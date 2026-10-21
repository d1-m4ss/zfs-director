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
finishTests();
