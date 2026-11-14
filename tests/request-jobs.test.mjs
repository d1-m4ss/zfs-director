import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {startIntegration} from './integration/server.mjs';

async function fixture(fn){const s=await startIntegration({dependencyUsage:true});try{
 const post=async fields=>(await fetch(s.url+'/plugins/zfs.master.ui/backend/ZFSMAdmin.php',{method:'POST',body:new URLSearchParams({csrf_token:'integration-token',...fields})})).json();
 await fn({s,post,model:s.readModel(),target:'cache/__mock__/project'});
}finally{await s.close();}}

test('a successful snapshot is recorded in the audit log only, not in Jobs',async()=>fixture(async({s,post,model,target})=>{
 const a=await post({cmd:'snapshotdataset',zdataset:target,recursive:'0',expected_guid:model.datasets[target].guid});assert.deepEqual(a.failed,[]);assert.equal(a.job,undefined);
 const list=await post({cmd:'conversionjobs',listed:'0'});assert.equal(list.jobs.length,0);
 const audit=(await post({cmd:'auditlog'})).entries;assert.ok(audit.some(e=>e.command==='snapshotdataset'&&e.phase==='outcome'&&e.status==='succeeded'));
}));
test('a failed snapshot request writes no journal: the error is in the dialog answer and the audit log',async()=>fixture(async({s,post,model,target})=>{
 const a=await post({cmd:'snapshotdataset',zdataset:target,recursive:'0',expected_guid:'999999'});assert.ok(Object.keys(a.failed).length);assert.equal(a.job,undefined);
 assert.equal((await post({cmd:'conversionjobs',listed:'0'})).jobs.length,0,'no journal is written');
 const audit=(await post({cmd:'auditlog'})).entries;assert.ok(audit.some(e=>e.command==='snapshotdataset'&&e.phase==='outcome'&&e.status==='failed'));
}));

test('invalid downloads are journaled; secret-bearing unlock refusals write no journal and no secret',async()=>fixture(async({post,model,target})=>{
 const a=await post({cmd:'downloadsnapshotarchive',job_id:'invalid'});assert.equal(a.job?.state,'failed');assert.equal(a.job.type,'download');
 const b=await post({cmd:'unlockdataset',zdataset:target,expected_guid:'999999',passphrase:'DO-NOT-PERSIST-THIS-KEY'});assert.ok(Object.keys(b.failed).length);assert.equal(b.job,undefined);assert.doesNotMatch(JSON.stringify((await post({cmd:'conversionjobs',listed:'0'})).jobs),/DO-NOT-PERSIST-THIS-KEY|passphrase/);
}));

test('refusals of synchronous and file-queue operations write no journal; CSRF does not either',async()=>fixture(async({post,model,target})=>{
 await post({cmd:'inventory'});await post({cmd:'snapshotdataset',zdataset:target,expected_guid:model.datasets[target].guid,csrf_token:'wrong'});assert.equal((await post({cmd:'conversionjobs',listed:'0'})).jobs.length,0);
 const bad=await post({cmd:'snapshotdataset',zdataset:target,expected_guid:'999999'});assert.equal(bad.job,undefined);assert.match(Object.values(bad.failed).join(' '),/identity|GUID|refresh/i);
 const restore=await post({cmd:'restoresnapshotfiles',preview_id:'invalid',preview_token:'PRIVATE-TOKEN',confirmed:'1'});assert.ok(Object.keys(restore.failed).length);assert.equal(restore.job,undefined);assert.equal((await post({cmd:'conversionjobs',listed:'0'})).jobs.length,0);
}));

test('a signed restore refused because the destination became readonly writes no journal and says why',async()=>fixture(async({s,post,model,target})=>{
 const snapshot=target+'@base',preview=await post({cmd:'previewrestore',snapshot,snapshot_guid:model.snapshots[snapshot].guid,'selection[0]':'notes.txt',target:'restored',mode:'new'});assert.ok(preview.token);
 const changed=s.readModel();changed.datasets[target].readonly='on';s.writeModel(changed);
 const answer=await post({cmd:'restoresnapshotfiles',preview_id:preview.id,preview_token:preview.token,confirmed:'1'});
 assert.equal(answer.job,undefined);assert.match(Object.values(answer.failed).join(' '),/read.only/i);assert.equal((await post({cmd:'conversionjobs',listed:'0'})).jobs.length,0);
}));

