<?php
// Cleanup is a distinct reviewed operation. Ordinary .zfsm-* deletion stays denied.
function zfsmCleanupName($name) {
    return is_string($name)&&preg_match('/^\.zfsm-mutation-[a-f0-9]{48}$/D',$name)===1;
}
function zfsmCleanupOwnedRequest($job,$directory) {
    $tracking=$GLOBALS['zfsm_request_job']??null;
    if (!is_string($directory)||($job['schema']??null)!==7||($job['command']??null)!=='cleanupmutation'||($job['state']??null)!=='running'||($job['source']??null)!==$directory||!is_array($tracking)||($tracking['id']??null)!==($job['id']??null)||!is_resource($tracking['lease']??null)) return false;
    $lease=$tracking['lease'];$file=zfsmRequestJobLease($job['id']);
    clearstatcache(true,$file);$path=@lstat($file);$opened=fstat($lease);
    if (!$path||!$opened||is_link($file)||($path['mode']&0170000)!==0100000||($opened['mode']&0170000)!==0100000||$path['dev']!==$opened['dev']||$path['ino']!==$opened['ino']||!zfsmRequestJobActive($job)) return false;
    // Do not exempt a lock path replaced during the live-lease observation.
    clearstatcache(true,$file);$after=@lstat($file);
    return $after&&!is_link($file)&&($after['mode']&0170000)===0100000&&$after['dev']===$opened['dev']&&$after['ino']===$opened['ino'];
}
function zfsmCleanupTerminalJob($job) {
    $schema=$job['schema'];$state=$job['state'];$stage=$job['stage']??null;
    if ($state==='completed') {
        if ($schema===1) return $stage==='complete_source_retained';
        if (in_array($schema,[2,6,7],true)) return $stage==='completed';
        if ($schema===4) return $stage==='finished'&&in_array($job['verified_outcome']??null,['completed','completed_with_warnings','up_to_date','skipped'],true);
    }
    // These records prove rejection before native work; generic failures may
    // retain partial data and remain blocked even when their request ended.
    return $state==='failed'&&$stage==='preflight_rejected'&&($schema===5||$schema===7||($schema===6&&$job['rejected']===true));
}
function zfsmCleanupRequireIdle($directory=null) {
    $files=glob(zfsmJobDirectory($GLOBALS['plugin_state']).'/*.json')?:[];
    if(count($files)>5000)throw new RuntimeException('Jobs inventory exceeds cleanup safety limit.');
    foreach($files as$file){
        if(is_link($file)||!is_file($file)||filesize($file)>131072)throw new RuntimeException('Jobs require recovery review before cleanup.');
        try {
            $job=zfsmReadJob(basename($file,'.json'));
            if(zfsmJobProblem($job)||!empty($job['hold_owned'])||zfsmArchiveNeedsCleanup($job)||(!zfsmCleanupOwnedRequest($job,$directory)&&!zfsmCleanupTerminalJob($job)))throw new RuntimeException('Unsafe cleanup journal');
        } catch(Throwable$error) {throw new RuntimeException('Jobs contain unfinished, invalid or unknown operations; inspect them before cleanup.');}
    }
}
function zfsmCleanupInspect($directory) {
    zfsmCleanupRequireIdle($directory);$source=zfsmResolveDirectory($directory,true);
    if(!$source||$directory!==$source['path']||!zfsmCleanupName(substr($source['path'],strlen($source['mountpoint'])+1)))throw new RuntimeException('Choose an exact top-level mutation recovery directory.');
    $owner=zfsmReadIdentity($source['dataset']);$identity=zfsmDirectoryIdentity($source['path']);
    $native=zfsmDirectoryCommand(['op'=>'cleanup-inspect','root'=>$source['mountpoint'],'root_identity'=>zfsmDirectoryIdentity($source['mountpoint']),'path'=>basename($source['path']),'identity'=>$identity]);
    if(($native['ok']??false)!==true)throw new RuntimeException($native['error']??'Recovery cleanup inspection failed.');
    $bytes=isset($native['journal_base64'])&&is_string($native['journal_base64'])?base64_decode($native['journal_base64'],true):false;
    if(!is_string($bytes)||strlen($bytes)>262144||($native['identity']??null)!==$identity||!is_array($native['journal_identity']??null)||!is_string($native['journal_sha256']??null)||!hash_equals(hash('sha256',$bytes),$native['journal_sha256']))throw new RuntimeException('Native recovery review is incomplete.');
    $rootIdentity=zfsmDirectoryIdentity($source['mountpoint']);
    return ['scope'=>['kind'=>'cleanup','name'=>$source['dataset'],'guid'=>$owner['guid'],'directory'=>$source['path'],'root'=>$source['mountpoint'],'root_identity'=>$rootIdentity,'identity'=>$identity,'journal_identity'=>$native['journal_identity'],'journal_sha256'=>$native['journal_sha256'],'operation'=>$native['operation'],'records'=>$native['records'],'can_proceed'=>true],'journal_base64'=>$native['journal_base64']];
}
function zfsmCleanupPreview($directory,$secret) {
    return zfsmOperationPreview(zfsmCleanupInspect($directory)['scope'],$secret);
}
function zfsmCleanupCommit($request,$secret) {
    if(($request['confirmed']??null)!=='1')throw new InvalidArgumentException('Explicit cleanup confirmation is required.');
    $inspected=zfsmCleanupInspect($request['directory']??'');$scope=$inspected['scope'];
    zfsmOperationConsume($request,$secret,$scope);
    // A durable copy is required before the native helper may remove the journal.
    $archive=zfsmJobDirectory(dirname($GLOBALS['plugin_state']).'/mutation-cleanup').'/'.$request['preview_id'].'.json';
    $record=['schema'=>1,'purpose'=>'journal archive before cleanup; outcome is in administrative history','archived_at'=>gmdate('c'),'scope'=>$scope,'journal_base64'=>$inspected['journal_base64']];
    if(file_exists($archive)||is_link($archive))throw new RuntimeException('Cleanup archive identity already exists.');
    zfsmJobAtomicWrite($archive,$record);
    if(json_decode(file_get_contents($archive),true)!==$record)throw new RuntimeException('Cleanup archive readback failed; no deletion attempted.');
    $result=zfsmDirectoryCommand(['op'=>'cleanup','root'=>$scope['root'],'root_identity'=>$scope['root_identity'],'path'=>basename($scope['directory']),'identity'=>$scope['identity'],'journal_sha256'=>$scope['journal_sha256']]);
    $answer=zfsmDirectoryAnswer($scope['directory'],$result);$answer['cleanup_archive']=$archive;return $answer;
}
