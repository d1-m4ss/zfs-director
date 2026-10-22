<?php
// Embedded in the PLG: only known plugin code/registrations are replaced.
// Director settings, journals and recovery never enter the cleanup list.
function zfsdLegacyPath(string $path,bool $registration=false): void {
    if(!str_starts_with($path,'/')||preg_match('~(?:^|/)\.\.?(/|$)~',$path))throw new RuntimeException('Unsafe installer path');
    for($parent=dirname($path);$parent!=='/';$parent=dirname($parent)){
        if(is_link($parent)||(file_exists($parent)&&!is_dir($parent)))throw new RuntimeException('Unsafe installer parent: '.$parent);
    }
    if(is_link($path)){
        if(!$registration||readlink($path)!=='/boot/config/plugins/'.basename($path))throw new RuntimeException('Unsafe plugin link: '.$path);
    }elseif(file_exists($path)&&!is_file($path)&&!is_dir($path))throw new RuntimeException('Unsafe installer object: '.$path);
}
function zfsdLegacyPlan(string $root,string $keep): array {
    if(!in_array($keep,['zfs-director.plg','zfs.master.ui.plg','zfs.master.ui.local.plg'],true))throw new RuntimeException('Unknown installer registration');
    $root=rtrim($root,'/');$moves=[];$cron=[];
    zfsdLegacyPath($root.'/usr/local/emhttp/plugins/dynamix.plugin.manager/post-hooks/zfs-director');
    $mounts=@file_get_contents($root.'/proc/self/mountinfo');
    if($mounts===false&&$root==='')throw new RuntimeException('Cannot verify legacy directory mount boundaries');
    foreach(explode("\n",(string)$mounts)as$line){
        $fields=explode(' ',$line);if(count($fields)<6)continue;
        $mount=preg_replace_callback('/\\\\([0-7]{3})/',static fn($m)=>chr(octdec($m[1])),$fields[4]);
        foreach(['/usr/local/emhttp/plugins/zfs.master','/usr/local/emhttp/plugins/zfs.master.ui','/boot/config/plugins/zfs.master']as$tree){
            $tree=$root.$tree;if($mount===$tree||str_starts_with($mount,$tree.'/'))throw new RuntimeException('Mounted data inside a plugin directory requires inspection: '.$mount);
        }
    }
    foreach(['zfs.master.plg','zfs-director.plg','zfs.master.ui.plg','zfs.master.ui.local.plg']as$name){
        if($name===$keep)continue;
        foreach(['/boot/config/plugins/','/var/log/plugins/','/boot/config/plugins/zfs.master.ui/']as$folder){
            $p=$root.$folder.$name;zfsdLegacyPath($p,$folder==='/var/log/plugins/');
            if(is_dir($p)&&!is_link($p))throw new RuntimeException('Plugin registration is a directory: '.$p);
            if(file_exists($p)||is_link($p))$moves[]=$p;
        }
    }
    foreach(['/usr/local/emhttp/plugins/zfs.master','/boot/config/plugins/zfs.master']as$folder){
        $p=$root.$folder;zfsdLegacyPath($p);
        if(is_link($p)||(file_exists($p)&&!is_dir($p)))throw new RuntimeException('Unsafe legacy plugin directory: '.$p);
        if(is_dir($p)){
            if(glob($p.'/*.cron'))throw new RuntimeException('Legacy ZFS Master has custom schedules; inspect them before replacing its configuration');
            $moves[]=$p;
        }
    }
    // Obsolete packages are code, not user state. Retain them in the same
    // rollback backup instead of leaving old installers in the state folder.
    foreach(glob($root.'/boot/config/plugins/zfs.master.ui/zfs.master.ui-*.tgz')?:[]as$p){
        if(!preg_match('/^zfs\.master\.ui-[0-9.]+\.tgz$/D',basename($p)))continue;
        zfsdLegacyPath($p);if(!is_file($p)||is_link($p))throw new RuntimeException('Unsafe legacy package: '.$p);$moves[]=$p;
    }
    foreach(['zfs-director','zfs.master.ui','zfs.master.ui.local']as$namespace){
        $p=$root.'/boot/config/plugins/'.$namespace.'/protection.cron';zfsdLegacyPath($p);
        foreach(glob(dirname($p).'/*.cron')?:[]as$other)if($other!==$p)throw new RuntimeException('Custom schedules in an old Director namespace require inspection: '.$other);
        if(is_link($p)||(file_exists($p)&&(!is_file($p)||filesize($p)>1048576)))throw new RuntimeException('Unsafe Director cron source: '.$p);
        if(is_file($p))$cron[$p]=file_get_contents($p);
    }
    $destination=$root.'/boot/config/plugins/'.basename($keep,'.plg').'/protection.cron';
    $selected=null;$active=[];
    foreach($cron as$p=>$text){
        $lines=array_values(array_filter(explode("\n",$text),static fn($line)=>trim($line)!==''&&!str_starts_with(ltrim($line),'#')));
        if($lines)$active[$p]=$text;
    }
    if(count(array_unique($active))>1)throw new RuntimeException('Conflicting Director schedules; no registration or schedule was removed');
    if($active)$selected=array_key_first($active);
    elseif(isset($cron[$destination]))$selected=$destination;
    elseif($cron)$selected=array_key_first($cron);
    foreach($cron as$p=>$text)if($p!==$destination)$moves[]=$p;
    // A different empty destination may be replaced by the existing active
    // source, but is backed up just like every displaced registration.
    if($selected!==null&&$selected!==$destination&&isset($cron[$destination]))$moves[]=$destination;
    return ['moves'=>array_values(array_unique($moves)),'cron_target'=>$destination,'cron_text'=>$selected!==null?$cron[$selected]:null,
            'write_cron'=>$selected!==null&&($cron[$destination]??null)!==$cron[$selected]];
}
function zfsdLegacyProcesses(string $root): array {
    $nchan=[];$legacy=rtrim($root,'/').'/usr/local/emhttp/plugins/zfs.master/';
    foreach(glob(rtrim($root,'/').'/proc/[0-9]*/cmdline')?:[]as$file){
        $args=explode("\0",(string)@file_get_contents($file));$matched=false;
        foreach($args as$arg)if(str_starts_with($arg,$legacy))$matched=true;
        if(!$matched)continue;
        $script=$args[1]??'';if($script==='-q')$script=$args[2]??'';
        if(basename($args[0])!=='php'||$script!==$legacy.'nchan/zfs_master')throw new RuntimeException('An operation from ZFS Master is still running; finish it before installation');
        $nchan[(int)basename(dirname($file))]=(string)file_get_contents($file);
    }
    return $nchan;
}
function zfsdLegacyInstall(string $mode,string $root,string $keep,string $backup): void {
    $root=rtrim($root,'/');
    if($mode==='check'){zfsdLegacyPlan($root,$keep);zfsdLegacyProcesses($root);return;}
    zfsdLegacyPath($backup);
    if($mode==='rollback'){
        $journal=$backup.'/migration.json';if(!is_file($journal))return;
        $state=json_decode(file_get_contents($journal),true,64,JSON_THROW_ON_ERROR);
        if(!empty($state['rolled_back']))return;
        if(isset($state['created_cron'])){
            [$target,$sha]=$state['created_cron'];zfsdLegacyPath($target);
            if(file_exists($target)){
                $restored=false;$current=lstat($target);
                foreach($state['done']as$item)if($item[0]===$target&&[$current['dev'],$current['ino']]===$item[3]&&!file_exists($item[1]))$restored=true;
                if(!$restored){
                    if(is_link($target)||!is_file($target)||hash_file('sha256',$target)!==$sha)throw new RuntimeException('Cron changed after installation; retained backup: '.$backup);
                    if(!unlink($target))throw new RuntimeException('Cannot undo Director cron relocation');
                }
            }
        }
        foreach(array_reverse($state['done'])as$item){
            [$from,$to,$link,$identity]=$item;clearstatcache();
            if(file_exists($from)||is_link($from)){
                $stat=lstat($from);
                if(($link!==null&&is_link($from)&&readlink($from)===$link)||($link===null&&[$stat['dev'],$stat['ino']]===$identity&&!file_exists($to)))continue;
                throw new RuntimeException('Rollback target changed; retained backup: '.$backup);
            }
            if($link!==null){if(!symlink($link,$from))throw new RuntimeException('Cannot restore plugin registration');}
            elseif(!rename($to,$from))throw new RuntimeException('Cannot restore displaced plugin file');
        }
        $state['rolled_back']=true;
        if(file_put_contents($journal.'.tmp',json_encode($state,JSON_THROW_ON_ERROR),LOCK_EX)===false||!rename($journal.'.tmp',$journal))throw new RuntimeException('Cannot record completed rollback');
        return;
    }
    if($mode!=='apply')throw new RuntimeException('Unknown legacy cleanup action');
    $plan=zfsdLegacyPlan($root,$keep);$processes=zfsdLegacyProcesses($root);
    if($processes&&$root!=='')throw new RuntimeException('Process changes require the live system root');
    foreach($processes as$pid=>$cmd){
        if((string)@file_get_contents('/proc/'.$pid.'/cmdline')!==$cmd)throw new RuntimeException('Legacy monitor identity changed');
        if(!posix_kill($pid,15))throw new RuntimeException('Unable to stop the legacy ZFS Master monitor');
    }
    $deadline=microtime(true)+5;
    do{$running=zfsdLegacyProcesses($root);if(!$running)break;usleep(100000);}while(microtime(true)<$deadline);
    if($running)throw new RuntimeException('Legacy ZFS Master monitor has not stopped');
    if(!$plan['moves']&&!$plan['write_cron'])return;
    if(file_exists($backup)||!mkdir($backup,0700,true))throw new RuntimeException('Cannot create legacy plugin backup');
    $state=['done'=>[]];$journal=$backup.'/migration.json';
    $save=static function()use(&$state,$journal){$json=json_encode($state,JSON_PRETTY_PRINT|JSON_THROW_ON_ERROR);if(file_put_contents($journal.'.tmp',$json,LOCK_EX)!==strlen($json)||!rename($journal.'.tmp',$journal))throw new RuntimeException('Cannot save installer rollback journal');};
    $save();
    try{
        foreach($plan['moves']as$i=>$from){
            $link=is_link($from)?readlink($from):null;
            $to=is_dir($from)&&str_starts_with($from,$root.'/usr/local/emhttp/plugins/')?dirname($from).'/.zfs-director-legacy-'.basename($backup).'-'.$i:$backup.'/item-'.$i;
            if(file_exists($to)||is_link($to))throw new RuntimeException('Legacy backup destination exists');
            $stat=lstat($from);$state['done'][]=[$from,$to,$link,[$stat['dev'],$stat['ino']]];$save();
            if($link!==null){if(!unlink($from))throw new RuntimeException('Cannot remove old registration');}
            elseif(!rename($from,$to))throw new RuntimeException('Cannot retain old plugin file');
        }
        if($plan['write_cron']){
            $target=$plan['cron_target'];if(!is_dir(dirname($target))&&!mkdir(dirname($target),0700,true))throw new RuntimeException('Cannot preserve Director cron namespace');
            if(file_exists($target)||is_link($target))throw new RuntimeException('Director cron changed during installation');
            $text=$plan['cron_text'];$state['created_cron']=[$target,hash('sha256',$text)];$save();
            $temporary=tempnam(dirname($target),'.director-cron-');
            if($temporary===false)throw new RuntimeException('Cannot stage Director cron');
            try{if(file_put_contents($temporary,$text,LOCK_EX)!==strlen($text)||!rename($temporary,$target)||file_get_contents($target)!==$text)throw new RuntimeException('Director cron readback failed');}
            finally{if(is_file($temporary))unlink($temporary);}
        }
        echo 'ZFS Director: old ZFS Master code and duplicate registrations removed; rollback backup: '.$backup."\n";
    }catch(Throwable$error){
        zfsdLegacyInstall('rollback',$root,$keep,$backup);throw $error;
    }
}
