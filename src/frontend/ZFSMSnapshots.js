/* Embedded snapshot administration. Operation forms own all requests and results. */
(function (global) {
    'use strict';

    const containers = new WeakMap();
    const controllers = new WeakMap();

    function zfsmDisposeSnapshots(container) {
        const controller = controllers.get(container);
        if (controller) { controller.dispose(false); controllers.delete(container); }
    }

    function element(tag, text, className) {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = String(text);
        if (className) node.className = className;
        return node;
    }

    function bytes(value) {
        if (value === undefined || value === null || value === '') return '—';
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0) return String(value);
        const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
        const power = number > 0 ? Math.min(Math.floor(Math.log(number) / Math.log(1024)), units.length - 1) : 0;
        return Math.round(number / Math.pow(1024, power) * 10) / 10 + ' ' + units[power];
    }

    function creation(value) {
        return global.zfsmFormatDateTime(value);
    }

    function stateFor(container, pool, dataset) {
        if (!containers.has(container)) containers.set(container, new Map());
        const states = containers.get(container);
        const key = String(pool) + '\n' + String(dataset);
        if (!states.has(key)) states.set(key, { selected: new Set(),snapshotGuids:new Map(),datasetGuid:null, snapshots: null, openSnapshot: null, query: '', sort: 'name', direction: 'asc', page: 1 });
        return states.get(key);
    }

    function zfsmRenderSnapshots(container, options) {
        const node = options.node || {};
        const pool = options.pool || '';
        const state = stateFor(container, pool, node.name || '');
        const previousController = controllers.get(container);
        const restoreFocus = previousController ? previousController.dispose(true) : null;
        const previousWrap = container.querySelector('.zfsm-table-wrap');
        const scroll = {top:container.scrollTop,left:previousWrap ? previousWrap.scrollLeft : 0};
        let incoming = Array.isArray(node.snapshots) ? node.snapshots : null;
        if(state.scope==='recursive'&&incoming){incoming=incoming.slice();const collect=parent=>{for(const child of Object.values(parent.child||{})){if(Array.isArray(child.snapshots))incoming.push(...child.snapshots);else incoming.push(null);if(child._snapshot_error)incoming.push(null);collect(child);}};collect(node);}
        const error = options.snapshotError ? String(options.snapshotError) : '';
        const loaded = options.loaded === true;
        const malformed = loaded && !error && (incoming === null || incoming.some(snapshot =>
            !snapshot || typeof snapshot.name !== 'string' || snapshot.name === ''));
        const fresh = loaded && !error && !malformed;
        const snapshots = (fresh ? incoming : state.snapshots || incoming || [])
            .filter(snapshot => snapshot && typeof snapshot.name === 'string' && snapshot.name !== '');
        // A failed or incomplete refresh must not turn known snapshots into an empty list.
        if (fresh) {
            const guids=new Map(snapshots.map(snapshot=>[snapshot.name,String(snapshot.guid||'')]));
            if(state.datasetGuid!==null&&state.datasetGuid!==String(node.guid||'')){state.selected.clear();state.openSnapshot=null;}
            for(const name of state.selected)if(!guids.has(name)||!guids.get(name)||state.snapshotGuids.get(name)!==guids.get(name))state.selected.delete(name);
            if(state.openSnapshot&&state.snapshotGuids.get(state.openSnapshot)!==guids.get(state.openSnapshot))state.openSnapshot=null;
            state.snapshotGuids=guids;state.datasetGuid=String(node.guid||'');state.snapshots = snapshots.slice();
            const names = new Set(snapshots.map(snapshot => snapshot.name));
            if (!names.has(state.openSnapshot)) state.openSnapshot = null;
        }
        const destructive = Number((options.config || {}).destructive_mode) === 1;
        const context = { pool: pool, dataset: node.name || '', type: node.type || 'filesystem', node: node,snapshot_identities:Object.fromEntries(snapshots.map(s=>[s.name,String(s.guid||'')])) };
        const rowChecks = [];
        const pageSize = 50;
        let visibleSnapshots = [], filteredSnapshots = [];
        const menus = new Map(), events = new AbortController();
        let activeMenu = null, positioningFrame = 0;
        function hideMenu() {
            if (!activeMenu) return;
            if (activeMenu.actions.matches(':popover-open')) activeMenu.actions.hidePopover();
            activeMenu.operations.open = false;
            activeMenu.trigger.setAttribute('aria-expanded', 'false');
            activeMenu = null;
        }
        function closeMenu() { hideMenu(); state.openSnapshot = null; }
        function positionMenu() {
            if (!activeMenu || !activeMenu.trigger.isConnected) return;
            const {trigger, actions} = activeMenu, anchor = trigger.getBoundingClientRect();
            const width = Math.min(210, window.innerWidth - 16), height = window.innerHeight;
            actions.style.width = width + 'px'; actions.style.maxHeight = 'none';
            const natural = actions.getBoundingClientRect().height;
            const below = Math.max(0, height - Math.max(8, anchor.bottom + 5) - 8);
            const above = Math.max(0, Math.min(height - 8, anchor.top - 5) - 8);
            const downward = below >= natural || below >= above;
            const available = Math.max(40, downward ? below : above), actual = Math.min(natural, available);
            actions.style.maxHeight = actual + 'px';
            actions.style.left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)) + 'px';
            const top = downward ? anchor.bottom + 5 : anchor.top - 5 - actual;
            actions.style.top = Math.max(8, Math.min(top, height - actual - 8)) + 'px';
        }
        function schedulePosition(event) {
            if (event && activeMenu && activeMenu.actions.contains(event.target)) return;
            cancelAnimationFrame(positioningFrame); positioningFrame = requestAnimationFrame(positionMenu);
        }
        function openMenu(name) {
            hideMenu(); activeMenu = menus.get(name) || null;
            state.openSnapshot = activeMenu ? name : null;
            if (!activeMenu) return;
            activeMenu.operations.open = true;
            activeMenu.trigger.setAttribute('aria-expanded', 'true');
            if (typeof activeMenu.actions.showPopover === 'function') activeMenu.actions.showPopover();
            positionMenu();
        }
        document.addEventListener('pointerdown', event => {
            if (activeMenu && !activeMenu.operations.contains(event.target)) closeMenu();
        }, {signal:events.signal});
        window.addEventListener('resize', schedulePosition, {signal:events.signal});
        window.addEventListener('scroll', schedulePosition, {capture:true,passive:true,signal:events.signal});
        const resize = new ResizeObserver(schedulePosition); resize.observe(container);
        controllers.set(container, {dispose(preserve) {
            const focused = activeMenu && activeMenu.operations.contains(document.activeElement)
                ? {snapshot:state.openSnapshot, action:document.activeElement.dataset.snapshotAction || 'trigger'} : null;
            events.abort(); resize.disconnect(); cancelAnimationFrame(positioningFrame);
            if (preserve) hideMenu(); else closeMenu();
            return focused;
        }});
        function actionButton(label, action, extra, enabled) {
            const button = element('button', label);
            if(global.zfsmSnapshotActionHelp[action])button.title=global.zfsmSnapshotActionHelp[action];
            button.type = 'button';
            button.disabled = !enabled;
            button.addEventListener('click', function () {
                if (button.disabled || typeof options.onAction !== 'function') return;
                closeMenu();
                options.onAction(action, Object.assign({}, context, extra || {}));
            });
            return button;
        }

        container.replaceChildren();
        const toolbar = element('div', undefined, 'zfsm-buttons');
        function toolbarIcon(control, label, action, drawing) {
            control.replaceChildren(); control.classList.add('zfsm-snapshot-action-button');
            control.setAttribute('aria-label',label);
            control.setAttribute('aria-description',global.zfsmSnapshotActionHelp[action]);
            control.title=label+' — '+global.zfsmSnapshotActionHelp[action];
            const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS(svg.namespaceURI,'path');
            svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');
            svg.setAttribute('width','18');svg.setAttribute('height','18');
            path.setAttribute('d',drawing);svg.append(path);control.append(svg,element('span',label));return control;
        }
        toolbar.appendChild(toolbarIcon(actionButton('Take Snapshot', 'snapshotdataset', null, fresh&&Boolean(node.guid)), 'Take Snapshot', 'snapshotdataset', 'M3 7h4l2-3h6l2 3h4v13H3Z M16 13a4 4 0 1 0-8 0 4 4 0 0 0 8 0'));
        const destroySelected = element('button', 'Destroy selected snapshots');
        destroySelected.title=global.zfsmSnapshotActionHelp.destroysnapshot;
        destroySelected.type = 'button';
        destroySelected.addEventListener('click', function () {
            if (destroySelected.disabled || typeof options.onAction !== 'function') return;
            const selected = snapshots.filter(snapshot => state.selected.has(snapshot.name)).map(snapshot => snapshot.name);
            if (selected.length) options.onAction('destroysnapshot', Object.assign({}, context, { snapshots: selected }));
        });
        toolbarIcon(destroySelected,'Destroy selected snapshots','destroysnapshot','M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7');
        destroySelected.classList.add('zfsm-danger');
        toolbar.appendChild(destroySelected);
        const count = element('span', undefined, 'zfsm-muted zfsm-snapshot-count');
        count.setAttribute('aria-live', 'polite');
        toolbar.appendChild(count);
        container.appendChild(toolbar);
        const help = element('details', undefined, 'zfsm-snapshot-help');
        help.appendChild(element('summary', 'What do snapshot actions do?'));
        const explanations = element('dl', undefined, 'zfsm-properties');
        for (const [label,action] of [['Take Snapshot','snapshotdataset'],['Rename','renamesnapshot'],['Hold','holdsnapshot'],['Release','releasesnapshot'],['Clone','clonesnapshot'],['Rollback','rollbacksnapshot'],['Destroy','destroysnapshot']]) {
            explanations.append(element('dt',label),element('dd',global.zfsmSnapshotActionHelp[action]));
        }
        for (const [label,description] of [['Used','Blocks referenced exclusively by this snapshot. Deleting adjacent snapshots can change this value.'],['Referenced','Data accessible from this snapshot, including blocks shared with other snapshots or the dataset.'],['Written','Data written since the previous snapshot. This is not the amount a deletion will reclaim.']]) explanations.append(element('dt',label),element('dd',description));
        explanations.append(element('p','Snapshot Used, Referenced and Written values cannot be summed to predict reclaimable space. Holds and clone dependencies can prevent deletion.'));
        help.appendChild(explanations);container.appendChild(help);

        function notice(text, failed) {
            const message = element('p', text, failed ? 'zfsm-notice zfsm-error' : 'zfsm-notice');
            message.setAttribute('role', failed ? 'alert' : 'status');
            container.appendChild(message);
        }
        if (error) notice('Unable to load snapshots: ' + error + (snapshots.length ? ' Retained snapshot inventory is stale; refresh before acting on these rows.' : ''), true);
        else if (malformed) notice('Snapshot inventory is unavailable. Refresh to read the snapshot list.' + (snapshots.length ? ' Retained snapshot inventory is stale.' : ''), true);
        else if (!loaded) notice('Loading snapshots…' + (snapshots.length ? ' Showing retained snapshot inventory; it may be stale.' : ''), false);
        else if (!snapshots.length) notice('No snapshots for this dataset.', false);
        if (!destructive) notice('Destructive Mode is disabled. Enable it in Settings to destroy snapshots or roll back.', false);

        const controls = element('div', undefined, 'zfsm-snapshot-controls');
        const scopeLabel=element('label','Scope','zfsm-snapshot-sort'),scope=element('select');scope.setAttribute('aria-label','Snapshot scope');for(const [value,label] of [['direct','Direct dataset'],['recursive','Dataset and descendants']]){const option=element('option',label);option.value=value;scope.append(option);}scope.value=state.scope||'direct';scope.addEventListener('change',()=>{state.scope=scope.value;state.page=1;zfsmRenderSnapshots(container,options);},{signal:events.signal});scopeLabel.append(scope);controls.append(scopeLabel);
        if (Array.isArray(options.datasets) && typeof options.onDataset === 'function') {
            const datasetLabel = element('label', 'Dataset', 'zfsm-snapshot-sort');
            const dataset = element('select'); dataset.setAttribute('aria-label', 'Dataset');
            const names = [...new Set(options.datasets.filter(name => typeof name === 'string' && (name === pool || name.startsWith(pool + '/'))))];
            for (const name of names) { const option = element('option', name); option.value = name; dataset.appendChild(option); }
            dataset.value = node.name || '';
            dataset.addEventListener('change', () => {
                if (names.includes(dataset.value) && dataset.value !== node.name) options.onDataset(dataset.value);
            }, {signal:events.signal});
            datasetLabel.appendChild(dataset); controls.appendChild(datasetLabel);
        }
        const searchLabel = element('label', 'Search snapshots', 'zfsm-snapshot-search');
        const search = element('input'); search.type = 'search'; search.value = state.query;
        search.setAttribute('aria-label', 'Search snapshots'); search.placeholder = 'Snapshot name or dataset path';
        searchLabel.appendChild(search); controls.appendChild(searchLabel);
        const sortLabel = element('label', 'Sort snapshots', 'zfsm-snapshot-sort');
        const sort = element('select'); sort.setAttribute('aria-label', 'Sort snapshots');
        for (const [value,label] of [['name','Name'],['creation','Creation date'],['used','Used'],['referenced','Referenced']]) {
            const option = element('option', label); option.value = value; sort.appendChild(option);
        }
        sort.value = state.sort; sortLabel.appendChild(sort); controls.appendChild(sortLabel);
        const directionLabel = element('label', 'Direction', 'zfsm-snapshot-sort');
        const direction = element('select'); direction.setAttribute('aria-label', 'Snapshot sort direction');
        for (const [value,label] of [['asc','Ascending'],['desc','Descending']]) {
            const option = element('option', label); option.value = value; direction.appendChild(option);
        }
        direction.value = state.direction; directionLabel.appendChild(direction); controls.appendChild(directionLabel);
        const pagination = element('div', undefined, 'zfsm-snapshot-pagination');
        const previous = element('button', 'Previous'), next = element('button', 'Next'), page = element('span');
        previous.type = next.type = 'button';
        previous.setAttribute('aria-label', 'Previous snapshots page'); next.setAttribute('aria-label', 'Next snapshots page');
        page.setAttribute('aria-live', 'polite'); pagination.append(previous, page, next); controls.appendChild(pagination);
        container.appendChild(controls);
        container.appendChild(element('p', 'Dataset: ' + (node.name || 'dataset') + (state.scope==='recursive'?' · Dataset and descendants.':' · Direct snapshots only.')+' Search also filters by dataset path.', 'zfsm-muted zfsm-snapshot-scope'));
        const bookmarks=element('details'),bookmarkHeading=element('summary','Bookmarks · '+(node._bookmarks?.status==='known'?node._bookmarks.entries.length:'Unknown'));bookmarks.append(bookmarkHeading);for(const entry of node._bookmarks?.entries||[])bookmarks.append(element('p',entry.name+' · GUID '+entry.guid));bookmarks.append(element('p','Bookmarks retain stream lineage, not file contents. Native capability/read failures remain Unknown.','zfsm-muted'));container.append(bookmarks);

        const wrap = element('div', undefined, 'zfsm-table-wrap');
        const table = element('table', undefined, 'zfsm-table zfsm-readable-table zfsm-snapshot-table');
        table.appendChild(element('caption', 'Snapshots for ' + (node.name || 'dataset')));
        const thead = element('thead');
        const header = element('tr');
        const selectHeader = element('th');
        selectHeader.scope = 'col';
        const all = element('input');
        all.type = 'checkbox';
        all.setAttribute('aria-label', 'Select visible page');
        selectHeader.appendChild(element('span', 'Select'));
        const selectAll = element('label', undefined, 'zfsm-select-all');
        selectAll.append(all, element('span', 'Select visible page'));
        toolbar.prepend(selectAll);
        header.appendChild(selectHeader);
        for (const label of ['Name', 'Used', 'Referenced', 'Written', 'Defer Destroy', 'Holds', 'Creation Date', 'Actions']) {
            const th = element('th', label);
            th.scope = 'col';
            header.appendChild(th);
        }
        thead.appendChild(header);
        table.appendChild(thead);

        function syncSelection() {
            const selected = snapshots.filter(snapshot => state.selected.has(snapshot.name)).length;
            const visibleSelected = visibleSnapshots.filter(snapshot => state.selected.has(snapshot.name)).length;
            all.disabled = !fresh || visibleSnapshots.length === 0;
            all.checked = visibleSnapshots.length > 0 && visibleSelected === visibleSnapshots.length;
            all.indeterminate = visibleSelected > 0 && visibleSelected < visibleSnapshots.length;
            destroySelected.disabled = !fresh || !destructive || selected === 0;
            const start = visibleSnapshots.length ? (state.page - 1) * pageSize + 1 : 0;
            const end = visibleSnapshots.length ? start + visibleSnapshots.length - 1 : 0;
            count.textContent = 'Showing ' + start + '–' + end + ' of ' + filteredSnapshots.length + ' matching snapshot' + (filteredSnapshots.length === 1 ? '' : 's') + ' (' + snapshots.length + ' total); ' + selected + ' selected across all pages';
            for (const control of rowChecks) control.input.checked = state.selected.has(control.name);
        }
        all.addEventListener('change', function () {
            for (const snapshot of visibleSnapshots) {
                if (all.checked) state.selected.add(snapshot.name);
                else state.selected.delete(snapshot.name);
            }
            syncSelection();
        });

        const body = element('tbody');
        function renderPage() {
            hideMenu(); menus.clear(); rowChecks.length = 0; body.replaceChildren();
            const query = state.query.trim().toLocaleLowerCase();
            filteredSnapshots = snapshots.filter(snapshot => (snapshot.name + ' ' + (snapshot.dataset || snapshot.name.split('@')[0])).toLocaleLowerCase().includes(query));
            filteredSnapshots.sort((left,right) => {
                let order;
                if (state.sort === 'name') order = left.name.localeCompare(right.name, undefined, {numeric:true});
                else {
                    const a = left[state.sort] === undefined || left[state.sort] === null || left[state.sort] === '' ? NaN : Number(left[state.sort]);
                    const b = right[state.sort] === undefined || right[state.sort] === null || right[state.sort] === '' ? NaN : Number(right[state.sort]);
                    if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.isFinite(a) ? -1 : Number.isFinite(b) ? 1 : left.name.localeCompare(right.name);
                    order = a - b;
                }
                return (state.direction === 'desc' ? -order : order) || left.name.localeCompare(right.name);
            });
            const pages = Math.max(1, Math.ceil(filteredSnapshots.length / pageSize));
            state.page = Math.max(1, Math.min(state.page, pages));
            visibleSnapshots = filteredSnapshots.slice((state.page - 1) * pageSize, state.page * pageSize);
            previous.disabled = state.page === 1; next.disabled = state.page === pages;
            page.textContent = 'Page ' + state.page + ' of ' + pages;
            for (const snapshot of visibleSnapshots) {
            const row = element('tr');
            const selection = element('td');
            const check = element('input');
            check.type = 'checkbox';
            check.value = snapshot.name;
            check.setAttribute('aria-label', 'Select snapshot ' + snapshot.name);
            check.disabled = !fresh;
            check.addEventListener('change', function () {
                if (check.checked) state.selected.add(snapshot.name);
                else state.selected.delete(snapshot.name);
                syncSelection();
            });
            rowChecks.push({ input: check, name: snapshot.name });
            selection.appendChild(check);
            row.appendChild(selection);
            const fields = [snapshot.name, bytes(snapshot.used), bytes(snapshot.referenced), bytes(snapshot.written),
                snapshot.defer_destroy ?? '—', snapshot.userrefs ?? '—', creation(snapshot.creation)];
            const labels = ['Name', 'Used', 'Referenced', 'Written', 'Defer Destroy', 'Holds', 'Creation Date'];
            for (const [index, value] of fields.entries()) {
                const cell = element('td', value); cell.dataset.label = labels[index];
                if (index === 0) {
                    cell.textContent = ''; cell.appendChild(element('span', value));
                    const names = values => Array.isArray(values) && values.every(name => typeof name === 'string' && name !== '') ? values.length ? values.join(', ') : 'None' : 'Unknown';
                    cell.appendChild(element('small',' · Clone dependencies: '+names(snapshot.clone_dependencies)+' · Hold names: '+names(snapshot.hold_names),'zfsm-muted'));
                    cell.appendChild(element('small',' · Origin: '+(snapshot.provenance||'Unknown')+' · Retention: '+(snapshot.retention_policy||'Unknown')+' · Replication references: '+(snapshot.replication_refs?.length?snapshot.replication_refs.join(', '):'Unknown')+' · Last verified replication: '+(snapshot.last_verified_replication||'Unknown'),'zfsm-muted'));
                }
                row.appendChild(cell);
            }
            const actionsCell = element('td');
            actionsCell.dataset.label = 'Actions';
            const fileManager = actionButton('File Manager', 'browsesnapshot', { snapshot: snapshot.name }, fresh && context.type === 'filesystem');
            fileManager.dataset.fileManager = snapshot.name;
            actionsCell.appendChild(fileManager);
            const operations = element('details', undefined, 'zfsm-operations');
            const trigger = element('summary', 'Operations');
            trigger.setAttribute('role', 'button'); trigger.setAttribute('aria-expanded', 'false');
            trigger.setAttribute('aria-label', 'Operations');
            trigger.setAttribute('aria-haspopup', 'true');
            trigger.setAttribute('aria-description', 'Snapshot operations for ' + snapshot.name);
            const actions = element('div', undefined, 'zfsm-operation-list');
            actions.setAttribute('popover', 'manual');
            actions.setAttribute('role', 'group');
            actions.setAttribute('aria-label', 'Operations for ' + snapshot.name);
            operations.append(trigger, actions);
            menus.set(snapshot.name, {operations,trigger,actions});
            trigger.addEventListener('click', event => {
                event.preventDefault();
                if (state.openSnapshot === snapshot.name) closeMenu(); else openMenu(snapshot.name);
            });
            operations.addEventListener('keydown', event => {
                const buttons = Array.from(actions.querySelectorAll('button:enabled'));
                if (event.key === 'Tab') requestAnimationFrame(() => {
                    if (operations.isConnected && activeMenu && activeMenu.operations === operations && !operations.contains(document.activeElement)) closeMenu();
                });
                if (event.key === 'Escape') { event.preventDefault(); closeMenu(); trigger.focus({preventScroll:true}); }
                else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key) && buttons.length) {
                    event.preventDefault(); if (!operations.open) openMenu(snapshot.name);
                    const index = buttons.indexOf(document.activeElement);
                    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length-1 : event.key === 'ArrowDown' ? (index+1)%buttons.length : index<0 ? buttons.length-1 : (index-1+buttons.length)%buttons.length;
                    buttons[next].focus({preventScroll:true});
                }
            });
            for (const [label, action, dangerous, icon] of [
                ['Restore Files / Browse', 'browsesnapshot', false, '▱'], ['Rename', 'renamesnapshot', false, '✎'], ['Hold', 'holdsnapshot', false, '▣'], ['Release', 'releasesnapshot', false, '□'],
                ['Clone', 'clonesnapshot', false, '⧉'], ['Rollback', 'rollbacksnapshot', true, '↶'], ['Destroy', 'destroysnapshot', true, '×']
            ]) {
                const button = actionButton(label, action, { snapshot: snapshot.name }, fresh && (!dangerous || destructive) && (action !== 'browsesnapshot' || context.type === 'filesystem'));
                const symbol = element('span', icon, 'zfsm-operation-icon'); symbol.setAttribute('aria-hidden', 'true'); button.prepend(symbol);
                if (dangerous) button.classList.add('zfsm-danger');
                button.title = global.zfsmSnapshotActionHelp[action] + '\nTarget: ' + snapshot.name;
                button.setAttribute('aria-description',global.zfsmSnapshotActionHelp[action]);
                button.dataset.snapshotAction = action;
                actions.appendChild(button);
            }
            actionsCell.appendChild(operations);
            row.appendChild(actionsCell);
            body.appendChild(row);
            }
            const empty = body.querySelector('tr');
            if (!empty && snapshots.length) {
                const row = element('tr'), cell = element('td', 'No snapshots match this search.'); cell.colSpan = 9; row.appendChild(cell); body.appendChild(row);
            }
            syncSelection();
            if (state.openSnapshot) {
                openMenu(state.openSnapshot);
                if (activeMenu && restoreFocus && restoreFocus.snapshot === state.openSnapshot) {
                    const target = Array.from(activeMenu.actions.querySelectorAll('button:enabled')).find(button => button.dataset.snapshotAction === restoreFocus.action);
                    (target || activeMenu.trigger).focus({preventScroll:true});
                }
            }
        }
        table.appendChild(body);
        wrap.appendChild(table);
        container.appendChild(wrap);
        function changeView() { closeMenu(); state.page = 1; renderPage(); }
        search.addEventListener('input', () => { state.query = search.value; changeView(); });
        sort.addEventListener('change', () => { state.sort = sort.value; changeView(); });
        direction.addEventListener('change', () => { state.direction = direction.value; changeView(); });
        previous.addEventListener('click', () => { if (previous.disabled) return; closeMenu(); state.page--; renderPage(); });
        next.addEventListener('click', () => { if (next.disabled) return; closeMenu(); state.page++; renderPage(); });
        renderPage();
        wrap.scrollLeft = scroll.left; container.scrollTop = scroll.top;
    }

    global.zfsmRenderSnapshots = zfsmRenderSnapshots;
    global.zfsmDisposeSnapshots = zfsmDisposeSnapshots;
})(globalThis);
