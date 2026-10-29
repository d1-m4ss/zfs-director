<?php
// New conversions are separate from the legacy path-based runner. The rejected
// detached-fd/schema3 implementation is never loaded or migrated automatically.
function zfsmConfinedStagingPath($id) {
    return ($GLOBALS['plugin_conversion_runtime']??'/var/tmp/zfs.master.ui/conversions').'/'.zfsmJobId($id);
}
function zfsmConversionRequireWritableOwner($dataset) {
    // Query the effective value, including inheritance; property sources and
    // inventory metadata cannot establish whether a new child will be writable.
    $result=runProcess('zfs',['get','-H','-o','value','readonly',$dataset]);
    $value=trim($result['output']??'');
    if (($result['code']??1)!==0||!in_array($value,['on','off'],true)) throw new RuntimeException('Unable to verify the conversion parent filesystem readonly property; conversion requires a writable parent.');
    if ($value==='on') throw new RuntimeException('Conversion parent filesystem is read-only (readonly=on, including inherited settings). Review its readonly property before retrying; the original directory is retained.');
}
function zfsmConversionRecoveryPath($source,$id,$collision=false) {
    zfsmJobId($id);
    $suffix='_archived_'.substr($id,0,15).($collision?'-'.substr($id,16):'');
    // ZFS directory entries allow 255 bytes. Leave room for the complete
    // timestamp and collision identity even when the source name fills NAME_MAX.
    $name=basename($source);$stem=substr($name,0,255-strlen($suffix));
    if (preg_match('//u',$name)===1) while (preg_match('//u',$stem)!==1) $stem=substr($stem,0,-1);
    return dirname($source).'/'.$stem.$suffix;
}
function zfsmConversionRecoveryMatches($job) {
    $source=$job['source']??null;$id=$job['id']??null;$recovery=$job['recovery']??null;
    if (!is_string($source)||!is_string($id)||!is_string($recovery)) return false;
    // Retain compatibility with existing journals; never rename their data.
    return $recovery===$source.'_zfsm_recovery_'.$id||$recovery===zfsmConversionRecoveryPath($source,$id)||$recovery===zfsmConversionRecoveryPath($source,$id,true);
}
function zfsmValidateConfinedJobShape($job) {
    $stages=['planned','preparing','target_created','copying','copy_verified','claiming','source_retained','reserving','reserved','mountpoint_pending','publishing','published','complete_source_retained'];
    if (($job['method']??'')!=='confined-v1'||($job['schema']??null)!==1||!in_array($job['stage']??null,$stages,true)||($job['staging']??null)!==zfsmConfinedStagingPath($job['id']??'')) throw new RuntimeException('Confined conversion journal requires manual inspection');
    if (!zfsmValidPoolName($job['pool']??'')||!zfsmValidDatasetName($job['owner_dataset']??'')||!zfsmValidDatasetName($job['dataset']??'')||($job['dataset']??'')!==$job['owner_dataset'].'/'.basename($job['source']??'')||dirname($job['source']??'')!==($job['owner_mountpoint']??'')||($job['owner_mountpoint']??'')==='/'||!zfsmConversionRecoveryMatches($job)||explode('/',$job['owner_dataset'],2)[0]!==$job['pool']) throw new RuntimeException('Confined conversion scope changed; manual inspection required');
}
function zfsmConfinedCanResume($job) {
    return ($job['method']??null)!=='confined-v1'||in_array($job['stage']??'',['planned','published'],true);
}
function zfsmConfinedPreflight($review) {
    if (!is_array($review)||!is_string($review['root']??null)||!is_array($review['root_identity']??null)) throw new RuntimeException('Conversion requires a verified owner filesystem before capability checks');
    $directory=zfsmDirectoryCommand(['op'=>'probe']+array_intersect_key($review,['root'=>true,'root_identity'=>true]));
    if (($directory['ok']??false)!==true) throw new RuntimeException($directory['error']??'Required directory boundary is unavailable');
    $result=runProcess('/usr/bin/perl',[dirname(__DIR__).'/scripts/zfsm-publish.pl'],"{\"op\":\"probe\"}\n");
    $probe=json_decode($result['output']??'',true);
    if (($result['code']??1)!==0||($probe['ok']??false)!==true||($probe['phase']??'')!=='probe') throw new RuntimeException('Required pinned-mount API is unavailable; no directory conversion was queued');
}

