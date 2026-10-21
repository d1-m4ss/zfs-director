<?php
/** Durable, redacted administrative history. Do not pass raw request or CLI output. */

function zfsmAuditBegin($command, $fields = []): string {
    $command = zfsmAuditCommand($command);
    $id = bin2hex(random_bytes(16));
    zfsmAuditAppend([
        'version' => 1, 'operation_id' => $id, 'timestamp' => gmdate('Y-m-d\TH:i:s\Z'),
        'command' => $command, 'phase' => 'begin', 'status' => 'started',
        'fields' => zfsmAuditFields($fields),
    ]);
    $GLOBALS['zfsm_audit_current_id']=$id;
    $GLOBALS['zfsm_audit_operations'][$id] = ['command' => $command, 'directory' => zfsmAuditPath(),'failure_details'=>['stage'=>'preflight']];
    return $id;
}

function zfsmAuditFinish($id, $outcome): void {
    if (!is_string($id) || !preg_match('/^[a-f0-9]{32}$/D', $id) || !is_array($outcome)) {
        throw new \InvalidArgumentException('Invalid audit outcome');
    }
    $status = $outcome['status'] ?? null;
    if (!is_string($status) || !in_array($status, ['succeeded', 'failed', 'cancelled', 'recovery_required'], true)) {
        throw new \InvalidArgumentException('Invalid audit status');
    }
    $operation = $GLOBALS['zfsm_audit_operations'][$id] ?? null;
    if (!is_array($operation) || $operation['directory'] !== zfsmAuditPath()) {
        $operation = null;
        foreach (zfsmAuditList(500) as $entry) {
            if ($entry['operation_id'] === $id && $entry['phase'] === 'begin') {
                $operation = ['command' => $entry['command']];
                break;
            }
        }
    }
    if ($operation === null) throw new \RuntimeException('Audit operation start unavailable');
    $entry = [
        'version' => 1, 'operation_id' => $id, 'timestamp' => gmdate('Y-m-d\TH:i:s\Z'),
        'command' => $operation['command'], 'phase' => 'outcome', 'status' => $status,
        'fields' => [],
    ];
    foreach (['succeeded', 'failed'] as $key) {
        if (isset($outcome[$key])) $entry[$key] = zfsmAuditTargets($outcome[$key]);
    }
    $reason = zfsmAuditReason($outcome['reason'] ?? null);
    if ($reason !== null) $entry['reason'] = $reason;
    if($status!=='succeeded')$entry['details']=zfsmAuditFailureDetails(array_replace($operation['failure_details']??[],is_array($outcome['details']??null)?$outcome['details']:[]),$operation['command']);
    zfsmAuditAppend($entry);
    unset($GLOBALS['zfsm_audit_operations'][$id]);
    if(($GLOBALS['zfsm_audit_current_id']??null)===$id)unset($GLOBALS['zfsm_audit_current_id']);
}

function zfsmAuditEvent($command, $fields, $status): string {
    $command = zfsmAuditCommand($command);
    if (!is_string($status) || !in_array($status, zfsmAuditStatuses(), true)) {
        throw new \InvalidArgumentException('Invalid audit status');
    }
    $id = bin2hex(random_bytes(16));
    zfsmAuditAppend([
        'version' => 1, 'operation_id' => $id, 'timestamp' => gmdate('Y-m-d\TH:i:s\Z'),
        'command' => $command, 'phase' => 'event', 'status' => $status,
        'fields' => zfsmAuditFields($fields),
    ]);
    return $id;
}

