<?php
// Regression probes for the corrected contracts, replacing the historical gaps
// recorded at 9252188. PASS now means the intended safe behavior is present.
// Run only through source-probes.mjs: all files are virtual, all processes mocked.
require '/app/harness.php';

$GLOBALS['plugin_state'] = '/source-probe-jobs';
$GLOBALS['plugin_runtime'] = '/source-probe-runtime';
$GLOBALS['plugin_worker_lock'] = '/source-probe-worker.lock';
$GLOBALS['plugin_config'] = '/source-probe-config.cfg';
ini_set('error_log', '/source-probe-errors.log');

// Unraid configuration reader is an environment boundary, not product logic.
function parse_plugin_cfg($plugin, $sections) { return []; }
function sourceProbeSettings($changes = []) {
    return array_replace([
        'refresh_interval'=>'30', 'lazy_load'=>'0', 'sanoid_integration'=>'0',
        'destructive_mode'=>'0', 'exclusion'=>'', 'directory_listing'=>'',
        'snap_max_days_alert'=>'30', 'snap_pattern'=>'Y-m-d-His', 'snap_prefix'=>'',
    ], $changes);
}

check('corrected Jobs: oldest active job stays visible beside 100 newer completed journals', function() {
    $old = '20261016-000000-000000000000';
    for ($index=0; $index<101; $index++) {
        $id = '20261016-000000-'.str_pad(dechex($index), 12, '0', STR_PAD_LEFT);
        zfsmJobAtomicWrite(zfsmJobFile($id), [
            'schema'=>1, 'id'=>$id, 'state'=>$index===0?'running':'completed',
            'stage'=>$index===0?'copying':'complete_source_retained',
            'source'=>'/mnt/cache/source', 'dataset'=>'cache/source', 'pool'=>'cache',
            'owner_dataset'=>'cache', 'owner_mountpoint'=>'/mnt/cache', 'owner_guid'=>'123',
            'source_identity'=>['dev'=>'1','ino'=>'2'],
            'recovery'=>'/mnt/cache/source_zfsm_recovery_'.$id,
        ]);
    }
    $listed = zfsmListJobs();
    $pending = zfsmPendingJobs();
    same(101, count($listed));
    same(true, in_array($old, array_column($listed, 'id'), true));
    same(true, in_array($old, array_column($pending, 'id'), true));
    same([], $GLOBALS['test_calls']);
});

check('corrected Jobs: invalid journal exposes diagnostics and disables unsupported actions', function() {
    $previous = $GLOBALS['plugin_state'];
    $GLOBALS['plugin_state'] = '/source-probe-invalid-jobs';
    try {
        $id = '20261016-000001-000000000000';
        file_put_contents(zfsmJobFile($id), '{invalid json');
        $listed = zfsmListJobs();
        same(1, count($listed));
        same('invalid_journal', $listed[0]['stage']);
        same('recovery_required', $listed[0]['state']);
        same('unknown', $listed[0]['type']);
        same(null, $listed[0]['schema']);
        same('needs_attention', $listed[0]['group']);
        same(['cancel'=>false,'resume'=>false,'download'=>false,'inspect'=>true], $listed[0]['actions']);
        same(false, array_key_exists('raw', $listed[0]['diagnostics'])); // Security contract: identify journals without returning raw secrets.
        same(true, str_contains($listed[0]['retained_data']['message'], 'cannot be verified'));
        same([], $GLOBALS['test_calls']);
    } finally { $GLOBALS['plugin_state'] = $previous; }
});

check('corrected Settings: invalid PCRE is rejected without changing stored settings', function() {
    file_put_contents($GLOBALS['plugin_config'], "[general]\nexclusion = \"safe\"\n");
    $before = file_get_contents($GLOBALS['plugin_config']);
    $answer = zfsmSaveSettings(sourceProbeSettings(['exclusion'=>'[']));
    same([], $answer['succeeded']);
    same(true, isset($answer['field_errors']['exclusion']));
    same($before, file_get_contents($GLOBALS['plugin_config']));
    same(false, is_file('/source-probe-errors.log'));
    same([], $GLOBALS['test_calls']);
});

check('corrected Settings: invalid generated snapshot name cannot be persisted', function() {
    $settings = sourceProbeSettings(['snap_prefix'=>'@']);
    $before = file_get_contents($GLOBALS['plugin_config']);
    $answer = zfsmSaveSettings($settings);
    same([], $answer['succeeded']);
    same(true, isset($answer['field_errors']['snap_prefix']));
    same($before, file_get_contents($GLOBALS['plugin_config']));
    same([], $GLOBALS['test_calls']);
});

