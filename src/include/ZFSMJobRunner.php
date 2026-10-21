<?php

function zfsmJobTargetState($job) {
    $result=runProcess('zfs',['get','-H','-o','property,value','guid,zfs.master.ui:conversion-job,mountpoint,mounted',$job['dataset']]);
    if ($result['code']!==0) throw new RuntimeException('Unable to inspect conversion target');
    $state=[];
    foreach (explode("\n",$result['output']) as $line) { $parts=explode("\t",$line,2); if(count($parts)===2)$state[$parts[0]]=$parts[1]; }
    $mountinfo=zfsmMountInfo();
    if (($state['zfs.master.ui:conversion-job']??'')!==$job['id'] || !preg_match('/^[0-9]+$/D',$state['guid']??'') || ($state['mountpoint']??'')!==$job['source'] || ($state['mounted']??'')!=='yes' || !zfsmLiveZfsMount($job['source'],$job['dataset'],$mountinfo) || zfsmPathHasSymlink($job['source'])) throw new RuntimeException('Conversion target ownership or live mount changed');
    foreach ($mountinfo as $mount) if (str_starts_with($mount['path'],$job['source'].'/')) throw new RuntimeException('Conversion target contains a nested mount');
    if (isset($job['target_guid']) && $job['target_guid']!==$state['guid']) throw new RuntimeException('Conversion target was replaced');
    return $state;
}
function zfsmValidateJobShape($job) {
    if (array_key_exists('method',$job)) {
        zfsmValidateConfinedJobShape($job);
        return;
    }
    if (($job['schema']??0)!==1 || !zfsmValidPoolName($job['pool']??'') || !zfsmValidDatasetName($job['owner_dataset']??'') || !zfsmValidDatasetName($job['dataset']??'') || ($job['dataset']??'')!==$job['owner_dataset'].'/'.basename($job['source']??'') || dirname($job['source']??'')!==($job['owner_mountpoint']??'') || ($job['recovery']??'')!==$job['source'].'_zfsm_recovery_'.$job['id'] || explode('/',$job['owner_dataset'],2)[0]!==$job['pool']) throw new RuntimeException('Job journal requires manual recovery');
    if (!in_array($job['stage']??'',['planned','moving','source_moved','creating','dataset_created','copying','verifying','complete_source_retained'],true)) throw new RuntimeException('Unknown conversion stage');
}
function zfsmConversionStage($id,$stage) {
    // Flush intent/audit before each filesystem side effect.
    zfsmAuditEvent('conversion',['job_id'=>$id,'stage'=>$stage],'running');
    return zfsmJobUpdate($id,['stage'=>$stage,'state'=>'running']);
}
function zfsmJobCancelRequested($id) { return !empty(zfsmReadJob($id)['cancel_requested']); }
function zfsmRunConversionJob($id) {
    $job=zfsmReadJob($id); $audit_id=null; $attempt_started=false;
    if (array_key_exists('method',$job)) return zfsmRunConfinedConversionJob($id);
    if (!in_array($job['state']??'', ['queued','running'],true)) return $job;
    try {
        zfsmValidateJobShape($job);
        if ($job['state']==='running') return zfsmJobUpdate($id,['state'=>'recovery_required','finished_at'=>null,'error'=>'Conversion was interrupted. Inspect retained data and confirm Resume before continuing.']);
        if (!zfsmJobBootApproved($job)) return zfsmJobUpdate($id,['state'=>'recovery_required','started_at'=>null,'finished_at'=>null,'error'=>'System restarted. Stop all writers and confirm Resume before continuing.']);
        if (zfsmJobCancelRequested($id)) { zfsmAuditEvent('conversion',['job_id'=>$id,'stage'=>$job['stage']],'cancelled'); return zfsmJobUpdate($id,['state'=>'cancelled','started_at'=>null,'finished_at'=>null]); }
        $audit_id=zfsmAuditBegin('conversion',['job_id'=>$id,'directory'=>$job['source'],'zdataset'=>$job['dataset'],'stage'=>$job['stage']]);
        $job=zfsmJobUpdate($id,['state'=>'running','started_at'=>gmdate('c'),'finished_at'=>null]); $attempt_started=true;
        // Legacy schema1 jobs are not silently upgraded to the new copier.
        // Their path-based ZFS/rsync stages still require trusted ancestors.
        if (!zfsmDirectoryParentsTrusted($job['source'])||!zfsmDirectoryParentsTrusted($job['recovery'])) throw new RuntimeException('Legacy conversion needs manual inspection under writable ancestors; no unsafe copy was attempted');
        $owner=zfsmFilesystemMounts()[$job['owner_dataset']]??null;
        if (!$owner || $owner['mounted']!=='yes' || $owner['mountpoint']!==$job['owner_mountpoint'] || !zfsmLiveZfsMount($job['owner_mountpoint'],$job['owner_dataset'],zfsmMountInfo())) throw new RuntimeException('Source filesystem or mount changed');
        $guid=runProcess('zfs',['get','-H','-o','value','guid',$job['owner_dataset']]);
        if ($guid['code']!==0 || trim($guid['output'])!==($job['owner_guid']??'')) throw new RuntimeException('Source filesystem identity changed');
        $target_exists=zfsmDatasetExists($job['dataset'],'filesystem');
        $source_exists=is_dir($job['source']); $recovery_exists=is_dir($job['recovery']);
        if (!$recovery_exists) {
            if ($target_exists || !$source_exists || !in_array($job['stage'],['planned','moving'],true)) throw new RuntimeException('Cannot reconcile original and recovery paths');
            $source=zfsmResolveDirectory($job['source'],true);
            if (!$source || $source['dataset']!==$job['owner_dataset'] || $source['path']!==$job['source']) throw new RuntimeException('Original directory changed');
            zfsmRequireSourceIdentity($job,$job['source']);
            $job=zfsmConversionStage($id,'moving');
            if (zfsmJobCancelRequested($id)) throw new RuntimeException('cancel_requested');
            // Only legacy jobs with the strict ancestor check above use this
            // compatibility rename. New jobs use the native claim boundary.
            $moved=@rename($job['source'],$job['recovery'])?['succeeded'=>[$job['recovery']=>0]]:['succeeded'=>[]];
            if (!$moved['succeeded']) throw new RuntimeException('Unable to rename original directory; source retained');
            $job=zfsmConversionStage($id,'source_moved');
            $source_exists=false; $recovery_exists=true;
        }
        $recovery=zfsmResolveDirectory($job['recovery'],true);
        if (!$recovery || $recovery['dataset']!==$job['owner_dataset'] || $recovery['path']!==$job['recovery']) throw new RuntimeException('Recovery source changed or contains nested mounts');
        zfsmRequireSourceIdentity($job,$job['recovery']);
        if (!$target_exists) {
            if ($source_exists || !in_array($job['stage'],['moving','source_moved','creating'],true)) throw new RuntimeException('Conversion target disappeared or original path is occupied');
            $job=zfsmConversionStage($id,'creating');
            if (zfsmJobCancelRequested($id)) throw new RuntimeException('cancel_requested');
            $created=runProcess('zfs',['create','-o','mountpoint='.$job['source'],'-o','zfs.master.ui:conversion-job='.$id,$job['dataset']]);
            if ($created['code']!==0) throw new RuntimeException('Dataset creation failed; retained original requires inspection: '.$created['output']);
        }
        $state=zfsmJobTargetState($job);
        $job=zfsmJobUpdate($id,['target_guid'=>$state['guid']]);
        $job=zfsmConversionStage($id,'dataset_created');
        $progress=['stage'=>'copying','percent'=>0,'bytes'=>0,'rate'=>'','remaining'=>'']; $last_progress=0; $buffer='';
        $on_chunk=function($chunk)use($id,&$progress,&$last_progress,&$buffer) {
            $buffer=substr($buffer.$chunk,-4096); $parsed=zfsmParseRsyncProgress($buffer);
            if ($parsed) $progress=array_merge($progress,$parsed);
            if (microtime(true)-$last_progress>=1) { zfsmWriteJobProgress($id,$progress); $last_progress=microtime(true); }
        };
        $cancel=function()use($id,&$audit_id){
            $stopped=zfsmWorkerStopRequested(); $cancelled=zfsmJobCancelRequested($id);
            if ($stopped || $cancelled) {
                // Persist before signalling the isolated group, including this
                // daemon. The supervisor can now restart without recopying.
                zfsmJobUpdate($id,['state'=>$stopped?'recovery_required':'cancelled','finished_at'=>null,'error'=>$stopped?'Worker stopped; confirm Resume before continuing':'Cancelled. Original and partial dataset retained.']);
                if ($audit_id!==null) { zfsmAuditFinish($audit_id,['status'=>$stopped?'recovery_required':'cancelled']); $audit_id=null; }
                return true;
            }
            return false;
        };
        $job=zfsmConversionStage($id,'copying'); zfsmWriteJobProgress($id,$progress);
        $stream_failure=function($error)use($id,&$audit_id,&$job){
            zfsmJobUpdate($id,['state'=>'recovery_required','finished_at'=>null,'error'=>'Copy process interrupted; inspect retained source and Resume explicitly']);
            if ($audit_id!==null) { zfsmAuditFinish($audit_id,['status'=>'recovery_required','reason'=>'command_failed','details'=>['stage'=>$job['stage']??'unknown']]); $audit_id=null; }
        };
        $copied=zfsmStreamProcess('rsync',['-aHAX','--numeric-ids','--one-file-system','--info=progress2','--no-inc-recursive','--',$job['recovery'].'/',$job['source'].'/'],$on_chunk,$cancel,$stream_failure);
        if ($copied['cancelled'] || $cancel()) throw new RuntimeException(zfsmWorkerStopRequested()?'Worker stopped; retained source requires Resume':'cancel_requested');
        if ($copied['code']!==0) throw new RuntimeException('Copy failed ('.$copied['code'].'): '.$copied['output']);
        zfsmJobTargetState($job);
        if (!zfsmResolveDirectory($job['recovery'],true)) throw new RuntimeException('Recovery mount changed before verification');
        zfsmRequireSourceIdentity($job,$job['recovery']);
        $job=zfsmConversionStage($id,'verifying'); $progress=['stage'=>'verifying','percent'=>0,'bytes'=>0,'rate'=>'','remaining'=>'']; zfsmWriteJobProgress($id,$progress);
        $verified=zfsmStreamProcess('rsync',['-aHAX','--numeric-ids','--one-file-system','--checksum','--dry-run','--delete','--itemize-changes','--',$job['recovery'].'/',$job['source'].'/'],$on_chunk,$cancel,$stream_failure);
        if ($verified['cancelled'] || $cancel()) throw new RuntimeException(zfsmWorkerStopRequested()?'Worker stopped; retained source requires Resume':'cancel_requested');
        if ($verified['code']!==0 || !empty($verified['has_output']) || trim($verified['output'])!=='') throw new RuntimeException('Copy verification failed: '.$verified['output']);
        zfsmJobTargetState($job);
        $job=zfsmJobUpdate($id,['stage'=>'complete_source_retained','state'=>'completed','finished_at'=>gmdate('c'),'error'=>null]);
        zfsmWriteJobProgress($id,['stage'=>'completed','percent'=>100,'bytes'=>$progress['bytes']]);
        zfsmAuditFinish($audit_id,['status'=>'succeeded']); refreshData();
        return $job;
    } catch (Throwable $error) {
        $cancelled=$error->getMessage()==='cancel_requested';
        $state=$cancelled?'cancelled':'recovery_required';
        $job=zfsmJobUpdate($id,['state'=>$state,'finished_at'=>$attempt_started?gmdate('c'):null,'error'=>$cancelled?'Cancelled. Original and partial dataset retained.':substr($error->getMessage(),0,4096)]);
        if ($audit_id!==null) {
            try { zfsmAuditFinish($audit_id,['status'=>$cancelled?'cancelled':'recovery_required','reason'=>'command_failed','details'=>['stage'=>$job['stage']??'unknown']]); }
            catch (Throwable $audit_error) { $job=zfsmJobUpdate($id,['audit_error'=>'Unable to record final audit outcome']); }
        }
        return $job;
    }
}
