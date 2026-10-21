#!/usr/bin/env python3
"""Actual PHP orchestration + native workers; only ZFS CLI uses a tmpfs model."""
import ctypes, hashlib, json, os, pathlib, shutil, socket, subprocess, sys, tempfile, threading
assert pathlib.Path('/.dockerenv').exists(), 'Disposable container required'
ROOT=pathlib.Path('/stand');PHP=ROOT/'tests/native-linux/conversion-workflow.php'
libc=ctypes.CDLL(None,use_errno=True)
RESULTS=[]

def execute(base,action,allow_crash=False,deny_openat2=False):
    command=['php',str(PHP),str(base),action]
    if deny_openat2:
        seccomp='''import ctypes,os,sys
class F(ctypes.Structure):_fields_=[('code',ctypes.c_ushort),('jt',ctypes.c_ubyte),('jf',ctypes.c_ubyte),('k',ctypes.c_uint)]
class P(ctypes.Structure):_fields_=[('len',ctypes.c_ushort),('filter',ctypes.POINTER(F))]
f=(F*4)(F(0x20,0,0,0),F(0x15,0,1,437),F(0x06,0,0,0x50000|38),F(0x06,0,0,0x7fff0000));p=P(4,f);c=ctypes.CDLL(None,use_errno=True)
assert c.prctl(38,1,0,0,0)==0;assert c.prctl(22,2,ctypes.byref(p))==0
os.execvp(sys.argv[1],sys.argv[1:])'''
        command=['python3','-c',seccomp]+command
    p=subprocess.run(command,capture_output=True,text=True,timeout=30)
    if allow_crash and p.returncode==77:return p,None
    try:r=json.loads(p.stdout.strip() if p.returncode==0 else p.stderr.strip().splitlines()[-1])
    except Exception:raise AssertionError((p.returncode,p.stdout,p.stderr))
    return p,r

def read_state(base):return json.loads((base/'zfs.json').read_text())
def save_state(base,state):(base/'zfs.json').write_text(json.dumps(state))
def digest(path):return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
def identity(path):
    s=os.stat(path);return {'dev':str(s.st_dev),'ino':str(s.st_ino)}

class Keeper:
    """Keep a detached tmpfs mount FD to model ZFS persistence after unmount.

    This test-only storage fixture runs outside the production workers. The
    clone is never attached, visible to rsync, or present in mountinfo.
    """
    def __init__(self,base):
        self.base=base;self.fds=[];self.stop=False
        self.sock=socket.socket(socket.AF_UNIX);self.sock.bind(str(base/'keeper.sock'));self.sock.listen();self.sock.settimeout(.1)
        self.thread=threading.Thread(target=self.serve,daemon=True);self.thread.start()
    def serve(self):
        while not self.stop:
            try:conn,_=self.sock.accept()
            except socket.timeout:continue
            with conn:
                try:
                    line=conn.makefile('rb').readline();target=json.loads(line)['target']
                    assert target.startswith(str(self.base/'conversions')+'/') and target.endswith('/target')
                    fd=libc.syscall(428,-100,os.fsencode(target),1|0x80000)
                    assert fd>=0,ctypes.get_errno();self.fds.append(fd)
                    conn.sendall(b'{"ok":true}\n')
                except Exception as e:conn.sendall(json.dumps({'ok':False,'error':str(e)}).encode()+b'\n')
    def retained_copy(self):
        return any(pathlib.Path('/proc/self/fd/'+str(fd)+'/payload').is_file() for fd in self.fds)
    def close(self):
        self.stop=True;self.thread.join(timeout=2);self.sock.close()
        for fd in self.fds:os.close(fd)

