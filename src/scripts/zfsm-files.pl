#!/usr/bin/perl
# Filesystem boundary for Snapshot Explorer. No shell commands, no symlink
# traversal. Linux openat2 pins paths beneath validated ZFS roots.
use strict;
use warnings;
use utf8;
use JSON::PP;
use Encode qw(encode decode FB_CROAK LEAVE_SRC);
use Fcntl qw(:DEFAULT :mode);
use POSIX qw(uname);
use Digest::SHA qw(sha256_hex);
use IO::Handle;

my $json=JSON::PP->new->utf8->canonical;
sub file_error { die $_[0]."\n" }
sub safe_path {
    my ($p)=@_;
    file_error('Invalid relative path') if !defined($p) || ref($p) || length($p)>4096 || $p=~/\0/ || $p=~m{^/};
    return '' if $p eq '';
    my @parts=split m{/},$p,-1;
    file_error('Invalid relative path') if @parts>128 || grep { $_ eq '' || $_ eq '.' || $_ eq '..' || $_ eq '.zfs' || /^\.zfsm-(restore|archive)-/ } @parts;
    return $p;
}
sub normalize_selection {
    my ($input)=@_;
    file_error('Select at least one file or folder (up to 1000 selections)') unless ref($input) eq 'ARRAY' && @$input && @$input<=1000;
    my (%seen,@out);
    for my $p (sort map { safe_path($_) } @$input) {
        file_error('Select files or folders, not the entire snapshot root') if $p eq '';
        next if $seen{$p}++ || grep { index($p,$_.'/')==0 } @out;
        push @out,$p;
    }
    return \@out;
}
sub filter_page {
    my ($entries,$filter,$sort,$direction,$offset,$hidden,$kind)=@_; $kind//='all';
    file_error('Invalid file type filter') unless $kind=~/^(all|file|directory)$/;
    $filter='' unless defined($filter); file_error('Filter is too long') if length($filter)>255;
    file_error('Invalid sort') unless $sort=~/^(name|size|mtime)$/;
    file_error('Invalid sort direction') unless $direction=~/^(asc|desc)$/;
    file_error('Invalid page') unless defined($offset) && $offset=~/^\d+$/ && $offset<=100000;
    my @rows=grep { ($kind eq 'all'||$_->{type} eq $kind) && ($hidden || substr($_->{name},0,1) ne '.') && index(lc($_->{name}),lc($filter))>=0 } @$entries;
    @rows=sort {
        (($b->{type} eq 'directory') <=> ($a->{type} eq 'directory')) ||
        (($sort eq 'name' ? lc($a->{name}) cmp lc($b->{name}) : $a->{$sort}<=>$b->{$sort}) * ($direction eq 'desc' ? -1 : 1)) || ($a->{name} cmp $b->{name})
    } @rows;
    my $total=@rows; my @page=$offset<$total ? @rows[$offset..($offset+199<$total?$offset+199:$total-1)] : ();
    return {entries=>\@page,total=>$total,offset=>0+$offset,limit=>200};
}
sub utfpath { return encode('UTF-8',$_[0],FB_CROAK|LEAVE_SRC) }
my %syscalls;
sub platform {
    my @u=uname();
    # Linux UAPI numbers differ for directory mutations. Unknown ABIs fail closed.
    my %abi=(x86_64=>[437,258,316,263],aarch64=>[437,34,276,35]);
    file_error('Snapshot Explorer requires Linux x86_64 or aarch64 with openat2 support') unless $^O eq 'linux' && exists($abi{$u[4]});
    @syscalls{qw(openat2 mkdirat renameat2 unlinkat)}=@{$abi{$u[4]}};
}
sub open_beneath {
    my ($base,$path,$flags,$root)=@_;
    # Linux openat2: NO_XDEV=1, NO_SYMLINKS=4, BENEATH=8.
    my $how=pack('Q<Q<Q<',$flags,0,4|8|($root?0:1));
    my $name=utfpath($path eq ''?'.':$path);
    my $fd=syscall($syscalls{openat2},fileno($base),$name,$how,length($how));
    file_error('Path is unavailable, crosses a mount, or contains a symbolic link: '.$path) if $fd<0;
    open(my $handle,'<&=',$fd) or file_error('Unable to pin file');
    return $handle;
}
sub root_handle {
    my ($path,$expected)=@_;
    file_error('Invalid filesystem root') unless defined($path) && $path=~m{^/} && $path!~/\0/;
    sysopen(my $slash,'/',O_RDONLY|O_DIRECTORY) or file_error('Unable to open filesystem root');
    my $handle=open_beneath($slash,substr($path,1),O_RDONLY|O_DIRECTORY,1);
    my @s=stat($handle);
    file_error('Filesystem identity changed; reopen the snapshot') unless ref($expected) eq 'HASH' && "$s[0]" eq "$expected->{dev}" && "$s[1]" eq "$expected->{ino}";
    return $handle;
}
sub anchor { return '/proc/'.($$).'/fd/'.fileno($_[0]) }
sub signature {
    my (@s)=@_; return undef unless @s;
    my $type=S_ISDIR($s[2])?'directory':S_ISREG($s[2])?'file':S_ISLNK($s[2])?'symlink':'special';
    return {dev=>"$s[0]",ino=>"$s[1]",mode=>0+$s[2],uid=>0+$s[4],gid=>0+$s[5],type=>$type,size=>($type eq 'directory'?0:0+$s[7]),mtime=>($type eq 'directory'?0:0+$s[9]),ctime=>($type eq 'directory'?0:0+$s[10])};
}
sub child_stat {
    my ($dir,$name)=@_; my @s=lstat(anchor($dir).'/'.utfpath($name)); return signature(@s);
}
sub content_identity {
    my ($root,$path,$stat)=@_;return $stat unless $stat && $stat->{type} eq 'file';
    my $fh=open_beneath($root,$path,O_RDONLY|O_NONBLOCK,0);my $before=signature(stat($fh));
    file_error('Destination changed while checking conflicts') unless $json->encode($before) eq $json->encode($stat);
    my $sha=Digest::SHA->new(256);$sha->addfile($fh);
    file_error('Destination changed while checking conflicts') unless $json->encode(signature(stat($fh))) eq $json->encode($before);
    return {%$stat,sha256=>$sha->hexdigest};
}
sub path_stat {
    my ($root,$p)=@_;
    return signature(stat($root)) if $p eq '';
    my @parts=split m{/},$p; my $name=pop @parts; my $parent=$root;
    for my $part (@parts) {
        my $s=child_stat($parent,$part); return undef unless $s;
        file_error('Destination contains a link or non-folder: '.$p) unless $s->{type} eq 'directory';
        $parent=open_beneath($parent,$part,O_RDONLY|O_DIRECTORY,0);
    }
    my $s=child_stat($parent,$name);
    # Even empty bind mounts must be rejected, including same-device mounts.
    open_beneath($parent,$name,O_RDONLY|O_DIRECTORY,0) if $s && $s->{type} eq 'directory';
    return $s;
}
sub directory_entries {
    my ($root,$path)=@_; my $dir=open_beneath($root,$path,O_RDONLY|O_DIRECTORY,0);
    opendir(my $dh,anchor($dir)) or file_error('Unable to read directory'); my @rows;
    while(defined(my $raw=readdir($dh))) {
        next if $raw eq '.' || $raw eq '..' || $raw eq '.zfs' || $raw=~/^\.zfsm-(restore|archive)-/;
        file_error('Directory exceeds 100000 entries; select a smaller folder') if @rows>=100000;
        my $name=eval { decode('UTF-8',$raw,FB_CROAK) }; file_error('Directory contains a filename that is not valid UTF-8') if $@;
        my $s=child_stat($dir,$name); next unless $s;
        my $type=$s->{type}; my $available=($type eq 'directory'||$type eq 'file')?1:0;
        if ($available) { eval { my $h=open_beneath($dir,$name,O_RDONLY|($type eq 'directory'?O_DIRECTORY:O_NONBLOCK),0); }; $available=0 if $@; }
        push @rows,{name=>$name,path=>($path eq ''?$name:$path.'/'.$name),type=>$type,size=>$s->{size},mtime=>(lstat(anchor($dir).'/'.utfpath($name)))[9]+0,available=>$available?JSON::PP::true:JSON::PP::false};
    }
    closedir($dh); return \@rows;
}
sub make_plan {
    my ($source,$dest,$args)=@_; my $selection=normalize_selection($args->{selection});
    my $target=safe_path($args->{target}); my $mode=$args->{mode}//'new';
    file_error('Invalid restore mode') unless $mode eq 'new' || $mode eq 'overwrite';
    file_error('Use a new folder name directly inside this dataset') if $mode eq 'new' && ($target eq '' || $target=~m{/});
    my $target_stat=path_stat($dest,$target);
    file_error('Destination already exists; choose a different new folder') if $mode eq 'new' && $target_stat;
    file_error('Overwrite destination must be an existing folder in this dataset') if $mode eq 'overwrite' && (!$target_stat || $target_stat->{type} ne 'directory');
    my (@entries,%included); my $bytes=0; my @conflicts;
    my $add;
    $add=sub {
        my ($path,$recurse)=@_; return if $included{$path}++;
        file_error('Selection exceeds 100000 entries; restore smaller batches') if @entries>=100000;
        my $src=path_stat($source,$path); file_error('Snapshot entry is unavailable: '.$path) unless $src;
        file_error('Links and special files cannot be restored: '.$path) unless $src->{type} eq 'file' || $src->{type} eq 'directory';
        my $to=($target eq ''?'':$target.'/').$path; my $current=content_identity($dest,$to,path_stat($dest,$to));
        file_error('Destination has a different type or a symbolic link: '.$to) if $current && $current->{type} ne $src->{type};
        my $row={path=>$path,type=>$src->{type},size=>$src->{size},source=>$src,destination=>$current}; push @entries,$row;
        if ($src->{type} eq 'file') { $bytes+=$src->{size}; push @conflicts,$to if $current; }
        if ($src->{type} eq 'directory' && $recurse) { for my $e (@{directory_entries($source,$path)}) { $add->($e->{path},1); } }
    };
    for my $path (@$selection) {
        my @parts=split m{/},$path; pop @parts; my $parent='';
        for my $part (@parts) { $parent.=($parent eq ''?'':'/').$part; $add->($parent,0); }
        $add->($path,1);
    }
    @entries=sort { $a->{path} cmp $b->{path} } @entries;
    return {selection=>$selection,target=>$target,mode=>$mode,entries=>\@entries,bytes=>$bytes,files=>0+grep($_->{type} eq 'file',@entries),conflicts=>\@conflicts,target_identity=>$target_stat};
}
sub join_path { return $_[0] eq ''?$_[1]:$_[0].'/'.$_[1] }
sub mkdir_child {
    my ($dir,$name,$mode)=@_; my $raw=utfpath($name);
    file_error('Unable to create destination folder: '.$name) if syscall($syscalls{mkdirat},fileno($dir),$raw,$mode)!=0;
    $dir->sync or file_error('Unable to flush destination folder');
    return open_beneath($dir,$name,O_RDONLY|O_DIRECTORY,0);
}
sub ensure_parent {
    my ($root,$path)=@_; my @parts=split m{/},$path; my $name=pop @parts; my $dir=$root;
    for my $part (@parts) {
        my $s=child_stat($dir,$part);
        if ($s) { file_error('Destination folder changed') unless $s->{type} eq 'directory'; $dir=open_beneath($dir,$part,O_RDONLY|O_DIRECTORY,0); }
        else { $dir=mkdir_child($dir,$part,0700); }
    }
    return ($dir,$name);
}
sub move_noreplace {
    my ($from,$old,$to,$new)=@_; my $a=utfpath($old); my $b=utfpath($new);
    # Linux renameat2, RENAME_NOREPLACE=1. Never overwrite an unreviewed file.
    file_error('Destination changed while publishing; copied and original files are retained') if syscall($syscalls{renameat2},fileno($from),$a,fileno($to),$b,1)!=0;
    $from->sync && $to->sync or file_error('Unable to flush published files; inspect retained job');
}
sub reviewed_parent {
    my ($root,$path,$directories)=@_;my @parts=split m{/},$path;my $name=pop @parts;my $dir=$root;my $relative='';
    for my $part (@parts) {
        $relative=join_path($relative,$part);$dir=open_beneath($dir,$part,O_RDONLY|O_DIRECTORY,0);
        file_error('A destination folder was replaced during publication: '.$relative) unless exists($directories->{$relative}) && $json->encode(signature(stat($dir))) eq $json->encode($directories->{$relative});
    }
    return ($dir,$name);
}
sub remove_owned_empty {
    my ($parent,$name,$directory)=@_;my $raw=utfpath($name);
    file_error('Restoration finished, but temporary metadata cleanup failed') if syscall($syscalls{unlinkat},fileno($parent),$raw,$directory?512:0)!=0;
    $parent->sync or file_error('Unable to flush temporary metadata cleanup');
}
sub emit { print $json->encode($_[0])."\n" or file_error('Progress channel closed'); STDOUT->flush; }
sub rsync_copy {
    my ($source,$data,$container,$plan,$verify)=@_;
    my $list=anchor($container).'/selection.list';
    if (!$verify) {
        sysopen(my $fh,$list,O_WRONLY|O_CREAT|O_EXCL,0600) or file_error('Unable to create copy manifest'); binmode($fh);
        print $fh ".\0" or file_error('Unable to write source root metadata');
        for my $row (@{$plan->{entries}}) { print $fh utfpath($row->{path})."\0" or file_error('Unable to write copy manifest'); }
        $fh->flush && $fh->sync or file_error('Unable to flush copy manifest; current files were not replaced');
        close($fh) or file_error('Unable to close copy manifest; current files were not replaced');
    }
    my @cmd=('/usr/bin/rsync','-aHAXS','--numeric-ids','--fsync','--no-recursive','--dirs','--relative','--no-implied-dirs','--one-file-system','--from0','--files-from='.$list,'--info=progress2','--out-format=%i',($verify?('--dry-run','--checksum'):()),'--',anchor($source).'/',anchor($data).'/');
    open(my $pipe,'-|',@cmd) or file_error('Unable to start file copy'); my $buffer=''; my $changed=0;
    while (read($pipe,my $chunk,8192)) {
        $buffer.=$chunk;
        while($buffer=~s/^(.*?)[\r\n]//s) {
            my $line=$1; $changed=1 if $verify && $line=~/^[<>ch\.][fdLDS]/;
            if (!$verify && $line=~/^\s*([\d,]+)\s+(\d+)%/) { my $bytes=$1; $bytes=~s/,//g; emit({phase=>'copying',bytes=>0+$bytes,percent=>int($2*.85)}); }
        }
        file_error('Unexpected copy output') if length($buffer)>65536;
    }
    close($pipe) or file_error($verify?'Copied files could not be verified':'Copy failed; current files were not replaced');
    file_error('Copied files differ from the snapshot; current files were not replaced') if $changed;
}
sub restore {
    my ($source,$dest,$args)=@_; my $plan=$args->{plan};
    file_error('Invalid restore manifest') unless ref($plan) eq 'HASH' && ref($plan->{entries}) eq 'ARRAY';
    my $fresh=make_plan($source,$dest,$plan);
    file_error('Files or destination changed since confirmation; review again') unless $json->encode($fresh) eq $json->encode($plan);
    my $id=$args->{id}; file_error('Invalid restore job') unless $id=~/^\d{8}-\d{6}-[a-f0-9]{12}$/;
    my $name='.zfsm-restore-'.$id;
    file_error('Restore staging already exists; inspect the retained job before retrying') if child_stat($dest,$name);
    my $container=mkdir_child($dest,$name,0700); my $data=mkdir_child($container,'data',0700); my $backup=mkdir_child($container,'replaced',0700);
    emit({phase=>'copying',bytes=>0,percent=>0,staging=>$name});
    rsync_copy($source,$data,$container,$plan,0); emit({phase=>'verifying',bytes=>$plan->{bytes},percent=>86}); rsync_copy($source,$data,$container,$plan,1);
    # Complete recheck after copying, before the first live-file replacement.
    $fresh=make_plan($source,$dest,$plan);
    file_error('Destination changed during copying; current files were not replaced') unless $json->encode($fresh) eq $json->encode($plan);
    emit({phase=>'publishing',bytes=>$plan->{bytes},percent=>90});
    if ($plan->{mode} eq 'new') {
        move_noreplace($container,'data',$dest,$plan->{target});
        remove_owned_empty($container,'selection.list',0);
        remove_owned_empty($container,'replaced',1);
        remove_owned_empty($dest,$name,1);
    } else {
        my $destination=open_beneath($dest,$plan->{target},O_RDONLY|O_DIRECTORY,0); my $done=0; my @published;
        file_error('Restore destination was replaced during publication') unless $json->encode(signature(stat($destination))) eq $json->encode($plan->{target_identity});
        my %directories=map { $_->{type} eq 'directory' ? ($_->{path}=>$_->{destination}) : () } @{$plan->{entries}};
        for my $row (@{$plan->{entries}}) {
            my $path=$row->{path};next if grep { index($path,$_.'/')==0 } @published;
            my ($parent,$base)=reviewed_parent($destination,$path,\%directories);
            my $current=content_identity($parent,$base,child_stat($parent,$base));
            file_error('Destination changed during publication: '.$path) unless $json->encode($current) eq $json->encode($row->{destination});
            if ($row->{type} eq 'directory') {
                if (!$current) { my ($sp,$sn)=ensure_parent($data,$path);move_noreplace($sp,$sn,$parent,$base);push @published,$path; }
                next;
            }
            if ($current) {
                my ($bp,$bn)=ensure_parent($backup,$path); move_noreplace($parent,$base,$bp,$bn);
                # rename changes ctime; every other identity/content field must
                # still match the reviewed conflict before publishing our copy.
                my $moved=content_identity($bp,$bn,child_stat($bp,$bn));my %expected=%$current;
                delete $expected{ctime};delete $moved->{ctime};
                if($json->encode($moved) ne $json->encode(\%expected)) {
                    eval { move_noreplace($bp,$bn,$parent,$base); };
                    file_error('A current file changed during replacement. The copied and current versions are retained; inspect this job before retrying');
                }
            }
            my ($sp,$sn)=ensure_parent($data,$path); move_noreplace($sp,$sn,$parent,$base);
            $done++; emit({phase=>'publishing',files=>$done,bytes=>$plan->{bytes},percent=>90+int(9*$done/($plan->{files}||1)),current=>$path});
        }
        # New directories move with rsync-preserved ACLs/xattrs/ownership.
        # Existing directories keep their live metadata and unrelated files.
    }
    emit({phase=>'completed',percent=>100,bytes=>$plan->{bytes},files=>$plan->{files},recovery=>($plan->{mode} eq 'overwrite' && @{$plan->{conflicts}} ? $name.'/replaced' : ''),staging=>$name});
}
sub archive_name {
    my ($args)=@_;file_error('Invalid archive job') unless ($args->{id}//'')=~/^\d{8}-\d{6}-[a-f0-9]{12}$/;
    return '.zfsm-archive-'.$args->{id};
}
sub archive_entries {
    my ($source,$selection)=@_;my (%seen,@rows);my $walk;
    $walk=sub {
        my($path,$recursive)=@_;return if $seen{$path}++;safe_path($path);
        file_error('Selection exceeds 100000 entries; download smaller batches') if @rows>=100000;
        my $sig=path_stat($source,$path);
        file_error('Links and special files cannot be archived: '.$path) unless $sig && ($sig->{type} eq 'directory'||$sig->{type} eq 'file');
        my $fh=open_beneath($source,$path,O_RDONLY|O_NONBLOCK,0);my @s=stat($fh);
        file_error('Snapshot entry changed') unless $json->encode($sig) eq $json->encode(signature(@s));
        push @rows,{path=>$path,stat=>$sig,mtime=>$s[9]};
        if($recursive&&$sig->{type} eq 'directory'){for my $row (@{directory_entries($source,$path)}){$walk->($row->{path},1);}}
    };
    for my $path (@{normalize_selection($selection)}){my @parts=split m{/},$path;pop @parts;my $p='';for(@parts){$p=join_path($p,$_);$walk->($p,0);}$walk->($path,1);}
    return [sort {$a->{path} cmp $b->{path}} @rows];
}
sub create_archive {
    my ($source,$dest,$args)=@_;
    require IO::Compress::Zip;
    my $rows=archive_entries($source,$args->{selection});my $total=0;$total+=$_->{stat}{size} for @$rows;
    my $container=mkdir_child($dest,archive_name($args),0700);
    sysopen(my $out,anchor($container).'/archive.part',O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600) or file_error('Unable to create ZIP; check free space');binmode($out);
    file_error('Archive ownership token is unavailable') unless ($args->{archive_token}//'')=~/^[a-f0-9]{64}$/;
    sysopen(my $owner,anchor($container).'/.owner',O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600) or file_error('Unable to create archive ownership record');
    print $owner $json->encode({token=>$args->{archive_token},container_ino=>''.((stat($container))[1]),file_ino=>''.((stat($out))[1])}) or file_error('Unable to write archive ownership record');
    $owner->flush && $owner->sync && $container->sync or file_error('Unable to flush archive ownership record');close($owner);
    emit({phase=>'compressing',percent=>0,bytes=>0,total=>$total});
    my ($zip,$done,$last)=(undef,0,0);
    for my $row (@$rows){
        my $isdir=$row->{stat}{type} eq 'directory';
        my $fh=open_beneath($source,$row->{path},O_RDONLY|O_NONBLOCK,0);
        file_error('Snapshot file identity changed') unless $json->encode(signature(stat($fh))) eq $json->encode($row->{stat});
        my @options=(Name=>utfpath($row->{path}.($isdir?'/':'')),Efs=>1,Time=>$row->{mtime},ExtAttr=>($row->{stat}{mode}<<16)|($isdir?16:0),Level=>9,Zip64=>1);
        if(!$zip){$zip=IO::Compress::Zip->new($out,@options,AutoClose=>0) or file_error('ZIP compression could not start');}
        else{$zip->newStream(@options) or file_error('Unable to append ZIP entry; check free space');}
        if(!$isdir){while(1){my $n=sysread($fh,my $chunk,1048576);file_error('Unable to read snapshot file') unless defined($n);last unless $n;
            $zip->print($chunk) or file_error('ZIP write failed; check free space');$done+=$n;
            if(time()!= $last){emit({phase=>'compressing',percent=>int(98*$done/($total||1)),bytes=>$done,total=>$total,current=>$row->{path}});$last=time();}
        }}
    }
    $zip->close or file_error('Unable to finish ZIP; check free space');$out->flush && $out->sync or file_error('Unable to flush ZIP');close($out);
    move_noreplace($container,'archive.part',$container,'archive.zip');
    my $stat=child_stat($container,'archive.zip');
    emit({phase=>'completed',percent=>100,bytes=>$done,total=>$total,archive_size=>$stat->{size},archive_identity=>$stat});
}
sub archive_access {
    my ($dest,$args)=@_;my $name=archive_name($args);my $stat=child_stat($dest,$name);
    if(!$stat && $args->{op} eq 'archive-cleanup'){emit({removed=>JSON::PP::true});return;}
    my $container=open_beneath($dest,$name,O_RDONLY|O_DIRECTORY,0);my @s=stat($container);
    file_error('Archive cache ownership changed') unless $s[4]==0 && ($s[2]&0777)==0700;
    if($args->{op} eq 'archive-cleanup'){
        my $owner=open_beneath($container,'.owner',O_RDONLY|O_NONBLOCK,0);my @o=stat($owner);
        file_error('Archive ownership record is invalid') unless S_ISREG($o[2])&&$o[4]==0&&($o[2]&0777)==0600&&$o[7]<1024;
        local $/;my $proof=$json->decode(<$owner>);
        file_error('Archive directory was replaced; cleanup refused') unless ($proof->{token}//'') eq ($args->{archive_token}//'invalid') && ($proof->{container_ino}//'') eq "$s[1]";
        for my $file ('archive.part','archive.zip'){
            my $s=child_stat($container,$file);next unless $s;
            file_error('Archive cache contains an unexpected object') unless $s->{type} eq 'file' && $s->{uid}==0 && ($s->{mode}&0777)==0600 && $s->{ino} eq ($proof->{file_ino}//'');
            remove_owned_empty($container,$file,0);
        }
        remove_owned_empty($container,'.owner',0);remove_owned_empty($dest,$name,1);emit({removed=>JSON::PP::true});return;
    }
    my $fh=open_beneath($container,'archive.zip',O_RDONLY|O_NONBLOCK,0);my $s=signature(stat($fh));
    file_error('Archive identity changed; prepare a new ZIP') unless $s->{type} eq 'file' && $json->encode($s) eq $json->encode($args->{archive_identity});
    emit({ready=>JSON::PP::true,size=>$s->{size}});
    while(1){my $n=sysread($fh,my $bytes,1048576);file_error('Unable to read ZIP') unless defined($n);last unless $n;print STDOUT $bytes or last;}
}
sub main {
    platform(); binmode(STDIN); binmode(STDOUT); $|=1; umask(0077);
    my $input=\*STDIN;
    if (@ARGV) {
        file_error('Invalid file helper arguments') unless @ARGV==2 && $ARGV[0] eq '--request-file';
        sysopen(my $fh,$ARGV[1],O_RDONLY|O_NOFOLLOW) or file_error('Restore manifest is unavailable');
        my @s=stat($fh);file_error('Invalid restore manifest ownership') unless S_ISREG($s[2]) && $s[4]==0 && ($s[2]&0077)==0;
        $input=$fh;
    }
    my $raw=''; while(read($input,my $chunk,65536)) { $raw.=$chunk; file_error('Request is too large') if length($raw)>64*1024*1024; }
    my $args=$json->decode($raw); file_error('Invalid request') unless ref($args) eq 'HASH';
    my $op=$args->{op}//'';
    if($op eq 'archive-download'||$op eq 'archive-cleanup'){archive_access(root_handle($args->{destination},$args->{destination_identity}),$args);return;}
    my $source=root_handle($args->{source},$args->{source_identity});
    if ($op eq 'list') { my $path=safe_path($args->{path}//''); emit(filter_page(directory_entries($source,$path),$args->{filter}//'',$args->{sort}//'name',$args->{direction}//'asc',$args->{offset}//0,$args->{hidden},$args->{kind}//'all')); }
    elsif ($op eq 'download' || $op eq 'fileinfo') {
        my $p=safe_path($args->{path}); file_error('Choose a file to download') if $p eq '';
        my $stat=path_stat($source,$p);file_error('Only regular files can be downloaded') unless $stat && $stat->{type} eq 'file';
        my $fh=open_beneath($source,$p,O_RDONLY|O_NONBLOCK,0); my @s=stat($fh); file_error('Only regular files can be downloaded') unless S_ISREG($s[2]);
        emit({ready=>JSON::PP::true,size=>0+$s[7]}); return if $op eq 'fileinfo';
        while (1) { my $n=sysread($fh,my $bytes,1024*1024); file_error('Unable to read snapshot file') unless defined($n); last unless $n; print STDOUT $bytes or last; }
    } elsif ($op eq 'archive') {
        create_archive($source,root_handle($args->{destination},$args->{destination_identity}),$args);
    } elsif ($op eq 'plan' || $op eq 'restore') {
        my $dest=root_handle($args->{destination},$args->{destination_identity});
        if ($op eq 'plan') { emit(make_plan($source,$dest,$args)); } else { restore($source,$dest,$args); }
    } else { file_error('Unknown file operation'); }
}
unless (caller) { eval { main(); 1 } or do { my $error=$@||'File operation failed'; $error=~s/\s+$//; print STDERR $json->encode({error=>$error})."\n"; exit 1; }; }
1;
