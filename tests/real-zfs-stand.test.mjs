import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
// TEST-011: the real ZFS stand destroys pools, so without the disposable-VM marker it must refuse before doing anything.
test('the real ZFS stand refuses to run without the disposable VM marker',{skip:existsSync('/etc/zfsm-disposable-vm')},()=>{
 const r=spawnSync('sh',['tests/real-zfs/setup.sh'],{encoding:'utf8',env:{...process.env,ZFSM_REAL_ZFS_OUT:'/nonexistent/never-created'}});
 assert.equal(r.status,2);
 assert.equal(r.stderr,'refusing to run: /etc/zfsm-disposable-vm is missing. This stand destroys pools and must only run on a disposable VM.\n');
 assert.equal(existsSync('/nonexistent/never-created'),false);
});
test('the host launcher refuses to run without an image',()=>{
 const r=spawnSync('sh',['tests/real-zfs/vm.sh'],{encoding:'utf8',env:{...process.env,ZFSM_VM_IMAGE:''}});
 assert.notEqual(r.status,0);assert.match(r.stderr,/ZFSM_VM_IMAGE/);
});