function zfsmConfinedOwner($job) {
    $owner=zfsmFilesystemMounts()[$job['owner_dataset']]??null;
    if (!$owner||$owner['mounted']!=='yes'||$owner['mountpoint']!==$job['owner_mountpoint']||!zfsmLiveZfsMount($job['owner_mountpoint'],$job['owner_dataset'],zfsmMountInfo())) throw new RuntimeException('Conversion owner filesystem or live mount changed');
    zfsmRequireIdentity($job['owner_dataset'],$job['owner_guid']);
    return ['path'=>$job['owner_mountpoint']]+zfsmDirectoryIdentity($job['owner_mountpoint']);
}

function zfsmConfinedSource($job,$path) {
    $source=zfsmResolveDirectory($path,true);
    if (!$source||$source['path']!==$path||$source['dataset']!==$job['owner_dataset']) throw new RuntimeException('Original directory is no longer inside its owner filesystem');
    $identity=zfsmDirectoryIdentity($path);
    if (($identity['ino']??null)!==($job['source_identity']['ino']??null)) throw new RuntimeException('Original directory identity changed; manual inspection required');
    return ['path'=>$path]+$identity;
}

function zfsmConfinedTarget($job,$path,$mounted=true,$allow_on=false) {
    $r=runProcess('zfs',['get','-H','-o','property,value','guid,zfs.master.ui:conversion-job,mountpoint,mounted,canmount',$job['dataset']]);
    if (($r['code']??1)!==0) throw new RuntimeException('Unable to inspect confined conversion target');
    $state=[];
    foreach (explode("\n",trim($r['output']??'')) as $line) {
        $parts=explode("\t",$line);
        if (count($parts)!==2||isset($state[$parts[0]])) throw new RuntimeException('Malformed conversion target properties');
        $state[$parts[0]]=$parts[1];
    }
    if (!preg_match('/^[1-9][0-9]*$/D',$state['guid']??'')||($state['zfs.master.ui:conversion-job']??null)!==$job['id']||($state['mountpoint']??null)!==$path||($state['mounted']??null)!==($mounted?'yes':'no')||!in_array($state['canmount']??null,$allow_on?['noauto','on']:['noauto'],true)||isset($job['target_guid'])&&$state['guid']!==$job['target_guid']) throw new RuntimeException('Confined target GUID, ownership, mountpoint or activation changed');
    if ($mounted&&!zfsmLiveZfsMount($path,$job['dataset'],zfsmMountInfo())) throw new RuntimeException('Confined target live mount differs from its recorded properties');
    return $state;
}

function zfsmConfinedStageDirectory($job) {
    $path=$job['staging'];$current='';
    foreach (explode('/',ltrim($path,'/')) as $part) {
        $current.='/'.$part;clearstatcache(true,$current);$s=@lstat($current);
        if (!$s) { if (!@mkdir($current,0700)) throw new RuntimeException('Unable to create private conversion staging');$s=lstat($current); }
        if (!$s||($s['mode']&0170000)!==0040000||$s['uid']!==0||($s['mode']&0022)!==0&&($s['mode']&01000)===0||is_link($current)) throw new RuntimeException('Conversion staging ancestor is not protected');
    }
    if (($s['mode']&07777)!==0700||scandir($path)!==['.','..']) throw new RuntimeException('Conversion staging already exists or is not private and empty; inspect retained data');
    if (!mkdir($path.'/target',0700)) throw new RuntimeException('Unable to create private target mountpoint');
}

