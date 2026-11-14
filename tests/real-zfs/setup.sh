#!/bin/sh
# TEST-011: one command on a DISPOSABLE Linux VM with real ZFS. It creates its own file-backed
# pools, runs the plugin's PHP against them (pool diagnostics capture, Sanoid and Syncoid on the
# loopback, SSH replication to 127.0.0.1, restoring a file from a snapshot, deleting a dataset)
# and writes a report with the ZFS, Sanoid and kernel versions to $ZFSM_REAL_ZFS_OUT.
#   sudo sh tests/real-zfs/setup.sh          (from a checkout copied to the VM)
# Refuses to run unless /etc/zfsm-disposable-vm exists: it destroys pools named zfsmreal and
# director_*_1018 and writes under /var/lib. Never run it on a machine that matters.
set -eu
marker=/etc/zfsm-disposable-vm
if [ ! -f "$marker" ]; then echo "refusing to run: $marker is missing. This stand destroys pools and must only run on a disposable VM." >&2; exit 2; fi
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
for tool in zfs zpool php perl rsync ssh sshd sanoid syncoid; do
  command -v "$tool" >/dev/null 2>&1 || [ -x "/usr/sbin/$tool" ] || { echo "missing tool: $tool (apt-get install zfsutils-linux sanoid php-cli rsync perl openssh-server)" >&2; exit 2; }
done
root=$(cd "$(dirname "$0")/../.." && pwd)
out=${ZFSM_REAL_ZFS_OUT:-/var/lib/zfs-director-real-out}
rm -rf "$out"; mkdir -p "$out"; chmod 700 "$out"
modprobe zfs 2>/dev/null || true
zfs version >/dev/null || { echo "ZFS is not usable in this VM" >&2; exit 2; }
# Loopback SSH inside the VM: its own key, trusted host key of 127.0.0.1 only.
mkdir -p /root/.ssh; chmod 700 /root/.ssh
[ -f /root/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -f /root/.ssh/id_ed25519
grep -qF "$(cut -d' ' -f1,2 /root/.ssh/id_ed25519.pub)" /root/.ssh/authorized_keys 2>/dev/null || cat /root/.ssh/id_ed25519.pub >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
(systemctl start ssh 2>/dev/null || systemctl start sshd 2>/dev/null || service ssh start) >/dev/null 2>&1 || true
: > /root/.ssh/known_hosts; ssh-keyscan -T 5 127.0.0.1 >> /root/.ssh/known_hosts 2>/dev/null
ssh -o BatchMode=yes -o ConnectTimeout=5 root@127.0.0.1 true || { echo "loopback SSH is not usable" >&2; exit 2; }
status=0
run() { name=$1; shift; echo "== $name"; "$@" > "$out/$name.log" 2>&1 || { echo "FAILED: $name (see $out/$name.log)"; status=1; }; }
run capture sh -c "php '$root/tests/native-linux/real-zfs-capture.php' > '$out/capture.json'"
run protection-setup sh "$root/tests/native-linux/protection-setup.sh"
run protection php "$root/tests/native-linux/protection.php"
run protection-ssh php "$root/tests/native-linux/protection-ssh.php"
run restore-and-delete php "$root/tests/real-zfs/scenarios.php" "$out/scenarios.json"
base=/var/lib/zfs-director-native-20261018
for f in results.json ssh-results.json; do [ -f "$base/$f" ] && cp "$base/$f" "$out/protection-$f"; done
php "$root/tests/real-zfs/report.php" "$out" > "$out/report.json" || status=1
cat "$out/report.json"
exit $status
