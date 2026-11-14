#!/bin/sh
# Host side of the real ZFS stand (TEST-011). Boots a DISPOSABLE VM from an Ubuntu cloud image with
# QEMU, runs tests/real-zfs/setup.sh inside it, copies the report and the fixtures back and deletes
# the VM disk. Needs: qemu-system-aarch64 (or x86_64 with ZFSM_VM_ARCH=x86_64), ssh, python3, and the
# image: ZFSM_VM_IMAGE=/path/to/<release>-server-cloudimg-arm64.img (Ubuntu 26.04 "resolute" ships
# OpenZFS 2.4.x; 24.04 ships 2.2.2). The VM only ever talks to this host through one forwarded
# loopback port, and its own SSH replication test runs on the VM's loopback.
set -eu
here=$(cd "$(dirname "$0")" && pwd); root=$(cd "$here/../.." && pwd)
name=${ZFSM_VM_NAME:-zfsm-test-$(date +%Y%m%d)}
image=${ZFSM_VM_IMAGE:?set ZFSM_VM_IMAGE to the Ubuntu cloud image (qcow2)}
work=${ZFSM_VM_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/$name.XXXXXX")}
arch=${ZFSM_VM_ARCH:-aarch64}; port=${ZFSM_VM_SSH_PORT:-22022}; seed=${ZFSM_VM_SEED_PORT:-22080}
out=${ZFSM_REAL_ZFS_RESULT:-$root/evidence/real-zfs}
mkdir -p "$work" "$out"; mkdir -p "$work/seed"
test -f "$image" || { echo "image not found: $image" >&2; exit 2; }
case $(uname -s) in Darwin) accel=hvf;; *) accel=kvm;; esac
case $arch in
  aarch64) qemu=qemu-system-aarch64; machine="-machine virt -cpu host";;
  x86_64) qemu=qemu-system-x86_64; machine="-machine q35 -cpu host";;
  *) echo "unsupported ZFSM_VM_ARCH" >&2; exit 2;;
esac
fw=
if [ "$arch" = aarch64 ]; then
  code=${ZFSM_VM_UEFI:-$(dirname "$(command -v $qemu)")/../share/qemu/edk2-aarch64-code.fd}
  test -f "$code" || { echo "UEFI firmware not found: $code (set ZFSM_VM_UEFI)" >&2; exit 2; }
  dd if=/dev/zero of="$work/vars.fd" bs=1m count=64 2>/dev/null || dd if=/dev/zero of="$work/vars.fd" bs=1M count=64 2>/dev/null
  fw="-drive if=pflash,format=raw,readonly=on,file=$code -drive if=pflash,format=raw,file=$work/vars.fd"
fi
ssh-keygen -q -t ed25519 -N '' -f "$work/key" -C "$name"
pub=$(cat "$work/key.pub")
cat > "$work/seed/meta-data" <<META
instance-id: $name
local-hostname: $name
META
cat > "$work/seed/user-data" <<USER
#cloud-config
users:
  - name: zfsm
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys: ["$pub"]
package_update: true
packages: [zfsutils-linux, sanoid, php-cli, rsync, perl, openssh-server, mbuffer, lzop, pv, acl, attr, python3]
write_files:
  - path: /etc/zfsm-disposable-vm
    content: "$name: disposable test VM, may be destroyed at any time\n"
USER
: > "$work/seed/vendor-data"
qemu-img create -q -f qcow2 -b "$image" -F qcow2 "$work/disk.qcow2" 40G
( cd "$work/seed" && python3 -m http.server "$seed" --bind 127.0.0.1 >/dev/null 2>&1 & echo $! > "$work/seed.pid" )
cleanup() {
  [ -f "$work/qemu.pid" ] && kill "$(cat "$work/qemu.pid")" 2>/dev/null || true
  [ -f "$work/seed.pid" ] && kill "$(cat "$work/seed.pid")" 2>/dev/null || true
  [ -z "${ZFSM_VM_KEEP:-}" ] && rm -rf "$work"
}
trap cleanup EXIT INT TERM
# shellcheck disable=SC2086
$qemu $machine -accel $accel -smp 4 -m 4096 $fw \
  -drive file="$work/disk.qcow2",if=virtio,format=qcow2 \
  -netdev user,id=n0,hostfwd=tcp:127.0.0.1:$port-:22 -device virtio-net-pci,netdev=n0 \
  -smbios "type=1,serial=ds=nocloud;s=http://10.0.2.2:$seed/" \
  -display none -serial "file:$work/console.log" -daemonize -pidfile "$work/qemu.pid"
ssh_opts="-i $work/key -p $port -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5"
echo "$name: waiting for the VM (first boot installs packages, several minutes)"
i=0; until ssh $ssh_opts zfsm@127.0.0.1 true 2>/dev/null; do i=$((i+1)); [ $i -le 180 ] || { echo "VM did not come up; console: $work/console.log" >&2; ZFSM_VM_KEEP=1; exit 1; }; sleep 5; done
ssh $ssh_opts zfsm@127.0.0.1 'sudo cloud-init status --wait' >/dev/null 2>&1 || true
tar -C "$root" -cf - src tests | ssh $ssh_opts zfsm@127.0.0.1 'rm -rf ~/stand && mkdir ~/stand && tar -C ~/stand -xf -'
status=0
ssh $ssh_opts zfsm@127.0.0.1 'sudo sh ~/stand/tests/real-zfs/setup.sh' || status=$?
ssh $ssh_opts zfsm@127.0.0.1 'sudo tar -C /var/lib/zfs-director-real-out -cf - .' | tar -C "$out" -xf - || true
echo "results: $out (exit $status)"
exit $status
