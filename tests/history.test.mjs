import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';

function entry(id, phase, status, timestamp, fields = {}, extra = {}) {
    return {version:1, operation_id:id, command:'renamedataset', phase, status, timestamp, fields, ...extra};
}
function view(entries, options = {}) {
    const dom = new JSDOM('<main></main>', {runScripts:'outside-only', url:'http://fixture.local/'});
    const path = 'src/frontend/ZFSMHistory.js';
    if (existsSync(path)) dom.window.eval(readFileSync(path, 'utf8'));
    assert.equal(typeof dom.window.zfsmRenderHistory, 'function', 'History renderer must exist');
    const root = dom.window.document.querySelector('main');
    dom.window.zfsmRenderHistory(root, entries, {date:value=>'LOCAL '+value, ...options});
    return {root, window:dom.window, close:()=>dom.window.close()};
}
const rows = root => [...root.querySelectorAll('[data-history-operation]')];
const control = (root, label) => [...root.querySelectorAll('input, select, button')].find(item=>item.getAttribute('aria-label')===label || item.textContent===label);
function set(ctx, label, value) {
    const field = control(ctx.root, label); assert.ok(field, label); field.value=value;
    field.dispatchEvent(new ctx.window.Event(field.tagName==='INPUT'?'input':'change', {bubbles:true}));
}

test('history groups begin, events and outcome without dropping technical fields', () => {
    const records = [
        entry('a','outcome','succeeded','2026-10-16T12:00:02Z',{}, {succeeded:['cache/new'], diagnostic:{message:'[redacted]', count:3}}),
        entry('a','event','running','2026-10-16T12:00:01Z',{stage:'renaming'}),
        entry('a','begin','started','2026-10-16T12:00:00Z',{zdataset:'cache/old',newname:'cache/new'}),
    ];
    const ctx = view(records);
    try {
        assert.equal(rows(ctx.root).length,1);
        const row = rows(ctx.root)[0];
        assert.match(row.textContent,/LOCAL 2026-10-16T12:00:00Z/);
        assert.match(row.textContent,/cache\/old/); assert.match(row.textContent,/cache\/new/);
        assert.equal(row.querySelector('[data-history-result]').textContent,'Succeeded');
        assert.equal(row.querySelector('[data-history-duration]').textContent,'2 s');
        assert.ok(row.querySelector('details > summary'));
        assert.deepEqual(JSON.parse(row.querySelector('[data-audit-records]').textContent),records);
        assert.deepEqual(records[0].diagnostic,{message:'[redacted]',count:3});
    } finally {ctx.close();}
});

test('history search and operation/result filters narrow actual grouped records', () => {
    const ctx = view([
        entry('a','outcome','succeeded','2026-10-16T12:00:00Z',{zdataset:'cache/Alpha'}),
        entry('b','outcome','failed','2026-10-16T12:00:01Z',{snapshot:'cache/beta@s1'}, {command:'destroysnapshot'}),
        entry('c','begin','started','2026-10-16T12:00:02Z',{zdataset:'cache/beta'}),
    ]);
    try {
        set(ctx,'Search history','ALPHA'); assert.deepEqual(rows(ctx.root).map(row=>row.dataset.historyOperation),['a']);
        set(ctx,'Search history','destroysnapshot'); assert.deepEqual(rows(ctx.root).map(row=>row.dataset.historyOperation),['b']);
        set(ctx,'Search history',''); set(ctx,'Operation','renamedataset');
        assert.equal(rows(ctx.root).length,2);
        set(ctx,'Result','unconfirmed'); assert.deepEqual(rows(ctx.root).map(row=>row.dataset.historyOperation),['c']);
        set(ctx,'Result','failed'); assert.equal(rows(ctx.root).length,0); assert.match(ctx.root.textContent,/No operations match/);
    } finally {ctx.close();}
});

