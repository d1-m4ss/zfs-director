<?php
require '/app/harness.php';
function snapshotRow($name='cache/data@s1',$refs=2,$clones='cache/clone') {
    $values=['name'=>$name,'used'=>'10','referenced'=>'20','written'=>'30','defer_destroy'=>'off','userrefs'=>(string)$refs,'creation'=>'1700000000','guid'=>'77','clones'=>$clones];
    return implode("\t",array_map(fn($key)=>$values[$key],zfsmSnapshotColumns()));
}
function snapshotDatasetRow($name) {
    $values=array_fill_keys(zfsmDatasetColumns(),'0');
    $values=array_replace($values,['name'=>$name,'type'=>'filesystem','guid'=>$name==='cache'?'1':'2','encryption'=>'off','encryptionroot'=>'-','keyformat'=>'-','keystatus'=>'none','mounted'=>'yes','mountpoint'=>'/mnt/'.$name,'compressratio'=>'1.00x','origin'=>'-']);
    return implode("\t",array_map(fn($key)=>$values[$key],zfsmDatasetColumns()));
}
function expectSnapshots($rows,$recursive=false,$code=0,$withClones=true) {
    $columns=zfsmSnapshotColumns();if(!$withClones)$columns=array_values(array_diff($columns,['clones']));
    expectProcess('zfs',['list','-H','-p',...($recursive?['-r']:['-d','1']),'-t','snapshot','-o',implode(',',$columns),$recursive?'cache':'cache/data'],$rows,$code);
}
check('actual live pool inventory exposes clone dependencies and exact batched hold names',function(){
    expectProcess('zfs',['list','-H','-p','-r','-t','filesystem,volume','-o',implode(',',zfsmDatasetColumns()),'cache'],snapshotDatasetRow('cache')."\n".snapshotDatasetRow('cache/data'));
    expectSnapshots(snapshotRow(),true);
    expectProcess('zfs',['holds','-H','cache/data@s1'],"cache/data@s1\tkeep\tfixture\ncache/data@s1\tbackup\tfixture");
    $tree=zfsmLoadPoolTree('cache',true,'',0);$snapshot=$tree['child']['cache/data']['snapshots'][0];
    same(['cache/clone'],$snapshot['clone_dependencies']??null);same(['backup','keep'],$snapshot['hold_names']??null);same(2,$snapshot['userrefs']);
});
foreach(['failure','truncated','outside snapshot','duplicate tag','incomplete count']as$case)check('optional hold metadata stays Unknown without losing counters '.$case,function()use($case){
    expectSnapshots(snapshotRow());
    expectProcess('zfs',['holds','-H','cache/data@s1'],match($case){'failure'=>'permission denied','truncated'=>'short','outside snapshot'=>"cache/other@s1\tkeep\tfixture",'duplicate tag'=>"cache/data@s1\tkeep\tfixture\ncache/data@s1\tkeep\tfixture",'incomplete count'=>"cache/data@s1\tkeep\tfixture"},$case==='failure'?1:0);
    $answer=getDatasetSnapshotsResult('cache','cache/data');same(true,$answer['ok']);same(null,$answer['snapshots'][0]['hold_names']??null);same(2,$answer['snapshots'][0]['userrefs']);
});
check('empty clone list and zero userrefs need no extra hold process',function(){
    expectSnapshots(snapshotRow('cache/data@s1',0,'-'));$answer=getDatasetSnapshotsResult('cache','cache/data');same([],$answer['snapshots'][0]['clone_dependencies']??null);same([],$answer['snapshots'][0]['hold_names']??null);same(1,count($GLOBALS['test_calls']));
});
check('unsupported clone property preserves inventory with Unknown dependencies',function(){
    expectSnapshots('unsupported property',false,1);$row=snapshotRow('cache/data@s1',0,'-');$parts=explode("\t",$row);if(in_array('clones',zfsmSnapshotColumns(),true))array_pop($parts);
    expectSnapshots(implode("\t",$parts),false,0,false);$answer=getDatasetSnapshotsResult('cache','cache/data');same(true,$answer['ok']);same(null,$answer['snapshots'][0]['clone_dependencies']??null);same([],$answer['snapshots'][0]['hold_names']??null);
});
check('2000 unheld snapshots retain one inventory process and bounded held batches',function(){
    $rows=[];for($i=0;$i<2000;$i++)$rows[]=snapshotRow('cache/data@s'.$i,0,'-');expectSnapshots(implode("\n",$rows));$answer=getDatasetSnapshotsResult('cache','cache/data');same(2000,count($answer['snapshots']));same(1,count($GLOBALS['test_calls']));
    $GLOBALS['test_calls']=[];$rows=[];$names=[];for($i=0;$i<101;$i++){$names[]='cache/data@s'.$i;$rows[]=snapshotRow($names[$i],1,'-');}expectSnapshots(implode("\n",$rows));
    foreach(array_chunk($names,100)as$batch)expectProcess('zfs',['holds','-H',...$batch],implode("\n",array_map(fn($name)=>$name."\tkeep\tfixture",$batch)));
    $answer=getDatasetSnapshotsResult('cache','cache/data');same(3,count($GLOBALS['test_calls']));foreach($answer['snapshots']as$sameSnapshot)same(['keep'],$sameSnapshot['hold_names']??null);
});
check('excluded datasets do not trigger optional hold probes',function(){
    expectProcess('zfs',['list','-H','-p','-r','-t','filesystem,volume','-o',implode(',',zfsmDatasetColumns()),'cache'],snapshotDatasetRow('cache')."\n".snapshotDatasetRow('cache/data'));
    expectSnapshots(snapshotRow(),true);$tree=zfsmLoadPoolTree('cache',true,'^cache/data$',0);same(2,count($GLOBALS['test_calls']));same(0,$tree['total_snapshots']);
});
check('expired inventory budget does not launch optional metadata subprocesses',function(){
    $snapshots=[['name'=>'cache/data@s1','userrefs'=>1,'clones'=>'cache/clone']];$GLOBALS['zfsm_inventory_deadline']=microtime(true)-1;
    try{zfsmSnapshotMetadata($snapshots);same([],$GLOBALS['test_calls']);same(null,$snapshots[0]['hold_names']);same(['cache/clone'],$snapshots[0]['clone_dependencies']);}finally{unset($GLOBALS['zfsm_inventory_deadline']);}
});
check('malformed clone dependency text stays Unknown while snapshot remains visible',function(){
    foreach(['cache/clone,../outside','cache/clone,cache/clone']as$clones){expectSnapshots(snapshotRow('cache/data@s1',0,$clones));$answer=getDatasetSnapshotsResult('cache','cache/data');same(true,$answer['ok']);same(null,$answer['snapshots'][0]['clone_dependencies']);}
});
finishTests();
