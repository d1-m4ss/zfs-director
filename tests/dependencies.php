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
check('blocked deletion names each configured reference in the preview text and rejected journal',function(){
    $report=['status'=>'known','entries'=>[['kind'=>'additional_mount','name'=>'cache/TimeMachineRemote','path'=>'/mnt/remotes/tm']],'services'=>[['service'=>'smb','name'=>"TimeMachine\nx",'path'=>'/mnt/cache/TimeMachineRemote'],['service'=>'docker','name'=>'timemachine','path'=>'/mnt/cache/TimeMachineRemote/data','read_only'=>false]],'services_status'=>'known'];
    $blockers=zfsmDependencyBlockers($report,'destroydataset');
    same([['kind'=>'smb','name'=>"TimeMachine\nx",'path'=>'/mnt/cache/TimeMachineRemote'],['kind'=>'docker','name'=>'timemachine','path'=>'/mnt/cache/TimeMachineRemote/data'],['kind'=>'additional_mount','name'=>'cache/TimeMachineRemote','path'=>'/mnt/remotes/tm']],$blockers);
    $text=zfsmDependencyBlockerText($blockers);
    same('SMB share "TimeMachine x" at /mnt/cache/TimeMachineRemote; Docker container "timemachine" at /mnt/cache/TimeMachineRemote/data; Additional mount at /mnt/remotes/tm',$text);
    same([],zfsmDependencyBlockers($report,'createdataset'));
    $many=array_fill(0,7,['kind'=>'nfs','name'=>'NFS export','path'=>'/mnt/a']);
    same('NFS export at /mnt/a; NFS export at /mnt/a; NFS export at /mnt/a; NFS export at /mnt/a; NFS export at /mnt/a; and 2 more',zfsmDependencyBlockerText($many));
    [$code,$message]=zfsmDeletionError("Operation blocked by configured service references or additional mounts. Review Usage & Dependencies and release references through their owner; no services were stopped.\nBlocking: ".$text);
    same('dependencies',$code);
    same('Deletion is blocked by service references or mounts. Review Usage & Dependencies and release them through their owner. Blocking: '.$text.'.',$message);
    [$code,$message]=zfsmDeletionError('Deletion blocked by live filesystem references');
    same(['dependencies','Deletion is blocked by service references or mounts. Review Usage & Dependencies and release them through their owner.'],[$code,$message]);
});
check('busy deletion names the lock holder or the earlier request for the same folder',function(){
    same(['lock_busy','Another operation is running. Wait for it to finish, refresh the target and submit a new request. Held by: php (PID 4242).'],zfsmDeletionError("Another operation is running: the operation lock is held. Wait for it to finish and retry.\nHeld by: php (PID 4242)"));
    same(['lock_busy','Another operation is running. Wait for it to finish, refresh the target and submit a new request. Earlier request: job 20261108-221212-16a5e75556fa (queued).'],zfsmDeletionError("Another operation for this target is already queued or running\nEarlier request: job 20261108-221212-16a5e75556fa (queued)"));
    same(['lock_busy','Another operation is running. Wait for it to finish, refresh the target and submit a new request.'],zfsmDeletionError('Unable to lock queue'));
    same(['lock_busy','Another operation is running. Wait for it to finish, refresh the target and submit a new request.'],zfsmDeletionError("Unable to lock queue\nHeld by: <script>"));
});
finishTests();
