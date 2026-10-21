import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {runtime} from './php-runtime.mjs';
const record=(i)=>({version:1,operation_id:String(i).padStart(32,'0'),timestamp:'2026-10-16T12:00:00Z',command:'renamedataset',phase:'event',status:'succeeded',fields:{zdataset:'cache/item'+i}});
function view(entries,options={}){const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),root=dom.window.document.querySelector('main');dom.window.eval(readFileSync('src/frontend/ZFSMHistory.js','utf8'));dom.window.zfsmRenderHistory(root,entries,options);return{dom,root,close:()=>dom.window.close()};}
const older=x=>[...x.root.querySelectorAll('button')].find(b=>b.textContent==='Load older records');
const tick=async()=>{for(let n=0;n<20;n++)await Promise.resolve();};
test('History Load older appends regrouped records while retaining filters sort and page',async()=>{
 const calls=[],x=view(Array.from({length:30},(_,i)=>record(i+30)),{hasMore:true,nextCursor:'first',scanLimited:true,loadOlder:async cursor=>{calls.push(cursor);return{entries:Array.from({length:30},(_,i)=>record(i)),has_more:false,next_cursor:null};}});try{
  const search=x.root.querySelector('[aria-label="Search history"]');search.value='cache/item';search.dispatchEvent(new x.dom.window.Event('input',{bubbles:true}));const sort=x.root.querySelector('[aria-label="Sort history"]');sort.value='oldest';sort.dispatchEvent(new x.dom.window.Event('change',{bubbles:true}));[...x.root.querySelectorAll('button')].find(b=>b.textContent==='Next page').click();
  assert.ok(older(x));older(x).click();await tick();assert.deepEqual(calls,['first']);assert.equal(search.value,'cache/item');assert.equal(sort.value,'oldest');assert.match(x.root.querySelector('[data-history-pagination]').textContent,/Page 2 of 3/);assert.match(x.root.textContent,/60 audit records returned/);assert.equal(older(x).hidden,true);assert.doesNotMatch(x.root.textContent,/Incomplete audit range/);
 }finally{x.close();}
});
test('History failure retains loaded records and requires an explicit retry; duplicate clicks stay single request',async()=>{
 let reject;const calls=[],x=view([record(1)],{hasMore:true,nextCursor:'first',loadOlder:cursor=>{calls.push(cursor);return new Promise((_,fail)=>reject=fail);}});try{
  assert.ok(older(x));older(x).click();older(x).click();assert.deepEqual(calls,['first']);reject(Error('Cursor expired; refresh history'));await tick();assert.match(x.root.textContent,/cache\/item1/);assert.match(x.root.textContent,/Cursor expired/);assert.equal(older(x).disabled,false);assert.equal(x.root.querySelectorAll('[data-history-operation]').length,1);
 }finally{x.close();}
});
test('History late older response cannot update a detached or replaced view',async()=>{
 let resolve;const x=view([record(1)],{hasMore:true,nextCursor:'first',loadOlder:()=>new Promise(done=>resolve=done)});try{
  assert.ok(older(x));older(x).click();x.root.replaceChildren(x.dom.window.document.createTextNode('NEW VIEW'));resolve({entries:[record(2)],has_more:false,next_cursor:null});await tick();assert.equal(x.root.textContent,'NEW VIEW');
 }finally{x.close();}
});
test('PHP bounded persistent audit pagination real filesystem adapter',async()=>{const php=await runtime();try{php.writeFile('/app/rc-audit-pagination.php',await readFile('tests/rc-audit-pagination.php'));const result=await php.run({scriptPath:'/app/rc-audit-pagination.php'});console.log(result.text);assert.equal(result.exitCode,0,result.text);assert.equal(result.errors,'');}finally{php.exit();}});

test('History presents the stored error category without guessing missing raw diagnostics',()=>{
 const failed={...record(1),phase:'outcome',status:'failed',reason:'not_authorized'},x=view([failed]);try{assert.match(x.root.textContent,/Error categoryPermission or authorization denied/);assert.doesNotMatch(x.root.textContent,/permission denied by server|CLI output/i);}finally{x.close();}
});

test('actual PHP endpoint retains only an allowlisted failure category across persistent pages',async()=>{
 const canary='DO-NOT-STORE-cause-secret-7391';
 for(const [message,reason] of [['Permission denied','not_authorized'],['No space left on device','storage_unavailable'],['Target already exists','conflict'],['Invalid property value','validation_failed'],['Unexpected native failure','command_failed']]){
  const php=await runtime();try{
   const result=await php.run({code:`<?php require '/app/harness.php';
    function parse_plugin_cfg($plugin,$sections){return [];}
    $docroot='/app/host';@mkdir('/app/host/webGui/include',0777,true);file_put_contents('/app/host/webGui/include/Helpers.php','<?php');@mkdir('/app/host/plugins',0777,true);symlink('/app/src','/app/host/plugins/zfs.master.ui');
    $GLOBALS['plugin_audit']='/test/cause-audit';$GLOBALS['var']=['csrf_token'=>'test-secret'];$_SERVER['REQUEST_METHOD']='POST';$_POST=['cmd'=>'scrubpool','pool'=>'cache','confirmed'=>'1','csrf_token'=>'test-secret'];
    expectProcess('zpool',['status','-p','-t','cache'],statusFixture('','0 0 0','none requested'));expectProcess('zpool',['list','-v','-p','cache'],infoFixture());expectProcess('zpool',['get','-H','-o','value','guid','cache'],'54321');expectProcess('/bin/date',['+%z'],'+0000');expectProcess('zpool',['scrub','cache'],${JSON.stringify(message+' '+canary)},1);
    ob_start();require '/app/src/backend/ZFSMAdmin.php';$response=json_decode(ob_get_clean(),true,512,JSON_THROW_ON_ERROR);$page=zfsmAuditPage(1);$older=zfsmAuditPage(1,$page['next_cursor']);
    echo json_encode(['response'=>$response,'page'=>$page,'older'=>$older,'stored'=>file_get_contents($GLOBALS['plugin_audit'].'/'.gmdate('Y-m-d').'.jsonl')],JSON_THROW_ON_ERROR);
   `});
   const answer=JSON.parse(result.text);assert.equal(answer.response.failed.cache,message+' '+canary,JSON.stringify(answer.response));assert.equal(answer.response.job.result.failure.exit_code,1);assert.ok(answer.response.job.result.failure.stage);assert.equal(result.errors,'');assert.equal(answer.page.entries[0].phase,'outcome');assert.equal(answer.page.entries[0].reason,reason);assert.equal(answer.older.entries[0].phase,'begin');assert.equal(answer.older.has_more,false);assert.equal(JSON.stringify([answer.page,answer.older,answer.stored]).includes(canary),false);
  }finally{php.exit();}
 }
});
