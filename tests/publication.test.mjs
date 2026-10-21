import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
test('publication detector catches synthetic private paths and commit trailers',()=>{const code="import importlib.util\nspec=importlib.util.spec_from_file_location('audit','tools/check-release.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nassert 'personal_home_path' in m.findings(b'/Users/' + b'example-person/Documents/report.txt')\nassert 'coauthor_trailer' in m.findings(b'Co-' + b'Authored-By: Example <example@example.invalid>')\nassert 'private_deny_list' in m.findings(b'synthetic private identifier',[b'private identifier'])\nassert not m.findings(b'ZFS Director synthetic example')\nassert m.approved_identity(b'author d1-m4ss <d1-m4ss@users.noreply.github.com> 1 +0000')\nassert not m.approved_identity(b'author Example <private@example.invalid> 1 +0000')\nassert not m.approved_identity(b'author Unexpected d1-m4ss <d1-m4ss@users.noreply.github.com> 1 +0000')\nprint('PASS')";assert.match(execFileSync('python3',['-B','-c',code],{encoding:'utf8'}),/PASS/);});
test('preview data is invented and has no imports from historical fixture or process APIs',async()=>{const code=await readFile('docs/preview/data.mjs','utf8');assert.doesNotMatch(code,/readFile|child_process|server-metadata|ssh|fetch\(/);assert.match(code,/Every value in this module is invented/);assert.match(await readFile('docs/preview/server.mjs','utf8'),/Read-only synthetic demonstration/);});
test('publication history accepts a clean follow-up and rejects an unrelated root',()=>{
 const code=`import importlib.util,pathlib,subprocess,tempfile
spec=importlib.util.spec_from_file_location('audit','tools/check-release.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as folder:
 m.ROOT=pathlib.Path(folder)
 def git(*args):return subprocess.check_output(['git',*args],cwd=folder,stderr=subprocess.PIPE)
 git('init','-q','-b','main');git('config','user.name','ZFS Director Maintainers');git('config','user.email','maintainers@zfs-director.invalid');git('config','core.hooksPath','/dev/null');git('config','commit.gpgsign','false')
 for value in ['initial synthetic content','follow-up synthetic content']:
  (m.ROOT/'example.txt').write_text(value);git('add','example.txt');git('commit','-qm',value)
 result=m.run([],True);assert result['pass'],result
 git('checkout','--orphan','unrelated');(m.ROOT/'example.txt').write_text('unrelated synthetic root');git('add','example.txt');git('commit','-qm','unrelated synthetic root')
 result=m.run([],True);assert not result['pass'],result
print('PASS')`;
 assert.match(execFileSync('python3',['-B','-c',code],{encoding:'utf8'}),/PASS/);
});
