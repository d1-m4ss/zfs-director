#!/usr/bin/env python3
"""Native proof: FAN_CREATE target FID verifies mkdir's identity, no handle-open."""
import ctypes, errno, json, os, pathlib, select, stat, struct

c=ctypes.CDLL(None,use_errno=True)
assert os.uname().sysname=='Linux' and os.geteuid()==0
root=pathlib.Path('/owner'); assert root.is_mount()
rootfd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)

def handle(fd):
    # Standard name_to_handle_at, not AT_HANDLE_FID: comparable openable handles.
    storage=ctypes.create_string_buffer(8+128); struct.pack_into('Ii',storage,0,128,0)
    mount=ctypes.c_int()
    result=c.name_to_handle_at(fd,b'',storage,ctypes.byref(mount),0x1000)
    assert result==0,(result,ctypes.get_errno())
    size,kind=struct.unpack_from('Ii',storage)
    assert 0<size<=128
    return (kind,storage.raw[8:8+size].hex())

def actor(fn):
    pid=os.fork()
    if pid==0:
        os.setgroups([]); os.setgid(100); os.setuid(99)
        try: fn(); os._exit(0)
        except BaseException: os._exit(1)
    _,status=os.waitpid(pid,0); assert status==0

def one(name,attack):
    fan=c.fanotify_init(1|2|0x200|0x400|0x800|0x1000,os.O_RDONLY|os.O_CLOEXEC)
    assert fan>=0,ctypes.get_errno()
    assert c.fanotify_mark(fan,1|8,ctypes.c_uint64(0x100|0x40000000|0x08000000),rootfd,b'.')==0,ctypes.get_errno()
    target=root/name; target.mkdir(0o700)
    created=os.stat(target).st_ino
    if attack:
        victim=root/(name+'-victim'); victim.mkdir(0o700)
        actor(lambda:(os.rename(target,root/(name+'-retained')),os.rename(victim,target)))
    assert select.select([fan],[],[],2)[0]
    data=os.read(fan,65536); os.close(fan)
    matching=[]; offset=0
    while offset<len(data):
        length,version,reserved,metalength,mask,eventfd,pid=struct.unpack_from('IBBHQii',data,offset)
        assert version==3 and metalength>=24 and length>=metalength and offset+length<=len(data)
        assert not(mask&0x4000),'queue overflow'
        records={}; pos=offset+metalength
        while pos<offset+length:
            kind,pad,infolen=struct.unpack_from('BBH',data,pos)
            assert infolen>=4 and pos+infolen<=offset+length and kind in (1,2)
            size,htype=struct.unpack_from('Ii',data,pos+12)
            assert size>0 and pos+20+size<=pos+infolen
            identity=(htype,data[pos+20:pos+20+size].hex())
            records[kind]=(identity,data[pos+20+size:pos+infolen])
            pos+=infolen
        assert pos==offset+length
        if pid==os.getpid() and mask==(0x100|0x40000000):
            assert set(records)=={1,2}
            parent,rawname=records[2]
            assert parent==handle(rootfd)
            if rawname.split(b'\0',1)[0]==name.encode(): matching.append(records[1][0])
        offset+=length
    assert len(matching)==1,matching
    opened=os.open(target,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    opened_stat=os.fstat(opened); current=handle(opened)
    accepted=(current==matching[0])
    assert accepted != attack,(accepted,attack)
    # Crucially, no journal or source mutation occurs until accepted.
    assert not os.listdir(opened)
    if accepted:
        journal=os.open('journal',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600,dir_fd=opened)
        os.close(journal)
    os.close(opened)
    return {'name':name,'attack':attack,'accepted':accepted,'created_ino':created,'opened_ino':opened_stat.st_ino,'target_handle':matching[0],'opened_handle':current,'status':'PASS'}

print(json.dumps({'kernel':os.uname().release,'results':[one('fan-clean',False),one('fan-swapped',True)]},sort_keys=True))
