import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';
async function run(code){const php=await runtime();try{const r=await php.run({code:`<?php require '/app/harness.php';require_once '/app/src/include/ZFSMJobHistory.php';$GLOBALS['plugin_state']='/history/jobs';$GLOBALS['plugin_runtime']='/history/runtime';$GLOBALS['plugin_config']='/history/plugin.cfg';$GLOBALS['plugin_lock']='/history/operation.lock';$GLOBALS['zfsm_boot_id']='history-test-boot';
function record($n,$state='completed'){$id='20260101-120000-'.str_pad(dechex($n),12,'0',STR_PAD_LEFT);$j=['schema'=>7,'id'=>$id,'type'=>'operation','command'=>'snapshotdataset','label'=>'Create snapshots','source'=>'cache/test','state'=>$state,'stage'=>$state==='completed'?'completed':'interrupted','created'=>'2026-01-01T12:00:00Z','updated'=>'2026-01-01T12:00:00Z','finished_at'=>'2026-01-01T12:00:00Z','owner_boot'=>'history-test-boot','result'=>['summary'=>'Successful test operation']];zfsmJobAtomicWrite(zfsmJobFile($id),$j);file_put_contents(zfsmJobFile($id).'.lock','');return $j;}
${code}`});assert.equal(r.errors,'');assert.equal(r.exitCode,0,r.text);return JSON.parse(r.text);}finally{php.exit();}}

for(const kind of ['malformed','symlink','store'])test('history cleanup fails closed for '+kind+' uncertainty',async()=>{
 const x=await run(`for($i=1;$i<=105;$i++)record($i);${kind==='malformed'?"file_put_contents(zfsmJobFile('20260101-120000-ffffffffffff'),'{broken');":kind==='symlink'?"symlink('/outside',zfsmJobFile('20260101-120000-ffffffffffff'));":"zfsmJobDirectory('/history/protection');file_put_contents('/history/protection/config.json','{broken');"} $before=file_get_contents(zfsmJobFile('20260101-120000-000000000001'));$r=zfsmJobHistoryCleanup(1792497600);echo json_encode(['result'=>$r,'unchanged'=>file_get_contents(zfsmJobFile('20260101-120000-000000000001'))===$before]);`);assert.equal(x.result.removed,0);assert.equal(x.result.blocked,true);assert.equal(x.unchanged,true);
});

test('history metadata symlink ancestors never redirect deletion outside the log tree',async()=>{
 const x=await run(`for($i=1;$i<=105;$i++)record($i);zfsmJobDirectory('/outside/jobs');$outside='/outside/jobs/20260101-120000-000000000001.marker';file_put_contents($outside,'KEEP');symlink('/outside',$GLOBALS['plugin_state'].'/visibility');$r=zfsmJobHistoryCleanup(1792497600);echo json_encode(['result'=>$r,'outside'=>file_exists($outside)?file_get_contents($outside):null]);`);assert.equal(x.outside,'KEEP');assert.equal(x.result.blocked,true);
});

test('unrecognized JSON and keyed references cannot be bypassed by log cleanup',async()=>{
 const x=await run(`for($i=1;$i<=105;$i++)record($i);file_put_contents($GLOBALS['plugin_state'].'/broken.json','{}');$r=zfsmJobHistoryCleanup(1792497600);unlink($GLOBALS['plugin_state'].'/broken.json');unlink($GLOBALS['plugin_runtime'].'/history-cleanup.json');$id='20260101-120000-000000000001';$store=['version'=>1,'policies'=>[],'replications'=>[],'owned_snapshots'=>[$id=>['guid'=>'123']]];zfsmJobAtomicWrite('/history/protection/config.json',$store);$next=zfsmJobHistoryCleanup(1792497600);echo json_encode(['first'=>$r,'kept'=>is_file(zfsmJobFile($id))]);`);assert.equal(x.first.blocked,true);assert.equal(x.first.removed,0);assert.equal(x.kept,true);
});

test('last verified replication result and latest definition run are retained',async()=>{
 const x=await run(`for($i=1;$i<=105;$i++)record($i);$def=['id'=>'abc','owner'=>'managed','source'=>'cache/test','source_guid'=>'123','target'=>'backup/test'];foreach([1,2,3]as$n){$j=record($n);$j=['schema'=>4,'id'=>$j['id'],'type'=>'replication','definition_id'=>'abc','definition'=>$def,'definition_hash'=>hash('sha256',json_encode($def,JSON_THROW_ON_ERROR)),'state'=>'completed','stage'=>'finished','verified_outcome'=>'completed','source'=>'cache/test','source_guid'=>'123','target'=>'backup/test','cancel_requested'=>false,'created'=>'2026-01-0'.$n.'T12:00:00Z','updated'=>'2026-01-0'.$n.'T12:00:00Z','verification'=>['outcome'=>'completed','verified'=>$n===1]];zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);}$r=zfsmJobHistoryCleanup(1792497600);echo json_encode(['result'=>$r,'first_verified'=>is_file(zfsmJobFile('20260101-120000-000000000001')),'last'=>is_file(zfsmJobFile('20260101-120000-000000000003'))]);`);assert.equal(x.first_verified,true);assert.equal(x.last,true);
});


