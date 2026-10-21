<?php
/* Branding renamed to ZFS Director on 2026-10-16; GPL-2.0-or-later. */
// Compatibility link: snapshot administration now belongs to the workspace.
$pool = is_string($_GET['zpool'] ?? null) ? $_GET['zpool'] : '';
$dataset = is_string($_GET['zdataset'] ?? null) ? $_GET['zdataset'] : $pool;
$target = '/Main/ZFSDirector?section=datasets&pool='.rawurlencode($pool).'&dataset='.rawurlencode($dataset).'&tab=snapshots';
if (!headers_sent()) header('Location: '.$target, true, 302);
?>
<p><a href="<?=htmlspecialchars($target, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8')?>">Open Admin Snapshots in ZFS Director</a></p>
<script>window.location.replace(<?=json_encode($target, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT)?>);</script>
