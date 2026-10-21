import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
function render(node,extra={}){
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window,host=w.document.querySelector('main'),calls=[];
 if(existsSync('src/frontend/ZFSMOverview.js'))w.eval(readFileSync('src/frontend/ZFSMOverview.js','utf8'));
 w.zfsmRenderDatasetOverview(host,{node,pool:'cache',fresh:true,loaded:true,bytes:x=>String(x)+' B',date:x=>'DATE '+x,config:{snap_max_days_alert:30},onAction:a=>calls.push(a),onTab:t=>calls.push(t),...extra});
 return {dom,host,calls};
}
const dataset={name:'cache/data',type:'filesystem',mountpoint:'/mnt/cache/data',used:600,available:400,usedbydataset:200,usedbychildren:250,usedbysnapshots:100,usedbyrefreservation:50,quota:0,refquota:0,compression:'lz4',compressratio:120,encryption:'off',child:{'cache/data/child':{name:'cache/data/child',child:{},snapshots:[{name:'cache/data/child@s1',creation:200}]}},snapshots:[{name:'cache/data@s1',creation:100}]};
test('overview distinguishes direct snapshots, descendant scope and actual accounting',()=>{const x=render(dataset);try{assert.equal(x.host.querySelectorAll('.zfsm-overview-card').length,4);assert.match(x.host.textContent,/Direct snapshots1/);assert.match(x.host.textContent,/Including descendants2/);assert.match(x.host.textContent,/Refreservation50 B/);assert.match(x.host.textContent,/Dataset statistics/);assert.equal(x.host.querySelector('[role=img]').getAttribute('aria-label').includes('60%'),true);assert.match(x.host.textContent,/External backupUnknown/);}finally{x.dom.window.close();}});
test('missing properties never fabricate accounting, services or protection',()=>{const x=render({...dataset,usedbydataset:undefined,usedbychildren:undefined});try{assert.match(x.host.textContent,/Breakdown unavailable/);assert.match(x.host.textContent,/Schedule ownerUnknown/);assert.match(x.host.textContent,/UsageUnknown/);assert.doesNotMatch(x.host.textContent,/Protected|Daily|Not configured/);}finally{x.dom.window.close();}});
test('stale overview disables every mutation while keeping navigation',()=>{const x=render(dataset,{fresh:false});try{const b=[...x.host.querySelectorAll('button')].find(b=>b.textContent==='Take Snapshot');assert.equal(b.disabled,true);[...x.host.querySelectorAll('button')].find(b=>b.textContent==='Restore Files').click();assert.deepEqual(x.calls,['snapshots']);}finally{x.dom.window.close();}});
test('volume overview omits filesystem-only details and explains inherited encryption',()=>{const x=render({...dataset,type:'volume',mountpoint:'none',volblocksize:16384,encryption:'aes-256-gcm',encryptionroot:'cache/secure',keystatus:'unavailable'});try{assert.doesNotMatch(x.host.textContent,/Mountpointnone/);assert.match(x.host.textContent,/Volume block size16384 B/);assert.match(x.host.textContent,/Encryption inherited.*locked by ancestor/);}finally{x.dom.window.close();}});
