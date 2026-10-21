import assert from 'node:assert/strict';import {test} from 'node:test';import {runtime} from './php-runtime.mjs';
const script=String.raw`<?php require '/app/harness.php';
function nextScrub($cron,$now,$zone='Europe/Helsinki'){$file='/cron-next';file_put_contents($file,$cron.' /usr/local/emhttp/plugins/dynamix/scripts/zfs_scrub start cache' . "\n");return zfsmNativeMaintenance('cache',$file,['now'=>strtotime($now),'evidence'=>fn()=>['timezone'=>$zone,'status'=>'verified']]);}
check('verified native weekly and monthly schedules return UTC instant and native timezone',function(){same('2026-10-19T03:00:00Z',nextScrub('0 6 * * 1','2026-10-18T12:00:00Z')['next_run']);same('2026-10-19 06:00 Europe/Helsinki',nextScrub('0 6 * * 1','2026-10-18T12:00:00Z')['next_run_local']);same('Europe/Helsinki',nextScrub('0 6 * * 1','2026-10-18T12:00:00Z')['timezone']);same('2026-11-01T06:00:00Z',nextScrub('0 6 1 * *','2026-10-18T12:00:00Z','UTC')['next_run']);});
check('next nominal minute handles spring gap and repeated autumn wall time',function(){same('2027-03-29T00:30:00Z',nextScrub('30 3 * * *','2027-03-27T23:59:00Z')['next_run']);same('2026-10-25T01:30:00Z',nextScrub('30 3 * * *','2026-10-25T00:45:00Z')['next_run']);});
check('unsupported dual day semantics malformed cron and unknown zone remain explicit Unknown',function(){foreach(['0 6 1 * 1','70 6 * * *','0 6 * * FUNDAY']as$c){$r=nextScrub($c,'2026-10-18T12:00:00Z');same(null,$r['next_run']);same(true,!empty($r['warning']));}same(null,nextScrub('0 6 * * *','2026-10-18T12:00:00Z','Unverified/Zone')['next_run']);});
check('native daemon directory and timezone evidence are read without any command',function(){
 foreach(['/usr/sbin','/usr/share/zoneinfo/Europe','/proc/321','/etc/cron.d']as$d)@mkdir($d,0755,true);file_put_contents('/usr/sbin/crond','fixture');chmod('/usr/sbin/crond',0755);file_put_contents('/usr/share/zoneinfo/Europe/Helsinki','TZifFIXTURE');symlink('/usr/share/zoneinfo/Europe/Helsinki','/etc/localtime');file_put_contents('/proc/321/comm',"crond\n");file_put_contents('/proc/321/cmdline',"/usr/sbin/crond\0-c\0/etc/cron.d\0");file_put_contents('/proc/321/environ',"UNRELATED_SECRET=DO_NOT_RETURN\0");symlink('/usr/sbin/crond','/proc/321/exe');symlink('/','/proc/321/root');file_put_contents('/etc/cron.d/root',"0 6 * * 1 /usr/local/emhttp/plugins/dynamix/scripts/zfs_scrub start cache\n");$r=zfsmNativeMaintenance('cache','/etc/cron.d/root',['now'=>strtotime('2026-10-18T12:00:00Z')]);same('2026-10-19T03:00:00Z',$r['next_run']);same(false,str_contains(json_encode($r),'DO_NOT_RETURN'));same([],$GLOBALS['test_calls']);
 file_put_contents('/proc/321/cmdline',"/usr/sbin/crond\0-c\0/other/cron\0-s\0/other/system\0");same(null,zfsmNativeMaintenance('cache')['next_run']);
});
check('Unraid dcron default system directory remains active independently of its user spool',function(){
 foreach(["/usr/sbin/crond\0","/usr/sbin/crond\0-c\0/other/users\0"]as$args){file_put_contents('/proc/321/cmdline',$args);$r=zfsmNativeMaintenance('cache','/etc/cron.d/root',['now'=>strtotime('2026-10-18T12:00:00Z')]);same('Europe/Helsinki',$r['timezone']);same('2026-10-19T03:00:00Z',$r['next_run']);}
 same([],$GLOBALS['test_calls']);
});
check('dcron system directory overrides do not validate the inactive default directory',function(){
 foreach(["/usr/sbin/crond\0-s\0/other/system\0","/usr/sbin/crond\0-s/other/system\0"]as$args){file_put_contents('/proc/321/cmdline',$args);same('unknown',zfsmNativeCronEvidence('/etc/cron.d/root')['status']);same('verified',zfsmNativeCronEvidence('/other/system/root')['status']);same('verified',zfsmNativeCronEvidence('/var/spool/cron/crontabs/root')['status']);}
 same([],$GLOBALS['test_calls']);
});
finishTests();`;
test('native maintenance reads cron/TZ and calculates only unambiguous nominal matches',async()=>{const php=await runtime();try{const r=await php.run({code:script});assert.equal(r.errors,'',r.text);assert.equal(r.exitCode,0,r.text);}finally{php.exit();}});
