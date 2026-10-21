import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runtime } from './php-runtime.mjs';

test('RC command identity matrix, destroy dependency changes and settings boundaries', async () => {
    const php=await runtime();
    try {
        php.writeFile('/app/rc-security-matrix.php',await readFile('tests/rc-security-matrix.php'));
        const result=await php.run({scriptPath:'/app/rc-security-matrix.php'});
        console.log(result.text);assert.equal(result.errors,'');assert.equal(result.exitCode,0,result.text);
    } finally {php.exit();}
});
