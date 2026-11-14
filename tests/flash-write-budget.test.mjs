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
// A separate, independent counter restricted to writes whose target path is actually under
// plugin_state: zfsmJobAtomicWrite also now fires for the harmless tmpfs runtime copy, so the
// unrestricted "jobs" counter above can no longer stand in for "0 writes to the boot flash".
const DURABLE_COUNTER_FILE = '/test-durable-write-count.json';
function instrumentDurableJobWrites(php) {
    const file = '/app/src/include/ZFSMJobs.php', signature = 'function zfsmJobAtomicWrite($file,$data) {';
    const source = php.readFileAsText(file), at = source.indexOf(signature);
    assert.ok(at >= 0, signature);
    const hook = `if(isset($GLOBALS['plugin_state'])&&str_starts_with($file,rtrim($GLOBALS['plugin_state'],'/').'/')){$__dwc=is_file('${DURABLE_COUNTER_FILE}')?(int)file_get_contents('${DURABLE_COUNTER_FILE}'):0;file_put_contents('${DURABLE_COUNTER_FILE}',(string)($__dwc+1));}`;
    php.writeFile(file, source.slice(0, at + signature.length) + ' ' + hook + ' ' + source.slice(at + signature.length));
}
function resetDurableCount(php) { php.writeFile(DURABLE_COUNTER_FILE, '0'); }
function readDurableCount(php) { return parseInt(php.readFileAsText(DURABLE_COUNTER_FILE), 10); }
// Recursively lists every file under a boot-flash config root as {path: [mtimeMs, size]}, so a
// before/after comparison catches a rewrite-in-place (same path, bumped mtime) as well as a
// created or removed file -- not just a count from the three hooked primitives above.
async function snapshotFlashTree(s, root) {
    const r = await s.run({code: `<?php
$out=[];
if(is_dir('${root}')){$it=new RecursiveIteratorIterator(new RecursiveDirectoryIterator('${root}',FilesystemIterator::SKIP_DOTS));
foreach($it as $file)if($file->isFile())$out[$file->getPathname()]=[$file->getMTime(),$file->getSize()];}
ksort($out);echo json_encode($out);`});
    assert.equal(r.errors, '', r.text);
    return JSON.parse(r.text);
}

test('a scheduled policy idle check that creates nothing writes nothing under the boot flash', async () => {
    const s = await startIntegration({protection: true});
    try {
        instrumentWrites(s.php);
        instrumentDurableJobWrites(s.php);
        // Same simulated sanoid override as tests/idle-protection-checks.test.mjs: a non-readonly
        // --take-snapshots invocation reports nothing due, i.e. no snapshot is created or pruned.
        const file = '/acceptance/system.php', text = s.php.readFileAsText(file), marker = 'function integrationProcess($command,$args,$stdin=null) {';
        assert.ok(text.includes(marker));
        s.php.writeFile(file, text.replace(marker, marker + `
 if($command==='/usr/sbin/sanoid'&&in_array('--take-snapshots',$args,true)&&!in_array('--readonly',$args,true))return ['code'=>0,'output'=>'SYNTHETIC nothing due'];
`));
        // A one-time warm-up run: the very first ever protection job lazily creates its empty
        // lock files (jobs/history.lock, protection/config.lock, protection/execution.lock).
        // Those are reused (never recreated) afterwards, matching the plan's own "0 writes over
        // 10 idle checks" criterion rather than requiring a pristine, never-touched tree.
        await s.run({code: `<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
$p=zfsmSanoidPolicy(['id'=>'abc','dataset'=>'cache/__mock__/project','autosnap'=>false,'autoprune'=>false]);
$p['source_guid']=zfsmReadIdentity($p['dataset'])['guid'];
$store=zfsmProtectionReadStore();$store['policies']['abc']=$p;zfsmProtectionWriteStore($store);
$queued=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);
zfsmRunProtectionJob(zfsmReadJob($queued['job']['id']));`});
        const before = await snapshotFlashTree(s, '/boot/config/plugins/zfs.master.ui');
        resetCounts(s.php);
        resetDurableCount(s.php);
        const r = await s.run({code: `<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
$queued=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);
zfsmRunProtectionJob(zfsmReadJob($queued['job']['id']));
echo json_encode(['ephemeral_gone'=>!is_file(zfsmJobDirectory($GLOBALS['plugin_runtime'].'/protection-queue').'/'.$queued['job']['id'].'.json')]);`});
        assert.equal(r.errors, '', r.text);
        assert.deepEqual(JSON.parse(r.text), {ephemeral_gone: true}, 'the tmpfs runtime copy is removed once the idle outcome is known');
        const after = await snapshotFlashTree(s, '/boot/config/plugins/zfs.master.ui');
        // TARGET after REL-002: nothing under the boot flash tree (jobs/, protection/, audit/)
        // is created, rewritten or removed by an idle scheduled check -- not even transiently.
        assert.deepEqual(after, before, 'the boot flash tree must be byte-for-byte unchanged by an idle check');
        const counts = readCounts(s.php);
        // zfsmJobAtomicWrite now also fires for the tmpfs runtime copy (queued/running/finished),
        // which is why the path-restricted durable count below -- not this unrestricted hook
        // count -- is the authoritative assertion; zfsmAuditAppend and zfsmProtectionWriteStore
        // must still never run at all, regardless of target path.
        assert.equal(counts.audit, 0, 'no audit entry for a quiet scheduled policy check');
        assert.equal(counts.store, 0, 'nothing was created or pruned, so the protection store is never written');
        assert.equal(readDurableCount(s.php), 0, 'zfsmJobAtomicWrite must never target a plugin_state path for an idle check');
    } finally { await s.close(); }
});

