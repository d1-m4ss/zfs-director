#!/usr/bin/env python3
"""Build a local or explicitly addressed public Unraid package; never connect or install."""
import argparse
import copy
import datetime
import gzip
import hashlib
import io
import json
import pathlib
import re
import shlex
import subprocess
import tarfile
import xml.etree.ElementTree as ET
import zipfile
from urllib.parse import urlsplit

ROOT = pathlib.Path(__file__).resolve().parents[1]
VERSION = '2026.10.22.1'
STOP_MARKER = r'''use strict;
use warnings;
use Fcntl qw(:DEFAULT :mode);
my ($base, $owner, $message) = @ARGV;
die "Invalid runtime guard arguments\n" unless defined($message) && $owner =~ /\A[0-9]+\z/ && $base =~ m{\A/} && $base !~ m{(?:\A|/)\.\.?(/|\z)};
sub enter_directory {
    my ($name, $uid, $shared) = @_;
    sysopen(my $directory, $name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) or die "Runtime directory requires inspection\n";
    my @stat = stat($directory);
    die "Untrusted runtime directory\n" unless @stat && S_ISDIR($stat[2]) && $stat[4] == $uid
        && (!(($stat[2]) & 0022) || ($shared && ($stat[2] & 01000)));
    chdir($directory) or die "Unable to enter trusted runtime directory\n";
}
enter_directory('/', 0, 0);
my @parents = grep { length } split m{/}, $base;
for my $index (0 .. $#parents) {
    enter_directory($parents[$index], $index == $#parents ? $owner : 0, 1);
}
for my $name ('zfs.master.ui', 'jobs') {
    if (!lstat($name)) { mkdir($name, 0700) or die "Unable to create runtime directory\n"; }
    enter_directory($name, $owner, 0);
}
my @stop = lstat('stop');
die "Stop marker requires inspection\n" if @stop && (!S_ISREG($stop[2]) || $stop[4] != $owner || ($stop[2] & 0022) || $stop[3] != 1);
my $temporary = '.stop-' . $$ . '-' . int(rand(1000000000));
sysopen(my $marker, $temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) or die "Unable to create stop marker\n";
eval {
    print {$marker} $message, "\n" or die "Unable to write stop marker\n";
    close($marker) or die "Unable to close stop marker\n";
    rename($temporary, 'stop') or die "Unable to publish stop marker\n";
    1;
} or do {
    my $error = $@;
    close($marker) if defined(fileno($marker));
    unlink($temporary);
    die $error;
};
'''


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def release_base_url(value):
    message = 'release base URL must be a plain HTTPS directory URL without credentials, query, fragment or dot segments'
    try:
        parsed = urlsplit(value)
        parsed.port  # Reject malformed port numbers before producing any files.
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None or parsed.password is not None
                or '?' in value or '#' in value or not re.fullmatch(r'[A-Za-z0-9.\-:\[\]]+', parsed.netloc)
                or not re.fullmatch(r'[A-Za-z0-9._~/\-]*', parsed.path)
                or any(part in ('.', '..') for part in parsed.path.split('/'))
                or any(char.isspace() or ord(char) < 32 for char in value)):
            raise ValueError(message)
    except ValueError as error:
        raise argparse.ArgumentTypeError(message) from error
    return value.rstrip('/')


