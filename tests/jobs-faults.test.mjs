import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runtime } from './php-runtime.mjs';

test('job hold cleanup refuses uncertain ownership and releases only its retained GUID', async () => {
    const php = await runtime();
    try {
        php.writeFile('/app/jobs-faults.php', await readFile('tests/jobs-faults.php'));
        const result = await php.run({ scriptPath: '/app/jobs-faults.php' });
        console.log(result.text);
        assert.equal(result.errors, '', result.errors);
        assert.equal(result.exitCode, 0, result.text);
    } finally { php.exit(); }
});
