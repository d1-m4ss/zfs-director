<?php
require __DIR__.'/src/include/ZFSMDirectory.php';
require __DIR__.'/src/include/ZFSMUsage.php';
require __DIR__.'/src/include/ZFSMACL.php';
$checks=0;
function verify($condition,$label){global $checks;if(!$condition)throw new RuntimeException($label);$checks++;}
$answer=zfsmUsageProcess(PHP_BINARY,['-r','fwrite(STDERR,"secret");echo "projected";'],microtime(true)+2);
verify($answer===['code'=>0,'output'=>'projected'],'Native process captures only stdout');
$answer=zfsmUsageProcess(PHP_BINARY,['-r','echo str_repeat("x",600000);'],microtime(true)+2);
verify($answer['code']!==0&&$answer['output']==='','Native output cap fails closed');
$started=microtime(true);$answer=zfsmUsageProcess(PHP_BINARY,['-r','usleep(2000000);echo "late";'],$started+0.15);
verify($answer['code']!==0&&$answer['output']===''&&microtime(true)-$started<1,'Native deadline terminates child');
$answer=zfsmUsageProcess(PHP_BINARY,['-r','fwrite(STDERR,str_repeat("x",600000));'],microtime(true)+2);
verify($answer['code']!==0&&$answer['output']==='','Native stderr cap fails closed');
$started=microtime(true);$shared=zfsmUsageIO(['deadline'=>$started+0.15]);
$answer=($shared['process'])(PHP_BINARY,['-r','usleep(2000000);echo "late";']);
verify($answer['code']!==0&&$answer['output']===''&&microtime(true)-$started<1,'Explicit shared deadline also bounds the default process closure');
file_put_contents('/tmp/zfsm-usage-config',"[data]\npath = /tmp\n");
verify(zfsmUsageReadFile('/tmp/zfsm-usage-config')['status']==='known','Bounded regular source read');
symlink('/tmp/zfsm-usage-config','/tmp/zfsm-usage-link');
verify(zfsmUsageReadFile('/tmp/zfsm-usage-link')['status']==='error','Config symlink rejected');
file_put_contents('/tmp/zfsm-usage-huge',str_repeat('x',524289));
verify(zfsmUsageReadFile('/tmp/zfsm-usage-huge')['status']==='error','Config size cap');
verify(zfsmUsageReadFile('/tmp/zfsm-usage-missing')['status']==='unavailable','Missing actual config unavailable');
verify(zfsmUsageReadFile('/tmp')['status']==='error','Directory is not a source file');
verify(zfsmUsagePathOwner('/tmp',zfsmUsageIO())===false,'Real local non-ZFS mount is proven unrelated');
$tool=zfsmUsageTool('getfacl');$nativeACL='not installed';
if($tool){
 $answer=zfsmUsageProcess($tool,['--absolute-names','--numeric','--omit-header','--','/tmp'],microtime(true)+2);
 verify($answer['code']===0&&zfsmParsePosixACL($answer['output'])!==null,'Actual getfacl output parses');$nativeACL='actual getfacl parsed';
}
$toolAlias='existing zfs executable left unchanged';
if(!file_exists('/usr/sbin/zfs')&&!is_link('/usr/sbin/zfs')){
 symlink(PHP_BINARY,'/usr/sbin/zfs');
 try{verify(zfsmUsageTool('zfs')===realpath(PHP_BINARY),'Known executable symlink resolves to trusted canonical target');$toolAlias='trusted symlink verified';}
 finally{unlink('/usr/sbin/zfs');}
}
$fixtures=zfsmUsageProcess(PHP_BINARY,[__DIR__.'/usage-acl.php'],microtime(true)+2);
verify($fixtures['code']===0&&preg_match('/^[0-9]+ usage\/ACL checks passed\n$/D',$fixtures['output'])===1,'Actual PHP adapters pass injected service fixture matrix on native Linux filesystem: '.substr($fixtures['output'],0,512));
echo json_encode(['checks'=>$checks,'failed'=>0,'php'=>PHP_VERSION,'nativeACL'=>$nativeACL,'xmlParser'=>class_exists('DOMDocument'),'toolAlias'=>$toolAlias,'adapterFixture'=>trim($fixtures['output'])],JSON_THROW_ON_ERROR)."\n";
