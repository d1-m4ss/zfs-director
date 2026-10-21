import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startIntegration} from './integration/server.mjs';
const started='Tue Oct 20 12:00:00 2026',running='scrub in progress since '+started+'\n    100 / 1000 scanned, 100 / 1000 issued\n    0B repaired, 10.00% done, 00:00:10 to go';
async function fixture(fn){const s=await startIntegration();try{const file='/app/src/include/ZFSMScrub.php';s.php.writeFile(file,s.php.readFileAsText(file).replace("'scan_requested_from'=>time()","'scan_requested_from'=>1792497600").replace("'scan_requested_until'=>time()","'scan_requested_until'=>1792497600"));const post=async fields=>(await fetch(s.url+'/plugins/zfs.master.ui/backend/ZFSMAdmin.php',{method:'POST',body:new URLSearchParams({csrf_token:'integration-token',...fields})})).json();const scan=text=>{const m=s.readModel();m.status=m.status.replace(/scan: [\s\S]*?\nconfig:/,'scan: '+text+'\nconfig:');s.writeModel(m);};const observe=async id=>{const r=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';zfsmJobUpdate('${id}',['observed_at'=>0]);echo json_encode(zfsmObserveRequestJob('${id}'));`});assert.equal(r.errors,'');return JSON.parse(r.text);};await fn({s,post,scan,observe});}finally{await s.close();}}
test('scrub start remains in Jobs until native completion; observer reads progress without reissuing scrub',async()=>fixture(async({s,post,scan,observe})=>{
 const a=await post({cmd:'scrubpool',pool:'cache',confirmed:'1'});assert.equal(a.job?.state,'running');assert.equal(a.job.type,'maintenance');assert.equal(a.job.stage,'awaiting_scan');assert.match(a.job.pool_guid,/^[1-9][0-9]*$/);assert.equal(s.readModel().scrub_requests,1);
 scan(running);const live=await observe(a.job.id);assert.equal(live.state,'running');assert.equal(live.stage,'scrubbing');assert.equal(live.progress.percent,10);assert.equal(live.scan_started,started);
 scan('scrub paused since '+started);assert.equal((await observe(a.job.id)).stage,'scrub_paused');
 scan('scrub repaired 0B in 00:00:20 with 0 errors on Tue Oct 20 12:00:20 2026');const end=await observe(a.job.id);assert.equal(end.state,'completed');assert.equal(end.progress.percent,100);assert.match(end.result.summary,/0 errors/);assert.equal(s.readModel().scrub_requests,1);
 const before=s.readModel().calls.length;await observe(a.job.id);assert.equal(s.readModel().calls.length,before);
}));
test('scrub observer refuses pool replacement, scan replacement and reboot; never resumes or starts a scan',async()=>{
 for(const change of ['pool','scan','boot'])await fixture(async({s,post,scan,observe})=>{
  const a=await post({cmd:'scrubpool',pool:'cache',confirmed:'1'});scan(running);await observe(a.job.id);
  if(change==='pool'){const m=s.readModel();m.pool_guid='999';s.writeModel(m);}else if(change==='scan')scan(running.replace(started,'Tue Oct 20 13:00:00 2026'));else s.php.writeFile('/proc/sys/kernel/random/boot_id','different-test-boot');
  const j=await observe(a.job.id);assert.equal(j.state,'recovery_required',change);assert.equal(s.readModel().scrub_requests,1);
 });
});
test('old terminal status cannot complete newly requested scrub and unreadable native status requires inspection',async()=>fixture(async({s,post,scan,observe})=>{
 scan('scrub repaired 0B in 00:00:20 with 0 errors on Mon Oct 19 12:00:20 2026');const a=await post({cmd:'scrubpool',pool:'cache',confirmed:'1'});assert.equal((await observe(a.job.id)).state,'running');
 const m=s.readModel();m.fail_command='zpool status -p cache';s.writeModel(m);const j=await observe(a.job.id);assert.equal(j.state,'recovery_required');assert.notEqual(j.progress?.percent,100);assert.equal(s.readModel().scrub_requests,1);
}));
test('a different terminal scrub within an observation gap is never attributed to the recorded start',async()=>fixture(async({post,scan,observe})=>{
 const a=await post({cmd:'scrubpool',pool:'cache',confirmed:'1'});scan(running);await observe(a.job.id);
 scan('scrub repaired 0B in 00:00:03 with 0 errors on Tue Oct 20 12:00:20 2026');const j=await observe(a.job.id);assert.equal(j.state,'recovery_required');assert.notEqual(j.progress?.percent,100);
}));
test('scrub journal retains audit correlation when the HTTP request detaches',async()=>fixture(async({post})=>{
 const a=await post({cmd:'scrubpool',pool:'cache',confirmed:'1'});assert.match(a.job?.audit_id,/^[a-f0-9]{32}$/);const history=(await post({cmd:'auditlog'})).entries;assert.ok(history.some(e=>e.operation_id===a.job.audit_id&&e.phase==='outcome'));
}));
test('cancel status without matching start evidence requires inspection rather than claiming this scrub was cancelled',async()=>fixture(async({post,scan,observe})=>{
 const a=await post({cmd:'scrubpool',pool:'cache',confirmed:'1'});scan(running);await observe(a.job.id);scan('scrub canceled on Tue Oct 20 12:00:20 2026');assert.equal((await observe(a.job.id)).state,'recovery_required');
}));

test('first observed replacement scan outside dispatch window cannot be adopted',async()=>fixture(async({post,scan,observe})=>{
 const a=await post({cmd:'scrubpool',pool:'cache',confirmed:'1'});scan(running.replace(started,'Tue Oct 20 13:00:00 2026'));assert.equal((await observe(a.job.id)).state,'recovery_required');
}));
test('native scrub success followed by a transient journal fault requires inspection, never replay',async()=>fixture(async({s,post})=>{
 const file='/app/src/include/ZFSMJobs.php';s.php.writeFile(file,s.php.readFileAsText(file).replace('function zfsmJobAtomicWrite($file,$data) {',"function zfsmJobAtomicWrite($file,$data) { if(($data['schema']??null)===7&&($data['stage']??null)==='awaiting_scan'&&empty($GLOBALS['one_scan_fault'])){$GLOBALS['one_scan_fault']=true;throw new RuntimeException('Synthetic journal failure after native start');}"));const a=await post({cmd:'scrubpool',pool:'cache',confirmed:'1'});assert.equal(s.readModel().scrub_requests,1);assert.equal(a.job?.state,'recovery_required');
}));
test('scrub read budgets restore the caller deadline and never time-limit the native mutator',async()=>fixture(async({s,post,scan,observe})=>{
 const file='/acceptance/system.php';s.php.writeFile(file,s.php.readFileAsText(file).replace("$call=['command'=>$command,'args'=>$args,'stdin_present'=>$stdin!==null];","$call=['command'=>$command,'args'=>$args,'stdin_present'=>$stdin!==null,'deadline'=>$GLOBALS['zfsm_inventory_deadline']??null];"));const a=await post({cmd:'scrubpool',pool:'cache',confirmed:'1'});scan(running);await observe(a.job.id);const calls=s.readModel().calls;assert.equal(calls.find(c=>c.command==='zpool'&&c.args[0]==='scrub').deadline,null);for(const c of calls.filter(c=>c.command==='zpool'&&['get','status'].includes(c.args[0])))assert.equal(typeof c.deadline,'number');
 const r=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';$GLOBALS['zfsm_inventory_deadline']=microtime(true)+2; $saved=$GLOBALS['zfsm_inventory_deadline'];zfsmJobUpdate('${a.job.id}',['observed_at'=>0]);zfsmObserveRequestJob('${a.job.id}');echo $saved===$GLOBALS['zfsm_inventory_deadline']?'preserved':'changed';`});assert.equal(r.text,'preserved');
}));
