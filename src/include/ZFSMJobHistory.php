<?php
// Log retention never invokes ZFS or removes manifests, spools or saved data.
function zfsmJobHistoryPolicy() {
    return ['interval_seconds'=>3600,'days'=>30,'max_entries'=>1000,'max_bytes'=>32*1024*1024,'minimum_kept'=>100,'batch_limit'=>250,'duplicate_batch_limit'=>5000];
}
// Pin every existing directory component; missing metadata is never followed.
function zfsmJobHistoryPathProof($path) {
    if(!is_string($path)||!str_starts_with($path,'/')||preg_match('#(?:^|/)\.\.?(/|$)#',$path))throw new RuntimeException('Unsafe history path');
    $proof=[];$cursor='';foreach(explode('/',trim($path,'/'))as$part){$cursor.='/'.$part;clearstatcache(true,$cursor);$st=@lstat($cursor);if(!$st)return null;if(is_link($cursor)||($st['mode']&0170000)!==0040000)throw new RuntimeException('History directory identity requires inspection.');$proof[$cursor]=[$st['dev'],$st['ino']];}return $proof;
}
function zfsmJobHistoryGate($exclusive=false,$nonblocking=false) {
    zfsmJobHistoryPathProof($GLOBALS['plugin_state']);$path=zfsmJobDirectory($GLOBALS['plugin_state']).'/history.lock';
    if(is_link($path))throw new RuntimeException('Untrusted job history lock');
    $h=fopen($path,'ce');$st=$h?fstat($h):false;clearstatcache(true,$path);$named=@lstat($path);
    if(!$h||!$st||!$named||is_link($path)||($st['mode']&0170000)!==0100000||$st['nlink']!==1||$st['dev']!==$named['dev']||$st['ino']!==$named['ino']){if(is_resource($h))fclose($h);throw new RuntimeException('Job history lock unavailable');}
    if(!flock($h,($exclusive?LOCK_EX:LOCK_SH)|($nonblocking?LOCK_NB:0))){fclose($h);if($nonblocking)return null;throw new RuntimeException('Unable to lock job history');}
    return $h;
}
function zfsmJobHistoryStatus() {
    $file=$GLOBALS['plugin_runtime'].'/history-cleanup.json';$last=null;
    if(is_file($file)&&!is_link($file)&&filesize($file)<=16384){$value=json_decode(file_get_contents($file),true,8);if(is_array($value)&&is_int($value['checked_at']??null))$last=$value;}
    return ['policy'=>zfsmJobHistoryPolicy(),'last_cleanup'=>$last];
}
function zfsmJobHistoryTime($job) {
    $times=[];foreach(['created','updated','finished_at']as$key){$value=$job[$key]??null;$time=is_string($value)&&strlen($value)<=64?strtotime($value):false;if($time!==false&&$time>0)$times[]=$time;}
    return $times?max($times):null;
}
function zfsmJobHistoryEligible($job) {
    if(zfsmJobProblem($job)||$job['state']!=='completed'||!empty($job['error'])||!empty($job['hold_owned'])||!empty($job['cancel_requested'])||zfsmJobHistoryTime($job)===null)return false;
    if(!empty($job['result']['warning'])||!empty($job['result']['warnings'])||!in_array($job['result']['severity']??'info',['info','success'],true))return false;
    if($job['schema']===7)return is_array($job['result']??null)&&is_string($job['result']['summary']??null)&&$job['result']['summary']!==''&&$job['stage']==='completed'&&($job['result']['failed_count']??0)===0&&!zfsmRequestJobActive($job);
    // Conversion, file restore/ZIP and deletion journals describe saved data or
    // recovery evidence. Their retention is deliberately independent of logs.
    return $job['schema']===4&&$job['stage']==='finished'&&in_array($job['verified_outcome']??null,['completed','up_to_date','skipped'],true)&&($job['verification']['outcome']??null)===$job['verified_outcome'];
}
function zfsmJobHistoryReferences($value,&$pins,$self=null) {
    if(is_array($value)){foreach($value as$key=>$item){if(is_string($key))zfsmJobHistoryReferences($key,$pins,$self);zfsmJobHistoryReferences($item,$pins,$self);}return;}
    if(!is_string($value))return;
    preg_match_all('/[0-9]{8}-[0-9]{6}-[a-f0-9]{12}/',$value,$matches);foreach($matches[0]as$id)if($id!==$self)$pins[$id]=true;
}
function zfsmJobHistoryRegular($file) {
    clearstatcache(true,$file);$st=@lstat($file);
    if(!$st||is_link($file)||($st['mode']&0170000)!==0100000||$st['nlink']!==1)throw new RuntimeException('History contains an unsafe file; retained for inspection.');
    return $st;
}
// "Delete finished jobs": removes the records of finished jobs on request, on every page.
// Kept: queued or running jobs; anything that may still own data or a way to recover it
// (cancelled or failed conversions, restores and deletions, snapshot holds, ZIP staging not yet
// removed, recovery_required, journals that cannot be read safely); the latest run and the
// latest verified run of every policy and replication, which pool warnings and the Replication
// screen read; and journals other records refer to. Failed or cancelled protection and request
// jobs own no data (the recovery journals above do), so they are deleted. Datasets, snapshots
// and files are never touched. The caller holds the operation lock.
function zfsmJobKeepOnDelete($job,$pinned=false) {
    if(zfsmJobProblem($job))return 'needs inspection';
    $state=$job['state']??'';$schema=$job['schema']??null;
    if(in_array($state,['queued','running'],true))return 'running';
    if($state==='recovery_required')return 'needs recovery';
    if(!empty($job['hold_owned'])||(function_exists('zfsmArchiveNeedsCleanup')&&zfsmArchiveNeedsCleanup($job)))return 'still holds a snapshot or ZIP';
    // A conversion or deletion that retained an original keeps the only pointer to it in Jobs.
    if(in_array($schema,[1,6],true)&&!empty($job['recovery']))return 'retains an original for recovery';
    if($pinned)return 'latest result of a policy or replication';
    if($schema===4&&in_array($state,['completed','failed','cancelled'],true))return null;
    if($schema===7&&in_array($state,['completed','failed','cancelled'],true))return function_exists('zfsmRequestJobActive')&&zfsmRequestJobActive($job)?'running':null;
    if(function_exists('zfsmCleanupTerminalJob')&&zfsmCleanupTerminalJob($job))return null;
    return 'may own recovery data';
}
function zfsmJobDeleteFinished() {
    $gate=zfsmJobHistoryGate(true,true);if($gate===null)throw new RuntimeException('Jobs are being updated; try again in a moment.');
    $removed=0;$kept=[];$directory=zfsmJobDirectory($GLOBALS['plugin_state']);
    $keep=function($reason)use(&$kept){$kept[$reason]=($kept[$reason]??0)+1;};
    try{
        $names=@scandir($directory);if($names===false)throw new RuntimeException('Job storage is unavailable');
        $jobs=[];$unreadable=[];
        foreach($names as$name){
            if(!preg_match('/^([0-9]{8}-[0-9]{6}-[a-f0-9]{12})\.json$/D',$name,$match))continue;
            try{zfsmJobHistoryRegular($directory.'/'.$name);$jobs[$match[1]]=zfsmReadJob($match[1]);}catch(Throwable$error){$unreadable[$match[1]]=true;}
        }
        // Same pins as the hourly cleanup: latest and latest verified run per definition, and references.
        $pins=[];try{zfsmJobHistoryReferences(zfsmProtectionReadStore(),$pins);}catch(Throwable$error){}
        $order=$jobs;uasort($order,fn($a,$b)=>((zfsmJobHistoryTime($b)??PHP_INT_MAX)<=>(zfsmJobHistoryTime($a)??PHP_INT_MAX))?:strcmp($b['id'],$a['id']));
        $latest=[];foreach($order as$id=>$job){
            zfsmJobHistoryReferences($job,$pins,$id);
            if(($job['schema']??null)===4){$key=($job['type']??'').':'.($job['definition_id']??'');if(!isset($latest[$key])){$pins[$id]=true;$latest[$key]=true;}if(($job['verification']['verified']??false)===true&&!isset($latest[$key.':verified'])){$pins[$id]=true;$latest[$key.':verified']=true;}}
        }
        foreach($unreadable as$id=>$_)$keep('needs inspection');
        foreach($jobs as$id=>$job){
            $reason=zfsmJobKeepOnDelete($job,isset($pins[$id]));if($reason!==null){$keep($reason);continue;}
            $file=zfsmJobFile($id);$lock=$file.'.lock';$handle=null;
            if(file_exists($lock)||is_link($lock)){
                try{zfsmJobHistoryRegular($lock);}catch(Throwable$error){$keep('needs inspection');continue;}
                $handle=fopen($lock,'ce');if(!$handle||!flock($handle,LOCK_EX|LOCK_NB)){if($handle)fclose($handle);$keep('running');continue;}
            }
            try{
                if(!unlink($file))throw new RuntimeException('Unable to delete a job record.');$removed++;
                foreach([$lock,($GLOBALS['plugin_runtime']??'/var/tmp/zfs.master.ui/jobs').'/'.$id.'.json',$directory.'/visibility/jobs/'.$id.'.marker']as$aux)if(!is_link($aux)&&is_file($aux))@unlink($aux);
            }finally{if($handle){flock($handle,LOCK_UN);fclose($handle);}}
        }
        if($removed)zfsmAuditSyncDirectory($directory);
    }finally{flock($gate,LOCK_UN);fclose($gate);}
    ksort($kept);$left=array_sum($kept);
    $message='Deleted '.$removed.' finished job record(s).'.($left?' Kept '.$left.': '.implode(', ',array_map(fn($reason,$count)=>$count.' '.$reason,array_keys($kept),$kept)).'.':'');
    return ['succeeded'=>['jobs'=>$message],'failed'=>[],'deleted'=>$removed,'kept'=>$kept];
}
function zfsmJobHistoryCleanup($now=null) {
    $now=$now??time();$policy=zfsmJobHistoryPolicy();$last=zfsmJobHistoryStatus()['last_cleanup'];
    if($last!==null&&$now-$last['checked_at']<$policy['interval_seconds'])return ['skipped'=>'not_due'];
    $operation=zfsmAcquireOperationLock($GLOBALS['plugin_lock'],true);if($operation===null)return ['skipped'=>'operation_busy'];
    $gate=null;$config=null;$report=['checked_at'=>$now,'removed'=>0,'reclaimed_bytes'=>0,'protected'=>0,'minimum_kept'=>$policy['minimum_kept'],'blocked'=>false];
    try {
    try {
        $gate=zfsmJobHistoryGate(true,true);if($gate===null)return ['skipped'=>'journal_busy'];
        zfsmJobHistoryPathProof(dirname($GLOBALS['plugin_config']));zfsmJobHistoryPathProof(dirname($GLOBALS['plugin_config']).'/protection');$configPath=zfsmProtectionDirectory().'/config.lock';if(is_link($configPath))throw new RuntimeException('Protection state requires inspection.');$config=fopen($configPath,'ce');$configStat=$config?fstat($config):false;$configNamed=zfsmJobHistoryRegular($configPath);if(!$configStat||$configStat['dev']!==$configNamed['dev']||$configStat['ino']!==$configNamed['ino'])throw new RuntimeException('Protection lock identity changed.');if(!flock($config,LOCK_SH|LOCK_NB))return ['skipped'=>'configuration_busy'];
        $storeFile=zfsmProtectionDirectory().'/config.json';if(file_exists($storeFile)||is_link($storeFile))zfsmJobHistoryRegular($storeFile);$store=zfsmProtectionReadStore();$pins=[];zfsmJobHistoryReferences($store,$pins);
        $records=[];$bytes=0;$seen=0;$directory=zfsmJobDirectory($GLOBALS['plugin_state']);$scan=opendir($directory);
        try{while(($name=readdir($scan))!==false){if(++$seen>20000)throw new RuntimeException('History scan limit reached; no records removed.');if(!preg_match('/^([0-9]{8}-[0-9]{6}-[a-f0-9]{12})\.json$/D',$name,$match)){if(str_ends_with($name,'.json'))throw new RuntimeException('Unknown job journal; history retained for inspection.');continue;}
            $file=$directory.'/'.$name;$stat=zfsmJobHistoryRegular($file);if($stat['size']>131072||count($records)>=5000||$bytes+$stat['size']>64*1024*1024)throw new RuntimeException('History scan limit reached; no records removed.');
            $job=zfsmReadJob($match[1]);if(zfsmJobProblem($job))throw new RuntimeException('Invalid job journal; history retained for inspection.');$bytes+=$stat['size'];$records[$job['id']]=['job'=>$job,'stat'=>$stat,'hash'=>hash_file('sha256',$file),'time'=>zfsmJobHistoryTime($job)??PHP_INT_MAX];
            zfsmJobHistoryReferences($job,$pins,$job['id']);
        }}finally{closedir($scan);}
        uasort($records,fn($a,$b)=>($b['time']<=>$a['time'])?:strcmp($b['job']['id'],$a['job']['id']));
        $latest=[];foreach($records as$id=>$r)if($r['job']['schema']===4){$key=$r['job']['type'].':'.$r['job']['definition_id'];if(!isset($latest[$key])){$pins[$id]=true;$latest[$key]=true;}if(($r['job']['verification']['verified']??false)===true&&!isset($latest[$key.':verified'])){$pins[$id]=true;$latest[$key.':verified']=true;}}
        // A scheduled launch refused before anything ran used to write a new failed record every
        // minute. Of each run of identical refusals only the newest is kept, whatever its age.
        $duplicates=[];$firstRefusal=[];foreach($records as$id=>$r){if(!zfsmProtectionBlockedBeforeStart($r['job']))continue;$key=$r['job']['type'].':'.$r['job']['definition_id'].':'.hash('sha256',(string)($r['job']['error']??''));if(!isset($firstRefusal[$key])){$firstRefusal[$key]=true;continue;}if(!isset($pins[$id]))$duplicates[$id]=$r;}
        $eligible=[];foreach($records as$id=>$r){if(isset($duplicates[$id]))continue;if(isset($pins[$id])||!zfsmJobHistoryEligible($r['job']))$report['protected']++;else$eligible[$id]=$r;}
        $eligible=array_slice($eligible,$policy['minimum_kept'],null,true);$count=count($records);
        $duplicateRemoved=0;
        foreach(array_reverse($duplicates,true)+array_reverse($eligible,true)as$id=>$r){
            $duplicate=isset($duplicates[$id]);
            if($duplicate&&$duplicateRemoved>=$policy['duplicate_batch_limit'])continue;
            if(!$duplicate&&$report['removed']-$duplicateRemoved>=$policy['batch_limit'])break;
            if(!$duplicate&&$r['time']>$now-$policy['days']*86400&&$count<$policy['max_entries']&&$bytes<=$policy['max_bytes']-8192)continue;
            $file=zfsmJobFile($id);$stat=zfsmJobHistoryRegular($file);if($stat['dev']!==$r['stat']['dev']||$stat['ino']!==$r['stat']['ino']||hash_file('sha256',$file)!==$r['hash'])throw new RuntimeException('Job identity changed; remaining history retained.');
            $aux=[$file.'.lock',$GLOBALS['plugin_runtime'].'/'.$id.'.json',$GLOBALS['plugin_runtime'].'/requests/'.$id.'.lock',$directory.'/visibility/jobs/'.$id.'.marker'];
            $proofs=[];$existing=[];$locks=[];$busy=false;
            try{
                foreach(array_merge([$file],$aux)as$path){$proof=zfsmJobHistoryPathProof(dirname($path));if($proof===null)continue;if(!file_exists($path)&&!is_link($path))continue;$meta=zfsmJobHistoryRegular($path);$proofs[$path]=[$proof,$meta];$existing[]=$path;
                    if(str_ends_with($path,'.lock')){$h=fopen($path,'ce');$locks[]=$h;$opened=fstat($h);if(!$h||!flock($h,LOCK_EX|LOCK_NB)||$opened['dev']!==$meta['dev']||$opened['ino']!==$meta['ino']){$busy=true;break;}}
                }
                if($busy){$report['protected']++;continue;}
                foreach($proofs as$path=>[$proof,$meta]){$current=zfsmJobHistoryRegular($path);if(zfsmJobHistoryPathProof(dirname($path))!==$proof||$current['dev']!==$meta['dev']||$current['ino']!==$meta['ino'])throw new RuntimeException('History metadata identity changed; retained.');}
                // Exclusive history gate excludes every per-ID updater and its
                // waiters. Separate flock probes also preserve foreign live locks.
                if(!unlink($file))throw new RuntimeException('Unable to remove an expired log record.');
                $report['removed']++;if($duplicate){$duplicateRemoved++;$report['duplicates_removed']=$duplicateRemoved;}$count--;$bytes-=$stat['size'];$report['reclaimed_bytes']+=$stat['size'];
                foreach($existing as$path)if($path!==$file&&!unlink($path))throw new RuntimeException('Unable to remove expired log metadata.');
            }finally{foreach($locks as$h)if(is_resource($h)){flock($h,LOCK_UN);fclose($h);}}
        }
        $report['entries']=$count;$report['bytes']=$bytes;$report['over_limit']=$count>$policy['max_entries']||$bytes>$policy['max_bytes'];
        if($report['over_limit'])$report['warning']='Protected history or cleanup backlog exceeds the storage target; retained for inspection.';
        if($report['removed'])zfsmAuditSyncDirectory($directory);
    } catch(Throwable$error){$report['blocked']=true;$report['warning']=$error->getMessage();}
    finally {foreach([$config,$gate]as$handle)if(is_resource($handle)){flock($handle,LOCK_UN);fclose($handle);}}
    zfsmJobAtomicWrite(zfsmJobDirectory($GLOBALS['plugin_runtime']).'/history-cleanup.json',$report);
    if($report['removed']){zfsmRequestJobBegin('jobhistorycleanup',['cmd'=>'jobhistorycleanup']);$summary=zfsmRequestJobFinish('completed','Removed '.$report['removed'].' expired log records ('.$report['reclaimed_bytes'].' bytes). Datasets, snapshots and recovery files were not changed.','completed',['removed'=>$report['removed'],'reclaimed_bytes'=>$report['reclaimed_bytes']]);if(isset($report['entries'],$report['bytes'])){$report['entries']++;$report['bytes']+=filesize(zfsmJobFile($summary['id']));$report['over_limit']=$report['entries']>$policy['max_entries']||$report['bytes']>$policy['max_bytes'];}zfsmJobAtomicWrite($GLOBALS['plugin_runtime'].'/history-cleanup.json',$report);}
    return $report;
    }finally{flock($operation,LOCK_UN);fclose($operation);}
}
