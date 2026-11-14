#!/usr/bin/env python3
"""Release ZFS Director step by step; stop at the first failed step (ARCH-007).

Usage:
  tools/release.py NEW_VERSION --message "short summary" [--dry-run] [--local]

The version lives in VERSION. CHANGELOG.md must already start with a "### NEW_VERSION"
section. Every step runs only after the previous one succeeded. --dry-run prints the plan
and changes nothing. --local stops before anything leaves this machine (no push, no
GitHub release). Commits never get trailers; tools/check-release.py also rejects them.
"""
import argparse
import hashlib
import pathlib
import re
import shlex
import subprocess
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPOSITORY = 'd1-m4ss/zfs-director'
RELEASE_URL = 'https://github.com/' + REPOSITORY + '/releases/download/{version}'
PLUGIN_URL = 'https://raw.githubusercontent.com/' + REPOSITORY + '/main/plugin'
VERSION_PATTERN = re.compile(r'^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$')
# Files where the published version appears for users (download links, CA template).
VERSIONED_FILES = ['README.md', 'README.ru.md', 'ca_profile.xml', 'zfs-director.xml', 'docs/INSTALLATION.md', 'src/README.md']
PLUGIN_FILES = ['zfs-director.plg', 'zfs.master.ui.plg', 'zfs.master.ui.local.plg']
SCREENSHOTS = ("docker run --rm -v \"$PWD\":/work -w /work mcr.microsoft.com/playwright:v1.62.1-noble "
               "bash -c 'node docs/preview/server.mjs > /tmp/preview.log 2>&1 & sleep 3; node docs/preview/capture.mjs'")


def current_version():
    version = (ROOT / 'VERSION').read_text().strip()
    if not VERSION_PATTERN.match(version):
        raise SystemExit('VERSION is not a release version: ' + version)
    return version


def version_problems(version):
    """Every user-facing version literal must equal VERSION."""
    problems = []
    for name in VERSIONED_FILES:
        text = (ROOT / name).read_text()
        found = set(re.findall(r'(?<![0-9.])20[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[0-9]+(?![0-9])', text))
        if version not in found:
            problems.append(name + ': does not mention ' + version)
        for other in sorted(found - {version}):
            problems.append(name + ': still mentions ' + other)
    return problems


def run(command, dry_run, check_output=False):
    print('$ ' + command, flush=True)
    if dry_run:
        return ''
    result = subprocess.run(command, shell=True, executable='/bin/bash', cwd=ROOT, text=True, capture_output=check_output)
    if result.returncode != 0:
        if check_output:
            sys.stderr.write((result.stdout or '') + (result.stderr or ''))
        raise SystemExit('Step failed (exit %d): %s' % (result.returncode, command))
    return result.stdout if check_output else ''


def git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, text=True, capture_output=True, check=True).stdout


def preconditions(new, old, local):
    problems = []
    if git('status', '--porcelain').strip():
        problems.append('working tree is not clean')
    if not local and git('rev-parse', '--abbrev-ref', 'HEAD').strip() != 'main':
        problems.append('a public release is made from main')
    if not VERSION_PATTERN.match(new):
        problems.append('new version must look like YYYY.MM.DD.N')
    if new == old:
        problems.append('new version equals VERSION')
    first = next((line for line in (ROOT / 'CHANGELOG.md').read_text().splitlines() if line.startswith('### ')), '')
    if first != '### ' + new:
        problems.append('CHANGELOG.md must start with "### ' + new + '"')
    if git('tag', '--list', new).strip():
        problems.append('tag ' + new + ' already exists')
    return problems


def bump(old, new, dry_run):
    print('# write VERSION and replace ' + old + ' in user-facing files', flush=True)
    if dry_run:
        return
    (ROOT / 'VERSION').write_text(new + '\n')
    for name in VERSIONED_FILES + ['docs/DEVELOPMENT.md']:
        path = ROOT / name
        text = path.read_text()
        if old in text:
            path.write_text(text.replace(old, new))
    left = version_problems(new)
    if left:
        raise SystemExit('Version literals left after bump:\n' + '\n'.join(left))


def verify_published(new, dry_run):
    print('# verify the public PLG serves ' + new + ' and its MD5 matches the package', flush=True)
    if dry_run:
        return
    with urllib.request.urlopen(PLUGIN_URL + '/zfs-director.plg?nocache=' + new, timeout=30) as response:
        plg = response.read().decode()
    package = ROOT / 'dist' / ('release-' + new) / ('zfs-director-' + new + '.tgz')
    digest = hashlib.md5(package.read_bytes()).hexdigest()
    if 'version="' + new + '"' not in plg or digest not in plg:
        raise SystemExit('Published PLG does not match ' + new + ' yet (CDN cache?). Re-run the check later.')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('version', nargs='?')
    parser.add_argument('--message', help='commit summary, for example "Large window button"')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--local', action='store_true', help='commit and build only; publish nothing')
    parser.add_argument('--check-version', action='store_true', help='only check that user-facing files match VERSION')
    args = parser.parse_args()
    old = current_version()
    if args.check_version:
        problems = version_problems(old)
        print('\n'.join(problems) if problems else 'Version literals match ' + old)
        return 1 if problems else 0
    if not args.version or not args.message:
        parser.error('NEW_VERSION and --message are required')
    new = args.version
    problems = preconditions(new, old, args.local)
    if problems:
        print('Release refused:\n- ' + '\n- '.join(problems), file=sys.stderr)
        return 1
    output = 'dist/release-' + new
    summary = shlex.quote('feat: ' + args.message + ' (' + new + ')')
    # Tests and screenshots run first: a failure there leaves the tree untouched.
    run('python3 tests/installer.test.py', args.dry_run)
    run('npm test', args.dry_run)
    run(SCREENSHOTS, args.dry_run)
    bump(old, new, args.dry_run)
    run('python3 tools/check-release.py', args.dry_run)
    run('git add -A && git commit -q -m ' + summary, args.dry_run)
    run('python3 tools/build-installer.py --output ' + output + ' --release-base-url ' + RELEASE_URL.format(version=new)
        + ' --plugin-url-base ' + PLUGIN_URL, args.dry_run)
    run('git tag ' + new, args.dry_run)
    if args.local:
        print('Local release ' + new + ' is committed, tagged and built in ' + output + '; nothing was published.')
        return 0
    push = "git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin main "
    run(push + new, args.dry_run)
    assets = ' '.join(output + '/' + name for name in ['zfs-director-' + new + '.tgz', *PLUGIN_FILES, 'SHA256SUMS', 'ZFS-Director-' + new + '-Unraid.zip'])
    notes = output + '/RELEASE_NOTES.md'
    print('# write ' + notes + ' from the first CHANGELOG.md section', flush=True)
    if not args.dry_run:
        section = (ROOT / 'CHANGELOG.md').read_text().split('### ')[1].split('\n', 1)[1].strip()
        (ROOT / notes).write_text(section + '\n')
    run('gh release create ' + new + ' --repo ' + REPOSITORY + ' --latest --title ' + new + ' --notes-file ' + notes + ' ' + assets, args.dry_run)
    run(' && '.join('cp ' + output + '/' + name + ' plugin/' + name for name in PLUGIN_FILES), args.dry_run)
    run('git add plugin && git commit -q -m ' + shlex.quote('feat: publish PLG files for ' + new), args.dry_run)
    run(push.strip(), args.dry_run)
    verify_published(new, args.dry_run)
    print('Release ' + new + ' published.' if not args.dry_run else 'Dry run: nothing was changed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
