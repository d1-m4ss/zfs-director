import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {startMock,lab} from './mock-server.mjs';

// Real frontend and native Chromium modality. HTTP/ZFS responses are synthetic.
const require=createRequire(import.meta.url),{chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const out=process.env.ZFSM_OUTPUT||'backups/2026-10-21/action-dialogs';await mkdir(out,{recursive:true});
const mock=await startMock(),browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true});
const results=[],errors=[],project=lab+'/project';let context,page;
const calls=cmd=>mock.model.calls.filter(c=>c.cmd===cmd);
async function fresh({profile=0,width=1280,theme='dark',layout='tree'}={}){
 if(context)await context.close();mock.reset();mock.model.config.refresh_interval=profile;
 context=await browser.newContext({viewport:{width,height:720}});page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/*',route=>route.request().url().startsWith(mock.url)?route.continue():route.abort());
 await page.goto(mock.url);await page.locator('[data-node="'+project+'"]').click();await page.locator('[data-tab=actions]').click();
 await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(theme);await page.locator('[data-layout-choice="'+layout+'"]').click();
}
async function open(label='Destroy dataset'){
 await page.getByRole('button',{name:label,exact:true}).click();
 const dialog=page.getByRole('dialog',{name:label==='Take Snapshot'?'Create snapshot':label==='Edit Dataset'?'Edit properties':label,exact:true});await dialog.waitFor();return dialog;
}
async function preview(dialog){await dialog.locator('[data-preview]').click();await dialog.locator('.zfsm-preview pre').first().waitFor();await dialog.locator('[name=acknowledge]').check();}
async function review(dialog){await dialog.locator('button[type=submit]').click();await dialog.locator('[data-confirm-operation]').waitFor();}
async function geometry(dialog){return dialog.evaluate(el=>{
 const b=el.querySelector('.zfsm-action-body'),h=el.querySelector('.zfsm-action-heading'),f=[...el.querySelectorAll('.zfsm-action-footer')].find(n=>n.getBoundingClientRect().height>0),r=el.getBoundingClientRect();
 return {top:r.top,bottom:r.bottom,height:r.height,viewport:innerHeight,dialogScroll:el.scrollHeight,dialogClient:el.clientHeight,width:el.clientWidth,scrollWidth:el.scrollWidth,body:b&&{top:b.getBoundingClientRect().top,bottom:b.getBoundingClientRect().bottom,client:b.clientHeight,scroll:b.scrollHeight,overflow:getComputedStyle(b).overflowY},head:h?.getBoundingClientRect().bottom,footer:f&&{top:f.getBoundingClientRect().top,bottom:f.getBoundingClientRect().bottom},modal:el.matches(':modal')};
});}
function fits(g){assert.equal(g.modal,true,'Background actions must be inert through native modality');assert.ok(g.top>=0&&g.bottom<=g.viewport+1,JSON.stringify(g));assert.ok(g.dialogScroll<=g.dialogClient+1,'The dialog shell must not scroll');assert.ok(g.scrollWidth<=g.width+1,'No dialog horizontal overflow');assert.equal(g.body?.overflow,'auto');assert.ok(g.body.client>80,'Usable content area');assert.ok(g.head<=g.body.top+1&&g.body.bottom<=g.footer.top+1,'Header and footer stay outside the scroll body');}
async function shot(name){await page.screenshot({path:out+'/'+name+'.png'});}
async function run(name,fn){if(process.env.ZFSM_CASE&&!name.includes(process.env.ZFSM_CASE))return;try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',error:e.message});console.log('FAIL '+name+': '+e.message.split('\n')[0]);await shot('failure-'+results.length).catch(()=>{});}}
try{
for(const profile of [0,30])for(const theme of ['auto','dark','gray','light','azure'])for(const layout of ['tree','table'])for(const width of [390,1280])await run(`bounded deletion ${profile} ${theme} ${layout} ${width}`,async()=>{
 await fresh({profile,width,theme,layout});
 await page.route('**/mock/admin',async route=>{
  const fields=new URLSearchParams(route.request().postData());if(fields.get('cmd')!=='previewdestroy')return route.continue();
  const response=await route.fetch(),answer=await response.json();answer.recursive=true;
  answer.objects=Array.from({length:80},(_,i)=>({name:i===0?project:project+'/long-reviewed-child-'+i+'-'+('component/'.repeat(8)),type:'filesystem',guid:i===0?String(mock.model.find(project).guid):String(4000+i),mountpoint:'/mnt/'+project+'/child-'+i,encryptionroot:'-',origin:'-',holds:'-'}));
  answer.dependencies=[];answer.preview=answer.objects.map(o=>'destroy\t'+o.name).join('\n');await route.fulfill({json:answer});
 });
 await page.getByRole('button',{name:'Destroy dataset',exact:true}).scrollIntoViewIfNeeded();const before=await page.locator('.zfsm-actions').boundingBox(),scroll=await page.evaluate(()=>scrollY),dialog=await open();await dialog.locator('[name=force]').check();await preview(dialog);const edit=await geometry(dialog);fits(edit);assert.ok(edit.body.scroll>edit.body.client);
 assert.deepEqual(await page.locator('.zfsm-actions').boundingBox(),before,'Opening cannot insert a form above Actions');assert.equal(await page.evaluate(()=>scrollY),scroll,'Opening cannot move the page');
 await page.locator('.zfsm-actions [aria-label="Take Snapshot"]').evaluate(el=>el.focus());assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true,'Background Actions cannot receive focus');
 await review(dialog);assert.equal(calls('destroydataset').length,0);assert.equal(await dialog.locator('.zfsm-form-grid').isVisible(),false,'Review replaces the editor');assert.equal(await dialog.locator('button[type=submit]').isVisible(),false,'One primary submit at a time');assert.equal(await dialog.locator('.zfsm-confirmation .zfsm-destroy-summary').count(),1,'Review retains the exact preview');
 const first=await geometry(dialog);fits(first);await shot(`review-top-${profile}-${theme}-${layout}-${width}`);await dialog.locator('.zfsm-action-body').evaluate(el=>el.scrollTop=el.scrollHeight);const last=await geometry(dialog);assert.deepEqual(last.footer,first.footer);assert.equal(last.head,first.head);assert.equal(await dialog.locator('[data-confirm-operation]').isVisible(),true);await shot(`review-${profile}-${theme}-${layout}-${width}`);
 await dialog.getByRole('button',{name:'Back',exact:true}).click();assert.equal(await dialog.locator('.zfsm-form-grid').isVisible(),true);assert.equal(await dialog.locator('[data-confirm-operation]').count(),0);assert.equal(await dialog.locator('[name=acknowledge]').isChecked(),true);
 await dialog.getByRole('button',{name:'Close action',exact:true}).click();assert.equal(await page.locator('dialog:modal').count(),0);assert.equal(await page.locator('.zfsm-actions [aria-label="Destroy dataset"]').evaluate(el=>el===document.activeElement),true);assert.equal(calls('destroydataset').length,0);
});
await run('Escape clears preview acknowledgment and restores focus without changing the page',async()=>{
 await fresh({width:390});const dialog=await open();await preview(dialog);await review(dialog);await page.keyboard.press('Escape');assert.equal(await page.locator('dialog:modal').count(),0);assert.equal(await page.locator('.zfsm-actions [aria-label="Destroy dataset"]').evaluate(el=>el===document.activeElement),true);
 const next=await open();assert.equal(await next.locator('[name=acknowledge]').isChecked(),false);assert.equal(await next.locator('button[type=submit]').isDisabled(),true);assert.equal(await next.locator('[data-confirm-operation]').count(),0);assert.equal(calls('destroydataset').length,0);
});
await run('changed scope requires fresh preview and final confirmation submits once with GUID and token',async()=>{
 await fresh();const expectedGuid=String(mock.model.find(project).guid),dialog=await open();await preview(dialog);await review(dialog);await dialog.getByRole('button',{name:'Back',exact:true}).click();await dialog.locator('[name=force]').check();assert.equal(await dialog.locator('button[type=submit]').isDisabled(),true);assert.equal(await dialog.locator('[name=acknowledge]').isChecked(),false);await preview(dialog);await review(dialog);
 const response=page.waitForResponse(r=>r.url()===mock.url+'/mock/admin'&&new URLSearchParams(r.request().postData()).get('cmd')==='destroydataset');await dialog.locator('[data-confirm-operation]').click();await response;await dialog.locator('[data-result=success]').waitFor();assert.equal(calls('destroydataset').length,1);const request=calls('destroydataset')[0];assert.equal(request.force,'1');assert.match(request.preview_token,/^[a-f0-9]{64}$/);assert.equal(request.expected_guid,expectedGuid);assert.equal(request.csrf_token,'fixture-token');assert.equal(await dialog.getByRole('button',{name:'Close action',exact:true}).isEnabled(),true);
});
await run('GUID change during review blocks confirmation and Close remains available',async()=>{
 await fresh({profile:30});const dialog=await open('Rename dataset');await dialog.locator('[name=newname]').fill(lab+'/renamed');await review(dialog);mock.model.find(project).guid='999999';await page.evaluate(()=>zfsm_workspace.refresh());await dialog.getByRole('alert').filter({hasText:/identity changed/}).waitFor();assert.equal(await dialog.locator('[data-confirm-operation]').isDisabled(),true);await dialog.locator('[data-confirm-operation]').dispatchEvent('click');assert.equal(calls('renamedataset').length,0);assert.equal(await dialog.getByRole('button',{name:'Close action',exact:true}).isEnabled(),true);await page.keyboard.press('Escape');assert.equal(await page.locator('dialog:modal').count(),0);
});
await run('closing during request does not cancel retry or replay and reopening stays guarded',async()=>{
 await fresh();let release,started,submitted=0;const pending=new Promise(r=>release=r),arrived=new Promise(r=>started=r);
 await page.route('**/mock/admin',async route=>{if(new URLSearchParams(route.request().postData()).get('cmd')!=='renamedataset')return route.continue();submitted++;started();await pending;await route.fulfill({json:{succeeded:{},failed:{request:'Synthetic busy dependency'}}});});
 let dialog=await open('Rename dataset');await dialog.locator('[name=newname]').fill(lab+'/renamed');await review(dialog);await dialog.locator('[data-confirm-operation]').click();await arrived;await dialog.getByRole('progressbar',{name:'Operation progress'}).waitFor();await dialog.getByRole('button',{name:'Close action',exact:true}).click();dialog=await open('Rename dataset');assert.equal(await dialog.locator('button[type=submit]').isDisabled(),true);release();await dialog.locator('button[type=submit]').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('.zfsm-action-dialog form').matches('[aria-busy=true]'));assert.equal(await dialog.locator('[data-confirm-operation]').count(),0);assert.equal(calls('cancelconversion').length,0);assert.equal(submitted,1);await shot('pending-close-reopen');
});
await run('property review uses the same bounded window and Back retains unsaved inputs',async()=>{
 await fresh({width:390});const dialog=await open('Edit Dataset');await dialog.locator('[name=compression]').selectOption('zstd');await dialog.locator('[data-save-property=compression]').click();await dialog.locator('[data-confirm-operation]').waitFor();fits(await geometry(dialog));assert.equal(await dialog.locator('.zfsm-form-grid').isVisible(),false);await dialog.getByRole('button',{name:'Back',exact:true}).click();assert.equal(await dialog.locator('[name=compression]').inputValue(),'zstd');assert.equal(calls('editdatasetproperty').length,0);await shot('properties-mobile');
});
await run('directory snapshot and Jobs recovery entry points open one action window without mutations',async()=>{
 await fresh();await page.locator('[data-node="/mnt/'+project+'/ordinary"]').click();let dialog=await open('Delete directory');await dialog.getByRole('button',{name:'Close action',exact:true}).click();await page.locator('[data-node="'+project+'"]').click();await page.locator('[data-tab=snapshots]').click();const row=page.locator('tr').filter({has:page.getByText(project+'@base',{exact:true})});await row.getByRole('button',{name:'Operations',exact:true}).click();await page.locator('[data-snapshot-action=renamesnapshot]').filter({visible:true}).click();dialog=page.getByRole('dialog',{name:'Rename snapshot',exact:true});await dialog.waitFor();await page.keyboard.press('Escape');assert.equal(await row.getByRole('button',{name:'Operations',exact:true}).evaluate(el=>el===document.activeElement),true,'Return to the visible snapshot menu trigger');await page.locator('[data-section=jobs]').click();await page.locator('[data-job-id="20261016-100002-222222222222"] > details > summary').click();await page.getByRole('button',{name:'Resume',exact:true}).click();dialog=page.getByRole('dialog',{name:'Resume conversion',exact:true});await dialog.waitFor();assert.equal(await page.locator('dialog:modal').count(),1);assert.equal(calls('resumeconversion').length,0);assert.equal(calls('deletedirectory').length,0);assert.equal(calls('renamesnapshot').length,0);
});

