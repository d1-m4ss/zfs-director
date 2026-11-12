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

// REL-004: the busy-lock message names the operation currently holding it.
test('busy-lock failure names the running command/job only when its pid matches the real kernel lock owner',async()=>{
 const php=await runtime();try{
  const r=await php.run({code:String.raw`<?php require '/app/harness.php';
  $GLOBALS['plugin_runtime']='/lock-owner-runtime';
  (function(){
   zfsmOperationLockDescribe('Rename dataset','tank/a');
   $owner=['pid'=>getmypid(),'comm'=>'php'];
   $message=zfsmOperationLockFailure('lock_busy',$owner)->getMessage();
   same(true,str_contains($message,'Held by: php (PID '.getmypid().')'));
   same(true,str_contains($message,'Running now: Rename dataset tank/a (0 min)'));
   zfsmOperationLockForget();
   $message=zfsmOperationLockFailure('lock_busy',$owner)->getMessage();
   same(false,str_contains($message,'Running now:'));
  })();
  (function(){
   zfsmOperationLockDescribe('Convert directory','tank/b');
   $message=zfsmOperationLockFailure('lock_busy',['pid'=>getmypid()+1,'comm'=>'php'])->getMessage();
   same(false,str_contains($message,'Running now:'));
   zfsmOperationLockForget();
  })();
  (function(){
   zfsmOperationLockDescribe('Delete dataset','tank/c');
   file_put_contents($GLOBALS['plugin_runtime'].'/lock-owner.json',json_encode(['label'=>'Delete dataset','subject'=>'tank/c','pid'=>getmypid(),'started'=>time()-185]));
   $message=zfsmOperationLockFailure('lock_busy',['pid'=>getmypid(),'comm'=>'php'])->getMessage();
   same(true,str_contains($message,'Running now: Delete dataset tank/c (3 min)'));
   zfsmOperationLockForget();
  })();
  (function(){
   zfsmOperationLockDescribe('Pool scrub',null);
   $message=zfsmOperationLockFailure('lock_busy',['pid'=>getmypid(),'comm'=>'php'])->getMessage();
   same(true,str_contains($message,'Running now: Pool scrub (0 min)'));
   zfsmOperationLockForget();
  })();
  (function(){
   $file=$GLOBALS['plugin_runtime'].'/lock-owner.json';
   file_put_contents($file,'not json');
   same(null,zfsmOperationLockRunningNow(['pid'=>getmypid()]));
   file_put_contents($file,str_repeat('a',5000));
   same(null,zfsmOperationLockRunningNow(['pid'=>getmypid()]));
   unlink($file);symlink('/etc/passwd',$file);
   same(null,zfsmOperationLockRunningNow(['pid'=>getmypid()]));
   unlink($file);
   same(null,zfsmOperationLockRunningNow(['pid'=>getmypid()]));
  })();
  echo 'PASS';`});
  assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);assert.equal(r.text,'PASS');
 }finally{php.exit();}
});
