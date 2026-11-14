// Reads the audit log straight from the test stand's storage (the plugin has no endpoint for it).
export async function auditEntries(stand){
 const r=await stand.run({code:"<?php require '/acceptance/system.php';require '/app/src/backend/ZFSMOperations.php';echo json_encode(zfsmAuditPage('500','')['entries']);"});
 if(r.errors!=='')throw new Error('Audit read failed: '+r.errors);
 return JSON.parse(r.text);
}
