/* Dataset scope only. Unavailable integrations stay explicitly unknown. */
function zfsmRenderDatasetOverview(host, options) {
    const item=options.node,bytes=options.bytes,date=options.date,metadataLoaded=options.propertiesFresh===true,properties=metadataLoaded&&options.properties?options.properties:item;
    const known=value=>['number','string'].includes(typeof value)&&value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))&&Number(value)>=0;
    const text=(tag,value,cls)=>{const n=document.createElement(tag);if(value!==undefined)n.textContent=String(value);if(cls)n.className=cls;return n;};
    const button=(label,run,disabled=false)=>{const n=text('button',label);n.type='button';n.disabled=disabled;n.addEventListener('click',run);return n;};
    const numeric=(name,unlimited=false,source=item)=>!known(source[name])?'Unknown':unlimited&&Number(source[name])===0?'Unlimited':bytes(source[name]);
    const cards=text('div',undefined,'zfsm-overview-cards');
    function card(title,scope){const n=text('section',undefined,'zfsm-overview-card'),heading=text('header'),label=text('h3',title);if(typeof zfsmCreateIcon==='function')label.prepend(zfsmCreateIcon({'Details':'details','Space Management':'space','Data Protection':'shield','Usage & Permissions':'users','ZFS Encryption':'lock'}[title]));heading.append(label,text('small',scope,'zfsm-muted'));n.append(heading);cards.append(n);return n;}
    function rows(parent,values){const list=text('dl',undefined,'zfsm-overview-values');for(const [label,value,help,source]of values){const key=text('dt',label),answer=text('dd',value??'Unknown');if(help){key.title=help;answer.title=help;}if(source)answer.append(text('small',' · Source: '+source,'zfsm-muted'));list.append(key,answer);}parent.append(list);}
    function link(parent,label,tab){parent.append(button(label,()=>options.onTab(tab)));}
    const volume=item.type==='volume',root=item.name===options.pool;
    const hero=text('section',undefined,'zfsm-dataset-hero'),labels=text('div',undefined,'zfsm-dataset-tags'),actions=text('div',undefined,'zfsm-buttons');
    labels.append(text('span',root?'Pool root dataset':volume?'ZFS volume':item.origin&&item.origin!=='-'?'Clone filesystem':'ZFS filesystem','zfsm-tag'),text('span','Compression: '+(item.compression||'Unknown'),'zfsm-tag'));
    const snapshot=button('Take Snapshot',()=>options.onAction('snapshotdataset'),!options.fresh||!item.guid);snapshot.title=options.fresh?'Create a restore point for this dataset':'Refresh successfully before changing this dataset';
    actions.append(snapshot,button('Restore Files',()=>options.onTab('snapshots')),button('Dataset actions',()=>options.onTab('actions')));hero.append(labels,actions);host.append(hero);
    if(!options.fresh)host.append(text('p','Stale data — refresh successfully before changing objects.','zfsm-notice'));
    const staging=String(item.mountpoint||properties.mountpoint||'').match(/^\/var\/tmp\/zfs\.master\.ui\/conversions\/([0-9]{8}-[0-9]{6}-[a-f0-9]{12})\//);
    if(staging)host.append(text('p','Conversion not published — job '+staging[1]+'. This dataset is mounted only in a private staging path and is not visible at its directory. Open Jobs to publish or inspect it; do not delete the original directory.','zfsm-danger'));

    const details=card('Details','Dataset statistics');
    const source=name=>metadataLoaded&&typeof properties._sources?.[name]==='string'&&properties._sources[name].trim()!==''?properties._sources[name]:'Unknown';
    const values=[['Name',item.name],['Type',volume?'Volume':'Filesystem']];
    if(!volume)values.push(['Mountpoint',properties.mountpoint||'Unknown',null,source('mountpoint')]);
    values.push(['Compression',properties.compression,null,source('compression')],['Compression ratio',known(properties.compressratio)?Number(properties.compressratio)/100+'x':'Unknown'],['Sync',properties.sync,null,source('sync')]);
    if(volume)values.push(['Volume block size',numeric('volblocksize',false,properties)]);else values.push(['Record size',numeric('recordsize',false,properties),null,source('recordsize')],['Atime',properties.atime,null,source('atime')],['Case sensitivity',properties.casesensitivity,null,source('casesensitivity')]);
    values.push(['Read only',properties.readonly,null,source('readonly')],['Xattr',properties.xattr,null,source('xattr')],['Primary cache',properties.primarycache,null,source('primarycache')],['Dedup',properties.dedup],['Created',properties.creation?date(properties.creation):'Unknown']);rows(details,values);link(details,'View all properties','properties');

    const space=card('Space Management','Dataset statistics'),body=text('div',undefined,'zfsm-space-body');
    const total=known(item.used)&&known(item.available)?Number(item.used)+Number(item.available):0;
    const parts=[['Dataset','usedbydataset','#18b9c8'],['Children','usedbychildren','#e9ab42'],['Snapshots','usedbysnapshots','#7f8ff2'],['Refreservation','usedbyrefreservation','#cb80c7']];
    const complete=parts.every(([,key])=>known(item[key]))&&Math.abs(parts.reduce((sum,[,key])=>sum+Number(item[key]),0)-Number(item.used))<=1;
    if(total>0){
        const percent=Math.round(Number(item.used)/total*100),ring=text('div',undefined,'zfsm-space-ring');ring.setAttribute('role','img');ring.setAttribute('aria-label',percent+'% used of dataset used plus available space');
        let cursor=0;const segments=[];
        for(const [,key,color]of complete?parts:[['Used','used','var(--zfsm-accent)']]){const end=cursor+Number(item[key])/total*100;segments.push(color+' '+cursor+'% '+end+'%');cursor=end;}
        segments.push('var(--zfsm-track) '+cursor+'% 100%');ring.style.background='conic-gradient('+segments.join(',')+')';
        const inside=text('div',undefined,'zfsm-space-ring-center');inside.append(text('strong',percent+'%'),text('span','Used'));ring.append(inside);body.append(ring);
    }
    const legend=text('div',undefined,'zfsm-space-legend');rows(legend,[['Used',numeric('used'),'Dataset used includes children, snapshots and refreservation; this is not pool allocated space.'],['Available',numeric('available'),'Effective space available to this dataset, limited by quotas, reservations and pool space.']]);
    if(complete)for(const [label,key,color]of parts){const row=text('div',undefined,'zfsm-space-part'),dot=text('i');dot.style.background=color;row.append(dot,text('span',label),text('strong',numeric(key)));legend.append(row);}else legend.append(text('p','Breakdown unavailable — refresh to load usedby* properties.','zfsm-muted'));
    body.append(legend);space.append(body);rows(space,[['Referenced',numeric('referenced'),'Data accessible from this dataset; shared blocks are not additive.'],...(!volume?[['Quota',numeric('quota',true,properties),null,source('quota')],['Refquota',numeric('refquota',true,properties),null,source('refquota')]]:[]),['Reservation',known(properties.reservation)&&Number(properties.reservation)===0?'None':numeric('reservation',false,properties),null,source('reservation')],['Refreservation',known(properties.refreservation)&&Number(properties.refreservation)===0?'None':numeric('refreservation',false,properties),null,source('refreservation')]]);
    space.append(text('p','Percent uses dataset Used + Available. Quotas and reservations can make this differ from pool capacity. Snapshot Used values cannot be summed to predict reclaimable space.','zfsm-muted'));link(space,volume?'View space properties':'Manage quota','properties');
    if(total>0){const percent=Number(item.used)/total*100,warning=Number(options.config?.space_warning_percent??80),critical=Number(options.config?.space_critical_percent??90);if(percent>=warning)space.append(text('p','Dataset space '+(percent>=critical?'critical':'warning')+' threshold reached ('+Math.round(percent)+'% of Used + Available).','zfsm-error'));}
    if(!volume){const quotas=text('button','User / group quotas');quotas.type='button';quotas.addEventListener('click',()=>options.onAction?.('setquota'));space.append(quotas);}

    const protection=card('Data Protection','Snapshots and external backup are separate');
    function counts(n){let count=(n.snapshots||[]).length;for(const child of Object.values(n.child||{}))count+=counts(child);return count;}
    const snapshots=item.snapshots||[],latest=snapshots.reduce((value,s)=>Math.max(value,Number(s.creation)||0),0),days=latest?Math.max(0,Math.floor((Date.now()/1000-latest)/86400)):null,threshold=Number(options.config?.snap_max_days_alert),loaded=options.loaded===true;
    const ageState=!loaded?'Snapshot inventory unavailable':!latest?'No direct snapshots':Number.isFinite(threshold)&&threshold>0&&days>threshold?'Old snapshot — exceeds configured '+threshold+' day warning':'Latest direct snapshot';
    rows(protection,[['Direct snapshots',loaded?snapshots.length:'Unknown'],['Including descendants',loaded?counts(item):'Unknown'],['Snapshot status',ageState],['Last direct snapshot',loaded&&latest?date(latest):'Unknown'],['Snapshot age',loaded&&days!==null?days+' days':'Unknown'],['Schedule owner','Unknown'],['Next execution','Unknown'],['Last scheduled execution','Unknown'],['Last successful execution','Unknown'],['Last failure','Unknown'],['Last task result','Unknown'],['Retention','Unknown'],['External backup','Unknown']]);
    protection.append(text('p','A local snapshot is a restore point, not an external backup. No scheduler or replication status has been verified.','zfsm-muted'));link(protection,'View Snapshots','snapshots');link(protection,'Manage Protection','snapshots');

    const permissions=metadataLoaded?properties._permissions:null,permissionsKnown=permissions?.status==='known',services=metadataLoaded?properties._usage:null,acl=metadataLoaded?properties._acl:null;
    const state=value=>value?.status==='unavailable'?'Not available':value?.status==='error'?'Error':'Unknown';
    const service=value=>value?.status==='known'&&Array.isArray(value.entries)?value.entries.length?value.entries.length+' configured use'+(value.entries.length===1?'':'s'):'No configured use found':state(value);
    const serviceNames=[['smb','SMB'],['nfs','NFS'],['docker','Docker'],['vm','VM']],aclKnown=acl?.status==='known'&&Array.isArray(acl.entries);
    const references=serviceNames.reduce((total,[key])=>total+(Array.isArray(services?.[key]?.entries)?services[key].entries.length:0),0),usageSummary=references?references+' verified reference'+(references===1?'':'s'):serviceNames.every(([key])=>services?.[key]?.status==='known')?'No configured use found':'Unknown';
    const usage=card('Usage & Permissions','Read-only summary');rows(usage,[['Usage',usageSummary],['SMB / NFS','SMB: '+service(services?.smb)+'; NFS: '+service(services?.nfs)],['Docker / VM','Docker: '+service(services?.docker)+'; VM: '+service(services?.vm)],['Owner / Group',permissionsKnown?permissions.owner+' / '+permissions.group:'Unknown'],['Unix permissions',permissionsKnown?permissions.mode:'Unknown'],['ACL type',volume?'Not applicable':properties.acltype||'Unknown',null,volume?null:source('acltype')],['ACL mode',volume?'Not applicable':properties.aclmode||'Unknown',null,volume?null:source('aclmode')],['ACL inheritance',volume?'Not applicable':properties.aclinherit||'Unknown',null,volume?null:source('aclinherit')],['ACL entries',aclKnown?acl.entries.length+' entries':state(acl)],['ACL state',aclKnown?(acl.extended?'Extended POSIX ACL':'Base POSIX ACL')+(acl.has_default?' with default entries':''):state(acl)]]);
    for(const [key,label]of serviceNames){
        const value=services?.[key];if(!value)continue;
        if(Array.isArray(value.entries)&&value.entries.length){const list=text('ul');list.style.overflowWrap='anywhere';for(const entry of value.entries)list.append(text('li',label+': '+entry.name+(entry.state?' ('+entry.state+')':'')+' · '+entry.path+(entry.destination?' → '+entry.destination:'')+(entry.configured_path?' · Configured: '+entry.configured_path:'')+(entry.evidence?' · '+({verified_user_share_location:'Verified user-share location',container_mountinfo:'Verified container mount',zvol_device_identity:'Verified zvol device'}[entry.evidence]||'Verified reference'):'')));usage.append(list);}
        if(value.status!=='known'&&Array.isArray(value.entries)&&value.entries.length)usage.append(text('p',label+': verified references shown; discovery is incomplete.','zfsm-muted'));
        if(value.reason)usage.append(text('p',label+': '+value.reason,'zfsm-muted'));
        if(value.entries?.length){const owner=text('a','Open '+label);owner.href={smb:'/Shares',nfs:'/Shares',docker:'/Docker',vm:'/VMs'}[key];usage.append(owner);}
    }
    const dependencies=metadataLoaded?properties._dependencies:null;
    const dependencyDetail=text('details'),dependencyHeading=text('summary','Dependencies · '+(dependencies?.status==='known'?dependencies.entries.length+' native references':'Unknown'));
    dependencyDetail.append(dependencyHeading);
    for(const entry of dependencies?.entries||[])dependencyDetail.append(text('p',entry.kind+': '+entry.name+(entry.path?' · '+entry.path:'')+(entry.origin?' · '+entry.origin:'')+(entry.count?' · '+entry.count+' holds':'')));
    dependencyDetail.append(text('p','Evidence: '+(dependencies?.source||'Unknown')+'. Configured dependencies are rechecked before changing paths or deleting data. Incomplete discovery is not proof of no use.','zfsm-muted'));usage.append(dependencyDetail);
    if(aclKnown){
        const detail=text('details'),summary=text('summary','View ACL entries'),wrap=text('div',undefined,'zfsm-table-wrap'),table=text('table',undefined,'zfsm-table zfsm-acl-table'),head=text('thead'),heading=text('tr'),body=text('tbody');
        for(const label of ['Scope','Entry','ID','Permissions','Effective','Masked']){const cell=text('th',label);cell.scope='col';heading.append(cell);}head.append(heading);
        for(const entry of acl.entries){const row=text('tr');for(const value of [entry.scope,entry.tag,entry.id??'—',entry.permissions,entry.effective,entry.masked?'Yes':'No'])row.append(text('td',value));body.append(row);}table.append(head,body);wrap.append(table);detail.append(summary,wrap);usage.append(detail);
        usage.append(text('p','Effective permissions apply the access or default mask to named users and group entries. Default entries describe inheritance for newly created children; they are not effective access to this directory.','zfsm-muted'));
    }else if(acl?.reason)usage.append(text('p',acl.reason,'zfsm-muted'));
    const permissionNotice=permissionsKnown?'Owner, group and Unix mode were read from the verified mountpoint.':permissions?.reason||options.metadataError||(options.metadataState==='loading'?'Loading permission and property-source metadata…':'Current permissions have not been verified. Refresh inventory to load metadata.');
    usage.append(text('p',permissionNotice+' Configured service paths do not prove active I/O. Unresolved paths, including user-share aliases, remain Unknown.','zfsm-muted'));
    if(properties.encryption&&properties.encryption!=='off'){
        const encryption=card('ZFS Encryption','Effective encryption'),inherited=properties.encryptionroot&&properties.encryptionroot!==item.name&&properties.encryptionroot!=='none',locked=properties.keystatus==='unavailable';
        rows(encryption,[['State',inherited?'Encryption inherited — '+(locked?'locked by ancestor':'unlocked'):'Encrypted root — '+(locked?'locked':'unlocked')],['Encryption',properties.encryption,null,source('encryption')],['Encryption root',properties.encryptionroot,null,source('encryptionroot')],['Key status',properties.keystatus,null,source('keystatus')],['Key format',properties.keyformat,null,source('keyformat')],['Mounted',volume?'Not applicable':properties.mounted,null,volume?null:source('mounted')]]);link(encryption,'Encryption actions','actions');
    }
    host.append(cards);
}
