import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runtime } from './php-runtime.mjs';

test('fresh identities and expiring one-use destroy previews', async () => {
    const php = await runtime();
    try {
        php.writeFile('/app/identity-cases.php', await readFile('tests/identity-cases.php'));
        const result = await php.run({scriptPath:'/app/identity-cases.php'});
        console.log(result.text);
        assert.equal(result.errors, '', result.errors);
        assert.equal(result.exitCode, 0, result.text);
    } finally { php.exit(); }
});
