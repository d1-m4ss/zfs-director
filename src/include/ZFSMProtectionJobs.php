<?php
function zfsmNewProtectionJob(string $type,array $definition): array {
    if(!in_array($type,['policy','replication'],true)||($definition['owner']??null)!=='managed')throw new InvalidArgumentException('Only managed protection definitions can be queued.');
    $id=gmdate('Ymd-His').'-'.bin2hex(random_bytes(6));$source=$type==='policy'?$definition['dataset']:$definition['source'];
    $j=['schema'=>4,'id'=>$id,'type'=>$type,'definition_id'=>$definition['id'],'definition'=>$definition,'definition_hash'=>hash('sha256',json_encode($definition,JSON_THROW_ON_ERROR)),'state'=>'queued','stage'=>'queued','verified_outcome'=>'queued','source'=>$source,'target'=>$definition['target']??null,'source_guid'=>$definition['source_guid'],'ack_boot'=>zfsmBootId(),'cancel_requested'=>false,'created'=>gmdate('c'),'updated'=>gmdate('c')];
    return zfsmJobInitializeHistory($j);
}
function zfsmProtectionJobProblem(array $j): ?array {
    $invalid=['invalid_journal','Invalid protection journal; automatic execution is disabled.'];
    if(!in_array($j['type']??null,['policy','replication'],true)||!is_string($j['definition_id']??null)||!preg_match('/^[a-f0-9]{1,32}$/D',$j['definition_id'])||!is_array($j['definition']??null)||($j['definition']['owner']??null)!=='managed'||($j['definition']['id']??null)!==$j['definition_id'])return $invalid;
    if(!is_string($j['definition_hash']??null)||!hash_equals(hash('sha256',json_encode($j['definition'],JSON_THROW_ON_ERROR)),$j['definition_hash'])||!zfsmValidDatasetName($j['source']??null)||!is_string($j['source_guid']??null)||!preg_match('/^[1-9][0-9]*$/D',$j['source_guid'])||!is_bool($j['cancel_requested']??null))return $invalid;
    if($j['source']!==($j['type']==='policy'?($j['definition']['dataset']??null):($j['definition']['source']??null))||($j['type']==='replication'&&($j['target']??null)!==($j['definition']['target']??null)))return $invalid;
    return null;
}
function zfsmProtectionFinish(string $id,array $outcome): array {
    if(isset($outcome['exit_code'])&&is_int($outcome['exit_code'])&&$outcome['exit_code']<0)$outcome['exit_code']=null;
    $name=$outcome['outcome']??'unknown';$states=['completed'=>'completed','completed_with_warnings'=>'completed','up_to_date'=>'completed','skipped'=>'completed','failed'=>'failed','blocked'=>'failed','unknown'=>'recovery_required','interrupted'=>'recovery_required','recovery_required'=>'recovery_required'];
    if(!isset($states[$name]))throw new InvalidArgumentException('Invalid verified outcome.');
    return zfsmJobUpdate($id,['state'=>$states[$name],'stage'=>'finished','finished_at'=>gmdate('c'),'verified_outcome'=>$name,'verification'=>$outcome,'error'=>in_array($name,['completed','completed_with_warnings','up_to_date','skipped'],true)?null:($outcome['reason']??'Inspect this job before retrying.')]);
}
function zfsmProtectionRecoverJob(array $j): bool {
    if($j['state']==='running'||!zfsmJobBootApproved($j)) {zfsmProtectionFinish($j['id'],['outcome'=>'interrupted','exit_code'=>null,'reason'=>'Worker or boot changed before verified completion. Partial data retained; inspect before retry.']);return false;}
    return true;
}
function zfsmProtectionCancel(string $id): array {
    return zfsmJobUpdate($id,function($j){if(($j['schema']??null)!==4||zfsmJobProblem($j))throw new InvalidArgumentException('This is not a valid protection job.');if(!in_array($j['state'],['queued','running'],true))return [];return ['cancel_requested'=>true]+($j['state']==='queued'?['state'=>'cancelled','stage'=>'cancelled','verified_outcome'=>'skipped','finished_at'=>gmdate('c')]:[]);});
}
function zfsmProtectionSchedules(): array {
    $external=[];$issues=[];$paths=[];$managed=zfsmProtectionCronFile();$sources=[];
    foreach($GLOBALS['zfsm_protection_scan_roots']??['/etc/cron.d','/var/spool/cron/crontabs','/var/spool/cron']as$dir){if(is_dir($dir)&&!is_readable($dir))$issues[]='Cannot inspect '.$dir;foreach(glob($dir.'/*')?:[]as$file)if(is_file($file))$paths[]=$file;}
    foreach($GLOBALS['zfsm_protection_scan_patterns']??['/boot/config/plugins/user.scripts/scripts/*/script','/etc/systemd/system/*sanoid*','/etc/systemd/system/*syncoid*']as$pattern)foreach(glob($pattern)?:[]as$file)if(is_file($file))$paths[]=$file;
    if(is_file('/boot/config/go'))$paths[]='/boot/config/go';
    foreach(array_unique($paths)as$file){if($file===$managed)continue;if(is_link($file)||!is_readable($file)||filesize($file)>1048576){$issues[]='Cannot safely inspect '.$file;continue;}
        foreach(preg_split('/\r?\n/',file_get_contents($file))as$line){$line=trim($line);if($line===''||str_starts_with($line,'#')||str_contains($line,'/zfsm-protection.php'))continue;if(!preg_match('/\b(?:sanoid|syncoid|zrepl|zfs-auto-snapshot)\b/i',$line))continue;
            preg_match_all('~(?<![A-Za-z0-9_./:-])([A-Za-z][A-Za-z0-9_.:-]*(?:/[A-Za-z0-9_.:-]+)+)(?![A-Za-z0-9_./:-])~',$line,$matches);$datasets=[];foreach($matches[1]as$ds)if(zfsmValidDatasetName($ds)&&!preg_match('#^(?:usr|etc|boot|var|root|bin|sbin|mnt)/#',$ds))$datasets[]=$ds;
            $schedule=['id'=>'external-'.substr(hash('sha256',$file.$line),0,12),'owner'=>'external','file'=>$file,'datasets'=>array_values(array_unique($datasets)),'review'=>!$datasets||str_contains($file,'user.scripts'),'description'=>'External schedule/script; inspect original file. No script contents or secrets returned.'];
            if(preg_match('~(?:^|[ /])sanoid(?:\s|$)~',$line)&&!str_contains($file,'user.scripts')&&!preg_match('/[\$`;|&<>()]/',$line)){
                $configDir='/etc/sanoid';if(preg_match('~--configdir(?:=|\s+)(/[A-Za-z0-9_./-]+)~',$line,$m))$configDir=$m[1];$conf=$configDir.'/sanoid.conf';
                if(zfsmProtectionTrustedFile($conf)&&filesize($conf)<=1048576)try{$c=zfsmSanoidParse(file_get_contents($conf));$scopes=[];$hooks=false;foreach($c as$name=>$v){foreach($v as$key=>$value)if(str_ends_with($key,'_script')&&$value!=='')$hooks=true;if(!str_starts_with($name,'template_')){$effective=zfsmSanoidEffective($c,$name);if(($effective['autosnap']??'yes')==='yes'||($effective['autoprune']??'yes')==='yes')$scopes[]=$name;}}$schedule['datasets']=$scopes;$schedule['review']=$hooks;$schedule['configuration']=$conf;$schedule['configuration_sha256']=hash_file('sha256',$conf);}catch(Throwable$e){$schedule['review']=true;}
            }
            if(!isset($sources[$file]))$sources[$file]=zfsmOwnershipSource($file);
            $external[]=array_merge($schedule,$sources[$file]);
        }
    }
    $grouped=[];foreach($external as$row){$file=$row['file'];if(!isset($grouped[$file]))$grouped[$file]=$row;else{$grouped[$file]['datasets']=array_values(array_unique(array_merge($grouped[$file]['datasets'],$row['datasets'])));$grouped[$file]['review']=$grouped[$file]['review']||$row['review'];}}
    $external=array_values($grouped);
    // A removed command or missing script must not hide an existing ownership
    // binding: the owner still needs a way to inspect and review the change.
    $listed=array_column($external,'file');
    foreach(zfsmProtectionReadStore()['external_reviews']??[]as$record){$file=$record['source_file']??null;if(!is_string($file)||in_array($file,$listed,true))continue;
        $external[]=array_merge(['id'=>'external-'.substr(hash('sha256',$file),0,12),'owner'=>'external','file'=>$file,'datasets'=>[],'review'=>true,'description'=>'Previously reviewed External source; inspect ownership again.'],zfsmOwnershipSource($file));$listed[]=$file;
    }
    return ['owner'=>'Director cron','managed_file'=>$managed,'external'=>$external,'issues'=>$issues,'mechanism'=>'Unraid update_cron; worker executes queued jobs only'];
}
function zfsmProtectionCheckSchedules(string $dataset,array $schedules): void {
    if($schedules['issues'])throw new RuntimeException('Schedule ownership is unknown: '.implode(' ',$schedules['issues']));
    foreach($schedules['external']as$e){if(($e['schedule_state']??null)==='disabled'&&!empty($e['transfer_supported']))continue;if($e['review'])throw new RuntimeException('External config-driven schedule requires review: '.$e['file']);foreach($e['datasets']as$ds)if(zfsmProtectionScopeOverlap($dataset,$ds))throw new RuntimeException('External schedule overlaps '.$dataset.': '.$e['file'].'. Transfer ownership explicitly before enabling another schedule.');}
}
function zfsmProtectionCheckDefinitionSchedules(string $type,array $definition,array $schedules): void {
    zfsmOwnershipCheckDefinition($type,$definition);
    zfsmProtectionCheckSchedules($type==='policy'?$definition['dataset']:$definition['source'],$schedules);
    if($type==='replication'&&$definition['mode']==='local')zfsmProtectionCheckSchedules($definition['target'],$schedules);
}
function zfsmProtectionRequireIdleDefinition(string $type,string $id): void {
    foreach(zfsmPendingJobs()as$j)if(($j['schema']??null)===4&&$j['type']===$type&&$j['definition_id']===$id)throw new RuntimeException('Cancel or finish the pending job before changing its definition.');
}
function zfsmProtectionCronText(array $store): string {
    $text="# ZFS Director managed protection schedules. Do not edit.\n";$script='/usr/local/emhttp/plugins/zfs.master.ui/scripts/zfsm-protection.php';
    foreach(['policies'=>'policy','replications'=>'replication']as$key=>$type)foreach($store[$key]as$id=>$d){if(empty($d['enabled']))continue;if(!preg_match('/^[a-f0-9]{1,32}$/D',$id))throw new RuntimeException('Invalid managed schedule identity.');$text.=zfsmProtectionCron($d['schedule']).' /usr/bin/php '.escapeshellarg($script).' '.escapeshellarg($type).' '.escapeshellarg($id)." >/dev/null 2>&1\n";}
    return $text;
}
function zfsmProtectionCronCompatibility(string $current,array $sources): void {
    $known=[];foreach($sources as$text)foreach(preg_split('/\r?\n/',$text)as$line){$line=trim($line);if($line!==''&&!str_starts_with($line,'#'))$known[$line]=true;}
    foreach(preg_split('/\r?\n/',$current)as$line){$line=trim($line);if($line!==''&&!str_starts_with($line,'#')&&!isset($known[$line]))throw new RuntimeException('Existing system cron contains unmanaged entries that update_cron would overwrite. Move them to their owner plugin cron source before activating Director schedules.');}
}
function zfsmProtectionPublishedCron(array $previous): string {
    $expected=zfsmProtectionCronText($previous);$file=zfsmProtectionCronFile();$record=zfsmProtectionDirectory().'/cron-publication.json';
    // Same private state boundary as config.json. Only hashes of generated
    // cron are retained, including the previous text for activation rollback.
    if(!is_file($record))return $expected;
    if(is_link($record)||filesize($record)>4096)throw new RuntimeException('Invalid Director cron publication record.');
    $proof=json_decode(file_get_contents($record),true,8,JSON_THROW_ON_ERROR);
    if(($proof['version']??null)!==1||!is_array($proof['hashes']??null)||count($proof['hashes'])>2)throw new RuntimeException('Invalid Director cron publication record.');
    foreach($proof['hashes']as$hash)if(!is_string($hash)||!preg_match('/^[a-f0-9]{64}$/D',$hash))throw new RuntimeException('Invalid Director cron publication hash.');
    if(is_file($file)&&!is_link($file)&&filesize($file)<=4194304){$text=file_get_contents($file);if(in_array(hash('sha256',$text),$proof['hashes'],true))return $text;}
    return $expected;
}
function zfsmProtectionRememberLegacyCron(array $previous): void {
    $record=zfsmProtectionDirectory().'/cron-publication.json';$file=zfsmProtectionCronFile();
    if(file_exists($record)||is_link($record))return;
    $expected=zfsmProtectionCronText($previous);
    // On an upgrade there is no publication record yet. Preserve only an
    // exact generated pre-change cron, before a durable stop changes state.
    if(is_file($file)&&!is_link($file)&&filesize($file)<=4194304&&file_get_contents($file)===$expected)zfsmJobAtomicWrite($record,['version'=>1,'hashes'=>[hash('sha256',$expected)]]);
}
function zfsmProtectionCronSources(array $previous): array {
    // Same source set as upstream Unraid sbin/update_cron, with our previous
    // generated text replacing any manually altered Director cron file.
    $paths=glob('/boot/config/plugins/dynamix/*.cron')?:[];
    foreach(glob('/var/log/plugins/*.plg')?:[]as$plugin)foreach(glob('/boot/config/plugins/'.basename($plugin,'.plg').'/*.cron')?:[]as$file)$paths[]=$file;
    $own=zfsmProtectionCronFile();$texts=[zfsmProtectionPublishedCron($previous)];
    foreach(array_unique($paths)as$file){if($file===$own)continue;if(is_link($file)||!is_readable($file)||filesize($file)>1048576)throw new RuntimeException('Cannot verify installed plugin cron sources.');$texts[]=file_get_contents($file);}return $texts;
}
function zfsmProtectionCronReadback(string $expected,string $actual): void {
    $wanted=[];foreach(explode("\n",$expected)as$line){$line=trim($line);if($line!==''&&!str_starts_with($line,'#'))$wanted[$line]=true;}
    $seen=[];foreach(explode("\n",$actual)as$line){$line=trim($line);if($line===''||str_starts_with($line,'#'))continue;if(str_contains($line,'/zfsm-protection.php')&&!isset($wanted[$line]))throw new RuntimeException('Cron contains an unexpected Director launch; inspect ownership.');$seen[$line]=($seen[$line]??0)+1;}
    foreach($wanted as$line=>$_)if(($seen[$line]??0)!==1)throw new RuntimeException('Cron readback is missing or duplicates a Director launch.');
}
function zfsmProtectionPublishSchedules(array $store,array $previous): void {
    $file=zfsmProtectionCronFile();$text=zfsmProtectionCronText($store);$before=is_file($file)?file_get_contents($file):null;
    $updater=zfsmProtectionCronUpdater();if($updater===null)throw new RuntimeException('Unraid update_cron is unavailable. Configuration was not activated.');
    $bash=realpath('/bin/bash');if($bash===false||!zfsmProtectionTrustedFile($bash,true))throw new RuntimeException('Trusted Bash is required for Unraid update_cron. Configuration was not activated.');
    $current=runProcess('crontab',['-c','/etc/cron.d','-l']);if(($current['code']??1)!==0&&!preg_match('/no crontab|cannot open.*No such file/i',$current['output']??''))throw new RuntimeException('Cannot verify current Unraid system cron.');zfsmProtectionCronCompatibility(($current['code']??1)===0?$current['output']:'',zfsmProtectionCronSources($previous));
    foreach(['policies'=>'policy','replications'=>'replication']as$key=>$type)foreach($store[$key]as$d)if($d['enabled'])zfsmProtectionCheckDefinitionSchedules($type,$d,zfsmProtectionSchedules());
    zfsmJobAtomicWrite(zfsmProtectionDirectory().'/cron-publication.json',['version'=>1,'hashes'=>array_values(array_unique([hash('sha256',$text),hash('sha256',zfsmProtectionPublishedCron($previous))]))]);
    zfsmProtectionWriteText($file,$text);
    try{$r=runProcess($bash,[$updater]);if(($r['code']??1)!==0)throw new RuntimeException('update_cron failed.');$read=runProcess('crontab',['-c','/etc/cron.d','-l']);if(($read['code']??1)!==0)throw new RuntimeException('Cannot read scheduler state.');zfsmProtectionCronReadback($text,$read['output']??'');}
    catch(Throwable$e){if($before===null)@unlink($file);else zfsmProtectionWriteText($file,$before);$rollback=runProcess($bash,[$updater]);if(($rollback['code']??1)!==0)throw new RuntimeException('Schedule activation and rollback failed; inspect cron and retained configuration.');throw new RuntimeException('Schedule activation failed; previous cron restored. '.$e->getMessage());}
}
function zfsmProtectionApplyStore(array $store): void {
    $before=zfsmProtectionReadStore();zfsmProtectionWriteStore($store);
    try{zfsmProtectionPublishSchedules($store,$before);}catch(Throwable$e){zfsmJobAtomicWrite(zfsmProtectionDirectory().'/config.json',$before);throw $e;}
}
function zfsmProtectionActivationConflicts(string $type,array $definition,array $store,array $externalPolicies): void {
    if($type==='policy'){zfsmSanoidPolicyConflicts($definition,array_merge(array_values($store['policies']),$externalPolicies));return;}
    foreach($store['replications']as$other)if($other['id']!==$definition['id']&&$other['enabled']&&$other['mode']===$definition['mode']&&$other['host']===$definition['host']&&zfsmProtectionScopeOverlap($other['target'],$definition['target']))throw new RuntimeException('Another enabled managed replication owns this destination scope.');
}
function zfsmProtectionDefinitionControl(array $request): array {
    $type=$request['type']??'';$id=$request['id']??'';$action=$request['action']??'';
    if(!in_array($type,['policy','replication'],true)||!is_string($id)||!preg_match('/^[a-f0-9]{1,32}$/D',$id)||!in_array($action,['enable','disable','remove'],true))throw new InvalidArgumentException('Only managed definitions support enable, disable or remove.');
    return zfsmProtectionConfigLock(function()use($type,$id,$action){zfsmProtectionRequire();$s=zfsmProtectionReadStore();$key=$type==='policy'?'policies':'replications';$d=$s[$key][$id]??null;if(!$d)throw new InvalidArgumentException('Managed definition not found.');zfsmProtectionRequireIdleDefinition($type,$id);if($action==='enable')zfsmProtectionActivationConflicts($type,$d,$s,zfsmSanoidRead()['policies']);if($action==='remove'){unset($s[$key][$id]);foreach($s['external_reviews']??[]as$source=>$record)if(($record['definition']??null)===['type'=>$type,'id'=>$id])unset($s['external_reviews'][$source]);}else$s[$key][$id]['enabled']=$action==='enable';$warning=null;
        if($action==='enable')zfsmProtectionApplyStore($s);
        else{
            // A safe stop must remain durable even when another stale owner
            // prevents cron publication. Existing launchers then see disabled
            // or missing state; no new launcher is published on that failure.
            $before=zfsmProtectionReadStore();zfsmProtectionRememberLegacyCron($before);zfsmProtectionWriteStore($s);
            try{zfsmProtectionPublishSchedules($s,$before);}catch(Throwable$e){$warning='Definition stopped in Director state; cron synchronization deferred. '.$e->getMessage();}
        }
        return ['succeeded'=>[$id=>$action==='remove'?'Definition removed; all datasets and snapshots retained':'Definition '.$action.'d'],'failed'=>[]]+($warning===null?[]:['scheduler_warning'=>$warning]);});
}
function zfsmQueueProtection(array $request,bool $interactive=true): array {
    $type=$request['type']??'';$id=$request['id']??'';
    if(!in_array($type,['policy','replication'],true)||!is_string($id)||!preg_match('/^[a-f0-9]{1,32}$/D',$id))throw new InvalidArgumentException('Valid managed definition required.');
    return zfsmProtectionConfigLock(function()use($type,$id,$interactive){
        $store=zfsmProtectionReadStore();$d=$store[$type==='policy'?'policies':'replications'][$id]??null;if(!$d||!$d['enabled'])throw new RuntimeException('Definition is missing or disabled.');
        foreach(zfsmPendingJobs()as$j)if(($j['schema']??null)===4&&$j['type']===$type&&$j['definition_id']===$id)return ['succeeded'=>[$j['id']=>'Already queued/running for this definition'],'failed'=>[],'job'=>$j];
        $job=zfsmNewProtectionJob($type,$d);
        try{$backend=zfsmProtectionRequire($interactive);if(!$backend['enabled'])throw new RuntimeException('Sanoid / Syncoid integration is disabled; managed execution is blocked. Existing schedules are unchanged.');zfsmProtectionCheckDefinitionSchedules($type,$d,zfsmProtectionSchedules());}
        catch(Throwable$e){if($interactive)throw $e;zfsmJobAtomicWrite(zfsmJobFile($job['id']),$job);$job=zfsmProtectionFinish($job['id'],['outcome'=>'blocked','reason'=>$e->getMessage(),'exit_code'=>null]);zfsmAuditEvent('protectionscheduled',['job_id'=>$job['id']],'failed');return ['succeeded'=>[],'failed'=>[$job['id']=>$e->getMessage()],'job'=>$job];}
        zfsmJobAtomicWrite(zfsmJobFile($job['id']),$job);if(!$interactive)zfsmAuditEvent('protectionscheduled',['job_id'=>$job['id']],'queued');return ['succeeded'=>[$job['id']=>'Queued'],'failed'=>[],'job'=>$job];
    });
}
function zfsmProtectionStream(array $job,string $binary,array $args,?callable $tick=null): array {
    $stageRecorded=false;
    return zfsmStreamProcess($binary,$args,function($chunk)use($job,&$stageRecorded,$tick){
        if($tick!==null)$tick();
        // Native output is intentionally not journaled: it may expose SSH
        // identities/paths. Unknown byte/percentage values stay unknown.
        if($chunk!==''&&!$stageRecorded){zfsmJobUpdate($job['id'],['stage'=>'transferring']);$stageRecorded=true;}
    },fn()=>zfsmReadJob($job['id'])['cancel_requested']===true,null,null,true);
}
function zfsmRunProtectionJob(array $job): void {
    $job=zfsmReadJob($job['id']);if(zfsmJobProblem($job)||!in_array($job['state'],['queued','running'],true))return;
    $file=zfsmProtectionDirectory().'/execution.lock';if(is_link($file))throw new RuntimeException('Untrusted protection execution lock.');$lock=@fopen($file,'c');if(!$lock||!flock($lock,LOCK_EX|LOCK_NB)){if($lock)fclose($lock);return;}
    $mutation=null;$audit=null;
    try{if(!zfsmProtectionRecoverJob($job))return;
        // Administrative requests take mutation then config locks. Publish the
        // running reservation under that same order before releasing mutation.
        $mutation=zfsmAcquireOperationLock($GLOBALS['plugin_lock'],true);if($mutation===null)return;
        // Queue publication can precede config unlock. Leave it queued for the
        // next worker pass on contention; invalid storage still fails closed.
        $job=zfsmProtectionConfigLock(function()use($job){if((int)loadConfig(parse_plugin_cfg($GLOBALS['plugin'],true))['sanoid_integration']!==1)throw new RuntimeException('Sanoid / Syncoid integration is disabled; queued execution requires review.');$live=zfsmReadJob($job['id']);if($live['state']!=='queued'||$live['cancel_requested'])return null;$store=zfsmProtectionReadStore();$d=$store[$live['type']==='policy'?'policies':'replications'][$live['definition_id']]??null;if(!$d||!hash_equals($live['definition_hash'],hash('sha256',json_encode($d,JSON_THROW_ON_ERROR))))throw new RuntimeException('Queued definition changed; inspect and queue a fresh run.');zfsmProtectionCheckDefinitionSchedules($live['type'],$d,zfsmProtectionSchedules());return zfsmJobUpdate($live['id'],['state'=>'running','stage'=>'inspecting','verified_outcome'=>'running','started_at'=>gmdate('c')]);},true);
        if($job===null)return;
        $GLOBALS['zfsm_operation_lock_handle']=$lock;$audit=zfsmAuditBegin('protectionexecute',['job_id'=>$job['id'],'source'=>$job['source'],'target'=>$job['target']]);
        if($job['type']==='replication'){flock($mutation,LOCK_UN);fclose($mutation);$mutation=null;}
        $out=$job['type']==='policy'?zfsmSanoidExecute($job):zfsmSyncoidExecute($job);zfsmProtectionFinish($job['id'],$out);zfsmAuditFinish($audit,['status'=>in_array($out['outcome'],['completed','completed_with_warnings','up_to_date','skipped'],true)?'succeeded':'failed','reason'=>$out['reason']??'Verified protection outcome recorded.']);$audit=null;
    }catch(Throwable$e){zfsmProtectionFinish($job['id'],['outcome'=>'recovery_required','reason'=>$e->getMessage(),'exit_code'=>null]);if($audit!==null)zfsmAuditFinish($audit,['status'=>'recovery_required','reason'=>'Protection execution requires inspection.']);}
    finally{unset($GLOBALS['zfsm_operation_lock_handle']);if(is_resource($mutation)){flock($mutation,LOCK_UN);fclose($mutation);}flock($lock,LOCK_UN);fclose($lock);}
}
function zfsmProtectionMutationGuard(string $command,array $fields): void {
    if(!in_array($command,['createdataset','clonesnapshot','destroydataset','destroysnapshot','renamedataset','lockdataset','unlockdataset','rollbacksnapshot','movedirectory','convertdirectory','deletedirectory','cleanupmutation','promotedataset','renamesnapshot','editdatasetproperty','setquota','editacl'],true))return;
    $running=array_filter(zfsmPendingJobs(),fn($j)=>($j['schema']??null)===4&&$j['state']==='running');if(!$running)return;
    $targets=[];if($command==='createdataset'&&is_array($fields['data']??null)){$ds=($fields['data']['zpool']??'').'/'.trim($fields['data']['name']??'','/');if(zfsmValidDatasetName($ds))$targets[]=$ds;}foreach(['zdataset','snapshot','directory','newname','clone']as$key)if(is_string($fields[$key]??null)){
        $target=explode('@',$fields[$key],2)[0];if(str_starts_with($target,'/')){$resolved=zfsmResolveDirectory($target,$key!=='newname');if(!$resolved)throw new RuntimeException('Cannot verify directory scope while a protection job is active.');$target=$resolved['dataset'];}if(zfsmValidDatasetName($target))$targets[]=$target;
    }
    foreach($running as$j)foreach($targets as$target)if(zfsmProtectionScopeOverlap($target,$j['source'])||(($j['definition']['mode']??'local')==='local'&&is_string($j['target'])&&zfsmProtectionScopeOverlap($target,$j['target'])))throw new RuntimeException('A protection job owns this dataset scope. Cancel and inspect its outcome before changing identity or data.');
}
function zfsmProtectionData(): array {
    $d=zfsmProtectionRequire();$s=zfsmProtectionReadStore();$native=zfsmSanoidRead();$page=zfsmJobPage(1,200);$jobs=array_values(array_filter($page['jobs'],fn($j)=>($j['schema']??null)===4));foreach($jobs as &$job)if($job['type']==='replication')$job['verification']=zfsmProtectionCurrentVerification($job['verification']??[]);unset($job);$last=[];
    $inventory=zfsmProtectionProbe('zfs',['list','-H','-p','-t','filesystem,volume','-o','name,guid']);$datasets=[];
    if(($inventory['code']??1)!==0)throw new RuntimeException('Source dataset inventory is unavailable.');
    foreach(preg_split('/\r?\n/',trim($inventory['output']),-1,PREG_SPLIT_NO_EMPTY)as$line){$v=explode("\t",$line);if(count($v)!==2||!zfsmValidDatasetName($v[0])||!preg_match('/^[1-9][0-9]*$/D',$v[1]))throw new RuntimeException('Malformed source dataset inventory.');$datasets[]=['name'=>$v[0],'guid'=>$v[1]];}
    foreach($jobs as$j){$id=$j['definition_id'];if(!isset($last[$id])||strcmp($j['created'],$last[$id]['created'])>0)$last[$id]=$j;}
    $present=array_fill_keys(array_column($datasets,'name'),true);$snapshotDefaults=zfsmSanoidSnapshotDefaults();
    foreach($native['policies']as&$p){$p['last_job']=$last[$p['id']]??null;$p['dataset_present']=isset($present[$p['dataset']]);if(($p['owner']??'')!=='external')$p['snapshot_effective']=zfsmSanoidSnapshotEffective($p,$native['templates'],$snapshotDefaults);}unset($p);
    $replications=array_values($s['replications']);foreach($replications as&$r)$r['last_job']=$last[$r['id']]??null;unset($r);
    $credentials=[];$file=zfsmProtectionDirectory().'/credentials.json';if(zfsmProtectionTrustedFile($file)&&filesize($file)<=65536){$refs=json_decode(file_get_contents($file),true,8,JSON_THROW_ON_ERROR);if(is_array($refs))foreach($refs as$id=>$entry)if(is_string($id)&&preg_match('/^[A-Za-z0-9_-]{1,64}$/D',$id))$credentials[]=$id;}
    return ['detection'=>$d,'datasets'=>$datasets,'policies'=>$native['policies'],'templates'=>$native['templates'],'replications'=>$replications,'jobs'=>$jobs,'scheduler'=>zfsmProtectionSchedules(),'issues'=>$native['issues'],'credentials'=>$credentials,'snapshot_naming'=>$native['snapshot_naming'],'snapshot_defaults'=>$snapshotDefaults];
}
function zfsmProtectionRunPreview(array $request,string $secret): array {
    $d=zfsmProtectionRequire();$type=$request['type']??'';$id=$request['id']??'';if(!in_array($type,['policy','replication'],true)||!is_string($id))throw new InvalidArgumentException('Choose a managed job.');$s=zfsmProtectionReadStore();$def=$s[$type==='policy'?'policies':'replications'][$id]??null;if(!$def||!$def['enabled'])throw new RuntimeException('Managed job is missing or disabled.');
    $source=$type==='policy'?$def['dataset']:$def['source'];zfsmProtectionCheckDefinitionSchedules($type,$def,zfsmProtectionSchedules());
    $inspection=$type==='policy'?zfsmSanoidInventory($source):zfsmSyncoidInspect($def);$guid=$type==='policy'?$inspection['datasets'][$source]:$inspection['source']['']['guid'];if($guid!==$def['source_guid'])throw new RuntimeException('Source identity changed. Edit and review the job before running.');
    return zfsmProtectionPreview(['type'=>'run','value'=>['type'=>$type,'id'=>$id],'inspection'=>$inspection,'warnings'=>['No automatic rollback, foreign snapshot cleanup or destination deletion.']],$secret,zfsmProtectionFingerprint().$d['fingerprint']);
}
function zfsmProtectionRunCommit(array $request,string $secret): array {
    $d=zfsmProtectionRequire();$p=zfsmProtectionConsumePreview($request,$secret,zfsmProtectionFingerprint().$d['fingerprint']);if(($p['type']??null)!=='run')throw new InvalidArgumentException('Fresh run inspection is required.');$answer=zfsmQueueProtection($p['value']);try{zfsmStartWorker();}catch(Throwable$e){$answer['worker_warning']='Worker is unavailable; the durable job remains queued.';}return $answer;
}
function zfsmProtectionControlPreview(array $input,string $secret): array {
    $d=zfsmProtectionRequire();$type=$input['type']??'';$id=$input['id']??'';$action=$input['action']??'';
    if(!in_array($type,['policy','replication'],true)||!is_string($id)||!preg_match('/^[a-f0-9]{1,32}$/D',$id)||!in_array($action,['enable','disable','remove'],true))throw new InvalidArgumentException('Only managed definitions can be changed.');$s=zfsmProtectionReadStore();$def=$s[$type==='policy'?'policies':'replications'][$id]??null;if(!$def)throw new RuntimeException('Managed definition is missing.');
    return zfsmProtectionPreview(['type'=>'definition_control','value'=>['type'=>$type,'id'=>$id,'action'=>$action],'definition'=>$def,'warnings'=>['Removing the definition does not remove snapshots, datasets or history.']],$secret,zfsmProtectionFingerprint().$d['fingerprint']);
}
function zfsmProtectionControlCommit(array $request,string $secret): array {
    $d=zfsmProtectionRequire();$p=zfsmProtectionConsumePreview($request,$secret,zfsmProtectionFingerprint().$d['fingerprint']);if(($p['type']??null)!=='definition_control')throw new InvalidArgumentException('Fresh definition review is required.');return zfsmProtectionDefinitionControl($p['value']);
}
function zfsmProtectionTestConfiguration(): array {
    $d=zfsmProtectionRequire();$native=zfsmSanoidRead();if($native['issues'])throw new RuntimeException(implode(' ',$native['issues']));$s=zfsmProtectionReadStore();$results=[];
    foreach($s['policies']as$p){$inventory=zfsmSanoidInventory($p['dataset']);$scope=zfsmSanoidScope($p,array_keys($inventory['datasets']));$r=zfsmSanoidInvoke($p,$scope,false,$d['sanoid']['path'],['--readonly','--take-snapshots']);$results[]=['id'=>$p['id'],'valid'=>($r['code']??1)===0,'exit_code'=>$r['code']??1];}
    return ['valid'=>!array_filter($results,fn($r)=>!$r['valid']),'policies'=>$results,'issues'=>$native['issues'],'message'=>'Read-only native configuration checks; no replication or pruning performed.'];
}
