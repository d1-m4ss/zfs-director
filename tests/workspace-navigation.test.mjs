import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';

const settle=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
const mutation='/mnt/cache/a/.zfsm-mutation-'+'a'.repeat(48),maintenance='/mnt/cache/a/.zfsm-maintenance',archive='/mnt/cache/a/.zfsm-archive-20261020-130405-0123456789ab',restore='/mnt/cache/a/.zfsm-restore-20261020-130405-0123456789ab';
const findButton=(root,label)=>[...root.querySelectorAll('button')].find(b=>b.textContent===label);
async function mount(jobs=[],savedSelection=''){
 const dom=new JSDOM('<main id="zfsm-workspace"></main>',{url:'http://fixture.local/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,root=w.document.querySelector('main'),calls=[];
 w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.zfsmFormatDateTime=String;w.scrollTo=()=>{};w.ResizeObserver=class{observe(){}disconnect(){}};
 w.setTimeout=()=>1;w.clearTimeout=()=>{};
 for(const file of ['ZFSMInventory','ZFSMForms','ZFSMSnapshots','ZFSMExplorer','ZFSMPoolView','ZFSMOverview','ZFSMHistory','ZFSMWorkspace'])w.eval(readFileSync('src/frontend/'+file+'.js','utf8'));
 const dataset=(name,guid,type='filesystem')=>({name,guid,type,mountpoint:type==='volume'?'none':'/mnt/'+name,used:100,referenced:100,available:1000,encryption:'off',keystatus:'none',child:{},directories:[],snapshots:[]});
 const tree=dataset('cache','1');tree.child['cache/a']=dataset('cache/a','2');tree.child['cache/b']=dataset('cache/b','3');tree.child['cache/volume']=dataset('cache/volume','4','volume');
 tree.child['cache/a'].directories=['/mnt/cache/a/ordinary',mutation,maintenance,maintenance+'/retained',archive,restore,restore+'/replaced','/mnt/cache/a/.keep-me','/mnt/cache/a/SampleProject_archived_20261020-130405'];
 tree.child['cache/a']._directory_identities=Object.fromEntries(tree.child['cache/a'].directories.map((name,i)=>[name,{dev:'1',ino:String(100+i)}]));
 const inventory={op:'getAll',data:{pools:{cache:{Health:'ONLINE',Size:1000,Used:100,Snapshots:0}},datasets:{cache:tree},devices:{cache:''},errors:{}}};
 if(savedSelection)w.localStorage.setItem('zfsm-workspace-preferences-v1',JSON.stringify({pool:'cache',selection:savedSelection}));
 const app=w.zfsmCreateWorkspace({root,config:{refresh_interval:0,destructive_mode:1,directory_listing:['cache/a']},request:async fields=>{calls.push(fields);if(fields.cmd==='inventory'||fields.cmd==='inventorysnapshots')return inventory;if(fields.cmd==='conversionjobs')return {jobs,worker_running:false};if(fields.cmd==='getdatasetproperties')return tree.child[fields.zdataset]||tree;if(fields.cmd==='pooldiagnostics')throw Error('Synthetic unavailable diagnostics');throw Error('Unexpected '+fields.cmd);}});
 await app.refresh();await settle();
 return {w,root,app,calls,async select(name){root.querySelector('[data-node="'+name+'"]').click();await settle();},async tab(key){root.querySelector('.zfsm-tabs [data-tab="'+key+'"]').click();await settle();},close(){app.stop();w.close();}};
}

for(const key of ['overview','details','properties','snapshots','files','actions'])test('selecting another dataset preserves the compatible '+key+' tab',async()=>{
 const t=await mount();try{await t.select('cache/a');await t.tab(key);await t.select('cache/b');assert.equal(t.app.getState().tab,key);assert.equal(t.root.querySelector('.zfsm-workarea').dataset.activeTab,key);}finally{t.close();}
});
test('incompatible directories and zvols fall back without replacing the dataset tab preference',async()=>{
 const t=await mount();try{await t.select('cache/a');await t.tab('snapshots');await t.select('/mnt/cache/a/ordinary');assert.equal(t.app.getState().tab,'actions');assert.equal(t.root.querySelector('[data-tab=snapshots]').disabled,true);await t.select('cache/b');assert.equal(t.app.getState().tab,'snapshots');await t.tab('files');await t.select('cache/volume');assert.equal(t.app.getState().tab,'overview');assert.equal(t.root.querySelector('[data-tab=files]').disabled,true);await t.select('cache/a');assert.equal(t.app.getState().tab,'files');}finally{t.close();}
});
test('directory selection retains tree scroll and keyboard focus without browser auto scroll',async()=>{
 const t=await mount();try{await t.select('cache/a');await t.tab('actions');const browser=t.root.querySelector('.zfsm-browser'),control=browser.querySelector('[data-node="/mnt/cache/a/ordinary"]');browser.scrollTop=275;browser.scrollLeft=12;control.focus();const original=t.w.HTMLElement.prototype.focus,focusOptions=[];t.w.HTMLElement.prototype.focus=function(options){focusOptions.push(options);return original.call(this,options);};control.click();await settle();assert.equal(t.root.querySelector('.zfsm-browser').scrollTop,275);assert.equal(t.root.querySelector('.zfsm-browser').scrollLeft,12);assert.equal(t.w.document.activeElement.dataset.node,'/mnt/cache/a/ordinary');assert.ok(focusOptions.length);assert.ok(focusOptions.every(value=>value?.preventScroll===true));}finally{t.close();}
});
test('Compact selection retains horizontal scroll of the rebuilt table wrapper',async()=>{
 const t=await mount();try{t.root.querySelector('[data-layout-choice=table]').click();t.root.querySelector('.zfsm-table-wrap').scrollLeft=480;await t.select('cache/a');assert.equal(t.root.querySelector('.zfsm-table-wrap').scrollLeft,480);}finally{t.close();}
});
test('Compact Actions retains keyboard focus on the same row action without scrolling',async()=>{
 const t=await mount();try{t.root.querySelector('[data-layout-choice=table]').click();const control=t.root.querySelector('[data-node="cache/b"]').closest('tr').lastElementChild.querySelector('button');control.focus();control.click();await settle();assert.equal(t.app.getState().selection,'cache/b');assert.equal(t.app.getState().tab,'actions');const focused=t.w.document.activeElement;assert.equal(focused.textContent,'Actions');assert.equal(focused.closest('tr').querySelector('[data-node]').dataset.node,'cache/b');}finally{t.close();}
});
test('programmatic Compact selection preserves focus outside the browser',async()=>{
 const t=await mount();try{t.root.querySelector('[data-layout-choice=table]').click();const theme=t.root.querySelector('[aria-label=Theme]');theme.focus();await t.select('cache/b');assert.equal(t.w.document.activeElement,theme);}finally{t.close();}
});
test('normal tree and Compact hide only plugin service directories and Jobs reveals protected recovery files deliberately',async()=>{
 const t=await mount();try{for(const layout of ['tree','table']){t.root.querySelector('[data-layout-choice='+layout+']').click();for(const path of [mutation,maintenance,maintenance+'/retained'])assert.equal(t.root.querySelector('[data-node="'+path+'"]'),null);assert.ok(t.root.querySelector('[data-node="/mnt/cache/a/.keep-me"]'));}t.root.querySelector('[data-section=jobs]').click();await settle();findButton(t.root,'Show recovery files').click();await settle();assert.match(t.root.querySelector('[data-recovery-files]').textContent,/journal|saved original/i);await t.select(mutation);const cleanup=t.root.querySelector('[aria-label="Clean completed recovery"]');assert.ok(cleanup);assert.equal(cleanup.disabled,false);assert.equal(t.root.querySelector('[aria-label="Delete directory"]'),null);await t.select(maintenance);assert.equal(t.root.querySelector('[aria-label="Clean completed recovery"]'),null);assert.match(t.root.textContent,/Protected service directory/);findButton(t.root,'Hide recovery files').click();await settle();assert.equal(t.root.querySelector('[data-node="'+mutation+'"]'),null);assert.equal(t.app.getState().selection,'cache/a');assert.equal(t.calls.some(f=>['cleanupmutation','deletedirectory','movedirectory'].includes(f.cmd)),false);}finally{t.close();}
});
test('Pool and Scrub retains all pool sections with a single workspace entry and restores dataset tabs',async()=>{
 const t=await mount();try{await t.select('cache/a');await t.tab('snapshots');assert.equal(t.root.querySelector('.zfsm-tabs [data-tab=pool]'),null);findButton(t.root,'Pool & Scrub').click();await settle();assert.equal(t.app.getState().tab,'status');for(const key of ['status','information','devices']){t.root.querySelector('.zfsm-pool-tabs [data-tab='+key+']').click();await settle();assert.equal(t.app.getState().tab,key);}await t.select('cache/b');assert.equal(t.app.getState().tab,'snapshots');assert.equal(t.calls.some(f=>f.cmd==='scrubpool'),false);}finally{t.close();}
});
test('main and workspace tabs keep labels and decorative inline vectors after Jobs badge refresh',async()=>{
 const t=await mount([{id:'fixture-job',schema:2,type:'archive',source:'cache/a@base',state:'completed',stage:'completed',actions:{}}]);try{for(const control of t.root.querySelectorAll('.zfsm-global-nav button,.zfsm-tabs button')){const icon=control.querySelector('svg.zfsm-icon.zfsm-nav-icon');assert.ok(icon,control.textContent);assert.equal(icon.getAttribute('aria-hidden'),'true');assert.equal(icon.getAttribute('focusable'),'false');assert.ok(control.textContent.trim());assert.equal(icon.querySelector('image,use,script'),null);}assert.match(t.root.querySelector('[data-section=jobs]').textContent,/Jobs.*1/);for(const [name,kind]of [['cache','pool'],['cache/a','dataset'],['cache/volume','volume'],['/mnt/cache/a/ordinary','folder']])assert.equal(t.root.querySelector('[data-node="'+name+'"] svg').dataset.icon,kind);}finally{t.close();}
});
test('a saved service-directory selection returns to its owner until recovery files are deliberately shown',async()=>{
 const t=await mount([],mutation);try{assert.equal(t.app.getState().selection,'cache/a');assert.equal(t.root.querySelector('[data-node="'+mutation+'"]'),null);assert.equal(t.root.querySelector('[aria-label="Clean completed recovery"]'),null);}finally{t.close();}
});
test('internal restore and ZIP spools share the deliberate recovery view while saved originals remain ordinary directories',async()=>{
 const t=await mount();try{for(const path of [archive,restore,restore+'/replaced'])assert.equal(t.root.querySelector('[data-node="'+path+'"]'),null);assert.ok(t.root.querySelector('[data-node="/mnt/cache/a/SampleProject_archived_20261020-130405"]'));t.root.querySelector('[data-section=jobs]').click();await settle();findButton(t.root,'Show recovery files').click();await settle();for(const path of [archive,restore,restore+'/replaced']){await t.select(path);assert.equal(t.root.querySelector('[aria-label="Delete directory"]'),null);assert.equal(t.root.querySelector('[aria-label="Clean completed recovery"]'),null);}}finally{t.close();}
});
