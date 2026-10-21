<?php
/* Branding renamed to ZFS Director on 2026-10-16; GPL-2.0-or-later. */
// Compatibility link: creation now belongs to the integrated workspace.
$pool = is_string($_GET['zpool'] ?? null) ? $_GET['zpool'] : '';
$target = '/Main/ZFSDirector?section=create&pool='.rawurlencode($pool);
if (!headers_sent()) header('Location: '.$target, true, 302);
?>
<p><a href="<?=htmlspecialchars($target, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8')?>">Open Create Dataset in ZFS Director</a></p>
<script>window.location.replace(<?=json_encode($target, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT)?>);</script>
