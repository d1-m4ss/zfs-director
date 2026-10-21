import {execFileSync,spawnSync} from 'node:child_process';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';

// Disposable Linux only: copy files, never mount the checkout or Docker socket.
const output=process.env.ZFSM_DIRECTORY_OUTPUT||'evidence/directory-compatibility-2026-10-18/final';
const platform=process.env.ZFSM_DIRECTORY_PLATFORM||(process.arch==='arm64'?'linux/arm64':'linux/amd64');
const image=process.env.ZFSM_DIRECTORY_IMAGE||'zfs-director-native-rsync351:local';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const hashes={};
async function scan(path){for(const file of await readdir(path,{withFileTypes:true})){if(file.name.startsWith('.'))continue;const p=path+'/'+file.name;if(file.isDirectory())await scan(p);else hashes[p]=createHash('sha256').update(await readFile(p)).digest('hex');}}
await scan('src');
const metadata={head:git('rev-parse','HEAD'),sourceTree:git('rev-parse','HEAD:src'),functionalDirty:git('status','--porcelain','--','src','tests','tools/build-installer.py')!=='',hashes};
const suites=[['directory','directory-mutations.py'],['copy','conversion-copy.py'],['publish','conversion-publish.py'],['workflow','conversion-workflow.py'],['existing','run.py']];
await mkdir(output,{recursive:true});const results=[];
for(const [suite,script] of suites){
 const name='zfsm-dir-'+process.pid+'-'+suite;
 const args=['create','--name',name,'--platform',platform,'--network','none','--cap-drop','ALL'];
 for(const cap of ['SYS_ADMIN','SYS_CHROOT','SETPCAP','SETUID','SETGID','CHOWN','DAC_OVERRIDE','FOWNER','FSETID','SETFCAP','MKNOD'])args.push('--cap-add',cap);
 args.push('--security-opt','seccomp=unconfined','--tmpfs','/test:rw,exec,nosuid,mode=0755,size=256m','--tmpfs','/limited:rw,nosuid,size=4m','--tmpfs','/readonly:ro,nosuid,size=1m',image,'python3','/stand/tests/native-linux/'+script);
 execFileSync('docker',args,{stdio:'pipe'});
 try{
  execFileSync('docker',['cp','src',name+':/stand/src']);execFileSync('docker',['cp','tests',name+':/stand/tests']);
  const r=spawnSync('docker',['start','-a',name],{encoding:'utf8',maxBuffer:16*1024*1024});
  const meta=JSON.parse(execFileSync('docker',['inspect',name],{encoding:'utf8'}))[0];
  const log=(r.stdout||'')+(r.stderr||'');await writeFile(output+'/'+suite+'.log',log);
  let report;try{report=JSON.parse((r.stdout||'').trim().split('\n').at(-1));}catch{report={tests:Number(log.match(/Ran (\d+) tests?/)?.[1]||0)};}
  const pass=meta.State.ExitCode===0&&r.status===0;
  const result={suite,status:pass?'PASS':'FAIL',report,image:meta.Image,platform,network:meta.HostConfig.NetworkMode,binds:meta.HostConfig.Binds||[],mounts:meta.Mounts,capabilities:meta.HostConfig.CapAdd,exitCode:meta.State.ExitCode,command:['docker',...args]};
  results.push(result);await writeFile(output+'/'+suite+'.json',JSON.stringify(result,null,2)+'\n');
  process.stdout.write(suite+': '+result.status+'\n');if(!pass){process.stdout.write(log.slice(-10000));process.exitCode=1;}
 }finally{execFileSync('docker',['rm','-f',name],{stdio:'pipe'});}
}
await writeFile(output+'/results.json',JSON.stringify({source:metadata,results},null,2)+'\n');
