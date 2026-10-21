import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';
import {startIntegration} from './integration/server.mjs';

async function fixture(fn){const s=await startIntegration({dependencyUsage:true});try{
 const m=s.readModel(),f=m.directory_fixtures,i=f.metadata[f.paths.convert].identity;
 const post=async extra=>(await fetch(s.url+'/plugins/zfs.master.ui/backend/ZFSMAdmin.php',{method:'POST',body:new URLSearchParams({csrf_token:'integration-token',cmd:'convertdirectory',directory:f.paths.convert,pool:'cache',offline_confirmed:'1',expected_guid:m.datasets[f.owner].guid,'directory_identity[dev]':i.dev,'directory_identity[ino]':i.ino,...extra})})).json();
 const run=async id=>{const r=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';echo json_encode(zfsmRunConversionJob(${JSON.stringify(id)}));`});assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);return JSON.parse(r.text);};
 await fn({s,m,f,post,run});
}finally{await s.close();}}

for(const source of ['local','inherited from cache'])test('conversion rejects effective readonly='+source+' before queuing or invoking a native helper',async()=>fixture(async({s,f,post})=>{
 const m=s.readModel();m.datasets[f.owner].readonly='on';m.datasets[f.owner]._sources={readonly:source};s.writeModel(m);
 const answer=await post();assert.match(JSON.stringify(answer.failed),/read.?only/i);assert.equal(answer.job?.schema,5);assert.equal(answer.job?.error_code,'readonly_parent');assert.match(answer.job.error,/read.?only/i);
 const live=s.readModel();assert.equal(live.calls.some(c=>c.command==='/usr/bin/perl'||c.command==='zfs'&&['create','mount','set'].includes(c.args[0])),false);
 assert.equal(s.php.readFileAsText(f.paths.convert+'/retained.txt'),'ordinary directory fixture; preserve source identity');
}));

test('queued conversion rechecks effective readonly under the operation lock before staging or target creation',async()=>fixture(async({s,f,post,run})=>{
 const answer=await post();assert.equal(answer.job?.state,'queued',JSON.stringify(answer));
 const m=s.readModel();m.datasets[f.owner].readonly='on';m.datasets[f.owner]._sources={readonly:'inherited from cache'};s.writeModel(m);
 const helpers='/app/src/include/ZFSMHelpers.php';s.php.writeFile(helpers,s.php.readFileAsText(helpers).replace('return integrationProcess($command,$args,$stdin);',"if($command==='zfs'&&$args===['get','-H','-o','value','readonly',"+JSON.stringify(f.owner)+"]){$m=integrationModel();$m['readonly_lock_held']=is_resource($GLOBALS['zfsm_operation_lock_handle']??null);integrationSave($m);}return integrationProcess($command,$args,$stdin);"));
 const job=await run(answer.job.id);assert.match(job.error,/read.?only/i);assert.equal(job.stage,'planned');assert.equal(job.state,'recovery_required');assert.equal(s.php.fileExists(job.staging),false);
 assert.equal(s.readModel().readonly_lock_held,true);assert.equal(s.readModel().calls.some(c=>c.command==='zfs'&&['create','mount','set'].includes(c.args[0])),false);
 assert.equal(s.php.readFileAsText(f.paths.convert+'/retained.txt'),'ordinary directory fixture; preserve source identity');
}));

test('readonly change at the final pre-create boundary cannot create a child dataset',async()=>fixture(async({s,f,post,run})=>{
 const answer=await post();assert.equal(answer.job?.state,'queued',JSON.stringify(answer));
 const permissions=await s.run({code:"<?php foreach(['/var','/var/tmp']as$p){if(!is_dir($p))mkdir($p);chmod($p,0755);}"});assert.equal(permissions.errors,'');
 const helper='/app/src/include/ZFSMConfinedConversion.php';s.php.writeFile(helper,s.php.readFileAsText(helper).replace('zfsmConfinedStageDirectory($job);',"zfsmConfinedStageDirectory($job);$m=integrationModel();$m['datasets']["+JSON.stringify(f.owner)+"]['readonly']='on';integrationSave($m);"));
 const job=await run(answer.job.id);assert.match(job.error,/read.?only/i);assert.equal(job.stage,'preparing');assert.equal(s.readModel().calls.some(c=>c.command==='zfs'&&c.args[0]==='create'),false);
 assert.equal(s.php.readFileAsText(f.paths.convert+'/retained.txt'),'ordinary directory fixture; preserve source identity');
}));

test('unknown effective readonly fails closed without a conversion journal or helper mutation',async()=>fixture(async({s,f,post})=>{
 const m=s.readModel();m.datasets[f.owner].readonly='-';s.writeModel(m);const answer=await post();assert.ok(Object.keys(answer.failed).length);assert.notEqual(answer.job?.schema,1);assert.match(JSON.stringify(answer.failed),/writable|readonly/i);
 assert.equal(s.readModel().calls.some(c=>c.command==='/usr/bin/perl'||c.command==='zfs'&&c.args[0]==='create'),false);
}));

test('new conversion journals retain originals under dated archived names without moving data at queue time',async()=>fixture(async({s,f,post})=>{
 const answer=await post(),job=answer.job;assert.equal(job?.state,'queued',JSON.stringify(answer));assert.match(job.recovery,/\/convert-0777_archived_[0-9]{8}-[0-9]{6}$/);assert.equal(s.php.fileExists(job.recovery),false);
 const r=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';echo json_encode(zfsmJobProblem(zfsmReadJob(${JSON.stringify(job.id)})));`});assert.equal(r.errors,'');assert.equal(r.text,'null');assert.equal(s.php.fileExists(f.paths.convert+'/retained.txt'),true);
}));

test('queue chooses a job-specific archive name when the timestamp name already exists',async()=>fixture(async({s,f,post})=>{
 const r=await s.run({code:`<?php for($i=-2;$i<60;$i++){$p=${JSON.stringify(f.paths.convert)}.'_archived_'.gmdate('Ymd-His',time()+$i);mkdir($p);file_put_contents($p.'/keep','existing archive');}`});assert.equal(r.errors,'');
 const answer=await post(),job=answer.job;assert.equal(job?.state,'queued',JSON.stringify(answer));assert.match(job.recovery,/\/convert-0777_archived_[0-9]{8}-[0-9]{6}-[a-f0-9]{12}$/);assert.equal(s.php.readFileAsText(job.recovery.replace(/-[a-f0-9]{12}$/,'')+'/keep'),'existing archive');assert.equal(s.php.fileExists(job.recovery),false);
}));

test('queue treats a dangling symlink as an occupied archive name without following it',async()=>fixture(async({s,f,post})=>{
 const r=await s.run({code:`<?php for($i=-2;$i<60;$i++)symlink('/absent-archive-destination',${JSON.stringify(f.paths.convert)}.'_archived_'.gmdate('Ymd-His',time()+$i));`});assert.equal(r.errors,'');
 const answer=await post(),job=answer.job;assert.equal(job?.state,'queued',JSON.stringify(answer));assert.match(job.recovery,/\/convert-0777_archived_[0-9]{8}-[0-9]{6}-[a-f0-9]{12}$/);
 const p=job.recovery.replace(/-[a-f0-9]{12}$/,'');const probe=await s.run({code:`<?php echo json_encode(['symlink'=>is_link(${JSON.stringify(p)}),'destination'=>readlink(${JSON.stringify(p)})]);`});assert.equal(probe.errors,'');assert.deepEqual(JSON.parse(probe.text),{symlink:true,destination:'/absent-archive-destination'});assert.equal(s.php.fileExists(job.recovery),false);
}));

test('NAME_MAX truncation preserves whole Cyrillic and emoji characters in archive paths',async()=>{
 const php=await runtime();try{const r=await php.run({code:`<?php require '/app/harness.php';$id='20261020-130405-0123456789ab';$out=[];foreach([str_repeat('Б',120),str_repeat('A',215).'😀😀']as$name){$path=zfsmConversionRecoveryPath('/archive-owner/'.$name,$id,true);$out[]=['valid'=>preg_match('//u',$path)===1,'bytes'=>strlen(basename($path)),'base64'=>base64_encode(basename($path))];}echo json_encode($out);`});assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);const rows=JSON.parse(r.text);assert.deepEqual(rows.map(row=>row.valid),[true,true]);assert.deepEqual(rows.map(row=>row.bytes),[254,253]);assert.deepEqual(rows.map(row=>Buffer.from(row.base64,'base64').toString('utf8')),['Б'.repeat(108)+'_archived_20261020-130405-0123456789ab','A'.repeat(215)+'_archived_20261020-130405-0123456789ab']);
 }finally{php.exit();}
});

