import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startIntegration} from './integration/server.mjs';
function encoded(fields){const body=new URLSearchParams();function append(key,value){if(value&&typeof value==='object')for(const [child,item]of Object.entries(value))append(key+'['+child+']',item);else body.append(key,String(value));}for(const [key,value]of Object.entries(fields))append(key,value);return body;}
test('the Jobs endpoint rejects malformed parameters and the removed commands are unknown',async()=>{
 const stand=await startIntegration();try{
 const post=async fields=>{const response=await fetch(stand.url+'/plugins/zfs.master.ui/backend/ZFSMAdmin.php',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:encoded({csrf_token:'integration-token',...fields})});assert.equal(response.status,200);return response.json();};
 for(const fields of [{filter:['all']},{sort:'surprise'},{page_size:['25']}])assert.ok((await post({cmd:'conversionjobs',listed:'0',...fields})).failed.request);
 for(const cmd of ['auditlog','activityvisibility','previewhistoryarchive','refresh'])assert.ok((await post({cmd})).failed.request,cmd);
 }finally{await stand.close();}
});
