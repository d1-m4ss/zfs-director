import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';
async function run(code){const php=await runtime();try{const r=await php.run({code:`<?php require '/app/harness.php';require_once '/app/src/include/ZFSMJobHistory.php';$GLOBALS['plugin_state']='/history/jobs';$GLOBALS['plugin_runtime']='/history/runtime';$GLOBALS['plugin_config']='/history/plugin.cfg';$GLOBALS['plugin_lock']='/history/operation.lock';$GLOBALS['zfsm_boot_id']='history-test-boot';
function record($n,$state='completed'){$id='20260101-120000-'.str_pad(dechex($n),12,'0',STR_PAD_LEFT);$j=['schema'=>7,'id'=>$id,'type'=>'operation','command'=>'snapshotdataset','label'=>'Create snapshots','source'=>'cache/test','state'=>$state,'stage'=>$state==='completed'?'completed':'interrupted','created'=>'2026-01-01T12:00:00Z','updated'=>'2026-01-01T12:00:00Z','finished_at'=>'2026-01-01T12:00:00Z','owner_boot'=>'history-test-boot','result'=>['summary'=>'Successful test operation']];zfsmJobAtomicWrite(zfsmJobFile($id),$j);file_put_contents(zfsmJobFile($id).'.lock','');return $j;}
${code}`});assert.equal(r.errors,'');assert.equal(r.exitCode,0,r.text);return JSON.parse(r.text);}finally{php.exit();}}

for(const kind of ['malformed','symlink'])test('one '+kind+' journal is skipped and counted; the hourly pass still deletes the old valid records',async()=>{
 const x=await run(`for($i=1;$i<=105;$i++)record($i);$bad=zfsmJobFile('20260101-120000-ffffffffffff');${kind==='malformed'?"file_put_contents($bad,'{broken');":"symlink('/outside',$bad);"} $r=zfsmJobHistoryCleanup(1792497600);echo json_encode(['result'=>$r,'bad'=>is_link($bad)?'link:'.readlink($bad):file_get_contents($bad),'valid_left'=>count(glob($GLOBALS['plugin_state'].'/2026*-*.json'))-1]);`);
 assert.equal(x.result.blocked,false);assert.equal(x.result.removed,105);assert.equal(x.result.skipped_unsafe,1);
 assert.equal(x.bad,kind==='malformed'?'{broken':'link:/outside','the bad entry is never touched');assert.equal(x.valid_left,0);
});
test('history cleanup fails closed when the protection store is unreadable',async()=>{
 const x=await run(`for($i=1;$i<=105;$i++)record($i);zfsmJobDirectory('/history/protection');file_put_contents('/history/protection/config.json','{broken');$before=file_get_contents(zfsmJobFile('20260101-120000-000000000001'));$r=zfsmJobHistoryCleanup(1792497600);echo json_encode(['result'=>$r,'unchanged'=>file_get_contents(zfsmJobFile('20260101-120000-000000000001'))===$before]);`);assert.equal(x.result.removed,0);assert.equal(x.result.blocked,true);assert.equal(x.unchanged,true);
});

test('history metadata symlink ancestors never redirect deletion outside the log tree',async()=>{
 const x=await run(`for($i=1;$i<=105;$i++)record($i);zfsmJobDirectory('/outside/jobs');$outside='/outside/jobs/20260101-120000-000000000001.marker';file_put_contents($outside,'KEEP');symlink('/outside',$GLOBALS['plugin_state'].'/visibility');$r=zfsmJobHistoryCleanup(1792497600);echo json_encode(['result'=>$r,'outside'=>file_exists($outside)?file_get_contents($outside):null]);`);assert.equal(x.outside,'KEEP');assert.equal(x.result.blocked,true);
});

