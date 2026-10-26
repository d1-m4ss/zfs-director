"""Exercise the real generated offline package; no host installation."""
import hashlib
import fcntl
import json
import os
import pathlib
import shlex
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parents[1]
STAND_TMP = pathlib.Path('/private/tmp') if pathlib.Path('/private/tmp').is_dir() else pathlib.Path('/tmp')


def startup_stand(install, anchor):
    # Only filesystem and expected-owner boundaries change. The guard and
    # activation branches are the actual generated installer code.
    guard = ''
    if '# Runtime stop marker guard.\n' in install:
        guard = install.split('# Runtime stop marker guard.\n', 1)[1].split('# End runtime stop marker guard.\n', 1)[0]
    branch = guard + "\nstop_runtime 'package installation in progress'\n"
    branch = branch.replace('/boot/config/plugins/zfs.master.ui/activation.sha256', str(anchor / 'activation.sha256'))
    branch = branch.replace('/var/tmp/zfs.master.ui/jobs', str(anchor / 'zfs.master.ui/jobs'))
    return branch.replace('-- /var/tmp 0 ', '-- ' + shlex.quote(str(anchor)) + ' ' + str(os.geteuid()) + ' ')


def removal_stand(output, anchor, filename='zfs-director.plg'):
    script = ET.parse(output / filename).findtext("FILE[@Method='remove']/INLINE")
    script = script.replace('/usr/local/emhttp/plugins/zfs.master.ui', str(anchor / 'live'))
    script = script.replace('/boot/config/plugins/zfs.master.ui', str(anchor / 'state'))
    script = script.replace('/var/lock/zfs.master.ui.lock', str(anchor / 'operation.lock'))
    script = script.replace('/var/lock/zfs.master.ui.service.lock', str(anchor / 'service.lock'))
    script = script.replace('/var/lock/zfs.master.ui.worker.lock', str(anchor / 'worker.lock'))
    script = script.replace('/var/tmp/zfs.master.ui/jobs/monitor.lock', str(anchor / 'monitor.lock'))
    script = script.replace('-- /var/tmp 0 ', '-- ' + shlex.quote(str(anchor)) + ' ' + str(os.geteuid()) + ' ')
    return script.replace('/usr/bin/php', shlex.quote(str(anchor / 'php-boundary')))


