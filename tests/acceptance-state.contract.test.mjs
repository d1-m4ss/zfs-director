import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { runtime } from './php-runtime.mjs';

test('valid PHP settings validation JSON leaves the real Settings form submittable', async () => {
    const php = await runtime();
    const dom = new JSDOM('<main></main>', {url:'http://fixture.local', runScripts:'outside-only'});
    try {
        const result = await php.run({code:`<?php require '/app/harness.php';
            echo json_encode(zfsmValidateSettings([
                'refresh_interval'=>'30','lazy_load'=>'0','sanoid_integration'=>'0','destructive_mode'=>'0',
                'exclusion'=>'','directory_listing'=>'','snap_max_days_alert'=>'30',
                'snap_pattern'=>'Y-m-d-His','snap_prefix'=>'auto-'
            ]),JSON_THROW_ON_ERROR);
        `});
        assert.equal(result.exitCode, 0, result.errors);
        assert.equal(result.errors, '');
        const answer = JSON.parse(result.text);
        assert.equal(answer.valid, true);
        dom.window.eval(readFileSync('src/frontend/ZFSMForms.js', 'utf8'));
        const forms = dom.window.zfsmCreateInlineForms({
            request: async data => {
                assert.equal(data.cmd, 'validatesettings');
                return answer;
            },
            getConfig: () => ({refresh_interval:30, lazy_load:0, sanoid_integration:0, destructive_mode:0,
                dataset_exclusion:'', directory_listing:[], snap_max_days_alert:30,
                snap_pattern:'Y-m-d-His', snap_prefix:'auto-'})
        });
        const host = dom.window.document.querySelector('main');
        await forms.render(host, 'saveconfig', {});
        for (let index = 0; index < 20; index++) await Promise.resolve();
        const form = host.querySelector('form');
        assert.equal(form.checkValidity(), true,
            'PHP accepted settings, but the frontend rejected its actual JSON: ' + host.textContent);
        form.dispatchEvent(new dom.window.Event('submit', {bubbles:true, cancelable:true}));
        assert.ok(host.querySelector('[data-confirm-operation]'), 'valid settings must reach the confirmation step');
        forms.dispose();
    } finally {
        dom.window.close();
        php.exit();
    }
});

