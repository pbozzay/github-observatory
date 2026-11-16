import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createServer } from '../src/server.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(process.env.TMPDIR||tmpdir(),'observatory-test-'));
  await writeFile(join(root,'index.html'),'<h1>Github Observatory</h1>');
  const service={dashboard:()=>({dates:[],repos:[{name:'private-canary',metrics:{}}]}),status:()=>({collecting:false}),events:()=>({events:[]}),discover:async()=>({repositories:[]}),addWatch:async x=>({repository:{id:'42',name:x.repository}}),pauseWatch:()=>{},sync:async()=>({ok:true})};
  const server=createServer({service,publicDir:root,unlockKey:'synthetic-test-key',logger:()=>{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const login=async()=>{const res=await fetch(base+'/api/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({key:'synthetic-test-key'})});assert.equal(res.status,200);return {cookie:res.headers.get('set-cookie').split(';')[0],csrf:(await res.json()).csrf};};
  return {base,service,login};
}
test('anonymous requests never disclose private data',async t=>{
 const {base}=await fixture(t);
 for(const route of ['/api/dashboard','/api/status','/api/events','/api/discover','/api/export']){const res=await fetch(base+route);assert.equal(res.status,401);assert.ok(!(await res.text()).includes('private-canary'));assert.match(res.headers.get('cache-control'),/no-store/);}
 const shell=await fetch(base);assert.equal(shell.status,200);assert.ok(!(await shell.text()).includes('private-canary'));
});
test('local session works and has protected cookie',async t=>{
 const {base,login}=await fixture(t);const {cookie}=await login();
 const res=await fetch(base+'/api/dashboard',{headers:{Cookie:cookie}});assert.equal(res.status,200);assert.equal((await res.json()).repos[0].name,'private-canary');
 const loginRes=await fetch(base+'/api/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{"key":"synthetic-test-key"}'});assert.match(loginRes.headers.get('set-cookie'),/HttpOnly/);assert.match(loginRes.headers.get('set-cookie'),/SameSite=Strict/);
});
test('foreign Origin and Host are rejected before data is returned',async t=>{
 const {base,login}=await fixture(t);const {cookie}=await login();
 assert.equal((await fetch(base+'/api/dashboard',{headers:{Cookie:cookie,Origin:'https://attacker.invalid'}})).status,403);
 const status=await new Promise((resolve,reject)=>{const req=request(base+'/api/dashboard',{headers:{Cookie:cookie,Host:'attacker.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
 assert.equal(status,403);
});
test('mutations require origin and csrf even with session',async t=>{
 const {base,login}=await fixture(t);const {cookie,csrf}=await login();
 const options={method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'};
 assert.equal((await fetch(base+'/api/sync',options)).status,403);
 options.headers.Origin=base;assert.equal((await fetch(base+'/api/sync',options)).status,403);
 options.headers['X-CSRF-Token']=csrf;assert.equal((await fetch(base+'/api/sync',options)).status,202);
});
test('filesystem escape and arbitrary files are never served',async t=>{
 const {base}=await fixture(t);
 for(const route of ['/.env','/package.json','/src/server.mjs','/%2e%2e/secrets','/data.sqlite'])assert.equal((await fetch(base+route)).status,404);
});
test('bad payloads and provider errors are sanitized',async t=>{
 const {base,login,service}=await fixture(t);const {cookie,csrf}=await login();
 const headers={Cookie:cookie,Origin:base,'Content-Type':'application/json','X-CSRF-Token':csrf};
 assert.equal((await fetch(base+'/api/watches',{method:'POST',headers,body:'bad'})).status,400);
 service.addWatch=async()=>{throw new Error('Authorization Bearer do-not-leak /private/path');};
 const res=await fetch(base+'/api/watches',{method:'POST',headers,body:'{"repository":"example/repo","access":"public"}'});assert.equal(res.status,500);assert.ok(!(await res.text()).includes('do-not-leak'));
 assert.equal((await fetch(base+'/api/session',{method:'POST',headers,body:JSON.stringify({key:'wrong'})})).status,401);
});
test('ranges are validated and invalid login attempts are bounded',async t=>{
 const {base,login}=await fixture(t);const {cookie}=await login();
 assert.equal((await fetch(base+'/api/dashboard?range=999999',{headers:{Cookie:cookie}})).status,400);
 let status=0;for(let i=0;i<15;i++)status=(await fetch(base+'/api/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{"key":"bad"}'})).status;
 assert.equal(status,429);
});

test('watch mutation returns one repository wrapper',async t=>{
 const {base,login}=await fixture(t);const {cookie,csrf}=await login();
 const res=await fetch(base+'/api/watches',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{"repository":"example/repo","access":"public"}'});
 assert.equal(res.status,201);assert.equal((await res.json()).repository.id,'42');
});

test('empty repository conflicts retain HTTP 409 with a sanitized response',async t=>{
 const {base,login,service}=await fixture(t);const {cookie,csrf}=await login();
 service.addWatch=async()=>{throw Object.assign(new Error('Git Repository is empty. PRIVATE_ERROR'),{statusCode:409,code:'empty_repository'});};
 const res=await fetch(base+'/api/watches',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{"repository":"example/repo","access":"public"}'});
 assert.equal(res.status,409);assert.ok(!(await res.text()).includes('PRIVATE_ERROR'));
});
