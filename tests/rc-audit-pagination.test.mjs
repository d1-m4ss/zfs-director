import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';
const record=(i)=>({version:1,operation_id:String(i).padStart(32,'0'),timestamp:'2026-10-16T12:00:00Z',command:'renamedataset',phase:'event',status:'succeeded',fields:{zdataset:'cache/item'+i}});
test('PHP bounded persistent audit pagination real filesystem adapter',async()=>{const php=await runtime();try{php.writeFile('/app/rc-audit-pagination.php',await readFile('tests/rc-audit-pagination.php'));const result=await php.run({scriptPath:'/app/rc-audit-pagination.php'});console.log(result.text);assert.equal(result.exitCode,0,result.text);assert.equal(result.errors,'');}finally{php.exit();}});

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