def fixture(name,fault='',crash_stage=None):
    base=pathlib.Path(tempfile.mkdtemp(prefix=name+'-',dir='/test/private'));base.chmod(0o700)
    shutil.copytree(ROOT/'src',base/'code/src')
    seams=[('include/ZFSMHelpers.php','runProcess','workflowRealProcess'),('include/ZFSMDirectory.php','zfsmMountInfo','workflowRealMountInfo'),('include/ZFSMJobs.php','zfsmJobAtomicWrite','workflowRealAtomicWrite'),('include/ZFSMJobProcess.php','zfsmStreamProcess','workflowRealStreamProcess')]
    for rel,original,replacement in seams:
        p=base/'code/src'/rel;s=p.read_text();needle='function '+original+'(';assert s.count(needle)==1;s=s.replace(needle,'function '+replacement+'(');p.write_text(s)
    for p in (ROOT/'src/scripts').iterdir():
        if p.is_file():assert p.read_bytes()==(base/'code/src/scripts'/p.name).read_bytes()
    owner=base/'owner';owner.mkdir()
    assert libc.mount(b'tmpfs',os.fsencode(owner),b'tmpfs',0,b'size=64m')==0,ctypes.get_errno()
    os.chown(owner,99,100);owner.chmod(0o777)
    source=owner/'SampleProject';source.mkdir();os.chown(source,99,100);source.chmod(0o777)
    (source/'payload').write_bytes(b'original contents\x00'*4096);os.chown(source/'payload',99,100)
    (source/'nested').mkdir();(source/'nested/file').write_text('nested content')
    if fault=='copy':
        with (source/'large').open('wb') as f:
            chunk=os.urandom(1024*1024)
            for _ in range(40):f.write(chunk)
        (base/'large.sha256').write_text(digest(source/'large'))
    device=next(x.split()[2] for x in pathlib.Path('/proc/self/mountinfo').read_text().splitlines() if x.split()[4]==str(owner))
    state={'fault':fault,'crash_stage':crash_stage,'datasets':{'tank/owner':{'guid':'101','mountpoint':str(owner),'device':device,'canmount':'on','readonly':'off','zfs.master.ui:conversion-job':'-'}},'commands':[],'native':[]}
    save_state(base,state)
    return base,source,Keeper(base)

def cleanup(base,keeper):
    keeper.close()
    rows=[x.split()[4] for x in pathlib.Path('/proc/self/mountinfo').read_text().splitlines() if x.split()[4].startswith(str(base)+'/')]
    for path in sorted(rows,key=len,reverse=True):assert libc.umount2(os.fsencode(path),2)==0,(path,ctypes.get_errno())
    shutil.rmtree(base)

def queue(base):
    p,r=execute(base,'queue');assert p.returncode==0,r
    job=r['job'];(base/'job-id.json').write_text(json.dumps(job['id']));return job

def mutations(base):return [x for x in read_state(base)['commands'] if x[0] in ['create','mount','unmount','set','destroy']]
def original_retained(job,sha):
    good=[]
    for path in [job['source'],job['recovery']]:
        p=pathlib.Path(path)
        if p.is_dir() and identity(p)==job['source_identity'] and (p/'payload').is_file() and digest(p/'payload')==sha:good.append(path)
    assert good,('original inode/content not retained',job)

def success():
    base,source,keeper=fixture('success')
    try:
        original=digest(source/'payload');job=queue(base)
        p,r=execute(base,'run');assert p.returncode==0,r
        job=r['job'];assert job['state']=='completed',job
        assert digest(source/'payload')==original and digest(pathlib.Path(job['recovery'])/'payload')==original
        assert identity(pathlib.Path(job['recovery']))==job['source_identity']
        assert (os.stat(source).st_uid,os.stat(source).st_mode&0o7777)==(99,0o777)
        state=read_state(base);assert state['datasets'][job['dataset']]['canmount']=='on'
        assert not any(x[0]=='destroy' for x in state['commands'])
        assert not any(x['command'].endswith('rsync') for x in state['native'])
        # Final property transition is strictly after actual mounted publication.
        assert state['commands'][-1]!=['mount',job['dataset']]
    finally:cleanup(base,keeper)

