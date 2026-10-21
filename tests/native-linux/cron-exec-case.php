<?php
if(PHP_SAPI!=='cli'||getenv('ZFSM_CRON_EXEC_PRIVATE')!=='1')exit(2);
$root=getenv('ZFSM_CRON_EXEC_ROOT');$candidate=($argv[1]??'')==='candidate';
if(!preg_match('~^/var/lib/zfsd-ownership-[a-z0-9_]+/cron-exec$~D',$root))exit(2);
require ($candidate?$root.'/candidate/src':dirname($root).'/src').'/backend/ZFSMOperations.php';
$GLOBALS['plugin_config']=$root.'/state/director.cfg';$GLOBALS['plugin_state']=$root.'/state/jobs';$GLOBALS['plugin_runtime']=$root.'/state/runtime';$GLOBALS['plugin_audit']=$root.'/state/audit';$GLOBALS['zfsm_protection_cron_file']='/boot/config/plugins/zfs.master.ui.local/protection.cron';$GLOBALS['zfsm_protection_scan_roots']=[$root.'/scan'];$GLOBALS['zfsm_protection_scan_patterns']=[];
function parse_plugin_cfg($p,$s){return [];}
$empty=['version'=>1,'policies'=>[],'replications'=>[],'owned_snapshots'=>[]];$s=$empty;$s['policies']['acff']=['id'=>'acff','owner'=>'managed','dataset'=>'director_it_1018/isolated-cron-fixture','enabled'=>true,'schedule'=>'* * * * *'];
$entries=fn($text)=>array_values(array_filter(array_map('trim',explode("\n",$text)),fn($line)=>$line!==''&&!str_starts_with($line,'#')));
zfsmProtectionWriteStore($empty);$foreign=file_get_contents('/boot/config/plugins/dynamix/foreign.cron');$before=file_get_contents($root.'/live.cron');$error=null;
try{zfsmProtectionApplyStore($s);}catch(Throwable$e){$error=$e->getMessage();}
if(!$candidate){$ok=$error==='Schedule activation and rollback failed; inspect cron and retained configuration.'&&zfsmProtectionReadStore()===$empty&&file_get_contents($root.'/live.cron')===$before;}
else{$ok=$error===null&&zfsmProtectionReadStore()===$s&&substr_count(file_get_contents($root.'/live.cron'),'/zfsm-protection.php')===1;
 if($ok){$first=file_get_contents($root.'/live.cron');zfsmProtectionApplyStore($s);$ok=file_get_contents($root.'/live.cron')===$first;zfsmProtectionApplyStore($empty);$ok=$ok&&$entries(file_get_contents($root.'/live.cron'))===$entries($before);}
}
$ok=$ok&&file_get_contents('/boot/config/plugins/dynamix/foreign.cron')===$foreign;
echo json_encode(['variant'=>$candidate?'candidate':'unchanged_product','status'=>$ok?'PASS':'FAIL','expected_original_failure'=>!$candidate,'error'=>$error,'foreign_cron_unchanged'=>file_get_contents('/boot/config/plugins/dynamix/foreign.cron')===$foreign,'live_schedules_restored'=>$entries(file_get_contents($root.'/live.cron'))===$entries($before),'live_cron_bytes_identical'=>file_get_contents($root.'/live.cron')===$before,'updater_sha256'=>hash_file('sha256','/usr/local/sbin/update_cron'),'backend_sha256'=>hash_file('sha256',($candidate?$root.'/candidate/src':dirname($root).'/src').'/include/ZFSMProtectionJobs.php')],JSON_PRETTY_PRINT)."\n";exit($ok?0:1);
