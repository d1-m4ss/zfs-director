import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runtime } from './php-runtime.mjs';

test('durable jobs: visibility, recovery actions and atomic journals', async () => {
    const php = await runtime();
    try {
        // PHP-WASM cannot model kernel flock contention. Replace that OS boundary
        // only; exercise the real presentation and Resume decision against it.
        const jobs = php.readFileAsText('/app/src/include/ZFSMJobs.php');
        assert.ok(jobs.includes('function zfsmLockHeld($file) {'));
        php.writeFile('/app/src/include/ZFSMJobs.php', jobs.replace('function zfsmLockHeld($file) {',
            'function zfsmLockHeld($file) { if ($file === ($GLOBALS["plugin_worker_lock"] ?? null)) return $GLOBALS["test_worker_running"] ?? false; return zfsmTestNativeLockHeld($file); }\nfunction zfsmTestNativeLockHeld($file) {'));
        php.writeFile('/app/jobs-cases.php', await readFile('tests/jobs-cases.php'));
        const result = await php.run({ scriptPath: '/app/jobs-cases.php' });
        console.log(result.text);
        assert.equal(result.errors, '', result.errors);
        assert.equal(result.exitCode, 0, result.text);
    } finally { php.exit(); }
});