test('a scheduled policy check that creates a snapshot is promoted: journal and store land on the boot flash and stay visible in Jobs', async () => {
    const s = await startIntegration({protection: true});
    try {
        const source = 'cache/__mock__/project', created = source + '@autosnap_2026-10-05_00:00:00_frequently';
        const model = s.readModel(), guid = model.datasets[source].guid;
        const file = '/acceptance/system.php', text = s.php.readFileAsText(file), marker = 'function integrationProcess($command,$args,$stdin=null) {';
        assert.ok(text.includes(marker));
        // The snapshot only appears in the mocked inventory as a side effect of the overridden
        // --take-snapshots call, exactly like a real sanoid invocation: zfsmSanoidExecute's
        // before/after comparison (zfsmSanoidCreated) is what must observe the new snapshot.
        s.php.writeFile(file, text.replace(marker, marker + `
 if($command==='/usr/sbin/sanoid'&&in_array('--take-snapshots',$args,true)&&!in_array('--readonly',$args,true)){
 $m=integrationModel();$m['snapshots']['${created}']=['name'=>'${created}','type'=>'snapshot','guid'=>'920001','creation'=>1790812800,'createtxg'=>1790812800,'userrefs'=>0,'origin'=>'-','mountpoint'=>'-','encryptionroot'=>'-','used'=>0];integrationSave($m);
 return ['code'=>0,'output'=>"taking snapshot ${created}\\n"];
 }
`));
        const r = await s.run({code: `<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
$p=zfsmSanoidPolicy(['id'=>'abc','dataset'=>'${source}','autosnap'=>false,'autoprune'=>false]);
$p['source_guid']='${guid}';
$store=zfsmProtectionReadStore();$store['policies']['abc']=$p;zfsmProtectionWriteStore($store);
$queued=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);$id=$queued['job']['id'];
zfsmRunProtectionJob(zfsmReadJob($id));
$job=zfsmReadJob($id);
$durable=zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$id.'.json';
$runtime=zfsmJobDirectory($GLOBALS['plugin_runtime'].'/protection-queue').'/'.$id.'.json';
$finalStore=zfsmProtectionReadStore();
echo json_encode(['durable'=>is_file($durable),'ephemeral'=>is_file($runtime),'outcome'=>$job['verified_outcome'],'created'=>$job['verification']['snapshots_created'],'store_has_snapshot'=>isset($finalStore['owned_snapshots']['${created}']),'in_jobs'=>in_array($id,array_column(zfsmJobPage(1,200)['jobs'],'id'),true)]);`});
        assert.equal(r.errors, '', r.text);
        assert.deepEqual(JSON.parse(r.text), {durable: true, ephemeral: false, outcome: 'completed', created: [created], store_has_snapshot: true, in_jobs: true});
    } finally { await s.close(); }
});

