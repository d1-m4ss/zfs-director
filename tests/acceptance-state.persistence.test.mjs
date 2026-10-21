import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtime } from './php-runtime.mjs';

const settings = {refresh_interval:'30', lazy_load:'0', sanoid_integration:'0', destructive_mode:'0',
    exclusion:'', directory_listing:'', snap_max_days_alert:'30', snap_pattern:'Y-m-d-His', snap_prefix:'auto-'};

async function phpResult(php, code) {
    const result = await php.run({code:'<?php require "/app/harness.php"; ' + code});
    assert.equal(result.exitCode, 0, result.errors);
    assert.equal(result.errors, '');
    return JSON.parse(result.text);
}

test('valid PCRE backslashes survive persistence and successful readback', async () => {
    const php = await runtime();
    try {
        const encoded = Buffer.from(JSON.stringify({...settings, exclusion:'\\d+$'})).toString('base64');
        const result = await phpResult(php, `
            $GLOBALS['plugin_config']='/acceptance-settings.cfg';
            file_put_contents($GLOBALS['plugin_config'],"[general]\\nunknown = \\\"preserved\\\"\\n");
            $settings=json_decode(base64_decode('${encoded}'),true);
            $answer=zfsmSaveSettings($settings);
            echo json_encode(['answer'=>$answer,'stored'=>parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_NORMAL)],JSON_THROW_ON_ERROR);
        `);
        assert.equal(result.stored.general.exclusion, '\\d+$');
        assert.equal(Object.keys(result.answer.failed).length, 0,
            'A valid PCRE save was committed but falsely reported failed: ' + JSON.stringify(result.answer));
    } finally { php.exit(); }
});

test('saving settings preserves escaped values in unknown configuration keys', async () => {
    const php = await runtime();
    try {
        const unknown = {path:'C:\\backup\\archive', comment:'A "quoted" value'};
        const encoded = Buffer.from(JSON.stringify({settings, unknown})).toString('base64');
        const result = await phpResult(php, `
            $GLOBALS['plugin_config']='/acceptance-settings.cfg';
            $data=json_decode(base64_decode('${encoded}'),true);
            saveConfig(['general'=>['unknown'=>$data['unknown']['path']], 'future'=>['comment'=>$data['unknown']['comment']]]);
            $before=parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_NORMAL);
            $answer=zfsmSaveSettings($data['settings']);
            echo json_encode(['before'=>$before,'after'=>parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_NORMAL),'answer'=>$answer],JSON_THROW_ON_ERROR);
        `);
        assert.equal(result.before.general.unknown, unknown.path);
        assert.equal(result.before.future.comment, unknown.comment);
        assert.equal(result.after.general.unknown, unknown.path, 'An unrelated existing backslash value must not gain escaping');
        assert.equal(result.after.future.comment, unknown.comment, 'An unrelated quoted value must not gain escaping');
    } finally { php.exit(); }
});

test('quoted unknown INI constants, mode words and arrays retain their values', async () => {
    const php = await runtime();
    try {
        const future = {yesWord:'yes', noWord:'no', enabled:'on', disabled:'off', boolean:'true',
            falseValue:'false', emptyValue:'null', noneWord:'none', constant:'E_ALL', version:'PHP_VERSION',
            rows:['yes', 'no', 'C:\\backup', 'A "quoted" value']};
        const encoded = Buffer.from(JSON.stringify({settings, future})).toString('base64');
        const result = await phpResult(php, `
            $GLOBALS['plugin_config']='/acceptance-settings.cfg';
            $data=json_decode(base64_decode('${encoded}'),true);
            saveConfig(['general'=>[], 'future'=>$data['future']]);
            $answer=zfsmSaveSettings($data['settings']);
            echo json_encode(['answer'=>$answer,'future'=>parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_NORMAL)['future']],JSON_THROW_ON_ERROR);
        `);
        assert.equal(Object.keys(result.answer.failed).length, 0);
        assert.deepEqual(result.future, future);
    } finally { php.exit(); }
});
