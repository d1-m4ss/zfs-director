#!/usr/bin/env python3
"""Real mount API regressions; run only in a disposable privileged container."""
import ctypes, hashlib, json, os, pathlib, select, stat, subprocess, tempfile

assert pathlib.Path('/.dockerenv').exists(), 'Disposable Docker container required'
HELPER='/stand/src/scripts/zfsm-publish.pl'
libc=ctypes.CDLL(None,use_errno=True)
SCENARIOS=0

def ident(p):
    s=os.stat(p); return {'dev':str(s.st_dev),'ino':str(s.st_ino)}

def mount(p):
    assert libc.mount(b'tmpfs',os.fsencode(p),b'tmpfs',0,b'size=8m')==0,ctypes.get_errno()

def unmount(p):
    assert libc.umount2(os.fsencode(p),2)==0,(p,ctypes.get_errno())

def read(p):
    assert select.select([p.stdout],[],[],5)[0], 'helper protocol timed out'
    line=p.stdout.readline()
    assert line, ('helper exited',p.poll(),p.stderr.read())
    return json.loads(line)

def send(p,obj):
    p.stdin.write(json.dumps(obj)+'\n');p.stdin.flush();return read(p)

def start(args,wrapper=None):
    command=['perl',HELPER] if wrapper is None else ['perl','-e',wrapper,HELPER]
    p=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    return p,send(p,args)

def finish(p):
    p.stdin.close();p.wait(timeout=5)
    return p.returncode

def fixture(base,name):
    global SCENARIOS
    SCENARIOS+=1
    b=base/name;b.mkdir(mode=0o700)
    owner=b/'owner';owner.mkdir();mount(owner);os.chown(owner,99,100);os.chmod(owner,0o777)
    source=owner/'selected';source.mkdir();(source/'original').write_bytes(b'original retained')
    stage=b/'stage';stage.mkdir(mode=0o700)
    target=stage/'new';target.mkdir();mount(target);os.chown(target,99,100);os.chmod(target,0o777)
    (target/'copied').write_bytes(b'copied contents')
    args={'root':str(owner),'root_identity':ident(owner),'path':'selected','identity':ident(source),'target':str(target),'target_identity':ident(target),'recovery':'retained','id':name}
    return owner,source,target,args

def claim_for(source):
    claim=source.parent/'claim';claim.mkdir(mode=0o700)
    journal=claim/'journal.jsonl'
    journal.write_text(''.join(json.dumps(row)+'\n' for row in [
        {'event':'captured','identity':ident(source.parent/'retained')},
        {'event':'published','destination':'retained','identity':ident(source.parent/'retained')}]))
    journal.chmod(0o600)
    return dict(path=str(claim),**ident(claim))

def reserve(p,source):
    source.rename(source.parent/'retained')
    r=send(p,{'action':'reserve','claim':claim_for(source)});assert r['phase']=='reserved',r
    assert stat.S_IMODE(os.stat(source).st_mode)==0o700 and os.stat(source).st_uid==0
    return r

def fail(r):
    assert not r.get('ok',False) and r.get('error'),r

