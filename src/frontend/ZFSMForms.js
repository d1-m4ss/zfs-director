/* Embedded administrative forms. The caller owns authentication and refresh. */
(function (global) {
  'use strict';
  const destructive = new Set(['destroydataset', 'destroysnapshot', 'rollbacksnapshot', 'deletedirectory', 'cleanupmutation', 'movedirectory', 'convertdirectory', 'resumeconversion', 'publishconversion', 'lockdataset']);
  const titles = {
    createdataset: 'Create dataset', editdatasetproperty: 'Edit properties', renamedataset: 'Rename dataset', destroydataset: 'Destroy dataset',
    lockdataset: 'Lock dataset', unlockdataset: 'Unlock dataset', promotedataset: 'Promote clone', adddirectortlisting: 'Show folders in tree',
    removedirectorylisting: 'Hide folders in tree', movedirectory: 'Move directory', convertdirectory: 'Convert directory to dataset', deletedirectory: 'Delete directory', cleanupmutation: 'Clean completed recovery',
    snapshotdataset: 'Create snapshot', renamesnapshot: 'Rename snapshot', holdsnapshot: 'Hold snapshot', releasesnapshot: 'Release snapshot hold',
    clonesnapshot: 'Clone snapshot', rollbacksnapshot: 'Rollback snapshot', destroysnapshot: 'Destroy snapshots', cancelconversion: 'Cancel conversion',
    resumeconversion: 'Resume conversion', publishconversion: 'Publish verified conversion copy', cancelrestore: 'Cancel file operation', saveconfig: 'Settings', setquota:'User / group quotas',editacl:'POSIX ACL editor'
  };
  const snapshotHelp = {
    snapshotdataset: 'Use when you need a restore point before changing or deleting files. Captures the current dataset state without stopping applications; stop writers first if you need application-consistent data.',
    renamesnapshot: 'Use when you need a clearer name for this restore point. Changes the snapshot name without changing its saved files.',
    holdsnapshot: 'Use when you need to protect a snapshot from deletion. Adds the zfsmaster hold; it does not change dataset files.',
    releasesnapshot: 'Use when you need to remove deletion protection from a snapshot. Removes only the zfsmaster hold; it does not restore files. Other holds can still protect it.',
    clonesnapshot: 'Use when you need to recover individual files or inspect an older state safely. Creates a separate writable dataset based on the snapshot and keeps the current dataset unchanged.',
    rollbacksnapshot: 'Use when you need to restore the entire dataset to this snapshot. Deleted files return; later file changes are lost. Stop applications writing here first. For individual files, use Restore Files. Clone creates a separate writable dataset.',
    destroysnapshot: 'Use when you no longer need this restore point. Permanently removes the snapshot; current dataset files stay as they are. Holds or dependent clones can block deletion.'
  };
  snapshotHelp.browsesnapshot = 'Browse the saved files without changing the snapshot. Download a file or restore selected files and folders to the current dataset.';
  global.zfsmSnapshotActionHelp = snapshotHelp;
  const propertyLabels = { mountpoint: 'Mountpoint', compression: 'Compression', quota: 'Quota (bytes or ZFS size, 0 for unlimited)', refquota:'Referenced quota (bytes or ZFS size)', reservation:'Reservation (bytes or ZFS size)', refreservation:'Refreservation (bytes or ZFS size)', recordsize: 'Record size', atime: 'Access time', xattr: 'Extended attributes', primarycache: 'Primary cache', readonly: 'Read only', sync: 'Sync' };
  const propertyHelp = {
    mountpoint: 'Directory where this filesystem appears. Changing it can affect application paths and require remounting.',
    compression: 'Compress newly written data to save space. Existing blocks are not recompressed automatically. lz4 prioritises speed.',
    refquota:'Limit referenced data in this dataset; children and snapshots are excluded. Use 0 for unlimited.',reservation:'Minimum space reserved for this dataset and descendants. Use 0 for none.',refreservation:'Minimum space reserved for this dataset alone. Use 0 for none.',
    quota: 'Space limit for this dataset, snapshots and children. Use 0 for unlimited; reaching the limit blocks further allocation.',
    recordsize: 'Suggested file block size. Tune for your workload; changes affect newly created files, not existing files.',
    atime: 'Record when files are read. off avoids access-time updates; some applications may need on.',
    xattr: 'Extended file metadata, used by ACLs and applications. sa stores it efficiently; off disables extended attributes.',
    primarycache: 'What ZFS caches in RAM: all includes file data; metadata caches only metadata; none disables this cache.',
    readonly: 'on prevents modifications to this dataset. off permits writes subject to permissions.',
    sync: 'standard honours application durability requests. always makes every write synchronous. disabled ignores durability requests and risks losing acknowledged writes after a crash.'
  };
  const propertyOptions = {
    compression: ['inherit', 'off', 'on', 'lz4', 'gzip', 'zstd'], recordsize: ['inherit', '512', '4096', '8192', '16384', '65536', '131072', '1048576'],
    atime: ['inherit', 'off', 'on'], xattr: ['inherit', 'sa', 'on', 'off'], primarycache: ['inherit', 'all', 'metadata', 'none'],
    readonly: ['inherit','off', 'on'], sync: ['inherit','standard', 'always', 'disabled']
  };
  let sequence = 0;
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function failureText(answer) {
    return Object.entries(answer && answer.failed || {}).map(([name, value]) => String(value).startsWith(name + ':') ? String(value) : name + ': ' + String(value)).join('\n');
  }
  function snapshotDeletionIssue(snapshot, message) {
    let text = String(message), prefix = snapshot + ': ';
    while (text.startsWith(prefix)) text = text.slice(prefix.length);
    if (/snapshot has dependent clones/i.test(text)) {
      const objects = text.match(/following datasets:\s*([\s\S]*)/i);
      return 'Deletion blocked: other clones depend on this snapshot.\nTo keep a clone, open that dataset → Actions → Promote clone, then retry.\nTo remove an unwanted clone, use Destroy dataset and review its preview first.' + (objects ? '\nDependent objects: ' + objects[1].trim() : '');
    }
    return text;
  }
  function usableAnswer(answer) {
    return answer && typeof answer === 'object' && !Array.isArray(answer) && answer.succeeded && typeof answer.succeeded === 'object' && answer.failed && typeof answer.failed === 'object';
  }
  function immutableContext(context) {
    const copy = {};
    for (const key of ['pool', 'dataset', 'type', 'snapshot', 'directory', 'property']) if (typeof context[key] === 'string') copy[key] = context[key];
    for(const key of ['identity_map','snapshot_identities','directory_identity'])copy[key]=Object.freeze(Object.assign({},context[key]||{}));
    copy.node = Object.freeze(Object.assign({}, context.node || {}));
    copy.job = Object.freeze(Object.assign({}, context.job || {}));
    copy.snapshots = Object.freeze(Array.isArray(context.snapshots) ? context.snapshots.filter(name => typeof name === 'string').slice() : []);
    copy.datasets = Object.freeze(Array.isArray(context.datasets) ? context.datasets.filter(name => typeof name === 'string' && name).slice() : []);
    return Object.freeze(copy);
  }
  global.zfsmCreateInlineForms = function zfsmCreateInlineForms(options) {
    const request = options.request;
    const getConfig = options.getConfig || (() => ({}));
    const getDatasets = options.getDatasets || (() => []);
    const getOperationIssue = options.getOperationIssue || (() => '');
    const getMutationFields = options.getMutationFields || (() => ({}));
    const onComplete = options.onComplete || (() => {});
    const onClose = options.onClose || (() => {});
    const drafts = new Map();
    const settingsDraftOwners = new Map();
    const runningActions = new Set();
    let active = null;
    let generation = 0;
    function current(state) { return active === state && state.generation === generation; }
    function remember(state) {
      if (!state) return;
      if (state.action === 'saveconfig') {
        const draft = {};
        for (const name of state.dirtySettings || []) if (state.fields[name]) draft[name] = value(state, name);
        state.draft = draft;
        drafts.set(state.key, draft);
        settingsDraftOwners.set(state.key, state);
        return;
      }
      // A property read can be deactivated before its inputs are built. Keep the
      // previous nonsecret values rather than replacing that draft with {}.
      const draft = Object.assign({}, state.draft);
      if (state.form.querySelector('[name="snapshot_selection"]')) draft.snapshot_selection = [];
      for (const control of state.form.elements) {
        if (!control.name || control.type === 'password' || control.type === 'hidden' || ['acknowledge', 'offline_confirmed'].includes(control.name)) continue;
        if (control.name === 'snapshot_selection') {
          if (!draft.snapshot_selection) draft.snapshot_selection = [];
          if (control.checked) draft.snapshot_selection.push(control.value);
        } else draft[control.name] = control.type === 'checkbox' ? control.checked : control.value;
      }
      if (state.batchFailures) draft.snapshot_failures = Object.assign({}, state.batchFailures);
      drafts.set(state.key, draft);
    }
    function clearSecrets(state) {
      if (state) for (const input of state.form.querySelectorAll('input[type="password"]')) input.value = '';
    }
    function dispose() {
      if (active) {
        remember(active);
        clearSecrets(active);
        clearConfirmation(active);
        active.preview = null;
        active.previewGeneration++;
        active.form.remove();
      }
      active = null;
      generation++;
    }
    function note(state, text, error) {
      state.result.textContent = String(text);
      state.result.className = error ? 'zfsm-error' : 'zfsm-notice';
      delete state.result.dataset.result;
      delete state.result.dataset.severity;
      state.result.setAttribute('role', error ? 'alert' : 'status');
    }
    function policy(state, exactTargets) {
      const { action, context: ctx } = state;
      const targets = state.batchRows ? Array.from(state.batchRows.entries()).filter(([, row]) => row.select.checked).map(([name]) => name)
        : ctx.snapshot ? [ctx.snapshot] : ctx.snapshots;
      const issue = getOperationIssue(action, ctx, exactTargets || targets);
      if (issue) return issue;
      if (destructive.has(action) && Number(getConfig().destructive_mode) !== 1) return 'Destructive Mode is disabled. Enable it in Settings before this operation.';
      if (action === 'destroydataset' && (!ctx.dataset || !ctx.dataset.includes('/') || ctx.dataset.includes('@'))) return 'Pool root destruction is not allowed.';
      if (action === 'lockdataset') {
        const node = ctx.node;
        if (ctx.type === 'volume' || node.type === 'volume') return 'Only a filesystem encryption root can be locked.';
        if (!node.encryption || node.encryption === 'off' || node.keystatus !== 'available' || node.encryptionroot !== ctx.dataset) return 'Only an unlocked encryption root can be locked. Open its encryption root to manage the inherited key.';
      }
      if (action === 'unlockdataset' && (ctx.type === 'volume' || ctx.node.type === 'volume' || !ctx.node.encryption || ctx.node.encryption === 'off' || (ctx.node.keystatus !== 'unavailable'&&!ctx.node._encryption_recovery) || ctx.node.encryptionroot !== ctx.dataset)) return 'Only a locked filesystem encryption root or saved mount recovery can be unlocked. Open its encryption root to manage the inherited key.';
      if (action === 'promotedataset' && ctx.node.origin === '-') return 'This dataset is not a clone.';
      if(action==='setquota'&&(ctx.type==='volume'||ctx.node.type==='volume'))return 'User/group and object quotas apply to filesystems, not zvols.';
      if (['cancelconversion', 'resumeconversion', 'publishconversion', 'cancelrestore'].includes(action) && !ctx.job.id) return 'A background job is required.';
      if (action === 'resumeconversion' && (ctx.job.state === 'completed' || (ctx.job.schema !== undefined && ctx.job.schema !== 1))) return 'This job requires manual recovery or has already completed.';
      if (action === 'cancelconversion' && ctx.job.schema !== undefined && ctx.job.schema !== 1) return 'Legacy journals require manual recovery.';
      if (action === 'createdataset' && !ctx.pool) return 'Select a pool before creating a dataset.';
      return '';
    }
    function field(state, name, label, value, choices, attrs) {
      const wrap = element('label', undefined, 'zfsm-field');
      const caption = element('span', label);
      let control;
      attrs = attrs || {};
      if (attrs.type === 'textarea') control = element('textarea');
      else if (choices) {
        control = element('select');
        const values = choices.map(choice => Array.isArray(choice) ? choice : [choice, choice]);
        if (value !== undefined && value !== null && !values.some(choice => String(choice[0]) === String(value))) values.push([String(value), String(value) + ' (current)']);
        for (const [itemValue, itemLabel] of values) {
          const option = element('option', itemLabel);
          option.value = String(itemValue);
          control.append(option);
        }
      } else {
        control = element('input');
        control.type = attrs.type || 'text';
      }
      control.name = name;
      control.id = 'zfsm-field-' + (++sequence);
      if (control.type !== 'password' && Object.prototype.hasOwnProperty.call(state.draft, name)) value = state.draft[name];
      if (control.type === 'checkbox') control.checked = Boolean(value);
      else control.value = value === undefined || value === null ? '' : String(value);
      for (const [attr, val] of Object.entries(attrs)) {
        if (attr !== 'type') control[attr] = val;
      }
      if (control.type === 'password') { control.autocomplete = 'off'; control.maxLength = 512; control.spellcheck = false; }
      wrap.htmlFor = control.id;
      wrap.dataset.field = name;
      if (control.type === 'hidden') {
        state.form.append(control);
        state.fields[name] = control;
        return control;
      }
      if (control.type === 'checkbox') wrap.append(control, caption);
      else wrap.append(caption, control);
      state.grid.append(wrap);
      state.fields[name] = control;
      return control;
    }
    function checkbox(state, name, label) { return field(state, name, label, false, null, { type: 'checkbox' }); }
    function value(state, name) {
      const control = state.fields[name];
      return control && control.type === 'checkbox' ? (control.checked ? '1' : '0') : (control ? control.value : '');
    }
    function enable(state) {
      state.form.setAttribute('aria-busy',String(!!(state.busy||state.validationBusy||runningActions.has(state.key))));
      state.form.dataset.phase=state.completed?'completed':state.busy||runningActions.has(state.key)?'busy':'idle';
      // Renaming/moving/deleting retires this form's immutable target. Preserve
      // the confirmed result instead of treating its old name as a stale error.
      if (state.completed) {
        for (const button of state.form.querySelectorAll('button')) button.disabled = !button.hasAttribute('data-view-job')&&!button.hasAttribute('data-close-action');
        return;
      }
      const blocked = policy(state);
      // A refresh can temporarily block mutations. Keep the reviewed immutable
      // target visible, but disabled; the click path rechecks policy/signature.
      const busy = state.busy || state.validationBusy || runningActions.has(state.key);
      const checked = (!state.fields.acknowledge || state.fields.acknowledge.checked) && (!state.fields.offline_confirmed || state.fields.offline_confirmed.checked);
      const previewReady = !state.requiresPreview || (state.preview && state.preview.canProceed);
      const selectionReady = state.action !== 'destroysnapshot' || Array.from(state.form.querySelectorAll('[name="snapshot_selection"]:checked')).length > 0;
      for (const button of state.form.querySelectorAll('button')) button.disabled = button.hasAttribute('data-close-action')?false:button.hasAttribute('data-view-job') ? busy : busy || !!blocked || (button.type === 'submit' && (!checked || !previewReady || !selectionReady || state.previewBusy));
      if (state.pendingConfirmation) {
        for (const button of state.form.querySelectorAll('button[type="submit"]')) button.disabled = true;
        state.pendingConfirmation.confirm.disabled = busy || !!blocked || !checked || !previewReady || !selectionReady || state.previewBusy;
        state.pendingConfirmation.cancel.disabled = busy;
      }
      if (state.previewButton) state.previewButton.disabled = busy || state.previewBusy || !!blocked;
      if (state.batchRows) for (const row of state.batchRows.values()) row.select.disabled = busy || !!row.deleted;
      if(blocked){if(!state.policyNotice){state.policyNotice=element('p',undefined,'zfsm-error');state.policyNotice.setAttribute('role','alert');state.grid.before(state.policyNotice);}state.policyNotice.textContent=blocked;}else if(state.policyNotice){state.policyNotice.remove();state.policyNotice=null;}
      state.policyIssue = blocked;
    }
    function acknowledgment(state, text) { checkbox(state, 'acknowledge', text || 'I understand this operation cannot be undone and confirm the target shown above.'); }
    // A blocked deletion offers only a recheck; the confirmation controls return once it is free.
    function stopProcessesButton(state, processes) {
      state.stopButton?.remove(); state.stopButton = null;
      if (state.action !== 'destroydataset' || !state.buttons || !processes.length) return;
      const button = element('button', 'Stop ' + (processes.length === 1 ? '1 process' : processes.length + ' processes'), 'zfsm-danger');
      button.type = 'button'; button.dataset.stopProcesses = '';
      button.addEventListener('click', () => {
        if (!current(state) || state.previewBusy) return;
        state.stopConfirm?.remove();
        const panel = element('section', undefined, 'zfsm-destroy-stop');
        panel.append(element('h4', 'Stop processes?'), element('p', 'These will be closed (SIGTERM). Unsaved work in them is lost.'));
        for (const row of processes) panel.append(element('p', row.command + ' · PID ' + row.pid));
        const actions = element('div', undefined, 'zfsm-buttons'), confirm = element('button', 'Stop processes', 'zfsm-danger'), cancel = element('button', 'Cancel');
        confirm.type = cancel.type = 'button'; confirm.dataset.confirmStop = '';
        cancel.addEventListener('click', () => { panel.remove(); state.stopConfirm = null; button.hidden = false; });
        confirm.addEventListener('click', async () => {
          confirm.disabled = cancel.disabled = true;
          try {
            const answer = await request({ cmd: 'stopdestroyprocesses', zdataset: state.context.dataset, force: value(state, 'force'), processes: processes.map(row => row.pid + ':' + row.start) });
            if (!current(state)) return;
            const failed = Object.values(answer?.failed || {});
            panel.remove(); state.stopConfirm = null;
            // Give SIGTERM a moment, then recheck exactly as Check again would.
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (!current(state)) return;
            await loadPreview(state);
            if (failed.length) note(state, failed.join(' '), true);
          } catch (error) { if (current(state)) { note(state, 'Stopping processes failed: ' + String(error.message || error), true); confirm.disabled = cancel.disabled = false; } }
        });
        actions.append(confirm, cancel); panel.append(actions);
        state.previewBox.append(panel); state.stopConfirm = panel; button.hidden = true;
      });
      state.buttons.prepend(button); state.stopButton = button;
    }
    function showDestroyControls(state, free) {
      const ack = state.fields.acknowledge?.closest('label'), submit = state.buttons?.querySelector('button[type="submit"]');
      if (ack) ack.hidden = !free;
      if (submit) submit.hidden = !free;
      if (state.previewButton && state.buttons && state.modal) {
        state.previewButton.textContent = 'Check again';
        state.previewButton.hidden = free;
        state.buttons.prepend(state.previewButton);
      }
    }
    function invalidatePreview(state) {
      clearConfirmation(state);
      state.stopButton?.remove(); state.stopButton = null; state.stopConfirm = null;
      for (const old of state.jobLinks || []) old.remove(); state.jobLinks = [];
      state.preview = null;
      state.previewGeneration++;
      state.previewBusy = false;
      if (state.fields.acknowledge) state.fields.acknowledge.checked = false;
      if (state.previewBox) state.previewBox.replaceChildren(element('p', 'Load a fresh preview and review every listed object before confirming.'));
      if (state.previewButton && state.previewButton.hidden) state.previewButton.hidden = false;
      enable(state);
    }
    function renderDestroyDiagnostics(host, diagnostics) {
      if (!diagnostics) return;
      const panel = element('section', undefined, 'zfsm-destroy-diagnostics');
      panel.append(element('strong', 'Live filesystem references'));
      const reasons = {foreign_mount:'Mount retained in a foreign namespace',additional_mount:'Additional or bind mount',nested_mount:'Nested mount owned by another filesystem',snapshot_mount:'Mounted snapshot',cwd:'Process working directory',open_file:'Open file reference'};
      for (const row of diagnostics.blockers || []) {
        const entry = element('p', undefined, 'zfsm-error');
        entry.textContent = row.dataset + ': ' + (reasons[row.kind] || row.kind) + ' · ' + row.mountpoint + ' · PID ' + row.pid + ' (' + row.command + ') · ' + row.namespace + (row.container ? ' · Container ' + (row.container_name ? row.container_name + ' (' + row.container.slice(0,12) + ')' : row.container.slice(0,12)) : '');
        panel.append(entry);
      }
      if (diagnostics.blocked) panel.append(element('p', 'Force can\'t release busy mounts held by another Linux namespace. Stop these processes or unmount through their owner, then press Check again.'));
      for (const warning of diagnostics.warnings || []) panel.append(element('p', warning, 'zfsm-muted'));
      host.append(panel);
    }
    function renderDestroySummary(host, answer) {
      const summary = element('section', undefined, 'zfsm-destroy-summary');
      const objects = Array.isArray(answer.objects) ? answer.objects : null;
      const dependencies = Array.isArray(answer.dependencies) ? answer.dependencies : null;
      const typed = objects && objects.every(row => ['filesystem', 'volume', 'snapshot'].includes(row?.type));
      const datasets = typed ? objects.filter(row => row.type !== 'snapshot').length : null;
      const snapshots = typed ? objects.length - datasets : null;
      const count = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
      summary.append(element('p', answer.target + ' · ' + (typed ? count(datasets, 'dataset') + ' · ' + count(snapshots, 'snapshot') : objects ? count(objects.length, 'object') : 'object count unknown') + ' · ' + (typeof answer.recursive === 'boolean' ? answer.recursive ? 'recursive' : 'selected object only' : 'scope unknown'), 'zfsm-muted'));
      const services = Array.isArray(answer.service_blockers) ? answer.service_blockers : [];
      const busy = answer.diagnostics?.blocked === true;
      // One verdict box: what holds the dataset and where to release it, or that it is free.
      const verdict = element('section', undefined, answer.can_destroy === true ? 'zfsm-destroy-verdict zfsm-destroy-ok' : 'zfsm-destroy-verdict zfsm-destroy-services');
      if (answer.can_destroy === true) verdict.append(element('p', '✓ Not in use. Deleting can\'t be undone.', 'zfsm-success'));
      const names = {smb:'SMB share',nfs:'NFS export',docker:'Docker container',vm:'VM',additional_mount:'Additional mount',nested_mount:'Nested mount'};
      const fixes = {smb:row => 'Open Shares → ' + row.name + ', set SMB Export to No', nfs:() => 'Open Shares and set NFS Export to No', docker:row => 'Stop Docker container "' + row.name + '" or remove this path from it', vm:row => 'Remove this disk from VM "' + row.name + '"', additional_mount:row => 'Unmount ' + row.path, nested_mount:row => 'Unmount ' + row.path};
      for (const row of services) {
        const named = row?.name && !['nfs','additional_mount','nested_mount'].includes(row.kind);
        const who = (names[row?.kind] || 'Service reference') + (named ? ' "' + row.name + '"' : '');
        const fix = fixes[row?.kind] && (named || !['smb','docker','vm'].includes(row.kind)) ? fixes[row.kind](row) : 'Release it through its owner';
        verdict.append(element('p', '⛔ Can\'t delete: ' + who + ' uses ' + (row?.path || 'this dataset'), 'zfsm-error'), element('p', fix + ', then press Check again.', 'zfsm-error'));
      }
      const stoppable = Array.isArray(answer.stoppable_processes) ? answer.stoppable_processes : [];
      if (busy) {
        // Host processes the backend may stop get one readable line; everything else keeps its full evidence.
        const keys = new Set(stoppable.map(row => row.pid + ':' + row.start));
        const rest = (answer.diagnostics.blockers || []).filter(row => !keys.has(row.pid + ':' + row.start) || !['cwd','open_file'].includes(row.kind));
        if (stoppable.length) {
          const paths = [...new Set((answer.diagnostics.blockers || []).filter(row => keys.has(row.pid + ':' + row.start)).map(row => row.mountpoint))];
          verdict.append(element('p', '⛔ Can\'t delete: ' + (stoppable.length === 1 ? '1 process is' : stoppable.length + ' processes are') + ' inside ' + paths.join(', '), 'zfsm-error'),
            element('p', stoppable.map(row => row.command + ' (PID ' + row.pid + ')').join(' · '), 'zfsm-error'),
            element('p', 'A terminal opened in this folder counts too: cd out of it, or stop them here.', 'zfsm-error'));
        }
        if (rest.length) renderDestroyDiagnostics(verdict, {...answer.diagnostics, blockers: rest});
      }
      if (answer.can_destroy !== true && !services.length && !busy) verdict.append(element('p', '⛔ Can\'t delete: ' + (dependencies && dependencies.length ? 'clones outside this scope depend on it' : 'ZFS did not approve this scope (holds or a failed dry run)') + '. See Details.', 'zfsm-error'));
      summary.append(verdict);
      const details = element('details', undefined, 'zfsm-destroy-details');
      details.append(element('summary', 'Details'));
      function table(title, rows) {
        if (rows && !rows.length) return;
        details.append(element('strong', title));
        if (!rows) { details.append(element('p', 'Unknown — this preview did not report this information.', 'zfsm-muted')); return; }
        const wrap = element('div', undefined, 'zfsm-table-wrap'), table = element('table', undefined, 'zfsm-table zfsm-readable-table');
        const head = element('thead'), headings = element('tr'), body = element('tbody');
        const columns = [['Object', 'name'], ['Type', 'type'], ['GUID', 'guid'], ['Mountpoint', 'mountpoint'], ['Encryption root', 'encryptionroot'], ['Origin', 'origin'], ['Holds', 'holds']];
        for (const [label] of columns) { const cell = element('th', label); cell.scope = 'col'; headings.append(cell); }
        head.append(headings);
        for (const row of rows) {
          const line = element('tr');
          for (const [label, key] of columns) {
            let value = row?.[key];
            if (key === 'holds' && row?.type && row.type !== 'snapshot') value = 'Not applicable';
            else if (key === 'holds' && value === '') value = 'None';
            else if (value === '-') value = 'Not applicable';
            const cell = element('td', value === undefined || value === null || value === '' ? 'Unknown' : value); cell.dataset.label = label; line.append(cell);
          }
          body.append(line);
        }
        table.append(head, body); wrap.append(table); details.append(wrap);
      }
      table('Objects affected by deletion', objects);
      table('Clone dependencies — these can be outside the selected branch', dependencies);
      if (!busy && answer.diagnostics?.warnings?.length) renderDestroyDiagnostics(details, answer.diagnostics);
      details.append(element('strong', 'Raw ZFS dry-run'), element('pre', answer.preview || 'No usable preview'));
      summary.append(details);
      host.append(summary);
    }
    function renderDirectorySummary(host, answer) {
      const summary = element('section', undefined, 'zfsm-destroy-summary');
      summary.append(element('p', answer.target + ' · ' + (answer.recursive ? 'with all contents' : 'only if empty'), 'zfsm-muted'));
      const verdict = element('section', undefined, answer.can_delete ? 'zfsm-destroy-verdict zfsm-destroy-ok' : 'zfsm-destroy-verdict zfsm-destroy-services');
      if (answer.can_delete) { verdict.append(element('p', '✓ Not in use. Deleting can\'t be undone.', 'zfsm-success')); if (answer.note) verdict.append(element('p', answer.note)); }
      for (const row of answer.blockers) { verdict.append(element('p', '⛔ ' + row.title, 'zfsm-error')); if (row.fix) verdict.append(element('p', row.fix, 'zfsm-error')); }
      const names = {smb:'SMB share',nfs:'NFS export',docker:'Docker container',vm:'VM',additional_mount:'Additional mount',nested_mount:'Nested mount'};
      for (const row of answer.service_blockers || []) {
        const named = row?.name && !['nfs','additional_mount','nested_mount'].includes(row.kind);
        verdict.append(element('p', '⛔ Can\'t delete: ' + (names[row?.kind] || 'Service reference') + (named ? ' "' + row.name + '"' : '') + ' uses ' + (row?.path || 'this folder'), 'zfsm-error'), element('p', (row.kind === 'smb' && named ? 'Open Shares → ' + row.name + ', set SMB Export to No' : 'Release it through its owner') + ', then press Check again.', 'zfsm-error'));
      }
      summary.append(verdict);
      const details = element('details', undefined, 'zfsm-destroy-details');
      details.append(element('summary', 'Details'), element('p', 'Folder: ' + answer.target), element('p', 'Dataset: ' + (answer.dataset || 'Unknown')), element('p', 'Mode: ' + (answer.recursive ? 'Recursive: all files and subdirectories' : 'Only an empty folder')));
      summary.append(details);
      host.append(summary);
    }
    function jobButtons(state, ids) {
      for (const old of state.jobLinks || []) old.remove(); state.jobLinks = [];
      if (!state.buttons || !ids.length || typeof options.onViewJob !== 'function') return;
      for (const id of [...new Set(ids)]) { const link = element('button', 'Open Jobs'); link.type = 'button'; link.dataset.viewJob = id; link.addEventListener('click', () => options.onViewJob(id)); state.buttons.prepend(link); state.jobLinks.push(link); }
    }
    async function loadPreview(state) {
      if (!current(state) || state.previewBusy || state.busy || runningActions.has(state.key)) return;
      if (policy(state)) { enable(state); return; }
      invalidatePreview(state);
      state.previewBusy = true;
      const previewGeneration = state.previewGeneration;
      const rollback = state.action === 'rollbacksnapshot';
      const choice = previewChoice(state);
      if(state.action==='destroysnapshot'){
        const targets=Array.from(state.batchRows.entries()).filter(([,row])=>row.select.checked).map(([name])=>name);state.batchPreviews=new Map();state.previewBox.replaceChildren();let allowed=targets.length>0;
        try{for(const snapshot of targets){const answer=await request({cmd:'previewdestroy',snapshot,recursive:choice});if(!current(state)||previewGeneration!==state.previewGeneration)return;if(!answer?.token||answer.target!==snapshot)throw Error('Invalid snapshot deletion preview');state.batchPreviews.set(snapshot,answer);allowed=allowed&&answer.can_destroy===true;renderDestroySummary(state.previewBox,answer);}state.preview={choice,canProceed:allowed};note(state,allowed?'Review the exact deletion scope above, then acknowledge.':'Deletion blocked. Review dependencies and holds.',!allowed);}catch(error){note(state,'Preview failed: '+error.message,true);}finally{if(current(state)){state.previewBusy=false;enable(state);}}return;
      }
      state.previewBox.replaceChildren(element('p', 'Loading fresh server preview…'));
      enable(state);
      try {
        if(state.action==='cleanupmutation'){
          const answer=await request({cmd:'previewcleanup',directory:state.context.directory});
          if(!current(state)||previewGeneration!==state.previewGeneration)return;
          const review=answer?.review;
          if(!answer?.token||!answer.preview_id||review?.kind!=='cleanup'||review.name!==state.context.dataset||review.directory!==state.context.directory)throw new Error(failureText(answer)||'Invalid cleanup review');
          state.previewBox.replaceChildren(element('strong','Completed '+review.operation+' operation'),element('p','Only journal.jsonl remains ('+review.records+' records). No retained data was found.'),element('p','Journal SHA-256: '+review.journal_sha256),element('p','Director will save the journal in persistent plugin storage before removing this container. The private .zfsm-maintenance directory is kept for safe cleanup.'));
          state.preview={...answer,choice,canProceed:review.can_proceed===true};note(state,'Review this exact container and acknowledge before cleanup.',false);return;
        }
        if(state.action==='deletedirectory'){
          const answer=await request({cmd:'previewdeletedirectory',directory:state.context.directory,force:choice});
          if(!current(state)||previewGeneration!==state.previewGeneration)return;
          if(answer?.target!==state.context.directory||typeof answer.can_delete!=='boolean'||!Array.isArray(answer.blockers))throw new Error(failureText(answer)||'Invalid folder deletion check');
          state.previewBox.replaceChildren();renderDirectorySummary(state.previewBox,answer);
          state.preview={choice,canProceed:answer.can_delete};state.result.textContent='';state.result.className='';
          showDestroyControls(state,answer.can_delete);jobButtons(state,answer.can_delete?[]:answer.blockers.filter(row=>row.job).map(row=>row.job));return;
        }
        if(['promotedataset','setquota','editacl'].includes(state.action)){
          const quota=state.action==='setquota',acl=state.action==='editacl',answer=await request({cmd:quota?'previewquota':acl?'previewacl':'previewpromote',zdataset:state.context.dataset,...(quota?{data:{kind:value(state,'kind'),id:value(state,'id'),value:value(state,'value')}}:acl?{acl:value(state,'acl')}:{})});
          if(!current(state)||previewGeneration!==state.previewGeneration)return;
          if(!answer?.token||!answer.preview_id||answer.review?.name!==state.context.dataset||answer.review.kind!==(quota?'quota':acl?'acl':'promote'))throw new Error(failureText(answer)||'Invalid server review');
          const review=answer.review;state.previewBox.replaceChildren(element('strong',quota?'Quota change':acl?'Exact POSIX ACL change':'Clone dependency change'));
          if(acl)state.previewBox.append(element('strong','Previous ACL'),element('pre',review.previous),element('strong','Reviewed ACL'),element('pre',review.desired));
          else if(quota)state.previewBox.append(element('p',review.change.property+': '+review.previous+' → '+review.change.value));
          else{state.previewBox.append(element('p','Origin: '+review.origin));for(const row of review.affected_snapshots||[])state.previewBox.append(element('p',row.name+' · GUID '+row.guid));for(const name of review.conflicts||[])state.previewBox.append(element('p','Conflicting snapshot: '+name,'zfsm-error'));}
          if(review.warning)state.previewBox.append(element('p',review.warning,'zfsm-notice'));
          state.preview={...answer,choice,canProceed:review.can_proceed===true};note(state,'Review the native scope and acknowledge before applying.',false);return;
        }
        const data = rollback ? { cmd: 'previewrollback', snapshot: state.context.snapshot, destroy_newer: choice } : { cmd: 'previewdestroy', zdataset: state.context.dataset, force: choice };
        const answer = await request(data);
        if (!current(state) || previewGeneration !== state.previewGeneration) return;
        if (!answer || typeof answer.token !== 'string' || !/^[a-f0-9]{64}$/.test(answer.token)) throw new Error(failureText(answer) || 'The server returned an invalid preview.');
        let canProceed = true;
        state.previewBox.replaceChildren();
        if (rollback) {
          if (answer.snapshot !== state.context.snapshot || answer.destroy_newer !== (choice === '1') || typeof answer.can_rollback !== 'boolean' || !Array.isArray(answer.newer_snapshots) || !Array.isArray(answer.newer_bookmarks) || !answer.newer_snapshots.concat(answer.newer_bookmarks).every(name => typeof name === 'string')) throw new Error('The rollback preview does not match this request.');
          state.previewBox.append(element('p', 'All changes after ' + state.context.snapshot + ' will be discarded.'));
          state.previewBox.append(element('p', choice === '1' ? 'These newer objects will be permanently destroyed:' : 'These newer objects block rollback:'));
          for (const [label, names] of [['Snapshots', answer.newer_snapshots], ['Bookmarks', answer.newer_bookmarks]]) {
            state.previewBox.append(element('strong', label));
            const list = element('ul');
            if (names.length) for (const name of names) list.append(element('li', name));
            else list.append(element('li', 'None'));
            state.previewBox.append(list);
          }
          canProceed = answer.can_rollback;
          if (!canProceed) state.previewBox.append(element('p', 'Enable destruction of newer objects and load a fresh preview to proceed.', 'zfsm-error'));
        } else {
          if (typeof answer.preview !== 'string' || !answer.preview.trim()) throw new Error('The destruction preview is empty.');
          renderDestroySummary(state.previewBox, answer);
        }
        state.preview = { token: answer.token, preview_id:answer.preview_id, choice, canProceed:canProceed&&(rollback||answer.can_destroy===true) };
        state.result.textContent = ''; state.result.className = '';
        if (['destroydataset','destroysnapshot'].includes(state.action)) { showDestroyControls(state, state.preview.canProceed); stopProcessesButton(state, state.preview.canProceed || !Array.isArray(answer.stoppable_processes) ? [] : answer.stoppable_processes); }
      } catch (error) {
        if (!current(state) || previewGeneration !== state.previewGeneration) return;
        state.preview = null;
        state.previewBox.replaceChildren(element('p', 'Preview unavailable. Load a fresh preview before proceeding.', 'zfsm-error'));
        note(state, 'Preview failed: ' + String(error.message || error), true);
      } finally {
        if (current(state) && previewGeneration === state.previewGeneration) { state.previewBusy = false; enable(state); }
      }
    }
    function previewChoice(state){if(state.action==='editacl')return value(state,'acl');if(state.action==='setquota')return JSON.stringify([value(state,'kind'),value(state,'id'),value(state,'value')]);return value(state,state.action==='rollbacksnapshot'?'destroy_newer':state.action==='destroysnapshot'?'recursive':'force');}
    function reviewedControls(state){
      state.requiresPreview=true;state.previewButton=element('button','Load fresh preview');state.previewButton.type='button';state.previewButton.dataset.preview='';state.previewButton.addEventListener('click',()=>loadPreview(state));state.previewBox=element('section',undefined,'zfsm-preview');state.grid.append(state.previewButton,state.previewBox);acknowledgment(state,'I reviewed the affected objects and confirm this change.');invalidatePreview(state);
    }
    async function quotaFields(state){
      state.requiresPreview=true;
      const answer=await request({cmd:'quotaoverview',zdataset:state.context.dataset});if(!current(state))return;
      if(answer.status!=='known'){state.grid.append(element('p',answer.reason||'Native quota inventory is unavailable.','zfsm-error'));state.requiresPreview=true;return;}
      state.grid.append(element('p',answer.inheritance||'User/group quotas are local and are not inherited. Dataset limits and reservations remain in Properties.'));
      for(const alert of answer.alerts||[])state.grid.append(element('p',alert.reason,alert.severity==='error'?'zfsm-error':'zfsm-notice'));
      const wrap=element('div',undefined,'zfsm-table-wrap'),table=element('table',undefined,'zfsm-table'),head=element('tr');for(const title of ['Identity','ID','Bytes used','Byte quota','Objects used','Object quota'])head.append(element('th',title));table.append(head);
      for(const row of answer.rows||[]){const line=element('tr');for(const key of ['type','id','used','quota','objects_used','objects_quota'])line.append(element('td',row[key]??'Unsupported'));table.append(line);}wrap.append(table);state.grid.append(wrap);
      const kind=field(state,'kind','Quota type','user',[['user','User bytes'],['group','Group bytes'],['userobj','User objects'],['groupobj','Group objects']]);for(const option of kind.options)option.disabled=answer.capabilities?.[option.value]!==true;
      if(kind.selectedOptions[0]?.disabled){const available=[...kind.options].find(o=>!o.disabled);if(available)kind.value=available.value;}
      field(state,'id','Numeric POSIX UID / GID','',null,{required:true,pattern:'[0-9]+',inputMode:'numeric'});field(state,'value','Exact bytes or object count (0 = unlimited)','0',null,{required:true,pattern:'[0-9]+',inputMode:'numeric'});reviewedControls(state);
      for(const key of ['kind','id','value'])for(const event of ['input','change'])state.fields[key].addEventListener(event,()=>invalidatePreview(state));
    }
    async function aclFields(state){
      state.requiresPreview=true;
      const answer=await request({cmd:'acleditorinfo',zdataset:state.context.dataset});if(!current(state))return;
      if(answer.editable!==true){state.grid.append(element('p',answer.reason||'Verified native ACL editing is unavailable.','zfsm-error'));state.requiresPreview=true;return;}
      state.grid.append(element('p',answer.scope||'Only this mountpoint ACL is changed. No recursive chmod/chown.','zfsm-notice'));
      const label=element('label','Explicit numeric POSIX ACL','zfsm-field'),control=element('textarea');control.name='acl';control.value=answer.acl||'';control.rows=12;control.maxLength=16384;control.required=true;control.setAttribute('aria-label','Explicit numeric POSIX ACL');label.append(control);state.grid.append(label);state.fields.acl=control;reviewedControls(state);control.addEventListener('input',()=>invalidatePreview(state));
    }
    function withPreview(state, name, label) {
      state.requiresPreview = true;
      const flag = checkbox(state, name, label);
      flag.addEventListener('change', () => invalidatePreview(state));
      state.previewButton = element('button', 'Load fresh preview');
      state.previewButton.type = 'button';
      state.previewButton.setAttribute('data-preview', '');
      state.previewButton.addEventListener('click', () => loadPreview(state));
      state.grid.append(state.previewButton);
      state.previewBox = element('section', undefined, 'zfsm-preview');
      state.previewBox.setAttribute('aria-label', 'Exact server preview');
      state.grid.append(state.previewBox);
      acknowledgment(state, state.action === 'destroydataset' ? 'Delete ' + state.context.dataset + ' permanently' : state.action === 'deletedirectory' ? 'Delete this folder permanently' : 'I reviewed the exact preview above and confirm this irreversible operation.');
      invalidatePreview(state);
    }
    function createFields(state) {
      const ctx = state.context;
      field(state, 'zpool', 'Pool', ctx.pool, null, { type: 'hidden' });
      const name = field(state, 'name', 'Dataset path without pool name', ctx.dataset && ctx.dataset.startsWith(ctx.pool + '/') ? ctx.dataset.slice(ctx.pool.length + 1) + '/' : '', null, { required: true, maxLength: 768, placeholder: 'parent/new-dataset' });
      const list = element('datalist'); list.id = 'zfsm-datasets-' + (++sequence); name.setAttribute('list', list.id);
      const names = getDatasets(ctx.pool);
      if (Array.isArray(names)) for (const dataset of names) {
        if (typeof dataset !== 'string' || !dataset.startsWith(ctx.pool + '/')) continue;
        const option = element('option'); option.value = dataset.slice(ctx.pool.length + 1) + '/'; list.append(option);
      }
      state.grid.append(list);
      const mount = field(state, 'mount', 'Mount', 'yes', [['yes', 'Yes'], ['no', 'No']]);
      const mountpoint = field(state, 'mountpoint', 'Mountpoint (blank uses default)', '', null, { placeholder: '/mnt/' + ctx.pool + '/new-dataset', maxLength: 1024 });
      field(state, 'atime', propertyLabels.atime, 'inherit', propertyOptions.atime);
      field(state, 'casesensitivity', 'Case sensitivity', 'sensitive', ['sensitive', 'insensitive', 'mixed']);
      field(state, 'compression', 'Compression', 'inherit', propertyOptions.compression);
      field(state, 'quota', 'Quota (blank for unlimited)', '', null, { inputMode: 'decimal', pattern: '[0-9]+(?:\\.[0-9]+)?', maxLength: 32 });
      field(state, 'quotaunit', 'Quota unit', 'M', [['M', 'MiB'], ['G', 'GiB'], ['T', 'TiB']]);
      const encryption = field(state, 'encryption', 'Encryption', 'inherit', [['inherit', 'Inherit from parent'], ['new-root', 'Create new encryption root']]);
      const effectiveEncryption = element('p', '', 'zfsm-notice'); effectiveEncryption.dataset.effectiveEncryption = '';
      const passphrase = field(state, 'passphrase', 'Encryption passphrase (8–512 bytes)', '', null, { type: 'password', minLength: 8 });
      field(state, 'xattr', propertyLabels.xattr, 'inherit', propertyOptions.xattr);
      field(state, 'recordsize', propertyLabels.recordsize, 'inherit', propertyOptions.recordsize);
      field(state, 'primarycache', propertyLabels.primarycache, 'inherit', propertyOptions.primarycache);
      field(state, 'readonly', propertyLabels.readonly, 'off', propertyOptions.readonly);
      field(state, 'sync', propertyLabels.sync, 'standard', propertyOptions.sync);
      const syncMount = () => { mountpoint.disabled = mount.value === 'no'; };
      const syncEncryption = () => {
        // Map drafts produced by the legacy No/Yes selector without changing semantics.
        if (encryption.value === 'no') encryption.value = 'inherit';
        if (encryption.value === 'yes') encryption.value = 'new-root';
        passphrase.disabled = encryption.value !== 'new-root'; passphrase.required = !passphrase.disabled;
        if (passphrase.disabled) passphrase.value = '';
        if (encryption.value === 'new-root') { effectiveEncryption.textContent = 'Effective encryption: a new encryption root with its own passphrase.'; return; }
        const fullName = ctx.pool + '/' + name.value.replace(/^\/+|\/+$/g, '');
        let parentName = name.value.endsWith('/') ? fullName : fullName.slice(0, fullName.lastIndexOf('/'));
        let parent = null;
        while (parentName) {
          parent = options.getDataset ? options.getDataset(parentName) : parentName === ctx.dataset ? ctx.node : null;
          if (parent) break;
          parentName = parentName.includes('/') ? parentName.slice(0, parentName.lastIndexOf('/')) : '';
        }
        effectiveEncryption.textContent = !parent || !parent.encryption
          ? 'Effective encryption: parent state is unknown; refresh inventory and verify the parent before creating.'
          : parent.encryption === 'off' ? 'Effective encryption: unencrypted, inherited from ' + parentName + '.'
          : 'Effective encryption: encrypted, inheriting the key from ' + (parent.encryptionroot || parentName) + (parent.keystatus === 'unavailable' ? ' (currently locked).' : '.');
      };
      mount.addEventListener('change', syncMount); encryption.addEventListener('change', syncEncryption); name.addEventListener('input', syncEncryption); syncMount(); syncEncryption();
      state.form.classList.add('zfsm-create-form');
      state.grid.classList.add('zfsm-grouped-grid');
      for (const [title, names] of [
        ['Location', ['name', 'mountpoint', 'mount', 'casesensitivity']],
        ['Storage', ['compression', 'recordsize', 'quota', 'quotaunit']],
        ['Filesystem behavior', ['atime', 'xattr', 'primarycache', 'readonly', 'sync']],
        ['Encryption', ['encryption', 'passphrase']]
      ]) {
        const group = element('fieldset', undefined, 'zfsm-form-group');
        group.append(element('legend', title));
        const fields = element('div', undefined, 'zfsm-group-fields');
        for (const name of names) fields.append(state.fields[name].closest('.zfsm-field'));
        group.append(fields); state.grid.append(group);
      }
      state.grid.append(effectiveEncryption);
      state.grid.append(element('p', 'New filesystems inherit unset properties. Encryption passphrases stay only in this live form.', 'zfsm-notice'));
    }
    function settingsValues() {
      const config = getConfig();
      const values = {
        refresh_interval: config.refresh_interval ?? 30, lazy_load: config.lazy_load ?? 0,
        destructive_mode: config.destructive_mode ?? 0, exclusion: config.dataset_exclusion ?? config.exclusion ?? '',
        directory_listing: Array.isArray(config.directory_listing) ? config.directory_listing.join('\n') : config.directory_listing || '',
        snap_max_days_alert: config.snap_max_days_alert ?? 30, snap_pattern: config.snap_pattern ?? 'Y-m-d-His', snap_prefix: config.snap_prefix || '',space_warning_percent:config.space_warning_percent??80,space_critical_percent:config.space_critical_percent??90,replication_lag_hours:config.replication_lag_hours??24,job_retention_days:config.job_retention_days??7
      };
      for (const name of Object.keys(values)) values[name] = String(values[name]);
      return values;
    }
    function rebaseSettings(state) {
      const latest = settingsValues();
      for (const [name, fresh] of Object.entries(latest)) {
        if (!state.fields[name]) continue;
        if (!state.dirtySettings.has(name)) { state.fields[name].value = fresh; if (state.fields[name].zfsmSync) state.fields[name].zfsmSync(); }
        else if (value(state, name) === fresh) state.dirtySettings.delete(name);
      }
      state.settingsBaseline = latest;
      remember(state);
    }
    function settingsFields(state) {
      const values = settingsValues();
      state.settingsBaseline = values;
      state.dirtySettings = new Set(Object.keys(state.draft).filter(name => Object.prototype.hasOwnProperty.call(values, name) && String(state.draft[name]) !== values[name]));
      field(state, 'job_retention_days', 'Keep finished jobs for', values.job_retention_days, [['1', '1 day'], ['7', '7 days'], ['30', '30 days'], ['0', 'Always']]);
      field(state, 'refresh_interval', 'Refresh interval', values.refresh_interval, [['0', 'No refresh'], ['30', '30 seconds'], ['60', '1 minute'], ['120', '2 minutes'], ['300', '5 minutes'], ['900', '15 minutes'], ['1800', '30 minutes']]);
      for (const [key, label] of [['lazy_load', 'Load snapshots only when a pool is opened'], ['destructive_mode', 'Destructive Mode']]) field(state, key, label, values[key], [['0', 'No'], ['1', 'Yes']]);
      const listing = field(state, 'directory_listing', 'Show folders in the tree for these datasets', values.directory_listing, null, { type: 'textarea', rows: 5, maxLength: 16384 });
      if (state.context && Array.isArray(state.context.datasets) && typeof global.zfsmDatasetChecklist === 'function') global.zfsmDatasetChecklist(listing, () => state.context.datasets, { label: 'Show folders in the tree for these datasets' });
      field(state, 'snap_max_days_alert', 'Snapshot age warning (days)', values.snap_max_days_alert, null, { type: 'number', min: 0, max: 36500, step: 1, required: true });
      field(state,'space_warning_percent','Space warning threshold (%)',values.space_warning_percent,null,{type:'number',min:1,max:99,step:1,required:true});
      field(state,'space_critical_percent','Space critical threshold (%)',values.space_critical_percent,null,{type:'number',min:2,max:100,step:1,required:true});
      field(state,'replication_lag_hours','Verified replication age alert (hours; 0 = disabled)',values.replication_lag_hours,null,{type:'number',min:0,max:8760,step:1,required:true});
      // Rarely changed, expert-level options stay available but out of the way.
      const basicGrid = state.grid, advanced = element('details'), advancedGrid = element('div');
      advanced.className = 'zfsm-settings-advanced'; advancedGrid.className = basicGrid.className;
      advanced.append(element('summary', 'Advanced'), advancedGrid); basicGrid.append(advanced); state.grid = advancedGrid;
      field(state, 'exclusion', 'Hide datasets whose name matches (regular expression)', values.exclusion, null, { type: 'textarea', rows: 2, maxLength: 1024 });
      const pattern = field(state, 'snap_pattern', 'Snapshot name date format', values.snap_pattern, null, { maxLength: 128 });
      const presets = element('datalist'); presets.id = 'zfsm-snap-pattern-presets';
      for (const [value, label] of [['Y-m-d-His', '2026-01-31-235959'], ['Ymd-His', '20260131-235959'], ['Y-m-d_H-i', '2026-01-31_23-59']]) { const option = element('option', label); option.value = value; presets.append(option); }
      pattern.setAttribute('list', presets.id); advancedGrid.append(presets);
      field(state, 'snap_prefix', 'Snapshot name prefix (without @, # or /)', values.snap_prefix, null, { maxLength: 128 });
      const preview = element('p', 'Snapshot name preview: validating…', 'zfsm-notice');
      preview.dataset.snapshotNamePreview = ''; state.grid.append(preview);
      state.grid = basicGrid;
      const errors = {};
      for (const [name, control] of Object.entries(state.fields)) {
        const error = element('small', '', 'zfsm-error'); error.setAttribute('aria-live', 'polite');
        error.id = 'zfsm-setting-error-' + (++sequence); control.setAttribute('aria-describedby', error.id);
        control.closest('.zfsm-field').append(error); errors[name] = error;
      }
      let validationGeneration = 0,lastValidationKey='';
      const validate = async () => {
        const settings=Object.fromEntries(Object.entries(state.fields).map(([name,control])=>[name,control.value])),key=JSON.stringify(settings);if(key===lastValidationKey)return;lastValidationKey=key;
        state.validationBusy=true;enable(state);const revision = ++validationGeneration;
        for (const control of Object.values(state.fields)) control.setCustomValidity('Settings validation is in progress.');
        preview.textContent = 'Snapshot name preview: validating…';
        try {
          const answer = await request({cmd:'validatesettings', settings});
          if (!current(state) || revision !== validationGeneration) return;
          if (!answer || typeof answer.valid !== 'boolean' || !answer.errors || typeof answer.errors !== 'object' || (Array.isArray(answer.errors) && answer.errors.length !== 0)) throw new Error('Invalid settings validation response');
          for (const [name, control] of Object.entries(state.fields)) {
            const message = String(answer.errors[name] || answer.errors.settings || '');
            control.setCustomValidity(message); errors[name].textContent = message;
            control.setAttribute('aria-invalid', message ? 'true' : 'false');
          }
          // A problem in a collapsed Advanced field must never stay hidden.
          if (Object.keys(answer.errors).some(name => advancedGrid.contains(state.fields[name] || null))) advanced.open = true;
          preview.textContent = 'Snapshot name preview: ' + (answer.snapshot_preview || 'Correct the naming fields to generate a valid name.');
          state.validationBusy=false;enable(state);
        } catch (error) {
          if (!current(state) || revision !== validationGeneration) return;
          const message = 'Server validation unavailable. Retry after restoring backend connectivity.';
          for (const control of Object.values(state.fields)) control.setCustomValidity(message);
          lastValidationKey='';preview.textContent = message;state.validationBusy=false;enable(state);
        }
      };
      state.form.addEventListener('input', validate); state.form.addEventListener('change', validate);
      validate();
      state.grid.append(element('p', 'Destructive Mode enables deletion, rollback, directory moves/conversion and key unloading. Pool root destruction is always refused.', 'zfsm-notice'));
    }
    async function editFields(state) {
      note(state, 'Loading current dataset properties…', false);
      state.grid.classList.add('zfsm-property-grid');
      try {
        const properties = await request({ cmd: 'getdatasetproperties', zdataset: state.context.dataset });
        if (!current(state)) return;
        if (!properties || properties._error || properties.failed || !properties.type) throw new Error(properties && (properties._error || failureText(properties)) || 'The server returned no dataset properties.');
        const filesystemOnly = new Set(['mountpoint', 'quota', 'refquota', 'recordsize', 'atime', 'xattr']);
        const volume = properties.type === 'volume' || state.context.type === 'volume';
        const requested = state.context.property ? [state.context.property] : Object.keys(propertyLabels);
        state.propertyValues = Object.assign({}, properties);state.propertyFeedback={};state.propertySources={};
        const groups=new Map();for(const title of ['General','Performance','Space','Security','Advanced']){const group=element('fieldset',undefined,'zfsm-form-group');group.append(element('legend',title));groups.set(title,group);state.grid.append(group);}
        for (const property of requested) {
          if (!Object.prototype.hasOwnProperty.call(propertyLabels, property) || (volume && filesystemOnly.has(property))) continue;
          const control = field(state, property, propertyLabels[property], properties[property], propertyOptions[property], { required: true, maxLength: 1024 });
          control.parentNode.classList.add('zfsm-property-field');
          control.setAttribute('aria-label',propertyLabels[property]);
          const help = element('small', propertyHelp[property], 'zfsm-property-help');
          help.id = control.id + '-help'; control.setAttribute('aria-describedby', help.id);
          const save = element('button', 'Save'); save.type = 'button'; save.setAttribute('data-save-property', property); save.setAttribute('aria-label', 'Save ' + propertyLabels[property]);
          save.addEventListener('click', () => {
            if (!control.reportValidity()) return;
            reviewMutation(state, property);
          });
          const source=element('small','Source: '+(properties._sources?.[property]||'Unknown'),'zfsm-property-help'),feedback=element('span','','zfsm-property-feedback');feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');control.parentNode.append(save,help,source,feedback);state.propertyFeedback[property]=feedback;state.propertySources[property]=source;
          const group=['quota','refquota','reservation','refreservation'].includes(property)?'Space':['mountpoint','atime','readonly'].includes(property)?'General':'Performance';groups.get(group).append(control.parentNode);
        }
        const readOnly = {
          General: [['name','Name'],['type','Type'],...(!volume?[['casesensitivity','Case sensitivity']]:[]),['creation','Creation']],
          Security: [['encryption','Effective encryption'],['encryptionroot','Encryption root'],['keystatus','Key status'],['keyformat','Key format'],...(!volume?[['mounted','Mounted state'],['acltype','ACL type'],['aclmode','ACL mode'],['aclinherit','ACL inheritance']]:[])],
          Advanced: [['guid','GUID'],['origin','Clone origin'],['used','Used (bytes)'],['available','Available (bytes)'],['referenced','Referenced (bytes)'],['usedbydataset','Used by dataset (bytes)'],['usedbychildren','Used by children (bytes)'],['usedbysnapshots','Used by snapshots (bytes)'],['usedbyrefreservation','Used by refreservation (bytes)'],['compressratio','Compression ratio'],['dedup','Deduplication'],...(volume?[['volblocksize','Volume block size (bytes)'],['volsize','Volume size (bytes)']]:[])]
        };
        for (const [title, definitions] of Object.entries(readOnly)) {
          const list=element('dl',undefined,'zfsm-properties');
          for (const [property,label] of definitions) {
            if ((state.context.property&&state.context.property!==property)||properties[property]===undefined) continue;
            let value=properties[property]===null?'Unknown':String(properties[property]);
            if(property==='compressratio'&&properties[property]!==null&&Number.isFinite(Number(properties[property])))value=Number(properties[property])/100+'x';
            if(property==='creation'&&typeof global.zfsmFormatDateTime==='function')value=global.zfsmFormatDateTime(properties[property]);
            const answer=element('dd');answer.dataset.readonlyProperty=property;
            answer.append(element('span',value),element('small',' · Source: '+(properties._sources?.[property]||'Unknown'),'zfsm-property-help'));
            list.append(element('dt',label),answer);
          }
          if(list.children.length)groups.get(title).append(element('p','Read-only details — these properties have no Save action here.','zfsm-muted'),list);
          else if(title!=='General')groups.get(title).append(element('p','Property details are not available in the current response.','zfsm-muted'));
        }
        note(state, 'Save each changed property separately. Inherit follows native property semantics for inheritable properties. Quota and reservation limits are not inherited; use 0/none to clear them. Numeric values are shown without rounding.', false);
        if (!state.grid.querySelector('[data-save-property]')) note(state, 'This property does not apply to this dataset type.', true);
        enable(state);
      } catch (error) { if (current(state)) note(state, 'Unable to read properties: ' + String(error.message || error), true); }
    }
    function snapshotSelection(state) {
      const ctx = state.context;
      const snapshots = Array.from(new Set(ctx.snapshots.length ? ctx.snapshots : (ctx.snapshot ? [ctx.snapshot] : [])));
      const retained = state.draft.snapshot_selection;
      state.batchRows = new Map();
      state.batchFailures = Object.assign({}, state.draft.snapshot_failures || {});
      for (const snapshot of snapshots) {
        const row = element('div', undefined, 'zfsm-field');
        const label = element('label'); const select = element('input'); select.type = 'checkbox'; select.name = 'snapshot_selection'; select.value = snapshot;
        select.checked = retained ? retained.includes(snapshot) : true;
        const result = element('span'); result.setAttribute('role', 'status');
        if (state.batchFailures[snapshot]) { result.textContent = state.batchFailures[snapshot]; result.className = 'zfsm-error'; }
        label.append(select, element('span', snapshot)); row.append(label, result); state.grid.append(row); state.batchRows.set(snapshot, { select, result });
      }
      const recursive=checkbox(state, 'recursive', 'Also destroy snapshots with this name on descendant datasets');
      state.requiresPreview=true;state.previewButton=element('button','Load fresh preview');state.previewButton.type='button';state.previewButton.dataset.preview='';state.previewButton.addEventListener('click',()=>loadPreview(state));state.previewBox=element('section',undefined,'zfsm-preview');state.grid.append(state.previewButton,state.previewBox);recursive.addEventListener('change',()=>invalidatePreview(state));for(const row of state.batchRows.values())row.select.addEventListener('change',()=>invalidatePreview(state));
      acknowledgment(state, 'I confirm permanent destruction of the selected snapshots. This cannot be undone.');
    }
    function build(state) {
      const ctx = state.context;
      switch (state.action) {
        case 'createdataset': createFields(state); break;
        case 'saveconfig': settingsFields(state); break;
        case 'editdatasetproperty': return editFields(state);
        case 'renamedataset':
          field(state, 'newname', 'New full dataset name', ctx.dataset, null, { required: true, maxLength: 768 });
          checkbox(state, 'force', 'Force unmount filesystems that must be unmounted during rename'); break;
        case 'destroydataset':
          withPreview(state, 'force', 'Recursive + Force: include child datasets and snapshots; preserve external clones'); break;
        case 'unlockdataset': if(ctx.node.keystatus==='available')state.grid.append(element('p','Key already loaded. Restore only saved mount GUIDs; changed identities remain blocked.'));else field(state, 'passphrase', 'Dataset passphrase', '', null, { type: 'password', required: true });state.grid.append(element('p','Only previously mounted filesystems recorded by Director are restored. Without a saved mount journal, only the key is loaded.','zfsm-notice'));break;
        case 'lockdataset': {const affected=[];function walk(n){if(n.encryptionroot===ctx.dataset)affected.push(n.name+' — mounted: '+(n.mounted||'unknown'));for(const child of Object.values(n.child||{}))walk(child);}walk(ctx.node);state.grid.append(element('p','Encryption root: '+ctx.dataset+'; dependent filesystems become inaccessible. Shares, Docker and VM usage are not verified.','zfsm-danger'));const list=element('ul');for(const text of affected)list.append(element('li',text));state.grid.append(list);acknowledgment(state, 'I confirm unmounting this encryption root and unloading its key.');break;}
        case 'promotedataset': reviewedControls(state); break;
        case 'setquota': return quotaFields(state);
        case 'editacl': return aclFields(state);
        case 'movedirectory': field(state, 'newname', 'New full directory path (within the same dataset)', ctx.directory, null, { required: true, maxLength: 4096 }); acknowledgment(state, 'I confirm moving this directory to the path entered above.'); break;
        case 'deletedirectory': withPreview(state, 'force', 'Recursively delete all files and subdirectories (otherwise only an empty directory is removed)'); break;
        case 'convertdirectory': case 'resumeconversion':
          state.grid.append(element('p', 'Stop Docker containers, VMs, SMB/NFS clients and every other writer. Allow space for both copies. The original stays in a recovery directory; keep writers stopped until verification and inspection of the result. Progress and recovery controls are in Conversion Jobs.', 'zfsm-danger'));
          checkbox(state, 'offline_confirmed', 'All writers are stopped; I will inspect the result before restarting them'); break;
        case 'cleanupmutation': state.grid.append(element('p','Only a completed journal-only recovery container can be cleaned. Unfinished operations, retained objects and unknown journals remain protected. A fresh review is required.','zfsm-notice'));reviewedControls(state);break;
        case 'cancelconversion': acknowledgment(state, 'I confirm requesting cancellation. The retained source will not be deleted.'); break;
        case 'publishconversion': state.grid.append(element('p', 'The copy was verified when it was made, but publication did not finish. The dataset will be mounted at the original path. This is refused while anything exists at that path. Changes made to the original after the copy are not included.', 'zfsm-danger')); acknowledgment(state, 'I confirm publishing the verified copy at the original path.'); break;
        case 'cancelrestore': acknowledgment(state, ctx.job.type==='archive'?'I confirm cancelling ZIP preparation. Temporary archive data will be removed.':'I confirm requesting cancellation. Copied and replaced files will be retained; a partially published restore must be inspected.'); break;
        case 'snapshotdataset': checkbox(state, 'recursive', 'Create snapshots recursively on descendant datasets'); state.grid.append(element('p', 'The server generates the snapshot name using the current prefix and date pattern.', 'zfsm-notice')); break;
        case 'renamesnapshot': field(state, 'newname', 'New snapshot name (without dataset or @)', (ctx.snapshot || '').split('@')[1] || '', null, { required: true, maxLength: 255 }); break;
        case 'clonesnapshot': field(state, 'clone', 'Destination full dataset name', ctx.pool ? ctx.pool + '/' : '', null, { required: true, maxLength: 768 }); break;
        case 'rollbacksnapshot': withPreview(state, 'destroy_newer', 'Also permanently destroy newer snapshots and bookmarks'); break;
        case 'destroysnapshot': snapshotSelection(state); break;
        case 'releasesnapshot': acknowledgment(state, 'I confirm releasing the zfsmaster hold; this removes its protection against deletion.'); break;
        case 'holdsnapshot': state.grid.append(element('p', 'Add the zfsmaster hold to protect this snapshot from deletion.', 'zfsm-notice')); break;
        case 'adddirectortlisting': case 'removedirectorylisting': state.grid.append(element('p', 'Ordinary folders inside this dataset are listed under it in the dataset tree, or hidden again. Nothing on disk changes.', 'zfsm-notice')); break;
      }
      return Promise.resolve();
    }
    function payload(state) {
      const ctx = state.context;
      const data = { cmd: state.action };
      switch (state.action) {
        case 'createdataset':
          data.data = {};
          for (const key of ['name', 'mount', 'mountpoint', 'atime', 'casesensitivity', 'compression', 'quota', 'quotaunit', 'encryption', 'xattr', 'recordsize', 'primarycache', 'readonly', 'sync']) data.data[key] = value(state, key);
          data.data.zpool = ctx.pool;
          if (['yes','new-root'].includes(value(state, 'encryption'))) data.data.passphrase = value(state, 'passphrase');
          break;
        case 'saveconfig': data.settings = {}; for (const key of Object.keys(state.fields)) data.settings[key] = value(state, key); break;
        case 'renamedataset': data.zdataset = ctx.dataset; data.newname = value(state, 'newname'); data.force = value(state, 'force'); break;
        case 'destroydataset': data.zdataset = ctx.dataset; data.force = value(state, 'force'); data.preview_token = state.preview.token; data.preview_id=state.preview.preview_id; break;
        case 'unlockdataset': data.zdataset = ctx.dataset; data.passphrase = value(state, 'passphrase'); break;
        case 'lockdataset': case 'promotedataset': case 'adddirectortlisting': case 'removedirectorylisting': data.zdataset = ctx.dataset; break;
        case 'setquota': data.zdataset=ctx.dataset;data.data={kind:value(state,'kind'),id:value(state,'id'),value:value(state,'value')};break;
        case 'editacl': data.zdataset=ctx.dataset;data.acl=value(state,'acl');break;
        case 'movedirectory': data.directory = ctx.directory; data.newname = value(state, 'newname'); break;
        case 'cleanupmutation': data.directory=ctx.directory;data.preview_id=state.preview.preview_id;data.token=state.preview.token;data.confirmed=value(state,'acknowledge');break;
        case 'deletedirectory': data.directory = ctx.directory; data.force = value(state, 'force'); break;
        case 'convertdirectory': data.directory = ctx.directory; data.pool = ctx.pool; data.offline_confirmed = value(state, 'offline_confirmed'); break;
        case 'resumeconversion': data.job_id = ctx.job.id; data.offline_confirmed = value(state, 'offline_confirmed'); break;
        case 'cancelconversion': case 'cancelrestore': case 'publishconversion': data.job_id = ctx.job.id; break;
        case 'snapshotdataset': data.zdataset = ctx.dataset; data.recursive = value(state, 'recursive'); break;
        case 'renamesnapshot': data.snapshot = ctx.snapshot; data.newname = value(state, 'newname'); break;
        case 'clonesnapshot': data.snapshot = ctx.snapshot; data.clone = value(state, 'clone'); break;
        case 'holdsnapshot': case 'releasesnapshot': data.snapshot = ctx.snapshot; break;
        case 'rollbacksnapshot': data.snapshot = ctx.snapshot; data.destroy_newer = value(state, 'destroy_newer'); data.preview_token = state.preview.token; break;
      }
      if(['promotedataset','setquota','editacl'].includes(state.action)){data.preview_id=state.preview.preview_id;data.token=state.preview.token;}
      return data;
    }
    function displayAnswer(state, answer) {
      if(answer.field_errors)for(const [name,message]of Object.entries(answer.field_errors)){const control=state.fields[name];if(control){control.setCustomValidity(String(message));let feedback=control.parentNode.querySelector('.zfsm-field-error');if(!feedback){feedback=element('small',undefined,'zfsm-field-error');control.parentNode.append(feedback);}feedback.textContent=String(message);}}
      const failures = failureText(answer);
      const successes = Object.entries(answer.succeeded).map(([name, text]) => name + ': ' + String(text)).join('\n');
      const result = failures ? (successes ? 'partial' : 'error') : !successes ? 'unknown' : answer.worker_warning ? 'warning' : 'success';
      const finished = result === 'success' && state.modal && state.action !== 'editdatasetproperty' && !['queued', 'running'].includes(answer.job?.state);
      const completed = state.completed && !finished ? 'Select the updated object to perform another action.' : '';
      const deleted = Object.keys(answer.succeeded);
      const details = state.batchRows
        ? (finished ? '' : 'Deleted: ' + deleted.length + '. Failed or not attempted: ' + Object.keys(answer.failed).length + '.\nSee each snapshot above for details.')
        : [successes, failures, answer.worker_warning, completed].filter(Boolean).join('\n');
      note(state, details || 'The operation returned no result. Inspect actual state before retrying.', !!failures);
      const titles = {success:'Operation successful',partial:'Partially completed',error:'Operation failed',unknown:'Result not confirmed',warning:'Completed with warnings'};
      if (finished && state.batchRows) titles.success = 'Destroyed ' + deleted.length + (deleted.length === 1 ? ' snapshot' : ' snapshots');
      state.result.dataset.result = result;
      const heading = element('strong', titles[result], 'zfsm-result-heading');
      if (result === 'success') {
        const icon = element('span', '✓', 'zfsm-result-icon'); icon.setAttribute('aria-hidden', 'true'); heading.prepend(icon);
        state.result.dataset.severity = 'ok';
      } else if (['partial', 'warning', 'unknown'].includes(result)) {
        state.result.className = 'zfsm-notice'; state.result.dataset.severity = 'warning';
      }
      state.result.prepend(heading);
      if (finished) {
        // A finished action leaves only its result: no fields, checkboxes, preview or review buttons.
        for (const child of Array.from(state.body.children)) if (child !== state.result && child.tagName !== 'H3' && child !== state.buttons && !child.classList.contains('zfsm-form-target')) child.remove();
        if (state.buttons) { for (const control of Array.from(state.buttons.querySelectorAll('button:not([data-close-action])'))) control.remove(); if (!state.buttons.children.length) state.buttons.remove(); }
        if (state.batchRows) { const list = element('ul'); for (const name of deleted) list.append(element('li', name)); state.result.append(list); }
      }
      if (answer.destruction && (!finished || ['remaining', 'changed'].some(key => Array.isArray(answer.destruction[key]) && answer.destruction[key].length) || answer.destruction.diagnostics)) {
        const outcome = element('section', undefined, 'zfsm-destroy-outcome'); outcome.dataset.destroyOutcome = '';
        outcome.append(element('strong', 'Deletion outcome'));
        outcome.append(element('p', answer.destruction.attempted === false ? 'No deletion was attempted.' : answer.destruction.state_verified ? 'Current object identities were checked after the attempt.' : 'Current state is unverified. Inspect actual state before retrying.'));
        for (const [label, key] of [['Removed', 'removed'], ['Remaining', 'remaining'], ['Identity changed', 'changed']]) {
          const names = answer.destruction[key]; if (!Array.isArray(names) || !names.length) continue;
          outcome.append(element('strong', label)); const list = element('ul'); for (const name of names) list.append(element('li', name)); outcome.append(list);
        }
        renderDestroyDiagnostics(outcome, answer.destruction.diagnostics);
        outcome.append(element('p', 'Resolve blockers, refresh inventory and load a fresh preview before another attempt. GUID and scope will be checked again. No automatic destructive retry.'));
        state.result.append(outcome);
      }
      if(answer.job?.id){
        const deletion=['deletedirectory','destroydataset'].includes(state.action);
        const queued=['queued','running'].includes(answer.job.state);
        const conversion=['convertdirectory','resumeconversion'].includes(state.action);
        if(queued){state.completed=true;heading.textContent=deletion?'Deletion queued':conversion?'Conversion queued':'Operation in progress';state.result.append(element('span',' The operation has not finished. Follow its stage and progress in Jobs.'));}
        const jobs=element('button',queued?(deletion?'View deletion progress':conversion?'View conversion progress':'View progress in Jobs'):answer.job.state==='completed'?'View result in Jobs':'View failed attempt in Jobs');jobs.type='button';jobs.dataset.viewJob=answer.job.id;
        jobs.addEventListener('click',()=>options.onViewJob?.(answer.job.id));if(answer.job.schema!==7)state.result.append(jobs);
      }
    }
    function notify(answer, state, metadata) {
      // Refresh is independent of form lifetime: an operation can finish after navigation.
      try {
        const completed = metadata === undefined ? onComplete(answer, state.action, state.context) : onComplete(answer, state.action, state.context, metadata);
        Promise.resolve(completed).catch(() => { if (current(state)) note(state, 'The operation returned a result, but refresh failed. Inspect actual state before retrying.', true); });
      }
      catch (error) { if (current(state)) note(state, 'The operation returned a result, but refresh failed. Inspect actual state before retrying.', true); }
    }
    function retireSavedSettings(state, submitted) {
      // Saving is authoritative even when the following inventory refresh fails.
      // Only retire submitted values; later edits still belong to the live draft.
      state.settingsBaseline = Object.assign({}, submitted);
      for (const name of state.dirtySettings) if (value(state, name) === submitted[name]) state.dirtySettings.delete(name);
      if (settingsDraftOwners.get(state.key) === state) remember(state);
    }
    function clearConfirmation(state) {
      if (!state.pendingConfirmation) return;
      const pending=state.pendingConfirmation;pending.panel.remove();pending.controls.remove();state.pendingConfirmation = null;
      if(state.modal){state.form.dataset.step='edit';if(state.buttons)state.buttons.hidden=false;state.body.scrollTop=pending.editScroll;}
    }
    function confirmationSignature(state) {
      return JSON.stringify([state.previewGeneration,Array.from(state.form.elements).filter(control=>control.name).map(control=>[control.name,control.type==='password'?'private':control.value,control.checked])]);
    }
    function readyToMutate(state) {
      if (!current(state) || state.completed || state.busy || runningActions.has(state.key) || policy(state)) return false;
      if (state.fields.acknowledge && !state.fields.acknowledge.checked) return false;
      if (state.fields.offline_confirmed && !state.fields.offline_confirmed.checked) return false;
      if (state.requiresPreview && (!state.preview || !state.preview.canProceed || state.preview.choice !== previewChoice(state))) return false;
      return true;
    }
    async function reviewMutation(state, property) {
      if (!readyToMutate(state) || !(property ? state.fields[property].reportValidity() : state.form.reportValidity())) return;
      clearConfirmation(state);
      let nativeReview=null;
      if(['quota','refquota','reservation','refreservation'].includes(property)){
        if(state.validationBusy)return;state.validationBusy=true;enable(state);const signature=confirmationSignature(state),requested=value(state,property);
        try{
          nativeReview=await request({cmd:'previewspaceproperty',zdataset:state.context.dataset,property,value:requested});if(!current(state))return;
          if(signature!==confirmationSignature(state)||!readyToMutate(state))throw Error('Fields or object state changed; review the limit again.');
          const r=nativeReview?.review;if(!/^[a-f0-9]{64}$/.test(nativeReview?.token||'')||!/^[a-f0-9]{32}$/.test(nativeReview?.preview_id||'')||r?.kind!=='space_property'||r.name!==state.context.dataset||r.property!==property||r.requested!==requested||r.can_proceed!==true||(state.context.node.guid&&r.guid!==String(state.context.node.guid)))throw Error(failureText(nativeReview)||'Invalid native limit preview.');
        }catch(error){if(current(state)){note(state,'Space limit preview failed: '+error.message,true);if(state.propertyFeedback[property])state.propertyFeedback[property].textContent='Preview failed — '+error.message;}return;}
        finally{if(current(state)){state.validationBusy=false;enable(state);}}
      }
      const panel=element('section',undefined,'zfsm-confirmation'),heading=element('h4','Are you sure you want to '+(property?'change '+propertyLabels[property].toLowerCase():titles[state.action].toLowerCase())+'?');
      panel.setAttribute('aria-label','Confirm operation');panel.append(heading);
      const target=state.action==='createdataset'?state.context.pool+'/'+value(state,'name'):state.context.snapshot||state.context.directory||state.context.dataset||state.context.job.id||state.context.pool||'Plugin settings';
      panel.append(element('p','Target: '+target,'zfsm-form-target'));
      const values=element('dl',undefined,'zfsm-confirmation-values');
      if(property){
        values.append(element('dt',propertyLabels[property]),element('dd',String(state.propertyValues[property]??'—')+' → '+value(state,property)));
        if(nativeReview)values.append(element('dt','Verified native scope'),element('dd',nativeReview.review.previous+' → '+nativeReview.review.expected+' bytes · Source: '+nativeReview.review.source));
        if(property==='sync'&&value(state,property)==='disabled')panel.append(element('p',propertyHelp.sync,'zfsm-danger'));
      }else{
        for(const control of state.form.elements){
          if(!control.name||control.type==='hidden'||control.type==='password'||['acknowledge','offline_confirmed'].includes(control.name))continue;
          if(control.name==='snapshot_selection'&&!control.checked)continue;
          const caption=control.name==='snapshot_selection'?'Snapshot':control.closest('label')?.querySelector('span')?.textContent||control.name;
          const display=control.type==='checkbox'?(control.name==='snapshot_selection'?control.value:control.checked?'Yes':'No'):control.value||'Default';
          values.append(element('dt',caption),element('dd',display));
        }
      }
      if(values.children.length)panel.append(values);
      if(state.action==='destroysnapshot'||state.action==='destroydataset'||state.action==='deletedirectory'||state.action==='cleanupmutation')panel.append(element('p','Deletion is permanent. Only proceed if you have reviewed the target and selected scope.','zfsm-danger'));
      if(state.action==='rollbacksnapshot')panel.append(element('p','Current file changes after this restore point will be lost. Review the preview above.','zfsm-danger'));
      const controls=element('div',undefined,'zfsm-buttons'),confirm=element('button','Confirm '+(property?'change':titles[state.action].toLowerCase())),cancel=element('button',state.modal?'Back':'Cancel');
      confirm.type=cancel.type='button';confirm.dataset.confirmOperation='';
      if(destructive.has(state.action))confirm.className='zfsm-danger';
      controls.append(confirm,cancel);panel.append(controls);
      const pending={panel,controls,confirm,cancel,opener:document.activeElement,editScroll:state.body.scrollTop,signature:confirmationSignature(state)};state.pendingConfirmation=pending;
      cancel.addEventListener('click',()=>{if(state.pendingConfirmation===pending){clearConfirmation(state);enable(state);if(state.modal&&pending.opener?.isConnected)pending.opener.focus({preventScroll:true});}});
      confirm.addEventListener('click',()=>{
        if(state.pendingConfirmation!==pending)return;
        if(!readyToMutate(state)||pending.signature!==confirmationSignature(state)) {clearConfirmation(state);note(state,'The operation changed or is no longer available. Review it again before confirming.',true);enable(state);return;}
        if(!(property?state.fields[property].reportValidity():state.form.reportValidity()))return;
        clearConfirmation(state);
        if(state.action==='destroysnapshot')mutateSnapshots(state);
        else mutate(state,property?{cmd:'editdatasetproperty',zdataset:state.context.dataset,property,value:value(state,property),...(nativeReview?{preview_id:nativeReview.preview_id,token:nativeReview.token}:{})}:payload(state));
      });
      if(state.modal){
        if(state.previewBox?.children.length)panel.insertBefore(state.previewBox.cloneNode(true),controls);
        state.body.append(panel);controls.classList.add('zfsm-action-footer');state.form.append(controls);state.form.dataset.step='review';if(state.buttons)state.buttons.hidden=true;state.body.scrollTop=0;
      }
      else if(property)state.fields[property].parentNode.after(panel);
      else state.form.insertBefore(panel,state.buttons||null);
      heading.tabIndex=-1;heading.focus({preventScroll:true});enable(state);
    }
    async function mutate(state, data) {
      if (!current(state) || state.completed || state.busy || runningActions.has(state.key)) return;
      const blocked = policy(state);
      if (blocked) { note(state, blocked, true); enable(state); return; }
      Object.assign(data,getMutationFields(state.action,state.context,data));
      state.busy = true;
      runningActions.add(state.key);
      if (state.action === 'saveconfig') {
        state.settingsPendingValues = Object.assign({}, data.settings);
        state.settingsPendingDirty = new Set(state.dirtySettings);
      }
      remember(state); clearSecrets(state); enable(state);
      note(state, 'Operation in progress…', false);if(data.cmd==='editdatasetproperty'&&state.propertyFeedback[data.property])state.propertyFeedback[data.property].textContent='Saving…';
      if(!['convertdirectory','resumeconversion','deletedirectory','destroydataset'].includes(state.action)){const progress=element('progress');progress.setAttribute('aria-label','Operation progress');state.result.append(progress);}
      if(['convertdirectory','resumeconversion','deletedirectory','destroydataset'].includes(state.action)){
        const deletion=['deletedirectory','destroydataset'].includes(state.action);
        note(state,deletion?'Checking and queuing deletion…':'Checking and queuing conversion…',false);const progress=element('progress');progress.setAttribute('aria-label',deletion?'Submitting deletion':'Submitting conversion');state.result.append(progress);
      }
      try {
        const answer = await request(data);
        if (!usableAnswer(answer)) throw new Error('Invalid server response');
        if(data.cmd==='editdatasetproperty'&&current(state)){const feedback=state.propertyFeedback[data.property];if(Object.keys(answer.succeeded).length&&!Object.keys(answer.failed).length){try{const actual=await request({cmd:'getdatasetproperties',zdataset:state.context.dataset});if(!actual||actual.failed||actual._error||actual[data.property]===undefined||(state.context.node.guid&&String(actual.guid)!==String(state.context.node.guid)))throw Error('Effective value or object identity could not be confirmed');if(current(state)){state.propertyValues[data.property]=actual[data.property];state.fields[data.property].value=String(actual[data.property]);state.propertySources[data.property].textContent='Source: '+(actual._sources?.[data.property]||'Unknown');feedback.textContent='Saved — '+actual[data.property];feedback.className='zfsm-property-feedback zfsm-success';}}catch(error){if(current(state)){feedback.textContent='Applied; readback unavailable. '+error.message;feedback.className='zfsm-property-feedback zfsm-error';}}}else{feedback.textContent='Failed — '+failureText(answer);feedback.className='zfsm-property-feedback zfsm-error';}}
        if (Object.keys(answer.succeeded).length && !Object.keys(answer.failed).length && ['renamesnapshot', 'renamedataset', 'destroydataset', 'movedirectory', 'deletedirectory', 'cleanupmutation'].includes(state.action)) state.completed = true;
        let completionMetadata;
        if (state.action === 'saveconfig') {
          if (!Object.keys(answer.failed).length && Object.keys(answer.succeeded).length) {
            const settings = Object.freeze(Object.assign({}, data.settings));
            retireSavedSettings(state, settings);
            completionMetadata = Object.freeze({ settings });
          }
          state.settingsPendingValues = null;
          state.settingsPendingDirty = null;
        }
        if (current(state)) displayAnswer(state, answer);
        notify(answer, state, completionMetadata);
      } catch (error) {
        state.settingsPendingValues = null;
        state.settingsPendingDirty = null;
        const uncertainty = 'Request result is unavailable. Inspect actual state before retrying; the operation may already have completed.';
        if (current(state)){note(state, uncertainty, true);if(data.cmd==='editdatasetproperty'&&state.propertyFeedback[data.property])state.propertyFeedback[data.property].textContent=uncertainty;}
        notify({ succeeded: {}, failed: { request: uncertainty }, uncertain: true }, state);
      } finally {
        runningActions.delete(state.key);
        // Drop secret references from our request object immediately after transport finishes.
        if (data.passphrase !== undefined) data.passphrase = '';
        if (data.data && data.data.passphrase !== undefined) data.data.passphrase = '';
        if (current(state)) {
          state.busy = false;
          if (state.requiresPreview) invalidatePreview(state);
          if (state.fields.acknowledge) state.fields.acknowledge.checked = false;
          if (state.fields.offline_confirmed) state.fields.offline_confirmed.checked = false;
          enable(state);
        } else if (active && active.key === state.key) enable(active);
      }
    }
    async function mutateSnapshots(state) {
      if (!current(state) || state.busy || runningActions.has(state.key) || policy(state)) { if (current(state)) enable(state); return; }
      const targets = Array.from(state.batchRows.entries()).filter(([, row]) => row.select.checked).map(([name]) => name);
      const recursive = value(state, 'recursive');
      if (!targets.length) return;
      state.busy = true; runningActions.add(state.key); enable(state);
      note(state,'',false);
      const progress=element('progress'),progressLabel=element('span');progress.max=targets.length;progress.value=0;progress.setAttribute('aria-label','Snapshot deletion progress');state.result.append(progressLabel,progress);
      const combined = { succeeded: {}, failed: {} };
      for (let index = 0; index < targets.length; index++) {
        const snapshot = targets[index];
        // Navigation or a changed policy stops the batch before its next mutation.
        if (!current(state) || policy(state, [snapshot])) {
          for (const unattempted of targets.slice(index)) combined.failed[unattempted] = 'Not attempted; operation was deactivated or policy changed.';
          break;
        }
        const row = state.batchRows.get(snapshot);
        row.result.textContent = 'Deleting…';
        progressLabel.textContent='Deleting '+snapshot+' · '+(index+1)+' of '+targets.length;
        try {
          const preview = state.batchPreviews?.get(snapshot);
          if(!preview?.token||preview.can_destroy===false)throw new Error('Deletion preview is blocked. '+(preview?.preview||failureText(preview)));
          const answer = await request({ cmd: 'destroysnapshot', snapshot, recursive,preview_id:preview.preview_id,preview_token:preview.token,...getMutationFields('destroysnapshot',state.context,{snapshot}) });
          if (!usableAnswer(answer)) throw new Error('Invalid server response');
          const failed = failureText(answer);
          if (failed || !Object.keys(answer.succeeded).length) {
            combined.failed[snapshot] = snapshotDeletionIssue(snapshot, failed || 'No successful deletion was reported. Inspect actual state before retrying.');
            row.result.textContent = combined.failed[snapshot]; row.result.className = 'zfsm-error';
          } else {
            combined.succeeded[snapshot] = 'Destroyed'; row.result.textContent = '✓ Destroyed'; row.result.className = 'zfsm-notice'; row.result.dataset.severity = 'ok'; row.select.checked = false; row.deleted = true; row.select.disabled = true;
          }
          progress.value=index+1;
        } catch (error) {
          combined.failed[snapshot] = 'Request result unavailable. Inspect actual state before retrying; deletion may already have completed.';
          row.result.textContent = combined.failed[snapshot]; row.result.className = 'zfsm-error';
          // An uncertain transport result stops the batch; nothing is silently retried.
          for (const unattempted of targets.slice(index + 1)) combined.failed[unattempted] = 'Not attempted after uncertain request result.';
          break;
        }
      }
      for (const snapshot of Object.keys(combined.succeeded)) delete state.batchFailures[snapshot];
      Object.assign(state.batchFailures, combined.failed);
      for (const [snapshot, failure] of Object.entries(combined.failed)) {
        const row = state.batchRows.get(snapshot);
        if (row) { row.result.textContent = failure; row.result.className = 'zfsm-error'; }
      }
      runningActions.delete(state.key);
      notify(combined, state);
      if (current(state)) {
        state.busy = false;state.batchPreviews=null;invalidatePreview(state); state.fields.acknowledge.checked = false;
        displayAnswer(state, combined); remember(state); enable(state);
      } else if (!active || active.key !== state.key) remember(state);
      else enable(active);
    }
    function render(container, action, context) {
      if (!container || !container.append) throw new TypeError('An inline form container is required');
      context = immutableContext(context || {});
      const key = JSON.stringify([action, context.pool, context.dataset, context.snapshot, context.snapshots, context.directory, context.job.id, context.property]);
      if(active&&active.key===key&&!active.built&&!policy(active))dispose();
      if (active && active.key === key) {
        if (active.form.parentNode !== container) { clearSecrets(active); container.replaceChildren(active.form); }
        if (action === 'saveconfig') rebaseSettings(active);
        active.container = container; enable(active); return active.ready;
      }
      dispose();
      const state = { action, context, key, generation, draft: drafts.get(key) || {}, container, modal:Boolean(container.closest('.zfsm-action-dialog')), fields: {}, busy: false, preview: null, previewGeneration: 0, previewBusy: false, requiresPreview: false };
      if (action === 'saveconfig') settingsDraftOwners.set(key, state);
      state.form = element('form', undefined, 'zfsm-form');
      state.form.setAttribute('aria-label', titles[action] || 'Unsupported operation');
      state.form.dataset.step='edit';
      state.form.append(element('h3', titles[action] || 'Unsupported operation'));
      state.body=state.modal?element('div',undefined,'zfsm-action-body'):state.form;if(state.modal)state.form.append(state.body);
      const target = ['movedirectory', 'convertdirectory', 'deletedirectory', 'cleanupmutation'].includes(action) ? context.directory
        : ['cancelconversion', 'resumeconversion', 'publishconversion', 'cancelrestore'].includes(action) ? context.job.id
        : action === 'createdataset' ? context.pool
        : ['renamesnapshot', 'holdsnapshot', 'releasesnapshot', 'clonesnapshot', 'rollbacksnapshot', 'destroysnapshot'].includes(action) ? context.snapshot || context.dataset
        : action === 'saveconfig' ? '' : context.dataset;
      if (target) state.body.append(element('p', 'Target: ' + target, 'zfsm-form-target'));
      if (snapshotHelp[action]) state.body.append(element('p', snapshotHelp[action], 'zfsm-notice zfsm-action-help'));
      state.grid = element('div', undefined, 'zfsm-form-grid'); state.body.append(state.grid);
      state.result = element('p', '', 'zfsm-notice'); state.result.setAttribute('aria-live', 'polite'); state.body.append(state.result);
      active = state;
      container.replaceChildren(state.form);
      if (!Object.prototype.hasOwnProperty.call(titles, action)) { note(state, 'Unsupported operation.', true); return Promise.resolve(); }
      const blocked = policy(state);
      if (blocked) { note(state, blocked, true); return Promise.resolve(); }
      state.built=true;
      const edited = event => {
        clearConfirmation(state);
        if (state.action === 'saveconfig' && state.fields[event.target.name]) {
          const name = event.target.name;
          if (state.settingsPendingValues) {
            if (value(state, name) !== state.settingsPendingValues[name] || state.settingsPendingDirty.has(name)) state.dirtySettings.add(name);
            else state.dirtySettings.delete(name);
          } else if (value(state, name) === state.settingsBaseline[name]) state.dirtySettings.delete(name);
          else state.dirtySettings.add(name);
        }
        remember(state); enable(state);
      };
      state.form.addEventListener('input', edited);
      state.form.addEventListener('change', edited);
      state.ready = Promise.resolve(build(state)).then(()=>{if(current(state))enable(state);});
      if (action !== 'editdatasetproperty'||state.modal) {
        const buttons = element('div', undefined, 'zfsm-buttons');
        state.buttons = buttons;
        if(action!=='editdatasetproperty'){
          const submit = element('button',state.modal?(['destroydataset','deletedirectory'].includes(action)?'Delete':'Review'):titles[action] === 'Settings' ? 'Save settings' : titles[action]); submit.type = 'submit';
          if (destructive.has(action)) submit.className = 'zfsm-danger';buttons.append(submit);
        }
        if(state.modal){buttons.classList.add('zfsm-action-footer');const close=element('button','Close');close.type='button';close.dataset.closeAction='';close.addEventListener('click',()=>{if(current(state))onClose();});buttons.append(close);}
        state.form.append(buttons);
      }
      state.form.addEventListener('submit', event => {
        event.preventDefault();
        if (!current(state) || state.completed || state.busy || !state.form.reportValidity()) return;
        if (state.fields.acknowledge && !state.fields.acknowledge.checked) return;
        if (state.fields.offline_confirmed && !state.fields.offline_confirmed.checked) return;
        if (state.requiresPreview && (!state.preview || !state.preview.canProceed || state.preview.choice !== previewChoice(state))) { invalidatePreview(state); return; }
        if (action !== 'editdatasetproperty') reviewMutation(state);
      });
      enable(state);
      return state.ready;
    }
    return { render, dispose };
  };
  // Dataset names are picked from a list instead of typed one per line. The
  // textarea stays the form value (one name per line); this only drives it.
  // getNames() returns the current choices; names saved earlier that are no
  // longer offered stay visible, checked, so nothing is dropped silently.
  global.zfsmDatasetChecklist = function (textarea, getNames, options) {
    options = options || {};
    const make = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
    const wrap = textarea.closest('label') || textarea;
    const box = make('div', undefined, 'zfsm-checklist');
    const head = make('div', undefined, 'zfsm-checklist-head');
    const filter = make('input'); filter.type = 'search'; filter.placeholder = 'Filter datasets…'; filter.setAttribute('aria-label', 'Filter datasets'); filter.autocomplete = 'off';
    const count = make('span', undefined, 'zfsm-checklist-count');
    const list = make('div', undefined, 'zfsm-checklist-list');
    const missing = make('div', undefined, 'zfsm-checklist-missing');
    head.append(filter, count);
    box.append(head, list, missing);
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', options.label || textarea.getAttribute('aria-label') || 'Datasets');
    textarea.hidden = true;
    wrap.after(box);
    const lines = () => String(textarea.value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const checkbox = (name, checked) => {
      const row = make('label', undefined, 'zfsm-checklist-row');
      const input = make('input'); input.type = 'checkbox'; input.checked = checked; input.value = name;
      row.append(input, make('span', name));
      return row;
    };
    function commit(selected) {
      const names = getNames();
      const ordered = [...names.filter(name => selected.has(name)), ...lines().filter(name => selected.has(name) && !names.includes(name))];
      textarea.value = [...new Set(ordered)].join('\n');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      sync();
    }
    function sync() {
      const names = getNames(), selected = new Set(lines()), needle = filter.value.trim().toLowerCase();
      list.replaceChildren(); missing.replaceChildren();
      const shown = names.filter(name => !needle || name.toLowerCase().includes(needle));
      for (const name of shown) list.append(checkbox(name, selected.has(name)));
      if (!shown.length) list.append(make('p', names.length ? 'No dataset matches the filter.' : (options.empty || 'No datasets available.'), 'zfsm-checklist-empty'));
      const gone = lines().filter(name => !names.includes(name));
      if (gone.length) {
        missing.append(make('p', 'Not found now. Kept until you uncheck them:'));
        for (const name of gone) missing.append(checkbox(name, true));
      }
      missing.hidden = !gone.length;
      count.textContent = selected.size + ' selected';
    }
    box.addEventListener('change', event => {
      const input = event.target;
      if (!input || input.type !== 'checkbox') return;
      const selected = new Set(lines());
      if (input.checked) selected.add(input.value); else selected.delete(input.value);
      commit(selected);
    });
    filter.addEventListener('input', event => { event.stopPropagation(); sync(); });
    filter.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
    textarea.zfsmSync = sync;
    sync();
    return textarea;
  };
})(typeof window === 'undefined' ? globalThis : window);
