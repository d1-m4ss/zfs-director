#!/usr/bin/perl
# Linux directory mutations. Every destructive name is first captured into a
# root-owned private directory and checked by dev/ino. A complete filesystem
# root confines renames; FAN_CREATE handles authenticate the private parent.
use strict;
use warnings;
use JSON::PP;
use Fcntl qw(:DEFAULT :mode);
use POSIX qw(uname);
use Encode qw(encode decode FB_CROAK LEAVE_SRC);
use IO::Handle;
use Errno qw(EBADF);
use Digest::SHA ();
use MIME::Base64 ();
use Time::HiRes ();

my $json=JSON::PP->new->utf8->canonical;
my %nr;
my ($root,$container,$container_name,$root_path,$journal,$source_location,$publication,$boundary);
my $serial=0;
my ($delete_total,$delete_removed,$delete_tick)=(0,0,0);
sub deletion_progress {
    $delete_removed++;
    if (Time::HiRes::time()-$delete_tick>=0.5||$delete_removed==$delete_total) {
        emit({phase=>'deleting',removed=>$delete_removed,total=>$delete_total});$delete_tick=Time::HiRes::time();
    }
}
use constant O_PATH_LINUX => 0x200000;
use constant O_CLOEXEC_LINUX => 0x80000;
sub fail { die $_[0]."\n" }
sub raw { encode('UTF-8',$_[0],FB_CROAK|LEAVE_SRC) }
sub emit { print $json->encode($_[0])."\n" or fail('Progress channel closed'); STDOUT->flush; }
sub identity { my @s=stat($_[0]); fail('Pinned object unavailable') unless @s; return {dev=>"$s[0]",ino=>"$s[1]"}; }
sub same { my ($a,$b)=@_; return ref($b) eq 'HASH' && defined($b->{dev}) && defined($b->{ino}) && $a->{dev} eq "$b->{dev}" && $a->{ino} eq "$b->{ino}"; }
sub path {
    my ($value)=@_; fail('Invalid directory path') if !defined($value)||ref($value)||length($value)>4096||$value=~m{^/|\0};
    my @parts=split m{/},$value,-1;
    fail('Invalid directory path') if !@parts||@parts>128||grep { $_ eq ''||$_ eq '.'||$_ eq '..'||$_ eq '.zfs'||/^\.zfsm-/ } @parts;
    return $value;
}
sub openat {
    my ($parent,$name,$flags,$allow_mount)=@_;
    my $how=pack('Q<Q<Q<',$flags,0,8|4|($allow_mount?0:1)); my $p=raw($name);
    my $fd=syscall($nr{openat2},fileno($parent),$p,$how,length($how));
    fail('Path is unavailable, contains a symbolic link, or crosses a mount: '.$name) if $fd<0;
    open(my $fh,'<&=',$fd) or fail('Unable to retain directory handle'); return $fh;
}
sub anchor { '/proc/self/fd/'.fileno($_[0]) }
sub entries {
    my ($dir)=@_; opendir(my $dh,anchor($dir)) or fail('Unable to inspect pinned directory'); my @out;
    while(defined(my $p=readdir($dh))) { next if $p eq '.'||$p eq '..'; push @out,decode('UTF-8',$p,FB_CROAK); fail('Directory exceeds 100000 entries') if @out>100000; }
    closedir($dh); return sort @out;
}
sub renamed {
    my ($from,$old,$to,$new)=@_; my $a=raw($old); my $b=raw($new);
    return syscall($nr{renameat2},fileno($from),$a,fileno($to),$b,1)==0;
}
sub parent {
    my ($name)=@_; my @parts=split m{/},$name; my $leaf=pop @parts;
    return (openat($root,@parts?join('/',@parts):'.',O_RDONLY|O_DIRECTORY,0),$leaf);
}
sub canonical_parent {
    my ($path,$pinned)=@_;my ($current)=parent($path);
    return same(identity($current),identity($pinned));
}
sub recovery {
    return undef unless $container;
    my $where=readlink(anchor($container));
    my $details={container=>$container_name,location=>defined($where)?$where:'unavailable',identity=>identity($container),journal=>'journal.jsonl',retained=>JSON::PP::true};
    $details->{source}=$source_location if $source_location;
    if ($publication) {
        my $actual=readlink(anchor($publication->{handle}));
        $details->{publication}={requested=>$publication->{requested},location=>defined($actual)?$actual:'unavailable',identity=>identity($publication->{handle})};
    }
    return $details;
}
sub record {
    my ($row)=@_; print $journal $json->encode($row)."\n" or fail('Unable to write recovery journal');
    $journal->flush && $journal->sync or fail('Unable to flush recovery journal');
}
sub mount_id {
    my ($dir)=@_; open(my $info,'<','/proc/self/fdinfo/'.fileno($dir)) or fail('Unable to inspect pinned mount identity');
    local $/; my $value=<$info>; close($info);
    fail('Pinned mount identity unavailable') unless $value=~/^mnt_id:\s*(\d+)\s*$/m; return "$1";
}
sub full_root {
    my ($dir)=@_; my $id=mount_id($dir); my $found;
    open(my $info,'<','/proc/self/mountinfo') or fail('Unable to inspect filesystem mount roots');
    while(my $line=<$info>) {
        my @fields=split / /,$line; next unless $fields[0] eq $id;
        fail('Dataset mutation root must be a complete filesystem root') unless $fields[3] eq '/';
        my $point=$fields[4]; $point=~s/\\([0-7]{3})/chr(oct($1))/ge; $point=decode('UTF-8',$point,FB_CROAK);
        sysopen(my $slash,'/',O_RDONLY|O_DIRECTORY) or fail('Unable to inspect filesystem mount root');
        my $mounted=$point eq '/'?$slash:openat($slash,substr($point,1),O_RDONLY|O_DIRECTORY,1);
        fail('Dataset mutation root must be a complete filesystem root') unless same(identity($mounted),identity($dir)) && mount_id($mounted) eq $id;
        $found=1; last;
    }
    close($info); fail('Pinned filesystem mount root unavailable') unless $found; return $id;
}
sub file_handle {
    my ($dir)=@_; my $handle=pack('L<l<',128,0).("\0"x128); my $mount=pack('l<',0); my $empty='';
    fail('Filesystem object handles are required') if syscall($nr{name_to_handle_at},fileno($dir),$empty,$handle,$mount,0x1000)!=0;
    my ($length,$type)=unpack('L<l<',$handle); fail('Invalid filesystem object handle') if !$length||$length>128;
    return pack('l<',$type).substr($handle,8,$length);
}
sub filesystem_id {
    my ($dir)=@_; my $value="\0"x128;
    fail('Unable to inspect owning filesystem identity') if syscall($nr{fstatfs},fileno($dir),$value)!=0;
    return substr($value,56,8);
}
sub fanotify {
    # Directory entry notifications must include both the parent and target FID.
    my $fd=syscall($nr{fanotify_init},0x1e03,O_RDONLY|O_CLOEXEC_LINUX);
    fail('Safe directory mutations require fanotify target object handles') if $fd<0;
    open(my $fan,'<&=',$fd) or fail('Unable to retain creation notification handle'); return $fan;
}
sub prepare_boundary {
    my ($dir)=@_; my $id=full_root($dir); my $handle=file_handle($dir); my $fsid=filesystem_id($dir); my $fan=fanotify(); my $dot='.';
    fail('Filesystem creation notifications are required') if syscall($nr{fanotify_mark},fileno($fan),1|8,0x48000100,fileno($dir),$dot)!=0;
    return {mount_id=>$id,handle=>$handle,fsid=>$fsid,fan=>$fan};
}
sub creation_handle {
    my ($policy,$name)=@_; my $ready=''; vec($ready,fileno($policy->{fan}),1)=1;
    fail('Private directory creation notification unavailable') unless select($ready,undef,undef,2)>0;
    my $bytes=''; my $length=sysread($policy->{fan},$bytes,65536);
    fail('Unable to read private directory creation notification') unless defined($length)&&$length>0;
    my ($offset,$target)=(0,undef);
    while($offset<$length) {
        fail('Malformed private directory creation notification') if $length-$offset<24;
        my ($event_length,$version,$reserved,$metadata_length,$mask,$fd,$pid)=unpack('L<CCS<Q<l<l<',substr($bytes,$offset,24));
        fail('Invalid private directory creation notification') if $version!=3||$reserved||$metadata_length!=24||$event_length<$metadata_length||$offset+$event_length>$length||($mask&0x4000)||$fd!=-1;
        my (%records,$position); $position=$offset+$metadata_length;
        while($position<$offset+$event_length) {
            fail('Malformed creation identity record') if $offset+$event_length-$position<20;
            my ($kind,$pad,$size)=unpack('CCS<',substr($bytes,$position,4));
            fail('Unexpected creation identity record') if $pad||($kind!=1&&$kind!=2)||$size<20||$position+$size>$offset+$event_length||exists($records{$kind});
            my $fsid=substr($bytes,$position+4,8); my ($handle_length,$type)=unpack('L<l<',substr($bytes,$position+12,8));
            fail('Invalid creation filesystem identity') if $fsid ne $policy->{fsid}||!$handle_length||$handle_length>128||20+$handle_length>$size;
            my $tail=substr($bytes,$position+20+$handle_length,$size-20-$handle_length);
            fail('Malformed target creation identity') if $kind==1&&$tail=~/[^\0]/;
            $records{$kind}={handle=>pack('l<',$type).substr($bytes,$position+20,$handle_length),tail=>$tail};
            $position+=$size;
        }
        fail('Missing creation identity records') unless $position==$offset+$event_length&&keys(%records)==2&&$records{1}&&$records{2};
        my $tail=$records{2}{tail}; fail('Malformed created directory name') unless $tail=~/\A([^\0]*)\0\0*\z/s;
        my $event_name=$1;
        if ($pid==$$ && $mask==0x40000100 && $event_name eq raw($name)) {
            fail('Private directory creation parent changed') unless $records{2}{handle} eq $policy->{handle};
            fail('Ambiguous private directory creation identity') if defined($target); $target=$records{1}{handle};
        }
        $offset+=$event_length;
    }
    fail('Private directory creation identity unavailable') unless defined($target); return $target;
}
sub probe {
    my ($args)=@_;
    sysopen(my $slash,'/',O_RDONLY|O_DIRECTORY) or fail('Unable to pin filesystem root');
    my $pinned=openat($slash,'.',O_RDONLY|O_DIRECTORY,0);
    my $a='zfsm-readonly-probe';my $b='zfsm-readonly-probe';
    my $result=syscall($nr{renameat2},-1,$a,-1,$b,1);
    fail('Safe directory mutations require renameat2 RENAME_NOREPLACE') unless $result<0 && $!==EBADF;
    my $fan=fanotify(); my $handle=pack('L<l<',128,0).("\0"x128);my $mount=pack('l<',0);my $empty='';
    my $result_handle=syscall($nr{name_to_handle_at},-1,$empty,$handle,$mount,0x1000);
    fail('Safe directory mutations require name_to_handle_at') unless $result_handle<0&&$!==EBADF;
    my $dot='.'; my $result_mark=syscall($nr{fanotify_mark},-1,1|8,0x48000100,-1,$dot);
    fail('Safe directory mutations require fanotify_mark') unless $result_mark<0&&$!==EBADF;
    my $row={ok=>JSON::PP::true,op=>'probe',fanotify_target_fid=>JSON::PP::true};
    if (exists($args->{root})) { my $dir=request_root($args); my $policy=prepare_boundary($dir); $row->{root_mount_id}=$policy->{mount_id}; }
    emit($row);
}
sub container {
    sysopen(my $random,'/dev/urandom',O_RDONLY) or fail('Unable to obtain private claim name');
    read($random,my $bytes,24)==24 or fail('Unable to obtain private claim name'); close($random);
    $container_name='.zfsm-mutation-'.unpack('H*',$bytes); my $name=raw($container_name);
    fail('Unable to create private recovery container') if syscall($nr{mkdirat},fileno($root),$name,0700)!=0;
    my $created=creation_handle($boundary,$container_name);
    my $candidate=openat($root,$container_name,O_RDONLY|O_DIRECTORY,0); my @s=stat($candidate);
    fail('Private recovery container creation identity changed') unless mount_id($candidate) eq $boundary->{mount_id} && file_handle($candidate) eq $created;
    fail('Private recovery container ownership changed') unless $s[4]==0 && ($s[2]&0777)==0700 && !($s[2]&01000);
    $container=$candidate;
    # A setgid dataset parent can contribute its group bit; clear it only after
    # authenticating the created inode, never on an unrelated substituted dir.
    chmod(0700,$container)==1 or fail('Unable to secure proven private recovery container');
    fail('Private recovery container is not empty; no metadata written') if entries($container);
    # The public parent may be0777. Never unlink the public container name:
    # Linux lacks inode-conditional unlinkat. Retain the journal on success too.
    my $file=anchor($container).'/journal.jsonl';
    sysopen($journal,$file,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600) or fail('Unable to create recovery journal');
    record({event=>'created',container_identity=>identity($container)});
    $container->sync && $root->sync or fail('Unable to flush private recovery container');
    emit({phase=>'prepared',recovery=>recovery()});
}
sub capture {
    my ($from,$name,$expected,$original)=@_; my $slot='object-'.(++$serial);
    record({event=>'intent',slot=>$slot,path=>$original,identity=>$expected});
    fail('Directory changed or cannot be claimed; no destination was overwritten') unless renamed($from,$name,$container,$slot);
    $from->sync && $container->sync or fail('Unable to flush claim; inspect recovery journal');
    my $captured;
    eval { $captured=openat($container,$slot,O_PATH_LINUX|O_NOFOLLOW,0); 1 } or do {
        my $error=$@; my $restored=renamed($container,$slot,$from,$name);
        $from->sync && $container->sync or fail('Unable to flush rollback; inspect recovery journal');
        record({event=>$restored?'rolled-back':'retained',slot=>$slot,path=>$original});
        fail($restored?'Captured object is unavailable; original name restored':$error.'; object retained; original name occupied or moved');
    };
    if (!same(identity($captured),$expected)) {
        my $restored=renamed($container,$slot,$from,$name);
        $from->sync && $container->sync or fail('Unable to flush rollback; inspect recovery journal');
        record({event=>$restored?'rolled-back':'retained',slot=>$slot,path=>$original,identity=>identity($captured)});
        fail($restored?'Directory identity changed; unexpected object restored':'Directory identity changed; unexpected object retained; original name occupied or moved');
    }
    my @captured_stat=stat($captured);
    $captured=openat($captured,'.',O_RDONLY|O_DIRECTORY,0) if S_ISDIR($captured_stat[2]);
    my $where=readlink(anchor($from));
    my $observed=defined($where)?$where.'/'.$name:'unavailable';
    $source_location={requested=>$original,location=>$observed} if $serial==1;
    record({event=>'captured',slot=>$slot,path=>$original,source_location=>$observed,identity=>$expected});
    return ($captured,$slot);
}
sub inspect_tree {
    my ($dir,$relative,$manifest,$recursive)=@_;
    for my $name (entries($dir)) {
        fail('Reserved directory entry cannot be mutated') if $name eq '.zfs'||$name=~/^\.zfsm-/;
        my $child=openat($dir,$name,O_PATH_LINUX|O_NOFOLLOW,0); my @s=stat($child);
        $child=openat($child,'.',O_RDONLY|O_DIRECTORY,0) if S_ISDIR($s[2]);
        # Non-directories (including links, FIFOs, sockets and device nodes)
        # are pinned only with O_PATH|O_NOFOLLOW; never opened for I/O.
        fail('Directory is not empty; recursive deletion is required') unless $recursive;
        my $p=$relative eq ''?$name:$relative.'/'.$name;
        # Names preserve the preflight entry set. Child identities are pinned
        # freshly immediately before their individual private claims.
        $manifest->{$p}={directory=>S_ISDIR($s[2])?1:0} if $manifest;
        inspect_tree($child,$p,$manifest,$recursive) if S_ISDIR($s[2]);
    }
}
sub remove_tree {
    my ($dir,$slot,$relative,$manifest)=@_;
    for my $name (entries($dir)) {
        my $p=$relative eq ''?$name:$relative.'/'.$name; my $known=$manifest->{$p};
        fail('Directory contents changed; remaining objects retained') unless $known;
        # Selected-root authorization covers current contents. Pin each
        # current child through capture/verification, preventing inode reuse
        # without retaining one descriptor for every file in a large tree.
        my $current=openat($dir,$name,O_PATH_LINUX|O_NOFOLLOW,0);
        my @current_stat=stat($current);
        fail('Directory entry type changed; remaining objects retained') if !!S_ISDIR($current_stat[2]) != !!$known->{directory};
        my ($child,$captured)=capture($dir,$name,identity($current),$p);
        close($current); # The verified captured handle now pins this inode.
        if ($known->{directory}) { remove_tree($child,$captured,$p,$manifest); }
        else {
            my $raw=raw($captured);
            fail('Unable to delete captured file; remaining objects retained') if syscall($nr{unlinkat},fileno($container),$raw,0)!=0;
            record({event=>'deleted',slot=>$captured,path=>$p});
            deletion_progress();
        }
    }
    my $raw=raw($slot);
    fail('Directory received new files or left its boundary; remaining objects retained') if syscall($nr{unlinkat},fileno($container),$raw,512)!=0;
    record({event=>'deleted',slot=>$slot,path=>$relative});
    deletion_progress();
}
sub request_root {
    my ($args)=@_; my $root_path=$args->{root}; fail('Invalid dataset root') unless defined($root_path)&&!ref($root_path)&&$root_path=~m{^/[^/]}&&$root_path!~/\0/&&$root_path!~m{/$};
    sysopen(my $slash,'/',O_RDONLY|O_DIRECTORY) or fail('Unable to pin filesystem root');
    my $dir=openat($slash,substr($root_path,1),O_RDONLY|O_DIRECTORY,1);
    fail('The filesystem root cannot be a dataset mutation root') if same(identity($dir),identity($slash));
    fail('Dataset root identity changed') unless same(identity($dir),$args->{root_identity}); return $dir;
}
# Only journal-only completed mutation containers are eligible. Never recurse.
sub cleanup_inspect {
    my ($dir)=@_; my @s=stat($dir);
    fail('Recovery container must be root-owned and private0700') unless $s[4]==0 && ($s[2]&07777)==0700;
    my @names=entries($dir); fail('Recovery data is retained or the journal is missing; cleanup blocked') unless @names==1 && $names[0] eq 'journal.jsonl';
    my $file=openat($dir,'journal.jsonl',O_RDONLY|O_NOFOLLOW|O_NONBLOCK,0);my @f=stat($file);
    fail('Recovery journal must be a private root-owned regular file with one link') unless S_ISREG($f[2]) && $f[4]==0 && ($f[2]&07777)==0600 && $f[3]==1 && $f[7]>0 && $f[7]<=262144;
    my $bytes='';while(read($file,my $chunk,16384)){ $bytes.=$chunk;fail('Recovery journal exceeds read bound') if length($bytes)>262144; }
    fail('Recovery journal changed while reading') unless length($bytes)==$f[7] && same(identity($file),identity(openat($dir,'journal.jsonl',O_PATH_LINUX|O_NOFOLLOW,0)));
    fail('Incomplete recovery journal') unless $bytes=~/\n\z/;
    my @lines=split /\n/,$bytes;fail('Recovery journal exceeds record limit') if @lines>4096;
    my (%slots,$created,$complete,$published,$op);my $id=identity($dir);
    for my $line (@lines){
        my $row=eval{$json->decode($line)};fail('Malformed recovery journal') unless ref($row)eq'HASH' && !defined($complete);
        my $event=$row->{event}//'';
        if(!$created){fail('Recovery journal identity does not match container') unless $event eq 'created' && same($id,$row->{container_identity});$created=1;next;}
        if($event eq'intent'){
            my $slot=$row->{slot}//'';fail('Malformed recovery intent') unless $slot=~/\Aobject-[1-9][0-9]*\z/ && !exists($slots{$slot}) && ref($row->{identity})eq'HASH' && defined($row->{path}) && !ref($row->{path});
            $slots{$slot}={state=>'intent',identity=>$row->{identity}};
        }elsif($event eq'captured'){
            my $slot=$row->{slot}//'';fail('Unmatched recovery capture') unless ($slots{$slot}{state}//'')eq'intent' && same($slots{$slot}{identity},$row->{identity});$slots{$slot}{state}='captured';
        }elsif($event eq'deleted'){
            my $slot=$row->{slot}//'';fail('Unmatched recovery deletion') unless ($slots{$slot}{state}//'')eq'captured';$slots{$slot}{state}='deleted';
        }elsif($event eq'published'){
            fail('Unmatched recovery publication') unless !$published && keys(%slots)==1 && ($slots{'object-1'}{state}//'')eq'captured' && same($slots{'object-1'}{identity},$row->{identity});$published=1;$slots{'object-1'}{state}='published';
        }elsif($event eq'complete'){
            $op=$row->{op}//'';fail('Incomplete or inconsistent recovery operation') unless keys(%slots)>0 && (($op eq'delete' && !$published && !grep{$_->{state}ne'deleted'}values%slots) || (($op eq'move'||$op eq'claim') && $published && keys(%slots)==1));$complete=1;
        }else{fail('Unfinished, retained or unsupported recovery journal; cleanup blocked');}
    }
    fail('Recovery operation is not complete') unless $complete;
    @names=entries($dir);fail('Recovery contents changed') unless @names==1 && $names[0]eq'journal.jsonl';
    return {identity=>$id,journal_identity=>identity($file),journal_sha256=>Digest::SHA::sha256_hex($bytes),journal_base64=>MIME::Base64::encode_base64($bytes,''),operation=>$op,records=>scalar(@lines)};
}
sub cleanup_anchor {
    my ($policy)=@_;my $name='.zfsm-maintenance';my $p=raw($name);my $created;
    if(!lstat(anchor($root).'/'.$name)){
        fail('Unable to create cleanup maintenance area') if syscall($nr{mkdirat},fileno($root),$p,0700)!=0;
        $created=creation_handle($policy,$name);
    }
    my $dir=openat($root,$name,O_RDONLY|O_DIRECTORY,0);my @s=stat($dir);
    fail('Cleanup maintenance area creation identity changed') if defined($created) && file_handle($dir)ne$created;
    fail('Cleanup maintenance area is not trusted') unless $s[4]==0 && mount_id($dir)eq$policy->{mount_id} && (defined($created)?(($s[2]&0777)==0700 && !($s[2]&05000)):($s[2]&07777)==0700);
    # Clear inherited setgid only on the authenticated newly created inode.
    chmod(0700,$dir)==1 or fail('Unable to secure cleanup maintenance area') if defined($created);
    $dir->sync && $root->sync or fail('Unable to flush maintenance area');return $dir;
}
sub cleanup_main {
    my ($args)=@_;my $selected=$args->{path}//'';
    fail('Only a top-level mutation recovery container can be cleaned') unless !ref($selected) && $selected=~/\A\.zfsm-mutation-[a-f0-9]{48}\z/;
    $root_path=$args->{root};$root=request_root($args);full_root($root);
    my $source=openat($root,$selected,O_RDONLY|O_DIRECTORY,0);fail('Recovery container identity changed') unless same(identity($source),$args->{identity});
    my $review=cleanup_inspect($source);
    if($args->{op}eq'cleanup-inspect'){emit({ok=>JSON::PP::true,op=>$args->{op},%$review});return;}
    fail('Fresh recovery journal digest is required') unless defined($args->{journal_sha256}) && !ref($args->{journal_sha256}) && $args->{journal_sha256}=~/\A[a-f0-9]{64}\z/ && $args->{journal_sha256}eq$review->{journal_sha256};
    my $policy=prepare_boundary($root);my $area=cleanup_anchor($policy);
    sysopen(my $random,'/dev/urandom',O_RDONLY) or fail('Unable to create cleanup identity');read($random,my $bytes,24)==24 or fail('Unable to read cleanup identity');close($random);
    my $slot='cleanup-'.unpack('H*',$bytes);$container=$area;$container_name='.zfsm-maintenance';
    fail('Recovery container changed before capture') unless renamed($root,$selected,$area,$slot);
    $root->sync && $area->sync or fail('Unable to flush recovery capture');
    $source_location={requested=>$selected,location=>(readlink(anchor($area))//'unavailable').'/'.$slot};
    my $captured=openat($area,$slot,O_RDONLY|O_DIRECTORY,0);
    if(!same(identity($captured),$review->{identity})){
        my $restored=renamed($area,$slot,$root,$selected);$area->sync;$root->sync;
        fail($restored?'Recovery identity changed; substituted directory restored':'Recovery identity changed; substituted directory retained in maintenance area');
    }
    my $fresh=eval{cleanup_inspect($captured)};
    if(!$fresh || $fresh->{journal_sha256}ne$review->{journal_sha256} || !same($fresh->{journal_identity},$review->{journal_identity})){
        my $restored=renamed($area,$slot,$root,$selected);$area->sync;$root->sync;
        fail($restored?'Recovery contents changed; container restored':'Recovery contents changed; container retained in maintenance area');
    }
    # The selected inode is now beneath a pinned root0700 parent. A writer of
    # the public dataset root cannot replace the two names used for unlinkat.
    my $journal_name=raw('journal.jsonl');fail('Unable to remove archived journal; inspect maintenance area') if syscall($nr{unlinkat},fileno($captured),$journal_name,0)!=0;
    $captured->sync or fail('Unable to flush journal removal');my $name=raw($slot);
    fail('Unable to remove empty recovery container; inspect maintenance area') if syscall($nr{unlinkat},fileno($area),$name,512)!=0;
    $area->sync or fail('Unable to flush cleanup');$container=undef;
    emit({ok=>JSON::PP::true,op=>'cleanup',removed_identity=>$review->{identity},journal_sha256=>$review->{journal_sha256},maintenance=>'.zfsm-maintenance'});
}

sub main {
    my @u=uname(); my %abi=(x86_64=>[437,258,316,263,300,301,303,138],aarch64=>[437,34,276,35,262,263,264,44]);
    fail('Safe directory mutations require Linux x86_64 or aarch64') unless $^O eq 'linux' && $abi{$u[4]};
    @nr{qw(openat2 mkdirat renameat2 unlinkat fanotify_init fanotify_mark name_to_handle_at fstatfs)}=@{$abi{$u[4]}};
    fail('Safe directory mutations require the privileged local worker') unless $>==0;
    fail('Unexpected command arguments') if @ARGV;
    umask(0077); binmode(STDIN);binmode(STDOUT); $|=1;
    my $raw=''; while(read(STDIN,my $chunk,65536)) { $raw.=$chunk;fail('Request too large') if length($raw)>1048576; }
    my $args=$json->decode($raw); fail('Invalid request') unless ref($args) eq 'HASH';
    my $op=$args->{op}//''; if ($op eq 'probe') { probe($args);return; }
    if($op eq 'cleanup-inspect'||$op eq 'cleanup'){cleanup_main($args);return;}
    fail('Unknown directory operation') unless $op eq 'move'||$op eq 'claim'||$op eq 'delete';
    my $selected=path($args->{path}); my $destination;
    $destination=path($args->{destination}) if $op ne 'delete';
    fail('Destination cannot be inside selected directory') if defined($destination)&&($destination eq $selected||index($destination,$selected.'/')==0);
    $root_path=$args->{root}; $root=request_root($args); $boundary=prepare_boundary($root);
    my ($from,$name)=parent($selected); my $source=openat($from,$name,O_RDONLY|O_DIRECTORY,0);
    fail('Selected directory identity changed') unless same(identity($source),$args->{identity});
    my ($to,$target); if ($op ne 'delete') {
        ($to,$target)=parent($destination);
        fail('Destination already exists') if lstat(anchor($to).'/'.raw($target));
    }
    emit({phase=>'scanning'}) if $op eq 'delete';
    my %manifest; inspect_tree($source,'',$op eq 'delete'?\%manifest:undef,$op eq 'delete'?($args->{recursive}?1:0):1);
    $delete_total=1+scalar(keys %manifest) if $op eq 'delete';
    container();
    fail('Selected directory parent changed; reopen the directory') unless canonical_parent($selected,$from);
    my ($claimed,$slot)=capture($from,$name,$args->{identity},$selected);
    my $source_canonical=eval { canonical_parent($selected,$from) };
    fail('Selected directory parent moved during claim; reviewed directory retained in recovery container') unless $source_canonical;
    if ($op ne 'delete') {
        my $destination_canonical=eval { canonical_parent($destination,$to) };
        if (!$destination_canonical) {
            my $restored=renamed($container,$slot,$from,$name);
            $container->sync && $from->sync or fail('Unable to flush move rollback; inspect recovery journal');
            record({event=>$restored?'rolled-back':'retained',slot=>$slot,path=>$selected});
            fail($restored?'Destination parent changed; original restored':'Destination parent changed; reviewed directory retained in recovery container');
        }
        if (!renamed($container,$slot,$to,$target)) {
            my $restored=renamed($container,$slot,$from,$name);
            record({event=>$restored?'rolled-back':'retained',slot=>$slot,path=>$selected});
            fail($restored?'Move destination changed or left dataset; original restored':'Move refused; selected directory retained in recovery container');
        }
        $publication={requested=>$destination,handle=>$claimed};
        $container->sync && $to->sync or fail('Unable to flush move; inspect destination and recovery journal');
        my $actual=readlink(anchor($claimed));
        record({event=>'published',destination=>$destination,location=>defined($actual)?$actual:'unavailable',identity=>identity($claimed)});
        my $canonical=eval {
            my $current=openat($root,$destination,O_PATH_LINUX|O_NOFOLLOW,0);
            canonical_parent($destination,$to) && same(identity($current),identity($claimed));
        };
        fail('Destination moved during publication; reviewed directory retained at its reported actual location') unless $canonical;
    } else {
        # Each recursion root is already captured under the authenticated
        # root0700 parent. Parent DAC prevents ordinary writers moving it out,
        # including through old FDs. Uncaptured preflight handles are not used.
        remove_tree($claimed,$slot,'',\%manifest);
        $container->sync or fail('Unable to flush deletion');
    }
    record({event=>'complete',op=>$op});
    emit({ok=>JSON::PP::true,op=>$op,recovery=>recovery(),($op eq 'delete'?(removed=>$delete_removed,total=>$delete_total):())});
}
unless (caller) {
    eval { main();1 } or do {my $error=$@||'Directory mutation failed';$error=~s/\s+$//;print STDERR $json->encode({error=>$error,recovery=>recovery()})."\n";exit 1;};
}
1;
