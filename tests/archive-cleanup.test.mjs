import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {runtime} from './php-runtime.mjs';

test('archive cleanup reconciles a proven absent owner without deleting paths or replaying work',async()=>{
 const php=await runtime();try{
  for(const [file,name,body] of [
   ['ZFSMUsage.php','zfsmUsageProcess','function zfsmUsageProcess($tool,$args,$deadline){return zfsmTestProcess("zfs",$args);}'],
   ['ZFSMExplorer.php','zfsmExplorerCall','function zfsmExplorerCall($args){$GLOBALS["cleanup_helper_calls"][]=$args;return $GLOBALS["cleanup_helper_reply"]??["removed"=>true];}']
  ]){const path='/app/src/include/'+file,s=php.readFileAsText(path),at=s.indexOf('function '+name+'('),end=s.indexOf('\nfunction ',at+1);assert.ok(at>=0&&end>at);php.writeFile(path,s.slice(0,at)+body+'\n'+s.slice(end));}
  php.mkdir('/usr/sbin');php.writeFile('/usr/sbin/zfs','synthetic process boundary');
  php.writeFile('/app/archive-cleanup.php',await readFile('tests/archive-cleanup.php'));
  const r=await php.run({scriptPath:'/app/archive-cleanup.php'});console.log(r.text);assert.equal(r.errors,'',r.errors);assert.equal(r.exitCode,0,r.text);
 }finally{php.exit();}
});
