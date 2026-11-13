<?php
// ARCH-004: production deletes only through the queued job (zfsmQueueDeletion and
// zfsmRunDeletionJob). These tests check the shared confined helper contract that job also
// relies on: the same zfsmDirectoryRequest, the same zfsm-directory.pl and its answer.
function zfsmTestDirectoryDelete($directory,$force) {
	$resolved=zfsmResolveDirectory($directory,true);
	if (!$resolved) return zfsmFailure($directory,'Directory is outside a mounted ZFS filesystem');
	if ($resolved!==zfsmResolveDirectory($directory,true)) return zfsmFailure($directory,'Directory state changed; refresh and retry');
	try {
		$request=zfsmDirectoryRequest('delete',$resolved,['recursive'=>(string)$force==='1']);
		return zfsmDirectoryAnswer($resolved['path'],zfsmDirectoryCommand($request));
	} catch (Throwable $error) { return zfsmFailure($directory,$error->getMessage()); }
}
// Same for a reviewed dataset destroy: the queued runner uses the same busy diagnostics and
// the same verified destroy result.
function zfsmTestDestroyDataset($zdataset,$force,$scope=null) {
	if (!is_string($zdataset) || strpos($zdataset,'/')===false || strpos($zdataset,'@')!==false) return zfsmFailure($zdataset,'Pool root destruction is not allowed');
	if (!zfsmDatasetExists($zdataset)) return zfsmFailure($zdataset,'Dataset does not exist');
	if ($scope!==null) {
		$diagnostics=zfsmDestroyBusyDiagnostics($scope['objects']);
		if ($diagnostics['blocked']) return zfsmDestroyBlockedAnswer($scope,$diagnostics);
	}
	$args=['destroy','-v'];
	if ((string)$force==='1') array_push($args,'-r','-f');
	$args[]=$zdataset;
	return zfsmDestroyCommandResult($zdataset,runProcess('zfs',$args),$scope);
}
