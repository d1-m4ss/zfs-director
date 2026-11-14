import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';
// Deleting a ZIP job record also deletes its ZIP file; the file goes first and a failure keeps the record (JOBS-001, Q9).
async function run(code){const php=await runtime();try{const restore='/app/src/include/ZFSMRestore.php';php.writeFile(restore,php.readFileAsText(restore).replace('function zfsmCleanupArchive($job) {','function zfsmCleanupArchive($job) { return zfsmTestCleanupArchive($job);'));const r=await php.run({code:`<?php require '/app/harness.php';require_once '/app/src/include/ZFSMJobHistory.php';$GLOBALS['plugin_state']='/zip/jobs';$GLOBALS['plugin_runtime']='/zip/runtime';$GLOBALS['plugin_config']='/zip/plugin.cfg';$GLOBALS['plugin_lock']='/zip/operation.lock';$GLOBALS['zfsm_boot_id']='zip-test-boot';
function zfsmTestCleanupArchive($job){$log=json_decode(@file_get_contents('/zip/removed.json')?:'[]',true);if(!empty($GLOBALS['zip_fail']))throw new RuntimeException('Disk is read-only');$file='/zip/files/'.$job['id'].'.zip';if(!is_file($file))throw new RuntimeException('ZIP is missing');unlink($file);$log[]=$job['id'];file_put_contents('/zip/removed.json',json_encode($log));return 'removed';}
function zip($n,$hold=false){$id='20260101-120000-'.str_pad(dechex($n),12,'0',STR_PAD_LEFT);$mount='/mnt/cache/test';$j=['schema'=>2,'type'=>'archive','id'=>$id,'state'=>'completed','stage'=>'completed','snapshot'=>'cache/test@s','source'=>'cache/test@s','dataset'=>'cache/test','owner_guid'=>'123','snapshot_guid'=>'456','owner_mountpoint'=>$mount,'staging'=>$mount.'/.zfsm-archive-'.$id,'hold_tag'=>'zfsm_archive_'.$id,'hold_owned'=>$hold,'cancel_requested'=>false,'ack_boot'=>'zip-test-boot','target'=>'ZIP download','archive_removed'=>false,'destination_identity'=>['dev'=>'1','ino'=>'2'],'expires'=>1893456000,'archive_identity'=>['dev'=>'1','ino'=>'3','type'=>'file'],'archive_size'=>10,'created'=>'2026-01-01T12:00:00Z','updated'=>'2026-01-01T12:00:00Z','finished_at'=>'2026-01-01T12:00:00Z'];zfsmJobAtomicWrite(zfsmJobFile($id),$j);file_put_contents(zfsmJobFile($id).'.lock','');@mkdir('/zip/files',0700,true);file_put_contents('/zip/files/'.$id.'.zip','zip');return $id;}
${code}`});assert.equal(r.errors,'');assert.equal(r.exitCode,0,r.text);return JSON.parse(r.text);}finally{php.exit();}}

test('Delete finished jobs removes a ZIP record together with its ZIP file',async()=>{
 const x=await run(`$id=zip(1);$r=zfsmJobDeleteFinished();echo json_encode(['deleted'=>$r['deleted'],'kept'=>$r['kept'],'record'=>is_file(zfsmJobFile($id)),'zip'=>is_file('/zip/files/'.$id.'.zip'),'removed'=>json_decode(file_get_contents('/zip/removed.json'),true)===[$id]]);`);
 assert.deepEqual(x,{deleted:1,kept:[],record:false,zip:false,removed:true});
});
test('when the ZIP file cannot be removed the record stays and the answer says why',async()=>{
 const x=await run(`$id=zip(2);$GLOBALS['zip_fail']=true;$r=zfsmJobDeleteFinished();echo json_encode(['deleted'=>$r['deleted'],'kept'=>$r['kept'],'message'=>$r['succeeded']['jobs'],'record'=>is_file(zfsmJobFile($id)),'zip'=>is_file('/zip/files/'.$id.'.zip')]);`);
 assert.deepEqual(x,{deleted:0,kept:{'ZIP file could not be removed (Disk is read-only)':1},message:'Deleted 0 finished job record(s). Kept 1: 1 ZIP file could not be removed (Disk is read-only).',record:true,zip:true});
});
test('a ZIP record that holds a snapshot is kept and its ZIP file is not touched',async()=>{
 const x=await run(`$id=zip(3,true);$r=zfsmJobDeleteFinished();echo json_encode(['deleted'=>$r['deleted'],'kept'=>$r['kept'],'record'=>is_file(zfsmJobFile($id)),'zip'=>is_file('/zip/files/'.$id.'.zip')]);`);
 assert.deepEqual(x,{deleted:0,kept:{'still holds a snapshot':1},record:true,zip:true});
});
