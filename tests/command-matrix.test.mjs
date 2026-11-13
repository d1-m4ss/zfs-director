import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {startIntegration} from './integration/server.mjs';
// TEST-007 / ARCH-002: every command the endpoint accepts has one registry entry, and the
// endpoint really takes the lock and enforces Destructive Mode the entry says.
// tests/fixtures/command-matrix.json is the snapshot of the lists ZFSMAdmin.php used before the
// registry; a change to a command's kind, lock or flags must update it deliberately.
const expected=JSON.parse(readFileSync(new URL('./fixtures/command-matrix.json',import.meta.url),'utf8'));
const BUSY='Another operation is running',DISABLED='Destructive Mode is disabled';
async function registry(s){
 const r=await s.run({code:"<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';echo json_encode(['registry'=>zfsmCommandRegistry(),'alias'=>zfsmCommand('adddirectorylisting')['name']??null,'unknown'=>zfsmCommand('nosuchcommand')]);"});
 assert.equal(r.errors,'',r.text);return JSON.parse(r.text);
}
function holdOperationLock(php){
 const file='/app/src/include/ZFSMHelpers.php',source=php.readFileAsText(file);
 const start=source.indexOf('function zfsmAcquireOperationLockWaiting('),end=source.indexOf('\nfunction ',start+1);assert.ok(start>0&&end>start);
 php.writeFile(file,source.slice(0,start)+"function zfsmAcquireOperationLockWaiting($file,$seconds=5.0) { if ($file===$GLOBALS['plugin_lock']) throw zfsmOperationLockFailure('lock_busy',['pid'=>1,'comm'=>'php']); return zfsmAcquireOperationLock($file); }\n"+source.slice(end));
}
// Only the refusal part of an answer counts: a Jobs listing may quote earlier refusals.
const post=(s,cmd)=>fetch(s.url+'/plugins/zfs.master.ui/backend/ZFSMAdmin.php',{method:'POST',body:new URLSearchParams({csrf_token:'integration-token',cmd})}).then(r=>r.text()).then(text=>{let body;try{body=JSON.parse(text);}catch{return text;}return body&&typeof body==='object'?JSON.stringify([body.failed??null,body.error??null]):text;});
test('the registry matches the command matrix snapshot',async t=>{
 const s=await startIntegration({protection:true});t.after(()=>s.close());
 const out=await registry(s);
 const actual=Object.fromEntries(Object.entries(out.registry).map(([name,c])=>[name,{kind:c.kind,lock:c.lock,destructive:c.destructive,observed:c.observed}]));
 assert.deepEqual(actual,expected);
 for(const [name,c] of Object.entries(out.registry)){
  assert.equal(c.name,name);
  if(c.kind==='read')assert.equal(c.lock,'none',name+': a read-only command takes no lock');
  if(c.destructive)assert.equal(c.kind,'admin',name+': a destructive command must be audited');
  if(c.kind==='admin'&&name!=='refresh')assert.ok(c.label,name+': an audited command needs a History label');
 }
 assert.equal(out.alias,'adddirectortlisting','the correct spelling is accepted as an alias');
 assert.equal(out.unknown,null);
});
test('each command takes exactly the lock its registry entry names',async t=>{
 const s=await startIntegration({protection:true});t.after(()=>s.close());holdOperationLock(s.php);
 const wrong=[];
 for(const [name,c] of Object.entries(expected)){
  const busy=(await post(s,name)).includes(BUSY);
  if(busy!==(c.lock==='operation'))wrong.push(name+': lock '+c.lock+' but busy='+busy);
 }
 assert.deepEqual(wrong,[]);
});
test('every destructive command is refused when Destructive Mode is off, and only audited commands reach History',async t=>{
 const s=await startIntegration({protection:true});t.after(()=>s.close());
 const cfg='/boot/config/plugins/zfs.master.ui/zfs.master.ui.cfg';s.php.writeFile(cfg,s.php.readFileAsText(cfg).replace('destructive_mode = "1"','destructive_mode = "0"'));
 const wrong=[];
 for(const [name,c] of Object.entries(expected)){
  const text=await post(s,name);
  if(c.destructive&&!text.includes(DISABLED))wrong.push(name+': destructive but not refused');
 }
 assert.deepEqual(wrong,[]);
 const r=await s.run({code:"<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';echo json_encode(array_values(array_unique(array_column(zfsmAuditList(500),'command'))));"});
 const audited=new Set(JSON.parse(r.text));
 for(const [name,c] of Object.entries(expected))assert.equal(audited.has(name),c.kind==='admin',name+' audit record');
});
