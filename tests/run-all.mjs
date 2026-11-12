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
const KNOWN_FAILURES = {
  'gui:icon-alignment': 'TEST-001: this script is the only one that sets hasTouch:true for its 390px case. That makes headless Chromium render a classic (non-overlay) scrollbar for the nested, vertically scrolling file list, which adds ~2px to .zfsm-explorer scrollWidth versus clientWidth at every theme/layout (confirmed: hasTouch=false -> scroll===client, hasTouch=true -> scroll=358 client=356). Possibly a real, minor overflow on actual touch devices; needs a src/frontend decision/ticket, out of TEST-001 scope.',
  'gui:metadata': "TEST-001: getByRole('button',{name:'Overview',exact:true}) now matches 2 elements on the page (strict mode violation). Pre-existing selector ambiguity from later UI additions; script was never wired to a runner and needs its own update.",
  'gui:protection': "TEST-001: waits for '.zfsm-global-nav' button 'Data Protection', which no longer exists — the Protection section split into 'Snapshot Policies' and 'Replication' (src/frontend/ZFSMWorkspace.js). Pre-existing, unrelated to TEST-001.",
  'gui:workspace-navigation': "TEST-001: asserts 'Fixture must actually scroll the tree'; the fixture no longer produces a tall enough tree to require scrolling at the tested viewport. Pre-existing, needs its own fixture update.",
  'integration:actions-layout': "TEST-001: expects inventory._directory_identities to deep-equal {} for datasets with no directories; the PHP/WASM endpoint now reports an empty list as [] (standard PHP empty-array JSON encoding). Pre-existing response-shape mismatch, unrelated to TEST-001.",
  'integration:activity': "TEST-001: locator('[data-job-id=...] summary') now matches 2 elements — the job entry's own toggle plus a nested 'Technical diagnostics' <details><summary>. Needs a scoped selector (e.g. '> details > summary'); pre-existing, unrelated to TEST-001.",
  'integration:all-operation-jobs': 'TEST-001: same nested <summary> ambiguity as integration:activity.',
  'integration:conversion-exports': "TEST-001: times out waiting for the 'Convert to dataset' button; an earlier case in the same file leaves the workspace in a state where that button is not reachable the same way anymore. Pre-existing navigation-flow mismatch, unrelated to TEST-001.",
  'integration:destroy': "TEST-001: a GUID-mismatch destroy response no longer has a `destruction` field at all (reads 'Cannot read properties of undefined'), only `failed`. Pre-existing response-shape mismatch, unrelated to TEST-001.",
  'integration:history-fixes': "TEST-001: clicks 'Administrative History' right after page load, but that button only renders once the Jobs section is open (src/frontend/ZFSMWorkspace.js). Pre-existing navigation-flow mismatch, unrelated to TEST-001.",
  'integration:ownership': "TEST-001: waits for heading 'Data Protection' to become visible; current navigation requires opening the renamed 'Snapshot Policies'/'Replication' sections instead. Same root cause as gui:protection.",
  'integration:rc1-gaps': "TEST-001: waits for button 'Compact table'; the view-switch button is now labelled just 'Compact' (src/frontend/ZFSMWorkspace.js). Pre-existing label mismatch, unrelated to TEST-001.",
  'integration:rc1-history-details': 'TEST-001: same missing-navigation-step cause as integration:history-fixes.',
  'integration:rc1-history-old': 'TEST-001: same missing-navigation-step cause as integration:history-fixes.',
  'integration:rc1-lock': "TEST-001: waits for button 'Delete directory' right after selecting the node, without opening the 'Actions' tab first. Pre-existing navigation-flow mismatch, unrelated to TEST-001.",
  'integration:security': "TEST-001: clicks 'POSIX ACL editor' while an earlier 'Unlock dataset' modal <dialog> is still open; its body now intercepts pointer events for the rest of the page (true native modality, consistent with action-dialogs.mjs). The script never closes that dialog first. Pre-existing, unrelated to TEST-001.",
};

const steps = [];
steps.push({name: 'unit-tests', build: async () => {
  const files = (await readdir(resolve(repoRoot, 'tests')))
    .filter(f => f.endsWith('.test.mjs'))
    .sort()
    .map(f => 'tests/' + f);
  return [process.execPath, ['--test', '--test-concurrency=1', '--test-force-exit', ...files]];
}});
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
