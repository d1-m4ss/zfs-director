#!/usr/bin/env python3
"""Real PHP endpoint and kernel flock in a disposable Linux container only."""
import pathlib, subprocess, json, fcntl, hashlib, os
assert pathlib.Path('/.dockerenv').exists()
root=pathlib.Path('/usr/local/emhttp');(root/'webGui/include').mkdir(parents=True,exist_ok=True);(root/'plugins').mkdir(exist_ok=True)
(root/'plugins/zfs.master.ui').symlink_to('/stand/src')
(root/'webGui/include/Helpers.php').write_text("<?php function parse_plugin_cfg($p,$s){return parse_ini_file('/boot/config/plugins/zfs.master.ui/zfs.master.ui.cfg',true,INI_SCANNER_RAW);}")
cfg=pathlib.Path('/boot/config/plugins/zfs.master.ui/zfs.master.ui.cfg');cfg.parent.mkdir(parents=True,exist_ok=True);cfg.write_text('[general]\nsanoid_integration="0"\n')
request=pathlib.Path('/test/settings-request.php');request.write_text("<?php $docroot='/usr/local/emhttp';$_SERVER['REQUEST_METHOD']='POST';$var=['csrf_token'=>'fixture'];$_POST=['cmd'=>'saveconfig','csrf_token'=>'fixture','settings'=>[]];require '/stand/src/backend/ZFSMAdmin.php';")
def call():
 p=subprocess.run(['php',str(request)],capture_output=True,text=True,timeout=20);assert p.returncode==0,(p.stdout,p.stderr);return json.loads(p.stdout)
original=cfg.read_bytes();lock=pathlib.Path('/var/lock/zfs.master.ui.lock');lock.parent.mkdir(parents=True,exist_ok=True)
with lock.open('a') as h:
 fcntl.flock(h,fcntl.LOCK_EX|fcntl.LOCK_NB);inode=lock.stat().st_ino
 answer=call();assert 'operation lock is held' in answer['failed']['request'],answer;assert cfg.read_bytes()==original
 events=[json.loads(l) for p in cfg.parent.glob('audit/*.jsonl') for l in p.read_text().splitlines()]
 event=next(e for e in reversed(events) if e.get('phase')=='outcome');assert event['details']['error_code']=='lock_busy' and event['details']['stage']=='acquiring_lock',event
 assert event['details'].get('lock_owner')=={'pid':os.getpid(),'comm':pathlib.Path('/proc/self/comm').read_text().strip()},event
 assert set(event['details']['lock_owner'])=={'pid','comm'},event
 assert 'cmdline' not in json.dumps(events)
 fcntl.flock(h,fcntl.LOCK_UN)
 # A released owner must not be inferred from a persistent inode or old audit.
 probe=pathlib.Path('/test/lock-owner.php');probe.write_text("<?php require '/stand/src/include/ZFSMHelpers.php'; $h=fopen('/var/lock/zfs.master.ui.lock','ce'); echo json_encode(zfsmOperationLockOwner(fstat($h))); fclose($h);")
 p=subprocess.run(['php',str(probe)],capture_output=True,text=True,timeout=10);assert p.returncode==0,(p.stdout,p.stderr);assert json.loads(p.stdout) is None,p.stdout
answer=call();assert 'field_errors' in answer and 'request' not in answer['failed'],answer
events=[json.loads(l) for p in cfg.parent.glob('audit/*.jsonl') for l in p.read_text().splitlines()]
assert 'lock_owner' not in next(e for e in reversed(events) if e.get('phase')=='outcome')['details']
assert cfg.read_bytes()==original and lock.stat().st_ino==inode
# Deterministically release the real kernel lock between the two observations.
# Instrument only the test copy at the comm-read boundary, not the parser/flock.
helpers=pathlib.Path('/stand/src/include/ZFSMHelpers.php').read_text()
boundary="        $comm=@file_get_contents('/proc/'.$pid.'/comm',false,null,0,17);"
assert helpers.count(boundary)==1
paused=pathlib.Path('/test/paused-helpers.php');paused.write_text(helpers.replace(boundary,boundary+'\n        echo "observed\\n"; fflush(STDOUT); fgets(STDIN);'))
probe.write_text("<?php require '/test/paused-helpers.php'; $h=fopen('/var/lock/zfs.master.ui.lock','ce'); echo json_encode(zfsmOperationLockOwner(fstat($h))); fclose($h);")
with lock.open('a') as h:
 fcntl.flock(h,fcntl.LOCK_EX|fcntl.LOCK_NB)
 child=subprocess.Popen(['php',str(probe)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  import select
  assert select.select([child.stdout],[],[],5)[0],'Owner read did not reach inspection boundary'
  assert child.stdout.readline()=='observed\n'
  fcntl.flock(h,fcntl.LOCK_UN)
  out,err=child.communicate('\n',timeout=10);assert child.returncode==0,(out,err);assert json.loads(out) is None,out
 finally:
  if child.poll() is None:child.kill();child.wait()
# Missing /proc (or denied diagnostic reads) must preserve the original refusal.
empty=pathlib.Path('/test/no-proc');empty.mkdir();missing=pathlib.Path('/test/no-proc.php')
missing.write_text("<?php require '/stand/src/include/ZFSMHelpers.php'; $GLOBALS['zfsm_audit_current_id']='fixture'; $GLOBALS['zfsm_audit_operations']=['fixture'=>[]]; if(!chroot('/test/no-proc'))exit(2); try{zfsmAcquireOperationLock('/mutation.lock');exit(3);}catch(RuntimeException $e){echo json_encode(['message'=>$e->getMessage(),'details'=>$GLOBALS['zfsm_audit_operations']['fixture']['failure_details']]);}")
with (empty/'mutation.lock').open('a') as h:
 fcntl.flock(h,fcntl.LOCK_EX|fcntl.LOCK_NB)
 p=subprocess.run(['php',str(missing)],capture_output=True,text=True,timeout=10);assert p.returncode==0,(p.stdout,p.stderr)
 result=json.loads(p.stdout);assert 'operation lock is held' in result['message'];assert result['details']=={'stage':'acquiring_lock','error_code':'lock_busy'},result
print(json.dumps({'status':'PASS','checks':['held flock denies actual saveconfig before settings validation','config OFF remains byte-identical','History records acquiring_lock/lock_busy and matched kernel owner PID/comm only','released owner produces no stale diagnostics','release during diagnostic inspection returns no owner','missing procfs preserves lock_busy refusal without invented owner','released same inode permits settings validation on retry'],'boundary':'Disposable native Linux; request settings deliberately incomplete, no activation or ZFS calls; production holder remains unknown'}))
