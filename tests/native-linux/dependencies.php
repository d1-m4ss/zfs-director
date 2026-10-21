<?php
require __DIR__.'/protection-bootstrap.php';
$name='director_it_1018/dependencies';
if(!zfsmDatasetExists($name))nativeCommand(['create',$name]);
$path=trim(nativeCommand(['get','-H','-o','value','mountpoint',$name]));
if(!zfsmSnapshotExists($name.'@held'))nativeCommand(['snapshot',$name.'@held']);
$holds=runProcess('zfs',['holds','-H',$name.'@held']);if(trim($holds['output'])==='')nativeCommand(['hold','director-test',$name.'@held']);
if(!zfsmDatasetExists('director_it_1018/dependency-clone'))nativeCommand(['clone',$name.'@held','director_it_1018/dependency-clone']);
$properties=['name'=>$name,'guid'=>zfsmReadIdentity($name)['guid'],'type'=>'filesystem','mounted'=>'yes','mountpoint'=>$path];
nativeCheck('native dependency inventory exposes clone and held snapshot',function()use($properties){$r=zfsmReadDependencies($properties,[]);nativeExpect($r['status']==='known','Native dependency read unavailable');nativeExpect(in_array('hold',array_column($r['entries'],'kind'),true),'Held snapshot missing');nativeExpect(in_array('clone',array_column($r['entries'],'kind'),true),'Clone dependency missing');return $r;});
nativeCheck('native busy inspection detects own open file and nested tmpfs mount',function()use($name,$path,$properties){
    $file=fopen($path.'/open.bin','w+');fwrite($file,'fixture');$temp=$path.'/nested';if(!is_dir($temp))mkdir($temp);
    $mount=runProcess('mount',['-t','tmpfs','-o','size=1m','tmpfs',$temp]);nativeExpect($mount['code']===0,'Cannot mount isolated test tmpfs');
    try{$r=zfsmDestroyBusyDiagnostics([['name'=>$name,'guid'=>$properties['guid'],'type'=>'filesystem','mountpoint'=>$path]]);$kinds=array_column($r['blockers'],'kind');nativeExpect(in_array('open_file',$kinds,true),'Own open file missing');nativeExpect(in_array('nested_mount',$kinds,true),'Nested mount missing');return $r;}
    finally{fclose($file);$r=runProcess('umount',[$temp]);nativeExpect($r['code']===0,'Isolated test mount needs manual cleanup');}
});
exit(array_filter($results,fn($r)=>$r['status']!=='PASS')?1:0);
