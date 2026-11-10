<?php
require '/app/harness.php';
function rejectReplication($fn){try{$fn();}catch(InvalidArgumentException|RuntimeException$e){return;}throw new LogicException('Expected rejection');}
function replicationTree($guid,$snapshot='11',$child=false){$tree=[''=>['guid'=>$guid,'snapshots'=>[$snapshot=>['name'=>'snap','creation'=>100]],'resume'=>false]];if($child)$tree['/child']=['guid'=>$guid.'2','snapshots'=>['21'=>['name'=>'child-snap','creation'=>100]],'resume'=>false];return $tree;}
function replicationBefore($child=false){return ['source'=>replicationTree('100','11',$child),'target'=>replicationTree('200','10',$child),'expected'=>$child?[''=>'11','/child'=>'21']:[''=>'11']];}
function syncoidCaps(){return ['flags'=>['--no-clone-handling','--no-rollback','--recvoptions','--sshoption','--no-resume','--recursive','--exclude-datasets','--use-hold','--no-sync-snap','--create-bookmark','--compress','--source-bwlimit','--sshkey','--sshport','--identifier'],'resume'=>true];}
check('default argv never permits rollback or mounting and uses native resume only with capability',function(){
 $j=zfsmSyncoidJob(['name'=>'Test','source'=>'cache/a','target'=>'backup/a']);$a=zfsmSyncoidArgv($j,syncoidCaps());same(true,in_array('--no-rollback',$a,true));same(true,in_array('--recvoptions=u',$a,true));same(false,in_array('-F',$a,true));same(false,in_array('--no-resume',$a,true));$c=syncoidCaps();$c['resume']=false;rejectReplication(fn()=>zfsmSyncoidArgv($j,$c));$j['resume']=false;same(true,in_array('--no-resume',zfsmSyncoidArgv($j,$c),true));
});
check('host credentials schedule bandwidth and data paths are validated without shell interpolation',function(){
 foreach([['source'=>'cache/a;id'],['target'=>'cache/a/child'],['host'=>'bad;id','mode'=>'remote'],['schedule'=>'* * * * * curl bad'],['bandwidth'=>'1m;id'],['credential'=>'../../key','mode'=>'remote','host'=>'backup.example']]as$bad)rejectReplication(fn()=>zfsmSyncoidJob(array_replace(['name'=>'Test','source'=>'cache/a','target'=>'backup/a'],$bad)));
 rejectReplication(fn()=>zfsmSyncoidJob(['name'=>'R','source'=>'cache/a','target'=>'backup/a','mode'=>'remote','host'=>'backup.example']));
});
check('bookmark requires no-sync-snap and all advanced flags require detected support',function(){
 rejectReplication(fn()=>zfsmSyncoidJob(['source'=>'cache/a','target'=>'backup/a','bookmark'=>'1']));$j=zfsmSyncoidJob(['source'=>'cache/a','target'=>'backup/a','use_hold'=>'1']);$c=syncoidCaps();$c['flags']=array_diff($c['flags'],['--use-hold']);rejectReplication(fn()=>zfsmSyncoidArgv($j,$c));
});
check('different dataset GUIDs with delivered matching snapshot GUID are completed',function(){
 $b=replicationBefore();$a=['source'=>$b['source'],'target'=>replicationTree('200','11')];$r=zfsmSyncoidVerify($b,$a,0);same('completed',$r['outcome']);same('11',$r['checkpoints']['']['guid']);same(0,$r['lag_seconds']);
});
check('exit zero with expected snapshot absent is blocked rather than successful',function(){same('blocked',zfsmSyncoidVerify(replicationBefore(),['source'=>replicationTree('100'),'target'=>replicationTree('200','10')],0)['outcome']);});
check('already present checkpoint is up to date not a false failure',function(){
 $b=replicationBefore();$b['target']=replicationTree('200');same('up_to_date',zfsmSyncoidVerify($b,['source'=>$b['source'],'target'=>$b['target']],0)['outcome']);
});
check('every recursive child must be delivered',function(){
 $b=replicationBefore(true);$b['target']=replicationTree('200','10');same('blocked',zfsmSyncoidVerify($b,['source'=>$b['source'],'target'=>replicationTree('200')],0)['outcome']);
});
check('dataset identity change requires recovery and incomplete readback stays unknown',function(){
 $b=replicationBefore();same('recovery_required',zfsmSyncoidVerify($b,['source'=>replicationTree('101'),'target'=>replicationTree('200')],0)['outcome']);same('recovery_required',zfsmSyncoidVerify($b,['source'=>replicationTree('100'),'target'=>replicationTree('201')],0)['outcome']);same('unknown',zfsmSyncoidVerify($b,['source'=>null,'target'=>null],0)['outcome']);
});
check('post-checkpoint writes do not invalidate a delivered frozen checkpoint',function(){
 $b=replicationBefore();$a=['source'=>replicationTree('100'),'target'=>replicationTree('200')];$a['source']['']['snapshots']['12']=['name'=>'concurrent','creation'=>200];same('completed',zfsmSyncoidVerify($b,$a,0)['outcome']);
});
check('nonzero and resumable partial results never appear completed',function(){
 $b=replicationBefore();$a=['source'=>$b['source'],'target'=>$b['target']];same('failed',zfsmSyncoidVerify($b,$a,1)['outcome']);$a['target']['']['resume']=true;same('interrupted',zfsmSyncoidVerify($b,$a,1)['outcome']);
});
check('remote unknown credentials cannot produce an SSH command',function(){
 $GLOBALS['plugin_config']='/config/director.cfg';$j=zfsmSyncoidJob(['source'=>'cache/a','target'=>'backup/a','mode'=>'remote','host'=>'backup.example','credential'=>'backup']);rejectReplication(fn()=>zfsmSyncoidSsh($j,['list']));
});
check('native failure reasons are actionable without returning credential or CLI output',function(){
 $r=zfsmSyncoidFailure('private key SECRET: cannot receive: out of space',1);same('insufficient_space',$r['error_code']);same(false,str_contains(json_encode($r),'SECRET'));same('host_identity',zfsmSyncoidFailure('Host key verification failed.',255)['error_code']);same('ssh_timeout',zfsmSyncoidFailure('Connection timed out',255)['error_code']);
});
check('progress counter counts only dataset starts, across split chunks, and keeps no text',function(){
 $buffer='';$total=0;
 foreach(["INFO: Sending oldest full snapshot cache/a@x to new target filesystem backup/a (~ 1.2 MB):\n","INFO: Sending incremen","tal cache/a/b@x ... y to backup/a/b (~ 4 KB):\nWARN: something\n","INFO: Skipping dataset (syncoid:sync=false): cache/a/c...\nINFO: Resuming interrupted zfs send/receive from cache/a/d to backup/a/d (~ 1 MB remaining):\nDEBUG: NEWEST SNAPSHOT: x\n"] as $chunk)$total+=zfsmProtectionProgressLines($buffer,$chunk);
 same(4,$total);same('',$buffer);
 $buffer='';same(0,zfsmProtectionProgressLines($buffer,"user@host: ssh key SECRET without newline"));same(true,strlen($buffer)>0);
 $buffer=str_repeat('x',9000);zfsmProtectionProgressLines($buffer,'y');same('',$buffer);
});
// Replication scenarios on simulated `zfs list` output (no ZFS runs locally; real syncoid is not executed).
function inspectScenario($sourceLines,$destinationLines,$tokens=null,$target='backup/a',$extra=[]){
 $j=zfsmSyncoidJob(array_merge(['name'=>'R','source'=>'cache/a','target'=>$target,'recursive'=>true],$extra));
 $list=['list','-H','-p','-r','-t','filesystem,volume,snapshot','-o','name,type,guid,creation,createtxg'];
 expectProcess('zfs',array_merge($list,['cache/a']),$sourceLines);
 expectProcess('zfs',array_merge($list,[$target]),$destinationLines===null?'cannot open \''.$target.'\': dataset does not exist':$destinationLines,$destinationLines===null?1:0);
 if($destinationLines!==null)expectProcess('zfs',['get','-H','-r','-o','name,value','receive_resume_token',$target],$tokens??($target."\t-\n"));
 return zfsmSyncoidInspect($j);
}
$sourceFull="cache/a\tfilesystem\t100\t1\t1\ncache/a@s1\tsnapshot\t11\t10\t5\ncache/a@s2\tsnapshot\t12\t20\t6\ncache/a/child\tfilesystem\t101\t1\t2\ncache/a/child@s1\tsnapshot\t21\t10\t5\n";
$sourceEmpty="cache/a\tfilesystem\t100\t1\t1\n";
$emptyDestination="backup/a\tfilesystem\t200\t2\t2\n";
check('scenario: destination that does not exist yet is allowed and is created by the first run',function()use($sourceFull){
 $r=inspectScenario($sourceFull,null);same([],$r['blockers']);same([],$r['target']);same([''=>'12','/child'=>'21'],$r['expected']);
});
check('scenario: empty source (no snapshots) into a new destination is allowed and does not crash',function()use($sourceEmpty){
 $r=inspectScenario($sourceEmpty,null);same([],$r['blockers']);same([],$r['expected']);same([],$r['source']['']['snapshots']);
});
check('scenario: existing destination without snapshots is a hazard for that dataset (root or child), never a blocker, whether the source is empty or not',function()use($sourceFull,$sourceEmpty,$emptyDestination){
 foreach([$sourceFull,$sourceEmpty]as$source){$r=inspectScenario($source,$emptyDestination);same([],$r['blockers']);same(1,count($r['hazards']));same(true,str_contains($r['hazards'][0],'backup/a already exists but has no snapshots'));same(true,str_contains($r['hazards'][0],'this part will fail'));}
 $childOnly="backup/a\tfilesystem\t200\t2\t2\nbackup/a@s1\tsnapshot\t11\t10\t5\nbackup/a@s2\tsnapshot\t12\t20\t6\nbackup/a/child\tfilesystem\t201\t2\t3\n";
 $r=inspectScenario($sourceFull,$childOnly,"backup/a\t-\nbackup/a/child\t-\n");same([],$r['blockers']);same(1,count($r['hazards']));same(true,str_contains($r['hazards'][0],'backup/a/child already exists'));
});
check('scenario: a root that never gets its own snapshot by design (only children replicated, no sync snapshot) is not flagged',function(){
 $src="cache/a\tfilesystem\t100\t1\t1\ncache/a/child\tfilesystem\t101\t1\t2\ncache/a/child@s1\tsnapshot\t21\t10\t5\n";
 $dst="backup/a\tfilesystem\t200\t2\t2\nbackup/a/child\tfilesystem\t201\t2\t3\nbackup/a/child@s1\tsnapshot\t21\t10\t5\n";
 $r=inspectScenario($src,$dst,"backup/a\t-\nbackup/a/child\t-\n",'backup/a',['no_sync_snap'=>true]);same([],$r['blockers']);same([],$r['hazards']);
 $r=inspectScenario($src,$dst,"backup/a\t-\nbackup/a/child\t-\n",'backup/a',['no_sync_snap'=>false]);same(1,count($r['hazards']));
});
check('scenario: an empty destination holding an interrupted first receive (resume token) is not flagged',function()use($sourceFull,$emptyDestination){
 $r=inspectScenario($sourceFull,$emptyDestination,"backup/a\t1-abcdef-token\n");same([],$r['blockers']);same([],$r['hazards']);same(true,$r['target']['']['resume']);
});
check('syncoid refusing an existing empty destination is reported as an actionable failure without raw output',function(){
 $r=zfsmSyncoidFailure("CRITICAL ERROR: Target backup/a exists but has no snapshots matching with cache/a!\n  Replication to target would require destroying existing\n  target. Cancelling.\nssh key SECRET",2);
 same('destination_without_snapshots',$r['error_code']);same(false,str_contains(json_encode($r),'SECRET'));same(true,str_contains($r['reason'],'cannot receive into it'));
});
check('scenario: normal incremental run, destination has a common lineage, is not blocked',function()use($sourceFull){
 $dst="backup/a\tfilesystem\t200\t2\t2\nbackup/a@s1\tsnapshot\t11\t10\t5\nbackup/a/child\tfilesystem\t201\t2\t3\nbackup/a/child@s1\tsnapshot\t21\t10\t5\n";
 $r=inspectScenario($sourceFull,$dst,"backup/a\t-\nbackup/a/child\t-\n");same([],$r['blockers']);same([],$r['hazards']);
});
check('scenario: choosing another source for a destination that already holds different data never overwrites: it is blocked',function()use($sourceFull){
 $other="backup/a\tfilesystem\t200\t2\t2\nbackup/a@older-other-dataset\tsnapshot\t999\t10\t5\nbackup/a@another\tsnapshot\t998\t11\t6\n";
 $r=inspectScenario($sourceFull,$other);
 same(['Destination has a snapshot outside source lineage: @older-other-dataset','Destination has a snapshot outside source lineage: @another'],array_map(fn($b)=>str_replace('Destination has a snapshot outside source lineage: ','Destination has a snapshot outside source lineage: ',$b),$r['blockers']));
});
check('scenario: foreign child datasets on the destination are blocked, not deleted',function()use($sourceFull){
 $dst="backup/a\tfilesystem\t200\t2\t2\nbackup/a@s1\tsnapshot\t11\t10\t5\nbackup/a/mine\tfilesystem\t300\t2\t3\n";
 $r=inspectScenario($sourceFull,$dst,"backup/a\t-\nbackup/a/mine\t-\n");same(['Foreign destination dataset /mine'],$r['blockers']);
});
check('scenario: destination and source with the same dataset identity are rejected',function()use($sourceFull){
 rejectReplication(fn()=>inspectScenario($sourceFull,"backup/a\tfilesystem\t100\t2\t2\nbackup/a@s1\tsnapshot\t11\t10\t5\n"));
});
check('scenario: destination inside the source, equal to it, or overlapping another job is refused',function(){
 foreach(['cache/a','cache/a/backup']as$target)rejectReplication(fn()=>zfsmSyncoidJob(['name'=>'R','source'=>'cache/a','target'=>$target]));
 same(true,zfsmProtectionScopeOverlap('backup/a','backup/a'));same(true,zfsmProtectionScopeOverlap('backup/a','backup/a/b'));same(true,zfsmProtectionScopeOverlap('backup/a/b','backup/a'));same(false,zfsmProtectionScopeOverlap('backup/a','backup/ab'));
});
check('scenario: no run argument can delete, roll back or overwrite the destination',function(){
 foreach([[],['recursive'=>true],['resume'=>false],['use_hold'=>true],['no_sync_snap'=>true],['bookmark'=>true,'no_sync_snap'=>true],['recursive'=>true,'exclusions'=>['cache/a/skip']]]as$extra){
  $a=zfsmSyncoidArgv(zfsmSyncoidJob(array_merge(['name'=>'R','source'=>'cache/a','target'=>'backup/a'],$extra)),syncoidCaps());
  same(false,in_array('--force-delete',$a,true));same(true,in_array('--no-rollback',$a,true));same(true,in_array('--recvoptions=u',$a,true));
 }
});
finishTests();
