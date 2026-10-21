"""Completed recovery cleanup; disposable Linux fixture only."""
import importlib.util, json, os, pathlib, unittest, hashlib
spec=importlib.util.spec_from_file_location('directory_mutations',str(pathlib.Path(__file__).with_name('directory-mutations.py')))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class MutationCleanup(m.DirectoryMutations):
    # Inherit race helpers, not the existing test cases (run that suite separately).
    def completed(self):
        p,rows=self.run_helper(self.request());self.assertEqual(p.returncode,0,p.stderr)
        self.target=pathlib.Path(rows[-1]['recovery']['location']);self.journal=self.target/'journal.jsonl'
        return dict(op='cleanup-inspect',root=str(self.root),root_identity=m.identity(self.root),path=self.target.name,identity=m.identity(self.target))
    def test_cleanup_complete_journal_only(self):
        req=self.completed();before=set(self.root.iterdir());p,rows=self.run_helper(req);self.assertEqual(p.returncode,0,p.stderr);self.assertEqual(before,set(self.root.iterdir()))
        review=rows[-1];self.assertEqual(review['journal_sha256'],hashlib.sha256(self.journal.read_bytes()).hexdigest())
        req.update(op='cleanup',journal_sha256=review['journal_sha256']);p,rows=self.run_helper(req);self.assertEqual(p.returncode,0,p.stderr)
        self.assertFalse(self.target.exists());self.assertEqual(list((self.root/'.zfsm-maintenance').iterdir()),[]);self.assertEqual((self.outside/'sentinel').read_text(),'outside must survive')
    def test_cleanup_refuses_retained_data_or_unfinished_journal(self):
        req=self.completed();original=self.journal.read_bytes()
        (self.target/'object-1').write_text('must survive');p,_=self.run_helper(req);self.assertNotEqual(p.returncode,0);self.assertTrue((self.target/'object-1').exists());(self.target/'object-1').unlink()
        self.journal.write_bytes(b'\n'.join(original.splitlines()[:-1])+b'\n');p,_=self.run_helper(req);self.assertNotEqual(p.returncode,0);self.assertTrue(self.target.exists())
    def test_cleanup_refuses_changed_digest_and_wrong_identity(self):
        req=self.completed();req.update(op='cleanup',journal_sha256='0'*64);p,_=self.run_helper(req);self.assertNotEqual(p.returncode,0);self.assertTrue(self.journal.exists())
        req.update(op='cleanup-inspect',identity={'dev':'1','ino':'1'});p,_=self.run_helper(req);self.assertNotEqual(p.returncode,0);self.assertTrue(self.journal.exists())
    def test_cleanup_refuses_untrusted_journal(self):
        req=self.completed();original=self.journal.read_bytes()
        for contents in [b'{}\n',original+b'{"event":"complete","op":"delete"}\n',original+b'broken',original.replace(b'"created"',b'"unknown"')]:
            self.journal.write_bytes(contents);p,_=self.run_helper(req);self.assertNotEqual(p.returncode,0);self.assertTrue(self.journal.exists())
        self.journal.write_bytes(original);self.journal.chmod(0o666);p,_=self.run_helper(req);self.assertNotEqual(p.returncode,0)
        self.journal.chmod(0o600);os.link(self.journal,self.root/'linked');p,_=self.run_helper(req);self.assertNotEqual(p.returncode,0)
        (self.root/'linked').unlink();self.journal.unlink();self.journal.symlink_to(self.outside/'sentinel');p,_=self.run_helper(req);self.assertNotEqual(p.returncode,0);self.assertTrue((self.outside/'sentinel').exists())
    def test_setgid_parent_only_secures_new_authenticated_anchor(self):
        self.root.chmod(0o2777);req=self.completed();req.update(op='cleanup',journal_sha256=hashlib.sha256(self.journal.read_bytes()).hexdigest())
        p,_=self.run_helper(req);self.assertEqual(p.returncode,0,p.stderr);self.assertEqual((self.root/'.zfsm-maintenance').stat().st_mode&0o7777,0o700)
    def test_completed_move_and_claim_are_eligible(self):
        for op in ['move','claim']:
            if not self.source.exists():self.source.mkdir()
            (self.source/'data').write_text('retained published data')
            p,rows=self.run_helper(self.request(op=op,destination='published-'+op));self.assertEqual(p.returncode,0,p.stderr)
            target=pathlib.Path(rows[-1]['recovery']['location'])
            req=dict(op='cleanup-inspect',root=str(self.root),root_identity=m.identity(self.root),path=target.name,identity=m.identity(target))
            p,rows=self.run_helper(req);self.assertEqual(p.returncode,0,p.stderr)
            req.update(op='cleanup',journal_sha256=rows[-1]['journal_sha256']);p,_=self.run_helper(req);self.assertEqual(p.returncode,0,p.stderr)
            self.assertEqual((self.root/('published-'+op)/'data').read_text(),'retained published data')
    def test_capture_substitution_preserves_unrelated_data(self):
        req=self.completed();req.update(op='cleanup',journal_sha256=hashlib.sha256(self.journal.read_bytes()).hexdigest())
        victim=self.root/'victim';victim.mkdir();(victim/'keep').write_text('unrelated')
        rootfd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
        wrapper=r"""my $orig=\&renamed;my $once=0;no warnings 'redefine';*renamed=sub{rendezvous() unless $once++;return $orig->(@_);};"""
        def swap(proc):
            def actor():
                os.rename(self.target.name,'parked',src_dir_fd=rootfd,dst_dir_fd=rootfd)
                os.rename('victim',self.target.name,src_dir_fd=rootfd,dst_dir_fd=rootfd)
            self.as_uid99(actor)
        try:
            code,out,err=self.run_interleaved(req,wrapper,swap);self.assertNotEqual(code,0);self.assertIn('identity changed',err)
            self.assertEqual((self.target/'keep').read_text(),'unrelated');self.assertTrue((self.root/'parked'/'journal.jsonl').exists())
        finally:os.close(rootfd)
    def test_changed_captured_journal_is_restored(self):
        req=self.completed();req.update(op='cleanup',journal_sha256=hashlib.sha256(self.journal.read_bytes()).hexdigest())
        wrapper=r"""my $orig=\&renamed;my $once=0;no warnings 'redefine';*renamed=sub{my $ok=$orig->(@_);rendezvous() unless $once++;return $ok;};"""
        def change(proc):
            journal=next((self.root/'.zfsm-maintenance').glob('cleanup-*/journal.jsonl'));journal.write_bytes(journal.read_bytes()+b'{}\n')
        code,out,err=self.run_interleaved(req,wrapper,change);self.assertNotEqual(code,0);self.assertIn('contents changed',err);self.assertTrue(self.journal.exists());self.assertTrue(self.journal.read_bytes().endswith(b'{}\n'))
    def test_private_anchor_substitution_during_creation_is_rejected(self):
        req=self.completed();req.update(op='cleanup',journal_sha256=hashlib.sha256(self.journal.read_bytes()).hexdigest())
        victim=self.root/'victim';victim.mkdir(mode=0o700);(victim/'keep').write_text('unrelated')
        wrapper=r"""my $orig=\&creation_handle;no warnings 'redefine';*creation_handle=sub{rendezvous();return $orig->(@_);};"""
        rootfd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
        def swap(proc):
            def actor():
                os.rename('.zfsm-maintenance','parked-area',src_dir_fd=rootfd,dst_dir_fd=rootfd)
                os.rename('victim','.zfsm-maintenance',src_dir_fd=rootfd,dst_dir_fd=rootfd)
            self.as_uid99(actor)
        try:
            code,out,err=self.run_interleaved(req,wrapper,swap);self.assertNotEqual(code,0);self.assertIn('creation identity changed',err);self.assertTrue(self.journal.exists());self.assertEqual((self.root/'.zfsm-maintenance'/'keep').read_text(),'unrelated')
        finally:os.close(rootfd)
    def test_nested_mount_and_untrusted_anchor_refused(self):
        req=self.completed();req.update(op='cleanup',journal_sha256=hashlib.sha256(self.journal.read_bytes()).hexdigest())
        area=self.root/'.zfsm-maintenance';area.mkdir(mode=0o777);area.chmod(0o777)
        p,_=self.run_helper(req);self.assertNotEqual(p.returncode,0);self.assertTrue(self.journal.exists());area.rmdir()
        area.symlink_to(self.outside,target_is_directory=True);p,_=self.run_helper(req);self.assertNotEqual(p.returncode,0);self.assertTrue(self.journal.exists());area.unlink()
        m.subprocess.run(['mount','--bind',str(self.target),str(self.target)],check=True)
        try:
            p,_=self.run_helper(req);self.assertNotEqual(p.returncode,0);self.assertTrue(self.journal.exists())
        finally:m.subprocess.run(['umount',str(self.target)],check=True)
    def test_crash_after_capture_preserves_journal_for_review(self):
        req=self.completed();req.update(op='cleanup',journal_sha256=hashlib.sha256(self.journal.read_bytes()).hexdigest())
        wrapper=r"""my $orig=\&renamed;no warnings 'redefine';*renamed=sub{my $ok=$orig->(@_);POSIX::_exit(77);};"""
        # Separate interpreter injects a crash at the capture boundary only.
        proc=m.subprocess.run(['perl','-e',"require '"+m.HELPER+"';"+wrapper+'main();'],input=json.dumps(req),text=True,capture_output=True)
        self.assertEqual(proc.returncode,77,proc.stderr);self.assertFalse(self.target.exists())
        retained=list((self.root/'.zfsm-maintenance').glob('cleanup-*/journal.jsonl'));self.assertEqual(len(retained),1);self.assertEqual(hashlib.sha256(retained[0].read_bytes()).hexdigest(),req['journal_sha256'])
# Avoid inherited tests in this targeted class; the original suite remains separate.
for name in dir(m.DirectoryMutations):
    if name.startswith('test_') and name not in MutationCleanup.__dict__:setattr(MutationCleanup,name,None)
if __name__=='__main__':unittest.main()