test('archive selection handles existing entries and NAME_MAX while old journal paths remain valid',async()=>{
 const php=await runtime();try{const r=await php.run({code:`<?php require '/app/harness.php';if(!function_exists('zfsmConversionRecoveryPath')){echo json_encode(['missing'=>'archive path selector']);return;}mkdir('/archive-owner');$id='20261020-130405-0123456789ab';
 $source='/archive-owner/SampleProject';$base=['schema'=>1,'method'=>'confined-v1','id'=>$id,'state'=>'queued','stage'=>'planned','source'=>$source,'source_identity'=>['dev'=>'1','ino'=>'2'],'recovery'=>$source.'_zfsm_recovery_'.$id,'dataset'=>'cache/SampleProject','owner_dataset'=>'cache','owner_guid'=>'123','owner_mountpoint'=>'/archive-owner','pool'=>'cache','staging'=>zfsmConfinedStagingPath($id)];
 $out=['legacy'=>zfsmJobProblem($base)];$plain=zfsmConversionRecoveryPath($source,$id);$out['plain']=$plain;mkdir($plain);$chosen=zfsmConversionRecoveryPath($source,$id,true);$out['collision']=$chosen;
 $job=array_replace($base,['recovery'=>$chosen]);$out['new_problem']=zfsmJobProblem($job);$out['cleanup_original']=zfsmCleanupName(basename($chosen));$out['cleanup_journal']=zfsmCleanupName('.zfsm-mutation-'.str_repeat('a',48));
 $out['long']=zfsmConversionRecoveryPath('/archive-owner/'.str_repeat('B',255),$id,true);$out['bad']=[];foreach(['/archive-owner/other_archived_20261020-130405','/archive-owner/SampleProject_archived_20261019-130405','/archive-owner/SampleProject_archived_20261020-130405-ffffffffffff','/other/SampleProject_archived_20261020-130405']as$p)$out['bad'][]=zfsmJobProblem(array_replace($base,['recovery'=>$p]))!==null;
 echo json_encode($out);`});assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);const a=JSON.parse(r.text);assert.equal(a.legacy,null);assert.equal(a.plain,'/archive-owner/SampleProject_archived_20261020-130405');assert.equal(a.collision,'/archive-owner/SampleProject_archived_20261020-130405-0123456789ab');assert.equal(a.new_problem,null);assert.equal(a.cleanup_original,false);assert.equal(a.cleanup_journal,true);assert.equal(Buffer.byteLength(a.long.split('/').at(-1)),255);assert.ok(a.long.endsWith('_archived_20261020-130405-0123456789ab'));assert.ok(a.bad.every(Boolean));
 }finally{php.exit();}
});
