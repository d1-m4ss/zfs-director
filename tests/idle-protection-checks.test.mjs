import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startIntegration} from './integration/server.mjs';
// A scheduled policy check that created and removed nothing leaves no journal file and no audit entry;
// a manual run, and any scheduled run that failed, stay recorded.
async function fixture(t){
 const s=await startIntegration({protection:true});t.after(()=>s.close());
 const file='/acceptance/system.php',text=s.php.readFileAsText(file),marker='function integrationProcess($command,$args,$stdin=null) {';assert.ok(text.includes(marker));
 s.php.writeFile(file,text.replace(marker,marker+`
 if($command==='/usr/sbin/sanoid'&&in_array('--take-snapshots',$args,true)&&!in_array('--readonly',$args,true)){$GLOBALS['lock_owner_seen']=json_decode((string)@file_get_contents($GLOBALS['plugin_runtime'].'/lock-owner.json'),true);return ['code'=>$GLOBALS['fake_sanoid_code']??0,'output'=>'SYNTHETIC nothing due'];}
`));return s;
}
const prelude=`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
$p=zfsmSanoidPolicy(['id'=>'abc','dataset'=>'cache/__mock__/project','autosnap'=>false,'autoprune'=>false]);$p['source_guid']=zfsmReadIdentity($p['dataset'])['guid'];$store=zfsmProtectionReadStore();$store['policies']['abc']=$p;zfsmProtectionWriteStore($store);
function runJob($manual){$queued=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],$manual);$id=$queued['job']['id'];zfsmRunProtectionJob(zfsmReadJob($id));return $id;}
function executeAudits(){return count(array_filter(zfsmAuditList(100),fn($row)=>($row['command']??'')==='protectionexecute'));}
function scheduledAudits(){return count(array_filter(zfsmAuditList(100),fn($row)=>($row['command']??'')==='protectionscheduled'));}
`;
test('a scheduled check refused before it starts (integration switched off meanwhile) is kept and audited',async t=>{
 const s=await fixture(t);
 const r=await s.run({code:prelude+`
 $queued=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);$id=$queued['job']['id'];
 $cfg=$GLOBALS['plugin_config'];file_put_contents($cfg,str_replace('sanoid_integration = "1"','sanoid_integration = "0"',file_get_contents($cfg)));
 zfsmRunProtectionJob(zfsmReadJob($id));$job=zfsmReadJob($id);
 echo json_encode(['kept'=>is_file(zfsmJobFile($id)),'outcome'=>$job['verified_outcome'],'state'=>$job['state'],'audits'=>executeAudits()]);`});
 assert.equal(r.errors,'',r.text);const out=JSON.parse(r.text.slice(r.text.indexOf('{')));
 assert.deepEqual(out,{kept:true,outcome:'recovery_required',state:'recovery_required',audits:2},'the refused check stays visible with its audit trail');
});
test('an idle scheduled policy check leaves no record; manual and failed runs do',async t=>{
 const s=await fixture(t);
 const r=await s.run({code:prelude+`
 $idle=runJob(false);$afterIdle=['kept'=>is_file(zfsmJobFile($idle)),'audits'=>executeAudits(),'scheduled'=>scheduledAudits(),'lock'=>is_file(zfsmJobFile($idle).'.lock')];
 $manual=runJob(true);$m=zfsmReadJob($manual);$afterManual=['kept'=>is_file(zfsmJobFile($manual)),'outcome'=>$m['verified_outcome'],'trigger'=>$m['trigger'],'audits'=>executeAudits()];
 $GLOBALS['fake_sanoid_code']=1;$failed=runJob(false);$f=zfsmReadJob($failed);$afterFail=['kept'=>is_file(zfsmJobFile($failed)),'outcome'=>$f['verified_outcome'],'trigger'=>$f['trigger'],'audits'=>executeAudits()];
 echo json_encode(compact('afterIdle','afterManual','afterFail'));`});
 assert.equal(r.errors,'',r.text);const out=JSON.parse(r.text.slice(r.text.indexOf('{')));
 assert.deepEqual(out.afterIdle,{kept:false,audits:0,scheduled:0,lock:false},'nothing happened: no job file, no lock file, no audit rows');
 assert.deepEqual(out.afterManual,{kept:true,outcome:'up_to_date',trigger:'manual',audits:2},'Run now is always recorded (one audit operation = two rows)');
 assert.deepEqual(out.afterFail,{kept:true,outcome:'failed',trigger:'schedule',audits:4},'a failed scheduled check stays visible and audited');
});
test('a second scheduled check for the same policy is deduplicated while the first is queued in tmpfs, and once promoted',async t=>{
 const s=await fixture(t);
 const r=await s.run({code:prelude+`
 $first=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);$id=$first['job']['id'];
 $ephemeral=is_file(zfsmJobDirectory($GLOBALS['plugin_runtime'].'/protection-queue').'/'.$id.'.json');
 $durableBeforePromotion=is_file(zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$id.'.json');
 $dup=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);
 zfsmProtectionPromoteJob($id);
 $dupAfterPromotion=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);
 echo json_encode(['ephemeral'=>$ephemeral,'durable_before_promotion'=>$durableBeforePromotion,'dup_id'=>$dup['job']['id'],'dup_message'=>array_values($dup['succeeded'])[0]??null,'dup_after_promotion_id'=>$dupAfterPromotion['job']['id'],'dup_after_promotion_message'=>array_values($dupAfterPromotion['succeeded'])[0]??null,'same_id'=>$id]);`});
 assert.equal(r.errors,'',r.text);const out=JSON.parse(r.text.slice(r.text.indexOf('{')));
 assert.equal(out.ephemeral,true,'the first check is queued in the tmpfs runtime directory');
 assert.equal(out.durable_before_promotion,false,'nothing is written durably while only queued in tmpfs');
 assert.equal(out.dup_id,out.same_id,'a second scheduled request for the same policy is deduplicated to the ephemeral job');
 assert.match(out.dup_message,/Already queued\/running/);
 assert.equal(out.dup_after_promotion_id,out.same_id,'dedup still works once the journal is durable');
 assert.match(out.dup_after_promotion_message,/Already queued\/running/);
});
test('a scheduled check promoted and marked running, then abandoned by a crashed worker, is recovered as interrupted on the next pass',async t=>{
 const s=await fixture(t);
 const r=await s.run({code:prelude+`
 $queued=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);$id=$queued['job']['id'];
 zfsmJobUpdate($id,['state'=>'running','stage'=>'inspecting','verified_outcome'=>'running','started_at'=>gmdate('c')]);
 zfsmProtectionPromoteJob($id);
 $durableWhileRunning=is_file(zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$id.'.json');
 // The worker process is gone here; the next pass picks the same job id back up from disk.
 zfsmRunProtectionJob(zfsmReadJob($id));
 $job=zfsmReadJob($id);
 echo json_encode(['durable_while_running'=>$durableWhileRunning,'outcome'=>$job['verified_outcome'],'state'=>$job['state'],'durable_after'=>is_file(zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$id.'.json')]);`});
 assert.equal(r.errors,'',r.text);const out=JSON.parse(r.text.slice(r.text.indexOf('{')));
 assert.deepEqual(out,{durable_while_running:true,outcome:'interrupted',state:'recovery_required',durable_after:true});
});
test('a worker crash while a scheduled check is still only in tmpfs promotes it and marks it interrupted; it is not re-run',async t=>{
 const s=await fixture(t);
 const r=await s.run({code:prelude+`
 $queued=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);$id=$queued['job']['id'];
 // The worker marks it running, then is killed before any promotion ever happens: at this
 // exact moment the job is still only in tmpfs, with no durable record at all.
 zfsmJobUpdate($id,['state'=>'running','stage'=>'inspecting','verified_outcome'=>'running','started_at'=>gmdate('c')]);
 $ephemeralWhileRunning=is_file(zfsmJobDirectory($GLOBALS['plugin_runtime'].'/protection-queue').'/'.$id.'.json');
 $durableWhileRunning=is_file(zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$id.'.json');
 $pendingWhileRunning=count(array_filter(zfsmPendingJobs(),fn($j)=>$j['id']===$id));
 // The next worker pass (same boot, no reboot) picks the job back up from tmpfs.
 zfsmRunProtectionJob(zfsmReadJob($id));
 $job=zfsmReadJob($id);
 echo json_encode(['ephemeral_while_running'=>$ephemeralWhileRunning,'durable_while_running'=>$durableWhileRunning,'pending_while_running'=>$pendingWhileRunning,'outcome'=>$job['verified_outcome'],'state'=>$job['state'],'durable_after'=>is_file(zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$id.'.json'),'pending_after'=>count(array_filter(zfsmPendingJobs(),fn($j)=>$j['id']===$id))]);`});
 assert.equal(r.errors,'',r.text);const out=JSON.parse(r.text.slice(r.text.indexOf('{')));
 assert.deepEqual(out,{ephemeral_while_running:true,durable_while_running:false,pending_while_running:1,outcome:'interrupted',state:'recovery_required',durable_after:true,pending_after:0},'a crash purely in tmpfs is promoted and recovered as interrupted, and is not picked up again');
});
test('a crash between the durable write and the runtime unlink leaves a leftover that recovery cleans up, with no duplicate in pending',async t=>{
 const s=await fixture(t);
 const r=await s.run({code:prelude+`
 $queued=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);$id=$queued['job']['id'];
 $runtime=zfsmJobDirectory($GLOBALS['plugin_runtime'].'/protection-queue').'/'.$id.'.json';
 // Simulates exactly the crash window inside zfsmProtectionPromoteJob: the durable copy is
 // written, but the process dies before the runtime file (and its lock) are removed.
 zfsmJobAtomicWrite(zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$id.'.json',zfsmReadJob($id));
 $runtimePresentDuringCrash=is_file($runtime);
 $pendingDuringCrash=count(array_filter(zfsmPendingJobs(),fn($j)=>$j['id']===$id));
 // A later promotion attempt (or the periodic sweep) must clean up the leftover.
 zfsmProtectionPromoteJob($id);
 echo json_encode(['runtime_present_during_crash'=>$runtimePresentDuringCrash,'pending_count_during_crash'=>$pendingDuringCrash,'runtime_present_after'=>is_file($runtime),'lock_present_after'=>is_file($runtime.'.lock'),'durable_after'=>is_file(zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$id.'.json')]);`});
 assert.equal(r.errors,'',r.text);const out=JSON.parse(r.text.slice(r.text.indexOf('{')));
 assert.deepEqual(out,{runtime_present_during_crash:true,pending_count_during_crash:1,runtime_present_after:false,lock_present_after:false,durable_after:true},'the stale runtime copy never counts twice and is removed once a durable copy exists');
});
test('a scheduled check still queued only in tmpfs is listed and cancellable in Jobs',async t=>{
 const s=await fixture(t);
 const r=await s.run({code:prelude+`
 $queued=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);$id=$queued['job']['id'];
 $page=zfsmJobPage(1,200);$listed=null;foreach($page['jobs']as$j)if($j['id']===$id)$listed=$j;
 zfsmProtectionCancel($id);
 $after=zfsmReadJob($id);
 echo json_encode(['listed_before_cancel'=>$listed!==null,'group'=>$listed['group']??null,'cancel_action'=>$listed['actions']['cancel']??null,'state_after'=>$after['state'],'cancel_requested_after'=>$after['cancel_requested'],'durable_after'=>is_file(zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$id.'.json')]);`});
 assert.equal(r.errors,'',r.text);const out=JSON.parse(r.text.slice(r.text.indexOf('{')));
 assert.deepEqual(out,{listed_before_cancel:true,group:'active',cancel_action:true,state_after:'cancelled',cancel_requested_after:true,durable_after:true},'a tmpfs-only queued check is visible and cancellable, and the cancellation is durable');
});
test('the worker sweep removes stale terminal tmpfs entries and already-promoted leftovers, but never touches an active one',async t=>{
 const s=await fixture(t);
 const r=await s.run({code:prelude+`
 $abc=zfsmProtectionReadStore()['policies']['abc'];
 $runtimeDir=zfsmJobDirectory($GLOBALS['plugin_runtime'].'/protection-queue');
 // A busy drop (zfsmProtectionDropIdleCheck's non-blocking gate contended) can leave a
 // terminal entry behind with no durable copy at all.
 $stale=zfsmNewProtectionJob('policy',$abc);$stale['trigger']='schedule';$stale['state']='completed';$stale['stage']='finished';$stale['verified_outcome']='up_to_date';$stale['verification']=['outcome'=>'up_to_date','snapshots_created'=>[],'snapshots_pruned'=>[]];
 zfsmJobAtomicWrite($runtimeDir.'/'.$stale['id'].'.json',$stale);
 // A promotion crash leaves a durable copy plus a stale runtime leftover.
 $promoted=zfsmNewProtectionJob('policy',$abc);$promoted['trigger']='schedule';$promoted['state']='failed';$promoted['stage']='finished';$promoted['verified_outcome']='failed';
 zfsmJobAtomicWrite($runtimeDir.'/'.$promoted['id'].'.json',$promoted);
 zfsmJobAtomicWrite(zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$promoted['id'].'.json',$promoted);
 // A non-idle terminal outcome (e.g. a promotion that failed after a real result) must never
 // be swept away just because it is terminal: only a genuinely idle completion ever is.
 $nonIdle=zfsmNewProtectionJob('policy',$abc);$nonIdle['trigger']='schedule';$nonIdle['state']='completed';$nonIdle['stage']='finished';$nonIdle['verified_outcome']='completed';$nonIdle['verification']=['outcome'=>'completed','snapshots_created'=>['cache/__mock__/project@autosnap_2026-10-07_00:00:00_frequently'],'snapshots_pruned'=>[]];
 zfsmJobAtomicWrite($runtimeDir.'/'.$nonIdle['id'].'.json',$nonIdle);
 // A genuinely active check in the same directory must never be touched.
 $activeId=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false)['job']['id'];
 zfsmProtectionSweepRuntimeQueue();
 echo json_encode(['stale_removed'=>!is_file($runtimeDir.'/'.$stale['id'].'.json'),'promoted_leftover_removed'=>!is_file($runtimeDir.'/'.$promoted['id'].'.json'),'promoted_durable_kept'=>is_file(zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$promoted['id'].'.json'),'non_idle_kept'=>is_file($runtimeDir.'/'.$nonIdle['id'].'.json'),'active_kept'=>is_file($runtimeDir.'/'.$activeId.'.json')]);`});
 assert.equal(r.errors,'',r.text);const out=JSON.parse(r.text.slice(r.text.indexOf('{')));
 assert.deepEqual(out,{stale_removed:true,promoted_leftover_removed:true,promoted_durable_kept:true,non_idle_kept:true,active_kept:true});
});
test('a corrupt tmpfs journal is swept once old enough, but a fresh one (a write still in flight) is left alone',async t=>{
 const s=await fixture(t);
 const r=await s.run({code:prelude+`
 $runtimeDir=zfsmJobDirectory($GLOBALS['plugin_runtime'].'/protection-queue');
 $old=$runtimeDir.'/20260101-000000-aaaaaaaaaaaa.json';file_put_contents($old,'{not valid json');touch($old,time()-600);
 $fresh=$runtimeDir.'/20260101-000000-bbbbbbbbbbbb.json';file_put_contents($fresh,'{not valid json');
 zfsmProtectionSweepRuntimeQueue();
 echo json_encode(['old_removed'=>!is_file($old),'fresh_kept'=>is_file($fresh)]);`});
 assert.equal(r.errors,'',r.text);const out=JSON.parse(r.text.slice(r.text.indexOf('{')));
 assert.deepEqual(out,{old_removed:true,fresh_kept:true},'a corrupt journal is only swept once it cannot still be a write in flight');
});
test('cancelling a tmpfs check that was just removed is a clean "Job not found", and cancelling an already-finished idle tmpfs entry never promotes it',async t=>{
 const s=await fixture(t);
 const r=await s.run({code:prelude+`
 $queued=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);$id=$queued['job']['id'];
 $runtime=zfsmJobDirectory($GLOBALS['plugin_runtime'].'/protection-queue').'/'.$id.'.json';
 // Simulates a drop/sweep racing ahead of the cancel request and removing the entry first.
 @unlink($runtime);
 $message=null;try{zfsmProtectionCancel($id);}catch(Throwable$e){$message=$e->getMessage();}
 // An idle check that already finished but has not been dropped/swept yet.
 $abc=zfsmProtectionReadStore()['policies']['abc'];
 $idleFinished=zfsmNewProtectionJob('policy',$abc);$idleFinished['trigger']='schedule';$idleFinished['state']='completed';$idleFinished['stage']='finished';$idleFinished['verified_outcome']='up_to_date';$idleFinished['verification']=['outcome'=>'up_to_date','snapshots_created'=>[],'snapshots_pruned'=>[]];
 $idleRuntime=zfsmJobDirectory($GLOBALS['plugin_runtime'].'/protection-queue').'/'.$idleFinished['id'].'.json';
 zfsmJobAtomicWrite($idleRuntime,$idleFinished);
 zfsmProtectionCancel($idleFinished['id']);
 echo json_encode(['removed_message'=>$message,'idle_durable_after_cancel'=>is_file(zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$idleFinished['id'].'.json'),'idle_runtime_kept'=>is_file($idleRuntime)]);`});
 assert.equal(r.errors,'',r.text);const out=JSON.parse(r.text.slice(r.text.indexOf('{')));
 assert.deepEqual(out,{removed_message:'Job not found',idle_durable_after_cancel:false,idle_runtime_kept:true},'a cancel race is a clean, generic "Job not found"; cancelling an already-idle-finished check never promotes it to flash');
});
test('a promotion completing between the durable and runtime scans is still counted exactly once by zfsmPendingJobs',async t=>{
 const s=await fixture(t);
 const file='/app/src/include/ZFSMJobs.php',text=s.php.readFileAsText(file),marker='// promotion completing between the two scans above must still be counted exactly once, from';
 assert.ok(text.includes(marker));
 // Simulates the exact race: a promotion writes the durable copy (without yet removing the
 // runtime file) right after the durable scan already ran, but before the runtime scan reaches it.
 s.php.writeFile(file,text.replace(marker,`if(!empty($GLOBALS['test_promote_mid_scan'])){$__midId=$GLOBALS['test_promote_mid_scan'];$GLOBALS['test_promote_mid_scan']=null;zfsmJobAtomicWrite(zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$__midId.'.json',zfsmReadJob($__midId));}\n    `+marker));
 const r=await s.run({code:prelude+`
 $queued=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);$id=$queued['job']['id'];
 $GLOBALS['test_promote_mid_scan']=$id;
 $pending=zfsmPendingJobs();
 $matches=array_values(array_filter($pending,fn($j)=>$j['id']===$id));
 echo json_encode(['count'=>count($matches),'durable'=>is_file(zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$id.'.json'),'state'=>$matches[0]['state']??null]);`});
 assert.equal(r.errors,'',r.text);const out=JSON.parse(r.text.slice(r.text.indexOf('{')));
 assert.deepEqual(out,{count:1,durable:true,state:'queued'},'the job is counted exactly once even though it was promoted mid-scan, after the durable scan already ran');
});
test('a promotion completing between the durable and runtime scans is still listed exactly once by zfsmJobPage',async t=>{
 const s=await fixture(t);
 const file='/app/src/include/ZFSMJobs.php',text=s.php.readFileAsText(file),marker='// completed in between -- never counted from neither scan.';
 assert.ok(text.includes(marker));
 s.php.writeFile(file,text.replace(marker,marker+`
    if(!empty($GLOBALS['test_promote_mid_scan'])){$__midId=$GLOBALS['test_promote_mid_scan'];$GLOBALS['test_promote_mid_scan']=null;zfsmJobAtomicWrite(zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$__midId.'.json',zfsmReadJob($__midId));}`));
 const r=await s.run({code:prelude+`
 $queued=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);$id=$queued['job']['id'];
 $GLOBALS['test_promote_mid_scan']=$id;
 $page=zfsmJobPage(1,200);
 $matches=array_values(array_filter($page['jobs'],fn($j)=>$j['id']===$id));
 echo json_encode(['count'=>count($matches),'durable'=>is_file(zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$id.'.json'),'group'=>$matches[0]['group']??null]);`});
 assert.equal(r.errors,'',r.text);const out=JSON.parse(r.text.slice(r.text.indexOf('{')));
 assert.deepEqual(out,{count:1,durable:true,group:'active'},'the job is listed exactly once even though it was promoted mid-scan, after the durable scan already ran');
});
test('the Running now bar links to Jobs only for a manual policy run, not for a scheduled check',async t=>{
 const s=await fixture(t);
 const r=await s.run({code:prelude+`
 $manual=runJob(true);$seenManual=$GLOBALS['lock_owner_seen'];$scheduled=runJob(false);$seenScheduled=$GLOBALS['lock_owner_seen'];
 echo json_encode(['manual'=>[$seenManual['label'],$seenManual['job']===$manual],'scheduled'=>[$seenScheduled['label'],$seenScheduled['job']]]);`});
 assert.equal(r.errors,'',r.text);
 assert.deepEqual(JSON.parse(r.text.slice(r.text.indexOf('{'))),{manual:['Snapshot policy',true],scheduled:['Snapshot policy',null]});
});