/** Newest first; reads at most 2 MiB, 4096 lines, 32 daily files and 500 results. */
function zfsmAuditList($limit = 100): array {
    $limit = max(0, min(500, is_int($limit) ? $limit : (is_numeric($limit) ? (int)$limit : 100)));
    if ($limit === 0) return [];
    $directory = zfsmAuditStorage(false);
    if ($directory === null) return [];
    $lock = zfsmAuditLock($directory, LOCK_SH);
    try {
        $names = [];
        $scan = @opendir($directory);
        if ($scan === false) throw new \RuntimeException('Audit storage unavailable');
        try {
            $seen = 0;
            while (($name = readdir($scan)) !== false && $seen++ < 4096) {
                if (preg_match('/^(\d{4})-(\d{2})-(\d{2})\.jsonl$/D', $name, $date) && checkdate((int)$date[2], (int)$date[3], (int)$date[1])) $names[] = $name;
            }
        } finally { closedir($scan); }
        rsort($names, SORT_STRING);
        $result = []; $bytesLeft = 2 * 1024 * 1024; $linesLeft = 4096;
        foreach (array_slice($names, 0, 32) as $name) {
            $path = $directory.'/'.$name;
            $handle = zfsmAuditOpen($path, false);
            try {
                $stat = fstat($handle);
                if ($stat === false) throw new \RuntimeException('Audit storage unavailable');
                $size = $stat['size']; $readBytes = min($size, $bytesLeft);
                if ($readBytes <= 0) continue;
                $offset = $size - $readBytes;
                if (fseek($handle, $offset, SEEK_SET) !== 0) throw new \RuntimeException('Audit storage unavailable');
                $tail = stream_get_contents($handle, $readBytes);
                if ($tail === false || strlen($tail) !== $readBytes) throw new \RuntimeException('Audit storage unavailable');
                $bytesLeft -= $readBytes;
                // Both edges may be crash-truncated. Only newline-terminated records count.
                $lines = explode("\n", $tail);
                array_pop($lines);
                if ($offset > 0) array_shift($lines);
                for ($i = count($lines) - 1; $i >= 0 && $linesLeft > 0; $i--, $linesLeft--) {
                    if (strlen($lines[$i]) > 65536) continue;
                    $entry = json_decode($lines[$i], true, 8);
                    $entry = zfsmAuditReadEntry($entry);
                    if ($entry !== null) $result[] = $entry;
                    if (count($result) >= $limit) return $result;
                }
            } finally { fclose($handle); }
            if ($bytesLeft <= 0 || $linesLeft <= 0) break;
        }
        return $result;
    } finally { flock($lock, LOCK_UN); fclose($lock); }
}

/** Opaque read-only continuation; filenames never come from an arbitrary path. */
function zfsmAuditCursor($name, $offset, $stat): string {
    return rtrim(strtr(base64_encode(json_encode(['v'=>1,'name'=>$name,'offset'=>(string)$offset,'dev'=>(string)$stat['dev'],'ino'=>(string)$stat['ino']], JSON_THROW_ON_ERROR)), '+/', '-_'), '=');
}

