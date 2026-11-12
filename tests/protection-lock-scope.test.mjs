import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startIntegration} from './integration/server.mjs';

// A long destructive/convert job holds the real operation lock
// ($GLOBALS['plugin_lock']) for its whole duration. Config-only protection
// commands must not wait behind it; they take the config lock instead, the
// same one saveconfig/adddirectortlisting/removedirectorylisting use. The
// php-wasm VFS does not enforce real cross-handle flock contention within one
// process (two fopen() handles on the same file both acquire LOCK_EX), so a
// genuine two-process race is covered natively (tests/native-linux); here the
// exact file requested by ZFSMAdmin.php is what is under test, so the shared
// lock acquisition helper is replaced to fail deterministically for the
// operation lock while still taking a real lock for any other file.
function simulateOperationLockHeld(php) {
    const file = '/app/src/include/ZFSMHelpers.php';
    const source = php.readFileAsText(file);
    const start = source.indexOf('function zfsmAcquireOperationLockWaiting(');
    assert.ok(start > 0);
    const end = source.indexOf('\nfunction ', start + 1);
    assert.ok(end > start);
    php.writeFile(file, source.slice(0, start) +
        "function zfsmAcquireOperationLockWaiting($file,$seconds=5.0) { if ($file===$GLOBALS['plugin_lock']) throw zfsmOperationLockFailure('lock_busy',['pid'=>1,'comm'=>'php']); return zfsmAcquireOperationLock($file); }\n" +
        source.slice(end));
}

function encode(fields) {
    const p = new URLSearchParams();
    function add(key, v) { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) add(key + '[' + k + ']', x); else p.append(key, String(v)); }
    for (const [k, v] of Object.entries(fields)) add(k, v);
    return p;
}
function poster(url) {
    return async fields => {
        const r = await fetch(url + '/plugins/zfs.master.ui/backend/ZFSMAdmin.php', { method: 'POST', body: encode({ csrf_token: 'integration-token', ...fields }) });
        return r.json();
    };
}
function ok(body) { assert.deepEqual(Object.keys(body.failed || {}), [], JSON.stringify(body)); return body; }

test('protectionsettings, protectionpolicysave, protectionreplicationsave, protectioncontrol, protectionrun and protectioncancel all succeed while the operation lock is held by a long job', async t => {
    const s = await startIntegration({ protection: true });
    t.after(() => s.close());
    simulateOperationLockHeld(s.php);
    const post = poster(s.url);
    const source = 'cache/__mock__/project';

    ok(await post({ cmd: 'protectionsettings', enabled: '0' }));
    ok(await post({ cmd: 'protectionsettings', enabled: '1' }));

    const policyPreview = ok(await post({ cmd: 'protectionpolicypreview', data: { name: 'Lock scope policy', dataset: source, hourly: '24', autoprune: '0' } }));
    const policySaved = ok(await post({ cmd: 'protectionpolicysave', preview_id: policyPreview.preview_id, token: policyPreview.token }));
    const policyId = policySaved.policy.id;

    const controlPreview = ok(await post({ cmd: 'protectioncontrolpreview', type: 'policy', id: policyId, action: 'disable' }));
    ok(await post({ cmd: 'protectioncontrol', preview_id: controlPreview.preview_id, token: controlPreview.token }));

    const replicationPreview = ok(await post({ cmd: 'protectionreplicationpreview', data: { name: 'Lock scope replication', source, target: 'cache/__mock__/lock-scope-backup' } }));
    const replicationSaved = ok(await post({ cmd: 'protectionreplicationsave', preview_id: replicationPreview.preview_id, token: replicationPreview.token }));
    const replicationId = replicationSaved.replication.id;

    const runPreview = ok(await post({ cmd: 'protectionrunpreview', type: 'replication', id: replicationId }));
    const queued = ok(await post({ cmd: 'protectionrun', preview_id: runPreview.preview_id, token: runPreview.token }));
    assert.equal(queued.job.schema, 4);

    ok(await post({ cmd: 'protectioncancel', job_id: queued.job.id }));
});

