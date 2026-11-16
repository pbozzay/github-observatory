import test from 'node:test';
import assert from 'node:assert/strict';
import {presentRepository, aggregate, chartView, exportCSV, repositoryActivity, CARD_METRICS} from '../public/metrics.js';
const dates=['2026-01-01','2026-01-02','2026-01-03'];
const metric=(key,extra={})=>({label:CARD_METRICS[key],kind:['stars','issues','forks'].includes(key)?'balance':'event',unit:key,value:6,points:dates.map((date,i)=>({date,value:[2,null,4][i]})),coverage:{complete:false},history:{value:106,points:dates.map((date,i)=>({date,value:[102,null,106][i]})),baseline:100,from:'2025-01-01',complete:true,status:'complete',kind:'recorded',label:'Recorded history'},...extra});
const repo=(metrics,id='a')=>({id,owner:'fixture',name:id,lastActivityAt:'2025-12-31T00:00:00Z',metrics});
test('all eight history counts survive zoom and daily mode; supplied running totals are never summed again',()=>{
 for(const key of Object.keys(CARD_METRICS)){
  const raw=repo({[key]:metric(key)}),before=JSON.stringify(raw);
  for(const mode of ['totals','daily']){
   const r=presentRepository(raw,mode),m=r.metrics[key];
   assert.equal(m.value,106,key);assert.equal(repositoryActivity(r),Date.parse(raw.lastActivityAt));
   if(mode==='totals'){
    assert.deepEqual(chartView(m,dates,mode).points.map(p=>p.value),[102,null,106]);
    assert.deepEqual(chartView(m,dates.slice(2),mode).points.map(p=>p.value),[106]);
   }
   assert.match(exportCSV([r],'7'),/"6"/);
  }
  assert.equal(JSON.stringify(raw),before);
 }
});
test('history totals aggregate the entire headline cohort, never a better-covered subset',()=>{
 const a=presentRepository(repo({commits:metric('commits')},'a'));
 const b=presentRepository(repo({commits:metric('commits',{history:{...metric('commits').history,value:9,baseline:7,complete:false,status:'backfilling',points:[{date:dates[2],value:9}]}})},'b'));
 const m=aggregate([a,b,repo({},'unknown')],'commits',dates);
 assert.equal(m.value,115);assert.equal(m.contributors.length,2);assert.equal(m.chartContributors.length,2);
 assert.deepEqual(chartView(m,dates).points.map(p=>p.value),[null,null,115]);
 assert.equal(m.history.complete,false);assert.equal(m.history.status,'backfilling');assert.equal(m.history.baseline,107);
});
test('daily stars use only raw activity, never reconstructed totals or differences across gaps',()=>{
 const stars=metric('stars',{history:{...metric('stars').history,kind:'reconstructed',label:'Current surviving stars · reconstructed'}});
 const raw=repo({stars,star_activity:{kind:'event',value:3,points:dates.map((date,i)=>({date,value:[1,null,2][i]})),source:'Raw star events'}});
 const m=presentRepository(raw,'daily').metrics.stars;
 assert.equal(m.value,106);assert.deepEqual(chartView(m,dates,'daily').points.map(p=>p.value),[1,null,2]);assert.match(chartView(m,dates,'daily').label,/current surviving stars/i);
 const absent=presentRepository(repo({stars}),'daily');assert.ok(chartView(absent.metrics.stars,dates,'daily').points.every(p=>p.value===null));
 const combined=aggregate([presentRepository(raw,'daily'),absent],'stars',dates);assert.ok(chartView(combined,dates,'daily').points.every(p=>p.value===null));
 const balance=presentRepository(repo({issues:metric('issues')}),'daily').metrics.issues;
 assert.deepEqual(chartView(balance,dates,'daily').points.map(p=>p.value),[102,null,106]);assert.match(chartView(balance,dates,'daily').label,/recorded balance/i);
});
test('legacy range data is explicitly scoped; null history count never falls back to range count',()=>{
 const m=metric('commits');delete m.history;
 const shown=presentRepository(repo({commits:m})).metrics.commits;
 assert.equal(shown.value,6);assert.match(chartView(shown,dates).label,/Recorded history.*selected range/i);assert.deepEqual(chartView(shown,dates).points.map(p=>p.value),[2,null,6]);
 const unknown=presentRepository(repo({commits:metric('commits',{history:{...metric('commits').history,value:null,points:[],status:'no_access',complete:false}})})).metrics.commits;
 assert.equal(unknown.value,null);assert.ok(chartView(unknown,dates).points.every(p=>p.value===null));
});

test('uncounted backfills retain status, while missing history cannot hide raw CSV data',()=>{
 const h={...metric('commits').history,value:null,points:[],complete:false,status:'backfilling'};
 const unknown=presentRepository(repo({commits:metric('commits',{history:h})}));
 const empty=aggregate([unknown],'commits',dates);
 assert.equal(empty.value,null);assert.equal(empty.history.status,'backfilling');assert.equal(empty.history.complete,false);assert.equal(empty.contributors.length,0);
 assert.match(exportCSV([unknown],'7'),/"6"/,'raw legacy CSV value survives an unknown full-history count');
 const known=presentRepository(repo({commits:metric('commits')},'known'));
 const partial=aggregate([known,unknown],'commits',dates);assert.equal(partial.value,106);assert.equal(partial.history.status,'backfilling');assert.equal(partial.history.complete,false);
});
test('all daily event families use raw observations; balances remain labeled totals and nulls stay null',()=>{
 for(const key of Object.keys(CARD_METRICS)){
  const raw=metric(key),m=presentRepository(repo({[key]:raw}),'daily').metrics[key],g=chartView(m,dates,'daily');
  assert.equal(m.value,106);
  assert.deepEqual(g.points.map(p=>p.value),key==='stars'?[null,null,null]:raw.kind==='balance'?[102,null,106]:[2,null,4]);
  assert.match(g.label,raw.kind==='balance'&&key!=='stars'?/Recorded balance/:/Daily/);
 }
});
test('reconstructed dates never stand in for observed-balance comparability',()=>{
 const raw=metric('issues',{observedAt:undefined,points:[]});
 const a=presentRepository(repo({issues:raw},'a')),b=presentRepository(repo({issues:raw},'b'));
 assert.equal(aggregate([a,b],'issues',dates).chartComparable,false);
 const reconstructed=metric('stars',{history:{...metric('stars').history,kind:'reconstructed',label:'Current surviving stars'}});
 const result=aggregate([presentRepository(repo({stars:reconstructed},'a')),presentRepository(repo({stars:reconstructed},'b'))],'stars',dates);
 assert.equal(result.chartComparable,true);assert.equal(result.history.kind,'reconstructed');assert.doesNotMatch(chartView(result,dates).label,/observed/i);
});
