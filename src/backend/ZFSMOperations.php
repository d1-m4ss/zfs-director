<?php
/* Branding renamed to ZFS Director on 2026-10-16; GPL-2.0-or-later. */

define('__ROOT__', dirname(dirname(__FILE__)));

require_once __ROOT__."/include/ZFSMBase.php";
require_once __ROOT__."/include/ZFSMError.php";
require_once __ROOT__."/include/ZFSMHelpers.php";
require_once __ROOT__."/include/ZFSMDirectory.php";
require_once __ROOT__."/include/ZFSMDirectoryMutation.php";
require_once __ROOT__."/include/ZFSMRecoveryCleanup.php";
require_once __ROOT__."/include/ZFSMAudit.php";
require_once __ROOT__."/include/ZFSMRollback.php";
require_once __ROOT__."/include/ZFSMIdentity.php";
require_once __ROOT__."/include/ZFSMDestroy.php";
require_once __ROOT__."/include/ZFSMJobProcess.php";
require_once __ROOT__."/include/ZFSMJobs.php";
require_once __ROOT__."/include/ZFSMRequestJobs.php";
require_once __ROOT__."/include/ZFSMDeletionJobs.php";
require_once __ROOT__."/include/ZFSMJobRunner.php";
require_once __ROOT__."/include/ZFSMConfinedConversion.php";
require_once __ROOT__."/include/ZFSMSettings.php";
require_once __ROOT__."/include/ZFSMProtection.php";
require_once __ROOT__."/include/ZFSMSanoid.php";
require_once __ROOT__."/include/ZFSMSyncoid.php";
require_once __ROOT__."/include/ZFSMProtectionJobs.php";
require_once __ROOT__."/include/ZFSMOwnership.php";
require_once __ROOT__."/include/ZFSMConversion.php";
require_once __ROOT__."/include/ZFSMPoolDiagnostics.php";
require_once __ROOT__."/include/ZFSMScrub.php";
require_once __ROOT__."/include/ZFSMMonitor.php";
require_once __ROOT__."/include/ZFSMMaintenance.php";
require_once __ROOT__."/include/ZFSMExplorer.php";
require_once __ROOT__."/include/ZFSMRestore.php";
require_once __ROOT__."/include/ZFSMUsage.php";
require_once __ROOT__."/include/ZFSMDependencies.php";
require_once __ROOT__."/include/ZFSMReviewedOperations.php";
require_once __ROOT__."/include/ZFSMQuotas.php";
require_once __ROOT__."/include/ZFSMSnapshotReferences.php";
require_once __ROOT__."/include/ZFSMEncryptionState.php";
require_once __ROOT__."/include/ZFSMACL.php";
require_once __ROOT__."/include/ZFSMACLEditor.php";
$unraid_helpers = '/usr/local/emhttp/webGui/include/Helpers.php';
$unraid_publish = '/usr/local/emhttp/webGui/include/publish.php';
if (is_file($unraid_helpers)) require_once $unraid_helpers;
if (is_file($unraid_publish)) require_once $unraid_publish;

function refreshData() {
	return touch('/tmp/zfs.master.ui-reload');
}

function buildArrayRet() {
	return array('succeeded' => array(), 'failed' => array());
}

function zfsmFailure($subject, $message) {
	$ret = buildArrayRet();
	$ret['failed'][$subject] = $message;
	return $ret;
}

function zfsmValidPoolName($name) {
	return is_string($name) && strlen($name) > 0 && strlen($name) <= 255
		&& preg_match('/^[A-Za-z][A-Za-z0-9_.:-]*$/D', $name) === 1;
}

function zfsmValidDatasetName($name) {
	if (!is_string($name) || strlen($name) === 0 || strlen($name) > 1024 || strpos($name, '@') !== false || strpos($name, '#') !== false) return false;
	$parts = explode('/', $name);
	foreach ($parts as $part) {
		if ($part === '' || $part === '.' || $part === '..' || preg_match('/^[A-Za-z0-9_.: -]+$/D', $part) !== 1) return false;
	}
	return zfsmValidPoolName($parts[0]);
}

function zfsmValidSnapshotName($name) {
	if (!is_string($name) || substr_count($name, '@') !== 1) return false;
	list($dataset, $snapshot) = explode('@', $name, 2);
	return zfsmValidDatasetName($dataset) && $snapshot !== '' && strlen($snapshot) <= 255
		&& preg_match('/^[A-Za-z0-9_.: -]+$/D', $snapshot) === 1;
}

function zfsmDatasetExists($name, $types = 'filesystem,volume') {
	if (!zfsmValidDatasetName($name)) return false;
	$result = runProcess('zfs', array('list', '-H', '-o', 'name', '-t', $types, $name));
	return ($result['code'] ?? 1) === 0 && trim($result['output'] ?? '') === $name;
}

function zfsmSnapshotExists($name) {
	if (!zfsmValidSnapshotName($name)) return false;
	$result = runProcess('zfs', array('list', '-H', '-o', 'name', '-t', 'snapshot', $name));
	return ($result['code'] ?? 1) === 0 && trim($result['output'] ?? '') === $name;
}

function zfsmDatasetColumns() {
	return array('name', 'type', 'used', 'available', 'referenced', 'encryption', 'keystatus', 'mountpoint', 'compression', 'compressratio', 'usedbysnapshots', 'quota', 'recordsize', 'atime', 'xattr', 'primarycache', 'readonly', 'casesensitivity', 'sync', 'creation', 'origin', 'volblocksize', 'encryptionroot', 'mounted', 'keyformat', 'guid', 'usedbydataset', 'usedbychildren', 'usedbyrefreservation', 'refquota', 'reservation', 'refreservation', 'dedup');
}

function zfsmSnapshotColumns() {
	return array('name', 'used', 'referenced', 'written', 'defer_destroy', 'userrefs', 'creation', 'guid', 'clones');
}

