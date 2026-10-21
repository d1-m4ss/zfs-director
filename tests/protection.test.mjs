import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runtime} from './php-runtime.mjs';

test('native PHP protection detection and legacy settings safety', async()=>{
 const php=await runtime();
 try{
  php.writeFile('/app/protection.php',await readFile('tests/protection.php'));
  const result=await php.run({scriptPath:'/app/protection.php'});
  assert.equal(result.errors,'',result.text);assert.equal(result.exitCode,0,result.text);
 }finally{php.exit();}
});
