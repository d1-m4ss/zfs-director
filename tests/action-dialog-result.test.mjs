import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';

const settle=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
const object={name:'cache/data',type:'filesystem',guid:'1',origin:'-',mountpoint:'/mnt/cache/data',encryptionroot:'cache/data',userrefs:'-',defer_destroy:'-'};
const preview=target=>({target,type:'snapshot',recursive:false,objects:[{...object,name:target,type:'snapshot'}],dependencies:[],preview:'would destroy '+target,can_destroy:true,preview_id:'b'.repeat(32),token:'a'.repeat(64),expires:1792195200});
async function setup(snapshots,destroy,action='destroysnapshot',context={}){
 const dom=new JSDOM('<main><div class="zfsm-action-dialog"><div id="host"></div></div></main>',{runScripts:'outside-only'}),w=dom.window,host=w.document.querySelector('#host');
 w.eval(readFileSync('src/frontend/ZFSMForms.js','utf8'));
 const calls=[];
 const forms=w.zfsmCreateInlineForms({getConfig:()=>({destructive_mode:1}),request:async fields=>{calls.push(fields);return fields.cmd==='previewdestroy'?(action==='destroydataset'?{...preview('cache/data'),type:'filesystem',target:'cache/data'}:preview(fields.snapshot)):destroy(fields);}});
 await forms.render(host,action,{pool:'cache',dataset:'cache/data',type:'filesystem',node:{...object},snapshots,...context});
 const x={w,host,calls,forms,close(){forms.dispose();w.close();}};
 await attempt(x);
 return x;
}
async function attempt(x){
 const {w,host}=x;
 host.querySelector('[data-preview]')?.click();await settle();
 const ack=host.querySelector('[name=acknowledge]');if(ack){ack.checked=true;ack.dispatchEvent(new w.Event('change',{bubbles:true}));}
 host.querySelector('button[type=submit]').click();await settle();
 host.querySelector('[data-confirm-operation]').click();await settle();
}
const resultText=host=>host.querySelector('[aria-live=polite]').textContent;
const buttons=host=>[...host.querySelectorAll('button')].map(b=>b.textContent);
const controls=host=>host.querySelectorAll('input,select,textarea').length;

test('after one snapshot is destroyed the dialog shows only the result and Close',async()=>{
 const x=await setup(['cache/data@s1'],()=>({succeeded:{done:'Done'},failed:{}}));
 try{
  assert.equal(controls(x.host),0);
  assert.deepEqual(buttons(x.host),['Close']);
  assert.equal(x.host.querySelector('.zfsm-form-target').textContent,'Target: cache/data');
  assert.equal(resultText(x.host),'✓Destroyed 1 snapshotcache/data@s1','only the heading and the names, no "no result" line');
  assert.deepEqual([...x.host.querySelectorAll('li')].map(li=>li.textContent),['cache/data@s1']);
  assert.doesNotMatch(x.host.textContent,/See each snapshot|Load fresh preview|I understand|Also destroy|Operation successful/);
 }finally{x.close();}
});
test('after several snapshots are destroyed the dialog lists their names',async()=>{
 const x=await setup(['cache/data@s1','cache/data@s2'],()=>({succeeded:{done:'Done'},failed:{}}));
 try{
  assert.equal(controls(x.host),0);
  assert.deepEqual(buttons(x.host),['Close']);
  assert.equal(resultText(x.host),'✓Destroyed 2 snapshotscache/data@s1cache/data@s2');
  assert.deepEqual([...x.host.querySelectorAll('li')].map(li=>li.textContent),['cache/data@s1','cache/data@s2']);
 }finally{x.close();}
});
test('after a partial failure the form and the snapshot checkboxes stay',async()=>{
 const x=await setup(['cache/data@s1','cache/data@s2'],fields=>fields.snapshot.endsWith('s2')?{succeeded:{},failed:{snapshot:'dataset is busy'}}:{succeeded:{done:'Done'},failed:{}});
 try{
  assert.equal(x.host.querySelector('.zfsm-result-heading').textContent,'Partially completed');
  assert.ok(x.host.querySelectorAll('input[type=checkbox]').length>=3,'snapshot rows and confirmation checkboxes stay');
  assert.ok(buttons(x.host).includes('Close'));
  assert.ok(x.host.querySelector('button[type=submit]'),'the submit button stays for a retry');
  assert.match(x.host.textContent,/Deleted: 1\. Failed or not attempted: 1\./);
 }finally{x.close();}
});

