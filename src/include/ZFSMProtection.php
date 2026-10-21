<?php
/** Integration discovery is always server-side; no installation or daemon is started. */
function zfsmProtectionPaths(): array {
    return $GLOBALS['zfsm_protection_paths']??[
        'manifest'=>'/var/log/plugins/unRAID6-Sanoid.plg',
        'sanoid'=>['/usr/local/sbin/sanoid','/usr/local/bin/sanoid','/usr/sbin/sanoid'],
        'syncoid'=>['/usr/local/sbin/syncoid','/usr/local/bin/syncoid','/usr/sbin/syncoid'],
    ];
}
function zfsmProtectionTrustedFile($path,$executable=false): bool {
    if (!is_string($path)||!str_starts_with($path,'/')||is_link($path)) return false;
    clearstatcache(true,$path);$stat=@lstat($path);
    if (!$stat||($stat['mode']&0170000)!==0100000||$stat['uid']!==0||($stat['mode']&0022)!==0||($executable&&!is_executable($path))) return false;
    for($parent=dirname($path);$parent!=='/';$parent=dirname($parent)) {
        $s=@lstat($parent);if(!$s||is_link($parent)||($s['mode']&0170000)!==0040000||$s['uid']!==0||($s['mode']&0022)!==0)return false;
    }
    return true;
}
// Unraid registers installed plugins as root-owned symlinks into persistent
// /boot/config/plugins. Accept only that exact filename mapping, never an
// arbitrary link or an executable from a writable directory.
function zfsmProtectionManifestFile(string $path): ?string {
    if(!is_link($path))return zfsmProtectionTrustedFile($path)?$path:null;
    $before=@lstat($path);$target=realpath($path);
    if(!$before||$before['uid']!==0||dirname($path)!=='/var/log/plugins'||$target!=='/boot/config/plugins/'.basename($path)||!zfsmProtectionTrustedFile($target))return null;
    for($p=dirname($path);$p!=='/';$p=dirname($p)){$st=@lstat($p);if(!$st||is_link($p)||($st['mode']&0170000)!==0040000||$st['uid']!==0||($st['mode']&0022)!==0)return null;}
    clearstatcache(true,$path);$after=@lstat($path);return $after&&$before['dev']===$after['dev']&&$before['ino']===$after['ino']&&realpath($path)===$target?$target:null;
}
function zfsmProtectionCronFile(): string {
    if(isset($GLOBALS['zfsm_protection_cron_file']))return $GLOBALS['zfsm_protection_cron_file'];
    $sources=[];foreach(['/var/log/plugins/zfs-director.plg','/var/log/plugins/zfs.master.ui.local.plg','/var/log/plugins/zfs.master.ui.plg']as$registered){$manifest=zfsmProtectionManifestFile($registered);if($manifest!==null&&filesize($manifest)<=1048576&&preg_match('/<PLUGIN\b[^>]*\bname=["\']zfs\.master\.ui["\']/i',file_get_contents($manifest)))$sources[]='/boot/config/plugins/'.basename($registered,'.plg').'/protection.cron';}
    if(count($sources)!==1)throw new RuntimeException('Director cron plugin namespace is missing or ambiguous; schedules remain unchanged.');
    $legacy=dirname($GLOBALS['plugin_config']).'/protection.cron';if($sources[0]!==$legacy&&file_exists($legacy))throw new RuntimeException('Legacy Director cron source requires explicit migration; schedules remain unchanged.');
    return $sources[0];
}
function zfsmProtectionProbe(string $binary,array $args,int $seconds=15): array {
    if($seconds<1||$seconds>90)throw new InvalidArgumentException('Invalid read-only probe budget.');
    $previous=$GLOBALS['zfsm_inventory_deadline']??null;
    $deadline=microtime(true)+$seconds;$GLOBALS['zfsm_inventory_deadline']=$previous===null?$deadline:min($previous,$deadline);
    try{return runProcess($binary,$args);}finally{if($previous===null)unset($GLOBALS['zfsm_inventory_deadline']);else $GLOBALS['zfsm_inventory_deadline']=$previous;}
}
function zfsmProtectionCronUpdater(): ?string {
    foreach(['/usr/local/sbin/update_cron','/usr/sbin/update_cron','/sbin/update_cron']as$candidate){$path=realpath($candidate);if($path!==false&&zfsmProtectionTrustedFile($path,true))return $path;}return null;
}
function zfsmProtectionDetection(): array {
    $paths=zfsmProtectionPaths();$manifest=zfsmProtectionManifestFile($paths['manifest']);
    $installed=$manifest!==null&&filesize($manifest)<=1048576&&preg_match('/<!ENTITY\s+name\s+["\']unRAID6-Sanoid["\']\s*>/',(string)file_get_contents($manifest))===1;
    $config=loadConfig(parse_plugin_cfg($GLOBALS['plugin'],true));$enabled=(int)($config['sanoid_integration']??0)===1;
    $result=['installed'=>$installed,'enabled'=>$enabled,'compatible'=>false,'visible'=>false,'state'=>$installed?'unhealthy':'missing','manifest'=>$installed?$manifest:null,'sanoid'=>null,'syncoid'=>null,'issues'=>[]];
    $files=[];
    foreach(['sanoid','syncoid']as$name){$files[$name]=null;foreach($paths[$name]as$candidate){$path=realpath($candidate);if($path!==false&&zfsmProtectionTrustedFile($path,true)){$files[$name]=$path;break;}}}
    if(!$installed)$result['issues'][]='Supported external Unraid Sanoid plugin is not installed or its manifest is not trusted.';
    elseif(in_array(null,$files,true))$result['issues'][]='Both trusted Sanoid and Syncoid executables are required.';
    else {
        foreach($files as$name=>$path){
            $version=zfsmProtectionProbe($path,['--version']);$help=zfsmProtectionProbe($path,['--help']);$text=$help['output']??'';
            preg_match('/\b(\d+\.\d+\.\d+)\b/',$version['output']??'',$match);
            $flags=[];preg_match_all('/--[a-z][a-z0-9-]*/i',$text,$matches);foreach($matches[0]as$flag)$flags[$flag]=true;
            $required=$name==='sanoid'?['--configdir','--readonly','--take-snapshots','--prune-snapshots','--cache-dir','--run-dir','--force-update']:['--no-rollback','--recvoptions','--sshoption','--identifier','--no-resume','--compress','--no-clone-handling'];
            $missing=array_values(array_diff($required,array_keys($flags)));
            $ok=($version['code']??1)===0&&isset($match[1])&&version_compare($match[1],'2.2.0','>=')&&version_compare($match[1],'3.0.0','<')&&!$missing;
            $result[$name]=['path'=>$path,'version'=>$match[1]??null,'compatible'=>$ok,'capabilities'=>array_keys($flags),'sha256'=>hash_file('sha256',$path)];
            if($name==='syncoid'){$result[$name]['compressions']=['none'];foreach(['gzip','lzop','lz4','zstd']as$compression)if(preg_match('/\b'.preg_quote($compression,'/').'\b/',$text)&&(zfsmProtectionTrustedFile('/usr/bin/'.$compression,true)||zfsmProtectionTrustedFile('/bin/'.$compression,true)))$result[$name]['compressions'][]=$compression;}
            if(!$ok)$result['issues'][]=$name.': unsupported version or missing safety capabilities'.($missing?' ('.implode(', ',$missing).')':'').'.';
        }
        $result['compatible']=$result['sanoid']['compatible']&&$result['syncoid']['compatible'];
        $result['state']=$result['compatible']?($enabled?'healthy':'disabled'):'unhealthy';
        $result['visible']=$enabled&&$result['compatible'];
    }
    $result['configuration_status']=['status'=>'unavailable','message'=>'Backend is unavailable.'];
    $updater=zfsmProtectionCronUpdater();$result['scheduler_status']=['available'=>$updater!==null,'path'=>$updater,'owner'=>'Director cron / External read-only'];
    if($installed&&$result['compatible']){
        try{$store=zfsmProtectionReadStore();$native=zfsmSanoidRead();if($native['issues'])throw new RuntimeException(implode(' ',$native['issues']));$result['configuration_status']=['status'=>'valid','message'=>count($store['policies']).' managed policies, '.count($store['replications']).' managed replication jobs.'];}
        catch(Throwable$e){$result['configuration_status']=['status'=>'invalid','message'=>$e->getMessage()];$result['issues'][]='Configuration requires inspection.';}
        if(!$result['scheduler_status']['available'])$result['issues'][]='Unraid update_cron is unavailable; managed schedule activation is disabled.';
        if($result['configuration_status']['status']==='invalid'||!$result['scheduler_status']['available']){$result['state']='unhealthy';$result['visible']=false;}
    }
    $result['fingerprint']=hash('sha256',json_encode([$installed?$manifest:null,$installed?hash_file('sha256',$manifest):null,$result['sanoid'],$result['syncoid']],JSON_THROW_ON_ERROR));
    return $result;
}
function zfsmProtectionRequire(bool $interactive=true): array {
    $d=zfsmProtectionDetection();
    if(!$d['compatible']||($interactive&&!$d['visible']))throw new RuntimeException($d['issues']?implode(' ',$d['issues']):'Sanoid / Syncoid integration is disabled. Existing scheduled jobs are unchanged.');
    return $d;
}
function zfsmProtectionRequireExecution(): array {
    $d=zfsmProtectionRequire(false);
    if(!$d['enabled'])throw new RuntimeException('Sanoid / Syncoid integration is disabled; managed execution requires separate review.');
    return $d;
}
function zfsmProtectionSettings(array $request): array {
    $value=$request['enabled']??null;
    if(!in_array($value,['0','1'],true))throw new InvalidArgumentException('Choose enabled or disabled.');
    if($value==='1')zfsmProtectionRequire(false);
    $current=loadConfig(parse_plugin_cfg($GLOBALS['plugin'],true));
    $settings=['refresh_interval'=>(string)$current['refresh_interval'],'lazy_load'=>(string)$current['lazy_load'],'sanoid_integration'=>$value,'destructive_mode'=>(string)$current['destructive_mode'],'exclusion'=>$current['dataset_exclusion'],'directory_listing'=>implode("\n",$current['directory_listing']),'snap_max_days_alert'=>(string)$current['snap_max_days_alert'],'snap_pattern'=>$current['snap_pattern'],'snap_prefix'=>$current['snap_prefix']];
    return zfsmSaveSettings($settings);
}
function zfsmProtectionDirectory(): string {return zfsmJobDirectory(dirname($GLOBALS['plugin_config']).'/protection');}
function zfsmProtectionReadStore(): array {
    $file=zfsmProtectionDirectory().'/config.json';
    if(!file_exists($file))return ['version'=>1,'policies'=>[],'replications'=>[],'owned_snapshots'=>[]];
    if(is_link($file)||!is_file($file)||filesize($file)>4*1024*1024)throw new RuntimeException('Protection configuration is not a trusted regular file.');
    $data=json_decode(file_get_contents($file),true,32,JSON_THROW_ON_ERROR);
    if(!is_array($data)||($data['version']??null)!==1)throw new RuntimeException('Unsupported protection configuration; retained unchanged.');
    foreach(['policies','replications','owned_snapshots']as$key)if(!is_array($data[$key]??null))throw new RuntimeException('Invalid protection configuration.');
    if(array_key_exists('external_reviews',$data)){
        if(!is_array($data['external_reviews']))throw new RuntimeException('Invalid External ownership state; execution requires inspection.');
        foreach($data['external_reviews']as$id=>$record){
            if(!is_array($record)||!is_string($record['source_file']??null)||$id!=='source-'.substr(hash('sha256',$record['source_file']),0,16)||($record['state']??null)!=='transferred'||!in_array($record['definition']['type']??null,['policy','replication'],true)||!is_string($record['definition']['id']??null)||!preg_match('/^[a-f0-9]{1,32}$/D',$record['definition']['id'])||!is_bool($record['recursive']??null)||!is_array($record['scope']??null)||!$record['scope']||!is_array($record['guids']??null)||!$record['guids'])throw new RuntimeException('Invalid External ownership record; execution requires inspection.');
            foreach(['source_sha256','deactivation_fingerprint']as$key)if(!is_string($record[$key]??null)||!preg_match('/^[a-f0-9]{64}$/D',$record[$key]))throw new RuntimeException('Invalid External ownership fingerprint.');
            foreach($record['scope']as$name)if(!is_string($name)||$name===''||strlen($name)>2048||preg_match('/[\x00-\x1f]/',$name))throw new RuntimeException('Invalid External ownership scope.');
            foreach($record['guids']as$name=>$guid)if(!zfsmValidDatasetName($name)||!is_string($guid)||!preg_match('/^[1-9][0-9]*$/D',$guid))throw new RuntimeException('Invalid External ownership identity.');
        }
    }
    return $data;
}
function zfsmProtectionWriteStore(array $data): void {
    if(($data['version']??null)!==1)throw new InvalidArgumentException('Unsupported protection configuration.');
    $file=zfsmProtectionDirectory().'/config.json';$before=file_exists($file)?zfsmProtectionReadStore():null;
    if($before!==null)zfsmJobAtomicWrite($file.'.bak',$before);
    zfsmJobAtomicWrite($file,$data);
    if(zfsmProtectionReadStore()!==$data)throw new RuntimeException('Configuration readback failed; inspect the retained backup.');
}
function zfsmProtectionConfigLock(callable $fn,bool $deferBusy=false) {
    $file=zfsmProtectionDirectory().'/config.lock';if(is_link($file))throw new RuntimeException('Untrusted configuration lock.');
    $lock=@fopen($file,'c');if(!$lock)throw new RuntimeException('Protection configuration lock is unavailable.');
    if(!flock($lock,LOCK_EX|LOCK_NB,$wouldBlock)){fclose($lock);if($deferBusy&&$wouldBlock===1)return null;throw new RuntimeException('Protection configuration is being changed.');}
    try{return $fn();}finally{flock($lock,LOCK_UN);fclose($lock);}
}
function zfsmProtectionFingerprint(): string {
    $files=['/etc/sanoid/sanoid.conf','/etc/sanoid/sanoid.defaults.conf','/usr/share/sanoid/sanoid.defaults.conf','/boot/config/plugins/unRAID6-Sanoid/sanoid.conf'];$external=[];
    foreach($files as$file)if(is_file($file)){$external[$file]=is_link($file)?'symlink:'.readlink($file):hash_file('sha256',$file);}
    $credentials=zfsmProtectionDirectory().'/credentials.json';if(is_file($credentials))$external[$credentials]=hash_file('sha256',$credentials);
    $schedules=function_exists('zfsmProtectionSchedules')?zfsmProtectionSchedules():[];
    return hash('sha256',json_encode([zfsmProtectionReadStore(),$external,$schedules],JSON_THROW_ON_ERROR));
}
function zfsmProtectionScopeOverlap(string $a,string $b): bool {return $a===$b||str_starts_with($a,$b.'/')||str_starts_with($b,$a.'/');}
function zfsmProtectionPreview(array $value,string $secret,string $fingerprint): array {
    if($secret==='')throw new InvalidArgumentException('Preview signing secret is unavailable.');
    $id=bin2hex(random_bytes(16));$record=['expires'=>time()+600,'fingerprint'=>$fingerprint,'value'=>$value];
    $file=zfsmJobDirectory($GLOBALS['plugin_runtime'].'/protection-previews').'/'.$id.'.json';
    $count=0;foreach(glob(dirname($file).'/*.json')?:[]as$old){if(is_link($old))continue;if(filemtime($old)<time()-1200)@unlink($old);else$count++;}if($count>=200)throw new RuntimeException('Too many pending protection reviews; wait for expiry.');
    zfsmJobAtomicWrite($file,$record);
    return ['preview_id'=>$id,'token'=>hash_hmac('sha256',$id.json_encode($record,JSON_THROW_ON_ERROR),$secret),'expires'=>$record['expires'],'review'=>$value];
}
function zfsmProtectionConsumePreview(array $request,string $secret,string $fingerprint): array {
    $id=$request['preview_id']??'';if(!is_string($id)||!preg_match('/^[a-f0-9]{32}$/D',$id))throw new InvalidArgumentException('Fresh protection review is required.');
    $file=$GLOBALS['plugin_runtime'].'/protection-previews/'.$id.'.json';
    if(is_link($file)||!is_file($file)||filesize($file)>4*1024*1024)throw new RuntimeException('Preview is unavailable or already consumed.');
    $r=json_decode(file_get_contents($file),true,32,JSON_THROW_ON_ERROR);
    $token=hash_hmac('sha256',$id.json_encode($r,JSON_THROW_ON_ERROR),$secret);
    if(!is_string($request['token']??null)||!hash_equals($token,$request['token'])||($r['expires']??0)<time()||($r['fingerprint']??null)!==$fingerprint)throw new RuntimeException('Review expired or configuration/backend changed; refresh and review again.');
    if(function_exists('zfsmRequestJobReviewContext'))zfsmRequestJobReviewContext($r['value']);
    if(!unlink($file))throw new RuntimeException('Unable to consume review safely.');
    return $r['value'];
}
