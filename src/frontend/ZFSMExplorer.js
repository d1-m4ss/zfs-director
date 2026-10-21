/* ZFS Director vector branding added on 2026-10-16; GPL-2.0-or-later. */
/* Snapshot files stay read-only. Restores use explicit previews and worker jobs. */
(function(global){
 'use strict';
 function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;return n;}
 const documentPath='M5 3h9l5 5v13H5Z M14 3v5h5 ';
 const drawings={
  director:'M3 7a6 2.5 0 1 0 12 0 6 2.5 0 1 0-12 0 M3 7v6c0 3.3 12 3.3 12 0V7 M3 13v6c0 3.3 12 3.3 12 0v-6 M14 3h7v7 M21 3l-8 8',
  pool:'M4 6a8 3 0 1 0 16 0 8 3 0 1 0-16 0 M4 6v6c0 4 16 4 16 0V6 M4 12v6c0 4 16 4 16 0v-6',
  dataset:'M3 6h7l2 3h9v11H3Z M13 13h5v4h-5Z',
  folder:'M3 6h7l2 3h9v11H3Z',
  clone:'M3 4h12v4H7v9H3Z M7 8h7l2 3h5v10H7Z',
  volume:'M4 3h16v7H4Z M4 14h16v7H4Z M7 6h1 M7 17h1 M12 6h5 M12 17h5',
  snapshot:'M3 6h7l2 3h8v3 M3 6v14h8 M16 12a5 5 0 1 0 0 10 5 5 0 1 0 0-10 M16 14v3l2 1',
  lock:'M6 10h12v11H6Z M8 10V7a4 4 0 0 1 8 0v3 M12 14v3',
  file:documentPath,
  text:documentPath+'M8 12h8 M8 15h8 M8 18h5',
  code:documentPath+'M10 12l-2 3 2 3 M14 12l2 3-2 3',
  pdf:documentPath+'M8 18v-6h3v3H8 M14 12v6 M14 12h2 M14 15h2',
  image:'M3 3h18v18H3Z M3 17l6-6 5 5 3-3 4 4 M15 7h2v2h-2Z',
  video:'M3 5h13v14H3Z M16 10l5-3v10l-5-3 M8 9l4 3-4 3Z',
  audio:documentPath+'M14 11v6 M14 11l3-1 M11 17a2 2 0 1 0 4 0 2 2 0 1 0-4 0',
  archive:documentPath+'M10 9h2 M12 11h2 M10 13h2 M12 15h2 M10 17h4v2h-4Z',
  link:'M10 13a5 5 0 0 0 7.54 .54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  unavailable:'M4 4h16v16H4Z M4 20 20 4',
  download:'M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4',
  restore:'M4 10a8 8 0 1 1 0 7 M4 4v6h6 M12 7v6l4 2',
  eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0',
  refresh:'M20 9a8 8 0 1 0 0 7 M20 3v6h-6',up:'M12 21V4 M5 11l7-7 7 7',back:'M20 12H4 M11 5l-7 7 7 7',
  'chevron-left':'M15 5l-7 7 7 7','chevron-right':'M9 5l7 7-7 7','chevron-down':'M5 9l7 7 7-7',
  check:'M4 4h16v16H4Z M7 12l3 3 7-7',clear:'M5 5h14v14H5Z M9 9l6 6 M15 9l-6 6',close:'M6 6l12 12 M18 6 6 18',
  details:'M5 3h14v18H5Z M8 7h8 M8 11h8 M8 15h4',space:'M12 3a9 9 0 1 0 9 9 M12 3v9h9 M16 3v5h5',
  shield:'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z M8 12l3 3 5-6',users:'M8 3a3 3 0 1 0 0 6 3 3 0 1 0 0-6 M3 20v-5a5 5 0 0 1 10 0v5 M16 4a3 3 0 0 1 0 6 M17 13a4 4 0 0 1 4 4v3'
 };
 function icon(kind){kind=Object.hasOwn(drawings,kind)?kind:'file';const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),p=document.createElementNS(svg.namespaceURI,'path');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');svg.setAttribute('class','zfsm-icon');svg.dataset.icon=kind;p.setAttribute('d',drawings[kind]);svg.append(p);return svg;}
 function fileIcon(entry){
  if(entry.type==='directory')return icon('folder');if(entry.type==='symlink')return icon('link');if(entry.type!=='file')return icon('unavailable');
  const extension=String(entry.name||'').split('.').pop().toLowerCase();
  for(const [kind,extensions]of [['image',['jpg','jpeg','png','gif','webp','avif','heic','svg','tiff','bmp']],['video',['mp4','mkv','mov','webm','avi','m4v']],['audio',['mp3','flac','wav','aac','ogg','m4a']],['archive',['zip','gz','bz2','xz','zst','tar','7z','rar']],['pdf',['pdf']],['code',['json','yaml','yml','xml','html','css','js','ts','php','py','sh','sql','toml']],['text',['txt','md','log','csv','ini','conf']]])if(extensions.includes(extension))return icon(kind);
  return icon('file');
 }
 function button(label,run,kind,help,visibleLabel){const b=el('button',kind?undefined:label,kind?'zfsm-action-icon-button':'');b.type='button';b.setAttribute('aria-label',label);b.title=help?label+' — '+help:label;if(help)b.setAttribute('aria-description',help);if(kind){b.append(icon(kind));if(visibleLabel){b.append(el('span',visibleLabel));b.classList.add('zfsm-action-label-button');}}b.addEventListener('click',run);return b;}
 function bytes(value){const n=Number(value)||0;const u=['B','KiB','MiB','GiB','TiB'],p=n>0?Math.min(4,Math.floor(Math.log(n)/Math.log(1024))):0;return (n/1024**p).toLocaleString(undefined,{maximumFractionDigits:1})+' '+u[p];}
 function create(options){
  const host=options.host,snapshot=options.snapshot,events=new AbortController(),chosen=new Map();
  let path='',hidden=false,offset=0,total=0,disposed=false,generation=0,timer=null,ready=false,guid=options.snapshotGuid||null,restoreAllowed=false,preview=null,formGeneration=0,formBusy=false,available=true,selectionOpen=false;
  const unavailableMessage='Snapshot inventory is unavailable or the snapshot disappeared. Refresh before restoring.';
  host.replaceChildren();host.classList.add('zfsm-explorer');host.tabIndex=-1;
  const top=el('header',undefined,'zfsm-explorer-header'),heading=el('h3','Snapshot File Manager'),identity=el('p',snapshot,'zfsm-muted'),notice=el('p','Read-only snapshot · Select files to download or restore.','zfsm-muted'),title=el('div');
  const close=button('Close File Manager',options.onClose,'close',undefined,'Close');heading.prepend(icon('snapshot'));title.append(heading,identity,notice);top.append(title,close);host.append(top);
  const jobStatus=el('section',undefined,'zfsm-explorer-jobs'),jobLine=el('div',undefined,'zfsm-explorer-job-summary'),jobMessage=el('span'),jobProgress=el('progress'),jobAlert=button('Operation errors',()=>{jobDetails.open=true;syncContent();markErrorsViewed();},undefined,undefined,'');
  const jobDetails=el('details'),jobToggle=el('summary','Details'),jobList=el('div',undefined,'zfsm-explorer-job-list'),viewedErrors=new Set();let downloadJob=null,downloadBusy=false;
  const jobAlertMessage=el('span');jobAlert.replaceChildren(jobAlertMessage);jobMessage.setAttribute('role','status');jobMessage.setAttribute('aria-live','polite');jobProgress.max=100;jobProgress.setAttribute('aria-label','Operation progress');jobAlert.className='zfsm-error';jobAlert.hidden=true;
  const downloadZip=button('Download ZIP',async()=>{if(downloadBusy||!downloadJob)return;const id=downloadJob.id;downloadBusy=true;downloadZip.disabled=true;try{await options.download({cmd:'downloadsnapshotarchive',job_id:id},text=>status(text,true));if(!disposed)status('Download requested. Transfer progress appears in Jobs; check browser Downloads for the saved file.');}catch(error){if(!disposed)status(error.message,true);}finally{downloadBusy=false;downloadZip.disabled=false;}},'download','The browser saves the ready ZIP. Temporary ZIPs expire after one hour.','Download');
  jobDetails.append(jobToggle);jobDetails.addEventListener('toggle',()=>{syncContent();if(jobDetails.open)markErrorsViewed();},{signal:events.signal});jobLine.append(jobMessage,jobProgress,downloadZip,jobAlert,jobDetails);jobStatus.append(jobLine);jobStatus.hidden=true;host.append(jobStatus);
  const bar=el('div',undefined,'zfsm-explorer-toolbar'),crumbs=el('nav',undefined,'zfsm-explorer-path');crumbs.setAttribute('aria-label','Snapshot path');
  const filter=el('input');filter.type='search';filter.placeholder='Filter names…';filter.setAttribute('aria-label','Filter names');filter.autocomplete='off';
  const sort=el('select');sort.setAttribute('aria-label','Sort files');for(const [value,label]of[['name:asc','Name A–Z'],['name:desc','Name Z–A'],['size:desc','Largest first'],['size:asc','Smallest first'],['mtime:desc','Newest first'],['mtime:asc','Oldest first']]){const o=el('option',label);o.value=value;sort.append(o);}
  const kind=el('select');kind.setAttribute('aria-label','File types');for(const [value,label]of[['all','All types'],['file','Files only'],['directory','Folders only']]){const o=el('option',label);o.value=value;kind.append(o);}
  const showHidden=button('Show hidden files',()=>{hidden=!hidden;showHidden.setAttribute('aria-pressed',String(hidden));offset=0;load();},'eye','Show files and folders whose names start with a dot. Off by default.');showHidden.setAttribute('aria-pressed','false');
  const up=button('Parent folder',()=>go(path.split('/').slice(0,-1).join('/')),'up'),refresh=button('Refresh files',()=>load(),'refresh');
  bar.append(up,filter,kind,sort,showHidden,refresh);host.append(crumbs,jobStatus,bar);identity.title=snapshot;
  const result=el('div',undefined,'zfsm-explorer-status');result.setAttribute('role','status');
  const wrap=el('div',undefined,'zfsm-explorer-list'),table=el('table',undefined,'zfsm-table zfsm-file-table'),head=el('thead'),header=el('tr'),body=el('tbody');
  for(const name of ['Select','Name','Size','Modified','Actions']){const th=el('th',name);th.scope='col';header.append(th);}head.append(header);table.append(head,body);wrap.append(table);
  const footer=el('div',undefined,'zfsm-explorer-controls'),selectionBar=el('div',undefined,'zfsm-buttons zfsm-explorer-selection'),paginationBar=el('div',undefined,'zfsm-buttons zfsm-explorer-pagination'),count=button('Review selected files',openSelection,'details','See and remove selected paths across all folders and pages.','Selected: 0'),selectionContext=el('small',undefined,'zfsm-explorer-selection-context'),previous=button('Previous page',()=>{offset=Math.max(0,offset-200);load();},'chevron-left',undefined,'Previous'),next=button('Next page',()=>{offset+=200;load();},'chevron-right',undefined,'Next'),pageCount=el('span',undefined,'zfsm-muted'),all=button('Select page',()=>{for(const row of currentEntries)if(row.available)chosen.set(row.path,row);syncSelection();},'check',undefined,'Select page'),clear=button('Clear selection',()=>{chosen.clear();syncSelection();},'clear',undefined,'Clear selection');
  const restore=button('Restore selected',openRestore,'restore','Recover selected files or folders. Hidden descendants are included when a folder is selected.','Restore files');
  const archive=button('Download selected as ZIP',()=>queueArchive([...chosen.keys()]),'archive','Prepare a ZIP with maximum Deflate compression in the background. Selected folders include hidden contents. Temporary ZIP files expire after one hour.','Prepare ZIP');
  const bulk=el('div',undefined,'zfsm-buttons zfsm-explorer-bulk');selectionBar.append(all,clear,count,selectionContext);bulk.append(restore,archive);paginationBar.append(previous,pageCount,next);footer.append(selectionBar,paginationBar,bulk);footer.setAttribute('aria-label','File selection and pagination');const form=el('div',undefined,'zfsm-explorer-restore'),content=el('div',undefined,'zfsm-explorer-body'),selectionReview=el('section',undefined,'zfsm-explorer-selection-review');jobList.hidden=true;selectionReview.hidden=true;selectionReview.setAttribute('aria-label','Selected paths');content.append(jobList,selectionReview,form,wrap);host.append(result,footer,content,el('footer','Selection persists across folders and pages · Restores require a separate preview and confirmation.','zfsm-explorer-footer'));
  const trackedJobs=new Map(),downloading=new Set();let jobFingerprint='',archiveBusy=false;
  let currentEntries=[];
  function status(text,error=false,success=false){result.className=error?'zfsm-error':success?'zfsm-success':'zfsm-explorer-status';result.textContent=(error?'⚠ ':success?'✓ ':'')+text;result.setAttribute('role',error?'alert':'status');}
  function invalidatePreview(){preview=null;formGeneration++;form.querySelector('.zfsm-restore-review')?.remove();}
  function syncAvailability(){
   const usable=ready&&available;
   restore.disabled=!usable||!chosen.size||!restoreAllowed||formBusy||Number(options.getConfig().destructive_mode)!==1;
   archive.disabled=archiveBusy||!usable||!chosen.size||!restoreAllowed;
   all.disabled=!usable||!currentEntries.some(entry=>entry.available);clear.disabled=!chosen.size||formBusy;
   count.disabled=!chosen.size||formBusy;
   previous.disabled=!usable||offset===0;next.disabled=!usable||offset+200>=total;body.inert=!usable;
   for(const row of body.querySelectorAll('tr[data-entry]')){
    const entry=currentEntries.find(entry=>entry.path===row.dataset.entry),select=row.querySelector('input[type=checkbox]');
    if(select)select.disabled=!usable||!entry?.available||formBusy;
    for(const action of row.querySelectorAll('button'))action.disabled=!usable||!entry?.available||downloading.has(entry.path)||(action.dataset.archive!==undefined&&(archiveBusy||!restoreAllowed));
   }
   for(const action of form.querySelectorAll('button,input,select'))action.disabled=!usable||formBusy;
   const start=form.querySelector('[data-start-restore]'),confirmation=form.querySelector('.zfsm-restore-review input[type=checkbox]');
   if(start)start.disabled=!usable||formBusy||!preview||!confirmation?.checked;
  }
  function syncSelection(){
   for(const check of body.querySelectorAll('input[type=checkbox]'))check.checked=chosen.has(check.dataset.path);
   const folders=[...chosen.values()].filter(entry=>entry.type==='directory').length,files=chosen.size-folders,outside=[...chosen.keys()].filter(selected=>!currentEntries.some(entry=>entry.path===selected)).length;
   count.querySelector('span').textContent='Selected: '+chosen.size+(chosen.size?' '+(folders&&files?'items':folders?'folder'+(folders===1?'':'s'):'file'+(files===1?'':'s')):'');
   selectionContext.textContent=chosen.size?['Across all folders and pages',outside?outside+' outside this view':'',folders&&files?files+' files · '+folders+' folders':''].filter(Boolean).join(' · '):'';selectionContext.hidden=!chosen.size;
   archive.querySelector('span').textContent='Prepare ZIP'+(chosen.size?' ('+chosen.size+')':'');archive.title='Archive all '+chosen.size+' selected paths across folders and pages. Use Review selected files to inspect the selection.';
   if(selectionOpen)renderSelectionReview();invalidatePreview();syncAvailability();
  }
  function entryIdentity(entry){return JSON.stringify([entry.type,entry.size,entry.mtime,entry.dev??null,entry.ino??null]);}
  function reconcileSelection(entries){
   const visible=new Map(entries.map(entry=>[entry.path,entry]));let removed=0;
   for(const [selectedPath,old]of chosen){
    const fresh=visible.get(selectedPath),parent=selectedPath.includes('/')?selectedPath.slice(0,selectedPath.lastIndexOf('/')):'';
    const covered=offset===0&&total<=200&&parent===path&&(kind.value==='all'||old.type===kind.value)&&(hidden||!old.name.startsWith('.'))&&old.name.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase());
    if(fresh?(!fresh.available||entryIdentity(fresh)!==entryIdentity(old)):covered){chosen.delete(selectedPath);removed++;}
   }
   return removed;
  }
  function breadcrumbs(){crumbs.replaceChildren(button('Snapshot root',()=>go(''),'snapshot',undefined,'Snapshot root'));let p='';for(const part of path.split('/').filter(Boolean)){p+=(p?'/':'')+part;const dest=p;crumbs.append(el('span','/'),button(part,()=>go(dest),'folder',undefined,part));}up.disabled=!path;}
  function syncContent(){const reviewing=Boolean(form.childElementCount);jobList.hidden=!jobDetails.open;selectionReview.hidden=!selectionOpen||jobDetails.open||reviewing;form.hidden=jobDetails.open||selectionOpen;wrap.hidden=reviewing||jobDetails.open||selectionOpen;bar.hidden=reviewing;footer.hidden=reviewing;}
  function closeRestore(){invalidatePreview();form.replaceChildren();syncContent();content.scrollTop=0;}
  function openSelection(){if(!chosen.size||formBusy)return;closeRestore();jobDetails.open=false;selectionOpen=true;renderSelectionReview();syncContent();content.scrollTop=0;}
  function renderSelectionReview(){selectionReview.replaceChildren(el('h4','Selected across all folders and pages'),button('Back to files',()=>{selectionOpen=false;syncContent();count.focus({preventScroll:true});}));const list=el('ul');for(const [selected,entry]of chosen){const row=el('li'),name=el('span',selected),remove=button('Remove selected '+selected,()=>{chosen.delete(selected);syncSelection();selectionReview.querySelector('button')?.focus({preventScroll:true});},'clear',undefined,'Remove');name.prepend(icon(entry.type==='directory'?'folder':'file'));row.append(name,remove);list.append(row);}selectionReview.append(chosen.size?list:el('p','Nothing selected.'));}
  function go(nextPath){if(formBusy||!ready||!available)return;path=nextPath;offset=0;filter.value='';selectionOpen=false;closeRestore();filter.focus({preventScroll:true});load();}
  async function checked(fields){const answer=await options.request({...fields,...(fields.snapshot?{snapshot_guid:guid||''}:{})});if(answer.failed&&Object.keys(answer.failed).length)throw Error(Object.values(answer.failed).join('; '));return answer;}
  async function load(){
   if(disposed)return;jobDetails.open=false;selectionOpen=false;syncContent();const mine=++generation;ready=false;refresh.disabled=true;invalidatePreview();syncAvailability();status('Loading files…');breadcrumbs();
   const [key,direction]=sort.value.split(':');
   try{
    const answer=await checked({cmd:'snapshotfiles',snapshot,path,filter:filter.value,kind:kind.value,sort:key,direction,offset:String(offset),hidden:hidden?'1':'0'});
    if(disposed||mine!==generation)return;
    if(answer.snapshot!==snapshot||answer.path!==path||!Array.isArray(answer.entries)||typeof answer.snapshot_guid!=='string'||!answer.snapshot_guid||!Number.isSafeInteger(answer.total)||answer.total<0||answer.entries.length>200||answer.entries.some(entry=>!entry||typeof entry.name!=='string'||typeof entry.path!=='string'||!['file','directory','symlink','special','other'].includes(entry.type)||typeof entry.available!=='boolean'||!Number.isFinite(entry.size)||!Number.isFinite(entry.mtime)))throw Error('Invalid snapshot file response');
    if(guid&&guid!==answer.snapshot_guid){chosen.clear();syncSelection();throw Error('This snapshot was replaced. Close the explorer and reopen it.');}
    guid=answer.snapshot_guid;restoreAllowed=answer.restore_available===true;currentEntries=answer.entries;total=answer.total;if(offset>0&&offset>=total){offset=0;await load();return;}const removed=reconcileSelection(currentEntries);
    body.replaceChildren();for(const entry of currentEntries){
     const row=el('tr');row.dataset.entry=entry.path;const select=el('td'),check=el('input');check.type='checkbox';check.dataset.path=entry.path;check.setAttribute('aria-label','Select '+entry.name);check.disabled=!entry.available;check.addEventListener('change',()=>{if(!ready||!available||formBusy)return;check.checked?chosen.set(entry.path,entry):chosen.delete(entry.path);syncSelection();});select.append(check);
     const name=el('td'),label=entry.type==='directory'?button('Open '+entry.name,()=>go(entry.path)):el('span');label.replaceChildren(fileIcon(entry),el('span',entry.name));label.classList.add('zfsm-file-name');if(entry.type==='directory')label.disabled=!entry.available;name.append(label);if(!entry.available)name.append(el('small',entry.type==='symlink'?'Symbolic link · not followed':'Unavailable or unsupported','zfsm-muted'));
     const size=el('td',entry.type==='directory'?'Folder':bytes(entry.size)),date=el('td',global.zfsmFormatDateTime(entry.mtime)),download=el('td');size.dataset.label='Size';date.dataset.label='Modified';
     if(entry.available&&['file','directory'].includes(entry.type)){
      const directory=entry.type==='directory',action=button((directory?'Prepare ZIP ':'Download file ')+entry.name,()=>directory?queueArchive([entry.path]):downloadFile(entry),directory?'archive':'download',directory?'Prepare this folder as a ZIP in the background. Temporary writable space is required.':'Download this saved file directly without a ZIP job.',directory?'ZIP':'Download');
      if(directory)action.dataset.archive='';download.append(action);
     }
     row.append(select,name,size,date,download);body.append(row);
    }
    ready=true;pageCount.textContent='Page '+(Math.floor(offset/200)+1)+' / '+Math.max(1,Math.ceil(total/200))+' · Items '+(total?(offset+1)+'–'+Math.min(offset+200,total)+' of '+total:'0 of 0');
    status(removed?removed+' changed or missing item(s) removed from selection. Review the selection before continuing.':total?'':'No matching files in this folder.');syncSelection();
   }catch(error){if(!disposed&&mine===generation){status(error.message,true);currentEntries=[];body.replaceChildren();syncAvailability();}}
   finally{if(!disposed&&mine===generation){refresh.disabled=false;syncAvailability();}}
  }
  async function downloadFile(entry){
   if(disposed||!ready||!available||downloading.has(entry.path))return;
   const mine=generation,expectedGuid=guid;downloading.add(entry.path);syncAvailability();
   try{
    const info=await checked({cmd:'snapshotfileinfo',snapshot,path:entry.path});
    if(disposed||!ready||!available||mine!==generation||expectedGuid!==guid)return;
    if(info.ready!==true||!Number.isSafeInteger(info.size)||info.size!==entry.size)throw Error('The file changed or is unavailable. Refresh files before downloading.');
    await options.download({cmd:'downloadsnapshotfile',snapshot,snapshot_guid:expectedGuid,path:entry.path},message=>{if(!disposed)status(message,true);});
    if(!disposed)status('Download requested. Transfer progress appears in Jobs; check browser Downloads for the saved file.');
   }catch(error){if(!disposed)status(error.message,true);}
   finally{downloading.delete(entry.path);if(!disposed)syncAvailability();}
  }
  async function queueArchive(selection){
   if(archiveBusy||!selection.length||!ready||!available||!restoreAllowed)return;archiveBusy=true;syncAvailability();
   try{const result=await checked({cmd:'archivesnapshotfiles',snapshot,selection});if(disposed)return;trackedJobs.set(result.job.id,result.job);renderJobStatus();status(result.worker_warning||'ZIP preparation queued. Progress appears above.',Boolean(result.worker_warning));}
   catch(error){if(!disposed)status(error.message,true);}
   finally{archiveBusy=false;if(!disposed)syncAvailability();}
  }
  function updateJobs(jobs){if(disposed)return;for(const job of jobs)if(job.snapshot===snapshot&&['restore','archive','download'].includes(job.type))trackedJobs.set(job.id,job);renderJobStatus();}
  function needsAttention(job){return !['queued','running','completed','cancelled'].includes(job.state);}
  function errorKey(job){return JSON.stringify([job.id,job.state,job.error]);}
  function markErrorsViewed(){for(const job of trackedJobs.values())if(needsAttention(job))viewedErrors.add(errorKey(job));jobAlert.hidden=true;jobAlertMessage.removeAttribute('role');}
  function jobLabel(job){const type=job.type==='archive'?'ZIP':job.type==='download'?'Download':'Restore',percent=typeof job.progress?.percent==='number'&&Number.isFinite(job.progress.percent)?Math.max(0,Math.min(100,job.progress.percent)):null,state={queued:'Queued',running:'Running'+(percent===null?'':' · '+percent+'%'),completed:'Completed',failed:'Failed',recovery_required:'Recovery required',cancelled:'Cancelled'}[job.state]||'Recovery required';return type+' · '+(job.type==='archive'&&job.state==='completed'&&(job.archive_removed||Number(job.expires)*1000<=Date.now())?'Expired — prepare again':state);}
  function renderJobStatus(){
   const jobs=[...trackedJobs.values()].sort((a,b)=>b.id.localeCompare(a.id)),fingerprint=JSON.stringify(jobs.map(job=>({...job,expired:job.type==='archive'&&Number(job.expires)*1000<=Date.now()})));if(fingerprint===jobFingerprint)return;jobFingerprint=fingerprint;jobStatus.hidden=!jobs.length;if(!jobs.length)return;
   const latest=jobs[0],label=jobLabel(latest),active=['queued','running'].includes(latest.state),unseen=jobs.filter(job=>needsAttention(job)&&!viewedErrors.has(errorKey(job)));
   if(jobMessage.textContent!==label)jobMessage.textContent=label;jobMessage.className=needsAttention(latest)?'zfsm-error':latest.state==='completed'?'zfsm-success':'';
   jobProgress.hidden=!active;if(typeof latest.progress?.percent==='number'&&Number.isFinite(latest.progress.percent))jobProgress.value=Math.max(0,Math.min(100,latest.progress.percent));else jobProgress.removeAttribute('value');
   downloadJob=jobs.find(job=>job.type==='archive'&&job.state==='completed'&&!job.archive_removed&&Number(job.expires)*1000>Date.now())||null;downloadZip.hidden=!downloadJob;downloadZip.disabled=downloadBusy;downloadZip.title=downloadJob?'Download ZIP '+downloadJob.id:'';
   jobToggle.textContent='Details'+(jobs.length>1?' (+'+(jobs.length-1)+')':'');jobAlertMessage.textContent=unseen.length+' operation'+(unseen.length===1?' needs':'s need')+' attention';jobAlert.hidden=!unseen.length||jobDetails.open;if(jobAlert.hidden)jobAlertMessage.removeAttribute('role');else jobAlertMessage.setAttribute('role','alert');
   const focused=jobList.contains(document.activeElement)?{id:document.activeElement.closest('[data-job-id]')?.dataset.jobId,action:document.activeElement.dataset.jobAction}:null;jobList.replaceChildren();
   for(const job of jobs){
    const zip=job.type==='archive',complete=job.state==='completed',expired=zip&&(job.archive_removed||Number(job.expires)*1000<=Date.now());
    const card=el('div',undefined,'zfsm-explorer-job');card.dataset.jobId=job.id;card.append(el('strong',jobLabel(job)),el('small',job.id,'zfsm-muted'));
    if(job.error)card.append(el('p',job.error,'zfsm-error'));
    if(job.type==='download'&&job.result?.summary)card.append(el('p',job.result.summary,'zfsm-muted'));
    if(complete&&!expired&&zip&&job.id!==downloadJob?.id){const download=button('Download ZIP '+job.id,async()=>{try{await options.download({cmd:'downloadsnapshotarchive',job_id:job.id},text=>status(text,true));}catch(error){if(!disposed)status(error.message,true);}},'download',undefined,'Download');download.dataset.jobAction='download';card.append(download);}
    if(!zip&&job.target)card.append(el('p',job.target,'zfsm-muted'));
    const view=button('View job',()=>options.onJobs());view.dataset.jobAction='view';card.append(view);jobList.append(card);
   }
   syncContent();if(jobDetails.open)markErrorsViewed();if(focused)for(const action of jobList.querySelectorAll('button'))if(action.closest('[data-job-id]').dataset.jobId===focused.id&&action.dataset.jobAction===focused.action){action.focus({preventScroll:true});break;}
  }
  function openRestore(){
   if(restore.disabled)return;invalidatePreview();form.replaceChildren();selectionOpen=false;wrap.hidden=true;bar.hidden=true;footer.hidden=true;jobDetails.open=false;content.scrollTop=0;
   const title=el('h4','Restore selected files'),grid=el('div',undefined,'zfsm-explorer-restore-fields'),modeLabel=el('label','Restore destination'),mode=el('select'),targetLabel=el('label','New folder name'),target=el('input');
   mode.setAttribute('aria-label','Restore destination');for(const [value,label]of[['new','New folder (recommended)'],['overwrite','Original location / existing folder']]){const o=el('option',label);o.value=value;mode.append(o);}target.value='restored-'+new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');target.setAttribute('aria-label','Restore folder');modeLabel.append(mode);targetLabel.append(target);grid.append(modeLabel,targetLabel);
   const hint=el('p','A selected folder includes all its contents, including hidden files. Links and special files cannot be restored.','zfsm-muted'),review=button('Review restore',async()=>{
    if(formBusy||!ready||!available)return;invalidatePreview();const mine=formGeneration;formBusy=true;syncAvailability();
    try{
     const selected=[...chosen.keys()];if(!selected.length)throw Error('Select files or folders first');
     const answer=await checked({cmd:'previewrestore',snapshot,selection:selected,target:target.value,mode:mode.value});
     if(disposed||mine!==formGeneration)return;preview=answer;renderReview(answer);
    }catch(error){if(!disposed&&mine===formGeneration)status(error.message,true);}
    finally{formBusy=false;if(!disposed)syncAvailability();}
   });
   const cancel=button('Close restore form',()=>{if(formBusy)return;closeRestore();restore.focus({preventScroll:true});});
   mode.addEventListener('change',()=>{target.value=mode.value==='new'?'restored-'+new Date().toISOString().slice(0,10):'';targetLabel.firstChild.textContent=mode.value==='new'?'New folder name':'Folder inside this dataset (blank = original root)';invalidatePreview();});target.addEventListener('input',invalidatePreview);
   form.append(title,grid,hint,review,cancel);syncContent();
  }
  function renderReview(answer){
   const panel=el('section',undefined,'zfsm-restore-review zfsm-preview');panel.append(el('h4','Review restore'),el('p',answer.files+' files · '+bytes(answer.bytes)),el('p','Destination: '+answer.target));
   const selected=el('ul');for(const path of answer.selection)selected.append(el('li',path));panel.append(el('strong','Selected paths'),selected);
   if(answer.conflicts.length){panel.append(el('p','These current files will be replaced. Their previous contents will be retained in this job’s recovery folder.','zfsm-notice'));const conflicts=el('ul');conflicts.className='zfsm-conflicts';for(const path of answer.conflicts)conflicts.append(el('li',path));panel.append(conflicts);}else panel.append(el('p','No current files will be replaced.','zfsm-notice'));
   panel.append(el('p','Stop applications writing to these paths before starting. The snapshot is protected while copying; other current files are kept.','zfsm-muted'));
   const label=el('label',undefined,'zfsm-checkbox'),confirm=el('input');confirm.type='checkbox';label.append(confirm,el('span','I confirm this selection and destination'+(answer.conflicts.length?' and the listed replacements.':'.')));
   const start=button('Start restore',async()=>{
    if(!confirm.checked||preview!==answer||formBusy||!ready||!available)return;formBusy=true;syncAvailability();
    try{const result=await checked({cmd:'restoresnapshotfiles',preview_id:answer.id,preview_token:answer.token,confirmed:'1'});if(disposed)return;
     closeRestore();chosen.clear();syncSelection();trackedJobs.set(result.job.id,{...result.job,type:'restore'});renderJobStatus();status('Restore queued. Track progress above or in Jobs.');if(result.worker_warning)status(result.worker_warning,true);
    }catch(error){if(!disposed){invalidatePreview();status(error.message+' Review again before retrying.',true);}}
    finally{formBusy=false;if(!disposed)syncAvailability();}
   });start.dataset.startRestore='';start.disabled=true;confirm.addEventListener('change',()=>{syncAvailability();});panel.append(label,start);form.append(panel);
  }
  filter.addEventListener('input',()=>{clearTimeout(timer);offset=0;generation++;ready=false;invalidatePreview();syncAvailability();timer=setTimeout(load,160);},{signal:events.signal});
  sort.addEventListener('change',()=>{offset=0;load();},{signal:events.signal});
  kind.addEventListener('change',()=>{offset=0;load();},{signal:events.signal});
  host.addEventListener('keydown',event=>{
   if(event.key==='Escape'&&filter.value){event.preventDefault();filter.value='';offset=0;load();return;}
   if(event.ctrlKey||event.metaKey||event.altKey||event.key.length!==1||event.target.closest('input,select,textarea')||(event.key===' '&&event.target.closest('button'))||form.contains(event.target))return;
   event.preventDefault();filter.focus({preventScroll:true});filter.value+=event.key;filter.dispatchEvent(new Event('input'));
  },{signal:events.signal});
  filter.focus({preventScroll:true});load();return {updateJobs,dispose(){disposed=true;generation++;formGeneration++;clearTimeout(timer);events.abort();},setAvailable(value){available=value;syncAvailability();if(!value){invalidatePreview();status(unavailableMessage,true);}else if(result.textContent==='⚠ '+unavailableMessage)status('');},getState(){return {path,hidden,filter:filter.value,selection:[...chosen.keys()]};}};
 }
 global.zfsmCreateIcon=icon;global.zfsmCreateFileIcon=fileIcon;global.zfsmCreateSnapshotExplorer=create;
})(window);
