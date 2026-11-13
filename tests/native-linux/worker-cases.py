#!/usr/bin/env python3
"""Real worker service/daemon signals and Linux locks; copied host/ZFS adapters only.

No mounts, network, ZFS installation, production paths, or product source edits.
The Python parent acts as a minimal init subreaper for killed grandchildren.
"""
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback

ROOT = Path('/stand/src')
RESULTS = []

def wait_for(predicate, message, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(.05)
    raise AssertionError(message)

def proc_info(pid):
    try:
        stat = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        argv = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        return {'pid':pid, 'state':stat[0], 'ppid':int(stat[1]), 'pgid':int(stat[2]), 'argv':[x.decode(errors='replace') for x in argv if x]}
    except (FileNotFoundError, ProcessLookupError):
        return None

# The worker renames itself, so its path may no longer appear in argv. REL-001: the
# service runs one daemon per lane; only the files lane owns the monitor.
def daemon_lane(info):
    argv=info['argv']
    if 'zfs-director worker' in argv: return 'files'
    for lane in ('policy','replication'):
        if 'zfs-director worker '+lane in argv: return lane
    if '--daemon' in argv:
        rest=argv[argv.index('--daemon')+1:]
        return rest[0] if rest else 'files'
    return None

def is_daemon(info):
    return daemon_lane(info)=='files'

def descends_from_test(pid):
    # Renamed processes no longer carry this test's path: scope them by ancestry.
    seen=set()
    while pid>1 and pid not in seen:
        if pid==os.getpid(): return True
        seen.add(pid)
        info=proc_info(pid)
        if not info: return False
        pid=info['ppid']
    return False

def processes(source):
    found = []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        info = proc_info(int(path.name))
        if info and (any(str(source) in arg for arg in info['argv']) or (any(arg.startswith('zfs-director ') for arg in info['argv']) and descends_from_test(info['pid']))):
            found.append(info)
    return found

def active(pid):
    info = proc_info(pid)
    return bool(info and info['state'] != 'Z')

def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                return
        except ChildProcessError:
            return

def free_lock(path):
    with open(path, 'a+b') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(handle, fcntl.LOCK_UN)
            return True
        except BlockingIOError:
            return False

def job_read(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def mark(name, evidence):
    RESULTS.append({'name':name, 'status':'PASS', 'evidence':evidence})

def main():
    assert not shutil.which('zfs') and not shutil.which('zpool'), 'Actual ZFS commands must not be installed'
    assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0, 'Linux child subreaper unavailable'
    base = Path(tempfile.mkdtemp(prefix='zfsm-worker-', dir='/test'))
    source = base/'src'
    shutil.copytree(ROOT, source)
    for folder in ['jobs', 'runtime', 'audit', 'bin', 'mount', 'original']:
        (base/folder).mkdir(mode=0o700)
    # Stub only host config/path integration, never worker/runner/journal logic.
    settings = source/'include/ZFSMBase.php'
    adapter = r'''
$plugin_state=getenv('ZFSM_TEST_HOME').'/jobs';
$plugin_runtime=getenv('ZFSM_TEST_HOME').'/runtime';
$plugin_audit=getenv('ZFSM_TEST_HOME').'/audit';
$plugin_lock=getenv('ZFSM_TEST_HOME').'/mutation.lock';
$plugin_worker_lock=getenv('ZFSM_TEST_HOME').'/worker.lock';
$plugin_service_lock=getenv('ZFSM_TEST_HOME').'/service.lock';
$plugin_config=getenv('ZFSM_TEST_HOME').'/settings.cfg';
function parse_plugin_cfg($plugin,$all=false){return ['general'=>['destructive_mode'=>'1','refresh_interval'=>'0']];}
'''
    settings.write_text(settings.read_text().replace('?>', adapter+'\n?>'))
    # The monitor sees no pools; all unexpected ZFS operations fail and are logged.
    external = '''#!/usr/bin/python3
import json,os,sys
from pathlib import Path
with open(Path(os.environ['ZFSM_TEST_HOME'])/'external.jsonl','a') as f:f.write(json.dumps({'command':Path(sys.argv[0]).name,'args':sys.argv[1:]})+'\\n')
if Path(sys.argv[0]).name=='zpool' and sys.argv[1:2]==['list']:sys.exit(0)
sys.stderr.write('Native worker test: unexpected external operation refused\\n')
sys.exit(91)
'''
    for name in ['zfs', 'zpool', 'rsync']:
        path=base/'bin'/name
        path.write_text(external)
        path.chmod(0o700)
    worker=source/'scripts/zfsm-worker.php'
    monitor=source/'scripts/zfsm-monitor.php'
    for path in [worker, monitor, source/'include/ZFSMJobs.php', source/'include/ZFSMJobRunner.php', source/'include/ZFSMRestore.php', source/'include/ZFSMJobProcess.php']:
        assert path.read_bytes()==(ROOT/path.relative_to(source)).read_bytes(), 'Product lifecycle logic must remain byte-identical'
    env=os.environ|{'ZFSM_TEST_HOME':str(base),'PATH':str(base/'bin')+':'+os.environ['PATH']}
    log=open(base/'service.log','wb')
    lock=open(base/'mutation.lock','a+b')
    fcntl.flock(lock, fcntl.LOCK_EX)
    service=None
    observed_pids=set()
    try:
        service=subprocess.Popen(['php',str(worker),'--service'],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        def daemon(excluding=None):
            for info in processes(source):
                observed_pids.add(info['pid'])
                if is_daemon(info) and info['pid']!=excluding and info['state']!='Z':
                    return info
        first=wait_for(lambda:daemon(), 'Actual service failed to launch daemon')
        def monitor_in_group(group):
            return next((x for x in processes(source) if (str(monitor) in x['argv'] or 'zfs-director monitor' in x['argv']) and x['pgid']==group and x['state']!='Z'),None)
        old_monitor=wait_for(lambda:monitor_in_group(first['pid']), 'Actual daemon failed to launch monitor in its isolated process group')
        observed_pids.add(old_monitor['pid'])
        assert not free_lock(base/'worker.lock') and not free_lock(base/'service.lock')
        for mode in ['--daemon','--service']:
            competitor=subprocess.run(['php',str(worker),mode],env=env,capture_output=True,timeout=4)
            assert competitor.returncode==0, competitor.stderr.decode()
        assert active(first['pid']), 'Competing worker disrupted owner'
        assert len([x for x in processes(source) if is_daemon(x) and x['state']!='Z'])==1
        lanes=wait_for(lambda:(found:=sorted(daemon_lane(x) for x in processes(source) if daemon_lane(x) and x['state']!='Z'))==['files','policy','replication'] and found,'Service did not start one daemon per lane')
        for lane in ('policy','replication'):assert not free_lock(base/('worker.'+lane+'.lock')),lane
        mark('service runs one daemon per worker lane', {'lanes':lanes})
        mark('real competing daemons/services cannot acquire owner kernel locks', {'daemon_pid':first['pid'],'monitor_pid':old_monitor['pid'],'worker_lock_held':True,'service_lock_held':True})

        boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        conversion_id='20261016-140000-aaaaaaaaaaaa'
        restore_id='20261016-140001-bbbbbbbbbbbb'
        original=base/'original'/'item';original.mkdir();(original/'marker').write_text('ORIGINAL retained bytes')
        target=base/'mount'/'item';target.mkdir();(target/'marker').write_text('PARTIAL target bytes')
        original_identity={'dev':str(original.stat().st_dev),'ino':str(original.stat().st_ino)}
        conversion={'schema':1,'type':'conversion','id':conversion_id,'state':'running','stage':'copying','source':str(target),'source_identity':original_identity,'recovery':str(target)+'_zfsm_recovery_'+conversion_id,'dataset':'cache/item','owner_dataset':'cache','owner_guid':'123','owner_mountpoint':str(base/'mount'),'pool':'cache','ack_boot':boot,'cancel_requested':False}
        mount=base/'mount'
        staging=mount/('.zfsm-restore-'+restore_id);(staging/'replaced').mkdir(parents=True);(staging/'replaced'/'marker').write_text('ORIGINAL restore bytes')
        restore={'schema':2,'type':'restore','id':restore_id,'state':'running','stage':'copying','snapshot':'cache@saved','snapshot_guid':'77','dataset':'cache','owner_guid':'123','owner_mountpoint':str(mount),'source':'cache@saved','target':str(mount),'staging':str(staging),'hold_tag':'zfsm_restore_'+restore_id,'hold_owned':False,'cancel_requested':False,'ack_boot':boot,'mode':'overwrite','bytes':10,'files':1,'conflicts':1,'recovery':str(staging/'replaced')}
        paths=[base/'jobs'/(conversion_id+'.json'),base/'jobs'/(restore_id+'.json')]
        for path,job in zip(paths,[conversion,restore]):path.write_text(json.dumps(job))
        retained=[original/'marker',target/'marker',staging/'replaced'/'marker']
        before={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in retained}
        os.kill(first['pid'],signal.SIGKILL)
        second=wait_for(lambda:(candidate:=daemon(excluding=first['pid'])) and candidate['pgid']==candidate['pid'] and candidate, 'Supervisor did not restart an isolated SIGKILLed daemon')
        wait_for(lambda:not active(old_monitor['pid']), 'Supervisor did not kill orphan monitor in old daemon process group')
        reap()
        assert second['pid']!=first['pid'] and second['pgid']==second['pid']
        assert all(job_read(p).get('state')=='running' for p in paths), 'Mutation lock failed to hold interrupted journal processing'
        mark('actual supervisor restarts killed daemon and kills orphan group', {'killed_daemon_pid':first['pid'],'restarted_daemon_pid':second['pid'],'old_monitor_not_running':True})
        fcntl.flock(lock,fcntl.LOCK_UN)
        def recovered():
            jobs=[job_read(p) for p in paths]
            return jobs if all(j.get('state')=='recovery_required' for j in jobs) else None
        recovered_jobs=wait_for(recovered,'Restarted actual worker must quarantine conversion and restore without automatic copying')
        for job in recovered_jobs:assert 'interrupted' in job.get('error','').lower(),job
        # Wait multiple worker polls: quarantine must remain stable, not recopy.
        time.sleep(1.2)
        assert all(job_read(p).get('state')=='recovery_required' for p in paths)
        assert before=={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in retained},'Retained original/partial bytes changed'
        commands=[json.loads(line) for line in (base/'external.jsonl').read_text().splitlines()] if (base/'external.jsonl').exists() else []
        assert all(row['command']=='zpool' for row in commands),commands
        assert not list((base/'jobs').glob('*.tmp'))
        mark('SIGKILL restart quarantines running conversion and restore without copying', {'states':[j['state'] for j in recovered_jobs],'stages':[j['stage'] for j in recovered_jobs],'retained_sha256':before,'copy_or_zfs_operations':0,'journal_temp_files':0})

        stopped=subprocess.run(['php',str(worker),'--stop'],env=env,capture_output=True,timeout=16)
        assert stopped.returncode==0,stopped.stderr.decode()
        assert service.wait(timeout=4)==0
        wait_for(lambda:not any(x['state']!='Z' for x in processes(source)), 'Cooperative stop left live daemon/monitor processes')
        reap()
        for path in [base/'worker.lock',base/'worker.policy.lock',base/'worker.replication.lock',base/'service.lock',base/'mutation.lock',base/'runtime'/'monitor.lock']:assert free_lock(path),str(path)
        assert not any(active(pid) for pid in observed_pids)
        mark('actual --stop releases all locks and leaves no live descendants', {'stop_exit':stopped.returncode,'service_exit':service.returncode,'worker_service_mutation_monitor_locks_free':True,'live_descendants':0})
    finally:
        try:(base/'runtime'/'stop').write_text('stop')
        except OSError:pass
        try:fcntl.flock(lock,fcntl.LOCK_UN)
        except OSError:pass
        lock.close()
        # Deterministic cleanup even after assertion failure; no unrelated PIDs.
        for info in processes(source):
            if info['pgid']==info['pid']:
                try:os.killpg(info['pid'],signal.SIGKILL)
                except ProcessLookupError:pass
        if service and service.poll() is None:
            service.kill()
        if service:
            try:service.wait(timeout=4)
            except subprocess.TimeoutExpired:pass
        for info in processes(source):
            try:os.kill(info['pid'],signal.SIGKILL)
            except ProcessLookupError:pass
        time.sleep(.05);reap();log.close()
        # Preserve no jobs, logs, or spawned processes outside disposable /test.
        shutil.rmtree(base)

# TEST-004 / REL-001: a long synchronous replication (schema 4) must not delay a
# queued scheduled policy or a restore job; each runs in its own worker lane.
def lanes_case():
    # Idempotent: run.py's own main() already does this before invoking this
    # file as a subprocess, but this file is also runnable standalone, and the
    # trusted-manifest chain below requires a non-world-writable ancestor.
    os.chmod('/test',0o755)
    base=Path(tempfile.mkdtemp(prefix='zfsm-lanes-',dir='/test'))
    source=base/'src'
    shutil.copytree(ROOT,source)
    for folder in ['jobs','runtime','audit','bin','cron-fixture']:
        (base/folder).mkdir(mode=0o700)
    settings=source/'include/ZFSMBase.php'
    adapter=r'''
$plugin_state=getenv('ZFSM_TEST_HOME').'/jobs';
$plugin_runtime=getenv('ZFSM_TEST_HOME').'/runtime';
$plugin_audit=getenv('ZFSM_TEST_HOME').'/audit';
$plugin_lock=getenv('ZFSM_TEST_HOME').'/mutation.lock';
$plugin_worker_lock=getenv('ZFSM_TEST_HOME').'/worker.lock';
$plugin_service_lock=getenv('ZFSM_TEST_HOME').'/service.lock';
$plugin_config=getenv('ZFSM_TEST_HOME').'/settings.cfg';
$GLOBALS['zfsm_protection_paths']=['manifest'=>getenv('ZFSM_TEST_HOME').'/native-plugin-fixture.plg','sanoid'=>[getenv('ZFSM_TEST_HOME').'/bin/sanoid'],'syncoid'=>[getenv('ZFSM_TEST_HOME').'/bin/syncoid'],'defaults'=>[getenv('ZFSM_TEST_HOME').'/sanoid.defaults.conf']];
$GLOBALS['zfsm_protection_cron_file']=getenv('ZFSM_TEST_HOME').'/protection.cron';
$GLOBALS['zfsm_protection_scan_roots']=[getenv('ZFSM_TEST_HOME').'/cron-fixture'];
$GLOBALS['zfsm_protection_scan_patterns']=[];
function parse_plugin_cfg($plugin,$all=false){return ['general'=>['destructive_mode'=>'1','refresh_interval'=>'0','sanoid_integration'=>'1']];}
'''
    settings.write_text(settings.read_text().replace('?>',adapter+'\n?>'))
    worker=source/'scripts/zfsm-worker.php'
    for path in [worker, source/'include/ZFSMJobs.php', source/'include/ZFSMProtectionJobs.php', source/'include/ZFSMRestore.php']:
        assert path.read_bytes()==(ROOT/path.relative_to(source)).read_bytes(), 'Product lifecycle logic must remain byte-identical'
    (base/'native-plugin-fixture.plg').write_text('<!DOCTYPE PLUGIN [<!ENTITY name "unRAID6-Sanoid"><!ENTITY version "2.3.0">]><PLUGIN name="&name;"/>')
    (base/'sanoid.defaults.conf').write_text('')
    # Fake syncoid/sanoid never call real zfs; this fake zfs only answers the
    # exact inventory lookups zfsmSyncoidInventory()/zfsmSanoidInventory() make
    # for our fixture datasets and fails closed on anything else.
    fake_zfs=r'''#!/usr/bin/python3
import sys
args=sys.argv[1:]
guids={'lanes/policy':'77001','lanes/replicate/source':'77002'}
missing={'lanes/replicate/target'}
if args[:1]==['list'] and '-o' in args:
    dataset=args[-1]
    if dataset in missing:
        sys.stderr.write('cannot open: dataset does not exist\n')
        sys.exit(1)
    guid=guids.get(dataset)
    if guid is None:
        sys.stderr.write('lanes fake zfs: unexpected dataset '+str(dataset)+'\n')
        sys.exit(2)
    sys.stdout.write(dataset+'\tfilesystem\t'+guid+'\t1700000000\t1\n')
    sys.exit(0)
if args[:1] in (['receive'],['send']):
    sys.exit(1)
sys.stderr.write('lanes fake zfs: unexpected invocation '+repr(args)+'\n')
sys.exit(3)
'''
    fake_sanoid=r'''#!/usr/bin/python3
import sys
args=sys.argv[1:]
if '--version' in args:
    sys.stdout.write('sanoid version 2.3.0\n');sys.exit(0)
if '--help' in args:
    sys.stdout.write('--configdir --readonly --take-snapshots --prune-snapshots --cache-dir --run-dir --force-update\n');sys.exit(0)
sys.exit(0)
'''
    fake_syncoid=r'''#!/usr/bin/python3
import sys,time
args=sys.argv[1:]
if '--version' in args:
    sys.stdout.write('syncoid version 2.3.0\n');sys.exit(0)
if '--help' in args:
    sys.stdout.write('--no-rollback --recvoptions --sshoption --identifier --no-resume --compress --no-clone-handling\n');sys.exit(0)
time.sleep(40)
sys.exit(0)
'''
    for name,content in [('zfs',fake_zfs),('sanoid',fake_sanoid),('syncoid',fake_syncoid)]:
        path=base/'bin'/name;path.write_text(content);path.chmod(0o700)
    # Builds valid policy/replication definitions and queues their protection
    # jobs with the real production helpers (zfsmSanoidPolicy/zfsmSyncoidJob/
    # zfsmNewProtectionJob); only the restore job is assembled directly, the
    # way this same file already does for its own fixture jobs above.
    setup=base/'lanes-setup.php'
    setup.write_text(r'''<?php
require $argv[1].'/backend/ZFSMOperations.php';
$action=$argv[2];
if($action==='init'){
    $policy=zfsmSanoidPolicy(['dataset'=>'lanes/policy','source_guid'=>'77001']);
    $replication=zfsmSyncoidJob(['source'=>'lanes/replicate/source','target'=>'lanes/replicate/target','source_guid'=>'77002','mode'=>'local','resume'=>false,'compression'=>'none']);
    $store=['version'=>1,'policies'=>[$policy['id']=>$policy],'replications'=>[$replication['id']=>$replication],'owned_snapshots'=>[]];
    zfsmProtectionWriteStore($store);
    echo json_encode(['policy_id'=>$policy['id'],'replication_id'=>$replication['id']]);
    exit(0);
}
if($action==='queue-replication'||$action==='queue-policy'){
    $type=$action==='queue-replication'?'replication':'policy';
    $store=zfsmProtectionReadStore();
    $definition=$store[$type==='policy'?'policies':'replications'][$argv[3]];
    $job=zfsmNewProtectionJob($type,$definition);
    zfsmJobAtomicWrite(zfsmJobFile($job['id']),$job);
    echo $job['id'];
    exit(0);
}
if($action==='queue-restore'){
    $id=gmdate('Ymd-His').'-'.bin2hex(random_bytes(6));
    $mount='/test/lanes-restore-mount';
    $job=['schema'=>2,'type'=>'restore','id'=>$id,'state'=>'queued','stage'=>'planned',
        'dataset'=>'lanes/restore','snapshot'=>'lanes/restore@keep','source'=>'lanes/restore@keep',
        'owner_guid'=>'77003','snapshot_guid'=>'77004',
        'owner_mountpoint'=>$mount,'target'=>$mount.'/restored','mode'=>'new',
        'bytes'=>0,'files'=>0,'conflicts'=>0,'recovery'=>'',
        'staging'=>$mount.'/.zfsm-restore-'.$id,'hold_tag'=>'zfsm_restore_'.$id,
        'hold_owned'=>false,'cancel_requested'=>false,'ack_boot'=>zfsmBootId(),
        'created'=>gmdate('c'),'updated'=>gmdate('c')];
    $job=zfsmJobInitializeHistory($job);
    zfsmJobAtomicWrite(zfsmJobFile($job['id']),$job);
    echo $job['id'];
    exit(0);
}
fwrite(STDERR,"unknown action\n");exit(1);
''')
    env=os.environ|{'ZFSM_TEST_HOME':str(base),'PATH':str(base/'bin')+':'+os.environ['PATH']}
    def run_setup(*args):
        p=subprocess.run(['php',str(setup),str(source)]+list(args),env=env,capture_output=True,timeout=10)
        assert p.returncode==0,p.stdout.decode()+p.stderr.decode()
        return p.stdout.decode().strip()
    log=open(base/'service.log','wb')
    service=None
    try:
        ids=json.loads(run_setup('init'))
        # No start_new_session here: the --daemon branch calls posix_setsid()
        # itself, which fails if Python already made this process a session
        # leader. Let the daemon create its own new session, as --service does.
        service=subprocess.Popen(['php',str(worker),'--service'],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        wait_for(lambda:sorted(daemon_lane(x) for x in processes(source) if daemon_lane(x) and x['state']!='Z')==['files','policy','replication'],'Lane daemons failed to start')
        replication_id=run_setup('queue-replication',ids['replication_id'])
        time.sleep(1)
        policy_id=run_setup('queue-policy',ids['policy_id'])
        restore_id=run_setup('queue-restore')
        t_secondary=time.monotonic()
        def secondary_terminal():
            p=job_read(base/'jobs'/(policy_id+'.json'))
            r=job_read(base/'jobs'/(restore_id+'.json'))
            if p.get('state') in ('queued','running') or r.get('state') in ('queued','running'):
                return None
            return (p,r)
        try:
            policy,restore=wait_for(secondary_terminal,'Queued policy/restore jobs did not reach a terminal state within 15s while replication was still running (REL-001)',timeout=15)
        except AssertionError as error:
            replication=job_read(base/'jobs'/(replication_id+'.json'))
            p=job_read(base/'jobs'/(policy_id+'.json'));r=job_read(base/'jobs'/(restore_id+'.json'))
            raise AssertionError(str(error)+' -- observed: replication.state=%r policy.state=%r restore.state=%r'%(replication.get('state'),p.get('state'),r.get('state'))) from None
        replication=job_read(base/'jobs'/(replication_id+'.json'))
        assert replication.get('state')=='running','Replication job unexpectedly left running before the lane assertion window; test timing is unreliable: '+json.dumps(replication)
        print('PASS worker lanes: policy %s / restore %s reached a terminal state in %.1fs while replication was still running'%(policy.get('state'),restore.get('state'),time.monotonic()-t_secondary),file=sys.stderr,flush=True)
    finally:
        try:(base/'runtime'/'stop').write_text('stop')
        except OSError:pass
        for info in processes(source):
            if info['pgid']==info['pid']:
                try:os.killpg(info['pid'],signal.SIGKILL)
                except ProcessLookupError:pass
        if service and service.poll() is None:
            service.kill()
        if service:
            try:service.wait(timeout=4)
            except subprocess.TimeoutExpired:pass
        for info in processes(source):
            try:os.kill(info['pid'],signal.SIGKILL)
            except ProcessLookupError:pass
        time.sleep(.05);reap();log.close()
        shutil.rmtree(base,ignore_errors=True)

if __name__=='__main__':
    failure=None
    try:main()
    except Exception as error:
        failure=str(error)
        RESULTS.append({'name':'actual worker lifecycle integration','status':'FAIL','error':failure,'traceback':traceback.format_exc(limit=6)})
    print(json.dumps({'scope':'native Linux PHP actual worker/service/daemon/monitor and journaling; copied Base host paths/config shim; external ZFS/rsync only fail-closed stubs; Python init subreaper','results':RESULTS,'failed':sum(r['status']=='FAIL' for r in RESULTS),'not_tested':['native ZFS/mount behavior','actual copy interruption (covered separately by helper tests)','held snapshot cleanup semantics','real Unraid host integration']}))
    lanes_failure=None
    try:
        lanes_case()
    except Exception as error:
        lanes_failure=str(error)
        print('FAIL worker lanes: '+lanes_failure,file=sys.stderr,flush=True)
    raise SystemExit(1 if (failure or lanes_failure) else 0)
