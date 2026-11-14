import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {startIntegration} from './server.mjs';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const output=process.env.ZFSM_OUTPUT||'evidence/history-fixes-integration';await mkdir(output+'/screenshots',{recursive:true});
const stand=await startIntegration(),browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true}),context=await browser.newContext({viewport:{width:1280,height:1000}}),page=await context.newPage(),checks=[],errors=[];
page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));await context.route('**/*',route=>route.request().url().startsWith(stand.url)?route.continue():route.abort());
try{
 await page.goto(stand.url);await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.locator('[data-node="cache/__mock__/project"]').waitFor();
 await page.getByRole('button',{name:'Datasets',exact:true}).click();await page.locator('[data-node="cache/__mock__/project"]').click();await page.getByRole('navigation',{name:'Workspace tabs'}).getByRole('button',{name:'Actions',exact:true}).click();await page.getByRole('button',{name:'Take Snapshot',exact:true}).click();const form=page.locator('.zfsm-form');await form.locator('button[type=submit]').click();const confirm=form.locator('[data-confirm-operation]');await confirm.waitFor();
 let release;const held=new Promise(resolve=>release=resolve);await page.route('**/ZFSMAdmin.php',async route=>{if(new URLSearchParams(route.request().postData()).get('cmd')==='inventory')await held;await route.continue();});await page.evaluate(()=>zfsm_workspace.refresh());assert.equal(await confirm.count(),1);assert.equal(await confirm.isDisabled(),true);release();await page.waitForFunction(()=>document.querySelector('[data-confirm-operation]')?.disabled===false);await page.screenshot({path:output+'/screenshots/confirmation-after-refresh.png',fullPage:false});await form.getByRole('button',{name:'Back',exact:true}).click();assert.equal(stand.calls.filter(c=>new URLSearchParams(c.body).get('cmd')==='snapshotdataset').length,0);checks.push('Actual Chromium confirmation survives held PHP inventory refresh disabled, then re-enables without mutation');
 assert.deepEqual(errors,[]);
}catch(error){errors.push(error.message);throw error;}finally{await writeFile(output+'/results.json',JSON.stringify({checks,errors,system_boundary:'Real frontend and PHP; simulated ZFS/Unraid boundaries'},null,2));await browser.close();await stand.close();}
console.log(JSON.stringify({passed:checks.length,checks,errors}));
