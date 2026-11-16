// Wholly invented publication/test fixtures. Never import the server or runtime.
import {readFile} from 'node:fs/promises';
export const DEMO_ORIGIN='http://observatory-demo.test';
export const DEMO_TIME='2026-04-30T16:00:00Z';
const dates=Array.from({length:30},(_,i)=>`2026-04-${String(i+1).padStart(2,'0')}`);
const labels={commits:'Commits',stars:'Stars',views:'Views',issues:'Open issues',merged_prs:'Merged PRs',releases:'Releases',forks:'Forks',clones:'Clones',star_activity:'Stars gained'};
function metric(key,values,value){
  const balance=['stars','issues','forks'].includes(key);
  return {label:labels[key],kind:balance?'balance':'event',unit:key==='issues'?'open issues':key==='merged_prs'?'pull requests':key.replace('_',' '),value,delta:null,points:dates.map((date,i)=>({date,value:values[i]})),coverage:{start:dates[0],end:dates.at(-1),complete:values.every(v=>v!==null)},status:'ok',lastSuccess:DEMO_TIME,source:balance?'GitHub repository snapshot':'GitHub REST API · UTC daily observations'};
}
export function syntheticDashboard(){
  const identities=[['atlas','northstar-labs','atlas-api','TypeScript',5,842],['orbit','cedar-studio','orbit-ui','TypeScript',2,396],['field','meadow-tools','field-notes','Python',0,128],['ember','cinder-works','ember-cli','Rust',1,215]];
  return {dates:[...dates],updatedAt:DEMO_TIME,collecting:false,credentialConfigured:false,repos:identities.map(([id,owner,name,language,issues,stars],n)=>{
    const daily=(scale,phase=0)=>dates.map((_,i)=>((i*7+n*3+phase)%11<2?0:((i*3+n+phase)%7+1)*scale));
    const commits=daily(n===0?3:1),views=daily(13+n*3,2),clones=daily(2,4),prs=daily(1,1).map(v=>Math.floor(v/3));
    const gains=dates.map((_,i)=>(i+n)%4===0?3:1),releases=dates.map((_,i)=>[8+n,23+n].includes(i)?1:0);
    const sum=values=>values.reduce((a,b)=>a+b,0),balance=(end,step)=>dates.map((_,i)=>end-Math.floor((29-i)/step));
    return {id,owner,name,language,visibility:n===1?'private':'public',archived:false,description:'An entirely fictional project for interface demonstrations.',url:`https://github.com/${owner}/${name}`,metrics:{commits:metric('commits',commits,sum(commits)),stars:metric('stars',balance(stars,2),stars),views:metric('views',views,sum(views)),issues:metric('issues',dates.map((_,i)=>Math.max(0,issues+(i<12?1:0))),issues),merged_prs:metric('merged_prs',prs,sum(prs)),releases:metric('releases',releases,sum(releases)),forks:metric('forks',balance(24+n*7,5),24+n*7),clones:metric('clones',clones,sum(clones)),...(n===2?{}:{star_activity:metric('star_activity',gains,sum(gains))})}};
  })};
}
const issueTitles=['Preserve cursor position when retrying a request','Add an example for scoped access tokens','Clarify pagination limits in the quickstart','Keep keyboard focus after refreshing the list','Improve the empty state for new workspaces'];
export function syntheticDetails(url,dashboard=syntheticDashboard()){
  const key=url.searchParams.get('metric'),r=dashboard.repos.find(r=>r.id===url.searchParams.get('repository'));
  const offset=Number(url.searchParams.get('offset')||0),limit=50;
  const kind=key==='issues'?'snapshot':['commits','merged_prs','releases'].includes(key)?'events':'observations';
  const total=kind==='snapshot'?(r?.metrics.issues.value||0):kind==='events'?(key==='commits'?57:key==='merged_prs'?8:2):0;
  const records=Array.from({length:total},(_,i)=>({id:`${r?.id}-${key}-${i}`,date:kind==='snapshot'?`2026-03-${String(10+i).padStart(2,'0')}`:`2026-04-${String(30-Math.floor(i/3)).padStart(2,'0')}`,title:kind==='snapshot'?`#${101+i} ${issueTitles[i%issueTitles.length]}`:key==='commits'?`Refine ${['request validation','navigation states','documentation examples','release tooling'][i%4]}`:key==='merged_prs'?`Improve ${['keyboard navigation','test coverage','error messages'][i%3]}`:`Release v1.${i+2}.0`,url:`${r?.url}/${key==='issues'?'issues/'+(101+i):key==='merged_prs'?'pull/'+(81+i):key==='releases'?'releases/tag/v1.'+(i+2)+'.0':'commit/'+(i+1).toString(16).padStart(40,'0')}`,author:['demo-avery','demo-robin','demo-kai'][i%3]}));
  return {items:records.slice(offset,offset+limit).map(item=>({...item,actor:{login:item.author,name:'Demo contributor',url:'https://github.com/'+item.author},summary:key==='commits'?'Improve the observed navigation behavior.':null,metadata:key==='commits'?{sha:item.url.split('/').at(-1),branch:'main'}:key==='merged_prs'?{number:81,head:'focus-fix',base:'main',action:'merged'}:{}})),total,hasMore:offset+limit<total,offset,limit,kind,observedAt:DEMO_TIME,status:'ok',complete:kind!=='observations'};
}
export function syntheticEvents(url,dashboard=syntheticDashboard(),count=63){
  const types=['commits','merged_prs','releases','stars','forks','issues','branch_created'];
  const titles=['Preserve focus when navigating repository graphs','Improve keyboard navigation in the project list','Release v1.4.0','Starred repository','Forked repository','Clarify retry behavior in the documentation','Created a release branch'];
  const all=Array.from({length:count},(_,i)=>{
    const r=dashboard.repos[i%dashboard.repos.length],type=types[i%types.length];
    return {id:'demo-event-'+i,repositoryId:r.id,repository:r.owner+'/'+r.name,type,date:`2026-04-${String(30-Math.floor(i/6)).padStart(2,'0')}T12:00:00Z`,title:titles[i%titles.length],url:r.url,summary:i===0?'Keep the active control focused after refreshing.\nHandle missing observations without inventing values.':null,...(i===3?{}:{actor:{login:'demo-avery',name:'Demo Avery',url:'https://github.com/demo-avery'}}),metadata:type==='commits'?{sha:'abc123def456',branch:'main'}:type==='merged_prs'?{number:81,action:'merged',head:'focus-fix',base:'main'}:type==='branch_created'?{ref:'release/v1.4',refType:'branch'}:{},observedAt:DEMO_TIME,source:'Synthetic persisted event'};
  }).filter(event=>{
    const r=dashboard.repos.find(r=>r.id===event.repositoryId),q=url.searchParams;
    return (!q.get('repository')||event.repositoryId===q.get('repository'))&&(!q.get('visibility')||q.get('visibility')==='all'||r.visibility===q.get('visibility'))&&(!q.get('search')||event.repository.toLowerCase().includes(q.get('search').toLowerCase()))&&(!q.has('archived')||r.archived===(q.get('archived')==='true'));
  }).filter(event=>url.searchParams.get('range')!=='7'||event.date>='2026-04-24');
  const offset=Number(url.searchParams.get('offset')||0),limit=50;
  return {events:all.slice(offset,offset+limit),total:all.length,hasMore:offset+limit<all.length,offset,limit,coverage:{complete:false,label:'Collected observations only; actor history may be incomplete.'}};
}
const banner='<aside class="synthetic-banner">Synthetic demo data <span>· Fictional projects, activity and identities</span></aside>';
const demoCSS='\n.synthetic-banner{padding:8px 20px;text-align:center;background:#e9edf3;color:#495b75;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;border-bottom:1px solid #d7dfe9}.metric-dialog .dialog-head h2::after{content:"Synthetic demo data";display:block;color:var(--muted);font-size:11px;font-weight:400;letter-spacing:0;margin-top:6px}@media(max-width:500px){.synthetic-banner span{display:none}}';
// The allowlist serves ONLY public assets. All API requests are fulfilled locally;
// everything else is aborted. No app server, live origin, credentials or storage.
export async function installSyntheticDemo(context,{dashboard=syntheticDashboard(),details,api}={}){
  const calls=[],blocked=[];
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==DEMO_ORIGIN){blocked.push(url.href);return route.abort();}
    const send=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(url.pathname.startsWith('/api/')){
      calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),method:route.request().method()});
      if(api&&await api({url,route,send,calls}))return;
      if(url.pathname==='/api/session')return send({ok:true,csrf:'synthetic-demo-csrf'});
      if(url.pathname==='/api/notifications')return send({items:[],total:0,unreadCount:0,offset:0,limit:50,hasMore:false,snapshot:0,coverage:{complete:false,label:'Synthetic retained events'},status:'ready',updatedAt:null});
      if(url.pathname==='/api/dashboard')return send(dashboard);
      if(url.pathname==='/api/details')return details?details({url,route,send,calls}):send(syntheticDetails(url,dashboard));
      if(url.pathname==='/api/events')return send(syntheticEvents(url,dashboard));
      if(url.pathname==='/api/status')return send({collecting:false,lastSuccess:DEMO_TIME,lastAttempt:DEMO_TIME,runs:[]});
      return send({error:'Not available in synthetic demo'},404);
    }
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(!['index.html','app.js','style.css','metrics.js','icon.svg','favicon.ico','icon-32.png','icon-180.png'].includes(name)){blocked.push(url.href);return route.abort();}
    let body=await readFile(new URL('../public/'+name,import.meta.url),/\.(png|ico)$/.test(name)?undefined:'utf8');
    if(name==='index.html')body=body.replace('<div class="shell">',banner+'<div class="shell">');
    if(name==='style.css')body+=demoCSS;
    return route.fulfill({contentType:name.endsWith('.ico')?'image/x-icon':name.endsWith('.png')?'image/png':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':'text/html',body});
  });
  await context.routeWebSocket('**/*',socket=>socket.close());
  return {calls,blocked,dashboard};
}
