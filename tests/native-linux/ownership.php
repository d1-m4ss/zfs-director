<?php
// Caller must provide disposable or mount-namespace-isolated /boot and /tmp.
// Real Linux /proc, permissions, flock and rename; private crontab via PATH.
if(getenv('ZFSM_OWNERSHIP_ISOLATED_PATHS')!=='1')throw new RuntimeException('Isolated fixture paths are required.');
$base=getenv('ZFSM_NATIVE_ROOT')?:'/stand';
if($base!=='/stand'){
    if(!preg_match('~^/var/lib/zfsd-ownership-[a-z0-9_-]+$~D',$base)||!is_file($base.'/ISOLATED-TEST-ONLY'))throw new RuntimeException('Private VM fixture marker is required.');
    $mounts=file_get_contents('/proc/self/mountinfo');
    foreach(['/boot','/tmp','/etc/sanoid','/usr/local/sbin']as$path)if(!preg_match('~^[^\n]* '.preg_quote($path,'~').' [^\n]* - tmpfs ~m',$mounts))throw new RuntimeException('Private tmpfs fixture mount is required: '.$path);
}
require $base.'/src/backend/ZFSMOperations.php';
$GLOBALS['plugin_config']=$base.'/os-state/director.cfg';
mkdir($base.'/os-state',0700,true);
$bin=$base.'/bin';if(!is_dir($bin))mkdir($bin,0700,true);
file_put_contents($bin.'/crontab',"#!/bin/sh\ncat \"\$ZFSM_NATIVE_ROOT/live.cron\"\n");chmod($bin.'/crontab',0700);
if(!is_file($base.'/live.cron'))file_put_contents($base.'/live.cron','');
putenv('ZFSM_NATIVE_ROOT='.$base);putenv('PATH='.$bin.':'.getenv('PATH'));
$script='/boot/config/plugins/user.scripts/scripts/legacy/script';
foreach([dirname($script),'/tmp/user.scripts']as$d)mkdir($d,0755,true);
$registry=[$script=>['script'=>$script,'frequency'=>'disabled','custom'=>'15 3 * * *','id'=>'fixturelegacy']];
foreach(['/boot/config/plugins/user.scripts/schedule.json','/tmp/user.scripts/schedule.json']as$f){file_put_contents($f,json_encode($registry));chmod($f,0600);}
file_put_contents($script,"#!/bin/sh\necho ready\nread -r reply\n");chmod($script,0700);
$results=[];
function verifyNative($ok,$message){if(!$ok)throw new RuntimeException($message);}
function checkNative($name,$fn){global$results;try{$fn();$r=['name'=>$name,'status'=>'PASS'];}catch(Throwable$e){$r=['name'=>$name,'status'=>'FAIL','error'=>$e->getMessage()];}$results[]=$r;echo json_encode($r)."\n";}
checkNative('disabled source verified using actual Linux process inventory',function()use($script){verifyNative(zfsmOwnershipSchedulerProof($script)['state']==='disabled','Idle source not proven');});
checkNative('real source process and running marker prevent transfer',function()use($script){
    $p=proc_open(['/bin/sh',$script],[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes);verifyNative(is_resource($p),'Spawn failed');
    try{verifyNative(trim(fgets($pipes[1]))==='ready','Fixture not ready');verifyNative(zfsmOwnershipSchedulerProof($script)['state']==='running','Running script missed');
    }finally{fwrite($pipes[0],"done\n");foreach($pipes as$pipe)fclose($pipe);proc_close($p);}
    $p=proc_open(['/bin/sleep','30'],[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes);verifyNative(is_resource($p),'Marker fixture spawn failed');
    try{mkdir('/tmp/user.scripts/running',0755);$marker='/tmp/user.scripts/running/legacy';file_put_contents($marker,(string)proc_get_status($p)['pid']);chmod($marker,0600);verifyNative(zfsmOwnershipSchedulerProof($script)['state']==='running','PID marker without source argv missed');unlink($marker);}
    finally{proc_terminate($p);foreach($pipes as$pipe)fclose($pipe);proc_close($p);}
    verifyNative(zfsmOwnershipSchedulerProof($script)['state']==='disabled','Exited source still blocked');
});
checkNative('world writable source and symlink are rejected on Linux',function()use($script){
    chmod($script,0777);try{zfsmOwnershipReadFile($script);throw new LogicException('Writable source accepted');}catch(RuntimeException$e){}finally{chmod($script,0700);}
    symlink($script,$script.'.link');try{zfsmOwnershipReadFile($script.'.link');throw new LogicException('Symlink accepted');}catch(RuntimeException$e){}finally{unlink($script.'.link');}
});
checkNative('config flock excludes a second PHP process and releases normally',function()use($base){
    $code='require '.var_export($base.'/src/backend/ZFSMOperations.php',true).';$GLOBALS["plugin_config"]='.var_export($GLOBALS['plugin_config'],true).';try{zfsmProtectionConfigLock(fn()=>null);echo "acquired";}catch(RuntimeException $e){echo "busy";}';
    $run=fn()=>runProcess(PHP_BINARY,['-r',$code]);
    zfsmProtectionConfigLock(function()use($run){$r=$run();verifyNative($r['code']===0&&$r['output']==='busy','Second process acquired held lock');});
    $r=$run();verifyNative($r['code']===0&&$r['output']==='acquired','Normal release failed');
});
checkNative('Director state persists atomically with a readback and retained previous version',function(){
    $first=['version'=>1,'policies'=>[],'replications'=>[],'owned_snapshots'=>[]];zfsmProtectionWriteStore($first);$second=$first;$second['external_reviews']=[];zfsmProtectionWriteStore($second);
    verifyNative(zfsmProtectionReadStore()===$second,'Readback mismatch');verifyNative(json_decode(file_get_contents(zfsmProtectionDirectory().'/config.json.bak'),true)===$first,'Previous state lost');
});
$failed=count(array_filter($results,fn($r)=>$r['status']!=='PASS'));$report=['provenance'=>'Real Linux /proc, processes, filesystem and cross-PHP flock; private crontab fixture.','results'=>$results,'failed'=>$failed];file_put_contents($base.'/os-results.json',json_encode($report,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES)."\n");echo json_encode($report)."\n";exit($failed?1:0);
