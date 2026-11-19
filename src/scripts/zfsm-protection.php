<?php
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require_once dirname(__DIR__).'/backend/ZFSMOperations.php';
try{
    $answer=zfsmQueueProtection(['type'=>$argv[1]??'','id'=>$argv[2]??''],false);
    if(!empty($answer['failed']))exit(1);
    zfsmStartWorker();exit(0);
}catch(Throwable$error){
    // Cron discards output; the system log keeps the reason a scheduled run did not start.
    $message='ZFS Director scheduled '.preg_replace('/[^a-z]/','',(string)($argv[1]??'')).' '.preg_replace('/[^a-f0-9]/','',(string)($argv[2]??'')).' did not start: '.$error->getMessage();
    error_log($message);if(function_exists('openlog')&&openlog('zfs-director',LOG_PID,LOG_USER)){syslog(LOG_WARNING,$message);closelog();}exit(1);}
