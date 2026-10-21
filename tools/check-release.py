#!/usr/bin/env python3
"""Offline, read-only publication checks. Optional private deny-list stays outside Git."""
import argparse, hashlib, json, pathlib, re, subprocess, sys, zlib
ROOT=pathlib.Path(__file__).resolve().parents[1]
SKIP={'.git','node_modules','.private','dist','artifacts','evidence','backups','test-results','playwright-report','__pycache__'}
PATTERNS={
 'personal_home_path':re.compile(rb'(?:/Users/[A-Za-z0-9_.-]+/|[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+\\)'),
 'private_key':re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----'),
 'github_credential':re.compile(rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b'),
 'cloud_credential':re.compile(rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
 'coauthor_trailer':re.compile(rb'^Co-Authored-By:',re.I|re.M),
}
APPROVED_IDENTITIES={b'ZFS Director Maintainers <maintainers@zfs-director.invalid>',b'd1-m4ss <d1-m4ss@users.noreply.github.com>'}
def approved_identity(line):
 match=re.fullmatch(rb'(?:author|committer) (.+) [0-9]+ [+-][0-9]{4}',line)
 return bool(match and match[1] in APPROVED_IDENTITIES)

def findings(data,deny=()):
 result=[key for key,pattern in PATTERNS.items() if pattern.search(data)]
 if any(value and value.lower() in data.lower() for value in deny):result.append('private_deny_list')
 return result

def png_check(data):
 if not data.startswith(b'\x89PNG\r\n\x1a\n'):return ['invalid_png']
 result=[];offset=8
 while offset<len(data):
  if offset+12>len(data):return ['truncated_png']
  size=int.from_bytes(data[offset:offset+4],'big');kind=data[offset+4:offset+8];payload=data[offset+8:offset+8+size];crc=data[offset+8+size:offset+12+size]
  if len(crc)!=4 or zlib.crc32(kind+payload)&0xffffffff!=int.from_bytes(crc,'big'):result.append('png_crc')
  if kind in [b'tEXt',b'zTXt',b'iTXt',b'eXIf']:result.append('png_metadata')
  offset+=12+size
 return result

def checked_paths():
 try:
  if subprocess.check_output(['git','rev-parse','--show-toplevel'],cwd=ROOT,stderr=subprocess.DEVNULL,text=True).strip()==str(ROOT):
   tracked=subprocess.check_output(['git','ls-files','-z'],cwd=ROOT).decode().split('\0');untracked=subprocess.check_output(['git','ls-files','--others','--exclude-standard','-z'],cwd=ROOT).decode().split('\0')
   return sorted(set(p for p in tracked+untracked if p))
 except subprocess.CalledProcessError:pass
 return sorted(str(p.relative_to(ROOT))for p in ROOT.rglob('*')if p.is_file() and not any(part in SKIP for part in p.relative_to(ROOT).parts))

def run(deny,history):
 violations=[];paths=checked_paths();scanned=0;images=0
 for name in paths:
  p=ROOT/name
  if p.is_symlink():violations.append({'file':name,'reason':'symlink'});continue
  if any(part in {'backups','.private','node_modules'}for part in p.relative_to(ROOT).parts):violations.append({'file':name,'reason':'private_directory'})
  data=p.read_bytes();scanned+=1
  for reason in findings(data,deny):violations.append({'file':name,'reason':reason})
  if p.suffix=='.png':
   images+=1
   for reason in png_check(data):violations.append({'file':name,'reason':reason})
  if p.suffix.lower()in ['.pem','.key','.crdownload']or p.name.startswith(('id_rsa','id_ed25519')):violations.append({'file':name,'reason':'credential_or_download_file'})
 for readme in [ROOT/'README.md',ROOT/'README.ru.md']:
  if not readme.exists():continue
  text=readme.read_text()
  targets=re.findall(r'!\[[^\]]*\]\(([^)]+)\)',text)+re.findall(r'<img\b[^>]*\bsrc=[\"\x27]([^\"\x27]+)[\"\x27]',text,re.I)
  for target in targets:
   if '://' in target or not (ROOT/target).is_file():violations.append({'file':readme.name,'reason':'missing_or_remote_image'})
 manifest=ROOT/'docs/images/manifest.json'
 if manifest.is_file():
  m=json.loads(manifest.read_text())
  if not m.get('synthetic')or not m.get('capture',{}).get('inside_vm'):violations.append({'file':'docs/images/manifest.json','reason':'missing_synthetic_vm_provenance'})
  for shot in m.get('screenshots',[]):
   path=manifest.parent/shot['file']
   if not path.is_file()or hashlib.sha256(path.read_bytes()).hexdigest()!=shot['sha256']:violations.append({'file':str(path.relative_to(ROOT)),'reason':'screenshot_hash'})
  for name,expected in m.get('source_hashes',{}).items():
   path=ROOT/name
   if not path.is_file()or hashlib.sha256(path.read_bytes()).hexdigest()!=expected:violations.append({'file':name,'reason':'capture_source_hash'})
 commits=0;blobs=0;roots=0
 if history:
  lines=subprocess.check_output(['git','rev-list','--objects','--all'],cwd=ROOT,text=True).splitlines()
  for line in lines:
   oid,_,name=line.partition(' ');kind=subprocess.check_output(['git','cat-file','-t',oid],cwd=ROOT,text=True).strip()
   if kind not in ['commit','blob']:continue
   data=subprocess.check_output(['git','cat-file',kind,oid],cwd=ROOT)
   if kind=='commit':
    commits+=1
    for line in data.splitlines():
     if line.startswith((b'author ',b'committer '))and not approved_identity(line):violations.append({'object':oid,'reason':'unapproved_git_identity'})
   else:blobs+=1
   for reason in findings(data,deny):violations.append({'object':oid,'file':name,'reason':reason})
  roots=int(subprocess.check_output(['git','rev-list','--max-parents=0','--count','--all'],cwd=ROOT,text=True))
  if commits<1 or roots!=1:violations.append({'reason':'expected_one_clean_root','commits':commits,'roots':roots})
 return {'pass':not violations,'files':scanned,'png_files':images,'history_commits':commits,'history_roots':roots,'history_blobs':blobs,'private_deny_list_supplied':bool(deny),'violations':violations,'scope':'Known private identifiers, credential shapes, absolute home paths, image metadata, screenshot hashes and Git author/trailers. This is not a general security audit.'}
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--deny-file',type=pathlib.Path);parser.add_argument('--history',action='store_true');parser.add_argument('--output',type=pathlib.Path);args=parser.parse_args();deny=[s.encode()for s in json.loads(args.deny_file.read_text())]if args.deny_file else []
 result=run(deny,args.history);text=json.dumps(result,indent=2)+'\n';print(text,end='')
 if args.output:args.output.write_text(text)
 sys.exit(0 if result['pass']else 1)
