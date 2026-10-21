import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startMock} from './gui/mock-server.mjs';

test('interactive mock can reuse its requested loopback port and serves uncached source',async()=>{
 const first=await startMock(),port=Number(new URL(first.url).port);await first.close();
 const second=await startMock({port});try{
  assert.equal(new URL(second.url).hostname,'127.0.0.1');assert.equal(Number(new URL(second.url).port),port);
  const page=await fetch(second.url),asset=await fetch(second.url+'/src/frontend/ZFSMWorkspace.js');
  assert.equal(page.headers.get('cache-control'),'no-store');assert.equal(asset.headers.get('cache-control'),'no-store');
 }finally{await second.close();}
});
