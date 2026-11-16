import test from 'node:test';
import assert from 'node:assert/strict';
import {presentRepository, aggregate, chartView, repositoryActivity, exportCSV, unavailableReason, missingMetric} from '../public/metrics.js';
const dates=['2026-01-01','2026-01-02','2026-01-03'];
const metric=(kind,value,values,start=dates[0])=>({label:kind==='balance'?'Stars':'Stars gained',unit:'stars',kind,value,points:dates.map((date,i)=>({date,value:values[i]})),coverage:{start,end:dates[2],complete:false},source:'Synthetic',status:'ok'});
const raw={id:'a',owner:'fixture',name:'alpha',metrics:{stars:metric('balance',1433,[1418,null,1433]),star_activity:metric('event',15,[5,null,10])}};
test('Total is default: 1433 balances, not 15 gains; modes preserve raw history, export and activity',()=>{
 const before=JSON.stringify(raw),total=presentRepository(raw),gained=presentRepository(raw,'daily');
 assert.deepEqual(chartView(total.metrics.stars,dates).points.map(p=>p.value),[1418,null,1433]);
 assert.deepEqual(chartView(gained.metrics.stars,dates).points.map(p=>p.value),[5,null,10]);
 assert.equal(total.metrics.stars.value,1433);assert.equal(gained.metrics.stars.value,1433);
 assert.deepEqual(chartView(presentRepository(raw,'totals').metrics.stars,dates,'daily').points,chartView(total.metrics.stars,dates).points);
 assert.equal(repositoryActivity(total),repositoryActivity(raw));assert.equal(repositoryActivity(gained),repositoryActivity(raw));
 assert.deepEqual(presentRepository(gained,'totals').metrics.stars.points,total.metrics.stars.points);
 assert.equal(exportCSV([total],'30'),exportCSV([gained],'30'));assert.equal(JSON.stringify(raw),before);
});
test('Total aggregate uses every counted repository despite different coverage starts, with no backfill',()=>{
 const other={...raw,id:'b',metrics:{stars:metric('balance',7,[null,null,7],dates[2])}};
 const total=aggregate([raw,other].map(r=>presentRepository(r)),'stars',dates);
 assert.equal(total.value,1440);assert.equal(total.chartContributors.length,2);
 assert.deepEqual(total.points.map(p=>p.value),[null,null,1440]);
 const delayed={...other,metrics:{stars:metric('balance',7,[null,7,null])}};
 const partial=aggregate([raw,delayed].map(r=>presentRepository(r)),'stars',dates);
 assert.deepEqual(partial.points.map(p=>p.value),[null,null,null]);assert.equal(partial.value,1440);
 assert.equal(partial.chartComparable,false);
});
test('availability reasons use only explicit safe states; absence and legacy errors never mean disabled',()=>{
 for(const [state,label] of Object.entries({disabled:'Disabled on repo',no_access:'No access',not_collected:'Not collected yet',error:'Collection failed',empty_repository:'No commits yet'})){
  const r={metricAvailability:{issues:{state,label:'<script>unsafe</script>'}}};
  assert.equal(unavailableReason(r,'issues'),label);assert.equal(missingMetric(r,'issues').value,null);
 }
 for(const r of [{},{status:'disabled'}, {metrics:{issues:{status:'forbidden'}}}, {metricAvailability:{issues:{state:'available'}}}, {metricAvailability:{issues:{state:'toString'}}}]){
  assert.equal(unavailableReason(r,'issues'),'Not collected yet');assert.deepEqual(missingMetric(r,'issues').points,[]);
 }
});
test('missing gains never fall back to balance, while true zero and gaps survive',()=>{
 const noGains=presentRepository({...raw,metrics:{stars:raw.metrics.stars}},'daily');
 assert.equal(noGains.metrics.stars.value,1433);assert.ok(chartView(noGains.metrics.stars,dates).points.every(p=>p.value===null));
 assert.equal(noGains.metrics.stars.chartUnavailableReason,'Not collected yet');
 const mixed=aggregate([noGains,presentRepository({...raw,id:'other'})],'stars',dates);
 assert.equal(mixed.chartContributors.length,2);assert.ok(mixed.points.every(p=>p.value===null));
 const zero=presentRepository({...raw,metrics:{stars:raw.metrics.stars,star_activity:metric('event',0,[0,null,0])}},'daily');
 assert.deepEqual(chartView(zero.metrics.stars,dates).points.map(p=>p.value),[0,null,0]);
 const combined=aggregate([noGains,zero],'stars',dates);assert.equal(combined.value,2866);assert.equal(combined.chartContributors.length,2);
 assert.deepEqual(chartView(combined,dates).points.map(p=>p.value),[null,null,null]);
});
