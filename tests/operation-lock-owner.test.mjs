import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';

test('lock owner audit retains only safe observed identity for acquiring_lock contention',async()=>{
 const php=await runtime();try{
  const r=await php.run({code:String.raw`<?php require '/app/harness.php';
  $input=['stage'=>'acquiring_lock','error_code'=>'lock_busy','lock_owner'=>['pid'=>321,'comm'=>'php-fpm','cmdline'=>'SECRET','path'=>'SECRET']];
  $id=zfsmAuditBegin('saveconfig',[]);zfsmAuditFinish($id,['status'=>'failed','details'=>$input]);$row=zfsmAuditList(1)[0];
  same(['pid'=>321,'comm'=>'php-fpm'],$row['details']['lock_owner']??null);same(false,str_contains(json_encode($row),'SECRET'));
  foreach(['bad name','SECRET/secret',"php\nINJECT",str_repeat('a',16)]as$comm){$input['lock_owner']['comm']=$comm;$safe=zfsmAuditFailureDetails($input,'saveconfig');same(['pid'=>321,'comm'=>null],$safe['lock_owner']??null);}
  foreach([0,-1,'321',2147483648,[]]as$pid){$input['lock_owner']['pid']=$pid;same(false,array_key_exists('lock_owner',zfsmAuditFailureDetails($input,'saveconfig')));}
  $input['lock_owner']=['pid'=>321,'comm'=>'php'];$input['stage']='native_set';same(false,array_key_exists('lock_owner',zfsmAuditFailureDetails($input,'saveconfig')));
  $input['stage']='acquiring_lock';$input['error_code']='lock_unavailable';same(false,array_key_exists('lock_owner',zfsmAuditFailureDetails($input,'saveconfig')));
  echo 'PASS';`});
  assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);assert.equal(r.text,'PASS');
 }finally{php.exit();}
});

test('kernel lock parser excludes unrelated inodes devices shared locks and waiting processes',async()=>{
 const php=await runtime();try{
  const r=await php.run({code:String.raw`<?php require '/app/harness.php';
  $opened=['dev'=>512,'ino'=>42];
  $irrelevant="1: FLOCK ADVISORY WRITE 10 02:00:43 0 EOF\n2: FLOCK ADVISORY WRITE 11 02:01:42 0 EOF\n3: FLOCK ADVISORY READ 12 02:00:42 0 EOF\n4: -> FLOCK ADVISORY WRITE 13 02:00:42 0 EOF\n5: POSIX ADVISORY WRITE 14 02:00:42 0 EOF\n";
  same(null,zfsmOperationLockPid($irrelevant,$opened));same(321,zfsmOperationLockPid($irrelevant."6: FLOCK ADVISORY WRITE 321 02:00:42 0 EOF\n",$opened));
  same(null,zfsmOperationLockOwner($opened));echo 'PASS';`});
  assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);assert.equal(r.text,'PASS');
 }finally{php.exit();}
});
