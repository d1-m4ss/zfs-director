<?php
require '/app/harness.php';
function encryptionIdentity($name){$guid=$name==='cache/secure'?'100':(string)(1000+abs(crc32($name)));expectProcess('zfs',['list','-H','-p','-o','name,type,guid','-t','filesystem,volume,snapshot',$name],"$name\tfilesystem\t$guid");}
function encryptionRoot($op='lock',$mounted='yes') {
    $root='cache/secure';
    @unlink(zfsmEncryptionStateFile('100'));
    expectProcess('zfs',['list','-H','-o','name','-t','filesystem',$root],$root);
    $properties='encryption,encryptionroot,keystatus'.($op==='lock'?',mounted':'');
    $state="encryption\taes-256-gcm\nencryptionroot\t$root\nkeystatus\t".($op==='lock'?'available':'unavailable');
    if($op==='lock')$state.="\nmounted\t$mounted";
    expectProcess('zfs',['get','-H','-o','property,value',$properties,$root],$state);
    if($op==='unlock')encryptionIdentity($root);
}
function encryptionFamily($rows) {
    expectProcess('zfs',['list','-H','-r','-t','filesystem','-o','name,encryptionroot,mounted','cache/secure'],implode("\n",$rows));
    $valid=true;$seen=[];$mounted=[];
    foreach($rows as $row){$p=explode("\t",$row);if(count($p)!==3||isset($seen[$p[0]])||($p[0]!=='cache/secure'&&!str_starts_with($p[0],'cache/secure/'))||!in_array($p[2],['yes','no'],true)){ $valid=false;break;}$seen[$p[0]]=true;if($p[1]!=='cache/secure'&&$p[2]==='yes')$valid=false;if($p[1]==='cache/secure'&&$p[2]==='yes')$mounted[]=$p[0];}
    if($valid&&isset($seen['cache/secure'])){encryptionIdentity('cache/secure');usort($mounted,fn($a,$b)=>substr_count($b,'/')<=>substr_count($a,'/')?:strcmp($a,$b));foreach($mounted as $name)if($name!=='cache/secure')encryptionIdentity($name);}
}
function encryptionFailed($answer,$contains) {
    same([],$answer['succeeded']);same(true,str_contains(implode('; ',$answer['failed']),$contains));
}
check('locking refuses mounted independent roots before any unmount or key mutation',function(){
    encryptionRoot();
    encryptionFamily(["cache/secure\tcache/secure\tyes","cache/secure/child\tcache/secure\tyes","cache/secure/child/nested\tcache/secure/child/nested\tyes"]);
    encryptionFailed(lockDataset('cache/secure'),'nested encryption root');
});
check('locking unmounts inherited descendants deepest first and leaves unmounted nested roots alone',function(){
    encryptionRoot();
    encryptionFamily(["cache/secure\tcache/secure\tyes","cache/secure/child\tcache/secure\tyes","cache/secure/child/deep\tcache/secure\tyes","cache/secure/offline\tcache/secure\tno","cache/secure/nested\tcache/secure/nested\tno","cache/secure/nested/child\tcache/secure/nested\tno"]);
    foreach(['cache/secure/child/deep','cache/secure/child','cache/secure']as$name)expectProcess('zfs',['unmount',$name]);
    expectProcess('zfs',['unload-key','cache/secure']);
    same([],lockDataset('cache/secure')['failed']);
});
check('unmounted encryption root still unmounts its mounted inherited child',function(){
    encryptionRoot('lock','no');encryptionFamily(["cache/secure\tcache/secure\tno","cache/secure/child\tcache/secure\tyes"]);
    expectProcess('zfs',['unmount','cache/secure/child']);expectProcess('zfs',['unload-key','cache/secure']);
    same([],lockDataset('cache/secure')['failed']);
});
check('child unmount failure restores only descendants already unmounted and never unloads key',function(){
    encryptionRoot();encryptionFamily(["cache/secure\tcache/secure\tyes","cache/secure/child\tcache/secure\tyes","cache/secure/child/deep\tcache/secure\tyes"]);
    expectProcess('zfs',['unmount','cache/secure/child/deep']);expectProcess('zfs',['unmount','cache/secure/child'],'busy',1);
    encryptionIdentity('cache/secure/child/deep');expectProcess('zfs',['mount','cache/secure/child/deep']);
    encryptionFailed(lockDataset('cache/secure'),'busy');
});
check('unload failure restores original mounted family root first and reports failed remounts',function(){
    encryptionRoot();encryptionFamily(["cache/secure\tcache/secure\tyes","cache/secure/child\tcache/secure\tyes","cache/secure/offline\tcache/secure\tno"]);
    expectProcess('zfs',['unmount','cache/secure/child']);expectProcess('zfs',['unmount','cache/secure']);
    expectProcess('zfs',['unload-key','cache/secure'],'key busy',1);encryptionIdentity('cache/secure');expectProcess('zfs',['mount','cache/secure']);encryptionIdentity('cache/secure/child');expectProcess('zfs',['mount','cache/secure/child'],'mount busy',1);
    encryptionFailed(lockDataset('cache/secure'),'cache/secure/child');
});
foreach(['truncated','outside','duplicate','missing root','unknown mounted']as$case)check('invalid descendant inventory blocks all mutations '.$case,function()use($case){
    encryptionRoot();$row="cache/secure\tcache/secure\tyes";
    encryptionFamily(match($case){'truncated'=>[$row,'short'],'outside'=>[$row,"cache/other\tcache/secure\tyes"],'duplicate'=>[$row,$row],'missing root'=>["cache/secure/child\tcache/secure\tyes"],'unknown mounted'=>["cache/secure\tcache/secure\tmaybe"]});
    encryptionFailed(lockDataset('cache/secure'),'inventory');
});
check('key load rejection never mounts and keeps passphrase solely in stdin',function(){
    $secret='fixture-secret-key';$GLOBALS['encryption_stdin']=[];encryptionRoot('unlock');
    expectProcess('zfs',['load-key','-L','prompt','cache/secure'],'incorrect key',1);
    encryptionFailed(unlockDataset('cache/secure',$secret),'incorrect key');
    same(false,str_contains(json_encode($GLOBALS['test_calls']),$secret));same($secret."\n",end($GLOBALS['encryption_stdin']));
});
check('mount failure after loading key explicitly describes partially unlocked state',function(){
    encryptionRoot('unlock');zfsmSaveEncryptionState(['version'=>1,'root'=>'cache/secure','root_guid'=>'100','phase'=>'locked','mounts'=>[['name'=>'cache/secure','guid'=>'100']]]);expectProcess('zfs',['load-key','-L','prompt','cache/secure']);encryptionIdentity('cache/secure');expectProcess('zfs',['get','-H','-o','property,value','encryptionroot,mounted','cache/secure'],"encryptionroot\tcache/secure\nmounted\tno");expectProcess('zfs',['mount','cache/secure'],'mount busy',1);
    encryptionFailed(unlockDataset('cache/secure','fixture-secret-key'),'key is loaded');
});
function encryptionThrow($args) {
    expectProcess('zfs',$args);$last=array_key_last($GLOBALS['test_responses']);$GLOBALS['test_responses'][$last][2]['throw']=true;
}
check('thrown unmount transport failure still restores descendants already unmounted',function(){
    encryptionRoot();encryptionFamily(["cache/secure\tcache/secure\tyes","cache/secure/child\tcache/secure\tyes"]);
    expectProcess('zfs',['unmount','cache/secure/child']);encryptionThrow(['unmount','cache/secure']);encryptionIdentity('cache/secure/child');expectProcess('zfs',['mount','cache/secure/child']);
    $answer=lockDataset('cache/secure');encryptionFailed($answer,'communication failed');same(false,str_contains(json_encode($answer),'fixture-private-key'));
});
check('thrown unload failure restores family and thrown remount failure does not skip other mounts',function(){
    encryptionRoot();encryptionFamily(["cache/secure\tcache/secure\tyes","cache/secure/child\tcache/secure\tyes"]);
    expectProcess('zfs',['unmount','cache/secure/child']);expectProcess('zfs',['unmount','cache/secure']);encryptionThrow(['unload-key','cache/secure']);
    encryptionIdentity('cache/secure');encryptionThrow(['mount','cache/secure']);encryptionIdentity('cache/secure/child');expectProcess('zfs',['mount','cache/secure/child']);
    $answer=lockDataset('cache/secure');encryptionFailed($answer,'remount failed: cache/secure');same(false,str_contains(json_encode($answer),'fixture-private-key'));
});
finishTests();
