import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readdirSync,readFileSync} from 'node:fs';
import {runtime} from './php-runtime.mjs';
// TEST-006: pool diagnostics parsed from output captured on a real OpenZFS system
// (tests/native-linux/real-zfs-capture.php in the disposable VM). Each fixture holds the exact
// zpool commands the plugin ran, their output, and what the plugin concluded on that system.
const folder=new URL('./fixtures/real-zfs/',import.meta.url);
const files=readdirSync(folder).filter(name=>name.endsWith('.json'));
test('captured real OpenZFS fixtures exist',()=>{assert.ok(files.length>0,'no real-zfs fixtures');});
for(const file of files){
 const capture=JSON.parse(readFileSync(new URL(file,folder),'utf8'));
 for(const [state,fixture] of Object.entries(capture.fixtures))test(capture.openzfs+' '+state+': diagnostics match the live result',async()=>{
  const php=await runtime();try{
   const responses=fixture.commands.map(c=>'expectProcess('+JSON.stringify(c.binary)+',json_decode('+JSON.stringify(JSON.stringify(c.args))+',true),json_decode('+JSON.stringify(JSON.stringify(c.output))+'),'+Number(c.code)+');').join('\n');
   const r=await php.run({code:"<?php require '/app/harness.php';\n"+responses+"\n$d=zfsmReadPoolDiagnostics("+JSON.stringify(capture.pool)+");echo json_encode(['health'=>$d['health'],'severity'=>$d['severity'],'scan_state'=>$d['scan']['state']??null,'scan_kind'=>$d['scan']['kind']??null,'reasons'=>$d['reasons'],'left'=>count($GLOBALS['test_responses'])]);"});
   assert.equal(r.errors,'',r.text);const got=JSON.parse(r.text);
   assert.equal(got.left,0,'every captured command was used');delete got.left;
   assert.deepEqual(got,fixture.expected);
  }finally{php.exit();}
 });
}
