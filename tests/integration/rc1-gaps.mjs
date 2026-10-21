import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {startIntegration} from './server.mjs';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const output=process.env.ZFSM_OUTPUT||'evidence/rc1-gap-2026-10-18/recursive-gui';await mkdir(output,{recursive:true});
const stand=await startIntegration(),results=[],errors=[];let browser;
async function check(name,fn){await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}
async function post(f){const r=await fetch(stand.url+'/plugins/zfs.master.ui/backend/ZFSMAdmin.php',{method:'POST',body:new URLSearchParams({csrf_token:'integration-token',...f})});return r.json();}
try{
 const source='cache/__mock__/project',child=source+'/recursive-child',m=stand.readModel();m.datasets[child]={...m.datasets[source],name:child,guid:'8100',mountpoint:'/mnt/'+child};for(const [owner,short,guid]of[[source,'mixed-root','8101'],[child,'mixed-child','8102']])m.snapshots[owner+'@'+short]={name:owner+'@'+short,type:'snapshot',guid,creation:1792320000,userrefs:0,origin:'-',mountpoint:'-',encryptionroot:'-'};stand.writeModel(m);
 await check('child snapshot fresh destroy preview retains its own GUID',async()=>{const p=await post({cmd:'previewdestroy',zdataset:child+'@mixed-child',recursive:'0'});assert.equal(Object.keys(p.failed||{}).length,0,JSON.stringify(p));assert.match(JSON.stringify(p),/8102/);});
 browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 await check('Chromium recursive scope shows mixed owners in both views and stays responsive',async()=>{
  for(const mode of['Workspace','Compact table'])for(const width of[390,1280]){
   await page.setViewportSize({width,height:1000});await page.goto(stand.url);await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:mode,exact:true}).click();await page.locator('[data-node="'+source+'"]').click();await page.getByRole('button',{name:'Snapshots',exact:true}).first().click();await page.getByRole('combobox',{name:'Snapshot scope',exact:true}).selectOption('recursive');await page.getByRole('row').filter({hasText:child+'@mixed-child'}).waitFor();assert.ok(await page.getByRole('row').filter({hasText:source+'@mixed-root'}).count());assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:output+'/'+mode.replaceAll(' ','-')+'-'+width+'.png',fullPage:true});
  }
 });
 assert.deepEqual(errors,[]);assert.ok(stand.readModel().calls.every(c=>!['mount','unmount','load-key','unload-key'].includes(c.args?.[0])&&(c.args?.[0]!=='destroy'||c.args.includes('-nvp'))));
}finally{if(browser)await browser.close();await stand.close();await writeFile(output+'/results.json',JSON.stringify({provenance:'Actual frontend/PHP endpoint; only CLI effects simulated. Preview only, no ZFS or test-host operations.',results,pageErrors:errors,phpErrors:stand.errors},null,2)+'\n');}
