<?php
/* Streaming commands are owned by this worker; never accept an external PID. */
function zfsmStopIsolatedWorkerGroup() {
    $group=$GLOBALS['zfsm_worker_group']??null;
    if (is_int($group) && $group>1 && function_exists('posix_getpgrp') && posix_getpgrp()===$group && posix_getpid()===$group) @posix_kill(-$group,15);
}
function zfsmStreamProcess($command, $args, $on_chunk, $cancel_requested, $on_failure=null, $stdin=null, $isolate=false) {
    // Linux drains a nonblocking pipe, with bounded memory and no growing log.
    // Windows test hosts require a temporary regular file for cancellable reads.
    $capture=null; $reader=null; $pipes=[];
    $spec=[0=>['pipe','r'],1=>['pipe','w'],2=>['redirect',1]];
    if (PHP_OS_FAMILY==='Windows') {
        $capture=tempnam(sys_get_temp_dir(),'zfsm-');
        if ($capture===false) throw new RuntimeException('Unable to create process capture');
        @chmod($capture,0600); $reader=@fopen($capture,'rb');
        $spec[1]=['file',$capture,'ab'];
    }
    // If the worker dies, its owned child keeps the kernel mutation lock until
    // exit; a restarted daemon cannot copy concurrently with that orphan.
    if (is_resource($GLOBALS['zfsm_operation_lock_handle']??null)) $spec[3]=$GLOBALS['zfsm_operation_lock_handle'];
    $argv=array_merge([$command],array_values($args));
    if($isolate){$setsid=is_executable('/usr/bin/setsid')?'/usr/bin/setsid':'/bin/setsid';if(!is_executable($setsid)||!function_exists('posix_getpgid')||!function_exists('posix_kill'))throw new RuntimeException('Safe isolated process cancellation requires Linux setsid and PHP POSIX.');$argv=array_merge([$setsid,'--wait','--'],$argv);}
    $process=@proc_open($argv, $spec, $pipes, null, null, ['bypass_shell'=>true]);
    if (!is_resource($process)) { if($reader)fclose($reader); if($capture!==null)@unlink($capture); throw new RuntimeException('Unable to start copy process'); }
    $owned_pid=proc_get_status($process)['pid'];$owned_group=false;
    $stop=function($signal)use($process,$isolate,$owned_pid,&$owned_group){
        if($isolate){if(@posix_getpgid($owned_pid)===$owned_pid)$owned_group=true;if($owned_group)@posix_kill(-$owned_pid,$signal);else @proc_terminate($process,$signal);}
        else{zfsmStopIsolatedWorkerGroup();@proc_terminate($process,$signal);}
    };
    try { $prefetched=zfsmProcessInput($process,$pipes,$stdin??''); }
    catch (Throwable $error) { zfsmAbortProcess($process,$pipes); if($reader)fclose($reader); if($capture!==null)@unlink($capture); throw $error; }
    fclose($pipes[0]);
    if ($capture===null) { $reader=$pipes[1]; stream_set_blocking($reader,false); }
    $output=''; $has_output=false; $exit=-1; $cancelled=false; $terminated_at=null; $last_tick=0;
    $consume=function()use($reader,&$output,&$has_output,$on_chunk) {
        // Bounded reads also allow cancellation under continuous child output.
        $chunk=stream_get_contents($reader,65536);
        if ($chunk!==false && $chunk!=='') { $output=substr($output.$chunk,-65536); $has_output=$has_output||trim($chunk)!==''; $on_chunk($chunk); return true; }
        return false;
    };
    try {
        if ($prefetched[1]!=='') { $output=substr($prefetched[1],-65536);$has_output=trim($output)!=='';$on_chunk($prefetched[1]); }
        while (true) {
            if (!$cancelled && $cancel_requested()) {
                $cancelled=true; $terminated_at=microtime(true);
                // A local rsync forks receiver/generator processes. Stop the
                // isolated worker group; its supervisor reaps any survivors.
                $stop(15);
            }
            if ($cancelled && microtime(true)-$terminated_at>2) $stop(9);
            $read=$consume();
            if (microtime(true)-$last_tick>=1) { $on_chunk(''); $last_tick=microtime(true); }
            $status=proc_get_status($process);
            if (!$status['running']) { $exit=$status['exitcode']; break; }
            if (!$read) usleep(100000);
        }
        while ($consume()) {}
    } catch (Throwable $error) {
        try { if ($on_failure!==null) $on_failure($error); }
        finally { $stop(15); usleep(100000); $stop(9); }
        throw $error;
    } finally {
        if($cancelled&&$isolate)$stop(9);
        fclose($reader); $closed=proc_close($process); if($capture!==null)@unlink($capture);
        if ($exit<0) $exit=$closed;
    }
    $answer=['code'=>$exit,'output'=>trim($output),'has_output'=>$has_output,'cancelled'=>$cancelled];if(function_exists('zfsmAuditRecordFailure'))zfsmAuditRecordFailure($command,$args,$answer);return $answer;
}

function zfsmParseRsyncProgress($text) {
    if (!preg_match_all('/([0-9][0-9,]*)\s+(\d{1,3})%\s+([^\s]+)\s+([0-9:]+)/',$text,$matches,PREG_SET_ORDER)) return null;
    $last=end($matches);
    return ['bytes'=>(int)str_replace(',','',$last[1]),'percent'=>min(100,(int)$last[2]),'rate'=>substr($last[3],0,32),'remaining'=>substr($last[4],0,32)];
}