test('a scheduled prune promotes its journal to the boot flash before the first delete; an abort there leaves the job interrupted and recoverable', async () => {
    const s = await startIntegration({protection: true});
    try {
        const source = 'cache/__mock__/project', owned = source + '@autosnap_2026-10-01_00:00:00_frequently';
        const model = s.readModel(), guid = model.datasets[source].guid;
        model.snapshots[owned] = {name: owned, type: 'snapshot', guid: '910001', creation: 1790812800, createtxg: 1790812800, userrefs: 0, origin: '-', mountpoint: '-', encryptionroot: '-', used: 0};
        s.writeModel(model);
        const file = '/acceptance/system.php', text = s.php.readFileAsText(file), marker = 'function integrationProcess($command,$args,$stdin=null) {';
        assert.ok(text.includes(marker));
        s.php.writeFile(file, text.replace(marker, marker + `
 if($command==='/usr/sbin/sanoid'&&in_array('--take-snapshots',$args,true)&&!in_array('--readonly',$args,true))return ['code'=>0,'output'=>'SYNTHETIC nothing due'];
 if($command==='/usr/sbin/sanoid'&&in_array('--readonly',$args,true))return ['code'=>0,'output'=>"INFO: pruning snapshots...\\nINFO: pruning ${owned} ...\\n"];
`));
        // Simulates a worker that is killed the instant it starts the first destructive delete:
        // the exception must only ever fire after the journal is already durable and 'running'.
        const ops = '/app/src/backend/ZFSMOperations.php', opsText = s.php.readFileAsText(ops), opsMarker = 'function deleteDatasetSnapshot($snapshot, $recursive = 0, $scope = null) {';
        assert.ok(opsText.includes(opsMarker));
        s.php.writeFile(ops, opsText.replace(opsMarker, opsMarker + `
 if(!($GLOBALS['test_abort_done']??false)){$GLOBALS['test_abort_done']=true;$durable=zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$GLOBALS['test_job_id'].'.json';$GLOBALS['test_promoted_before_delete']=is_file($durable)&&zfsmReadJob($GLOBALS['test_job_id'])['state']==='running';throw new RuntimeException('SYNTHETIC worker abort before destructive step');}
`));
        const r = await s.run({code: `<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
$p=zfsmSanoidPolicy(['id'=>'abc','dataset'=>'${source}','autosnap'=>false,'autoprune'=>true]);
$p['source_guid']='${guid}';
$store=zfsmProtectionReadStore();$store['policies']['abc']=$p;$store['owned_snapshots']['${owned}']=['guid'=>'910001','dataset_guid'=>'${guid}','policy_id'=>'abc'];
zfsmProtectionWriteStore($store);
$queued=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);$id=$queued['job']['id'];
$GLOBALS['test_job_id']=$id;
zfsmRunProtectionJob(zfsmReadJob($id));
$job=zfsmReadJob($id);
echo json_encode(['promoted_before_delete'=>$GLOBALS['test_promoted_before_delete']??null,'state'=>$job['state'],'outcome'=>$job['verified_outcome'],'trigger'=>$job['trigger'],'durable'=>is_file(zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$id.'.json')]);`});
        assert.equal(r.errors, '', r.text);
        const out = JSON.parse(r.text.slice(r.text.indexOf('{')));
        assert.deepEqual(out, {promoted_before_delete: true, state: 'recovery_required', outcome: 'recovery_required', trigger: 'schedule', durable: true});
    } finally { await s.close(); }
});

