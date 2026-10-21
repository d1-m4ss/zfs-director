<?php
/* Branding renamed to ZFS Director on 2026-10-16; GPL-2.0-or-later. */

// The inode persists between operations. Never unlink a lock to recover it:
// replacing it can create two independent kernel locks for the same pathname.
function zfsmOperationLockFailure($code,$owner=null) {
    $id=$GLOBALS['zfsm_audit_current_id']??null;
    if($id&&isset($GLOBALS['zfsm_audit_operations'][$id]))$GLOBALS['zfsm_audit_operations'][$id]['failure_details']=['stage'=>'acquiring_lock','error_code'=>$code];
    if($code==='lock_busy'&&$owner!==null&&$id&&isset($GLOBALS['zfsm_audit_operations'][$id]))$GLOBALS['zfsm_audit_operations'][$id]['failure_details']['lock_owner']=$owner;
    $messages=['lock_busy'=>'Another operation is running: the operation lock is held. Wait for it to finish and retry.',
        'lock_open_failed'=>'Operation lock unavailable: cannot open its file. Check backend permissions and lock storage.',
        'lock_unavailable'=>'Operation lock unavailable: file identity or kernel locking could not be verified.'];
    return new RuntimeException($messages[$code]);
}
/** Match an observed Linux whole-file flock, never a waiter or another inode. */
function zfsmOperationLockPid($locks,$opened) {
    if(!is_string($locks)||strlen($locks)>1048576||PHP_INT_SIZE<8||!is_int($opened['dev']??null)||!isset($opened['ino']))return null;
    $dev=$opened['dev'];$major=(($dev>>8)&0xfff)|(($dev>>32)&0xfffff000);$minor=($dev&0xff)|(($dev>>12)&0xffffff00);
    foreach(explode("\n",$locks)as$line){
        if(!preg_match('/^[0-9]+: +FLOCK +ADVISORY +WRITE +([1-9][0-9]{0,9}) +([0-9a-f]{1,8}):([0-9a-f]{1,8}):([0-9]+) +0 +EOF$/iD',$line,$m))continue;
        if(hexdec($m[2])===$major&&hexdec($m[3])===$minor&&$m[4]===(string)$opened['ino']&&(int)$m[1]<=2147483647)return (int)$m[1];
    }
    return null;
}
/** Best-effort snapshot only; never changes locking or reads process arguments. */
function zfsmOperationLockOwner($opened) {
    try{
        if(PHP_OS_FAMILY!=='Linux')return null;
        $pid=zfsmOperationLockPid(@file_get_contents('/proc/locks',false,null,0,1048577),$opened);
        if($pid===null)return null;
        $comm=@file_get_contents('/proc/'.$pid.'/comm',false,null,0,17);
        $comm=is_string($comm)?rtrim($comm,"\n"):null;
        if(!is_string($comm)||!preg_match('/^[A-Za-z0-9_.+-]{1,15}$/D',$comm))$comm=null;
        // Release/exit during inspection must not manufacture a stale owner.
        if(zfsmOperationLockPid(@file_get_contents('/proc/locks',false,null,0,1048577),$opened)!==$pid)return null;
        return ['pid'=>$pid,'comm'=>$comm];
    }catch(Throwable$error){return null;}
}
function zfsmAcquireOperationLock($file,$allowBusy=false) {
    if(!is_string($file)||$file===''||str_contains($file,"\0"))throw zfsmOperationLockFailure('lock_open_failed');
    clearstatcache(true,$file);$before=@lstat($file);
    if(is_link($file)||($before&&($before['mode']&0170000)!==0100000))throw zfsmOperationLockFailure('lock_unavailable');
    // e prevents unrelated exec children retaining this descriptor. Owned
    // mutation subprocesses deliberately receive FD3 from their supervisor.
    $h=@fopen($file,'ce');if(!$h)throw zfsmOperationLockFailure('lock_open_failed');
    try{
        clearstatcache(true,$file);$path=@lstat($file);$opened=fstat($h);
        if(!$path||!$opened||($path['mode']&0170000)!==0100000||$path['dev']!==$opened['dev']||$path['ino']!==$opened['ino']||($before&&($before['dev']!==$path['dev']||$before['ino']!==$path['ino'])))throw zfsmOperationLockFailure('lock_unavailable');
        $blocked=0;if(!@flock($h,LOCK_EX|LOCK_NB,$blocked)){if($blocked&&$allowBusy){fclose($h);return null;}throw zfsmOperationLockFailure($blocked?'lock_busy':'lock_unavailable',$blocked?zfsmOperationLockOwner($opened):null);}
        clearstatcache(true,$file);$after=@lstat($file);if(!$after||$after['dev']!==$opened['dev']||$after['ino']!==$opened['ino']||($after['mode']&0170000)!==0100000)throw zfsmOperationLockFailure('lock_unavailable');
        return $h;
    }catch(Throwable$e){fclose($h);throw $e;}
}

