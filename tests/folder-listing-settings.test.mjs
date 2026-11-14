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
