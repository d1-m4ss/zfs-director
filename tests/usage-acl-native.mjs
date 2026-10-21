import {execFileSync,spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
const image='zfs-director-native-rsync351:local',name='zfsm-usage-acl-'+process.pid,output='evidence/usage-acl-2026-10-18';
const docker=args=>execFileSync('docker',args,{timeout:20000,killSignal:'SIGKILL'});
await mkdir(output,{recursive:true});
try{docker(['create','--name',name,'--network','none','--cap-drop','ALL',image,'php','/stand/usage-acl-native.php']);}
catch(error){await writeFile(output+'/native.json',JSON.stringify({status:'NOT RUN',reason:'Disposable Docker container could not be created',containerName:name,outcomeUnknown:error.code==='ETIMEDOUT',code:error.code||error.status},null,2)+'\n');throw error;}
try{
 docker(['cp','src',name+':/stand/src']);
 docker(['cp','tests/usage-acl-native.php',name+':/stand/usage-acl-native.php']);
 docker(['cp','tests/usage-acl.php',name+':/stand/usage-acl.php']);
 const result=spawnSync('docker',['start','-a',name],{encoding:'utf8',maxBuffer:1024*1024,timeout:20000,killSignal:'SIGKILL'});
 const state=JSON.parse(execFileSync('docker',['inspect','--format','{"image":{{json .Image}},"network":{{json .HostConfig.NetworkMode}},"binds":{{json .HostConfig.Binds}},"exitCode":{{json .State.ExitCode}}}',name],{encoding:'utf8',timeout:20000,killSignal:'SIGKILL'}));
 await writeFile(output+'/native.txt',(result.stdout||'')+(result.stderr||''));
 let report;try{report=JSON.parse(result.stdout.trim().split('\n').at(-1));}catch{report={failed:1,error:'Native runner did not return JSON'};}
 await writeFile(output+'/native.json',JSON.stringify({...report,container:state},null,2)+'\n');
 process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exitCode=state.exitCode===0&&report.failed===0?0:1;
}finally{docker(['rm','-f',name]);}
