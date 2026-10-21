import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runtime} from './php-runtime.mjs';

test('native snapshot creation times validate, inherit and survive configuration roundtrip',async()=>{
 const php=await runtime();
 try{php.writeFile('/app/sanoid-times.php',await readFile('tests/sanoid-times.php'));const r=await php.run({scriptPath:'/app/sanoid-times.php'});assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);}finally{php.exit();}
});
