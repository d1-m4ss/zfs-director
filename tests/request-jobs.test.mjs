import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {startIntegration} from './integration/server.mjs';

async function fixture(fn){const s=await startIntegration({dependencyUsage:true});try{
 const post=async fields=>(await fetch(s.url+'/plugins/zfs.master.ui/backend/ZFSMAdmin.php',{method:'POST',body:new URLSearchParams({csrf_token:'integration-token',...fields})})).json();
 await fn({s,post,model:s.readModel(),target:'cache/__mock__/project'});
}finally{await s.close();}}

test('snapshot creation appears once in Jobs with recorded stages, terminal result and no replay actions',async()=>fixture(async({s,post,model,target})=>{
 const a=await post({cmd:'snapshotdataset',zdataset:target,recursive:'0',expected_guid:model.datasets[target].guid});assert.deepEqual(a.failed,[]);assert.equal(a.job?.state,'completed');assert.equal(a.job.command,'snapshotdataset');assert.equal(a.job.type,'operation');
 const list=await post({cmd:'conversionjobs'});assert.equal(list.jobs.length,1);const j=list.jobs[0];assert.equal(j.id,a.job.id);assert.equal(j.diagnostics.issue,null);assert.deepEqual(j.actions,{cancel:false,resume:false,download:false,inspect:true});assert.ok(j.stage_history.some(e=>e.stage==='executing_operation'));assert.equal(j.stage_history.at(-1).state,'completed');assert.ok(j.result.summary);
 assert.match(j.audit_id,/^[a-f0-9]{32}$/);const audit=(await post({cmd:'auditlog'})).entries;assert.ok(audit.some(e=>e.operation_id===j.audit_id&&e.phase==='outcome'));
 const calls=s.readModel().calls.length;await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';zfsmObserveRequestJob('${j.id}');`});assert.equal(s.readModel().calls.length,calls);
}));

test('invalid downloads and secret-bearing unlock refusals are journaled without secrets or payloads',async()=>fixture(async({post,model,target})=>{
 const a=await post({cmd:'downloadsnapshotarchive',job_id:'invalid'});assert.equal(a.job?.state,'failed');assert.equal(a.job.type,'download');
 const b=await post({cmd:'unlockdataset',zdataset:target,expected_guid:'999999',passphrase:'DO-NOT-PERSIST-THIS-KEY'});assert.equal(b.job?.state,'failed');assert.doesNotMatch(JSON.stringify((await post({cmd:'conversionjobs'})).jobs),/DO-NOT-PERSIST-THIS-KEY|passphrase/);
}));

test('authenticated refusals of synchronous and file-queue operations remain visible; readonly and CSRF do not create jobs',async()=>fixture(async({post,model,target})=>{
 await post({cmd:'inventory'});await post({cmd:'snapshotdataset',zdataset:target,expected_guid:model.datasets[target].guid,csrf_token:'wrong'});assert.equal((await post({cmd:'conversionjobs'})).jobs.length,0);
 const bad=await post({cmd:'snapshotdataset',zdataset:target,expected_guid:'999999'});assert.equal(bad.job?.state,'failed');assert.match(bad.job.error,/identity|GUID|refresh/i);
 const restore=await post({cmd:'restoresnapshotfiles',preview_id:'invalid',preview_token:'PRIVATE-TOKEN',confirmed:'1'});assert.equal(restore.job?.state,'failed');assert.equal(restore.job.command,'restoresnapshotfiles');assert.doesNotMatch(JSON.stringify(restore.job),/PRIVATE-TOKEN/);assert.equal((await post({cmd:'conversionjobs'})).jobs.length,2);
}));

