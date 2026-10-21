import {startMock} from './mock-server.mjs';
const port=Number(process.env.ZFSM_PORT??50527);
if(!Number.isInteger(port)||port<0||port>65535)throw Error('ZFSM_PORT must be an integer from 0 to 65535');
const mock=await startMock({port});
console.log('Local simulated ZFS Director: '+mock.url);
console.log('Server metadata is copied; all operations, jobs and file contents are simulated. Ctrl+C stops the lab.');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await mock.close();process.exit(0);});
