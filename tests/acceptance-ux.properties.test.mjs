import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';

async function setup(overrides={}){
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window,root=w.document.querySelector('main'),calls=[];
 w.eval(readFileSync('src/frontend/ZFSMForms.js','utf8'));
 const properties={name:'cache/data',type:'filesystem',guid:'18446744073709551615',mountpoint:'/mnt/cache/data',compression:'lz4',quota:0,refquota:0,reservation:0,refreservation:0,recordsize:131072,atime:'off',xattr:'sa',primarycache:'all',readonly:'off',sync:'standard',casesensitivity:'sensitive',encryption:'aes-256-gcm',encryptionroot:'cache',keystatus:'available',keyformat:'passphrase',mounted:'yes',used:100,available:900,referenced:80,compressratio:101,origin:'cache/base@s1',creation:1792141200,dedup:'off',_sources:{encryption:'inherited from cache',encryptionroot:'-',keyformat:'received',mounted:'temporary',casesensitivity:'local',compression:'default'},...overrides};
 const forms=w.zfsmCreateInlineForms({request:async fields=>{calls.push(fields);return properties;}});
 await forms.render(root,'editdatasetproperty',{pool:'cache',dataset:'cache/data',type:properties.type,node:{guid:properties.guid}});
 return {root,w,calls,close(){forms.dispose();w.close();}};
}
const group=(root,label)=>[...root.querySelectorAll('fieldset')].find(n=>n.querySelector('legend')?.textContent===label);

test('Security properties retain effective values and reported sources without offering unsafe Save controls',async()=>{
 const x=await setup({acltype:'posix',aclmode:'passthrough',aclinherit:'restricted'});try{
  const security=group(x.root,'Security');assert.ok(security,'Security group must exist');
  for(const value of ['aes-256-gcm','cache','available','passphrase','yes','posix','passthrough','restricted','inherited from cache','received','temporary'])assert.ok(security.textContent.includes(value),value);
  assert.equal(security.querySelector('input,select,[data-save-property]'),null);
  assert.match(security.textContent,/read.only/i);assert.equal(x.calls.filter(c=>c.cmd==='editdatasetproperty').length,0);
 }finally{x.close();}
});

test('General and Advanced present immutable native properties while editable controls keep their meaningful groups',async()=>{
 const x=await setup();try{
  const general=group(x.root,'General'),advanced=group(x.root,'Advanced');assert.ok(advanced,'Advanced group must exist');
  assert.match(general.textContent,/Case sensitivity/);assert.match(general.textContent,/sensitive/);assert.match(general.textContent,/local/);
  for(const value of ['18446744073709551615','cache/base@s1','1.01x','100'])assert.ok(advanced.textContent.includes(value),value);
  assert.equal(general.querySelector('[name=casesensitivity]'),null);assert.equal(advanced.querySelector('input,select,[data-save-property]'),null);
  for(const [field,title]of [['readonly','General'],['compression','Performance'],['recordsize','Performance'],['quota','Space'],['refquota','Space']])assert.ok(group(x.root,title).querySelector('[data-save-property="'+field+'"]'),field+' in '+title);
 }finally{x.close();}
});

test('missing security metadata stays unavailable and never fabricates effective encryption or its source',async()=>{
 const x=await setup({encryption:undefined,encryptionroot:undefined,keystatus:undefined,keyformat:undefined,mounted:undefined,_sources:{}});try{
  const security=group(x.root,'Security');assert.ok(security);assert.match(security.textContent,/not available|unavailable|unknown/i);assert.doesNotMatch(security.textContent,/Unencrypted|Encryption.*off|Source: default/);
 }finally{x.close();}
});

test('volume read-only groups omit filesystem and ACL state while exposing volume block size',async()=>{
 const x=await setup({type:'volume',volblocksize:16384,acltype:'posix',mounted:'no'});try{
  const text=x.root.textContent,advanced=group(x.root,'Advanced');assert.ok(advanced,'Advanced volume summary must exist');assert.doesNotMatch(text,/Case sensitivity|Mounted state|ACL type/);assert.match(advanced.textContent,/Volume block size/);assert.match(advanced.textContent,/16384/);
  assert.equal(x.root.querySelector('[data-save-property=mountpoint]'),null);
 }finally{x.close();}
});

test('read-only native property values and sources are text rather than executable markup',async()=>{
 const x=await setup({encryptionroot:'<img src=x onerror=alert(1)>',_sources:{encryption:'<script>bad()</script>'}});try{
  const security=group(x.root,'Security');assert.ok(security);assert.match(security.textContent,/<img/);assert.match(security.textContent,/<script>/);assert.equal(security.querySelector('img,script'),null);
 }finally{x.close();}
});

test('volume retains editable reservation and refreservation without exposing filesystem quotas',async()=>{
 const x=await setup({type:'volume',reservation:256,refreservation:512});try{
  assert.ok(x.root.querySelector('[data-save-property=reservation]'),'zvol reservation must remain editable');assert.ok(x.root.querySelector('[data-save-property=refreservation]'),'zvol refreservation must remain editable');assert.equal(x.root.querySelector('[data-save-property=quota]'),null);assert.equal(x.root.querySelector('[data-save-property=refquota]'),null);
 }finally{x.close();}
});