function loadConfig($config) {	
	$config = is_array($config) ? $config : [];
	$zfsm_ret['refresh_interval'] = isset($config['general']['refresh_interval']) ? intval($config['general']['refresh_interval']) : 30;
	$zfsm_ret['lazy_load'] = isset($config['general']['lazy_load']) ? intval($config['general']['lazy_load']) : "0";
	$zfsm_ret['sanoid_integration'] = (string)($config['general']['sanoid_integration'] ?? '0') === '1' ? 1 : 0;

	$zfsm_ret['destructive_mode'] = isset($config['general']['destructive_mode']) ? intval($config['general']['destructive_mode']) : 0;

	if (isset($config['general']['exclussion']) && $config['general']['exclussion'] != '' && !isset($config['general']['exclusion'])):
		$config['general']['exclusion'] = $config['general']['exclussion'];
	endif;

	if (!isset($config['general']['exclusion']) || $config['general']['exclusion'] == '' || $config['general']['exclusion'] == ' '):
		$zfsm_ret['dataset_exclusion'] = '';
	else:
		$zfsm_ret['dataset_exclusion'] = $config['general']['exclusion'];
	endif;
		
	$zfsm_ret['snap_max_days_alert'] = isset($config['general']['snap_max_days_alert']) ? intval($config['general']['snap_max_days_alert']) : 30;
	foreach(['space_warning_percent'=>80,'space_critical_percent'=>90,'replication_lag_hours'=>24] as $key=>$default)$zfsm_ret[$key]=(int)($config['general'][$key]??$default);
	$zfsm_ret['snap_prefix'] = isset($config['general']['snap_prefix']) ? $config['general']['snap_prefix'] : '';

	if (!isset($config['general']['snap_pattern']) || $config['general']['snap_pattern'] == ''):
		$zfsm_ret['snap_pattern'] = 'Y-m-d-His';
	else:
		$zfsm_ret['snap_pattern'] = $config['general']['snap_pattern'];
	endif;

	if (!isset($config['general']['directory_listing']) || $config['general']['directory_listing'] == ''):
		$zfsm_ret['directory_listing'] = array();
	else:
		$zfsm_ret['directory_listing'] = preg_split('/\r\n|\r|\n/', $config['general']['directory_listing']);
	endif;
	
	return $zfsm_ret;
}

function zfsnotify( $subject, $description, $message, $type="normal") {	
	$notify = ($GLOBALS["docroot"] ?? '/usr/local/emhttp').'/plugins/dynamix/scripts/notify';
	runProcess($notify, array('-e', 'ZFS Director', '-s', $subject, '-d', $description, '-m', (string)$message, '-i', $type));
}

function fromBytesToString($bytes) {
	$units = array('B', 'KiB', 'MiB', 'GiB', 'TiB'); 

	$bytes = is_numeric($bytes) ? max((float)$bytes, 0) : 0;
   	$pow = floor(($bytes ? log($bytes) : 0) / log(1024)); 
   	$pow = min($pow, count($units) - 1); 

   	$bytes /= pow(1024, $pow);

   return round($bytes, 2) . ' ' . $units[$pow]; 
}
	  
function implodeWithKeys($glue, $array, $symbol = ': ') {
	return implode( $glue, array_map( function($k, $v) use($symbol) {
			return $k . $symbol . $v;
		},
		array_keys($array),
		array_values($array))
	);
}
	
