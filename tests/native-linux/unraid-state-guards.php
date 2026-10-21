<?php
/** Native state guards only; never load Operations or run acceptance operations. */
error_reporting(E_ALL);
set_error_handler(static function($level,$message,$file,$line){if(!(error_reporting()&$level))return false;throw new ErrorException($message,0,$level,$file,$line);});
$source=file_get_contents('/stand/tests/unraid/directory-acceptance.php');token_get_all($source,TOKEN_PARSE);
$start=strpos($source,'function ');$end=strpos($source,"\n// Driver entry point");if($start===false||$end===false||$end<=$start)throw new RuntimeException('Cannot isolate driver definitions');eval(substr($source,$start,$end-$start));
function nativeCheck($ok,$why){if(!$ok)throw new RuntimeException($why);}
if(($argv[1]??'')==='lock-child'){
    $handle=fopen($argv[2],'rb');$mode=$argv[3]==='shared'?LOCK_SH:LOCK_EX;
    if(flock($handle,$mode|LOCK_NB)){fclose($handle);fwrite(STDERR,'Child unexpectedly acquired held state lock');exit(1);}fclose($handle);exit(0);
}
function nativeRefused($fn){try{$fn();}catch(Throwable$error){return;}throw new RuntimeException('Unsafe native state accepted');}
function nativeState(){
    global $stateFile,$state,$stateHandle;$parent='/tmp/zfs-director-update-20261018T120000-'.bin2hex(random_bytes(3));nativeCheck(mkdir($parent,0700),'Private state directory creation failed');$stateFile=$parent.'/acceptance-state.json';$state=['synthetic'=>'state only'];$stateHandle=null;return $parent;
}
function nativeClose(){global $stateHandle;if(is_resource($stateHandle)){flock($stateHandle,LOCK_UN);fclose($stateHandle);$stateHandle=null;}}
$rootBefore=lstat('/');$parents=[];$checks=[];
try{
    $parents[]=nativeState();acceptanceOpenState(true);saveAcceptance();$metadata=lstat($stateFile);nativeCheck(($metadata['mode']&07777)===0600&&$metadata['uid']===0&&$metadata['nlink']===1,'Created state not root0600/nlink1');nativeCheck(json_decode(file_get_contents($stateFile),true)===$state,'Saved state differs');$checks[]='valid root0700 parent and root0600/nlink1 state create/save';
    foreach(['shared','exclusive']as$mode){$pipes=[];$child=proc_open([PHP_BINARY,__FILE__,'lock-child',$stateFile,$mode],[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes);nativeCheck(is_resource($child),'Cannot create lock child');fclose($pipes[0]);$out=stream_get_contents($pipes[1]);$err=stream_get_contents($pipes[2]);fclose($pipes[1]);fclose($pipes[2]);nativeCheck(proc_close($child)===0,'State lock failed: '.$out.$err);}$checks[]='separate native PHP processes cannot acquire SH or EX while parent holds EX';nativeClose();
    $parents[]=nativeState();$victim=dirname($stateFile).'/victim';file_put_contents($victim,'KEEP');chmod($victim,0600);nativeCheck(link($victim,$stateFile),'Cannot create native hardlink');nativeCheck(lstat($stateFile)['nlink']===2,'Hardlink test did not create nlink2');nativeRefused(fn()=>acceptanceOpenState(true));nativeCheck(file_get_contents($victim)==='KEEP','Hardlink victim modified');$checks[]='actual native nlink2 hardlinked state refused before truncation';
    $parents[]=nativeState();acceptanceOpenState(true);saveAcceptance();rename($stateFile,$stateFile.'.retained');$victim=dirname($stateFile).'/victim';file_put_contents($victim,'KEEP');chmod($victim,0600);symlink($victim,$stateFile);nativeRefused(fn()=>saveAcceptance());nativeCheck(file_get_contents($victim)==='KEEP','Symlink victim modified');$checks[]='symlink substitution before save refuses without changing victim';nativeClose();
    $parents[]=nativeState();file_put_contents($stateFile,'KEEP');chmod($stateFile,0644);nativeRefused(fn()=>acceptanceOpenState(true));nativeCheck(file_get_contents($stateFile)==='KEEP'&&(fileperms($stateFile)&07777)===0644,'Permissive state was repaired or truncated');$checks[]='permissive existing state refused unchanged';
    $parents[]=nativeState();acceptanceOpenState(true);saveAcceptance();rename($stateFile,$stateFile.'.retained');file_put_contents($stateFile,'REPLACEMENT');chmod($stateFile,0600);nativeRefused(fn()=>saveAcceptance());nativeCheck(file_get_contents($stateFile)==='REPLACEMENT','Replacement identity truncated');$checks[]='regular file identity swap before save refuses unchanged';nativeClose();
    $parents[]=nativeState();chmod(dirname($stateFile),0777);nativeRefused(fn()=>acceptanceOpenState(true));nativeCheck(!file_exists($stateFile),'Unsafe parent created a state file');chmod(dirname($stateFile),0700);$checks[]='nonprivate state parent refused before file creation';
    $rootAfter=lstat('/');foreach(['dev','ino','mode','uid','gid']as$key)nativeCheck($rootBefore[$key]===$rootAfter[$key],'Host root metadata changed');
    echo json_encode(['status'=>'PASS','checks'=>$checks,'driver_sha256'=>hash('sha256',$source),'test_sha256'=>hash_file('sha256',__FILE__),'php'=>PHP_VERSION,'constraints'=>['only extracted function definitions','no Operations include','no ownIdentity/fixture/driver operations or ZFS','no chmod/chown of filesystem root']],JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)."\n";
}finally{
    nativeClose();foreach($parents as$parent){chmod($parent,0700);foreach(scandir($parent)as$name)if($name!=='.'&&$name!=='..')unlink($parent.'/'.$name);rmdir($parent);}
}
