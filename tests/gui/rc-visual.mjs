import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {startMock,lab} from './mock-server.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const output=process.env.ZFSM_OUTPUT||'evidence/branding-2026-10-16/visual';await mkdir(output+'/screenshots',{recursive:true});
const mock=await startMock(),browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true});
const results=[],issues=[],external=[],images=[],colors=[];let context,page;const project=lab+'/project',snap=project+'@base';
async function fresh(width=1920,touch=false){if(context)await context.close();mock.reset();context=await browser.newContext({viewport:{width,height:1100},hasTouch:touch});page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',e=>issues.push(e.message));await context.route('**/*',r=>{if(r.request().url().startsWith(mock.url))r.continue();else{external.push(r.request().url());r.abort();}});await page.goto(mock.url);await page.locator('[data-node="'+project+'"]').waitFor();await page.locator('[data-node="'+project+'"]').click();await page.getByRole('button',{name:'Overview',exact:true}).click();}
async function capture(name){assert.equal(await page.getByRole('heading',{name:'ZFS Director',exact:true}).count(),1);assert.doesNotMatch(await page.locator('body').innerText(),/ZFS[ _-]+Master/i);assert.equal(await page.locator('h1 [data-icon=director]').count(),1);if(name.endsWith('-properties'))assert.ok(await page.locator('.zfsm-form-group').count()>0,'Properties screenshot must contain loaded field groups');if(name.endsWith('-administrative-history'))assert.equal(await page.locator('.zfsm-history-toolbar').count(),1,'History screenshot must contain loaded filters');if(name.endsWith('-jobs')){await page.getByRole('combobox',{name:'Filter jobs',exact:true}).waitFor();await page.locator('[data-job-id]').first().waitFor();assert.equal(await page.getByText('Loading current jobs…',{exact:true}).count(),0,'Jobs screenshot must contain loaded timeline');}const file=name+'.png';await page.screenshot({path:output+'/screenshots/'+file,fullPage:!name.includes('file-manager')});images.push(file);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Page overflow: '+name);}
async function test(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',error:e.message});console.log('FAIL '+name+': '+e.message);}}
try{
 await test('all themes keep readable primary selected and pool state text contrast',async()=>{
  function luminance(color){const c=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2];}
  function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
  await fresh();
  for(const theme of ['auto','dark','gray','light','azure']){
   await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(theme);
   const pairs=await page.locator('#zfsm-workspace').evaluate(root=>{
    const primary=document.createElement('button');primary.className='zfsm-primary';primary.textContent='Primary style probe';root.append(primary);const s=getComputedStyle(primary),pairs=[{kind:'primary',fg:s.color,bg:s.backgroundColor}];primary.remove();
    const selected=root.querySelector('[data-section="datasets"]');const css=getComputedStyle(selected);pairs.push({kind:'selected',fg:css.color,bg:css.backgroundColor});
    for(const severity of ['ok','warning','error']){const probe=document.createElement('span');probe.dataset.severity=severity;probe.innerHTML='<span class="zfsm-pool-health">State</span>';selected.append(probe);pairs.push({kind:severity,fg:getComputedStyle(probe.firstChild).color,bg:css.backgroundColor});probe.remove();}return pairs;
   });
   for(const pair of pairs)assert.ok(contrast(pair.fg,pair.bg)>=4.5,theme+' '+pair.kind+' contrast '+contrast(pair.fg,pair.bg).toFixed(2));
  }
 });
 await test('Overview protection actions stay visually separated on desktop and mobile',async()=>{
  for(const width of [390,1920]){await fresh(width);await page.waitForFunction(()=>['View Snapshots','Manage Protection'].every(label=>[...document.querySelectorAll('.zfsm-overview-card>button')].some(el=>el.textContent===label&&el.getBoundingClientRect().width>0)));const [a,b]=await page.evaluate(()=>['View Snapshots','Manage Protection'].map(label=>{const el=[...document.querySelectorAll('.zfsm-overview-card>button')].find(el=>el.textContent===label),r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};}));assert.ok(b.y>=a.y+a.height||b.x>=a.x+a.width+8,'Protection action labels must have a visible gap');}
 });
 await test('dataset tree Arrow Home End collapse and touch selection preserve identity',async()=>{
  await fresh();const node=page.locator('[data-node="'+project+'"]');await node.focus();await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>document.activeElement.dataset.node),'cache');await page.keyboard.press('ArrowDown');assert.notEqual(await page.evaluate(()=>document.activeElement.dataset.node),'cache');await page.keyboard.press('End');const last=await page.locator('.zfsm-tree-node').last().getAttribute('data-node');assert.equal(await page.evaluate(()=>document.activeElement.dataset.node),last);await page.keyboard.press('ArrowUp');assert.notEqual(await page.evaluate(()=>document.activeElement.dataset.node),last);
  await page.locator('[data-node="'+lab+'"]') .focus();await page.keyboard.press('ArrowLeft');assert.equal(await page.locator('[data-node="'+project+'"]') .count(),0);await page.keyboard.press('ArrowRight');await page.locator('[data-node="'+project+'"]') .waitFor();
  await fresh(390,true);await page.locator('[data-node="'+project+'"]') .tap();assert.equal(await page.evaluate(()=>zfsm_workspace.getState().selection),project);
 });
 await test('Snapshots Dataset chooser navigates direct scope and drops prior bulk selection',async()=>{
  await fresh(390,true);const target=lab+'/clone';mock.model.find(target).snapshots=[{...mock.model.findSnapshot(snap),name:target+'@chooser',guid:'99001'}];
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Snapshots',exact:true}).click();
  await page.getByRole('checkbox',{name:'Select snapshot '+snap,exact:true}).check();assert.equal(await page.getByRole('button',{name:'Destroy selected snapshots',exact:true}).isDisabled(),false);
  const choose=page.getByRole('combobox',{name:'Dataset',exact:true});await choose.selectOption(target);
  assert.equal(await page.evaluate(()=>zfsm_workspace.getState().selection),target);assert.equal(await page.evaluate(()=>zfsm_workspace.getState().tab),'snapshots');
  assert.match(await page.locator('.zfsm-snapshot-scope').innerText(),/clone.*Direct snapshots only/);assert.equal(await page.getByRole('checkbox',{name:'Select snapshot '+snap,exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Destroy selected snapshots',exact:true}).isDisabled(),true);await page.getByRole('checkbox',{name:'Select snapshot '+target+'@chooser',exact:true}).check();
  await choose.selectOption(project);assert.equal(await page.getByRole('checkbox',{name:'Select snapshot '+snap,exact:true}).isChecked(),false);assert.equal(await page.getByRole('button',{name:'Destroy selected snapshots',exact:true}).isDisabled(),true);
  assert.equal(mock.model.calls.some(call=>['snapshotdataset','destroysnapshot'].includes(call.cmd)),false);await capture('390-snapshot-dataset-chooser');
 });

 for(const theme of ['auto','dark','gray','light','azure'])for(const layout of ['Workspace','Compact table'])await test(theme+' '+layout+' real screenshot and selection',async()=>{
  await fresh();await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(theme);await page.getByRole('button',{name:layout,exact:true}).click();assert.equal(await page.evaluate(()=>zfsm_workspace.getState().selection),project);await page.locator('.zfsm-overview-card').first().waitFor();await capture('theme-'+theme+'-'+(layout==='Workspace'?'workspace':'compact'));
  colors.push(await page.locator('#zfsm-workspace').evaluate((el)=>{const s=getComputedStyle(el);return {theme:el.dataset.theme,layout:el.dataset.layout,bg:s.backgroundColor,text:s.color,muted:s.getPropertyValue('--zfsm-muted').trim(),accent:s.getPropertyValue('--zfsm-accent').trim()};}));
 });
 for(const width of [390,768,1280,1920])await test(width+' responsive key workflows and touch controls',async()=>{
  await fresh(width,width<=768);await capture(width+'-overview');
  for(const tab of ['Properties','Snapshots','Actions']){await page.getByRole('button',{name:tab,exact:true}).click();if(tab==='Properties')await page.locator('.zfsm-form-group').first().waitFor();await capture(width+'-'+tab.toLowerCase());}
  await page.getByRole('button',{name:'Snapshots',exact:true}).click();await page.locator('[data-file-manager="'+snap+'"]').click();await page.getByRole('dialog',{name:'Snapshot File Manager',exact:true}).waitFor();await page.getByRole('checkbox',{name:'Select notes.txt',exact:true}).check();await capture(width+'-file-manager');await page.getByRole('button',{name:'Close File Manager',exact:true}).click();
  for(const tab of ['Jobs','Administrative History','Settings','Pool & Scrub']){await page.getByRole('button',{name:tab==='Jobs'?/^Jobs/:tab,exact:tab!=='Jobs'}).click();if(tab==='Administrative History')await page.locator('.zfsm-history-toolbar').waitFor();await capture(width+'-'+tab.toLowerCase().replaceAll(/[^a-z]+/g,'-'));}
  assert.equal(mock.model.calls.filter(c=>c.cmd==='scrubpool').length,0,'Visual review cannot launch scrub');
 });
 for(const severity of ['warning','error','unknown'])await test('pool '+severity+' is visible and never Healthy',async()=>{
  await fresh();mock.model.diagnostic.severity=severity;mock.model.diagnostic.reasons=['Synthetic '+severity+' reason'];await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.locator('.zfsm-pool-button[data-severity="'+severity+'"]').waitFor();const label=await page.locator('.zfsm-pool-button').innerText();assert.ok(!label.includes('Healthy'));await page.getByRole('button',{name:'Pool & Scrub',exact:true}).click();await capture('pool-'+severity);
 });
 await test('malformed HTTP response retains rows and blocks mutation',async()=>{
  await fresh();await page.route(mock.url+'/mock/admin',async route=>{if(new URLSearchParams(route.request().postData()).get('cmd')==='inventory')await route.fulfill({contentType:'application/json',body:'{not-json'});else await route.continue();});
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText(/Stale data/).first().waitFor();assert.equal(await page.getByRole('button',{name:'Take Snapshot',exact:true}).isDisabled(),true);await capture('inventory-malformed-stale');
 });
 await test('real pending HTTP request is aborted by actual inventory deadline',async()=>{
  await fresh();await page.clock.install();let held;await page.route(mock.url+'/mock/admin',async route=>{if(new URLSearchParams(route.request().postData()).get('cmd')==='inventory'){held=route;return;}await route.continue();});
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.zfsm-refresh-button').disabled===true);await page.clock.fastForward(60001);await page.getByText(/Stale data/).first().waitFor();assert.equal(await page.getByRole('button',{name:'Take Snapshot',exact:true}).isDisabled(),true);assert.ok(held);await capture('inventory-http-timeout');
 });
}finally{if(context)await context.close();await browser.close();await mock.close();}
const report={git:{head:(process.env.ZFSM_SOURCE_REVISION||'working-tree'),dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()!==''},results,issues,external,images,colors,timeoutScope:'Real browser fetch and AbortController, pending HTTP route; Playwright virtual browser clock advances the unchanged 60000ms deadline. Not a 60-second wall-clock latency benchmark.'};await writeFile(output+'/results.json',JSON.stringify(report,null,2)+'\n');process.exitCode=results.some(r=>r.status!=='PASS')||issues.length||external.length?1:0;
