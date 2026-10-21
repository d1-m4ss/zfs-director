import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {runtime} from './php-runtime.mjs';
import {startIntegration} from './integration/server.mjs';

test('job runners record actual attempt start/end and leave crash time unknown',async()=>{
 const php=await runtime();try{
 const result=await php.run({code:`<?php require '/app/harness.php';
 $GLOBALS['plugin_state']='/timing-jobs';$GLOBALS['plugin_runtime']='/timing-runtime';$GLOBALS['zfsm_boot_id']='boot';
 function timedConversion($n,$changes=[]){$id='20261016-120000-'.str_pad(dechex($n),12,'0',STR_PAD_LEFT);$source='/test/source';return array_replace(['schema'=>1,'id'=>$id,'state'=>'queued','stage'=>'planned','source'=>$source,'source_identity'=>['dev'=>'1','ino'=>'2'],'recovery'=>$source.'_zfsm_recovery_'.$id,'dataset'=>'cache/source','owner_dataset'=>'cache','owner_guid'=>'123','owner_mountpoint'=>'/test','pool'=>'cache','ack_boot'=>'boot','cancel_requested'=>false,'created'=>'2000-01-01T00:00:00+00:00'],$changes);}
 function timedRestore($n,$changes=[]){$id=timedConversion($n)['id'];$staging='/test/.zfsm-restore-'.$id;return array_replace(['schema'=>2,'type'=>'restore','id'=>$id,'state'=>'queued','stage'=>'planned','snapshot'=>'cache/data@saved','snapshot_guid'=>'77','dataset'=>'cache/data','owner_guid'=>'99','owner_mountpoint'=>'/test','source'=>'cache/data@saved','target'=>'/test','staging'=>$staging,'hold_tag'=>'zfsm_restore_'.$id,'hold_owned'=>false,'cancel_requested'=>false,'ack_boot'=>'boot','mode'=>'new','bytes'=>0,'files'=>0,'conflicts'=>0,'recovery'=>'','created'=>'2000-01-01T00:00:00+00:00'],$changes);}
 $jobs=[];
 $job=timedConversion(1,['started_at'=>'2001-01-01T00:00:00+00:00','finished_at'=>'2001-01-01T00:00:30+00:00']);zfsmJobAtomicWrite(zfsmJobFile($job['id']),$job);expectProcess('zfs',['list','-H','-o','name,mountpoint,mounted','-t','filesystem'],'');$jobs['conversion_failure']=zfsmRunConversionJob($job['id']);
 $job=timedConversion(2,['state'=>'running','stage'=>'copying','started_at'=>'2001-01-01T00:00:00+00:00']);zfsmJobAtomicWrite(zfsmJobFile($job['id']),$job);$jobs['conversion_crash']=zfsmRunConversionJob($job['id']);
 $job=timedRestore(3);zfsmJobAtomicWrite(zfsmJobFile($job['id']),$job);zfsmRunRestoreJob($job['id']);$jobs['restore_failure']=zfsmReadJob($job['id']);
 $job=timedRestore(4,['state'=>'running','stage'=>'copying','started_at'=>'2001-01-01T00:00:00+00:00']);zfsmJobAtomicWrite(zfsmJobFile($job['id']),$job);zfsmRunRestoreJob($job['id']);$jobs['restore_crash']=zfsmReadJob($job['id']);
 $job=timedRestore(5,['cancel_requested'=>true]);zfsmJobAtomicWrite(zfsmJobFile($job['id']),$job);zfsmRunRestoreJob($job['id']);$jobs['cancel_before_start']=zfsmReadJob($job['id']);
 echo json_encode($jobs,JSON_THROW_ON_ERROR);`});
 const jobs=JSON.parse(result.text);assert.equal(result.errors,'');
 for(const name of ['conversion_failure','restore_failure']){assert.ok(Date.parse(jobs[name].started_at)>Date.parse('2020-01-01'));assert.ok(Date.parse(jobs[name].finished_at)>=Date.parse(jobs[name].started_at));}
 for(const name of ['conversion_crash','restore_crash']){assert.equal(jobs[name].state,'recovery_required');assert.equal(jobs[name].started_at,'2001-01-01T00:00:00+00:00');assert.equal(jobs[name].finished_at??null,null);}
 assert.equal(jobs.cancel_before_start.started_at??null,null);assert.equal(jobs.cancel_before_start.finished_at??null,null);
 }finally{php.exit();}
});