/** Each request scans at most 2 MiB, 4096 lines, 32 files and 4096 directory entries. */
function zfsmAuditPage($limit = 500, $cursor = ''): array {
    if ((!is_int($limit) && !is_string($limit)) || preg_match('/^[1-9][0-9]{0,2}$/D', (string)$limit) !== 1 || (int)$limit > 500) throw new \InvalidArgumentException('Invalid audit page size');
    if (!is_string($cursor) || strlen($cursor) > 512) throw new \InvalidArgumentException('Invalid audit cursor');
    $continuation = null;
    if ($cursor !== '') {
        if (preg_match('/^[A-Za-z0-9_-]+$/D', $cursor) !== 1) throw new \InvalidArgumentException('Invalid audit cursor');
        $decoded = base64_decode(strtr($cursor, '-_', '+/'), true);
        $continuation = $decoded === false ? null : json_decode($decoded, true, 4);
        if (!is_array($continuation) || count($continuation) !== 5 || ($continuation['v'] ?? null) !== 1 || !is_string($continuation['name'] ?? null)
            || !preg_match('/^(\d{4})-(\d{2})-(\d{2})\.jsonl$/D', $continuation['name'], $date) || !checkdate((int)$date[2], (int)$date[3], (int)$date[1])) throw new \InvalidArgumentException('Invalid audit cursor');
        foreach (['offset','dev','ino'] as $key) if (!is_string($continuation[$key] ?? null) || preg_match('/^(0|[1-9][0-9]{0,18})$/D', $continuation[$key]) !== 1 || (float)$continuation[$key] > PHP_INT_MAX) throw new \InvalidArgumentException('Invalid audit cursor');
        if (zfsmAuditCursor($continuation['name'], $continuation['offset'], $continuation) !== $cursor) throw new \InvalidArgumentException('Invalid audit cursor');
    }
    $entries = []; $stats = ['bytes_read'=>0,'lines_scanned'=>0,'files_read'=>0,'directory_entries_scanned'=>0]; $directory_limited = false;
    $answer = static function($next = null, $limited = false) use (&$entries, &$stats, &$directory_limited): array {
        return ['entries'=>$entries,'next_cursor'=>$next,'has_more'=>$next !== null,'scan_limited'=>$limited || $directory_limited] + $stats;
    };
    $directory = zfsmAuditStorage(false);
    if ($directory === null) {
        if ($continuation !== null) throw new \RuntimeException('Audit cursor expired; refresh history');
        return $answer();
    }
    $lock = zfsmAuditLock($directory, LOCK_SH);
    try {
        $names = []; $scan = @opendir($directory);
        if ($scan === false) throw new \RuntimeException('Audit storage unavailable');
        try {
            while ($stats['directory_entries_scanned'] < 4096 && ($name = readdir($scan)) !== false) {
                $stats['directory_entries_scanned']++;
                if (preg_match('/^(\d{4})-(\d{2})-(\d{2})\.jsonl$/D', $name, $date) && checkdate((int)$date[2], (int)$date[3], (int)$date[1])) $names[] = $name;
            }
            $directory_limited = $stats['directory_entries_scanned'] === 4096;
        } finally { closedir($scan); }
        rsort($names, SORT_STRING);
        if ($continuation !== null) {
            if (!in_array($continuation['name'], $names, true)) throw new \RuntimeException('Audit cursor expired; refresh history');
            $names = array_values(array_filter($names, fn($name) => strcmp($name, $continuation['name']) <= 0));
        }
        foreach ($names as $index => $name) {
            $handle = zfsmAuditOpen($directory.'/'.$name, false);
            try {
                $stat = fstat($handle);
                if ($stat === false) throw new \RuntimeException('Audit storage unavailable');
                $stats['files_read']++;
                $end = $stat['size'];
                if ($continuation !== null && $name === $continuation['name']) {
                    if ((string)$stat['dev'] !== $continuation['dev'] || (string)$stat['ino'] !== $continuation['ino'] || (int)$continuation['offset'] > $end) throw new \RuntimeException('Audit cursor expired; refresh history');
                    $end = (int)$continuation['offset'];
                }
                $position = 0;
                if ($end > 0) {
                    $readBytes = min($end, 2 * 1024 * 1024 - $stats['bytes_read']); $offset = $end - $readBytes;
                    if (fseek($handle, $offset, SEEK_SET) !== 0) throw new \RuntimeException('Audit storage unavailable');
                    $tail = stream_get_contents($handle, $readBytes);
                    if ($tail === false || strlen($tail) !== $readBytes) throw new \RuntimeException('Audit storage unavailable');
                    $stats['bytes_read'] += $readBytes;
                    $lines = explode("\n", $tail); $unfinished = array_pop($lines); $position = $end - strlen($unfinished);
                    // Keep the leading partial record for the next page. If an
                    // oversized record fills the whole window, advance through
                    // it without ever parsing a non-newline-terminated fragment.
                    $leadingBytes = 0;
                    if ($offset > 0 && $lines !== []) $leadingBytes = strlen(array_shift($lines)) + 1;
                    for ($line = count($lines) - 1; $line >= 0; $line--) {
                        $position -= strlen($lines[$line]) + 1; $stats['lines_scanned']++;
                        if (strlen($lines[$line]) <= 65536) {
                            $entry = zfsmAuditReadEntry(json_decode($lines[$line], true, 8));
                            if ($entry !== null) $entries[] = $entry;
                        }
                        if (count($entries) >= (int)$limit || $stats['lines_scanned'] >= 4096) {
                            $next = $position > 0 || $index < count($names) - 1 ? zfsmAuditCursor($name, $position, $stat) : null;
                            return $answer($next, $stats['lines_scanned'] >= 4096);
                        }
                    }
                    if ($leadingBytes > 65536) $position = $offset;
                }
                if ($position > 0 || $stats['files_read'] >= 32 || $stats['bytes_read'] >= 2 * 1024 * 1024) {
                    $next = $position > 0 || $index < count($names) - 1 ? zfsmAuditCursor($name, $position, $stat) : null;
                    return $answer($next, true);
                }
            } finally { fclose($handle); }
        }
        return $answer();
    } finally { flock($lock, LOCK_UN); fclose($lock); }
}

