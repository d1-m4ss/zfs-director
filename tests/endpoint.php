<?php
require '/app/harness.php';
function parse_plugin_cfg($plugin, $sections) { return []; }
$docroot='/app/host';
@mkdir('/app/host/webGui/include',0777,true);
file_put_contents('/app/host/webGui/include/Helpers.php', '<?php');
@mkdir('/app/host/plugins',0777,true);
symlink('/app/src','/app/host/plugins/zfs.master.ui');
$GLOBALS['var']=['csrf_token'=>'test-secret'];
$_SERVER['REQUEST_METHOD']=$case==='get'?'GET':'POST';
$_POST=['cmd'=>'scrubpool','pool'=>'cache','confirmed'=>'1','csrf_token'=>$case==='csrf'?'bad':'test-secret'];
if ($case==='refresh') $_POST['cmd']='refresh';
if ($case==='unconfirmed') $_POST['confirmed']='0';
if ($case==='badpool') $_POST['pool']='cache/data';
if ($case==='lock') $GLOBALS['plugin_lock']='/missing/operation.lock';
if (in_array($case,['success','native-failure'],true)) {
    expectProcess('zpool',['status','-p','-t','cache'],statusFixture('','0 0 0','none requested'));
    expectProcess('zpool',['list','-v','-p','cache'],infoFixture());
    expectProcess('zpool',['get','-H','-o','value','guid','cache'],'54321');expectProcess('/bin/date',['+%z'],'+0000');expectProcess('zpool',['scrub','cache'],$case==='native-failure'?'cannot scrub cache: busy':'',$case==='native-failure'?1:0);
}
ob_start();
require '/app/src/backend/ZFSMAdmin.php';
$body=ob_get_clean();
check('endpoint '.$case, function() use($body,$case) {
    $answer=json_decode($body,true,512,JSON_THROW_ON_ERROR);
    $succeeded=in_array($case,['success','refresh'],true);
    same($succeeded,!empty($answer['succeeded']));
    same(!$succeeded,!empty($answer['failed']));
    if (!in_array($case,['success','native-failure'],true)) same([], $GLOBALS['test_calls']);
    $audit=zfsmAuditList();
    if (in_array($case,['csrf','get'],true)) same([], $audit);
    else {
        same(2,count($audit));
        same($case==='refresh'?'refresh':'scrubpool',$audit[0]['command']);
        same($succeeded?'succeeded':'failed',$audit[0]['status']);
        same($case==='badpool'?'cache/data':'cache', $audit[1]['fields']['pool']);
    }
});
finishTests();
