#!/usr/bin/env python3
"""Real Linux filesystem tests. No ZFS executables, no host mounts or data."""
import ctypes, errno, hashlib, json, os, pathlib, platform, select, shutil, signal, subprocess, tempfile, time, zipfile
ROOT=pathlib.Path('/stand/src'); HELPER=ROOT/'scripts/zfsm-files.pl'
RESULTS=[]; SUBCHECKS={}
def test(name, fn):
    try:
        fn(); RESULTS.append({'name':name,'status':'PASS'}); print('PASS '+name,flush=True)
    except Exception as e:
        RESULTS.append({'name':name,'status':'FAIL','error':str(e)});print('FAIL '+name+': '+str(e),flush=True)
def identity(p):
    s=os.stat(p);return {'dev':str(s.st_dev),'ino':str(s.st_ino)}
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def run(args,ok=True,env=None):
    p=subprocess.run(['perl',str(HELPER)],input=json.dumps(args).encode(),capture_output=True,env=env,timeout=30)
    if ok: assert p.returncode==0,p.stderr.decode()+p.stdout.decode(errors='replace')
    else: assert p.returncode!=0,'unsafe request succeeded'
    rows=[json.loads(x) for x in p.stdout.splitlines()] if p.returncode==0 else []
    return rows,p
counter=0
def fixture(base=None):
    global counter
    counter+=1
    d=pathlib.Path(tempfile.mkdtemp(prefix='zfsm-test-',dir=base or '/test'));s=d/'snapshot';t=d/'dataset';s.mkdir();t.mkdir()
    (s/'folder').mkdir();(s/'folder'/'Привет мир.txt').write_bytes(b'from-snapshot\x00\xff\n'*1000);(s/'notes.txt').write_text('snapshot notes\n');(s/'empty').mkdir()
    (s/'notes.txt').chmod(0o640);os.chown(s/'notes.txt',99,100)
    return d,s,t,{'source':str(s),'source_identity':identity(s),'destination':str(t),'destination_identity':identity(t),'id':f'20261016-120000-{counter:012x}','archive_token':'a'*64}
def finish():
    failures=[r for r in RESULTS if r['status']=='FAIL'];versions={name:subprocess.check_output(command,text=True).splitlines()[0] for name,command in {'php':['php','-r','echo PHP_VERSION;'],'perl':['perl','-e','print $^V;'],'rsync':['rsync','--version']}.items()};print(json.dumps({'platform':platform.platform(),'machine':platform.machine(),'versions':versions,'helper_sha256':sha(HELPER),'subchecks':SUBCHECKS,'results':RESULTS,'failed':len(failures)}));raise SystemExit(bool(failures))
def native_open():
    d,s,t,a=fixture();r,_=run(a|{'op':'list','path':'','sort':'name','direction':'asc','offset':0,'hidden':False});assert {x['name'] for x in r[0]['entries']}=={'folder','notes.txt','empty'}
    for path in ['../outside','folder/../../outside','/etc/passwd','folder//file','folder/.zfs/secret']:
        run(a|{'op':'list','path':path},False)
    (s/'link').symlink_to('/etc');r,_=run(a|{'op':'list','path':''});assert next(x for x in r[0]['entries'] if x['name']=='link')['available'] is False
    run(a|{'op':'list','path':'link'},False)
def archive():
    d,s,t,a=fixture();rows,_=run(a|{'op':'archive','selection':['folder','notes.txt','empty']});last=rows[-1];assert last['phase']=='completed'
    path=t/('.zfsm-archive-'+a['id'])/'archive.zip'
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None;assert z.read('notes.txt')==(s/'notes.txt').read_bytes();assert hashlib.sha256(z.read('folder/Привет мир.txt')).hexdigest()==sha(s/'folder'/'Привет мир.txt');assert 'empty/' in z.namelist()
    p=subprocess.run(['perl',str(HELPER)],input=json.dumps(a|{'op':'archive-download','archive_identity':last['archive_identity']}).encode(),capture_output=True,timeout=20);head,data=p.stdout.split(b'\n',1);assert json.loads(head)['size']==len(data);assert hashlib.sha256(data).hexdigest()==sha(path)
    run(a|{'op':'archive-cleanup','archive_token':'b'*64},False);assert path.exists()
    run(a|{'op':'archive-cleanup'});assert not path.parent.exists();run(a|{'op':'archive-cleanup'})
