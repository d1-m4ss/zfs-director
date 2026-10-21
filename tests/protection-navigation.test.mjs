import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {protectionUXFixture} from './fixtures/protection-ux.mjs';
const settle=async()=>{for(let n=0;n<60;n++)await Promise.resolve();};
async function mount(palette='white',installed=true,state='healthy'){
 const dom=new JSDOM('<main id="zfsm-workspace"></main>',{url:'http://fixture.local/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,root=w.document.querySelector('main');
 w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.zfsmFormatDateTime=String;
 for(const file of ['ZFSMInventory.js','ZFSMForms.js','ZFSMSnapshots.js','ZFSMExplorer.js','ZFSMPoolView.js','ZFSMOverview.js','ZFSMHistory.js','ZFSMProtection.js','ZFSMWorkspace.js'])w.eval(readFileSync('src/frontend/'+file,'utf8'));
 const app=w.zfsmCreateWorkspace({root,hostTheme:palette,config:{refresh_interval:0},request:async fields=>{
  if(fields.cmd==='conversionjobs')return {jobs:[],worker_running:false};
  if(fields.cmd==='protectiondata')return protectionUXFixture();
  if(fields.cmd==='protectiondetect')return {installed,enabled:state==='healthy',visible:installed&&state==='healthy',compatible:installed&&state!=='untrusted',state:installed?state:'missing',issues:[],sanoid:{version:'2.3.0'},syncoid:{version:'2.3.0'}};
  throw Error('Unexpected '+fields.cmd);
 }});await settle();return {w,root,app,close(){app.stop();w.close();}};
}
for(const palette of ['white','black','gray','azure'])test('Data Protection and Replication preserve '+palette+' host theme and both view modes',async()=>{
 const t=await mount(palette);try{const nav=t.root.querySelector('.zfsm-global-nav'),entry=nav.querySelector('[data-section=protection]');assert.equal(entry.hidden,false);assert.equal(entry.textContent,'Snapshot Policies');assert.deepEqual([...nav.querySelectorAll('[data-section]')].map(n=>n.textContent),['Overview','Datasets','Snapshot Policies','Replication','Jobs','Settings']);entry.click();await settle();assert.equal(t.root.dataset.palette,palette);assert.equal(t.root.dataset.followHost,'true');assert.equal(t.root.querySelector('.zfsm-pools').hidden,true);assert.equal(t.root.querySelector('[aria-label="Data Protection sections"]'),null);for(const b of t.root.querySelectorAll('[data-layout-choice]'))assert.equal(b.hidden,false);t.root.querySelector('[data-layout-choice=table]').click();await settle();assert.equal(t.app.getState().layout,'table');assert.ok(t.root.querySelector('[data-policy-id]'));assert.equal(t.root.querySelector('[data-protection-inspector]'),null);nav.querySelector('[data-section=replication]').click();await settle();assert.ok(t.root.querySelector('[name=replication_search]'));nav.querySelector('[data-section=datasets]').click();await settle();assert.equal(t.root.querySelector('.zfsm-pools').hidden,false);assert.equal(t.root.dataset.palette,palette);}finally{t.close();}
});
for(const [installed,state]of [[false,'missing'],[true,'disabled'],[true,'untrusted']])test(state+' plugin hides working sections and retains real Settings diagnostics',async()=>{const t=await mount('white',installed,state);try{assert.equal(t.root.querySelector('[data-section=protection]').hidden,true);assert.equal(t.root.querySelector('[data-section=replication]').hidden,true);const settings=t.root.querySelector('[data-section=settings]');assert.equal(settings.hidden,false);settings.click();await settle();assert.ok(t.root.querySelector('[name=integration_enabled]'));assert.equal(t.root.querySelector('[aria-label="Data Protection sections"]'),null);}finally{t.close();}});
