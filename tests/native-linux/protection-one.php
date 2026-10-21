<?php
require __DIR__.'/protection-bootstrap.php';
$id=$argv[1]??'';zfsmJobId($id);zfsmRunProtectionJob(zfsmReadJob($id));