function zfsmConfinedCheckCancelled($id) {
    if (zfsmWorkerStopRequested()||zfsmJobCancelRequested($id)) throw new RuntimeException('Conversion interrupted or cancelled; original and partial target retained for inspection');
}

function zfsmConfinedCopy($job,$source,$operation='copy') {
    $request=['op'=>$operation,'source'=>zfsmConfinedSource($job,$source),'target'=>['path'=>$job['staging'].'/target']+zfsmDirectoryIdentity($job['staging'].'/target'),'staging'=>['path'=>$job['staging']]+zfsmDirectoryIdentity($job['staging'])];
    $last=null;$buffer='';
    $consume=function($chunk)use(&$last,&$buffer,$job){
        $buffer.=$chunk;
        if (strlen($buffer)>131072) throw new RuntimeException('Unexpected confined copy response size');
        while (($end=strpos($buffer,"\n"))!==false) {
            $line=substr($buffer,0,$end);$buffer=substr($buffer,$end+1);$row=json_decode($line,true);
            if (!is_array($row)) throw new RuntimeException('Invalid confined copy response');
            $last=$row;
            if (isset($row['percent'])&&is_numeric($row['percent'])) zfsmWriteJobProgress($job['id'],['stage'=>$row['phase']??'copying','percent'=>max(0,min(99,(int)$row['percent'])),'bytes'=>max(0,(int)($row['bytes']??0))]);
        }
    };
    $cancel=fn()=>zfsmWorkerStopRequested()||zfsmJobCancelRequested($job['id']);
    $r=zfsmStreamProcess('/usr/bin/perl',[dirname(__DIR__).'/scripts/zfsm-copy-confined.pl'],$consume,$cancel,null,json_encode($request,JSON_THROW_ON_ERROR));
    if ($buffer!=='') $consume("\n");
    if (($r['cancelled']??false)||($r['code']??1)!==0||($last['ok']??false)!==true||($last['phase']??'')!=='completed'||!preg_match('/^[a-f0-9]{64}$/D',$last['manifest_sha256']??'')) throw new RuntimeException(is_string($last['error']??null)?substr($last['error'],0,4096):'Confined copy did not return verified completion; originals retained');
    return $last;
}

