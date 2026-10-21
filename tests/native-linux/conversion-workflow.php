<?php
// Native workflow fixture only. Real mount APIs + production PHP and Perl;
// exclusively the ZFS CLI is replaced with a strict tmpfs-backed state model.
if (!is_file('/.dockerenv')) throw new RuntimeException('Disposable container required');
$fixture=$argv[1]??'';
if (!str_starts_with($fixture,'/test/private/')) throw new RuntimeException('Invalid fixture root');
function wfState() { return json_decode(file_get_contents($GLOBALS['fixture'].'/zfs.json'),true,32,JSON_THROW_ON_ERROR); }
function wfSave($state) { file_put_contents($GLOBALS['fixture'].'/zfs.json',json_encode($state,JSON_THROW_ON_ERROR)); }
function wfResult($output='', $code=0) { return ['code'=>$code,'output'=>$output]; }
function wfRows() {
    $rows=[];
    foreach(explode("\n",trim(file_get_contents('/proc/self/mountinfo'))) as $line) {
        $halves=explode(' - ',$line,2);if(count($halves)!==2)continue;
        $left=explode(' ',$halves[0]);$right=explode(' ',$halves[1]);
        $decode=static fn($x)=>preg_replace_callback('/\\\\([0-7]{3})/',static fn($m)=>chr(octdec($m[1])),$x);
        $rows[]=['id'=>$left[0],'parent'=>$left[1],'device'=>$left[2],'path'=>$decode($left[4]),'fs'=>$right[0],'source'=>$decode($right[1])];
    }
    return $rows;
}
function zfsmMountInfo() {
    $state=wfState();$rows=wfRows();
    foreach($rows as &$row) foreach($state['datasets'] as $name=>$dataset) {
        if(($dataset['device']??null)===$row['device']&&$row['fs']==='tmpfs') {$row['fs']='zfs';$row['source']=$name;}
    }
    return $rows;
}
function wfProperty($name,$property,&$state) {
    $dataset=$state['datasets'][$name]??null;
    if($dataset===null)throw new RuntimeException('Unknown fixture dataset');
    if(($state['fault']??'')==='wrong-tag'&&$name!=='tank/owner'&&$property==='zfs.master.ui:conversion-job')return 'foreign-job';
    if($property==='mounted') {
        foreach(wfRows() as $row) if($row['path']===$dataset['mountpoint']&&($dataset['device']??null)===$row['device'])return 'yes';
        return 'no';
    }
    if(!array_key_exists($property,$dataset))throw new RuntimeException('Unmodelled ZFS property: '.$property);
    if(($state['fault']??'')==='wrong-guid'&&$name!=='tank/owner'&&$property==='guid') {$state['guid_reads']=($state['guid_reads']??0)+1;wfSave($state);if($state['guid_reads']>1)return '999999';}
    return $dataset[$property];
}
function runProcess($command,$args=[],$stdin=null) {
    if($command!=='zfs') {
        $state=wfState();$state['native'][]=['command'=>$command,'args'=>$args];wfSave($state);
        return workflowRealProcess($command,$args,$stdin);
    }
    $state=wfState();$state['commands'][]=$args;wfSave($state);
    $op=$args[0]??'';
    if($op==='list'&&array_slice($args,0,6)===['list','-H','-o','name,mountpoint,mounted','-t','filesystem']&&count($args)===6) {
        $rows=[];foreach($state['datasets'] as $name=>$dataset)$rows[]=$name."\t".$dataset['mountpoint']."\t".wfProperty($name,'mounted',$state);
        return wfResult(implode("\n",$rows));
    }
    if($op==='list'&&array_slice($args,0,4)===['list','-H','-o','name']&&($args[4]??'')==='-t'&&count($args)===7) {
        $name=$args[6];return isset($state['datasets'][$name])?wfResult($name):wfResult('missing fixture dataset',1);
    }
    if(array_slice($args,0,7)===['list','-H','-p','-o','name,type,guid','-t','filesystem,volume,snapshot']&&count($args)===8) {
        $name=$args[7];return isset($state['datasets'][$name])?wfResult($name."\tfilesystem\t".$state['datasets'][$name]['guid']):wfResult('missing fixture dataset',1);
    }
    if($op==='get'&&array_slice($args,0,3)===['get','-H','-o']&&count($args)===6&&in_array($args[3],['value','property,value'],true)) {
        $name=$args[5];if(!isset($state['datasets'][$name]))return wfResult('missing fixture dataset',1);
        $out=[];foreach(explode(',',$args[4]) as $property) {
            $value=wfProperty($name,$property,$state);$out[]=($args[3]==='value'?'':$property."\t").$value;
        }
        return wfResult(implode("\n",$out));
    }
    if($op==='create') {
        if(($state['fault']??'')==='create')return wfResult('injected create failure',1);
        $name=end($args);$props=[];
        if(($args[1]??'')!=='-u')throw new RuntimeException('Create must not automount');
        for($i=2;$i<count($args)-1;$i+=2) {
            if($args[$i]!=='-o'||!isset($args[$i+1])||!str_contains($args[$i+1],'='))throw new RuntimeException('Unmodelled create form');
            [$key,$value]=explode('=',$args[$i+1],2);if(!in_array($key,['mountpoint','canmount','zfs.master.ui:conversion-job','sharenfs','sharesmb'],true))throw new RuntimeException('Unsafe create property');$props[$key]=$value;
        }
        if(isset($state['datasets'][$name])||$name!=='tank/owner/SampleProject'||($props['canmount']??null)!=='noauto'||($props['sharenfs']??null)!=='off'||($props['sharesmb']??null)!=='off'||!str_starts_with($props['mountpoint']??'',$GLOBALS['plugin_conversion_runtime'].'/')||!str_ends_with($props['mountpoint'],'/target')||!preg_match('/^[0-9]{8}-[0-9]{6}-[a-f0-9]{12}$/D',$props['zfs.master.ui:conversion-job']??''))throw new RuntimeException('Unsafe fixture dataset creation');
        $state['datasets'][$name]=$props+['guid'=>'202','readonly'=>'off'];wfSave($state);return wfResult();
    }
    if($op==='mount'&&count($args)===2) {
        if(($state['fault']??'')==='mount')return wfResult('injected mount failure',1);
        $name=$args[1];$dataset=$state['datasets'][$name]??null;if(!$dataset||$name==='tank/owner')throw new RuntimeException('Unsafe fixture mount');
        $path=$dataset['mountpoint'];if(!is_dir($path)&&!mkdir($path,0700))throw new RuntimeException('Create fixture mountpoint');
        $result=workflowRealProcess('/usr/bin/mount',['-t','tmpfs','-o','size=32m','tmpfs',$path]);if($result['code']!==0)return $result;
        foreach(wfRows() as $row)if($row['path']===$path)$state['datasets'][$name]['device']=$row['device'];
        wfSave($state);return wfResult();
    }
    if($op==='unmount'&&count($args)===2) {
        $name=$args[1];$dataset=$state['datasets'][$name]??null;if(!$dataset||$name==='tank/owner')throw new RuntimeException('Unsafe fixture unmount');
        $socket=stream_socket_client('unix://'.$GLOBALS['fixture'].'/keeper.sock',$errno,$error,5);
        if(!$socket)throw new RuntimeException('Fixture persistent-filesystem keeper unavailable');
        fwrite($socket,json_encode(['target'=>$dataset['mountpoint']])."\n");$reply=json_decode(fgets($socket),true);fclose($socket);
        if(($reply['ok']??false)!==true)throw new RuntimeException('Fixture mount retention failed');
        return workflowRealProcess('/usr/bin/umount',[$dataset['mountpoint']]);
    }
    if($op==='set'&&count($args)===4&&$args[1]==='-u') {
        [$key,$value]=explode('=',$args[2],2);$name=$args[3];
        if($name!=='tank/owner/SampleProject'||!isset($state['datasets'][$name])||!in_array($key,['mountpoint','canmount'],true))throw new RuntimeException('Unsafe fixture property write');
        if(($state['fault']??'')==='property'||($state['fault']??'')==='activation'&&$key==='canmount')return wfResult('injected property failure',1);
        if($key==='mountpoint'&&$value!==$GLOBALS['fixture'].'/owner/SampleProject')throw new RuntimeException('Unexpected public mountpoint');
        if($key==='canmount'&&$value!=='on')throw new RuntimeException('Unexpected canmount value');
        if(($state['fault']??'')==='activation-noop'&&$key==='canmount')return wfResult();
        $state['datasets'][$name][$key]=$value;wfSave($state);
        if(($state['fault']??'')==='publish'&&$key==='mountpoint') {
            $attack='import os,sys;fd=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY);os.setgroups([]);os.setgid(100);os.setuid(99);os.rename("SampleProject","SampleProject-held",src_dir_fd=fd,dst_dir_fd=fd);os.mkdir("SampleProject",dir_fd=fd);f=os.open("SampleProject/replacement",os.O_WRONLY|os.O_CREAT,0o600,dir_fd=fd);os.write(f,b"untouched");os.close(f)';
            $attacked=workflowRealProcess('/usr/bin/python3',['-c',$attack,$GLOBALS['fixture'].'/owner']);
            if($attacked['code']!==0)throw new RuntimeException('Fixture UID99 race failed');
        }
        return wfResult();
    }
    throw new RuntimeException('UNMODELLED ZFS COMMAND: '.json_encode($args));
}
// Load the unchanged dependency graph through an isolated copied PHP tree so
// require_once remains truthful. Four exact function declaration seams
// were renamed by the Python driver before this script started.
require $fixture.'/code/src/backend/ZFSMOperations.php';
$plugin_state=$fixture.'/state';$plugin_runtime=$fixture.'/runtime';$plugin_audit=$fixture.'/audit';
$plugin_conversion_runtime=$fixture.'/conversions';$plugin_worker_lock=$fixture.'/worker.lock';$plugin_service_lock=$fixture.'/service.lock';
foreach([$plugin_state,$plugin_runtime,$plugin_audit,$plugin_conversion_runtime] as $dir)if(!is_dir($dir))mkdir($dir,0700,true);
$mode=$argv[2]??'run';
function zfsmStreamProcess($command,$args,$consume,$cancel,$failure=null,$stdin=null) {
    $state=wfState();$state['native'][]=['command'=>$command,'args'=>$args];wfSave($state);
    if($command==='rsync'||str_ends_with($command,'/rsync'))throw new RuntimeException('Unsafe unconfined rsync requested by PHP');
    $record=function($chunk)use($consume){file_put_contents($GLOBALS['fixture'].'/native-stream.log',$chunk,FILE_APPEND);$consume($chunk);};
    return workflowRealStreamProcess($command,$args,$record,$cancel,$failure,$stdin);
}
function zfsmJobAtomicWrite($file,$data) {
    workflowRealAtomicWrite($file,$data);$state=wfState();
    if(($GLOBALS['mode']??'')==='run'&&($data['stage']??'')==='copy_verified'&&empty($state['fault_seen'])) {
        if(($state['fault']??'')==='concurrent-write') {file_put_contents($data['source'].'/payload','concurrent writer',FILE_APPEND);$state['fault_seen']=true;wfSave($state);}
        if(($state['fault']??'')==='target-corrupt') {file_put_contents($data['staging'].'/target/payload','corrupted target');$state['fault_seen']=true;wfSave($state);}
    }
    if(($GLOBALS['mode']??'')==='run'&&($data['state']??'')==='running'&&($state['crash_stage']??null)===($data['stage']??null)&&empty($state['crash_seen'])) {
        $state['crash_seen']=true;wfSave($state);exit(77);
    }
}
try {
    if(in_array($mode,['move','delete'],true)) {
        $review=json_decode(file_get_contents($fixture.'/review.json'),true);
        zfsmGuardMutationIdentity($mode==='move'?'movedirectory':'deletedirectory',['directory'=>$review['path'],'directory_identity'=>$review['identity'],'expected_guid'=>'101']);
        $answer=$mode==='move'?moveDirectory($review['path'],$review['destination']):deleteDirectory($review['path'],'1');
        echo json_encode(['ok'=>true,'answer'=>$answer],JSON_THROW_ON_ERROR)."\n";return;
    } elseif($mode==='queue') {
        $answer=zfsmQueueConversion($fixture.'/owner/SampleProject','tank',true);
        if(empty($answer['job']))throw new RuntimeException('Queue failed: '.json_encode($answer));
        $job=$answer['job'];if(($job['schema']??null)!==1||($job['method']??null)!=='confined-v1'||($job['staging']??null)!==zfsmConfinedStagingPath($job['id']))throw new RuntimeException('New job is not confined-v1');
    } elseif($mode==='run') {
        $id=json_decode(file_get_contents($fixture.'/job-id.json'),true);$job=zfsmRunConversionJob($id);
    } elseif($mode==='resume') {
        $id=json_decode(file_get_contents($fixture.'/job-id.json'),true);$job=zfsmResumeConversion($id,true);
    } else throw new RuntimeException('Unknown workflow fixture action');
    echo json_encode(['ok'=>true,'job'=>$job],JSON_THROW_ON_ERROR)."\n";
} catch(Throwable $error) {fwrite(STDERR,json_encode(['ok'=>false,'error'=>$error->getMessage()])."\n");exit(1);}
