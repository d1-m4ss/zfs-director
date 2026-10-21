import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runtime } from './php-runtime.mjs';

test('PHP regression suite (simulated processes)', async () => {
    const php = await runtime();
    try {
        php.writeFile('/app/regressions.php', await readFile('tests/regressions.php'));
        const result = await php.run({ scriptPath: '/app/regressions.php' });
        console.log(result.text);
        assert.equal(result.errors, '', result.errors);
        assert.equal(result.exitCode, 0, result.text);
    } finally { php.exit(); }
});

test('PHP scrub suite (simulated processes)', async () => {
    const php = await runtime();
    try {
        php.writeFile('/app/scrub.php', await readFile('tests/scrub.php'));
        const result = await php.run({ scriptPath: '/app/scrub.php' });
        console.log(result.text);
        assert.equal(result.errors, '', result.errors);
        assert.equal(result.exitCode, 0, result.text);
    } finally { php.exit(); }
});

for (const scenario of ['success','native-failure','csrf','get','unconfirmed','badpool','lock','refresh']) {
    test('authenticated endpoint: ' + scenario, async () => {
        const php = await runtime();
        try {
            php.writeFile('/app/endpoint.php', await readFile('tests/endpoint.php'));
            const result = await php.run({ code: '<?php $case=' + JSON.stringify(scenario) + '; require "/app/endpoint.php";' });
            console.log(result.text);
            // Rejected requests intentionally log a backend error.
            assert.equal(result.exitCode, 0, result.text);
        } finally { php.exit(); }
    });
}

test('all PHP and Unraid page sources parse as PHP 8.3', async () => {
    const php=await runtime();
    try {
        const result=await php.run({code:`<?php
            $count=0;
            $files=new RecursiveIteratorIterator(new RecursiveDirectoryIterator('/app/src'));
            foreach($files as $file)if($file->isFile()&&in_array($file->getExtension(),['php','page'],true)) {
                token_get_all(file_get_contents($file->getPathname()),TOKEN_PARSE);$count++;
            }
            echo $count.' PHP/page sources parsed';
        `});
        console.log(result.text);assert.equal(result.errors,'');assert.equal(result.exitCode,0);
    } finally {php.exit();}
});
