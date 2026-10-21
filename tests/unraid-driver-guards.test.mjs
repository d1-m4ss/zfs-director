import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';

test('live acceptance driver rejects mount/state/replay escapes before fixture mutations',async()=>{
 const php=await runtime();try{
  const source=await readFile('tests/unraid/directory-acceptance.php','utf8');
  php.writeFile('/app/driver-source.php',source);const parsed=await php.run({code:"<?php token_get_all(file_get_contents('/app/driver-source.php'),TOKEN_PARSE);echo 'syntax OK';"});assert.equal(parsed.text,'syntax OK');
  let end=source.indexOf('\n// Driver entry point');if(end<0)end=source.indexOf('\ntry{');
  assert.ok(end>source.indexOf('function '));
  // Load only real function definitions in the copied PHP filesystem. Never
  // run the driver entry point, fixture operations, worker or ZFS commands.
  // The virtual runtime is not CLI: replace only its CLI/root process boundary;
  php.writeFile('/app/driver-functions.php','<?php\n'+source.slice(source.indexOf('function '),end).replace("PHP_SAPI!=='cli'||posix_geteuid()!==0||",''));
  php.writeFile('/app/unraid-driver-guards.php',await readFile('tests/unraid-driver-guards.php'));
  const result=await php.run({scriptPath:'/app/unraid-driver-guards.php'});assert.equal(result.errors,'');assert.equal(result.exitCode,0,result.text);console.log(result.text);
 }finally{php.exit();}
});
