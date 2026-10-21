#!/usr/bin/env python3
"""Run cleanup cases only on new children of the retained isolated file-backed VM pool."""
import importlib.util, pathlib, tempfile, subprocess, os, shutil, unittest, time
BASE=pathlib.Path('/var/lib/zfs-director-native-20261018')
POOL='director_it_1018'
if not (BASE/'ISOLATED-TEST-ONLY').is_file():raise RuntimeError('Missing isolated VM marker')
status=subprocess.check_output(['zpool','status','-P',POOL],text=True)
if str(BASE/(POOL+'.img')) not in status:raise RuntimeError('Wrong pool backing')
spec=importlib.util.spec_from_file_location('cleanup_tests',str(pathlib.Path(__file__).with_name('mutation-cleanup.py')))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.m.HELPER=str(pathlib.Path(__file__).resolve().parents[2]/'src/scripts/zfsm-directory.pl')
class ZFSCleanup(m.MutationCleanup):
    def setUp(self):
        self.base=pathlib.Path(tempfile.mkdtemp(prefix='cleanup-native-',dir=BASE));self.root=self.base/'dataset'
        self.dataset=POOL+'/cleanup_'+str(time.time_ns())
        subprocess.run(['zfs','create','-o','mountpoint='+str(self.root),self.dataset],check=True)
        self.guid=subprocess.check_output(['zfs','get','-H','-o','value','guid',self.dataset],text=True).strip()
        self.root.chmod(0o777);self.source=self.root/'selected';self.source.mkdir(mode=0o777);self.source.chmod(0o777);os.chown(self.source,99,100)
        self.outside=self.base/'outside';self.outside.mkdir(mode=0o777);self.outside.chmod(0o777);(self.outside/'sentinel').write_text('outside must survive')
    def tearDown(self):
        # Destroy only this fixture with unchanged GUID; no recursive/force flags.
        actual=subprocess.check_output(['zfs','get','-H','-o','value','guid',self.dataset],text=True).strip()
        if actual!=self.guid:raise RuntimeError('Fixture identity changed; retained for inspection')
        subprocess.run(['zfs','destroy',self.dataset],check=True)
        shutil.rmtree(self.base)
if __name__=='__main__':unittest.main()
