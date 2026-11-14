import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {startMock,lab} from './mock-server.mjs';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url),{chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const out=process.env.ZFSM_OUTPUT||'backups/2026-11-09/dialogs-layout';await mkdir(out,{recursive:true});
const scripts=await Promise.all(['ZFSMDateTime','ZFSMInventory','ZFSMForms','ZFSMSnapshots','ZFSMExplorer','ZFSMPoolView','ZFSMOverview','ZFSMProtection','ZFSMWorkspace'].map(name=>readFile('src/frontend/'+name+'.js','utf8'))),css=await readFile('src/frontend/ZFSMWorkspace.css','utf8'),protectionCSS=await readFile('src/frontend/ZFSMProtection.css','utf8');

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

const H=700;
// One rule set for every modal dialog: inside the viewport, centred, own scroll, fixed header, page behind locked.
async function checkDialog(page,name,{scroll=true}={}){
 const dialog=page.locator('dialog[open]').last();await dialog.waitFor();
 const info=await dialog.evaluate(d=>{const r=d.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,sw:d.scrollWidth,cw:d.clientWidth,sh:d.scrollHeight,ch:d.clientHeight,vw:innerWidth,vh:innerHeight,overflow:getComputedStyle(document.documentElement).overflow};});
 const label=name+' @'+info.vw;
 assert.ok(info.left>=-1&&info.right<=info.vw+1&&info.top>=-1&&info.bottom<=info.vh+1,label+': dialog must fit the viewport '+JSON.stringify(info));
 assert.ok(Math.abs((info.left+info.right)/2-info.vw/2)<=2,label+': dialog must be centred horizontally');
 assert.ok(Math.abs((info.top+info.bottom)/2-info.vh/2)<=2||info.bottom>=info.vh-14,label+': dialog must be centred vertically or fill the height');
 assert.ok(info.sw<=info.cw+1,label+': no horizontal scroll inside the dialog ('+info.sw+'>'+info.cw+')');
 assert.equal(info.overflow,'hidden',label+': the page behind must not scroll');
 // The wheel over the dim backdrop must not move the page.
 await page.evaluate(()=>window.scrollTo(0,0));const before=await page.evaluate(()=>window.scrollY);
 await page.mouse.move(2,2);await page.mouse.wheel(0,400);await page.waitForTimeout(60);
 assert.equal(await page.evaluate(()=>window.scrollY),before,label+': wheel on the backdrop moved the page');
 if(scroll&&info.sh>info.ch+4){
  await page.mouse.move((info.left+info.right)/2,(info.top+info.bottom)/2);await page.mouse.wheel(0,3000);await page.waitForTimeout(80);
  const after=await dialog.evaluate(d=>({top:d.scrollTop,max:d.scrollHeight-d.clientHeight}));
  assert.ok(after.top>0,label+': the long dialog must scroll by itself');
  assert.equal(await page.evaluate(()=>window.scrollY),before,label+': scrolling the dialog moved the page');
  const heading=await dialog.evaluate(d=>{const h=d.querySelector('header');return h?Math.round(h.getBoundingClientRect().top-d.getBoundingClientRect().top):null;});
  assert.ok(heading===null||heading<=4,label+': the header must stay at the top while the dialog scrolls (offset '+heading+')');
 }
 return info;
}
try{
 for(const width of [390,768,1280]){
  let page;
  try{
   // Protection dialogs on the standalone workspace.
   page=await open(width,'replication');await page.setViewportSize({width,height:H});await page.evaluate(()=>{const spacer=document.createElement('div');spacer.style.height='3000px';document.body.append(spacer);});
   await page.locator('tr[data-definition-id=r1]').click();await page.getByRole('button',{name:'Run now',exact:true}).first().click();
   await page.locator('.zfsm-run-verdict').waitFor();await checkDialog(page,'run inspection');
   assert.equal(await page.getByRole('button',{name:'Run reviewed job',exact:true}).evaluate(b=>{const r=b.getBoundingClientRect();return r.bottom<=innerHeight&&r.top>=0;}),true,'Run button must be visible without scrolling @'+width);
   await page.screenshot({path:out+'/'+width+'-run.png'});await page.keyboard.press('Escape');
   await page.getByRole('button',{name:'New replication',exact:true}).click();await checkDialog(page,'replication wizard');await page.screenshot({path:out+'/'+width+'-wizard.png'});await page.keyboard.press('Escape');
   await page.close();
   page=await open(width,'protection');await page.setViewportSize({width,height:H});await page.evaluate(()=>{const spacer=document.createElement('div');spacer.style.height='3000px';document.body.append(spacer);});
   await page.getByRole('button',{name:'New policy',exact:true}).click();await checkDialog(page,'policy editor');await page.screenshot({path:out+'/'+width+'-policy.png'});await page.close();
   // Action dialog and snapshot list on the mock stand.
   const mock=await startMock();const context=await browser.newContext({viewport:{width,height:H}});page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
   await context.route('**/*',route=>route.request().url().startsWith(mock.url)?route.continue():route.abort());
   try{
    await page.goto(mock.url);await page.evaluate(()=>{const spacer=document.createElement('div');spacer.style.height='3000px';document.body.append(spacer);});
    const project=lab+'/project';await page.locator('[data-node="'+project+'"]').click();
    await page.locator('[data-tab=snapshots]').click();await page.locator('.zfsm-snapshot-table').first().waitFor();
    const snap=await page.evaluate(()=>{const table=document.querySelector('.zfsm-snapshot-table');let el=table,worst=0;while(el&&el!==document.body){worst=Math.max(worst,el.scrollWidth-el.clientWidth);el=el.parentElement;}return {worst,page:document.documentElement.scrollWidth-innerWidth};});
    assert.ok(snap.worst<=1&&snap.page<=1,'snapshot list must not scroll horizontally @'+width+' '+JSON.stringify(snap));await page.screenshot({path:out+'/'+width+'-snapshots.png'});
    await page.locator('[data-tab=actions]').click();await page.getByRole('button',{name:'Destroy dataset',exact:true}).click();await checkDialog(page,'action dialog',{scroll:false});await page.screenshot({path:out+'/'+width+'-action.png'});
   }finally{await context.close();await mock.close?.();}
   results.push({width,status:'PASS'});
  }catch(e){results.push({width,status:'FAIL',error:e.stack});if(page&&!page.isClosed())await page.screenshot({path:out+'/FAIL-'+width+'.png'}).catch(()=>{});throw e;}finally{if(page&&!page.isClosed())await page.close().catch(()=>{});}
 }
}finally{await browser.close();await writeFile(out+'/results.json',JSON.stringify({results,errors,scope:'Actual offline Chromium; synthetic data. No test-host.'},null,2)+'\n');console.log(JSON.stringify({results,errors}));if(results.some(r=>r.status!=='PASS')||errors.length)process.exitCode=1;process.exit(process.exitCode||0);}
