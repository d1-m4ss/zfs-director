import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
test('GUI runner cannot report success when Chromium emitted a pageerror',async()=>{
 const output=await mkdtemp(join(tmpdir(),'zfsm-gate-'));
 try{
  const run=spawnSync(process.execPath,['tests/gui/run.mjs'],{env:{...process.env,ZFSM_CASE:'theme selection survives navigation',ZFSM_OUTPUT:output,ZFSM_INJECT_PAGE_ERROR:'1'},encoding:'utf8'});
  const report=JSON.parse(await readFile(output+'/gui-results.json','utf8'));assert.ok(report.issues.some(i=>i.type==='pageerror'));
  assert.notEqual(run.status,0,'Collected JavaScript errors must make the GUI gate fail');
 }finally{await rm(output,{recursive:true,force:true});}
});
