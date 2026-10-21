import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';

const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const entry=(name,overrides={})=>({name,path:name,type:'file',size:10,mtime:1700000000,available:true,...overrides});
const button=(root,name)=>[...root.querySelectorAll('button')].find(node=>node.getAttribute('aria-label')===name);
test('operation summary precedes a paginated file list and keeps details collapsed',async()=>{
 const f=await explorer(Array.from({length:1001},(_,i)=>entry('file-'+i)));try{
  f.app.updateJobs([{id:'zip1',snapshot:'cache/data@base',type:'archive',state:'running',progress:{percent:43}}]);
  const activity=f.root.querySelector('.zfsm-explorer-jobs'),list=f.root.querySelector('.zfsm-explorer-list');
  assert.ok(activity.compareDocumentPosition(list)&f.w.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.match(activity.querySelector('[role=status]').textContent,/ZIP.*Running.*43%/);
  assert.equal(activity.querySelector('details').open,false);assert.equal(f.root.querySelectorAll('tr[data-entry]').length,200);
 }finally{f.close();}
});
test('ready ZIP stays downloadable above files and progress updates preserve focused action and open details',async()=>{
 const f=await explorer([entry('notes.txt')]);try{
  const job={id:'zip1',snapshot:'cache/data@base',type:'archive',state:'completed',expires:Date.now()/1000+3600};
  f.app.updateJobs([job]);const download=button(f.root,'Download ZIP'),details=f.root.querySelector('.zfsm-explorer-jobs details');assert.ok(download);assert.ok(details);
  details.open=true;download.focus();f.app.updateJobs([{...job,updated:1}]);
  assert.equal(f.w.document.activeElement,download);assert.equal(details.open,true);
  download.click();await settle();assert.deepEqual(f.downloads,[{cmd:'downloadsnapshotarchive',job_id:'zip1'}]);
  f.app.updateJobs([{...job,archive_removed:true}]);assert.equal(download.hidden,true);assert.match(f.root.querySelector('.zfsm-explorer-job-summary').textContent,/expired/i);
 }finally{f.close();}
});
test('an older failed operation remains visible ahead of newer successes and does not render error HTML',async()=>{
 const f=await explorer([entry('notes.txt')]);try{
  f.app.updateJobs([{id:'a',snapshot:'cache/data@base',type:'restore',state:'recovery_required',error:'<img src=x> Copy failed',target:'/mnt/cache/data/'+('long/'.repeat(80))},...['b','c','d','e'].map(id=>({id,snapshot:'cache/data@base',type:'restore',state:'completed'}))]);
  const activity=f.root.querySelector('.zfsm-explorer-jobs');assert.match(activity.querySelector('[role=alert]').textContent,/1 operation.*needs attention/i);assert.match(f.root.textContent,/Copy failed/);assert.equal(f.root.querySelector('img'),null);
 }finally{f.close();}
});
test('restore review replaces the file area and closing it returns to the retained selection',async()=>{
 const f=await explorer([entry('notes.txt')]);try{
  button(f.root,'Select page').click();button(f.root,'Restore selected').click();
  assert.equal(f.root.querySelector('.zfsm-explorer-list').hidden,true);
  assert.ok(f.root.querySelector('.zfsm-explorer-body .zfsm-explorer-restore'));
  button(f.root,'Review restore').click();await settle();assert.ok(f.root.querySelector('.zfsm-restore-review'));
  button(f.root,'Close restore form').click();assert.equal(f.root.querySelector('.zfsm-explorer-list').hidden,false);assert.deepEqual(Array.from(f.app.getState().selection),['notes.txt']);
 }finally{f.close();}
});
test('latest journal state wins and old failures stay marked until details are viewed',async()=>{
 const f=await explorer([entry('notes.txt')]);try{
  const base={snapshot:'cache/data@base',type:'restore'},failed={...base,id:'1',state:'failed',error:'Permission denied'};
  f.app.updateJobs([failed,{...base,id:'2',state:'completed'}]);assert.equal(f.root.querySelector('.zfsm-explorer-job-summary>[role=status]').textContent,'Restore · Completed');assert.equal(button(f.root,'Operation errors').hidden,false);
  button(f.root,'Operation errors').click();assert.equal(button(f.root,'Operation errors').hidden,true);
  f.app.updateJobs([{...failed,error:'New copy failure'}]);assert.equal(button(f.root,'Operation errors').hidden,true,'Details is open and displays the new failure');
  f.root.querySelector('details').open=false;f.app.updateJobs([{...failed,error:'Another failure'}]);assert.equal(button(f.root,'Operation errors').hidden,false);
  assert.equal(f.calls.filter(c=>['cancelrestore','restoresnapshotfiles','archivesnapshotfiles'].includes(c.cmd)).length,0);
 }finally{f.close();}
});
test('offscreen folder selection remains explicit and can be reviewed and removed before ZIP',async()=>{
 const f=await explorer([entry('folder',{type:'directory'}),entry('inside.txt',{path:'folder/inside.txt'})]);try{
  const check=f.root.querySelector('[aria-label="Select folder"]');check.checked=true;check.dispatchEvent(new f.w.Event('change'));button(f.root,'Open folder').click();await settle();
  assert.match(button(f.root,'Review selected files').textContent,/Selected: 1 folder/);assert.match(f.root.querySelector('.zfsm-explorer-selection-context').textContent,/1 outside this view/);
  button(f.root,'Review selected files').click();assert.equal(f.root.querySelector('.zfsm-explorer-list').hidden,true);assert.match(f.root.querySelector('.zfsm-explorer-selection-review').textContent,/folder/);
  button(f.root,'Remove selected folder').click();assert.equal(f.app.getState().selection.length,0);assert.equal(button(f.root,'Download selected as ZIP').disabled,true);assert.equal(f.calls.filter(c=>c.cmd==='archivesnapshotfiles').length,0);
  button(f.root,'Back to files').click();assert.equal(f.root.querySelector('.zfsm-explorer-list').hidden,false);
 }finally{f.close();}
});
test('successful inventory recovery clears only the obsolete availability warning',async()=>{
 const f=await explorer([entry('notes.txt')]);try{
  f.app.setAvailable(false);assert.match(f.root.textContent,/Snapshot inventory is unavailable/);
  f.app.setAvailable(true);assert.doesNotMatch(f.root.textContent,/Snapshot inventory is unavailable/);assert.equal(button(f.root,'Select page').disabled,false);
 }finally{f.close();}
});
test('inventory recovery preserves an unrelated file backend error',async()=>{
 const f=await explorer([entry('notes.txt')]);try{
  f.app.setAvailable(false);f.model.failure='snapshotfiles';button(f.root,'Refresh files').click();await settle();
  f.app.setAvailable(true);assert.match(f.root.textContent,/Backend unavailable/);assert.equal(button(f.root,'Select page').disabled,true);
 }finally{f.close();}
});
test('file type filter keeps selections outside its visible result set',async()=>{
 const f=await explorer([entry('notes.txt'),entry('folder',{type:'directory'})]);try{
  button(f.root,'Select page').click();const kind=f.root.querySelector('[aria-label="File types"]');assert.ok(kind);kind.value='file';kind.dispatchEvent(new f.w.Event('change'));await settle();
  assert.equal(f.root.querySelectorAll('tr[data-entry]').length,1);assert.equal(f.calls.at(-1).kind,'file');assert.equal(f.app.getState().selection.length,2);
  kind.value='directory';kind.dispatchEvent(new f.w.Event('change'));await settle();assert.equal(f.root.querySelector('tr[data-entry]').dataset.entry,'folder');assert.equal(f.app.getState().selection.length,2);
 }finally{f.close();}
});
async function explorer(entries=[],settings={}) {
 const instance=new JSDOM('<main id="files"></main>',{url:'http://fixture.local',runScripts:'outside-only',pretendToBeVisual:true}),w=instance.window,root=w.document.querySelector('main'),calls=[],downloads=[],timers=new Map();
 let timer=0;
 w.setTimeout=fn=>{timers.set(++timer,fn);return timer;};w.clearTimeout=id=>timers.delete(id);
 w.zfsmFormatDateTime=String;w.eval(readFileSync('src/frontend/ZFSMExplorer.js','utf8'));
 const model={entries,restore:true,guid:'18446744073709551615',failure:null,pause:null,...settings};
 const request=async data=>{
  calls.push(structuredClone(data));if(model.failure===data.cmd)throw Error('Backend unavailable');if(model.pause&&model.pause.cmd===data.cmd)await model.pause.promise;
  if(data.cmd==='snapshotfiles'){
   let list=model.entries.filter(row=>!data.kind||data.kind==='all'||row.type===data.kind).filter(row=>(row.path.includes('/')?row.path.slice(0,row.path.lastIndexOf('/')):'')===data.path).filter(row=>data.hidden==='1'||!row.name.startsWith('.')).filter(row=>row.name.toLowerCase().includes(data.filter.toLowerCase()));
   list.sort((a,b)=>(data.sort==='name'?a.name.localeCompare(b.name):a[data.sort]-b[data.sort])*(data.direction==='desc'?-1:1));
   return {snapshot:data.snapshot,path:data.path,snapshot_guid:model.guid,restore_available:model.restore,entries:list.slice(Number(data.offset),Number(data.offset)+200).map(e=>({...e})),total:list.length};
  }
  if(data.cmd==='snapshotfileinfo')return {ready:true,size:model.entries.find(row=>row.path===data.path)?.size};
  if(data.cmd==='archivesnapshotfiles')return {succeeded:{archive:0},failed:{},job:{id:'archive1',type:'archive',state:'queued',snapshot:data.snapshot}};
  if(data.cmd==='previewrestore')return {id:'preview1',token:'signed',selection:data.selection,files:data.selection.length,bytes:10,target:'/mnt/cache/data/restored',conflicts:[]};
  if(data.cmd==='restoresnapshotfiles')return {succeeded:{restore:0},failed:{},job:{id:'restore1',type:'restore',state:'queued'}};
  throw Error('Unexpected command '+data.cmd);
 };
 const app=w.zfsmCreateSnapshotExplorer({host:root,snapshot:'cache/data@base',request,download:async data=>{downloads.push(structuredClone(data));},getConfig:()=>({destructive_mode:1}),onClose(){},onJobs(){}});await settle();
 return {instance,w,root,calls,downloads,model,app,flush:async()=>{for(const fn of [...timers.values()])fn();timers.clear();await settle();},close:()=>{app.dispose();instance.window.close();}};
}
for(const count of [0,1,14,200,1001])test('top controls and page totals for '+count+' files',async()=>{
 const fixture=await explorer(Array.from({length:count},(_,i)=>entry('file-'+String(i).padStart(4,'0'))));const{root,w}=fixture;
 try {
  const controls=root.querySelector('.zfsm-explorer-controls'),table=root.querySelector('.zfsm-file-table');assert.ok(controls,'selection/pagination toolbar exists');assert.ok(controls.compareDocumentPosition(table)&w.Node.DOCUMENT_POSITION_FOLLOWING,'toolbar precedes table');
  assert.match(controls.textContent,new RegExp('Page 1 / '+Math.max(1,Math.ceil(count/200))));assert.match(controls.textContent,new RegExp(count?'Items 1–'+Math.min(200,count)+' of '+count:'Items 0 of 0'));
  assert.equal(button(root,'Select page').disabled,count===0);assert.equal(button(root,'Previous page').disabled,true);assert.equal(button(root,'Next page').disabled,count<=200);
 }finally{fixture.close();}
});
test('selection spans pages; Select page affects only current page',async()=>{
 const f=await explorer(Array.from({length:205},(_,i)=>entry('file-'+String(i).padStart(3,'0'))));try{
  button(f.root,'Select page').click();assert.equal(f.app.getState().selection.length,200);button(f.root,'Next page').click();await settle();assert.equal(f.app.getState().selection.length,200);assert.equal(f.root.querySelectorAll('tr[data-entry]').length,5);
  button(f.root,'Select page').click();assert.equal(f.app.getState().selection.length,205);assert.match(f.root.querySelector('.zfsm-explorer-controls').textContent,/Selected: 205/);
  button(f.root,'Previous page').click();await settle();assert.equal(f.root.querySelectorAll('input[type=checkbox]:checked').length,200);button(f.root,'Clear selection').click();assert.equal(f.app.getState().selection.length,0);
 }finally{f.close();}
});
for(const restore of [true,false])test('single file direct download on '+(restore?'writable':'readonly')+' dataset',async()=>{
 const f=await explorer([entry('notes.txt')],{restore});try{
  button(f.root,'Download file notes.txt')?.click();await settle();assert.equal(f.calls.filter(c=>c.cmd==='snapshotfileinfo').length,1);assert.equal(f.downloads.length,1);assert.equal(f.downloads[0].cmd,'downloadsnapshotfile');assert.equal(f.downloads[0].snapshot_guid,'18446744073709551615');assert.equal(f.calls.filter(c=>c.cmd==='archivesnapshotfiles').length,0);
 }finally{f.close();}
});
test('folder is explicitly ZIP; selection ZIP and restore controls remain',async()=>{
 const f=await explorer([entry('folder',{type:'directory',size:0})]);try{
  button(f.root,'Prepare ZIP folder')?.click();await settle();assert.equal(f.calls.filter(c=>c.cmd==='archivesnapshotfiles').length,1);assert.deepEqual(f.calls.find(c=>c.cmd==='archivesnapshotfiles').selection,['folder']);assert.equal(f.downloads.length,0);
  assert.ok(button(f.root,'Restore selected'));assert.ok(button(f.root,'Download selected as ZIP'));
 }finally{f.close();}
});
test('refresh removes changed or missing selected entries after a complete listing',async()=>{
 const f=await explorer([entry('changed'),entry('missing'),entry('keep')]);try{
  button(f.root,'Select page').click();f.model.entries=[entry('changed',{mtime:1700000001}),entry('keep')];button(f.root,'Refresh files').click();await settle();assert.deepEqual(Array.from(f.app.getState().selection),['keep']);assert.match(f.root.textContent,/selection.*changed|changed.*selection/i);
 }finally{f.close();}
});
test('filtering preserves offscreen selection; navigating folders preserves paths',async()=>{
 const f=await explorer([entry('notes.txt'),entry('folder',{type:'directory'}),entry('inside.txt',{path:'folder/inside.txt'})]);try{
  const check=f.root.querySelector('[aria-label="Select notes.txt"]');check.checked=true;check.dispatchEvent(new f.w.Event('change'));
  const filter=f.root.querySelector('[aria-label="Filter names"]');filter.value='folder';filter.dispatchEvent(new f.w.Event('input'));await f.flush();assert.deepEqual(Array.from(f.app.getState().selection),['notes.txt']);
  button(f.root,'Open folder').click();await settle();button(f.root,'Select page').click();assert.deepEqual(Array.from(f.app.getState().selection),['notes.txt','folder/inside.txt']);button(f.root,'Snapshot root').click();await settle();assert.equal(f.root.querySelector('[aria-label="Select notes.txt"]').checked,true);
 }finally{f.close();}
});
test('loading and inventory loss disable download and bulk action dispatch',async()=>{
 const f=await explorer([entry('notes.txt')]);try{
  button(f.root,'Select page').click();let resolve;f.model.pause={cmd:'snapshotfiles',promise:new Promise(r=>resolve=r)};button(f.root,'Refresh files').click();
  assert.equal(button(f.root,'Download selected as ZIP').disabled,true);button(f.root,'Download file notes.txt')?.click();await settle();assert.equal(f.downloads.length,0);assert.equal(f.calls.filter(c=>c.cmd==='snapshotfileinfo').length,0);
  resolve();await settle();f.app.setAvailable(false);assert.equal(button(f.root,'Select page').disabled,true);button(f.root,'Download file notes.txt')?.click();await settle();assert.equal(f.downloads.length,0);
 }finally{f.close();}
});
test('direct download rejects changed size and duplicate submission without retries',async()=>{
 const f=await explorer([entry('notes.txt')]);try{
  let resolve;f.model.pause={cmd:'snapshotfileinfo',promise:new Promise(r=>resolve=r)};const direct=button(f.root,'Download file notes.txt');direct?.click();direct?.click();await settle();assert.equal(f.calls.filter(c=>c.cmd==='snapshotfileinfo').length,1);
  f.model.entries=[entry('notes.txt',{size:11})];resolve();await settle();assert.equal(f.downloads.length,0);assert.match(f.root.textContent,/changed|refresh/i);
 }finally{f.close();}
});
test('failed ZIP is explicit and does not retry',async()=>{
 const f=await explorer([entry('notes.txt')]);try{
  button(f.root,'Select page').click();f.model.failure='archivesnapshotfiles';button(f.root,'Download selected as ZIP').click();await settle();assert.match(f.root.querySelector('[role=alert]').textContent,/Backend unavailable/);assert.equal(f.calls.filter(c=>c.cmd==='archivesnapshotfiles').length,1);
 }finally{f.close();}
});
test('special links and Unicode names render as text without unsupported downloads',async()=>{
 const f=await explorer([entry('<img src=x onerror=alert(1)>.txt'),entry('Привет мир.txt'),entry('pipe',{type:'special',available:false}),entry('link',{type:'symlink',available:false})]);try{
  assert.equal(f.root.querySelectorAll('tr[data-entry]').length,4);assert.equal(f.root.querySelector('img'),null);assert.ok(button(f.root,'Download file Привет мир.txt'));assert.equal(button(f.root,'Download file pipe'),undefined);assert.equal(f.root.querySelector('[aria-label="Select link"]').disabled,true);
 }finally{f.close();}
});
test('file inventory error blocks all mutations until a fresh successful read',async()=>{
 const f=await explorer([entry('notes.txt')]);try{
  button(f.root,'Select page').click();f.model.failure='snapshotfiles';button(f.root,'Refresh files').click();await settle();assert.match(f.root.querySelector('[role=alert]').textContent,/Backend unavailable/);assert.equal(button(f.root,'Download selected as ZIP').disabled,true);assert.equal(button(f.root,'Restore selected').disabled,true);assert.equal(button(f.root,'Select page').disabled,true);
  f.model.failure=null;button(f.root,'Refresh files').click();await settle();assert.equal(button(f.root,'Download selected as ZIP').disabled,false);
 }finally{f.close();}
});
test('snapshot replacement clears the selection counter and disables bulk work',async()=>{
 const f=await explorer([entry('notes.txt')]);try{
  button(f.root,'Select page').click();f.model.guid='999';button(f.root,'Refresh files').click();await settle();assert.deepEqual(Array.from(f.app.getState().selection),[]);assert.match(f.root.querySelector('.zfsm-explorer-controls').textContent,/Selected: 0/);assert.equal(button(f.root,'Download selected as ZIP').disabled,true);
 }finally{f.close();}
});
test('restore preview cannot submit after inventory availability is lost',async()=>{
 const f=await explorer([entry('notes.txt')]);try{
  button(f.root,'Select page').click();button(f.root,'Restore selected').click();button(f.root,'Review restore').click();await settle();const confirm=f.root.querySelector('.zfsm-restore-review input[type=checkbox]');confirm.checked=true;confirm.dispatchEvent(new f.w.Event('change'));const start=button(f.root,'Start restore');assert.equal(start.disabled,false);
  f.app.setAvailable(false);start.click();await settle();assert.equal(f.calls.filter(c=>c.cmd==='restoresnapshotfiles').length,0);assert.equal(button(f.root,'Start restore'),undefined);
 }finally{f.close();}
});
test('a removed final page returns to a valid page without losing other selections',async()=>{
 const f=await explorer(Array.from({length:205},(_,i)=>entry('file-'+String(i).padStart(3,'0'))));try{
  button(f.root,'Next page').click();await settle();f.model.entries=f.model.entries.slice(0,14);button(f.root,'Refresh files').click();await settle();assert.match(f.root.querySelector('.zfsm-explorer-controls').textContent,/Page 1 \/ 1.*Items 1–14 of 14/);
 }finally{f.close();}
});

test('File Manager tracks direct transfers without hiding ready ZIP and never fabricates a percent',async()=>{
 const f=await explorer([entry('notes.txt')]);try{
  const archive={id:'a',snapshot:'cache/data@base',type:'archive',state:'completed',expires:Date.now()/1000+3600},transfer={id:'b',snapshot:'cache/data@base',type:'download',state:'running',stage:'transferring',progress:{bytes:2,total:10,percent:20}};
  f.app.updateJobs([archive,transfer]);const area=f.root.querySelector('.zfsm-explorer-jobs');assert.match(area.querySelector('[role=status]').textContent,/Download.*20%/);assert.equal(area.querySelector('progress').value,20);assert.equal(button(f.root,'Download ZIP').hidden,false);
  f.app.updateJobs([{...transfer,progress:{bytes:2,total:10,percent:null}}]);assert.equal(area.querySelector('progress').hasAttribute('value'),false);assert.doesNotMatch(area.querySelector('[role=status]').textContent,/0%/);
  f.app.updateJobs([{...transfer,state:'completed',result:{summary:'Server transfer finished. Check browser Downloads to confirm the file was saved.'}}]);assert.match(f.root.textContent,/Check browser Downloads/);assert.equal(button(f.root,'Download ZIP').hidden,false);
 }finally{f.close();}
});
