<?php
require '/app/harness.php';
function parse_plugin_cfg($plugin, $sections) { return is_file($GLOBALS['plugin_config']) ? parse_ini_file($GLOBALS['plugin_config'], true, INI_SCANNER_RAW) : []; }
$GLOBALS['plugin_config']='/settings.cfg';
function settingsFixture($overrides=[]) { return array_merge(['refresh_interval'=>'30','lazy_load'=>'0','sanoid_integration'=>'0','destructive_mode'=>'0','exclusion'=>'','directory_listing'=>'','snap_max_days_alert'=>'30','snap_pattern'=>'Y-m-d-His','snap_prefix'=>'auto-'],$overrides); }
check('inventory carries encryption, mount, GUID and space accounting', function() {
    foreach (['encryptionroot','mounted','keyformat','guid','usedbydataset','usedbychildren','usedbyrefreservation','refquota','reservation','refreservation','dedup'] as $property) if(!in_array($property,zfsmDatasetColumns(),true))throw new RuntimeException('Missing '.$property);
    if(!in_array('guid',zfsmSnapshotColumns(),true))throw new RuntimeException('Missing snapshot GUID');
    same('18446744073709551615',zfsmNormalizeProperty('guid','18446744073709551615'));
    same(0,zfsmNormalizeProperty('refquota','none'));
    same(10,zfsmNormalizeProperty('usedbychildren','10'));
});
function inventoryRow($overrides=[]) {
    $values=array_fill_keys(zfsmDatasetColumns(),'0');
    $values=array_merge($values,['name'=>'cache','type'=>'filesystem','encryption'=>'off','encryptionroot'=>'-','keyformat'=>'-','keystatus'=>'none','mounted'=>'yes','guid'=>'18446744073709551615','mountpoint'=>'/mnt/cache','compression'=>'lz4','compressratio'=>'1.00x','atime'=>'off','xattr'=>'sa','primarycache'=>'all','readonly'=>'off','casesensitivity'=>'sensitive','sync'=>'standard','origin'=>'-','dedup'=>'off'],$overrides);
    return implode("\t",array_map(static fn($column)=>$values[$column],zfsmDatasetColumns()));
}
foreach (['truncated','duplicate','outside pool','unknown type','bad GUID','bad number','missing parent','snapshot instead of filesystem'] as $case) {
    check('malformed inventory fails closed '.$case,function()use($case){
        $valid=inventoryRow();
        $row=match($case){
            'truncated'=>$valid."\ntruncated", 'duplicate'=>$valid."\n".$valid,
            'outside pool'=>inventoryRow(['name'=>'other']), 'unknown type'=>inventoryRow(['type'=>'unknown']),
            'bad GUID'=>inventoryRow(['guid'=>'bad']), 'bad number'=>inventoryRow(['used'=>'bad']),
            'missing parent'=>$valid."\n".inventoryRow(['name'=>'cache/absent/child','guid'=>'2']),
            'snapshot instead of filesystem'=>$valid."\n".inventoryRow(['name'=>'cache/data@snap','guid'=>'2'])
        };
        expectProcess('zfs',['list','-H','-p','-r','-t','filesystem,volume','-o',implode(',',zfsmDatasetColumns()),'cache'],$row);
        $tree=zfsmLoadPoolTree('cache',false,'',0);if(empty($tree['_error']))throw new RuntimeException('Missing inventory error');
    });
}
check('complete inventory preserves roots inherited keys nested roots and locked mounts',function(){
    $rows=[inventoryRow(),inventoryRow(['name'=>'cache/secure','guid'=>'2','encryption'=>'aes-256-gcm','encryptionroot'=>'cache/secure','keyformat'=>'passphrase','keystatus'=>'unavailable','mounted'=>'no']),inventoryRow(['name'=>'cache/secure/child','guid'=>'3','encryption'=>'aes-256-gcm','encryptionroot'=>'cache/secure','keyformat'=>'passphrase','keystatus'=>'unavailable','mounted'=>'no']),inventoryRow(['name'=>'cache/secure/nested','guid'=>'4','encryption'=>'aes-256-gcm','encryptionroot'=>'cache/secure/nested','keyformat'=>'passphrase','keystatus'=>'available','mounted'=>'yes'])];
    expectProcess('zfs',['list','-H','-p','-r','-t','filesystem,volume','-o',implode(',',zfsmDatasetColumns()),'cache'],implode("\n",$rows));
    $tree=zfsmLoadPoolTree('cache',false,'',0);same('18446744073709551615',$tree['guid']);same('off',$tree['encryption']);
    $secure=$tree['child']['cache/secure'];same('no',$secure['mounted']);same('unavailable',$secure['keystatus']);same('cache/secure',$secure['child']['cache/secure/child']['encryptionroot']);same('cache/secure/nested',$secure['child']['cache/secure/nested']['encryptionroot']);same('available',$secure['child']['cache/secure/nested']['keystatus']);
});
check('strict parser rejects duplicate and malformed rows',function(){
    foreach (["cache\t1\nshort","cache\t1\ncache\t2","cache\tbad"] as $output){
        try {zfsmParseTable($output,['name','guid']);throw new LogicException('Expected parsing rejection');}catch(RuntimeException $error){if($error instanceof LogicException)throw $error;}
    }
});
check('legacy no and explicit inherit omit all key parameters',function(){
    foreach(['no','inherit'] as $mode){$clean=cleanZFSCreateDatasetParams(['encryption'=>$mode,'passphrase'=>'secretsecret','keyformat'=>'raw','keylocation'=>'file:///tmp/key']);same([],$clean);}
});
check('new root supplies passphrase through existing stdin contract',function(){
    foreach(['yes','new-root'] as $mode){$clean=cleanZFSCreateDatasetParams(['encryption'=>$mode,'passphrase'=>'secretsecret']);same('on',$clean['encryption']);same('passphrase',$clean['keyformat']);same('prompt',$clean['keylocation']);same('secretsecret',$clean['passphrase']);}
});
check('unknown encryption modes are rejected before process execution',function(){
    foreach(['off','garbage',[],null] as $mode){try{cleanZFSCreateDatasetParams(['encryption'=>$mode]);throw new LogicException('Expected invalid encryption');}catch(InvalidArgumentException $error){}}
    same([],$GLOBALS['test_calls']);
});
foreach ([['exclusion'=>'['],['snap_prefix'=>'@'],['snap_prefix'=>'bad/name'],['snap_prefix'=>'bad#name'],['snap_prefix'=>'bad;name'],['snap_pattern'=>''],['snap_pattern'=>'c'],['snap_max_days_alert'=>'1.5'],['refresh_interval'=>'31']] as $bad) {
    check('invalid settings are atomic '.json_encode($bad),function()use($bad){
        file_put_contents('/settings.cfg',"[general]\nsnap_prefix = \"safe-\"\nunknown = \"preserved\"\n");$before=file_get_contents('/settings.cfg');
        $answer=zfsmSaveSettings(settingsFixture($bad));same([], $answer['succeeded']);same($before,file_get_contents('/settings.cfg'));
        if(!isset($answer['field_errors'][array_key_first($bad)]))throw new RuntimeException('Missing field error');
    });
}
check('settings use PCRE syntax and preview actual PHP generated name',function(){
    $settings=settingsFixture(['exclusion'=>'(?<=cache/)secure(?:/|$)']);
    $answer=zfsmValidateSettings($settings);same(true,$answer['valid']);same([],$answer['errors']);
    if(!zfsmValidSnapshotName($answer['snapshot_preview']))throw new RuntimeException('Invalid snapshot preview');
    if(!str_starts_with($answer['snapshot_preview'],'cache/data@auto-'))throw new RuntimeException('Wrong preview');
});
check('valid save preserves unknown keys and reports persisted values',function(){
    file_put_contents('/settings.cfg',"[general]\nunknown = \"preserved\"\n[future]\noption = \"kept\"\n");
    $settings=settingsFixture();$answer=zfsmSaveSettings($settings);same([], $answer['failed']);same($settings,$answer['settings']);
    $config=parse_ini_file('/settings.cfg',true,INI_SCANNER_RAW);same('preserved',$config['general']['unknown']);same('kept',$config['future']['option']);
});
check('corrupt existing configuration is never reset on save',function(){
    file_put_contents('/settings.cfg',"[general]\ninvalid = \"unterminated\n");$before=file_get_contents('/settings.cfg');
    $answer=zfsmSaveSettings(settingsFixture());same([], $answer['succeeded']);same($before,file_get_contents('/settings.cfg'));
});
check('parsable compression ratios retain their actual factor',function(){same(101,zfsmNormalizeProperty('compressratio','1.01'));same(100,zfsmNormalizeProperty('compressratio','1.00x'));same(250,zfsmNormalizeProperty('compressratio','2.50'));});
check('legacy snapshot prefix with spaces validates and persists without renaming',function(){
    file_put_contents('/settings.cfg',"[general]\nsnap_prefix = \"manual backup-\"\nunknown = \"preserved\"\n");
    $settings=settingsFixture(['snap_prefix'=>'manual backup-']);
    $validation=zfsmValidateSettings($settings);same(true,$validation['valid']);same([],$validation['errors']);
    same(true,str_starts_with($validation['snapshot_preview'],'cache/data@manual backup-'));
    $answer=zfsmSaveSettings($settings);same([],$answer['failed']);same('manual backup-',$answer['settings']['snap_prefix']);
    $stored=parse_ini_file('/settings.cfg',true,INI_SCANNER_RAW);same('manual backup-',$stored['general']['snap_prefix']);same('preserved',$stored['general']['unknown']);
});
finishTests();
