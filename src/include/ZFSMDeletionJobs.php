<?php
// One-shot destructive jobs. A fresh GUI review is required for every retry.
function zfsmDeletionError($text) {
    foreach ([
        'dependencies'=>['/configured service references|additional mounts|live filesystem references/i','Deletion is blocked by service references or mounts. Review Usage & Dependencies and release them through their owner.'],
        'lock_busy'=>['/operation lock|Another operation|lock queue/i','Another operation is running. Wait for it to finish, refresh the target and submit a new request.'],
        'destructive_mode'=>['/Destructive Mode/i','Destructive Mode is disabled. Enable it in Settings, then review and submit a new request.'],
        'identity_changed'=>['/identity|GUID|replaced|original dataset|no longer available/i','The target identity changed or could not be verified. Refresh the inventory and review the target again.'],
        'preview_changed'=>['/preview|dependencies changed|holds|dry run/i','The deletion preview expired, changed or is blocked. Load a fresh preview and review its objects and dependencies.'],
        'protected'=>['/protected|service directory|pool root/i','This target contains protected data. Inspect its recovery or protection information; ordinary deletion is refused.'],
    ] as $code=>[$pattern,$message]) if (preg_match($pattern,$text)) return [$code,$message];
    return ['preflight_failed','Deletion was not started. Review the target, permissions and Administrative History, then submit a fresh request.'];
}
function zfsmRecordRejectedDeletion($kind,$source,$failed,$audit_id) {
    if (!in_array($kind,['directory','dataset'],true)||!is_string($source)||strlen($source)>4096||preg_match('/[\x00-\x1f\x7f]/',$source)||($kind==='dataset'?!zfsmValidDatasetName($source):!str_starts_with($source,'/mnt/'))) return null;
    [$code,$message]=zfsmDeletionError(implode("\n",array_filter($failed,'is_string')));
    $now=gmdate('c');$id=gmdate('Ymd-His').'-'.bin2hex(random_bytes(6));
    $job=zfsmJobInitializeHistory(['schema'=>6,'type'=>'deletion','kind'=>$kind,'id'=>$id,'source'=>$source,'rejected'=>true,'state'=>'failed','stage'=>'preflight_rejected','created'=>$now,'updated'=>$now,'started_at'=>null,'finished_at'=>$now,'error_code'=>$code,'error'=>$message,'audit_id'=>$audit_id]);
    zfsmJobAtomicWrite(zfsmJobFile($id),$job);return $job;
}
function zfsmValidateDeletionJob($job) {
    if (($job['schema']??null)!==6||($job['type']??null)!=='deletion'||!in_array($job['kind']??null,['directory','dataset'],true)||!is_bool($job['rejected']??null)||!is_string($job['source']??null)||strlen($job['source'])>4096||preg_match('/[\x00-\x1f\x7f]/',$job['source'])) throw new RuntimeException('Invalid deletion journal; execution is disabled');
    if ($job['rejected']) {
        $allowed=['schema','type','kind','id','source','rejected','state','stage','created','updated','started_at','finished_at','error_code','error','audit_id','stage_history','stage_history_complete','stage_history_dropped'];
        if ($job['state']!=='failed'||($job['stage']??null)!=='preflight_rejected'||array_diff(array_keys($job),$allowed)) throw new RuntimeException('Rejected deletion records cannot execute');
        return;
    }
    if (!is_string($job['ack_boot']??null)||!is_string($job['owner_guid']??null)||!preg_match('/^[1-9][0-9]*$/D',$job['owner_guid'])||!is_bool($job['recursive']??null)||!in_array($job['stage']??null,['planned','validating','scanning','deleting','verifying','completed','interrupted','preflight_failed'],true)) throw new RuntimeException('Deletion authorization evidence is missing');
    if ($job['kind']==='dataset') {
        $scope=$job['scope']??null;
        if (!zfsmValidDatasetName($job['source'])||!str_contains($job['source'],'/')||!is_array($scope)||($scope['target']??null)!==$job['source']||($scope['recursive']??null)!==$job['recursive']||($scope['can_destroy']??null)!==true||!is_array($scope['objects']??null)||!$scope['objects']||!empty($scope['dependencies'])) throw new RuntimeException('Invalid reviewed deletion scope');
        $found=false;$seen=[];
        foreach ($scope['objects'] as $row) {
            $name=$row['name']??'';$owner=explode('@',$name,2)[0];
            if ((!zfsmValidDatasetName($name)&&!zfsmValidSnapshotName($name))||!is_string($row['guid']??null)||!preg_match('/^[1-9][0-9]*$/D',$row['guid'])||isset($seen[$name])||($name!==$job['source']&&(!$job['recursive']||($owner!==$job['source']&&!str_starts_with($owner,$job['source'].'/'))))) throw new RuntimeException('Deletion scope contains an unreviewed object');
            $seen[$name]=true;if($name===$job['source']&&$row['guid']===$job['owner_guid'])$found=true;
        }
        if (!$found) throw new RuntimeException('Deletion target GUID is missing');
    } else {
        $r=$job['request']??null;
        if (!zfsmValidDatasetName($job['owner_dataset']??'')||!is_array($r)||($r['op']??null)!=='delete'||($r['recursive']??null)!==$job['recursive']||!is_string($r['root']??null)||$r['root']==='/'||!str_starts_with($r['root'],'/')||!is_string($r['path']??null)||$r['path']===''||$job['source']!==$r['root'].'/'.$r['path']||preg_match('~(?:^|/)(?:\.{1,2}|\.zfs|\.zfsm-[^/]*)(?:/|$)~',$r['path'])) throw new RuntimeException('Invalid confined deletion request');
        foreach (['identity','root_identity'] as $key) foreach (['dev','ino'] as $field) if (!is_string($r[$key][$field]??null)||!preg_match('/^[0-9]+$/D',$r[$key][$field])) throw new RuntimeException('Deletion directory identity is missing');
    }
}
function zfsmQueueDeletion($kind,$source,$recursive,$scope=null) {
    $recursive=zfsmDestroyChoice($recursive);$now=gmdate('c');$id=gmdate('Ymd-His').'-'.bin2hex(random_bytes(6));
    $job=['schema'=>6,'type'=>'deletion','kind'=>$kind,'id'=>$id,'source'=>$source,'rejected'=>false,'recursive'=>$recursive,'state'=>'queued','stage'=>'planned','ack_boot'=>zfsmBootId(),'created'=>$now,'updated'=>$now,'started_at'=>null,'finished_at'=>null,'error'=>null];
    if ($kind==='dataset') {
        $job['scope']=$scope;$job['owner_guid']=zfsmReadIdentity($source)['guid'];
    } elseif ($kind==='directory') {
        $resolved=zfsmResolveDirectory($source,true);
        if (!$resolved||$resolved['path']!==$source) throw new RuntimeException('Directory is no longer available in its original dataset');
        $job['request']=zfsmDirectoryRequest('delete',$resolved,['recursive'=>$recursive]);
        $job['owner_dataset']=$resolved['dataset'];$job['owner_guid']=zfsmReadIdentity($resolved['dataset'])['guid'];
    }
    zfsmValidateDeletionJob($job);$job=zfsmJobInitializeHistory($job);
    // Job readers are bounded too. Do not publish a journal they cannot read.
    if (strlen(json_encode($job,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR))>100000) throw new RuntimeException('Deletion scope is too large for a safe job journal; select a smaller reviewed subtree');
    $queue=zfsmJobDirectory($GLOBALS['plugin_state']).'/queue.lock';
    if (is_link($queue)) throw new RuntimeException('Invalid queue lock');
    $lock=@fopen($queue,'c');if(!$lock||!flock($lock,LOCK_EX))throw new RuntimeException('Unable to lock queue');
    try {
        foreach(zfsmPendingJobs() as $existing) if (($existing['source']??null)===$source) throw new RuntimeException('Another operation for this target is already queued or running');
        $GLOBALS['zfsm_deletion_journal_started']=true;
        zfsmJobAtomicWrite(zfsmJobFile($id),$job);
        $answer=['succeeded'=>[$source=>'Deletion queued. Follow progress and the verified result in Jobs.'],'failed'=>[],'job'=>$job];
        try{zfsmStartWorker();}catch(Throwable$error){$answer['worker_warning']='Deletion is queued, but the background worker could not start. No deletion has been confirmed. Check worker status before submitting another request.';}
        return $answer;
    } finally {flock($lock,LOCK_UN);fclose($lock);}
}
function zfsmDeletionStage($id,$stage) {
    zfsmAuditEvent('deletion',['job_id'=>$id,'stage'=>$stage],'running');
    zfsmWriteJobProgress($id,['stage'=>$stage]);
    return zfsmJobUpdate($id,['stage'=>$stage]);
}
function zfsmRunDeletionJob($id) {
    $owned=null;$audit=null;$attempted=false;
    if (!is_resource($GLOBALS['zfsm_operation_lock_handle']??null)) {$owned=zfsmAcquireOperationLock($GLOBALS['plugin_lock']);$GLOBALS['zfsm_operation_lock_handle']=$owned;}
    try {
        $job=zfsmReadJob($id);zfsmValidateDeletionJob($job);
        if ($job['rejected']||!in_array($job['state'],['queued','running'],true)) return $job;
        if ($job['state']==='running'||!zfsmJobBootApproved($job)) return zfsmJobUpdate($id,['state'=>'recovery_required','stage'=>'interrupted','finished_at'=>gmdate('c'),'error'=>'Deletion was interrupted or the system restarted. Inspect the target and any retained recovery data. No automatic retry or Resume is allowed; submit a fresh reviewed request.']);
        $audit=zfsmAuditBegin('deletion',['job_id'=>$id,'source'=>$job['source'],'kind'=>$job['kind']]);
        $job=zfsmJobUpdate($id,['state'=>'running','stage'=>'validating','started_at'=>gmdate('c')]);
        $config=loadConfig(parse_plugin_cfg($GLOBALS['plugin'],true));
        if ((int)$config['destructive_mode']!==1) throw new RuntimeException('Destructive Mode is disabled');
        $command=$job['kind']==='dataset'?'destroydataset':'deletedirectory';
        $fields=$job['kind']==='dataset'?['zdataset'=>$job['source'],'expected_guid'=>$job['owner_guid']]:['directory'=>$job['source'],'expected_guid'=>$job['owner_guid'],'directory_identity'=>$job['request']['identity']];
        zfsmGuardMutationIdentity($command,$fields);
        if ($job['kind']==='dataset') {
            $fresh=zfsmDestroyScope($job['source'],$job['recursive']);
            if ($fresh!==$job['scope']) throw new RuntimeException('Deletion preview identity or dependencies changed');
            $diagnostics=zfsmDestroyBusyDiagnostics($fresh['objects']);
            if ($diagnostics['blocked']) throw new RuntimeException('Deletion blocked by live filesystem references');
            $job=zfsmDeletionStage($id,'deleting');$attempted=true;
            $args=['destroy','-v'];if($job['recursive'])array_push($args,'-r','-f');$args[]=$job['source'];
            $native=zfsmStreamProcess('zfs',$args,static function($chunk){},static fn()=>false);
            $job=zfsmDeletionStage($id,'verifying');
            $answer=zfsmDestroyCommandResult($job['source'],$native,$fresh);
            $result=$answer['destruction'];$result['summary']=count($result['removed']).' reviewed object(s) deleted; '.count($result['remaining']).' remain; '.count($result['changed']).' changed identity.';
            // The exact approved scope stays in the journal. Bound final detail
            // so a large native plan cannot make that journal unreadable.
            unset($result['plan_output']);$result['errors']=substr(implode("\n",$result['errors']),0,4096);
            foreach(['removed','remaining','changed']as$key){$result[$key.'_count']=count($result[$key]);$result[$key]=array_slice($result[$key],0,3);}
            $failure=$answer['failed']?substr(implode("\n",$answer['failed']),0,4096):null;
        } else {
            $resolved=zfsmResolveDirectory($job['source'],true);
            if (!$resolved||$resolved['dataset']!==$job['owner_dataset']||zfsmDirectoryRequest('delete',$resolved,['recursive'=>$job['recursive']])!==$job['request']) throw new RuntimeException('Directory identity or mount changed');
            $job=zfsmDeletionStage($id,'scanning');$buffer='';$last=null;$lastProgress=0;
            $chunk=function($text)use($id,&$buffer,&$last,&$lastProgress){
                $buffer.=$text;
                if (strlen($buffer)>65536) throw new RuntimeException('Directory helper returned an oversized record');
                while(($end=strpos($buffer,"\n"))!==false){$line=substr($buffer,0,$end);$buffer=substr($buffer,$end+1);$row=json_decode($line,true);if(!is_array($row))continue;$last=$row;
                    if(($row['phase']??null)==='prepared'&&is_array($row['recovery']??null)){zfsmJobUpdate($id,['recovery'=>$row['recovery']]);zfsmDeletionStage($id,'deleting');}
                    if (($row['phase']??null)==='deleting'&&is_int($row['removed']??null)&&is_int($row['total']??null)&&$row['total']>0&&$row['removed']>=0&&$row['removed']<=$row['total']&&(microtime(true)-$lastProgress>=0.5||$row['removed']===$row['total'])){zfsmWriteJobProgress($id,['stage'=>'deleting','removed'=>$row['removed'],'total'=>$row['total'],'percent'=>(int)floor(100*$row['removed']/$row['total'])]);$lastProgress=microtime(true);}
                }
            };
            // Intent is durable before the helper can capture or unlink data.
            $attempted=true;
            $native=zfsmStreamProcess('/usr/bin/perl',[dirname(__DIR__).'/scripts/zfsm-directory.pl'],$chunk,static fn()=>false,null,json_encode($job['request'],JSON_THROW_ON_ERROR));
            $chunk("\n");$job=zfsmDeletionStage($id,'verifying');
            clearstatcache(true,$job['source']);
            $verified=($native['code']??1)===0&&($last['ok']??false)===true&&($last['op']??null)==='delete'&&@lstat($job['source'])===false;
            $result=['exit_code'=>$native['code']??null,'state_verified'=>$verified,'recovery'=>$last['recovery']??null,'removed'=>$last['removed']??null,'total'=>$last['total']??null,'summary'=>$verified?'Directory and its selected contents deleted; absence verified.':'Deletion did not complete or its result could not be verified. Inspect the target and retained recovery data before another request.'];
            $failure=$verified?null:substr(is_string($last['error']??null)?$last['error']:$result['summary'],0,4096);
        }
        $state=$failure===null?'completed':'failed';
        $job=zfsmJobUpdate($id,['state'=>$state,'stage'=>$failure===null?'completed':'verifying','finished_at'=>gmdate('c'),'result'=>$result,'recovery'=>$result['recovery']??null,'error'=>$failure,'exit_code'=>$result['exit_code']??null]);
        if ($failure===null) zfsmWriteJobProgress($id,['stage'=>'completed','percent'=>100]);
        zfsmAuditFinish($audit,['status'=>$failure===null?'succeeded':'failed','reason'=>$failure===null?null:'command_failed','details'=>['stage'=>$job['stage'],'exit_code'=>$job['exit_code']]]);$audit=null;
        refreshData();return $job;
    } catch(Throwable $error) {
        if (!isset($job)||($job['schema']??null)!==6||zfsmJobProblem($job)) throw $error;
        [$code,$safe]=zfsmDeletionError($error->getMessage());
        $job=zfsmJobUpdate($id,['state'=>$attempted?'recovery_required':'failed','stage'=>$attempted?'interrupted':'preflight_failed','finished_at'=>gmdate('c'),'error_code'=>$attempted?'outcome_uncertain':$code,'error'=>$attempted?'Deletion was interrupted; some objects may already be removed. Inspect the target, Jobs and retained recovery journals. No automatic retry was performed.':$safe,'result'=>['attempted'=>$attempted,'state_verified'=>false,'summary'=>$attempted?'Deletion outcome is uncertain; manual inspection is required.':'No deletion was attempted.']]);
        if($audit!==null)try{zfsmAuditFinish($audit,['status'=>'failed','reason'=>'command_failed','details'=>['stage'=>$job['stage']]]);}catch(Throwable$ignored){}
        if($attempted)refreshData();return $job;
    } finally {unset($GLOBALS['zfsm_directory_reviewed']);if(is_resource($owned)){unset($GLOBALS['zfsm_operation_lock_handle']);flock($owned,LOCK_UN);fclose($owned);}}
}
