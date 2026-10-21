<?php

// Preserve native text; missing progress or an unfamiliar format is never 100%.
function zfsmParsePoolScan($text) {
    $scan = ['state'=>'unknown','kind'=>null,'text'=>$text,'percent'=>null,'scanned'=>null,'scan_total'=>null,'scan_rate'=>null,'issued'=>null,'issue_total'=>null,'issue_rate'=>null,'eta'=>null,'repaired'=>null,'errors'=>null];
    $first = trim(explode("\n", trim($text))[0]);
    $details = $text;
    // OpenZFS can print an old scrub before an active resilver/rebuild.
    // A paused scrub must not take precedence over reconstruction either.
    foreach (['resilver(?: \([^\r\n()]+\))?', 'error scrub', 'scrub'] as $kind) {
        if (preg_match('/(?:^|\n)('.$kind.' (?:in progress|paused) since [^\n]+)/', $text, $match, PREG_OFFSET_CAPTURE)) {
            $first = trim($match[1][0]); $details = substr($text, $match[1][1]); break;
        }
    }
    if ($first === 'none requested') $scan['state'] = 'idle';
    elseif (preg_match('/^(scrub|error scrub|resilver(?: \([^\r\n()]+\))?) (in progress|paused) since .+$/D', $first, $match)) {
        $scan['kind'] = str_starts_with($match[1], 'resilver') ? 'resilver' : $match[1];
        $scan['state'] = $scan['kind'] === 'resilver' ? 'resilvering' : ($match[2] === 'paused' ? 'paused' : 'running');
    } elseif (preg_match('/^(scrub|resilver(?: \([^\r\n()]+\))?) canceled on .+$/D', $first, $match)) {
        $scan['state'] = 'canceled'; $scan['kind'] = str_starts_with($match[1], 'resilver') ? 'resilver' : 'scrub';
    } elseif (preg_match('/^(scrub repaired|resilvered(?: \([^\r\n()]+\))?) (\S+) in .+ with ([0-9]+) errors on .+$/D', $first, $match)) {
        $scan['state'] = 'finished'; $scan['kind'] = str_starts_with($match[1], 'resilvered') ? 'resilver' : 'scrub';
        $scan['repaired'] = $match[2]; $scan['errors'] = (int)$match[3];
    }
    if (in_array($scan['state'], ['running','paused','resilvering'], true)) {
        if (preg_match('/\b([0-9]+(?:\.[0-9]+)?)% done\b/', $details, $match)) $scan['percent'] = (float)$match[1];
        if (preg_match('/([0-9]+(?:\.[0-9]+)?[KMGTPEZY]?B?) \/ ([0-9]+(?:\.[0-9]+)?[KMGTPEZY]?B?) scanned(?: at (\S+\/s))?, ([0-9]+(?:\.[0-9]+)?[KMGTPEZY]?B?) \/ ([0-9]+(?:\.[0-9]+)?[KMGTPEZY]?B?) issued(?: at (\S+\/s))?/', $details, $match)) {
            $scan['scanned']=$match[1]; $scan['scan_total']=$match[2]; $scan['scan_rate']=($match[3] ?? '') ?: null;
            $scan['issued']=$match[4]; $scan['issue_total']=$match[5]; $scan['issue_rate']=($match[6] ?? '') ?: null;
        }
        if (preg_match('/([0-9]+(?:\.[0-9]+)?[KMGTPEZY]?B?) repaired,/', $details, $match)) $scan['repaired'] = $match[1];
        if ($scan['state'] !== 'paused' && preg_match('/((?:[0-9]+ days? )?[0-9]+:[0-9]{2}:[0-9]{2}) to go/', $details, $match)) $scan['eta'] = $match[1];
    }
    return $scan;
}