test('a finished action cannot be submitted a second time',async()=>{
 const x=await setup([],()=>({succeeded:{done:'Done'},failed:{}}),'holdsnapshot',{snapshot:'cache/data@s1'});
 try{
  assert.equal(x.calls.filter(c=>c.cmd==='holdsnapshot').length,1);
  x.host.querySelector('form').requestSubmit();await settle();
  assert.equal(x.calls.filter(c=>c.cmd==='holdsnapshot').length,1,'the second submit sends nothing');
  assert.deepEqual(buttons(x.host),['Close']);assert.equal(controls(x.host),0);
 }finally{x.close();}
});
test('a queued deletion also leaves only its result, the Jobs link and Close',async()=>{
 const x=await setup([],()=>({succeeded:{job:'Queued'},failed:{},job:{id:'20261114-120000-aaaaaaaaaaaa',schema:6,state:'queued'}}),'destroydataset');
 try{
  assert.equal(controls(x.host),0);
  assert.deepEqual(buttons(x.host),['View deletion progress','Close']);
  assert.equal(resultText(x.host),'✓Startedjob: Queued The operation has not finished. Follow its stage and progress in Jobs.View deletion progress');
  assert.doesNotMatch(x.host.textContent,/Load fresh preview|I understand/);
 }finally{x.close();}
});
test('a verified-false deletion outcome stays visible after success',async()=>{
 const x=await setup(['cache/data@s1'],()=>({succeeded:{done:'Done'},failed:{},destruction:{attempted:true,state_verified:false,removed:['cache/data@s1']}}),'destroydataset');
 try{
  assert.equal(x.host.querySelector('[data-destroy-outcome] p').textContent,'Current state is unverified. Inspect actual state before retrying.');
  assert.equal(controls(x.host),0);
 }finally{x.close();}
});
test('a verified deletion outcome with only Removed is not shown',async()=>{
 const x=await setup(['cache/data@s1'],()=>({succeeded:{done:'Done'},failed:{},destruction:{attempted:true,state_verified:true,removed:['cache/data@s1']}}),'destroydataset');
 try{assert.equal(x.host.querySelector('[data-destroy-outcome]'),null);}finally{x.close();}
});
test('names destroyed by an earlier attempt are counted and listed with the later ones',async()=>{
 let second=false;
 const x=await setup(['cache/data@s1','cache/data@s2'],fields=>fields.snapshot.endsWith('s2')&&!second?{succeeded:{},failed:{snapshot:'dataset is busy'}}:{succeeded:{done:'Done'},failed:{}});
 try{
  assert.equal(resultText(x.host).startsWith('Partially completed'),true);
  second=true;await attempt(x);
  assert.equal(resultText(x.host),'✓Destroyed 2 snapshotscache/data@s1cache/data@s2');
  assert.deepEqual(buttons(x.host),['Close']);
 }finally{x.close();}
});
test('a cancel request is titled Cancellation requested, not Started, and does not repeat itself',async()=>{
 const x=await setup([],()=>({succeeded:{'20261114-120000-aaaaaaaaaaaa':'Cancellation requested; partial data retained'},failed:{},job:{id:'20261114-120000-aaaaaaaaaaaa',schema:1,state:'running'}}),'cancelconversion',{job:{id:'20261114-120000-aaaaaaaaaaaa'}});
 try{
  assert.equal(resultText(x.host),'✓Cancellation requested20261114-120000-aaaaaaaaaaaa: Partial data retained The operation has not finished. Follow its stage and progress in Jobs.View progress in Jobs');
  assert.equal(controls(x.host),0);
 }finally{x.close();}
});
