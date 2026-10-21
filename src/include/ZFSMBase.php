<?php
	$plugin = "zfs.master.ui";
	$docroot = $docroot ?? ($_SERVER['DOCUMENT_ROOT'] ?? '/usr/local/emhttp');
	$docroot = $docroot ?: '/usr/local/emhttp';
	$plugin_config = "/boot/config/plugins/".$plugin."/".$plugin.".cfg";
	$plugin_include = $docroot."/plugins/".$plugin."/include/";
	$plugin_session_file = "/tmp/".$plugin."-session.data";
	$plugin_lock = '/var/lock/'.$plugin.'.lock';
	$plugin_state = '/boot/config/plugins/'.$plugin.'/jobs';
	$plugin_runtime = '/var/tmp/'.$plugin.'/jobs';
	$plugin_worker_lock = '/var/lock/'.$plugin.'.worker.lock';
	$plugin_service_lock = '/var/lock/'.$plugin.'.service.lock';
	$plugin_audit = '/boot/config/plugins/'.$plugin.'/audit';
		
	$urlzmadmin = "/plugins/".$plugin."/backend/ZFSMAdmin.php";
	$urlcreatedataset = "/plugins/".$plugin."/frontend/ZFSMCreateDataset.php";
	$urladmindatasetsnaps = "/plugins/".$plugin."/frontend/ZFSMAdminDatasetSnaps.php";
?>
