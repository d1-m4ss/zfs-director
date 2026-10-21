import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url),{chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const out=process.env.ZFSM_OUTPUT||'backups/2026-10-20/refresh-fixes/selectors',refreshInterval=Number(process.env.ZFSM_REFRESH_INTERVAL)||0;await mkdir(out,{recursive:true});
const scripts=await Promise.all(['ZFSMInventory','ZFSMForms','ZFSMSnapshots','ZFSMExplorer','ZFSMPoolView','ZFSMOverview','ZFSMHistory','ZFSMProtection','ZFSMWorkspace'].map(name=>readFile('src/frontend/'+name+'.js','utf8'))),css=await readFile('src/frontend/ZFSMWorkspace.css','utf8'),protectionCSS=await readFile('src/frontend/ZFSMProtection.css','utf8');
const browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true}),results=[],errors=[];
try{
 for(const width of [390,1280])for(const layout of ['tree','table'])for(const names of [['cache/current'],[]]){
  const page=await browser.newPage({viewport:{width,height:1000}});page.setDefaultTimeout(5000);await page.route('**/*',r=>r.abort());page.on('pageerror',e=>errors.push(e.message));
  try{
   await page.setContent('<style>body{margin:12px;font:14px Arial;background:#202020;color:#eee}</style><main id="zfsm-workspace"></main>');await page.addStyleTag({content:css+protectionCSS});for(const content of scripts)await page.addScriptTag({content});
   await page.evaluate(({names,refreshInterval})=>{
    window.zfsmFormatDateTime=String;const ds=(name,guid)=>({name,guid,type:'filesystem',mountpoint:'/mnt/'+name,encryption:'off',keystatus:'none',child:{},directories:[],snapshots:[]}),tree=ds('cache','1');tree.child['cache/deleted']=ds('cache/deleted','2');
    window.selectorCalls=[];window.selectorData={datasets:names.map(name=>({name,guid:'3'})),policies:[],replications:[],jobs:[],templates:{},issues:[],credentials:[],scheduler:{external:[],issues:[]}};
    window.zfsm_workspace=zfsmCreateWorkspace({root:document.querySelector('main'),config:{refresh_interval:refreshInterval,destructive_mode:1},request:async fields=>{selectorCalls.push(fields);if(fields.cmd==='inventory')return {op:'getAll',data:{pools:{cache:{Health:'ONLINE',Size:1000,Used:1}},datasets:{cache:tree},devices:{cache:''},errors:{}}};if(fields.cmd==='conversionjobs')return {jobs:[],worker_running:true};if(fields.cmd==='pooldiagnostics')throw Error('Synthetic unavailable');if(fields.cmd==='protectiondetect')return {visible:true,installed:true,enabled:true,compatible:true,state:'healthy',issues:[],sanoid:{version:'2.3.0'},syncoid:{version:'2.3.0'}};if(fields.cmd==='protectiondata')return structuredClone(selectorData);throw Error('Unexpected command '+fields.cmd);}});
   },{names,refreshInterval});
   await page.locator('[data-layout-choice='+layout+']').click();
   for(const [section,label,field]of [['protection','New policy','dataset'],['replication','New replication','source']]){
    await page.locator('[data-section='+section+']').click();await page.getByRole('button',{name:label,exact:true}).click();const d=page.getByRole('dialog');assert.deepEqual(await d.locator('[name='+field+'] option').evaluateAll(items=>items.map(o=>o.value)),['',...names]);await page.screenshot({path:out+'/'+width+'-'+layout+'-'+section+'-'+names.length+'.png'});await d.getByRole('button',{name:'Close',exact:true}).click();
   }
   await page.evaluate(()=>{selectorData.policies=[{id:'missing',name:'Saved policy',owner:'managed',dataset:'cache/deleted',enabled:false,hourly:24,daily:7}];selectorData.replications=[{id:'missing-rep',name:'Saved replication',owner:'managed',source:'cache/deleted',target:'backup/a',enabled:false}];});
   await page.locator('[data-section=protection]').click();await page.locator('[data-policy-id=missing]').click();await page.locator('[data-edit-policy=missing]').click();let d=page.getByRole('dialog');assert.equal(await d.locator('[name=dataset]').inputValue(),'cache/deleted');assert.equal(await d.locator('[name=dataset] option:checked').evaluate(el=>el.disabled),true);await d.getByRole('button',{name:'Review changes',exact:true}).click();assert.equal(await d.locator('[data-review-save]').count(),0);await d.getByRole('button',{name:'Close',exact:true}).click();
   await page.locator('[data-section=replication]').click();await page.locator('[data-replication-id=missing-rep]').click();await page.getByRole('button',{name:'Edit',exact:true}).click();d=page.getByRole('dialog');assert.equal(await d.locator('[name=source] option:checked').evaluate(el=>el.disabled),true);await d.getByRole('button',{name:'Next',exact:true}).click();assert.equal(await d.locator('[name=target]').count(),0);await page.screenshot({path:out+'/'+width+'-'+layout+'-unavailable-'+names.length+'.png'});
   assert.equal(await page.evaluate(()=>selectorCalls.some(c=>/preview|save|run$/.test(c.cmd))),false);results.push({width,layout,fresh_datasets:names,initial_refresh_interval:refreshInterval,status:'PASS'});
  }catch(e){results.push({width,layout,fresh_datasets:names,status:'FAIL',error:e.stack});await page.screenshot({path:out+'/FAIL-'+results.length+'.png'});throw e;}finally{await page.close();}
 }
}finally{await browser.close();await writeFile(out+'/results.json',JSON.stringify({results,errors,scope:'Actual offline Chromium Workspace/Protection; synthetic current discovery and stale inventory. No test-host.'},null,2)+'\n');console.log(JSON.stringify({pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL').length,errors}));}
