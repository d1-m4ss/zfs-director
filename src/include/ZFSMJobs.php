<?php
require_once __DIR__.'/ZFSMActivityVisibility.php';
require_once __DIR__.'/ZFSMJobHistory.php';

function zfsmJobDirectory($directory) {
    $exists=is_dir($directory);
    if ((!$exists && !@mkdir($directory,0700,true)) || is_link($directory)) throw new RuntimeException('Job storage is unavailable');
    if (!$exists) zfsmAuditSyncDirectory(dirname($directory));
    return $directory;
}
function zfsmJobId($id) {
    if (!is_string($id) || !preg_match('/^[0-9]{8}-[0-9]{6}-[a-f0-9]{12}$/D',$id)) throw new InvalidArgumentException('Invalid job ID');
    return $id;
}
function zfsmJobFile($id) { return zfsmJobDirectory($GLOBALS['plugin_state']).'/'.zfsmJobId($id).'.json'; }
function zfsmJobAtomicWrite($file,$data) {
    $history_gate=isset($GLOBALS['plugin_state'],$data['id'])&&$file===rtrim($GLOBALS['plugin_state'],'/').'/'.$data['id'].'.json'?zfsmJobHistoryGate():null;
    try {
    zfsmJobDirectory(dirname($file));
    if (is_link($file)) throw new RuntimeException('Job storage cannot be a symlink');
    $temp=$file.'.'.bin2hex(random_bytes(6)).'.tmp'; $handle=@fopen($temp,'xb');
    if (!$handle) throw new RuntimeException('Unable to open job journal');
    @chmod($temp,0600);
    try {
        $bytes=json_encode($data,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)."\n";
        if (fwrite($handle,$bytes)!==strlen($bytes) || !fflush($handle) || (function_exists('fsync')&&!fsync($handle))) throw new RuntimeException('Unable to flush job journal');
        fclose($handle); $handle=null;
        if (!@rename($temp,$file)) throw new RuntimeException('Unable to commit job journal');
        if(!empty($GLOBALS['zfsm_job_request_command'])&&in_array($data['schema']??null,[1,2,4,6],true)&&isset($data['id'])&&basename($file)===$data['id'].'.json')$GLOBALS['zfsm_request_published_job']=$data['id'];
        zfsmAuditSyncDirectory(dirname($file));
    } finally { if (is_resource($handle)) fclose($handle); if (is_file($temp)) @unlink($temp); }
    } finally { if(is_resource($history_gate)){flock($history_gate,LOCK_UN);fclose($history_gate);} }
}
function zfsmReadJob($id) {
    $file=zfsmJobFile($id);
    if (is_link($file) || !is_file($file)) throw new InvalidArgumentException('Job not found');
    $bytes=file_get_contents($file);
    if (!is_string($bytes)||strlen($bytes)>131072) throw new RuntimeException('Invalid job journal');
    $job=json_decode($bytes,true,32,JSON_THROW_ON_ERROR);
    if (!is_array($job)||($job['id']??null)!==$id) throw new RuntimeException('Job journal identity mismatch');
    return $job;
}
function zfsmJobStageHistory($job) {
    $events=[];
    foreach (is_array($job['stage_history']??null)?$job['stage_history']:[] as $event) {
        if (!is_array($event)||!is_string($event['at']??null)||strlen($event['at'])>40||strtotime($event['at'])===false||!in_array($event['state']??null,['queued','running','completed','failed','cancelled','recovery_required'],true)||!is_string($event['stage']??null)||!preg_match('/^[a-z][a-z0-9_]{0,63}$/D',$event['stage'])) continue;
        $events[]=['at'=>$event['at'],'state'=>$event['state'],'stage'=>$event['stage'],'attempt'=>is_int($event['attempt']??null)&&$event['attempt']>=0?$event['attempt']:null];
    }
    return array_slice($events,-128);
}
function zfsmJobInitializeHistory($job) {
    $job['stage_history']=[['at'=>$job['created'],'state'=>$job['state'],'stage'=>$job['stage'],'attempt'=>0]];
    $job['stage_history_complete']=true;$job['stage_history_dropped']=0;
    return $job;
}
function zfsmJobUpdate($id,$changes) {
    $history_gate=zfsmJobHistoryGate();
    try {
    $file=zfsmJobFile($id);if(!is_file($file)||is_link($file))throw new InvalidArgumentException('Job not found');$lock_file=$file.'.lock';
    if (is_link($lock_file)) throw new RuntimeException('Invalid job lock');
    $lock=@fopen($lock_file,'c');
    if (!$lock || !flock($lock,LOCK_EX)) throw new RuntimeException('Unable to lock job journal');
    try {
        $job=zfsmReadJob($id);$previous=$job;
        if (is_callable($changes)) $changes=$changes($job);
        if ($changes===[]) return $job;
        foreach ($changes as $key=>$value) if (!in_array($key,['stage_history','stage_history_complete','stage_history_dropped'],true)) $job[$key]=$value;
        $job['updated']=gmdate('c');
        $new_attempt=($job['state']??null)==='running'&&(($previous['state']??null)!=='running'||(!empty($job['started_at'])&&($job['started_at']!==($previous['started_at']??null))));
        if ($new_attempt||($job['state']??null)!==($previous['state']??null)||($job['stage']??null)!==($previous['stage']??null)) {
            $history=zfsmJobStageHistory($previous);$attempt=$history?($history[count($history)-1]['attempt']):null;
            if ($new_attempt) $attempt=($attempt??0)+1;
            // Only transition metadata enters history; errors and operation fields
            // can contain credentials and belong to the existing redacted record.
            $event=zfsmJobStageHistory(['stage_history'=>[['at'=>$job['updated'],'state'=>$job['state']??null,'stage'=>$job['stage']??null,'attempt'=>$attempt]]]);
            if ($event) $history[]=$event[0];
            $job['stage_history_dropped']=max(0,is_int($previous['stage_history_dropped']??null)?$previous['stage_history_dropped']:0)+max(0,count($history)-128);
            $job['stage_history']=array_slice($history,-128);
            $job['stage_history_complete']=($previous['stage_history_complete']??false)===true;
        }
        zfsmJobAtomicWrite($file,$job);
        return $job;
    } finally { flock($lock,LOCK_UN); fclose($lock); }
    } finally { flock($history_gate,LOCK_UN); fclose($history_gate); }
}
function zfsmBootId() {
    $id=$GLOBALS['zfsm_boot_id']??@file_get_contents('/proc/sys/kernel/random/boot_id');
    if (!is_string($id)||trim($id)==='') throw new RuntimeException('Unable to verify current boot identity');
    return trim($id);
}
function zfsmJobBootApproved($job) { return ($job['ack_boot']??'')===zfsmBootId(); }
function zfsmDirectoryIdentity($path) {
    clearstatcache(true,$path); $stat=@lstat($path);
    if (!$stat || ($stat['mode']&0170000)!==0040000 || is_link($path)) throw new RuntimeException('Original directory identity is unavailable');
    return ['dev'=>(string)$stat['dev'],'ino'=>(string)$stat['ino']];
}
function zfsmRequireSourceIdentity($job,$path) {
    $actual=zfsmDirectoryIdentity($path); $expected=$job['source_identity']??[];
    // Linux assigns ZFS st_dev on each mount, including same-boot remounts.
    // The runner pins owner GUID and live mount; inode identifies its object.
    if (($expected['ino']??null)!==$actual['ino']) throw new RuntimeException('Original directory was replaced; manual recovery required');
}
function zfsmPendingJobs() {
    $jobs=[];
    foreach (glob(zfsmJobDirectory($GLOBALS['plugin_state']).'/*.json')?:[] as $file) {
        try { $job=zfsmReadJob(basename($file,'.json')); if (zfsmJobProblem($job)) continue; if (in_array($job['state']??'',['queued','running'],true) || ((in_array($job['type']??'',['restore','archive'],true)&&!empty($job['hold_owned']) || (function_exists('zfsmArchiveNeedsCleanup')&&zfsmArchiveNeedsCleanup($job)))&&($job['cleanup_retry_after']??0)<=time())) $jobs[]=$job; }
        catch (Throwable $error) { /* Invalid journals remain visible for manual recovery. */ }
    }
    usort($jobs,function($a,$b){return strcmp($a['id'],$b['id']);});
    return $jobs;
}
// Unresolved conversions may hold the only copy in an unpublished target or in
// the retained original. Neither may be removed while the other is not proven.
function zfsmUnresolvedConversions() {
    $jobs=[];
    foreach (glob(zfsmJobDirectory($GLOBALS['plugin_state']).'/*.json')?:[] as $file) {
        try { $job=zfsmReadJob(basename($file,'.json')); } catch (Throwable $error) { continue; }
        if (($job['schema']??null)!==1||($job['state']??'')==='completed'||($job['stage']??'')==='planned'||!is_string($job['dataset']??null)||!is_string($job['source']??null)) continue;
        $r=runProcess('zfs',['get','-H','-o','property,value','mountpoint,canmount,zfs.master.ui:conversion-job',$job['dataset']]);
        if (($r['code']??1)!==0) continue;
        $state=[];foreach (explode("\n",trim($r['output']??'')) as $line) {$parts=explode("\t",$line);if (count($parts)===2) $state[$parts[0]]=$parts[1];}
        if (($state['zfs.master.ui:conversion-job']??null)!==$job['id']) continue;
        $job['target_published']=($state['mountpoint']??null)===$job['source']&&($state['canmount']??null)==='on';
        $originals=array_filter([$job['source'],$job['recovery']??null],'is_string');
        $job['original_present']=false;foreach ($originals as $path) {clearstatcache(true,$path);if (is_dir($path)&&!is_link($path)&&!($job['target_published']&&$path===$job['source'])) $job['original_present']=true;}
        $jobs[]=$job;
    }
    return $jobs;
}
function zfsmPathOverlaps($a,$b) { return $a===$b||str_starts_with($a,rtrim($b,'/').'/')||str_starts_with($b,rtrim($a,'/').'/'); }
function zfsmConversionMutationGuard($command,$fields) {
    if (!in_array($command,['deletedirectory','movedirectory','convertdirectory','destroydataset'],true)) return;
    $jobs=zfsmUnresolvedConversions();if (!$jobs) return;
    if ($command==='destroydataset') {
        $name=$fields['zdataset']??'';
        foreach ($jobs as $job) if (($name===$job['dataset']||str_starts_with($job['dataset'],$name.'/'))&&!$job['original_present']) throw new RuntimeException('Unresolved conversion job '.$job['id'].' keeps the only copy in '.$job['dataset'].'; publish or inspect it before deleting this dataset.');
        return;
    }
    $path=$fields['directory']??null;if (!is_string($path)) return;
    $resolved=zfsmResolveDirectory($path,true);if ($resolved) $path=$resolved['path'];
    foreach ($jobs as $job) {
        if ($job['target_published']) continue;
        foreach (array_filter([$job['source'],$job['recovery']??null],'is_string') as $original) if (zfsmPathOverlaps($path,$original)) throw new RuntimeException('Unresolved conversion job '.$job['id'].' has not published '.$job['dataset'].'; this directory is its retained original. Publish or inspect the conversion first.');
    }
}
// A rejected request is evidence only, never a resumable worker journal.
function zfsmRecordRejectedConversion($source,$failed,$audit_id) {
    if(!is_string($source)||strlen($source)>4096||!str_starts_with($source,'/mnt/')||preg_match('/[\x00-\x1f\x7f]/',$source)||!preg_match('/^[a-f0-9]{32}$/D',$audit_id))return null;
    $text=implode("\n",array_filter($failed,'is_string'));
    $code='preflight_failed';$message='Conversion was not queued. Review the request and Administrative History before trying again.';
    foreach([
        'readonly_parent'=>['/read.?only|readonly/i','Conversion requires a writable parent filesystem. Its effective readonly property is on or could not be verified. Review the parent readonly property before trying again.'],
        'dependencies'=>['/configured service references or additional mounts/','Operation blocked by configured service references or additional mounts. Review Usage & Dependencies and release references through their owner; no services were stopped.'],
        'writers_unconfirmed'=>['/Stop all writers and explicitly confirm/','Stop all writers and explicitly confirm before converting this directory.'],
        'lock_busy'=>['/operation lock|Another operation is running|Unable to lock queue/i','Another operation holds the operation lock. Wait for it to finish, then review and submit again.'],
        'destructive_mode'=>['/Destructive Mode is disabled/','Destructive Mode is disabled in ZFS Director settings.'],
        'identity_changed'=>['/identity|GUID|replaced|changed since/i','The directory or its dataset identity could not be confirmed. Refresh the inventory before submitting again.'],
        'target_invalid'=>['/direct child|already exists|invalid/i','The conversion target is invalid, already exists or is not a direct child of a mounted dataset.'],
    ]as$key=>[$pattern,$safe])if(preg_match($pattern,$text)){$code=$key;$message=$safe;break;}
    $id=gmdate('Ymd-His').'-'.bin2hex(random_bytes(6));$now=gmdate('c');
    $job=zfsmJobInitializeHistory(['schema'=>5,'type'=>'conversion','id'=>$id,'state'=>'failed','stage'=>'preflight_rejected','source'=>$source,'created'=>$now,'updated'=>$now,'started_at'=>null,'finished_at'=>$now,'error_code'=>$code,'error'=>$message,'audit_id'=>$audit_id]);
    zfsmJobAtomicWrite(zfsmJobFile($id),$job);return $job;
}
function zfsmJobProblem($job) {
    if (!in_array($job['schema']??null,[1,2,4,5,6,7],true)) return ['unsupported_schema','Unsupported journal schema; automatic actions are disabled. Inspect the journal and retained data manually.'];
    if (!in_array($job['state']??null,['queued','running','completed','failed','cancelled','recovery_required'],true)) return ['invalid_journal','Unknown job state; manual inspection is required.'];
    if($job['schema']===5){
        $allowed=['schema','type','id','state','stage','source','created','updated','started_at','finished_at','error_code','error','audit_id','stage_history','stage_history_complete','stage_history_dropped'];
        return ($job['type']??null)==='conversion'&&$job['state']==='failed'&&($job['stage']??null)==='preflight_rejected'&&is_string($job['source']??null)&&str_starts_with($job['source'],'/mnt/')&&is_string($job['error']??null)&&!array_diff(array_keys($job),$allowed)?null:['invalid_journal','Invalid rejected request record; execution is disabled.'];
    }
    if ($job['schema']===4) return zfsmProtectionJobProblem($job);
    if ($job['schema']===7) {try{zfsmValidateRequestJob($job);return null;}catch(Throwable$error){return ['invalid_journal',$error->getMessage()];}}
    if ($job['schema']===6) {try{zfsmValidateDeletionJob($job);return null;}catch(Throwable$error){return ['invalid_journal',$error->getMessage()];}}
    if (($job['schema']===1 && !in_array($job['type']??'conversion',['conversion'],true)) || ($job['schema']===2 && !in_array($job['type']??'',['restore','archive'],true))) return ['invalid_journal','Journal type does not match its schema; manual inspection is required.'];
    if ($job['schema']===1) {
        if (!is_string($job['owner_guid']??null) || !preg_match('/^[0-9]+$/D',$job['owner_guid']) || !is_string($job['source_identity']['ino']??null) || !preg_match('/^[0-9]+$/D',$job['source_identity']['ino'])) return ['invalid_journal','Conversion ownership evidence is missing; manual inspection is required.'];
        try { zfsmValidateJobShape($job); }
        catch (Throwable $error) { return ['invalid_journal',$error->getMessage()]; }
    }
    if ($job['schema']===2) {
        try { zfsmValidateFileJobShape($job); }
        catch (Throwable $error) { return ['invalid_journal',$error->getMessage()]; }
    }
    return null;
}
function zfsmRedactJobData($value) {
    if (!is_array($value)) return $value;
    foreach ($value as $key=>$item) {
        $name=preg_replace('/[^a-z0-9]/i','',(string)$key);
        $sensitive=preg_match('/password|passphrase|secret|token|credential|authorization|cookie|keymaterial|(?:api|private|encryption|access|signing|client)key|^key$/i',$name);
        $value[$key]=$sensitive?'[redacted]':zfsmRedactJobData($item);
    }
    return $value;
}
function zfsmJobPresentation($job,$file,$worker_running,$problem=null) {
    $job['stage_history']=$problem?[]:zfsmJobStageHistory($job);
    $job['stage_history_complete']=!$problem&&($job['stage_history_complete']??false)===true;
    $job['stage_history_dropped']=!$problem&&is_int($job['stage_history_dropped']??null)?max(0,$job['stage_history_dropped']):0;
    $job['type']=$job['type']??(($job['schema']??null)===1?'conversion':'unknown');
    $job['diagnostics']=['journal'=>basename($file),'issue'=>$problem[0]??null,'detail'=>$problem[1]??''];
    if ($problem) {
        // Corrupt or future journals may contain credentials. Identify the file
        // for local inspection without returning any of its raw contents.
        $inspectable=!is_link($file)&&is_file($file);
        $job['diagnostics']['bytes']=$inspectable?(@filesize($file)?:0):null;
        $job['diagnostics']['sha256']=$inspectable?(@hash_file('sha256',$file)?:null):null;
        $job['original_state']=$job['state']??null;
        $job['state']='recovery_required'; $job['stage']=$problem[0]; $job['error']=$problem[1];
    }
    $active=in_array($job['state']??'',['queued','running'],true);
    $cleanup=!empty($job['hold_owned']) || (function_exists('zfsmArchiveNeedsCleanup')&&zfsmArchiveNeedsCleanup($job));
    $job['group']=$active?'active':(($job['state']??'')==='completed'&&!$cleanup?'completed':'needs_attention');
    $archive=($job['type']==='archive');
    $job['archive_status']=$archive?(!empty($job['archive_removed'])?'removed':(($job['state']??'')==='completed'?(($job['expires']??0)>time()?'ready':'expired'):'unavailable')):null;
    $job['actions']=['cancel'=>!$problem&&$active,'resume'=>!$problem&&$job['type']==='conversion'&&in_array($job['state'],['queued','running','failed','cancelled','recovery_required'],true)&&!$worker_running,'download'=>!$problem&&$archive&&$job['archive_status']==='ready','inspect'=>true];
    if ($job['type']==='conversion'&&!zfsmConfinedCanResume($job)) $job['actions']['resume']=false;
    if ($job['type']==='conversion') {clearstatcache(true,(string)($job['source']??''));$job['actions']['publish']=!$problem&&($job['method']??null)==='confined-v1'&&$job['state']==='recovery_required'&&preg_match('/^[a-f0-9]{64}$/D',$job['copy_manifest_sha256']??'')===1&&is_string($job['source']??null)&&!file_exists($job['source'])&&!is_link($job['source']);}
    $job['retained_data']=['source'=>$job['source']??null,'dataset'=>$job['dataset']??null,'recovery'=>$job['recovery']??null,'staging'=>$job['staging']??null,'hold_owned'=>!empty($job['hold_owned']),'message'=>$problem?'Retained data cannot be verified from this journal. Inspect the recorded paths and filesystem before manual recovery.':($job['type']==='conversion'?'The original source and any partial target are retained. Paths are journal records; verify actual data before manual recovery.':($archive?'ZIP staging and any snapshot protection remain owned by this job until automatic cleanup succeeds.':'Copied files and replaced originals are retained for inspection. Create a fresh restore preview after verifying actual files.'))];
    if(!$problem&&$archive&&!empty($job['archive_removed']))$job['retained_data']['message']=($job['cleanup_resolution']??null)==='owner_absent'?'The original dataset and snapshot GUIDs are absent from the imported pool, and the recorded ZIP path is absent. No files were deleted; stale ZIP cleanup bookkeeping was reconciled.':'The temporary ZIP archive has been removed. The original operation result and history are preserved.';
    if(!$problem&&!empty($job['cleanup_error'])){$cleanup_message='Cleanup pending: '.zfsmExplorerShortText($job['cleanup_error'],1500);$job['retained_data']['message'].=' '.$cleanup_message;$job['error']=(!empty($job['error'])?$job['error'].' ':'').$cleanup_message;}
    if(!$problem&&($job['schema']??null)===4)$job['retained_data']=['source'=>$job['source'],'target'=>$job['target'],'message'=>'Protection jobs do not remove destination data. Inspect verified outcome and any partial receive before retrying.'];
    if(!$problem&&($job['schema']??null)===5){$job['actions']=['cancel'=>false,'resume'=>false,'download'=>false,'inspect'=>true];$job['retained_data']=['source'=>$job['source'],'message'=>'Conversion was rejected before it started. No data was copied or moved; no recovery directory was created by this attempt. Review the cause, then submit a new request.'];}
    if(!$problem&&($job['schema']??null)===6){$job['actions']=['cancel'=>false,'resume'=>false,'download'=>false,'inspect'=>true];$job['retained_data']=['source'=>$job['source'],'recovery'=>$job['recovery']??null,'message'=>!empty($job['rejected'])?'Deletion was rejected before it started. No deletion was attempted.':'Deletion cannot be undone or resumed automatically. After a failure, inspect remaining objects and recovery data, refresh the inventory and submit a fresh reviewed request.'];}
    if(!$problem&&($job['schema']??null)===7){$job['actions']=['cancel'=>false,'resume'=>false,'download'=>false,'inspect'=>true];$job['execution_active']=in_array($job['state'],['queued','running'],true)&&zfsmRequestJobActive($job);$job['retained_data']=['source'=>$job['source'],'message'=>'Recorded operation; it is never replayed by the worker. Inspect actual state before any new request.'];}
    return zfsmRedactJobData($job);
}
function zfsmJobPage($page=1,$page_size=25,$options=null) {
    if ($options!==null) {
        if(!is_array($options))throw new InvalidArgumentException('Invalid jobs options');
        foreach(['filter'=>['all','active','needs_attention','completed','recovery','snapshot','restore','archive','conversion','deletion','policy','replication','operation','download','maintenance'],'sort'=>['newest','oldest','attention'],'view'=>['working','archived','all']]as$key=>$allowed)if(isset($options[$key])&&(!is_string($options[$key])||!in_array($options[$key],$allowed,true)))throw new InvalidArgumentException('Invalid jobs '.$key);
    }
    $directory=zfsmJobDirectory($GLOBALS['plugin_state']); $files=@scandir($directory);
    if ($files===false) throw new RuntimeException('Job storage is unavailable');
    $files=array_values(array_filter($files,function($file){return str_ends_with($file,'.json');})); rsort($files,SORT_STRING);
    $groups=['active'=>[],'needs_attention'=>[],'completed'=>[]]; $worker_running=zfsmWorkerRunning();
    foreach ($files as $name) {
        $file=$directory.'/'.$name;
        try {
            $job=zfsmReadJob(basename($name,'.json')); $problem=zfsmJobProblem($job);
        } catch (Throwable $error) {
            $job=['id'=>basename($name,'.json'),'schema'=>null,'type'=>'unknown','state'=>'recovery_required'];
            $problem=['invalid_journal','Journal cannot be read safely: '.$error->getMessage().'. Inspect retained data manually.'];
        }
        $job=zfsmJobPresentation($job,$file,$worker_running,$problem);
        // Runtime progress is disposable. Its failure must not hide a valid journal.
        if (!$problem&&!(($job['schema']??null)===7&&!in_array($job['state'],['queued','running'],true))) try {
            $runtime=($GLOBALS['plugin_runtime']??'/var/tmp/zfs.master.ui/jobs').'/'.$job['id'].'.json';
            if (!is_link($runtime) && is_file($runtime)) {
                $progress=json_decode(@file_get_contents($runtime,false,null,0,131073),true);
                if (is_array($progress)) $job['progress']=zfsmRedactJobData($progress);
            }
        } catch (Throwable $error) { $job['diagnostics']['detail']='Live progress is unavailable; the durable job journal remains available.'; }
        $groups[$job['group']][]=$job;
    }
    if($options!==null){
        $all=array_merge(...array_values($groups));$filter=$options['filter']??'all';$sort=$options['sort']??'newest';$view=$options['view']??'working';
        foreach($all as&$item){$item['archived']=zfsmActivityJobArchived($item);$item['archive_eligible']=zfsmActivityJobEligible($item);}unset($item);
        $all=array_values(array_filter($all,function($job)use($filter,$view){return ($view==='all'||($view==='archived')===$job['archived'])&&($filter==='all'||$filter===$job['group']||($filter==='recovery'&&$job['state']==='recovery_required')||$filter===$job['type']||$filter===zfsmRequestJobCategory($job));}));
        $createdTime=static function($job){$created=$job['created']??null;if(is_int($created)||is_float($created))return is_finite($created)&&$created>0?$created:0;return is_string($created)&&strlen($created)<=64?(strtotime($created)?:0):0;};
        usort($all,function($a,$b)use($sort,$createdTime){if($sort==='attention'){$rank=['needs_attention'=>0,'active'=>1,'completed'=>2];$d=$rank[$a['group']]-$rank[$b['group']];if($d)return $d;}$aTime=$createdTime($a);$bTime=$createdTime($b);$d=($bTime<=>$aTime)?:strcmp($b['id'],$a['id']);return $sort==='oldest'?-$d:$d;});
        $counts=array_map('count',$groups);$total=count($all);$page_size=max(1,min(200,(int)$page_size));$pages=max(1,(int)ceil($total/$page_size));$page=max(1,min($pages,(int)$page));
        return ['jobs'=>array_slice($all,($page-1)*$page_size,$page_size),'counts'=>$counts,'pagination'=>['page'=>$page,'page_size'=>$page_size,'total'=>$total,'pages'=>$pages,'has_previous'=>$page>1,'has_next'=>$page<$pages]];
    }
    $counts=array_map('count',$groups); $page_size=max(1,min(200,(int)$page_size)); $pages=max(1,(int)ceil($counts['completed']/$page_size)); $page=max(1,min($pages,(int)$page));
    return ['jobs'=>array_merge($groups['active'],$groups['needs_attention'],array_slice($groups['completed'],($page-1)*$page_size,$page_size)),'counts'=>$counts,'pagination'=>['page'=>$page,'page_size'=>$page_size,'total'=>$counts['completed'],'pages'=>$pages,'has_previous'=>$page>1,'has_next'=>$page<$pages]];
}
function zfsmListJobs($limit=100) { return zfsmJobPage(1,$limit)['jobs']; }
function zfsmQueueConversion($directory,$pool,$offline_confirmed=false) {
    if ($offline_confirmed!==true && $offline_confirmed!=='1') return zfsmFailure($directory,'Stop all writers and explicitly confirm before conversion');
    if (!zfsmValidPoolName($pool)) return zfsmFailure($directory,'Invalid pool name');
    $source=zfsmResolveDirectory($directory,true);
    if (!$source || explode('/',$source['dataset'],2)[0]!==$pool || dirname($source['path'])!==$source['mountpoint']) return zfsmFailure($directory,'Only a direct child of a mounted dataset can be converted');
    try { zfsmConversionRequireWritableOwner($source['dataset']);$review=zfsmDirectoryRequest('claim',$source);zfsmConfinedPreflight($review); }
    catch (Throwable $error) { return zfsmFailure($directory,$error->getMessage()); }
    $dataset=$source['dataset'].'/'.basename($source['path']);
    if (!zfsmValidDatasetName($dataset) || zfsmDatasetExists($dataset)) return zfsmFailure($directory,'Target dataset already exists or is invalid');
    $queue_file=zfsmJobDirectory($GLOBALS['plugin_state']).'/queue.lock';
    if (is_link($queue_file)) throw new RuntimeException('Invalid queue lock');
    $lock=@fopen($queue_file,'c'); if (!$lock||!flock($lock,LOCK_EX)) throw new RuntimeException('Unable to lock queue');
    try {
        foreach (zfsmPendingJobs() as $existing) {
            if (($existing['source']??'')===$source['path'] && !in_array($existing['state']??'', ['completed','failed','cancelled','recovery_required'],true)) return ['succeeded'=>[$directory=>'Already queued'],'failed'=>[],'job'=>$existing];
        }
        $guid=runProcess('zfs',['get','-H','-o','value','guid',$source['dataset']]);
        if ($guid['code']!==0 || !preg_match('/^[0-9]+$/D',$guid['output'])) throw new RuntimeException('Unable to verify source filesystem identity');
        $id=gmdate('Ymd-His').'-'.bin2hex(random_bytes(6));
        $recovery=zfsmConversionRecoveryPath($source['path'],$id);
        clearstatcache(true,$recovery);
        if (file_exists($recovery)||is_link($recovery)) $recovery=zfsmConversionRecoveryPath($source['path'],$id,true);
        clearstatcache(true,$recovery);
        if (file_exists($recovery)||is_link($recovery)) throw new RuntimeException('Retained original destination already exists; review it and submit a new conversion.');
        $job=['schema'=>1,'method'=>'confined-v1','id'=>$id,'state'=>'queued','stage'=>'planned','source'=>$source['path'],'source_identity'=>$review['identity'],'source_identity_boot'=>zfsmBootId(),'recovery'=>$recovery,'dataset'=>$dataset,'owner_dataset'=>$source['dataset'],'owner_guid'=>$guid['output'],'owner_mountpoint'=>$source['mountpoint'],'pool'=>$pool,'staging'=>zfsmConfinedStagingPath($id),'ack_boot'=>zfsmBootId(),'cancel_requested'=>false,'created'=>gmdate('c'),'updated'=>gmdate('c')];
        $job=zfsmJobInitializeHistory($job);
        // Publication can succeed before a following directory sync fails.
        // Such an outcome must not be reported as a proven prequeue rejection.
        $GLOBALS['zfsm_conversion_journal_started']=true;
        zfsmJobAtomicWrite(zfsmJobFile($id),$job);
        return ['succeeded'=>[$directory=>'Conversion queued; original will be retained'],'failed'=>[],'job'=>$job];
    } finally { flock($lock,LOCK_UN); fclose($lock); }
}
function zfsmCancelConversion($id) {
    return zfsmJobUpdate($id,function($job){
        if (($job['schema']??0)!==1) throw new InvalidArgumentException('Legacy journal requires manual recovery');
        if (zfsmJobProblem($job)) throw new InvalidArgumentException('This job requires manual inspection');
        if (in_array($job['state'],['completed','failed','cancelled','recovery_required'],true)) return [];
        return ['cancel_requested'=>true]+($job['state']==='queued'?['state'=>'cancelled']:[]);
    });
}
function zfsmResumeConversion($id,$offline_confirmed) {
    if ($offline_confirmed!=='1'&&$offline_confirmed!==true) throw new InvalidArgumentException('Confirm all writers remain stopped before resuming');
    return zfsmJobUpdate($id,function($job){
        if (($job['schema']??0)!==1 || zfsmJobProblem($job) || $job['state']==='completed') throw new InvalidArgumentException('This job cannot be resumed automatically');
        if (!zfsmConfinedCanResume($job)) throw new InvalidArgumentException('This conversion has retained source or partial target data; inspect it manually before another operation. Destructive stages are not retried.');
        if ($job['state']==='running' && zfsmWorkerRunning()) throw new InvalidArgumentException('Job is still running; cancel it or wait');
        if ($job['state']==='queued' && ($job['ack_boot']??'')===zfsmBootId() && empty($job['cancel_requested']) && empty($job['error'])) return [];
        return ['state'=>'queued','cancel_requested'=>false,'ack_boot'=>zfsmBootId(),'error'=>null];
    });
}
function zfsmWorkerRunning() {
    return zfsmLockHeld($GLOBALS['plugin_worker_lock']??'/var/lock/zfs.master.ui.worker.lock');
}
function zfsmServiceRunning() { return zfsmLockHeld($GLOBALS['plugin_service_lock']??'/var/lock/zfs.master.ui.service.lock'); }
function zfsmLockHeld($file) {
    if (is_link($file)) throw new RuntimeException('Invalid worker lock');
    $lock=@fopen($file,'c'); if(!$lock)return false;
    $free=flock($lock,LOCK_EX|LOCK_NB);
    if($free)flock($lock,LOCK_UN); fclose($lock); return !$free;
}
function zfsmSuperviseWorker($launch,$stop,$pause) {
    $backoff=1;
    while (!$stop()) {
        $start=microtime(true); $launch();
        if ($stop()) break;
        $pause($backoff);
        $backoff=microtime(true)-$start>30?1:min(5,$backoff*2);
    }
}
function zfsmWorkerStopRequested() { return is_file(($GLOBALS['plugin_runtime']??'/var/tmp/zfs.master.ui/jobs').'/stop'); }
function zfsmWriteJobProgress($id,$progress) {
    $root=zfsmJobDirectory($GLOBALS['plugin_runtime']??'/var/tmp/zfs.master.ui/jobs');
    $progress['updated']=gmdate('c'); zfsmJobAtomicWrite($root.'/'.zfsmJobId($id).'.json',$progress);
}
function zfsmStartWorker() {
    if (zfsmWorkerStopRequested()) throw new RuntimeException('Worker is stopped for maintenance; job retained in queue');
    if (zfsmServiceRunning()) return true;
    $runtime=zfsmJobDirectory($GLOBALS['plugin_runtime']??'/var/tmp/zfs.master.ui/jobs');
    $php=is_executable('/usr/bin/php')?'/usr/bin/php':'/bin/php';
    $setsid=is_executable('/usr/bin/setsid')?'/usr/bin/setsid':'/bin/setsid';
    if (!is_executable($php)||!is_executable($setsid)) throw new RuntimeException('PHP CLI or setsid is unavailable; job retained in queue');
    $worker=dirname(__DIR__).'/scripts/zfsm-worker.php';
    $pipes=[];
    $process=@proc_open([$setsid,'--fork','--',$php,$worker,'--service'],[0=>['file','/dev/null','r'],1=>['file',$runtime.'/worker.log','a'],2=>['redirect',1]],$pipes,null,null,['bypass_shell'=>true]);
    if (!is_resource($process)||proc_close($process)!==0) throw new RuntimeException('Unable to start background worker; job retained in queue');
    return true;
}
