<?php
function zfsmSettingsFields() {
    return ['refresh_interval','lazy_load','sanoid_integration','destructive_mode','exclusion','directory_listing','snap_max_days_alert','snap_pattern','snap_prefix','space_warning_percent','space_critical_percent','replication_lag_hours'];
}

function zfsmValidateSettings($settings) {
    $errors=[]; $preview=''; $allowed=zfsmSettingsFields();
    if (!is_array($settings)) return ['valid'=>false,'errors'=>['settings'=>'Settings must be an object.'],'snapshot_preview'=>''];
    if (array_diff(array_keys($settings),$allowed)) $errors['settings']='Unknown settings field.';
    foreach (array_diff($allowed,['space_warning_percent','space_critical_percent','replication_lag_hours']) as $key) if (!is_string($settings[$key]??null)) $errors[$key]='A text value is required.';
    foreach(['space_warning_percent','space_critical_percent','replication_lag_hours'] as $key)if(isset($settings[$key])&&(!is_string($settings[$key])||!ctype_digit($settings[$key])||strlen($settings[$key])>4))$errors[$key]='Use a whole number.';
    $warning=(int)($settings['space_warning_percent']??80);$critical=(int)($settings['space_critical_percent']??90);
    if($warning<1||$warning>99)$errors['space_warning_percent']='Use 1–99 percent.';
    if($critical<2||$critical>100||$critical<=$warning)$errors['space_critical_percent']='Critical percent must exceed warning and be at most 100.';
    if((int)($settings['replication_lag_hours']??24)>8760)$errors['replication_lag_hours']='Use 0–8760 hours; 0 disables replication age alerts.';
    if ($errors) return ['valid'=>false,'errors'=>$errors,'snapshot_preview'=>''];
    if (!in_array($settings['refresh_interval'],['0','30','60','120','300','900','1800'],true)) $errors['refresh_interval']='Choose a supported refresh interval, for example 30 seconds.';
    foreach (['lazy_load','sanoid_integration','destructive_mode'] as $key) if (!in_array($settings[$key],['0','1'],true)) $errors[$key]='Choose Yes (1) or No (0).';
    if (!ctype_digit($settings['snap_max_days_alert']) || strlen($settings['snap_max_days_alert'])>5 || (int)$settings['snap_max_days_alert']>36500) $errors['snap_max_days_alert']='Use a whole number from 0 to 36500, for example 30.';
    foreach (['exclusion'=>1024,'directory_listing'=>16384,'snap_pattern'=>128,'snap_prefix'=>128] as $key=>$max) {
        if (strlen($settings[$key])>$max || str_contains($settings[$key],"\0") || ($key!=='directory_listing'&&preg_match('/[\r\n]/',$settings[$key]))) $errors[$key]='Use at most '.$max.' bytes without unsupported control characters.';
    }
    if (!isset($errors['exclusion']) && trim($settings['exclusion'])!=='' && @preg_match('#'.str_replace('#','\\#',$settings['exclusion']).'#i','')===false) $errors['exclusion']='Invalid PCRE pattern. Example: ^cache/temp(?:/|$)';
    if (!isset($errors['directory_listing'])) foreach (preg_split('/\r\n|\r|\n/',$settings['directory_listing']) as $dataset) if ($dataset!==''&&!zfsmValidDatasetName($dataset)) { $errors['directory_listing']='Use a full dataset name per line, for example cache/data.'; break; }
    if (!isset($errors['snap_prefix']) && $settings['snap_prefix']!=='' && !zfsmValidSnapshotName('cache/data@'.$settings['snap_prefix'])) $errors['snap_prefix']='Use snapshot name characters without @, # or /. Example: manual backup-';
    if ($settings['snap_pattern']==='') $errors['snap_pattern']='A PHP date pattern is required. Example: Y-m-d-His';
    if (!isset($errors['snap_pattern']) && !isset($errors['snap_prefix'])) {
        // Check dates with different widths (day/month names, leap years and epoch).
        foreach ([time(),0,951782400,1798757999] as $timestamp) {
            $generated=$settings['snap_prefix'].date($settings['snap_pattern'],$timestamp);
            if (!zfsmValidSnapshotName('cache/data@'.$generated)) { $errors['snap_pattern']='The generated snapshot name must be 1–255 bytes using ZFS name characters. Example: Y-m-d-His'; break; }
        }
        $preview='cache/data@'.$settings['snap_prefix'].date($settings['snap_pattern']);
    }
    return ['valid'=>!$errors,'errors'=>$errors,'snapshot_preview'=>$preview];
}

function zfsmSaveSettings($settings) {
    $validation=zfsmValidateSettings($settings);
    if (!$validation['valid']) return array_merge(zfsmFailure('settings','Invalid settings. Correct the indicated fields.'),['field_errors'=>$validation['errors'],'snapshot_preview'=>$validation['snapshot_preview']]);
    if($settings['sanoid_integration']==='1') {
        try{zfsmProtectionRequire(false);}catch(Throwable $error){return zfsmFailure('sanoid_integration',$error->getMessage());}
    }
    $file=$GLOBALS['plugin_config'];
    if (is_file($file)) {
        $syntax=@parse_ini_file($file,true,INI_SCANNER_NORMAL);
        $config=$syntax;
        if (!is_array($syntax) || !is_array($config) || (isset($config['general'])&&!is_array($config['general']))) return zfsmFailure('settings','Existing configuration is invalid; preserve it and repair it before saving.');
    } else {
        $config=parse_plugin_cfg($GLOBALS['plugin'],true);
        if (!is_array($config)) return zfsmFailure('settings','Unable to read existing configuration.');
    }
    foreach($config as $section)if(!is_array($section))return zfsmFailure('settings','Existing configuration contains unsupported top-level values; preserve and repair it before saving.');
    $config['general']=array_merge($config['general']??[],$settings);
    if (!saveConfig($config)) return zfsmFailure('settings','Unable to persist settings');
    $saved=@parse_ini_file($file,true,INI_SCANNER_NORMAL);
    foreach ($settings as $key=>$value) if (($saved['general'][$key]??null)!==$value) return zfsmFailure('settings','Settings were written but readback failed. Refresh and inspect the stored configuration.');
    return ['succeeded'=>['settings'=>0],'failed'=>[],'settings'=>array_intersect_key($saved['general'],array_flip(zfsmSettingsFields())),'snapshot_preview'=>$validation['snapshot_preview']];
}
