<?php
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require_once dirname(__DIR__).'/backend/ZFSMOperations.php';
try{
    $answer=zfsmQueueProtection(['type'=>$argv[1]??'','id'=>$argv[2]??''],false);
    if(!empty($answer['failed']))exit(1);
    zfsmStartWorker();exit(0);
}catch(Throwable$error){error_log('ZFS Director scheduled protection failed: '.$error->getMessage());exit(1);}
