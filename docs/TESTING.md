# Testing

## Local checks

Use Node 22.22.2+ within 22.x or 24.15+ within 24.x, Python 3 and the build tools required by native dependencies.

```sh
npm ci
npx playwright install chromium
npm test
npm run test:gui
npm run test:integration
python3 -B tests/installer.test.py
npm run test:privacy
```

GUI tests use the actual frontend with synthetic responses. PHP/WASM tests run the handlers with simulated external commands. These checks do not establish native ZFS semantics.

Set `ZFSM_REFRESH_INTERVAL=0` or `30` to test with periodic refresh disabled or enabled. `ZFSM_OUTPUT` selects the result directory. `ZFSM_CHROME` optionally selects a compatible Chromium executable.

## Native tests

The [Linux stand](../tests/native-linux/README.md) uses disposable container filesystems. Run real ZFS scenarios only in an isolated VM with disposable pools.

`tests/native-linux/public-zip-unraid.sh` tests a release ZIP through the actual Unraid Plugin Manager. It requires root, no imported pools, and `/boot/ZFSD-DISPOSABLE-INSTALLER-TEST` containing exactly `synthetic public ZIP acceptance only`. Do not run it on a production server.

```sh
bash tests/native-linux/public-zip-unraid.sh /tmp/release.zip VERIFIED_ZIP_SHA256
# Deliberate same-version replacement:
bash tests/native-linux/public-zip-unraid.sh /tmp/release.zip VERIFIED_ZIP_SHA256 forced
# Preserve an existing local PLG registration:
ZFSM_INSTALL_NAMESPACE=local bash tests/native-linux/public-zip-unraid.sh /tmp/release.zip VERIFIED_ZIP_SHA256
```

The runner checks registration, installed hashes, persistent state, automatic background-service startup and a free operation lock. Finish Unraid onboarding before comparing state. Evidence is written to the temporary directory printed by the runner.

RC1 installation was evaluated in an isolated VM running Unraid 7.3.3 / OpenZFS 2.4.4: clean installation, upgrade from `.4`, early refusals, service startup and normal reboot. Pending recovery was also tested by reconstructing the interface while keeping execution paused. Power-loss recovery and a native reboot with pending recovery remain outside that evaluation.

## Backend comparison

The backend-selection study on 2026-10-17–18 compared **Sanoid/Syncoid 2.2.0** and **ZnapZend 0.23.6** using the same adapter interface and GUI. It ran in an isolated Ubuntu 24.04 VM with **real ZFS 2.2.2**, file-backed pools and loopback SSH. These are the original comparison results; the later RC1 checks on Unraid are listed separately below.

| Suite | Sanoid / Syncoid | ZnapZend |
| --- | --- | --- |
| Shared unit/mock checks | 23/23 passed | 23/23 passed |
| Real ZFS scenarios | 12/12 passed | 12/12 passed after adapter workarounds |
| Fault injection and data safety | 12/12 passed | 10/12 passed |
| Foreign objects, interrupted increments and retention | 4/5 passed | 3/4 passed |
| Normal VM reboot | 6/6 passed, including an actual scheduled cron run | 5/5 passed |
| VM hard reset during a transfer | 4/4 passed | 3/4 passed |

The shared Chromium GUI suite passed **16/16** across the two adapters. A result such as 4/5 means four checks passed out of five; the suites did not always contain the same number of checks.

### Findings that drove the choice

- **Interrupted transfers:** Syncoid resumed both initial and incremental sends through resume tokens, with matching data afterward. With receiver protection enabled, ZnapZend recovered an interrupted increment but needed manual recovery after an interrupted initial send, including after a VM hard reset. The pools themselves imported successfully after the resets.
- **Failure reporting:** six ZnapZend cases returned zero despite an incomplete or failed operation. The adapter needed log parsing and explicit configuration/tree checks. Its unreachable-host check also exceeded the test's timeout bound: 99 seconds, compared with 36 seconds for Syncoid.
- **Receiver protection:** both preserved foreign receiver objects with protection enabled. Both could still report zero while those objects blocked replication; this was the failed check in each pre-selection safety suite. Success therefore needs receiver-progress verification. Control tests with protection disabled confirmed that receiver rollback could discard foreign snapshots and changes.
- **Retention during an outage:** after six simulated hours without a reachable receiver, both retained the common source base and caught up with identical data. Incremental catch-up was confirmed for Syncoid; the study did not establish whether ZnapZend used an incremental or full resend. The expected risk from Syncoid's `--no-sync-snap` mode was not reproduced by the simulated-clock test.
- **Operation:** Sanoid/Syncoid needed cron orchestration but no dedicated daemon. ZnapZend provided remote receiver retention within its plan, while its daemon required supervision; a SIGHUP during startup terminated it in the tested setup.

