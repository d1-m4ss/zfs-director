<?php
require __DIR__.'/protection-bootstrap.php';
$parent='director_rt_1018/capped';$target=$parent.'/recv';$source='director_it_1018/faults';
$r=runProcess('zfs',['list','-H','-o','name',$parent]);if($r['code']!==0)nativeCommand(['create','-o','quota=2M',$parent]);
nativeCheck('receiver quota exhaustion is visible and never verified as completed',function()use($source,$target,$parent){
 $before=zfsmReadIdentity($parent)['guid'];$r=zfsmSyncoidJob(['id'=>'a7','source'=>$source,'source_guid'=>zfsmReadIdentity($source)['guid'],'target'=>$target]);$s=zfsmProtectionReadStore();$s['replications']['a7']=$r;zfsmProtectionWriteStore($s);$j=nativeJob('replication','a7');nativeExpect(!in_array($j['verified_outcome'],['completed','up_to_date'],true),'Quota exhaustion was presented as successful');nativeExpect(($j['verification']['error_code']??null)==='insufficient_space',json_encode($j['verification']));nativeExpect(zfsmReadIdentity($parent)['guid']===$before,'Receiver parent identity changed');return $j['verification'];
});
file_put_contents($base.'/space-results.json',json_encode(['provenance'=>'Real file-backed test pool and a 2 MiB quota on a dedicated receiver parent. No production datasets.','results'=>$results],JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES)."\n");
exit(array_filter($results,fn($r)=>$r['status']!=='PASS')?1:0);
