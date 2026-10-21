import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
async function workspace(){
 const dom=new JSDOM('<main></main>',{url:'http://fixture.local/?section=jobs',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,root=w.document.querySelector('main');let poll,fail=false,inventoryRequests=0;
 w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.scrollTo=()=>{};w.ResizeObserver=class{observe(){}disconnect(){}};w.zfsmFormatDateTime=x=>String(x);w.setTimeout=(fn,ms)=>{if(ms===2500)poll=fn;return 1;};w.clearTimeout=()=>{};
 for(const file of ['ZFSMInventory.js','ZFSMForms.js','ZFSMSnapshots.js','ZFSMExplorer.js','ZFSMPoolView.js','ZFSMOverview.js','ZFSMHistory.js','ZFSMWorkspace.js'])w.eval(readFileSync('src/frontend/'+file,'utf8'));
 const jobs=[{id:'20261018-120000-000000000001',schema:2,type:'archive',state:'failed',stage:'copying',source:'ZIP fixture',error:'Synthetic copy failure',actions:{},stage_history:[{at:'2026-10-18T10:00:00+00:00',state:'queued',stage:'planned',attempt:0},{at:'2026-10-18T10:01:00+00:00',state:'running',stage:'copying',attempt:1},{at:'2026-10-18T10:02:00+00:00',state:'failed',stage:'copying',attempt:1}],stage_history_complete:true,stage_history_dropped:4,credentials:{api_key:'must-remain-secret'}},{id:'20261018-120000-000000000002',schema:2,type:'restore',state:'completed',stage:'completed',source:'Legacy fixture',actions:{}}];
 const app=w.zfsmCreateWorkspace({root,config:{refresh_interval:0},request:async fields=>{if(fields.cmd==='conversionjobs'){if(fail)throw Error('fixture unavailable');return {jobs,worker_running:false};}if(fields.cmd==='inventory'){inventoryRequests++;return {op:'getAll',data:{pools:{},datasets:{},devices:{},errors:{}}};}throw Error(fields.cmd);}});
 for(let i=0;i<80;i++)await Promise.resolve();return {w,root,jobs,get inventoryRequests(){return inventoryRequests;},fail(){fail=true;},poll:async()=>{await poll();for(let i=0;i<50;i++)await Promise.resolve();},close(){app.stop();w.close();}};
}
test('all operation types identify the action and show honest progress and a visible result',async()=>{
 const x=await workspace();try{
  const j=x.jobs[0];Object.assign(j,{schema:7,type:'operation',label:'Create snapshots',command:'snapshotdataset',state:'running',stage:'executing_operation',source:'cache/data',execution_active:true,progress:{percent:null}});delete j.error;await x.poll();let row=x.root.querySelector('[data-job-id]');assert.match(row.querySelector('summary').textContent,/Create snapshots.*cache\/data/);assert.equal(row.querySelector('progress').hasAttribute('value'),false);assert.equal(row.querySelector('progress').getAttribute('aria-label'),'Operation progress');
  Object.assign(j,{type:'download',label:'Download snapshot file',progress:{percent:25,bytes:25,total:100},stage:'transferring'});await x.poll();row=x.root.querySelector('[data-job-id]');assert.equal(row.querySelector('progress').value,25);assert.match(row.querySelector('summary').textContent,/25 B \/ 100 B/);assert.equal(row.querySelector('progress').getAttribute('aria-label'),'Download progress');
  Object.assign(j,{state:'completed',stage:'completed',progress:{percent:100,bytes:100,total:100},result:{summary:'Server transfer finished. Check browser Downloads to confirm the file was saved.'}});await x.poll();row=x.root.querySelector('[data-job-id]');assert.equal(row.querySelector('details').open,false);assert.ok(row.querySelector('[data-operation-result]'));assert.equal(row.querySelector('[data-operation-result]').closest('details'),null);assert.match(row.textContent,/Check browser Downloads/);assert.equal(row.querySelector('[role=status]').textContent,'✓ Completed');
  const choices=[...x.root.querySelector('[aria-label="Filter jobs"]').options].map(o=>o.value);for(const type of ['operation','download','maintenance'])assert.ok(choices.includes(type));
 }finally{x.close();}
});
test('deletion Jobs show real directory counters, indeterminate ZFS stages and verified outcomes without opening technical details',async()=>{
 const x=await workspace();try{
  const job=x.jobs[0];Object.assign(job,{schema:6,type:'deletion',kind:'directory',state:'running',stage:'deleting',source:'/mnt/cache/test',actions:{cancel:false,resume:false},progress:{stage:'deleting',removed:4,total:10}});delete job.error;await x.poll();
  let row=x.root.querySelector('[data-job-id]'),bar=row.querySelector('progress');assert.equal(bar.value,40);assert.equal(bar.getAttribute('aria-label'),'Deletion progress');assert.match(row.querySelector('summary').textContent,/Delete directory.*4 \/ 10 objects deleted/);assert.equal(row.querySelectorAll('button').length,1);assert.equal(row.querySelector('details').open,false);
  job.kind='dataset';job.progress={stage:'deleting'};await x.poll();row=x.root.querySelector('[data-job-id]');assert.equal(row.querySelector('progress').hasAttribute('value'),false);assert.match(row.querySelector('summary').textContent,/Deleting reviewed ZFS objects/);
  Object.assign(job,{state:'failed',stage:'verifying',error:'Dataset is busy; release its mount.',result:{summary:'1 reviewed object deleted; 1 remains.'}});await x.poll();row=x.root.querySelector('[data-job-id]');assert.match(row.querySelector('summary').textContent,/Dataset is busy/);assert.equal(row.querySelector('details').open,false);assert.equal(row.querySelector('[data-deletion-result]').parentElement,row);assert.equal(row.querySelector('[data-deletion-result]').previousElementSibling.tagName,'DETAILS');
 }finally{x.close();}
});
test('Jobs inspect renders only captured chronological stages, attempt context and explicit incomplete/truncated history',async()=>{
 const x=await workspace();try{
  const rows=x.root.querySelectorAll('[data-job-id]'),timeline=rows[0].querySelector('[data-stage-history]');assert.ok(timeline,'Job inspect needs a stage timeline');
  assert.deepEqual([...timeline.querySelectorAll('li')].map(li=>li.textContent),['2026-10-18T10:00:00+00:00 · Before first attempt · queued · planned','2026-10-18T10:01:00+00:00 · Attempt 1 · running · copying','2026-10-18T10:02:00+00:00 · Attempt 1 · failed · copying']);
  assert.match(rows[0].querySelector('details').textContent,/4 earlier stage events omitted/);assert.match(rows[1].querySelector('details').textContent,/Stage history: Unknown/);assert.equal(rows[1].querySelectorAll('[data-stage-history] li').length,0);
  rows[0].querySelector('details').open=true;rows[0].querySelector('summary').focus();await x.poll();assert.equal(x.root.querySelector('[data-job-id] details').open,true);assert.equal(x.w.document.activeElement.tagName,'SUMMARY');
 }finally{x.close();}
});
test('Jobs exposes status and errors, preserves keyboard Copy focus across polls and copies redacted timeline',async()=>{
 const x=await workspace();try{
  let row=x.root.querySelector('[data-job-id]');assert.match(row.querySelector('[role=status]').textContent,/failed.*copying/);assert.match(row.querySelector('[role=alert]').textContent,/Synthetic copy failure/);
  const copy=[...row.querySelectorAll('button')].find(b=>b.textContent==='Copy');assert.match(copy.getAttribute('aria-label'),/Copy job .*000000000001/);copy.focus();await x.poll();assert.equal(x.w.document.activeElement.getAttribute('aria-label'),copy.getAttribute('aria-label'));
  x.w.document.activeElement.click();for(let i=0;i<30;i++)await Promise.resolve();row=x.root.querySelector('[data-job-id]');const fallback=row.querySelector('[data-copy-fallback]');assert.match(fallback.value,/stage_history/);assert.doesNotMatch(fallback.value,/must-remain-secret/);await x.poll();assert.equal(x.w.document.activeElement,fallback);
  x.fail();await x.poll();assert.match(x.root.querySelector('[role=alert]').textContent,/Job status unavailable/);
 }finally{x.close();}
});
test('Conversion progress omits absent rate/ETA without losing known values or ZIP byte counters',async()=>{
 const x=await workspace();try{
  const job=x.jobs[0];Object.assign(job,{type:'conversion',state:'completed',stage:'complete_source_retained',progress:{percent:100}});delete job.error;await x.poll();let progress=x.root.querySelector('[data-job-id] progress');assert.equal(progress.nextElementSibling.textContent,'100%');
  job.progress={percent:43,rate:'2 MiB/s',remaining:'00:00:20'};await x.poll();progress=x.root.querySelector('[data-job-id] progress');assert.equal(progress.nextElementSibling.textContent,'43% · 2 MiB/s · 00:00:20');
  job.progress={percent:43,rate:'2 MiB/s',remaining:'   '};await x.poll();assert.equal(x.root.querySelector('[data-job-id] progress').nextElementSibling.textContent,'43% · 2 MiB/s');
  Object.assign(job,{type:'archive',bytes:8,progress:{percent:50,bytes:4}});await x.poll();assert.equal(x.root.querySelector('[data-job-id] progress').nextElementSibling.textContent,'50% · 4 B / 8 B');
 }finally{x.close();}
});
test('active job progress and failed-job reason stay visible while technical details are collapsed',async()=>{
 const x=await workspace();try{
  let row=x.root.querySelector('[data-job-id]');assert.equal(row.querySelector('details').open,false);assert.ok(row.querySelector('[role=alert]').closest('summary'));
  Object.assign(x.jobs[0],{type:'conversion',state:'running',stage:'copying',progress:{percent:25}});delete x.jobs[0].error;await x.poll();row=x.root.querySelector('[data-job-id]');
  assert.ok(row.querySelector('progress').closest('summary'));assert.equal(row.querySelector('progress').value,25);
  x.jobs[0].progress.percent=73;await x.poll();assert.equal(x.root.querySelector('[data-job-id] progress').value,73);
  delete x.jobs[0].progress;x.jobs[0].state='queued';await x.poll();const waiting=x.root.querySelector('[data-job-id] progress');assert.equal(waiting.hasAttribute('value'),false);assert.ok(waiting.closest('summary'));
 }finally{x.close();}
});
test('verified copy completion shows 100% with explicit ongoing verification, never a completed conversion',async()=>{
 const x=await workspace();try{
  Object.assign(x.jobs[0],{type:'conversion',state:'running',stage:'copying',progress:{percent:99,stage:'verifying'}});delete x.jobs[0].error;await x.poll();let row=x.root.querySelector('[data-job-id]');
  assert.equal(row.querySelector('progress').value,100);assert.match(row.querySelector('progress').nextElementSibling.textContent,/Copying: 100%.*Verifying files/);assert.match(row.querySelector('[role=status]').textContent,/running.*Verifying/);assert.doesNotMatch(row.querySelector('summary').textContent,/✓|completed/);assert.ok(row.querySelector('progress').closest('summary'));
  for(const stage of ['copy_verified','claiming','source_retained','reserving','reserved','mountpoint_pending','publishing','published']){x.jobs[0].stage=stage;delete x.jobs[0].progress;await x.poll();row=x.root.querySelector('[data-job-id]');assert.equal(row.querySelector('progress').value,100);assert.match(row.querySelector('summary').textContent,/Copying: 100%/);assert.doesNotMatch(row.querySelector('summary').textContent,/✓|completed/);if(stage==='source_retained')assert.match(row.querySelector('summary').textContent,/Verifying retained original/);}
  x.jobs[0].state='failed';x.jobs[0].error='Verification failed';await x.poll();row=x.root.querySelector('[data-job-id]');assert.match(row.querySelector('[role=alert]').textContent,/Verification failed/);assert.doesNotMatch(row.querySelector('summary').textContent,/Verifying files|Copying: 100%|✓/);
 }finally{x.close();}
});

test('finished deletion refreshes stale inventory exactly once even when automatic refresh is disabled',async()=>{
 const x=await workspace();try{const job=x.jobs[0];Object.assign(job,{schema:6,type:'deletion',kind:'directory',state:'running',stage:'deleting',actions:{}});await x.poll();const before=x.inventoryRequests;job.state='failed';job.stage='verifying';await x.poll();assert.equal(x.inventoryRequests,before+1);await x.poll();assert.equal(x.inventoryRequests,before+1);}finally{x.close();}
});
