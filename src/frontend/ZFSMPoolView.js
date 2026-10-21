/* Command output is never executable markup. Mutations use workspace callbacks. */
function zfsmCanStartScrub(diagnostic) {
    return Boolean(diagnostic&&!diagnostic.stale&&['ok','warning','error'].includes(diagnostic.severity)&&['ONLINE','DEGRADED'].includes(diagnostic.health)&&diagnostic.scan&&diagnostic.scan.kind!=='error scrub'&&['idle','finished','canceled','paused'].includes(diagnostic.scan.state));
}

function zfsmRenderScrub(container, diagnostic, options) {
    function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;return n;}
    const scan=diagnostic.scan||{state:'unknown'},panel=node('section',undefined,'zfsm-scrub');panel.setAttribute('aria-label','Pool scrub');
    const labels={idle:'No scrub requested',running:'Scrub in progress',paused:'Scrub paused',finished:'Last scan completed',canceled:'Last scan canceled',resilvering:'Resilver in progress',unknown:'Scan status unavailable'};
    panel.append(node('h3','Scrub · '+(labels[scan.state]||labels.unknown)));
    if(['running','paused','resilvering'].includes(scan.state)){
        const progress=node('progress');progress.max=100;progress.setAttribute('aria-label','Scrub progress');
        const known=typeof scan.percent==='number'&&Number.isFinite(scan.percent)&&scan.percent>=0;
        if(known&&!diagnostic.stale)progress.value=Math.min(scan.percent,100);
        progress.setAttribute('aria-valuetext',diagnostic.stale?'Last reported progress is stale':known?scan.percent+'%':'Progress not yet available');
        panel.append(progress,node('p',diagnostic.stale?'Last reported progress is stale. Refresh to confirm current state.':known?scan.percent+'% done':'Progress not yet available.'));
        const metrics=node('dl',undefined,'zfsm-properties');
        for(const [label,value] of [['Scanned',scan.scanned?scan.scanned+' / '+scan.scan_total:null],['Scan speed',scan.scan_rate],['Issued',scan.issued?scan.issued+' / '+scan.issue_total:null],['Scrub speed',scan.issue_rate],['Time remaining',scan.eta||'Not available'],['Repaired',scan.repaired]])if(value!==null&&value!==undefined)metrics.append(node('dt',label),node('dd',value));
        panel.append(metrics);
    }
    if(scan.text)panel.append(node('pre',scan.text,'zfsm-raw-output'));
    const allowed=zfsmCanStartScrub(diagnostic),controls=node('div',undefined,'zfsm-buttons'),start=node('button',scan.state==='paused'?'Resume scrub':'Start scrub');start.type='button';start.disabled=!allowed||Boolean(options.busy);
    start.addEventListener('click',()=>{if(!start.disabled)options.onReview?.();});controls.append(start);panel.append(controls);
    if(options.busy)panel.append(node('p','Scrub request in progress…','zfsm-notice'));
    else if(!allowed)panel.append(node('p','Starting scrub requires fresh pool diagnostics and no active scan.','zfsm-muted'));
    else if(options.review){
        const review=node('section',undefined,'zfsm-confirmation');review.setAttribute('aria-label','Confirm scrub');
        review.append(node('p','Scrub verifies the entire pool '+diagnostic.pool+' and can increase disk activity. It cannot be limited to a dataset.'));
        const confirm=node('button','Confirm scrub'),cancel=node('button','Cancel');confirm.type=cancel.type='button';
        confirm.addEventListener('click',()=>{confirm.disabled=true;options.onScrub?.();});cancel.addEventListener('click',()=>options.onCancel?.());
        const buttons=node('div',undefined,'zfsm-buttons');buttons.append(confirm,cancel);review.append(buttons);panel.append(review);
    }
    container.append(panel);
}

