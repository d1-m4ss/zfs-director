<?php
// UX-012: zfsmOperationLockStatus() reads the real kernel lock owner from /proc/locks and
// never takes the lock itself. A separate PHP process holds the lock, as a running operation does.
if(PHP_SAPI!=='cli')exit(2);
require '/stand/src/backend/ZFSMOperations.php';
$root='/test/operation-status';
foreach(['plugin_config'=>'/director.cfg','plugin_state'=>'/jobs','plugin_runtime'=>'/runtime','plugin_lock'=>'/mutation.lock','plugin_audit'=>'/audit']as$key=>$suffix)$GLOBALS[$key]=$root.$suffix;
function parse_plugin_cfg($p,$s){return [];}
function statusExpect($ok,$message){if(!$ok)throw new RuntimeException($message);}
if(($argv[1]??'')==='hold'){
    $h=zfsmAcquireOperationLock($GLOBALS['plugin_lock']);
    if(($argv[2]??'')==='describe')zfsmOperationLockDescribe('Rename dataset','tank/a','20261114-120000-aaaaaaaaaaaa');
    touch($root.'/ready');for($n=0;$n<200&&!file_exists($root.'/release');$n++)usleep(50000);
    zfsmOperationLockForget();flock($h,LOCK_UN);fclose($h);exit(0);
}
if(!is_dir($root))mkdir($root,0700,true);foreach(['/runtime','/jobs','/audit']as$d)if(!is_dir($root.$d))mkdir($root.$d,0700);
touch($GLOBALS['plugin_lock']);
statusExpect(zfsmOperationLockStatus()===null,'A free lock must report no running operation');
$hold=function(string $mode,callable $check)use($root){
    @unlink($root.'/ready');@unlink($root.'/release');
    $p=proc_open([PHP_BINARY,__FILE__,'hold',$mode],[0=>['file','/dev/null','r'],1=>['file','/dev/null','w'],2=>['file',$root.'/holder.log','a']],$pipes);
    try{for($n=0;$n<100&&!file_exists($root.'/ready');$n++)usleep(50000);statusExpect(file_exists($root.'/ready'),'Holder did not take the lock: '.@file_get_contents($root.'/holder.log'));$check();}
    finally{touch($root.'/release');proc_close($p);}
};
$hold('describe',function(){
    $status=zfsmOperationLockStatus();
    statusExpect($status===['label'=>'Rename dataset','subject'=>'tank/a','job'=>'20261114-120000-aaaaaaaaaaaa','minutes'=>0],'Busy lock must name the operation: '.json_encode($status));
    $again=zfsmOperationLockStatus();statusExpect($again===$status,'Reading the status must not change the lock');
});
statusExpect(zfsmOperationLockStatus()===null,'The status must clear once the holder releases the lock');
// A stale description from another PID is never shown; the lock is still reported as held.
file_put_contents($GLOBALS['plugin_runtime'].'/lock-owner.json',json_encode(['label'=>'Old operation','subject'=>null,'job'=>null,'pid'=>1,'started'=>time()]));
statusExpect(zfsmOperationLockStatus()===null,'A stale description without a lock holder must report nothing');
$hold('plain',function(){
    $status=zfsmOperationLockStatus();
    statusExpect($status===['label'=>null,'subject'=>null,'job'=>null,'minutes'=>null],'A stale description must not be attributed to another holder: '.json_encode($status));
});
echo json_encode(['status'=>'PASS','free_lock_reports_nothing'=>true,'busy_lock_names_operation'=>true,'read_only'=>true,'stale_description_ignored'=>true])."\n";
