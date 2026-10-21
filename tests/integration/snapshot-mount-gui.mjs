import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {startIntegration} from './server.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const output=process.env.ZFSM_OUTPUT||'evidence/snapshot-mount-2026-10-20/gui';await mkdir(output,{recursive:true});const checks=[];
const browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true});
try{for(const busy of [false,true]){
 const stand=await startIntegration(),page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  const m=stand.readModel(),owner='cache/__mock__/project',snapshot=owner+'@gui-browsed',mount=m.datasets[owner].mountpoint;
  m.snapshots[snapshot]={...m.snapshots[owner+'@base'],name:snapshot,guid:'9876543210'};m.snapshot_busy=busy;stand.writeModel(m);
  // Replace only Linux /proc + ZFS mount metadata input in this WASM stand.
  // The busy-report classifier, signed preview, UI and destroy endpoint stay real.
  const file='/app/src/include/ZFSMDestroyBusy.php',source=stand.php.readFileAsText(file),start=source.indexOf('function zfsmDestroyBusyDiagnostics('),end=source.indexOf('function zfsmDestroyBlockedAnswer(',start);
  const table=`1 0 0:1 / / rw - rootfs rootfs rw\n2 1 0:2 / ${mount} rw - zfs ${owner} rw\n3 2 0:3 / ${mount}/.zfs/snapshot/gui-browsed ro - zfs ${snapshot} ro`;
  const shim=`function zfsmDestroyBusyDiagnostics($objects){$m=integrationModel();$p=['pid'=>1,'command'=>'init','namespace'=>'host','mountinfo'=>${JSON.stringify(table)},'cwd'=>'/','fd_mount_ids'=>[]];$ps=[$p];if($m['snapshot_busy'])$ps[]=array_replace($p,['pid'=>900,'command'=>'reader','fd_mount_ids'=>['3']]);return zfsmDestroyBusyReport($objects,$ps,'host',[${JSON.stringify(owner)}=>['mountpoint'=>${JSON.stringify(mount)},'mounted'=>'yes']])+['complete'=>true,'warnings'=>[]];}\n`;
  stand.php.writeFile(file,source.slice(0,start)+shim+source.slice(end));
  await page.route('**/*',r=>r.request().url().startsWith(stand.url)?r.continue():r.abort());await page.goto(stand.url);await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.locator('[data-node="'+owner+'"]').click();await page.getByRole('navigation',{name:'Workspace tabs'}).getByRole('button',{name:'Snapshots',exact:true}).click();
  const row=page.locator('tr').filter({has:page.getByText(snapshot,{exact:true})});await row.getByRole('button',{name:'Operations',exact:true}).click();await page.locator('[data-snapshot-action=destroysnapshot]').filter({visible:true}).click();await page.locator('[data-preview]').click();await page.locator('.zfsm-destroy-diagnostics').waitFor();await page.locator('[name=acknowledge]').check();
  const submit=page.locator('.zfsm-form button[type=submit]');
  if(busy){assert.equal(await submit.isEnabled(),false);assert.match(await page.locator('.zfsm-destroy-diagnostics').innerText(),/Open file reference.*PID 900/);assert.doesNotMatch(await page.locator('.zfsm-destroy-diagnostics').innerText(),/PID 1 \(init\)/);assert.ok(stand.readModel().snapshots[snapshot]);checks.push('Real FD input keeps Delete disabled and identifies its reader instead of PID1');}
  else{assert.equal(await submit.isEnabled(),true);assert.match(await page.locator('.zfsm-destroy-diagnostics').innerText(),/No blocking references/);assert.doesNotMatch(await page.locator('.zfsm-destroy-diagnostics').innerText(),/PID 1/);await page.screenshot({path:output+'/unused-preview.png'});await submit.click();await page.locator('[data-confirm-operation]').click();await page.getByText('✓ Destroyed',{exact:true}).waitFor();assert.equal(stand.readModel().snapshots[snapshot],undefined);assert.ok(stand.readModel().snapshots[owner+'@base']);assert.ok(stand.readModel().datasets[owner]);checks.push('Unused canonical automount permits explicit preview/confirmation and deletes only the selected snapshot');}
  await page.screenshot({path:output+'/'+(busy?'busy-protected':'unused-destroyed')+'.png'});assert.deepEqual(errors,[]);assert.deepEqual(stand.errors.filter(e=>e.trim()!=='ZFS Director backend request failed'),[]);
 }finally{await page.close();await stand.close();}
}
await writeFile(output+'/results.json',JSON.stringify({pass:true,checks,boundary:'Real frontend/PHP/preview/guards; Linux /proc and mount metadata are controlled input fixtures. Native ZFS tested separately.'},null,2)+'\n');console.log(JSON.stringify({pass:true,checks},null,2));
}finally{await browser.close();}