test('a scheduled policy check that fails promotes its journal to the boot flash', async () => {
    const s = await startIntegration({protection: true});
    try {
        const file = '/acceptance/system.php', text = s.php.readFileAsText(file), marker = 'function integrationProcess($command,$args,$stdin=null) {';
        assert.ok(text.includes(marker));
        s.php.writeFile(file, text.replace(marker, marker + `
 if($command==='/usr/sbin/sanoid'&&in_array('--take-snapshots',$args,true)&&!in_array('--readonly',$args,true))return ['code'=>1,'output'=>'SYNTHETIC native failure'];
`));
        const r = await s.run({code: `<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
$p=zfsmSanoidPolicy(['id'=>'abc','dataset'=>'cache/__mock__/project','autosnap'=>false,'autoprune'=>false]);
$p['source_guid']=zfsmReadIdentity($p['dataset'])['guid'];
$store=zfsmProtectionReadStore();$store['policies']['abc']=$p;zfsmProtectionWriteStore($store);
$queued=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);$id=$queued['job']['id'];
zfsmRunProtectionJob(zfsmReadJob($id));
$job=zfsmReadJob($id);
echo json_encode(['durable'=>is_file(zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$id.'.json'),'outcome'=>$job['verified_outcome'],'state'=>$job['state']]);`});
        assert.equal(r.errors, '', r.text);
        assert.deepEqual(JSON.parse(r.text), {durable: true, outcome: 'failed', state: 'failed'});
    } finally { await s.close(); }
});

test('a promotion that fails to reach the boot flash keeps the real outcome in tmpfs, visible and protected from the sweep', async () => {
    const s = await startIntegration({protection: true});
    try {
        const source = 'cache/__mock__/project', created = source + '@autosnap_2026-10-06_00:00:00_frequently';
        const model = s.readModel(), guid = model.datasets[source].guid;
        const sysFile = '/acceptance/system.php', sysText = s.php.readFileAsText(sysFile), sysMarker = 'function integrationProcess($command,$args,$stdin=null) {';
        assert.ok(sysText.includes(sysMarker));
        s.php.writeFile(sysFile, sysText.replace(sysMarker, sysMarker + `
 if($command==='/usr/sbin/sanoid'&&in_array('--take-snapshots',$args,true)&&!in_array('--readonly',$args,true)){
 $m=integrationModel();$m['snapshots']['${created}']=['name'=>'${created}','type'=>'snapshot','guid'=>'930001','creation'=>1790812800,'createtxg'=>1790812800,'userrefs'=>0,'origin'=>'-','mountpoint'=>'-','encryptionroot'=>'-','used'=>0];integrationSave($m);
 return ['code'=>0,'output'=>"taking snapshot ${created}\\n"];
 }
`));
        // Simulates the durable write itself failing (a full disk, a read-only remount, etc.):
        // only the plugin_state-targeted write throws, so the ephemeral queue write still works.
        const jobsFile = '/app/src/include/ZFSMJobs.php', jobsText = s.php.readFileAsText(jobsFile), jobsMarker = 'function zfsmJobAtomicWrite($file,$data) {';
        assert.ok(jobsText.includes(jobsMarker));
        s.php.writeFile(jobsFile, jobsText.replace(jobsMarker, jobsMarker + `
 if(!empty($GLOBALS['test_force_durable_write_failure'])&&isset($GLOBALS['plugin_state'])&&str_starts_with($file,rtrim($GLOBALS['plugin_state'],'/').'/'))throw new RuntimeException('SYNTHETIC flash write failure');
`));
        const r = await s.run({code: `<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
$p=zfsmSanoidPolicy(['id'=>'abc','dataset'=>'${source}','autosnap'=>false,'autoprune'=>false]);
$p['source_guid']='${guid}';
$store=zfsmProtectionReadStore();$store['policies']['abc']=$p;zfsmProtectionWriteStore($store);
$queued=zfsmQueueProtection(['type'=>'policy','id'=>'abc'],false);$id=$queued['job']['id'];
$GLOBALS['test_force_durable_write_failure']=true;
zfsmRunProtectionJob(zfsmReadJob($id));
$GLOBALS['test_force_durable_write_failure']=false;
$job=zfsmReadJob($id);
$runtime=zfsmJobDirectory($GLOBALS['plugin_runtime'].'/protection-queue').'/'.$id.'.json';
$durable=zfsmJobDirectory($GLOBALS['plugin_state']).'/'.$id.'.json';
$page=zfsmJobPage(1,200);$listed=null;foreach($page['jobs']as$j)if($j['id']===$id)$listed=$j;
zfsmProtectionSweepRuntimeQueue();
echo json_encode(['outcome'=>$job['verified_outcome'],'state'=>$job['state'],'created'=>$job['verification']['snapshots_created']??null,'ephemeral'=>is_file($runtime),'durable'=>is_file($durable),'listed_group'=>$listed['group']??null,'listed_cancel'=>$listed['actions']['cancel']??null,'ephemeral_after_sweep'=>is_file($runtime)]);`});
        assert.equal(r.errors, '', r.text);
        assert.deepEqual(JSON.parse(r.text), {outcome: 'completed', state: 'completed', created: [created], ephemeral: true, durable: false, listed_group: 'needs_attention', listed_cancel: false, ephemeral_after_sweep: true}, 'the real outcome (a created snapshot) is preserved, stays in tmpfs, is listed as needs_attention and survives the sweep');
    } finally { await s.close(); }
});

