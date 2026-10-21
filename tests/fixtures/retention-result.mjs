import assert from 'node:assert/strict';
import {startIntegration} from '../integration/server.mjs';

// Only the native Sanoid process is replaced. Inventory, GUID/ownership guards,
// deletion, worker, durable journal, Jobs presentation and audit remain real PHP.
export async function retentionResult({eligible=true,protectedSnapshots=true,invalidPlan=false,deleteFailure=false,partialFailure=false}={}){
 const stand=await startIntegration({protection:true});
 try{
  const source='cache/__mock__/project',owned=source+'@autosnap_2026-10-01_00:00:00_frequently',manual=source+'@autosnap_2000-01-01_00:00:00_hourly',held=source+'@autosnap_2026-10-01_00:00:00_hourly',second=source+'@autosnap_2026-10-02_00:00:00_frequently';
  const model=stand.readModel(),guid=model.datasets[source].guid;
  const names=[...(eligible?[owned]:[]),...(partialFailure?[second]:[]),...(protectedSnapshots?[manual,held]:[])];
  for(const [i,name]of names.entries())model.snapshots[name]={name,type:'snapshot',guid:String(910001+i),creation:1790812800,createtxg:1790812800,userrefs:name===held?1:0,origin:'-',mountpoint:'-',encryptionroot:'-',used:0};
  model.holds={[held]:['retention-test']};
  if(deleteFailure||partialFailure)model.fail_command='zfs destroy '+(partialFailure?second:owned);
  stand.writeModel(model);
  const file='/acceptance/system.php',text=stand.php.readFileAsText(file),boundary=`if($command==='/usr/sbin/sanoid'&&in_array('--readonly',$args,true))return $ok("INFO: taking snapshots...\\nINFO: pruning snapshots...\\n");`;
  assert.ok(text.includes(boundary));
  const output=invalidPlan?'unverifiable plan':'INFO: pruning snapshots...\n'+names.map(n=>'INFO: pruning '+n+' ...').join('\n');
  stand.php.writeFile(file,text.replace(boundary,`if($command==='/usr/sbin/sanoid')return $ok(in_array('--readonly',$args,true)?${JSON.stringify(output)}:'');`));
  const result=await stand.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
   $p=zfsmSanoidPolicy(['id'=>'ace','dataset'=>'${source}','autosnap'=>false,'autoprune'=>true]);$p['source_guid']='${guid}';
   $s=zfsmProtectionReadStore();$s['policies']['ace']=$p;
   foreach(${JSON.stringify(names.filter(n=>n!==manual))}as$name)$s['owned_snapshots'][$name]=['guid'=>integrationModel()['snapshots'][$name]['guid'],'dataset_guid'=>'${guid}','policy_id'=>'ace'];
   zfsmProtectionWriteStore($s);$j=zfsmNewProtectionJob('policy',$p);zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);zfsmRunProtectionJob($j);
   echo json_encode(['job'=>zfsmReadJob($j['id']),'page'=>zfsmJobPage(1,200),'audit'=>zfsmAuditList(100)]);`});
  assert.equal(result.errors,'',result.text);assert.equal(result.exitCode,0,result.text);
  return {stand,source,owned,manual,held,second,before:model,...JSON.parse(result.text)};
 }catch(error){await stand.close();throw error;}
}
