import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const scan = (state = 'idle') => ({state,kind:state==='idle'?null:'scrub',text:'native scan text',percent:state==='running'?16.91:null,scanned:'403M',scan_total:'405M',scan_rate:'100M/s',issued:'68.4M',issue_total:'405M',issue_rate:'10.0M/s',eta:'00:00:04',repaired:'0B',errors:0});
function diagnostic(state = 'idle') {
    return {pool:'cache',health:'ONLINE',severity:'ok',reasons:[],command_errors:[],collected_at:'2026-10-16T12:00:00Z',scan:scan(state),
        status:{text:'native status',state:'ONLINE',scan:'native scan text',errors:'No known data errors',rows:[{name:'cache',state:'ONLINE',read:'0',write:'0',cksum:'0',depth:0},{name:'disk1',state:'ONLINE',read:'0',write:'0',cksum:'0',depth:1}]},
        information:{text:'native list',columns:['NAME','SIZE','ALLOC','FREE','CKPOINT','EXPANDSZ','FRAG','CAP','DEDUP','HEALTH','ALTROOT'],rows:[{name:'cache',health:'ONLINE'},{name:'disk1',health:'ONLINE'}]}};
}
function dom() {
    const instance = new JSDOM('<main id="root"></main>', {url:'http://fixture.local/?pool=cache&tab=pool-status',runScripts:'outside-only',pretendToBeVisual:true});
    instance.window.zfsmFormatDateTime=value=>value;
    return instance;
}
function view(value, options = {}) {
    const instance=dom(), w=instance.window, root=w.document.getElementById('root');
    w.eval(readFileSync('src/frontend/ZFSMPoolView.js','utf8'));
    w.zfsmRenderPoolDiagnostics(root,value,'status',options);
    return {instance,w,root};
}
const findButton=(root,text)=>[...root.querySelectorAll('button')].find(item=>item.textContent===text);

test('start requires a separate review and confirmation', () => {
    let reviews=0, starts=0;
    const {instance,root}=view(diagnostic(),{onReview:()=>reviews++,onScrub:()=>starts++});
    try {
        const start=findButton(root,'Start scrub'); assert.ok(start); start.click();
        assert.equal(reviews,1); assert.equal(starts,0);
    } finally {instance.window.close();}
    const confirmed=view(diagnostic(),{review:true,onScrub:()=>starts++});
    try {
        assert.match(confirmed.root.textContent,/entire pool cache/i);
        findButton(confirmed.root,'Confirm scrub').click(); assert.equal(starts,1);
    } finally {confirmed.instance.window.close();}
});
test('running scrub displays progress and native speed, never a start button', () => {
    const {instance,root}=view(diagnostic('running'));
    try {
        const progress=root.querySelector('progress'); assert.ok(progress); assert.equal(progress.value,16.91);
        assert.match(root.textContent,/16.91%/); assert.match(root.textContent,/10.0M\/s/); assert.match(root.textContent,/00:00:04/);
        assert.equal(findButton(root,'Start scrub')?.disabled,true);
    } finally {instance.window.close();}
});
for (const [label,edit] of [['stale',d=>d.stale=true],['unknown',d=>d.severity='unknown'],['invalid severity',d=>d.severity='invalid'],['scan missing',d=>delete d.scan],['resilvering',d=>d.scan.state='resilvering']]) {
    test('scrub action is blocked when '+label, () => {
        const d=diagnostic();edit(d);const {instance,root}=view(d,{review:true});
        try {
            assert.equal(findButton(root,'Start scrub')?.disabled,true);
            assert.equal(findButton(root,'Confirm scrub'),undefined);
        } finally {instance.window.close();}
    });
}
test('stale progress is indeterminate and identified as stale', () => {
    const d=diagnostic('running');d.stale=true;const {instance,root}=view(d);
    try {assert.equal(root.querySelector('progress')?.hasAttribute('value'),false);assert.match(root.textContent,/stale/i);}
    finally {instance.window.close();}
});
test('scan text is rendered as text, never executable HTML', () => {
    const d=diagnostic('running');d.scan.text='<img src=x onerror=alert(1)>';const {instance,root}=view(d);
    try {assert.equal(root.querySelector('img'),null);assert.ok(root.textContent.includes('<img'));}
    finally {instance.window.close();}
});

