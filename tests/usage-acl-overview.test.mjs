import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';

function render(metadata={},fresh=true){
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),host=dom.window.document.querySelector('main');
 dom.window.eval(readFileSync('src/frontend/ZFSMOverview.js','utf8'));
 const node={name:'cache/data',type:'filesystem',guid:'99',encryption:'off',child:{},snapshots:[]};
 dom.window.zfsmRenderDatasetOverview(host,{node,pool:'cache',fresh:true,loaded:true,propertiesFresh:fresh,properties:{...node,...metadata},bytes:x=>x+' B',date:String,onAction(){},onTab(){}});
 return {host,dom};
}
test('Overview renders verified service paths and detailed ACL masks as text',()=>{
 const metadata={_usage:{smb:{status:'known',entries:[{name:'<img src=x onerror=alert(1)>',path:'/mnt/cache/data'}]},nfs:{status:'known',entries:[]},docker:{status:'unknown',reason:'Unresolved alias',entries:[{name:'worker',state:'running',path:'/mnt/cache/data/app',destination:'/data'}]},vm:{status:'unavailable',reason:'Libvirt unavailable',entries:null}},_acl:{status:'known',entries:[{scope:'access',tag:'user',id:'1000',permissions:'rwx',effective:'r-x',masked:true}],extended:true,has_default:false}};
 const x=render(metadata);try{
  assert.match(x.host.textContent,/SMB: 1 configured use/);assert.match(x.host.textContent,/NFS: No configured use found/);assert.match(x.host.textContent,/Docker: Unknown/);assert.match(x.host.textContent,/VM: Not available/);
  assert.match(x.host.textContent,/Unresolved alias/);assert.match(x.host.textContent,/worker.*running.*\/mnt\/cache\/data\/app.*\/data/);assert.match(x.host.textContent,/Extended POSIX ACL/);
  assert.match(x.host.textContent,/Docker: verified references shown; discovery is incomplete/);
  const table=x.host.querySelector('details table');assert.ok(table);assert.match(table.textContent,/1000.*rwx.*r-x.*Yes/);assert.equal(x.host.querySelector('img,script'),null);
 }finally{x.dom.window.close();}
});
test('Overview distinguishes failed and unavailable ACL from known empty usage and ignores stale metadata',()=>{
 for(const [status,label]of [['error','Error'],['unavailable','Not available'],['unknown','Unknown']]){
  const x=render({_acl:{status,reason:'ACL failure reason',entries:null}});try{assert.match(x.host.textContent,new RegExp('ACL entries'+label));assert.match(x.host.textContent,/ACL failure reason/);assert.equal(x.host.querySelector('details table'),null);}finally{x.dom.window.close();}
 }
 const x=render({_usage:{smb:{status:'known',entries:[{name:'STALE-SERVICE',path:'/stale'}]}},_acl:{status:'known',entries:[{id:'STALE-ACL'}]}},false);try{assert.doesNotMatch(x.host.textContent,/STALE-SERVICE|STALE-ACL/);}finally{x.dom.window.close();}
});
test('Overview shows native dependency evidence and links to Unraid service owners',()=>{
 const x=render({_dependencies:{status:'known',source:'zfs + mountinfo',entries:[{kind:'clone',name:'cache/clone',origin:'cache/data@base'},{kind:'nested_mount',name:'tmpfs',path:'/mnt/cache/data/temp'}]},_usage:{docker:{status:'known',entries:[{name:'worker',path:'/mnt/cache/data'}]}}});
 try{assert.match(x.host.textContent,/Dependencies.*clone.*cache\/clone.*cache\/data@base/s);assert.match(x.host.textContent,/zfs \+ mountinfo/);assert.equal(x.host.querySelector('a[href="/Docker"]')?.textContent,'Open Docker');}finally{x.dom.window.close();}
});

test('verified alias and zvol references stay visible with their proof and configured path',()=>{
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window,host=w.document.querySelector('main');w.eval(readFileSync('src/frontend/ZFSMOverview.js','utf8'));const node={name:'cache/vm',type:'volume',guid:'501',child:{},snapshots:[]};
 w.zfsmRenderDatasetOverview(host,{node,pool:'cache',fresh:true,loaded:true,propertiesFresh:true,properties:{...node,_usage:{vm:{status:'known',entries:[{name:'machine',path:'/dev/zd7',configured_path:'/dev/zvol/cache/vm',evidence:'zvol_device_identity'}]}}},bytes:String,date:String,onAction(){},onTab(){}});
 try{assert.match(host.textContent,/1 verified reference/);assert.match(host.textContent,/Verified zvol device/);assert.match(host.textContent,/\/dev\/zvol\/cache\/vm/);}finally{w.close();}
});
