import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runtime} from './php-runtime.mjs';

test('directory deletion distinguishes read-only Docker coverage from writable and exact dependencies',async()=>{
 const php=await runtime();try{
  php.writeFile('/app/readonly-directory-dependencies.php',await readFile('tests/readonly-directory-dependencies.php'));
  const result=await php.run({scriptPath:'/app/readonly-directory-dependencies.php'});
  assert.equal(result.errors,'');assert.equal(result.exitCode,0,result.text);console.log(result.text);
 }finally{php.exit();}
});