def fault_case(fault):
    base,source,keeper=fixture('failure-'+fault,fault)
    try:
        original=digest(source/'payload');job=queue(base)
        p,r=execute(base,'run');assert p.returncode==0,r
        job=r['job'];assert job['state']=='recovery_required',job
        if fault=='concurrent-write':original=hashlib.sha256((b'original contents\x00'*4096)+b'concurrent writer').hexdigest()
        original_retained(job,original)
        state=read_state(base);assert not any(x[0]=='destroy' for x in state['commands'])
        if fault=='copy':
            assert job['stage']=='copying',job
            assert 'No space left on device' in (base/'native-stream.log').read_text(),job
            retained=pathlib.Path(job['recovery']) if pathlib.Path(job['recovery']).exists() else source
            assert digest(retained/'large')==(base/'large.sha256').read_text()
        if fault=='publish':
            assert (source/'replacement').read_bytes()==b'untouched' and keeper.retained_copy()
            assert state['datasets'][job['dataset']]['canmount']=='noauto'
        before=mutations(base);p,r=execute(base,'run');assert p.returncode==0,r;assert mutations(base)==before
        p,r=execute(base,'resume');assert p.returncode!=0,('unsafe automatic retry accepted',fault,r)
        assert mutations(base)==before
    finally:cleanup(base,keeper)

def crash_case(stage):
    base,source,keeper=fixture('crash-'+stage,crash_stage=stage)
    try:
        original=digest(source/'payload');job=queue(base)
        p,r=execute(base,'run',allow_crash=True);assert p.returncode==77,('requested crash boundary not reached',stage,r)
        job=json.loads((base/'state'/ (job['id']+'.json')).read_text());assert job['stage']==stage
        original_retained(job,original);before=mutations(base)
        p,r=execute(base,'run');assert p.returncode==0,r;assert r['job']['state']=='recovery_required';assert mutations(base)==before
        p,r=execute(base,'resume')
        if stage in ['planned','published']:
            assert p.returncode==0,r
            p,r=execute(base,'run');assert p.returncode==0 and r['job']['state']=='completed',r
            later=mutations(base)[len(before):]
            if stage=='published':assert all(x==['set','-u','canmount=on',job['dataset']] for x in later),later
            else:assert sum(x[0]=='create' for x in later)==1,later
        else:assert p.returncode!=0,('intermediate crash retry was accepted',stage,r)
        original_retained(job,original)
    finally:cleanup(base,keeper)

def activation(fault='activation'):
    base,source,keeper=fixture(fault,fault)
    try:
        original=digest(source/'payload');job=queue(base);p,r=execute(base,'run');assert p.returncode==0,r
        job=r['job'];assert job['state']=='recovery_required' and job['stage']=='published',job
        original_retained(job,original);assert digest(source/'payload')==original
        state=read_state(base);assert state['datasets'][job['dataset']]['canmount']=='noauto';before=mutations(base)
        state['fault']='';save_state(base,state);p,r=execute(base,'resume');assert p.returncode==0,r
        p,r=execute(base,'run');assert p.returncode==0 and r['job']['state']=='completed',r
        assert mutations(base)[len(before):]==[['set','-u','canmount=on',job['dataset']]]
    finally:cleanup(base,keeper)

def legacy():
    base,source,keeper=fixture('legacy')
    try:
        original=digest(source/'payload');job=queue(base);job.pop('method');job.pop('staging')
        (base/'state'/(job['id']+'.json')).write_text(json.dumps(job));before=mutations(base)
        p,r=execute(base,'run');assert p.returncode==0,r
        assert r['job']['state']=='recovery_required' and 'method' not in r['job'],r
        assert mutations(base)==before;original_retained(job,original)
    finally:cleanup(base,keeper)

