<?php
require '/app/harness.php';
$GLOBALS['plugin_runtime']='/identity-runtime';
function rejected($fn,$pattern) { try {$fn();} catch(Throwable $e) { if(!preg_match($pattern,$e->getMessage()))throw $e;return;}throw new RuntimeException('Expected refusal'); }
function identityRead($guid='18446744073709551615',$name='cache/data') {
    expectProcess('zfs',['list','-H','-p','-o','name,type,guid','-t','filesystem,volume,snapshot',$name],$name."\tfilesystem\t".$guid);
}
function destroyRead($changes=[]) {
    $rows=array_replace([
        'cache'=>"cache\tfilesystem\t1\t-\t/mnt/cache\t-\t-\t-",
        'cache/data'=>"cache/data\tfilesystem\t18446744073709551615\t-\t/mnt/cache/data\t-\t-\t-",
        'cache/data@s1'=>"cache/data@s1\tsnapshot\t99\t-\t-\t-\t0\toff",
    ],$changes);
    expectProcess('zfs',['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o','name,type,guid,origin,mountpoint,encryptionroot,userrefs,defer_destroy','cache'],implode("\n",$rows));
    foreach($rows as $name=>$row)if(str_contains($name,'@'))expectProcess('zfs',['holds','-H',$name],'');
    expectProcess('zfs',['destroy','-nvp','-r','-f','cache/data'],"destroy\tcache/data@s1\ndestroy\tcache/data\nreclaim\t0");
}
check('identity preserves unsigned GUID and requires exact name',function(){identityRead();same('18446744073709551615',zfsmReadIdentity('cache/data')['guid']);});
check('same name replacement is refused',function(){identityRead('22');rejected(fn()=>zfsmRequireIdentity('cache/data','18446744073709551615'),'/identity|changed/i');});
check('missing expected identity fails before any process',function(){rejected(fn()=>zfsmRequireIdentity('cache/data',''),'/identity|refresh/i');same([],$GLOBALS['test_calls']);});
check('missing or malformed live identity is refused',function(){identityRead('bad');rejected(fn()=>zfsmReadIdentity('cache/data'),'/identity|malformed/i');});
check('preview binds GUID, expiry, descendants and exact flags',function(){destroyRead();$p=zfsmPreviewDestroy('cache/data','1','secret');same(true,$p['can_destroy']);same(2,count($p['objects']));same('18446744073709551615',$p['objects'][0]['guid']);same(true,$p['expires']>time());same(true,isset($p['preview_id']));});
check('changed GUID rejects identical dry run',function(){destroyRead();$p=zfsmPreviewDestroy('cache/data','1','secret');destroyRead(['cache/data'=>"cache/data\tfilesystem\t22\t-\t/mnt/cache/data\t-\t-\t-"]);rejected(fn()=>zfsmValidateDestroyPreview('cache/data','1','secret',$p['preview_id'],$p['token']),'/changed/i');});
check('expiry rejected before reading objects',function(){destroyRead();$p=zfsmPreviewDestroy('cache/data','1','secret');$f=zfsmDestroyPreviewFile($p['preview_id']);$record=json_decode(file_get_contents($f),true);$record['expires']=time()-1;file_put_contents($f,json_encode($record));rejected(fn()=>zfsmValidateDestroyPreview('cache/data','1','secret',$p['preview_id'],$p['token']),'/expired/i');});
check('signature tampering rejected before reading objects',function(){destroyRead();$p=zfsmPreviewDestroy('cache/data','1','secret');rejected(fn()=>zfsmValidateDestroyPreview('cache/data','1','secret',$p['preview_id'],str_repeat('a',64)),'/signature|confirmation/i');});
check('changed children reject the confirmed scope',function(){destroyRead();$p=zfsmPreviewDestroy('cache/data','1','secret');destroyRead(['cache/data/new'=>"cache/data/new\tfilesystem\t23\t-\t/mnt/cache/data/new\t-\t-\t-"]);rejected(fn()=>zfsmValidateDestroyPreview('cache/data','1','secret',$p['preview_id'],$p['token']),'/changed/i');});
check('one successful validation consumes preview; replay refused',function(){destroyRead();$p=zfsmPreviewDestroy('cache/data','1','secret');destroyRead();$validated=zfsmValidateDestroyPreview('cache/data','1','secret',$p['preview_id'],$p['token']);same('cache/data',$validated['target']);rejected(fn()=>zfsmValidateDestroyPreview('cache/data','1','secret',$p['preview_id'],$p['token']),'/missing|used|expired/i');});
check('unsupported flags and pool root never expand deletion',function(){rejected(fn()=>zfsmPreviewDestroy('cache','1','secret'),'/root|child/i');rejected(fn()=>zfsmPreviewDestroy('cache/data','-R','secret'),'/flag|choice/i');same([],$GLOBALS['test_calls']);});
check('new destination ancestor cannot silently change inheritance',function(){
    identityRead('1','cache');
    expectProcess('zfs',['list','-H','-r','-t','filesystem,volume','-o','name','cache'],"cache\ncache/new");
    rejected(fn()=>zfsmGuardMutationIdentity('createdataset',['data'=>['zpool'=>'cache','name'=>'new/child'],'parent_name'=>'cache','parent_guid'=>'1']),'/parent.*changed|parent.*appeared/i');
});
check('implicit missing destination parents remain supported when still absent',function(){
    identityRead('1','cache');
    expectProcess('zfs',['list','-H','-r','-t','filesystem,volume','-o','name','cache'],"cache\ncache/unrelated");
    zfsmGuardMutationIdentity('createdataset',['data'=>['zpool'=>'cache','name'=>'new/child'],'parent_name'=>'cache','parent_guid'=>'1']);
});
check('one snapshot preview does not query holds on unrelated snapshots',function(){
    $rows=["cache\tfilesystem\t1\t-\t/mnt/cache\t-\t-\t-","cache/data@s1\tsnapshot\t99\t-\t-\t-\t0\toff"];
    for($i=0;$i<2000;$i++)$rows[]="cache/other@unrelated$i\tsnapshot\t".($i+100)."\t-\t-\t-\t0\toff";
    expectProcess('zfs',['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o','name,type,guid,origin,mountpoint,encryptionroot,userrefs,defer_destroy','cache'],implode("\n",$rows));
    expectProcess('zfs',['holds','-H','cache/data@s1'],'');expectProcess('zfs',['destroy','-nvp','cache/data@s1'],"destroy\tcache/data@s1\nreclaim\t0");
    $scope=zfsmDestroyScope('cache/data@s1',false);same(true,$scope['can_destroy']);same(3,count($GLOBALS['test_calls']));
});
check('expiry cleanup removes abandoned reviews but preserves live confirmations',function(){
    $expired=zfsmDestroyPreviewFile(str_repeat('c',32));$live=zfsmDestroyPreviewFile(str_repeat('d',32));
    file_put_contents($expired,json_encode(['expires'=>time()-1]));file_put_contents($live,json_encode(['expires'=>time()+600]));
    zfsmPruneDestroyPreviews();same(false,is_file($expired));same(true,is_file($live));
});
check('snapshot user hold blocks destruction even if dry run is misleading',function(){
    destroyRead(['cache/data@s1'=>"cache/data@s1\tsnapshot\t99\t-\t-\t-\t1\toff"]);
    same(false,zfsmPreviewDestroy('cache/data','1','secret')['can_destroy']);
});
check('recursive destruction includes internal clones without inventing external dependencies',function(){
    destroyRead(['cache/data/clone'=>"cache/data/clone\tfilesystem\t23\tcache/data@s1\t/mnt/cache/data/clone\t-\t-\t-"]);
    $scope=zfsmDestroyScope('cache/data',true);
    same(true,$scope['can_destroy']);same([],array_column($scope['dependencies'],'name'));
    same(['cache/data','cache/data/clone','cache/data@s1'],array_column($scope['objects'],'name'));
});
check('clone outside confirmed recursive scope still blocks destruction',function(){
    destroyRead(['cache/outside'=>"cache/outside\tfilesystem\t23\tcache/data@s1\t/mnt/cache/outside\t-\t-\t-"]);
    $scope=zfsmDestroyScope('cache/data',true);
    same(false,$scope['can_destroy']);same(['cache/outside'],array_column($scope['dependencies'],'name'));
    same(['cache/data','cache/data@s1'],array_column($scope['objects'],'name'));
});
finishTests();
