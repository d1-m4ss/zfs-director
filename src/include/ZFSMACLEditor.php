<?php
function zfsmACLCanonical($text,$native=false) {
    if(!is_string($text)||strlen($text)>16384||(!$native&&str_contains($text,'#')))throw new InvalidArgumentException('ACL must contain only explicit numeric POSIX entries, at most 16 KiB.');
    $entries=zfsmParsePosixACL($text);if($entries===null||count($entries)>128)throw new InvalidArgumentException('ACL is incomplete or unsupported; named entries require an explicit mask.');
    $lines=[];foreach($entries as $entry){if($entry['id']!==null&&zfsmRollbackDecimalCompare($entry['id'],'4294967294')>0)throw new InvalidArgumentException('POSIX ID exceeds the supported range');$lines[]=($entry['scope']==='default'?'default:':'').$entry['tag'].':'.($entry['id']??'').':'.$entry['permissions'];}sort($lines,SORT_STRING);return implode("\n",$lines)."\n";
}
function zfsmACLEditIssue($properties,$parents,$mode,$tools) {
    if(($properties['type']??'')!=='filesystem'||($properties['mounted']??'')!=='yes'||($properties['keystatus']??'')==='unavailable')return 'ACL editing requires a verified mounted filesystem.';
    if(!in_array($properties['acltype']??'',['posix','posixacl'],true))return 'Only native POSIX ACLs are supported by this editor.';
    if(!$parents)return 'ACL editor is unavailable under writable or untrusted ancestors. Their permissions will not be changed automatically.';
    if(($mode&07000)!==0)return 'Special permission bits require native administration; automatic ACL editing is disabled.';
    if(!$tools)return 'Verified native getfacl/setfacl and Linux descriptor support are required.';
    return null;
}
function zfsmACLDescriptorProcess($tool,$args,$handle,$input=null) {
    $pipes=[];$proc=@proc_open(array_merge([$tool],$args),[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w'],3=>$handle],$pipes,null,null,['bypass_shell'=>true]);if(!is_resource($proc))throw new RuntimeException('Cannot start native ACL command');
    $output='';$size=0;$code=-1;$deadline=microtime(true)+4;
    try{
        if($input!==null&&fwrite($pipes[0],$input)!==strlen($input))throw new RuntimeException('ACL input could not be delivered');fclose($pipes[0]);unset($pipes[0]);foreach([1,2] as $i)stream_set_blocking($pipes[$i],false);
        while(true){foreach([1,2] as $i){$chunk=fread($pipes[$i],65536);if($chunk===false)throw new RuntimeException('ACL command read failed');$size+=strlen($chunk);if($size>262144)throw new RuntimeException('ACL command exceeded output limit');if($i===1)$output.=$chunk;}$state=proc_get_status($proc);if(!$state['running']){$code=$state['exitcode'];break;}if(microtime(true)>$deadline)throw new RuntimeException('ACL command exceeded time limit');usleep(10000);}
        foreach([1,2] as $i){$chunk=stream_get_contents($pipes[$i],262145-$size);$size+=strlen($chunk);if($size>262144)throw new RuntimeException('ACL output exceeded limit');if($i===1)$output.=$chunk;}
    }catch(Throwable $error){@proc_terminate($proc,9);throw $error;}
    finally{foreach($pipes as $pipe)if(is_resource($pipe))fclose($pipe);$closed=proc_close($proc);if($code<0)$code=$closed;}
    return ['code'=>$code,'output'=>$output];
}
function zfsmACLContext($name) {
    $identity=zfsmReadIdentity($name);if($identity['type']!=='filesystem')throw new RuntimeException('ACL editing is unavailable for zvols.');
    $columns=['name','guid','type','mounted','mountpoint'];$r=runProcess('zfs',['list','-H','-p','-o',implode(',',$columns),$name]);$p=explode("\t",rtrim($r['output'],"\r\n"));if($r['code']!==0||count($p)!==count($columns))throw new RuntimeException('ACL filesystem inventory unavailable');$properties=array_combine($columns,$p);
    if($properties['name']!==$name||$properties['guid']!==$identity['guid'])throw new RuntimeException('ACL dataset identity changed');
    $r=runProcess('zfs',['get','-H','-o','value','acltype',$name]);$properties['acltype']=$r['code']===0?trim($r['output']):'unknown';$path=$properties['mountpoint'];$stat=@lstat($path);$get=zfsmUsageTool('getfacl');$set=zfsmUsageTool('setfacl');
    $issue=zfsmACLEditIssue($properties,zfsmDirectoryParentsTrusted($path),$stat['mode']??0,$get&&$set&&is_dir('/proc/self/fd'));
    if($issue!==null)throw new RuntimeException($issue);
    if(!zfsmUsageVerifyDataset($properties,zfsmUsageIO()))throw new RuntimeException('ACL target is not a verified live ZFS mount.');
    $handle=@fopen($path,'r');if(!is_resource($handle))throw new RuntimeException('Cannot pin ACL mountpoint');
    try{$opened=fstat($handle);if(!$opened||($opened['mode']&0170000)!==0040000||$opened['dev']!==$stat['dev']||$opened['ino']!==$stat['ino'])throw new RuntimeException('ACL mountpoint identity changed');
        $r=zfsmACLDescriptorProcess($get,['--numeric','--omit-header','--','/proc/self/fd/3'],$handle);if($r['code']!==0)throw new RuntimeException('Pinned ACL read failed');$previous=zfsmACLCanonical($r['output'],true);
        return ['handle'=>$handle,'get'=>$get,'set'=>$set,'scope'=>['kind'=>'acl','name'=>$name,'guid'=>$identity['guid'],'path'=>$path,'identity'=>['dev'=>(string)$stat['dev'],'ino'=>(string)$stat['ino']],'uid'=>(string)$stat['uid'],'gid'=>(string)$stat['gid'],'previous'=>$previous,'can_proceed'=>true]];
    }catch(Throwable $error){fclose($handle);throw $error;}
}
function zfsmACLEditorInfo($name) {
    try{$context=zfsmACLContext($name);fclose($context['handle']);return ['editable'=>true,'acl'=>$context['scope']['previous'],'scope'=>'Only this filesystem mountpoint directory. No recursive chmod/chown.'];}
    catch(Throwable $error){return ['editable'=>false,'reason'=>$error->getMessage()];}
}
function zfsmACLPreview($name,$text,$secret) {
    $desired=zfsmACLCanonical($text);$context=zfsmACLContext($name);
    try{$r=zfsmACLDescriptorProcess($context['set'],['--test','--no-mask','--set-file=-','--','/proc/self/fd/3'],$context['handle'],$desired);if($r['code']!==0)throw new RuntimeException('Native setfacl does not support this reviewed ACL.');return zfsmOperationPreview($context['scope']+['desired'=>$desired,'entries'=>zfsmParsePosixACL($desired),'warning'=>'Changes only the selected mountpoint ACL. Default entries affect inheritance of newly created children; existing children are unchanged.'],$secret);}
    finally{fclose($context['handle']);}
}
function zfsmCommitACL($request,$secret) {
    $desired=zfsmACLCanonical($request['acl']??'');$context=zfsmACLContext($request['zdataset']??'');$scope=$context['scope']+['desired'=>$desired,'entries'=>zfsmParsePosixACL($desired),'warning'=>'Changes only the selected mountpoint ACL. Default entries affect inheritance of newly created children; existing children are unchanged.'];
    try{
        zfsmOperationConsume($request,$secret,$scope);$backup=zfsmJobDirectory(dirname($GLOBALS['plugin_config']).'/acl-backups').'/'.$scope['guid'].'-'.bin2hex(random_bytes(8)).'.json';zfsmJobAtomicWrite($backup,$scope);
        $verified=false;$rollback=false;
        try{$r=zfsmACLDescriptorProcess($context['set'],['--no-mask','--set-file=-','--','/proc/self/fd/3'],$context['handle'],$desired);if($r['code']!==0)throw new RuntimeException('Native ACL write failed');$r=zfsmACLDescriptorProcess($context['get'],['--numeric','--omit-header','--','/proc/self/fd/3'],$context['handle']);if($r['code']!==0||zfsmACLCanonical($r['output'],true)!==$desired)throw new RuntimeException('Native ACL readback differs');zfsmRequireIdentity($scope['name'],$scope['guid']);$stat=fstat($context['handle']);if((string)$stat['uid']!==$scope['uid']||(string)$stat['gid']!==$scope['gid'])throw new RuntimeException('Ownership changed during ACL write');$verified=true;}
        catch(Throwable $error){try{$r=zfsmACLDescriptorProcess($context['set'],['--no-mask','--set-file=-','--','/proc/self/fd/3'],$context['handle'],$scope['previous']);$read=zfsmACLDescriptorProcess($context['get'],['--numeric','--omit-header','--','/proc/self/fd/3'],$context['handle']);$rollback=$r['code']===0&&$read['code']===0&&zfsmACLCanonical($read['output'],true)===$scope['previous'];}catch(Throwable $rollbackError){$rollback=false;}}
        return $verified?['succeeded'=>[$scope['name']=>'POSIX ACL applied to pinned mountpoint and readback verified'],'failed'=>[],'acl_backup'=>$backup]:['succeeded'=>[],'failed'=>[$scope['name']=>'ACL result was not verified; '.($rollback?'previous ACL restored and verified.':'rollback unverified; inspect the retained backup before further changes.')],'acl_backup'=>$backup,'rollback_verified'=>$rollback];
    }finally{fclose($context['handle']);}
}
