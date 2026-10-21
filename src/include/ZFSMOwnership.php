<?php
/** External schedulers are inspected, never executed or rewritten here. */
function zfsmOwnershipReadFile(string $path): string {
    clearstatcache(true,$path);$s=@lstat($path);
    if(!$s||is_link($path)||($s['mode']&0170000)!==0100000||$s['uid']!==0||($s['mode']&0022)!==0||$s['size']>2097152||realpath($path)!==$path)throw new RuntimeException('Source or scheduler file is missing or untrusted.');
    for($parent=dirname($path);$parent!=='/';$parent=dirname($parent)){
        $p=@lstat($parent);$sticky=$parent==='/tmp'&&$p&&($p['mode']&01000)!==0;
        if(!$p||is_link($parent)||($p['mode']&0170000)!==0040000||$p['uid']!==0||(!$sticky&&($p['mode']&0022)!==0))throw new RuntimeException('Source or scheduler directory is untrusted.');
    }
    $bytes=@file_get_contents($path);clearstatcache(true,$path);$after=@lstat($path);
    if(!is_string($bytes)||!$after||$s['dev']!==$after['dev']||$s['ino']!==$after['ino']||strlen($bytes)!==$after['size'])throw new RuntimeException('Source changed during inspection.');
    return $bytes;
}
function zfsmOwnershipMentionsSource(string $text,string $file): bool {
    $name=basename(dirname($file));
    $paths=[$file,dirname($file),'/tmp/user.scripts/tmpScripts/'.$name.'/script','/usr/local/emhttp/plugins/user.scripts/scripts/'.$name.'/script','/usr/local/emhttp/plugins/user.scripts/scripts/'.$name,'/usr/local/emhttp/plugins/tmp.user.scripts/tmpScripts/'.$name.'/script.php'];
    foreach($paths as$path)foreach([$path,rawurlencode($path)]as$needle)if(preg_match('~'.preg_quote($needle,'~').'(?=$|[\s\x27"/?&])~',$text))return true;
    return false;
}
function zfsmOwnershipProcessState(string $file): string {
    $marker='/tmp/user.scripts/running/'.basename(dirname($file));
    if(file_exists($marker)||is_link($marker)){
        $pid=trim(zfsmOwnershipReadFile($marker));
        return preg_match('/^[1-9][0-9]*$/D',$pid)&&is_dir('/proc/'.$pid)?'running':'unknown';
    }
    $pids=glob('/proc/[0-9]*');
    if(!$pids)return 'unknown';
    foreach($pids as$pid){$bytes=@file_get_contents($pid.'/cmdline');if($bytes===false){if(is_dir($pid))return 'unknown';continue;}
        foreach(explode("\0",$bytes)as$arg)if(zfsmOwnershipMentionsSource($arg,$file))return 'running';
    }
    return 'idle';
}
function zfsmOwnershipSchedulerProof(string $file): array {
    $entries=[];
    foreach(['/boot/config/plugins/user.scripts/schedule.json','/tmp/user.scripts/schedule.json']as$path){
        $json=json_decode(zfsmOwnershipReadFile($path),true,32,JSON_THROW_ON_ERROR);$row=$json[$file]??null;
        if(!is_array($row)||($row['script']??null)!==$file||!is_string($row['frequency']??null)||!is_string($row['custom']??null)||!is_string($row['id']??null)||$row['id']===''||strlen($row['id'])>256||preg_match('/[\x00-\x1f]/',$row['id']))throw new RuntimeException('User Scripts scheduler entry is missing or unsupported.');
        $entries[]=['script'=>$file,'frequency'=>$row['frequency'],'custom'=>$row['custom'],'id'=>$row['id']];
    }
    if($entries[0]!==$entries[1])throw new RuntimeException('Persistent and runtime User Scripts schedules disagree.');
    $row=$entries[0];$state=$row['frequency']==='disabled'?'disabled':'active';
    $live=runProcess('crontab',['-c','/etc/cron.d','-l']);
    if(($live['code']??1)!==0&&!preg_match('/no crontab|cannot open.*No such file/i',$live['output']??''))throw new RuntimeException('Live Unraid crontab could not be verified.');
    // Include other owners' persistent cron too: update_cron may publish a
    // legacy launcher that is not present in the live crontab yet.
    $texts=[$live['output']??''];foreach(glob('/boot/config/plugins/*/*.cron')?:[]as$path)$texts[]=zfsmOwnershipReadFile($path);
    foreach($texts as$text)foreach(preg_split('/\r?\n/',$text)as$line){$line=trim($line);if($line===''||str_starts_with($line,'#'))continue;
        if(zfsmOwnershipMentionsSource($line,$file)||str_contains($line,$row['id']))$state='active';
    }
    $process=zfsmOwnershipProcessState($file);if($process!=='idle')$state=$process;
    return ['state'=>$state,'schedule'=>$row['custom'],'fingerprint'=>hash('sha256',json_encode($row,JSON_THROW_ON_ERROR))];
}
function zfsmOwnershipSource(string $file): array {
    $m=['source_id'=>'source-'.substr(hash('sha256',$file),0,16),'source_sha256'=>null,'source_kind'=>'other','schedule_state'=>'unknown','schedule'=>null,'transfer_supported'=>false,'transfer_reason'=>'Only a verified disabled User Scripts source supports this transfer.','ownership_state'=>'external'];
    if(!preg_match('~^/boot/config/plugins/user\.scripts/scripts/[^/]+/script$~D',$file))return $m;
    $m['source_kind']='user_script';
    try{
        $m['source_sha256']=hash('sha256',zfsmOwnershipReadFile($file));$proof=zfsmOwnershipSchedulerProof($file);
        $m['schedule_state']=$proof['state'];$m['schedule']=$proof['schedule'];$m['deactivation_fingerprint']=$proof['fingerprint'];
        $m['transfer_supported']=$proof['state']==='disabled';$m['transfer_reason']=$m['transfer_supported']?'Verified disabled in persistent and runtime User Scripts; no live launch found.':'Disable this source through User Scripts and wait for its current run to finish, then refresh review.';
    }catch(Throwable$e){$m['transfer_reason']=$e->getMessage();}
    $record=zfsmProtectionReadStore()['external_reviews'][$m['source_id']]??null;
    if(is_array($record)){
        $matches=$m['transfer_supported']&&($record['source_sha256']??null)===$m['source_sha256']&&($record['deactivation_fingerprint']??null)===($m['deactivation_fingerprint']??null);
        $m['ownership_state']=$matches?'managed':'needs_review';$m['managed_definition']=$record['definition']??null;
    }
    return $m;
}
function zfsmOwnershipDefinitionScope(string $type,array $definition): array {
    return $type==='policy'?[$definition['dataset']]:[$definition['source'],($definition['mode']==='remote'?$definition['user'].'@'.$definition['host'].':':'').$definition['target']];
}
function zfsmOwnershipCheckDefinition(string $type,array $definition): void {
    foreach(zfsmProtectionReadStore()['external_reviews']??[]as$record){
        if(($record['definition']['type']??null)!==$type||($record['definition']['id']??null)!==$definition['id'])continue;
        $source=zfsmOwnershipSource($record['source_file']);
        if(!$source['transfer_supported']||$source['ownership_state']!=='managed'||($record['scope']??null)!==zfsmOwnershipDefinitionScope($type,$definition)||($record['recursive']??null)!==$definition['recursive'])throw new RuntimeException('External ownership changed; disable Managed execution and review the transfer again.');
        foreach($record['guids']??[]as$name=>$guid)zfsmRequireIdentity($name,$guid);
    }
}
function zfsmOwnershipTransferPreview(array $request,string $secret): array {
    $d=zfsmProtectionRequire();$type=$request['type']??'';$data=$request['data']??null;
    if(!in_array($type,['policy','replication'],true)||!is_array($data)||array_intersect(['id','source_guid','target_guid'],array_keys($data)))throw new InvalidArgumentException('Choose a new Managed policy or replication definition.');
    $schedules=zfsmProtectionSchedules();$row=null;
    foreach($schedules['external']as$item)if(($request['id']??null)===$item['id']||($request['id']??null)===($item['source_id']??null)){$row=$item;break;}
    if(!$row||empty($row['transfer_supported']))throw new RuntimeException($row['transfer_reason']??'External source is unavailable; refresh review.');
    $store=zfsmProtectionReadStore();$binding=$store['external_reviews'][$row['source_id']]??null;
    if($binding){
        $owner=$binding['definition'];$existing=$store[$owner['type']==='policy'?'policies':'replications'][$owner['id']]??null;
        if($owner['type']!==$type||!$existing||$existing['enabled'])throw new RuntimeException('Disable the existing Managed owner before reviewing this source again.');
        zfsmProtectionRequireIdleDefinition($type,$owner['id']);$data['id']=$owner['id'];
    }
    $data['enabled']=false;$guids=[];$native=zfsmSanoidRead();if($native['issues'])throw new RuntimeException(implode(' ',$native['issues']));
    if($type==='policy'){
        $data['autoprune']=false;$definition=zfsmSanoidPolicy($data);$inventory=zfsmSanoidInventory($definition['dataset']);$definition['source_guid']=$inventory['datasets'][$definition['dataset']];$scope=zfsmSanoidScope($definition,array_keys($inventory['datasets']));
        if(!$scope)throw new RuntimeException('Policy has no effective datasets.');$guids[$definition['dataset']]=$definition['source_guid'];foreach($scope as$name)$guids[$name]=$inventory['datasets'][$name];
        zfsmSanoidPolicyConflicts($definition,$native['policies']);foreach(array_filter(explode(',',$definition['use_template']))as$t)if(!isset($native['templates'][$t]))throw new InvalidArgumentException('Template is unavailable.');
        $config=zfsmSanoidConfig([$definition],$native['templates']);$inspection=null;
    }else{
        $definition=zfsmSyncoidJob($data);$inspection=zfsmSyncoidInspect($definition);$definition['source_guid']=$inspection['source']['']['guid'];$definition['target_guid']=$inspection['target']['']['guid']??null;
        $guids[$definition['source']]=$definition['source_guid'];if($definition['mode']==='local'&&$definition['target_guid']!==null)$guids[$definition['target']]=$definition['target_guid'];$config=null;$scope=zfsmOwnershipDefinitionScope($type,$definition);
    }
    // A fresh signed re-review replaces the old, disabled binding. Scheduling
    // checks still inspect every live External source; the old lease is not used.
    zfsmProtectionCheckSchedules($type==='policy'?$definition['dataset']:$definition['source'],$schedules);
    if($type==='replication'&&$definition['mode']==='local')zfsmProtectionCheckSchedules($definition['target'],$schedules);
    $review=['type'=>'external_transfer','definition_type'=>$type,'value'=>$definition,'source'=>$row,'scope'=>$scope,'guids'=>$guids,'config'=>$config,'inspection'=>$inspection,'external_diff'=>"External script: unchanged (SHA-256 ".$row['source_sha256'].")\nExternal schedule: disabled -> remains disabled\nManaged: create disabled ".$type."; schedule ".$definition['schedule']."\nNo cron is published by this transfer.",'warnings'=>['Review the new definition explicitly. Script hooks, notifications, rsync and other legacy actions are not converted. The original script is retained unchanged.','The imported definition stays disabled; enabling it later rechecks External scheduler state, source hashes and dataset identities.','Snapshot names do not transfer GUID ownership. Managed autoprune remains off.']];
    return zfsmProtectionPreview($review,$secret,zfsmProtectionFingerprint().$d['fingerprint']);
}
function zfsmOwnershipTransferCommit(array $request,string $secret): array {
    return zfsmProtectionConfigLock(function()use($request,$secret){
        $d=zfsmProtectionRequire();$r=zfsmProtectionConsumePreview($request,$secret,zfsmProtectionFingerprint().$d['fingerprint']);
        if(($r['type']??null)!=='external_transfer')throw new InvalidArgumentException('Fresh External transfer review is required.');
        $source=zfsmOwnershipSource($r['source']['file']);
        if(!$source['transfer_supported']||$source['source_sha256']!==$r['source']['source_sha256']||$source['deactivation_fingerprint']!==$r['source']['deactivation_fingerprint'])throw new RuntimeException('External source changed; review again.');
        foreach($r['guids']as$name=>$guid)zfsmRequireIdentity($name,$guid);
        if($r['definition_type']==='replication'){
            $actual=zfsmSyncoidInspect($r['value']);
            if($actual['source']['']['guid']!==$r['value']['source_guid']||($actual['target']['']['guid']??null)!==$r['value']['target_guid'])throw new RuntimeException('Dataset identity changed; review the transfer again.');
        }else{$actual=zfsmSanoidInventory($r['value']['dataset']);if(zfsmSanoidScope($r['value'],array_keys($actual['datasets']))!==$r['scope'])throw new RuntimeException('Policy scope changed; review the transfer again.');}
        $before=zfsmProtectionReadStore();$binding=$before['external_reviews'][$source['source_id']]??null;
        $type=$r['definition_type'];$def=$r['value'];$key=$type==='policy'?'policies':'replications';
        $existing=$before[$key][$def['id']]??null;
        if($def['enabled']||($type==='policy'&&$def['autoprune'])||($existing&&(!$binding||$binding['definition']!==['type'=>$type,'id'=>$def['id']]||$existing['enabled'])))throw new RuntimeException('Transfer requires a new or explicitly reviewed disabled definition.');
        zfsmProtectionRequireIdleDefinition($type,$def['id']);
        $after=$before;$after[$key][$def['id']]=$def;
        $after['external_reviews'][$source['source_id']]=['state'=>'transferred','source_file'=>$r['source']['file'],'source_sha256'=>$source['source_sha256'],'deactivation_fingerprint'=>$source['deactivation_fingerprint'],'definition'=>['type'=>$type,'id'=>$def['id']],'scope'=>zfsmOwnershipDefinitionScope($type,$def),'recursive'=>$def['recursive'],'guids'=>$r['guids'],'reviewed_at'=>gmdate('c')];
        try{
            zfsmProtectionWriteStore($after);$fresh=zfsmOwnershipSource($r['source']['file']);
            if(!$fresh['transfer_supported']||$fresh['ownership_state']!=='managed')throw new RuntimeException('External source changed during transfer.');
        }catch(Throwable$e){zfsmJobAtomicWrite(zfsmProtectionDirectory().'/config.json',$before);throw $e;}
        return ['succeeded'=>[$def['id']=>'Transfer reviewed; Managed definition saved disabled. External files and schedules retained.'],'failed'=>[],$type=>$def,'source'=>$fresh];
    });
}
