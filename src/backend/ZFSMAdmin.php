<?php
/* Branding renamed to ZFS Director on 2026-10-16; GPL-2.0-or-later. */

$plugin = 'zfs.master.ui';
$docroot = $docroot ?? ($_SERVER['DOCUMENT_ROOT'] ?? '/usr/local/emhttp');

require_once $docroot.'/webGui/include/Helpers.php';
require_once $docroot.'/plugins/'.$plugin.'/include/ZFSMBase.php';
require_once $docroot.'/plugins/'.$plugin.'/include/ZFSMError.php';
require_once $docroot.'/plugins/'.$plugin.'/include/ZFSMHelpers.php';
require_once $docroot.'/plugins/'.$plugin.'/backend/ZFSMOperations.php';

$zfsm_cfg = loadConfig(parse_plugin_cfg($plugin, true));
$_POST = is_array($_POST ?? null) ? $_POST : array();
zfsmRequestReset();
unset($GLOBALS['zfsm_request_job']);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function zfsmPostString($key, $default = '') {
	$value = $_POST[$key] ?? $default;
	return is_string($value) ? $value : $default;
}

function zfsmResolveAnswerCodes($answer) {
	if (!is_array($answer)) return zfsmFailure('request', 'The operation returned no usable result');
	$answer['succeeded'] = is_array($answer['succeeded'] ?? null) ? $answer['succeeded'] : array();
	$answer['failed'] = is_array($answer['failed'] ?? null) ? $answer['failed'] : array();
	foreach ($answer['succeeded'] as $key => $value) $answer['succeeded'][$key] = resolve_error($value);
	foreach ($answer['failed'] as $key => $value) $answer['failed'][$key] = resolve_error($value);
	return $answer;
}

