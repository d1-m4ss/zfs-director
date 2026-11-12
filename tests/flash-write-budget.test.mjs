import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startIntegration} from './integration/server.mjs';

// Counts durable fsync+directory-fsync writes under /boot/config/plugins/zfs.master.ui by
// hooking the three primitives that perform them: zfsmJobAtomicWrite (jobs/ journals and the
// protection/ config.json(.bak) pair), zfsmAuditAppend (audit/ journal) and
// zfsmProtectionWriteStore (informational breakdown only -- its writes already land in the
// zfsmJobAtomicWrite total, so it is never added on top of "jobs"). The hooks are inserted only
// into this test's virtual PHP-WASM filesystem copy of src/, the same way other tests in this
// suite patch process/network boundaries (see tests/php-runtime.mjs, tests/integration/server.mjs);
// the real src/ files on disk are never edited.
const COUNTER_FILE = '/test-write-counts.json';
function countedWrite(kind) {
    return `$__wc=is_file('${COUNTER_FILE}')?json_decode(file_get_contents('${COUNTER_FILE}'),true):['jobs'=>0,'audit'=>0,'store'=>0];$__wc['${kind}']=($__wc['${kind}']??0)+1;file_put_contents('${COUNTER_FILE}',json_encode($__wc));`;
}
function inject(php, file, signature, kind) {
    const source = php.readFileAsText(file), at = source.indexOf(signature);
    assert.ok(at >= 0, signature);
    php.writeFile(file, source.slice(0, at + signature.length) + ' ' + countedWrite(kind) + ' ' + source.slice(at + signature.length));
}
function instrumentWrites(php) {
    inject(php, '/app/src/include/ZFSMJobs.php', 'function zfsmJobAtomicWrite($file,$data) {', 'jobs');
    inject(php, '/app/src/include/ZFSMAudit.php', 'function zfsmAuditAppend(array $entry): void {', 'audit');
    inject(php, '/app/src/include/ZFSMProtection.php', 'function zfsmProtectionWriteStore(array $data): void {', 'store');
}
function resetCounts(php) { php.writeFile(COUNTER_FILE, JSON.stringify({jobs: 0, audit: 0, store: 0})); }
function readCounts(php) { return JSON.parse(php.readFileAsText(COUNTER_FILE)); }

test('a scheduled policy idle check that creates nothing makes 5 flash writes and no audit append', async () => {
    const s = await startIntegration({protection: true});
    try {
        instrumentWrites(s.php);
        // Same simulated sanoid override as tests/idle-protection-checks.test.mjs: a non-readonly
        // --take-snapshots invocation reports nothing due, i.e. no snapshot is created or pruned.
        const file = '/acceptance/system.php', text = s.php.readFileAsText(file), marker = 'function integrationProcess($command,$args,$stdin=null) {';
        assert.ok(text.includes(marker));
        s.php.writeFile(file, text.replace(marker, marker + `
 if($command==='/usr/sbin/sanoid'&&in_array('--take-snapshots',$args,true)&&!in_array('--readonly',$args,true))return ['code'=>0,'output'=>'SYNTHETIC nothing due'];
`));
        const r = await s.run({code: `<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
$p=zfsmSanoidPolicy(['id'=>'abc','dataset'=>'cache/__mock__/project','autosnap'=>false,'autoprune'=>false]);
$p['source_guid']=zfsmReadIdentity($p['dataset'])['guid'];
$store=zfsmProtectionReadStore();$store['policies']['abc']=$p;zfsmProtectionWriteStore($store);
file_put_contents('${COUNTER_FILE}',json_encode(['jobs'=>0,'audit'=>0,'store'=>0]));
$queued=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);
zfsmRunProtectionJob(zfsmReadJob($queued['job']['id']));
echo file_get_contents('${COUNTER_FILE}');`});
        assert.equal(r.errors, '', r.text);
        const counts = JSON.parse(r.text);
        // BASELINE (measured): zfsmQueueProtection writes the queued journal (1), then
        // zfsmRunProtectionJob writes it running (2) and zfsmProtectionFinish writes it finished
        // (3); zfsmSanoidExecute unconditionally calls zfsmProtectionWriteStore (src/include/ZFSMSanoid.php:164),
        // which writes protection/config.json.bak and protection/config.json even though nothing
        // was created (+2) = 5 total. zfsmProtectionDropIdleCheck then deletes the now-idle
        // journal with a plain unlink, not counted as a write. No audit entry for a quiet
        // scheduled policy check. TARGET after REL-002/ARCH-001: idle check -> 0 writes.
        assert.deepEqual(counts, {jobs: 5, audit: 0, store: 1});
    } finally { await s.close(); }
});

