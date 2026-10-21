<?php
require '/app/harness.php';
$objects=[['name'=>'cache/data','type'=>'filesystem','guid'=>'11','mountpoint'=>'/mnt/cache/data'],['name'=>'cache/data/child','type'=>'filesystem','guid'=>'12','mountpoint'=>'/mnt/cache/data/child']];
function procRow($overrides=[]){return array_replace(['pid'=>42,'command'=>'worker','namespace'=>'host','mountinfo'=>"1 0 0:1 / / rw - rootfs rootfs rw\n2 1 0:2 / /mnt/cache/data rw - zfs cache/data rw\n3 2 0:3 / /mnt/cache/data/child rw - zfs cache/data/child rw",'cwd'=>'/app','fd_mount_ids'=>[],'container'=>null],$overrides);}
check('foreign namespace mounts block even when host reports unmounted',function()use($objects){$r=zfsmDestroyBusyReport($objects,[procRow(['namespace'=>'other','command'=>'python3.14','container'=>str_repeat('a',64)])],'host');same(true,$r['blocked']);same('foreign_mount',$r['blockers'][0]['kind']);same('cache/data',$r['blockers'][0]['dataset']);same(42,$r['blockers'][0]['pid']);same(str_repeat('a',64),$r['blockers'][0]['container']);same([],$GLOBALS['test_calls']);});
check('ordinary mounted children without references are eligible for normal unmount',function()use($objects){same(false,zfsmDestroyBusyReport($objects,[procRow()],'host')['blocked']);});
check('host bind mount and escaped paths are reported',function()use($objects){$r=zfsmDestroyBusyReport($objects,[procRow(['mountinfo'=>procRow()['mountinfo']."\n4 1 0:2 /subdir /export\\040copy rw - zfs cache/data rw"])],'host');same(true,$r['blocked']);same('/export copy',$r['blockers'][0]['mountpoint']);same('additional_mount',$r['blockers'][0]['kind']);});
check('open file and cwd references distinguish nested mount owner',function()use($objects){$r=zfsmDestroyBusyReport($objects,[procRow(['fd_mount_ids'=>['3'],'cwd'=>'/mnt/cache/data/dir'])],'host');same(['cache/data','cache/data/child'],array_column($r['blockers'],'dataset'));same(['cwd','open_file'],array_column($r['blockers'],'kind'));});
check('nested non-ZFS mounts block without inventing an open file on the underlying dataset',function()use($objects){$r=zfsmDestroyBusyReport($objects,[procRow(['cwd'=>'/mnt/cache/data/elsewhere','mountinfo'=>procRow()['mountinfo']."\n4 2 0:9 / /mnt/cache/data/elsewhere rw - tmpfs tmpfs rw\n5 1 0:8 / /mnt/cache/data-other rw - zfs cache/data-other rw"])],'host');same(true,$r['blocked']);same(['nested_mount'],array_column($r['blockers'],'kind'));same('cache/data',$r['blockers'][0]['dataset']);same('/mnt/cache/data/elsewhere',$r['blockers'][0]['mountpoint']);});
check('mounted snapshot is a blocker for destruction of its filesystem',function()use($objects){$r=zfsmDestroyBusyReport($objects,[procRow(['mountinfo'=>"5 1 0:8 / /snap rw - zfs cache/data@s1 rw"])],'host');same(true,$r['blocked']);same('snapshot_mount',$r['blockers'][0]['kind']);});
$snapshot=[['name'=>'cache/data@s1','type'=>'snapshot','guid'=>'13','mountpoint'=>'-']];
$mounts=['cache/data'=>['mountpoint'=>'/mnt/cache/data','mounted'=>'yes']];
$automount=procRow(['pid'=>1,'command'=>'init','mountinfo'=>procRow()['mountinfo']."\n5 2 0:8 / /mnt/cache/data/.zfs/snapshot/s1 ro - zfs cache/data@s1 ro"]);
check('unused canonical snapshot automount is eligible and does not blame namespace representative PID1',function()use($snapshot,$mounts,$automount){$r=zfsmDestroyBusyReport($snapshot,[$automount],'host',$mounts);same(false,$r['blocked']);same([],$r['blockers']);});
check('incomplete process diagnostics never exempt a canonical snapshot automount',function()use($snapshot,$mounts,$automount){$r=zfsmDestroyBusyReport($snapshot,[$automount],'host',$mounts,false);same(true,$r['blocked']);same('snapshot_mount',$r['blockers'][0]['kind']);});
check('canonical snapshot automount still blocks real open files and cwd with their holder PID',function()use($snapshot,$mounts,$automount){$busy=array_replace($automount,['pid'=>99,'command'=>'reader','cwd'=>'/mnt/cache/data/.zfs/snapshot/s1/dir','fd_mount_ids'=>['5']]);$r=zfsmDestroyBusyReport($snapshot,[$automount,$busy],'host',$mounts);same(true,$r['blocked']);same(['cwd','open_file'],array_column($r['blockers'],'kind'));same([99,99],array_column($r['blockers'],'pid'));});
check('snapshot automount in another namespace remains protected',function()use($snapshot,$mounts,$automount){$r=zfsmDestroyBusyReport($snapshot,[array_replace($automount,['namespace'=>'container'])],'host',$mounts);same(true,$r['blocked']);same('foreign_mount',$r['blockers'][0]['kind']);});
check('snapshot binds and unverified canonical-looking mounts remain protected',function()use($snapshot,$mounts,$automount){
 foreach([
  [$automount,[]],
  [$automount,['cache/data'=>['mountpoint'=>'/mnt/other','mounted'=>'yes']]],
  [$automount,['cache/data'=>['mountpoint'=>'/mnt/cache/data','mounted'=>'no']]],
  [array_replace($automount,['mountinfo'=>str_replace('5 2 0:8 / ','5 2 0:8 /subdir ',$automount['mountinfo'])]),$mounts],
  [array_replace($automount,['mountinfo'=>$automount['mountinfo']."\n6 1 0:8 / /export/snapshot ro - zfs cache/data@s1 ro"]),$mounts],
  [array_replace($automount,['mountinfo'=>$automount['mountinfo']."\n6 2 0:8 / /mnt/cache/data/.zfs/snapshot/s1 ro - zfs cache/data@s1 ro"]),$mounts],
  [array_replace($automount,['mountinfo'=>$automount['mountinfo']."\n6 5 0:9 / /mnt/cache/data/.zfs/snapshot/s1/nested rw - tmpfs tmpfs rw"]),$mounts],
  [array_replace($automount,['mountinfo'=>$automount['mountinfo']."\n6 5 0:9 / /mnt/cache/data/.zfs/snapshot/s1 rw - tmpfs tmpfs rw"]),$mounts],
  [array_replace($automount,['mountinfo'=>$automount['mountinfo']."\n6 2 0:9 / /mnt/cache/data/.zfs rw - tmpfs tmpfs rw"]),$mounts],
  [array_replace($automount,['mountinfo'=>$automount['mountinfo']."\n6 1 0:9 / /mnt/cache/data rw - tmpfs tmpfs rw"]),$mounts],
  [array_replace($automount,['mountinfo'=>$automount['mountinfo']."\n6 1 0:9 / /mnt/cache rw - tmpfs tmpfs rw"]),$mounts],
 ]as[$process,$owners])same(true,zfsmDestroyBusyReport($snapshot,[$process],'host',$owners)['blocked']);
});
check('legitimate parent mounts in the actual snapshot ancestor chain remain eligible',function()use($snapshot,$mounts,$automount){$p=$automount;$p['mountinfo']=str_replace('2 1 0:2','2 7 0:2',$p['mountinfo'])."\n7 1 0:7 / /mnt/cache rw - zfs cache rw";same(false,zfsmDestroyBusyReport($snapshot,[$p],'host',$mounts)['blocked']);});
check('container list parser accepts only full IDs and safe Docker names',function(){
    $a=str_repeat('a',64);$b=str_repeat('b',64);
    same([$a=>'qbittorrent',$b=>'backup_worker-2.1'],zfsmDestroyParseContainerNames($a." qbittorrent\n".$b." backup_worker-2.1\n"));
    foreach(['short name',str_repeat('A',64).' name',$a.' <img>',$a.' bad/name',$a.' bad;name',$a." good\tbad",$a.' good extra',$a." first\n".$a.' second']as$text)same([],zfsmDestroyParseContainerNames($text));
    same([],zfsmDestroyParseContainerNames(''));
});
finishTests();
