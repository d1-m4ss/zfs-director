import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url),{chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const out=process.env.ZFSM_OUTPUT||'backups/2026-11-09/protection-status';await mkdir(out,{recursive:true});
const scripts=await Promise.all(['ZFSMDateTime','ZFSMInventory','ZFSMForms','ZFSMSnapshots','ZFSMExplorer','ZFSMPoolView','ZFSMOverview','ZFSMHistory','ZFSMProtection','ZFSMWorkspace'].map(name=>readFile('src/frontend/'+name+'.js','utf8'))),css=await readFile('src/frontend/ZFSMWorkspace.css','utf8'),protectionCSS=await readFile('src/frontend/ZFSMProtection.css','utf8');
const browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true}),results=[],errors=[];
async function open(width,section){
 const page=await browser.newPage({viewport:{width,height:1100}});page.setDefaultTimeout(5000);await page.route('**/*',r=>r.abort());page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<style>body{margin:12px;font:14px Arial;background:#202020;color:#eee}</style><main id="zfsm-workspace"></main>');await page.addStyleTag({content:css+protectionCSS});for(const content of scripts)await page.addScriptTag({content});
 await page.evaluate(()=>{
  window.zfsmDateTimeSettings={timeZone:'UTC',dateFormat:'%A, %d-%m-%Y',timeFormat:'%T'};
  const ds=(name,guid)=>({name,guid,type:'filesystem',mountpoint:'/mnt/'+name,encryption:'off',keystatus:'none',child:{},directories:[],snapshots:[]}),tree=ds('cache','1');
  const run=(outcome)=>({verified_outcome:outcome,finished_at:'2026-11-09T22:17:05Z',verification:{verified:true,lag_seconds:42}});
  window.selectorData={datasets:['cache/a','cache/b','backup/x'].map((name,i)=>({name,guid:String(10+i)})),
   policies:[{id:'p1',name:'Daily',owner:'managed',dataset:'cache/a',enabled:true,hourly:24,daily:7,last_job:run('up_to_date')},{id:'p2',name:'Fresh',owner:'managed',dataset:'cache/b',enabled:false,hourly:24,daily:7},{id:'p3',name:'sanoid',owner:'external',dataset:'cache/a',enabled:true}],
   replications:[{id:'r1',name:'Nightly',owner:'managed',source:'cache/a',target:'backup/x',mode:'local',schedule:'0 2 * * *',enabled:true,last_job:run('completed')},{id:'r2',name:'Paused',owner:'managed',source:'cache/b',target:'backup/x',mode:'local',schedule:'0 3 * * *',enabled:false}],
   jobs:[],templates:{},issues:[],credentials:[],scheduler:{external:[],issues:[]}};
  window.zfsm_workspace=zfsmCreateWorkspace({root:document.querySelector('main'),config:{refresh_interval:0,destructive_mode:1},request:async fields=>{if(fields.cmd==='inventory')return {op:'getAll',data:{pools:{cache:{Health:'ONLINE',Size:1000,Used:1}},datasets:{cache:tree},devices:{cache:''},errors:{}}};if(fields.cmd==='conversionjobs')return {jobs:[],worker_running:true};if(fields.cmd==='pooldiagnostics')throw Error('Synthetic unavailable');if(fields.cmd==='protectiondetect')return {visible:true,installed:true,enabled:true,compatible:true,state:'healthy',issues:[],sanoid:{version:'2.3.0'},syncoid:{version:'2.3.0'}};if(fields.cmd==='protectiondata')return structuredClone(selectorData);if(fields.cmd==='protectionrunpreview'){const snap=(name)=>({name,creation:1766949364,txg:'1'});return {preview_id:'e'.repeat(32),token:'signed',review:{type:'run',value:{type:'replication',id:'r1'},warnings:['No automatic rollback, foreign snapshot cleanup or destination deletion.'],inspection:{source:{'':{guid:'1',snapshots:{111:snap('2025-12-28-211604'),222:snap('autosnap_2026-11-09_20:17:05_daily')}},'/a-rather-long-child-dataset-name/library':{guid:'2',snapshots:{333:snap('2025-12-28-211604'),444:snap('autosnap_2026-11-09_20:17:05_daily')}}},target:{'':{guid:'9',snapshots:[]}},expected:{'':'222','/a-rather-long-child-dataset-name/library':'444'},blockers:[]}}};}throw Error('Unexpected command '+fields.cmd);}});
 });
 await page.locator('[data-section='+section+']').click();return page;
}
// No cell content may spill into a neighbouring cell or past the table.
const overlaps=page=>page.evaluate(()=>{
 const problems=[];
 for(const tr of document.querySelectorAll('.zfsm-protection-table tbody tr')){
  const cells=[...tr.cells].map(td=>td.getBoundingClientRect());
  [...tr.cells].forEach((td,i)=>{
   if(td.scrollWidth>td.clientWidth+1)problems.push('cell '+i+' content wider than its cell: '+td.scrollWidth+'>'+td.clientWidth);
   for(const child of td.querySelectorAll('*')){const r=child.getBoundingClientRect();if(r.width&&(r.right>cells[i].right+1||r.left<cells[i].left-1))problems.push('cell '+i+' child '+child.className+' leaves its cell');}
  });
  const visible=cells.filter(c=>c.width>0);
  if(window.innerWidth>760)for(let i=1;i<visible.length;i++)if(visible[i].left<visible[i-1].right-1)problems.push('cells '+(i-1)+' and '+i+' overlap');
 }
 return problems;
});
const stack=(page,id)=>page.locator('tr[data-definition-id='+id+'] .zfsm-status-stack').evaluate(box=>[...box.children].map(c=>c.textContent));
try{
 for(const width of [390,1280]){
  let page;
  try{
   page=await open(width,'protection');
   assert.deepEqual(await stack(page,'p1'),['Up to date','Schedule: on','Managed by ZFS Director']);
   assert.deepEqual(await stack(page,'p2'),['Not run yet','Schedule: paused','Managed by ZFS Director']);
   assert.deepEqual((await stack(page,'p3')).slice(0,2),['Configured in Sanoid','External: not tracked by Director']);
   assert.deepEqual(await page.locator('tr[data-definition-id=p1] .zfsm-protection-when span').allTextContents(),['Monday, 09-11-2026','22:17:05'],'date and time on separate lines');
   assert.equal(await page.locator('.zfsm-protection-table td:has-text("Enabled")').count(),0,'the unexplained bare "Enabled" is gone');
   await page.locator('tr[data-definition-id=p1]').click();
   const panel=await page.locator('body').innerText();
   assert.equal(panel.includes('[object'),false,'details panel must show real text, not an object');
   assert.equal(/EnabledUp/.test(panel),false,'status words must not run together');
   assert.match(panel,/Last run\s+Monday, 09-11-2026, 22:17:05/);
   assert.deepEqual(await overlaps(page),[],'snapshot policies: no cell overlaps');
   await page.screenshot({path:out+'/'+width+'-policies.png'});await page.close();
   page=await open(width,'replication');
   assert.deepEqual(await stack(page,'r1'),['Completed','Schedule: on','Managed by ZFS Director']);
   assert.deepEqual(await stack(page,'r2'),['Not run yet','Schedule: paused','Managed by ZFS Director']);
   assert.deepEqual(await page.locator('tr[data-definition-id=r1] .zfsm-protection-when span').allTextContents(),['Monday, 09-11-2026','22:17:05']);
   assert.deepEqual(await overlaps(page),[],'replication: no cell overlaps');
   await page.screenshot({path:out+'/'+width+'-replication.png'});
   // Run inspection: one verdict, a table that fits, raw JSON folded away.
   await page.locator('tr[data-definition-id=r1]').click();await page.getByRole('button',{name:'Run now',exact:true}).first().click();
   const run=page.getByRole('dialog');await run.locator('.zfsm-run-verdict').waitFor();
   assert.match(await run.locator('.zfsm-run-verdict').innerText(),/Ready to run/);
   assert.equal(await run.locator('details pre').first().isVisible(),false,'raw JSON is folded');
   assert.deepEqual(await run.evaluate(d=>({wide:d.scrollWidth>d.clientWidth+1})),{wide:false},'run window must not scroll sideways');
   assert.equal(await run.locator('.zfsm-run-table-wrap').evaluate(w=>w.scrollWidth<=w.clientWidth+1),true,'table fits its box');
   await page.screenshot({path:out+'/'+width+'-run-inspection.png'});
   results.push({width,status:'PASS'});
  }catch(e){results.push({width,status:'FAIL',error:e.stack});if(page&&!page.isClosed())await page.screenshot({path:out+'/FAIL-'+width+'.png'});throw e;}finally{if(page&&!page.isClosed())await page.close();}
 }
}finally{await browser.close();await writeFile(out+'/results.json',JSON.stringify({results,errors,scope:'Actual offline Chromium Workspace; synthetic definitions. No test-host.'},null,2)+'\n');console.log(JSON.stringify({results,errors}));if(results.some(r=>r.status!=='PASS')||errors.length)process.exitCode=1;}
