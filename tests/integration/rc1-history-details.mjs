import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {mkdir,writeFile} from 'node:fs/promises';import {startIntegration} from './server.mjs';
const require=createRequire(import.meta.url),{chromium}=require('playwright'),output='evidence/rc1-gap-2026-10-18/history-details-gui';await mkdir(output,{recursive:true});const stand=await startIntegration(),errors=[];let browser;
try{
 const source='cache/__mock__/project',m=stand.readModel();m.fail_command='zfs set atime=off '+source;stand.writeModel(m);
 async function post(f){return(await fetch(stand.url+'/plugins/zfs.master.ui/backend/ZFSMAdmin.php',{method:'POST',body:new URLSearchParams({csrf_token:'integration-token',...f})})).json();}
 const failed=await post({cmd:'editdatasetproperty',zdataset:source,expected_guid:m.datasets[source].guid,property:'atime',value:'off',passphrase:'MUST_NOT_PERSIST'});assert.ok(Object.keys(failed.failed).length);const history=await post({cmd:'auditlog'}),out=history.entries.find(e=>e.command==='editdatasetproperty'&&e.phase==='outcome');assert.equal(out.details.exit_code,1);assert.equal(out.details.stage,'executing_operation');assert.ok(!JSON.stringify(history).includes('MUST_NOT_PERSIST'));

}finally{if(browser)await browser.close();await stand.close();await writeFile(output+'/result.json',JSON.stringify({provenance:'Actual endpoint and audit filesystem, CLI failure deliberately simulated.',pageErrors:errors,phpErrors:stand.errors},null,2)+'\n');}
