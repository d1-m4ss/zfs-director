#!/bin/bash
# Destructive only to CODE in an explicitly marked, disposable Unraid VM.
# No installer rewriting, coordinator, worker stub or production ZFS operations.
set -euo pipefail
[[ $EUID == 0 && -f /etc/unraid-version && -f /boot/ZFSD-DISPOSABLE-INSTALLER-TEST ]]
[[ $(cat /boot/ZFSD-DISPOSABLE-INSTALLER-TEST) == 'synthetic public ZIP acceptance only' ]]
pools=$(zpool list -H -o name)
[[ -z $pools ]]
if [[ $# != 2 && $# != 3 ]]; then
  echo 'Usage: public-zip-unraid.sh ZIP VERIFIED_ZIP_SHA256 [forced]' >&2
  exit 2
fi
zip=$(realpath "$1")
expected=$2
[[ $expected =~ ^[a-f0-9]{64}$ ]]
[[ ${3:-} == '' || ${3:-} == forced ]]
printf '%s  %s\n' "$expected" "$zip" | sha256sum -c -
work=$(mktemp -d /tmp/zfsd-public-zip-XXXXXX)
# The archive is a verified release asset; extraction remains confined to /tmp.
unzip -t "$zip" > "$work/zip-integrity.log"
unzip -q "$zip" -d "$work/unpacked"
(cd "$work/unpacked"; sha256sum -c SHA256SUMS)
state=/boot/config/plugins/zfs.master.ui
live=/usr/local/emhttp/plugins/zfs.master.ui
mkdir -p "$state"
# Record all existing configuration/journals/cron, including other plugins.
# Only the incoming code artifacts and Plugin Manager registrations are excluded.
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
case ${ZFSM_INSTALL_NAMESPACE:-public} in
  public) definition="$work/unpacked/zfs-director/zfs-director.plg" ;;
  legacy-public) definition="$work/unpacked/legacy-public/zfs.master.ui.plg" ;;
  local) definition="$work/unpacked/legacy-local/zfs.master.ui.local.plg" ;;
  *) exit 2 ;;
esac
plugin=$(basename "$definition")
cp "$work/unpacked/zfs-director/"*.tgz "$definition" "$state/"
[[ $plugin == zfs-director.plg || $plugin == zfs.master.ui.plg || $plugin == zfs.master.ui.local.plg ]]
# This is the actual Unraid Plugin Manager, exactly as invoked by its GUI.
/usr/local/sbin/plugin install "$state/$plugin" ${3:+forced} 2>&1 | tee "$work/plugin-install.log"
[[ $(readlink -f "/var/log/plugins/$plugin") == "/boot/config/plugins/$plugin" ]]
cmp "$state/$plugin" "/boot/config/plugins/$plugin"
(cd "$live"; sha256sum -c SHA256SUMS) > "$work/runtime-hashes.log"
capture > "$work/state-after.json"
/usr/bin/php -r '
  $before=json_decode(file_get_contents($argv[1]),true,512,JSON_THROW_ON_ERROR);
  $after=json_decode(file_get_contents($argv[2]),true,512,JSON_THROW_ON_ERROR);
  foreach($before as $name=>$hash)if(($after[$name]??null)!==$hash){fwrite(STDERR,"Existing state changed: ".$name."\n");exit(1);}
  foreach(array_diff_key($after,$before) as $name=>$hash){
    // First automatic startup creates these empty advisory lock files.
      if(in_array($name,["zfs.master.ui/jobs/history.lock","zfs.master.ui/protection/config.lock","zfs.master.ui/protection/execution.lock"],true)&&$hash===hash("sha256","")){
      echo "Observed first-start lock creation: ".$name,"\n";continue;
    }
    // Unraid API can finish its own first-boot initialization while a fresh
    // install is running. Existing API bytes are still protected above.
    if($name!=="dynamix.my.servers/configs/api.json"){fwrite(STDERR,"Unexpected new state: ".$name."\n");exit(1);}
    echo "Observed Unraid API first-boot file creation: ".$name,"\n";
  }
' "$work/state-before.json" "$work/state-after.json"
# Healthy installation starts real services without an acceptance token.
[[ ! -e /var/tmp/zfs.master.ui/jobs/stop ]]
for attempt in {1..40}; do
  if pgrep -f '^/usr/bin/php .*/zfsm-worker.php --daemon$' >/dev/null && pgrep -f '^/usr/bin/php .*/zfsm-monitor.php$' >/dev/null; then break; fi
  sleep 0.5
done
pgrep -f '^/usr/bin/php .*/zfsm-worker.php --service$'
pgrep -f '^/usr/bin/php .*/zfsm-worker.php --daemon$'
pgrep -f '^/usr/bin/php .*/zfsm-monitor.php$'
/usr/bin/php -r '
  $p="/var/lock/zfs.master.ui.lock";
  if(file_exists($p)){$f=fopen($p,"r+");if(!$f||!flock($f,LOCK_EX|LOCK_NB))exit(1);flock($f,LOCK_UN);fclose($f);}
'
cat "$live/release.json"
printf 'PASS: public ZIP installed through Unraid Plugin Manager; state retained; worker/monitor started automatically; operation lock free. Evidence: %s\n' "$work"
