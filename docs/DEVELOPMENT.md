# Developer guide

Installers and users should use the ready-to-install ZIP described in [Installation](INSTALLATION.md). The commands below are for contributors building or testing source.

## Build release artifacts

The package builder supports **local evaluation and an explicitly configured public release directory**. Building performs no installation, upload or server connection.

```sh
python3 tools/build-installer.py --output dist/local
RELEASE_BASE_URL='https://github.com/d1-m4ss/zfs-director/releases/download/2026.10.22.1'
python3 tools/build-installer.py --output dist/release --release-base-url "$RELEASE_BASE_URL" \
  --plugin-url-base https://raw.githubusercontent.com/d1-m4ss/zfs-director/main/plugin
```

Build from a committed checkout. Local output includes a TGZ, `zfs.master.ui.local.plg`, `SHA256SUMS` and the exact installer script. Public mode emits `zfs-director.plg` and compatible `zfs.master.ui.plg` / `zfs.master.ui.local.plg`, all using one matching TGZ with pinned HTTPS URLs and package checksums. Public builds target `d1-m4ss/zfs-director`; upload every matching asset to the release directory used by the build. Packages stay pinned to that version-specific directory, while `pluginURL` points to `--plugin-url-base`, which Plugin Manager polls for updates. After publishing the release assets, commit the three built PLG files to `plugin/` on `main`; Community Applications installs `plugin/zfs-director.plg` from there.

Use the release tag to reproduce the published source. The release tag and packaged `source_commit` identify the final squashed release commit. The privacy check scans every reachable commit and blob.

Use a disposable test environment first. Read [installation, upgrades and code-only rollback](INSTALLATION.md) before touching a real host. Healthy installation starts Director services automatically and leaves fresh integration OFF; existing settings and schedules are preserved, with integration required OFF before upgrade. Local and public PLG registrations must not coexist. Boot/upgrade/rollback acceptance remains a separate host evaluation.


## Run tests and the synthetic preview

Use Node **22.22.2+ within 22.x** or **24.15+ within 24.x**, Python 3 and the build tools required by native Node dependencies. Node 26 is not supported by this test setup.

```sh
npm ci
npx playwright install chromium
npm test
npm run test:gui
npm run test:integration
npm run test:privacy
```

On Linux, Playwright system libraries may also be required. Browser tests default to Playwright's installed Chromium; `ZFSM_CHROME` can point to an explicitly selected compatible executable. No developer home path is embedded in the commands or source.

Preview the generated demonstration without a storage server:

```sh
npm run demo
# Open http://127.0.0.1:9000
```

The preview uses the real frontend with a read-only synthetic response adapter. It does not invoke ZFS, SSH or the production PHP backend. Screenshot regeneration is VM-only; see [testing and screenshot provenance](TESTING.md).


## Manual-install ZIP

Every build also produces `ZFS-Director-2026.10.22.1-Unraid.zip`. It contains the matching PLG/TGZ pair, two short installation guides, the full installation guide and an internal SHA-256 manifest. No source tree, settings, Jobs or datasets are included. Release mode places `zfs-director.plg` in `zfs-director` and includes the compatibility definitions under `legacy-public` and `legacy-local` for existing local registrations; all use the common TGZ. Local mode contains only `zfs.master.ui.local.plg`. Never mix assets from different builds.

ZIP member names, timestamps and modes are deterministic. Publish the ZIP and external `SHA256SUMS` together with the matching public PLG, compatibility PLG and TGZ release assets. The ZIP is the primary download for manual installation; GitHub's source-code archives are for development.
