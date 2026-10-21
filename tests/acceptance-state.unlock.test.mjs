import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtime } from './php-runtime.mjs';

const target = 'cache/secure';
const states = [
    ['inheriting child', 'encryption\taes-256-gcm\nencryptionroot\tcache\nkeystatus\tunavailable', false],
    ['unencrypted filesystem', 'encryption\toff\nencryptionroot\t-\nkeystatus\tnone', false],
    ['already unlocked root', 'encryption\taes-256-gcm\nencryptionroot\tcache/secure\nkeystatus\tavailable', false],
    ['incomplete state', 'encryption\taes-256-gcm\nencryptionroot\tcache/secure', false],
    ['locked root', 'encryption\taes-256-gcm\nencryptionroot\tcache/secure\nkeystatus\tunavailable', true]
];

for (const [name, state, allowed] of states) test('unlock endpoint rechecks ' + name + ' before native key loading', async () => {
    const php = await runtime();
    try {
        // Keep the endpoint, CSRF/identity gates and operations real. Simulate
        // only native commands, so the key-loading boundary can be observed.
        const helper = php.readFileAsText('/app/src/include/ZFSMHelpers.php');
        php.writeFile('/app/src/include/ZFSMHelpers.php', helper.replace(
            'return zfsmTestProcess($command, $args);', 'return zfsmAcceptanceUnlockProcess($command, $args);'));
        const encoded = Buffer.from(JSON.stringify({state, target})).toString('base64');
        const result = await php.run({code:`<?php
            // PHP-WASM omits POSIX's error-string lookup used by the endpoint.
            if(!function_exists('posix_strerror')){function posix_strerror($code){return $code===0?'Success':'Native error';}}
            function zfsmAcceptanceUnlockProcess($command,$args) {
                $GLOBALS['test_calls'][]=[$command,$args]; $target=$GLOBALS['unlock_fixture']['target'];
                if($command!=='zfs')throw new RuntimeException('Unexpected command');
                if($args===['list','-H','-p','-o','name,type,guid','-t','filesystem,volume,snapshot',$target])return ['code'=>0,'output'=>$target."\\tfilesystem\\t99"];
                if($args===['list','-H','-o','name','-t','filesystem',$target])return ['code'=>0,'output'=>$target];
                if($args===['get','-H','-o','property,value','encryption,encryptionroot,keystatus',$target])return ['code'=>0,'output'=>$GLOBALS['unlock_fixture']['state']];
                if($args===['load-key','-L','prompt',$target]||$args===['mount',$target])return ['code'=>0,'output'=>''];
                throw new RuntimeException('Unexpected simulated ZFS arguments');
            }
            require '/app/harness.php';
            function parse_plugin_cfg($plugin,$sections){return [];}
            $GLOBALS['unlock_fixture']=json_decode(base64_decode('${encoded}'),true);
            $docroot='/app/host';mkdir($docroot.'/webGui/include',0777,true);
            file_put_contents($docroot.'/webGui/include/Helpers.php','<?php');mkdir($docroot.'/plugins',0777,true);
            symlink('/app/src',$docroot.'/plugins/zfs.master.ui');
            $GLOBALS['var']=['csrf_token'=>'fixture-token']; $_SERVER['REQUEST_METHOD']='POST';
            $_POST=['cmd'=>'unlockdataset','zdataset'=>'cache/secure','expected_guid'=>'99','passphrase'=>'fixture-passphrase','csrf_token'=>'fixture-token'];
            ob_start();require '/app/src/backend/ZFSMAdmin.php';$body=ob_get_clean();
            echo json_encode(['answer'=>json_decode($body,true,512,JSON_THROW_ON_ERROR),'calls'=>$GLOBALS['test_calls']],JSON_THROW_ON_ERROR);
        `});
        assert.equal(result.errors, '', result.text);
        assert.equal(result.exitCode, 0, result.text);
        const answer = JSON.parse(result.text);
        const commands = answer.calls.map(([, args]) => args[0]);
        assert.equal(commands.includes('load-key'), allowed, 'Key loading eligibility must be checked in the backend');
        assert.equal(commands.includes('mount'), false, 'Without a saved mount journal Unlock must not guess previous mounts');
        if(allowed)assert.match(JSON.stringify(answer.answer.succeeded),/previous mount state unavailable/);
        assert.equal(Object.keys(answer.answer.succeeded).length > 0, allowed);
        assert.equal(Object.keys(answer.answer.failed).length > 0, !allowed);
    } finally { php.exit(); }
});
