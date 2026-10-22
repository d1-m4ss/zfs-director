#!/usr/bin/env python3
"""Full generated installer on an isolated temporary filesystem; never host install."""
import hashlib,json,os,re,shlex,subprocess,tempfile,tarfile
from pathlib import Path
assert Path('/.dockerenv').exists() and os.geteuid()==0
packages=list(Path('/stand/package').glob('zfs-director-*.tgz'));assert len(packages)==1
package=packages[0]
with tarfile.open(package) as tar: expected_release=json.load(tar.extractfile('zfs.master.ui/release.json'))
script=Path('/stand/package/install.sh').read_text()
registration=re.search(r'^registration=(.+)$',script,re.M)[1].removesuffix('.plg')
def translated_installer(root):
    # Only host-root boundaries change; native Unraid tests execute the complete
    # registration/post-hook lifecycle without any rewriting.
    helper=script.split('legacy_cleanup() {',1)[1].split('\n}',1)[0]
    out=script.replace(helper,'__LEGACY_HELPER__',1)
    for prefix in ['/boot/config/plugins','/usr/local/emhttp/plugins','/var/lock','/var/tmp']:
        out=out.replace(prefix,str(root)+prefix)
    (root/'var/lock').mkdir(parents=True,exist_ok=True)
    (root/'var/tmp').mkdir(parents=True,exist_ok=True,mode=0o700)
    helper=helper.replace('-- \"$1\" / ', '-- \"$1\" '+shlex.quote(str(root))+' ')
    return out.replace('__LEGACY_HELPER__',helper,1)
base=Path(tempfile.mkdtemp(prefix='director-install-'))
boot=base/'boot/config/plugins/zfs.master.ui';boot.mkdir(parents=True)
plugins=base/'usr/local/emhttp/plugins';live=plugins/'zfs.master.ui';(live/'scripts').mkdir(parents=True)
stop_log=base/'stopped';(live/'scripts/zfsm-worker.php').write_text('<?php file_put_contents('+json.dumps(str(stop_log))+',implode(" ",$argv));')
(live/'old-code').write_text('old code retained until all gates pass')
settings=boot/'zfs.master.ui.cfg';settings.write_bytes(b'[general]\nsanoid_integration=0\nlegacy=settings\n')
(boot/'jobs').mkdir();journal=boot/'jobs/job.json';journal.write_bytes(b'{"state":"completed","source":"retained"}')
(boot/'activation.sha256').write_text('old-package-hash\n')
expected={p:hashlib.sha256(p.read_bytes()).hexdigest() for p in [settings,journal]}
for relative,content in {'audit/2026-10-18.jsonl':b'{"operation":"retained"}\n','protection/config.json':b'{"version":1,"replications":{}}','encryption-mounts/100.json':b'{"phase":"restore_required"}','acl-backups/100.json':b'{"previous":"retained ACL"}',('../'+registration+'/protection.cron'):b'# Existing managed cron preserved\n','../buddybackup/sanoid.cron':b'*/15 * * * * external-sanoid --cron\n'}.items():
    retained=boot/relative;retained.parent.mkdir(parents=True,exist_ok=True);retained.write_bytes(content);expected[retained]=hashlib.sha256(content).hexdigest()
text=translated_installer(base)
def run():return subprocess.run(['bash','-c',text],capture_output=True,text=True)
root_before=os.stat('/')
missing=run();assert missing.returncode!=0 and not stop_log.exists() and (live/'old-code').is_file(),missing.stdout+missing.stderr
(boot/package.name).write_bytes(package.read_bytes())
settings.write_bytes(b'[general]\nsanoid_integration=1\nlegacy=settings\n')
enabled_bytes=settings.read_bytes()
with tarfile.open(package) as tar: gate=tar.extractfile('zfs.master.ui/scripts/zfsm-upgrade-preflight.php').read()
check=subprocess.run(['/usr/bin/php','--',str(boot),'install'],input=gate,capture_output=True)
assert check.returncode==0,check.stdout+check.stderr
assert settings.read_bytes()==enabled_bytes,'Installer rewrote enabled integration settings'
settings.write_bytes(b'[general]\nsanoid_integration=0\nlegacy=settings\n')

