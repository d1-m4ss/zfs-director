<?php
// The newest result of every managed policy and replication outlives the job journals. Pool
// warnings and the Snapshot Policies and Replication screens read it, while the journals
// themselves are deleted by retention or by "Delete finished jobs". One small file per
// definition under the protection state; written only when a journal that holds the newest
// result is about to be deleted, never on a run.
function zfsmLastResultName($type,$id) {
    if(!in_array($type,['policy','replication'],true)||!is_string($id)||!preg_match('/^[A-Za-z0-9_-]{1,64}$/D',$id))return null;
    return $type.'-'.$id.'.json';
}
function zfsmLastResultDirectory() { return zfsmJobDirectory(zfsmProtectionDirectory().'/last-results'); }
function zfsmLastResultCompact($job) {
    $keep=['schema','id','type','definition_id','state','stage','verified_outcome','verification','error','created','updated','started_at','finished_at','trigger','source','target'];
    $out=array_intersect_key($job,array_flip($keep));$out['remembered']=true;
    return $out;
}
function zfsmLastResultVerified($job) {
    return ($job['schema']??null)===4&&in_array($job['verified_outcome']??'',['completed','up_to_date'],true)&&($job['verification']['verified']??false)===true;
}
// Throws when the result cannot be stored; the caller then keeps the journal. Two slots: the
// newest result, and the newest verified one (the Snapshots screen reads its checkpoints).
function zfsmLastResultRemember($job) {
    if(($job['schema']??null)!==4)return;
    $name=zfsmLastResultName($job['type']??null,$job['definition_id']??null);if($name===null)throw new RuntimeException('Result of an unsupported definition.');
    $directory=zfsmLastResultDirectory();
    $slots=[$name];if(zfsmLastResultVerified($job))$slots[]=substr($name,0,-5).'.verified.json';
    foreach($slots as$slot){
        $file=$directory.'/'.$slot;
        if(is_link($file)||(file_exists($file)&&!is_file($file)))throw new RuntimeException('Saved result requires inspection.');
        $current=zfsmLastResultRead($file);
        if($current!==null&&strcmp((string)($current['created']??''),(string)($job['created']??''))>=0)continue;
        zfsmJobAtomicWrite($file,zfsmLastResultCompact($job));
    }
}
function zfsmLastResultRead($file) {
    if(is_link($file)||!is_file($file)||filesize($file)>262144)return null;
    try{$value=json_decode((string)file_get_contents($file),true,32,JSON_THROW_ON_ERROR);}catch(Throwable$error){return null;}
    return is_array($value)&&($value['schema']??null)===4&&is_string($value['created']??null)?$value:null;
}
// type:id => compact job, from the newest-result slot or the verified slot. Never throws: a
// missing or damaged file is simply absent.
function zfsmLastResults($verified=false) {
    $results=[];
    try{
        $directory=zfsmProtectionDirectory().'/last-results';if(!is_dir($directory)||is_link($directory))return [];
        foreach(scandir($directory)?:[]as$name){
            if(!preg_match('/^(policy|replication)-([A-Za-z0-9_-]{1,64})(\.verified)?\.json$/D',$name,$m)||(($m[3]??'')!=='')!==$verified)continue;
            $value=zfsmLastResultRead($directory.'/'.$name);
            if($value!==null&&($value['type']??null)===$m[1]&&(string)($value['definition_id']??'')===$m[2])$results[$m[1].':'.$m[2]]=$value;
        }
    }catch(Throwable$error){}
    return $results;
}
// Journals plus the saved results, for readers that look for the newest run of a definition.
function zfsmJobsWithLastResults(array $jobs): array {
    return array_merge($jobs,array_values(zfsmLastResults()),array_values(zfsmLastResults(true)));
}
function zfsmLastResultForget($type,$id) {
    try{$name=zfsmLastResultName($type,$id);if($name===null)return;$file=zfsmProtectionDirectory().'/last-results/'.$name;foreach([$file,substr($file,0,-5).'.verified.json']as$f)if(!is_link($f)&&is_file($f))@unlink($f);}catch(Throwable$error){}
}
// Results of definitions that no longer exist are not needed any more.
function zfsmLastResultsPrune($store) {
    try{
        foreach(zfsmLastResults()as$key=>$value){
            [$type,$id]=explode(':',$key,2);
            if(!isset($store[$type==='policy'?'policies':'replications'][$id]))zfsmLastResultForget($type,$id);
        }
    }catch(Throwable$error){}
}
