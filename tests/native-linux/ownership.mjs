import {execFileSync,spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
const output=process.env.ZFSM_OUTPUT||'evidence/ownership-2026-10-19/native';await mkdir(output,{recursive:true});
const name='zfsm-ownership-'+process.pid;
execFileSync('docker',['create','--name',name,'--network','none','--cap-drop','ALL','-e','ZFSM_OWNERSHIP_ISOLATED_PATHS=1','zfs-director-native-rsync351:local','php','/stand/tests/native-linux/ownership.php'],{stdio:'pipe',timeout:20000});
try{
 for(const path of ['src','tests'])execFileSync('docker',['cp',path,name+':/stand/'+path],{timeout:20000});
 const r=spawnSync('docker',['start','-a',name],{encoding:'utf8',maxBuffer:1024*1024,timeout:30000}),meta=JSON.parse(execFileSync('docker',['inspect',name],{encoding:'utf8',timeout:20000}))[0];
 await writeFile(output+'/run.log',(r.stdout||'')+(r.stderr||''));
 let report;try{report=JSON.parse(r.stdout.trim().split('\n').at(-1));}catch{report={failed:1,error:'No native JSON result'};}
 report.container={image:meta.Image,network:meta.HostConfig.NetworkMode,binds:meta.HostConfig.Binds||[],exitCode:meta.State.ExitCode};
 await writeFile(output+'/results.json',JSON.stringify(report,null,2)+'\n');process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');
 if(meta.State.ExitCode!==0||report.failed!==0)process.exitCode=1;
}finally{execFileSync('docker',['rm','-f',name],{stdio:'pipe',timeout:20000});}
