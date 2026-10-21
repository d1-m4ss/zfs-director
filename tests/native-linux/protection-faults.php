<?php
require __DIR__.'/protection-bootstrap.php';
$src='director_it_1018/faults';$dst='director_rt_1018/partial';
$probe=runProcess('zfs',['list','-H','-o','name',$src]);if($probe['code']!==0)nativeCommand(['create',$src]);
$mount=nativeCommand(['get','-H','-o','value','mountpoint',$src]);if(!is_file($mount.'/large.bin')){$h=fopen($mount.'/large.bin','wb');for($n=0;$n<16;$n++)fwrite($h,random_bytes(1048576));fclose($h);}
$definition=zfsmSyncoidJob(['id'=>'a4','source'=>$src,'target'=>$dst,'source_guid'=>zfsmReadIdentity($src)['guid'],'bandwidth'=>'512k']);$s=zfsmProtectionReadStore();$s['replications']['a4']=$definition;zfsmProtectionWriteStore($s);
function interruptNativeTransfer($source,$target){
 global$base;$s=zfsmProtectionReadStore();$j=zfsmNewProtectionJob('replication',$s['replications']['a4']);zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);
 $p=proc_open(['/usr/bin/php',__DIR__.'/protection-one.php',$j['id']],[0=>['file','/dev/null','r'],1=>['file',$base.'/'.$j['id'].'.log','a'],2=>['redirect',1]],$pipes);nativeExpect(is_resource($p),'Could not start owned native worker');$deadline=microtime(true)+180;$receiving=false;
 while(microtime(true)<$deadline){$live=zfsmReadJob($j['id']);if($live['state']==='running'){$r=runProcess('pgrep',['-a','-x','zfs']);if(preg_match('/\bzfs\s+(?:receive|recv)\b[^\r\n]*'.preg_quote($target,'/').'(?:\s|$)/',$r['output'])){$receiving=true;break;}}if(!proc_get_status($p)['running'])break;usleep(200000);}
 nativeExpect($receiving,'Transfer did not reach receiver state before timeout');usleep(1000000);
 $guarded=false;try{zfsmProtectionMutationGuard('destroydataset',['zdataset'=>$source]);}catch(RuntimeException$e){$guarded=true;}nativeExpect($guarded,'Source mutation was not blocked during transfer');
 zfsmProtectionCancel($j['id']);$deadline=microtime(true)+90;while(proc_get_status($p)['running']&&microtime(true)<$deadline)usleep(200000);nativeExpect(!proc_get_status($p)['running'],'Owned worker did not finish cancellation');proc_close($p);$after=zfsmReadJob($j['id']);nativeExpect($after['verified_outcome']==='interrupted',json_encode($after['verification']));return $after['verification'];
}
nativeCheck('isolated cancellation preserves unrelated process',function(){
 $other=proc_open(['/bin/sleep','30'],[0=>['file','/dev/null','r'],1=>['file','/dev/null','w'],2=>['file','/dev/null','w']],$pipes);$at=microtime(true);
 try{$r=zfsmStreamProcess('/bin/sh',['-c','sleep 30 & wait'],fn($chunk)=>null,fn()=>microtime(true)-$at>0.3,null,null,true);nativeExpect($r['cancelled']===true,'Cancellation was not observed');nativeExpect(proc_get_status($other)['running'],'Unrelated process was terminated');return ['cancelled'=>true,'unrelated_alive'=>true];}finally{proc_terminate($other);proc_close($other);}
});
nativeCheck('cancelled initial send retains resumable receiver',function()use($src,$dst){$out=interruptNativeTransfer($src,$dst);$token=nativeCommand(['get','-H','-o','value','receive_resume_token',$dst]);nativeExpect($token!=='-','Initial partial receive has no token');return $out+['resume_token_present'=>true];});
nativeCheck('protected initial receive resumes without destroying target',function()use($dst){$guid=nativeCommand(['get','-H','-o','value','guid',$dst]);$j=nativeJob('replication','a4');nativeExpect($j['verified_outcome']==='completed',json_encode($j['verification']));nativeExpect(nativeCommand(['get','-H','-o','value','guid',$dst])===$guid,'Receiver identity changed');nativeExpect(nativeCommand(['get','-H','-o','value','receive_resume_token',$dst])==='-','Token remains after completion');return $j['verification'];});
nativeCheck('cancelled incremental send is retained then resumed',function()use($src,$dst,$mount){$h=fopen($mount.'/incremental.bin','wb');for($n=0;$n<8;$n++)fwrite($h,random_bytes(1048576));fclose($h);$before=zfsmSyncoidInventory(zfsmProtectionReadStore()['replications']['a4'],true);$stopped=interruptNativeTransfer($src,$dst);$j=nativeJob('replication','a4');nativeExpect($j['verified_outcome']==='completed',json_encode($j['verification']));return ['cancelled'=>$stopped,'recovered'=>$j['verification'],'previous_guid'=>$before['']['guid']];});
file_put_contents($base.'/fault-results.json',json_encode(['provenance'=>'Real ZFS, Syncoid, PHP streaming/process groups and journal cancellation. Isolated Unraid discovery fixtures.','results'=>$results],JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES)."\n");
exit(array_filter($results,fn($r)=>$r['status']!=='PASS')?1:0);