test('signed restore refusal retains reviewed context when the destination becomes readonly',async()=>fixture(async({s,post,model,target})=>{
 const snapshot=target+'@base',preview=await post({cmd:'previewrestore',snapshot,snapshot_guid:model.snapshots[snapshot].guid,'selection[0]':'notes.txt',target:'restored',mode:'new'});assert.ok(preview.token);
 const changed=s.readModel();changed.datasets[target].readonly='on';s.writeModel(changed);
 const answer=await post({cmd:'restoresnapshotfiles',preview_id:preview.id,preview_token:preview.token,confirmed:'1'});
 assert.equal(answer.job?.schema,7);assert.equal(answer.job.type,'operation');assert.equal(answer.job.state,'failed');assert.equal(answer.job.stage,'preflight_rejected');
 assert.equal(answer.job.source,snapshot);assert.equal(answer.job.snapshot,snapshot);assert.equal(answer.job.dataset,target);assert.equal(answer.job.target,'/mnt/cache/__mock__/project/restored');assert.match(answer.job.error,/read.only/i);
 const listed=(await post({cmd:'conversionjobs'})).jobs.find(j=>j.id===answer.job.id);assert.equal(listed.diagnostics.issue,null);assert.deepEqual(listed.actions,{cancel:false,resume:false,download:false,inspect:true});assert.doesNotMatch(JSON.stringify(listed),new RegExp(preview.token));
 const before=s.readModel();await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';zfsmObserveRequestJob('${answer.job.id}');`});assert.deepEqual(s.readModel(),before);
}));

test('signed restore context survives identity refusal without misreporting readonly as the cause',async()=>fixture(async({s,post,model,target})=>{
 const snapshot=target+'@base',preview=await post({cmd:'previewrestore',snapshot,snapshot_guid:model.snapshots[snapshot].guid,'selection[0]':'notes.txt',target:'',mode:'overwrite'});assert.ok(preview.token);
 const changed=s.readModel();changed.datasets[target].guid='999999';changed.datasets[target].readonly='on';s.writeModel(changed);
 const answer=await post({cmd:'restoresnapshotfiles',preview_id:preview.id,preview_token:preview.token,confirmed:'1',snapshot:'cache/spoofed@fake',zdataset:'cache/spoofed',target:'/spoofed'});
 assert.equal(answer.job?.state,'failed');assert.equal(answer.job.source,snapshot);assert.equal(answer.job.dataset,target);assert.equal(answer.job.target,'/mnt/cache/__mock__/project');assert.match(answer.job.error,/identity/i);assert.doesNotMatch(JSON.stringify(answer.job),/spoofed/);
 assert.equal(s.readModel().helper_calls.length,1);
}));

for(const reason of ['expired preview','untrusted queue lock'])test('signed restore context is available before '+reason+' rejection',async()=>fixture(async({s,post,model,target})=>{
 const snapshot=target+'@base',preview=await post({cmd:'previewrestore',snapshot,snapshot_guid:model.snapshots[snapshot].guid,'selection[0]':'notes.txt',target:'restored',mode:'new'});assert.ok(preview.token);
 const prepare=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';${reason==='expired preview'?`$file=zfsmRestorePreviewFile('${preview.id}');$document=json_decode(file_get_contents($file),true);$document['expires']=time()-1;zfsmJobAtomicWrite($file,$document);echo zfsmRestoreSignature($document,'integration-token');`:`symlink('/acceptance/model.json',zfsmJobDirectory($GLOBALS['plugin_state']).'/restore-queue.lock');`}`});assert.equal(prepare.errors,'');
 const answer=await post({cmd:'restoresnapshotfiles',preview_id:preview.id,preview_token:prepare.text||preview.token,confirmed:'1'});assert.equal(answer.job?.state,'failed');assert.equal(answer.job.source,snapshot);assert.equal(answer.job.dataset,target);assert.equal(answer.job.target,'/mnt/cache/__mock__/project/restored');assert.equal(s.readModel().helper_calls.length,1);
}));

