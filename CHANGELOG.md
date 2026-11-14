### 2026.11.14.1
Snapshot policies, replication and file jobs now run in three separate background lanes, so a long replication no longer delays scheduled snapshots, restores or file operations; a policy waits while a local replication is receiving into its dataset. SSH keys for remote replication are registered in Settings: only the key and known_hosts paths are stored, and keys under /boot survive a reboot. One switch turns Sanoid/Syncoid integration on or off. The replication wizard first asks whether the copy goes to this server or to another one. Jobs has fewer filters, and a Running now bar on every screen names the operation in progress. A dataset has four tabs with its actions in one Actions menu, and Overview shows a status summary. The idle background service no longer rereads unchanged job journals.

ZFS Director: based on ZFS Master by Carlos Rodriguez (IkerSaint). GPL-2.0-or-later. Settings and recovery state retain their namespace. Background services start automatically after successful validation. Uninstall stops Director services and preserves settings, Jobs and recovery data.

### 2026.11.13.3
New Large window button in the plugin header opens the whole plugin in a large window over the page; Escape or Close window returns. The pool warning bar is now one compact line with a shorter replication message.

ZFS Director: based on ZFS Master by Carlos Rodriguez (IkerSaint). GPL-2.0-or-later. Settings and recovery state retain their namespace. Background services start automatically after successful validation. Uninstall stops Director services and preserves settings, Jobs and recovery data.

### 2026.11.13.2
Fixed an update that was refused with Jobs scan incomplete on servers with a large Jobs folder. The pre-update check now counts only job journals, not their lock files, and allows up to 50000 of them.

ZFS Director: based on ZFS Master by Carlos Rodriguez (IkerSaint). GPL-2.0-or-later. Settings and recovery state retain their namespace. Background services start automatically after successful validation. Uninstall stops Director services and preserves settings, Jobs and recovery data.

### 2026.11.13.1
Jobs now lists background work and failures only. Quick actions such as taking a snapshot or saving settings are recorded in Administrative History, so the list is no longer flooded. Scheduled snapshot checks that find nothing to do no longer write anything to the USB flash, and settings and policy changes can be saved while a long operation is running. The Jobs badge shows active and attention jobs, replication schedules are shown in words, a disabled action shows why, and the empty Unknown rows are gone. One interface layout replaces Workspace and Compact. Rare settings sit under Advanced, and technical texts are plainer. The File Manager fits a phone screen again, and a busy operation lock now names the running operation. The support link points to the Unraid forum thread.

ZFS Director: based on ZFS Master by Carlos Rodriguez (IkerSaint). GPL-2.0-or-later. Settings and recovery state retain their namespace. Background services start automatically after successful validation. Uninstall stops Director services and preserves settings, Jobs and recovery data.

### 2026.11.09.12
Compact top area, so the work panes are taller. A pool warning now shows its reason with links to the replication job and the pool status. Replication destination is a parent dataset plus a replica name (it is created inside the parent, with the full path shown). Scheduled snapshot checks that did nothing are no longer written to Jobs or the audit log. The Clear button in Jobs is aligned.

ZFS Director: based on ZFS Master by Carlos Rodriguez (IkerSaint). GPL-2.0-or-later. Settings and recovery state retain their namespace. Background services start automatically after successful validation. Uninstall stops Director services and preserves settings, Jobs and recovery data.
