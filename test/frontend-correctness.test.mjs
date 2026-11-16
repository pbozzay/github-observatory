import test from 'node:test';
import assert from 'node:assert/strict';
import {unavailableReason, presentRepository, aggregate, collectionWarning, collectionProblem} from '../public/metrics.js';

test('missing metric explanations preserve bounded backend labels, never provider strings',()=>{
  for(const label of ['Not collected yet','No observations yet','Collection in progress']){
    assert.equal(unavailableReason({metricAvailability:{stars:{state:'not_collected',label}}},'stars'),label);
  }
  for(const [state,label,expected] of [
    ['not_collected','provider secret','Not collected yet'],
    ['not_collected','Disabled on repo','Not collected yet'],
    ['provider secret','Collection in progress','Not collected yet'],
    ['no_access','provider secret','No access'],
    ['disabled','No observations yet','Disabled on repo'],
    ['__proto__','Collection in progress','Not collected yet'],
  ])assert.equal(unavailableReason({metricAvailability:{stars:{state,label}}},'stars'),expected);
});

test('retained collection warnings recognize disabled and access statuses without trusting provider text',()=>{
  for(const [status,label] of [['disabled','Disabled on repo'],['no_access','No access'],['forbidden','No access'],['unauthorized','No access'],['credentials_missing','No access'],['network_error','Collection failed']]){
    assert.equal(collectionProblem(status),true);
    const r={metrics:{issues:{value:4,status}}},before=JSON.stringify(r);
    assert.equal(collectionWarning(r,'issues'),label);
    assert.equal(JSON.stringify(r),before,'warnings never rewrite retained data');
  }
  assert.equal(collectionProblem('provider secret'),false);
  assert.equal(collectionWarning({metrics:{issues:{value:4,status:'provider secret'}},metricAvailability:{issues:{state:'provider secret',label:'provider secret'}}},'issues'),'');
});

const range=['2026-07-19','2026-07-20'];
const retained=(id,value,observedAt,points=[])=>presentRepository({id,metrics:{stars:{label:'Stars',kind:'balance',unit:'stars',value,observedAt,points}}});
test('empty gained aggregates summarize every contributor rather than borrowing the first reason',()=>{
  const missing=presentRepository({id:'missing',metrics:{stars:{kind:'balance',value:7,points:[]}},metricAvailability:{star_activity:{state:'no_access'}}},'daily');
  const old=presentRepository({id:'old',metrics:{stars:{kind:'balance',value:1433,points:[]},star_activity:{kind:'event',value:15,observedAt:'2026-06-20T12:00:00Z',points:[]}}},'daily');
  for(const repos of [[missing,old],[old,missing]]){
    const result=aggregate(repos,'stars',range);
    assert.match(result.chartUnavailableReason,/No observations in this range/);
    assert.match(result.chartUnavailableReason,/No access/);
    assert.equal(result.value,1440);
    assert.ok(result.points.every(point=>point.value===null));
  }
});

test('total-star comparability follows actual retained observation dates outside the range',()=>{
  const a=retained('a',1433,'2026-06-20T12:00:00Z');
  for(const [at,expected] of [['2026-06-21T12:00:00Z',false],['2026-06-20T23:00:00Z',true],[undefined,false],['invalid',false]]){
    const result=aggregate([a,retained('b',7,at)],'stars',range);
    assert.equal(result.value,1440);assert.deepEqual(result.points,range.map(date=>({date,value:null})));
    assert.equal(result.chartComparable,expected,String(at));
  }
  assert.equal(aggregate([retained('a',1433),retained('b',7)],'stars',range).chartComparable,false,'two unknown dates do not prove comparability');
});
test('retained timestamps take priority over ranged points; legacy fallback uses all recorded points',()=>{
  const points=[{date:range[0],value:1}];
  assert.equal(aggregate([retained('a',1433,'2026-07-20T12:00:00Z',points),retained('b',7,'2026-07-21T12:00:00Z',points)],'stars',range).chartComparable,false);
  const oldPoints=day=>[{date:day,value:7},{date:'2026-08-01',value:null}];
  for(const [day,expected] of [['2026-06-20',true],['2026-06-21',false]]){
    assert.equal(aggregate([retained('a',1433,undefined,oldPoints('2026-06-20')),retained('b',7,'invalid',oldPoints(day))],'stars',range).chartComparable,expected);
  }
});
