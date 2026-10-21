#!/usr/bin/env python3
"""Disposable-container-only confinement regression; never run on the host."""
import ctypes, hashlib, json, os, pathlib, select, shutil, signal, socket, stat, subprocess, sys, tempfile, time

if not pathlib.Path('/.dockerenv').exists():
    raise SystemExit('Run only in the disposable native Linux container')
HELPER='/stand/src/scripts/zfsm-copy-confined.pl'
libc=ctypes.CDLL(None, use_errno=True)

def ident(path):
    s=os.stat(path)
    return dict(path=path,dev=str(s.st_dev),ino=str(s.st_ino))

def mount(target, options='size=32m'):
    if libc.mount(b'tmpfs',os.fsencode(target),b'tmpfs',0,options.encode()):
        raise OSError(ctypes.get_errno(),'test tmpfs mount failed')

def invoke(source,target,stage,op='copy',helper=HELPER):
    p=subprocess.run(['perl',str(helper)],input=json.dumps(dict(op=op,source=ident(source),target=ident(target),staging=ident(stage))),text=True,capture_output=True)
    try:
        rows=[json.loads(line) for line in p.stdout.splitlines()]
        result=rows[-1]
        result['_events']=rows[:-1]
    except Exception: result={'error':p.stdout+p.stderr}
    return p,result

def fixture(base,name,size='size=32m'):
    stage=str(base/name); os.mkdir(stage,0o700)
    target=stage+'/target';os.mkdir(target,0o700);mount(target,size)
    return stage,target

