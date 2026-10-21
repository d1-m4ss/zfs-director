<?php
require_once __DIR__.'/ZFSMDestroyBusy.php';

function zfsmDestroyChoice($value) {
	if (!in_array($value,[0,1,'0','1',false,true],true)) throw new InvalidArgumentException('Invalid destruction flag choice');
	return in_array($value,[1,'1',true],true);
}

function zfsmDestroyScope($target,$recursive) {
	$snapshot=zfsmValidSnapshotName($target);
	if (!$snapshot && (!zfsmValidDatasetName($target)||!str_contains($target,'/'))) throw new InvalidArgumentException('Only a child dataset or snapshot can be destroyed; pool root is protected');
	$dataset=explode('@',$target,2)[0];$pool=explode('/',$dataset,2)[0];
	$columns=['name','type','guid','origin','mountpoint','encryptionroot','userrefs','defer_destroy'];
	$result=runProcess('zfs',['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o',implode(',',$columns),$pool]);
	if (($result['code']??1)!==0) throw new RuntimeException('Unable to determine destruction dependencies');
	$inventory=[];
	foreach (preg_split('/\r\n|\r|\n/',trim($result['output']??''),-1,PREG_SPLIT_NO_EMPTY)?:[] as $line) {
		$parts=explode("\t",$line);
		if(count($parts)!==count($columns))throw new RuntimeException('Malformed destruction dependency inventory');
		$row=array_combine($columns,$parts);$name=$row['name'];
		if ((!zfsmValidDatasetName($name)&&!zfsmValidSnapshotName($name))||!in_array($row['type'],['filesystem','volume','snapshot'],true)||preg_match('/^[1-9][0-9]*$/D',$row['guid'])!==1||isset($inventory[$name]))throw new RuntimeException('Malformed destruction object identity');

		$inventory[$name]=$row;
	}
	if (!isset($inventory[$target]))throw new RuntimeException('Destruction target no longer exists');
	ksort($inventory);$objects=[];$dependencies=[];
	foreach($inventory as $name=>$row) {
		$owner=explode('@',$name,2)[0];
		$affected=$snapshot?($name===$target||($recursive&&$row['type']==='snapshot'&&str_starts_with($owner,$dataset.'/')&&explode('@',$name,2)[1]===explode('@',$target,2)[1])):($name===$target||($recursive&&($owner===$dataset||str_starts_with($owner,$dataset.'/'))));
		if($affected){if($row['type']==='snapshot'){$holds=runProcess('zfs',['holds','-H',$name]);if(($holds['code']??1)!==0)throw new RuntimeException('Unable to determine snapshot holds');$row['holds']=trim($holds['output']??'');}$objects[]=$row;}
	}
	$names=array_column($objects,'name');
	foreach($inventory as $row)if(in_array($row['origin'],$names,true)&&!in_array($row['name'],$names,true))$dependencies[]=$row;
	$args=['destroy','-nvp'];if($recursive){$args[]='-r';if(!$snapshot)$args[]='-f';}$args[]=$target;
	$dry=runProcess('zfs',$args);
	$blocked=$dependencies||array_filter($objects,fn($row)=>($row['type']==='snapshot'&&((int)$row['userrefs']>0||($row['holds']??'')!=='')));
	return ['target'=>$target,'type'=>$snapshot?'snapshot':$inventory[$target]['type'],'recursive'=>$recursive,'objects'=>$objects,'dependencies'=>$dependencies,'preview'=>(string)($dry['output']??''),'can_destroy'=>!$blocked&&($dry['code']??1)===0&&trim($dry['output']??'')!==''];
}

function zfsmDestroyPreviewFile($id) {
	if (!is_string($id)||preg_match('/^[a-f0-9]{32}$/D',$id)!==1)throw new InvalidArgumentException('Invalid destroy preview identity');
	return zfsmJobDirectory($GLOBALS['plugin_runtime'].'/destroy-previews').'/'.$id.'.json';
}

function zfsmPruneDestroyPreviews() {
    $directory=zfsmJobDirectory($GLOBALS['plugin_runtime'].'/destroy-previews');$count=0;
    foreach(glob($directory.'/*.json')?:[] as $file){if(is_link($file)||!is_file($file)||!preg_match('/^[a-f0-9]{32}\.json$/D',basename($file)))continue;$count++;if(filesize($file)>4*1024*1024)continue;$record=json_decode(@file_get_contents($file)?:'null',true);if(is_array($record)&&is_int($record['expires']??null)&&$record['expires']<time()){if(@unlink($file))$count--;}}
    if($count>=1000)throw new RuntimeException('Too many outstanding destroy previews; wait for expiry before reviewing again');
}