/** Feed pipes without blocking on a child that writes before reading stdin. */
function zfsmProcessInput($process, $pipes, $input, $deadline = null, $limits = [1=>67108864, 2=>65536]) {
	$output = [1=>'', 2=>'']; $offset = 0; $length = strlen($input);
	foreach ($pipes as $pipe) stream_set_blocking($pipe, false);
	while ($offset < $length) {
		if ($deadline !== null && microtime(true) >= $deadline) throw new RuntimeException('Process input timed out');
		$read = []; foreach ([1,2] as $index) if (isset($pipes[$index]) && !feof($pipes[$index])) $read[] = $pipes[$index];
		$write = [$pipes[0]]; $except = null;
		if (@stream_select($read, $write, $except, 0, 200000) === false) throw new RuntimeException('Unable to communicate with process');
		foreach ($read as $pipe) {
			$index = $pipe === $pipes[1] ? 1 : 2;
			$bytes = fread($pipe, 65536);
			if ($bytes === false) throw new RuntimeException('Unable to read process output');
			$output[$index] .= $bytes;
			if (strlen($output[$index]) > $limits[$index]) throw new RuntimeException('Process output exceeds the supported size');
		}
		if ($write) {
			$written = @fwrite($pipes[0], substr($input, $offset, 65536));
			if ($written === false || $written === 0) throw new RuntimeException('Unable to send process input');
			$offset += $written;
		}
	}
	return $output;
}

/** A failed transport must not leave a child holding the mutation lock. */
function zfsmAbortProcess($process, $pipes) {
	@proc_terminate($process);
	foreach ($pipes as $pipe) if (is_resource($pipe)) @fclose($pipe);
	$deadline = microtime(true) + 0.2;
	do { $status = proc_get_status($process); if (!$status['running']) break; usleep(10000); } while (microtime(true) < $deadline);
	if ($status['running']) @proc_terminate($process, 9);
	@proc_close($process);
}

function runProcess($command, $args = array(), $stdin = null) {
	$descriptor_spec = array(
		0 => array('pipe', 'r'),
		1 => array('pipe', 'w'),
		2 => array('redirect', 1)
	);
	$cmd = array_merge(array($command), array_values($args));
	if (is_resource($GLOBALS['zfsm_operation_lock_handle'] ?? null)) $descriptor_spec[3]=$GLOBALS['zfsm_operation_lock_handle'];
	// HTTP inventory gets a shared wall-clock budget, including blocked ZFS CLI
	// calls. Never apply a timeout to administrative/mutating commands.
	$inventory_deadline = $GLOBALS['zfsm_inventory_deadline'] ?? null;
	if ($inventory_deadline !== null) {
		$remaining = $inventory_deadline - microtime(true);
		if ($remaining <= 0) throw new RuntimeException('ZFS inventory timed out');
		$timeout = is_executable('/usr/bin/timeout') ? '/usr/bin/timeout' : '/bin/timeout';
		if (!is_executable($timeout)) throw new RuntimeException('The system timeout utility is unavailable');
		$duration = number_format(max(0.001, $remaining), 3, '.', '').'s';
		$cmd = array_merge(array($timeout, '--signal=TERM', '--kill-after=2s', $duration), $cmd);
	}
	$pipes = array();
	$process = @proc_open($cmd, $descriptor_spec, $pipes, null, null, array('bypass_shell' => true));

	if (!is_resource($process)) {
		return array('code' => ZFSM_ERR_UNABLE_TO_CREATE_PROC, 'output' => 'Unable to start '.basename($command));
	}

	try {
		$prefetched = zfsmProcessInput($process, $pipes, $stdin ?? '', $inventory_deadline);
		fclose($pipes[0]); unset($pipes[0]);
		stream_set_blocking($pipes[1], true);
		$remaining_output = stream_get_contents($pipes[1]);
		if ($remaining_output === false) throw new RuntimeException('Unable to read process output');
		$output = $prefetched[1].$remaining_output;
		fclose($pipes[1]); unset($pipes[1]);
		$code = proc_close($process); $process = null;
	} catch (Throwable $error) {
		if (is_resource($process)) zfsmAbortProcess($process, $pipes);
		if ($inventory_deadline !== null) throw new RuntimeException('ZFS inventory transport failed or timed out');
		// Native output and input may contain key material; expose no payload.
		return ['code'=>ZFSM_ERR_UNABLE_TO_CREATE_PROC, 'output'=>'Unable to communicate with '.basename($command)];
	}
	if ($inventory_deadline !== null && in_array($code, array(124, 137), true)) throw new RuntimeException('ZFS inventory timed out while running '.basename($command));

	$answer=array('code' => $code, 'output' => trim((string)$output));
	if(function_exists('zfsmAuditRecordFailure'))zfsmAuditRecordFailure($command,$args,$answer);
	return $answer;
}

