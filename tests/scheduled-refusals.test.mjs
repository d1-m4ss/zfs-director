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
 $old=[];for($i=11;$i<51;$i++)$old[]=$make($i,'Both trusted Sanoid and Syncoid executables are required.');
 $other=[$make(55,'Sanoid / Syncoid integration is disabled; managed execution is blocked.'),$make(56,'Sanoid / Syncoid integration is disabled; managed execution is blocked.')];
 $ran=$make(10,'Both trusted Sanoid and Syncoid executables are required.',true);
 $r=zfsmJobHistoryCleanup(1794600000+4000);$left=array_map(fn($f)=>basename($f,'.json'),journals());
 echo json_encode(['removed'=>$r['duplicates_removed']??0,'blocked'=>$r['blocked'],'newest_kept'=>in_array(end($old),$left,true),'oldest_gone'=>!in_array($old[0],$left,true),'other_kept'=>in_array($other[1],$left,true),'other_dup_gone'=>!in_array($other[0],$left,true),'ran_kept'=>in_array($ran,$left,true)]);`);
 assert.deepEqual(out,{removed:40,blocked:false,newest_kept:true,oldest_gone:true,other_kept:true,other_dup_gone:true,ran_kept:true},'39 + 1 duplicates removed; the newest of each reason and a run that started stay');
});
test('a refusal the user hid does not mute the next refusal',async t=>{
 const out=await run(t,`integration(false);$first=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false)['job']['id'];zfsmActivitySetJobs([$first],true);
 $second=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false)['job']['id'];$page=zfsmJobPage(1,50,['filter'=>'all']);
 echo json_encode(['new_record'=>$second!==$first,'visible_attention'=>$page['counts']['needs_attention']]);`);
 assert.deepEqual(out,{new_record:true,visible_attention:2});
});
test('Delete finished jobs keeps data owners, latest results and running work; deletes the rest',async t=>{
 const out=await run(t,`$abc=zfsmProtectionReadStore()['policies']['abc'];$GLOBALS['abc']=$abc;$n=0;
 $prot=function($state,$minute,$extra=[])use(&$n){$j=zfsmNewProtectionJob('policy',$GLOBALS['abc']);$j['id']=sprintf('20261113-21%02d00-%012x',$minute,$minute);$j['created']=$j['updated']=gmdate('c',1794600000+$minute*60);$j['state']=$state;$j['stage']=$state==='queued'?'queued':'finished';$j['verified_outcome']=$state==='completed'?'completed':($state==='queued'?'queued':'failed');$j['verification']=['outcome'=>$j['verified_outcome']];$j=$extra+$j;zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);return $j['id'];};
 $conv=function($state,$stage,$minute){$id=sprintf('20261113-22%02d00-%012x',$minute,$minute);$j=['schema'=>1,'id'=>$id,'state'=>$state,'stage'=>$stage,'source'=>'/mnt/cache/x','dataset'=>'cache/x','owner_dataset'=>'cache','owner_guid'=>'123','owner_mountpoint'=>'/mnt/cache','pool'=>'cache','source_identity'=>['dev'=>'1','ino'=>'2'],'recovery'=>'/mnt/cache/x_zfsm_recovery_'.$id];zfsmJobAtomicWrite(zfsmJobFile($id),$j);return $id;};
 $oldFail=$prot('failed',1);$oldDone=$prot('completed',2);$queued=$prot('queued',3);$held=$prot('completed',4,['hold_owned'=>true]);$latest=$prot('failed',9);
 $cancelledConversion=$conv('cancelled','copying',1);$failedConversion=$conv('failed','copying',2);$doneConversion=$conv('completed','complete_source_retained',3);
 $hidden=zfsmActivitySetJobs([$oldFail],true);
 $r=zfsmJobDeleteFinished();$left=array_map(fn($f)=>basename($f,'.json'),journals());sort($left);
 echo json_encode(['hidden'=>isset($hidden['succeeded'][$oldFail]),'deleted'=>$r['deleted'],'kept'=>$r['kept'],'left'=>$left,'expected_left'=>[$queued,$held,$latest,$cancelledConversion,$failedConversion],'deleted_ids'=>array_values(array_diff([$oldFail,$oldDone,$doneConversion],$left)),'message'=>$r['succeeded']['jobs']]);`);
 assert.equal(out.hidden,true,'a failed job can be hidden');
 assert.equal(out.deleted,3,'old failed and old completed protection jobs and the completed conversion');
 assert.deepEqual(out.left,out.expected_left.sort(),'running, held, the latest result and unfinished conversions stay');
 assert.deepEqual(out.kept,{'latest result of a policy or replication':1,'may own recovery data':2,running:1,'still holds a snapshot or ZIP':1});
 assert.match(out.message,/^Deleted 3 finished job record\(s\)\. Kept 5:/);
});
test('Delete finished jobs removes every matching record in one call, on every page; Everything ignores the filters',async t=>{
 const out=await run(t,`$abc=zfsmProtectionReadStore()['policies']['abc'];$GLOBALS['abc']=$abc;
 $make=function($i,$state){$j=zfsmNewProtectionJob('policy',$GLOBALS['abc']);$j['id']=sprintf('20261113-%06d-%012x',$i,$i);$j['created']=$j['updated']=gmdate('c',1794000000+$i);$j['state']=$state;$j['stage']='finished';$j['verified_outcome']=$state==='completed'?'completed':'failed';$j['verification']=['outcome'=>$j['verified_outcome']];zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);return $j['id'];};
 for($i=1;$i<=300;$i++)$make($i,'failed');for($i=301;$i<=330;$i++)$make($i,'completed');
 $filter=zfsmJobPage(1,1,['filter'=>'completed','type'=>'all','view'=>'all','ids_only'=>true]);
 $r1=zfsmJobDeleteFinished(array_fill_keys($filter['ids'],true));$after1=count(journals());
 $r2=zfsmJobDeleteFinished();$after2=count(journals());
 echo json_encode(['matching'=>count($filter['ids']),'deleted_first'=>$r1['deleted'],'left_first'=>$after1,'deleted_second'=>$r2['deleted'],'left_second'=>$after2,'kept'=>$r2['kept']]);`);
 assert.equal(out.matching,30,'the filter selects the completed group across pages');
 assert.equal(out.deleted_first+out.left_first,330,'nothing else was touched');
 assert.equal(out.left_first,300+1-out.deleted_first+29,'only matching records go; the newest policy result stays pinned');
 assert.equal(out.left_second,1,'one call removes the rest; only the latest result of the policy stays');
 assert.deepEqual(out.kept,{'latest result of a policy or replication':1});
});
test('Jobs lists only functional work: replication runs and manual policy runs, not scheduled policy checks or quick-action journals',async t=>{
 const out=await run(t,`$abc=zfsmProtectionReadStore()['policies']['abc'];$GLOBALS['abc']=$abc;
 $policy=function($n,$trigger){$j=zfsmNewProtectionJob('policy',$GLOBALS['abc']);$j['id']=sprintf('20261114-10%02d00-%012x',$n,$n);$j['trigger']=$trigger;$j['state']='completed';$j['stage']='finished';$j['verified_outcome']='completed';$j['verification']=['outcome'=>'completed'];zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);return $j['id'];};
 $manual=$policy(1,'manual');$scheduled=$policy(2,'schedule');
 $failedQuick=zfsmRequestJobBegin('snapshotdataset',['cmd'=>'snapshotdataset']);zfsmRequestJobFinish('failed','Quick action failed.');
 $listed=array_column(zfsmJobPage(1,50,['filter'=>'all','listed'=>true])['jobs'],'id');$all=array_column(zfsmJobPage(1,50,['filter'=>'all','listed'=>false])['jobs'],'id');
 echo json_encode(['manual'=>in_array($manual,$listed,true),'scheduled'=>in_array($scheduled,$listed,true),'listed_count'=>count($listed),'all_count'=>count($all)]);`);
 assert.deepEqual(out,{manual:true,scheduled:false,listed_count:1,all_count:3},'a manual run is listed; a scheduled policy check and a failed quick action are not');
});
