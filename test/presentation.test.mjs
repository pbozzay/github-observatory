import test from 'node:test';
import assert from 'node:assert/strict';
import {presentRepository,aggregate,chart,issueLevel,validateThresholds,chartView,validateChartKeys,githubMetricAction,repositoryActivity,compareRepositories,validateRowKeys} from '../public/metrics.js';
const dates=['2026-01-01','2026-01-02','2026-01-03'];
test('recent activity uses persisted event time, never totals, balances or sync freshness',()=>{
 const repo=(name,lastActivityAt)=>({name,owner:'synthetic-labs',lastActivityAt,metrics:{}});
 const old={...repo('alpha','2026-01-01T10:00:00Z'),updatedAt:'2026-02-01',metrics:{commits:{kind:'event',value:999,points:[{date:'2026-01-03',value:10}]}}};
 const recent=repo('zeta','2026-01-02T10:00:00Z');
 assert.deepEqual([old,recent].sort(compareRepositories).map(r=>r.name),['zeta','alpha']);
 assert.deepEqual([repo('zeta',null),repo('alpha',null)].sort(compareRepositories).map(r=>r.name),['alpha','zeta']);
 const fallback={name:'fallback',metrics:{commits:{kind:'event',value:99,lastSuccess:'2026-02-01',points:[{date:'2026-01-01',value:2},{date:'2026-01-03',value:0}]},stars:{kind:'balance',points:[{date:'2026-01-03',value:999}]}}};
 assert.equal(repositoryActivity(fallback),Date.parse('2026-01-01'));
 assert.equal(repositoryActivity({metrics:{stars:fallback.metrics.stars}}),0);
 assert.equal(repositoryActivity({metrics:{views:{kind:'event',points:[{date:'2026-02-01',value:100}]},clones:{kind:'event',points:[{date:'2026-02-01',value:5}]}}}),0,'traffic counters are not recorded GitHub events');
 assert.equal(repositoryActivity({...fallback,lastActivityAt:null}),0,'an explicit no-activity result is authoritative');
 assert.equal(repositoryActivity(presentRepository({metrics:{stars:fallback.metrics.stars,star_activity:{kind:'event',points:[{date:'2026-01-02',value:1}]}}})),Date.parse('2026-01-02'));
 assert.deepEqual([old,recent].sort((a,b)=>compareRepositories(a,b,'name')).map(r=>r.name),['alpha','zeta']);
});
test('row preferences are independent, permit no metrics, and reject duplicates or unsafe keys',()=>{
 assert.deepEqual(validateRowKeys(['stars','commits']),['stars','commits']);assert.deepEqual(validateRowKeys([]),[]);
 for(const value of [null,{},['stars','stars'],['star_activity'],['<script>']])assert.equal(validateRowKeys(value),null);
});
test('metric actions use safe repository destinations and honest date semantics',()=>{
 const r={url:'https://github.com/northstar-labs/atlas-api'};
 const action=k=>new URL(githubMetricAction(r,k,dates).url);
 assert.equal(action('issues').searchParams.get('q'),'is:issue is:open');
 assert.equal(action('merged_prs').searchParams.get('q'),'is:pr is:merged merged:2026-01-01..2026-01-03');
 assert.equal(action('commits').searchParams.get('since'),'2026-01-01T00:00:00Z');
 assert.equal(action('commits').searchParams.get('until'),'2026-01-03T23:59:59Z');
 for(const [key,path] of [['stars','stargazers'],['forks','forks'],['releases','releases'],['views','graphs/traffic'],['clones','graphs/traffic']])assert.equal(action(key).pathname,'/northstar-labs/atlas-api/'+path);
 for(const url of ['javascript:alert(1)','https://github.com.evil.test/a/b','https://user@github.com/a/b','https://github.com/a/b/issues','https://github.com/a/b?bad=1'])assert.equal(githubMetricAction({url},'issues',dates),null);
 assert.equal(githubMetricAction(r,'unknown',dates),null);
 assert.equal(new URL(githubMetricAction(r,'commits',['bad']).url).search,'');
 assert.equal(new URL(githubMetricAction(r,'merged_prs',[]).url).searchParams.get('q'),'is:pr is:merged');
});
const metric=(kind,value,values)=>({label:'Stars',kind,unit:'stars',value,delta:null,points:dates.map((date,i)=>({date,value:values[i]})),coverage:{start:dates[0],end:dates[2],complete:true},lastSuccess:'2026-01-03T12:00:00Z'});
test('one Stars metric keeps current count distinct from its daily-gains graph',()=>{
 const raw={id:'a',metrics:{stars:metric('balance',100,[null,null,100]),star_activity:metric('event',5,[2,0,3])}};
 const r=presentRepository(raw,'daily');
 assert.deepEqual(Object.keys(r.metrics),['stars']);assert.equal(r.metrics.stars.value,100);
 assert.deepEqual(r.metrics.stars.points.map(p=>p.value),[2,0,3]);assert.equal(r.metrics.stars.kind,'balance');assert.equal(r.metrics.stars.chartKind,'event');
 assert.equal(raw.metrics.stars.points[2].value,100);assert.ok(raw.metrics.star_activity);
 const total=aggregate([r,presentRepository({...raw,id:'b'},'daily')],'stars',dates);
 assert.equal(total.value,200);assert.deepEqual(total.points.map(p=>p.value),[4,0,6]);assert.equal(total.chartKind,'event');
 const fallback=presentRepository({id:'c',metrics:{stars:metric('balance',50,[null,null,50])}});
 assert.equal(fallback.metrics.stars.chartKind,'balance');assert.equal(aggregate([r,fallback],'stars',dates).value,150);assert.equal(aggregate([r,fallback],'stars',dates).chartContributors.length,2);
});
test('issue thresholds use strict greater-than boundaries and validated settings',()=>{
 assert.deepEqual([0,1,2,3,4].map(v=>issueLevel(v,{warning:1,danger:3})),['','', 'warning','warning','danger']);
 assert.equal(issueLevel(null,{warning:1,danger:3}),'');assert.equal(issueLevel(6,{warning:5,danger:10}),'warning');
 assert.deepEqual(validateThresholds({warning:0,danger:2}),{warning:0,danger:2});
 for(const value of [{warning:-1,danger:3},{warning:3,danger:3},{warning:4,danger:2},{warning:1.2,danger:3},{warning:'1',danger:3}])assert.equal(validateThresholds(value),null);
});
test('event graphs fill to a zero baseline with steps and never fill across unknown days',()=>{
 const svg=chart(metric('event',4,[0,4,0]).points,{small:true,kind:'event'});
 assert.match(svg,/class="chart-baseline"/);assert.match(svg,/class="chart-area"/);assert.match(svg,/H/);assert.match(svg,/V/);
 const gaps=chart([{date:dates[0],value:2},{date:dates[1],value:null},{date:dates[2],value:4}],{kind:'event'});
 assert.equal((gaps.match(/class="chart-area"/g)||[]).length,2);assert.doesNotMatch(gaps,/>2026-01-02: 0</);
 const zero=chart(metric('event',0,[0,0,0]).points,{small:true,kind:'event'});assert.match(zero,/chart-baseline/);assert.doesNotMatch(zero,/NaN|Infinity/);
});

