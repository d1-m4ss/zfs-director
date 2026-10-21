<?php
/** Durable restores use the existing supervised worker and mutation lock. */
function zfsmRestoreManifestFile($id) { return zfsmJobDirectory($GLOBALS['plugin_state'].'/restores/'.zfsmJobId($id)).'/request.json'; }
function zfsmValidateFileJobShape($job) {
    $type=$job['type']??'';
    if (($job['schema']??null)!==2 || !in_array($type,['restore','archive'],true)) throw new RuntimeException('Invalid file journal type; manual inspection is required');
    $id=zfsmJobId($job['id']??null);
    if (!in_array($job['state']??null,['queued','running','completed','failed','cancelled','recovery_required'],true) || !in_array($job['stage']??null,['planned','validating','copying','verifying','publishing','compressing','completed','cancelled_before_copy'],true)) throw new RuntimeException('Invalid file journal state; manual inspection is required');
    if (!zfsmValidDatasetName($job['dataset']??null) || !zfsmValidSnapshotName($job['snapshot']??null) || explode('@',$job['snapshot'],2)[0]!==$job['dataset'] || ($job['source']??null)!==$job['snapshot']) throw new RuntimeException('File journal snapshot ownership is invalid');
    foreach (['owner_guid','snapshot_guid'] as $key) if (!is_string($job[$key]??null) || preg_match('/^[1-9][0-9]{0,19}$/D',$job[$key])!==1 || (strlen($job[$key])===20 && strcmp($job[$key],'18446744073709551615')>0)) throw new RuntimeException('File journal identity is missing or invalid');
    if (isset($job['owner_pool_guid']) && (!is_string($job['owner_pool_guid']) || !preg_match('/^[1-9][0-9]{0,19}$/D',$job['owner_pool_guid']) || (strlen($job['owner_pool_guid'])===20 && strcmp($job['owner_pool_guid'],'18446744073709551615')>0))) throw new RuntimeException('File journal pool identity is invalid');
    $mount=$job['owner_mountpoint']??null;
    if (!is_string($mount) || !str_starts_with($mount,'/') || $mount==='/' || strlen($mount)>4096 || str_contains($mount,"\0") || preg_match('#(?:^|/)\.\.?(/|$)#',$mount) || ($job['staging']??null)!==$mount.'/.zfsm-'.$type.'-'.$id) throw new RuntimeException('File journal retained paths are invalid');
    if (($job['hold_tag']??null)!=='zfsm_'.$type.'_'.$id || !is_bool($job['hold_owned']??null) || !is_bool($job['cancel_requested']??null) || !is_string($job['ack_boot']??null) || $job['ack_boot']==='') throw new RuntimeException('File journal protection ownership is invalid');
    if (isset($job['cleanup_retry_after']) && (!is_int($job['cleanup_retry_after']) || $job['cleanup_retry_after']<0)) throw new RuntimeException('Invalid file journal cleanup time');
    if (isset($job['cleanup_error']) && (!is_string($job['cleanup_error']) || strlen($job['cleanup_error'])>2000)) throw new RuntimeException('Invalid file journal cleanup diagnostic');
    if (isset($job['cleanup_resolution']) && !in_array($job['cleanup_resolution'],['removed','owner_absent'],true)) throw new RuntimeException('Invalid file journal cleanup resolution');
    if ($type==='restore') {
        foreach (['bytes','files','conflicts'] as $key) if (!is_int($job[$key]??null) || $job[$key]<0) throw new RuntimeException('Invalid restore journal counts');
        if (!in_array($job['mode']??null,['new','overwrite'],true) || !is_string($job['target']??null) || ($job['target']!==$mount && !str_starts_with($job['target'],$mount.'/')) || ($job['recovery']??null)!==($job['conflicts']>0?$job['staging'].'/replaced':'')) throw new RuntimeException('Restore journal retained paths are invalid');
        zfsmExplorerPath($job['target']===$mount?'':substr($job['target'],strlen($mount)+1));
    } else {
        if (($job['target']??null)!=='ZIP download' || !is_bool($job['archive_removed']??null)) throw new RuntimeException('Invalid archive journal state');
        foreach (['dev','ino'] as $key) if (!is_string($job['destination_identity'][$key]??null) || !ctype_digit($job['destination_identity'][$key])) throw new RuntimeException('Archive destination identity is missing');
        if (($job['state']==='completed' || isset($job['expires'])) && (!is_int($job['expires']??null) || $job['expires']<=0)) throw new RuntimeException('Invalid archive expiry');
        if ($job['state']==='completed') {
            foreach (['dev','ino'] as $key) if (!is_string($job['archive_identity'][$key]??null) || !ctype_digit($job['archive_identity'][$key])) throw new RuntimeException('Archive file identity is missing');
            if (($job['archive_identity']['type']??null)!=='file' || !is_int($job['archive_size']??null) || $job['archive_size']<0) throw new RuntimeException('Invalid archive file identity');
        }
    }
}
function zfsmArchivePoolGuid($pool,$deadline=null) {
    $previous=$GLOBALS['zfsm_inventory_deadline']??null;
    $GLOBALS['zfsm_inventory_deadline']=min($previous??INF,$deadline??microtime(true)+4.0);
    try{$r=runProcess('zpool',['get','-H','-p','-o','value','guid',$pool]);}
    finally{if($previous===null)unset($GLOBALS['zfsm_inventory_deadline']);else $GLOBALS['zfsm_inventory_deadline']=$previous;}
    if(($r['code']??null)!==0||!is_string($r['output']??null)||!preg_match('/^[1-9][0-9]{0,19}$/D',$r['output'])||(strlen($r['output'])===20&&strcmp($r['output'],'18446744073709551615')>0))throw new RuntimeException('ZIP pool identity is unavailable; inspect the imported pool before retrying');
    return $r['output'];
}
function zfsmQueueArchive($snapshot,$selection,$guid) {
    if($guid==='')throw new InvalidArgumentException('Reopen the snapshot before downloading');
    $ctx=zfsmExplorerContext($snapshot,$guid);
    if($ctx['readonly']!=='off')throw new RuntimeException('ZIP preparation needs temporary space on this dataset. It is read-only; individual file downloads remain available');
    if(!is_array($selection)||!$selection||count($selection)>1000)throw new InvalidArgumentException('Select between 1 and 1000 files or folders');
    foreach($selection as$path){zfsmExplorerPath($path);if($path==='')throw new InvalidArgumentException('Select files or folders inside the snapshot');}
    $pool_guid=zfsmArchivePoolGuid(explode('/',$ctx['dataset'],2)[0]);
    $id=gmdate('Ymd-His').'-'.bin2hex(random_bytes(6));
    zfsmJobAtomicWrite(zfsmRestoreManifestFile($id),$ctx+['op'=>'archive','id'=>$id,'selection'=>array_values($selection),'archive_token'=>bin2hex(random_bytes(32))]);
    $job=['schema'=>2,'type'=>'archive','id'=>$id,'state'=>'queued','stage'=>'planned','snapshot'=>$snapshot,'snapshot_guid'=>$ctx['snapshot_guid'],'dataset'=>$ctx['dataset'],'owner_guid'=>$ctx['dataset_guid'],'owner_pool_guid'=>$pool_guid,'owner_mountpoint'=>$ctx['destination'],'destination_identity'=>$ctx['destination_identity'],'source'=>$snapshot,'target'=>'ZIP download','staging'=>$ctx['destination'].'/.zfsm-archive-'.$id,'hold_tag'=>'zfsm_archive_'.$id,'hold_owned'=>false,'cancel_requested'=>false,'archive_removed'=>false,'ack_boot'=>zfsmBootId(),'created'=>gmdate('c'),'updated'=>gmdate('c')];
    $job=zfsmJobInitializeHistory($job);zfsmJobAtomicWrite(zfsmJobFile($id),$job);return $job;
}
function zfsmArchiveRequest($job,$op) {
    zfsmValidateFileJobShape($job);
    $mount=$job['owner_mountpoint'];
    if(zfsmExplorerGuid($job['dataset'])!==$job['owner_guid']||!zfsmLiveZfsMount($mount,$job['dataset'],zfsmMountInfo()))throw new RuntimeException('Archive dataset identity changed');
    // ZFS st_dev changes on remount. GUID + verified live mount + stable inode
    // identify the same filesystem; adapt only its ephemeral device number.
    $identity=zfsmDirectoryIdentity($mount);
    if($identity['ino']!==$job['destination_identity']['ino'])throw new RuntimeException('Archive dataset root was replaced');
    $archive=$job['archive_identity']??null;if($archive)$archive['dev']=$identity['dev'];
    $file=zfsmRestoreManifestFile($job['id']);if(is_link($file)||!is_file($file)||filesize($file)>64*1024*1024)throw new RuntimeException('Archive ownership manifest is unavailable');
    $manifest=json_decode(file_get_contents($file),true,160,JSON_THROW_ON_ERROR);
    return ['op'=>$op,'id'=>$job['id'],'destination'=>$mount,'destination_identity'=>$identity,'archive_identity'=>$archive,'archive_token'=>$manifest['archive_token']??''];
}
function zfsmArchiveReadRequest($id) {
    $job=zfsmReadJob($id);
    zfsmValidateFileJobShape($job);
    if(($job['type']??'')!=='archive'||$job['state']!=='completed'||!empty($job['archive_removed'])||($job['expires']??0)<=time())throw new InvalidArgumentException('ZIP expired or is not ready. Prepare a new archive');
    return zfsmArchiveRequest($job,'archive-download');
}
function zfsmArchiveNeedsCleanup($job) {
    return ($job['type']??'')==='archive'&&empty($job['archive_removed'])&&!in_array($job['state'],['queued','running'],true)&&($job['state']!=='completed'||($job['expires']??0)<=time());
}
// A failed name lookup is not proof of destruction: the owner may have been
// renamed, exported or replaced. This inventory is read-only and bounded.
function zfsmArchiveCleanupInventory($pool,$pool_guid,$io) {
    if(zfsmArchivePoolGuid($pool,$io['deadline'])!==$pool_guid)throw new RuntimeException('ZIP pool identity changed; original temporary data and protection remain unresolved');
    $tool=($io['tool'])('zfs');
    if(!$tool||!zfsmUsageHasTime($io))throw new RuntimeException('ZIP cleanup cannot verify the original pool; temporary data are retained');
    $r=($io['process'])($tool,['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o','name,type,guid',$pool]);
    if(($r['code']??null)!==0||!is_string($r['output']??null)||strlen($r['output'])>524288)throw new RuntimeException('ZIP cleanup pool inventory is unavailable; temporary data are retained');
    $rows=[];
    foreach(explode("\n",rtrim($r['output'],"\r\n"))as$line){
        $p=explode("\t",$line);
        if(count($p)!==3||!in_array($p[1],['filesystem','volume','snapshot'],true)||!preg_match('/^[1-9][0-9]{0,19}$/D',$p[2])||(strlen($p[2])===20&&strcmp($p[2],'18446744073709551615')>0)||isset($rows[$p[0]]))throw new RuntimeException('ZIP cleanup inventory is incomplete or ambiguous; temporary data are retained');
        $name=explode('@',$p[0],2)[0];
        if(!($p[1]==='snapshot'?zfsmValidSnapshotName($p[0]):zfsmValidDatasetName($p[0]))||($name!==$pool&&!str_starts_with($name,$pool.'/')))throw new RuntimeException('ZIP cleanup inventory scope is invalid; temporary data are retained');
        $rows[$p[0]]=['type'=>$p[1],'guid'=>$p[2]];
    }
    if(($rows[$pool]['type']??null)!=='filesystem')throw new RuntimeException('ZIP cleanup requires the original pool to be imported and readable');
    ksort($rows,SORT_STRING);return $rows;
}
function zfsmArchiveOwnerPathMissing($path) {
    // Verify absence through an opened/readable parent, never file_exists()
    // alone: permissions, dangling symlinks and inaccessible mounts are unknown.
    $parent='/';
    foreach(explode('/',ltrim($path,'/'))as$part){
        clearstatcache(true,$parent);$s=@lstat($parent);
        if(!$s||($s['mode']&0170000)!==0040000||is_link($parent))return false;
        $next=rtrim($parent,'/').'/'.$part;clearstatcache(true,$next);
        if(@lstat($next)===false){$names=@scandir($parent);return is_array($names)&&!in_array($part,$names,true);}
        $parent=$next;
    }
    return false;
}
function zfsmArchiveReconcileAbsentOwner($job) {
    if(!isset($job['owner_pool_guid']))throw new RuntimeException('This older ZIP job has no recorded pool GUID; inspect its original pool and retained data before reconciling cleanup');
    // Background cleanup may need two full pool inventories; unlike optional
    // GUI usage metadata it has a shared 30-second budget, still fail-closed.
    $deadline=min(microtime(true)+30.0,$GLOBALS['zfsm_inventory_deadline']??INF);
    $io=['deadline'=>$deadline,'tool'=>'zfsmUsageTool','process'=>fn($tool,$args)=>zfsmUsageProcess($tool,$args,$deadline)];
    $pool=explode('/',$job['dataset'],2)[0];$before=zfsmArchiveCleanupInventory($pool,$job['owner_pool_guid'],$io);
    foreach($before as$name=>$row)if($name===$job['dataset']||$row['guid']===$job['owner_guid']||$row['guid']===$job['snapshot_guid'])throw new RuntimeException('ZIP owner or snapshot still exists, possibly renamed; inspect its current location');
    if(!zfsmArchiveOwnerPathMissing($job['owner_mountpoint']))throw new RuntimeException('ZIP retained path still exists or cannot be verified; no files were removed');
    if(zfsmArchiveCleanupInventory($pool,$job['owner_pool_guid'],$io)!==$before||!zfsmArchiveOwnerPathMissing($job['owner_mountpoint']))throw new RuntimeException('ZIP cleanup identity changed during verification; no files were removed');
    // Only reconcile stale bookkeeping. No file removal, hold release, restore
    // or replay is attempted on an absent/foreign filesystem.
    return 'owner_absent';
}
function zfsmCleanupArchive($job) {
    try{$request=zfsmArchiveRequest($job,'archive-cleanup');}
    catch(Throwable$e){return zfsmArchiveReconcileAbsentOwner($job);}
    $answer=zfsmExplorerCall($request);
    if(($answer['removed']??null)!==true)throw new RuntimeException('ZIP cleanup did not confirm removal; temporary data are retained');
    return 'removed';
}
function zfsmQueueRestore($id,$token,$secret,$confirmed) {
    unset($GLOBALS['zfsm_request_restore_context']);
    if($confirmed!=='1')throw new InvalidArgumentException('Review the restore summary and confirm explicitly');
    $file=zfsmRestorePreviewFile($id);
    if(is_link($file)||!is_file($file)||filesize($file)>64*1024*1024)throw new InvalidArgumentException('Restore preview expired; review the selection again');
    $document=json_decode(file_get_contents($file),true,160,JSON_THROW_ON_ERROR);
    if(!is_array($document)||($document['id']??'')!==$id||!is_string($token)||!hash_equals(zfsmRestoreSignature($document,$secret),$token))throw new InvalidArgumentException('Restore preview does not match the reviewed selection');
    zfsmRequestJobRestoreContext($document);
    $queue=zfsmJobDirectory($GLOBALS['plugin_state']).'/restore-queue.lock';if(is_link($queue))throw new RuntimeException('Invalid restore queue lock');
    $lock=fopen($queue,'c');if(!$lock||!flock($lock,LOCK_EX))throw new RuntimeException('Restore queue unavailable');
    try {
        if(is_file(zfsmJobFile($id)))return zfsmReadJob($id); // retry is idempotent
        if(($document['expires']??0)<time())throw new InvalidArgumentException('Restore preview expired; review the selection again');
        $ctx=zfsmExplorerContext($document['context']['snapshot']);
        if($ctx!==$document['context']){
            if($ctx['readonly']!=='off'&&array_replace($ctx,['readonly'=>$document['context']['readonly']??null])===$document['context'])throw new RuntimeException('The restore destination dataset is read-only; review its readonly property');
            throw new RuntimeException('Snapshot or filesystem identity changed; review again');
        }
        $plan=$document['plan'];
        $fresh=zfsmExplorerCall($ctx+['op'=>'plan','selection'=>$plan['selection'],'target'=>$plan['target'],'mode'=>$plan['mode']]);
        if($fresh!==$plan)throw new RuntimeException('Files or conflicts changed since the preview; review again');
        zfsmJobAtomicWrite(zfsmRestoreManifestFile($id),$ctx+['op'=>'restore','id'=>$id,'plan'=>$plan]);
        $job=['schema'=>2,'type'=>'restore','id'=>$id,'state'=>'queued','stage'=>'planned','snapshot'=>$ctx['snapshot'],'snapshot_guid'=>$ctx['snapshot_guid'],'dataset'=>$ctx['dataset'],'owner_guid'=>$ctx['dataset_guid'],'owner_mountpoint'=>$ctx['destination'],'source'=>$ctx['snapshot'],'target'=>$ctx['destination'].($plan['target']===''?'':'/'.$plan['target']),'mode'=>$plan['mode'],'bytes'=>$plan['bytes'],'files'=>$plan['files'],'conflicts'=>count($plan['conflicts']),'staging'=>$ctx['destination'].'/.zfsm-restore-'.$id,'recovery'=>count($plan['conflicts'])?$ctx['destination'].'/.zfsm-restore-'.$id.'/replaced':'','hold_tag'=>'zfsm_restore_'.$id,'hold_owned'=>false,'cancel_requested'=>false,'ack_boot'=>zfsmBootId(),'created'=>gmdate('c'),'updated'=>gmdate('c')];
        $job=zfsmJobInitializeHistory($job);zfsmJobAtomicWrite(zfsmJobFile($id),$job);return $job;
    }finally{flock($lock,LOCK_UN);fclose($lock);}
}
function zfsmCancelRestore($id) {
    return zfsmJobUpdate($id,function($job){
        if(!in_array($job['type']??'',['restore','archive'],true)||($job['schema']??0)!==2)throw new InvalidArgumentException('This is not a file job');
        zfsmValidateFileJobShape($job);
        if(!in_array($job['state'],['queued','running'],true))return [];
        return ['cancel_requested'=>true]+($job['state']==='queued'?['state'=>'cancelled','stage'=>'cancelled_before_copy']:[]);
    });
}
function zfsmReleaseRestoreHold($job) {
    zfsmValidateFileJobShape($job);
    if(empty($job['hold_owned']))return;
    // Match immutable GUID, so a snapshot rename cannot leak our owned hold.
    $r=runProcess('zfs',['list','-H','-p','-d','1','-t','snapshot','-o','name,guid',$job['dataset']]);
    if($r['code']!==0)throw new RuntimeException('Unable to release the restore protection; the job hold is retained');
    $name=null;$guids=[];
    foreach(zfsmParseTable($r['output'],['name','guid'])as$row){
        if(explode('@',$row['name'],2)[0]!==$job['dataset'] || !zfsmValidSnapshotName($row['name']) || isset($guids[$row['guid']]))throw new RuntimeException('Invalid snapshot protection inventory; the job hold is retained');
        $guids[$row['guid']]=true;
        if($row['guid']===$job['snapshot_guid'])$name=$row['name'];
    }
    if($name!==null){
        $holds=runProcess('zfs',['holds','-H',$name]);if($holds['code']!==0)throw new RuntimeException('Unable to inspect restore protection; the job hold is retained');
        $owned=false;$tags=[];$text=rtrim($holds['output'],"\r\n");
        foreach($text===''?[]:preg_split('/\r\n|\r|\n/',$text)as$line){
            $parts=explode("\t",$line);
            if(count($parts)!==3 || $parts[0]!==$name || $parts[1]==='' || $parts[2]==='' || preg_match('/[\x00-\x1F\x7F]/',$parts[1].$parts[2]) || isset($tags[$parts[1]]))throw new RuntimeException('Invalid snapshot hold inventory; the job hold is retained');
            $tags[$parts[1]]=true;
            if($parts[1]===$job['hold_tag'])$owned=true;
        }
        if($owned){$r=runProcess('zfs',['release',$job['hold_tag'],$name]);if($r['code']!==0)throw new RuntimeException('Restore protection could not be released; the job hold is retained');}
    }
    zfsmJobUpdate($job['id'],['hold_owned'=>false]);
}
function zfsmRunRestoreJob($id) {
    $job=zfsmReadJob($id);if(!in_array($job['type']??'',['restore','archive'],true))return;
    if (zfsmJobProblem($job)) return;
    $archive=$job['type']==='archive';
    if(!in_array($job['state'],['queued','running'],true)){
        $pending=!empty($job['hold_owned'])||zfsmArchiveNeedsCleanup($job);$cleanup_error=null;
        if(!empty($job['hold_owned']))try{zfsmReleaseRestoreHold($job);$job=zfsmReadJob($id);}catch(Throwable$e){$cleanup_error=$e->getMessage();}
        if(zfsmArchiveNeedsCleanup($job))try{$resolution=zfsmCleanupArchive($job);$changes=['archive_removed'=>true,'cleanup_resolution'=>$resolution];if($resolution==='owner_absent'){$changes['hold_owned']=false;$cleanup_error=null;}zfsmJobUpdate($id,$changes);}catch(Throwable$e){$cleanup_error=$e->getMessage();}
        if($pending)zfsmJobUpdate($id,['cleanup_retry_after'=>$cleanup_error===null?null:time()+60,'cleanup_error'=>$cleanup_error===null?null:zfsmExplorerShortText($cleanup_error,1900)]);
        return;
    }
    $audit=$job['audit_id']??null;$state='failed';$error=null;$phase=$job['stage'];$attempt_started=false;
    try {
        if($job['state']==='running')throw new RuntimeException($archive?'ZIP preparation was interrupted. Prepare a new archive':'Restore was interrupted. Copied and replaced files are retained; inspect this job before starting a new restore');
        if(!zfsmJobBootApproved($job))throw new RuntimeException('Server restarted after confirmation; create a fresh restore preview');
        if(!empty($job['cancel_requested'])){$state='cancelled';return;}
        $audit=zfsmAuditBegin($archive?'archivesnapshotfiles':'restorefiles',['zdataset'=>$job['dataset'],'snapshot'=>$job['snapshot'],'job_id'=>$id]);
        $job=zfsmJobUpdate($id,['state'=>'running','stage'=>'validating','audit_id'=>$audit,'started_at'=>gmdate('c'),'finished_at'=>null]);
        $attempt_started=true;
        $file=zfsmRestoreManifestFile($id);if(is_link($file)||!is_file($file)||filesize($file)>64*1024*1024)throw new RuntimeException('Restore manifest is unavailable');
        $request=json_decode(file_get_contents($file),true,160,JSON_THROW_ON_ERROR);
        $ctx=zfsmExplorerContext($job['snapshot']);foreach($ctx as$key=>$value)if(($request[$key]??null)!==$value)throw new RuntimeException('Snapshot or destination identity changed; create a fresh restore preview');
        // Journal ownership before creating the hold. Recovery only ever removes
        // this unpredictable, job-specific tag, never another application's hold.
        $job=zfsmJobUpdate($id,['hold_owned'=>true]);
        $r=runProcess('zfs',['hold',$job['hold_tag'],$job['snapshot']]);if($r['code']!==0)throw new RuntimeException('Unable to protect the snapshot during restoration');
        $buffer='';$last=0;$progress=['percent'=>0,'phase'=>'validating'];$finished=false;
        $result=zfsmStreamProcess('/usr/bin/perl',[zfsmExplorerHelper(),'--request-file',$file],function($chunk)use($id,$archive,&$buffer,&$phase,&$progress,&$last,&$finished){
            $buffer.=$chunk;if(strlen($buffer)>131072)throw new RuntimeException('Invalid restore progress');
            while(($at=strpos($buffer,"\n"))!==false){$line=substr($buffer,0,$at);$buffer=substr($buffer,$at+1);$next=json_decode($line,true);if(!is_array($next)||!isset($next['phase']))continue;
                $progress=$next;
                if($next['phase']!==$phase){$phase=$next['phase'];zfsmJobUpdate($id,['stage'=>$phase]);}
                if($phase==='completed'){
                    $finished=true;
                    if($archive)zfsmJobUpdate($id,['archive_identity'=>$next['archive_identity'],'archive_size'=>$next['archive_size'],'expires'=>time()+3600,'bytes'=>$next['total']]);
                }
            }
            if(microtime(true)-$last>=.5){zfsmWriteJobProgress($id,$progress);$last=microtime(true);}
        },function()use($id){return zfsmWorkerStopRequested()||!empty(zfsmReadJob($id)['cancel_requested']);},function()use($id){zfsmJobUpdate($id,['state'=>'running','error'=>'Restore process stopped unexpectedly. Retained files must be inspected before retrying']);});
        if($result['cancelled'])throw new RuntimeException($archive?'ZIP preparation cancelled':'Restore cancelled. Copied and replaced files are retained for inspection');
        if($result['code']!==0||!$finished)throw new RuntimeException(zfsmExplorerError($result['output'],$archive?'ZIP preparation failed; check free space':'Restore did not finish; retained files must be inspected'));
        zfsmWriteJobProgress($id,$progress);$state='completed';
    } catch(Throwable $e){$error=$e->getMessage();$state=$archive?(!empty(zfsmReadJob($id)['cancel_requested'])?'cancelled':'failed'):(($job['state']==='running'||is_dir($job['staging']))?'recovery_required':'failed');}
    finally {
        try{zfsmReleaseRestoreHold(zfsmReadJob($id));}catch(Throwable$e){$error=($error?$error.' ':'').$e->getMessage();$state='recovery_required';zfsmJobUpdate($id,['cleanup_retry_after'=>time()+60]);}
        zfsmJobUpdate($id,['state'=>$state,'stage'=>$state==='completed'?'completed':$phase,'finished_at'=>$attempt_started?gmdate('c'):null,'error'=>$error]);
        if($audit)try{zfsmAuditFinish($audit,['status'=>$state==='completed'?'succeeded':($state==='recovery_required'?'recovery_required':'failed'),'succeeded'=>$state==='completed'?[$job['target']]:[],'details'=>['stage'=>$phase]]);}catch(Throwable$e){zfsmJobUpdate($id,['state'=>'recovery_required','error'=>'Files may be restored, but the final history record failed. Inspect actual state']);}
    }
}
