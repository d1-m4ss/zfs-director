<?php
// Explicitly authorized synthetic dataset only. This driver never cleans up.
function rootMetadata(){
    clearstatcache(true,'/');$s=lstat('/');
    return array_intersect_key($s,array_flip(['dev','ino','mode','uid','gid']));
}
function acceptanceCanonical($path){
    $current='';foreach(explode('/',ltrim($path,'/'))as$part){$current.='/'.$part;clearstatcache(true,$current);if(is_link($current))throw new RuntimeException('Symbolic link in acceptance path');}
}
function acceptanceStateParent(){
    global $stateFile;$parent=dirname($stateFile);acceptanceCanonical($parent);
    $tmp=lstat('/tmp');$s=@lstat($parent);
    // Only the explicit root-owned sticky /tmp ancestor may be writable.
    if(($tmp['mode']&0170000)!==0040000||$tmp['uid']!==0||(($tmp['mode']&0022)!==0&&($tmp['mode']&01000)===0)||!$s||($s['mode']&0170000)!==0040000||$s['uid']!==0||($s['mode']&07777)!==0700||realpath($parent)!==$parent)throw new RuntimeException('State parent must be canonical root-owned private 0700 directory');
}
function acceptanceStateStat($s){
    if(!$s||($s['mode']&0170000)!==0100000||$s['uid']!==0||($s['mode']&07777)!==0600||$s['nlink']!==1)throw new RuntimeException('State must be regular root0600 file with exactly one link; no symlink');
}
function acceptanceCheckStateHandle(){
    global $stateFile,$stateHandle,$stateIdentity;acceptanceStateParent();clearstatcache(true,$stateFile);$path=@lstat($stateFile);$handle=fstat($stateHandle);acceptanceStateStat($path);acceptanceStateStat($handle);
    if($path['dev']!==$handle['dev']||$path['ino']!==$handle['ino']||[$handle['dev'],$handle['ino']]!==$stateIdentity)throw new RuntimeException('State file identity changed');
}
function acceptanceOpenState($create){
    global $stateFile,$stateHandle,$stateIdentity,$stateCreated;
    acceptanceStateParent();clearstatcache(true,$stateFile);$before=@lstat($stateFile);$stateCreated=false;
    if($before)acceptanceStateStat($before);elseif(!$create)throw new RuntimeException('Existing acceptance state required for inspection');
    // x+b uses O_EXCL for creation. Existing opens occur only in a proven
    // root0700 parent; lstat/fstat identity checks precede every truncation.
    $mask=umask(0077);try{$handle=@fopen($stateFile,$before?($create?'r+b':'rb'):'x+b');}finally{umask($mask);}if(!$handle)throw new RuntimeException('Safe state open failed');
    try{
        $s=fstat($handle);
        if(!$before){
            clearstatcache(true,$stateFile);$created=lstat($stateFile);
            if(($s['mode']&0170000)!==0100000||$s['uid']!==0||$s['nlink']!==1||$created['dev']!==$s['dev']||$created['ino']!==$s['ino']||is_link($stateFile)||!chmod($stateFile,0600))throw new RuntimeException('Unsafe newly created state file');
            $s=fstat($handle);
        }
        acceptanceStateStat($s);
        if($before&&($before['dev']!==$s['dev']||$before['ino']!==$s['ino']))throw new RuntimeException('State changed while opening');
        if(!flock($handle,($create?LOCK_EX:LOCK_SH)|LOCK_NB))throw new RuntimeException('Acceptance already running; no replay');
        $stateHandle=$handle;$stateIdentity=[$s['dev'],$s['ino']];$stateCreated=!$before;acceptanceCheckStateHandle();
    }catch(Throwable$error){fclose($handle);$stateHandle=null;throw $error;}
}
function saveAcceptance(){
    global $state,$stateHandle;acceptanceCheckStateHandle();$bytes=json_encode($state,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)."\n";
    if(!rewind($stateHandle)||!ftruncate($stateHandle,0)||fwrite($stateHandle,$bytes)!==strlen($bytes)||!fflush($stateHandle)||!fsync($stateHandle))throw new RuntimeException('Test state write failed');
}
function ownIdentity(){
    global $dataset,$guid,$base,$state;
    $root=rootMetadata();if($root['uid']!==0||($root['mode']&0022)!==0||isset($state['root_metadata'])&&$root!==$state['root_metadata'])throw new RuntimeException('Host root metadata changed');
    acceptanceCanonical($base);clearstatcache(true,$base);$s=@lstat($base);
    if(!$s||($s['mode']&0170000)!==0040000||realpath($base)!==$base)throw new RuntimeException('Acceptance base is not a canonical directory');
    $identity=['dev'=>(string)$s['dev'],'ino'=>(string)$s['ino']];
    if(isset($state['base_identity'])&&$identity!==$state['base_identity'])throw new RuntimeException('Acceptance base identity differs from baseline');
    $object=zfsmRequireIdentity($dataset,$guid);if($object['type']!=='filesystem')throw new RuntimeException('Acceptance object is not a filesystem');
    $text=testProcess('zfs',['get','-H','-p','-o','property,value','mountpoint,mounted,readonly',$dataset]);$properties=[];
    foreach(explode("\n",trim($text))as$line){$row=explode("\t",$line);if(count($row)!==2||!in_array($row[0],['mountpoint','mounted','readonly'],true)||isset($properties[$row[0]]))throw new RuntimeException('Malformed acceptance mount properties');$properties[$row[0]]=$row[1];}
    if(($properties['mountpoint']??null)!==$base||($properties['mounted']??null)!=='yes'||($properties['readonly']??null)!=='off')throw new RuntimeException('Acceptance configured mountpoint/mounted/readonly differs');
    if(!zfsmLiveZfsMount($base,$dataset,zfsmMountInfo()))throw new RuntimeException('Exact live ZFS mount required');
    clearstatcache(true,$base);if(zfsmDirectoryIdentity($base)!==$identity)throw new RuntimeException('Acceptance base identity changed during guard');
    $state['root_metadata']=$root;$state['base_identity']=$identity;
}
function ownPath($path){
    global $base;if(!is_string($path)||!str_starts_with($path,$base.'/')||str_contains($path,"\0"))throw new RuntimeException('Test path outside exact scope');
    foreach(explode('/',substr($path,strlen($base)+1))as$part)if($part===''||$part==='.'||$part==='..')throw new RuntimeException('Test path outside exact scope');
    acceptanceCanonical($path);return $path;
}
function testProcess($command,$args){$r=runProcess($command,$args);if(($r['code']??1)!==0)throw new RuntimeException('Test command failed: '.substr($r['output']??'',0,2048));return $r['output'];}
function passed($name,$condition,$detail=[]){global $state;if(!$condition)throw new RuntimeException('FAIL '.$name);$row=['name'=>$name,'status'=>'PASS','detail'=>$detail];$state['checks'][]=$row;saveAcceptance();echo json_encode($row,JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)."\n";}
function acceptanceFreshRun(){
    global $state;if(!empty($state['phase'])||!empty($state['checks'])||!empty($state['jobs'])||isset($state['failure']))throw new RuntimeException('Acceptance already started; inspect state instead of replay');
}
function lockedTest($operation){
    $lock=fopen($GLOBALS['plugin_lock'],'c');$until=microtime(true)+5;while(!flock($lock,LOCK_EX|LOCK_NB)){if(microtime(true)>$until){fclose($lock);throw new RuntimeException('Plugin busy; no test mutation');}usleep(20000);}
    try{ownIdentity();$GLOBALS['zfsm_operation_lock_handle']=$lock;return $operation();}finally{unset($GLOBALS['zfsm_operation_lock_handle']);flock($lock,LOCK_UN);fclose($lock);}
}
function successful($answer){return is_array($answer)&&!empty($answer['succeeded'])&&empty($answer['failed']);}
function privateFixtureBase(){
    global $base;clearstatcache(true,$base);$s=lstat($base);if($s['uid']!==0||($s['mode']&07777)!==0700)throw new RuntimeException('Fixture writes require private root0700 base');
}
function protectFixtures(){
    global $base;ownIdentity();if(!chown($base,0)||!chgrp($base,0)||!chmod($base,0700))throw new RuntimeException('Unable to secure fixture base');privateFixtureBase();
}
function fixtureDirectory($path,$mode=0700){
    ownPath($path);privateFixtureBase();if(file_exists($path)||is_link($path))throw new RuntimeException('Test path already exists');if(!mkdir($path,0700))throw new RuntimeException('Fixture mkdir failed');
}
function fixtureContents($path){
    ownPath($path);privateFixtureBase();if(!mkdir($path.'/nested',0700)||file_put_contents($path.'/payload',str_repeat("synthetic conversion\0",4096))===false||file_put_contents($path.'/nested/ї file.txt',"Synthetic unicode\n")===false||!link($path.'/payload',$path.'/hardlink')||!symlink('nested',$path.'/symlink'))throw new RuntimeException('Fixture contents failed');
    foreach([$path.'/payload',$path.'/hardlink',$path.'/nested',$path.'/nested/ї file.txt']as$p){ownIdentity();ownPath($p);if(!chown($p,99)||!chgrp($p,100)||!chmod($p,is_dir($p)?0777:0666))throw new RuntimeException('Fixture metadata failed');}
    return hash_file('sha256',$path.'/payload');
}
function exposeFixtures($paths,$baseMode=0777){
    global $base;privateFixtureBase();foreach($paths as$path=>$mode){ownIdentity();ownPath($path);if(!chown($path,99)||!chgrp($path,100)||!chmod($path,$mode))throw new RuntimeException('Fixture exposure failed');}
    ownIdentity();if(!chown($base,99)||!chgrp($base,100)||!chmod($base,$baseMode))throw new RuntimeException('Fixture base exposure failed');
}
function waitOwnJob($id,$path){
    global $dataset,$guid,$state;$until=microtime(true)+60;do{$job=zfsmReadJob($id);if(($job['id']??null)!==$id||($job['dataset']??null)!==$dataset.'/'.basename($path)||($job['owner_dataset']??null)!==$dataset||($job['owner_guid']??null)!==$guid||($job['source']??null)!==$path)throw new RuntimeException('Foreign job identity');$state['job_results'][$id]=array_intersect_key($job,array_flip(['id','dataset','state','stage','error','recovery','mutation_recovery','retained_data']));if(!in_array($job['state'],['queued','running'],true)){saveAcceptance();return $job;}usleep(100000);}while(microtime(true)<$until);saveAcceptance();throw new RuntimeException('Own job timed out; retained for inspection: '.json_encode($state['job_results'][$id],JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR));
}
function acceptanceMetadata($properties,$expectDefault){
    $acl=$properties['_acl']??[];$status=$acl['status']??'missing';
    if($status!=='known'||!is_array($acl['entries']??null))throw new RuntimeException('ACL backend verification failed: '.$status.'; '.substr($acl['reason']??'entries unavailable',0,256));
    $summary=['acl'=>['status'=>$status,'type'=>$acl['type']??'unknown','entries'=>count($acl['entries']),'has_default'=>$acl['has_default']??null],'usage'=>[]];
    if($expectDefault){
        $named=array_values(array_filter($acl['entries'],fn($entry)=>($entry['scope']??null)==='default'&&($entry['tag']??null)==='user'&&($entry['id']??null)==='1001'));
        $mask=array_values(array_filter($acl['entries'],fn($entry)=>($entry['scope']??null)==='default'&&($entry['tag']??null)==='mask'));
        if(($acl['has_default']??false)!==true||count($named)!==1||count($mask)!==1||($named[0]['permissions']??null)!=='rwx'||($named[0]['effective']??null)!=='rwx'||($mask[0]['permissions']??null)!=='rwx')throw new RuntimeException('Parsed default UID1001 ACL and effective mask differ from fixture');
        $summary['acl']['default_uid1001_effective']=$named[0]['effective'];$summary['acl']['default_mask']=$mask[0]['permissions'];
    }
    foreach(['smb','nfs','docker','vm']as$key){$component=$properties['_usage'][$key]??[];$componentStatus=$component['status']??'missing';if(!in_array($componentStatus,['known','unknown','unavailable','error'],true))throw new RuntimeException('Invalid usage component classification: '.$key);$summary['usage'][$key]=['status'=>$componentStatus,'entries'=>is_array($component['entries']??null)?count($component['entries']):null];}
    return $summary;
}
function conversion($name,$mode){
    global $base,$dataset,$state;protectFixtures();$path=$base.'/'.$name;fixtureDirectory($path);$sha=fixtureContents($path);$identity=zfsmDirectoryIdentity($path);exposeFixtures([$path=>$mode],$mode);
    $answer=lockedTest(fn()=>zfsmQueueConversion($path,'cache',true));if(!successful($answer)||!is_string($answer['job']['id']??null))throw new RuntimeException('Queue failed: '.json_encode($answer['failed']??$answer));$id=$answer['job']['id'];$state['jobs'][]=$id;saveAcceptance();$job=waitOwnJob($id,$path);
    if($job['state']!=='completed'||$job['stage']!=='complete_source_retained')throw new RuntimeException('Convert '.$name.' failed: '.json_encode($state['job_results'][$id],JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR));passed('Convert '.$name.' completes',true,['job'=>$id,'state'=>$job['state'],'stage'=>$job['stage'],'error'=>$job['error']??null]);ownIdentity();ownPath($job['recovery']);$state['objects'][$job['dataset']]=zfsmExplorerGuid($job['dataset']);saveAcceptance();
    passed('Convert '.$name.' original inode retained',zfsmDirectoryIdentity($job['recovery'])===$identity);passed('Convert '.$name.' SHA-256 source and copy',hash_file('sha256',$path.'/payload')===$sha&&hash_file('sha256',$job['recovery'].'/payload')===$sha,['sha256'=>$sha]);clearstatcache();passed('Convert '.$name.' owner/mode/symlink/hardlink',fileowner($path)===99&&(fileperms($path)&07777)===$mode&&is_link($path.'/symlink')&&fileinode($path.'/payload')===fileinode($path.'/hardlink'));
    $properties=getAllDatasetProperties($job['dataset'],0);$metadata=acceptanceMetadata($properties,$mode===02777);$state['metadata'][$name]=$metadata;saveAcceptance();passed('ACL backend entries verified for '.$name,true,$metadata['acl']);echo json_encode(['name'=>'Observed usage classifications for '.$name,'status'=>'OBSERVED','detail'=>$metadata['usage']],JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)."\n";passed('New job has durable recorded stages',($job['stage_history_complete']??false)===true&&count($job['stage_history'])>=8,['events'=>count($job['stage_history'])]);
}
function runAcceptance($phase){
    global $dataset,$guid,$stateFile,$base,$state,$stateHandle,$stateCreated;
    $dataset=getenv('ZFSD_TEST_DATASET');$guid=getenv('ZFSD_TEST_GUID');$stateFile=getenv('ZFSD_TEST_STATE');
    if(PHP_SAPI!=='cli'||posix_geteuid()!==0||!is_string($dataset)||!preg_match('/^cache\/zfs-director-acceptance-20261018T[0-9]{6}-[a-f0-9]{6}$/D',$dataset)||!preg_match('/^[1-9][0-9]*$/D',$guid?:'')||!is_string($stateFile)||!preg_match('#^/tmp/zfs-director-update-20261018T[0-9]{6}-[a-f0-9]{6}/acceptance-state.json$#D',$stateFile)||!in_array($phase,['operations','inspect'],true))throw new RuntimeException('Exact newly created acceptance identity and supported phase required');
    $base='/mnt/'.$dataset;$state=null;$running=false;
    try{
        acceptanceOpenState($phase==='operations');rewind($stateHandle);$bytes=stream_get_contents($stateHandle,1048577);if(strlen($bytes)>1048576)throw new RuntimeException('Acceptance state too large');
        $state=$stateCreated?['dataset'=>$dataset,'guid'=>$guid,'checks'=>[],'jobs'=>[],'objects'=>[$dataset=>$guid]]:json_decode($bytes,true,160,JSON_THROW_ON_ERROR);
        if(!is_array($state)||($state['dataset']??null)!==$dataset||($state['guid']??null)!==$guid||!is_array($state['checks']??null)||!is_array($state['jobs']??null)||!is_array($state['objects']??null))throw new RuntimeException('Acceptance state identity/shape changed');
        if($phase==='inspect'){echo json_encode($state,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)."\n";return;}
        acceptanceFreshRun();ownIdentity();if(scandir($base)!==['.','..'])throw new RuntimeException('Fresh empty acceptance dataset required');if(testProcess('zfs',['get','-H','-p','-o','value','quota',$dataset])!=='268435456')throw new RuntimeException('Expected quota missing');
        $state['phase']='started';saveAcceptance();$running=true;conversion('convert-0777',0777);
        protectFixtures();testProcess('/usr/bin/setfacl',['-m','d:u:1001:rwx,d:m::rwx','--',$base]);conversion('convert-sgid-acl',02777);
        passed('Default ACL retained on converted source',str_contains(testProcess('/usr/bin/getfacl',['--numeric','--omit-header','--',$base.'/convert-sgid-acl']),'default:user:1001:rwx'));
        protectFixtures();fixtureDirectory($base.'/move-parent');fixtureDirectory($base.'/destination');fixtureDirectory($base.'/move-parent/source');$sha=fixtureContents($base.'/move-parent/source');$before=zfsmDirectoryIdentity($base.'/move-parent/source');exposeFixtures([$base.'/move-parent'=>0777,$base.'/destination'=>0777,$base.'/move-parent/source'=>0777]);
        $answer=lockedTest(fn()=>moveDirectory($base.'/move-parent/source',$base.'/destination/moved'));passed('Move under ordinary permissions',successful($answer),['result'=>$answer]);passed('Move inode and SHA-256',!file_exists($base.'/move-parent/source')&&zfsmDirectoryIdentity($base.'/destination/moved')===$before&&hash_file('sha256',$base.'/destination/moved/payload')===$sha,['sha256'=>$sha]);
        protectFixtures();fixtureDirectory($base.'/outside');file_put_contents($base.'/outside/sentinel','untouched synthetic sibling');$outside=hash_file('sha256',$base.'/outside/sentinel');fixtureDirectory($base.'/delete-me');fixtureDirectory($base.'/delete-me/nested');for($i=0;$i<20;$i++)file_put_contents($base.'/delete-me/nested/file-'.$i,'synthetic '.$i);symlink('../outside',$base.'/delete-me/escape');exposeFixtures([$base.'/outside'=>0777,$base.'/delete-me'=>0777,$base.'/delete-me/nested'=>0777]);
        $answer=lockedTest(fn()=>deleteDirectory($base.'/delete-me','1'));passed('Recursive Delete under ordinary permissions',successful($answer),['result'=>$answer]);passed('Delete does not follow sibling symlink',!file_exists($base.'/delete-me')&&hash_file('sha256',$base.'/outside/sentinel')===$outside,['sha256'=>$outside]);ownIdentity();passed('Host root metadata unchanged',rootMetadata()===$state['root_metadata']);$state['phase']='completed';saveAcceptance();
    }catch(Throwable$error){if($running&&is_array($state)&&is_resource($stateHandle)){$state['failure']=$error->getMessage();saveAcceptance();}throw $error;}
    finally{if(is_resource($stateHandle)){flock($stateHandle,LOCK_UN);fclose($stateHandle);$stateHandle=null;}}
}

// Driver entry point. Tests load definitions only from a virtual filesystem copy.
if(PHP_SAPI!=='cli')exit(2);
require '/usr/local/emhttp/plugins/zfs.master.ui/backend/ZFSMOperations.php';
try{runAcceptance($argv[1]??'');}catch(Throwable$error){fwrite(STDERR,$error->getMessage()."\n");exit(1);}