// Optional read-only metadata never changes mutation scope or hides snapshots.
function zfsmSnapshotMetadata(&$snapshots, $clones_available = true) {
	$held = [];
	foreach ($snapshots as $index => &$snapshot) {
		$snapshot['clone_dependencies'] = null;
		if ($clones_available) {
			$clones = isset($snapshot['clones']) ? explode(',', $snapshot['clones']) : [];
			if (count(array_filter($clones, 'zfsmValidDatasetName')) === count($clones) && count(array_unique($clones)) === count($clones)) $snapshot['clone_dependencies'] = $clones;
		}
		$snapshot['hold_names'] = ($snapshot['userrefs'] ?? null) === 0 ? [] : null;
		if (($snapshot['userrefs'] ?? 0) > 0) $held[$snapshot['name']] = $index;
	}
	unset($snapshot);
	foreach (array_chunk($held, 100, true) as $batch) {
		if (isset($GLOBALS['zfsm_inventory_deadline']) && microtime(true) >= $GLOBALS['zfsm_inventory_deadline']) break;
		try {
			$result = runProcess('zfs', array_merge(['holds', '-H'], array_keys($batch)));
			if (($result['code'] ?? 1) !== 0) continue;
			$names = array_fill_keys(array_keys($batch), []); $valid = true;
			$text = rtrim($result['output'] ?? '', "\r\n");
			foreach ($text === '' ? [] : preg_split('/\r\n|\r|\n/', $text) as $line) {
				$parts = explode("\t", $line);
				if (count($parts) !== 3 || !isset($names[$parts[0]]) || $parts[1] === '' || $parts[2] === '' || preg_match('/[\x00-\x1F\x7F]/', $parts[1].$parts[2]) || in_array($parts[1], $names[$parts[0]], true)) { $valid = false; break; }
				$names[$parts[0]][] = $parts[1];
			}
			if ($valid) foreach ($batch as $name => $index) {
				if (count($names[$name]) !== $snapshots[$index]['userrefs']) continue;
				sort($names[$name], SORT_STRING); $snapshots[$index]['hold_names'] = $names[$name];
			}
		} catch (Throwable $error) { /* Failed optional probes remain Unknown. */ }
	}
}

function zfsmNormalizeProperty($property, $value) {
	if ($value === '-') {
		if (in_array($property, ['keystatus','mountpoint','encryptionroot','keyformat'], true)) return 'none';
		return null;
	}
	if (in_array($property, ['quota','refquota','reservation','refreservation'], true) && $value === 'none') return 0;
	if ($property === 'compressratio') {
		if (preg_match('/^([0-9.]+)x$/', $value, $match)) return (int)round(((float)$match[1]) * 100);
		return is_numeric($value) ? (int)round(((float)$value)*100) : 0;
	}
	$numeric = array('used', 'available', 'referenced', 'usedbysnapshots', 'quota', 'recordsize', 'creation', 'volblocksize', 'written', 'userrefs', 'usedbydataset', 'usedbychildren', 'usedbyrefreservation', 'refquota', 'reservation', 'refreservation');
	return in_array($property, $numeric, true) && is_numeric($value) ? (int)$value : $value;
}

function zfsmParseTable($output, $columns) {
	if (!is_string($output) || !is_array($columns) || !$columns) throw new RuntimeException('Invalid inventory table');
	$rows = array(); $names = array();
	// Strip line endings only: trimming tabs would hide truncated first/last cells.
	$text = rtrim($output, "\r\n");
	if ($text === '') return $rows;
	foreach (preg_split('/\r\n|\r|\n/', $text) as $line) {
		$parts = explode("\t", $line);
		if (count($parts) !== count($columns)) throw new RuntimeException('Malformed inventory row');
		$row = array();
		foreach ($columns as $index => $property) {
			$raw = $parts[$index];
			if ($raw === '' || str_contains($raw, "\0")) throw new RuntimeException('Empty or invalid inventory value: '.$property);
			if ($property === 'name') {
				if (!(in_array('type',$columns,true) ? zfsmValidDatasetName($raw) : (in_array('defer_destroy',$columns,true) ? zfsmValidSnapshotName($raw) : (str_contains($raw,'@') ? zfsmValidSnapshotName($raw) : zfsmValidDatasetName($raw)))) || isset($names[$raw])) throw new RuntimeException('Invalid or duplicate inventory object');
				$names[$raw] = true;
			}
			if ($property === 'type' && !in_array($raw, ['filesystem','volume'], true)) throw new RuntimeException('Invalid inventory object type');
			if ($property === 'guid' && (!ctype_digit($raw) || $raw === '0' || strlen($raw) > 20 || (strlen($raw) === 20 && strcmp($raw,'18446744073709551615') > 0))) throw new RuntimeException('Invalid inventory GUID');
			if ($property === 'mounted' && !in_array($raw, ['yes','no','-'], true)) throw new RuntimeException('Invalid mounted state');
			if ($property === 'keystatus' && !in_array($raw, ['none','available','unavailable','-'], true)) throw new RuntimeException('Invalid key status');
			if ($property === 'encryptionroot' && !in_array($raw, ['-','none'], true) && !zfsmValidDatasetName($raw)) throw new RuntimeException('Invalid encryption root');
			$numeric = ['used','available','referenced','usedbysnapshots','quota','recordsize','creation','volblocksize','written','userrefs','usedbydataset','usedbychildren','usedbyrefreservation','refquota','reservation','refreservation'];
			if (in_array($property,$numeric,true) && $raw !== '-' && !ctype_digit($raw) && !(in_array($property,['quota','refquota','reservation','refreservation'],true) && $raw === 'none')) throw new RuntimeException('Invalid numeric inventory value: '.$property);
			$value = zfsmNormalizeProperty($property, $raw);
			if ($value !== null) $row[$property] = $value;
		}
		$rows[] = $row;
	}
	return $rows;
}

function zfsmMatchesExclusion($name, $pattern) {
	if (!is_string($pattern) || trim($pattern) === '') return false;
	$regex = '#'.str_replace('#', '\\#', $pattern).'#i';
	$result = @preg_match($regex, $name);
	if ($result === false) {
		error_log('ZFS Director ignored invalid dataset exclusion pattern: '.$pattern);
		return false;
	}
	return $result === 1;
}

function zfsmLoadUserProperties($dataset_root, &$datasets) {
	$result = runProcess('zfs', array('get', '-H', '-p', '-r', '-t', 'filesystem,volume', '-o', 'name,property,value,source', 'all', $dataset_root));
	if (($result['code'] ?? 1) !== 0) return;
	foreach (preg_split('/\r\n|\r|\n/', trim($result['output'] ?? ''), -1, PREG_SPLIT_NO_EMPTY) ?: array() as $line) {
		$parts = explode("\t", $line, 4);
		if (count($parts) < 3 || strpos($parts[1], ':') === false || !isset($datasets[$parts[0]])) continue;
		$datasets[$parts[0]][$parts[1]] = $parts[2];
	}
}

function zfsmBuildDatasetNode($name, $datasets, $children) {
	$node = $datasets[$name];
	$node['child'] = array();
	foreach ($children[$name] ?? array() as $child_name) $node['child'][$child_name] = zfsmBuildDatasetNode($child_name, $datasets, $children);
	ksort($node['child']);
	return $node;
}

function zfsmEmptyDatasetTree($pool, $error = '') {
	$tree = array('name' => $pool, 'type' => 'filesystem', 'mountpoint' => 'none', 'child' => array(), 'directories' => array(), 'snapshots' => array(), 'total_snapshots' => 0);
	if ($error !== '') $tree['_error'] = $error;
	return $tree;
}

