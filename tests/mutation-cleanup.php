<?php
require '/app/harness.php';
check('cleanup only accepts exact top-level mutation container names',function(){
 same(true,zfsmCleanupName('.zfsm-mutation-'.str_repeat('a',48)));
 foreach(['ordinary','.zfsm-maintenance','.zfsm-mutation-abc','sub/.zfsm-mutation-'.str_repeat('a',48),'.zfsm-mutation-'.str_repeat('a',48).'/']as$n)same(false,zfsmCleanupName($n));
});
check('cleanup preview binds digest identities target expiry and single use',function(){
 $GLOBALS['plugin_runtime']='/cleanup-runtime';$scope=['kind'=>'cleanup','name'=>'cache/data','directory'=>'/mnt/cache/data/.zfsm-mutation-'.str_repeat('a',48),'guid'=>'12','journal_sha256'=>str_repeat('b',64),'can_proceed'=>true];
 $p=zfsmOperationPreview($scope,'secret');$request=['preview_id'=>$p['preview_id'],'token'=>$p['token']];
 try{zfsmOperationConsume($request,'wrong',$scope);throw new Exception('accepted bad token');}catch(RuntimeException$e){same(true,str_contains($e->getMessage(),'Review expired'));}
 foreach(['guid','directory','journal_sha256']as$key){$changed=$scope;$changed[$key].='changed';try{zfsmOperationConsume($request,'secret',$changed);throw new Exception('accepted changed scope');}catch(RuntimeException$e){same(true,str_contains($e->getMessage(),'Review expired'));}}
 same($scope,zfsmOperationConsume($request,'secret',$scope));
 try{zfsmOperationConsume($request,'secret',$scope);throw new Exception('accepted replay');}catch(RuntimeException$e){same(true,str_contains($e->getMessage(),'already consumed'));}
});
check('cleanup rejects expired correctly signed review',function(){
 $scope=['kind'=>'cleanup'];$p=zfsmOperationPreview($scope,'secret');$file=$GLOBALS['plugin_runtime'].'/protection-previews/'.$p['preview_id'].'.json';$r=json_decode(file_get_contents($file),true);$r['expires']=time()-1;zfsmJobAtomicWrite($file,$r);$token=hash_hmac('sha256',$p['preview_id'].json_encode($r,JSON_THROW_ON_ERROR),'secret');
 try{zfsmOperationConsume(['preview_id'=>$p['preview_id'],'token'=>$token],'secret',$scope);throw new Exception('accepted expired review');}catch(RuntimeException$e){same(true,str_contains($e->getMessage(),'Review expired'));}
});
check('cleanup refuses all unfinished or unknown jobs before native work',function(){
 $GLOBALS['plugin_state']='/cleanup-state';zfsmJobDirectory($GLOBALS['plugin_state']);
 foreach(['queued','running','failed','recovery_required']as$s){file_put_contents('/cleanup-state/a.json',json_encode(['schema'=>1,'state'=>$s]));try{zfsmCleanupRequireIdle();throw new Exception('accepted unfinished job');}catch(RuntimeException$e){same(true,str_contains($e->getMessage(),'Jobs'));}}
 file_put_contents('/cleanup-state/a.json','broken');try{zfsmCleanupRequireIdle();throw new Exception('accepted corrupt job');}catch(RuntimeException$e){same(true,str_contains($e->getMessage(),'Jobs'));}
 file_put_contents('/cleanup-state/a.json',json_encode(['schema'=>1,'state'=>'completed']));try{zfsmCleanupRequireIdle();throw new Exception('accepted malformed completed job');}catch(RuntimeException$e){same(true,str_contains($e->getMessage(),'Jobs'));}unlink('/cleanup-state/a.json');
});
finishTests();
