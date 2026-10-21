<?php
/** Real kernel flock concurrency against copied source and disposable journals. */
error_reporting(E_ALL);
require '/stand/src/include/ZFSMAudit.php';
require '/stand/src/include/ZFSMJobs.php';
$GLOBALS['plugin_state']='/tmp/job-history-'.getmypid();
$id='20261018-000000-000000000001';
function insistHistory($truth,$message){if(!$truth)throw new RuntimeException($message);}
if(($argv[1]??'')==='child'){
    $GLOBALS['plugin_state']=$argv[2];$index=(int)$argv[3];
    for($i=0;$i<6;$i++)zfsmJobUpdate($id,function($job)use($index,$i){usleep(3000);return ['stage'=>'worker_'.$index.'_step_'.$i,'counter'=>($job['counter']??0)+1];});
    exit(0);
}
try{
    $job=zfsmJobInitializeHistory(['id'=>$id,'schema'=>2,'type'=>'archive','state'=>'running','stage'=>'validating','created'=>gmdate('c'),'counter'=>0]);
    zfsmJobAtomicWrite(zfsmJobFile($id),$job);$children=[];
    for($i=0;$i<8;$i++){$pipes=[];$child=proc_open([PHP_BINARY,__FILE__,'child',$GLOBALS['plugin_state'],(string)$i],[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes);insistHistory(is_resource($child),'Unable to start worker');fclose($pipes[0]);$children[]=[$child,$pipes];}
    foreach($children as[$child,$pipes]){$stdout=stream_get_contents($pipes[1]);$stderr=stream_get_contents($pipes[2]);fclose($pipes[1]);fclose($pipes[2]);insistHistory(proc_close($child)===0,'Concurrent worker failed: '.$stdout.$stderr);}
    $job=zfsmReadJob($id);insistHistory($job['counter']===48,'Locked updates were lost');insistHistory(count($job['stage_history'])===49,'Stage transitions were lost');
    $seen=[];foreach(array_slice($job['stage_history'],1)as$event){insistHistory(!isset($seen[$event['stage']]),'Duplicate transition');$seen[$event['stage']]=true;}
    for($i=0;$i<8;$i++)for($j=0;$j<6;$j++)insistHistory(isset($seen['worker_'.$i.'_step_'.$j]),'Missing worker transition');
    for($i=0;$i<20;$i++)zfsmJobUpdate($id,['stage'=>$job['stage'],'progress'=>['percent'=>$i]]);
    insistHistory(count(zfsmReadJob($id)['stage_history'])===49,'Duplicate progress created history');
    echo "PASS native job stage history: 48 concurrent locked transitions retained, duplicate progress omitted\n";
}catch(Throwable$e){fwrite(STDERR,'FAIL native job stage history: '.$e->getMessage()."\n");exit(1);}
