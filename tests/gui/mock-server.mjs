import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';

const repo=resolve(import.meta.dirname,'../..');
const seed=JSON.parse(await readFile(resolve(repo,'tests/gui/fixtures/server-metadata.json'),'utf8'));
function countServer(node){const children=Object.values(node.child||{}).map(countServer);return {datasets:1+children.reduce((n,c)=>n+c.datasets,0),snapshots:(node.snapshots||[]).length+children.reduce((n,c)=>n+c.snapshots,0)};}
export const serverCounts=countServer(seed.inventory.data.datasets.cache);
export const lab='cache/__mock__';
const now=()=>Math.floor(Date.now()/1000);
const token='a'.repeat(64);let nextGuid=1000000;
function node(name,extra={}) {
    return {name,guid:String(nextGuid++),encryptionroot:'none',mounted:'yes',type:'filesystem',used:10485760,available:1073741824,referenced:10485760,mountpoint:'/mnt/'+name,compression:'lz4',compressratio:100,usedbysnapshots:4096,quota:0,recordsize:131072,atime:'off',xattr:'sa',primarycache:'all',readonly:'off',casesensitivity:'sensitive',sync:'standard',creation:now()-86400,origin:'-',usedbydataset:10481664,usedbychildren:0,usedbyrefreservation:0,refquota:0,reservation:0,refreservation:0,encryption:'off',keystatus:'none',child:{},directories:[],snapshots:[],...extra};
}
function snapshot(dataset,suffix,extra={}) {return {name:dataset+'@'+suffix,guid:String(nextGuid++),used:4096,referenced:10485760,written:1024,defer_destroy:'off',userrefs:0,creation:now()-3600,...extra};}
export function createModel() {
    const data=structuredClone(seed.inventory.data),config=structuredClone(seed.config),calls=[],previews=new Map();
    if(['0','30'].includes(process.env.ZFSM_REFRESH_INTERVAL))config.refresh_interval=Number(process.env.ZFSM_REFRESH_INTERVAL);
    // ZFSMAdmin serializes empty mapping fields as objects, unlike raw PHP arrays.
    data.errors={...data.errors};
    // Historical metadata lacks immutable IDs: synthesize IDs for the local
    // model only, never claim these are the server GUIDs.
    function addMockIdentities(n){n.guid||=String(nextGuid++);for(const snap of n.snapshots||[])snap.guid||=String(nextGuid++);for(const child of Object.values(n.child||{}))addMockIdentities(child);}addMockIdentities(data.datasets.cache);
    const root=node(lab);data.datasets.cache.child[lab]=root;
    for(const name of ['project','clone','locked','unlocked','volume'])root.child[lab+'/'+name]=node(lab+'/'+name);
    const project=root.child[lab+'/project'];project.snapshots=[snapshot(project.name,'base'),snapshot(project.name,'protected',{userrefs:1,creation:now()-1800})];project.directories=['/mnt/'+lab+'/project/ordinary'];project._directory_identities={[project.directories[0]]:{dev:'1',ino:'100'}};
    root.child[lab+'/clone'].origin=project.name+'@base';
    Object.assign(root.child[lab+'/locked'],{encryption:'aes-256-gcm',keystatus:'unavailable',encryptionroot:lab+'/locked',mounted:'no'});
    Object.assign(root.child[lab+'/unlocked'],{encryption:'aes-256-gcm',keystatus:'available',encryptionroot:lab+'/unlocked',mounted:'yes'});
    root.child[lab+'/unlocked'].child[lab+'/unlocked/child']=node(lab+'/unlocked/child',{encryption:'aes-256-gcm',keystatus:'available',encryptionroot:lab+'/unlocked',mounted:'yes'});
    Object.assign(root.child[lab+'/volume'],{type:'volume',mountpoint:'none',volblocksize:16384});
    config.directory_listing=[project.name];
    const jobs=[{id:'20261016-100001-111111111111',schema:1,type:'conversion',owner_guid:'1',source_identity:{dev:'1',ino:'100'},source:'/mnt/'+lab+'/project/ordinary',target:lab+'/project/ordinary',state:'running',stage:'copying',created:now()-120,updated:now(),progress:{percent:35,rate:'10 MiB/s',remaining:'1 minute'}},
        {id:'20261016-100002-222222222222',schema:1,type:'conversion',owner_guid:'1',source_identity:{dev:'1',ino:'100'},source:'/mnt/'+lab+'/failed-directory',target:lab+'/failed-directory',state:'failed',stage:'copying',error:'Simulated interrupted copy',recovery:'/mnt/'+lab+'/.recovery',created:now()-200,updated:now()-60},
        {id:'20261016-100003-333333333333',schema:1,type:'archive',snapshot:project.name+'@base',source:project.name+'@base',state:'completed',stage:'completed',expires:now()+3600,bytes:1048576,created:now()-60,updated:now(),progress:{percent:100,bytes:1048576}}];
    let diagnostic=structuredClone(seed.diagnostic),sequence=4;
    const model={data,config,calls,jobs,previews,diagnostic,failedCommand:'',failedSnapshot:'',worker_running:true,restoreAvailable:true,snapshotGuid:'',fileMtime:now(),largeDirectory:false};
    function all(){const out=[];function walk(n){out.push(n);for(const child of Object.values(n.child||{}))walk(child);}walk(data.datasets.cache);return out;}
    const find=name=>all().find(n=>n.name===name);
    const findSnapshot=name=>all().flatMap(n=>n.snapshots||[]).find(s=>s.name===name);
    const fail=(target,message)=>({succeeded:{},failed:{[target||'request']:message}});
    const success=(target,message='Simulated success')=>({succeeded:{[target]:message},failed:{}});
    function insert(name,extra={}){const parent=find(name.slice(0,name.lastIndexOf('/')));if(!parent)throw Error('Missing parent');if(find(name))throw Error('Dataset already exists');return parent.child[name]=node(name,extra);}
    function remove(name){const parent=find(name.slice(0,name.lastIndexOf('/')));if(!parent?.child[name])throw Error('Unknown dataset');delete parent.child[name];}
    function queue(type,fields={}){const job={id:'20261016-1000'+String(sequence++).padStart(2,'0')+'-444444444444',schema:1,type,state:'queued',stage:'queued',created:now(),updated:now(),progress:{percent:0,bytes:0},...fields};jobs.unshift(job);return job;}
    function inventory(){const copy=structuredClone(data);const count=all().reduce((n,item)=>n+(item.snapshots||[]).length,0);copy.pools.cache.Snapshots=count;copy.datasets.cache.total_snapshots=count;return {op:'getAll',data:copy,config:structuredClone(config),publishing_paused:false};}
    function endpoint(fields) {
        const {cmd}=fields;const target=fields.zdataset||fields.snapshot||fields.directory||fields.job_id||fields.pool||'settings';
        if(model.failedCommand===cmd)throw Error('Simulated '+cmd+' failure');
        switch(cmd){
            case 'inventory':case 'inventorysnapshots':{if(cmd==='inventorysnapshots'&&model.pendingSnapshotReplacement){find(lab+'/project').guid=model.pendingSnapshotReplacement;model.pendingSnapshotReplacement='';}const answer=inventory();if(cmd==='inventory'&&Number(config.lazy_load)===1){answer.op='getDatasets';answer.data.pools.cache.Snapshots=null;}return answer;}
            case 'pooldiagnostics':{const d=structuredClone(model.diagnostic);if(fields.pool!=='cache'){d.pool=fields.pool;d.status.rows[0].name=fields.pool;d.information.rows[0].name=fields.pool;}return d;}
            case 'conversionjobs':{if(fields.filter||fields.sort||fields.view){
                const group=j=>['queued','running'].includes(j.state)?'active':j.state==='completed'?'completed':'needs_attention';
                let rows=jobs.filter(j=>(!fields.filter||fields.filter==='all'||fields.filter===group(j)||(fields.filter==='recovery'&&j.state==='recovery_required')||fields.filter===j.type)&&(fields.view!=='archived'));
                const time=j=>typeof j.created==='number'?j.created:Date.parse(j.created)/1000||0;
                rows.sort((a,b)=>{if(fields.sort==='attention'){const rank={needs_attention:0,active:1,completed:2},d=rank[group(a)]-rank[group(b)];if(d)return d;}const d=time(b)-time(a)||b.id.localeCompare(a.id);return fields.sort==='oldest'?-d:d;});
                const size=Math.max(1,Math.min(200,Number(fields.page_size)||25)),pages=Math.max(1,Math.ceil(rows.length/size)),page=Math.max(1,Math.min(pages,Number(fields.page)||1));
                return {jobs:structuredClone(rows.slice((page-1)*size,page*size)),worker_running:model.worker_running,counts:{active:jobs.filter(j=>group(j)==='active').length,needs_attention:jobs.filter(j=>group(j)==='needs_attention').length,completed:jobs.filter(j=>group(j)==='completed').length},pagination:{page,page_size:size,total:rows.length,pages,has_previous:page>1,has_next:page<pages}};
            }const active=jobs.filter(j=>['queued','running'].includes(j.state)),attention=jobs.filter(j=>!['queued','running','completed'].includes(j.state)),complete=jobs.filter(j=>j.state==='completed'),size=Math.max(1,Math.min(200,Number(fields.page_size)||25)),pages=Math.max(1,Math.ceil(complete.length/size)),page=Math.max(1,Math.min(pages,Number(fields.page)||1));return {jobs:structuredClone([...active,...attention,...complete.slice((page-1)*size,page*size)]),worker_running:model.worker_running,counts:{active:active.length,needs_attention:attention.length,completed:complete.length},pagination:{page,page_size:size,total:complete.length,pages,has_previous:page>1,has_next:page<pages}};}
            case 'auditlog':return {entries:calls.filter(c=>!['inventory','pooldiagnostics','conversionjobs','auditlog','getdatasetproperties','previewdestroy','previewrollback','snapshotfiles'].includes(c.cmd)).map((c,i)=>({operation_id:String(i).padStart(32,'0'),timestamp:new Date().toISOString(),command:c.cmd,phase:'outcome',status:'succeeded',fields:{zdataset:c.zdataset||'',pool:c.pool||''}}))};
            case 'validatesettings':{const errors={};if(fields.settings.exclusion==='[')errors.exclusion='Invalid PCRE pattern';if(/[@\/]/.test(fields.settings.snap_prefix||''))errors.snap_prefix='Invalid snapshot prefix';return {valid:!Object.keys(errors).length,errors,snapshot_preview:'cache/data@'+(fields.settings.snap_prefix||'')+'2026-10-16-170000'};}
            case 'getdatasetproperties':return structuredClone(find(fields.zdataset)||{_error:'Dataset not found'});
            case 'previewdestroy':{previews.set(token,{target,kind:'destroy'});return {target,preview_id:'b'.repeat(32),expires:now()+600,can_destroy:true,objects:[{name:target,guid:find(target)?.guid||findSnapshot(target)?.guid}],preview:'would destroy '+target+' and '+(find(target)?.snapshots.length||0)+' snapshots',token};}
            case 'previewrollback':previews.set(token,{target,kind:'rollback'});return {snapshot:fields.snapshot,destroy_newer:fields.destroy_newer==='1',can_rollback:true,newer_snapshots:[],newer_bookmarks:[],token};
            case 'createdataset':{const name='cache/'+fields.data.name;if(!name.startsWith(lab+'/'))return fail(name,'Mock lab confines mutations to synthetic datasets');insert(name);return success(name);}
            case 'editdatasetproperty':{const n=find(target);if(!n)return fail(target,'Missing dataset');n[fields.property]=fields.value;return success(target);}
            case 'renamedataset':{const n=find(target);if(!n||!fields.newname.startsWith(lab+'/'))return fail(target,'Invalid mock target');remove(target);n.name=fields.newname;n.mountpoint='/mnt/'+n.name;find(fields.newname.slice(0,fields.newname.lastIndexOf('/'))).child[n.name]=n;return success(n.name);}
            case 'destroydataset':if(previews.get(fields.preview_token)?.target!==target)return fail(target,'Preview target mismatch');remove(target);return success(target);
            case 'snapshotdataset':{const n=find(target);if(!n)return fail(target,'Missing dataset');n.snapshots.push(snapshot(target,'mock-created-'+sequence++));return success(target);}
            case 'renamesnapshot':{const s=findSnapshot(target);if(!s)return fail(target,'Missing snapshot');s.name=target.split('@')[0]+'@'+fields.newname;return success(s.name);}
            case 'holdsnapshot':case 'releasesnapshot':{const s=findSnapshot(target);if(!s)return fail(target,'Missing snapshot');s.userrefs=cmd==='holdsnapshot'?1:0;return success(target);}
            case 'clonesnapshot':if(!findSnapshot(target))return fail(target,'Missing snapshot');insert(fields.clone,{origin:target});return success(fields.clone);
            case 'rollbacksnapshot':if(previews.get(fields.preview_token)?.target!==target)return fail(target,'Preview target mismatch');return success(target);
            case 'destroysnapshot':{if(target===model.failedSnapshot)return fail(target,'cannot destroy snapshot: dataset is busy (simulated hold)');const n=find(target.split('@')[0]);n.snapshots=n.snapshots.filter(s=>s.name!==target);return success(target);}
            case 'lockdataset':case 'unlockdataset':{const n=find(target);if(!n)return fail(target,'Missing dataset');if(target.endsWith('/unlocked/child'))return fail(target,'Dataset is not an encryption root');n.keystatus=cmd==='lockdataset'?'unavailable':'available';return success(target);}
            case 'previewpromote':{const n=find(target);if(!n||n.origin==='-')return fail(target,'Dataset is not a clone');previews.set(token,{target,kind:'promote',guid:n.guid});return {preview_id:'c'.repeat(32),token,review:{kind:'promote',name:target,origin:n.origin,can_proceed:true,affected_snapshots:[],conflicts:[]}};}
            case 'promotedataset':{const preview=previews.get(fields.token),n=find(target);if(!n||preview?.kind!=='promote'||preview.target!==target||preview.guid!==n.guid||fields.preview_id!=='c'.repeat(32))return fail(target,'Fresh promotion review required');previews.delete(fields.token);n.origin='-';return success(target);}
            case 'adddirectortlisting':config.directory_listing=[...new Set([...config.directory_listing,target])];return success(target);
            case 'removedirectorylisting':config.directory_listing=config.directory_listing.filter(name=>name!==target);return success(target);
            case 'saveconfig':Object.assign(config,fields.settings);if(typeof config.directory_listing==='string')config.directory_listing=config.directory_listing.split('\n').filter(Boolean);return {...success('settings'),config:structuredClone(config)};
            case 'movedirectory':case 'deletedirectory':return success(target);
            case 'convertdirectory':return {...success(target),job:queue('conversion',{source:target,target:target.replace('/mnt/','')})};
            case 'cancelconversion':case 'cancelrestore':{const job=jobs.find(j=>j.id===target);if(!job)return fail(target,'Job missing');job.state='cancelled';return success(target);}
            case 'resumeconversion':{const job=jobs.find(j=>j.id===target);if(!job)return fail(target,'Job missing');job.state='queued';return {...success(target),job};}
            case 'scrubpool':model.diagnostic.scan={...model.diagnostic.scan,state:'running',kind:'scrub',percent:16.91,text:'scrub in progress since fixture time',issued:'68.4M',issue_total:'405M',issue_rate:'10.0M/s',eta:'00:00:04'};return success('cache','Simulated scrub request');
            case 'snapshotfiles':{let entries=[{name:'folder',path:'folder',type:'directory',size:0,mtime:model.fileMtime,available:true},{name:'notes.txt',path:'notes.txt',type:'file',size:2048,mtime:model.fileMtime,available:true},{name:'.hidden',path:'.hidden',type:'file',size:128,mtime:model.fileMtime,available:true},{name:'unsafe-link',path:'unsafe-link',type:'symlink',size:0,mtime:model.fileMtime,available:false}];if(fields.path==='folder')entries=[{name:'inside.txt',path:'folder/inside.txt',type:'file',size:1024,mtime:model.fileMtime,available:true}];if(model.largeDirectory||Number.isSafeInteger(model.fileCount))entries=Array.from({length:model.fileCount??205},(_,i)=>({name:'file-'+String(i).padStart(3,'0')+'.txt',path:'file-'+String(i).padStart(3,'0')+'.txt',type:'file',size:1024*(i+1),mtime:model.fileMtime-i,available:true}));if(fields.hidden!=='1')entries=entries.filter(e=>!e.name.startsWith('.'));if(fields.filter)entries=entries.filter(e=>e.name.includes(fields.filter));entries.sort((a,b)=>{const key=fields.sort||'name',direction=fields.direction==='desc'?-1:1;return direction*(key==='name'?a.name.localeCompare(b.name):(a[key]-b[key]));});if(fields.kind&&fields.kind!=='all')entries=entries.filter(e=>e.type===fields.kind);const total=entries.length;entries=entries.slice(Number(fields.offset)||0,(Number(fields.offset)||0)+200);return {snapshot:fields.snapshot,path:fields.path||'',snapshot_guid:model.snapshotGuid||findSnapshot(fields.snapshot)?.guid,entries,total,restore_available:model.restoreAvailable};}
            case 'snapshotfileinfo':return {ready:true,snapshot:fields.snapshot,path:fields.path,size:2048};
            case 'previewrestore':{const id='b'.repeat(32);previews.set(id,{target:fields.target,selection:fields.selection});return {id,token,files:1,bytes:2048,selection:fields.selection,target:'/mnt/'+lab+'/project/'+fields.target,conflicts:fields.mode==='overwrite'?['notes.txt']:[]};}
            case 'restoresnapshotfiles':if(!previews.has(fields.preview_id)||fields.preview_token!==token||fields.confirmed!=='1')return fail('restore','Invalid preview');return {...success('restore'),job:queue('restore',{snapshot:lab+'/project@base',target:previews.get(fields.preview_id).target})};
            case 'archivesnapshotfiles':return {...success('archive'),job:queue('archive',{snapshot:fields.snapshot,source:fields.snapshot,expires:now()+3600})};
            case 'downloadsnapshotfile':case 'downloadsnapshotarchive':return {download:true};
            default:throw Error('Unimplemented mock command: '+cmd);
        }
    }
    model.handle=fields=>{if(fields.csrf_token!=='fixture-token')throw Error('Invalid fixture CSRF');calls.push(structuredClone({...fields,passphrase:fields.passphrase?'[fixture redacted]':undefined,...(fields.data?{data:{...fields.data,passphrase:fields.data.passphrase?'[fixture redacted]':undefined}}:{})}));return endpoint(fields);};
    model.inventory=inventory;model.find=find;model.findSnapshot=findSnapshot;
    return model;
}
function decode(body){const out={};for(const [key,value]of new URLSearchParams(body)){const parts=key.replace(/\]/g,'').split('[');let item=out;for(const p of parts.slice(0,-1))item=item[p]??={};item[parts.at(-1)]=value;}function arrays(value){if(!value||typeof value!=='object')return value;const keys=Object.keys(value);if(keys.length&&keys.every(key=>/^\d+$/.test(key)))return keys.map(key=>arrays(value[key]));return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,arrays(item)]));}return arrays(out);}
export async function startMock({port=0}={}){
    let model=createModel();
    const server=http.createServer(async(req,res)=>{
        res.setHeader('Cache-Control','no-store');
        try{
            if(req.method==='POST'&&req.url==='/mock/admin'){
                let body='';for await(const part of req)body+=part;const answer=model.handle(decode(body));
                if(answer.download){res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="SIMULATED.txt"'});res.end('SIMULATED DOWNLOAD: no server file content');}
                else {res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(answer));}return;
            }
            if(req.url.startsWith('/src/frontend/')){const path=resolve(repo,'.'+req.url);if(!path.startsWith(repo+'/src/frontend/'))throw Error('Invalid asset');res.setHeader('Content-Type',extname(path)==='.css'?'text/css':'text/javascript');res.end(await readFile(path));return;}
            if(req.url==='/'||req.url.startsWith('/?')){res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZFS Director local GUI analysis</title><link rel="stylesheet" href="/src/frontend/ZFSMWorkspace.css"><style>body{margin:14px;background:#1b1b1b;color:#eee;font:14px system-ui}#lab-note{color:#ffd28a;margin-bottom:12px}</style></head><body><aside id="lab-note">SYNTHETIC DEMO · generated inventory, identifiers and file contents · no server connection</aside><main id="zfsm-workspace"></main>${['ZFSMDateTime','ZFSMInventory','ZFSMForms','ZFSMSnapshots','ZFSMExplorer','ZFSMPoolView','ZFSMOverview','ZFSMHistory','ZFSMWorkspace'].map(name=>'<script src="/src/frontend/'+name+'.js"></script>').join('')}<script>var zfsmDateTimeSettings={timeZone:'UTC',dateFormat:'%d-%m-%Y',timeFormat:'%T'};var zfsm_workspace=zfsmCreateWorkspace({root:document.getElementById('zfsm-workspace'),url:'/mock/admin',csrf:'fixture-token',hostTheme:'black',config:${JSON.stringify(model.config)}});window.addEventListener('pagehide',()=>zfsm_workspace.stop());</script></body></html>`);return;}
            res.writeHead(404);res.end('Not found');
        }catch(error){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({failed:{request:error.message}}));}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
    return {url:'http://127.0.0.1:'+server.address().port,get model(){return model;},reset(){model=createModel();},close:()=>new Promise(resolve=>server.close(resolve))};
}