test('a signed restore refused on identity writes no journal and does not blame readonly',async()=>fixture(async({s,post,model,target})=>{
 const snapshot=target+'@base',preview=await post({cmd:'previewrestore',snapshot,snapshot_guid:model.snapshots[snapshot].guid,'selection[0]':'notes.txt',target:'',mode:'overwrite'});assert.ok(preview.token);
 const changed=s.readModel();changed.datasets[target].guid='999999';changed.datasets[target].readonly='on';s.writeModel(changed);
 const answer=await post({cmd:'restoresnapshotfiles',preview_id:preview.id,preview_token:preview.token,confirmed:'1',snapshot:'cache/spoofed@fake',zdataset:'cache/spoofed',target:'/spoofed'});
 assert.equal(answer.job,undefined);assert.match(Object.values(answer.failed).join(' '),/identity/i);assert.doesNotMatch(Object.values(answer.failed).join(' '),/read.only/i);assert.equal((await post({cmd:'conversionjobs',listed:'0'})).jobs.length,0);
 assert.equal(s.readModel().helper_calls.length,1);
}));

for(const reason of ['expired preview','untrusted queue lock'])test('a signed restore rejected for '+reason+' writes no journal',async()=>fixture(async({s,post,model,target})=>{
 const snapshot=target+'@base',preview=await post({cmd:'previewrestore',snapshot,snapshot_guid:model.snapshots[snapshot].guid,'selection[0]':'notes.txt',target:'restored',mode:'new'});assert.ok(preview.token);
 const prepare=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';${reason==='expired preview'?`$file=zfsmRestorePreviewFile('${preview.id}');$document=json_decode(file_get_contents($file),true);$document['expires']=time()-1;zfsmJobAtomicWrite($file,$document);echo zfsmRestoreSignature($document,'integration-token');`:`symlink('/acceptance/model.json',zfsmJobDirectory($GLOBALS['plugin_state']).'/restore-queue.lock');`}`});assert.equal(prepare.errors,'');
 const answer=await post({cmd:'restoresnapshotfiles',preview_id:preview.id,preview_token:prepare.text||preview.token,confirmed:'1'});assert.ok(Object.keys(answer.failed).length);assert.equal(answer.job,undefined);assert.equal((await post({cmd:'conversionjobs',listed:'0'})).jobs.length,0);assert.equal(s.readModel().helper_calls.length,1);
}));

test('an invalid restore signature writes no journal and echoes no claimed context or token',async()=>fixture(async({s,post,model,target})=>{
 const snapshot=target+'@base',preview=await post({cmd:'previewrestore',snapshot,snapshot_guid:model.snapshots[snapshot].guid,'selection[0]':'notes.txt',target:'restored',mode:'new'});assert.ok(preview.token);
 const answer=await post({cmd:'restoresnapshotfiles',preview_id:preview.id,preview_token:'PRIVATE-INVALID-TOKEN',confirmed:'1',snapshot:'cache/spoofed@fake',zdataset:'cache/spoofed',target:'/spoofed'});
 assert.equal(answer.job,undefined);assert.equal((await post({cmd:'conversionjobs',listed:'0'})).jobs.length,0);assert.doesNotMatch(JSON.stringify(answer),/spoofed|PRIVATE-INVALID-TOKEN|restored/);assert.equal(s.readModel().helper_calls.length,1);
}));