function zfsmReturnAnswer($ret) {
	$answer = zfsmResolveAnswerCodes($ret);
	if (!empty(zfsmRequestGet('request_audit'))) {
		$id=zfsmRequestGet('request_audit'); zfsmRequestUnset('request_audit');
		$deletion_command=$GLOBALS['zfsm_audit_operations'][$id]['command']??null;
		if(in_array($deletion_command,['deletedirectory','destroydataset'],true)&&$answer['failed']&&empty($answer['job'])){
			try{if(!empty(zfsmRequestGet('deletion_journal_started')))$answer['failed']['queue']='Deletion queue outcome is uncertain. Inspect Jobs and actual state before submitting again.';else{$kind=$deletion_command==='deletedirectory'?'directory':'dataset';$rejected=zfsmRecordRejectedDeletion($kind,zfsmPostString($kind==='directory'?'directory':'zdataset'),$answer['failed'],$id);if($rejected)$answer['job']=$rejected;}}
			catch(Throwable$error){$answer['failed']['job_record']='The rejected deletion request could not be saved in Jobs. Inspect the actual state before retrying.';error_log('ZFS Director: rejected deletion record failed');}
		}
		if(($GLOBALS['zfsm_audit_operations'][$id]['command']??null)==='convertdirectory'&&$answer['failed']&&empty($answer['job'])){
			try{if(!empty(zfsmRequestGet('conversion_journal_started')))$answer['failed']['queue']='Conversion queue outcome is uncertain. Inspect Jobs and actual state before submitting again.';else{$rejected=zfsmRecordRejectedConversion(zfsmPostString('directory'),$answer['failed'],$id);if($rejected)$answer['job']=$rejected;}}
			catch(Throwable$error){$answer['failed']['job_record']='The rejected request could not be saved in Jobs. No conversion was queued. Inspect the actual state before retrying.';error_log('ZFS Director: rejected conversion record failed');}
		}
		if($answer['failed']&&empty($GLOBALS['zfsm_audit_operations'][$id]['failure_details']['error_code']))zfsmAuditRecordFailure(null,[],['code'=>null,'output'=>implode("\n",array_map(fn($v)=>is_string($v)?$v:'',$answer['failed']))]);
		zfsmRequestSet('job_failure_context',$GLOBALS['zfsm_audit_operations'][$id]['failure_details']??[]);
        try { zfsmAuditFinish($id,['status'=>$answer['failed']?'failed':'succeeded','succeeded'=>array_keys($answer['succeeded']),'failed'=>array_keys($answer['failed']),'reason'=>zfsmAuditFailureReason($answer['failed'])]); }
		catch (Throwable $error) { $answer['failed']['audit']='Operation may have completed, but its final audit record failed. Inspect actual state before retrying.'; error_log('ZFS Director: final audit write failed'); }
	}
	try{$answer=zfsmRequestJobAnswer($answer);}catch(Throwable$error){$answer['failed']['job_record']='The final job record could not be saved. Inspect Jobs and actual state before retrying.';error_log('ZFS Director: operation journal failed');}
	echo json_encode($answer, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
}

function zfsmRequireDestructiveMode($config, $subject) {
	return (int)($config['destructive_mode'] ?? 0) === 1 ? null : zfsmFailure($subject, 'Destructive Mode is disabled in ZFS Director settings');
}


// Unraid's local_prepend validates and removes the submitted token, keeping
// its validated value in $csrf_token. Standalone requests must supply a token.
function zfsmValidateRequest() {
	if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') throw new InvalidArgumentException('POST is required');
	if (!is_string($_POST['cmd'] ?? null) || $_POST['cmd'] === '') throw new InvalidArgumentException('Missing command');
	$expected = $GLOBALS['var']['csrf_token'] ?? '';
	if (!is_string($expected) || $expected === '') {
		$vars = @parse_ini_file('/var/local/emhttp/var.ini');
		$expected = is_array($vars) ? ($vars['csrf_token'] ?? '') : '';
	}
	$provided = $_POST['csrf_token'] ?? $_SERVER['HTTP_X_CSRF_TOKEN'] ?? $GLOBALS['csrf_token'] ?? null;
	if (!is_string($expected) || $expected === '' || !is_string($provided) || !hash_equals($expected, $provided)) throw new InvalidArgumentException('Invalid CSRF token');
	return $expected;
}

$mutation_lock = null;
$lock_described = false;
try {
	$request_token = zfsmValidateRequest();
	$command = zfsmPostString('cmd');
	// ARCH-002: kind, lock, Destructive Mode and journaling come from zfsmCommandRegistry().
	$spec = zfsmCommand($command);
	if ($spec === null) throw new InvalidArgumentException('Unknown command');
	$command = $_POST['cmd'] = $spec['name'];
	zfsmRequestSet('job_request_command',$command);
	if($spec['observed'])zfsmRequestJobBegin($command,$_POST);
	if ($spec['kind'] === 'admin') {
		$fields=$_POST;
		if ($command==='createdataset' && is_array($_POST['data']??null)) {
			$data=$_POST['data'];
			if (is_string($data['zpool']??null)&&is_string($data['name']??null)) $fields['zdataset']=$data['zpool'].'/'.$data['name'];
		}
		zfsmRequestSet('request_audit',zfsmAuditBegin($command,$fields));
		zfsmRequestSet('job_request_audit',zfsmRequestGet('request_audit'));
        if(isset($GLOBALS['zfsm_request_job']))zfsmJobUpdate($GLOBALS['zfsm_request_job']['id'],['audit_id'=>zfsmRequestGet('request_audit')]);
	}
	// Lock 'none' admin commands (protectionrun, conversion/restore queueing and cancels) only
	// queue or flag a durable job; they serialize on their own job/config locks already.
	if ($spec['lock'] !== 'none') {
		zfsmAuditSetStage('acquiring_lock');
		// Config commands never make a mutating ZFS/sanoid/syncoid call, so a long ZFS job holding
		// the operation lock must not block them; they share the config lock saveconfig uses.
		$config_only = $spec['lock'] === 'config';
		$mutation_lock = zfsmAcquireOperationLockWaiting($config_only?$GLOBALS['plugin_config_lock']:$GLOBALS['plugin_lock']);
        $GLOBALS['zfsm_operation_lock_handle']=$mutation_lock;
        $subject=null;foreach(['zdataset','snapshot','directory','pool','newname','job_id']as$key)if(is_string($_POST[$key]??null)&&$_POST[$key]!==''){$subject=$_POST[$key];break;}
        // Only the operation-lock holder describes itself: a config-only command
        // must not overwrite or remove the running ZFS operation's description.
        if(!$config_only){zfsmOperationLockDescribe($spec['label']??$command,$subject);$lock_described=true;}
	}
	// Settings may have changed while audit storage was locked. Recheck policy
	// under the mutation lock that serializes ZFS changes (settings use their own
	// lock, so an operation already running keeps the policy it started under).
	if ($spec['destructive']) {
		$zfsm_cfg=loadConfig(parse_plugin_cfg($plugin,true));
		if ((int)$zfsm_cfg['destructive_mode'] !== 1) throw new InvalidArgumentException('Destructive Mode is disabled in ZFS Director settings');
	}
	zfsmAuditSetStage('validating_identity');
	zfsmGuardMutationIdentity($command,$_POST);
	zfsmAuditSetStage('executing_operation');
	switch ($command) {
		case 'protectionexternalpreview': echo json_encode(zfsmOwnershipTransferPreview(['id'=>zfsmPostString('id'),'type'=>zfsmPostString('type'),'data'=>is_array($_POST['data']??null)?$_POST['data']:[]],$request_token),JSON_THROW_ON_ERROR);break;
		case 'protectionexternaltransfer': zfsmReturnAnswer(zfsmOwnershipTransferCommit($_POST,$request_token));break;
		case 'previewspaceproperty': echo json_encode(zfsmOperationPreview(zfsmSpacePropertyScope(zfsmPostString('zdataset'),zfsmPostString('property'),zfsmPostString('value')),$request_token),JSON_THROW_ON_ERROR);break;
		case 'acleditorinfo': echo json_encode(zfsmACLEditorInfo(zfsmPostString('zdataset')),JSON_THROW_ON_ERROR);break;
		case 'previewacl': echo json_encode(zfsmACLPreview(zfsmPostString('zdataset'),zfsmPostString('acl'),$request_token),JSON_THROW_ON_ERROR);break;
		case 'editacl': zfsmReturnAnswer(zfsmCommitACL($_POST,$request_token));break;
		case 'previewpromote': echo json_encode(zfsmOperationPreview(zfsmPromoteScope(zfsmPostString('zdataset')),$request_token),JSON_THROW_ON_ERROR);break;
		case 'quotaoverview': echo json_encode(zfsmQuotaOverview(zfsmPostString('zdataset'),$zfsm_cfg),JSON_THROW_ON_ERROR);break;
		case 'previewquota': echo json_encode(zfsmOperationPreview(zfsmQuotaScope(zfsmPostString('zdataset'),is_array($_POST['data']??null)?$_POST['data']:[]),$request_token),JSON_THROW_ON_ERROR);break;
		case 'setquota': zfsmReturnAnswer(zfsmCommitQuota($_POST,$request_token));break;
		case 'protectionimportpreview':
			echo json_encode(zfsmSanoidImportPreview(zfsmPostString('id'),$request_token),JSON_THROW_ON_ERROR);break;
		case 'protectionimport':
			zfsmReturnAnswer(zfsmSanoidImportCommit($_POST,$request_token));break;
		case 'protectiondata':
			echo json_encode(zfsmProtectionData(),JSON_THROW_ON_ERROR);break;
		case 'protectionpolicypreview':
			echo json_encode(zfsmSanoidPreview(is_array($_POST['data']??null)?$_POST['data']:[],$request_token),JSON_THROW_ON_ERROR);break;
		case 'protectionreplicationpreview':
			echo json_encode(zfsmSyncoidPreview(is_array($_POST['data']??null)?$_POST['data']:[],$request_token),JSON_THROW_ON_ERROR);break;
		case 'protectionpolicysave':
			zfsmReturnAnswer(zfsmSanoidCommit($_POST,$request_token));break;
		case 'protectionreplicationsave':
			zfsmReturnAnswer(zfsmSyncoidCommit($_POST,$request_token));break;
		case 'protectionrunpreview':
			echo json_encode(zfsmProtectionRunPreview($_POST,$request_token),JSON_THROW_ON_ERROR);break;
		case 'protectionrun':
			zfsmReturnAnswer(zfsmProtectionRunCommit($_POST,$request_token));break;
		case 'protectioncontrolpreview':
			echo json_encode(zfsmProtectionControlPreview($_POST,$request_token),JSON_THROW_ON_ERROR);break;
		case 'protectioncontrol':
			zfsmReturnAnswer(zfsmProtectionControlCommit($_POST,$request_token));break;
		case 'protectioncancel':
			zfsmProtectionRequire();$job=zfsmProtectionCancel(zfsmPostString('job_id'));
			zfsmReturnAnswer(['succeeded'=>[$job['id']=>'Cancellation requested; partial data retained'],'failed'=>[]]);break;
		case 'protectiontest':
			echo json_encode(zfsmProtectionTestConfiguration(),JSON_THROW_ON_ERROR);break;
		case 'protectiondetect':
			echo json_encode(zfsmProtectionDetection(),JSON_THROW_ON_ERROR);
			break;
		case 'protectioncredentiallist':
			zfsmProtectionRequire();echo json_encode(['credentials'=>zfsmSyncoidCredentialList()],JSON_THROW_ON_ERROR);break;
		case 'protectioncredentialsave':
			zfsmProtectionRequire();zfsmReturnAnswer(zfsmSyncoidCredentialSave(['name'=>zfsmPostString('name'),'keyfile'=>zfsmPostString('keyfile'),'known_hosts'=>zfsmPostString('known_hosts')]));break;
		case 'protectioncredentialremove':
			zfsmProtectionRequire();zfsmReturnAnswer(zfsmSyncoidCredentialRemove(zfsmPostString('name')));break;
		case 'protectionsettings':
			zfsmReturnAnswer(zfsmProtectionSettings($_POST));
			break;
		case 'validatesettings':
			echo json_encode(zfsmValidateSettings(is_array($_POST['settings']??null)?$_POST['settings']:[]),JSON_THROW_ON_ERROR);
			break;
		case 'scrubpool':
			zfsmReturnAnswer(zfsmStartPoolScrub(zfsmPostString('pool'),zfsmPostString('confirmed')));
			break;
		case 'archivesnapshotfiles':
			$job=zfsmQueueArchive(zfsmPostString('snapshot'),$_POST['selection']??[],zfsmPostString('snapshot_guid'));
			$warning=null;try{zfsmStartWorker();}catch(Throwable$error){$warning='Worker did not start; ZIP remains queued';}
			zfsmReturnAnswer(['succeeded'=>[$job['id']=>'ZIP preparation queued'],'failed'=>[],'job'=>$job,'worker_warning'=>$warning]);
			break;
		case 'downloadsnapshotarchive':
			$id=zfsmJobId(zfsmPostString('job_id'));
            $archive=zfsmReadJob($id);if(($archive['schema']??null)===2&&($archive['type']??null)==='archive')zfsmRequestJobDownloadContext($archive['snapshot']??'');
			zfsmStreamDownload(zfsmArchiveReadRequest($id),'snapshot-'.$id.'.zip','application/zip');
			break;
		case 'snapshotfileinfo':
			echo json_encode(zfsmExplorerCall(zfsmExplorerContext(zfsmPostString('snapshot'),zfsmPostString('snapshot_guid'))+['op'=>'fileinfo','path'=>zfsmExplorerPath(zfsmPostString('path'))]),JSON_THROW_ON_ERROR);
			break;
		case 'snapshotfiles':
            echo json_encode(zfsmExplorerList(zfsmPostString('snapshot'),zfsmPostString('path'),zfsmPostString('filter'),zfsmPostString('sort','name'),zfsmPostString('direction','asc'),zfsmPostString('offset','0'),zfsmPostString('hidden','0'),zfsmPostString('snapshot_guid'),zfsmPostString('kind','all')),JSON_UNESCAPED_SLASHES|JSON_INVALID_UTF8_SUBSTITUTE|JSON_THROW_ON_ERROR);
			break;
		case 'downloadsnapshotfile':
			zfsmExplorerDownload(zfsmPostString('snapshot'),zfsmPostString('path'),zfsmPostString('snapshot_guid'));
			break;
		case 'previewrestore':
			if(zfsmPostString('snapshot_guid')==='')throw new InvalidArgumentException('Reopen the snapshot before restoring files');
			echo json_encode(zfsmPreviewRestore(zfsmPostString('snapshot'),$_POST['selection']??[],zfsmPostString('target'),zfsmPostString('mode','new'),$request_token,zfsmPostString('snapshot_guid')),JSON_UNESCAPED_SLASHES|JSON_INVALID_UTF8_SUBSTITUTE|JSON_THROW_ON_ERROR);
			break;
		case 'restoresnapshotfiles':
			$job=zfsmQueueRestore(zfsmPostString('preview_id'),zfsmPostString('preview_token'),$request_token,zfsmPostString('confirmed'));
			$warning=null;try{zfsmStartWorker();}catch(Throwable $error){$warning='Worker did not start; restore remains queued';}
			zfsmReturnAnswer(['succeeded'=>[$job['id']=>'Restore queued'],'failed'=>[],'job'=>$job,'worker_warning'=>$warning]);
			break;
		case 'cancelrestore':
			$job=zfsmCancelRestore(zfsmPostString('job_id'));
			zfsmReturnAnswer(['succeeded'=>[$job['id']=>'Cancellation requested; copied and replaced files will be retained'],'failed'=>[],'job'=>$job]);
			break;
		case 'pooldiagnostics':
			echo json_encode(zfsmReadMaintenanceDiagnostics(zfsmPostString('pool'),$zfsm_cfg), JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR);
			break;
		case 'previewhistoryarchive':
            echo json_encode(zfsmActivityHistoryReview($_POST['ids']??null,zfsmPostString('review_token')),JSON_THROW_ON_ERROR);
            break;
		case 'activityvisibility':
			if(!is_string($_POST['kind']??null)||!in_array($_POST['kind'],['jobs','history'],true)||!is_string($_POST['archived']??null)||!in_array($_POST['archived'],['0','1'],true))throw new InvalidArgumentException('Invalid visibility request');
			$answer=$_POST['kind']==='jobs'?zfsmActivitySetJobs($_POST['ids']??null,$_POST['archived']==='1'):zfsmActivitySetHistory($_POST['ids']??null,$_POST['archived']==='1',zfsmPostString('review_token'));
			zfsmReturnAnswer($answer);
			break;
		case 'deletefinishedjobs':
			foreach(['filter','type','everything']as$key)if(array_key_exists($key,$_POST)&&!is_string($_POST[$key]))throw new InvalidArgumentException('Invalid delete request');
			// By default only jobs matching the filters shown in Jobs, on every page; "everything" ignores them.
			$only=null;if(($_POST['everything']??'')!=='1'){$match=zfsmJobPage(1,1,array_intersect_key($_POST,array_flip(['filter','type']))+['view'=>'all','ids_only'=>true,'listed'=>true]);$only=array_fill_keys($match['ids'],true);}
			zfsmReturnAnswer(zfsmJobDeleteFinished($only));
			break;
		case 'conversionjobs':
			foreach(['page','page_size','filter','type','sort','view']as$key)if(array_key_exists($key,$_POST)&&!is_string($_POST[$key]))throw new InvalidArgumentException('Invalid jobs page request');
			// Retention also runs when the worker is stopped; it returns at once when not due.
			try{zfsmJobHistoryCleanup();}catch(Throwable$error){error_log('ZFS Director: job history maintenance unavailable');}
			$job_options=array_intersect_key($_POST,array_flip(['filter','type','sort','view']))+['listed'=>($_POST['listed']??'1')!=='0'];
			echo json_encode(zfsmJobPage(zfsmPostString('page','1'),zfsmPostString('page_size','25'),$job_options?:null)+['worker_running'=>zfsmWorkerRunning(),'history'=>zfsmJobHistoryStatus(),'operation'=>zfsmOperationLockStatus()],JSON_UNESCAPED_SLASHES|JSON_INVALID_UTF8_SUBSTITUTE);
			break;
		case 'auditlog':
			foreach (['cursor','page_size'] as $key) if (array_key_exists($key,$_POST) && !is_string($_POST[$key])) throw new InvalidArgumentException('Invalid audit page request');
			echo json_encode(zfsmActivityAuditPage(zfsmPostString('page_size','500'),zfsmPostString('cursor')),JSON_UNESCAPED_SLASHES|JSON_INVALID_UTF8_SUBSTITUTE|JSON_THROW_ON_ERROR);
			break;
		case 'cancelconversion':
			$job=zfsmCancelConversion(zfsmPostString('job_id'));
			zfsmReturnAnswer(['succeeded'=>[$job['id']=>'Cancellation requested; retained source will not be deleted'],'failed'=>[],'job'=>$job]);
			break;
		case 'resumeconversion':
			$job=zfsmResumeConversion(zfsmPostString('job_id'),zfsmPostString('offline_confirmed'));
			$warning=null;
			try { zfsmStartWorker(); } catch (Throwable $error) { $warning='Worker did not start; job remains queued'; }
			zfsmReturnAnswer(['succeeded'=>[$job['id']=>'Resume queued'],'failed'=>[],'job'=>$job,'worker_warning'=>$warning]);
			break;
		case 'publishconversion':
			zfsmReturnAnswer(['succeeded'=>[zfsmPublishConversion(zfsmPostString('job_id'))['source']=>'Verified conversion copy published at its original path'],'failed'=>[]]);
			break;
		case 'saveconfig':
			zfsmReturnAnswer(zfsmSaveSettings(is_array($_POST['settings']??null)?$_POST['settings']:[]));
			break;
		case 'inventory':
		case 'inventorysnapshots':
			// Use the existing authenticated, CSRF-protected plugin endpoint.
			$pool = $command === 'inventorysnapshots' ? zfsmPostString('pool') : '';
			if ($command === 'inventorysnapshots' && $pool === '') throw new InvalidArgumentException('Missing pool name');
			$answer = zfsmReadInventory($zfsm_cfg, $command === 'inventorysnapshots' || !$zfsm_cfg['lazy_load'], $pool);
			$answer['config'] = $zfsm_cfg;
			// These fields are maps. PHP otherwise emits [] for empty maps,
			// which violates the client contract even on a healthy pool.
			foreach (array('pools','devices','datasets','errors') as $key) $answer['data'][$key] = (object)$answer['data'][$key];
			echo json_encode($answer, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR);
			break;

		case 'refresh':
			// Compatibility for older clients: inventory is read directly on every request.
			zfsmReturnAnswer(array('succeeded' => array('refresh' => 'Inventory is read directly; no refresh is needed'), 'failed' => array()));
			break;

		case 'createdataset':
			$data = is_array($_POST['data'] ?? null) ? $_POST['data'] : array();
			foreach ($data as $value) if (!is_string($value)) throw new InvalidArgumentException('Dataset fields must be strings');
			$pool = is_string($data['zpool'] ?? null) ? $data['zpool'] : '';
			$name = is_string($data['name'] ?? null) ? trim($data['name'], '/') : '';
			$dataset = $pool.($name !== '' ? '/'.$name : '');
			zfsmReturnAnswer(createDataset($dataset, cleanZFSCreateDatasetParams($data)));
			break;

		case 'editdatasetproperty':
			$ret=in_array(zfsmPostString('property'),['quota','refquota','reservation','refreservation'],true)?zfsmCommitSpaceProperty($_POST,$request_token):setDatasetProperty(zfsmPostString('zdataset'), zfsmPostString('property'), zfsmPostString('value'));
			zfsmReturnAnswer($ret);
			break;

		case 'getdatasetproperties':
			echo json_encode(getAllDatasetProperties(zfsmPostString('zdataset'), 0), JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
			break;

		case 'adddirectortlisting':
			zfsmReturnAnswer(addToDirectoryListing(zfsmPostString('zdataset')));
			break;

		case 'removedirectorylisting':
			zfsmReturnAnswer(removeFromDirectoryListing(zfsmPostString('zdataset')));
			break;

		case 'renamedataset':
			zfsmReturnAnswer(renameDataset(zfsmPostString('zdataset'), zfsmPostString('newname'), zfsmPostString('force')));
			break;

		case 'previewdestroy':
			echo json_encode(zfsmPreviewDestroy(zfsmPostString('snapshot')?:zfsmPostString('zdataset'), zfsmPostString('recursive',zfsmPostString('force','0')), $request_token), JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
			break;
		case 'stopdestroyprocesses':
			zfsmReturnAnswer(zfsmStopDestroyProcesses(zfsmPostString('snapshot')?:zfsmPostString('zdataset'),zfsmPostString('force','0'),$_POST['processes']??null));
			break;
		case 'previewrollback':
			echo json_encode(zfsmPreviewRollback(zfsmPostString('snapshot'),zfsmPostString('destroy_newer','0'),$request_token),JSON_UNESCAPED_SLASHES|JSON_INVALID_UTF8_SUBSTITUTE);
			break;
		case 'destroydataset':
			$dataset = zfsmPostString('zdataset');
			$scope = zfsmValidateDestroyPreview($dataset,zfsmPostString('force','0'),$request_token,zfsmPostString('preview_id'),zfsmPostString('preview_token'));
			$blocked = zfsmRequireDestructiveMode($zfsm_cfg, $dataset);
			zfsmReturnAnswer($blocked ?? zfsmQueueDeletion('dataset',$dataset,zfsmPostString('force','0'),$scope));
			break;

		case 'lockdataset':
			zfsmReturnAnswer(lockDataset(zfsmPostString('zdataset')));
			break;

		case 'unlockdataset':
			zfsmReturnAnswer(unlockDataset(zfsmPostString('zdataset'), zfsmPostString('passphrase')));
			break;

		case 'promotedataset':
			zfsmReturnAnswer(zfsmCommitPromote($_POST,$request_token));
			break;

		case 'movedirectory':
			zfsmReturnAnswer(moveDirectory(zfsmPostString('directory'), zfsmPostString('newname')));
			break;

		case 'convertdirectory':
			$directory = zfsmPostString('directory');
			$blocked = zfsmRequireDestructiveMode($zfsm_cfg, $directory);
			zfsmReturnAnswer($blocked ?? convertDirectory($directory, zfsmPostString('pool'), zfsmPostString('offline_confirmed')));
			break;

		case 'previewcleanup': echo json_encode(zfsmCleanupPreview(zfsmPostString('directory'),$request_token),JSON_THROW_ON_ERROR);break;
		case 'cleanupmutation': zfsmReturnAnswer(zfsmCleanupCommit($_POST,$request_token));break;
		case 'previewdeletedirectory':
			echo json_encode(zfsmDirectoryDeletionPreview(zfsmPostString('directory'),zfsmPostString('force','0')),JSON_UNESCAPED_SLASHES|JSON_INVALID_UTF8_SUBSTITUTE);
			break;
		case 'deletedirectory':
			$directory = zfsmPostString('directory');
			$blocked = zfsmRequireDestructiveMode($zfsm_cfg, $directory);
			zfsmReturnAnswer($blocked ?? zfsmQueueDeletion('directory',$directory,zfsmPostString('force','0')));
			break;

		case 'rollbacksnapshot':
			$preview=zfsmValidateRollbackPreview(zfsmPostString('snapshot'),zfsmPostString('destroy_newer','0'),$request_token,zfsmPostString('preview_token'));
			if (!$preview['can_rollback']) throw new InvalidArgumentException('Newer snapshots/bookmarks require explicit deletion permission');
			zfsmReturnAnswer(rollbackDatasetSnapshot(zfsmPostString('snapshot'), zfsmPostString('destroy_newer')));
			break;

		case 'renamesnapshot':
			$snapshot = zfsmPostString('snapshot');
			$pool = explode('/', explode('@', $snapshot, 2)[0], 2)[0];
			zfsmReturnAnswer(renameDatasetSnapshot($pool, $snapshot, zfsmPostString('newname')));
			break;

		case 'holdsnapshot':
			zfsmReturnAnswer(holdDatasetSnapshot(zfsmPostString('snapshot')));
			break;

		case 'releasesnapshot':
			zfsmReturnAnswer(releaseDatasetSnapshot(zfsmPostString('snapshot')));
			break;

		case 'clonesnapshot':
			zfsmReturnAnswer(cloneDatasetSnapshot(zfsmPostString('snapshot'), zfsmPostString('clone')));
			break;

		case 'destroysnapshot':
			$scope = zfsmValidateDestroyPreview(zfsmPostString('snapshot'),zfsmPostString('recursive','0'),$request_token,zfsmPostString('preview_id'),zfsmPostString('preview_token'));
			zfsmReturnAnswer(deleteDatasetSnapshot(zfsmPostString('snapshot'), zfsmPostString('recursive'), $scope));
			break;

		case 'snapshotdataset':
			$snapshot = ($zfsm_cfg['snap_prefix'] ?? '').date($zfsm_cfg['snap_pattern'] ?? 'Y-m-d-His');
			zfsmReturnAnswer(createDatasetSnapshot(zfsmPostString('zdataset'), $snapshot, zfsmPostString('recursive')));
			break;

		default:
			zfsmReturnAnswer(zfsmFailure('request', 'Unknown or missing command'));
	}
} catch (Throwable $error) {
	error_log('ZFS Director backend request failed');
	zfsmReturnAnswer(zfsmFailure('request', $error->getMessage()));
} finally {
    unset($GLOBALS['zfsm_operation_lock_handle']);
	if (is_resource($mutation_lock)) { if ($lock_described) zfsmOperationLockForget(); flock($mutation_lock, LOCK_UN); fclose($mutation_lock); }
}

?>
