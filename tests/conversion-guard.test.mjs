import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runtime} from './php-runtime.mjs';
test('unresolved conversions protect the last copy and expose an explicit publish recovery',async()=>{
 const php=await runtime();try{php.writeFile('/app/conversion-guard.php',await readFile('tests/conversion-guard.php'));const r=await php.run({scriptPath:'/app/conversion-guard.php'});assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);}finally{php.exit();}
});