test('protectionimport succeeds while the operation lock is held by a long job', async t => {
    const s = await startIntegration({ protection: true });
    t.after(() => s.close());
    const source = 'cache/__mock__/project';
    s.php.writeFile('/etc/sanoid/sanoid.conf', '[' + source + "]\nhourly=3\nautosnap=yes\nautoprune=yes\n");
    await s.run({ code: "<?php chmod('/etc/sanoid/sanoid.conf',0644);" });
    const normalPost = poster(s.url);
    const external = ok(await normalPost({ cmd: 'protectiondata' })).policies.find(p => p.owner === 'external' && p.dataset === source);
    assert.ok(external);
    const importPreview = ok(await normalPost({ cmd: 'protectionimportpreview', id: external.id }));

    simulateOperationLockHeld(s.php);
    const post = poster(s.url);
    const saved = ok(await post({ cmd: 'protectionimport', preview_id: importPreview.preview_id, token: importPreview.token }));
    assert.equal(saved.policy.dataset, source);
});

test('protectionexternaltransfer succeeds while the operation lock is held by a long job', async t => {
    const s = await startIntegration({ protection: true });
    t.after(() => s.close());
    const script = '/boot/config/plugins/user.scripts/scripts/legacy/script';
    const setup = `<?php
foreach(['/boot','/boot/config','/boot/config/plugins','/boot/config/plugins/user.scripts','/boot/config/plugins/user.scripts/scripts','/boot/config/plugins/user.scripts/scripts/legacy','/tmp/user.scripts','/proc','/proc/123']as$d){if(!is_dir($d))mkdir($d,0755,true);chmod($d,0755);}chmod('/tmp',01777);
file_put_contents('/proc/123/cmdline',"php\\0");
$registry=['${script}'=>['script'=>'${script}','frequency'=>'disabled','custom'=>'15 3 * * *','id'=>'fixturelegacy']];
foreach(['/boot/config/plugins/user.scripts/schedule.json','/tmp/user.scripts/schedule.json']as$f){file_put_contents($f,json_encode($registry));chmod($f,0600);}
file_put_contents('${script}',"#!/bin/sh\\nsanoid --configdir=/etc/sanoid --cron\\n");chmod('${script}',0700);`;
    await s.run({ code: setup });
    const normalPost = poster(s.url);
    const source = (await normalPost({ cmd: 'protectiondata' })).scheduler.external[0];
    assert.ok(source, 'External source was not discovered by the default scan patterns');
    const transferPreview = ok(await normalPost({ cmd: 'protectionexternalpreview', id: source.id, type: 'policy', data: { dataset: 'cache/__mock__/project', schedule: '15 4 * * *' } }));

    simulateOperationLockHeld(s.php);
    const post = poster(s.url);
    const saved = ok(await post({ cmd: 'protectionexternaltransfer', preview_id: transferPreview.preview_id, token: transferPreview.token }));
    assert.equal(saved.policy.enabled, false);
});

test('editing, disabling or removing a definition whose job is currently running is refused with a clear message', async t => {
    const s = await startIntegration({ protection: true });
    t.after(() => s.close());
    const post = poster(s.url);
    const source = 'cache/__mock__/project';
    const preview = ok(await post({ cmd: 'protectionpolicypreview', data: { name: 'Running job policy', dataset: source, hourly: '24', autoprune: '0' } }));
    const saved = ok(await post({ cmd: 'protectionpolicysave', preview_id: preview.preview_id, token: preview.token }));
    const policy = saved.policy;

    // A job references this definition and is currently running.
    const policyId = JSON.stringify(policy.id);
    await s.run({ code: "<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';" +
        "$definition=zfsmProtectionReadStore()['policies'][" + policyId + "];" +
        "$j=zfsmNewProtectionJob('policy',$definition);" +
        "$j['state']='running';$j['stage']='inspecting';zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);" });

    const editPreview = ok(await post({ cmd: 'protectionpolicypreview', data: { id: policy.id, name: 'Edited while running', dataset: source, hourly: '12', autoprune: '0' } }));
    const edit = await post({ cmd: 'protectionpolicysave', preview_id: editPreview.preview_id, token: editPreview.token });
    assert.match(JSON.stringify(edit.failed), /pending job/);

    const controlPreview = ok(await post({ cmd: 'protectioncontrolpreview', type: 'policy', id: policy.id, action: 'disable' }));
    const disable = await post({ cmd: 'protectioncontrol', preview_id: controlPreview.preview_id, token: controlPreview.token });
    assert.match(JSON.stringify(disable.failed), /pending job/);

    const removePreview = ok(await post({ cmd: 'protectioncontrolpreview', type: 'policy', id: policy.id, action: 'remove' }));
    const remove = await post({ cmd: 'protectioncontrol', preview_id: removePreview.preview_id, token: removePreview.token });
    assert.match(JSON.stringify(remove.failed), /pending job/);
});
