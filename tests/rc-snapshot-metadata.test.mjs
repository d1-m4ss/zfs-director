import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {runtime} from './php-runtime.mjs';
function render(overrides={}){
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,root=w.document.querySelector('main');w.ResizeObserver=class{observe(){}disconnect(){}};w.zfsmFormatDateTime=value=>String(value);
 for(const file of ['ZFSMForms.js','ZFSMSnapshots.js'])w.eval(readFileSync('src/frontend/'+file,'utf8'));
 w.zfsmRenderSnapshots(root,{node:{name:'cache/data',type:'filesystem',guid:'2',snapshots:[{name:'cache/data@s1',guid:'77',used:10,referenced:20,written:30,userrefs:2,creation:1700000000,...overrides}]},pool:'cache',loaded:true,config:{destructive_mode:1},onAction(){}});
 return {root,close(){w.zfsmDisposeSnapshots(root);w.close();}};
}
test('snapshot accounting has discoverable semantic help and explicit direct scope',()=>{
 const x=render();try{assert.match(x.root.textContent,/Direct snapshots only/);assert.match(x.root.textContent,/Referenced.*accessible|accessible.*Referenced/i);assert.match(x.root.textContent,/Written.*since|since.*Written/i);assert.match(x.root.textContent,/Used.*exclusive|exclusive.*Used/i);assert.match(x.root.textContent,/cannot.*sum|not.*additive/i);}finally{x.close();}
});
test('snapshot metadata displays actual clone dependencies and hold names as text',()=>{
 const x=render({clone_dependencies:['cache/clone-a','cache/clone-b'],hold_names:['backup','<img src=x onerror=alert(1)>']});try{
  const row=x.root.querySelector('tbody tr');assert.equal(row.querySelector('[data-label=Name]')?.firstElementChild?.textContent,'cache/data@s1');assert.match(row.textContent,/cache\/clone-a/);assert.match(row.textContent,/cache\/clone-b/);assert.match(row.textContent,/backup/);assert.match(row.textContent,/<img/);assert.equal(row.querySelector('img'),null);
 }finally{x.close();}
});
test('missing snapshot dependency and hold metadata stay Unknown with reported counter retained',()=>{
 const x=render();try{const row=x.root.querySelector('tbody tr');assert.match(row.textContent,/Clone dependencies.*Unknown/);assert.match(row.textContent,/Hold names.*Unknown/);assert.equal(row.querySelector('[data-label=Holds]').textContent.includes('2'),true);}finally{x.close();}
});
test('verified empty metadata is explicitly None rather than Unknown',()=>{
 const x=render({userrefs:0,clone_dependencies:[],hold_names:[]});try{const row=x.root.querySelector('tbody tr');assert.match(row.textContent,/Clone dependencies.*None/);assert.match(row.textContent,/Hold names.*None/);}finally{x.close();}
});
test('PHP real snapshot inventory and bounded metadata adapters',async()=>{
 const php=await runtime();try{php.writeFile('/app/rc-snapshot-metadata.php',await readFile('tests/rc-snapshot-metadata.php'));const result=await php.run({scriptPath:'/app/rc-snapshot-metadata.php'});console.log(result.text);assert.equal(result.errors,'');assert.equal(result.exitCode,0,result.text);}finally{php.exit();}
});
