#!/usr/bin/env python3
"""Disposable-container-only boundary design probes, never a product helper."""
import errno, json, os, pathlib, stat

OWNER=pathlib.Path('/owner'); OUTSIDE=pathlib.Path('/outside')
assert os.geteuid()==0 and os.uname().sysname=='Linux'
assert OWNER.is_mount() and OUTSIDE.is_mount()
RESULTS=[]

def ident(p):
    s=os.stat(p); return [s.st_dev,s.st_ino]

def actor(fn):
    read,write=os.pipe(); pid=os.fork()
    if pid==0:
        os.close(read); os.setgroups([]); os.setgid(100); os.setuid(99)
        try: value=fn()
        except BaseException as e: value={'exception':str(e),'errno':getattr(e,'errno',None)}
        os.write(write,json.dumps(value).encode()); os._exit(0)
    os.close(write); data=os.read(read,65536); os.close(read)
    _,status=os.waitpid(pid,0); assert status==0
    return json.loads(data)

def public(p):
    p.mkdir(); p.chmod(0o777); os.chown(p,99,100)

# A mount-root is qualitatively different from an arbitrary 0777 subtree.
public(OWNER/'subtree'); (OWNER/'subtree'/'selected').mkdir()
outside_move=actor(lambda:(os.rename(OWNER/'subtree',OUTSIDE/'escaped'),True)[1])
assert outside_move['errno']==errno.EXDEV, outside_move
RESULTS.append({'name':'full-filesystem-boundary-cross-fs-rename','errno':outside_move['errno'],'status':'PASS'})

# A root-owned0700 empty directory is renameable by an ordinary writer of its
# nonsticky0777 parent; its properties do not prove the mkdir-created identity.
created=OWNER/'.zfsm-mutation-known'; victim=OWNER/'unrelated-root-private'
created.mkdir(0o700); victim.mkdir(0o700)
created_identity=ident(created); victim_identity=ident(victim)
swap=actor(lambda:(os.rename(created,OWNER/'parked-new-container'),os.rename(victim,created),True)[2])
assert swap is True, swap
fd=os.open(created,os.O_RDONLY|os.O_DIRECTORY); s=os.fstat(fd)
assert s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o700 and os.listdir(fd)==[]
assert [s.st_dev,s.st_ino]==victim_identity and victim_identity!=created_identity
journal=os.open('journal.jsonl',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600,dir_fd=fd)
os.write(journal,b'{"event":"victim-modified"}\n'); os.close(journal)
assert (created/'journal.jsonl').read_text().endswith('\n')
RESULTS.append({'name':'mkdir-open-root0700-empty-substitution','status':'PASS','attack':'accepted-victim-dir-and-wrote-journal','created_identity':created_identity,'opened_identity':victim_identity})

# Preopened selected and child descriptors retain lookup access, but DAC is
# checked against each current rename parent, including an already-open FD.
public(OWNER/'selected'); public(OWNER/'selected'/'nested')
(OWNER/'selected'/'nested'/'sentinel').write_text('keep')
selected_fd=os.open(OWNER/'selected',os.O_RDONLY|os.O_DIRECTORY)
nested_fd=os.open(OWNER/'selected'/'nested',os.O_RDONLY|os.O_DIRECTORY)
private=OWNER/'trusted-private'; private.mkdir(0o700)
private_fd=os.open(private,os.O_RDONLY|os.O_DIRECTORY)
os.rename('selected','root',src_dir_fd=os.open(OWNER,os.O_RDONLY|os.O_DIRECTORY),dst_dir_fd=private_fd)
escape=actor(lambda:(os.rename('root','escaped-root',src_dir_fd=private_fd,dst_dir_fd=os.open(OWNER,os.O_RDONLY|os.O_DIRECTORY)),True)[1])
assert escape['errno']==errno.EACCES,escape
descendant_escape=actor(lambda:(os.rename('nested','escaped-nested',src_dir_fd=selected_fd,dst_dir_fd=os.open(OWNER,os.O_RDONLY|os.O_DIRECTORY)),True)[1])
assert descendant_escape is True,descendant_escape
assert pathlib.Path(f'/proc/self/fd/{nested_fd}/sentinel').read_text()=='keep'
RESULTS.append({'name':'preopened-child-can-escape-before-child-capture','status':'PASS','root_escape_errno':escape['errno'],'nested_escape_succeeds':True})

# Capture the child first: even the original child's directory descriptor can
# no longer be used to move the directory itself out of its root0700 parent.
os.rename(OWNER/'escaped-nested',private/'child')
after_capture=actor(lambda:(os.rename('child','escaped-again',src_dir_fd=private_fd,dst_dir_fd=os.open(OWNER,os.O_RDONLY|os.O_DIRECTORY)),True)[1])
assert after_capture['errno']==errno.EACCES,after_capture
RESULTS.append({'name':'capture-each-child-protects-pinned-recursive-root','status':'PASS','errno':after_capture['errno']})

# A bind alias to the same underlying filesystem has a different mount object;
# rename between aliases is refused even though st_dev matches.
import subprocess
alias=pathlib.Path('/alias'); alias.mkdir()
subprocess.run(['mount','--bind',str(OWNER),str(alias)],check=True)
public(OWNER/'alias-source')
alias_move=actor(lambda:(os.rename(OWNER/'alias-source',alias/'alias-destination'),True)[1])
assert alias_move['errno']==errno.EXDEV,alias_move
RESULTS.append({'name':'same-filesystem-bind-alias-rename','status':'PASS','errno':alias_move['errno'],'same_st_dev':os.stat(OWNER).st_dev==os.stat(alias).st_dev})
print(json.dumps({'kernel':os.uname().release,'actor_uid':99,'results':RESULTS},sort_keys=True))