def run():
    global SCENARIOS
    # This assertion is the initial RED boundary: no placeholder or publication
    # helper existed before this suite was written.
    assert pathlib.Path(HELPER).is_file(), 'missing descriptor-bound publication helper'
    p,r=start({'op':'probe'});assert r=={'ok':True,'phase':'probe'},r;assert finish(p)==0;SCENARIOS+=1
    with tempfile.TemporaryDirectory(prefix='publish-',dir='/var/tmp',ignore_cleanup_errors=True) as temp:
        base=pathlib.Path(temp);outside=base/'outside';outside.mkdir();(outside/'sentinel').write_bytes(b'outside unchanged')
        sent=lambda:(stat.S_IMODE(os.stat('/').st_mode),os.stat('/').st_uid,stat.S_IMODE(outside.stat().st_mode),hashlib.sha256((outside/'sentinel').read_bytes()).hexdigest())
        before=sent()
        owner,source,target,args=fixture(base,'success')
        p,r=start(args);assert r['phase']=='prepared',r
        reserve(p,source);expected=ident(target);unmount(target)
        r=send(p,{'action':'publish'});assert r['phase']=='published' and r['ok'] and r['identity']==expected,r
        assert finish(p)==0
        assert ident(source)==expected and (source/'copied').read_bytes()==b'copied contents'
        assert (owner/'retained'/'original').read_bytes()==b'original retained'
        assert (os.stat(source).st_uid,stat.S_IMODE(os.stat(source).st_mode))==(99,0o777)
        unmount(source);unmount(owner)
        for name,change in [('wrong-root',lambda a:a['root_identity'].update(ino='999999')),('wrong-target',lambda a:a['target_identity'].update(ino='999999')),('wrong-source',lambda a:a['identity'].update(ino='999999')),('nested-name',lambda a:a.update(path='a/b')),('root-slash',lambda a:a.update(root='/')),('insecure-stage',None),('symlink-target',None),('plain-target',None)]:
            owner,source,target,args=fixture(base,name)
            if change:change(args)
            if name=='insecure-stage':os.chmod(target.parent,0o777)
            if name=='symlink-target':
                link=target.parent/'link';link.symlink_to(target);args['target']=str(link)
            if name=='plain-target':unmount(target)
            p,r=start(args);fail(r);assert finish(p)!=0
            assert (source/'original').read_bytes()==b'original retained'
            if name!='plain-target':unmount(target)
            unmount(owner)
        # A public mkdir/open cannot authenticate a newly created inode under
        # a 0777 owner. Publication requires a private authenticated claim FD.
        owner,source,target,args=fixture(base,'no-claim');p,r=start(args);assert r['phase']=='prepared',r
        source.rename(owner/'retained');r=send(p,{'action':'reserve'});fail(r);assert finish(p)!=0
        assert not source.exists();unmount(target);unmount(owner)
        # A bind of the owning filesystem is not a new destination dataset.
        owner,source,target,args=fixture(base,'same-filesystem');unmount(target)
        assert libc.mount(os.fsencode(owner),os.fsencode(target),None,4096,None)==0
        args['target_identity']=ident(target);p,r=start(args);fail(r);assert finish(p)!=0
        unmount(target);unmount(owner)
        # Source symlinks and nested mounts in target are never cloned.
        for problem in ['source-link','target-nested']:
            owner,source,target,args=fixture(base,problem)
            if problem=='source-link':
                source.rename(owner/'retained');source.symlink_to(outside)
            else:
                nested=target/'nested';nested.mkdir();mount(nested)
            p,r=start(args);fail(r);assert finish(p)!=0
            if problem=='target-nested':unmount(target/'nested')
            unmount(target);unmount(owner)
        # Existing destination is never covered, including a symlink.
        for name,link in [('exists',False),('symlink',True)]:
            owner,source,target,args=fixture(base,name);p,r=start(args);assert r['phase']=='prepared',r
            source.rename(owner/'retained')
            if link:source.symlink_to(outside)
            else:
                source.mkdir();(source/'replacement').write_bytes(b'untouched')
            r=send(p,{'action':'reserve','claim':claim_for(source)});fail(r);assert finish(p)!=0
            assert not (outside/'copied').exists()
            if not link:assert (source/'replacement').read_bytes()==b'untouched'
            unmount(target);unmount(owner)
        # A claim identity and private authenticated journal are mandatory.
        for problem in ['identity','writable','journal','symlink']:
            owner,source,target,args=fixture(base,'claim-'+problem);p,r=start(args);assert r['phase']=='prepared',r
            source.rename(owner/'retained');claim=claim_for(source)
            if problem=='identity':claim['ino']='999999'
            if problem=='writable':os.chmod(claim['path'],0o777)
            if problem=='journal':(pathlib.Path(claim['path'])/'journal.jsonl').write_text('{}\n')
            if problem=='symlink':
                link=owner/'claim-link';link.symlink_to(claim['path']);claim['path']=str(link)
            r=send(p,{'action':'reserve','claim':claim});fail(r);assert finish(p)!=0
            assert not source.exists() and (owner/'retained'/'original').is_file()
            unmount(target);unmount(owner)
        # At each protocol boundary EOF merely closes detached descriptors.
        for phase in ['prepared','reserved']:
            owner,source,target,args=fixture(base,'eof-'+phase);p,r=start(args);assert r['phase']=='prepared',r
            if phase=='reserved':reserve(p,source)
            assert finish(p)!=0
            assert (target/'copied').read_bytes()==b'copied contents'
            if phase=='prepared':assert (source/'original').is_file()
            else:assert not list(source.iterdir()) and (owner/'retained'/'original').is_file()
            unmount(target);unmount(owner)
        # SIGTERM before publication also performs no attach or cleanup.
        for phase in ['prepared','reserved']:
            owner,source,target,args=fixture(base,'kill-'+phase);p,r=start(args);assert r['phase']=='prepared',r
            if phase=='reserved':reserve(p,source)
            p.terminate();assert finish(p)<0
            assert (target/'copied').read_bytes()==b'copied contents'
            if phase=='reserved':assert not list(source.iterdir()) and (owner/'retained'/'original').is_file()
            else:assert (source/'original').is_file()
            unmount(target);unmount(owner)
        # A hostile parent owner may rename the empty 0700 placeholder. The
        # helper refuses the replacement and preserves both copied/source data.
        owner,source,target,args=fixture(base,'rename');p,r=start(args);assert r['phase']=='prepared',r
        reserve(p,source);held=owner/'held';source.rename(held);source.mkdir();(source/'replacement').write_bytes(b'untouched')
        unmount(target);r=send(p,{'action':'publish'});fail(r);assert finish(p)!=0
        assert (source/'replacement').read_bytes()==b'untouched' and not list(held.iterdir())
        assert (owner/'retained'/'original').is_file();unmount(owner)
        # Interpose only in this test process, immediately around the real
        # move_mount call. There are no environment hooks in the worker.
        owner,source,target,args=fixture(base,'late-rename')
        wrapper=r'''do shift(@ARGV) or die $@||$!;
my $original=\&main::attach_mount;
{ no warnings 'redefine'; *main::attach_mount=sub {
    my @args=@_; my $child=fork(); die 'fork' unless defined $child;
    if (!$child) { POSIX::setgid(100); POSIX::setuid(99);
        rename($ENV{RACE_SOURCE},$ENV{RACE_HELD}) or die 'rename';
        mkdir($ENV{RACE_SOURCE},0777) or die 'replacement';
        open(my $f,'>',$ENV{RACE_SOURCE}.'/replacement') or die 'file';print $f 'untouched';close($f);POSIX::_exit(0);
    }
    waitpid($child,0);die 'race child failed' if $?; $original->(@args);
}; }
eval { main::main();1 } or do { main::emit({ok=>JSON::PP::false(),error=>$@,published=>JSON::PP::true()});exit 1; };'''
        # Environment belongs to the test-only wrapper, never production logic.
        os.chmod(base,0o755);os.chmod(owner.parent,0o755)
        os.environ['RACE_SOURCE']=str(source);os.environ['RACE_HELD']=str(owner/'held')
        p,r=start(args,wrapper);assert r['phase']=='prepared',r
        reserve(p,source);unmount(target);r=send(p,{'action':'publish'});fail(r)
        assert r.get('published') is True,r
        assert finish(p)!=0 and (source/'replacement').read_bytes()==b'untouched'
        assert not (source/'copied').exists() and (owner/'held'/'copied').read_bytes()==b'copied contents'
        assert (owner/'retained'/'original').is_file()
        unmount(owner/'held');unmount(owner)
        # A replacement owner mount is refused after prepare.
        owner,source,target,args=fixture(base,'owner-replaced');p,r=start(args);assert r['phase']=='prepared',r
        source.rename(owner/'retained');mount(owner)
        r=send(p,{'action':'reserve'});fail(r);assert finish(p)!=0 and not list(owner.iterdir())
        unmount(owner);assert (owner/'retained'/'original').is_file();unmount(target);unmount(owner)
        # Mounting over a reserved placeholder cannot make the worker attach
        # onto that new mount; NO_XDEV rejects it.
        owner,source,target,args=fixture(base,'nested-placeholder');p,r=start(args);assert r['phase']=='prepared',r
        reserve(p,source);mount(source);(source/'replacement').write_bytes(b'untouched')
        unmount(target);r=send(p,{'action':'publish'});fail(r);assert finish(p)!=0
        assert (source/'replacement').read_bytes()==b'untouched';unmount(source);unmount(owner)
        assert sent()==before
    print(json.dumps({'ok':True,'suite':'conversion-publish','mount_api':'open_tree/move_mount','scenarios':SCENARIOS,'arch':os.uname().machine,'kernel':os.uname().release}))

run()