async function workspace(initial = diagnostic()) {
    const instance=dom(),w=instance.window,root=w.document.getElementById('root'),timers=new Map(),calls=[];
    let sequence=0,current=initial,failRead=false,resolveStart,rejectStart;
    w.setTimeout=(fn,ms)=>{timers.set(++sequence,{fn,ms});return sequence;};w.clearTimeout=id=>timers.delete(id);
    w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
    for (const file of ['ZFSMInventory.js','ZFSMForms.js','ZFSMSnapshots.js','ZFSMExplorer.js','ZFSMPoolView.js','ZFSMOverview.js','ZFSMHistory.js','ZFSMWorkspace.js']) w.eval(readFileSync('src/frontend/'+file,'utf8'));
    const request=async fields=>{
        calls.push({...fields});
        if(fields.cmd==='conversionjobs')return {jobs:[],worker_running:false};
        if(fields.cmd==='inventory')return {op:'getAll',data:{pools:{cache:{Health:'ONLINE',Size:1000,Used:100,Snapshots:0}},datasets:{cache:{name:'cache',type:'filesystem',mountpoint:'/mnt/cache',used:100,available:900,referenced:100,child:{},snapshots:[]}},devices:{cache:[]}}};
        if(fields.cmd==='pooldiagnostics'){if(failRead)throw new Error('simulated read failure');return structuredClone(current);}
        if(fields.cmd==='scrubpool')return await new Promise((resolve,reject)=>{resolveStart=resolve;rejectStart=reject;});
        throw new Error('Unexpected request '+fields.cmd);
    };
    const app=w.zfsmCreateWorkspace({root,config:{refresh_interval:30},request});
    await settle();
    return {instance,w,root,timers,calls,app,setDiagnostic:d=>current=d,failRead:()=>failRead=true,resolveStart:answer=>resolveStart(answer),rejectStart:()=>rejectStart(new Error('simulated lost response'))};
}
async function settle(){for(let i=0;i<20;i++)await Promise.resolve();}
test('workspace confirms once, polls visible progress, and stops polling on exit', async () => {
    const ctx=await workspace();
    try {
        assert.ok(findButton(ctx.root,'Start scrub'),'Pool Status deep link should open');
        findButton(ctx.root,'Start scrub').click();
        const confirm=findButton(ctx.root,'Confirm scrub');assert.ok(confirm);confirm.click();confirm.click();await settle();
        assert.equal(ctx.calls.filter(c=>c.cmd==='scrubpool').length,1);
        assert.deepEqual(ctx.calls.find(c=>c.cmd==='scrubpool'),{cmd:'scrubpool',pool:'cache',confirmed:'1'});
        ctx.setDiagnostic(diagnostic('running'));ctx.resolveStart({succeeded:{cache:'Scrub start requested'},failed:{}});await settle();
        assert.equal(ctx.root.querySelector('progress')?.value,16.91);
        const poll=[...ctx.timers.values()].find(t=>t.ms===5000);assert.ok(poll);const count=ctx.calls.length;poll.fn();await settle();assert.ok(ctx.calls.length>count);
        findButton(ctx.root,'Overview').click();assert.equal([...ctx.timers.values()].some(t=>t.ms===5000),false);
        ctx.app.stop();assert.equal(ctx.timers.size,0);
    } finally {ctx.app.stop();ctx.instance.window.close();}
});
test('failed progress refresh retains stale output and disables scrub', async () => {
    const ctx=await workspace();
    try {
        ctx.failRead();const poll=[...ctx.timers.values()].find(t=>t.ms===5000);assert.ok(poll);poll.fn();await settle();
        assert.match(ctx.root.textContent,/stale/i);assert.equal(findButton(ctx.root,'Start scrub')?.disabled,true);
    } finally {ctx.app.stop();ctx.instance.window.close();}
});
test('a detached confirmation cannot start scrub after navigation', async () => {
    const ctx=await workspace();
    try {
        findButton(ctx.root,'Start scrub').click();const confirm=findButton(ctx.root,'Confirm scrub');
        findButton(ctx.root,'Overview').click();confirm.dispatchEvent(new ctx.w.Event('click'));await settle();
        assert.equal(ctx.calls.filter(c=>c.cmd==='scrubpool').length,0);
    } finally {ctx.app.stop();ctx.instance.window.close();}
});
test('a lost start response is not retried or reported as success', async () => {
    const ctx=await workspace();
    try {
        findButton(ctx.root,'Start scrub').click();findButton(ctx.root,'Confirm scrub').click();await settle();
        ctx.setDiagnostic(diagnostic('running'));ctx.rejectStart();await settle();
        assert.match(ctx.root.textContent,/result is not confirmed/i);
        const poll=[...ctx.timers.values()].find(t=>t.ms===5000);poll.fn();await settle();
        assert.equal(ctx.calls.filter(c=>c.cmd==='scrubpool').length,1);
        assert.equal(findButton(ctx.root,'Start scrub')?.disabled,true);
    } finally {ctx.app.stop();ctx.instance.window.close();}
});
test('hidden pages do not poll diagnostics', async () => {
    const ctx=await workspace();
    try {
        Object.defineProperty(ctx.w.document,'hidden',{value:true});
        const count=ctx.calls.length;[...ctx.timers.values()].find(t=>t.ms===5000).fn();await settle();
        assert.equal(ctx.calls.length,count);
    } finally {ctx.app.stop();ctx.instance.window.close();}
});
test('initial incomplete diagnostic with a known error still blocks scrub', async () => {
    const d=diagnostic();d.severity='unknown';d.reasons=['zpool list failed'];d.command_errors=[{command:'list',code:1,message:'failed'}];d.status.rows[1].cksum='7';d.information.rows=[];
    const ctx=await workspace(d);
    try {assert.equal(findButton(ctx.root,'Start scrub')?.disabled,true);}
    finally {ctx.app.stop();ctx.instance.window.close();}
});