test('operation categories include refusal journals while preserving native types and malformed journal visibility',async()=>fixture(async({s})=>{
 const r=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';$category=function_exists('zfsmRequestJobCategory')?'zfsmRequestJobCategory':fn($job)=>$job['type']??'unknown';$out=[];foreach(['restoresnapshotfiles','rollbacksnapshot','archivesnapshotfiles','convertdirectory','deletedirectory','destroydataset','destroysnapshot','protectionrun','snapshotdataset']as$command)$out[]=$category(['schema'=>7,'type'=>'operation','command'=>$command]);foreach([['schema'=>2,'type'=>'restore'],['schema'=>4,'type'=>'replication'],['schema'=>7,'type'=>'download','command'=>'downloadsnapshotarchive'],['schema'=>7,'type'=>'operation','command'=>[]],['schema'=>7]]as$job)$out[]=$category($job);echo json_encode($out);`});assert.equal(r.errors,'');assert.deepEqual(JSON.parse(r.text),['restore','restore','archive','conversion','deletion','deletion','deletion','operation','snapshot','restore','replication','download','operation','unknown']);
}));

test('existing queued directory deletion keeps its original Job without a duplicate request journal',async()=>fixture(async({post,model})=>{
 const f=model.directory_fixtures,i=f.metadata[f.paths.delete].identity;
 const a=await post({cmd:'deletedirectory',directory:f.paths.delete,force:'1',expected_guid:model.datasets[f.owner].guid,'directory_identity[dev]':i.dev,'directory_identity[ino]':i.ino});assert.equal(a.job?.schema,6);assert.equal(a.job.state,'queued');assert.equal((await post({cmd:'conversionjobs',listed:'0'})).jobs.length,1);
}));

test('an unavailable history record stops a mutation before it runs and never reports unrecorded success',async()=>fixture(async({s,post,model,target})=>{
 const file='/app/src/include/ZFSMAudit.php';s.php.writeFile(file,s.php.readFileAsText(file).replace('function zfsmAuditAppend(array $entry): void {',"function zfsmAuditAppend(array $entry): void { throw new RuntimeException('Synthetic unavailable audit history');"));
 const before=Object.keys(s.readModel().snapshots);const a=await post({cmd:'snapshotdataset',zdataset:target,recursive:'0',expected_guid:model.datasets[target].guid});assert.ok(Object.keys(a.failed).length);assert.deepEqual(Object.keys(s.readModel().snapshots),before);
}));

test('observer cannot overwrite a final result published after its stale read',async()=>fixture(async({s})=>{
 const file='/app/src/include/ZFSMRequestJobs.php',source=s.php.readFileAsText(file),start=source.indexOf('function zfsmRequestJobActive('),end=source.indexOf('function zfsmObserveRequestJob(',start);
 s.php.writeFile(file,source.slice(0,start)+"function zfsmRequestJobActive($job){if(!empty($GLOBALS['finish_race'])){$GLOBALS['finish_race']=false;zfsmRequestJobFinish('completed','Native result published');}return false;}\n"+source.slice(end));
 const r=await s.run({code:"<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';$j=zfsmRequestJobBegin('snapshotdataset',['zdataset'=>'cache/__mock__/project']);$GLOBALS['finish_race']=true;echo json_encode(zfsmObserveRequestJob($j['id']));"});assert.equal(r.errors,'');assert.equal(JSON.parse(r.text).state,'completed');
}));

test('uncertain audit outcome after native success writes no journal and the answer says to inspect',async()=>fixture(async({s,post,model,target})=>{
 const file='/app/src/include/ZFSMAudit.php';s.php.writeFile(file,s.php.readFileAsText(file).replace('function zfsmAuditFinish($id, $outcome): void {',"function zfsmAuditFinish($id, $outcome): void { throw new RuntimeException('Synthetic final audit unavailable');"));
 const before=Object.keys(s.readModel().snapshots).length;const a=await post({cmd:'snapshotdataset',zdataset:target,recursive:'0',expected_guid:model.datasets[target].guid});assert.equal(Object.keys(s.readModel().snapshots).length,before+1);assert.equal(a.job,undefined);assert.ok(Object.keys(a.failed).length);assert.equal((await post({cmd:'conversionjobs',listed:'0'})).jobs.length,0);
}));
test('request operation coverage is explicit and includes Job controls and excludes read-only views',async()=>fixture(async({s})=>{
 const r=await s.run({code:"<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';echo json_encode(array_keys(zfsmRequestJobCommands()));"});const commands=JSON.parse(r.text);
 for(const c of ['restoresnapshotfiles','rollbacksnapshot','downloadsnapshotfile','downloadsnapshotarchive','archivesnapshotfiles','convertdirectory','movedirectory','cleanupmutation','deletedirectory','destroydataset','destroysnapshot','snapshotdataset','createdataset','renamedataset','lockdataset','unlockdataset','promotedataset','renamesnapshot','holdsnapshot','releasesnapshot','clonesnapshot','protectionrun','scrubpool','editdatasetproperty','editacl','setquota','activityvisibility','cancelconversion','resumeconversion','cancelrestore','protectioncancel'])assert.ok(commands.includes(c),c);
 for(const c of ['inventory','snapshotfiles','previewrestore','previewdestroy','protectionrunpreview','refresh'])assert.equal(commands.includes(c),false,c);
}));
test('Jobs API preserves completed transfer 100 percent over last transient 99 percent',async()=>fixture(async({s,post})=>{
 const r=await s.run({code:"<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';$j=zfsmRequestJobBegin('downloadsnapshotfile',['snapshot'=>'cache/__mock__/project@base']);zfsmRequestJobProgress(6,6);zfsmRequestJobFinish('completed','Server transfer finished');echo $j['id'];"});const job=(await post({cmd:'conversionjobs',listed:'0'})).jobs.find(j=>j.id===r.text);assert.equal(job.state,'completed');assert.equal(job.progress.percent,100);
}));

