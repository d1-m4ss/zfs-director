import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {runtime} from './php-runtime.mjs';

test('conversion submission exposes an indeterminate loading bar and clears it after failure',async()=>{
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window,root=w.document.querySelector('main');
 w.eval(readFileSync('src/frontend/ZFSMForms.js','utf8'));let finish,calls=0;
 const forms=w.zfsmCreateInlineForms({getConfig:()=>({destructive_mode:1}),request:()=>{calls++;return new Promise(resolve=>finish=resolve);}});
 try{
  await forms.render(root,'convertdirectory',{directory:'/mnt/cache/zfs/SampleCamera',pool:'cache',node:{type:'directory'}});
  root.querySelector('[name=offline_confirmed]').click();root.querySelector('button[type=submit]').click();root.querySelector('[data-confirm-operation]').click();
  assert.equal(calls,1);assert.equal(root.querySelector('form').getAttribute('aria-busy'),'true');
  const progress=root.querySelector('progress[aria-label="Submitting conversion"]');assert.ok(progress);assert.equal(progress.hasAttribute('value'),false);assert.match(root.textContent,/Checking and queuing conversion/);
  assert.equal(root.querySelector('button[type=submit]').disabled,true);
  finish({succeeded:{},failed:{request:'Stopped-writers confirmation required'}});for(let i=0;i<20;i++)await Promise.resolve();
  assert.equal(root.querySelector('form').getAttribute('aria-busy'),'false');assert.equal(root.querySelector('progress'),null);assert.match(root.textContent,/Operation failed/);
 }finally{forms.dispose();w.close();}
});

test('rejected conversion journals are durable, redacted, non-executable and cannot resume',async()=>{
 const php=await runtime();try{
  const r=await php.run({code:`<?php require '/app/harness.php';$GLOBALS['plugin_state']='/rejected-jobs';
  $job=zfsmRecordRejectedConversion('/mnt/cache/zfs/SampleCamera',['request'=>'Operation blocked by configured service references or additional mounts. password=never-save-this'],'a'.str_repeat('b',31));
  same(null,zfsmJobProblem($job));same('failed',$job['state']);same('preflight_rejected',$job['stage']);same([],zfsmPendingJobs());same($job,zfsmRunConversionJob($job['id']));
  $view=zfsmJobPresentation($job,zfsmJobFile($job['id']),false);same(false,$view['actions']['resume']);same(false,$view['actions']['cancel']);same('needs_attention',$view['group']);same(false,str_contains(json_encode(zfsmReadJob($job['id'])),'never-save-this'));
  foreach(['state'=>'queued','stage'=>'planned','method'=>'confined-v1','hold_owned'=>true]as$key=>$value){$bad=$job;$bad[$key]=$value;same(true,zfsmJobProblem($bad)!==null);}
  same(null,zfsmRecordRejectedConversion('invalid target',[],'a'.str_repeat('b',31)));echo json_encode($view);`});
  assert.equal(r.errors,'');assert.equal(r.exitCode,0,r.text);assert.match(r.text,/No data was copied or moved/);
 }finally{php.exit();}
});

test('API does not invent a rejected attempt when queued journal publication succeeded but directory sync failed',async()=>{
 const {startIntegration}=await import('./integration/server.mjs'),stand=await startIntegration({dependencyUsage:true});
 try{
  const m=stand.readModel(),f=m.directory_fixtures,id=f.metadata[f.paths.convert].identity,endpoint=stand.url+'/plugins/zfs.master.ui/backend/ZFSMAdmin.php';
  const fields={cmd:'convertdirectory',csrf_token:'integration-token',directory:f.paths.convert,pool:'cache',offline_confirmed:'1',expected_guid:m.datasets[f.owner].guid,'directory_identity[dev]':id.dev,'directory_identity[ino]':id.ino};
  async function post(data){return (await fetch(endpoint,{method:'POST',body:new URLSearchParams(data)})).json();}
  const denied=await post({...fields,csrf_token:'wrong'});assert.match(JSON.stringify(denied.failed),/CSRF/);
  assert.equal((await post({cmd:'conversionjobs',csrf_token:'integration-token'})).jobs.length,0);
  const path='/app/src/include/ZFSMJobs.php',source=stand.php.readFileAsText(path);stand.php.writeFile(path,source.replace('zfsmAuditSyncDirectory(dirname($file));',"if(($data['schema']??null)===1)throw new RuntimeException('Synthetic post-rename directory sync failure');zfsmAuditSyncDirectory(dirname($file));"));
  const answer=await post(fields);assert.match(JSON.stringify(answer.failed),/queue outcome is uncertain/);
  const jobs=(await post({cmd:'conversionjobs',csrf_token:'integration-token'})).jobs;assert.equal(jobs.length,1);assert.equal(answer.job?.id,jobs[0].id);assert.equal(jobs[0].schema,1);assert.equal(jobs[0].state,'queued');assert.notEqual(jobs[0].stage,'preflight_rejected');
 }finally{await stand.close();}
});
