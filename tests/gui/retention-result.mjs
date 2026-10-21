import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {retentionResult} from '../fixtures/retention-result.mjs';

const require=createRequire(import.meta.url),{chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const output=process.env.ZFSM_OUTPUT||'evidence/retention-warning-2026-10-20/gui';await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true});
const results=[],errors=[];let stand,context;
try{
 const fixture=await retentionResult();stand=fixture.stand;assert.equal(fixture.job.verified_outcome,'completed_with_warnings');
 context=await browser.newContext();await context.route('**/*',route=>route.request().url().startsWith(stand.url)?route.continue():route.abort());
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(stand.url);
 await page.locator('[data-section=jobs]').click();const row=page.locator('[data-job-id="'+fixture.job.id+'"]');await row.waitFor();await row.locator(':scope > details > summary').click();
 for(const theme of ['auto','dark','gray','light','azure'])for(const layout of ['Workspace','Compact'])for(const width of [1185,390]){
  await page.setViewportSize({width,height:1000});await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(theme);await page.getByRole('button',{name:layout,exact:true}).click();
  await row.getByRole('status',{name:'Job '+fixture.job.id+' status',exact:true}).filter({hasText:'Completed with warnings'}).waitFor();
  assert.match(await row.textContent(),/Snapshots deleted: 1\. Protected snapshots kept: 2/);assert.equal(await row.locator('[role=alert]').count(),0);assert.equal(await row.locator('.zfsm-success').count(),0);
  assert.ok(await row.locator('[data-severity=warning]').count());assert.equal(await row.locator(':scope > details > summary').evaluate(el=>el.nextElementSibling.matches('.zfsm-notice[data-severity=warning]')),true,'Human result must precede technical details');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Warning must fit mobile viewport');
  if((width===1185&&layout==='Workspace')||(theme==='dark'&&width===390))await page.screenshot({path:output+'/jobs-'+theme+'-'+layout.toLowerCase()+'-'+width+'.png',fullPage:false});
  results.push({theme,layout,width,status:'PASS'});
 }
 await page.setViewportSize({width:1185,height:1000});await page.getByRole('button',{name:'Workspace',exact:true}).click();await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption('dark');
 await page.locator('[data-section=protection]').click();const policy=page.locator('[data-policy-id=ace]');await policy.waitFor();assert.match(await policy.textContent(),/Completed with warnings/);await page.screenshot({path:output+'/policy-warning.png',fullPage:false});
 results.push({screen:'Data Protection',status:'PASS'});
 assert.equal(stand.errors.length,0,stand.errors.join('\n'));await context.close();await stand.close();context=null;stand=null;
 const blocked=await retentionResult({invalidPlan:true});stand=blocked.stand;
 context=await browser.newContext();await context.route('**/*',route=>route.request().url().startsWith(stand.url)?route.continue():route.abort());
 const negative=await context.newPage();negative.on('pageerror',error=>errors.push(error.message));await negative.goto(stand.url);await negative.locator('[data-section=jobs]').click();const failed=negative.locator('[data-job-id="'+blocked.job.id+'"]');await failed.waitFor();await failed.locator(':scope > details > summary').click();assert.match(await failed.getByRole('status',{name:'Job '+blocked.job.id+' status',exact:true}).textContent(),/failed/);assert.ok(await failed.locator('[role=alert]').count());assert.doesNotMatch(await failed.textContent(),/Completed with warnings/);
 results.push({screen:'Unverified plan remains an error',status:'PASS'});assert.equal(stand.errors.length,0,stand.errors.join('\n'));assert.deepEqual(errors,[]);
 const report={passed:results.length,failed:0,cases:results,page_errors:errors,backend:'Actual PHP worker and API in WASM; native Sanoid/ZFS process boundary simulated',testhost_accessed:false};
 await writeFile(output+'/results.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await context?.close();await stand?.close();await browser.close();}
