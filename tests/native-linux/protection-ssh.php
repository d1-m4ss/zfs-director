<?php
require __DIR__.'/protection-bootstrap.php';
// Reuse the already-authorized PoC identity and existing trust store read-only.
// No key generation, authorized_keys or known_hosts writes.
zfsmJobAtomicWrite(zfsmProtectionDirectory().'/credentials.json',['loopback'=>['keyfile'=>'/root/.ssh/id_ed25519','known_hosts'=>'/root/.ssh/known_hosts']]);
$src='director_it_1018/send';$dst='director_rt_1018/ssh';
nativeCheck('trusted loopback SSH replication verifies GUID and frozen data',function()use($src,$dst){
 $r=zfsmSyncoidJob(['id'=>'a5','source'=>$src,'target'=>$dst,'source_guid'=>zfsmReadIdentity($src)['guid'],'mode'=>'remote','host'=>'127.0.0.1','credential'=>'loopback']);$s=zfsmProtectionReadStore();$s['replications']['a5']=$r;zfsmProtectionWriteStore($s);$j=nativeJob('replication','a5');nativeExpect($j['verified_outcome']==='completed',json_encode($j['verification']));return $j['verification'];
});
nativeCheck('unknown SSH host identity is rejected without target changes',function()use($src,$dst){$j=zfsmSyncoidJob(['source'=>$src,'target'=>$dst,'mode'=>'remote','host'=>'127.0.0.2','credential'=>'loopback']);$before=zfsmReadIdentity($dst)['guid'];$r=zfsmSyncoidCall($j,true,['list','-H','-o','name',$dst]);nativeExpect($r['code']!==0,'Unknown host identity was accepted');nativeExpect(preg_match('/Host key verification failed|host key is known/i',$r['output'])===1,'Failure was not host-key verification: '.$r['output']);nativeExpect(zfsmReadIdentity($dst)['guid']===$before,'Receiver identity changed');return ['ssh_exit'=>$r['code'],'receiver_unchanged'=>true];});
nativeCheck('unreachable SSH port fails within bounded timeout',function()use($src,$dst){$j=zfsmSyncoidJob(['source'=>$src,'target'=>$dst,'mode'=>'remote','host'=>'127.0.0.1','port'=>'1','credential'=>'loopback']);$at=microtime(true);$r=zfsmSyncoidCall($j,true,['list','-H','-o','name',$dst]);$duration=microtime(true)-$at;nativeExpect($r['code']!==0,'Unavailable port was accepted');nativeExpect($duration<25,'SSH timeout was not bounded');return ['ssh_exit'=>$r['code'],'seconds'=>$duration];});
file_put_contents($base.'/ssh-results.json',json_encode(['provenance'=>'Real SSH on loopback within the same retained VM. Trusted host key read from VM host-public-key file. No separate host/network evidence.','results'=>$results],JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES)."\n");
exit(array_filter($results,fn($r)=>$r['status']!=='PASS')?1:0);
