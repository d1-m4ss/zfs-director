import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {startIntegration} from './server.mjs';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const output=process.env.ZFSM_OUTPUT||'evidence/destroy-2026-10-17/integration-destroy';await mkdir(output,{recursive:true});
const stand=await startIntegration(),results=[],errors=[];
const browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true});
const page=await browser.newPage({viewport:{width:1280,height:1000}});page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(7000);
const target='cache/__mock__/destroy-case',snapshot=target+'@base';
const endpoint=stand.url+'/plugins/zfs.master.ui/backend/ZFSMAdmin.php';
async function post(fields){const r=await fetch(endpoint,{method:'POST',body:new URLSearchParams({csrf_token:'integration-token',...fields})});return r.json();}
async function pass(name,fn){await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}
async function preview(){await page.locator('[data-preview]').click();await page.locator('.zfsm-preview pre').waitFor();}
async function confirm(){await page.locator('[name=acknowledge]').check();await page.locator('.zfsm-form button[type=submit]').click();const response=page.waitForResponse(r=>r.url()===endpoint&&new URLSearchParams(r.request().postData()).get('cmd')==='destroydataset');await page.locator('[data-confirm-operation]').click();return (await response).json();}
try{
 const model=stand.readModel();model.datasets[target]={...model.datasets['cache/__mock__/project'],name:target,guid:'999001',mountpoint:'/mnt/'+target};model.snapshots[snapshot]={...model.snapshots['cache/__mock__/project@base'],name:snapshot,guid:'999002'};stand.writeModel(model);
 await stand.run({code:`<?php mkdir('/proc/self/ns',0755,true);symlink('mnt:[1]','/proc/self/ns/mnt');mkdir('/proc/42/ns',0755,true);symlink('mnt:[2]','/proc/42/ns/mnt');file_put_contents('/proc/42/comm','fixture-service');file_put_contents('/proc/42/mountinfo',${JSON.stringify('9 1 0:2 / /export/copy ro - zfs '+target+' rw\n')});`});
 await page.goto(stand.url);await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.locator('[data-node="'+target+'"]').click();await page.getByRole('button',{name:'Actions',exact:true}).click();await page.getByRole('button',{name:'Destroy dataset',exact:true}).click();await page.locator('[name=force]').check();await preview();
 await pass('actual PHP preview blocks a foreign mount despite successful ZFS dry-run',async()=>{assert.equal(await page.locator('.zfsm-form button[type=submit]').isDisabled(),true);assert.match(await page.locator('.zfsm-preview').textContent(),/fixture-service/);await page.screenshot({path:output+'/blocked-1280.png',fullPage:true});await page.setViewportSize({width:390,height:900});await page.screenshot({path:output+'/blocked-390.png',fullPage:true});await page.setViewportSize({width:1280,height:1000});});
 await pass('backend rechecks references appearing after a valid signed preview',async()=>{
  await stand.run({code:"<?php unlink('/proc/42/ns/mnt');symlink('mnt:[1]','/proc/42/ns/mnt');file_put_contents('/proc/42/mountinfo','');"});
  const p=await post({cmd:'previewdestroy',zdataset:target,force:'1'});assert.equal(p.can_destroy,true);
  await stand.run({code:`<?php unlink('/proc/42/ns/mnt');symlink('mnt:[2]','/proc/42/ns/mnt');file_put_contents('/proc/42/mountinfo',${JSON.stringify('9 1 0:2 / /copy ro - zfs '+target+' rw\n')});`});
  const before=stand.readModel().calls.filter(c=>c.command==='zfs'&&c.args[0]==='destroy'&&!c.args.includes('-nvp')).length;
  const r=await post({cmd:'destroydataset',zdataset:target,expected_guid:'999001',force:'1',preview_id:p.preview_id,preview_token:p.token});assert.equal(r.destruction.attempted,false);assert.equal(stand.readModel().calls.filter(c=>c.command==='zfs'&&c.args[0]==='destroy'&&!c.args.includes('-nvp')).length,before);
 });
 await pass('partial failure separates errors from the plan and verifies surviving GUIDs',async()=>{
  await stand.run({code:"<?php unlink('/proc/42/ns/mnt');symlink('mnt:[1]','/proc/42/ns/mnt');file_put_contents('/proc/42/mountinfo','');"});
  const m=stand.readModel();m.destroy_fault=target;stand.writeModel(m);await preview();const r=await confirm();assert.equal(r.destruction.exit_code,1);assert.deepEqual(r.destruction.removed,[snapshot]);assert.deepEqual(r.destruction.remaining,[target]);assert.doesNotMatch(r.failed[target],/will destroy/);await page.locator('[data-destroy-outcome]').waitFor();await page.screenshot({path:output+'/partial-1280.png',fullPage:true});assert.equal(await page.locator('.zfsm-form button[type=submit]').isDisabled(),true);
 });
 await pass('fresh preview after failure reflects the reduced scope and safely completes once',async()=>{
  const m=stand.readModel();delete m.destroy_fault;stand.writeModel(m);await preview();const r=await confirm();assert.equal(Object.keys(r.failed).length,0,JSON.stringify(r));assert.deepEqual(r.destruction.removed,[target]);assert.equal(stand.readModel().datasets[target],undefined);
  const calls=stand.calls.map(c=>Object.fromEntries(new URLSearchParams(c.body))).filter(c=>c.cmd==='destroydataset');const replay=await post(calls.at(-1));assert.ok(Object.keys(replay.failed).length);assert.ok(stand.readModel().calls.some(c=>c.command==='zfs'&&JSON.stringify(c.args)===JSON.stringify(['destroy','-v','-r','-f',target])));
 });
 assert.deepEqual(errors,[]);
}finally{await writeFile(output+'/results.json',JSON.stringify({head:(process.env.ZFSM_SOURCE_REVISION||'working-tree'),results,errors,phpErrors:stand.errors},null,2)+'\n');await browser.close();await stand.close();}
