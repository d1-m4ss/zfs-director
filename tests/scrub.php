<?php
require '/app/harness.php';
$running = "scrub in progress since Fri Oct 16 15:00:00 2026\n403M / 405M scanned at 100M/s, 68.4M / 405M issued at 10.0M/s\n0B repaired, 16.91% done, 00:00:04 to go";
$finished = 'scrub repaired 0B in 00:15:53 with 0 errors on Fri Oct 16 15:00:00 2026';
foreach (['resilver','resilver (mirror-0)'] as $kind) {
    $multiple=$finished."\n$kind in progress since Fri Oct 16 15:01:00 2026\n100M / 405M scanned at 10M/s, 50M / 405M issued at 5M/s\n0B repaired, 12.35% done, 00:00:20 to go";
    check('active reconstruction overrides previous scrub '.$kind, function() use($multiple) {
        $scan=zfsmParsePoolScan($multiple);same('resilvering',$scan['state']);same(12.35,$scan['percent']);same('50M',$scan['issued']);
    });
    check('multiple scan sections block scrub '.$kind, function() use($multiple) {
        expectProcess('zpool',['status','-p','-t','cache'],statusFixture('','0 0 0',$multiple));
        expectProcess('zpool',['list','-v','-p','cache'],infoFixture());
        try {zfsmStartPoolScrub('cache','1');throw new LogicException('Expected rejection');}catch(RuntimeException $e){if($e instanceof LogicException)throw $e;}
        same(2,count($GLOBALS['test_calls']));
    });
}
check('paused scrub cannot hide active resilver', function() use($running) {
    same('resilvering',zfsmParsePoolScan("scrub paused since Fri Oct 16 15:00:00 2026\n".str_replace('scrub in progress','resilver in progress',$running))['state']);
});
check('unknown data-error summary blocks scrub', function() use($finished) {
    expectProcess('zpool',['status','-p','-t','cache'],str_replace('No known data errors','new unknown data-error format',statusFixture('','0 0 0',$finished)));
    expectProcess('zpool',['list','-v','-p','cache'],infoFixture());
    try {zfsmStartPoolScrub('cache','1');throw new LogicException('Expected rejection');}catch(RuntimeException $e){if($e instanceof LogicException)throw $e;}
    same(2,count($GLOBALS['test_calls']));
});
check('scrub progress follows issued IO and native percentage', function() use ($running) {
    $scan=zfsmParsePoolScan($running);
    same('running',$scan['state']); same('scrub',$scan['kind']); same(16.91,$scan['percent']);
    same('68.4M',$scan['issued']); same('405M',$scan['issue_total']); same('10.0M/s',$scan['issue_rate']);
    same('403M',$scan['scanned']); same('100M/s',$scan['scan_rate']); same('00:00:04',$scan['eta']); same('0B',$scan['repaired']);
});
check('progress above 100 is still running', function() use ($running) {
    $scan=zfsmParsePoolScan(str_replace('16.91%', '100.25%', $running));
    same('running',$scan['state']); same(100.25,$scan['percent']);
});
foreach (['none requested'=>'idle','scrub paused since Fri Oct 16 15:00:00 2026'=>'paused','scrub canceled on Fri Oct 16 15:00:00 2026'=>'canceled','scrub repaired 0B in 00:15:53 with 0 errors on Fri Oct 16 15:00:00 2026'=>'finished','resilver in progress since Fri Oct 16 15:00:00 2026'=>'resilvering','error scrub in progress since Fri Oct 16 15:00:00 2026'=>'running','scrub mystery'=>'unknown',''=>'unknown'] as $text=>$want) {
    check('scan state '.$want.' '.$text, function() use($text,$want) {same($want,zfsmParsePoolScan($text)['state']);});
}
check('finished scrub preserves repair and error result', function() {
    $scan=zfsmParsePoolScan('scrub repaired 4K in 00:15:53 with 2 errors on Fri Oct 16 15:00:00 2026');
    same('4K',$scan['repaired']); same(2,$scan['errors']); same(null,$scan['percent']);
});
foreach (['cache/data','-a','cache;id','', ['cache']] as $bad) {
    check('invalid target emits no process '.json_encode($bad), function() use($bad) {
        try {zfsmStartPoolScrub($bad,'1'); throw new LogicException('Expected rejection');} catch(InvalidArgumentException $e) {}
        same([], $GLOBALS['test_calls']);
    });
}
check('explicit confirmation is required before reading or starting scrub', function() {
    try {zfsmStartPoolScrub('cache','0'); throw new LogicException('Expected rejection');} catch(InvalidArgumentException $e) {}
    same([], $GLOBALS['test_calls']);
});
foreach ([$running,'resilver in progress since Fri Oct 16 15:00:00 2026','error scrub in progress since Fri Oct 16 15:00:00 2026','scrub mystery'] as $scan) {
    check('existing scan or unknown state blocks start '.$scan, function() use($scan) {
        expectProcess('zpool',['status','-p','-t','cache'],statusFixture('','0 0 0',$scan));
        expectProcess('zpool',['list','-v','-p','cache'],infoFixture());
        try {zfsmStartPoolScrub('cache','1'); throw new LogicException('Expected rejection');} catch(RuntimeException $e) {if($e instanceof LogicException)throw $e;}
        same(2,count($GLOBALS['test_calls']));
    });
}
check('failed pool status blocks scrub', function() {
    expectProcess('zpool',['status','-p','-t','cache'],'no such pool',1);
    expectProcess('zpool',['list','-v','-p','cache'],infoFixture());
    try {zfsmStartPoolScrub('cache','1'); throw new LogicException('Expected rejection');} catch(RuntimeException $e) {if($e instanceof LogicException)throw $e;}
    same(2,count($GLOBALS['test_calls']));
});
check('malformed status blocks scrub', function() {
    expectProcess('zpool',['status','-p','-t','cache'],"scan: none requested\n");
    expectProcess('zpool',['list','-v','-p','cache'],infoFixture());
    try {zfsmStartPoolScrub('cache','1'); throw new LogicException('Expected rejection');} catch(RuntimeException $e) {if($e instanceof LogicException)throw $e;}
    same(2,count($GLOBALS['test_calls']));
});
foreach (['none requested','scrub paused since Fri Oct 16 15:00:00 2026'] as $scan) {
    check('start or resume targets exactly one verified pool '.$scan, function() use($scan) {
        expectProcess('zpool',['status','-p','-t','cache'],statusFixture('','0 0 0',$scan));
        expectProcess('zpool',['list','-v','-p','cache'],infoFixture());
        expectProcess('zpool',['scrub','cache']);
        $answer=zfsmStartPoolScrub('cache','1');
        same([], $answer['failed']); same(['cache'],array_keys($answer['succeeded']));
    });
}
check('native scrub failure reaches caller', function() {
    expectProcess('zpool',['status','-p','-t','cache'],statusFixture('','0 0 0','none requested'));
    expectProcess('zpool',['list','-v','-p','cache'],infoFixture());
    expectProcess('zpool',['scrub','cache'],'cannot scrub cache: pool is busy',1);
    $answer=zfsmStartPoolScrub('cache','1');
    same([], $answer['succeeded']); same('cannot scrub cache: pool is busy',$answer['failed']['cache']);
});
finishTests();
