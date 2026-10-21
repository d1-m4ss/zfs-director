<?php
require_once __DIR__.'/ZFSMUsageOwnership.php';
/* Optional read-only host metadata. No service output is logged or returned raw. */
function zfsmUsageResult($status, $reason = '', $entries = null) {
    return ['status'=>$status, 'entries'=>$entries, 'reason'=>$reason];
}

function zfsmUsageTool($name) {
    $paths = ['zfs'=>['/usr/sbin/zfs','/sbin/zfs','/usr/bin/zfs'], 'docker'=>['/usr/bin/docker','/usr/local/bin/docker'], 'virsh'=>['/usr/bin/virsh','/usr/sbin/virsh'], 'getfacl'=>['/usr/bin/getfacl','/bin/getfacl']];
    $paths['getfattr']=['/usr/bin/getfattr','/bin/getfattr'];
    $paths['setfacl']=['/usr/bin/setfacl','/bin/setfacl'];
    foreach ($paths[$name] ?? [] as $path) {
        $resolved=realpath($path);if($resolved===false||!is_executable($resolved))continue;
        $stat=@lstat($resolved);if(!$stat||($stat['mode']&0170000)!==0100000||(int)$stat['uid']!==0||($stat['mode']&0022)!==0)continue;
        $trusted=true;
        for($parent=dirname($resolved);; $parent=dirname($parent)){
            $stat=@lstat($parent);if(!$stat||($stat['mode']&0170000)!==0040000||(int)$stat['uid']!==0||($stat['mode']&0022)!==0){$trusted=false;break;}
            if($parent==='/')break;
        }
        if($trusted)return $resolved;
    }
    return null;
}