test('history paginates 1000 events and sorting/search reset the page', () => {
    const records = Array.from({length:1000},(_,index)=>entry(String(index),'event','completed',new Date(Date.UTC(2026,9,16,0,0,index)).toISOString(),{zdataset:'cache/item'+index}));
    const ctx = view(records);
    try {
        assert.equal(rows(ctx.root).length,25); assert.equal(rows(ctx.root)[0].dataset.historyOperation,'999');
        assert.equal(control(ctx.root,'Previous page').disabled,true);
        control(ctx.root,'Next page').click(); assert.equal(rows(ctx.root)[0].dataset.historyOperation,'974');
        assert.match(ctx.root.querySelector('[data-history-pagination]').textContent,/Page 2 of 40/);
        set(ctx,'Sort history','oldest'); assert.equal(rows(ctx.root)[0].dataset.historyOperation,'0');
        control(ctx.root,'Next page').click(); set(ctx,'Search history','cache/item999');
        assert.deepEqual(rows(ctx.root).map(row=>row.dataset.historyOperation),['999']);
        assert.equal(control(ctx.root,'Next page').disabled,true);
        assert.match(ctx.root.textContent,/Incomplete audit range/);
    } finally {ctx.close();}
});

test('history distinguishes missing phases and never invents duration or success', () => {
    const ctx = view([
        entry('a','begin','started','2026-10-16T12:00:00Z'),
        entry('b','outcome','failed','2026-10-16T12:00:02Z'),
        entry('c','begin','started','not a timestamp'),entry('c','outcome','succeeded','2026-10-16T12:00:02Z'),
        entry('d','begin','started','2026-10-16T12:00:05Z'),entry('d','outcome','succeeded','2026-10-16T12:00:02Z'),
    ],{limited:true});
    try {
        const byId = new Map(rows(ctx.root).map(row=>[row.dataset.historyOperation,row]));
        assert.equal(byId.get('a').querySelector('[data-history-result]').textContent,'Started / unconfirmed');
        assert.equal(byId.get('b').querySelector('[data-history-result]').textContent,'Failed');
        for (const row of byId.values()) assert.equal(row.querySelector('[data-history-duration]').textContent,'—');
        assert.match(byId.get('a').textContent,/Outcome record unavailable/);
        assert.match(byId.get('b').textContent,/Begin record unavailable/);
        assert.match(ctx.root.textContent,/Incomplete audit range/);
    } finally {ctx.close();}
});

test('history renders hostile values and all technical JSON strictly as text', () => {
    const payload = '<img src=x onerror="window.injected=true">';
    const record = entry(payload,'event','failed','2026-10-16T12:00:00Z',{zdataset:payload},{command:payload, reason:payload, diagnostic:{redacted:payload}});
    const ctx = view([record]);
    try {
        assert.equal(ctx.root.querySelector('img'),null); assert.equal(ctx.root.querySelector('script'),null);
        assert.ok(ctx.root.textContent.includes(payload));
        assert.deepEqual(JSON.parse(ctx.root.querySelector('[data-audit-records]').textContent),[record]);
        assert.equal(ctx.window.injected,undefined);
    } finally {ctx.close();}
});

test('history preserves independent records without operation IDs and reports empty history', () => {
    const first = entry(undefined,'event','running','2026-10-16T12:00:00Z');
    const second = entry(undefined,'event','failed','2026-10-16T12:00:01Z');
    const ctx = view([first,second]);
    try {assert.equal(rows(ctx.root).length,2);} finally {ctx.close();}
    const empty = view([]);
    try {assert.match(empty.root.textContent,/No administrative operations/);} finally {empty.close();}
});

