<?php
error_reporting(E_ALL);
set_error_handler(static function($level, $message, $file, $line) {
    if (!(error_reporting() & $level)) return false;
    throw new ErrorException($message, 0, $level, $file, $line);
});
$GLOBALS['test_calls'] = [];
$GLOBALS['test_responses'] = [];
function zfsmTestProcess($command, $args) {
    $GLOBALS['test_calls'][] = [$command, $args];
    $next = array_shift($GLOBALS['test_responses']);
    if (!$next || $next[0] !== $command || $next[1] !== $args) throw new RuntimeException('Unexpected simulated process: '.json_encode([$command,$args]));
    return $next[2];
}
function expectProcess($command, $args, $output = '', $code = 0) {
    $GLOBALS['test_responses'][] = [$command, $args, ['output'=>$output,'code'=>$code]];
}
function same($want, $got) {
    if ($want !== $got) throw new RuntimeException('Expected '.json_encode($want).', got '.json_encode($got));
}
$GLOBALS['test_count'] = 0;
$GLOBALS['test_failures'] = 0;
function check($name, $fn) {
    $GLOBALS['test_count']++;
    $GLOBALS['test_calls'] = []; $GLOBALS['test_responses'] = [];
    try {
        $fn(); same([], $GLOBALS['test_responses']);
        echo "PASS $name\n";
    } catch (Throwable $error) {
        $GLOBALS['test_failures']++;
        echo "FAIL $name: ".$error->getMessage()."\n";
    }
}
function finishTests() {
    echo $GLOBALS['test_count'].' checks, '.$GLOBALS['test_failures']." failures\n";
    exit($GLOBALS['test_failures'] ? 1 : 0);
}
function statusFixture($note = '', $counters = '0 0 0', $scan = 'scrub repaired 0B in 00:15:53 with 0 errors on Sun Mar  1 06:15:55 2026') {
    return "  pool: cache\n state: ONLINE\n  scan: $scan\nconfig:\n\n        NAME STATE READ WRITE CKSUM\n        cache ONLINE 0 0 0\n          disk1 ONLINE $counters $note\n\nerrors: No known data errors\n";
}
function infoFixture() {
    return "NAME SIZE ALLOC FREE CKPOINT EXPANDSZ FRAG CAP DEDUP HEALTH ALTROOT\ncache 1000 100 900 - - 0 10 1.00 ONLINE -\n  disk1 1000 100 900 - - 0 10 - ONLINE\n";
}
function diagnosticsFixture($note = '', $counters = '0 0 0', $scan = 'none requested') {
    expectProcess('zpool',['status','-p','-t','cache'],statusFixture($note,$counters,$scan));
    expectProcess('zpool',['list','-v','-p','cache'],infoFixture());
    return zfsmReadPoolDiagnostics('cache');
}
require '/app/src/backend/ZFSMOperations.php';
// All persistent writes stay in the PHP virtual filesystem.
$GLOBALS['plugin_audit'] = '/test-audit';
$GLOBALS['plugin_lock'] = '/test-mutation.lock';

$GLOBALS['zfsm_protection_cron_file']='/test-protection.cron';