test('invalid restore signatures cannot add claimed or preview context to the refusal journal',async()=>fixture(async({s,post,model,target})=>{
 const snapshot=target+'@base',preview=await post({cmd:'previewrestore',snapshot,snapshot_guid:model.snapshots[snapshot].guid,'selection[0]':'notes.txt',target:'restored',mode:'new'});assert.ok(preview.token);
 const answer=await post({cmd:'restoresnapshotfiles',preview_id:preview.id,preview_token:'PRIVATE-INVALID-TOKEN',confirmed:'1',snapshot:'cache/spoofed@fake',zdataset:'cache/spoofed',target:'/spoofed'});
 assert.equal(answer.job?.state,'failed');assert.equal(answer.job.source,'Restore files');assert.equal(answer.job.snapshot,undefined);assert.equal(answer.job.dataset,undefined);assert.equal(answer.job.target,undefined);assert.doesNotMatch(JSON.stringify(answer.job),/spoofed|PRIVATE-INVALID-TOKEN|restored/);assert.equal(s.readModel().helper_calls.length,1);
}));

test('operation categories include refusal journals while preserving native types and malformed journal visibility',async()=>fixture(async({s})=>{
 const r=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';$category=function_exists('zfsmRequestJobCategory')?'zfsmRequestJobCategory':fn($job)=>$job['type']??'unknown';$out=[];foreach(['restoresnapshotfiles','rollbacksnapshot','archivesnapshotfiles','convertdirectory','deletedirectory','destroydataset','destroysnapshot','protectionrun','snapshotdataset']as$command)$out[]=$category(['schema'=>7,'type'=>'operation','command'=>$command]);foreach([['schema'=>2,'type'=>'restore'],['schema'=>4,'type'=>'replication'],['schema'=>7,'type'=>'download','command'=>'downloadsnapshotarchive'],['schema'=>7,'type'=>'operation','command'=>[]],['schema'=>7]]as$job)$out[]=$category($job);echo json_encode($out);`});assert.equal(r.errors,'');assert.deepEqual(JSON.parse(r.text),['restore','restore','archive','conversion','deletion','deletion','deletion','operation','snapshot','restore','replication','download','operation','unknown']);
}));

test('existing queued directory deletion keeps its original Job without a duplicate request journal',async()=>fixture(async({post,model})=>{
 const f=model.directory_fixtures,i=f.metadata[f.paths.delete].identity;
 const a=await post({cmd:'deletedirectory',directory:f.paths.delete,force:'1',expected_guid:model.datasets[f.owner].guid,'directory_identity[dev]':i.dev,'directory_identity[ino]':i.ino});assert.equal(a.job?.schema,6);assert.equal(a.job.state,'queued');assert.equal((await post({cmd:'conversionjobs'})).jobs.length,1);
}));

test('recording failure stops a mutation before it runs and never reports unjournaled success',async()=>fixture(async({s,post,model,target})=>{
 const file='/app/src/include/ZFSMJobs.php';s.php.writeFile(file,s.php.readFileAsText(file).replace('function zfsmJobAtomicWrite($file,$data) {',"function zfsmJobAtomicWrite($file,$data) { if(($data['schema']??null)===7)throw new RuntimeException('Synthetic unavailable job journal');"));
 const before=Object.keys(s.readModel().snapshots);const a=await post({cmd:'snapshotdataset',zdataset:target,recursive:'0',expected_guid:model.datasets[target].guid});assert.ok(Object.keys(a.failed).length);assert.deepEqual(Object.keys(s.readModel().snapshots),before);
}));

test('observer cannot overwrite a final result published after its stale read',async()=>fixture(async({s})=>{
 const file='/app/src/include/ZFSMRequestJobs.php',source=s.php.readFileAsText(file),start=source.indexOf('function zfsmRequestJobActive('),end=source.indexOf('function zfsmObserveRequestJob(',start);
 s.php.writeFile(file,source.slice(0,start)+"function zfsmRequestJobActive($job){if(!empty($GLOBALS['finish_race'])){$GLOBALS['finish_race']=false;zfsmRequestJobFinish('completed','Native result published');}return false;}\n"+source.slice(end));
 const r=await s.run({code:"<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';$j=zfsmRequestJobBegin('snapshotdataset',['zdataset'=>'cache/__mock__/project']);$GLOBALS['finish_race']=true;echo json_encode(zfsmObserveRequestJob($j['id']));"});assert.equal(r.errors,'');assert.equal(JSON.parse(r.text).state,'completed');
}));

