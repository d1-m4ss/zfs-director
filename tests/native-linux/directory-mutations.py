#!/usr/bin/env python3
"""Native mutation probes. Run only inside the disposable Linux test container."""
import ctypes, errno, json, os, pathlib, resource, select, shutil, socket, stat, struct, subprocess, tempfile, unittest

HELPER = '/stand/src/scripts/zfsm-directory.pl'

def identity(path):
    st = os.stat(path, follow_symlinks=False)
    return {'dev': str(st.st_dev), 'ino': str(st.st_ino)}

class DirectoryMutations(unittest.TestCase):
    def setUp(self):
        self.base = pathlib.Path(tempfile.mkdtemp(prefix='directory-', dir='/test'))
        self.root = self.base / 'dataset'
        self.root.mkdir(mode=0o777)
        subprocess.run(['mount','-t','tmpfs','-o','size=256m,mode=0777','tmpfs',str(self.root)],check=True)
        os.chmod(self.root, 0o777)
        self.source = self.root / 'selected'
        self.source.mkdir(mode=0o777)
        os.chmod(self.source, 0o777)
        os.chown(self.source, 99, 100)
        self.outside = self.base / 'outside'
        self.outside.mkdir(mode=0o777)
        os.chmod(self.outside,0o777)
        (self.outside / 'sentinel').write_text('outside must survive')
    def tearDown(self):
        subprocess.run(['umount',str(self.root)],check=True)
        shutil.rmtree(self.base)
    def request(self, **extra):
        value = dict(op='delete', root=str(self.root), root_identity=identity(self.root),
                     path='selected', identity=identity(self.source), recursive=False)
        value.update(extra)
        return value
    def run_helper(self, request, preexec_fn=None):
        proc = subprocess.run(['perl', HELPER], input=json.dumps(request), text=True, capture_output=True, preexec_fn=preexec_fn)
        rows = [json.loads(row) for row in proc.stdout.splitlines() if row.strip()]
        return proc, rows
    def run_interleaved(self, request, wrapper, callback):
        # Override a real abstraction only in the test process. No production
        # pause flags, test hooks, environment switches, or host paths.
        event_read, event_write = os.pipe()
        ack_read, ack_write = os.pipe()
        prelude = f"""
            require '{HELPER}';
            open(my $events, '>&=', {event_write}) or die $!;
            open(my $ack, '<&=', {ack_read}) or die $!;
            $events->autoflush(1);
            sub rendezvous {{ print $events "ready\\n"; my $byte; read($ack,$byte,1)==1 or die 'missing ack'; }}
            {wrapper}
            eval {{ main(); 1 }} or do {{ print STDERR JSON::PP->new->encode({{error=>"$@",recovery=>recovery()}}); exit 1; }};
        """
        proc = subprocess.Popen(['perl','-e',prelude], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, pass_fds=(event_write,ack_read))
        os.close(event_write); os.close(ack_read)
        proc.stdin.write(json.dumps(request)); proc.stdin.close(); proc.stdin=None
        try:
            ready,_,_ = select.select([event_read],[],[],10)
            self.assertTrue(ready, 'helper did not reach race boundary')
            self.assertTrue(os.read(event_read,100), 'helper exited before race boundary')
            callback(proc)
            os.write(ack_write,b'1')
            stdout, stderr = proc.communicate(timeout=10)
            return proc.returncode, stdout, stderr
        finally:
            os.close(event_read); os.close(ack_write)
            if proc.poll() is None:
                proc.kill(); proc.wait()
    def as_uid99(self, callback):
        pid=os.fork()
        if pid==0:
            try:
                os.setgroups([]); os.setgid(100); os.setuid(99)
                callback(); os._exit(0)
            except BaseException:
                os._exit(1)
        _,status=os.waitpid(pid,0)
        self.assertEqual(status,0,'uid99 race actor failed')
    def rename_exdev(self,old,new,source_fd,destination_fd):
        def attempt():
            try:os.rename(old,new,src_dir_fd=source_fd,dst_dir_fd=destination_fd)
            except OSError as error:
                if error.errno==errno.EXDEV:return
                raise
            raise AssertionError('owning filesystem boundary was escaped')
        self.as_uid99(attempt)
    def test_probe_is_read_only_and_requires_no_selected_directory(self):
        before=set(self.root.iterdir())
        proc,rows=self.run_helper({'op':'probe'})
        self.assertEqual(proc.returncode,0,proc.stderr)
        self.assertTrue(rows[-1]['ok'])
        self.assertEqual(rows[-1]['op'],'probe')
        self.assertTrue(rows[-1]['fanotify_target_fid'])
        self.assertEqual(before,set(self.root.iterdir()))
    def test_ordinary_subdirectory_root_rejected_before_any_mutation(self):
        inner=self.root/'ordinary';inner.mkdir();inner.chmod(0o777)
        self.source.rename(inner/'selected');self.source=inner/'selected'
        before=set(inner.iterdir())
        proc,rows=self.run_helper(self.request(root=str(inner),root_identity=identity(inner)))
        self.assertNotEqual(proc.returncode,0)
        self.assertIn('complete filesystem root',proc.stderr)
        self.assertEqual(before,set(inner.iterdir()))
        self.assertTrue(self.source.exists())
    def test_root_specific_probe_is_read_only(self):
        before=set(self.root.iterdir())
        proc,rows=self.run_helper({'op':'probe','root':str(self.root),'root_identity':identity(self.root)})
        self.assertEqual(proc.returncode,0,proc.stderr)
        self.assertTrue(rows[-1]['fanotify_target_fid'])
        self.assertTrue(rows[-1]['root_mount_id'])
        self.assertEqual(before,set(self.root.iterdir()))
    def test_bind_subdirectory_is_not_a_complete_filesystem_root(self):
        alias=self.base/'subtree-alias';alias.mkdir()
        subprocess.run(['mount','--bind',str(self.source),str(alias)],check=True)
        try:
            proc,rows=self.run_helper({'op':'probe','root':str(alias),'root_identity':identity(alias)})
            self.assertNotEqual(proc.returncode,0)
            self.assertIn('complete filesystem root',proc.stderr)
            self.assertEqual(list(self.source.iterdir()),[])
            self.assertEqual(list(self.root.glob('.zfsm-mutation-*')),[])
        finally:subprocess.run(['umount',str(alias)],check=True)
    def test_created_container_substitution_rejected_before_metadata(self):
        victim=self.root/'unrelated-private';victim.mkdir(mode=0o700)
        before=identity(victim)
        root_fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
        wrapper=r"""my $original=\&creation_handle; no warnings 'redefine';
          *creation_handle=sub { rendezvous(); return $original->(@_); };"""
        def actor(proc):
            names=[name for name in os.listdir(root_fd) if name.startswith('.zfsm-mutation-')]
            self.assertEqual(len(names),1)
            def swap():
                os.rename(names[0],'parked-new-container',src_dir_fd=root_fd,dst_dir_fd=root_fd)
                os.rename('unrelated-private',names[0],src_dir_fd=root_fd,dst_dir_fd=root_fd)
            self.as_uid99(swap)
        try:
            code,out,err=self.run_interleaved(self.request(),wrapper,actor)
            self.assertNotEqual(code,0)
            self.assertIn('creation identity changed',err)
            substituted=next(self.root.glob('.zfsm-mutation-*'))
            self.assertEqual(identity(substituted),before)
            self.assertEqual(list(substituted.iterdir()),[])
            self.assertTrue(self.source.exists())
            self.assertEqual(list((self.root/'parked-new-container').iterdir()),[])
        finally:os.close(root_fd)
    def test_inherited_sgid_and_default_acl_private_container_only_is_secured(self):
        os.chown(self.root,99,100);os.chmod(self.root,0o2777)
        acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',tag,7,uid) for tag,uid in ((1,0xffffffff),(2,99),(4,0xffffffff),(16,0xffffffff),(32,0xffffffff)))
        os.setxattr(self.root,'system.posix_acl_default',acl)
        original=os.stat(self.source)
        proc,rows=self.run_helper(self.request(op='move',destination='moved'))
        self.assertEqual(proc.returncode,0,proc.stderr)
        after=os.stat(self.root/'moved')
        self.assertEqual((after.st_uid,after.st_gid,after.st_mode),(original.st_uid,original.st_gid,original.st_mode))
        self.assertEqual(stat.S_IMODE(os.stat(self.root).st_mode),0o2777)
        private=next(self.root.glob('.zfsm-mutation-*'))
        self.assertEqual(stat.S_IMODE(os.stat(private).st_mode),0o700)
        self.assertEqual(os.stat(private).st_uid,0)
        # An inherited named-user ACL must not grant access through its mask.
        root_fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
        def denied():
            try:
                fd=os.open(private.name,os.O_RDONLY|os.O_DIRECTORY,dir_fd=root_fd)
            except PermissionError:return
            os.close(fd)
            raise AssertionError('inherited ACL allowed private-container access')
        try:self.as_uid99(denied)
        finally:os.close(root_fd)
    def test_creation_event_failures_precede_journal_and_source_claim(self):
        mutations={
            'overflow':"substr($bytes,8,8)=pack('Q<',0x4000);",
            'wrong-version':"substr($bytes,4,1)=pack('C',99);",
            'malformed-length':"substr($bytes,0,4)=pack('L<',65535);",
            'wrong-pid':"substr($bytes,20,4)=pack('l<',$$+100000);",
            'wrong-fsid':"$policy->{fsid}=~s/./chr(ord($&)^255)/se;",
            'wrong-parent':"$policy->{handle}.='wrong';",
        }
        for label,mutation in mutations.items():
            wrapper=r"""my $original=\&creation_handle; no warnings 'redefine';
              *creation_handle=sub {
                my ($policy,$name)=@_;my $bytes='';sysread($policy->{fan},$bytes,65536)>0 or die 'missing native event';
                MUTATION
                pipe(my $reader,my $writer) or die $!;print $writer $bytes;close($writer);$policy->{fan}=$reader;
                return $original->($policy,$name);
              };""".replace('MUTATION',mutation)
            program=f"require '{HELPER}'; {wrapper} eval {{main();1}} or do {{print STDERR $@;exit 1;}};"
            proc=subprocess.run(['perl','-e',program],input=json.dumps(self.request()),text=True,capture_output=True)
            self.assertNotEqual(proc.returncode,0,(label,proc.stderr))
            self.assertTrue(self.source.exists(),label)
            self.assertEqual(list(self.root.glob('.zfsm-mutation-*/journal.jsonl')),[],label)
    def test_landlock_enosys_does_not_block_safe_mutation(self):
        class Filter(ctypes.Structure):
            _fields_=[('code',ctypes.c_ushort),('jt',ctypes.c_ubyte),('jf',ctypes.c_ubyte),('k',ctypes.c_uint)]
        class Program(ctypes.Structure):
            _fields_=[('length',ctypes.c_ushort),('filters',ctypes.POINTER(Filter))]
        def no_landlock():
            libc=ctypes.CDLL(None,use_errno=True)
            filters=(Filter*8)(Filter(0x20,0,0,0),Filter(0x15,0,1,444),Filter(0x06,0,0,0x50000|errno.ENOSYS),Filter(0x15,0,1,445),Filter(0x06,0,0,0x50000|errno.ENOSYS),Filter(0x15,0,1,446),Filter(0x06,0,0,0x50000|errno.ENOSYS),Filter(0x06,0,0,0x7fff0000))
            program=Program(8,filters)
            if libc.prctl(38,1,0,0,0) or libc.prctl(22,2,ctypes.byref(program)):os._exit(111)
        proc,rows=self.run_helper(self.request(),preexec_fn=no_landlock)
        self.assertEqual(proc.returncode,0,proc.stderr)
        self.assertFalse(self.source.exists())
    def test_move_0777_uid99_preserves_owner_mode(self):
        (self.source/'file').write_text('content')
        os.chown(self.source/'file',99,100)
        before = os.stat(self.source)
        proc, rows = self.run_helper(self.request(op='move', destination='moved'))
        self.assertEqual(proc.returncode,0,proc.stderr)
        after = os.stat(self.root/'moved')
        self.assertEqual((before.st_ino,before.st_mode,before.st_uid,before.st_gid),
                         (after.st_ino,after.st_mode,after.st_uid,after.st_gid))
        self.assertFalse(self.source.exists())
    def test_delete_empty_0777_uid99(self):
        proc, rows = self.run_helper(self.request())
        self.assertEqual(proc.returncode,0,proc.stderr)
        self.assertFalse(self.source.exists())
    def test_delete_nonempty_requires_recursive(self):
        (self.source/'file').write_text('preserve')
        proc, rows = self.run_helper(self.request())
        self.assertNotEqual(proc.returncode,0)
        self.assertEqual((self.source/'file').read_text(),'preserve')
    def test_delete_recursive(self):
        (self.source/'nested').mkdir(mode=0o777)
        (self.source/'nested'/'file').write_text('content')
        proc, rows = self.run_helper(self.request(recursive=True))
        self.assertEqual(proc.returncode,0,proc.stderr)
        self.assertFalse(self.source.exists())

    def test_delete_progress_counts_only_successful_unlinks_and_keeps_outside_data(self):
        (self.source / 'file').write_text('delete')
        (self.source / 'child').mkdir()
        (self.source / 'child' / 'file').write_text('delete')
        (self.source / 'link').symlink_to(self.outside / 'sentinel')
        proc, rows = self.run_helper(self.request(recursive=True))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        progress = [row for row in rows if row.get('phase') == 'deleting']
        self.assertTrue(progress)
        self.assertEqual([row['removed'] for row in progress], sorted(set(row['removed'] for row in progress)))
        self.assertTrue(all(row['total'] == 5 and 0 < row['removed'] <= 5 for row in progress))
        self.assertEqual((rows[-1]['removed'], rows[-1]['total']), (5, 5))
        self.assertEqual((self.outside / 'sentinel').read_text(), 'outside must survive')
    def test_existing_destination_preserved(self):
        (self.root/'moved').mkdir()
        (self.root/'moved'/'sentinel').write_text('preserve')
        proc, rows = self.run_helper(self.request(op='move', destination='moved'))
        self.assertNotEqual(proc.returncode,0)
        self.assertEqual((self.root/'moved'/'sentinel').read_text(),'preserve')
        self.assertTrue(self.source.exists())
    def test_wrong_selected_identity_does_not_mutate(self):
        proc, rows = self.run_helper(self.request(identity={'dev':'0','ino':'0'}, recursive=True))
        self.assertNotEqual(proc.returncode,0)
        self.assertTrue(self.source.exists())
    def test_symlink_in_selected_tree_unlinked_without_following(self):
        (self.source/'link').symlink_to(self.outside, target_is_directory=True)
        proc, rows = self.run_helper(self.request(recursive=True))
        self.assertEqual(proc.returncode,0,proc.stderr)
        self.assertEqual((self.outside/'sentinel').read_text(),'outside must survive')
        self.assertFalse(self.source.exists())
    def test_dataset_identity_required(self):
        proc, rows = self.run_helper(self.request(root_identity={'dev':'0','ino':'0'}))
        self.assertNotEqual(proc.returncode,0)
        self.assertTrue(self.source.exists())

    def test_move_preserves_symlink_entries(self):
        (self.source/'link').symlink_to(self.outside, target_is_directory=True)
        proc, rows = self.run_helper(self.request(op='move', destination='moved'))
        self.assertEqual(proc.returncode,0,proc.stderr)
        self.assertTrue((self.root/'moved'/'link').is_symlink())
        self.assertEqual((self.outside/'sentinel').read_text(),'outside must survive')
    def test_move_preserves_fifo_socket_entries(self):
        os.mkfifo(self.source/'pipe',0o666)
        with socket.socket(socket.AF_UNIX) as sock:sock.bind(str(self.source/'socket'))
        before={p.name:(os.lstat(p).st_ino,os.lstat(p).st_mode) for p in self.source.iterdir()}
        proc,rows=self.run_helper(self.request(op='move',destination='moved'))
        self.assertEqual(proc.returncode,0,proc.stderr)
        after={p.name:(os.lstat(p).st_ino,os.lstat(p).st_mode) for p in (self.root/'moved').iterdir()}
        self.assertEqual(before,after)
    def test_delete_fifo_socket_entries_without_opening(self):
        os.mkfifo(self.source/'pipe',0o666)
        with socket.socket(socket.AF_UNIX) as sock:sock.bind(str(self.source/'socket'))
        proc,rows=self.run_helper(self.request(recursive=True))
        self.assertEqual(proc.returncode,0,proc.stderr)
        self.assertFalse(self.source.exists())
    def test_device_nodes_are_not_opened_for_io(self):
        # Requires CAP_MKNOD only in this disposable fixture. O_PATH metadata
        # handles never call a character/block driver's open implementation.
        os.mknod(self.source/'char-device',stat.S_IFCHR|0o600,os.makedev(1,3))
        os.mknod(self.source/'block-device',stat.S_IFBLK|0o600,os.makedev(7,250))
        before={p.name:(os.lstat(p).st_ino,os.lstat(p).st_mode,os.lstat(p).st_rdev) for p in self.source.iterdir()}
        proc,rows=self.run_helper(self.request(op='move',destination='moved'))
        self.assertEqual(proc.returncode,0,proc.stderr)
        self.source=self.root/'moved'
        after={p.name:(os.lstat(p).st_ino,os.lstat(p).st_mode,os.lstat(p).st_rdev) for p in self.source.iterdir()}
        self.assertEqual(before,after)
        proc,rows=self.run_helper(self.request(path='moved',recursive=True))
        self.assertEqual(proc.returncode,0,proc.stderr)
        self.assertFalse(self.source.exists())
    def test_delete_hardlink_does_not_change_outside_inode(self):
        sentinel=self.root/'outside-selected-sentinel';sentinel.write_text('outside must survive')
        os.link(sentinel,self.source/'hardlink')
        proc,rows=self.run_helper(self.request(recursive=True))
        self.assertEqual(proc.returncode,0,proc.stderr)
        self.assertEqual(sentinel.read_text(),'outside must survive')
    def test_move_publication_race_does_not_replace_new_destination(self):
        root_fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
        wrapper=r"""my $original=\&record; no warnings 'redefine';
          *record=sub { $original->(@_); if ($_[0]{event} eq 'captured' && $_[0]{path} eq 'selected') { rendezvous(); } };"""
        def actor(proc):
            def replace():
                os.mkdir('moved',0o777,dir_fd=root_fd)
                fd=os.open('moved/sentinel',os.O_WRONLY|os.O_CREAT,0o666,dir_fd=root_fd)
                os.write(fd,b'new destination preserved');os.close(fd)
            self.as_uid99(replace)
        try:
            code,out,err=self.run_interleaved(self.request(op='move',destination='moved'),wrapper,actor)
            self.assertNotEqual(code,0)
            self.assertTrue(self.source.is_dir())
            self.assertEqual((self.root/'moved'/'sentinel').read_text(),'new destination preserved')
        finally:os.close(root_fd)
    def test_move_open_destination_parent_cannot_escape_dataset(self):
        dest=self.root/'destination-parent';dest.mkdir(mode=0o777);os.chmod(dest,0o777)
        (dest/'sentinel').write_text('outside destination preserved')
        root_fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
        outside_fd=os.open(self.outside,os.O_RDONLY|os.O_DIRECTORY)
        wrapper=r"""my $original=\&record; no warnings 'redefine';
          *record=sub { $original->(@_); if ($_[0]{event} eq 'captured' && $_[0]{path} eq 'selected') { rendezvous(); } };"""
        def actor(proc):
            self.rename_exdev('destination-parent','escaped-destination',root_fd,outside_fd)
        try:
            code,out,err=self.run_interleaved(self.request(op='move',destination='destination-parent/moved'),wrapper,actor)
            self.assertEqual(code,0,err)
            self.assertTrue((dest/'moved').is_dir())
            self.assertFalse((self.outside/'escaped-destination'/'moved').exists())
            self.assertEqual((dest/'sentinel').read_text(),'outside destination preserved')
        finally:os.close(root_fd);os.close(outside_fd)
    def test_destination_parent_replaced_during_final_rename_reports_actual_retention(self):
        dest=self.root/'destination-parent';dest.mkdir(mode=0o777);os.chmod(dest,0o777)
        (self.source/'original').write_text('reviewed inode preserved')
        expected=identity(self.source)
        root_fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
        wrapper=r"""my $original=\&renamed; no warnings 'redefine';
          *renamed=sub { if ($_[1] eq 'object-1' && $_[3] eq 'moved') { rendezvous(); } return $original->(@_); };"""
        def actor(proc):
            def replace():
                os.rename('destination-parent','other-parent',src_dir_fd=root_fd,dst_dir_fd=root_fd)
                os.mkdir('destination-parent',0o777,dir_fd=root_fd)
                fd=os.open('destination-parent/replacement',os.O_WRONLY|os.O_CREAT,0o666,dir_fd=root_fd)
                os.write(fd,b'replacement untouched');os.close(fd)
            self.as_uid99(replace)
        try:
            code,out,err=self.run_interleaved(self.request(op='move',destination='destination-parent/moved'),wrapper,actor)
            self.assertNotEqual(code,0,'canonical destination changed during rename must not report success')
            moved=self.root/'other-parent'/'moved'
            self.assertEqual(identity(moved),expected)
            self.assertEqual((moved/'original').read_text(),'reviewed inode preserved')
            self.assertFalse((dest/'moved').exists())
            self.assertEqual((dest/'replacement').read_text(),'replacement untouched')
            self.assertIn(str(moved),err)
            journal=next(self.root.glob('.zfsm-mutation-*/journal.jsonl')).read_text()
            self.assertIn(str(moved),journal)
        finally:os.close(root_fd)
    def test_destination_parent_changed_before_publication_is_rejected(self):
        dest=self.root/'destination-parent';dest.mkdir(mode=0o777);os.chmod(dest,0o777)
        root_fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
        wrapper=r"""my $original=\&record; no warnings 'redefine';
          *record=sub { $original->(@_); if ($_[0]{event} eq 'captured' && $_[0]{path} eq 'selected') { rendezvous(); } };"""
        def actor(proc):
            def replace():
                os.rename('destination-parent','other-parent',src_dir_fd=root_fd,dst_dir_fd=root_fd)
                os.mkdir('destination-parent',0o777,dir_fd=root_fd)
            self.as_uid99(replace)
        try:
            code,out,err=self.run_interleaved(self.request(op='move',destination='destination-parent/moved'),wrapper,actor)
            self.assertNotEqual(code,0)
            self.assertFalse((self.root/'other-parent'/'moved').exists())
            self.assertFalse((dest/'moved').exists())
            # Original either safely rolled back or retained in private claim.
            retained=self.source.exists() or bool(list(self.root.glob('.zfsm-mutation-*/object-1')))
            self.assertTrue(retained)
        finally:os.close(root_fd)
    def test_source_parent_replaced_within_dataset_retains_reviewed_inode_and_actual_metadata(self):
        parent=self.root/'source-parent';parent.mkdir(mode=0o777);os.chmod(parent,0o777)
        self.source.rename(parent/'selected');self.source=parent/'selected'
        (self.source/'original').write_text('reviewed source preserved')
        expected=identity(self.source)
        root_fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
        wrapper=r"""my $original=\&renamed; no warnings 'redefine';
          *renamed=sub { if ($_[1] eq 'selected' && $_[3] eq 'object-1') { rendezvous(); } return $original->(@_); };"""
        def actor(proc):
            def replace():
                os.rename('source-parent','other-source-parent',src_dir_fd=root_fd,dst_dir_fd=root_fd)
                os.mkdir('source-parent',0o777,dir_fd=root_fd)
                os.mkdir('source-parent/selected',0o777,dir_fd=root_fd)
                fd=os.open('source-parent/selected/replacement',os.O_WRONLY|os.O_CREAT,0o666,dir_fd=root_fd)
                os.write(fd,b'replacement untouched');os.close(fd)
            self.as_uid99(replace)
        try:
            code,out,err=self.run_interleaved(self.request(path='source-parent/selected',recursive=True),wrapper,actor)
            self.assertNotEqual(code,0)
            self.assertEqual((self.source/'replacement').read_text(),'replacement untouched')
            retained=list(self.root.glob('.zfsm-mutation-*/object-1'))
            self.assertEqual(len(retained),1)
            self.assertEqual(identity(retained[0]),expected)
            self.assertEqual((retained[0]/'original').read_text(),'reviewed source preserved')
            actual=str(self.root/'other-source-parent'/'selected')
            journal=next(self.root.glob('.zfsm-mutation-*/journal.jsonl')).read_text()
            self.assertIn(actual,journal)
            self.assertIn(actual,err)
        finally:os.close(root_fd)
    def test_wrong_final_name_capture_restored(self):
        root_fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
        wrapper=r"""my $original=\&capture; no warnings 'redefine';
          *capture=sub { if ($_[3] eq 'selected') { rendezvous(); } return $original->(@_); };"""
        def actor(proc):
            def replace():
                os.rename('selected','parked',src_dir_fd=root_fd,dst_dir_fd=root_fd)
                os.mkdir('selected',0o777,dir_fd=root_fd)
                fd=os.open('selected/sentinel',os.O_WRONLY|os.O_CREAT,0o666,dir_fd=root_fd)
                os.write(fd,b'unexpected must survive'); os.close(fd)
            self.as_uid99(replace)
        try:
            code,out,err=self.run_interleaved(self.request(recursive=True),wrapper,actor)
            self.assertNotEqual(code,0,err)
            self.assertEqual((self.source/'sentinel').read_text(),'unexpected must survive')
            self.assertTrue((self.root/'parked').is_dir())
        finally: os.close(root_fd)
    def test_wrong_capture_occupied_original_retained_without_overwrite(self):
        root_fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
        wrapper=r"""my $capture=\&capture; my $rename=\&renamed; no warnings 'redefine';
          *capture=sub { if ($_[3] eq 'selected') { rendezvous(); } return $capture->(@_); };
          *renamed=sub { my $ok=$rename->(@_); if ($ok && $_[1] eq 'selected') { rendezvous(); } return $ok; };"""
        event_r,event_w=os.pipe(); ack_r,ack_w=os.pipe()
        program=f"""require '{HELPER}'; open(my $e,'>&=',{event_w});open(my $a,'<&=',{ack_r});$e->autoflush(1);
          sub rendezvous {{print $e "ready\n";my $x;read($a,$x,1);}}
          {wrapper}
          eval {{main();1}} or do {{print STDERR $@;exit 1;}};"""
        proc=subprocess.Popen(['perl','-e',program],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,pass_fds=(event_w,ack_r))
        os.close(event_w);os.close(ack_r)
        request=self.request(recursive=True)
        proc.stdin.write(json.dumps(request));proc.stdin.close();proc.stdin=None
        try:
            self.assertTrue(select.select([event_r],[],[],10)[0]);os.read(event_r,100)
            def replace():
                os.rename('selected','parked',src_dir_fd=root_fd,dst_dir_fd=root_fd)
                os.mkdir('selected',0o777,dir_fd=root_fd)
                fd=os.open('selected/wrong',os.O_WRONLY|os.O_CREAT,0o666,dir_fd=root_fd)
                os.write(fd,b'wrong preserved');os.close(fd)
            self.as_uid99(replace);os.write(ack_w,b'1')
            self.assertTrue(select.select([event_r],[],[],10)[0]);os.read(event_r,100)
            self.as_uid99(lambda:os.mkdir('selected',0o777,dir_fd=root_fd));os.write(ack_w,b'1')
            out,err=proc.communicate(timeout=10)
            self.assertNotEqual(proc.returncode,0)
            self.assertIn('retained',err)
            self.assertTrue(self.source.is_dir())
            wrong=list(self.root.glob('.zfsm-mutation-*/object-*/wrong'))
            self.assertEqual(len(wrong),1)
            self.assertEqual(wrong[0].read_text(),'wrong preserved')
        finally:
            for fd in (event_r,ack_w,root_fd):os.close(fd)
            if proc.poll() is None:proc.kill();proc.wait()
    def test_open_source_parent_moved_outside_dataset_is_confined(self):
        parent=self.root/'parent';parent.mkdir(mode=0o777);os.chmod(parent,0o777)
        self.source.rename(parent/'selected');self.source=parent/'selected'
        (self.source/'sentinel').write_text('escaped selected must survive')
        root_fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
        outside_fd=os.open(self.outside,os.O_RDONLY|os.O_DIRECTORY)
        os.chmod(self.outside,0o777)
        wrapper=r"""my $original=\&capture; no warnings 'redefine';
          *capture=sub { if ($_[3] eq 'parent/selected') { rendezvous(); } return $original->(@_); };"""
        def escape(proc):
            self.rename_exdev('parent','escaped-parent',root_fd,outside_fd)
        try:
            request=self.request(path='parent/selected',recursive=True)
            code,out,err=self.run_interleaved(request,wrapper,escape)
            self.assertEqual(code,0,err)
            self.assertFalse(self.source.exists())
            self.assertFalse((self.outside/'escaped-parent').exists())
            self.assertEqual((self.outside/'sentinel').read_text(),'outside must survive')
        finally:
            os.close(root_fd);os.close(outside_fd)
    def test_unsafe_subdirectory_root_control_demonstrates_why_full_root_is_required(self):
        # Deliberately bypass exactly the full-root requirement, only in this
        # test process. A same-filesystem ordinary subtree can lose ancestors.
        filesystem=self.root;ordinary=filesystem/'ordinary';ordinary.mkdir();ordinary.chmod(0o777)
        self.source.rename(ordinary/'selected');self.root=ordinary;self.source=ordinary/'selected'
        escaped=filesystem/'sibling';escaped.mkdir();escaped.chmod(0o777)
        parent=self.root/'parent';parent.mkdir(mode=0o777);os.chmod(parent,0o777)
        self.source.rename(parent/'selected');self.source=parent/'selected'
        (self.source/'controlled-canary').write_text('fixture only')
        root_fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
        outside_fd=os.open(escaped,os.O_RDONLY|os.O_DIRECTORY)
        wrapper=r"""my $original=\&capture; no warnings 'redefine';
          *full_root=sub { return mount_id($_[0]); };
          *capture=sub { if ($_[3] eq 'parent/selected') { rendezvous(); } return $original->(@_); };"""
        def escape(proc):
            self.as_uid99(lambda:os.rename('parent','escaped-control',src_dir_fd=root_fd,dst_dir_fd=outside_fd))
        try:
            code,out,err=self.run_interleaved(self.request(path='parent/selected',recursive=True),wrapper,escape)
            self.assertNotEqual(code,0,err)
            # Canonical-path checking detects this only after an out-of-scope
            # claim. The mandatory full-filesystem-root check prevents it.
            self.assertFalse((escaped/'escaped-control'/'selected').exists())
            self.assertTrue(list(self.root.glob('.zfsm-mutation-*/object-1/controlled-canary')))
            self.assertEqual((self.outside/'sentinel').read_text(),'outside must survive')
        finally:os.close(root_fd);os.close(outside_fd);self.root=filesystem
    def test_claim_container_relocated_outside_dataset_is_confined(self):
        (self.source/'file').write_text('escaped claim must survive')
        os.chmod(self.outside,0o777)
        root_fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
        outside_fd=os.open(self.outside,os.O_RDONLY|os.O_DIRECTORY)
        wrapper=r"""my $original=\&record; no warnings 'redefine';
          *record=sub { $original->(@_); if ($_[0]{event} eq 'captured' && $_[0]{path} eq 'selected') { rendezvous(); } };"""
        def actor(proc):
            names=[name for name in os.listdir(root_fd) if name.startswith('.zfsm-mutation-')]
            self.assertEqual(len(names),1)
            self.rename_exdev(names[0],'escaped-claim',root_fd,outside_fd)
        try:
            code,out,err=self.run_interleaved(self.request(recursive=True),wrapper,actor)
            self.assertEqual(code,0,err)
            self.assertFalse(self.source.exists())
            self.assertFalse((self.outside/'escaped-claim').exists())
            self.assertEqual((self.outside/'sentinel').read_text(),'outside must survive')
        finally:os.close(root_fd);os.close(outside_fd)
    def test_manifest_pins_unlinked_inodes_until_identity_check(self):
        file=self.source/'file';file.write_text('original');before=os.stat(file)
        source_fd=os.open(self.source,os.O_RDONLY|os.O_DIRECTORY)
        wrapper=r"""my $original=\&capture; no warnings 'redefine';
          *capture=sub { if ($_[3] eq 'file') { rendezvous(); } return $original->(@_); };"""
        def actor(proc):
            def replace():
                os.unlink('file',dir_fd=source_fd)
                fd=os.open('file',os.O_WRONLY|os.O_CREAT,0o666,dir_fd=source_fd)
                os.write(fd,b'replacement preserved');os.close(fd)
            self.as_uid99(replace)
            pinned=[]
            for fd in pathlib.Path(f'/proc/{proc.pid}/fd').iterdir():
                try:pinned.append(os.stat(fd))
                except FileNotFoundError:pass
            self.assertTrue(any(st.st_dev==before.st_dev and st.st_ino==before.st_ino and st.st_nlink==0 for st in pinned),
                            'reviewed inode must remain pinned, preventing inode-number reuse')
        try:
            code,out,err=self.run_interleaved(self.request(recursive=True),wrapper,actor)
            self.assertNotEqual(code,0)
            retained=list(self.root.glob('.zfsm-mutation-*/object-*/file'))
            self.assertEqual(len(retained),1)
            self.assertEqual(retained[0].read_text(),'replacement preserved')
        finally:os.close(source_fd)
    def test_preopened_child_and_private_parent_fds_cannot_escape_captured_recursion_root(self):
        nested=self.source/'nested';nested.mkdir();nested.chmod(0o777);os.chown(nested,99,100)
        (nested/'file').write_text('selected contents')
        nested_fd=os.open(nested,os.O_RDONLY|os.O_DIRECTORY)
        root_fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
        wrapper=r"""my $original=\&record; no warnings 'redefine';
          *record=sub { $original->(@_); if ($_[0]{event} eq 'captured' && $_[0]{path} eq 'nested') { rendezvous(); } };"""
        def actor(proc):
            private=next(self.root.glob('.zfsm-mutation-*'))
            private_fd=os.open(private,os.O_RDONLY|os.O_DIRECTORY)
            def attempt():
                # Supply even a directory FD the ordinary writer could not
                # freshly open; Linux still applies parent DAC on rename.
                try:os.rename('object-2','escaped-child',src_dir_fd=private_fd,dst_dir_fd=root_fd)
                except PermissionError:pass
                else:raise AssertionError('captured child escaped private parent')
                assert os.stat('file',dir_fd=nested_fd).st_size>0
            try:self.as_uid99(attempt)
            finally:os.close(private_fd)
        try:
            code,out,err=self.run_interleaved(self.request(recursive=True),wrapper,actor)
            self.assertEqual(code,0,err)
            self.assertFalse((self.root/'escaped-child').exists())
            self.assertFalse(self.source.exists())
        finally:os.close(nested_fd);os.close(root_fd)
    def test_new_concurrent_writer_entry_is_retained(self):
        source_fd=os.open(self.source,os.O_RDONLY|os.O_DIRECTORY)
        wrapper=r"""my $original=\&record; no warnings 'redefine';
          *record=sub { $original->(@_); if ($_[0]{event} eq 'captured' && $_[0]{path} eq 'selected') { rendezvous(); } };"""
        def actor(proc):
            def write():
                fd=os.open('new-file',os.O_WRONLY|os.O_CREAT,0o666,dir_fd=source_fd)
                os.write(fd,b'concurrent writer preserved');os.close(fd)
            self.as_uid99(write)
        try:
            code,out,err=self.run_interleaved(self.request(recursive=True),wrapper,actor)
            self.assertNotEqual(code,0)
            retained=list(self.root.glob('.zfsm-mutation-*/object-*/new-file'))
            self.assertEqual(len(retained),1)
            self.assertEqual(retained[0].read_text(),'concurrent writer preserved')
        finally:os.close(source_fd)
    def test_interrupted_claim_has_durable_visible_recovery(self):
        (self.source/'file').write_text('retained after interruption')
        wrapper=r"""my $original=\&record; no warnings 'redefine';
          *record=sub { $original->(@_); if ($_[0]{event} eq 'captured' && $_[0]{path} eq 'selected') { rendezvous(); } };"""
        def actor(proc):proc.kill()
        # Killing the blocked process makes acknowledgement harmless.
        try:
            self.run_interleaved(self.request(recursive=True),wrapper,actor)
        except BrokenPipeError:pass
        retained=list(self.root.glob('.zfsm-mutation-*/object-*/file'))
        self.assertEqual(len(retained),1)
        self.assertEqual(retained[0].read_text(),'retained after interruption')
        journals=list(self.root.glob('.zfsm-mutation-*/journal.jsonl'))
        self.assertEqual(len(journals),1)
        self.assertIn('captured',journals[0].read_text())
    def test_nested_same_device_bind_mount_rejected(self):
        mountpoint=self.source/'mounted';mountpoint.mkdir()
        binding=self.root/'bind-source';binding.mkdir();(binding/'sentinel').write_text('outside must survive')
        mounted=subprocess.run(['mount','--bind',str(binding),str(mountpoint)],capture_output=True,text=True)
        self.assertEqual(mounted.returncode,0,mounted.stderr)
        try:
            self.assertEqual(os.stat(mountpoint).st_dev,os.stat(self.source).st_dev)
            for op in ('delete','move'):
                request=self.request(op=op,recursive=True,destination='moved')
                proc,rows=self.run_helper(request)
                self.assertNotEqual(proc.returncode,0)
                self.assertTrue(self.source.exists())
                self.assertEqual((binding/'sentinel').read_text(),'outside must survive')
        finally:
            subprocess.run(['umount',str(mountpoint)],check=True)
    def test_deep_preflight_fd_exhaustion_fails_before_mutation(self):
        cursor=self.source
        for n in range(40):cursor=cursor/'nested';cursor.mkdir()
        (cursor/'file').write_text('deep original retained')
        before=set(self.root.iterdir())
        def limit():resource.setrlimit(resource.RLIMIT_NOFILE,(32,32))
        proc=subprocess.run(['perl',HELPER],input=json.dumps(self.request(recursive=True)),text=True,capture_output=True,preexec_fn=limit)
        self.assertNotEqual(proc.returncode,0)
        self.assertEqual(before,set(self.root.iterdir()))
        self.assertEqual((cursor/'file').read_text(),'deep original retained')
    def test_large_flat_directory_move_claim_delete_below_file_count_fd_limit(self):
        for n in range(1500):(self.source/f'file-{n}').touch()
        large=self.source/'large-sparse';large.touch()
        with large.open('r+b') as handle:handle.truncate(4*1024**3)
        expected=identity(self.source)
        def limit():resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))
        for op,path,destination in (('move','selected','moved'),('claim','moved','claimed'),('delete','claimed',None)):
            request=self.request(op=op,path=path,recursive=True)
            if destination:request['destination']=destination
            proc,rows=self.run_helper(request,preexec_fn=limit)
            self.assertEqual(proc.returncode,0,proc.stderr)
            if destination:
                self.source=self.root/destination
                self.assertEqual(identity(self.source),expected)
                self.assertEqual((self.source/'large-sparse').stat().st_size,4*1024**3)
            else:self.assertFalse(self.source.exists())
    def test_large_flat_delete_with_bounded_descriptors(self):
        for n in range(1800):(self.source/f'file-{n}').touch()
        def limit():resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))
        proc,rows=self.run_helper(self.request(recursive=True),preexec_fn=limit)
        self.assertEqual(proc.returncode,0,proc.stderr)
        self.assertFalse(self.source.exists())
    def test_move_delete_exceed_old_global_entry_limit_across_directories(self):
        # Empty files exercise namespace scale without allocating content pages.
        for n in range(101):
            directory=self.source/f'dir-{n}';directory.mkdir()
            for child in range(1000):(directory/f'file-{child}').touch()
        expected=identity(self.source)
        def limit():resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))
        proc,rows=self.run_helper(self.request(op='move',destination='moved'),preexec_fn=limit)
        self.assertEqual(proc.returncode,0,proc.stderr)
        self.assertEqual(identity(self.root/'moved'),expected)
        self.assertEqual(len(list((self.root/'moved').iterdir())),101)
        self.assertTrue((self.root/'moved'/'dir-100'/'file-999').is_file())
        self.source=self.root/'moved'
        proc,rows=self.run_helper(self.request(path='moved',recursive=True),preexec_fn=limit)
        self.assertEqual(proc.returncode,0,proc.stderr)
        self.assertFalse(self.source.exists())
    def test_missing_mandatory_syscalls_fail_closed(self):
        class Filter(ctypes.Structure):
            _fields_=[('code',ctypes.c_ushort),('jt',ctypes.c_ubyte),('jf',ctypes.c_ubyte),('k',ctypes.c_uint)]
        class Program(ctypes.Structure):
            _fields_=[('length',ctypes.c_ushort),('filters',ctypes.POINTER(Filter))]
        rename_nr=276 if os.uname().machine=='aarch64' else 316
        (self.source/'file').write_text('all original content retained')
        fan_init,fan_mark,handle_nr=(262,263,264) if os.uname().machine=='aarch64' else (300,301,303)
        for blocked in (437,fan_init,fan_mark,handle_nr,rename_nr):
            def seccomp():
                libc=ctypes.CDLL(None,use_errno=True)
                filters=(Filter*4)(Filter(0x20,0,0,0),Filter(0x15,0,1,blocked),Filter(0x06,0,0,0x50000|errno.ENOSYS),Filter(0x06,0,0,0x7fff0000))
                program=Program(4,filters)
                if libc.prctl(38,1,0,0,0) or libc.prctl(22,2,ctypes.byref(program)):
                    os._exit(111)
            proc=subprocess.run(['perl',HELPER],input=json.dumps(self.request(recursive=True)),text=True,capture_output=True,preexec_fn=seccomp)
            self.assertNotEqual(proc.returncode,0,(blocked,proc.stderr))
            self.assertNotEqual(proc.returncode,111,'seccomp setup failed')
            self.assertTrue(self.source.exists(),(blocked,proc.stderr))
            self.assertEqual((self.source/'file').read_text(),'all original content retained')
            before=set(self.root.iterdir())
            probe=subprocess.run(['perl',HELPER],input=json.dumps({'op':'probe'}),text=True,capture_output=True,preexec_fn=seccomp)
            self.assertNotEqual(probe.returncode,0,(blocked,probe.stderr))
            self.assertEqual(before,set(self.root.iterdir()))

if __name__ == '__main__':
    if os.uname().sysname != 'Linux' or not pathlib.Path('/.dockerenv').exists():
        raise SystemExit('Run only in isolated disposable Linux container')
    unittest.main(verbosity=2)
