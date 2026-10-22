#!/bin/bash
# Code-only lifecycle test in a marked disposable Unraid VM, never production.
set -euo pipefail
[[ $EUID == 0 && -f /etc/unraid-version ]]
[[ $(cat /boot/ZFSD-DISPOSABLE-INSTALLER-TEST) == 'synthetic public ZIP acceptance only' ]]
pools=$(zpool list -H -o name)
[[ -z $pools && $# == 2 ]]
here=$(cd -- "$(dirname -- "$0")" && pwd)
bash "$here/public-zip-unraid.sh" "$1" "$2" forced
state=/boot/config/plugins/zfs.master.ui
live=/usr/local/emhttp/plugins/zfs.master.ui
case ${ZFSM_INSTALL_NAMESPACE:-public} in
  public) plugin=zfs-director.plg ;;
  legacy-public) plugin=zfs.master.ui.plg ;;
  local) plugin=zfs.master.ui.local.plg ;;
  *) exit 2 ;;
esac
work=$(mktemp -d /tmp/zfsd-public-uninstall-XXXXXX)
fixture=director-uninstall-fixture
[[ ! -e /boot/config/plugins/$fixture.plg && ! -L /var/log/plugins/$fixture.plg ]]
mkdir -p "/boot/config/plugins/$fixture" "$state/uninstall-fixture/recovery"
printf '<PLUGIN name="director-uninstall-fixture" version="1" />\n' > "/boot/config/plugins/$fixture.plg"
ln -s "/boot/config/plugins/$fixture.plg" "/var/log/plugins/$fixture.plg"
printf '0 0 1 1 * : external-uninstall-fixture\n' > "/boot/config/plugins/$fixture/external.cron"
cron=/boot/config/plugins/${plugin%.plg}/protection.cron
mkdir -p "$(dirname "$cron")"
[[ ! -e $cron && ! -L $cron ]]
printf "# Synthetic Director cron; never due during this test.\n0 0 1 1 * /usr/bin/php '%s/scripts/zfsm-protection.php' 'policy' 'ffffffffffff' >/dev/null 2>&1\n" "$live" > "$cron"
/usr/local/sbin/update_cron
/usr/bin/php -r '
  require $argv[1]."/backend/ZFSMOperations.php";
  foreach(["completed","recovery_required"] as $state){
    zfsmRequestJobBegin("snapshotdataset",["zdataset"=>"demo/photos"]);
    zfsmRequestJobFinish($state,"Synthetic uninstall retention check; no ZFS operation executed.");
  }
' "$live"
printf 'synthetic retained original\n' > "$state/uninstall-fixture/recovery/original.txt"
printf '{"synthetic":"retained recovery manifest"}\n' > "$state/uninstall-fixture/recovery/manifest.json"
capture() {
  /usr/bin/php -r '
    $root="/boot/config/plugins";$out=[];
    $scan=new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root,FilesystemIterator::SKIP_DOTS));
    foreach($scan as $p){
      if(!$p->isFile()||$p->isLink()||$p->getPathname()==="/boot/config/plugins/zfs.master.ui/installed.sha256"||preg_match("/\\.(plg|tgz)$/D",$p->getFilename()))continue;
      $out[substr($p->getPathname(),strlen($root)+1)]=hash_file("sha256",$p->getPathname());
    }
    ksort($out);echo json_encode($out,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES),"\n";
  '
}
capture > "$work/state-before.json"
crontab -c /etc/cron.d -l > "$work/cron-before.txt"
lock_inode=$(stat -c '%d:%i' /var/lock/zfs.master.ui.lock)
# A real held flock must stop uninstall, without replacing its inode.
flock -x /var/lock/zfs.master.ui.lock sh -c 'touch "$1"; while [ ! -e "$2" ]; do sleep 0.1; done' sh "$work/lock-ready" "$work/lock-release" &
holder=$!
trap 'touch "$work/lock-release"; wait "$holder"' EXIT
for attempt in {1..100}; do [[ -e $work/lock-ready ]] && break; sleep 0.1; done
[[ -e $work/lock-ready ]]
if /usr/local/sbin/plugin remove "$plugin" > "$work/remove-busy.log" 2>&1; then
  echo 'FAIL: removal accepted a held operation lock' >&2
  exit 1
fi
[[ -L /var/log/plugins/$plugin && -f $live/ZFSDirector.page && -f $state/installed.sha256 ]]
[[ $(stat -c '%d:%i' /var/lock/zfs.master.ui.lock) == "$lock_inode" ]]
touch "$work/lock-release"
wait "$holder"
trap - EXIT
/usr/local/sbin/plugin remove "$plugin" 2>&1 | tee "$work/remove.log"
[[ ! -e /var/log/plugins/$plugin && ! -L /var/log/plugins/$plugin ]]
[[ ! -e /boot/config/plugins/$plugin && ! -e $live && ! -e $state/installed.sha256 ]]
[[ -f /var/tmp/zfs.master.ui/jobs/stop ]]
[[ $(stat -c '%d:%i' /var/lock/zfs.master.ui.lock) == "$lock_inode" ]]
if pgrep -f '^/usr/bin/php .*/zfsm-(worker|monitor)\.php( |$)' >/dev/null; then
  echo 'FAIL: Director services survived removal' >&2
  exit 1
fi
capture > "$work/state-after.json"
cmp "$work/state-before.json" "$work/state-after.json"
crontab -c /etc/cron.d -l > "$work/cron-after.txt"
/usr/bin/php -r '
  $lines=static fn($p)=>array_values(array_filter(explode("\n",file_get_contents($p)),static fn($s)=>trim($s)!==""&&!str_starts_with(trim($s),"#")));
  $before=array_values(array_filter($lines($argv[1]),static fn($s)=>!str_contains($s,"/zfsm-protection.php")));
  if($before!==$lines($argv[2])){fwrite(STDERR,"Unrelated cron changed or Director launch survived removal\n");exit(1);}
' "$work/cron-before.txt" "$work/cron-after.txt"
sleep 3
[[ ! -e /var/log/plugins/$plugin && ! -e $live ]]
echo "PASS: native uninstall; busy refusal; services stopped; code and registration removed; state/recovery/external cron retained. Evidence: $work"
# Remove only this script's synthetic scheduler fixture, leaving journals and
# recovery sentinels available for the following reinstall/hash comparison.
rm -- "$cron"
/usr/local/sbin/plugin remove "$fixture.plg" > "$work/remove-fixture.log"
