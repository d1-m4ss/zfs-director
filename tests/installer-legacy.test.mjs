import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';

async function fixture(body) {
    const php=await runtime();
    try {
        php.writeFile('/legacy.php',await readFile('tools/installer-legacy.php','utf8'));
        const r=await php.run({code:`<?php require '/app/harness.php';require '/legacy.php';
        function putLegacy($name,$text){$p='/stand'.$name;@mkdir(dirname($p),0700,true);file_put_contents($p,$text);return $p;}
        $root='/stand';$backup='/stand/boot/config/plugins-removed/install-test';
        $config=putLegacy('/boot/config/plugins/zfs.master.ui/zfs.master.ui.cfg',"[general]\nsanoid_integration=1\n");
        $job=putLegacy('/boot/config/plugins/zfs.master.ui/jobs/original.json','retained job');
        $recovery=putLegacy('/data/recovery/original.txt','retained data');
        $external=putLegacy('/boot/config/plugins/user.scripts/script','external schedule');
        ${body}
        same("[general]\nsanoid_integration=1\n",file_get_contents($config));same('retained job',file_get_contents($job));same('retained data',file_get_contents($recovery));same('external schedule',file_get_contents($external));echo 'PASS';`});
        assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);assert.ok(r.text.includes('PASS'));
    } finally {php.exit();}
}
test('legacy cleanup removes duplicate PLGs and original Master code, preserves state and supports rollback',async()=>fixture(`
    $reg=putLegacy('/boot/config/plugins/zfs.master.ui.local.plg','old Director registration');
    $cached=putLegacy('/boot/config/plugins/zfs.master.ui/zfs.master.ui.plg','stale installer');
    $oldPackage=putLegacy('/boot/config/plugins/zfs.master.ui/zfs.master.ui-2025.01.01.tgz','old code archive');
    $master=putLegacy('/usr/local/emhttp/plugins/zfs.master/README.md','old Master code');
    $oldConfig=putLegacy('/boot/config/plugins/zfs.master/zfs.master.cfg','old Master setting');
    $plan=zfsdLegacyPlan($root,'zfs-director.plg');same(true,in_array($reg,$plan['moves'],true));
    zfsdLegacyInstall('apply',$root,'zfs-director.plg',$backup);
    foreach([$reg,$cached,$master,$oldConfig,$oldPackage]as$p)same(false,file_exists($p));
    zfsdLegacyInstall('rollback',$root,'zfs-director.plg',$backup);
    same('old Director registration',file_get_contents($reg));same('stale installer',file_get_contents($cached));same('old Master code',file_get_contents($master));same('old Master setting',file_get_contents($oldConfig));same('old code archive',file_get_contents($oldPackage));
`));
test('migration retains one identical cron source and rollback restores its original namespace',async()=>fixture(`
    $text="0 3 * * * /usr/bin/php /usr/local/emhttp/plugins/zfs.master.ui/scripts/zfsm-protection.php policy abc\n";
    $old=putLegacy('/boot/config/plugins/zfs.master.ui.local/protection.cron',$text);
    $target='/stand/boot/config/plugins/zfs-director/protection.cron';
    zfsdLegacyInstall('apply',$root,'zfs-director.plg',$backup);same(false,file_exists($old));same($text,file_get_contents($target));
    zfsdLegacyInstall('rollback',$root,'zfs-director.plg',$backup);same($text,file_get_contents($old));same(false,file_exists($target));
`));
test('conflicting cron definitions refuse cleanup before removing any old registration',async()=>fixture(`
    $reg=putLegacy('/boot/config/plugins/zfs.master.ui.local.plg','KEEP');
    putLegacy('/boot/config/plugins/zfs.master.ui.local/protection.cron',"0 3 * * * one\n");
    putLegacy('/boot/config/plugins/zfs-director/protection.cron',"0 4 * * * two\n");
    $blocked=false;try{zfsdLegacyInstall('apply',$root,'zfs-director.plg',$backup);}catch(RuntimeException $e){$blocked=true;}
    same(true,$blocked);same('KEEP',file_get_contents($reg));same(false,file_exists($backup));
`));
test('rollback restores an empty destination and is safe to repeat after apply',async()=>fixture(`
    $old=putLegacy('/boot/config/plugins/zfs.master.ui.local/protection.cron',"0 3 * * * schedule\n");
    $target=putLegacy('/boot/config/plugins/zfs-director/protection.cron','# empty');
    zfsdLegacyInstall('apply',$root,'zfs-director.plg',$backup);
    zfsdLegacyInstall('rollback',$root,'zfs-director.plg',$backup);
    same('# empty',file_get_contents($target));same("0 3 * * * schedule\n",file_get_contents($old));
    $j=json_decode(file_get_contents($backup.'/migration.json'),true);unset($j['rolled_back']);file_put_contents($backup.'/migration.json',json_encode($j));
    zfsdLegacyInstall('rollback',$root,'zfs-director.plg',$backup);
    same('# empty',file_get_contents($target));same("0 3 * * * schedule\n",file_get_contents($old));
`));
test('cleanup rejects redirected runtime and unexpected registration symlinks',async()=>fixture(`
    @mkdir('/stand/usr/local/emhttp/plugins',0700,true);symlink('/stand/data/recovery','/stand/usr/local/emhttp/plugins/zfs.master');
    $blocked=false;try{zfsdLegacyPlan($root,'zfs-director.plg');}catch(RuntimeException $e){$blocked=true;}same(true,$blocked);
    unlink('/stand/usr/local/emhttp/plugins/zfs.master');
    @mkdir('/stand/var/log/plugins',0700,true);symlink('/stand/data/recovery/original.txt','/stand/var/log/plugins/zfs.master.plg');
    $blocked=false;try{zfsdLegacyPlan($root,'zfs-director.plg');}catch(RuntimeException $e){$blocked=true;}same(true,$blocked);
`));
test('active legacy operations block cleanup while its read-only nchan monitor is recognized',async()=>fixture(`
    $cmd=putLegacy('/proc/123/cmdline',"/usr/bin/php\0/stand/usr/local/emhttp/plugins/zfs.master/backend/ZFSMOperations.php\0");
    $blocked=false;try{zfsdLegacyProcesses($root);}catch(RuntimeException $e){$blocked=true;}same(true,$blocked);
    file_put_contents($cmd,"/usr/bin/php\0-q\0/stand/usr/local/emhttp/plugins/zfs.master/nchan/zfs_master\0");
    same([123],array_keys(zfsdLegacyProcesses($root)));
`));
test('cleanup rejects child bind mounts but accepts the ordinary parent filesystem',async()=>fixture(`
    $m=putLegacy('/proc/self/mountinfo',"1 0 0:1 / /stand/boot rw - vfat flash rw\n");
    zfsdLegacyPlan($root,'zfs-director.plg');
    file_put_contents($m,"1 0 0:1 / /stand/usr/local/emhttp/plugins/zfs.master/nested rw - zfs test rw\n");
    $blocked=false;try{zfsdLegacyPlan($root,'zfs-director.plg');}catch(RuntimeException $e){$blocked=true;}same(true,$blocked);
`));
