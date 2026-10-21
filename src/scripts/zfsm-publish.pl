#!/usr/bin/perl
# Publish a copied filesystem only over our own exclusive empty placeholder.
# The owner dataset may be UID99/0777. No existing user inode is mounted over,
# removed or chmodded. Failure deliberately retains recovery and placeholders.
use strict;
use warnings;
use JSON::PP;
use Fcntl qw(:DEFAULT :mode);
use POSIX qw(uname);
use Encode qw(encode FB_CROAK LEAVE_SRC);
use IO::Handle;

my $json=JSON::PP->new->utf8->canonical;
my ($root,$target,$placeholder,$root_path,$target_path,$selected,$recovery,$id);
my ($root_identity,$target_identity,$source_identity,$placeholder_identity);
my ($mkdirat,$renameat2);
my $published=0;
sub fail { die $_[0]."\n"; }
sub raw { encode('UTF-8',$_[0],FB_CROAK|LEAVE_SRC); }
sub emit { print $json->encode($_[0])."\n" or fail('Progress channel closed'); STDOUT->flush; }
sub identity { my @s=stat($_[0]);fail('Pinned directory unavailable') unless @s;return {dev=>"$s[0]",ino=>"$s[1]"}; }
sub same { my ($a,$b)=@_;return ref($b) eq 'HASH'&&defined($b->{dev})&&defined($b->{ino})&&$a->{dev} eq "$b->{dev}"&&$a->{ino} eq "$b->{ino}"; }
sub request {
    my $line=<STDIN>;fail('Publication channel closed; retained objects require inspection') unless defined $line;
    fail('Request too large') if length($line)>65536;
    my $obj=$json->decode($line);fail('Invalid request') unless ref($obj) eq 'HASH';return $obj;
}
sub absolute {
    my ($v)=@_;fail('Invalid absolute directory') unless defined($v)&&!ref($v)&&length($v)<=4096&&$v=~m{^/[^/]}&&$v!~/\0/;
    fail('Invalid absolute directory') if grep { $_ eq ''||$_ eq '.'||$_ eq '..' } split(m{/},substr($v,1),-1);
    return $v;
}
sub child {
    my ($v)=@_;fail('Publication requires a direct child name') unless defined($v)&&!ref($v)&&length($v)&&length(raw($v))<=255&&$v!~m{/|\0}&&$v ne '.'&&$v ne '..'&&$v ne '.zfs';return $v;
}
sub handle {
    my ($fd,$label)=@_;fail($label.': '.$!) if $fd<0;
    open(my $fh,'<&=',$fd) or fail('Unable to retain mount handle');return $fh;
}
sub pin {
    my ($parent,$name,$cross)=@_;my $how=pack('Q<Q<Q<',O_RDONLY|O_DIRECTORY|0x80000,0,8|4|($cross?0:1));my $p=raw($name);
    return handle(syscall(437,fileno($parent),$p,$how,length($how)),'Directory unavailable, symbolic link, or unexpected mount');
}
sub pin_absolute {
    my ($path)=@_;sysopen(my $slash,'/',O_RDONLY|O_DIRECTORY) or fail('Unable to pin filesystem root');
    return pin($slash,substr($path,1),1);
}
sub anchor { '/proc/self/fd/'.fileno($_[0]); }
sub mount_rows {
    open(my $f,'<','/proc/self/mountinfo') or fail('Mount identity unavailable');my @rows;
    while (<$f>) {
        my @fields=split / /;next unless @fields>=10;
        for my $i (3,4) { $fields[$i]=~s/\\([0-7]{3})/chr(oct($1))/ge; }
        push @rows,{id=>$fields[0],root=>$fields[3],path=>$fields[4]};
    }
    close($f);return @rows;
}
sub mount_root {
    my ($path,$nested)=@_;my @rows=mount_rows();my @exact=grep { $_->{path} eq raw($path) } @rows;
    fail('Directory must be an exact filesystem mount root') unless @exact==1&&$exact[0]->{root} eq '/';
    fail('Nested mounts cannot be published') if !$nested&&grep { index($_->{path},raw($path).'/')==0 } @rows;
    return $exact[0]->{id};
}
sub canonical_root {
    my $now=pin_absolute($root_path);
    fail('Owner dataset root identity changed') unless same(identity($now),$root_identity);
    mount_root($root_path,1);
}
sub trusted_target {
    my @parts=split m{/},substr($target_path,1);pop @parts;
    fail('Private staging ancestor required') unless @parts;
    sysopen(my $cursor,'/',O_RDONLY|O_DIRECTORY) or fail('Unable to inspect staging ancestors');my $at='';
    for my $i (0..$#parts) {
        $at.='/'.$parts[$i];$cursor=pin($cursor,$parts[$i],1);my @s=stat($cursor);
        fail('Staging ancestors must be root owned') unless $s[4]==0;
        my $mode=$s[2]&07777;
        my $sticky=($at eq '/tmp'||$at eq '/var/tmp')&&($mode&01000);
        fail('Staging ancestors permit untrusted writes') if ($mode&0022)&&!$sticky;
        fail('Private staging directory must be root owned mode 0700') if $i==$#parts&&$mode!=0700;
    }
}
sub clone_mount {
    my ($fh)=@_;my $empty='';return handle(syscall(428,fileno($fh),$empty,1|0x1000|0x80000),'Safe mounted publication requires open_tree clone');
}
sub attach_mount {
    my ($from,$to)=@_;my $empty='';fail('Pinned mount publication failed: '.$!) if syscall(429,fileno($from),$empty,fileno($to),$empty,4|64)!=0;
}
sub private_claim {
    my ($claim)=@_;
    fail('Authenticated private claim is required') unless ref($claim) eq 'HASH';
    my $path=absolute($claim->{path});
    fail('Claim must be directly inside owner dataset') unless index($path,$root_path.'/')==0;
    my $name=child(substr($path,length($root_path)+1));
    my $dir=pin($root,$name,0);my @s=stat($dir);
    fail('Private claim identity changed') unless same(identity($dir),$claim);
    fail('Claim must be root owned mode 0700') unless $s[4]==0&&($s[2]&07777)==0700;
    my $how=pack('Q<Q<Q<',O_RDONLY|0x80000,0,8|4|1);my $journal='journal.jsonl';
    my $fh=handle(syscall(437,fileno($dir),$journal,$how,length($how)),'Claim recovery journal unavailable');my @j=stat($fh);
    fail('Claim recovery journal is not private') unless S_ISREG($j[2])&&$j[4]==0&&($j[2]&07777)==0600&&$j[7]<=1048576;
    my ($captured,$retained)=(0,0);
    while (my $line=<$fh>) {
        my $row=$json->decode($line);next unless ref($row) eq 'HASH'&&same($source_identity,$row->{identity});
        $captured=1 if ($row->{event}//'') eq 'captured';
        $retained=1 if ($row->{event}//'') eq 'published'&&($row->{destination}//'') eq $recovery;
    }
    close($fh);fail('Claim journal does not authenticate original source') unless $captured&&$retained;
    return $dir;
}
sub empty_placeholder {
    my @s=stat($placeholder);
    fail('Placeholder ownership or permissions changed') unless $s[4]==0&&($s[2]&07777)==0700;
    opendir(my $d,anchor($placeholder)) or fail('Placeholder cannot be inspected');
    my @entries=grep { $_ ne '.'&&$_ ne '..' } readdir($d);closedir($d);
    fail('Placeholder is no longer empty') if @entries;
}
sub main {
    my @u=uname();fail('Mounted publication requires privileged Linux x86_64 or aarch64') unless $^O eq 'linux'&&$>==0&&($u[4] eq 'aarch64'||$u[4] eq 'x86_64');
    $mkdirat=$u[4] eq 'aarch64'?34:258;$renameat2=$u[4] eq 'aarch64'?276:316;
    fail('Unexpected command arguments') if @ARGV;
    umask(0077);binmode(STDIN);binmode(STDOUT);$|=1;
    my $a=request();
    if (($a->{op}//'') eq 'probe') {
        sysopen(my $slash,'/',O_RDONLY|O_DIRECTORY) or fail('Unable to probe mount API');my $clone=clone_mount($slash);close($clone);
        my $empty='';my $result=syscall(429,-1,$empty,-1,$empty,4|64);
        fail('Safe mounted publication requires move_mount') unless $result<0&&$!{EBADF};
        emit({ok=>JSON::PP::true,phase=>'probe'});return;
    }
    fail('Unknown publication operation') if defined($a->{op})&&$a->{op} ne 'publish';
    $root_path=absolute($a->{root});$target_path=absolute($a->{target});$selected=child($a->{path});$recovery=child($a->{recovery});
    fail('Recovery and selected names must differ') if $selected eq $recovery;
    $id=$a->{id};fail('Invalid publication id') if !defined($id)||ref($id)||length($id)>256;
    $root=pin_absolute($root_path);$root_identity=identity($root);
    fail('Owner dataset root identity changed') unless same($root_identity,$a->{root_identity});mount_root($root_path,1);
    trusted_target();my $normal=pin_absolute($target_path);$target_identity=identity($normal);
    fail('Target mount identity changed') unless same($target_identity,$a->{target_identity});
    fail('Target must be a separate filesystem') if $target_identity->{dev} eq $root_identity->{dev};mount_root($target_path,0);
    my $source=pin($root,$selected,0);$source_identity=identity($source);close($source);
    fail('Selected source identity changed') unless same($source_identity,$a->{identity});
    $target=clone_mount($normal);close($normal);
    fail('Detached target identity changed') unless same(identity($target),$target_identity);
    emit({ok=>JSON::PP::true,phase=>'prepared',id=>$id,identity=>$target_identity,source_identity=>$source_identity});
    my $next=request();fail('Expected reserve action') unless ($next->{action}//'') eq 'reserve';
    canonical_root();my $retained=pin($root,$recovery,0);
    fail('Original source was not retained at requested recovery name') unless same(identity($retained),$source_identity);close($retained);
    my $claim=private_claim($next->{claim});
    my $private='publication-placeholder';
    fail('Private publication placeholder already exists') if syscall($mkdirat,fileno($claim),$private,0700)!=0;
    $placeholder=pin($claim,$private,0);$placeholder_identity=identity($placeholder);empty_placeholder();
    # Pin the created inode before exposing it to a writable public parent.
    # mkdirat followed by openat2 in the public directory has a rename gap.
    my $name=raw($selected);
    fail('Publication destination already exists or cannot be reserved') if syscall($renameat2,fileno($claim),$private,fileno($root),$name,1)!=0;
    $claim->sync or fail('Unable to flush private publication claim');
    $root->sync or fail('Unable to flush publication placeholder');
    emit({ok=>JSON::PP::true,phase=>'reserved',id=>$id,placeholder_identity=>$placeholder_identity});
    $next=request();fail('Expected publish action') unless ($next->{action}//'') eq 'publish';
    canonical_root();my $current=pin($root,$selected,0);
    fail('Publication placeholder moved or changed') unless same(identity($current),$placeholder_identity);close($current);
    empty_placeholder();fail('Detached target identity changed') unless same(identity($target),$target_identity);
    attach_mount($target,$placeholder);$published=1;
    # A writable owner parent can rename the placeholder between the preceding
    # checks and move_mount. The FD prevents covering a replacement inode. Only
    # the exact canonical mount and identity qualify as a successful publish.
    canonical_root();mount_root($root_path.'/'.$selected,0);
    $current=pin($root,$selected,1);
    fail('Published mount moved; retained mount and source require inspection') unless same(identity($current),$target_identity);
    emit({ok=>JSON::PP::true,phase=>'published',id=>$id,identity=>$target_identity});
}
unless (caller) {
    eval { main();1 } or do {
        my $error=$@||'Mounted publication failed';$error=~s/\s+$//;
        emit({ok=>JSON::PP::false,error=>$error,published=>$published?JSON::PP::true:JSON::PP::false,retained=>JSON::PP::true});exit 1;
    };
}
1;
