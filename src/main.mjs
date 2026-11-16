import { mkdir, readFile, writeFile, stat, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.mjs';
import { createObservatory } from './data.mjs';

process.umask(0o077);
const port=Number(process.env.OBSERVATORY_PORT||47831);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local port.');
const state=resolve(process.env.OBSERVATORY_DATA_DIR||join(homedir(),'.local','share','github-observatory'));
await mkdir(state,{recursive:true,mode:0o700});await chmod(state,0o700);
const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
if(state===root||state.startsWith(root+'/'))throw new Error('Runtime data must be outside the source tree.');
let token='';
if(process.env.GITHUB_TOKEN_FILE){
 const path=resolve(process.env.GITHUB_TOKEN_FILE),info=await stat(path);
 if(info.mode&0o077)throw new Error('Token file must be readable only by its owner.');
 token=(await readFile(path,'utf8')).trim();if(!token||token.length>1024)throw new Error('Invalid token file.');
}
const keyPath=join(state,'unlock-key');
let key;
try{key=(await readFile(keyPath,'utf8')).trim();}catch(e){if(e.code!=='ENOENT')throw e;key=randomBytes(32).toString('base64url');await writeFile(keyPath,key+'\n',{mode:0o600,flag:'wx'});}
if(!/^[A-Za-z0-9_-]{40,}$/.test(key))throw new Error('Invalid local unlock file.');
await chmod(keyPath,0o600);
const service=await createObservatory({dbPath:join(state,'observatory.sqlite'),token});
const server=createServer({service,publicDir:join(root,'public'),unlockKey:key,logger:message=>console.error(message)});
let interval;
const period=60*60*1000;
async function collect(){
 try{service.setNextRun?.(new Date(Date.now()+period).toISOString());await service.sync();}catch{console.error('Collection did not complete; inspect the authenticated Collection page.');}
}
server.listen(port,'127.0.0.1',async()=>{
 await writeFile(join(state,'runtime.json'),JSON.stringify({url:`http://127.0.0.1:${port}`,pid:process.pid,startedAt:new Date().toISOString()})+'\n',{mode:0o600});
 console.log(`Github Observatory listening on http://127.0.0.1:${port}`);
 console.log('Run npm run open in this project to unlock the local browser.');
 interval=setInterval(collect,period);interval.unref();void collect();
});
server.on('error',()=>{console.error('Local server could not start. Check the configured port.');process.exitCode=1;service.close();});
let stopping=false;
async function shutdown(){if(stopping)return;stopping=true;clearInterval(interval);server.close(async()=>{await service.close();process.exit(0);});setTimeout(()=>process.exit(0),5000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
process.on('unhandledRejection',()=>{console.error('Background operation failed; private details withheld.');});
