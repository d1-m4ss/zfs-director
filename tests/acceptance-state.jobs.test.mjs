import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtime } from './php-runtime.mjs';

const id = '20261016-000000-123456789abc';
const restore = {schema:2, type:'restore', id, state:'completed', stage:'completed',
    snapshot:'cache/data@saved', snapshot_guid:'77', dataset:'cache/data', owner_guid:'99',
    owner_mountpoint:'/mnt/cache/data', source:'cache/data@saved', target:'/mnt/cache/data',
    staging:'/mnt/cache/data/.zfsm-restore-20261016-000000-123456789abc',
    hold_tag:'zfsm_restore_20261016-000000-123456789abc', hold_owned:true, cancel_requested:false,
    ack_boot:'test-boot', mode:'overwrite', bytes:10, files:1, conflicts:1,
    recovery:'/mnt/cache/data/.zfsm-restore-20261016-000000-123456789abc/replaced'};
const encoded = job => Buffer.from(JSON.stringify(job)).toString('base64');

test('schema 2 ownership, path and field corruption disables every automatic action', async () => {
    const php = await runtime();
    try {
        const archive = {...restore, type:'archive', source:'cache/data@saved', target:'ZIP download',
            staging:'/mnt/cache/data/.zfsm-archive-20261016-000000-123456789abc',
            hold_tag:'zfsm_archive_20261016-000000-123456789abc', archive_removed:false,
            destination_identity:{dev:'1', ino:'2'}, expires:1792141200,
            archive_identity:{dev:'1', ino:'3', type:'file'}, archive_size:10};
        const changes = [
            {...restore, owner_guid:''}, {...restore, snapshot_guid:77},
            {...restore, snapshot:'other/data@saved'}, {...restore, source:'other/data@saved'},
            {...restore, staging:'/mnt/other/staging'}, {...restore, recovery:'/mnt/other/replaced'},
            {...restore, target:'/mnt/cache/data/../other'}, {...restore, hold_owned:'yes'},
            {...restore, cancel_requested:1}, {...restore, conflicts:'1'},
            {...restore, stage:'unknown'}, {...archive, destination_identity:{}},
            {...archive, expires:[]}, {...archive, archive_identity:{dev:'1', ino:'3', type:'directory'}}
        ];
        const result = await php.run({code:`<?php require '/app/harness.php';
            $GLOBALS['plugin_worker_lock']='/acceptance-worker.lock';
            $valid=json_decode(base64_decode('${encoded([restore, archive])}'),true);
            $valid_problems=array_map('zfsmJobProblem',$valid);
            $cases=json_decode(base64_decode('${encoded(changes)}'),true); $results=[];
            foreach($cases as $index=>$job) {
                $GLOBALS['plugin_state']='/acceptance-jobs-'.$index;
                zfsmJobAtomicWrite(zfsmJobFile($job['id']),$job);
                $before=file_get_contents(zfsmJobFile($job['id']));
                try { zfsmCancelRestore($job['id']); } catch(Throwable $error) {}
                $results[]=['problem'=>zfsmJobProblem($job),'pending'=>zfsmPendingJobs(),
                    'actions'=>zfsmJobPage()['jobs'][0]['actions'],
                    'preserved'=>$before===file_get_contents(zfsmJobFile($job['id']))];
            }
            echo json_encode(['valid'=>$valid_problems,'results'=>$results,'calls'=>$GLOBALS['test_calls']],JSON_THROW_ON_ERROR);
        `});
        assert.equal(result.errors, '');
        assert.equal(result.exitCode, 0, result.text);
        const answer = JSON.parse(result.text);
        assert.deepEqual(answer.valid, [null, null], 'Production-shaped restore and archive journals must remain valid');
        for (const [index, item] of answer.results.entries()) {
            assert.ok(item.problem, 'Corrupt variant ' + index + ' was not diagnosed');
            assert.deepEqual(item.pending, [], 'Corrupt variant ' + index + ' entered the worker queue');
            assert.deepEqual(item.actions, {cancel:false, resume:false, download:false, inspect:true});
            assert.equal(item.preserved, true, 'Cancel rewrote corrupt variant ' + index);
        }
        assert.deepEqual(answer.calls, [], 'Validation must not invoke native operations');
    } finally { php.exit(); }
});

test('schema 2 journal with a foreign hold tag cannot enter automatic cleanup', async () => {
    const php = await runtime();
    try {
        const result = await php.run({code:`<?php require '/app/harness.php';
            $GLOBALS['plugin_state']='/acceptance-jobs';
            $id='${id}';
            $job=json_decode(base64_decode('${encoded({...restore, hold_tag:'keep_forever'})}'),true);
            zfsmJobAtomicWrite(zfsmJobFile($id),$job);
            echo json_encode(['problem'=>zfsmJobProblem($job),'pending'=>zfsmPendingJobs()],JSON_THROW_ON_ERROR);
        `});
        assert.equal(result.errors, '');
        assert.equal(result.exitCode, 0, result.text);
        const answer = JSON.parse(result.text);
        assert.equal(answer.pending.length, 0, 'A malformed schema 2 journal must remain inspection-only');
        assert.ok(answer.problem, 'The foreign hold tag must be reported as invalid ownership');
    } finally { php.exit(); }
});

test('restore cleanup cannot release an unrelated snapshot hold from a corrupt journal', async () => {
    const php = await runtime();
    try {
        const result = await php.run({code:`<?php require '/app/harness.php';
            $GLOBALS['plugin_state']='/acceptance-jobs';
            $id='${id}';
            $job=json_decode(base64_decode('${encoded({...restore, hold_tag:'keep_forever'})}'),true);
            zfsmJobAtomicWrite(zfsmJobFile($id),$job);
            expectProcess('zfs',['list','-H','-p','-d','1','-t','snapshot','-o','name,guid','cache/data'],"cache/data@saved\\t77");
            expectProcess('zfs',['holds','-H','cache/data@saved'],"cache/data@saved\\tkeep_forever\\t2026-10-16");
            expectProcess('zfs',['release','keep_forever','cache/data@saved']);
            $before=file_get_contents(zfsmJobFile($id));
            zfsmRunRestoreJob($id);
            echo json_encode(['calls'=>$GLOBALS['test_calls'],'job'=>zfsmReadJob($id),'preserved'=>$before===file_get_contents(zfsmJobFile($id))],JSON_THROW_ON_ERROR);
        `});
        assert.equal(result.errors, '');
        assert.equal(result.exitCode, 0, result.text);
        const answer = JSON.parse(result.text);
        assert.equal(answer.calls.some(([command, args]) => command === 'zfs' && args[0] === 'release'), false,
            'Corrupt journal issued a real cleanup command for an unrelated protection hold: ' + JSON.stringify(answer.calls));
        assert.equal(answer.job.hold_owned, true, 'Invalid ownership evidence must be retained for manual inspection');
        assert.equal(answer.preserved, true, 'The original journal must remain intact for inspection');
    } finally { php.exit(); }
});
