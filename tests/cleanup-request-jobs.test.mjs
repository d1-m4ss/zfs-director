import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';
import {startIntegration} from './integration/server.mjs';

// WASM flock does not report an already held descriptor as contention. Simulate
// only that kernel observation; journal validation and opened-file identity stay real.
function leaseBoundary(php){const file='/app/src/include/ZFSMJobs.php';php.writeFile(file,php.readFileAsText(file).replace('function zfsmLockHeld($file) {',"function zfsmLockHeld($file) { if(str_contains($file,'/requests/'))return $GLOBALS['cleanup_test_lease_held']??true;"));}
const setup=`<?php require '/app/harness.php';$GLOBALS['plugin_state']='/cleanup-jobs';$GLOBALS['plugin_runtime']='/cleanup-runtime';$GLOBALS['zfsm_boot_id']='cleanup-boot';$target='/mnt/cache/.zfsm-mutation-'.str_repeat('a',48);
function allowedCleanup($target=null){try{zfsmCleanupRequireIdle($target);return true;}catch(Throwable$e){return false;}}
function saveCleanupJob($job){zfsmJobAtomicWrite(zfsmJobFile($job['id']),$job);return $job;}
function clearCleanupJobs(){foreach(glob($GLOBALS['plugin_state'].'/*.json')?:[]as$f)unlink($f);}
function conversionCleanupFixture(){return ['schema'=>1,'id'=>'20261020-120000-000000000001','type'=>'conversion','state'=>'completed','stage'=>'complete_source_retained','source'=>'/mnt/cache/SampleProject','source_identity'=>['dev'=>'1','ino'=>'2'],'recovery'=>'/mnt/cache/SampleProject_zfsm_recovery_20261020-120000-000000000001','dataset'=>'cache/SampleProject','owner_dataset'=>'cache','owner_guid'=>'123','owner_mountpoint'=>'/mnt/cache','pool'=>'cache'];}
function requestCleanupFixture($state='completed',$stage='completed'){return ['schema'=>7,'id'=>'20261020-120000-000000000007','type'=>'operation','command'=>'snapshotdataset','label'=>'Create snapshots','source'=>'cache/data','state'=>$state,'stage'=>$stage,'owner_boot'=>'cleanup-boot'];}
function deletionCleanupFixture($rejected=false){$j=['schema'=>6,'id'=>'20261020-120000-000000000006','type'=>'deletion','kind'=>'dataset','source'=>'cache/delete','rejected'=>$rejected,'state'=>$rejected?'failed':'completed','stage'=>$rejected?'preflight_rejected':'completed'];if(!$rejected)$j+=['ack_boot'=>'cleanup-boot','owner_guid'=>'123','recursive'=>false,'scope'=>['target'=>'cache/delete','recursive'=>false,'can_destroy'=>true,'objects'=>[['name'=>'cache/delete','guid'=>'123']],'dependencies'=>[]],'result'=>['state_verified'=>true]];return $j;}
`;

test('only the exact owned cleanup request with a matching live lease is exempt from idle blocking',async()=>{
 const php=await runtime();leaseBoundary(php);try{const r=await php.run({code:setup+`
 $j=zfsmRequestJobBegin('cleanupmutation',['directory'=>$target]);$tracking=$GLOBALS['zfsm_request_job'];$out=['own'=>allowedCleanup($target),'other_target'=>allowedCleanup($target.'-other')];
 $GLOBALS['zfsm_request_job']['id']='20261020-120000-ffffffffffff';$out['other_id']=allowedCleanup($target);$GLOBALS['zfsm_request_job']=$tracking;
 zfsmJobUpdate($j['id'],['owner_boot'=>'old-boot']);$out['old_boot']=allowedCleanup($target);zfsmJobUpdate($j['id'],['owner_boot'=>'cleanup-boot']);
 $GLOBALS['cleanup_test_lease_held']=false;$out['unheld']=allowedCleanup($target);$GLOBALS['cleanup_test_lease_held']=true;
 $path=zfsmRequestJobLease($j['id']);rename($path,$path.'.old');file_put_contents($path,'replacement');$out['replaced_lease']=allowedCleanup($target);unlink($path);symlink($path.'.old',$path);$out['symlink_lease']=allowedCleanup($target);unlink($path);rename($path.'.old',$path);
 zfsmJobUpdate($j['id'],['command'=>'movedirectory','label'=>'Move directory']);$out['other_command']=allowedCleanup($target);zfsmJobUpdate($j['id'],['command'=>'cleanupmutation','label'=>'Clean completed recovery']);
 fclose($tracking['lease']);$out['closed_lease']=allowedCleanup($target);unset($GLOBALS['zfsm_request_job']);echo json_encode($out);`});assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);assert.deepEqual(JSON.parse(r.text),{own:true,other_target:false,other_id:false,old_boot:false,unheld:false,replaced_lease:false,symlink_lease:false,other_command:false,closed_lease:false});
 }finally{php.exit();}
});

