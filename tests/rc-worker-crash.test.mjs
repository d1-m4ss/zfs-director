import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';
test('a previously running conversion requires explicit Resume before any ZFS or filesystem retry',async()=>{
 const php=await runtime();try{
 const r=await php.run({code:`<?php require '/app/harness.php';
 $GLOBALS['plugin_state']='/worker-crash';$GLOBALS['zfsm_boot_id']='boot';
 $id='20261016-120000-aaaaaaaaaaaa';$source='/test/source';
 $job=['schema'=>1,'id'=>$id,'state'=>'running','stage'=>'copying','source'=>$source,'source_identity'=>['dev'=>'1','ino'=>'2'],'recovery'=>$source.'_zfsm_recovery_'.$id,'dataset'=>'cache/source','owner_dataset'=>'cache','owner_guid'=>'123','owner_mountpoint'=>'/test','pool'=>'cache','ack_boot'=>'boot','cancel_requested'=>false];
 zfsmJobAtomicWrite(zfsmJobFile($id),$job);$after=zfsmRunConversionJob($id);
 echo json_encode(['state'=>$after['state'],'error'=>$after['error'],'calls'=>$GLOBALS['test_calls']]);`});
 const result=JSON.parse(r.text);assert.equal(result.state,'recovery_required');assert.match(result.error,/interrupted.*Resume/i);assert.deepEqual(result.calls,[]);
 }finally{php.exit();}
});
