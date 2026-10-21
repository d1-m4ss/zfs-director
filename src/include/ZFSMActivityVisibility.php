<?php
/* Visibility markers never move or delete worker journals or audit records. */
function zfsmActivityIds($ids,$kind) {
    $maximum=$kind==='jobs'?200:500;
    if (!is_array($ids) || !array_is_list($ids) || count($ids)<1 || count($ids)>$maximum) throw new InvalidArgumentException('Invalid visibility selection');
    $seen=[];
    foreach($ids as$id) {
        if (!is_string($id) || ($kind==='jobs'?preg_match('/^[0-9]{8}-[0-9]{6}-[a-f0-9]{12}$/D',$id):preg_match('/^[a-f0-9]{32}$/D',$id))!==1 || isset($seen[$id])) throw new InvalidArgumentException('Invalid visibility ID');
        $seen[$id]=true;
    }
    return $ids;
}
function zfsmActivityDirectory($kind) {
    if (!in_array($kind,['jobs','history'],true)) throw new InvalidArgumentException('Invalid visibility kind');
    $root=zfsmJobDirectory($GLOBALS['plugin_state']);
    return zfsmJobDirectory(zfsmJobDirectory($root.'/visibility').'/'.$kind);
}
function zfsmActivityMarker($kind,$id) {
    zfsmActivityIds([$id],$kind);$file=zfsmActivityDirectory($kind).'/'.$id.'.marker';
    if (!file_exists($file) && !is_link($file)) return null;
    $handle=zfsmAuditOpen($file,false);
    try{$bytes=stream_get_contents($handle,2049);}finally{fclose($handle);}
    $marker=is_string($bytes)&&strlen($bytes)<=2048?json_decode($bytes,true,4):null;
    if (!is_array($marker)||!in_array($marker['version']??null,[1,2],true)||($marker['id']??null)!==$id||!is_bool($marker['archived']??null)) throw new RuntimeException('Invalid visibility marker; no activity was hidden');
    return $marker;
}
function zfsmActivityJobEligible($job) {
    return !zfsmJobProblem($job) && ($job['state']??'')==='completed' && empty($job['hold_owned']) && empty($job['error']) && !(function_exists('zfsmArchiveNeedsCleanup')&&zfsmArchiveNeedsCleanup($job));
}
function zfsmActivitySetJobs($ids,$archived) {
    $ids=zfsmActivityIds($ids,'jobs');if(!is_bool($archived))throw new InvalidArgumentException('Invalid visibility action');
    $directory=zfsmActivityDirectory('jobs');$lock=zfsmAuditLock($directory,LOCK_EX);
    try{
        foreach($ids as$id){$job=zfsmReadJob($id);if($archived&&!zfsmActivityJobEligible($job))throw new InvalidArgumentException('Only valid completed jobs without snapshot protection or errors can be archived');}
        foreach($ids as$id)zfsmJobAtomicWrite($directory.'/'.$id.'.marker',['version'=>1,'id'=>$id,'archived'=>$archived]);
    }finally{flock($lock,LOCK_UN);fclose($lock);}
    return ['succeeded'=>array_fill_keys($ids,$archived?'Hidden from working view; retained journal unchanged':'Restored to working view'),'failed'=>[]];
}
function zfsmActivityJobArchived($job) {
    if(!zfsmActivityJobEligible($job))return false;
    try{return (zfsmActivityMarker('jobs',$job['id'])['archived']??false)===true;}catch(Throwable$error){return false;}
}
function zfsmActivityHistoryGroups($entries) {
    $groups=[];foreach($entries as$entry)$groups[$entry['operation_id']][]=$entry;return $groups;
}
function zfsmActivityHistoryOutcome($entries) {
    $outcome=null;
    foreach($entries as$entry){
        if(in_array($entry['status'],['failed','cancelled','recovery_required','running','queued'],true))return null;
        if($entry['phase']==='outcome'&&$entry['status']==='succeeded'&&($outcome===null||strcmp($entry['timestamp'],$outcome['timestamp'])>=0))$outcome=$entry;
    }
    return $outcome;
}
// Every page keeps the audit reader's 2 MiB / 4096-line budget. Review tokens
// are server-owned temporary state, bound to the exact selection and markers.
function zfsmActivityHistoryReviewFile($token) {
    if(!is_string($token)||!preg_match('/^[a-f0-9]{32}$/D',$token))throw new InvalidArgumentException('Invalid history review token');
    return zfsmJobDirectory(zfsmActivityDirectory('history').'/reviews').'/'.$token.'.json';
}
function zfsmActivityHistoryReviewState($token,$ids) {
    $h=zfsmAuditOpen(zfsmActivityHistoryReviewFile($token),false);try{$raw=stream_get_contents($h,262145);}finally{fclose($h);}
    $state=is_string($raw)&&strlen($raw)<=262144?json_decode($raw,true,12):null;
    if(!is_array($state)||($state['ids']??null)!==$ids||($state['expires']??0)<time())throw new RuntimeException('History review expired or selection changed; review again');
    foreach($ids as$id)if((zfsmActivityMarker('history',$id)['review']??null)!==$token)throw new RuntimeException('Operation changed during history review; refresh and review again');
    return $state;
}
function zfsmActivityHistoryReviewPrune($directory) {
    $scan=@opendir($directory);if(!$scan)throw new RuntimeException('History review storage unavailable');$active=0;$seen=0;
    try{while(($name=readdir($scan))!==false){if($name==='.'||$name==='..')continue;if(++$seen>256)throw new RuntimeException('History review cache scan incomplete; retry later');$p=$directory.'/'.$name;$st=@lstat($p);
        if(preg_match('/^[a-f0-9]{32}\.json$/D',$name)&&$st&&($st['mode']&0170000)===0100000&&$st['mtime']<time()-600){if(!@unlink($p))throw new RuntimeException('Expired history review could not be removed');}else$active++;
    }}finally{closedir($scan);}
    if($active>=64)throw new RuntimeException('Too many active history reviews; retry after ten minutes');
}
function zfsmActivityHistoryReview($ids,$token='') {
    $ids=zfsmActivityIds($ids,'history');$audit=zfsmAuditStorage(true);
    if($token===''){
        $token=bin2hex(random_bytes(16));$lock=zfsmAuditLock($audit,LOCK_EX);
        try{
            zfsmActivityHistoryReviewPrune(dirname(zfsmActivityHistoryReviewFile($token)));
            $state=['ids'=>$ids,'expires'=>time()+600,'cursor'=>'','groups'=>[],'complete'=>false];
            foreach($ids as$id)zfsmJobAtomicWrite(zfsmActivityDirectory('history').'/'.$id.'.marker',['version'=>2,'id'=>$id,'archived'=>false,'review'=>$token]);
            zfsmJobAtomicWrite(zfsmActivityHistoryReviewFile($token),$state);
        }finally{flock($lock,LOCK_UN);fclose($lock);}
    }
    $state=zfsmActivityHistoryReviewState($token,$ids);
    if(!$state['complete']){
        $page=zfsmAuditPage(500,$state['cursor']);
        if($page['directory_entries_scanned']>=4096)throw new RuntimeException('Audit directory scan incomplete; no operation was hidden');
        $lock=zfsmAuditLock($audit,LOCK_EX);
        try{
            // Re-read under the append lock: a concurrent target event clears
            // its review guard before it is appended, including across pages.
            $current=zfsmActivityHistoryReviewState($token,$ids);
            if($current['cursor']!==$state['cursor'])throw new RuntimeException('History review already advanced; retry');
            foreach($page['entries']as$entry){$id=$entry['operation_id'];if(!in_array($id,$ids,true)||!empty($state['groups'][$id]['begin']))continue;
                $g=$state['groups'][$id]??['outcome'=>null,'begin'=>false,'blocked'=>false];
                if(in_array($entry['status'],['failed','cancelled','recovery_required','running','queued'],true))$g['blocked']=true;
                if($entry['phase']==='outcome'&&$entry['status']==='succeeded'&&$g['outcome']===null)$g['outcome']=$entry;
                if($entry['phase']==='begin')$g['begin']=true;$state['groups'][$id]=$g;
            }
            $state['cursor']=$page['next_cursor'];$state['complete']=!$page['has_more'];
            $all=true;foreach($ids as$id){$g=$state['groups'][$id]??[];if(!empty($g['blocked']))throw new InvalidArgumentException('Operation has failed, active or recovery events and cannot be hidden');if(empty($g['begin']))$all=false;}
            $state['complete']=$state['complete']||$all;
            if($state['complete'])foreach($ids as$id)if(empty($state['groups'][$id]['outcome']))throw new InvalidArgumentException('Operation has no confirmed successful outcome; no activity was hidden');
            zfsmJobAtomicWrite(zfsmActivityHistoryReviewFile($token),$state);
        }finally{flock($lock,LOCK_UN);fclose($lock);}
    }
    return ['review_token'=>$token,'complete'=>$state['complete'],'has_more'=>!$state['complete']];
}
// Called under the audit append lock, before writing any new event. Invalidate
// only this operation's marker; unrelated history does not re-open old groups.
function zfsmActivityInvalidateHistory($id) {
    if(!is_string($id)||!preg_match('/^[a-f0-9]{32}$/D',$id)||!isset($GLOBALS['plugin_state']))return;
    $base=rtrim($GLOBALS['plugin_state'],'/').'/visibility/history';$file=$base.'/'.$id.'.marker';
    if(!file_exists($file)&&!is_link($file))return;
    zfsmActivityMarker('history',$id); // Reject an unsafe marker, never follow it.
    zfsmJobAtomicWrite($file,['version'=>2,'id'=>$id,'archived'=>false]);
}
function zfsmActivitySetHistory($ids,$archived,$token='') {
    $ids=zfsmActivityIds($ids,'history');if(!is_bool($archived))throw new InvalidArgumentException('Invalid visibility action');
    if($archived&&$token===''){$review=zfsmActivityHistoryReview($ids);if(!$review['complete'])throw new InvalidArgumentException('Older history needs a complete paginated review before hiding');$token=$review['review_token'];}
    $lock=zfsmAuditLock(zfsmAuditStorage(true),LOCK_EX);
    try{
        $state=$archived?zfsmActivityHistoryReviewState($token,$ids):null;
        if($archived&&!$state['complete'])throw new InvalidArgumentException('History review is incomplete; no operation was hidden');
        foreach($ids as$id){$outcome=$archived?$state['groups'][$id]['outcome']:null;zfsmJobAtomicWrite(zfsmActivityDirectory('history').'/'.$id.'.marker',['version'=>2,'id'=>$id,'archived'=>$archived,'outcome'=>$outcome===null?null:hash('sha256',json_encode($outcome,JSON_THROW_ON_ERROR))]);}
        if($archived)@unlink(zfsmActivityHistoryReviewFile($token));
    }finally{flock($lock,LOCK_UN);fclose($lock);}
    return ['succeeded'=>array_fill_keys($ids,$archived?'Hidden from working view; audit retained':'Restored to working view'),'failed'=>[]];
}
function zfsmActivityAuditPage($limit,$cursor) {
    $page=zfsmAuditPage($limit,$cursor);$archived=[];
    foreach(zfsmActivityHistoryGroups($page['entries'])as$id=>$entries){
        $problem=false;foreach($entries as$entry)if(in_array($entry['status'],['failed','cancelled','recovery_required','running','queued'],true))$problem=true;
        try{$marker=zfsmActivityMarker('history',$id);}catch(Throwable$error){$marker=null;}
        // Legacy markers lacked an append invalidation guard: leave visible
        // until a fresh review. New markers are invalidated on every ID event.
        if(!$problem&&($marker['version']??null)===2&&($marker['archived']??false)===true&&is_string($marker['outcome']??null))$archived[]=$id;
    }
    $page['archived_ids']=$archived;return $page;
}
