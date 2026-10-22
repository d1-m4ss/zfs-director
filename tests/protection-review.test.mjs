import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startIntegration} from './integration/server.mjs';

const bootstrap=`require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
function ensure($ok,$message){if(!$ok)throw new RuntimeException($message);}
function rejected($fn,$message){try{$fn();}catch(RuntimeException $e){ensure(str_contains($e->getMessage(),$message),$e->getMessage());return;}throw new RuntimeException('Expected rejection: '.$message);}
$source='cache/__mock__/project';$target='cache/__mock__/review-backup';
$r=zfsmSyncoidJob(['id'=>'abc','source'=>$source,'target'=>$target,'source_guid'=>zfsmReadIdentity($source)['guid']]);
$p=zfsmSanoidPolicy(['id'=>'def','dataset'=>$source,'autoprune'=>false]);$p['source_guid']=$r['source_guid'];
$store=zfsmProtectionReadStore();$store['replications']['abc']=$r;$store['policies']['def']=$p;zfsmProtectionWriteStore($store);
`;
async function scenario(t,code,{partial=false,edit=false}={}) {
 const stand=await startIntegration({protection:true});t.after(()=>stand.close());
 if(partial||edit){
  const path='/acceptance/system.php',text=stand.php.readFileAsText(path);
  const marker="return integrationProcess($command,$args)+['cancelled'=>false];";
  assert.ok(text.includes(marker));
  const altered=`$result=integrationProcess($command,$args);${edit?`$s=zfsmProtectionReadStore();$s['replications']['abc']['target']='cache/__mock__/edited-target';$s['replications']['abc']['target_guid']=null;zfsmProtectionWriteStore($s);`:''}return array_replace($result,['code'=>${partial?'1':'0'},'cancelled'=>${partial?'true':'false'}]);`;
  stand.php.writeFile(path,text.replace(marker,altered));
 }
 const result=await stand.run({code:'<?php '+bootstrap+code+"echo 'PASS';"});
 assert.equal(result.errors,'',result.text);assert.equal(result.exitCode,0,result.text);assert.equal(result.text,'PASS');
 return stand;
}
test('snapshot clock survives signed preview, save, state readback and native invocation config',async t=>{
 await scenario(t,`file_put_contents('/etc/sanoid/sanoid.defaults.conf',"[template_default]\\nhourly=24\\ndaily_hour=22\\ndaily_min=17\\nautosnap=yes\\nautoprune=no\\n");
 $preview=zfsmSanoidPreview(['id'=>'def','dataset'=>$source,'daily'=>7,'daily_hour'=>3,'daily_min'=>0,'hourly'=>0,'weekly'=>0,'monthly'=>0,'yearly'=>0,'frequently'=>0],'secret');
 ensure($preview['review']['snapshot_effective']['daily_hour']===3&&$preview['review']['snapshot_effective']['daily_min']===0,'Signed clock is not the native clock');
 zfsmSanoidCommit($preview,'secret');$saved=zfsmProtectionReadStore()['policies']['def'];ensure($saved['daily_hour']===3&&$saved['daily_min']===0,'Clock was lost in persistent state');
 $args=zfsmSanoidPrepare($saved,[$source]);$dir=substr($args[0],strlen('--configdir='));$native=zfsmSanoidParse(file_get_contents($dir.'/sanoid.conf'))[$source];ensure($native['daily_hour']==='3'&&$native['daily_min']==='0'&&$native['autoprune']==='no','Native snapshot config is unsafe or has the wrong time');
 $data=zfsmProtectionData();ensure($data['snapshot_defaults']['daily_hour']===22,'Installed default missing from API');$policy=array_values(array_filter($data['policies'],fn($row)=>$row['id']==='def'))[0];ensure($policy['snapshot_effective']['daily_hour']===3,'Saved API has a different clock');`);
});
test('native Unraid collector uses trusted Bash argv for activation and rollback',async t=>{
 await scenario(t,`file_put_contents('/usr/local/sbin/update_cron',"#/bin/bash\\n# Captured Unraid header has no interpreter marker\\n");zfsmProtectionPublishSchedules($store,$store);$calls=integrationModel()['calls'];$bash=array_values(array_filter($calls,fn($c)=>$c['command']==='/bin/bash'));ensure(count($bash)===1&&$bash[0]['args']===['/usr/local/sbin/update_cron'],'Collector was not invoked through explicit Bash argv');foreach($calls as$c)ensure($c['command']!=='/usr/local/sbin/update_cron','Malformed header was executed directly');$m=integrationModel();$m['fail_command']='/bin/bash /usr/local/sbin/update_cron';$m['calls']=[];integrationSave($m);rejected(fn()=>zfsmProtectionPublishSchedules($store,$store),'rollback failed');$calls=integrationModel()['calls'];$bash=array_values(array_filter($calls,fn($c)=>$c['command']==='/bin/bash'));ensure(count($bash)===2,'Activation and rollback must use the same trusted interpreter');foreach($bash as$c)ensure($c['args']===['/usr/local/sbin/update_cron'],'Shell command text must not be used');`);
});
test('untrusted Bash refuses publication before any scheduler call or cron write',async t=>{
 await scenario(t,`chmod('/bin/bash',0777);$before=integrationModel()['calls'];$file=zfsmProtectionCronFile();ensure(!is_file($file),'Unexpected cron fixture');rejected(fn()=>zfsmProtectionPublishSchedules($store,$store),'Trusted Bash');ensure(!is_file($file),'Untrusted interpreter still wrote cron');ensure(integrationModel()['calls']===$before,'Untrusted interpreter still called scheduler');`);
});
test('creation date guards leave disabled and pruning-only policy edits intact',async t=>{
 await scenario(t,`foreach([['enabled'=>false,'autosnap'=>true],['enabled'=>true,'autosnap'=>false]]as$flags){$input=array_merge(['id'=>'def','dataset'=>$source,'monthly'=>6,'monthly_mday'=>31],$flags);$review=zfsmSanoidPreview($input,'secret');zfsmSanoidCommit($review,'secret');$saved=zfsmProtectionReadStore()['policies']['def'];ensure($saved['monthly_mday']===31,'Non-creating policy clock was rewritten');zfsmSanoidInvoke($saved,[$source],true,'/usr/sbin/sanoid',['--readonly','--prune-snapshots']);}`);
});
test('distinct overlapping definitions stay queued while same-definition cron runs deduplicate',async t=>{
 await scenario(t,`$policy=zfsmQueueProtection(['type'=>'policy','id'=>'def'],false);$replica=zfsmQueueProtection(['type'=>'replication','id'=>'abc'],false);$again=zfsmQueueProtection(['type'=>'replication','id'=>'abc'],false);ensure($policy['job']['id']!==$replica['job']['id'],'Replication occurrence was discarded');ensure($again['job']['id']===$replica['job']['id'],'Same definition duplicated');ensure(count(zfsmPendingJobs())===2,'Both definitions must remain queued');`);
});
test('installer maintenance refuses cron dispatch without creating Jobs or touching schedules',async t=>{
 await scenario(t,`$beforeJobs=glob(dirname(zfsmJobFile('20261022-230000-ffffffffffff')).'/*.json');$before=integrationModel();$stop=$GLOBALS['plugin_runtime'].'/stop';if(!is_dir(dirname($stop)))mkdir(dirname($stop),0700,true);file_put_contents($stop,'package installation in progress');
 foreach(['policy'=>'def','replication'=>'abc']as$type=>$id)rejected(fn()=>zfsmQueueProtection(['type'=>$type,'id'=>$id],false),'paused for maintenance');
 ensure(glob(dirname(zfsmJobFile('20261022-230000-ffffffffffff')).'/*.json')===$beforeJobs,'Maintenance created a Job');ensure(integrationModel()===$before,'Maintenance launched a command or changed cron');
 unlink($stop);$result=zfsmQueueProtection(['type'=>'policy','id'=>'def'],false);ensure($result['job']['state']==='queued','Dispatch did not recover after maintenance');`);
});
test('external local destination conflicts block preview activation run and dispatch',async t=>{
 await scenario(t,`file_put_contents('/etc/cron.d/external','* * * * * syncoid other/src '.$target."\n");
 rejected(fn()=>zfsmSyncoidPreview(['id'=>'abc','source'=>$source,'target'=>$target],'secret'),'External schedule');
 rejected(fn()=>zfsmProtectionPublishSchedules($store,$store),'External schedule');
 rejected(fn()=>zfsmProtectionRunPreview(['type'=>'replication','id'=>'abc'],'secret'),'External schedule');
 $q=zfsmQueueProtection(['type'=>'replication','id'=>'abc'],false);ensure($q['job']['verified_outcome']==='blocked','Scheduled receiver conflict must be durable');
 $j=zfsmNewProtectionJob('replication',$r);zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);zfsmRunProtectionJob($j);ensure(zfsmReadJob($j['id'])['state']!=='completed','Execution ignored receiver ownership');
 foreach(integrationModel()['calls']as$c)ensure($c['command']!=='/usr/sbin/syncoid'||in_array($c['args'][0],['--version','--help'],true),'Transfer launched despite External destination');`);
});
test('missing scheduled backend produces a failed durable attempt and failure audit',async t=>{
 await scenario(t,`$old=zfsmNewProtectionJob('replication',$r);zfsmJobAtomicWrite(zfsmJobFile($old['id']),$old);zfsmProtectionFinish($old['id'],['outcome'=>'completed','reason'=>'old success']);unlink('/usr/sbin/syncoid');
 $q=zfsmQueueProtection(['type'=>'replication','id'=>'abc'],false);$j=zfsmReadJob($q['job']['id']);ensure($j['id']!==$old['id']&&$j['verified_outcome']==='blocked'&&$j['state']==='failed','Backend failure disappeared');ensure(!empty($q['failed']),'Dispatcher must receive failure');
 ensure((bool)array_filter(zfsmAuditList(),fn($e)=>$e['command']==='protectionscheduled'&&$e['status']==='failed'&&($e['fields']['job_id']??null)===$j['id']),'No durable scheduled failure audit');`);
});
test('pending definitions cannot be overwritten by a previously signed save',async t=>{
 await scenario(t,`foreach(['replication','policy']as$type){$input=$type==='policy'?['id'=>'def','dataset'=>$source,'autoprune'=>false]:['id'=>'abc','source'=>$source,'target'=>$target];$preview=$type==='policy'?zfsmSanoidPreview($input,'secret'):zfsmSyncoidPreview($input,'secret');$d=$type==='policy'?$p:$r;$job=zfsmNewProtectionJob($type,$d);zfsmJobAtomicWrite(zfsmJobFile($job['id']),$job);rejected(fn()=>$type==='policy'?zfsmSanoidCommit($preview,'secret'):zfsmSyncoidCommit($preview,'secret'),'pending job');zfsmProtectionCancel($job['id']);}`);
});
test('completion cannot bind old receiver GUID into an edited definition',async t=>{
 await scenario(t,`$j=zfsmNewProtectionJob('replication',$r);zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);zfsmRunProtectionJob($j);$saved=zfsmProtectionReadStore()['replications']['abc'];ensure($saved['target']==='cache/__mock__/edited-target'&&$saved['target_guid']===null,'Old receiver identity corrupted edited target');ensure(zfsmReadJob($j['id'])['state']==='recovery_required','Definition change must require inspection');`,{edit:true});
});
test('interrupted initial receiver identity persists and replacement cannot be retried',async t=>{
 await scenario(t,`$j=zfsmNewProtectionJob('replication',$r);zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);zfsmRunProtectionJob($j);$saved=zfsmProtectionReadStore()['replications']['abc'];$guid=integrationModel()['datasets'][$target]['guid'];ensure($saved['target_guid']===$guid,'Partial receiver identity was not saved');ensure(zfsmReadJob($j['id'])['verified_outcome']==='interrupted','Cancelled transfer must remain interrupted');
 $model=integrationModel();$model['datasets'][$target]['guid']='99999999';$model['calls']=[];integrationSave($model);$retry=zfsmNewProtectionJob('replication',$saved);zfsmJobAtomicWrite(zfsmJobFile($retry['id']),$retry);zfsmRunProtectionJob($retry);ensure(zfsmReadJob($retry['id'])['state']==='recovery_required','Replaced receiver was accepted');foreach(integrationModel()['calls']as$c)ensure($c['command']!=='/usr/sbin/syncoid'||in_array($c['args'][0],['--version','--help'],true),'Transfer launched into replaced receiver');`,{partial:true});
});
test('a target that appears after absent-target review requires a fresh ownership review',async t=>{
 await scenario(t,`$model=integrationModel();$model['datasets'][$target]=$model['datasets'][$source];$model['datasets'][$target]['name']=$target;$model['datasets'][$target]['guid']='99999999';integrationSave($model);$j=zfsmNewProtectionJob('replication',$r);zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);zfsmRunProtectionJob($j);ensure(zfsmReadJob($j['id'])['state']==='recovery_required','Unexpected receiver was accepted');foreach(integrationModel()['calls']as$c)ensure($c['command']!=='/usr/sbin/syncoid'||in_array($c['args'][0],['--version','--help'],true),'Unreviewed target received data');`);
});

test('disabled integration blocks scheduled dispatch and pre-existing queued execution without changing cron',async t=>{
 await scenario(t,`$cfg=$GLOBALS['plugin_config'];$bytes=file_get_contents($cfg);file_put_contents($cfg,str_replace('sanoid_integration = "1"','sanoid_integration = "0"',$bytes));$before=integrationModel();$queued=zfsmQueueProtection(['type'=>'replication','id'=>'abc'],false);ensure(!empty($queued['failed']),'Disabled scheduled dispatch was queued');$j=zfsmNewProtectionJob('policy',$p);zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);zfsmRunProtectionJob($j);ensure(zfsmReadJob($j['id'])['state']!=='completed','Disabled queued job executed');$after=integrationModel();foreach(array_slice($after['calls'],count($before['calls']))as$c)ensure(!in_array($c['command'],['/usr/sbin/sanoid','/usr/sbin/syncoid'],true)||in_array($c['args'][0],['--version','--help'],true),'Disabled integration ran native work');ensure(($after['crontab']??'')===($before['crontab']??''),'Disabled gate rewrote cron');`);
});
