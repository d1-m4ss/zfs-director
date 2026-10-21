<?php
// Read-only installer prerequisite. No plugin includes, worker or scheduler calls.
if(PHP_SAPI!=='cli')exit(2);
$root=$argv[1]??'/boot/config/plugins/zfs.master.ui';
$acceptedBoot=($argv[2]??'')==='accepted-boot';
$requireRecovery=static function($message)use($acceptedBoot){fwrite(STDERR,'RC4 preflight: '.$message."\n");exit($acceptedBoot?10:1);};
try{
    if(!is_string($root)||!str_starts_with($root,'/')||str_contains($root,"\0")||str_contains($root,'..')||is_link($root))throw new RuntimeException('Unsafe persistent state path');
    $config=$root.'/zfs.master.ui.cfg';
    if(file_exists($config)||is_link($config)){
        if(is_link($config)||!is_file($config)||filesize($config)>1048576)throw new RuntimeException('Settings require inspection');
        $parsed=@parse_ini_file($config,true,INI_SCANNER_RAW);if(!is_array($parsed))$requireRecovery('Settings cannot be parsed; restore stopped for inspection');
        $flag=$parsed['general']['sanoid_integration']??'0';if((string)$flag!=='0'&&!($acceptedBoot&&(string)$flag==='1'))$requireRecovery('Disable Sanoid/Syncoid integration explicitly before this RC upgrade');
    }
    $jobs=$root.'/jobs';if(is_link($jobs))throw new RuntimeException('Jobs path requires inspection');
    if(is_dir($jobs)){
        $scan=opendir($jobs);$count=0;
        try{while(($name=readdir($scan))!==false){if(++$count>4096)$requireRecovery('Jobs scan incomplete; restore stopped for inspection');if(!preg_match('/^[0-9]{8}-[0-9]{6}-[a-f0-9]{12}\.json$/D',$name))continue;$file=$jobs.'/'.$name;
            if(is_link($file)||!is_file($file)||filesize($file)>131072)throw new RuntimeException('Job requires inspection before upgrade');$j=json_decode(file_get_contents($file),true,32);if(!is_array($j))$requireRecovery('Malformed job requires inspection');
            if(!is_array($j)||!is_string($j['state']??null)||in_array($j['state'],['queued','running'],true))$requireRecovery('Pending or unverified jobs require inspection; worker stays stopped');
            // Terminal file jobs can still release holds or delete ZIP staging.
            // Future expiry/retry times only defer that work after activation.
            if(in_array($j['type']??null,['restore','archive'],true)&&($j['hold_owned']??null)!==false)$requireRecovery('File job protection requires inspection; worker stays stopped');
            if(($j['type']??null)==='archive'&&($j['archive_removed']??null)!==true)$requireRecovery('Retained ZIP cleanup requires inspection; worker stays stopped');
        }}finally{closedir($scan);}
    }
    echo $acceptedBoot?"RC4 preflight: accepted boot reconstruction; no pending recovery. State and schedules unchanged.\n":"RC4 preflight: integration disabled; no queued/running jobs. State and schedules unchanged.\n";
}catch(Throwable$e){fwrite(STDERR,'RC4 upgrade blocked: '.$e->getMessage()."\n");exit(1);}
