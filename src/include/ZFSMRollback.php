<?php

// createtxg and GUID are unsigned 64-bit properties. Keep decimal strings so
// PHP integers/floats cannot round identities or change transaction ordering.
function zfsmRollbackDecimalCompare($left, $right) {
	return strlen($left) <=> strlen($right) ?: strcmp($left, $right);
}

function zfsmRollbackDestroyNewerFlag($value) {
	if (in_array($value, array(true, 1, '1'), true)) return true;
	if (in_array($value, array(false, 0, '0'), true)) return false;
	throw new InvalidArgumentException('Invalid rollback destroy-newer choice');
}

function zfsmRollbackScope($snapshot, $destroy_newer) {
	if (!zfsmValidSnapshotName($snapshot)) throw new InvalidArgumentException('Invalid rollback snapshot');
	$destroy_newer = zfsmRollbackDestroyNewerFlag($destroy_newer);
	$dataset = explode('@', $snapshot, 2)[0];
	// A depth of one includes direct snapshots/bookmarks without traversing
	// every descendant. Still match the dataset exactly when interpreting rows.
	$result = runProcess('zfs', array('list', '-H', '-p', '-d', '1', '-t', 'snapshot,bookmark', '-o', 'name,type,guid,createtxg', $dataset));
	if (($result['code'] ?? 1) !== 0) throw new RuntimeException('Unable to read rollback snapshot and bookmark inventory');
	$objects = array();
	foreach (preg_split('/\r\n|\r|\n/', (string)($result['output'] ?? ''), -1, PREG_SPLIT_NO_EMPTY) ?: array() as $line) {
		$parts = explode("\t", $line);
		if (count($parts) !== 4) throw new RuntimeException('Malformed rollback inventory');
		list($name, $type, $guid, $txg) = $parts;
		if (!in_array($type, array('snapshot', 'bookmark'), true)
			|| preg_match('/^[1-9][0-9]*$/D', $guid) !== 1
			|| preg_match('/^[1-9][0-9]*$/D', $txg) !== 1) throw new RuntimeException('Malformed rollback object identity');
		$separator = $type === 'snapshot' ? '@' : '#';
		if (substr_count($name, $separator) !== 1
			|| !zfsmValidSnapshotName($type === 'snapshot' ? $name : str_replace('#', '@', $name))) throw new RuntimeException('Malformed rollback object name');
		if (explode($separator, $name, 2)[0] !== $dataset) continue;
		if (isset($objects[$name])) throw new RuntimeException('Duplicate rollback inventory object');
		$objects[$name] = array('name' => $name, 'type' => $type, 'guid' => $guid, 'createtxg' => $txg);
	}
	$target = $objects[$snapshot] ?? null;
	if ($target === null || $target['type'] !== 'snapshot') throw new RuntimeException('Rollback snapshot no longer exists');
	$newer = array_values(array_filter($objects, function($object) use ($target) {
		return zfsmRollbackDecimalCompare($object['createtxg'], $target['createtxg']) > 0;
	}));
	usort($newer, function($left, $right) {
		return zfsmRollbackDecimalCompare($left['createtxg'], $right['createtxg']) ?: strcmp($left['name'], $right['name']);
	});
	$snapshots = array();
	$bookmarks = array();
	foreach ($newer as $object) {
		if ($object['type'] === 'snapshot') $snapshots[] = $object['name'];
		else $bookmarks[] = $object['name'];
	}
	$requires_destroy_newer = count($newer) > 0;
	return array(
		'snapshot' => $snapshot,
		'dataset' => $dataset,
		'destroy_newer' => $destroy_newer,
		'target_guid' => $target['guid'],
		'target_createtxg' => $target['createtxg'],
		'newer_snapshots' => $snapshots,
		'newer_bookmarks' => $bookmarks,
        'newer_objects' => $newer,
		'requires_destroy_newer' => $requires_destroy_newer,
		'can_rollback' => $destroy_newer || !$requires_destroy_newer,
	);
}

function zfsmRollbackPreviewFile($token) {
    if (!is_string($token)||preg_match('/^[a-f0-9]{64}$/D',$token)!==1) throw new InvalidArgumentException('Rollback preview confirmation is required');
    return zfsmJobDirectory($GLOBALS['plugin_runtime'].'/rollback-previews').'/'.$token.'.json';
}
function zfsmPreviewRollback($snapshot,$destroy_newer,$secret) {
    if (!is_string($secret)||$secret==='') throw new InvalidArgumentException('Rollback preview signing secret is unavailable');
    $scope=zfsmRollbackScope($snapshot,$destroy_newer);
    $directory=zfsmJobDirectory($GLOBALS['plugin_runtime'].'/rollback-previews');$count=0;
    foreach(glob($directory.'/*.json')?:[]as$file){if(is_link($file)||!is_file($file))continue;$count++;if(filemtime($file)<time()-600&&@unlink($file))$count--;}
    if($count>=1000)throw new RuntimeException('Too many rollback previews; wait for expiry');
    $record=['version'=>2,'nonce'=>bin2hex(random_bytes(32)),'expires'=>time()+600,'scope'=>$scope];
    $token=hash_hmac('sha256',json_encode($record,JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR),$secret);
    zfsmJobAtomicWrite(zfsmRollbackPreviewFile($token),$record);
    return $scope+['token'=>$token,'expires'=>$record['expires']];
}
// Consume under the existing mutation lock before executing the command.
// A failed/uncertain command requires a new review; external ZFS writers
// remain outside the plugin lock, so this is not a ZFS transaction.
function zfsmValidateRollbackPreview($snapshot,$destroy_newer,$secret,$token) {
    $file=zfsmRollbackPreviewFile($token);
    if(is_link($file)||!is_file($file)||filesize($file)>4*1024*1024)throw new RuntimeException('Rollback preview missing or already used; review again');
    $record=json_decode(file_get_contents($file),true,128,JSON_THROW_ON_ERROR);
    if(!is_array($record)||($record['version']??null)!==2||($record['expires']??0)<time())throw new RuntimeException('Rollback preview expired; review again');
    $signature=hash_hmac('sha256',json_encode($record,JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR),$secret);
    if(!hash_equals($signature,$token))throw new RuntimeException('Invalid rollback preview signature');
    $scope=zfsmRollbackScope($snapshot,$destroy_newer);
    if($scope!==$record['scope'])throw new RuntimeException('Rollback identity or newer objects changed; review again');
    if(!$scope['can_rollback'])throw new RuntimeException('Newer objects require explicit destruction permission');
    if(!unlink($file))throw new RuntimeException('Unable to consume rollback preview');
    return $scope;
}
