#!/usr/bin/env python3
"""Replay captured Unraid update_cron inside disposable Linux, never a daemon."""
import hashlib,json,os,pathlib,subprocess,tempfile,shutil
assert pathlib.Path('/.dockerenv').exists()
root=pathlib.Path(tempfile.mkdtemp(prefix='rc4-cron-'));boot=root/'boot/config/plugins';registry=root/'var/log/plugins';runtime=root/'runtime';tools=root/'tools'
for p in [boot,registry,runtime,tools]:p.mkdir(parents=True,exist_ok=True)
# Read the production namespace resolver against a real Unraid registry layout.
for p in ['/boot/config/plugins/zfs.master.ui','/var/log/plugins']:pathlib.Path(p).mkdir(parents=True,exist_ok=True)
manifest=pathlib.Path('/boot/config/plugins/zfs.master.ui.local.plg');manifest.write_text('<PLUGIN name="zfs.master.ui"/>');manifest.chmod(0o600);os.symlink(manifest,'/var/log/plugins/zfs.master.ui.local.plg')
code="require '/stand/src/backend/ZFSMOperations.php';$GLOBALS['plugin_config']='/boot/config/plugins/zfs.master.ui/director.cfg';$s=['policies'=>['abc'=>['enabled'=>true,'schedule'=>'*/5 * * * *']],'replications'=>[]];echo json_encode(['file'=>zfsmProtectionCronFile(),'text'=>zfsmProtectionCronText($s)]);"
p=subprocess.run(['php','-r',code],capture_output=True,text=True);assert p.returncode==0,p.stderr;managed=json.loads(p.stdout);assert managed['file']=='/boot/config/plugins/zfs.master.ui.local/protection.cron'
namespace=pathlib.Path(managed['file']).parent.name;(boot/namespace).mkdir();(boot/namespace/'protection.cron').write_text(managed['text']);(boot/'dynamix').mkdir();(boot/'dynamix/native.cron').write_text('0 1 * * * native-job\n');(boot/'buddybackup').mkdir();foreign='*/15 * * * * sanoid --configdir=/boot/config/plugins/buddybackup --cron\n';(boot/'buddybackup/sanoid.cron').write_text(foreign)
for name in [namespace,'buddybackup']:(boot/(name+'.plg')).write_text('<PLUGIN/>');os.symlink(boot/(name+'.plg'),registry/(name+'.plg'))
stub=tools/'crontab';stub.write_text('#!/usr/bin/python3\nimport os,sys,pathlib\np=pathlib.Path(os.environ["RC4_CRONTAB"])\nif sys.argv[-1]=="-":p.write_text(sys.stdin.read())\nelif sys.argv[-1]=="-d":p.unlink(missing_ok=True)\nelse:raise SystemExit(2)\n');stub.chmod(0o755)
source=pathlib.Path('/stand/native-source/update_cron').read_text();script=root/'update_cron';script.write_text(source.replace('/boot/config/plugins',str(boot)).replace('/var/log/plugins',str(registry)));env=dict(os.environ,PATH=str(tools)+':'+os.environ['PATH'],RC4_CRONTAB=str(runtime/'root'))
def collect():
 r=subprocess.run(['/bin/bash',str(script)],env=env,capture_output=True,text=True);assert r.returncode==0,r.stderr;return (runtime/'root').read_bytes()
first=collect();assert first.count(b'zfsm-protection.php')==1;assert foreign.encode()in first
second=collect();assert first==second,'Repeated update_cron appended duplicates'
(runtime/'root').unlink()
for p in registry.iterdir():p.unlink()
for name in [namespace,'buddybackup']:os.symlink(boot/(name+'.plg'),registry/(name+'.plg'))
third=collect();assert third==first,'Persistent sources did not reconstruct after runtime loss';assert (boot/'buddybackup/sanoid.cron').read_text()==foreign
print(json.dumps({'status':'PASS','collector_source_sha256':hashlib.sha256(source.encode()).hexdigest(),'checks':['Actual registered .local namespace','Captured collector replay, only root paths and crontab IO redirected','Repeated reconstruction produces one Director line','Runtime spool/registry loss reconstructs from persistent plugin sources','External cron bytes retained'],'actual_reboot':False,'real_cron_enabled':False,'host_binds':False},indent=2))