test('snapshotdataset writes no job journal and 2 audit appends', async () => {
    const s = await startIntegration({dependencyUsage: true});
    try {
        instrumentWrites(s.php);
        const model = s.readModel(), target = 'cache/__mock__/project';
        resetCounts(s.php);
        const post = fields => fetch(s.url + '/plugins/zfs.master.ui/backend/ZFSMAdmin.php', {method: 'POST', body: new URLSearchParams({csrf_token: 'integration-token', ...fields})}).then(r => r.json());
        const a = await post({cmd: 'snapshotdataset', zdataset: target, recursive: '0', expected_guid: model.datasets[target].guid});
        assert.deepEqual(a.failed, []);
        assert.equal(a.job, undefined);
        const counts = readCounts(s.php);
        // A synchronous action writes only its two audit log records; it gets a
        // Jobs journal only when it fails (ARCH-001). It used to cost 9 journal writes.
        assert.deepEqual(counts, {jobs: 0, audit: 2, store: 0});
    } finally { await s.close(); }
});

test('saveconfig writes no job journal and 2 audit appends', async () => {
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
        // Same contract as snapshotdataset: two audit records, no journal on success. It used to cost 8.
        assert.deepEqual(counts, {jobs: 0, audit: 2, store: 0});
    } finally { await s.close(); }
});

test('a failed snapshot and a refused restore write no job journal, only their audit records', async () => {
    const s = await startIntegration({dependencyUsage: true});
    try {
        instrumentWrites(s.php);
        const target = 'cache/__mock__/project';
        const post = fields => fetch(s.url + '/plugins/zfs.master.ui/backend/ZFSMAdmin.php', {method: 'POST', body: new URLSearchParams({csrf_token: 'integration-token', ...fields})}).then(r => r.json());
        resetCounts(s.php);
        const failed = await post({cmd: 'snapshotdataset', zdataset: target, recursive: '0', expected_guid: '999999'});
        assert.equal(Object.keys(failed.failed).length > 0, true);
        assert.equal(failed.job, undefined);
        assert.deepEqual(readCounts(s.php), {jobs: 0, audit: 2, store: 0});
        resetCounts(s.php);
        const refused = await post({cmd: 'restoresnapshotfiles', preview_id: 'invalid', preview_token: 'x', confirmed: '1'});
        assert.equal(Object.keys(refused.failed).length > 0, true);
        assert.equal(refused.job, undefined);
        assert.equal(readCounts(s.php).jobs, 0);
    } finally { await s.close(); }
});