// Finished jobs are deleted once they are older than the retention setting (default 7 days); the
// cleanup itself never writes a Jobs entry.
test('hourly cleanup deletes finished jobs older than 7 days, keeps newer, running and recovery ones, and writes nothing to Jobs',async()=>{
 const x=await run(`for($i=1;$i<=20;$i++)record($i);$new=record(50);$new['created']=$new['updated']=$new['finished_at']='2026-10-30T10:00:00Z';zfsmJobAtomicWrite(zfsmJobFile($new['id']),$new);$run=record(51,'running');$bad=record(200,'recovery_required');$before=file_get_contents(zfsmJobFile($bad['id']));$r=zfsmJobHistoryCleanup(strtotime('2026-11-02T10:00:00Z'));$left=array_map(fn($f)=>basename($f,'.json'),glob($GLOBALS['plugin_state'].'/*.json'));sort($left);echo json_encode(['result'=>$r,'left'=>$left,'expected'=>[$new['id'],$run['id'],$bad['id']],'protected_unchanged'=>file_get_contents(zfsmJobFile($bad['id']))===$before,'old_lock'=>is_file(zfsmJobFile('20260101-120000-000000000001').'.lock'),'second'=>zfsmJobHistoryCleanup(strtotime('2026-11-02T10:01:00Z'))]);`);
 sortedEqual(x.left,x.expected);assert.equal(x.result.removed,20);assert.equal(x.result.days,7);assert.equal(x.protected_unchanged,true);assert.equal(x.old_lock,false);assert.equal(x.second.skipped,'not_due');
});
function sortedEqual(a,b){assert.deepEqual([...a].sort(),[...b].sort());}

test('the retention setting picks 1, 30 days or always; the default is 7',async()=>{
 const x=await run(`zfsmJobDirectory('/history');$out=[];foreach([null,'1','30','0','5']as$v){@unlink($GLOBALS['plugin_config']);if($v!==null)file_put_contents($GLOBALS['plugin_config'],'[general]'.PHP_EOL.'job_retention_days="'.$v.'"'.PHP_EOL);$out[]=zfsmJobRetentionDays();}
 for($i=1;$i<=3;$i++)record($i);file_put_contents($GLOBALS['plugin_config'],'job_retention_days="0"'.PHP_EOL);$keep=zfsmJobHistoryCleanup(strtotime('2027-01-01T00:00:00Z'));$files=count(glob($GLOBALS['plugin_state'].'/*.json'));echo json_encode(['days'=>$out,'always'=>$keep,'files'=>$files]);`);
 assert.deepEqual(x.days,[7,1,30,0,7],'unknown values fall back to 7');assert.equal(x.always.skipped,'keep_always');assert.equal(x.files,3,'Always deletes nothing');
});

test('cleanup keeps what is still needed: running work, referenced journals and ZIPs on disk; it deletes finished and failed requests and saved-original conversions',async()=>{
 const x=await run(`for($i=1;$i<=10;$i++)record($i);$a=record(1);$b=record(2,'failed');$c=record(3,'running');$d=record(4);$d['parent_job_id']=$a['id'];zfsmJobAtomicWrite(zfsmJobFile($d['id']),$d);$saved=['schema'=>1,'id'=>record(300)['id'],'state'=>'completed','stage'=>'complete_source_retained','source'=>'/mnt/cache/source','source_identity'=>['dev'=>'1','ino'=>'2'],'recovery'=>'/mnt/cache/source_zfsm_recovery_20260101-120000-00000000012c','dataset'=>'cache/source','owner_dataset'=>'cache','owner_guid'=>'123','owner_mountpoint'=>'/mnt/cache','pool'=>'cache','created'=>'2026-01-01T12:00:00Z','updated'=>'2026-01-01T12:00:00Z'];zfsmJobAtomicWrite(zfsmJobFile($saved['id']),$saved);
 $r=zfsmJobHistoryCleanup(1792497600);echo json_encode(['kept'=>['referenced'=>is_file(zfsmJobFile($a['id'])),'running'=>is_file(zfsmJobFile($c['id']))],'gone'=>['failed_request'=>!is_file(zfsmJobFile($b['id'])),'referencing'=>!is_file(zfsmJobFile($d['id'])),'saved_original'=>!is_file(zfsmJobFile($saved['id']))]]);`);
 assert.deepEqual(x.kept,{referenced:true,running:true});assert.deepEqual(x.gone,{failed_request:true,referencing:true,saved_original:true});
});
