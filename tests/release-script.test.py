#!/usr/bin/env python3
"""ARCH-007: tools/release.py refuses unsafe states and its dry run changes nothing."""
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
VERSION = (ROOT / 'VERSION').read_text().strip()
NEW = '2099.01.01.1'
COPY = ['VERSION', 'CHANGELOG.md', 'README.md', 'README.ru.md', 'ca_profile.xml', 'zfs-director.xml', 'docs/INSTALLATION.md', 'docs/DEVELOPMENT.md', 'src/README.md', 'tools/release.py']


class ReleaseScriptTests(unittest.TestCase):
    def checkout(self, folder, changelog=True):
        base = pathlib.Path(folder)
        for name in COPY:
            (base / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, base / name)
        if changelog:
            text = (base / 'CHANGELOG.md').read_text()
            (base / 'CHANGELOG.md').write_text('### ' + NEW + '\nTest release.\n\n' + text)
        git = lambda *args: subprocess.run(['git', '-C', str(base), *args], check=True, capture_output=True)
        git('init', '-q', '-b', 'main')
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '-A')
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'fixture')
        return base

    def release(self, base, *args):
        return subprocess.run(['python3', str(base / 'tools/release.py'), *args], cwd=base, capture_output=True, text=True, timeout=30)

    def snapshot(self, base):
        return {name: (base / name).read_bytes() for name in COPY}

    def test_dry_run_on_a_clean_tree_prints_every_step_and_changes_nothing(self):
        with tempfile.TemporaryDirectory() as folder:
            base = self.checkout(folder)
            before = self.snapshot(base)
            result = self.release(base, NEW, '--message', 'Test', '--dry-run')
            self.assertEqual(result.returncode, 0, result.stderr)
            for step in ['tests/installer.test.py', 'npm test', 'capture.mjs', 'check-release.py', 'git commit', 'build-installer.py', 'git tag ' + NEW, 'push origin main ' + NEW, 'gh release create ' + NEW, 'plugin/zfs-director.plg', 'publish PLG files for ' + NEW]:
                self.assertIn(step, result.stdout)
            order = [result.stdout.index(s) for s in ['installer.test.py', 'npm test', 'capture.mjs', '# write VERSION', 'check-release.py', 'git commit', 'build-installer.py', 'git tag', 'gh release create']]
            self.assertEqual(order, sorted(order), 'steps must run in release order')
            self.assertEqual(self.snapshot(base), before)
            self.assertIn('Dry run: nothing was changed.', result.stdout)

    def test_local_dry_run_never_pushes_or_publishes(self):
        with tempfile.TemporaryDirectory() as folder:
            base = self.checkout(folder)
            result = self.release(base, NEW, '--message', 'Test', '--dry-run', '--local')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('push', result.stdout)
            self.assertNotIn('gh release', result.stdout)

    def test_refuses_a_dirty_tree_a_missing_changelog_section_and_the_same_version(self):
        with tempfile.TemporaryDirectory() as folder:
            base = self.checkout(folder)
            (base / 'README.md').write_text((base / 'README.md').read_text() + '\nlocal edit\n')
            result = self.release(base, NEW, '--message', 'Test', '--dry-run')
            self.assertEqual(result.returncode, 1)
            self.assertIn('working tree is not clean', result.stderr)
        with tempfile.TemporaryDirectory() as folder:
            base = self.checkout(folder, changelog=False)
            result = self.release(base, NEW, '--message', 'Test', '--dry-run')
            self.assertEqual(result.returncode, 1)
            self.assertIn('CHANGELOG.md must start with "### ' + NEW + '"', result.stderr)
            result = self.release(base, VERSION, '--message', 'Test', '--dry-run')
            self.assertIn('new version equals VERSION', result.stderr)

    def test_version_check_finds_a_stale_download_link(self):
        with tempfile.TemporaryDirectory() as folder:
            base = self.checkout(folder)
            self.assertEqual(self.release(base, '--check-version').returncode, 0)
            text = (base / 'README.md').read_text()
            (base / 'README.md').write_text(text.replace(VERSION, '2020.01.01.1', 1))
            result = self.release(base, '--check-version')
            self.assertEqual(result.returncode, 1)
            self.assertIn('README.md: still mentions 2020.01.01.1', result.stdout)

    def test_repository_files_match_version(self):
        result = subprocess.run(['python3', str(ROOT / 'tools/release.py'), '--check-version'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout)


if __name__ == '__main__':
    unittest.main()
