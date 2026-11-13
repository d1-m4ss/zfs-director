import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// Actual frontend in isolated Chromium. All request responses are local fixtures;
// no HTTP listener, server connection or native storage operation is used.
const require=createRequire(import.meta.url),{chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const out=resolve(process.env.ZFSM_OUTPUT||'evidence/workspace-navigation-2026-10-20');await mkdir(out,{recursive:true});
const files=['ZFSMInventory','ZFSMForms','ZFSMSnapshots','ZFSMExplorer','ZFSMPoolView','ZFSMOverview','ZFSMHistory','ZFSMWorkspace'];
const scripts=await Promise.all(files.map(name=>readFile(name==='ZFSMWorkspace'&&process.env.ZFSM_WORKSPACE_SOURCE?process.env.ZFSM_WORKSPACE_SOURCE:'src/frontend/'+name+'.js','utf8'))),css=await readFile('src/frontend/ZFSMWorkspace.css','utf8');
const browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true}),results=[],errors=[];
const mutation='/mnt/cache/a/.zfsm-mutation-'+'a'.repeat(48),ordinary='/mnt/cache/a/ordinary-65';
async function settled(page){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function setup(page,layout){
 await page.route('**/*',route=>route.abort());page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<style>body{margin:0;padding:16px;font:13px Arial,sans-serif;background:#ececec;color:#222}</style><main id="zfsm-workspace"></main><div style="height:800px"></div>');await page.addStyleTag({content:css});
 for(const content of scripts)await page.addScriptTag({content});
 await page.evaluate(async ({mutation,refreshInterval})=>{
  window.zfsmFormatDateTime=String;
  const ds=(name,guid,type='filesystem')=>({name,guid,type,mountpoint:type==='volume'?'none':'/mnt/'+name,mounted:'yes',encryption:'off',keystatus:'none',used:100,referenced:100,available:1000,child:{},directories:[],snapshots:[]});
  const tree=ds('cache','1');for(const [i,name]of ['cache/a','cache/b','cache/volume'].entries())tree.child[name]=ds(name,String(i+2),name.endsWith('/volume')?'volume':'filesystem');
  const a=tree.child['cache/a'];a.directories=Array.from({length:80},(_,i)=>'/mnt/cache/a/ordinary-'+String(i).padStart(2,'0'));a.directories.push(mutation,'/mnt/cache/a/.zfsm-maintenance');a._directory_identities=Object.fromEntries(a.directories.map((name,i)=>[name,{dev:'1',ino:String(100+i)}]));
  const inventory={op:'getAll',data:{pools:{cache:{Health:'ONLINE',Size:1000,Used:100,Snapshots:0}},datasets:{cache:tree},devices:{cache:''},errors:{}}};
  window.navigationCalls=[];window.zfsm_workspace=zfsmCreateWorkspace({root:document.querySelector('main'),hostTheme:'white',config:{refresh_interval:refreshInterval,destructive_mode:1,directory_listing:['cache/a']},request:async fields=>{navigationCalls.push(fields);if(fields.cmd==='inventory'||fields.cmd==='inventorysnapshots')return inventory;if(fields.cmd==='conversionjobs')return {jobs:[{id:'fixture-delete',schema:6,type:'deletion',kind:'directory',state:'completed',stage:'completed',source:'/mnt/cache/deleted',recovery:{location:mutation,journal:'journal.jsonl',retained:true},actions:{}}],worker_running:false};if(fields.cmd==='getdatasetproperties')return tree.child[fields.zdataset]||tree;if(fields.cmd==='pooldiagnostics')throw Error('Synthetic unavailable diagnostics');throw Error('Unexpected '+fields.cmd);}});
 },{mutation,refreshInterval:['0','30'].includes(process.env.ZFSM_REFRESH_INTERVAL)?Number(process.env.ZFSM_REFRESH_INTERVAL):0});
 await page.locator('[data-node="cache/a"]').click();await page.locator('.zfsm-tabs [data-tab=actions]').click();
}
async function scrollSelection(page,path){
 const target=page.locator('[data-node="'+path+'"]');
 await target.evaluate(el=>{el.scrollIntoView({block:'center'});el.focus({preventScroll:true});});await settled(page);
 // The fixed-height frame scrolls either the tree pane itself (wide tree layout) or the
 // whole main body (narrow layout, or the Compact table where .zfsm-browser is overflow:visible).
 const read=()=>page.evaluate(()=>{const browserEl=document.querySelector('.zfsm-browser'),mainBody=document.querySelector('.zfsm-main-body'),container=browserEl.scrollHeight>browserEl.clientHeight+1?browserEl:mainBody;const focusedEl=document.activeElement,box=focusedEl?.getBoundingClientRect(),view=container.getBoundingClientRect();return {top:container.scrollTop,maxTop:container.scrollHeight-container.clientHeight,left:container.scrollLeft,pageY:scrollY,focused:focusedEl?.dataset.node,visible:Boolean(box&&box.bottom>view.top&&box.top<view.bottom)};});
 const before=await read();assert.ok(before.top>100,'Fixture must actually scroll the tree');await page.keyboard.press('Enter');await settled(page);const after=await read();
 assert.equal(after.focused,path,'Keyboard focus stays on the selected directory');// Position is kept; only when the content got shorter may it clamp to the new end, and the
 // selected row must then still be on screen.
 assert.ok(Math.abs(after.top-before.top)<=1||(after.top<before.top&&Math.abs(after.top-after.maxTop)<=1&&after.visible),JSON.stringify({before,after}));assert.equal(after.left,before.left);assert.ok(Math.abs(after.pageY-before.pageY)<=1,'Page position changed: '+JSON.stringify({before,after}));
 return {before,after};
}
try{
 for(const width of [390,1280])for(const layout of ['tree']){
  const page=await browser.newPage({viewport:{width,height:900}});try{
   await setup(page,layout);const normal=await scrollSelection(page,ordinary);
   for(const key of ['snapshots','properties','actions']){await page.locator('[data-node="cache/a"]').click();await page.locator('.zfsm-tabs [data-tab='+key+']').click();await page.locator('[data-node="cache/b"]').click();assert.equal(await page.evaluate(()=>zfsm_workspace.getState().tab),key);}
   assert.equal(await page.locator('[data-node="'+mutation+'"]').count(),0);await page.locator('[data-section=jobs]').click();await page.getByRole('button',{name:'Show recovery files',exact:true}).click();const recovery=await scrollSelection(page,mutation);assert.equal(await page.getByRole('button',{name:'Clean completed recovery',exact:true}).isEnabled(),true);assert.equal(await page.getByRole('button',{name:'Delete directory',exact:true}).count(),0);
   await page.screenshot({path:out+'/recovery-'+width+'-'+layout+'.png'});await page.getByRole('button',{name:'Hide recovery files',exact:true}).click();assert.equal(await page.locator('[data-node="'+mutation+'"]').count(),0);
   await page.locator('[data-section=jobs]').click();await page.locator('[data-job-id="fixture-delete"] > details > summary').click();assert.match(await page.locator('[data-job-id="fixture-delete"]').innerText(),/Recovery journal/);assert.doesNotMatch(await page.locator('[data-job-id="fixture-delete"]').innerText(),/"location"|Retained original/);
   await page.locator('[data-section=datasets]').click();assert.equal(await page.locator('.zfsm-tabs [data-tab=pool]').count(),0);await page.getByRole('button',{name:'Pool & Scrub',exact:true}).click();for(const key of ['status','information','devices']){await page.locator('.zfsm-pool-tabs [data-tab='+key+']').click();assert.equal(await page.evaluate(()=>zfsm_workspace.getState().tab),key);}
   assert.equal(await page.evaluate(()=>navigationCalls.some(fields=>['cleanupmutation','deletedirectory','movedirectory','scrubpool'].includes(fields.cmd))),false);assert.deepEqual(errors,[]);results.push({width,layout,status:'PASS',normal,recovery});
  }catch(error){results.push({width,layout,status:'FAIL',error:error.stack});await page.screenshot({path:out+'/failure-'+width+'-'+layout+'.png'});throw error;}finally{await page.close();}
 }
}finally{await browser.close();await writeFile(out+'/results.json',JSON.stringify({results,errors,boundary:'Actual offline Chromium/frontend; local fixtures only, no server or native storage operations.'},null,2)+'\n');console.log(JSON.stringify({pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL').length,results,errors}));}
