import {installDialogs} from './helpers/dialogs.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';

const tick=async()=>{for(let n=0;n<40;n++)await Promise.resolve();};
const click=(root,label)=>{const b=[...root.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label||b.dataset.node===label||b.textContent===label);assert.ok(b,label);b.click();return b;};
async function setup({cached=false,refreshInterval=cached?0:30,guid='2',initialHold=false,initialFail=false,initialProgressive=false,initialSnapshotHold=false}={}){
 const dom=new JSDOM('<main id="root"></main>',{url:'http://fixture.local/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,root=w.document.querySelector('main');
 const timers=new Map();let timerSequence=0;w.setTimeout=(fn,ms)=>{timers.set(++timerSequence,{fn,ms});return timerSequence;};w.clearTimeout=id=>timers.delete(id);
 w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.scrollTo=()=>{};w.ResizeObserver=class{observe(){}disconnect(){}};w.zfsmFormatDateTime=x=>String(x);
 installDialogs(w);
 for(const f of ['ZFSMInventory.js','ZFSMForms.js','ZFSMSnapshots.js','ZFSMExplorer.js','ZFSMPoolView.js','ZFSMOverview.js','ZFSMHistory.js','ZFSMWorkspace.js'])w.eval(readFileSync('src/frontend/'+f,'utf8'));
 let fail=initialFail,hold=initialHold,release,progressive=initialProgressive,snapshotRelease;const calls=[];
 const child={name:'cache/data',type:'filesystem',guid,encryption:'off',keystatus:'none',mountpoint:'/mnt/cache/data',child:{},snapshots:[],directories:[]};
 const data={pools:{cache:{Health:'ONLINE',Size:1000,Used:100,Snapshots:0}},datasets:{cache:{name:'cache',type:'filesystem',guid:'1',child:{'cache/data':child},snapshots:[],directories:[]}},devices:{cache:''},errors:{}};
 if(cached)w.localStorage.setItem('zfsm-workspace-inventory-v1',JSON.stringify({time:'2026-01-01T00:00:00Z',data}));
 const config={refresh_interval:refreshInterval,destructive_mode:1};
 const app=w.zfsmCreateWorkspace({root,config,request:async fields=>{
  calls.push(structuredClone(fields));if(fields.cmd==='conversionjobs')return {jobs:[],worker_running:false};if(fields.cmd==='inventory'){if(hold)await new Promise(r=>release=r);if(fail)throw Error('simulated timeout');const copy=structuredClone(data);if(progressive)copy.pools.cache.Snapshots=null;return {op:progressive?'getDatasets':'getAll',data:copy};}
  if(fields.cmd==='inventorysnapshots'){if(initialSnapshotHold)await new Promise(r=>snapshotRelease=r);const copy=structuredClone(data);if(!initialProgressive)copy.datasets.cache.child['cache/data'].guid='888';return {op:'getAll',data:copy};}
  if(fields.cmd==='pooldiagnostics')throw Error('unavailable');if(fields.cmd==='renamedataset')return {succeeded:{'cache/new':'Renamed'},failed:{}};throw Error('Unexpected '+fields.cmd);
 }});await tick();click(root,'cache/data');click(root,'Actions');await tick();
 return {w,root,app,calls,data,child,timers,config,replaceDuringSnapshots:()=>progressive=true,fail:()=>fail=true,recover:()=>fail=false,hold:()=>hold=true,release:()=>release?.(),releaseSnapshots:()=>snapshotRelease?.(),close(){app.stop();w.close();}};
}
for(const scenario of ['cached','failed','missing GUID'])test('all dataset mutations blocked: '+scenario,async()=>{
 const x=await setup({cached:scenario==='cached',initialHold:scenario==='cached',guid:scenario==='missing GUID'?'':'2'});try{
  if(scenario==='failed'){x.fail();x.app.refresh();await tick();}
  for(const label of ['Take Snapshot','Rename dataset','Edit Dataset','Destroy dataset'])assert.equal([...x.root.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label)?.disabled,true,label);
  assert.equal(x.calls.some(c=>c.cmd==='renamedataset'),false);
 }finally{x.close();}
});
for(const cached of [false,true])test('opening workspace refreshes once when periodic refresh is off, cached='+cached,async()=>{
 const x=await setup({cached,refreshInterval:0});try{
  assert.equal(x.calls.filter(c=>c.cmd==='inventory').length,1);
  for(const label of ['Take Snapshot','Rename dataset','Destroy dataset'])assert.equal([...x.root.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label)?.disabled,false,label);
  assert.equal(x.calls.some(c=>['destroydataset','snapshotdataset','renamedataset'].includes(c.cmd)),false);
  assert.match(x.root.textContent,/Last refresh/);
  assert.equal(x.config.refresh_interval,0);
  assert.equal([...x.timers.values()].some(timer=>![2500,5000].includes(timer.ms)),false,'Only Jobs and diagnostics timers remain; no inventory polling');
 }finally{x.close();}
});
test('cached actions stay protected until all initial inventory pages finish',async()=>{
 const x=await setup({cached:true,initialProgressive:true,initialSnapshotHold:true});try{
  assert.equal(x.calls.filter(c=>c.cmd==='inventorysnapshots').length,1);
  assert.equal([...x.root.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Destroy dataset')?.disabled,true);
  x.releaseSnapshots();await tick();
  assert.equal([...x.root.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Destroy dataset')?.disabled,false);
 }finally{x.close();}
});
test('failed initial refresh offers an in-context retry without bypassing safety',async()=>{
 const x=await setup({cached:true,initialFail:true});try{
  assert.equal([...x.root.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Destroy dataset')?.disabled,true);
  const retry=[...x.root.querySelectorAll('button')].find(b=>b.textContent==='Refresh inventory');assert.ok(retry);
  x.recover();retry.click();await tick();
  assert.equal(x.calls.filter(c=>c.cmd==='inventory').length,2);
  assert.equal([...x.root.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Destroy dataset')?.disabled,false);
  assert.equal(x.calls.some(c=>c.cmd==='destroydataset'),false);
 }finally{x.close();}
});
test('replacement with same name invalidates an open confirmation',async()=>{
 const x=await setup();try{click(x.root,'Rename dataset');await tick();const input=x.root.querySelector('[name="newname"]');input.value='cache/new';input.dispatchEvent(new x.w.Event('input',{bubbles:true}));x.root.querySelector('form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));const confirm=x.root.querySelector('[data-confirm-operation]');assert.ok(confirm);x.child.guid='3';x.app.refresh();await tick();confirm.dispatchEvent(new x.w.Event('click'));await tick();assert.equal(x.calls.some(c=>c.cmd==='renamedataset'),false);assert.match(x.root.textContent,/identity|changed|stale/i);}finally{x.close();}
});
test('fresh confirmed mutation transmits original GUID and destination parent identity once',async()=>{
 const x=await setup();try{click(x.root,'Rename dataset');await tick();const input=x.root.querySelector('[name="newname"]');input.value='cache/new';input.dispatchEvent(new x.w.Event('input',{bubbles:true}));x.root.querySelector('form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));const confirm=x.root.querySelector('[data-confirm-operation]');assert.ok(confirm);confirm.click();confirm.click();await tick();const calls=x.calls.filter(c=>c.cmd==='renamedataset');assert.equal(calls.length,1);assert.equal(calls[0].expected_guid,'2');assert.equal(calls[0].parent_guid,'1');assert.equal(calls[0].parent_name,'cache');}finally{x.close();}
});
test('failed bulk deletion consumes review and requires a fresh preview before retry',async()=>{
 const dom=new JSDOM('<main></main>',{url:'http://fixture.local/',runScripts:'outside-only'}),w=dom.window,root=w.document.querySelector('main'),calls=[];
 w.eval(readFileSync('src/frontend/ZFSMForms.js','utf8'));
 const forms=w.zfsmCreateInlineForms({getConfig:()=>({destructive_mode:1}),request:async fields=>{calls.push(fields);return fields.cmd==='previewdestroy'?{target:fields.snapshot,token:'a'.repeat(64),preview_id:'b'.repeat(32),preview:'destroy snapshot',can_destroy:true}:{succeeded:{},failed:{'cache/data@s1':'Device is busy'}};}});
 try{await forms.render(root,'destroysnapshot',{pool:'cache',dataset:'cache/data',snapshot:'cache/data@s1'});root.querySelector('[data-preview]').click();await tick();const ack=root.querySelector('[name=acknowledge]');ack.checked=true;ack.dispatchEvent(new w.Event('change',{bubbles:true}));root.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));root.querySelector('[data-confirm-operation]').click();await tick();ack.checked=true;ack.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(root.querySelector('button[type=submit]').disabled,true);assert.equal(calls.filter(c=>c.cmd==='destroysnapshot').length,1);}finally{forms.dispose();w.close();}
});
test('dataset search reveals collapsed ancestors and preserves selection through filters',async()=>{
 const x=await setup();try{x.child.child['cache/data/nested']={...structuredClone(x.child),name:'cache/data/nested',guid:'3',child:{}};x.app.refresh();await tick();click(x.root,'Collapse cache/data');const search=x.root.querySelector('[aria-label="Search datasets"]');assert.ok(search);search.value='nested';search.dispatchEvent(new x.w.Event('input',{bubbles:true}));assert.ok(x.root.querySelector('[data-node="cache/data/nested"]'));assert.equal(x.app.getState().selection,'cache/data');const filter=x.root.querySelector('[aria-label="Filter datasets"]');filter.value='locked';filter.dispatchEvent(new x.w.Event('change',{bubbles:true}));assert.match(x.root.textContent,/No matching datasets/);assert.equal(x.app.getState().selection,'cache/data');}finally{x.close();}
});
test('same-name dataset replacement requires explicit review before a new mutation',async()=>{
 const x=await setup();try{x.child.guid='777';x.app.refresh();await tick();assert.equal([...x.root.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Take Snapshot').disabled,true);click(x.root,'cache/data');click(x.root,'Actions');assert.equal([...x.root.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Take Snapshot').disabled,false);}finally{x.close();}
});
test('progressive snapshot loading cannot silently rebind selected dataset identity',async()=>{
 const x=await setup();try{x.replaceDuringSnapshots();x.app.refresh();await tick();assert.ok(x.root.querySelectorAll('button').length);assert.match(x.root.textContent,/Selected object identity changed/);assert.equal([...x.root.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Take Snapshot').disabled,true);}finally{x.close();}
});
