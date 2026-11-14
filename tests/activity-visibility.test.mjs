import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';
test('timeline sorting retains unknown journals with malformed created fields beside valid jobs',async()=>{
 const php=await runtime();try{const result=await php.run({code:`<?php require '/app/harness.php';$GLOBALS['plugin_state']='/review-created-types';$GLOBALS['plugin_runtime']='/review-created-runtime';$GLOBALS['plugin_worker_lock']='/review-created-worker';
 $unknown=['id'=>'20261017-120000-000000000001','schema'=>99,'type'=>'conversion','state'=>'completed','stage'=>'unknown','created'=>['invalid'=>'timestamp']];
 $id='20261017-120000-000000000002';$valid=['id'=>$id,'schema'=>1,'state'=>'completed','stage'=>'complete_source_retained','source'=>'/mnt/cache/source','source_identity'=>['dev'=>'1','ino'=>'2'],'recovery'=>'/mnt/cache/source_zfsm_recovery_'.$id,'dataset'=>'cache/source','owner_dataset'=>'cache','owner_guid'=>'123','owner_mountpoint'=>'/mnt/cache','pool'=>'cache','created'=>'2026-10-17T12:00:00Z'];
 $numeric=$valid;$numeric['id']='20261017-120000-000000000000';$numeric['created']=strtotime('2026-10-18T12:00:00Z');$numeric['recovery']='/mnt/cache/source_zfsm_recovery_'.$numeric['id'];zfsmJobAtomicWrite(zfsmJobFile($numeric['id']),$numeric);zfsmJobAtomicWrite(zfsmJobFile($unknown['id']),$unknown);zfsmJobAtomicWrite(zfsmJobFile($id),$valid);$answer=[];
 try{$answer['page']=zfsmJobPage(1,25,['filter'=>'all','sort'=>'newest']);$answer['original_created']=zfsmReadJob($unknown['id'])['created'];}catch(Throwable$e){$answer['error']=$e->getMessage();}
 echo json_encode($answer,JSON_THROW_ON_ERROR);`});assert.equal(result.errors,'');const answer=JSON.parse(result.text);assert.equal(answer.error,undefined,'Malformed timestamps must not fail the full jobs page: '+answer.error);assert.equal(answer.page.jobs.length,3);assert.equal(answer.page.jobs[0].id,'20261017-120000-000000000000','Legacy numeric timestamp must sort by time rather than ID');const unknown=answer.page.jobs.find(job=>job.schema===99);assert.equal(unknown.state,'recovery_required');assert.equal(unknown.diagnostics.issue,'unsupported_schema');assert.equal(unknown.archived,false);assert.deepEqual(answer.original_created,{invalid:'timestamp'});
 }finally{php.exit();}
});
