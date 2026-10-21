import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runtime } from './php-runtime.mjs';

test('encryption roots: descendant mounts, nested keys and failure recovery', async () => {
    const php = await runtime();
    try {
        const helper = php.readFileAsText('/app/src/include/ZFSMHelpers.php');
        php.writeFile('/app/src/include/ZFSMHelpers.php', helper.replace('return zfsmTestProcess($command, $args);',
            '$GLOBALS["encryption_stdin"][]=$stdin; $answer=zfsmTestProcess($command, $args); if(!empty($answer["throw"]))throw new RuntimeException("fixture-private-key transport exception"); return $answer;'));
        php.writeFile('/app/encryption-faults.php', await readFile('tests/encryption-faults.php'));
        const result = await php.run({ scriptPath: '/app/encryption-faults.php' });
        console.log(result.text);
        assert.equal(result.errors, '', result.errors);
        assert.equal(result.exitCode, 0, result.text);
    } finally { php.exit(); }
});
