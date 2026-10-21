import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {startMock} from './mock-server.mjs';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const out=process.env.ZFSM_OUTPUT||'evidence/jobs-history-2026-10-20/pagination';await mkdir(out,{recursive:true});
const mock=await startMock(),browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true}),results=[],errors=[];
try{
 for(const width of [390,1280])for(const theme of ['dark','gray','light','azure'])for(const layout of ['tree','table']){
  mock.reset();const seed=structuredClone(mock.model.jobs.find(j=>j.state==='completed'));mock.model.jobs.splice(0,mock.model.jobs.length,...Array.from({length:37},(_,i)=>({...seed,id:'20261020-120000-'+i.toString(16).padStart(12,'0'),source:'Synthetic log '+i,created:1792497600+i})));
  const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await context.route('**/*',r=>r.request().url().startsWith(mock.url)?r.continue():r.abort());
  await page.goto(mock.url+'/?section=jobs');await page.locator('[data-job-id]').first().waitFor();await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(theme);await page.locator('[data-layout-choice='+layout+']').click();
  assert.equal(await page.locator('[data-job-id]').count(),10);const first=await page.locator('[data-job-id]').evaluateAll(es=>es.map(e=>e.dataset.jobId));
  await page.getByRole('button',{name:'Next jobs',exact:true}).click();await page.getByText('Page 2 / 4 · 37 total',{exact:true}).waitFor();assert.equal(await page.locator('[data-job-id]').count(),10);const second=await page.locator('[data-job-id]').evaluateAll(es=>es.map(e=>e.dataset.jobId));assert.ok(second.every(id=>!first.includes(id)));
  for(const pageNo of [3,4]){await page.getByRole('button',{name:'Next jobs',exact:true}).click();await page.getByText('Page '+pageNo+' / 4 · 37 total',{exact:true}).waitFor();}assert.equal(await page.locator('[data-job-id]').count(),7);assert.equal(await page.getByRole('button',{name:'Next jobs',exact:true}).isDisabled(),true);
  for(const [size,count,pages]of [['25',25,2],['50',37,1],['100',37,1],['10',10,4]]){await page.getByRole('combobox',{name:'Jobs per page',exact:true}).selectOption(size);await page.getByText('Page 1 / '+pages+' · 37 total',{exact:true}).waitFor();assert.equal(await page.locator('[data-job-id]').count(),count);}
  await page.reload();await page.locator('[data-job-id]').first().waitFor();assert.equal(await page.getByRole('combobox',{name:'Jobs per page',exact:true}).inputValue(),'10');assert.equal(await page.locator('[data-job-id]').count(),10);
  await page.locator('.zfsm-history-storage > summary').click();assert.equal(await page.locator('.zfsm-history-storage').evaluate(e=>e.open),true);
  if(width===390&&theme==='dark'&&layout==='tree'){await page.waitForResponse(r=>r.url()===mock.url+'/mock/admin'&&new URLSearchParams(r.request().postData()).get('cmd')==='conversionjobs');assert.equal(await page.locator('.zfsm-history-storage').evaluate(e=>e.open),true);}
  assert.equal(await page.locator('#zfsm-workspace').evaluate(e=>e.scrollWidth>e.clientWidth+1),false);
  const key=theme+'-'+layout+'-'+width;await page.screenshot({path:out+'/'+key+'.png',fullPage:true});results.push({key,status:'PASS',default_size:10,selected_sizes:[10,25,50,100],last_page_count:7,storage_explanation_open:true});console.log('PASS '+key);await context.close();
 }
 assert.deepEqual(errors,[]);
}finally{await browser.close();await mock.close();await writeFile(out+'/results.json',JSON.stringify({results,errors,boundary:'Actual Chromium frontend against local mock. No test-host or native storage operations.'},null,2)+'\n');}
