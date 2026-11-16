import { writeFile } from 'node:fs/promises';
import {prepareRuntimeDirectory,readSecretFile} from './runtime.mjs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer, validateProxyConfiguration } from './server.mjs';
import { createObservatory } from './data.mjs';

process.umask(0o077);
const port=Number(process.env.OBSERVATORY_PORT||47831);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local port.');
const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const publicOrigin=process.env.OBSERVATORY_PUBLIC_ORIGIN;
const proxyKey=process.env.OBSERVATORY_PROXY_KEY_FILE?await readSecretFile(process.env.OBSERVATORY_PROXY_KEY_FILE):undefined;
const bind=process.env.OBSERVATORY_BIND_HOST||'127.0.0.1';
if(!['127.0.0.1','0.0.0.0'].includes(bind)||(bind!=='127.0.0.1'&&(!publicOrigin||!proxyKey)))throw new Error('Non-loopback binding requires an HTTPS origin and proxy key file.');
validateProxyConfiguration({publicOrigin,proxyKey});
const state=await prepareRuntimeDirectory(process.env.OBSERVATORY_DATA_DIR||join(homedir(),'.local','share','github-observatory'),root);
const token=process.env.GITHUB_TOKEN_FILE?await readSecretFile(process.env.GITHUB_TOKEN_FILE):'';
const keyPath=join(state,'unlock-key');
let key;
try{key=await readSecretFile(keyPath);}catch(e){if(e.code!=='ENOENT')throw e;key=randomBytes(32).toString('base64url');await writeFile(keyPath,key+'\n',{mode:0o600,flag:'wx'});}
if(!/^[A-Za-z0-9_-]{40,}$/.test(key))throw new Error('Invalid local unlock file.');
const service=await createObservatory({dbPath:join(state,'observatory.sqlite'),token});
let server;
try{server=createServer({service,publicDir:join(root,'public'),unlockKey:key,publicOrigin,proxyKey,logger:message=>console.error(message)});}
catch(error){await service.close();throw error;}
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
