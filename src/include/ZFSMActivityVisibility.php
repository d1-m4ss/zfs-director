<?php
/* Read-only: markers written by earlier versions still hide a finished job from the Jobs list. Nothing writes them any more; they go with the job record. */
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
function zfsmActivityJobArchived($job) {
    try{return (zfsmActivityMarker('jobs',$job['id'])['archived']??false)===true;}catch(Throwable$error){return false;}
}
