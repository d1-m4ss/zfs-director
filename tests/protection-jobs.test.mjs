import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runtime} from './php-runtime.mjs';
test('protection jobs reuse durable Jobs with isolated ownership and cron schedules',async()=>{
 const php=await runtime();try{php.writeFile('/app/protection-jobs.php',await readFile('tests/protection-jobs.php'));const r=await php.run({scriptPath:'/app/protection-jobs.php'});assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);}finally{php.exit();}
});
