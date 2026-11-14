import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';

const settle=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
const object={name:'cache/data',type:'filesystem',guid:'1',origin:'-',mountpoint:'/mnt/cache/data',encryptionroot:'cache/data',userrefs:'-',defer_destroy:'-'};
const preview=target=>({target,type:'snapshot',recursive:false,objects:[{...object,name:target,type:'snapshot'}],dependencies:[],preview:'would destroy '+target,can_destroy:true,preview_id:'b'.repeat(32),token:'a'.repeat(64),expires:1792195200});
async function setup(snapshots,destroy){
 const dom=new JSDOM('<main><div class="zfsm-action-dialog"><div id="host"></div></div></main>',{runScripts:'outside-only'}),w=dom.window,host=w.document.querySelector('#host');
 w.eval(readFileSync('src/frontend/ZFSMForms.js','utf8'));
 const forms=w.zfsmCreateInlineForms({getConfig:()=>({destructive_mode:1}),request:async fields=>fields.cmd==='previewdestroy'?preview(fields.snapshot):destroy(fields)});
 await forms.render(host,'destroysnapshot',{pool:'cache',dataset:'cache/data',type:'filesystem',node:{...object},snapshots});
 host.querySelector('[data-preview]').click();await settle();
 const ack=host.querySelector('[name=acknowledge]');ack.checked=true;ack.dispatchEvent(new w.Event('change',{bubbles:true}));
 host.querySelector('button[type=submit]').click();await settle();
 host.querySelector('[data-confirm-operation]').click();await settle();
 return {host,close(){forms.dispose();w.close();}};
}
const buttons=host=>[...host.querySelectorAll('button')].map(b=>b.textContent);
const controls=host=>host.querySelectorAll('input,select,textarea').length;

test('after one snapshot is destroyed the dialog shows only the result and Close',async()=>{
 const x=await setup(['cache/data@s1'],()=>({succeeded:{done:'Done'},failed:{}}));
 try{
  assert.equal(controls(x.host),0);
  assert.deepEqual(buttons(x.host),['Close']);
  assert.equal(x.host.querySelector('.zfsm-form-target').textContent,'Target: cache/data');
  assert.equal(x.host.querySelector('.zfsm-result-heading').textContent,'✓Destroyed 1 snapshot');
  assert.deepEqual([...x.host.querySelectorAll('li')].map(li=>li.textContent),['cache/data@s1']);
  assert.doesNotMatch(x.host.textContent,/See each snapshot|Load fresh preview|I understand|Also destroy|Operation successful/);
 }finally{x.close();}
});
test('after several snapshots are destroyed the dialog lists their names',async()=>{
 const x=await setup(['cache/data@s1','cache/data@s2'],()=>({succeeded:{done:'Done'},failed:{}}));
 try{
  assert.equal(controls(x.host),0);
  assert.deepEqual(buttons(x.host),['Close']);
  assert.equal(x.host.querySelector('.zfsm-result-heading').textContent,'✓Destroyed 2 snapshots');
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
