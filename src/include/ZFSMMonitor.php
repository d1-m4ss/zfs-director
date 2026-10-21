<?php
/* Branding renamed to ZFS Director on 2026-10-16; GPL-2.0-or-later. */

function zfsmSendPoolNotification($pool, $severity, $reasons) {
    $level = $severity === 'error' ? 'alert' : 'warning';
    $label = $severity === 'error' ? 'Error' : ($severity === 'unknown' ? 'Monitoring unavailable' : 'Warning');
    $text = implode("\n", $reasons);
    $result = runProcess('/usr/local/emhttp/webGui/scripts/notify', [
        '-e', 'ZFS Director', '-s', 'ZFS pool '.$pool.': '.$label,
        '-d', 'Pool '.$pool.' requires attention.', '-m', $text, '-i', $level,
        '-l', '/Main/ZFSDirector?pool='.rawurlencode($pool).'&tab=pool-status'
    ]);
    return ($result['code'] ?? 1) === 0;
}

// Persist only transitions, not every poll. The lock also prevents two
// overlapping monitor processes from sending the same warning.
function zfsmMonitorTransition($directory, $diagnostic, $send = null) {
    $pool = $diagnostic['pool'] ?? '';
    if (!zfsmValidPoolName($pool)) throw new InvalidArgumentException('Invalid monitored pool');
    zfsmJobDirectory($directory);
    $file = $directory.'/health.json'; $lockfile = $directory.'/health.lock';
    if (is_link($file) || is_link($lockfile)) throw new RuntimeException('Monitor state cannot be a symlink');
    $lock = fopen($lockfile, 'c');
    if (!$lock || !flock($lock, LOCK_EX)) throw new RuntimeException('Unable to lock monitor state');
    try {
        $state = [];
        if (is_file($file)) {
            try {
                if (filesize($file)>1048576) throw new RuntimeException('Monitor state is too large');
                $state = json_decode(file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
                if (!is_array($state)) throw new RuntimeException('Invalid monitor state');
                foreach ($state as $name=>$fingerprint) if (!zfsmValidPoolName($name) || !is_string($fingerprint) || preg_match('/^[a-f0-9]{64}$/D',$fingerprint)!==1) throw new RuntimeException('Invalid monitor transition');
            } catch (Throwable $error) {
                // A damaged dedup journal must not disable all future alerts.
                // Preserve its exact bytes, then rebuild transitions from fresh diagnostics.
                $retained=$file.'.corrupt-'.gmdate('Ymd-His').'-'.bin2hex(random_bytes(6));
                if (!@rename($file,$retained)) throw new RuntimeException('Unable to preserve damaged monitor state');
                zfsmAuditSyncDirectory($directory); $state=[];
            }
        }
        $severity = $diagnostic['severity'] ?? 'unknown';
        // A partial diagnostic must not downgrade an already observed fault.
        if ($severity === 'unknown') {
            if (!in_array($diagnostic['health'] ?? 'UNKNOWN',['ONLINE','UNKNOWN'],true)) $severity='error';
            foreach ($diagnostic['status']['rows'] ?? [] as $row) {
                foreach (['read','write','cksum'] as $key) if (zfsmPoolDiagnosticPositive($row[$key] ?? '0')) $severity='error';
            }
            if (preg_match('/Permanent errors|\b[1-9][0-9]*\s+(?:data\s+)?errors?\b/i', $diagnostic['status']['errors'] ?? '')) $severity='error';
        }
        $reasons = array_values(array_unique(array_map('strval', $diagnostic['reasons'] ?? []))); sort($reasons, SORT_STRING);
        $fingerprint = $severity === 'ok' ? null : hash('sha256', json_encode([$severity,$diagnostic['health'] ?? 'UNKNOWN',$reasons], JSON_THROW_ON_ERROR));
        if (($state[$pool] ?? null) === $fingerprint) return false;
        $deliver = $send ?? static function($pool,$severity,$reasons) { return zfsmSendPoolNotification($pool,$severity,$reasons); };
        if ($fingerprint !== null && !$deliver($pool,$severity,$reasons)) return false;
        if ($fingerprint === null) unset($state[$pool]); else $state[$pool] = $fingerprint;
        zfsmJobAtomicWrite($file,$state);
        try{zfsmRecordMaintenanceTransition($directory,$diagnostic,$severity,$reasons);}catch(Throwable $error){error_log('ZFS Director maintenance history could not be persisted; health dedup remains intact.');}
        return $fingerprint !== null;
    } finally { flock($lock, LOCK_UN); fclose($lock); }
}

function zfsmMonitorPools() {
    $directory = dirname($GLOBALS['plugin_state']).'/monitor';
    $config=loadConfig(@parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_RAW)?:[]);
    $GLOBALS['zfsm_inventory_deadline'] = microtime(true)+8;
    try {
        $list = runProcess('zpool',['list','-H','-o','name']);
        if (($list['code'] ?? 1) !== 0) throw new RuntimeException('Unable to list ZFS pools');
        $pools = preg_split('/\r\n|\r|\n/',trim($list['output'] ?? ''),-1,PREG_SPLIT_NO_EMPTY) ?: [];
    } finally { unset($GLOBALS['zfsm_inventory_deadline']); }
    foreach ($pools as $pool) {
        if (zfsmWorkerStopRequested()) break;
        if (!zfsmValidPoolName($pool)) throw new RuntimeException('Invalid ZFS pool inventory');
        $GLOBALS['zfsm_inventory_deadline'] = microtime(true)+8;
        try { zfsmMonitorTransition($directory,zfsmReadMaintenanceDiagnostics($pool,$config)); }
        finally { unset($GLOBALS['zfsm_inventory_deadline']); }
    }
}
