import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {startMock,lab} from './mock-server.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const out=process.env.ZFSM_OUTPUT||'evidence/ux-refinement-2026-10-20/alignment';await mkdir(out,{recursive:true});
const mock=await startMock(),browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true});
const measurements=[],issues=[];
try{
 for(const width of [1920,1280,390])for(const theme of ['dark','gray','light','azure'])for(const layout of ['Workspace','Compact']){
  mock.reset();const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();page.on('pageerror',e=>issues.push(e.message));await context.route('**/*',r=>r.request().url().startsWith(mock.url)?r.continue():r.abort());
  await page.goto(mock.url);await page.locator('[data-node="'+lab+'/project"]').click();await page.locator('[data-tab="overview"]').click();await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(theme);await page.getByRole('button',{name:layout,exact:true}).click();
  const key=theme+'-'+width+'-'+layout.toLowerCase();await page.screenshot({path:out+'/'+key+'.png',fullPage:true});
  const measured=await page.locator('.zfsm-overview-card>header').evaluateAll(els=>els.map(el=>{const heading=el.querySelector('h3'),detail=el.querySelector('small'),icon=heading?.querySelector('svg');const box=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,cy:r.y+r.height/2,height:r.height,width:r.width};};return {heading:box(heading),detail:detail?box(detail):null,icon:icon?box(icon):null,text:heading.textContent};}));
  measurements.push({key,headers:measured});
  for(const x of measured){if(x.detail)assert.ok(Math.abs(x.heading.cy-x.detail.cy)<=2,key+' header text misalignment '+JSON.stringify(x));if(x.icon)assert.ok(Math.abs(x.heading.cy-x.icon.cy)<=1,key+' heading icon misalignment '+JSON.stringify(x));}
  const nav=await page.locator('.zfsm-global-nav button:visible,.zfsm-tabs button:visible').evaluateAll(els=>els.map(e=>{const s=e.querySelector('svg');return {name:e.textContent,icon:s?{width:s.getBoundingClientRect().width,height:s.getBoundingClientRect().height,cy:s.getBoundingClientRect().y+s.getBoundingClientRect().height/2}:null,cy:e.getBoundingClientRect().y+e.getBoundingClientRect().height/2};}));
  for(const x of nav){assert.ok(x.icon,key+' missing navigation icon '+x.name);assert.ok(x.icon.width>=16&&x.icon.width<=20&&x.icon.height>=16&&x.icon.height<=20,key+' inconsistent navigation icon '+JSON.stringify(x));assert.ok(Math.abs(x.cy-x.icon.cy)<=1,key+' navigation icon offset '+JSON.stringify(x));}
  assert.equal(await page.locator('#zfsm-workspace').evaluate(e=>e.scrollWidth>e.clientWidth+1),false,key+' horizontal overflow');
  await context.close();console.log('PASS '+key);
 }
 assert.deepEqual(issues,[]);
}finally{await browser.close();await mock.close();await writeFile(out+'/measurements.json',JSON.stringify({measurements,issues},null,2)+'\n');}