test('snapshotdataset makes 9 flash job-journal writes and 2 audit appends', async () => {
    const s = await startIntegration({dependencyUsage: true});
    try {
        instrumentWrites(s.php);
        const model = s.readModel(), target = 'cache/__mock__/project';
        resetCounts(s.php);
        const post = fields => fetch(s.url + '/plugins/zfs.master.ui/backend/ZFSMAdmin.php', {method: 'POST', body: new URLSearchParams({csrf_token: 'integration-token', ...fields})}).then(r => r.json());
        const a = await post({cmd: 'snapshotdataset', zdataset: target, recursive: '0', expected_guid: model.datasets[target].guid});
        assert.deepEqual(a.failed, []);
        assert.equal(a.job?.state, 'completed');
        const counts = readCounts(s.php);
        // BASELINE (measured): zfsmRequestJobBegin writes queued then running (2); the audit_id
        // update after zfsmAuditBegin (1); 3 stage changes via zfsmAuditSetStage->zfsmRequestJobStage
        // (acquiring_lock, validating_identity, executing_operation) (3); zfsmRequestJobDownloadContext
        // records the created snapshot (1); zfsmRequestJobAnswer writes audit_id again (1); and
        // zfsmRequestJobFinish (1) = 9. Plus zfsmAuditBegin/zfsmAuditFinish = 2 audit appends.
        // TARGET after REL-002: a synchronous command -> only 2 audit appends.
        assert.deepEqual(counts, {jobs: 9, audit: 2, store: 0});
    } finally { await s.close(); }
});

test('saveconfig makes 8 flash job-journal writes and 2 audit appends', async () => {
    const s = await startIntegration();
    try {
        instrumentWrites(s.php);
        resetCounts(s.php);
        const settings = {refresh_interval: '30', lazy_load: '0', sanoid_integration: '0', destructive_mode: '1', exclusion: '', directory_listing: 'cache/__mock__/project', snap_max_days_alert: '30', snap_pattern: 'Y-m-d-His', snap_prefix: '', space_warning_percent: '80', space_critical_percent: '90', replication_lag_hours: '24'};
        const fields = {csrf_token: 'integration-token', cmd: 'saveconfig'};
        for (const [key, value] of Object.entries(settings)) fields['settings[' + key + ']'] = value;
        const a = await fetch(s.url + '/plugins/zfs.master.ui/backend/ZFSMAdmin.php', {method: 'POST', body: new URLSearchParams(fields)}).then(r => r.json());
        assert.deepEqual(a.failed, [], JSON.stringify(a));
        const counts = readCounts(s.php);
        // BASELINE (measured): same flow as snapshotdataset but without the download-context
        // write (saveconfig never calls zfsmRequestJobDownloadContext), so it is "most other
        // commands": zfsmRequestJobBegin (2) + audit_id update (1) + 3 stage changes (3) +
        // audit_id again (1) + finish (1) = 8, plus 2 audit appends.
        // TARGET after REL-002: a synchronous command -> only 2 audit appends.
        assert.deepEqual(counts, {jobs: 8, audit: 2, store: 0});
    } finally { await s.close(); }
});
