import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';

test('container lookup runs only for validated container blockers and fails back to original IDs',async()=>{
 const php=await runtime();
 try{
  const path='/app/src/include/ZFSMDestroyBusy.php',source=php.readFileAsText(path),start=source.indexOf('function zfsmDestroyReadContainerNames('),end=source.indexOf('function zfsmDestroyNameContainers(',start);
  assert.ok(start>0&&end>start,'bounded Docker process boundary is available');
  php.writeFile(path,source.slice(0,start)+`function zfsmDestroyReadContainerNames(){ $GLOBALS['docker_calls']++;if($GLOBALS['docker_fail'])throw new RuntimeException('Unavailable');return zfsmDestroyParseContainerNames($GLOBALS['docker_output']); }\n`+source.slice(end));
  const r=await php.run({code:`<?php require '/app/harness.php';
   $GLOBALS['docker_calls']=0;$GLOBALS['docker_fail']=false;$id=str_repeat('a',64);$other=str_repeat('b',64);$GLOBALS['docker_output']=$id." qbittorrent\\n".$other." other_container\\n";
   $empty=['blocked'=>false,'blockers'=>[]];same($empty,zfsmDestroyNameContainers($empty));same(0,$GLOBALS['docker_calls']);
   $host=['blocked'=>true,'blockers'=>[['container'=>null],['container'=>'short']]];same($host,zfsmDestroyNameContainers($host));same(0,$GLOBALS['docker_calls']);
   $report=['blocked'=>true,'blockers'=>[['container'=>$id],['container'=>$id],['container'=>str_repeat('c',64)]]];$named=zfsmDestroyNameContainers($report);same(1,$GLOBALS['docker_calls']);same(true,$named['blocked']);same('qbittorrent',$named['blockers'][0]['container_name']);same('qbittorrent',$named['blockers'][1]['container_name']);same($report['blockers'][2],$named['blockers'][2]);same($id,$named['blockers'][0]['container']);
   $GLOBALS['docker_fail']=true;same($report,zfsmDestroyNameContainers($report));same(2,$GLOBALS['docker_calls']);
   $GLOBALS['docker_fail']=false;$GLOBALS['docker_output']='invalid output';same($report,zfsmDestroyNameContainers($report));
   echo 'PASS optional container names preserve blockers, unknown IDs and failure fallback';`});
  assert.equal(r.errors,'');assert.equal(r.exitCode,0,r.text);console.log(r.text);
 }finally{php.exit();}
});

test('optional Docker child uses fixed argv and bounded timeout/output with cleanup',async()=>{
 const php=await runtime();
 try{
  // Keep the collector real; replace only OS process/selector boundaries in a
  // test namespace. PHP-WASM cannot spawn a native docker child.
  php.writeFile('/collector.php',php.readFileAsText('/app/src/include/ZFSMDestroyBusy.php').replace('<?php','<?php namespace ZfsmDockerProbe;'));
  const r=await php.run({code:`<?php namespace ZfsmDockerProbe;
   function proc_open($argv,$descriptors,&$pipes,$cwd=null,$env=null,$options=[]){
    if($argv!==['docker','ps','--no-trunc','--format','{{.ID}} {{.Names}}']||$cwd!==null||$env!==null||$options!==['bypass_shell'=>true])throw new \\RuntimeException('Unexpected process contract');
    $GLOBALS['opened']++;if($GLOBALS['mode']==='unavailable')return false;
    $pipes=[1=>fopen('php://memory','w+')];fwrite($pipes[1],$GLOBALS['output']);rewind($pipes[1]);return fopen('php://memory','w+');
   }
   function proc_get_status($process){return ['running'=>$GLOBALS['mode']==='hang','exitcode'=>$GLOBALS['mode']==='nonzero'?1:0];}
   function proc_terminate($process,$signal=15){$GLOBALS['terminated'][]=$signal;return true;}
   function proc_close($process){$GLOBALS['closed']++;fclose($process);return 0;}
   function stream_select(&$read,&$write,&$except,$seconds,$microseconds=0){if($GLOBALS['mode']==='hang')usleep(5000);return 1;}
   require '/collector.php';
   function same($a,$b){if($a!==$b)throw new \\RuntimeException('Expected '.json_encode($a).', got '.json_encode($b));}
   $id=str_repeat('a',64);$GLOBALS['opened']=0;$GLOBALS['closed']=0;$GLOBALS['terminated']=[];
   $GLOBALS['mode']='ok';$GLOBALS['output']=$id." qbittorrent\\n";same([$id=>'qbittorrent'],zfsmDestroyReadContainerNames());same(1,$GLOBALS['closed']);same([],$GLOBALS['terminated']);
   $GLOBALS['mode']='nonzero';same([],zfsmDestroyReadContainerNames());same(2,$GLOBALS['closed']);
   $GLOBALS['mode']='ok';$GLOBALS['output']=str_repeat('x',262145);same([],zfsmDestroyReadContainerNames());same([9],$GLOBALS['terminated']);same(3,$GLOBALS['closed']);
   $GLOBALS['mode']='hang';$GLOBALS['output']='';$started=microtime(true);same([],zfsmDestroyReadContainerNames());$elapsed=microtime(true)-$started;if($elapsed<0.9||$elapsed>2.5)throw new \\RuntimeException('Timeout not bounded: '.$elapsed);same([9,9],$GLOBALS['terminated']);same(4,$GLOBALS['closed']);
   $GLOBALS['mode']='unavailable';same([],zfsmDestroyReadContainerNames());same(5,$GLOBALS['opened']);same(4,$GLOBALS['closed']);
   echo 'PASS fixed read-only argv, exit status, 256KiB cap, 1s deadline and owned-child cleanup';`});
  assert.equal(r.errors,'');assert.equal(r.exitCode,0,r.text);console.log(r.text);
 }finally{php.exit();}
});
