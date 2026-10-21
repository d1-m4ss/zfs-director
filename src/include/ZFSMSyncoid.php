<?php
function zfsmSyncoidJob(array $input): array {
    $allowed=['id','name','source','source_guid','target','target_guid','mode','host','user','port','credential','recursive','exclusions','enabled','schedule','compression','bandwidth','resume','no_sync_snap','use_hold','bookmark'];
    if(array_diff(array_keys($input),$allowed))throw new InvalidArgumentException('Unknown replication option. Arbitrary CLI arguments are not accepted.');
    $j=['id'=>$input['id']??bin2hex(random_bytes(8)),'name'=>$input['name']??'Replication','source'=>$input['source']??'','target'=>$input['target']??'','source_guid'=>$input['source_guid']??null,'target_guid'=>$input['target_guid']??null,'mode'=>$input['mode']??'local','host'=>$input['host']??'','user'=>$input['user']??'root','port'=>(string)($input['port']??'22'),'credential'=>$input['credential']??'','schedule'=>$input['schedule']??'0 * * * *','compression'=>$input['compression']??'none','bandwidth'=>$input['bandwidth']??'','owner'=>'managed'];
    if(!is_string($j['id'])||!preg_match('/^[a-f0-9]{1,32}$/D',$j['id'])||!is_string($j['name'])||$j['name']===''||strlen($j['name'])>120||preg_match('/[\x00-\x1f]/',$j['name']))throw new InvalidArgumentException('Invalid replication identity/name.');
    foreach(['source','target']as$key)if(!zfsmValidDatasetName($j[$key])||!preg_match('/^[A-Za-z0-9_.:\/-]+$/D',$j[$key]))throw new InvalidArgumentException('Syncoid paths must be valid dataset names without whitespace or shell syntax.');
    if(!in_array($j['mode'],['local','remote'],true))throw new InvalidArgumentException('Choose local or remote destination.');
    if($j['mode']==='local'&&zfsmProtectionScopeOverlap($j['source'],$j['target']))throw new InvalidArgumentException('Source and destination scopes overlap.');
    if(!is_string($j['host'])||!is_string($j['user'])||!is_string($j['credential'])||!ctype_digit($j['port'])||(int)$j['port']<1||(int)$j['port']>65535)throw new InvalidArgumentException('Invalid SSH connection.');
    if($j['mode']==='remote'&&(!preg_match('/^(?!-)[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/D',$j['host'])||!preg_match('/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/D',$j['user'])||!preg_match('/^[A-Za-z0-9_-]{1,64}$/D',$j['credential'])))throw new InvalidArgumentException('Remote destination requires a hostname, user and existing credential reference.');
    foreach(['enabled'=>true,'recursive'=>false,'resume'=>true,'no_sync_snap'=>false,'use_hold'=>false,'bookmark'=>false]as$key=>$default){$v=$input[$key]??$default;if(!in_array($v,[true,false,1,0,'1','0'],true))throw new InvalidArgumentException('Invalid replication flag '.$key);$j[$key]=in_array($v,[true,1,'1'],true);}
    if($j['bookmark']&&!$j['no_sync_snap'])throw new InvalidArgumentException('Native bookmarks require no-sync-snap.');
    if(!in_array($j['compression'],['none','lzop','gzip','lz4','zstd'],true)||!is_string($j['bandwidth'])||($j['bandwidth']!==''&&!preg_match('/^[1-9][0-9]{0,9}[kmg]?$/D',$j['bandwidth'])))throw new InvalidArgumentException('Choose a supported compression and bandwidth limit.');
    $j['exclusions']=$input['exclusions']??[];if(!is_array($j['exclusions'])||count($j['exclusions'])>200)throw new InvalidArgumentException('Invalid replication exclusions.');foreach($j['exclusions']as$e)if(!is_string($e)||!preg_match('/^[A-Za-z0-9_.:\/-]+$/D',$e)||!str_starts_with($e,$j['source'].'/'))throw new InvalidArgumentException('Replication exclusions must be descendants of the source.');
    if($j['exclusions']&&!$j['recursive'])throw new InvalidArgumentException('Exclusions require recursive replication.');zfsmProtectionCron($j['schedule']);return $j;
}
function zfsmSyncoidCredential(string $reference): array {
    $file=zfsmProtectionDirectory().'/credentials.json';
    if(!zfsmProtectionTrustedFile($file)||filesize($file)>65536)throw new RuntimeException('No trusted credential registry. Configure a root-owned credential reference first.');
    $credentials=json_decode(file_get_contents($file),true,8,JSON_THROW_ON_ERROR);$entry=$credentials[$reference]??null;
    foreach(['keyfile','known_hosts']as$key)if(!is_string($entry[$key]??null)||!preg_match('#^/[A-Za-z0-9_./-]+$#D',$entry[$key]))throw new RuntimeException('Credential paths must be absolute trusted paths without shell syntax or whitespace.');
    if(!is_array($entry)||!zfsmProtectionTrustedFile($entry['keyfile']??null)||!zfsmProtectionTrustedFile($entry['known_hosts']??null))throw new RuntimeException('Credential reference or trusted known_hosts is unavailable.');
    if((fileperms($entry['keyfile'])&0077)!==0)throw new RuntimeException('Private SSH key permissions must exclude group and other access.');return $entry;
}
function zfsmSyncoidSsh(array $j,array $zfsArgs): array {
    $c=zfsmSyncoidCredential($j['credential']);
    foreach($zfsArgs as$a)if(!is_string($a)||str_contains($a,"\0"))throw new InvalidArgumentException('Invalid remote ZFS argument.');
    return ['binary'=>'/usr/bin/ssh','args'=>['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','-o','UserKnownHostsFile='.$c['known_hosts'],'-i',$c['keyfile'],'-p',$j['port'],$j['user'].'@'.$j['host'],'zfs '.implode(' ',array_map('escapeshellarg',$zfsArgs))]];
}
function zfsmSyncoidCall(array $j,bool $remote,array $args): array {
    if(!$remote)return zfsmProtectionProbe('zfs',$args);
    $ssh=zfsmSyncoidSsh($j,$args);return zfsmProtectionProbe($ssh['binary'],$ssh['args']);
}
function zfsmSyncoidCapabilities(array $j,array $d): array {
    $receive=zfsmSyncoidCall($j,$j['mode']==='remote',['receive']);$send=zfsmSyncoidCall($j,false,['send']);
    $resume=preg_match('/\[-[A-Za-z]*s[A-Za-z]*\]/',$receive['output']??'')===1&&preg_match('/(?:^|\s)-t(?:\s|$)/',$send['output']??'')===1;
    return ['flags'=>$d['syncoid']['capabilities'],'resume'=>$resume,'compressions'=>$d['syncoid']['compressions']??['none']];
}
function zfsmSyncoidArgv(array $j,array $caps): array {
    $flags=$caps['flags'];foreach(['--no-rollback','--recvoptions','--sshoption','--identifier','--no-clone-handling']as$f)if(!in_array($f,$flags,true))throw new RuntimeException('Installed Syncoid lacks required safety capability '.$f);
    $args=['--no-rollback','--recvoptions=u','--identifier=zfsd-'.$j['id'],'--sshoption=BatchMode=yes','--sshoption=StrictHostKeyChecking=yes','--sshoption=ConnectTimeout=15','--sshoption=ServerAliveInterval=15','--sshoption=ServerAliveCountMax=2'];
    if($j['resume']&&!$caps['resume'])throw new RuntimeException('Resumable receive is not verified on source and receiver; inspect capabilities.');
    foreach(['recursive'=>'--recursive','no_sync_snap'=>'--no-sync-snap','use_hold'=>'--use-hold','bookmark'=>'--create-bookmark']as$key=>$flag)if($j[$key]){if(!in_array($flag,$flags,true))throw new RuntimeException('Installed Syncoid does not support '.$flag);$args[]=$flag;}
    if(!$j['resume']){if(!in_array('--no-resume',$flags,true))throw new RuntimeException('Unable to disable unverified resume support.');$args[]='--no-resume';}
    if(in_array('--no-clone-handling',$flags,true))$args[]='--no-clone-handling';
    if(!in_array('--compress',$flags,true))throw new RuntimeException('Installed Syncoid compression capability is unknown.');$args[]='--compress='.$j['compression'];
    if(!in_array($j['compression'],$caps['compressions']??['none'],true))throw new RuntimeException('Selected compression is not verified in installed Syncoid help and executables.');
    if($j['bandwidth']!==''){if(!in_array('--source-bwlimit',$flags,true))throw new RuntimeException('Bandwidth option is unsupported.');$args[]='--source-bwlimit='.$j['bandwidth'];}
    foreach($j['exclusions']as$e){if(!in_array('--exclude-datasets',$flags,true))throw new RuntimeException('Dataset exclusions are unsupported.');$args[]='--exclude-datasets=^'.preg_quote($e,'~').'(?:/|$)';}
    if($j['mode']==='remote'){$c=zfsmSyncoidCredential($j['credential']);foreach(['--sshkey','--sshport']as$f)if(!in_array($f,$flags,true))throw new RuntimeException('Required SSH credential option is unsupported.');$args[]='--sshkey='.$c['keyfile'];$args[]='--sshport='.$j['port'];$args[]='--sshoption=IdentitiesOnly=yes';$args[]='--sshoption=UserKnownHostsFile='.$c['known_hosts'];}
    $args[]=$j['source'];$args[]=$j['mode']==='remote'?$j['user'].'@'.$j['host'].':'.$j['target']:$j['target'];return $args;
}
function zfsmSyncoidInventory(array $j,bool $target): array {
    $root=$j[$target?'target':'source'];$r=zfsmSyncoidCall($j,$target&&$j['mode']==='remote',['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o','name,type,guid,creation,createtxg',$root]);
    if(($r['code']??1)!==0){
        // The dataset may legitimately be new, but transport/permission errors
        // must not be reinterpreted as a missing destination.
        if(preg_match('/dataset does not exist/i',$r['output']??'')){if($target)return [];throw new RuntimeException('Source dataset is missing; inspect the definition before retrying.');}
        $failure=zfsmSyncoidFailure($r['output']??'',(int)($r['code']??1));throw new RuntimeException('Unable to inspect '.($target?'destination':'source').' snapshot GUID inventory. '.$failure['reason']);
    }
    $tree=[];$snaps=[];
    foreach(preg_split('/\r?\n/',trim($r['output']),-1,PREG_SPLIT_NO_EMPTY)as$line){$v=explode("\t",$line);if(count($v)!==5||!preg_match('/^[1-9][0-9]*$/D',$v[2]))throw new RuntimeException('Malformed replication inventory.');[$name,$type,$guid,$created,$txg]=$v;$owner=explode('@',$name,2)[0];if($owner!==$root&&!str_starts_with($owner,$root.'/'))throw new RuntimeException('Replication inventory escaped dataset scope.');$rel=substr($owner,strlen($root));if($rel!==''&&!$j['recursive'])continue;$source=$j['source'].$rel;$excluded=false;foreach($j['exclusions']as$e)if($source===$e||str_starts_with($source,$e.'/'))$excluded=true;if($excluded)continue;
        if($type==='snapshot'){if(!zfsmValidSnapshotName($name)||!ctype_digit($created)||!ctype_digit($txg))throw new RuntimeException('Malformed snapshot lineage.');$snaps[$rel][$guid]=['name'=>explode('@',$name,2)[1],'creation'=>(int)$created,'txg'=>$txg];}
        elseif(in_array($type,['filesystem','volume'],true)&&zfsmValidDatasetName($name)&&!isset($tree[$rel]))$tree[$rel]=['guid'=>$guid,'snapshots'=>[],'resume'=>false];else throw new RuntimeException('Malformed dataset identity.');
    }
    if(!isset($tree['']))throw new RuntimeException('Replication root identity is missing.');foreach($snaps as$rel=>$rows){if(!isset($tree[$rel]))throw new RuntimeException('Snapshot owner is missing.');uasort($rows,fn($a,$b)=>strlen($a['txg'])<=>strlen($b['txg'])?:strcmp($a['txg'],$b['txg']));$tree[$rel]['snapshots']=$rows;}
    if($target){$tokens=zfsmSyncoidCall($j,$j['mode']==='remote',['get','-H','-r','-o','name,value','receive_resume_token',$root]);if(($tokens['code']??1)!==0)throw new RuntimeException('Unable to inspect receiver resume state.');foreach(preg_split('/\r?\n/',trim($tokens['output']),-1,PREG_SPLIT_NO_EMPTY)as$line){$v=explode("\t",$line);if(count($v)!==2)throw new RuntimeException('Malformed receiver resume state.');$rel=substr($v[0],strlen($root));if(isset($tree[$rel]))$tree[$rel]['resume']=$v[1]!=='-';}}
    return $tree;
}
function zfsmSyncoidExpected(array $source): array {
    $expected=[];foreach($source as$rel=>$row){$snaps=$row['snapshots'];$key=array_key_last($snaps);if($key!==null)$expected[$rel]=(string)$key;}return $expected;
}
function zfsmSyncoidFailure(string $output,int $exit): array {
    foreach([
        'insufficient_space'=>['/no space left|out of space|quota exceeded/i','Receiver reports insufficient space or quota. Partial data is retained; free space and inspect before retrying.'],
        'host_identity'=>['/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|no .*host key is known/i','SSH host identity is untrusted or changed. Inspect the trusted known_hosts entry; Director will not accept a new key automatically.'],
        'ssh_authentication'=>['/permission denied \(publickey|authentication failed|no supported authentication/i','SSH authentication failed. Inspect the configured credential reference and server authorization.'],
        'ssh_timeout'=>['/connection timed out|operation timed out|connection refused|no route to host|could not resolve hostname/i','Destination connection is unavailable or timed out. Inspect host, port and network before retrying.'],
        'resume_unavailable'=>['/cannot resume|invalid resume|resume token.*(?:invalid|unsupported)/i','Resume state could not be used safely. Partial data is retained; inspect the source checkpoint and receiver token.'],
    ]as$code=>$match)if(preg_match($match[0],$output))return ['error_code'=>$code,'reason'=>$match[1]];
    return ['error_code'=>'native_failure','reason'=>'Native transfer failed ('.($exit>=0?'exit '.$exit:'exit unavailable').'). Inspect source, receiver and retained partial state before retrying.'];
}
function zfsmSyncoidVerify(array $before,array $after,int $exit): array {
    $r=['outcome'=>'unknown','exit_code'=>$exit,'verified'=>false,'checkpoints'=>[],'lag_seconds'=>null,'reason'=>'Snapshot GUID readback is unavailable.'];
    if(!is_array($before['source']??null)||!is_array($after['source']??null)||!is_array($after['target']??null))return $r;
    foreach($before['source']as$rel=>$row)if(($after['source'][$rel]['guid']??null)!==$row['guid'])return array_replace($r,['outcome'=>'recovery_required','reason'=>'Source dataset identity changed or disappeared.']);
    foreach($before['target']??[]as$rel=>$row)if(($after['target'][$rel]['guid']??null)!==$row['guid'])return array_replace($r,['outcome'=>'recovery_required','reason'=>'Destination dataset identity changed or disappeared.']);
    if($exit!==0){$partial=(bool)array_filter($after['target'],fn($row)=>!empty($row['resume']));return array_replace($r,['outcome'=>$partial?'interrupted':'failed','reason'=>$partial?'Partial receive retained; inspect resumable state.':'Syncoid process failed; inspect before retrying.']);}
    $expected=$before['expected']??[];if(count($expected)!==count($before['source']))return array_replace($r,['outcome'=>'blocked','reason'=>'No verified source checkpoint for every effective dataset.']);
    $advanced=false;$lag=0;
    foreach($expected as$rel=>$guid){$src=$after['source'][$rel]['snapshots'][$guid]??null;$target=$after['target'][$rel]['snapshots'][$guid]??null;
        if(!$src||!$target)return array_replace($r,['outcome'=>'blocked','reason'=>'Expected source checkpoint was not confirmed on destination'.($rel!==''?' child '.$rel:'').'. Exit code alone is insufficient.']);
        $advanced=$advanced||!isset($before['target'][$rel]['snapshots'][$guid]);$r['checkpoints'][$rel]=['guid'=>(string)$guid,'source_snapshot'=>$src['name'],'target_snapshot'=>$target['name'],'creation'=>$src['creation']];
        $latest=max(array_column($after['source'][$rel]['snapshots'],'creation'));$lag=max($lag,$latest-$src['creation']);
    }
    return array_replace($r,['outcome'=>$advanced?'completed':'up_to_date','verified'=>true,'lag_seconds'=>$lag,'reason'=>$advanced?'Expected snapshot GUIDs confirmed across the complete scope.':'Expected snapshot GUIDs were already present.']);
}
function zfsmSyncoidInspect(array $j): array {
    $source=zfsmSyncoidInventory($j,false);$target=zfsmSyncoidInventory($j,true);$blocked=[];
    if(isset($target['']['guid'])&&$target['']['guid']===$source['']['guid'])throw new RuntimeException('Source and destination have the same dataset identity.');
    foreach($target as$rel=>$row){if(!isset($source[$rel])){$blocked[]='Foreign destination dataset '.$rel;continue;}foreach($row['snapshots']as$guid=>$s)if(!isset($source[$rel]['snapshots'][$guid]))$blocked[]='Destination has a snapshot outside source lineage: '.$rel.'@'.$s['name'];}
    return ['source'=>$source,'target'=>$target,'expected'=>zfsmSyncoidExpected($source),'blockers'=>$blocked];
}
function zfsmSyncoidPreview(array $input,string $secret): array {
    $d=zfsmProtectionRequire();$j=zfsmSyncoidJob($input);$inspection=zfsmSyncoidInspect($j);$j['source_guid']=$inspection['source']['']['guid'];$j['target_guid']=$inspection['target']['']['guid']??null;
    if($j['enabled'])zfsmProtectionCheckDefinitionSchedules('replication',$j,zfsmProtectionSchedules());
    $caps=zfsmSyncoidCapabilities($j,$d);$argv=zfsmSyncoidArgv($j,$caps);$store=zfsmProtectionReadStore();foreach($store['replications']as$r)if($r['id']!==$j['id']&&$r['enabled']&&($r['mode']===$j['mode'])&&($r['host']===$j['host'])&&zfsmProtectionScopeOverlap($r['target'],$j['target']))throw new RuntimeException('Destination overlaps another managed replication.');
    $review=['type'=>'replication','value'=>$j,'inspection'=>$inspection,'capabilities'=>$caps,'argv'=>array_map(fn($a)=>str_starts_with($a,'--sshkey=')?'--sshkey=[credential reference]':$a,$argv),'warnings'=>array_merge($inspection['blockers'],['No rollback or automatic destination cleanup is permitted.','Remove job deletes only its definition.'])];return zfsmProtectionPreview($review,$secret,zfsmProtectionFingerprint().$d['fingerprint']);
}
function zfsmSyncoidCommit(array $request,string $secret): array {
    return zfsmProtectionConfigLock(function()use($request,$secret){$d=zfsmProtectionRequire();$r=zfsmProtectionConsumePreview($request,$secret,zfsmProtectionFingerprint().$d['fingerprint']);if(($r['type']??'')!=='replication')throw new InvalidArgumentException('Replication review is required.');$j=$r['value'];zfsmProtectionRequireIdleDefinition('replication',$j['id']);$actual=zfsmSyncoidInspect($j);if($actual['source']['']['guid']!==$j['source_guid']||($actual['target']['']['guid']??null)!==$j['target_guid'])throw new RuntimeException('Dataset identity changed; review again.');$s=zfsmProtectionReadStore();$s['replications'][$j['id']]=$j;zfsmProtectionApplyStore($s);return ['succeeded'=>[$j['id']=>'Replication saved and read back'],'failed'=>[],'replication'=>$j];});
}
function zfsmSyncoidRememberTarget(array &$definition,array $target): void {
    $guid=$target['']['guid']??null;
    if($definition['target_guid']!==null&&$guid!==$definition['target_guid'])throw new RuntimeException('Destination identity changed; fresh review required.');
    zfsmProtectionConfigLock(function()use(&$definition,$guid){$s=zfsmProtectionReadStore();$current=$s['replications'][$definition['id']]??null;
        if($current!==$definition)throw new RuntimeException('Replication definition changed during execution; receiver identity was not applied.');
        if($guid!==null&&$definition['target_guid']===null){$next=$definition;$next['target_guid']=$guid;$s['replications'][$next['id']]=$next;zfsmProtectionWriteStore($s);$definition=$next;}
    });
}
function zfsmSyncoidExecute(array $job): array {
    $d=zfsmProtectionRequireExecution();$s=zfsmProtectionReadStore();$j=$s['replications'][$job['definition_id']]??null;if(!$j)throw new RuntimeException('Replication definition was removed.');if(!$j['enabled'])return ['outcome'=>'skipped','reason'=>'Replication is disabled.','exit_code'=>null];
    $before=zfsmSyncoidInspect($j);if($before['source']['']['guid']!==$j['source_guid']||(($before['target']['']['guid']??null)!==$j['target_guid']))throw new RuntimeException('Source or destination identity changed; fresh review required.');if($before['blockers'])return ['outcome'=>'blocked','exit_code'=>null,'reason'=>implode(' ',$before['blockers']),'verified'=>false];
    $argv=zfsmSyncoidArgv($j,zfsmSyncoidCapabilities($j,$d));
    $lastProbe=0;$observe=function()use(&$j,&$lastProbe){if($j['target_guid']!==null||microtime(true)-$lastProbe<2)return;$lastProbe=microtime(true);try{$target=zfsmSyncoidInventory($j,true);}catch(Throwable$e){return;}if(isset($target['']['guid']))zfsmSyncoidRememberTarget($j,$target);};
    $result=function_exists('zfsmProtectionStream')?zfsmProtectionStream($job,$d['syncoid']['path'],$argv,$observe):runProcess($d['syncoid']['path'],$argv);
    try{$target=zfsmSyncoidInventory($j,true);}catch(Throwable$e){return ['outcome'=>'unknown','exit_code'=>$result['code']??1,'verified'=>false,'reason'=>'Process ended, but receiver readback failed. Any unbound receiver requires a fresh ownership review.'];}
    // Persist a discovered initial receiver even after cancellation or partial
    // failure. A crash before observation leaves target_guid null and a later
    // appearing receiver requires a new signed ownership review.
    zfsmSyncoidRememberTarget($j,$target);
    try{$after=['source'=>zfsmSyncoidInventory($j,false),'target'=>$target];}catch(Throwable$e){return ['outcome'=>'unknown','exit_code'=>$result['code']??1,'verified'=>false,'reason'=>'Process ended, but source readback failed. Receiver identity retained; inspect before retrying.'];}
    if(!$j['no_sync_snap']){
        // Native Syncoid creates its sync checkpoint after invocation. Select
        // only this job's identifier namespace, while proving source identities
        // against pre-run GUIDs. Other concurrent snapshots cannot substitute.
        foreach($before['source']as$rel=>$row){$candidate=null;foreach($after['source'][$rel]['snapshots']??[]as$guid=>$snap)if(str_starts_with($snap['name'],'syncoid_zfsd-'.$j['id'].'_'))$candidate=(string)$guid;if($candidate!==null)$before['expected'][$rel]=$candidate;else unset($before['expected'][$rel]);}
    }
    $out=zfsmSyncoidVerify($before,$after,(int)($result['code']??1));
    if(($result['code']??1)!==0)$out=array_replace($out,zfsmSyncoidFailure($result['output']??'',(int)($result['code']??1)));
    if(!empty($result['cancelled'])){$out['outcome']='interrupted';$out['verified']=false;$out['reason']='Owned process was cancelled; partial receiver state was retained.';}
    return $out;
}
