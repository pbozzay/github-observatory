import {observed, missingMetric, unavailableReason, collectionWarning, finite, escapeHTML as e, fmt, keys, githubURL, githubMetricAction, aligned, aggregate, chart, chartView, exportCSV, presentRepository, issueLevel, validateThresholds, validateChartKeys, CARD_METRICS, DEFAULT_CHART_KEYS, compareRepositories, validateRowKeys, collectionProblem as errorStatus} from './metrics.js';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const authMode=document.documentElement.dataset.authMode==='proxy'?'proxy':'local';
let connecting=false;
let unlockKey = authMode==='local'?new URLSearchParams(location.hash.slice(1)).get('unlock'):null;
if(location.hash) history.replaceState(null,'',location.pathname+location.search);
const query=new URLSearchParams(location.search);
const state={range:['7','30','90','all'].includes(query.get('range'))?query.get('range'):'30',visibility:['public','private'].includes(query.get('visibility'))?query.get('visibility'):'all',data:null,csrf:null,page:'overview',detail:null,chartKeys:[...DEFAULT_CHART_KEYS],sort:'activity',rowKeys:null,request:0};
const preferencesKey='github-observatory-preferences',chartModeKey='github-observatory-chart-mode';
state.graphMode='cumulative';
state.starMode='total';
state.showGraphLabels=true;
try{if(localStorage.getItem(chartModeKey)==='daily')state.graphMode='daily';}catch{}
state.issueThresholds={warning:1,danger:3};
try{const saved=JSON.parse(localStorage.getItem(preferencesKey));state.issueThresholds=validateThresholds(saved)||state.issueThresholds;state.chartKeys=validateChartKeys(saved?.chartKeys)||state.chartKeys;state.rowKeys=validateRowKeys(saved?.rowKeys);state.starMode=saved?.starMode==='gained'?'gained':'total';state.showGraphLabels=saved?.showGraphLabels!==false;if(['name','activity'].includes(saved?.sort))state.sort=saved.sort;}catch{}
function savePreferences(){try{localStorage.setItem(preferencesKey,JSON.stringify({...state.issueThresholds,chartKeys:state.chartKeys,rowKeys:state.rowKeys,sort:state.sort,starMode:state.starMode,showGraphLabels:state.showGraphLabels}));return true;}catch{return false;}}
const issueClass=(key,m)=>key==='issues'&&issueLevel(m.value,state.issueThresholds)?'issue-'+issueLevel(m.value,state.issueThresholds):'';
const issueHint=(key,m)=>issueClass(key,m)?issueLevel(m.value,state.issueThresholds)+' threshold exceeded':'';
let toastTimer, dialogFocus, detailFocus, drilldown, activity, statusRequest=0, dialogSession=0;
// DOM IDs are reused; only the session that started work may update dialog UI.
const dialogActive=session=>()=>session===dialogSession&&$('#dialog').open&&!!state.csrf;
function cancelActivity(){activity?.controller.abort();activity=null;$('#activity').setAttribute('aria-busy','false');}
function cancelDrilldown(){drilldown?.controller?.abort();drilldown=null;}
const rangeLabel=()=>(state.dataRange || state.range)==='all'?'all stored history':`last ${state.dataRange || state.range} days`;
const dateText=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)?value:value && !Number.isNaN(Date.parse(value))?new Date(value).toLocaleString():'Not yet collected';
function persist(){const q=new URLSearchParams({range:state.range,visibility:state.visibility});history.replaceState(null,'',location.pathname+'?'+q);}
persist(); // Never persist repository search terms or identifiers.
$('#scope-filter').value=state.visibility;
function notify(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4500);}
function sessionView(view,message=''){
  const pending=view==='pending',needsKey=view==='key'&&authMode==='local';
  $('#locked').setAttribute('aria-busy',String(pending));
  $('#session-title').textContent=pending?'Connecting…':needsKey?'Unlock observatory':'Connection needed';
  $('#session-description').textContent=pending?'Establishing your browser session.':needsKey?'Enter your local unlock key to continue.':'Reconnect to establish a browser session. If retry fails, reload this page to sign in through your host.';
  $('#unlock-form').hidden=!needsKey;$('#session-retry').hidden=pending||needsKey;
  $('#unlock-message').textContent=message;
}
function locked(expired=true){dialogSession++;cancelDrilldown();cancelActivity();statusRequest++;$('#events-state').textContent='';$('#events-more').hidden=true;clearTimeout(toastTimer);$('#toast').hidden=true;$('#toast').textContent='';state.csrf=null;state.data=null;state.detail=null;state.request++;$('#workspace').hidden=true;$('#settings').hidden=true;$('#locked').hidden=false;['#aggregate','#cards','#detail','#events','#collection-content','#dialog-body'].forEach(s=>$(s).replaceChildren());$('#search').value='';$('#scope-summary').textContent='';$('#projects-summary').textContent='';$('#freshness').textContent='';$('#dialog-title').textContent='';$('#dialog-message').textContent='';$('#unlock-key').value='';$('#dialog').close();if(expired)sessionView(authMode==='local'?'key':'retry','Your session expired. Reconnect to continue.');}
async function api(path,{method='GET',body,session=false,signal}={}){
  const headers={Accept:'application/json'};
  if(method!=='GET'){headers['Content-Type']='application/json';if(!session)headers['X-CSRF-Token']=state.csrf || '';}
  const response=await fetch(path,{method,headers,credentials:'same-origin',cache:'no-store',mode:'same-origin',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000),...(method!=='GET'?{body:JSON.stringify(body ?? {})}:{})});
  if(!response.ok){if(response.status===401&&!session)locked();throw Object.assign(new Error('The request could not be completed. Please try again.'),{status:response.status});}
  return response.json();
}
async function authenticate(key){
  if(connecting)return;
  connecting=true;sessionView('pending');
  const submittedKey=authMode==='local'&&!!key;
  try{
    const session=await api('/api/session',{method:'POST',body:submittedKey?{key}:{},session:true});key=null;
    if(typeof session.csrf!=='string'||!session.csrf)throw Error('Invalid session');
    state.csrf=session.csrf;$('#locked').hidden=true;$('#workspace').hidden=false;$('#settings').hidden=false;await refresh();
  }catch(error){
    key=null;locked(false);
    if(authMode==='local'&&error.status===401)sessionView('key',submittedKey?'Unable to unlock. Check your local key and try again.':'A local unlock key is required for this browser.');
    else sessionView('retry','Unable to connect. Please retry the connection.');
  }finally{key=null;connecting=false;}
}
$('#session-retry').onclick=()=>authenticate();
$('#unlock-form').onsubmit=event=>{event.preventDefault();let key=$('#unlock-key').value;$('#unlock-key').value='';authenticate(key);key=null;};
function filtered(){const term=$('#search').value.trim().toLowerCase();return (state.data?.repos || []).filter(r=>(state.visibility==='all'||r.visibility===state.visibility)&&(!$('#archived').checked||r.archived)&&`${r.owner}/${r.name}`.toLowerCase().includes(term));}
function visibilityIcon(r){const privateRepo=r.visibility==='private',label=privateRepo?'Private repository':'Public repository';return `<span class="visibility-icon" role="img" aria-label="${label}" title="${label}"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${privateRepo?'<path d="M9.5 5.3A12 12 0 0 1 12 5c6 0 10 7 10 7a19 19 0 0 1-3.3 4.1M6.2 6.2A23 23 0 0 0 2 12s4 7 10 7a12 12 0 0 0 5.8-1.8"/><path d="M10 10a3 3 0 0 0 4 4"/><path class="eye-slash" d="m3 3 18 18"/>':'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'}</svg></span>`;}
function badges(r){return r.archived?'<span class="badge archived">Archived</span>':'';}
function change(m){return finite(m.delta)?`${m.delta>0?'+':''}${fmt(m.delta)} ${m.kind==='balance'?'in window':'vs prior period'}`:'';}
function metricFor(repo,key){return observed(repo.metrics?.[key])?{...repo.metrics[key],collectionWarning:collectionWarning(repo,key)}:missingMetric(repo,key);}
function placeholder(reason){return `<span class="metric-placeholder"><span class="unavailable-baseline" aria-hidden="true"></span><span class="unavailable-label">${e(reason)}</span></span>`;}
function metricGraph(m,g,options){return g.points.some(p=>finite(p.value))?chart(g.points,options):placeholder(m.unavailableReason||m.chartUnavailableReason||(m.chartComparable===false?'History not comparable':observed(m)?'No observations in this range':'Not collected yet'));}
function aggregateMetric(repos,key){
  const m=aggregate(repos,key,state.data.dates);
  if(m){
    const warnings=new Map();
    for(const repo of repos){const warning=collectionWarning(repo,key);if(warning)warnings.set(warning,(warnings.get(warning)||0)+1);}
    return {...m,collectionWarning:[...warnings].map(([label,count])=>`${label}: ${count} of ${repos.length} projects`).join(' · ')};
  }
  const reasons=[...new Set(repos.map(r=>unavailableReason(r,key)))];
  return {...missingMetric({},key),unavailableReason:reasons.join(' · ')||'Not collected yet',contributors:[],chartContributors:[]};
}
function graphNote(m,repos){
  const notes=m.collectionWarning?[m.collectionWarning]:[];
  if(m.chartComparable===false)notes.push('Latest balances not comparable · different or unknown observation dates');
  if(m.chartContributors?.length<m.contributors?.length)notes.push(`Graph: ${m.chartContributors.length} of ${m.contributors.length} counted projects`);
  if(m.contributors?.length<repos.length)notes.push(`Incomplete count: ${m.contributors.length} of ${repos.length} projects`);
  return notes.length?' · '+notes.join(' · '):'';
}
function setStarMode(mode){
  state.starMode=mode==='gained'?'gained':'total';
  if(state.data)state.data.repos=state.data.repos.map(r=>presentRepository(r,state.starMode));
}
function renderAggregates(repos){
  const available=Object.keys(CARD_METRICS).map(key=>[key,aggregateMetric(repos,key)]);
  const map=new Map(available);
  const selected=state.chartKeys;
  $('#aggregate').style.setProperty('--summary-count',Math.max(1,selected.filter(Boolean).length));
  $('#aggregate').innerHTML=selected.map((key,slot)=>{if(!key)return '';const m=map.get(key),g=chartView(m,state.data.dates,state.graphMode);return `<section class="panel aggregate-panel" data-aggregate="${e(key)}"><div class="aggregate-header"><span class="metric-picker"><span class="metric-selected-label" aria-hidden="true">${e(m.label)}</span><select class="metric-select" data-slot="${slot}" aria-label="Aggregate chart ${slot+1} metric">${available.map(([k,v])=>`<option value="${e(k)}" ${k===key?'selected':''}>${e(v.label)}</option>`).join('')}</select></span><button class="scope-button" data-aggregate-detail="${e(key)}" aria-haspopup="dialog">${m.contributors.length} projects ↗</button></div><button class="aggregate-value ${issueClass(key,m)}" data-aggregate-detail="${e(key)}" aria-haspopup="dialog" aria-label="Inspect ${e(m.label)} count and project contributions" title="${e(issueHint(key,m))}"><strong>${finite(m.value)?fmt(m.value):'—'}</strong><span class="metric-unit">${e(m.countLabel||m.unit)}</span></button><div class="change">${e(change(m))}</div><button class="large-chart chart-button" data-aggregate-detail="${e(key)}" aria-haspopup="dialog" aria-label="Inspect ${e(m.label)} graph · ${e(rangeLabel())}">${metricGraph(m,g,{kind:g.kind,compact:true})}</button><div class="aggregate-footer">${e(m.unavailableReason||g.label)}${e(graphNote(m,repos))}</div></section>`;}).join('');
  $$('.metric-select').forEach(select=>select.onchange=()=>{const slot=Number(select.dataset.slot),old=state.chartKeys[slot],duplicate=state.chartKeys.indexOf(select.value);if(duplicate>=0&&duplicate!==slot)state.chartKeys[duplicate]=old;state.chartKeys[slot]=select.value;if(!savePreferences())notify('Applied to this tab; browser storage is unavailable.');render();$(`.metric-select[data-slot="${slot}"]`)?.focus({preventScroll:true});});
  $$('[data-aggregate-detail]').forEach(button=>button.onclick=()=>openAggregateDialog(map.get(button.dataset.aggregateDetail),button.dataset.aggregateDetail,repos.length));
  $$('.aggregate-panel').forEach(panel=>panel.onclick=event=>{if(!event.target.closest('button,select,option,a,.metric-picker')){panel.querySelector('.aggregate-value').focus();openAggregateDialog(map.get(panel.dataset.aggregate),panel.dataset.aggregate,repos.length);}});
}
function renderCards(repos){
  const available=[...new Set(repos.flatMap(keys))].filter(k=>Object.hasOwn(CARD_METRICS,k)),columns=state.rowKeys===null?[...new Set([...available,...state.chartKeys])]:state.rowKeys,labels=new Map([...Object.entries(CARD_METRICS),...repos.flatMap(r=>keys(r).map(k=>[k,r.metrics[k].label]))]);
  const sorted=[...repos].sort((a,b)=>compareRepositories(a,b,state.sort));
  $('#sort').textContent=state.sort==='name'?'Sort: name':'Sort: recent activity ↓';
  $('#cards').style.setProperty('--metric-count',Math.max(1,columns.length));
  $('#cards').classList.toggle('many-metrics',columns.length>8);
  $('#cards').classList.toggle('hide-graph-labels',!state.showGraphLabels);
  $('#cards').innerHTML=(repos.length?`<div class="project-column-head" aria-hidden="true"><span>Repository</span><div class="column-labels">${columns.map(k=>`<span>${e(labels.get(k))}</span>`).join('')}</div></div>`:'')+sorted.map(r=>`<article class="panel project-card" data-project="${e(r.id)}"><header class="project-header"><div class="project-heading"><div class="owner">${e(r.owner)}</div><div class="project-name-row"><button class="project-name" data-repo="${e(r.id)}" title="${e(r.owner+'/'+r.name)}">${e(r.name)}</button>${visibilityIcon(r)}</div><div class="badges">${badges(r)}</div><div class="project-footer">${e(r.language)}</div></div></header><div class="metric-grid">${columns.map(k=>{const m=metricFor(r,k),g=chartView(m,state.data.dates,state.graphMode);return `<button class="spark-metric ${issueClass(k,m)}" title="${e(m.collectionWarning||m.unavailableReason||m.chartUnavailableReason||issueHint(k,m)||g.label)}" data-repo="${e(r.id)}" data-metric="${e(k)}" aria-haspopup="dialog" style="--metric-position:${columns.indexOf(k)+1}" aria-label="${e(r.name+': '+(m.countLabel||m.label)+', '+(finite(m.value)?fmt(m.value):m.unavailableReason)+(issueHint(k,m)?', '+issueHint(k,m):'')+(m.collectionWarning?', '+m.collectionWarning:''))}"><span class="spark-label">${e(m.countLabel||m.label)}</span><span class="spark-value">${finite(m.value)?fmt(m.value):'—'}</span><span class="spark-chart">${metricGraph(m,g,{small:true,kind:g.kind})}</span><span class="spark-caption">${e(m.collectionWarning||(m.unavailableReason?'':m.starMode?g.label:change(m)))}</span></button>`;}).join('')}</div></article>`).join('')||`<div class="empty panel"><h3>${state.data.repos.length?'No matching projects':'Your observatory is ready'}</h3><p>${state.data.repos.length?'Try another search or visibility filter.':'Watch a repository to start collecting real history.'}</p><button id="empty-add">+ Watch repo</button></div>`;
  $$('#cards [data-repo]').forEach(button=>button.onclick=()=>button.dataset.metric?openMetricDialog(state.data.repos.find(r=>r.id===button.dataset.repo),button.dataset.metric):openRepo(button.dataset.repo));
  if($('#empty-add'))$('#empty-add').onclick=openConnections;
}
function render(){
  if(!state.data)return;
  const repos=filtered();$('#scope-summary').textContent=`${repos.length} projects · ${rangeLabel()}`;$('#projects-summary').textContent=`${repos.length} watched projects`;
  $$('[data-range]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.range===(state.dataRange || state.range))));
  $$('[data-chart-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.chartMode===state.graphMode)));
  $$('[data-star-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.starMode===state.starMode)));
  $('#freshness').textContent=`Stored data: ${dateText(state.data.updatedAt)}${state.data.collecting?' · Collection running':''}`;
  $('#sync').textContent=state.data.collecting?'Collecting…':'Sync now';$('#sync').disabled=!!state.data.collecting;
  renderAggregates(repos);renderCards(repos);if(state.page==='detail')renderDetail();
}
async function refresh(){
  if(!state.csrf)return;
  const request=++state.request,range=state.range;
  try{
    const raw=await api('/api/dashboard?range='+encodeURIComponent(range)),data={...raw,repos:raw.repos.map(r=>presentRepository(r,state.starMode))};if(request!==state.request||!state.csrf)return;
    const changed=state.dataRange!==range || JSON.stringify(state.data)!==JSON.stringify(data);
    state.data=data;state.dataRange=range;$('#error').hidden=true;
    if(changed){
      const focus=document.activeElement,repo=focus?.dataset.repo,metric=focus?.dataset.metric,detailMetric=focus?.dataset.detailMetric;
      const tableOpen=$('#detail details')?.open;
      render();
      if(state.page==='activity'&&activityScope().key!==activity?.key)loadEvents();
      renderWatched();
      if(tableOpen&&$('#detail details'))$('#detail details').open=true;
      if(repo)$$('[data-repo]').find(b=>b.dataset.repo===repo&&b.dataset.metric===metric)?.focus({preventScroll:true});
      else if(detailMetric)$$('[data-detail-metric]').find(b=>b.dataset.detailMetric===detailMetric)?.focus({preventScroll:true});
    }
    return data;
  }
  catch{if(request===state.request&&state.csrf){if(state.dataRange){state.range=state.dataRange;persist();}$('#error').textContent='Refresh failed. Previously collected data is unchanged. Try Sync now or wait for the next refresh.';$('#error').hidden=false;}}
}
function showPage(page,focus=true){
  cancelActivity();statusRequest++;state.page=page;
  (page==='activity'?$('#activity-filters'):$('#overview .section-title')).append($('.table-tools'));
  ['#sort','#repository-settings','#export'].forEach(selector=>$(selector).hidden=page==='activity');
  ['overview','detail','activity','collection'].forEach(id=>$('#'+id).hidden=id!==page);
  $$('[data-page]').forEach(b=>{const active=b.dataset.page===(page==='detail'?'overview':page);b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  $('#page-title').textContent={overview:'Aggregate',detail:'Project history',activity:'Activity',collection:'Logs'}[page];
  if(focus)$('#page-title').focus();if(page==='activity')loadEvents();if(page==='collection')loadStatus();
}
function metricDetail(m,key,{interactive=false,expanded=false}={}){const coverage=m.chartCoverage||m.coverage,points=aligned(m,state.data.dates),count=points.filter(p=>finite(p.value)).length,g=chartView(m,state.data.dates,state.graphMode);return `<section class="panel detail-panel"><div class="detail-chart-top"><div><h2>${e(m.label)}</h2><p>${e(rangeLabel())}</p></div>${interactive?`<button class="detail-count" data-open-metric aria-haspopup="dialog" aria-label="Inspect ${e(m.label)} records">`:""}<strong class="${issueClass(key,m)}" title="${e(issueHint(key,m))}">${finite(m.value)?fmt(m.value):'Not observed'} <small>${e(m.countLabel||m.unit)}</small></strong>${interactive?"</button>":""}</div><${interactive?'button':'div'} class="large-chart ${interactive?'chart-button':''}" ${interactive?'data-open-metric aria-haspopup="dialog"':'role="img"'} aria-label="${interactive?'Inspect ':''}${e(m.label)} observations">${metricGraph(m,g,{kind:g.kind,width:interactive?Math.max(300,$('#detail').clientWidth-50):Math.max(300,Math.min(780,innerWidth-100))})}</${interactive?'button':'div'}>${m.starMode?`<p class="chart-explanation">Count: latest observed total stars. Graph: ${e(g.label)}${m.starMode==='gained'?' (does not subtract unstarring)':''}. ${m.chartComparable===false?'Latest balances have different or unknown observation dates; history is not comparable to the headline.':''}</p>`:''}${g.cumulative?'<p class="chart-explanation">Running total of observed events within the selected range; missing days remain unknown. The observation table retains daily values.</p>':''}<p class="change">${e(change(m))}</p><dl class="provenance"><div><dt>Source</dt><dd>${e(m.source)}</dd></div><div><dt>Coverage</dt><dd>${count} of ${points.length} days${coverage?.start?' · '+e(coverage.start)+' to '+e(coverage.end):''}${coverage?.complete?' · complete':' · partial'}</dd></div><div><dt>Last collected</dt><dd>${e(dateText(m.lastSuccess))}</dd></div>${m.chartLabel?`${m.chartSource&&m.chartSource!==m.source?`<div><dt>Graph source</dt><dd>${e(m.chartSource)}</dd></div>`:''}<div><dt>Graph collected</dt><dd>${e(dateText(m.chartLastSuccess))}</dd></div>${errorStatus(m.chartStatus)?'<div><dt>Graph collection</dt><dd class="error">Latest graph collection failed; previous graph observations retained.</dd></div>':''}`:''}${m.collectionWarning||errorStatus(m.status)?`<div><dt>Collection</dt><dd class="error">${e(m.collectionWarning||'Latest collection failed')}; previous observations retained.</dd></div>`:''}</dl><details ${expanded?'open':''}><summary>Observation table · raw daily values</summary><div class="table-wrap" tabindex="0" role="region" aria-label="Daily observation table"><table><caption>${e(m.label)} · ${e(rangeLabel())}</caption><thead><tr><th scope="col">Date</th><th scope="col">${e(m.chartLabel||m.unit)}</th></tr></thead><tbody>${points.map(p=>`<tr><th scope="row">${e(p.date)}</th><td>${finite(p.value)?fmt(p.value):'Not observed'}</td></tr>`).join('')}</tbody></table></div></details></section>`;}
function openRepo(id,key){detailFocus=document.activeElement;state.detail={id,key};showPage('detail');renderDetail();}
function renderDetail(){
  const r=state.data.repos.find(r=>r.id===state.detail?.id);if(!r){showPage('overview');return;}
  const available=Object.keys(CARD_METRICS);if(!available.includes(state.detail.key))state.detail.key=available[0];const m=metricFor(r,state.detail.key),url=githubURL(r.url);
  $('#detail').innerHTML=`<button class="back" id="back">← All projects</button><div class="detail-title-row"><div><div class="owner">${e(r.owner)}</div><div class="project-name-row"><h2>${e(r.name)}</h2>${visibilityIcon(r)}</div><p>${e(r.description)}</p>${url?`<a href="${e(url)}" target="_blank" rel="noopener noreferrer">View on GitHub ↗</a>`:''}</div><div class="badges">${badges(r)}</div></div><div class="detail-summary">${available.map(k=>`<button data-detail-metric="${e(k)}" aria-pressed="${k===state.detail.key}">${e(r.metrics[k]?.label||CARD_METRICS[k])}</button>`).join('')}</div>${m?metricDetail(m,state.detail.key,{interactive:true}):'<p class="empty">No observations collected yet.</p>'}<div class="detail-actions"><button id="pause">Unwatch repository</button><p class="tiny">Stop future collection without deleting stored history.</p></div>`;
  $$('#detail [data-open-metric]').forEach(b=>b.onclick=()=>openMetricDialog(r,state.detail.key));
  $('#back').onclick=()=>{showPage('overview');if(detailFocus?.isConnected)detailFocus.focus();else $$('[data-repo]').find(b=>b.dataset.repo===r.id)?.focus();};
  $$('[data-detail-metric]').forEach(b=>b.onclick=()=>{state.detail.key=b.dataset.detailMetric;renderDetail();$$('[data-detail-metric]').find(x=>x.dataset.detailMetric===state.detail.key)?.focus();});
  $('#pause').onclick=()=>confirmUnwatch(r);
}
function bindUnwatch(scope){
  $$(scope+' [data-unwatch]').forEach(button=>button.onclick=()=>{const r=state.data?.repos.find(r=>r.id===button.dataset.unwatch);if(r)confirmUnwatch(r);});
}
function renderWatched(){
  if(!$('#watched-repositories'))return;
  $('#watched-repositories').innerHTML=[...(state.data?.repos||[])].sort((a,b)=>compareRepositories(a,b,state.sort)).map(r=>`<div class="discovery-row" data-watched="${e(r.id)}"><div><div class="project-name-row"><strong>${e(r.owner+'/'+r.name)}</strong>${visibilityIcon(r)}</div><div class="badges">${badges(r)}</div></div><button data-unwatch="${e(r.id)}" aria-label="Unwatch ${e(r.owner+'/'+r.name)}" aria-haspopup="dialog">Unwatch</button></div>`).join('')||'<p class="empty">No active watches.</p>';
  bindUnwatch('#watched-repositories');
}
function confirmUnwatch(r){
  openDialog('Unwatch this repository?',`<p>Unwatch <strong>${e(r.owner+'/'+r.name)}</strong>? This will stop collection and remove it from the active view. Stored history is retained. Add the same repository again to resume collection.</p><div class="drilldown-actions"><button id="confirm-pause" class="primary">Unwatch repository</button><button id="cancel-unwatch">Keep watching</button></div>`,()=>{
    $('#cancel-unwatch').onclick=closeDialog;
    $('#confirm-pause').onclick=()=>mutation($('#confirm-pause'),async active=>{
      await api('/api/watches/'+encodeURIComponent(r.id)+'/pause',{method:'POST',body:{}});
      const data=await refresh();if(!active())return;
      closeDialog();notify(data&&!data.repos.some(repo=>repo.id===r.id)?'Unwatched. Stored history is retained. Add it again to resume.':'Unwatch request accepted, but removal could not be confirmed. Refresh to verify.');
    });
  });
}
function openDialog(title,html,setup){dialogSession++;cancelDrilldown();if(!$('#dialog').open)dialogFocus=document.activeElement;$('#dialog').classList.remove('metric-dialog');$('#dialog-title').textContent=title;$('#dialog-body').innerHTML=html;$('#dialog-message').textContent='';if(!$('#dialog').open)$('#dialog').showModal();$('#dialog').scrollTop=0;setup?.();$('#close').focus();}
function closeDialog(){dialogSession++;cancelDrilldown();$('#dialog').close();restoreDialogFocus();}
$('#close').onclick=closeDialog;
$('#dialog').addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
function restoreDialogFocus(){
  // A queued close event must not invalidate a newly opened dialog.
  if($('#dialog').open)return;
  cancelDrilldown();
  if(!state.csrf){($('#unlock-form').hidden?$('#session-retry'):$('#unlock-key')).focus();return;}
  const old=dialogFocus;if(!old)return;dialogFocus=null;
  const replacement=old?.id?document.getElementById(old.id):old?.dataset.repo?$$('#cards [data-repo]').find(b=>b.dataset.repo===old.dataset.repo&&b.dataset.metric===old.dataset.metric):old?.dataset.aggregateDetail?$$('[data-aggregate-detail]').find(b=>b.dataset.aggregateDetail===old.dataset.aggregateDetail&&b.className===old.className):old?.hasAttribute('data-open-metric')?$$('#detail [data-open-metric]').find(b=>b.className===old.className):null;
  (old?.isConnected?old:replacement||$('#page-title')).focus({preventScroll:true});
}
$('#dialog').addEventListener('close',restoreDialogFocus);
$('#dialog').addEventListener('keydown',event=>{
  if(event.key!=='Tab')return;
  const controls=$$('#dialog a[href],#dialog button,#dialog input,#dialog select,#dialog textarea,#dialog summary,#dialog [tabindex]').filter(el=>!el.disabled&&el.tabIndex>=0&&el.getClientRects().length);
  const first=controls[0],last=controls.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
});
function metricAction(r,key){const action=githubMetricAction(r,key,state.data.dates);return action?`<a class="metric-action" href="${e(action.url)}" target="_blank" rel="noopener noreferrer">${e(action.label)} ↗</a>`:'<span class="tiny">GitHub link unavailable</span>';}
function openAggregateDialog(m,key,total){
  if(!m)return;
  const graphIDs=new Set(m.chartContributors.map(r=>r.id));
  openDialog(`${m.label} · project contributions`,`<p class="drilldown-context">${m.contributors.length} of ${total} filtered projects · ${e(rangeLabel())}</p><p class="cohort-note">Count includes all listed projects. Graph uses a fixed group; every member must have a recorded value on a date to plot it. Gaps remain unknown. ${m.chartContributors.length} of ${m.contributors.length} count contributors belong to the graph cohort; the Graph column identifies them.</p><div class="table-wrap contribution-wrap" tabindex="0" role="region" aria-label="Project contribution table"><table class="contribution-table"><caption>Project contributions · ${e(m.unit)}</caption><thead><tr><th scope="col">Repository</th><th scope="col">Value</th><th scope="col">Graph</th><th scope="col">Actions</th></tr></thead><tbody>${m.contributors.map(r=>`<tr><th scope="row">${e(r.owner)}/<wbr>${e(r.name)}</th><td class="numeric">${fmt(r.metrics[key].value)}</td><td>${graphIDs.has(r.id)?'Included':'Count only'}</td><td><div class="contribution-actions">${metricAction(r,key)}<button class="text-button" data-contribution="${e(r.id)}" aria-label="Inspect ${e(r.owner+'/'+r.name+' '+m.label)}">Inspect records →</button></div></td></tr>`).join('')}</tbody></table></div>${metricDetail(m,key,{expanded:true})}`,()=>{
    $('#dialog').classList.add('metric-dialog');
    $$('[data-contribution]').forEach(button=>button.onclick=()=>openMetricDialog(m.contributors.find(r=>r.id===button.dataset.contribution),key,()=>openAggregateDialog(m,key,total)));
  });
}
function openMetricDialog(r,key,back){
  if(!r)return;const m=metricFor(r,key);
  openDialog(`${m.label} · ${r.name}`,`${back?'<button id="contribution-back" class="back">← Project contributions</button>':''}<div class="drilldown-intro"><p class="drilldown-context">${e(r.owner)}/${e(r.name)} · ${e(rangeLabel())}</p><div class="drilldown-actions">${metricAction(r,key)}<button id="full-history" class="text-button">Full project history →</button></div></div><section id="records-section" class="records-section" aria-labelledby="records-heading"><h3 id="records-heading">${key==='issues'?'Current open-issue snapshot':'Stored records'}</h3><p id="records-state" role="status" aria-live="polite">Loading stored records…</p><div id="records-table"></div><button id="records-more" hidden>Load more</button></section>${metricDetail(m,key,{expanded:true})}`,()=>{
    $('#dialog').classList.add('metric-dialog');
    if(back)$('#contribution-back').onclick=back;
    $('#full-history').onclick=()=>{const origin=dialogFocus;cancelDrilldown();$('#dialog').close();openRepo(r.id,key);detailFocus=origin;dialogFocus=$('#page-title');};
  });
  if(m.unavailableReason){$('#records-state').textContent=m.unavailableReason;return;}
  drilldown={r,key,range:state.dataRange||state.range,items:[],next:0,loading:false,error:false,page:null,controller:new AbortController()};
  $('#records-more').onclick=()=>loadMetricRecords(drilldown);
  loadMetricRecords(drilldown);
}
function renderMetricRecords(view){
  const data=view.page,loading=view.loading;
  $('#records-section')?.setAttribute('aria-busy',String(loading));
  let message=view.error?'':'Loading stored records…';
  if(data){
    const type=data.kind==='snapshot'?'Current snapshot — not filtered by the selected date range.':data.kind==='events'?'Stored events in the selected date range.':'Daily observations only. Individual records are not collected for this metric; use the observation table below.';
    const freshness=data.observedAt?` Observed ${dateText(data.observedAt)}.`:' Observation time unavailable.';
    const health=errorStatus(data.status)||['stale','details_incomplete'].includes(data.status)?' Collection is stale or incomplete; retained records may not reflect GitHub now.':data.status==='paused'?' Collection is paused; retained records may be outdated.':data.status==='ok'?'':data.status==='not_collected'?' No successful record collection is available yet.':` Collection status: ${data.status||'unknown'}.`;
    message=type+freshness+health+(data.complete?'':' Collection coverage is partial; this is not a complete inventory.')+(plain(data.coverage?.label)?' '+plain(data.coverage.label):'')+(data.kind==='observations'?'':` Showing ${view.items.length} of ${data.total} stored records.`);
    if(!view.items.length&&data.kind!=='observations')message+=' No stored records were returned; this does not establish that no activity exists on GitHub.';
  }
  if(view.changed)message+=' The stored inventory changed while paging. Close and reopen this dialog to load a consistent snapshot.';
  else if(view.error)message+=(data?' More records could not be loaded. Existing rows are unchanged.':' Records could not be loaded. Daily observations below are unchanged.')+' Try again.';
  else if(loading&&data)message+=' Loading more…';
  $('#records-state').textContent=message;
  $('#records-state').classList.toggle('error',view.error);
  $('#records-table').innerHTML=view.items.length?`<div class="table-wrap record-wrap" tabindex="0" role="region" aria-label="Stored record table"><table class="record-table"><caption>${data.kind==='snapshot'?'Open issues · latest stored snapshot':'Collected event records'}</caption><thead><tr><th scope="col">${data.kind==='snapshot'?'Created':'Date'}</th><th scope="col">${data.kind==='snapshot'?'Issue':'Record'} / GitHub action</th><th scope="col">Author</th></tr></thead><tbody>${view.items.map(raw=>{const item={...raw,type:raw.type||view.key},url=githubURL(item.url);return `<tr><td>${e(item.date?dateText(item.date):'Unknown date')}</td><th scope="row">${url?`<a href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(recordTitle(item))} ↗</a>`:e(recordTitle(item))}${recordContext(item)}</th><td class="event-actor">${actorHTML(item)}</td></tr>`;}).join('')}</tbody></table></div>`:'';
  const more=$('#records-more');more.hidden=view.changed||!(view.error||data?.hasMore);more.disabled=loading;more.textContent=loading?'Loading…':view.error?'Try again':'Load more';
}
async function loadMetricRecords(view){
  if(!view||view!==drilldown||view.loading||!state.csrf)return;
  view.loading=true;view.error=false;renderMetricRecords(view);
  const active=()=>view===drilldown&&$('#dialog').open&&!!state.csrf;
  try{
    const params=new URLSearchParams({repository:view.r.id,metric:view.key,range:view.range,offset:String(view.next),limit:'50'});
    const data=await api('/api/details?'+params,{signal:view.controller.signal});
    if(!active())return;
    // Bound pagination and reject inconsistent pages rather than invent totals.
    if(!Array.isArray(data.items)||data.items.length>50||!Number.isSafeInteger(data.total)||data.total<0||data.offset!==view.next||data.limit!==50||typeof data.hasMore!=='boolean'||!['events','snapshot','observations'].includes(data.kind)||typeof data.complete!=='boolean'||typeof data.status!=='string'||data.items.some(item=>!item||typeof item.id!=='string'||typeof item.title!=='string'))throw Error('Invalid detail page');
    if(view.page&&(data.kind!==view.page.kind||data.observedAt!==view.page.observedAt||data.total!==view.page.total)){view.changed=true;throw Error('Inventory changed');}
    const ids=new Set(view.items.map(item=>item.id));
    if(data.items.some(item=>{if(ids.has(item.id))return true;ids.add(item.id);return false;}))throw Error('Repeated page');
    const next=view.next+data.items.length;
    if(next>data.total||data.hasMore&&(!data.items.length||next>=data.total)||!data.hasMore&&next!==data.total||data.kind==='observations'&&data.items.length)throw Error('Inconsistent pagination');
    view.items.push(...data.items);view.next=next;view.page=data;
  }catch{if(active())view.error=true;}
  finally{if(active()){const hadFocus=document.activeElement.id==='records-more';view.loading=false;renderMetricRecords(view);if(hadFocus&&$('#records-more').hidden){$('#records-state').tabIndex=-1;$('#records-state').focus({preventScroll:true});}}}
}
async function mutation(button,work){
  const inDialog=!!button.closest('#dialog'),active=inDialog?dialogActive(dialogSession):()=>!!state.csrf;
  button.disabled=true;
  try{await work(active);}
  catch{if(active()){const message='The request could not be completed. Please try again.';if(inDialog)$('#dialog-message').textContent=message;else notify(message);}}
  finally{if(active()&&button.isConnected)button.disabled=button.id==='sync'&&!!state.data?.collecting;}
}
function openConnections(section){
  const rowOptions=Object.keys(CARD_METRICS);
  openDialog('Settings',`<section><h3>Open issue alerts</h3><p>Highlight counts strictly above these thresholds. Saved in this browser.</p><form id="preferences-form"><div class="threshold-fields"><label>Yellow above<input id="issue-warning" type="number" min="0" step="1" required value="${state.issueThresholds.warning}"></label><label>Red above<input id="issue-danger" type="number" min="0" step="1" required value="${state.issueThresholds.danger}"></label></div><h3>Stars graph</h3><label for="star-mode-setting">Stars presentation</label><select id="star-mode-setting"><option value="total" ${state.starMode==='total'?'selected':''}>Total stars</option><option value="gained" ${state.starMode==='gained'?'selected':''}>Stars gained</option></select><p>Totals use recorded balances only. Daily/Cumulative applies to event graphs, including stars gained, not total stars. Headlines always show total stars.</p><h3>Top cards</h3><p>Choose four different metrics. Cards follow the current filters. Saved in this browser.</p><div class="card-fields">${state.chartKeys.map((key,slot)=>`<label>Card ${slot+1}<select id="card-metric-${slot}" data-card-setting="${slot}">${Object.entries(CARD_METRICS).map(([value,label])=>`<option value="${e(value)}" ${value===key?'selected':''}>${e(label)}</option>`).join('')}</select></label>`).join('')}</div><section aria-labelledby="repository-graphs"><h3 id="repository-graphs" tabindex="-1">Repository graphs</h3><p>Choose metrics for repository rows, independently of the four top cards. Unavailable metrics keep their columns with a grey reason, never a fabricated zero.</p><label class="row-choice"><input type="checkbox" id="show-graph-labels" ${state.showGraphLabels?'checked':''}> Show graph labels</label><p class="tiny">Repeat the metric name above each repository graph, on desktop and mobile. Top-card and project-history labels stay visible. Saved in this browser.</p><label for="repository-sort">Default repository sort</label><select id="repository-sort"><option value="activity" ${state.sort==='activity'?'selected':''}>Recent activity (newest first)</option><option value="name" ${state.sort==='name'?'selected':''}>Repository name (A–Z)</option></select><p class="tiny">Newest persisted event time; never sync freshness or current counts. Ties use repository name.</p><label class="row-choice"><input type="checkbox" id="row-all" ${state.rowKeys===null?'checked':''}> Automatic: observed metrics plus selected top cards</label><div class="row-fields">${rowOptions.map(key=>`<label class="row-choice"><input type="checkbox" data-row-setting="${e(key)}" ${state.rowKeys===null||state.rowKeys.includes(key)?'checked':''}> ${e(CARD_METRICS[key])}</label>`).join('')}</div></section><button type="submit">Save settings</button><p id="preferences-message" role="status"></p></form></section><h3>Watched repositories</h3><p>Unwatch stops collection and removes a repository from active views, retaining its history. Add the same repository again to resume.</p><div id="watched-repositories"></div><h3>Connections & watches</h3><p>Watch a public repository anonymously, or choose owned repositories from your existing local connection. No GitHub token is entered in this browser.</p><form id="watch-form"><label for="repository">Public repository URL or owner/repository</label><input id="repository" required autocomplete="off" spellcheck="false" placeholder="owner/repository"><button class="primary" type="submit">Add public watch</button></form><section class="connection-section"><h3>Existing connection</h3><p>${state.data?.credentialConfigured?'A local credential is configured. Choose repositories explicitly.':'No local credential is configured. Public watches are available.'}</p><button id="discover" ${state.data?.credentialConfigured?'':'disabled'}>Choose owned repositories</button><div id="discovery"></div></section>`,()=>{
    renderWatched();
    $('#row-all').onchange=()=>{if($('#row-all').checked)$$('[data-row-setting]').forEach(input=>input.checked=true);};
    $$('[data-row-setting]').forEach(input=>input.onchange=()=>$('#row-all').checked=false);
    $('#preferences-form').onsubmit=event=>{
      event.preventDefault();const thresholds=validateThresholds({warning:Number($('#issue-warning').value),danger:Number($('#issue-danger').value)});
      if(!thresholds){$('#preferences-message').textContent='Use nonnegative whole numbers; red must be higher than yellow.';return;}
      const chartKeys=validateChartKeys($$('[data-card-setting]').map(select=>select.value));
      if(!chartKeys){$('#preferences-message').textContent='Choose four different supported metrics.';return;}
      setStarMode($('#star-mode-setting').value);state.issueThresholds=thresholds;state.chartKeys=chartKeys;state.showGraphLabels=$('#show-graph-labels').checked;state.sort=$('#repository-sort').value;state.rowKeys=$('#row-all').checked?null:validateRowKeys($$('[data-row-setting]:checked').map(input=>input.dataset.rowSetting));const saved=savePreferences();
      render();$('#preferences-message').textContent=saved?'Settings saved.':'Applied to this tab; browser storage is unavailable.';
    };
    $('#watch-form').onsubmit=event=>{event.preventDefault();const value=$('#repository').value.trim();let valid=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);try{const u=new URL(value);valid=!!githubURL(value)&&/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(u.pathname)&&!u.hash&&!u.search;}catch{}if(!valid){$('#dialog-message').textContent='Use owner/repository or an HTTPS github.com repository URL.';return;}mutation($('#watch-form button'),async active=>{const result=await api('/api/watches',{method:'POST',body:{repository:value,access:'public'}}),data=await refresh();if(!active())return;$('#repository').value='';renderWatched();$('#dialog-message').textContent=data?.repos.some(r=>r.id===result.repository.id)?'Public watch added.':'Request accepted. Refresh to confirm the stored watch.';});};
    $('#discover').onclick=()=>mutation($('#discover'),loadDiscover);
  });
  if(section==='repository-graphs'){$('#repository-graphs').focus();$('#repository-graphs').scrollIntoView({block:'start'});}
}
async function loadDiscover(active=dialogActive(dialogSession)){
  if(!active())return;
  const data=await api('/api/discover');if(!active())return;
  if(data.status&&!['ok','partial'].includes(data.status)){$('#discovery').textContent='Repository discovery could not be completed. Please try again.';return;}
  $('#discovery').innerHTML=data.repositories.map((r,i)=>`<div class="discovery-row"><div><div class="project-name-row"><strong>${e(r.owner+'/'+r.name)}</strong>${visibilityIcon(r)}</div><div class="badges">${badges(r)}</div></div><button data-add-owned="${i}" ${r.watched?'disabled':''}>${r.watched?'Watching':'Add'}</button></div>`).join('')||'<p class="empty">No owned repositories were returned.</p>';
  if(data.complete===false)$('#discovery').insertAdjacentHTML('afterbegin','<p class="notice">Showing available owned repositories; discovery is incomplete.</p>');
  $$('[data-add-owned]').forEach(b=>b.onclick=()=>mutation(b,async active=>{const r=data.repositories[Number(b.dataset.addOwned)],result=await api('/api/watches',{method:'POST',body:{repository:r.owner+'/'+r.name,access:'token'}});const [updated]=await Promise.all([refresh(),loadDiscover(active)]);if(!active())return;renderWatched();$('#dialog-message').textContent=updated?.repos.some(repo=>repo.id===result.repository.id)?'Repository watch added.':'Request accepted. Refresh to confirm the stored watch.';}));
}
const eventLabels={commits:'Commit',commit:'Commit',merged_prs:'Merged PR',releases:'Release',stars:'Star',forks:'Fork',issues:'Issue',pull_requests:'Pull request'};
const plain=value=>typeof value==='string'?value:typeof value==='number'&&finite(value)?String(value):'';
function recordTitle(item){
  const title=plain(item.title).split('\n')[0].trim();
  return /^(?:Commit\s+)?[a-f0-9]{7,64}$/i.test(title)?'Commit (title not recorded)':title||'Title not recorded';
}
function actorHTML(item){
  const actor=item.actor||{},name=plain(actor.name),login=plain(actor.login),author=plain(item.author);
  const text=name&&login?`${name} (@${login})`:name||login&&'@'+login||author;
  if(!text||/\S+@\S+\.\S+/.test(text))return '<span>Actor not recorded</span>';
  const url=githubURL(actor.url);
  return url?`<a href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(text)}</a>`:e(text);
}
function recordContext(item){
  const meta=item.metadata||{},sha=plain(meta.sha)||(/^(?:Commit\s+)?[a-f0-9]{7,64}$/i.test(plain(item.title))?plain(item.title).replace(/^Commit\s+/i,''):''),fields=[['SHA',sha],['Branch',meta.branch],[item.type==='merged_prs'?'PR':'Number',meta.number?'#'+plain(meta.number):''],['Action',meta.action],['Ref',meta.ref],['Ref type',meta.refType],['Commits',meta.commitCount],['Head',meta.head],['Base',meta.base]].filter(([,v])=>plain(v)!=='');
  const summary=plain(item.summary);
  return (summary?`<p class="event-summary">${e(summary)}</p>`:'')+(fields.length?`<dl class="event-metadata">${fields.map(([label,value])=>`<div><dt>${label}</dt><dd>${e(plain(value))}</dd></div>`).join('')}</dl>`:'');
}
function eventHTML(item){
  const url=githubURL(item.url),type=eventLabels[item.type]||plain(item.type).replaceAll('_',' ');
  return `<article class="panel event"><div class="event-heading"><span class="event-type">${e(type||'Activity')}</span><span>${e(item.repository)}</span><time datetime="${e(item.date)}">${e(item.date?dateText(item.date):'Date not recorded')}</time></div><h2>${url?`<a href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(recordTitle(item))} ↗</a>`:e(recordTitle(item))}</h2><p class="event-actor">${actorHTML(item)}</p>${recordContext(item)}${item.source||item.observedAt?`<p class="event-provenance">${e(item.source)}${item.observedAt?' · Observed '+e(dateText(item.observedAt)):''}</p>`:''}</article>`;
}
function activityScope(){
  const repos=filtered(),params=new URLSearchParams({range:state.dataRange||state.range});
  if(repos.length===1)params.set('repository',repos[0].id);
  else{
    if(state.visibility!=='all')params.set('visibility',state.visibility);
    const search=$('#search').value.trim();if(search)params.set('search',search);
    if($('#archived').checked)params.set('archived','true');
  }
  return {params,empty:!repos.length,key:params.toString()+'|'+repos.map(r=>r.id).sort().join(',')};
}
function renderEvents(view){
  $('#activity').setAttribute('aria-busy',String(view.loading));
  const page=view.page;
  let message=view.empty?'No matching repositories. Adjust the repository filters.':page?`Showing ${view.items.length} of ${page.total} stored events · ${rangeLabel()}. Collected observations only; not a complete GitHub history. ${plain(page.coverage?.label)}`:'Loading activity…';
  if(page?.legacy)message+=' Pagination is unavailable for this older response; additional history may exist.';
  if(view.changed)message+=' Stored activity changed while paging. Refresh activity to restart from the latest events.';
  if(view.error)message=(page?message+' Existing rows are unchanged. ':'')+'Activity could not be loaded. Please try again.';
  else if(view.loading&&page)message+=' Loading activity…';
  if(page&&!page.total)message+=' No stored events in this range; this does not establish that no activity exists on GitHub.';
  $('#events-state').textContent=message;$('#events-state').classList.toggle('error',!!view.error);
  $('#events').innerHTML=view.items.map(eventHTML).join('');
  $('#events-more').hidden=view.changed||!page?.hasMore;$('#events-more').disabled=view.loading;
  $('#reload-events').disabled=view.loading;
}
async function loadEvents(more=false){
  if(!state.csrf||state.page!=='activity'||!state.data)return;
  more=more===true;
  const scope=activityScope(),previous=activity;
  if(more&&(!previous||previous.loading||previous.changed||!previous.page?.hasMore))return;
  if(more&&previous.key!==scope.key)more=false;
  if(!more){
    previous?.controller.abort();
    // Keep good rows only when refreshing exactly the same scope.
    activity={...scope,items:previous?.key===scope.key?previous.items:[],page:previous?.key===scope.key?previous.page:null,next:previous?.key===scope.key?previous.next:0,changed:previous?.key===scope.key&&!!previous.changed,controller:new AbortController()};
  }
  const view=activity,active=()=>activity===view&&state.page==='activity'&&!!state.csrf;
  if(view.empty){view.items=[];view.page=null;view.loading=false;renderEvents(view);return;}
  const offset=more?view.next:0;view.loading=true;view.error=false;renderEvents(view);
  try{
    const params=new URLSearchParams({limit:'50',offset:String(offset),...Object.fromEntries(scope.params)});
    let data=await api('/api/events?'+params,{signal:view.controller.signal});if(!active())return;
    // Legacy inventories were capped at 500; modern pages still obey limit=50.
    // Detect compatibility locally, never trust a server-supplied legacy flag.
    const legacy=Array.isArray(data.events)&&data.total===undefined&&data.hasMore===undefined&&offset===0;
    data=legacy?{...data,total:data.events.length,offset:0,limit:50,hasMore:false,legacy:true}:{...data,legacy:false};
    if(!Array.isArray(data.events)||data.events.length>(legacy?500:50)||!Number.isSafeInteger(data.total)||data.total<0||data.offset!==offset||data.limit!==50||typeof data.hasMore!=='boolean'||data.events.some(item=>!item||typeof item.id!=='string'||typeof item.title!=='string'))throw Error('Invalid activity page');
    if(more&&data.total!==view.page.total){view.changed=true;throw Error('Activity changed');}
    const ids=new Set(more?view.items.map(item=>item.id):[]);
    if(data.events.some(item=>{if(ids.has(item.id))return true;ids.add(item.id);return false;})){if(more)view.changed=true;throw Error('Repeated page');}
    const next=offset+data.events.length;
    if(next>data.total||data.hasMore&&(!data.events.length||next>=data.total)||!data.hasMore&&next!==data.total)throw Error('Inconsistent pagination');
    view.items=more?[...view.items,...data.events]:data.events;view.page=data;view.next=next;view.changed=false;
  }catch{if(active())view.error=true;}
  finally{if(active()){const hadFocus=document.activeElement.id==='events-more';view.loading=false;renderEvents(view);if(hadFocus&&$('#events-more').hidden){$('#events-state').tabIndex=-1;$('#events-state').focus({preventScroll:true});}}}
}
async function loadStatus(){
  const request=++statusRequest,active=()=>request===statusRequest&&state.page==='collection'&&!!state.csrf;
  $('#collection-content').textContent='Loading logs…';
  try{const status=await api('/api/status');if(!active())return;$('#collection-content').innerHTML=`<section class="panel pad"><h2>${status.collecting?'Collection running':'Collection schedule'}</h2><dl class="provenance"><div><dt>Last attempt</dt><dd>${e(dateText(status.lastAttempt))}</dd></div><div><dt>Last success</dt><dd>${e(dateText(status.lastSuccess))}</dd></div>${status.nextRun?`<div><dt>Next run</dt><dd>${e(dateText(status.nextRun))}</dd></div>`:''}</dl></section><div class="timeline">${(status.runs||[]).map(run=>`<article class="panel event"><h3>${e(run.repository)} · ${e(run.metric)}</h3><p class="${errorStatus(run.status)?'error':''}">${e(run.status)}</p><p class="tiny">Attempt: ${e(dateText(run.lastAttempt))} · Last success: ${e(dateText(run.lastSuccess))}</p>${run.message?`<p>${e(run.message)}</p>`:''}</article>`).join('')||'<p class="empty">No collection attempts yet.</p>'}</div>`;}
  catch{if(active())$('#collection-content').textContent='Logs could not be loaded. Please try again.';}
}
$('#settings').onclick=openConnections;$('#add').onclick=openConnections;$('#repository-settings').onclick=()=>openConnections('repository-graphs');
$$('[data-page]').forEach(b=>b.onclick=()=>showPage(b.dataset.page));
$$('[data-range]').forEach(b=>b.onclick=async()=>{if(state.range===b.dataset.range)return;state.range=b.dataset.range;persist();await refresh();});
$$('[data-chart-mode]').forEach(button=>button.onclick=()=>{
  state.graphMode=button.dataset.chartMode;try{localStorage.setItem(chartModeKey,state.graphMode);}catch{}
  const tableOpen=$('#detail details')?.open;render();if(tableOpen&&$('#detail details'))$('#detail details').open=true;
});
$$('[data-star-mode]').forEach(button=>button.onclick=()=>{setStarMode(button.dataset.starMode);if(!savePreferences())notify('Applied to this tab; browser storage is unavailable.');render();});
function filterChanged(){render();if(state.page==='activity')loadEvents();}
$('#search').oninput=filterChanged;$('#scope-filter').onchange=()=>{state.visibility=$('#scope-filter').value;persist();filterChanged();};$('#archived').onchange=filterChanged;
$('#sort').onclick=()=>{state.sort=state.sort==='name'?'activity':'name';if(!savePreferences())notify('Applied to this tab; browser storage is unavailable.');renderCards(filtered());};
$('#sync').onclick=()=>mutation($('#sync'),async()=>{const result=await api('/api/sync',{method:'POST',body:{}});notify(result.started?'Collection started. New observations will appear automatically.':'Collection is already running.');await refresh();});
$('#reload-events').onclick=()=>loadEvents();$('#events-more').onclick=()=>loadEvents(true);$('#reload-status').onclick=loadStatus;
$('#export').onclick=()=>{const blob=new Blob([exportCSV(filtered(),state.dataRange || state.range)],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='github-observatory.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
function setTheme(light){document.body.classList.toggle('light',light);$('#theme').setAttribute('aria-label',light?'Switch to dark theme':'Switch to light theme');}
try{setTheme(localStorage.getItem('github-observatory-theme')!=='dark');}catch{setTheme(true);}
$('#theme').onclick=()=>{setTheme(!document.body.classList.contains('light'));try{localStorage.setItem('github-observatory-theme',document.body.classList.contains('light')?'light':'dark');}catch{}};
setInterval(async()=>{if(state.csrf&&!document.hidden){await refresh();if(state.page==='activity'&&!activity?.loading&&(activity?.next||0)<=50)loadEvents();if(state.page==='collection')loadStatus();}},30000);
authenticate(unlockKey);unlockKey=null;
