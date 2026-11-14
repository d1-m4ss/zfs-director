import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {startMock,lab} from './mock-server.mjs';

// Real frontend. The workspace fills the viewport; each screen scrolls in one place; no scroll inside scroll.
const require=createRequire(import.meta.url),{chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const out=process.env.ZFSM_OUTPUT||'backups/2026-11-10/fixed-frame';await mkdir(out,{recursive:true});
const mock=await startMock(),browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true});
const results=[],errors=[],project=lab+'/project';
const holder=mock.model.data.datasets.cache.child[lab].child[project];
for(let n=0;n<300;n++)holder.snapshots.push({name:project+'@autosnap_2026-11-'+String(1+n%28).padStart(2,'0')+'_20:17:05_daily_'+n,guid:String(900000+n),used:4096,referenced:10485760,written:1024,defer_destroy:'off',userrefs:0,creation:1790000000+n*60});
// Scrollable elements that actually scroll (content taller than the box), and whether one sits inside another.
const scrollers=page=>page.evaluate(()=>{
 const list=[...document.querySelectorAll('#zfsm-workspace *')].filter(el=>{const s=getComputedStyle(el);return ['auto','scroll'].includes(s.overflowY)&&el.scrollHeight>el.clientHeight+2&&el.clientHeight>0&&!el.closest('dialog:not([open])');});
 const name=el=>el.tagName.toLowerCase()+'.'+[...el.classList].join('.');
 const nested=list.filter(el=>list.some(other=>other!==el&&other.contains(el))).map(name);
 return {names:list.map(name),nested,page:document.documentElement.scrollHeight-innerHeight};
});
async function fresh(width,height,layout='tree'){
 const context=await browser.newContext({viewport:{width,height}});const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/*',route=>route.request().url().startsWith(mock.url)?route.continue():route.abort());
 await page.goto(mock.url);return {context,page};
}
try{
 for(const [width,height] of [[390,800],[768,900],[1280,720],[1920,1000]]){
  const {context,page}=await fresh(width,height);
  try{
   await page.locator('[data-node="'+project+'"]').click();
   const frame=await page.evaluate(()=>{const r=document.querySelector('#zfsm-workspace').getBoundingClientRect();return {mode:document.querySelector('#zfsm-workspace').dataset.frame,bottom:Math.round(r.bottom),vh:innerHeight,page:document.documentElement.scrollHeight-innerHeight};});
   assert.equal(frame.mode,'fixed');assert.ok(frame.bottom<=frame.vh,'the frame must end inside the viewport @'+width+' '+JSON.stringify(frame));assert.ok(frame.page<=1,'the page itself must not scroll @'+width+' '+JSON.stringify(frame));
   if(width>=1280){const room=await page.evaluate(()=>{const area=document.querySelector('.zfsm-workarea').getBoundingClientRect();return {area:Math.round(area.height),vh:innerHeight};});assert.ok(room.area>=room.vh*0.6,'the work panes use most of the window height @'+width+' '+JSON.stringify(room));}
   // Jobs toolbar: the Clear button shares the baseline of the selects.
   if(width>=1280){await page.locator('[data-section=jobs]').click();await page.waitForTimeout(200);const row=await page.evaluate(()=>{const bar=document.querySelector('.zfsm-jobs-toolbar');const select=bar.querySelector('select').getBoundingClientRect(),clear=[...bar.querySelectorAll('button')].find(b=>/Clear finished/.test(b.textContent)).getBoundingClientRect();return {selectBottom:Math.round(select.bottom),clearBottom:Math.round(clear.bottom)};});assert.ok(Math.abs(row.selectBottom-row.clearBottom)<=3,'Clear button is level with the selects @'+width+' '+JSON.stringify(row));await page.locator('[data-section=datasets]').click();await page.locator('[data-node="'+project+'"]').click();}
   for(const tab of ['overview','details','properties','snapshots','actions']){
    // UX-001: Dataset information is the All properties block on Overview.
    await page.locator('[data-tab='+(tab==='details'?'overview':tab)+']').click();await page.waitForTimeout(120);
    if(tab==='details'){await page.locator('.zfsm-all-properties > summary').click();await page.waitForTimeout(120);}
    const found=await scrollers(page);
    assert.deepEqual(found.nested,[],tab+' @'+width+': scroll inside scroll '+JSON.stringify(found));assert.ok(found.page<=1,tab+' @'+width+': the page must not scroll '+JSON.stringify(found));
    if(width>=1280)assert.ok(found.names.length<=2,tab+' @'+width+': at most the tree and the detail pane scroll '+JSON.stringify(found));
    if(tab==='snapshots'&&width>=1280){assert.equal(await page.locator('.zfsm-snapshot-table tbody tr').count(),50,'the first page of 50 snapshots is listed');assert.match(await page.locator('.zfsm-snapshot-count').first().textContent(),/302|1[-–]50/,'the list knows it has 302 snapshots');}
    if(tab==='details'){
     const groups=await page.locator('.zfsm-all-properties .zfsm-subtabs button').allTextContents();assert.ok(groups.length>=2,'dataset information is split into groups @'+width+' '+groups.join('|'));
     const first=await page.locator('.zfsm-all-properties .zfsm-properties dt').allTextContents();await page.locator('.zfsm-all-properties .zfsm-subtabs button').nth(1).click();const second=await page.locator('.zfsm-all-properties .zfsm-properties dt').allTextContents();
     assert.notDeepEqual(first,second,'another group shows other properties');assert.ok(second.length>0);
     assert.ok(first.length<18,'one group is a short list ('+first.length+')');
    }
    await page.screenshot({path:out+'/'+width+'-'+tab+'.png'});
   }
   // The tab bar and the pane heading stay on screen while the long list scrolls.
   if(width>=1280){await page.locator('[data-tab=snapshots]').click();await page.waitForTimeout(100);const pane=page.locator('.zfsm-detail>:last-child');await pane.evaluate(el=>{el.scrollTop=el.scrollHeight;});
    const stay=await page.evaluate(()=>{const tabs=document.querySelector('.zfsm-tabs').getBoundingClientRect(),head=document.querySelector('.zfsm-detail-heading').getBoundingClientRect();return {tabsTop:Math.round(tabs.top),headTop:Math.round(head.top),vh:innerHeight};});
    assert.ok(stay.tabsTop>=0&&stay.tabsTop<stay.vh&&stay.headTop>=0&&stay.headTop<stay.vh,'tabs and heading stay visible '+JSON.stringify(stay));}
   results.push({width,height,status:'PASS'});
  }catch(e){results.push({width,height,status:'FAIL',error:e.stack});await page.screenshot({path:out+'/FAIL-'+width+'.png'}).catch(()=>{});throw e;}finally{await context.close();}
 }
 // A live resize re-fits the frame and flips the layout, without a reload.
 {const {context,page}=await fresh(1280,720);try{
  const state=()=>page.evaluate(()=>{const root=document.querySelector('#zfsm-workspace');return {wide:root.dataset.wide,bottom:Math.round(root.getBoundingClientRect().bottom),vh:innerHeight,page:document.documentElement.scrollHeight-innerHeight};});
  assert.equal((await state()).wide,'true');
  await page.setViewportSize({width:1280,height:900});await page.waitForTimeout(150);let now=await state();assert.ok(now.bottom<=now.vh&&now.bottom>=now.vh-80,'the frame grows with the window '+JSON.stringify(now));assert.ok(now.page<=1);
  await page.setViewportSize({width:700,height:600});await page.waitForTimeout(150);now=await state();assert.equal(now.wide,'false','narrow window switches to the stacked layout');assert.ok(now.bottom<=now.vh&&now.page<=1,'the narrow frame fits too '+JSON.stringify(now));
  await page.setViewportSize({width:1280,height:720});await page.waitForTimeout(150);now=await state();assert.equal(now.wide,'true');
  results.push({resize:true,status:'PASS'});
 }finally{await context.close();}}
 // Pool & Scrub view: same single scroll area.
 {const {context,page}=await fresh(1280,720);try{await page.getByRole('button',{name:'Pool & Scrub',exact:true}).click();await page.waitForTimeout(200);const found=await scrollers(page);assert.deepEqual(found.nested,[],'pool view: scroll inside scroll '+JSON.stringify(found));assert.ok(found.page<=1,'pool view: the page must not scroll '+JSON.stringify(found));assert.ok(found.names.length<=2,'pool view: at most two scroll areas '+JSON.stringify(found));await page.screenshot({path:out+'/pool-1280.png'});results.push({view:'pool',status:'PASS'});}finally{await context.close();}}
 // Table layout: one scroll area, no nested scroll.
 {const {context,page}=await fresh(1280,720,'table');try{await page.locator('[data-node="'+project+'"]').click();const found=await scrollers(page);assert.deepEqual(found.nested,[],'table layout: scroll inside scroll '+JSON.stringify(found));assert.ok(found.page<=1,'table layout: the page must not scroll');await page.screenshot({path:out+'/table-1280.png'});results.push({layout:'table',status:'PASS'});}finally{await context.close();}}
}finally{await browser.close();await mock.close();await writeFile(out+'/results.json',JSON.stringify({results,errors,scope:'Actual Chromium on the mock stand; synthetic data. No test-host.'},null,2)+'\n');console.log(JSON.stringify({results,errors}));if(results.some(r=>r.status!=='PASS')||errors.length)process.exitCode=1;}
