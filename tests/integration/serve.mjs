import {startIntegration} from './server.mjs';
const stand=await startIntegration();
console.log('LOCAL PHP INTEGRATION: '+stand.url+' · click Refresh · no Unraid/native ZFS');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await stand.close();process.exit(0);});