await run('Jobs polling preserves the logical return focus after replacing its opener',async()=>{
 await fresh();await page.locator('[data-section=jobs]').click();const row=page.locator('[data-job-id="20261016-100002-222222222222"]');await row.locator('> details > summary').click();await row.getByRole('button',{name:'Resume',exact:true}).evaluate(el=>el.dataset.oldOpener='');await row.getByRole('button',{name:'Resume',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Resume conversion',exact:true});await dialog.waitFor();
 await page.waitForResponse(r=>r.url()===mock.url+'/mock/admin'&&new URLSearchParams(r.request().postData()).get('cmd')==='conversionjobs');await page.waitForFunction(()=>!document.querySelector('[data-job-id="20261016-100002-222222222222"] [data-old-opener]'));
 await page.keyboard.press('Escape');assert.equal(await row.getByRole('button',{name:'Resume',exact:true}).evaluate(el=>el===document.activeElement),true);assert.equal(calls('resumeconversion').length,0);
});

await run('removed target closes the action and retired confirmation cannot submit',async()=>{
 await fresh({profile:30});const dialog=await open('Rename dataset');await dialog.locator('[name=newname]').fill(lab+'/renamed');await review(dialog);const retired=await dialog.locator('[data-confirm-operation]').elementHandle();delete mock.model.find(lab).child[project];await page.evaluate(()=>zfsm_workspace.refresh());await dialog.waitFor({state:'detached'});assert.equal(await page.locator('dialog:modal').count(),0);await retired.evaluate(el=>el.click());assert.equal(calls('renamedataset').length,0);assert.notEqual(await page.evaluate(()=>zfsm_workspace.getState().selection),project);
});
await run('late preview after close cannot approve a new action window',async()=>{
 await fresh();let release,started;const pending=new Promise(r=>release=r),arrived=new Promise(r=>started=r);
 await page.route('**/mock/admin',async route=>{if(new URLSearchParams(route.request().postData()).get('cmd')!=='previewdestroy')return route.continue();const response=await route.fetch();started();await pending;await route.fulfill({response});});
 let dialog=await open();await dialog.locator('[data-preview]').click();await arrived;await page.keyboard.press('Escape');dialog=await open();const answered=page.waitForResponse(r=>r.url()===mock.url+'/mock/admin'&&new URLSearchParams(r.request().postData()).get('cmd')==='previewdestroy');release();await answered;await page.evaluate(()=>new Promise(r=>requestAnimationFrame(r)));assert.equal(await dialog.locator('[name=acknowledge]').isChecked(),false);assert.equal(await dialog.locator('button[type=submit]').isDisabled(),true);assert.equal(await dialog.locator('.zfsm-destroy-summary').count(),0);assert.equal(calls('destroydataset').length,0);
});
await run('preview rejection is readable and Close stays available on a short viewport',async()=>{
 await fresh({width:390});await page.setViewportSize({width:390,height:360});await page.route('**/mock/admin',async route=>{if(new URLSearchParams(route.request().postData()).get('cmd')!=='previewdestroy')return route.continue();const answer=await(await route.fetch()).json();answer.can_destroy=false;await route.fulfill({json:answer});});const dialog=await open();await preview(dialog);await dialog.getByText(/backend has not approved/).waitFor();assert.equal(await dialog.locator('button[type=submit]').isDisabled(),true);assert.equal(await dialog.getByRole('button',{name:'Close action',exact:true}).isEnabled(),true);fits(await geometry(dialog));await shot('preview-blocked-mobile');
});
await run('callbacks from a disposed dialog cannot close a newer action',async()=>{
 await fresh();let dialog=await open();const retired=await dialog.getByRole('button',{name:'Close action',exact:true}).elementHandle();await page.keyboard.press('Escape');dialog=await open('Rename dataset');await retired.evaluate(el=>el.click());assert.equal(await dialog.isVisible(),true);assert.equal(await page.locator('dialog:modal').count(),1);
});

await run('Create Dataset from Properties restores the inline editor and unsaved draft on Close',async()=>{
 await fresh();await page.locator('[data-tab=properties]').click();await page.locator('[name=compression]').selectOption('zstd');await page.getByRole('button',{name:'Create Dataset',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Create dataset',exact:true});await dialog.waitFor();await page.keyboard.press('Escape');await page.locator('.zfsm-detail [name=compression]').waitFor();assert.equal(await page.locator('.zfsm-detail [name=compression]').inputValue(),'zstd');assert.equal(calls('createdataset').length,0);assert.equal(calls('editdatasetproperty').length,0);
});

await run('snapshot batch displays current target and determinate progress while requests are pending',async()=>{
 await fresh();mock.model.failedSnapshot=project+'@protected';await page.locator('[data-tab=snapshots]').click();for(const name of [project+'@base',project+'@protected'])await page.getByRole('checkbox',{name:'Select snapshot '+name,exact:true}).check();await page.getByRole('button',{name:'Destroy selected snapshots',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Destroy snapshots',exact:true});await preview(dialog);await review(dialog);
 let firstReady,secondReady,releaseFirst,releaseSecond,count=0;const first=new Promise(r=>firstReady=r),second=new Promise(r=>secondReady=r),gateFirst=new Promise(r=>releaseFirst=r),gateSecond=new Promise(r=>releaseSecond=r);
 await page.route('**/mock/admin',async route=>{if(new URLSearchParams(route.request().postData()).get('cmd')!=='destroysnapshot')return route.continue();count++;if(count===1){firstReady();await gateFirst;}else{secondReady();await gateSecond;}await route.continue();});
 try{await dialog.locator('[data-confirm-operation]').click();await first;const bar=dialog.getByRole('progressbar',{name:'Snapshot deletion progress',exact:true});await bar.waitFor();assert.equal(await bar.getAttribute('max'),'2');assert.equal(await bar.getAttribute('value'),'0');await dialog.getByText('Deleting '+project+'@base · 1 of 2',{exact:true}).waitFor();await shot('snapshot-batch-progress');releaseFirst();await second;assert.equal(await bar.getAttribute('value'),'1');await dialog.getByText('Deleting '+project+'@protected · 2 of 2',{exact:true}).waitFor();releaseSecond();await dialog.getByText('Partially completed',{exact:true}).waitFor();assert.equal(count,2);}finally{releaseFirst();releaseSecond();}
});

await run('successful snapshot deletion returns focus to a usable control when the original button is disabled',async()=>{
 await fresh();await page.locator('[data-tab=snapshots]').click();await page.getByRole('checkbox',{name:'Select snapshot '+project+'@base',exact:true}).check();await page.getByRole('button',{name:'Destroy selected snapshots',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Destroy snapshots',exact:true});await preview(dialog);await review(dialog);await dialog.locator('[data-confirm-operation]').click();await dialog.locator('[data-result=success]').waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('button')].find(el=>el.textContent==='Destroy selected snapshots')?.disabled===true);await page.keyboard.press('Escape');assert.equal(await page.locator('.zfsm-tabs [data-tab=snapshots]').evaluate(el=>el===document.activeElement),true);
});

await run('renaming a snapshot returns to the active tab after its original row disappears',async()=>{
 await fresh();await page.locator('[data-tab=snapshots]').click();const row=page.locator('tr').filter({has:page.getByText(project+'@base',{exact:true})});await row.getByRole('button',{name:'Operations',exact:true}).click();await page.locator('[data-snapshot-action=renamesnapshot]').filter({visible:true}).click();const dialog=page.getByRole('dialog',{name:'Rename snapshot',exact:true});await dialog.locator('[name=newname]').fill('renamed');await review(dialog);await dialog.locator('[data-confirm-operation]').click();await dialog.locator('[data-result=success]').waitFor();await page.waitForFunction(name=>![...document.querySelectorAll('[data-file-manager]')].some(el=>el.dataset.fileManager===name),project+'@base');await page.keyboard.press('Escape');assert.equal(await page.locator('.zfsm-tabs [data-tab=snapshots]').evaluate(el=>el===document.activeElement),true);
});
}finally{await writeFile(out+'/results.json',JSON.stringify({at:new Date().toISOString(),scope:'Local Chromium; synthetic HTTP/ZFS; no test-host access',results,errors},null,2)+'\n');if(context)await context.close();await browser.close();await mock.close();}
console.log(JSON.stringify({pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL').length,errors}));process.exitCode=results.some(r=>r.status==='FAIL')||errors.length?1:0;
