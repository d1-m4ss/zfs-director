import {installDialogs} from './helpers/dialogs.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';

const settle=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
function dataset(name,guid,count=1){return {name,guid,type:'filesystem',mountpoint:'/mnt/'+name,child:{},directories:[],snapshots:Array.from({length:count},(_,i)=>({name:name+'@s'+i,guid:String(Number(guid)*100+i),creation:1700000000+i,used:i,referenced:100,written:1,userrefs:0,defer_destroy:'off'}))};}
const control=(x,label)=>x.root.querySelector('[aria-label="'+label+'"]');
const button=(x,label)=>[...x.root.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label||b.textContent===label);
function choose(x,name){const select=control(x,'Dataset');assert.ok(select,'Snapshots must expose a Dataset chooser');select.value=name;select.dispatchEvent(new x.w.Event('change',{bubbles:true}));}
function check(x,name){const input=[...x.root.querySelectorAll('tbody input[type=checkbox]')].find(input=>input.value===name);assert.ok(input,name);input.checked=true;input.dispatchEvent(new x.w.Event('change',{bubbles:true}));}

async function setup(){
 const dom=new JSDOM('<main></main>',{url:'http://fixture.local/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,root=w.document.querySelector('main');
 w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.scrollTo=()=>{};w.ResizeObserver=class{observe(){}disconnect(){}};w.zfsmFormatDateTime=x=>String(x);
 installDialogs(w);
 for(const file of ['ZFSMInventory.js','ZFSMForms.js','ZFSMSnapshots.js','ZFSMExplorer.js','ZFSMPoolView.js','ZFSMOverview.js','ZFSMHistory.js','ZFSMWorkspace.js'])w.eval(readFileSync('src/frontend/'+file,'utf8'));
 const first=dataset('cache/first','2',51),second=dataset('cache/second','3'),parent=dataset('cache','1',0);first.directories=['/mnt/cache/first/ordinary'];parent.child={first,second};
 const data={pools:{cache:{Health:'ONLINE',Size:1000,Used:100,Snapshots:52},other:{Health:'ONLINE',Size:1000,Used:100,Snapshots:1}},datasets:{cache:parent,other:dataset('other','9')},devices:{cache:'',other:''},errors:{}},calls=[];
 let failInventory=false;
 const app=w.zfsmCreateWorkspace({root,config:{refresh_interval:30,destructive_mode:1},request:async fields=>{
  calls.push(structuredClone(fields));
  if(fields.cmd==='inventory'){if(failInventory)throw Error('Inventory unavailable');return {op:'getAll',data:structuredClone(data)};}
  if(fields.cmd==='conversionjobs')return {jobs:[],worker_running:false};
  if(fields.cmd==='pooldiagnostics')throw Error('Unavailable');
  if(fields.cmd==='getdatasetproperties')return structuredClone(fields.zdataset==='cache/first'?first:parent);
  if(fields.cmd==='previewdestroy')return {target:fields.snapshot,preview_id:'b'.repeat(32),token:'a'.repeat(64),expires:1792195200,can_destroy:true,objects:[{name:fields.snapshot,guid:'300',type:'snapshot'}],dependencies:[],preview:'would destroy '+fields.snapshot};
  if(fields.cmd==='destroysnapshot')return {succeeded:{[fields.snapshot]:'Deleted synthetic snapshot'},failed:{}};
  throw Error('Unexpected '+fields.cmd);
 }});
 await settle();root.querySelector('[data-node="cache/first"]').click();button({root},'Snapshots').click();await settle();
 return {dom,w,root,app,data,calls,setFail(value){failInventory=value;},close(){app.stop();w.close();}};
}

test('Dataset chooser navigates only current-pool datasets and preserves direct snapshot scope',async()=>{
 const x=await setup();try{
  const select=control(x,'Dataset');assert.ok(select,'Snapshots must expose a Dataset chooser');
  assert.deepEqual([...select.options].map(option=>option.value),['cache','cache/first','cache/second']);
  assert.equal(select.value,'cache/first');choose(x,'cache/second');
  assert.equal(x.app.getState().selection,'cache/second');assert.equal(x.app.getState().tab,'snapshots');
  assert.match(x.root.querySelector('.zfsm-snapshot-scope').textContent,/cache\/second.*Direct snapshots only/);
  assert.deepEqual([...x.root.querySelectorAll('tbody input[type=checkbox]')].map(input=>input.value),['cache/second@s0']);
  assert.equal(x.calls.some(call=>['snapshotdataset','destroysnapshot'].includes(call.cmd)),false);
 }finally{x.close();}
});

test('switching datasets clears visible and offscreen bulk selections before opening a new preview',async()=>{
 const x=await setup();try{
  check(x,'cache/first@s0');button(x,'Next snapshots page').click();check(x,'cache/first@s50');
  assert.match(x.root.textContent,/2 selected across all pages/);choose(x,'cache/second');
  assert.equal(button(x,'Destroy selected snapshots').disabled,true);assert.equal(x.root.querySelector('tbody input').checked,false);
  check(x,'cache/second@s0');button(x,'Destroy selected snapshots').click();x.root.querySelector('[data-preview]').click();await settle();
  const previews=x.calls.filter(call=>call.cmd==='previewdestroy');assert.equal(previews.length,1);assert.equal(previews[0].snapshot,'cache/second@s0');
  assert.doesNotMatch(x.root.querySelector('.zfsm-action-dialog').textContent,/cache\/first@s/);
  const ack=x.root.querySelector('[name=acknowledge]');ack.checked=true;ack.dispatchEvent(new x.w.Event('change',{bubbles:true}));
  x.root.querySelector('.zfsm-action-dialog form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));x.root.querySelector('[data-confirm-operation]').click();await settle();
  const mutations=x.calls.filter(call=>call.cmd==='destroysnapshot');assert.equal(mutations.length,1);assert.equal(mutations[0].snapshot,'cache/second@s0');assert.equal(mutations[0].expected_guid,'3');assert.equal(mutations[0].snapshot_guid,'300');
 }finally{x.close();}
});

test('stale inventory permits Dataset navigation but cannot enable mutations until a successful refresh',async()=>{
 const x=await setup();try{
  x.setFail(true);x.app.refresh();await settle();assert.equal(button(x,'Take Snapshot').disabled,true);
  assert.ok(control(x,'Dataset'),'Snapshots must expose a Dataset chooser');assert.equal(control(x,'Dataset').disabled,false);choose(x,'cache/second');
  assert.equal(x.app.getState().selection,'cache/second');assert.equal(button(x,'Take Snapshot').disabled,true);assert.equal(button(x,'Destroy selected snapshots').disabled,true);
  x.setFail(false);x.app.refresh();await settle();assert.equal(button(x,'Take Snapshot').disabled,false);
  assert.equal(control(x,'Dataset').value,'cache/second');assert.equal(x.calls.some(call=>call.cmd==='snapshotdataset'),false);
 }finally{x.close();}
});

test('disposed and forged Dataset chooser values cannot select unavailable targets',async()=>{
 const x=await setup();try{
  const old=control(x,'Dataset');assert.ok(old,'Snapshots must expose a Dataset chooser');choose(x,'cache/second');
  old.value='cache/first';old.dispatchEvent(new x.w.Event('change',{bubbles:true}));assert.equal(x.app.getState().selection,'cache/second');
  const select=control(x,'Dataset'),option=x.w.document.createElement('option');option.value='other';select.append(option);choose(x,'other');assert.equal(x.app.getState().selection,'cache/second');
  delete x.data.datasets.cache.child.first;x.app.refresh();await settle();assert.equal([...control(x,'Dataset').options].some(option=>option.value==='cache/first'),false);
 }finally{x.close();}
});
