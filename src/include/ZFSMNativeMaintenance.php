<?php
// Evidence and nominal next match only. Never install, alter or execute cron.
function zfsmNativeCronEvidence($file): array {
    $unknown=['status'=>'unknown','timezone'=>'Unknown'];$host=@stat('/');$daemons=[];$paths=glob('/proc/[0-9]*/comm')?:[];if(count($paths)>4096)return $unknown;
    foreach($paths as$p){if(trim(@file_get_contents($p,false,null,0,64)?:'')!=='crond')continue;$base=dirname($p);$root=@stat($base.'/root');if(!$root||!$host||$root['dev']!==$host['dev']||$root['ino']!==$host['ino'])continue;
        $exe=realpath($base.'/exe');if(!in_array($exe,['/usr/sbin/crond','/sbin/crond'],true))continue;$a=@stat($base.'/exe');$b=@stat($exe);if(!$a||!$b||$a['dev']!==$b['dev']||$a['ino']!==$b['ino']||$b['uid']!==0||($b['mode']&0022)!==0)return $unknown;
        $raw=@file_get_contents($base.'/cmdline',false,null,0,8193);$env=@file_get_contents($base.'/environ',false,null,0,65537);if(!is_string($raw)||strlen($raw)>8192||!is_string($env)||strlen($env)>65536)return $unknown;
        // Unraid's dcron reads both directories; -c changes only the user spool,
        // while -s changes the system directory used by update_cron.
        $args=explode("\0",$raw);$directories=['-c'=>'/var/spool/cron/crontabs','-s'=>'/etc/cron.d'];
        for($i=1;$i<count($args);$i++){foreach(['-c','-s']as$option){if($args[$i]===$option){$directories[$option]=$args[++$i]??'';break;}if(str_starts_with($args[$i],$option)&&strlen($args[$i])>2){$directories[$option]=substr($args[$i],2);break;}}}
        if(!in_array(dirname($file),array_map(fn($directory)=>rtrim($directory,'/'),$directories),true))continue;$tz=null;foreach(explode("\0",$env)as$v)if(str_starts_with($v,'TZ='))$tz=substr($v,3);$daemons[]=$tz;
    }
    if(count($daemons)!==1)return $unknown;$zone=$daemons[0];
    if($zone===null){$target=realpath('/etc/localtime');if(!is_string($target)||!str_starts_with($target,'/usr/share/zoneinfo/'))return $unknown;$zone=substr($target,strlen('/usr/share/zoneinfo/'));}
    $zone=ltrim($zone,':');if(!preg_match('~^[A-Za-z0-9_+/-]+$~D',$zone)||str_contains($zone,'..')||!is_file('/usr/share/zoneinfo/'.$zone))return $unknown;
    try{new DateTimeZone($zone);}catch(Throwable$e){return $unknown;}
    return ['status'=>'verified','timezone'=>$zone,'source'=>'host crond environment / system localtime'];
}
function zfsmCronField($text,$min,$max,$aliases=[]): ?array {
    if(!is_string($text)||strlen($text)>128)return null;$text=strtolower($text);$text=preg_replace_callback('/[a-z]+/',fn($m)=>isset($aliases[$m[0]])?(string)$aliases[$m[0]]:'invalid',$text);$values=[];
    foreach(explode(',',$text)as$part){if(!preg_match('/^(\*|[0-9]+(?:-[0-9]+)?)(?:\/([1-9][0-9]*))?$/D',$part,$m))return null;$step=isset($m[2])?(int)$m[2]:1;if($step>($max-$min+1))return null;
        if($m[1]==='*'){[$start,$end]=[$min,$max];}else{$range=explode('-',$m[1]);$start=(int)$range[0];$end=(int)($range[1]??$range[0]);}
        if($start<$min||$end>$max||$end<$start)return null;for($n=$start;$n<=$end;$n+=$step)$values[$n]=true;
    }
    return $values?:null;
}
function zfsmNativeCronNext($expression,$timezone,$now): ?string {
    $f=preg_split('/\s+/',trim($expression));if(count($f)!==5)return null;
    $minutes=zfsmCronField($f[0],0,59);$hours=zfsmCronField($f[1],0,23);$days=zfsmCronField($f[2],1,31);$months=zfsmCronField($f[3],1,12,array_combine(['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'],range(1,12)));$week=zfsmCronField($f[4],0,7,array_combine(['sun','mon','tue','wed','thu','fri','sat'],range(0,6)));
    if(!$minutes||!$hours||!$days||!$months||!$week)return null;if(isset($week[7])){$week[0]=true;unset($week[7]);}
    // dcron treats dual restricted days as ordinal weekdays; Vixie cron uses
    // different semantics. Unsupported combinations must never be guessed.
    if(count($days)<31&&count($week)<7)return null;
    try{$zone=new DateTimeZone($timezone);$local=(new DateTimeImmutable('@'.$now))->setTimezone($zone);$day=new DateTimeImmutable($local->format('Y-m-d'),new DateTimeZone('UTC'));}catch(Throwable$e){return null;}
    for($i=0;$i<1830;$i++,$day=$day->modify('+1 day')){
        if(!isset($months[(int)$day->format('n')],$days[(int)$day->format('j')],$week[(int)$day->format('w')]))continue;$offsets=[];$transitions=$zone->getTransitions($day->getTimestamp()-172800,$day->getTimestamp()+172800);foreach($transitions?:[]as$t)$offsets[$t['offset']]=true;if(!$offsets)$offsets[$zone->getOffset($day)]=true;$next=null;
        foreach(array_keys($hours)as$hour)foreach(array_keys($minutes)as$minute){$wall=$day->format('Y-m-d').' '.sprintf('%02d:%02d',$hour,$minute);$utc=$day->getTimestamp()+$hour*3600+$minute*60;foreach(array_keys($offsets)as$offset){$candidate=$utc-$offset;if($candidate<=$now)continue;$actual=(new DateTimeImmutable('@'.$candidate))->setTimezone($zone);if($actual->format('Y-m-d H:i')===$wall&&($next===null||$candidate<$next))$next=$candidate;}}
        if($next!==null)return gmdate('Y-m-d\TH:i:s\Z',$next);
    }
    return null;
}