function zfsmConfinedPublish($job,$prepared,$reserved) {
    $owner=zfsmConfinedOwner($job);$source=zfsmConfinedSource($job,$job['source']);
    $request=['op'=>'publish','root'=>$owner['path'],'root_identity'=>array_intersect_key($owner,['dev'=>true,'ino'=>true]),'path'=>basename($job['source']),'identity'=>array_intersect_key($source,['dev'=>true,'ino'=>true]),'recovery'=>basename($job['recovery']),'target'=>$job['staging'].'/target','target_identity'=>zfsmDirectoryIdentity($job['staging'].'/target'),'id'=>$job['id']];
    $spec=[0=>['pipe','r'],1=>['pipe','w'],2=>['redirect',1]];
    if (is_resource($GLOBALS['zfsm_operation_lock_handle']??null)) $spec[3]=$GLOBALS['zfsm_operation_lock_handle'];
    $process=proc_open(['/usr/bin/perl',dirname(__DIR__).'/scripts/zfsm-publish.pl'],$spec,$pipes,null,null,['bypass_shell'=>true]);
    if (!is_resource($process)) throw new RuntimeException('Unable to start pinned mount publication');
    $done=false;
    $send=function($row)use(&$pipes){$line=json_encode($row,JSON_THROW_ON_ERROR)."\n";if (fwrite($pipes[0],$line)!==strlen($line)||!fflush($pipes[0])) throw new RuntimeException('Publication input failed; retained objects require inspection');};
    stream_set_blocking($pipes[1],false);$buffer='';
    $read=function($phase)use(&$pipes,&$buffer,$job,$request){
        $deadline=microtime(true)+15;
        while (true) {
            zfsmConfinedCheckCancelled($job['id']);
            if (($end=strpos($buffer,"\n"))!==false) {
                $line=substr($buffer,0,$end);$buffer=substr($buffer,$end+1);$row=json_decode($line,true);
                if (!is_array($row)||($row['ok']??false)!==true||($row['phase']??'')!==$phase||($row['id']??null)!==$job['id']) throw new RuntimeException(is_string($row['error']??null)?substr($row['error'],0,4096):'Unexpected publication response; retained objects require inspection');
                if (in_array($phase,['prepared','published'],true)&&($row['identity']??null)!==$request['target_identity']) throw new RuntimeException('Publisher target identity changed');
                return $row;
            }
            if (microtime(true)>$deadline||feof($pipes[1])) throw new RuntimeException('Publication channel interrupted; retained objects require inspection');
            $select=[$pipes[1]];$write=null;$except=null;
            if (stream_select($select,$write,$except,0,200000)>0) {$chunk=fread($pipes[1],32768);if ($chunk===false) throw new RuntimeException('Publication output failed');$buffer.=$chunk;if (strlen($buffer)>65536) throw new RuntimeException('Publication response too large');}
        }
    };
    try {
        $send($request);$read('prepared');$claim=$prepared();
        $send(['action'=>'reserve','claim'=>['path'=>$claim['location']]+$claim['identity']]);
        $reservation=$read('reserved');$reserved($reservation);
        $send(['action'=>'publish']);$publication=$read('published');
        fclose($pipes[0]);unset($pipes[0]);fclose($pipes[1]);unset($pipes[1]);
        $status=proc_close($process);$process=null;if ($status!==0) throw new RuntimeException('Publication helper failed after reporting its mount; inspect retained data');
        $done=true;return $publication;
    } finally {
        foreach ($pipes as $pipe) if (is_resource($pipe)) fclose($pipe);
        if (is_resource($process)) {if (!$done) proc_terminate($process,15);proc_close($process);}
    }
}

// Explicit recovery for a verified copy whose publication never happened. It
// requires the original path to be free, so it can never cover live data.
function zfsmPublishConversion($id) {
    $job=zfsmReadJob($id);
    if (zfsmJobProblem($job)||($job['method']??null)!=='confined-v1'||($job['state']??null)!=='recovery_required') throw new InvalidArgumentException('Only a confined conversion that requires recovery can be published');
    zfsmValidateConfinedJobShape($job);
    if (!preg_match('/^[a-f0-9]{64}$/D',$job['copy_manifest_sha256']??'')||!is_string($job['target_guid']??null)) throw new InvalidArgumentException('The target copy was never verified; inspect it manually');
    $free=function()use($job){clearstatcache(true,$job['source']);if (file_exists($job['source'])||is_link($job['source'])) throw new InvalidArgumentException('The original path is occupied; move or inspect the retained original before publishing');};
    $free();zfsmConfinedOwner($job);
    $staging=$job['staging'].'/target';
    $mounted=runProcess('zfs',['get','-H','-o','value','mounted',$job['dataset']]);
    $mounted=trim($mounted['output']??'')==='yes';
    zfsmConfinedTarget($job,$staging,$mounted);
    if ($mounted&&(runProcess('zfs',['unmount',$job['dataset']])['code']??1)!==0) throw new RuntimeException('Private target could not be unmounted; no force/lazy unmount attempted');
    if ((runProcess('zfs',['set','-u','mountpoint='.$job['source'],$job['dataset']])['code']??1)!==0) throw new RuntimeException('Target mountpoint update failed; target retained unmounted');
    zfsmConfinedTarget($job,$job['source'],false);
    if ((runProcess('zfs',['set','-u','canmount=on',$job['dataset']])['code']??1)!==0) throw new RuntimeException('Target activation failed; target retained unmounted');
    $free();
    if ((runProcess('zfs',['mount',$job['dataset']])['code']??1)!==0) throw new RuntimeException('Published target mount failed; target retained unmounted at its final mountpoint');
    zfsmConfinedTarget($job,$job['source'],true,true);
    foreach ([$staging,$job['staging']] as $dir) @rmdir($dir);
    $job=zfsmJobUpdate($id,['stage'=>'complete_source_retained','state'=>'completed','finished_at'=>gmdate('c'),'error'=>null]);
    refreshData();return $job;
}

