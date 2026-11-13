<?php
// Read-only installer prerequisite. No plugin includes, worker or scheduler calls.
if(PHP_SAPI!=='cli')exit(2);
$root=$argv[1]??'/boot/config/plugins/zfs.master.ui';
$acceptedBoot=($argv[2]??'')==='accepted-boot';
$managedInstall=($argv[2]??'')==='install';
$requireRecovery=static function($message)use($acceptedBoot){fwrite(STDERR,'ZFS Director preflight: '.$message."\n");exit($acceptedBoot?10:1);};
try{
    if(!is_string($root)||!str_starts_with($root,'/')||str_contains($root,"\0")||str_contains($root,'..')||is_link($root))throw new RuntimeException('Unsafe persistent state path');
    $config=$root.'/zfs.master.ui.cfg';
    if(file_exists($config)||is_link($config)){
        if(is_link($config)||!is_file($config)||filesize($config)>1048576)throw new RuntimeException('Settings require inspection');
        $parsed=@parse_ini_file($config,true,INI_SCANNER_RAW);if(!is_array($parsed))$requireRecovery('Settings cannot be parsed; restore stopped for inspection');
        $flag=$parsed['general']['sanoid_integration']??'0';if((string)$flag!=='0'&&!(($acceptedBoot||$managedInstall)&&(string)$flag==='1'))$requireRecovery('Integration settings require inspection before upgrade');
    }
    $jobs=$root.'/jobs';if(is_link($jobs))throw new RuntimeException('Jobs path requires inspection');
    $pendingJobs=[];
    $scanJobs=function($directory,$skipIfDurable=null)use(&$pendingJobs,$requireRecovery){
        if(!is_dir($directory))return;
        $scan=opendir($directory);$count=0;
        // Only job journals count toward the bound: every journal also keeps a .lock file and may
        // sit next to other files, so counting raw directory entries refused healthy installs.
        try{while(($name=readdir($scan))!==false){if(!preg_match('/^[0-9]{8}-[0-9]{6}-[a-f0-9]{12}\.json$/D',$name))continue;if(++$count>50000)$requireRecovery('Jobs scan incomplete: more than 50000 job journals; restore stopped for inspection');
            // A promotion can crash between writing the durable copy and removing this leftover
            // (REL-002); once a durable record exists for this id, it alone is authoritative.
            if($skipIfDurable!==null&&is_file($skipIfDurable.'/'.$name))continue;
            $file=$directory.'/'.$name;
            if(is_link($file)||!is_file($file)||filesize($file)>131072)throw new RuntimeException('Job requires inspection before upgrade');$j=json_decode(file_get_contents($file),true,32);if(!is_array($j))$requireRecovery('Malformed job requires inspection');
            if(!is_array($j)||!is_string($j['state']??null))$requireRecovery('A job with an unreadable state requires inspection; background services stay paused.');
            if(in_array($j['state'],['queued','running'],true)){$label=trim(preg_replace('/[^\x20-\x7e]+/','',(string)($j['type']??'job').' '.(string)($j['source']??$j['label']??'')));$pendingJobs[]=substr($label===''?'job':$label,0,90).' ('.$j['state'].')';continue;}
            // Terminal file jobs can still release holds or delete ZIP staging.
            // Future expiry/retry times only defer that work after activation.
            if(in_array($j['type']??null,['restore','archive'],true)&&($j['hold_owned']??null)!==false)$requireRecovery('File job protection requires inspection; worker stays stopped');
            if(($j['type']??null)==='archive'&&($j['archive_removed']??null)!==true)$requireRecovery('Retained ZIP cleanup requires inspection; worker stays stopped');
        }}finally{closedir($scan);}
    };
    $scanJobs($jobs);
    // A scheduled policy check (REL-002) is queued only in the tmpfs runtime directory while
    // idle-capable; an update must refuse to proceed while one is in flight there too.
    $runtimeJobs='/var/tmp/'.basename($root).'/jobs/protection-queue';if(is_link($runtimeJobs))throw new RuntimeException('Jobs path requires inspection');
    $scanJobs($runtimeJobs,$jobs);
    if($pendingJobs){
        $shown=implode('; ',array_slice($pendingJobs,0,3)).(count($pendingJobs)>3?'; and '.(count($pendingJobs)-3).' more':'');
        $requireRecovery('Update paused: '.count($pendingJobs).' job(s) still queued or running: '.$shown.'. Nothing was changed and the installed version keeps running. Next: open Main > ZFS Director > Jobs, wait for these jobs to finish or cancel them, then run Plugins > Check for Updates again.');
    }
    echo "ZFS Director preflight: no pending execution or file cleanup. Settings and schedules retained.\n";
}catch(Throwable$e){fwrite(STDERR,'ZFS Director upgrade blocked: '.$e->getMessage()."\n");exit(1);}
