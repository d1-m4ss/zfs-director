<?php
require_once __DIR__.'/ZFSMRecoveryCleanup.php';
require_once __DIR__.'/ZFSMLastResults.php';
// Log retention never invokes ZFS or removes manifests, spools or saved data.
// Settings > Keep finished jobs for: 1, 7 or 30 days, or 0 = always. Default 7.
function zfsmJobRetentionDays() {
    $value=null;$exists=false;
    try{
        $file=$GLOBALS['plugin_config']??null;
        $exists=is_string($file)&&is_file($file);
        $stored=$exists?@parse_ini_file($file,true,INI_SCANNER_NORMAL):null;
        // A settings file that exists but cannot be read must never fall back to deleting.
        if($exists&&!is_array($stored))return null;
        if(is_array($stored)){$value=$stored['job_retention_days']??($stored['general']['job_retention_days']??null);}
        elseif(function_exists('parse_plugin_cfg')){$cfg=parse_plugin_cfg($GLOBALS['plugin'],true);$value=is_array($cfg)?($cfg['job_retention_days']??null):null;}
    }catch(Throwable$error){if(!empty($exists))return null;}
    return in_array((string)$value,['0','1','7','30'],true)?(int)$value:7;
}
function zfsmJobHistoryPolicy() {
    return ['interval_seconds'=>3600,'days'=>zfsmJobRetentionDays(),'batch_limit'=>5000,'duplicate_batch_limit'=>5000];
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
// One decision, used by the hourly retention and by "Delete finished jobs".
// A record stays only when it is still needed: queued or running work; a snapshot hold or a ZIP
// that is still on disk; the journal of a conversion or file restore that may own saved data or
// a way to recover it; a journal that cannot be read safely; and a journal another record or
// the protection store points at. Everything else is deleted, whatever its outcome: failed,
// cancelled and interrupted policy, replication and request jobs and all deletion journals own
// no data. The newest result of each policy and replication is copied to a small file first
// (ZFSMLastResults.php), so the Policies and Replication screens and the pool warnings keep
// it. Datasets, snapshots and files are never touched.
function zfsmJobKeepOnDelete($job) {
    if(zfsmJobProblem($job))return 'needs inspection';
    $state=$job['state']??'';$schema=$job['schema']??null;
    if(in_array($state,['queued','running'],true))return 'running';
    if(!empty($job['hold_owned'])||(function_exists('zfsmArchiveNeedsCleanup')&&zfsmArchiveNeedsCleanup($job)))return 'still holds a snapshot or ZIP';
    // A ZIP that is still on disk belongs to its job until it is removed.
    if($schema===2&&($job['type']??'')==='archive')return empty($job['archive_removed'])?'still holds a snapshot or ZIP':null;
    if($schema===6){
        // A deletion that was interrupted or kept a private recovery container is the only record of it.
        if(function_exists('zfsmCleanupTerminalJob')&&zfsmCleanupTerminalJob($job))return null;
        return $state==='recovery_required'||!empty($job['recovery'])?'may own recovery data':null;
    }
    if($schema===4)return null;
    if($schema===7)return function_exists('zfsmRequestJobActive')&&zfsmRequestJobActive($job)?'running':null;
    if($state==='recovery_required')return 'needs recovery';
    if(function_exists('zfsmCleanupTerminalJob')&&zfsmCleanupTerminalJob($job))return null;
    return 'may own recovery data';
}
function zfsmJobHistoryDescribe($job,$stat,$hash) {
    $refs=[];zfsmJobHistoryReferences($job,$refs,$job['id']);
    $definition=($job['schema']??null)===4?(string)($job['type']??'').':'.(string)($job['definition_id']??''):null;
    $refusal=zfsmProtectionBlockedBeforeStart($job);
    return ['dev'=>$stat['dev'],'ino'=>$stat['ino'],'size'=>$stat['size'],'hash'=>$hash,'reason'=>zfsmJobKeepOnDelete($job),'time'=>zfsmJobHistoryTime($job)??PHP_INT_MAX,'created'=>(string)($job['created']??''),'refs'=>array_keys($refs),'definition'=>$definition,'verified'=>zfsmLastResultVerified($job),'refusal'=>$refusal?($job['type'].':'.$job['definition_id'].':'.hash('sha256',(string)($job['error']??''))):null];
}
// Compact description of every journal (never the journals themselves, so thousands of records
// fit in memory). $strict is retention: an unknown or unsafe entry is skipped, counted and never touched.
function zfsmJobHistoryScan($directory,$strict) {
    $records=[];$unreadable=[];$skipped=0;$unsafe=0;$bytes=0;$seen=0;$scan=opendir($directory);if($scan===false)throw new RuntimeException('Job storage is unavailable');
    try{while(($name=readdir($scan))!==false){
        if(++$seen>400000)throw new RuntimeException('History scan limit reached; no records removed.');
        if(!preg_match('/^([0-9]{8}-[0-9]{6}-[a-f0-9]{12})\.json$/D',$name,$match)){if($strict&&str_ends_with($name,'.json'))$unsafe++;continue;}
        $id=$match[1];$file=$directory.'/'.$name;
        try{
            $stat=zfsmJobHistoryRegular($file);
            if($stat['size']>131072){$unreadable[$id]=true;continue;}
            // Budget: what is not scanned in this pass stays untouched and is picked up by the next one.
            if(count($records)>=20000||$bytes+$stat['size']>64*1024*1024){$skipped++;continue;}
            $bytes+=$stat['size'];
            $job=zfsmReadJob($id);if(zfsmJobProblem($job)){$unreadable[$id]=true;continue;}
            $records[$id]=zfsmJobHistoryDescribe($job,$stat,hash_file('sha256',$file));
        }catch(Throwable$error){if($strict)$unsafe++;else $unreadable[$id]=true;}
    }}finally{closedir($scan);}
    return [$records,$unreadable,$skipped,$unsafe];
}
// id => keep reason, or null when the record is deleted. $cutoff: records newer than this
// time stay ("recent"); null deletes regardless of age. $only: ids the request selected.
// $fold: of each run of identical refusals only the newest stays, whatever its age.
function zfsmJobHistoryPlan($records,$storePins,$cutoff,$only=null,$fold=false) {
    $reason=[];$duplicate=[];
    foreach($records as$id=>$r){
        $why=$r['reason'];
        if($why===null&&$only!==null&&!isset($only[$id]))$why='not selected';
        elseif($why===null&&$cutoff!==null&&$r['time']>$cutoff)$why='recent';
        $reason[$id]=$why;
    }
    uksort($records,fn($a,$b)=>($records[$b]['time']<=>$records[$a]['time'])?:strcmp($b,$a));
    if($fold){$first=[];foreach($records as$id=>$r){if($r['refusal']===null||$records[$id]['reason']!==null)continue;if(!isset($first[$r['refusal']])){$first[$r['refusal']]=true;continue;}if($only===null||isset($only[$id])){$reason[$id]=null;$duplicate[$id]=true;}}}
    foreach($storePins as$id=>$_)if(array_key_exists($id,$reason)&&$reason[$id]===null)$reason[$id]='referenced by protection';
    // A record that stays keeps every record it points at, and so on down the chain.
    $queue=array_keys(array_filter($reason,fn($why)=>$why!==null));
    while($queue){$id=array_pop($queue);foreach($records[$id]['refs']as$ref)if(array_key_exists($ref,$reason)&&$reason[$ref]===null){$reason[$ref]='referenced by another job';$queue[]=$ref;}}
    // The newest record of each definition among those about to go is saved first.
    // Readers compare the creation time, so "newest" here means the newest created.
    $byCreated=array_keys($records);usort($byCreated,fn($a,$b)=>strcmp($records[$b]['created'],$records[$a]['created'])?:strcmp($b,$a));
    $latest=[];$remember=[];foreach($byCreated as$id){$r=$records[$id];if($reason[$id]!==null||$r['definition']===null)continue;
        if(!isset($latest[$r['definition']])){$latest[$r['definition']]=true;$remember[$id]=true;}
        if($r['verified']&&!isset($latest[$r['definition'].':verified'])){$latest[$r['definition'].':verified']=true;$remember[$id]=true;}}
    return ['reason'=>$reason,'duplicate'=>$duplicate,'latest'=>$remember];
}
// Removes one journal with its lock, runtime copy and marker. Returns the bytes freed, or null
// when somebody else holds the journal. Throws when the files changed since the scan.
function zfsmJobHistoryRemove($id,$record,$directory,$runtime) {
    $file=zfsmJobFile($id);$stat=zfsmJobHistoryRegular($file);
    if($stat['dev']!==$record['dev']||$stat['ino']!==$record['ino']||hash_file('sha256',$file)!==$record['hash'])throw new RuntimeException('Job identity changed; remaining history retained.');
    $aux=[$file.'.lock',$runtime.'/'.$id.'.json',$runtime.'/requests/'.$id.'.lock',$directory.'/visibility/jobs/'.$id.'.marker'];
    $proofs=[];$existing=[];$locks=[];
    try{
        foreach(array_merge([$file],$aux)as$path){$proof=zfsmJobHistoryPathProof(dirname($path));if($proof===null)continue;if(!file_exists($path)&&!is_link($path))continue;$meta=zfsmJobHistoryRegular($path);$proofs[$path]=[$proof,$meta];$existing[]=$path;
            if(str_ends_with($path,'.lock')){$h=fopen($path,'ce');if(!$h)return null;$locks[]=$h;$opened=fstat($h);if(!flock($h,LOCK_EX|LOCK_NB)||$opened['dev']!==$meta['dev']||$opened['ino']!==$meta['ino'])return null;}
        }
        foreach($proofs as$path=>[$proof,$meta]){$current=zfsmJobHistoryRegular($path);if(zfsmJobHistoryPathProof(dirname($path))!==$proof||$current['dev']!==$meta['dev']||$current['ino']!==$meta['ino'])throw new RuntimeException('History metadata identity changed; retained.');}
        // The exclusive history gate excludes every per-ID updater and its waiters; the lock
        // probes above also preserve foreign live locks.
        if(!unlink($file))throw new RuntimeException('Unable to remove a job record.');
        foreach($existing as$path)if($path!==$file&&!unlink($path))throw new RuntimeException('Unable to remove job metadata.');
        return $stat['size'];
    }finally{foreach($locks as$h)if(is_resource($h)){flock($h,LOCK_UN);fclose($h);}}
}
// Walks the plan: saves the newest results, then deletes. Returns [removed, bytes, kept reasons, duplicates removed].
function zfsmJobHistoryApply($records,$plan,$directory,$limit,$strict,&$progress=null) {
    $runtime=zfsmJobDirectory($GLOBALS['plugin_runtime']??'/var/tmp/zfs.master.ui/jobs');
    $removed=0;$bytes=0;$kept=[];$duplicates=0;$progress=['removed'=>0,'bytes'=>0,'duplicates'=>0];
    $keep=function($why)use(&$kept){$kept[$why]=($kept[$why]??0)+1;};
    $ids=array_keys($plan['reason']);usort($ids,fn($a,$b)=>($records[$a]['time']<=>$records[$b]['time'])?:strcmp($a,$b));
    try{foreach($ids as$id){
        $why=$plan['reason'][$id];
        if($why!==null){if(!in_array($why,['recent','not selected'],true))$keep($why);continue;}
        if($limit!==null&&$removed>=$limit)continue;
        if(isset($plan['latest'][$id])){try{zfsmLastResultRemember(zfsmReadJob($id));}catch(Throwable$error){$keep('newest result could not be saved');continue;}}
        try{$freed=zfsmJobHistoryRemove($id,$records[$id],$directory,$runtime);}catch(Throwable$error){if($strict)throw $error;$keep('changed during deletion');continue;}
        if($freed===null){$keep('running');continue;}
        $removed++;$bytes+=$freed;if(isset($plan['duplicate'][$id]))$duplicates++;$progress=['removed'=>$removed,'bytes'=>$bytes,'duplicates'=>$duplicates];
    }}finally{if($removed)zfsmAuditSyncDirectory($directory);}
    return [$removed,$bytes,$kept,$duplicates];
}
function zfsmJobDeleteFinished($only=null) {
    $gate=zfsmJobHistoryGate(true,true);if($gate===null)throw new RuntimeException('Jobs are being updated; try again in a moment.');
    $directory=zfsmJobDirectory($GLOBALS['plugin_state']);
    try{
        [$records,$unreadable,$skipped]=zfsmJobHistoryScan($directory,false);
        // An unreadable protection store means references cannot be checked: nothing is deleted.
        $pins=[];try{$store=zfsmProtectionReadStore();}catch(Throwable$error){throw new RuntimeException('Protection settings could not be read; no job was deleted.');}zfsmJobHistoryReferences($store,$pins);
        $plan=zfsmJobHistoryPlan($records,$pins,null,$only);
        [$removed,$bytes,$kept]=zfsmJobHistoryApply($records,$plan,$directory,null,false);
        // "Everything" also removes a journal that cannot be validated, but only a plain single-link
        // file whose lock nobody holds; with filters such a journal is never selected and stays.
        $runtime=zfsmJobDirectory($GLOBALS['plugin_runtime']??'/var/tmp/zfs.master.ui/jobs');$freedAny=false;
        foreach($unreadable as$id=>$_){
            $freed=null;
            if($only===null){try{$file=zfsmJobFile($id);$stat=zfsmJobHistoryRegular($file);$freed=zfsmJobHistoryRemove($id,['dev'=>$stat['dev'],'ino'=>$stat['ino'],'hash'=>hash_file('sha256',$file)],$directory,$runtime);}catch(Throwable$error){$freed=null;}}
            if($freed!==null){$removed++;$freedAny=true;continue;}
            if($only===null||isset($only[$id]))$kept['needs inspection']=($kept['needs inspection']??0)+1;
        }
        if($freedAny)zfsmAuditSyncDirectory($directory);
        if($skipped)$kept['not scanned yet, press again']=$skipped;
        zfsmLastResultsPrune($store);
    }finally{flock($gate,LOCK_UN);fclose($gate);}
    ksort($kept);$left=array_sum($kept);
    $message='Deleted '.$removed.' finished job record(s).'.($left?' Kept '.$left.': '.implode(', ',array_map(fn($reason,$count)=>$count.' '.$reason,array_keys($kept),$kept)).'.':'');
    return ['succeeded'=>['jobs'=>$message],'failed'=>[],'deleted'=>$removed,'kept'=>$kept];
}
function zfsmJobHistoryCleanup($now=null) {
    $now=$now??time();$policy=zfsmJobHistoryPolicy();if($policy['days']===null)return ['skipped'=>'settings_unreadable'];$last=zfsmJobHistoryStatus()['last_cleanup'];
    if($last!==null&&$now-$last['checked_at']<$policy['interval_seconds'])return ['skipped'=>'not_due'];
    $gate=null;$config=null;$progress=null;$report=['checked_at'=>$now,'removed'=>0,'reclaimed_bytes'=>0,'protected'=>0,'days'=>$policy['days'],'skipped_unsafe'=>0,'blocked'=>false];
    try {
        $gate=zfsmJobHistoryGate(true,true);if($gate===null)return ['skipped'=>'journal_busy'];
        zfsmJobHistoryPathProof(dirname($GLOBALS['plugin_config']));zfsmJobHistoryPathProof(dirname($GLOBALS['plugin_config']).'/protection');$configPath=zfsmProtectionDirectory().'/config.lock';if(is_link($configPath))throw new RuntimeException('Protection state requires inspection.');$config=fopen($configPath,'ce');$configStat=$config?fstat($config):false;$configNamed=zfsmJobHistoryRegular($configPath);if(!$configStat||$configStat['dev']!==$configNamed['dev']||$configStat['ino']!==$configNamed['ino'])throw new RuntimeException('Protection lock identity changed.');if(!flock($config,LOCK_SH|LOCK_NB))return ['skipped'=>'configuration_busy'];
        $storeFile=zfsmProtectionDirectory().'/config.json';if(file_exists($storeFile)||is_link($storeFile))zfsmJobHistoryRegular($storeFile);$store=zfsmProtectionReadStore();$pins=[];zfsmJobHistoryReferences($store,$pins);
        $directory=zfsmJobDirectory($GLOBALS['plugin_state']);
        [$records,$unreadable,$skipped,$unsafe]=zfsmJobHistoryScan($directory,true);
        // "Always" keeps every record, but still folds the repeated refusals older versions wrote.
        $cutoff=$policy['days']===0?PHP_INT_MIN:$now-$policy['days']*86400;
        $plan=zfsmJobHistoryPlan($records,$pins,$cutoff,null,true);
        [$removed,$bytes,$kept,$duplicates]=zfsmJobHistoryApply($records,$plan,$directory,$policy['batch_limit']+$policy['duplicate_batch_limit'],true,$progress);
        $report['removed']=$removed;$report['reclaimed_bytes']=$bytes;$report['protected']=array_sum($kept)+count($unreadable)+$skipped+$unsafe;$report['skipped_unsafe']=$unsafe+count($unreadable);$report['entries']=count($records)-$removed;
        if($duplicates)$report['duplicates_removed']=$duplicates;
        zfsmLastResultsPrune($store);
    } catch(Throwable$error){$report['blocked']=true;$report['warning']=$error->getMessage();if(!empty($progress)){$report['removed']=$progress['removed'];$report['reclaimed_bytes']=$progress['bytes'];}}
    finally {foreach([$config,$gate]as$handle)if(is_resource($handle)){flock($handle,LOCK_UN);fclose($handle);}}
    zfsmJobAtomicWrite(zfsmJobDirectory($GLOBALS['plugin_runtime']).'/history-cleanup.json',$report);
    return $report;
}
