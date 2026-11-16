import {finite, escapeHTML as e, fmt, keys, githubURL, aligned, aggregate, chart, exportCSV} from './metrics.js';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
let unlockKey = new URLSearchParams(location.hash.slice(1)).get('unlock');
if(location.hash) history.replaceState(null,'',location.pathname+location.search);
const query=new URLSearchParams(location.search);
const state={range:['7','30','90','all'].includes(query.get('range'))?query.get('range'):'30',visibility:['public','private'].includes(query.get('visibility'))?query.get('visibility'):'all',data:null,csrf:null,page:'overview',detail:null,chartKeys:['commits','stars','views'],sort:'name',request:0};
let toastTimer, dialogFocus, detailFocus;
const rangeLabel=()=>(state.dataRange || state.range)==='all'?'all stored history':`last ${state.dataRange || state.range} days`;
const dateText=value=>value && !Number.isNaN(Date.parse(value))?new Date(value).toLocaleString():'Not yet collected';
function persist(){const q=new URLSearchParams({range:state.range,visibility:state.visibility});history.replaceState(null,'',location.pathname+'?'+q);}
persist(); // Never persist repository search terms or identifiers.
$('#scope-filter').value=state.visibility;
function notify(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4500);}
function locked(){state.csrf=null;state.data=null;state.detail=null;state.request++;$('#workspace').hidden=true;$('#settings').hidden=true;$('#locked').hidden=false;['#aggregate','#cards','#detail','#events','#collection-content','#dialog-body'].forEach(s=>$(s).replaceChildren());$('#search').value='';$('#scope-summary').textContent='';$('#projects-summary').textContent='';$('#freshness').textContent='';$('#dialog-title').textContent='';$('#dialog').close();}
async function api(path,{method='GET',body,session=false}={}){
  const headers={Accept:'application/json'};
  if(method!=='GET'){headers['Content-Type']='application/json';if(!session)headers['X-CSRF-Token']=state.csrf || '';}
  const response=await fetch(path,{method,headers,credentials:'same-origin',cache:'no-store',mode:'same-origin',signal:AbortSignal.timeout(20000),...(method!=='GET'?{body:JSON.stringify(body ?? {})}:{})});
  if(!response.ok){if(response.status===401&&!session)locked();throw new Error('The request could not be completed. Please try again.');}
  return response.json();
}
async function authenticate(key){
  $('#unlock-message').textContent='';
  try{const session=await api('/api/session',{method:'POST',body:key?{key}:{},session:true});key=null;state.csrf=session.csrf;$('#locked').hidden=true;$('#workspace').hidden=false;$('#settings').hidden=false;await refresh();}
  catch{key=null;locked();$('#unlock-message').textContent='Unable to unlock. Check your local key and try again.';}
}
$('#unlock-form').onsubmit=event=>{event.preventDefault();let key=$('#unlock-key').value;$('#unlock-key').value='';authenticate(key);key=null;};
function filtered(){const term=$('#search').value.trim().toLowerCase();return (state.data?.repos || []).filter(r=>(state.visibility==='all'||r.visibility===state.visibility)&&(!$('#archived').checked||r.archived)&&`${r.owner}/${r.name}`.toLowerCase().includes(term));}
function badges(r){return `<span class="badge ${r.visibility==='private'?'private':''}">${r.visibility==='private'?'Private':'Public'}</span>${r.archived?'<span class="badge archived">Archived</span>':''}`;}
function change(m){return finite(m.delta)?`${m.delta>0?'+':''}${fmt(m.delta)} ${m.kind==='balance'?'in window':'vs prior period'}`:'';}
function errorStatus(status){return /^(error|failed|failure|rate_limited|rate-limited|forbidden|unauthorized|unavailable|upstream_error|invalid_response|network_error|timeout|partial)$/.test(status || '');}
function renderAggregates(repos){
  const available=[...new Set(repos.flatMap(keys))].map(key=>[key,aggregate(repos,key,state.data.dates)]).filter(([,m])=>m);
  const map=new Map(available),used=new Set();
  const selected=state.chartKeys.map(key=>{const next=map.has(key)&&!used.has(key)?key:available.find(([k])=>!used.has(k))?.[0];if(next)used.add(next);return next;});
  $('#aggregate').innerHTML=selected.map((key,slot)=>{if(!key)return '';const m=map.get(key);return `<section class="panel aggregate-panel" data-aggregate="${e(key)}"><div class="aggregate-header"><select class="metric-select" data-slot="${slot}" aria-label="Aggregate chart ${slot+1} metric">${available.map(([k,v])=>`<option value="${e(k)}" ${k===key?'selected':''}>${e(v.label)}</option>`).join('')}</select><button class="scope-button" data-aggregate-detail="${e(key)}">${m.contributors.length} projects ↗</button></div><div class="aggregate-value"><strong>${fmt(m.value)}</strong><span class="metric-unit">${e(m.unit)}</span></div><div class="change">${e(change(m))}</div><div class="large-chart" role="img" aria-label="${e(m.label)} · ${e(rangeLabel())}">${chart(m.points)}</div><div class="aggregate-footer">${m.kind==='balance'?'Observed balance':'Daily observations'}</div></section>`;}).join('');
  $$('.metric-select').forEach(select=>select.onchange=()=>{const slot=Number(select.dataset.slot),old=selected[slot],duplicate=selected.indexOf(select.value);state.chartKeys=[...selected];if(duplicate>=0&&duplicate!==slot)state.chartKeys[duplicate]=old;state.chartKeys[slot]=select.value;renderAggregates(filtered());});
  $$('[data-aggregate-detail]').forEach(button=>button.onclick=()=>{const m=map.get(button.dataset.aggregateDetail);openDialog(m.label,metricDetail(m)+`<h3>Included projects</h3><ul class="source-list">${m.contributors.map(r=>`<li>${e(r.owner)}/${e(r.name)}</li>`).join('')}</ul><p class="tiny">${m.contributors.length} of ${repos.length} filtered projects. Totals use a fixed group with compatible observed coverage; gaps remain unknown.</p>`);});
}
function renderCards(repos){
  const columns=[...new Set(repos.flatMap(keys))],labels=new Map(repos.flatMap(r=>keys(r).map(k=>[k,r.metrics[k].label])));
  const sorted=[...repos].sort((a,b)=>state.sort==='name'?a.name.localeCompare(b.name):(finite(b.metrics?.commits?.value)?b.metrics.commits.value:-Infinity)-(finite(a.metrics?.commits?.value)?a.metrics.commits.value:-Infinity)||a.name.localeCompare(b.name));
  $('#cards').style.setProperty('--metric-count',Math.max(1,columns.length));
  $('#cards').classList.toggle('many-metrics',columns.length>8);
  $('#cards').innerHTML=(repos.length?`<div class="project-column-head" aria-hidden="true"><span>Repository</span><div class="column-labels">${columns.map(k=>`<span>${e(labels.get(k))}</span>`).join('')}</div><span class="column-visibility">Visibility</span></div>`:'')+sorted.map(r=>`<article class="panel project-card" data-project="${e(r.id)}"><header class="project-header"><div class="project-heading"><div class="owner">${e(r.owner)}</div><button class="project-name" data-repo="${e(r.id)}" title="${e(r.owner+'/'+r.name)}">${e(r.name)}</button><div class="project-footer">${e(r.language)}</div></div><div class="badges">${badges(r)}</div></header><div class="metric-grid">${columns.filter(k=>keys(r).includes(k)).map(k=>{const m=r.metrics[k];return `<button class="spark-metric" data-repo="${e(r.id)}" data-metric="${e(k)}" style="--metric-position:${columns.indexOf(k)+1}" aria-label="${e(r.name+': '+m.label+', '+fmt(m.value))}"><span class="spark-label">${e(m.label)}</span><span class="spark-value">${fmt(m.value)}</span><span class="spark-chart">${chart(aligned(m,state.data.dates),{small:true})}</span><span class="spark-caption">${e(change(m))}</span></button>`;}).join('')}</div></article>`).join('')||`<div class="empty panel"><h3>${state.data.repos.length?'No matching projects':'Your observatory is ready'}</h3><p>${state.data.repos.length?'Try another search or visibility filter.':'Watch a repository to start collecting real history.'}</p><button id="empty-add">+ Watch repo</button></div>`;
  $$('[data-repo]').forEach(button=>button.onclick=()=>openRepo(button.dataset.repo,button.dataset.metric));
  if($('#empty-add'))$('#empty-add').onclick=openConnections;
}
function render(){
  if(!state.data)return;
  const repos=filtered();$('#scope-summary').textContent=`${repos.length} projects · ${rangeLabel()}`;$('#projects-summary').textContent=`${repos.length} watched projects`;
  $$('[data-range]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.range===(state.dataRange || state.range))));
  $('#freshness').textContent=`Stored data: ${dateText(state.data.updatedAt)}${state.data.collecting?' · Collection running':''}`;
  $('#sync').textContent=state.data.collecting?'Collecting…':'Sync now';$('#sync').disabled=!!state.data.collecting;
  renderAggregates(repos);renderCards(repos);if(state.page==='detail')renderDetail();
}
async function refresh(){
  if(!state.csrf)return;
  const request=++state.request,range=state.range;
  try{
    const data=await api('/api/dashboard?range='+encodeURIComponent(range));if(request!==state.request||!state.csrf)return;
    const changed=state.dataRange!==range || JSON.stringify(state.data)!==JSON.stringify(data);
    state.data=data;state.dataRange=range;$('#error').hidden=true;
    if(changed){
      const focus=document.activeElement,repo=focus?.dataset.repo,metric=focus?.dataset.metric,detailMetric=focus?.dataset.detailMetric;
      const tableOpen=$('#detail details')?.open;
      render();
      if(tableOpen&&$('#detail details'))$('#detail details').open=true;
      if(repo)$$('[data-repo]').find(b=>b.dataset.repo===repo&&b.dataset.metric===metric)?.focus({preventScroll:true});
      else if(detailMetric)$$('[data-detail-metric]').find(b=>b.dataset.detailMetric===detailMetric)?.focus({preventScroll:true});
    }
    return data;
  }
  catch{if(request===state.request&&state.csrf){if(state.dataRange){state.range=state.dataRange;persist();}$('#error').textContent='Refresh failed. Previously collected data is unchanged. Try Sync now or wait for the next refresh.';$('#error').hidden=false;}}
}
function showPage(page,focus=true){state.page=page;['overview','detail','activity','collection'].forEach(id=>$('#'+id).hidden=id!==page);$$('[data-page]').forEach(b=>{const active=b.dataset.page===(page==='detail'?'overview':page);b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});$('#page-title').textContent={overview:'Aggregate',detail:'Project history',activity:'Activity',collection:'Collection'}[page];if(focus)$('#page-title').focus();if(page==='activity')loadEvents();if(page==='collection')loadStatus();}
function metricDetail(m){const points=aligned(m,state.data.dates),count=points.filter(p=>finite(p.value)).length;return `<section class="panel detail-panel"><div class="detail-chart-top"><div><h2>${e(m.label)}</h2><p>${e(rangeLabel())}</p></div><strong>${fmt(m.value)} <small>${e(m.unit)}</small></strong></div><div class="large-chart" role="img" aria-label="${e(m.label)} observations">${chart(points)}</div><p class="change">${e(change(m))}</p><dl class="provenance"><div><dt>Source</dt><dd>${e(m.source)}</dd></div><div><dt>Coverage</dt><dd>${count} of ${points.length} days${m.coverage?.start?' · '+e(m.coverage.start)+' to '+e(m.coverage.end):''}${m.coverage?.complete?' · complete':' · partial'}</dd></div><div><dt>Last collected</dt><dd>${e(dateText(m.lastSuccess))}</dd></div>${errorStatus(m.status)?'<div><dt>Collection</dt><dd class="error">Latest collection failed; previous observations retained.</dd></div>':''}</dl><details><summary>Observation table</summary><div class="table-wrap"><table><caption>${e(m.label)} · ${e(rangeLabel())}</caption><thead><tr><th scope="col">Date</th><th scope="col">${e(m.unit)}</th></tr></thead><tbody>${points.map(p=>`<tr><th scope="row">${e(p.date)}</th><td>${finite(p.value)?fmt(p.value):'Not observed'}</td></tr>`).join('')}</tbody></table></div></details></section>`;}
function openRepo(id,key){detailFocus=document.activeElement;state.detail={id,key};showPage('detail');renderDetail();}
function renderDetail(){
  const r=state.data.repos.find(r=>r.id===state.detail?.id);if(!r){showPage('overview');return;}
  const available=keys(r);if(!available.includes(state.detail.key))state.detail.key=available[0];const m=r.metrics[state.detail.key],url=githubURL(r.url);
  $('#detail').innerHTML=`<button class="back" id="back">← All projects</button><div class="detail-title-row"><div><div class="owner">${e(r.owner)}</div><h2>${e(r.name)}</h2><p>${e(r.description)}</p>${url?`<a href="${e(url)}" target="_blank" rel="noopener noreferrer">View on GitHub ↗</a>`:''}</div><div class="badges">${badges(r)}</div></div><div class="detail-summary">${available.map(k=>`<button data-detail-metric="${e(k)}" aria-pressed="${k===state.detail.key}">${e(r.metrics[k].label)}</button>`).join('')}</div>${m?metricDetail(m):'<p class="empty">No observations collected yet.</p>'}<div class="detail-actions"><button id="pause">Pause watch</button><p class="tiny">Stop future collection without deleting stored history.</p></div>`;
  $('#back').onclick=()=>{showPage('overview');if(detailFocus?.isConnected)detailFocus.focus();else $$('[data-repo]').find(b=>b.dataset.repo===r.id)?.focus();};
  $$('[data-detail-metric]').forEach(b=>b.onclick=()=>{state.detail.key=b.dataset.detailMetric;renderDetail();$$('[data-detail-metric]').find(x=>x.dataset.detailMetric===state.detail.key)?.focus();});
  $('#pause').onclick=()=>openDialog('Pause this watch?',`<p>Pause collection for <strong>${e(r.owner+'/'+r.name)}</strong>? Stored history is kept.</p><button id="confirm-pause" class="primary">Pause collection</button>` ,()=>{$('#confirm-pause').onclick=()=>mutation($('#confirm-pause'),async()=>{await api('/api/watches/'+encodeURIComponent(r.id)+'/pause',{method:'POST',body:{}});const data=await refresh(),updated=data?.repos.find(repo=>repo.id===r.id),paused=updated&&Object.values(updated.metrics).some(metric=>metric.status==='paused');$('#dialog').close();notify(paused?'Watch paused. Stored history is retained.':'Pause request accepted. Check Collection to confirm its status.');});});
}
function openDialog(title,html,setup){dialogFocus=document.activeElement;$('#dialog-title').textContent=title;$('#dialog-body').innerHTML=html;$('#dialog-message').textContent='';if(!$('#dialog').open)$('#dialog').showModal();setup?.();$('#close').focus();}
$('#close').onclick=()=>$('#dialog').close();$('#dialog').addEventListener('close',()=>{if(!state.csrf){$('#unlock-key').focus();return;}if(dialogFocus?.isConnected)dialogFocus.focus();else if(dialogFocus?.id&&document.getElementById(dialogFocus.id))document.getElementById(dialogFocus.id).focus();else $('#page-title').focus();});
async function mutation(button,work){button.disabled=true;try{await work();}catch{if(state.csrf){const message='The request could not be completed. Please try again.';if($('#dialog').open)$('#dialog-message').textContent=message;else notify(message);}}finally{if(button.isConnected)button.disabled=button.id==='sync'&&!!state.data?.collecting;}}
function openConnections(){
  openDialog('Connections & watches',`<p>Watch a public repository anonymously, or choose owned repositories from your existing local connection. No GitHub token is entered in this browser.</p><form id="watch-form"><label for="repository">Public repository URL or owner/repository</label><input id="repository" required autocomplete="off" spellcheck="false" placeholder="owner/repository"><button class="primary" type="submit">Add public watch</button></form><section class="connection-section"><h3>Existing connection</h3><p>${state.data?.credentialConfigured?'A local credential is configured. Choose repositories explicitly.':'No local credential is configured. Public watches are available.'}</p><button id="discover" ${state.data?.credentialConfigured?'':'disabled'}>Choose owned repositories</button><div id="discovery"></div></section>`,()=>{
    $('#watch-form').onsubmit=event=>{event.preventDefault();const value=$('#repository').value.trim();let valid=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);try{const u=new URL(value);valid=!!githubURL(value)&&/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(u.pathname)&&!u.hash&&!u.search;}catch{}if(!valid){$('#dialog-message').textContent='Use owner/repository or an HTTPS github.com repository URL.';return;}mutation($('#watch-form button'),async()=>{const result=await api('/api/watches',{method:'POST',body:{repository:value,access:'public'}}),data=await refresh();if(!$('#repository'))return;$('#repository').value='';$('#dialog-message').textContent=data?.repos.some(r=>r.id===result.repository.id)?'Public watch added.':'Request accepted. Refresh to confirm the stored watch.';});};
    $('#discover').onclick=()=>mutation($('#discover'),loadDiscover);
  });
}
async function loadDiscover(){
  const data=await api('/api/discover');if(!$('#discovery'))return;
  if(data.status&&!['ok','partial'].includes(data.status)){$('#discovery').textContent='Repository discovery could not be completed. Please try again.';return;}
  $('#discovery').innerHTML=data.repositories.map((r,i)=>`<div class="discovery-row"><div><strong>${e(r.owner+'/'+r.name)}</strong><div class="badges">${badges(r)}</div></div><button data-add-owned="${i}" ${r.watched?'disabled':''}>${r.watched?'Watching':'Add'}</button></div>`).join('')||'<p class="empty">No owned repositories were returned.</p>';
  if(data.complete===false)$('#discovery').insertAdjacentHTML('afterbegin','<p class="notice">Showing available owned repositories; discovery is incomplete.</p>');
  $$('[data-add-owned]').forEach(b=>b.onclick=()=>mutation(b,async()=>{const r=data.repositories[Number(b.dataset.addOwned)],result=await api('/api/watches',{method:'POST',body:{repository:r.owner+'/'+r.name,access:'token'}});const [updated]=await Promise.all([refresh(),loadDiscover()]);$('#dialog-message').textContent=updated?.repos.some(repo=>repo.id===result.repository.id)?'Repository watch added.':'Request accepted. Refresh to confirm the stored watch.';}));
}
async function loadEvents(){
  $('#events').textContent='Loading activity…';
  try{const {events}=await api('/api/events?limit=100');if(!state.csrf)return;$('#events').innerHTML=events.map(event=>{const url=githubURL(event.url);return `<article class="panel event"><div class="tiny">${e(event.repository)} · ${e(event.type)} · ${e(dateText(event.date))}</div><h2>${url?`<a href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(event.title)}</a>`:e(event.title)}</h2>${event.author?`<p>${e(event.author)}</p>`:''}</article>`;}).join('')||'<p class="empty">No activity has been collected yet.</p>';}
  catch{if(state.csrf)$('#events').textContent='Activity could not be loaded. Please try again.';}
}
async function loadStatus(){
  $('#collection-content').textContent='Loading collection status…';
  try{const status=await api('/api/status');if(!state.csrf)return;$('#collection-content').innerHTML=`<section class="panel pad"><h2>${status.collecting?'Collection running':'Collection schedule'}</h2><dl class="provenance"><div><dt>Last attempt</dt><dd>${e(dateText(status.lastAttempt))}</dd></div><div><dt>Last success</dt><dd>${e(dateText(status.lastSuccess))}</dd></div>${status.nextRun?`<div><dt>Next run</dt><dd>${e(dateText(status.nextRun))}</dd></div>`:''}</dl></section><div class="timeline">${(status.runs||[]).map(run=>`<article class="panel event"><h3>${e(run.repository)} · ${e(run.metric)}</h3><p class="${errorStatus(run.status)?'error':''}">${e(run.status)}</p><p class="tiny">Attempt: ${e(dateText(run.lastAttempt))} · Last success: ${e(dateText(run.lastSuccess))}</p>${run.message?`<p>${e(run.message)}</p>`:''}</article>`).join('')||'<p class="empty">No collection attempts yet.</p>'}</div>`;}
  catch{if(state.csrf)$('#collection-content').textContent='Collection status could not be loaded. Please try again.';}
}
$('#settings').onclick=openConnections;$('#add').onclick=openConnections;
$$('[data-page]').forEach(b=>b.onclick=()=>showPage(b.dataset.page));
$$('[data-range]').forEach(b=>b.onclick=async()=>{if(state.range===b.dataset.range)return;state.range=b.dataset.range;persist();await refresh();});
$('#search').oninput=render;$('#scope-filter').onchange=()=>{state.visibility=$('#scope-filter').value;persist();render();};$('#archived').onchange=render;
$('#sort').onclick=()=>{state.sort=state.sort==='name'?'activity':'name';$('#sort').textContent=state.sort==='name'?'Sort: name':'Sort: activity ↓';renderCards(filtered());};
$('#sync').onclick=()=>mutation($('#sync'),async()=>{const result=await api('/api/sync',{method:'POST',body:{}});notify(result.started?'Collection started. New observations will appear automatically.':'Collection is already running.');await refresh();});
$('#reload-events').onclick=loadEvents;$('#reload-status').onclick=loadStatus;
$('#export').onclick=()=>{const blob=new Blob([exportCSV(filtered(),state.dataRange || state.range)],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='github-observatory.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
function setTheme(light){document.body.classList.toggle('light',light);$('#theme').setAttribute('aria-label',light?'Switch to dark theme':'Switch to light theme');}
try{setTheme(localStorage.getItem('github-observatory-theme')!=='dark');}catch{setTheme(true);}
$('#theme').onclick=()=>{setTheme(!document.body.classList.contains('light'));try{localStorage.setItem('github-observatory-theme',document.body.classList.contains('light')?'light':'dark');}catch{}};
setInterval(()=>{if(state.csrf&&!document.hidden){refresh();if(state.page==='activity')loadEvents();if(state.page==='collection')loadStatus();}},30000);
authenticate(unlockKey);unlockKey=null;
