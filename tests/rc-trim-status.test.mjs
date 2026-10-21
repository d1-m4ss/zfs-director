import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {runtime} from './php-runtime.mjs';

test('native read-only TRIM query uses narrow compatibility fallback and never masks command or checksum errors',async()=>{
 const php=await runtime();try{php.writeFile('/app/rc-trim-status.php',await readFile('tests/rc-trim-status.php'));const r=await php.run({scriptPath:'/app/rc-trim-status.php'});console.log(r.text);assert.equal(r.errors,'');assert.equal(r.exitCode,0,r.text);}finally{php.exit();}
});
function render(extra={}){
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window,root=w.document.querySelector('main');w.zfsmFormatDateTime=x=>String(x);w.eval(readFileSync('src/frontend/ZFSMPoolView.js','utf8'));
 w.zfsmRenderPoolDiagnostics(root,{pool:'cache',health:'ONLINE',severity:'ok',reasons:[],trim:{available:true},status:{scan:'scrub repaired 0B with 0 errors on Mon Oct 12 06:15:55 2026',rows:[{name:'disk1',state:'ONLINE',read:'0',write:'0',cksum:'0',note:'(100% trimmed, completed at Mon Oct 12 02:10:32 2026)'}]},information:{rows:[]},...extra},'status');
 return {root,close(){w.close();}};
}
const value=(x,label)=>[...x.root.querySelectorAll('.zfsm-maintenance-summary dt')].find(n=>n.textContent===label)?.nextElementSibling?.textContent;
test('maintenance displays reported per-vdev TRIM and native last scan text without inferred dates',()=>{
 const x=render();try{assert.equal(value(x,'TRIM'),'disk1: (100% trimmed, completed at Mon Oct 12 02:10:32 2026)');assert.equal(value(x,'Current / last scan'),'scrub repaired 0B with 0 errors on Mon Oct 12 06:15:55 2026');assert.doesNotMatch(x.root.textContent,/Last successful maintenance|Next TRIM/);}finally{x.close();}
});
for(const extra of [{trim:{available:false,reason:'zpool status -t is unsupported'}},{trim:undefined},{status:{rows:[]}}])test('unavailable or unreported TRIM remains explicitly Unknown '+JSON.stringify(extra),()=>{
 const x=render(extra);try{assert.match(value(x,'TRIM'),/^Unknown/);if(extra.status)assert.equal(value(x,'Current / last scan'),'Unknown');}finally{x.close();}
});
test('native TRIM notes and scan text render as text without executable markup',()=>{
 const x=render({status:{scan:'<img src=x>',rows:[{name:'<img src=x>',note:'(trim unsupported)'}]}});try{assert.equal(x.root.querySelector('img'),null);assert.ok(value(x,'TRIM').includes('<img'));assert.equal(value(x,'Current / last scan'),'<img src=x>');}finally{x.close();}
});