def new_restore():
    d,s,t,a=fixture();p=run(a|{'op':'plan','selection':['folder','notes.txt','empty'],'mode':'new','target':'restored'})[0][0]
    r,_=run(a|{'op':'restore','plan':p});assert r[-1]['phase']=='completed'
    assert sha(t/'restored'/'notes.txt')==sha(s/'notes.txt');assert sha(t/'restored'/'folder'/'Привет мир.txt')==sha(s/'folder'/'Привет мир.txt');st=(t/'restored'/'notes.txt').stat();assert (st.st_uid,st.st_gid,st.st_mode&0o777)==(99,100,0o640)
    assert not (t/('.zfsm-restore-'+a['id'])).exists()
def overwrite():
    d,s,t,a=fixture();dest=t/'live';dest.mkdir();(dest/'notes.txt').write_text('ORIGINAL');(dest/'unrelated').write_text('KEEP');before=sha(dest/'notes.txt')
    p=run(a|{'op':'plan','selection':['folder','notes.txt'],'mode':'overwrite','target':'live'})[0][0];r,_=run(a|{'op':'restore','plan':p});assert r[-1]['phase']=='completed';assert sha(dest/'notes.txt')==sha(s/'notes.txt');assert (dest/'unrelated').read_text()=='KEEP';assert sha(t/('.zfsm-restore-'+a['id'])/'replaced'/'notes.txt')==before
    run(a|{'op':'restore','plan':p},False)
def conflict_change():
    d,s,t,a=fixture();dest=t/'live';dest.mkdir();(dest/'notes.txt').write_text('ORIGINAL')
    p=run(a|{'op':'plan','selection':['notes.txt'],'mode':'overwrite','target':'live'})[0][0];(dest/'notes.txt').write_text('CONCURRENT');run(a|{'op':'restore','plan':p},False);assert (dest/'notes.txt').read_text()=='CONCURRENT'
    (dest/'notes.txt').unlink();(dest/'notes.txt').symlink_to('/etc/passwd');run(a|{'op':'plan','selection':['notes.txt'],'mode':'overwrite','target':'live'},False)
def root_replaced():
    d,s,t,a=fixture();t.rename(d/'retained');t.mkdir();run(a|{'op':'archive','selection':['notes.txt']},False);assert not list(t.iterdir())
def unsupported_syscall():
    # Child-only seccomp denies openat2. The helper must fail, never fall back.
    code="""import ctypes,os,sys
class F(ctypes.Structure): _fields_=[('code',ctypes.c_ushort),('jt',ctypes.c_ubyte),('jf',ctypes.c_ubyte),('k',ctypes.c_uint)]
class P(ctypes.Structure): _fields_=[('len',ctypes.c_ushort),('filter',ctypes.POINTER(F))]
f=(F*4)(F(0x20,0,0,0),F(0x15,0,1,437),F(0x06,0,0,0x50000|38),F(0x06,0,0,0x7fff0000));p=P(4,f);c=ctypes.CDLL(None,use_errno=True)
assert c.prctl(38,1,0,0,0)==0;assert c.prctl(22,2,ctypes.byref(p))==0
os.execv('/usr/bin/perl',['perl',sys.argv[1]])"""
    d,s,t,a=fixture();p=subprocess.run(['python3','-c',code,str(HELPER)],input=json.dumps(a|{'op':'list','path':''}).encode(),capture_output=True,timeout=20);assert p.returncode!=0,p.stdout;assert b'Path is unavailable' in p.stderr,p.stderr