function zfsmLoadPoolTree($pool, $include_snapshots, $exclusion_pattern, $extended) {
	if (!zfsmValidPoolName($pool)) return zfsmEmptyDatasetTree($pool, 'Invalid pool name');
	$columns = zfsmDatasetColumns();
	$result = runProcess('zfs', array('list', '-H', '-p', '-r', '-t', 'filesystem,volume', '-o', implode(',', $columns), $pool));
	if (($result['code'] ?? 1) !== 0) {
		$error = trim($result['output'] ?? 'Unable to list datasets');
		error_log('ZFS Director dataset inventory failed for '.$pool.': '.$error);
		return zfsmEmptyDatasetTree($pool, $error);
	}

	$datasets = array();
	$excluded_roots = array();
	try { $rows = zfsmParseTable($result['output'], $columns); }
	catch (RuntimeException $error) { return zfsmEmptyDatasetTree($pool, $error->getMessage()); }
	foreach ($rows as $row) {
		$name = $row['name'] ?? '';
		if ($name !== $pool && !str_starts_with($name, $pool.'/')) return zfsmEmptyDatasetTree($pool, 'Inventory object outside requested pool');
		$excluded = zfsmMatchesExclusion($name, $exclusion_pattern);
		foreach ($excluded_roots as $root) if ($name === $root || str_starts_with($name, $root.'/')) $excluded = true;
		if ($excluded) {
			$excluded_roots[] = $name;
			continue;
		}
		$row['child'] = array();
		$row['directories'] = array();
		$row['snapshots'] = array();
		zfsmEncryptionMetadata($row);
		$datasets[$name] = $row;
	}

	if (!isset($datasets[$pool])) return zfsmEmptyDatasetTree($pool, 'Pool root dataset was not returned by zfs list');
	if ((int)$extended === 1) zfsmLoadUserProperties($pool, $datasets);

	$total_snapshots = 0;
	if ($include_snapshots) {
		$snapshot_columns = zfsmSnapshotColumns();
		$snap_result = runProcess('zfs', array('list', '-H', '-p', '-r', '-t', 'snapshot', '-o', implode(',', $snapshot_columns), $pool));
		$clones_available = true;
		if (($snap_result['code'] ?? 1) !== 0) {
			$clones_available = false; $snapshot_columns = array_values(array_diff($snapshot_columns, ['clones']));
			$snap_result = runProcess('zfs', ['list', '-H', '-p', '-r', '-t', 'snapshot', '-o', implode(',', $snapshot_columns), $pool]);
		}
		if (($snap_result['code'] ?? 1) !== 0) {
			$error = trim($snap_result['output'] ?? 'Unable to list snapshots');
			error_log('ZFS Director snapshot inventory failed for '.$pool.': '.$error);
			$datasets[$pool]['_snapshot_error'] = $error;
		} else {
			try { $snapshots = zfsmParseTable($snap_result['output'], $snapshot_columns); }
			catch (RuntimeException $error) { $snapshots = []; $datasets[$pool]['_snapshot_error'] = $error->getMessage(); }
			$snapshots = array_values(array_filter($snapshots, fn($snapshot) => isset($datasets[explode('@', $snapshot['name'], 2)[0]])));
			zfsmSnapshotMetadata($snapshots, $clones_available);
			zfsmSnapshotReferenceStore($snapshots,array_map(fn($row)=>(string)$row['guid'],$datasets));
			zfsmBookmarkMetadata($pool,$datasets);
			foreach ($snapshots as $snapshot) {
				$dataset_name = explode('@', $snapshot['name'] ?? '', 2)[0];
				if (!isset($datasets[$dataset_name])) continue;
				$datasets[$dataset_name]['snapshots'][] = $snapshot;
				$total_snapshots++;
			}
		}
	}

	$children = array();
	foreach (array_keys($datasets) as $name) {
		if ($name === $pool || strpos($name, '/') === false) continue;
		$parent = substr($name, 0, strrpos($name, '/'));
		if (!isset($datasets[$parent])) return zfsmEmptyDatasetTree($pool, 'Inventory dataset parent is missing');
		$children[$parent][] = $name;
	}
	$tree = zfsmBuildDatasetNode($pool, $datasets, $children);
	$tree['total_snapshots'] = $total_snapshots;
	return sortDatasetArray($tree);
}

function listDirectories($path, $childs, $zexc_pattern) {
	if (!is_string($path) || $path === '' || $path === 'none' || $path === 'legacy' || $path[0] !== '/' || !is_dir($path)) return array();
	$real_path = realpath($path);
	if ($real_path === false || $real_path === '/') return array();
	$remove = array($real_path.'/..', $real_path.'/.');
	foreach (is_array($childs) ? $childs : array() as $child) if (isset($child['mountpoint']) && is_string($child['mountpoint'])) $remove[] = rtrim($child['mountpoint'], '/');
	$dirs = glob(rtrim($real_path, '/').'/{,.}*', GLOB_ONLYDIR | GLOB_BRACE);
	if (!is_array($dirs)) return array();
	$dirs = array_values(array_filter(array_unique(array_diff($dirs, $remove)), function($dir) { return !zfsmPathHasSymlink($dir); }));
	if ($zexc_pattern !== '') $dirs = array_values(array_filter($dirs, function($dir) use ($zexc_pattern) { return !zfsmMatchesExclusion($dir, $zexc_pattern); }));
	sort($dirs, SORT_NATURAL | SORT_FLAG_CASE);
	return $dirs;
}

function saveConfig($array) {
	$content = '';
	foreach ($array as $key => $elem) {
		if (!is_array($elem)) continue;
		$content .= '['.$key."]\n";
		foreach ($elem as $key2 => $elem2) {
			$values = is_array($elem2) ? $elem2 : array($elem2);
			foreach ($values as $value) {
				$value = str_replace(array('\\', '"', '$', "\r"), array('\\\\', '\\"', '\\$', ''), (string)$value);
				$content .= $key2.(is_array($elem2) ? '[]' : '').' = "'.$value."\"\n";
			}
		}
	}
	$file=$GLOBALS['plugin_config'];
	if (is_link($file)) return false;
	$temp=$file.'.'.bin2hex(random_bytes(6)).'.tmp'; $handle=@fopen($temp,'xb');
	if (!$handle) return false;
	@chmod($temp,0600);
	$flushed=false;
	try { $flushed=fwrite($handle,$content)===strlen($content) && fflush($handle) && (!function_exists('fsync')||fsync($handle)); }
	finally { fclose($handle); }
	if (!$flushed || !@rename($temp,$file)) { @unlink($temp); return false; }
	return true;
}

