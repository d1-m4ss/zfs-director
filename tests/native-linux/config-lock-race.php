<?php
// Deterministic diagnostic against a retained immutable VM source copy.
if(PHP_SAPI!=='cli')exit(2);
$base=dirname(__FILE__);if(!preg_match('~^/var/lib/zfsd-ownership-[a-z0-9_]+$~D',$base)||!is_file($base.'/ISOLATED-TEST-ONLY'))exit(2);
require $base.'/src/backend/ZFSMOperations.php';$root=$base.'/config-race';
$GLOBALS['plugin_config']=$root.'/director.cfg';$GLOBALS['plugin_state']=$root.'/jobs';$GLOBALS['plugin_runtime']=$root.'/runtime';$GLOBALS['plugin_lock']=$root.'/mutation.lock';$GLOBALS['plugin_audit']=$root.'/audit';
function parse_plugin_cfg($p,$s){return parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_RAW)?:[];}
if(($argv[1]??'')==='child'){
 if(!zfsmLockHeld(zfsmProtectionDirectory().'/config.lock'))throw new RuntimeException('Parent fixture config lock is not held');
 $j=zfsmReadJob($argv[2]);zfsmRunProtectionJob($j);$j=zfsmReadJob($j['id']);echo json_encode(['id'=>$j['id'],'state'=>$j['state'],'outcome'=>$j['verified_outcome'],'reason'=>$j['verification']['reason']??null,'started_at'=>$j['started_at']??null]);exit;
}
if(file_exists($root))throw new RuntimeException('Unique diagnostic root already exists');mkdir($root,0700);file_put_contents($root.'/director.cfg',"[general]\nsanoid_integration=\"1\"\n");chmod($root.'/director.cfg',0600);
$p=zfsmSanoidPolicy(['id'=>'abba','dataset'=>'director_it_1018/nonexistent-race-diagnostic','source_guid'=>'100']);$s=zfsmProtectionReadStore();$s['policies'][$p['id']]=$p;zfsmProtectionWriteStore($s);$j=zfsmNewProtectionJob('policy',$p);
$out=zfsmProtectionConfigLock(function()use($j){zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);$child=runProcess(PHP_BINARY,[__FILE__,'child',$j['id']]);if($child['code']!==0)throw new RuntimeException('Diagnostic child failed');return json_decode($child['output'],true,16,JSON_THROW_ON_ERROR);});
$before=zfsmReadJob($j['id']);zfsmRunProtectionJob($before);$after=zfsmReadJob($j['id']);$confirmed=$out['state']==='recovery_required'&&$out['reason']==='Protection configuration is being changed.'&&$out['started_at']===null&&$before===$after;
echo json_encode(['status'=>$confirmed?'REPRODUCED':'NOT_REPRODUCED','held_by_parent'=>true,'job_published_while_queue_config_lock_held'=>true,'worker'=>$out,'no_auto_resume_after_release'=>$before===$after,'no_native_operation'=>true,'explanation'=>'Worker sees atomically published queued journal before producer releases config.lock; nonblocking reservation failure is converted to terminal recovery_required instead of deferring the queued job.'],JSON_PRETTY_PRINT)."\n";exit($confirmed?0:1);
