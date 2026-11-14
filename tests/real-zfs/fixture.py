#!/usr/bin/env python3
"""Turns the capture of one stand run into tests/fixtures/real-zfs/openzfs-<version>.json (TEST-011).

    python3 tests/real-zfs/fixture.py evidence/real-zfs

Nothing is invented: every field comes from capture.json and report.json written by
tests/real-zfs/setup.sh inside the disposable VM. A capture with failed checks is refused.
"""
import json, pathlib, re, sys

out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'evidence/real-zfs')
capture = json.loads((out / 'capture.json').read_text())
report = json.loads((out / 'report.json').read_text())
if capture.get('failed') != 0 or report.get('failed') != 0:
    raise SystemExit('refusing to write fixtures from a run with failed checks')
version = re.search(r'zfs-(\d+\.\d+\.\d+)', capture['openzfs'])
if not version:
    raise SystemExit('cannot read the OpenZFS version: ' + capture['openzfs'])
fixture = {
    'source': 'tests/real-zfs/setup.sh (tests/native-linux/real-zfs-capture.php) in a disposable ' + report['versions']['os'] + ' VM (QEMU)',
    'openzfs': capture['openzfs'],
    'kernel': capture['kernel'],
    'pool': 'zfsmreal',
    'live_checks': [{'name': c['name'], 'status': c['status']} for c in capture['checks']],
    'inventory_seconds': {n: {'with_snapshots': p['median_with_snapshots_s'], 'lazy': p['median_lazy_s']} for n, p in capture['perf'].items()},
    'fixtures': capture['fixtures'],
}
target = pathlib.Path(__file__).resolve().parents[1] / 'fixtures' / 'real-zfs' / ('openzfs-' + version.group(1) + '.json')
target.write_text(json.dumps(fixture, indent=1, ensure_ascii=False) + '\n')
print(target)
