<?php
/* Branding renamed to ZFS Director on 2026-10-16; GPL-2.0-or-later. */
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once dirname(__DIR__).'/backend/ZFSMOperations.php';
$runtime=zfsmJobDirectory($GLOBALS['plugin_runtime']);
$lockfile=$runtime.'/monitor.lock';
if (is_link($lockfile)) exit(1);
$lock=fopen($lockfile,'c');
if (!$lock || !flock($lock,LOCK_EX|LOCK_NB)) exit(0);
try {
    do {
        try { zfsmMonitorPools(); }
        catch (Throwable $error) { error_log('ZFS Director monitor: '.$error->getMessage()); }
        if (($argv[1]??'')==='--once') break;
        // Independent of the browser and long-running conversion jobs.
        for ($i=0;$i<600 && !zfsmWorkerStopRequested();$i++) usleep(100000);
    } while (!zfsmWorkerStopRequested());
} finally { flock($lock,LOCK_UN); fclose($lock); }
