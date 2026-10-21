<?php
require __DIR__.'/protection-bootstrap.php';
// Dedicated file-backed test pool only; no production paths or service config writes.
$pool=runProcess('zpool',['status','-P','director_it_1018']);
nativeExpect($pool['code']===0&&str_contains($pool['output'],'/var/lib/zfs-director-native-20261018/'),'Unexpected native test pool backing');
$name='director_it_1018/delete-export-'.gmdate('His').'-'.getmypid();
nativeCommand(['create',$name]);
$path=trim(nativeCommand(['get','-H','-o','value','mountpoint',$name]));
$target=$path.'/SampleProject_zfsm_recovery_test';$sibling=$path.'/retained';mkdir($target);mkdir($sibling);file_put_contents($target.'/remove.txt','synthetic disposable fixture');file_put_contents($sibling.'/keep.txt','preserve');
$props=['name'=>$name,'guid'=>zfsmReadIdentity($name)['guid'],'type'=>'filesystem','mounted'=>'yes','mountpoint'=>$path];
$io=['read'=>function($file)use($path){if($file==='/etc/samba/smb-shares.conf')return ['status'=>'known','content'=>"[fixture]\npath = $path\n"];if($file==='/etc/exports')return ['status'=>'known','content'=>"$path *(rw)\n"];return zfsmUsageReadFile($file);}];
nativeCheck('real ZFS ownership and synthetic share configuration permit ordinary child deletion',function()use($props,$io,$target,$path,$sibling){
 $usage=zfsmReadDatasetUsage($props,$io);nativeExpect($usage['smb']['status']==='known'&&count($usage['smb']['entries'])===1,'SMB config fixture not detected');nativeExpect($usage['nfs']['status']==='known'&&count($usage['nfs']['entries'])===1,'NFS config fixture not detected');
 $report=zfsmReadDependencies($props,$usage);nativeExpect($report['status']==='known','Real ZFS dependency inventory unavailable');
 nativeExpect(!zfsmDependencyBlocks($report,'deletedirectory',$target),'Ancestor export still blocks child');
 nativeExpect(zfsmDependencyBlocks($report,'deletedirectory',$path),'Export root unprotected');
 $nested=$report;$nested['services'][]=['service'=>'smb','path'=>$target.'/remove.txt'];nativeExpect(zfsmDependencyBlocks($nested,'deletedirectory',$target),'Nested export unprotected');
 $busy=$report;$busy['services'][]=['service'=>'docker','path'=>$path];nativeExpect(zfsmDependencyBlocks($busy,'deletedirectory',$target),'Docker ancestor unprotected');
 $mounts=$report;$mounts['entries'][]=['kind'=>'nested_mount','path'=>$target.'/mount'];nativeExpect(zfsmDependencyBlocks($mounts,'deletedirectory',$target),'Nested mount unprotected');
 $reserved=$path.'/.zfsm-mutation-test';mkdir($reserved);file_put_contents($reserved.'/journal.jsonl','synthetic protected fixture');$refused=deleteDirectory($reserved,'1');nativeExpect(str_contains(json_encode($refused),'protected recovery data')&&is_file($reserved.'/journal.jsonl'),'Reserved recovery directory not protected/explained');
 $result=deleteDirectory($target,'1');clearstatcache();nativeExpect(!file_exists($target),'Real native deletion did not remove fixture: '.json_encode($result));nativeExpect(file_get_contents($sibling.'/keep.txt')==='preserve','Sibling changed');
 return ['dataset'=>$props['name'],'guid'=>$props['guid'],'removed'=>$target,'sibling_preserved'=>true,'result'=>$result,'boundary'=>'Real ZFS inventory/ownership and confined Perl deletion; synthetic read-only SMB/NFS config, no Samba service'];
});
exit(array_filter($results,fn($r)=>$r['status']!=='PASS')?1:0);
