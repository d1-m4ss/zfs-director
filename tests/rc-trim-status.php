<?php
require '/app/harness.php';
check('native status requests per-vdev TRIM without changing health or scan text',function(){
    $scan='scrub repaired 0B in 00:15:53 with 0 errors on Mon Oct 12 06:15:55 2026';
    expectProcess('zpool',['status','-p','-t','cache'],statusFixture('(100% trimmed, completed at Mon Oct 12 02:10:32 2026)','0 0 0',$scan));
    expectProcess('zpool',['list','-v','-p','cache'],infoFixture());
    $d=zfsmReadPoolDiagnostics('cache');same('ok',$d['severity']);same(true,$d['trim']['available']??null);same($scan,$d['status']['scan']);same('(100% trimmed, completed at Mon Oct 12 02:10:32 2026)',$d['status']['rows'][1]['note']);
});
check('only explicit unsupported t option falls back and marks TRIM Unknown while preserving checksum errors',function(){
    expectProcess('zpool',['status','-p','-t','cache'],"invalid option 't'\nusage:\n\tstatus [-p] [pool]",2);
    expectProcess('zpool',['status','-p','cache'],statusFixture('','0 0 7'));
    expectProcess('zpool',['list','-v','-p','cache'],infoFixture());
    $d=zfsmReadPoolDiagnostics('cache');same(false,$d['trim']['available']??null);same('error',$d['severity']);same([], $d['command_errors']);same(true,in_array('disk1 has CKSUM errors: 7',$d['reasons'],true));same(3,count($GLOBALS['test_calls']));
});
foreach(['I/O failure','permission failure','timeout','partial inventory','wrong unsupported option']as$case)check('real status failure cannot trigger a fallback '.$case,function()use($case){
    [$text,$code]=match($case){'I/O failure'=>["cannot open 'cache': I/O error",1],'permission failure'=>['permission denied',1],'timeout'=>["invalid option 't'",124],'partial inventory'=>[statusFixture('','0 0 7')."\ninvalid option 't'",1],'wrong unsupported option'=>["invalid option 'p'",2]};
    expectProcess('zpool',['status','-p','-t','cache'],$text,$code);expectProcess('zpool',['list','-v','-p','cache'],infoFixture());
    $d=zfsmReadPoolDiagnostics('cache');same('unknown',$d['severity']);same(false,$d['trim']['available']??null);same(1,count($d['command_errors']));same(2,count($GLOBALS['test_calls']));
    if($case==='partial inventory')same(true,in_array('disk1 has CKSUM errors: 7',$d['reasons'],true));
});
check('fallback native failure remains visible and is never converted to healthy',function(){
    expectProcess('zpool',['status','-p','-t','cache'],"invalid option 't'",2);expectProcess('zpool',['status','-p','cache'],'I/O error',1);expectProcess('zpool',['list','-v','-p','cache'],infoFixture());
    $d=zfsmReadPoolDiagnostics('cache');same('unknown',$d['severity']);same(false,$d['trim']['available']??null);same('I/O error',$d['command_errors'][0]['message']);
});
finishTests();
