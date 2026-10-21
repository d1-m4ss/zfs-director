import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PHP } from '@php-wasm/universal';
import { loadNodeRuntime } from '@php-wasm/node';

// No host filesystem mount. Only copied source and in-memory test state.
// The Node loader creates internal loopback networking; tests make no remote requests.
export async function runtime() {
    const php = new PHP(await loadNodeRuntime('8.3', { emscriptenOptions: { processId: process.pid } }));
    async function copy(from, to) {
        php.mkdir(to);
        for (const file of await readdir(from, { withFileTypes: true })) {
            if (file.name.startsWith('.') || file.name.startsWith('._')) continue;
            if (file.isDirectory()) await copy(from + '/' + file.name, to + '/' + file.name);
            else php.writeFile(to + '/' + file.name, await readFile(from + '/' + file.name));
        }
    }
    await copy('src', '/app/src');
    php.mkdir('/proc/sys/kernel/random');
    php.writeFile('/proc/sys/kernel/random/boot_id','synthetic-test-boot');
    // Replace only the external process boundary in the virtual test copy.
    // Keep validators, commandAnswer, parsers, operations and endpoint code real.
    const helpers = php.readFileAsText('/app/src/include/ZFSMHelpers.php');
    const start = helpers.indexOf('function runProcess('), end = helpers.indexOf('function commandAnswer(', start);
    assert.ok(start > 0 && end > start);
    php.writeFile('/app/src/include/ZFSMHelpers.php', helpers.slice(0, start) +
        'function runProcess($command, $args = [], $stdin = null) { return zfsmTestProcess($command, $args); }\n' + helpers.slice(end));
    php.writeFile('/app/harness.php', await readFile('tests/harness.php'));
    return php;
}
