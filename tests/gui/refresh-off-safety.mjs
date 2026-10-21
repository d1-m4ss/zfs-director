import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {startMock,lab} from './mock-server.mjs';

// Actual frontend in an isolated browser; all backend data and mutations are synthetic.
const require=createRequire(import.meta.url),{chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const out=process.env.ZFSM_OUTPUT||'backups/2026-10-20/refresh-off-audit/safety';await mkdir(out,{recursive:true});
const mock=await startMock(),browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true});
const refreshInterval=['0','30'].includes(process.env.ZFSM_REFRESH_INTERVAL)?Number(process.env.ZFSM_REFRESH_INTERVAL):0;
const results=[],errors=[],project=lab+'/project',directory='/mnt/'+project+'/ordinary';let context,page,commands;
async function fresh({cached=false}={}){
 if(context)await context.close();mock.reset();mock.model.config.refresh_interval=refreshInterval;
 context=await browser.newContext({viewport:{width:1280,height:960}});page=await context.newPage();page.setDefaultTimeout(5000);commands=[];
 await context.route('**/*',route=>route.request().url().startsWith(mock.url)?route.continue():route.abort());
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST')commands.push(new URLSearchParams(request.postData()).get('cmd'));});
 if(cached)await page.addInitScript(({data,project})=>{localStorage.setItem('zfsm-workspace-inventory-v1',JSON.stringify({time:'2026-10-19T00:00:00Z',data}));localStorage.setItem('zfsm-workspace-preferences-v1',JSON.stringify({pool:'cache',selection:project}));},{data:mock.model.data,project});
}
async function select(name=project){await page.locator('[data-node="'+name+'"]').click();await page.locator('[data-tab=actions]').click();}
async function settled(){await page.waitForFunction(()=>document.querySelector('.zfsm-refresh-button')?.disabled===false);}
async function record(name,run){try{const detail=await run();results.push({name,status:'PASS',...detail});console.log('PASS '+name);}catch(error){results.push({name,status:'FAIL',error:error.message});console.log('FAIL '+name+': '+error.message);await page.screenshot({path:out+'/failure-'+results.length+'.png'}).catch(()=>{});}}
try{
 for(const fault of ['401','403','503','network','timeout','invalid JSON','invalid mapping','partial snapshots'])await record('startup and retry: '+fault,async()=>{
  await fresh({cached:true});if(fault==='partial snapshots')mock.model.config.lazy_load=1;
  let reject=true;await page.route(mock.url+'/mock/admin',async route=>{
   const cmd=new URLSearchParams(route.request().postData()).get('cmd');
   if(!reject||cmd!==(fault==='partial snapshots'?'inventorysnapshots':'inventory'))return route.continue();
   if(['network','timeout'].includes(fault))return route.abort(fault==='timeout'?'timedout':'failed');
   const body=fault==='invalid JSON'?'{invalid':fault==='invalid mapping'?JSON.stringify({op:'getAll',data:{pools:[],datasets:{},devices:{}}}):JSON.stringify({failed:{request:'Synthetic '+fault}});
   return route.fulfill({status:/^\d+$/.test(fault)?Number(fault):fault==='partial snapshots'?503:200,contentType:'application/json',body});
  });
  await page.goto(mock.url);await settled();const cachedRows=refreshInterval===0||fault==='partial snapshots';if(cachedRows){await select();assert.equal(await page.getByRole('button',{name:'Destroy dataset',exact:true}).isDisabled(),true);}else{assert.equal(await page.locator('[data-node]').count(),0,'Refresh ON does not restore cached rows before its first successful read');assert.equal(await page.getByRole('button',{name:'Destroy dataset',exact:true}).count(),0);}
  assert.match(await page.locator('.zfsm-refresh-status').innerText(),/Stale data/);const retry=page.getByRole('button',{name:cachedRows?'Refresh inventory':'Refresh',exact:true});assert.ok(await retry.isVisible());
  reject=false;await retry.click();await settled();await select();assert.equal(await page.getByRole('button',{name:'Destroy dataset',exact:true}).isEnabled(),true);
  assert.equal(commands.filter(cmd=>cmd==='inventory').length,2);assert.equal(mock.model.config.refresh_interval,refreshInterval);
  const mutations=commands.filter(cmd=>!['inventory','inventorysnapshots','conversionjobs','pooldiagnostics','getdatasetproperties'].includes(cmd));assert.deepEqual(mutations,[]);
  return {inventory_reads:2,cached_rows_before_retry:cachedRows,guard_before_retry:'blocked',guard_after_retry:'enabled',mutations:0};
 });
 await record('idle for three virtual minutes follows the requested refresh profile',async()=>{
  await fresh();await page.clock.install();await page.goto(mock.url);await select();await settled();await page.waitForFunction(()=>document.querySelector('[data-section=jobs]')?.textContent.includes('3'));
  const poll=page.waitForResponse(response=>response.url()===mock.url+'/mock/admin'&&new URLSearchParams(response.request().postData()).get('cmd')==='conversionjobs'),inventory=refreshInterval===0?null:page.waitForResponse(response=>response.url()===mock.url+'/mock/admin'&&new URLSearchParams(response.request().postData()).get('cmd')==='inventory');await page.clock.fastForward(180000);await poll;if(inventory){await inventory;await settled();}
  const reads=commands.filter(cmd=>cmd==='inventory').length;if(refreshInterval===0)assert.equal(reads,1);else assert.ok(reads>=2,'Enabled periodic refresh must read inventory');assert.ok(commands.filter(cmd=>cmd==='conversionjobs').length>=2);assert.equal(mock.model.config.refresh_interval,refreshInterval);
  return {inventory_reads:reads,jobs_reads:commands.filter(cmd=>cmd==='conversionjobs').length,virtual_seconds:180};
 });
 await record('Settings switches 0 to 30 and back to 0 without leaving an inventory timer',async()=>{
  await fresh();await page.clock.install();await page.goto(mock.url);await select();await settled();
  async function saveInterval(value){
   await page.locator('[data-section=settings]').click();await page.locator('.zfsm-general-settings>summary').click();await page.locator('[name=refresh_interval]').selectOption(value);const form=page.locator('.zfsm-form');await form.locator('button[type=submit]').click();
   const saved=page.waitForResponse(response=>response.url()===mock.url+'/mock/admin'&&new URLSearchParams(response.request().postData()).get('cmd')==='saveconfig');await form.locator('[data-confirm-operation]').click();await saved;await settled();assert.equal(String(mock.model.config.refresh_interval),value);
  }
  if(refreshInterval!==0)await saveInterval('0');
  await saveInterval('30');const enabledReads=commands.filter(cmd=>cmd==='inventory').length;await page.clock.fastForward(31000);await settled();assert.equal(commands.filter(cmd=>cmd==='inventory').length,enabledReads+1);
  await saveInterval('0');const disabledReads=commands.filter(cmd=>cmd==='inventory').length;await page.clock.fastForward(180000);await settled();assert.equal(commands.filter(cmd=>cmd==='inventory').length,disabledReads);return {enabled_timer_observed:true,disabled_timer_removed:true,final_refresh_interval:0};
 });
 await record('completed conversion reconciles the tree without manual Refresh',async()=>{
  await fresh();await page.goto(mock.url);await select(directory);await page.getByRole('button',{name:'Convert to dataset',exact:true}).click();const form=page.locator('.zfsm-form');await form.locator('[name=offline_confirmed]').check();await form.locator('button[type=submit]').click();const queued=page.waitForResponse(response=>response.url()===mock.url+'/mock/admin'&&new URLSearchParams(response.request().postData()).get('cmd')==='convertdirectory');await form.locator('[data-confirm-operation]').click();assert.ok((await(await queued).json()).job?.id);
  await page.getByRole('button',{name:'Close action',exact:true}).click();const job=mock.model.jobs.find(job=>job.type==='conversion'&&job.source===directory);assert.ok(job);const owner=mock.model.find(project);owner.directories=owner.directories.filter(name=>name!==directory);delete owner._directory_identities[directory];const target=project+'/ordinary';owner.child[target]={...structuredClone(owner),name:target,guid:'999999',mountpoint:'/mnt/'+target,directories:[],child:{},snapshots:[]};job.state='completed';job.stage='complete_source_retained';job.progress={percent:100};
  await page.locator('[data-section=jobs]').click();await page.locator('[data-job-id="'+job.id+'"]').getByRole('status').filter({hasText:/Completed|completed/}).waitFor();await page.locator('[data-section=datasets]').click();await settled();
  try{await page.waitForFunction(({directory,target})=>!document.querySelector('[data-node="'+directory+'"]')&&Boolean(document.querySelector('[data-node="'+target+'"]')),{directory,target},{timeout:3000});}catch(error){if(error.name!=='TimeoutError')throw error;}
  const observed={inventory_reads:commands.filter(cmd=>cmd==='inventory').length,old_directory:await page.locator('[data-node="'+directory+'"]').count(),new_dataset:await page.locator('[data-node="'+target+'"]').count()};await page.screenshot({path:out+'/completed-conversion-reconciled.png'});
  assert.equal(observed.old_directory,0,JSON.stringify(observed));assert.equal(observed.new_dataset,1,JSON.stringify(observed));return observed;
 });
 for(const filter of ['active','restore'])await record('completed deletion hidden by '+filter+' reconciles without Refresh',async()=>{
  await fresh();const id='20261020-120000-000000000099';
  await page.route(mock.url+'/mock/admin',async route=>{const fields=new URLSearchParams(route.request().postData());if(fields.get('cmd')!=='deletedirectory')return route.continue();assert.equal(fields.get('directory'),directory);const job={id,schema:6,type:'deletion',kind:'directory',state:'queued',stage:'planned',source:directory,created:Math.floor(Date.now()/1000),actions:{},progress:{percent:0}};mock.model.jobs.unshift(job);return route.fulfill({contentType:'application/json',body:JSON.stringify({succeeded:{[directory]:'Queued'},failed:{},job})});});
  await page.goto(mock.url);await select(directory);await page.getByRole('button',{name:'Delete directory',exact:true}).click();const form=page.locator('.zfsm-form');await form.locator('[name=acknowledge]').check();await form.locator('button[type=submit]').click();const queued=page.waitForResponse(r=>r.url()===mock.url+'/mock/admin'&&new URLSearchParams(r.request().postData()).get('cmd')==='deletedirectory');await form.locator('[data-confirm-operation]').click();await queued;await page.getByRole('button',{name:'Close action',exact:true}).click();
  await page.locator('[data-section=jobs]').click();await page.getByRole('combobox',{name:'Filter jobs',exact:true}).selectOption(filter);await page.getByRole('combobox',{name:'Filter jobs',exact:true}).waitFor();
  const reconciled=page.waitForResponse(r=>r.url()===mock.url+'/mock/admin'&&new URLSearchParams(r.request().postData()).get('cmd')==='inventory',{timeout:7000});const job=mock.model.jobs.find(j=>j.id===id),owner=mock.model.find(project);assert.ok(job);owner.directories=[];owner._directory_identities={};job.state='completed';job.stage='completed';job.progress={percent:100};
  await reconciled;await settled();
  assert.equal(await page.getByRole('combobox',{name:'Filter jobs',exact:true}).inputValue(),filter);assert.equal(await page.locator('[data-job-id="'+id+'"]').count(),0);await page.locator('[data-section=datasets]').click();await settled();assert.equal(await page.locator('[data-node="'+directory+'"]').count(),0);assert.equal(commands.filter(cmd=>cmd==='deletedirectory').length,1);await page.screenshot({path:out+'/deletion-'+filter+'-reconciled.png'});return {filter,deleted_row_absent:true,confirmed_deletion_requests:1,inventory_reads:commands.filter(cmd=>cmd==='inventory').length};
 });
}finally{
 await writeFile(out+'/results.json',JSON.stringify({commit:(process.env.ZFSM_SOURCE_REVISION||'working-tree'),source_tree:execFileSync('git',['rev-parse','HEAD:src'],{encoding:'utf8'}).trim(),initial_refresh_interval:refreshInterval,scope:'Actual local Chromium frontend; synthetic HTTP/native responses only; no test-host connection. timeout case is an aborted network request, not the 60-second application deadline.',results,errors},null,2)+'\n');
 if(context)await context.close();await browser.close();await mock.close();
}
process.exitCode=results.some(result=>result.status==='FAIL')||errors.length?1:0;
