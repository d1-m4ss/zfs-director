<?php
/** Explicitly authorized native acceptance. Never invoke against an existing user dataset. */
if (PHP_SAPI !== 'cli') exit(2);
require '/usr/local/emhttp/plugins/zfs.master.ui/backend/ZFSMOperations.php';
$root=getenv('ZFSD_TEST_DATASET');$rootGuid=getenv('ZFSD_TEST_GUID');
if($root!=='cache/zfs-director-acceptance-20261016T225600'||$rootGuid!=='1484883988092487105')throw new RuntimeException('Exact authorized test identity required');
zfsmRequireIdentity($root,$rootGuid);
$base='/mnt/'.$root;$stateFile='/tmp/zfs-director-install-20261016-2/acceptance-state.json';
$state=is_file($stateFile)?json_decode(file_get_contents($stateFile),true,160,JSON_THROW_ON_ERROR):['root'=>$root,'root_guid'=>$rootGuid,'objects'=>[],'checks'=>[]];
function acceptScope($name){global $root;return $name===$root||str_starts_with($name,$root.'/')||str_starts_with($name,$root.'@');}
function acceptSaveState(){global $state,$stateFile;file_put_contents($stateFile,json_encode($state,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES)."\n",LOCK_EX);}
function acceptCheck($name,$assertion,$detail=[]){global $state;if(!$assertion)throw new RuntimeException('FAIL '.$name);$state['checks'][]=['name'=>$name,'status'=>'PASS','detail'=>$detail];echo json_encode(end($state['checks']),JSON_UNESCAPED_SLASHES)."\n";acceptSaveState();}
function acceptZfs($args){$target=end($args);if(!acceptScope($target))throw new RuntimeException('Out of scope native target');$r=runProcess('zfs',$args);if($r['code']!==0)throw new RuntimeException('Native ZFS failed: '.$r['output']);return trim($r['output']);}
function acceptRemember($name){global $state;if(!acceptScope($name))throw new RuntimeException('Out of scope object');$state['objects'][$name]=zfsmExplorerGuid($name);acceptSaveState();return $state['objects'][$name];}
function acceptIdentity($name){global $state;if(!acceptScope($name)||!isset($state['objects'][$name]))throw new RuntimeException('Unrecorded target');zfsmRequireIdentity($name,$state['objects'][$name]);}
function acceptMutate($name,$operation){global $root,$rootGuid;zfsmRequireIdentity($root,$rootGuid);if(!acceptScope($name))throw new RuntimeException('Out of scope mutation');$lock=fopen($GLOBALS['plugin_lock'],'c');if(!$lock)throw new RuntimeException('Plugin lock unavailable');$until=microtime(true)+5;while(!flock($lock,LOCK_EX|LOCK_NB)){if(microtime(true)>$until)throw new RuntimeException('Plugin busy');usleep(20000);}try{$GLOBALS['zfsm_operation_lock_handle']=$lock;return $operation();}finally{unset($GLOBALS['zfsm_operation_lock_handle']);flock($lock,LOCK_UN);fclose($lock);}}
function acceptSuccess($r){return is_array($r)&&!empty($r['succeeded'])&&empty($r['failed']);}
function acceptRefused($fn){try{$r=$fn();return is_array($r)&&!empty($r['failed']);}catch(Throwable $e){return true;}}
function acceptWaitJob($id,$timeout=45){$until=microtime(true)+$timeout;do{$job=zfsmReadJob($id);if(!in_array($job['state'],['queued','running'],true))return $job;usleep(100000);}while(microtime(true)<$until);throw new RuntimeException('Timed out waiting for own job '.$id);}
function acceptQueueRestore($snapshot,$selection,$target,$mode){global $state;$secret='synthetic-acceptance-signing-secret';$preview=zfsmPreviewRestore($snapshot,$selection,$target,$mode,$secret,$state['objects'][$snapshot]);$job=zfsmQueueRestore($preview['id'],$preview['token'],$secret,'1');$state['own_jobs'][]=$job['id'];acceptSaveState();return $job;}
function acceptStartWorker(){global $root;foreach(zfsmPendingJobs() as $job)if(!acceptScope($job['dataset']))throw new RuntimeException('Foreign pending job: startup blocked');@unlink($GLOBALS['plugin_runtime'].'/stop');zfsmStartWorker();}
function acceptHashes($path){global $base;if(!str_starts_with($path,$base.'/')||is_link($path))throw new RuntimeException('Out of scope hash traversal');$out=[];if(is_dir($path))foreach(new RecursiveIteratorIterator(new RecursiveDirectoryIterator($path,FilesystemIterator::SKIP_DOTS)) as $f)if($f->isFile()&&!$f->isLink())$out[substr($f->getPathname(),strlen($path)+1)]=hash_file('sha256',$f->getPathname());ksort($out);return $out;}

