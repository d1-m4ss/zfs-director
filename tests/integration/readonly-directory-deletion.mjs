import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {startIntegration} from './server.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const output=process.env.ZFSM_OUTPUT||'backups/2026-10-21/readonly-directory/gui';await mkdir(output,{recursive:true});
const stand=await startIntegration({dependencyUsage:true}),browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>route.request().url().startsWith(stand.url)?route.continue():route.abort());
const endpoint=stand.url+'/plugins/zfs.master.ui/backend/ZFSMAdmin.php',fixture=stand.readModel().directory_fixtures,target=fixture.paths.delete;
const helperCount=()=>stand.readModel().calls.filter(c=>c.stdin_json?.op==='delete').length;
function monitor(path,rw){const m=stand.readModel();m.docker={name:'/metrics-demo',state:'running',pid:123,mounts:[{source:path,destination:'/storage',type:'bind',...(rw===undefined?{}:{rw})}]};stand.writeModel(m);}
async function submit(){
 if(await page.locator('.zfsm-action-dialog[open]').count())await page.getByRole('button',{name:'Close action',exact:true}).click();
 await page.locator('[data-section=datasets]').click();await page.locator('[data-node="'+target+'"]').click();await page.locator('[data-tab=actions]').click();await page.getByRole('button',{name:'Delete directory',exact:true}).click();
 await page.locator('[name=force]').check();await page.locator('[name=acknowledge]').check();await page.locator('.zfsm-form button[type=submit]').click();
 const response=page.waitForResponse(r=>r.url()===endpoint&&new URLSearchParams(r.request().postData()).get('cmd')==='deletedirectory');await page.locator('[data-confirm-operation]').click();return (await response).json();
}
async function run(id){const r=await stand.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';echo json_encode(zfsmRunDeletionJob('${id}'));`});assert.equal(r.errors,'');return JSON.parse(r.text);}
try{
 stand.php.mkdir('/usr/bin');stand.php.writeFile('/usr/bin/docker','SYNTHETIC test executable; external reads are simulated');await stand.run({code:"<?php chmod('/usr/bin/docker',0755);chmod('/usr/bin',0755);"});
 await page.goto(stand.url);await page.locator('[data-node="'+target+'"]').waitFor();
 for(const [name,path,rw]of [['writable parent',fixture.mountpoint,true],['unknown access',fixture.mountpoint,undefined],['exact read-only consumer',target,false],['nested read-only consumer',target+'/retained.txt',false]]){
  monitor(path,rw);const reply=await submit();assert.equal(reply.job?.state,'failed',JSON.stringify(reply));assert.equal(reply.job.error_code,'dependencies');assert.equal(helperCount(),0);assert.ok(stand.php.fileExists(target+'/retained.txt'));
  await page.getByRole('button',{name:'View failed attempt in Jobs',exact:true}).click();await page.locator('[data-job-id="'+reply.job.id+'"]').getByRole('alert').waitFor();checks.push(name+' refuses before deletion and appears in Jobs');
 }
 monitor(fixture.mountpoint,false);const queued=await submit();assert.equal(queued.job?.state,'queued',JSON.stringify(queued));assert.ok(stand.php.fileExists(target+'/retained.txt'));await page.getByRole('button',{name:'View deletion progress',exact:true}).click();const first=page.locator('[data-job-id="'+queued.job.id+'"]');await first.getByRole('progressbar',{name:'Deletion progress'}).waitFor();
 monitor(fixture.mountpoint,true);const denied=await run(queued.job.id);assert.equal(denied.state,'failed');assert.equal(denied.error_code,'dependencies');assert.equal(helperCount(),0);assert.ok(stand.php.fileExists(target+'/retained.txt'));checks.push('Worker rechecks read-only → writable change and preserves the directory');
 monitor(fixture.mountpoint,false);const answer=await submit();assert.equal(answer.job?.state,'queued',JSON.stringify(answer));await page.getByRole('button',{name:'View deletion progress',exact:true}).click();const row=page.locator('[data-job-id="'+answer.job.id+'"]');await row.getByRole('progressbar',{name:'Deletion progress'}).waitFor();await page.screenshot({path:output+'/queued.png'});
 const done=await run(answer.job.id);assert.equal(done.state,'completed');assert.equal(done.result.state_verified,true);await row.getByText(/Directory and its selected contents deleted; absence verified/).waitFor();assert.equal(stand.php.fileExists(target),false);assert.ok(stand.php.fileExists(fixture.paths.convert+'/retained.txt'));assert.equal(await row.getByRole('button',{name:'Resume',exact:true}).count(),0);checks.push('Read-only parent allows queued directory deletion; completion and sibling preservation verified');await page.screenshot({path:output+'/completed.png'});
 assert.deepEqual(errors,[]);assert.deepEqual(stand.errors.filter(e=>e.trim()!=='ZFS Director backend request failed'),[]);console.log(JSON.stringify({pass:true,checks}));
}catch(error){checks.push({failed:error.stack});await page.screenshot({path:output+'/failure.png'});throw error;}
finally{await writeFile(output+'/results.json',JSON.stringify({checks,errors,initial_refresh_interval:process.env.ZFSM_REFRESH_INTERVAL||'fixture default',scope:'Real GUI/PHP endpoint, usage parser, guards, queue and worker in WASM. Docker/ZFS reads and confined helper effects are external fixtures; no native operation acceptance.'},null,2)+'\n');await browser.close();await stand.close();}