class InstallerTests(unittest.TestCase):
    def removal_fixture(self, anchor):
        output = anchor / 'build'
        subprocess.run(['python3', str(ROOT / 'tools/build-installer.py'), '--output', str(output),
                        '--release-base-url', 'https://example.invalid/releases/2026.10.22.1'],
                       cwd=ROOT, check=True, capture_output=True)
        (anchor / 'live/scripts').mkdir(parents=True)
        (anchor / 'live/scripts/zfsm-worker.php').write_text('synthetic worker boundary')
        (anchor / 'php-boundary').write_text('#!/bin/bash\nprintf "%s\\n" "$*" >> ' + shlex.quote(str(anchor / 'worker-calls')) + '\nexit "${STOP_STATUS:-0}"\n')
        (anchor / 'php-boundary').chmod(0o700)
        # macOS has no flock CLI. Exercise kernel flock on the same inherited
        # descriptor; native Unraid acceptance uses its real /usr/bin/flock.
        (anchor / 'flock').write_text('#!/usr/bin/env python3\nimport fcntl,sys\ntry: fcntl.flock(int(sys.argv[-1]),fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(1)\n')
        (anchor / 'flock').chmod(0o700)
        retained = {}
        for name, data in {'zfs.master.ui.cfg': b'[general]\nsanoid_integration=0\n',
                           'jobs/completed.json': b'{"state":"completed"}',
                           'jobs/recovery.json': b'{"state":"recovery_required"}',
                           'audit/history.json': b'{"synthetic":"retained"}',
                           'protection/config.json': b'{"policies":{},"replications":{}}',
                           'protection.cron': b'# retained Director source\n'}.items():
            target = anchor / 'state' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            retained[target] = data
        (anchor / 'state/installed.sha256').write_text('accepted-package\n')
        for filename in ('zfs-director.plg', 'zfs.master.ui.plg', 'zfs.master.ui.local.plg'):
            (anchor / 'state' / filename).write_text('cached installer code')
        (anchor / 'external-sanoid.cron').write_text('0 3 * * * sanoid --cron\n')
        retained[anchor / 'external-sanoid.cron'] = b'0 3 * * * sanoid --cron\n'
        return output, retained, dict(os.environ, PATH=str(anchor) + os.pathsep + os.environ['PATH'])

    def test_plugin_manager_remove_stops_services_removes_code_and_preserves_state(self):
        for filename in ('zfs-director.plg', 'zfs.master.ui.plg', 'zfs.master.ui.local.plg'):
            with self.subTest(plugin=filename), tempfile.TemporaryDirectory(dir=STAND_TMP) as folder:
                anchor = pathlib.Path(folder)
                output, retained, env = self.removal_fixture(anchor)
                result = subprocess.run(['bash', '-c', removal_stand(output, anchor, filename)], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse((anchor / 'live').exists(), 'Removed plugin must not remain in the WebGUI')
                self.assertFalse((anchor / 'state/installed.sha256').exists(), 'Reinstallation must not mistake removal for an accepted boot')
                self.assertEqual(list((anchor / 'state').glob('*.plg')), [], 'Stale cached PLGs must not block a later reinstall')
                self.assertIn('--stop', (anchor / 'worker-calls').read_text())
                self.assertTrue((anchor / 'zfs.master.ui/jobs/stop').is_file())
                for target, data in retained.items(): self.assertEqual(target.read_bytes(), data)

    def test_remove_refuses_busy_worker_or_operation_without_removing_code(self):
        for busy in ('worker', 'operation'):
            with self.subTest(busy=busy), tempfile.TemporaryDirectory(dir=STAND_TMP) as folder:
                anchor = pathlib.Path(folder)
                output, retained, env = self.removal_fixture(anchor)
                if busy == 'worker': env['STOP_STATUS'] = '1'
                with (anchor / 'operation.lock').open('w') as lock:
                    if busy == 'operation': fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    identity = os.fstat(lock.fileno()).st_ino
                    result = subprocess.run(['bash', '-c', removal_stand(output, anchor)], env=env, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0, 'Busy work must prevent removal')
                    self.assertEqual((anchor / 'operation.lock').stat().st_ino, identity, 'Never replace an active lock inode')
                self.assertTrue((anchor / 'live/scripts/zfsm-worker.php').is_file())
                self.assertEqual((anchor / 'state/installed.sha256').read_text(), 'accepted-package\n')
                for target, data in retained.items(): self.assertEqual(target.read_bytes(), data)

    def test_remove_rejects_symlinked_runtime_or_receipt_before_stopping_worker(self):
        for unsafe in ('live', 'state/installed.sha256', 'operation.lock'):
            with self.subTest(unsafe=unsafe), tempfile.TemporaryDirectory(dir=STAND_TMP) as folder:
                anchor = pathlib.Path(folder)
                output, retained, env = self.removal_fixture(anchor)
                if unsafe == 'live':
                    (anchor / 'live').rename(anchor / 'unrelated')
                    (anchor / 'live').symlink_to(anchor / 'unrelated', target_is_directory=True)
                    sentinel = anchor / 'unrelated/scripts/zfsm-worker.php'
                else:
                    sentinel = anchor / 'unrelated'
                    sentinel.write_text('unrelated bytes')
                    target = anchor / unsafe
                    if target.exists(): target.unlink()
                    target.symlink_to(sentinel)
                before = sentinel.read_bytes()
                result = subprocess.run(['bash', '-c', removal_stand(output, anchor)], env=env, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((anchor / 'worker-calls').exists(), 'Unsafe paths must fail before process changes')
                self.assertEqual(sentinel.read_bytes(), before)

    def test_remove_refuses_orphan_services_even_when_worker_script_is_missing(self):
        for name in ('service.lock', 'worker.lock', 'monitor.lock'):
            with self.subTest(lock=name), tempfile.TemporaryDirectory(dir=STAND_TMP) as folder:
                anchor = pathlib.Path(folder)
                output, retained, env = self.removal_fixture(anchor)
                (anchor / 'live/scripts/zfsm-worker.php').unlink()
                with (anchor / name).open('w') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    identity = os.fstat(lock.fileno()).st_ino
                    result = subprocess.run(['bash', '-c', removal_stand(output, anchor)], env=env, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0, 'Running service must block removal of incomplete code')
                    self.assertEqual((anchor / name).stat().st_ino, identity)
                self.assertTrue((anchor / 'live').is_dir())
                self.assertTrue((anchor / 'state/installed.sha256').is_file())

    def test_remove_rejects_nonregular_service_locks_before_worker_can_open_them(self):
        for name in ('service.lock', 'worker.lock', 'monitor.lock'):
            for kind in ('fifo', 'directory'):
                with self.subTest(lock=name, kind=kind), tempfile.TemporaryDirectory(dir=STAND_TMP) as folder:
                    anchor = pathlib.Path(folder)
                    output, retained, env = self.removal_fixture(anchor)
                    if kind == 'fifo': os.mkfifo(anchor / name)
                    else: (anchor / name).mkdir()
                    result = subprocess.run(['bash', '-c', removal_stand(output, anchor)], env=env, capture_output=True, text=True, timeout=5)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse((anchor / 'worker-calls').exists(), 'Worker fopen must not reach a FIFO and hang uninstall')
                    self.assertTrue((anchor / 'live').is_dir())
                    self.assertTrue((anchor / 'state/installed.sha256').is_file())

    def test_public_install_uses_director_url_without_manual_state_directory(self):
        with tempfile.TemporaryDirectory(dir=STAND_TMP) as tmp:
            output = pathlib.Path(tmp) / 'build'
            subprocess.run(['python3', str(ROOT / 'tools/build-installer.py'), '--output', str(output),
                            '--release-base-url', 'https://example.invalid/releases/2026.10.22.1'],
                           cwd=ROOT, check=True, capture_output=True)
            self.assertTrue((output / 'zfs-director.plg').is_file(), 'The public plugin URL must use ZFS Director branding')
            with zipfile.ZipFile(output / 'ZFS-Director-2026.10.22.1-Unraid.zip') as bundle:
                guide = bundle.read('INSTALL.txt').decode()
                self.assertIn('https://example.invalid/releases/2026.10.22.1/zfs-director.plg', guide)
                self.assertNotIn('explicit acceptance', guide)
                self.assertNotIn('Copy its TWO files', guide)
                self.assertNotIn('/boot/config/plugins/zfs.master.ui/', guide)

    def test_packaged_post_hook_calls_completion_only_when_runtime_exists(self):
        with tempfile.TemporaryDirectory(dir=STAND_TMP) as folder:
            anchor = pathlib.Path(folder)
            script = anchor / 'complete.php'
            calls = anchor / 'calls'
            php = anchor / 'php-boundary'
            php.write_text('#!/bin/bash\nprintf "%s\\n" "$*" > ' + shlex.quote(str(calls)) + '\nexit "${COMPLETE_STATUS:-0}"\n')
            php.chmod(0o700)
            hook = (ROOT / 'src/scripts/zfsm-plugin-hook').read_text().replace('/usr/local/emhttp/plugins/zfs.master.ui/scripts/zfsm-install-complete.php', str(script)).replace('/usr/bin/php', shlex.quote(str(php)))
            command = ['bash', '-c', hook, 'hook', 'plugin', 'install', 'zfs-director.plg']
            missing = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(missing.returncode, 0)
            self.assertFalse(calls.exists(), 'Uninstalled runtime must not be invoked by a leftover hook')
            script.write_text('synthetic external process boundary')
            ready = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(ready.returncode, 0)
            self.assertEqual(calls.read_text().split(), [str(script), 'plugin', 'install', 'zfs-director.plg'])
            failed = subprocess.run(command, env=dict(os.environ, COMPLETE_STATUS='1'), capture_output=True, text=True)
            self.assertEqual(failed.returncode, 1, 'Post-hook must propagate activation failure')

    def test_boot_mode_requires_an_automatically_recorded_matching_package(self):
        with tempfile.TemporaryDirectory(dir=STAND_TMP) as tmp:
            root = pathlib.Path(tmp)
            output = root / 'build'
            subprocess.run(['python3', str(ROOT / 'tools/build-installer.py'), '--output', str(output)],
                           cwd=ROOT, check=True, capture_output=True)
            digest = hashlib.sha256(next(output.glob('*.tgz')).read_bytes()).hexdigest()
            install = (output / 'install.sh').read_text()
            gate = install.split('\npreflight\n# Read-only prerequisite gate', 1)[0] + '\npreflight\n'
            # The read-only PLG gate does not depend on having downloaded TGZ yet.
            gate = '\n'.join(line for line in gate.splitlines() if not (line.startswith("printf '%s  %s") and 'sha256sum -c' in line))
            for receipt, runtime, expected in [(None, False, 'install'), ('old-package', False, 'install'), (digest, False, 'accepted-boot'), (digest, True, 'install')]:
                with self.subTest(receipt=receipt, runtime=runtime), tempfile.TemporaryDirectory(dir=STAND_TMP) as folder:
                    anchor = pathlib.Path(folder)
                    state = anchor / 'boot/config/plugins/zfs.master.ui'
                    state.mkdir(parents=True)
                    if receipt is not None: (state / 'installed.sha256').write_text(receipt + '\n')
                    if runtime: (anchor / 'plugins/zfs.master.ui').mkdir(parents=True)
                    observed = anchor / 'mode'
                    php = anchor / 'php-boundary'
                    php.write_text('#!/bin/bash\nprintf "%s" "${@: -1}" > ' + shlex.quote(str(observed)) + '\n')
                    php.chmod(0o700)
                    translated = gate.replace('/boot/config/plugins', str(anchor / 'boot/config/plugins')).replace('/var/log/plugins', str(anchor / 'registry'))
                    translated = translated.replace('/usr/local/emhttp/plugins', str(anchor / 'plugins')).replace('/var/lock/zfs.master.ui.lock', str(anchor / 'operation.lock')).replace('/usr/bin/php', shlex.quote(str(php)))
                    result = subprocess.run(['bash', '-c', translated], capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(observed.read_text(), expected, 'Only a matching installed package may use boot recovery semantics')

    def test_boot_reconstruction_does_not_require_an_activation_hash(self):
        with tempfile.TemporaryDirectory(dir=STAND_TMP) as tmp:
            output = pathlib.Path(tmp) / 'build'
            subprocess.run(['python3', str(ROOT / 'tools/build-installer.py'), '--output', str(output)],
                           cwd=ROOT, check=True, capture_output=True)
            install = (output / 'install.sh').read_text()
            self.assertNotIn('activation.sha256', install, 'Installed plugin boot must not depend on an administrator acceptance token')
            self.assertIn("mode=accepted-boot", install, 'Boot must retain pending-recovery preflight semantics')

    def test_manual_zip_hands_matching_ready_files_to_unraid_without_build_tools(self):
        for public in (False, True):
            with self.subTest(public=public), tempfile.TemporaryDirectory(dir=STAND_TMP) as folder:
                output = pathlib.Path(folder) / 'build'
                args = ['python3', str(ROOT / 'tools/build-installer.py'), '--output', str(output)]
                if public:
                    args += ['--release-base-url', 'https://example.invalid/releases/2026.10.22.1']
                subprocess.run(args, cwd=ROOT, check=True, capture_output=True)
                plugin_name = 'zfs-director.plg' if public else 'zfs.master.ui.local.plg'
                bundle = output / 'ZFS-Director-2026.10.22.1-Unraid.zip'
                self.assertTrue(bundle.is_file(), 'Users need a ready manual-install ZIP')
                with zipfile.ZipFile(bundle) as archive:
                    self.assertIsNone(archive.testzip())
                    names = set(archive.namelist())
                    expected = {'INSTALL.txt', 'INSTALL.ru.txt', 'INSTALLATION.md', 'SHA256SUMS',
                                'zfs-director/' + plugin_name,
                                'zfs-director/zfs-director-2026.10.22.1.tgz'}
                    if public:
                        expected.update(['legacy-local/zfs.master.ui.local.plg', 'legacy-public/zfs.master.ui.plg'])
                    self.assertEqual(names, expected, 'Bundle must not contain source, settings or Jobs')
                    for entry in archive.infolist():
                        self.assertFalse(entry.is_dir())
                        self.assertFalse(entry.filename.startswith('/'))
                        self.assertNotIn('..', pathlib.PurePosixPath(entry.filename).parts)
                        self.assertEqual((entry.external_attr >> 16) & 0o170000, 0o100000)
                    for line in archive.read('SHA256SUMS').decode().splitlines():
                        digest, name = line.split('  ', 1)
                        self.assertEqual(digest, hashlib.sha256(archive.read(name)).hexdigest())
                    self.assertEqual(len(archive.read('SHA256SUMS').splitlines()), len(expected) - 1)
                    for name in (plugin_name, 'zfs-director-2026.10.22.1.tgz'):
                        self.assertEqual(archive.read('zfs-director/' + name), (output / name).read_bytes())
                    for name in ('INSTALL.txt', 'INSTALL.ru.txt'):
                        guide = archive.read(name).decode()
                        self.assertIn('Plugins', guide)
                        self.assertIn('Install Plugin', guide)
                        self.assertNotIn('manual activation is required', guide)
                        if public: self.assertIn('https://example.invalid/releases/2026.10.22.1/zfs-director.plg', guide)
                        self.assertNotRegex(guide, r'(?im)^\s*(?:npm |npx |python3 |git clone)')
                    # Reproduce only the documented file handoff in a private stand.
                    # No installation code is executed and no host path is used.
                    extracted = pathlib.Path(folder) / 'unpacked'
                    archive.extractall(extracted)
                stand = pathlib.Path(folder) / 'flash/config/plugins'
                state = stand / 'zfs.master.ui'
                state.mkdir(parents=True)
                sentinel = state / 'zfs.master.ui.cfg'
                sentinel.write_bytes(b'preserved synthetic settings')
                for source in (extracted / 'zfs-director').iterdir():
                    (state / source.name).write_bytes(source.read_bytes())
                plugin = ET.parse(state / plugin_name).getroot()
                package_path = pathlib.PurePosixPath(plugin.find('FILE[@Name]').attrib['Name'])
                local_package = stand / package_path.relative_to('/boot/config/plugins')
                self.assertTrue(local_package.is_file())
                self.assertEqual(plugin.findtext('FILE[@Name]/MD5'), hashlib.md5(local_package.read_bytes()).hexdigest())
                self.assertEqual(sentinel.read_bytes(), b'preserved synthetic settings')

    def test_plugin_manager_preflight_reports_unsafe_paths_before_package_resolution(self):
        with tempfile.TemporaryDirectory(dir=STAND_TMP) as folder:
            root = pathlib.Path(folder)
            out = root / 'build'
            subprocess.run(['python3', str(ROOT / 'tools/build-installer.py'), '--output', str(out), '--release-base-url', 'https://example.invalid/releases/2026.10.22.1'], check=True, capture_output=True)
            first = ET.parse(out / 'zfs-director.plg').findall('FILE')[0]
            self.assertNotIn('Name', first.attrib)
            gate = first.findtext('INLINE')
            # Exercise exact type checks with a FIFO (opening it would hang),
            # a directory and a redirected operation lock. The PHP legacy
            # planner is covered by installer-legacy.test.mjs and native tests.
            check = gate[gate.index('for directory in "$live"'):gate.index('# End legacy migration guard.')]
            for kind in ('fifo', 'directory', 'symlink'):
                with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=STAND_TMP) as stand:
                    base = pathlib.Path(stand)
                    lock = base / 'lock'
                    if kind == 'fifo': os.mkfifo(lock)
                    elif kind == 'directory': lock.mkdir()
                    else: lock.symlink_to(base / 'missing')
                    translated = check.replace('/var/lock/zfs.master.ui.lock', str(lock)).replace('/boot/config/plugins/zfs.master.ui/protection', str(base / 'protection'))
                    result = subprocess.run(['bash', '-c', 'set -eu\nlive=' + shlex.quote(str(base / 'live')) + '\n' + translated], capture_output=True, text=True, timeout=5)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('unsafe installer lock', result.stdout, 'Plugin Manager must display the reason on stdout')

    def test_vm_acceptance_rejects_failed_or_nonempty_pool_inventory(self):
        # A failed inventory command with no stdout must never authorize tests
        # on an unknown VM. Exercise the actual runner's inventory gate.
        text = (ROOT / 'tests/native-linux/public-zip-unraid.sh').read_text()
        gate = text.split('[[ $(cat /boot/ZFSD-DISPOSABLE-INSTALLER-TEST)', 1)[1].split('\n', 1)[1].split('if [[ $#', 1)[0]
        for body, code in [("return 0", 0), ("printf 'existing-pool\\n'; return 0", 1), ("return 7", 7)]:
            with self.subTest(body=body):
                result = subprocess.run(['bash', '-c', 'set -euo pipefail\nzpool() { ' + body + '; }\n' + gate], capture_output=True, text=True)
                self.assertEqual(result.returncode, code, result.stderr)

    def test_stable_plugin_url_base_drives_update_checks_but_not_package_pinning(self):
        # A tag-pinned pluginURL makes Plugin Manager poll the same release forever.
        builder = ROOT / 'tools/build-installer.py'
        base = 'https://example.invalid/releases/2026.10.22.1'
        stable = 'https://example.invalid/stable/main'
        with tempfile.TemporaryDirectory(dir=STAND_TMP) as tmp:
            out = pathlib.Path(tmp) / 'build'
            subprocess.run(['python3', str(builder), '--output', str(out), '--release-base-url', base,
                            '--plugin-url-base', stable + '/'], cwd=ROOT, check=True, capture_output=True)
            for name in ['zfs-director.plg', 'zfs.master.ui.plg', 'zfs.master.ui.local.plg']:
                plugin = ET.parse(out / name).getroot()
                self.assertEqual(plugin.attrib['pluginURL'], stable + '/' + name)
                self.assertEqual(plugin.findtext('FILE[@Name]/URL'), base + '/zfs-director-2026.10.22.1.tgz')
            result = subprocess.run(['python3', str(builder), '--output', str(pathlib.Path(tmp) / 'local'),
                                     '--plugin-url-base', stable], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('--plugin-url-base requires --release-base-url', result.stderr)

    def test_public_zip_includes_matching_legacy_upgrade_without_build_or_namespace_change(self):
        with tempfile.TemporaryDirectory(dir=STAND_TMP) as tmp:
            out = pathlib.Path(tmp) / 'build'
            subprocess.run(['python3', str(ROOT / 'tools/build-installer.py'), '--output', str(out),
                            '--release-base-url', 'https://example.invalid/releases/2026.10.22.1'],
                           cwd=ROOT, check=True, capture_output=True)
            with zipfile.ZipFile(out / 'ZFS-Director-2026.10.22.1-Unraid.zip') as zipped:
                self.assertIn('legacy-local/zfs.master.ui.local.plg', zipped.namelist(), 'The public ZIP must provide an upgrade for existing .local registrations')
                legacy = ET.fromstring(zipped.read('legacy-local/zfs.master.ui.local.plg'))
                public = ET.fromstring(zipped.read('zfs-director/zfs-director.plg'))
                self.assertEqual(legacy.attrib['name'], 'zfs.master.ui')
                self.assertTrue(legacy.attrib['pluginURL'].endswith('/zfs.master.ui.local.plg'))
                self.assertEqual(legacy.find('FILE[@Name]').attrib, public.find('FILE[@Name]').attrib)
                self.assertEqual(legacy.findtext('FILE[@Name]/MD5'), public.findtext('FILE[@Name]/MD5'))
                self.assertEqual(legacy.findtext('FILE[@Name]/URL'), public.findtext('FILE[@Name]/URL'))
                install = [x.findtext('INLINE') for x in legacy.findall('FILE')
                           if x.attrib.get('Run') == '/bin/bash' and 'Method' not in x.attrib][-1]
                self.assertIsNotNone(install)
    def test_stop_marker_rejects_unsafe_runtime_paths_without_touching_other_files(self):
        # Removing the no-follow/owner/permission checks must expose the
        # unrelated sentinel or incorrectly accept an unsafe runtime path.
        with tempfile.TemporaryDirectory(dir=STAND_TMP) as tmp:
            output = pathlib.Path(tmp) / 'build'
            subprocess.run(['python3', str(ROOT / 'tools/build-installer.py'), '--output', str(output)],
                           cwd=ROOT, check=True, capture_output=True)
            install = (output / 'install.sh').read_text()
            for recovery in (0, 1):
                for unsafe in ('runtime-symlink', 'jobs-symlink', 'stop-symlink',
                               'runtime-writable', 'jobs-writable', 'stop-writable', 'stop-hardlink', 'wrong-owner'):
                    with self.subTest(recovery=recovery, unsafe=unsafe), tempfile.TemporaryDirectory(dir=STAND_TMP) as stand:
                        anchor = pathlib.Path(stand)
                        sentinel = anchor / 'unrelated'
                        sentinel.mkdir()
                        protected = sentinel / 'stop'
                        protected.write_bytes(b'unrelated original bytes\n')
                        runtime = anchor / 'zfs.master.ui'
                        jobs = runtime / 'jobs'
                        if unsafe == 'runtime-symlink':
                            runtime.symlink_to(sentinel, target_is_directory=True)
                        else:
                            runtime.mkdir(mode=0o700)
                            if unsafe == 'jobs-symlink':
                                jobs.symlink_to(sentinel, target_is_directory=True)
                            else:
                                jobs.mkdir(mode=0o700)
                                if unsafe == 'stop-symlink':
                                    (jobs / 'stop').symlink_to(protected)
                                elif unsafe == 'stop-hardlink':
                                    os.link(protected, jobs / 'stop')
                                elif unsafe == 'stop-writable':
                                    (jobs / 'stop').write_text('existing unsafe stop')
                                    (jobs / 'stop').chmod(0o666)
                                elif unsafe == 'runtime-writable':
                                    runtime.chmod(0o777)
                                elif unsafe == 'jobs-writable':
                                    jobs.chmod(0o770)
                        branch = startup_stand(install, anchor)
                        if unsafe == 'wrong-owner':
                            branch = branch.replace('-- ' + shlex.quote(str(anchor)) + ' ' + str(os.geteuid()) + ' ',
                                                    '-- ' + shlex.quote(str(anchor)) + ' ' + str(os.geteuid() + 1) + ' ')
                        result = subprocess.run(['bash', '-c', 'set -eu\nlive=/stand/plugin\nhold_recovery=' + str(recovery) + '\n' + branch],
                                                capture_output=True, text=True)
                        self.assertEqual(protected.read_bytes(), b'unrelated original bytes\n')
                        self.assertFalse((sentinel / 'jobs').exists(), 'Unsafe runtime parent must not acquire a jobs directory')
                        self.assertNotEqual(result.returncode, 0, 'Unsafe runtime must fail closed')
                        if unsafe == 'stop-writable':
                            self.assertEqual((jobs / 'stop').read_text(), 'existing unsafe stop')

    def test_stop_marker_is_private_and_replaces_existing_marker_atomically(self):
        with tempfile.TemporaryDirectory(dir=STAND_TMP) as tmp:
            anchor = pathlib.Path(tmp)
            output = anchor / 'build'
            subprocess.run(['python3', str(ROOT / 'tools/build-installer.py'), '--output', str(output)],
                           cwd=ROOT, check=True, capture_output=True)
            branch = startup_stand((output / 'install.sh').read_text(), anchor)
            command = ['bash', '-c', 'set -eu\nlive=/stand/plugin\nhold_recovery=1\n' + branch]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            runtime = anchor / 'zfs.master.ui'
            jobs = runtime / 'jobs'
            stop = jobs / 'stop'
            for directory in (runtime, jobs):
                self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            self.assertEqual(stop.stat().st_mode & 0o777, 0o600)
            stop.write_text('previous marker bytes')
            with stop.open('rb') as previous:
                result = subprocess.run(command, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(previous.read(), b'previous marker bytes', 'Existing inode must never be truncated')
            self.assertEqual(stop.read_text(), 'package installation in progress\n')
            self.assertEqual(list(jobs.glob('.stop-*')), [], 'Atomic marker staging must leave no residue')

    def test_release_package_has_pinned_urls_checksums_and_reproducible_bytes(self):
        # A missing/wrong URL, an unpinned package or nondeterministic build
        # must fail before these artifacts are offered to a plugin manager.
        builder = ROOT / 'tools/build-installer.py'
        base = 'https://downloads.example.invalid/zfs-director/2026.10.22.1'
        with tempfile.TemporaryDirectory(dir=STAND_TMP) as tmp:
            outputs = [pathlib.Path(tmp) / name for name in ['first', 'second']]
            for output in outputs:
                result = subprocess.run(['python3', str(builder), '--output', str(output),
                                         '--release-base-url', base + '/'], cwd=ROOT, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            first, second = outputs
            self.assertEqual(sorted(p.name for p in first.iterdir()),
                             ['SHA256SUMS', 'ZFS-Director-2026.10.22.1-Unraid.zip', 'install.sh', 'zfs-director-2026.10.22.1.tgz', 'zfs-director.plg', 'zfs.master.ui.local.plg', 'zfs.master.ui.plg'])
            for path in first.iterdir():
                self.assertEqual(path.read_bytes(), (second / path.name).read_bytes(), path.name)
            for line in (first / 'SHA256SUMS').read_text().splitlines():
                digest, name = line.split('  ', 1)
                self.assertEqual(digest, hashlib.sha256((first / name).read_bytes()).hexdigest())
            plugin = ET.parse(first / 'zfs-director.plg').getroot()
            self.assertEqual(plugin.attrib['pluginURL'], base + '/zfs-director.plg')
            self.assertEqual(plugin.attrib['version'], '2026.10.22.1')
            package = plugin.find('FILE[@Name]')
            self.assertEqual(package.attrib['Name'], '/boot/config/plugins/zfs.master.ui/zfs-director-2026.10.22.1.tgz')
            self.assertEqual(package.findtext('URL'), base + '/zfs-director-2026.10.22.1.tgz')
            self.assertIsNone(package.find('LOCAL'))
            archive = first / 'zfs-director-2026.10.22.1.tgz'
            self.assertEqual(package.findtext('MD5'), hashlib.md5(archive.read_bytes()).hexdigest())
            with tarfile.open(archive) as tar:
                release = json.load(tar.extractfile('zfs.master.ui/release.json'))
                self.assertEqual(release['status'], 'release')
                for line in tar.extractfile('zfs.master.ui/SHA256SUMS').read().decode().splitlines():
                    digest, name = line.split('  ', 1)
                    self.assertEqual(digest, hashlib.sha256(tar.extractfile('zfs.master.ui/' + name).read()).hexdigest())
            scripts = [f.findtext('INLINE') for f in plugin.findall('FILE') if f.find('INLINE') is not None]
            for script in scripts:
                result = subprocess.run(['bash', '-n'], input=script, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            install = (first / 'install.sh').read_text()
            self.assertIn(install, scripts)
            # Run only the actual checksum gate, redirected into this stand.
            # No installer, host preflight or runtime replacement is executed.
            gate = install.split('# Legacy migration guard.', 1)[0]
            gate = gate.replace('/boot/config/plugins/zfs.master.ui/' + archive.name, str(archive))
            result = subprocess.run(['bash', '-c', gate], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            archive.write_bytes(archive.read_bytes() + b'tampered')
            result = subprocess.run(['bash', '-c', gate], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0, 'Tampered release archive must be rejected')

    def test_release_base_url_rejects_unsafe_or_ambiguous_destinations_before_writing(self):
        builder = ROOT / 'tools/build-installer.py'
        invalid = ['', 'http://example.invalid/release', 'file:///tmp/release',
                   'https:///release', 'https://user:secret@example.invalid/release',
                   'https://example.invalid/release?token=secret', 'https://example.invalid/release?',
                   'https://example.invalid/release#fragment', 'https://example.invalid/release#',
                   'https://example.invalid:wrong/release', 'https://example.invalid/a/../release',
                   'https://example.invalid/a%2frelease', 'https://example.invalid/a b',
                   'https://example.invalid/release\n', 'https://example.invalid\\evil/release']
        with tempfile.TemporaryDirectory() as tmp:
            for index, url in enumerate(invalid):
                with self.subTest(url=url):
                    output = pathlib.Path(tmp) / str(index)
                    result = subprocess.run(['python3', str(builder), '--output', str(output),
                                             '--release-base-url', url], cwd=ROOT, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('release base URL', result.stderr)
                    self.assertFalse(output.exists(), 'Invalid URL must not create partial artifacts')

    def test_package_preserves_state_namespace_and_starts_services_automatically(self):
        builder = ROOT / 'tools/build-installer.py'
        self.assertTrue(builder.is_file(), 'Missing offline installer builder')
        with tempfile.TemporaryDirectory(dir=STAND_TMP) as tmp:
            subprocess.run(['python3', str(builder), '--output', tmp], cwd=ROOT, check=True, capture_output=True)
            out = pathlib.Path(tmp)
            archive = next(out.glob('*.tgz'))
            sha = hashlib.sha256(archive.read_bytes()).hexdigest()
            plugin = ET.parse(out / 'zfs.master.ui.local.plg').getroot()
            self.assertEqual(plugin.attrib['name'], 'zfs.master.ui')
            self.assertEqual(plugin.attrib['launch'], 'Main/ZFSDirector')
            self.assertEqual(plugin.attrib['min'], '7.3.3')
            self.assertFalse(plugin.findall('.//URL'))
            with tarfile.open(archive) as tar:
                for entry in tar:
                    self.assertTrue(entry.isfile())
                    self.assertTrue(entry.name.startswith('zfs.master.ui/'))
                    rel = pathlib.PurePosixPath(entry.name).relative_to('zfs.master.ui')
                    self.assertNotIn('..', rel.parts)
                    self.assertNotIn(rel.parts[0], ['jobs', 'audit', 'monitor', 'experiments'])
                    self.assertNotIn(rel.name, ['zfsm-convert.pl', 'ZFSMConversionPinned.php'])
                    if (ROOT / 'src' / rel).is_file():
                        self.assertEqual(tar.extractfile(entry).read(), (ROOT / 'src' / rel).read_bytes())
                release = json.load(tar.extractfile('zfs.master.ui/release.json'))
                self.assertEqual(release['display_name'], 'ZFS Director')
            scripts = [f.findtext('INLINE') for f in plugin.findall('FILE') if f.find('INLINE') is not None]
            for script in scripts:
                p = subprocess.run(['bash', '-n'], input=script, text=True, capture_output=True)
                self.assertEqual(p.returncode, 0, p.stderr)
            install = next(s for s in scripts if 'sha256sum -c' in s)
            self.assertIn(sha, install)
            self.assertNotIn('activation.sha256', install)
            probe = '/usr/bin/perl -e ' + shlex.quote((ROOT / 'src/scripts/zfsm-directory.pl').read_text())
            self.assertTrue(probe in install, 'Installer must probe the exact packaged directory helper')
            self.assertLess(install.index(probe), install.index('--stop'))
            self.assertNotIn('landlock_create_ruleset', install)
            self.assertLess(install.index('--stop'), install.index('tar -xzf'))
            self.assertNotIn('--launch', install, 'Services must wait for the native registration post-hook')
            self.assertNotIn('rm -rf', install)
            self.assertNotIn('zfs destroy', install)

            # Before Plugin Manager registration, every mode retains the pause.
            # Actual post-hook readiness is exercised by native Unraid tests.
            branch = startup_stand(install, out)
            result = subprocess.run(['bash', '-c', 'set -eu\n' + branch], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((out / 'zfs.master.ui/jobs/stop').is_file())



if __name__ == '__main__':
    unittest.main()
