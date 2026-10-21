<?php
require_once __DIR__.'/ZFSMNativeMaintenance.php';

// OpenZFS 2.2 documents status -p -t (per-vdev TRIM) and list -v -p. Verbose list uses the
// default eleven-column layout; -H discards vdev indentation and arbitrary
// -o layouts do not apply to its vdev rows. Keep both outputs as plain text.
// https://openzfs.github.io/openzfs-docs/man/v2.2/8/zpool-status.8.html
// https://openzfs.github.io/openzfs-docs/man/v2.2/8/zpool-list.8.html
function zfsmPoolInformationColumns() {
	return ['NAME','SIZE','ALLOC','FREE','CKPOINT','EXPANDSZ','FRAG','CAP','DEDUP','HEALTH','ALTROOT'];
}

// The native cron remains the sole owner. Reading this file does not install,
// reschedule or execute maintenance. A next-run time needs verified cron TZ.
function zfsmNativeMaintenance($pool,$file='/etc/cron.d/root',$overrides=[]) {
	$result=['owner'=>'Unknown','schedule'=>null,'next_run'=>null,'timezone'=>'Unknown','status'=>'unknown','settings_url'=>'/Main'];
	if(!zfsmValidPoolName($pool)||is_link($file)||!is_file($file))return $result;
	$content=@file_get_contents($file,false,null,0,262145);
	if(!is_string($content)||strlen($content)>262144)return $result;
	$matches=[];$pattern='~^\s*([^\s]+\s+[^\s]+\s+[^\s]+\s+[^\s]+\s+[^\s]+)\s+/usr/local/emhttp/plugins/dynamix/scripts/zfs_scrub\s+start\s+'.preg_quote($pool,'~').'(?:\s+(?:&>|>|2>)\s*[^\r\n]*)?\s*$~';
	foreach(preg_split('/\r\n|\r|\n/',$content)?:[] as $line)if(preg_match($pattern,$line,$match))$matches[]=preg_replace('/\s+/',' ',trim($match[1]));
	if(count($matches)===1){$result=array_replace($result,['owner'=>'Unraid','schedule'=>$matches[0],'status'=>'configured']);
        if(preg_match('/^\s*(?:TZ|CRON_TZ)\s*=/m',$content))return $result+['warning'=>'Cron timezone assignments require daemon-specific interpretation; next run is Unknown.'];
        $proof=isset($overrides['evidence'])?($overrides['evidence'])($file):zfsmNativeCronEvidence($file);if(($proof['status']??null)!=='verified')return $result+['warning'=>'Native cron daemon directory/timezone could not be verified; next run is Unknown.'];
        $result['timezone']=$proof['timezone'];$result['next_run']=zfsmNativeCronNext($matches[0],$proof['timezone'],$overrides['now']??time());if($result['next_run']!==null)$result['next_run_local']=(new DateTimeImmutable($result['next_run']))->setTimezone(new DateTimeZone($proof['timezone']))->format('Y-m-d H:i').' '.$proof['timezone'];$result['next_run_basis']='nominal native cron match; actual execution depends on daemon and system state';if($result['next_run']===null)$result['warning']='Unsupported or ambiguous native cron expression/timezone; next run is Unknown.';return $result;
    }
	if(count($matches)>1)return array_replace($result,['owner'=>'Unraid','status'=>'error','warning'=>'Multiple native scrub entries match this pool; inspect Unraid settings.']);
	return $result;
}

function zfsmPoolDiagnosticStates() {
	return ['ONLINE','DEGRADED','FAULTED','OFFLINE','UNAVAIL','REMOVED','SUSPENDED','AVAIL','AVAILABLE','INUSE'];
}

function zfsmPoolDiagnosticSection($name) {
	return $name === 'spare' ? 'spares' : $name;
}

function zfsmPoolDiagnosticCounter($value) {
	return is_string($value) && preg_match('/^[0-9]+(?:\.[0-9]+)?[KMGTPEZY]?$/iD', $value) === 1;
}

function zfsmPoolDiagnosticPositive($value) {
	return zfsmPoolDiagnosticCounter($value) && (float)$value > 0;
}

