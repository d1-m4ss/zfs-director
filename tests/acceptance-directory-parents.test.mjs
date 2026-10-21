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

test('legacy conversion trust predicate still refuses writable ancestors',async()=>{
 const php=await runtime();try{const r=await php.run({code:`<?php require '/app/harness.php';
 chmod('/',0755);mkdir('/private-parent/subdir/selected',0755,true);$safe=zfsmDirectoryParentsTrusted('/private-parent/subdir/selected');
 chmod('/private-parent',0777);$public=zfsmDirectoryParentsTrusted('/private-parent/subdir/selected');
 
 echo json_encode([$safe,$public]);`});assert.equal(r.errors,'');assert.deepEqual(JSON.parse(r.text),[true,false]);}finally{php.exit();}
});

test('acceptance security: recursive directory deletion stays within the verified filesystem during an ancestor swap', async () => {
    const php = await runtime();
    try {
        // Model an independent writer at the process boundary. All mkdir/rename/
        // symlink operations below affect only PHP WASM's virtual filesystem.
        php.writeFile('/app/harness.php', php.readFileAsText('/app/harness.php').replace(
            "$GLOBALS['test_calls'][] = [$command, $args];",
            "$GLOBALS['test_calls'][] = [$command, $args]; if (is_callable($GLOBALS['acceptance_process_hook'] ?? null)) ($GLOBALS['acceptance_process_hook'])($command, $args);"
        ));
        const result = await php.run({ code: `<?php
require '/app/harness.php';
mkdir('/mounted/data/parent/branch/selected', 0777, true);
mkdir('/outside/selected', 0777, true);
@mkdir('/proc/self', 0777, true);
file_put_contents('/proc/self/mountinfo', "1 0 1:1 / /mounted/data rw - zfs cache/data rw\n");
$source = '/mounted/data/parent/branch/selected';
chmod('/mounted/data/parent',0777);
function directoryMounts() {
    expectProcess('zfs',['list','-H','-o','name,mountpoint,mounted','-t','filesystem'], "cache/data\t/mounted/data\tyes");
}
directoryMounts(); directoryMounts();
$effect = null;
$GLOBALS['acceptance_process_hook'] = function($command,$args) use(&$effect,$source) {
    if ($command !== '/usr/bin/perl') return;
    rename('/mounted/data/parent/branch','/mounted/data/parent/original-branch');
    symlink('/outside','/mounted/data/parent/branch');
    $effect = realpath($source);
};
expectProcess('/usr/bin/perl',['/app/src/scripts/zfsm-directory.pl'],json_encode(['error'=>'Path is unavailable, contains a symbolic link, or crosses a mount']),1);
$answer = deleteDirectory($source,'1');
echo json_encode(['effect'=>$effect,'succeeded'=>!empty($answer['succeeded']),'remaining_processes'=>count($GLOBALS['test_responses'])]);
` });
        assert.equal(result.errors, '', result.errors);
        assert.equal(result.exitCode, 0, result.text);
        const output = JSON.parse(result.text);
        assert.equal(output.succeeded,false,'native refusal must never fall back to path-based rm');assert.equal(output.effect,'/outside/selected','independent writer actually replaced the ancestor before native refusal');assert.equal(output.remaining_processes,0);
    } finally { php.exit(); }
});

test('conversion refuses unavailable kernel confinement before persisting a background job',async()=>{
 const php=await runtime();try{const r=await php.run({code:`<?php require '/app/harness.php';
 $GLOBALS['plugin_state']='/preflight-jobs';$GLOBALS['zfsm_boot_id']='synthetic-boot';
 chmod('/',0755);mkdir('/conversion-mount/ordinary',0755,true);chmod('/conversion-mount',0777);@mkdir('/proc/self',0755,true);
 file_put_contents('/proc/self/mountinfo',"1 0 0:1 / / rw - rootfs rootfs rw\n2 1 0:2 / /conversion-mount rw - zfs cache/data rw\n");
 expectProcess('zfs',['list','-H','-o','name,mountpoint,mounted','-t','filesystem'],"cache/data\t/conversion-mount\tyes");
 expectProcess('zfs',['get','-H','-o','value','readonly','cache/data'],'off');
 expectProcess('/usr/bin/perl',['/app/src/scripts/zfsm-directory.pl'],json_encode(['error'=>'Filesystem creation notifications are required']),1);
 $answer=zfsmQueueConversion('/conversion-mount/ordinary','cache',true);
 echo json_encode(['answer'=>$answer,'jobs'=>count(glob('/preflight-jobs/*.json')?:[]),'commands'=>count($GLOBALS['test_calls'])]);`});
 const out=JSON.parse(r.text);assert.equal(out.jobs,0,'unsupported kernel confinement must not create a queued/recovery job');assert.equal(out.commands,3);assert.match(out.answer.failed['/conversion-mount/ordinary'],/Filesystem creation notifications/);
 }finally{php.exit();}
});