def directory_workflow(negative=None):
    base,source,keeper=fixture('directory-'+(negative or 'success'))
    try:
        original=digest(source/'payload');before=identity(source);dest=source.parent/'MOVED'
        (source/'link-outside').symlink_to('/test/private/outside-sentinel')
        (source/'link-directory').symlink_to('/test/private')
        (base/'review.json').write_text(json.dumps({'path':str(source),'identity':before,'destination':str(dest)}))
        if negative=='duplicate':dest.mkdir();(dest/'existing').write_text('existing preserved')
        p,r=execute(base,'move',deny_openat2=negative=='kernel-deny');assert p.returncode==0,r
        if negative:
            assert r['answer']['failed'] and not r['answer']['succeeded'],r
            assert digest(source/'payload')==original and identity(source)==before
            if negative=='duplicate':assert (dest/'existing').read_text()=='existing preserved'
            else:assert not dest.exists()
        else:
            assert r['answer']['succeeded'] and not r['answer']['failed'],r
            assert not source.exists() and digest(dest/'payload')==original and identity(dest)==before
            assert (os.stat(dest).st_uid,os.stat(dest).st_mode&0o7777)==(99,0o777)
            assert (dest/'link-outside').is_symlink()
            (base/'review.json').write_text(json.dumps({'path':str(dest),'identity':identity(dest)}))
            p,r=execute(base,'delete');assert p.returncode==0,r
            assert r['answer']['succeeded'] and not r['answer']['failed'] and not dest.exists(),r
    finally:cleanup(base,keeper)

def run():
    assert os.stat('/test').st_uid==0 and os.stat('/test').st_mode&0o022==0,'/test must be root owned and protected (Docker tmpfs mode=0755)'
    pathlib.Path('/test/private').mkdir(mode=0o700,parents=True,exist_ok=True)
    cases=[('success',success)]+[(fault,lambda fault=fault:fault_case(fault)) for fault in ['create','mount','copy','property','publish','wrong-guid','wrong-tag','concurrent-write','target-corrupt']]
    stages=['planned','preparing','target_created','copying','copy_verified','claiming','source_retained','reserving','reserved','mountpoint_pending','publishing','published']
    cases += [('crash-'+stage,lambda stage=stage:crash_case(stage)) for stage in stages]+[('legacy-retained',legacy),('activation-resume',activation),('activation-noop',lambda:activation('activation-noop')),('guarded-move-delete',directory_workflow),('move-existing-destination',lambda:directory_workflow('duplicate')),('move-kernel-denied',lambda:directory_workflow('kernel-deny'))]
    if len(sys.argv)>1:cases=[(name,fn) for name,fn in cases if name in sys.argv[1:]];assert cases,'Unknown scenario filter'
    sentinel=pathlib.Path('/test/private/outside-sentinel');sentinel.write_bytes(b'outside unchanged')
    outside=(digest(sentinel),os.stat('/').st_mode,os.stat('/').st_uid)
    for name,fn in cases:
        try:
            fn();assert outside==(digest(sentinel),os.stat('/').st_mode,os.stat('/').st_uid);RESULTS.append({'name':name,'status':'PASS'});print('PASS '+name,flush=True)
        except Exception as e:RESULTS.append({'name':name,'status':'FAIL','error':str(e)});print('FAIL '+name+': '+str(e),flush=True)
    failed=sum(x['status']=='FAIL' for x in RESULTS)
    print(json.dumps({'ok':failed==0,'suite':'conversion-workflow','scenarios':len(RESULTS),'failed':failed,'results':RESULTS,'php':subprocess.check_output(['php','-r','echo PHP_VERSION;'],text=True),'arch':os.uname().machine,'kernel':os.uname().release,'source_sha256':{name:digest(ROOT/'src'/name) for name in ['scripts/zfsm-directory.pl','scripts/zfsm-copy-confined.pl','scripts/zfsm-publish.pl','include/ZFSMConfinedConversion.php','include/ZFSMJobRunner.php','include/ZFSMIdentity.php','include/ZFSMJobProcess.php','include/ZFSMJobs.php']}}))
    raise SystemExit(bool(failed))

run()