function zfsmRunConfinedConversionJob($id) {
    $job=zfsmReadJob($id);$audit=null;$owned=null;
    if (!in_array($job['state']??'',['queued','running'],true)) return $job;
    if (!is_resource($GLOBALS['zfsm_operation_lock_handle']??null)) {$owned=zfsmAcquireOperationLock($GLOBALS['plugin_lock']);$GLOBALS['zfsm_operation_lock_handle']=$owned;}
    try {
        zfsmValidateConfinedJobShape($job);
        if ($job['state']==='running'||!zfsmJobBootApproved($job)||!zfsmConfinedCanResume($job)) throw new RuntimeException('Conversion was interrupted; inspect retained data. Destructive stages are not retried automatically');
        zfsmConfinedCheckCancelled($id);$owner=zfsmConfinedOwner($job);
        if ($job['stage']==='planned') zfsmConversionRequireWritableOwner($job['owner_dataset']);
        $audit=zfsmAuditBegin('conversion',['job_id'=>$id,'directory'=>$job['source'],'zdataset'=>$job['dataset'],'method'=>'confined-v1']);
        $job=zfsmJobUpdate($id,['state'=>'running','started_at'=>gmdate('c'),'finished_at'=>null]);
        if ($job['stage']==='planned') {
            zfsmConfinedPreflight(['root'=>$owner['path'],'root_identity'=>array_intersect_key($owner,['dev'=>true,'ino'=>true])]);zfsmConfinedSource($job,$job['source']);
            if (zfsmDatasetExists($job['dataset'],'filesystem')) throw new RuntimeException('Target dataset already exists; no creation or retry attempted');
            $job=zfsmConversionStage($id,'preparing');zfsmConfinedStageDirectory($job);zfsmConfinedCheckCancelled($id);
            // Re-read under the operation lock immediately before native ZFS
            // creation, independently of queue-time and capability checks.
            zfsmConfinedOwner($job);zfsmConfinedSource($job,$job['source']);zfsmConversionRequireWritableOwner($job['owner_dataset']);
            $created=runProcess('zfs',['create','-u','-o','canmount=noauto','-o','mountpoint='.$job['staging'].'/target','-o','zfs.master.ui:conversion-job='.$id,'-o','sharenfs=off','-o','sharesmb=off',$job['dataset']]);
            if (($created['code']??1)!==0) throw new RuntimeException('Target creation failed; original directory retained');
            $state=zfsmConfinedTarget($job,$job['staging'].'/target',false);
            $job=zfsmJobUpdate($id,['target_guid'=>$state['guid']]);
            if ((runProcess('zfs',['mount',$job['dataset']])['code']??1)!==0) throw new RuntimeException('Private target mount failed; original directory retained');
            zfsmConfinedTarget($job,$job['staging'].'/target');$job=zfsmConversionStage($id,'target_created');
            $job=zfsmConversionStage($id,'copying');zfsmWriteJobProgress($id,['stage'=>'copying','percent'=>0,'bytes'=>0]);
            $copy=zfsmConfinedCopy($job,$job['source']);$job=zfsmJobUpdate($id,['copy_manifest_sha256'=>$copy['manifest_sha256']]);
            $job=zfsmConversionStage($id,'copy_verified');zfsmConfinedCheckCancelled($id);
            zfsmConfinedTarget($job,$job['staging'].'/target');
            zfsmConfinedPublish($job,function()use(&$job,$id){
                zfsmConfinedCheckCancelled($id);$owner=zfsmConfinedOwner($job);$source=zfsmConfinedSource($job,$job['source']);
                $job=zfsmConversionStage($id,'claiming');
                $request=['op'=>'claim','root'=>$owner['path'],'root_identity'=>array_intersect_key($owner,['dev'=>true,'ino'=>true]),'path'=>basename($job['source']),'identity'=>array_intersect_key($source,['dev'=>true,'ino'=>true]),'destination'=>basename($job['recovery'])];
                $claimed=zfsmDirectoryCommand($request);
                if (($claimed['ok']??false)!==true) {zfsmJobUpdate($id,['mutation_recovery'=>$claimed['recovery']??null]);throw new RuntimeException($claimed['error']??'Original directory claim failed; inspect retained objects');}
                $job=zfsmJobUpdate($id,['mutation_recovery'=>$claimed['recovery']]);$job=zfsmConversionStage($id,'source_retained');
                // Re-verify AFTER claiming the original, before reserving/mounting.
                $verified=zfsmConfinedCopy($job,$job['recovery'],'verify');
                if ($verified['manifest_sha256']!==$job['copy_manifest_sha256']) throw new RuntimeException('Original changed after copy; retained source and target require inspection');
                $job=zfsmConversionStage($id,'reserving');return $claimed['recovery'];
            },function($reservation)use(&$job,$id){
                $job=zfsmJobUpdate($id,['placeholder_identity'=>$reservation['placeholder_identity']??null]);$job=zfsmConversionStage($id,'reserved');
                zfsmConfinedCheckCancelled($id);zfsmConfinedTarget($job,$job['staging'].'/target');
                $job=zfsmConversionStage($id,'mountpoint_pending');
                if ((runProcess('zfs',['unmount',$job['dataset']])['code']??1)!==0) throw new RuntimeException('Private target could not be unmounted; no force/lazy unmount attempted');
                zfsmConfinedTarget($job,$job['staging'].'/target',false);
                if ((runProcess('zfs',['set','-u','mountpoint='.$job['source'],$job['dataset']])['code']??1)!==0) throw new RuntimeException('Target mountpoint update failed; original and target retained');
                zfsmConfinedTarget($job,$job['source'],false);$job=zfsmConversionStage($id,'publishing');
            });
            $job=zfsmConversionStage($id,'published');
        }
        // Published-only explicit Resume performs no copy, claim or mount retry.
        zfsmConfinedCheckCancelled($id);zfsmConfinedOwner($job);zfsmConfinedSource($job,$job['recovery']);
        zfsmConfinedTarget($job,$job['source'],true,true);
        if ((runProcess('zfs',['set','-u','canmount=on',$job['dataset']])['code']??1)!==0) throw new RuntimeException('Published filesystem retained with noauto; activation needs inspection');
        $activated=zfsmConfinedTarget($job,$job['source'],true,true);
        if ($activated['canmount']!=='on') throw new RuntimeException('Published filesystem activation was not applied; noauto target retained for inspection');
        $job=zfsmJobUpdate($id,['stage'=>'complete_source_retained','state'=>'completed','finished_at'=>gmdate('c'),'error'=>null]);
        zfsmWriteJobProgress($id,['stage'=>'completed','percent'=>100]);zfsmAuditFinish($audit,['status'=>'succeeded']);$audit=null;refreshData();return $job;
    } catch (Throwable $error) {
        $job=zfsmJobUpdate($id,['state'=>'recovery_required','finished_at'=>gmdate('c'),'error'=>substr($error->getMessage(),0,4096)]);
        if ($audit!==null) {try{zfsmAuditFinish($audit,['status'=>'recovery_required','reason'=>'command_failed','details'=>['stage'=>$job['stage']??'unknown']]);}catch(Throwable $ignored){zfsmJobUpdate($id,['audit_error'=>'Unable to record conversion outcome']);}}
        return $job;
    } finally {if(is_resource($owned)){unset($GLOBALS['zfsm_operation_lock_handle']);flock($owned,LOCK_UN);fclose($owned);}}
}
