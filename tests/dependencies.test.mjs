import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runtime} from './php-runtime.mjs';
test('dependency evidence and mutation guards preserve unknown and component scope',async()=>{
 const php=await runtime();try{php.writeFile('/app/dependencies.php',await readFile('tests/dependencies.php'));const r=await php.run({scriptPath:'/app/dependencies.php'});assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);}finally{php.exit();}
});