# A kernel without required fanotify must reject the real installer before
# stopping the old worker, taking its mutation lock, or replacing any code.
deny='''import ctypes,os,sys,platform
class F(ctypes.Structure):_fields_=[('code',ctypes.c_ushort),('jt',ctypes.c_ubyte),('jf',ctypes.c_ubyte),('k',ctypes.c_uint)]
class P(ctypes.Structure):_fields_=[('len',ctypes.c_ushort),('filter',ctypes.POINTER(F))]
number={'x86_64':300,'aarch64':262}[platform.machine()] if sys.argv[1]=='fanotify' else 444
f=(F*4)(F(0x20,0,0,0),F(0x15,0,1,number),F(0x06,0,0,0x50000|38),F(0x06,0,0,0x7fff0000));p=P(4,f);c=ctypes.CDLL(None,use_errno=True)
assert c.prctl(38,1,0,0,0)==0;assert c.prctl(22,2,ctypes.byref(p))==0
os.execvp(sys.argv[2],sys.argv[2:])'''
unsupported=subprocess.run(['python3','-c',deny,'fanotify','bash','-c',text],capture_output=True,text=True)
assert unsupported.returncode!=0 and not stop_log.exists() and (live/'old-code').is_file() and not (base/'var/lock/zfs.master.ui.lock').exists(),unsupported.stdout+unsupported.stderr
assert 'fanotify' in unsupported.stdout and 'unchanged' in unsupported.stdout,unsupported.stdout+unsupported.stderr
assert all(hashlib.sha256(p.read_bytes()).hexdigest()==sha for p,sha in expected.items())
installed=subprocess.run(['python3','-c',deny,'landlock','bash','-c',text],capture_output=True,text=True);assert installed.returncode==0,installed.stdout+installed.stderr
release=json.loads((live/'release.json').read_text());assert release==expected_release
assert not (live/'old-code').exists() and stop_log.read_text().endswith('--stop')
assert all(hashlib.sha256(p.read_bytes()).hexdigest()==sha for p,sha in expected.items())
assert not (live/'scripts/zfsm-convert.pl').exists() and not (live/'include/ZFSMConversionPinned.php').exists()
assert (boot/'activation.sha256').read_text()=='old-package-hash\n'
assert (base/'var/tmp/zfs.master.ui/jobs/stop').is_file()
assert json.loads((base/'var/tmp/zfs.master.ui/jobs/install-pending.json').read_text())['hold_recovery'] is False
root_after=os.stat('/');assert (root_before.st_dev,root_before.st_ino,root_before.st_mode,root_before.st_uid,root_before.st_gid)==(root_after.st_dev,root_after.st_ino,root_after.st_mode,root_after.st_uid,root_after.st_gid)
print(json.dumps({'status':'PASS','checks':['Missing persistent package fails before stopping worker or replacing code','Unsupported fanotify kernel fails before stopping worker, lock or code/state changes','Generated installer works without Landlock and validates all PHP/Perl files','Settings jobs audit protection cron encryption and ACL backup bytes retained','Rejected helper excluded','Staging retains maintenance until native Plugin Manager registration and post-hook','Container root identity/mode/owner unchanged'],'source':release},indent=2))

new_job=boot/'jobs/20261018-190000-aaaaaaaaaaaa.json';new_job.write_bytes(b'{"schema":4,"state":"recovery_required","new":"retained"}')
expected[new_job]=hashlib.sha256(new_job.read_bytes()).hexdigest()
previous=list(plugins.glob('.zfs-director-previous-*'));assert len(previous)==1
retained_candidate=plugins/'rc4-retained-candidate';live.rename(retained_candidate);previous[0].rename(live)
assert (live/'old-code').is_file() and all(hashlib.sha256(p.read_bytes()).hexdigest()==sha for p,sha in expected.items())
print(json.dumps({'rollback':'PASS','checks':['Code-only previous directory restored','Newer schema4 journal and existing persistent bytes retained','External/managed cron bytes unchanged','Legacy activation file unchanged; rollback preserves persistent state']}))
# The same PLG runs on Unraid boot. Reconstruct installed code automatically
# with no runtime code; mock only the worker launch boundary in this fixture.
boot_cases=[
    ('enabled','1',{'schema':4,'state':'completed'},False),
    ('queued','0',{'schema':4,'state':'queued'},True),
    ('running','0',{'schema':4,'state':'running'},True),
    ('held-restore','0',{'schema':2,'type':'restore','state':'completed','hold_owned':True},True),
    ('held-archive','0',{'schema':2,'type':'archive','state':'completed','hold_owned':True,'archive_removed':True},True),
    ('expired-archive','0',{'schema':2,'type':'archive','state':'completed','hold_owned':False,'archive_removed':False,'expires':1},True),
    ('future-archive','0',{'schema':2,'type':'archive','state':'completed','hold_owned':False,'archive_removed':False,'expires':4102444800,'cleanup_retry_after':4102444800},True),
    ('cleaned-archive','0',{'schema':2,'type':'archive','state':'completed','hold_owned':False,'archive_removed':True,'expires':1},False),
    ('released-restore','0',{'schema':2,'type':'restore','state':'completed','hold_owned':False},False),
]
for label,flag,job,hold in boot_cases:
    case=base/('boot-'+label);persist=case/'boot/config/plugins/zfs.master.ui';persist.mkdir(parents=True);(persist/'jobs').mkdir();plugs=case/'usr/local/emhttp/plugins';plugs.mkdir(parents=True);runtime=case/'var/tmp'
    (persist/'zfs.master.ui.cfg').write_text('[general]\nsanoid_integration='+flag+'\n');(persist/'installed.sha256').write_text(hashlib.sha256(package.read_bytes()).hexdigest()+'\n');(persist/package.name).write_bytes(package.read_bytes());j=persist/'jobs/20261018-190001-bbbbbbbbbbbb.json';j.write_text(json.dumps(job));original={p:p.read_bytes()for p in [persist/'zfs.master.ui.cfg',j,persist/'installed.sha256']}
    translated=translated_installer(case)
    r=subprocess.run(['python3','-c',deny,'landlock','bash','-c',translated],capture_output=True,text=True)
    assert r.returncode==0 and (plugs/'zfs.master.ui/release.json').is_file(),label+': accepted boot did not reconstruct GUI: '+r.stdout+r.stderr
    assert all(p.read_bytes()==v for p,v in original.items()),label+': boot rewrote persistent settings or journal'
    assert (runtime/'zfs.master.ui/jobs/stop').is_file(),label+': staging released maintenance before registration'
    assert json.loads((runtime/'zfs.master.ui/jobs/install-pending.json').read_text())['hold_recovery'] is hold,label+': pending recovery instruction differs'
    if flag=='0':
        upgrade=subprocess.run(['/usr/bin/php',str(plugs/'zfs.master.ui/scripts/zfsm-upgrade-preflight.php'),str(persist)],capture_output=True,text=True)
        assert upgrade.returncode==(1 if hold else 0),label+': upgrade did not enforce the same cleanup gate'
        assert all(p.read_bytes()==v for p,v in original.items()),label+': upgrade preflight rewrote persistent state'
print(json.dumps({'accepted_boot_reconstruction':'PASS','cases':[case[0] for case in boot_cases],'actual_reboot':False}))
