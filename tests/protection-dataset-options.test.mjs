import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
const settle=async()=>{for(let n=0;n<100;n++)await Promise.resolve();};
async function fixture(names=['cache/current']){
 const dom=new JSDOM('<main></main>',{url:'http://fixture.local/',runScripts:'outside-only'}),w=dom.window,root=w.document.querySelector('main'),calls=[];let failData=false;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.eval(readFileSync('src/frontend/ZFSMProtection.js','utf8'));
 const detection={visible:true,compatible:true,installed:true,enabled:true,state:'healthy',issues:[],sanoid:{version:'2.3.0'},syncoid:{version:'2.3.0'}},data={datasets:names.map(name=>({name,guid:'123'})),policies:[],replications:[],jobs:[],templates:{},scheduler:{external:[],issues:[]},issues:[],credentials:[]};
 const app=w.zfsmCreateProtection({root,getDatasets:()=>['cache/deleted'],request:async fields=>{calls.push(fields);if(failData&&fields.cmd==='protectiondata')throw Error('Synthetic discovery failure');return fields.cmd==='protectiondetect'?detection:structuredClone(data);}});
 const button=label=>{const b=[...root.querySelectorAll('button')].find(b=>b.textContent===label);assert.ok(b,label);return b;};
 return {w,root,data,calls,app,button,fail:()=>failData=true,close(){app.stop();w.close();}};
}
for(const names of [['cache/current'],[]])for(const screen of ['policies','replication'])test('new '+screen+' uses only fresh dataset discovery: '+JSON.stringify(names),async()=>{
 const x=await fixture(names);try{await x.app.render(screen);x.button(screen==='policies'?'New policy':'New replication').click();const select=x.root.querySelector(screen==='policies'?'[name=dataset]':'[name=source]');assert.deepEqual([...select.options].map(o=>o.value),['',...names]);assert.equal(x.calls.some(c=>/save|run$/.test(c.cmd)),false);}finally{x.close();}
});
test('editing a missing policy shows its old source explicitly unavailable and prevents preview',async()=>{
 const x=await fixture();try{x.data.policies=[{id:'managed-missing',name:'Existing policy',owner:'managed',dataset:'cache/deleted',dataset_present:false,enabled:false,hourly:24,daily:7}];await x.app.render('policies');x.root.querySelector('[data-edit-policy]').click();await settle();const select=x.root.querySelector('[name=dataset]');assert.equal(select.value,'cache/deleted');assert.equal(select.selectedOptions[0].disabled,true);assert.match(select.selectedOptions[0].textContent,/unavailable/i);x.button('Review changes').click();await settle();assert.equal(x.calls.some(c=>c.cmd==='protectionpolicypreview'),false);}finally{x.close();}
});

for(const value of [null,{},'cache/current'])test('invalid fresh discovery never falls back to cached names: '+JSON.stringify(value),async()=>{
 const x=await fixture();try{x.data.datasets=value;await x.app.render('policies');x.button('New policy').click();assert.deepEqual([...x.root.querySelector('[name=dataset]').options].map(o=>o.value),['']);}finally{x.close();}
});
test('editing missing replication source keeps it visibly unavailable and blocks Next',async()=>{
 const x=await fixture();try{x.data.replications=[{id:'managed-missing',name:'Existing replication',owner:'managed',source:'cache/deleted',target:'backup/a',enabled:false}];await x.app.render('replication');x.button('Edit').click();await settle();const source=x.root.querySelector('[name=source]');assert.equal(source.value,'cache/deleted');assert.equal(source.selectedOptions[0].disabled,true);x.button('Next').click();assert.equal(x.root.querySelector('[name=target]'),null);assert.match(x.root.textContent,/Choose an available source dataset/);assert.equal(x.calls.some(c=>c.cmd==='protectionreplicationpreview'),false);}finally{x.close();}
});

for(const screen of ['policies','replication'])test('External transfer '+screen+' offers only authoritative sources',async()=>{
 const x=await fixture();try{x.data.scheduler.external=[{id:'external-row',source_id:'source-1',file:'/boot/config/plugins/user.scripts/scripts/Test/script',source_kind:'user_script',schedule_state:'disabled',schedule:'0 3 * * *',datasets:['cache/deleted'],review:true,transfer_supported:true,ownership_state:'external'}];await x.app.render(screen);x.button('Review transfer').click();const select=x.root.querySelector(screen==='policies'?'[name=dataset]':'[name=source]');assert.deepEqual([...select.options].map(o=>o.value),['','cache/current']);assert.equal(x.calls.some(c=>c.cmd==='protectionexternaltransfer'),false);}finally{x.close();}
});
test('failed fresh discovery exposes no creation form or cached choices',async()=>{
 const x=await fixture();try{await x.app.render('policies');x.fail();await x.app.render('policies');assert.match(x.root.textContent,/Synthetic discovery failure/);assert.equal([...x.root.querySelectorAll('button')].some(b=>b.textContent==='New policy'),false);assert.equal(x.root.querySelector('[name=dataset]'),null);}finally{x.close();}
});