function zfsmPoolDiagnosticKnownNote($note) {
	$core = preg_replace('/\s*\((?:removing|non-allocating|resilvering|repairing|awaiting resilver|trimming|untrimmed|trim unsupported)\)/', '', $note);
	// OpenZFS status -t reports progress and ctime timestamps for TRIM.
	$core = trim(preg_replace('/\s*\((?:100|[0-9]{1,2})% trimmed, (?:suspended, started|started|completed) at (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}\)/', '', $core));
	return $core === '' || preg_match("/^(?:was .+|cannot open|missing device|insufficient replicas|newer version|unsupported feature\\(s\\)|unsupported minimum blocksize|too many (?:slow I\\/Os|errors)|experienced I\\/O failures|bad intent log|external device fault|split into new pool|all children offline|invalid label|corrupted data|currently in use|in use by pool '.+'|block size: [0-9]+B configured, [0-9]+B native)$/D", $core) === 1;
}

function zfsmParsePoolDiagnosticStatus($pool, $text) {
	$data = ['text'=>$text,'rows'=>[],'state'=>'','scan'=>'','errors'=>'','status'=>'','action'=>''];
	$issues = []; $seen = []; $field = ''; $in_config = false; $header = false; $base = null; $section = 'data'; $reported_pool = ''; $previous_depth = 0;
	foreach (preg_split('/\r\n|\r|\n/', $text) ?: [] as $raw) {
		$line = str_replace("\t", '        ', $raw);
		$trimmed = trim($line);
		if (preg_match('/^\s*(pool|state|status|action|scan|config|errors|see|remove|checkpoint|expand|rebuild|dedup):\s*(.*)$/', $line, $match)) {
			$field = $match[1];
			$seen[$field] = ($seen[$field] ?? 0) + 1;
			$in_config = $field === 'config';
			if ($field === 'pool') $reported_pool = trim($match[2]);
			if (array_key_exists($field, $data) && $field !== 'text' && $field !== 'rows') {
				$data[$field] = ($field === 'scan' && $data[$field] !== '' ? $data[$field]."\n" : '').trim($match[2]);
			}
			continue;
		}
		if ($trimmed === '') continue;
		if (!$in_config) {
			if (in_array($field, ['scan','errors','status','action'], true)) $data[$field] .= ($data[$field] === '' ? '' : "\n").$trimmed;
			elseif (!in_array($field,['see','remove','checkpoint','expand','rebuild','dedup'],true)) $issues[] = 'Pool status contains unrecognized output outside its device table';
			continue;
		}
		if ($trimmed === 'NAME' || preg_match('/^NAME\s+STATE\s+READ\s+WRITE\s+CKSUM$/D', $trimmed)) {
			if ($header || $trimmed === 'NAME') $issues[] = 'Pool status device header is malformed';
			$header = $trimmed !== 'NAME';
			continue;
		}
		if (in_array($trimmed, ['logs','cache','spares','special','dedup'], true)) {
			$section = $trimmed;
			$previous_depth = 0;
			continue;
		}
		if (!$header || !preg_match('/^(\s*)(\S+)\s+([A-Z_]+)(?:\s+(.*))?$/D', $line, $match)) {
			$issues[] = 'Pool status contains an unrecognized device row';
			continue;
		}
		$name = $match[2]; $state = $match[3]; $indent = strlen($match[1]);
		$parts = preg_split('/\s+/', trim($match[4] ?? ''), -1, PREG_SPLIT_NO_EMPTY) ?: [];
		$counters = [null,null,null]; $note = '';
		$annotation = implode(' ', $parts);
		$in_use_note = $state === 'INUSE' && preg_match("/^(?:currently in use|in use by pool '.+')$/D", $annotation);
		$fault_note = !in_array($state,['ONLINE','AVAIL','AVAILABLE','INUSE'],true) && zfsmPoolDiagnosticKnownNote($annotation);
		if (count($parts) >= 3 && zfsmPoolDiagnosticCounter($parts[0]) && zfsmPoolDiagnosticCounter($parts[1]) && zfsmPoolDiagnosticCounter($parts[2])) {
			$counters = array_slice($parts, 0, 3); $note = implode(' ', array_slice($parts, 3));
		} elseif ($section === 'spares' && (count($parts) === 0 || $in_use_note || $fault_note)) {
			// Hot-spare rows omit counters; INUSE can have a textual annotation.
			$note = $annotation;
		} else $issues[] = 'Pool status has missing or invalid error counters for '.$name;
		if (!zfsmPoolDiagnosticKnownNote($note)) $issues[] = 'Pool status has an unrecognized device annotation for '.$name;
		if (!in_array($state, zfsmPoolDiagnosticStates(), true)) $issues[] = 'Pool status has an unknown device state for '.$name;
		if ($base === null) {
			$base = $indent;
			if ($name !== $pool || $section !== 'data') $issues[] = 'Pool status root does not match the requested pool';
		} elseif ($indent <= $base) $issues[] = 'Pool status device hierarchy is incomplete';
		if ($indent < $base || ($indent - $base) % 2 !== 0) $issues[] = 'Pool status device indentation is malformed';
		$depth = max(0,(int)(($indent-$base)/2));
		if ($depth > $previous_depth + 1) $issues[] = 'Pool status device hierarchy skips a parent';
		$previous_depth = $depth;
		$data['rows'][] = ['name'=>$name,'state'=>$state,'read'=>$counters[0],'write'=>$counters[1],'cksum'=>$counters[2],'depth'=>$depth,'section'=>$section,'note'=>$note];
	}
	foreach (['pool','state','config','errors'] as $required) if (($seen[$required] ?? 0) !== 1) $issues[] = 'Pool status is missing or duplicates its '.$required.' section';
	if ($reported_pool !== $pool) $issues[] = 'Pool status identifies a different pool';
	if (!in_array($data['state'], zfsmPoolDiagnosticStates(), true)) $issues[] = 'Pool status native state is missing or unrecognized';
	if (!$header || !$data['rows']) $issues[] = 'Pool status device table is missing';
	if ($data['rows'] && $data['rows'][0]['state'] !== $data['state']) $issues[] = 'Pool status native state and root device disagree';
	if ($data['state'] === 'ONLINE' && count($data['rows']) < 2) $issues[] = 'Pool status has no devices';
	return ['data'=>$data,'issues'=>array_values(array_unique($issues))];
}

