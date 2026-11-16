import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const safeEqual=(a,b)=>timingSafeEqual(createHash('sha256').update(String(a)).digest(),createHash('sha256').update(String(b)).digest());
function problem(statusCode,message){return Object.assign(new Error(message),{statusCode,local:true});}
function rangeOf(url){const range=url.searchParams.get('range')||'30';if(!['7','30','90','all'].includes(range))throw problem(400,'Invalid date range.');return range;}
function csvCell(value){let s=String(value??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
function publicFiles(directory){
 const files=new Map();
 function walk(dir){for(const name of readdirSync(dir)){const path=join(dir,name),stat=lstatSync(path);if(stat.isSymbolicLink())continue;if(stat.isDirectory()){walk(path);continue;}const ext=name.slice(name.lastIndexOf('.'));if(!MIME[ext]||stat.size>4*1024*1024)continue;const route='/'+relative(directory,path).replaceAll('\\','/');files.set(route,{content:readFileSync(path),type:MIME[ext]});}}
 walk(directory);if(files.has('/index.html'))files.set('/',files.get('/index.html'));return files;
}
async function jsonBody(req){
 if(!String(req.headers['content-type']||'').startsWith('application/json'))throw problem(415,'Use JSON requests.');
 if(Number(req.headers['content-length']||0)>16384)throw problem(413,'Request too large.');
 let n=0;const chunks=[];for await(const chunk of req){n+=chunk.length;if(n>16384)throw problem(413,'Request too large.');chunks.push(chunk);}
 try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!value||Array.isArray(value)||typeof value!=='object')throw new Error();return value;}catch{throw problem(400,'Invalid JSON request.');}
}

export function createServer({service,publicDir,unlockKey,logger=()=>{},now=()=>Date.now()}){
 if(typeof unlockKey!=='string'||!unlockKey)throw new Error('Local unlock key required.');
 const files=publicFiles(publicDir),sessions=new Map();let failures=[];let syncing=false;
 const server=http.createServer(async(req,res)=>{
  const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",'Permissions-Policy':'camera=(), microphone=(), geolocation=()'};
  const send=(code,payload,type='application/json; charset=utf-8',extra={})=>{res.writeHead(code,{...headers,'Content-Type':type,...extra});res.end(type.startsWith('application/json')?JSON.stringify(payload):payload);};
  try{
   const port=server.address()?.port;
   const validHosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
   const host=String(req.headers.host||'');if(!validHosts.has(host))throw problem(403,'Request not permitted.');
   const origin=`http://${host}`;
   if(req.headers.origin&&req.headers.origin!==origin)throw problem(403,'Request not permitted.');
   const url=new URL(req.url,origin),route=url.pathname;
   if(req.method==='GET'&&route==='/health'){send(200,{status:'running'});return;}
   const cookie=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('observatory_session='))?.slice('observatory_session='.length);
   const session=cookie&&sessions.get(cookie);
   const authenticated=Boolean(session&&session.expires>now());
   if(cookie&&session&&!authenticated)sessions.delete(cookie);
   if(req.method==='POST'&&route==='/api/session'){
    if(req.headers.origin!==origin)throw problem(403,'Request not permitted.');
    const body=await jsonBody(req);
    if(authenticated&&!body.key){send(200,{ok:true,csrf:session.csrf});return;}
    failures=failures.filter(t=>now()-t<60000);
    if(failures.length>=12)throw problem(429,'Too many unlock attempts. Try again in a minute.');
    if(typeof body.key!=='string'||!safeEqual(body.key,unlockKey)){failures.push(now());throw problem(401,'Unlock required.');}
    for(const [id,s] of sessions)if(s.expires<=now())sessions.delete(id);
    while(sessions.size>=10)sessions.delete(sessions.keys().next().value);
    const id=randomBytes(32).toString('base64url'),csrf=randomBytes(24).toString('base64url');
    sessions.set(id,{csrf,expires:now()+12*60*60*1000});
    send(200,{ok:true,csrf},undefined,{'Set-Cookie':`observatory_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`});return;
   }
   if(route.startsWith('/api/')){
    if(!authenticated)throw problem(401,'Unlock required.');
    if(req.method!=='GET'){
     if(req.headers.origin!==origin||typeof req.headers['x-csrf-token']!=='string'||!safeEqual(req.headers['x-csrf-token'],session.csrf))throw problem(403,'Request not permitted.');
    }
    if(req.method==='GET'&&route==='/api/dashboard'){send(200,service.dashboard(rangeOf(url)));return;}
    if(req.method==='GET'&&route==='/api/status'){send(200,service.status());return;}
    if(req.method==='GET'&&route==='/api/events'){
     const limit=Number(url.searchParams.get('limit')||100);if(!Number.isInteger(limit)||limit<1||limit>500)throw problem(400,'Invalid event limit.');send(200,service.events(limit));return;
    }
    if(req.method==='GET'&&route==='/api/discover'){send(200,await service.discover());return;}
    if(req.method==='POST'&&route==='/api/watches'){
     const body=await jsonBody(req);if(typeof body.repository!=='string'||body.repository.length>250||!['public','token'].includes(body.access))throw problem(400,'Specify a repository and access mode.');
     const result=await service.addWatch({repository:body.repository,access:body.access});send(201,result);return;
    }
    const paused=route.match(/^\/api\/watches\/([0-9]+)\/pause$/);
    if(req.method==='POST'&&paused){await jsonBody(req);await service.pauseWatch(paused[1]);send(200,{ok:true});return;}
    if(req.method==='POST'&&route==='/api/sync'){
     await jsonBody(req);const started=!syncing&&!service.status().collecting;
     if(started){syncing=true;Promise.resolve().then(()=>service.sync()).catch(()=>logger('Collection attempt failed; inspect local collection status.')).finally(()=>{syncing=false;});}
     send(202,{started});return;
    }
    if(req.method==='GET'&&route==='/api/export'){
     const data=service.dashboard(rangeOf(url)),rows=[['repository','visibility','metric','kind','value','date','source']];
     for(const repo of data.repos)for(const [key,metric] of Object.entries(repo.metrics))for(const point of metric.points||[])if(point.value!==null)rows.push([repo.owner+'/'+repo.name,repo.visibility,key,metric.kind,point.value,point.date,metric.source]);
     send(200,rows.map(row=>row.map(csvCell).join(',')).join('\r\n'),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="github-observatory.csv"'});return;
    }
    throw problem(404,'Not found.');
   }
   const file=files.get(route);
   if(req.method==='GET'&&file){send(200,file.content,file.type);return;}
   throw problem(404,'Not found.');
  }catch(error){
   const code=error.local?error.statusCode:[400,401,403,404,409,422,429,503].includes(error.statusCode)?error.statusCode:500;
   const message=error.local?error.message:({400:'Invalid repository request.',401:'GitHub authorization unavailable.',403:'GitHub access denied.',404:'Repository not found or not accessible.',409:'Request conflicts with current state.',422:'Repository request could not be processed.',429:'GitHub rate limit reached. Try later.',503:'GitHub is temporarily unavailable.'}[code]||'Request failed. Inspect local collection status.');
   if(!res.headersSent)send(code,{error:message});else res.end();
   if(code>=500)logger('Request failed (details withheld for privacy).');
  }
 });
 server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=1000;server.maxHeadersCount=50;
 return server;
}