function zfsmAuditCommand($command): string {
    if (!is_string($command) || !preg_match('/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/D', $command)) throw new \InvalidArgumentException('Invalid audit command');
    return $command;
}

function zfsmAuditStatuses(): array {
    return ['started', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'recovery_required', 'completed'];
}

function zfsmAuditReason($reason): ?string {
    return is_string($reason) && in_array($reason, [
        'invalid_request', 'validation_failed', 'command_failed', 'storage_unavailable',
        'conflict', 'cancelled', 'recovery_required', 'internal_error', 'not_authorized',
        'worker_interrupted', 'audit_unavailable',
    ], true) ? $reason : null;
}

/** Keep only a coarse allowlisted category, never CLI/request/secret text. */
function zfsmAuditFailureReason($failed): ?string {
    if (!is_array($failed) || $failed === []) return null;
    $text = '';
    foreach (array_slice($failed, 0, 32) as $message) if (is_string($message)) $text .= substr($message, 0, 4096)."\n";
    foreach ([
        'not_authorized'=>'/permission denied|access denied|not authorized|unauthori[sz]ed|operation not permitted/i',
        'storage_unavailable'=>'/no space left|disk full|read-only file system|(?:audit|job|config|storage).{0,80}unavailable|unable to (?:persist|save|write|flush)/i',
        'conflict'=>'/already exists|\bbusy\b|conflict|identity changed|state changed|replaced|changed since/i',
        'validation_failed'=>'/\binvalid\b|\bunsupported\b|\bmalformed\b|\brequired\b|\bconfirm\b|must be|must not|not allowed|destructive mode is disabled/i',
    ] as $reason=>$pattern) if (preg_match($pattern, $text)) return $reason;
    return 'command_failed';
}

