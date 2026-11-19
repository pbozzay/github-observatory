import { writeFile } from 'node:fs/promises';
import {prepareRuntimeDirectory,readSecretFile} from './runtime.mjs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer, validateHomeConfiguration } from './server.mjs';
import { createObservatory } from './data.mjs';
import { createNotifications, withNotifications } from './notifications.mjs';

process.umask(0o077);
const port=Number(process.env.OBSERVATORY_PORT||47831);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local port.');
const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const publicOrigin=process.env.OBSERVATORY_PUBLIC_ORIGIN;
const proxyKey=process.env.OBSERVATORY_PROXY_KEY_FILE?await readSecretFile(process.env.OBSERVATORY_PROXY_KEY_FILE):undefined;
const homeToken=process.env.OBSERVATORY_HOME_TOKEN_FILE?await readSecretFile(process.env.OBSERVATORY_HOME_TOKEN_FILE):undefined;
const bind=process.env.OBSERVATORY_BIND_HOST||'127.0.0.1';
if(!['127.0.0.1','0.0.0.0'].includes(bind)||(bind!=='127.0.0.1'&&(!publicOrigin||!proxyKey)))throw new Error('Non-loopback binding requires an HTTPS origin and proxy key file.');
validateHomeConfiguration({publicOrigin,proxyKey,homeToken});
const state=await prepareRuntimeDirectory(process.env.OBSERVATORY_DATA_DIR||join(homedir(),'.local','share','github-observatory'),root);
const token=process.env.GITHUB_TOKEN_FILE?await readSecretFile(process.env.GITHUB_TOKEN_FILE):'';
const keyPath=join(state,'unlock-key');
let key;
try{key=await readSecretFile(keyPath);}catch(e){if(e.code!=='ENOENT')throw e;key=randomBytes(32).toString('base64url');await writeFile(keyPath,key+'\n',{mode:0o600,flag:'wx'});}
if(!/^[A-Za-z0-9_-]{40,}$/.test(key))throw new Error('Invalid local unlock file.');
const observatory=await createObservatory({dbPath:join(state,'observatory.sqlite'),token});
let service=observatory,notifications,server;
try{
 // The primary writer is held before the private inbox is opened. Its own
 // stable SQLite lock also protects standalone initialization and test use.
 notifications=createNotifications({dbPath:join(state,'notifications.sqlite'),service:observatory});
 service=withNotifications(observatory,notifications);
 server=createServer({service,notifications,publicDir:join(root,'public'),unlockKey:key,publicOrigin,proxyKey,homeToken,logger:message=>console.error(message)});
}catch(error){try{await notifications?.close();}finally{await observatory.close();}throw error;}
let interval;
const period=60*60*1000;
async function collect(){
 try{service.setNextRun?.(new Date(Date.now()+period).toISOString());await service.sync();}catch{console.error('Collection did not complete; inspect the authenticated Collection page.');}
}
server.listen(port,bind,async()=>{
 await writeFile(join(state,'runtime.json'),JSON.stringify({url:`http://127.0.0.1:${port}`,pid:process.pid,startedAt:new Date().toISOString()})+'\n',{mode:0o600});
 console.log(publicOrigin?'Github Observatory listening behind its authenticated reverse proxy.':`Github Observatory listening on http://127.0.0.1:${port}`);
 if(!publicOrigin)console.log('Run npm run open in this project to unlock the local browser.');
 interval=setInterval(collect,period);interval.unref();void collect();
});
server.on('error',()=>{console.error('Server could not start. Check the configured port.');void shutdown(1);});
let stopping=false;
async function shutdown(code=0){
 if(stopping)return;stopping=true;clearInterval(interval);
 // Interrupted writes remain transaction-safe; kernel-owned writer locks release on exit.
 const deadline=setTimeout(()=>{console.error('Shutdown deadline reached; pending collection was interrupted.');process.exit(1);},25000);deadline.unref();
 try{await new Promise(resolve=>server.close(resolve));await service.close();clearTimeout(deadline);process.exit(code);}
 catch{console.error('Shutdown failed; private diagnostics withheld.');process.exit(1);}
}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
process.on('unhandledRejection',()=>{console.error('Background operation failed; private details withheld.');});
