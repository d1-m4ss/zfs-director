// UX-006: register, list and remove an SSH key reference for remote replication.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
const require=createRequire(import.meta.url),{chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const out=process.env.ZFSM_OUTPUT||'backups/2026-11-13/ssh-keys';await mkdir(out,{recursive:true});
const scripts=await Promise.all(['ZFSMDateTime','ZFSMInventory','ZFSMForms','ZFSMSnapshots','ZFSMExplorer','ZFSMPoolView','ZFSMOverview','ZFSMProtection','ZFSMWorkspace'].map(name=>readFile('src/frontend/'+name+'.js','utf8'))),css=await readFile('src/frontend/ZFSMWorkspace.css','utf8'),protectionCSS=await readFile('src/frontend/ZFSMProtection.css','utf8');
const browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true}),errors=[];
async function open(width){
 const page=await browser.newPage({viewport:{width,height:1000}});page.setDefaultTimeout(5000);await page.route('**/*',r=>r.abort());page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<style>body{margin:12px;font:14px Arial;background:#202020;color:#eee}</style><main id="zfsm-workspace"></main>');await page.addStyleTag({content:css+protectionCSS});for(const content of scripts)await page.addScriptTag({content});
 await page.evaluate(()=>{
  const tree={name:'cache',guid:'1',type:'filesystem',mountpoint:'/mnt/cache',encryption:'off',keystatus:'none',child:{},directories:[],snapshots:[]};
  window.keys=[];window.calls=[];
  const data=()=>({datasets:[{name:'cache/a',guid:'10'},{name:'cache/b',guid:'11'}],policies:[],replications:[{id:'r1',name:'Offsite',owner:'managed',source:'cache/a',target:'tank/a',mode:'remote',host:'backup.example',credential:'used-key',schedule:'0 2 * * *',enabled:false}],jobs:[],templates:{},issues:[],credentials:keys.map(k=>k.name),scheduler:{external:[],issues:[]}});
  window.zfsm_workspace=zfsmCreateWorkspace({root:document.querySelector('main'),config:{refresh_interval:0,destructive_mode:1},request:async fields=>{calls.push(fields);
   if(fields.cmd==='inventory')return {op:'getAll',data:{pools:{cache:{Health:'ONLINE',Size:1000,Used:1}},datasets:{cache:tree},devices:{cache:''},errors:{}}};
   if(fields.cmd==='conversionjobs')return {jobs:[],worker_running:true};if(fields.cmd==='pooldiagnostics')throw Error('Synthetic unavailable');
   if(fields.cmd==='protectiondetect')return {visible:true,installed:true,enabled:true,compatible:true,state:'healthy',issues:[],sanoid:{version:'2.3.0'},syncoid:{version:'2.3.0'}};
   if(fields.cmd==='protectiondata')return data();
   if(fields.cmd==='protectioncredentiallist')return {credentials:structuredClone(keys)};
   if(fields.cmd==='protectioncredentialsave'){if(!fields.keyfile.startsWith('/'))return {succeeded:{},failed:{[fields.name]:'Credential paths must be absolute trusted paths without shell syntax or whitespace.'}};keys.push({name:fields.name,keyfile:fields.keyfile,known_hosts:fields.known_hosts,usable:true,problem:null,used_by:fields.name==='used-key'?['Offsite']:[],persistent:fields.keyfile.startsWith('/boot/')});return {succeeded:{[fields.name]:'SSH key reference added'},failed:{}};}
   if(fields.cmd==='protectioncredentialremove'){keys=keys.filter(k=>k.name!==fields.name);return {succeeded:{[fields.name]:'removed'},failed:{}};}
   if(fields.cmd==='auditlog')return {entries:[]};
   throw Error('Unexpected fixture command '+fields.cmd);}});
 });
 await page.locator('[data-section=settings]').click();await page.getByRole('heading',{name:'Sanoid / Syncoid Integration',exact:true}).waitFor();
 return page;
}
const card=page=>page.locator('.zfsm-ssh-keys');
try{
 for(const width of [390,1280]){
  const page=await open(width);
  await card(page).getByText('No SSH keys are registered yet. Remote replication needs one.').waitFor();
  const add=card(page).locator('details').filter({has:page.locator('summary',{hasText:'Add SSH key'})});
  assert.notEqual(await add.getAttribute('open'),null,'the form is open while no key exists');
  assert.match(await add.innerText(),/ssh-keygen -t ed25519/);assert.match(await add.innerText(),/ssh-keyscan/);assert.match(await add.innerText(),/\/root is in RAM/);
  await card(page).getByRole('button',{name:'Add SSH key',exact:true}).click();
  await card(page).getByText('Enter a name and both file paths.').waitFor();
  assert.equal((await page.evaluate(()=>calls.filter(c=>c.cmd==='protectioncredentialsave').length)),0,'empty form is not sent');
  await card(page).getByRole('textbox',{name:'Name',exact:true}).fill('relative');
  await card(page).getByRole('textbox',{name:'Private key file',exact:true}).fill('id_ed25519');
  await card(page).getByRole('textbox',{name:'known_hosts file',exact:true}).fill('/boot/k');
  await card(page).getByRole('button',{name:'Add SSH key',exact:true}).click();
  await card(page).getByText(/Credential paths must be absolute/).waitFor();
  await card(page).getByRole('textbox',{name:'Name',exact:true}).fill('used-key');
  await card(page).getByRole('textbox',{name:'Private key file',exact:true}).fill('/boot/config/ssh/zfs-director/id_ed25519');
  await card(page).getByRole('button',{name:'Add SSH key',exact:true}).click();
  const row=card(page).locator('.zfsm-ssh-key').filter({hasText:'used-key'});await row.waitFor();
  assert.match(await row.innerText(),/Ready/);assert.match(await row.innerText(),/Used by: Offsite/);
  const remove=row.getByRole('button',{name:'Remove SSH key used-key',exact:true});assert.equal(await remove.isDisabled(),true,'a key used by a replication cannot be removed');
  assert.match(await remove.getAttribute('title'),/Offsite/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal page scroll');
  await page.screenshot({path:out+'/settings-'+width+'.png',fullPage:true});
  // The replication wizard lists the registered key.
  await page.locator('[data-section=replication]').click();await page.getByRole('button',{name:'New replication',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByRole('combobox',{name:'Source dataset',exact:true}).selectOption('cache/a');await dialog.getByRole('button',{name:'Next',exact:true}).click();
  await dialog.getByRole('combobox',{name:'Destination mode',exact:true}).selectOption('remote');
  const key=dialog.getByRole('combobox',{name:'SSH key',exact:true});
  assert.deepEqual(await key.locator('option').allTextContents(),['Choose an SSH key','used-key'],'the wizard lists registered keys');
  // UX-007: the mode comes first; a remote destination shows no local dataset list.
  const labels=await dialog.locator('.zfsm-protection-fields > label:not([hidden]) > span').allTextContents();
  assert.equal(labels[0],'Destination mode','Destination mode is the first field');
  assert.equal(await dialog.getByRole('combobox',{name:'Destination parent dataset',exact:true}).isVisible(),false,'no local parent list for a remote destination');
  await dialog.getByRole('textbox',{name:'Destination dataset (full name on the remote server)',exact:true}).fill('tank/a');
  await dialog.getByRole('textbox',{name:'Remote host',exact:true}).fill('backup.example');await key.selectOption('used-key');
  await dialog.getByRole('button',{name:'Next',exact:true}).click();
  const schedule=dialog.getByRole('combobox',{name:'Run schedule',exact:true});await schedule.waitFor();
  assert.equal((await schedule.locator('option').allTextContents()).some(t=>/every minute/i.test(t)),false,'no every-minute preset for replication');
  await dialog.getByRole('button',{name:'Back',exact:true}).click();await dialog.getByRole('combobox',{name:'Destination mode',exact:true}).selectOption('local');
  assert.equal(await dialog.locator('details').filter({has:page.locator('summary',{hasText:'Remote SSH connection'})}).isVisible(),false,'the SSH block is hidden for a local destination');
  await page.close();
 }
 assert.deepEqual(errors,[]);
 console.log('PASS ssh keys: empty state with steps, validation, list with status, remove guard (390 and 1280 px)');
}finally{await browser.close();}