test('a refused restore is not kept as a hidden journal',async()=>fixture(async({post})=>{
 const refused=await post({cmd:'restoresnapshotfiles',preview_id:'invalid',preview_token:'NEVER-PERSIST',confirmed:'1'});assert.ok(Object.keys(refused.failed).length);assert.equal(refused.job,undefined);
 for(const filter of ['restore','operation','all'])assert.equal((await post({cmd:'conversionjobs',listed:'0',filter,sort:'newest',view:'all'})).jobs.length,0,filter);
}));

for(const command of ['cancelconversion','resumeconversion','cancelrestore','protectioncancel','activityvisibility'])test(command+' refusal writes no journal and does not touch data',async()=>fixture(async({s,post})=>{
 const before=s.readModel(),answer=await post({cmd:command});assert.ok(Object.keys(answer.failed).length);
 assert.equal(answer.job,undefined);assert.equal((await post({cmd:'conversionjobs',listed:'0',filter:'all'})).jobs.length,0);assert.deepEqual(s.readModel().datasets,before.datasets);
}));

test('signed definition review gives Jobs its policy name, dataset and remove action; bad signatures do not',async()=>fixture(async({s})=>{
 const r=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';$out=[];foreach([false,true]as$valid){$job=zfsmRequestJobBegin('protectioncontrol',['cmd'=>'protectioncontrol','type'=>'replication','name'=>'SPOOFED']);$preview=zfsmProtectionPreview(['type'=>'definition_control','value'=>['type'=>'policy','id'=>'abc','action'=>'remove'],'definition'=>['id'=>'abc','name'=>'Nightly snapshots','dataset'=>'cache/test']],'secret','fingerprint');try{zfsmProtectionConsumePreview(['preview_id'=>$preview['preview_id'],'token'=>$valid?$preview['token']:'wrong'],'secret','fingerprint');}catch(Throwable$e){}$out[]=zfsmRequestJobFinish('completed','Reviewed test');}echo json_encode($out);`});assert.equal(r.errors,'');const [bad,good]=JSON.parse(r.text);assert.equal(bad.category,undefined);assert.equal(good.category,'policy');assert.equal(good.source,'cache/test');assert.equal(good.definition_name,'Nightly snapshots');assert.equal(good.definition_action,'remove');assert.doesNotMatch(JSON.stringify([bad,good]),/SPOOFED|secret|fingerprint/);
}));


test('every administrative mutation is covered by a Jobs journal registry entry',async()=>fixture(async({s})=>{
 const r=await s.run({code:"<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';echo json_encode(['labels'=>array_keys(zfsmRequestJobCommands()),'admin'=>array_keys(array_filter(zfsmCommandRegistry(),fn($c)=>$c['kind']==='admin'))]);"});
 const out=JSON.parse(r.text),registered=new Set(out.labels);
 assert.ok(out.admin.length>35);for(const command of out.admin)if(command!=='refresh')assert.ok(registered.has(command),'Missing operation journal: '+command);
}));

