import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('canonical Director page is the only Director block embedded into native Main',()=>{
 const pages=readdirSync('src').filter(name=>name.endsWith('.page')).map(name=>({name,text:readFileSync('src/'+name,'utf8')}));
 const main=pages.filter(page=>/^Menu="Main:2"$/m.test(page.text));assert.equal(main.length,1);assert.equal(main[0].name,'ZFSDirector.page');assert.match(main[0].text,/zfsmCreateWorkspace/);
 assert.equal(JSON.parse(readFileSync('src/plugin.json')).launch,'Main/ZFSDirector');
});
test('legacy launch keeps bookmark query and fragment and redirects only to the canonical local route',()=>{
 const alias=readFileSync('src/ZFSMaster.page','utf8');assert.match(alias,/window.location.replace/);
 const scripts=[...alias.matchAll(/<script>([\s\S]*?)<\/script>/g)];assert.equal(scripts.length,1);
 for(const [search,hash,want] of [['','','/Main/ZFSDirector'],['?section=settings','#advanced','/Main/ZFSDirector?section=settings#advanced'],['?pool=cache&dataset=cache%2Ftest&tab=snapshots','','/Main/ZFSDirector?pool=cache&dataset=cache%2Ftest&tab=snapshots'],['?redirect=https://example.invalid','#x','/Main/ZFSDirector?redirect=https://example.invalid#x']]){
  let redirected;runInNewContext(scripts[0][1],{window:{location:{search,hash,replace:value=>{redirected=value;}}}});assert.equal(redirected,want);
 }
 assert.doesNotMatch(alias,/zfsmCreateWorkspace|Menu="Main/);
});
