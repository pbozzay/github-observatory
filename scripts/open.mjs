import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawn } from 'node:child_process';

const state=resolve(process.env.OBSERVATORY_DATA_DIR||join(homedir(),'.local','share','github-observatory'));
try{
 const runtime=JSON.parse(await readFile(join(state,'runtime.json'),'utf8'));
 const url=new URL(runtime.url);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/')throw new Error();
 const health=await fetch(new URL('/health',url),{signal:AbortSignal.timeout(3000)});if(!health.ok)throw new Error();
 const key=(await readFile(join(state,'unlock-key'),'utf8')).trim();
 if(!/^[A-Za-z0-9_-]{40,}$/.test(key))throw new Error();
 url.hash='unlock='+encodeURIComponent(key);
 const [command,args]=platform()==='darwin'?['open',[url.href]]:platform()==='win32'?['rundll32',['url.dll,FileProtocolHandler',url.href]]:['xdg-open',[url.href]];
 const child=spawn(command,args,{stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error()));});
 console.log('Opened the local dashboard. The unlock fragment is consumed and removed by the page.');
}catch{console.error('Could not open the local dashboard. Start the app first, and use the same OBSERVATORY_DATA_DIR for both commands.');process.exitCode=1;}
