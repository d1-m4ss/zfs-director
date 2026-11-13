import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startIntegration} from './integration/server.mjs';
// UX-006: SSH key references are registered from the UI. Only paths are stored, every path is
// checked the same way syncoid execution checks it, and a key in use cannot be removed.
const prelude=`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
// Unraid mounts /boot for root only; the stand's directories default to 0777.
zfsmProtectionDirectory();foreach(['/boot','/boot/config','/boot/config/plugins','/boot/config/plugins/zfs.master.ui','/boot/config/plugins/zfs.master.ui/protection','/boot/config/ssh','/boot/config/ssh/director','/root','/root/.ssh']as$d){if(!is_dir($d))mkdir($d,0755,true);chmod($d,0755);}
file_put_contents('/boot/config/ssh/director/id_ed25519',"synthetic key\\n");chmod('/boot/config/ssh/director/id_ed25519',0600);
file_put_contents('/boot/config/ssh/director/known_hosts',"backup.example ssh-ed25519 AAAA\\n");chmod('/boot/config/ssh/director/known_hosts',0644);
file_put_contents('/root/.ssh/id_ed25519',"synthetic key\\n");chmod('/root/.ssh/id_ed25519',0600);file_put_contents('/root/.ssh/known_hosts',"x\\n");chmod('/root/.ssh/known_hosts',0644);
function attempt($fn){try{return ['ok'=>$fn()];}catch(Throwable$e){return ['error'=>$e->getMessage()];}}
$key='/boot/config/ssh/director/id_ed25519';$known='/boot/config/ssh/director/known_hosts';
`;
async function run(t,code){
 const s=await startIntegration({protection:true});t.after(()=>s.close());
 const r=await s.run({code:prelude+code});assert.equal(r.errors,'',r.text);return JSON.parse(r.text.slice(r.text.indexOf('{')));
}
test('a valid reference is saved with paths only and becomes usable by syncoid',async t=>{
 const out=await run(t,`$saved=zfsmSyncoidCredentialSave(['name'=>'backup-server','keyfile'=>$key,'known_hosts'=>$known]);
 $again=zfsmSyncoidCredentialSave(['name'=>'backup-server','keyfile'=>$key,'known_hosts'=>$known]);
 echo json_encode(['saved'=>$saved,'again'=>$again,'stored'=>json_decode(file_get_contents(zfsmSyncoidCredentialFile()),true),'list'=>zfsmSyncoidCredentialList(),'resolved'=>zfsmSyncoidCredential('backup-server'),'names'=>zfsmProtectionData()['credentials']]);`);
 assert.deepEqual(out.saved.succeeded,{'backup-server':'SSH key reference added'});assert.equal(Object.keys(out.saved.failed).length,0);
 assert.equal(out.again.succeeded['backup-server'],'SSH key reference updated');
 assert.deepEqual(out.stored,{'backup-server':{keyfile:'/boot/config/ssh/director/id_ed25519',known_hosts:'/boot/config/ssh/director/known_hosts'}},'only the two paths are stored');
 assert.deepEqual(out.list,[{name:'backup-server',keyfile:'/boot/config/ssh/director/id_ed25519',known_hosts:'/boot/config/ssh/director/known_hosts',usable:true,problem:null,used_by:[],persistent:true}]);
 assert.deepEqual(out.resolved,out.stored['backup-server']);
 assert.deepEqual(out.names,['backup-server'],'the replication wizard sees the new key');
});
test('unsafe names, paths and files are refused before anything is written',async t=>{
 const out=await run(t,`
 chmod($key,0640);$groupReadable=attempt(fn()=>zfsmSyncoidCredentialSave(['name'=>'a','keyfile'=>$key,'known_hosts'=>$known]));chmod($key,0600);
 chmod('/boot/config/ssh/director',0777);$openDir=attempt(fn()=>zfsmSyncoidCredentialSave(['name'=>'a','keyfile'=>$key,'known_hosts'=>$known]));chmod('/boot/config/ssh/director',0755);
 file_put_contents('/boot/config/ssh/director/empty',''); chmod('/boot/config/ssh/director/empty',0644);
 echo json_encode([
  'name'=>attempt(fn()=>zfsmSyncoidCredentialSave(['name'=>'bad name','keyfile'=>$key,'known_hosts'=>$known])),
  'relative'=>attempt(fn()=>zfsmSyncoidCredentialSave(['name'=>'a','keyfile'=>'id_ed25519','known_hosts'=>$known])),
  'dotdot'=>attempt(fn()=>zfsmSyncoidCredentialSave(['name'=>'a','keyfile'=>'/boot/config/ssh/../ssh/director/id_ed25519','known_hosts'=>$known])),
  'shell'=>attempt(fn()=>zfsmSyncoidCredentialSave(['name'=>'a','keyfile'=>$key.';rm','known_hosts'=>$known])),
  'missing'=>attempt(fn()=>zfsmSyncoidCredentialSave(['name'=>'a','keyfile'=>'/boot/config/ssh/director/none','known_hosts'=>$known])),
  'same'=>attempt(fn()=>zfsmSyncoidCredentialSave(['name'=>'a','keyfile'=>$key,'known_hosts'=>$key])),
  'empty_known_hosts'=>attempt(fn()=>zfsmSyncoidCredentialSave(['name'=>'a','keyfile'=>$key,'known_hosts'=>'/boot/config/ssh/director/empty'])),
  'group_readable_key'=>$groupReadable,'writable_directory'=>$openDir,
  'written'=>file_exists(zfsmSyncoidCredentialFile())]);`);
 assert.match(out.name.error,/letters, digits/);
 for(const k of ['relative','dotdot','shell'])assert.match(out[k].error,/absolute trusted paths/,k);
 assert.match(out.missing.error,/unavailable/);
 assert.match(out.same.error,/different files/);
 assert.match(out.empty_known_hosts.error,/known_hosts is empty/);
 assert.match(out.group_readable_key.error,/exclude group and other/);
 assert.match(out.writable_directory.error,/unavailable/);
 assert.equal(out.written,false,'no refused request creates the list');
});
test('a key in RAM is accepted with a reboot warning; a key used by a replication cannot be removed',async t=>{
 const out=await run(t,`$ram=zfsmSyncoidCredentialSave(['name'=>'ram','keyfile'=>'/root/.ssh/id_ed25519','known_hosts'=>'/root/.ssh/known_hosts']);
 zfsmSyncoidCredentialSave(['name'=>'used','keyfile'=>$key,'known_hosts'=>$known]);
 $store=zfsmProtectionReadStore();$r=zfsmSyncoidJob(['name'=>'Offsite','source'=>'cache/__mock__/project','target'=>'tank/copy','source_guid'=>'1','mode'=>'remote','host'=>'backup.example','credential'=>'used','resume'=>false,'compression'=>'none']);$store['replications'][$r['id']]=$r;zfsmProtectionWriteStore($store);
 $blocked=attempt(fn()=>zfsmSyncoidCredentialRemove('used'));$removed=zfsmSyncoidCredentialRemove('ram');$unknown=attempt(fn()=>zfsmSyncoidCredentialRemove('ram'));
 $list=zfsmSyncoidCredentialList();
 echo json_encode(['ram'=>$ram,'blocked'=>$blocked,'removed'=>$removed,'unknown'=>$unknown,'names'=>array_column($list,'name'),'used_by'=>$list[0]['used_by'],'files_kept'=>is_file('/root/.ssh/id_ed25519')]);`);
 assert.match(out.ram.warning,/RAM on Unraid and are lost at reboot/);
 assert.match(out.blocked.error,/Used by replication "Offsite"/);
 assert.equal(out.removed.succeeded.ram,'SSH key reference removed; the key files were not touched');
 assert.match(out.unknown.error,/not found/);
 assert.deepEqual(out.names,['used']);assert.deepEqual(out.used_by,['Offsite']);
 assert.equal(out.files_kept,true,'removing a reference never deletes the key');
});