function addToDirectoryListing($zdataset) {
	if (!zfsmDatasetExists($zdataset, 'filesystem')) return zfsmFailure($zdataset, 'Dataset does not exist or is not a filesystem');
	$config = parse_plugin_cfg('zfs.master.ui', true);
	$current = preg_split('/\r\n|\r|\n/', $config['general']['directory_listing'] ?? '', -1, PREG_SPLIT_NO_EMPTY) ?: array();
	if (in_array($zdataset, $current, true)) return zfsmFailure($zdataset, ZFSM_ERR_ALREADY_SET_IN_CONFIG);
	$current[] = $zdataset;
	$config['general']['directory_listing'] = implode(PHP_EOL, array_values(array_unique($current)));
	$saved = saveConfig($config);
	$ret = buildArrayRet();
	$ret[$saved ? 'succeeded' : 'failed'][$zdataset] = $saved ? 0 : ZFSM_ERR_UNABLE_TO_SAVE;
	return $ret;
}

function removeFromDirectoryListing($zdataset) {
	$config = parse_plugin_cfg('zfs.master.ui', true);
	$current = preg_split('/\r\n|\r|\n/', $config['general']['directory_listing'] ?? '', -1, PREG_SPLIT_NO_EMPTY) ?: array();
	$key = array_search($zdataset, $current, true);
	if ($key === false) return zfsmFailure($zdataset, ZFSM_ERR_NOT_IN_CONFIG);
	unset($current[$key]);
	$config['general']['directory_listing'] = implode(PHP_EOL, $current);
	$saved = saveConfig($config);
	$ret = buildArrayRet();
	$ret[$saved ? 'succeeded' : 'failed'][$zdataset] = $saved ? 0 : ZFSM_ERR_UNABLE_TO_SAVE;
	return $ret;
}

function getZFSPools($strict = false) {
	$ret_pools = array();
	$result = runProcess('zpool', array('list', '-H', '-p', '-o', 'name,size,alloc,free,health'));
	if (($result['code'] ?? 1) !== 0) {
		if (stripos($result['output'] ?? '', 'no pools available') === false) {
			$error = 'ZFS Director pool inventory failed: '.($result['output'] ?? 'unknown error');
			if ($strict) throw new RuntimeException($error);
			error_log($error);
		}
		return $ret_pools;
	}
	foreach (preg_split('/\r\n|\r|\n/', trim($result['output'] ?? ''), -1, PREG_SPLIT_NO_EMPTY) ?: array() as $line) {
		$parts = explode("\t", $line);
		if (count($parts) < 5 || !zfsmValidPoolName($parts[0])) continue;
		$ret_pools[$parts[0]] = array('Pool' => $parts[0], 'Health' => $parts[4], 'Name' => '', 'Size' => $parts[1], 'MountPoint' => '', 'Refer' => '', 'Used' => $parts[2], 'Free' => $parts[3], 'Snapshots' => 0, 'Origin' => '');
	}
	return $ret_pools;
}

// HTTP inventory must not depend on a running daemon or Unraid's publish flag.
// The optional pool limits the second, progressive snapshot-loading phase.
function zfsmReadInventory($config, $include_snapshots = true, $pool = '') {
	$previous_deadline = $GLOBALS['zfsm_inventory_deadline'] ?? null;
	$GLOBALS['zfsm_inventory_deadline'] = microtime(true) + 45;
	try {
		return zfsmCollectInventory($config, $include_snapshots, $pool);
	} finally {
		if ($previous_deadline === null) unset($GLOBALS['zfsm_inventory_deadline']);
		else $GLOBALS['zfsm_inventory_deadline'] = $previous_deadline;
	}
}

function zfsmCollectInventory($config, $include_snapshots, $pool) {
	if ($pool !== '' && !zfsmValidPoolName($pool)) throw new InvalidArgumentException('Invalid pool name');
	$pools = getZFSPools(true);
	if ($pool !== '') {
		if (!isset($pools[$pool])) throw new RuntimeException('Pool is no longer imported: '.$pool);
		$pools = array($pool => $pools[$pool]);
	}
	$data = array('pools' => $pools, 'devices' => array(), 'datasets' => array(), 'errors' => array());
	foreach ($pools as $name => $info) {
		$data['devices'][$name] = getZFSPoolDevices($name);
		$tree = $include_snapshots
			? getZFSPoolDatasetsAndSnapshots($name, $config['dataset_exclusion'], 0, $config['directory_listing'])
			: getZFSPoolDatasets($name, $config['dataset_exclusion'], 0, $config['directory_listing']);
		zfsmAttachDirectoryIdentities($tree);
		$data['datasets'][$name] = $tree;
		$data['pools'][$name]['MountPoint'] = $tree['mountpoint'] ?? '';
		$data['pools'][$name]['Snapshots'] = $include_snapshots ? ($tree['total_snapshots'] ?? 0) : null;
		foreach (array('_error', '_snapshot_error') as $key) {
			if (!empty($tree[$key])) $data['errors'][$name] = ($data['errors'][$name] ?? '').$tree[$key].' ';
		}
	}
	return array('op' => $include_snapshots ? 'getAll' : 'getDatasets', 'data' => $data);
}

function getZFSPoolDevices($zpool) {
	if (!zfsmValidPoolName($zpool)) return '';
	$result = runProcess('zpool', array('status', '-v', $zpool));
	if (($result['code'] ?? 1) !== 0) return '';
	$devices = array();
	$in_config = false;
	$skipped_pool = false;
	foreach (preg_split('/\r\n|\r|\n/', $result['output'] ?? '') ?: array() as $line) {
		if (trim($line) === 'config:') { $in_config = true; continue; }
		if (!$in_config) continue;
		if (str_starts_with(trim($line), 'errors:')) break;
		$parts = preg_split('/\s+/', trim($line), -1, PREG_SPLIT_NO_EMPTY);
		if (!$parts || $parts[0] === 'NAME' || count($parts) < 2) continue;
		if (!$skipped_pool && $parts[0] === $zpool) { $skipped_pool = true; continue; }
		$devices[] = $parts[0];
	}
	return implode("\n", $devices);
}

function getZFSPoolDatasets($zpool, $zexc_pattern, $ext, $directory_listing = array()) {
	$result = zfsmLoadPoolTree($zpool, false, $zexc_pattern, $ext);
	$result['directories'] = listDirectories($result['mountpoint'] ?? '', $result['child'] ?? array(), $zexc_pattern);
	if ($directory_listing) $result['child'] = getDatasetDirectories($result['child'] ?? array(), $directory_listing, $zexc_pattern, $ext);
	return $result;
}

