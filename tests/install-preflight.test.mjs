import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';

async function preflight(flag, job, mode='install') {
    const php=await runtime();
    try {
        php.mkdir('/state/jobs');
        const config='[general]\nsanoid_integration='+flag+'\n';
        php.writeFile('/state/zfs.master.ui.cfg',config);
        const path='/state/jobs/20261022-120000-aaaaaaaaaaaa.json';
        if(job)php.writeFile(path,JSON.stringify(job));
        // Only the CLI SAPI boundary changes; the standalone gate is real.
        const source=(await readFile('src/scripts/zfsm-upgrade-preflight.php','utf8')).replace("if(PHP_SAPI!=='cli')exit(2);",'');
        const result=await php.run({code:'<?php define("STDERR",fopen("php://stderr","w"));$argv=["preflight","/state",'+JSON.stringify(mode)+']; ?>'+source}).catch(error=>{if(error.response)return error.response;throw error;});
        assert.equal(php.readFileAsText('/state/zfs.master.ui.cfg'),config,'Preflight must not reset integration');
        if(job)assert.equal(php.readFileAsText(path),JSON.stringify(job),'Preflight must not change Jobs');
        return result;
    } finally {php.exit();}
}

test('installation accepts retained integration ON after uninstall without resetting settings',async()=>{
    const r=await preflight('1',{state:'completed',type:'deletion'});
    assert.equal(r.exitCode,0,r.errors+r.text);
});
test('installation still refuses queued work, held snapshots and pending ZIP cleanup',async()=>{
    for(const job of [{state:'queued'},{state:'running'},{state:'completed',type:'restore',hold_owned:true},{state:'completed',type:'archive',hold_owned:false,archive_removed:false}]){
        const r=await preflight('1',job);assert.equal(r.exitCode,1,r.text);
    }
});
test('installation accepts inspected recovery and released file jobs but rejects invalid integration flags',async()=>{
    for(const job of [{state:'recovery_required',type:'conversion'},{state:'completed',type:'restore',hold_owned:false},{state:'completed',type:'archive',hold_owned:false,archive_removed:true}]){
        const r=await preflight('1',job);assert.equal(r.exitCode,0,r.errors+r.text);
    }
    const invalid=await preflight('unexpected',{state:'completed'});assert.equal(invalid.exitCode,1);
});
test('accepted boot keeps unresolved recovery paused rather than resuming it',async()=>{
    const r=await preflight('1',{state:'queued'},'accepted-boot');assert.equal(r.exitCode,10);
});
