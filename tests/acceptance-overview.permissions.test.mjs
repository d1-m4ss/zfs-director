import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtime } from './php-runtime.mjs';

test('dataset properties report verified mount permissions while readonly metadata remains unavailable', async () => {
    const php = await runtime();
    try {
        const result = await php.run({code:`<?php require '/app/harness.php';
            // PHP-WASM's virtual filesystem reports numeric uid/gid 0.
            mkdir('/verified/data',0777,true);chmod('/verified/data',0750);
            @mkdir('/proc/self',0777,true);
            file_put_contents('/proc/self/mountinfo',"1 0 0:1 / / rw - tmpfs tmpfs rw\\n2 1 0:2 / /verified/data rw - zfs cache/data rw\\n");
            $values=array_fill_keys(zfsmDatasetColumns(),'0');
            $values=array_replace($values,['name'=>'cache/data','type'=>'filesystem','encryption'=>'off','encryptionroot'=>'-','keyformat'=>'-','keystatus'=>'none','mounted'=>'yes','guid'=>'99','mountpoint'=>'/verified/data','compression'=>'lz4','compressratio'=>'1.00x','atime'=>'off','xattr'=>'sa','primarycache'=>'all','readonly'=>'off','casesensitivity'=>'sensitive','sync'=>'standard','origin'=>'-','dedup'=>'off']);
            $cases=[[],['mounted'=>'no'],['type'=>'volume'],['encryption'=>'aes-256-gcm','keystatus'=>'unavailable'],['mountpoint'=>'/verified/missing']];
            $answers=[];
            foreach($cases as $changes) {
                $row=array_replace($values,$changes);
                expectProcess('zfs',['list','-H','-o','name','-t','filesystem,volume','cache/data'],'cache/data');
                expectProcess('zfs',['list','-H','-p','-o',implode(',',zfsmDatasetColumns()),'cache/data'],implode("\\t",array_map(fn($key)=>$row[$key],zfsmDatasetColumns())));
                expectProcess('zfs',['get','-H','-p','-o','property,value,source',implode(',',zfsmAllowedDatasetProperties()),'cache/data'],"compression\\tlz4\\tinherited from cache\\nsync\\tstandard\\tdefault\\natime\\toff\\tlocal");
                expectProcess('zfs',['get','-H','-p','-o','property,value,source','encryption,encryptionroot,keyformat,keystatus'.($row['type']==='filesystem'?',mounted':''),'cache/data'],'unsupported readonly properties',1);
                if($row['type']==='filesystem')expectProcess('zfs',['get','-H','-p','-o','property,value,source','acltype,aclmode,aclinherit','cache/data'],'unsupported ACL properties',1);
                $before=count($GLOBALS['test_calls']);$answer=getAllDatasetProperties('cache/data',0);
                $answers[]=['permissions'=>$answer['_permissions']??null,'sources'=>$answer['_sources'],'native_calls'=>count($GLOBALS['test_calls'])-$before];
            }
            symlink('/verified/data','/verified/link');
            $answers[]=['permissions'=>function_exists('zfsmReadDatasetPermissions')?zfsmReadDatasetPermissions(array_replace($values,['mountpoint'=>'/verified/link'])):null];
            file_put_contents('/proc/self/mountinfo',"1 0 0:1 / / rw - tmpfs tmpfs rw\\n2 1 0:2 / /verified/data rw - zfs other/data rw\\n");
            $answers[]=['permissions'=>function_exists('zfsmReadDatasetPermissions')?zfsmReadDatasetPermissions($values):null];
            echo json_encode($answers,JSON_THROW_ON_ERROR);
        `});
        assert.equal(result.errors, '');
        assert.equal(result.exitCode, 0, result.text);
        const answers = JSON.parse(result.text);
        assert.deepEqual(answers[0].permissions, {status:'known', owner:'0', group:'0', uid:'0', gid:'0', mode:'0750', acl_type:'unknown', acl_state:'unknown', reason:''});
        assert.deepEqual(answers[0].sources, {compression:'inherited from cache', sync:'default', atime:'local'});
        for (const [index,answer] of answers.slice(0, 5).entries()) assert.equal(answer.native_calls, index===2?4:5);
        for (const answer of answers.slice(1)) {
            assert.equal(answer.permissions?.status, 'unknown');
            assert.equal(answer.permissions?.owner, null);
            assert.equal(answer.permissions?.group, null);
            assert.equal(answer.permissions?.mode, null);
            assert.ok(answer.permissions?.reason);
        }
    } finally { php.exit(); }
});
