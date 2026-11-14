import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startIntegration} from './integration/server.mjs';
// JOBS-007: a retained restore folder can be deleted, but never while its restore is unresolved.
const mount='/mnt/cache/__mock__/project',id='20261114-093000-0123456789ab',folder=mount+'/.zfsm-restore-'+id,BLOCK='This folder belongs to a restore that did not finish. Open that job in Jobs first.';
const php=code=>`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';${code}`;
async function fixture(fn){const s=await startIntegration({dependencyUsage:true});try{
 const post=async fields=>(await fetch(s.url+'/plugins/zfs.master.ui/backend/ZFSMAdmin.php',{method:'POST',body:new URLSearchParams({csrf_token:'integration-token',...fields})})).json();
 const call=async code=>{const r=await s.run({code:php(code)});assert.equal(r.errors,'',r.text);return JSON.parse(r.text);};
 const prepare=async(state)=>{await s.run({code:`<?php mkdir('${folder}/replaced',0700,true);file_put_contents('${folder}/replaced/old.txt','old');`});
  if(state)await call(`$id='${id}';$mount='${mount}';$j=['schema'=>2,'type'=>'restore','id'=>$id,'state'=>'${state}','stage'=>'${state==='completed'?'completed':'copying'}','snapshot'=>'cache/__mock__/project@base','source'=>'cache/__mock__/project@base','dataset'=>'cache/__mock__/project','owner_guid'=>'123','snapshot_guid'=>'456','owner_mountpoint'=>$mount,'staging'=>$mount.'/.zfsm-restore-'.$id,'hold_tag'=>'zfsm_restore_'.$id,'hold_owned'=>false,'cancel_requested'=>false,'ack_boot'=>zfsmBootId(),'bytes'=>1,'files'=>1,'conflicts'=>1,'mode'=>'overwrite','target'=>$mount,'recovery'=>$mount.'/.zfsm-restore-'.$id.'/replaced','created'=>'2026-11-14T09:00:00Z','updated'=>'2026-11-14T09:00:00Z'];zfsmJobAtomicWrite(zfsmJobFile($id),$j);echo json_encode(zfsmJobProblem($j));`);};
 const run=async jobId=>call(`echo json_encode(zfsmRunDeletionJob(${JSON.stringify(jobId)}));`);
 const identity=async path=>call(`echo json_encode(zfsmDirectoryIdentity(${JSON.stringify(path)}));`);
 await fn({s,post,call,prepare,run,identity,m:s.readModel()});
}finally{await s.close();}}
const request=async(post,identity,m,path)=>{const i=await identity(path);return post({cmd:'deletedirectory',directory:path,force:'1',expected_guid:m.datasets['cache/__mock__/project'].guid,'directory_identity[dev]':i.dev,'directory_identity[ino]':i.ino});};

test('a retained restore folder without a journal is queued, deleted by the worker and gone',async()=>fixture(async({s,post,prepare,run,identity,m})=>{
 await prepare(null);
 const review=await post({cmd:'previewdeletedirectory',directory:folder,force:'1'});assert.deepEqual({can_delete:review.can_delete,blockers:review.blockers},{can_delete:true,blockers:[]});
 const answer=await request(post,identity,m,folder);assert.equal(answer.job?.state,'queued',JSON.stringify(answer).slice(0,300));
 const job=await run(answer.job.id);assert.equal(job.state,'completed');assert.equal(s.php.fileExists(folder),false);
}));
test('a completed restore does not keep its folder from being deleted',async()=>fixture(async({s,post,prepare,run,identity,m})=>{
 await prepare('completed');
 const answer=await request(post,identity,m,folder);assert.equal(answer.job?.state,'queued',JSON.stringify(answer).slice(0,300));
 assert.equal((await run(answer.job.id)).state,'completed');assert.equal(s.php.fileExists(folder),false);
}));
for(const state of ['recovery_required','failed','running','queued'])test('a restore in state '+state+' blocks the review and the deletion of its folder',async()=>fixture(async({s,post,prepare,run,identity,m,call})=>{
 await prepare(state);
 const review=await post({cmd:'previewdeletedirectory',directory:folder,force:'1'});
 assert.equal(review.can_delete,false);assert.deepEqual(review.blockers.filter(b=>b.kind==='restore').map(b=>b.title),[BLOCK]);
 // The restore may also become unresolved after the review; the worker checks again.
 await prepare(null);const answer=await request(post,identity,m,folder);assert.equal(answer.job?.state,'queued',JSON.stringify(answer).slice(0,300));
 await call(`$id='${id}';$mount='${mount}';$j=['schema'=>2,'type'=>'restore','id'=>$id,'state'=>'${state}','stage'=>'copying','snapshot'=>'cache/__mock__/project@base','source'=>'cache/__mock__/project@base','dataset'=>'cache/__mock__/project','owner_guid'=>'123','snapshot_guid'=>'456','owner_mountpoint'=>$mount,'staging'=>$mount.'/.zfsm-restore-'.$id,'hold_tag'=>'zfsm_restore_'.$id,'hold_owned'=>false,'cancel_requested'=>false,'ack_boot'=>zfsmBootId(),'bytes'=>1,'files'=>1,'conflicts'=>1,'mode'=>'overwrite','target'=>$mount,'recovery'=>$mount.'/.zfsm-restore-'.$id.'/replaced','created'=>'2026-11-14T09:00:00Z','updated'=>'2026-11-14T09:00:00Z'];zfsmJobAtomicWrite(zfsmJobFile($id),$j);echo '1';`);
 const job=await run(answer.job.id);assert.equal(job.state,'failed');assert.equal(job.error,'Deletion was not started. Review the target and permissions, then submit a fresh request.');assert.equal(s.php.fileExists(folder+'/replaced/old.txt'),true);
}));
test('nothing inside a retained restore folder, and no other service folder, can be deleted',async()=>fixture(async({s,post,prepare,identity,m,call})=>{
 await prepare(null);await s.run({code:`<?php mkdir('${folder}/data',0700,true);mkdir('${mount}/.zfsm-mutation-${'a'.repeat(48)}',0700,true);`});
 for(const path of [folder+'/replaced',folder+'/data',mount+'/.zfsm-mutation-'+'a'.repeat(48)]){
  const review=await post({cmd:'previewdeletedirectory',directory:path,force:'1'});assert.equal(review.can_delete,false,path);
  const answer=await request(post,identity,m,path);assert.notEqual(answer.job?.state,'queued',path);assert.equal(s.php.fileExists(path),true,path);
 }
 assert.deepEqual(await call(`echo json_encode([zfsmRetainedRestoreId('.zfsm-restore-${id}'),zfsmRetainedRestoreId('a/b/.zfsm-restore-${id}'),zfsmRetainedRestoreId('.zfsm-restore-${id}/replaced'),zfsmRetainedRestoreId('.zfsm-x/.zfsm-restore-${id}'),zfsmRetainedRestoreId('../.zfsm-restore-${id}'),zfsmRetainedRestoreId('.zfsm-restore-x')]);`),[id,id,null,null,null,null]);
}));
