import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { runtime } from './php-runtime.mjs';

const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const click = (root, label) => {
    const control = [...root.querySelectorAll('button')].find(item => item.dataset.node === label || item.textContent === label || item.getAttribute('aria-label') === label);
    assert.ok(control, label);
    control.click();
};

test('acceptance security: a successful rollback consumes its preview before an identical replay', async () => {
    const php = await runtime();
    try {
        const result = await php.run({ code: `<?php
require '/app/harness.php';
function rollbackInventory() {
    expectProcess('zfs', ['list','-H','-p','-d','1','-t','snapshot,bookmark','-o','name,type,guid,createtxg','cache/data'], "cache/data@selected\tsnapshot\t101\t12");
}
rollbackInventory();
$preview = zfsmPreviewRollback('cache/data@selected','0','secret');
rollbackInventory();
zfsmValidateRollbackPreview('cache/data@selected','0','secret',$preview['token']);
expectProcess('zfs',['list','-H','-o','name','-t','snapshot','cache/data@selected'],'cache/data@selected');
expectProcess('zfs',['rollback','cache/data@selected'],'');
rollbackDatasetSnapshot('cache/data@selected','0');
// Live file writes leave this snapshot inventory and target GUID unchanged.
$refused = false;
try { zfsmValidateRollbackPreview('cache/data@selected','0','secret',$preview['token']); }
catch (Throwable $error) { $refused = true; }
echo json_encode(['replay_refused'=>$refused,'remaining_processes'=>count($GLOBALS['test_responses'])]);
` });
        assert.equal(result.errors, '', result.errors);
        assert.equal(result.exitCode, 0, result.text);
        const output = JSON.parse(result.text);
        assert.equal(output.replay_refused, true, 'a previously executed rollback token must not authorize erasing subsequent live writes');
        assert.equal(output.remaining_processes, 0);
    } finally { php.exit(); }
});

for (const mode of ['expired','tampered','changed-guid','changed-newer','replaced-newer-guid','replaced-newer-txg']) test('rollback preview refuses '+mode,async()=>{
 const php=await runtime();try{
  const result=await php.run({code:`<?php require '/app/harness.php';
  $args=['list','-H','-p','-d','1','-t','snapshot,bookmark','-o','name,type,guid,createtxg','cache/data'];
  $initial="cache/data@selected\tsnapshot\t101\t12";
  if(str_starts_with('${mode}','replaced-newer'))$initial.="\ncache/data@newer\tsnapshot\t102\t13";
  $flag=str_starts_with('${mode}','replaced-newer')?'1':'0';
  expectProcess('zfs',$args,$initial);
  $p=zfsmPreviewRollback('cache/data@selected',$flag,'secret');$file=zfsmRollbackPreviewFile($p['token']);
  $r=json_decode(file_get_contents($file),true);
  if('${mode}'==='expired'){$r['expires']=time()-1;file_put_contents($file,json_encode($r));}
  if('${mode}'==='tampered'){$r['scope']['target_guid']='999';file_put_contents($file,json_encode($r));}
  if('${mode}'==='changed-guid')expectProcess('zfs',$args,"cache/data@selected\tsnapshot\t999\t12");
  if('${mode}'==='changed-newer')expectProcess('zfs',$args,"cache/data@selected\tsnapshot\t101\t12\ncache/data@new\tsnapshot\t102\t13");
  if('${mode}'==='replaced-newer-guid')expectProcess('zfs',$args,"cache/data@selected\tsnapshot\t101\t12\ncache/data@newer\tsnapshot\t999\t13");
  if('${mode}'==='replaced-newer-txg')expectProcess('zfs',$args,"cache/data@selected\tsnapshot\t101\t12\ncache/data@newer\tsnapshot\t102\t14");
  $refused=false;try{zfsmValidateRollbackPreview('cache/data@selected',$flag,'secret',$p['token']);}catch(Throwable$e){$refused=true;}
  echo json_encode(['refused'=>$refused,'remaining'=>count($GLOBALS['test_responses'])]);`});
  assert.equal(result.errors,'');assert.deepEqual(JSON.parse(result.text),{refused:true,remaining:0});
 }finally{php.exit();}
});

