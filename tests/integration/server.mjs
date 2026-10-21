import http from 'node:http';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {runtime} from '../php-runtime.mjs';
import {createModel} from '../gui/mock-server.mjs';

const repo=resolve(import.meta.dirname,'../..');
export async function startIntegration({protection=false,dependencyUsage=false}={}) {
 const php=await runtime();
 // Virtual-copy adapters only; unmodified production endpoint is required below.
 function replace(file,name,replacement) {
  const source=php.readFileAsText(file),start=source.indexOf('function '+name+'(');assert.ok(start>=0,name);
  const next=source.indexOf('\nfunction ',start+1);php.writeFile(file,source.slice(0,start)+replacement+'\n'+(next<0?'':source.slice(next)));
 }
 replace('/app/src/include/ZFSMHelpers.php','runProcess','function runProcess($command,$args=[],$stdin=null){return integrationProcess($command,$args,$stdin);}');
 replace('/app/src/include/ZFSMExplorer.php','zfsmExplorerCall','function zfsmExplorerCall($args){return integrationFiles($args);}');
 replace('/app/src/include/ZFSMExplorer.php','zfsmStreamDownload','function zfsmStreamDownload($request,$filename,$type){integrationDownload($request,$filename,$type);}');
 replace('/app/src/include/ZFSMJobProcess.php','zfsmStreamProcess','function zfsmStreamProcess($command,$args,$chunk,$cancel,$failure=null,$stdin=null){return integrationStream($command,$args,$chunk,$cancel,$failure,$stdin);}');
 replace('/app/src/include/ZFSMJobs.php','zfsmStartWorker','function zfsmStartWorker(){return true;}');
 // WASM libc lacks GLOB_BRACE. Expand the same two filesystem patterns in
 // the virtual copy only; production enumeration/filters remain intact.
 const operations=php.readFileAsText('/app/src/backend/ZFSMOperations.php');assert.ok(operations.includes("glob(rtrim($real_path, '/').'/{,.}*', GLOB_ONLYDIR | GLOB_BRACE)"));
 php.writeFile('/app/src/backend/ZFSMOperations.php',operations.replace("glob(rtrim($real_path, '/').'/{,.}*', GLOB_ONLYDIR | GLOB_BRACE)","array_merge(glob(rtrim($real_path, '/').'/*', GLOB_ONLYDIR)?:[],glob(rtrim($real_path, '/').'/.*', GLOB_ONLYDIR)?:[])"));
 for(const dir of ['/acceptance','/usr/local/emhttp/webGui/include','/usr/local/emhttp/plugins','/var/lock','/var/local/emhttp','/proc/self','/proc/sys/kernel/random','/boot/config/plugins/zfs.master.ui','/boot/config/plugins/dynamix','/etc/cron.d'])php.mkdir(dir);
 if(dependencyUsage){
  // Simulate only the external ZFS read process; retain discovery, config
  // parsing, dependency guards, endpoint and directory identity validation.
  replace('/app/src/include/ZFSMUsage.php','zfsmUsageProcess','function zfsmUsageProcess($tool,$args,$deadline){return integrationProcess(basename($tool),$args);}');
  for(const dir of ['/usr/sbin','/etc/samba'])php.mkdir(dir);
  php.writeFile('/usr/sbin/zfs','SYNTHETIC executable; process boundary is simulated');
  await php.run({code:"<?php foreach(['/','/usr','/usr/sbin','/usr/sbin/zfs'] as $p)chmod($p,0755);"});
 }
 php.writeFile('/acceptance/system.php',await readFile('tests/integration/system.php'));
 php.writeFile('/usr/local/emhttp/webGui/include/Helpers.php','<?php');
 php.symlink('/app/src','/usr/local/emhttp/plugins/zfs.master.ui');
 php.writeFile('/var/local/emhttp/var.ini','csrf_token="integration-token"\n');
 php.writeFile('/proc/sys/kernel/random/boot_id','synthetic-integration-boot');
 php.writeFile('/etc/cron.d/root','0 3 * * 0 /usr/local/emhttp/plugins/dynamix/scripts/zfs_scrub start cache\n');
 const cfg=createModel().config;
 if(protection){
  for(const dir of ['/var/log/plugins','/usr/local/sbin','/usr/sbin','/etc/sanoid','/bin'])php.mkdir(dir);
  php.writeFile('/var/log/plugins/zfs.master.ui.local.plg','<PLUGIN name="zfs.master.ui"/>');
  php.writeFile('/var/log/plugins/unRAID6-Sanoid.plg','<!DOCTYPE PLUGIN [<!ENTITY name "unRAID6-Sanoid"><!ENTITY version "2.3.0">]><PLUGIN name="&name;"/>');
  for(const file of ['/usr/sbin/sanoid','/usr/sbin/syncoid','/usr/local/sbin/update_cron','/bin/bash'])php.writeFile(file,'SYNTHETIC TEST EXECUTABLE; only process boundary is simulated');
  php.writeFile('/etc/sanoid/sanoid.defaults.conf','[template_default]\nhourly=24\nautosnap=yes\nautoprune=no\n');
  php.writeFile('/acceptance/protection-permissions.php',"<?php foreach(['/var','/var/log','/var/log/plugins','/usr','/usr/sbin','/usr/local','/usr/local/sbin','/etc','/etc/sanoid','/bin'] as $d)chmod($d,0755);foreach(['/usr/sbin/sanoid','/usr/sbin/syncoid','/usr/local/sbin/update_cron','/bin/bash'] as $p)chmod($p,0755);chmod('/var/log/plugins/unRAID6-Sanoid.plg',0644);chmod('/var/log/plugins/zfs.master.ui.local.plg',0644);chmod('/etc/sanoid/sanoid.defaults.conf',0644);");
  await php.run({scriptPath:'/acceptance/protection-permissions.php'});
 }
 cfg.destructive_mode=1;cfg.lazy_load=0;cfg.sanoid_integration=0;cfg.directory_listing=['cache/__mock__/project'];cfg.refresh_interval=['0','30'].includes(process.env.ZFSM_REFRESH_INTERVAL)?Number(process.env.ZFSM_REFRESH_INTERVAL):0;
 if(protection)cfg.sanoid_integration=1;
 php.writeFile('/boot/config/plugins/zfs.master.ui/zfs.master.ui.cfg','[general]\n'+Object.entries(cfg).map(([key,v])=>(key==='dataset_exclusion'?'exclusion':key)+' = "'+String(v).replaceAll('"','\\"')+'"').join('\n')+'\n[future]\nkeep = "preserved"\n');
 php.writeFile('/boot/config/plugins/dynamix/dynamix.cfg','[display]\ntheme="black"\n');
 const seed=createModel(),datasets={},snapshots={};
 function walk(row){datasets[row.name]={...row};delete datasets[row.name].child;delete datasets[row.name].snapshots;delete datasets[row.name].directories;for(const snap of row.snapshots||[])snapshots[snap.name]={...snap,type:'snapshot',origin:'-',mountpoint:'-',encryptionroot:'-'};for(const child of Object.values(row.child||{}))walk(child);}
 walk(seed.inventory().data.datasets.cache);
 for(const snapshot of Object.values(snapshots))snapshot.userrefs=0;
 const status='  pool: cache\n state: ONLINE\n  scan: none requested\nconfig:\n\n        NAME STATE READ WRITE CKSUM\n        cache ONLINE 0 0 0\n          disk1 ONLINE 0 0 0\n\nerrors: No known data errors\n';
 const model={datasets,snapshots,status,pool_list:'NAME SIZE ALLOC FREE CKPOINT EXPANDSZ FRAG CAP DEDUP HEALTH ALTROOT\ncache 1000 100 900 - - 0 10 1.00 ONLINE -\n  disk1 1000 100 900 - - 0 10 - ONLINE\n',guid:9000000,calls:[],helper_calls:[],downloads:[],files:[{name:'notes.txt',path:'notes.txt',type:'file',size:2048,mtime:1700000000,available:true},{name:'folder',path:'folder',type:'directory',size:0,mtime:1700000000,available:true},{name:'inside.txt',path:'folder/inside.txt',type:'file',size:1024,mtime:1700000000,available:true}]};
 if(protection)model.protection={enabled:true};
 let mounts='1 0 0:1 / / rw - rootfs rootfs rw\n',id=1;const mountIds=new Map([['/',1]]);
 for(const row of Object.values(datasets)){if(row.type!=='filesystem'||!row.mountpoint?.startsWith('/'))continue;php.mkdir(row.mountpoint);const parent=[...mountIds.keys()].filter(path=>row.mountpoint.startsWith(path==='/'?'/':path+'/')).sort((a,b)=>b.length-a.length)[0];mounts+=(++id)+' '+mountIds.get(parent)+' 0:'+id+' / '+row.mountpoint+' rw - zfs '+row.name+' rw\n';mountIds.set(row.mountpoint,id);}
 for(const row of Object.values(snapshots)){const [owner,short]=row.name.split('@');if(datasets[owner]?.mountpoint?.startsWith('/'))php.mkdir(datasets[owner].mountpoint+'/.zfs/snapshot/'+short);}
 const directoryOwner='cache/__mock__/project',directoryMount=datasets[directoryOwner].mountpoint;
 const directoryFixtures=Object.fromEntries(['move','delete','stale','convert','unsupported'].map(name=>[name,directoryMount+'/'+name+'-0777']));
 for(const path of Object.values(directoryFixtures)){php.mkdir(path);php.writeFile(path+'/retained.txt','ordinary directory fixture; preserve source identity');}
 // WASM chmod/dev/ino are real. chown/chgrp may remain UID/GID0; record the
 // observed values rather than presenting this stand as native ownership proof.
 const fixtureState=await php.run({code:'<?php $out=[];foreach('+JSON.stringify([directoryMount,...Object.values(directoryFixtures)])+' as $path){@chown($path,99);@chgrp($path,100);chmod($path,0777);clearstatcache(true,$path);$s=lstat($path);$out[$path]=["uid"=>$s["uid"],"gid"=>$s["gid"],"mode"=>$s["mode"]&07777,"identity"=>["dev"=>(string)$s["dev"],"ino"=>(string)$s["ino"]]];}echo json_encode($out);'});
 assert.equal(fixtureState.errors,'',fixtureState.errors);model.directory_fixtures={owner:directoryOwner,mountpoint:directoryMount,paths:directoryFixtures,metadata:JSON.parse(fixtureState.text)};
 php.writeFile('/proc/self/mountinfo',mounts);php.writeFile('/acceptance/model.json',JSON.stringify(model));
 const pageSource=(await readFile('src/ZFSDirector.page','utf8')).split('---\n').slice(1).join('---\n');
 php.writeFile('/acceptance/page.php',pageSource);
 const bootstrap="<?php require '/acceptance/system.php'; date_default_timezone_set('UTC'); $docroot='/usr/local/emhttp'; $var=['csrf_token'=>'integration-token']; $display=['theme'=>'black']; require ";
 php.writeFile('/acceptance/admin.php',bootstrap+"'/app/src/backend/ZFSMAdmin.php';");
 php.writeFile('/acceptance/render.php',bootstrap+"'/acceptance/page.php';");
 let queue=Promise.resolve();const calls=[],errors=[];
 const run=options=>{const work=queue.then(()=>php.run(options));queue=work.catch(()=>{});return work;};
 const server=http.createServer(async(req,res)=>{
  try {
   const path=new URL(req.url,'http://local').pathname;
   if(path.startsWith('/plugins/zfs.master.ui/frontend/')){const name=path.slice('/plugins/zfs.master.ui/frontend/'.length);if(!/^[A-Za-z0-9.-]+$/.test(name))throw Error('Invalid asset');res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(repo+'/src/frontend/'+name));return;}
   if(path==='/'||path==='/plugins/zfs.master.ui/backend/ZFSMAdmin.php'){
    let body='';for await(const chunk of req)body+=chunk;
    if(path!=='/')calls.push({method:req.method,body});
    const result=await run({scriptPath:path==='/'?'/acceptance/render.php':'/acceptance/admin.php',method:req.method,body:Buffer.from(body),headers:{'content-type':req.headers['content-type']||'application/x-www-form-urlencoded',...(req.headers['x-csrf-token']?{'x-csrf-token':req.headers['x-csrf-token']}:{})},$_SERVER:{DOCUMENT_ROOT:'/usr/local/emhttp'}});
    if(result.errors)errors.push(result.errors);
    res.statusCode=result.httpStatusCode;for(const [name,value]of Object.entries(result.headers))res.setHeader(name,value);
    if(path==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:14px;background:#1b1b1b;color:#eee;font:14px system-ui}</style><aside>LOCAL INTEGRATION · actual PHP endpoint · synthetic ZFS/filesystem · no Unraid</aside>'+result.text);}else res.end(Buffer.from(result.bytes));return;
   }res.statusCode=404;res.end();
  }catch(error){errors.push(error.stack);res.statusCode=500;res.end(JSON.stringify({failed:{integration:error.message}}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {url:'http://127.0.0.1:'+server.address().port,php,calls,errors,readModel:()=>JSON.parse(php.readFileAsText('/acceptance/model.json')),writeModel:m=>php.writeFile('/acceptance/model.json',JSON.stringify(m)),run,close:async()=>{await new Promise(resolve=>server.close(resolve));await queue;php.exit();}};
}
