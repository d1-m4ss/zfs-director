// Single entry point for every GUI and integration check in this repo: the
// unit suite (tests/*.test.mjs), the two wired Chromium runners
// (tests/gui/run.mjs, tests/integration/run.mjs) and every standalone GUI/
// integration script that is not otherwise wired to a runner or an npm
// script. Runs strictly sequentially — several scripts spin up their own
// local HTTP mock and reusing a shared browser/server across scripts is not
// safe. See docs/TESTING.md.
import {spawn} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TIMEOUT = 300; // seconds

// Scripts under tests/gui and tests/integration that are real, self-contained
// checks (own mock server/browser, exit non-zero on failure) but are not
// wired to tests/gui/run.mjs, tests/integration/run.mjs or any npm script.
const GUI_SCRIPTS = [
  'action-dialogs', 'alignment', 'clean-ui', 'dataset-checklist', 'dialogs-layout',
  'fixed-frame', 'icon-alignment', 'job-history-pagination', 'jobs-history', 'metadata',
  'overview-health', 'policy-workflows', 'pool-warning-links', 'protection-dataset-options',
  'protection-destination', 'protection-status', 'protection', 'refresh-off-safety',
  'workspace-navigation',
];
const INTEGRATION_SCRIPTS = [
  'actions-layout', 'activity', 'advanced-storage', 'all-operation-jobs', 'archive-cleanup',
  'conversion-exports', 'deletion-exports', 'deletion-jobs-gui', 'destroy', 'history-fixes',
  'mutation-cleanup', 'ownership', 'protection', 'rc1-gaps', 'rc1-history-details',
  'rc1-history-old', 'rc1-lock', 'rc1-maintenance', 'rc1-usage', 'readonly-directory-deletion',
  'security', 'snapshot-mount-gui',
];

// name -> reason. A FAIL whose name is listed here does not fail the overall
// run; it is still printed and counted. Every reason below was confirmed by
// running the script against unmodified HEAD and reading the frontend/PHP
// source it exercises (TEST-001); none of these scripts were ever wired to a
// runner, so they were not kept in sync with later UI changes.
const KNOWN_FAILURES={
  'integration:activity':'Hiding a job itself creates a new request-job row in Jobs; resolved by ARCH-001 (synchronous actions only in Administrative History).',
};

const steps = [];
steps.push({name: 'unit-tests', build: async () => {
  const files = (await readdir(resolve(repoRoot, 'tests')))
    .filter(f => f.endsWith('.test.mjs'))
    .sort()
    .map(f => 'tests/' + f);
  return [process.execPath, ['--test', '--test-concurrency=1', '--test-force-exit', ...files]];
}});
steps.push({name: 'installer', build: async () => ['python3', ['tests/installer.test.py']]});
steps.push({name: 'release-script', build: async () => ['python3', ['tests/release-script.test.py']]});
steps.push({name: 'gui:run', build: async () => [process.execPath, ['tests/gui/run.mjs']]});
steps.push({name: 'integration:run', build: async () => [process.execPath, ['tests/integration/run.mjs']]});
for (const script of GUI_SCRIPTS) steps.push({name: 'gui:' + script, build: async () => [process.execPath, ['tests/gui/' + script + '.mjs']]});
for (const script of INTEGRATION_SCRIPTS) steps.push({name: 'integration:' + script, build: async () => [process.execPath, ['tests/integration/' + script + '.mjs']]});

function runStep(name, cmd, args) {
  return new Promise(settle => {
    const start = Date.now();
    const child = spawn(cmd, args, {cwd: repoRoot, stdio: 'inherit'});
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGKILL');
      settle({status: 'FAIL', secs: (Date.now() - start) / 1000, reason: 'timed out after ' + DEFAULT_TIMEOUT + 's'});
    }, DEFAULT_TIMEOUT * 1000);
    child.on('error', error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      settle({status: 'FAIL', secs: (Date.now() - start) / 1000, reason: error.message});
    });
    child.on('exit', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      settle({status: code === 0 ? 'PASS' : 'FAIL', secs: (Date.now() - start) / 1000});
    });
  });
}

async function main() {
  const onlyIndex = process.argv.indexOf('--only');
  const only = onlyIndex !== -1 ? process.argv[onlyIndex + 1] : null;
  const results = [];
  for (const step of steps) {
    if (only && !step.name.includes(only)) continue;
    const [cmd, args] = await step.build();
    console.log('--- ' + step.name + ' ---');
    const result = await runStep(step.name, cmd, args);
    results.push({name: step.name, ...result});
    const known = result.status === 'FAIL' ? KNOWN_FAILURES[step.name] : undefined;
    console.log((result.status === 'PASS' ? 'PASS' : 'FAIL') + ' ' + step.name + ' (' + result.secs.toFixed(1) + 's)' + (result.reason ? ' — ' + result.reason : '') + (known ? ' [known failure]' : ''));
  }
  const totalSecs = results.reduce((sum, r) => sum + r.secs, 0);
  const passed = results.filter(r => r.status === 'PASS');
  const known = results.filter(r => r.status === 'FAIL' && KNOWN_FAILURES[r.name]);
  const unexpected = results.filter(r => r.status === 'FAIL' && !KNOWN_FAILURES[r.name]);
  console.log('');
  console.log('=== Summary: ' + passed.length + ' passed, ' + known.length + ' known failures, ' + unexpected.length + ' unexpected failures, total ' + totalSecs.toFixed(1) + 's ===');
  if (known.length) {
    console.log('Known failures (see tests/run-all.mjs KNOWN_FAILURES for reasons):');
    for (const r of known) console.log('  - ' + r.name);
  }
  if (unexpected.length) {
    console.log('Unexpected failures:');
    for (const r of unexpected) console.log('  - ' + r.name + (r.reason ? ' (' + r.reason + ')' : ''));
  }
  process.exit(unexpected.length ? 1 : 0);
}

await main();