test('uncertain audit outcome after native success remains inspection-required with safe error context',async()=>fixture(async({s,post,model,target})=>{
 const file='/app/src/include/ZFSMAudit.php';s.php.writeFile(file,s.php.readFileAsText(file).replace('function zfsmAuditFinish($id, $outcome): void {',"function zfsmAuditFinish($id, $outcome): void { throw new RuntimeException('Synthetic final audit unavailable');"));
 const before=Object.keys(s.readModel().snapshots).length;const a=await post({cmd:'snapshotdataset',zdataset:target,recursive:'0',expected_guid:model.datasets[target].guid});assert.equal(Object.keys(s.readModel().snapshots).length,before+1);assert.equal(a.job?.state,'recovery_required');assert.match(a.job.result.summary,/may have completed.*inspect/i);
}));
test('request operation coverage is explicit and includes Job controls and excludes read-only views',async()=>fixture(async({s})=>{
 const r=await s.run({code:"<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';echo json_encode(array_keys(zfsmRequestJobCommands()));"});const commands=JSON.parse(r.text);
 for(const c of ['restoresnapshotfiles','rollbacksnapshot','downloadsnapshotfile','downloadsnapshotarchive','archivesnapshotfiles','convertdirectory','movedirectory','cleanupmutation','deletedirectory','destroydataset','destroysnapshot','snapshotdataset','createdataset','renamedataset','lockdataset','unlockdataset','promotedataset','renamesnapshot','holdsnapshot','releasesnapshot','clonesnapshot','protectionrun','scrubpool','editdatasetproperty','editacl','setquota','activityvisibility','cancelconversion','resumeconversion','cancelrestore','protectioncancel'])assert.ok(commands.includes(c),c);
 for(const c of ['inventory','snapshotfiles','previewrestore','previewdestroy','protectionrunpreview','refresh'])assert.equal(commands.includes(c),false,c);
}));
test('Jobs API preserves completed transfer 100 percent over last transient 99 percent',async()=>fixture(async({s,post})=>{
 const r=await s.run({code:"<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';$j=zfsmRequestJobBegin('downloadsnapshotfile',['snapshot'=>'cache/__mock__/project@base']);zfsmRequestJobProgress(6,6);zfsmRequestJobFinish('completed','Server transfer finished');echo $j['id'];"});const job=(await post({cmd:'conversionjobs'})).jobs.find(j=>j.id===r.text);assert.equal(job.state,'completed');assert.equal(job.progress.percent,100);
}));

test('Jobs Restore filter includes request refusals while Other operations remains compatible',async()=>fixture(async({post})=>{
 const refused=await post({cmd:'restoresnapshotfiles',preview_id:'invalid',preview_token:'NEVER-PERSIST',confirmed:'1'});assert.equal(refused.job.state,'failed');
 const restore=await post({cmd:'conversionjobs',filter:'restore',sort:'newest',view:'all'});assert.ok(restore.jobs.some(j=>j.id===refused.job.id),'A refused restore must remain reachable in Restore, including historical schema7 journals');
 const operations=await post({cmd:'conversionjobs',filter:'operation',sort:'newest',view:'all'});assert.ok(operations.jobs.some(j=>j.id===refused.job.id));
 const deletion=await post({cmd:'conversionjobs',filter:'deletion',sort:'newest',view:'all'});assert.ok(!deletion.jobs.some(j=>j.id===refused.job.id));
}));

