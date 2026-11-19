<?php
require '/app/harness.php';
function maintenanceDiagnostic($alloc){return ['pool'=>'cache','health'=>'ONLINE','severity'=>'ok','reasons'=>[],'information'=>['rows'=>[['name'=>'cache','size'=>'1000','alloc'=>(string)$alloc]]]];}
check('capacity thresholds use verified pool allocation without downgrading native errors',function(){ $c=['space_warning_percent'=>80,'space_critical_percent'=>90];$a=zfsmMaintenanceEvaluate(maintenanceDiagnostic(810),$c);same('warning',$a['severity']);same(81.0,$a['capacity']['percent']);$b=zfsmMaintenanceEvaluate(maintenanceDiagnostic(850),$c);same($a['reasons'],$b['reasons']);same('error',zfsmMaintenanceEvaluate(maintenanceDiagnostic(910),$c)['severity']);$d=maintenanceDiagnostic(100);$d['severity']='error';same('error',zfsmMaintenanceEvaluate($d,$c)['severity']);$d['information']['rows']=[];same('unknown',zfsmMaintenanceEvaluate($d,$c)['capacity']['status']);});
check('lag is recomputed from verified checkpoint creation and stays unknown without evidence',function(){ $v=['verified'=>true,'checkpoints'=>[''=>['creation'=>100,'guid'=>'11']],'lag_seconds'=>0];same(900,zfsmProtectionCurrentVerification($v,1000)['lag_seconds']);same(null,zfsmProtectionCurrentVerification(['verified'=>false,'lag_seconds'=>0],1000)['lag_seconds']);});
check('maintenance history records transitions rather than every poll and includes recovery',function(){ $dir='/maintenance-state';$sent=0;$send=function()use(&$sent){$sent++;return true;};$c=['space_warning_percent'=>80,'space_critical_percent'=>90];foreach([810,820,910,920,100] as $alloc)zfsmMonitorTransition($dir,zfsmMaintenanceEvaluate(maintenanceDiagnostic($alloc),$c),$send);same(2,$sent);$history=zfsmReadMaintenanceHistory($dir,'cache');same('known',$history['status']);same(['ok','error','warning'],array_column($history['entries'],'severity'));});
check('threshold settings validate ordering while preserving old clients',function(){ $base=['refresh_interval'=>'30','lazy_load'=>'0','sanoid_integration'=>'0','destructive_mode'=>'0','exclusion'=>'','directory_listing'=>'','snap_max_days_alert'=>'30','snap_pattern'=>'Y-m-d-His','snap_prefix'=>'auto-'];same(true,zfsmValidateSettings($base)['valid']);same(false,zfsmValidateSettings($base+['space_warning_percent'=>'95','space_critical_percent'=>'90'])['valid']);same(true,zfsmValidateSettings($base+['space_warning_percent'=>'80','space_critical_percent'=>'95','replication_lag_hours'=>'24'])['valid']);});
check('capacity alert cannot turn incomplete diagnostics into actionable known health',function(){$d=maintenanceDiagnostic(950);$d['severity']='unknown';same('unknown',zfsmMaintenanceEvaluate($d,[])['severity']);});
check('partial checkpoint metadata cannot masquerade as a verified current lag',function(){same(null,zfsmProtectionCurrentVerification(['verified'=>true,'checkpoints'=>[['guid'=>'1','creation'=>100],['guid'=>'2']]],1000)['lag_seconds']);});
check('oversized maintenance history is preserved instead of silently replaced',function(){zfsmJobDirectory('/large-maintenance');$raw=str_repeat('x',524289);file_put_contents('/large-maintenance/maintenance-history.json',$raw);try{zfsmRecordMaintenanceTransition('/large-maintenance',maintenanceDiagnostic(100),'ok',[]);}catch(RuntimeException $error){}same($raw,file_get_contents('/large-maintenance/maintenance-history.json'));});
check('replication age alerts support numeric definition IDs and disable switch',function(){$store=['replications'=>['123'=>['enabled'=>true,'source'=>'cache/a','schedule'=>'0 * * * *']]];$jobs=[['schema'=>4,'type'=>'replication','definition_id'=>'123','created'=>'2026-10-18','verified_outcome'=>'completed','verification'=>['verified'=>true,'checkpoints'=>[['guid'=>'11','creation'=>100]]]]];same(1,count(zfsmProtectionLagAlerts('cache',$store,$jobs,1,100+7200+1)));same([],zfsmProtectionLagAlerts('cache',$store,$jobs,0,10000));});
check('failed replication alert names the job and the recorded reason',function(){
 $store=['replications'=>['5f91932124fad7a0'=>['enabled'=>true,'name'=>'Immich backup','source'=>'cache/immich']]];
 $jobs=[['schema'=>4,'type'=>'replication','definition_id'=>'5f91932124fad7a0','created'=>'2026-11-10','verified_outcome'=>'failed','verification'=>['verified'=>false,'reason'=>"Native transfer failed (exit 2).\nInspect source and receiver."]]];
 same(['Replication "Immich backup": last run not verified. Native transfer failed (exit 2). Inspect source and receiver.'],zfsmProtectionLagAlerts('cache',$store,$jobs,24,strtotime('2026-11-10T12:00:00Z')));
 $jobs[0]['verification']=['verified'=>false];
 same(['Replication "Immich backup": last run not verified.'],zfsmProtectionLagAlerts('cache',$store,$jobs,24,strtotime('2026-11-10T12:00:00Z')));
});
check('a replication warning is linked to its definition',function(){
 $store=['replications'=>['5f91932124fad7a0'=>['enabled'=>true,'name'=>'Immich backup','source'=>'cache/immich']]];
 $jobs=[['schema'=>4,'type'=>'replication','definition_id'=>'5f91932124fad7a0','created'=>'2026-11-10','verified_outcome'=>'failed','verification'=>['verified'=>false,'reason'=>'Native transfer failed (exit 2).']]];
 $alerts=zfsmProtectionLagAlerts('cache',$store,$jobs,24,strtotime('2026-11-10T12:00:00Z'),true);
 same([['text'=>'Replication "Immich backup": last run not verified. Native transfer failed (exit 2).','type'=>'replication','id'=>'5f91932124fad7a0']],$alerts);
 $diagnostic=zfsmMaintenanceEvaluate(['pool'=>'cache','severity'=>'ok','reasons'=>[],'information'=>['rows'=>[]]],[],$alerts);
 same('warning',$diagnostic['severity']);same([$alerts[0]['text']],$diagnostic['reasons']);
 same([['reason'=>$alerts[0]['text'],'type'=>'replication','id'=>'5f91932124fad7a0']],$diagnostic['reason_links']);
});
check('cron max gap follows the longest pause between fire times',function(){
 $d=86400;
 foreach([['0 * * * *',3600],['*/15 * * * *',900],['0 3 * * *',$d],['0 3 * * 0',7*$d],['0 3 * * 7',7*$d],['0 3 * * 1-5',3*$d],['0 3 1 * *',31*$d],['0 3,15 * * *',12*3600],['0 3,4 * * *',$d-3600],['*/20 8-9 * * *',$d-(9*60+40-(8*60))*60],['0 0 * * 1,3',5*$d],['30 2 1 1 *',366*$d],['0 0 29 2 *',366*$d],['5 4 * * 1-5/2',3*$d],['0 0 1,15 * *',17*$d],['*/30 * * * *',1800],['0,10,20 * * * *',40*60]] as [$schedule,$expected])same($expected,zfsmCronMaxGapSeconds($schedule),$schedule);
 // Vixie rule: with both day fields restricted a day matches when either matches.
 same(7*$d,zfsmCronMaxGapSeconds('0 0 15 * 1'),'dom 15 or Monday');same(3*$d,zfsmCronMaxGapSeconds('0 0 * 1-12 1-5'),'both fields restricted use OR; a star keeps AND');same(7*$d,zfsmCronMaxGapSeconds('0 0 1-7 * 1'),'a star-free dom range and Monday');same(3*$d,zfsmCronMaxGapSeconds('0 0 */1 * 1-5'),'dom */1 starts with a star so both must match');
 same(null,zfsmCronMaxGapSeconds('0 0 30 2 *'));
 foreach(['','* * * *','* * * * * *','60 * * * *','a * * * *','0 0 * * 8','5-1 * * * *','@daily'] as $bad)same(null,zfsmCronMaxGapSeconds($bad),$bad);
});
check('missed-run limit is the gap plus 25 percent, at least one hour, in whole hours',function(){
 same(2*3600,zfsmReplicationMissedLimitSeconds('0 * * * *'));
 same(30*3600,zfsmReplicationMissedLimitSeconds('0 3 * * *'));
 same(210*3600,zfsmReplicationMissedLimitSeconds('0 3 * * 0'));
 same(null,zfsmReplicationMissedLimitSeconds('0 0 30 2 *'));same(null,zfsmReplicationMissedLimitSeconds(null));
 same('2 hours',zfsmMissedLimitText(7200));same('47 hours',zfsmMissedLimitText(47*3600));same('2 days',zfsmMissedLimitText(48*3600));same('8 days 18 hours',zfsmMissedLimitText(210*3600));same('3 days 1 hour',zfsmMissedLimitText(73*3600));same('2 days 2 hours',zfsmMissedLimitText(50*3600));
});
check('replication missed-run alert is per job and its text does not change with the age',function(){
 $job=['schema'=>4,'type'=>'replication','definition_id'=>'81e71907838a181a','created'=>'2026-10-18','verified_outcome'=>'completed','verification'=>['verified'=>true,'checkpoints'=>[['guid'=>'11','creation'=>100]]]];
 $alerts=function($name,$age,$extra=[],$hours=24,$links=false)use($job){$definition=array_replace(['enabled'=>true,'source'=>'cache/a','schedule'=>'0 3 * * *'],$extra);if($name!==null)$definition['name']=$name;return zfsmProtectionLagAlerts('cache',['replications'=>['81e71907838a181a'=>$definition]],[$job],$hours,100+$age,$links);};
 $text='Replication "Immich backup": no verified copy for longer than expected (limit: 30 hours).';
 same([$text],$alerts("Immich \n backup",30*3600+1));
 same([$text],$alerts('Immich backup',200*3600));
 same($alerts('Immich backup',30*3600+1),$alerts('Immich backup',230*3600));
 same(['Replication "81e71907838a181a": no verified copy for longer than expected (limit: 30 hours).'],$alerts(null,31*3600));
 same([],$alerts('Immich backup',30*3600));same([],$alerts('Immich backup',3600));
 same([['text'=>$text,'type'=>'replication','id'=>'81e71907838a181a']],$alerts('Immich backup',31*3600,[],24,true));
 same(['Replication "Immich backup": no verified copy for longer than expected (limit: 8 days 18 hours).'],$alerts('Immich backup',210*3600+1,['schedule'=>'0 3 * * 0']));
 same([],$alerts('Immich backup',3*86400,['schedule'=>'0 3 * * 0']));same([],$alerts('Immich backup',210*3600,['schedule'=>'0 3 * * 0']));
 same(['Replication "Immich backup": no verified copy for longer than expected (limit: 2 hours).'],$alerts('Immich backup',2*3600+1,['schedule'=>'0 * * * *']));
 same([],$alerts('Immich backup',900*3600,['missed_alert'=>false]));
 same(1,count($alerts('Immich backup',900*3600,['missed_alert'=>true])));
 same(1,count($alerts('Immich backup',900*3600,['missed_alert'=>null])));
 same([],$alerts('Immich backup',900*3600,[],0));
 same([],$alerts('Immich backup',900*3600,['schedule'=>'0 0 30 2 *']));same([],$alerts('Immich backup',900*3600,['schedule'=>'bad']));
 same([],$alerts('Immich backup',900*3600,['enabled'=>false]));
});
check('a failed replication run still alerts unless the job turned its missed-run alert off',function(){
 $job=['schema'=>4,'type'=>'replication','definition_id'=>'5f91932124fad7a0','created'=>'2026-11-10','verified_outcome'=>'failed','verification'=>['verified'=>false,'reason'=>'Native transfer failed (exit 2).']];
 $alerts=fn($extra)=>zfsmProtectionLagAlerts('cache',['replications'=>['5f91932124fad7a0'=>['enabled'=>true,'name'=>'Immich backup','source'=>'cache/immich','schedule'=>'0 3 * * 0']+$extra]],[$job],24,strtotime('2026-11-10T12:00:00Z'));
 same(['Replication "Immich backup": last run not verified. Native transfer failed (exit 2).'],$alerts([]));
 same(['Replication "Immich backup": last run not verified. Native transfer failed (exit 2).'],$alerts(['missed_alert'=>true]));
 same([],$alerts(['missed_alert'=>false]));
});
check('the replication definition validator stores missed_alert as a boolean defaulting to true',function(){
 $base=['id'=>'abc','name'=>'R','source'=>'cache/a','target'=>'tank/b','mode'=>'local'];
 same(true,zfsmSyncoidJob($base)['missed_alert']);
 same(false,zfsmSyncoidJob($base+['missed_alert'=>'0'])['missed_alert']);same(false,zfsmSyncoidJob($base+['missed_alert'=>false])['missed_alert']);
 same(true,zfsmSyncoidJob($base+['missed_alert'=>'1'])['missed_alert']);same(true,zfsmSyncoidJob($base+['missed_alert'=>true])['missed_alert']);
 foreach(['yes','',2] as $bad){try{zfsmSyncoidJob($base+['missed_alert'=>$bad]);$ok=true;}catch(InvalidArgumentException $error){$ok=false;}same(false,$ok);}
});
finishTests();