def mutable_parent_semantics():
    # fd-relative rename pins an ancestor; it cannot compare final-entry inode.
    d,s,t,a=fixture();parent=t/'public';parent.mkdir();parent.chmod(0o777);os.chown(parent,99,100);selected=parent/'selected';selected.mkdir();(selected/'marker').write_text('REVIEWED');review=identity(selected)
    fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY);selected.rename(parent/'retained-original');selected.mkdir();(selected/'marker').write_text('REPLACEMENT')
    os.rename('selected','moved',src_dir_fd=fd,dst_dir_fd=fd);os.close(fd)
    assert identity(parent/'moved')!=review;assert (parent/'moved'/'marker').read_text()=='REPLACEMENT';assert (parent/'retained-original'/'marker').read_text()=='REVIEWED'
    # Real guard must refuse both world-writable and non-root parents.
    script=ROOT/'include/ZFSMDirectory.php';code=f"require {json.dumps(str(script))}; echo json_encode(zfsmDirectoryParentsTrusted({json.dumps(str(parent/'moved'))}));"
    p=subprocess.run(['php','-r',code],capture_output=True);assert p.stdout==b'false',p.stderr
    parent.chmod(0o755);p=subprocess.run(['php','-r',code],capture_output=True);assert p.stdout==b'false',p.stderr
    os.chown(parent,0,0);os.chown(parent/'moved',99,100);(parent/'moved').chmod(0o777);p=subprocess.run(['php','-r',code],capture_output=True);assert p.stdout==b'true',p.stderr
    parent.chmod(0o777);p=subprocess.run(['php','-r',code],capture_output=True);assert p.stdout==b'false',p.stderr

