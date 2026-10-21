/* Administrative history consumes only the backend's redacted audit records. */
(function (global) {
    'use strict';

    function redacted(value) {
        if(Array.isArray(value))return value.map(redacted);
        if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/password|passphrase|secret|token|credential|authorization|cookie|keymaterial|(?:api|private|encryption|access|signing|client)key|^key$/i.test(key.replace(/[^a-z0-9]/gi,''))?'[redacted]':redacted(item)]));
        return value;
    }
    async function copyActivity(host,value) {
        const text=JSON.stringify(redacted(value),null,2),document=host.ownerDocument;
        let notice=host.querySelector('[data-copy-status]');if(!notice){notice=document.createElement('p');notice.dataset.copyStatus='';notice.setAttribute('role','status');host.append(notice);}
        host.querySelector('[data-copy-fallback]')?.remove();
        try{
            if(global.isSecureContext&&typeof global.navigator.clipboard?.writeText==='function')await global.navigator.clipboard.writeText(text);
            else {
                if(typeof document.execCommand!=='function')throw new Error('Clipboard API unavailable');
                const previous=document.activeElement,temporary=document.createElement('textarea');temporary.value=text;temporary.readOnly=true;temporary.tabIndex=-1;temporary.setAttribute('aria-hidden','true');temporary.style.cssText='position:fixed;opacity:0;pointer-events:none';document.body.append(temporary);
                try{temporary.focus({preventScroll:true});temporary.select();if(document.execCommand('copy')!==true)throw new Error('Clipboard copy was refused');}
                finally{temporary.remove();if(previous?.isConnected)previous.focus({preventScroll:true});}
            }
            notice.textContent='Copied redacted event data.';
        }catch(error){
            notice.textContent='Copy unavailable. Select and copy the redacted data below manually.';
            const fallback=document.createElement('textarea');fallback.dataset.copyFallback='';fallback.readOnly=true;fallback.setAttribute('aria-label','Redacted event data to copy manually');fallback.value=text;host.append(fallback);fallback.focus();fallback.select();
        }
    }
    global.zfsmCopyActivity=copyActivity;
    const results = {succeeded:'Succeeded', failed:'Failed', cancelled:'Cancelled', recovery_required:'Needs attention', completed:'Completed', running:'Running / unconfirmed', queued:'Queued / unconfirmed', started:'Started / unconfirmed'};
    const reasons = {not_authorized:'Permission or authorization denied',storage_unavailable:'Storage unavailable or write failed',conflict:'Target conflict or changed state',validation_failed:'Request validation failed',command_failed:'Command failed',invalid_request:'Invalid request',cancelled:'Cancelled',recovery_required:'Manual recovery required',internal_error:'Internal error',worker_interrupted:'Worker interrupted',audit_unavailable:'Audit unavailable'};
    const targetFields = ['zdataset', 'snapshot', 'directory', 'newname', 'pool', 'dataset', 'target', 'clone'];

    function timestamp(value) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
        const time = Date.parse(value);
        return Number.isFinite(time) && new Date(time).toISOString().slice(0,19) === value.slice(0,19) ? time : null;
    }

    function groupRecords(entries) {
        const groups = new Map();
        const positions = new Map(entries.map((entry,index)=>[entry,index]));
        entries.forEach((record, index) => {
            const entry = record && typeof record === 'object' ? record : {};
            const identified = typeof entry.operation_id === 'string' && entry.operation_id !== '';
            const key = identified ? 'id:' + entry.operation_id : 'record:' + index;
            if (!groups.has(key)) groups.set(key, {id:identified ? entry.operation_id : 'unidentified-' + index, identified, records:[], entries:[], index});
            const group = groups.get(key); group.records.push(record); group.entries.push(entry);
        });
        const order=(a,b)=>{const at=timestamp(a.timestamp),bt=timestamp(b.timestamp);return at===null||bt===null?null:at-bt||positions.get(b)-positions.get(a);};
        const attempts=[...groups.values()].flatMap(group=>{
            const begins=group.entries.filter(entry=>entry.command==='conversion'&&entry.phase==='begin'&&/^[0-9]{8}-[0-9]{6}-[a-f0-9]{12}$/.test(entry.fields?.job_id));
            if(begins.length!==1)return [];
            const outcomes=group.entries.filter(entry=>entry.phase==='outcome').sort((a,b)=>order(a,b)||0);
            return [{group,begin:begins[0],outcome:outcomes.at(-1)}];
        });
        const related=new Set();
        for(const group of groups.values()){
            if(group.entries.length!==1)continue;
            const stage=group.entries[0];
            if(stage.command!=='conversion'||stage.phase!=='event'||stage.status!=='running'||typeof stage.fields?.stage!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(stage.fields.stage))continue;
            const matches=attempts.filter(attempt=>attempt.group!==group&&attempt.begin.fields.job_id===stage.fields.job_id&&order(attempt.begin,stage)!==null&&order(attempt.begin,stage)<=0&&(!attempt.outcome||(order(stage,attempt.outcome)!==null&&order(stage,attempt.outcome)<=0)));
            // Missing/overlapping attempt evidence stays independent. Original
            // IDs/primary entries still govern archive eligibility on the server.
            if(matches.length===1){const owner=matches[0].group;(owner.related||(owner.related=[])).push(stage);owner.records.push(stage);owner.records.sort((a,b)=>positions.get(a)-positions.get(b));related.add(group);}
        }
        return [...groups.values()].filter(group=>!related.has(group)).map(group => {
            // Audit API is newest-first, including records written in the same second.
            const chronological = [...group.entries,...group.related||[]].sort((a,b)=>((timestamp(a.timestamp)??-Infinity)-(timestamp(b.timestamp)??-Infinity))||positions.get(b)-positions.get(a));
            const begins = chronological.filter(entry => entry.phase === 'begin');
            const outcomes = chronological.filter(entry => entry.phase === 'outcome');
            const begin = begins[0], outcome = outcomes[outcomes.length - 1];
            const latest = chronological[chronological.length - 1];
            const timeEntry = begin && timestamp(begin.timestamp) !== null ? begin : latest;
            group.time = timestamp(timeEntry.timestamp);
            group.timestamp = timeEntry.timestamp;
            group.commands = [...new Set(group.entries.map(entry => typeof entry.command === 'string' ? entry.command : 'Unknown operation'))];
            const laterEvent=latest.phase==='event'&&['queued','running','failed','cancelled','recovery_required'].includes(latest.status);
            group.status = laterEvent ? latest.status : outcome ? outcome.status : begin ? 'unconfirmed' : latest.status;
            group.result = group.status === 'unconfirmed' ? 'Started / unconfirmed' : results[group.status] || 'Unknown / unconfirmed';
            group.status = Object.prototype.hasOwnProperty.call(results, group.status) ? group.status : 'unconfirmed';
            const targets = [];
            for (const entry of group.entries) {
                for (const name of targetFields) {
                    const value = entry.fields && entry.fields[name];
                    for (const target of Array.isArray(value) ? value : [value]) if (typeof target === 'string' && target) targets.push(target);
                }
                for (const name of ['succeeded', 'failed']) if (Array.isArray(entry[name])) for (const target of entry[name]) if (typeof target === 'string' && target) targets.push(target);
            }
            group.target = [...new Set(targets)].join(' → ') || '—';
            if(group.commands.length===1&&group.commands[0]==='movedirectory'&&typeof begin?.fields?.directory==='string'&&typeof begin.fields.newname==='string')group.target=begin.fields.directory+' → '+begin.fields.newname;
            const start = begin && timestamp(begin.timestamp), end = outcome && timestamp(outcome.timestamp);
            group.duration = !laterEvent && typeof start === 'number' && typeof end === 'number' && end >= start ? ((end - start) / 1000) + ' s' : '—';
            group.begin = begin; group.outcome = outcome;
            return group;
        });
    }

    function zfsmRenderHistory(host, entries, options) {
        options = options || {};
        const document = host.ownerDocument, records = Array.isArray(entries) ? entries.slice() : [];
        const date = typeof options.date === 'function' ? options.date : value => value;
        const archivedIds=new Set(Array.isArray(options.archivedIds)?options.archivedIds:[]);let visibility='working',pendingIds=null,visibilityBusy=false;
        let groups = groupRecords(records), page = 1, nextCursor = options.nextCursor, hasMore = options.hasMore === true, scanLimited = options.scanLimited === true, loadingOlder = false;
        function node(tag, text, className) {
            const item = document.createElement(tag);
            if (text !== undefined) item.textContent = String(text);
            if (className) item.className = className;
            return item;
        }
        function select(label, choices) {
            const wrap = node('label', undefined, 'zfsm-field'), control = node('select');
            wrap.append(node('span', label)); control.setAttribute('aria-label', label);
            for (const [value, caption] of choices) { const option = node('option', caption); option.value = value; control.append(option); }
            wrap.append(control); toolbar.append(wrap); return control;
        }
        function button(label, action) {
            const control = node('button', label); control.type = 'button'; control.addEventListener('click', action); return control;
        }
        host.replaceChildren();
        const toolbar = node('div', undefined, 'zfsm-history-toolbar zfsm-buttons');
        const searchWrap = node('label', undefined, 'zfsm-field'), search = node('input');
        search.type = 'search'; search.setAttribute('aria-label', 'Search history'); search.placeholder = 'Operation or target';
        searchWrap.append(node('span', 'Search history'), search); toolbar.append(searchWrap);
        const operation = select('Operation', [['','All operations'], ...[...new Set(groups.flatMap(group => group.commands))].sort().map(command => [command,command])]);
        const result = select('Result', [['','All results'], ...Object.entries(results), ['unconfirmed','Outcome unconfirmed']]);
        const sort = select('Sort history', [['newest','Newest first'], ['oldest','Oldest first']]);
        const view=select('History view',[['working','Working view'],['archived','Archived'],['all','All including archived']]);
        const clear=button('Clear completed on this page',()=>confirmVisibility(true)),restore=button('Restore archived on this page',()=>confirmVisibility(false));
        toolbar.append(clear,restore);host.append(toolbar);
        const confirmation=node('div',undefined,'zfsm-notice');confirmation.hidden=true;host.append(confirmation);
        const visibilityStatus=node('p');visibilityStatus.setAttribute('role','status');host.append(visibilityStatus);
        const eligible=group=>group.identified&&/^[a-f0-9]{32}$/.test(group.id)&&group.status==='succeeded'&&group.entries.every(entry=>!['failed','cancelled','recovery_required','running','queued'].includes(entry.status));
        let pageGroups=[];
        function confirmVisibility(archive){
            pendingIds=pageGroups.filter(group=>archive?eligible(group)&&!archivedIds.has(group.id):archivedIds.has(group.id)).map(group=>group.id).slice(0,500);
            if(!pendingIds.length)return;
            const ids=pendingIds.slice();confirmation.replaceChildren(node('p',(archive?'Hide '+ids.length+' successful operation(s) from this page? Audit records are retained. All newer events are checked through bounded history pages before hiding.':'Restore '+ids.length+' archived operation(s) from this page?')),
                button(archive?'Confirm hide':'Confirm restore',async()=>{
                    if(visibilityBusy)return;visibilityBusy=true;confirmation.hidden=true;
                    try{const answer=await options.setVisibility(ids,archive);if(!answer||!answer.succeeded||Object.keys(answer.failed||{}).length)throw new Error(Object.values(answer?.failed||{}).join('; ')||'Invalid visibility response');for(const id of ids)archive?archivedIds.add(id):archivedIds.delete(id);visibilityStatus.textContent=ids.length+' operation(s) '+(archive?'hidden. Audit retained.':'restored.');render();}
                    catch(error){visibilityStatus.textContent='Unable to change history visibility: '+error.message;}finally{visibilityBusy=false;}
                }),button('Cancel',()=>{pendingIds=null;confirmation.hidden=true;}));confirmation.hidden=false;
        }
        view.addEventListener('change',()=>{visibility=view.value;page=1;confirmation.hidden=true;render();});
        const range = node('p',undefined,'zfsm-notice'); host.append(range);
        const older = button('Load older records', loadOlder), olderStatus = node('p',undefined,'zfsm-notice');
        olderStatus.setAttribute('role','status'); olderStatus.setAttribute('aria-live','polite'); olderStatus.hidden=true; host.append(older,olderStatus);
        const count = node('p', undefined, 'zfsm-muted'); count.setAttribute('role','status'); count.setAttribute('aria-live','polite'); host.append(count);
        const wrap = node('div', undefined, 'zfsm-table-wrap'), table = node('table', undefined, 'zfsm-table zfsm-history-table');
        const header = node('thead'), heading = node('tr'), body = node('tbody');
        for (const label of ['Time','Operation','Target','Result','Duration','Details']) { const cell = node('th',label); cell.scope='col'; heading.append(cell); }
        header.append(heading); table.append(header,body); wrap.append(table); host.append(wrap);
        const empty = node('p', undefined, 'zfsm-notice'); host.append(empty);
        const pagination = node('nav', undefined, 'zfsm-buttons'); pagination.setAttribute('aria-label','History pages');
        pagination.dataset.historyPagination = '';
        const previous = button('Previous page', () => { page--; render(); });
        const next = button('Next page', () => { page++; render(); });
        const pageLabel = node('span'); pagination.append(previous,pageLabel,next); host.append(pagination);

        const current = () => host.isConnected && host.contains(older) && (typeof options.isCurrent !== 'function' || options.isCurrent());
        async function loadOlder() {
            if (loadingOlder || !hasMore || typeof nextCursor !== 'string' || !nextCursor || typeof options.loadOlder !== 'function' || !current()) return;
            loadingOlder=true; older.disabled=true; olderStatus.hidden=false; olderStatus.className='zfsm-notice'; olderStatus.textContent='Loading older audit records…';
            const requested=nextCursor;
            try {
                const answer=await options.loadOlder(requested);
                if (!current()) return;
                if (!answer || !Array.isArray(answer.entries) || answer.entries.length>500 || answer.entries.some(entry=>!entry || typeof entry!=='object' || Array.isArray(entry)) || (answer.has_more===true && (typeof answer.next_cursor!=='string' || !answer.next_cursor || answer.next_cursor===requested))) throw new Error('Invalid older audit response; refresh history');
                records.push(...answer.entries); for(const id of answer.archived_ids||[])archivedIds.add(id); groups=groupRecords(records); nextCursor=answer.next_cursor; hasMore=answer.has_more===true; scanLimited=answer.scan_limited===true;
                const selected=operation.value; operation.replaceChildren();
                for (const value of ['',...[...new Set(groups.flatMap(group=>group.commands))].sort()]) { const option=node('option',value || 'All operations'); option.value=value; operation.append(option); }
                operation.value=selected; olderStatus.textContent=answer.entries.length+' older audit records loaded.'; render();
            } catch (error) {
                if (current()) { olderStatus.className='zfsm-error'; olderStatus.textContent='Unable to read older history: '+error.message; }
            } finally {
                loadingOlder=false; if(current()) older.disabled=false;
            }
        }

        function details(group) {
            const detail = node('details'), summary = node('summary','Technical details'); detail.append(summary);
            const list = node('dl');
            for (const [label,value] of [
                ['Operation ID',group.identified ? group.id : 'Unavailable; this record is shown independently'],
                ['Begin event',group.begin ? String(group.begin.timestamp || 'Unknown time') : 'Begin record unavailable in this returned range.'],
                ['Outcome',group.outcome ? String(group.outcome.status || 'Unknown') + ' · ' + String(group.outcome.timestamp || 'Unknown time') : 'Outcome record unavailable; no final outcome is inferred.'],
            ]) list.append(node('dt',label),node('dd',value));
            if (group.outcome && group.outcome.status !== 'succeeded') list.append(node('dt','Error category'),node('dd',reasons[group.outcome.reason] || 'Not recorded'));
            if(group.outcome?.details){const d=group.outcome.details;for(const [label,value]of [['Failure stage',d.stage],['Native exit code',d.exit_code??'Unknown'],['Failure context',d.error_code],['Native tool',d.tool??'Unknown']])list.append(node('dt',label),node('dd',value??'Unknown'));}
            detail.append(list,node('p','Parameters, error details and technical JSON — all '+group.records.length+' original audit records:'));
            const json = node('pre',JSON.stringify(group.records,null,2)); json.dataset.auditRecords=''; detail.append(json); return detail;
        }
        function render() {
            const paged=typeof options.hasMore==='boolean';
            const limited=options.limited===true || hasMore || scanLimited || (!paged && records.length >= (Number(options.limit)>0?Number(options.limit):500));
            range.textContent=limited
                ? 'Incomplete audit range — only the returned records are available. Older operations and related begin/outcome records may be outside this response.'+(scanLimited?' A bounded scan limit was reached; this does not establish the total history size.':'')
                : 'History covers the returned audit records. Missing begin/outcome records may fall outside this range.';
            older.hidden=!(hasMore && typeof nextCursor==='string' && nextCursor && typeof options.loadOlder==='function');
            const query = search.value.trim().toLocaleLowerCase();
            const isArchived=group=>archivedIds.has(group.id)&&!group.entries.some(entry=>['failed','cancelled','recovery_required','running','queued'].includes(entry.status));
            const visible = groups.filter(group => (visibility==='all'||(visibility==='archived')===isArchived(group)) && (!operation.value || group.commands.includes(operation.value)) && (!result.value || result.value === group.status) && (!query || (group.commands.join(' ') + ' ' + group.target).toLocaleLowerCase().includes(query)));
            visible.sort((a,b) => {
                if (a.time === null && b.time !== null) return 1;
                if (b.time === null && a.time !== null) return -1;
                const difference = a.time === b.time ? a.index - b.index : a.time - b.time;
                return sort.value === 'oldest' ? difference : -difference;
            });
            const pages = Math.max(1,Math.ceil(visible.length / 25)); page = Math.max(1,Math.min(page,pages));
            body.replaceChildren();pageGroups=visible.slice((page-1)*25,page*25);
            clear.hidden=typeof options.setVisibility!=='function'||visibility==='archived';restore.hidden=typeof options.setVisibility!=='function'||visibility==='working';clear.disabled=!pageGroups.some(group=>eligible(group)&&!archivedIds.has(group.id));restore.disabled=!pageGroups.some(group=>archivedIds.has(group.id));
            for (const group of pageGroups) {
                const row = node('tr'); row.dataset.historyOperation = group.id;
                const time = node('td',group.time === null ? 'Unknown time' : date(group.timestamp));
                const status = node('td',group.result), duration = node('td',group.duration), technical = node('td');
                status.dataset.historyResult=''; duration.dataset.historyDuration=''; technical.append(details(group),button('Copy',()=>copyActivity(technical,group.records)));
                row.append(time,node('td',group.commands.join(', ')),node('td',group.target),status,duration,technical); body.append(row);
            }
            count.textContent = visible.length + ' of ' + groups.length + ' operations · ' + records.length + ' audit records returned';
            empty.textContent = groups.length ? 'No operations match the current filters.' : 'No administrative operations have been recorded.';
            empty.hidden = visible.length > 0; wrap.hidden = visible.length === 0;
            pageLabel.textContent = 'Page '+page+' of '+pages;
            previous.disabled = page <= 1; next.disabled = page >= pages;
        }
        for (const control of [search,operation,result,sort]) control.addEventListener(control === search ? 'input' : 'change', () => { page=1; render(); });
        render();
    }

    global.zfsmRenderHistory = zfsmRenderHistory;
})(window);
