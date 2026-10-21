<?php
require '/app/harness.php';
@mkdir('/mnt/tank/review/child',0755,true);
$properties=['name'=>'tank','guid'=>'99','type'=>'filesystem','mounted'=>'yes','mountpoint'=>'/mnt/tank'];
$hostMounts=[['id'=>'1','parent'=>'0','path'=>'/','source'=>'rootfs','fs'=>'rootfs'],['id'=>'2','parent'=>'1','path'=>'/mnt/tank','source'=>'tank','fs'=>'zfs']];
function monitorReport($bindings,$namespace='') {
    global $properties,$hostMounts;
    $io=zfsmUsageIO(['tool'=>fn($name)=>'/usr/bin/'.$name,'mounts'=>fn()=>$hostMounts,'read'=>fn($path)=>['status'=>'known','content'=>$namespace],
        'process'=>function($tool,$args)use($bindings){
            same('docker',basename($tool));
            if($args===['container','ls','--all','--quiet','--no-trunc'])return ['code'=>0,'output'=>str_repeat('a',64)];
            same(['container','inspect','--format'],array_slice($args,0,3));
            return ['code'=>0,'output'=>json_encode(['name'=>'/metrics-demo','state'=>'running','pid'=>123,'mounts'=>$bindings])];
        }]);
    $usage=zfsmUsageDocker($properties,$io);
    same('known',$usage['status']);same(count($bindings),count($usage['entries']));
    return zfsmDependencyReport($properties,[$properties],$hostMounts,['docker'=>$usage]);
}
function monitorBind($path,$rw=false) {return ['source'=>$path,'destination'=>'/storage','type'=>'bind','rw'=>$rw];}
check('read-only Docker parent exposes an ordinary directory without pinning its deletion',function(){
    $report=monitorReport([monitorBind('/mnt/tank')]);
    same(false,zfsmDependencyBlocks($report,'deletedirectory','/mnt/tank/review'));
    same(true,$report['services'][0]['read_only']??null);
});
check('writable missing or malformed Docker access never receives the read-only exception',function(){
    foreach([true,null,'false',0]as$rw){$binding=monitorBind('/mnt/tank',$rw);if($rw===null)unset($binding['rw']);$report=monitorReport([$binding]);same(true,zfsmDependencyBlocks($report,'deletedirectory','/mnt/tank/review'));}
});
check('read-only exact and descendant consumers remain deletion blockers',function(){
    foreach(['/mnt/tank/review','/mnt/tank/review/child']as$path){$report=monitorReport([monitorBind($path)]);same(true,zfsmDependencyBlocks($report,'deletedirectory','/mnt/tank/review'));}
    $report=monitorReport([monitorBind('/mnt/tank')]);
    foreach(['destroydataset','renamedataset','movedirectory','convertdirectory']as$command)same(true,zfsmDependencyBlocks($report,$command,'/mnt/tank/review'));
    same(true,zfsmDependencyBlocks($report,'deletedirectory','/mnt/tank'));
    same(true,zfsmDependencyBlocks($report,'deletedirectory','/mnt'));
});
check('read-only ancestor exposure uses the effective child mount mode in its namespace',function(){
    foreach(['ro'=>false,'rw'=>true,'ro,rw'=>true,'nosuid'=>true]as$mode=>$blocked){
        $binding=monitorBind('/mnt');
        $namespace="1 0 0:1 / / rw - rootfs rootfs rw\n2 1 0:1 /mnt /storage ro - rootfs rootfs rw\n3 2 0:2 / /storage/tank $mode,noatime - zfs tank rw\n";
        $report=monitorReport([$binding],$namespace);
        same('container_mountinfo',$report['services'][0]['evidence']);
        same($blocked,zfsmDependencyBlocks($report,'deletedirectory','/mnt/tank/review'));
    }
});
check('one read-only parent cannot hide writable consumers or nested mounts',function(){
    $base=monitorReport([monitorBind('/mnt/tank')]);
    foreach([monitorBind('/mnt/tank',true),monitorBind('/mnt/tank/review',false)]as$other)same(true,zfsmDependencyBlocks(monitorReport([monitorBind('/mnt/tank'),$other]),'deletedirectory','/mnt/tank/review'));
    foreach(['nested_mount','additional_mount']as$kind){$report=$base;$report['entries'][]=['kind'=>$kind,'path'=>'/mnt/tank/review/child'];same(true,zfsmDependencyBlocks($report,'deletedirectory','/mnt/tank/review'));}
    $report=$base;$report['services'][]=['service'=>'vm','path'=>'/mnt/tank','read_only'=>true];same(true,zfsmDependencyBlocks($report,'deletedirectory','/mnt/tank/review'));
});
finishTests();
