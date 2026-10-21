import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';

test('conversion preflight verifies the reviewed filesystem root and sends no mutation fields',async()=>{
 const php=await runtime();try{
  const helper='/app/src/include/ZFSMHelpers.php';
  php.writeFile(helper,php.readFileAsText(helper).replace('return zfsmTestProcess($command, $args);',"$GLOBALS['probe_requests'][]=json_decode($stdin,true);return zfsmTestProcess($command, $args);"));
  const r=await php.run({code:`<?php require '/app/harness.php';
   expectProcess('/usr/bin/perl',['/app/src/scripts/zfsm-directory.pl'],json_encode(['ok'=>true,'op'=>'probe','fanotify_target_fid'=>true,'root_mount_id'=>'9']));
   expectProcess('/usr/bin/perl',['/app/src/scripts/zfsm-publish.pl'],json_encode(['ok'=>true,'phase'=>'probe']));
   zfsmConfinedPreflight(['op'=>'claim','root'=>'/mounted/owner','root_identity'=>['dev'=>'17','ino'=>'4'],'path'=>'ordinary','destination'=>'retained']);
   echo json_encode($GLOBALS['probe_requests']);`});
  assert.equal(r.exitCode,0,r.text+r.errors);
  assert.deepEqual(JSON.parse(r.text),[{op:'probe',root:'/mounted/owner',root_identity:{dev:'17',ino:'4'}},{op:'probe'}]);
 }finally{php.exit();}
});

test('conversion cannot substitute a generic kernel probe for a reviewed owner filesystem',async()=>{
 const php=await runtime();try{
  const r=await php.run({code:`<?php require '/app/harness.php';$error=null;
   try{zfsmConfinedPreflight([]);}catch(Throwable $e){$error=$e->getMessage();}
   echo json_encode(['error'=>$error,'calls'=>$GLOBALS['test_calls']]);`});
  assert.equal(r.exitCode,0,r.text+r.errors);const result=JSON.parse(r.text);
  assert.match(result.error,/verified owner filesystem/);assert.deepEqual(result.calls,[]);
 }finally{php.exit();}
});

test('confined conversion journals validate their method, exact stage and private target before any execution',async()=>{
 const php=await runtime();try{
 const r=await php.run({code:`<?php require '/app/harness.php';
 $id='20261017-120000-000000000001';$source='/mnt/cache/SampleProject';
 $job=['schema'=>1,'method'=>'confined-v1','id'=>$id,'state'=>'queued','stage'=>'copy_verified','source'=>$source,'source_identity'=>['dev'=>'1','ino'=>'2'],'recovery'=>$source.'_zfsm_recovery_'.$id,'dataset'=>'cache/SampleProject','owner_dataset'=>'cache','owner_guid'=>'123','owner_mountpoint'=>'/mnt/cache','pool'=>'cache','staging'=>'/var/tmp/zfs.master.ui/conversions/'.$id];
 $valid=zfsmJobProblem($job);$bad=[];
 foreach([['method'=>'detached-fd'],['stage'=>'unknown'],['staging'=>'/'],['staging'=>'/var/tmp/zfs.master.ui/conversions/../escape'],['dataset'=>'cache/other']]as$changes)$bad[]=zfsmJobProblem(array_replace($job,$changes));
 echo json_encode(['valid'=>$valid,'bad'=>$bad,'resume_copy'=>zfsmConfinedCanResume($job),'resume_planned'=>zfsmConfinedCanResume(array_replace($job,['stage'=>'planned'])),'resume_published'=>zfsmConfinedCanResume(array_replace($job,['stage'=>'published']))]);`});
 assert.equal(r.exitCode,0,r.text+r.errors);const a=JSON.parse(r.text);assert.equal(a.valid,null);assert.ok(a.bad.every(Boolean));assert.equal(a.resume_copy,false);assert.equal(a.resume_planned,true);assert.equal(a.resume_published,true);
 }finally{php.exit();}
});

test('explicit Resume cannot re-copy an interrupted confined conversion or alter the journal',async()=>{
 const php=await runtime();try{
 const r=await php.run({code:`<?php require '/app/harness.php';$GLOBALS['plugin_state']='/confined-jobs';
 $id='20261017-120000-000000000002';$source='/mnt/cache/SampleProject';
 $job=['schema'=>1,'method'=>'confined-v1','id'=>$id,'state'=>'recovery_required','stage'=>'copying','source'=>$source,'source_identity'=>['dev'=>'1','ino'=>'2'],'recovery'=>$source.'_zfsm_recovery_'.$id,'dataset'=>'cache/SampleProject','owner_dataset'=>'cache','owner_guid'=>'123','owner_mountpoint'=>'/mnt/cache','pool'=>'cache','staging'=>'/var/tmp/zfs.master.ui/conversions/'.$id];
 zfsmJobAtomicWrite(zfsmJobFile($id),$job);$before=hash_file('sha256',zfsmJobFile($id));$error=null;
 try{zfsmResumeConversion($id,true);}catch(Throwable $e){$error=$e->getMessage();}
 echo json_encode(['error'=>$error,'unchanged'=>$before===hash_file('sha256',zfsmJobFile($id)),'pending'=>zfsmPendingJobs(),'actions'=>zfsmJobPage()['jobs'][0]['actions']]);`});
 assert.equal(r.exitCode,0,r.text+r.errors);const a=JSON.parse(r.text);assert.match(a.error,/retained|manual|inspect/i);assert.equal(a.unchanged,true);assert.deepEqual(a.pending,[]);assert.equal(a.actions.resume,false);
 }finally{php.exit();}
});
