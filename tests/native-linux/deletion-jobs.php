<?php
// Destructive tests are confined to a unique child of the verified file-backed
// test pool in the existing VM. Never invoke this on an Unraid production host.
$base=getenv('ZFSM_NATIVE_ROOT');$dataset=getenv('ZFSM_DELETION_DATASET');
if(!preg_match('~^/var/lib/zfsd-delete-jobs-[a-z0-9_]+$~D',$base?:'')||!is_file($base.'/ISOLATED-TEST-ONLY')||!preg_match('~^director_it_1018/delete_jobs_[a-z0-9_]+$~D',$dataset?:''))throw new RuntimeException('Dedicated fixture scope required');
require $base.'/src/backend/ZFSMOperations.php';
$plugin_config=$base.'/director.cfg';$plugin_state=$base.'/jobs';$plugin_runtime=$base.'/runtime';$plugin_lock=$base.'/mutation.lock';$plugin_audit=$base.'/audit';
$plugin_worker_lock=$base.'/worker.lock';$plugin_service_lock=$base.'/service.lock';
// This fixture itself drives the real runner. Keep the launch boundary local
// instead of spawning a daemon with the VM's unrelated global configuration.
$fixtureService=fopen($plugin_service_lock,'c');flock($fixtureService,LOCK_EX);
function parse_plugin_cfg($p,$s){return parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_RAW)?:[];}
function demandDelete($yes,$why){if(!$yes)throw new RuntimeException($why);}
function zdelete($args){$r=runProcess('zfs',$args);demandDelete($r['code']===0,'Fixture ZFS command failed: '.$r['output']);return trim($r['output']);}
file_put_contents($plugin_config,"[general]\ndestructive_mode=1\nsanoid_integration=0\n");chmod($plugin_config,0600);
$root=$base.'/source';$checks=[];
function directoryJob($path,$recursive=true){global $dataset;zfsmGuardMutationIdentity('deletedirectory',['directory'=>$path,'expected_guid'=>zfsmReadIdentity($dataset)['guid'],'directory_identity'=>zfsmDirectoryIdentity($path)]);return zfsmQueueDeletion('directory',$path,$recursive)['job'];}
function datasetJob($name){$preview=zfsmPreviewDestroy($name,'1','isolated-test-secret');demandDelete($preview['can_destroy'],'Native preview blocked: '.json_encode($preview['diagnostics']));$scope=zfsmValidateDestroyPreview($name,'1','isolated-test-secret',$preview['preview_id'],$preview['token']);return zfsmQueueDeletion('dataset',$name,true,$scope)['job'];}
try{
 $parentGuid=zfsmReadIdentity($dataset)['guid'];mkdir($root.'/sibling');file_put_contents($root.'/sibling/sentinel','outside selected target');
 mkdir($root.'/selected',0777);chmod($root.'/selected',0777);chown($root.'/selected',99);chgrp($root.'/selected',100);
 for($i=0;$i<150;$i++)file_put_contents($root.'/selected/file-'.$i,'disposable fixture '.$i);
 symlink($root.'/sibling/sentinel',$root.'/selected/outside-link');
 $j=directoryJob($root.'/selected');demandDelete(is_file($root.'/selected/file-0'),'Queue deleted data synchronously');$done=zfsmRunDeletionJob($j['id']);demandDelete($done['state']==='completed','Real directory delete failed: '.json_encode($done));demandDelete($done['result']['removed']===152&&$done['result']['total']===152,'Wrong real deletion counters');demandDelete(!file_exists($root.'/selected')&&file_get_contents($root.'/sibling/sentinel')==='outside selected target','Deletion escaped selected target');$checks[]='0777 uid99 recursive directory: 152 verified unlinks; outside symlink target preserved';
 demandDelete(zfsmRunDeletionJob($j['id'])===$done,'Completed deletion reran');$checks[]='Completed deletion is inert on repeat';
 mkdir($root.'/nonempty');file_put_contents($root.'/nonempty/file','preserve');$j=directoryJob($root.'/nonempty',false);$done=zfsmRunDeletionJob($j['id']);demandDelete($done['state']==='failed'&&file_get_contents($root.'/nonempty/file')==='preserve'&&str_contains($done['error'],'not empty'),'Non-recursive refusal lost data or reason');$checks[]='Nonempty directory refuses nonrecursive deletion and keeps contents';
 mkdir($root.'/replace');file_put_contents($root.'/replace/original','preserve');$j=directoryJob($root.'/replace');rename($root.'/replace',$root.'/replace-original');mkdir($root.'/replace');file_put_contents($root.'/replace/new','preserve replacement');$done=zfsmRunDeletionJob($j['id']);demandDelete($done['state']==='failed'&&is_file($root.'/replace-original/original')&&is_file($root.'/replace/new'),'Replaced inode was deleted');$checks[]='Queued directory replacement fails closed';
 foreach(['running','previous-boot']as$case){mkdir($root.'/'.$case);file_put_contents($root.'/'.$case.'/file','preserve');$j=directoryJob($root.'/'.$case);zfsmJobUpdate($j['id'],$case==='running'?['state'=>'running','stage'=>'deleting']:['ack_boot'=>'previous-boot']);$done=zfsmRunDeletionJob($j['id']);demandDelete($done['state']==='recovery_required'&&is_file($root.'/'.$case.'/file'),'Interrupted or reboot job executed');$view=zfsmJobPresentation($done,zfsmJobFile($j['id']),false);demandDelete(!$view['actions']['resume']&&!$view['actions']['cancel'],'Unsafe automatic control offered');}$checks[]='Running and previous-boot deletion require inspection; no Resume';
 $target=$dataset.'/delete-target';zdelete(['create',$target]);zdelete(['create',$target.'/child']);zdelete(['snapshot','-r',$target.'@reviewed']);$j=datasetJob($target);$scope=$j['scope'];$done=zfsmRunDeletionJob($j['id']);demandDelete($done['state']==='completed'&&$done['result']['state_verified']&&$done['result']['removed_count']===4&&!zfsmDatasetExists($target),'Real recursive dataset deletion incomplete: '.json_encode($done));$checks[]='Signed exact scope: two real datasets and two snapshots removed; independent GUID readback';
 $held=$dataset.'/held-target';zdelete(['create',$held]);zdelete(['snapshot',$held.'@protected']);$j=datasetJob($held);zdelete(['hold','zfsd-delete-test',$held.'@protected']);$done=zfsmRunDeletionJob($j['id']);demandDelete($done['state']==='failed'&&!$done['result']['attempted']&&zfsmSnapshotExists($held.'@protected'),'New hold did not block queued deletion');zdelete(['release','zfsd-delete-test',$held.'@protected']);$checks[]='Hold added after review blocks worker before any deletion';
 demandDelete(zfsmReadIdentity($dataset)['guid']===$parentGuid&&file_get_contents($root.'/sibling/sentinel')==='outside selected target','Parent or sibling changed');
 $page=zfsmJobPage(1,100,['filter'=>'deletion','view'=>'all']);foreach($page['jobs']as$item)demandDelete($item['type']==='deletion'&&!$item['actions']['resume']&&!$item['actions']['cancel'],'Jobs presentation unsafe');demandDelete(zfsmPendingJobs()===[],'Unexpected pending jobs');
 $out=['pass'=>true,'dataset'=>$dataset,'owner_guid'=>$parentGuid,'checks'=>$checks,'jobs'=>array_map(fn($j)=>['id'=>$j['id'],'state'=>$j['state'],'stage'=>$j['stage'],'result'=>$j['result']??null],$page['jobs']),'pending'=>0,'sibling_unchanged'=>true,'integration'=>false];
}catch(Throwable$e){$out=['pass'=>false,'error'=>$e->getMessage(),'dataset'=>$dataset,'checks'=>$checks];}
file_put_contents($base.'/result.json',json_encode($out,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES));echo json_encode($out,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES)."\n";exit($out['pass']?0:1);
