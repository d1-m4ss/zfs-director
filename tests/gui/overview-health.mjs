import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const out=process.env.ZFSM_OUTPUT||'evidence/plain-policy-2026-10-19/health';await mkdir(out,{recursive:true});
const names=['ZFSMInventory.js','ZFSMForms.js','ZFSMSnapshots.js','ZFSMExplorer.js','ZFSMPoolView.js','ZFSMOverview.js','ZFSMHistory.js','ZFSMProtection.js','ZFSMWorkspace.js','ZFSMWorkspace.css','ZFSMProtection.css'];
const sources=await Promise.all(names.map(n=>readFile('src/frontend/'+n,'utf8'))),hashes=Object.fromEntries(names.map((n,i)=>[n,createHash('sha256').update(sources[i]).digest('hex')]));
const browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true}),results=[],errors=[];
try{
 for(const theme of ['dark','gray','light','azure'])for(const mode of ['Workspace','Compact'])for(const severity of ['ok','warning','error','unknown'])for(const width of(theme==='light'?[390,1280]:[1280])){
  const page=await browser.newPage({viewport:{width,height:950}});page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.abort());await page.setContent('<style>body{margin:0;padding:12px;background:#ddd;font:13px Arial}</style><main id="zfsm-workspace"></main>');
  for(let i=0;i<names.length;i++)if(names[i].endsWith('.css'))await page.addStyleTag({content:sources[i]});else await page.addScriptTag({content:sources[i]});
  await page.evaluate(async severity=>{
   window.zfsmFormatDateTime=String;
   const health=severity==='error'?'DEGRADED':'ONLINE',row={name:'cache',state:health,health,read:'0',write:'0',cksum:'0'};
   const diagnostic={pool:'cache',health,severity,stale:false,reasons:severity==='warning'?['Capacity threshold reached']:severity==='unknown'?['Diagnostic result unavailable']:[],command_errors:[],status:{text:'Synthetic pool status',state:health,rows:[row]},information:{text:'Synthetic pool information',columns:['NAME','SIZE','ALLOC','FREE','CKPOINT','EXPANDSZ','FRAG','CAP','DEDUP','HEALTH','ALTROOT'],rows:[row]}};
   const dataset={name:'cache',guid:'1',type:'filesystem',mountpoint:'/mnt/cache',child:{},directories:[],snapshots:[]};
   window.app=zfsmCreateWorkspace({root:document.querySelector('main'),hostTheme:'white',config:{refresh_interval:0},request:async f=>{
    if(f.cmd==='inventory')return {op:'getAll',data:{pools:{cache:{Health:health,Size:100000,Used:25000}},datasets:{cache:dataset},devices:{cache:''},errors:{}}};
    if(f.cmd==='conversionjobs')return {jobs:[],counts:{active:0,completed:0,needs_attention:0},worker_running:true};
    if(f.cmd==='pooldiagnostics')return diagnostic;
    if(f.cmd==='protectiondetect')return {installed:false,visible:false,enabled:false,compatible:false,issues:[]};
    if(f.cmd==='getdatasetproperties')return dataset;
    throw Error('Unexpected fixture request '+f.cmd);
   }});await app.refresh();
  },severity);
  await page.getByRole('button',{name:'Overview',exact:true}).first().click();await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(theme);await page.getByRole('button',{name:mode,exact:true}).click();
  const label={ok:'Healthy',warning:'Warning',error:'Error',unknown:'Not checked'}[severity],badge=page.locator('[data-pool-health="cache"]');await badge.waitFor();assert.equal(await badge.getAttribute('data-severity'),severity);assert.match(await badge.innerText(),new RegExp(label));assert.equal(await badge.locator('[aria-hidden=true]').count(),1);assert.match(await page.locator('.zfsm-dashboard-metrics').innerText(),/Ready · No active jobs/);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  const color=await badge.evaluate(el=>getComputedStyle(el).color),icon=await badge.locator('[aria-hidden=true]').textContent();results.push({theme,mode,severity,width,label,icon,color});await page.screenshot({path:out+'/'+theme+'-'+width+'-'+mode.toLowerCase()+'-'+severity+'.png',fullPage:true});await page.evaluate(()=>app.stop());await page.close();
 }
 assert.deepEqual(errors,[]);for(const theme of ['dark','gray','light','azure']){const colors=results.filter(x=>x.theme===theme&&x.mode==='Workspace'&&x.width===1280).map(x=>x.color);assert.equal(new Set(colors).size,4,'health severity colors must be distinguishable: '+theme);}
}finally{await browser.close();await writeFile(out+'/results.json',JSON.stringify({hashes,results,errors,scope:'Offline actual frontend/CSS in Chromium; synthetic read-only diagnostics, no test-host access.'},null,2)+'\n');}
console.log('PASS '+results.length+' Overview health/worker visual states; four themes, both modes, mobile+desktop');
