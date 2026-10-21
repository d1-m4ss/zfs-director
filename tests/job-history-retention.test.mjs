import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';
async function run(code){const php=await runtime();try{const r=await php.run({code:`<?php require '/app/harness.php';require_once '/app/src/include/ZFSMJobHistory.php';$GLOBALS['plugin_state']='/history/jobs';$GLOBALS['plugin_runtime']='/history/runtime';$GLOBALS['plugin_config']='/history/plugin.cfg';$GLOBALS['plugin_lock']='/history/operation.lock';$GLOBALS['zfsm_boot_id']='history-test-boot';
function record($n,$state='completed'){$id='20260101-120000-'.str_pad(dechex($n),12,'0',STR_PAD_LEFT);$j=['schema'=>7,'id'=>$id,'type'=>'operation','command'=>'snapshotdataset','label'=>'Create snapshots','source'=>'cache/test','state'=>$state,'stage'=>$state==='completed'?'completed':'interrupted','created'=>'2026-01-01T12:00:00Z','updated'=>'2026-01-01T12:00:00Z','finished_at'=>'2026-01-01T12:00:00Z','owner_boot'=>'history-test-boot','result'=>['summary'=>'Successful test operation']];zfsmJobAtomicWrite(zfsmJobFile($id),$j);file_put_contents(zfsmJobFile($id).'.lock','');return $j;}
${code}`});assert.equal(r.errors,'');assert.equal(r.exitCode,0,r.text);return JSON.parse(r.text);}finally{php.exit();}}

test('hourly history cleanup removes only old successful logs, retains the newest 100, and records its result',async()=>{
 const x=await run(`for($i=1;$i<=105;$i++)record($i);$bad=record(200,'recovery_required');$before=file_get_contents(zfsmJobFile($bad['id']));$r=zfsmJobHistoryCleanup(1792497600);echo json_encode(['result'=>$r,'count'=>count(glob($GLOBALS['plugin_state'].'/*.json')),'protected_unchanged'=>file_get_contents(zfsmJobFile($bad['id']))===$before,'old_lock'=>is_file(zfsmJobFile('20260101-120000-000000000001').'.lock'),'second'=>zfsmJobHistoryCleanup(1792497601)]);`);
 assert.equal(x.result.removed,5);assert.equal(x.result.minimum_kept,100);assert.equal(x.count,102);assert.equal(x.protected_unchanged,true);assert.equal(x.old_lock,false);assert.equal(x.second.skipped,'not_due');
});

test('history cleanup keeps errors, warnings, saved originals, active requests and referenced journals',async()=>{
 const x=await run(`for($i=1;$i<=105;$i++)record($i);$a=record(1);$b=record(2,'failed');$c=record(3,'running');$d=record(4);$d['parent_job_id']=$a['id'];zfsmJobAtomicWrite(zfsmJobFile($d['id']),$d);$e=record(5);$e['error']='Warning requires inspection';zfsmJobAtomicWrite(zfsmJobFile($e['id']),$e);$saved=['schema'=>1,'id'=>record(300)['id'],'state'=>'completed','stage'=>'complete_source_retained','source'=>'/mnt/cache/source','source_identity'=>['dev'=>'1','ino'=>'2'],'recovery'=>'/mnt/cache/source_zfsm_recovery_20260101-120000-00000000012c','dataset'=>'cache/source','owner_dataset'=>'cache','owner_guid'=>'123','owner_mountpoint'=>'/mnt/cache','pool'=>'cache'];zfsmJobAtomicWrite(zfsmJobFile($saved['id']),$saved);$ids=[$a['id'],$b['id'],$c['id'],$e['id'],$saved['id']];$hash=[];foreach($ids as$id)$hash[$id]=hash_file('sha256',zfsmJobFile($id));$r=zfsmJobHistoryCleanup(1792497600);$same=true;foreach($hash as$id=>$sha)$same=$same&&is_file(zfsmJobFile($id))&&hash_file('sha256',zfsmJobFile($id))===$sha;echo json_encode(['result'=>$r,'same'=>$same]);`);assert.equal(x.same,true);assert.ok(x.result.protected>=5);
});

for(const kind of ['malformed','symlink','store'])test('history cleanup fails closed for '+kind+' uncertainty',async()=>{
 const x=await run(`for($i=1;$i<=105;$i++)record($i);${kind==='malformed'?"file_put_contents(zfsmJobFile('20260101-120000-ffffffffffff'),'{broken');":kind==='symlink'?"symlink('/outside',zfsmJobFile('20260101-120000-ffffffffffff'));":"zfsmJobDirectory('/history/protection');file_put_contents('/history/protection/config.json','{broken');"} $before=file_get_contents(zfsmJobFile('20260101-120000-000000000001'));$r=zfsmJobHistoryCleanup(1792497600);echo json_encode(['result'=>$r,'unchanged'=>file_get_contents(zfsmJobFile('20260101-120000-000000000001'))===$before]);`);assert.equal(x.result.removed,0);assert.equal(x.result.blocked,true);assert.equal(x.unchanged,true);
});