check('corrected Encryption: explicit Inherit omits key options and uses native inheritance', function() {
    $clean = cleanZFSCreateDatasetParams([
        'zpool'=>'cache', 'name'=>'secure/child', 'mount'=>'yes', 'mountpoint'=>'',
        'encryption'=>'inherit', 'passphrase'=>'discard-this-fixture-value',
    ]);
    same(false, array_key_exists('encryption', $clean));
    same(false, array_key_exists('passphrase', $clean));
    expectProcess('zfs', ['create','-p','cache/secure/child']);
    expectProcess('zfs', ['get','-H','-p','-o','value','mountpoint','cache/secure/child'], '', 1);
    $answer = createDataset('cache/secure/child', $clean);
    same([], $answer['failed']);
    same(['cache/secure/child'], array_keys($answer['succeeded']));
    same(['zfs',['create','-p','cache/secure/child']], $GLOBALS['test_calls'][0]);
    // The command contract is real; native ZFS inheritance needs an approved live test.
});

check('corrected Inventory: encryption root mount state and unsigned GUID survive parsing', function() {
    $columns = zfsmDatasetColumns();
    $values = array_replace(array_fill_keys($columns, '0'), [
        'name'=>'cache', 'type'=>'filesystem', 'encryption'=>'aes-256-gcm',
        'encryptionroot'=>'cache', 'mounted'=>'no', 'keyformat'=>'passphrase',
        'keystatus'=>'unavailable', 'guid'=>'18446744073709551615',
        'mountpoint'=>'/mnt/cache', 'origin'=>'-', 'compressratio'=>'1.00x',
    ]);
    $row = implode("\t", array_map(static fn($column)=>$values[$column], $columns));
    expectProcess('zfs', ['list','-H','-p','-r','-t','filesystem,volume','-o',implode(',', $columns),'cache'], $row);
    $tree = zfsmLoadPoolTree('cache', false, '', 0);
    same('cache', $tree['encryptionroot']);
    same('no', $tree['mounted']);
    same('passphrase', $tree['keyformat']);
    same('unavailable', $tree['keystatus']);
    same('18446744073709551615', $tree['guid']);
    same(1, count($GLOBALS['test_calls']));
});

check('existing guard: inherited child cannot unload its parent encryption key', function() {
    expectProcess('zfs', ['list','-H','-o','name','-t','filesystem','cache/secure/child'], 'cache/secure/child');
    expectProcess('zfs', ['get','-H','-o','property,value','encryption,encryptionroot,keystatus,mounted','cache/secure/child'],
        "encryption\taes-256-gcm\nencryptionroot\tcache/secure\nkeystatus\tavailable\nmounted\tyes");
    $answer = lockDataset('cache/secure/child');
    same([], $answer['succeeded']);
    same('Only an unlocked encryption root can be locked', $answer['failed']['cache/secure/child']);
    same(2, count($GLOBALS['test_calls']));
});

function sourceProbeDestroyRead($guid='18446744073709551615') {
    $rows = [
        "cache\tfilesystem\t1\t-\t/mnt/cache\t-\t-\t-",
        "cache/data\tfilesystem\t$guid\t-\t/mnt/cache/data\t-\t-\t-",
        "cache/data@s1\tsnapshot\t99\t-\t-\t-\t0\toff",
    ];
    expectProcess('zfs', ['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o','name,type,guid,origin,mountpoint,encryptionroot,userrefs,defer_destroy','cache'], implode("\n", $rows));
    expectProcess('zfs', ['holds','-H','cache/data@s1'], '');
    expectProcess('zfs', ['destroy','-nvp','-r','-f','cache/data'], "destroy\tcache/data@s1\ndestroy\tcache/data\nreclaim\t0");
}
check('corrected Destroy: preview binds GUID scope expiry and one-use confirmation', function() {
    $secret = 'source-probe-session';
    $previews = [];
    for ($index=0; $index<2; $index++) {
        sourceProbeDestroyRead();
        $previews[] = zfsmPreviewDestroy('cache/data', '1', $secret);
    }
    same(false, $previews[0]['token']===$previews[1]['token']);
    same(false, $previews[0]['preview_id']===$previews[1]['preview_id']);
    same(true, $previews[0]['expires']>time());
    same(true, $previews[0]['can_destroy']);
    same('18446744073709551615', $previews[0]['objects'][0]['guid']);
    same(['cache/data','cache/data@s1'], array_column($previews[0]['objects'], 'name'));
    sourceProbeDestroyRead('22');
    try { zfsmValidateDestroyPreview('cache/data','1',$secret,$previews[0]['preview_id'],$previews[0]['token']); throw new LogicException('Expected changed identity rejection'); }
    catch (RuntimeException $error) { same(true, str_contains($error->getMessage(), 'changed')); }
    sourceProbeDestroyRead();
    $valid = zfsmValidateDestroyPreview('cache/data','1',$secret,$previews[1]['preview_id'],$previews[1]['token']);
    same('cache/data', $valid['target']);
    try { zfsmValidateDestroyPreview('cache/data','1',$secret,$previews[1]['preview_id'],$previews[1]['token']); throw new LogicException('Expected replay rejection'); }
    catch (RuntimeException $error) { same(true, str_contains($error->getMessage(), 'missing')); }
    same(12, count($GLOBALS['test_calls']));
    // This verifies the safe CLI request contract; no native ZFS process executes.
});

finishTests();
