#!/usr/bin/env python3
from pathlib import Path
import json
root=Path(__file__).resolve().parents[2];base=1767225600
names=['data','projects','projects/app','projects/design','projects/research','photos','photos/originals','photos/previews','media','media/music','media/video','backups','backups/laptop','backups/desktop','archives','scratch','vm-images','secure','home']
count=0
def node(name):
 global count
 count+=1
 return dict(name=name,type='filesystem',guid=str(8000000000+count),used=8*1024**3,available=3*1024**4,referenced=4*1024**3,encryption='off',keystatus='none',mounted='yes',mountpoint='/mnt/'+name,compression='lz4',compressratio=142,usedbysnapshots=512*1024**2,quota=0,recordsize=131072,atime='off',xattr='sa',primarycache='all',readonly='off',casesensitivity='sensitive',sync='standard',creation=base,encryptionroot='none',keyformat='none',origin='-',child={},directories=[],snapshots=[],total_snapshots=0,_directory_identities={})
parent=node('cache');nodes={'cache':parent}
for i,n in enumerate(names):
 full='cache/'+n;nodes[full]=node(full);nodes[full.rsplit('/',1)[0]]['child'][full]=nodes[full]
 if i<15:nodes[full]['snapshots']=[dict(name=full+'@daily-demo',guid=str(9000000000+i),used=100*1024**2,referenced=4*1024**3,written=1024,creation=base+3600,defer_destroy='off',userrefs=0)]
parent['used']=3*1024**4;parent['usedbydataset']=8*1024**3;parent['usedbychildren']=3*1024**4-8*1024**3;parent['total_snapshots']=15
rows=[dict(name='cache',state='ONLINE',read=0,write=0,cksum=0,depth=0,section='data',note=''),dict(name='mirror-0',state='ONLINE',read=0,write=0,cksum=0,depth=1,section='data',note='')]+[dict(name='demo-disk-'+str(i),state='ONLINE',read=0,write=0,cksum=0,depth=2,section='data',note='')for i in [1,2]]
status='  pool: cache\n state: ONLINE\n  scan: scrub repaired 0B with 0 errors on Thu Jan 1 12:00:00 2026\nconfig:\n\n        NAME             STATE     READ WRITE CKSUM\n        cache            ONLINE       0     0     0\n          mirror-0       ONLINE       0     0     0\n            demo-disk-1  ONLINE       0     0     0\n            demo-disk-2  ONLINE       0     0     0\n\nerrors: No known data errors\n'
pool={'Pool':'cache','Health':'ONLINE','Name':'cache','Size':8*1024**4,'MountPoint':'/mnt/cache','Refer':8*1024**3,'Used':3*1024**4,'Free':5*1024**4,'Snapshots':15,'Origin':'-'}
info=dict(name='cache',size=8*1024**4,alloc=3*1024**4,free=5*1024**4,ckpoint='-',expandsz='-',frag='3%',cap='37%',dedup='1.00x',health='ONLINE',altroot='-',depth=0,section='data')
diagnostic=dict(pool='cache',collected_at='2026-01-01T12:00:00+00:00',health='ONLINE',severity='ok',reasons=[],status=dict(text=status,rows=rows,state='ONLINE',scan='scrub repaired 0B with 0 errors',errors='No known data errors',status='',action=''),information=dict(text='NAME SIZE ALLOC FREE HEALTH\ncache 8T 3T 5T ONLINE',columns=['NAME','SIZE','ALLOC','FREE','CKPOINT','EXPANDSZ','FRAG','CAP','DEDUP','HEALTH','ALTROOT'],rows=[info]),scan=dict(state='finished',kind='scrub',text='scrub repaired 0B with 0 errors',percent=None,scanned=None,scan_total=None,scan_rate=None,issued=None,issue_total=None,issue_rate=None,eta=None,repaired='0B',errors=0),maintenance=dict(owner='Unraid native schedule',schedule='Monthly',next_run=None,timezone='UTC',status='read-only demo',settings_url='/Settings/Scheduler'),command_errors=[])
fixture={'inventory':{'op':'getAll','data':{'pools':{'cache':pool},'devices':{'cache':'mirror-0\ndemo-disk-1\ndemo-disk-2'},'datasets':{'cache':parent},'errors':{}}},'config':dict(refresh_interval=0,lazy_load=0,sanoid_integration=0,destructive_mode=1,dataset_exclusion='',snap_max_days_alert=30,snap_prefix='',snap_pattern='Y-m-d-His',directory_listing=[]),'diagnostic':diagnostic,'provenance':{'synthetic':True,'generator':'tests/gui/generate-fixture.py','collected_at':'2026-01-01T12:00:00Z','description':'Entirely generated. No server inventory or user data is read.'}}
(root/'tests/gui/fixtures').mkdir(exist_ok=True,parents=True);(root/'tests/gui/fixtures/server-metadata.json').write_text(json.dumps(fixture,indent=2)+'\n')
