import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync,readFileSync} from 'node:fs';
import {runtime} from './php-runtime.mjs';
test('rejected detached-fd conversion cannot enter the installed source or worker dispatch',()=>{
 assert.equal(existsSync('src/scripts/zfsm-convert.pl'),false);
 assert.equal(existsSync('src/include/ZFSMConversionPinned.php'),false);
 for(const path of ['src/backend/ZFSMOperations.php','src/include/ZFSMJobRunner.php','src/include/ZFSMJobs.php'])assert.doesNotMatch(readFileSync(path,'utf8'),/zfsmRunPinnedConversionJob|zfsmProbePinnedConversion|ZFSMConversionPinned/);
});
test('experimental conversion journals remain visible for manual inspection and cannot run automatically',async()=>{
 const php=await runtime();try{
 const r=await php.run({code:`<?php require '/app/harness.php';$GLOBALS['plugin_state']='/quarantined-jobs';
 $job=['id'=>'20261017-120000-000000000001','schema'=>3,'type'=>'conversion','state'=>'queued','stage'=>'planned','source'=>'/synthetic/SampleProject','dataset'=>'cache/synthetic/SampleProject','created'=>'2026-10-17T12:00:00Z'];
 zfsmJobAtomicWrite(zfsmJobFile($job['id']),$job);$page=zfsmJobPage();echo json_encode(['pending'=>zfsmPendingJobs(),'job'=>$page['jobs'][0]]);`});
 assert.equal(r.errors,'');assert.equal(r.exitCode,0,r.text);const a=JSON.parse(r.text);assert.deepEqual(a.pending,[]);assert.equal(a.job.diagnostics.issue,'unsupported_schema');assert.equal(a.job.group,'needs_attention');assert.equal(a.job.actions.resume,false);assert.equal(a.job.actions.cancel,false);assert.equal(a.job.actions.download,false);assert.equal(a.job.actions.inspect,true);
 }finally{php.exit();}
});
