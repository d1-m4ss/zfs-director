<?php
require __DIR__.'/protection-bootstrap.php';
nativeCheck('native reviewed promote preserves moved snapshot GUIDs and reverses origin',function(){
    $original='director_it_1018/promote-origin';$clone='director_it_1018/promote-clone';
    if(!zfsmDatasetExists($original)){nativeCommand(['create',$original]);nativeCommand(['snapshot',$original.'@first']);nativeCommand(['snapshot',$original.'@fork']);nativeCommand(['clone',$original.'@fork',$clone]);nativeCommand(['snapshot',$original.'@later']);}
    $scope=zfsmPromoteScope($clone);nativeExpect(count($scope['affected_snapshots'])===2,'Wrong moved snapshot scope');$preview=zfsmOperationPreview($scope,'native-secret');$answer=zfsmCommitPromote($preview+['zdataset'=>$clone],'native-secret');nativeExpect(!$answer['failed'],json_encode($answer));return ['scope'=>$scope,'answer'=>$answer];
});
nativeCheck('native user group and object quotas are capability probed reviewed and read back',function(){
    $name='director_it_1018/quotas';if(!zfsmDatasetExists($name))nativeCommand(['create',$name]);$overview=zfsmQuotaOverview($name);nativeExpect($overview['status']==='known',json_encode($overview));$out=[];
    foreach(['user'=>['99','1048576'],'group'=>['100','2097152'],'userobj'=>['99','16'],'groupobj'=>['100','32']] as $kind=>[$id,$value]){
        nativeExpect($overview['capabilities'][$kind]===true,'Expected quota capability unavailable: '.$kind);$data=compact('kind','id','value');$scope=zfsmQuotaScope($name,$data);$p=zfsmOperationPreview($scope,'native-secret');$answer=zfsmCommitQuota($p+['zdataset'=>$name,'data'=>$data],'native-secret');nativeExpect(!$answer['failed'],json_encode($answer));$out[$kind]=$answer;
    }return ['overview'=>$overview,'changes'=>$out,'after'=>zfsmQuotaOverview($name)];
});
exit(array_filter($results,fn($r)=>$r['status']!=='PASS')?1:0);
