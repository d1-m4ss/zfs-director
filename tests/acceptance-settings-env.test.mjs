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
