import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
test('file type filtering happens before pagination in the actual helper pure function',()=>{
 const code=`require './src/scripts/zfsm-files.pl'; my @rows=map {{name=>'folder-'.$_,path=>'folder-'.$_,type=>'directory',size=>0,mtime=>1}} 1..205; push @rows,{name=>'notes.txt',path=>'notes.txt',type=>'file',size=>1,mtime=>1}; my $r=filter_page(\\@rows,'','name','asc',0,0,'file'); print JSON::PP->new->encode($r);`;
 const r=JSON.parse(execFileSync('/usr/bin/perl',['-e',code],{encoding:'utf8'}));
 assert.equal(r.total,1);assert.equal(r.entries[0].name,'notes.txt');
});
