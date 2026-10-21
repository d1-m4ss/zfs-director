<?php
function zfsmQuotaInput($input) {
    $kinds=['user'=>'userquota','group'=>'groupquota','userobj'=>'userobjquota','groupobj'=>'groupobjquota'];
    $kind=$input['kind']??'';$id=$input['id']??'';$value=$input['value']??'';
    if(!is_string($kind)||!isset($kinds[$kind])||!is_string($id)||!preg_match('/^(?:0|[1-9][0-9]{0,9})$/D',$id)||zfsmRollbackDecimalCompare($id,'4294967294')>0)throw new InvalidArgumentException('Choose a quota type and a numeric POSIX UID/GID.');
    if($value==='none')$value='0';
    if(!is_string($value)||!preg_match('/^(?:0|[1-9][0-9]{0,18})$/D',$value)||zfsmRollbackDecimalCompare($value,'9223372036854775807')>0)throw new InvalidArgumentException('Quota must be an exact nonnegative byte/object count; use 0 for unlimited. User/group quotas are not inherited.');
    return ['property'=>$kinds[$kind].'@'.$id,'value'=>$value];
}
function zfsmQuotaParse($text,$objects) {
    $rows=[];foreach(preg_split('/\r\n|\r|\n/',rtrim($text,"\r\n"),-1,PREG_SPLIT_NO_EMPTY)?:[] as $line){
        $p=explode("\t",$line);if(count($p)!==($objects?6:4)||!in_array($p[0],['POSIX User','POSIX Group'],true)||!ctype_digit($p[1]))return null;
        foreach(array_slice($p,2) as $v)if(!ctype_digit($v)&&$v!=='none'&&$v!=='-')return null;
        $rows[]=['type'=>$p[0],'id'=>$p[1],'used'=>$p[2],'quota'=>$p[3]==='none'?'0':$p[3],'objects_used'=>$objects?$p[4]:null,'objects_quota'=>$objects?($p[5]==='none'?'0':$p[5]):null];if(count($rows)>4096)return null;
    }return $rows;
}
function zfsmQuotaOverview($name,$config=[]) {
    $identity=zfsmReadIdentity($name);if($identity['type']!=='filesystem')return ['status'=>'unavailable','reason'=>'User/group and object quotas apply to filesystems, not zvols.','rows'=>[]];
    $rows=[];$capabilities=[];
    foreach(['user'=>'userspace','group'=>'groupspace'] as $kind=>$cmd){
        $objects=true;$r=runProcess('zfs',[$cmd,'-Hnp','-o','type,name,used,quota,objused,objquota','-t','posix'.$kind,$name]);
        if(($r['code']??1)!==0){$objects=false;$r=runProcess('zfs',[$cmd,'-Hnp','-o','type,name,used,quota','-t','posix'.$kind,$name]);}
        $parsed=$r['code']===0?zfsmQuotaParse($r['output'],$objects):null;$capabilities[$kind]=$parsed!==null;$capabilities[$kind.'obj']=$parsed!==null&&$objects;
        if($parsed===null)return ['status'=>'unknown','reason'=>'Native quota inventory is unavailable or unsupported.','rows'=>[],'capabilities'=>$capabilities];
        $rows=array_merge($rows,$parsed);
    }
    zfsmRequireIdentity($name,$identity['guid']);
    return ['status'=>'known','guid'=>$identity['guid'],'rows'=>$rows,'alerts'=>zfsmQuotaUsageAlerts($rows,$config),'capabilities'=>$capabilities,'inheritance'=>'User/group quotas are local to this filesystem and are not inherited. Dataset quota/refquota and reservations remain in Properties.','scope'=>'Numeric POSIX identities; SMB SID quotas require native administration.'];
}
function zfsmQuotaUsageAlerts($rows,$config) {
    $alerts=[];foreach($rows as $row)foreach([['used','quota','bytes'],['objects_used','objects_quota','objects']] as [$used,$limit,$unit]){
        if(!ctype_digit((string)($row[$used]??''))||!ctype_digit((string)($row[$limit]??''))||(float)$row[$limit]<=0)continue;$percent=(float)$row[$used]/(float)$row[$limit]*100;
        if($percent>=(int)($config['space_warning_percent']??80))$alerts[]=['severity'=>$percent>=(int)($config['space_critical_percent']??90)?'error':'warning','reason'=>$row['type'].' '.$row['id'].' uses '.round($percent,1).'% of its '.$unit.' quota.'];
    }return $alerts;
}
function zfsmSpaceLimitBytes($value) {
    if($value==='none')return '0';
    if(!is_string($value)||!preg_match('/^(0|[1-9][0-9]{0,18})([KMGTPE]?)(?:B)?$/iD',$value,$m))throw new InvalidArgumentException('Use whole bytes or an integer K/M/G/T/P/E size. These limits are not inherited; use 0/none to clear the native limit.');
    $digits=$m[1];$power=$m[2]===''?0:strpos('KMGTPE',strtoupper($m[2]))+1;
    for($n=0;$n<$power;$n++){$carry=0;$next='';for($i=strlen($digits)-1;$i>=0;$i--){$v=(int)$digits[$i]*1024+$carry;$next=($v%10).$next;$carry=intdiv($v,10);}while($carry){$next=($carry%10).$next;$carry=intdiv($carry,10);}$digits=ltrim($next,'0')?:'0';}
    if(zfsmRollbackDecimalCompare($digits,'9223372036854775807')>0)throw new InvalidArgumentException('Space limit exceeds the supported exact integer range.');return $digits;
}
function zfsmSpacePropertyScope($name,$property,$value) {
    $identity=zfsmReadIdentity($name);
    if(!in_array($identity['type'],['filesystem','volume'],true)||!in_array($property,['quota','refquota','reservation','refreservation'],true)||($identity['type']==='volume'&&in_array($property,['quota','refquota'],true)))throw new InvalidArgumentException('This space property is not supported for this object type.');
    $bytes=zfsmSpaceLimitBytes($value);$r=runProcess('zfs',['get','-H','-p','-o','value,source',$property,$name]);$parts=explode("\t",trim($r['output']??''));if($r['code']!==0||count($parts)!==2||(!ctype_digit($parts[0])&&$parts[0]!=='none'))throw new RuntimeException('Native space limit cannot be inspected.');
    return ['kind'=>'space_property','name'=>$name,'guid'=>$identity['guid'],'property'=>$property,'requested'=>$value,'expected'=>$bytes,'previous'=>$parts[0]==='none'?'0':$parts[0],'source'=>$parts[1],'can_proceed'=>true];
}
function zfsmCommitSpaceProperty($request,$secret) {
    $name=$request['zdataset']??'';$property=$request['property']??'';$value=$request['value']??'';$scope=zfsmSpacePropertyScope($name,$property,$value);zfsmOperationConsume($request,$secret,$scope);
    $r=runProcess('zfs',['set',$property.'='.($scope['expected']==='0'?'none':$scope['expected']),$name]);if($r['code']!==0)return commandAnswer($property,$r);
    try{$after=zfsmSpacePropertyScope($name,$property,$value);if($after['guid']!==$scope['guid']||$after['previous']!==$scope['expected'])throw new RuntimeException('Effective limit differs');return ['succeeded'=>[$property=>'Effective native limit readback verified'],'failed'=>[]];}
    catch(Throwable $error){return zfsmFailure($property,'Space limit command completed but effective limit readback was not confirmed. Inspect before retrying.');}
}
function zfsmQuotaScope($name,$input) {
    $identity=zfsmReadIdentity($name);if($identity['type']!=='filesystem')throw new InvalidArgumentException('User/group quotas are unavailable for zvols.');
    $change=zfsmQuotaInput($input);$r=runProcess('zfs',['get','-H','-p','-o','value,source',$change['property'],$name]);$parts=explode("\t",trim($r['output']??''));
    if(($r['code']??1)!==0||count($parts)!==2||(!ctype_digit($parts[0])&&$parts[0]!=='none'))throw new RuntimeException('This native quota property is unsupported or unreadable.');
    return ['kind'=>'quota','name'=>$name,'guid'=>$identity['guid'],'change'=>$change,'previous'=>$parts[0]==='none'?'0':$parts[0],'source'=>$parts[1],'can_proceed'=>true,'warning'=>'Allocation can fail when a quota is reached. This change affects one filesystem and one POSIX identity.'];
}
function zfsmCommitQuota($request,$secret) {
    $scope=zfsmQuotaScope($request['zdataset']??'',is_array($request['data']??null)?$request['data']:[]);zfsmOperationConsume($request,$secret,$scope);
    $name=$scope['name'];$change=$scope['change'];$r=runProcess('zfs',['set',$change['property'].'='.($change['value']==='0'?'none':$change['value']),$name]);if($r['code']!==0)return commandAnswer($name,$r);
    try{$after=zfsmQuotaScope($name,$request['data']);if($after['guid']!==$scope['guid']||$after['previous']!==$change['value'])throw new RuntimeException('Quota readback differs');return ['succeeded'=>[$change['property']=>'Quota applied and readback verified'],'failed'=>[]];}
    catch(Throwable $error){return zfsmFailure($name,'Quota command completed, but readback is unverified. Inspect the native quota before retrying.');}
}
