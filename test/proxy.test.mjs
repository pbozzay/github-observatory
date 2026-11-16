import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {createServer} from '../src/server.mjs';
const origin='https://observatory.example.test',key='synthetic-proxy-secret-at-least-32-characters';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'observatory-proxy-test-'));
 await writeFile(join(root,'index.html'),'<h1>Observatory</h1>');
 const server=createServer({publicDir:root,unlockKey:'synthetic-local-key',publicOrigin:origin,proxyKey:key,service:{dashboard:()=>({repos:[]}),status:()=>({collecting:false}),sync:async()=>{}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 function call(path,{method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{Host:'observatory.example.test',...headers}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);req.end(body);});}
 return {call,port:server.address().port};
}
test('proxy mode rejects direct origin access and spoofed forwarding headers',async t=>{
 const {call}=await fixture(t);
 for(const path of ['/','/api/dashboard','/api/session','/health']){const r=await call(path,{headers:{'X-Forwarded-Proto':'https','X-Forwarded-Host':'observatory.example.test'}});assert.equal(r.status,403);}
 assert.equal((await call('/',{headers:{'X-Observatory-Proxy-Key':key,Host:'evil.example'}})).status,403);
 assert.equal((await call('/',{headers:{'X-Observatory-Proxy-Key':'wrong'}})).status,403);
 assert.equal((await call('/',{headers:{'X-Observatory-Proxy-Key':key}})).status,200);
});
test('trusted proxy creates secure browser session without a second unlock',async t=>{
 const {call}=await fixture(t),headers={'X-Observatory-Proxy-Key':key,Origin:origin,'Content-Type':'application/json'};
 assert.equal((await call('/api/dashboard',{headers})).status,401);
 const login=await call('/api/session',{method:'POST',headers,body:'{}'});assert.equal(login.status,200);
 const cookie=login.headers['set-cookie'][0];assert.match(cookie,/; Secure/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
 const csrf=JSON.parse(login.text).csrf;
 assert.equal((await call('/api/dashboard',{headers:{...headers,Cookie:cookie}})).status,200);
 assert.equal((await call('/api/dashboard',{headers:{Cookie:cookie}})).status,403);
 assert.equal((await call('/api/sync',{method:'POST',headers:{...headers,Cookie:cookie},body:'{}'})).status,403);
 assert.equal((await call('/api/sync',{method:'POST',headers:{...headers,Cookie:cookie,'X-CSRF-Token':csrf},body:'{}'})).status,202);
 assert.equal((await call('/api/session',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);
 assert.equal((await call('/api/session',{method:'POST',headers:{'X-Observatory-Proxy-Key':key,'Content-Type':'application/json'},body:'{}'})).status,403);
});
test('container health is loopback-only and never exposes application data',async t=>{
 const {call,port}=await fixture(t);
 const r=await call('/health',{headers:{Host:`127.0.0.1:${port}`}});assert.equal(r.status,200);assert.deepEqual(JSON.parse(r.text),{status:'running'});
 assert.equal((await call('/api/dashboard',{headers:{Host:`127.0.0.1:${port}`}})).status,403);
});
test('invalid public origins and missing proxy keys fail closed',()=>{
 for(const config of [{publicOrigin:origin},{proxyKey:key},{publicOrigin:'http://observatory.example',proxyKey:key},{publicOrigin:origin+'/path',proxyKey:key},{publicOrigin:'https://user:pass@observatory.example',proxyKey:key},{publicOrigin:origin,proxyKey:'short'}])assert.throws(()=>createServer({publicDir:'.',unlockKey:'test',service:{},...config}));
});
