<?php

// Re-read under the administrative mutation lock. GUIDs must remain decimal
// strings; unsigned ZFS identities may exceed PHP's signed integer range.
function zfsmReadIdentity($name) {
	if (!zfsmValidDatasetName($name) && !zfsmValidSnapshotName($name)) throw new InvalidArgumentException('Invalid object identity target');
	$result=runProcess('zfs',['list','-H','-p','-o','name,type,guid','-t','filesystem,volume,snapshot',$name]);
	$parts=explode("\t",trim($result['output']??''));
	if (($result['code']??1)!==0 || count($parts)!==3 || $parts[0]!==$name || !in_array($parts[1],['filesystem','volume','snapshot'],true) || preg_match('/^[1-9][0-9]*$/D',$parts[2])!==1) throw new RuntimeException('Object is missing or its identity is malformed; refresh inventory');
	return ['name'=>$parts[0],'type'=>$parts[1],'guid'=>$parts[2]];
}

function zfsmRequireIdentity($name,$guid) {
	if (!is_string($guid)||preg_match('/^[1-9][0-9]*$/D',$guid)!==1) throw new InvalidArgumentException('Fresh object identity is required; refresh inventory');
	$actual=zfsmReadIdentity($name);
	if (!hash_equals($actual['guid'],$guid)) throw new RuntimeException('Object identity changed; refresh and review the target again');
	return $actual;
}

function zfsmAttachDirectoryIdentities(&$tree) {
	$tree['_directory_identities']=[];
	foreach ($tree['directories']??[] as $path) {
		if (!is_string($path)||zfsmPathHasSymlink($path)) continue;
		$identity=zfsmDirectoryIdentity($path);
		if ($identity!==null) $tree['_directory_identities'][$path]=$identity;
	}
	foreach ($tree['child'] as &$child) zfsmAttachDirectoryIdentities($child);
}

function zfsmGuardMutationIdentity($command,$fields) {
    zfsmProtectionMutationGuard($command,$fields);
    zfsmDependencyMutationGuard($command,$fields);
    unset($GLOBALS['zfsm_directory_reviewed']);
	$datasetCommands=['editdatasetproperty','setquota','editacl','adddirectortlisting','removedirectorylisting','renamedataset','destroydataset','lockdataset','unlockdataset','promotedataset','snapshotdataset'];
	$snapshotCommands=['renamesnapshot','holdsnapshot','releasesnapshot','clonesnapshot','destroysnapshot','rollbacksnapshot'];
	if (in_array($command,$datasetCommands,true)) zfsmRequireIdentity($fields['zdataset']??'', $fields['expected_guid']??'');
	if (in_array($command,$snapshotCommands,true)) zfsmRequireIdentity($fields['snapshot']??'', $fields['snapshot_guid']??'');
	if (in_array($command,['movedirectory','deletedirectory','cleanupmutation','convertdirectory'],true)) {
		$resolved=zfsmResolveDirectory($fields['directory']??'',true);
		if (!$resolved) throw new RuntimeException('Directory is no longer available in its original dataset');
		zfsmRequireIdentity($resolved['dataset'],$fields['expected_guid']??'');
		$expected=$fields['directory_identity']??null;
		if (!is_array($expected)||$expected!==zfsmDirectoryIdentity($resolved['path'])) throw new RuntimeException('Directory identity changed; refresh inventory');
        $GLOBALS['zfsm_directory_reviewed']=['path'=>$resolved['path'],'identity'=>$expected];
	}
	if (in_array($command,['createdataset','clonesnapshot','renamedataset'],true)) {
		$target=$command==='createdataset'?($fields['data']['zpool']??'').'/'.trim($fields['data']['name']??'','/') : ($command==='clonesnapshot'?($fields['clone']??''):($fields['newname']??''));
		$parent=$fields['parent_name']??'';
		if (!zfsmValidDatasetName($target)||!zfsmValidDatasetName($parent)||!str_starts_with($target,$parent.'/')) throw new InvalidArgumentException('Fresh destination parent identity is required');
		zfsmRequireIdentity($parent,$fields['parent_guid']??'');
		if (dirname($target)!==$parent) {
			$result=runProcess('zfs',['list','-H','-r','-t','filesystem,volume','-o','name',$parent]);
			if (($result['code']??1)!==0)throw new RuntimeException('Unable to verify destination parent chain');
			$names=preg_split('/\r\n|\r|\n/',trim($result['output']??''),-1,PREG_SPLIT_NO_EMPTY)?:[];
			if (!in_array($parent,$names,true))throw new RuntimeException('Destination parent inventory is incomplete');
			foreach($names as $name) {
				if(!zfsmValidDatasetName($name)||($name!==$parent&&!str_starts_with($name,$parent.'/')))throw new RuntimeException('Malformed destination parent inventory');
				if($name!==$parent&&str_starts_with($target,$name.'/'))throw new RuntimeException('Destination parent appeared or changed; refresh and review inherited properties');
			}
		}
	}
}