def wrapper(a,phase='publishing',current=False,replace=None):
    # Deterministic test-only pause at a real progress boundary, never product code.
    code="require $ARGV[0]; my $emit=\\&emit; no warnings 'redefine'; *emit=sub { $emit->(@_); if ($_[0]->{phase} eq '"+phase+"'"+(" && $_[0]->{current}" if current else "")+") { kill 'STOP',$$; } }; @ARGV=(); main();"
    p=subprocess.Popen(['perl','-e',code,str(HELPER)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,bufsize=0)
    p.stdin.write(json.dumps(a).encode());p.stdin.close()
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        if not select.select([p.stdout],[],[],max(.01,deadline-time.monotonic()))[0]:break
        line=p.stdout.readline()
        if not line:break
        row=json.loads(line)
        if row.get('phase')==phase and (not current or row.get('current')):
            # Progress is flushed just before SIGSTOP. Wait for the kernel stop
            # event so the parent's SIGCONT cannot arrive before the pause.
            while time.monotonic()<deadline:
                pid,status=os.waitpid(p.pid,os.WUNTRACED|os.WNOHANG)
                if pid and os.WIFSTOPPED(status):return p,row
                if pid:raise AssertionError('helper exited before the requested pause')
                time.sleep(.001)
            break
    os.killpg(p.pid,signal.SIGKILL);p.wait();raise AssertionError('pause boundary unavailable: '+p.stderr.read().decode())

def interrupted_restore():
    d,s,t,a=fixture();dest=t/'live';dest.mkdir();(dest/'notes.txt').write_text('ORIGINAL notes');(dest/'z-last.txt').write_text('ORIGINAL last');(s/'z-last.txt').write_text('NEW last')
    plan=run(a|{'op':'plan','selection':['notes.txt','z-last.txt'],'mode':'overwrite','target':'live'})[0][0]
    p,event=wrapper(a|{'op':'restore','plan':plan},current=True)
    os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
    retained=t/('.zfsm-restore-'+a['id']);assert (retained/'replaced'/'notes.txt').read_text()=='ORIGINAL notes';assert sha(dest/'notes.txt')==sha(s/'notes.txt');assert (dest/'z-last.txt').read_text()=='ORIGINAL last';assert sha(retained/'data'/'z-last.txt')==sha(s/'z-last.txt')
    run(a|{'op':'restore','plan':plan},False);assert (dest/'z-last.txt').read_text()=='ORIGINAL last'

def path_swap_after_copy():
    d,s,t,a=fixture();dest=t/'live';dest.mkdir();(dest/'notes.txt').write_text('ORIGINAL')
    plan=run(a|{'op':'plan','selection':['notes.txt'],'mode':'overwrite','target':'live'})[0][0]
    p,event=wrapper(a|{'op':'restore','plan':plan})
    dest.rename(t/'original-live');dest.symlink_to('/etc');os.kill(p.pid,signal.SIGCONT);p.wait(timeout=10)
    assert p.returncode!=0;assert (t/'original-live'/'notes.txt').read_text()=='ORIGINAL';assert (t/('.zfsm-restore-'+a['id'])/'data'/'notes.txt').exists()

def no_space():
    d,s,t,a=fixture('/limited');(s/'large.bin').write_bytes(os.urandom(1500000))
    # Consume remaining tmpfs blocks after source setup; real ENOSPC on copy.
    with (d/'filler').open('wb') as f:
        try:
            while True:f.write(b'x'*65536);f.flush()
        except OSError as e:assert e.errno==errno.ENOSPC
    plan=run(a|{'op':'plan','selection':['large.bin'],'mode':'new','target':'restored'})[0][0]
    _,p=run(a|{'op':'restore','plan':plan},False);assert not (t/'restored').exists();assert sha(s/'large.bin')==hashlib.sha256((s/'large.bin').read_bytes()).hexdigest();shutil.rmtree(d)

def read_only_write():
    d,s,t,a=fixture();ro=pathlib.Path('/readonly');a|={'destination':str(ro),'destination_identity':identity(ro)}
    _,p=run(a|{'op':'archive','selection':['notes.txt']},False);assert b'Unable to create destination folder' in p.stderr,p.stderr

def nonroot_restore():
    d,s,t,a=fixture();t.chmod(0o777);os.chown(t,99,100)
    plan=run(a|{'op':'plan','selection':['notes.txt'],'mode':'new','target':'restored'})[0][0];run(a|{'op':'restore','plan':plan});assert sha(t/'restored'/'notes.txt')==sha(s/'notes.txt');assert (t.stat().st_uid,t.stat().st_mode&0o777)==(99,0o777)

def mount_boundary():
    d,s,t,a=fixture();nested=s/'nested';nested.mkdir()
    m=subprocess.run(['mount','-t','tmpfs','-o','size=1m','tmpfs',str(nested)],capture_output=True);assert m.returncode==0,m.stderr
    try:
        (nested/'secret').write_text('different mount')
        run(a|{'op':'list','path':'nested'},False);run(a|{'op':'archive','selection':['nested']},False)
    finally:subprocess.run(['umount',str(nested)],check=True)

def process_cases():
    SUBCHECKS['process']=[]
    for scenario in ['request-job-lease','operation-lock','duplex','broken-input','explorer-broken-input','explorer-duplex','explorer-encoding','explorer-output-limit','explorer-download','explorer-call-overflow']:
        p=subprocess.run(['php','/stand/tests/native-linux/process-cases.php',scenario],capture_output=True,timeout=10)
        assert p.returncode==0,scenario+': '+p.stdout.decode()+p.stderr.decode();SUBCHECKS['process'].append({'name':scenario,'status':'PASS'})

def journal_contention():
    # PHP journal implementation, kernel flock, simultaneous real processes.
    d=pathlib.Path(tempfile.mkdtemp(dir='/test'));runner=d/'counter.php'
    runner.write_text("<?php require '/stand/src/include/ZFSMAudit.php'; require '/stand/src/include/ZFSMJobs.php'; $GLOBALS['plugin_state']=$argv[1]; $id='20261016-120000-aaaaaaaaaaaa'; for($i=0;$i<20;$i++)zfsmJobUpdate($id,fn($j)=>['counter'=>$j['counter']+1]);")
    jobs=d/'jobs';jobs.mkdir(mode=0o700);job=jobs/'20261016-120000-aaaaaaaaaaaa.json';job.write_text(json.dumps({'id':job.stem,'schema':1,'state':'queued','counter':0}))
    children=[subprocess.Popen(['php',str(runner),str(jobs)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)for _ in range(4)]
    for p in children:
        out,err=p.communicate(timeout=15);assert p.returncode==0,err
    assert json.loads(job.read_text())['counter']==80;assert not list(jobs.glob('*.tmp*'))

def archive_enospc():
    d,s,t,a=fixture('/limited');(s/'random.bin').write_bytes(os.urandom(1000000))
    with (d/'filler').open('wb') as f:
        free=os.statvfs(d).f_bavail*os.statvfs(d).f_frsize
        f.write(b'x'*max(0,free-65536))
    _,p=run(a|{'op':'archive','selection':['random.bin']},False)
    staging=t/('.zfsm-archive-'+a['id']);assert not (staging/'archive.zip').exists();assert (s/'random.bin').stat().st_size==1000000
    run(a|{'op':'archive-cleanup'});assert not staging.exists();shutil.rmtree(d)

def concurrent_restore():
    d,s,t,a=fixture();plan=run(a|{'op':'plan','selection':['notes.txt'],'mode':'new','target':'same'})[0][0]
    procs=[]
    for i in range(2):
        request=a|{'op':'restore','plan':plan,'id':f'20261016-130000-{i:012x}'}
        p=subprocess.Popen(['perl',str(HELPER)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE);p.stdin.write(json.dumps(request).encode());p.stdin.close();procs.append(p)
    for p in procs:p.wait(timeout=15)
    assert sum(p.returncode==0 for p in procs)==1;assert sha(t/'same'/'notes.txt')==sha(s/'notes.txt')

def worker_cases():
    p=subprocess.run(['python3','/stand/tests/native-linux/worker-cases.py'],capture_output=True,timeout=40)
    assert p.returncode==0,p.stdout.decode()+p.stderr.decode()
    result=json.loads(p.stdout.decode().strip().splitlines()[-1]);assert result['failed']==0,result
    SUBCHECKS['worker']=result['results']

def protection_lock():
    p=subprocess.run(['php','/stand/tests/native-linux/protection-lock.php'],capture_output=True,timeout=15)
    assert p.returncode==0,p.stdout.decode()+p.stderr.decode()
    result=json.loads(p.stdout);assert result['status']=='PASS',result
    SUBCHECKS['protection-lock']=result

def audit_cases():
    p=subprocess.run(['php','/stand/tests/rc-audit-pagination.php'],capture_output=True,timeout=20)
    assert p.returncode==0,p.stdout.decode()+p.stderr.decode()
    SUBCHECKS['audit']=[{'name':line[5:],'status':'PASS'} for line in p.stdout.decode().splitlines() if line.startswith('PASS ')]
    assert len(SUBCHECKS['audit'])==6,p.stdout

def main():
    os.chmod('/test',0o755)  # Private synthetic ancestor; never a host path.
    assert not shutil.which('zfs') and not shutil.which('zpool'),'ZFS must not be installed'
    test('Perl openat2 real files, symlinks and traversal refusal',native_open)
    test('real ZIP contents SHA-256 streaming ownership token and cleanup',archive)
    test('real new restore SHA-256 Unicode permissions ownership and cleanup',new_restore)
    test('overwrite keeps originals and unrelated files; no implicit retry',overwrite)
    test('changed conflicts and destination symlinks fail before publication',conflict_change)
    test('replaced filesystem root is rejected by inode identity',root_replaced)
    test('openat2 ENOSYS refuses without fallback',unsupported_syscall)
    test('0777 non-root directory race proves basename limitation and safe refusal',mutable_parent_semantics)
    test('interrupted overwrite retains original and copied versions; retry refused',interrupted_restore)
    test('symlink replacement after copy cannot redirect publication',path_swap_after_copy)
    test('real ENOSPC cannot publish incomplete restoration',no_space)
    test('read-only destination write failure does not create ZIP',read_only_write)
    test('restore under 0777 non-root dataset root preserves owner and mode',nonroot_restore)
    test('nested tmpfs mount cannot be browsed or archived',mount_boundary)
    test('kernel flock serializes 80 concurrent PHP journal updates',journal_contention)
    test('real ZIP ENOSPC keeps partial cache inspectable and cleanup owned',archive_enospc)
    test('concurrent restore publication never overwrites another job',concurrent_restore)
    test('native audit cursor pagination bounds identity redaction and retained history',audit_cases)
    test('native worker kill restart stop and recovery integration',worker_cases)
    test('protection worker defers config lock contention without losing its queued occurrence',protection_lock)
    test('native process input failures and duplex pipe backpressure',process_cases)
    finish()
if __name__=='__main__':main()
