import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url),{chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const out=process.env.ZFSM_OUTPUT||'backups/2026-11-09/pool-warning-links';await mkdir(out,{recursive:true});
const scripts=await Promise.all(['ZFSMDateTime','ZFSMInventory','ZFSMForms','ZFSMSnapshots','ZFSMExplorer','ZFSMPoolView','ZFSMOverview','ZFSMHistory','ZFSMProtection','ZFSMWorkspace'].map(name=>readFile('src/frontend/'+name+'.js','utf8'))),css=await readFile('src/frontend/ZFSMWorkspace.css','utf8'),protectionCSS=await readFile('src/frontend/ZFSMProtection.css','utf8');

const browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true}),results=[],errors=[];
async function open(width,section){
 const page=await browser.newPage({viewport:{width,height:1100}});page.setDefaultTimeout(5000);await page.route('**/*',r=>r.abort());page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<style>body{margin:12px;font:14px Arial;background:#202020;color:#eee}</style><main id="zfsm-workspace"></main>');await page.addStyleTag({content:css+protectionCSS});for(const content of scripts)await page.addScriptTag({content});
 await page.evaluate(()=>{
  window.zfsmDateTimeSettings={timeZone:'UTC',dateFormat:'%A, %d-%m-%Y',timeFormat:'%T'};
  const ds=(name,guid)=>({name,guid,type:'filesystem',mountpoint:'/mnt/'+name,encryption:'off',keystatus:'none',child:{},directories:[],snapshots:[]}),tree=ds('cache','1');
  const run=(outcome)=>({verified_outcome:outcome,finished_at:'2026-11-09T22:17:05Z',verification:{verified:true,lag_seconds:42}});
  window.selectorData={datasets:['cache/a','cache/b','backup/x'].map((name,i)=>({name,guid:String(10+i)})),
   policies:[{id:'p1',name:'Daily',owner:'managed',dataset:'cache/a',enabled:true,hourly:24,daily:7,last_job:run('up_to_date')},{id:'p2',name:'Fresh',owner:'managed',dataset:'cache/b',enabled:false,hourly:24,daily:7},{id:'p3',name:'sanoid',owner:'external',dataset:'cache/a',enabled:true}],
   replications:[{id:'r1',name:'Nightly',owner:'managed',source:'cache/a',target:'backup/x',mode:'local',schedule:'0 2 * * *',enabled:true,last_job:run('completed')},{id:'r2',name:'Paused',owner:'managed',source:'cache/b',target:'backup/x',mode:'local',schedule:'0 3 * * *',enabled:false}],
   jobs:[],templates:{},issues:[],credentials:[],scheduler:{external:[],issues:[]}};
  window.reasonText='Replication Nightly (r1) requires inspection; the latest run is not verified complete: Native transfer failed (exit 2).';
  window.diagnosticAnswer=name=>({pool:name,collected_at:'2026-11-10T12:00:00Z',health:'ONLINE',severity:'warning',reasons:[window.reasonText],reason_links:[{reason:window.reasonText,type:'replication',id:'r1'}],command_errors:[],
   status:{text:'  pool: '+name,state:'ONLINE',rows:[{name,state:'ONLINE',read:'0',write:'0',cksum:'0'}],scan:'none requested',errors:'No known data errors',status:'',action:''},
   information:{text:'',columns:['NAME','SIZE','ALLOC','FREE','CKPOINT','EXPANDSZ','FRAG','CAP','DEDUP','HEALTH','ALTROOT'],rows:[{name,size:'1000',alloc:'100',free:'900',health:'ONLINE'}]},
   scan:{state:'idle',kind:null,text:'none requested'},trim:{available:false,reason:'n/a'},capacity:{status:'unknown',percent:null},maintenance_history:{status:'known',entries:[]}});
  window.zfsm_workspace=zfsmCreateWorkspace({root:document.querySelector('main'),config:{refresh_interval:0,destructive_mode:1},request:async fields=>{if(fields.cmd==='inventory')return {op:'getAll',data:{pools:{cache:{Health:'ONLINE',Size:1000,Used:1}},datasets:{cache:tree},devices:{cache:''},errors:{}}};if(fields.cmd==='conversionjobs')return {jobs:[],worker_running:true};if(fields.cmd==='pooldiagnostics')return window.diagnosticAnswer(fields.pool);if(fields.cmd==='protectiondetect')return {visible:true,installed:true,enabled:true,compatible:true,state:'healthy',issues:[],sanoid:{version:'2.3.0'},syncoid:{version:'2.3.0'}};if(fields.cmd==='protectiondata')return structuredClone(selectorData);if(fields.cmd==='protectionrunpreview'){const snap=(name)=>({name,creation:1766949364,txg:'1'});return {preview_id:'e'.repeat(32),token:'signed',review:{type:'run',value:{type:'replication',id:'r1'},warnings:['No automatic rollback, foreign snapshot cleanup or destination deletion.'],inspection:{source:{'':{guid:'1',snapshots:{111:snap('2025-12-28-211604'),222:snap('autosnap_2026-11-09_20:17:05_daily')}},'/a-rather-long-child-dataset-name/library':{guid:'2',snapshots:{333:snap('2025-12-28-211604'),444:snap('autosnap_2026-11-09_20:17:05_daily')}}},target:{'':{guid:'9',snapshots:[]}},expected:{'':'222','/a-rather-long-child-dataset-name/library':'444'},blockers:[]}}};}throw Error('Unexpected command '+fields.cmd);}});
 });
 await page.locator('[data-section='+section+']').click();return page;
}

try{
 for(const width of [390,1280]){
  let page;
  try{
   page=await open(width,'overview');await page.setViewportSize({width,height:800});
   const why=page.locator('.zfsm-dashboard-reasons');await why.waitFor();
   assert.match(await why.innerText(),/Replication Nightly \(r1\) requires inspection/);
   assert.deepEqual(await why.getByRole('button').allTextContents(),['Open replication','Pool status'],'the overview explains the warning and offers both targets');
   await page.screenshot({path:out+'/'+width+'-overview.png'});
   // Header strip on the datasets screen.
   await page.locator('[data-section=datasets]').click();const strip=page.locator('.zfsm-attention');await strip.waitFor();
   assert.match(await strip.innerText(),/cache[\s\S]*Replication Nightly/);assert.equal(await strip.getByRole('button',{name:'Open replication'}).count(),1);
   await page.screenshot({path:out+'/'+width+'-header.png'});
   // Open replication lands on that job.
   await strip.getByRole('button',{name:'Open replication'}).click();
   await page.waitForFunction(()=>document.querySelector('tr[data-replication-id=r1].is-selected'),null,{timeout:5000});
   assert.equal(await page.locator('[data-section=replication]').getAttribute('aria-current'),'page');
   // Pool status lists the same reason with the same way out.
   await page.locator('[data-section=datasets]').click();await page.locator('.zfsm-attention').getByRole('button',{name:'Pool status'}).first().click();
   const status=page.locator('[data-severity=warning]').filter({hasText:'Replication Nightly'}).first();await status.waitFor();
   assert.equal(await status.getByRole('button',{name:'Open replication'}).count(),1);assert.equal(await status.getByRole('button',{name:'Pool status'}).count(),0,'already on the pool status');
   await page.screenshot({path:out+'/'+width+'-status.png'});
   results.push({width,status:'PASS'});
  }catch(e){results.push({width,status:'FAIL',error:e.stack});if(page&&!page.isClosed())await page.screenshot({path:out+'/FAIL-'+width+'.png'}).catch(()=>{});throw e;}finally{if(page&&!page.isClosed())await page.close().catch(()=>{});}
 }
}finally{await browser.close();await writeFile(out+'/results.json',JSON.stringify({results,errors,scope:'Actual offline Chromium Workspace; synthetic pool diagnostics. No test-host.'},null,2)+'\n');console.log(JSON.stringify({results,errors}));if(results.some(r=>r.status!=='PASS')||errors.length)process.exitCode=1;}
