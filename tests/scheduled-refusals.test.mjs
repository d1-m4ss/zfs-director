import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startIntegration} from './integration/server.mjs';
// A scheduled launch refused before anything runs repeats every minute until the cause is
// fixed. It must leave one record, not one per minute (3104 identical failures were reported).
const prelude=`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
$p=zfsmSanoidPolicy(['id'=>'abc','dataset'=>'cache/__mock__/project','autosnap'=>false,'autoprune'=>false]);$p['source_guid']=zfsmReadIdentity($p['dataset'])['guid'];$store=zfsmProtectionReadStore();$store['policies']['abc']=$p;zfsmProtectionWriteStore($store);
function integration($on){$cfg=$GLOBALS['plugin_config'];file_put_contents($cfg,str_replace($on?'sanoid_integration = "0"':'sanoid_integration = "1"',$on?'sanoid_integration = "1"':'sanoid_integration = "0"',file_get_contents($cfg)));}
function journals(){return array_values(array_filter(glob(zfsmJobDirectory($GLOBALS['plugin_state']).'/*.json'),fn($f)=>preg_match('/[0-9]{8}-[0-9]{6}-[a-f0-9]{12}\\.json$/',$f)));}
function refusals(){return count(array_filter(zfsmAuditList(500),fn($row)=>($row['command']??'')==='protectionscheduled'&&($row['status']??'')==='failed'));}
`;
async function run(t,code){
 const s=await startIntegration({protection:true});t.after(()=>s.close());
 const r=await s.run({code:prelude+code});assert.equal(r.errors,'',r.text);return JSON.parse(r.text.slice(r.text.indexOf('{')));
}
test('identical scheduled refusals leave one record and one audit row; the repeats are counted',async t=>{
 const out=await run(t,`integration(false);$ids=[];for($i=0;$i<5;$i++){$q=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);$ids[]=$q['job']['id'];$failed[]=count($q['failed']);}
 $page=zfsmJobPage(1,50,['filter'=>'all']);$listed=array_values(array_filter($page['jobs'],fn($j)=>$j['id']===$ids[0]));
 echo json_encode(['distinct'=>count(array_unique($ids)),'failed'=>$failed,'journals'=>count(journals()),'audits'=>refusals(),'repeats'=>$listed[0]['repeats']['count']??null,'error'=>$listed[0]['error']??null,'listed'=>count($page['jobs'])]);`);
 assert.equal(out.distinct,1,'every repeat points at the first record');
 assert.deepEqual(out.failed,[1,1,1,1,1],'the dispatcher still sees each launch as refused');
 assert.equal(out.journals,1);assert.equal(out.audits,1);assert.equal(out.listed,1);
 assert.equal(out.repeats,4);assert.match(out.error,/integration is disabled/);
});
test('a launch that passes the checks resets the count; a later refusal is recorded again',async t=>{
 const out=await run(t,`integration(false);$first=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false)['job']['id'];zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);
 integration(true);$ok=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);zfsmProtectionCancel($ok['job']['id']);$marker=is_file(zfsmProtectionBlockedFile('policy','abc'));
 integration(false);$again=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false)['job']['id'];
 echo json_encode(['marker_after_success'=>$marker,'new_record'=>$again!==$first,'audits'=>refusals()]);`);
 assert.deepEqual(out,{marker_after_success:false,new_record:true,audits:2});
});
test('a different refusal reason is recorded separately',async t=>{
 const out=await run(t,`integration(false);$a=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false)['job']['id'];
 $m=json_decode(file_get_contents(zfsmProtectionBlockedFile('policy','abc')),true);$m['reason']='An older, different reason.';file_put_contents(zfsmProtectionBlockedFile('policy','abc'),json_encode($m));
 $b=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false)['job']['id'];echo json_encode(['separate'=>$a!==$b,'journals'=>count(journals())]);`);
 assert.deepEqual(out,{separate:true,journals:2});
});
test('history cleanup keeps only the newest of each run of identical refusals left by older versions',async t=>{
 const out=await run(t,`$abc=zfsmProtectionReadStore()['policies']['abc'];$make=function($minute,$reason,$started=false){$j=zfsmNewProtectionJob('policy',$GLOBALS['abc']);$j['id']=sprintf('20261113-21%02d00-%012x',$minute,$minute);$j['created']=$j['updated']=gmdate('c',1794600000+$minute*60);$j['trigger']='schedule';if($started)$j['started_at']=$j['created'];zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);zfsmProtectionFinish($j['id'],['outcome'=>'blocked','reason'=>$reason,'exit_code'=>null]);return $j['id'];};$GLOBALS['abc']=$abc;
 $old=[];for($i=0;$i<40;$i++)$old[]=$make($i,'Both trusted Sanoid and Syncoid executables are required.');
 $other=[$make(45,'Sanoid / Syncoid integration is disabled; managed execution is blocked.'),$make(46,'Sanoid / Syncoid integration is disabled; managed execution is blocked.')];
 $ran=$make(50,'Both trusted Sanoid and Syncoid executables are required.',true);
 $r=zfsmJobHistoryCleanup(1794600000+4000);$left=array_map(fn($f)=>basename($f,'.json'),journals());
 echo json_encode(['removed'=>$r['duplicates_removed']??0,'blocked'=>$r['blocked'],'newest_kept'=>in_array(end($old),$left,true),'oldest_gone'=>!in_array($old[0],$left,true),'other_kept'=>in_array($other[1],$left,true),'other_dup_gone'=>!in_array($other[0],$left,true),'ran_kept'=>in_array($ran,$left,true)]);`);
 assert.deepEqual(out,{removed:40,blocked:false,newest_kept:true,oldest_gone:true,other_kept:true,other_dup_gone:true,ran_kept:true},'39 + 1 duplicates removed; the newest of each reason and a run that started stay');
});
test('Delete finished jobs removes finished records and keeps running, held and recovery ones',async t=>{
 const out=await run(t,`$abc=zfsmProtectionReadStore()['policies']['abc'];$make=function($n,$state,$extra=[]){$j=zfsmNewProtectionJob('policy',$GLOBALS['abc']);$j['id']=sprintf('20261113-2100%02d-%012x',$n,$n);$j['state']=$state;$j['stage']=$state==='queued'?'queued':'finished';$j['verified_outcome']=$state==='failed'?'failed':($state==='completed'?'completed':$state);$j=$extra+$j;zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);return $j['id'];};$GLOBALS['abc']=$abc;
 $done=$make(1,'completed');$failed=$make(2,'failed');$queued=$make(3,'queued');$recovery=$make(4,'recovery_required');$held=$make(5,'completed',['hold_owned'=>true]);
 $hidden=zfsmActivitySetJobs([$failed],true);$page=zfsmJobPage(1,50,['filter'=>'all']);$counts=$page['counts'];
 $r=zfsmJobDeleteFinished();$left=array_map(fn($f)=>basename($f,'.json'),journals());sort($left);
 echo json_encode(['failed_hidden'=>isset($hidden['succeeded'][$failed]),'attention_after_hide'=>$counts['needs_attention'],'deleted'=>$r['deleted'],'kept'=>$r['kept'],'left'=>$left,'expected'=>[$queued,$recovery,$held],'message'=>$r['succeeded']['jobs']]);`);
 assert.equal(out.failed_hidden,true,'a failed job can be hidden');
 assert.equal(out.attention_after_hide,2,'a hidden failure no longer counts; the recovery and the held job still do');
 assert.equal(out.deleted,2);assert.deepEqual(out.left,out.expected.sort());
 assert.deepEqual(out.kept,{'needs recovery':1,running:1,'still holds a snapshot or ZIP':1});
 assert.match(out.message,/^Deleted 2 finished job record\(s\)\. Kept 3:/);
});