// Bound stdout + stderr together, wall time and argv; never invoke a shell.
function zfsmUsageProcess($tool, $args, $deadline) {
    if (!is_string($tool) || !is_array($args) || count($args)>140 || microtime(true)>=$deadline) return ['code'=>-1,'output'=>''];
    $pipes=[]; $process=@proc_open(array_merge([$tool], $args), [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']], $pipes, null, null, ['bypass_shell'=>true]);
    if (!is_resource($process)) return ['code'=>-1,'output'=>''];
    fclose($pipes[0]); stream_set_blocking($pipes[1],false); stream_set_blocking($pipes[2],false);
    $output=''; $size=0; $code=-1;
    try {
        while (true) {
            foreach ([1,2] as $index) {
                $chunk=fread($pipes[$index],65536);
                if ($chunk===false) throw new RuntimeException('Read failed');
                $size+=strlen($chunk);
                if ($size>524288) throw new RuntimeException('Output limit');
                if ($index===1) $output.=$chunk;
            }
            $state=proc_get_status($process);
            if (!$state['running']) { $code=$state['exitcode']; break; }
            if (microtime(true)>=$deadline) throw new RuntimeException('Metadata deadline');
            usleep(10000);
        }
        foreach ([1,2] as $index) {
            $tail=stream_get_contents($pipes[$index],524289-$size);
            if ($tail===false) throw new RuntimeException('Read failed');
            $size+=strlen($tail); if ($size>524288) throw new RuntimeException('Output limit');
            if ($index===1) $output.=$tail;
        }
    } catch (Throwable $error) { @proc_terminate($process,9); $code=-1; $output=''; }
    finally { fclose($pipes[1]);fclose($pipes[2]);$closed=proc_close($process);if($code<0&&$output!=='')$code=$closed; }
    return ['code'=>$code,'output'=>$output];
}

function zfsmUsageReadFile($path) {
    if (!file_exists($path)) return ['status'=>'unavailable','reason'=>'Generated service configuration is unavailable'];
    if (zfsmPathHasSymlink($path) || realpath($path)!==$path) return ['status'=>'error','reason'=>'Service configuration path is not trusted'];
    clearstatcache(true,$path); $stat=@lstat($path);
    if (!$stat || ($stat['mode']&0170000)!==0100000 || $stat['size']>524288) return ['status'=>'error','reason'=>'Service configuration exceeds the read limit or is not a regular file'];
    $handle=@fopen($path,'rb'); if (!$handle) return ['status'=>'error','reason'=>'Service configuration cannot be read'];
    try { $opened=fstat($handle);$content=stream_get_contents($handle,524289); }
    finally { fclose($handle); }
    if (!$opened || $opened['dev']!==$stat['dev'] || $opened['ino']!==$stat['ino'] || !is_string($content) || strlen($content)>524288 || zfsmPathHasSymlink($path)) return ['status'=>'error','reason'=>'Service configuration changed or exceeded its read limit'];
    return ['status'=>'known','content'=>$content];
}

function zfsmUsageMounts() {return zfsmUsageParseMounts(@file_get_contents('/proc/self/mountinfo',false,null,0,524289));}
function zfsmUsageParseMounts($text) {
    if(!is_string($text)||$text===''||strlen($text)>524288)return [];
    $mounts=[];
    $decode=fn($value)=>preg_replace_callback('/\\\\([0-7]{3})/',fn($match)=>chr(octdec($match[1])),$value);
    foreach(explode("\n",rtrim($text,"\n")) as $line){
        $halves=explode(' - ',$line,2);if(count($halves)!==2)return [];
        $left=explode(' ',$halves[0]);$right=explode(' ',$halves[1]);
        if(count($left)<6||count($right)<2||!ctype_digit($left[0])||!ctype_digit($left[1]))return [];
        $access=array_values(array_intersect(explode(',',$left[5]),['ro','rw']));
        $mounts[]=['id'=>$left[0],'parent'=>$left[1],'root'=>$decode($left[3]),'path'=>rtrim($decode($left[4]),'/')?:'/','fs'=>$right[0],'source'=>$decode($right[1]),'read_only'=>count($access)===1?$access[0]==='ro':null];
        if(count($mounts)>4096)return [];
    }
    return $mounts;
}

function zfsmUsageIO($overrides = []) {
    $deadline=min(microtime(true)+4.0, $GLOBALS['zfsm_inventory_deadline'] ?? INF, $overrides['deadline'] ?? INF);
    return array_replace(['deadline'=>$deadline,'tool'=>'zfsmUsageTool','read'=>'zfsmUsageReadFile','realpath'=>'realpath','stat'=>fn($p)=>@lstat($p),'mounts'=>'zfsmUsageMounts','process'=>fn($tool,$args)=>zfsmUsageProcess($tool,$args,$deadline)],$overrides,['deadline'=>$deadline]);
}

function zfsmUsageHasTime($io) {
    return microtime(true)<($io['deadline']??0);
}

function zfsmUsageLexicalPath($path) {
    if (!is_string($path) || strlen($path)>4096 || !str_starts_with($path,'/') || $path==='/' || preg_match('/[\x00-\x1F\x7F]/',$path)) return false;
    foreach(explode('/',substr($path,1)) as $part)if($part===''||$part==='.'||$part==='..')return false;
    return true;
}

function zfsmUsageSafePath($path) {
    return zfsmUsageLexicalPath($path) && !zfsmPathHasSymlink($path) && realpath($path)===$path;
}

function zfsmUsageVerifyDataset($properties, $io) {
    if(!zfsmUsageHasTime($io))return false;
    if (($properties['type']??'')!=='filesystem' || ($properties['mounted']??'')!=='yes' || ($properties['keystatus']??'')==='unavailable' || !preg_match('/^[1-9][0-9]{0,19}$/D',(string)($properties['guid']??''))) return false;
    $path=$properties['mountpoint']??null; $name=$properties['name']??'';
    if (!preg_match('/^[A-Za-z][A-Za-z0-9_.: -]*(?:\/[A-Za-z0-9_.: -]+)*$/D',$name) || !zfsmUsageLexicalPath($path) || !zfsmLiveZfsMount($path,$name,($io['mounts'])()) || !zfsmUsageSafePath($path) || !is_dir($path)) return false;
    $tool=($io['tool'])('zfs'); if (!$tool) return false;
    $result=($io['process'])($tool,['list','-H','-p','-o','name,guid,type,mounted,mountpoint',$name]);
    $expected=implode("\t",[$name,(string)$properties['guid'],'filesystem','yes',$path]);
    return ($result['code']??-1)===0 && rtrim($result['output']??'',"\r\n")===$expected && zfsmUsageSafePath($path) && zfsmLiveZfsMount($path,$name,($io['mounts'])());
}

// A matching textual prefix is insufficient: resolve the deepest live mount.
// Unraid /mnt/user FUSE aliases cannot prove which pool owns a particular file.
function zfsmUsageVisibleMount($mount, $mounts) {
    $same=0;$byId=[];
    foreach($mounts as $row){if($row['path']===$mount['path'])$same++;if(isset($byId[$row['id']]))return false;$byId[$row['id']]=$row;}
    if($same!==1)return false;
    $ancestors=[];$current=$mount;
    while($current&&!isset($ancestors[$current['id']])){$ancestors[$current['id']]=true;$current=$byId[$current['parent']]??null;}
    foreach($mounts as $row)if(($row['path']==='/'||str_starts_with($mount['path'],$row['path'].'/'))&&!isset($ancestors[$row['id']]))return false;
    return true;
}

function zfsmUsagePathOwner($path, $io) {
    if (!zfsmUsageHasTime($io) || !zfsmUsageLexicalPath($path)) return null;
    $mounts=($io['mounts'])(); $candidates=[];
    foreach ($mounts as $mount) if ($mount['path']==='/' || $path===$mount['path'] || str_starts_with($path,$mount['path'].'/')) $candidates[]=$mount;
    usort($candidates,fn($a,$b)=>strlen($b['path'])<=>strlen($a['path']));
    if (!$candidates || !zfsmUsageVisibleMount($candidates[0],$mounts)) return null;
    if($candidates[0]['fs']!=='zfs') {
        // Only canonical paths on known local filesystems prove unrelatedness.
        // FUSE, network mounts and symlink aliases retain unresolved status.
        return in_array($candidates[0]['fs'],['tmpfs','ramfs','rootfs','overlay','ext2','ext3','ext4','xfs','btrfs','squashfs'],true)&&zfsmUsageSafePath($path)?false:null;
    }
    if(!zfsmLiveZfsMount($candidates[0]['path'],$candidates[0]['source'],$mounts)||!zfsmUsageSafePath($path))return null;
    return $candidates[0]['source'];
}

function zfsmUsageLabel($value) {
    return is_string($value) && $value!=='' && strlen($value)<=255 && !preg_match('/[\x00-\x1F\x7F]/',$value);
}

function zfsmUsageSMBPaths($text) {
    $entries=[]; $name=null; $sectionPaths=[];
    foreach (preg_split('/\r\n|\r|\n/',$text) as $line) {
        $line=trim($line); if ($line==='' || $line[0]==='#' || $line[0]===';') continue;
        if (preg_match('/^\[([^\]]+)\]$/D',$line,$match)) { $name=$match[1];if(!zfsmUsageLabel($name)||isset($sectionPaths[$name]))return null;$sectionPaths[$name]=false;continue; }
        if (!preg_match('/^([^=]+)=(.*)$/D',$line,$match)) return null;
        $key=strtolower(trim($match[1])); $value=trim($match[2]);
        // Includes and variable expansion are not interpreted as verified paths.
        if ($key==='include' || $key==='copy') return null;
        if ($key!=='path') continue;
        if ($name===null || strtolower($name)==='global' || $sectionPaths[$name] || str_contains($value,'%')) return null;
        if (strlen($value)>1 && $value[0]==='"' && substr($value,-1)==='"') $value=substr($value,1,-1);
        $sectionPaths[$name]=true;$entries[]=['name'=>$name,'path'=>rtrim($value,'/')];
        if (count($entries)>512) return null;
    }
    return $entries;
}

function zfsmUsageNFSPaths($text) {
    $entries=[];
    foreach (preg_split('/\r\n|\r|\n/',$text) as $line) {
        $line=trim($line); if($line===''||$line[0]==='#')continue;
        if (!preg_match('/^(?:"([^"\r\n]+)"|([^\s]+))\s+[^\r\n]+$/D',$line,$match)) return null;
        $path=($match[1]??'')!==''?$match[1]:$match[2];
        $path=preg_replace_callback('/\\\\([0-7]{3})/',fn($m)=>chr(octdec($m[1])),$path);
        if (str_contains($path,'\\')) return null;
        $entries[]=['name'=>'NFS export','path'=>rtrim($path,'/')];if(count($entries)>512)return null;
    }
    return $entries;
}

function zfsmUsageMatchEntries($entries, $properties, $io) {
    $matched=[]; $unresolved=0; $potential_ancestor=false;
    foreach ($entries as $entry) {
        if(!zfsmUsageHasTime($io))return zfsmUsageResult('unknown','Read-only service discovery exceeded its time budget',$matched);
        if(($properties['type']??null)==='volume'){$proof=zfsmUsageZvolReference($entry,$properties,$io);if($proof!==null)$matched[]=$proof;else$unresolved++;continue;}
        $path=$entry['path']??null;
        if(is_string($path)&&str_starts_with($path,'/mnt/user/')){$resolved=zfsmUsageUserPath($path,$io);if($resolved===null){$unresolved++;continue;}$entry['configured_path']=$path;$entry['path']=$resolved;$entry['evidence']='verified_user_share_location';}
        $owner=zfsmUsagePathOwner($entry['path']??null,$io);
        if ($owner===null) {$unresolved++;continue;}
        if (is_string($properties['mountpoint']??null) && str_starts_with($properties['mountpoint'],$entry['path'].'/')) {
            if($exposure=zfsmUsageAncestorExposure($entry,$properties,$io)){$entry['configured_path']=$entry['path'];$entry['path']=$properties['mountpoint'];$entry['evidence']='container_mountinfo';$entry['read_only']=$exposure['read_only']??null;$matched[]=$entry;}else{$unresolved++;$potential_ancestor=true;}continue;
        }
        if ($owner===$properties['name']) $matched[]=$entry;
    }
    $reason=$potential_ancestor?'A configured ancestor path may include this dataset; descendant coverage is unverified':($unresolved?'Some configured paths could not be assigned to a verified ZFS mount':'');
    return zfsmUsageResult($unresolved?'unknown':'known',$reason,$matched);
}

function zfsmUsageConfig($path, $parser, $properties, $io) {
    $file=($io['read'])($path);
    if (($file['status']??'error')!=='known') return zfsmUsageResult($file['status']??'error',$file['reason']??'Service configuration cannot be read');
    if (!is_string($file['content']??null) || strlen($file['content'])>524288) return zfsmUsageResult('error','Service configuration exceeds its read limit');
    $entries=$parser($file['content']);
    return $entries===null?zfsmUsageResult('unknown','Service configuration contains unsupported or ambiguous syntax'):zfsmUsageMatchEntries($entries,$properties,$io);
}

function zfsmUsageDocker($properties, $io) {
    $tool=($io['tool'])('docker');if(!$tool)return zfsmUsageResult('unavailable','Trusted Docker client is unavailable');
    $ids=($io['process'])($tool,['container','ls','--all','--quiet','--no-trunc']);
    if (($ids['code']??-1)!==0) return zfsmUsageResult('error','Docker container inventory failed or exceeded its read limit');
    $ids=preg_split('/\s+/',trim($ids['output']??''),-1,PREG_SPLIT_NO_EMPTY);
    if (!$ids) return zfsmUsageResult('known','',[]);
    if (count($ids)>64 || count(array_unique($ids))!==count($ids)) return zfsmUsageResult('unknown','Docker container inventory exceeds the supported limit');
    foreach($ids as $id)if(!preg_match('/^[a-f0-9]{64}$/D',$id))return zfsmUsageResult('error','Docker container inventory is malformed');
    $format='{"name":{{json .Name}},"state":{{json .State.Status}},"pid":{{json .State.Pid}},"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"source":{{json $m.Source}},"destination":{{json $m.Destination}},"type":{{json $m.Type}},"rw":{{json $m.RW}}}{{end}}]}';
    $result=($io['process'])($tool,array_merge(['container','inspect','--format',$format],$ids));
    if (($result['code']??-1)!==0) return zfsmUsageResult('error','Docker mount inspection failed or exceeded its read limit');
    $lines=preg_split('/\r\n|\r|\n/',rtrim($result['output']??'',"\r\n"));
    if (count($lines)!==count($ids)) return zfsmUsageResult('error','Docker mount inspection is incomplete');
    $entries=[];
    foreach($lines as $line) {
        $row=json_decode($line,true,16);
        if (!is_array($row) || !zfsmUsageLabel($row['name']??null) || !in_array($row['state']??'', ['created','running','paused','restarting','removing','exited','dead'],true) || !is_array($row['mounts']??null) || count($row['mounts'])>512) return zfsmUsageResult('error','Docker mount inspection is malformed');
        foreach($row['mounts'] as $mount) {
            if (!is_array($mount)||!in_array($mount['type']??'', ['bind','volume','tmpfs','npipe','cluster','image'],true)) return zfsmUsageResult('error','Docker mount inspection is malformed');
            if (in_array($mount['type'],['tmpfs','npipe'],true)) continue;
            if (!zfsmUsageLabel($mount['destination']??null)||!is_string($mount['source']??null)) return zfsmUsageResult('error','Docker mount inspection is malformed');
            $entry=['name'=>ltrim($row['name'],'/'),'state'=>$row['state'],'path'=>$mount['source'],'destination'=>$mount['destination'],'read_only'=>is_bool($mount['rw']??null)?!$mount['rw']:null];if(is_int($row['pid']??null)&&$row['pid']>0)$entry['namespace_pid']=(string)$row['pid'];$entries[]=$entry;
        }
    }
    return zfsmUsageMatchEntries($entries,$properties,$io);
}

function zfsmUsageVMPaths($xml, $name) {
    if (!class_exists('DOMDocument') || strlen($xml)>524288 || preg_match('/<!DOCTYPE|<!ENTITY/i',$xml)) return null;
    $previous=libxml_use_internal_errors(true);
    try {
        $document=new DOMDocument();$document->resolveExternals=false;$document->substituteEntities=false;
        if (!$document->loadXML($xml,LIBXML_NONET) || $document->doctype || $document->documentElement->nodeName!=='domain') return null;
        $xpath=new DOMXPath($document);$entries=[];
        foreach($xpath->query('/domain/devices/disk/source | /domain/devices/disk/backingStore//source') as $source) {
            $attributes=0;foreach(['file','dev','dir'] as $attribute)if($source->hasAttribute($attribute))$attributes++;
            if($attributes>1)return null;
            $path=$source->getAttribute('file')?:$source->getAttribute('dev')?:$source->getAttribute('dir');
            if ($path==='') {if($source->attributes->length>0)$entries[]=['name'=>$name,'path'=>''];continue;}
            $entries[]=['name'=>$name,'path'=>$path];if(count($entries)>512)return null;
        }
        return $entries;
    } finally {libxml_clear_errors();libxml_use_internal_errors($previous);}
}

function zfsmUsageVM($properties, $io) {
    $tool=($io['tool'])('virsh');if(!$tool)return zfsmUsageResult('unavailable','Trusted Libvirt client is unavailable');
    if (!class_exists('DOMDocument')) return zfsmUsageResult('unavailable','Safe VM XML parser is unavailable');
    $result=($io['process'])($tool,['--readonly','--connect','qemu:///system','list','--all','--name']);
    if (($result['code']??-1)!==0)return zfsmUsageResult('error','VM inventory failed or exceeded its read limit');
    $names=preg_split('/\r\n|\r|\n/',trim($result['output']??''),-1,PREG_SPLIT_NO_EMPTY);
    if(count($names)>32||count(array_unique($names))!==count($names))return zfsmUsageResult('unknown','VM inventory exceeds the supported limit');
    $entries=[];
    foreach($names as $name) {
        if(!zfsmUsageHasTime($io))return zfsmUsageResult('unknown','Read-only VM discovery exceeded its time budget');
        if(!zfsmUsageLabel($name)||str_starts_with($name,'-'))return zfsmUsageResult('error','VM inventory is malformed');
        $result=($io['process'])($tool,['--readonly','--connect','qemu:///system','dumpxml',$name]);
        if (($result['code']??-1)!==0)return zfsmUsageResult('error','VM disk inspection failed or exceeded its read limit');
        $paths=zfsmUsageVMPaths($result['output']??'',$name);
        if($paths===null)return zfsmUsageResult('error','VM disk XML is unsupported or malformed');
        $entries=array_merge($entries,$paths);
        if(count($entries)>512)return zfsmUsageResult('unknown','VM disk inventory exceeds the supported limit');
    }
    return zfsmUsageMatchEntries($entries,$properties,$io);
}

function zfsmReadDatasetUsage($properties, $overrides = []) {
    $io=zfsmUsageIO($overrides);$unknown=zfsmUsageResult('unknown','Usage requires the current identity of a verified mounted ZFS filesystem');
    $answer=array_fill_keys(['smb','nfs','docker','vm'],$unknown);
    try {
        if(!zfsmUsageHasTime($io))return array_fill_keys(array_keys($answer),zfsmUsageResult('unknown','Read-only service metadata time budget is exhausted'));
        if(($properties['type']??null)==='volume'){if(!zfsmUsageVerifyVolume($properties,$io))return $answer;$answer=array_fill_keys(array_keys($answer),zfsmUsageResult('unavailable','A zvol is a block device, not a mounted filesystem'));$answer['vm']=zfsmUsageVM($properties,$io);return zfsmUsageVerifyVolume($properties,$io)?$answer:array_fill_keys(array_keys($answer),$unknown);}
        if (!zfsmUsageVerifyDataset($properties,$io)) return $answer;
        $answer['smb']=zfsmUsageConfig('/etc/samba/smb-shares.conf','zfsmUsageSMBPaths',$properties,$io);
        $answer['nfs']=zfsmUsageConfig('/etc/exports','zfsmUsageNFSPaths',$properties,$io);
        $answer['docker']=zfsmUsageDocker($properties,$io);
        $answer['vm']=zfsmUsageVM($properties,$io);
        if(!zfsmUsageHasTime($io))return array_fill_keys(array_keys($answer),zfsmUsageResult('unknown','Read-only service metadata time budget is exhausted'));
        if (!zfsmUsageVerifyDataset($properties,$io)) return array_fill_keys(array_keys($answer),$unknown);
    } catch (Throwable $error) { return array_fill_keys(array_keys($answer),zfsmUsageResult('error','Read-only service metadata could not be verified')); }
    return $answer;
}