function zfsmParsePoolDiagnosticInformation($pool, $text) {
	$columns = zfsmPoolInformationColumns();
	$data = ['text'=>$text,'columns'=>$columns,'rows'=>[]];
	$issues = []; $header = false; $section = 'data'; $base = null; $previous_depth = 0;
	foreach (preg_split('/\r\n|\r|\n/', $text) ?: [] as $raw) {
		$line = str_replace("\t", '        ', $raw); $trimmed = trim($line);
		if ($trimmed === '') continue;
		if (!$header) {
			if ((preg_split('/\s+/', $trimmed) ?: []) !== $columns) {
				$issues[] = 'Pool information header is missing or unrecognized';
				break;
			}
			$header = true;
			continue;
		}
		preg_match('/^\s*/', $line, $indent_match); $indent = strlen($indent_match[0]);
		$parts = preg_split('/\s+/', $trimmed, 11) ?: [];
		$is_group = in_array($parts[0] ?? '', ['logs','cache','spare','spares','special','dedup'], true) && count(array_unique(array_slice($parts,1))) === 1 && ($parts[1] ?? '') === '-';
		if ($base === null) {
			$base = $indent;
			if (($parts[0] ?? '') !== $pool || count($parts) !== 11) $issues[] = 'Pool information root is missing or malformed';
		} elseif ($is_group) $section = zfsmPoolDiagnosticSection($parts[0]);
		elseif ($indent <= $base) $issues[] = 'Pool information device hierarchy is incomplete';
		// OpenZFS verbose vdev rows end at HEALTH; ALTROOT applies only to pools.
		if (count($parts) === 10 && count($data['rows']) > 0) $parts[] = '-';
		if (count($parts) !== 11) {
			$issues[] = 'Pool information contains an incomplete row';
			continue;
		}
		if ($indent < $base || ($indent-$base) % 2 !== 0) $issues[] = 'Pool information device indentation is malformed';
		$row = array_combine(array_map('strtolower', $columns), $parts);
		$row['depth'] = max(0,(int)(($indent-$base)/2)); $row['section'] = $section;
		if ($row['depth'] > $previous_depth + 1) $issues[] = 'Pool information device hierarchy skips a parent';
		$previous_depth = $row['depth'];
		if (!$is_group) {
			foreach (['size','alloc','free','ckpoint','expandsz','frag','cap'] as $key) if ($row[$key] !== '-' && preg_match('/^[0-9]+(?:\.[0-9]+)?[KMGTPEZY%]?$/iD', $row[$key]) !== 1) $issues[] = 'Pool information has an invalid '.$key.' value';
			if ($row['dedup'] !== '-' && preg_match('/^[0-9]+(?:\.[0-9]+)?x?$/D', $row['dedup']) !== 1) $issues[] = 'Pool information has an invalid deduplication ratio';
			if (!in_array($row['health'], zfsmPoolDiagnosticStates(), true)) $issues[] = 'Pool information has an unknown device health';
		}
		$data['rows'][] = $row;
	}
	if (!$header || !$data['rows']) $issues[] = 'Pool information device table is missing';
	return ['data'=>$data,'issues'=>array_values(array_unique($issues))];
}

