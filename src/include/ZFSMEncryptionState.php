<?php
function zfsmEncryptionStateFile($guid) {
    if(!is_string($guid)||!preg_match('/^[1-9][0-9]{0,19}$/D',$guid))throw new InvalidArgumentException('Invalid encryption root GUID');
    return dirname($GLOBALS['plugin_config']).'/encryption-mounts/'.$guid.'.json';
}
function zfsmValidateEncryptionState($record) {
    if(!is_array($record)||($record['version']??null)!==1||!zfsmValidDatasetName($record['root']??'')||!in_array($record['phase']??'',['prepared','locked','restore_required'],true)||!is_array($record['mounts']??null)||count($record['mounts'])>4096)throw new InvalidArgumentException('Invalid saved encryption mount state');
    zfsmEncryptionStateFile($record['root_guid']??null);$seen=[];
    foreach($record['mounts'] as $row){$name=$row['name']??'';if(!zfsmValidDatasetName($name)||($name!==$record['root']&&!str_starts_with($name,$record['root'].'/'))||isset($seen[$name]))throw new InvalidArgumentException('Saved mount is outside the encryption family');zfsmEncryptionStateFile($row['guid']??null);$seen[$name]=true;}
    return $record;
}
function zfsmSaveEncryptionState($record) {
    $record=zfsmValidateEncryptionState($record);$file=zfsmEncryptionStateFile($record['root_guid']);zfsmJobDirectory(dirname($file));zfsmJobAtomicWrite($file,$record);return $record;
}
function zfsmReadEncryptionState($root,$guid) {
    $file=zfsmEncryptionStateFile($guid);if(!file_exists($file))return null;
    if(is_link($file)||!is_file($file)||filesize($file)>1048576||zfsmPathHasSymlink($file))throw new RuntimeException('Saved encryption state is not trusted; inspect it before changing keys.');
    $record=zfsmValidateEncryptionState(json_decode(file_get_contents($file),true,32,JSON_THROW_ON_ERROR));
    if($record['root']!==$root||$record['root_guid']!==$guid)throw new RuntimeException('Saved encryption root identity changed; inspect before restoring mounts.');return $record;
}
function zfsmRememberEncryptionMounts($root,$mounted) {
    $identity=zfsmReadIdentity($root);$mounts=[];
    if(zfsmReadEncryptionState($root,$identity['guid'])!==null)throw new RuntimeException('Saved mount recovery is pending. Restore it before creating another lock state.');
    foreach($mounted as $name)$mounts[]=['name'=>$name,'guid'=>$name===$root?$identity['guid']:zfsmReadIdentity($name)['guid']];
    return zfsmSaveEncryptionState(['version'=>1,'root'=>$root,'root_guid'=>$identity['guid'],'phase'=>'prepared','mounts'=>$mounts]);
}
function zfsmEncryptionMetadata(&$properties) {
    $properties['_encryption_recovery']=null;
    if(($properties['encryptionroot']??null)!==($properties['name']??'')||!is_string($properties['guid']??null))return;
    try{$record=zfsmReadEncryptionState($properties['name'],$properties['guid']);if($record)$properties['_encryption_recovery']=['phase'=>$record['phase'],'mounts'=>array_column($record['mounts'],'name')];}
    catch(Throwable $error){$properties['_encryption_recovery']=['phase'=>'unknown','reason'=>'Saved mount journal requires inspection.'];}
}
function zfsmEncryptionRestoreFailure($record,$unmounted,$result) {
    $result=zfsmRestoreEncryptionMounts($unmounted,$result,array_column($record['mounts'],'guid','name'));
    if(empty($result['restore_failures'])){if(!@unlink(zfsmEncryptionStateFile($record['root_guid'])))$result['output'].='; saved mount journal retained for inspection';}
    else{$record['phase']='restore_required';zfsmSaveEncryptionState($record);}
    return $result;
}
function zfsmRestoreSavedEncryptionMounts($record) {
    $rows=$record['mounts'];usort($rows,fn($a,$b)=>substr_count($a['name'],'/')<=>substr_count($b['name'],'/')?:strcmp($a['name'],$b['name']));$failures=[];
    foreach($rows as $row){$name=$row['name'];try{
        foreach(array_keys($failures) as $failed)if(str_starts_with($name,$failed.'/'))throw new RuntimeException('Previously mounted ancestor could not be restored');
        zfsmRequireIdentity($name,$row['guid']);$read=zfsmEncryptionMutation(['get','-H','-o','property,value','encryptionroot,mounted',$name]);$state=[];foreach(explode("\n",trim($read['output']??'')) as $line){$p=explode("\t",$line,2);if(count($p)===2)$state[$p[0]]=$p[1];}
        if($read['code']!==0||($state['encryptionroot']??'')!==$record['root']||!in_array($state['mounted']??'',['yes','no'],true))throw new RuntimeException('Mount identity or encryption root changed');
        if($state['mounted']==='no'){$r=zfsmEncryptionMutation(['mount',$name]);if($r['code']!==0)throw new RuntimeException($r['output']??'mount failed');$r=zfsmEncryptionMutation(['get','-H','-o','property,value','encryptionroot,mounted',$name]);if($r['code']!==0||!str_contains($r['output'],"mounted\tyes")||!str_contains($r['output'],"encryptionroot\t".$record['root']))throw new RuntimeException('Mounted state readback is unavailable');}
    }catch(Throwable $error){$failures[$name]=$error->getMessage();}}
    if($failures){$record['phase']='restore_required';zfsmSaveEncryptionState($record);return zfsmFailure($record['root'],'Encryption key is loaded; some saved mounts require recovery: '.implode('; ',array_map(fn($name,$reason)=>$name.': '.$reason,array_keys($failures),array_values($failures))));}
    if(!@unlink(zfsmEncryptionStateFile($record['root_guid'])))return zfsmFailure($record['root'],'Saved mounts restored but journal cleanup failed; inspect before retrying.');
    return ['succeeded'=>[$record['root']=>'Key available; only previously mounted filesystem GUIDs restored'],'failed'=>[]];
}