try {
if(($argv[1]??'')==='basic'){
 acceptCheck('GUI-created root GUID/quota/mount',acceptZfs(['get','-H','-p','-o','value','quota',$root])==='1073741824'&&acceptZfs(['get','-H','-o','value','mounted',$root])==='yes');
 $work=$root.'/work';acceptCheck('backend create dataset',acceptMutate($work,fn()=>acceptSuccess(createDataset($work,['compression'=>'off']))));acceptRemember($work);
 acceptCheck('native create result',acceptZfs(['get','-H','-o','value','compression',$work])==='off');
 acceptIdentity($work);acceptCheck('backend rename dataset',acceptMutate($work,fn()=>acceptSuccess(renameDataset($work,$root.'/files','0'))));$files=$root.'/files';$oldGuid=$state['objects'][$work];unset($state['objects'][$work]);acceptRemember($files);acceptCheck('rename preserved GUID',$state['objects'][$files]===$oldGuid&&!zfsmDatasetExists($work));
 acceptCheck('backend set property',acceptMutate($files,fn()=>acceptSuccess(setDatasetProperty($files,'atime','on'))));acceptCheck('native property result',acceptZfs(['get','-H','-o','value','atime',$files])==='on');
 acceptCheck('backend inherit compression',acceptMutate($files,fn()=>acceptSuccess(setDatasetProperty($files,'compression','inherit'))));acceptCheck('native inherited property/source',str_contains(acceptZfs(['get','-H','-o','value,source','compression',$files]),"lz4\tinherited from ".$root));
 $path='/mnt/'.$files;mkdir($path.'/docs');mkdir($path.'/many');mkdir($path.'/empty');
 $fixture=['hello.txt'=>"ZFS Director native acceptance\n",'docs/unicode-ї файл.txt'=>"Unicode original\n",'.hidden'=>"hidden synthetic\n",'docs/data.bin'=>hash('sha256','synthetic',true)];
 foreach($fixture as $p=>$data){file_put_contents($path.'/'.$p,$data);$state['fixture_sha256'][$p]=hash('sha256',$data);}
 for($i=0;$i<125;$i++)file_put_contents($path.'/many/file-'.sprintf('%03d',$i).'.txt',"synthetic $i\n");
 symlink('docs',$path.'/internal-link');symlink('/etc',$path.'/escape');chmod($path.'/hello.txt',0666);chown($path.'/hello.txt',99);chgrp($path.'/hello.txt',100);
 acceptCheck('backend create snapshot',acceptMutate($files,fn()=>acceptSuccess(createDatasetSnapshot($files,'baseline','0'))));$snap=$files.'@baseline';acceptRemember($snap);
 acceptCheck('snapshot native content SHA256',hash_file('sha256',$path.'/.zfs/snapshot/baseline/hello.txt')===$state['fixture_sha256']['hello.txt']);
 acceptCheck('backend snapshot hold',acceptMutate($snap,fn()=>acceptSuccess(holdDatasetSnapshot($snap))));acceptCheck('native hold exists',str_contains(acceptZfs(['holds','-H',$snap]),'zfsmaster'));
 $blocked=zfsmPreviewDestroy($snap,'0','synthetic-acceptance-signing-secret');acceptCheck('destroy preview blocks held snapshot',$blocked['can_destroy']===false);
 acceptCheck('backend snapshot release',acceptMutate($snap,fn()=>acceptSuccess(releaseDatasetSnapshot($snap))));acceptCheck('native hold removed',acceptZfs(['holds','-H',$snap])==='');
 $clone=$root.'/clone';acceptCheck('backend clone',acceptMutate($clone,fn()=>acceptSuccess(cloneDatasetSnapshot($snap,$clone))));acceptRemember($clone);acceptCheck('native clone content SHA256',hash_file('sha256','/mnt/'.$clone.'/hello.txt')===$state['fixture_sha256']['hello.txt']);
 $blocked=zfsmPreviewDestroy($snap,'0','synthetic-acceptance-signing-secret');acceptCheck('destroy preview detects clone dependency',$blocked['can_destroy']===false&&count($blocked['dependencies'])===1);
 $preview=zfsmPreviewDestroy($clone,'0','synthetic-acceptance-signing-secret');acceptCheck('destroy preview lists exact clone identity',$preview['can_destroy']===true&&$preview['objects'][0]['guid']===$state['objects'][$clone]);
 acceptMutate($clone,function()use($clone,$preview){acceptIdentity($clone);zfsmValidateDestroyPreview($clone,'0','synthetic-acceptance-signing-secret',$preview['preview_id'],$preview['token']);if(!acceptSuccess(destroyDataset($clone,'0')))throw new RuntimeException('Clone destroy failed');});acceptCheck('native clone destruction',!zfsmDatasetExists($clone));unset($state['objects'][$clone]);
 acceptCheck('destroy preview cannot replay',acceptRefused(fn()=>zfsmValidateDestroyPreview($clone,'0','synthetic-acceptance-signing-secret',$preview['preview_id'],$preview['token'])));
 acceptCheck('stale GUID refused',acceptRefused(fn()=>zfsmGuardMutationIdentity('editdatasetproperty',['zdataset'=>$files,'expected_guid'=>'1'])));
 $list=zfsmExplorerList($snap,'','','name','asc','0','0',$state['objects'][$snap]);acceptCheck('native helper snapshot listing',isset($list['entries'])&&count($list['entries'])>=5,['keys'=>array_keys($list)]);
 $page1=zfsmExplorerList($snap,'many','','name','asc','0','0',$state['objects'][$snap]);$page2=zfsmExplorerList($snap,'many','','name','asc','100','0',$state['objects'][$snap]);
 acceptCheck('File Manager real pagination',count($page1['entries'])>0&&count($page2['entries'])>0&&$page1['entries'][0]['name']!==$page2['entries'][0]['name'],['page1'=>count($page1['entries']),'page2'=>count($page2['entries']),'total'=>$page1['total']??null]);
 acceptCheck('path traversal refused',acceptRefused(fn()=>zfsmExplorerList($snap,'../','','name','asc','0','0',$state['objects'][$snap])));
 acceptCheck('symlink escape refused',acceptRefused(fn()=>zfsmExplorerList($snap,'escape','','name','asc','0','0',$state['objects'][$snap])));
 acceptCheck('directory writable-ancestor guard refuses safely',acceptRefused(fn()=>moveDirectory($path.'/docs',$path.'/moved-docs'))&&is_dir($path.'/docs')&&!file_exists($path.'/moved-docs'));
 $state['files_dataset']=$files;$state['snapshot']=$snap;acceptSaveState();
}elseif(($argv[1]??'')==='files'){
 $files=$state['files_dataset'];$snap=$state['snapshot'];$path='/mnt/'.$files;acceptIdentity($files);acceptIdentity($snap);
 acceptCheck('no foreign pending work before worker start',count(zfsmPendingJobs())===0);
 for($i=125;$i<425;$i++)file_put_contents($path.'/many/file-'.sprintf('%03d',$i).'.txt',"synthetic $i\n");
 acceptCheck('pagination snapshot',acceptMutate($files,fn()=>acceptSuccess(createDatasetSnapshot($files,'pagination','0'))));acceptRemember($files.'@pagination');
 $page1=zfsmExplorerList($files.'@pagination','many','','name','asc','0','0',$state['objects'][$files.'@pagination']);$page2=zfsmExplorerList($files.'@pagination','many','','name','asc','200','0',$state['objects'][$files.'@pagination']);
 acceptCheck('real nonoverlapping 200-item pagination',count($page1['entries'])===200&&count($page2['entries'])===200&&$page1['entries'][0]['name']!==$page2['entries'][0]['name']&&$page1['total']===425);
 $job=zfsmQueueArchive($snap,['hello.txt','docs','.hidden','empty'],$state['objects'][$snap]);$state['archive_job']=$job['id'];$state['own_jobs'][]=$job['id'];acceptSaveState();acceptStartWorker();$done=acceptWaitJob($job['id']);
 acceptCheck('background ZIP completed',$done['state']==='completed'&&$done['hold_owned']===false,['job_id'=>$job['id'],'bytes'=>$done['archive_size']??null,'error'=>$done['error']??null]);
 $job=acceptQueueRestore($snap,['hello.txt','docs','empty'],'restored-new','new');$state['restore_new_job']=$job['id'];acceptSaveState();$done=acceptWaitJob($job['id']);acceptCheck('background new restore completed',$done['state']==='completed',['job_id'=>$job['id'],'error'=>$done['error']??null]);
 foreach(['hello.txt','docs/unicode-ї файл.txt','docs/data.bin'] as $file)acceptCheck('new restore SHA256 '.$file,hash_file('sha256',$path.'/restored-new/'.$file)===$state['fixture_sha256'][$file]);
 acceptCheck('new restore preserves empty directory',is_dir($path.'/restored-new/empty'));
 acceptCheck('new restore preserves uid/mode',fileowner($path.'/restored-new/hello.txt')===99&&(fileperms($path.'/restored-new/hello.txt')&0777)===0666);
 file_put_contents($path.'/hello.txt',"modified synthetic original before overwrite\n");$modified=hash_file('sha256',$path.'/hello.txt');
 $preview=zfsmPreviewRestore($snap,['hello.txt','docs'],'','overwrite','synthetic-acceptance-signing-secret',$state['objects'][$snap]);acceptCheck('overwrite preview enumerates conflicts',count($preview['conflicts'])>=1);
 $job=zfsmQueueRestore($preview['id'],$preview['token'],'synthetic-acceptance-signing-secret','1');$state['overwrite_job']=$job['id'];$state['own_jobs'][]=$job['id'];acceptSaveState();$done=acceptWaitJob($job['id']);acceptCheck('overwrite restore completed',$done['state']==='completed',['job_id'=>$job['id'],'error'=>$done['error']??null]);
 acceptCheck('overwrite restores snapshot SHA256',hash_file('sha256',$path.'/hello.txt')===$state['fixture_sha256']['hello.txt']);
 acceptCheck('overwrite retains replaced SHA256',hash_file('sha256',$done['recovery'].'/hello.txt')===$modified,['retained_sha256'=>$modified]);
 $preview=zfsmPreviewRestore($snap,['hello.txt'],'','overwrite','synthetic-acceptance-signing-secret',$state['objects'][$snap]);file_put_contents($path.'/hello.txt',"changed after preview synthetic conflict\n");$conflict=hash_file('sha256',$path.'/hello.txt');
 acceptCheck('stale conflict preview refuses queue',acceptRefused(fn()=>zfsmQueueRestore($preview['id'],$preview['token'],'synthetic-acceptance-signing-secret','1'))&&hash_file('sha256',$path.'/hello.txt')===$conflict);
 acceptCheck('restore selection cannot follow a symlink',acceptRefused(fn()=>zfsmPreviewRestore($snap,['escape'],'unsafe','new','synthetic-acceptance-signing-secret',$state['objects'][$snap])));
 acceptCheck('readonly property can be enabled',acceptMutate($files,fn()=>acceptSuccess(setDatasetProperty($files,'readonly','on'))));
 acceptCheck('readonly dataset refuses restore',acceptRefused(fn()=>zfsmPreviewRestore($snap,['hello.txt'],'readonly-test','new','synthetic-acceptance-signing-secret',$state['objects'][$snap])));
 acceptCheck('readonly property restored',acceptMutate($files,fn()=>acceptSuccess(setDatasetProperty($files,'readonly','off'))));
 acceptCheck('own jobs released all snapshot holds',acceptZfs(['holds','-H',$snap])==='');
}elseif(($argv[1]??'')==='encryption-quota'){
 $secure=$root.'/secure';$child=$secure.'/child';$nested=$child.'/nested-root';
 $keyA='synthetic-director-acceptance-key-A';$keyB='synthetic-director-acceptance-key-B';
 if(!isset($state['objects'][$secure])){
  acceptCheck('create real encryption root',acceptMutate($secure,fn()=>acceptSuccess(createDataset($secure,['encryption'=>'on','keyformat'=>'passphrase','keylocation'=>'prompt','passphrase'=>$keyA]))));acceptRemember($secure);
  acceptCheck('create encryption inheriting child',acceptMutate($child,fn()=>acceptSuccess(createDataset($child,[]))));acceptRemember($child);
  acceptCheck('create nested independent encryption root',acceptMutate($nested,fn()=>acceptSuccess(createDataset($nested,['encryption'=>'on','keyformat'=>'passphrase','keylocation'=>'prompt','passphrase'=>$keyB]))));acceptRemember($nested);
  foreach([$secure,$child,$nested] as $ds){file_put_contents('/mnt/'.$ds.'/marker.txt',"encrypted synthetic $ds\n");$state['encrypted_sha256'][$ds]=hash_file('sha256','/mnt/'.$ds.'/marker.txt');}
 }else{foreach([$secure,$child,$nested] as $ds)acceptIdentity($ds);}
 acceptCheck('native encryption inheritance',acceptZfs(['get','-H','-o','value','encryptionroot',$child])===$secure&&acceptZfs(['get','-H','-o','value','encryptionroot',$nested])===$nested);
 acceptCheck('Lock refuses inherited child',acceptMutate($child,fn()=>acceptRefused(fn()=>lockDataset($child))));
 $r=acceptMutate($secure,fn()=>lockDataset($secure));
 acceptCheck('mounted nested root safely blocks parent Lock',!empty($r['failed'])&&acceptZfs(['get','-H','-o','value','keystatus',$secure])==='available'&&acceptZfs(['get','-H','-o','value','mounted',$child])==='yes'&&acceptZfs(['get','-H','-o','value','mounted',$nested])==='yes');
 acceptCheck('Lock nested root',acceptMutate($nested,fn()=>acceptSuccess(lockDataset($nested))));
 acceptCheck('Lock parent with dependent child',acceptMutate($secure,fn()=>acceptSuccess(lockDataset($secure))));
 acceptCheck('native locked state',acceptZfs(['get','-H','-o','value','keystatus',$secure])==='unavailable'&&acceptZfs(['get','-H','-o','value','mounted',$child])==='no');
 acceptCheck('wrong key refused without mounting',acceptMutate($secure,fn()=>acceptRefused(fn()=>unlockDataset($secure,'incorrect-synthetic-key')))&&acceptZfs(['get','-H','-o','value','keystatus',$secure])==='unavailable');
 acceptCheck('Unlock parent root',acceptMutate($secure,fn()=>acceptSuccess(unlockDataset($secure,$keyA))));
 acceptCheck('Unlock root is honest about descendant mount state',acceptZfs(['get','-H','-o','value','mounted',$secure])==='yes'&&acceptZfs(['get','-H','-o','value','mounted',$child])==='no');
 acceptZfs(['mount',$child]);
 acceptCheck('Unlock nested root',acceptMutate($nested,fn()=>acceptSuccess(unlockDataset($nested,$keyB))));
 foreach([$secure,$child,$nested] as $ds)acceptCheck('encryption roundtrip SHA256 '.$ds,hash_file('sha256','/mnt/'.$ds.'/marker.txt')===$state['encrypted_sha256'][$ds]);
 $space=$root.'/quota-case';acceptCheck('create quota-isolated ENOSPC dataset',acceptMutate($space,fn()=>acceptSuccess(createDataset($space,['compression'=>'off','quota'=>'32M']))));acceptRemember($space);
 $path='/mnt/'.$space;$file=fopen($path.'/large.bin','xb');for($i=0;$i<18;$i++){if(fwrite($file,random_bytes(1024*1024))!==1024*1024)throw new RuntimeException('Synthetic fixture write failed');}fflush($file);fsync($file);fclose($file);$hash=hash_file('sha256',$path.'/large.bin');
 acceptCheck('create quota source snapshot',acceptMutate($space,fn()=>acceptSuccess(createDatasetSnapshot($space,'source','0'))));$snap=$space.'@source';acceptRemember($snap);unlink($path.'/large.bin');
 $job=acceptQueueRestore($snap,['large.bin'],'enospc-result','new');$state['enospc_job']=$job['id'];acceptSaveState();acceptStartWorker();$done=acceptWaitJob($job['id']);
 acceptCheck('real quota ENOSPC fails closed with retained partial staging',$done['state']==='recovery_required'&&is_dir($done['staging'])&&!file_exists($path.'/enospc-result'),['job_id'=>$job['id'],'error'=>$done['error']??null]);
 acceptCheck('ENOSPC preserves snapshot SHA256',hash_file('sha256',$path.'/.zfs/snapshot/source/large.bin')===$hash&&$done['hold_owned']===false,['sha256'=>$hash]);
 acceptCheck('increase only test quota for explicit fresh recovery',acceptMutate($space,fn()=>acceptSuccess(setDatasetProperty($space,'quota','96M'))));
 $recovery=acceptQueueRestore($snap,['large.bin'],'fresh-recovery','new');$state['quota_recovery_job']=$recovery['id'];acceptSaveState();$done=acceptWaitJob($recovery['id']);
 acceptCheck('fresh explicit recovery after ENOSPC',$done['state']==='completed'&&hash_file('sha256',$path.'/fresh-recovery/large.bin')===$hash,['job_id'=>$recovery['id']]);
 acceptCheck('failed ENOSPC job was not retried',zfsmReadJob($job['id'])['state']==='recovery_required');
}elseif(($argv[1]??'')==='mount-and-idempotency'){
 $files=$state['files_dataset'];$snap=$state['snapshot'];$child=$files.'/mount-boundary';acceptIdentity($files);acceptIdentity($snap);
 acceptCheck('create real nested mount boundary',acceptMutate($child,fn()=>acceptSuccess(createDataset($child,[]))));acceptRemember($child);file_put_contents('/mnt/'.$child.'/marker.txt',"synthetic mount boundary\n");$hash=hash_file('sha256','/mnt/'.$child.'/marker.txt');
 acceptCheck('restore preview refuses crossing a mounted child',acceptRefused(fn()=>zfsmPreviewRestore($snap,['hello.txt'],'mount-boundary','overwrite','synthetic-acceptance-signing-secret',$state['objects'][$snap]))&&hash_file('sha256','/mnt/'.$child.'/marker.txt')===$hash);
 $preview=zfsmPreviewRestore($snap,['hello.txt'],'idempotent-restore','new','synthetic-acceptance-signing-secret',$state['objects'][$snap]);
 $first=zfsmQueueRestore($preview['id'],$preview['token'],'synthetic-acceptance-signing-secret','1');$second=zfsmQueueRestore($preview['id'],$preview['token'],'synthetic-acceptance-signing-secret','1');$state['own_jobs'][]=$first['id'];acceptSaveState();
 acceptCheck('duplicate reviewed restore queues one job',$first['id']===$second['id']);acceptStartWorker();$done=acceptWaitJob($first['id']);acceptCheck('idempotent restore SHA256',$done['state']==='completed'&&hash_file('sha256','/mnt/'.$files.'/idempotent-restore/hello.txt')===$state['fixture_sha256']['hello.txt']);
 $p=zfsmPreviewDestroy($child,'0','synthetic-acceptance-signing-secret');acceptMutate($child,function()use($child,$p){acceptIdentity($child);zfsmValidateDestroyPreview($child,'0','synthetic-acceptance-signing-secret',$p['preview_id'],$p['token']);if(!acceptSuccess(destroyDataset($child,'0')))throw new RuntimeException('Own mounted child destroy failed');});acceptCheck('own nested mount cleanup',!zfsmDatasetExists($child));unset($state['objects'][$child]);acceptSaveState();
}elseif(($argv[1]??'')==='interrupt'){
 $files=$state['files_dataset'];$path='/mnt/'.$files;acceptIdentity($files);
 acceptCheck('no pending work before isolated worker interruption',count(zfsmPendingJobs())===0);
 $stop=runProcess(PHP_BINARY,['/usr/local/emhttp/plugins/zfs.master.ui/scripts/zfsm-worker.php','--stop']);acceptCheck('supervised worker stopped before isolated test',$stop['code']===0);
 mkdir($path.'/interrupt-source');for($i=0;$i<4000;$i++)file_put_contents($path.'/interrupt-source/file-'.sprintf('%04d',$i).'.txt',str_repeat("synthetic-$i\n",80));
 $original=acceptHashes($path.'/interrupt-source');$state['interrupt_sha256_manifest']=$original;
 acceptCheck('interrupt source snapshot',acceptMutate($files,fn()=>acceptSuccess(createDatasetSnapshot($files,'interrupt','0'))));$snap=$files.'@interrupt';acceptRemember($snap);
 $job=acceptQueueRestore($snap,['interrupt-source'],'interrupted-target','new');$id=$job['id'];$state['interrupted_job']=$id;acceptSaveState();
 @unlink($GLOBALS['plugin_runtime'].'/stop');$pipes=[];$process=proc_open([PHP_BINARY,'/usr/local/emhttp/plugins/zfs.master.ui/scripts/zfsm-worker.php','--daemon'],[0=>['file','/dev/null','r'],1=>['file','/tmp/zfs-director-install-20261016-2/isolated-worker.log','a'],2=>['redirect',1]],$pipes);if(!is_resource($process))throw new RuntimeException('Isolated worker failed to start');$pid=proc_get_status($process)['pid'];
 $until=microtime(true)+15;$partial=[];do{$current=zfsmReadJob($id);if($current['state']==='running'&&$current['stage']==='copying'){$partial=acceptHashes($current['staging'].'/data');if(count($partial)>0&&count($partial)<4000)break;}if(!in_array($current['state'],['queued','running'],true))throw new RuntimeException('Copy finished before interrupt; no signal sent');usleep(10000);}while(microtime(true)<$until);
 if(!$partial||count($partial)>=4000||!proc_get_status($process)['running']||posix_getpgid($pid)!==$pid)throw new RuntimeException('Isolated process ownership/partial-copy precondition missing; no signal sent');
 foreach(zfsmPendingJobs() as $pending)if($pending['id']!==$id||$pending['dataset']!==$files)throw new RuntimeException('Unexpected pending job; no signal sent');
 if(!posix_kill(-$pid,19))throw new RuntimeException('Unable to freeze own isolated group');
 $frozen=acceptHashes($current['staging'].'/data');if(!posix_kill(-$pid,9))throw new RuntimeException('Unable to terminate own isolated test group');proc_close($process);
 acceptCheck('real isolated worker interrupted during partial copy',count($frozen)>0&&count($frozen)<4000&&zfsmReadJob($id)['state']==='running',['job_id'=>$id,'partial_files'=>count($frozen)]);
 acceptStartWorker();$recovered=acceptWaitJob($id);
 acceptCheck('restart marks interrupted restore for inspection',$recovered['state']==='recovery_required'&&$recovered['hold_owned']===false&&!file_exists($path.'/interrupted-target'));
 acceptCheck('restart does not resume partial file publication',acceptHashes($current['staging'].'/data')===$frozen&&acceptHashes($path.'/interrupt-source')===$original);
 $fresh=acceptQueueRestore($snap,['interrupt-source'],'fresh-after-interrupt','new');$state['interrupt_recovery_job']=$fresh['id'];acceptSaveState();$done=acceptWaitJob($fresh['id']);
 acceptCheck('explicit fresh restore after interruption SHA256',$done['state']==='completed'&&acceptHashes($path.'/fresh-after-interrupt/interrupt-source')===$original,['files'=>count($original),'job_id'=>$fresh['id']]);
 acceptCheck('interrupted job remains inspection-only',zfsmReadJob($id)['state']==='recovery_required');
}elseif(($argv[1]??'')==='corrupt-journal'){
 $id=$state['quota_recovery_job'];$job=zfsmReadJob($id);acceptIdentity($job['dataset']);if($job['state']!=='completed'||$job['hold_owned']||!acceptScope($job['dataset']))throw new RuntimeException('Only an owned completed unprotected test journal can be fault-injected');
 acceptCheck('no pending work before journal fault injection',count(zfsmPendingJobs())===0);
 $stop=runProcess(PHP_BINARY,['/usr/local/emhttp/plugins/zfs.master.ui/scripts/zfsm-worker.php','--stop']);if($stop['code']!==0)throw new RuntimeException('Cooperative stop failed');
 $file=zfsmJobFile($id);$original=file_get_contents($file);$broken='{synthetic-test-invalid-json';file_put_contents('/tmp/zfs-director-install-20261016-2/journal-before-corruption.json',$original);
 acceptMutate($job['dataset'],fn()=>file_put_contents($file,$broken,LOCK_EX));
 $page=zfsmJobPage();$found=null;foreach($page['jobs'] as $row)if($row['id']===$id)$found=$row;
 acceptCheck('corrupted own journal reports recovery_required',$found&&$found['state']==='recovery_required');
 acceptStartWorker();usleep(750000);
 acceptCheck('worker leaves corrupt journal untouched',file_get_contents($file)===$broken);
 acceptMutate($job['dataset'],function()use($file,$broken,$original){if(file_get_contents($file)!==$broken)throw new RuntimeException('Journal changed; refuse restore over newer state');$lock=fopen($file.'.lock','c');if(!$lock||!flock($lock,LOCK_EX|LOCK_NB))throw new RuntimeException('Job lock unavailable');try{zfsmJobAtomicWrite($file,json_decode($original,true,160,JSON_THROW_ON_ERROR));}finally{flock($lock,LOCK_UN);fclose($lock);}});
 acceptCheck('owned terminal journal restored without overwriting newer records',zfsmReadJob($id)===$job);
}elseif(($argv[1]??'')==='quota-recover'){
 $space=$root.'/quota-case';$snap=$space.'@source';$path='/mnt/'.$space;acceptIdentity($space);acceptIdentity($snap);
 $old=zfsmReadJob($state['enospc_job']);acceptCheck('quota recovery only follows inspected owned job',$old['dataset']===$space&&$old['state']==='recovery_required'&&$old['hold_owned']===false);
 $hash=null;foreach($state['checks'] as $c)if($c['name']==='ENOSPC preserves snapshot SHA256')$hash=$c['detail']['sha256'];if(!$hash)throw new RuntimeException('Original checksum evidence missing');
 acceptCheck('increase only test quota for explicit fresh recovery',acceptMutate($space,fn()=>acceptSuccess(setDatasetProperty($space,'quota','96M'))));
 $job=acceptQueueRestore($snap,['large.bin'],'fresh-recovery','new');$state['quota_recovery_job']=$job['id'];acceptSaveState();acceptStartWorker();$done=acceptWaitJob($job['id']);
 acceptCheck('fresh explicit recovery after ENOSPC',$done['state']==='completed'&&hash_file('sha256',$path.'/fresh-recovery/large.bin')===$hash,['job_id'=>$job['id']]);
 acceptCheck('failed ENOSPC job was not retried',zfsmReadJob($old['id'])['state']==='recovery_required');
}elseif(($argv[1]??'')==='encryption-reset'){
 $secure=$root.'/secure';$child=$secure.'/child';$nested=$child.'/nested-root';foreach([$secure,$child,$nested] as $ds)acceptIdentity($ds);
 if(acceptZfs(['get','-H','-o','value','keystatus',$secure])==='unavailable')acceptCheck('restore synthetic root mount after reproducer',acceptMutate($secure,fn()=>acceptSuccess(unlockDataset($secure,'synthetic-director-acceptance-key-A'))));
 foreach([$child,$nested] as $ds)if(acceptZfs(['get','-H','-o','value','mounted',$ds])==='no')acceptZfs(['mount',$ds]);
 foreach([$secure,$child,$nested] as $ds)acceptCheck('pre-retest encryption SHA256 '.$ds,hash_file('sha256','/mnt/'.$ds.'/marker.txt')===$state['encrypted_sha256'][$ds]);
}elseif(($argv[1]??'')==='download'){
 $snap=$state['snapshot'];acceptIdentity($snap);zfsmExplorerDownload($snap,'hello.txt',$state['objects'][$snap]);
}elseif(($argv[1]??'')==='download-zip'){
 $job=zfsmReadJob($state['archive_job']);acceptIdentity($job['dataset']);zfsmStreamDownload(zfsmArchiveReadRequest($job['id']),'acceptance.zip','application/zip');
}else throw new InvalidArgumentException('Unknown acceptance phase');
}catch(Throwable $e){$state['failure']=$e->getMessage();acceptSaveState();fwrite(STDERR,$e->getMessage()."\n");exit(1);}
