<?php
// Real kernel locks and a separate PHP worker. No native storage commands.
if(PHP_SAPI!=='cli')exit(2);
$base=dirname(__DIR__,2);
if($base!=='/stand'&&(!preg_match('~^/var/lib/zfsd-ownership-[a-z0-9_]+$~D',$base)||!is_file($base.'/ISOLATED-TEST-ONLY')))exit(2);
require $base.'/src/backend/ZFSMOperations.php';
$root=$base==='/stand'?'/test/protection-lock':$base.'/protection-lock';
foreach(['plugin_config'=>'/director.cfg','plugin_state'=>'/jobs','plugin_runtime'=>'/runtime','plugin_lock'=>'/mutation.lock','plugin_audit'=>'/audit']as$key=>$suffix)$GLOBALS[$key]=$root.$suffix;
function parse_plugin_cfg($p,$s){return parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_RAW)?:[];}
function lockExpect($ok,$message){if(!$ok)throw new RuntimeException($message);}
if(($argv[1]??'')==='child'){
    lockExpect(zfsmLockHeld(zfsmProtectionDirectory().'/config.lock'),'Parent must hold the real config lock');
    $job=zfsmReadJob($argv[2]);zfsmRunProtectionJob($job);
    echo json_encode(zfsmReadJob($job['id']),JSON_THROW_ON_ERROR);exit;
}
lockExpect(!file_exists($root),'Unique test root already exists');mkdir($root,0700);
file_put_contents($root.'/director.cfg',"[general]\nsanoid_integration=\"1\"\n");chmod($root.'/director.cfg',0600);
$policy=zfsmSanoidPolicy(['id'=>'abba','dataset'=>'fixture/no-native-commands','source_guid'=>'100']);
$store=zfsmProtectionReadStore();$store['policies'][$policy['id']]=$policy;zfsmProtectionWriteStore($store);
$job=zfsmNewProtectionJob('policy',$policy);
$after=zfsmProtectionConfigLock(function()use($job){
    zfsmJobAtomicWrite(zfsmJobFile($job['id']),$job);
    $child=runProcess(PHP_BINARY,[__FILE__,'child',$job['id']]);
    lockExpect($child['code']===0,'Concurrent worker failed: '.$child['output']);
    return json_decode($child['output'],true,32,JSON_THROW_ON_ERROR);
});
lockExpect($after===$job,'Config lock contention must leave the complete queued journal unchanged');
lockExpect(!zfsmLockHeld($GLOBALS['plugin_lock'])&&!zfsmLockHeld(zfsmProtectionDirectory().'/execution.lock'),'Deferred attempt leaked an execution or mutation lock');
// A normal later worker pass rechecks the gate; it does not bypass validation.
file_put_contents($root.'/director.cfg',"[general]\nsanoid_integration=\"0\"\n");
zfsmRunProtectionJob($job);$blocked=zfsmReadJob($job['id']);
lockExpect($blocked['state']==='recovery_required'&&str_contains($blocked['error'],'integration is disabled'),'Deferred job was not retried through the integration safety gate');
lockExpect(($blocked['started_at']??null)===null,'Disabled integration started execution');
zfsmRunProtectionJob($blocked);lockExpect(zfsmReadJob($job['id'])===$blocked,'A terminal journal must not automatically resume');
// Invalid lock storage is a hard error, never a retryable contention result.
$lock=zfsmProtectionDirectory().'/config.lock';unlink($lock);mkdir($lock,0700);
$bad=zfsmNewProtectionJob('policy',$policy);zfsmJobAtomicWrite(zfsmJobFile($bad['id']),$bad);zfsmRunProtectionJob($bad);
lockExpect(zfsmReadJob($bad['id'])['state']==='recovery_required','Cannot-open lock error was treated as contention');rmdir($lock);
symlink($root.'/wrong-lock',$lock);$bad=zfsmNewProtectionJob('policy',$policy);zfsmJobAtomicWrite(zfsmJobFile($bad['id']),$bad);zfsmRunProtectionJob($bad);
lockExpect(zfsmReadJob($bad['id'])['state']==='recovery_required'&&str_contains(zfsmReadJob($bad['id'])['error'],'Untrusted'),'Symlink lock was accepted');unlink($lock);
echo json_encode(['status'=>'PASS','contention_preserves_entire_queued_journal'=>true,'locks_released'=>true,'later_pass_rechecks_integration'=>true,'terminal_no_auto_resume'=>true,'invalid_lock_fails_closed'=>true,'symlink_fails_closed'=>true,'native_storage_operations'=>0],JSON_PRETTY_PRINT)."\n";
