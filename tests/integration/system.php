<?php
// Unraid PHP supplies POSIX; the WASM build used here does not.
if(!function_exists('posix_strerror')){function posix_strerror($code){return $code===0?'Success':'Simulated system error '.$code;}}
// Only external system boundaries are simulated. Endpoint, validators,
// operations, journals, signing, config and PHP filesystem remain real.
function integrationModel() { return json_decode(file_get_contents('/acceptance/model.json'),true,512,JSON_THROW_ON_ERROR); }
function integrationSave($m) { file_put_contents('/acceptance/model.json',json_encode($m,JSON_THROW_ON_ERROR)); }
function integrationProcess($command,$args,$stdin=null) {
    $m=integrationModel();$call=['command'=>$command,'args'=>$args,'stdin_present'=>$stdin!==null];
    if($command==='/usr/bin/perl'&&$stdin!==null)$call['stdin_json']=json_decode($stdin,true,512,JSON_THROW_ON_ERROR);
    $m['calls'][]=$call;integrationSave($m);
    $ok=fn($text='')=>['code'=>0,'output'=>rtrim($text,"\r\n")];$bad=fn($text)=>['code'=>1,'output'=>$text];
    if(($m['fail_command']??'')===$command.' '.implode(' ',$args))return $bad('SIMULATED command failure');
    if($command==='docker'&&isset($m['docker'])) {
        if($args===['container','ls','--all','--quiet','--no-trunc'])return $ok(str_repeat('a',64));
        if(array_slice($args,0,3)===['container','inspect','--format'])return $ok(json_encode($m['docker']));
        throw new RuntimeException('UNHANDLED SIMULATED DOCKER READ');
    }
    if(!empty($m['protection']['enabled'])) {
        if(in_array($command,['/usr/sbin/sanoid','/usr/sbin/syncoid'],true)&&$args===['--version'])return $ok(basename($command).' version 2.3.0');
        if(in_array($command,['/usr/sbin/sanoid','/usr/sbin/syncoid'],true)&&$args===['--help'])return $ok('--configdir --readonly --take-snapshots --prune-snapshots --cache-dir --run-dir --force-update --no-rollback --recvoptions --sshoption --identifier --compress --no-resume --recursive --exclude-datasets --no-sync-snap --use-hold --create-bookmark --source-bwlimit --sshkey --sshport --no-clone-handling');
        if($command==='/usr/local/sbin/update_cron'||($command==='/bin/bash'&&$args===['/usr/local/sbin/update_cron'])){$m['crontab']=@file_get_contents(zfsmProtectionCronFile())?:'';integrationSave($m);return $ok();}
        if($command==='crontab'&&$args===['-c','/etc/cron.d','-l'])return $ok($m['crontab']??'');
        if($command==='zfs'&&$args===['receive'])return $bad('zfs receive [-FhMnsuv] filesystem');
        if($command==='zfs'&&$args===['send'])return $bad('zfs send -t receive_resume_token');
        if($command==='/usr/sbin/syncoid') {
            $source=$args[count($args)-2];$target=end($args);$identifier='';foreach($args as$a)if(str_starts_with($a,'--identifier='))$identifier=substr($a,13);
            $short='syncoid_'.$identifier.'_integration_2026-10-18:00:00:00';$guid=(string)++$m['guid'];$snap=$source.'@'.$short;
            $m['snapshots'][$snap]=['name'=>$snap,'type'=>'snapshot','guid'=>$guid,'creation'=>1792320000,'createtxg'=>1792320000,'userrefs'=>0];
            if(empty($m['protection']['no_delivery'])){$m['datasets'][$target]=$m['datasets'][$source];$m['datasets'][$target]['name']=$target;$m['datasets'][$target]['guid']=(string)++$m['guid'];$copy=$m['snapshots'][$snap];$copy['name']=$target.'@'.$short;$m['snapshots'][$copy['name']]=$copy;}
            integrationSave($m);return $ok('SYNTHETIC native transfer effect');
        }
        if($command==='/usr/sbin/sanoid'&&in_array('--readonly',$args,true))return $ok("INFO: taking snapshots...\nINFO: pruning snapshots...\n");
    }
    if($command==='/usr/bin/perl'&&count($args)===1&&str_ends_with($args[0],'/scripts/zfsm-directory.pl')) {
        $request=json_decode($stdin,true,512,JSON_THROW_ON_ERROR);$op=$request['op']??'';
        if($op==='probe')return ($m['native_preflight']??'available')==='directory-unsupported'?$bad(json_encode(['ok'=>false,'op'=>$op,'error'=>'SIMULATED unsupported Linux directory boundary'])):$ok(json_encode(['ok'=>true,'op'=>$op]));
        // Only the external helper effect is simulated, entirely in WASM.
        // Production endpoint, validators, identities and mutation code stay real.
        $path=$request['root'].'/'.$request['path'];
        if($op==='cleanup-inspect'||$op==='cleanup') {
            if(!empty($m['cleanup_refuse']))return $bad(json_encode(['ok'=>false,'error'=>'SIMULATED native safety refusal']));
            $bytes=file_get_contents($path.'/journal.jsonl');$stat=lstat($path.'/journal.jsonl');
            if($op==='cleanup-inspect')return $ok(json_encode(['ok'=>true,'op'=>$op,'identity'=>zfsmDirectoryIdentity($path),'journal_identity'=>['dev'=>(string)$stat['dev'],'ino'=>(string)$stat['ino']],'journal_sha256'=>hash('sha256',$bytes),'journal_base64'=>base64_encode($bytes),'operation'=>'delete','records'=>5]));
            $archives=glob(dirname($GLOBALS['plugin_state']).'/mutation-cleanup/*.json')?:[];$found=false;
            foreach($archives as$file){$a=json_decode(file_get_contents($file),true);if(($a['scope']['directory']??'')===$path&&($a['journal_base64']??'')===base64_encode($bytes))$found=true;}
            if(!$found)throw new RuntimeException('Cleanup called before matching persistent archive');
            unlink($path.'/journal.jsonl');rmdir($path);return $ok(json_encode(['ok'=>true,'op'=>$op]));
        }
        if($op==='move')return rename($path,$request['root'].'/'.$request['destination'])?$ok(json_encode(['ok'=>true,'op'=>$op])):$bad('SIMULATED helper rename failed');
        if($op==='delete') {
            $remove=function($p)use(&$remove,$request){if(is_dir($p)&&!is_link($p)){if($request['recursive'])foreach(scandir($p)as$name)if($name!=='.'&&$name!=='..')$remove($p.'/'.$name);if(!rmdir($p))throw new RuntimeException('SIMULATED helper rmdir failed');}elseif(!unlink($p))throw new RuntimeException('SIMULATED helper unlink failed');};
            $remove($path);return $ok(json_encode(['ok'=>true,'op'=>$op]));
        }
        throw new RuntimeException('UNHANDLED SIMULATED DIRECTORY OP: '.$op);
    }
    if($command==='/usr/bin/perl'&&$args===['/app/src/scripts/zfsm-publish.pl']) {
        $request=json_decode($stdin,true,512,JSON_THROW_ON_ERROR);
        if($request!==['op'=>'probe'])throw new RuntimeException('Invalid simulated publish probe transport');
        return ($m['native_preflight']??'available')==='publish-unsupported'?$bad(json_encode(['ok'=>false,'error'=>'SIMULATED unsupported mount API'])):$ok(json_encode(['ok'=>true,'phase'=>'probe']));
    }
    if(str_ends_with($command,'/notify'))return $ok();
    if($command==='/bin/date'&&$args===['+%z'])return $ok('+0000');
    if($command==='zpool') {
        if($args[0]==='status')return $ok($m['status']);
        if(in_array($args,[['get','-H','-o','value','guid','cache'],['get','-H','-p','-o','value','guid','cache']],true))return $ok($m['pool_guid']??'54321');
        if($args[0]==='list')return in_array('-v',$args,true)?$ok($m['pool_list']):$ok("cache\t5992338374656\t4518984179712\t1473354194944\tONLINE");
        if($args[0]==='scrub'){$m['scrub_requests']=($m['scrub_requests']??0)+1;integrationSave($m);return $ok();}
    }
    if($command==='zfs') {
        $op=$args[0];$target=end($args);$all=$m['datasets']+$m['snapshots'];
        if(in_array($op,['userspace','groupspace'],true)){
            $user=$op==='userspace';$id=$user?'99':'100';$prefix=$user?'user':'group';$row=$m['datasets'][$target]??[];
            return $ok(($user?'POSIX User':'POSIX Group')."\t".$id."\t1024\t".($row[$prefix.'quota@'.$id]??'none').(str_contains(implode(',',$args),'objused')?"\t2\t".($row[$prefix.'objquota@'.$id]??'none'):'')."\n");
        }
        if($op==='promote'){
            $origin=$m['datasets'][$target]['origin'];$parent=explode('@',$origin,2)[0];$txg=$m['snapshots'][$origin]['createtxg'];
            foreach($m['snapshots'] as $name=>$snapshot)if(explode('@',$name,2)[0]===$parent&&$snapshot['createtxg']<=$txg){$new=$target.'@'.explode('@',$name,2)[1];$snapshot['name']=$new;$m['snapshots'][$new]=$snapshot;unset($m['snapshots'][$name]);if(isset($m['holds'][$name])){$m['holds'][$new]=$m['holds'][$name];unset($m['holds'][$name]);}foreach($m['datasets'] as &$dataset)if(($dataset['origin']??'')===$name)$dataset['origin']=$new;unset($dataset);}
            $m['datasets'][$target]['origin']=$m['datasets'][$parent]['origin'];$m['datasets'][$parent]['origin']=$target.'@'.explode('@',$origin,2)[1];integrationSave($m);return $ok();
        }
        $listAll=$args===['list','-H','-o','name,mountpoint,mounted','-t','filesystem']||$args===['list','-H','-p','-t','filesystem,volume','-o','name,guid'];
        if(in_array($op,['list','get'],true)) {
            if(!$listAll&&!isset($all[$target]))return $bad('dataset does not exist');
            $columns=explode(',',$args[array_search('-o',$args,true)+1]);
            if($op==='list') {
                $types=in_array('-t',$args,true)?explode(',',$args[array_search('-t',$args,true)+1]):['filesystem','volume'];$lines=[];
                foreach($all as $name=>$row) {
                    $owner=explode('@',$name)[0];
                    $match=$listAll || $name===$target || (in_array('-r',$args,true)&&($owner===$target||str_starts_with($owner,$target.'/'))) || (in_array('-d',$args,true)&&$owner===$target&&$row['type']==='snapshot');
                    if(!$match||!in_array($row['type'],$types,true))continue;
                    $values=[];foreach($columns as $column){$v=$row[$column]??'-';if($column==='createtxg')$v=$row['createtxg']??$row['creation']??'-';if($column==='compressratio')$v=is_numeric($v)?$v/100:$v;$values[]=(string)$v;}$lines[]=implode("\t",$values);
                }return $ok(implode("\n",$lines));
            }
            $props=explode(',',$args[count($args)-2]);if($props===['all'])$props=array_keys($all[$target]);$lines=[];
            foreach($props as $property){$row=$all[$target];$value=$row[$property]??'-';$source=$row['_sources'][$property]??'local';$out=[];foreach($columns as $column)$out[]=['property'=>$property,'value'=>(string)$value,'source'=>$source,'name'=>$target][$column];$lines[]=implode("\t",$out);}return $ok(implode("\n",$lines));
        }
        if($op==='create') {
            if(isset($all[$target]))return $bad('dataset already exists');
            $parent=dirname($target);$row=$m['datasets'][$parent]??$m['datasets']['cache'];$row['name']=$target;$row['guid']=(string)++$m['guid'];$row['mountpoint']='/mnt/'.$target;$row['origin']='-';$row['creation']=time();
            foreach($args as $i=>$arg)if($arg==='-o'){[$key,$value]=explode('=',$args[$i+1],2);$row[$key]=$value;}
            if(($row['encryption']??'off')!=='off'&&$stdin!==null){$row['encryptionroot']=$target;$row['keystatus']='available';}
            $m['datasets'][$target]=$row;integrationSave($m);return $ok();
        }
        if($op==='snapshot') {
            $m['snapshots'][$target]=['name'=>$target,'type'=>'snapshot','guid'=>(string)++$m['guid'],'used'=>4096,'referenced'=>10485760,'written'=>1024,'defer_destroy'=>'off','userrefs'=>0,'creation'=>time(),'origin'=>'-','mountpoint'=>'-','encryptionroot'=>'-'];integrationSave($m);return $ok();
        }
        if($op==='set'||$op==='inherit') {[$property,$value]=$op==='set'?explode('=',$args[1],2):[$args[1],'lz4'];$m['datasets'][$target][$property]=$value;$m['datasets'][$target]['_sources'][$property]=$op==='inherit'?'inherited from cache':'local';integrationSave($m);return $ok();}
        if($op==='destroy') {
            if(in_array('-nvp',$args,true))return $ok('would destroy '.$target."\nwould reclaim 4096");
            if(($m['destroy_fault']??'')===$target){
                foreach(array_keys($m['snapshots'])as$name)if(str_starts_with($name,$target.'@')){unset($m['snapshots'][$name]);break;}
                integrationSave($m);return $bad("cannot destroy '".$target."': dataset is busy\nwill destroy ".$target."@base\nwill destroy ".$target);
            }
            foreach(['datasets','snapshots'] as $set)foreach(array_keys($m[$set])as$name)if($name===$target||(in_array('-r',$args,true)&&(str_starts_with($name,$target.'/')||str_starts_with($name,$target.'@'))))unset($m[$set][$name]);integrationSave($m);return $ok();
        }
        if($op==='holds') { $lines=[];foreach($m['holds'][$target]??[]as$tag)$lines[]=$target."\t".$tag."\tfixture";return $ok(implode("\n",$lines)); }
        if($op==='hold'){$m['holds'][$target][]=$args[1];integrationSave($m);return $ok();}
        if($op==='release'){$m['holds'][$target]=array_values(array_diff($m['holds'][$target]??[],[$args[1]]));integrationSave($m);return $ok();}
        if(in_array($op,['mount','unmount','load-key','unload-key'],true)){$key=in_array($op,['mount','unmount'],true)?'mounted':'keystatus';$m['datasets'][$target][$key]=['mount'=>'yes','unmount'=>'no','load-key'=>'available','unload-key'=>'unavailable'][$op];integrationSave($m);return $ok();}
        if($op==='rollback'){ $m['rollback_requests']=($m['rollback_requests']??0)+1;integrationSave($m);return $ok(); }
    }
    throw new RuntimeException('UNHANDLED SIMULATED COMMAND: '.json_encode([$command,$args]));
}
function integrationFiles($request) {
    $m=integrationModel();$m['helper_calls'][]=$request;integrationSave($m);$op=$request['op'];
    if($op==='list') {
        $entries=$m['files'];if($request['path']!=='')$entries=array_values(array_filter($entries,fn($e)=>dirname($e['path'])===$request['path']));else $entries=array_values(array_filter($entries,fn($e)=>!str_contains($e['path'],'/')));
        $entries=array_values(array_filter($entries,fn($e)=>(($request['kind']??'all')==='all'||$e['type']===$request['kind'])&&($request['hidden']||!str_starts_with($e['name'],'.'))&&stripos($e['name'],$request['filter'])!==false));
        usort($entries,fn($a,$b)=>($request['direction']==='desc'?-1:1)*($request['sort']==='name'?strcmp($a['name'],$b['name']):($a[$request['sort']]<=>$b[$request['sort']])));
        return ['entries'=>array_slice($entries,$request['offset'],200),'total'=>count($entries)];
    }
    if($op==='fileinfo')return ['ready'=>true,'size'=>2048];
    if($op==='plan')return ['selection'=>$request['selection'],'target'=>$request['target'],'mode'=>$request['mode'],'files'=>count($request['selection']),'bytes'=>2048,'conflicts'=>$request['mode']==='overwrite'?['notes.txt']:[],'entries'=>[['path'=>'notes.txt','size'=>2048]]];
    if($op==='archive-plan')return ['selection'=>$request['selection'],'files'=>count($request['selection']),'bytes'=>2048,'entries'=>[['path'=>'notes.txt','size'=>2048]]];
    if($op==='archive-cleanup')return ['removed'=>true];
    throw new RuntimeException('UNHANDLED SIMULATED HELPER: '.$op);
}
function integrationStream($command,$args,$chunk,$cancel,$failure=null,$stdin=null) {
    if($command==='zfs'||($command==='/usr/bin/perl'&&str_ends_with($args[0]??'','/zfsm-directory.pl'))){$result=integrationProcess($command,$args,$stdin);$chunk($result['output']."\n");return $result+['cancelled'=>false];}
    if($command==='/usr/sbin/syncoid'){$chunk('SYNTHETIC transfer output');return integrationProcess($command,$args)+['cancelled'=>false];}
    $request=json_decode(file_get_contents(end($args)),true,160,JSON_THROW_ON_ERROR);
    $chunk(json_encode(['phase'=>'completed','percent'=>100,'total'=>2048,'archive_identity'=>['dev'=>'1','ino'=>'1','type'=>'file','size'=>2048],'archive_size'=>2048])."\n");
    return ['code'=>0,'output'=>'','cancelled'=>false];
}
function integrationDownload($request,$filename,$type) {
    $m=integrationModel();$m['downloads'][]=$request;integrationSave($m);
    zfsmRequestJobStage('transferring');zfsmRequestJobProgress(2048,2048);
    header('Content-Type: '.$type);header('Content-Disposition: attachment; filename="SIMULATED.txt"');echo str_repeat('x',2048);
    zfsmRequestJobFinish('completed','Server transfer finished. Check browser Downloads to confirm the file was saved.','completed',['confirmation'=>'server_stream_only']);
}
function parse_plugin_cfg($plugin,$sections) { return parse_ini_file('/boot/config/plugins/'.$plugin.'/'.$plugin.'.cfg',$sections)?:[]; }
function autov($url) { echo htmlspecialchars($url,ENT_QUOTES); }