function getZFSPoolDatasetsAndSnapshots($zpool, $zexc_pattern, $ext, $directory_listing = array()) {
	$result = zfsmLoadPoolTree($zpool, true, $zexc_pattern, $ext);
	$result['directories'] = listDirectories($result['mountpoint'] ?? '', $result['child'] ?? array(), $zexc_pattern);
	if ($directory_listing) $result['child'] = getDatasetDirectories($result['child'] ?? array(), $directory_listing, $zexc_pattern, $ext);
	return $result;
}

function getDatasetDirectories($dataset_tree, $directory_listing, $zexc_pattern, $ext) {
	foreach ($dataset_tree as &$dataset) {
		if (in_array($dataset['name'] ?? '', $directory_listing, true)) $dataset['directories'] = listDirectories($dataset['mountpoint'] ?? '', $dataset['child'] ?? array(), $zexc_pattern);
		if (!empty($dataset['child'])) $dataset['child'] = getDatasetDirectories($dataset['child'], $directory_listing, $zexc_pattern, $ext);
	}
	return $dataset_tree;
}

function getDatasetProperty($zpool, $zdataset, $zproperty) {
	if (!zfsmValidDatasetName($zdataset) || !preg_match('/^[A-Za-z][A-Za-z0-9_.:-]*$/D', $zproperty)) return null;
	$result = runProcess('zfs', array('get', '-H', '-p', '-o', 'value', $zproperty, $zdataset));
	return ($result['code'] ?? 1) === 0 ? zfsmNormalizeProperty($zproperty, trim($result['output'] ?? '')) : null;
}

function zfsmReadDatasetPermissions($properties) {
	$unknown=['status'=>'unknown','owner'=>null,'group'=>null,'uid'=>null,'gid'=>null,'mode'=>null,'acl_type'=>'unknown','acl_state'=>'unknown','reason'=>'Permissions require a verified mounted filesystem'];
	if (($properties['type']??'')!=='filesystem' || ($properties['mounted']??'')!=='yes' || ($properties['keystatus']??'')==='unavailable') return $unknown;
	$mount=$properties['mountpoint']??''; $dataset=$properties['name']??'';
	try {
		if (!is_string($mount) || !str_starts_with($mount,'/') || $mount==='/' || zfsmPathHasSymlink($mount) || realpath($mount)!==$mount || !zfsmLiveZfsMount($mount,$dataset,zfsmMountInfo())) return $unknown;
		clearstatcache(true,$mount); $stat=@lstat($mount);
		if (!$stat || ($stat['mode']&0170000)!==0040000 || zfsmPathHasSymlink($mount) || !zfsmLiveZfsMount($mount,$dataset,zfsmMountInfo())) return $unknown;
		$owner=function_exists('posix_getpwuid')?@posix_getpwuid($stat['uid']):false;
		$group=function_exists('posix_getgrgid')?@posix_getgrgid($stat['gid']):false;
		return ['status'=>'known','owner'=>is_string($owner['name']??null)?$owner['name']:(string)$stat['uid'],'group'=>is_string($group['name']??null)?$group['name']:(string)$stat['gid'],'uid'=>(string)$stat['uid'],'gid'=>(string)$stat['gid'],'mode'=>sprintf('%04o',$stat['mode']&07777),'acl_type'=>'unknown','acl_state'=>'unknown','reason'=>''];
	} catch (Throwable $error) { return $unknown; }
}

function getAllDatasetProperties($zdataset, $ext) {
	if (!zfsmDatasetExists($zdataset)) return array('_error' => 'Dataset does not exist');
	$columns = zfsmDatasetColumns();
	$result = runProcess('zfs', array('list', '-H', '-p', '-o', implode(',', $columns), $zdataset));
	if (($result['code'] ?? 1) !== 0) return array('_error' => trim($result['output'] ?? 'Unable to read dataset properties'));
	try{$rows = zfsmParseTable($result['output'], $columns);}catch(Throwable $error){return ['_error'=>'Dataset properties are incomplete: '.$error->getMessage()];}
	$properties = $rows[0] ?? array();
	if (!$properties||($properties['name']??'')!==$zdataset) return array('_error' => 'ZFS returned no matching dataset properties');
	$sources=runProcess('zfs',['get','-H','-p','-o','property,value,source',implode(',',zfsmAllowedDatasetProperties()),$zdataset]);
	$properties['_sources']=[];
	if(($sources['code']??1)===0)foreach(preg_split('/\r\n|\r|\n/',trim($sources['output']??''),-1,PREG_SPLIT_NO_EMPTY)?:[] as $line){$parts=explode("\t",$line);if(count($parts)===3&&in_array($parts[0],zfsmAllowedDatasetProperties(),true))$properties['_sources'][$parts[0]]=$parts[2];}
	// Report security metadata without granting it to the mutation allowlist.
	$security_properties = ['encryption','encryptionroot','keyformat','keystatus'];
	if (($properties['type'] ?? '') === 'filesystem') $security_properties[] = 'mounted';
	$readonly_groups = [$security_properties];
	$acl_values = ['acltype'=>['off','posix','posixacl','nfsv4'], 'aclmode'=>['discard','groupmask','passthrough','restricted'], 'aclinherit'=>['discard','noallow','restricted','passthrough','passthrough-x']];
	if (($properties['type'] ?? '') === 'filesystem') $readonly_groups[] = array_keys($acl_values);
	foreach ($readonly_groups as $reported) {
		$metadata = runProcess('zfs', ['get','-H','-p','-o','property,value,source',implode(',', $reported),$zdataset]);
		if (($metadata['code'] ?? 1) !== 0) continue;
		$values = []; $reported_sources = []; $valid = true;
		foreach (preg_split('/\r\n|\r|\n/', rtrim($metadata['output'] ?? '', "\r\n")) as $line) {
			$parts = explode("\t", $line);
			if (count($parts) !== 3 || !in_array($parts[0], $reported, true) || isset($values[$parts[0]]) || $parts[1] === '' || preg_match('/[\x00-\x1F\x7F]/', $parts[1])) { $valid = false; break; }
			[$property,$value,$source] = $parts;
			$ancestor = str_starts_with($source, 'inherited from ') ? substr($source, 15) : null;
			if (!in_array($source, ['local','default','received','temporary','-'], true) && !($ancestor !== null && zfsmValidDatasetName($ancestor) && str_starts_with($zdataset, $ancestor.'/'))) { $valid = false; break; }
			$normalized = zfsmNormalizeProperty($property, $value);
			if (isset($acl_values[$property]) ? !in_array($value, $acl_values[$property], true) : (!array_key_exists($property, $properties) || $properties[$property] !== $normalized)) { $valid = false; break; }
			$values[$property] = $normalized; $reported_sources[$property] = $source;
		}
		if (!$valid || count($values) !== count($reported)) continue;
		foreach ($values as $property => $value) if (isset($acl_values[$property])) $properties[$property] = $value;
		$properties['_sources'] = array_replace($properties['_sources'], $reported_sources);
	}
	$properties['_permissions']=zfsmReadDatasetPermissions($properties);
	zfsmEncryptionMetadata($properties);
	$metadata_io=zfsmUsageIO();
	$properties['_usage']=zfsmReadDatasetUsage($properties,$metadata_io);
	$properties['_acl']=zfsmReadDatasetACL($properties,$metadata_io);
	$properties['_dependencies']=zfsmReadDependencies($properties,$properties['_usage'],$metadata_io);
	if ((int)$ext === 1) {
		$map = array($zdataset => $properties);
		zfsmLoadUserProperties($zdataset, $map);
		$properties = $map[$zdataset];
	}
	return $properties;
}

