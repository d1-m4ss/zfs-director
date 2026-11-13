import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startIntegration} from './integration/server.mjs';
// UX-003: Jobs filters by status and by type separately; older clients may still send a type in
// "filter".
test('Jobs status and type filters combine, and the legacy single filter still works',async t=>{
 const s=await startIntegration({protection:true});t.after(()=>s.close());
 const r=await s.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
 $d=zfsmSyncoidJob(['source'=>'cache/__mock__/project','target'=>'cache/__mock__/backup','source_guid'=>'1','mode'=>'local','resume'=>false,'compression'=>'none']);$p=zfsmSanoidPolicy(['dataset'=>'cache/__mock__/project','source_guid'=>'1']);
 $make=function($type,$def,$state){$j=zfsmNewProtectionJob($type,$def);$j['state']=$state;$j['stage']=$state;zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);return $j['id'];};
 $ids=['rep_done'=>$make('replication',$d,'completed'),'rep_queued'=>$make('replication',$d,'queued'),'pol_done'=>$make('policy',$p,'completed')];
 $page=fn($o)=>array_column(zfsmJobPage(1,50,$o)['jobs'],'id');
 $bad=null;try{zfsmJobPage(1,50,['type'=>'nonsense']);}catch(Throwable$e){$bad=$e->getMessage();}
 echo json_encode(['ids'=>$ids,'completed_replication'=>$page(['filter'=>'completed','type'=>'replication']),'all_replication'=>$page(['type'=>'replication']),'completed'=>$page(['filter'=>'completed']),'legacy'=>$page(['filter'=>'policy']),'bad'=>$bad]);`});
 assert.equal(r.errors,'',r.text);const out=JSON.parse(r.text.slice(r.text.indexOf('{')));
 assert.deepEqual(out.completed_replication,[out.ids.rep_done]);
 assert.deepEqual(new Set(out.all_replication),new Set([out.ids.rep_done,out.ids.rep_queued]));
 assert.deepEqual(new Set(out.completed),new Set([out.ids.rep_done,out.ids.pol_done]));
 assert.deepEqual(out.legacy,[out.ids.pol_done],'a type sent as "filter" still filters by type');
 assert.match(out.bad,/Invalid jobs type/);
});
