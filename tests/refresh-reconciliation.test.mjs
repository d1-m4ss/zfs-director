import {installDialogs} from './helpers/dialogs.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';

const settle=async()=>{for(let n=0;n<120;n++)await Promise.resolve();};
const id='20261020-120000-000000000001',source='/mnt/cache/a/ordinary',target='cache/a/ordinary';
const ds=(name,guid)=>({name,guid,type:'filesystem',mountpoint:'/mnt/'+name,encryption:'off',keystatus:'none',child:{},directories:[],snapshots:[]});
async function fixture({type='conversion',interval=0,initial=true,holdInitial=false}={}){
 const dom=new JSDOM('<main id="zfsm-workspace"></main>',{url:'http://fixture.local/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,root=w.document.querySelector('main'),timers=new Map(),calls=[];let sequence=0,failObservation=false,holdObservation=holdInitial,releaseObservation;
 w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.scrollTo=()=>{};w.ResizeObserver=class{observe(){}disconnect(){}};w.zfsmFormatDateTime=String;w.setTimeout=(fn,ms)=>{timers.set(++sequence,{fn,ms});return sequence;};w.clearTimeout=n=>timers.delete(n);
 installDialogs(w);
 for(const name of ['ZFSMInventory','ZFSMForms','ZFSMSnapshots','ZFSMExplorer','ZFSMPoolView','ZFSMOverview','ZFSMHistory','ZFSMWorkspace'])w.eval(readFileSync('src/frontend/'+name+'.js','utf8'));
 const owner=ds('cache/a','2'),tree=ds('cache','1');owner.directories=[source];owner._directory_identities={[source]:{dev:'1',ino:'100'}};tree.child[owner.name]=owner;
 const data={pools:{cache:{Health:'ONLINE',Size:1000,Used:100,Snapshots:0}},datasets:{cache:tree},devices:{cache:''},errors:{}};
 const job={id,type,state:'running',stage:'copying',source,actions:{},progress:{percent:25}},jobs=initial?[job]:[];
 const button=label=>{const item=[...root.querySelectorAll('button')].find(b=>b.textContent===label||b.getAttribute('aria-label')===label);assert.ok(item,label);return item;};
 const app=w.zfsmCreateWorkspace({root,config:{refresh_interval:interval,destructive_mode:1,directory_listing:[owner.name]},request:async fields=>{
  calls.push(structuredClone(fields));
  if(fields.cmd==='inventory')return {op:'getAll',data:structuredClone(data)};
  if(fields.cmd==='pooldiagnostics')throw Error('Synthetic unavailable');
  if(fields.cmd==='getdatasetproperties')return structuredClone(owner);
  if(fields.cmd==='conversionjobs'){
   if(!fields.filter&&failObservation)throw Error('Synthetic observation failure');
   const rows=fields.filter==='active'?jobs.filter(j=>['queued','running'].includes(j.state)):fields.filter==='restore'?jobs.filter(j=>j.type==='restore'):jobs;
   const active=jobs.filter(j=>['queued','running'].includes(j.state)),attention=jobs.filter(j=>!['queued','running','completed'].includes(j.state)),completed=jobs.filter(j=>j.state==='completed'),size=Number(fields.page_size)||10;
   const answer={jobs:structuredClone(fields.filter?rows.slice(0,size):[...active,...attention,...completed.slice(0,size)]),worker_running:true,counts:{active:active.length,completed:completed.length,needs_attention:attention.length}};
   if(!fields.filter&&holdObservation)await new Promise(resolve=>releaseObservation=resolve);
   return answer;
  }
  if(fields.cmd==='convertdirectory'){jobs.push(job);return {succeeded:{[source]:'Queued'},failed:{},job:structuredClone(job)};}
  throw Error('Unexpected '+fields.cmd);
 }});await settle();
 return {w,root,app,jobs,job,calls,timers,button,reads:()=>calls.filter(c=>c.cmd==='inventory').length,
  async poll(){const entry=[...timers].find(([,v])=>v.ms===2500);assert.ok(entry);timers.delete(entry[0]);entry[1].fn();await settle();},
  async filter(value){root.querySelector('[data-section=jobs]').click();await settle();const f=root.querySelector('[aria-label="Filter jobs"]');f.value=value;f.dispatchEvent(new w.Event('change',{bubbles:true}));await settle();},
  finish(state='completed'){owner.directories=[];owner._directory_identities={};if(type==='conversion')owner.child[target]=ds(target,'3');job.state=state;job.stage=state;},
  async queueFast(){root.querySelector('[data-node="'+source+'"]').click();root.querySelector('[data-tab=actions]').click();button('Convert to dataset').click();await settle();const f=root.querySelector('.zfsm-form');f.querySelector('[name=offline_confirmed]').checked=true;f.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();f.querySelector('[data-confirm-operation]').click();await settle();},
  fail:()=>failObservation=true,recover:()=>failObservation=false,hold:()=>holdObservation=true,pending:()=>Boolean(releaseObservation),release:()=>{holdObservation=false;releaseObservation?.();},close(){app.stop();w.close();}};
}
for(const interval of [0,30])for(const type of ['conversion','deletion','restore','policy','replication'])test(type+' completion reconciles once at interval '+interval,async()=>{
 const x=await fixture({type,interval});try{assert.equal(x.reads(),1);x.finish();await x.poll();assert.equal(x.reads(),2);await x.poll();assert.equal(x.reads(),2);assert.equal(x.calls.some(c=>c.cmd.startsWith('resume')),false);assert.equal([...x.timers.values()].some(t=>t.ms===30000),interval===30);}finally{x.close();}
});
for(const state of ['failed','cancelled','recovery_required'])test('partial conversion '+state+' reconciles without retrying execution',async()=>{
 const x=await fixture();try{x.finish(state);await x.poll();assert.equal(x.reads(),2);assert.equal(x.calls.every(c=>['inventory','conversionjobs','pooldiagnostics','getdatasetproperties'].includes(c.cmd)),true);}finally{x.close();}
});
for(const type of ['archive','download'])test(type+' progress never triggers inventory reconciliation',async()=>{const x=await fixture({type});try{x.finish();await x.poll();assert.equal(x.reads(),1);}finally{x.close();}});
test('queued reply remains tracked if it completes before the next Jobs poll',async()=>{
 const x=await fixture({initial:false});try{await x.queueFast();x.finish();await x.poll();assert.equal(x.reads(),2);assert.equal(x.root.querySelector('[data-node="'+source+'"]'),null);assert.ok(x.root.querySelector('[data-node="'+target+'"]'));}finally{x.close();}
});
for(const filter of ['active','restore'])test('deletion hidden by '+filter+' filter still reconciles once',async()=>{
 const x=await fixture({type:'deletion'});try{await x.filter(filter);x.finish();await x.poll();assert.equal(x.reads(),2);assert.equal(x.root.querySelector('[aria-label="Filter jobs"]').value,filter);assert.equal(x.root.querySelector('[data-job-id="'+id+'"]'),null);await x.poll();assert.equal(x.reads(),2);}finally{x.close();}
});
test('failed unfiltered observation retains pending work until the next successful poll',async()=>{
 const x=await fixture({type:'deletion'});try{await x.filter('active');x.finish();x.fail();await x.poll();assert.equal(x.reads(),1);assert.match(x.root.textContent,/Job status unavailable/);x.recover();await x.poll();assert.equal(x.reads(),2);}finally{x.close();}
});
test('an absent journal reconciles inventory without inventing a successful Job',async()=>{
 const x=await fixture({type:'deletion'});try{await x.filter('active');x.jobs.length=0;await x.poll();assert.equal(x.reads(),2);assert.equal(x.root.querySelector('[data-job-id]'),null);await x.poll();assert.equal(x.reads(),2);}finally{x.close();}
});
test('stopping during a pending observation prevents late inventory and UI updates',async()=>{
 const x=await fixture({type:'deletion'});try{await x.filter('active');x.finish();x.hold();await x.poll();assert.equal(x.pending(),true,'An unfiltered observation must actually be pending');x.app.stop();x.release();await settle();assert.equal(x.reads(),1);}finally{x.close();}
});

test('a completed deletion outside the one-record observation page still reconciles',async()=>{
 const x=await fixture({type:'deletion'});try{await x.filter('active');x.finish();x.jobs.unshift({id:'newer-archive',type:'archive',state:'completed'});await x.poll();assert.equal(x.reads(),2);assert.ok(x.calls.some(c=>c.page_size==='1'&&!c.filter));await x.poll();assert.equal(x.reads(),2);}finally{x.close();}
});
test('a Jobs filter change discards a pending observation and reconciles using the new scope',async()=>{
 const x=await fixture({type:'deletion'});try{await x.filter('active');x.finish();x.hold();await x.poll();assert.equal(x.pending(),true);await x.filter('restore');x.release();await settle();assert.equal(x.reads(),2);assert.equal(x.root.querySelector('[aria-label="Filter jobs"]').value,'restore');assert.equal(x.root.querySelector('[data-job-id="'+id+'"]'),null);await x.poll();assert.equal(x.reads(),2);}finally{x.close();}
});
test('global active count discovers an inventory Job outside the visible filter',async()=>{
 const x=await fixture({type:'deletion',initial:false});try{await x.filter('restore');x.jobs.push(x.job);await x.poll();assert.equal(x.reads(),1);x.finish();await x.poll();assert.equal(x.reads(),2);assert.equal(x.root.querySelector('[aria-label="Filter jobs"]').value,'restore');}finally{x.close();}
});

test('an observation started before queueing cannot discard the new Job as missing',async()=>{
 const x=await fixture({initial:false,holdInitial:true});try{assert.equal(x.pending(),true);await x.queueFast();x.release();await settle();assert.equal(x.reads(),1,'An older observation must not reconcile a newly registered Job');x.finish();await x.poll();assert.equal(x.reads(),2);await x.poll();assert.equal(x.reads(),2);}finally{x.close();}
});
