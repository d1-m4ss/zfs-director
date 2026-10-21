<?php
require '/app/harness.php';
$GLOBALS['plugin_state']='/history-jobs';
$GLOBALS['zfsm_boot_id']='test-boot';
function historyJob($index) { return ['id'=>'20261018-000000-'.str_pad(dechex($index),12,'0',STR_PAD_LEFT),'schema'=>2,'type'=>'archive','state'=>'queued','stage'=>'planned','created'=>'2026-10-18T10:00:00+00:00']; }
check('new journal captures creation and only durable stage or state transitions',function(){
    $job=zfsmJobInitializeHistory(historyJob(1));$id=$job['id'];zfsmJobAtomicWrite(zfsmJobFile($id),$job);
    same(true,$job['stage_history_complete']);same(1,count($job['stage_history']));same('queued',$job['stage_history'][0]['state']);same(0,$job['stage_history'][0]['attempt']);
    zfsmJobUpdate($id,['state'=>'running','stage'=>'validating','started_at'=>'2026-10-18T10:01:00+00:00']);
    zfsmJobUpdate($id,['stage'=>'copying']);
    zfsmJobUpdate($id,['stage'=>'copying','progress'=>['percent'=>3],'error'=>'password=never-put-this-in-history']);
    zfsmJobUpdate($id,function($current){same('copying',$current['stage']);return ['stage'=>'copying','hold_owned'=>true];});
    $job=zfsmJobUpdate($id,['state'=>'failed','finished_at'=>'2026-10-18T10:02:00+00:00']);
    same(['planned','validating','copying','copying'],array_column($job['stage_history'],'stage'));
    same(['queued','running','running','failed'],array_column($job['stage_history'],'state'));
    same([0,1,1,1],array_column($job['stage_history'],'attempt'));
    foreach($job['stage_history']as$event){same(['at','state','stage','attempt'],array_keys($event));same(true,strtotime($event['at'])!==false);}
    same(false,str_contains(json_encode($job['stage_history']),'never-put-this'));
    zfsmJobUpdate($id,['state'=>'queued']);
    zfsmJobUpdate($id,['state'=>'running','started_at'=>'2026-10-18T10:03:00+00:00','finished_at'=>null]);
    $job=zfsmJobUpdate($id,['state'=>'completed','stage'=>'completed']);
    same([0,1,1,1,1,2,2],array_column($job['stage_history'],'attempt'));
    same($job,zfsmReadJob($id));
});
check('legacy journals expose Unknown history without read-time writes or invented prior transitions',function(){
    $job=historyJob(2);$job['state']='running';$job['stage']='copying';$id=$job['id'];zfsmJobAtomicWrite(zfsmJobFile($id),$job);$bytes=file_get_contents(zfsmJobFile($id));
    $view=zfsmJobPresentation($job,zfsmJobFile($id),false);
    same([],$view['stage_history']);same(false,$view['stage_history_complete']);same(0,$view['stage_history_dropped']);same($bytes,file_get_contents(zfsmJobFile($id)));
    $job=zfsmJobUpdate($id,['progress'=>['percent'=>9]]);same([], $job['stage_history']??[]);
    $job=zfsmJobUpdate($id,['stage'=>'verifying']);same(1,count($job['stage_history']));same('verifying',$job['stage_history'][0]['stage']);same(null,$job['stage_history'][0]['attempt']);same(false,$job['stage_history_complete']);
});
check('bounded journal retains newest transitions and explicit omitted count',function(){
    $job=zfsmJobInitializeHistory(historyJob(3));$id=$job['id'];zfsmJobAtomicWrite(zfsmJobFile($id),$job);
    for($i=0;$i<400;$i++)zfsmJobUpdate($id,['state'=>$i%2?'running':'queued','stage'=>$i%2?'copying':'planned']);
    $job=zfsmReadJob($id);same(true,count($job['stage_history'])<=200);same(true,$job['stage_history_dropped']>0);same(400,count($job['stage_history'])+$job['stage_history_dropped']);same('running',$job['stage_history'][count($job['stage_history'])-1]['state']);same(true,filesize(zfsmJobFile($id))<131072);
});
check('history presentation excludes injected arbitrary fields and invalid metadata',function(){
    $job=historyJob(4);$job['stage_history']=[['at'=>'2026-10-18T10:00:00+00:00','state'=>'queued','stage'=>'planned','attempt'=>0,'error'=>'secret-text','password'=>'secret-key']];
    $view=zfsmJobPresentation($job,'/not-present',false);
    same(['at','state','stage','attempt'],array_keys($view['stage_history'][0]));same(false,str_contains(json_encode($view['stage_history']),'secret'));
});

finishTests();
