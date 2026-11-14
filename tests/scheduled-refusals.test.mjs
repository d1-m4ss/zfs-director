import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startIntegration} from './integration/server.mjs';
// A scheduled launch refused before anything runs repeats every minute until the cause is
// fixed. It must leave one record, not one per minute (3104 identical failures were reported).
const prelude=`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
$p=zfsmSanoidPolicy(['id'=>'abc','dataset'=>'cache/__mock__/project','autosnap'=>false,'autoprune'=>false]);$p['source_guid']=zfsmReadIdentity($p['dataset'])['guid'];$store=zfsmProtectionReadStore();$store['policies']['abc']=$p;zfsmProtectionWriteStore($store);
function integration($on){$cfg=$GLOBALS['plugin_config'];file_put_contents($cfg,str_replace($on?'sanoid_integration = "0"':'sanoid_integration = "1"',$on?'sanoid_integration = "1"':'sanoid_integration = "0"',file_get_contents($cfg)));}
function hide($id){zfsmJobAtomicWrite(zfsmActivityDirectory('jobs').'/'.$id.'.marker',['version'=>1,'id'=>$id,'archived'=>true]);}
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
 const out=await run(t,`integration(false);$first=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false)['job']['id'];hide($first);
 $second=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false)['job']['id'];$page=zfsmJobPage(1,50,['filter'=>'all']);
 echo json_encode(['new_record'=>$second!==$first,'visible_attention'=>$page['counts']['needs_attention']]);`);
 assert.deepEqual(out,{new_record:true,visible_attention:2});
});
test('Delete finished jobs keeps data owners, holds and running work; deletes the rest and saves the newest policy result',async t=>{
 const out=await run(t,`$abc=zfsmProtectionReadStore()['policies']['abc'];$GLOBALS['abc']=$abc;$n=0;
 $prot=function($state,$minute,$extra=[])use(&$n){$j=zfsmNewProtectionJob('policy',$GLOBALS['abc']);$j['id']=sprintf('20261113-21%02d00-%012x',$minute,$minute);$j['created']=$j['updated']=gmdate('c',1794600000+$minute*60);$j['state']=$state;$j['stage']=$state==='queued'?'queued':'finished';$j['verified_outcome']=$state==='completed'?'completed':($state==='queued'?'queued':'failed');$j['verification']=['outcome'=>$j['verified_outcome']];$j=$extra+$j;zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);return $j['id'];};
 $conv=function($state,$stage,$minute){$id=sprintf('20261113-22%02d00-%012x',$minute,$minute);$j=['schema'=>1,'id'=>$id,'state'=>$state,'stage'=>$stage,'source'=>'/mnt/cache/x','dataset'=>'cache/x','owner_dataset'=>'cache','owner_guid'=>'123','owner_mountpoint'=>'/mnt/cache','pool'=>'cache','source_identity'=>['dev'=>'1','ino'=>'2'],'recovery'=>'/mnt/cache/x_zfsm_recovery_'.$id];zfsmJobAtomicWrite(zfsmJobFile($id),$j);return $id;};
 $oldFail=$prot('failed',1);$oldDone=$prot('completed',2);$queued=$prot('queued',3);$held=$prot('completed',4,['hold_owned'=>true]);$latest=$prot('failed',9);
 $cancelledConversion=$conv('cancelled','copying',1);$failedConversion=$conv('failed','copying',2);$doneConversion=$conv('completed','complete_source_retained',3);
 hide($oldFail);
 $r=zfsmJobDeleteFinished();$left=array_map(fn($f)=>basename($f,'.json'),journals());sort($left);
 echo json_encode(['deleted'=>$r['deleted'],'kept'=>$r['kept'],'left'=>$left,'expected_left'=>[$queued,$held,$cancelledConversion,$failedConversion],'deleted_ids'=>array_values(array_diff([$oldFail,$oldDone,$latest,$doneConversion],$left)),'saved'=>zfsmLastResults()['policy:abc']['id']??null,'latest'=>$latest,'message'=>$r['succeeded']['jobs']]);`);
 assert.equal(out.deleted,4,'failed and completed protection jobs (including the newest) and the completed conversion');
 assert.equal(out.saved,out.latest,'the newest policy result is saved before its journal goes');
 assert.deepEqual(out.left,out.expected_left.sort(),'running, held and unfinished conversions stay');
 assert.deepEqual(out.kept,{'may own recovery data':2,running:1,'still holds a snapshot or ZIP':1});
 assert.match(out.message,/^Deleted 4 finished job record\(s\)\. Kept 4:/);
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
 assert.equal(out.deleted_first,30);assert.equal(out.left_first,300,'only the 30 matching records go');
 assert.equal(out.left_second,0,'one call removes the rest, on every page');
 assert.deepEqual(out.kept,[],'nothing is kept back');
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
test('after Delete finished jobs the Policies screen and the replication warning still see the newest result',async t=>{
 const out=await run(t,`$abc=zfsmProtectionReadStore()['policies']['abc'];$GLOBALS['abc']=$abc;
 $make=function($minute,$state)use($abc){$j=zfsmNewProtectionJob('policy',$abc);$j['id']=sprintf('20261113-21%02d00-%012x',$minute,$minute);$j['created']=$j['updated']=gmdate('c',1794600000+$minute*60);$j['state']=$state;$j['stage']='finished';$j['verified_outcome']=$state==='completed'?'completed':'failed';$j['verification']=['outcome'=>$j['verified_outcome'],'reason'=>'Native transfer failed (exit 2).'];zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);return $j['id'];};
 $make(1,'completed');$newest=$make(2,'failed');
 $before=zfsmProtectionData();$lastBefore=array_values(array_filter($before['policies'],fn($p)=>$p['id']==='abc'))[0]['last_job']['id']??null;
 zfsmJobDeleteFinished();
 $after=zfsmProtectionData();$policy=array_values(array_filter($after['policies'],fn($p)=>$p['id']==='abc'))[0];
 $store=['replications'=>['r1'=>['enabled'=>true,'source'=>'cache/data','name'=>'Backup']]];
 $rep=zfsmLastResults();$remembered=['schema'=>4,'id'=>'20261113-210200-000000000009','type'=>'replication','definition_id'=>'r1','state'=>'failed','stage'=>'finished','verified_outcome'=>'failed','verification'=>['outcome'=>'failed','reason'=>'Native transfer failed (exit 2).'],'created'=>gmdate('c',1794600000),'updated'=>gmdate('c',1794600000)];
 zfsmLastResultRemember($remembered);
 echo json_encode(['journals'=>count(journals()),'before'=>$lastBefore===$newest,'last_job'=>$policy['last_job']['id']??null,'newest'=>$newest,'remembered_flag'=>$policy['last_job']['remembered']??false,'alerts'=>zfsmProtectionLagAlerts('cache',$store,zfsmJobsWithLastResults([]),24,1794600100)]);`);
 assert.equal(out.journals,0);assert.equal(out.before,true);
 assert.equal(out.last_job,out.newest,'the screen still shows the newest run of the policy');assert.equal(out.remembered_flag,true);
 assert.deepEqual(out.alerts,['Replication "Backup": last run not verified. Native transfer failed (exit 2).'],'a failed replication keeps warning after its journal is gone');
});
test('with Always the hourly cleanup deletes nothing but still folds repeated refusals',async t=>{
 const out=await run(t,`$cfg=$GLOBALS['plugin_config'];file_put_contents($cfg,'job_retention_days="0"'.PHP_EOL.file_get_contents($cfg));
 $abc=zfsmProtectionReadStore()['policies']['abc'];$GLOBALS['abc']=$abc;
 $make=function($minute,$reason)use($abc){$j=zfsmNewProtectionJob('policy',$abc);$j['id']=sprintf('20261113-21%02d00-%012x',$minute,$minute);$j['created']=$j['updated']=gmdate('c',1794600000+$minute*60);$j['trigger']='schedule';zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);zfsmProtectionFinish($j['id'],['outcome'=>'blocked','reason'=>$reason,'exit_code'=>null]);return $j['id'];};
 for($i=10;$i<40;$i++)$make($i,'Both trusted Sanoid and Syncoid executables are required.');
 $done=zfsmNewProtectionJob('policy',$abc);$done['id']='20260101-120000-00000000aaaa';$done['trigger']='manual';$done['state']='completed';$done['stage']='finished';$done['verified_outcome']='completed';$done['verification']=['outcome'=>'completed'];$done['created']=$done['updated']='2026-01-01T12:00:00Z';zfsmJobAtomicWrite(zfsmJobFile($done['id']),$done);
 $r=zfsmJobHistoryCleanup(1794600000+999999);echo json_encode(['retention'=>zfsmJobRetentionDays(),'blocked'=>$r['blocked'],'removed'=>$r['removed'],'left'=>count(journals()),'old_completed_kept'=>is_file(zfsmJobFile($done['id']))]);`);
 assert.deepEqual(out,{retention:0,blocked:false,removed:29,left:2,old_completed_kept:true},'29 repeated refusals folded; the newest refusal and the old finished job stay');
});
test('a journal that is too large to read safely does not stop the retention pass',async t=>{
 const out=await run(t,`$abc=zfsmProtectionReadStore()['policies']['abc'];$GLOBALS['abc']=$abc;
 foreach([1,2,3]as$n){$j=zfsmNewProtectionJob('policy',$abc);$j['id']=sprintf('20260101-12%02d00-%012x',$n,$n);$j['trigger']='manual';$j['state']='completed';$j['stage']='finished';$j['verified_outcome']='completed';$j['verification']=['outcome'=>'completed'];$j['created']=$j['updated']='2026-01-01T12:00:00Z';zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);}
 $big=zfsmJobFile('20260101-130000-0000000000ff');file_put_contents($big,json_encode(['pad'=>str_repeat('x',140000)]));
 $r=zfsmJobHistoryCleanup(1794600000+999999);echo json_encode(['blocked'=>$r['blocked'],'removed'=>$r['removed'],'protected'=>$r['protected'],'big_kept'=>is_file($big),'left'=>count(journals())]);`);
 assert.deepEqual(out,{blocked:false,removed:3,protected:1,big_kept:true,left:1});
});
test('Delete keeps deletion journals that own recovery data, saves the newest verified replication result, and refuses when the protection store is unreadable',async t=>{
 const out=await run(t,`$def=['id'=>'a1','owner'=>'managed','source'=>'cache/test','source_guid'=>'123','target'=>'backup/test'];
 $store=zfsmProtectionReadStore();$store['replications']['a1']=$def;zfsmProtectionWriteStore($store);
 $rep=function($n,$state,$verified)use($def){$j=['schema'=>4,'id'=>sprintf('20261113-23%02d00-%012x',$n,$n),'type'=>'replication','definition_id'=>'a1','definition'=>$def,'definition_hash'=>hash('sha256',json_encode($def,JSON_THROW_ON_ERROR)),'state'=>$state,'stage'=>'finished','verified_outcome'=>$state==='completed'?'completed':'failed','source'=>'cache/test','source_guid'=>'123','target'=>'backup/test','cancel_requested'=>false,'created'=>gmdate('c',1794600000+$n*60),'updated'=>gmdate('c',1794600000+$n*60),'verification'=>['outcome'=>$state==='completed'?'completed':'failed','verified'=>$verified,'checkpoints'=>[['guid'=>'7']]]];zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);return $j['id'];};
 $rep(1,'completed',false);$verifiedId=$rep(2,'completed',true);$newestId=$rep(3,'failed',false);
 $del=function($n,$state,$extra)use(&$del){$id=sprintf('20261113-24%02d00-%012x',$n,$n);$j=['schema'=>6,'type'=>'deletion','kind'=>'directory','id'=>$id,'source'=>'/mnt/cache/x','rejected'=>false,'recursive'=>true,'ack_boot'=>zfsmBootId(),'owner_guid'=>'123','owner_dataset'=>'cache','request'=>['op'=>'delete','recursive'=>true,'root'=>'/mnt/cache','path'=>'x','identity'=>['dev'=>'1','ino'=>'2'],'root_identity'=>['dev'=>'1','ino'=>'3']],'started_at'=>gmdate('c',1794600000+$n*60),'state'=>$state,'stage'=>$state==='recovery_required'?'interrupted':'verifying','created'=>gmdate('c',1794600000+$n*60),'updated'=>gmdate('c',1794600000+$n*60),'finished_at'=>gmdate('c',1794600000+$n*60),'error'=>'x']+$extra;zfsmJobAtomicWrite(zfsmJobFile($id),$j);return $id;};
 $withRecovery=$del(1,'failed',['recovery'=>'/mnt/cache/.zfsm-mutation-'.str_repeat('a',48)]);$interrupted=$del(2,'recovery_required',[]);$plain=$del(3,'failed',[]);
 $dir=zfsmProtectionDirectory();$config=$dir.'/config.json';$good=file_get_contents($config);file_put_contents($config,'{broken');
 $refused=false;try{zfsmJobDeleteFinished();}catch(Throwable$e){$refused=true;}$untouched=count(journals());file_put_contents($config,$good);
 $r=zfsmJobDeleteFinished();$left=array_map(fn($f)=>basename($f,'.json'),journals());sort($left);
 $latest=zfsmLastResults();$verified=zfsmLastResults(true);
 echo json_encode(['refused'=>$refused,'untouched'=>$untouched,'left'=>$left,'expected'=>[$withRecovery,$interrupted],'newest'=>$latest['replication:a1']['id']??null,'newest_id'=>$newestId,'verified'=>$verified['replication:a1']['id']??null,'verified_id'=>$verifiedId,'merged'=>count(zfsmJobsWithLastResults([]))]);`);
 assert.equal(out.refused,true,'an unreadable protection store stops the deletion');assert.equal(out.untouched,6);
 assert.deepEqual(out.left,out.expected.sort(),'a deletion that kept a recovery container or was interrupted stays; the others go');
 assert.equal(out.newest,out.newest_id);assert.equal(out.verified,out.verified_id,'the newest verified run is saved next to the newest run');assert.equal(out.merged,2);
});
test('Jobs hands the card the definition name and the destination, with user@host for a remote replication',async t=>{
 const out=await run(t,`$mk=function($n,$extra)use(&$mk){$def=['id'=>'a'.$n,'owner'=>'managed','name'=>'Immich '.$n,'source'=>'cache/test','source_guid'=>'123','target'=>'backup/test','mode'=>'local'];$def=array_replace($def,$extra);$j=['schema'=>4,'id'=>sprintf('20261113-25%02d00-%012x',$n,$n),'type'=>'replication','definition_id'=>$def['id'],'definition'=>$def,'definition_hash'=>hash('sha256',json_encode($def,JSON_THROW_ON_ERROR)),'state'=>'completed','stage'=>'finished','verified_outcome'=>'completed','source'=>'cache/test','source_guid'=>'123','target'=>'backup/test','cancel_requested'=>false,'trigger'=>'manual','created'=>gmdate('c',1794600000+$n),'updated'=>gmdate('c',1794600000+$n),'verification'=>['outcome'=>'completed','verified'=>true]];zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);return $j['id'];};
 $local=$mk(1,[]);$remote=$mk(2,['mode'=>'remote','user'=>'backup','host'=>'nas.lan']);
 $jobs=[];foreach(zfsmJobPage(1,50,['filter'=>'all','listed'=>true])['jobs']as$j)$jobs[$j['id']]=[$j['definition_name']??null,$j['destination']??null];
 echo json_encode(['local'=>$jobs[$local]??null,'remote'=>$jobs[$remote]??null]);`);
 assert.deepEqual(out,{local:['Immich 1','backup/test'],remote:['Immich 2','backup@nas.lan:backup/test']});
});
test('opening Jobs runs the retention pass, so an 8-day-old finished manual policy job is gone after one conversionjobs request',async t=>{
 const s=await startIntegration({protection:true});t.after(()=>s.close());
 const seeded=await s.run({code:prelude+`$old=time()-8*86400;$j=zfsmNewProtectionJob('policy',zfsmProtectionReadStore()['policies']['abc']);$j['id']=gmdate('Ymd-His',$old).'-0000000000a1';$j['trigger']='manual';$j['state']='completed';$j['stage']='finished';$j['verified_outcome']='completed';$j['verification']=['outcome'=>'completed'];$j['created']=$j['updated']=gmdate('c',$old);zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);echo json_encode(['id'=>$j['id'],'before'=>count(journals())]);`});
 assert.equal(seeded.errors,'',seeded.text);const seed=JSON.parse(seeded.text.slice(seeded.text.indexOf('{')));
 assert.equal(seed.before,1);
 const page=await fetch(s.url+'/plugins/zfs.master.ui/backend/ZFSMAdmin.php',{method:'POST',body:new URLSearchParams({csrf_token:'integration-token',cmd:'conversionjobs'})}).then(r=>r.json());
 assert.deepEqual(page.jobs,[],'the expired job is not listed');
 const after=await s.run({code:prelude+`echo json_encode(['left'=>count(journals()),'report'=>json_decode(file_get_contents($GLOBALS['plugin_runtime'].'/history-cleanup.json'),true)['removed']]);`});
 assert.deepEqual(JSON.parse(after.text.slice(after.text.indexOf('{'))),{left:0,report:1});
});