const requestJob = `<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';`;
test('scrub and download progress is written to the runtime directory and nothing under the boot flash', async () => {
    const s = await startIntegration({dependencyUsage: true});
    try {
        instrumentDurableJobWrites(s.php);
        resetDurableCount(s.php);
        const before = await snapshotFlashTree(s, '/boot/config/plugins/zfs.master.ui/jobs');
        const r = await s.run({code: requestJob + `
$scrub=zfsmRequestJobBegin('scrubpool',['pool'=>'cache']);zfsmRequestJobStage('scrubbing');zfsmRequestJobFinish('completed','Scrub requested');
$download=zfsmRequestJobBegin('downloadsnapshotfile',['snapshot'=>'cache/__mock__/project@base']);zfsmRequestJobProgress(3,6);zfsmRequestJobFinish('completed','Transfer finished');
echo json_encode(['runtime'=>$GLOBALS['plugin_runtime'],'ids'=>[$scrub['id'],$download['id']],'files'=>array_map('basename',glob($GLOBALS['plugin_runtime'].'/requests/*.json')),'found'=>[zfsmJobFile($scrub['id']),zfsmJobFile($download['id'])],'progress'=>zfsmReadJob($download['id'])['progress']]);`});
        assert.equal(r.errors, '', r.text);
        const out = JSON.parse(r.text);
        assert.equal(readDurableCount(s.php), 0, 'no journal write reaches plugin_state');
        const withoutGate = tree => Object.fromEntries(Object.entries(tree).filter(([name]) => !name.endsWith('/history.lock')));
        assert.deepEqual(withoutGate(await snapshotFlashTree(s, '/boot/config/plugins/zfs.master.ui/jobs')), withoutGate(before), 'the jobs directory on the flash holds no new record');
        assert.deepEqual(out.files.sort(), out.ids.map(id => id + '.json').sort());
        assert.deepEqual(out.found, out.ids.map(id => out.runtime + '/requests/' + id + '.json'));
        assert.deepEqual(out.progress, {stage: 'transferring', bytes: 3, total: 6, percent: 100});
    } finally { await s.close(); }
});

test('request progress is read back from the runtime directory while the request is running', async () => {
    const s = await startIntegration({dependencyUsage: true});
    try {
        const r = await s.run({code: requestJob + `
$job=zfsmRequestJobBegin('downloadsnapshotfile',['snapshot'=>'cache/__mock__/project@base']);zfsmRequestJobProgress(2,8);
$read=zfsmReadJob($job['id']);$page=zfsmJobPage(1,50,['filter'=>'all']);$ids=array_column($page['jobs'],'id');$listed=array_values(array_filter($page['jobs'],fn($j)=>$j['id']===$job['id']))[0]??[];
echo json_encode(['state'=>$read['state'],'progress'=>$listed['progress']['percent']??null,'pending'=>array_column(zfsmPendingJobs(),'id')===[$job['id']],'in_page'=>in_array($job['id'],$ids,true),'runtime'=>$GLOBALS['plugin_runtime'].'/requests/'.$job['id'].'.json','file'=>zfsmJobFile($job['id'])]);`});
        assert.equal(r.errors, '', r.text);
        const out = JSON.parse(r.text);
        assert.deepEqual({state: out.state, progress: out.progress, pending: out.pending, in_page: out.in_page, file: out.file}, {state: 'running', progress: 25, pending: true, in_page: true, file: out.runtime});
    } finally { await s.close(); }
});

test('after a reboot the runtime directory is gone: nothing fails and the operation no longer exists', async () => {
    const s = await startIntegration({dependencyUsage: true});
    try {
        const r = await s.run({code: requestJob + `
$job=zfsmRequestJobBegin('downloadsnapshotfile',['snapshot'=>'cache/__mock__/project@base']);zfsmRequestJobFinish('completed','Done');
$dir=$GLOBALS['plugin_runtime'].'/requests';foreach(glob($dir.'/*')?:[] as$f)unlink($f);rmdir($dir);
$missing=null;try{zfsmReadJob($job['id']);}catch(Throwable$e){$missing=$e->getMessage();}
zfsmRequestRuntimeSweep();
echo json_encode(['missing'=>$missing,'pending'=>zfsmPendingJobs(),'page'=>zfsmJobPage(1,50,['filter'=>'all'])['jobs'],'recreated'=>is_dir($dir)]);`});
        assert.equal(r.errors, '', r.text);
        assert.deepEqual(JSON.parse(r.text), {missing: 'Job not found', pending: [], page: [], recreated: true});
    } finally { await s.close(); }
});
