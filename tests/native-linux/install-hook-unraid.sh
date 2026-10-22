#!/bin/bash
# Failure injection only inside the explicitly disposable, pool-free VM.
set -euo pipefail
[[ $EUID == 0 && $(cat /boot/ZFSD-DISPOSABLE-INSTALLER-TEST) == 'synthetic public ZIP acceptance only' ]]
pools=$(zpool list -H -o name); [[ -z $pools ]]
state=/boot/config/plugins/zfs.master.ui
live=/usr/local/emhttp/plugins/zfs.master.ui
runtime=/var/tmp/zfs.master.ui/jobs
work=$(mktemp -d /tmp/zfsd-hook-test-XXXXXX)
collector=/usr/local/sbin/update_cron
cp -p "$collector" "$work/update_cron.original"
crontab -c /etc/cron.d -l > "$work/original.cron"
cleanup() { cp -p "$work/update_cron.original" "$collector"; crontab -c /etc/cron.d "$work/original.cron"; }
trap cleanup EXIT
/usr/bin/php "$live/scripts/zfsm-worker.php" --stop
arm() {
  printf 'post-hook test maintenance\n' > "$runtime/stop"
  /usr/bin/php -r '$p=["registration"=>"zfs-director.plg","sha256"=>trim(file_get_contents($argv[1]."/installed.sha256")),"hold_recovery"=>false];file_put_contents($argv[2]."/install-pending.json",json_encode($p));' -- "$state" "$runtime"
}
hook() { /usr/bin/php "$live/scripts/zfsm-install-complete.php" plugin install zfs-director.plg > "$work/$1.log" 2>&1; }
paused() { [[ -f "$runtime/stop" && -f "$runtime/install-pending.json" ]]; ! pgrep -f '^/usr/bin/php .*/zfsm-worker.php --daemon$' >/dev/null; }
arm
exec 9>>"$state/protection/config.lock"; flock -n 9
if hook lock-busy; then echo 'FAIL: busy config lock accepted';exit 1;fi
grep -q 'Director is busy' "$work/lock-busy.log"; paused
flock -u 9;exec 9>&-
# An external entry not backed by any saved source must survive refusal.
cp "$work/original.cron" "$work/unrecognized.cron"
printf '0 0 1 1 * /bin/true # synthetic unsaved external schedule\n' >> "$work/unrecognized.cron"
crontab -c /etc/cron.d "$work/unrecognized.cron"
if hook external; then echo 'FAIL: unknown external entry accepted';exit 1;fi
grep -q 'external cron differs' "$work/external.log";paused
crontab -c /etc/cron.d -l > "$work/after-external";cmp "$work/unrecognized.cron" "$work/after-external"
crontab -c /etc/cron.d "$work/original.cron"
# A collector can fail after writing, or claim success with wrong contents.
for result in 9 0; do
  printf '#!/bin/bash\nprintf "0 0 1 1 * /bin/true # injected collector failure\\n" | /usr/bin/crontab -c /etc/cron.d -\nexit %s\n' "$result" > "$collector"
  if hook "collector-$result"; then echo 'FAIL: incorrect collector accepted';exit 1;fi
  paused
  crontab -c /etc/cron.d -l > "$work/after-$result";cmp "$work/original.cron" "$work/after-$result"
done
cleanup
hook healthy
[[ ! -e "$runtime/stop" && ! -e "$runtime/install-pending.json" ]]
[[ $(pgrep -fc '^/usr/bin/php .*/zfsm-worker.php --service$') == 1 && $(pgrep -fc '^/usr/bin/php .*/zfsm-worker.php --daemon$') == 1 && $(pgrep -fc '^/usr/bin/php .*/zfsm-monitor.php$') == 1 ]]
crontab -c /etc/cron.d -l > "$work/final.cron";cmp "$work/original.cron" "$work/final.cron"
trap - EXIT
printf 'PASS: busy-lock refusal, unknown external cron preservation, collector failure/readback rollback and healthy activation. Evidence: %s\n' "$work"