### Measurements

Two measurement runs used the VM's emulated CPU and loopback SSH.

| Metric | Sanoid / Syncoid | ZnapZend |
| --- | --- | --- |
| Initial 20 MB transfer | About 43 seconds | About 61 seconds |
| Small incremental transfer | About 19 seconds | About 34 seconds |
| Resident backend process | None | About 32 MB RSS |
| Backend-specific adapter code | 245 lines | 265 lines |

The study led to **Sanoid/Syncoid** for resumable protected transfers, clearer failure reporting and operation without a dedicated daemon. Director supplies scheduling, history and receiver verification. ZnapZend is excluded from the active integration.

## RC1 verification (2026-10-22)

The checked package is **2026.10.22.1 RC1**. A separate, administrator-approved temporary dataset was used for smoke tests on a running Unraid host. Existing datasets, settings, schedules, journals and integration state were compared before and after the upgrade. The temporary dataset was removed after verification; the host was not rebooted.

| Check | Result and scope |
| --- | --- |
| Regression | 580 passed; no failures, skips or cancellations |
| Installer | 15 passed; automatic startup, unsafe-path refusals and recovery gates |
| Chromium workflows | 83 passed with refresh OFF and 83 with refresh ON |
| Startup / refresh safety | 13 passed with refresh OFF and 13 with refresh ON |
| Frontend → PHP/WASM | 29 passed per refresh profile; system commands are simulated |
| Action dialogs | 55 passed, including themes, layouts, mobile sizes and focus lifecycle |
| Existing SVG icons | 30 alignment cases passed |
| Native Linux | 21 filesystem/process suites and 5 ownership cases passed in disposable containers |
| Actual Unraid installation | Public URL clean install, compatibility upgrade, installed hashes and automatic worker/monitor startup passed |
| Actual ZFS file operations | Snapshot creation, File Manager listing, restore, ZIP preparation/integrity, conversion and directory/dataset/snapshot deletion passed on the temporary dataset |
| File integrity | All 2051 restored files matched; all 2050 conversion files matched in both copies; ZIP SHA-256, CRC and entry hashes matched |
| Safety errors | A late readonly change rejected restore and conversion; nonrecursive removal of a nonempty directory failed with its files retained |
| Jobs | Operations, progress and errors recorded; page sizes 10/25/50/100 reached every journal exactly once |
| Live GUI | Four explicit themes plus inheritance, Workspace/Compact and startup with refresh OFF/ON checked |
| Sanoid / Syncoid | Version 2.3.0 detection healthy; existing integration state and schedules preserved; no Managed retention or replication run |

Normal reboot was checked only in the isolated VM. These results do not establish full hardware, accessibility, security or power-loss certification, or compatibility with every Unraid/OpenZFS version.

## Documentation screenshots

The preview uses the real frontend with invented data from `docs/preview/data.mjs`; it does not read a storage server. Screenshot capture requires a QEMU/KVM Linux VM.

```sh
npm run demo
# In another terminal inside the VM:
npm run screenshots
```

The default preview URL is loopback-only. `ZFSM_DEMO_URL` and `ZFSM_SCREENSHOTS` can override the address and output directory. Capture covers the main pages, action reviews, themes and a narrow viewport. `docs/images/manifest.json` records source and image hashes, dimensions and capture platform.

## Release checks

```sh
python3 tools/check-release.py
python3 tools/check-release.py --history
```

These checks cover known credential patterns, personal home paths, image metadata, screenshot hashes, Git identities and commit trailers. A private list of additional identifiers can be supplied with `--deny-file /path/outside/repository/list.json`. Do not commit that list. Passing these checks does not replace a security review.
