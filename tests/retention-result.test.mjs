import assert from 'node:assert/strict';
import {test} from 'node:test';
import {retentionResult} from './fixtures/retention-result.mjs';

test('retention deleting eligible snapshots while preserving manual and held snapshots completes with warnings',async t=>{
 const r=await retentionResult();t.after(()=>r.stand.close());
 assert.equal(r.job.state,'completed');assert.equal(r.job.verified_outcome,'completed_with_warnings');assert.equal(r.job.error,null);
 assert.deepEqual(r.job.verification.snapshots_pruned,[r.owned]);assert.equal(r.job.verification.retention.protected.length,2);
 const after=r.stand.readModel();assert.equal(after.snapshots[r.owned],undefined);for(const n of [r.manual,r.held])assert.deepEqual(after.snapshots[n],r.before.snapshots[n]);
 assert.equal(r.page.jobs[0].group,'completed');assert.equal(r.page.counts.needs_attention,0);assert.equal(r.page.jobs[0].actions.resume,false);
 assert.ok(r.audit.some(e=>e.command==='protectionexecute'&&e.phase==='outcome'&&e.status==='succeeded'));
});
test('retention with no protected snapshots reports actual deletion as completed',async t=>{
 const r=await retentionResult({protectedSnapshots:false});t.after(()=>r.stand.close());
 assert.equal(r.job.verified_outcome,'completed');assert.deepEqual(r.job.verification.snapshots_pruned,[r.owned]);assert.equal(r.job.error,null);
});
for(const [name,options,want]of [
 ['no eligible deletions',{eligible:false},'blocked'],
 ['unverified retention plan',{invalidPlan:true},'blocked'],
 ['native deletion failure',{deleteFailure:true},'recovery_required']
])test('retention '+name+' remains unsuccessful rather than completed with warnings',async t=>{
 const r=await retentionResult(options);t.after(()=>r.stand.close());
 assert.equal(r.job.verified_outcome,want);assert.notEqual(r.job.state,'completed');assert.ok(r.job.error);
 const after=r.stand.readModel();for(const name of [r.owned,r.manual,r.held])if(r.before.snapshots[name])assert.deepEqual(after.snapshots[name],r.before.snapshots[name]);
});

test('retention failure after the first deletion stays unsuccessful, with remaining protected snapshots intact',async t=>{
 const r=await retentionResult({partialFailure:true});t.after(()=>r.stand.close());
 assert.equal(r.job.verified_outcome,'recovery_required');assert.notEqual(r.job.state,'completed');assert.ok(r.job.error);
 const after=r.stand.readModel();assert.equal(after.snapshots[r.owned],undefined);for(const name of [r.second,r.manual,r.held])assert.deepEqual(after.snapshots[name],r.before.snapshots[name]);
});
