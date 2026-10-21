<?php
/** Native Linux child pipes and flock. No ZFS, no host paths or mounts. */
error_reporting(E_ALL);
set_error_handler(static function($level,$message,$file,$line){if(!(error_reporting()&$level))return false;throw new ErrorException($message,0,$level,$file,$line);});
require '/stand/src/include/ZFSMError.php';
require '/stand/src/include/ZFSMHelpers.php';
require '/stand/src/include/ZFSMAudit.php';
require '/stand/src/include/ZFSMJobs.php';
require '/stand/src/include/ZFSMRequestJobs.php';
$base=sys_get_temp_dir().'/zfsm-process-'.getmypid().'-'.bin2hex(random_bytes(4));mkdir($base,0700);
$GLOBALS['process_helper']=$argv[2]??($base.'/helper.pl');
$explorer=file_get_contents('/stand/src/include/ZFSMExplorer.php');
$explorer=str_replace("return dirname(__DIR__).'/scripts/zfsm-files.pl';",'return $GLOBALS["process_helper"];',$explorer);
eval(substr($explorer,5));
function insist($truth,$message){if(!$truth)throw new RuntimeException($message);}
function waitFile($file){for($i=0;$i<100&&!is_file($file);$i++)usleep(10000);insist(is_file($file),'child PID not recorded');return (int)file_get_contents($file);}
function reaped($pid){clearstatcache();insist(!is_dir('/proc/'.$pid),'child was left alive or unreaped');}
$secret=str_repeat('fixture-private-key-',65536);
$scenario=$argv[1]??'';$pidFile=$base.'/pid';
try {
    if($scenario==='request-job-lease') {
        $GLOBALS['plugin_runtime']=$base.'/runtime';$GLOBALS['plugin_state']=$base.'/jobs';$GLOBALS['zfsm_boot_id']='native-test-boot';
        $j=zfsmRequestJobBegin('movedirectory',['directory'=>'/fixture/directory']);$path=zfsmRequestJobLease($j['id']);$lease=$GLOBALS['zfsm_request_job']['lease'];$stat=fstat($lease);
        insist(zfsmRequestJobActive($j),'live HTTP lease not recognized');
        // A separate exec may open its own descriptor but must never inherit ours.
        $pipes=[];$child=proc_open(['/bin/sleep','1'],[0=>['file','/dev/null','r'],1=>['file','/dev/null','w'],2=>['file','/dev/null','w']],$pipes);$pid=proc_get_status($child)['pid'];
        foreach(glob('/proc/'.$pid.'/fd/*')?:[]as$fd){$s=@stat($fd);insist(!$s||$s['ino']!==$stat['ino']||$s['dev']!==$stat['dev'],'exec inherited request lease');}proc_close($child);
        $probe=fopen($path,'c');insist(!flock($probe,LOCK_EX|LOCK_NB),'live request lease was not exclusive');fclose($probe);
        zfsmRequestJobFinish('completed','Native request finished');insist(!zfsmRequestJobActive(zfsmReadJob($j['id'])),'final request lease remained held');
        // Simulate an abruptly lost owner without running any operation again.
        $orphan=zfsmRequestJobBegin('movedirectory',['directory'=>'/fixture/other']);fclose($GLOBALS['zfsm_request_job']['lease']);unset($GLOBALS['zfsm_request_job']);
        $observed=zfsmObserveRequestJob($orphan['id']);insist($observed['state']==='recovery_required','lost request was not inspection-required');
        insist(zfsmObserveRequestJob($j['id'])['state']==='completed','observer replaced final result');
        require '/stand/src/include/ZFSMRestore.php';
        require '/stand/src/include/ZFSMRecoveryCleanup.php';
        $GLOBALS['plugin_state']=$base.'/cleanup-jobs';$target='/fixture/.zfsm-mutation-'.str_repeat('a',48);
        $cleanup=zfsmRequestJobBegin('cleanupmutation',['directory'=>$target]);$lease=$GLOBALS['zfsm_request_job']['lease'];$path=zfsmRequestJobLease($cleanup['id']);
        zfsmCleanupRequireIdle($target);
        $blocked=function()use($target){try{zfsmCleanupRequireIdle($target);return false;}catch(RuntimeException$error){return true;}};
        flock($lease,LOCK_UN);insist($blocked(),'cleanup exempted an unlocked request lease');insist(flock($lease,LOCK_EX|LOCK_NB),'fixture could not reacquire request lease');
        rename($path,$path.'.old');file_put_contents($path,'replacement');insist($blocked(),'cleanup exempted a replaced request lease');unlink($path);rename($path.'.old',$path);zfsmCleanupRequireIdle($target);
        $other=$cleanup;$other['id']='20261020-120000-ffffffffffff';$other['source']='/fixture/other';zfsmJobAtomicWrite(zfsmJobFile($other['id']),$other);insist($blocked(),'own cleanup exempted another live request');
        zfsmJobUpdate($other['id'],['state'=>'recovery_required','stage'=>'interrupted']);insist($blocked(),'own cleanup hid unrelated recovery-required state');unlink(zfsmJobFile($other['id']));
        zfsmRequestJobFinish('completed','Synthetic cleanup lease validation finished');zfsmCleanupRequireIdle($target);
    } elseif($scenario==='operation-lock') {
        $file=$base.'/mutation.lock';$h=zfsmAcquireOperationLock($file);$ino=fstat($h)['ino'];
        $message='';try{zfsmAcquireOperationLock($file);}catch(RuntimeException$e){$message=$e->getMessage();}insist(str_contains($message,'lock is held'),'contention not distinguished');insist(zfsmAcquireOperationLock($file,true)===null,'worker busy probe did not return null');
        $pipes=[];$child=proc_open(['/bin/sleep','2'],[0=>['file','/dev/null','r'],1=>['file','/dev/null','w'],2=>['file','/dev/null','w']],$pipes);$pid=proc_get_status($child)['pid'];
        foreach(glob('/proc/'.$pid.'/fd/*')?:[]as$fd){$st=@stat($fd);insist(!$st||$st['ino']!==$ino||$st['dev']!==fstat($h)['dev'],'unrelated exec inherited mutation lock');}
        fclose($h);$h=zfsmAcquireOperationLock($file);insist(fstat($h)['ino']===$ino,'lock inode was replaced');fclose($h);proc_close($child);
        file_put_contents($base.'/outside','KEEP');symlink($base.'/outside',$base.'/alias');$bad=false;try{zfsmAcquireOperationLock($base.'/alias');}catch(RuntimeException$e){$bad=str_contains($e->getMessage(),'Operation lock unavailable');}insist($bad&&file_get_contents($base.'/outside')==='KEEP','symlink lock was followed or changed');
    } elseif($scenario==='duplex') {
        $script='$p=$argv[1];file_put_contents($p,(string)getmypid());fwrite(STDOUT,str_repeat("O",1048576));$data=stream_get_contents(STDIN);echo "\\n".hash("sha256",$data);';
        $answer=runProcess(PHP_BINARY,['-r',$script,$pidFile],$secret);
        insist($answer['code']===0,'large input command failed');insist($answer['output']===str_repeat('O',1048576)."\n".hash('sha256',$secret),'large stdin/output was truncated');reaped(waitFile($pidFile));
    } elseif($scenario==='broken-input') {
        $lock=fopen($base.'/mutation.lock','c');flock($lock,LOCK_EX);$GLOBALS['zfsm_operation_lock_handle']=$lock;
        $script='file_put_contents($argv[1],(string)getmypid());fclose(STDIN);pcntl_signal(SIGTERM,SIG_IGN);pcntl_async_signals(true);sleep(20);';
        $answer=runProcess(PHP_BINARY,['-r',$script,$pidFile],$secret);
        insist($answer['code']!==0,'closed child stdin reported success');insist(!str_contains($answer['output'],'fixture-private-key'),'secret leaked in transport error');reaped(waitFile($pidFile));
        $probe=fopen($base.'/mutation.lock','c');insist(!flock($probe,LOCK_EX|LOCK_NB),'parent mutation lock was dropped during cleanup');fclose($probe);
        unset($GLOBALS['zfsm_operation_lock_handle']);flock($lock,LOCK_UN);fclose($lock);$probe=fopen($base.'/mutation.lock','c');insist(flock($probe,LOCK_EX|LOCK_NB),'orphan child retained the mutation lock');fclose($probe);
    } elseif($scenario==='explorer-broken-input') {
        file_put_contents($GLOBALS['process_helper'],'use strict; use warnings; open(my $p,">",$ENV{ZFSM_PROCESS_PID}) or die; print $p $$; close $p; close STDIN; $SIG{TERM}="IGNORE"; sleep 20;');putenv('ZFSM_PROCESS_PID='.$pidFile);
        try{zfsmExplorerOpen(['secret'=>$secret]);throw new LogicException('closed Explorer stdin reported success');}catch(RuntimeException$e){insist(!str_contains($e->getMessage(),'fixture-private-key'),'Explorer secret leaked');}
        reaped(waitFile($pidFile));
    } elseif($scenario==='explorer-duplex') {
        file_put_contents($GLOBALS['process_helper'],'use strict;use warnings;print STDERR "E"x32768;print STDOUT " "x1048576;local $/;my $in=<STDIN>;print STDOUT "{\\"received\\":".length($in)."}";');
        $args=['payload'=>$secret];$answer=zfsmExplorerCall($args);insist($answer['received']===strlen(json_encode($args,JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)),'Explorer input or prefetched output truncated');
    } elseif($scenario==='download-child') {
        zfsmStreamDownload(['payload'=>$secret],'fixture.bin','application/octet-stream');exit(0);
    } elseif($scenario==='explorer-download') {
        file_put_contents($GLOBALS['process_helper'],'use strict;use warnings;print STDOUT "{\\"ready\\":true,\\"size\\":1048576}\\n";print STDOUT "B"x1048576;local $/;my $in=<STDIN>;');
        $answer=runProcess(PHP_BINARY,[__FILE__,'download-child',$GLOBALS['process_helper']]);
        insist($answer['code']===0,'prefetched download failed');insist(strlen($answer['output'])===1048576 && hash('sha256',$answer['output'])===hash('sha256',str_repeat('B',1048576)),'prefetched download body was lost or truncated');
    } elseif($scenario==='explorer-call-overflow') {
        file_put_contents($GLOBALS['process_helper'],'use strict;use warnings;open(my $p,">",$ENV{ZFSM_PROCESS_PID}) or die;print $p $$;close $p;local $/;my $in=<STDIN>;$SIG{TERM}="IGNORE";print STDERR "E"x131072;sleep 20;');putenv('ZFSM_PROCESS_PID='.$pidFile);
        try{zfsmExplorerCall(['payload'=>'small']);throw new LogicException('unbounded Explorer call stderr accepted');}catch(RuntimeException$e){}
        reaped(waitFile($pidFile));
    } elseif($scenario==='explorer-output-limit') {
        file_put_contents($GLOBALS['process_helper'],'use strict;use warnings;open(my $p,">",$ENV{ZFSM_PROCESS_PID}) or die;print $p $$;close $p;$SIG{TERM}="IGNORE";print STDERR "E"x131072;sleep 20;');putenv('ZFSM_PROCESS_PID='.$pidFile);
        try{zfsmExplorerOpen(['secret'=>$secret]);throw new LogicException('unbounded Explorer stderr accepted');}catch(RuntimeException$e){insist(!str_contains($e->getMessage(),'fixture-private-key'),'Explorer secret leaked');}
        reaped(waitFile($pidFile));
    } elseif($scenario==='explorer-encoding') {
        file_put_contents($GLOBALS['process_helper'],'open(my $p,">",$ENV{ZFSM_PROCESS_PID}) or die;print $p $$;close $p;sleep 20;');putenv('ZFSM_PROCESS_PID='.$pidFile);
        try{zfsmExplorerOpen(['bad'=>NAN]);throw new LogicException('invalid JSON accepted');}catch(JsonException$e){}
        usleep(100000);insist(!is_file($pidFile),'Explorer spawned child before JSON validation');
    } else throw new RuntimeException('Unknown native process scenario');
    echo 'PASS '.$scenario."\n";
} catch(Throwable$e){fwrite(STDERR,'FAIL '.$scenario.': '.$e->getMessage()."\n");exit(1);}
