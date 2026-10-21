<?php
require_once __DIR__.'/ZFSMUsage.php';

function zfsmParsePosixACL($text) {
    if (!is_string($text)||strlen($text)>262144)return null;
    $entries=[];$seen=[];$masks=[];$groups=[];
    foreach(preg_split('/\r\n|\r|\n/',$text) as $line) {
        $line=trim($line);if($line===''||$line[0]==='#')continue;
        if (!preg_match('/^(default:)?(user|group|mask|other):([0-9]*):([r-][w-][x-])(?:\s+#effective:([r-][w-][x-]))?$/D',$line,$match))return null;
        $scope=$match[1]!==''?'default':'access';$tag=$match[2];$id=$match[3];$permissions=$match[4];
        if (($id!==''&&!in_array($tag,['user','group'],true))||strlen($id)>20)return null;
        $key=$scope.':'.$tag.':'.$id;if(isset($seen[$key]))return null;$seen[$key]=true;
        if($tag==='mask')$masks[$scope]=$permissions;
        $groups[$scope]=true;
        $entries[]=['scope'=>$scope,'tag'=>$tag,'id'=>$id===''?null:$id,'permissions'=>$permissions,'effective'=>$permissions,'masked'=>false,'reported_effective'=>$match[5]??null];
        if(count($entries)>1024)return null;
    }
    if(!isset($groups['access']))return null;
    foreach(array_keys($groups) as $scope)foreach(['user','group','other'] as $tag)if(!isset($seen[$scope.':'.$tag.':']))return null;
    foreach($entries as &$entry) {
        $subjectToMask=$entry['tag']==='group'||($entry['tag']==='user'&&$entry['id']!==null);
        if($entry['id']!==null&&!isset($masks[$entry['scope']]))return null;
        if($subjectToMask&&isset($masks[$entry['scope']])) {
            $mask=$masks[$entry['scope']];$effective='';
            for($i=0;$i<3;$i++)$effective.=$entry['permissions'][$i]!=='-'&&$mask[$i]!=='-'?$entry['permissions'][$i]:'-';
            $entry['effective']=$effective;$entry['masked']=$effective!==$entry['permissions'];
        }
        if($entry['reported_effective']!==null&&$entry['reported_effective']!==$entry['effective'])return null;
        unset($entry['reported_effective']);
    }
    unset($entry);
    return $entries;
}

function zfsmReadDatasetACL($properties, $overrides = []) {
    $io=zfsmUsageIO($overrides);
    $result=['status'=>'unknown','type'=>$properties['acltype']??'unknown','entries'=>null,'extended'=>null,'has_default'=>null,'reason'=>'ACL requires the current identity of a verified mounted ZFS filesystem'];
    if(($properties['type']??'')==='volume')return array_replace($result,['status'=>'unavailable','reason'=>'Filesystem ACL entries are not applicable to ZFS volumes']);
    try {
        if(!zfsmUsageHasTime($io))return array_replace($result,['reason'=>'Read-only ACL metadata time budget is exhausted']);
        if(!zfsmUsageVerifyDataset($properties,$io))return $result;
        if(!in_array($properties['acltype']??'', ['posix','posixacl'],true))return array_replace($result,['status'=>'unavailable','reason'=>'Detailed entries require POSIX ACL support; this ACL type is unsupported']);
        $tool=($io['tool'])('getfacl');if(!$tool)return array_replace($result,['status'=>'unavailable','reason'=>'Trusted getfacl executable is unavailable']);
        $answer=($io['process'])($tool,['--absolute-names','--numeric','--omit-header','--',$properties['mountpoint']]);
        if(($answer['code']??-1)!==0)return array_replace($result,['status'=>'error','reason'=>'ACL read failed or exceeded its read limit']);
        $entries=zfsmParsePosixACL($answer['output']??'');
        if($entries===null)return array_replace($result,['status'=>'error','reason'=>'ACL output is unsupported, incomplete or malformed']);
        if(!zfsmUsageVerifyDataset($properties,$io))return $result;
        $extended=false;$hasDefault=false;
        foreach($entries as $entry){if($entry['scope']==='default')$hasDefault=true;if($entry['id']!==null||$entry['tag']==='mask')$extended=true;}
        return array_replace($result,['status'=>'known','entries'=>$entries,'extended'=>$extended,'has_default'=>$hasDefault,'reason'=>'']);
    } catch(Throwable $error){return array_replace($result,['status'=>'error','reason'=>'Read-only ACL metadata could not be verified']);}
}