test('an unrecognized JSON file is skipped and kept; keyed references still protect a journal',async()=>{
 const x=await run(`for($i=1;$i<=105;$i++)record($i);$broken=$GLOBALS['plugin_state'].'/broken.json';file_put_contents($broken,'{}');$r=zfsmJobHistoryCleanup(1792497600);$stays=file_get_contents($broken);unlink($broken);unlink($GLOBALS['plugin_runtime'].'/history-cleanup.json');for($i=1;$i<=105;$i++)record($i);$id='20260101-120000-000000000001';$store=['version'=>1,'policies'=>[],'replications'=>[],'owned_snapshots'=>[$id=>['guid'=>'123']]];zfsmJobAtomicWrite('/history/protection/config.json',$store);$next=zfsmJobHistoryCleanup(1792497600);echo json_encode(['first'=>$r,'stays'=>$stays,'next'=>$next,'kept'=>is_file(zfsmJobFile($id)),'left'=>count(glob($GLOBALS['plugin_state'].'/*.json'))]);`);
 assert.equal(x.first.blocked,false);assert.equal(x.first.removed,105);assert.equal(x.first.skipped_unsafe,1);assert.equal(x.stays,'{}');
 assert.equal(x.next.blocked,false);assert.equal(x.next.removed,104);assert.equal(x.kept,true);assert.equal(x.left,1);
});
test('an unreadable settings file stops deletion; a missing key still means 7 days',async()=>{
 const x=await run(`zfsmJobDirectory('/history');for($i=1;$i<=3;$i++)record($i);file_put_contents($GLOBALS['plugin_config'],'job_retention_days="7'.PHP_EOL.'[broken');$days=zfsmJobRetentionDays();$r=zfsmJobHistoryCleanup(1792497600);$left=count(glob($GLOBALS['plugin_state'].'/*.json'));
 file_put_contents($GLOBALS['plugin_config'],'[general]'.PHP_EOL.'other="1"'.PHP_EOL);$missing=zfsmJobRetentionDays();$r2=zfsmJobHistoryCleanup(1792497600);echo json_encode(['days'=>$days,'result'=>$r,'left'=>$left,'missing'=>$missing,'removed'=>$r2['removed']]);`);
 assert.equal(x.days,null);assert.deepEqual(x.result,{skipped:'settings_unreadable'});assert.equal(x.left,3);assert.equal(x.missing,7);assert.equal(x.removed,3);
});
test('Delete with Everything also removes a journal that cannot be validated, unless it is a symlink; filters keep it (a held lock is covered by the native test)',async()=>{
 const x=await run(`zfsmJobDirectory('/history');for($i=1;$i<=2;$i++)record($i);$d=$GLOBALS['plugin_state'];
 $bad=zfsmJobFile('20260101-120000-aaaaaaaaaaaa');file_put_contents($bad,'{broken');file_put_contents($bad.'.lock','');
 $link=zfsmJobFile('20260101-120000-cccccccccccc');symlink('/outside',$link);
 $filtered=zfsmJobDeleteFinished(['20260101-120000-000000000001'=>true]);$afterFilter=count(glob($d.'/*.json'));
 $all=zfsmJobDeleteFinished();$left=array_map('basename',glob($d.'/2026*.json'));sort($left);
 echo json_encode(['filtered'=>[$filtered['deleted'],$filtered['kept']],'after_filter'=>$afterFilter,'all'=>[$all['deleted'],$all['kept']],'left'=>$left]);`);
 assert.deepEqual(x.filtered,[1,[]]);
 assert.equal(x.after_filter,3,'with a filter the unreadable journals stay (1 valid + 2 unreadable)');
 assert.equal(x.all[0],2,'the last valid record and the unreadable plain file');
 assert.deepEqual(x.all[1],{'needs inspection':1});
 assert.deepEqual(x.left,['20260101-120000-cccccccccccc.json']);
});
test('the newest result of a replication is saved before its journals are deleted; results of removed definitions are dropped',async()=>{
 const x=await run(`for($i=1;$i<=105;$i++)record($i);$def=['id'=>'abc','owner'=>'managed','source'=>'cache/test','source_guid'=>'123','target'=>'backup/test'];foreach([1,2,3]as$n){$j=record($n);$j=['schema'=>4,'id'=>$j['id'],'type'=>'replication','definition_id'=>'abc','definition'=>$def,'definition_hash'=>hash('sha256',json_encode($def,JSON_THROW_ON_ERROR)),'state'=>$n===3?'failed':'completed','stage'=>'finished','verified_outcome'=>$n===3?'failed':'completed','source'=>'cache/test','source_guid'=>'123','target'=>'backup/test','cancel_requested'=>false,'created'=>'2026-01-0'.$n.'T12:00:00Z','updated'=>'2026-01-0'.$n.'T12:00:00Z','verification'=>['outcome'=>$n===3?'failed':'completed','verified'=>$n===1]];zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);}
 zfsmJobDirectory('/history/protection');file_put_contents('/history/protection/config.json',json_encode(['version'=>1,'policies'=>new stdClass,'replications'=>['abc'=>$def],'owned_snapshots'=>new stdClass]));
 $r=zfsmJobHistoryCleanup(1792497600);$saved=zfsmLastResults();
 echo json_encode(['blocked'=>$r['blocked'],'journals_left'=>count(glob($GLOBALS['plugin_state'].'/*.json')),'first'=>is_file(zfsmJobFile('20260101-120000-000000000001')),'last'=>is_file(zfsmJobFile('20260101-120000-000000000003')),'saved'=>array_map(fn($v)=>[$v['id'],$v['state'],$v['verified_outcome']],$saved)]);`);
 assert.equal(x.blocked,false);assert.equal(x.journals_left,0,'every old journal is deleted');
 assert.deepEqual(x.saved,{'replication:abc':['20260101-120000-000000000003','failed','failed']},'only the newest result of the definition is kept');
 const y=await run(`$def=['id'=>'abc','owner'=>'managed','source'=>'cache/test','source_guid'=>'123','target'=>'backup/test'];$j=record(1);$j=['schema'=>4,'id'=>$j['id'],'type'=>'replication','definition_id'=>'abc','definition'=>$def,'definition_hash'=>hash('sha256',json_encode($def,JSON_THROW_ON_ERROR)),'state'=>'completed','stage'=>'finished','verified_outcome'=>'completed','source'=>'cache/test','source_guid'=>'123','target'=>'backup/test','cancel_requested'=>false,'created'=>'2026-01-01T12:00:00Z','updated'=>'2026-01-01T12:00:00Z','verification'=>['outcome'=>'completed']];zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);
 zfsmJobDirectory('/history/protection');file_put_contents('/history/protection/config.json',json_encode(['version'=>1,'policies'=>new stdClass,'replications'=>['abc'=>$def],'owned_snapshots'=>new stdClass]));$r1=zfsmJobHistoryCleanup(1792497600);$before=array_keys(zfsmLastResults());
 file_put_contents('/history/protection/config.json',json_encode(['version'=>1,'policies'=>new stdClass,'replications'=>new stdClass,'owned_snapshots'=>new stdClass]));unlink($GLOBALS['plugin_runtime'].'/history-cleanup.json');zfsmJobHistoryCleanup(1792497600+7200);echo json_encode(['before'=>$before,'after'=>array_keys(zfsmLastResults()),'removed'=>$r1['removed']]);`);
 assert.deepEqual(y,{before:['replication:abc'],after:[],removed:1});
});

