import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtime } from './php-runtime.mjs';

const settings = {refresh_interval:'30', lazy_load:'0', sanoid_integration:'0', destructive_mode:'0',
    exclusion:'', directory_listing:'', snap_max_days_alert:'30', snap_pattern:'Y-m-d-His', snap_prefix:'auto-'};

test('a literal environment expression in a valid exclusion survives settings persistence', async () => {
    const php = await runtime();
    try {
        php.writeFile('/acceptance-settings.cfg', '[general]\n');
        const exclusion = '\\Q${ZFS_MASTER_TEST}\\E';
        const encoded = Buffer.from(JSON.stringify({...settings, exclusion})).toString('base64');
        const result = await php.run({code:`<?php require '/app/harness.php';
            putenv('ZFS_MASTER_TEST=expanded-by-parser');
            $GLOBALS['plugin_config']='/acceptance-settings.cfg';
            $settings=json_decode(base64_decode('${encoded}'),true);
            $answer=zfsmSaveSettings($settings);
            echo json_encode(['answer'=>$answer,'stored'=>parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_NORMAL)],JSON_THROW_ON_ERROR);
        `});
        assert.equal(result.exitCode, 0, result.errors);
        assert.equal(result.errors, '');
        const output = JSON.parse(result.text);
        assert.equal(output.stored.general.exclusion, exclusion, 'INI parsing must not expand the literal exclusion');
        assert.equal(Object.keys(output.answer.failed).length, 0, 'A valid exclusion must save with successful readback');
    } finally { php.exit(); }
});

// CFG-001: one schema drives defaults, the field list and both save paths.
test('an old .cfg using the legacy exclussion key migrates to exclusion once', async () => {
    const php = await runtime();
    try {
        const result = await php.run({code:`<?php require '/app/harness.php';
            $config=['general'=>['exclussion'=>'^cache/temp']];
            $loaded=loadConfig($config);
            echo json_encode(['dataset_exclusion'=>$loaded['dataset_exclusion']],JSON_THROW_ON_ERROR);
        `});
        assert.equal(result.exitCode, 0, result.errors);
        assert.equal(result.errors, '');
        assert.equal(JSON.parse(result.text).dataset_exclusion, '^cache/temp');
    } finally { php.exit(); }
});

test('a .cfg missing newer schema fields gets every schema default, never an unset key', async () => {
    const php = await runtime();
    try {
        const result = await php.run({code:`<?php require '/app/harness.php';
            $loaded=loadConfig(['general'=>['refresh_interval'=>'60']]);
            $fields=array_keys(zfsmSettingsSchema());
            $missing=[];foreach($fields as$field)if(!array_key_exists($field==='exclusion'?'dataset_exclusion':$field,$loaded))$missing[]=$field;
            echo json_encode(['missing'=>$missing,'lazy_load'=>$loaded['lazy_load'],'space_warning_percent'=>$loaded['space_warning_percent'],'replication_lag_hours'=>$loaded['replication_lag_hours']],JSON_THROW_ON_ERROR);
        `});
        assert.equal(result.exitCode, 0, result.errors);
        assert.equal(result.errors, '');
        const output = JSON.parse(result.text);
        assert.deepEqual(output.missing, [], 'every schema field must be present with its default');
        assert.equal(output.lazy_load, 0);
        assert.equal(output.space_warning_percent, 80);
        assert.equal(output.replication_lag_hours, 24);
    } finally { php.exit(); }
});

