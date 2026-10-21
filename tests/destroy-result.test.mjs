import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';
test('destroy distinguishes CLI plan, errors and verified partial outcomes',async()=>{const php=await runtime();try{php.writeFile('/app/cases.php',await readFile('tests/destroy-result.php'));const r=await php.run({scriptPath:'/app/cases.php'});console.log(r.text);assert.equal(r.errors,'');assert.equal(r.exitCode,0,r.text);}finally{php.exit();}});
