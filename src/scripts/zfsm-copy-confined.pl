#!/usr/bin/perl
# Linux-only Convert copier. The caller must stop ALL source writers and keep
# the root-owned 0700 staging directory private until publication. No SSH.
# A new, empty filesystem-root target is mandatory: descendants cannot be moved
# to another filesystem. Never pass rsync a /proc/*/fd path or a detached mount.
use strict;
use warnings;
use JSON::PP;
use Fcntl qw(:DEFAULT :mode);
use POSIX qw(uname _exit);
use Digest::SHA;
use File::Path qw(make_path);
use IO::Handle;
use Encode qw(encode_utf8);

my $json=JSON::PP->new->utf8->canonical;
my ($jail,$child,%nr);
my $supervisor_pid=$$;
sub fail { die "$_[0]\n" }
sub event {print STDOUT $json->encode($_[0])."\n";STDOUT->flush();}
sub call {
    my ($name,@args)=@_;my $r=syscall($nr{$name},@args);
    fail("$name unavailable or denied: $!") if $r<0;return $r;
}
sub beneath {
    my ($base,$path,$flags,$cross)=@_;
    my $how=pack('Q<Q<Q<',$flags,0,4|8|($cross?0:1));
    my $name=$path eq ''?'.':$path;
    my $fd=call('openat2',fileno($base),$name,$how,length($how));
    open(my $fh,'<&=',$fd) or fail("open pinned descriptor: $!");return $fh;
}
sub root_pin {
    my ($row)=@_;
    fail('Invalid pinned root') unless ref($row) eq 'HASH' && defined($row->{path}) && $row->{path}=~m{^/[^\0]*$} && $row->{path}!~m{//|/\.?\.?(/|$)|/$};
    sysopen(my $slash,'/',O_RDONLY|O_DIRECTORY) or fail('Open root');
    my $fh=beneath($slash,substr($row->{path},1),O_RDONLY|O_DIRECTORY,1);
    my @s=stat($fh);fail('Pinned identity changed') unless defined($row->{dev}) && defined($row->{ino}) && "$s[0]" eq "$row->{dev}" && "$s[1]" eq "$row->{ino}";
    return $fh;
}
sub secure_ancestors {
    my ($path)=@_;sysopen(my $fh,'/',O_RDONLY|O_DIRECTORY) or fail('Open root');
    for my $part ('',split(m{/},substr($path,1))) {
        $fh=beneath($fh,$part,O_RDONLY|O_DIRECTORY,1) if length($part);
        my @s=stat($fh);fail('Staging ancestor must be root-owned and protected from rename') if $s[4]!=0 || (($s[2]&0022) && !($s[2]&01000));
    }
}
sub attrs {
    my ($fd,$bits)=@_;my $empty='';my $a=pack('Q<Q<Q<Q<',$bits,0,0,0);
    call('mount_setattr',fileno($fd),$empty,0x1000,$a,length($a));
}
sub clone_tree {
    my ($from)=@_;my $empty='';
    my $n=call('open_tree',fileno($from),$empty,0x1000|1|0x80000);
    open(my $tree,'<&=',$n) or fail('Open detached mount');return $tree;
}
sub clone_mount {
    my ($tree,$to,$bits)=@_;my $empty='';attrs($tree,$bits);
    call('move_mount',fileno($tree),$empty,fileno($to),$empty,4|64);
}
sub trusted_file {
    my ($path)=@_;fail('Invalid runtime dependency') unless $path=~m{^/[\w./+:-]+$};
    # Runtime system symlinks (/lib -> /usr/lib) are permitted only here. Files
    # are pinned before isolation and must have root-owned non-writable ancestry.
    require Cwd;my $resolved=Cwd::abs_path($path);fail('Missing runtime dependency') unless defined $resolved;
    secure_ancestors($resolved=~s{/[^/]+$}{}r);
    sysopen(my $fh,Cwd::abs_path($path),O_RDONLY|O_NOFOLLOW) or fail('Open runtime dependency');
    my @s=stat($fh);fail('Untrusted runtime dependency') unless S_ISREG($s[2]) && $s[4]==0 && !($s[2]&0022);
    return $fh;
}
sub close_extra {
    opendir(my $dh,'/proc/self/fd') or fail('Descriptor inventory unavailable');
    my @fds=grep { /^\d+$/ && $_>2 && $_!=fileno($dh) } readdir($dh);closedir($dh);
    POSIX::close($_) for @fds;
}
sub drop_privileges {
    my ($last)=@_;
    fail('Unsupported capability inventory') unless defined($last) && $last=~/^\d+\s*$/ && $last<=63;
    my %allow=map { $_=>1 } (0,1,3,4,31); # CHOWN, DAC_OVERRIDE, FOWNER, FSETID, SETFCAP
    for my $c (0..$last) {call('prctl',24,$c,0,0,0) unless $allow{$c};}
    call('prctl',38,1,0,0,0); # no_new_privs
    my $mask=0; $mask|=1<<$_ for keys %allow;
    my $header=pack('L<L<',0x20080522,0);
    my $data=pack('L<L<L<L<L<L<',$mask&0xffffffff,$mask&0xffffffff,0,0,0,0);
    call('capset',$header,$data);
}
sub xattrs {
    my ($fh,$link)=@_;my ($list,$get,$id)=$link?('llistxattr','lgetxattr',$link):('flistxattr','fgetxattr',fileno($fh));my $size=call($list,$id,0,0);my $names="\0" x $size;
    call($list,$id,$names,$size) if $size;
    my %out;for my $n (split(/\0/,$names)) {
        my $s=call($get,$id,$n,0,0);my $v="\0" x $s;call($get,$id,$n,$v,$s) if $s;$out{$n}=unpack('H*',$v);
    }return \%out;
}
sub inventory {
    my ($path)=@_;sysopen(my $root,$path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW) or fail('Inventory root unavailable');my (%rows,%links);my $files=0;
    my $walk;$walk=sub {
        my ($dir,$rel)=@_;my @s=stat($dir);$rows{$rel}={type=>'directory',mode=>$s[2]&07777,uid=>$s[4],gid=>$s[5],mtime=>$s[9],xattrs=>xattrs($dir)};
        opendir(my $dh,$path.($rel eq ''?'':"/$rel")) or fail('Read inventory');my @names=sort grep {$_ ne '.' && $_ ne '..'} readdir($dh);closedir($dh);
        for my $name (@names) {
            my $p=$rel eq ''?$name:"$rel/$name";my $full="$path/$p";my @st=lstat($full);fail('Source changed during inventory') unless @st;
            if(S_ISDIR($st[2])) {$walk->(beneath($dir,$name,O_RDONLY|O_DIRECTORY,0),$p);}
            elsif(S_ISREG($st[2])) {
                my $fh=beneath($dir,$name,O_RDONLY|O_NONBLOCK,0);my @a=stat($fh);fail('File identity changed') unless $a[0]==$st[0] && $a[1]==$st[1] && S_ISREG($a[2]);
                my $sha=Digest::SHA->new(256)->addfile($fh)->hexdigest;my @b=stat($fh);fail('File changed while hashing') unless join(',',@a[0,1,2,4,5,7,9,10]) eq join(',',@b[0,1,2,4,5,7,9,10]);
                my $group=$links{"$a[0]:$a[1]"}//=$p;
                $rows{$p}={type=>'file',mode=>$a[2]&07777,uid=>$a[4],gid=>$a[5],mtime=>$a[9],size=>$a[7],sha256=>$sha,hardlink=>$group,xattrs=>xattrs($fh)};$files++;
            }
            elsif(S_ISLNK($st[2])) {my $link=readlink($full);fail('Symlink changed') unless defined($link);$rows{$p}={type=>'symlink',uid=>$st[4],gid=>$st[5],mtime=>$st[9],link=>$link,xattrs=>xattrs(undef,$full)};}
            elsif(S_ISFIFO($st[2]) || S_ISSOCK($st[2])) {
                # Preserve inert node metadata only. Never open/read a FIFO or
                # socket; path-based xattr syscalls explicitly do not follow links.
                $rows{$p}={type=>S_ISFIFO($st[2])?'fifo':'socket',mode=>$st[2]&07777,uid=>$st[4],gid=>$st[5],mtime=>$st[9],rdev=>0+$st[6],xattrs=>xattrs(undef,$full)};
            }
            elsif(S_ISCHR($st[2]) || S_ISBLK($st[2])) {fail('Device source files are not supported');}
            else {fail('Unsupported source file type');}
        }
    };$walk->($root,'');return (\%rows,$files);
}
sub isolated {
    my ($args,$source,$target,$runtime,$runtime_fhs)=@_;
    my $source_tree=clone_tree($source);my $target_tree=clone_tree($target);my @runtime_trees=map {clone_tree($_)} @$runtime_fhs;
    call('unshare',0x20000|0x20000000);my ($none,$slash)=('none','/');call('mount',$none,$slash,0,16384|262144,0);
    my ($tmpfs,$opts)=('tmpfs','size=16m,mode=0700');call('mount',$tmpfs,$jail,$tmpfs,2|4,$opts);
    make_path("$jail/source","$jail/target");
    for my $path (@$runtime) {my $parent=$path=~s{/[^/]+$}{}r;make_path($jail.$parent);sysopen(my $f,$jail.$path,O_CREAT|O_EXCL|O_WRONLY,0600) or fail('Create runtime mountpoint');close($f);}
    sysopen(my $jr,$jail,O_RDONLY|O_DIRECTORY) or fail('Open jail');
    my $src=beneath($jr,'source',O_RDONLY|O_DIRECTORY,0);my $dst=beneath($jr,'target',O_RDONLY|O_DIRECTORY,0);
    clone_mount($source_tree,$src,1|2|4|8);clone_mount($target_tree,$dst,2|4|8);
    for my $i (0..$#$runtime) {my $dest=beneath($jr,substr($runtime->[$i],1),O_RDONLY,0);clone_mount($runtime_trees[$i],$dest,1|2|4);}
    attrs($jr,1|2|4|8);
    # No proc, inherited directory handles, executable escape capability, or
    # writable jail metadata is available to either rsync or the verifier.
    open(my $caps,'<','/proc/sys/kernel/cap_last_cap') or fail('Capability inventory unavailable');
    my $last=<$caps>;close($caps);
    # Update PerlIO bookkeeping before the raw inherited-descriptor sweep.
    # Otherwise a reused FD can retain stale PerlIO references and fail to close.
    close($_) for ($source,$target,$source_tree,$target_tree,@$runtime_fhs,@runtime_trees,$jr,$src,$dst);
    close_extra();close(STDIN);
    chdir($jail) && chroot('.') && chdir('/') or fail('Enter private root');
    drop_privileges($last);
    # This child becomes PID 1 in the private PID namespace. Linux kills all
    # namespace members when it exits, including rsync's sender/receiver fork.
    pipe(my $ready_read,my $ready_write) or fail('Create namespace handshake');
    my $init=fork();fail('Fork namespace init') unless defined($init);
    if($init) {
        close($ready_read);
        # Keep the liveness writer open until init has exited. A buffered
        # one-shot handshake cannot prove this supervisor still exists.
        waitpid($init,0);my $status=$?;close($ready_write);_exit(($status&127)?128+($status&127):$status>>8);
    }
    close($ready_write);call('prctl',1,9,0,0,0);
    # PDEATHSIG cannot report a death that happened before registration.
    # EOF closes that window; a death after registration triggers SIGKILL.
    fcntl($ready_read,F_SETFL,O_NONBLOCK) or fail('Configure supervisor liveness pipe');
    my $ready='';my $alive=sysread($ready_read,$ready,1);
    fail('Copy supervisor exited') if defined($alive) || !($!{EAGAIN} || $!{EWOULDBLOCK});
    close($ready_read);
    my ($before,$files)=inventory('/source');
    if($args->{op} eq 'copy') {
        event({phase=>'copying',percent=>0,bytes=>0});
        open(my $progress,'-|','/usr/bin/rsync','--archive','--hard-links','--acls','--xattrs','--sparse','--numeric-ids','--one-file-system','--no-devices','--specials','--info=progress2','--no-human-readable','--outbuf=L','--','/source/','/target/') or fail('Start confined rsync');
        my $buffer='';my $consume=sub {
            my ($line)=@_;
            # Only numeric progress is exported. Never relay rsync filenames,
            # diagnostics or arbitrary stdout as operational JSON.
            if($line=~/^\s*([0-9,]+)\s+([0-9]{1,3})%\s+/ && $2<=100) {
                my ($bytes,$percent)=($1,$2);$bytes=~s/,//g;
                event({phase=>'copying',percent=>0+$percent,bytes=>0+$bytes});
            }
        };
        while(1) {
            my $chunk='';my $n=sysread($progress,$chunk,4096);fail('Read confined rsync progress') unless defined($n);last unless $n;
            $buffer.=$chunk;
            while($buffer=~s/^([^\r\n]*)[\r\n]//) {$consume->($1);}
            fail('Confined rsync progress exceeded limit') if length($buffer)>8192;
        }
        $consume->($buffer) if length($buffer);
        close($progress) or fail('Confined rsync failed (status '.$?.')');
    }
    event({phase=>'verifying',percent=>100});
    my ($after)=inventory('/source');my ($copied)=inventory('/target');
    fail('Source changed during copy or verification') unless $json->encode($before) eq $json->encode($after);
    fail('SHA-256, metadata, ACL, xattr, symlink or hardlink verification failed') unless $json->encode($before) eq $json->encode($copied);
    return {ok=>JSON::PP::true,phase=>'completed',verified_files=>$files,manifest_sha256=>Digest::SHA::sha256_hex($json->encode($before)),confinement=>'private-mount-namespace-chroot'};
}

my $result;
$SIG{TERM}=$SIG{INT}=sub {die "Confined copy interrupted\n"};
eval {
    my @u=uname();fail('Linux x86_64/aarch64 required') unless $^O eq 'linux' && ($u[4] eq 'aarch64'||$u[4] eq 'x86_64');
    %nr=(openat2=>437,open_tree=>428,move_mount=>429,mount_setattr=>442);
    @nr{qw(mount unshare prctl capset flistxattr fgetxattr llistxattr lgetxattr)}=$u[4] eq 'aarch64'?(40,97,167,91,13,10,12,9):(165,272,157,126,196,193,195,192);
    fail('Root required') unless $>==0;
    fail('All standard streams must be pipes') unless -p STDIN && -p STDOUT && -p STDERR;
    my $raw=do {local $/;<STDIN>};fail('Request too large') if !defined($raw)||length($raw)>16384;my $args=$json->decode($raw);
    fail('Invalid operation') unless ref($args) eq 'HASH' && ($args->{op}//'')=~/^(copy|verify)$/;
    for my $key (qw(source target staging)) {fail('Invalid pinned root') unless ref($args->{$key}) eq 'HASH';$args->{$key}{path}=encode_utf8($args->{$key}{path}) if defined($args->{$key}{path});}
    my $source=root_pin($args->{source});my $target=root_pin($args->{target});my $stage=root_pin($args->{staging});
    my @ss=stat($stage);fail('Staging must be root-owned mode 0700') unless $ss[4]==0 && ($ss[2]&07777)==0700;
    secure_ancestors($args->{staging}{path});fail('Target must be directly inside staging') unless $args->{target}{path} eq $args->{staging}{path}.'/target';
    my @ts=stat($target);my @src=stat($source);fail('Source and target must be different filesystems') if $src[0]==$ts[0];my @rs=stat('/');fail('Host filesystem cannot be a target') if $ts[0]==$rs[0];
    open(my $fi,'<','/proc/self/fdinfo/'.fileno($target)) or fail('Mount identity unavailable');my $info=do {local $/;<$fi>};close($fi);my ($id)=$info=~/^mnt_id:\s+(\d+)$/m;fail('Mount identity unavailable') unless $id;
    open(my $mi,'<','/proc/self/mountinfo') or fail('Mount inventory unavailable');my @mounts=<$mi>;close($mi);my ($line)=grep {/^$id /} @mounts;fail('Target mount missing') unless defined $line;
    my @target_mount=split(/ /,$line);
    for my $mount (@mounts) {
        my @m=split(/ /,$mount);fail('Target filesystem has another mounted alias') if $m[2] eq $target_mount[2] && $m[0] ne $id;my $point=$m[4];$point=~s/\\([0-7]{3})/chr(oct($1))/ge;
        for my $kind (qw(source target)) {fail('Nested mounts are not supported') if index($point,$args->{$kind}{path}.'/')==0;}
    }
    my @fields=split(/ /,$line);my $mp=$fields[4];$mp=~s/\\([0-7]{3})/chr(oct($1))/ge;
    fail('Target must be a complete writable filesystem root') unless $fields[3] eq '/' && $mp eq $args->{target}{path} && $fields[5]=~/(^|,)rw(,|$)/;
    if($args->{op} eq 'copy') {opendir(my $d,$args->{target}{path}) or fail('Read target');my @e=grep {$_ ne '.' && $_ ne '..'} readdir($d);closedir($d);fail('New copy target must be empty') if @e;}
    local %ENV=(PATH=>'/usr/bin:/bin',LC_ALL=>'C');
    my $rsync=trusted_file('/usr/bin/rsync');my $ldd=trusted_file('/usr/bin/ldd');
    open(my $ld,'-|','/usr/bin/ldd','/usr/bin/rsync') or fail('Dependency inspection failed');my $deps=do {local $/;<$ld>};close($ld) or fail('Dependency inspection failed');
    fail('Missing shared dependency') if $deps=~/not found/;
    my @runtime=('/usr/bin/rsync',sort keys %{ {map {$_=>1} ($deps=~m{(/[\w./+:-]+)}g)} });
    my @runtime_fhs=map {trusted_file($_)} @runtime;
    $jail=$args->{staging}{path}.'/.zfsm-copy-jail-'.$$;mkdir($jail,0700) or fail('Create private jail');
    pipe(my $read,my $write) or fail('Create result pipe');$child=fork();fail('Fork failed') unless defined $child;
    if(!$child) {
        close($stage);close($rsync);close($ldd);close($read);call('prctl',1,9,0,0,0);_exit(1) unless getppid()==$supervisor_pid;open(STDOUT,'>&',$write) or _exit(1);close($write);my $out;
        eval {
            # Namespace setup retains privilege; escape capabilities are removed
            # immediately after chroot and before processing source contents.
            $out=isolated($args,$source,$target,\@runtime,\@runtime_fhs);1;
        } or $out={ok=>JSON::PP::false,error=>($@||'Copy failed')};
        event($out);_exit($out->{ok}?0:1);
    }
    close($write);my $final;
    while(my $row=<$read>) {
        fail('Confined copier event exceeded limit') if length($row)>16384;
        my $item=$json->decode($row);fail('Invalid confined copier event') unless ref($item) eq 'HASH';
        if(exists($item->{ok})) {$final=$item;} else {event($item);}
    }
    close($read);waitpid($child,0);my $status=$?;$child=undef;
    rmdir($jail) or fail('Private jail cleanup failed');$jail=undef;
    fail('Confined copier exited without a final result') unless defined($final);
    fail('Confined copier exited unsuccessfully') if $status && $final->{ok};
    $result=$final;1;
} or $result={ok=>JSON::PP::false,error=>($@||'Copy failed')};
if(defined($child)) {kill('TERM',$child);waitpid($child,0);}
rmdir($jail) if defined $jail;
print $json->encode($result)."\n";exit($result->{ok}?0:1);
