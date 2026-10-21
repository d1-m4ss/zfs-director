import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {startMock} from './mock-server.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const mock=await startMock(),browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true});
try{
 for(const width of [390,768,1280,1920]){
  mock.reset();const job=mock.model.jobs[0];job.stage_history_complete=true;job.stage_history_dropped=3;job.stage_history=[{at:'2026-10-18T10:00:00+00:00',state:'queued',stage:'planned',attempt:0},{at:'2026-10-18T10:01:00+00:00',state:'running',stage:'copying',attempt:1}];
  const context=await browser.newContext({viewport:{width,height:960}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',route=>route.request().url().startsWith(mock.url)?route.continue():route.abort());
  try{
   await page.goto(mock.url+'/?section=jobs');const row=page.locator('[data-job-id="'+job.id+'"]'),summary=row.locator(':scope > details > summary');await summary.waitFor();
   await summary.focus();await page.keyboard.press('Enter');assert.equal(await row.locator(':scope > details').evaluate(el=>el.open),true);
   await row.getByRole('list',{name:'Recorded job stages'}).waitFor();assert.equal(await row.locator('[data-stage-history] li').count(),2);await row.getByText(/3 earlier stage events omitted/).waitFor();
   const focused=await summary.evaluate(el=>({active:document.activeElement===el,outline:getComputedStyle(el).outlineStyle,width:getComputedStyle(el).outlineWidth}));assert.equal(focused.active,true);assert.equal(focused.outline,'solid');assert.equal(focused.width,'2px');
   job.stage_history.push({at:'2026-10-18T10:02:00+00:00',state:'running',stage:'verifying',attempt:1});job.stage='verifying';
   await page.waitForFunction(id=>document.querySelector('[data-job-id="'+id+'"] [data-stage-history]')?.children.length===3,job.id);
   assert.equal(await row.locator(':scope > details').evaluate(el=>el.open),true);assert.equal(await summary.evaluate(el=>document.activeElement===el),true);
   for(let step=0;step<3&&await page.evaluate(()=>document.activeElement.getAttribute('aria-label'))!=='Copy job '+job.id;step++)await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Copy job '+job.id);
   const requests=mock.model.calls.filter(c=>c.cmd==='conversionjobs').length;await page.waitForResponse(response=>response.url()===mock.url+'/mock/admin'&&new URLSearchParams(response.request().postData()).get('cmd')==='conversionjobs',{timeout:15000});assert.ok(mock.model.calls.filter(c=>c.cmd==='conversionjobs').length>requests);assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Copy job '+job.id);
   if(process.env.ZFSM_REFRESH_INTERVAL==='0'){assert.equal(mock.model.config.refresh_interval,0);assert.equal(mock.model.calls.filter(c=>c.cmd==='inventory').length,1,'Jobs polling must not start periodic inventory refresh');}
   assert.equal(await row.locator('[role=status]').getAttribute('aria-label'),'Job '+job.id+' status');
   const legacy=page.locator('[data-job-id]').filter({hasText:'Stage history: Unknown'});assert.ok(await legacy.count()>0);
   const dimensions=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));assert.ok(dimensions.scroll<=dimensions.width+1,JSON.stringify({width,...dimensions}));assert.deepEqual(errors,[]);
   console.log('PASS Jobs recorded timeline, keyboard inspect/Copy and polling focus at '+width+'px');
  }finally{await context.close();}
 }
 const context=await browser.newContext(),page=await context.newPage();
 try{
  await page.goto(mock.url+'/?section=jobs');await page.locator('[data-job-id]').first().waitFor();mock.model.failedCommand='conversionjobs';await page.getByRole('alert').filter({hasText:'Job status unavailable'}).waitFor();console.log('PASS Jobs fetch failure exposes alert');
 }finally{await context.close();}
}finally{await browser.close();await mock.close();}
