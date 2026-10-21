import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';

test('snapshot mount exemption requires readable references; vanished FDs remain benign',async()=>{
 const php=await runtime();
 try{
  php.writeFile('/collector.php',php.readFileAsText('/app/src/include/ZFSMDestroyBusy.php').replace('<?php','<?php namespace SnapshotCollector;'));
  const r=await php.run({code:`<?php namespace SnapshotCollector;
   require '/app/harness.php';
   function scandir($p){return $p==='/proc'?['1']:['3'];}
   function readlink($p){return str_ends_with($p,'/ns/mnt')?'host':'/';}
   function is_dir($p){return true;}
   function is_file($p){return $GLOBALS['fd_mode']!=='vanished';}
   function file_get_contents($p,...$options){
    if(str_ends_with($p,'/mountinfo'))return "1 0 0:1 / / rw - rootfs rootfs rw\\n2 1 0:2 / /mnt/cache/data rw - zfs cache/data rw\\n5 2 0:8 / /mnt/cache/data/.zfs/snapshot/s1 ro - zfs cache/data@s1 ro";
    if(str_contains($p,'/fdinfo/'))return match($GLOBALS['fd_mode']){'unreadable','vanished'=>false,'malformed'=>"pos: 0\\n",'open'=>"mnt_id: 5\\n",default=>"mnt_id: 1\\n"};
    return '';
   }
   function zfsmFilesystemMounts(){return ['cache/data'=>['mountpoint'=>'/mnt/cache/data','mounted'=>'yes']];}
   require '/collector.php';
   $objects=[['name'=>'cache/data@s1','type'=>'snapshot','guid'=>'13','mountpoint'=>'-']];
   foreach(['unreadable','malformed','vanished','open','unrelated']as$mode){
    $GLOBALS['fd_mode']=$mode;$r=zfsmDestroyBusyDiagnostics($objects);
    $unknown=in_array($mode,['unreadable','malformed'],true);
    \\same(!$unknown,$r['complete']);\\same($unknown||$mode==='open',$r['blocked']);
    if($mode==='open')\\same('open_file',$r['blockers'][0]['kind']);
   }
   echo 'PASS unreadable/malformed live FD fails closed; disappeared FD is benign; actual reader blocks; unrelated FD allows unused snapshot';`});
  assert.equal(r.errors,'');assert.equal(r.exitCode,0,r.text);console.log(r.text);
 }finally{php.exit();}
});
