<?php
/* Branding renamed to ZFS Director on 2026-10-16; GPL-2.0-or-later. */
/** Authenticated, read-only snapshot access and signed restore previews. */
function zfsmExplorerPath($path) {
    if (!is_string($path) || strlen($path)>4096 || str_contains($path,"\0") || str_starts_with($path,'/') || !preg_match('//u',$path)) throw new InvalidArgumentException('Invalid relative path');
    if ($path==='') return $path;
    $parts=explode('/',$path);
    if (count($parts)>128) throw new InvalidArgumentException('Path is too deep');
    foreach ($parts as $part) if (in_array($part,['','.','..','.zfs'],true) || preg_match('/^\.zfsm-(restore|archive)-/',$part)) throw new InvalidArgumentException('Invalid relative path');
    return $path;
}
function zfsmExplorerFlag($value) {
    if (in_array($value,[true,1,'1'],true)) return true;
    if (in_array($value,[false,0,'0'],true)) return false;
    throw new InvalidArgumentException('Invalid file visibility choice');
}
function zfsmExplorerGuid($name) {
    $r=runProcess('zfs',['get','-H','-p','-o','value','guid',$name]);
    if ($r['code']!==0 || !preg_match('/^[1-9][0-9]*$/D',$r['output'])) throw new RuntimeException('Snapshot or dataset is no longer available');
    return $r['output'];
}
function zfsmExplorerContext($snapshot,$expected_guid='') {
    if (!zfsmValidSnapshotName($snapshot)) throw new InvalidArgumentException('Invalid snapshot');
    [$dataset,$short]=explode('@',$snapshot,2);
    $guid=zfsmExplorerGuid($snapshot);
    if($expected_guid!==''&&(!is_string($expected_guid)||!hash_equals($guid,$expected_guid)))throw new RuntimeException('Snapshot was replaced; reopen it before accessing files');
    $r=runProcess('zfs',['get','-H','-p','-o','property,value','type,mountpoint,mounted,guid,readonly',$dataset]);
    if ($r['code']!==0) throw new RuntimeException('Unable to read dataset properties');
    $props=[]; foreach(explode("\n",$r['output']) as $line) { $parts=explode("\t",$line,2); if(count($parts)===2)$props[$parts[0]]=$parts[1]; }
    if (($props['type']??'')!=='filesystem' || ($props['mounted']??'')!=='yes') throw new RuntimeException('File browsing requires a mounted, unlocked filesystem dataset');
    $mount=$props['mountpoint']??'';
    if (!str_starts_with($mount,'/') || $mount==='/' || zfsmPathHasSymlink($mount) || !zfsmLiveZfsMount($mount,$dataset,zfsmMountInfo())) throw new RuntimeException('Dataset mount identity could not be verified');
    if (!preg_match('/^[1-9][0-9]*$/D',$props['guid']??'')) throw new RuntimeException('Dataset identity is unavailable');
    $root=rtrim($mount,'/').'/.zfs/snapshot/'.$short;
    // Accessing this directory uses ZFS's read-only snapshot mount; no clone,
    // snapdir setting change or writable mount is made.
    if (!is_dir($root) || zfsmPathHasSymlink($root)) throw new RuntimeException('Snapshot files are unavailable; check that the dataset is unlocked and mounted');
    $directory=@opendir($root);if(!$directory)throw new RuntimeException('Snapshot directory could not be opened');closedir($directory);clearstatcache(true,$root);
    $context=['snapshot'=>$snapshot,'snapshot_guid'=>$guid,'dataset'=>$dataset,'dataset_guid'=>$props['guid'],'source'=>$root,'source_identity'=>zfsmDirectoryIdentity($root),'destination'=>$mount,'destination_identity'=>zfsmDirectoryIdentity($mount),'readonly'=>$props['readonly']??'on'];
    if (zfsmExplorerGuid($snapshot)!==$guid || zfsmExplorerGuid($dataset)!==$props['guid']) throw new RuntimeException('Snapshot identity changed; reopen the snapshot');
    return $context;
}
function zfsmExplorerHelper() { return dirname(__DIR__).'/scripts/zfsm-files.pl'; }
function zfsmExplorerError($text,$fallback='File operation failed') {
    $lines=preg_split('/\r?\n/',trim($text));
    foreach(array_reverse($lines) as $line) { $j=json_decode($line,true); if (is_array($j)&&is_string($j['error']??null)) return zfsmExplorerShortText($j['error'],1500); }
    return $fallback;
}
// Byte truncation with UTF-8 repair happens in the JSON response encoder.
function zfsmExplorerShortText($text,$limit) { return function_exists('mb_substr')?mb_substr($text,0,$limit,'UTF-8'):substr($text,0,$limit); }
function zfsmExplorerOpen($args) {
    $input=json_encode($args,JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR);
    $pipes=[];
    $p=@proc_open(['/usr/bin/perl',zfsmExplorerHelper()],[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes,null,null,['bypass_shell'=>true]);
    if (!is_resource($p)) throw new RuntimeException('Unable to start Snapshot Explorer');
    try {
        $prefetched=zfsmProcessInput($p,$pipes,$input,microtime(true)+120);
        fclose($pipes[0]);unset($pipes[0]);
        stream_set_blocking($pipes[1],true);stream_set_blocking($pipes[2],true);
        return [$p,$pipes,$prefetched];
    } catch(Throwable $error) {
        zfsmAbortProcess($p,$pipes);
        throw new RuntimeException('Unable to send file request');
    }
}

function zfsmExplorerCall($args) {
    [$p,$pipes,$prefetched]=zfsmExplorerOpen($args); $out=$prefetched[1];$err=$prefetched[2];$deadline=microtime(true)+120;$exit=null;
    stream_set_blocking($pipes[1],false);stream_set_blocking($pipes[2],false);
    try {
        do {
            $out.=stream_get_contents($pipes[1]);$err.=stream_get_contents($pipes[2]);
            if(strlen($out)>64*1024*1024 || strlen($err)>65536)throw new RuntimeException('File request exceeds the supported size; select a smaller folder');
            if(microtime(true)>$deadline)throw new RuntimeException('File request timed out; select a smaller folder');
            $status=proc_get_status($p); if(!$status['running']){$exit=$status['exitcode'];$out.=stream_get_contents($pipes[1]);$err.=stream_get_contents($pipes[2]);break;} usleep(10000);
        }while(true);
        if($exit!==0)throw new RuntimeException(zfsmExplorerError($err));
        $answer=json_decode($out,true,160,JSON_THROW_ON_ERROR); if(!is_array($answer))throw new RuntimeException('Invalid file response');return $answer;
    } finally {if($exit===null)zfsmAbortProcess($p,$pipes);else{fclose($pipes[1]);fclose($pipes[2]);proc_close($p);}}
}
function zfsmExplorerList($snapshot,$path,$filter,$sort,$direction,$offset,$hidden,$expected_guid='',$kind='all') {
    if(!in_array($kind,['all','file','directory'],true))throw new InvalidArgumentException('Invalid file type filter');
    $ctx=zfsmExplorerContext($snapshot,$expected_guid);$path=zfsmExplorerPath($path);
    if(!is_string($filter)||strlen($filter)>1024||!in_array($sort,['name','size','mtime'],true)||!in_array($direction,['asc','desc'],true)||!preg_match('/^[0-9]{1,6}$/D',(string)$offset))throw new InvalidArgumentException('Invalid browsing options');
    $answer=zfsmExplorerCall($ctx+['op'=>'list','path'=>$path,'filter'=>$filter,'sort'=>$sort,'direction'=>$direction,'offset'=>(int)$offset,'hidden'=>zfsmExplorerFlag($hidden),'kind'=>$kind]);
    return $answer+['snapshot'=>$snapshot,'snapshot_guid'=>$ctx['snapshot_guid'],'path'=>$path,'read_only'=>true,'restore_available'=>$ctx['readonly']==='off'];
}
function zfsmExplorerDownload($snapshot,$path,$expected_guid) {
    if($expected_guid==='')throw new InvalidArgumentException('Reopen the snapshot before downloading');
    $ctx=zfsmExplorerContext($snapshot,$expected_guid);$path=zfsmExplorerPath($path);
    zfsmStreamDownload($ctx+['op'=>'download','path'=>$path],basename($path),'application/octet-stream');
}
function zfsmStreamDownload($request,$filename,$type) {
    $p=null;$pipes=[];$headers_started=false;$previous_abort=ignore_user_abort(true);
    try {
        [$p,$pipes,$prefetched]=zfsmExplorerOpen($request);
        stream_set_timeout($pipes[1],30);
        $buffer=$prefetched[1];
        while(!str_contains($buffer,"\n") && strlen($buffer)<4095){$part=fgets($pipes[1],4096-strlen($buffer));if($part===false||$part==='')break;$buffer.=$part;}
        $at=strpos($buffer,"\n");if($at===false||$at>=4096)throw new RuntimeException('Invalid download response');$head=substr($buffer,0,$at);$buffer=substr($buffer,$at+1);$ready=json_decode($head,true);
        if(!is_array($ready)||($ready['ready']??false)!==true||!is_int($ready['size']??null)||$ready['size']<0)throw new RuntimeException('File cannot be downloaded; refresh the snapshot and try again');
        zfsmRequestJobStage('transferring');zfsmRequestJobProgress(0,$ready['size']);
        while(ob_get_level())ob_end_clean();
        header('Content-Type: '.$type);header('X-Content-Type-Options: nosniff');header('Cache-Control: no-store');header('Content-Length: '.$ready['size']);
        header("Content-Disposition: attachment; filename=\"snapshot-download".($type==='application/zip'?'.zip':'')."\"; filename*=UTF-8''".rawurlencode($filename));
        $headers_started=true;$left=$ready['size'];
        if($buffer!==''){$bytes=substr($buffer,0,$left);echo $bytes;$left-=strlen($bytes);flush();zfsmRequestJobProgress($ready['size']-$left,$ready['size']);}
        while($left>0&&!connection_aborted()){$bytes=fread($pipes[1],min(1048576,$left));if($bytes===false||$bytes==='')break;echo $bytes;$left-=strlen($bytes);flush();zfsmRequestJobProgress($ready['size']-$left,$ready['size']);}
        $aborted=connection_aborted();$complete=$left===0&&!$aborted;
        zfsmRequestJobFinish($complete?'completed':($aborted?'cancelled':'failed'),$complete?'Server transfer finished. Check browser Downloads to confirm the file was saved.':($aborted?'The browser disconnected; the server transfer was interrupted.':'The file stream ended before all bytes were sent. Request a fresh download.'),$complete?'completed':'interrupted',['confirmation'=>'server_stream_only']);
        if(!$complete)error_log('ZFS Director: snapshot download was interrupted');
    } catch(Throwable$error) {
        if(!$headers_started)throw $error;
        // Never append a JSON error to an attachment body already in flight.
        try{zfsmRequestJobFinish('failed','Server transfer failed. Inspect Jobs and request a fresh download.','interrupted',['confirmation'=>'server_stream_only']);}catch(Throwable$journal_error){error_log('ZFS Director: interrupted download journal requires inspection');}
        error_log('ZFS Director: snapshot download was interrupted');
    } finally {if(is_resource($p))zfsmAbortProcess($p,$pipes);ignore_user_abort($previous_abort);}
}
function zfsmRestoreSignature($document,$secret) {
    if(!is_string($secret)||$secret==='')throw new RuntimeException('Preview signing key unavailable');
    return hash_hmac('sha256',json_encode($document,JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR),$secret);
}
function zfsmRestorePreviewFile($id) { return zfsmJobDirectory($GLOBALS['plugin_runtime'].'/restore-previews').'/'.zfsmJobId($id).'.json'; }
function zfsmPreviewRestore($snapshot,$selection,$target,$mode,$secret,$expected_guid='') {
    $ctx=zfsmExplorerContext($snapshot,$expected_guid); if($ctx['readonly']!=='off')throw new RuntimeException('The current dataset is read-only');
    if(!is_array($selection)||!$selection||count($selection)>1000)throw new InvalidArgumentException('Select between 1 and 1000 files or folders');
    foreach($selection as $path)zfsmExplorerPath($path);
    zfsmExplorerPath($target);if(!in_array($mode,['new','overwrite'],true))throw new InvalidArgumentException('Invalid restore mode');
    $plan=zfsmExplorerCall($ctx+['op'=>'plan','selection'=>array_values($selection),'target'=>$target,'mode'=>$mode]);
    if(count($plan['conflicts']??[])>1000)throw new RuntimeException('More than 1000 conflicts; restore smaller batches so every replacement can be reviewed');
    $id=gmdate('Ymd-His').'-'.bin2hex(random_bytes(6));
    $document=['id'=>$id,'expires'=>time()+600,'context'=>$ctx,'plan'=>$plan];zfsmJobAtomicWrite(zfsmRestorePreviewFile($id),$document);
    // Expired previews are private temporary metadata, never snapshot files.
    foreach(glob(dirname(zfsmRestorePreviewFile($id)).'/*.json')?:[] as $file)if(!is_link($file)&&filemtime($file)<time()-3600)@unlink($file);
    return ['id'=>$id,'token'=>zfsmRestoreSignature($document,$secret),'expires'=>$document['expires'],'files'=>$plan['files'],'bytes'=>$plan['bytes'],'entries'=>count($plan['entries']),'conflicts'=>$plan['conflicts'],'target'=>$ctx['destination'].($target===''?'':'/'.$target),'mode'=>$mode,'selection'=>$plan['selection']];
}