function getDatasetSnapshotsResult($zpool, $zdataset) {
	if (!zfsmValidPoolName($zpool) || !zfsmValidDatasetName($zdataset) || explode('/', $zdataset, 2)[0] !== $zpool) return array('ok' => false, 'snapshots' => array(), 'error' => 'Invalid pool or dataset name');
	$columns = zfsmSnapshotColumns();
	$result = runProcess('zfs', array('list', '-H', '-p', '-d', '1', '-t', 'snapshot', '-o', implode(',', $columns), $zdataset));
	$clones_available = true;
	if (($result['code'] ?? 1) !== 0) {
		$clones_available = false; $columns = array_values(array_diff($columns, ['clones']));
		$result = runProcess('zfs', ['list', '-H', '-p', '-d', '1', '-t', 'snapshot', '-o', implode(',', $columns), $zdataset]);
	}
	if (($result['code'] ?? 1) !== 0) return array('ok' => false, 'snapshots' => array(), 'error' => trim($result['output'] ?? 'Unable to list snapshots'));
	try{$snapshots = zfsmParseTable($result['output'], $columns);}catch(Throwable $error){return ['ok'=>false,'snapshots'=>[],'error'=>$error->getMessage()];}
	foreach ($snapshots as $snapshot) if (explode('@', $snapshot['name'], 2)[0] !== $zdataset) return ['ok'=>false,'snapshots'=>[],'error'=>'Snapshot inventory is outside the requested dataset'];
	zfsmSnapshotMetadata($snapshots, $clones_available);
	usort($snapshots, function($a, $b) { return ($a['creation'] ?? 0) <=> ($b['creation'] ?? 0); });
	return array('ok' => true, 'snapshots' => $snapshots, 'error' => '');
}

function getDatasetSnapshots($zpool, $zdataset) {
	return getDatasetSnapshotsResult($zpool, $zdataset)['snapshots'];
}

function zfsmAllowedDatasetProperties() {
	return array('mountpoint', 'compression', 'quota', 'refquota', 'reservation', 'refreservation', 'recordsize', 'atime', 'xattr', 'primarycache', 'readonly', 'casesensitivity', 'sync');
}

function zfsmSafePropertyValue($property, $value) {
	if (!is_string($value) || strlen($value) > 1024 || preg_match('/[\x00-\x1F\x7F]/', $value)) return false;
	if ($property === 'mountpoint') return in_array($value, array('none', 'legacy'), true) || ($value !== '' && $value[0] === '/');
	return $value !== '';
}

function createDataset($zdataset, $zoptions) {
	if (!zfsmValidDatasetName($zdataset)) return zfsmFailure($zdataset, 'Invalid dataset name');
	$pool = explode('/', $zdataset, 2)[0];
	if (!is_array($zoptions)) return zfsmFailure($zdataset, 'Invalid dataset options');
	foreach ($zoptions as $value) if (!is_string($value)) return zfsmFailure($zdataset, 'Dataset option values must be strings');
	$passphrase = $zoptions['passphrase'] ?? '';
	if (strlen($passphrase) > 512 || strpbrk($passphrase, "\0\r\n") !== false) return zfsmFailure($zdataset, 'Passphrase contains unsupported control bytes or exceeds 512 bytes');
	unset($zoptions['passphrase']);
	$allowed = array('mountpoint', 'compression', 'quota', 'refquota', 'reservation', 'refreservation', 'recordsize', 'atime', 'xattr', 'primarycache', 'readonly', 'casesensitivity', 'sync', 'encryption', 'keylocation', 'keyformat');
	$args = array('create', '-p');
	foreach ($zoptions as $property => $value) {
		if (!in_array($property, $allowed, true) || !zfsmSafePropertyValue($property, (string)$value)) return zfsmFailure($zdataset, 'Invalid dataset property: '.$property);
		$args[] = '-o';
		$args[] = $property.'='.$value;
	}
	$encrypted = ($zoptions['encryption'] ?? 'off') === 'on';
	if ($encrypted && strlen($passphrase) < 8) return zfsmFailure($zdataset, 'Encryption passphrase must be at least 8 characters');
	$args[] = $zdataset;
	$result = runProcess('zfs', $args, $encrypted ? $passphrase."\n".$passphrase."\n" : null);
	$answer = commandAnswer($zdataset, $result);
	if (($result['code'] ?? 1) === 0) {
		$mountpoint = getDatasetProperty($pool, $zdataset, 'mountpoint');
		if (is_string($mountpoint) && $mountpoint !== '' && $mountpoint[0] === '/' && is_dir($mountpoint)) {
			@chown($mountpoint, 'nobody');
			@chgrp($mountpoint, 'users');
		}
	}
	return $answer;
}

function renameDataset($zdataset, $new_name, $force) {
	if (!zfsmDatasetExists($zdataset) || !zfsmValidDatasetName($new_name)) return zfsmFailure($new_name, 'Invalid source or destination dataset');
	$args = array('rename');
	if ((string)$force === '1') $args[] = '-f';
	$args[] = $zdataset;
	$args[] = $new_name;
	return commandAnswer($new_name, runProcess('zfs', $args));
}

function setDatasetProperty($zdataset, $property, $value) {
	if (!zfsmDatasetExists($zdataset) || !in_array($property, zfsmAllowedDatasetProperties(), true) || !zfsmSafePropertyValue($property, (string)$value)) return zfsmFailure($property, 'Invalid dataset, property, or value');
	$result = $value === 'inherit' ? runProcess('zfs', array('inherit', $property, $zdataset)) : runProcess('zfs', array('set', $property.'='.$value, $zdataset));
	return commandAnswer($property, $result);
}

