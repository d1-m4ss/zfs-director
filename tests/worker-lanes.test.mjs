import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startIntegration} from './integration/server.mjs';
// REL-001: jobs are split into worker lanes, and a queued files job waits while a running
// protection job owns an overlapping dataset scope.
const prelude=`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
function running($source,$target,$mode='local'){$input=['source'=>$source,'target'=>$target,'source_guid'=>'77002','mode'=>$mode,'resume'=>false,'compression'=>'none'];if($mode==='remote')$input+=['host'=>'backup.example','credential'=>'key'];$d=zfsmSyncoidJob($input);$job=zfsmNewProtectionJob('replication',$d);$job['state']='running';$job['stage']='transferring';zfsmJobAtomicWrite(zfsmJobFile($job['id']),$job);if(zfsmJobProblem(zfsmReadJob($job['id'])))throw new RuntimeException('fixture job is invalid');return $job['id'];}
`;
async function run(t,code){
 const s=await startIntegration({protection:true});t.after(()=>s.close());
 const r=await s.run({code:prelude+code});assert.equal(r.errors,'',r.text);return JSON.parse(r.text.slice(r.text.indexOf('{')));
}
test('every job belongs to exactly one lane and each lane has its own worker lock',async t=>{
 const out=await run(t,`echo json_encode([
  'lanes'=>zfsmWorkerLanes(),
  'policy'=>zfsmJobLane(['schema'=>4,'type'=>'policy']),'replication'=>zfsmJobLane(['schema'=>4,'type'=>'replication']),
  'conversion'=>zfsmJobLane(['schema'=>1,'type'=>'conversion']),'restore'=>zfsmJobLane(['schema'=>2,'type'=>'restore']),'deletion'=>zfsmJobLane(['schema'=>6]),'request'=>zfsmJobLane(['schema'=>7]),
  'locks'=>array_map('basename',array_map('zfsmWorkerLaneLock',zfsmWorkerLanes())),'files_lock_is_legacy'=>zfsmWorkerLaneLock('files')===$GLOBALS['plugin_worker_lock']]);`);
 assert.deepEqual(out.lanes,['files','policy','replication']);
 assert.deepEqual([out.policy,out.replication,out.conversion,out.restore,out.deletion,out.request],['policy','replication','files','files','files','files']);
 assert.equal(new Set(out.locks).size,3,'lanes must not share a worker lock');
 assert.equal(out.files_lock_is_legacy,true,'the files lane keeps the installed worker lock path');
});
test('a queued conversion, restore or deletion waits while a replication owns its scope',async t=>{
 const out=await run(t,`$id=running('cache/__mock__/project','cache/__mock__/backup');
 $conflict=fn($job)=>zfsmProtectionJobConflict($job);
 echo json_encode(['id'=>$id,
  'conversion_inside_source'=>$conflict(['schema'=>1,'dataset'=>'cache/__mock__/project/new','owner_dataset'=>'cache/__mock__/project']),
  'conversion_elsewhere'=>$conflict(['schema'=>1,'dataset'=>'cache/__mock__/other/new','owner_dataset'=>'cache/__mock__/other']),
  'restore_into_target'=>$conflict(['schema'=>2,'type'=>'restore','dataset'=>'cache/__mock__/backup']),
  'restore_parent'=>$conflict(['schema'=>2,'type'=>'restore','dataset'=>'cache/__mock__']),
  'archive_reads_only'=>$conflict(['schema'=>2,'type'=>'archive','dataset'=>'cache/__mock__/project']),
  'delete_dataset'=>$conflict(['schema'=>6,'kind'=>'dataset','source'=>'cache/__mock__/backup/child']),
  'delete_directory'=>$conflict(['schema'=>6,'kind'=>'directory','owner_dataset'=>'cache/__mock__/project','source'=>'/mnt/cache/project/a'])]);`);
 assert.equal(out.conversion_inside_source,out.id);
 assert.equal(out.conversion_elsewhere,null,'unrelated datasets run at once');
 assert.equal(out.restore_into_target,out.id);
 assert.equal(out.restore_parent,out.id,'a parent dataset overlaps the running scope');
 assert.equal(out.archive_reads_only,null,'a ZIP only reads a snapshot');
 assert.equal(out.delete_dataset,out.id);
 assert.equal(out.delete_directory,out.id);
});
test('a remote replication only owns its local source',async t=>{
 const out=await run(t,`$id=running('cache/__mock__/project','tank/remote/copy','remote');
 echo json_encode(['id'=>$id,'source'=>zfsmProtectionJobConflict(['schema'=>2,'type'=>'restore','dataset'=>'cache/__mock__/project']),'remote_name'=>zfsmProtectionJobConflict(['schema'=>2,'type'=>'restore','dataset'=>'tank/remote/copy'])]);`);
 assert.equal(out.source,out.id);
 assert.equal(out.remote_name,null,'a remote target name does not lock a local dataset');
});
test('PERF-001: the worker queue scan rereads only changed journals',async t=>{
 const out=await run(t,`$GLOBALS['zfsm_job_read_cache']=true;
 $a=running('cache/__mock__/project','cache/__mock__/backup');$b=running('cache/__mock__/other','cache/__mock__/backup2');
 $reads=fn()=>$GLOBALS['zfsm_job_cache_reads']??0;
 zfsmPendingJobs();$first=$reads();zfsmPendingJobs();$idle=$reads()-$first;
 $job=zfsmReadJob($a);$job['state']='queued';zfsmJobAtomicWrite(zfsmJobFile($a),$job);
 $before=$reads();$pending=zfsmPendingJobs();$changed=$reads()-$before;
 $states=[];foreach($pending as$j)$states[$j['id']]=$j['state'];
 unset($GLOBALS['zfsm_job_read_cache']);$before=$reads();zfsmPendingJobs();$uncached=$reads()-$before;
 echo json_encode(['first'=>$first,'idle'=>$idle,'changed'=>$changed,'a'=>$states[$a]??null,'b'=>$states[$b]??null,'uncached_counter'=>$uncached]);`);
 assert.equal(out.first,2,'the first scan reads every journal');
 assert.equal(out.idle,0,'an idle scan reads no journal');
 assert.equal(out.changed,1,'only the rewritten journal is read again');
 assert.equal(out.a,'queued','the rewritten state is seen in the same scan');
 assert.equal(out.b,'running');
 assert.equal(out.uncached_counter,0,'request handlers bypass the cache');
});
