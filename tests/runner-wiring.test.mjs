import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readdirSync,readFileSync} from 'node:fs';
// A GUI or integration script that no runner lists would never run anywhere.
const helpers={
 gui:['run','serve','mock-server','retention-result','source-probes','download-save','rc-visual','rc-performance','result-policy.test'],
 integration:['run','serve','server'],
};
const runner=readFileSync('tests/run-all.mjs','utf8'),pkg=readFileSync('package.json','utf8');
function listed(constant){const body=runner.match(new RegExp('const '+constant+' = \\[([^\\]]*)\\]'))?.[1]??'';return new Set([...body.matchAll(/'([^']+)'/g)].map(m=>m[1]));}
for(const [dir,constant] of [['gui','GUI_SCRIPTS'],['integration','INTEGRATION_SCRIPTS']])test('every tests/'+dir+' script is wired to a runner or an npm script',()=>{
 const wired=listed(constant),files=readdirSync('tests/'+dir).filter(f=>f.endsWith('.mjs')).map(f=>f.slice(0,-4));
 assert.equal(wired.size>10,true,constant+' was parsed');
 const missing=files.filter(name=>!helpers[dir].includes(name)&&!wired.has(name)&&!pkg.includes('tests/'+dir+'/'+name+'.mjs'));
 assert.deepEqual(missing,[]);
 assert.deepEqual([...wired].filter(name=>!files.includes(name)),[],'the runner lists a script that does not exist');
});