function zfsmPreviewDestroy($target,$force,$secret) {
	$recursive=zfsmDestroyChoice($force);
	if (!is_string($secret)||$secret==='')throw new InvalidArgumentException('Preview signing secret unavailable');
	$scope=zfsmDestroyScope($target,$recursive);
	zfsmPruneDestroyPreviews();
	$id=bin2hex(random_bytes(16));$record=['version'=>2,'created'=>time(),'expires'=>time()+600,'scope'=>$scope];
	$token=hash_hmac('sha256',json_encode([$id,$record],JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR),$secret);
	zfsmJobAtomicWrite(zfsmDestroyPreviewFile($id),$record);
	$diagnostics=zfsmDestroyBusyDiagnostics($scope['objects']);
	$answer=$scope+['preview_id'=>$id,'token'=>$token,'expires'=>$record['expires'],'diagnostics'=>$diagnostics];
	$answer['can_destroy']=$scope['can_destroy']&&!$diagnostics['blocked'];
	return $answer;
}

// The plugin lock serializes consumption and execution. External root/ZFS
// writers can still race the final CLI call; this is not a ZFS transaction.
function zfsmValidateDestroyPreview($target,$force,$secret,$id,$token) {
	$file=zfsmDestroyPreviewFile($id);$record=json_decode(@file_get_contents($file)?:'null',true);
	if (!is_array($record))throw new RuntimeException('Destroy preview missing, already used or expired; review again');
	if (($record['expires']??0)<time())throw new RuntimeException('Destroy preview expired; review again');
	$signature=hash_hmac('sha256',json_encode([$id,$record],JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR),$secret);
	if (!is_string($token)||!hash_equals($signature,$token))throw new InvalidArgumentException('Destroy preview confirmation signature is invalid');
	$scope=zfsmDestroyScope($target,zfsmDestroyChoice($force));
	if ($scope!==$record['scope'])throw new RuntimeException('Destruction identity or dependencies changed; review a new preview');
	if (!$scope['can_destroy'])throw new RuntimeException('Destruction is blocked by dependencies, holds or failed dry run');
	if (!@unlink($file))throw new RuntimeException('Unable to consume destroy preview safely');
	return $scope;
}

// Verbose destroy output is a plan, including on failures. It never proves that
// an object was removed. Verify the reviewed identities using a separate read.
function zfsmDestroyCommandResult($target,$result,$scope=null) {
    $errors=[];$plan=[];
    foreach(preg_split('/\r\n|\r|\n/',trim($result['output']??''),-1,PREG_SPLIT_NO_EMPTY)?:[] as $line) {
        if(preg_match('/^(?:will destroy |would destroy |destroy\t)/',$line))$plan[]=$line;
        elseif(!preg_match('/^(?:will reclaim |would reclaim |reclaim\t)/',$line))$errors[]=$line;
    }
    $code=(int)($result['code']??1);
    $answer=['succeeded'=>[],'failed'=>[],'destruction'=>['exit_code'=>$code,'errors'=>$errors,'plan_output'=>$plan,'state_verified'=>false,'removed'=>[],'remaining'=>[],'changed'=>[]]];
    if($code!==0)$answer['failed'][$target]=$errors?implode("\n",$errors):'ZFS destroy failed (exit '.$code.'). Inspect current state and load a fresh preview; no automatic retry was performed.';
    if($scope===null){if($code===0)$answer['succeeded'][$target]=0;return $answer;}
    try {
        $pool=explode('/',explode('@',$target,2)[0],2)[0];
        $read=runProcess('zfs',['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o','name,guid',$pool]);
        if(($read['code']??1)!==0)throw new RuntimeException('readback unavailable');
        $live=[];
        foreach(preg_split('/\r\n|\r|\n/',trim($read['output']??''),-1,PREG_SPLIT_NO_EMPTY)?:[]as$line){$p=explode("\t",$line);if(count($p)!==2||(!zfsmValidDatasetName($p[0])&&!zfsmValidSnapshotName($p[0]))||preg_match('/^[1-9][0-9]*$/D',$p[1])!==1||isset($live[$p[0]]))throw new RuntimeException('malformed readback');$live[$p[0]]=$p[1];}
        if(!isset($live[$pool]))throw new RuntimeException('incomplete readback');
        foreach($scope['objects']as$row){$name=$row['name'];if(!isset($live[$name])&&!in_array($row['guid'],$live,true)){$answer['destruction']['removed'][]=$name;$answer['succeeded'][$name]='Destroyed; absence verified';}elseif(!isset($live[$name])||$live[$name]!==$row['guid']){$answer['destruction']['changed'][]=$name;$answer['failed'][$name]='Object identity changed after the attempt. Inspect manually; do not retry using this preview.';}else $answer['destruction']['remaining'][]=$name;}
        $answer['destruction']['state_verified']=true;
        if($answer['destruction']['remaining']&&$code===0)$answer['failed'][$target]='ZFS reported success but reviewed objects remain. Inspect actual state and load a fresh preview.';
    }catch(Throwable$error){$answer['failed']['readback']='The deletion result could not be verified. Inspect actual state before retrying; some objects may already have been removed.';}
    return $answer;
}
