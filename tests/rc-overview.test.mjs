import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const dataset = {name:'cache/data',type:'filesystem',guid:'2',used:20,available:80,referenced:10,quota:0,refquota:0,reservation:0,refreservation:0,encryption:'aes-256-gcm',encryptionroot:'cache/data',keystatus:'available',keyformat:'passphrase',mounted:'yes',child:{},snapshots:[]};
function render(node=dataset,extra={}) {
    const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),host=dom.window.document.querySelector('main'),calls=[];
    dom.window.eval(readFileSync('src/frontend/ZFSMOverview.js','utf8'));
    dom.window.zfsmRenderDatasetOverview(host,{node,pool:'cache',fresh:true,loaded:true,bytes:value=>value+' B',date:value=>'DATE '+value,config:{snap_max_days_alert:30},onAction:action=>calls.push(action),onTab:tab=>calls.push(tab),...extra});
    return {host,calls,close:()=>dom.window.close()};
}
const card=(x,title)=>[...x.host.querySelectorAll('.zfsm-overview-card')].find(n=>n.querySelector('h3')?.textContent===title);
const value=(section,label)=>[...section.querySelectorAll('dt')].find(n=>n.textContent===label)?.nextElementSibling;

test('Overview Space values and sources come from the same fresh reported properties',()=>{
    const properties={...dataset,quota:1000,refquota:700,reservation:100,refreservation:50,_sources:{quota:'local',refquota:'inherited from cache',reservation:'received',refreservation:'default'}};
    const x=render(dataset,{propertiesFresh:true,properties});try{
        const space=card(x,'Space Management');
        for(const [name,expected] of [['Quota','1000 B · Source: local'],['Refquota','700 B · Source: inherited from cache'],['Reservation','100 B · Source: received'],['Refreservation','50 B · Source: default']])assert.equal(value(space,name)?.textContent,expected);
    }finally{x.close();}
});

test('Overview Encryption values and sources come from the same fresh reported properties',()=>{
    const properties={...dataset,encryptionroot:'cache',keystatus:'unavailable',mounted:'no',_sources:{encryption:'inherited from cache',encryptionroot:'-',keystatus:'-',keyformat:'received',mounted:'temporary'}};
    const x=render(dataset,{propertiesFresh:true,properties});try{
        const encryption=card(x,'ZFS Encryption');
        assert.match(value(encryption,'State').textContent,/inherited.*locked by ancestor/);
        for(const [name,expected] of [['Encryption','aes-256-gcm · Source: inherited from cache'],['Encryption root','cache · Source: -'],['Key status','unavailable · Source: -'],['Key format','passphrase · Source: received'],['Mounted','no · Source: temporary']])assert.equal(value(encryption,name)?.textContent,expected);
    }finally{x.close();}
});

for(const fresh of [false,true])test('Overview missing or stale sources remain Unknown without inventing inheritance: fresh='+fresh,()=>{
    const properties={...dataset,_sources:{quota:fresh?'':'INJECTED-STALE-SOURCE',encryption:fresh?'':'INJECTED-STALE-SOURCE'}};
    const x=render(dataset,{propertiesFresh:fresh,properties});try{
        assert.match(value(card(x,'Space Management'),'Quota').textContent,/Source: Unknown/);
        assert.match(value(card(x,'ZFS Encryption'),'Encryption').textContent,/Source: Unknown/);
        assert.doesNotMatch(x.host.textContent,/INJECTED-STALE-SOURCE/);
    }finally{x.close();}
});

test('Overview volume omits filesystem quotas but preserves valid reservation and refreservation',()=>{
    const node={...dataset,type:'volume',quota:0,refquota:0,reservation:256,refreservation:512};
    const x=render(node,{propertiesFresh:true,properties:{...node,_sources:{reservation:'local',refreservation:'local'}}});try{
        const space=card(x,'Space Management');assert.equal(value(space,'Quota'),undefined);assert.equal(value(space,'Refquota'),undefined);
        assert.equal(value(space,'Reservation').textContent,'256 B · Source: local');assert.equal(value(space,'Refreservation').textContent,'512 B · Source: local');
        assert.equal([...space.querySelectorAll('button')].some(n=>n.textContent==='Manage quota'),false);
        assert.equal(value(card(x,'ZFS Encryption'),'Mounted').textContent,'Not applicable');
    }finally{x.close();}
});

test('Overview absent volume reservation data stays Unknown while reported zero means None',()=>{
    const x=render({...dataset,type:'volume',quota:null,refquota:null,reservation:null,refreservation:0});try{
        const space=card(x,'Space Management');assert.match(value(space,'Reservation').textContent,/^Unknown/);assert.match(value(space,'Refreservation').textContent,/^None/);
        assert.doesNotMatch(space.textContent,/Unlimited/);
    }finally{x.close();}
});

test('Overview protection exposes separate unknown execution and failure facts and View Snapshots',()=>{
    const x=render();try{
        const protection=card(x,'Data Protection');
        for(const name of ['Last scheduled execution','Last successful execution','Last failure'])assert.equal(value(protection,name)?.textContent,'Unknown');
        assert.doesNotMatch(protection.textContent,/\b(?:Configured|No schedule|Protected|Daily)\b/);
        const view=[...protection.querySelectorAll('button')].find(n=>n.textContent==='View Snapshots');assert.ok(view);view.click();assert.deepEqual(x.calls,['snapshots']);
    }finally{x.close();}
});

test('Overview reported sources are text and never create executable markup',()=>{
    const source='<img src=x onerror=alert(1)>',x=render(dataset,{propertiesFresh:true,properties:{...dataset,_sources:{quota:source,encryption:source}}});try{
        assert.ok(value(card(x,'Space Management'),'Quota').textContent.includes(source));assert.ok(value(card(x,'ZFS Encryption'),'Encryption').textContent.includes(source));assert.equal(x.host.querySelector('img,script'),null);
    }finally{x.close();}
});

test('Overview reports verified ACL properties separately from unknown ACL entries',()=>{
 const properties={...dataset,acltype:'posix',aclmode:'passthrough',aclinherit:'restricted',_sources:{acltype:'local',aclmode:'inherited from cache',aclinherit:'default'}};
 const x=render(dataset,{propertiesFresh:true,properties});try{
  const usage=card(x,'Usage & Permissions');assert.equal(value(usage,'ACL type').textContent,'posix · Source: local');assert.equal(value(usage,'ACL mode').textContent,'passthrough · Source: inherited from cache');assert.equal(value(usage,'ACL entries').textContent,'Unknown');
 }finally{x.close();}
});
