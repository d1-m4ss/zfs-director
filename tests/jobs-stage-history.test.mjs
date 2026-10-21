import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';

test('durable stage history records real transitions, attempts and truncation without fabricating legacy history',async()=>{
 const php=await runtime();
 try{
  php.writeFile('/app/jobs-stage-history.php',await readFile('tests/jobs-stage-history.php'));
  const result=await php.run({scriptPath:'/app/jobs-stage-history.php'});
  assert.equal(result.errors,'',result.errors);assert.equal(result.exitCode,0,result.text);
  console.log(result.text);
 }finally{php.exit();}
});

test('real archive and restore queues persist creation and worker phases in their existing journals',async()=>{
 const {startIntegration}=await import('./integration/server.mjs');const stand=await startIntegration();
 try{
  const result=await stand.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
  $m=integrationModel();$snapshot=null;foreach($m['snapshots']as$name=>$row)if(str_ends_with($name,'/project@base')){$snapshot=$name;break;}$guid=$m['snapshots'][$snapshot]['guid'];
  $archive=zfsmQueueArchive($snapshot,['notes.txt'],$guid);$initial_archive=$archive;zfsmRunRestoreJob($archive['id']);$archive=zfsmReadJob($archive['id']);
  $preview=zfsmPreviewRestore($snapshot,['notes.txt'],'history-restore','new','history-secret',$guid);$restore=zfsmQueueRestore($preview['id'],$preview['token'],'history-secret','1');$initial_restore=$restore;zfsmRunRestoreJob($restore['id']);$restore=zfsmReadJob($restore['id']);
  zfsmRunRestoreJob($archive['id']);zfsmRunRestoreJob($restore['id']);echo json_encode(['initial_archive'=>$initial_archive,'initial_restore'=>$initial_restore,'archive'=>$archive,'restore'=>$restore,'after_archive'=>zfsmReadJob($archive['id']),'after_restore'=>zfsmReadJob($restore['id'])],JSON_THROW_ON_ERROR);`});
  assert.equal(result.errors,'');const jobs=JSON.parse(result.text);
  for(const type of ['archive','restore']){
   assert.equal(jobs[type].state,'completed',jobs[type].error);assert.equal(jobs['initial_'+type].stage_history_complete,true);assert.deepEqual(jobs['initial_'+type].stage_history.map(e=>[e.state,e.stage,e.attempt]),[['queued','planned',0]]);
   assert.deepEqual(jobs[type].stage_history.slice(0,2).map(e=>[e.state,e.stage,e.attempt]),[['queued','planned',0],['running','validating',1]]);assert.equal(jobs[type].stage_history.at(-1).state,'completed');
   assert.deepEqual(jobs[type].stage_history.map(e=>[e.state,e.stage]),[['queued','planned'],['running','validating'],['running','completed'],['completed','completed']]);assert.deepEqual(jobs['after_'+type].stage_history,jobs[type].stage_history);
  }
 }finally{await stand.close();}
});
