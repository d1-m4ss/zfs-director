import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { runtime } from './php-runtime.mjs';

const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const click = (root, label) => {
    const control = [...root.querySelectorAll('button')].find(item => item.dataset.node === label || item.textContent === label || item.getAttribute('aria-label') === label);
    assert.ok(control, label);
    control.click();
};

test('acceptance security: File Manager pins the GUID from the selected snapshot row on its first read', async () => {
    const dom = new JSDOM('<main></main>', { url: 'http://fixture.local', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window, root = w.document.querySelector('main'), calls = [];
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.ResizeObserver = class { observe() {} disconnect() {} };
    w.scrollTo = () => {};
    w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    w.zfsmFormatDateTime = String;
    for (const file of ['ZFSMInventory.js', 'ZFSMForms.js', 'ZFSMSnapshots.js', 'ZFSMExplorer.js', 'ZFSMPoolView.js', 'ZFSMOverview.js', 'ZFSMHistory.js', 'ZFSMWorkspace.js']) w.eval(readFileSync('src/frontend/' + file, 'utf8'));
    const snapshot = { name: 'cache/data@selected', guid: '101', creation: 1700000000 };
    const child = { name: 'cache/data', guid: '2', type: 'filesystem', encryption: 'off', keystatus: 'none', child: {}, directories: [], snapshots: [snapshot] };
    const data = { pools: { cache: { Health: 'ONLINE', Size: 1000, Used: 10, Snapshots: 1 } }, datasets: { cache: { name: 'cache', guid: '1', type: 'filesystem', child: { 'cache/data': child }, directories: [], snapshots: [] } }, devices: { cache: '' }, errors: {} };
    const app = w.zfsmCreateWorkspace({ root, config: { refresh_interval: 30, destructive_mode: 1 }, request: async fields => {
        calls.push(structuredClone(fields));
        if (fields.cmd === 'conversionjobs') return { jobs: [], worker_running: false };
        if (fields.cmd === 'inventory') return { op: 'getAll', data: structuredClone(data) };
        if (fields.cmd === 'pooldiagnostics') throw Error('No live diagnostics in acceptance test');
        if (fields.cmd === 'snapshotfiles') {
            // External replacement after the table was rendered: same name, new GUID.
            if (fields.snapshot_guid && fields.snapshot_guid !== '202') return { failed: { snapshot: 'Snapshot was replaced; reopen it before accessing files' } };
            return { snapshot: fields.snapshot, path: fields.path, snapshot_guid: '202', restore_available: true, entries: [{ name: 'replacement.txt', path: 'replacement.txt', size: 1, mtime: 1700000000, type: 'file', available: true }], total: 1 };
        }
        throw Error('Unexpected command ' + fields.cmd);
    } });
    try {
        await settle(); click(root, 'cache/data'); click(root, 'Snapshots'); await settle();
        root.querySelector('[data-file-manager="cache/data@selected"]').click(); await settle();
        assert.equal(calls.find(call => call.cmd === 'snapshotfiles')?.snapshot_guid, '101', 'first request must retain the reviewed row GUID instead of binding to its replacement');
        assert.equal(root.querySelector('.zfsm-file-dialog').textContent.includes('replacement.txt'), false);
    } finally { app.stop(); w.close(); }
});