for(const command of ['cancelconversion','resumeconversion','cancelrestore','protectioncancel','activityvisibility'])test(command+' refusal is recorded in Jobs without touching data',async()=>fixture(async({s,post})=>{
 const before=s.readModel(),answer=await post({cmd:command});assert.ok(Object.keys(answer.failed).length);
 const jobs=(await post({cmd:'conversionjobs',filter:'all'})).jobs;assert.equal(jobs.length,1);assert.equal(jobs[0].command,command);assert.equal(jobs[0].state,'failed');assert.deepEqual(s.readModel().datasets,before.datasets);
}));

test('snapshot creation has its own Jobs filter',async()=>fixture(async({post,model,target})=>{
 const answer=await post({cmd:'snapshotdataset',zdataset:target,recursive:'0',expected_guid:model.datasets[target].guid});assert.equal(answer.job?.state,'completed');
 const page=await post({cmd:'conversionjobs',filter:'snapshot'});assert.equal(page.jobs?.length,1,JSON.stringify(page));assert.equal(page.jobs[0].command,'snapshotdataset');
}));

test('signed definition review gives Jobs its policy name, dataset and remove action; bad signatures do not',async()=>fixture(async({s})=>{
 const r=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';$out=[];foreach([false,true]as$valid){$job=zfsmRequestJobBegin('protectioncontrol',['cmd'=>'protectioncontrol','type'=>'replication','name'=>'SPOOFED']);$preview=zfsmProtectionPreview(['type'=>'definition_control','value'=>['type'=>'policy','id'=>'abc','action'=>'remove'],'definition'=>['id'=>'abc','name'=>'Nightly snapshots','dataset'=>'cache/test']],'secret','fingerprint');try{zfsmProtectionConsumePreview(['preview_id'=>$preview['preview_id'],'token'=>$valid?$preview['token']:'wrong'],'secret','fingerprint');}catch(Throwable$e){}$out[]=zfsmRequestJobFinish('completed','Reviewed test');}echo json_encode($out);`});assert.equal(r.errors,'');const [bad,good]=JSON.parse(r.text);assert.equal(bad.category,undefined);assert.equal(good.category,'policy');assert.equal(good.source,'cache/test');assert.equal(good.definition_name,'Nightly snapshots');assert.equal(good.definition_action,'remove');assert.doesNotMatch(JSON.stringify([bad,good]),/SPOOFED|secret|fingerprint/);
}));


test('every administrative mutation is covered by a Jobs journal registry entry',async()=>fixture(async({s})=>{
 const r=await s.run({code:"<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';echo json_encode(array_keys(zfsmRequestJobCommands()));"});
 const registered=new Set(JSON.parse(r.text)),source=readFileSync('src/backend/ZFSMAdmin.php','utf8');
 const assignments=source.match(/\$administrative(?:\s*=\s*[^;]+|\[\]\s*=\s*[^;]+)/g)||[];
 const administrative=new Set(assignments.flatMap(a=>[...a.matchAll(/'([a-z]+)'/g)].map(m=>m[1])));
 assert.ok(administrative.size>35);for(const command of administrative)if(command!=='refresh')assert.ok(registered.has(command),'Missing operation journal: '+command);
}));

test('wrong-type control parent is refused with a valid journal, not an invalid history record',async()=>fixture(async({s,post})=>{
 const r=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';$definition=['id'=>'abc','owner'=>'managed','dataset'=>'cache/__mock__/project','source_guid'=>'123'];$j=zfsmNewProtectionJob('policy',$definition);zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);echo $j['id'];`});assert.equal(r.errors,'');const answer=await post({cmd:'cancelconversion',job_id:r.text});assert.ok(Object.keys(answer.failed).length);const jobs=(await post({cmd:'conversionjobs',filter:'all'})).jobs;const observation=jobs.find(j=>j.command==='cancelconversion');assert.ok(observation);assert.equal(observation.diagnostics.issue,null);assert.equal(observation.state,'failed');assert.equal(observation.parent_job_id,r.text);
}));
