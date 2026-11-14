<?php
// TEST-011: restoring a file from a snapshot and deleting a dataset through the plugin's own
// code on real ZFS. Runs as root inside the disposable VM only (see setup.sh). Prints nothing on
// success except a JSON report written to $argv[1].
if(PHP_SAPI!=='cli'||posix_geteuid()!==0)exit(2);
if(!is_file('/etc/zfsm-disposable-vm'))throw new RuntimeException('Only for the disposable test VM (marker /etc/zfsm-disposable-vm).');
require dirname(__DIR__,2).'/src/backend/ZFSMOperations.php';
$base='/var/lib/zfs-director-real-scenarios';$pool='zfsmscn';$secret='real-zfs-stand-secret';
$GLOBALS['plugin_config']=$base.'/director.cfg';$GLOBALS['plugin_state']=$base.'/jobs';$GLOBALS['plugin_runtime']=$base.'/runtime';$GLOBALS['plugin_lock']=$base.'/mutation.lock';$GLOBALS['plugin_audit']=$base.'/audit';
$GLOBALS['plugin_worker_lock']=$base.'/worker.lock';$GLOBALS['plugin_service_lock']=$base.'/service.lock';
function parse_plugin_cfg($p,$s){return parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_RAW)?:[];}
function sh(string $cmd): string {$out=[];exec($cmd.' 2>&1',$out,$code);if($code!==0)throw new RuntimeException($cmd.': '.implode("\n",$out));return implode("\n",$out);}
function expect($ok,$message){if(!$ok)throw new RuntimeException($message);}
$checks=[];
function check(string $name,callable $fn){global $checks;try{$checks[]=['name'=>$name,'status'=>'PASS','detail'=>$fn()];}catch(Throwable $e){$checks[]=['name'=>$name,'status'=>'FAIL','error'=>$e->getMessage()];}}
if(trim((string)@shell_exec('zpool list -H -o name '.$pool.' 2>/dev/null'))===$pool)sh('zpool destroy -f '.$pool);
sh('rm -rf '.escapeshellarg($base));mkdir($base,0700,true);foreach(['jobs','runtime','audit']as$d)mkdir($base.'/'.$d,0700);
file_put_contents($GLOBALS['plugin_config'],"[general]\nsanoid_integration=\"0\"\ndestructive_mode=\"1\"\nlazy_load=\"0\"\n");touch($GLOBALS['plugin_lock']);
sh('truncate -s 512M '.$base.'/vdev.img');
sh('zpool create -f -o cachefile=none -O mountpoint='.$base.'/mnt '.$pool.' '.$base.'/vdev.img');
$data=$pool.'/data';$mount=$base.'/mnt/data';
sh('zfs create '.$data);mkdir($mount.'/folder',0755);
file_put_contents($mount.'/notes.txt',"ORIGINAL NOTES\n");file_put_contents($mount.'/folder/a.txt',"original a\n");
sh('zfs snapshot '.$data.'@base');
file_put_contents($mount.'/notes.txt',"CHANGED AFTER THE SNAPSHOT\n");
$retained=null;
check('restoring a file from a snapshot over a changed file puts the original back and retains the replaced one',function()use($data,$mount,$secret,&$retained){
    $snapshot=$data.'@base';$guid=zfsmReadIdentity($snapshot)['guid'];
    $preview=zfsmPreviewRestore($snapshot,['notes.txt'],'','overwrite',$secret,$guid);
    expect(count($preview['conflicts'])===1,'conflicts: '.json_encode($preview['conflicts']));
    $job=zfsmQueueRestore($preview['id'],$preview['token'],$secret,'1');$id=$job['job']['id']??$job['id']??null;expect(is_string($id),'queued: '.json_encode($job));
    zfsmRunRestoreJob($id);$done=zfsmReadJob($id);
    expect($done['state']==='completed','restore job: '.json_encode(['state'=>$done['state'],'stage'=>$done['stage'],'error'=>$done['error']??null]));
    expect(file_get_contents($mount.'/notes.txt')==="ORIGINAL NOTES\n",'restored content: '.file_get_contents($mount.'/notes.txt'));
    $retained=$mount.'/.zfsm-restore-'.$id;
    expect(file_get_contents($retained.'/replaced/notes.txt')==="CHANGED AFTER THE SNAPSHOT\n",'replaced file retained');
    return ['job'=>$id,'state'=>$done['state'],'retained'=>basename($retained)];});
check('the retained folder describes itself after its job record is gone',function()use(&$retained){
    expect($retained!==null,'no retained folder');
    $id=substr(basename($retained),strlen('.zfsm-restore-'));
    foreach(glob($GLOBALS['plugin_state'].'/'.$id.'.json')?:[] as$file)unlink($file);
    $info=zfsmRestoreRetainedInfo($retained);
    expect(str_ends_with((string)$info['snapshot'],'@base')&&is_string($info['restored_at']),'info: '.json_encode($info));
    return ['snapshot'=>$info['snapshot'],'destination'=>$info['destination']];});
check('the retained folder is deleted by a deletion job with the real folder helper',function()use($data,&$retained,$mount){
    $guid=zfsmReadIdentity($data)['guid'];
    zfsmGuardMutationIdentity('deletedirectory',['directory'=>$retained,'expected_guid'=>$guid,'directory_identity'=>zfsmDirectoryIdentity($retained)]);
    $job=zfsmQueueDeletion('directory',$retained,true)['job'];$done=zfsmRunDeletionJob($job['id']);
    expect($done['state']==='completed'&&!file_exists($retained),'deletion: '.json_encode(['state'=>$done['state'],'error'=>$done['error']??null]));
    expect(file_get_contents($mount.'/notes.txt')==="ORIGINAL NOTES\n",'the restored file survived');
    return ['state'=>$done['state']];});
check('a dataset with a child and snapshots is deleted by a reviewed deletion job and its absence is verified',function()use($pool,$secret){
    // Not mounted (canmount=noauto): systemd services in the VM keep private copies of every new mount, and
    // the plugin rightly refuses to destroy a mounted dataset another mount namespace still holds.
    $target=$pool.'/delete-target';sh('zfs create -o canmount=noauto '.$target);sh('zfs create -o canmount=noauto '.$target.'/child');sh('zfs snapshot -r '.$target.'@reviewed');
    $preview=zfsmPreviewDestroy($target,'1',$secret);expect($preview['can_destroy'],'preview blocked: '.json_encode($preview['diagnostics']??null));
    $scope=zfsmValidateDestroyPreview($target,'1',$secret,$preview['preview_id'],$preview['token']);
    $job=zfsmQueueDeletion('dataset',$target,true,$scope)['job'];$done=zfsmRunDeletionJob($job['id']);
    expect($done['state']==='completed'&&($done['result']['state_verified']??false)&&!zfsmDatasetExists($target),'dataset deletion: '.json_encode($done['result']??$done));
    return ['removed'=>$done['result']['removed_count']??null];});
sh('zpool destroy -f '.$pool);
$report=['checks'=>$checks,'failed'=>count(array_filter($checks,fn($c)=>$c['status']!=='PASS'))];
file_put_contents($argv[1]??($base.'/scenarios.json'),json_encode($report,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES)."\n");
exit($report['failed']?1:0);
