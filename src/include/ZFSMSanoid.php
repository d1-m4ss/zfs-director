<?php
function zfsmSanoidTiers(): array {return ['frequently','hourly','daily','weekly','monthly','yearly'];}
function zfsmSanoidTimingFields(): array {
    return ['frequent_period'=>[1,60],'hourly_min'=>[0,59],'daily_hour'=>[0,23],'daily_min'=>[0,59],'weekly_wday'=>[0,6],'weekly_hour'=>[0,23],'weekly_min'=>[0,59],'monthly_mday'=>[1,31],'monthly_hour'=>[0,23],'monthly_min'=>[0,59],'yearly_mon'=>[1,12],'yearly_mday'=>[1,31],'yearly_hour'=>[0,23],'yearly_min'=>[0,59]];
}
function zfsmSanoidTimingValue(string $key,$value): int {
    [$min,$max]=zfsmSanoidTimingFields()[$key];
    if((!is_int($value)&&!(is_string($value)&&ctype_digit($value)))||(int)$value<$min||(int)$value>$max)throw new InvalidArgumentException('Snapshot time '.$key.' must be a whole number from '.$min.' to '.$max.'.');
    return (int)$value;
}
function zfsmSanoidSnapshotDefaults(): array {
    try{$config=zfsmSanoidParse(file_get_contents(zfsmSanoidDefaultsFile()));$values=$config['template_default']??[];}catch(Throwable$e){return [];}
    return zfsmSanoidSnapshotEffective([],[],array_intersect_key($values,array_flip(array_merge(zfsmSanoidTiers(),array_keys(zfsmSanoidTimingFields())))));
}
function zfsmSanoidSnapshotEffective(array $policy,array $templates,array $defaults): array {
    $values=array_replace($defaults,$templates['default']??[]);
    foreach(array_filter(explode(',',$policy['use_template']??''))as$name)$values=array_replace($values,$templates[$name]??[]);
    $values=array_replace($values,array_filter($policy,fn($v)=>$v!==null&&$v!==''));$safe=[];
    foreach(array_merge(array_fill_keys(zfsmSanoidTiers(),[0,100000]),zfsmSanoidTimingFields())as$key=>[$min,$max]){if(!isset($values[$key]))continue;$v=$values[$key];if((is_int($v)||(is_string($v)&&ctype_digit($v)))&&(int)$v>=$min&&(int)$v<=$max)$safe[$key]=(int)$v;}
    return $safe;
}
function zfsmSanoidValidateSnapshotCalendar(array $values): void {
    // Native timelocal rejects nonexistent dates rather than skipping a month/year.
    if(($values['monthly']??0)>0&&($values['monthly_mday']??1)>28)throw new InvalidArgumentException('Monthly snapshots require a day from 1 to 28, valid in every month.');
    if(($values['yearly']??0)>0&&isset($values['yearly_mon'],$values['yearly_mday'])&&!checkdate((int)$values['yearly_mon'],(int)$values['yearly_mday'],2001))throw new InvalidArgumentException('Choose an annual snapshot date valid every year (February 1 to 28).');
}
function zfsmSanoidParse(string $text): array {
    if(strlen($text)>1048576||str_contains($text,"\0"))throw new InvalidArgumentException('Sanoid configuration exceeds supported size.');
    $result=[];$section=null;
    foreach(preg_split('/\r\n|\r|\n/',$text)as$line){
        $line=trim($line);if($line===''||str_starts_with($line,'#')||str_starts_with($line,';'))continue;
        if(preg_match('/^\[([^\]\r\n]+)\](?:\s*[#;].*)?$/D',$line,$m)){$section=$m[1];if(isset($result[$section])||(!str_starts_with($section,'template_')&&!zfsmValidDatasetName($section)))throw new InvalidArgumentException('Duplicate or invalid Sanoid section.');$result[$section]=[];continue;}
        if($section===null||!preg_match('/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/D',$line,$m)||isset($result[$section][$m[1]]))throw new InvalidArgumentException('Unsupported or duplicate Sanoid configuration line.');
        $result[$section][$m[1]]=trim(preg_replace('/\s+[;#].*$/','',$m[2])," \t\"'");
    }
    return $result;
}
function zfsmSanoidEffective(array $config,string $dataset): array {
    $effective=[];$parts=explode('/',$dataset);$ancestors=[];
    while($parts){array_unshift($ancestors,implode('/',$parts));array_pop($parts);}
    foreach($ancestors as$name){$values=$config[$name]??[];
        foreach(array_filter(array_map('trim',explode(',',$values['use_template']??'')))as$template){$t=$config['template_'.$template]??null;if(!is_array($t))throw new RuntimeException('Referenced Sanoid template is unavailable: '.$template);$effective=array_replace($effective,$t);}
        $effective=array_replace($effective,$values);
        if($name!==$dataset&&!in_array($effective['recursive']??'no',['yes','zfs'],true))$effective=[];
    }
    return $effective;
}
function zfsmSanoidPolicy(array $input): array {
    $allowed=array_merge(['id','name','dataset','source_guid','enabled','recursive','process_children_only','use_template','autosnap','autoprune','exclusions','schedule'],zfsmSanoidTiers(),array_keys(zfsmSanoidTimingFields()));
    if(array_diff(array_keys($input),$allowed))throw new InvalidArgumentException('Unknown policy field. Script hooks are not supported in managed policies.');
    $dataset=$input['dataset']??'';if(!zfsmValidDatasetName($dataset))throw new InvalidArgumentException('Choose a valid source dataset.');
    $p=['id'=>$input['id']??bin2hex(random_bytes(8)),'name'=>$input['name']??$dataset,'dataset'=>$dataset,'source_guid'=>$input['source_guid']??null,'use_template'=>$input['use_template']??'','schedule'=>$input['schedule']??'* * * * *','owner'=>'managed'];
    if(!is_string($p['id'])||!preg_match('/^[a-f0-9]{1,32}$/D',$p['id'])||!is_string($p['name'])||strlen($p['name'])>120||preg_match('/[\x00-\x1f]/',$p['name']))throw new InvalidArgumentException('Invalid policy identity/name.');
    if(!is_string($p['use_template'])||($p['use_template']!==''&&!preg_match('/^[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*$/D',$p['use_template'])))throw new InvalidArgumentException('Invalid Sanoid template reference.');
    foreach(['enabled'=>true,'recursive'=>false,'process_children_only'=>false,'autosnap'=>true,'autoprune'=>false]as$key=>$default){$v=$input[$key]??$default;if(!in_array($v,[true,false,'0','1',0,1],true))throw new InvalidArgumentException('Invalid policy flag '.$key);$p[$key]=in_array($v,[true,'1',1],true);}
    foreach(zfsmSanoidTiers()as$t){$v=$input[$t]??null;if($v===null||$v===''){$p[$t]=null;continue;}if((!is_int($v)&&!(is_string($v)&&ctype_digit($v)))||(int)$v<0||(int)$v>100000)throw new InvalidArgumentException('Retention counts must be whole numbers from 0 to 100000.');$p[$t]=(int)$v;}
    foreach(zfsmSanoidTimingFields()as$key=>$range)if(isset($input[$key])&&$input[$key]!=='')$p[$key]=zfsmSanoidTimingValue($key,$input[$key]);
    $p['exclusions']=$input['exclusions']??[];if(!is_array($p['exclusions'])||count($p['exclusions'])>200)throw new InvalidArgumentException('Invalid exclusions.');
    foreach($p['exclusions']as$e)if(!is_string($e)||!zfsmValidDatasetName($e)||!str_starts_with($e,$dataset.'/'))throw new InvalidArgumentException('Exclusions must be descendants of the source.');
    if($p['process_children_only']&&!$p['recursive'])throw new InvalidArgumentException('Process children only requires recursive scope.');
    zfsmProtectionCron($p['schedule']);return $p;
}
function zfsmProtectionCron($schedule): string {
    if(!is_string($schedule)||strlen($schedule)>100||!preg_match('/^[0-9*\/, -]+$/D',$schedule))throw new InvalidArgumentException('Use a numeric five-field cron schedule.');
    $fields=preg_split('/\s+/',trim($schedule));if(count($fields)!==5)throw new InvalidArgumentException('Use a five-field cron schedule.');
    foreach($fields as$i=>$field){foreach(explode(',',$field)as$part){if(!preg_match('/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/D',$part,$m))throw new InvalidArgumentException('Invalid cron expression.');$max=[59,23,31,12,7][$i];$min=$i===2||$i===3?1:0;if(isset($m[2])&&((int)$m[2]<1||(int)$m[2]>$max+1))throw new InvalidArgumentException('Invalid cron interval.');if($m[1]!=='*'){$r=explode('-',$m[1]);foreach($r as$n)if((int)$n<$min||(int)$n>$max)throw new InvalidArgumentException('Cron value is outside its field range.');if(count($r)===2&&(int)$r[0]>(int)$r[1])throw new InvalidArgumentException('Cron range must be ascending.');}}}
    return implode(' ',$fields);
}
function zfsmSanoidScope(array $p,array $datasets): array {
    $scope=[];foreach($datasets as$ds){if($ds!==$p['dataset']&&(!$p['recursive']||!str_starts_with($ds,$p['dataset'].'/')))continue;if($ds===$p['dataset']&&$p['process_children_only'])continue;$exclude=false;foreach($p['exclusions']as$e)if($ds===$e||str_starts_with($ds,$e.'/'))$exclude=true;if(!$exclude)$scope[]=$ds;}sort($scope,SORT_STRING);return $scope;
}
function zfsmSanoidPolicyConflicts(array $p,array $policies): void {
    foreach($policies as$other){if(($other['id']??null)===($p['id']??'')||($other['enabled']??true)===false)continue;
        if($p['dataset']===$other['dataset']||(!empty($p['recursive'])&&str_starts_with($other['dataset'],$p['dataset'].'/'))||(!empty($other['recursive'])&&str_starts_with($p['dataset'],$other['dataset'].'/')))throw new RuntimeException('Policy overlaps '.($other['owner']??'unknown').' policy on '.$other['dataset'].'. Review ownership/schedules first.');
    }
}
function zfsmSanoidConfig(array $policies,array $templates=[],bool $prune=false): string {
    $text="# Managed by ZFS Director. External configuration is never rewritten.\n";
    foreach($policies as$p){$text.='['.$p['dataset']."]\n";
        if($p['use_template']!=='')$text.='use_template = '.$p['use_template']."\n";
        foreach(['recursive','process_children_only','autosnap']as$key)$text.=$key.' = '.($p['enabled']&&$p[$key]?'yes':'no')."\n";
        $text.='autoprune = '.($prune&&$p['enabled']&&$p['autoprune']?'yes':'no')."\n";
        foreach(zfsmSanoidTiers()as$t)if($p[$t]!==null)$text.=$t.' = '.$p[$t]."\n";
        foreach(zfsmSanoidTimingFields()as$key=>$range)if(isset($p[$key])&&$p[$key]!=='')$text.=$key.' = '.zfsmSanoidTimingValue($key,$p[$key])."\n";
        foreach($p['exclusions']as$e)$text.="\n[$e]\nrecursive = yes\nautosnap = no\nautoprune = no\n";
        $text.="\n";
    }
    foreach($templates as$name=>$values){if(!preg_match('/^[A-Za-z0-9_-]+$/D',$name))throw new InvalidArgumentException('Invalid template name.');$text.='[template_'.$name."]\n";foreach(zfsmSanoidTiers()as$t)if(isset($values[$t])&&ctype_digit((string)$values[$t]))$text.=$t.' = '.(int)$values[$t]."\n";foreach(zfsmSanoidTimingFields()as$key=>$range)if(isset($values[$key])&&$values[$key]!=='')$text.=$key.' = '.zfsmSanoidTimingValue($key,$values[$key])."\n";$text.="\n";}
    zfsmSanoidParse($text);return $text;
}
function zfsmSanoidRead(): array {
    $store=zfsmProtectionReadStore();$policies=array_values($store['policies']);$templates=[];$issues=[];$sources=[];
    foreach(['/etc/sanoid/sanoid.conf','/boot/config/plugins/unRAID6-Sanoid/sanoid.conf']as$file){if(!is_file($file))continue;try{if(is_link($file)||filesize($file)>1048576)throw new RuntimeException('External configuration is not a regular supported file.');$hash=hash_file('sha256',$file);if(in_array($hash,$sources,true))continue;$sources[]=$hash;$c=zfsmSanoidParse(file_get_contents($file));foreach($c as$name=>$values)if(str_starts_with($name,'template_'))$templates[substr($name,9)]=array_intersect_key($values,array_flip(array_merge(zfsmSanoidTiers(),array_keys(zfsmSanoidTimingFields()),['autosnap','autoprune'])));else{$v=zfsmSanoidEffective($c,$name);$policies[]=['id'=>'external-'.substr(hash('sha256',$file.$name),0,12),'dataset'=>$name,'name'=>$name,'owner'=>'external','file'=>$file,'recursive'=>in_array($v['recursive']??'no',['yes','zfs'],true),'enabled'=>(($v['autosnap']??'yes')==='yes'||($v['autoprune']??'yes')==='yes'),'snapshot_effective'=>zfsmSanoidSnapshotEffective($v,[],array_replace(zfsmSanoidSnapshotDefaults(),$c['template_default']??[])),'effective'=>array_intersect_key($v,array_flip(array_merge(zfsmSanoidTiers(),array_keys(zfsmSanoidTimingFields()),['use_template','recursive','process_children_only','autosnap','autoprune'])))];}}catch(Throwable$e){$issues[]=$file.': '.$e->getMessage();}}
    return ['policies'=>$policies,'templates'=>$templates,'issues'=>$issues,'snapshot_naming'=>'Native Sanoid autosnap_<timestamp>_<tier>; ownership requires GUID evidence.'];
}
function zfsmSanoidInventory(string $dataset): array {
    $r=runProcess('zfs',['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o','name,type,guid,creation,userrefs',$dataset]);if(($r['code']??1)!==0)throw new RuntimeException('Unable to read policy dataset/snapshot inventory.');$datasets=[];$snaps=[];
    foreach(preg_split('/\r?\n/',trim($r['output']),-1,PREG_SPLIT_NO_EMPTY)as$line){$v=explode("\t",$line);if(count($v)!==5||!preg_match('/^[1-9][0-9]*$/D',$v[2]))throw new RuntimeException('Malformed policy inventory.');[$name,$type,$guid,$creation,$refs]=$v;$owner=explode('@',$name,2)[0];if($owner!==$dataset&&!str_starts_with($owner,$dataset.'/'))throw new RuntimeException('Policy inventory escaped source scope.');if($type==='snapshot'){if(!zfsmValidSnapshotName($name)||!ctype_digit($creation)||!ctype_digit($refs)||isset($snaps[$name]))throw new RuntimeException('Invalid snapshot retention evidence.');$snaps[$name]=['name'=>$name,'guid'=>$guid,'creation'=>(int)$creation,'holds'=>(int)$refs>0];}elseif(in_array($type,['filesystem','volume'],true)&&zfsmValidDatasetName($name)&&!isset($datasets[$name]))$datasets[$name]=$guid;else throw new RuntimeException('Invalid dataset inventory.');}
    if(!isset($datasets[$dataset]))throw new RuntimeException('Policy source is missing.');foreach($snaps as$name=>&$s){$s['dataset_guid']=$datasets[explode('@',$name,2)[0]]??null;if($s['dataset_guid']===null)throw new RuntimeException('Snapshot owner identity is missing.');}unset($s);return ['datasets'=>$datasets,'snapshots'=>$snaps];
}
function zfsmSanoidPreview(array $input,string $secret): array {
    $d=zfsmProtectionRequire();$existing=zfsmSanoidRead();if($existing['issues'])throw new RuntimeException(implode(' ',$existing['issues']));$p=zfsmSanoidPolicy($input);zfsmSanoidPolicyConflicts($p,$existing['policies']);
    foreach(array_filter(explode(',',$p['use_template']))as$t)if(!isset($existing['templates'][$t]))throw new InvalidArgumentException('Template is unavailable.');
    if($p['enabled']&&$p['autosnap'])zfsmSanoidValidateSnapshotCalendar(zfsmSanoidSnapshotEffective($p,$existing['templates'],zfsmSanoidSnapshotDefaults()));
    if($p['enabled'])zfsmProtectionCheckDefinitionSchedules('policy',$p,zfsmProtectionSchedules());
    $inventory=zfsmSanoidInventory($p['dataset']);$p['source_guid']=$inventory['datasets'][$p['dataset']];$scope=zfsmSanoidScope($p,array_keys($inventory['datasets']));if(!$scope)throw new RuntimeException('Policy has no effective datasets.');
    $store=zfsmProtectionReadStore();$protected=[];foreach($inventory['snapshots']as$name=>$s)if(($store['owned_snapshots'][$name]['guid']??null)!==$s['guid'])$protected[]=$name;
    $native=zfsmSanoidInvoke($p,$scope,true,$d['sanoid']['path'],['--readonly','--take-snapshots','--prune-snapshots']);
    if(($native['code']??1)!==0)throw new RuntimeException('Native Sanoid read-only configuration validation failed.');
    preg_match_all('/^taking (?:dst )?snapshot ([^\r\n]+@[^\s]+)(?:\s|$)/m',$native['output']??'',$matches);
    $nativePlan=['would_create'=>array_values(array_unique($matches[1])),'retention'=>zfsmSanoidRetentionPlan($native['output']??'',$inventory['snapshots'],$store['owned_snapshots'],zfsmSanoidReferences($p,$inventory['snapshots'],$store),$p['id'])];
    $review=['type'=>'policy','value'=>$p,'scope'=>$scope,'config'=>zfsmSanoidConfig([$p],$existing['templates']),'previous'=>isset($store['policies'][$p['id']])?zfsmSanoidConfig([$store['policies'][$p['id']]],$existing['templates']):'','native_plan'=>$nativePlan,'snapshot_effective'=>zfsmSanoidSnapshotEffective($p,$existing['templates'],zfsmSanoidSnapshotDefaults()),'protected_snapshots'=>$protected,'warnings'=>['Native naming does not establish ownership. Automatic pruning requires verified GUID provenance.','Pruning rechecks GUID, holds, clones and replication references at execution.','Configuration save does not run a job.'],'capability_fingerprint'=>$d['fingerprint']];
    return zfsmProtectionPreview($review,$secret,zfsmProtectionFingerprint().$d['fingerprint']);
}
function zfsmSanoidCommit(array $request,string $secret): array {
    return zfsmProtectionConfigLock(function()use($request,$secret){$d=zfsmProtectionRequire();$review=zfsmProtectionConsumePreview($request,$secret,zfsmProtectionFingerprint().$d['fingerprint']);if(($review['type']??'')!=='policy')throw new InvalidArgumentException('Policy review required.');$p=$review['value'];zfsmProtectionRequireIdleDefinition('policy',$p['id']);zfsmRequireIdentity($p['dataset'],$p['source_guid']);$s=zfsmProtectionReadStore();$s['policies'][$p['id']]=$p;zfsmProtectionApplyStore($s);return ['succeeded'=>[$p['id']=>'Policy saved and read back'],'failed'=>[],'policy'=>$p];});
}
function zfsmSanoidRetentionPlan(string $native,array $inventory,array $owned,array $references,?string $policyId=null): array {
    $candidates=[];$protected=[];preg_match_all('/^INFO: pruning (.+@[^\r\n]+?) \.\.\.\s*$/m',$native,$matches);
    foreach(array_unique($matches[1])as$name){if(!zfsmValidSnapshotName($name)||!isset($inventory[$name]))throw new RuntimeException('Native retention plan contains an unverified snapshot.');$s=$inventory[$name];$o=$owned[$name]??[];$safe=($o['guid']??null)===($s['guid']??null)&&($o['dataset_guid']??null)===($s['dataset_guid']??null)&&$policyId!==null&&($o['policy_id']??null)===$policyId&&empty($s['holds'])&&!in_array($name,$references,true);$row=['name'=>$name,'guid'=>$s['guid'],'dataset_guid'=>$s['dataset_guid'],'reason'=>$safe?'verified managed snapshot':'foreign, held, changed identity or replication reference'];if($safe)$candidates[]=$row;else$protected[]=$row;}
    return ['candidates'=>$candidates,'protected'=>$protected];
}
function zfsmProtectionWriteText(string $file,string $text): void {
    zfsmJobDirectory(dirname($file));if(is_link($file))throw new RuntimeException('Untrusted managed configuration path.');
    $temp=$file.'.'.bin2hex(random_bytes(8)).'.tmp';$h=@fopen($temp,'xb');if(!$h)throw new RuntimeException('Unable to stage managed configuration.');@chmod($temp,0600);
    try{if(fwrite($h,$text)!==strlen($text)||!fflush($h)||(function_exists('fsync')&&!fsync($h)))throw new RuntimeException('Unable to flush managed configuration.');fclose($h);$h=null;if(!rename($temp,$file))throw new RuntimeException('Unable to publish managed configuration.');zfsmAuditSyncDirectory(dirname($file));if(file_get_contents($file)!==$text)throw new RuntimeException('Managed configuration readback failed.');}finally{if(is_resource($h))fclose($h);if(is_file($temp))@unlink($temp);}
}
function zfsmSanoidDefaultsFile(): string {
    foreach(zfsmProtectionPaths()['defaults']??['/etc/sanoid/sanoid.defaults.conf','/usr/share/sanoid/sanoid.defaults.conf']as$candidate){$file=realpath($candidate);if($file!==false&&zfsmProtectionTrustedFile($file)&&filesize($file)<=1048576)return $file;}
    throw new RuntimeException('Trusted installed sanoid.defaults.conf is required.');
}
function zfsmSanoidPrepare(array $policy,array $scope,bool $prune=false): array {
    $external=zfsmSanoidRead();if($external['issues'])throw new RuntimeException(implode(' ',$external['issues']));zfsmSanoidPolicyConflicts($policy,$external['policies']);
    $defaults=zfsmSanoidDefaultsFile();
    $text=file_get_contents($defaults);$parsed=zfsmSanoidParse($text);foreach($parsed as$values)foreach($values as$key=>$v)if(str_ends_with($key,'_script')&&$v!==''&&$v!=='false')throw new RuntimeException('Managed execution refuses script hooks in native defaults.');
    $policies=[];foreach($scope as$ds){$p=$policy;$p['dataset']=$ds;$p['recursive']=false;$p['process_children_only']=false;$p['exclusions']=[];$policies[]=$p;}
    $base=zfsmJobDirectory($GLOBALS['plugin_runtime'].'/sanoid/'.$policy['id']);$dir=zfsmJobDirectory($base.'/invocations/'.bin2hex(random_bytes(16)));zfsmProtectionWriteText($dir.'/sanoid.defaults.conf',$text);zfsmProtectionWriteText($dir.'/sanoid.conf',zfsmSanoidConfig($policies,$external['templates'],$prune));
    return ['--configdir='.$dir,'--cache-dir='.zfsmJobDirectory($dir.'/cache'),'--run-dir='.zfsmJobDirectory($base.'/run'),'--force-update','--verbose'];
}
function zfsmSanoidInvoke(array $policy,array $scope,bool $prune,string $binary,array $args,int $readonlySeconds=15): array {
    // Sanoid defaults to --cron when no action is supplied. It has no
    // Director provenance knowledge; pruning is permitted here only as a plan.
    $readonly=in_array('--readonly',$args,true);
    if(!$args||array_diff($args,['--readonly','--take-snapshots','--prune-snapshots'])||count(array_unique($args))!==count($args)||(!in_array('--take-snapshots',$args,true)&&!in_array('--prune-snapshots',$args,true))||(!$readonly&&($prune||$args!==['--take-snapshots'])))throw new RuntimeException('Unsafe native Sanoid action; use snapshot-only execution or read-only retention planning.');
    if($policy['enabled']&&$policy['autosnap']&&in_array('--take-snapshots',$args,true)){$external=zfsmSanoidRead();zfsmSanoidValidateSnapshotCalendar(zfsmSanoidSnapshotEffective($policy,$external['templates'],zfsmSanoidSnapshotDefaults()));}
    $prepared=zfsmSanoidPrepare($policy,$scope,$prune);$dir=substr($prepared[0],strlen('--configdir='));
    try{return in_array('--readonly',$args,true)?zfsmProtectionProbe($binary,array_merge($prepared,$args),$readonlySeconds):runProcess($binary,array_merge($prepared,$args));}
    finally{foreach(glob($dir.'/cache/*')?:[]as$file)if(is_file($file)&&!is_link($file))@unlink($file);@rmdir($dir.'/cache');@unlink($dir.'/sanoid.conf');@unlink($dir.'/sanoid.defaults.conf');@rmdir($dir);}
}
function zfsmSanoidCreated(string $output,array $before,array $after,string $policyId): array {
    $owned=[];preg_match_all('/^taking (?:dst )?snapshot ([^\r\n]+@[^\s]+)(?:\s|$)/m',$output,$m);
    foreach(array_unique($m[1])as$name){$s=$after['snapshots'][$name]??null;if($s&&!isset($before['snapshots'][$name]))$owned[$name]=['guid'=>$s['guid'],'dataset_guid'=>$s['dataset_guid'],'policy_id'=>$policyId];}return $owned;
}
function zfsmSanoidReferences(array $policy,array $snapshots,array $store): array {
    $references=[];foreach($store['replications']as$r)if(zfsmProtectionScopeOverlap($policy['dataset'],$r['source']))foreach($snapshots as$name=>$snapshot){$owner=explode('@',$name,2)[0];if($owner===$r['source']||(!empty($r['recursive'])&&str_starts_with($owner,$r['source'].'/')))$references[]=$name;}return array_values(array_unique($references));
}
function zfsmSanoidExecute(array $job): array {
    $d=zfsmProtectionRequireExecution();$store=zfsmProtectionReadStore();$p=$store['policies'][$job['definition_id']]??null;if(!$p)throw new RuntimeException('Policy definition was removed.');if(!$p['enabled'])return ['outcome'=>'skipped','reason'=>'Policy is disabled.','exit_code'=>null];
    $before=zfsmSanoidInventory($p['dataset']);if($before['datasets'][$p['dataset']]!==$p['source_guid'])throw new RuntimeException('Source GUID changed; policy requires review.');
    $scope=zfsmSanoidScope($p,array_keys($before['datasets']));if(!$scope)throw new RuntimeException('Policy has no effective datasets.');
    $result=zfsmSanoidInvoke($p,$scope,false,$d['sanoid']['path'],['--take-snapshots']);$after=zfsmSanoidInventory($p['dataset']);
    foreach($scope as$ds)if(($after['datasets'][$ds]??null)!==($before['datasets'][$ds]??null))throw new RuntimeException('Dataset GUID changed during policy execution.');
    $created=($result['code']??1)===0?zfsmSanoidCreated($result['output']??'',$before,$after,$p['id']):[];
    zfsmProtectionConfigLock(function()use($created){$s=zfsmProtectionReadStore();$s['owned_snapshots']=array_replace($s['owned_snapshots'],$created);zfsmProtectionWriteStore($s);});
    $out=['outcome'=>($result['code']??1)===0?($created?'completed':'up_to_date'):'failed','exit_code'=>$result['code']??1,'snapshots_created'=>array_keys($created),'retention'=>['candidates'=>[],'protected'=>[]],'reason'=>($result['code']??1)===0?'Native snapshot result read back.':'Native Sanoid snapshot execution failed.'];
    if(($result['code']??1)!==0)return $out;
    if($p['autosnap']&&!$created&&!array_filter($after['snapshots'],fn($s)=>in_array(explode('@',$s['name'],2)[0],$scope,true))){$out['outcome']='blocked';$out['reason']='Sanoid returned 0 but no snapshot exists in the effective policy scope.';}
    if(!$p['autoprune'])return $out;
    // Background planning can inspect many snapshots; HTTP previews retain
    // their short budget. This longer phase remains strictly read-only.
    $plan=zfsmSanoidInvoke($p,$scope,true,$d['sanoid']['path'],['--prune-snapshots','--readonly'],90);
    if(($plan['code']??1)!==0||!str_contains($plan['output']??'','INFO: pruning snapshots...')){$out['outcome']='blocked';$out['reason']='Native retention plan could not be verified; no snapshots were pruned.';return $out;}
    $store=zfsmProtectionReadStore();$references=zfsmSanoidReferences($p,$after['snapshots'],$store);
    $retention=zfsmSanoidRetentionPlan($plan['output'],$after['snapshots'],$store['owned_snapshots'],$references,$p['id']);$out['retention']=$retention;$out['snapshots_pruned']=[];
    foreach($retention['candidates']as$c){$identity=zfsmRequireIdentity($c['name'],$c['guid']);$owner=explode('@',$c['name'],2)[0];zfsmRequireIdentity($owner,$c['dataset_guid']);$scopeReview=zfsmDestroyScope($c['name'],false);if(count($scopeReview['objects'])!==1||$scopeReview['objects'][0]['guid']!==$c['guid']||!$scopeReview['can_destroy'])throw new RuntimeException('Retention dependencies or GUID changed; snapshot retained.');$answer=deleteDatasetSnapshot($c['name'],0,$scopeReview);if($answer['failed'])throw new RuntimeException('Retention deletion did not complete; inspect the retained snapshot.');$out['snapshots_pruned'][]=$c['name'];}
    if($out['snapshots_pruned']&&$out['outcome']!=='blocked'){
        $out['outcome']=$retention['protected']?'completed_with_warnings':'completed';
        $out['reason']='Deleted '.count($out['snapshots_pruned']).' snapshot(s); kept '.count($retention['protected']).' protected snapshot(s). Protected snapshots were not changed.';
    }elseif($retention['protected']){$out['outcome']='blocked';$out['reason']='Retention preserved foreign/held snapshots or replication bases. Snapshot creation may have completed.';}
    return $out;
}
function zfsmSanoidDetachExternal(string $text,string $dataset): array {
    $config=zfsmSanoidParse($text);$values=$config[$dataset]??null;if(!is_array($values))throw new RuntimeException('External policy section is unavailable.');
    $allowed=array_merge(zfsmSanoidTiers(),array_keys(zfsmSanoidTimingFields()),['use_template','recursive','process_children_only','autosnap','autoprune']);
    if(array_diff(array_keys($values),$allowed))throw new RuntimeException('External policy includes advanced options or hooks; transfer requires manual inspection.');
    if(in_array($values['recursive']??'no',['yes','zfs'],true))throw new RuntimeException('Recursive external ownership requires a complete subtree review; automatic transfer is disabled.');
    foreach($config as$name=>$v)if(!str_starts_with($name,'template_')&&$name!==$dataset&&str_starts_with($dataset,$name.'/')&&in_array($v['recursive']??'no',['yes','zfs'],true))throw new RuntimeException('An external ancestor still owns this dataset; transfer the complete scope explicitly.');
    $chunks=preg_split('/(?=^\h*\[[^\]\r\n]+\])/m',$text);$after='';$removed='';
    foreach($chunks as$chunk){if(preg_match('/^\h*\[([^\]\r\n]+)\]/',$chunk,$m)&&$m[1]===$dataset)$removed.=$chunk;else$after.=$chunk;}
    if($removed==='')throw new RuntimeException('Unable to isolate exact external configuration bytes.');zfsmSanoidParse($after);return ['after'=>$after,'removed'=>$removed];
}
function zfsmSanoidImportPreview(string $externalId,string $secret): array {
    $d=zfsmProtectionRequire();$native=zfsmSanoidRead();$external=null;foreach($native['policies']as$p)if($p['id']===$externalId&&$p['owner']==='external')$external=$p;if(!$external)throw new RuntimeException('External policy is no longer available.');$file=$external['file'];
    if(!zfsmProtectionTrustedFile($file))throw new RuntimeException('External configuration is not a trusted regular file.');$before=file_get_contents($file);$change=zfsmSanoidDetachExternal($before,$external['dataset']);
    $input=['dataset'=>$external['dataset'],'name'=>'Imported '.$external['dataset'],'enabled'=>false];foreach($external['effective']as$key=>$v){if(in_array($key,zfsmSanoidTiers(),true)||$key==='use_template')$input[$key]=$v;elseif(in_array($key,['autosnap','autoprune','recursive','process_children_only'],true))$input[$key]=$v==='yes'?'1':'0';}
    $input['autoprune']=false;$p=zfsmSanoidPolicy($input);$p['source_guid']=zfsmReadIdentity($p['dataset'])['guid'];
    $review=['type'=>'policy_import','value'=>$p,'scope'=>[$p['dataset']],'config'=>zfsmSanoidConfig([$p],$native['templates']),'external_file'=>$file,'external_sha256'=>hash('sha256',$before),'external_diff'=>"--- External section\n".$change['removed']."\n+++ Removed from external config; imported managed definition stays disabled.\n",'warnings'=>['This explicit transfer removes only the reviewed standalone section, preserving other sections and scripts.','A full original configuration backup is retained. The imported managed definition remains disabled with automatic pruning off until separately reviewed and enabled.']];return zfsmProtectionPreview($review,$secret,zfsmProtectionFingerprint().$d['fingerprint']);
}
function zfsmSanoidImportCommit(array $request,string $secret): array {
    return zfsmProtectionConfigLock(function()use($request,$secret){$d=zfsmProtectionRequire();$r=zfsmProtectionConsumePreview($request,$secret,zfsmProtectionFingerprint().$d['fingerprint']);if(($r['type']??null)!=='policy_import')throw new InvalidArgumentException('Explicit ownership transfer review is required.');$file=$r['external_file'];if(!zfsmProtectionTrustedFile($file)||hash_file('sha256',$file)!==$r['external_sha256'])throw new RuntimeException('External configuration changed; review again.');$before=file_get_contents($file);$mode=fileperms($file)&0777;$p=$r['value'];zfsmRequireIdentity($p['dataset'],$p['source_guid']);$change=zfsmSanoidDetachExternal($before,$p['dataset']);$backup=zfsmJobDirectory(zfsmProtectionDirectory().'/external-backups').'/'.$p['id'].'.conf';zfsmProtectionWriteText($backup,$before);
        try{zfsmProtectionWriteText($file,$change['after']);chmod($file,$mode);$s=zfsmProtectionReadStore();$s['policies'][$p['id']]=$p;zfsmProtectionApplyStore($s);}catch(Throwable$e){zfsmProtectionWriteText($file,$before);chmod($file,$mode);throw new RuntimeException('Ownership transfer failed; original external configuration restored. '.$e->getMessage());}
        return ['succeeded'=>[$p['id']=>'Ownership transferred; imported policy is disabled pending schedule review'],'failed'=>[],'policy'=>$p,'rollback_configuration'=>$backup];});
}
