<?php
// Compatibility API: HTTP only queues work; the CLI worker performs the copy.
function zfsmWriteConversionJob($file,$job) { zfsmJobAtomicWrite($file,$job); }
function convertDirectory($directory,$pool,$offline_confirmed=false) {
    $answer=zfsmQueueConversion($directory,$pool,$offline_confirmed);
    if (!empty($answer['job'])) {
        try { zfsmStartWorker(); }
        catch (Throwable $error) { $answer['worker_warning']='Job is saved, but the background worker did not start. Resume after checking the worker.'; }
    }
    return $answer;
}