test('completed warning journals survive automatic retention',async()=>{
 const x=await run(`for($i=1;$i<=105;$i++)record($i);$j=record(1);$j['result']=['summary'=>'Observed scrub finished with errors','severity'=>'warning'];zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);$before=file_get_contents(zfsmJobFile($j['id']));$r=zfsmJobHistoryCleanup(1792497600);echo json_encode(['result'=>$r,'same'=>is_file(zfsmJobFile($j['id']))&&file_get_contents(zfsmJobFile($j['id']))===$before]);`);assert.equal(x.same,true);
});

test('history metadata symlink ancestors never redirect deletion outside the log tree',async()=>{
 const x=await run(`for($i=1;$i<=105;$i++)record($i);zfsmJobDirectory('/outside/jobs');$outside='/outside/jobs/20260101-120000-000000000001.marker';file_put_contents($outside,'KEEP');symlink('/outside',$GLOBALS['plugin_state'].'/visibility');$r=zfsmJobHistoryCleanup(1792497600);echo json_encode(['result'=>$r,'outside'=>file_exists($outside)?file_get_contents($outside):null]);`);assert.equal(x.outside,'KEEP');assert.equal(x.result.blocked,true);
});

test('entry-count limit reclaims recent routine logs without touching the newest hundred',async()=>{
 const x=await run(`for($i=1;$i<=1005;$i++){ $j=record($i);$j['created']=$j['updated']=$j['finished_at']='2026-10-20T10:00:00Z';zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);}$r=zfsmJobHistoryCleanup(1792497600);echo json_encode(['result'=>$r,'newest'=>is_file(zfsmJobFile('20260101-120000-0000000003ed'))]);`);assert.equal(x.result.removed,6);assert.equal(x.result.entries,1000);assert.equal(x.newest,true);
});

for(const kind of ['missing','scalar'])test('history retains an uncertain '+kind+' terminal result',async()=>{
 const x=await run(`for($i=1;$i<=105;$i++)record($i);$j=record(1);${kind==='missing'?"unset($j['result']);":"$j['result']='broken';"}zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);$r=zfsmJobHistoryCleanup(1792497600);echo json_encode(['kept'=>is_file(zfsmJobFile($j['id']))]);`);assert.equal(x.kept,true);
});

test('unrecognized JSON and keyed references cannot be bypassed by log cleanup',async()=>{
 const x=await run(`for($i=1;$i<=105;$i++)record($i);file_put_contents($GLOBALS['plugin_state'].'/broken.json','{}');$r=zfsmJobHistoryCleanup(1792497600);unlink($GLOBALS['plugin_state'].'/broken.json');unlink($GLOBALS['plugin_runtime'].'/history-cleanup.json');$id='20260101-120000-000000000001';$store=['version'=>1,'policies'=>[],'replications'=>[],'owned_snapshots'=>[$id=>['guid'=>'123']]];zfsmJobAtomicWrite('/history/protection/config.json',$store);$next=zfsmJobHistoryCleanup(1792497600);echo json_encode(['first'=>$r,'kept'=>is_file(zfsmJobFile($id))]);`);assert.equal(x.first.blocked,true);assert.equal(x.first.removed,0);assert.equal(x.kept,true);
});

test('last verified replication result and latest definition run are retained',async()=>{
 const x=await run(`for($i=1;$i<=105;$i++)record($i);$def=['id'=>'abc','owner'=>'managed','source'=>'cache/test','source_guid'=>'123','target'=>'backup/test'];foreach([1,2,3]as$n){$j=record($n);$j=['schema'=>4,'id'=>$j['id'],'type'=>'replication','definition_id'=>'abc','definition'=>$def,'definition_hash'=>hash('sha256',json_encode($def,JSON_THROW_ON_ERROR)),'state'=>'completed','stage'=>'finished','verified_outcome'=>'completed','source'=>'cache/test','source_guid'=>'123','target'=>'backup/test','cancel_requested'=>false,'created'=>'2026-01-0'.$n.'T12:00:00Z','updated'=>'2026-01-0'.$n.'T12:00:00Z','verification'=>['outcome'=>'completed','verified'=>$n===1]];zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);}$r=zfsmJobHistoryCleanup(1792497600);echo json_encode(['result'=>$r,'first_verified'=>is_file(zfsmJobFile('20260101-120000-000000000001')),'last'=>is_file(zfsmJobFile('20260101-120000-000000000003'))]);`);assert.equal(x.first_verified,true);assert.equal(x.last,true);
});

test('byte target reclaims recent successful logs before the entry-count target is reached',async()=>{
 const x=await run(`for($i=1;$i<=300;$i++){$j=record($i);$j['created']=$j['updated']=$j['finished_at']='2026-10-20T10:00:00Z';$j['result']['summary']=str_repeat('S',120000);zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);}$r=zfsmJobHistoryCleanup(1792497600);echo json_encode($r);`);assert.equal(x.blocked,false);assert.ok(x.removed>0);assert.ok(x.bytes<=32*1024*1024);assert.ok(x.entries>=100);
});