function zfsmEncryptionMountedFamily($root) {
	$result = runProcess('zfs', ['list', '-H', '-r', '-t', 'filesystem', '-o', 'name,encryptionroot,mounted', $root]);
	if (($result['code'] ?? 1) !== 0) throw new RuntimeException('Unable to inspect encryption descendant inventory: '.($result['output'] ?? ''));
	$mounted = []; $found = false;
	foreach (zfsmParseTable($result['output'], ['name','encryptionroot','mounted']) as $row) {
		if (($row['name'] !== $root && !str_starts_with($row['name'], $root.'/')) || !in_array($row['mounted'], ['yes','no'], true)) throw new RuntimeException('Invalid encryption descendant inventory');
		if ($row['name'] === $root) {
			if ($row['encryptionroot'] !== $root) throw new RuntimeException('Encryption root changed during inventory');
			$found = true;
		}
		// Native ZFS unmount can also unmount an independently encrypted nested
		// filesystem. Refuse before touching mounts outside the reviewed family.
		if ($row['encryptionroot'] !== $root && $row['mounted'] === 'yes') throw new RuntimeException('Mounted nested encryption root must be locked or unmounted separately first: '.$row['name']);
		if ($row['encryptionroot'] === $root && $row['mounted'] === 'yes') $mounted[] = $row['name'];
	}
	if (!$found) throw new RuntimeException('Encryption root missing from descendant inventory');
	usort($mounted, static function($a, $b) { return substr_count($b, '/') <=> substr_count($a, '/') ?: strcmp($a, $b); });
	return $mounted;
}

function zfsmEncryptionMutation($args, $stdin = null) {
	try { return runProcess('zfs', $args, $stdin); }
	catch (Throwable $error) { return ['code'=>ZFSM_ERR_UNABLE_TO_CREATE_PROC, 'output'=>'Encryption process communication failed']; }
}

function zfsmRestoreEncryptionMounts($unmounted, $result, $identities=[]) {
	$failures = [];
	foreach (array_reverse($unmounted) as $name) {
		try {if(!isset($identities[$name]))throw new RuntimeException('Saved mount GUID is unavailable');zfsmRequireIdentity($name,$identities[$name]);}
		catch(Throwable $error){$failures[]=$name.': mount identity changed; inspect saved recovery state';continue;}
		$restore = zfsmEncryptionMutation(['mount', $name]);
		if (($restore['code'] ?? 1) !== 0) $failures[] = $name.': '.($restore['output'] ?? 'mount failed');
	}
	if ($unmounted) $result['output'] = ($result['output'] ?? '').($failures ? '; remount failed: '.implode('; ', $failures) : '; original mounts restored');
	$result['restore_failures']=$failures;
	return $result;
}

function lockDataset($zdataset) {
	if (!zfsmDatasetExists($zdataset, 'filesystem')) return zfsmFailure($zdataset, 'Dataset does not exist');
	$result = runProcess('zfs', array('get', '-H', '-o', 'property,value', 'encryption,encryptionroot,keystatus,mounted', $zdataset));
	if (($result['code'] ?? 1) !== 0) return commandAnswer($zdataset, $result);
	$state = array();
	foreach (explode("\n", $result['output']) as $line) { $p = explode("\t", $line, 2); if (count($p) === 2) $state[$p[0]] = $p[1]; }
	if (($state['encryption'] ?? 'off') === 'off' || ($state['encryptionroot'] ?? '') !== $zdataset || ($state['keystatus'] ?? '') !== 'available') return zfsmFailure($zdataset, 'Only an unlocked encryption root can be locked');
	try { $mounted = zfsmEncryptionMountedFamily($zdataset); }
	catch (Throwable $error) { return zfsmFailure($zdataset, 'Encryption descendant inventory is unavailable: '.$error->getMessage()); }
	try { $record=zfsmRememberEncryptionMounts($zdataset,$mounted); }
	catch (Throwable $error) { return zfsmFailure($zdataset,'Cannot persist previous mount identities; no unmount attempted: '.$error->getMessage()); }
	$unmounted = [];
	foreach ($mounted as $name) {
		$unmount = zfsmEncryptionMutation(['unmount', $name]);
		if (($unmount['code'] ?? 1) !== 0) return commandAnswer($zdataset, zfsmEncryptionRestoreFailure($record,$unmounted, $unmount));
		$unmounted[] = $name;
	}
	$unload = zfsmEncryptionMutation(['unload-key', $zdataset]);
	if (($unload['code'] ?? 1) !== 0) $unload = zfsmEncryptionRestoreFailure($record,$unmounted, $unload);
	else {$record['phase']='locked';try{zfsmSaveEncryptionState($record);}catch(Throwable $error){return zfsmFailure($zdataset,'Key unloaded; prepared mount journal retained, final journal update failed. Inspect before unlocking.');}}
	return commandAnswer($zdataset, $unload);
}

function unlockDataset($zdataset, $passphrase) {
	if (!zfsmDatasetExists($zdataset, 'filesystem') || !is_string($passphrase) || strlen($passphrase) > 512 || strpbrk($passphrase, "\0\r\n") !== false) return zfsmFailure($zdataset, 'Invalid dataset or unsupported passphrase');
	$result = runProcess('zfs', array('get', '-H', '-o', 'property,value', 'encryption,encryptionroot,keystatus', $zdataset));
	if (($result['code'] ?? 1) !== 0) return commandAnswer($zdataset, $result);
	$state = array();
	foreach (explode("\n", $result['output']) as $line) { $p = explode("\t", $line, 2); if (count($p) === 2) $state[$p[0]] = $p[1]; }
	if (($state['encryption'] ?? 'off') === 'off' || ($state['encryptionroot'] ?? '') !== $zdataset || !in_array($state['keystatus']??'',['available','unavailable'],true)) return zfsmFailure($zdataset, 'Only an encryption root can be unlocked');
	try {$identity=zfsmReadIdentity($zdataset);$record=zfsmReadEncryptionState($zdataset,$identity['guid']);}catch(Throwable $error){return zfsmFailure($zdataset,$error->getMessage());}
	if($state['keystatus']==='available'&&!$record)return zfsmFailure($zdataset,'Key is already loaded and no saved mount recovery is pending.');
	if($state['keystatus']==='unavailable'){
		if($passphrase==='')return zfsmFailure($zdataset,'Passphrase is required for a locked encryption root.');
		$load=zfsmEncryptionMutation(['load-key','-L','prompt',$zdataset],$passphrase."\n");if(($load['code']??1)!==0)return commandAnswer($zdataset,$load);
	}
	if(!$record)return ['succeeded'=>[$zdataset=>'Key loaded; previous mount state unavailable. Inspect and mount filesystems explicitly.'],'failed'=>[]];
	return zfsmRestoreSavedEncryptionMounts($record);
}