function zfsmPoolDiagnosticDeviceMap($rows, $state_column) {
	$map = [];
	foreach ($rows as $row) {
		if (($row[$state_column] ?? '-') === '-') continue; // Information section labels.
		$key = json_encode([$row['section'],$row['name'],$row['depth']]);
		$map[$key] = ($map[$key] ?? 0) + 1;
	}
	ksort($map);
	return $map;
}

function zfsmReadPoolDiagnostics($pool) {
	if (!zfsmValidPoolName($pool)) throw new InvalidArgumentException('Invalid pool name');
	$commands = ['status'=>['status','-p','-t',$pool], 'list'=>['list','-v','-p',$pool]];
	$results = []; $command_errors = [];
	$trim = ['available'=>false,'reason'=>'Native TRIM status could not be read'];
	$had_deadline = array_key_exists('zfsm_inventory_deadline', $GLOBALS);
	$previous_deadline = $GLOBALS['zfsm_inventory_deadline'] ?? null;
	$GLOBALS['zfsm_inventory_deadline'] = $previous_deadline === null ? microtime(true)+15 : min($previous_deadline,microtime(true)+15);
	try {
		foreach ($commands as $name=>$args) {
			try {
				$result = runProcess('zpool', $args);
				$trim_requested = $name === 'status';
				// OpenZFS emits this exact option error before reading any pool.
				// Never retry a timeout, I/O failure, or partially returned inventory.
				if ($trim_requested && in_array($result['code'] ?? null, [1,2], true) && preg_match("/\\Ainvalid option 't'(?:\\r?\\nusage:.*)?\\z/s", trim($result['output'] ?? '')) === 1) {
					$trim_requested = false; $trim['reason'] = 'zpool status -t is unsupported';
					$result = runProcess('zpool', ['status','-p',$pool]);
				}
				if ($trim_requested && ($result['code'] ?? 1) === 0) $trim = ['available'=>true,'reason'=>''];
				$results[$name] = (string)($result['output'] ?? '');
				if (($result['code'] ?? 1) !== 0) $command_errors[] = ['command'=>$name,'code'=>$result['code'] ?? null,'message'=>$results[$name] !== '' ? $results[$name] : 'zpool '.$name.' failed'];
			} catch (Throwable $error) {
				$results[$name] = '';
				$command_errors[] = ['command'=>$name,'code'=>null,'message'=>$error->getMessage()];
			}
		}
	} finally {
		if ($had_deadline) $GLOBALS['zfsm_inventory_deadline'] = $previous_deadline;
		else unset($GLOBALS['zfsm_inventory_deadline']);
	}
	$status = zfsmParsePoolDiagnosticStatus($pool, $results['status']);
	$information = zfsmParsePoolDiagnosticInformation($pool, $results['list']);
	$issues = array_merge($status['issues'], $information['issues']);
	$native = $status['data']['state'];
	if (!in_array($native,zfsmPoolDiagnosticStates(),true)) $native = $information['data']['rows'][0]['health'] ?? 'UNKNOWN';
	if (!in_array($native,zfsmPoolDiagnosticStates(),true)) $native = 'UNKNOWN';
	if (!$issues && zfsmPoolDiagnosticDeviceMap($status['data']['rows'],'state') !== zfsmPoolDiagnosticDeviceMap($information['data']['rows'],'health')) $issues[] = 'Pool status and information device inventories disagree; refresh to collect a consistent result';
	if (($information['data']['rows'][0]['health'] ?? $native) !== $native) $issues[] = 'Pool status and information native health disagree; refresh to collect a consistent result';
	$reasons = []; $severity = 'ok';
	$add_reason = function($level, $message) use (&$severity,&$reasons) {
		if ($level === 'error' || $severity === 'ok') $severity = $level;
		$reasons[] = $message;
	};
	if ($native !== 'ONLINE' && $native !== 'UNKNOWN') $add_reason('error', 'Pool native state is '.$native);
	foreach ($status['data']['rows'] as $row) {
		foreach (['read'=>'READ','write'=>'WRITE','cksum'=>'CKSUM'] as $key=>$label) if (zfsmPoolDiagnosticPositive($row[$key])) $add_reason('error', $row['name'].' has '.$label.' errors: '.$row[$key]);
		$is_spare = $row['section'] === 'spares';
		$healthy_states = $is_spare ? ['ONLINE','AVAIL','AVAILABLE','INUSE'] : ['ONLINE'];
		if (!in_array($row['state'],$healthy_states,true)) $add_reason($is_spare ? 'warning' : 'error', ($is_spare ? 'Spare ' : 'Device ').$row['name'].' is '.$row['state']);
		if (str_contains($row['note'],'block size:')) $add_reason('warning', 'Device '.$row['name'].': '.$row['note']);
	}
	foreach ($information['data']['rows'] as $row) {
		if ($row['health'] === '-') continue;
		$is_spare = $row['section'] === 'spares';
		if (!in_array($row['health'],$is_spare ? ['ONLINE','AVAIL','AVAILABLE','INUSE'] : ['ONLINE'],true)) $add_reason($is_spare ? 'warning' : 'error', ($is_spare ? 'Spare ' : 'Device ').$row['name'].' is '.$row['health']);
	}
	$errors = $status['data']['errors'];
	if ($errors !== 'No known data errors') {
		if (preg_match('/Permanent errors|\b[1-9][0-9]*\s+(?:data\s+)?errors?\b/i', $errors)) $add_reason('error', $errors);
		else $issues[] = 'Pool data-error summary is missing or unrecognized';
	}
	if (preg_match('/\b[1-9][0-9]*\s+errors?\b/i', $status['data']['scan'])) $add_reason('error', 'Scan reports errors: '.$status['data']['scan']);
	foreach (['status','action'] as $field) {
		$notice = $status['data'][$field];
		if ($notice !== '' && !preg_match('/^(?:The pool is healthy\.?|No action (?:is )?required\.?)$/iD', $notice)) $add_reason('warning', ucfirst($field).': '.$notice);
	}
	if ($command_errors || $issues || $native === 'UNKNOWN') {
		$severity = 'unknown';
		foreach ($command_errors as $error) $reasons[] = 'zpool '.$error['command'].' failed: '.$error['message'];
		$reasons = array_merge($reasons,$issues);
		if ($native === 'UNKNOWN') $reasons[] = 'Native pool health could not be determined';
	}
	return ['pool'=>$pool,'collected_at'=>gmdate('c'),'health'=>$native,'severity'=>$severity,'reasons'=>array_values(array_unique($reasons)),'status'=>$status['data'],'information'=>$information['data'],'scan'=>zfsmParsePoolScan($status['data']['scan']),'trim'=>$trim,'maintenance'=>zfsmNativeMaintenance($pool),'command_errors'=>$command_errors];
}