async function timingView(jobs,worker=true){
 const dom=new JSDOM('<main></main>',{url:'http://fixture.local/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,root=w.document.querySelector('main');
 w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.scrollTo=()=>{};w.ResizeObserver=class{observe(){}disconnect(){}};w.zfsmFormatDateTime=x=>String(x);w.Date.now=()=>Date.parse('2026-10-16T12:01:00Z');
 for(const file of ['ZFSMInventory.js','ZFSMForms.js','ZFSMSnapshots.js','ZFSMExplorer.js','ZFSMPoolView.js','ZFSMOverview.js','ZFSMHistory.js','ZFSMWorkspace.js'])w.eval(readFileSync('src/frontend/'+file,'utf8'));
 const app=w.zfsmCreateWorkspace({root,config:{refresh_interval:0},request:async fields=>{if(fields.cmd==='conversionjobs')return {jobs,worker_running:worker};if(fields.cmd==='inventory')return {op:'getAll',data:{pools:{},datasets:{},devices:{},errors:{}}};throw Error('unexpected '+fields.cmd);}});
 for(let n=0;n<50;n++)await Promise.resolve();[...root.querySelectorAll('button')].find(b=>/^Jobs/.test(b.textContent)).click();for(let n=0;n<50;n++)await Promise.resolve();
 return {root,close(){app.stop();w.close();}};
}
test('Jobs uses per-attempt timestamps and never queue/cleanup timestamps as duration',async()=>{
 const common={schema:1,source:'/source',created:'2026-10-16T10:00:00Z',updated:'2026-10-16T13:00:00Z',stage:'copying',actions:{}};
 const x=await timingView([{...common,id:'legacy',state:'completed'},{...common,id:'complete',state:'completed',started_at:'2026-10-16T12:00:00Z',finished_at:'2026-10-16T12:00:20Z'},{...common,id:'running',state:'running',started_at:'2026-10-16T12:00:00Z'},{...common,id:'crashed',state:'recovery_required',started_at:'2026-10-16T12:00:00Z'},{...common,id:'queued-resume',state:'queued',started_at:'2026-10-16T11:00:00Z',finished_at:'2026-10-16T11:30:00Z'}]);
 try{const text=id=>x.root.querySelector('[data-job-id="'+id+'"]').textContent;
 assert.match(text('legacy'),/Attempt started: Unknown/);assert.match(text('legacy'),/Attempt elapsed: Unknown/);assert.match(text('complete'),/Attempt elapsed: 20 s/);assert.match(text('running'),/Attempt elapsed: 60 s/);assert.match(text('crashed'),/Attempt elapsed: Unknown/);assert.match(text('queued-resume'),/Attempt started: Unknown/);assert.match(text('queued-resume'),/Attempt elapsed: Unknown/);assert.match(text('complete'),/Queued: 2026-10-16T10:00:00Z/);
 }finally{x.close();}
});
test('a stopped worker cannot turn an unfinished attempt into increasing elapsed duration',async()=>{
 const x=await timingView([{id:'stopped',schema:1,state:'running',stage:'copying',started_at:'2026-10-16T12:00:00Z',actions:{}}],false);try{assert.match(x.root.querySelector('[data-job-id="stopped"]').textContent,/Attempt elapsed: Unknown/);}finally{x.close();}
});

test('completed restore and archive record end timestamps that later cleanup preserves',async()=>{
 const stand=await startIntegration();try{
 const result=await stand.run({code:`<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';
 $m=integrationModel();$snapshot=null;foreach($m['snapshots']as$name=>$row)if(str_ends_with($name,'/project@base')){$snapshot=$name;break;}$guid=$m['snapshots'][$snapshot]['guid'];
 $archive=zfsmQueueArchive($snapshot,['notes.txt'],$guid);zfsmRunRestoreJob($archive['id']);$archive=zfsmReadJob($archive['id']);
 $preview=zfsmPreviewRestore($snapshot,['notes.txt'],'timed-restore','new','timing-secret',$guid);$restore=zfsmQueueRestore($preview['id'],$preview['token'],'timing-secret','1');zfsmRunRestoreJob($restore['id']);$restore=zfsmReadJob($restore['id']);
 zfsmRunRestoreJob($archive['id']);zfsmRunRestoreJob($restore['id']);echo json_encode(['archive'=>$archive,'restore'=>$restore,'after_archive'=>zfsmReadJob($archive['id']),'after_restore'=>zfsmReadJob($restore['id'])],JSON_THROW_ON_ERROR);`});
 assert.equal(result.errors,'');const jobs=JSON.parse(result.text);
 for(const type of ['archive','restore']){assert.equal(jobs[type].state,'completed',jobs[type].error);assert.ok(Number.isFinite(Date.parse(jobs[type].started_at)));assert.ok(Date.parse(jobs[type].finished_at)>=Date.parse(jobs[type].started_at));assert.equal(jobs['after_'+type].finished_at,jobs[type].finished_at);}
 }finally{await stand.close();}
});
