import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
async function workspace(suppliedJobs){
 const dom=new JSDOM('<main></main>',{url:'http://fixture.local/?section=jobs',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,root=w.document.querySelector('main'),requests=[];let poll;
 w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.scrollTo=()=>{};w.ResizeObserver=class{observe(){}disconnect(){}};w.zfsmFormatDateTime=x=>String(x);w.setTimeout=(fn,ms)=>{if(ms===2500)poll=fn;return 1;};w.clearTimeout=()=>{};
 for(const file of ['ZFSMInventory.js','ZFSMForms.js','ZFSMSnapshots.js','ZFSMExplorer.js','ZFSMPoolView.js','ZFSMOverview.js','ZFSMHistory.js','ZFSMWorkspace.js'])w.eval(readFileSync('src/frontend/'+file,'utf8'));
 const jobs=suppliedJobs||[{id:'20261017-120000-000000000001',schema:2,type:'archive',state:'completed',stage:'complete',source:'ZIP fixture',archive_eligible:true,actions:{},metadata:{password:'[redacted]'}}];
 const app=w.zfsmCreateWorkspace({root,config:{refresh_interval:0},request:async fields=>{requests.push(fields);if(fields.cmd==='conversionjobs')return {jobs,worker_running:false};if(fields.cmd==='inventory')return {op:'getAll',data:{pools:{},datasets:{},devices:{},errors:{}}};if(fields.cmd==='activityvisibility')return {succeeded:{ok:'hidden'},failed:{}};throw Error(fields.cmd);}});
 for(let i=0;i<80;i++)await Promise.resolve();return {w,root,requests,poll:async()=>{await poll();for(let i=0;i<50;i++)await Promise.resolve();},close(){app.stop();w.close();}};
}
test('Jobs requests global timeline, preserves expanded inspection across polling, offers all filters and bounded clear confirmation',async()=>{
 const x=await workspace();try{assert.equal(x.requests.find(r=>r.cmd==='conversionjobs').sort,'newest');const details=x.root.querySelector('[data-job-id] details');details.open=true;await x.poll();assert.equal(x.root.querySelector('[data-job-id] details').open,true);const filter=x.root.querySelector('[aria-label="Filter jobs"]');assert.deepEqual([...filter.options].map(o=>o.value),['all','active','needs_attention','completed','recovery','snapshot','restore','archive','download','conversion','deletion','operation','maintenance','policy','replication']);const clear=[...x.root.querySelectorAll('button')].find(b=>b.textContent==='Clear completed on this page');assert.ok(clear);clear.click();assert.match(x.root.textContent,/Hide 1 completed job/);assert.equal(x.requests.some(r=>r.cmd==='activityvisibility'),false);}finally{x.close();}
});
test('Jobs Copy reports insecure clipboard failure with selectable redacted fallback',async()=>{
 const x=await workspace();try{const copy=[...x.root.querySelectorAll('[data-job-id] button')].find(b=>b.textContent==='Copy');assert.ok(copy);copy.click();for(let i=0;i<30;i++)await Promise.resolve();assert.match(x.root.querySelector('[data-job-id]').textContent,/Copy unavailable/);const fallback=x.root.querySelector('[data-job-id] textarea');assert.ok(fallback);assert.match(fallback.value,/\[redacted\]/);await x.poll();assert.equal(x.root.querySelector('[data-job-id] textarea')?.value,fallback.value);}finally{x.close();}
});
test('History has one Copy per grouped event and reversible explicit page clear',async()=>{
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only',url:'http://fixture.local/'}),w=dom.window,root=w.document.querySelector('main');w.eval(readFileSync('src/frontend/ZFSMHistory.js','utf8'));
 const id='a'.repeat(32),calls=[];w.zfsmRenderHistory(root,[{operation_id:id,phase:'outcome',status:'succeeded',command:'rename',timestamp:'2026-10-17T12:00:00Z'}],{setVisibility:async(...args)=>{calls.push(args);return {succeeded:{[id]:'hidden'},failed:{}};}});
 try{assert.equal([...root.querySelectorAll('[data-history-operation] button')].filter(b=>b.textContent==='Copy').length,1);const clear=[...root.querySelectorAll('button')].find(b=>b.textContent==='Clear completed on this page');assert.ok(clear);clear.click();assert.match(root.textContent,/Hide 1 successful operation/);assert.equal(calls.length,0);}finally{w.close();}
});
test('Jobs confirmation sends only explicit page IDs and filters use server controls',async()=>{
 const x=await workspace();try{
 const click=text=>[...x.root.querySelectorAll('button')].find(b=>b.textContent===text).click();click('Clear completed on this page');click('Confirm hide');for(let i=0;i<80;i++)await Promise.resolve();
 const mutation=x.requests.find(r=>r.cmd==='activityvisibility');assert.deepEqual(JSON.parse(JSON.stringify(mutation)),{cmd:'activityvisibility',kind:'jobs',ids:['20261017-120000-000000000001'],archived:'1'});
 const filter=x.root.querySelector('[aria-label="Filter jobs"]');filter.value='archive';filter.dispatchEvent(new x.w.Event('change'));for(let i=0;i<80;i++)await Promise.resolve();assert.equal(x.requests.filter(r=>r.cmd==='conversionjobs').at(-1).filter,'archive');
 }finally{x.close();}
});
test('History clear and restore preserve group data and successful secure copying copies one full redacted group',async()=>{
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only',url:'https://fixture.local/'}),w=dom.window,root=w.document.querySelector('main');w.eval(readFileSync('src/frontend/ZFSMHistory.js','utf8'));let copied;Object.defineProperty(w,'isSecureContext',{value:true});Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>copied=text}});
 const id='b'.repeat(32),records=[{operation_id:id,phase:'begin',status:'started',command:'rename',timestamp:'2026-10-17T11:00:00Z',fields:{token:'secret-canary'}},{operation_id:id,phase:'outcome',status:'succeeded',command:'rename',timestamp:'2026-10-17T12:00:00Z'}],calls=[];w.zfsmRenderHistory(root,records,{setVisibility:async(ids,archive)=>{calls.push([ids,archive]);return {succeeded:{[id]:'okay'},failed:{}};}});
 try{const click=text=>[...root.querySelectorAll('button')].find(b=>b.textContent===text).click();click('Copy');for(let i=0;i<30;i++)await Promise.resolve();assert.equal(JSON.parse(copied).length,2);assert.doesNotMatch(copied,/secret-canary/);assert.match(copied,/\[redacted\]/);assert.match(root.textContent,/Copied redacted event data/);
 click('Clear completed on this page');click('Confirm hide');for(let i=0;i<30;i++)await Promise.resolve();assert.equal(root.querySelectorAll('[data-history-operation]').length,0);const view=root.querySelector('[aria-label="History view"]');view.value='archived';view.dispatchEvent(new w.Event('change'));assert.equal(root.querySelectorAll('[data-history-operation]').length,1);click('Restore archived on this page');click('Confirm restore');for(let i=0;i<30;i++)await Promise.resolve();view.value='working';view.dispatchEvent(new w.Event('change'));assert.equal(root.querySelectorAll('[data-history-operation]').length,1);assert.equal(calls.length,2);assert.equal(records[0].fields.token,'secret-canary');
 }finally{w.close();}
});
test('History newest-first same-second recovery outcome wins over the older success',()=>{
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window,root=w.document.querySelector('main');w.eval(readFileSync('src/frontend/ZFSMHistory.js','utf8'));const common={operation_id:'c'.repeat(32),command:'restore',timestamp:'2026-10-17T12:00:00Z'};w.zfsmRenderHistory(root,[{...common,phase:'outcome',status:'recovery_required'},{...common,phase:'outcome',status:'succeeded'},{...common,phase:'begin',status:'started'}],{archivedIds:['c'.repeat(32)]});try{assert.equal(root.querySelector('[data-history-result]').textContent,'Needs attention');}finally{w.close();}
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
 for(const file of ['ZFSMInventory.js','ZFSMForms.js','ZFSMSnapshots.js','ZFSMExplorer.js','ZFSMPoolView.js','ZFSMOverview.js','ZFSMHistory.js','ZFSMWorkspace.js'])w.eval(readFileSync('src/frontend/'+file,'utf8'));
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

for(const state of ['running','queued'])test('History keeps '+state+' visible despite a stale archived ID',()=>{
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window,root=w.document.querySelector('main');w.eval(readFileSync('src/frontend/ZFSMHistory.js','utf8'));const common={operation_id:'d'.repeat(32),command:'restore',timestamp:'2026-10-17T12:00:00Z'};w.zfsmRenderHistory(root,[{...common,phase:'event',status:state},{...common,phase:'outcome',status:'succeeded'},{...common,phase:'begin',status:'started'}],{archivedIds:['d'.repeat(32)]});try{assert.equal(root.querySelectorAll('[data-history-operation]').length,1);assert.match(root.querySelector('[data-history-result]').textContent,/unconfirmed/i);}finally{w.close();}
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

test('history storage explanation remains expanded during Jobs polling',async()=>{
 const x=await workspace();try{const storage=x.root.querySelector('.zfsm-history-storage');assert.ok(storage);storage.open=true;await x.poll();assert.equal(x.root.querySelector('.zfsm-history-storage').open,true);assert.match(x.root.textContent,/protected.*exceed|can exceed/i);}finally{x.close();}
});