function zfsmRenderPoolDiagnostics(container, diagnostic, type, options = {}) {
    function node(tag,text,cls) { const n=document.createElement(tag); if(text!==undefined)n.textContent=String(text); if(cls)n.className=cls; return n; }
    function bytes(value) {
        if(value===null||value===undefined||value==='')return '—';
        if(!/^\d+(?:\.\d+)?$/.test(String(value)))return String(value);
        const n=Number(value),units=['B','KiB','MiB','GiB','TiB','PiB','EiB'],power=n>0?Math.min(Math.floor(Math.log(n)/Math.log(1024)),units.length-1):0;
        return (n/1024**power).toLocaleString(undefined,{maximumFractionDigits:2})+' '+units[power];
    }
    container.replaceChildren();
    container.append(node('h3',type==='status'?'ZFS Pool Status':'ZFS Pool Information'));
    if(!diagnostic) { container.append(node('p','Pool diagnostics have not been checked. Click Refresh.','zfsm-notice')); return; }
    const severity=['ok','warning','error','unknown'].includes(diagnostic.severity)?diagnostic.severity:'unknown';
    const notice=node('div',undefined,severity==='error'?'zfsm-error':'zfsm-notice'); notice.dataset.severity=severity;
    const health=node('strong',(diagnostic.health||'UNKNOWN')+' · '+({ok:'Healthy',warning:'Warning',error:'Error',unknown:'Unknown'}[severity])),dot=node('span',undefined,'zfsm-status-dot');dot.dataset.severity=severity;dot.setAttribute('aria-hidden','true');health.prepend(dot);notice.append(health);
    for(const reason of diagnostic.reasons||[])notice.append(node('p',reason));
    if(diagnostic.stale)notice.append(node('p','Retained output is stale. The latest diagnostic request failed.'));
    container.append(notice);
    if(diagnostic.collected_at)container.append(node('p','Last checked: '+zfsmFormatDateTime(diagnostic.collected_at),'zfsm-muted'));
    if(diagnostic.attempted_at)container.append(node('p','Latest incomplete attempt: '+zfsmFormatDateTime(diagnostic.attempted_at),'zfsm-muted'));
    if(type==='status')zfsmRenderScrub(container,diagnostic,options);
    const summary=node('section',undefined,'zfsm-overview-card zfsm-maintenance-summary');summary.append(node('h3','Pool statistics & maintenance'));const facts=node('dl',undefined,'zfsm-overview-values'),native=diagnostic.information?.rows?.find(row=>row.name===diagnostic.pool)||{},maintenance=diagnostic.maintenance||{},trim=(diagnostic.status?.rows||[]).filter(row=>/trim/i.test(row.note||'')).map(row=>row.name+': '+row.note);
    const trimText=diagnostic.trim?.available===true?(trim.length?trim.join('; '):'Unknown — no vdev TRIM status was reported'):'Unknown — '+(diagnostic.trim?.reason||'native TRIM status is unavailable');
    if(diagnostic.capacity?.status==='known')summary.append(node('p','Allocated '+diagnostic.capacity.percent+'% · warning '+diagnostic.capacity.warning+'% · critical '+diagnostic.capacity.critical+'%'));
    const history=node('details'),historyLabel=node('summary','Maintenance transitions');history.append(historyLabel);
    if(diagnostic.maintenance_history?.status==='known'){const entries=diagnostic.maintenance_history.entries||[];if(!entries.length)history.append(node('p','No recorded transitions. This is not a complete native scrub/TRIM history.'));for(const entry of entries)history.append(node('p',zfsmFormatDateTime(entry.time)+' · '+entry.severity+' · '+entry.reasons.join('; ')));}
    else history.append(node('p','Transition history Unknown. Current native scan and TRIM evidence remain separate.'));
    summary.append(history);if(diagnostic.monitor_warning)summary.append(node('p',diagnostic.monitor_warning,'zfsm-muted'));
    for(const [label,value]of [['Pool',diagnostic.pool],['Health',diagnostic.health],['Capacity',native.size===undefined?'Unknown':bytes(native.size)],['Allocated',native.alloc===undefined?'Unknown':bytes(native.alloc)],['Free',native.free===undefined?'Unknown':bytes(native.free)],['Fragmentation',native.frag&&native.frag!=='-'?native.frag+'%':'Unknown'],['Current / last scan',diagnostic.status?.scan||diagnostic.scan?.text||'Unknown'],['Scan errors',diagnostic.scan?.errors??'Unknown'],['TRIM',trimText],['Scrub schedule owner',maintenance.owner||'Unknown'],['Native cron schedule',maintenance.schedule||'Unknown'],['Native cron timezone',maintenance.timezone||'Unknown'],['Next scheduled scrub (nominal)',maintenance.next_run?(maintenance.next_run_local||zfsmFormatDateTime(maintenance.next_run)):'Unknown — schedule or timezone not verified']])facts.append(node('dt',label),node('dd',value));summary.append(facts,node('p','Pool Allocated measures pool space. Dataset Used follows dataset accounting, including children, snapshots and reservations. ZFS health is not a SMART health verdict.','zfsm-muted'));const settings=node('a','Open Unraid storage settings');settings.href='/Main';summary.append(settings);if(maintenance.warning)summary.append(node('p',maintenance.warning,'zfsm-error'));container.append(summary);
    const part=diagnostic[type==='status'?'status':'information'];
    if(!part) { container.append(node('p','Diagnostic output is unavailable.','zfsm-error')); return; }
    if(type==='status') {
        const list=node('dl',undefined,'zfsm-properties');
        for(const [key,label] of [['status','Status'],['action','Suggested action (information only)'],['errors','Data errors']])if(part[key])list.append(node('dt',label),node('dd',part[key]));
        container.append(list);
    }
    const columns=type==='status'?['NAME','STATE','READ','WRITE','CKSUM']:['NAME','SIZE','ALLOC','FREE','CKPOINT','EXPANDSZ','FRAG','CAP','DEDUP','HEALTH','ALTROOT'];
    const wrap=node('div',undefined,'zfsm-table-wrap'),table=node('table',undefined,'zfsm-table zfsm-readable-table '+(type==='status'?'zfsm-status-table':'zfsm-pool-information-table')),head=node('thead'),hr=node('tr'),body=node('tbody');
    for(const label of columns){const th=node('th',label);th.scope='col';hr.append(th);}head.append(hr);table.append(head,body);wrap.append(table);container.append(wrap);
    for(const row of Array.isArray(part.rows)?part.rows:[]) {
        const tr=node('tr');
        const badCounters=['read','write','cksum'].some(key=>parseFloat(row[key])>0);
        const state=String(type==='status'?row.state:row.health||'');
        const badState=state!==''&&state!=='-'&&!['ONLINE','AVAIL','AVAILABLE','INUSE'].includes(state);
        if(badCounters||badState)tr.dataset.problem='true';
        for(const label of columns){
            const key=label.toLowerCase(),value=row[key];
            let text=value===null||value===undefined?'—':String(value);
            if(type!=='status'&&['size','alloc','free','ckpoint','expandsz'].includes(key))text=bytes(value);
            if(type!=='status'&&['frag','cap'].includes(key)&&/^\d+(\.\d+)?$/.test(text))text+='%';
            const td=node('td',text);
            if(key==='name')td.style.paddingLeft=(10+Math.max(0,Math.min(20,Number(row.depth)||0))*14)+'px';
            else if(!['state','health','altroot'].includes(key))td.dataset.number='true';
            if(['read','write','cksum'].includes(key)&&parseFloat(value)>0)td.className='zfsm-counter-error';
            tr.append(td);
        }
        body.append(tr);
    }
    if(!body.children.length)container.append(node('p','No usable rows were returned.','zfsm-error'));
    if(part.text){const details=node('details');details.append(node('summary','Raw zpool '+(type==='status'?'status':'list')+' output'),node('pre',part.text,'zfsm-raw-output'));container.append(details);}
    for(const error of diagnostic.command_errors||[])container.append(node('p',(error.command||'Diagnostic')+': '+(error.message||'Command failed'),'zfsm-error'));
}
