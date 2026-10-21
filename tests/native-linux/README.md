# Native Linux test stand

This optional stand runs PHP, Perl, rsync and filesystem/process tests inside a disposable Linux container. It does not provide ZFS and does not establish Unraid compatibility.

```sh
docker build --platform linux/amd64 -t zfsm-native-tests:local -f tests/native-linux/Dockerfile tests/native-linux
npm run test:native
```

On ARM hosts, build the corresponding linux/arm64 image and set ZFSM_NATIVE_PLATFORM and ZFSM_NATIVE_IMAGE as needed. The runner copies source; it does not mount host storage or the Docker socket. Runtime networking is disabled. Tests use temporary filesystems, including deliberate ENOSPC and EROFS cases.

The stand needs container-only mount capabilities for nested synthetic filesystems. It must never be connected to production pools. Real ZFS, reboot, import/export and power-loss acceptance need a separately isolated VM and explicit operator review. Machine-specific SSH/VM launch scripts are deliberately excluded from this public repository.
