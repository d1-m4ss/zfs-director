import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {runtime} from './php-runtime.mjs';

const settings={refresh_interval:'30',lazy_load:'0',sanoid_integration:'0',destructive_mode:'0',exclusion:'',snap_max_days_alert:'30',snap_pattern:'Y-m-d-His',snap_prefix:'auto-'};
test('saving Settings keeps the stored folder listing exactly',async()=>{
 const php=await runtime();
 try{
  php.writeFile('/listing-settings.cfg','[general]\ndirectory_listing="cache/a\ncache/b"\n');
  const encoded=Buffer.from(JSON.stringify({...settings,snap_prefix:'daily-'})).toString('base64');
  const r=await php.run({code:`<?php require '/app/harness.php';$GLOBALS['plugin_config']='/listing-settings.cfg';
   $before=parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_NORMAL)['general']['directory_listing'];
   $answer=zfsmSaveSettings(json_decode(base64_decode('${encoded}'),true));
   $after=parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_NORMAL)['general'];
   echo json_encode(['failed'=>$answer['failed'],'before'=>$before,'after'=>$after['directory_listing'],'prefix'=>$after['snap_prefix']]);`});
  assert.equal(r.errors,'');
  assert.deepEqual(JSON.parse(r.text),{failed:[],before:'cache/a\ncache/b',after:'cache/a\ncache/b',prefix:'daily-'});
 }finally{php.exit();}
});
test('the Settings form has no folder listing field and does not send one',async()=>{
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window,root=w.document.querySelector('main');w.eval(readFileSync('src/frontend/ZFSMForms.js','utf8'));
 const forms=w.zfsmCreateInlineForms({getConfig:()=>({directory_listing:['cache/a']}),request:async()=>({valid:true,errors:{},snapshot_preview:'x'})});
 await forms.render(root,'saveconfig',{datasets:['cache/a'],settings:{}});
 try{
  assert.equal(root.querySelector('[name=directory_listing]'),null);
  assert.equal(root.textContent.includes('Show folders in the tree for these datasets'),false);
 }finally{forms.dispose();w.close();}
});
test('the Settings form has no replication age field, stays valid and keeps the stored legacy switch',async()=>{
 const php=await runtime();const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window,root=w.document.querySelector('main');w.eval(readFileSync('src/frontend/ZFSMForms.js','utf8'));
 const calls=[];let forms;
 try{
  forms=w.zfsmCreateInlineForms({getConfig:()=>({refresh_interval:30,lazy_load:0,destructive_mode:0,dataset_exclusion:'',snap_max_days_alert:30,snap_pattern:'Y-m-d-His',snap_prefix:'auto-',space_warning_percent:80,space_critical_percent:90,replication_lag_hours:0,job_retention_days:7}),request:async data=>{calls.push(data);return {valid:true,errors:{},snapshot_preview:'x'};}});
  await forms.render(root,'saveconfig',{});for(let n=0;n<20;n++)await Promise.resolve();
  assert.equal(root.querySelector('[name=replication_lag_hours]'),null);assert.equal(root.textContent.includes('replication age'),false);
  const form=root.querySelector('form');assert.equal(form.checkValidity(),true,root.textContent);
  const sent=Object.fromEntries([...root.querySelectorAll('[name]')].map(c=>[c.name,c.value]));assert.equal(Object.hasOwn(sent,'replication_lag_hours'),false);
  const validation=calls.at(-1);assert.equal(validation.cmd,'validatesettings');assert.equal(Object.hasOwn(validation.settings,'replication_lag_hours'),false);assert.equal(validation.settings.space_critical_percent,'90');
  php.writeFile('/legacy-settings.cfg','[general]\nreplication_lag_hours="0"\n');
  const encoded=Buffer.from(JSON.stringify({...settings,snap_prefix:'daily-'})).toString('base64');
  const r=await php.run({code:`<?php require '/app/harness.php';$GLOBALS['plugin_config']='/legacy-settings.cfg';
   $answer=zfsmSaveSettings(json_decode(base64_decode('${encoded}'),true));
   $after=parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_NORMAL)['general'];
   echo json_encode(['failed'=>$answer['failed'],'hours'=>$after['replication_lag_hours'],'config'=>loadConfig(['general'=>$after])['replication_lag_hours']]);`});
  assert.equal(r.errors,'');assert.deepEqual(JSON.parse(r.text),{failed:[],hours:'0',config:0});
 }finally{forms?.dispose();w.close();php.exit();}
});
