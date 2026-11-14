### 2026.11.14.4
Delete finished jobs now removes every finished record and the newest results are saved first; one unreadable journal no longer stops the cleanup, and unreadable settings never delete anything. Every Jobs card says in plain words what the process was, where it went, how it started and how it ended, including conversion, restore and ZIP cards. The Everything switch and the delete message reset when you change a filter or leave Jobs, and a delete error stays on screen. A scheduled policy check no longer gets an Open in Jobs link on the Running now bar. After a successful action the dialog shows only the result and a Close button; a partial or failed result keeps the form for a retry. A failed quick action and a refused restore no longer write hidden records to the flash drive; the error is shown in the dialog and kept in the audit log. Scrub and download progress is now kept in memory instead of on the flash drive. A snapshot policy whose scheduled check keeps failing now shows the reason, how many times and since when on its row, and the Overview names it with an Open policy link; the line goes away after the next check passes. Settings no longer has the Show folders in the tree list; folders are shown or hidden from a dataset's Actions menu, and the saved choice is kept. Properties no longer print Source: Unknown. Files replaced by a restore now stay identifiable after their job expires: the folder has a short description (date, snapshot and destination), Show recovery files displays it, and Delete retained files removes the folder.

ZFS Director: based on ZFS Master by Carlos Rodriguez (IkerSaint). GPL-2.0-or-later. Settings and recovery state retain their namespace. Background services start automatically after successful validation. Uninstall stops Director services and preserves settings, Jobs and recovery data.

### 2026.11.14.3
Jobs lists only functional work: directory conversion, file restore and ZIP preparation, dataset or directory deletion, requests refused before they started, replication runs, and manual snapshot-policy runs. Quick actions, scrub, downloads and scheduled snapshot checks no longer appear, and the Clean job history entry is gone. Finished jobs are deleted after 7 days by default; Settings has a new Keep finished jobs for option (1 day, 7 days, 30 days or Always). One Delete finished jobs button and an Everything checkbox replace the three clear and restore buttons; the button deletes at once, on every page, whatever matches the filters. The Jobs badge counts only running jobs. The long storage explanation is now one short line.

ZFS Director: based on ZFS Master by Carlos Rodriguez (IkerSaint). GPL-2.0-or-later. Settings and recovery state retain their namespace. Background services start automatically after successful validation. Uninstall stops Director services and preserves settings, Jobs and recovery data.

### 2026.11.14.2
A scheduled Sanoid or Syncoid run that is refused before it starts (for example, Sanoid is missing) is now recorded once instead of every minute; repeats only raise a counter, and old duplicates are folded away by the hourly cleanup. Jobs has a new Delete finished jobs button that removes the records of all finished jobs; running jobs, jobs that hold a snapshot, a ZIP or recovery data, and the latest result of each policy and replication are kept. Clear finished on this page now also hides failed jobs. The Administrative History screen is gone: quick actions stay in the audit log, and errors are in Jobs.

ZFS Director: based on ZFS Master by Carlos Rodriguez (IkerSaint). GPL-2.0-or-later. Settings and recovery state retain their namespace. Background services start automatically after successful validation. Uninstall stops Director services and preserves settings, Jobs and recovery data.

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
