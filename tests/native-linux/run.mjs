import {execFileSync,spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
const output=process.env.ZFSM_NATIVE_OUTPUT||'evidence/rc-2026-10-16/native-linux';await mkdir(output,{recursive:true});
const platform=process.env.ZFSM_NATIVE_PLATFORM||(process.arch==='arm64'?'linux/arm64':'linux/amd64');
const image=process.env.ZFSM_NATIVE_IMAGE||(platform==='linux/arm64'?'zfsm-native-tests:arm64':'zfsm-native-tests:local');
const name='zfsm-native-'+process.pid;
// Copy through docker cp. Never expose host paths or the Docker socket to tests.
execFileSync('docker',['create','--name',name,'--platform',platform,'--network','none','--cap-drop','ALL','--cap-add','CHOWN','--cap-add','DAC_OVERRIDE','--cap-add','FOWNER','--cap-add','SETUID','--cap-add','SETGID','--cap-add','SYS_ADMIN','--tmpfs','/test:rw,exec,nosuid,size=256m','--tmpfs','/limited:rw,nosuid,size=4m','--tmpfs','/readonly:ro,nosuid,size=1m',image,'python3','/stand/tests/native-linux/run.py']);
try {
 execFileSync('docker',['cp','src',name+':/stand/src']);execFileSync('docker',['cp','tests',name+':/stand/tests']);
 const result=spawnSync('docker',['start','-a',name],{encoding:'utf8',maxBuffer:16*1024*1024});
 const inspected=JSON.parse(execFileSync('docker',['inspect',name],{encoding:'utf8'}))[0];
 await writeFile(output+'/run.txt',(result.stdout||'')+(result.stderr||''));
 const last=(result.stdout||'').trim().split('\n').at(-1);let report;try{report=JSON.parse(last);}catch{report={error:'Native runner did not return JSON'};}
 report.container={image:inspected.Image,platform,exitCode:inspected.State.ExitCode,network:inspected.HostConfig.NetworkMode,binds:inspected.HostConfig.Binds||[]};
 report.git={head:(process.env.ZFSM_SOURCE_REVISION||'working-tree'),sourceTree:execFileSync('git',['rev-parse','HEAD:src'],{encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()!=='',functionalDirty:execFileSync('git',['status','--porcelain','--','src','tests','package.json','package-lock.json'],{encoding:'utf8'}).trim()!==''};
 await writeFile(output+'/results.json',JSON.stringify(report,null,2)+'\n');process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
 process.exitCode=inspected.State.ExitCode===0&&report.failed===0?0:1;
} finally {execFileSync('docker',['rm','-f',name]);}