function zfsmStartPoolScrub($pool, $confirmed) {
    if (!zfsmValidPoolName($pool)) throw new InvalidArgumentException('Invalid pool name');
    if ($confirmed !== '1') throw new InvalidArgumentException('Confirm scrub of the entire selected pool');
    $diagnostic = zfsmReadPoolDiagnostics($pool);
    if ($diagnostic['severity'] === 'unknown' || !in_array($diagnostic['health'], ['ONLINE','DEGRADED'], true)) throw new RuntimeException('Pool status is unavailable or unsafe for starting scrub');
    $scan = $diagnostic['scan'];
    if (!in_array($scan['state'], ['idle','finished','canceled','paused'], true) || $scan['kind'] === 'error scrub') throw new RuntimeException('A scan is active or its state is unknown; scrub was not started');
    // OpenZFS owns execution; Director only observes this explicitly requested scan.
    if(isset($GLOBALS['zfsm_request_job'])){
        $guid=zfsmScrubPoolGuid($pool);
        zfsmJobUpdate($GLOBALS['zfsm_request_job']['id'],['pool_guid'=>$guid,'scan_before'=>hash('sha256',$scan['text']),'scan_timezone'=>zfsmScrubNativeOffset(),'scan_requested_from'=>time()]+($scan['state']==='paused'&&preg_match('/^scrub paused since ([^\r\n]+)/',$scan['text'],$paused)?['scan_resume_started'=>$paused[1]]:[]));
    }
    $answer = commandAnswer($pool, runProcess('zpool', ['scrub',$pool]));
    if (isset($answer['succeeded'][$pool])) {
        $answer['succeeded'][$pool] = 'Scrub '.($scan['state'] === 'paused' ? 'resume' : 'start').' requested; native progress appears in Jobs';
        if(isset($GLOBALS['zfsm_request_job'])){
            $GLOBALS['zfsm_request_job']['native_submitted']=true;$tracking=$GLOBALS['zfsm_request_job'];
            $answer['job']=zfsmJobUpdate($tracking['id'],['state'=>'running','stage'=>'awaiting_scan','observed_at'=>0,'scan_requested_until'=>time()]);
            fclose($tracking['lease']);unset($GLOBALS['zfsm_request_job']);
            try{zfsmStartWorker();}catch(Throwable$error){$answer['worker_warning']='Scrub was requested, but its observer could not start. Inspect native pool status.';}
        }
    }
    return $answer;
}

