<?php
require __DIR__.'/protection-bootstrap.php';
$mode=$argv[1]??'';$source='director_it_1018/faults';$target='director_rt_1018/reset';
if($mode==='prepare'){
    $r=zfsmSyncoidJob(['id'=>'a6','source'=>$source,'target'=>$target,'source_guid'=>zfsmReadIdentity($source)['guid'],'bandwidth'=>'64k']);$s=zfsmProtectionReadStore();$s['replications']['a6']=$r;zfsmProtectionWriteStore($s);$j=zfsmNewProtectionJob('replication',$r);zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);file_put_contents($base.'/reset-job-id',$j['id']);
    $proc=proc_open(['/usr/bin/php',__DIR__.'/protection-one.php',$j['id']],[0=>['file','/dev/null','r'],1=>['file',$base.'/reset-child.log','a'],2=>['redirect',1]],$pipes);nativeExpect(is_resource($proc),'Cannot start owned reset worker');$deadline=microtime(true)+180;
    while(microtime(true)<$deadline){$p=runProcess('pgrep',['-a','-x','zfs']);if(preg_match('/\bzfs\s+(?:recv|receive)\b[^\r\n]*'.preg_quote($target,'/').'(?:\s|$)/',$p['output'])){file_put_contents($base.'/RESET-READY',json_encode(['job'=>$j['id'],'boot'=>zfsmBootId(),'target'=>$target]));while(proc_get_status($proc)['running'])usleep(500000);proc_close($proc);exit(0);}usleep(250000);}throw new RuntimeException('Active receiver was not observed before reset deadline.');
}
if($mode==='recover'){
    $id=trim(file_get_contents($base.'/reset-job-id'));$j=zfsmReadJob($id);nativeExpect($j['ack_boot']!==zfsmBootId(),'Guest boot identity did not change');zfsmRunProtectionJob($j);$interrupted=zfsmReadJob($id);nativeExpect($interrupted['verified_outcome']==='interrupted','Unfinished pre-reset job was not classified interrupted');
    $s=zfsmProtectionReadStore();$s['replications']['a6']['bandwidth']='1m';zfsmProtectionWriteStore($s);$after=nativeJob('replication','a6');nativeExpect($after['verified_outcome']==='completed',json_encode($after['verification']));$result=['status'=>'PASS','name'=>'guest hard reset interrupts durable run and protected retry completes','old_job'=>$id,'classification'=>$interrupted['verified_outcome'],'recovered'=>$after['verification'],'limit'=>'QEMU guest reset, not physical storage power loss'];file_put_contents($base.'/reset-result.json',json_encode($result,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES));echo json_encode($result,JSON_UNESCAPED_SLASHES)."\n";exit(0);
}
throw new InvalidArgumentException('Use prepare or recover.');
