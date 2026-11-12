#!/usr/bin/env python3
"""Real PHP endpoint and kernel flock in a disposable Linux container only."""
import pathlib, subprocess, json, fcntl, hashlib, os
assert pathlib.Path('/.dockerenv').exists()
root=pathlib.Path('/usr/local/emhttp');(root/'webGui/include').mkdir(parents=True,exist_ok=True);(root/'plugins').mkdir(exist_ok=True)
(root/'plugins/zfs.master.ui').symlink_to('/stand/src')
(root/'webGui/include/Helpers.php').write_text("<?php function parse_plugin_cfg($p,$s){return parse_ini_file('/boot/config/plugins/zfs.master.ui/zfs.master.ui.cfg',true,INI_SCANNER_RAW);}")
cfg=pathlib.Path('/boot/config/plugins/zfs.master.ui/zfs.master.ui.cfg');cfg.parent.mkdir(parents=True,exist_ok=True);cfg.write_text('[general]\nsanoid_integration="0"\n')
request=pathlib.Path('/test/settings-request.php');request.write_text("<?php $docroot='/usr/local/emhttp';$_SERVER['REQUEST_METHOD']='POST';$var=['csrf_token'=>'fixture'];$_POST=['cmd'=>'saveconfig','csrf_token'=>'fixture','settings'=>[]];require '/stand/src/backend/ZFSMAdmin.php';")
scrub=pathlib.Path('/test/scrub-request.php');scrub.write_text("<?php $docroot='/usr/local/emhttp';$_SERVER['REQUEST_METHOD']='POST';$var=['csrf_token'=>'fixture'];$_POST=['cmd'=>'scrubpool','pool'=>'cache','confirmed'=>'1','csrf_token'=>'fixture'];require '/stand/src/backend/ZFSMAdmin.php';")
def call(file=request):
 p=subprocess.run(['php',str(file)],capture_output=True,text=True,timeout=20);assert p.returncode==0,(p.stdout,p.stderr);return json.loads(p.stdout)
original=cfg.read_bytes();lock=pathlib.Path('/var/lock/zfs.master.ui.lock');lock.parent.mkdir(parents=True,exist_ok=True)
with lock.open('a') as h:
 fcntl.flock(h,fcntl.LOCK_EX|fcntl.LOCK_NB);inode=lock.stat().st_ino
 # A long ZFS job holds this lock; saving settings must not wait for it.
 answer=call();assert 'field_errors' in answer and 'request' not in answer['failed'],answer;assert cfg.read_bytes()==original
 # Any other mutation is still refused while the lock is held.
 answer=call(scrub);assert 'operation lock is held' in answer['failed']['request'],answer;assert cfg.read_bytes()==original
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
# REL-005: protectionsettings must also skip the operation lock.
protection=pathlib.Path('/test/protection-settings-request.php');protection.write_text("<?php $docroot='/usr/local/emhttp';$_SERVER['REQUEST_METHOD']='POST';$var=['csrf_token'=>'fixture'];$_POST=['cmd'=>'protectionsettings','csrf_token'=>'fixture','enabled'=>'0'];require '/stand/src/backend/ZFSMAdmin.php';")
with lock.open('a') as h:
 fcntl.flock(h,fcntl.LOCK_EX|fcntl.LOCK_NB)
 answer=call(protection);assert 'request' not in answer['failed'],answer
 fcntl.flock(h,fcntl.LOCK_UN)
# REL-005 race: saveconfig and protectionsettings write the same .cfg; they
# must now serialize on one real kernel lock, so a write paused mid-flight
# blocks the other side instead of letting it read stale state and clobber
# the paused writer's change (lost update).
cfg.write_text('[general]\nsanoid_integration="1"\nrefresh_interval="30"\nlazy_load="0"\ndestructive_mode="0"\nsnap_max_days_alert="30"\nsnap_pattern="Y-m-d-His"\n')
import shutil
shutil.copytree('/stand/src','/test/paused-src')
settings_file=pathlib.Path('/test/paused-src/include/ZFSMSettings.php');settings_text=settings_file.read_text()
pause_anchor="    $config['general']=array_merge($config['general']??[],$settings);"
assert settings_text.count(pause_anchor)==1
settings_file.write_text(settings_text.replace(pause_anchor,'echo "observed\\n"; fflush(STDOUT); fgets(STDIN);\n'+pause_anchor))
# sanoid_integration='0' here: integration is not installed in this fixture,
# so requesting '1' would fail validation before any write (unrelated to the
# lock race under test). protectionsettings is the one that changes it.
race_save=pathlib.Path('/test/race-save.php');race_save.write_text("<?php $docroot='/usr/local/emhttp';$_SERVER['REQUEST_METHOD']='POST';$var=['csrf_token'=>'fixture'];$_POST=['cmd'=>'saveconfig','csrf_token'=>'fixture','settings'=>['refresh_interval'=>'60','lazy_load'=>'0','sanoid_integration'=>'0','destructive_mode'=>'0','exclusion'=>'','directory_listing'=>'','snap_max_days_alert'=>'30','snap_pattern'=>'Y-m-d-His','snap_prefix'=>'']];require '/stand/src/backend/ZFSMAdmin.php';")
symlink=root/'plugins/zfs.master.ui'
symlink.unlink();symlink.symlink_to('/test/paused-src')
paused=subprocess.Popen(['php',str(protection)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
 import select
 assert select.select([paused.stdout],[],[],10)[0],'protectionsettings did not reach the read/merge boundary'
 assert paused.stdout.readline()=='observed\n'
 # The symlink swap only had to last long enough for PHP to load the patched
 # file; restore the real source before starting the concurrent request.
 symlink.unlink();symlink.symlink_to('/stand/src')
 # While paused mid-write (lock still held), a real concurrent saveconfig
 # request must block on the same lock rather than reading stale state.
 blocked=subprocess.Popen(['php',str(race_save)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 assert select.select([blocked.stdout],[],[],1)[0]==[],'saveconfig did not wait for the shared config lock'
 paused.stdin.write('\n');paused.stdin.flush()
 paused_rest=paused.stdout.read();paused_out,paused_err=paused_rest,paused.stderr.read();paused.wait(timeout=10);assert paused.returncode==0,(paused_out,paused_err)
 paused_answer=json.loads(paused_rest);assert 'request' not in paused_answer['failed'],paused_answer
 save_out,save_err=blocked.communicate(timeout=10);assert blocked.returncode==0,(save_out,save_err)
 save_answer=json.loads(save_out);assert 'request' not in save_answer['failed'],save_answer
finally:
 if symlink.is_symlink() and os.readlink(symlink)!='/stand/src':symlink.unlink();symlink.symlink_to('/stand/src')
 if paused.poll() is None:paused.kill();paused.wait()
race_result=cfg.read_text();assert 'refresh_interval = "60"' in race_result,race_result;assert 'sanoid_integration = "0"' in race_result,race_result
print(json.dumps({'status':'PASS','checks':['held operation flock does not block saveconfig (own settings lock) but still denies other mutations before any ZFS call','config OFF remains byte-identical','History records acquiring_lock/lock_busy and matched kernel owner PID/comm only','released owner produces no stale diagnostics','release during diagnostic inspection returns no owner','missing procfs preserves lock_busy refusal without invented owner','released same inode permits settings validation on retry','protectionsettings also bypasses a held operation lock','a paused protectionsettings write blocks a concurrent saveconfig on the shared config lock; both new values persist'],'boundary':'Disposable native Linux; request settings deliberately incomplete, no activation or ZFS calls; production holder remains unknown'}))
