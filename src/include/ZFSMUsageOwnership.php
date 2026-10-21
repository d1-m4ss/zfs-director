<?php
// Read-only reference proofs. Ambiguity never becomes absence or active I/O.
function zfsmUsageUserPath($path,$io) {
    if(!str_starts_with($path,'/mnt/user/')||!zfsmUsageLexicalPath($path))return null;
    $parts=explode('/',substr($path,10),2);$share='/mnt/user/'.$parts[0];$suffix=isset($parts[1])?'/'.$parts[1]:'';
    if(is_link($share)){
        $target=realpath($share);$resolved=realpath($path);
        if(!is_string($target)||!preg_match('~^/mnt/(?!user(?:0)?/)[A-Za-z0-9_.-]+/.+~D',$target)||$resolved!==$target.$suffix||!zfsmUsageSafePath($resolved))return null;
        return $resolved;
    }
    if(!zfsmUsageSafePath($path))return null;$mounts=($io['mounts'])();$fuse=null;
    foreach($mounts as$m)if($m['path']==='/mnt/user'&&($m['fs']==='fuse.shfs'||$m['fs']==='fuse'&&$m['source']==='shfs'))$fuse=$m;
    if(!$fuse||!zfsmUsageVisibleMount($fuse,$mounts)||!($tool=($io['tool'])('getfattr')))return null;
    $before=($io['stat'])($path);$args=['--absolute-names','--only-values','-n','system.LOCATION','--',$path];$first=($io['process'])($tool,$args);$location=trim($first['output']??'');
    if(($first['code']??1)!==0||!preg_match('/^[A-Za-z0-9][A-Za-z0-9_.-]*$/D',$location)||in_array($location,['user','user0'],true))return null;
    $resolved='/mnt/'.$location.'/'.substr($path,10);if(!zfsmUsageSafePath($resolved))return null;
    $second=($io['process'])($tool,$args);clearstatcache(true,$path);$after=($io['stat'])($path);
    if(!$before||!$after||array_intersect_key($before,array_flip(['dev','ino','mode']))!==array_intersect_key($after,array_flip(['dev','ino','mode']))||($second['code']??1)!==0||trim($second['output']??'')!==$location)return null;
    return $resolved;
}
function zfsmUsageAncestorExposure($entry,$properties,$io) {
    $pid=$entry['namespace_pid']??'';$destination=$entry['destination']??'';
    if(!is_string($pid)||!preg_match('/^[1-9][0-9]{0,8}$/D',$pid)||!zfsmUsageLexicalPath($destination))return false;
    $relative=substr($properties['mountpoint'],strlen($entry['path']));$expected=$destination.$relative;
    $read=($io['read'])('/proc/'.$pid.'/mountinfo');if(($read['status']??'')!=='known')return false;
    $mounts=zfsmUsageParseMounts($read['content']??'');
    // A read-only parent bind does not make its child mounts read-only.
    // Return the verified child's effective per-mount mode, not its superblock.
    foreach($mounts as$m)if(($m['root']??null)==='/'&&$m['path']===$expected&&$m['fs']==='zfs'&&$m['source']===$properties['name']&&zfsmUsageVisibleMount($m,$mounts))return $m;
    return false;
}
function zfsmUsageVerifyVolume($p,$io) {
    if(($p['type']??null)!=='volume'||!zfsmValidDatasetName($p['name']??'')||!preg_match('/^[1-9][0-9]*$/D',(string)($p['guid']??''))||!($tool=($io['tool'])('zfs'))||!zfsmUsageHasTime($io))return false;
    $r=($io['process'])($tool,['list','-H','-p','-o','name,guid,type',$p['name']]);return ($r['code']??1)===0&&trim($r['output']??'')===$p['name']."\t".$p['guid']."\tvolume";
}
function zfsmUsageZvolReference($entry,$properties,$io) {
    $path=$entry['path']??'';if(!zfsmUsageLexicalPath($path)||!str_starts_with($path,'/dev/'))return null;
    $canonical=($io['realpath'])('/dev/zvol/'.$properties['name']);$actual=($io['realpath'])($path);
    if(!is_string($canonical)||!preg_match('~^/dev/zd[0-9]+$~D',$canonical)||$actual!==$canonical)return null;
    $before=($io['stat'])($canonical);if(!$before||($before['mode']&0170000)!==0060000)return null;
    if(!zfsmUsageVerifyVolume($properties,$io))return null;
    clearstatcache(true,$canonical);$after=($io['stat'])($canonical);
    if(!$after||$before['rdev']!==$after['rdev']||$before['ino']!==$after['ino']||($io['realpath'])('/dev/zvol/'.$properties['name'])!==$canonical)return null;
    return $entry+['evidence'=>'zvol_device_identity','configured_reference'=>true];
}
