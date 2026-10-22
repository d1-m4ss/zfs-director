<?php
// Unraid calls post-hooks after saving the PLG and its registration symlink.
if(PHP_SAPI!=='cli')exit(2);
if(($argv[1]??'')!=='plugin'||!in_array($argv[2]??'',['install','update'],true)||!in_array($argv[3]??'',['zfs-director.plg','zfs.master.ui.plg','zfs.master.ui.local.plg'],true)||($argv[4]??'')!=='')exit(0);
$live=dirname(__DIR__);$state='/boot/config/plugins/zfs.master.ui';$runtime='/var/tmp/zfs.master.ui/jobs';$pending=$runtime.'/install-pending.json';
if(!file_exists($pending)&&!is_link($pending))exit(0);
$locks=[];$activationStarted=false;
function zfsdInstallFile($path): void {
    clearstatcache(true,$path);$s=@lstat($path);
    if(!$s||is_link($path)||($s['mode']&0170000)!==0100000||$s['uid']!==0||$s['nlink']!==1)throw new RuntimeException('Untrusted installation file: '.$path);
    for($p=dirname($path);$p!=='/';$p=dirname($p))if(is_link($p)||!is_dir($p))throw new RuntimeException('Untrusted installation directory: '.$p);
}
function zfsdInstallRun(array $command): string {
    $pipes=[];$p=proc_open($command,[0=>['file','/dev/null','r'],1=>['pipe','w'],2=>['redirect',1]],$pipes,null,null,['bypass_shell'=>true]);
    if(!is_resource($p))throw new RuntimeException('Unable to start installation check');
    $output=stream_get_contents($pipes[1]);fclose($pipes[1]);$status=proc_close($p);
    if($status!==0)throw new RuntimeException(trim($output)?:'Installation check failed (exit '.$status.')');return $output;
}
function zfsdInstallCronLines(string $text): array {
    $lines=array_values(array_filter(explode("\n",$text),static fn($s)=>trim($s)!==''&&!str_starts_with(ltrim($s),'#')));sort($lines,SORT_STRING);return $lines;
}
try{
    foreach(['/var/lock/zfs.master.ui.lock',$state.'/protection/config.lock',$state.'/protection/execution.lock']as$p){
        zfsdInstallFile($p);$h=fopen($p,'ce');$s=$h?fstat($h):false;$named=lstat($p);
        if(!$h||!$s||$s['dev']!==$named['dev']||$s['ino']!==$named['ino']||!flock($h,LOCK_EX|LOCK_NB)){if(is_resource($h))fclose($h);throw new RuntimeException('Director is busy; installation activation stays paused');}$locks[]=$h;
    }
    zfsdInstallFile($pending);if(filesize($pending)>4096)throw new RuntimeException('Invalid installation receipt');
    $pendingIdentity=lstat($pending);$pendingHash=hash_file('sha256',$pending);
    $plan=json_decode(file_get_contents($pending),true,8,JSON_THROW_ON_ERROR);
    if(($plan['registration']??null)!==$argv[3])exit(0);
    $sha=$plan['sha256']??'';if(!is_string($sha)||!preg_match('/^[a-f0-9]{64}$/D',$sha))throw new RuntimeException('Invalid package checksum');
    $registration='/var/log/plugins/'.$argv[3];$manifest='/boot/config/plugins/'.$argv[3];
    if(!is_link($registration)||readlink($registration)!==$manifest)throw new RuntimeException('Plugin Manager registration is not complete');
    zfsdInstallFile($manifest);zfsdInstallFile($state.'/installed.sha256');
    if(trim(file_get_contents($state.'/installed.sha256'))!==$sha)throw new RuntimeException('Installed receipt differs from the staged package');
    $xml=simplexml_load_file($manifest,SimpleXMLElement::class,LIBXML_NONET);
    if(!$xml||(string)$xml['name']!=='zfs.master.ui')throw new RuntimeException('Unexpected plugin registration');
    $archive=null;
    foreach($xml->FILE as$file){$name=(string)$file['Name'];if(preg_match('~^'.preg_quote($state,'~').'/zfs-director-[0-9.]+\.tgz$~D',$name)){$archive=$name;zfsdInstallFile($name);if((string)$file->MD5!==md5_file($name)||hash_file('sha256',$name)!==$sha)throw new RuntimeException('Registered package checksum mismatch');}}
    if($archive===null)throw new RuntimeException('Registered package is missing');
    zfsdInstallRun(['/bin/bash','-c','cd "$1" && sha256sum -c SHA256SUMS','bash',$live]);
    if(zfsdInstallRun(['/bin/tar','-xOf',$archive,'zfs.master.ui/SHA256SUMS'])!==file_get_contents($live.'/SHA256SUMS'))throw new RuntimeException('Runtime differs from the registered package');
    zfsdInstallFile($runtime.'/stop');
    if(!empty($plan['hold_recovery'])){echo "ZFS Director installed. Background services stay paused: inspect pending recovery in Jobs.\n";exit(0);}
    zfsdInstallRun([PHP_BINARY,$live.'/scripts/zfsm-upgrade-preflight.php',$state,'install']);
    // Rebuild only when current entries are accounted for by saved plugin
    // sources. Never silently discard manually injected crontab entries.
    $current=is_file('/etc/cron.d/root')?zfsdInstallRun(['/usr/bin/crontab','-c','/etc/cron.d','-l']):'';$sources=[];
    $namespaces=['dynamix'];foreach(glob('/var/log/plugins/*.plg')?:[]as$p)$namespaces[]=basename($p,'.plg');
    foreach(array_unique($namespaces)as$name)foreach(glob('/boot/config/plugins/'.$name.'/*.cron')?:[]as$p){zfsdInstallFile($p);$sources=array_merge($sources,zfsdInstallCronLines(file_get_contents($p)));}
    sort($sources,SORT_STRING);
    $own=static fn($line)=>str_contains($line,'/zfs.master.ui/scripts/zfsm-protection.php');
    $external=array_values(array_filter(zfsdInstallCronLines($current),static fn($line)=>!$own($line)));
    if(array_values(array_filter($sources,static fn($line)=>!$own($line)))!==$external)throw new RuntimeException('Current external cron differs from registered sources; retained unchanged, activation paused');
    $cron='/boot/config/plugins/'.basename($argv[3],'.plg').'/protection.cron';
    $expected=is_file($cron)?zfsdInstallCronLines(file_get_contents($cron)):[];
    if(array_diff(array_values(array_filter(zfsdInstallCronLines($current),$own)),$expected))throw new RuntimeException('Current cron contains an unrecognized Director launch; retained unchanged');
    if(array_values(array_filter($sources,$own))!==$expected)throw new RuntimeException('Saved cron contains duplicate or unrecognized Director launches; retained unchanged');
    try{
        zfsdInstallRun(['/bin/bash','/usr/local/sbin/update_cron']);
        $after=is_file('/etc/cron.d/root')?zfsdInstallRun(['/usr/bin/crontab','-c','/etc/cron.d','-l']):'';
        if(zfsdInstallCronLines($after)!==$sources)throw new RuntimeException('Cron readback differs from verified sources');
    }catch(Throwable$error){
        $restore=tempnam($runtime,'.cron-rollback-');
        try{if($restore===false||file_put_contents($restore,$current)!==strlen($current))throw new RuntimeException('Cannot retain cron rollback');zfsdInstallRun(['/usr/bin/crontab','-c','/etc/cron.d',$restore]);}
        finally{if(is_string($restore)&&is_file($restore))unlink($restore);}
        throw $error;
    }
    $activationStarted=true;
    if(!unlink($runtime.'/stop'))throw new RuntimeException('Unable to release installer maintenance pause');
    zfsdInstallRun([PHP_BINARY,$live.'/scripts/zfsm-worker.php','--launch']);
    $deadline=microtime(true)+15;
    do{
        $ready=true;
        foreach(['/var/lock/zfs.master.ui.service.lock','/var/lock/zfs.master.ui.worker.lock',$runtime.'/monitor.lock']as$p){
            if(!is_file($p)||is_link($p)){$ready=false;break;}$h=fopen($p,'ce');if(flock($h,LOCK_EX|LOCK_NB)){flock($h,LOCK_UN);$ready=false;}fclose($h);
        }
        if($ready)break;usleep(100000);
    }while(microtime(true)<$deadline);
    if(!$ready)throw new RuntimeException('Background services did not become ready');
    clearstatcache(true,$pending);$now=lstat($pending);
    if($now['dev']!==$pendingIdentity['dev']||$now['ino']!==$pendingIdentity['ino']||hash_file('sha256',$pending)!==$pendingHash)throw new RuntimeException('Installation receipt changed during activation');
    if(!unlink($pending))throw new RuntimeException('Unable to finalize installation receipt');
    foreach($locks as$h){flock($h,LOCK_UN);fclose($h);}$locks=[];
    echo "ZFS Director ready: registration verified, schedules restored without duplicates, worker and monitor running.\n";
}catch(Throwable$error){
    // No code rollback underneath running processes; retain the installed UI.
    // Publish the pause before releasing config/execution locks so cron cannot
    // enqueue work in the gap after a failed activation.
    $stopped=false;$pauseRequested=false;
    if($activationStarted)try{zfsdInstallFile($pending);if(file_exists($runtime.'/stop')||is_link($runtime.'/stop'))zfsdInstallFile($runtime.'/stop');if(file_put_contents($runtime.'/stop','Installation activation requires inspection',LOCK_EX)===false)throw new RuntimeException('Cannot request pause');$pauseRequested=true;}catch(Throwable$ignored){}
    foreach($locks as$h){flock($h,LOCK_UN);fclose($h);}
    if($pauseRequested)try{zfsdInstallRun([PHP_BINARY,$live.'/scripts/zfsm-worker.php','--stop']);$stopped=true;}catch(Throwable$ignored){}
    echo 'ZFS Director installed; '.($stopped?'background services PAUSED':'activation incomplete; maintenance state retained for inspection').': '.$error->getMessage()."\n";exit(1);
}