test('validated terminal conversion file protection deletion and request journals do not block cleanup',async()=>{
 const php=await runtime();try{const r=await php.run({code:setup+`
 $restore=['schema'=>2,'type'=>'restore','id'=>'20261020-120000-000000000002','state'=>'completed','stage'=>'completed','snapshot'=>'cache/data@saved','snapshot_guid'=>'77','dataset'=>'cache/data','owner_guid'=>'123','owner_mountpoint'=>'/mnt/cache/data','source'=>'cache/data@saved','target'=>'/mnt/cache/data','staging'=>'/mnt/cache/data/.zfsm-restore-20261020-120000-000000000002','hold_tag'=>'zfsm_restore_20261020-120000-000000000002','hold_owned'=>false,'cancel_requested'=>false,'ack_boot'=>'cleanup-boot','mode'=>'new','bytes'=>0,'files'=>0,'conflicts'=>0,'recovery'=>''];
 $archive=array_replace($restore,['type'=>'archive','target'=>'ZIP download','staging'=>'/mnt/cache/data/.zfsm-archive-20261020-120000-000000000002','hold_tag'=>'zfsm_archive_20261020-120000-000000000002','archive_removed'=>true,'destination_identity'=>['dev'=>'1','ino'=>'2'],'archive_identity'=>['dev'=>'1','ino'=>'3','type'=>'file'],'archive_size'=>0,'expires'=>time()+3600]);
 $protection=zfsmNewProtectionJob('policy',['owner'=>'managed','id'=>'abc','dataset'=>'cache/data','source_guid'=>'123']);$protection=array_replace($protection,['state'=>'completed','stage'=>'finished','verified_outcome'=>'completed']);
 $rejected=['schema'=>5,'type'=>'conversion','id'=>'20261020-120000-000000000005','state'=>'failed','stage'=>'preflight_rejected','source'=>'/mnt/cache/SampleProject','error'=>'Conversion rejected'];
 $out=[];foreach(['conversion'=>conversionCleanupFixture(),'restore'=>$restore,'archive'=>$archive,'protection'=>$protection,'conversion_rejected'=>$rejected,'deletion'=>deletionCleanupFixture(),'deletion_rejected'=>deletionCleanupFixture(true),'request'=>requestCleanupFixture(),'request_rejected'=>requestCleanupFixture('failed','preflight_rejected')]as$name=>$j){clearCleanupJobs();saveCleanupJob($j);$out[$name]=['problem'=>zfsmJobProblem($j),'allowed'=>allowedCleanup()];}echo json_encode($out);`});assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);for(const [name,row]of Object.entries(JSON.parse(r.text))){assert.equal(row.problem,null,name+' fixture must use the real journal validator');assert.equal(row.allowed,true,name);}
 }finally{php.exit();}
});

test('malformed unknown unfinished recovery hold-owned and generic failed journals remain blocked',async()=>{
 const php=await runtime();leaseBoundary(php);try{const r=await php.run({code:setup+`
 $out=[];$cases=['malformed_completed'=>['schema'=>1,'id'=>'20261020-120000-000000000001','state'=>'completed'],'unknown_schema'=>array_replace(conversionCleanupFixture(),['schema'=>99]),'invalid_state'=>array_replace(requestCleanupFixture(),['state'=>'mystery']),'invalid_request'=>array_replace(requestCleanupFixture(),['command'=>'unknown']),'generic_failed'=>requestCleanupFixture('failed','failed'),'failed_after_native'=>requestCleanupFixture('failed','executing_operation'),'unrelated_active'=>requestCleanupFixture('running','validating_request'),'recovery_required'=>requestCleanupFixture('recovery_required','interrupted'),'hold_owned'=>array_replace(conversionCleanupFixture(),['hold_owned'=>true]),'incomplete_completed'=>array_replace(conversionCleanupFixture(),['stage'=>'copying']),'deletion_failed'=>array_replace(deletionCleanupFixture(),['state'=>'failed','stage'=>'verifying'])];
 foreach($cases as$name=>$j){clearCleanupJobs();saveCleanupJob($j);$out[$name]=allowedCleanup();}
 clearCleanupJobs();$j=requestCleanupFixture();file_put_contents(zfsmJobFile($j['id']),'broken');$out['invalid_json']=allowedCleanup();unlink(zfsmJobFile($j['id']));$j=saveCleanupJob($j);rename(zfsmJobFile($j['id']),zfsmJobFile($j['id']).'.old');symlink(zfsmJobFile($j['id']).'.old',zfsmJobFile($j['id']));$out['symlink_journal']=allowedCleanup();unlink(zfsmJobFile($j['id']));rename(zfsmJobFile($j['id']).'.old',zfsmJobFile($j['id']));$j['id']='20261020-120000-000000000009';file_put_contents(zfsmJobFile('20261020-120000-000000000007'),json_encode($j));$out['journal_identity_mismatch']=allowedCleanup();echo json_encode($out);`});assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);for(const [name,allowed]of Object.entries(JSON.parse(r.text)))assert.equal(allowed,false,name);
 }finally{php.exit();}
});

