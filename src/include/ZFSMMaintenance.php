<?php
function zfsmProtectionCurrentVerification($verification,$now=null) {
    $now=$now??time();$creation=[];
    if(($verification['verified']??false)===true)foreach($verification['checkpoints']??[] as $checkpoint){if(!is_numeric($checkpoint['creation']??null)||$checkpoint['creation']<=0){$creation=[];break;}$creation[]=(int)$checkpoint['creation'];}
    $verification['lag_seconds']=$creation?max(0,$now-min($creation)):null;return $verification;
}
function zfsmMaintenanceEvaluate($diagnostic,$config,$lagAlerts=[]) {
    $quality=$diagnostic['severity']??'unknown';
    $diagnostic['capacity']=['status'=>'unknown','percent'=>null];$native=null;
    foreach($diagnostic['information']['rows']??[] as $row)if(($row['name']??'')===($diagnostic['pool']??''))$native=$row;
    $warning=(int)($config['space_warning_percent']??80);$critical=(int)($config['space_critical_percent']??90);
    if($native&&ctype_digit((string)($native['size']??''))&&ctype_digit((string)($native['alloc']??''))&&(float)$native['size']>0&&(float)$native['alloc']<=(float)$native['size']){
        $percent=round((float)$native['alloc']/(float)$native['size']*100,1);$diagnostic['capacity']=['status'=>'known','percent'=>$percent,'warning'=>$warning,'critical'=>$critical];
        if($percent>=$critical){if($quality!=='unknown')$diagnostic['severity']='error';$diagnostic['reasons'][]='Pool capacity is at or above the critical threshold ('.$critical.'%).';}
        elseif($percent>=$warning){if(!in_array($quality,['error','unknown'],true))$diagnostic['severity']='warning';$diagnostic['reasons'][]='Pool capacity is at or above the warning threshold ('.$warning.'%).';}
    }
    foreach($lagAlerts as $alert){
        $reason=is_array($alert)?$alert['text']:$alert;
        if(!in_array($diagnostic['severity']??'unknown',['error','unknown'],true))$diagnostic['severity']='warning';$diagnostic['reasons'][]=$reason;
        // Lets the screen link the warning to the exact definition instead of leaving a bare badge.
        if(is_array($alert)&&isset($alert['type'],$alert['id']))$diagnostic['reason_links'][]=['reason'=>$reason,'type'=>$alert['type'],'id'=>$alert['id']];
    }
    $diagnostic['reasons']=array_values(array_unique($diagnostic['reasons']??[]));return $diagnostic;
}
function zfsmProtectionLagAlerts($pool,$store,$jobs,$hours,$now=null,$withLinks=false) {
    if($hours<=0)return [];$now=$now??time();$alerts=[];
    foreach($store['replications']??[] as $id=>$definition){if(empty($definition['enabled'])||explode('/',$definition['source']??'',2)[0]!==$pool)continue;$latest=null;
        foreach($jobs as $job)if(($job['definition_id']??null)===(string)$id&&($job['type']??'')==='replication'&&($job['schema']??null)===4){if($latest===null||strcmp($job['created']??'',$latest['created']??'')>0)$latest=$job;}
        if(!$latest)continue;$verification=zfsmProtectionCurrentVerification($latest['verification']??[],$now);
        if(in_array($latest['verified_outcome']??'',['failed','blocked','unknown','interrupted','recovery_required'],true)){$reason=$latest['verification']['reason']??($latest['error']??'');$text='Replication '.($definition['name']??$id).' ('.$id.') requires inspection; the latest run is not verified complete'.(is_string($reason)&&$reason!==''?': '.substr(preg_replace('/\s+/',' ',$reason),0,300):'.');$alerts[]=$withLinks?['text'=>$text,'type'=>'replication','id'=>(string)$id]:$text;}
        elseif($verification['lag_seconds']!==null&&$verification['lag_seconds']>$hours*3600){$text='Replication '.$id.' exceeds the configured verified checkpoint age ('.$hours.' hours).';$alerts[]=$withLinks?['text'=>$text,'type'=>'replication','id'=>(string)$id]:$text;}
    }return $alerts;
}
function zfsmReadMaintenanceHistory($directory,$pool) {
    $file=$directory.'/maintenance-history.json';if(!file_exists($file))return ['status'=>'known','entries'=>[]];
    try{if(is_link($file)||!is_file($file)||filesize($file)>524288)throw new RuntimeException('Untrusted history');$data=json_decode(file_get_contents($file),true,32,JSON_THROW_ON_ERROR);if(($data['version']??null)!==1||!is_array($data['entries']??null)||count($data['entries'])>200)throw new RuntimeException('Invalid history');foreach($data['entries'] as $entry)if(!zfsmValidPoolName($entry['pool']??'')||!in_array($entry['severity']??'',['ok','warning','error','unknown'],true)||!is_string($entry['time']??null)||!is_array($entry['reasons']??null))throw new RuntimeException('Invalid history entry');return ['status'=>'known','entries'=>array_reverse(array_values(array_filter($data['entries'],fn($e)=>$e['pool']===$pool)))];}
    catch(Throwable $error){return ['status'=>'unknown','entries'=>null,'reason'=>'Maintenance transition history is unreadable; current diagnostics remain independent.'];}
}
function zfsmRecordMaintenanceTransition($directory,$diagnostic,$severity,$reasons) {
    $file=$directory.'/maintenance-history.json';$entries=[];
    if(file_exists($file)&&(is_link($file)||!is_file($file)||filesize($file)>524288))throw new RuntimeException('Maintenance history requires inspection; existing bytes retained.');
    if(is_file($file)&&!is_link($file)&&filesize($file)<=524288){$data=json_decode(@file_get_contents($file)?:'null',true);if(($data['version']??null)===1&&is_array($data['entries']??null))$entries=$data['entries'];else{if(!@rename($file,$file.'.corrupt-'.bin2hex(random_bytes(6))))throw new RuntimeException('Cannot preserve invalid maintenance history');}}
    $entries[]=['pool'=>$diagnostic['pool'],'severity'=>$severity,'health'=>$diagnostic['health']??'UNKNOWN','time'=>gmdate('c'),'reasons'=>$reasons,'scan'=>$diagnostic['scan']['state']??'unknown','trim'=>$diagnostic['trim']['state']??'unknown'];
    zfsmJobAtomicWrite($file,['version'=>1,'entries'=>array_slice($entries,-200)]);
}
function zfsmReadMaintenanceDiagnostics($pool,$config) {
    $diagnostic=zfsmReadPoolDiagnostics($pool);$alerts=[];
    try{if(is_file(dirname($GLOBALS['plugin_config']).'/protection/config.json'))$alerts=zfsmProtectionLagAlerts($pool,zfsmProtectionReadStore(),zfsmJobPage(1,200)['jobs'],(int)($config['replication_lag_hours']??24),null,true);}catch(Throwable $error){$diagnostic['monitor_warning']='Protection alert evidence is unavailable.';}
    $diagnostic=zfsmMaintenanceEvaluate($diagnostic,$config,$alerts);$diagnostic['maintenance_history']=zfsmReadMaintenanceHistory(dirname($GLOBALS['plugin_state']).'/monitor',$pool);return $diagnostic;
}
