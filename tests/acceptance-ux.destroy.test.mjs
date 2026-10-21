import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';

const settle=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const object={name:'cache/data',type:'filesystem',guid:'18446744073709551615',origin:'-',mountpoint:'/mnt/cache/data',encryptionroot:'cache/data',userrefs:'-',defer_destroy:'-'};
const snapshot={name:'cache/data@s1',type:'snapshot',guid:'99',origin:'-',mountpoint:'-',encryptionroot:'-',userrefs:'1',defer_destroy:'off',holds:'cache/data@s1\tmanual-protection\t2026-10-16'};
const clone={name:'cache/outside-clone',type:'filesystem',guid:'100',origin:'cache/data@s1',mountpoint:'/mnt/cache/outside-clone',encryptionroot:'none',userrefs:'-',defer_destroy:'-'};
const review=(target,overrides={})=>({target,type:target.includes('@')?'snapshot':'filesystem',recursive:false,objects:[object,snapshot],dependencies:[clone],preview:'would destroy '+target,can_destroy:true,preview_id:'b'.repeat(32),token:'a'.repeat(64),expires:1792195200,...overrides});

async function setup(action='destroydataset',answer=review('cache/data'),result={succeeded:{done:'Done'},failed:{}}){
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window,root=w.document.querySelector('main'),calls=[];
 w.eval(readFileSync('src/frontend/ZFSMForms.js','utf8'));
 const forms=w.zfsmCreateInlineForms({getConfig:()=>({destructive_mode:1}),request:async fields=>{calls.push(fields);if(fields.cmd==='previewdestroy')return typeof answer==='function'?answer(fields):answer;return result;}});
 await forms.render(root,action,{pool:'cache',dataset:'cache/data',type:'filesystem',node:{...object},snapshots:action==='destroysnapshot'?['cache/data@s1','cache/data@s2']:[]});
 root.querySelector('[data-preview]').click();await settle();
 return {w,root,calls,close(){forms.dispose();w.close();}};
}
function acknowledge(x){const ack=x.root.querySelector('[name=acknowledge]');ack.checked=true;ack.dispatchEvent(new x.w.Event('change',{bubbles:true}));}

test('dataset deletion review exposes exact objects, identities and external clone dependencies as text',async()=>{
 const x=await setup('destroydataset',review('cache/data',{objects:[object,{...snapshot,holds:'<img src=x onerror=alert(1)> manual-protection'}]}));
 try{
  const scope=x.root.querySelector('.zfsm-preview');
  assert.match(scope.textContent,/2 objects/);assert.match(scope.textContent,/1 dataset/);assert.match(scope.textContent,/1 snapshot/);
  for(const value of ['cache/data','filesystem','18446744073709551615','/mnt/cache/data','Encryption root','cache/data@s1','manual-protection','cache/outside-clone','100','/mnt/cache/outside-clone','Clone dependencies','would destroy cache/data'])assert.ok(scope.textContent.includes(value),value);
  assert.equal(scope.querySelector('img'),null);assert.match(scope.textContent,/permanent|irreversible/i);
 }finally{x.close();}
});