test('own cleanup exemption cannot hide an unrelated live or recovery-required request',async()=>{
 const php=await runtime();leaseBoundary(php);try{const r=await php.run({code:setup+`
 $own=zfsmRequestJobBegin('cleanupmutation',['directory'=>$target]);$out=[];foreach(['running','recovery_required']as$state){$other=saveCleanupJob(requestCleanupFixture($state,$state==='running'?'executing_operation':'interrupted'));$out[$state]=allowedCleanup($target);unlink(zfsmJobFile($other['id']));}zfsmRequestJobFinish('completed','Test complete');echo json_encode($out);`});assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);assert.deepEqual(JSON.parse(r.text),{running:false,recovery_required:false});
 }finally{php.exit();}
});

test('HTTP cleanup accepts its own observed request after completed deletion and request jobs and preserves exact archived bytes',async()=>{
 const s=await startIntegration({dependencyUsage:true});leaseBoundary(s.php);try{
  const post=async fields=>(await fetch(s.url+'/plugins/zfs.master.ui/backend/ZFSMAdmin.php',{method:'POST',body:new URLSearchParams({csrf_token:'integration-token',...fields})})).json();
  const m=s.readModel(),f=m.directory_fixtures,dir=f.mountpoint+'/.zfsm-mutation-'+'a'.repeat(48),bytes='Synthetic completed journal bytes\n';s.php.mkdir(dir);s.php.writeFile(dir+'/journal.jsonl',bytes);
  const seed=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';$j=zfsmRequestJobBegin('snapshotdataset',['zdataset'=>${JSON.stringify(f.owner)}]);zfsmRequestJobFinish('completed','Prior request complete');$s=lstat(${JSON.stringify(dir)});echo json_encode(['dev'=>(string)$s['dev'],'ino'=>(string)$s['ino']]);`});assert.equal(seed.errors,'');const identity=JSON.parse(seed.text);
  const deleteIdentity=f.metadata[f.paths.delete].identity,deleted=await post({cmd:'deletedirectory',directory:f.paths.delete,force:'1',expected_guid:m.datasets[f.owner].guid,'directory_identity[dev]':deleteIdentity.dev,'directory_identity[ino]':deleteIdentity.ino});assert.equal(deleted.job?.schema,6);
  const run=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';echo json_encode(zfsmRunDeletionJob('${deleted.job.id}'));`});assert.equal(run.errors,'');assert.equal(JSON.parse(run.text).state,'completed');
  const preview=await post({cmd:'previewcleanup',directory:dir});assert.ok(preview.token,JSON.stringify(preview));const fields={cmd:'cleanupmutation',directory:dir,expected_guid:m.datasets[f.owner].guid,'directory_identity[dev]':identity.dev,'directory_identity[ino]':identity.ino,preview_id:preview.preview_id,token:preview.token,confirmed:'1'};
  const answer=await post(fields);assert.equal(Object.keys(answer.failed).length,0,JSON.stringify(answer));assert.equal(answer.job?.schema,7);assert.equal(answer.job.command,'cleanupmutation');assert.equal(answer.job.state,'completed');assert.equal(s.php.fileExists(dir),false);
  const archive=JSON.parse(s.php.readFileAsText(answer.cleanup_archive));assert.equal(Buffer.from(archive.journal_base64,'base64').toString(),bytes);assert.equal(archive.scope.directory,dir);assert.equal(s.readModel().calls.filter(c=>c.stdin_json?.op==='cleanup').length,1);
  assert.ok(Object.keys((await post(fields)).failed).length);assert.equal(s.readModel().calls.filter(c=>c.stdin_json?.op==='cleanup').length,1);
 }finally{await s.close();}
});
