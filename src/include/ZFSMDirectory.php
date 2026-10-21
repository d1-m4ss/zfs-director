<?php
/* Branding renamed to ZFS Director on 2026-10-16; GPL-2.0-or-later. */
// Path-based rename/rm cannot safely follow an ancestor controlled by another
// account. Fail closed instead of changing its ownership or permissions.
// Administrator/root writers remain outside the plugin's mutation lock.
function zfsmDirectoryParentsTrusted($path) {
    for($parent=dirname($path);; $parent=dirname($parent)) {
        clearstatcache(true,$parent);$stat=@lstat($parent);
        if(!$stat||($stat['mode']&0170000)!==0040000||(int)$stat['uid']!==0||($stat['mode']&0022)!==0||is_link($parent))return false;
        if($parent==='/')return true;
    }
}
/* ZFS Director UI local hardening; GPL-2.0-or-later. */
function zfsmMountInfo() {
    $text = @file_get_contents('/proc/self/mountinfo');
    if (!is_string($text) || $text === '') return array();
    $mounts = array();
    foreach (explode("\n", trim($text)) as $line) {
        $halves = explode(' - ', $line, 2);
        if (count($halves) !== 2) continue;
        $left = explode(' ', $halves[0]); $right = explode(' ', $halves[1]);
        if (count($left) < 6 || count($right) < 2) continue;
        $decode = function($value) { return preg_replace_callback('/\\\\([0-7]{3})/', function($m) { return chr(octdec($m[1])); }, $value); };
        $mounts[] = array('id'=>$left[0], 'parent'=>$left[1], 'path' => rtrim($decode($left[4]), '/') ?: '/', 'fs' => $right[0], 'source' => $decode($right[1]));
    }
    return $mounts;
}

function zfsmLiveZfsMount($path, $dataset, $mountinfo) {
    $exact = array_values(array_filter($mountinfo, function($m) use ($path) { return $m['path'] === $path; }));
    if (count($exact) !== 1 || $exact[0]['fs'] !== 'zfs' || $exact[0]['source'] !== $dataset) return false;
    $by_id = array();
    foreach ($mountinfo as $m) $by_id[$m['id']] = $m;
    $ancestors = array(); $current = $exact[0];
    while ($current && !isset($ancestors[$current['id']])) {
        $ancestors[$current['id']] = true;
        $current = $by_id[$current['parent']] ?? null;
    }
    // A mount on an ancestor path can hide this otherwise valid ZFS record.
    // Its ID must belong to the actual parent chain of the selected mount.
    foreach ($mountinfo as $m) {
        if (($m['path'] === '/' || str_starts_with($path, $m['path'].'/')) && !isset($ancestors[$m['id']])) return false;
    }
    return true;
}

function zfsmPathHasSymlink($path) {
    $current = '';
    foreach (explode('/', trim($path, '/')) as $part) {
        if ($part === '' || $part === '.' || $part === '..') return true;
        $current .= '/'.$part;
        if (is_link($current)) return true;
    }
    return false;
}

// Authorization is based on both configured ZFS state and the live mount table.
function zfsmValidateDirectory($path, $filesystems, $mountinfo, $must_exist = true) {
    if (!is_string($path) || $path === '' || $path[0] !== '/' || preg_match('/[\x00-\x1F\x7F]/', $path)) return null;
    $path = rtrim($path, '/');
    if ($path === '' || zfsmPathHasSymlink($path)) return null;
    $resolved = $must_exist ? realpath($path) : realpath(dirname($path));
    if ($resolved === false) return null;
    if (!$must_exist) $resolved = rtrim($resolved, '/').'/'.basename($path);
    if ($must_exist && !is_dir($resolved)) return null;
    $candidates = array();
    foreach ($filesystems as $dataset => $entry) {
        $mp = $entry['mountpoint'];
        if ($resolved === $mp) return null;
        if (str_starts_with($resolved, $mp.'/')) $candidates[$dataset] = $entry;
    }
    uasort($candidates, function($a, $b) { return strlen($b['mountpoint']) <=> strlen($a['mountpoint']); });
    $dataset = array_key_first($candidates);
    if ($dataset === null || $candidates[$dataset]['mounted'] !== 'yes') return null;
    $mp = $candidates[$dataset]['mountpoint'];
    if (!zfsmLiveZfsMount($mp, $dataset, $mountinfo)) return null;
    foreach ($mountinfo as $mount) {
        // Refuse traversal into or removal of any nested mount, including bind/tmpfs.
        if ($mount['path'] === $resolved || str_starts_with($mount['path'], $resolved.'/')) return null;
        if (strlen($mount['path']) > strlen($mp) && str_starts_with($resolved, $mount['path'].'/')) return null;
    }
    return array('path' => $resolved, 'dataset' => $dataset, 'mountpoint' => $mp);
}
