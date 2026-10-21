import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startIntegration} from './integration/server.mjs';

async function fixture(fn){const s=await startIntegration({dependencyUsage:true});try{
 const post=async fields=>(await fetch(s.url+'/plugins/zfs.master.ui/backend/ZFSMAdmin.php',{method:'POST',body:new URLSearchParams({csrf_token:'integration-token',...fields})})).json();
 const run=async id=>{const r=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';echo json_encode(zfsmRunDeletionJob(${JSON.stringify(id)}));`});assert.equal(r.errors,'');return JSON.parse(r.text);};
 const m=s.readModel(),f=m.directory_fixtures,i=f.metadata[f.paths.delete].identity;
 await fn({s,post,run,m,f,fields:{cmd:'deletedirectory',directory:f.paths.delete,force:'1',expected_guid:m.datasets[f.owner].guid,'directory_identity[dev]':i.dev,'directory_identity[ino]':i.ino}});
}finally{await s.close();}}

test('directory delete is queued without removing data; worker verifies completion once and exposes no Resume',async()=>fixture(async({s,post,run,f,fields})=>{
 const answer=await post(fields);assert.equal(Object.keys(answer.failed).length,0,JSON.stringify(answer));assert.equal(answer.job?.state,'queued');assert.equal(s.php.fileExists(f.paths.delete+'/retained.txt'),true);
 const job=await run(answer.job.id);assert.equal(job.state,'completed');assert.equal(s.php.fileExists(f.paths.delete),false);assert.equal(job.result.state_verified,true);
 const calls=s.readModel().calls.length;assert.deepEqual(await run(job.id),job);assert.equal(s.readModel().calls.length,calls);
 const view=(await post({cmd:'conversionjobs',filter:'deletion'})).jobs.find(j=>j.id===job.id);assert.equal(view.actions.resume,false);assert.equal(view.actions.cancel,false);assert.match(view.result.summary,/deleted/i);
}));

test('dataset destroy consumes exact preview at queue time and verifies reviewed GUIDs after worker execution',async()=>fixture(async({s,post,run,m})=>{
 const target='cache/__mock__/locked',preview=await post({cmd:'previewdestroy',zdataset:target,recursive:'1'});
 const fields={cmd:'destroydataset',zdataset:target,force:'1',expected_guid:m.datasets[target].guid,preview_id:preview.preview_id,preview_token:preview.token};
 const answer=await post(fields);assert.equal(Object.keys(answer.failed).length,0,JSON.stringify(answer));assert.equal(answer.job?.state,'queued');assert.ok(s.readModel().datasets[target]);
 assert.ok(Object.keys((await post(fields)).failed).length);const job=await run(answer.job.id);assert.equal(job.state,'completed');assert.equal(s.readModel().datasets[target],undefined);assert.equal(job.result.state_verified,true);assert.ok(job.result.removed.includes(target));
}));

test('replaced directory and interrupted or previous-boot deletion never execute automatically',async()=>fixture(async({s,post,run,f,fields})=>{
 const answer=await post(fields);assert.equal(answer.job?.state,'queued');
 const r=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';rename(${JSON.stringify(f.paths.delete)},${JSON.stringify(f.paths.delete+'-original')});mkdir(${JSON.stringify(f.paths.delete)});file_put_contents(${JSON.stringify(f.paths.delete+'/new.txt')},'protect replacement');`});assert.equal(r.errors,'');
 const job=await run(answer.job.id);assert.equal(job.state,'failed');assert.equal(s.php.fileExists(f.paths.delete+'/new.txt'),true);assert.equal(s.php.fileExists(f.paths.delete+'-original/retained.txt'),true);
 for(const change of ["['state'=>'running','stage'=>'deleting']","['state'=>'queued','ack_boot'=>'other-boot']"]){await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';zfsmJobUpdate('${job.id}',${change});`});const stopped=await run(job.id);assert.equal(stopped.state,'recovery_required');assert.equal(s.php.fileExists(f.paths.delete+'/new.txt'),true);}
}));

test('authenticated preflight refusals appear in Jobs, while CSRF failures create no job',async()=>fixture(async({post,fields})=>{
 assert.ok((await post({...fields,csrf_token:'wrong'})).failed);assert.equal((await post({cmd:'conversionjobs'})).jobs.length,0);
 const denied=await post({...fields,expected_guid:'999999'});assert.equal(denied.job?.state,'failed');assert.equal(denied.job?.stage,'preflight_rejected');assert.match(denied.job.error,/identity|refresh/i);
 const jobs=(await post({cmd:'conversionjobs'})).jobs;assert.equal(jobs.length,1);assert.equal(jobs[0].actions.resume,false);assert.equal(jobs[0].actions.cancel,false);
}));

test('dataset partial failure reports verified removed and remaining objects without automatic retry',async()=>fixture(async({s,post,run,m})=>{
 const target='cache/__mock__/locked';const model=s.readModel();model.snapshots[target+'@base']={...model.snapshots['cache/__mock__/project@base'],name:target+'@base',guid:'987654320'};s.writeModel(model);const preview=await post({cmd:'previewdestroy',zdataset:target,recursive:'1'});
 const answer=await post({cmd:'destroydataset',zdataset:target,force:'1',expected_guid:m.datasets[target].guid,preview_id:preview.preview_id,preview_token:preview.token});assert.equal(answer.job?.state,'queued',JSON.stringify(answer));
 const live=s.readModel();live.destroy_fault=target;s.writeModel(live);
 const job=await run(answer.job.id);assert.equal(job.state,'failed');assert.equal(job.result.state_verified,true);assert.equal(job.exit_code,1);assert.match(job.error,/busy/);assert.ok(job.result.removed.includes(target+'@base'));assert.ok(job.result.remaining.includes(target));assert.ok(s.readModel().datasets[target]);
 const calls=s.readModel().calls.length;await run(job.id);assert.equal(s.readModel().calls.length,calls);
}));

test('worker refuses a changed dataset scope and newly disabled destructive mode before native deletion',async()=>fixture(async({s,post,run,m,fields,f})=>{
 const target='cache/__mock__/locked',preview=await post({cmd:'previewdestroy',zdataset:target,recursive:'1'});
 const answer=await post({cmd:'destroydataset',zdataset:target,force:'1',expected_guid:m.datasets[target].guid,preview_id:preview.preview_id,preview_token:preview.token});assert.equal(answer.job?.state,'queued');
 const live=s.readModel();live.snapshots[target+'@new']={...live.snapshots['cache/__mock__/project@base'],name:target+'@new',guid:'987654321'};s.writeModel(live);
 const changed=await run(answer.job.id);assert.equal(changed.state,'failed');assert.equal(changed.result.attempted,false);assert.ok(s.readModel().datasets[target]);assert.ok(s.readModel().snapshots[target+'@new']);
 const directory=await post(fields);assert.equal(directory.job?.state,'queued');const cfg='/boot/config/plugins/zfs.master.ui/zfs.master.ui.cfg';s.php.writeFile(cfg,s.php.readFileAsText(cfg).replace('destructive_mode = "1"','destructive_mode = "0"'));
 const disabled=await run(directory.job.id);assert.equal(disabled.state,'failed');assert.equal(disabled.error_code,'destructive_mode');assert.equal(s.php.fileExists(f.paths.delete+'/retained.txt'),true);
}));

test('post-publication sync failure leaves one real queued deletion and reports uncertainty',async()=>fixture(async({s,post,fields,f})=>{
 const path='/app/src/include/ZFSMJobs.php';s.php.writeFile(path,s.php.readFileAsText(path).replace('zfsmAuditSyncDirectory(dirname($file));',"if(($data['schema']??null)===6)throw new RuntimeException('Synthetic post-publication sync failure');zfsmAuditSyncDirectory(dirname($file));"));
 const answer=await post(fields);assert.match(JSON.stringify(answer.failed),/queue outcome is uncertain/);assert.equal(s.php.fileExists(f.paths.delete+'/retained.txt'),true);
 const jobs=(await post({cmd:'conversionjobs'})).jobs;assert.equal(jobs.length,1);assert.equal(answer.job?.id,jobs[0].id);assert.equal(jobs[0].state,'queued');assert.equal(jobs[0].rejected,false);
}));

test('worker launch failure preserves the queued deletion and explains that it has not finished',async()=>fixture(async({s,post,fields,f})=>{
 const path='/app/src/include/ZFSMJobs.php';s.php.writeFile(path,s.php.readFileAsText(path).replace('function zfsmStartWorker(){return true;}',"function zfsmStartWorker() { throw new RuntimeException('Synthetic launch failure'); }"));
 const answer=await post(fields);assert.equal(answer.job?.state,'queued');assert.match(answer.worker_warning,/worker could not start/);assert.equal(s.php.fileExists(f.paths.delete+'/retained.txt'),true);assert.equal((await post({cmd:'conversionjobs'})).jobs.length,1);
}));

test('large reviewed deletion remains readable after execution; full outcome counts survive bounded identity examples',async()=>fixture(async({s,post,run,m})=>{
 const target='cache/__mock__/locked',model=s.readModel(),template=model.snapshots['cache/__mock__/project@base'];
 for(let i=0;i<170;i++){const name=target+'@'+String(i).padStart(3,'0')+'x'.repeat(160);model.snapshots[name]={...template,name,guid:String(8000000+i)};}s.writeModel(model);
 const preview=await post({cmd:'previewdestroy',zdataset:target,recursive:'1'}),answer=await post({cmd:'destroydataset',zdataset:target,force:'1',expected_guid:m.datasets[target].guid,preview_id:preview.preview_id,preview_token:preview.token});assert.equal(answer.job?.state,'queued',JSON.stringify(answer.failed));
 const done=await run(answer.job.id);assert.equal(done.state,'completed');assert.equal(done.result.removed_count,171);assert.equal(done.result.remaining_count,0);assert.equal(done.result.removed.length,3);
 const stored=s.php.readFileAsText('/boot/config/plugins/zfs.master.ui/jobs/'+done.id+'.json');assert.ok(Buffer.byteLength(stored)<131072);const shown=(await post({cmd:'conversionjobs'})).jobs.find(j=>j.id===done.id);assert.equal(shown.state,'completed');assert.equal(shown.diagnostics.issue,null);
}));