def run():
    assert subprocess.check_output(['rsync','--version'],text=True).splitlines()[0].startswith('rsync  version 3.5.1 ')
    with tempfile.TemporaryDirectory(prefix='copy-confined-',dir='/test') as b:
        base=pathlib.Path(b); source=str(base/'source');os.mkdir(source,0o777);os.chown(source,99,100);os.chmod(source,0o777)
        pathlib.Path(source+'/data').write_bytes(b'copy-content\x00'*1024)
        os.chown(source+'/data',99,100);os.chmod(source+'/data',0o660)
        os.setxattr(source+'/data',b'user.regression',b'xattr\x00value')
        # ACL v2: owner rw, named uid123 read, group r, mask r, other none.
        import struct
        acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',tag,perm,uid) for tag,perm,uid in [(1,6,0xffffffff),(2,4,123),(4,4,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])
        os.setxattr(source+'/data',b'system.posix_acl_access',acl)
        os.link(source+'/data',source+'/hard')
        with open(source+'/sparse','wb') as f:f.seek(8*1024*1024);f.write(b'end')
        os.symlink('/outside/sentinel',source+'/absolute');os.symlink('../../outside',source+'/relative')
        outside=base/'outside';outside.mkdir();(outside/'sentinel').write_bytes(b'outside')
        sentinel=(os.stat('/').st_mode,os.stat('/').st_uid,hashlib.sha256((outside/'sentinel').read_bytes()).hexdigest())
        os.utime(source,(1234567890,1234567890))
        stage,target=fixture(base,'ok')
        p,r=invoke(source,target,stage)
        assert p.returncode==0,(p.returncode,r,p.stderr)
        assert r['ok'] and r['verified_files']==3,r
        assert any(row.get('phase')=='copying' and row.get('bytes',0)>0 for row in r['_events']),r
        assert any(row.get('phase')=='verifying' for row in r['_events']),r
        actual_progress=[row for row in r['_events'] if row.get('phase')=='copying' and row.get('bytes',0)>0]
        assert os.stat(target).st_mtime_ns==os.stat(source).st_mtime_ns
        assert (os.stat(target).st_uid,stat.S_IMODE(os.stat(target).st_mode))==(99,0o777)
        assert pathlib.Path(target+'/data').read_bytes()==pathlib.Path(source+'/data').read_bytes()
        assert os.stat(target+'/hard').st_ino==os.stat(target+'/data').st_ino
        assert os.getxattr(target+'/data',b'user.regression')==b'xattr\x00value'
        assert os.getxattr(target+'/data',b'system.posix_acl_access')==acl
        assert os.stat(target+'/sparse').st_blocks < os.stat(target+'/sparse').st_size//512
        assert os.readlink(target+'/absolute')=='/outside/sentinel'
        assert sentinel==(os.stat('/').st_mode,os.stat('/').st_uid,hashlib.sha256((outside/'sentinel').read_bytes()).hexdigest())
        p,r=invoke(source,target,stage,'verify');assert p.returncode==0,(r,p.stderr)
        pathlib.Path(target+'/data').write_bytes(b'corrupted')
        p,r=invoke(source,target,stage,'verify');assert p.returncode!=0 and not r['ok'],r
        # An ordinary same-filesystem directory is never an acceptable target.
        stage2=str(base/'not-a-mount');os.mkdir(stage2,0o700);target2=stage2+'/target';os.mkdir(target2)
        p,r=invoke(source,target2,stage2);assert p.returncode!=0 and not r['ok'],r
        # Other preconditions fail closed before any copying.
        stage3,target3=fixture(base,'insecure');os.chmod(stage3,0o777)
        p,r=invoke(source,target3,stage3);assert p.returncode!=0 and not r['ok'],r
        stage4,target4=fixture(base,'nonempty');pathlib.Path(target4+'/existing').write_text('unchanged')
        p,r=invoke(source,target4,stage4);assert p.returncode!=0 and pathlib.Path(target4+'/existing').read_text()=='unchanged',r
        # Real disk full and readonly mounts remain failures without outside mutation.
        stage5,target5=fixture(base,'full','size=1m')
        with open(source+'/large','wb') as f:f.write(os.urandom(2*1024*1024))
        p,r=invoke(source,target5,stage5);assert p.returncode!=0 and not r['ok'],r
        os.unlink(source+'/large')
        stage6,target6=fixture(base,'readonly')
        assert libc.mount(None,os.fsencode(target6),None,32|1,None)==0
        p,r=invoke(source,target6,stage6);assert p.returncode!=0 and not r['ok'],r
        assert sentinel==(os.stat('/').st_mode,os.stat('/').st_uid,hashlib.sha256((outside/'sentinel').read_bytes()).hexdigest())
        assert not list(base.glob('*/.zfsm-copy-jail-*'))
        # No uid99 process can acquire a descendant through the private stage,
        # even after rsync changes the filesystem root to uid99/mode0777.
        attack=subprocess.run(['python3','-c','import os,sys; p=sys.argv[1];\ntry: os.open(p,os.O_RDONLY);sys.exit(3)\nexcept PermissionError: pass',target],preexec_fn=lambda:(os.setgid(99),os.setuid(99)),capture_output=True)
        assert attack.returncode==0,attack.stderr
        # Source pathname/ancestor replacement after pinning never redirects a
        # copier to the outside sentinel. Target path is under trusted staging.
        race_source=str(base/'race-source');os.mkdir(race_source)
        pathlib.Path(race_source+'/data').write_bytes(os.urandom(8*1024*1024))
        expected=hashlib.sha256(pathlib.Path(race_source+'/data').read_bytes()).hexdigest()
        stage7,target7=fixture(base,'race','size=32m')
        req=dict(op='copy',source=ident(race_source),target=ident(target7),staging=ident(stage7))
        proc=subprocess.Popen(['perl',HELPER],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        proc.stdin.write(json.dumps(req));proc.stdin.close();proc.stdin=None
        deadline=time.monotonic()+5
        while not pathlib.Path(stage7+'/.zfsm-copy-jail-'+str(proc.pid)).exists() and proc.poll() is None and time.monotonic()<deadline:time.sleep(.001)
        os.rename(race_source,race_source+'-pinned');os.symlink(str(outside),race_source)
        out,err=proc.communicate(timeout=10);assert proc.returncode==0,(out,err)
        assert hashlib.sha256(pathlib.Path(target7+'/data').read_bytes()).hexdigest()==expected
        assert not pathlib.Path(target7+'/sentinel').exists()
        # A signal during an actual long hash/copy stops the whole private PID
        # namespace and removes the parent's empty jail directory.
        stage8,target8=fixture(base,'interrupt','size=32m')
        slow=str(base/'slow');os.mkdir(slow)
        with open(slow+'/large','wb') as f:f.truncate(512*1024*1024)
        req=dict(op='copy',source=ident(slow),target=ident(target8),staging=ident(stage8))
        proc=subprocess.Popen(['perl',HELPER],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        proc.stdin.write(json.dumps(req));proc.stdin.close();proc.stdin=None
        deadline=time.monotonic()+5
        jail=pathlib.Path(stage8+'/.zfsm-copy-jail-'+str(proc.pid))
        while not jail.exists() and proc.poll() is None and time.monotonic()<deadline:time.sleep(.001)
        time.sleep(.05);proc.send_signal(signal.SIGTERM)
        out,err=proc.communicate(timeout=10);assert proc.returncode!=0,(out,err)
        assert not jail.exists()
        time.sleep(.05)
        survivors=[]
        for cmdline in pathlib.Path('/proc').glob('[0-9]*/cmdline'):
            try:
                value=cmdline.read_bytes()
                if b'/usr/bin/rsync\x00--archive' in value:survivors.append(str(cmdline))
            except (FileNotFoundError,ProcessLookupError):pass
        assert not survivors,survivors
        assert sentinel==(os.stat('/').st_mode,os.stat('/').st_uid,hashlib.sha256((outside/'sentinel').read_bytes()).hexdigest())
        # FIFO and leftover UNIX socket nodes are preserved without opening
        # them; capabilities remain unchanged and device nodes remain forbidden.
        stage9,target9=fixture(base,'special');os.mkfifo(source+'/fifo',0o660)
        leftover=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        leftover.bind(source+'/socket');leftover.close()
        for name in ('fifo','socket'):
            path=source+'/'+name;os.chown(path,99,100);os.chmod(path,0o660)
            os.setxattr(path,b'system.posix_acl_access',acl,follow_symlinks=False)
            os.utime(path,(1234567891,1234567891),follow_symlinks=False)
        # Observe the real kernel capability state after the real capset.
        # No production hook or extra capability is introduced.
        cap_wrapper=base/'cap-wrapper.pl'
        cap_wrapper.write_text(r"""use strict;use warnings;use IO::Handle;
BEGIN {
    *CORE::GLOBAL::syscall=sub {
        my $number=shift;my $result=CORE::syscall($number,@_);
        if(($number==91 || $number==126) && $result==0) {
            my $header=pack('L<L<',0x20080522,0);my $data="\0" x 24;
            my $read=CORE::syscall($number==91?90:125,$header,$data);
            my $effective=unpack('L<',$data);
            my $bound=CORE::syscall($number==91?167:157,23,27,0,0,0);
            die 'CAP_MKNOD escaped jail drop' if $read!=0 || ($effective & (1<<27)) || $bound!=0;
            print STDERR "JAIL_CAP_MKNOD_EFFECTIVE=0 BOUNDING=0\n";STDERR->flush();
        }
        return $result;
    };
}
do '/stand/src/scripts/zfsm-copy-confined.pl';die($@ || $!);
""")
        p,r=invoke(source,target9,stage9,helper=cap_wrapper);assert p.returncode==0,(r,p.stderr)
        assert p.stderr=='JAIL_CAP_MKNOD_EFFECTIVE=0 BOUNDING=0\n',p.stderr
        for name,kind in (('fifo',stat.S_ISFIFO),('socket',stat.S_ISSOCK)):
            a=os.lstat(source+'/'+name);b=os.lstat(target9+'/'+name)
            assert kind(b.st_mode) and (b.st_mode,b.st_uid,b.st_gid,b.st_mtime_ns,b.st_rdev)==(a.st_mode,a.st_uid,a.st_gid,a.st_mtime_ns,a.st_rdev)
            assert os.getxattr(target9+'/'+name,b'system.posix_acl_access',follow_symlinks=False)==acl
        p,r=invoke(source,target9,stage9,'verify');assert p.returncode==0,(r,p.stderr)
        os.chmod(target9+'/fifo',0o600)
        p,r=invoke(source,target9,stage9,'verify');assert p.returncode!=0 and not r['ok'],r
        os.unlink(source+'/fifo');os.unlink(source+'/socket')
        # Test-container-only CAP_MKNOD creates inert fixture nodes. The jailed
        # helper still drops it; preflight must reject before any target writes.
        for name,kind,device in (('character',stat.S_IFCHR,os.makedev(1,3)),('block',stat.S_IFBLK,os.makedev(7,0))):
            stage_device,target_device=fixture(base,name)
            os.mknod(source+'/'+name,kind|0o600,device)
            p,r=invoke(source,target_device,stage_device)
            assert p.returncode!=0 and 'Device source files' in r['error'],r
            assert not list(pathlib.Path(target_device).iterdir())
            assert os.lstat(source+'/'+name).st_rdev==device
            os.unlink(source+'/'+name)
            assert libc.umount2(os.fsencode(target_device),2)==0
        # Unicode source path JSON escapes are accepted without lossy decoding.
        unicode_source=str(base/'папка');os.mkdir(unicode_source);pathlib.Path(unicode_source+'/данные').write_bytes(b'unicode')
        stage10,target10=fixture(base,'unicode')
        p,r=invoke(unicode_source,target10,stage10);assert p.returncode==0,(r,p.stderr)
        assert pathlib.Path(target10+'/данные').read_bytes()==b'unicode'
        # A nonrecursive bind must never silently substitute the covered
        # directory for a real nested source mount.
        stage11,target11=fixture(base,'nested')
        nested=source+'/nested';os.mkdir(nested);mount(nested)
        pathlib.Path(nested+'/mounted-file').write_bytes(b'mounted')
        p,r=invoke(source,target11,stage11)
        assert p.returncode!=0 and 'Nested mounts' in r['error'],r
        assert libc.umount2(os.fsencode(nested),2)==0
        stage12,target12=fixture(base,'alias')
        alias=str(base/'alias-mount');os.mkdir(alias)
        assert libc.mount(os.fsencode(target12),os.fsencode(alias),None,4096,None)==0
        p,r=invoke(source,target12,stage12)
        assert p.returncode!=0 and 'another mounted alias' in r['error'],r
        assert libc.umount2(os.fsencode(alias),2)==0
        # Missing mandatory kernel privilege is a hard failure before target
        # content or metadata processing; no fallback copier may run.
        stage13,target13=fixture(base,'nocap')
        req=dict(op='copy',source=ident(source),target=ident(target13),staging=ident(stage13))
        p=subprocess.run(['perl',HELPER],input=json.dumps(req),text=True,capture_output=True,preexec_fn=lambda:libc.prctl(24,21,0,0,0))
        assert p.returncode!=0 and not json.loads(p.stdout.splitlines()[-1])['ok'],(p.stdout,p.stderr)
        assert not list(pathlib.Path(target13).iterdir())
        assert not list(base.glob('*/.zfsm-copy-jail-*'))
        # Deterministically stop private namespace PID1 immediately BEFORE
        # PDEATHSIG registration, kill its supervisor, then allow registration.
        # Only the test wrapper intercepts syscall; production has no test hook.
        stage14,target14=fixture(base,'parent-death-race')
        death_source=str(base/'parent-death-source');os.mkdir(death_source)
        pause=pathlib.Path(death_source+'/pause');pause.write_text('wait')
        pathlib.Path(death_source+'/must-not-copy').write_bytes(b'no orphan copier')
        wrapper=base/'pdeath-wrapper.pl'
        wrapper.write_text(r"""use strict;use warnings;use IO::Handle;
BEGIN {
    *CORE::GLOBAL::syscall=sub {
        if(($_[0]==167 || $_[0]==157) && $_[1]==1 && $_[2]==9 && $$==1) {
            print STDERR "INIT_BEFORE_PDEATHSIG\n";STDERR->flush();
            while(1) {
                open(my $pause,'<','/source/pause') or die "pause unavailable";
                my $state=<$pause>;close($pause);last if $state eq 'go';
                select(undef,undef,undef,.001);
            }
        }
        my $number=shift;return CORE::syscall($number,@_);
    };
}
do '/stand/src/scripts/zfsm-copy-confined.pl';die($@ || $!);
""")
        req=dict(op='copy',source=ident(death_source),target=ident(target14),staging=ident(stage14))
        proc=subprocess.Popen(['perl',str(wrapper)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        proc.stdin.write(json.dumps(req));proc.stdin.close();proc.stdin=None
        assert select.select([proc.stderr],[],[],10)[0],'PID1 wrapper did not pause'
        marker=proc.stderr.readline();assert marker=='INIT_BEFORE_PDEATHSIG\n',(marker,proc.stdout.read() if marker=='' else '')
        children=pathlib.Path(f'/proc/{proc.pid}/task/{proc.pid}/children').read_text().split()
        assert len(children)==1,children
        supervisor=int(children[0])
        children=pathlib.Path(f'/proc/{supervisor}/task/{supervisor}/children').read_text().split()
        assert len(children)==1,children
        init=int(children[0]);os.kill(init,signal.SIGSTOP)
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            state=pathlib.Path(f'/proc/{init}/status').read_text()
            if '\nState:\tT' in state:break
            time.sleep(.001)
        else:raise AssertionError('Private PID1 did not stop')
        os.kill(supervisor,signal.SIGKILL)
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            status=pathlib.Path(f'/proc/{supervisor}/status')
            if not status.exists() or '\nState:\tZ' in status.read_text():break
            time.sleep(.001)
        else:raise AssertionError('Supervisor was not killed')
        pause.write_text('go');os.kill(init,signal.SIGCONT)
        out,err=proc.communicate(timeout=10)
        deadline=time.monotonic()+5
        while pathlib.Path(f'/proc/{init}').exists() and time.monotonic()<deadline:
            if '\nState:\tZ' in pathlib.Path(f'/proc/{init}/status').read_text():break
            time.sleep(.001)
        assert not list(pathlib.Path(target14).iterdir()),('Orphan namespace PID1 copied after supervisor death',out,err)
        assert proc.returncode!=0,(out,err)
        assert not pathlib.Path(stage14+'/.zfsm-copy-jail-'+str(proc.pid)).exists()
        # Unmount before TemporaryDirectory cleanup.
        for stage_name in ['ok','insecure','nonempty','full','readonly','race','interrupt','special','unicode','nested','alias','nocap','parent-death-race']:
            assert libc.umount2(os.fsencode(str(base/stage_name/'target')),2)==0
    print(json.dumps({'ok':True,'suite':'conversion-copy','rsync':'3.5.1','actual_progress':actual_progress,'deterministic_pre_pdeathsig_race':{'supervisor_sigkill':True,'namespace_init_sigstop_resume':True,'target_files':0},'special_nodes':{'fifo':True,'unix_socket':True,'character_rejected':True,'block_rejected':True,'cap_mknod_effective':False,'cap_mknod_bounding':False},'checks':['uid99-mode0777','root-mtime','sha256','acl','xattrs','hardlinks','sparse','symlinks','unicode','source-path-replacement','private-staging','sigterm-descendant-cleanup','fifo-socket-metadata-preservation','cap-mknod-effective-bounding-dropped','fifo-corrupt-verify-rejection','device-node-rejection','nested-mount-rejection','target-alias-rejection','missing-kernel-capability','readonly','enospc','corrupt-verify-rejection']}))

run()