function commandAnswer($subject, $result) {
	$answer = array('succeeded' => array(), 'failed' => array());
	if (($result['code'] ?? 1) === 0) {
		$answer['succeeded'][$subject] = 0;
	} else {
		if(function_exists('zfsmAuditRecordFailure'))zfsmAuditRecordFailure(null,[],$result);
		$message = trim((string)($result['output'] ?? ''));
		$answer['failed'][$subject] = $message !== '' ? $message : (int)($result['code'] ?? 1);
	}
	return $answer;
}
	
function cleanZFSCreateDatasetParams($params) {
	$retParams = is_array($params) ? $params : array();
	$encryption = array_key_exists('encryption', $retParams) ? $retParams['encryption'] : 'inherit';
	if (!is_string($encryption) || !in_array($encryption, ['inherit','new-root','no','yes'], true)) throw new InvalidArgumentException('Encryption must inherit from the parent or create a new root');

	unset($retParams['zpool']);
	unset($retParams['name']);
		
	foreach ($retParams as $key => $value):
		if ($value == 'inherit'):
			unset($retParams[$key]);
		endif;
	endforeach;
		
	if (($retParams['mount'] ?? 'yes') == 'no'):
		$retParams['mountpoint'] = 'none';
	else:
		if (!isset($retParams['mountpoint']) || $retParams['mountpoint'] == ''):
			unset($retParams['mountpoint']);
		endif;
	endif;

	if (in_array($encryption, ['inherit','no'], true)):
		unset($retParams['encryption']);
		unset($retParams['passphrase'], $retParams['keyformat'], $retParams['keylocation']);
	else:
		$retParams['encryption'] = 'on';
		$retParams['keylocation'] = 'prompt';
		$retParams['keyformat'] = 'passphrase';
	endif;
		
	unset($retParams['mount']);
	
	if (!isset($retParams['quota']) || $retParams['quota'] == '' || $retParams['quota'] == '0'):
		unset($retParams['quota']);
	else:
		$retParams['quota'] = $retParams['quota'].$retParams['quotaunit'];
	endif;

	unset($retParams['quotaunit']);
		
	return $retParams;
}
	
function sortDatasetArray($datasetArray) {
	if (!is_array($datasetArray)) {
		return array();
	}

	if (isset($datasetArray['snapshots']) && is_array($datasetArray['snapshots']) && count($datasetArray['snapshots']) > 0):
		usort($datasetArray['snapshots'], function($item1, $item2) { 
			return ($item1['creation'] ?? 0) <=> ($item2['creation'] ?? 0);
		});
	endif;

	if (!isset($datasetArray['child']) || is_null($datasetArray['child']) || !is_array($datasetArray['child']) || count($datasetArray['child']) <= 0):
		return $datasetArray;
	endif;

	ksort($datasetArray['child']);
	
	foreach ($datasetArray['child'] as $dataset):
		if (is_array($dataset) && isset($dataset['name'])) {
			$datasetArray['child'][$dataset['name']] = sortDatasetArray($dataset);
		}
	endforeach;
	
	return $datasetArray;
}

function generatePoolDatasetOptions($dataset_array) {
	if (!isset($dataset_array['child']) || !is_array($dataset_array['child']) || count($dataset_array['child']) <= 0):
		return;
	endif;
	
	foreach ($dataset_array['child'] as $zdataset):
		$option = ltrim(stristr($zdataset['name'], '/'), '/')."/";
		echo '<option value="'.htmlspecialchars($option, ENT_QUOTES, 'UTF-8').'">';

		if (count($zdataset['child']) > 0):
			generatePoolDatasetOptions($zdataset);
		endif;
	endforeach;
}

?>
