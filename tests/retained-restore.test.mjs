import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startIntegration} from './integration/server.mjs';

const mount='/mnt/cache/__mock__/project',id='20261114-093000-0123456789ab',folder=mount+'/.zfsm-restore-'+id;
async function fixture(fn){const s=await startIntegration({dependencyUsage:true});try{
 const post=async fields=>(await fetch(s.url+'/plugins/zfs.master.ui/backend/ZFSMAdmin.php',{method:'POST',body:new URLSearchParams({csrf_token:'integration-token',...fields})})).json();
 await fn({s,post});
}finally{await s.close();}}
const prepare=(s,withInfo)=>s.run({code:`<?php mkdir('${folder}/replaced',0700,true);file_put_contents('${folder}/replaced/old.txt','old');${withInfo?`file_put_contents('${folder}/restore-info.json',json_encode(['version'=>1,'restored_at'=>1794648600,'snapshot'=>'cache/__mock__/project@base','destination'=>'/photos','job'=>'${id}']));chmod('${folder}/restore-info.json',0600);`:''}`});

test('a retained restore folder is described by the file written next to the replaced files',async()=>fixture(async({s,post})=>{
 assert.equal((await prepare(s,true)).errors,'');
 const info=await post({cmd:'restoreinfo',directory:folder});
 assert.equal(info.directory,folder);assert.equal(info.snapshot,'cache/__mock__/project@base');assert.equal(info.destination,mount+'/photos');assert.equal(info.restored_at,'2026-11-14T09:30:00+00:00');assert.match(info.modified,/^20\d\d-\d\d-\d\dT/);
}));
test('a retained restore folder without a description is described by its path and change time and does not fail',async()=>fixture(async({s,post})=>{
 assert.equal((await prepare(s,false)).errors,'');
 const info=await post({cmd:'restoreinfo',directory:folder});
 assert.equal(info.directory,folder);assert.equal(info.snapshot,null);assert.equal(info.destination,null);assert.equal(info.restored_at,null);assert.match(info.modified,/^20\d\d-\d\d-\d\dT/);
}));
test('only a top-level retained restore folder can be described',async()=>fixture(async({s,post})=>{
 assert.equal((await prepare(s,true)).errors,'');
 for(const directory of [folder+'/replaced',mount,mount+'/.zfsm-mutation-'+'a'.repeat(48)])assert.ok((await post({cmd:'restoreinfo',directory})).failed?.request,directory);
}));
test('the deletion review accepts a retained restore folder as a whole',async()=>fixture(async({s,post})=>{
 assert.equal((await prepare(s,true)).errors,'');
 const review=await post({cmd:'previewdeletedirectory',directory:folder,force:'0'});
 assert.deepEqual({target:review.target,can_delete:review.can_delete,blockers:review.blockers},{target:folder,can_delete:true,blockers:[]});
}));
