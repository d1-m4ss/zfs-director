<?php
if (is_file('/app/harness.php')) require '/app/harness.php';
else {
 require '/stand/src/include/ZFSMAudit.php';
 $GLOBALS['paging_checks']=0;$GLOBALS['paging_failures']=0;
 function same($want,$got){if($want!==$got)throw new RuntimeException('Expected '.json_encode($want).', got '.json_encode($got));}
 function check($name,$fn){$GLOBALS['paging_checks']++;try{$fn();echo 'PASS '.$name."\n";}catch(Throwable$e){$GLOBALS['paging_failures']++;echo 'FAIL '.$name.': '.$e->getMessage()."\n";}}
 function finishTests(){echo $GLOBALS['paging_checks'].' checks, '.$GLOBALS['paging_failures']." failures\n";exit($GLOBALS['paging_failures']?1:0);}
}
function auditRecord($i,$date='2026-10-16') {return ['version'=>1,'operation_id'=>str_pad(dechex($i+1),32,'0',STR_PAD_LEFT),'timestamp'=>$date.'T12:00:00Z','command'=>'renamedataset','phase'=>'event','status'=>'succeeded','fields'=>['zdataset'=>'cache/item'.$i]];}
function auditDirectory($name) {$GLOBALS['plugin_audit']='/test/audit-page-'.$name;return zfsmAuditStorage(true);}
function auditRefused($fn){try{$fn();}catch(InvalidArgumentException|RuntimeException $e){return;}throw new RuntimeException('Expected unsafe cursor to be refused');}
check('persistent pages reach 1500 records across daily files exactly once with bounded reads',function(){
 $dir=auditDirectory('all');for($day=0;$day<3;$day++){$date='2026-10-'.(13+$day);$lines=[];for($i=0;$i<500;$i++)$lines[]=json_encode(auditRecord($day*500+$i,$date));file_put_contents($dir.'/'.$date.'.jsonl',implode("\n",$lines)."\n");}
 $cursor='';$ids=[];$pages=0;do{$page=zfsmAuditPage(200,$cursor);same(true,count($page['entries'])<=200);same(true,$page['bytes_read']<=2*1024*1024);same(true,$page['lines_scanned']<=4096);same(true,$page['files_read']<=32);same(true,$page['directory_entries_scanned']<=4096);foreach($page['entries']as$entry)$ids[]=$entry['operation_id'];$cursor=$page['next_cursor']??'';$pages++;if($pages>20)throw new RuntimeException('Cursor failed to advance');}while($page['has_more']);
 same(1500,count($ids));same(1500,count(array_unique($ids)));same(str_pad(dechex(1500),32,'0',STR_PAD_LEFT),$ids[0]);same(str_pad('1',32,'0',STR_PAD_LEFT),end($ids));same(null,$page['next_cursor']);
});
check('cursor pins prior page boundary despite new append',function(){
 $dir=auditDirectory('append');$file=$dir.'/2026-10-16.jsonl';$lines=[];for($i=0;$i<6;$i++)$lines[]=json_encode(auditRecord($i));file_put_contents($file,implode("\n",$lines)."\n");$first=zfsmAuditPage(3);file_put_contents($file,json_encode(auditRecord(6))."\n",FILE_APPEND);$older=zfsmAuditPage(3,$first['next_cursor']);
 same([auditRecord(2)['operation_id'],auditRecord(1)['operation_id'],auditRecord(0)['operation_id']],array_column($older['entries'],'operation_id'));same(false,$older['has_more']);
});
check('malformed/truncated/oversized records never become history entries or exhaust all older data',function(){
 $dir=auditDirectory('corrupt');file_put_contents($dir.'/2026-10-16.jsonl',json_encode(auditRecord(0))."\n".str_repeat('x',2200000)."\n"."not JSON\n".json_encode(auditRecord(1))."\n".'{"version":1');
 $ids=[];$cursor='';$pages=0;do{$page=zfsmAuditPage(10,$cursor);foreach($page['entries']as$entry)$ids[]=$entry['operation_id'];same(true,$page['bytes_read']<=2*1024*1024);$cursor=$page['next_cursor']??'';if(++$pages>10)throw new RuntimeException('Oversized record pagination stalled');}while($page['has_more']);same([auditRecord(1)['operation_id'],auditRecord(0)['operation_id']],$ids);
});
check('strict cursor and limit types reject path escapes offsets and replacement identity',function(){
 $dir=auditDirectory('cursor');$file=$dir.'/2026-10-16.jsonl';file_put_contents($file,json_encode(auditRecord(0))."\n".json_encode(auditRecord(1))."\n");$page=zfsmAuditPage(1);$cursor=$page['next_cursor'];
 foreach([null,[],0,501,'01','1e2','500oops']as$limit)auditRefused(fn()=>zfsmAuditPage($limit));
 foreach([[],null,str_repeat('x',513),'../outside','!!!!']as$bad)auditRefused(fn()=>zfsmAuditPage(1,$bad));
 $data=json_decode(base64_decode(strtr($cursor,'-_','+/')),true);foreach(['name'=>'../outside','offset'=>'9999999999999999999','ino'=>'999999']as$key=>$value){$bad=$data;$bad[$key]=$value;$encoded=rtrim(strtr(base64_encode(json_encode($bad)),'+/','-_'),'=');auditRefused(fn()=>zfsmAuditPage(1,$encoded));}
 rename($file,$file.'.retained');file_put_contents($file,json_encode(auditRecord(5))."\n");auditRefused(fn()=>zfsmAuditPage(1,$cursor));
});
check('paged history refuses symlinked daily files without reading their targets',function(){
 $dir=auditDirectory('symlink');file_put_contents('/test/not-audit',json_encode(auditRecord(8))."\n");symlink('/test/not-audit',$dir.'/2026-10-16.jsonl');auditRefused(fn()=>zfsmAuditPage(10));
});
check('paging preserves legacy list contract and redaction',function(){
 $dir=auditDirectory('legacy');$record=auditRecord(4);$record['fields']['passphrase']='secret-canary';$record['raw_output']='secret-canary';file_put_contents($dir.'/2026-10-16.jsonl',json_encode($record)."\n");same(zfsmAuditList(5),zfsmAuditPage(5)['entries']);same(false,str_contains(json_encode(zfsmAuditPage(5)),'secret-canary'));
});
finishTests();
