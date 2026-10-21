<?php
require '/app/harness.php';
$scope=['target'=>'cache/data','objects'=>[['name'=>'cache/data','guid'=>'11','type'=>'filesystem'],['name'=>'cache/data@s1','guid'=>'12','type'=>'snapshot']]];
check('busy error does not include the verbose destruction plan',function(){
 $r=zfsmDestroyCommandResult('cache/data',['code'=>1,'output'=>"cannot destroy 'cache/data': dataset is busy\nwill destroy cache/data@s1\nwill destroy cache/data\nreclaim\t42"]);
 same(false,str_contains($r['failed']['cache/data'],'will destroy'));same(true,str_contains($r['failed']['cache/data'],'busy'));same(1,$r['destruction']['exit_code']);same(2,count($r['destruction']['plan_output']));
});
check('partial destroy verifies removed and surviving GUIDs without replaying commands',function()use($scope){
 expectProcess('zfs',['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o','name,guid','cache'],"cache\t1\ncache/data\t11");
 $r=zfsmDestroyCommandResult('cache/data',['code'=>1,'output'=>"cannot destroy 'cache/data': dataset is busy\nwill destroy cache/data@s1"],$scope);
 same(['cache/data@s1'],$r['destruction']['removed']);same(['cache/data'],$r['destruction']['remaining']);same('Destroyed; absence verified',$r['succeeded']['cache/data@s1']);same(true,$r['destruction']['state_verified']);
});
check('same-name replacement is never reported as removed',function()use($scope){
 expectProcess('zfs',['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o','name,guid','cache'],"cache\t1\ncache/data\t99\ncache/data@s1\t12");
 $r=zfsmDestroyCommandResult('cache/data',['code'=>0,'output'=>''],$scope);same(['cache/data'],$r['destruction']['changed']);same([],array_keys($r['succeeded']));same(true,isset($r['failed']['cache/data']));
});
check('failed readback does not invent successful deletion or retry',function()use($scope){
 expectProcess('zfs',['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o','name,guid','cache'],'unavailable',1);
 $r=zfsmDestroyCommandResult('cache/data',['code'=>1,'output'=>'busy'],$scope);same(false,$r['destruction']['state_verified']);same([],$r['succeeded']);same(1,count($GLOBALS['test_calls']));
});
check('nonzero exit with empty errors stays failed; plan is never success evidence',function(){
 $r=zfsmDestroyCommandResult('cache/data',['code'=>2,'output'=>'will destroy cache/data']);same(true,isset($r['failed']['cache/data']));same([],$r['succeeded']);
});
check('recursive snapshot deletion reports verified partial state instead of losing it',function(){
 $scope=['target'=>'cache/data@s1','objects'=>[['name'=>'cache/data@s1','guid'=>'12','type'=>'snapshot'],['name'=>'cache/data/child@s1','guid'=>'13','type'=>'snapshot']]];
 expectProcess('zfs',['list','-H','-o','name','-t','snapshot','cache/data@s1'],'cache/data@s1');
 expectProcess('zfs',['destroy','-r','cache/data@s1'],"cannot destroy 'cache/data/child@s1': dataset is busy",1);
 expectProcess('zfs',['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o','name,guid','cache'],"cache\t1\ncache/data/child@s1\t13");
 $r=deleteDatasetSnapshot('cache/data@s1','1',$scope);same(['cache/data@s1'],$r['destruction']['removed']);same(['cache/data/child@s1'],$r['destruction']['remaining']);
});
check('renamed reviewed GUID is not reported as destroyed',function()use($scope){
 expectProcess('zfs',['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o','name,guid','cache'],"cache\t1\ncache/renamed\t11\ncache/data@s1\t12");
 $r=zfsmDestroyCommandResult('cache/data',['code'=>1,'output'=>'concurrent change'],$scope);same([],$r['destruction']['removed']);same(['cache/data'],$r['destruction']['changed']);
});
check('pool-root snapshot readback uses its pool rather than snapshot as root',function(){
 expectProcess('zfs',['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o','name,guid','cache'],"cache\t1");
 $r=zfsmDestroyCommandResult('cache@s1',['code'=>0,'output'=>''],['objects'=>[['name'=>'cache@s1','guid'=>'12','type'=>'snapshot']]]);same(true,$r['destruction']['state_verified']);same(['cache@s1'],$r['destruction']['removed']);
});
finishTests();
