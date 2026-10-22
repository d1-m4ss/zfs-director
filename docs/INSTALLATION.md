# Install ZFS Director in Unraid

RC1 2026.10.22.1 targets Unraid 7.3.3 / OpenZFS 2.4.4. No source build, developer tools, terminal activation or manual state-directory creation is required.

## Install

1. Open **Plugins → Install Plugin** in the Unraid WebGUI.
2. Paste this URL into the plugin URL field:

   ```text
   https://github.com/d1-m4ss/zfs-director/releases/download/2026.10.22.1/zfs-director.plg
   ```

3. Click **Install** and wait for completion.
4. Open **Main → ZFS Director**.

Unraid downloads the plugin and its matching package. The installer verifies the package, creates its own storage and starts Director's worker/monitor automatically. These services handle operations you request through the plugin. Fresh configuration leaves **Sanoid / Syncoid integration OFF**; installation does not create snapshot policies, adopt scripts or enable replication.

Existing settings, Jobs, recovery files and schedules are retained. If the installer finds unsafe paths or unresolved work, it reports the reason. Do not delete locks or recovery files to bypass the check.

## ZIP download

The release also provides a [ready-made ZIP](https://github.com/d1-m4ss/zfs-director/releases/download/2026.10.22.1/ZFS-Director-2026.10.22.1-Unraid-RC1.zip) and [SHA256SUMS](https://github.com/d1-m4ss/zfs-director/releases/download/2026.10.22.1/SHA256SUMS), containing matching PLG/TGZ files and short English/Russian guides. The plugin URL above is the normal installation method.

For local PLG selection, extract the ZIP and copy `zfs-director/zfs-director.plg` to the flash drive's existing `config/plugins` folder. Select that file in **Plugins → Install Plugin**. The public PLG downloads its matching TGZ itself. You do not need to create a separate plugin directory or unpack the TGZ into WebGUI.

## Upgrade an existing installation

- Make a verified private backup of the current plugin, settings, Jobs and recovery state.
- Finish active Jobs and inspect pending recovery. The installer pauses Director during replacement and preserves the integration setting, including ON after a previous uninstall.
- Use the same `zfs-director.plg` URL above. Existing ZFS Master code and duplicate Director registrations are backed up and removed from their active locations automatically. No manual directory cleanup is needed.
- Director settings, Jobs, recovery and saved schedules are retained. Managed cron is moved to the installed registration's namespace with its exact content preserved; registration completes before services start. External Sanoid/Syncoid scripts and schedules are not changed.
- To replace an already installed RC1 with the corrected package, select **Force Install** in Plugin Manager. A log ending with `not reinstalling same version` means the update was skipped: the old installer and removal handler are still installed. Force Install allows this same-version replacement; the plugin's safety checks still run.

A successful healthy upgrade restarts the services automatically. Existing schedules stay with their owners; integration and individual definitions remain under explicit GUI control.

Active ZFS Master operations, conflicting schedules, unrecognized hooks or unsafe filesystem paths stop installation with a visible reason. The installer does not terminate an active operation to force replacement. Old code and registration backups are recorded under `/boot/config/plugins-removed/zfs-director-*`; displaced runtime code is retained beside the live plugin.

## After reboot

Unraid reconstructs the plugin from its retained package and starts the services. If pending recovery needs inspection, the interface is restored with background execution paused. Inspect the affected Jobs through the GUI. Completed operations are not automatically resumed.

## Code-only rollback

Retain the previous matching PLG/TGZ and a verified private backup before upgrading. To roll back, finish active work, stop only Director, and restore the previous code through its matching plugin definition. Keep current settings, Jobs, audit and recovery state; do not overwrite them with an old state backup.

The installer retains the displaced runtime in a uniquely named `.zfs-director-previous-*` directory beside the live code. This volatile copy is a recovery aid, not a substitute for a persistent backup. Validate the restored code and inspect Jobs before resuming operations.

## Uninstall

Use **Plugins → Installed Plugins → Remove**. Director stops its background services and removes its WebGUI code. If an operation is still active, removal reports the reason and keeps the plugin installed; wait for the operation to finish and retry. No active lock is deleted and no process is forcibly stopped.

Settings, Jobs, audit and recovery data remain on the flash drive for a later reinstall. Datasets, snapshots and retained originals are untouched. Unraid removes the unregistered plugin's managed cron entries from the active scheduler; their saved definitions and all external Sanoid/Syncoid configuration and schedules remain unchanged. Reinstallation runs the usual safety checks.

## Compatibility and testing

Installation, upgrade and normal reboot were evaluated in an isolated Unraid VM. An upgrade and temporary-dataset smoke test were also verified on a running Unraid host, preserving existing state and schedules without rebooting it. Power-loss recovery and native reboot with pending recovery require separate validation. See [Testing](https://github.com/d1-m4ss/zfs-director/blob/2026.10.22.1/docs/TESTING.md#rc1-verification-2026-10-22) and [the developer guide](https://github.com/d1-m4ss/zfs-director/blob/2026.10.22.1/docs/DEVELOPMENT.md).
