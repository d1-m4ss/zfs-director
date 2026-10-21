import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile as readAsync } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { runtime } from './php-runtime.mjs';

test('encryption inventory and atomic PCRE settings validation (real PHP, virtual filesystem)', async () => {
  const php = await runtime();
  try {
    php.writeFile('/app/encryption-settings.php', await readAsync('tests/encryption-settings.php'));
    const result=await php.run({scriptPath:'/app/encryption-settings.php'});
    console.log(result.text); assert.equal(result.errors,''); assert.equal(result.exitCode,0,result.text);
  } finally {php.exit();}
});
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
async function form(action, node, overrides={}) {
  const instance=new JSDOM('<main></main>',{url:'http://fixture.local',runScripts:'outside-only'}), w=instance.window;
  w.eval(readFileSync('src/frontend/ZFSMForms.js','utf8'));
  const calls=[], request=async data=>{calls.push(data);return {valid:true,errors:{},snapshot_preview:'cache/data@auto-2026-10-16-120000'};};
  const forms=w.zfsmCreateInlineForms({request,getConfig:()=>({destructive_mode:1}),getDatasets:()=>['cache','cache/secure'],getDataset:name=>name==='cache/secure'?node:{name:'cache',encryption:'off'},...overrides});
  const root=w.document.querySelector('main');await forms.render(root,action,{pool:'cache',dataset:node.name,type:'filesystem',node});await settle();
  return {instance,w,root,calls};
}
test('create offers honest inherit/new root labels and effective parent encryption',async()=>{
  const {instance,root}=await form('createdataset',{name:'cache/secure',encryption:'aes-256-gcm',encryptionroot:'cache/secure',keystatus:'available'});
  try {
    const choices=[...root.querySelector('[name=encryption]').options].map(o=>o.textContent);assert.deepEqual(choices,['Inherit from parent','Create new encryption root']);
    assert.match(root.textContent,/Effective encryption:.*cache\/secure/i);assert.equal(root.querySelector('[name=passphrase]').disabled,true);
  }finally{instance.window.close();}
});
for(const action of ['lockdataset','unlockdataset'])test(action+' refuses inheriting child',async()=>{
  const {instance,root}=await form(action,{name:'cache/secure/child',encryption:'aes-256-gcm',encryptionroot:'cache/secure',keystatus:action==='lockdataset'?'available':'unavailable'});
  try{assert.match(root.textContent,/encryption root/i);assert.equal(root.querySelector('input[type=password]'),null);assert.equal(root.querySelector('button[type=submit]'),null);}finally{instance.window.close();}
});
test('settings server validation renders inline field errors using PCRE result',async()=>{
  const {instance,w,root,calls}=await form('saveconfig',{name:'cache'},{request:async data=>{return {valid:false,errors:{exclusion:'Invalid PCRE pattern. Example: ^cache/temp(?:/|$)'},snapshot_preview:'cache/data@auto-2026-10-16-120000'};}});
  try {const input=root.querySelector('[name=exclusion]');input.value='[';input.dispatchEvent(new w.Event('input',{bubbles:true}));await settle();assert.equal(input.checkValidity(),false);assert.match(root.textContent,/Invalid PCRE/);assert.match(root.textContent,/cache\/data@auto-/);}finally{instance.window.close();}
});