function zfsmAuditFailureDetails($input,$operation): array {
    $stages=['validating','compressing','completed','cancelled_before_copy','preflight','executing_operation','acquiring_lock','validating_identity','reviewing_scope','queued','planned','moving','source_moved','creating','dataset_created','preparing','target_created','copying','copy_verified','claiming','source_retained','reserving','reserved','mountpoint_pending','publishing','published','complete_source_retained','inspecting','transferring','verifying','restoring_mounts','cleanup','native_list','native_get','native_set','native_inherit','native_create','native_destroy','native_rename','native_snapshot','native_clone','native_promote','native_mount','native_unmount','native_load-key','native_unload-key','native_hold','native_release','native_rollback','native_scrub','native_sanoid','native_syncoid','native_ssh','native_perl','native_rsync','unknown'];
    $errors=['not_authorized','insufficient_space','busy','identity_changed','missing_object','timeout','unsupported','invalid_request','native_failure','transport_failed','lock_busy','lock_open_failed','lock_unavailable','unknown'];
    $safe=['operation'=>zfsmAuditCommand($operation),'stage'=>in_array($input['stage']??null,$stages,true)?$input['stage']:'unknown','tool'=>in_array($input['tool']??null,['zfs','zpool','perl','ssh','sanoid','syncoid','php','rsync'],true)?$input['tool']:null,'exit_code'=>is_int($input['exit_code']??null)&&$input['exit_code']>=0&&$input['exit_code']<=255?$input['exit_code']:null,'error_code'=>in_array($input['error_code']??null,$errors,true)?$input['error_code']:'unknown'];
    $owner=is_array($input['lock_owner']??null)?$input['lock_owner']:[];
    if($safe['stage']==='acquiring_lock'&&$safe['error_code']==='lock_busy'&&is_int($owner['pid']??null)&&$owner['pid']>0&&$owner['pid']<=2147483647){
        $comm=$owner['comm']??null;
        $safe['lock_owner']=['pid'=>$owner['pid'],'comm'=>is_string($comm)&&preg_match('/^[A-Za-z0-9_.+-]{1,15}$/D',$comm)?$comm:null];
    }
    return $safe;
}
function zfsmAuditSetStage($stage): void {
    $id=$GLOBALS['zfsm_audit_current_id']??null;if($id&&isset($GLOBALS['zfsm_audit_operations'][$id]))$GLOBALS['zfsm_audit_operations'][$id]['failure_details']['stage']=$stage;
    if(function_exists('zfsmRequestJobStage'))zfsmRequestJobStage($stage);
}
function zfsmAuditRecordFailure($binary,$args,$result): void {
    $id=$GLOBALS['zfsm_audit_current_id']??null;if(!$id||!isset($GLOBALS['zfsm_audit_operations'][$id])||($result['code']??1)===0)return;
    $old=$GLOBALS['zfsm_audit_operations'][$id]['failure_details']??[];$text=substr((string)($result['output']??''),0,8192);$error='native_failure';
    foreach(['not_authorized'=>'/permission denied|access denied|operation not permitted/i','insufficient_space'=>'/no space left|out of space|quota exceeded|disk full/i','identity_changed'=>'/identity changed|GUID changed|replaced/i','busy'=>'/busy|already exists|another operation/i','missing_object'=>'/does not exist|no such file/i','timeout'=>'/timed out|timeout/i','unsupported'=>'/unsupported|not supported/i']as$code=>$pattern)if(preg_match($pattern,$text)){$error=$code;break;}
    $tool=is_string($binary)?basename($binary):null;$op=$args[0]??$tool;$stage='native_'.(in_array($tool,['sanoid','syncoid','ssh','perl','rsync'],true)?$tool:(string)$op);
    $GLOBALS['zfsm_audit_operations'][$id]['failure_details']=array_replace($old,['exit_code'=>$result['code']??null,'error_code'=>$error],$binary!==null?['stage'=>$stage,'tool'=>$tool]:[])+['stage'=>'executing_operation'];
}
function zfsmAuditFields($fields): array {
    if (!is_array($fields)) return [];
    $safe = []; $budget = 8192;
    foreach (['zdataset', 'snapshot', 'directory', 'newname', 'pool', 'property', 'job_id', 'stage'] as $key) {
        if (!array_key_exists($key, $fields)) continue;
        $values = is_array($fields[$key]) ? array_slice($fields[$key], 0, 32) : [$fields[$key]];
        $kept = [];
        foreach ($values as $value) {
            if (!is_string($value) || $value === '' || preg_match('/[\x00-\x1f\x7f]/', $value) || preg_match('//u', $value) !== 1) continue;
            // ZFS component names may contain spaces; command output still has no input field.
            if (in_array($key, ['zdataset', 'snapshot'], true) && !zfsmAuditSafeTarget($value)) continue;
            if ($key === 'newname' && !preg_match('/^[A-Za-z0-9_.\/:@# -]+$/D', $value)) continue;
            if (!in_array($key, ['directory', 'zdataset', 'snapshot', 'newname'], true) && !preg_match('/^[A-Za-z0-9_.\/:@#+%-]+$/D', $value)) continue;
            $value = substr($value, 0, min(1024, $budget));
            while ($value !== '' && preg_match('//u', $value) !== 1) $value = substr($value, 0, -1);
            if ($value === '') continue;
            $kept[] = $value; $budget -= strlen($value);
            if ($budget <= 0) break;
        }
        if ($kept !== []) $safe[$key] = is_array($fields[$key]) ? $kept : $kept[0];
        if ($budget <= 0) break;
    }
    return $safe;
}

