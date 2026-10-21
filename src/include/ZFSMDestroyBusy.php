<?php
// Read-only, bounded Linux diagnostics. No nsenter, unmount or workload control.
function zfsmDestroyMountRows($text) {
    $rows=[];$decode=fn($s)=>preg_replace_callback('/\\\\([0-7]{3})/',fn($m)=>chr(octdec($m[1])),$s);
    foreach(explode("\n",trim($text))as$line){$parts=explode(' - ',$line,2);if(count($parts)!==2)continue;$a=explode(' ',$parts[0]);$b=explode(' ',$parts[1]);if(count($a)<6||count($b)<2)continue;$rows[$a[0]]=['id'=>$a[0],'parent'=>$a[1],'root'=>$decode($a[3]),'path'=>$decode($a[4]),'source'=>$decode($b[1]),'fs'=>$b[0]];}
    return $rows;
}

function zfsmDestroyBusyReport($objects,$processes,$self_namespace,$filesystem_mounts=[],$complete=true) {
    $selected=[];foreach($objects as$row)$selected[$row['name']]=$row;
    $blockers=[];$seen=[];
    foreach($processes as$process){
        $mounts=zfsmDestroyMountRows($process['mountinfo']);$foreign=$process['namespace']!==$self_namespace;
        $add=function($mount,$kind)use(&$blockers,&$seen,$process){$key=$process['namespace'].'|'.$mount['id'].'|'.$kind.(in_array($kind,['cwd','open_file'],true)?'|'.$process['pid']:'');if(isset($seen[$key]))return;$seen[$key]=true;$blockers[]=['dataset'=>$mount['source'],'kind'=>$kind,'mountpoint'=>$mount['path'],'namespace'=>$process['namespace'],'pid'=>$process['pid'],'command'=>$process['command'],'container'=>$process['container']??null];};
        $affected=[];
        foreach($mounts as$id=>$mount){
            if($mount['fs']!=='zfs')continue;
            $owner=explode('@',$mount['source'],2)[0];$row=$selected[$mount['source']]??$selected[$owner]??null;if(!$row)continue;
            $affected[$id]=$mount;
            if($foreign)$add($mount,'foreign_mount');
            elseif(str_contains($mount['source'],'@')){
                // Browsing .zfs mounts a snapshot on demand. Its mere presence
                // does not identify a user of it (PID1 is just a namespace
                // representative). Only the single canonical host mount may
                // be left for ZFS's normal destroy/unmount; keep aliases,
                // nested mounts, actual cwd/FDs and foreign namespaces blocked.
                $filesystem=$filesystem_mounts[$owner]??[];$root=rtrim($filesystem['mountpoint']??'','/');
                $primary=array_filter($mounts,fn($m)=>$m['fs']==='zfs'&&$m['source']===$owner&&$m['path']===$root&&$m['root']==='/');
                $instances=array_filter($mounts,fn($m)=>$m['fs']==='zfs'&&$m['source']===$mount['source']);
                $canonical=$complete&&zfsmValidSnapshotName($mount['source'])&&$root!==''&&($filesystem['mounted']??null)==='yes'&&count($primary)===1&&count($instances)===1&&$mount['root']==='/'&&$mount['path']===$root.'/.zfs/snapshot/'.explode('@',$mount['source'],2)[1]&&zfsmLiveZfsMount($root,$owner,$mounts)&&zfsmLiveZfsMount($mount['path'],$mount['source'],$mounts);
                if(!$canonical)$add($mount,'snapshot_mount');
            }
            elseif(($row['mountpoint']??null)!==$mount['path'])$add($mount,'additional_mount');
        }
        foreach($mounts as$id=>$mount){
            if(isset($affected[$id]))continue;
            foreach($affected as$parent)if($mount['path']===$parent['path']||str_starts_with($mount['path'],rtrim($parent['path'],'/').'/')){
                $add(array_replace($mount,['source'=>$parent['source']]),'nested_mount');break;
            }
        }
        if($foreign||!$affected)continue;
        $cwd=$process['cwd']??'';$cwd_mount=null;
        foreach($mounts as$mount)if($cwd===$mount['path']||str_starts_with($cwd,rtrim($mount['path'],'/').'/'))if($cwd_mount===null||strlen($mount['path'])>=strlen($cwd_mount['path']))$cwd_mount=$mount;
        if($cwd_mount&&isset($affected[$cwd_mount['id']]))$add($cwd_mount,'cwd');
        foreach($process['fd_mount_ids']??[]as$id)if(isset($affected[$id]))$add($affected[$id],'open_file');
    }
    return ['blocked'=>(bool)$blockers,'blockers'=>$blockers];
}

function zfsmDestroyParseContainerNames($text) {
    if(!is_string($text)||strlen($text)>262144)return [];
    $text=rtrim($text,"\r\n");if($text==='')return [];$names=[];
    foreach(preg_split('/\r\n|\r|\n/',$text)as$line){
        if(preg_match('/^([a-f0-9]{64}) ([A-Za-z0-9][A-Za-z0-9_.-]{0,254})$/D',$line,$match)!==1||isset($names[$match[1]]))return [];
        $names[$match[1]]=$match[2];
    }
    return $names;
}

