import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url),{chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const out=process.env.ZFSM_OUTPUT||'backups/2026-11-09/dataset-checklist';await mkdir(out,{recursive:true});
const scripts=await Promise.all(['ZFSMInventory','ZFSMForms','ZFSMSnapshots','ZFSMExplorer','ZFSMPoolView','ZFSMOverview','ZFSMProtection','ZFSMWorkspace'].map(name=>readFile('src/frontend/'+name+'.js','utf8'))),css=await readFile('src/frontend/ZFSMWorkspace.css','utf8'),protectionCSS=await readFile('src/frontend/ZFSMProtection.css','utf8');
const browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true}),results=[],errors=[];
async function open(width,section){
 const page=await browser.newPage({viewport:{width,height:1100}});page.setDefaultTimeout(5000);await page.route('**/*',r=>r.abort());page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<style>body{margin:12px;font:14px Arial;background:#202020;color:#eee}</style><main id="zfsm-workspace"></main>');await page.addStyleTag({content:css+protectionCSS});for(const content of scripts)await page.addScriptTag({content});
 await page.evaluate(()=>{
  window.zfsmFormatDateTime=String;const ds=(name,guid)=>({name,guid,type:'filesystem',mountpoint:'/mnt/'+name,encryption:'off',keystatus:'none',child:{},directories:[],snapshots:[]}),tree=ds('cache','1');
  tree.child['cache/a']=ds('cache/a','2');tree.child['cache/b']=ds('cache/b','3');tree.child['cache/a'].child['cache/a/c1']=ds('cache/a/c1','4');tree.child['cache/a'].child['cache/a/c2']=ds('cache/a/c2','5');
  window.calls=[];
  window.selectorData={datasets:['cache/a','cache/a/c1','cache/a/c2','cache/b'].map((name,i)=>({name,guid:String(10+i)})),policies:[],replications:[{id:'rep',name:'Saved replication',owner:'managed',source:'cache/a',target:'cache/b',mode:'local',enabled:false,exclusions:['cache/a/c1','cache/a/old']}],jobs:[],templates:{},issues:[],credentials:[],scheduler:{external:[{source_id:'ext1',file:'/boot/config/plugins/user.scripts/x/script',source_kind:'user_script',ownership_state:'external',managed_definition:{type:'policy'},datasets:['cache/a']}],issues:[]}};
  window.zfsm_workspace=zfsmCreateWorkspace({root:document.querySelector('main'),config:{refresh_interval:0,destructive_mode:1,directory_listing:'cache/a\ncache/gone'},request:async fields=>{calls.push(fields);if(fields.cmd==='inventory')return {op:'getAll',data:{pools:{cache:{Health:'ONLINE',Size:1000,Used:1}},datasets:{cache:tree},devices:{cache:''},errors:{}}};if(fields.cmd==='conversionjobs')return {jobs:[],worker_running:true};if(fields.cmd==='pooldiagnostics')throw Error('Synthetic unavailable');if(fields.cmd==='protectiondetect')return {visible:true,installed:true,enabled:true,compatible:true,state:'healthy',issues:[],sanoid:{version:'2.3.0'},syncoid:{version:'2.3.0'}};if(fields.cmd==='protectiondata')return structuredClone(selectorData);if(fields.cmd==='validatesettings')return {valid:true,errors:{},snapshot_preview:'cache/a@x'};throw Error('Unexpected command '+fields.cmd);}});
 });
 await page.locator('[data-section='+section+']').click();return page;
}
const rows=box=>box.locator('.zfsm-checklist-list .zfsm-checklist-row').evaluateAll(items=>items.map(i=>[i.textContent,i.querySelector('input').checked]));
try{
 for(const width of [390,1280]){
  let page,d;
  try{
   // Settings: the folder listing is chosen from the dataset menu only (UX-016)
   page=await open(width,'settings');
   await page.locator('details').evaluateAll(items=>items.forEach(i=>i.open=true));await page.getByRole('button',{name:'Save settings',exact:true}).waitFor();
   assert.equal(await page.locator('textarea[name=directory_listing]').count(),0);assert.equal(await page.locator('.zfsm-checklist').count(),0);
   await page.getByRole('button',{name:'Save settings',exact:true}).click();await page.waitForFunction(()=>calls.some(c=>c.cmd==='validatesettings'||c.cmd==='saveconfig'));
   assert.equal(await page.evaluate(()=>Object.hasOwn(calls.filter(c=>c.settings).at(-1).settings,'directory_listing')),false,'Settings does not send the folder listing');
   await page.screenshot({path:out+'/'+width+'-settings.png'});await page.close();
   // Replication: exclusions are children of the source
   page=await open(width,'replication');await page.locator('[data-replication-id=rep]').click();await page.getByRole('button',{name:'Edit',exact:true}).click();d=page.getByRole('dialog');
   await d.getByRole('button',{name:'Next',exact:true}).click();await d.getByRole('button',{name:'Next',exact:true}).click();
   await d.locator('details').evaluateAll(items=>items.forEach(i=>i.open=true));
   const rbox=d.locator('.zfsm-checklist').first();await rbox.waitFor();
   assert.deepEqual(await rows(rbox),[['cache/a/c1',true],['cache/a/c2',false]],'only children of the source are offered');
   assert.deepEqual(await rbox.locator('.zfsm-checklist-missing .zfsm-checklist-row').evaluateAll(items=>items.map(i=>[i.textContent,i.querySelector('input').checked])),[['cache/a/old',true]]);
   await rbox.getByRole('checkbox',{name:'cache/a/c2',exact:true}).check();assert.equal(await d.locator('textarea[name=exclusions]').inputValue(),'cache/a/c1\ncache/a/c2\ncache/a/old');
   await page.screenshot({path:out+'/'+width+'-replication.png'});await page.close();
   // Policy: nothing to pick until a dataset is chosen
   page=await open(width,'protection');await page.getByRole('button',{name:'New policy',exact:true}).click();d=page.getByRole('dialog');await d.locator('details').evaluateAll(items=>items.forEach(i=>i.open=true));
   const pbox=d.locator('.zfsm-checklist').first();assert.match(await pbox.textContent(),/Choose a source dataset to list its child datasets\./);
   await d.locator('[name=dataset]').selectOption('cache/a');assert.deepEqual(await rows(pbox),[['cache/a/c1',false],['cache/a/c2',false]]);
   await pbox.getByRole('checkbox',{name:'cache/a/c2',exact:true}).check();assert.equal(await d.locator('textarea[name=exclusions]').inputValue(),'cache/a/c2');
   await d.locator('[name=dataset]').selectOption('cache/b');assert.deepEqual(await rows(pbox),[]);
   await page.close();
   // External → Managed transfer of a snapshot policy uses the same checklist (its dataset field is "dataset").
   page=await open(width,'protection');await page.locator('details').evaluateAll(items=>items.forEach(i=>i.open=true));await page.getByRole('button',{name:'Review transfer'}).first().click();d=page.getByRole('dialog');
   await d.locator('details').evaluateAll(items=>items.forEach(i=>i.open=true));
   const xbox=d.locator('.zfsm-checklist').first();await xbox.waitFor();assert.deepEqual(errors,[],'opening the transfer form must not throw');
   await d.locator('[name=dataset]').selectOption('cache/a');assert.deepEqual(await rows(xbox),[['cache/a/c1',false],['cache/a/c2',false]]);
   await xbox.getByRole('checkbox',{name:'cache/a/c1',exact:true}).check();assert.equal(await d.locator('textarea[name=exclusions]').inputValue(),'cache/a/c1');
   results.push({width,status:'PASS'});
  }catch(e){results.push({width,status:'FAIL',error:e.stack});if(page&&!page.isClosed())await page.screenshot({path:out+'/FAIL-'+width+'.png'});throw e;}finally{if(page&&!page.isClosed())await page.close();}
 }
}finally{await browser.close();await writeFile(out+'/results.json',JSON.stringify({results,errors,scope:'Actual offline Chromium Workspace; synthetic datasets. No test-host.'},null,2)+'\n');console.log(JSON.stringify({results,errors}));if(results.some(r=>r.status!=='PASS')||errors.length)process.exitCode=1;}