// Finished jobs are deleted once they are older than the retention setting (default 7 days); the
// cleanup itself never writes a Jobs entry.
test('hourly cleanup deletes finished jobs older than 7 days, keeps newer, running and recovery ones, and writes nothing to Jobs',async()=>{
 const x=await run(`for($i=1;$i<=20;$i++)record($i);$new=record(50);$new['created']=$new['updated']=$new['finished_at']='2026-10-30T10:00:00Z';zfsmJobAtomicWrite(zfsmJobFile($new['id']),$new);$run=record(51,'running');$bad=['schema'=>1,'id'=>record(200)['id'],'state'=>'recovery_required','stage'=>'copying','source'=>'/mnt/cache/source','source_identity'=>['dev'=>'1','ino'=>'2'],'recovery'=>'/mnt/cache/source_zfsm_recovery_20260101-120000-0000000000c8','dataset'=>'cache/source','owner_dataset'=>'cache','owner_guid'=>'123','owner_mountpoint'=>'/mnt/cache','pool'=>'cache','created'=>'2026-01-01T12:00:00Z','updated'=>'2026-01-01T12:00:00Z'];zfsmJobAtomicWrite(zfsmJobFile($bad['id']),$bad);$request=record(201,'recovery_required');$before=file_get_contents(zfsmJobFile($bad['id']));$r=zfsmJobHistoryCleanup(strtotime('2026-11-02T10:00:00Z'));$left=array_map(fn($f)=>basename($f,'.json'),glob($GLOBALS['plugin_state'].'/*.json'));sort($left);echo json_encode(['result'=>$r,'left'=>$left,'expected'=>[$new['id'],$run['id'],$bad['id']],'protected_unchanged'=>file_get_contents(zfsmJobFile($bad['id']))===$before,'request_recovery_gone'=>!is_file(zfsmJobFile($request['id'])),'old_lock'=>is_file(zfsmJobFile('20260101-120000-000000000001').'.lock'),'second'=>zfsmJobHistoryCleanup(strtotime('2026-11-02T10:01:00Z'))]);`);
 sortedEqual(x.left,x.expected);assert.equal(x.result.removed,21,'20 finished requests and the interrupted one');assert.equal(x.result.days,7);assert.equal(x.protected_unchanged,true,'a conversion that needs recovery stays');assert.equal(x.request_recovery_gone,true,'an interrupted request owns nothing and is deleted');assert.equal(x.old_lock,false);assert.equal(x.second.skipped,'not_due');
});
function sortedEqual(a,b){assert.deepEqual([...a].sort(),[...b].sort());}

