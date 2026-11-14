<?php
// ARCH-002: one table for every command the admin endpoint accepts. A new command is added
// here once; ZFSMAdmin.php reads kind, lock, destructive and observed from this table only.
//   kind        read: no audit record. admin: recorded in the audit log.
//   lock        none | config (config lock) | operation (operation lock, waits up to 5 s).
//   destructive requires Destructive Mode, rechecked under the lock.
//   observed    keeps a Jobs journal from the start (scrub progress, downloads).
//   label       human name for History, Jobs and the busy-lock message.
function zfsmCommandRegistry(): array {
    static $registry=null;if($registry!==null)return $registry;
    $registry=[
        // Read-only views and previews: no audit record, no lock.
        'acleditorinfo'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'auditlog'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'conversionjobs'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'downloadsnapshotarchive'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>true,'label'=>'Download ZIP'],
        'downloadsnapshotfile'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>true,'label'=>'Download snapshot file'],
        'getdatasetproperties'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'inventory'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'inventorysnapshots'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'pooldiagnostics'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'previewacl'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'previewcleanup'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'previewdeletedirectory'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'previewdestroy'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'previewhistoryarchive'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'previewpromote'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'previewquota'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'previewrestore'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'previewrollback'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'previewspaceproperty'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'protectioncontrolpreview'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'protectiondata'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'protectiondetect'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'protectionexternalpreview'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'protectionimportpreview'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'protectionpolicypreview'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'protectionreplicationpreview'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'protectionrunpreview'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'protectiontest'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'quotaoverview'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'snapshotfileinfo'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'snapshotfiles'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'validatesettings'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        'protectioncredentiallist'=>['kind'=>'read','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>null],
        // Audited; only queue or flag a durable job, which serializes on its own job/config locks.
        'archivesnapshotfiles'=>['kind'=>'admin','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>'Prepare ZIP'],
        'cancelconversion'=>['kind'=>'admin','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>'Cancel conversion'],
        'cancelrestore'=>['kind'=>'admin','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>'Cancel restore'],
        'convertdirectory'=>['kind'=>'admin','lock'=>'none','destructive'=>true,'observed'=>false,'label'=>'Convert directory'],
        'protectioncancel'=>['kind'=>'admin','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>'Cancel protection job'],
        'protectionrun'=>['kind'=>'admin','lock'=>'none','destructive'=>false,'observed'=>false,'label'=>'Run Data Protection'],
        'restoresnapshotfiles'=>['kind'=>'admin','lock'=>'none','destructive'=>true,'observed'=>false,'label'=>'Restore files'],
        'resumeconversion'=>['kind'=>'admin','lock'=>'none','destructive'=>true,'observed'=>false,'label'=>'Resume conversion'],
        // Audited; change only settings, the protection store or cron. They take the config lock, so a long ZFS job never blocks them.
        'adddirectortlisting'=>['kind'=>'admin','lock'=>'config','destructive'=>false,'observed'=>false,'label'=>'Add directory listing'],
        'protectioncontrol'=>['kind'=>'admin','lock'=>'config','destructive'=>false,'observed'=>false,'label'=>'Change protection definition'],
        'protectionexternaltransfer'=>['kind'=>'admin','lock'=>'config','destructive'=>false,'observed'=>false,'label'=>'Transfer External ownership'],
        'protectionimport'=>['kind'=>'admin','lock'=>'config','destructive'=>false,'observed'=>false,'label'=>'Import policy'],
        'protectionpolicysave'=>['kind'=>'admin','lock'=>'config','destructive'=>false,'observed'=>false,'label'=>'Save snapshot policy'],
        'protectionreplicationsave'=>['kind'=>'admin','lock'=>'config','destructive'=>false,'observed'=>false,'label'=>'Save replication task'],
        'protectionsettings'=>['kind'=>'admin','lock'=>'config','destructive'=>false,'observed'=>false,'label'=>'Change Data Protection settings'],
        'removedirectorylisting'=>['kind'=>'admin','lock'=>'config','destructive'=>false,'observed'=>false,'label'=>'Remove directory listing'],
        'saveconfig'=>['kind'=>'admin','lock'=>'config','destructive'=>false,'observed'=>false,'label'=>'Save settings'],
        'protectioncredentialsave'=>['kind'=>'admin','lock'=>'config','destructive'=>false,'observed'=>false,'label'=>'Save SSH key reference'],
        'protectioncredentialremove'=>['kind'=>'admin','lock'=>'config','destructive'=>false,'observed'=>false,'label'=>'Remove SSH key reference'],
        // Audited; change ZFS or files under the operation lock.
        'activityvisibility'=>['kind'=>'admin','lock'=>'operation','destructive'=>false,'observed'=>false,'label'=>'Organize activity history'],
        'cleanupmutation'=>['kind'=>'admin','lock'=>'operation','destructive'=>true,'observed'=>false,'label'=>'Clean completed recovery'],
        'deletefinishedjobs'=>['kind'=>'admin','lock'=>'config','destructive'=>false,'observed'=>false,'label'=>'Delete finished jobs'],
        'clonesnapshot'=>['kind'=>'admin','lock'=>'operation','destructive'=>false,'observed'=>false,'label'=>'Clone snapshot'],
        'createdataset'=>['kind'=>'admin','lock'=>'operation','destructive'=>false,'observed'=>false,'label'=>'Create dataset'],
        'deletedirectory'=>['kind'=>'admin','lock'=>'operation','destructive'=>true,'observed'=>false,'label'=>'Delete directory'],
        'destroydataset'=>['kind'=>'admin','lock'=>'operation','destructive'=>true,'observed'=>false,'label'=>'Delete dataset'],
        'destroysnapshot'=>['kind'=>'admin','lock'=>'operation','destructive'=>true,'observed'=>false,'label'=>'Delete snapshots'],
        'editacl'=>['kind'=>'admin','lock'=>'operation','destructive'=>false,'observed'=>false,'label'=>'Change permissions'],
        'editdatasetproperty'=>['kind'=>'admin','lock'=>'operation','destructive'=>false,'observed'=>false,'label'=>'Change dataset property'],
        'holdsnapshot'=>['kind'=>'admin','lock'=>'operation','destructive'=>false,'observed'=>false,'label'=>'Hold snapshot'],
        'lockdataset'=>['kind'=>'admin','lock'=>'operation','destructive'=>true,'observed'=>false,'label'=>'Lock dataset'],
        'movedirectory'=>['kind'=>'admin','lock'=>'operation','destructive'=>true,'observed'=>false,'label'=>'Move directory'],
        'promotedataset'=>['kind'=>'admin','lock'=>'operation','destructive'=>false,'observed'=>false,'label'=>'Promote clone'],
        'publishconversion'=>['kind'=>'admin','lock'=>'operation','destructive'=>true,'observed'=>false,'label'=>'Publish conversion'],
        'refresh'=>['kind'=>'admin','lock'=>'operation','destructive'=>false,'observed'=>false,'label'=>null],
        'releasesnapshot'=>['kind'=>'admin','lock'=>'operation','destructive'=>false,'observed'=>false,'label'=>'Release snapshot hold'],
        'renamedataset'=>['kind'=>'admin','lock'=>'operation','destructive'=>false,'observed'=>false,'label'=>'Rename dataset'],
        'renamesnapshot'=>['kind'=>'admin','lock'=>'operation','destructive'=>false,'observed'=>false,'label'=>'Rename snapshot'],
        'rollbacksnapshot'=>['kind'=>'admin','lock'=>'operation','destructive'=>true,'observed'=>false,'label'=>'Restore dataset from snapshot'],
        'scrubpool'=>['kind'=>'admin','lock'=>'operation','destructive'=>false,'observed'=>true,'label'=>'Pool scrub'],
        'setquota'=>['kind'=>'admin','lock'=>'operation','destructive'=>false,'observed'=>false,'label'=>'Change quota'],
        'snapshotdataset'=>['kind'=>'admin','lock'=>'operation','destructive'=>false,'observed'=>false,'label'=>'Create snapshots'],
        'stopdestroyprocesses'=>['kind'=>'admin','lock'=>'operation','destructive'=>true,'observed'=>false,'label'=>'Stop processes'],
        'unlockdataset'=>['kind'=>'admin','lock'=>'operation','destructive'=>false,'observed'=>false,'label'=>'Unlock dataset'],
    ];
    foreach($registry as$name=>&$entry)$entry['name']=$name;unset($entry);
    return $registry;
}
// The correct spelling of the historical adddirectortlisting command (the client still sends the old one).
function zfsmCommandAliases(): array { return ['adddirectorylisting'=>'adddirectortlisting']; }
function zfsmCommand(string $name): ?array {
    $registry=zfsmCommandRegistry();
    return $registry[zfsmCommandAliases()[$name]??$name]??null;
}