const jobId='20261018-115320-0b8230067c45';
const conversion=(id,phase,status,time,fields={},extra={})=>entry(id,phase,status,'2026-10-18T'+time+'Z',{job_id:jobId,...fields},{command:'conversion',...extra});
test('completed conversion associates legacy stage events with the observed attempt and retains every raw record',()=>{
    const records=[conversion('a'.repeat(32),'outcome','succeeded','11:53:28'),conversion('b'.repeat(32),'event','running','11:53:27',{stage:'published'}),conversion('c'.repeat(32),'event','running','11:53:21',{stage:'copying'}),conversion('a'.repeat(32),'begin','started','11:53:20',{directory:'/mnt/cache/test/source'})];
    // Outcomes have no job_id in the actual audit schema.
    records[0].fields={};const ctx=view(records,{setVisibility:async()=>({succeeded:{},failed:{}})});
    try{const rendered=rows(ctx.root);assert.equal(rendered.length,1);assert.equal(rendered[0].querySelector('[data-history-result]').textContent,'Succeeded');assert.equal(rendered[0].querySelector('[data-history-duration]').textContent,'8 s');assert.deepEqual(JSON.parse(rendered[0].querySelector('[data-audit-records]').textContent),records);assert.equal(control(ctx.root,'Clear completed on this page').disabled,false);}finally{ctx.close();}
});
test('conversion history keeps separate attempts, standalone failures and missing or ambiguous correlation visible',()=>{
    const records=[conversion('e'.repeat(32),'event','recovery_required','11:53:29',{stage:'interrupted'}),conversion('d'.repeat(32),'outcome','succeeded','11:53:28'),conversion('f'.repeat(32),'event','running','11:53:27',{stage:'published'}),conversion('d'.repeat(32),'begin','started','11:53:26'),conversion('a'.repeat(32),'outcome','failed','11:53:24'),conversion('b'.repeat(32),'event','running','11:53:23',{stage:'copying'}),conversion('a'.repeat(32),'begin','started','11:53:20')];
    const ctx=view(records);try{assert.equal(rows(ctx.root).length,3);const statuses=rows(ctx.root).map(r=>r.querySelector('[data-history-result]').textContent);assert.deepEqual(statuses,['Needs attention','Succeeded','Failed']);}finally{ctx.close();}
    for(const extra of [[],[conversion('d'.repeat(32),'begin','started','11:53:20')]]){
        const stage=conversion('b'.repeat(32),'event','running','11:53:23',{stage:'copying'});const bounded=extra.length?[conversion('a'.repeat(32),'outcome','succeeded','11:53:25'),stage,...extra,conversion('a'.repeat(32),'begin','started','11:53:19')]:[stage];const x=view(bounded);try{assert.ok(rows(x.root).some(r=>r.dataset.historyOperation==='b'.repeat(32)),'Unmatched or ambiguous stage must remain independently visible');}finally{x.close();}
    }
});
test('conversion same-second audit append order distinguishes stages before outcome from later events',()=>{
    const records=[conversion('d'.repeat(32),'event','running','11:53:20',{stage:'copying'}),conversion('a'.repeat(32),'outcome','succeeded','11:53:20'),conversion('b'.repeat(32),'event','running','11:53:20',{stage:'published'}),conversion('a'.repeat(32),'begin','started','11:53:20')];
    const ctx=view(records);try{assert.equal(rows(ctx.root).length,2);assert.equal(rows(ctx.root).find(r=>r.dataset.historyOperation==='a'.repeat(32)).querySelector('[data-history-result]').textContent,'Succeeded');assert.equal(rows(ctx.root).find(r=>r.dataset.historyOperation==='d'.repeat(32)).querySelector('[data-history-result]').textContent,'Running / unconfirmed');}finally{ctx.close();}
});

test('Move history uses explicit begin source and destination even when outcome is returned first',()=>{
    const records=[entry('a','outcome','succeeded','2026-10-18T12:00:01Z',{}, {command:'movedirectory',succeeded:['/mnt/cache/test/destination/moved']}),entry('a','begin','started','2026-10-18T12:00:00Z',{directory:'/mnt/cache/test/source',newname:'/mnt/cache/test/destination/moved'}, {command:'movedirectory'})];
    const ctx=view(records);try{assert.equal(rows(ctx.root)[0].children[2].textContent,'/mnt/cache/test/source → /mnt/cache/test/destination/moved');assert.deepEqual(JSON.parse(rows(ctx.root)[0].querySelector('[data-audit-records]').textContent),records);}finally{ctx.close();}
});
