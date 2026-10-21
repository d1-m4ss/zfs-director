<?php
require '/app/harness.php';
$GLOBALS['plugin_state']='/zip-cleanup-jobs';$GLOBALS['plugin_runtime']='/zip-cleanup-runtime';$GLOBALS['zfsm_boot_id']='zip-cleanup-boot';
foreach(['/','/usr','/usr/sbin','/usr/sbin/zfs']as$p)chmod($p,0755);
mkdir('/zip-fixture');file_put_contents('/proc/self/mountinfo',"1 0 0:1 / / rw - rootfs rootfs rw\n");
function zipFixture($changes=[]){
 static $i=0;$id='20261021-000000-'.str_pad(dechex(++$i),12,'0',STR_PAD_LEFT);$mount='/zip-fixture/case-'.$i.'/owner';mkdir(dirname($mount));
 $j=array_replace(['schema'=>2,'type'=>'archive','id'=>$id,'state'=>'completed','stage'=>'completed','snapshot'=>'tank/zip@saved','snapshot_guid'=>'77','dataset'=>'tank/zip','owner_guid'=>'123','owner_pool_guid'=>'9000','owner_mountpoint'=>$mount,'source'=>'tank/zip@saved','target'=>'ZIP download','staging'=>$mount.'/.zfsm-archive-'.$id,'hold_tag'=>'zfsm_archive_'.$id,'hold_owned'=>false,'cancel_requested'=>false,'ack_boot'=>'zip-cleanup-boot','destination_identity'=>['dev'=>'1','ino'=>'2'],'archive_removed'=>false,'expires'=>time()-10,'archive_identity'=>['dev'=>'1','ino'=>'3','type'=>'file'],'archive_size'=>10,'cleanup_retry_after'=>0,'error'=>null],$changes);
 zfsmJobAtomicWrite(zfsmJobFile($id),$j);$GLOBALS['cleanup_helper_calls']=[];$GLOBALS['cleanup_helper_reply']=['removed'=>true];return$j;
}
function zipInventory($text="tank\tfilesystem\t900\ntank/sibling\tfilesystem\t901",$code=0){expectProcess('zpool',['get','-H','-p','-o','value','guid','tank'],$code===0?'9000':'unavailable',$code);if($code!==0)return;expectProcess('zfs',['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o','name,type,guid','tank'],$text,$code);}
function zipMissing(){expectProcess('zfs',['get','-H','-p','-o','value','guid','tank/zip'],'missing',1);}
function zipBlocked($j){zfsmRunRestoreJob($j['id']);$a=zfsmReadJob($j['id']);same(false,$a['archive_removed']);same($j['error'],$a['error']);same(true,$a['cleanup_retry_after']>time());same(true,is_string($a['cleanup_error']??null));same([],$GLOBALS['cleanup_helper_calls']);}
check('absent owner and ZIP reconcile metadata once; original failure stays intact',function(){
 $j=zipFixture(['state'=>'failed','stage'=>'compressing','error'=>'Original compression failure']);zipMissing();zipInventory();zipInventory();zfsmRunRestoreJob($j['id']);$a=zfsmReadJob($j['id']);
 same(true,$a['archive_removed']);same(false,$a['hold_owned']);same('owner_absent',$a['cleanup_resolution']);same('Original compression failure',$a['error']);same(null,$a['cleanup_retry_after']);same(null,$a['cleanup_error']);same([],$GLOBALS['cleanup_helper_calls']);same(false,in_array($j['id'],array_column(zfsmPendingJobs(),'id'),true));
 $bytes=file_get_contents(zfsmJobFile($j['id']));zfsmRunRestoreJob($j['id']);same($bytes,file_get_contents(zfsmJobFile($j['id'])));
});
foreach(['exported pool','truncated','missing root','renamed owner','renamed snapshot','reused name','duplicate name','invalid GUID','outside pool']as$case)check('uncertain orphan remains protected: '.$case,function()use($case){
 $j=zipFixture(['error'=>'Keep original error']);zipMissing();zipInventory(match($case){'exported pool'=>'unavailable','truncated'=>"tank\tfilesystem\t900\nshort",'missing root'=>"tank/sibling\tfilesystem\t901",'renamed owner'=>"tank\tfilesystem\t900\ntank/renamed\tfilesystem\t123",'renamed snapshot'=>"tank\tfilesystem\t900\ntank/sibling@renamed\tsnapshot\t77",'reused name'=>"tank\tfilesystem\t900\ntank/zip\tfilesystem\t999",'duplicate name'=>"tank\tfilesystem\t900\ntank\tfilesystem\t901",'invalid GUID'=>"tank\tfilesystem\tbad",'outside pool'=>"tank\tfilesystem\t900\nother/item\tfilesystem\t901"},$case==='exported pool'?1:0);zipBlocked($j);
});
check('legacy job without pool GUID remains inspection-only',function(){
 $j=zipFixture();unset($j['owner_pool_guid']);zfsmJobAtomicWrite(zfsmJobFile($j['id']),$j);zipMissing();zipBlocked($j);
});
check('different pool imported under original name cannot clear original data or holds',function(){
 $j=zipFixture(['hold_owned'=>true]);expectProcess('zfs',['list','-H','-p','-d','1','-t','snapshot','-o','name,guid','tank/zip'],'missing',1);zipMissing();expectProcess('zpool',['get','-H','-p','-o','value','guid','tank'],'9001');zipBlocked($j);same(true,zfsmReadJob($j['id'])['hold_owned']);
});
check('pool replacement between inventory passes remains blocked',function(){
 $j=zipFixture();zipMissing();zipInventory();expectProcess('zpool',['get','-H','-p','-o','value','guid','tank'],'9001');zipBlocked($j);
});
check('inventory changes during orphan verification retain cleanup',function(){
 $j=zipFixture();zipMissing();zipInventory();zipInventory("tank\tfilesystem\t902");zipBlocked($j);
});
foreach(['existing owner','staging data','symlink parent']as$case)check('recorded paths remain protected: '.$case,function()use($case){
 $j=zipFixture();if($case==='symlink parent'){mkdir('/zip-fixture/elsewhere');symlink('/zip-fixture/elsewhere',$j['owner_mountpoint']);}else{mkdir($j['owner_mountpoint']);if($case==='staging data'){mkdir($j['staging']);file_put_contents($j['staging'].'/kept','retained bytes');}}
 zipMissing();zipInventory();zipBlocked($j);if($case==='staging data')same('retained bytes',file_get_contents($j['staging'].'/kept'));
});
check('unreleased hold does not get inferred away from a failed dataset lookup alone',function(){
 $j=zipFixture(['hold_owned'=>true]);expectProcess('zfs',['list','-H','-p','-d','1','-t','snapshot','-o','name,guid','tank/zip'],'unavailable',1);zipMissing();zipInventory('unavailable',1);zipBlocked($j);same(true,zfsmReadJob($j['id'])['hold_owned']);
});
check('absent snapshot GUID reconciles its stale hold flag without releasing another hold',function(){
 $j=zipFixture(['hold_owned'=>true]);expectProcess('zfs',['list','-H','-p','-d','1','-t','snapshot','-o','name,guid','tank/zip'],'unavailable',1);zipMissing();zipInventory();zipInventory();zfsmRunRestoreJob($j['id']);$a=zfsmReadJob($j['id']);same(false,$a['hold_owned']);same(true,$a['archive_removed']);same(null,$a['cleanup_error']);same([],$GLOBALS['cleanup_helper_calls']);
});
function zipLive($j){
 mkdir($j['owner_mountpoint']);$identity=zfsmDirectoryIdentity($j['owner_mountpoint']);zfsmJobUpdate($j['id'],['destination_identity'=>$identity]);
 file_put_contents('/proc/self/mountinfo',"1 0 0:1 / / rw - rootfs rootfs rw\n2 1 0:2 / ".$j['owner_mountpoint']." rw - zfs tank/zip rw\n");zfsmJobAtomicWrite(zfsmRestoreManifestFile($j['id']),['archive_token'=>str_repeat('a',64)]);expectProcess('zfs',['get','-H','-p','-o','value','guid','tank/zip'],'123');
}
check('normal owned cleanup clears retry diagnostics without erasing job outcome',function(){
 $j=zipFixture(['error'=>'Original failure','cleanup_error'=>'Previous cleanup failure']);zipLive($j);zfsmRunRestoreJob($j['id']);$a=zfsmReadJob($j['id']);same(true,$a['archive_removed']);same(null,$a['cleanup_retry_after']);same(null,$a['cleanup_error']);same('Original failure',$a['error']);same('removed',$a['cleanup_resolution']);same(1,count($GLOBALS['cleanup_helper_calls']));
});
check('helper must positively confirm removal; malformed success is retained',function(){
 $j=zipFixture();zipLive($j);$GLOBALS['cleanup_helper_reply']=['removed'=>false];zfsmRunRestoreJob($j['id']);$a=zfsmReadJob($j['id']);same(false,$a['archive_removed']);same(true,$a['cleanup_retry_after']>time());same(null,$a['error']);same(1,count($GLOBALS['cleanup_helper_calls']));
});
check('completed orphan presentation explains metadata-only reconciliation and cannot resume',function(){
 $j=zipFixture();zipMissing();zipInventory();zipInventory();zfsmRunRestoreJob($j['id']);$a=zfsmReadJob($j['id']);$v=zfsmJobPresentation($a,zfsmJobFile($j['id']),false);same('completed',$v['group']);same('removed',$v['archive_status']);same(false,$v['actions']['resume']);same(false,$v['actions']['download']);same(true,str_contains($v['retained_data']['message'],'No files were deleted'));
});
finishTests();
