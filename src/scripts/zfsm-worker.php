<?php
/* Branding renamed to ZFS Director on 2026-10-16; GPL-2.0-or-later. */
if (PHP_SAPI!=='cli') { http_response_code(404); exit; }
require_once dirname(__DIR__).'/backend/ZFSMOperations.php';
$runtime=zfsmJobDirectory($GLOBALS['plugin_runtime']);
if (($argv[1]??'')==='--stop') {
    file_put_contents($runtime.'/stop','stop',LOCK_EX);
    $deadline=microtime(true)+12;
    do { if (!zfsmWorkerRunning(null) && !zfsmServiceRunning() && !zfsmLockHeld($GLOBALS['plugin_lock'])) exit(0); usleep(100000); } while(microtime(true)<$deadline);
    fwrite(STDERR,"ZFS worker is busy; installation stopped before replacing its files.\n"); exit(1);
}
if (($argv[1]??'')==='--launch') { try { zfsmStartWorker(); exit(0); } catch(Throwable $error) { fwrite(STDERR,"Unable to launch ZFS worker; queued jobs retained.\n"); exit(1); } }
if (($argv[1]??'')==='--service') {
    if (function_exists('cli_set_process_title')) @cli_set_process_title('zfs-director service');
    if (!function_exists('posix_kill') || !function_exists('posix_setsid')) { fwrite(STDERR,"PHP POSIX support is required for safe worker supervision.\n"); exit(1); }
    if (is_link($GLOBALS['plugin_service_lock'])) exit(1);
    $service_lock=@fopen($GLOBALS['plugin_service_lock'],'c');
    if (!$service_lock || !flock($service_lock,LOCK_EX|LOCK_NB)) exit(0);
    // REL-001: one daemon per lane. Each is restarted on its own with a short backoff; a crash
    // in one lane never stops the others. On a stop request every daemon finishes its current
    // job and exits by itself; the service waits for all of them before it releases its lock.
    $children=[];$backoff=[];$retryAt=[];$startedAt=[];
    foreach(zfsmWorkerLanes() as $lane){$children[$lane]=null;$backoff[$lane]=1;$retryAt[$lane]=0;$startedAt[$lane]=0;}
    $reap=function($lane)use(&$children){
        $child=$children[$lane];$children[$lane]=null;proc_close($child['process']);
        // The directly owned daemon creates its own session. Reap remaining members after a
        // crash before retrying its job.
        if ($child['pid']>1) @posix_kill(-$child['pid'],9);
    };
    try {
        while (true) {
            $stopping=zfsmWorkerStopRequested();$now=microtime(true);
            foreach ($children as $lane=>$child) {
                if ($child!==null) {
                    if (proc_get_status($child['process'])['running']) continue;
                    $reap($lane);
                    if ($now-$startedAt[$lane]>30) $backoff[$lane]=1;
                    $retryAt[$lane]=$now+$backoff[$lane];$backoff[$lane]=min(5,$backoff[$lane]*2);
                }
                if ($stopping || $now<$retryAt[$lane]) continue;
                $pipes=[];
                $process=proc_open([PHP_BINARY,__FILE__,'--daemon',$lane],[0=>['file','/dev/null','r'],1=>['file',$runtime.'/worker.log','a'],2=>['redirect',1]],$pipes,null,null,['bypass_shell'=>true]);
                if (is_resource($process)) {$children[$lane]=['process'=>$process,'pid'=>proc_get_status($process)['pid']];$startedAt[$lane]=$now;}
                else $retryAt[$lane]=$now+5;
            }
            if ($stopping && !array_filter($children)) break;
            usleep(100000);
        }
    } finally {
        foreach ($children as $lane=>$child) if ($child!==null) $reap($lane);
        flock($service_lock,LOCK_UN); fclose($service_lock);
    }
    exit(0);
}
if (($argv[1]??'')!=='--daemon') { fwrite(STDERR,"Use --daemon [files|policy|replication] or --stop\n"); exit(2); }
$lane=$argv[2]??'files';
if (!in_array($lane,zfsmWorkerLanes(),true)) { fwrite(STDERR,"Unknown worker lane\n"); exit(2); }
if (function_exists('cli_set_process_title')) @cli_set_process_title($lane==='files'?'zfs-director worker':'zfs-director worker '.$lane);
if (!function_exists('posix_setsid') || posix_setsid()===-1) { fwrite(STDERR,"Unable to isolate worker process group.\n"); exit(1); }
$GLOBALS['zfsm_worker_group']=posix_getpid();
$lane_lock=zfsmWorkerLaneLock($lane);
if (is_link($lane_lock)) exit(1);
$worker_lock=@fopen($lane_lock,'c');
if (!$worker_lock || !flock($worker_lock,LOCK_EX|LOCK_NB)) exit(0);
$monitor=null;$historyCheckAt=0;$GLOBALS['zfsm_job_read_cache']=true;
try {
    while (!zfsmWorkerStopRequested()) {
        if ($lane==='files' && (!is_resource($monitor) || !proc_get_status($monitor)['running'])) {
            if (is_resource($monitor)) proc_close($monitor);
            $monitor_pipes=[];
            // Inherits this daemon's process group: the service reaps it after
            // a crash, and a cooperative stop uses the same stop marker.
            $monitor=proc_open([PHP_BINARY,__DIR__.'/zfsm-monitor.php'],[0=>['file','/dev/null','r'],1=>['file',$runtime.'/monitor.log','a'],2=>['redirect',1]],$monitor_pipes,null,null,['bypass_shell'=>true]);
        }
        if($lane==='files'&&time()>=$historyCheckAt){$historyCheckAt=time()+60;try{zfsmJobHistoryCleanup();}catch(Throwable$error){error_log('ZFS Director: job history maintenance unavailable');}try{zfsmProtectionSweepRuntimeQueue();}catch(Throwable$error){error_log('ZFS Director: protection queue maintenance unavailable');}}
        foreach (zfsmPendingJobs($lane) as $job) {
            if (zfsmWorkerStopRequested()) break;
            if(($job['schema']??null)===7){try{zfsmObserveRequestJob($job['id']);}catch(Throwable$error){error_log('ZFS Director: request job requires inspection');}continue;}
            if(($job['schema']??null)===4){try{zfsmRunProtectionJob($job);}catch(Throwable$error){error_log('ZFS Director worker: protection job requires inspection');}continue;}
            try{$lock=zfsmAcquireOperationLock($GLOBALS['plugin_lock'],true);}catch(Throwable$error){error_log('ZFS Director worker: operation lock unavailable');break;}
            if($lock===null)break;
            try {
                // REL-001: a queued job waits (stays queued) while a policy or replication owns
                // its dataset scope; recovery of an interrupted job still runs immediately.
                if(($job['state']??'')==='queued'&&zfsmProtectionJobConflict($job)!==null)continue;
                $GLOBALS['zfsm_operation_lock_handle']=$lock;
                $label=($job['schema']??null)===6?(($job['kind']??null)==='dataset'?'Delete dataset':'Delete directory'):(($job['type']??'')==='archive'?'Prepare ZIP':(($job['type']??'')==='restore'?'Restore files':'Convert directory'));
                zfsmOperationLockDescribe($label,is_string($job['source']??null)?$job['source']:null,$job['id']);
                if(($job['schema']??null)===6){zfsmRunDeletionJob($job['id']);continue;}
                // Recovery only releases our protection and records retained
                // data. It must run even if destructive actions were disabled.
                if(($job['type']??'')==='archive'||(($job['type']??'')==='restore'&&$job['state']!=='queued')){zfsmRunRestoreJob($job['id']);continue;}
                $config=loadConfig(parse_plugin_cfg($GLOBALS['plugin'],true));
                if ((int)$config['destructive_mode']!==1) { zfsmJobUpdate($job['id'],['state'=>'recovery_required','error'=>'Destructive Mode is disabled; enable it and Resume explicitly']); continue; }
                if (($job['type']??'')==='restore') zfsmRunRestoreJob($job['id']);
                else zfsmRunConversionJob($job['id']);
            } catch (Throwable $error) { error_log('ZFS Director worker: job requires inspection'); }
            finally { unset($GLOBALS['zfsm_operation_lock_handle']); zfsmOperationLockForget(); flock($lock,LOCK_UN); fclose($lock); }
        }
        usleep(500000);
    }
} finally { if(is_resource($monitor))proc_close($monitor); flock($worker_lock,LOCK_UN); fclose($worker_lock); }
