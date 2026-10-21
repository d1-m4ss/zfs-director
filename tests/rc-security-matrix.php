<?php
require '/app/harness.php';
$GLOBALS['plugin_runtime']='/rc-security-runtime';
function matrixRefuses($fn,$pattern='/identity.*changed|changed.*identity/i') {
    try{$fn();}catch(Throwable$error){if(!preg_match($pattern,$error->getMessage()))throw $error;return;}
    throw new RuntimeException('Guard did not refuse the changed reviewed target');
}
function matrixIdentity($name,$guid='22') {
    expectProcess('zfs',['list','-H','-p','-o','name,type,guid','-t','filesystem,volume,snapshot',$name],$name."\t".(str_contains($name,'@')?'snapshot':'filesystem')."\t".$guid);
}
function matrixNoMutation() {
    foreach($GLOBALS['test_calls']as[$command,$args]){
        same('zfs',$command);
        same(true,in_array($args[0],['list','get','holds'],true)||($args[0]==='destroy'&&in_array('-nvp',$args,true)));
    }
}
$datasets=['editdatasetproperty','adddirectortlisting','removedirectorylisting','renamedataset','destroydataset','lockdataset','unlockdataset','promotedataset','snapshotdataset'];
foreach($datasets as$command)check('changed dataset GUID blocks '.$command,function()use($command){
    matrixIdentity('cache/data');matrixRefuses(fn()=>zfsmGuardMutationIdentity($command,['zdataset'=>'cache/data','expected_guid'=>'11']));same(1,count($GLOBALS['test_calls']));matrixNoMutation();
});
check('changed dataset GUID blocks quota edit before any set command',function(){
    matrixIdentity('cache/data');matrixRefuses(fn()=>zfsmGuardMutationIdentity('editdatasetproperty',['zdataset'=>'cache/data','expected_guid'=>'11','property'=>'quota','value'=>'1G']));matrixNoMutation();
});
foreach(['renamesnapshot','holdsnapshot','releasesnapshot','clonesnapshot','destroysnapshot','rollbacksnapshot']as$command)check('changed snapshot GUID blocks '.$command,function()use($command){
    matrixIdentity('cache/data@saved');matrixRefuses(fn()=>zfsmGuardMutationIdentity($command,['snapshot'=>'cache/data@saved','snapshot_guid'=>'11']));same(1,count($GLOBALS['test_calls']));matrixNoMutation();
});
foreach(['createdataset','clonesnapshot','renamedataset']as$command)check('changed destination parent GUID blocks '.$command,function()use($command){
    $fields=['parent_name'=>'cache/destination','parent_guid'=>'11'];
    if($command==='createdataset')$fields['data']=['zpool'=>'cache','name'=>'destination/new'];
    if($command==='clonesnapshot'){$fields+=['snapshot'=>'cache/data@saved','snapshot_guid'=>'99','clone'=>'cache/destination/new'];matrixIdentity('cache/data@saved','99');}
    if($command==='renamedataset'){$fields+=['zdataset'=>'cache/data','expected_guid'=>'99','newname'=>'cache/destination/new'];matrixIdentity('cache/data','99');}
    matrixIdentity('cache/destination');matrixRefuses(fn()=>zfsmGuardMutationIdentity($command,$fields));matrixNoMutation();
});
@mkdir('/proc/self',0755,true);@mkdir('/matrix-files/source',0755,true);chmod('/matrix-files',0755);chmod('/matrix-files/source',0755);chmod('/',0755);
file_put_contents('/proc/self/mountinfo',"1 0 0:1 / / rw - tmpfs tmpfs rw\n2 1 0:2 / /matrix-files rw - zfs cache/data rw\n");
foreach(['movedirectory','deletedirectory','convertdirectory']as$command){
    check('changed owning dataset GUID blocks '.$command,function()use($command){
        expectProcess('zfs',['list','-H','-o','name,mountpoint,mounted','-t','filesystem'],"cache/data\t/matrix-files\tyes");matrixIdentity('cache/data');
        matrixRefuses(fn()=>zfsmGuardMutationIdentity($command,['directory'=>'/matrix-files/source','expected_guid'=>'11','directory_identity'=>zfsmDirectoryIdentity('/matrix-files/source')]));matrixNoMutation();
    });
    check('replaced directory inode blocks '.$command,function()use($command){
        $identity=zfsmDirectoryIdentity('/matrix-files/source');rename('/matrix-files/source','/matrix-files/retained-'.$command);mkdir('/matrix-files/source',0755);
        expectProcess('zfs',['list','-H','-o','name,mountpoint,mounted','-t','filesystem'],"cache/data\t/matrix-files\tyes");matrixIdentity('cache/data','11');
        matrixRefuses(fn()=>zfsmGuardMutationIdentity($command,['directory'=>'/matrix-files/source','expected_guid'=>'11','directory_identity'=>$identity]));same(true,is_dir('/matrix-files/retained-'.$command));matrixNoMutation();
    });
}
function matrixDestroyRead($changes=[],$holds='') {
    $rows=array_replace(['cache'=>"cache\tfilesystem\t1\t-\t/mnt/cache\t-\t-\t-",'cache/data'=>"cache/data\tfilesystem\t11\t-\t/mnt/cache/data\t-\t-\t-",'cache/data@saved'=>"cache/data@saved\tsnapshot\t99\t-\t-\t-\t0\toff"],$changes);
    expectProcess('zfs',['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o','name,type,guid,origin,mountpoint,encryptionroot,userrefs,defer_destroy','cache'],implode("\n",$rows));
    ksort($rows);foreach($rows as$name=>$row)if(str_contains($name,'@')&&(str_starts_with($name,'cache/data@')||str_starts_with($name,'cache/data/')))expectProcess('zfs',['holds','-H',$name],$name==='cache/data@saved'?$holds:'');
    expectProcess('zfs',['destroy','-nvp','-r','-f','cache/data'],"destroy\tcache/data@saved\ndestroy\tcache/data\nreclaim\t0");
}
foreach(['new hold','new external clone','new dependent snapshot','new child dataset']as$case)check('destroy confirmation refuses '.$case.' despite identical dry run',function()use($case){
    matrixDestroyRead();$preview=zfsmPreviewDestroy('cache/data','1','matrix-secret');same(true,$preview['can_destroy']);
    $changes=match($case){'new hold'=>[], 'new external clone'=>['cache/externalclone'=>"cache/externalclone\tfilesystem\t66\tcache/data@saved\t/mnt/cache/externalclone\t-\t-\t-"], 'new dependent snapshot'=>['cache/data@new'=>"cache/data@new\tsnapshot\t67\t-\t-\t-\t0\toff"], 'new child dataset'=>['cache/data/new'=>"cache/data/new\tfilesystem\t68\t-\t/mnt/cache/data/new\t-\t-\t-"]};
    matrixDestroyRead($changes,$case==='new hold'?"cache/data@saved\texternal-hold\tFri Oct 16 11:26 2026":'');
    matrixRefuses(fn()=>zfsmValidateDestroyPreview('cache/data','1','matrix-secret',$preview['preview_id'],$preview['token']),'/dependencies.*changed|identity.*changed|blocked/i');same(true,is_file(zfsmDestroyPreviewFile($preview['preview_id'])));matrixNoMutation();
});
function matrixSettings($changes=[]) {return array_replace(['refresh_interval'=>'30','lazy_load'=>'0','sanoid_integration'=>'0','destructive_mode'=>'0','exclusion'=>'','directory_listing'=>'','snap_max_days_alert'=>'30','snap_pattern'=>'Y-m-d-His','snap_prefix'=>'auto-'],$changes);}
foreach(['exclusion'=>str_repeat('a',1025),'directory_listing'=>str_repeat('a',16385),'snap_prefix'=>str_repeat('a',129),'snap_pattern'=>str_repeat('Y',129),'snap_max_days_alert'=>'36501','refresh_interval'=>'2147483647','destructive_mode'=>'2']as$field=>$value)check('settings boundary rejects '.$field.' without processes',function()use($field,$value){
    $answer=zfsmValidateSettings(matrixSettings([$field=>$value]));same(false,$answer['valid']);same(true,isset($answer['errors'][$field]));same([],$GLOBALS['test_calls']);
});
check('legacy exclusion spelling loads without losing old snapshot defaults',function(){
    $loaded=loadConfig(['general'=>['exclussion'=>'^cache/legacy','snap_pattern'=>'','directory_listing'=>"cache/data\ncache/secure"]]);same('^cache/legacy',$loaded['dataset_exclusion']);same('Y-m-d-His',$loaded['snap_pattern']);same(['cache/data','cache/secure'],$loaded['directory_listing']);same(0,$loaded['destructive_mode']);same([],$GLOBALS['test_calls']);
});
check('explicit exclusion overrides legacy spelling and absent configuration defaults safely',function(){
    same('new',loadConfig(['general'=>['exclussion'=>'old','exclusion'=>'new']])['dataset_exclusion']);$loaded=loadConfig(null);same(30,$loaded['refresh_interval']);same(0,$loaded['destructive_mode']);same([],$loaded['directory_listing']);same([],$GLOBALS['test_calls']);
});
finishTests();