test('wrong-type control parent is refused without a journal and without damaging the parent',async()=>fixture(async({s,post})=>{
 const r=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';$definition=['id'=>'abc','owner'=>'managed','dataset'=>'cache/__mock__/project','source_guid'=>'123'];$j=zfsmNewProtectionJob('policy',$definition);zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);echo $j['id'];`});assert.equal(r.errors,'');const answer=await post({cmd:'cancelconversion',job_id:r.text});assert.ok(Object.keys(answer.failed).length);const jobs=(await post({cmd:'conversionjobs',listed:'0',filter:'all'})).jobs;assert.deepEqual(jobs.map(j=>j.id),[r.text]);assert.equal(jobs[0].diagnostics.issue,null);assert.equal(answer.job,undefined);
}));

// ARCH-005: request state lives in one explicit store with a fixed set of keys.
test('request context accepts only its known keys and resets in one call',async()=>fixture(async({s})=>{
 const r=await s.run({code:"<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';zfsmRequestSet('request_audit','a1');$before=zfsmRequestGet('request_audit');try{zfsmRequestSet('anything_else',1);$unknown=null;}catch(LogicException $e){$unknown=$e->getMessage();}zfsmRequestReset();echo json_encode(['before'=>$before,'after'=>zfsmRequestGet('request_audit','none'),'unknown'=>$unknown,'leftover_globals'=>array_values(array_filter(array_keys($GLOBALS),fn($k)=>in_array($k,['zfsm_job_request_command','zfsm_request_published_job','zfsm_job_request_audit','zfsm_job_failure_context','zfsm_request_audit','zfsm_conversion_journal_started','zfsm_deletion_journal_started','zfsm_request_restore_context'],true)))]);"});
 const out=JSON.parse(r.text);assert.equal(out.before,'a1');assert.equal(out.after,'none');assert.match(out.unknown,/Unknown request context key anything_else/);assert.deepEqual(out.leftover_globals,[]);
}));

test('the Jobs listing shows only functional work; a failed quick action leaves no journal',async()=>fixture(async({post,model,target})=>{
 const bad=await post({cmd:'snapshotdataset',zdataset:target,recursive:'0',expected_guid:'999999'});assert.equal(bad.job,undefined);
 assert.equal((await post({cmd:'conversionjobs'})).jobs.length,0);
 assert.equal((await post({cmd:'conversionjobs',listed:'0'})).jobs.length,0,'nothing is written to the job directory');
}));

test('journals of the removed Clean job history entry stay valid until they expire; the unfiltered page still carries every active job',async()=>fixture(async({s,post,model,target})=>{
 const seeded=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';zfsmRequestJobBegin('jobhistorycleanup',['cmd'=>'jobhistorycleanup']);$j=zfsmRequestJobFinish('completed','Removed 3 expired log records.','completed',['removed'=>3]);echo json_encode(['id'=>$j['id'],'problem'=>zfsmJobProblem(zfsmReadJob($j['id']))]);`});
 assert.equal(seeded.errors,'');assert.equal(JSON.parse(seeded.text).problem,null,'a journal written by an older version is not "invalid"');
 // One queued deletion that is older than twelve newer refusals must still be reachable without filters.
 const queued=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';$j=zfsmQueueDeletion('dataset','cache/__mock__/project',false,zfsmDestroyScope('cache/__mock__/project',false))['job'];echo json_encode(['id'=>$j['id'],'problem'=>zfsmJobProblem(zfsmReadJob($j['id']))]);`});
 const queuedId=JSON.parse(queued.text).id;assert.equal(JSON.parse(queued.text).problem,null,'fixture deletion journal is valid');{for(let i=0;i<12;i++)await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';zfsmRequestJobBegin('downloadsnapshotfile',['snapshot'=>'cache/__mock__/project@base']);zfsmRequestJobFinish('failed','Synthetic');`});const page=await post({cmd:'conversionjobs',page_size:'10'});assert.ok(page.jobs.some(j=>j.id===queuedId),'the active job is on the unfiltered page');}
}));