function zfsmAuditTargets($targets): array {
    if (!is_array($targets)) $targets = [$targets];
    $safe = [];
    foreach (array_slice($targets, 0, 32) as $target) {
        if (zfsmAuditSafeTarget($target)) $safe[] = $target;
    }
    return $safe;
}

function zfsmAuditSafeTarget($target): bool {
    if (!is_string($target) || $target === '' || strlen($target) > 1024 || !preg_match('/^[A-Za-z0-9_.\/:@# -]+$/D', $target)) return false;
    // Absolute paths are explicit targets; pool roots cannot contain spaces.
    if ($target[0] === '/') return true;
    $pool = preg_split('/[\/@#]/', $target, 2)[0];
    return preg_match('/^[A-Za-z][A-Za-z0-9_.:-]*$/D', $pool) === 1;
}

function zfsmAuditReadEntry($entry): ?array {
    if (!is_array($entry) || ($entry['version'] ?? null) !== 1 || !is_string($entry['operation_id'] ?? null)
        || !preg_match('/^[a-f0-9]{32}$/D', $entry['operation_id'])
        || !is_string($entry['timestamp'] ?? null) || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/D', $entry['timestamp'])
        || !is_string($entry['command'] ?? null) || !preg_match('/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/D', $entry['command'])
        || !in_array($entry['phase'] ?? null, ['begin', 'outcome', 'event'], true)
        || !in_array($entry['status'] ?? null, zfsmAuditStatuses(), true)) return null;
    if ($entry['phase'] === 'begin' && $entry['status'] !== 'started') return null;
    if ($entry['phase'] === 'outcome' && !in_array($entry['status'], ['succeeded', 'failed', 'cancelled', 'recovery_required'], true)) return null;
    $safe = array_intersect_key($entry, array_flip(['version', 'operation_id', 'timestamp', 'command', 'phase', 'status']));
    $safe['fields'] = zfsmAuditFields($entry['fields'] ?? []);
    if ($entry['phase'] === 'outcome') {
        foreach (['succeeded', 'failed'] as $key) if (isset($entry[$key])) $safe[$key] = zfsmAuditTargets($entry[$key]);
        $reason = zfsmAuditReason($entry['reason'] ?? null);
        if ($reason !== null) $safe['reason'] = $reason;
        if(is_array($entry['details']??null))$safe['details']=zfsmAuditFailureDetails($entry['details'],$entry['command']);
    }
    return $safe;
}

function zfsmAuditPath(): string {
    $path = $GLOBALS['plugin_audit'] ?? '/boot/config/plugins/zfs.master.ui/audit';
    if (!is_string($path) || $path === '' || str_contains($path, "\0") || str_contains($path, '://')) throw new \RuntimeException('Audit storage unavailable');
    $path = str_replace('\\', '/', $path);
    if ($path[0] !== '/' && !preg_match('/^[A-Za-z]:\//', $path)) throw new \RuntimeException('Audit storage unavailable');
    if (preg_match('~(?:^|/)\.{1,2}(?:/|$)~', $path)) throw new \RuntimeException('Audit storage unavailable');
    return rtrim($path, '/');
}

