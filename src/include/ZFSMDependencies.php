<?php
// Optional, bounded evidence. Unknown is never interpreted as proof of no use.
function zfsmDependencyReport($properties,$inventory,$mounts,$usage) {
    $name=$properties['name']??'';$result=['status'=>'unknown','source'=>'zfs + mountinfo','entries'=>[],'services'=>[],'services_status'=>'known'];$found=false;
    foreach($inventory as $row){if(($row['name']??'')===$name){if(($row['guid']??null)!==($properties['guid']??null))return $result;$found=true;}}
    if(!$found)return $result;
    $result['status']='known';
    foreach($inventory as $row){
        $object=$row['name']??'';$owner=explode('@',$object,2)[0];
        if(str_starts_with($object,$name.'/')&&($row['mounted']??'')==='yes')$result['entries'][]=['kind'=>'mounted_child','name'=>$object,'path'=>$row['mountpoint']??''];
        if(($row['type']??'')==='snapshot'&&($owner===$name||str_starts_with($owner,$name.'/'))&&(int)($row['userrefs']??0)>0)$result['entries'][]=['kind'=>'hold','name'=>$object,'count'=>(int)$row['userrefs']];
        $origin=$row['origin']??'-';$originOwner=explode('@',$origin,2)[0];
        if($origin!=='-'&&($originOwner===$name||str_starts_with($originOwner,$name.'/')))$result['entries'][]=['kind'=>'clone','name'=>$object,'origin'=>$origin];
    }
    $root=rtrim($properties['mountpoint']??'','/');
    foreach($mounts as $mount){
        $ordinary=false;foreach($inventory as $row)if(str_starts_with($row['name'],$name.'/')&&$row['name']===$mount['source']&&($row['mountpoint']??null)===$mount['path'])$ordinary=true;
        if($root!==''&&str_starts_with($mount['path'],$root.'/')&&!$ordinary)$result['entries'][]=['kind'=>'nested_mount','name'=>$mount['source'],'path'=>$mount['path']];
        elseif($mount['fs']==='zfs'&&$mount['source']===$name&&$mount['path']!==$root)$result['entries'][]=['kind'=>'additional_mount','name'=>$name,'path'=>$mount['path']];
    }
    if(!$mounts&&($properties['mounted']??'')==='yes')$result['status']='unknown';
    foreach($usage as $service=>$value){
        if(($value['status']??'')!=='known')$result['services_status']='unknown';
        foreach($value['entries']??[] as $entry)$result['services'][]=$entry+['service'=>$service];
    }
    return $result;
}

function zfsmReadDependencies($properties,$usage,$overrides=[]) {
    $io=zfsmUsageIO($overrides);$unknown=['status'=>'unknown','entries'=>[],'services'=>[],'services_status'=>'unknown','source'=>'zfs + mountinfo'];
    $name=$properties['name']??'';$tool=($io['tool'])('zfs');if(!$tool||!zfsmValidDatasetName($name))return $unknown;
    $columns=['name','type','guid','mounted','mountpoint','origin','userrefs'];
    $read=($io['process'])($tool,['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o',implode(',',$columns),explode('/',$name,2)[0]]);
    if(($read['code']??1)!==0)return $unknown;$inventory=[];
    foreach(preg_split('/\r\n|\r|\n/',trim($read['output']??''),-1,PREG_SPLIT_NO_EMPTY)?:[] as $line){
        $parts=explode("\t",$line);if(count($parts)!==count($columns))return $unknown;$row=array_combine($columns,$parts);
        if((!zfsmValidDatasetName($row['name'])&&!zfsmValidSnapshotName($row['name']))||!preg_match('/^[1-9][0-9]*$/D',$row['guid'])||isset($inventory[$row['name']]))return $unknown;
        $inventory[$row['name']]=$row;
    }
    return zfsmDependencyReport($properties,array_values($inventory),($io['mounts'])(),$usage);
}

function zfsmDependencyBlocks($report,$command,$path=null) {
    if(!in_array($command,['renamedataset','destroydataset','movedirectory','convertdirectory','deletedirectory'],true))return false;
    foreach($report['services']??[] as $entry){
        $used=$entry['path']??'';
        // A parent export alone does not pin an ordinary child. Conversion
        // still requires stopped-writer confirmation and confined native checks.
        // Keep export roots, nested exports and other consumers protected.
        if(in_array($command,['deletedirectory','convertdirectory'],true)&&$path!==null&&$used!==''&&in_array($entry['service']??'',['smb','nfs'],true)&&str_starts_with($path,$used.'/'))continue;
        // Read-only monitoring of a parent does not pin every ordinary folder.
        // Exact/nested consumers, writable/unknown modes and mounts still block.
        if($command==='deletedirectory'&&$path!==null&&$used!==''&&($entry['service']??'')==='docker'&&($entry['read_only']??null)===true&&str_starts_with($path,$used.'/'))continue;
        if($used!==''&&($path===null||$path===$used||str_starts_with($path,$used.'/')||str_starts_with($used,$path.'/')))return true;
    }
    foreach($report['entries']??[] as $entry){
        if(!in_array($entry['kind'],['additional_mount','nested_mount'],true))continue;
        $used=$entry['path']??'';if($path===null||$used===$path||str_starts_with($used,$path.'/'))return true;
    }
    return false;
}

function zfsmDependencyMutationGuard($command,$fields) {
    if($command==='cleanupmutation')$command='deletedirectory';
    if(!in_array($command,['renamedataset','destroydataset','movedirectory','convertdirectory','deletedirectory'],true))return;
    $io=zfsmUsageIO();$tool=($io['tool'])('zfs');if(!$tool)return;
    $path=$fields['directory']??null;$name=$fields['zdataset']??'';
    if($path!==null){$resolved=zfsmResolveDirectory($path,true);if(!$resolved)return;$name=$resolved['dataset'];$path=$resolved['path'];}
    if(!zfsmValidDatasetName($name))return;
    $columns=['name','guid','type','mounted','mountpoint'];$read=($io['process'])($tool,['list','-H','-p','-o',implode(',',$columns),$name]);$parts=explode("\t",trim($read['output']??''));
    if(($read['code']??1)!==0||count($parts)!==count($columns))return;
    $properties=array_combine($columns,$parts);if($properties['name']!==$name)return;
    $usage=zfsmReadDatasetUsage($properties,$io);$report=zfsmReadDependencies($properties,$usage,$io);
    if(zfsmDependencyBlocks($report,$command,$path))throw new RuntimeException('Operation blocked by configured service references or additional mounts. Review Usage & Dependencies and release references through their owner; no services were stopped.');
}
