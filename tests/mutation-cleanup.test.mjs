import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runtime} from './php-runtime.mjs';
test('mutation recovery cleanup authorization and preview guards',async()=>{
 const php=await runtime();try{php.writeFile('/app/cleanup.php',await readFile('tests/mutation-cleanup.php'));const r=await php.run({scriptPath:'/app/cleanup.php'});assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);}finally{php.exit();}
});
