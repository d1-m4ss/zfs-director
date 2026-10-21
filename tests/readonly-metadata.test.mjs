import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runtime } from './php-runtime.mjs';

test('native readonly security property sources stay separate from editing and ACL entries', async () => {
    const php=await runtime();
    try {
        php.writeFile('/app/readonly-metadata.php',await readFile('tests/readonly-metadata.php'));
        const result=await php.run({scriptPath:'/app/readonly-metadata.php'});
        console.log(result.text);assert.equal(result.errors,'');assert.equal(result.exitCode,0,result.text);
    } finally {php.exit();}
});
