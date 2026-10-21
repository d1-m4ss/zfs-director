#!/bin/bash
set -euo pipefail
test "$(id -u)" = 0
test -f "$ZFSM_CRON_EXEC_ROOT/../ISOLATED-TEST-ONLY"
mount --make-rprivate /
mount -t tmpfs -o mode=0755 tmpfs /boot
mount -t tmpfs -o mode=0755 tmpfs /var/log
mount -t tmpfs -o mode=0755 tmpfs /usr/local/sbin
mkdir -p /boot/config/plugins/dynamix /boot/config/plugins/zfs.master.ui.local /var/log/plugins "$ZFSM_CRON_EXEC_ROOT/bin" "$ZFSM_CRON_EXEC_ROOT/state" "$ZFSM_CRON_EXEC_ROOT/scan"
printf '<PLUGIN/>\n' > /var/log/plugins/zfs.master.ui.local.plg
printf '0 1 * * * /usr/bin/true\n' > /boot/config/plugins/dynamix/foreign.cron
cp /boot/config/plugins/dynamix/foreign.cron "$ZFSM_CRON_EXEC_ROOT/live.cron"
cp "$ZFSM_CRON_EXEC_ROOT/update_cron" /usr/local/sbin/update_cron
chmod 0700 /usr/local/sbin/update_cron
cat > "$ZFSM_CRON_EXEC_ROOT/bin/crontab" <<'EOF'
#!/bin/bash
set -euo pipefail
case "${!#}" in
 -l) cat "$ZFSM_CRON_EXEC_ROOT/live.cron";;
 -d) rm -f "$ZFSM_CRON_EXEC_ROOT/live.cron";;
 -) cat > "$ZFSM_CRON_EXEC_ROOT/live.cron";;
 *) exit 2;;
esac
EOF
chmod 0700 "$ZFSM_CRON_EXEC_ROOT/bin/crontab"
export PATH="$ZFSM_CRON_EXEC_ROOT/bin:$PATH"
export ZFSM_CRON_EXEC_PRIVATE=1
php "$ZFSM_CRON_EXEC_ROOT/cron-exec-case.php" original > "$ZFSM_CRON_EXEC_ROOT/original.json"
php "$ZFSM_CRON_EXEC_ROOT/cron-exec-case.php" candidate > "$ZFSM_CRON_EXEC_ROOT/candidate.json"