test('protectionsettings and saveconfig each persist every schema field without losing the other one\'s value', async () => {
    const php = await runtime();
    try {
        php.writeFile('/acceptance-settings.cfg', '[general]\n');
        const encoded = Buffer.from(JSON.stringify({...settings, space_warning_percent:'70', space_critical_percent:'95', replication_lag_hours:'12'})).toString('base64');
        const result = await php.run({code:`<?php require '/app/harness.php';
            $GLOBALS['plugin']='zfs.master.ui';$GLOBALS['plugin_config']='/acceptance-settings.cfg';
            function parse_plugin_cfg($p,$s){return parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_NORMAL)?:[];}
            $answer=zfsmSaveSettings(json_decode(base64_decode('${encoded}'),true));
            $afterSave=parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_NORMAL);
            $protection=zfsmProtectionSettings(['enabled'=>'0']);
            $afterProtection=parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_NORMAL);
            echo json_encode(['answer'=>$answer,'afterSave'=>$afterSave,'protection'=>$protection,'afterProtection'=>$afterProtection],JSON_THROW_ON_ERROR);
        `});
        assert.equal(result.exitCode, 0, result.errors);
        assert.equal(result.errors, '');
        const output = JSON.parse(result.text);
        assert.equal(Object.keys(output.answer.failed).length, 0, JSON.stringify(output.answer));
        assert.equal(output.afterSave.general.space_warning_percent, '70');
        assert.equal(output.afterSave.general.replication_lag_hours, '12');
        // protectionsettings only changes sanoid_integration; every other
        // field saveconfig just wrote must survive, not be dropped.
        assert.equal(Object.keys(output.protection.failed).length, 0, JSON.stringify(output.protection));
        assert.equal(output.afterProtection.general.space_warning_percent, '70');
        assert.equal(output.afterProtection.general.space_critical_percent, '95');
        assert.equal(output.afterProtection.general.replication_lag_hours, '12');
        assert.equal(output.afterProtection.general.sanoid_integration, '0');
    } finally { php.exit(); }
});

test('saving settings preserves literal environment expressions in unknown INI values', async () => {
    const php = await runtime();
    try {
        php.writeFile('/acceptance-settings.cfg', '[general]\n[future]\nliteral = "\\${ZFS_MASTER_TEST}"\n');
        const encoded = Buffer.from(JSON.stringify(settings)).toString('base64');
        const result = await php.run({code:`<?php require '/app/harness.php';
            putenv('ZFS_MASTER_TEST=expanded-by-parser');
            $GLOBALS['plugin_config']='/acceptance-settings.cfg';
            $before=parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_NORMAL);
            $answer=zfsmSaveSettings(json_decode(base64_decode('${encoded}'),true));
            echo json_encode(['before'=>$before,'after'=>parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_NORMAL),'answer'=>$answer],JSON_THROW_ON_ERROR);
        `});
        assert.equal(result.exitCode, 0, result.errors);
        assert.equal(result.errors, '');
        const output = JSON.parse(result.text);
        assert.equal(output.before.future.literal, '${ZFS_MASTER_TEST}');
        assert.equal(output.after.future.literal, '${ZFS_MASTER_TEST}', 'Saving unrelated settings must retain the existing literal');
        assert.equal(Object.keys(output.answer.failed).length, 0);
    } finally { php.exit(); }
});

// UX-004: General settings no longer send sanoid_integration. Saving them keeps the stored
// value; an older client that still sends the field keeps working.
test('saving General settings without the integration field keeps the stored integration value', async () => {
    const php = await runtime();
    try {
        const {sanoid_integration, ...general} = settings;
        const encoded = Buffer.from(JSON.stringify(general)).toString('base64');
        const result = await php.run({code:`<?php require '/app/harness.php';
            $GLOBALS['plugin_config']='/acceptance-integration.cfg';
            file_put_contents($GLOBALS['plugin_config'],"[general]\\nsanoid_integration=\\"1\\"\\n");
            $settings=json_decode(base64_decode('${encoded}'),true);
            $validation=zfsmValidateSettings($settings);
            $answer=zfsmSaveSettings($settings);
            $stored=parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_NORMAL);
            $old=zfsmSaveSettings($settings+['sanoid_integration'=>'0']);
            $after=parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_NORMAL);
            echo json_encode(['valid'=>$validation['valid'],'failed'=>$answer['failed'],'stored'=>$stored['general']['sanoid_integration']??null,'old_client_failed'=>$old['failed'],'after_old_client'=>$after['general']['sanoid_integration']??null],JSON_THROW_ON_ERROR);
        `});
        assert.equal(result.exitCode, 0, result.errors);
        const output = JSON.parse(result.text);
        assert.equal(output.valid, true, 'a General form without the field is valid');
        assert.deepEqual(output.failed, [], 'it saves without asking Sanoid / Syncoid');
        assert.equal(output.stored, '1', 'the stored integration value is kept');
        assert.deepEqual(output.old_client_failed, []);
        assert.equal(output.after_old_client, '0', 'an older client that sends the field still changes it');
    } finally { php.exit(); }
});
