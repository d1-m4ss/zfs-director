import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startIntegration} from './integration/server.mjs';
// A scheduled policy check that created and removed nothing leaves no journal file and no audit entry;
// a manual run, and any scheduled run that failed, stay recorded.
async function fixture(t){
 const s=await startIntegration({protection:true});t.after(()=>s.close());
 const file='/acceptance/system.php',text=s.php.readFileAsText(file),marker='function integrationProcess($command,$args,$stdin=null) {';assert.ok(text.includes(marker));
 s.php.writeFile(file,text.replace(marker,marker+`
 if($command==='/usr/sbin/sanoid'&&in_array('--take-snapshots',$args,true)&&!in_array('--readonly',$args,true))return ['code'=>$GLOBALS['fake_sanoid_code']??0,'output'=>'SYNTHETIC nothing due'];
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
