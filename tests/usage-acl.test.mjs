import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';

test('read-only usage and ACL adapters execute actual PHP parsers, identity and collection paths', async()=>{
 const php=await runtime();try{
  php.writeFile('/app/usage-acl.php',await readFile('tests/usage-acl.php'));
  const result=await php.run({scriptPath:'/app/usage-acl.php'});
  assert.equal(result.errors,'');assert.equal(result.exitCode,0,result.text);console.log(result.text);
 }finally{php.exit();}
});

test('existing properties endpoint includes safe usage and ACL metadata without changing API arguments',async()=>{
 const php=await runtime();try{
  const result=await php.run({code:`<?php require '/app/harness.php';
   $row=array_fill_keys(zfsmDatasetColumns(),'0');
   $row=array_replace($row,['name'=>'cache/data','guid'=>'99','type'=>'filesystem','mounted'=>'no','mountpoint'=>'/missing','keystatus'=>'none','encryption'=>'off','encryptionroot'=>'-','keyformat'=>'-','compression'=>'lz4','compressratio'=>'1.00x','atime'=>'off','xattr'=>'sa','primarycache'=>'all','readonly'=>'off','casesensitivity'=>'sensitive','sync'=>'standard','origin'=>'-','dedup'=>'off']);
   expectProcess('zfs',['list','-H','-o','name','-t','filesystem,volume','cache/data'],'cache/data');
   expectProcess('zfs',['list','-H','-p','-o',implode(',',zfsmDatasetColumns()),'cache/data'],implode("\\t",array_map(fn($key)=>$row[$key],zfsmDatasetColumns())));
   expectProcess('zfs',['get','-H','-p','-o','property,value,source',implode(',',zfsmAllowedDatasetProperties()),'cache/data'],'unsupported',1);
   expectProcess('zfs',['get','-H','-p','-o','property,value,source','encryption,encryptionroot,keyformat,keystatus,mounted','cache/data'],'unsupported',1);
   expectProcess('zfs',['get','-H','-p','-o','property,value,source','acltype,aclmode,aclinherit','cache/data'],'unsupported',1);
   $answer=getAllDatasetProperties('cache/data',0);
   echo json_encode(['usage'=>$answer['_usage']??null,'acl'=>$answer['_acl']??null,'calls'=>count($GLOBALS['test_calls']),'remaining'=>count($GLOBALS['test_responses'])],JSON_THROW_ON_ERROR);
  `});
  assert.equal(result.errors,'');const answer=JSON.parse(result.text);
  for(const key of ['smb','nfs','docker','vm']){assert.equal(answer.usage?.[key]?.status,'unknown');assert.equal(answer.usage[key].entries,null);}
  assert.equal(answer.acl?.status,'unknown');assert.equal(answer.acl.entries,null);assert.equal(answer.calls,5);assert.equal(answer.remaining,0);
 }finally{php.exit();}
});
