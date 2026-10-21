import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runtime} from './php-runtime.mjs';
test('promote and quotas use native identity capability and signed review guards',async()=>{const php=await runtime();try{php.writeFile('/app/advanced-storage.php',await readFile('tests/advanced-storage.php'));const r=await php.run({scriptPath:'/app/advanced-storage.php'});assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);}finally{php.exit();}});