test('aggregate coverage never upgrades authoritative partial coverage',()=>{
 const partial={...metric('event',6,[1,2,3]),coverage:{start:dates[0],end:dates[2],complete:false}};
 assert.equal(aggregate([{id:'a',metrics:{commits:partial}}],'commits',dates).coverage.complete,false);
 const full={...partial,coverage:{...partial.coverage,complete:true}};
 assert.equal(aggregate([{id:'a',metrics:{commits:full}},{id:'b',metrics:{commits:partial}}],'commits',dates).coverage.complete,false);
 assert.equal(aggregate([{id:'a',metrics:{commits:full}}],'commits',dates).coverage.complete,true);
});
test('unified Stars and aggregates preserve independent graph failure and coverage',()=>{
 const raw={id:'a',metrics:{stars:{...metric('balance',100,[null,null,100]),status:'ok',source:'Metadata'},star_activity:{...metric('event',5,[2,0,3]),status:'ok',source:'Daily star history'}}};
 const good=presentRepository(raw,'daily');
 const failed=presentRepository({...raw,id:'b',metrics:{...raw.metrics,star_activity:{...raw.metrics.star_activity,status:'error',lastSuccess:'2026-01-02T12:00:00Z',coverage:{...raw.metrics.star_activity.coverage,complete:false}}}},'daily');
 assert.equal(failed.metrics.stars.status,'ok');assert.equal(failed.metrics.stars.chartStatus,'error');assert.equal(failed.metrics.stars.chartSource,'Daily star history');
 const total=aggregate([good,failed],'stars',dates);
 assert.equal(total.value,200);assert.equal(total.status,'ok');assert.equal(total.chartStatus,'error');
 assert.equal(total.coverage.complete,false);assert.equal(total.chartCoverage.complete,false);assert.equal(total.chartLastSuccess,'2026-01-02T12:00:00Z');
});

test('cumulative view sums observed events within the range without filling gaps',()=>{
 const days=['1','2','3','4','5'],m={kind:'event',value:5,coverage:{complete:false},points:days.map((date,i)=>({date,value:[null,2,0,null,3][i]}))};
 const copy=JSON.stringify(m),running=chartView(m,days,'totals');
 assert.deepEqual(running.points.map(p=>p.value),[null,2,2,null,5]);assert.equal(running.kind,'balance');assert.match(running.label,/Recorded history.*selected range/);
 assert.deepEqual(chartView(m,days,'daily').points.map(p=>p.value),[null,2,0,null,3]);assert.equal(chartView(m,days,'daily').kind,'event');assert.equal(JSON.stringify(m),copy);
 assert.deepEqual(chartView(m,[],'totals').points,[]);
});
test('balance graphs are never summed; unified Stars accumulates only gains',()=>{
 const balance=metric('balance',8,[5,7,8]);
 assert.deepEqual(chartView(balance,dates,'totals').points.map(p=>p.value),[5,7,8]);assert.equal(chartView(balance,dates,'totals').label,'Recorded balance');
 const stars=presentRepository({metrics:{stars:balance,star_activity:metric('event',5,[2,0,3])}},'daily').metrics.stars;
 assert.deepEqual(chartView(stars,dates,'totals').points.map(p=>p.value),[2,0,3]);assert.equal(stars.value,8);assert.equal(chartView(stars,dates,'totals').label,'Daily stars gained · current surviving stars');
 assert.equal(chartView(stars,dates,'daily').label,'Daily stars gained · current surviving stars');
});

test('four-card preferences accept only unique supported metrics',()=>{
 const defaults=['commits','stars','views','issues'];assert.deepEqual(validateChartKeys(defaults),defaults);
 assert.deepEqual(validateChartKeys(['issues','clones','forks','releases']),['issues','clones','forks','releases']);
 for(const value of [null,{},['commits'],['commits','stars','views','views'],['commits','stars','views','star_activity'],['commits','stars','views','<script>'],['commits','stars','views',null]])assert.equal(validateChartKeys(value),null);
});