test('the retention setting picks 1, 30 days or always; the default is 7',async()=>{
 const x=await run(`zfsmJobDirectory('/history');$out=[];foreach([null,'1','30','0','5']as$v){@unlink($GLOBALS['plugin_config']);if($v!==null)file_put_contents($GLOBALS['plugin_config'],'[general]'.PHP_EOL.'job_retention_days="'.$v.'"'.PHP_EOL);$out[]=zfsmJobRetentionDays();}
 for($i=1;$i<=3;$i++)record($i);file_put_contents($GLOBALS['plugin_config'],'job_retention_days="0"'.PHP_EOL);$keep=zfsmJobHistoryCleanup(strtotime('2027-01-01T00:00:00Z'));$files=count(glob($GLOBALS['plugin_state'].'/*.json'));echo json_encode(['days'=>$out,'always'=>$keep,'files'=>$files]);`);
 assert.deepEqual(x.days,[7,1,30,0,7],'unknown values fall back to 7');assert.equal(x.always.blocked,false);assert.equal(x.always.removed,0);assert.equal(x.files,3,'Always deletes nothing');
});

test('cleanup keeps what is still needed: running work, referenced journals and ZIPs on disk; it deletes finished and failed requests and saved-original conversions',async()=>{
 const x=await run(`for($i=1;$i<=10;$i++)record($i);$a=record(1);$b=record(2,'failed');$c=record(3,'running');$d=record(4);$d['parent_job_id']=$a['id'];zfsmJobAtomicWrite(zfsmJobFile($d['id']),$d);$target=record(5);$c['parent_job_id']=$target['id'];zfsmJobAtomicWrite(zfsmJobFile($c['id']),$c);$saved=['schema'=>1,'id'=>record(300)['id'],'state'=>'completed','stage'=>'complete_source_retained','source'=>'/mnt/cache/source','source_identity'=>['dev'=>'1','ino'=>'2'],'recovery'=>'/mnt/cache/source_zfsm_recovery_20260101-120000-00000000012c','dataset'=>'cache/source','owner_dataset'=>'cache','owner_guid'=>'123','owner_mountpoint'=>'/mnt/cache','pool'=>'cache','created'=>'2026-01-01T12:00:00Z','updated'=>'2026-01-01T12:00:00Z'];zfsmJobAtomicWrite(zfsmJobFile($saved['id']),$saved);
 $r=zfsmJobHistoryCleanup(1792497600);echo json_encode(['kept'=>['referenced'=>is_file(zfsmJobFile($target['id'])),'running'=>is_file(zfsmJobFile($c['id']))],'gone'=>['failed_request'=>!is_file(zfsmJobFile($b['id'])),'referencing'=>!is_file(zfsmJobFile($d['id'])),'referenced_by_deleted'=>!is_file(zfsmJobFile($a['id'])),'saved_original'=>!is_file(zfsmJobFile($saved['id']))]]);`);
 assert.deepEqual(x.kept,{referenced:true,running:true});assert.deepEqual(x.gone,{failed_request:true,referencing:true,referenced_by_deleted:true,saved_original:true},'a journal only deleted records point at goes with them, in one pass');
});
