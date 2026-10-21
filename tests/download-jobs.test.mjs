import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';
import {execFileSync} from 'node:child_process';

for(const [mode,size,payload,state,sent]of [['ok',6,'ABCDEF','completed',6],['abort',6,'ABCDEF','cancelled',2],['short',6,'ABCD','failed',4],['empty',0,'','completed',0]])test('actual download stream journals '+mode+' without confusing server bytes with saved file',async()=>{
 const php=await runtime();try{
  const source=process.env.ZFSM_DOWNLOAD_BEFORE_FIX?execFileSync('git',['show','b501968:src/include/ZFSMExplorer.php'],{encoding:'utf8'}):php.readFileAsText('/app/src/include/ZFSMExplorer.php'),start=source.indexOf('function zfsmStreamDownload('),end=source.indexOf('function zfsmRestoreSignature(',start);
  php.writeFile('/stream.php','<?php namespace TransferProbe;\n'+source.slice(start,end));
  const r=await php.run({code:`<?php namespace TransferProbe;
   require '/app/harness.php';$GLOBALS['zfsm_boot_id']='download-test-boot';
   function zfsmExplorerOpen($request){$p=fopen('php://memory','w+');$out=fopen('php://memory','w+');$err=fopen('php://memory','w+');fwrite($out,substr(${JSON.stringify(payload)},2));rewind($out);return [$p,[1=>$out,2=>$err],[1=>json_encode(['ready'=>true,'size'=>${size}])."\\n".substr(${JSON.stringify(payload)},0,2),2=>'']];}
   function zfsmAbortProcess($p,$pipes){foreach($pipes as$h)fclose($h);fclose($p);$GLOBALS['aborted']++;}
   function connection_aborted(){return ${JSON.stringify(mode)}==='abort'?1:0;}
   function ob_get_level(){return 0;}
   function flush(){}
   require '/stream.php';$GLOBALS['aborted']=0;$j=\\zfsmRequestJobBegin('downloadsnapshotfile',['snapshot'=>'cache/data@base']);zfsmStreamDownload([], 'file.bin','application/octet-stream');
   echo "\\n".json_encode(['job'=>\\zfsmReadJob($j['id']),'cleaned'=>$GLOBALS['aborted']]);`});
  const at=r.text.lastIndexOf('\n'),body=r.text.slice(0,at),out=JSON.parse(r.text.slice(at+1));assert.equal(body,payload.slice(0,sent));assert.equal(out.job.state,state);assert.equal(out.job.type,'download');assert.equal(out.job.progress.bytes,sent);assert.equal(out.job.progress.total,size);assert.equal(out.cleaned,1);assert.equal(out.job.result.confirmation,'server_stream_only');assert.equal(out.job.progress.percent===100,state==='completed');
 }finally{php.exit();}
});
