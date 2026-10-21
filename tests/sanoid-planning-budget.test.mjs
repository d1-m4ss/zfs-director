import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startIntegration} from './integration/server.mjs';
async function fixture(t){const s=await startIntegration({protection:true});t.after(()=>s.close());const file='/acceptance/system.php',text=s.php.readFileAsText(file),marker='function integrationProcess($command,$args,$stdin=null) {';assert.ok(text.includes(marker));s.php.writeFile(file,text.replace(marker,marker+`
 if(basename($command)==='sanoid'){$GLOBALS['observed_probe_budget']=($GLOBALS['zfsm_inventory_deadline']??microtime(true))-microtime(true);if(in_array('--readonly',$args,true)&&$GLOBALS['observed_probe_budget']<26)throw new RuntimeException('Native readonly plan needs 26 seconds in this slow fixture.');}if($command==='/usr/sbin/sanoid'&&in_array('--take-snapshots',$args,true)&&!in_array('--readonly',$args,true))return ['code'=>0,'output'=>'SYNTHETIC autosnap=false; no snapshots created'];
`));return s;}
test('background retention allows a slow readonly plan while interactive preview keeps its short budget',async t=>{
 const s=await fixture(t),r=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
 $p=zfsmSanoidPolicy(['id'=>'abc','dataset'=>'cache/__mock__/project','autosnap'=>false,'autoprune'=>true]);$p['source_guid']=zfsmReadIdentity($p['dataset'])['guid'];$store=zfsmProtectionReadStore();$store['policies']['abc']=$p;zfsmProtectionWriteStore($store);
 $out=zfsmSanoidExecute(zfsmNewProtectionJob('policy',$p));if($GLOBALS['observed_probe_budget']<80)throw new LogicException('Worker plan has the short interactive deadline');
 try{zfsmSanoidPreview(['id'=>'abc','dataset'=>$p['dataset'],'enabled'=>false],'secret');throw new LogicException('Interactive plan acquired worker budget');}catch(RuntimeException $e){if(!str_contains($e->getMessage(),'26 seconds'))throw $e;}
 if($GLOBALS['observed_probe_budget']>15)throw new LogicException('Interactive deadline extended');echo 'PASS';`});assert.equal(r.errors,'');assert.equal(r.text,'PASS');
});
test('longer readonly probe never extends an existing caller deadline and restores it',async t=>{
 const s=await fixture(t),r=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';$outer=microtime(true)+0.2;$GLOBALS['zfsm_inventory_deadline']=$outer;zfsmProtectionProbe('/usr/sbin/sanoid',['--version'],90);if($GLOBALS['observed_probe_budget']>0.21)throw new LogicException('Caller deadline extended');if($GLOBALS['zfsm_inventory_deadline']!==$outer)throw new LogicException('Caller deadline lost');echo 'PASS';`});assert.equal(r.errors,'');assert.equal(r.text,'PASS');
});
