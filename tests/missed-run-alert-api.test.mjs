import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startIntegration} from './integration/server.mjs';
// The per-job missed-run alert is saved through the signed review and returned by the protection list API.
const prelude=`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
$source='cache/__mock__/project';$target='cache/__mock__/review-backup';
`;
async function run(t,code){
 const stand=await startIntegration({protection:true});t.after(()=>stand.close());
 const result=await stand.run({code:prelude+code});assert.equal(result.errors,'',result.text);return JSON.parse(result.text.slice(result.text.indexOf('{')));
}
test('missed_alert survives preview, save and edit, and the list reports its limit',async t=>{
 const out=await run(t,`$save=function($extra)use($source,$target){$preview=zfsmSyncoidPreview(array_merge(['id'=>'abc','source'=>$source,'target'=>$target,'schedule'=>'0 3 * * 0'],$extra),'secret');$value=$preview['review']['value'];zfsmSyncoidCommit($preview,'secret');return $value['missed_alert'];};
 $row=fn()=>array_values(array_filter(zfsmProtectionData()['replications'],fn($r)=>$r['id']==='abc'))[0];
 $result=['default_review'=>$save([])];$saved=zfsmProtectionReadStore()['replications']['abc'];$result['default_saved']=$saved['missed_alert'];$r=$row();$result['default_list']=[$r['missed_alert'],$r['missed_alert_limit_seconds']];
 $result['off_review']=$save(['missed_alert'=>'0']);$result['off_saved']=zfsmProtectionReadStore()['replications']['abc']['missed_alert'];$r=$row();$result['off_list']=[$r['missed_alert'],$r['missed_alert_limit_seconds']];
 $result['on_review']=$save(['missed_alert'=>'1','schedule'=>'0 * * * *']);$r=$row();$result['on_list']=[$r['missed_alert'],$r['missed_alert_limit_seconds']];
 $store=zfsmProtectionReadStore();unset($store['replications']['abc']['missed_alert']);zfsmProtectionWriteStore($store);$r=$row();$result['legacy_list']=[$r['missed_alert'],$r['missed_alert_limit_seconds']];
 echo json_encode($result);`);
 assert.deepEqual(out,{default_review:true,default_saved:true,default_list:[true,210*3600],off_review:false,off_saved:false,off_list:[false,null],on_review:true,on_list:[true,2*3600],legacy_list:[true,2*3600]});
});
