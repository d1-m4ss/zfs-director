<?php
function zfsmAnnotateSnapshots(&$snapshots,$datasetGuids,$store,$jobs) {
    foreach($snapshots as &$snapshot){
        $name=$snapshot['name'];$owner=explode('@',$name,2)[0];$owned=$store['owned_snapshots'][$name]??[];
        $snapshot['provenance']='Unknown';$snapshot['retention_policy']=null;$snapshot['replication_refs']=[];$snapshot['last_verified_replication']=null;
        if(isset($owned['policy_id'],$owned['guid'],$owned['dataset_guid'])&&$owned['guid']===($snapshot['guid']??null)&&$owned['dataset_guid']===($datasetGuids[$owner]??null)){$snapshot['provenance']='Managed policy '.$owned['policy_id'];$snapshot['retention_policy']=$owned['policy_id'];}
        foreach($store['replications']??[] as $id=>$definition)if(isset($definition['source'])&&zfsmProtectionScopeOverlap($owner,$definition['source']))$snapshot['replication_refs'][]=(string)$id;
        foreach($jobs as $job)if(($job['type']??'')==='replication'&&in_array($job['verified_outcome']??'',['completed','up_to_date'],true)&&($job['verification']['verified']??false)===true&&isset($job['source'])&&($owner===$job['source']||str_starts_with($owner,$job['source'].'/'))){
            foreach($job['verification']['checkpoints']??[] as $checkpoint)if(($checkpoint['guid']??null)===($snapshot['guid']??null)&&is_string($job['finished_at']??null)&&($snapshot['last_verified_replication']===null||strcmp($job['finished_at'],$snapshot['last_verified_replication'])>0))$snapshot['last_verified_replication']=$job['finished_at'];
        }
    }unset($snapshot);
}
function zfsmSnapshotReferenceStore(&$snapshots,$datasetGuids) {
    $store=[];$jobs=[];
    try{if(is_file(dirname($GLOBALS['plugin_config']).'/protection/config.json')){$store=zfsmProtectionReadStore();$jobs=zfsmJobPage(1,200)['jobs'];}}catch(Throwable $error){/* Optional provenance remains Unknown. */}
    zfsmAnnotateSnapshots($snapshots,$datasetGuids,$store,$jobs);
}
function zfsmBookmarkMetadata($pool,&$datasets) {
    foreach($datasets as &$dataset)$dataset['_bookmarks']=['status'=>'unknown','entries'=>null];unset($dataset);
    $io=zfsmUsageIO();$tool=($io['tool'])('zfs');if(!$tool)return;
    $r=($io['process'])($tool,['list','-H','-p','-r','-t','bookmark','-o','name,guid,creation',$pool]);if($r['code']!==0)return;
    $entries=[];foreach(preg_split('/\r\n|\r|\n/',rtrim($r['output'],"\r\n"),-1,PREG_SPLIT_NO_EMPTY)?:[] as $line){
        $p=explode("\t",$line);if(count($p)!==3||substr_count($p[0],'#')!==1||!zfsmValidSnapshotName(str_replace('#','@',$p[0]))||!preg_match('/^[1-9][0-9]*$/D',$p[1])||!ctype_digit($p[2]))return;
        $owner=explode('#',$p[0],2)[0];if(!isset($datasets[$owner]))continue;$entries[$owner][]=['name'=>$p[0],'guid'=>$p[1],'creation'=>$p[2]];
    }
    foreach($datasets as $name=>&$dataset)$dataset['_bookmarks']=['status'=>'known','entries'=>$entries[$name]??[]];unset($dataset);
}
