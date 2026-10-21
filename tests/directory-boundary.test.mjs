import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';

test('directory native boundary requires explicit verified success and preserves retained recovery details',async()=>{
 const php=await runtime();try{
 const r=await php.run({code:`<?php require '/app/harness.php';
 $request=['op'=>'move','root'=>'/mnt/cache','root_identity'=>['dev'=>'1','ino'=>'2'],'path'=>'SampleProject','identity'=>['dev'=>'1','ino'=>'3'],'destination'=>'Renamed SampleProject'];
 $helper='/app/src/scripts/zfsm-directory.pl';
 $recovery=['location'=>'/mnt/cache/.zfsm-mutation-fixture','identity'=>['dev'=>'1','ino'=>'4'],'journal'=>'journal.jsonl','retained'=>true];
 expectProcess('/usr/bin/perl',[$helper],json_encode(['phase'=>'prepared','recovery'=>$recovery])."\\n".json_encode(['ok'=>true,'op'=>'move','recovery'=>$recovery]));
 $success=zfsmDirectoryCommand($request);
 expectProcess('/usr/bin/perl',[$helper],json_encode(['error'=>'Directory identity changed; object retained','recovery'=>$recovery]),1);
 $failure=zfsmDirectoryCommand($request);
 expectProcess('/usr/bin/perl',[$helper],'');$empty=zfsmDirectoryCommand($request);
 echo json_encode(['success'=>$success,'failure'=>$failure,'empty'=>$empty,'calls'=>$GLOBALS['test_calls']]);`});
 assert.equal(r.exitCode,0,r.text+r.errors);const a=JSON.parse(r.text);
 assert.equal(a.success.ok,true);assert.equal(a.success.recovery.journal,'journal.jsonl');
 assert.equal(a.failure.ok,false);assert.match(a.failure.error,/identity changed/);assert.equal(a.failure.recovery.location,'/mnt/cache/.zfsm-mutation-fixture');
 assert.equal(a.empty.ok,false);assert.match(a.empty.error,/verified|response|result/i);
 assert.equal(a.calls.length,3);assert.ok(a.calls.every(c=>c[0]==='/usr/bin/perl'));
 }finally{php.exit();}
});

test('reviewed directory identity survives path re-resolution and prevents stale native mutation targets',async()=>{
 const php=await runtime();try{
 const r=await php.run({code:`<?php require '/app/harness.php';
 mkdir('/mnt/cache/SampleProject',0777,true);chmod('/mnt/cache',0777);$actual=zfsmDirectoryIdentity('/mnt/cache/SampleProject');
 $GLOBALS['zfsm_directory_reviewed']=['path'=>'/mnt/cache/SampleProject','identity'=>['dev'=>'9','ino'=>'123']];
 $source=['path'=>'/mnt/cache/SampleProject','dataset'=>'cache','mountpoint'=>'/mnt/cache'];
 try{$request=zfsmDirectoryRequest('move',$source,['destination'=>'Renamed']);echo json_encode(['request'=>$request]);}
 catch(Throwable $e){echo json_encode(['error'=>$e->getMessage()]);}`});
 assert.equal(r.exitCode,0,r.text+r.errors);const a=JSON.parse(r.text);assert.ok(a.error&&/identity|changed/i.test(a.error),r.text);
 }finally{php.exit();}
});

test('HTTP identity guard binds the selected inode through a writable-parent replacement before Delete',async()=>{
 const php=await runtime();try{
 const path='/app/src/backend/ZFSMOperations.php';
 php.writeFile(path,php.readFileAsText(path).replace('function zfsmResolveDirectory($path, $must_exist = true) {',`function zfsmResolveDirectory($path,$must_exist=true){return ['path'=>$path,'dataset'=>'cache','mountpoint'=>'/mnt/cache'];}\nfunction testOriginalResolveDirectory($path, $must_exist = true) {`));
 const r=await php.run({code:`<?php require '/app/harness.php';
 mkdir('/mnt/cache/SampleProject',0777,true);chmod('/mnt/cache',0777);file_put_contents('/mnt/cache/SampleProject/original','KEEP');
 $expected=zfsmDirectoryIdentity('/mnt/cache/SampleProject');expectProcess('zfs',['list','-H','-p','-o','name,type,guid','-t','filesystem,volume,snapshot','cache'],"cache\\tfilesystem\\t123");
 zfsmGuardMutationIdentity('deletedirectory',['directory'=>'/mnt/cache/SampleProject','expected_guid'=>'123','directory_identity'=>$expected]);
 rename('/mnt/cache/SampleProject','/mnt/cache/retained-original');mkdir('/mnt/cache/SampleProject');file_put_contents('/mnt/cache/SampleProject/replacement','KEEP TOO');
 $answer=deleteDirectory('/mnt/cache/SampleProject','1');
 echo json_encode(['answer'=>$answer,'original'=>file_get_contents('/mnt/cache/retained-original/original'),'replacement'=>file_get_contents('/mnt/cache/SampleProject/replacement'),'calls'=>$GLOBALS['test_calls']]);`});
 assert.equal(r.exitCode,0,r.text+r.errors);const a=JSON.parse(r.text);assert.equal(a.original,'KEEP');assert.equal(a.replacement,'KEEP TOO');assert.equal(Object.keys(a.answer.succeeded).length,0);assert.match(Object.values(a.answer.failed).join(' '),/identity changed/i);assert.equal(a.calls.length,1,'no mutation helper invoked for replaced reviewed object');
 }finally{php.exit();}
});
