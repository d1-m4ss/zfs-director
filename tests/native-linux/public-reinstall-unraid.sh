#!/bin/bash
# Real Plugin Manager lifecycle, confined to an explicitly disposable VM.
set -euo pipefail
[[ $EUID == 0 && $(cat /boot/ZFSD-DISPOSABLE-INSTALLER-TEST) == 'synthetic public ZIP acceptance only' ]]
pools=$(zpool list -H -o name); [[ -z $pools && $# == 2 ]]
here=$(cd -- "$(dirname "$0")" && pwd)
bash "$here/public-zip-unraid.sh" "$1" "$2" forced
state=/boot/config/plugins/zfs.master.ui
live=/usr/local/emhttp/plugins/zfs.master.ui
work=$(mktemp -d /tmp/zfsd-reinstall-XXXXXX)
operation= monitor=
trap 'for pid in "$operation" "$monitor"; do if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then kill -TERM "$pid"; wait "$pid" || true; fi; done' EXIT
install() { /usr/local/sbin/plugin install "$state/zfs-director.plg" forced > "$work/$1.log" 2>&1; }
ready() {
  [[ ! -e /var/tmp/zfs.master.ui/jobs/stop && ! -e /var/tmp/zfs.master.ui/jobs/install-pending.json ]]
  (cd "$live"; sha256sum -c SHA256SUMS) > "$work/hashes.log"
  [[ $(pgrep -fc '^/usr/bin/php .*/zfsm-worker.php --service$') == 1 ]]
  [[ $(pgrep -fc '^/usr/bin/php .*/zfsm-worker.php --daemon$') == 1 ]]
  [[ $(pgrep -fc '^/usr/bin/php .*/zfsm-monitor.php$') == 1 ]]
}
ready
# Only synthetic settings/cron/legacy code are created. No ZFS commands mutate.
printf '[general]\nsanoid_integration="1"\n' > "$state/zfs.master.ui.cfg"
for name in zfs.master zfs.master.ui.local; do [[ ! -e /var/log/plugins/$name.plg ]]; done
[[ ! -e /usr/local/emhttp/plugins/zfs.master && ! -e /boot/config/plugins/zfs.master ]]
mkdir -p /usr/local/emhttp/plugins/zfs.master/nchan /usr/local/emhttp/plugins/zfs.master/backend /boot/config/plugins/zfs.master /boot/config/plugins/zfs.master.ui.local
printf '<?php while(true)sleep(1);\n' > /usr/local/emhttp/plugins/zfs.master/nchan/zfs_master
printf '<?php while(true)sleep(1);\n' > /usr/local/emhttp/plugins/zfs.master/backend/operation.php
printf 'synthetic old Master settings\n' > /boot/config/plugins/zfs.master/zfs.master.cfg
printf 'synthetic obsolete code package\n' > "$state/zfs.master.ui-2025.01.01.tgz"
printf '<PLUGIN name="zfs.master" version="synthetic"/>\n' > /boot/config/plugins/zfs.master.plg
cp "$state/zfs-director.plg" /boot/config/plugins/zfs.master.ui.local.plg
ln -s /boot/config/plugins/zfs.master.plg /var/log/plugins/zfs.master.plg
ln -s /boot/config/plugins/zfs.master.ui.local.plg /var/log/plugins/zfs.master.ui.local.plg
cron=/boot/config/plugins/zfs.master.ui.local/protection.cron
printf "0 0 1 1 * /usr/bin/php '%s/scripts/zfsm-protection.php' 'policy' 'ffffffffffff' >/dev/null 2>&1\n" "$live" > "$cron"
cp "$cron" "$work/saved.cron"
/usr/local/sbin/update_cron
crontab -c /etc/cron.d -l > "$work/cron-before"
# Repeated test runs intentionally exercise identical sources in two old
# registrations. Only the duplicate Director launch should disappear.
awk '!/\/zfsm-protection.php/ || !seen[$0]++' "$work/cron-before" > "$work/cron-expected"
find "$state/jobs" -maxdepth 1 -type f -name '*.json' -exec sha256sum {} + | sort > "$work/jobs-before"
sha256sum "$state/zfs.master.ui.cfg" > "$work/settings-before"
/usr/bin/php /usr/local/emhttp/plugins/zfs.master/backend/operation.php >/dev/null 2>&1 &
operation=$!
if install active-legacy; then echo 'FAIL: active legacy operation accepted'; exit 1; fi
grep -q 'operation from ZFS Master is still running' "$work/active-legacy.log"
[[ -f /usr/local/emhttp/plugins/zfs.master/backend/operation.php && -L /var/log/plugins/zfs.master.plg ]]
kill -TERM "$operation";wait "$operation" || true
operation=
/usr/bin/php /usr/local/emhttp/plugins/zfs.master/nchan/zfs_master >/dev/null 2>&1 &
monitor=$!
install migration
ready
if kill -0 "$monitor" 2>/dev/null; then echo 'FAIL: legacy monitor survived cleanup';exit 1;fi
wait "$monitor" || true
monitor=
[[ ! -e /usr/local/emhttp/plugins/zfs.master && ! -e /boot/config/plugins/zfs.master ]]
[[ ! -e "$state/zfs.master.ui-2025.01.01.tgz" ]]
[[ ! -e /var/log/plugins/zfs.master.plg && ! -L /var/log/plugins/zfs.master.plg && ! -L /var/log/plugins/zfs.master.ui.local.plg ]]
[[ ! -e "$cron" ]]
cmp "$work/saved.cron" /boot/config/plugins/zfs-director/protection.cron
crontab -c /etc/cron.d -l > "$work/cron-after-migration"
cmp "$work/cron-expected" "$work/cron-after-migration"
sha256sum -c "$work/settings-before"
find "$state/jobs" -maxdepth 1 -type f -name '*.json' -exec sha256sum {} + | sort > "$work/jobs-after-migration"
cmp "$work/jobs-before" "$work/jobs-after-migration"
# Remove → reinstall with retained ON and saved managed cron.
/usr/local/sbin/plugin remove zfs-director.plg > "$work/remove.log" 2>&1
[[ ! -d "$live" && ! -e /var/log/plugins/zfs-director.plg ]]
[[ ! -e /usr/local/emhttp/plugins/dynamix.plugin.manager/post-hooks/zfs-director ]]
if crontab -c /etc/cron.d -l | grep -q '/zfsm-protection.php'; then echo 'FAIL: removed plugin still scheduled';exit 1;fi
# Uninstall removes cached PLGs, so use the verified public ZIP again.
bash "$here/public-zip-unraid.sh" "$1" "$2" > "$work/reinstall.log" 2>&1
ready
sha256sum -c "$work/settings-before"
crontab -c /etc/cron.d -l > "$work/cron-after-reinstall"
cmp "$work/cron-expected" "$work/cron-after-reinstall"
find "$state/jobs" -maxdepth 1 -type f -name '*.json' -exec sha256sum {} + | sort > "$work/jobs-after-reinstall"
cmp "$work/jobs-before" "$work/jobs-after-reinstall"
# Pending work must fail visibly before code replacement and never auto-resume.
/usr/bin/php "$live/scripts/zfsm-worker.php" --stop
job="$state/jobs/20261022-230000-ffffffffffff.json"
[[ ! -e "$job" ]]
printf '{"state":"queued","type":"conversion"}\n' > "$job"
if install pending; then echo 'FAIL: pending work accepted';exit 1;fi
grep -q 'Pending or unverified jobs' "$work/pending.log"
[[ -f /var/tmp/zfs.master.ui/jobs/stop ]]
rm -- "$job"
install resume-after-test
ready
printf 'PASS: native legacy migration, active-operation refusal, monitor stop, retained-ON reinstall, cron/Jobs/settings preservation and visible pending-work refusal. Evidence: %s\n' "$work"
