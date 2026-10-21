<?php
require '/app/harness.php';
$props=['name'=>'cache/data','guid'=>'12','type'=>'filesystem','mounted'=>'yes','mountpoint'=>'/mnt/cache/data'];
$inventory=[['name'=>'cache/data','type'=>'filesystem','guid'=>'12','mounted'=>'yes','mountpoint'=>'/mnt/cache/data','origin'=>'-','userrefs'=>'-'],['name'=>'cache/data/child','type'=>'filesystem','guid'=>'13','mounted'=>'yes','mountpoint'=>'/mnt/cache/data/child','origin'=>'-','userrefs'=>'-'],['name'=>'cache/data@s','type'=>'snapshot','guid'=>'14','mounted'=>'-','mountpoint'=>'-','origin'=>'-','userrefs'=>'1'],['name'=>'cache/clone','type'=>'filesystem','guid'=>'15','mounted'=>'no','mountpoint'=>'/mnt/cache/clone','origin'=>'cache/data@s','userrefs'=>'-']];
$mounts=[['id'=>'1','parent'=>'0','path'=>'/','fs'=>'rootfs','source'=>'rootfs'],['id'=>'2','parent'=>'1','path'=>'/mnt/cache/data','fs'=>'zfs','source'=>'cache/data'],['id'=>'3','parent'=>'2','path'=>'/mnt/cache/data/temp','fs'=>'tmpfs','source'=>'tmpfs'],['id'=>'4','parent'=>'1','path'=>'/export','fs'=>'zfs','source'=>'cache/data']];
check('dependencies retain mounted children clones holds and bind evidence',function()use($props,$inventory,$mounts){$r=zfsmDependencyReport($props,$inventory,$mounts,[]);same('known',$r['status']);same(['mounted_child','hold','clone','nested_mount','additional_mount'],array_column($r['entries'],'kind'));same('zfs + mountinfo',$r['source']);});
check('dependency inventory never calls incomplete data empty',function()use($props,$inventory){$bad=$inventory;$bad[0]['guid']='99';same('unknown',zfsmDependencyReport($props,$bad,[],[])['status']);same('unknown',zfsmDependencyReport($props,[],[],[])['status']);});
check('configured dependency guard includes ancestor use and exact path boundaries',function()use($props){$services=['docker'=>['status'=>'known','entries'=>[['name'=>'worker','path'=>'/mnt/cache/data/app']]],'smb'=>['status'=>'unknown','entries'=>null]];$r=zfsmDependencyReport($props,[$props+['origin'=>'-','userrefs'=>'-']],[], $services);same('unknown',$r['services_status']);same('docker',$r['services'][0]['service']);same(true,zfsmDependencyBlocks($r,'renamedataset'));same(true,zfsmDependencyBlocks($r,'movedirectory','/mnt/cache/data/app/sub'));same(false,zfsmDependencyBlocks($r,'movedirectory','/mnt/cache/data/apple'));same(false,zfsmDependencyBlocks($r,'snapshotdataset'));});
check('native failure keeps dependency uncertainty separate from blockers',function(){same(false,zfsmDependencyBlocks(['status'=>'unknown','entries'=>[],'services'=>[]],'renamedataset'));});
check('directory deletion allows contents of ancestor SMB and NFS exports only',function(){
    foreach(['smb','nfs'] as $service){
        // The /mnt/user alias has already been verified against this ZFS location.
        $entry=['service'=>$service,'name'=>'zfs','path'=>'/mnt/cache/zfs','configured_path'=>'/mnt/user/zfs','evidence'=>'verified_user_share_location'];
        $r=['services'=>[$entry],'entries'=>[]];
        foreach(['.zfsm-mutation-715e770d8bfd137da44f4cd330099906497509f84d3b0125','SampleProject_zfsm_recovery_test','ordinary/sub'] as $child)same(false,zfsmDependencyBlocks($r,'deletedirectory','/mnt/cache/zfs/'.$child));
        same(true,zfsmDependencyBlocks($r,'deletedirectory','/mnt/cache/zfs'));
        same(true,zfsmDependencyBlocks($r,'deletedirectory','/mnt/cache'));
        same(false,zfsmDependencyBlocks($r,'deletedirectory','/mnt/cache/zfs-other'));
        foreach(['renamedataset','destroydataset','movedirectory'] as $command)same(true,zfsmDependencyBlocks($r,$command,'/mnt/cache/zfs/ordinary'));
        same(true,zfsmDependencyBlocks($r,'destroydataset'));
        $r['services'][]=['service'=>$service,'path'=>'/mnt/cache/zfs/ordinary/nested-export'];
        same(true,zfsmDependencyBlocks($r,'deletedirectory','/mnt/cache/zfs/ordinary'));
    }
});
check('ancestor export exception never bypasses service consumers or nested mounts',function(){
    $r=['services'=>[['service'=>'smb','path'=>'/mnt/cache/zfs']],'entries'=>[]];
    foreach(['docker','vm','unknown'] as $service){$blocked=$r;$blocked['services'][]=['service'=>$service,'path'=>'/mnt/cache/zfs'];same(true,zfsmDependencyBlocks($blocked,'deletedirectory','/mnt/cache/zfs/ordinary'));}
    foreach(['nested_mount','additional_mount'] as $kind)foreach(['/mnt/cache/zfs/ordinary','/mnt/cache/zfs/ordinary/sub'] as $path){$blocked=$r;$blocked['entries'][]=['kind'=>$kind,'path'=>$path];same(true,zfsmDependencyBlocks($blocked,'deletedirectory','/mnt/cache/zfs/ordinary'));}
});
check('reserved recovery paths explain why ordinary deletion is unavailable',function(){
    foreach(['.zfsm-mutation-test','ordinary/.zfsm-restore-test/child'] as $path){
        try{zfsmDirectoryRequest('delete',['mountpoint'=>'/mnt/cache/zfs','path'=>'/mnt/cache/zfs/'.$path],['recursive'=>true]);throw new RuntimeException('Reserved path accepted');}
        catch(RuntimeException $error){same(true,str_contains($error->getMessage(),'protected recovery data'));}
    }
});
check('conversion permits ordinary children of SMB and NFS exports without weakening exact or nested exports',function(){
    foreach(['smb','nfs'] as $service){
        $r=['services'=>[['service'=>$service,'name'=>'zfs','path'=>'/mnt/cache/zfs','configured_path'=>'/mnt/user/zfs']],'entries'=>[]];
        same(false,zfsmDependencyBlocks($r,'convertdirectory','/mnt/cache/zfs/SampleCamera'));
        same(true,zfsmDependencyBlocks($r,'convertdirectory','/mnt/cache/zfs'));
        same(true,zfsmDependencyBlocks($r,'convertdirectory','/mnt/cache'));
        same(false,zfsmDependencyBlocks($r,'convertdirectory','/mnt/cache/zfs-other'));
        $r['services'][]=['service'=>$service,'path'=>'/mnt/cache/zfs/SampleCamera/nested'];
        same(true,zfsmDependencyBlocks($r,'convertdirectory','/mnt/cache/zfs/SampleCamera'));
    }
});
check('conversion ancestor export exception never bypasses Docker VM consumers or mounts',function(){
    $base=['services'=>[['service'=>'smb','path'=>'/mnt/cache/zfs'],['service'=>'nfs','path'=>'/mnt/cache/zfs']],'entries'=>[]];
    foreach(['docker','vm','unknown'] as $service)foreach(['/mnt/cache/zfs','/mnt/cache/zfs/SampleCamera','/mnt/cache/zfs/SampleCamera/child'] as $path){$r=$base;$r['services'][]=['service'=>$service,'path'=>$path];same(true,zfsmDependencyBlocks($r,'convertdirectory','/mnt/cache/zfs/SampleCamera'));}
    foreach(['nested_mount','additional_mount'] as $kind)foreach(['/mnt/cache/zfs/SampleCamera','/mnt/cache/zfs/SampleCamera/child'] as $path){$r=$base;$r['entries'][]=['kind'=>$kind,'path'=>$path];same(true,zfsmDependencyBlocks($r,'convertdirectory','/mnt/cache/zfs/SampleCamera'));}
});
finishTests();
