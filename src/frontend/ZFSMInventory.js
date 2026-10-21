/* Inventory uses authenticated HTTP; Nchan is optional copy-progress only. */
function createZFSMInventoryController(options) {
    let config = options.config;
    let busy = false;
    let pending = false;
    let timer = null;
    let stopped = false;
    let configGeneration = 0;

    function schedule() {
        clearTimeout(timer);
        const interval = Number(config.refresh_interval);
        if (!stopped && interval > 0) {
            timer = setTimeout(function() {
                if (document.hidden) schedule();
                else refresh();
            }, Math.max(interval, 1) * 1000);
        }
    }

    function finish() {
        busy = false;
        options.spinner(false);
        if (pending && !stopped) {
            pending = false;
            refresh();
        } else schedule();
    }

    function failed(message) {
        if (stopped) return;
        options.status(message + ' Existing rows may be stale.', true);
        finish();
    }

    function validate(answer) {
        const mapping = value => value && typeof value === 'object' && !Array.isArray(value);
        if (!answer || !['getAll', 'getDatasets'].includes(answer.op) || !answer.data ||
            !mapping(answer.data.pools) || !mapping(answer.data.datasets) || !mapping(answer.data.devices) ||
            (answer.data.errors !== undefined && !mapping(answer.data.errors))) {
            const errors = answer && answer.failed ? Object.values(answer.failed).join('; ') : 'Invalid inventory response';
            throw new Error(errors);
        }
        for (const pool of Object.keys(answer.data.pools)) {
            if (!answer.data.datasets[pool] || !Object.prototype.hasOwnProperty.call(answer.data.devices, pool)) {
                throw new Error('Incomplete inventory for ' + pool);
            }
        }
    }

    function request(data, done) {
        if (typeof options.request === 'function') {
            Promise.resolve().then(function() { return options.request(data); }).then(function(answer) {
                if (stopped) return;
                try { validate(answer); done(answer); }
                catch (error) { failed('Unable to load ZFS inventory: ' + error.message); }
            }).catch(function(error) { failed('ZFS inventory request failed: ' + error.message); });
            return;
        }
        $.ajax({url: options.url, method: 'POST', dataType: 'json', timeout: 60000,
            data: Object.assign({csrf_token: options.csrf}, data)
        }).done(function(answer) {
            if (stopped) return;
            try { validate(answer); done(answer); }
            catch (error) { failed('Unable to load ZFS inventory: ' + error.message); }
        }).fail(function(xhr, status) {
            failed('ZFS inventory request failed (HTTP ' + xhr.status + ', ' + status + ').');
        });
    }

    function refresh() {
        if (stopped) return;
        if (busy) { pending = true; return; }
        clearTimeout(timer);
        busy = true;
        options.spinner(true);
        options.status('Reading ZFS datasets and snapshots…', false);
        const requestedGeneration = configGeneration;
        request({cmd: 'inventory'}, function(answer) {
            // A pre-save read may finish after a confirmed settings write.
            // Only a request started in the current generation can replace it.
            if (requestedGeneration === configGeneration) {
                config = Object.assign({}, config, answer.config || {});
                options.configChanged(config);
            }
            const data = answer.data;
            const pools = answer.op === 'getDatasets' ? Object.keys(data.pools) : [];
            options.render(data, false);

            function complete() {
                options.render(data, true);
                const errors = Object.values(data.errors || {});
                let message = 'Last refresh at ' + zfsmFormatDateTime(new Date());
                if (answer.publishing_paused) message += ' — Unraid push updates paused; inventory loaded directly.';
                if (errors.length) message += ' — Query errors: ' + errors.join('; ');
                options.status(message, errors.length > 0);
                finish();
            }

            function nextPool() {
                if (!pools.length) { complete(); return; }
                const pool = pools.shift();
                options.status('Reading snapshots for ' + pool + '…', false);
                request({cmd: 'inventorysnapshots', pool: pool}, function(part) {
                    if (!part.data.pools[pool] || !part.data.datasets[pool]) throw new Error('Missing snapshot inventory for ' + pool);
                    ['pools', 'datasets', 'devices'].forEach(key => { data[key][pool] = part.data[key][pool]; });
                    data.errors = data.errors || {};
                    delete data.errors[pool];
                    Object.assign(data.errors, part.data.errors || {});
                    options.render(data, false);
                    nextPool();
                });
            }
            nextPool();
        });
    }

    return {refresh: refresh, updateConfig: function(next) { configGeneration++; config = Object.assign({}, config, next); if (!busy) schedule(); }, stop: function() { stopped = true; pending = false; clearTimeout(timer); }};
}