function zfsmAuditStorage(bool $create): ?string {
    $path = zfsmAuditPath(); $parts = [];
    for ($part = $path; ; $part = dirname($part)) {
        $parts[] = $part;
        if (dirname($part) === $part) break;
    }
    foreach (array_reverse($parts) as $part) {
        clearstatcache(true, $part);
        if (is_link($part)) throw new \RuntimeException('Audit storage unavailable');
        if (!file_exists($part)) {
            if (!$create) return null;
            if (!@mkdir($part, 0700) && !is_dir($part)) throw new \RuntimeException('Audit storage unavailable');
            zfsmAuditSyncDirectory(dirname($part));
        }
        if (!is_dir($part)) throw new \RuntimeException('Audit storage unavailable');
    }
    if ($create && !@chmod($path, 0700)) throw new \RuntimeException('Audit storage unavailable');
    return $path;
}

/** Check file kind and identity before and after opening; never accept a symlink. */
function zfsmAuditOpen(string $path, bool $create) {
    clearstatcache(true, $path);
    if (is_link($path) || (file_exists($path) && !is_file($path))) throw new \RuntimeException('Audit storage unavailable');
    $handle = @fopen($path, $create ? 'c+b' : 'rb');
    if ($handle === false) throw new \RuntimeException('Audit storage unavailable');
    try {
        clearstatcache(true, $path);
        $stat = @lstat($path); $opened = fstat($handle);
        if ($stat === false || $opened === false || ($stat['mode'] & 0170000) !== 0100000 || $stat['dev'] !== $opened['dev'] || $stat['ino'] !== $opened['ino']) throw new \RuntimeException('Audit storage unavailable');
        if ($create && !@chmod($path, 0600)) throw new \RuntimeException('Audit storage unavailable');
        return $handle;
    } catch (\Throwable $error) { fclose($handle); throw $error; }
}

function zfsmAuditLock(string $directory, int $mode) {
    $handle = zfsmAuditOpen($directory.'/.lock', true);
    if (!flock($handle, $mode)) { fclose($handle); throw new \RuntimeException('Audit storage unavailable'); }
    return $handle;
}

function zfsmAuditSyncDirectory(string $directory): void {
    // Windows does not expose directory handles through fopen. Production is Linux.
    if (PHP_OS_FAMILY === 'Windows') return;
    $handle = @fopen($directory, 'r');
    if ($handle === false) throw new \RuntimeException('Audit directory flush failed');
    try {
        if (!function_exists('fsync') || !@fsync($handle)) throw new \RuntimeException('Audit directory flush failed');
    } catch (\Throwable $error) {
        throw new \RuntimeException('Audit directory flush failed');
    } finally { fclose($handle); }
}

function zfsmAuditAppend(array $entry): void {
    $line = json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)."\n";
    if (strlen($line) > 65536) throw new \RuntimeException('Audit entry too large');
    $directory = zfsmAuditStorage(true);
    $lock = zfsmAuditLock($directory, LOCK_EX);
    try {
        if(function_exists('zfsmActivityInvalidateHistory'))zfsmActivityInvalidateHistory($entry['operation_id']??null);
        $handle = zfsmAuditOpen($directory.'/'.gmdate('Y-m-d').'.jsonl', true);
        try {
            if (fseek($handle, 0, SEEK_END) !== 0) throw new \RuntimeException('Audit storage unavailable');
            $size = ftell($handle);
            if ($size === false) throw new \RuntimeException('Audit storage unavailable');
            if ($size > 0) {
                if (fseek($handle, -1, SEEK_END) !== 0) throw new \RuntimeException('Audit storage unavailable');
                $last = fread($handle, 1);
                if ($last === false || fseek($handle, 0, SEEK_END) !== 0) throw new \RuntimeException('Audit storage unavailable');
                if ($last !== "\n") $line = "\n".$line;
            }
            $written = 0;
            while ($written < strlen($line)) {
                $count = @fwrite($handle, substr($line, $written));
                if ($count === false || $count === 0) throw new \RuntimeException('Audit write failed');
                $written += $count;
            }
            if (!@fflush($handle) || !function_exists('fsync') || !@fsync($handle)) throw new \RuntimeException('Audit flush failed');
            zfsmAuditSyncDirectory($directory);
        } finally { fclose($handle); }
    } finally { flock($lock, LOCK_UN); fclose($lock); }
}
