<?php
require '/app/harness.php';
$GLOBALS['plugin_state']='/fault-jobs';$GLOBALS['plugin_runtime']='/fault-runtime';$GLOBALS['zfsm_boot_id']='test-boot';
function heldJob($index=0) {
    $id='20261016-000000-'.str_pad(dechex($index),12,'0',STR_PAD_LEFT);$mount='/retained';$staging=$mount.'/.zfsm-restore-'.$id;
    $job=['schema'=>2,'type'=>'restore','id'=>$id,'state'=>'recovery_required','stage'=>'copying','snapshot'=>'cache/data@saved','snapshot_guid'=>'77','dataset'=>'cache/data','owner_guid'=>'123','owner_mountpoint'=>$mount,'source'=>'cache/data@saved','target'=>$mount,'staging'=>$staging,'hold_tag'=>'zfsm_restore_'.$id,'hold_owned'=>true,'cancel_requested'=>false,'ack_boot'=>'test-boot','mode'=>'overwrite','bytes'=>10,'files'=>1,'conflicts'=>1,'recovery'=>$staging.'/replaced'];
    zfsmJobAtomicWrite(zfsmJobFile($id),$job);return $job;
}
function listHeldSnapshots($output,$code=0) {expectProcess('zfs',['list','-H','-p','-d','1','-t','snapshot','-o','name,guid','cache/data'],$output,$code);}
function holdRejected($fn) {try{$fn();}catch(Throwable$e){if(str_starts_with($e->getMessage(),'Unexpected simulated process:'))throw $e;return;}throw new RuntimeException('Expected uncertain hold ownership to be rejected');}
foreach(['truncated','bad GUID','duplicate name','duplicate GUID','outside dataset']as$case)check('uncertain snapshot inventory keeps cleanup owned '.$case,function()use($case){
    $job=heldJob();listHeldSnapshots(match($case){'truncated'=>"cache/data@renamed\t77\nshort",'bad GUID'=>"cache/data@renamed\tinvalid",'duplicate name'=>"cache/data@renamed\t77\ncache/data@renamed\t88",'duplicate GUID'=>"cache/data@renamed\t77\ncache/data@other\t77",'outside dataset'=>"cache/other@renamed\t77"});
    holdRejected(fn()=>zfsmReleaseRestoreHold($job));same(true,zfsmReadJob($job['id'])['hold_owned']);
});
foreach(['truncated','wrong snapshot','duplicate tag','empty tag']as$case)check('uncertain hold inventory keeps cleanup owned '.$case,function()use($case){
    $job=heldJob();listHeldSnapshots("cache/data@renamed\t77");$valid="cache/data@renamed\t".$job['hold_tag']."\tFri Oct 16 11:26 2026";
    expectProcess('zfs',['holds','-H','cache/data@renamed'],match($case){'truncated'=>$valid."\nshort",'wrong snapshot'=>"cache/other@saved\t".$job['hold_tag']."\tFri Oct 16 11:26 2026",'duplicate tag'=>$valid."\n".$valid,'empty tag'=>"cache/data@renamed\t\tFri Oct 16 11:26 2026"});
    holdRejected(fn()=>zfsmReleaseRestoreHold($job));same(true,zfsmReadJob($job['id'])['hold_owned']);
});
check('orphan cleanup follows snapshot GUID rename and preserves another jobs hold',function(){
    $job=heldJob();$other=heldJob(1);listHeldSnapshots("cache/data@other\t88\ncache/data@renamed\t77");
    expectProcess('zfs',['holds','-H','cache/data@renamed'],"cache/data@renamed\t".$other['hold_tag']."\tFri Oct 16 11:26 2026\ncache/data@renamed\t".$job['hold_tag']."\tFri Oct 16 11:26 2026");
    expectProcess('zfs',['release',$job['hold_tag'],'cache/data@renamed']);zfsmReleaseRestoreHold($job);
    same(false,zfsmReadJob($job['id'])['hold_owned']);same(true,zfsmReadJob($other['id'])['hold_owned']);
});
check('release failure retains durable ownership and cleanup queue retry',function(){
    $job=heldJob();listHeldSnapshots("cache/data@saved\t77");expectProcess('zfs',['holds','-H','cache/data@saved'],"cache/data@saved\t".$job['hold_tag']."\tFri Oct 16 11:26 2026");expectProcess('zfs',['release',$job['hold_tag'],'cache/data@saved'],'release failed',1);
    zfsmRunRestoreJob($job['id']);$after=zfsmReadJob($job['id']);same(true,$after['hold_owned']);same(true,$after['cleanup_retry_after']>time());same(false,in_array($job['id'],array_column(zfsmPendingJobs(),'id'),true));
});
check('confirmed absent snapshot clears only that jobs stale hold ownership',function(){
    $job=heldJob();listHeldSnapshots('');zfsmReleaseRestoreHold($job);same(false,zfsmReadJob($job['id'])['hold_owned']);
});
finishTests();
