<?php
require '/app/harness.php';
$GLOBALS['plugin_config']='/config/director.cfg';$GLOBALS['plugin_state']='/jobs';$GLOBALS['plugin_runtime']='/runtime';$GLOBALS['zfsm_boot_id']='test-boot';
function parse_plugin_cfg($p,$s){return [];}
function definition(){return zfsmSyncoidJob(['id'=>'abc','name'=>'Backup','source'=>'cache/a','source_guid'=>'100','target'=>'backup/a']);}
function rejectJob($fn){try{$fn();}catch(InvalidArgumentException|RuntimeException$e){return;}throw new LogicException('Expected rejection');}
check('new protection journal is schema isolated and keeps stage history',function(){
 $j=zfsmNewProtectionJob('replication',definition());same(4,$j['schema']);same('queued',$j['state']);same(null,zfsmJobProblem($j));same('queued',$j['stage_history'][0]['state']);$j['schema']=2;same('invalid_journal',zfsmJobProblem($j)[0]);
});
check('invalid scope ownership and arbitrary process identities cannot form executable jobs',function(){
 $j=zfsmNewProtectionJob('replication',definition());$j['definition_id']='external-abc';same('invalid_journal',zfsmJobProblem($j)[0]);$j=zfsmNewProtectionJob('replication',definition());$j['definition_hash']='wrong';same('invalid_journal',zfsmJobProblem($j)[0]);
});
check('cancel queued protection job preserves definition and data paths',function(){
 $j=zfsmNewProtectionJob('replication',definition());zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);zfsmProtectionCancel($j['id']);$a=zfsmReadJob($j['id']);same('cancelled',$a['state']);same('backup/a',$a['target']);same(true,$a['cancel_requested']);same('abc',$a['definition_id']);
});
check('verified outcome remains separate from generic durable state',function(){
 foreach(['completed'=>'completed','up_to_date'=>'completed','blocked'=>'failed','unknown'=>'recovery_required','interrupted'=>'recovery_required','failed'=>'failed','skipped'=>'completed']as$outcome=>$state){$j=zfsmNewProtectionJob('replication',definition());zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);zfsmProtectionFinish($j['id'],['outcome'=>$outcome,'reason'=>'test','exit_code'=>0]);$a=zfsmReadJob($j['id']);same($state,$a['state']);same($outcome,$a['verified_outcome']);same(null,zfsmJobProblem($a));}
});
check('restarted in-flight jobs are interrupted without automatic destructive recovery',function(){
 $j=zfsmNewProtectionJob('replication',definition());$j['state']='running';$j['ack_boot']='old-boot';zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);same(false,zfsmProtectionRecoverJob($j));same('interrupted',zfsmReadJob($j['id'])['verified_outcome']);
});
check('single cron contains only enabled managed jobs and never depends on GUI toggle',function(){
 $s=zfsmProtectionReadStore();$s['replications']['abc']=definition();$p=zfsmSanoidPolicy(['id'=>'def','dataset'=>'cache/b','enabled'=>'0']);$s['policies']['def']=$p;$text=zfsmProtectionCronText($s);same(1,substr_count($text,'zfsm-protection.php'));same(false,str_contains($text,'def'));same(false,str_contains($text,'integration'));same(true,str_contains($text,"'replication' 'abc'"));
});
check('external schedules are visible and ambiguous scripts require review',function(){
 @mkdir('/etc/cron.d',0755,true);file_put_contents('/etc/cron.d/external',"5 * * * * root syncoid cache/a backup/a\n");$s=zfsmProtectionSchedules();same(1,count($s['external']));same('external',$s['external'][0]['owner']);rejectJob(fn()=>zfsmProtectionCheckSchedules('cache/a',$s));
 file_put_contents('/etc/cron.d/external',"* * * * * root sanoid --cron --configdir=\$CONFIG\n");same(true,zfsmProtectionSchedules()['external'][0]['review']);
});
check('external mutation identifiers and unsupported control actions fail closed',function(){
 rejectJob(fn()=>zfsmProtectionDefinitionControl(['type'=>'policy','id'=>'external-abc','action'=>'remove']));rejectJob(fn()=>zfsmProtectionDefinitionControl(['type'=>'replication','id'=>'abc','action'=>'destroy-target']));
});
check('enabling a saved draft cannot duplicate an existing managed schedule scope',function(){
 $p=zfsmSanoidPolicy(['id'=>'aa','dataset'=>'cache/a','recursive'=>'1']);$other=zfsmSanoidPolicy(['id'=>'bb','dataset'=>'cache/a/child']);$s=zfsmProtectionReadStore();$s['policies']=['bb'=>$other];rejectJob(fn()=>zfsmProtectionActivationConflicts('policy',$p,$s,[]));
 $r=definition();$other=$r;$other['id']='def';$other['target']='backup/a/child';$s['replications']=['def'=>$other];rejectJob(fn()=>zfsmProtectionActivationConflicts('replication',$r,$s,[]));
});
check('unavailable scheduler rolls configuration activation back without discarding backup',function(){
 $before=zfsmProtectionReadStore();zfsmProtectionWriteStore($before);$after=$before;$after['replications']['abc']=definition();rejectJob(fn()=>zfsmProtectionApplyStore($after));same($before,zfsmProtectionReadStore());same(true,is_file(zfsmProtectionDirectory().'/config.json.bak'));
});
check('Unraid cron activation refuses to overwrite unowned existing entries',function(){
 zfsmProtectionCronCompatibility("# generated\n0 * * * * native-job\n",["0 * * * * native-job\n"]);
 rejectJob(fn()=>zfsmProtectionCronCompatibility("0 * * * * native-job\n5 * * * * custom-job\n",["0 * * * * native-job\n"]));
});
check('unknown native exit code is not presented as a numeric process result',function(){
 $j=zfsmNewProtectionJob('replication',definition());zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);zfsmProtectionFinish($j['id'],['outcome'=>'interrupted','exit_code'=>-1,'reason'=>'cancelled']);same(null,zfsmReadJob($j['id'])['verification']['exit_code']);
});
check('active transfers guard quota and property changes on overlapping scopes',function(){
 $j=zfsmNewProtectionJob('replication',definition());$j['state']='running';zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);rejectJob(fn()=>zfsmProtectionMutationGuard('setquota',['zdataset'=>'cache/a']));rejectJob(fn()=>zfsmProtectionMutationGuard('editdatasetproperty',['zdataset'=>'backup/a','property'=>'readonly']));zfsmProtectionMutationGuard('setquota',['zdataset'=>'cache/another']);zfsmJobUpdate($j['id'],['state'=>'completed']);
});
check('running receiver reservations also guard dataset creation and clone destinations',function(){
 $j=zfsmNewProtectionJob('replication',definition());$j['state']='running';zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);rejectJob(fn()=>zfsmProtectionMutationGuard('createdataset',['data'=>['zpool'=>'backup','name'=>'a']]));rejectJob(fn()=>zfsmProtectionMutationGuard('clonesnapshot',['snapshot'=>'cache/other@s','clone'=>'backup/a/child']));zfsmProtectionMutationGuard('createdataset',['data'=>['zpool'=>'backup','name'=>'unrelated']]);zfsmJobUpdate($j['id'],['state'=>'completed']);
});
finishTests();
