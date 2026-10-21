import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runtime} from './php-runtime.mjs';
test('Syncoid safe argv and GUID verified replication outcomes',async()=>{
 const php=await runtime();try{php.writeFile('/app/syncoid.php',await readFile('tests/syncoid.php'));const r=await php.run({scriptPath:'/app/syncoid.php'});assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);}finally{php.exit();}
});
