<?php
/* Branding renamed to ZFS Director on 2026-10-16; GPL-2.0-or-later. */
if (PHP_SAPI!=='cli') { http_response_code(404); exit; }
require_once dirname(__DIR__).'/backend/ZFSMOperations.php';
$runtime=zfsmJobDirectory($GLOBALS['plugin_runtime']);
if (($argv[1]??'')==='--stop') {
    file_put_contents($runtime.'/stop','stop',LOCK_EX);
    $deadline=microtime(true)+12;
    do { if (!zfsmWorkerRunning() && !zfsmServiceRunning() && !zfsmLockHeld($GLOBALS['plugin_lock'])) exit(0); usleep(100000); } while(microtime(true)<$deadline);
    fwrite(STDERR,"ZFS worker is busy; installation stopped before replacing its files.\n"); exit(1);
}
if (($argv[1]??'')==='--launch') { try { zfsmStartWorker(); exit(0); } catch(Throwable $error) { fwrite(STDERR,"Unable to launch ZFS worker; queued jobs retained.\n"); exit(1); } }
if (($argv[1]??'')==='--service') {
    if (!function_exists('posix_kill') || !function_exists('posix_setsid')) { fwrite(STDERR,"PHP POSIX support is required for safe worker supervision.\n"); exit(1); }
    if (is_link($GLOBALS['plugin_service_lock'])) exit(1);
    $service_lock=@fopen($GLOBALS['plugin_service_lock'],'c');
    if (!$service_lock || !flock($service_lock,LOCK_EX|LOCK_NB)) exit(0);
    try {
        zfsmSuperviseWorker(function()use($runtime){
            $pipes=[];
            $child=proc_open([PHP_BINARY,__FILE__,'--daemon'],[0=>['file','/dev/null','r'],1=>['file',$runtime.'/worker.log','a'],2=>['redirect',1]],$pipes,null,null,['bypass_shell'=>true]);
            if (is_resource($child)) {
                $pid=proc_get_status($child)['pid']; proc_close($child);
                // The directly owned daemon creates its own session. Reap
                // remaining members after a crash before retrying its job.
                if ($pid>1) @posix_kill(-$pid,9);
            }
        },fn()=>zfsmWorkerStopRequested(),function($seconds){
            for($n=0;$n<$seconds*10 && !zfsmWorkerStopRequested();$n++)usleep(100000);
        });
    } finally { flock($service_lock,LOCK_UN); fclose($service_lock); }
    exit(0);
}
if (($argv[1]??'')!=='--daemon') { fwrite(STDERR,"Use --daemon or --stop\n"); exit(2); }
if (!function_exists('posix_setsid') || posix_setsid()===-1) { fwrite(STDERR,"Unable to isolate worker process group.\n"); exit(1); }
$GLOBALS['zfsm_worker_group']=posix_getpid();
if (is_link($GLOBALS['plugin_worker_lock'])) exit(1);
$worker_lock=@fopen($GLOBALS['plugin_worker_lock'],'c');
if (!$worker_lock || !flock($worker_lock,LOCK_EX|LOCK_NB)) exit(0);
$monitor=null;$historyCheckAt=0;
try {
    while (!zfsmWorkerStopRequested()) {
        if (!is_resource($monitor) || !proc_get_status($monitor)['running']) {
            if (is_resource($monitor)) proc_close($monitor);
            $monitor_pipes=[];
            // Inherits this daemon's process group: the service reaps it after
            // a crash, and a cooperative stop uses the same stop marker.
            $monitor=proc_open([PHP_BINARY,__DIR__.'/zfsm-monitor.php'],[0=>['file','/dev/null','r'],1=>['file',$runtime.'/monitor.log','a'],2=>['redirect',1]],$monitor_pipes,null,null,['bypass_shell'=>true]);
        }
        if(time()>=$historyCheckAt){$historyCheckAt=time()+60;try{zfsmJobHistoryCleanup();}catch(Throwable$error){error_log('ZFS Director: job history maintenance unavailable');}}
        foreach (zfsmPendingJobs() as $job) {
            if (zfsmWorkerStopRequested()) break;
            if(($job['schema']??null)===7){try{zfsmObserveRequestJob($job['id']);}catch(Throwable$error){error_log('ZFS Director: request job requires inspection');}continue;}
            if(($job['schema']??null)===4){zfsmRunProtectionJob($job);continue;}
            try{$lock=zfsmAcquireOperationLock($GLOBALS['plugin_lock'],true);}catch(Throwable$error){error_log('ZFS Director worker: operation lock unavailable');break;}
            if($lock===null)break;
            try {
                $GLOBALS['zfsm_operation_lock_handle']=$lock;
                if(($job['schema']??null)===6){zfsmRunDeletionJob($job['id']);continue;}
                // Recovery only releases our protection and records retained
                // data. It must run even if destructive actions were disabled.
                if(($job['type']??'')==='archive'||(($job['type']??'')==='restore'&&$job['state']!=='queued')){zfsmRunRestoreJob($job['id']);continue;}
                $config=loadConfig(parse_plugin_cfg($GLOBALS['plugin'],true));
                if ((int)$config['destructive_mode']!==1) { zfsmJobUpdate($job['id'],['state'=>'recovery_required','error'=>'Destructive Mode is disabled; enable it and Resume explicitly']); continue; }
                if (($job['type']??'')==='restore') zfsmRunRestoreJob($job['id']);
                else zfsmRunConversionJob($job['id']);
            } catch (Throwable $error) { error_log('ZFS Director worker: job requires inspection'); }
            finally { unset($GLOBALS['zfsm_operation_lock_handle']); flock($lock,LOCK_UN); fclose($lock); }
        }
        usleep(500000);
    }
} finally { if(is_resource($monitor))proc_close($monitor); flock($worker_lock,LOCK_UN); fclose($worker_lock); }
