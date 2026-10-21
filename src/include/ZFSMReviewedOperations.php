<?php
// Shared expiring/one-use HMAC storage; independent of the Sanoid GUI gate.
function zfsmOperationPreview($scope,$secret) {
    return zfsmProtectionPreview($scope,$secret,hash('sha256',json_encode($scope,JSON_THROW_ON_ERROR)));
}
function zfsmOperationConsume($request,$secret,$scope) {
    $review=zfsmProtectionConsumePreview($request,$secret,hash('sha256',json_encode($scope,JSON_THROW_ON_ERROR)));
    if($review!==$scope)throw new RuntimeException('Operation scope changed; load a fresh review.');
    return $review;
}

function zfsmPromotePlan($name,$rows) {
    $inventory=[];
    foreach($rows as $row){if(!isset($row['name'],$row['guid'],$row['type'],$row['origin'],$row['createtxg'])||isset($inventory[$row['name']])||(!zfsmValidDatasetName($row['name'])&&!zfsmValidSnapshotName($row['name']))||!preg_match('/^[1-9][0-9]*$/D',$row['guid'])||!preg_match('/^[1-9][0-9]*$/D',$row['createtxg']))throw new RuntimeException('Malformed promote inventory');$inventory[$row['name']]=$row;}
    $clone=$inventory[$name]??null;$origin=$clone['origin']??'';
    if(!$clone||!zfsmValidSnapshotName($origin)||!isset($inventory[$origin]))throw new RuntimeException('Only a clone with a verified origin snapshot can be promoted.');
    $parent=explode('@',$origin,2)[0];if(!isset($inventory[$parent]))throw new RuntimeException('Origin dataset identity is unavailable.');
    $affected=[];$conflicts=[];
    foreach($inventory as $row)if($row['type']==='snapshot'&&explode('@',$row['name'],2)[0]===$parent&&zfsmRollbackDecimalCompare($row['createtxg'],$inventory[$origin]['createtxg'])<=0){$affected[]=$row;$target=$name.'@'.explode('@',$row['name'],2)[1];if(isset($inventory[$target]))$conflicts[]=$target;}
    usort($affected,fn($a,$b)=>zfsmRollbackDecimalCompare($a['createtxg'],$b['createtxg'])?:strcmp($a['name'],$b['name']));sort($conflicts);
    $dependencies=[];foreach($inventory as $row)if(in_array($row['origin'],array_column($affected,'name'),true))$dependencies[]=$row;
    usort($dependencies,fn($a,$b)=>strcmp($a['name'],$b['name']));
    return ['kind'=>'promote','name'=>$name,'guid'=>$clone['guid'],'origin'=>$origin,'origin_dataset'=>$parent,'original'=>$inventory[$parent],'affected_snapshots'=>$affected,'dependencies'=>$dependencies,'conflicts'=>$conflicts,'can_proceed'=>!$conflicts,'warning'=>'Promotion reverses clone dependencies and transfers snapshot space accounting. Snapshot holds remain attached.'];
}
function zfsmPromoteScope($name) {
    if(!zfsmValidDatasetName($name))throw new InvalidArgumentException('Invalid clone');
    $columns=['name','type','guid','origin','createtxg','userrefs'];$r=runProcess('zfs',['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o',implode(',',$columns),explode('/',$name,2)[0]]);
    if(($r['code']??1)!==0)throw new RuntimeException('Unable to inspect promote dependencies');
    $rows=[];foreach(preg_split('/\r\n|\r|\n/',rtrim($r['output'],"\r\n"),-1,PREG_SPLIT_NO_EMPTY)?:[] as $line){$parts=explode("\t",$line);if(count($parts)!==count($columns))throw new RuntimeException('Malformed promote inventory');$row=array_combine($columns,$parts);if(!in_array($row['type'],['filesystem','volume','snapshot'],true)||($row['type']==='snapshot'?!zfsmValidSnapshotName($row['name']):!zfsmValidDatasetName($row['name']))||($row['origin']!=='-'&&!zfsmValidSnapshotName($row['origin']))||explode('/',explode('@',$row['name'],2)[0],2)[0]!==explode('/',$name,2)[0])throw new RuntimeException('Invalid promote object');$rows[]=$row;if(count($rows)>50000)throw new RuntimeException('Promote inventory exceeds review limit');}
    return zfsmPromotePlan($name,$rows);
}
function zfsmCommitPromote($request,$secret) {
    $scope=zfsmPromoteScope($request['zdataset']??'');zfsmOperationConsume($request,$secret,$scope);
    if(!$scope['can_proceed'])throw new RuntimeException('Conflicting snapshot names block promotion. Review them individually.');
    $name=$scope['name'];$r=runProcess('zfs',['promote',$name]);if(($r['code']??1)!==0)return commandAnswer($name,$r);
    try{
        zfsmRequireIdentity($name,$scope['guid']);zfsmRequireIdentity($scope['origin_dataset'],$scope['original']['guid']);
        $r=runProcess('zfs',['get','-H','-o','value','origin',$name]);if($r['code']!==0||trim($r['output'])!==$scope['original']['origin'])throw new RuntimeException('Promoted origin readback differs');
        $r=runProcess('zfs',['get','-H','-o','value','origin',$scope['origin_dataset']]);if($r['code']!==0||trim($r['output'])!==$name.'@'.explode('@',$scope['origin'],2)[1])throw new RuntimeException('Reversed dependency readback differs');
        foreach($scope['affected_snapshots'] as $row)zfsmRequireIdentity($name.'@'.explode('@',$row['name'],2)[1],$row['guid']);
        return ['succeeded'=>[$name=>'Promotion and moved snapshot GUIDs verified'],'failed'=>[]];
    }catch(Throwable $error){return zfsmFailure($name,'Promotion command completed but readback could not confirm the reviewed result. Inspect both datasets before further operations: '.$error->getMessage());}
}
