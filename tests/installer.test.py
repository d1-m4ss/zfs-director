"""Exercise the real generated offline package; no host installation."""
import hashlib
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
    branch = guard + install.split('flock -u 9\n', 1)[1]
    branch = branch.replace('/boot/config/plugins/zfs.master.ui/activation.sha256', str(anchor / 'activation.sha256'))
    branch = branch.replace('/var/tmp/zfs.master.ui/jobs', str(anchor / 'zfs.master.ui/jobs'))
    return branch.replace('-- /var/tmp 0 ', '-- ' + shlex.quote(str(anchor)) + ' ' + str(os.geteuid()) + ' ')


class InstallerTests(unittest.TestCase):
    def test_public_install_uses_director_url_without_manual_state_directory(self):
        with tempfile.TemporaryDirectory(dir=STAND_TMP) as tmp:
            output = pathlib.Path(tmp) / 'build'
            subprocess.run(['python3', str(ROOT / 'tools/build-installer.py'), '--output', str(output),
                            '--release-base-url', 'https://example.invalid/releases/2026.10.22.1'],
                           cwd=ROOT, check=True, capture_output=True)
            self.assertTrue((output / 'zfs-director.plg').is_file(), 'The public plugin URL must use ZFS Director branding')
            with zipfile.ZipFile(output / 'ZFS-Director-2026.10.22.1-Unraid-RC1.zip') as bundle:
                guide = bundle.read('INSTALL.txt').decode()
                self.assertIn('https://example.invalid/releases/2026.10.22.1/zfs-director.plg', guide)
                self.assertNotIn('explicit acceptance', guide)
                self.assertNotIn('Copy its TWO files', guide)
                self.assertNotIn('/boot/config/plugins/zfs.master.ui/', guide)

    def test_healthy_install_starts_services_without_activation_file(self):
        with tempfile.TemporaryDirectory(dir=STAND_TMP) as tmp:
            anchor = pathlib.Path(tmp)
            output = anchor / 'build'
            subprocess.run(['python3', str(ROOT / 'tools/build-installer.py'), '--output', str(output)],
                           cwd=ROOT, check=True, capture_output=True)
            launched = anchor / 'launched'
            php = anchor / 'php-boundary'
            php.write_text('#!/bin/bash\nif [[ "$1" != -r ]]; then printf "%s\\n" "$@" > ' + shlex.quote(str(launched)) + '; fi\n')
            php.chmod(0o700)
            branch = startup_stand((output / 'install.sh').read_text(), anchor)
            branch = branch.replace('/usr/bin/php', shlex.quote(str(php)))
            result = subprocess.run(['bash', '-c', 'set -eu\nlive=/stand/plugin\nhold_recovery=0\n' + branch],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(launched.exists(), 'A normal installation must start Director without a terminal activation step')
            self.assertEqual(launched.read_text().splitlines(), ['/stand/plugin/scripts/zfsm-worker.php', '--launch'])
            self.assertFalse((anchor / 'activation.sha256').exists())
            self.assertFalse((anchor / 'zfs.master.ui/jobs/stop').exists())

    def test_failed_automatic_start_leaves_services_paused_and_reports_failure(self):
        with tempfile.TemporaryDirectory(dir=STAND_TMP) as tmp:
            anchor = pathlib.Path(tmp)
            output = anchor / 'build'
            subprocess.run(['python3', str(ROOT / 'tools/build-installer.py'), '--output', str(output)],
                           cwd=ROOT, check=True, capture_output=True)
            calls = anchor / 'calls'
            launcher = anchor / 'php-boundary'
            launcher.write_text('#!/bin/bash\nprintf "%s\\n" "$*" >> ' + shlex.quote(str(calls)) + '\n[[ "$2" != --launch ]]\n')
            launcher.chmod(0o700)
            branch = startup_stand((output / 'install.sh').read_text(), anchor)
            branch = branch.replace('/usr/bin/php', shlex.quote(str(launcher)))
            result = subprocess.run(['bash', '-c', 'set -eu\nlive=/stand/plugin\nhold_recovery=0\n' + branch],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0, 'A failed launch must not be reported as a successful install')
            self.assertIn('could not start', result.stderr)
            self.assertEqual(calls.read_text().splitlines(), ['/stand/plugin/scripts/zfsm-worker.php --launch', '/stand/plugin/scripts/zfsm-worker.php --stop'])
            self.assertIn('failed to start', (anchor / 'zfs.master.ui/jobs/stop').read_text())

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
            for receipt, runtime, expected in [(None, False, 'upgrade'), ('old-package', False, 'upgrade'), (digest, False, 'accepted-boot'), (digest, True, 'upgrade')]:
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
                bundle = output / 'ZFS-Director-2026.10.22.1-Unraid-RC1.zip'
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

    def test_plugin_manager_preflight_runs_before_package_resolution(self):
        # A wrong namespace must be refused before Plugin Manager can unlink
        # the installed TGZ on a checksum mismatch and attempt a download.
        with tempfile.TemporaryDirectory(dir=STAND_TMP) as tmp:
            out = pathlib.Path(tmp) / 'build'
            subprocess.run(['python3', str(ROOT / 'tools/build-installer.py'), '--output', str(out),
                            '--release-base-url', 'https://example.invalid/releases/2026.10.22.1'],
                           cwd=ROOT, check=True, capture_output=True)
            for filename, conflict in [('zfs-director.plg', 'zfs.master.ui.local.plg'),
                                       ('zfs.master.ui.local.plg', 'zfs-director.plg'),
                                       ('zfs.master.ui.plg', 'zfs-director.plg')]:
                with self.subTest(plugin=filename):
                    xml = ET.parse(out / filename).getroot()
                    first = xml.findall('FILE')[0]
                    self.assertNotIn('Name', first.attrib, 'Readonly preflight must run BEFORE the archive FILE')
                    self.assertEqual(first.attrib.get('Run'), '/bin/bash')
                    boot = pathlib.Path(tmp) / filename / 'boot/config/plugins'
                    state = boot / 'zfs.master.ui'
                    registry = pathlib.Path(tmp) / filename / 'registry'
                    state.mkdir(parents=True)
                    registry.mkdir(parents=True)
                    (boot / conflict).write_text('existing opposite registration')
                    archive = state / 'zfs-director-2026.10.22.1.tgz'
                    archive.write_bytes(b'existing accepted package, deliberately different')
                    gate = first.findtext('INLINE').replace('/boot/config/plugins', str(boot)).replace('/var/log/plugins', str(registry))
                    gate = gate.replace('/usr/local/emhttp/plugins', str(pathlib.Path(tmp) / filename / 'live')).replace('/var/lock/zfs.master.ui.lock', str(pathlib.Path(tmp) / filename / 'lock'))
                    result = subprocess.run(['bash', '-c', gate], capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('conflicting plugin registration', result.stderr)
                    self.assertEqual(archive.read_bytes(), b'existing accepted package, deliberately different')

    def test_vm_acceptance_rejects_failed_or_nonempty_pool_inventory(self):
        # A failed inventory command with no stdout must never authorize tests
        # on an unknown VM. Exercise the actual runner's inventory gate.
        text = (ROOT / 'tests/native-linux/public-zip-unraid.sh').read_text()
        gate = text.split('[[ $(cat /boot/ZFSD-DISPOSABLE-INSTALLER-TEST)', 1)[1].split('\n', 1)[1].split('if [[ $#', 1)[0]
        for body, code in [("return 0", 0), ("printf 'existing-pool\\n'; return 0", 1), ("return 7", 7)]:
            with self.subTest(body=body):
                result = subprocess.run(['bash', '-c', 'set -euo pipefail\nzpool() { ' + body + '; }\n' + gate], capture_output=True, text=True)
                self.assertEqual(result.returncode, code, result.stderr)

    def test_public_zip_includes_matching_legacy_upgrade_without_build_or_namespace_change(self):
        with tempfile.TemporaryDirectory(dir=STAND_TMP) as tmp:
            out = pathlib.Path(tmp) / 'build'
            subprocess.run(['python3', str(ROOT / 'tools/build-installer.py'), '--output', str(out),
                            '--release-base-url', 'https://example.invalid/releases/2026.10.22.1'],
                           cwd=ROOT, check=True, capture_output=True)
            with zipfile.ZipFile(out / 'ZFS-Director-2026.10.22.1-Unraid-RC1.zip') as zipped:
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
                # Run the legacy gate: its own registration must pass, while
                # a public registration must stop it before worker/code writes.
                boot = pathlib.Path(tmp) / 'boot/config/plugins'
                state = boot / 'zfs.master.ui'
                registry = pathlib.Path(tmp) / 'registry'
                state.mkdir(parents=True)
                registry.mkdir()
                package = 'zfs-director-2026.10.22.1.tgz'
                (state / package).write_bytes(zipped.read('zfs-director/' + package))
                (boot / 'zfs.master.ui.local.plg').write_text('existing local')
                early = install.split('# Runtime stop marker guard.\n', 1)[0]
                early = early.replace('/boot/config/plugins', str(boot)).replace('/var/log/plugins', str(registry))
                early = early.replace('/usr/local/emhttp/plugins', str(pathlib.Path(tmp) / 'live')).replace('/var/lock/zfs.master.ui.lock', str(pathlib.Path(tmp) / 'operation.lock'))
                own = subprocess.run(['bash', '-c', early], capture_output=True, text=True)
                self.assertEqual(own.returncode, 0, own.stderr)
                (registry / 'zfs-director.plg').symlink_to(boot / 'missing-public')
                other = subprocess.run(['bash', '-c', early], capture_output=True, text=True)
                self.assertNotEqual(other.returncode, 0)
                self.assertEqual((boot / 'zfs.master.ui.local.plg').read_text(), 'existing local')

    def test_install_rejects_other_registration_before_stopping_or_replacing_code(self):
        # Without this guard the real Plugin Manager can register both names,
        # making managed cron ownership ambiguous after a successful install.
        for public in (True, False):
            with self.subTest(public=public), tempfile.TemporaryDirectory(dir=STAND_TMP) as tmp:
                root = pathlib.Path(tmp)
                output = root / 'build'
                args = ['python3', str(ROOT / 'tools/build-installer.py'), '--output', str(output)]
                if public:
                    args += ['--release-base-url', 'https://example.invalid/releases/2026.10.22.1']
                subprocess.run(args, cwd=ROOT, check=True, capture_output=True)
                boot = root / 'boot/config/plugins'
                state = boot / 'zfs.master.ui'
                registered = root / 'var/log/plugins'
                state.mkdir(parents=True)
                registered.mkdir(parents=True)
                package = next(output.glob('*.tgz'))
                (state / package.name).write_bytes(package.read_bytes())
                current = 'zfs-director.plg' if public else 'zfs.master.ui.local.plg'
                other = 'zfs.master.ui.local.plg' if public else 'zfs-director.plg'
                # Execute the real package's early gate; no host path is used.
                gate = (output / 'install.sh').read_text().split('# Runtime stop marker guard.\n', 1)[0]
                gate = gate.replace('/boot/config/plugins', str(boot)).replace('/var/log/plugins', str(registered))
                gate = gate.replace('/usr/local/emhttp/plugins', str(root / 'runtime')).replace('/var/lock/zfs.master.ui.lock', str(root / 'operation.lock'))
                own = boot / current
                own.write_text('existing own registration')
                for path in [boot / other, state / other, registered / other]:
                    with self.subTest(conflict=str(path.relative_to(root))):
                        path.symlink_to(root / 'absent-legacy-definition')
                        result = subprocess.run(['bash', '-c', gate], capture_output=True, text=True)
                        self.assertNotEqual(result.returncode, 0, 'Conflicting or stale other namespace must fail before any stop/code change')
                        self.assertIn('registration', result.stderr.lower())
                        self.assertTrue(path.is_symlink(), 'Installer must never remove another registration')
                        self.assertEqual(own.read_text(), 'existing own registration')
                        path.unlink()
                result = subprocess.run(['bash', '-c', gate], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)

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
            self.assertEqual(stop.read_text(), 'inspect pending recovery before launch\n')
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
                             ['SHA256SUMS', 'ZFS-Director-2026.10.22.1-Unraid-RC1.zip', 'install.sh', 'zfs-director-2026.10.22.1.tgz', 'zfs-director.plg', 'zfs.master.ui.local.plg', 'zfs.master.ui.plg'])
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
                self.assertEqual(release['status'], 'release-candidate')
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
            gate = install.split('[[ ! -L "$live"', 1)[0]
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
            self.assertLess(install.index("stop_runtime 'starting background services'"), install.index('--launch'))
            self.assertNotIn('rm -rf', install)
            self.assertNotIn('zfs destroy', install)

            # Execute the real boot-activation branch with filesystem/launcher
            # boundaries redirected into the temporary stand. Never boot or
            # touch host /boot or /var/tmp.
            activation = out / 'activation.sha256'
            stop = out / 'zfs.master.ui/jobs/stop'
            launches = out / 'launches'
            launcher = out / 'php-stand'
            launcher.write_text('#!/bin/sh\nif [ "$1" != -r ]; then printf "%s\\n" "$*" >> "' + str(launches) + '"; fi\n')
            launcher.chmod(0o755)
            branch = startup_stand(install, out)
            branch = branch.replace('/usr/bin/php', str(launcher))
            for value, recovery, expected in [(None, 0, 1), ('wrong-package-hash', 0, 1), (sha, 0, 1), (None, 1, 0), (sha, 1, 0)]:
                activation.unlink(missing_ok=True)
                launches.unlink(missing_ok=True)
                if value is not None:
                    activation.write_text(value + '\n')
                stop.unlink(missing_ok=True)
                result = subprocess.run(['bash', '-c', 'set -eu\nlive=/stand/plugin\nhold_recovery=' + str(recovery) + '\n' + branch], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(launches.read_text().splitlines()) if launches.exists() else 0, expected)
                self.assertEqual(stop.exists(), expected == 0)
                if expected:
                    self.assertEqual(launches.read_text().strip(), '/stand/plugin/scripts/zfsm-worker.php --launch')


if __name__ == '__main__':
    unittest.main()
