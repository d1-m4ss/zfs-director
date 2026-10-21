#!/bin/sh
# Only regular-file-backed pools in this dedicated VM fixture are created.
set -eu
base=/var/lib/zfs-director-native-20261018
mkdir -p "$base" "$base/cron-fixture"
chmod 700 "$base"
touch "$base/ISOLATED-TEST-ONLY"
for kind in it rt; do
    pool=director_${kind}_1018
    image="$base/$pool.img"
    if ! zpool list -H -o name "$pool" >/dev/null 2>&1; then
        if [ ! -e "$image" ]; then truncate -s 512M "$image"; fi
        test -f "$image" && test ! -L "$image"
        zpool create -o cachefile=none -O mountpoint="$base/$pool" "$pool" "$image"
    fi
done
for dataset in director_it_1018/policy director_it_1018/send director_it_1018/tree director_it_1018/tree/child; do
    if ! zfs list -H -o name "$dataset" >/dev/null 2>&1; then zfs create "$dataset"; fi
done
for dataset in send tree/child; do
    target="$base/director_it_1018/$dataset/payload.bin"
    if [ ! -e "$target" ]; then dd if=/dev/urandom of="$target" bs=1M count=4 status=none; fi
done
if [ ! -e "$base/director.cfg" ]; then
    cat > "$base/director.cfg" <<'EOF'
[general]
sanoid_integration="1"
destructive_mode="0"
EOF
fi
cat > "$base/native-plugin-fixture.plg" <<'EOF'
<!DOCTYPE PLUGIN [<!ENTITY name "unRAID6-Sanoid"><!ENTITY version "2.2.0">]><PLUGIN name="&name;"/>
EOF
chmod 600 "$base/director.cfg" "$base/native-plugin-fixture.plg"
php /home/poc/director-full/tests/native-linux/protection.php > "$base/run.jsonl" 2> "$base/run.err"
