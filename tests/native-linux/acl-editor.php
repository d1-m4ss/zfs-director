<?php
// Native test copy aliases only the descriptor transport for a one-read fault.
// Real getfacl/setfacl and filesystem effects still execute in every call.
function zfsmACLDescriptorProcess($tool,$args,$handle,$input=null){
    $r=zfsmACLDescriptorProcessActual($tool,$args,$handle,$input);
    if(basename($tool)==='setfacl'&&!in_array('--test',$args,true))$GLOBALS['acl_test_writes']=($GLOBALS['acl_test_writes']??0)+1;
    if(($GLOBALS['acl_test_fault']??false)&&basename($tool)==='getfacl'&&($GLOBALS['acl_test_writes']??0)===1&&empty($GLOBALS['acl_test_fault_used'])){$GLOBALS['acl_test_fault_used']=true;return ['code'=>1,'output'=>''];}
    return $r;
}
require __DIR__.'/protection-bootstrap.php';
$name='director_it_1018/acl-editor';nativeCommand(['create','-o','acltype=posix',$name]);$path=trim(nativeCommand(['get','-H','-o','value','mountpoint',$name]));file_put_contents($path.'/existing.txt','must survive');
nativeCheck('native pinned POSIX ACL preview commit masks and nonrecursive scope',function()use($name,$path){$text="user::rwx\nuser:99:rwx\ngroup::r-x\nmask::r-x\nother::---\ndefault:user::rwx\ndefault:group::r-x\ndefault:other::---\n";$before=hash_file('sha256',$path.'/existing.txt');$info=zfsmACLEditorInfo($name);nativeExpect($info['editable']===true,json_encode($info));$p=zfsmACLPreview($name,$text,'acl-native');$r=zfsmCommitACL($p+['zdataset'=>$name,'acl'=>$text],'acl-native');nativeExpect(!$r['failed'],json_encode($r));$after=zfsmACLEditorInfo($name);nativeExpect($after['acl']===zfsmACLCanonical($text),'ACL readback mismatch');nativeExpect(hash_file('sha256',$path.'/existing.txt')===$before,'Existing child content changed');return ['answer'=>$r,'acl'=>$after['acl'],'existing_child_unchanged'=>true];});
nativeCheck('native postwrite read failure rolls the exact previous ACL back',function()use($name){$before=zfsmACLEditorInfo($name)['acl'];$text="user::rwx\ngroup::---\nother::---\n";$p=zfsmACLPreview($name,$text,'acl-native');$GLOBALS['acl_test_writes']=0;$GLOBALS['acl_test_fault']=true;$GLOBALS['acl_test_fault_used']=false;$r=zfsmCommitACL($p+['zdataset'=>$name,'acl'=>$text],'acl-native');$GLOBALS['acl_test_fault']=false;nativeExpect(($r['rollback_verified']??false)===true,json_encode($r));nativeExpect(zfsmACLEditorInfo($name)['acl']===$before,'Previous ACL not restored');return $r;});
nativeCheck('native writable parent disables editor without chmod fallback',function()use($name,$path){$child=$name.'/child';nativeCommand(['create',$child]);chmod($path,0777);try{$r=zfsmACLEditorInfo($child);nativeExpect($r['editable']===false&&str_contains($r['reason'],'ancestors'),json_encode($r));return $r;}finally{chmod($path,0755);}});
exit(array_filter($results,fn($r)=>$r['status']!=='PASS')?1:0);
