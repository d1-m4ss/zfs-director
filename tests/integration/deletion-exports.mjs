import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {startIntegration} from './server.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const output=process.env.ZFSM_OUTPUT||'evidence/deletion-export-2026-10-18/gui';
await mkdir(output,{recursive:true});
const stand=await startIntegration({dependencyUsage:true}),results=[],errors=[];
const browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1000}});
page.on('pageerror',e=>errors.push(e.message));
const fixture=stand.readModel().directory_fixtures,target=fixture.paths.delete;
const endpoint=stand.url+'/plugins/zfs.master.ui/backend/ZFSMAdmin.php';
const helperCount=()=>stand.readModel().calls.filter(c=>c.stdin_json?.op==='delete').length;
async function submit(){
 await page.locator('.zfsm-form button[type=submit]').click();
 const reply=page.waitForResponse(r=>r.url()===endpoint&&new URLSearchParams(r.request().postData()).get('cmd')==='deletedirectory');
 await page.locator('[data-confirm-operation]').click();return (await reply).json();
}
async function form(){
 if(await page.locator('.zfsm-action-dialog[open]').count())await page.getByRole('button',{name:'Close action',exact:true}).click();
 await page.getByRole('button',{name:'Datasets',exact:true}).click();
 await page.locator('[data-node="'+target+'"]').click();
 await page.locator('[data-tab=actions]').click();
 await page.getByRole('button',{name:'Delete directory',exact:true}).click();
 await page.locator('[name=force]').check();await page.locator('[name=acknowledge]').check();
}
try{
 await page.goto(stand.url);await page.getByRole('button',{name:'Refresh',exact:true}).click();
 await page.locator('[data-node="'+target+'"]').waitFor();
 for(const path of [target,target+'/retained.txt']){
  stand.php.writeFile('/etc/samba/smb-shares.conf','[fixture]\npath = '+path+'\n');
  await form();const before=helperCount(),reply=await submit();
  assert.match(JSON.stringify(reply.failed),/configured service references/);
  assert.equal(helperCount(),before);assert.ok(stand.php.fileExists(target+'/retained.txt'));
  results.push({name:'configured export protected: '+path,status:'PASS'});
  if(path===target){
   const fields=new URLSearchParams(stand.calls.findLast(c=>new URLSearchParams(c.body).get('cmd')==='deletedirectory').body);
   fields.set('directory',target+'/');
   for(const service of ['smb','nfs']){
    stand.php.writeFile('/etc/samba/smb-shares.conf',service==='smb'?'[fixture]\npath = '+target+'\n':'');
    stand.php.writeFile('/etc/exports',service==='nfs'?target+' *(rw)\n':'');
    const denied=await(await fetch(endpoint,{method:'POST',body:fields})).json();
    assert.match(JSON.stringify(denied.failed),/configured service references/);assert.equal(helperCount(),before);
    assert.ok(stand.php.fileExists(target+'/retained.txt'));results.push({name:service+' exact export with trailing slash protected',status:'PASS'});
   }
   stand.php.writeFile('/etc/exports','');
  }
 }
 stand.php.writeFile('/etc/samba/smb-shares.conf','[fixture]\npath = '+fixture.mountpoint+'\n');
 stand.php.writeFile('/etc/exports',fixture.mountpoint+' *(rw)\n');
 await form();const reply=await submit();assert.equal(Object.keys(reply.failed||{}).length,0,JSON.stringify(reply));
 assert.equal(reply.job?.state,'queued');assert.equal(helperCount(),0);assert.ok(stand.php.fileExists(target+'/retained.txt'));
 const execution=await stand.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';echo json_encode(zfsmRunDeletionJob('${reply.job.id}'));`});assert.equal(execution.errors,'');assert.equal(JSON.parse(execution.text).state,'completed');
 assert.equal(helperCount(),1);assert.equal(stand.php.fileExists(target+'/retained.txt'),false);
 assert.ok(stand.php.fileExists(fixture.paths.convert+'/retained.txt'));
 results.push({name:'GUI deletes ordinary child of SMB and NFS exports; sibling preserved',status:'PASS'});
 await page.getByRole('button',{name:'View deletion progress',exact:true}).click();await page.locator('[data-job-id="'+reply.job.id+'"]').getByText(/Directory and its selected contents deleted; absence verified/).waitFor();
 await page.screenshot({path:output+'/deleted-child.png',fullPage:true});
 assert.deepEqual(errors,[]);
 assert.deepEqual(stand.errors,Array(4).fill('ZFS Director backend request failed\n')); // Four intentional guard rejections.
}catch(error){results.push({name:'GUI deletion exports',status:'FAIL',error:error.stack});await page.screenshot({path:output+'/failure.png',fullPage:true});process.exitCode=1;}
finally{await writeFile(output+'/results.json',JSON.stringify({results,errors,boundary:'Actual PHP endpoint/UI/guards; external ZFS and native helper effects simulated'},null,2)+'\n');console.log(JSON.stringify(results));await browser.close();await stand.close();}
