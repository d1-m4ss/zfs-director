import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
async function workspace(suppliedJobs){
 const behaviour={deleteFails:false};
 const dom=new JSDOM('<main></main>',{url:'http://fixture.local/?section=jobs',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,root=w.document.querySelector('main'),requests=[];let poll;
 w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.scrollTo=()=>{};w.ResizeObserver=class{observe(){}disconnect(){}};w.zfsmFormatDateTime=x=>String(x);w.setTimeout=(fn,ms)=>{if(ms===2500)poll=fn;return 1;};w.clearTimeout=()=>{};
 for(const file of ['ZFSMInventory.js','ZFSMForms.js','ZFSMSnapshots.js','ZFSMExplorer.js','ZFSMPoolView.js','ZFSMOverview.js','ZFSMWorkspace.js'])w.eval(readFileSync('src/frontend/'+file,'utf8'));
 const jobs=suppliedJobs||[{id:'20261017-120000-000000000001',schema:2,type:'archive',state:'completed',stage:'complete',source:'ZIP fixture',archive_eligible:true,actions:{},metadata:{password:'[redacted]'}}];
 const app=w.zfsmCreateWorkspace({root,config:{refresh_interval:0},request:async fields=>{requests.push(fields);if(fields.cmd==='conversionjobs')return {jobs,worker_running:false};if(fields.cmd==='inventory')return {op:'getAll',data:{pools:{},datasets:{},devices:{},errors:{}}};if(fields.cmd==='activityvisibility')return {succeeded:{ok:'hidden'},failed:{}};if(fields.cmd==='deletefinishedjobs'&&behaviour.deleteFails)return {succeeded:{},failed:{jobs:'Disk is read-only'}};if(fields.cmd==='deletefinishedjobs')return {succeeded:{jobs:'Deleted 1 finished job record(s).'},failed:{}};throw Error(fields.cmd);}});
 for(let i=0;i<80;i++)await Promise.resolve();return {w,root,requests,behaviour,poll:async()=>{await poll();for(let i=0;i<50;i++)await Promise.resolve();},close(){app.stop();w.close();}};
}
test('Jobs requests global timeline, preserves expanded inspection across polling, offers all filters and bounded clear confirmation',async()=>{
 const x=await workspace();try{assert.equal(x.requests.find(r=>r.cmd==='conversionjobs').sort,'newest');const details=x.root.querySelector('[data-job-id] details');details.open=true;await x.poll();assert.equal(x.root.querySelector('[data-job-id] details').open,true);const status=x.root.querySelector('[aria-label="Job status"]'),type=x.root.querySelector('[aria-label="Job type"]');assert.deepEqual([...status.options].map(o=>o.value),['all','active','needs_attention','completed']);assert.deepEqual([...type.options].map(o=>o.value),['all','restore','archive','conversion','deletion','policy','replication']);assert.ok(x.root.querySelector('[aria-label="Everything, ignore the filters"]'),'one checkbox widens the delete to everything');assert.ok([...x.root.querySelectorAll('button')].find(b=>b.textContent==='Delete finished jobs'),'one delete button');for(const gone of ['Show archived','Clear finished','Restore hidden','Clear finished on this page','Restore archived on this page'])assert.equal([...x.root.querySelectorAll('button')].some(b=>b.textContent===gone),false,gone+' is gone');assert.equal(x.requests.some(r=>r.cmd==='deletefinishedjobs'),false,'nothing is deleted just by opening Jobs');}finally{x.close();}
});
test('Jobs Copy reports insecure clipboard failure with selectable redacted fallback',async()=>{
 const x=await workspace();try{const copy=[...x.root.querySelectorAll('[data-job-id] button')].find(b=>b.textContent==='Copy');assert.ok(copy);copy.click();for(let i=0;i<30;i++)await Promise.resolve();assert.match(x.root.querySelector('[data-job-id]').textContent,/Copy unavailable/);const fallback=x.root.querySelector('[data-job-id] textarea');assert.ok(fallback);assert.match(fallback.value,/\[redacted\]/);await x.poll();assert.equal(x.root.querySelector('[data-job-id] textarea')?.value,fallback.value);}finally{x.close();}
});
test('Delete finished jobs acts at once with the current filters; Everything ignores them; type filter uses the server',async()=>{
 const x=await workspace();try{
 const click=text=>[...x.root.querySelectorAll('button')].find(b=>b.textContent===text).click();click('Delete finished jobs');for(let i=0;i<300;i++)await Promise.resolve();
 const mutation=x.requests.find(r=>r.cmd==='deletefinishedjobs');assert.deepEqual(JSON.parse(JSON.stringify(mutation)),{cmd:'deletefinishedjobs',filter:'all',type:'all',everything:'0'},'no confirmation step, the filters travel with the request');
 const everything=x.root.querySelector('[aria-label="Everything, ignore the filters"]');everything.checked=true;everything.dispatchEvent(new x.w.Event('change'));for(let i=0;i<300;i++)await Promise.resolve();click('Delete finished jobs');for(let i=0;i<300;i++)await Promise.resolve();assert.equal(x.requests.filter(r=>r.cmd==='deletefinishedjobs').at(-1).everything,'1');
 const filter=x.root.querySelector('[aria-label="Job type"]');filter.value='archive';filter.dispatchEvent(new x.w.Event('change'));for(let i=0;i<80;i++)await Promise.resolve();assert.equal(x.requests.filter(r=>r.cmd==='conversionjobs').at(-1).type,'archive');
 }finally{x.close();}
});
test('Jobs discloses structured recovery metadata without dumping JSON into the ordinary job explanation',async()=>{
 const x=await workspace([{id:'20261017-120000-000000000007',schema:3,type:'conversion',state:'completed',stage:'complete_source_retained',source:'/mnt/cache/source',recovery:{kind:'owner-underlay-v1',owner_dataset:'cache',relative:'source',ino:'123'},actions:{}}]);try{const row=x.root.querySelector('[data-job-id]'),diagnostics=row.querySelector('details details pre');assert.ok(diagnostics);assert.equal(JSON.parse(diagnostics.textContent).recovery.owner_dataset,'cache');assert.equal(JSON.parse(diagnostics.textContent).recovery.ino,'123');const explanation=row.cloneNode(true);explanation.querySelectorAll('pre').forEach(n=>n.remove());assert.doesNotMatch(explanation.textContent,/owner_dataset|"ino"|\[object Object\]/);assert.match(explanation.textContent,/recovery.*diagnostics|recovery.*inspection/i);}finally{x.close();}
});

test('deleted directory recovery is a journal, and saved originals remain clearly distinguished',async()=>{
 const jobs=[{id:'20261017-120000-000000000008',schema:6,type:'deletion',kind:'directory',state:'completed',stage:'completed',source:'/mnt/cache/deleted',recovery:{location:'/mnt/cache/.zfsm-mutation-fixture',journal:'journal.jsonl',retained:true},actions:{}},{id:'20261017-120000-000000000009',schema:2,type:'restore',state:'failed',stage:'copying',source:'cache/a@base',recovery:'/mnt/cache/saved-originals',actions:{}}];
 const x=await workspace(jobs);try{const deleted=x.root.querySelector('[data-job-id="'+jobs[0].id+'"]'),saved=x.root.querySelector('[data-job-id="'+jobs[1].id+'"]');const explanation=deleted.cloneNode(true);explanation.querySelectorAll('pre').forEach(n=>n.remove());assert.match(explanation.textContent,/Recovery journal/);assert.match(explanation.textContent,/deleted files.*not.*saved|does not contain.*deleted files/i);assert.doesNotMatch(explanation.textContent,/Retained original|"location"|"retained"/);assert.match(saved.textContent,/Previous files retained at: \/mnt\/cache\/saved-originals/);}finally{x.close();}
});

test('polling preserves an explicitly disclosed Technical diagnostics panel',async()=>{
 const x=await workspace();try{const outer=x.root.querySelector('[data-job-id] > details'),technical=outer.querySelector('details');outer.open=true;technical.open=true;technical.querySelector('summary').focus();await x.poll();assert.equal(x.root.querySelector('[data-job-id] > details').open,true);assert.equal(x.root.querySelector('[data-job-diagnostics]').open,true);assert.ok(x.w.document.activeElement.matches('[data-job-diagnostics] > summary'));}finally{x.close();}
});

test('entering Jobs during an older background request discards that response and immediately loads current timeline',async()=>{
 const dom=new JSDOM('<main></main>',{url:'http://fixture.local/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,root=w.document.querySelector('main'),calls=[];let release;
 w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.scrollTo=()=>{};w.ResizeObserver=class{observe(){}disconnect(){}};
 w.zfsmFormatDateTime=x=>String(x);w.setTimeout=()=>1;w.clearTimeout=()=>{};
 for(const file of ['ZFSMInventory.js','ZFSMForms.js','ZFSMSnapshots.js','ZFSMExplorer.js','ZFSMPoolView.js','ZFSMOverview.js','ZFSMWorkspace.js'])w.eval(readFileSync('src/frontend/'+file,'utf8'));
 const old={id:'20261016-120000-000000000001',schema:1,state:'running',stage:'copying',source:'stale response'},latest={id:'20261017-120000-000000000002',schema:2,type:'archive',state:'completed',stage:'complete',source:'fresh timeline',actions:{}};
 const app=w.zfsmCreateWorkspace({root,config:{refresh_interval:0},request:async fields=>{calls.push(fields);if(fields.cmd==='inventory')return {op:'getAll',data:{pools:{},datasets:{},devices:{},errors:{}}};if(fields.cmd==='conversionjobs'){if(!release)return await new Promise(resolve=>release=resolve);return {jobs:[latest],worker_running:true};}throw Error(fields.cmd);}});
 try{for(let i=0;i<80;i++)await Promise.resolve();const jobs=[...root.querySelectorAll('button')].find(b=>/^Jobs/.test(b.textContent));assert.ok(jobs);jobs.click();release({jobs:[old],worker_running:true});for(let i=0;i<160;i++)await Promise.resolve();const requests=calls.filter(x=>x.cmd==='conversionjobs');assert.equal(requests.length,2,'Do not wait for the next 2.5s poll to request the selected timeline');assert.equal(requests[1].sort,'newest');assert.equal(root.querySelector('[data-job-id]')?.dataset.jobId,latest.id);assert.doesNotMatch(root.querySelector('.zfsm-jobs')?.textContent||root.textContent,/stale response/);}finally{app.stop();w.close();}
});

test('polling preserves Copy fallback focus and text selection in the exact job row',async()=>{
 const rows=[1,2].map(n=>({id:'20261017-120000-'+String(n).padStart(12,'0'),schema:1,type:'conversion',state:'completed',stage:'completed',source:'job-'+n,actions:{}}));const x=await workspace(rows);
 try{const first=x.root.querySelector('[data-job-id="'+rows[0].id+'"]');[...first.querySelectorAll('button')].find(b=>b.textContent==='Copy').click();for(let i=0;i<30;i++)await Promise.resolve();const row=x.root.querySelector('[data-job-id="'+rows[1].id+'"]');[...row.querySelectorAll('button')].find(b=>b.textContent==='Copy').click();for(let i=0;i<30;i++)await Promise.resolve();const textarea=row.querySelector('textarea');textarea.setSelectionRange(3,17);assert.equal(x.w.document.activeElement,textarea);await x.poll();assert.equal(x.w.document.activeElement,textarea,'Do not move focus to a different job or body');assert.equal(textarea.selectionStart,3);assert.equal(textarea.selectionEnd,17);}finally{x.close();}
});

test('polling preserves keyboard focus on the inspected job summary',async()=>{
 const x=await workspace();try{const summary=x.root.querySelector('[data-job-id] summary');summary.focus();await x.poll();assert.equal(x.w.document.activeElement?.tagName,'SUMMARY');assert.equal(x.w.document.activeElement.closest('[data-job-id]').dataset.jobId,'20261017-120000-000000000001');}finally{x.close();}
});

test('plain HTTP Copy uses a user-gesture legacy clipboard path and restores focus',async()=>{
 const x=await workspace();let copied='';try{x.w.document.execCommand=cmd=>{assert.equal(cmd,'copy');copied=x.w.document.activeElement.value;return true;};const button=[...x.root.querySelectorAll('[data-job-id] button')].find(b=>b.textContent==='Copy');button.focus();button.click();for(let i=0;i<40;i++)await Promise.resolve();assert.match(x.root.textContent,/Copied redacted event data/);assert.match(copied,/\[redacted\]/);assert.equal(x.w.document.activeElement,button);assert.equal(x.root.querySelector('[data-copy-fallback]'),null);}finally{x.close();}
});
test('a secure clipboard permission rejection remains an explicit manual fallback',async()=>{
 const x=await workspace();let legacy=0;try{Object.defineProperty(x.w,'isSecureContext',{value:true});Object.defineProperty(x.w.navigator,'clipboard',{value:{writeText:async()=>{throw new Error('Permission denied');}}});x.w.document.execCommand=()=>{legacy++;return true;};[...x.root.querySelectorAll('[data-job-id] button')].find(b=>b.textContent==='Copy').click();for(let i=0;i<40;i++)await Promise.resolve();assert.equal(legacy,0);assert.match(x.root.textContent,/Copy unavailable/);assert.ok(x.root.querySelector('[data-copy-fallback]'));}finally{x.close();}
});

test('Jobs defaults to ten records and remembers a user-selected page size',async()=>{
 const x=await workspace();try{
  assert.equal(x.requests.find(r=>r.cmd==='conversionjobs').page_size,'10');
  const size=x.root.querySelector('[aria-label="Jobs per page"]');assert.ok(size);
  assert.deepEqual([...size.options].map(o=>o.value),['10','25','50','100']);
  size.value='50';size.dispatchEvent(new x.w.Event('change'));for(let i=0;i<80;i++)await Promise.resolve();
  const request=x.requests.filter(r=>r.cmd==='conversionjobs').at(-1);assert.equal(request.page_size,'50');assert.equal(request.page,'1');
  assert.equal(JSON.parse(x.w.localStorage.getItem('zfsm-workspace-preferences-v1')).jobsPageSize,50);
 }finally{x.close();}
});

test('Jobs says in one short line how long finished jobs are kept',async()=>{
 const x=await workspace();try{await x.poll();const line=x.root.querySelector('[data-jobs-retention]');assert.ok(line);assert.equal(line.textContent,'Finished jobs are deleted after 7 days. Change it in Settings.');assert.equal(x.root.querySelector('.zfsm-history-storage'),null,'the long storage explanation is gone');}finally{x.close();}
});
test('every job card names the process, where it went and how it ended, in words',async()=>{
 const base=n=>({id:'20261114-1300'+String(n).padStart(2,'0')+'-00000000000'+n,created:'2026-11-14T13:00:00Z',actions:{}});
 const rep=(n,state,stage,extra={})=>({...base(n),schema:4,type:'replication',definition_id:'a1',definition_name:'immich-daily',trigger:'manual',source:'cache/immich',target:'backup/immich',destination:'backup/immich',state,stage,verified_outcome:state==='completed'?'completed':state,...extra});
 const jobs=[
  rep(1,'running','transferring'),
  rep(2,'failed','finished',{trigger:'schedule',error:'Both trusted Sanoid and Syncoid executables are required.'}),
  rep(3,'recovery_required','finished',{destination:'user@nas:tank/immich'}),
  {...base(4),schema:4,type:'policy',definition_id:'b2',definition_name:'keep-7-days',trigger:'manual',source:'cache/immich',target:null,state:'completed',stage:'finished',verified_outcome:'completed'},
  {...base(5),schema:1,type:'conversion',state:'running',stage:'copying',source:'/mnt/cache/photos',dataset:'cache/photos'},
  {...base(6),schema:2,type:'restore',state:'running',stage:'copying',snapshot:'cache/immich@daily',source:'cache/immich@daily',target:'/mnt/user/photos'},
  {...base(7),schema:2,type:'archive',state:'completed',stage:'completed',snapshot:'cache/immich@daily',source:'cache/immich@daily',archive_removed:true},
  {...base(8),schema:6,type:'deletion',kind:'dataset',rejected:false,state:'running',stage:'deleting',source:'cache/old'},
  {...base(9),schema:5,type:'conversion',state:'failed',stage:'preflight_rejected',source:'/mnt/cache/photos'},
  {...base(10),schema:4,type:'replication',definition_id:'a1',source:'cache/immich',destination:'backup/immich',state:'recovery_required',stage:'invalid_journal',diagnostics:{issue:'invalid_journal'}},
  {...base(11),schema:9,type:'unknown',state:'recovery_required',stage:'unsupported_schema',source:'journal.json',diagnostics:{issue:'unsupported_schema'}},
  rep(12,'running','inspecting',{trigger:undefined,definition_name:undefined}),
 ];
 const x=await workspace(jobs);
 try{
  const card=n=>x.root.querySelector('[data-job-id="'+base(n).id+'"]'),title=n=>card(n).querySelector('summary>strong'),sub=n=>title(n).querySelector('small')?.textContent??null,main=n=>title(n).firstChild.textContent,status=n=>card(n).querySelector('summary>div').textContent;
  assert.deepEqual([1,2,3,4,5,6,7,9].map(main),['Replication · cache/immich → backup/immich','Replication · cache/immich → backup/immich','Replication · cache/immich → user@nas:tank/immich','Snapshot policy · cache/immich','Conversion · /mnt/cache/photos → cache/photos','Restore · cache/immich@daily → /mnt/user/photos','ZIP · cache/immich@daily','Refused: conversion · /mnt/cache/photos']);
  assert.equal(main(8),'Delete dataset · cache/old');
  assert.deepEqual([1,2,3,4].map(sub),['immich-daily · manual run','immich-daily · scheduled','immich-daily · manual run','keep-7-days · manual run']);
  assert.deepEqual([5,6,7,8,9].map(sub),[null,null,null,null,null],'only protection cards have a second line');
  assert.deepEqual([1,2,3,4].map(status),['Running: sending data','Failed','Interrupted: check the destination','✓ Done']);
  assert.deepEqual([10,11].map(main),['Unreadable job · cache/immich','Unreadable job · journal.json'],'a journal that cannot be read is not called a replication or a conversion');
  assert.equal(status(10),'Needs inspection: the job record cannot be read');assert.equal(sub(12),null,'no trigger recorded: no claim about how it started');assert.equal(status(12),'Running: checking');
  assert.equal(card(1).querySelector('summary').textContent.includes('percentage unavailable'),false,'a running protection card shows the bar and the status, not a second stage line');
  assert.equal(card(2).querySelector('[role=alert]').textContent,'Both trusted Sanoid and Syncoid executables are required.','the cause is shown without an Error prefix');
  assert.deepEqual([5,6,7].map(status),['Running: copying files','Running: copying files','✓ Completed'],'conversion, restore and ZIP cards state the status in words');
  assert.equal(status(9),'Failed');
  for(const n of [5,6,7,9])assert.doesNotMatch(card(n).querySelector('summary').textContent,/_|running ·|failed ·|completed ·/);
  for(const n of [1,2,3,4])assert.doesNotMatch(card(n).querySelector('summary').textContent,/recovery_required|finished|failed ·|running ·|transferring|inspecting|invalid_journal/);
 }finally{x.close();}
});
async function settle(n=300){for(let i=0;i<n;i++)await Promise.resolve();}
const clickButton=(x,text)=>[...x.root.querySelectorAll('button')].find(b=>b.textContent===text).click();
const notice=x=>x.root.querySelector('[data-jobs-deleted]')?.textContent??null;
const deleteError=x=>[...x.root.querySelectorAll('.zfsm-error')].map(n=>n.textContent).find(t=>t.startsWith('Unable to delete'))??null;
async function everything(x,on){const box=x.root.querySelector('[aria-label="Everything, ignore the filters"]');box.checked=on;box.dispatchEvent(new x.w.Event('change'));await settle();}
test('the Everything switch and the delete result reset when a filter changes or the user leaves Jobs',async()=>{
 const x=await workspace();try{
  await everything(x,true);clickButton(x,'Delete finished jobs');await settle();
  assert.equal(notice(x),'Deleted 1 finished job record(s).');assert.equal(x.root.querySelector('[aria-label="Everything, ignore the filters"]').checked,true);
  const type=x.root.querySelector('[aria-label="Job type"]');type.value='archive';type.dispatchEvent(new x.w.Event('change'));await settle();
  assert.equal(x.root.querySelector('[aria-label="Everything, ignore the filters"]').checked,false,'a type change resets Everything');assert.equal(notice(x),null);
  await everything(x,true);clickButton(x,'Delete finished jobs');await settle();assert.equal(notice(x),'Deleted 1 finished job record(s).');
  const status=x.root.querySelector('[aria-label="Job status"]');status.value='completed';status.dispatchEvent(new x.w.Event('change'));await settle();
  assert.equal(x.root.querySelector('[aria-label="Everything, ignore the filters"]').checked,false,'a status change resets Everything');assert.equal(notice(x),null);
  await everything(x,true);clickButton(x,'Delete finished jobs');await settle();
  x.root.querySelector('[data-section=overview]').click();await settle();x.root.querySelector('[data-section=jobs]').click();await settle();
  assert.equal(x.root.querySelector('[aria-label="Everything, ignore the filters"]').checked,false,'leaving Jobs resets Everything');assert.equal(notice(x),null);
 }finally{x.close();}
});
test('a delete failure survives the poll and clears on the next click, a filter change or leaving Jobs',async()=>{
 const x=await workspace();try{
  x.behaviour.deleteFails=true;clickButton(x,'Delete finished jobs');await settle();
  assert.equal(deleteError(x),'Unable to delete job records: Disk is read-only');
  await x.poll();assert.equal(deleteError(x),'Unable to delete job records: Disk is read-only','the 2.5 s poll does not clear it');
  x.behaviour.deleteFails=false;clickButton(x,'Delete finished jobs');await settle();assert.equal(deleteError(x),null,'the next Delete click clears it');assert.equal(notice(x),'Deleted 1 finished job record(s).');
  x.behaviour.deleteFails=true;clickButton(x,'Delete finished jobs');await settle();assert.equal(deleteError(x),'Unable to delete job records: Disk is read-only');
  const type=x.root.querySelector('[aria-label="Job type"]');type.value='archive';type.dispatchEvent(new x.w.Event('change'));await settle();assert.equal(deleteError(x),null,'a filter change clears it');
  clickButton(x,'Delete finished jobs');await settle();assert.equal(deleteError(x),'Unable to delete job records: Disk is read-only');
  x.root.querySelector('[data-section=overview]').click();await settle();x.root.querySelector('[data-section=jobs]').click();await settle();assert.equal(deleteError(x),null,'leaving Jobs clears it');
 }finally{x.close();}
});
test('every running conversion, restore and ZIP stage has plain words',async()=>{
 const stages=[['conversion','planned','Running: getting ready'],['conversion','source_retained','Running: keeping the original'],['conversion','dataset_created','Running: creating the dataset'],['conversion','mountpoint_pending','Running: updating the mount point'],['conversion','publishing','Running: mounting the dataset'],['archive','publishing','Running: finishing the ZIP'],['archive','compressing','Running: making the ZIP'],['restore','publishing','Running: putting files in place'],['restore','validating','Running: checking the request']];
 const jobs=stages.map(([type,stage],i)=>({id:'20261114-1400'+String(i).padStart(2,'0')+'-000000000001',schema:type==='conversion'?1:2,type,state:'running',stage,source:'/mnt/cache/photos',created:'2026-11-14T14:00:00Z',actions:{}}));
 const x=await workspace(jobs);
 try{
  const status=job=>x.root.querySelector('[data-job-id="'+job.id+'"] summary>div').textContent;
  assert.deepEqual(jobs.map(status),stages.map(row=>row[2]));
 }finally{x.close();}
});
