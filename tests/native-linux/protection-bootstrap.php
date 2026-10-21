<?php
/** Real ZFS/Sanoid/Syncoid in the retained VM. Unraid discovery/scheduler paths
 * are explicitly isolated test fixtures, not evidence of Unraid acceptance. */
if(PHP_SAPI!=='cli')exit(2);
require dirname(__DIR__,2).'/src/backend/ZFSMOperations.php';
$base='/var/lib/zfs-director-native-20261018';
if(!is_file($base.'/ISOLATED-TEST-ONLY'))throw new RuntimeException('Native fixture marker is missing.');
$GLOBALS['plugin_config']=$base.'/director.cfg';$GLOBALS['plugin_state']=$base.'/jobs';$GLOBALS['plugin_runtime']=$base.'/runtime';$GLOBALS['plugin_lock']=$base.'/mutation.lock';$GLOBALS['plugin_audit']=$base.'/audit';
$GLOBALS['zfsm_protection_paths']=['manifest'=>$base.'/native-plugin-fixture.plg','sanoid'=>['/usr/sbin/sanoid'],'syncoid'=>['/usr/sbin/syncoid']];
$GLOBALS['zfsm_protection_cron_file']=$base.'/protection.cron';
$GLOBALS['zfsm_protection_scan_roots']=[$base.'/cron-fixture'];$GLOBALS['zfsm_protection_scan_patterns']=[];
function parse_plugin_cfg($p,$s){return parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_RAW)?:[];}
$results=[];
function nativeCheck($name,$fn){global$results;if(($only=getenv('ONLY'))&&!str_contains($name,$only))return;try{$detail=$fn();$r=['name'=>$name,'status'=>'PASS','detail'=>$detail];}catch(Throwable$e){$r=['name'=>$name,'status'=>'FAIL','error'=>$e->getMessage()];}$results[]=$r;echo json_encode($r,JSON_UNESCAPED_SLASHES)."\n";flush();}
function nativeExpect($ok,$message){if(!$ok)throw new RuntimeException($message);}
function nativeCommand($args){$r=runProcess('zfs',$args);if($r['code']!==0)throw new RuntimeException($r['output']);return $r['output'];}
function nativeJob($type,$id){$s=zfsmProtectionReadStore();$def=$s[$type==='policy'?'policies':'replications'][$id];$j=zfsmNewProtectionJob($type,$def);zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);zfsmRunProtectionJob($j);return zfsmReadJob($j['id']);}
