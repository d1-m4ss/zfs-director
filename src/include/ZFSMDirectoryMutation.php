<?php
// Directory mutations use pinned descriptors and a full-filesystem boundary.
// Path checks here authorize the request; they are not a TOCTOU fallback.
// JOBS-007: the one retained-restore folder that may be deleted as a whole: the LAST component of the
// path is .zfsm-restore-<id> and no other component is a service name. Returns the job id, or null.
function zfsmRetainedRestoreId($relative) {
    if(!is_string($relative)||$relative==='')return null;
    $parts=explode('/',$relative);$last=array_pop($parts);
    if(!preg_match('/^\.zfsm-restore-([0-9]{8}-[0-9]{6}-[a-f0-9]{12})$/D',$last,$match))return null;
    foreach($parts as$part)if($part===''||$part==='.'||$part==='..'||$part==='.zfs'||str_starts_with($part,'.zfsm-'))return null;
    return $match[1];
}
// Why a retained restore folder must stay: its restore did not finish. Null when it may go.
function zfsmRetainedRestoreBlocker($path) {
    $id=is_string($path)?zfsmRetainedRestoreId(basename($path)):null;
    if($id===null)return null;
    foreach(glob(zfsmJobDirectory($GLOBALS['plugin_state']).'/*.json')?:[]as$file){
        $unreadable='This folder belongs to a restore whose record cannot be read. Inspect it in Jobs first.';
        // The record of this very restore must be readable; a damaged one keeps the only copy of the files.
        try{$job=zfsmReadJob(basename($file,'.json'));if(basename($file,'.json')===$id&&zfsmJobProblem($job))return $unreadable;}catch(Throwable$error){if(basename($file,'.json')===$id)return $unreadable;continue;}
        if(($job['schema']??null)!==2||($job['type']??null)!=='restore')continue;
        if(($job['id']??null)!==$id&&($job['staging']??null)!==$path)continue;
        if(in_array($job['state']??'',['queued','running','recovery_required','failed'],true))return 'This folder belongs to a restore that did not finish. Open that job in Jobs first.';
    }
    return null;
}
function zfsmDirectoryRequest($operation,$source,$options=[]) {
    if (!in_array($operation,['move','claim','delete'],true)) throw new InvalidArgumentException('Invalid directory operation');
    $root=$source['mountpoint']??''; $path=$source['path']??'';
    if (!is_string($root)||$root==='/'||!is_string($path)||!str_starts_with($path,$root.'/')) throw new RuntimeException('Directory is outside its dataset');
    // JOBS-007: a retained restore container (.zfsm-restore-<id>) may be deleted as a whole; every other service directory stays protected.
    $relative=substr($path,strlen($root)+1);
    if(!($operation==='delete'&&zfsmRetainedRestoreId($relative)!==null)&&preg_match('~(?:^|/)\.zfsm-[^/]*(?:/|$)~',$relative))throw new RuntimeException('This service directory contains protected recovery data and cannot be removed with Delete directory. Its journal and any retained objects require separate recovery review.');
    $identity=zfsmDirectoryIdentity($path);
    $reviewed=$GLOBALS['zfsm_directory_reviewed']??null;
    if (is_array($reviewed)&&($reviewed['path']??null)===$path) {
        if (($reviewed['identity']??null)!==$identity) throw new RuntimeException('Directory identity changed since inventory; refresh and review');
        $identity=$reviewed['identity'];
    }
    if (isset($options['identity'])&&$options['identity']!==$identity) throw new RuntimeException('Original directory identity changed');
    $request=['op'=>$operation,'root'=>$root,'root_identity'=>zfsmDirectoryIdentity($root),'path'=>substr($path,strlen($root)+1),'identity'=>$identity];
    foreach (['destination','recursive'] as $key) if (array_key_exists($key,$options)) $request[$key]=$options[$key];
    return $request;
}

function zfsmDirectoryCommand($request) {
    $result=runProcess('/usr/bin/perl',[dirname(__DIR__).'/scripts/zfsm-directory.pl'],json_encode($request,JSON_THROW_ON_ERROR));
    $last=null;
    foreach (preg_split('/\r?\n/',$result['output']??'')?:[] as $line) {
        if (strlen($line)>(($request['op']??'')==='cleanup-inspect'?524288:32768)) continue;
        $row=json_decode($line,true);
        if (is_array($row)) $last=$row;
    }
    if (($result['code']??1)===0&&($last['ok']??false)===true&&($last['op']??'')===($request['op']??'')) return $last;
    $answer=['ok'=>false,'error'=>is_string($last['error']??null)?substr($last['error'],0,4096):'Directory helper did not return a verified result; no unsafe fallback was attempted'];
    if (is_array($last['recovery']??null)) $answer['recovery']=$last['recovery'];
    return $answer;
}

function zfsmDirectoryAnswer($subject,$native) {
    if (($native['ok']??false)===true) return ['succeeded'=>[$subject=>0],'failed'=>[],'directory_recovery'=>$native['recovery']??null];
    $message=$native['error']??'Directory operation failed';
    if (is_string($native['recovery']['source']['location']??null)&&($native['recovery']['container']??'')==='.zfsm-maintenance') $message.='; inspect retained cleanup object: '.$native['recovery']['source']['location'];
    elseif (is_string($native['recovery']['location']??null)) $message.='; retained recovery journal: '.$native['recovery']['location'].'/journal.jsonl';
    return ['succeeded'=>[],'failed'=>[$subject=>$message],'directory_recovery'=>$native['recovery']??null];
}
