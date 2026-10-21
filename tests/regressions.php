<?php
require '/app/harness.php';

foreach (['(trimming)', '(untrimmed)', '(trim unsupported)', '(35% trimmed, started at Mon Oct 12 02:00:00 2026)', '(35% trimmed, suspended, started at Mon Oct 12 02:00:00 2026)', '(100% trimmed, completed at Mon Oct 12 02:10:32 2026)'] as $note) {
    check('healthy TRIM annotation '.$note, function() use ($note) {
        $result = diagnosticsFixture($note);
        same('ok',$result['severity']); same([], $result['reasons']);
        same($note, $result['status']['rows'][1]['note']);
    });
}
check('unknown annotations still fail closed', function() {
    same('unknown', diagnosticsFixture('(mystery activity)')['severity']);
});
check('TRIM cannot mask checksum errors', function() {
    $result = diagnosticsFixture('(trimming)', '0 0 7');
    same('error', $result['severity']);
    same(true, in_array('disk1 has CKSUM errors: 7', $result['reasons'], true));
});
check('notification includes reasons once across description and message', function() {
    $reasons = ['disk1 has CKSUM errors: 7', 'Pool native state is DEGRADED'];
    expectProcess('/usr/local/emhttp/webGui/scripts/notify', [
        '-e','ZFS Director','-s','ZFS pool cache: Error',
        '-d','Pool cache requires attention.','-m',implode("\n",$reasons),'-i','alert',
        '-l','/Main/ZFSDirector?pool=cache&tab=pool-status'
    ]);
    same(true,zfsmSendPoolNotification('cache','error',$reasons));
});
finishTests();