test('a blocked dataset preview remains inspectable and cannot reach mutation confirmation',async()=>{
 const x=await setup('destroydataset',review('cache/data',{can_destroy:false}));try{
  assert.match(x.root.querySelector('.zfsm-preview').textContent,/blocked/i);acknowledge(x);
  assert.equal(x.root.querySelector('button[type=submit]').disabled,true);
  x.root.querySelector('form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));
  assert.equal(x.root.querySelector('[data-confirm-operation]'),null);assert.equal(x.calls.some(c=>c.cmd==='destroydataset'),false);
 }finally{x.close();}
});

test('batch snapshot deletion shows each reviewed scope and blocks the batch if any target is blocked',async()=>{
 const x=await setup('destroysnapshot',fields=>review(fields.snapshot,{objects:[{...snapshot,name:fields.snapshot}],dependencies:fields.snapshot.endsWith('s2')?[clone]:[],can_destroy:!fields.snapshot.endsWith('s2')}));try{
  const scope=x.root.querySelector('.zfsm-preview');
  assert.match(scope.textContent,/cache\/data@s1/);assert.match(scope.textContent,/cache\/data@s2/);assert.match(scope.textContent,/Clone dependencies/);assert.match(scope.textContent,/cache\/outside-clone/);assert.match(scope.textContent,/99/);
  acknowledge(x);assert.equal(x.root.querySelector('button[type=submit]').disabled,true);assert.equal(x.calls.filter(c=>c.cmd==='previewdestroy').length,2);
 }finally{x.close();}
});

test('partial preview metadata is labelled unknown rather than inventing absent dependencies or identities',async()=>{
 const x=await setup('destroydataset',review('cache/data',{objects:[{name:'cache/data'}],dependencies:undefined}));try{
  const scope=x.root.querySelector('.zfsm-preview');assert.match(scope.textContent,/Unknown/);assert.match(scope.textContent,/Clone dependencies/);assert.match(scope.textContent,/1 object/);assert.doesNotMatch(scope.textContent,/No clone dependencies|0 clone dependencies/);
  acknowledge(x);assert.equal(x.root.querySelector('button[type=submit]').disabled,false);
 }finally{x.close();}
});

for(const action of ['destroydataset','destroysnapshot'])test(action+' requires explicit backend permission in the preview',async()=>{
 const x=await setup(action,fields=>review(fields.snapshot||'cache/data',{can_destroy:undefined,objects:[object],dependencies:[]}));try{
  acknowledge(x);assert.equal(x.root.querySelector('button[type=submit]').disabled,true);
 }finally{x.close();}
});


test('destroy preview explains Linux Force limits and names foreign namespace blockers safely',async()=>{
 const x=await setup('destroydataset',review('cache/data',{can_destroy:false,diagnostics:{complete:true,blocked:true,blockers:[{dataset:'cache/data',kind:'foreign_mount',mountpoint:'/cache/data',pid:42,command:'<img src=x>',namespace:'mnt:[5]',container:'a'.repeat(64)}],warnings:[]}}));
 try{const preview=x.root.querySelector('.zfsm-preview');assert.match(x.root.textContent,/Linux.*cannot.*busy|busy.*Linux/);for(const text of ['42','foreign','/cache/data','mnt:[5]','<img src=x>','fresh preview'])assert.ok(preview.textContent.includes(text),text);assert.equal(preview.querySelector('img'),null);acknowledge(x);assert.equal(x.root.querySelector('button[type=submit]').disabled,true);}finally{x.close();}
});

test('partial destroy has a separate verified outcome and requires a new preview without automatic retry',async()=>{
 const x=await setup('destroydataset',review('cache/data',{objects:[object],dependencies:[]}),{succeeded:{'cache/data@s1':'Destroyed; absence verified'},failed:{'cache/data':'dataset is busy'},destruction:{exit_code:1,state_verified:true,removed:['cache/data@s1'],remaining:['cache/data'],changed:[]}});
 try{acknowledge(x);x.root.querySelector('form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));x.root.querySelector('[data-confirm-operation]').click();await settle();assert.match(x.root.querySelector('[data-destroy-outcome]').textContent,/Remaining.*cache\/data/);assert.match(x.root.textContent,/fresh preview/);assert.equal(x.root.querySelector('button[type=submit]').disabled,true);assert.equal(x.calls.filter(c=>c.cmd==='destroydataset').length,1);x.root.querySelector('[data-preview]').click();await settle();assert.equal(x.calls.filter(c=>c.cmd==='previewdestroy').length,2);assert.equal(x.calls.filter(c=>c.cmd==='destroydataset').length,1);}finally{x.close();}
});

test('destroy diagnostics show container name with short ID and retain ID fallback as text',async()=>{
 const blockers=[{dataset:'cache/data',kind:'foreign_mount',mountpoint:'/cache/data',pid:42,command:'worker',namespace:'mnt:[5]',container:'a'.repeat(64),container_name:'qbittorrent'}, {dataset:'cache/data',kind:'foreign_mount',mountpoint:'/cache/data',pid:43,command:'worker',namespace:'mnt:[6]',container:'b'.repeat(64)}, {dataset:'cache/data',kind:'foreign_mount',mountpoint:'/cache/data',pid:44,command:'worker',namespace:'mnt:[7]',container:'c'.repeat(64),container_name:'<img src=x onerror=alert(1)>'}];
 const x=await setup('destroydataset',review('cache/data',{can_destroy:false,diagnostics:{blocked:true,blockers,warnings:[]}}));
 try{const preview=x.root.querySelector('.zfsm-preview');assert.match(preview.textContent,/Container qbittorrent \(aaaaaaaaaaaa\)/);assert.match(preview.textContent,/Container bbbbbbbbbbbb/);assert.ok(preview.textContent.includes('<img src=x onerror=alert(1)>'));assert.equal(preview.querySelector('img'),null);}finally{x.close();}
});