// This optional lookup has its own budget and never reads inspect/env payloads.
function zfsmDestroyReadContainerNames() {
    $process=null;$pipes=[];$complete=false;$output='';$exit_code=null;$deadline=microtime(true)+1.0;
    try{
        $process=@proc_open(['docker','ps','--no-trunc','--format','{{.ID}} {{.Names}}'],[0=>['file','/dev/null','r'],1=>['pipe','w'],2=>['file','/dev/null','w']],$pipes,null,null,['bypass_shell'=>true]);
        if(!is_resource($process))return [];
        if(!stream_set_blocking($pipes[1],false))return [];
        while(microtime(true)<$deadline){
            $read=[$pipes[1]];$write=null;$except=null;
            if(@stream_select($read,$write,$except,0,50000)===false)return [];
            if($read){$chunk=fread($pipes[1],65536);if($chunk===false)return [];$output.=$chunk;if(strlen($output)>262144)return [];}
            $status=proc_get_status($process);
            if(!$status['running']){if($exit_code===null)$exit_code=$status['exitcode'];if(feof($pipes[1])){$complete=true;break;}}
        }
        return $complete&&$exit_code===0?zfsmDestroyParseContainerNames($output):[];
    }catch(Throwable$error){return [];}
    finally{
        // Terminate only this optional CLI child when its budget is exhausted.
        if(is_resource($process)&&!$complete)@proc_terminate($process,9);
        foreach($pipes as$pipe)if(is_resource($pipe))@fclose($pipe);
        if(is_resource($process))@proc_close($process);
    }
}

function zfsmDestroyNameContainers($report) {
    $lookup=false;foreach($report['blockers']??[]as$row)if(is_string($row['container']??null)&&preg_match('/^[a-f0-9]{64}$/D',$row['container'])===1){$lookup=true;break;}
    if(!$lookup)return $report;
    try{$names=zfsmDestroyReadContainerNames();}catch(Throwable$error){$names=[];}
    foreach($report['blockers']as&$row)if(isset($names[$row['container']??'']))$row['container_name']=$names[$row['container']];
    unset($row);return $report;
}

function zfsmDestroyBusyDiagnostics($objects) {
    $self=@readlink('/proc/self/ns/mnt');$processes=[];$namespaces=[];$warnings=[];
    if(!is_string($self))return ['blocked'=>false,'blockers'=>[],'complete'=>false,'warnings'=>['Linux mount namespace diagnostics are unavailable. A successful dry run does not prove the dataset is unused.']];
    $deadline=microtime(true)+1.5;$fd_count=0;$count=0;
    foreach(@scandir('/proc')?:[]as$pid){
        if(!ctype_digit($pid))continue;
        if(++$count>16384||microtime(true)>$deadline){$warnings[]='Process scan limit reached; diagnostics are incomplete.';break;}
        $base='/proc/'.$pid;$ns=@readlink($base.'/ns/mnt');
        if(!is_string($ns)){if(is_dir($base))$warnings[]='A process namespace could not be read.';continue;}
        if(!isset($namespaces[$ns])){
            $text=@file_get_contents($base.'/mountinfo',false,null,0,2097153);
            if(!is_string($text)||strlen($text)>2097152){if(is_dir($base))$warnings[]='A mount table could not be read within limits.';continue;}
            $namespaces[$ns]=$text;
        }
        $row=['pid'=>(int)$pid,'namespace'=>$ns,'command'=>trim((string)@file_get_contents($base.'/comm',false,null,0,64)),'mountinfo'=>$namespaces[$ns],'container'=>null,'cwd'=>@readlink($base.'/cwd')?:'','fd_mount_ids'=>[]];
        $cgroup=@file_get_contents($base.'/cgroup',false,null,0,4096);if(is_string($cgroup)&&preg_match('~(?:/docker/|docker-)([a-f0-9]{64})(?:/|\.|$)~m',$cgroup,$m))$row['container']=$m[1];
        if($ns===$self){
            $has_target=false;foreach(zfsmDestroyMountRows($namespaces[$ns])as$mount)foreach($objects as$object)if($mount['fs']==='zfs'&&($mount['source']===$object['name']||str_starts_with($mount['source'],$object['name'].'@'))){$has_target=true;break 2;}
            if($has_target){$fds=@scandir($base.'/fdinfo');if($fds===false&&is_dir($base))$warnings[]='Some process file references could not be inspected.';
                foreach($fds?:[]as$fd){if(!ctype_digit($fd))continue;if(++$fd_count>50000||microtime(true)>$deadline){$warnings[]='File reference scan limit reached; diagnostics are incomplete.';break;}$info=@file_get_contents($base.'/fdinfo/'.$fd,false,null,0,4096);if(is_string($info)&&preg_match('/^mnt_id:\s*(\d+)/m',$info,$m))$row['fd_mount_ids'][]=$m[1];elseif(is_file($base.'/fdinfo/'.$fd))$warnings[]='Some process file references could not be inspected.';}
            }
        }
        $processes[]=$row;
    }
    $filesystems=[];$selected=array_fill_keys(array_column($objects,'name'),true);
    foreach($namespaces as$text)foreach(zfsmDestroyMountRows($text)as$mount)if(str_contains($mount['source'],'@')&&(isset($selected[$mount['source']])||isset($selected[explode('@',$mount['source'],2)[0]]))){
        try{$filesystems=zfsmFilesystemMounts();}catch(Throwable$error){$warnings[]='Snapshot mount ownership could not be verified; mounted snapshots remain protected.';}break 2;
    }
    return zfsmDestroyNameContainers(zfsmDestroyBusyReport($objects,$processes,$self,$filesystems,!$warnings))+['complete'=>!$warnings,'warnings'=>array_values(array_unique($warnings)),'processes_scanned'=>$count,'namespaces_scanned'=>count($namespaces)];
}

function zfsmDestroyBlockedAnswer($scope,$diagnostics) {
    $answer=zfsmFailure($scope['target'],'Deletion blocked by live filesystem references. Release the reported application references or mounts through their owner, then load a fresh preview. No deletion was attempted.');
    $answer['destruction']=['attempted'=>false,'diagnostics'=>$diagnostics,'state_verified'=>false,'removed'=>[],'remaining'=>array_column($scope['objects'],'name')];
    return $answer;
}