def manual_bundle(output, archive, plugin_name, epoch, release_base=None):
    url = (release_base + '/' + plugin_name) if release_base else 'local PLG from this archive'
    guide = f'''ZFS Director {VERSION} RC1 — Unraid installation

1. Open Unraid WebGUI → Plugins → Install Plugin.
2. Paste this plugin URL and click Install:
   {url}
3. Wait for installation to finish, then open Main → ZFS Director.

Already installed RC1? Select Force Install when replacing this same version.
The message "not reinstalling same version" means the old code was left installed.

The installer downloads and checks the ready-made package, creates its own storage
and starts the background services. No terminal command or manual activation is needed.
No source build, developer tools or manual state-directory creation is required.
Sanoid / Syncoid integration starts OFF on a fresh configuration and is enabled separately.
Existing settings, Jobs and schedules are preserved. Pending recovery remains protected.

This ZIP also contains the matching PLG/TGZ for archiving. To select a local PLG,
copy the PLG to the USB flash drive's existing config/plugins folder, then choose
it in Plugins → Install Plugin. The public PLG downloads its matching TGZ itself.
Do not unpack the TGZ into the WebGUI directory.

For an existing legacy PLG registration, use its matching file from legacy-public
or legacy-local instead of adding a second registration. See INSTALLATION.md.
Before upgrading, back up, turn integration OFF and resolve pending Jobs.
'''
    guide_ru = f'''ZFS Director {VERSION} RC1 — установка в Unraid

1. Откройте Unraid WebGUI → Plugins → Install Plugin.
2. Вставьте URL плагина и нажмите Install:
   {url}
3. Дождитесь завершения и откройте Main → ZFS Director.

RC1 уже установлен? Отметьте Force Install при замене этой же версии.
Строка "not reinstalling same version" означает, что остался прежний код.

Установщик сам скачает и проверит готовый пакет, создаст своё хранилище
и запустит фоновые службы. Терминал и ручная активация не нужны.
Сборка из исходников, инструменты разработки и ручное создание каталогов не требуются.
Интеграция Sanoid / Syncoid в новой конфигурации выключена и включается отдельно.
Существующие настройки, Jobs и расписания сохраняются. Recovery остаётся защищённым.

В ZIP также лежат соответствующие PLG/TGZ для хранения. Для выбора локального PLG
скопируйте PLG в существующую папку config/plugins на USB flash, затем выберите
его в Plugins → Install Plugin. Публичный PLG сам скачает соответствующий TGZ.
Не распаковывайте TGZ в каталог WebGUI.

Для прежней регистрации используйте соответствующий файл из legacy-public
или legacy-local, не добавляя второй плагин. Подробности — в INSTALLATION.md.
Перед обновлением сделайте backup, выключите интеграцию и разберите pending Jobs.
'''
    members = {'INSTALL.txt': guide.encode(), 'INSTALL.ru.txt': guide_ru.encode(),
               'INSTALLATION.md': (ROOT / 'docs/INSTALLATION.md').read_bytes(),
               'zfs-director/' + archive.name: archive.read_bytes(),
               'zfs-director/' + plugin_name: (output / plugin_name).read_bytes()}
    if plugin_name == 'zfs-director.plg':
        for legacy_name, folder in [('zfs.master.ui.plg', 'legacy-public'), ('zfs.master.ui.local.plg', 'legacy-local')]:
            members[folder + '/' + legacy_name] = (output / legacy_name).read_bytes()
    members['SHA256SUMS'] = ''.join(hashlib.sha256(data).hexdigest() + '  ' + name + '\n'
                                   for name, data in sorted(members.items())).encode()
    bundle = output / f'ZFS-Director-{VERSION}-Unraid-RC1.zip'
    timestamp = datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).timetuple()[:6]
    with zipfile.ZipFile(bundle, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zipped:
        for name, data in sorted(members.items()):
            entry = zipfile.ZipInfo(name, timestamp)
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            zipped.writestr(entry, data, compresslevel=9)
    return bundle


def build(output, release_base=None):
    output.mkdir(parents=True, exist_ok=True)
    epoch = int(git('show', '-s', '--format=%ct', 'HEAD'))
    files = {}
    for path in git('ls-files', 'src').splitlines():
        p = ROOT / path
        if p.is_symlink():
            raise ValueError('Source symlinks are not permitted')
        mode = 0o755 if git('ls-files', '-s', path).startswith('100755 ') else 0o644
        files[path.removeprefix('src/')] = (p.read_bytes(), mode)
    release = {'display_name': 'ZFS Director', 'version': VERSION, 'source_commit': git('rev-parse', 'HEAD'),
               'source_tree': git('rev-parse', 'HEAD:src'), 'plugin_id': 'zfs.master.ui',
               'status': 'release-candidate' if release_base else 'local-candidate', 'maturity': 'RC1'}
    files['release.json'] = ((json.dumps(release, indent=2) + '\n').encode(), 0o644)
    manifest = ''.join(hashlib.sha256(data).hexdigest() + '  ' + name + '\n' for name, (data, _) in sorted(files.items()))
    files['SHA256SUMS'] = (manifest.encode(), 0o644)
    archive = output / f'zfs-director-{VERSION}.tgz'
    with archive.open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=epoch) as zipped, tarfile.open(fileobj=zipped, mode='w') as tar:
        for name, (data, mode) in sorted(files.items()):
            entry = tarfile.TarInfo('zfs.master.ui/' + name)
            entry.size, entry.mode, entry.mtime = len(data), mode, epoch
            entry.uid = entry.gid = 0
            entry.uname = entry.gname = 'root'
            tar.addfile(entry, io.BytesIO(data))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    plugin_name = 'zfs-director.plg' if release_base else 'zfs.master.ui.local.plg'
    plugin_url = release_base + '/' + plugin_name if release_base else 'file:///boot/config/plugins/zfs.master.ui/' + plugin_name
    plugin = ET.Element('PLUGIN', name='zfs.master.ui', author='d1-m4ss', version=VERSION, min='7.3.3',
                        icon='database', launch='Main/ZFSDirector', pluginURL=plugin_url)
    ET.SubElement(plugin, 'CHANGES').text = f'### {VERSION}\nZFS Director: RC1 based on ZFS Master by Carlos Rodriguez (IkerSaint). GPL-2.0-or-later. Settings and recovery state retain their namespace. Background services start automatically after successful validation. Uninstall stops Director services and preserves settings, Jobs and recovery data.'
    package = ET.SubElement(plugin, 'FILE', Name=f'/boot/config/plugins/zfs.master.ui/{archive.name}')
    ET.SubElement(package, 'URL' if release_base else 'LOCAL').text = release_base + '/' + archive.name if release_base else package.attrib['Name']
    ET.SubElement(package, 'MD5').text = hashlib.md5(archive.read_bytes()).hexdigest()
    def conflict_paths(filename):
        return ' '.join(folder + '/' + other for other in ('zfs-director.plg', 'zfs.master.ui.plg', 'zfs.master.ui.local.plg') if other != filename
                        for folder in ('/boot/config/plugins', '/boot/config/plugins/zfs.master.ui', '/var/log/plugins'))
    registrations = conflict_paths(plugin_name)
    directory_probe = shlex.quote(files['scripts/zfsm-directory.pl'][0].decode('utf-8'))
    upgrade_probe = shlex.quote(files['scripts/zfsm-upgrade-preflight.php'][0].decode('utf-8').removeprefix('<?php'))
    install = f'''set -euo pipefail
umask 077
archive=/boot/config/plugins/zfs.master.ui/{archive.name}
live=/usr/local/emhttp/plugins/zfs.master.ui
stage=/usr/local/emhttp/plugins/.zfs-director-stage-{VERSION}-$$
previous=/usr/local/emhttp/plugins/.zfs-director-previous-{VERSION}-$$
printf '%s  %s\\n' '{digest}' "$archive" | sha256sum -c -
# Do not create a second Plugin Manager registration for the same state.
for registration in {registrations}; do
  if [[ -e "$registration" || -L "$registration" ]]; then
    echo 'ZFS Director: conflicting plugin registration; keep the existing .plg/.local.plg namespace and use its matching package. No code or worker changes made.' >&2
    exit 1
  fi
done
[[ ! -L "$live" && ! -L /var/lock/zfs.master.ui.lock ]]
# Runtime stop marker guard.
stop_runtime() {{
  /usr/bin/perl -e {shlex.quote(STOP_MARKER)} -- /var/tmp 0 "$1"
}}
# End runtime stop marker guard.
# Boot reconstruction restores the UI even when recovery must stay stopped.
installed=/boot/config/plugins/zfs.master.ui/installed.sha256
[[ ! -L "$installed" && ( ! -e "$installed" || -f "$installed" ) ]]
restore_accepted=0
hold_recovery=0
if [[ ! -e "$live" && -f "$installed" && "$(cat "$installed")" == '{digest}' ]]; then restore_accepted=1; fi
preflight() {{
  local status=0 mode=upgrade
  if [[ "$restore_accepted" == 1 ]]; then mode=accepted-boot; fi
  /usr/bin/php -r {upgrade_probe} -- /boot/config/plugins/zfs.master.ui "$mode" || status=$?
  if [[ "$status" == 10 && "$restore_accepted" == 1 ]]; then hold_recovery=1; elif [[ "$status" != 0 ]]; then return "$status"; fi
}}
preflight
# Read-only prerequisite gate, before stopping the installed implementation.
# Execute the exact packaged helper; the generic probe creates no files.
if ! /usr/bin/perl -e {directory_probe} <<< '{{"op":"probe"}}'; then
  echo 'ZFS Director directory prerequisites unavailable; installed code and worker unchanged.' >&2
  exit 1
fi
stop_runtime 'package installation in progress'
if [[ -f "$live/scripts/zfsm-worker.php" ]]; then /usr/bin/php "$live/scripts/zfsm-worker.php" --stop; fi
exec 9>/var/lock/zfs.master.ui.lock
flock -n 9
# Recheck under the mutation lock: settings may have changed during preflight.
preflight
mkdir -m 0700 "$stage"
tar -xzf "$archive" -C "$stage"
(cd "$stage/zfs.master.ui"; sha256sum -c SHA256SUMS)
while IFS= read -r -d '' file; do /usr/bin/php -l "$file" >/dev/null; done < <(find "$stage/zfs.master.ui" -type f \\( -name '*.php' -o -name '*.page' \\) -print0)
/usr/bin/perl -c "$stage/zfs.master.ui/scripts/zfsm-files.pl"
find "$stage/zfs.master.ui" -type d -exec chmod 0755 {{}} +
trap 'if [[ ! -d "$live" && -d "$previous" ]]; then mv -T "$previous" "$live"; fi' EXIT
if [[ -d "$live" ]]; then mv -T "$live" "$previous"; fi
mv -T "$stage/zfs.master.ui" "$live"
rmdir "$stage"
trap - EXIT
# Automatic installation receipt distinguishes boot from an unrelated upgrade.
if [[ "$hold_recovery" == 0 ]]; then
  receipt=$(mktemp "$installed.XXXXXX")
  printf '%s\\n' '{digest}' > "$receipt"
  mv -T -- "$receipt" "$installed"
fi
flock -u 9
if [[ "$hold_recovery" == 1 ]]; then
  stop_runtime 'inspect pending recovery before launch'
else
  # Verify the private marker path before clearing the installer-owned pause.
  stop_runtime 'starting background services'
  rm -f -- /var/tmp/zfs.master.ui/jobs/stop
  if ! /usr/bin/php "$live/scripts/zfsm-worker.php" --launch || ! /usr/bin/php -r '
    $deadline=microtime(true)+15;
    do {{
      $ready=true;
      foreach(["/var/lock/zfs.master.ui.service.lock","/var/lock/zfs.master.ui.worker.lock"]as$p){{
        if(is_link($p)||!is_file($p)){{$ready=false;break;}}
        $f=@fopen($p,"r+");if(!$f){{$ready=false;break;}}
        if(flock($f,LOCK_EX|LOCK_NB)){{flock($f,LOCK_UN);$ready=false;}}
        fclose($f);if(!$ready)break;
      }}
      if($ready)exit(0);usleep(100000);
    }}while(microtime(true)<$deadline);
    fwrite(STDERR,"Director services did not become ready.\\n");exit(1);
  '; then
    stop_runtime 'background services failed to start; inspect Jobs and logs'
    /usr/bin/php "$live/scripts/zfsm-worker.php" --stop
    echo 'ZFS Director installed, but background services could not start.' >&2
    exit 1
  fi
fi
echo 'ZFS Director {VERSION} installed; configuration and journals retained.'
'''
    # Plugin Manager resolves FILE entries in order and may unlink an existing
    # TGZ on a checksum mismatch. Refuse unsafe state BEFORE that can happen.
    early = install.split("stop_runtime 'package installation in progress'", 1)[0]
    checksum_gate = next(line for line in early.splitlines(keepends=True) if line.startswith("printf '%s  %s") and '"$archive" | sha256sum -c -' in line)
    assert checksum_gate in early
    early = early.replace(checksum_gate, '', 1)
    gate_file = ET.Element('FILE', Run='/bin/bash')
    ET.SubElement(gate_file, 'INLINE').text = early
    plugin.insert(1, gate_file)
    ET.SubElement(ET.SubElement(plugin, 'FILE', Run='/bin/bash'), 'INLINE').text = install
    # Plugin Manager unregisters this PLG before running the handler and
    # rebuilds cron afterward. Keep its persistent cron source and user state;
    # without registration those Director schedules are no longer published.
    remove = f'''set -euo pipefail
umask 077
live=/usr/local/emhttp/plugins/zfs.master.ui
installed=/boot/config/plugins/zfs.master.ui/installed.sha256
if [[ -L "$live" || ( -e "$live" && ! -d "$live" ) || -L "$(dirname "$installed")" || -L "$installed" || ( -e "$installed" && ! -f "$installed" ) || -L /var/lock/zfs.master.ui.lock || ( -e /var/lock/zfs.master.ui.lock && ! -f /var/lock/zfs.master.ui.lock ) ]]; then
  echo 'ZFS Director: unsafe uninstall path; no code or services changed.' >&2
  exit 1
fi
for service_lock in /var/lock/zfs.master.ui.service.lock /var/lock/zfs.master.ui.worker.lock /var/tmp/zfs.master.ui/jobs/monitor.lock; do
  if [[ -L "$service_lock" || ( -e "$service_lock" && ! -f "$service_lock" ) ]]; then
    echo 'ZFS Director: untrusted service lock; no code or services changed.' >&2
    exit 1
  fi
done
/usr/bin/perl -e {shlex.quote(STOP_MARKER)} -- /var/tmp 0 'plugin removal in progress'
if [[ -f "$live/scripts/zfsm-worker.php" ]]; then
  if ! /usr/bin/php "$live/scripts/zfsm-worker.php" --stop; then
    echo 'ZFS Director: background work has not stopped. Wait for the active operation, inspect Jobs, then retry removal. Code and recovery data retained.' >&2
    exit 1
  fi
fi
exec 9>>/var/lock/zfs.master.ui.lock
if ! flock -n 9; then
  echo 'ZFS Director: an operation is active. Retry removal when it finishes; no lock was deleted.' >&2
  exit 1
fi
# Also cover an incomplete installation with no usable worker stop script.
for service_lock in /var/lock/zfs.master.ui.service.lock /var/lock/zfs.master.ui.worker.lock /var/tmp/zfs.master.ui/jobs/monitor.lock; do
  if [[ -L "$service_lock" || ( -e "$service_lock" && ! -f "$service_lock" ) ]]; then
    echo 'ZFS Director: untrusted service lock; code retained for inspection.' >&2
    exit 1
  fi
  if [[ -f "$service_lock" ]]; then
    exec 8>>"$service_lock"
    if ! flock -n 8; then
      echo 'ZFS Director: a background service is still running; retry removal after it stops. No process was killed.' >&2
      exit 1
    fi
    exec 8>&-
  fi
done
# Reinstallation is a new install, never an accepted-boot reconstruction.
# Do not remove settings, journals, archives, recovery or external schedules.
rm -f -- "$installed"
rm -f -- /boot/config/plugins/zfs.master.ui/zfs-director.plg /boot/config/plugins/zfs.master.ui/zfs.master.ui.plg /boot/config/plugins/zfs.master.ui/zfs.master.ui.local.plg
rm -rf -- "$live"
echo 'ZFS Director removed. Settings, Jobs and recovery data retained; external Sanoid/Syncoid configuration unchanged.'
'''
    ET.SubElement(ET.SubElement(plugin, 'FILE', Run='/bin/bash', Method='remove'), 'INLINE').text = remove
    ET.indent(plugin)
    ET.ElementTree(plugin).write(output / plugin_name, encoding='utf-8', xml_declaration=True)
    checksums = digest + '  ' + archive.name + '\n' + hashlib.sha256((output / plugin_name).read_bytes()).hexdigest() + '  ' + plugin_name + '\n'
    if release_base:
        # Keep existing registrations and their cron namespaces for upgrades.
        for legacy_name in ('zfs.master.ui.plg', 'zfs.master.ui.local.plg'):
            legacy = copy.deepcopy(plugin)
            legacy.set('pluginURL', release_base + '/' + legacy_name)
            for entry in legacy.findall("FILE[@Run='/bin/bash']/INLINE"):
                entry.text = entry.text.replace(registrations, conflict_paths(legacy_name))
            legacy_path = output / legacy_name
            ET.ElementTree(legacy).write(legacy_path, encoding='utf-8', xml_declaration=True)
            checksums += hashlib.sha256(legacy_path.read_bytes()).hexdigest() + '  ' + legacy_path.name + '\n'
    (output / 'SHA256SUMS').write_text(checksums)
    (output / 'install.sh').write_text(install)
    bundle = manual_bundle(output, archive, plugin_name, epoch, release_base)
    bundle_digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
    with (output / 'SHA256SUMS').open('a') as sums:
        sums.write(bundle_digest + '  ' + bundle.name + '\n')
    print(json.dumps(release | {'package_sha256': digest, 'files': len(files),
                               'manual_zip': bundle.name, 'manual_zip_sha256': bundle_digest}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--release-base-url', type=release_base_url,
                        help='explicit HTTPS release asset directory; omit for local-only output')
    args = parser.parse_args()
    build(args.output, args.release_base_url)
