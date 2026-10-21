import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {startMock,lab} from './mock-server.mjs';

const require=createRequire(import.meta.url),{chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const output=process.env.ZFSM_METADATA_OUTPUT||'evidence/testhost-directories-2026-10-18/metadata-gui';
await mkdir(output+'/screenshots',{recursive:true});
const mock=await startMock(),browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true});
const project=lab+'/project',results=[],issues=[],external=[],screenshots=[],measurements=[],readOnly=new Set(['inventory','inventorysnapshots','pooldiagnostics','getdatasetproperties','conversionjobs','auditlog']);
let context,page;
const longPath='/mnt/'+project+'/'+Array.from({length:6},(_,i)=>'component-'+i+'-'+('long-unbroken-name-'.repeat(10))).join('/');
function seedMetadata(model){
 const dataset=model.find(project);
 Object.assign(dataset,{acltype:'posix',aclmode:'passthrough',aclinherit:'restricted',_sources:{acltype:'local',aclmode:'inherited from cache',aclinherit:'default'},
  _permissions:{status:'known',owner:'nobody',group:'users',uid:'99',gid:'100',mode:'2770',reason:''},
  _usage:{smb:{status:'known',entries:[{name:'Project media',path:'/mnt/'+project+'/media'}],reason:''},nfs:{status:'known',entries:[],reason:''},docker:{status:'unknown',entries:[{name:'indexer-service',state:'running',path:longPath,destination:'/application/persistent-data'}],reason:'Some configured paths could not be assigned to a verified ZFS mount'},vm:{status:'unavailable',entries:null,reason:'Trusted Libvirt client is unavailable'}},
  _acl:{status:'known',type:'posix',extended:true,has_default:true,reason:'',entries:[
   {scope:'access',tag:'user',id:null,permissions:'rwx',effective:'rwx',masked:false},
   {scope:'access',tag:'user',id:'1000',permissions:'rwx',effective:'r-x',masked:true},
   {scope:'access',tag:'group',id:null,permissions:'rwx',effective:'r-x',masked:true},
   {scope:'access',tag:'mask',id:null,permissions:'r-x',effective:'r-x',masked:false},
   {scope:'access',tag:'other',id:null,permissions:'---',effective:'---',masked:false},
   {scope:'default',tag:'user',id:null,permissions:'rwx',effective:'rwx',masked:false},
   {scope:'default',tag:'group',id:null,permissions:'r-x',effective:'r--',masked:true},
   {scope:'default',tag:'mask',id:null,permissions:'r--',effective:'r--',masked:false},
   {scope:'default',tag:'other',id:null,permissions:'---',effective:'---',masked:false}]}});
 const job=model.jobs[0];Object.assign(job,{stage:'verifying',stage_history_complete:true,stage_history_dropped:2,stage_history:[
  {at:'2026-10-18T10:00:00+00:00',state:'queued',stage:'planned',attempt:0},
  {at:'2026-10-18T10:01:00+00:00',state:'running',stage:'copying',attempt:1},
  {at:'2026-10-18T10:02:00+00:00',state:'running',stage:'verifying',attempt:1}]});
}
async function fresh(width){
 if(context)await context.close();mock.reset();seedMetadata(mock.model);
 context=await browser.newContext({viewport:{width,height:width===390?844:1000},hasTouch:width<=768});page=await context.newPage();page.setDefaultTimeout(6000);
 page.on('pageerror',error=>issues.push({case:results.length+1,message:error.message}));
 await context.route('**/*',route=>{if(route.request().url().startsWith(mock.url))return route.continue();external.push(route.request().url());return route.abort();});
 await page.goto(mock.url);await page.locator('[data-node="'+project+'"]').waitFor();
 await page.locator('[data-node="'+project+'"]').click();await page.getByRole('button',{name:'Overview',exact:true}).click();
}
async function check(name,run){
 if(process.env.ZFSM_METADATA_CASE&&!name.includes(process.env.ZFSM_METADATA_CASE))return;
 const started=Date.now();try{await run();results.push({name,status:'PASS',ms:Date.now()-started});console.log('PASS '+name);}
 catch(error){results.push({name,status:'FAIL',error:error.message,ms:Date.now()-started});console.log('FAIL '+name+': '+error.message.split('\n')[0]);if(page&&!page.isClosed())await shot('failure-'+results.length).catch(()=>{});}
}
async function shot(name,locator){
 const file=name+'.png',original=page.viewportSize();let captureViewport=original,expandedViewport=false;
 try{
  if(locator){
   const requiredHeight=await locator.evaluate(element=>{let height=0;for(let ancestor=element.parentElement;ancestor;ancestor=ancestor.parentElement){if(['auto','scroll'].includes(getComputedStyle(ancestor).overflowY)&&ancestor.scrollHeight>ancestor.clientHeight+1)height=Math.max(height,ancestor.scrollHeight+500);}return height;});
   if(requiredHeight>original.height){await page.setViewportSize({width:original.width,height:Math.ceil(requiredHeight)});expandedViewport=true;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
   await locator.scrollIntoViewIfNeeded();
   const visible=await locator.evaluate(element=>{const rect=element.getBoundingClientRect();for(let ancestor=element.parentElement;ancestor;ancestor=ancestor.parentElement){const style=getComputedStyle(ancestor);if(['auto','scroll','hidden','clip'].includes(style.overflowY)){const bounds=ancestor.getBoundingClientRect();if(rect.top<bounds.top-1||rect.bottom>bounds.bottom+1)return false;}}return true;});
   assert.equal(visible,true,'Full-height element screenshot must not be clipped by an ancestor');
   captureViewport=page.viewportSize();await locator.screenshot({path:output+'/screenshots/'+file});
  }else await page.screenshot({path:output+'/screenshots/'+file,fullPage:true});
 }finally{if(expandedViewport)await page.setViewportSize(original);}
 screenshots.push({name,file,kind:locator?'element full height':'full page',viewport:captureViewport,originalViewport:original,expandedViewport});
}
async function noOverflow(name){
 const metric=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,body:document.body.scrollWidth}));
 measurements.push({name,...metric});assert.ok(metric.document<=metric.client+1,'Document overflow: '+JSON.stringify(metric));
}
function assertReadOnly(){assert.deepEqual(mock.model.calls.filter(call=>!readOnly.has(call.cmd)).map(call=>call.cmd),[],'Metadata review must issue read-only commands only');}
try{
 for(const width of [390,768,1280,1920])for(const theme of ['auto','dark','gray','light','azure'])for(const layout of ['Workspace','Compact table']){
  const name=width+'-'+theme+'-'+(layout==='Workspace'?'workspace':'compact');
  await check(name+' read-only service metadata and expanded ACL',async()=>{
   await fresh(width);await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(theme);await page.getByRole('button',{name:layout,exact:true}).click();
   await page.getByRole('button',{name:'Overview',exact:true}).click();
   const usage=page.locator('.zfsm-overview-card').filter({has:page.getByRole('heading',{name:'Usage & Permissions',exact:true})});
   await usage.getByText('Extended POSIX ACL with default entries',{exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>zfsm_workspace.getState().selection),project);
   const text=await usage.innerText();for(const phrase of ['SMB: 1 configured use','NFS: No configured use found','Docker: Unknown','VM: Not available','nobody / users','2770','Docker: verified references shown; discovery is incomplete.','Some configured paths could not be assigned to a verified ZFS mount','Trusted Libvirt client is unavailable',longPath])assert.ok(text.includes(phrase),'Missing '+phrase);
   assert.equal(await usage.locator('button,input,select,textarea').count(),0,'Usage and ACL card has no write controls');
   await usage.getByText('View ACL entries',{exact:true}).click();assert.equal(await usage.locator('details').evaluate(element=>element.open),true);
   assert.equal(await usage.locator('table tbody tr').count(),9);assert.match(await usage.locator('table tbody tr').nth(1).innerText(),/access\s+user\s+1000\s+rwx\s+r-x\s+Yes/);
   const aclGeometry=await usage.locator('table').evaluate(table=>[...table.querySelectorAll('tr')].map(row=>({height:row.getBoundingClientRect().height,cells:[...row.children].map(cell=>{const style=getComputedStyle(cell),range=document.createRange();range.selectNodeContents(cell);return{text:cell.textContent,whiteSpace:style.whiteSpace,lines:[...range.getClientRects()].filter(rect=>rect.width>0&&rect.height>0).length,singleLineHeight:parseFloat(style.lineHeight)+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)+parseFloat(style.borderTopWidth)+parseFloat(style.borderBottomWidth)};})})));
   for(const row of aclGeometry){for(const cell of row.cells){assert.equal(cell.whiteSpace,'nowrap','Short ACL token must not wrap: '+cell.text);assert.ok(cell.lines<=1,'ACL cell occupies multiple text lines: '+cell.text);}assert.ok(row.height<=Math.max(...row.cells.map(cell=>cell.singleLineHeight))+2,'ACL row exceeds one text line plus cell padding');}
   assert.match(await usage.innerText(),/Default entries describe inheritance/);
   await noOverflow(name);assertReadOnly();
   const key=(layout==='Workspace'&&(width===390||width===1920))||(layout==='Compact table'&&((width===390&&theme==='dark')||(width===1280&&theme==='light')||(width===1920&&theme==='azure')))||(layout==='Workspace'&&width===768&&theme==='gray');
   if(key){await shot(name+'-overview');await shot(name+'-usage-acl',usage);}
   if(width===390&&theme==='dark'&&layout==='Workspace'){
    const wrap=usage.locator('.zfsm-table-wrap');await wrap.evaluate(element=>element.scrollLeft=element.scrollWidth);
    await noOverflow(name+'-acl-scroll-right');await shot(name+'-usage-acl-right-columns',usage);
   }
   assert.ok(mock.model.calls.some(call=>call.cmd==='getdatasetproperties'&&call.zdataset===project),'Existing metadata endpoint is exercised');
  });
 }
 for(const [width,theme] of [[390,'dark'],[768,'gray'],[1920,'light']])await check(width+' '+theme+' authoritative job stage history screenshot',async()=>{
  await fresh(width);await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(theme);await page.getByRole('button',{name:/^Jobs/}).click();
  const job=mock.model.jobs[0],row=page.locator('[data-job-id="'+job.id+'"]');await row.locator(':scope > details > summary').waitFor();await row.locator(':scope > details > summary').click();
  await row.getByRole('list',{name:'Recorded job stages',exact:true}).waitFor();assert.equal(await row.locator('[data-stage-history] li').count(),3);
  await row.getByText(/2 earlier stage events omitted/).waitFor();assert.doesNotMatch(await row.innerText(),/Stage history: Unknown/);
  assert.ok(await page.locator('[data-job-id]').filter({hasText:'Stage history: Unknown before recording began.'}).count()>0,'Legacy jobs retain their Unknown history notice');
  await noOverflow(width+'-'+theme+'-jobs');assertReadOnly();await shot(width+'-'+theme+'-jobs-recorded-stages');await shot(width+'-'+theme+'-job-card',row);
 });
}finally{if(context)await context.close();await browser.close();await mock.close();}
const report={created:new Date().toISOString(),scope:'Real Chromium and repository frontend against existing local mock server. Metadata and authoritative stage journal fixtures are synthetic; no live Unraid, ZFS, service discovery or deployment is claimed.',captureNote:'Full-height element captures temporarily increase viewport height when a desktop Compact table scroll-pane would clip the card. Width is preserved, source/CSS are unchanged by the capture helper, and original/capture viewport dimensions are recorded per image. Full-page captures retain the standard viewport.',git:{head:(process.env.ZFSM_SOURCE_REVISION||'working-tree'),dirty:execFileSync('git',['status','--porcelain','--','src','tests'],{encoding:'utf8'}).trim()!==''},matrix:{widths:[390,768,1280,1920],themeOptions:['auto','dark','gray','light','azure'],layouts:['Workspace','Compact table'],metadataCombinations:40,caseFilter:process.env.ZFSM_METADATA_CASE||null},results,issues,external,measurements,screenshots};
await writeFile(output+'/results.json',JSON.stringify(report,null,2)+'\n');
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const html='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Usage, ACL and stage history — Chromium evidence</title><style>body{max-width:1450px;margin:24px auto;padding:0 16px;background:#111820;color:#e4edf4;font:15px/1.5 system-ui}a{color:#80caff}h1,h2{line-height:1.2}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:7px;border-bottom:1px solid #405064}th{color:#a6bfd5}.pass{color:#89dfaf}.fail{color:#ff9d9d}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:18px}figure{margin:0;padding:12px;background:#1c2836;min-width:0}figure img{display:block;width:100%;height:auto;background:#17212c}figcaption{overflow-wrap:anywhere;margin-bottom:8px}p{overflow-wrap:anywhere}code{color:#b9d8ef}</style><h1>Usage, ACL and job stages</h1><p>'+escape(report.scope)+'</p><p><strong>'+results.filter(item=>item.status==='PASS').length+' / '+results.length+' PASS</strong> · '+issues.length+' browser errors · '+external.length+' external requests · <a href="results.json">Raw JSON report</a></p><p>Checked all 40 metadata combinations: four widths × five theme options × two layouts. ACL tables expanded in every case; long configured paths and partial/unknown/unavailable notices remain visible. Selected full-page views and full-height card screenshots appear below. The mobile dark ACL also has a right-column scroll capture.</p><h2>Checks</h2><table><thead><tr><th>Case</th><th>Result</th><th>Details</th></tr></thead><tbody>'+results.map(item=>'<tr><td>'+escape(item.name)+'</td><td class="'+(item.status==='PASS'?'pass':'fail')+'">'+escape(item.status)+'</td><td>'+escape(item.error||item.ms+' ms')+'</td></tr>').join('')+'</tbody></table><h2>Actual Chromium screenshots</h2><div class="gallery">'+screenshots.map(item=>'<figure><figcaption><a href="screenshots/'+encodeURIComponent(item.file)+'">'+escape(item.name)+'</a><br>'+escape(item.kind+' · '+item.viewport.width+' × '+item.viewport.height)+'</figcaption><a href="screenshots/'+encodeURIComponent(item.file)+'"><img loading="lazy" src="screenshots/'+encodeURIComponent(item.file)+'" alt="'+escape(item.name)+'"></a></figure>').join('')+'</div></html>';
await writeFile(output+'/index.html',html.replace('<h2>Checks</h2>','<p>'+escape(report.captureNote)+'</p><h2>Checks</h2>'));process.exitCode=results.some(item=>item.status!=='PASS')||issues.length||external.length?1:0;
