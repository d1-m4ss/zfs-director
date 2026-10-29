<?php
// Request-owned journals are observations, never executable/replayable payloads.
function zfsmRequestJobCommands() {
    return ['cancelconversion'=>'Cancel conversion','resumeconversion'=>'Resume conversion','publishconversion'=>'Publish conversion','cancelrestore'=>'Cancel restore','protectioncancel'=>'Cancel protection job','activityvisibility'=>'Organize activity history','jobhistorycleanup'=>'Clean job history','createdataset'=>'Create dataset','editdatasetproperty'=>'Change dataset property','adddirectortlisting'=>'Add directory listing','removedirectorylisting'=>'Remove directory listing','renamedataset'=>'Rename dataset','lockdataset'=>'Lock dataset','unlockdataset'=>'Unlock dataset','promotedataset'=>'Promote clone','movedirectory'=>'Move directory','cleanupmutation'=>'Clean completed recovery','rollbacksnapshot'=>'Restore dataset from snapshot','renamesnapshot'=>'Rename snapshot','holdsnapshot'=>'Hold snapshot','releasesnapshot'=>'Release snapshot hold','clonesnapshot'=>'Clone snapshot','destroysnapshot'=>'Delete snapshots','snapshotdataset'=>'Create snapshots','saveconfig'=>'Save settings','setquota'=>'Change quota','editacl'=>'Change permissions','protectionsettings'=>'Change Data Protection settings','protectionpolicysave'=>'Save snapshot policy','protectionreplicationsave'=>'Save replication task','protectioncontrol'=>'Change protection definition','protectionimport'=>'Import policy','protectionexternaltransfer'=>'Transfer External ownership','scrubpool'=>'Pool scrub','downloadsnapshotfile'=>'Download snapshot file','downloadsnapshotarchive'=>'Download ZIP','convertdirectory'=>'Convert directory','deletedirectory'=>'Delete directory','destroydataset'=>'Delete dataset','restoresnapshotfiles'=>'Restore files','archivesnapshotfiles'=>'Prepare ZIP','protectionrun'=>'Run Data Protection'];
}
function zfsmRequestJobQueuedCommands() { return ['convertdirectory','deletedirectory','destroydataset','restoresnapshotfiles','archivesnapshotfiles','protectionrun']; }
function zfsmRequestJobCategory($job) {
    $categories=['snapshotdataset'=>'snapshot','renamesnapshot'=>'snapshot','holdsnapshot'=>'snapshot','releasesnapshot'=>'snapshot','clonesnapshot'=>'snapshot','protectionpolicysave'=>'policy','protectionimport'=>'policy','protectionexternaltransfer'=>'policy','protectionreplicationsave'=>'replication','restoresnapshotfiles'=>'restore','rollbacksnapshot'=>'restore','archivesnapshotfiles'=>'archive','convertdirectory'=>'conversion','cancelconversion'=>'conversion','resumeconversion'=>'conversion','publishconversion'=>'conversion','cancelrestore'=>'restore','deletedirectory'=>'deletion','destroydataset'=>'deletion','destroysnapshot'=>'deletion'];
    $type=is_string($job['type']??null)?$job['type']:'unknown';$command=is_string($job['command']??null)?$job['command']:'';
    return ($job['schema']??null)===7?($job['category']??$categories[$command]??$type):$type;
}
// Called only after preview signature verification; retain display context, never a replay payload.
function zfsmRequestJobRestoreContext($document) {
    $ctx=$document['context']??[];$plan=$document['plan']??[];
    if(!is_array($ctx)||!is_array($plan)||!zfsmValidSnapshotName($ctx['snapshot']??null)||!zfsmValidDatasetName($ctx['dataset']??null)||explode('@',$ctx['snapshot'],2)[0]!==$ctx['dataset'])return;
    $mount=$ctx['destination']??null;if(!is_string($mount)||!str_starts_with($mount,'/')||$mount==='/'||strlen($mount)>4096||preg_match('/[\x00-\x1f\x7f]/',$mount)||preg_match('#(?:^|/)\.\.?(/|$)#',$mount))return;
    try{$target=zfsmExplorerPath($plan['target']??null);}catch(Throwable$error){return;}
    if(preg_match('/[\x00-\x1f\x7f]/',$target))return;
    $GLOBALS['zfsm_request_restore_context']=['snapshot'=>$ctx['snapshot'],'dataset'=>$ctx['dataset'],'target'=>$mount.($target===''?'':'/'.$target)];
}
// Context comes from a successfully verified, server-owned protection review.
function zfsmRequestJobReviewContext($review) {
    if(!isset($GLOBALS['zfsm_request_job'])||!is_array($review))return;
    $kind=$review['type']??null;$value=$review['value']??[];$definition=$review['definition']??$value;
    $category=$kind==='definition_control'?($value['type']??null):($kind==='policy_import'?'policy':$kind);
    if(!in_array($category,['policy','replication'],true)||!is_array($definition))return;
    $changes=['category'=>$category];$source=$definition[$category==='policy'?'dataset':'source']??null;
    if(zfsmValidDatasetName($source))$changes['source']=$source;
    $name=$definition['name']??null;if(is_string($name)&&strlen($name)<=200&&!preg_match('/[\x00-\x1f\x7f]/',$name))$changes['definition_name']=$name;
    if($kind==='definition_control'&&in_array($value['action']??null,['enable','disable','remove'],true))$changes['definition_action']=$value['action'];
    zfsmJobUpdate($GLOBALS['zfsm_request_job']['id'],$changes);
}
function zfsmRequestJobLease($id) { return zfsmJobDirectory($GLOBALS['plugin_runtime'].'/requests').'/'.zfsmJobId($id).'.lock'; }
function zfsmRequestJobSubject($request) {
    foreach(['snapshot','zdataset','directory','pool']as$key)if(is_string($request[$key]??null)&&$request[$key]!==''&&strlen($request[$key])<=4096&&!preg_match('/[\x00-\x1f\x7f]/',$request[$key]))return $request[$key];
    if(is_array($request['data']??null)&&is_string($request['data']['zpool']??null)&&is_string($request['data']['name']??null)&&zfsmValidDatasetName($request['data']['zpool'].'/'.$request['data']['name']))return $request['data']['zpool'].'/'.$request['data']['name'];
    return zfsmRequestJobCommands()[$request['cmd']??'']??'Director operation';
}
function zfsmRequestJobBegin($command,$request,$audit_id=null) {
    $history_gate=zfsmJobHistoryGate();try{
    $labels=zfsmRequestJobCommands();if(!isset($labels[$command]))throw new InvalidArgumentException('Unsupported request job');
    $context=$command==='restoresnapshotfiles'?($GLOBALS['zfsm_request_restore_context']??[]):[];
    if($command==='restoresnapshotfiles')$request=['cmd'=>$command]+$context;
    $parent=null;if(in_array($command,['cancelconversion','resumeconversion','publishconversion','cancelrestore','protectioncancel','downloadsnapshotarchive'],true)&&is_string($request['job_id']??null)&&preg_match('/^[0-9]{8}-[0-9]{6}-[a-f0-9]{12}$/D',$request['job_id']))try{$candidate=zfsmReadJob($request['job_id']);if(!zfsmJobProblem($candidate))$parent=$candidate;}catch(Throwable$error){}
    $id=gmdate('Ymd-His').'-'.bin2hex(random_bytes(6));$now=gmdate('c');$path=zfsmRequestJobLease($id);
    if(is_link($path))throw new RuntimeException('Untrusted request journal lock');$lease=fopen($path,'xce');if(!$lease)throw new RuntimeException('Unable to open request journal lock');if(!flock($lease,LOCK_EX|LOCK_NB)){fclose($lease);throw new RuntimeException('Unable to own request journal');}
    try{$job=zfsmJobInitializeHistory(['schema'=>7,'id'=>$id,'type'=>str_starts_with($command,'download')?'download':($command==='scrubpool'?'maintenance':'operation'),'command'=>$command,'label'=>$labels[$command],'source'=>zfsmRequestJobSubject($request),'state'=>'queued','stage'=>'planned','created'=>$now,'updated'=>$now,'started_at'=>null,'finished_at'=>null,'owner_boot'=>zfsmBootId(),'audit_id'=>$audit_id]);
    if(is_string($request['snapshot']??null)&&zfsmValidSnapshotName($request['snapshot']))$job['snapshot']=$request['snapshot'];
    $job+=$context;
    if($parent!==null){$job['parent_job_id']=$parent['id'];$job['source']=$parent['source']??$parent['id'];if($command==='protectioncancel'&&in_array($parent['type']??null,['policy','replication'],true))$job['category']=$parent['type'];}
    if($command==='downloadsnapshotarchive'&&is_string($request['job_id']??null)&&preg_match('/^[0-9]{8}-[0-9]{6}-[a-f0-9]{12}$/D',$request['job_id']))$job['parent_job_id']=$request['job_id'];
    zfsmJobAtomicWrite(zfsmJobFile($id),$job);$GLOBALS['zfsm_request_job']=['id'=>$id,'lease'=>$lease,'last_progress'=>0.0];$job=zfsmJobUpdate($id,['state'=>'running','stage'=>'validating_request','started_at'=>$now]);}
    catch(Throwable$error){fclose($lease);unset($GLOBALS['zfsm_request_job']);throw $error;}
    register_shutdown_function(function(){if(isset($GLOBALS['zfsm_request_job']))try{zfsmRequestJobFinish('recovery_required','Request ended before a final result was recorded. Inspect actual state; this operation will not be replayed.','interrupted');}catch(Throwable$error){error_log('ZFS Director: request journal requires inspection');}});
    return $job;
    }finally{flock($history_gate,LOCK_UN);fclose($history_gate);}
}
function zfsmRequestJobDownloadContext($snapshot) {
    if(isset($GLOBALS['zfsm_request_job'])&&zfsmValidSnapshotName($snapshot))zfsmJobUpdate($GLOBALS['zfsm_request_job']['id'],['snapshot'=>$snapshot,'source'=>$snapshot]);
}
function zfsmRequestJobStage($stage) {
    $id=$GLOBALS['zfsm_request_job']['id']??null;if(!$id)return;
    $job=zfsmReadJob($id);if($job['stage']!==$stage)zfsmJobUpdate($id,['stage'=>$stage]);
}
function zfsmRequestJobProgress($sent,$total) {
    if(!isset($GLOBALS['zfsm_request_job']))return;
    if(!is_int($sent)||!is_int($total)||$sent<0||$total<0||$sent>$total)throw new RuntimeException('Invalid transfer progress');
    $tracking=&$GLOBALS['zfsm_request_job'];$tracking['progress']=['stage'=>'transferring','bytes'=>$sent,'total'=>$total,'percent'=>$total>0?min(99,(int)floor(100*$sent/$total)):null];
    if(microtime(true)-$tracking['last_progress']>=0.25||$sent===$total){zfsmWriteJobProgress($tracking['id'],$tracking['progress']);$tracking['last_progress']=microtime(true);}
}
function zfsmRequestJobFinish($state,$summary,$stage=null,$details=[]) {
    $tracking=$GLOBALS['zfsm_request_job']??null;if(!$tracking)return null;
    $changes=['state'=>$state,'stage'=>$stage??($state==='completed'?'completed':($state==='recovery_required'?'inspection_required':'failed')),'finished_at'=>gmdate('c'),'result'=>['summary'=>$summary]+$details];
    if($state!=='completed')$changes['error']=$summary;
    if(isset($tracking['progress'])){$changes['progress']=$tracking['progress'];if($state==='completed')$changes['progress']['percent']=100;}
    try{return zfsmJobUpdate($tracking['id'],$changes);}finally{if(is_resource($tracking['lease']))fclose($tracking['lease']);unset($GLOBALS['zfsm_request_job']);}
}
function zfsmRequestJobFailure($failed) {
    $text=implode("\n",array_filter($failed,'is_string'));
    foreach([
        '/operation lock|Another operation is running|Unable to lock queue/i'=>'Another operation is running. Wait for it to finish, then review and submit again.',
        '/identity|GUID|replaced|changed since/i'=>'Object identity changed or could not be verified. Refresh and review the current object.',
        '/Destructive Mode is disabled/i'=>'Destructive Mode is disabled in Settings.',
        '/read[ -]?only/i'=>'The destination dataset is read-only. Review its readonly property before submitting a new request.',
        '/permission|access denied|not permitted/i'=>'Permission denied. Review the selected object and its access permissions.',
        '/no space|quota exceeded|disk full/i'=>'Insufficient space or quota. Free space and review the operation before retrying.',
        '/hold|clone|busy|dependencies|service references|mount/i'=>'The operation is blocked by object dependencies, holds or filesystem references. Review Usage & Dependencies.',
        '/preview|review|confirm|token/i'=>'The required review is missing, expired or no longer matches. Load a fresh preview and confirm it.',
        '/integration is disabled/i'=>'Sanoid / Syncoid is disabled. Existing schedules were not changed.',
        '/invalid|unsupported|not found|no longer available|does not exist/i'=>'The selected object or request is invalid or unavailable. Refresh and review the current selection.',
    ]as$pattern=>$message)if(preg_match($pattern,$text))return $message;
    return 'The operation failed. Review its stage and Administrative History; inspect actual state before retrying.';
}
function zfsmRequestJobAnswer($answer) {
    $command=$GLOBALS['zfsm_job_request_command']??'';
    if(isset($GLOBALS['zfsm_request_job'])){
        $failed=!empty($answer['failed']);$uncertain=($failed&&!empty($GLOBALS['zfsm_request_job']['native_submitted']))||isset($answer['failed']['audit'])||($failed&&!empty($answer['succeeded']));$summary=$uncertain?'The operation may have completed partly or fully. Inspect actual state and Administrative History before retrying.':($failed?zfsmRequestJobFailure($answer['failed']):(zfsmRequestJobCommands()[$command]??'Operation').' completed.');
        if($command==='snapshotdataset')foreach(array_keys($answer['succeeded']??[])as$name)if(zfsmValidSnapshotName($name)){zfsmRequestJobDownloadContext($name);break;}
        $id=$GLOBALS['zfsm_request_job']['id'];$audit=$GLOBALS['zfsm_job_request_audit']??null;if($audit!==null)zfsmJobUpdate($id,['audit_id'=>$audit]);
        $context=$GLOBALS['zfsm_job_failure_context']??[];
        $safe=array_intersect_key($context,array_flip(['stage','exit_code','error_code','tool']));
        $record=zfsmRequestJobFinish($uncertain?'recovery_required':($failed?'failed':'completed'),$summary,null,['succeeded_count'=>count($answer['succeeded']??[]),'failed_count'=>count($answer['failed']??[]),'failure'=>$failed?$safe:null]+(!empty($answer['scheduler_warning'])||!empty($answer['worker_warning'])?['severity'=>'warning']:[]));
        if(isset($answer['job']))$answer['request_job']=$record;else $answer['job']=$record;
    }elseif(($answer['job']['schema']??null)===7&&!empty($answer['failed'])){
        $answer['job']=zfsmJobUpdate($answer['job']['id'],['state'=>'recovery_required','stage'=>'observation_lost','finished_at'=>gmdate('c'),'error'=>'The native operation was requested, but the request outcome could not be recorded fully. Inspect actual state; automatic retry is disabled.']);
    }elseif(empty($answer['job'])&&isset($GLOBALS['zfsm_request_published_job'])){
        $answer['job']=zfsmReadJob($GLOBALS['zfsm_request_published_job']);
    }elseif(empty($answer['job'])&&!empty($answer['failed'])&&in_array($command,zfsmRequestJobQueuedCommands(),true)&&empty($GLOBALS['zfsm_conversion_journal_started'])&&empty($GLOBALS['zfsm_deletion_journal_started'])){
        zfsmRequestJobBegin($command,$_POST,$GLOBALS['zfsm_job_request_audit']??null);$answer['job']=zfsmRequestJobFinish('failed',zfsmRequestJobFailure($answer['failed']),'preflight_rejected');
    }
    return $answer;
}
function zfsmValidateRequestJob($job) {
    $allowed=['schema','id','type','command','label','source','state','stage','created','updated','started_at','finished_at','owner_boot','audit_id','snapshot','dataset','target','parent_job_id','stage_history','stage_history_complete','stage_history_dropped','result','error','progress','pool_guid','scan_started','scan_before','observed_at','scan_timezone','scan_requested_from','scan_requested_until','scan_resume_started','category','definition_name','definition_action'];
    $command=$job['command']??null;if(!is_string($command)||!isset(zfsmRequestJobCommands()[$command])||array_diff(array_keys($job),$allowed))throw new RuntimeException('Invalid request journal fields');
    zfsmJobId($job['id']);$expected=str_starts_with($command,'download')?'download':($command==='scrubpool'?'maintenance':'operation');
    if(($job['schema']??null)!==7||($job['type']??null)!==$expected||($job['label']??null)!==zfsmRequestJobCommands()[$command]||!is_string($job['source']??null)||strlen($job['source'])>4096||!is_string($job['owner_boot']??null))throw new RuntimeException('Invalid request journal identity');
    if(!is_string($job['stage']??null)||!preg_match('/^[a-z][a-z0-9_]{0,63}$/D',$job['stage']))throw new RuntimeException('Invalid request journal stage');
    if(isset($job['dataset'])||isset($job['target'])){
        if($command!=='restoresnapshotfiles'||!zfsmValidDatasetName($job['dataset']??null)||!zfsmValidSnapshotName($job['snapshot']??null)||explode('@',$job['snapshot'],2)[0]!==$job['dataset']||$job['source']!==$job['snapshot']||!is_string($job['target']??null)||!str_starts_with($job['target'],'/')||strlen($job['target'])>8193||preg_match('/[\x00-\x1f\x7f]/',$job['target'])||preg_match('#(?:^|/)\.\.?(/|$)#',$job['target']))throw new RuntimeException('Invalid reviewed restore context');
    }
    if(isset($job['category'])&&(!in_array($job['category'],['policy','replication'],true)||!str_starts_with($command,'protection')))throw new RuntimeException('Invalid definition category');
    foreach(['definition_name','definition_action']as$key)if(isset($job[$key])&&(!is_string($job[$key])||strlen($job[$key])>200||preg_match('/[\x00-\x1f\x7f]/',$job[$key])))throw new RuntimeException('Invalid definition context');
    if(isset($job['parent_job_id']))zfsmJobId($job['parent_job_id']);
    if(isset($job['pool_guid'])&&($command!=='scrubpool'||!zfsmValidPoolName($job['source'])||!is_string($job['pool_guid'])||!preg_match('/^[1-9][0-9]*$/D',$job['pool_guid'])||!is_string($job['scan_before']??null)||!preg_match('/^[a-f0-9]{64}$/D',$job['scan_before'])))throw new RuntimeException('Invalid native scan observation');
    if(isset($job['pool_guid'])&&(!is_string($job['scan_timezone']??null)||!preg_match('/^[+-](?:0[0-9]|1[0-4])[0-5][0-9]$/D',$job['scan_timezone'])||!is_int($job['scan_requested_from']??null)))throw new RuntimeException('Missing scrub start evidence');
    if(isset($job['observed_at'])&&(!is_int($job['scan_requested_until']??null)||$job['scan_requested_until']<$job['scan_requested_from']))throw new RuntimeException('Missing scrub dispatch window');
    if(isset($job['observed_at'])&&(!is_int($job['observed_at'])||$job['observed_at']<0))throw new RuntimeException('Invalid observation timestamp');
}
function zfsmRequestJobActive($job) {
    if(($job['owner_boot']??null)!==zfsmBootId())return false;
    $file=zfsmRequestJobLease($job['id']);return is_file($file)&&!is_link($file)&&zfsmLockHeld($file);
}
function zfsmObserveRequestJob($id) {
    $job=zfsmReadJob($id);zfsmValidateRequestJob($job);
    if(!in_array($job['state'],['queued','running'],true))return $job;
    if(zfsmRequestJobActive($job))return $job;
    if($job['command']==='scrubpool'&&isset($job['pool_guid'])&&$job['state']==='running'&&in_array($job['stage'],['awaiting_scan','scrubbing','scrub_paused'],true))return zfsmObserveScrubJob($job);
    // Never turn an abandoned HTTP request into an executable worker job.
    return zfsmJobUpdate($id,function($live){if(!in_array($live['state'],['queued','running'],true)||zfsmRequestJobActive($live))return [];return ['state'=>'recovery_required','stage'=>'interrupted','finished_at'=>gmdate('c'),'error'=>'Request ended without a verified result. Inspect actual state; automatic retry is disabled.'];});
}
