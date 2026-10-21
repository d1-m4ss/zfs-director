import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runtime } from '../php-runtime.mjs';

test('corrected source contracts (virtual PHP files and simulated processes)', async () => {
    const php = await runtime();
    try {
        php.writeFile('/app/source-probes.php', await readFile('tests/gui/source-probes.php'));
        const result = await php.run({ scriptPath: '/app/source-probes.php' });
        console.log(result.text);
        assert.equal(result.errors, '', result.errors);
        assert.equal(result.exitCode, 0, result.text);
    } finally { php.exit(); }
});