function promoteDataset($zdataset, $zforce = 0) {
	return zfsmFailure($zdataset, 'Load and confirm a fresh promote dependency preview.');
}

function destroyDataset($zdataset, $force, $scope = null) {
	if (!is_string($zdataset) || strpos($zdataset, '/') === false || strpos($zdataset, '@') !== false) return zfsmFailure($zdataset, 'Pool root destruction is not allowed');
	if (!zfsmDatasetExists($zdataset)) return zfsmFailure($zdataset, 'Dataset does not exist');
	if ($scope !== null) {
		$diagnostics = zfsmDestroyBusyDiagnostics($scope['objects']);
		if ($diagnostics['blocked']) return zfsmDestroyBlockedAnswer($scope, $diagnostics);
	}
	$args = array('destroy', '-v');
	if ((string)$force === '1') array_push($args, '-r', '-f');
	$args[] = $zdataset;
	return zfsmDestroyCommandResult($zdataset, runProcess('zfs', $args), $scope);
}

function zfsmFilesystemMounts() {
	$result = runProcess('zfs', array('list', '-H', '-o', 'name,mountpoint,mounted', '-t', 'filesystem'));
	$mounts = array();
	if (($result['code'] ?? 1) !== 0) return $mounts;
	foreach (preg_split('/\r\n|\r|\n/', trim($result['output'] ?? ''), -1, PREG_SPLIT_NO_EMPTY) ?: array() as $line) {
		$parts = explode("\t", $line);
		if (count($parts) !== 3 || $parts[1] === 'none' || $parts[1] === 'legacy' || $parts[1] === '/' || !is_dir($parts[1])) continue;
		$real = realpath($parts[1]);
		if ($real !== false && !zfsmPathHasSymlink($parts[1])) $mounts[$parts[0]] = array('mountpoint' => rtrim($real, '/'), 'mounted' => $parts[2]);
	}
	return $mounts;
}

function zfsmResolveDirectory($path, $must_exist = true) {
	return zfsmValidateDirectory($path, zfsmFilesystemMounts(), zfsmMountInfo(), $must_exist);
}

function moveDirectory($directory, $new_name) {
	$source = zfsmResolveDirectory($directory, true);
	$destination = zfsmResolveDirectory($new_name, false);
	if (!$source || !$destination || $source['dataset'] !== $destination['dataset'] || file_exists($destination['path'])) return zfsmFailure($new_name, 'Directory move is outside its dataset or destination exists');
	if ($source !== zfsmResolveDirectory($directory, true) || $destination !== zfsmResolveDirectory($new_name, false)) return zfsmFailure($directory, 'Directory state changed; refresh and retry');
    try {
        $request=zfsmDirectoryRequest('move',$source,['destination'=>substr($destination['path'],strlen($source['mountpoint'])+1)]);
        return zfsmDirectoryAnswer($destination['path'],zfsmDirectoryCommand($request));
    } catch (Throwable $error) { return zfsmFailure($directory,$error->getMessage()); }
}

function deleteDirectory($directory, $force) {
	$resolved = zfsmResolveDirectory($directory, true);
	if (!$resolved) return zfsmFailure($directory, 'Directory is outside a mounted ZFS filesystem');
	if ($resolved !== zfsmResolveDirectory($directory, true)) return zfsmFailure($directory, 'Directory state changed; refresh and retry');
    try {
        $request=zfsmDirectoryRequest('delete',$resolved,['recursive'=>(string)$force==='1']);
        return zfsmDirectoryAnswer($resolved['path'],zfsmDirectoryCommand($request));
    } catch (Throwable $error) { return zfsmFailure($directory,$error->getMessage()); }
}

function createDatasetSnapshot($zdataset, $snapshot_name, $recursive) {
	if (!zfsmDatasetExists($zdataset) || !zfsmValidSnapshotName($zdataset.'@'.$snapshot_name)) return zfsmFailure($zdataset, 'Invalid dataset or snapshot name');
	$args = array('snapshot');
	if ((string)$recursive === '1') $args[] = '-r';
	$full_name = $zdataset.'@'.$snapshot_name;
	$args[] = $full_name;
	return commandAnswer($full_name, runProcess('zfs', $args));
}

function rollbackDatasetSnapshot($snapshot, $destroy_newer = 0) {
	if (!zfsmSnapshotExists($snapshot)) return zfsmFailure($snapshot, 'Snapshot does not exist');
	$args = array('rollback');
	if ((string)$destroy_newer === '1') $args[] = '-r';
	$args[] = $snapshot;
	return commandAnswer($snapshot, runProcess('zfs', $args));
}

function renameDatasetSnapshot($zpool, $snapshot, $new_name) {
	if (!zfsmValidPoolName($zpool) || !zfsmSnapshotExists($snapshot) || !zfsmValidSnapshotName(explode('@', $snapshot, 2)[0].'@'.$new_name)) return zfsmFailure($snapshot, 'Invalid snapshot rename request');
	$destination = explode('@', $snapshot, 2)[0].'@'.$new_name;
	return commandAnswer($destination, runProcess('zfs', array('rename', $snapshot, $destination)));
}

function holdDatasetSnapshot($snapshot) {
	if (!zfsmSnapshotExists($snapshot)) return zfsmFailure($snapshot, 'Snapshot does not exist');
	return commandAnswer($snapshot, runProcess('zfs', array('hold', 'zfsmaster', $snapshot)));
}

function releaseDatasetSnapshot($snapshot) {
	if (!zfsmSnapshotExists($snapshot)) return zfsmFailure($snapshot, 'Snapshot does not exist');
	return commandAnswer($snapshot, runProcess('zfs', array('release', 'zfsmaster', $snapshot)));
}

function cloneDatasetSnapshot($snapshot, $clone) {
	if (!zfsmSnapshotExists($snapshot) || !zfsmValidDatasetName($clone)) return zfsmFailure($snapshot, 'Invalid snapshot or clone dataset name');
	return commandAnswer($clone, runProcess('zfs', array('clone', $snapshot, $clone)));
}

function deleteDatasetSnapshot($snapshot, $recursive = 0, $scope = null) {
	if (!zfsmSnapshotExists($snapshot)) return zfsmFailure($snapshot, 'Snapshot does not exist');
	if ($scope !== null) {
		$diagnostics = zfsmDestroyBusyDiagnostics($scope['objects']);
		if ($diagnostics['blocked']) return zfsmDestroyBlockedAnswer($scope, $diagnostics);
	}
	$args = array('destroy');
	if ((string)$recursive === '1') $args[] = '-r';
	$args[] = $snapshot;
	return zfsmDestroyCommandResult($snapshot, runProcess('zfs', $args), $scope);
}

?>
