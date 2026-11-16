// Only known values are charted. Reconstructed history is labeled; unknown is never zero.
export const finite = value => typeof value === 'number' && Number.isFinite(value);
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const fmt = value => finite(value) ? new Intl.NumberFormat().format(value) : '';
export const observed = metric => metric && (finite(metric.value) || metric.points?.some(p => finite(p.value)));
export const keys = repo => Object.keys(repo.metrics || {}).filter(k => observed(repo.metrics[k]));
export const collectionProblem=status=>/^(disabled|no_access|credentials_missing|error|failed|failure|rate_limited|rate-limited|forbidden|unauthorized|unavailable|upstream_error|invalid_response|network_error|timeout|partial|budget_exhausted|unsupported)$/.test(status||'');
function combinedStatus(values){const states=values.filter(Boolean);return states.find(collectionProblem)||states.find(s=>s==='collecting')||states[0]||null;}
export const CARD_METRICS=Object.freeze({commits:'Commits',stars:'Stars',views:'Views',issues:'Open issues',forks:'Forks',merged_prs:'Merged PRs',releases:'Releases',clones:'Clones'});
export const DEFAULT_CHART_KEYS=Object.freeze(['commits','stars','views','issues']);
export function validateRowKeys(value){
  return Array.isArray(value)&&value.every(key=>typeof key==='string'&&Object.hasOwn(CARD_METRICS,key))&&new Set(value).size===value.length?[...value]:null;
}
// Activity means an observed event, not a current balance or collection time.
export function repositoryActivity(repo){
  const persisted=Date.parse(repo.lastActivityAt);
  if(Object.hasOwn(repo,'lastActivityAt'))return Number.isFinite(persisted)?persisted:0;
  const dates=Object.entries(repo.metrics||{}).filter(([key,m])=>['commits','merged_prs','releases','star_activity','stars','forks'].includes(key)&&(m.chartKind||m.kind)==='event').flatMap(([,m])=>(m.points||[]).filter(p=>finite(p.value)&&p.value>0).map(p=>Date.parse(p.date))).filter(Number.isFinite);
  return dates.length?Math.max(...dates):0;
}
export function compareRepositories(a,b,sort='activity'){
  return (sort==='activity'?repositoryActivity(b)-repositoryActivity(a):0)||String(a.name).localeCompare(String(b.name))||String(a.owner).localeCompare(String(b.owner))||String(a.id).localeCompare(String(b.id));
}
export function validateChartKeys(value){
  return Array.isArray(value)&&value.length===4&&value.every(key=>typeof key==='string'&&Object.hasOwn(CARD_METRICS,key))&&new Set(value).size===4?[...value]:null;
}
export function validateThresholds(value) {
  return value && Number.isSafeInteger(value.warning) && Number.isSafeInteger(value.danger) && value.warning>=0 && value.danger>value.warning ? {warning:value.warning,danger:value.danger} : null;
}
export function issueLevel(value, thresholds) {
  if(!finite(value))return '';
  return value>thresholds.danger?'danger':value>thresholds.warning?'warning':'';
}
// One presentation metric, two explicitly different measurements. Raw storage
// still keeps outstanding-star balances and star-creation activity separate.
export function unavailableReason(repo,key) {
  const labels={disabled:'Disabled on repo',no_access:'No access',not_collected:'Not collected yet',error:'Collection failed',empty_repository:'No commits yet'};
  const {state,label}=repo.metricAvailability?.[key]||{};
  if(state==='not_collected'&&['No observations yet','Collection in progress'].includes(label))return label;
  return Object.hasOwn(labels,state)?labels[state]:'Not collected yet';
}
// Current collection health is independent of retained observation availability.
export function collectionWarning(repo,key){
  const state=repo.metricAvailability?.[key]?.state,status=repo.metrics?.[key]?.status;
  if(['disabled','no_access','error'].includes(state))return unavailableReason(repo,key);
  if(status==='disabled')return 'Disabled on repo';
  if(['no_access','forbidden','unauthorized','credentials_missing'].includes(status))return 'No access';
  return collectionProblem(status)?'Collection failed':'';
}
export function missingMetric(repo,key) {
  return {label:CARD_METRICS[key],value:null,points:[],unit:'',unavailableReason:unavailableReason(repo,key)};
}
// The old independent stars/gained preference is intentionally superseded.
// History is authoritative, including null counts. Raw metrics remain untouched.
export function historyNote(metric){
  const h=metric.history;if(!h)return metric.kind==='balance'?'Recorded balance · since tracking':'Recorded history · selected range only';
  const status={backfilling:'Backfilling',limited:'Limited history',no_access:'No access',error:'History collection failed',not_collected:'Not collected yet'}[h.status];
  return [...new Set([h.label||'Recorded history',h.kind==='reconstructed'&&!/reconstruct/i.test(h.label||'')?'Reconstructed':h.kind==='retained'&&!/retained/i.test(h.label||'')?'Retained history':null,status,!h.complete?'Partial history':null].filter(Boolean))].join(' · ');
}
function runningPoints(points){let total=0;return (points||[]).map(p=>({...p,value:finite(p.value)?(total+=p.value):null}));}
export function presentRepository(repo,mode='totals') {
  const rawMetrics=repo.rawMetrics || repo.metrics || {},metrics={};
  for(const [key,raw] of Object.entries(rawMetrics)){
    if(key==='star_activity')continue;
    const h=raw.history, daily=mode==='daily',balance=raw.kind==='balance';
    const source=daily&&key==='stars'?rawMetrics.star_activity:raw;
    const dailyEvent=daily&&(key==='stars'||!balance);
    const points=dailyEvent?source?.points||[]:h?h.points||[]:balance?raw.points||[]:runningPoints(raw.points);
    const chartLabel=dailyEvent?(key==='stars'?'Daily stars gained · current surviving stars':'Daily activity'):
      h?(balance&&h.kind==='recorded'?'Recorded balance':'Totals over history'):
      balance?'Recorded balance':'Recorded history · selected range only';
    metrics[key]={...raw,value:h?(finite(h.value)?h.value:null):raw.value,points,delta:null,presentationMode:daily?'daily':'totals',rawMetric:source||{points:[]},observedBalance:balance?{observedAt:raw.observedAt,points:raw.points}:undefined,
      countLabel:key==='stars'?'Total stars':balance&&(!h||h.kind==='recorded')?'Recorded balance':h?'History total':'Recorded history',
      chartKind:dailyEvent?'event':'balance',chartLabel,
      chartCoverage:dailyEvent?source?.coverage:h?{start:h.from,end:points.findLast(p=>finite(p.value))?.date??null,complete:h.complete&&points.length>0&&points.every(p=>finite(p.value))}:raw.coverage,
      chartSource:source?.source,chartLastSuccess:source?.lastSuccess,chartStatus:source?.status,
      chartUnavailableReason:points.some(p=>finite(p.value))?null:dailyEvent&&key==='stars'?(observed(source)?'No observations in this range':unavailableReason(repo,'star_activity')):h?.status==='no_access'?'No access':h?.status==='backfilling'?'Backfilling history':h?.status==='error'?'History collection failed':null};
  }
  // Backfill/collection freshness must never reorder actual event activity.
  const lastActivityAt=Object.hasOwn(repo,'lastActivityAt')?repo.lastActivityAt:new Date(repositoryActivity({...repo,metrics:rawMetrics})).toISOString();
  return {...repo,lastActivityAt,rawMetrics,metrics};
}
export function githubURL(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'github.com' && !u.port && !u.username && !u.password ? u.href : null; } catch { return null; }
}
// Navigation only: these destinations never imply locally collected records.
export function githubMetricAction(repo,key,dates=[]) {
  const safe=githubURL(repo.url);if(!safe)return null;
  const base=new URL(safe);
  if(base.search||base.hash||!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(base.pathname))return null;
  const paths={commits:'commits',issues:'issues',merged_prs:'pulls',releases:'releases',stars:'stargazers',forks:'forks',views:'graphs/traffic',clones:'graphs/traffic'};
  const labels={commits:'Browse commits',issues:'Triage open issues',merged_prs:'Review merged PRs',releases:'Browse releases',stars:'View stargazers',forks:'Explore forks',views:'View traffic on GitHub',clones:'View traffic on GitHub'};
  if(!Object.hasOwn(paths,key))return null;
  const url=new URL(base.href.replace(/\/$/,'')+'/'+paths[key]);
  const valid=dates.length>0&&dates.every(d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d);
  const start=valid?dates[0]:null,end=valid?dates.at(-1):null,range=start&&start<=end;
  if(key==='issues')url.searchParams.set('q','is:issue is:open');
  if(key==='merged_prs')url.searchParams.set('q','is:pr is:merged'+(range?' merged:'+start+'..'+end:''));
  if(key==='commits'&&range){url.searchParams.set('since',start+'T00:00:00Z');url.searchParams.set('until',end+'T23:59:59Z');}
  return {url:url.href,label:labels[key]};
}
export function aligned(metric, dates) {
  const points = new Map((metric.points || []).map(p => [p.date, p.value]));
  return dates.map(date => ({date, value: finite(points.get(date)) ? points.get(date) : null}));
}
function observationDay(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))return null;
  const time=Date.parse(value);
  return Number.isFinite(time)?new Date(time).toISOString().slice(0,10):null;
}
function latestBalanceDay(metric){
  metric=metric.observedBalance||metric;
  return observationDay(metric.observedAt)||(metric.points||[]).filter(p=>finite(p.value)).map(p=>observationDay(p.date)).filter(Boolean).sort().at(-1)||null;
}
function mergeHistories(histories,value,points,allCounted){
  if(!histories.some(Boolean))return undefined;
  const statuses=histories.map(h=>h?.status||'limited');
  const status=['error','no_access','backfilling','not_collected','limited'].find(s=>statuses.includes(s))||'complete';
  const kinds=[...new Set(histories.map(h=>h?.kind||'recorded'))];
  return {value,points,baseline:histories.every(h=>finite(h?.baseline))?histories.reduce((sum,h)=>sum+h.baseline,0):null,
    from:histories.every(h=>h?.from)?histories.map(h=>h.from).sort()[0]:null,
    complete:allCounted&&histories.every(h=>h?.complete===true)&&status==='complete',status,
    kind:kinds.includes('reconstructed')?'reconstructed':kinds.includes('retained')?'retained':'recorded',
    label:[...new Set(histories.map(h=>h?.label||'Recorded history · selected range only'))].join(' · ')};
}
// Every plotted point uses ALL headline contributors. Never substitute a
// smaller, better-covered cohort underneath a larger headline count.
export function aggregate(repos, key, dates) {
  const all=repos.map(repo=>({repo,metric:repo.metrics?.[key]?.presentationMode?repo.metrics[key]:presentRepository(repo).metrics[key]})),counted=all.filter(x=>finite(x.metric?.value));
  if(!counted.length){
    const first=all.find(x=>x.metric?.history)?.metric;if(!first)return null;
    const points=dates.map(date=>({date,value:null})),history=mergeHistories(all.map(x=>x.metric?.history),null,points,false);
    return {...first,value:null,points,history,contributors:[],chartContributors:[],chartCoverage:{complete:false},chartUnavailableReason:historyNote({history})};
  }
  const first=counted[0].metric;
  const sumPoints=select=>{
    const series=counted.map(x=>aligned(select(x.metric)||{},dates));
    return dates.map((date,i)=>({date,value:series.every(p=>finite(p[i].value))?series.reduce((sum,p)=>sum+p[i].value,0):null}));
  };
  const points=sumPoints(m=>m),value=counted.reduce((sum,x)=>sum+x.metric.value,0);
  const history=mergeHistories(all.map(x=>x.metric?.history),value,sumPoints(m=>m.history||m),counted.length===repos.length);
  if(history)history.baseline=counted.every(x=>finite(x.metric.history?.baseline))?counted.reduce((sum,x)=>sum+x.metric.history.baseline,0):null;
  const coverage={start:points.find(p=>finite(p.value))?.date??null,end:points.findLast(p=>finite(p.value))?.date??null,
    complete:counted.length===repos.length&&points.length>0&&points.every(p=>finite(p.value))&&counted.every(x=>(x.metric.chartCoverage||x.metric.coverage)?.complete===true)};
  const balances=counted.filter(x=>x.metric.kind==='balance'&&(!x.metric.history||x.metric.history.kind==='recorded'));
  const chartComparable=balances.length<2||!!latestBalanceDay(balances[0].metric)&&balances.every(x=>latestBalanceDay(x.metric)===latestBalanceDay(balances[0].metric));
  return {...first,history,value,points,delta:null,coverage,chartCoverage:coverage,chartComparable,
    status:combinedStatus(counted.map(x=>x.metric.status)),chartStatus:combinedStatus(counted.map(x=>x.metric.chartStatus)),
    chartLastSuccess:counted.map(x=>x.metric.chartLastSuccess).filter(Boolean).sort()[0]??null,
    chartSource:[...new Set(counted.map(x=>x.metric.chartSource).filter(Boolean))].join('; '),
    chartUnavailableReason:[...new Set(counted.map(x=>x.metric.chartUnavailableReason).filter(Boolean))].join(' · ')||null,
    rawMetric:{points:sumPoints(m=>m.rawMetric||m),unit:first.rawMetric?.unit||first.unit,kind:first.rawMetric?.kind||first.kind},
    contributors:counted.map(x=>x.repo),chartContributors:counted.map(x=>x.repo),
    lastSuccess:counted.map(x=>x.metric.lastSuccess).filter(Boolean).sort()[0]??null};
}
export function chartView(metric,dates,mode='totals') {
  // Presentation points (including backend history) are already in graph units.
  // Mode changes are projected from raw metrics, never from an earlier graph.
  const m=metric.presentationMode?metric:presentRepository({metrics:{metric}},mode).metrics.metric;
  return {points:aligned(m,dates),kind:m.chartKind||m.kind,label:m.chartLabel||'Recorded history'};
}
export function chart(points, {small=false,kind='balance',compact=false,width=390}={}) {
  const w=small?180:width, h=small?38:compact?100:180, left=small?4:42, right=w-8, top=small?4:12, bottom=h-(small?4:compact?20:26);
  const known=points.filter(p=>finite(p.value));
  // A zero reference is an axis, not an observation; retain every null gap.
  const zeroReference=known.every(p=>p.value===0);
  const max=Math.max(1,...known.map(p=>p.value)), min=Math.min(0,...known.map(p=>p.value));
  const coords=points.map((p,i)=>finite(p.value)?{...p,x:points.length===1?(left+right)/2:left+i*(right-left)/(points.length-1),y:bottom-(p.value-min)/(max-min)*(bottom-top)}:null);
  const segments=[]; let current=[];
  for(const p of coords){if(p)current.push(p);else if(current.length){segments.push(current);current=[];}}
  if(current.length)segments.push(current);
  const zero=bottom-(0-min)/(max-min)*(bottom-top),half=points.length>1?(right-left)/(points.length-1)/2:(right-left)/2;
  const paths=segments.map(segment=>{
    if(kind==='event'){
      const start=Math.max(left,segment[0].x-half),end=Math.min(right,segment.at(-1).x+half);
      let d=`M${start},${segment[0].y}`;
      segment.forEach((p,i)=>{if(i)d+=` H${(segment[i-1].x+p.x)/2} V${p.y}`;});d+=` H${end}`;
      return `<path class="chart-area" d="${d} L${end},${zero} L${start},${zero} Z"/><path class="chart-line" d="${d}"/>`;
    }
    if(segment.length===1)return `<circle class="chart-dot" cx="${segment[0].x}" cy="${segment[0].y}" r="2"><title>${escapeHTML(segment[0].date)}: ${fmt(segment[0].value)}</title></circle>`;
    const d=segment.map((p,i)=>`${i?'L':'M'}${p.x},${p.y}`).join(' ');
    return `<path class="chart-area" d="${d} L${segment.at(-1).x},${zero} L${segment[0].x},${zero} Z"/><path class="chart-line" d="${d}"/>`;
  }).join('');
  const baseline=`<line class="chart-baseline${zeroReference?' chart-zero-reference':''}" x1="${left}" y1="${zero}" x2="${right}" y2="${zero}"/>`;
  const hits=small?'':coords.filter(Boolean).map(p=>`<circle class="chart-hit" cx="${p.x}" cy="${p.y}" r="5"><title>${escapeHTML(p.date)}: ${fmt(p.value)}</title></circle>`).join('');
  const axes=small?'':`<line class="chart-grid" x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"/><text class="chart-axis" x="0" y="16">${fmt(max)}</text><text class="chart-axis" x="0" y="${bottom}">${fmt(min)}</text><text class="chart-axis" x="${left}" y="${h-4}">${escapeHTML(points[0]?.date)}</text><text class="chart-axis" text-anchor="end" x="${right}" y="${h-4}">${escapeHTML(points.at(-1)?.date)}</text>`;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${axes}${baseline}${paths}${hits}</svg>`;
}
export function csvCell(value) {
  let text=String(value ?? '');
  if(typeof value !== 'number' && /^[\s\u0000-\u001f]*[=+@-]/.test(text)) text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
export function exportCSV(repos,range) {
  const rows=[['repository','metric','value','unit','range','coverage_start','coverage_end','coverage_complete','last_success']];
  for(const r of repos)for(const key of keys({metrics:r.rawMetrics||r.metrics}).filter(k=>k!=='star_activity')){const m=r.rawMetrics?.[key]||r.metrics[key];rows.push([r.owner+'/'+r.name,m.label,m.value,m.unit,range,m.coverage?.start,m.coverage?.end,m.coverage?.complete,m.lastSuccess]);}
  return rows.map(row=>row.map(csvCell).join(',')).join('\r\n');
}