function zfsmScrubPoolGuid($pool) {
    if(!zfsmValidPoolName($pool))throw new RuntimeException('Invalid scrub pool');
    $had=array_key_exists('zfsm_inventory_deadline',$GLOBALS);$previous=$GLOBALS['zfsm_inventory_deadline']??null;$GLOBALS['zfsm_inventory_deadline']=$previous===null?microtime(true)+5:min($previous,microtime(true)+5);
    try{$r=runProcess('zpool',['get','-H','-o','value','guid',$pool]);}finally{if($had)$GLOBALS['zfsm_inventory_deadline']=$previous;else unset($GLOBALS['zfsm_inventory_deadline']);}
    $guid=trim($r['output']??'');
    if(($r['code']??1)!==0||!preg_match('/^[1-9][0-9]*$/D',$guid))throw new RuntimeException('Pool GUID unavailable');
    return $guid;
}
function zfsmScrubNativeOffset() {
    $had=array_key_exists('zfsm_inventory_deadline',$GLOBALS);$previous=$GLOBALS['zfsm_inventory_deadline']??null;$GLOBALS['zfsm_inventory_deadline']=$previous===null?microtime(true)+5:min($previous,microtime(true)+5);
    try{$r=runProcess('/bin/date',['+%z']);}finally{if($had)$GLOBALS['zfsm_inventory_deadline']=$previous;else unset($GLOBALS['zfsm_inventory_deadline']);}
    $offset=trim($r['output']??'');if(($r['code']??1)!==0||!preg_match('/^[+-](?:0[0-9]|1[0-4])[0-5][0-9]$/D',$offset))throw new RuntimeException('Native timezone unavailable');
    return $offset;
}
function zfsmScrubStamp($stamp,$offset) {
    $stamp=preg_replace('/\s+/',' ',trim($stamp));$date=DateTimeImmutable::createFromFormat('!D M j H:i:s Y',$stamp,new DateTimeZone($offset));
    return $date&&$date->format('D M j H:i:s Y')===$stamp?$date->getTimestamp():null;
}
function zfsmScrubTerminalMatchesStart($text,$started,$offset) {
    if(!preg_match('/^scrub repaired \S+ in (?:(\d{1,5}) days? )?(\d{1,6}):(\d{2}):(\d{2}) with [0-9]+ errors on ([^\r\n]+)$/D',trim($text),$m))return false;
    if((int)$m[3]>59||(int)$m[4]>59)return false;
    $start=zfsmScrubStamp($started,$offset);$end=zfsmScrubStamp($m[5],$offset);$duration=(int)($m[1]?:0)*86400+(int)$m[2]*3600+(int)$m[3]*60+(int)$m[4];
    return $start!==null&&$end!==null&&$duration>0&&$end>=$start&&$end-$duration===$start;
}
function zfsmObserveScrubJob($job) {
    // Never issue scrub, resume, cancel or any other mutation from observation.
    if(time()-($job['observed_at']??0)<15)return $job;
    $had=array_key_exists('zfsm_inventory_deadline',$GLOBALS);$previous=$GLOBALS['zfsm_inventory_deadline']??null;$GLOBALS['zfsm_inventory_deadline']=$previous===null?microtime(true)+8:min($previous,microtime(true)+8);
    try{
        if($job['owner_boot']!==zfsmBootId())throw new RuntimeException('Boot changed');
        if(zfsmScrubPoolGuid($job['source'])!==$job['pool_guid'])throw new RuntimeException('Pool changed');
        $r=runProcess('zpool',['status','-p',$job['source']]);
        if(($r['code']??1)!==0)throw new RuntimeException('Native status unavailable');
        $parsed=zfsmParsePoolDiagnosticStatus($job['source'],$r['output']);if($parsed['issues'])throw new RuntimeException('Unknown pool status');
        $scan=zfsmParsePoolScan($parsed['data']['scan']);$changes=['observed_at'=>time()];
        if(in_array($scan['state'],['running','paused'],true)&&$scan['kind']==='scrub'){
            if(!preg_match('/^scrub (?:in progress|paused) since ([^\r\n]+)/',$scan['text'],$match))throw new RuntimeException('Scan identity unavailable');
            if(isset($job['scan_started'])&&$job['scan_started']!==$match[1])throw new RuntimeException('Scan changed');
            if(!isset($job['scan_started'])){
                $stamp=zfsmScrubStamp($match[1],$job['scan_timezone']);
                if(isset($job['scan_resume_started'])?$job['scan_resume_started']!==$match[1]:($stamp===null||$stamp<$job['scan_requested_from']||$stamp>$job['scan_requested_until']))throw new RuntimeException('Observed scan does not match the requested start');
            }
            $changes+=['scan_started'=>$match[1],'stage'=>$scan['state']==='paused'?'scrub_paused':'scrubbing','progress'=>['percent'=>is_numeric($scan['percent'])?min(99,max(0,$scan['percent'])):null,'scanned'=>$scan['scanned'],'issued'=>$scan['issued'],'issue_total'=>$scan['issue_total'],'eta'=>$scan['eta']]];
        }elseif(hash('sha256',$scan['text'])===$job['scan_before']){
            if(time()-strtotime($job['started_at'])>60)throw new RuntimeException('Requested scan was not observed');
        }elseif(in_array($scan['state'],['finished','canceled'],true)&&$scan['kind']==='scrub'){
            // A terminal status alone cannot identify our start. Preserve uncertainty
            // for very fast scans or gaps in observation rather than invent success.
            if(!isset($job['scan_started'])||!zfsmScrubTerminalMatchesStart($scan['text'],$job['scan_started'],$job['scan_timezone']))throw new RuntimeException('Terminal scan identity cannot be matched to the observed start');
            $finished=$scan['state']==='finished';$summary=$finished?'Observed pool scrub finished: '.$scan['errors'].' errors reported, '.$scan['repaired'].' repaired.':'Observed pool scrub was cancelled externally.';
            $changes+=['state'=>$finished?'completed':'cancelled','stage'=>$finished?'completed':'scrub_cancelled','finished_at'=>gmdate('c'),'progress'=>['percent'=>$finished?100:null],'result'=>['summary'=>$summary,'confirmation'=>'native_pool_status','severity'=>$finished&&$scan['errors']>0?'warning':'info']];
        }else throw new RuntimeException('Scan state changed or is unknown');
    }catch(Throwable$error){$changes=['state'=>'recovery_required','stage'=>'observation_lost','finished_at'=>gmdate('c'),'error'=>'Scrub progress could not be attributed safely: '.$error->getMessage().'. Inspect native pool status; Director will not restart, resume or stop the scrub.'];}
    finally{if($had)$GLOBALS['zfsm_inventory_deadline']=$previous;else unset($GLOBALS['zfsm_inventory_deadline']);}
    return zfsmJobUpdate($job['id'],function($live)use($job,$changes){return $live['state']==='running'&&($live['observed_at']??0)===($job['observed_at']??0)?$changes:[];});
}
