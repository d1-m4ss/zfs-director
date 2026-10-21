<?php
require '/app/harness.php';
function readonlyFixture($security=null,$securityCode=0,$acl=null,$aclCode=0,$changes=[]) {
    $values=array_fill_keys(zfsmDatasetColumns(),'0');
    $values=array_replace($values,['name'=>'cache/secure/child','type'=>'filesystem','encryption'=>'aes-256-gcm','encryptionroot'=>'cache/secure','keyformat'=>'passphrase','keystatus'=>'available','mounted'=>'no','guid'=>'99','mountpoint'=>'/mnt/cache/secure/child','compression'=>'lz4','compressratio'=>'1.00x','atime'=>'off','xattr'=>'sa','primarycache'=>'all','readonly'=>'off','casesensitivity'=>'sensitive','sync'=>'standard','origin'=>'-','dedup'=>'off'],$changes);$name=$values['name'];
    expectProcess('zfs',['list','-H','-o','name','-t','filesystem,volume',$name],$name);
    expectProcess('zfs',['list','-H','-p','-o',implode(',',zfsmDatasetColumns()),$name],implode("\t",array_map(fn($key)=>$values[$key],zfsmDatasetColumns())));
    expectProcess('zfs',['get','-H','-p','-o','property,value,source',implode(',',zfsmAllowedDatasetProperties()),$name],"compression\tlz4\tinherited from cache");
    $securityFields='encryption,encryptionroot,keyformat,keystatus'.($values['type']==='filesystem'?',mounted':'');
    $securityOutput="encryption\taes-256-gcm\tinherited from cache/secure\nencryptionroot\tcache/secure\t-\nkeyformat\tpassphrase\treceived\nkeystatus\tavailable\t-".($values['type']==='filesystem'?"\nmounted\tno\ttemporary":'');
    expectProcess('zfs',['get','-H','-p','-o','property,value,source',$securityFields,$name],$security??$securityOutput,$securityCode);
    if($values['type']==='filesystem')expectProcess('zfs',['get','-H','-p','-o','property,value,source','acltype,aclmode,aclinherit',$name],$acl??"acltype\tposix\tlocal\naclmode\tpassthrough\tdefault\naclinherit\trestricted\tinherited from cache",$aclCode);
    return getAllDatasetProperties($name,0);
}
check('readonly metadata retains reported native encryption and ACL property sources',function(){
    $properties=readonlyFixture();same('inherited from cache/secure',$properties['_sources']['encryption']??null);same('-',$properties['_sources']['encryptionroot']??null);same('received',$properties['_sources']['keyformat']??null);same('temporary',$properties['_sources']['mounted']??null);
    same('posix',$properties['acltype']??null);same('local',$properties['_sources']['acltype']??null);same('passthrough',$properties['aclmode']??null);same('restricted',$properties['aclinherit']??null);same('unknown',$properties['_permissions']['acl_state']);
    foreach(['encryption','encryptionroot','keyformat','keystatus','mounted','acltype','aclmode','aclinherit']as$key)same(false,in_array($key,zfsmAllowedDatasetProperties(),true));
});
check('unsupported ACL probe preserves encryption evidence and leaves ACL state unknown',function(){
    $properties=readonlyFixture(null,0,'unsupported property',1);same('received',$properties['_sources']['keyformat']??null);same(false,isset($properties['acltype']));same(false,isset($properties['_sources']['acltype']));same('unknown',$properties['_permissions']['acl_state']);
});
check('unavailable readonly probes preserve inventory values without inventing sources',function(){
    $properties=readonlyFixture('security unavailable',1,'acl unavailable',1);same('aes-256-gcm',$properties['encryption']);same(['compression'=>'inherited from cache'],$properties['_sources']);same(false,isset($properties['acltype']));
});
foreach(['unknown property','duplicate property','invalid source','foreign inherited source','changed value','truncated']as$case)check('uncertain readonly source evidence is omitted '.$case,function()use($case){
    $security=match($case){'unknown property'=>"privatekey\tsecret\tlocal",'duplicate property'=>"encryption\taes-256-gcm\tlocal\nencryption\taes-256-gcm\treceived",'invalid source'=>"encryption\taes-256-gcm\tunknown source",'foreign inherited source'=>"encryption\taes-256-gcm\tinherited from other",'changed value'=>"encryption\toff\tlocal",'truncated'=>"encryption\taes-256-gcm"};
    $properties=readonlyFixture($security,0,'unsupported',1);same(['compression'=>'inherited from cache'],$properties['_sources']);same('aes-256-gcm',$properties['encryption']);same(false,isset($properties['privatekey']));
});
check('invalid ACL property values do not become reported security metadata',function(){
    $properties=readonlyFixture(null,0,"acltype\tinvented\tlocal\naclmode\tpassthrough\tlocal\naclinherit\trestricted\tlocal");same(false,isset($properties['acltype']));same(false,isset($properties['_sources']['acltype']));
});
check('volume metadata never probes or invents filesystem ACLs',function(){
    $properties=readonlyFixture(null,0,null,0,['type'=>'volume','mounted'=>'-']);same('received',$properties['_sources']['keyformat']??null);same(false,isset($properties['acltype']));
});
finishTests();
