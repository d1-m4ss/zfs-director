import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
const settle=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
test('property Save reports effective readback inline without overwriting unrelated drafts',async()=>{
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window,root=w.document.querySelector('main');w.eval(readFileSync('src/frontend/ZFSMForms.js','utf8'));
 let saved=false;const forms=w.zfsmCreateInlineForms({request:async data=>{if(data.cmd==='editdatasetproperty'){saved=true;return {succeeded:{compression:'Saved'},failed:{}};}return {name:'cache/data',type:'filesystem',guid:'2',compression:saved?'lz4':'off',quota:0,atime:'off',_sources:{compression:'inherited from cache'}};}});
 try{await forms.render(root,'editdatasetproperty',{pool:'cache',dataset:'cache/data',node:{guid:'2'}});root.querySelector('[name=quota]').value='1234';root.querySelector('[name=compression]').value='inherit';root.querySelector('[data-save-property=compression]').click();root.querySelector('[data-confirm-operation]').click();await settle();const field=root.querySelector('[data-field=compression]');assert.match(field.textContent,/Saved.*lz4/);assert.match(field.textContent,/inherited from cache/);assert.equal(root.querySelector('[name=quota]').value,'1234');assert.equal(root.querySelector('[name=compression]').value,'lz4');}finally{forms.dispose();w.close();}
});
test('property backend errors remain next to the field',async()=>{
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window,root=w.document.querySelector('main');w.eval(readFileSync('src/frontend/ZFSMForms.js','utf8'));
 const forms=w.zfsmCreateInlineForms({request:async data=>data.cmd==='editdatasetproperty'?{succeeded:{},failed:{quota:'No space available'}}:data.cmd==='previewspaceproperty'?{preview_id:'b'.repeat(32),token:'a'.repeat(64),review:{kind:'space_property',name:'cache/data',property:'quota',requested:'1',previous:'0',expected:'1',source:'default',can_proceed:true}}:{type:'filesystem',quota:0}});
 try{await forms.render(root,'editdatasetproperty',{dataset:'cache/data'});root.querySelector('[name=quota]').value='1';root.querySelector('[data-save-property=quota]').click();await settle();root.querySelector('[data-confirm-operation]').click();await settle();assert.match(root.querySelector('[data-field=quota]').textContent,/Failed.*No space available/);}finally{forms.dispose();w.close();}
});
test('Properties opened during stale inventory builds after successful refresh',async()=>{
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window,root=w.document.querySelector('main');w.eval(readFileSync('src/frontend/ZFSMForms.js','utf8'));let stale=true;
 const forms=w.zfsmCreateInlineForms({getOperationIssue:()=>stale?'Inventory is stale':'',request:async()=>({type:'filesystem',compression:'lz4'})});
 try{await forms.render(root,'editdatasetproperty',{dataset:'cache/data'});assert.equal(root.querySelector('[name=compression]'),null);stale=false;await forms.render(root,'editdatasetproperty',{dataset:'cache/data'});assert.ok(root.querySelector('[name=compression]'));assert.equal(root.querySelector('[data-save-property=compression]').disabled,false);}finally{forms.dispose();w.close();}
});
test('space property confirmation waits for signed native scope instead of trusting cached quota',async()=>{
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window,root=w.document.querySelector('main'),calls=[];w.eval(readFileSync('src/frontend/ZFSMForms.js','utf8'));const forms=w.zfsmCreateInlineForms({request:async data=>{calls.push(data);return data.cmd==='previewspaceproperty'?{preview_id:'b'.repeat(32),token:'a'.repeat(64),review:{kind:'space_property',name:'cache/data',guid:'2',property:'quota',requested:'1G',previous:'0',expected:'1073741824',source:'default',can_proceed:true}}:{type:'filesystem',guid:'2',quota:0};}});
 try{await forms.render(root,'editdatasetproperty',{dataset:'cache/data',node:{guid:'2'}});root.querySelector('[name=quota]').value='1G';root.querySelector('[data-save-property=quota]').click();await settle();assert.equal(calls.at(-1).cmd,'previewspaceproperty');assert.match(root.querySelector('.zfsm-confirmation').textContent,/1073741824/);}finally{forms.dispose();w.close();}
});
