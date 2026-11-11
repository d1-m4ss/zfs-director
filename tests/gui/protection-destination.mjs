import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url),{chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const out=process.env.ZFSM_OUTPUT||'backups/2026-11-09/protection-destination';await mkdir(out,{recursive:true});
const scripts=await Promise.all(['ZFSMInventory','ZFSMForms','ZFSMSnapshots','ZFSMExplorer','ZFSMPoolView','ZFSMOverview','ZFSMHistory','ZFSMProtection','ZFSMWorkspace'].map(name=>readFile('src/frontend/'+name+'.js','utf8'))),css=await readFile('src/frontend/ZFSMWorkspace.css','utf8'),protectionCSS=await readFile('src/frontend/ZFSMProtection.css','utf8');
const browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true}),results=[],errors=[];
async function open(width){
 const page=await browser.newPage({viewport:{width,height:1000}});page.setDefaultTimeout(5000);await page.route('**/*',r=>r.abort());page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<style>body{margin:12px;font:14px Arial;background:#202020;color:#eee}</style><main id="zfsm-workspace"></main>');await page.addStyleTag({content:css+protectionCSS});for(const content of scripts)await page.addScriptTag({content});
 await page.evaluate(()=>{
  window.zfsmFormatDateTime=String;const ds=(name,guid)=>({name,guid,type:'filesystem',mountpoint:'/mnt/'+name,encryption:'off',keystatus:'none',child:{},directories:[],snapshots:[]}),tree=ds('cache','1');
  window.selectorData={datasets:['cache/a','cache/a/child','cache/b','backup','backup/x'].map((name,i)=>({name,guid:String(10+i)})),policies:[],replications:[{id:'rep-ok',name:'Saved replication',owner:'managed',source:'cache/a',target:'backup/x',mode:'local',enabled:false},{id:'rep-new',name:'Not yet created',owner:'managed',source:'cache/a',target:'backup/not-yet',mode:'local',enabled:false}],jobs:[],templates:{},issues:[],credentials:[],scheduler:{external:[],issues:[]}};
  window.zfsm_workspace=zfsmCreateWorkspace({root:document.querySelector('main'),config:{refresh_interval:0,destructive_mode:1},request:async fields=>{if(fields.cmd==='inventory')return {op:'getAll',data:{pools:{cache:{Health:'ONLINE',Size:1000,Used:1}},datasets:{cache:tree},devices:{cache:''},errors:{}}};if(fields.cmd==='conversionjobs')return {jobs:[],worker_running:true};if(fields.cmd==='pooldiagnostics')throw Error('Synthetic unavailable');if(fields.cmd==='protectiondetect')return {visible:true,installed:true,enabled:true,compatible:true,state:'healthy',issues:[],sanoid:{version:'2.3.0'},syncoid:{version:'2.3.0'}};if(fields.cmd==='protectiondata')return structuredClone(selectorData);throw Error('Unexpected command '+fields.cmd);}});
 });
 await page.locator('[data-section=replication]').click();return page;
}
const choiceOf=d=>d.getByRole('combobox',{name:'Destination dataset',exact:true});
const optionTexts=choice=>choice.locator('option').evaluateAll(items=>items.map(item=>item.textContent));

const parentOf=d=>d.getByRole('combobox',{name:'Destination parent dataset',exact:true}),nameOf=d=>d.getByRole('textbox',{name:'Replica name',exact:true}),previewOf=d=>d.locator('.zfsm-dest-preview');
try{
 for(const width of [390,1280]){
  let page,d;
  try{
   page=await open(width);
   await page.getByRole('button',{name:'New replication',exact:true}).click();d=page.getByRole('dialog');
   await d.getByRole('combobox',{name:'Source dataset',exact:true}).selectOption('cache/a');await d.getByRole('button',{name:'Next',exact:true}).click();
   // The destination is a parent dataset plus a name; nothing inside the source can be the parent.
   assert.deepEqual(await optionTexts(parentOf(d)),['Choose where to put the replica','cache/b','backup','backup/x'],'the source and its children cannot be a parent');
   assert.equal(await nameOf(d).inputValue(),'a','the replica name defaults to the source name');
   assert.match(await previewOf(d).textContent(),/Choose a parent dataset and a replica name/);
   await d.getByRole('button',{name:'Next',exact:true}).click();assert.match(await d.textContent(),/Choose a parent dataset and a valid replica name\./,'no parent chosen');
   // The replica is created INSIDE the chosen parent, never replacing it.
   await parentOf(d).selectOption('backup/x');assert.match(await previewOf(d).textContent(),/Will be created as: backup\/x\/a$/);
   await nameOf(d).fill('immich');assert.match(await previewOf(d).textContent(),/Will be created as: backup\/x\/immich$/);
   await nameOf(d).fill('bad name');assert.match(await previewOf(d).textContent(),/letters, digits/);await d.getByRole('button',{name:'Next',exact:true}).click();assert.match(await d.textContent(),/valid replica name/,'an invalid name is refused');
   await nameOf(d).fill('immich');await d.getByRole('button',{name:'Next',exact:true}).click();assert.equal(await d.getByRole('heading',{name:'Schedule'}).isVisible(),true);
   await d.getByRole('button',{name:'Back',exact:true}).click();assert.equal(await parentOf(d).inputValue(),'backup/x');assert.equal(await nameOf(d).inputValue(),'immich','Back keeps the parent and the name');
   // An existing path is flagged (nothing is overwritten silently).
   await parentOf(d).selectOption('backup');await nameOf(d).fill('x');assert.match(await previewOf(d).textContent(),/Will be created as: backup\/x — already exists on this server/);
   // Remote destinations cannot be listed: one text field with the full name.
   await d.getByRole('combobox',{name:'Destination mode',exact:true}).selectOption('remote');
   assert.equal(await parentOf(d).isVisible(),false);assert.equal(await nameOf(d).isVisible(),false);assert.equal(await d.getByRole('textbox',{name:'Destination dataset (full name on the remote server)',exact:true}).isVisible(),true);
   await d.getByRole('combobox',{name:'Destination mode',exact:true}).selectOption('local');assert.equal(await parentOf(d).isVisible(),true);
   await page.screenshot({path:out+'/'+width+'-create.png'});
   // Edit: a saved target is split into its parent and name; a not-yet-created one still resolves to an existing parent.
   await d.getByRole('button',{name:'Close',exact:true}).click();
   await page.locator('[data-replication-id=rep-ok]').click();await page.getByRole('button',{name:'Edit',exact:true}).click();d=page.getByRole('dialog');await d.getByRole('button',{name:'Next',exact:true}).click();
   assert.equal(await parentOf(d).inputValue(),'backup');assert.equal(await nameOf(d).inputValue(),'x');assert.doesNotMatch(await previewOf(d).textContent(),/already exists/,'its own saved target is not a warning');
   await d.getByRole('button',{name:'Close',exact:true}).click();
   await page.locator('[data-replication-id=rep-new]').click();await page.getByRole('button',{name:'Edit',exact:true}).click();d=page.getByRole('dialog');await d.getByRole('button',{name:'Next',exact:true}).click();
   assert.equal(await parentOf(d).inputValue(),'backup');assert.equal(await nameOf(d).inputValue(),'not-yet');assert.match(await previewOf(d).textContent(),/Will be created as: backup\/not-yet$/);
   results.push({width,status:'PASS'});
  }catch(e){results.push({width,status:'FAIL',error:e.stack});if(page&&!page.isClosed())await page.screenshot({path:out+'/FAIL-'+width+'.png'}).catch(()=>{});throw e;}finally{if(page&&!page.isClosed())await page.close().catch(()=>{});}
 }
}finally{await browser.close();await writeFile(out+'/results.json',JSON.stringify({results,errors,scope:'Actual offline Chromium Workspace/Protection replication wizard; synthetic datasets. No test-host.'},null,2)+'\n');console.log(JSON.stringify({results,errors}));if(results.some(r=>r.status!=='PASS')||errors.length)process.exitCode=1;}
