import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {protectionUXFixture} from '../fixtures/protection-ux.mjs';

// Offline rendering of the actual frontend. No HTTP listener, remote access or native operations.
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const phase=process.env.ZFSM_PHASE||'after',out=resolve(process.env.ZFSM_OUTPUT||'evidence/clean-ui-2026-10-19',phase);
await mkdir(out,{recursive:true});
const source=process.env.ZFSM_SOURCE||'src/frontend';
const names=['ZFSMInventory.js','ZFSMForms.js','ZFSMSnapshots.js','ZFSMExplorer.js','ZFSMPoolView.js','ZFSMOverview.js','ZFSMHistory.js','ZFSMProtection.js','ZFSMWorkspace.js','ZFSMWorkspace.css','ZFSMProtection.css'];
const contents=await Promise.all(names.map(name=>readFile(source+'/'+name,'utf8')));
const hashes=Object.fromEntries(names.map((name,i)=>[name,createHash('sha256').update(contents[i]).digest('hex')]));
const prototype=await readFile('docs/design/2026-10-19-clean-ui/ZFS-Director-Clean-UI.html','utf8');
const screens=['overview','datasets','protection','replication','jobs','settings'];
const errors=[],results=[],failures=[];
const policyTimesOnly=process.env.ZFSM_POLICY_TIMES_ONLY==='1';
const browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true});
const check=(condition,message)=>{if(!condition)failures.push(message);};
async function capture(page,key){await page.screenshot({path:out+'/'+key+'.png',fullPage:await page.getByRole('dialog').count()===0});}
async function geometry(page){return page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:innerHeight,headings:[...document.querySelectorAll('h1,h2')].filter(e=>e.getBoundingClientRect().width).map(e=>e.textContent),panels:[...document.querySelectorAll('.main-grid,.zfsm-protection-main,.zfsm-protection-list,.zfsm-protection-inspector,.detail-panel,.sidebar,.zfsm-sidebar,.zfsm-pagehead,.pagehead')].filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height&&!e.closest('details:not([open])')).map(e=>({className:e.className,x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))}));}
async function setup(page,theme,width,layout,gate='visible'){
 await page.setContent('<style>body{margin:0;padding:16px;background:#ececec;color:#222;font:13px Arial,sans-serif;--background-color:#ececec;--mild-background-color:#fff;--border-color:#ccc}</style><main id="zfsm-workspace"></main>');
 for(let i=0;i<names.length;i++)if(names[i].endsWith('.css'))await page.addStyleTag({content:contents[i]});else await page.addScriptTag({content:contents[i]});
 await page.evaluate(({fixtureData,gate,policyTimesOnly,refreshInterval})=>{
  if(policyTimesOnly)fixtureData.snapshot_defaults={frequently:0,hourly:24,daily:7,weekly:0,monthly:0,yearly:0,frequent_period:15,hourly_min:0,daily_hour:23,daily_min:59,weekly_wday:1,weekly_hour:23,weekly_min:30,monthly_mday:1,monthly_hour:0,monthly_min:0,yearly_mon:1,yearly_mday:1,yearly_hour:0,yearly_min:0};
  window.zfsmFormatDateTime=()=> '19 Oct 2026, 08:00';
  const detection={installed:gate!=='missing',enabled:gate!=='disabled',compatible:gate!=='untrusted',visible:gate==='visible',state:gate==='visible'?'healthy':gate,issues:[],sanoid:{version:'2.3.0',path:'/usr/sbin/sanoid'},syncoid:{version:'2.3.0',path:'/usr/sbin/syncoid',compressions:['none']},configuration_status:{message:'Valid'},scheduler_status:{available:true}};
  const ds=(name,guid)=>({name,guid,type:'filesystem',mounted:'yes',mountpoint:'/mnt/'+name,encryption:'off',keystatus:'none',compression:'lz4',used:10485760,available:1073741824,referenced:10485760,child:{},directories:[],snapshots:[]});
  const root=ds('cache','1');for(const [i,name]of ['cache/a','cache/photos','cache/photos/library'].entries())root.child[name]=ds(name,String(i+2));
  root.child['cache/a'].snapshots=[{name:'cache/a@manual',guid:'123',creation:1792393200,used:4096,referenced:10485760,written:1024,userrefs:0,defer_destroy:'off'}];
  root.child['cache/a'].directories=['/mnt/cache/a/ordinary'];root.child['cache/a']._directory_identities={'/mnt/cache/a/ordinary':{dev:'1',ino:'100'}};
  const inventory={op:'getAll',data:{pools:{cache:{Health:'ONLINE',Size:1099511627776,Used:549755813888,Snapshots:0}},datasets:{cache:root},devices:{cache:''},errors:{}}};
  fixtureData.replications=[{id:'rep-1',name:'Project archive',source:'cache/a',target:'backup/project',mode:'local',owner:'managed',enabled:false,schedule:'0 2 * * *',last_job:{verified_outcome:'unknown',verification:{reason:'Receiver checkpoint not yet verified'}}}];
  window.fixture={detection,data:fixtureData,calls:[],inventory,failPreview:false};
  window.zfsm_workspace=zfsmCreateWorkspace({root:document.querySelector('main'),hostTheme:'white',config:{refresh_interval:refreshInterval,destructive_mode:1,directory_listing:['cache/a']},request:async fields=>{
   fixture.calls.push(fields);if(fields.cmd==='conversionjobs')return {jobs:[{id:'fixture-job',type:'archive',state:'completed',stage:'completed',source:'cache/a@manual',created:1792393200,updated:1792393204,progress:{percent:100,bytes:1024}}],worker_running:false};
   if(fields.cmd==='inventory'||fields.cmd==='inventorysnapshots')return inventory;
   if(fields.cmd==='getdatasetproperties')return root.child[fields.zdataset]||root;
   if(fields.cmd==='pooldiagnostics')throw Error('Synthetic diagnostics unavailable');
   if(fields.cmd==='auditlog')return {entries:[]};
   if(fields.cmd==='snapshotfiles')return {snapshot:fields.snapshot,snapshot_guid:'123',path:fields.path,total:1,restore_available:true,entries:[{name:'notes.txt',path:'notes.txt',type:'file',available:true,size:2048,mtime:1792393200,dev:'1',ino:'101'}]};
   if(fields.cmd==='previewrestore')return {id:'b'.repeat(32),token:'signed-fixture',files:1,bytes:2048,selection:fields.selection,target:'/mnt/cache/a/'+fields.target,conflicts:[]};
   if(fields.cmd==='previewdestroy')return {target:fields.zdataset||fields.snapshot,preview_id:'b'.repeat(32),token:'a'.repeat(64),can_destroy:true,objects:[{name:fields.zdataset||fields.snapshot,guid:'2'}],preview:'Synthetic reviewed deletion scope only'};
   if(fields.cmd==='protectiondetect')return detection;if(fields.cmd==='protectiondata')return fixtureData;
   if(fields.cmd.endsWith('preview')){if(fixture.failPreview)throw Error('Synthetic connection lost');const value={...fields.data};for(const key of ['enabled','recursive','process_children_only','autosnap','autoprune','resume','no_sync_snap','use_hold','bookmark'])if(Object.hasOwn(value,key))value[key]=[true,1,'1'].includes(value[key]);return {preview_id:'a'.repeat(32),token:'signed-fixture',review:{type:fields.cmd.includes('policy')?'policy':'replication',value,scope:['cache/a'],config:'Synthetic configuration preview',warnings:[],capabilities:{resume:true},inspection:{source:{'':{guid:'2',snapshots:{'123':'base'}}},target:{'':{guid:'4',snapshots:{'123':'base'}}}}}};}
   throw Error('Unexpected fixture command '+fields.cmd);
  }});
 },{fixtureData:protectionUXFixture(),gate,policyTimesOnly,refreshInterval:['0','30'].includes(process.env.ZFSM_REFRESH_INTERVAL)?Number(process.env.ZFSM_REFRESH_INTERVAL):0});
 await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(theme);
 await page.locator('[data-layout-choice='+layout+']').click();
}
async function modalChecks(page,key){
 const dialog=page.getByRole('dialog');await dialog.waitFor();
 const g=await dialog.evaluate(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);const lum=c=>{const rgb=c.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};let p=e,b=s.backgroundColor;while((b==='rgba(0, 0, 0, 0)'||b==='transparent')&&p.parentElement){p=p.parentElement;b=getComputedStyle(p).backgroundColor;}const a=lum(s.color),v=lum(b);return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,contrast:(Math.max(a,v)+.05)/(Math.min(a,v)+.05),scrollWidth:e.scrollWidth,clientWidth:e.clientWidth};});
 check(g.x>=-1&&g.y>=-1&&g.right<=g.width+1&&g.bottom<=g.height+1,key+' dialog outside viewport '+JSON.stringify(g));
 check(g.scrollWidth<=g.clientWidth+1,key+' dialog content overflow');check(g.contrast>=4.5,key+' text contrast '+g.contrast);
 return g;
}
async function listChecks(page,key,layout,width,type){
 const rows=page.locator(type==='policy'?'[data-policy-id]':'[data-replication-id]');check(await rows.count()>0,key+' missing rows');
 const contrasts=await page.locator('.zfsm-protection-table tr[data-definition-id]:visible > td').evaluateAll(cells=>cells.map(e=>{const lum=c=>{const rgb=c.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};const color=getComputedStyle(e).color;let p=e,b=getComputedStyle(e).backgroundColor;while((b==='rgba(0, 0, 0, 0)'||b==='transparent')&&p.parentElement){p=p.parentElement;b=getComputedStyle(p).backgroundColor;}const a=lum(color),v=lum(b);return {text:e.textContent.slice(0,40),color,background:b,ratio:(Math.max(a,v)+.05)/(Math.min(a,v)+.05)};}));for(const sample of contrasts)check(sample.ratio>=4.5,key+' table text contrast '+JSON.stringify(sample));
 if(await rows.count()){
  const row=rows.first();await page.keyboard.press('Tab');await row.focus();const focus=await row.evaluate(e=>({visible:e.matches(':focus-visible'),style:getComputedStyle(e).outlineStyle,width:parseFloat(getComputedStyle(e).outlineWidth)}));check(focus.visible&&focus.style!=='none'&&focus.width>=1,key+' no visible keyboard focus '+JSON.stringify(focus));await row.press('Enter');check(await row.getAttribute('aria-selected')==='true',key+' keyboard selection not announced');
  const inspector=page.locator('[data-protection-inspector]:visible');
  if(layout==='tree'&&width>1000)check(await inspector.count()===1,key+' Workspace needs one visible inspector');
  else{check(await inspector.count()===0,key+' Compact/mobile persistent inspector');await modalChecks(page,key+' selection');await page.keyboard.press('Escape');}
 }
}
async function legacyBeforeChecks(page,key){
 await navigate(page,'datasets');await page.locator('[data-node="cache/a"]').click();
 await page.locator('[data-tab=snapshots]').click();await capture(page,key+'-snapshots');
 await page.locator('[data-file-manager]').click();await page.getByRole('dialog',{name:'Snapshot File Manager',exact:true}).waitFor();await capture(page,key+'-file-manager');await page.keyboard.press('Escape');
 await page.locator('[data-tab=actions]').click();await capture(page,key+'-dataset-actions');
 await page.locator('[data-node="/mnt/cache/a/ordinary"]').click();await capture(page,key+'-directory-actions');
}
async function legacyChecks(page,key){
 await navigate(page,'datasets');await page.locator('[data-node="cache/a"]').click();
 for(const [tab,label]of [['overview','dataset-overview'],['details','dataset-information'],['properties','dataset-properties']]){await page.locator('[data-tab='+tab+']').click();if(tab==='properties')await page.locator('.zfsm-form-group').first().waitFor();await capture(page,key+'-'+label);}
 await page.getByRole('button',{name:'Pool & Scrub',exact:true}).click();for(const tab of ['status','information','devices']){await page.locator('.zfsm-pool-tabs [data-tab='+tab+']').click();await capture(page,key+'-pool-'+tab);}await navigate(page,'datasets');
 await page.getByRole('button',{name:'Create Dataset',exact:true}).click();await page.locator('.zfsm-create-form').waitFor();await capture(page,key+'-create-dataset');await navigate(page,'datasets');await page.locator('[data-node="cache/a"]').click();
 for(const tab of ['properties','snapshots','files','actions']){check(await page.locator('[data-tab='+tab+']').count()===1,key+' missing '+tab+' tab');}
 await page.locator('[data-tab=files]').click();const chooser=page.getByRole('combobox',{name:'Snapshot to browse',exact:true});await chooser.selectOption('cache/a@manual');await page.getByRole('button',{name:'Open File Manager',exact:true}).click();await page.getByRole('dialog',{name:'Snapshot File Manager',exact:true}).waitFor();await capture(page,key+'-file-manager-tab');await page.keyboard.press('Escape');check(await chooser.evaluate(e=>e===document.activeElement),key+' File Manager tab close focus');
 await page.locator('[data-tab=snapshots]').click();await capture(page,key+'-snapshots');await page.locator('[data-file-manager]').click();await page.getByRole('heading',{name:'Snapshot File Manager',exact:true}).waitFor();
 await modalChecks(page,key+' File Manager');await page.getByRole('checkbox',{name:'Select notes.txt',exact:true}).check();
 check(await page.getByRole('button',{name:'Download selected as ZIP',exact:true}).isEnabled(),key+' ZIP unavailable');
 await page.getByRole('button',{name:'Restore selected',exact:true}).click();await page.getByRole('button',{name:'Review restore',exact:true}).click();await page.locator('.zfsm-restore-review').waitFor();
 check(await page.getByRole('button',{name:'Start restore',exact:true}).isDisabled(),key+' restore bypassed independent confirmation');await capture(page,key+'-file-manager-restore');await page.keyboard.press('Escape');
 await page.locator('[data-tab=actions]').click();for(const label of ['Take Snapshot','Rename dataset','Edit Dataset','User / group quotas','POSIX ACL editor','Destroy dataset'])check(await page.getByRole('button',{name:label,exact:true}).count()===1,key+' inaccessible '+label);
 await capture(page,key+'-dataset-actions');await page.getByRole('button',{name:'Destroy dataset',exact:true}).click();await page.getByRole('button',{name:'Load fresh preview',exact:true}).click();await page.getByText('Synthetic reviewed deletion scope only',{exact:true}).waitFor();check(!await page.getByRole('checkbox',{name:'I reviewed the exact preview above and confirm this irreversible operation.',exact:true}).isChecked(),key+' destroy acknowledgment preselected');await capture(page,key+'-dataset-destroy');
 await navigate(page,'datasets');await page.locator('[data-node="/mnt/cache/a/ordinary"]').click();for(const label of ['Convert to dataset','Move / Rename','Delete directory'])check(await page.getByRole('button',{name:label,exact:true}).count()===1,key+' inaccessible '+label);await capture(page,key+'-directory-actions');
 const calls=await page.evaluate(()=>fixture.calls);check(calls.some(c=>c.cmd==='previewrestore'&&c.snapshot_guid==='123'),key+' restore must carry snapshot GUID');check(!calls.some(c=>['restoresnapshotfiles','destroydataset','deletedirectory'].includes(c.cmd)),key+' destructive endpoint was called');
}
async function navigate(page,screen){
 const direct=page.locator('.zfsm-global-nav [data-section="'+screen+'"]');
 if(await direct.count()){await direct.click();}
 else if(screen==='overview'){await page.locator('.zfsm-global-nav [data-section=protection]').click();await page.locator('[data-protection-screen=overview]').click();}
 else if(screen==='replication'){await page.locator('.zfsm-global-nav [data-section=protection]').click();await page.locator('[data-protection-screen=replication]').click();}
 if(phase==='before'&&screen==='protection')await page.locator('[data-protection-screen=policies]').click();
 await page.waitForTimeout(30);
}
async function policyTimesChecks(page,key){
 await navigate(page,'protection');await page.getByRole('button',{name:'New policy',exact:true}).click();const dialog=page.getByRole('dialog');await modalChecks(page,key+' creation clocks');
 const daily=dialog.locator('[data-snapshot-period=daily]');check(await daily.locator('[name=daily_time]').isVisible(),key+' daily creation clock hidden');check(await daily.locator('[name=daily_time]').inputValue()==='03:00',key+' new daily clock incorrect');
 await dialog.locator('[name=dataset]').selectOption('cache/a');const clock=daily.locator('[name=daily_time]');await clock.focus();await clock.press('ArrowLeft');await clock.press('ArrowLeft');await clock.press('Backspace');check(await clock.inputValue()==='',key+' partial clock silently reset');await clock.press('1');check(await clock.inputValue()==='01:00',key+' keyboard edit changed untouched minutes');await clock.fill('04:25');await dialog.getByRole('checkbox',{name:'Hourly',exact:true}).uncheck();for(const key of ['autosnap','autoprune','enabled'])check(await dialog.locator('[name='+key+']').evaluate(e=>e.closest('details')===null),key+' core control hidden '+key);await dialog.locator('[name=autoprune]').check();
 check(await dialog.locator('[data-policy-summary]').textContent().then(t=>t.includes('Daily at 04:25')&&t.includes('7 days')&&t.includes('delete expired snapshots after')),key+' live schedule unclear');await capture(page,key+'-policy-times');
 await dialog.getByRole('button',{name:'Review & create policy',exact:true}).click();const create=dialog.getByRole('button',{name:'Create policy',exact:true});await create.waitFor();await modalChecks(page,key+' clock review');
 check(await create.evaluate(e=>{const r=e.getBoundingClientRect();return e===document.activeElement&&r.top>=0&&r.bottom<=innerHeight;}),key+' create action focus/visibility');
 check(await dialog.locator('[data-review-policy-summary]').textContent().then(t=>t.includes('Daily at 04:25')&&t.includes('7 days')&&t.includes('delete expired snapshots after')),key+' reviewed schedule differs');
 const payload=await page.evaluate(()=>fixture.calls.findLast(c=>c.cmd==='protectionpolicypreview').data);check(payload.daily_hour==='4'&&payload.daily_min==='25'&&payload.schedule==='* * * * *'&&payload.autoprune==='1'&&!Object.hasOwn(payload,'daily_time')&&!Object.hasOwn(payload,'hourly_enabled'),key+' native payload incorrect');await capture(page,key+'-policy-times-review');
 await dialog.getByRole('button',{name:'Back to settings',exact:true}).click();check(await daily.locator('[name=daily_time]').inputValue()==='04:25',key+' Back lost clock');await daily.getByRole('button',{name:'Use inherited time',exact:true}).click();check(await daily.locator('[name=daily_time]').inputValue()==='23:59',key+' inherited clock not restored');
 if(key==='light-1280-tree'){
  await dialog.getByText('More periods',{exact:true}).click();await dialog.locator('[name=weekly_enabled]').check();await dialog.locator('[name=weekly]').fill('4');check(await dialog.locator('[name=weekly]').evaluate(e=>e===document.activeElement),key+' typing focus lost');await dialog.locator('[name=weekly_time]').fill('05:15');await dialog.locator('[name=weekly_day]').selectOption('2');await dialog.locator('[name=monthly_enabled]').check();await dialog.locator('[name=monthly]').fill('3');await dialog.locator('[name=monthly_day]').selectOption('12');await dialog.locator('[name=yearly_enabled]').check();await dialog.locator('[name=yearly]').fill('2');await dialog.locator('[name=yearly_month]').selectOption('6');await dialog.locator('[name=yearly_day]').selectOption('20');await dialog.locator('[name=frequently_enabled]').check();await dialog.locator('[name=frequently]').fill('8');await dialog.locator('[name=frequent_interval]').selectOption('15');await dialog.locator('[name=dataset]').focus();
  for(const [name,value]of [['weekly_day','2'],['monthly_day','12'],['yearly_month','6'],['yearly_day','20']])check(await dialog.locator('[name='+name+']').inputValue()===value,key+' calendar selection reverted: '+name);await capture(page,key+'-all-periods');
  await dialog.getByRole('button',{name:'Review & create policy',exact:true}).click();await dialog.getByRole('button',{name:'Create policy',exact:true}).waitFor();const calendar=await page.evaluate(()=>fixture.calls.findLast(c=>c.cmd==='protectionpolicypreview').data);for(const [name,value]of [['weekly_wday','2'],['weekly_hour','5'],['weekly_min','15'],['monthly_mday','12'],['yearly_mon','6'],['yearly_mday','20'],['frequent_period','15']])check(calendar[name]===value,key+' wrong native calendar payload '+name);
 }
 const g=await geometry(page);check(g.scrollWidth<=g.width,key+' page overflow');results.push({key,...g});await page.keyboard.press('Escape');
}
try{
 if(phase==='reference'){
  for(const theme of ['unraid','black','gray','white','azure'])for(const width of [390,768,1280,1920])for(const layout of ['workspace','compact']){
   const page=await browser.newPage({viewport:{width,height:1000}});page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.abort());await page.setContent(prototype);
   await page.locator('[data-theme-select]').selectOption(theme);await page.locator('[data-view='+layout+']').click();
   for(const screen of screens){await page.locator('nav [data-page='+screen+']:visible').click();results.push({theme,width,layout,screen,...await geometry(page)});await capture(page,`${theme}-${width}-${layout}-${screen}`);}
   if(theme==='white'&&layout==='workspace'&&[390,1280].includes(width)){for(const modal of ['policy','replication']){await page.locator('nav [data-page='+(modal==='policy'?'protection':'replication')+']:visible').click();await page.locator('[data-modal='+modal+']').first().click();await capture(page,`${theme}-${width}-${layout}-${modal}-dialog`);await page.keyboard.press('Escape');}}
   await page.close();console.log(`REFERENCE ${theme} ${width} ${layout}`);
  }
 }else{
  const themes=phase==='before'?['light']:(process.env.ZFSM_THEMES?.split(',')||['auto','dark','gray','light','azure']),widths=phase==='before'?[390,1280]:(process.env.ZFSM_WIDTHS?.split(',').map(Number)||[390,768,1280,1920]);
  for(const theme of themes)for(const width of widths)for(const layout of ['tree','table']){
   const page=await browser.newPage({viewport:{width,height:1000}});page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.abort());await setup(page,theme,width,layout);
   if(policyTimesOnly){const key=`${theme}-${width}-${layout}`;await policyTimesChecks(page,key);await page.evaluate(()=>zfsm_workspace.stop());await page.close();console.log('POLICY TIMES '+key);continue;}
   for(const screen of screens){await navigate(page,screen);const key=`${theme}-${width}-${layout}-${screen}`,g=await geometry(page);results.push({theme,width,layout,screen,...g});check(g.scrollWidth<=width,key+' page overflow '+g.scrollWidth);await capture(page,key);
    if(phase==='after'){
     check(await page.locator('.zfsm-global-nav').count()===1,key+' duplicate primary nav');check(await page.getByRole('navigation',{name:'Data Protection sections',exact:true}).count()===0,key+' nested protection nav');
     if(['overview','protection','replication'].includes(screen))check(await page.locator('.zfsm-dashboard-metric,.zfsm-protection-metrics>.zfsm-protection-card').count()<=3,key+' more than three metrics');
     if(screen==='protection'||screen==='replication')await listChecks(page,key,layout,width,screen==='protection'?'policy':'replication');
    }
   }
   const prefix=`${theme}-${width}-${layout}`;
   await navigate(page,'protection');await page.getByRole('button',{name:'New policy',exact:true}).click();await page.getByRole('dialog').waitFor();await capture(page,prefix+'-policy-dialog');
   if(phase==='after'){
    await modalChecks(page,prefix+' policy');check(await page.getByRole('dialog').getByText('Advanced',{exact:true}).evaluate(e=>!e.parentElement.open),prefix+' policy Advanced expanded');
    await page.getByRole('combobox',{name:'Dataset',exact:true}).selectOption('cache/a');await page.getByRole('button',{name:'Review & create policy',exact:true}).click();await page.getByRole('button',{name:'Create policy',exact:true}).waitFor();await modalChecks(page,prefix+' policy review');check(await page.getByRole('button',{name:'Create policy',exact:true}).evaluate(e=>{const r=e.getBoundingClientRect();return e===document.activeElement&&r.top>=0&&r.bottom<=innerHeight;}),prefix+' Create policy focus/visibility');check(!await page.getByRole('combobox',{name:'Dataset',exact:true}).isVisible(),prefix+' policy inputs hidden during review');await capture(page,prefix+'-policy-preview');await page.getByRole('button',{name:'Back to settings',exact:true}).click();await page.getByRole('textbox',{name:'Policy name',exact:true}).fill('Changed after review');check(await page.getByRole('button',{name:'Create policy',exact:true}).count()===0,prefix+' stale policy preview save');
   }
   await page.keyboard.press('Escape');if(phase==='after')check(await page.getByRole('button',{name:'New policy',exact:true}).evaluate(e=>e===document.activeElement),prefix+' policy focus not restored');
   await navigate(page,'replication');await page.getByRole('button',{name:'New replication',exact:true}).click();await page.getByRole('dialog').waitFor();await capture(page,prefix+'-wizard-source');
   if(phase==='after'){
    await modalChecks(page,prefix+' wizard');assert.deepEqual(await page.locator('[data-wizard-stage]').allTextContents(),['Source','Destination','Schedule','Review']);
    await page.getByRole('combobox',{name:'Source dataset',exact:true}).selectOption('cache/a');await page.getByRole('button',{name:'Next',exact:true}).click();await capture(page,prefix+'-wizard-destination');await page.getByRole('textbox',{name:'Destination dataset',exact:true}).fill('backup/project');await page.getByRole('button',{name:'Next',exact:true}).click();await capture(page,prefix+'-wizard-schedule');
    await page.evaluate(()=>fixture.failPreview=true);await page.getByRole('button',{name:'Review & create replication',exact:true}).click();await page.getByText('Synthetic connection lost',{exact:true}).waitFor();check(await page.getByRole('button',{name:'Create replication',exact:true}).count()===0,prefix+' save after connection loss');await page.evaluate(()=>fixture.failPreview=false);
    await page.getByRole('button',{name:'Review & create replication',exact:true}).click();await page.getByRole('button',{name:'Create replication',exact:true}).waitFor();check(await page.getByRole('button',{name:'Create replication',exact:true}).evaluate(e=>{const r=e.getBoundingClientRect();return e===document.activeElement&&r.top>=0&&r.bottom<=innerHeight;}),prefix+' Create replication focus/visibility');await capture(page,prefix+'-wizard-review');await modalChecks(page,prefix+' wizard review');await page.getByRole('button',{name:'Back',exact:true}).click();check(await page.getByRole('button',{name:'Create replication',exact:true}).count()===0,prefix+' stale wizard save after Back');
   }
   await page.keyboard.press('Escape');
   if(phase==='after')await legacyChecks(page,prefix);
   if(phase==='before')await legacyBeforeChecks(page,prefix);
   await page.evaluate(()=>zfsm_workspace.stop());await page.close();console.log(`${phase.toUpperCase()} ${theme} ${width} ${layout}`);
  }
  if(phase==='after'&&!policyTimesOnly)for(const gate of ['missing','disabled','untrusted']){
   const page=await browser.newPage({viewport:{width:1280,height:1000}});page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.abort());await setup(page,'light',1280,'tree',gate);
   for(const screen of ['protection','replication'])check(!await page.locator('.zfsm-global-nav [data-section='+screen+']').isVisible(),gate+' active '+screen+' navigation');await navigate(page,'settings');check(await page.getByRole('heading',{name:'Sanoid / Syncoid Integration',exact:true}).count()===1,gate+' diagnostics inaccessible');check(!(await page.evaluate(()=>fixture.calls)).some(c=>c.cmd==='protectiondata'),gate+' queried gated data');await capture(page,'gate-'+gate);await page.evaluate(()=>zfsm_workspace.stop());await page.close();
  }
  if(phase==='after')for(const hostWidth of [700,900]){
   const page=await browser.newPage({viewport:{width:1280,height:1000}});page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.abort());await setup(page,'light',1280,'tree');await page.locator('#zfsm-workspace').evaluate((e,width)=>{e.style.width=width+'px';e.style.maxWidth=width+'px';},hostWidth);
   for(const screen of ['protection','replication','datasets']){await navigate(page,screen);const key='embedded-'+hostWidth+'-'+screen;const g=await geometry(page);results.push({theme:'light',width:1280,hostWidth,layout:'tree',screen,...g});check(g.scrollWidth<=1280,key+' global overflow');const host=await page.locator('#zfsm-workspace').evaluate(e=>({scroll:e.scrollWidth,client:e.clientWidth}));check(host.scroll<=host.client+1,key+' plugin overflow '+JSON.stringify(host));await capture(page,key);if(screen!=='datasets'){check(await page.locator('[data-protection-inspector]:visible').count()===0,key+' narrow host inspector persists');await page.locator('[data-definition-id]').first().press('Enter');await modalChecks(page,key+' selection');await capture(page,key+'-selected');await page.keyboard.press('Escape');}}
   await page.evaluate(()=>zfsm_workspace.stop());await page.close();
  }
 }
}catch(error){failures.push('Harness stopped: '+String(error.stack||error));throw error;}finally{await browser.close();await writeFile(out+'/results.json',JSON.stringify({phase,source,hashes,prototypeSha256:createHash('sha256').update(prototype).digest('hex'),results,errors,failures,scope:'Offline actual frontend scripts/CSS in Chromium; synthetic backend only. No server, SSH, native ZFS or deployment.'},null,2)+'\n');}
assert.deepEqual(errors,[],'Browser errors');
if(phase==='after')assert.deepEqual(failures,[],'Visual geometry checks');
console.log(`Evidence ${out}/results.json (${results.length} screens; ${failures.length} failures)`);
