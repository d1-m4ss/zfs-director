<?php
require '/app/harness.php';
$GLOBALS['plugin_runtime']='/jobs-runtime';
$GLOBALS['plugin_worker_lock']='/jobs-worker.lock';
$GLOBALS['zfsm_boot_id']='test-boot';
function jobsStorage($name) { $GLOBALS['plugin_state']='/jobs-'.$name; zfsmJobDirectory($GLOBALS['plugin_state']); }
function jobFixture($index,$changes=[]) {
    $id='20261016-000000-'.str_pad(dechex($index),12,'0',STR_PAD_LEFT);
    $source='/mnt/cache/source';
    return array_replace(['schema'=>1,'id'=>$id,'state'=>'queued','stage'=>'planned','source'=>$source,'source_identity'=>['dev'=>'1','ino'=>'2'],'recovery'=>$source.'_zfsm_recovery_'.$id,'dataset'=>'cache/source','owner_dataset'=>'cache','owner_guid'=>'123','owner_mountpoint'=>'/mnt/cache','pool'=>'cache','ack_boot'=>'test-boot','cancel_requested'=>false],$changes);
}
function fileJobFixture($index,$type,$changes=[]) {
    $id=jobFixture($index)['id']; $mount='/retained'; $staging=$mount.'/.zfsm-'.$type.'-'.$id;
    $job=['schema'=>2,'type'=>$type,'id'=>$id,'state'=>'queued','stage'=>'planned','snapshot'=>'cache/data@saved','snapshot_guid'=>'77','dataset'=>'cache/data','owner_guid'=>'123','owner_mountpoint'=>$mount,'source'=>'cache/data@saved','target'=>$type==='archive'?'ZIP download':$mount,'staging'=>$staging,'hold_tag'=>'zfsm_'.$type.'_'.$id,'hold_owned'=>false,'cancel_requested'=>false,'ack_boot'=>'test-boot'];
    if($type==='restore')$job+=['mode'=>'overwrite','bytes'=>10,'files'=>1,'conflicts'=>1,'recovery'=>$staging.'/replaced'];
    else $job+=['destination_identity'=>['dev'=>'1','ino'=>'2'],'archive_removed'=>false,'expires'=>time()+3600,'archive_identity'=>['dev'=>'1','ino'=>'3','type'=>'file'],'archive_size'=>10];
    return array_replace($job,$changes);
}
function saveJob($job) { zfsmJobAtomicWrite(zfsmJobFile($job['id']),$job); return $job['id']; }
function rejected($fn) { try{$fn();}catch(Throwable $e){return $e->getMessage();}throw new RuntimeException('Expected rejection'); }

