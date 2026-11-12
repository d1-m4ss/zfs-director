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
test('a refused update names the pending jobs and what to do next',async()=>{
    const r=await preflight('1',{state:'queued',type:'replication',source:'cache/immich'});
    const text=r.errors+r.text;assert.equal(r.exitCode,1,text);
    assert.match(text,/Update paused: 1 job\(s\) still queued or running: replication cache\/immich \(queued\)/);
    assert.match(text,/Nothing was changed and the installed version keeps running/);assert.match(text,/Main > ZFS Director > Jobs/);assert.match(text,/Check for Updates/);assert.doesNotMatch(text,/--launch/);
    assert.doesNotMatch(text,/Pending or unverified/);
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
test('a scheduled policy check still queued in the tmpfs runtime directory also blocks the update (REL-002)',async()=>{
    const php=await runtime();
    try {
        php.mkdir('/state/jobs');
        php.writeFile('/state/zfs.master.ui.cfg','[general]\nsanoid_integration=1\n');
        // Durable plugin_state has no jobs at all; only the ephemeral runtime queue does.
        php.mkdir('/var/tmp/state/jobs/protection-queue');
        php.writeFile('/var/tmp/state/jobs/protection-queue/20261022-120000-aaaaaaaaaaaa.json',JSON.stringify({state:'queued',type:'policy',source:'cache/immich'}));
        const source=(await readFile('src/scripts/zfsm-upgrade-preflight.php','utf8')).replace("if(PHP_SAPI!=='cli')exit(2);",'');
        const result=await php.run({code:'<?php define("STDERR",fopen("php://stderr","w"));$argv=["preflight","/state","install"]; ?>'+source}).catch(error=>{if(error.response)return error.response;throw error;});
        const text=result.errors+result.text;
        assert.equal(result.exitCode,1,text);
        assert.match(text,/Update paused: 1 job\(s\) still queued or running: policy cache\/immich \(queued\)/);
    } finally {php.exit();}
});
test('preflight ignores a stale tmpfs leftover once its id already has a durable record (REL-002 crash window)',async()=>{
    const php=await runtime();
    try {
        const id='20261022-120000-aaaaaaaaaaaa';
        php.mkdir('/state/jobs');
        php.writeFile('/state/zfs.master.ui.cfg','[general]\nsanoid_integration=1\n');
        php.writeFile('/state/jobs/'+id+'.json',JSON.stringify({state:'completed',type:'policy'}));
        // A promotion crash: the durable copy above exists, but the tmpfs leftover for the
        // same id was never removed, and (worst case) still reads as running.
        php.mkdir('/var/tmp/state/jobs/protection-queue');
        php.writeFile('/var/tmp/state/jobs/protection-queue/'+id+'.json',JSON.stringify({state:'running',type:'policy',source:'cache/immich'}));
        const source=(await readFile('src/scripts/zfsm-upgrade-preflight.php','utf8')).replace("if(PHP_SAPI!=='cli')exit(2);",'');
        const result=await php.run({code:'<?php define("STDERR",fopen("php://stderr","w"));$argv=["preflight","/state","install"]; ?>'+source}).catch(error=>{if(error.response)return error.response;throw error;});
        assert.equal(result.exitCode,0,result.errors+result.text);
    } finally {php.exit();}
});
