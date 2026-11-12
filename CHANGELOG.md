### 2026.11.09.12
Compact top area, so the work panes are taller. A pool warning now shows its reason with links to the replication job and the pool status. Replication destination is a parent dataset plus a replica name (it is created inside the parent, with the full path shown). Scheduled snapshot checks that did nothing are no longer written to Jobs or the audit log. The Clear button in Jobs is aligned.

ZFS Director: based on ZFS Master by Carlos Rodriguez (IkerSaint). GPL-2.0-or-later. Settings and recovery state retain their namespace. Background services start automatically after successful validation. Uninstall stops Director services and preserves settings, Jobs and recovery data.
