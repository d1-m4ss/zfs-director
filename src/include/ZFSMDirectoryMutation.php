<?php
// Directory mutations use pinned descriptors and a full-filesystem boundary.
// Path checks here authorize the request; they are not a TOCTOU fallback.
function zfsmDirectoryRequest($operation,$source,$options=[]) {
    if (!in_array($operation,['move','claim','delete'],true)) throw new InvalidArgumentException('Invalid directory operation');
    $root=$source['mountpoint']??''; $path=$source['path']??'';
    if (!is_string($root)||$root==='/'||!is_string($path)||!str_starts_with($path,$root.'/')) throw new RuntimeException('Directory is outside its dataset');
    if(preg_match('~(?:^|/)\.zfsm-[^/]*(?:/|$)~',substr($path,strlen($root)+1)))throw new RuntimeException('This service directory contains protected recovery data and cannot be removed with Delete directory. Its journal and any retained objects require separate recovery review.');
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
