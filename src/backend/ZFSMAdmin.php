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
unset($GLOBALS['zfsm_conversion_journal_started']);
unset($GLOBALS['zfsm_deletion_journal_started']);
unset($GLOBALS['zfsm_request_job'],$GLOBALS['zfsm_job_request_command'],$GLOBALS['zfsm_request_published_job'],$GLOBALS['zfsm_job_request_audit'],$GLOBALS['zfsm_job_failure_context']);
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

function zfsmReturnAnswer($ret, $title, $success_text, $failed_text, $refresh = false, $unraid_notify = false) {
	$answer = zfsmResolveAnswerCodes($ret);
	if (!empty($GLOBALS['zfsm_request_audit'])) {
		$id=$GLOBALS['zfsm_request_audit']; unset($GLOBALS['zfsm_request_audit']);
		$deletion_command=$GLOBALS['zfsm_audit_operations'][$id]['command']??null;
		if(in_array($deletion_command,['deletedirectory','destroydataset'],true)&&$answer['failed']&&empty($answer['job'])){
			try{if(!empty($GLOBALS['zfsm_deletion_journal_started']))$answer['failed']['queue']='Deletion queue outcome is uncertain. Inspect Jobs and actual state before submitting again.';else{$kind=$deletion_command==='deletedirectory'?'directory':'dataset';$rejected=zfsmRecordRejectedDeletion($kind,zfsmPostString($kind==='directory'?'directory':'zdataset'),$answer['failed'],$id);if($rejected)$answer['job']=$rejected;}}
			catch(Throwable$error){$answer['failed']['job_record']='The rejected deletion request could not be saved in Jobs. Inspect Administrative History.';error_log('ZFS Director: rejected deletion record failed');}
		}
		if(($GLOBALS['zfsm_audit_operations'][$id]['command']??null)==='convertdirectory'&&$answer['failed']&&empty($answer['job'])){
			try{if(!empty($GLOBALS['zfsm_conversion_journal_started']))$answer['failed']['queue']='Conversion queue outcome is uncertain. Inspect Jobs and actual state before submitting again.';else{$rejected=zfsmRecordRejectedConversion(zfsmPostString('directory'),$answer['failed'],$id);if($rejected)$answer['job']=$rejected;}}
			catch(Throwable$error){$answer['failed']['job_record']='The rejected request could not be saved in Jobs. No conversion was queued; inspect Administrative History.';error_log('ZFS Director: rejected conversion record failed');}
		}
		if($answer['failed']&&empty($GLOBALS['zfsm_audit_operations'][$id]['failure_details']['error_code']))zfsmAuditRecordFailure(null,[],['code'=>null,'output'=>implode("\n",array_map(fn($v)=>is_string($v)?$v:'',$answer['failed']))]);
		$GLOBALS['zfsm_job_failure_context']=$GLOBALS['zfsm_audit_operations'][$id]['failure_details']??[];
        try { zfsmAuditFinish($id,['status'=>$answer['failed']?'failed':'succeeded','succeeded'=>array_keys($answer['succeeded']),'failed'=>array_keys($answer['failed']),'reason'=>zfsmAuditFailureReason($answer['failed'])]); }
		catch (Throwable $error) { $answer['failed']['audit']='Operation may have completed, but its final audit record failed. Inspect actual state before retrying.'; error_log('ZFS Director: final audit write failed'); }
	}
	try{$answer=zfsmRequestJobAnswer($answer);}catch(Throwable$error){$answer['failed']['job_record']='The final job record could not be saved. Inspect Jobs and actual state before retrying.';error_log('ZFS Director: operation journal failed');}
	if ($refresh && count($answer['succeeded']) > 0) refreshData();
	if ($unraid_notify) {
		$notification_map = function($map) {
			$rows = array();
			foreach ($map as $key=>$value) $rows[] = htmlspecialchars((string)$key, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8').': '.htmlspecialchars((string)$value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
			return implode('<br>', $rows);
		};
		if ($answer['succeeded']) zfsnotify($title, $success_text.' for:<br>'.$notification_map($answer['succeeded']), '', 'normal');
		if ($answer['failed']) zfsnotify($title, $failed_text.' for:<br>'.$notification_map($answer['failed']), '', 'warning');
	}
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
try {
	$request_token = zfsmValidateRequest();
	$command = zfsmPostString('cmd');
	$destructive = array('destroydataset','destroysnapshot','rollbacksnapshot','deletedirectory','cleanupmutation','movedirectory','convertdirectory','resumeconversion','lockdataset','restoresnapshotfiles');
	$readonly = array('inventory','inventorysnapshots','pooldiagnostics','getdatasetproperties','previewdestroy','previewrollback','conversionjobs','auditlog','snapshotfiles','snapshotfileinfo','downloadsnapshotfile','previewrestore','downloadsnapshotarchive','validatesettings');
	$administrative = array('refresh','createdataset','editdatasetproperty','adddirectortlisting','removedirectorylisting','renamedataset','destroydataset','lockdataset','unlockdataset','promotedataset','movedirectory','convertdirectory','deletedirectory','cleanupmutation','rollbacksnapshot','renamesnapshot','holdsnapshot','releasesnapshot','clonesnapshot','destroysnapshot','snapshotdataset','cancelconversion','resumeconversion','saveconfig','restoresnapshotfiles','cancelrestore','archivesnapshotfiles','scrubpool','activityvisibility');
	$readonly=array_merge($readonly,['protectiondetect','protectiondata','protectionpolicypreview','protectionreplicationpreview','protectionrunpreview','protectioncontrolpreview','protectiontest']);
	$administrative=array_merge($administrative,['protectionsettings','protectionpolicysave','protectionreplicationsave','protectionrun','protectioncontrol','protectioncancel']);
	$readonly[]='protectionimportpreview';$administrative[]='protectionimport';
	$readonly[]='protectionexternalpreview';$administrative[]='protectionexternaltransfer';
	$readonly=array_merge($readonly,['previewpromote','quotaoverview','previewquota']);$administrative[]='setquota';
	$readonly=array_merge($readonly,['acleditorinfo','previewacl']);$administrative[]='editacl';
	$readonly[]='previewcleanup';$readonly[]='previewspaceproperty';$readonly[]='previewhistoryarchive';
	if (!in_array($command,array_merge($readonly,$administrative),true)) throw new InvalidArgumentException('Unknown command');
	$GLOBALS['zfsm_job_request_command']=$command;
	if(isset(zfsmRequestJobCommands()[$command])&&!in_array($command,zfsmRequestJobQueuedCommands(),true))zfsmRequestJobBegin($command,$_POST);
	if (in_array($command,$administrative,true)) {
		$fields=$_POST;
		if ($command==='createdataset' && is_array($_POST['data']??null)) {
			$data=$_POST['data'];
			if (is_string($data['zpool']??null)&&is_string($data['name']??null)) $fields['zdataset']=$data['zpool'].'/'.$data['name'];
		}
		$GLOBALS['zfsm_request_audit']=zfsmAuditBegin($command,$fields);
		$GLOBALS['zfsm_job_request_audit']=$GLOBALS['zfsm_request_audit'];
        if(isset($GLOBALS['zfsm_request_job']))zfsmJobUpdate($GLOBALS['zfsm_request_job']['id'],['audit_id'=>$GLOBALS['zfsm_request_audit']]);
	}
	$controls=array('convertdirectory','cancelconversion','resumeconversion','restoresnapshotfiles','cancelrestore','archivesnapshotfiles');
	if (!in_array($command, array_merge($readonly,$controls), true)) {
		zfsmAuditSetStage('acquiring_lock');
		$mutation_lock = zfsmAcquireOperationLock($GLOBALS['plugin_lock']);
        $GLOBALS['zfsm_operation_lock_handle']=$mutation_lock;
	}
	// Settings may have changed while audit storage was locked. Recheck policy
	// under the same mutation lock that serializes saveconfig and ZFS changes.
	if (in_array($command, $destructive, true)) {
		$zfsm_cfg=loadConfig(parse_plugin_cfg($plugin,true));
		if ((int)$zfsm_cfg['destructive_mode'] !== 1) throw new InvalidArgumentException('Destructive Mode is disabled in ZFS Director settings');
	}
	zfsmAuditSetStage('validating_identity');
	zfsmGuardMutationIdentity($command,$_POST);
	zfsmAuditSetStage('executing_operation');
	switch ($command) {
		case 'protectionexternalpreview': echo json_encode(zfsmOwnershipTransferPreview(['id'=>zfsmPostString('id'),'type'=>zfsmPostString('type'),'data'=>is_array($_POST['data']??null)?$_POST['data']:[]],$request_token),JSON_THROW_ON_ERROR);break;
		case 'protectionexternaltransfer': zfsmReturnAnswer(zfsmOwnershipTransferCommit($_POST,$request_token),'External ownership transfer','','');break;
		case 'previewspaceproperty': echo json_encode(zfsmOperationPreview(zfsmSpacePropertyScope(zfsmPostString('zdataset'),zfsmPostString('property'),zfsmPostString('value')),$request_token),JSON_THROW_ON_ERROR);break;
		case 'acleditorinfo': echo json_encode(zfsmACLEditorInfo(zfsmPostString('zdataset')),JSON_THROW_ON_ERROR);break;
		case 'previewacl': echo json_encode(zfsmACLPreview(zfsmPostString('zdataset'),zfsmPostString('acl'),$request_token),JSON_THROW_ON_ERROR);break;
		case 'editacl': zfsmReturnAnswer(zfsmCommitACL($_POST,$request_token),'POSIX ACL','','',true);break;
		case 'previewpromote': echo json_encode(zfsmOperationPreview(zfsmPromoteScope(zfsmPostString('zdataset')),$request_token),JSON_THROW_ON_ERROR);break;
		case 'quotaoverview': echo json_encode(zfsmQuotaOverview(zfsmPostString('zdataset'),$zfsm_cfg),JSON_THROW_ON_ERROR);break;
		case 'previewquota': echo json_encode(zfsmOperationPreview(zfsmQuotaScope(zfsmPostString('zdataset'),is_array($_POST['data']??null)?$_POST['data']:[]),$request_token),JSON_THROW_ON_ERROR);break;
		case 'setquota': zfsmReturnAnswer(zfsmCommitQuota($_POST,$request_token),'Quota','','',true);break;
		case 'protectionimportpreview':
			echo json_encode(zfsmSanoidImportPreview(zfsmPostString('id'),$request_token),JSON_THROW_ON_ERROR);break;
		case 'protectionimport':
			zfsmReturnAnswer(zfsmSanoidImportCommit($_POST,$request_token),'Import snapshot policy','','');break;
		case 'protectiondata':
			echo json_encode(zfsmProtectionData(),JSON_THROW_ON_ERROR);break;
		case 'protectionpolicypreview':
			echo json_encode(zfsmSanoidPreview(is_array($_POST['data']??null)?$_POST['data']:[],$request_token),JSON_THROW_ON_ERROR);break;
		case 'protectionreplicationpreview':
			echo json_encode(zfsmSyncoidPreview(is_array($_POST['data']??null)?$_POST['data']:[],$request_token),JSON_THROW_ON_ERROR);break;
		case 'protectionpolicysave':
			zfsmReturnAnswer(zfsmSanoidCommit($_POST,$request_token),'Snapshot policy','','');break;
		case 'protectionreplicationsave':
			zfsmReturnAnswer(zfsmSyncoidCommit($_POST,$request_token),'Replication','','');break;
		case 'protectionrunpreview':
			echo json_encode(zfsmProtectionRunPreview($_POST,$request_token),JSON_THROW_ON_ERROR);break;
		case 'protectionrun':
			zfsmReturnAnswer(zfsmProtectionRunCommit($_POST,$request_token),'Protection run','','');break;
		case 'protectioncontrolpreview':
			echo json_encode(zfsmProtectionControlPreview($_POST,$request_token),JSON_THROW_ON_ERROR);break;
		case 'protectioncontrol':
			zfsmReturnAnswer(zfsmProtectionControlCommit($_POST,$request_token),'Protection definition','','');break;
		case 'protectioncancel':
			zfsmProtectionRequire();$job=zfsmProtectionCancel(zfsmPostString('job_id'));
			zfsmReturnAnswer(['succeeded'=>[$job['id']=>'Cancellation requested; partial data retained'],'failed'=>[]],'Cancel protection run','','');break;
		case 'protectiontest':
			echo json_encode(zfsmProtectionTestConfiguration(),JSON_THROW_ON_ERROR);break;
		case 'protectiondetect':
			echo json_encode(zfsmProtectionDetection(),JSON_THROW_ON_ERROR);
			break;
		case 'protectionsettings':
			zfsmReturnAnswer(zfsmProtectionSettings($_POST),'Data Protection','','');
			break;
		case 'validatesettings':
			echo json_encode(zfsmValidateSettings(is_array($_POST['settings']??null)?$_POST['settings']:[]),JSON_THROW_ON_ERROR);
			break;
		case 'scrubpool':
			zfsmReturnAnswer(zfsmStartPoolScrub(zfsmPostString('pool'),zfsmPostString('confirmed')), 'ZFS Pool Scrub', '', '');
			break;
		case 'archivesnapshotfiles':
			$job=zfsmQueueArchive(zfsmPostString('snapshot'),$_POST['selection']??[],zfsmPostString('snapshot_guid'));
			$warning=null;try{zfsmStartWorker();}catch(Throwable$error){$warning='Worker did not start; ZIP remains queued';}
			zfsmReturnAnswer(['succeeded'=>[$job['id']=>'ZIP preparation queued'],'failed'=>[],'job'=>$job,'worker_warning'=>$warning],'Prepare ZIP','','');
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
			zfsmReturnAnswer(['succeeded'=>[$job['id']=>'Restore queued'],'failed'=>[],'job'=>$job,'worker_warning'=>$warning],'Restore files','','');
			break;
		case 'cancelrestore':
			$job=zfsmCancelRestore(zfsmPostString('job_id'));
			zfsmReturnAnswer(['succeeded'=>[$job['id']=>'Cancellation requested; copied and replaced files will be retained'],'failed'=>[],'job'=>$job],'Cancel restore','','');
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
			zfsmReturnAnswer($answer,'Activity visibility','','');
			break;
		case 'conversionjobs':
			foreach(['page','page_size','filter','sort','view']as$key)if(array_key_exists($key,$_POST)&&!is_string($_POST[$key]))throw new InvalidArgumentException('Invalid jobs page request');
			$job_options=array_intersect_key($_POST,array_flip(['filter','sort','view']));
			echo json_encode(zfsmJobPage(zfsmPostString('page','1'),zfsmPostString('page_size','25'),$job_options?:null)+['worker_running'=>zfsmWorkerRunning(),'history'=>zfsmJobHistoryStatus()],JSON_UNESCAPED_SLASHES|JSON_INVALID_UTF8_SUBSTITUTE);
			break;
		case 'auditlog':
			foreach (['cursor','page_size'] as $key) if (array_key_exists($key,$_POST) && !is_string($_POST[$key])) throw new InvalidArgumentException('Invalid audit page request');
			echo json_encode(zfsmActivityAuditPage(zfsmPostString('page_size','500'),zfsmPostString('cursor')),JSON_UNESCAPED_SLASHES|JSON_INVALID_UTF8_SUBSTITUTE|JSON_THROW_ON_ERROR);
			break;
		case 'cancelconversion':
			$job=zfsmCancelConversion(zfsmPostString('job_id'));
			zfsmReturnAnswer(['succeeded'=>[$job['id']=>'Cancellation requested; retained source will not be deleted'],'failed'=>[],'job'=>$job],'Cancel','','');
			break;
		case 'resumeconversion':
			$job=zfsmResumeConversion(zfsmPostString('job_id'),zfsmPostString('offline_confirmed'));
			$warning=null;
			try { zfsmStartWorker(); } catch (Throwable $error) { $warning='Worker did not start; job remains queued'; }
			zfsmReturnAnswer(['succeeded'=>[$job['id']=>'Resume queued'],'failed'=>[],'job'=>$job,'worker_warning'=>$warning],'Resume','','');
			break;
		case 'saveconfig':
			zfsmReturnAnswer(zfsmSaveSettings(is_array($_POST['settings']??null)?$_POST['settings']:[]),'Settings','','',true);
			break;
		case 'inventory':
		case 'inventorysnapshots':
			// Use the existing authenticated, CSRF-protected plugin endpoint.
			$pool = $command === 'inventorysnapshots' ? zfsmPostString('pool') : '';
			if ($command === 'inventorysnapshots' && $pool === '') throw new InvalidArgumentException('Missing pool name');
			$answer = zfsmReadInventory($zfsm_cfg, $command === 'inventorysnapshots' || !$zfsm_cfg['lazy_load'], $pool);
			$answer['config'] = $zfsm_cfg;
			$answer['publishing_paused'] = is_file('/tmp/publishPaused');
			// These fields are maps. PHP otherwise emits [] for empty maps,
			// which violates the client contract even on a healthy pool.
			foreach (array('pools','devices','datasets','errors') as $key) $answer['data'][$key] = (object)$answer['data'][$key];
			echo json_encode($answer, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR);
			break;

		case 'refresh':
			// Compatibility for older clients: an accepted signal is not fresh inventory.
			if (is_file('/tmp/publishPaused')) {
				zfsmReturnAnswer(zfsmFailure('refresh', 'Unraid publishing is paused. Reload the updated ZFS Director page to use direct inventory.'), 'Refresh', '', '');
			} else {
				zfsmReturnAnswer(refreshData() ? array('succeeded' => array('refresh' => 'Refresh queued'), 'failed' => array()) : zfsmFailure('refresh', 'Unable to queue refresh'), 'Refresh', '', '');
			}
			break;

		case 'createdataset':
			$data = is_array($_POST['data'] ?? null) ? $_POST['data'] : array();
			foreach ($data as $value) if (!is_string($value)) throw new InvalidArgumentException('Dataset fields must be strings');
			$pool = is_string($data['zpool'] ?? null) ? $data['zpool'] : '';
			$name = is_string($data['name'] ?? null) ? trim($data['name'], '/') : '';
			$dataset = $pool.($name !== '' ? '/'.$name : '');
			zfsmReturnAnswer(createDataset($dataset, cleanZFSCreateDatasetParams($data)), 'ZFS Dataset Creation', 'Dataset created successfully', 'Unable to create dataset', true);
			break;

		case 'editdatasetproperty':
			$ret=in_array(zfsmPostString('property'),['quota','refquota','reservation','refreservation'],true)?zfsmCommitSpaceProperty($_POST,$request_token):setDatasetProperty(zfsmPostString('zdataset'), zfsmPostString('property'), zfsmPostString('value'));
			zfsmReturnAnswer($ret, 'ZFS Dataset Edit', 'Dataset edited successfully', 'Unable to edit dataset', true);
			break;

		case 'getdatasetproperties':
			echo json_encode(getAllDatasetProperties(zfsmPostString('zdataset'), 0), JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
			break;

		case 'adddirectortlisting':
			zfsmReturnAnswer(addToDirectoryListing(zfsmPostString('zdataset')), 'Directory Listing', 'Dataset added successfully', 'Unable to add dataset');
			break;

		case 'removedirectorylisting':
			zfsmReturnAnswer(removeFromDirectoryListing(zfsmPostString('zdataset')), 'Directory Listing', 'Dataset removed successfully', 'Unable to remove dataset');
			break;

		case 'renamedataset':
			zfsmReturnAnswer(renameDataset(zfsmPostString('zdataset'), zfsmPostString('newname'), zfsmPostString('force')), 'ZFS Dataset Rename', 'Dataset renamed successfully', 'Unable to rename dataset', true);
			break;

		case 'previewdestroy':
			echo json_encode(zfsmPreviewDestroy(zfsmPostString('snapshot')?:zfsmPostString('zdataset'), zfsmPostString('recursive',zfsmPostString('force','0')), $request_token), JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
			break;
		case 'previewrollback':
			echo json_encode(zfsmPreviewRollback(zfsmPostString('snapshot'),zfsmPostString('destroy_newer','0'),$request_token),JSON_UNESCAPED_SLASHES|JSON_INVALID_UTF8_SUBSTITUTE);
			break;
		case 'destroydataset':
			$dataset = zfsmPostString('zdataset');
			$scope = zfsmValidateDestroyPreview($dataset,zfsmPostString('force','0'),$request_token,zfsmPostString('preview_id'),zfsmPostString('preview_token'));
			$blocked = zfsmRequireDestructiveMode($zfsm_cfg, $dataset);
			zfsmReturnAnswer($blocked ?? zfsmQueueDeletion('dataset',$dataset,zfsmPostString('force','0'),$scope), 'ZFS Dataset Destroy', 'Dataset deletion queued', 'Unable to queue dataset deletion');
			break;

		case 'lockdataset':
			zfsmReturnAnswer(lockDataset(zfsmPostString('zdataset')), 'ZFS Dataset Lock', 'Dataset locked successfully', 'Unable to lock dataset', true);
			break;

		case 'unlockdataset':
			zfsmReturnAnswer(unlockDataset(zfsmPostString('zdataset'), zfsmPostString('passphrase')), 'ZFS Dataset Unlock', 'Dataset unlocked successfully', 'Unable to unlock dataset', true);
			break;

		case 'promotedataset':
			zfsmReturnAnswer(zfsmCommitPromote($_POST,$request_token), 'ZFS Dataset Promote', 'Dataset promoted successfully', 'Unable to promote dataset', true);
			break;

		case 'movedirectory':
			zfsmReturnAnswer(moveDirectory(zfsmPostString('directory'), zfsmPostString('newname')), 'ZFS Directory Move', 'Directory moved successfully', 'Unable to move directory', true);
			break;

		case 'convertdirectory':
			$directory = zfsmPostString('directory');
			$blocked = zfsmRequireDestructiveMode($zfsm_cfg, $directory);
			zfsmReturnAnswer($blocked ?? convertDirectory($directory, zfsmPostString('pool'), zfsmPostString('offline_confirmed')), 'ZFS Directory Convert', 'Conversion queued; original will be retained', 'Unable to queue conversion', false);
			break;

		case 'previewcleanup': echo json_encode(zfsmCleanupPreview(zfsmPostString('directory'),$request_token),JSON_THROW_ON_ERROR);break;
		case 'cleanupmutation': zfsmReturnAnswer(zfsmCleanupCommit($_POST,$request_token),'Recovery cleanup','Completed recovery journal archived and removed','Recovery cleanup refused',true);break;
		case 'deletedirectory':
			$directory = zfsmPostString('directory');
			$blocked = zfsmRequireDestructiveMode($zfsm_cfg, $directory);
			zfsmReturnAnswer($blocked ?? zfsmQueueDeletion('directory',$directory,zfsmPostString('force','0')), 'ZFS Directory Delete', 'Directory deletion queued', 'Unable to queue directory deletion');
			break;

		case 'rollbacksnapshot':
			$preview=zfsmValidateRollbackPreview(zfsmPostString('snapshot'),zfsmPostString('destroy_newer','0'),$request_token,zfsmPostString('preview_token'));
			if (!$preview['can_rollback']) throw new InvalidArgumentException('Newer snapshots/bookmarks require explicit deletion permission');
			zfsmReturnAnswer(rollbackDatasetSnapshot(zfsmPostString('snapshot'), zfsmPostString('destroy_newer')), 'ZFS Snapshot Rollback', 'Snapshot rolled back successfully', 'Unable to rollback snapshot', true);
			break;

		case 'renamesnapshot':
			$snapshot = zfsmPostString('snapshot');
			$pool = explode('/', explode('@', $snapshot, 2)[0], 2)[0];
			zfsmReturnAnswer(renameDatasetSnapshot($pool, $snapshot, zfsmPostString('newname')), 'ZFS Snapshot Rename', 'Snapshot renamed successfully', 'Unable to rename snapshot', true);
			break;

		case 'holdsnapshot':
			zfsmReturnAnswer(holdDatasetSnapshot(zfsmPostString('snapshot')), 'ZFS Snapshot Reference', 'Snapshot reference added successfully', 'Unable to add reference');
			break;

		case 'releasesnapshot':
			zfsmReturnAnswer(releaseDatasetSnapshot(zfsmPostString('snapshot')), 'ZFS Snapshot Release', 'Snapshot reference removed successfully', 'Unable to remove reference');
			break;

		case 'clonesnapshot':
			zfsmReturnAnswer(cloneDatasetSnapshot(zfsmPostString('snapshot'), zfsmPostString('clone')), 'ZFS Snapshot Clone', 'Snapshot cloned successfully', 'Unable to clone snapshot', true);
			break;

		case 'destroysnapshot':
			$scope = zfsmValidateDestroyPreview(zfsmPostString('snapshot'),zfsmPostString('recursive','0'),$request_token,zfsmPostString('preview_id'),zfsmPostString('preview_token'));
			zfsmReturnAnswer(deleteDatasetSnapshot(zfsmPostString('snapshot'), zfsmPostString('recursive'), $scope), 'ZFS Snapshot Destroy', 'Snapshot destroyed successfully', 'Unable to destroy snapshot', true);
			break;

		case 'snapshotdataset':
			$snapshot = ($zfsm_cfg['snap_prefix'] ?? '').date($zfsm_cfg['snap_pattern'] ?? 'Y-m-d-His');
			zfsmReturnAnswer(createDatasetSnapshot(zfsmPostString('zdataset'), $snapshot, zfsmPostString('recursive')), 'ZFS Snapshot Create', 'Snapshot created successfully', 'Unable to create snapshot', true);
			break;

		default:
			zfsmReturnAnswer(zfsmFailure('request', 'Unknown or missing command'), 'Request', '', '');
	}
} catch (Throwable $error) {
	error_log('ZFS Director backend request failed');
	zfsmReturnAnswer(zfsmFailure('request', $error->getMessage()), 'Request', '', '');
} finally {
    unset($GLOBALS['zfsm_operation_lock_handle']);
	if (is_resource($mutation_lock)) { flock($mutation_lock, LOCK_UN); fclose($mutation_lock); }
}

?>
