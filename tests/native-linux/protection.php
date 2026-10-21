<?php
require __DIR__.'/protection-bootstrap.php';
$src='director_it_1018';$dst='director_rt_1018';
nativeCheck('installed native engine capabilities',function(){ $d=zfsmProtectionRequire(false);return ['sanoid'=>$d['sanoid']['version'],'syncoid'=>$d['syncoid']['version']];});
nativeCheck('Sanoid real snapshot creation and ownership provenance',function()use($src){
 $p=zfsmSanoidPolicy(['id'=>'a1','name'=>'Native policy','dataset'=>$src.'/policy','source_guid'=>zfsmReadIdentity($src.'/policy')['guid'],'hourly'=>2,'daily'=>1]);$s=zfsmProtectionReadStore();$s['policies']['a1']=$p;zfsmProtectionWriteStore($s);$j=nativeJob('policy','a1');nativeExpect(in_array($j['verified_outcome'],['completed','up_to_date'],true),json_encode($j['verification']));nativeExpect(count(zfsmProtectionReadStore()['owned_snapshots'])>0,'No native snapshot ownership recorded');return $j['verification'];
});
nativeCheck('initial local replication verified by GUID with unmounted receiver',function()use($src,$dst){
 $r=zfsmSyncoidJob(['id'=>'a2','source'=>$src.'/send','target'=>$dst.'/recv','source_guid'=>zfsmReadIdentity($src.'/send')['guid']]);$s=zfsmProtectionReadStore();$s['replications']['a2']=$r;zfsmProtectionWriteStore($s);$j=nativeJob('replication','a2');nativeExpect($j['verified_outcome']==='completed',json_encode($j['verification']));nativeExpect(nativeCommand(['get','-H','-o','value','mounted',$dst.'/recv'])==='no','Receiver was mounted');return $j['verification'];
});
nativeCheck('incremental local replication advances verified checkpoint',function()use($src){
 $mount=nativeCommand(['get','-H','-o','value','mountpoint',$src.'/send']);file_put_contents($mount.'/delta.txt','incremental payload '.random_bytes(24));$j=nativeJob('replication','a2');nativeExpect($j['verified_outcome']==='completed',json_encode($j['verification']));return $j['verification'];
});
nativeCheck('source and receiver frozen checkpoint SHA256 match',function()use($src,$dst){
 $s=zfsmProtectionReadStore();$r=$s['replications']['a2'];$i=zfsmSyncoidInspect($r);$common=array_intersect_key($i['source']['']['snapshots'],$i['target']['']['snapshots']);nativeExpect((bool)$common,'No common GUID');$checkpoint=end($common)['name'];$mount=nativeCommand(['get','-H','-o','value','mountpoint',$src.'/send']);$targetMount='/var/lib/zfs-director-native-20261018/verify-target';if(!is_dir($targetMount))mkdir($targetMount,0700,true);
 // Read directly through a temporary clone with a verified source origin;
 // leave it retained for inspection, never mount the replication receiver.
 $clone=$dst.'/verify';$probe=runProcess('zfs',['list','-H','-o','name',$clone]);if($probe['code']!==0)nativeCommand(['clone','-o','mountpoint='.$targetMount,$dst.'/recv@'.$checkpoint,$clone]);
 $hash=hash_file('sha256',$mount.'/.zfs/snapshot/'.$checkpoint.'/payload.bin');$other=hash_file('sha256',$targetMount.'/payload.bin');nativeExpect($hash===$other,'Payload hash mismatch');return ['snapshot'=>$checkpoint,'sha256'=>$hash];
});
nativeCheck('foreign receiver snapshot blocks without rollback or deletion',function()use($dst){
 nativeCommand(['snapshot',$dst.'/recv@foreign-manual']);$before=nativeCommand(['get','-H','-o','value','guid',$dst.'/recv@foreign-manual']);$j=nativeJob('replication','a2');nativeExpect($j['verified_outcome']==='blocked',json_encode($j['verification']));nativeExpect(nativeCommand(['get','-H','-o','value','guid',$dst.'/recv@foreign-manual'])===$before,'Foreign snapshot changed');return $j['verification'];
});
nativeCheck('recursive delivery verifies root and child GUIDs',function()use($src,$dst){
 $r=zfsmSyncoidJob(['id'=>'a3','source'=>$src.'/tree','target'=>$dst.'/tree','source_guid'=>zfsmReadIdentity($src.'/tree')['guid'],'recursive'=>true]);$s=zfsmProtectionReadStore();$s['replications']['a3']=$r;zfsmProtectionWriteStore($s);$j=nativeJob('replication','a3');nativeExpect($j['verified_outcome']==='completed',json_encode($j['verification']));nativeExpect(count($j['verification']['checkpoints'])===2,'Child checkpoint was not verified');return $j['verification'];
});
nativeCheck('retention prunes owned GUIDs while preserving manual Sanoid-looking snapshot',function()use($src){
 $name=$src.'/policy@autosnap_2000-01-01_00:00:00_hourly';$probe=runProcess('zfs',['list','-H','-o','name',$name]);if($probe['code']!==0)nativeCommand(['snapshot',$name]);$guid=zfsmReadIdentity($name)['guid'];
 $s=zfsmProtectionReadStore();$original=$s['policies']['a1'];$p=$original;$p['autosnap']=false;$p['autoprune']=true;foreach(zfsmSanoidTiers()as$t)$p[$t]=0;$s['policies']['a1']=$p;zfsmProtectionWriteStore($s);
 try{$j=nativeJob('policy','a1');$out=$j['verification'];nativeExpect($out['outcome']==='completed_with_warnings',json_encode($out));nativeExpect(!empty($out['snapshots_pruned']),'No owned snapshot was pruned');nativeExpect(zfsmReadIdentity($name)['guid']===$guid,'Manual snapshot was changed or destroyed');return $out;}finally{$s=zfsmProtectionReadStore();$s['policies']['a1']=$original;zfsmProtectionWriteStore($s);}
});
file_put_contents($base.'/'.(getenv('RESULT_LABEL')?:'results').'.json',json_encode(['provenance'=>'Real ZFS and installed engine binaries; Unraid manifest/scan roots are explicit isolated fixtures. No test-host.','results'=>$results],JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES)."\n");
exit(array_filter($results,fn($r)=>$r['status']!=='PASS')?1:0);
