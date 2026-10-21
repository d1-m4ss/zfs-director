import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {startIntegration} from './server.mjs';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const output=process.env.ZFSM_OUTPUT||'evidence/cleanup-2026-10-18/gui';await mkdir(output,{recursive:true});
const stand=await startIntegration({dependencyUsage:true}),results=[],errors=[];
// WASM cannot observe native flock contention. Only this kernel lease-held
// observation is simulated; the request FD/path identity checks remain real.
const jobs='/app/src/include/ZFSMJobs.php';stand.php.writeFile(jobs,stand.php.readFileAsText(jobs).replace('function zfsmLockHeld($file) {',"function zfsmLockHeld($file) { if(str_contains($file,'/requests/'))return true;"));
const browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1000}});page.on('pageerror',e=>errors.push(e.message));
const model=stand.readModel(),owner=model.directory_fixtures.owner,root=model.directory_fixtures.mountpoint,target=root+'/.zfsm-mutation-'+'a'.repeat(48);
const endpoint=stand.url+'/plugins/zfs.master.ui/backend/ZFSMAdmin.php';
async function post(cmd,fields={}){return (await fetch(endpoint,{method:'POST',body:new URLSearchParams({csrf_token:'integration-token',cmd,...fields})})).json();}
const helpers=()=>stand.readModel().calls.filter(c=>c.stdin_json?.op==='cleanup').length;
const cfg='/boot/config/plugins/zfs.master.ui/zfs.master.ui.cfg';let id;
async function check(name,fn){await fn();results.push({name,status:'PASS'});}
function isolateRefusal(answer){if(answer.job){assert.equal(answer.job.schema,7);assert.equal(answer.job.state,'failed');assert.equal(answer.job.command,'cleanupmutation');stand.php.unlink('/boot/config/plugins/zfs.master.ui/jobs/'+answer.job.id+'.json');}}
function fields(preview){return {directory:target,expected_guid:model.datasets[owner].guid,'directory_identity[dev]':id.dev,'directory_identity[ino]':id.ino,preview_id:preview.preview_id,token:preview.token,confirmed:'1'};}
async function preview(){const p=await post('previewcleanup',{directory:target});assert.ok(p.token,JSON.stringify(p));return p;}
try{
 stand.php.mkdir(target);stand.php.writeFile(target+'/journal.jsonl','Synthetic helper-boundary journal\n');
 const r=await stand.run({code:'<?php $s=lstat('+JSON.stringify(target)+');echo json_encode(["dev"=>(string)$s["dev"],"ino"=>(string)$s["ino"]]);'});id=JSON.parse(r.text);
 stand.php.writeFile('/etc/samba/smb-shares.conf','[fixture]\npath = '+root+'\n');
 await check('preview reads without cleanup; CSRF and explicit confirmation required',async()=>{
  const p=await preview();assert.equal(helpers(),0);
  for(const extra of [{csrf_token:'wrong'},{confirmed:'0'}]){const a=await post('cleanupmutation',{...fields(p),...extra});assert.ok(Object.keys(a.failed).length);assert.equal(helpers(),0);isolateRefusal(a);}
 });
 await check('destructive mode OFF denies cleanup',async()=>{
  const p=await preview(),original=stand.php.readFileAsText(cfg);stand.php.writeFile(cfg,original.replace(/destructive_mode = "1"/,'destructive_mode = "0"'));
  try{const a=await post('cleanupmutation',fields(p));assert.match(JSON.stringify(a.failed),/Destructive Mode/);assert.equal(helpers(),0);isolateRefusal(a);}finally{stand.php.writeFile(cfg,original);}
 });
 await check('changed digest, dataset GUID, inode and missing token deny cleanup',async()=>{
  for(const kind of ['digest','guid','inode','token']){
   const p=await preview(),f=fields(p);if(kind==='digest')stand.php.writeFile(target+'/journal.jsonl','Changed journal\n');
   if(kind==='guid')f.expected_guid='1';if(kind==='inode')f['directory_identity[ino]']='1';if(kind==='token')f.token='0'.repeat(64);
   const a=await post('cleanupmutation',f);assert.ok(Object.keys(a.failed).length,kind+JSON.stringify(a));assert.equal(helpers(),0);isolateRefusal(a);
  }
 });
 await check('unfinished Jobs and native refusal deny preview',async()=>{
  const job='/boot/config/plugins/zfs.master.ui/jobs/20261018-000000-aaaaaaaaaaaa.json';stand.php.writeFile(job,JSON.stringify({schema:1,state:'running'}));
  let a=await post('previewcleanup',{directory:target});assert.match(JSON.stringify(a.failed),/Jobs/);stand.php.unlink(job);
  const m=stand.readModel();m.cleanup_refuse=true;stand.writeModel(m);a=await post('previewcleanup',{directory:target});assert.match(JSON.stringify(a.failed),/native safety refusal/);delete m.cleanup_refuse;stand.writeModel(m);assert.equal(helpers(),0);
 });
 await check('exact configured export remains protected',async()=>{
  const p=await preview();stand.php.writeFile('/etc/samba/smb-shares.conf','[fixture]\npath = '+target+'\n');
  try{const a=await post('cleanupmutation',fields(p));assert.match(JSON.stringify(a.failed),/configured service references/);assert.equal(helpers(),0);isolateRefusal(a);}finally{stand.php.writeFile('/etc/samba/smb-shares.conf','[fixture]\npath = '+root+'\n');}
 });
 await check('archive unavailable denies native deletion',async()=>{
  const p=await preview(),archive='/boot/config/plugins/zfs.master.ui/mutation-cleanup';stand.php.writeFile(archive,'storage blocked');
  const a=await post('cleanupmutation',fields(p));assert.match(JSON.stringify(a.failed),/storage|journal/i);assert.equal(helpers(),0);stand.php.unlink(archive);isolateRefusal(a);
 });
 await page.goto(stand.url);await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.locator('[data-section=jobs]').click();await page.getByRole('button',{name:'Show recovery files',exact:true}).click();await page.locator('[data-node="'+target+'"]').click();
 await page.getByRole('button',{name:'Clean completed recovery',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Delete directory',exact:true}).count(),0);
 await page.getByRole('button',{name:'Load fresh preview',exact:true}).click();await page.getByText('Completed delete operation',{exact:true}).waitFor();
 await check('fresh preview and confirmation visible in both views and four themes',async()=>{
  assert.equal(await page.locator('.zfsm-form button[type=submit]').isDisabled(),true);
  for(const view of ['Workspace','Compact']){
   await page.getByRole('button',{name:view,exact:true}).click();
   await page.locator('[data-node="'+target+'"]').click();await page.getByRole('button',{name:'Clean completed recovery',exact:true}).click();
   if(!await page.getByText('Completed delete operation',{exact:true}).count()){await page.getByRole('button',{name:'Load fresh preview',exact:true}).click();await page.getByText('Completed delete operation',{exact:true}).waitFor();}
   for(const theme of ['dark','gray','light','azure']){await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(theme);await page.screenshot({path:output+'/'+view.replaceAll(' ','-')+'-'+theme+'.png',fullPage:true});}
  }
  await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption('auto');
  for(const width of [390,1600]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:output+'/inherited-'+width+'.png',fullPage:true});}
 });
 await check('GUI cleanup archives exact journal, deletes selected container and rejects replay',async()=>{
  const bytes=stand.php.readFileAsText(target+'/journal.jsonl');
  await page.locator('[name=acknowledge]').check();await page.locator('.zfsm-form button[type=submit]').click();
  const response=page.waitForResponse(r=>r.url()===endpoint&&new URLSearchParams(r.request().postData()).get('cmd')==='cleanupmutation');await page.locator('[data-confirm-operation]').click();
  const resp=await response,a=await resp.json();assert.equal(Object.keys(a.failed).length,0,JSON.stringify(a));assert.equal(helpers(),1);assert.equal(stand.php.fileExists(target),false);
  const archive=JSON.parse(stand.php.readFileAsText(a.cleanup_archive));assert.equal(Buffer.from(archive.journal_base64,'base64').toString(),bytes);assert.equal(archive.scope.directory,target);
  const replay=await(await fetch(endpoint,{method:'POST',body:new URLSearchParams(resp.request().postData())})).json();assert.ok(Object.keys(replay.failed).length);assert.equal(helpers(),1);
  await page.getByText('Recovery cleanup completed',{exact:true}).waitFor();await page.screenshot({path:output+'/success.png',fullPage:true});
 });
 assert.deepEqual(errors,[]);assert.ok(stand.errors.every(e=>e==='ZFS Director backend request failed\n'),JSON.stringify(stand.errors));
}catch(e){results.push({name:'cleanup endpoint/GUI suite',status:'FAIL',error:e.stack});await page.screenshot({path:output+'/failure.png',fullPage:true});process.exitCode=1;}
finally{console.log(JSON.stringify(results,null,2));await writeFile(output+'/results.json',JSON.stringify({results,errors,boundary:'Actual endpoint, signing, archive, GUI and lease FD/path identity; external ZFS/helper effects and native lease-held observation simulated. Native cleanup and lease locking verified separately.'},null,2)+'\n');await browser.close();await stand.close();}
