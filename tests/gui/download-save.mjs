import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import http from 'node:http';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {startMock} from './mock-server.mjs';

// A download event only confirms attachment headers. Acceptance requires the
// completed browser-saved file, including its bytes after a slow transfer.
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const output=resolve(process.env.ZFSM_OUTPUT||'backups/zip-download-regression');
await mkdir(output,{recursive:true});
const fixture=output+'/fixture.zip';
execFileSync('python3',['-c',`import random,sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_STORED) as z:
 def put(name,data): z.writestr(zipfile.ZipInfo(name,(2000,1,1,0,0,0)),data)
 put('payload/blob.bin',random.Random(42).randbytes(64*1024*1024))
 put('payload/Пример файл.txt','Synthetic ZIP download regression\\n')
 put('payload/empty/','')`,fixture]);
const bytes=await readFile(fixture),sha=value=>createHash('sha256').update(value).digest('hex');
const mock=await startMock();if(['0','30'].includes(process.env.ZFSM_REFRESH_INTERVAL))assert.equal(mock.model.config.refresh_interval,Number(process.env.ZFSM_REFRESH_INTERVAL));let attachmentIsTopLevel=false;let sent=0,ended=false,closedEarly=false,fields,truncate=false;
const server=http.createServer(async(req,res)=>{
 try{
  let body='';for await(const chunk of req)body+=chunk;
  if(req.url==='/mock/admin'&&new URLSearchParams(body).get('cmd')==='downloadsnapshotarchive'){
   sent=0;fields=new URLSearchParams(body);res.writeHead(200,{'Content-Type':'application/zip','Content-Length':bytes.length,'Content-Disposition':'attachment; filename="snapshot-download.zip"; filename*=UTF-8\'\'snapshot-large-test.zip','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   res.on('close',()=>{closedEarly=sent!==bytes.length;});
   const timer=setInterval(()=>{if(res.destroyed){clearInterval(timer);return;}const end=Math.min(sent+65536,bytes.length);res.write(bytes.subarray(sent,end));sent=end;if(truncate&&sent>=131072){clearInterval(timer);res.destroy();return;}if(sent===bytes.length){clearInterval(timer);ended=true;res.end();}},10);return;
  }
  if(process.env.ZFSM_DOWNLOAD_BEFORE_FIX==='1'&&req.url==='/src/frontend/ZFSMWorkspace.js'){res.setHeader('Content-Type','text/javascript');res.end(execFileSync('git',['show','1193ff6:src/frontend/ZFSMWorkspace.js']));return;}
  const upstream=await fetch(mock.url+req.url,{method:req.method,headers:{'content-type':req.headers['content-type']||'text/plain'},...(req.method==='POST'?{body}:{})});
  res.writeHead(upstream.status,Object.fromEntries([...upstream.headers].filter(([name])=>!['content-length','content-encoding','transfer-encoding'].includes(name))));res.end(Buffer.from(await upstream.arrayBuffer()));
 }catch(error){res.writeHead(500);res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true});
const deadline=setTimeout(()=>{void browser.close().catch(()=>{});},60000);
try{
 const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();context.on('request',request=>{if(request.url()===url+'/mock/admin'&&new URLSearchParams(request.postData()||'').get('cmd')==='downloadsnapshotarchive'){try{attachmentIsTopLevel=request.isNavigationRequest()&&request.frame().parentFrame()===null;}catch(error){if(!request.isNavigationRequest()||!error.message.includes('before the frame is created'))throw error;attachmentIsTopLevel=true;}}});page.setDefaultTimeout(10000);await page.goto(url);
 await page.getByRole('button',{name:/^Jobs/}).click();await page.locator('[data-job-id="20261016-100003-333333333333"] > details > summary').click();
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'↓ Download ZIP',exact:true}).click();const download=await downloadPromise;
 assert.equal(attachmentIsTopLevel,true,'Attachment navigation must have its own top-level context; the in-app browser cancels hidden-frame downloads');
 assert.ok(sent<bytes.length,'Attachment headers arrive before the full archive; the event alone cannot pass acceptance');
 // ZIP download must not create a child browsing context in the opener.
 assert.equal(await page.locator('iframe[title="Snapshot download"]').count(),0);
 const saved=output+'/browser-saved.zip';await download.saveAs(saved);assert.equal(await download.failure(),null);
 const actual=await readFile(saved);assert.equal(actual.length,bytes.length);assert.equal(sha(actual),sha(bytes));assert.equal(ended,true);assert.equal(closedEarly,false);
 assert.equal(fields.get('csrf_token'),'fixture-token');assert.equal(fields.get('job_id'),'20261016-100003-333333333333');
 execFileSync('python3',['-c',"import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n assert len(z.infolist())==3",saved]);
 truncate=true;const interruptedPromise=page.waitForEvent('download');await page.getByRole('button',{name:'↓ Download ZIP',exact:true}).click();const interrupted=await interruptedPromise;assert.notEqual(await interrupted.failure(),null,'An interrupted attachment must fail even after its download event');assert.ok(sent<bytes.length);
 const result={status:'PASS',initial_refresh_interval:mock.model.config.refresh_interval,bytes:actual.length,sha256:sha(actual),crc_ok:true,attachment_event_precedes_completion:true,opener_stays_open:!page.isClosed(),csrf_in_post:true,top_level_attachment:true,interrupted_attachment_rejected:true};await writeFile(output+'/results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{clearTimeout(deadline);await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await mock.close();}
