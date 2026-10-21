import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {startMock,lab} from './mock-server.mjs';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const output=process.env.ZFSM_OUTPUT||'evidence/rc-2026-10-16/performance';await mkdir(output,{recursive:true});
const mock=await startMock(),project=lab+'/project',prototype=structuredClone(mock.model.find(project)),parent=mock.model.find(lab);
for(let i=0;i<1000;i++){const name=lab+'/scale-'+i;parent.child[name]={...structuredClone(prototype),name,guid:String(5000+i),child:{},snapshots:[],directories:[]};}
let branch=parent,deep=lab;for(let i=0;i<64;i++){deep+='/deep-'+i;const node={...structuredClone(prototype),name:deep,guid:String(9000+i),child:{},snapshots:[],directories:[]};branch.child[deep]=node;branch=node;}
mock.model.find(project).snapshots=Array.from({length:2000},(_,i)=>({...structuredClone(prototype.snapshots[0]),name:project+'@scale-'+i,guid:String(12000+i),creation:1700000000+i}));
const browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true,args:['--enable-precise-memory-info']}),context=await browser.newContext({viewport:{width:1920,height:1100}}),page=await context.newPage(),errors=[],blocked=[],measurements=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));await context.route('**/*',r=>{if(r.request().url().startsWith(mock.url))r.continue();else{blocked.push(r.request().url());r.abort();}});
async function measure(name,fn){const start=performance.now();await fn();const ms=performance.now()-start;measurements.push({name,ms:Math.round(ms*100)/100});assert.ok(ms<8000,name+' exceeded local 8s watchdog');}
try{
 await measure('first render (navigation + inventory + Chromium layout)',async()=>{await page.goto(mock.url);await page.locator('[data-node="'+project+'"]').waitFor();});assert.ok(await page.locator('[data-node]').count()<=200);
 await measure('deep tree search (64 levels)',async()=>{await page.getByRole('searchbox',{name:'Search datasets',exact:true}).fill('deep-63');await page.locator('[data-node="'+deep+'"]').waitFor();});
 await measure('dataset filtering (1000 synthetic siblings)',async()=>{await page.getByRole('searchbox',{name:'Search datasets',exact:true}).fill('scale-999');await page.locator('[data-node="'+lab+'/scale-999"]').waitFor();});
 await page.getByRole('button',{name:'Clear search',exact:true}).click();
 for(let i=0;i<3;i++)await measure('switch dataset sample '+(i+1),async()=>{await page.locator('[data-node="'+(i%2?lab+'/clone':project)+'"]').click();await page.locator('.zfsm-detail-heading h2').filter({hasText:i%2?'clone':'project'}).waitFor();});
 await page.locator('[data-node="'+project+'"]').click();await measure('open 2000 snapshots bounded page',async()=>{await page.getByRole('button',{name:'Snapshots',exact:true}).click();await page.getByRole('checkbox',{name:'Select snapshot '+project+'@scale-0',exact:true}).waitFor();});assert.equal(await page.getByRole('checkbox',{name:/^Select snapshot /}).count(),50);
 await measure('sort 2000 snapshots',async()=>{await page.getByRole('combobox',{name:'Sort snapshots',exact:true}).selectOption('creation');await page.getByRole('checkbox',{name:/^Select snapshot /}).first().waitFor();});
 await measure('snapshot pagination',async()=>{await page.getByRole('button',{name:'Next snapshots page',exact:true}).click();await page.getByRole('checkbox',{name:/^Select snapshot /}).first().waitFor();});
 await measure('filter 2000 snapshots',async()=>{await page.getByRole('searchbox',{name:'Search snapshots',exact:true}).fill('scale-1999');await page.getByRole('checkbox',{name:'Select snapshot '+project+'@scale-1999',exact:true}).waitFor();});
 await measure('open snapshot File Manager',async()=>{await page.locator('[data-file-manager="'+project+'@scale-1999"]').click();await page.getByRole('dialog',{name:'Snapshot File Manager',exact:true}).waitFor();});
 const memory=await page.evaluate(()=>performance.memory?{usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize}:null);
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);await writeFile(output+'/results.json',JSON.stringify({head:(process.env.ZFSM_SOURCE_REVISION||'working-tree'),fixture:{siblings:1000,snapshots:2000,depth:64},scope:'Local Mac Chromium + fake HTTP. Times include automation/network/layout; 8s is a hang watchdog, not product SLA. No native Unraid performance claim or leak proof. Memory is one Chromium heap sample.',measurements,memory,errors,blocked},null,2)+'\n');console.log(JSON.stringify({pass:measurements.length,measurements,memory}));
}finally{await context.close();await browser.close();await mock.close();}
