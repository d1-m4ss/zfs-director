import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';

test('creation review identifies the new full dataset path rather than the selected existing dataset',async()=>{
 const dom=new JSDOM('<main></main>',{url:'http://fixture.local',runScripts:'outside-only'}),w=dom.window,root=w.document.querySelector('main'),calls=[];
 w.eval(readFileSync('src/frontend/ZFSMForms.js','utf8'));
 const forms=w.zfsmCreateInlineForms({getConfig:()=>({destructive_mode:1}),getDatasets:()=>['cache','cache/production'],getDataset:name=>({name,encryption:'off'}),request:async data=>{calls.push(data);return {succeeded:{},failed:{}};}});
 try{
  await forms.render(root,'createdataset',{pool:'cache',dataset:'cache/production',type:'filesystem',node:{name:'cache/production',guid:'2',encryption:'off'}});
  const input=root.querySelector('[name=name]');input.value='zfs-director-acceptance-test';input.dispatchEvent(new w.Event('input',{bubbles:true}));
  root.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  const target=root.querySelector('.zfsm-confirmation .zfsm-form-target');assert.ok(target);
  assert.equal(target.textContent,'Target: cache/zfs-director-acceptance-test');
  assert.equal(calls.length,0,'review alone must not mutate');
  root.querySelector('[data-confirm-operation]').click();for(let i=0;i<20;i++)await Promise.resolve();
  assert.equal(calls[0].data.zpool,'cache');assert.equal(calls[0].data.name,'zfs-director-acceptance-test');
 }finally{forms.dispose();w.close();}
});
