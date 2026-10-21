import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';
test('pool monitor deduplicates retries recovers and preserves corrupt transition state',async()=>{
 const php=await runtime();try{const r=await php.run({code:`<?php require '/app/harness.php';
 $directory='/monitor-state';zfsmJobDirectory($directory);$sent=[];$fail=false;
 $send=function($pool,$severity,$reasons)use(&$sent,&$fail){$sent[]=[$pool,$severity,$reasons];return !$fail;};
 $d=['pool'=>'cache','health'=>'ONLINE','severity'=>'warning','reasons'=>['Pool feature notice']];
 same(true,zfsmMonitorTransition($directory,$d,$send));same(false,zfsmMonitorTransition($directory,$d,$send));same(1,count($sent));
 $d['severity']='error';$d['health']='DEGRADED';same(true,zfsmMonitorTransition($directory,$d,$send));same('error',$sent[1][1]);
 $d['severity']='ok';$d['health']='ONLINE';$d['reasons']=[];same(false,zfsmMonitorTransition($directory,$d,$send));same(2,count($sent));
 $d['severity']='warning';$d['reasons']=['Repeated issue'];$fail=true;same(false,zfsmMonitorTransition($directory,$d,$send));$fail=false;same(true,zfsmMonitorTransition($directory,$d,$send));same(4,count($sent));
 $raw='{broken monitor state';file_put_contents($directory.'/health.json',$raw);
 same(true,zfsmMonitorTransition($directory,$d,$send));same(false,zfsmMonitorTransition($directory,$d,$send));same(5,count($sent));
 $retained=glob($directory.'/health.json.corrupt-*');same(1,count($retained));same($raw,file_get_contents($retained[0]));
 echo 'PASS warning/error retries recovery and corrupt-state retention';`});assert.equal(r.errors,'');assert.equal(r.exitCode,0,r.text);console.log(r.text);}finally{php.exit();}
});
