#!/usr/bin/env python3
"""Prepare a separate native test copy; never install packages in the guest."""
import hashlib
import json
from pathlib import Path
import shutil
import sys

destination = Path(sys.argv[1]).resolve()
tools = Path(sys.argv[2]).resolve()
if not str(destination).startswith('/private/tmp/'):
    raise RuntimeError('Use a new private temporary staging directory')
shutil.copytree('src', destination/'src', dirs_exist_ok=True)
(destination/'tests/native-linux').mkdir(parents=True, exist_ok=True)
(destination/'acl-tools').mkdir(exist_ok=True)
hashes = {}
for name in ('getfacl', 'setfacl'):
    source = tools/name
    if source.read_bytes()[:4] != b'\x7fELF':
        raise RuntimeError('Expected native Linux ELF test tool')
    shutil.copyfile(source, destination/'acl-tools'/name)
    hashes[name] = hashlib.sha256(source.read_bytes()).hexdigest()
for name in ('protection-bootstrap.php', 'acl-editor.php'):
    shutil.copyfile(Path('tests/native-linux')/name, destination/'tests/native-linux'/name)
usage = destination/'src/include/ZFSMUsage.php'
text = usage.read_text()
text = text.replace("'getfacl'=>['/usr/bin/getfacl','/bin/getfacl']", "'getfacl'=>['/var/lib/zfs-director-native-20261018/acl-tools/getfacl']")
text = text.replace("$paths['setfacl']=['/usr/bin/setfacl','/bin/setfacl'];", "$paths['setfacl']=['/var/lib/zfs-director-native-20261018/acl-tools/setfacl'];")
usage.write_text(text)
editor = destination/'src/include/ZFSMACLEditor.php'
text = editor.read_text()
assert text.count('function zfsmACLDescriptorProcess(') == 1
editor.write_text(text.replace('function zfsmACLDescriptorProcess(', 'function zfsmACLDescriptorProcessActual('))
(destination/'test-boundaries.json').write_text(json.dumps({'tools': hashes, 'substitutions': ['private root-owned tool paths', 'descriptor wrapper injects one postwrite read failure; real commands still execute'], 'system_packages_changed': False}, indent=2)+'\n')
