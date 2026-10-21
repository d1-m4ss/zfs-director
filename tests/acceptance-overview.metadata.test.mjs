import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const tick = async () => { for (let index=0;index<40;index++) await Promise.resolve(); };
const child = {name:'cache/data',type:'filesystem',guid:'2',mounted:'yes',keystatus:'none',encryption:'off',mountpoint:'/mnt/cache/data',compression:'lz4',sync:'standard',atime:'off',child:{},snapshots:[],directories:[]};
const metadata = {...child,compression:'zstd',_sources:{compression:'inherited from cache',sync:'default',atime:'local'},
    _permissions:{status:'known',owner:'nobody',group:'users',uid:'99',gid:'100',mode:'0750',acl_type:'unknown',acl_state:'unknown',reason:''}};
const click = (root,label) => { const button=[...root.querySelectorAll('button')].find(button=>button.dataset.node===label||button.textContent===label);assert.ok(button,label);button.click(); };

async function setup({cached=false}={}) {
    const dom=new JSDOM('<main></main>',{url:'http://fixture.local/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,root=w.document.querySelector('main');
    w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.scrollTo=()=>{};w.ResizeObserver=class{observe(){}disconnect(){}};w.zfsmFormatDateTime=x=>String(x);
    for(const file of ['ZFSMInventory.js','ZFSMForms.js','ZFSMSnapshots.js','ZFSMExplorer.js','ZFSMPoolView.js','ZFSMOverview.js','ZFSMHistory.js','ZFSMWorkspace.js'])w.eval(readFileSync('src/frontend/'+file,'utf8'));
    const data={pools:{cache:{Health:'ONLINE',Size:1000,Used:100,Snapshots:0}},datasets:{cache:{name:'cache',type:'filesystem',guid:'1',child:{'cache/data':structuredClone(child),'cache/other':{...structuredClone(child),name:'cache/other',guid:'3'}},snapshots:[],directories:[]}},devices:{cache:''},errors:{}};
    if(cached)w.localStorage.setItem('zfsm-workspace-inventory-v1',JSON.stringify({time:'2026-01-01T00:00:00Z',data}));
    const pending=[],calls=[];
    const app=w.zfsmCreateWorkspace({root,config:{refresh_interval:cached?0:30,destructive_mode:1},request:async fields=>{
        calls.push(structuredClone(fields));
        if(fields.cmd==='conversionjobs')return {jobs:[],worker_running:false};
        if(fields.cmd==='inventory'){if(cached)return new Promise(()=>{});return {op:'getAll',data:structuredClone(data)};}
        if(fields.cmd==='pooldiagnostics')throw Error('Unavailable');
        if(fields.cmd==='getdatasetproperties')return new Promise((resolve,reject)=>pending.push({fields,resolve,reject}));
        throw Error('Unexpected '+fields.cmd);
    }});
    await tick();click(root,'cache/data');await tick();
    return {dom,w,root,app,data,pending,calls,close(){app.stop();w.close();}};
}

test('Overview loads effective sources and verified permission summary through existing properties endpoint',async()=>{
    const x=await setup();try{
        const request=x.pending.find(request=>request.fields.zdataset==='cache/data');
        assert.ok(request,'Overview must enrich its summary with getdatasetproperties');
        request.resolve(structuredClone(metadata));await tick();
        const details=[...x.root.querySelectorAll('.zfsm-overview-card')].find(card=>card.querySelector('h3')?.textContent==='Details');
        assert.match(details.textContent,/Compressionzstd.*Source: inherited from cache/);
        assert.match(details.textContent,/Syncstandard.*Source: default/);
        assert.match(details.textContent,/Atimeoff.*Source: local/);
        assert.match(x.root.textContent,/Owner \/ Groupnobody.*users/);
        assert.match(x.root.textContent,/Unix permissions0750/);
        assert.match(x.root.textContent,/ACL typeUnknown/);
        const cache=JSON.parse(x.w.localStorage.getItem('zfsm-workspace-inventory-v1'));
        assert.equal(cache.data.datasets.cache.child['cache/data'].compression,'lz4','Overview enrichment must not replace inventory or its cache');
    }finally{x.close();}
});

for(const change of ['selection','GUID','refresh','view'])test('Overview ignores metadata after '+change+' changes',async()=>{
    const x=await setup();try{
        const request=x.pending.find(request=>request.fields.zdataset==='cache/data');assert.ok(request);
        if(change==='selection')click(x.root,'cache/other');
        if(change==='GUID'){x.data.datasets.cache.child['cache/data'].guid='777';x.app.refresh();await tick();}
        if(change==='refresh'){x.app.refresh();await tick();}
        if(change==='view')click(x.root,'Dataset information');
        request.resolve({...structuredClone(metadata),_permissions:{...metadata._permissions,owner:'STALE-OWNER'}});await tick();
        assert.doesNotMatch(x.root.textContent,/STALE-OWNER/);
    }finally{x.close();}
});

test('cached Overview leaves permission/source metadata Unknown until initial refresh completes',async()=>{
    const x=await setup({cached:true});try{
        assert.equal(x.calls.filter(call=>call.cmd==='getdatasetproperties').length,0);
        assert.match(x.root.textContent,/Stale data/);
        assert.match(x.root.textContent,/Owner \/ GroupUnknown/);
        assert.match(x.root.textContent,/Unix permissionsUnknown/);
    }finally{x.close();}
});

for(const outcome of ['different GUID','backend error'])test('Overview keeps permission/source metadata Unknown after '+outcome,async()=>{
    const x=await setup();try{
        const request=x.pending.find(request=>request.fields.zdataset==='cache/data');assert.ok(request);
        if(outcome==='different GUID')request.resolve({...structuredClone(metadata),guid:'777'});
        else request.reject(Error('Property read timed out'));
        await tick();
        assert.match(x.root.textContent,/Owner \/ GroupUnknown/);
        assert.match(x.root.textContent,/Unix permissionsUnknown/);
        assert.doesNotMatch(x.root.textContent,/nobody|Source: inherited from cache/);
        assert.match(x.root.textContent,/Source: Unknown/);
    }finally{x.close();}
});
