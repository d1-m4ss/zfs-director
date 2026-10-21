import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

function snapshots(count=2000) {
    return Array.from({length:count},(_,index)=>({name:'cache/data@snap-'+String(index).padStart(4,'0'),creation:1700000000+index,used:index,referenced:count-index,written:index%10,defer_destroy:index===0?'on':'off',userrefs:index===0?2:0,guid:String(index+100)}));
}
function fixture(rows=snapshots()) {
    const dom=new JSDOM('<main></main>',{url:'http://fixture.local/',runScripts:'outside-only',pretendToBeVisual:true});
    const w=dom.window,root=w.document.querySelector('main'),calls=[];
    w.ResizeObserver=class{observe(){}disconnect(){}};
    w.zfsmFormatDateTime=value=>String(value);
    const matches=w.Element.prototype.matches;
    w.Element.prototype.matches=function(selector){return selector===':popover-open'?this.dataset.testPopoverOpen==='true':matches.call(this,selector);};
    // jsdom has no top-layer popover visibility; adapt that browser boundary so
    // its real focus handling can exercise the production restoration logic.
    w.HTMLElement.prototype.showPopover=function(){this.dataset.testPopoverOpen='true';this.removeAttribute('popover');};
    w.HTMLElement.prototype.hidePopover=function(){delete this.dataset.testPopoverOpen;this.setAttribute('popover','manual');};
    for(const file of ['ZFSMForms.js','ZFSMSnapshots.js'])w.eval(readFileSync('src/frontend/'+file,'utf8'));
    let current=rows;
    function render(next=current,options={}) {
        current=next;
        w.zfsmRenderSnapshots(root,{node:{name:'cache/data',type:'filesystem',guid:'2',snapshots:next},pool:'cache',loaded:true,config:{destructive_mode:1},onAction:(action,ctx)=>calls.push({action,ctx}),...options});
    }
    render();
    return {w,root,calls,render,close(){w.zfsmDisposeSnapshots(root);w.close();}};
}
test('recursive snapshot scope shows descendants with explicit provenance and bookmarks',()=>{
 const x=fixture([]);try{const node={name:'cache/data',guid:'2',type:'filesystem',snapshots:[{...snapshots(1)[0],provenance:'Unknown'}],_bookmarks:{status:'known',entries:[{name:'cache/data#base',guid:'100'}]},child:{one:{name:'cache/data/child',guid:'3',snapshots:[{name:'cache/data/child@checkpoint',guid:'900',provenance:'Managed policy abc',replication_refs:['def'],last_verified_replication:'2026-10-18'}],child:{}}}};x.render(node.snapshots,{node});const scope=x.root.querySelector('[aria-label="Snapshot scope"]');assert.ok(scope);scope.value='recursive';scope.dispatchEvent(new x.w.Event('change',{bubbles:true}));assert.match(x.root.textContent,/cache\/data\/child@checkpoint/);assert.match(x.root.textContent,/Managed policy abc/);assert.match(x.root.textContent,/cache\/data#base/);assert.match(x.root.textContent,/Replication references: def/);}finally{x.close();}
});
const rows=root=>[...root.querySelectorAll('tbody tr')].filter(row=>row.querySelector('input[type=checkbox]'));
const names=root=>rows(root).map(row=>row.querySelector('input').value);
const control=(root,label)=>root.querySelector('[aria-label="'+label+'"]');
const button=(root,label)=>[...root.querySelectorAll('button')].find(item=>item.getAttribute('aria-label')===label||item.textContent===label);
function input(x,label,value){const target=control(x.root,label);assert.ok(target,label);target.value=value;target.dispatchEvent(new x.w.Event(target.tagName==='SELECT'?'change':'input',{bubbles:true}));return target;}
function select(x,name){const check=[...x.root.querySelectorAll('tbody input')].find(item=>item.value===name);assert.ok(check,name);check.checked=true;check.dispatchEvent(new x.w.Event('change',{bubbles:true}));}

test('recursive selection keeps full child names and rejects replaced GUID or incomplete descendant inventory',()=>{
 const child={name:'cache/data/child',type:'filesystem',guid:'3',snapshots:[{name:'cache/data/child@same',guid:'900'}],child:{}},parent={name:'cache/data',type:'filesystem',guid:'2',snapshots:[{name:'cache/data@same',guid:'100'}],child:{child}};const x=fixture([]);
 try{x.render(parent.snapshots,{node:parent});input(x,'Snapshot scope','recursive');select(x,'cache/data@same');select(x,'cache/data/child@same');button(x.root,'Destroy selected snapshots').click();assert.deepEqual(Array.from(x.calls[0].ctx.snapshots),['cache/data@same','cache/data/child@same']);
 child.snapshots=[{name:'cache/data/child@same',guid:'901'}];x.render(parent.snapshots,{node:parent});assert.equal(rows(x.root).find(r=>r.querySelector('input').value==='cache/data/child@same').querySelector('input').checked,false);
 child._snapshot_error='Unavailable';x.render(parent.snapshots,{node:parent});assert.equal(button(x.root,'Destroy selected snapshots').disabled,true);
 }finally{x.close();}
});

test('File Manager is directly discoverable and retains filesystem and freshness guards',()=>{
    const x=fixture(snapshots(1));try{
        const open=()=>x.root.querySelector('[data-file-manager="cache/data@snap-0000"]');
        assert.ok(open(),'Snapshot row has a visible File Manager button outside Operations');assert.equal(open().closest('details'),null);
        open().click();assert.equal(x.calls[0].action,'browsesnapshot');assert.equal(x.calls[0].ctx.snapshot,'cache/data@snap-0000');
        x.render(undefined,{loaded:false});assert.equal(open().disabled,true);
        x.render(undefined,{node:{name:'cache/data',type:'volume',guid:'2',snapshots:snapshots(1)}});assert.equal(open().disabled,true);
    }finally{x.close();}
});

test('2000 snapshots render a bounded page with visible action labels and accurate scope',()=>{
    const x=fixture();try{
        assert.equal(rows(x.root).length,50);
        assert.match(x.root.textContent,/Showing 1[–-]50 of 2000/);
        assert.match(x.root.textContent,/Dataset: cache\/data/);assert.match(x.root.textContent,/Direct snapshots only/);
        assert.ok(control(x.root,'Search snapshots'));assert.ok(control(x.root,'Sort snapshots'));
        assert.match(button(x.root,'Take Snapshot').textContent,/Take Snapshot/);
        assert.match(button(x.root,'Destroy selected snapshots').textContent,/Destroy selected snapshots/);
        assert.ok(control(x.root,'Select visible page'));
        assert.ok(x.root.querySelector('.zfsm-snapshot-controls').compareDocumentPosition(x.root.querySelector('table'))&x.w.Node.DOCUMENT_POSITION_FOLLOWING);
        assert.ok(x.root.querySelectorAll('button').length<500);
    }finally{x.close();}
});
test('search by name or dataset path and navigation find all snapshots without losing search focus',()=>{
    const x=fixture();try{
        const search=input(x,'Search snapshots','snap-1999');search.focus();
        assert.deepEqual(names(x.root),['cache/data@snap-1999']);assert.match(x.root.textContent,/1 matching snapshot/);
        input(x,'Search snapshots','cache/data@');assert.equal(x.w.document.activeElement,search);
        assert.equal(rows(x.root).length,50);
        for(let page=1;page<40;page++)button(x.root,'Next snapshots page').click();
        assert.ok(names(x.root).includes('cache/data@snap-1999'));
        assert.equal(button(x.root,'Next snapshots page').disabled,true);
        assert.match(x.root.textContent,/Showing 1951[–-]2000/);
        input(x,'Search snapshots','missing');assert.equal(rows(x.root).length,0);
        assert.match(x.root.textContent,/No snapshots match/);
    }finally{x.close();}
});
test('snapshot sorting uses numeric creation and byte values while preserving all row actions',()=>{
    const data=snapshots(3);data[0].used=100;data[1].used=2;data[2].used=20;
    const x=fixture(data);try{
        input(x,'Sort snapshots','used');assert.deepEqual(names(x.root),[data[1].name,data[2].name,data[0].name]);
        input(x,'Snapshot sort direction','desc');assert.deepEqual(names(x.root),[data[0].name,data[2].name,data[1].name]);
        input(x,'Sort snapshots','creation');assert.deepEqual(names(x.root),[data[2].name,data[1].name,data[0].name]);
        input(x,'Sort snapshots','referenced');assert.equal(names(x.root)[0],data[0].name);
        input(x,'Sort snapshots','name');input(x,'Snapshot sort direction','asc');
        const row=rows(x.root)[0];assert.match(row.textContent,/on/);assert.match(row.textContent,/2/);
        assert.deepEqual([...row.querySelectorAll('[data-snapshot-action]')].map(item=>item.dataset.snapshotAction),['browsesnapshot','renamesnapshot','holdsnapshot','releasesnapshot','clonesnapshot','rollbacksnapshot','destroysnapshot']);
        row.querySelector('[data-snapshot-action=clonesnapshot]').click();assert.equal(x.calls[0].ctx.snapshot,data[0].name);
    }finally{x.close();}
});
test('visible page selection preserves hidden selections and bulk operations include their exact names',()=>{
    const x=fixture(snapshots(101));try{
        const all=control(x.root,'Select visible page');all.checked=true;all.dispatchEvent(new x.w.Event('change',{bubbles:true}));
        button(x.root,'Next snapshots page').click();select(x,'cache/data@snap-0050');
        assert.match(x.root.textContent,/51 selected across all pages/);
        input(x,'Search snapshots','snap-0100');assert.equal(rows(x.root).length,1);
        assert.equal(control(x.root,'Select visible page').checked,false);
        button(x.root,'Destroy selected snapshots').click();
        assert.equal(x.calls.length,1);assert.equal(x.calls[0].ctx.snapshots.length,51);
        assert.equal(x.calls[0].ctx.snapshots[0],'cache/data@snap-0000');
        assert.equal(x.calls[0].ctx.snapshots[50],'cache/data@snap-0050');
        input(x,'Search snapshots','');assert.equal(rows(x.root)[0].querySelector('input').checked,true);
    }finally{x.close();}
});
test('only a fresh complete inventory prunes selections absent from a refresh',()=>{
    const data=snapshots(101),x=fixture(data);try{
        select(x,data[0].name);button(x.root,'Next snapshots page').click();select(x,data[50].name);
        x.render([],{snapshotError:'backend unavailable'});
        assert.match(x.root.textContent,/2 selected across all pages/);assert.equal(button(x.root,'Destroy selected snapshots').disabled,true);
        x.render(null,{loaded:false});assert.match(x.root.textContent,/2 selected across all pages/);
        x.render([{name:''}]);assert.match(x.root.textContent,/2 selected across all pages/);
        x.render(data.slice(1));assert.match(x.root.textContent,/1 selected across all pages/);
        button(x.root,'Destroy selected snapshots').click();assert.deepEqual(Array.from(x.calls[0].ctx.snapshots),[data[50].name]);
        x.render([]);assert.match(x.root.textContent,/0 selected across all pages/);
    }finally{x.close();}
});
test('recreated snapshot with the same name cannot inherit an old selection',()=>{
    const data=snapshots(2),x=fixture(data);try{select(x,data[0].name);x.render(data.map((s,i)=>i===0?{...s,guid:'999999999999999'}:s));assert.equal(rows(x.root)[0].querySelector('input').checked,false);assert.equal(button(x.root,'Destroy selected snapshots').disabled,true);}finally{x.close();}
});
test('refresh preserves page and focused popover action for the same snapshot identity',()=>{
    const data=snapshots(101),x=fixture(data);try{
        button(x.root,'Next snapshots page').click();
        const target=rows(x.root)[3],name=target.querySelector('input').value;
        target.querySelector('summary').click();target.querySelector('[data-snapshot-action=holdsnapshot]').focus();
        assert.equal(x.w.document.activeElement.dataset.snapshotAction,'holdsnapshot','popover action receives focus before refresh');
        x.root.querySelector('.zfsm-table-wrap').scrollLeft=120;
        x.render(data.map(snapshot=>({...snapshot,used:snapshot.used+1})));
        assert.match(x.root.textContent,/Showing 51[–-]100/);
        assert.equal(x.w.document.activeElement.dataset.snapshotAction,'holdsnapshot');
        assert.match(x.w.document.activeElement.title,new RegExp(name));
        assert.equal(x.root.querySelector('.zfsm-table-wrap').scrollLeft,120);
        x.w.document.activeElement.click();assert.equal(x.calls[0].ctx.snapshot,name);
    }finally{x.close();}
});
