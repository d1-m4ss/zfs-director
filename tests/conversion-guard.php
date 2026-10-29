<?php
require '/app/harness.php';
$GLOBALS['plugin_state']='/jobs';$GLOBALS['plugin_runtime']='/runtime';$GLOBALS['zfsm_boot_id']='test-boot';
@mkdir('/jobs',0700,true);@mkdir('/runtime',0700,true);
$id='20261028-003433-181e6b25db85';$source='/mnt/cache/zfs/random';$dataset='cache/zfs/random';$staging='/var/tmp/zfs.master.ui/conversions/'.$id;
function conversionJob($state='recovery_required',$stage='source_retained'){
 global $id,$source,$dataset,$staging;
 return ['schema'=>1,'method'=>'confined-v1','type'=>'conversion','id'=>$id,'state'=>$state,'stage'=>$stage,'source'=>$source,'source_identity'=>['dev'=>'50','ino'=>'70'],'recovery'=>zfsmConversionRecoveryPath($source,$id),'dataset'=>$dataset,'owner_dataset'=>'cache/zfs','owner_guid'=>'1328257103549034369','owner_mountpoint'=>'/mnt/cache/zfs','pool'=>'cache','staging'=>$staging,'ack_boot'=>'test-boot','cancel_requested'=>false,'created'=>'2026-10-28T00:34:33+00:00','updated'=>'2026-10-28T00:40:52+00:00','target_guid'=>'14242478802561574822','copy_manifest_sha256'=>str_repeat('a',64),'error'=>'verification failed'];
}
function writeJob($job){zfsmJobAtomicWrite(zfsmJobFile($job['id']),$job);}
function targetState($mountpoint,$canmount='noauto'){global $id,$dataset;expectProcess('zfs',['get','-H','-o','property,value','mountpoint,canmount,zfs.master.ui:conversion-job',$dataset],"mountpoint\t$mountpoint\ncanmount\t$canmount\nzfs.master.ui:conversion-job\t$id\n");}
function noMounts(){expectProcess('zfs',['list','-H','-o','name,mountpoint,mounted','-t','filesystem'],'');}
function rejected($fn,$pattern){try{$fn();}catch(RuntimeException$e){if(!preg_match($pattern,$e->getMessage()))throw new LogicException('Unexpected refusal: '.$e->getMessage());return;}throw new LogicException('Expected refusal');}
function clearJobs(){foreach(glob('/jobs/*.json')?:[] as $f)unlink($f);foreach([$GLOBALS['source'],zfsmConversionRecoveryPath($GLOBALS['source'],$GLOBALS['id'])] as $d)if(is_dir($d))rmdir($d);}

check('unpublished conversion blocks deleting, moving or converting its retained original and descendants',function(){
 global $source,$staging;clearJobs();writeJob(conversionJob());
 foreach(['deletedirectory','movedirectory','convertdirectory'] as $command){targetState($staging.'/target');noMounts();rejected(fn()=>zfsmConversionMutationGuard($command,['directory'=>$source]),'/has not published cache\/zfs\/random/');}
 targetState($staging.'/target');noMounts();rejected(fn()=>zfsmConversionMutationGuard('deletedirectory',['directory'=>$source.'/sub']),'/retained original/');
 targetState($staging.'/target');noMounts();rejected(fn()=>zfsmConversionMutationGuard('deletedirectory',['directory'=>zfsmConversionRecoveryPath($source,$GLOBALS['id'])]),'/retained original/');
 targetState($staging.'/target');noMounts();zfsmConversionMutationGuard('deletedirectory',['directory'=>'/mnt/cache/zfs/random-other']);
});
check('target dataset of an unresolved conversion cannot be destroyed when no original remains',function(){
 global $source,$staging;clearJobs();writeJob(conversionJob());
 targetState($staging.'/target');rejected(fn()=>zfsmConversionMutationGuard('destroydataset',['zdataset'=>'cache/zfs/random']),'/only copy/');
 targetState($staging.'/target');rejected(fn()=>zfsmConversionMutationGuard('destroydataset',['zdataset'=>'cache/zfs']),'/only copy/');
 mkdir($source,0755,true);targetState($staging.'/target');zfsmConversionMutationGuard('destroydataset',['zdataset'=>'cache/zfs/random']);
 targetState($staging.'/target');zfsmConversionMutationGuard('destroydataset',['zdataset'=>'cache/zfs/random-other']);
});
check('published, completed, planned or unowned conversions do not block operations',function(){
 global $source;clearJobs();writeJob(conversionJob());
 targetState($source,'on');noMounts();zfsmConversionMutationGuard('deletedirectory',['directory'=>$source]);
 clearJobs();writeJob(conversionJob('completed','complete_source_retained'));zfsmConversionMutationGuard('deletedirectory',['directory'=>$source]);
 clearJobs();writeJob(conversionJob('cancelled','planned'));zfsmConversionMutationGuard('deletedirectory',['directory'=>$source]);
 clearJobs();writeJob(conversionJob());expectProcess('zfs',['get','-H','-o','property,value','mountpoint,canmount,zfs.master.ui:conversion-job','cache/zfs/random'],"mountpoint\t/x\ncanmount\tnoauto\nzfs.master.ui:conversion-job\tother\n");zfsmConversionMutationGuard('deletedirectory',['directory'=>$source]);
 clearJobs();writeJob(conversionJob());zfsmConversionMutationGuard('snapshotdataset',['zdataset'=>'cache/zfs/random']);
});
check('publish action is offered only for a verified copy whose original path is free',function(){
 global $source;clearJobs();$job=conversionJob();writeJob($job);same(null,zfsmJobProblem($job));
 same(true,zfsmJobPresentation($job,zfsmJobFile($job['id']),false)['actions']['publish']);
 $unverified=$job;unset($unverified['copy_manifest_sha256']);same(false,zfsmJobPresentation($unverified,zfsmJobFile($job['id']),false)['actions']['publish']);
 same(false,zfsmJobPresentation(conversionJob('failed'),zfsmJobFile($job['id']),false)['actions']['publish']);
 mkdir($source,0755,true);same(false,zfsmJobPresentation($job,zfsmJobFile($job['id']),false)['actions']['publish']);
});
check('publish refuses an occupied original path or a job that is not awaiting recovery before any ZFS change',function(){
 global $source;clearJobs();writeJob(conversionJob('completed','complete_source_retained'));
 try{zfsmPublishConversion($GLOBALS['id']);throw new LogicException('Expected refusal');}catch(InvalidArgumentException$e){}
 clearJobs();writeJob(conversionJob());mkdir($source,0755,true);
 try{zfsmPublishConversion($GLOBALS['id']);throw new LogicException('Expected refusal');}catch(InvalidArgumentException$e){same(1,preg_match('/occupied/',$e->getMessage()));}
 same([],$GLOBALS['test_calls']);clearJobs();
});
finishTests();