check('older active and attention jobs survive 205 newer completed journals',function(){
    jobsStorage('visibility');
    $running=saveJob(jobFixture(0,['state'=>'running','stage'=>'copying']));
    $failed=saveJob(jobFixture(1,['state'=>'failed','stage'=>'copying','error'=>'copy failed']));
    for($i=2;$i<207;$i++)saveJob(jobFixture($i,['state'=>'completed','stage'=>'complete_source_retained']));
    $jobs=zfsmListJobs();
    same(102,count($jobs));
    same(true,in_array($running,array_column($jobs,'id'),true));
    same(true,in_array($failed,array_column($jobs,'id'),true));
    $page=zfsmJobPage(2,100);
    same(['active'=>1,'needs_attention'=>1,'completed'=>205],$page['counts']);
    same(['page'=>2,'page_size'=>100,'total'=>205,'pages'=>3,'has_previous'=>true,'has_next'=>true],$page['pagination']);
    same(102,count($page['jobs']));
    same(jobFixture(106)['id'],$page['jobs'][2]['id']);
    same(jobFixture(7)['id'],$page['jobs'][101]['id']);
    $last=zfsmJobPage(99,100);
    same(3,$last['pagination']['page']);same(7,count($last['jobs']));
});
check('invalid JSON and unknown schema expose diagnostics without unsafe actions',function(){
    jobsStorage('invalid');
    $id=jobFixture(0)['id'];file_put_contents(zfsmJobFile($id),'{invalid json');
    saveJob(jobFixture(1,['schema'=>99,'state'=>'completed','recovery'=>'/retained/original']));
    $jobs=zfsmListJobs();same(2,count($jobs));
    foreach($jobs as$job){
        same('needs_attention',$job['group']);
        same(['cancel'=>false,'resume'=>false,'download'=>false,'inspect'=>true],$job['actions']);
        same(true,is_string($job['diagnostics']['detail']));
        // Diagnostics identify the saved journal without exposing its contents.
        same(false,array_key_exists('raw',$job['diagnostics']));
        same(true,is_int($job['diagnostics']['bytes']));
        same(true,is_string($job['diagnostics']['sha256']));
        same(true,is_string($job['retained_data']['message']));
    }
    same('unsupported_schema',$jobs[0]['diagnostics']['issue']);
    same('/retained/original',$jobs[0]['retained_data']['recovery']);
    same('invalid_journal',$jobs[1]['diagnostics']['issue']);
    same(13,$jobs[1]['diagnostics']['bytes']);
    same(hash('sha256','{invalid json'),$jobs[1]['diagnostics']['sha256']);
    same(true,str_contains(rejected(fn()=>zfsmResumeConversion(jobFixture(1)['id'],true)),'cannot be resumed'));
});
check('conversionjobs output never exposes corrupt journal text or recursive credential fields',function(){
    jobsStorage('secrets');
    $corrupt=jobFixture(0)['id'];
    file_put_contents(zfsmJobFile($corrupt),'{"passphrase":"corrupt-fixture-secret-123"');
    $unsupported=saveJob(jobFixture(1,['schema'=>99,'PassPhrase'=>'unsupported-fixture-secret-123','unknown'=>['API_TOKEN'=>'nested-fixture-secret-123','keep'=>'diagnostic value'],'recovery'=>'/retained/original']));
    $valid=saveJob(jobFixture(2,['password'=>'valid-fixture-secret-123','metadata'=>['child'=>['Authorization'=>'auth-fixture-secret-123','encryptionKey'=>'key-fixture-secret-123','key_material'=>'material-fixture-secret-123','keymaterial'=>'compact-fixture-secret-123']],'keyformat'=>'passphrase']));
    zfsmJobDirectory($GLOBALS['plugin_runtime']);
    file_put_contents($GLOBALS['plugin_runtime'].'/'.$valid.'.json',json_encode(['percent'=>50,'metadata'=>['client_secret'=>'progress-fixture-secret-123']]));
    $page=zfsmJobPage();$output=json_encode($page,JSON_THROW_ON_ERROR|JSON_INVALID_UTF8_SUBSTITUTE);
    foreach(['corrupt','unsupported','nested','valid','auth','key','material','compact','progress']as$prefix)same(false,str_contains($output,$prefix.'-fixture-secret-123'));
    $jobs=array_column($page['jobs'],null,'id');
    same('[redacted]',$jobs[$unsupported]['PassPhrase']);
    same('[redacted]',$jobs[$unsupported]['unknown']['API_TOKEN']);
    same('diagnostic value',$jobs[$unsupported]['unknown']['keep']);
    same('[redacted]',$jobs[$valid]['metadata']['child']['encryptionKey']);
    same('[redacted]',$jobs[$valid]['metadata']['child']['key_material']);
    same('[redacted]',$jobs[$valid]['metadata']['child']['keymaterial']);
    same('[redacted]',$jobs[$valid]['progress']['metadata']['client_secret']);
    same('/retained/original',$jobs[$unsupported]['retained_data']['recovery']);
    same('/mnt/cache/source',$jobs[$valid]['source']);same('passphrase',$jobs[$valid]['keyformat']);
    same(false,array_key_exists('raw',$jobs[$corrupt]['diagnostics']));
    same($corrupt.'.json',$jobs[$corrupt]['diagnostics']['journal']);
    same('valid-fixture-secret-123',zfsmReadJob($valid)['password']);
});
check('malformed conversion is inspection only and Resume does not queue it',function(){
    jobsStorage('malformed');$id=saveJob(jobFixture(0,['stage'=>'unknown']));
    $job=zfsmListJobs()[0];same(false,$job['actions']['resume']);same(false,$job['actions']['cancel']);
    rejected(fn()=>zfsmResumeConversion($id,true));same('queued',zfsmReadJob($id)['state']);
});
check('unsupported journals never enter the automatic worker queue',function(){
    jobsStorage('unsupported-pending');
    saveJob(jobFixture(0,['schema'=>99,'type'=>'restore','state'=>'queued']));
    saveJob(jobFixture(1,['state'=>'running','stage'=>'unknown']));
    same([],zfsmPendingJobs());
    same(2,zfsmJobPage()['counts']['needs_attention']);
});
check('missing conversion ownership evidence disables automatic Resume',function(){
    jobsStorage('missing-identity');
    foreach([['owner_guid'=>''],['source_identity'=>[]]]as$index=>$changes){
        $id=saveJob(jobFixture($index,$changes+['state'=>'failed','stage'=>'copying']));
        $jobs=array_column(zfsmListJobs(),null,'id');same(false,$jobs[$id]['actions']['resume']);
        rejected(fn()=>zfsmResumeConversion($id,true));same('failed',zfsmReadJob($id)['state']);
    }
});
check('interrupted conversion Resume preserves retained data and is idempotent',function(){
    jobsStorage('resume');$id=saveJob(jobFixture(0,['state'=>'recovery_required','stage'=>'copying','ack_boot'=>'old-boot','error'=>'interrupted']));
    $job=zfsmListJobs()[0];same('needs_attention',$job['group']);same(true,$job['actions']['resume']);
    same(jobFixture(0)['recovery'],$job['retained_data']['recovery']);
    $first=zfsmResumeConversion($id,true);$second=zfsmResumeConversion($id,true);
    same('queued',$first['state']);same('test-boot',$first['ack_boot']);same($first,$second);
    same(jobFixture(0)['recovery'],$second['recovery']);same(1,count(zfsmPendingJobs()));
});
check('running conversion can resume only while worker is stopped',function(){
    jobsStorage('worker');$id=saveJob(jobFixture(0,['state'=>'running','stage'=>'copying']));
    same(true,zfsmListJobs()[0]['actions']['resume']);
    $GLOBALS['test_worker_running']=true;
    try{same(false,zfsmListJobs()[0]['actions']['resume']);rejected(fn()=>zfsmResumeConversion($id,true));same('running',zfsmReadJob($id)['state']);}
    finally{$GLOBALS['test_worker_running']=false;}
});
check('repeated Resume of an already queued job does not rewrite its journal',function(){
    jobsStorage('resume-noop');$id=saveJob(jobFixture(0,['updated'=>'2001-01-01T00:00:00+00:00']));
    $before=file_get_contents(zfsmJobFile($id));zfsmResumeConversion($id,true);
    same($before,file_get_contents(zfsmJobFile($id)));
    same(true,zfsmListJobs()[0]['actions']['resume']);
});
check('restore interruption retains replacements and offers inspection rather than Resume',function(){
    jobsStorage('restore');$id=saveJob(fileJobFixture(0,'restore',['state'=>'running','stage'=>'copying']));
    zfsmRunRestoreJob($id);
    $job=zfsmListJobs()[0];same('recovery_required',$job['state']);same(false,$job['actions']['resume']);
    same(fileJobFixture(0,'restore')['recovery'],$job['retained_data']['recovery']);same(true,str_contains($job['error'],'interrupted'));
});
check('failed jobs and expired ZIPs keep cleanup visible without invalid downloads',function(){
    jobsStorage('archives');
    saveJob(fileJobFixture(0,'archive',['state'=>'failed','stage'=>'copying','hold_owned'=>true]));
    saveJob(fileJobFixture(1,'archive',['state'=>'completed','stage'=>'completed','expires'=>time()-10]));
    saveJob(fileJobFixture(2,'archive',['state'=>'completed','stage'=>'completed']));
    $jobs=zfsmListJobs();$byId=array_column($jobs,null,'id');
    same('needs_attention',$byId[jobFixture(0)['id']]['group']);
    same('needs_attention',$byId[jobFixture(1)['id']]['group']);
    same(false,$byId[jobFixture(1)['id']]['actions']['download']);
    same('expired',$byId[jobFixture(1)['id']]['archive_status']);
    same(true,$byId[jobFixture(2)['id']]['actions']['download']);
    same(2,count(zfsmPendingJobs()));
    rejected(fn()=>zfsmArchiveReadRequest(jobFixture(1)['id']));
});
check('refresh during journal update sees an intact old or new journal',function(){
    jobsStorage('refresh');$id=saveJob(jobFixture(0,['state'=>'running','stage'=>'copying','bytes'=>10]));
    for($i=0;$i<20;$i++){
        zfsmJobUpdate($id,function($job){same($job['bytes'],zfsmListJobs()[0]['bytes']);return ['bytes'=>$job['bytes']+1];});
        same(11+$i,zfsmListJobs()[0]['bytes']);
    }
    same([],glob($GLOBALS['plugin_state'].'/*.tmp'));
});
check('failed atomic journal encoding removes temporary files and preserves journal',function(){
    jobsStorage('atomic');$id=saveJob(jobFixture(0));$before=file_get_contents(zfsmJobFile($id));
    rejected(fn()=>zfsmJobAtomicWrite(zfsmJobFile($id),['invalid'=>NAN]));
    same($before,file_get_contents(zfsmJobFile($id)));same([],glob($GLOBALS['plugin_state'].'/*.tmp'));
});
check('unavailable progress does not disguise a valid job as a corrupt journal',function(){
    jobsStorage('progress');$id=saveJob(jobFixture(0));zfsmJobDirectory($GLOBALS['plugin_runtime']);
    file_put_contents($GLOBALS['plugin_runtime'].'/'.$id.'.json','{bad progress');
    $job=zfsmListJobs()[0];same('queued',$job['state']);same(true,$job['actions']['cancel']);
});
check('unavailable storage rejects refresh instead of pretending the jobs list is empty',function(){
    $GLOBALS['plugin_state']='/jobs-unavailable';file_put_contents($GLOBALS['plugin_state'],'unavailable');
    same(true,str_contains(rejected(fn()=>zfsmListJobs()),'storage is unavailable'));
});
finishTests();
