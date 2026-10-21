import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';
test('native scrub schedule is read-only, exact-pool and truthful when unavailable',async()=>{
 const php=await runtime();try{const r=await php.run({code:`<?php require '/app/harness.php';
 file_put_contents('/cron-fixture',"0 6 1 * * /usr/local/emhttp/plugins/dynamix/scripts/zfs_scrub start cache &> /dev/null\\n0 7 2 * * /usr/local/emhttp/plugins/dynamix/scripts/zfs_scrub start cache2 &> /dev/null\\n");
 $m=zfsmNativeMaintenance('cache','/cron-fixture');same('Unraid',$m['owner']);same('0 6 1 * *',$m['schedule']);same(null,$m['next_run']);same('Unknown',zfsmNativeMaintenance('cache','/absent')['owner']);same('Unknown',zfsmNativeMaintenance('other','/cron-fixture')['owner']);same([], $GLOBALS['test_calls']);echo 'PASS native schedule ownership without mutation or invented next-run';
 `});assert.equal(r.exitCode,0,r.text);assert.equal(r.errors,'');console.log(r.text);}finally{php.exit();}
});
