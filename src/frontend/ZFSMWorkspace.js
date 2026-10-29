/* Branding renamed to ZFS Director on 2026-10-16; GPL-2.0-or-later. */
/* Embedded ZFS workspace. All administrative work stays in this document. */
function zfsmCreateWorkspace(options) {
    'use strict';
    const root=options.root;
    if(!root)throw new Error('ZFS workspace root is missing');
    const preferenceKey='zfsm-workspace-preferences-v1',cacheKey='zfsm-workspace-inventory-v1';
    const controllers=new Set();
    const inventoryJobs=new Set();
    let stopped=false,config=Object.assign({},options.config),data=null,lastInventory=null,inventoryFresh=false,lastSuccessfulRefresh='',section='datasets',tab='overview',pool='',selection='';
    let layout='tree',theme='auto',viewGeneration=0,activeForm=null,snapshotHost=null,detailBody=null,browserHost=null,detailHeading=null;
    let jobsPage=1,jobsPageSize=10,jobsFilter='all',jobsSort='newest',jobsView='working',jobsClear=null,jobsVisibilityBusy=false,jobsStorageOpen=false;const jobsExpanded=new Set(),jobsDiagnosticsExpanded=new Set();let jobs={jobs:[],worker_running:false},jobsError='',jobsBusy=false,jobsPending=false,jobsScope='',jobsTimer=null,jobsHost=null;
    let diagnosticBusy=false,diagnosticPending=false,inventoryError='',datasetTab='overview',showRecoveryFiles=false,explorer=null,explorerDialog=null,actionDialog=null;
    let selectionChanged=false,selectionIdentity='';let diagnosticTimer=null,scrubReview='',browserQuery='',browserFilter='all',browserPage=1;
    const scrubBusy=new Set();
    const poolTabs=new Set(['status','information','devices']);
    const diagnostics=new Map(),collapsed=new Set();
    function node(tag,text,cls){const item=document.createElement(tag);if(text!==undefined)item.textContent=String(text);if(cls)item.className=cls;return item;}
    function button(text,handler,attrs){const item=node('button',text);item.type='button';item.addEventListener('click',handler);for(const [key,value] of Object.entries(attrs||{}))item.setAttribute(key,String(value));return item;}
    function navigationIcon(kind){
        const drawings={settings:'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',actions:'M13 2 5 14h6l-1 8 9-13h-6Z',jobs:'M5 3h14v18H5Z M8 7h2 M12 7h4 M8 12h2 M12 12h4 M8 17h2 M12 17h4',replication:'M3 5h7v6H3Z M14 13h7v6h-7Z M14 5h6v5 M17 7l3-2-2-2 M4 14v5h6 M7 17l3 2-2 2'};
        const icon=zfsmCreateIcon(({overview:'space',datasets:'dataset',protection:'snapshot',details:'details',properties:'code',snapshots:'snapshot',files:'folder',status:'shield',information:'space',devices:'volume'})[kind]||'file');
        if(drawings[kind]){icon.querySelector('path').setAttribute('d',drawings[kind]);icon.dataset.icon=kind;}icon.classList.add('zfsm-nav-icon');return icon;
    }
    function bytes(value){if(value===null||value===undefined||value==='')return '—';const n=Number(value);if(!Number.isFinite(n)||n<0)return String(value);const units=['B','KiB','MiB','GiB','TiB','PiB','EiB'],power=n>0?Math.min(Math.floor(Math.log(n)/Math.log(1024)),units.length-1):0;return (n/1024**power).toLocaleString(undefined,{maximumFractionDigits:2})+' '+units[power];}
    function date(value){return zfsmFormatDateTime(value);}
    function storageRead(key){try{return JSON.parse(localStorage.getItem(key)||'null');}catch(_){return null;}}
    function storageWrite(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch(_){/* Browser storage is optional. */}}
    const saved=storageRead(preferenceKey);
    if(saved&&typeof saved==='object'){
        if(['tree','table'].includes(saved.layout))layout=saved.layout;
        if(['auto','light','dark','gray','azure'].includes(saved.theme))theme=saved.theme;
        if([10,25,50,100].includes(saved.jobsPageSize))jobsPageSize=saved.jobsPageSize;
        if(typeof saved.pool==='string')pool=saved.pool;
        if(typeof saved.selection==='string')selection=saved.selection;
        if(Array.isArray(saved.collapsed))saved.collapsed.filter(value=>typeof value==='string').slice(0,1000).forEach(value=>collapsed.add(value));
    }
    function savePreferences(){storageWrite(preferenceKey,{layout,theme,pool,selection,jobsPageSize,collapsed:[...collapsed]});}
    function setStatus(message,error){status.textContent=message;status.setAttribute('role',error?'alert':'status');status.dataset.error=String(Boolean(error));status.hidden=section!=='datasets'&&!error;}
    function inventoryJob(job){return typeof job?.id==='string'&&['conversion','deletion','restore','policy','replication'].includes(job.type);}
    function queuedAnswer(answer){if(!stopped&&inventoryJob(answer?.job))inventoryJobs.add(answer.job.id);return answer;}
    async function request(fields){
        if(stopped)throw new Error('Workspace is closed');
        if(typeof options.request==='function')return queuedAnswer(await options.request(fields));
        const body=new URLSearchParams();
        function append(key,value){if(value&&typeof value==='object'){for(const [child,item] of Object.entries(value))append(key+'['+child+']',item);}else body.append(key,value===null||value===undefined?'':String(value));}
        append('csrf_token',options.csrf||'');for(const [key,value] of Object.entries(fields))append(key,value);
        const controller=new AbortController();controllers.add(controller);
        const timeout=setTimeout(()=>controller.abort(),fields.cmd.startsWith('protection')?130000:['snapshotfiles','previewrestore','restoresnapshotfiles','snapshotfileinfo','previewdestroy','previewrollback'].includes(fields.cmd)?130000:['inventory','inventorysnapshots','pooldiagnostics'].includes(fields.cmd)?60000:fields.cmd==='scrubpool'?30000:15000);
        try{
            const response=await fetch(options.url,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','X-CSRF-Token':options.csrf||''},body,signal:controller.signal});
            if(!response.ok)throw new Error('HTTP '+response.status);
            const answer=await response.json();if(!answer||typeof answer!=='object'||Array.isArray(answer))throw new Error('Invalid server response');return queuedAnswer(answer);
        }catch(error){throw new Error(error.name==='AbortError'?'Request timed out. Inspect actual state before retrying.':error.message);}
        finally{clearTimeout(timeout);controllers.delete(controller);}
    }
    function systemTheme(){
        if(document.documentElement.classList.contains('dark')||document.body.classList.contains('dark'))return 'dark';
        if(document.documentElement.classList.contains('light')||document.body.classList.contains('light'))return 'light';
        const rgb=getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g);
        if(rgb&&rgb.length>=3&&(rgb.length<4||Number(rgb[3])>0)){const values=rgb.slice(0,3).map(Number);return (.2126*values[0]+.7152*values[1]+.0722*values[2])<128?'dark':'light';}
        return window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
    }
    function applyTheme(){let palette=theme==='auto'?options.hostTheme:({light:'white',dark:'black'}[theme]||theme);if(!['black','white','gray','azure'].includes(palette))palette=systemTheme()==='dark'?'black':'white';root.dataset.palette=palette;root.dataset.theme=['black','gray'].includes(palette)||(palette==='azure'&&theme!=='auto')?'dark':'light';root.dataset.followHost=String(theme==='auto'&&Boolean(options.hostTheme));root.dataset.layout=layout;themeSelect.value=theme;for(const item of layoutButtons)item.setAttribute('aria-pressed',String(item.dataset.layoutChoice===layout));}
    root.replaceChildren();
    const shell=node('div',undefined,'zfsm-shell'),sidebar=node('aside',undefined,'zfsm-sidebar'),workspace=node('div',undefined,'zfsm-main');
    const heading=node('div',undefined,'zfsm-brand'),brand=node('strong','ZFS Director');heading.append(zfsmCreateIcon('director'));const brandText=node('div');brandText.append(brand,node('small','for Unraid'));heading.append(brandText);sidebar.append(heading);
    const header=node('header',undefined,'zfsm-header'),breadcrumb=node('div',undefined,'zfsm-breadcrumb');breadcrumb.append(node('span','Storage'),node('span','›'));const screenTitle=node('strong','Datasets');breadcrumb.append(screenTitle);
    const controls=node('div',undefined,'zfsm-controls'),layoutButtons=[],density=node('div',undefined,'zfsm-view-switch');density.setAttribute('aria-label','View mode');
    const protectionSection=()=>['protection','replication','protection-settings'].includes(section);
    for(const [value,label] of [['tree','Workspace'],['table','Compact']]){const item=button(label,()=>{layout=value;applyTheme();savePreferences();if(protectionSection()||section==='settings'){protection?.refresh();return;}if(section==='datasets')renderBrowser();},{'data-layout-choice':value,title:'Show '+label+' view'});layoutButtons.push(item);density.append(item);}controls.append(density);
    const themeSelect=node('select');themeSelect.setAttribute('aria-label','Theme');for(const [value,label] of [['auto','Unraid (auto)'],['dark','Black'],['gray','Gray'],['light','White'],['azure','Azure']]){const item=node('option',label);item.value=value;themeSelect.append(item);}themeSelect.addEventListener('change',()=>{theme=themeSelect.value;applyTheme();savePreferences();});controls.append(themeSelect);
    const refreshButton=button('',()=>protectionSection()&&protection?protection.refresh():section==='jobs'?loadJobs():section==='settings'?protection?.refresh():inventory.refresh(),{'aria-label':'Refresh',title:'Refresh',class:'zfsm-refresh-button'}),refreshIcon=zfsmCreateIcon('refresh');refreshIcon.classList.add('zfsm-refresh-icon');refreshButton.append(refreshIcon);controls.append(refreshButton);header.append(breadcrumb,controls);
    const nav=node('nav',undefined,'zfsm-global-nav');nav.setAttribute('aria-label','Plugin sections');const sectionButtons=new Map();
    for(const [key,label] of [['overview','Overview'],['datasets','Datasets'],['protection','Snapshot Policies'],['replication','Replication'],['jobs','Jobs'],['settings','Settings']]){const item=button('',()=>navigate(key),{'data-section':key});item.append(navigationIcon(key),node('span',label,'zfsm-nav-label'));sectionButtons.set(key,item);nav.append(item);}
    sidebar.append(nav);const sidebarNote=node('p','ZFS Director · local management','zfsm-sidebar-note');sidebar.append(sidebarNote);
    const datasetTools=node('div',undefined,'zfsm-dataset-tools'),poolToolsButton=button('Pool & Scrub',()=>{if(!pool)return;selection=pool;selectionChanged=false;selectionIdentity=selectionFingerprint();section='datasets';tab='status';savePreferences();renderSection();},{title:'View pool health, scrub progress and maintenance'});poolToolsButton.prepend(zfsmCreateIcon('pool'));poolToolsButton.disabled=true;
    const createButton=button('Create Dataset',()=>{if(pool)openActionForm('createdataset',selected()?context(selected()):{pool});},{'data-section':'create',class:'zfsm-primary'});sectionButtons.set('create',createButton);datasetTools.append(poolToolsButton,createButton);
    const status=node('div','Loading workspace…','zfsm-refresh-status');status.setAttribute('role','status');
    const cleanupNotice=node('section',undefined,'zfsm-notice');cleanupNotice.hidden=true;cleanupNotice.setAttribute('role','status');
    const poolHost=node('nav',undefined,'zfsm-pools');poolHost.setAttribute('aria-label','Pools');const content=node('div',undefined,'zfsm-content'),body=node('div',undefined,'zfsm-main-body');body.append(status,cleanupNotice,datasetTools,poolHost,content);workspace.append(header,body);shell.append(sidebar,workspace);root.append(shell);applyTheme();
    const forms=zfsmCreateInlineForms({request,getConfig:()=>config,getDataset:name=>flatten(name.split('/')[0],false).find(row=>row.name===name)?.node,getDatasets:name=>flatten(name,false).filter(item=>item.kind==='dataset').map(item=>item.name),getOperationIssue:snapshotOperationIssue,getMutationFields:mutationFields,onComplete:operationComplete,onClose:()=>closeActionForm(),onViewJob:id=>{jobsExpanded.delete(id);jobsPage=1;jobsFilter='all';jobsSort='newest';jobsView='working';navigate('jobs');}});
    const protectionHost=node('div',undefined,'zfsm-protection'),protectionButton=sectionButtons.get('protection'),replicationButton=sectionButtons.get('replication');protectionButton.hidden=true;replicationButton.hidden=true;
    const protection=typeof zfsmCreateProtection==='function'?zfsmCreateProtection({root:protectionHost,request,getLayout:()=>layout,embeddedNavigation:true,getDatasets:()=>Object.keys(data?.datasets||{}).flatMap(name=>flatten(name,false).filter(item=>item.kind==='dataset').map(item=>item.name)),onAvailability:(visible,detection)=>{const ready=Boolean(visible&&detection?.visible&&detection?.compatible);protectionButton.hidden=!ready;replicationButton.hidden=!ready;if(typeof detection?.enabled==='boolean'){config.sanoid_integration=detection.enabled?1:0;if(activeForm?.action==='saveconfig')forms.render(activeForm.host,activeForm.action,activeForm.context);}},onNavigate:next=>navigate(next==='settings'?'settings':next==='replication'?'replication':next==='jobs'?'jobs':'protection'),onJobs:()=>navigate('jobs'),onHistory:()=>navigate('history')}):null;
    const media=window.matchMedia('(prefers-color-scheme: dark)');const themeListener=()=>{if(theme==='auto')applyTheme();};media.addEventListener('change',themeListener);
    const themeObserver=new MutationObserver(themeListener);themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['class','data-theme','style']});themeObserver.observe(document.body,{attributes:true,attributeFilter:['class','data-theme','style']});
    function flatten(name,visible){
        const rows=[];
        function walk(item,depth){if(!item||typeof item.name!=='string'||depth>128)return;rows.push({kind:'dataset',name:item.name,node:item,depth});if(visible&&collapsed.has(item.name))return;for(const child of Object.values(item.child||{}))walk(child,depth+1);for(const directory of Array.isArray(item.directories)?item.directories:[])if(typeof directory==='string')rows.push({kind:'directory',name:directory,node:item,depth:depth+1});}
        if(data&&data.datasets)walk(data.datasets[name],0);return rows;
    }
    function selected(){return flatten(pool,false).find(item=>item.name===selection)||null;}
    function servicePath(name){return String(name).split('/').some(part=>part==='.zfsm-maintenance'||/^\.zfsm-(mutation|archive|restore)-/.test(part));}
    function compatibleTab(item,key){if(!item||item.kind==='directory'&&['details','properties','snapshots','files'].includes(key)||key==='files'&&item.node.type==='volume')return item?.kind==='directory'?'actions':'overview';return key;}
    function chooseTab(key){tab=key;if(!poolTabs.has(key)&&selected()?.kind==='dataset')datasetTab=key;renderTab();}
    function recoveryFiles(show){showRecoveryFiles=show;const item=selected();if(!show&&item?.kind==='directory'&&servicePath(item.name)){selection=item.node.name;selectionChanged=false;selectionIdentity=selectionFingerprint();}if(show){browserQuery='';browserFilter='all';browserPage=1;for(const row of flatten(pool,false).filter(row=>row.kind==='directory'&&servicePath(row.name))){let name=row.node.name;while(name){collapsed.delete(name);name=name.includes('/')?name.slice(0,name.lastIndexOf('/')):'';}}}section='datasets';tab=compatibleTab(selected(),datasetTab);savePreferences();renderSection();}
    function selectionFingerprint(item=selected()){return item?JSON.stringify([item.name,item.kind,String(item.node.guid||''),item.kind==='directory'?item.node._directory_identities?.[item.name]||null:null]):'';}
    const snapshotCommands=new Set(['renamesnapshot','holdsnapshot','releasesnapshot','clonesnapshot','rollbacksnapshot','destroysnapshot']);
    function subtreeSnapshots(tree){const rows=[...(tree.snapshots||[])];for(const child of Object.values(tree.child||{}))rows.push(...subtreeSnapshots(child));return rows;}
    const objectCommands=new Set(['createdataset','renamedataset','editdatasetproperty','setquota','editacl','snapshotdataset','destroydataset','lockdataset','unlockdataset','promotedataset','adddirectortlisting','removedirectorylisting','movedirectory','deletedirectory','cleanupmutation','convertdirectory',...snapshotCommands]);
    function snapshotOperationIssue(action,ctx,targets=[]){
        if(['cancelconversion','resumeconversion','publishconversion','cancelrestore'].includes(action)){const job=jobs.jobs.find(j=>j.id===ctx.job?.id);if(jobsError||!job)return 'Job inventory is unavailable or stale. Refresh successfully before controlling this job.';const key=action==='resumeconversion'?'resume':action==='publishconversion'?'publish':'cancel';if(job.actions&&job.actions[key]!==true)return 'This job requires manual inspection; the requested action is not supported.';if(ctx.job.state!==job.state||ctx.job.stage!==job.stage)return 'Job state changed; reopen its controls and review the current stage.';return '';}
        if(!objectCommands.has(action))return '';
        if(selectionChanged)return 'Selected object identity changed. Select the current object again or review it before making changes.';
        if(!inventoryFresh)return 'Stale data — last successful refresh '+(lastSuccessfulRefresh||'unknown')+'. Refresh successfully before changing objects.';
        const name=ctx.dataset||ctx.pool,item=flatten(ctx.pool||pool,false).find(row=>row.kind==='dataset'&&row.name===name);
        if(!item)return 'The selected object is missing. Refresh and select it again.';
        if((data.errors||{})[ctx.pool||pool]||item.node._error)return 'Object inventory contains errors. Refresh successfully before changing objects.';
        if(!/^[1-9][0-9]*$/.test(String(item.node.guid||'')))return 'Object identity is unknown. Refresh inventory before changing objects.';
        if(ctx.node?.guid&&String(ctx.node.guid)!==String(item.node.guid))return 'Object identity changed. Close this form and review the current object.';
        if(ctx.directory){const identity=item.node._directory_identities?.[ctx.directory];if(!identity||JSON.stringify(identity)!==JSON.stringify(ctx.directory_identity))return 'Directory identity changed or is unknown. Refresh before acting.';}
        if(snapshotCommands.has(action)){
            if(!snapshotsLoaded(item.node)||snapshotError(item.node))return 'Snapshot inventory is unavailable or stale. Refresh successfully before acting on these snapshots.';
            const snapshots=new Map(subtreeSnapshots(item.node).map(snapshot=>[snapshot.name,snapshot]));
            for(const target of targets){const current=snapshots.get(target),original=ctx.snapshot_identities?.[target]||ctx.node?.snapshots?.find(s=>s.name===target)?.guid;if(!current)return 'A selected snapshot no longer exists in current inventory. Review the target or deselect the missing snapshot before submitting.';if(!current.guid||String(current.guid)!==String(original))return 'Snapshot identity changed or is unknown. Reopen the operation.';}
        }
        return '';
    }
    function context(item){
        const rows=flatten(pool,false).filter(row=>row.kind==='dataset');
        return {pool,dataset:item.node.name,type:item.node.type||'filesystem',node:item.node,identity_map:Object.fromEntries(rows.map(row=>[row.name,String(row.node.guid||'')])),snapshot_identities:Object.fromEntries((item.node.snapshots||[]).map(s=>[s.name,String(s.guid||'')])),...(item.kind==='directory'?{directory:item.name,directory_identity:item.node._directory_identities?.[item.name]}:{})};
    }
    function mutationFields(action,ctx,fields){
        const result={};
        if(objectCommands.has(action)){result.expected_guid=String(ctx.node?.guid||'');if(ctx.directory)result.directory_identity=ctx.directory_identity;}
        if(snapshotCommands.has(action))result.snapshot_guid=ctx.snapshot_identities?.[fields.snapshot]||ctx.node?.snapshots?.find(s=>s.name===fields.snapshot)?.guid||'';
        let target=action==='createdataset'?ctx.pool+'/'+String(fields.data?.name||'').replace(/^\/+|\/+$/g,''):action==='clonesnapshot'?fields.clone:action==='renamedataset'?fields.newname:'';
        if(target){const parent=Object.keys(ctx.identity_map||{}).filter(name=>target.startsWith(name+'/')).sort((a,b)=>b.length-a.length)[0];result.parent_name=parent||'';result.parent_guid=ctx.identity_map?.[parent]||'';}
        return result;
    }
    function severityFor(name){const diagnostic=diagnostics.get(name),native=data&&data.pools[name]&&data.pools[name].Health||'UNKNOWN';if(native!=='ONLINE'&&native!=='UNKNOWN')return 'error';return diagnostic&&['ok','warning','error','unknown'].includes(diagnostic.severity)?diagnostic.severity:'unknown';}
    function knownDiagnosticError(diagnostic){
        if(!diagnostic)return false;
        const status=diagnostic.status||{},information=diagnostic.information||{};
        const badState=value=>value&&!['ONLINE','UNKNOWN','-'].includes(value);
        if(badState(diagnostic.health)||badState(status.state))return true;
        if((status.rows||[]).some(row=>['read','write','cksum'].some(key=>parseFloat(row[key])>0)||(row.section!=='spares'&&badState(row.state))))return true;
        if((information.rows||[]).some(row=>row.section!=='spares'&&badState(row.health)))return true;
        return /Permanent errors|\b[1-9][0-9]*\s+(?:data\s+)?errors?\b/i.test(status.errors||'')||/\b[1-9][0-9]*\s+errors?\b/i.test(status.scan||'');
    }
    function renderPools(){
        const focused=document.activeElement&&document.activeElement.dataset.pool;poolHost.replaceChildren();
        for(const [name,info] of Object.entries(data&&data.pools||{})){
            const severity=severityFor(name),item=button('',()=>{pool=name;selection=name;selectionChanged=false;selectionIdentity=selectionFingerprint();section='datasets';tab='overview';savePreferences();renderSection();renderPools();},{'data-pool':name,'data-severity':severity,'aria-pressed':name===pool});
            const diagnostic=diagnostics.get(name),native=diagnostic&&diagnostic.health!=='UNKNOWN'?diagnostic.health:info.Health;
            const label={ok:'Healthy',warning:'Warning',error:'Error',unknown:'Not checked'}[severity],health=node('span',(native||'UNKNOWN')+' · '+label+(diagnostic&&diagnostic.stale?' · stale':''),'zfsm-pool-health'),dot=node('span',undefined,'zfsm-status-dot');dot.dataset.severity=severity;dot.setAttribute('aria-hidden','true');health.prepend(dot);item.className='zfsm-pool-button';item.append(node('span',name,'zfsm-pool-name'),health,node('span',bytes(info.Used)+' / '+bytes(info.Size),'zfsm-muted'));poolHost.append(item);
        }
        if(focused){const target=[...poolHost.children].find(item=>item.dataset.pool===focused);if(target)target.focus({preventScroll:true});}
        sectionButtons.get('create').disabled=!pool||!inventoryFresh;
        poolToolsButton.disabled=!pool;
    }
    function invalidateForm(){forms.dispose();activeForm=null;if(actionDialog){const dialog=actionDialog;actionDialog=null;if(dialog.open)dialog.close();dialog.remove();}}
    function disposeSnapshots(){if(snapshotHost)zfsmDisposeSnapshots(snapshotHost);}
    function disposeExplorer(){if(explorer){explorer.dispose();explorer=null;}if(explorerDialog){explorerDialog.remove();explorerDialog=null;}}
    function navigate(next){if(next==='datasets'){recoveryFiles(false);return;}section=next;renderSection();}
    function updateNavigation(){const poolView=section==='datasets'&&poolTabs.has(tab);for(const [key,item]of sectionButtons){item.setAttribute('aria-pressed',String(section===key));item.setAttribute('aria-current',section===key?'page':'false');}poolToolsButton.setAttribute('aria-pressed',String(poolView));const datasetView=section==='datasets';datasetTools.hidden=!datasetView;poolHost.hidden=!datasetView;status.hidden=!datasetView&&status.dataset.error!=='true';screenTitle.textContent=({overview:'Overview',datasets:'Datasets',protection:'Snapshot Policies',replication:'Replication',jobs:'Jobs',history:'Administrative History',settings:'Settings','protection-settings':'Settings',create:'Create Dataset'})[section]||'Datasets';}
    function renderSection(){
        protection?.leave();
        clearTimeout(diagnosticTimer);scrubReview='';
        invalidateForm();disposeSnapshots();disposeExplorer();viewGeneration++;snapshotHost=null;detailBody=null;browserHost=null;jobsHost=null;content.replaceChildren();
        updateNavigation();
        if(section==='datasets'){
            if(!data){content.append(node('p','Click Refresh to load ZFS pools and datasets.','zfsm-notice'));return;}
            if(!Object.keys(data.pools).length){content.append(node('p','No imported ZFS pools.','zfsm-notice'));return;}
            if(!showRecoveryFiles&&selected()?.kind==='directory'&&servicePath(selection)){selection=selected().node.name;selectionIdentity=selectionFingerprint();}
            const area=node('div',undefined,'zfsm-workarea');browserHost=node('div',undefined,'zfsm-browser');const detail=node('section',undefined,'zfsm-detail');detailHeading=node('div',undefined,'zfsm-detail-heading');const tabs=node('nav',undefined,'zfsm-tabs');tabs.setAttribute('aria-label','Workspace tabs');
            const item=selected();if(!poolTabs.has(tab))tab=compatibleTab(item,tab);
            for(const [key,label] of [['overview','Overview'],['details','Dataset information'],['properties','Properties'],['snapshots','Snapshots'],['files','File Manager'],['actions','Actions']]){const control=button(label,()=>chooseTab(key),{'data-tab':key});control.prepend(navigationIcon(key));control.disabled=Boolean(item&&compatibleTab(item,key)!==key);if(key==='files'&&control.disabled)control.title='Choose a filesystem dataset, then a snapshot to browse.';tabs.append(control);}
            detailBody=node('div');detail.append(detailHeading,detailBody);area.append(browserHost,detail);content.append(tabs,area);renderBrowser();renderTab();return;
        }
        const surface=node('section',undefined,'zfsm-section');content.append(surface);
        if(protectionSection()&&protection){surface.append(protectionHost);protection.render(section==='protection-settings'?'settings':section==='replication'?'replication':'policies');}
        else if(section==='overview'){renderDashboard(surface);}
        else if(section==='jobs'){const head=pageHeading(surface,'Jobs','Background operations, verified results and recovery.'),history=button('Administrative History',()=>navigate('history'),{'data-open-history':'', 'data-section':'history'}),recovery=button('Show recovery files',()=>recoveryFiles(true));head.append(recovery,history);jobsHost=node('div');surface.append(jobsHost);renderJobs();loadJobs();}
        else if(section==='history'){surface.append(node('h2','Administrative History'));loadHistory(surface,viewGeneration);}
        else if(section==='settings'){pageHeading(surface,'Settings','Plugin preferences and Sanoid / Syncoid integration.');const general=node('details',undefined,'zfsm-general-settings'),summary=node('summary','General settings');general.append(summary);const settingsHost=node('div');general.append(settingsHost);surface.append(general);general.addEventListener('toggle',()=>{if(general.open&&!settingsHost.hasChildNodes())openForm(settingsHost,'saveconfig',{});});if(protection){surface.append(protectionHost);protection.render('settings');}}
        else if(section==='create'){if(!pool)surface.append(node('p','Select an imported pool first.','zfsm-notice'));else openForm(surface,'createdataset',selected()?context(selected()):{pool});}
    }
    function pageHeading(host,title,subtitle){const head=node('header',undefined,'zfsm-pagehead'),text=node('div');text.append(node('h2',title),node('p',subtitle,'zfsm-muted'));head.append(text);host.append(head);return head;}
    function backgroundTaskStatus(){
        if(jobsError||!jobsScope||typeof jobs.worker_running!=='boolean')return 'Status unavailable';
        if(!jobs.worker_running){const requests=jobs.jobs.filter(job=>job.execution_active&&['queued','running'].includes(job.state)).length,native=jobs.jobs.filter(job=>job.schema===7&&job.command==='scrubpool'&&job.state==='running'&&Number(job.observed_at)>Date.now()/1000-45).length;return requests?requests+' '+(requests===1?'operation':'operations')+' running · Background worker stopped':native?native+' native '+(native===1?'operation':'operations')+' observed · Background worker stopped':'Stopped';}
        const active=jobs.counts?.active;
        if(!Number.isSafeInteger(active)||active<0)return 'Ready · Activity unavailable';
        return active===0?'Ready · No active jobs':active+' '+(active===1?'job':'jobs')+' queued or running';
    }
    function overviewPoolHealth(name){
        const diagnostic=diagnostics.get(name),reported=severityFor(name),severity=diagnostic?.stale&&reported!=='error'?'unknown':reported;
        const label={ok:'Healthy',warning:'Warning',error:'Error',unknown:'Not checked'}[severity],badge=node('span',undefined,'zfsm-overview-health zfsm-pool-health');
        badge.dataset.poolHealth=name;badge.dataset.severity=severity;badge.setAttribute('role','status');badge.setAttribute('aria-label',name+' · '+label+(diagnostic?.stale?' · stale':''));
        const icon=node('span',{ok:'✓',warning:'⚠',error:'✕',unknown:'?'}[severity],'zfsm-health-icon');icon.setAttribute('aria-hidden','true');badge.append(icon,node('span',label+(diagnostic?.stale?' · stale':'')));
        badge.title=(diagnostic?.reasons||[]).join(' · ')||({ok:'Verified ZFS pool diagnostics.',unknown:'Pool diagnostics are not currently verified.'}[severity]||'Review Pool & Scrub diagnostics.');return badge;
    }
    function renderDashboard(host){
        const head=pageHeading(host,'Overview','Pools, datasets and background operations.'),open=button('Open datasets',()=>navigate('datasets'),{class:'zfsm-primary'});head.append(open);
        const metrics=node('div',undefined,'zfsm-dashboard-metrics'),datasetCount=data?Object.keys(data.datasets||{}).reduce((n,name)=>n+flatten(name,false).filter(row=>row.kind==='dataset').length,0):'Unknown';
        for(const [label,value]of [['Imported pools',data?Object.keys(data.pools||{}).length:'Unknown'],['Datasets',datasetCount],['Background tasks',backgroundTaskStatus()]]){const metric=node('section',undefined,'zfsm-dashboard-metric');metric.append(node('span',label),node('strong',value));if(label==='Background tasks')metric.append(node('small','Prepares ZIP downloads, restores files and converts directories.','zfsm-muted'));metrics.append(metric);}host.append(metrics);
        const list=node('section',undefined,'zfsm-dashboard-pools');list.append(node('h3','Storage pools'));if(!data)list.append(node('p','No current inventory. Refresh to inspect actual ZFS state.','zfsm-muted'));else for(const [name,p]of Object.entries(data.pools||{})){const row=node('div',undefined,'zfsm-dashboard-pool');row.append(button(name,()=>{pool=name;selection=name;selectionIdentity=selectionFingerprint();navigate('datasets');}),overviewPoolHealth(name),node('span',p.Health||'UNKNOWN'),node('span',bytes(p.Used)+' / '+bytes(p.Size)));list.append(row);}host.append(list);if(data&&!inventoryFresh)host.append(node('p','Inventory is stale. Refresh before relying on these values.','zfsm-notice'));
    }
    function renderBrowser(){
        if(!browserHost)return;
        const focusedNode=document.activeElement?.dataset.node,focused=document.activeElement?.getAttribute('aria-label'),caret=document.activeElement?.selectionStart,scroll=browserHost.scrollTop;browserHost.replaceChildren();
        if(showRecoveryFiles){const notice=node('section',undefined,'zfsm-notice');notice.dataset.recoveryFiles='';notice.append(node('strong','Recovery files'),node('p','Service directories may contain operation journals or saved originals. Deleted files are not saved by a deletion journal. Cleanup is available only after a completed journal passes a fresh safety review.'),button('Hide recovery files',()=>recoveryFiles(false)));browserHost.append(notice);}
        const tools=node('div',undefined,'zfsm-browser-tools'),search=node('input'),filter=node('select');search.type='search';search.placeholder='Search datasets…';search.setAttribute('aria-label','Search datasets');search.value=browserQuery;
        filter.setAttribute('aria-label','Filter datasets');for(const [value,label]of [['all','All objects'],['filesystem','Filesystems'],['volume','Zvols'],['encrypted','Encrypted'],['locked','Locked'],['no-direct','No direct snapshots'],['no-tree','No snapshots incl. descendants'],['attention','Needs attention']]){const option=node('option',label);option.value=value;filter.append(option);}filter.value=browserFilter;
        search.addEventListener('input',()=>{browserQuery=search.value;browserPage=1;renderBrowser();});filter.addEventListener('change',()=>{browserFilter=filter.value;browserPage=1;renderBrowser();});const clear=button('Clear search',()=>{browserQuery='';browserFilter='all';browserPage=1;renderBrowser();});clear.disabled=!browserQuery&&browserFilter==='all';tools.append(search,filter,clear);browserHost.append(tools);
        const query=browserQuery.trim().toLocaleLowerCase(),allRows=flatten(pool,false).filter(row=>row.kind!=='directory'||showRecoveryFiles||!servicePath(row.name));
        function snapshotTotal(n){return (n.snapshots||[]).length+Object.values(n.child||{}).reduce((sum,c)=>sum+snapshotTotal(c),0);}
        function matches(row){if(query&&!row.name.toLocaleLowerCase().includes(query))return false;const n=row.node;if(browserFilter==='all')return true;if(row.kind!=='dataset')return false;if(['filesystem','volume'].includes(browserFilter))return n.type===browserFilter;if(browserFilter==='encrypted')return n.encryption&&n.encryption!=='off';if(browserFilter==='locked')return n.keystatus==='unavailable';if(browserFilter==='no-direct')return snapshotsLoaded(n)&&!(n.snapshots||[]).length;if(browserFilter==='no-tree')return snapshotsLoaded(n)&&snapshotTotal(n)===0;return Boolean(n._error||n._snapshot_error||n.keystatus==='unavailable');}
        const filtering=Boolean(query)||browserFilter!=='all',matchesRows=allRows.filter(matches),visible=new Set(matchesRows.map(r=>r.name));
        if(filtering)for(const row of matchesRows){let name=row.name;while(name.includes('/')){name=name.slice(0,name.lastIndexOf('/'));visible.add(name);}}
        const candidates=filtering?allRows.filter(r=>visible.has(r.name)):flatten(pool,true).filter(row=>row.kind!=='directory'||showRecoveryFiles||!servicePath(row.name)),pages=Math.max(1,Math.ceil(candidates.length/200));browserPage=Math.min(browserPage,pages);
        const rows=candidates.slice((browserPage-1)*200,browserPage*200),count=node('p',(filtering?matchesRows.length+' matches · ':'')+candidates.length+' visible objects','zfsm-muted');browserHost.append(count);
        if(!matchesRows.length)browserHost.append(node('p','No matching datasets. Clear search or change the filter.','zfsm-notice'));
        if(pages>1){const previous=button('Previous datasets page',()=>{browserPage--;renderBrowser();}),next=button('Next datasets page',()=>{browserPage++;renderBrowser();});previous.disabled=browserPage===1;next.disabled=browserPage===pages;const paging=node('div',undefined,'zfsm-buttons');paging.append(previous,node('span','Page '+browserPage+' / '+pages),next);browserHost.append(paging);}

        function toggle(row){
            if(row.kind!=='dataset'||!(Object.keys(row.node.child||{}).length||(row.node.directories||[]).length))return node('span',undefined,'zfsm-tree-spacer');
            const control=button('',()=>{collapsed.has(row.name)?collapsed.delete(row.name):collapsed.add(row.name);savePreferences();renderBrowser();},{'aria-label':(collapsed.has(row.name)?'Expand ':'Collapse ')+row.name,'aria-expanded':!collapsed.has(row.name),class:'zfsm-tree-toggle'});control.append(zfsmCreateIcon(collapsed.has(row.name)?'chevron-right':'chevron-down'));return control;
        }
        function objectIcon(row){const marker=zfsmCreateIcon(row.kind==='directory'?'folder':row.name===pool?'pool':row.node.type==='volume'?'volume':row.node.origin&&row.node.origin!=='-'?'clone':'dataset');marker.classList.add('zfsm-object-icon');return marker;}
        if(layout==='tree')for(const row of rows){
            const line=node('div',undefined,'zfsm-tree-row');line.style.paddingLeft=(Math.min(row.depth,8)*12)+'px';
            line.append(toggle(row));
            const select=button('',()=>selectRow(row),{'data-node':row.name,'aria-pressed':selection===row.name,class:'zfsm-tree-node',title:row.name});select.append(objectIcon(row),node('span',row.depth?row.name.split('/').pop():row.name,'zfsm-node-label'),node('small',row.kind==='directory'?'Directory':row.node.type==='volume'?'Volume':bytes(row.node.used)));if(row.node.keystatus==='unavailable'){const locked=node('small','Locked','zfsm-node-state');locked.prepend(zfsmCreateIcon('lock'));select.append(locked);}else if(row.node.encryption&&row.node.encryption!=='off')select.append(node('small','Encrypted'));line.append(select);browserHost.append(line);
            select.addEventListener('keydown',event=>{const items=[...browserHost.querySelectorAll('[data-node]')],index=items.indexOf(select);if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();items[event.key==='Home'?0:event.key==='End'?items.length-1:Math.max(0,Math.min(items.length-1,index+(event.key==='ArrowDown'?1:-1)))].focus();}else if(event.key==='ArrowRight'&&collapsed.has(row.name)){event.preventDefault();collapsed.delete(row.name);savePreferences();renderBrowser();}else if(event.key==='ArrowLeft'){event.preventDefault();collapsed.add(row.name);savePreferences();renderBrowser();}});
        }else{
            const wrap=node('div',undefined,'zfsm-table-wrap'),table=node('table',undefined,'zfsm-table zfsm-inventory-table'),head=node('thead'),tr=node('tr'),body=node('tbody');
            for(const label of ['Dataset / Directory','Type','Mountpoint','Referenced','Used','Free','Snapshots','Actions']){const th=node('th',label);th.scope='col';tr.append(th);}head.append(tr);table.append(head,body);wrap.append(table);browserHost.append(wrap);
            for(const row of rows){const line=node('tr'),first=node('td'),label=node('span',undefined,'zfsm-table-node'),select=button(row.name,()=>selectRow(row),{'data-node':row.name,'aria-pressed':selection===row.name});select.prepend(objectIcon(row));first.style.paddingLeft=(10+Math.min(row.depth,8)*12)+'px';label.append(toggle(row),select);first.append(label);line.append(first);
                const values=row.kind==='directory'?['Directory',row.name,'—','—','—','—']:[row.node.type,row.node.mountpoint||'none',bytes(row.node.referenced),bytes(row.node.used),bytes(row.node.available),snapshotCount(row.node)];values.forEach((value,index)=>{const cell=node('td',value);if(index>=2)cell.setAttribute('data-number','');line.append(cell);});const actionCell=node('td');actionCell.append(button('Actions',()=>{selectRow(row,'actions');},{'data-node-action':row.name}));line.append(actionCell);body.append(line);}
        }
        if(focusedNode){const target=[...browserHost.querySelectorAll('[data-node]')].find(n=>n.dataset.node===focusedNode);target?.focus({preventScroll:true});}else if(focused==='Search datasets'){search.focus({preventScroll:true});search.setSelectionRange(caret,caret);}else if(focused==='Filter datasets')filter.focus({preventScroll:true});browserHost.scrollTop=scroll;
    }
    function selectRow(row,nextTab){
        const position={top:browserHost?.scrollTop||0,left:browserHost?.scrollLeft||0,tableLeft:browserHost?.querySelector('.zfsm-table-wrap')?.scrollLeft||0},viewport={left:window.scrollX,top:window.scrollY},focused=document.activeElement,browserAction=browserHost?.contains(focused)?focused.dataset.nodeAction:null,browserFocus=browserHost?.contains(focused)?focused.dataset.node:null;
        selectionChanged=false;selection=row.name;selectionIdentity=selectionFingerprint(row);tab=compatibleTab(row,nextTab||(row.kind==='directory'&&servicePath(row.name)?'actions':datasetTab));if(nextTab&&row.kind==='dataset')datasetTab=tab;savePreferences();renderSection();
        if(browserHost){if(browserFocus)[...browserHost.querySelectorAll('[data-node]')].find(control=>control.dataset.node===browserFocus)?.focus({preventScroll:true});else if(browserAction)[...browserHost.querySelectorAll('[data-node-action]')].find(control=>control.dataset.nodeAction===browserAction)?.focus({preventScroll:true});browserHost.scrollTop=position.top;browserHost.scrollLeft=position.left;const table=browserHost.querySelector('.zfsm-table-wrap');if(table)table.scrollLeft=position.tableLeft;}
        if(window.scrollX!==viewport.left||window.scrollY!==viewport.top)window.scrollTo({...viewport,behavior:'instant'});
    }
    function snapshotError(item){return inventoryError||(data&&data.errors||{})[pool]||(item&&item._snapshot_error)||'';}
    function snapshotsLoaded(item){return Boolean(data&&data.pools[pool]&&data.pools[pool].Snapshots!==null&&inventoryFresh&&!snapshotError(item));}
    function snapshotCount(item){return snapshotsLoaded(item)?String((item.snapshots||[]).length):snapshotError(item)||!inventoryFresh?'Unavailable':'Loading…';}
    function updateHeading(){if(!detailHeading)return;const item=selected();detailHeading.replaceChildren(node('h2',poolTabs.has(tab)?pool:item?item.name:pool),node('div',poolTabs.has(tab)?'Pool statistics — operations affect the pool':item?(item.kind==='directory'?'Directory':(item.node.type||'filesystem')+' · '+(item.node.mountpoint||'none')):'','zfsm-muted'));if(selectionChanged){const warning=node('p','Selected object identity changed. Review the new object before making changes.','zfsm-error');warning.append(button('Review current object',()=>{selectionChanged=false;selectionIdentity=selectionFingerprint();renderSection();}));detailHeading.append(warning);}}
    function renderCurrentPoolTab(){
        const host=detailBody&&detailBody.querySelector('.zfsm-pool-tab-content');if(!host)return;
        if(tab==='devices'){host.replaceChildren();renderPoolDevices(host);}
        else {
            const target=pool;
            zfsmRenderPoolDiagnostics(host,diagnostics.get(target),tab,{busy:scrubBusy.has(target),review:scrubReview===target,
                onReview:()=>{scrubReview=target;renderCurrentPoolTab();},onCancel:()=>{scrubReview='';renderCurrentPoolTab();},onScrub:()=>startScrub(target)});
        }
        scheduleDiagnostics();
    }
    function scheduleDiagnostics(){
        clearTimeout(diagnosticTimer);
        if(stopped||section!=='datasets'||tab!=='status'||!pool||scrubBusy.has(pool))return;
        diagnosticTimer=setTimeout(()=>{if(document.hidden)scheduleDiagnostics();else loadDiagnostics(pool);},5000);
    }
    async function startScrub(target){
        if(stopped||section!=='datasets'||tab!=='status'||scrubReview!==target||target!==pool||scrubBusy.has(target)||!zfsmCanStartScrub(diagnostics.get(target)))return;
        scrubBusy.add(target);scrubReview='';renderCurrentPoolTab();
        try{
            const answer=await request({cmd:'scrubpool',pool:target,confirmed:'1'});
            if(!answer||!answer.succeeded||!answer.failed)throw new Error('Invalid scrub response');
            const failures=Object.values(answer.failed),successes=Object.values(answer.succeeded);
            if(!failures.length&&!successes.length)throw new Error('Scrub result is not confirmed');
            if(!stopped)setStatus([...successes,...failures].join('; '),failures.length>0);
        }catch(error){if(!stopped)setStatus('Scrub result is not confirmed: '+error.message+' Inspect fresh pool status before retrying.',true);}
        finally{scrubBusy.delete(target);if(!stopped){await loadDiagnostics(target);if(section==='datasets'&&pool===target&&tab==='status')renderCurrentPoolTab();}}
    }
    function renderTab(){
        clearTimeout(diagnosticTimer);scrubReview='';
        if(!detailBody)return;invalidateForm();disposeSnapshots();disposeExplorer();viewGeneration++;snapshotHost=null;detailBody.replaceChildren();updateHeading();
        const area=detailBody.closest('.zfsm-workarea');area.dataset.activeTab=tab;area.dataset.poolView=String(poolTabs.has(tab));
        updateNavigation();
        area.prepend(tab==='overview'?browserHost:detailBody.closest('.zfsm-detail'));
        for(const item of content.querySelectorAll('[data-tab]'))item.setAttribute('aria-pressed',String(item.dataset.tab===tab));
        if(poolTabs.has(tab)){
            const navigation=node('nav',undefined,'zfsm-pool-tabs');navigation.setAttribute('aria-label','Pool sections');
            for(const [key,label] of [['status','Status'],['information','Capacity'],['devices','Devices']]){const control=button(label,()=>chooseTab(key),{'data-tab':key,'aria-pressed':key===tab});control.prepend(navigationIcon(key));navigation.append(control);}
            detailBody.append(navigation,node('div',undefined,'zfsm-pool-tab-content'));renderCurrentPoolTab();return;
        }
        const item=selected();if(!item){detailBody.append(node('p','The selected object is no longer available. Refresh inventory.','zfsm-error'));return;}
        if(tab==='overview')renderOverview(detailBody,item);
        else if(tab==='details')renderDatasetInformation(detailBody,item);
        else if(tab==='properties')openForm(detailBody,'editdatasetproperty',context(item));
        else if(tab==='snapshots'){snapshotHost=node('div');detailBody.append(snapshotHost);renderSnapshots();}
        else if(tab==='files')renderFiles(detailBody,item);
        else if(tab==='actions')renderActions(detailBody,item);
    }
    function renderOverview(host,item){
        if(item.kind==='directory'){host.append(node('p','Directory listing: '+item.name));return;}
        const error=snapshotError(item.node);if(error)host.append(node('p',error,'zfsm-error'));
        const fresh=inventoryFresh&&!error&&!selectionChanged,guid=String(item.node.guid||''),generation=viewGeneration,inventoryData=data,selectedPool=pool,surface=node('div');host.append(surface);
        const render=(properties,metadataState,metadataError)=>{surface.replaceChildren();zfsmRenderDatasetOverview(surface,{node:item.node,pool:selectedPool,fresh,loaded:snapshotsLoaded(item.node),config,bytes,date,properties,propertiesFresh:metadataState==='loaded',metadataState,metadataError,onAction:action=>openAction(action,context(item)),onTab:chooseTab});};
        render(null,fresh&&/^[1-9][0-9]*$/.test(guid)?'loading':'stale');
        if(!fresh||!/^[1-9][0-9]*$/.test(guid))return;
        const current=()=>!stopped&&surface.isConnected&&host.contains(surface)&&generation===viewGeneration&&section==='datasets'&&tab==='overview'&&pool===selectedPool&&selection===item.name&&inventoryFresh&&!selectionChanged&&data===inventoryData&&selected()?.node===item.node&&String(selected()?.node.guid||'')===guid;
        request({cmd:'getdatasetproperties',zdataset:item.name}).then(properties=>{
            if(!current())return;
            if(!properties||properties._error||properties.failed||properties.name!==item.name||String(properties.guid||'')!==guid)throw Error('Property metadata is unavailable or the dataset identity changed. Refresh inventory.');
            render(properties,'loaded');
        }).catch(error=>{if(current())render(null,'unavailable',error.message);});
    }
    function renderDatasetInformation(host,item){
        if(item.kind==='directory')return;
        const error=data.errors&&data.errors[pool];if(error)host.append(node('p',error,'zfsm-error'));
        if(!inventoryFresh)host.append(node('p','Cached inventory is stale. Refresh before acting on current state.','zfsm-notice'));
        const properties=node('dl',undefined,'zfsm-properties');
        const byteKeys=new Set(['used','available','referenced','usedbysnapshots','quota','recordsize','volblocksize','volsize']);
        for(const [key,value] of Object.entries(item.node)){
            if(value!==null&&typeof value==='object')continue;if(['_error','_snapshot_error'].includes(key))continue;
            let text=value===null?'—':String(value);if(key==='creation')text=date(value);else if(key==='compressratio')text=Number(value)/100+'x';else if(byteKeys.has(key))text=key==='quota'&&Number(value)===0?'Unlimited':bytes(value);
            properties.append(node('dt',key),node('dd',text));
        }
        host.append(node('h3','Dataset information'),properties);
    }
    function renderPoolDevices(host){
        host.append(node('h3','Pool devices'),node('p','Pool: '+pool,'zfsm-muted'));
        const error=data.errors&&data.errors[pool];if(error)host.append(node('p',error,'zfsm-error'));
        if(!inventoryFresh)host.append(node('p','Cached inventory is stale. Refresh before acting on current state.','zfsm-notice'));
        host.append(node('pre',data.devices[pool]||'No device list available.'));
    }
    function renderSnapshots(){
        if(!snapshotHost)return;const item=selected();if(!item)return;
        if(explorer){explorer.setAvailable(snapshotsLoaded(item.node)&&subtreeSnapshots(item.node).some(s=>s.name===explorer.snapshot));return;}
        const host=snapshotHost,selectedPool=pool,datasets=flatten(pool,false).filter(row=>row.kind==='dataset'&&(row.name===pool||row.name.startsWith(pool+'/')));
        zfsmRenderSnapshots(host,{node:item.node,pool,config,loaded:snapshotsLoaded(item.node),snapshotError:snapshotError(item.node)||(!inventoryFresh?'Inventory is stale; refresh before acting.':''),datasets:datasets.map(row=>row.name),onDataset:name=>{
            if(stopped||section!=='datasets'||tab!=='snapshots'||pool!==selectedPool||snapshotHost!==host)return;
            const row=flatten(pool,false).find(row=>row.kind==='dataset'&&row.name===name&&(name===pool||name.startsWith(pool+'/')));
            if(row)selectRow(row,'snapshots');
        },onAction:(action,ctx)=>openAction(action,ctx)});
    }
    function renderFiles(host,item){
        if(!item)return;
        if(explorer){explorer.setAvailable(snapshotsLoaded(item.node)&&subtreeSnapshots(item.node).some(s=>s.name===explorer.snapshot&&String(s.guid)===explorer.snapshotGuid));return;}
        host.replaceChildren(node('h3','Snapshot File Manager'),node('p','Choose a snapshot to browse files, prepare a ZIP or review a restore.','zfsm-muted'));
        const entry=node('div',undefined,'zfsm-file-entry'),label=node('label'),select=node('select'),empty=node('option','Choose snapshot');empty.value='';select.setAttribute('aria-label','Snapshot to browse');select.append(empty);
        const choices=subtreeSnapshots(item.node).filter(s=>/^[1-9][0-9]*$/.test(String(s.guid||'')));
        for(const snap of choices){const option=node('option',snap.name);option.value=snap.name;select.append(option);}
        label.append(node('span','Snapshot'),select);const open=button('Open File Manager',()=>{const snap=choices.find(s=>s.name===select.value);if(snap&&snapshotsLoaded(item.node))openAction('browsesnapshot',{...context(item),snapshot:snap.name});},{'data-open-file-manager':'',class:'zfsm-primary'});open.disabled=true;
        select.disabled=!snapshotsLoaded(item.node);select.addEventListener('change',()=>{open.disabled=!select.value||!snapshotsLoaded(item.node);});entry.append(label,open);host.append(entry);
        if(!snapshotsLoaded(item.node))host.append(node('p',snapshotError(item.node)||'Refresh snapshot inventory before browsing.','zfsm-notice'));else if(!choices.length)host.append(node('p','No snapshots are available for this dataset. Create one from Snapshots or Actions.','zfsm-notice'));
    }
    function renderActions(host,item){
        const bar=node('div',undefined,'zfsm-buttons zfsm-actions'),ctx=context(item),danger=Number(config.destructive_mode)===1;
        const icons={
            editacl:['M12 3l8 4v6c0 4-8 8-8 8s-8-4-8-8V7Z M9 12l2 2 4-4','Inspect supported exact mountpoint ACL editing, native masks and rollback.'],
            setquota:['M4 4h16v16H4Z M8 8h8 M8 12h8 M8 16h4','Review and change numeric POSIX user/group byte or object limits.'],
            snapshotdataset:['M3 7h4l2-3h6l2 3h4v13H3Z M16 13a4 4 0 1 0-8 0 4 4 0 0 0 8 0','Use when you need a restore point before changing files.'],
            renamedataset:['m15 4 5 5-11 11H4v-5Z M13 6l5 5','Use when you want to change this dataset name or path.'],
            editdatasetproperty:['M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6','Use when you need to change storage behaviour, compression, limits or mountpoint.'],
            adddirectortlisting:['M3 6h7l2 3h9v11H3Z M12 12v6 M9 15h6','Use when you need to show ordinary directories inside this dataset.'],
            removedirectorylisting:['M3 6h7l2 3h9v11H3Z M9 15h6','Use when you want to hide ordinary directories from the list; files are kept.'],
            promotedataset:['M5 20V6h7 M9 9l3-3-3-3 M12 12h7v8h-7Z','Use when you need to reverse the clone dependency so the original dataset no longer owns its base snapshot.'],
            unlockdataset:['M6 10h13v11H5V10 M9 10V7a4 4 0 0 1 8 0 M12 14v3','Use when you need to load the encryption key and access this dataset.'],
            lockdataset:['M5 10h14v11H5Z M8 10V7a4 4 0 0 1 8 0v3 M12 14v3','Use when you need to unmount this encrypted dataset and unload its key.'],
            destroydataset:['M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7','Use when you no longer need this dataset and its files. Review the deletion preview first.'],
            convertdirectory:['M3 6h7l2 3h9v11H3Z M7 14h10 M14 11l3 3-3 3','Use when you need to turn a directory into a separate ZFS dataset. Stop its writers first.'],
            movedirectory:['M3 6h7l2 3h9v11H3Z M8 15h8 M13 12l3 3-3 3','Use when you need to move or rename this ordinary directory.'],
            cleanupmutation:['M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7','Review a completed recovery journal and archive it before removing its empty container. Retained data stays protected.'],
            deletedirectory:['M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7','Use when you no longer need this directory and its contents.']
        };
        function action(label,command,enabled=true){
            const [drawing,help]=icons[command],control=button('',()=>openAction(command,ctx),{'aria-label':label,'aria-description':help,title:label+' — '+help,class:'zfsm-action-icon-button'});
            const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS(svg.namespaceURI,'path');
            svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');path.setAttribute('d',drawing);svg.append(path);control.append(svg,node('span',label));control.classList.add('zfsm-action-label-button');
            if(['destroydataset','deletedirectory','cleanupmutation','lockdataset'].includes(command))control.classList.add('zfsm-danger');
            const issue=snapshotOperationIssue(command,ctx);control.disabled=!enabled||Boolean(issue);if(issue){control.title=label+' — '+issue;control.setAttribute('aria-description',issue);}bar.append(control);
        }
        if(item.kind==='directory'){
            if(/^\.zfsm-mutation-[a-f0-9]{48}$/.test(item.name.split('/').pop()))action('Clean completed recovery','cleanupmutation',danger);
            else if(item.name.split('/').some(part=>part.startsWith('.zfsm-')))bar.append(node('p','Protected service directory. Retained data requires recovery review.','zfsm-notice'));
            else{action('Convert to dataset','convertdirectory',danger);action('Move / Rename','movedirectory',danger);action('Delete directory','deletedirectory',danger);}
        }
        else{
            action('Take Snapshot','snapshotdataset');action('Rename dataset','renamedataset',item.name!==pool);
            action('Edit Dataset','editdatasetproperty');
            if(item.node.type==='filesystem')action('User / group quotas','setquota');
            if(item.node.type==='filesystem')action('POSIX ACL editor','editacl');
            if(item.node.type!=='volume'){const listed=Array.isArray(config.directory_listing)&&config.directory_listing.includes(item.name);action(listed?'Remove Directory Listing':'Add Directory Listing',listed?'removedirectorylisting':'adddirectortlisting');}
            if(item.node.origin&&item.node.origin!=='-')action('Promote clone','promotedataset');
            if(item.node.type!=='volume'&&item.node.encryption&&item.node.encryption!=='off'&&item.node.encryptionroot===item.name&&item.node.keystatus!=='none'){
                const recovery=item.node.keystatus==='available'&&item.node._encryption_recovery;
                action(recovery?'Restore saved mounts':item.node.keystatus==='unavailable'?'Unlock dataset':'Lock dataset',recovery||item.node.keystatus==='unavailable'?'unlockdataset':'lockdataset',Boolean(recovery)||item.node.keystatus==='unavailable'||danger);
            }
            action('Destroy dataset','destroydataset',danger&&item.name!==pool);
        }
        if(item.node.encryptionroot&&item.node.encryptionroot!=='none'&&item.node.encryptionroot!==item.name){bar.append(button('Open encryption root: '+item.node.encryptionroot,()=>{const row=flatten(pool,false).find(r=>r.name===item.node.encryptionroot);if(row)selectRow(row,'actions');}));}
        host.append(bar);if(!inventoryFresh){const notice=node('div',undefined,'zfsm-notice');notice.append(node('p','Stale data — last successful refresh '+(lastSuccessfulRefresh||'unknown')+'. Refresh before making changes.'),button('Refresh inventory',()=>inventory.refresh()));host.append(notice);}if(!danger)host.append(node('p','Destructive Mode is off. Restricted operations are disabled.','zfsm-notice'));
    }
    function openForm(host,action,ctx,reveal=false){
        const opened={host,action,context:ctx};activeForm=opened;
        const position={left:window.scrollX,top:window.scrollY};let interacted=false;
        const userInput=()=>{interacted=true;};
        const events=['wheel','touchmove','keydown'];
        if(reveal)for(const event of events)window.addEventListener(event,userInput,{capture:true,passive:true});
        const cleanup=()=>{if(reveal)for(const event of events)window.removeEventListener(event,userInput,true);};
        const preserve=()=>{if(reveal&&!interacted&&activeForm===opened)window.scrollTo({...position,behavior:'instant'});};
        Promise.resolve(forms.render(host,action,ctx)).then(()=>{
            if(reveal&&!interacted&&activeForm===opened){const heading=host.querySelector('form h3');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}preserve();requestAnimationFrame(()=>{preserve();cleanup();});}else cleanup();
        }).catch(error=>{cleanup();if(activeForm===opened)host.append(node('p',error.message,'zfsm-error'));});
    }
    function closeActionForm(){
        const opener=actionDialog?.opener,inline=actionDialog?.inline,returnFocus=opener?.isConnected&&!opener.disabled&&opener!==document.body&&opener.getClientRects().length?opener:actionDialog?.returnFocus();
        invalidateForm();if(!stopped&&inline?.host.isConnected)openForm(inline.host,inline.action,inline.context);if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});
    }
    function openActionForm(action,ctx){
        const opener=document.activeElement,inline=actionDialog?actionDialog.inline:activeForm;invalidateForm();
        const dialog=node('dialog',undefined,'zfsm-action-dialog'),heading=node('header',undefined,'zfsm-action-heading'),title=node('h2'),host=node('div',undefined,'zfsm-action-form-host');
        dialog.opener=opener;dialog.inline=inline;actionDialog=dialog;
        dialog.returnFocus=()=>{
            let target;
            if(ctx.job?.id){const row=[...root.querySelectorAll('[data-job-id]')].find(item=>item.dataset.jobId===ctx.job.id);target=[...(row?.querySelectorAll('[data-job-action]')||[])].find(item=>item.dataset.jobAction===action&&!item.disabled)||row?.querySelector('summary');}
            else if(ctx.snapshot){const entry=[...root.querySelectorAll('[data-file-manager]')].find(item=>item.dataset.fileManager===ctx.snapshot);target=entry?.closest('tr')?.querySelector('summary[aria-label="Operations"]');}
            return target||[...(detailBody?.querySelectorAll('button[aria-label]')||[])].find(item=>!item.disabled&&item.getAttribute('aria-label')===opener?.getAttribute('aria-label'))||[...content.querySelectorAll('[data-tab]')].find(item=>item.dataset.tab===tab&&!item.disabled)||sectionButtons.get(section);
        };
        const close=button('Close',()=>{if(actionDialog===dialog)closeActionForm();},{'aria-label':'Close action'});heading.append(title,close);dialog.append(heading,host);root.append(dialog);
        dialog.addEventListener('cancel',event=>{event.preventDefault();if(actionDialog===dialog)closeActionForm();});
        openForm(host,action,ctx);title.textContent=host.querySelector('form')?.getAttribute('aria-label')||'Operation';dialog.setAttribute('aria-label',title.textContent);
        dialog.showModal();title.tabIndex=-1;title.focus({preventScroll:true});
    }
    function openAction(action,ctx){
        if(!detailBody)return;
        const currentItem=selected();if(currentItem)ctx={...context(currentItem),...ctx};
        if(action==='browsesnapshot'){
            const snapshotGuid=currentItem?subtreeSnapshots(currentItem.node).find(snapshot=>snapshot.name===ctx.snapshot)?.guid:null;
            if(!/^[1-9][0-9]*$/.test(String(snapshotGuid||'')))return;
            invalidateForm();disposeSnapshots();disposeExplorer();detailBody.querySelector('.zfsm-form-host')?.remove();
            const host=node('dialog',undefined,'zfsm-file-dialog');host.setAttribute('aria-label','Snapshot File Manager');root.append(host);explorerDialog=host;
            const close=()=>{disposeExplorer();if(tab==='files'){renderFiles(detailBody,selected());detailBody.querySelector('[aria-label="Snapshot to browse"]')?.focus({preventScroll:true});}else{renderSnapshots();[...snapshotHost.querySelectorAll('[data-file-manager]')].find(control=>control.dataset.fileManager===ctx.snapshot)?.focus({preventScroll:true});}};
            host.addEventListener('cancel',event=>{event.preventDefault();close();});
            explorer=zfsmCreateSnapshotExplorer({host,snapshot:ctx.snapshot,snapshotGuid:String(snapshotGuid),request,getConfig:()=>config,onClose:close,onJobs:()=>navigate('jobs'),download:downloadSnapshot});explorer.snapshot=ctx.snapshot;explorer.snapshotGuid=String(snapshotGuid);explorer.updateJobs(jobs.jobs);host.showModal();host.querySelector('input[type=search]')?.focus({preventScroll:true});return;
        }
        openActionForm(action,ctx);
    }
    function downloadSnapshot(fields,onError){
        // ZIP handoff needs a top-level attachment navigation in the in-app browser.
        // Keep the existing single-file flow and its asynchronous info check.
        // Keep CSRF in the authenticated POST body, never in an URL or a blob.
        const archive=fields.cmd==='downloadsnapshotarchive',frame=archive?null:node('iframe');
        if(frame){frame.hidden=true;frame.name='zfsm-download-'+Date.now()+'-'+Math.random().toString(16).slice(2);frame.title='Snapshot download';}
        const form=node('form');form.hidden=true;form.method='POST';form.action=options.url;form.target=archive?'_blank':frame.name;if(archive)form.rel='noopener';
        for(const [name,value]of Object.entries({...fields,csrf_token:options.csrf||''})){const input=node('input');input.type='hidden';input.name=name;input.value=value;form.append(input);}
        if(frame){frame.addEventListener('load',()=>{try{const text=frame.contentDocument?.body?.textContent?.trim();if(text){const response=JSON.parse(text);if(response.failed)onError(Object.values(response.failed).join('; '));}}catch(_){onError('Download could not start. Check the browser session and try again.');}});document.body.append(frame);}
        document.body.append(form);try{form.submit();}finally{form.remove();}if(frame)setTimeout(()=>frame.remove(),120000);
        loadJobs();
    }
    function operationComplete(answer,action,ctx,metadata){
        if(stopped)return;
        if(answer?.job?.id&&!['convertdirectory','cancelconversion','resumeconversion','publishconversion','cancelrestore','deletedirectory','destroydataset'].includes(action))loadJobs();
        if(action==='saveconfig'&&metadata&&metadata.settings&&answer&&answer.succeeded&&Object.keys(answer.succeeded).length&&answer.failed&&!Object.keys(answer.failed).length){
            const acknowledged=metadata.settings;
            config=Object.assign({},config,acknowledged,{dataset_exclusion:acknowledged.exclusion||'',directory_listing:String(acknowledged.directory_listing||'').split(/\r\n|\r|\n/).filter(Boolean)});
            inventory.updateConfig(config);
            if(activeForm)forms.render(activeForm.host,activeForm.action,activeForm.context);
            if(snapshotHost)renderSnapshots();
        }
        if(action==='cleanupmutation'&&answer?.succeeded&&Object.keys(answer.succeeded).length&&!Object.keys(answer.failed||{}).length){
            cleanupNotice.replaceChildren(node('strong','Recovery cleanup completed'),node('p',ctx.directory),node('p','Journal archive: '+answer.cleanup_archive),button('Dismiss',()=>{cleanupNotice.hidden=true;}));cleanupNotice.hidden=false;
        }
        if(['convertdirectory','cancelconversion','resumeconversion','publishconversion','cancelrestore','deletedirectory','destroydataset'].includes(action))loadJobs();
        else if(answer&&(answer.uncertain||(answer.succeeded&&Object.keys(answer.succeeded).length)))inventory.refresh();
    }
    function validDiagnostics(answer,name){
        if(!answer||answer.pool!==name||!['ok','warning','error','unknown'].includes(answer.severity)||typeof answer.health!=='string'||!Array.isArray(answer.reasons)||!Array.isArray(answer.command_errors))return false;
        const status=answer.status,info=answer.information,columns=['NAME','SIZE','ALLOC','FREE','CKPOINT','EXPANDSZ','FRAG','CAP','DEDUP','HEALTH','ALTROOT'];
        if(!status||typeof status.text!=='string'||!Array.isArray(status.rows)||!info||typeof info.text!=='string'||!Array.isArray(info.rows)||!Array.isArray(info.columns)||columns.some((value,index)=>info.columns[index]!==value)||info.columns.length!==columns.length)return false;
        if(answer.severity==='unknown')return answer.reasons.length>0;
        return typeof status.state==='string'&&status.rows.length>0&&info.rows.length>0&&status.rows[0].name===name&&info.rows[0].name===name&&status.rows.every(row=>row&&typeof row.name==='string'&&typeof row.state==='string'&&['read','write','cksum'].every(key=>(row.section==='spares'&&row[key]===null)||['string','number'].includes(typeof row[key])))&&info.rows.every(row=>row&&typeof row.name==='string'&&typeof row.health==='string');
    }
    async function loadDiagnostics(onlyPool){
        if(stopped||!data)return;
        if(diagnosticBusy){diagnosticPending=true;return;}diagnosticBusy=true;
        for(const name of Object.keys(data.pools)){
            if(onlyPool&&name!==onlyPool)continue;
            if(stopped)break;
            try{
                const answer=await request({cmd:'pooldiagnostics',pool:name});
                if(stopped)break;
                if(!validDiagnostics(answer,name))throw new Error(Object.values(answer.failed||{}).join('; ')||'Invalid pool diagnostic response');
                if(data.pools[name]){
                    if(answer.severity==='unknown'){
                        // Preserve incomplete provenance even when a known fault raises severity.
                        answer.stale=true;
                        const previous=diagnostics.get(name);
                        if(previous){
                            // An incomplete read cannot clear a device error merely by omitting that device.
                            const retainKnownErrors=knownDiagnosticError(previous);
                            const retainStatus=(retainKnownErrors||!answer.status.rows.length)&&previous.status,retainInformation=(retainKnownErrors||!answer.information.rows.length)&&previous.information;
                            if(retainStatus)answer.status=previous.status;
                            if(retainInformation)answer.information=previous.information;
                            if(retainKnownErrors&&previous.health)answer.health=previous.health;
                            if(retainStatus||retainInformation){answer.attempted_at=answer.collected_at;answer.collected_at=previous.collected_at;answer.stale=true;answer.reasons=[...new Set([...(previous.reasons||[]),...answer.reasons])];}
                        }
                        if(knownDiagnosticError(answer))answer.severity='error';
                    }
                    diagnostics.set(name,answer);
                }
            }catch(error){if(stopped)break;const previous=diagnostics.get(name)||{};diagnostics.set(name,Object.assign({},previous,{pool:name,health:previous.health||data.pools[name]&&data.pools[name].Health||'UNKNOWN',severity:knownDiagnosticError(previous)?'error':'unknown',stale:true,reasons:[...new Set([...(previous.reasons||[]),'Unable to refresh diagnostics: '+error.message])]}));}
            renderPools();if(section==='overview')renderSection();else if(section==='datasets'&&pool===name&&['status','information'].includes(tab)&&detailBody)renderCurrentPoolTab();
        }
        diagnosticBusy=false;if(diagnosticPending&&!stopped){diagnosticPending=false;loadDiagnostics();}else scheduleDiagnostics();
    }
    function jobRequestFields(){return {cmd:'conversionjobs',page:String(section==='jobs'?jobsPage:1),page_size:String(section==='jobs'?jobsPageSize:10),...(section==='jobs'?{filter:jobsFilter,sort:jobsSort,view:jobsView}:{})};}
    async function loadJobs(){
        if(stopped)return;if(jobsBusy){jobsPending=true;return;}jobsBusy=true;clearTimeout(jobsTimer);
        const fields=jobRequestFields(),scope=JSON.stringify(fields),tracked=[...inventoryJobs];
        try{
            const answer=await request(fields);if(stopped)return;
            if(scope!==JSON.stringify(jobRequestFields())){jobsPending=true;return;}
            if(!Array.isArray(answer.jobs))throw new Error(Object.values(answer.failed||{}).join('; ')||'Invalid jobs response');
            const active=job=>['queued','running'].includes(job.state),observed=new Map(answer.jobs.map(job=>[job.id,job]));
            for(const job of answer.jobs)if(inventoryJob(job)&&active(job))inventoryJobs.add(job.id);
            // Jobs registered after this read began belong to a newer observation.
            let complete=fields.filter===undefined;
            const hiddenActive=Number(answer.counts?.active)>answer.jobs.filter(active).length;
            if(!complete&&(tracked.some(id=>!observed.has(id))||hiddenActive)){
                // The legacy unfiltered page contains every active/attention Job,
                // regardless of the visible filter or completed-history page.
                const background=await request({cmd:'conversionjobs',page:'1',page_size:'1'});if(stopped)return;
                if(scope!==JSON.stringify(jobRequestFields())){jobsPending=true;return;}
                if(!Array.isArray(background.jobs))throw new Error(Object.values(background.failed||{}).join('; ')||'Invalid background jobs response');
                for(const job of background.jobs){observed.set(job.id,job);if(inventoryJob(job)&&active(job))inventoryJobs.add(job.id);}
                complete=true;
            }
            let refreshInventory=false;
            for(const id of tracked){const job=observed.get(id);if(job? !active(job):complete){inventoryJobs.delete(id);refreshInventory=true;}}
            jobs=answer;jobsScope=scope;jobsError='';if(refreshInventory)inventory.refresh();
        }
        catch(error){if(scope!==JSON.stringify(jobRequestFields()))jobsPending=true;else jobsError='Job status unavailable. Retained results may be stale: '+error.message;}
        finally{jobsBusy=false;if(!stopped){sectionButtons.get('jobs').querySelector('.zfsm-nav-label').textContent='Jobs'+(jobs.jobs.length?' · '+jobs.jobs.length:'');renderJobs();if(section==='overview')renderSection();if(activeForm&&['cancelconversion','resumeconversion','cancelrestore'].includes(activeForm.action))forms.render(activeForm.host,activeForm.action,activeForm.context);explorer?.updateJobs?.(jobs.jobs);if(jobsPending){jobsPending=false;loadJobs();}else jobsTimer=setTimeout(loadJobs,2500);}}
    }
    function renderJobs(){
        if(!jobsHost)return;
        const previousStorage=jobsHost.querySelector('.zfsm-history-storage');if(previousStorage)jobsStorageOpen=previousStorage.open;
        for(const detail of jobsHost.querySelectorAll('[data-job-id] > details')){const id=detail.closest('[data-job-id]').dataset.jobId;detail.open?jobsExpanded.add(id):jobsExpanded.delete(id);}
        for(const detail of jobsHost.querySelectorAll('[data-job-diagnostics]')){const id=detail.closest('[data-job-id]').dataset.jobId;detail.open?jobsDiagnosticsExpanded.add(id):jobsDiagnosticsExpanded.delete(id);}
        const copyNodes=new Map([...jobsHost.querySelectorAll('[data-job-id]')].map(row=>[row.dataset.jobId,[...row.querySelectorAll('[data-copy-status],[data-copy-fallback]')]]));
        const focusedNode=jobsHost.contains(document.activeElement)?document.activeElement:null;
        const focused=focusedNode?.getAttribute('aria-label'),focusedSummary=focusedNode?.tagName==='SUMMARY'?focusedNode.closest('[data-job-id]')?.dataset.jobId:null,focusedDiagnostics=Boolean(focusedNode?.closest('[data-job-diagnostics]'));
        jobsHost.replaceChildren();
        if(jobsScope!==JSON.stringify(jobRequestFields())){const notice=node('p',jobsError||'Loading current jobs…',jobsError?'zfsm-error':'zfsm-notice');notice.setAttribute('role',jobsError?'alert':'status');jobsHost.append(notice);return;}
        const toolbar=node('div',undefined,'zfsm-buttons');
        function choice(label,values,current,change){const wrap=node('label'),select=node('select');select.setAttribute('aria-label',label);for(const [value,caption]of values){const option=node('option',caption);option.value=value;select.append(option);}select.value=current;select.addEventListener('change',()=>{change(select.value);jobsPage=1;jobsClear=null;loadJobs();});wrap.append(node('span',label+' '),select);toolbar.append(wrap);}
        choice('Filter jobs',[['all','All operations'],['active','Active'],['needs_attention','Needs attention'],['completed','Completed'],['recovery','Recovery'],['snapshot','Snapshots'],['restore','Restore'],['archive','ZIP'],['download','Downloads'],['conversion','Conversion'],['deletion','Deletion'],['operation','Other operations'],['maintenance','Maintenance'],['policy','Snapshot policies'],['replication','Replication']],jobsFilter,value=>jobsFilter=value);
        choice('Jobs per page',[[10,'10'],[25,'25'],[50,'50'],[100,'100']],jobsPageSize,value=>{jobsPageSize=Number(value);savePreferences();});
        choice('Sort jobs',[['newest','Newest first'],['oldest','Oldest first'],['attention','Attention first']],jobsSort,value=>jobsSort=value);
        choice('Jobs view',[['working','Working view'],['archived','Archived'],['all','All including archived']],jobsView,value=>jobsView=value);
        const eligible=jobs.jobs.filter(job=>job.archive_eligible===true&&!job.archived).map(job=>job.id).slice(0,200),archived=jobs.jobs.filter(job=>job.archived===true).map(job=>job.id).slice(0,200);
        const clear=button('Clear completed on this page',()=>{jobsClear={ids:eligible.slice(),archive:true};renderJobs();}),restore=button('Restore archived on this page',()=>{jobsClear={ids:archived.slice(),archive:false};renderJobs();});
        clear.disabled=!eligible.length||!!jobsError||jobsVisibilityBusy;restore.disabled=!archived.length||!!jobsError||jobsVisibilityBusy;clear.hidden=jobsView==='archived';restore.hidden=jobsView==='working';toolbar.append(clear,restore);jobsHost.append(toolbar);
        if(jobsClear){const pending=jobsClear,confirmation=node('div',undefined,'zfsm-notice');confirmation.append(node('p',(pending.archive?'Hide '+pending.ids.length+' completed job(s) from this page? Journals, ZIP cleanup and retained files stay available.':'Restore '+pending.ids.length+' archived job(s) from this page?')),button(pending.archive?'Confirm hide':'Confirm restore',async()=>{if(jobsVisibilityBusy)return;jobsVisibilityBusy=true;try{const answer=await request({cmd:'activityvisibility',kind:'jobs',ids:pending.ids,archived:pending.archive?'1':'0'});if(!answer.succeeded||Object.keys(answer.failed||{}).length)throw new Error(Object.values(answer.failed||{}).join('; ')||'Invalid visibility response');jobsClear=null;await loadJobs();}catch(error){jobsError='Unable to change job visibility: '+error.message;renderJobs();}finally{jobsVisibilityBusy=false;}}),button('Cancel',()=>{jobsClear=null;renderJobs();}));jobsHost.append(confirmation);}

        const storage=node('details',undefined,'zfsm-history-storage'),storageTitle=node('summary','History storage'),last=jobs.history?.last_cleanup;
        storage.open=jobsStorageOpen;storageTitle.setAttribute('aria-label','History storage');
        storage.append(storageTitle,node('p','Automatic cleanup checks every hour. Successful log entries are kept for up to 30 days, with storage targets of 1,000 entries or 32 MiB. At least the newest 100 successful entries and the latest policy/replication results are retained.'));
        storage.append(node('p','Active tasks, errors, warnings, recovery records, saved-data journals and referenced records are protected. These can exceed the targets. Cleanup never deletes datasets, snapshots, ZIP/restore files or saved originals. Administrative History is retained separately.'));
        if(last){storage.append(node('p','Last check: '+date(last.checked_at)+' · '+last.removed+' log entries removed · '+bytes(last.reclaimed_bytes)+' reclaimed.'));if(last.warning)storage.append(node('p',last.warning,'zfsm-notice'));}
        else storage.append(node('p','The background worker will check history storage. Hiding completed entries changes the view and does not free storage.','zfsm-muted'));
        jobsHost.append(storage);
        if(jobs.pagination){const p=jobs.pagination,bar=node('div',undefined,'zfsm-buttons'),previous=button('Previous jobs',()=>{jobsPage=p.page-1;loadJobs();}),next=button('Next jobs',()=>{jobsPage=p.page+1;loadJobs();});previous.disabled=!p.has_previous||Boolean(jobsError);next.disabled=!p.has_next||Boolean(jobsError);bar.append(previous,node('span','Page '+p.page+' / '+p.pages+' · '+p.total+' total'),next);jobsHost.append(bar);}if(jobsError){const error=node('p',jobsError,'zfsm-error');error.setAttribute('role','alert');jobsHost.append(error);}
        if(!jobs.jobs.length)jobsHost.append(node('p','No background jobs.','zfsm-notice'));
        let previousGroup='';
        for(const job of jobs.jobs){
            const requestOwned=job.schema===7,requestStage=({planned:'Waiting to start',validating_request:'Checking request',acquiring_lock:'Waiting for operation lock',validating_identity:'Checking object identity',executing_operation:'Executing operation',transferring:'Sending to browser',scrubbing:'Scrubbing pool',scrub_paused:'Native scrub paused',scrub_cancelled:'Native scrub cancelled',observation_lost:'Inspection required',inspection_required:'Inspection required',awaiting_scan:'Waiting for native scan status',completed:'Completed',preflight_rejected:'Request refused',interrupted:'Interrupted'})[job.stage]||job.stage;
            const group=job.group||(['queued','running'].includes(job.state)?'active':job.state==='completed'?'completed':'needs_attention');if(group!==previousGroup){jobsHost.append(node('h3',{active:'Active',needs_attention:'Needs Attention',completed:'Completed'}[group]));previousGroup=group;}
            const warning=requestOwned&&job.result?.severity==='warning'?{title:'Completed with warnings',summary:job.result.summary}:typeof zfsmProtectionJobWarning==='function'?zfsmProtectionJobWarning(job):null;
            const copiedPhase=job.type==='conversion'&&job.state==='running'&&!jobsError?(job.stage==='copying'&&job.progress?.stage==='verifying'?'Verifying files':({copy_verified:'Copy verified',claiming:'Retaining original',source_retained:'Verifying retained original',reserving:'Preparing mount location',reserved:'Mount location ready',mountpoint_pending:'Updating dataset mountpoint',publishing:'Mounting dataset',published:'Checking mounted dataset'}[job.stage]||'')):'';
            const requestLabel=job.command==='protectioncontrol'&&['enable','disable','remove'].includes(job.definition_action)?({enable:'Enable',disable:'Disable',remove:'Delete'})[job.definition_action]+' '+(job.category==='policy'?'snapshot policy':'replication task'):String(job.label||'Operation');
            const isRestore=job.type==='restore',isArchive=job.type==='archive',isDeletion=job.type==='deletion',deletionStage=({planned:'Waiting to start',validating:'Checking target and protection',scanning:'Counting selected objects',deleting:job.kind==='directory'?'Deleting directory contents':'Deleting reviewed ZFS objects',verifying:'Verifying deletion',completed:'Completed',interrupted:'Inspection required',preflight_rejected:'Request refused',preflight_failed:'Safety check failed'})[(job.state==='running'?job.progress?.stage:null)||job.stage]||job.stage,row=node('div',undefined,'zfsm-job');row.dataset.jobId=job.id;row.append(node('strong',(requestOwned?requestLabel+' · ':isRestore?'Restore · ':isArchive?'ZIP · ':isDeletion?(job.kind==='directory'?'Delete directory · ':'Delete dataset · '):'')+(job.source||job.id)+(job.definition_name?' · '+job.definition_name:'')),node('div',warning?'⚠ '+warning.title:(job.state==='completed'?'✓ ':'')+(isDeletion||requestOwned?({queued:'Queued',running:'In progress',completed:'Completed',failed:'Failed',recovery_required:'Inspection required',cancelled:'Cancelled'})[job.state]:String(job.state))+((isDeletion&&job.state==='completed'||requestOwned&&!['queued','running'].includes(job.state))?'':' · '+(copiedPhase||(isDeletion?deletionStage:requestOwned?requestStage:String(job.stage)))),job.state==='completed'&&!warning?'zfsm-success':'zfsm-job-status'));
            row.lastElementChild.setAttribute('role','status');row.lastElementChild.setAttribute('aria-label','Job '+job.id+' status');
            if(warning)row.lastElementChild.dataset.severity='warning';
            if(job.created)row.append(node('p','Queued: '+date(job.created),'zfsm-muted'));
            const attemptStart=job.state==='queued'?null:job.started_at,attemptEnd=job.state==='queued'?null:job.finished_at;
            const timestamp=value=>typeof value==='number'&&value>0?value*1000:typeof value==='string'&&value.trim()!==''?Date.parse(value):NaN;
            const started=timestamp(attemptStart),finished=timestamp(attemptEnd),ended=Number.isFinite(finished)?finished:job.state==='running'&&(jobs.worker_running||job.execution_active===true)&&!jobsError?Date.now():NaN;
            row.append(node('p','Attempt started: '+(Number.isFinite(started)?date(attemptStart):'Unknown'),'zfsm-muted'),node('p','Attempt finished: '+(Number.isFinite(finished)?date(attemptEnd):'Unknown'),'zfsm-muted'),node('p','Attempt elapsed: '+(Number.isFinite(started)&&Number.isFinite(ended)&&ended>=started?Math.floor((ended-started)/1000)+' s':'Unknown'),'zfsm-muted'));
            if(job.updated)row.append(node('p','Last update: '+date(job.updated),'zfsm-muted'));
            if(isDeletion){
                if(['queued','running'].includes(job.state)){const progress=node('progress');progress.max=100;progress.setAttribute('aria-label','Deletion progress');const measured=job.kind==='directory'&&Number.isSafeInteger(job.progress?.removed)&&job.progress.removed>=0&&Number.isSafeInteger(job.progress?.total)&&job.progress.total>0&&job.progress.removed<=job.progress.total;if(measured)progress.value=Math.floor(100*job.progress.removed/job.progress.total);row.append(progress,node('span',measured?job.progress.removed+' / '+job.progress.total+' objects deleted · '+progress.value+'%':deletionStage+'…','zfsm-muted'));}
                if(job.result?.summary){const result=node('p',job.result.summary,'zfsm-notice');result.dataset.deletionResult='';result.setAttribute('role','status');row.append(result);}
            }else if(job.progress||copiedPhase){const progress=node('progress');progress.max=100;const measured=typeof job.progress?.percent==='number'&&Number.isFinite(job.progress.percent);if(copiedPhase||measured)progress.value=copiedPhase?100:Math.max(0,Math.min(100,job.progress.percent));progress.setAttribute('aria-label',isRestore?'Restore progress':isArchive?'ZIP progress':job.type==='download'?'Download progress':requestOwned?'Operation progress':job.type==='replication'?'Replication progress':job.type==='policy'?'Snapshot policy progress':'Conversion progress');if(copiedPhase)progress.setAttribute('aria-valuetext','Copying 100%; '+copiedPhase+'. Conversion is not finished.');
                const detail=isRestore||isArchive||job.type==='download'?bytes(job.progress?.bytes)+' / '+bytes(job.bytes??job.progress?.total)+(job.progress?.current?' · '+job.progress.current:''):[job.progress?.rate,job.progress?.remaining].filter(value=>typeof value==='string'&&value.trim()).map(value=>value.trim()).join(' · ');
                row.append(progress,node('span',copiedPhase?'Copying: 100% · '+copiedPhase+'…':[measured?progress.value+'%':(requestOwned?requestStage:String(job.stage))+'…',detail].filter(Boolean).join(' · '),'zfsm-muted'));}
            else if(['queued','running'].includes(job.state)){const progress=node('progress');progress.setAttribute('aria-label',isRestore?'Restore progress':isArchive?'ZIP progress':requestOwned?'Operation progress':job.type==='replication'?'Replication progress':job.type==='policy'?'Snapshot policy progress':'Conversion progress');row.append(progress,node('span',job.state==='queued'?'Waiting to start…':'Working · '+(requestOwned?requestStage:job.stage)+' · percentage unavailable','zfsm-muted'));}
            if(requestOwned&&job.result?.summary){const result=node('p',job.result.summary,'zfsm-notice');result.dataset.operationResult='';result.setAttribute('role','status');row.append(result);}
            for(const [key,label] of [['error','Error'],['target','Target'],...(isRestore&&job.state!=='completed'?[['staging','Copied files retained at']]:[])])if(job[key]){const message=node('p',label+': '+job[key],key==='error'?'zfsm-error':'zfsm-muted');if(key==='error')message.setAttribute('role','alert');row.append(message);}
            if(job.recovery){const recovery=job.recovery,structured=typeof recovery==='object',location=structured?recovery.location:null;row.append(node('p',isDeletion?'Recovery journal'+(typeof location==='string'?': '+location:'')+'. This records the operation; deleted files are not saved.':structured?'Recovery information requires inspection. Open Technical diagnostics for the recorded details.':(isRestore?'Previous files retained at: ':'Retained original: ')+recovery,'zfsm-muted'));}
            const details=node('details'),summary=node('summary','Inspect job / recovery information');summary.setAttribute('aria-label','Inspect job '+job.id+' / recovery information');details.open=jobsExpanded.has(job.id);details.addEventListener('toggle',()=>{details.open?jobsExpanded.add(job.id):jobsExpanded.delete(job.id);});details.append(summary,node('h4','Stage history'));
            const history=Array.isArray(job.stage_history)?job.stage_history:[];
            if(job.stage_history_complete!==true)details.append(node('p','Stage history: Unknown before recording began. Earlier stages and attempts are unavailable.','zfsm-muted'));
            if(Number.isInteger(job.stage_history_dropped)&&job.stage_history_dropped>0)details.append(node('p',job.stage_history_dropped+' earlier stage events omitted; only the newest recorded events are retained.','zfsm-muted'));
            const timeline=node('ol');timeline.dataset.stageHistory='';timeline.setAttribute('aria-label','Recorded job stages');
            for(const event of history){const attempt=Number.isInteger(event.attempt)?event.attempt===0?'Before first attempt':(job.stage_history_complete===true?'Attempt ':'Recorded attempt ')+event.attempt:'Attempt Unknown';timeline.append(node('li',(event.at?date(event.at):'Time Unknown')+' · '+attempt+' · '+String(event.state||'Unknown')+' · '+String(event.stage||'Unknown')));}
            const technical=node('details');technical.dataset.jobDiagnostics='';technical.open=jobsDiagnosticsExpanded.has(job.id);technical.append(node('summary','Technical diagnostics'),node('pre',JSON.stringify({id:job.id,type:job.type,schema:job.schema,stage:job.stage,...(requestOwned?{command:job.command,label:job.label,result:job.result}:{}),recovery:job.recovery,diagnostics:job.diagnostics,retained_data:job.retained_data,...(job.schema===4?{verified_outcome:job.verified_outcome,verification:job.verification}: {})},null,2)));details.append(timeline,technical);if(job.schema===4)details.prepend(node('p','Verified outcome: '+String(job.verified_outcome||'unknown')+' · Exit code: '+String(job.verification?.exit_code??'Unknown')));row.append(details);
            const controls=node('div',undefined,'zfsm-buttons');controls.append(button('Copy',()=>zfsmCopyActivity(row,job),{'aria-label':'Copy job '+job.id}));
            function control(label,action){controls.append(button(label,()=>openActionForm(action,{job}),{'data-job-action':action}));}
            if(job.schema===4&&!jobsError&&job.actions?.cancel)controls.append(button('Cancel protection run',async()=>{try{const answer=await request({cmd:'protectioncancel',job_id:job.id});if(Object.keys(answer.failed||{}).length)throw new Error(Object.values(answer.failed).join('; '));await loadJobs();}catch(error){jobsError=error.message;renderJobs();}}));else if(!jobsError&&(job.actions?job.actions.cancel:job.schema===1&&['queued','running'].includes(job.state)))control('Cancel',isRestore||isArchive?'cancelrestore':'cancelconversion');
            if(!jobsError&&(job.actions?job.actions.resume:job.schema===1&&!isRestore&&!isArchive&&(['cancelled','failed','recovery_required'].includes(job.state)||(['queued','running'].includes(job.state)&&!jobs.worker_running))))control('Resume','resumeconversion');
            if(!jobsError&&job.actions?.publish===true)control('Publish verified copy','publishconversion');
            if(isArchive&&job.state==='completed'&&!job.archive_removed&&Number(job.expires)*1000>Date.now())controls.append(button('↓ Download ZIP',()=>downloadSnapshot({cmd:'downloadsnapshotarchive',job_id:job.id},message=>{row.append(node('p',message,'zfsm-error'));})));
            if(isArchive&&job.state==='completed')row.append(node('p',job.archive_removed?'ZIP expired. Prepare a new archive.':'ZIP expires: '+date(Number(job.expires)), 'zfsm-muted'));
            row.append(controls,...(copyNodes.get(job.id)||[]));summary.classList.add('zfsm-job-summary');summary.replaceChildren(row.children[0],row.children[1],node('span',job.created?date(job.created):'Unknown','zfsm-muted'));const visible=[...row.children].filter(child=>(['queued','running'].includes(job.state)&&(child.tagName==='PROGRESS'||child.previousElementSibling?.tagName==='PROGRESS'))||child.getAttribute('role')==='alert');const extra=[...row.children].filter(child=>child!==details&&!visible.includes(child));if(visible.length){const feedback=node('span',undefined,'zfsm-job-feedback');feedback.append(...visible);summary.append(feedback);}for(const child of extra)details.append(child);row.replaceChildren(details);if(isDeletion||requestOwned){const result=details.querySelector('[data-deletion-result],[data-operation-result]');if(result)row.append(result);}if(warning){const notice=node('p',warning.summary,'zfsm-notice');notice.dataset.severity='warning';notice.setAttribute('role','status');summary.after(notice);}jobsHost.append(row);
        }
        if(focusedNode?.isConnected&&jobsHost.contains(focusedNode))focusedNode.focus({preventScroll:true});
        else if(focusedSummary)[...jobsHost.querySelectorAll('[data-job-id]')].find(row=>row.dataset.jobId===focusedSummary)?.querySelector(focusedDiagnostics?'[data-job-diagnostics] > summary':'summary')?.focus({preventScroll:true});
        else if(focused)[...jobsHost.querySelectorAll('[aria-label]')].find(item=>item.getAttribute('aria-label')===focused)?.focus({preventScroll:true});
        jobsHost.prepend(node('p',backgroundTaskStatus()+'. '+(jobs.worker_running?'Handles requested deletion, ZIP, restore and conversion tasks.':'Queued tasks wait until the background worker is available.'),'zfsm-notice'));
    }
    async function loadHistory(host,generation){
        const notice=node('p','Loading administrative history…','zfsm-notice');host.append(notice);
        try{const answer=await request({cmd:'auditlog'});if(stopped||generation!==viewGeneration)return;if(!Array.isArray(answer.entries))throw new Error(Object.values(answer.failed||{}).join('; ')||'Invalid audit response');notice.remove();
            zfsmRenderHistory(host,answer.entries,{date,limit:500,archivedIds:answer.archived_ids,setVisibility:async(ids,archive)=>{let review_token='';if(archive){for(let scan=0;scan<256;scan++){const proof=await request({cmd:'previewhistoryarchive',ids,review_token});if(!proof||typeof proof.review_token!=='string'||typeof proof.complete!=='boolean')throw new Error(Object.values(proof?.failed||{}).join('; ')||'Invalid history review');review_token=proof.review_token;if(proof.complete)break;if(scan===255)throw new Error('History review is incomplete; no operations were hidden');}}return request({cmd:'activityvisibility',kind:'history',ids,review_token,archived:archive?'1':'0'});} ,hasMore:answer.has_more,nextCursor:answer.next_cursor,scanLimited:answer.scan_limited,isCurrent:()=>!stopped&&generation===viewGeneration&&section==='history',loadOlder:cursor=>request({cmd:'auditlog',cursor})});
        }catch(error){if(!stopped&&generation===viewGeneration){notice.className='zfsm-error';notice.textContent='Unable to read administrative history: '+error.message;}}
    }
    function cleanCache(value){if(Array.isArray(value))return value.map(cleanCache);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/(passphrase|password|secret|private.?key|keymaterial)/i.test(key)).map(([key,item])=>[key,cleanCache(item)]));return value;}
    function cacheInventory(){const cache={time:new Date().toISOString(),data:cleanCache(data)};try{const encoded=JSON.stringify(cache);if(encoded.length<1000000)localStorage.setItem(cacheKey,encoded);}catch(_){/* Cache is optional. */}}
    function applyInventory(next,complete){
        const newCycle=next!==lastInventory,previousPool=pool,previousSelection=selection;lastInventory=next;data=next;inventoryFresh=complete&&!Object.keys(next.errors||{}).length;inventoryError='';if(inventoryFresh)lastSuccessfulRefresh=date(new Date());
        if(!data.pools[pool]){pool=Object.keys(data.pools)[0]||'';selection=pool;}
        if(pool&&!selected())selection=pool;
        const changedTarget=previousPool!==pool||previousSelection!==selection;if(changedTarget||!selectionIdentity)selectionIdentity=selectionFingerprint();else if(selectionIdentity!==selectionFingerprint())selectionChanged=true;
        if(changedTarget&&activeForm)setStatus('The selected object disappeared; its operation form has been closed.',true);
        renderPools();
        if(section==='datasets'){
            if(changedTarget||!pool||!browserHost)renderSection();else{renderBrowser();updateHeading();if(tab==='snapshots')renderSnapshots();else if(tab==='files'){renderFiles(detailBody,selected());}else if(tab==='devices'){renderCurrentPoolTab();}else if(!activeForm&&['overview','details'].includes(tab)){detailBody.replaceChildren();const item=selected();if(item)(tab==='details'?renderDatasetInformation:renderOverview)(detailBody,item);}else if(!activeForm&&tab==='actions'){detailBody.replaceChildren();renderActions(detailBody,selected());}}
        }else if(section==='overview')renderSection();else if(section==='create'&&(!activeForm||previousPool!==pool))renderSection();
        if(activeForm)forms.render(activeForm.host,activeForm.action,activeForm.context);
        if(complete)cacheInventory();if(newCycle)loadDiagnostics();
    }
    function inventoryStatus(message,error){
        setStatus(error?'Stale data — last successful refresh '+(lastSuccessfulRefresh||'unknown')+'. '+message:message,error);
        if(error||message.startsWith('Reading ZFS')){
            inventoryFresh=false;inventoryError=message;
            for(const name of Object.keys(data&&data.pools||{})){const previous=diagnostics.get(name)||{};diagnostics.set(name,Object.assign({},previous,{pool:name,severity:knownDiagnosticError(previous)?'error':'unknown',stale:true,reasons:[...new Set([...(previous.reasons||[]),'Inventory refresh failed; retained diagnostics may be stale.'])]}));}
            renderPools();renderBrowser();if(section==='overview')renderSection();
            if(section==='datasets'&&detailBody){if(tab==='snapshots')renderSnapshots();else if(tab==='files'){renderFiles(detailBody,selected());}else if(['status','information'].includes(tab))renderCurrentPoolTab();else if(tab==='devices'){renderCurrentPoolTab();}else if(['overview','details','actions'].includes(tab)&&!activeForm){detailBody.replaceChildren();const item=selected();if(item)(tab==='details'?renderDatasetInformation:tab==='actions'?renderActions:renderOverview)(detailBody,item);}}
            if(activeForm)forms.render(activeForm.host,activeForm.action,activeForm.context);
        }
    }
    const inventory=createZFSMInventoryController({url:options.url,csrf:options.csrf,config,request,status:inventoryStatus,spinner:active=>{refreshButton.disabled=active;refreshButton.setAttribute('aria-busy',String(active));refreshButton.title=active?'Refreshing…':'Refresh';},configChanged:next=>{config=next;},render:applyInventory});
    const query=new URLSearchParams(window.location.search);
    if(['overview','datasets','protection','replication','jobs','history','settings','create'].includes(query.get('section')))section=query.get('section');
    if(query.get('pool'))pool=query.get('pool');if(query.get('dataset'))selection=query.get('dataset');if(query.get('tab')==='snapshots')tab=datasetTab='snapshots';
    if(query.get('tab')==='pool-status')tab='status';
    renderSection();loadJobs();
    if(Number(config.refresh_interval)===0){const cached=storageRead(cacheKey);if(cached&&cached.data&&cached.data.pools&&cached.data.datasets&&cached.data.devices){data=cached.data;inventoryFresh=false;if(!data.pools[pool])pool=Object.keys(data.pools)[0]||'';if(!selected())selection=pool;selectionIdentity=selectionFingerprint();renderPools();renderSection();}}
    inventory.refresh();
    if(protection)protection.availability().catch(()=>{protectionButton.hidden=true;replicationButton.hidden=true;});
    return {refresh:()=>inventory.refresh(),stop:()=>{if(stopped)return;stopped=true;protection?.stop();inventory.stop();clearTimeout(jobsTimer);clearTimeout(diagnosticTimer);invalidateForm();disposeSnapshots();disposeExplorer();themeObserver.disconnect();media.removeEventListener('change',themeListener);for(const controller of controllers)controller.abort();controllers.clear();},getState:()=>({section,tab,pool,selection,layout,theme})};
}
