import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';

async function form(){
 const dom=new JSDOM('<main></main>',{url:'http://fixture.local',runScripts:'outside-only'}),w=dom.window,host=w.document.querySelector('main'),calls=[];let issue='';
 w.eval(readFileSync('src/frontend/ZFSMForms.js','utf8'));
 const context={pool:'cache',dataset:'cache/synthetic',node:{name:'cache/synthetic',type:'filesystem',guid:'123'}},forms=w.zfsmCreateInlineForms({getOperationIssue:()=>issue,getMutationFields:()=>({expected_guid:'123'}),request:async fields=>{calls.push(fields);return {succeeded:{'cache/synthetic':0},failed:{}};}});
 await forms.render(host,'removedirectorylisting',context);
 const submit=()=>host.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 return {w,host,calls,submit,refresh:async message=>{issue=message;await forms.render(host,'removedirectorylisting',context);},close(){forms.dispose();w.close();}};
}
test('pending confirmation remains visible and disabled through transient inventory refresh, then confirms same immutable target once',async()=>{
 const x=await form();try{x.submit();const pending=x.host.querySelector('[data-confirm-operation]');assert.ok(pending);pending.focus();await x.refresh('Stale inventory while reading');assert.equal(x.host.querySelector('[data-confirm-operation]'),pending,'Refresh must not discard the review');assert.equal(pending.disabled,true);pending.dispatchEvent(new x.w.MouseEvent('click',{bubbles:true}));assert.equal(x.calls.length,0,'Blocked confirmation cannot issue a request even through synthetic click');
 // The guarded click above retires this review, so obtain a fresh review before
 // testing preservation through a normal refresh with no click while disabled.
 await x.refresh('');x.submit();const review=x.host.querySelector('[data-confirm-operation]');review.focus();await x.refresh('Stale inventory while reading');assert.equal(review.disabled,true);await x.refresh('');assert.equal(x.host.querySelector('[data-confirm-operation]'),review);assert.equal(review.disabled,false);assert.equal(x.w.document.activeElement,review);review.click();review.click();for(let i=0;i<20;i++)await Promise.resolve();assert.equal(x.calls.length,1);assert.equal(x.calls[0].zdataset,'cache/synthetic');assert.equal(x.calls[0].expected_guid,'123');
 }finally{x.close();}
});
test('changed target keeps an existing confirmation blocked and editing still retires it',async()=>{
 const x=await form();try{x.submit();await x.refresh('Selected dataset GUID changed; reselect');const review=x.host.querySelector('[data-confirm-operation]');assert.ok(review);assert.equal(review.disabled,true);review.click();assert.equal(x.calls.length,0);await x.refresh('');x.submit();x.host.querySelector('form').dispatchEvent(new x.w.Event('change',{bubbles:true}));assert.equal(x.host.querySelector('[data-confirm-operation]'),null);assert.equal(x.calls.length,0);}finally{x.close();}
});
