import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {CARD_METRICS} from '../public/metrics.js';
const days=Array.from({length:90},(_,i)=>new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10));
const keys=Object.keys(CARD_METRICS);
function dashboard(range='30'){
 const dates=days.slice(range==='all'?0:-Number(range));
 const metrics=Object.fromEntries(keys.map((key,i)=>{
  const balance=key==='issues',retained=['views','clones'].includes(key),reconstructed=['stars','forks'].includes(key);
  return [key,{label:CARD_METRICS[key],kind:['stars','forks','issues'].includes(key)?'balance':'event',value:balance?20:dates.length,unit:key,source:'Synthetic raw observations',status:'ok',observedAt:days.at(-1)+'T12:00:00Z',lastSuccess:days.at(-1)+'T12:00:00Z',coverage:{start:dates[0],end:dates.at(-1),complete:true},points:dates.map(date=>({date,value:balance?20:1})),history:{value:balance?20:190+i,points:dates.map(date=>({date,value:balance?20:101+days.indexOf(date)+i})),baseline:balance?20:100+days.indexOf(dates[0])+i,from:'2025-01-01',complete:!retained,status:retained?'limited':'complete',kind:retained?'retained':reconstructed?'reconstructed':'recorded',label:retained?'Retained traffic · daily counts, not lifetime uniques':reconstructed?'Current surviving cohort · reconstructed':balance?'Open issues · since tracking':'Recorded event history'}}];
 }));
 metrics.star_activity={label:'Stars gained',kind:'event',value:dates.length,unit:'stars',source:'Raw surviving-star event dates',points:dates.map(date=>({date,value:1})),coverage:{complete:true}};
 return {dates,repos:[{id:'a',owner:'fixture',name:'alpha',url:'https://github.com/fixture/alpha',lastActivityAt:'2025-12-31T12:00:00Z',metrics}],updatedAt:days.at(-1)};
}
async function setup(t,{storage,blocked=false}={}){
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(5000);
 if(storage)await context.addInitScript(storage=>{if(!sessionStorage.getItem('seeded')){for(const [k,v]of Object.entries(storage))localStorage.setItem(k,v);sessionStorage.setItem('seeded','yes');}},storage);
 if(blocked)await context.addInitScript(()=>{Storage.prototype.setItem=()=>{throw new Error('Blocked');};});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));let transform=x=>x,fail=false;
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());assert.equal(url.hostname,'observatory.test');
  const send=v=>route.fulfill({contentType:'application/json',body:JSON.stringify(v)});
  if(url.pathname==='/api/session')return send({csrf:'test'});
  if(url.pathname==='/api/notifications')return send({items:[],total:0,unreadCount:0,offset:0,limit:50,hasMore:false,snapshot:0,coverage:{complete:false,label:'Synthetic retained events'},status:'ready',updatedAt:null});
      if(url.pathname==='/api/dashboard')return fail?route.fulfill({status:500,body:'error'}):send(transform(dashboard(url.searchParams.get('range'))));
  if(url.pathname==='/api/details')return send({items:[],total:0,offset:0,limit:50,hasMore:false,kind:'observations',status:'ok',complete:false});
  assert.ok(!url.pathname.startsWith('/api/'));
  const name=url.pathname==='/'?'index.html':url.pathname.slice(1);return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.ico')?'image/x-icon':name.endsWith('.png')?'image/png':'text/html',body:await readFile(new URL('../public/'+name,import.meta.url))});
 });
 await page.goto('http://observatory.test');await page.waitForSelector('.project-card');
 t.after(()=>assert.deepEqual(errors,[]));
 return {page,setTransform:fn=>transform=fn,setFailure:v=>fail=v};
}
test('all eight families keep history counts on 7/30/90 zoom; graph baselines, daily data, raw details and Settings agree',async t=>{
 const {page,setFailure}=await setup(t);
 assert.equal(await page.getAttribute('[data-chart-mode="totals"]','aria-pressed'),'true');assert.equal(await page.locator('[data-star-mode]').count(),0);
 for(const key of keys){
  await page.selectOption('[data-slot="0"]',key);
  const card=page.locator(`[data-aggregate="${key}"]`),expected=String(key==='issues'?20:190+keys.indexOf(key));
  for(const range of ['7','30','90']){
   await page.click(`[data-range="${range}"]`);await page.waitForFunction(range=>document.querySelector(`[data-range="${range}"]`).getAttribute('aria-pressed')==='true',range);
   assert.equal(await card.locator('strong').textContent(),expected,key+' '+range);assert.equal(await page.locator(`[data-project="a"] [data-metric="${key}"] .spark-value`).textContent(),expected);
   assert.equal(await card.locator('.chart-hit title').last().textContent(),days.at(-1)+': '+expected);
   assert.equal(await card.locator('.chart-hit title').first().textContent(),days.at(-Number(range))+': '+(key==='issues'?20:191-Number(range)+keys.indexOf(key)));
  }
 }
 await page.selectOption('[data-slot="0"]','commits');await page.click('[data-project="a"] [data-metric="commits"]');
 assert.match(await page.locator('#dialog .chart-explanation').textContent(),/history/i);
 assert.match(await page.locator('#dialog .provenance').textContent(),/100/,'opening history baseline is inspectable');
 assert.equal(await page.locator('#dialog details tbody td').first().textContent(),'1','raw observation table is not cumulative');
 await page.keyboard.press('Escape');await page.click('#settings');assert.equal(await page.inputValue('#graph-mode-setting'),'totals');await page.selectOption('#graph-mode-setting','daily');await page.click('#preferences-form button[type="submit"]');await page.keyboard.press('Escape');
 assert.equal(await page.getAttribute('[data-chart-mode="daily"]','aria-pressed'),'true');assert.equal(await page.locator('[data-aggregate="commits"] strong').textContent(),'190');
 assert.equal(await page.locator('[data-aggregate="commits"] .chart-hit title').first().textContent(),days[0]+': 1');
 assert.match(await page.locator('[data-project="a"] [data-metric="stars"]').textContent(),/Daily stars gained/);
 await page.reload();await page.waitForSelector('.project-card');assert.equal(await page.getAttribute('[data-chart-mode="daily"]','aria-pressed'),'true');
 await page.click('[data-project="a"] [data-metric="stars"]');assert.match(await page.locator('#dialog .chart-explanation').textContent(),/current surviving stars/);assert.match(await page.locator('#dialog .provenance').textContent(),/Raw surviving-star event dates/);await page.keyboard.press('Escape');
 await page.click('[data-chart-mode="totals"]');await page.reload();await page.waitForSelector('.project-card');assert.equal(await page.getAttribute('[data-chart-mode="totals"]','aria-pressed'),'true');
 setFailure(true);await page.click('[data-range="7"]');await page.waitForSelector('#error:not([hidden])');assert.equal(await page.locator('[data-aggregate="commits"] strong').textContent(),'190');assert.equal(await page.getAttribute('[data-range="90"]','aria-pressed'),'true');
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
});
test('partial/backfilling/error history, missing cohort days and access warnings stay visible without claiming completeness',async t=>{
 const {page,setTransform}=await setup(t);
 setTransform(d=>{const b=structuredClone(d.repos[0]);b.id='b';b.name='beta';b.metrics.commits.history={...b.metrics.commits.history,value:10,points:[{date:d.dates.at(-1),value:10}],complete:false,status:'backfilling'};b.metrics.stars.history.status='error';b.metrics.stars.history.complete=false;b.metrics.stars.status='no_access';delete b.metrics.star_activity;d.repos.push(b,{id:'c',owner:'fixture',name:'empty',metrics:{}});return d;});
 await page.reload();await page.waitForSelector('.project-card');
 const card=page.locator('[data-aggregate="commits"]');assert.equal(await card.locator('strong').textContent(),'200');assert.equal(await card.locator('.chart-hit').count(),1);assert.match(await card.locator('.aggregate-footer').textContent(),/Backfilling.*Partial history/);assert.match(await card.locator('.aggregate-footer').textContent(),/Incomplete count: 2 of 3/);
 await card.locator('.aggregate-value').click();assert.match(await page.locator('#dialog .cohort-note').textContent(),/2 of 2/);assert.equal(await page.locator('#dialog .contribution-table tbody tr').count(),2);await page.keyboard.press('Escape');
 assert.match(await page.locator('[data-aggregate="stars"] .aggregate-footer').textContent(),/History collection failed/);assert.match(await page.locator('[data-project="b"] [data-metric="stars"]').textContent(),/No access/);
 await page.click('[data-chart-mode="daily"]');assert.equal(await page.locator('[data-aggregate="stars"] .chart-hit').count(),0);assert.equal(await page.locator('[data-aggregate="stars"] strong').textContent(),'382');
 assert.equal(await page.locator('[data-project="c"] .chart-line,[data-project="c"] .chart-dot').count(),0);
});
test('preference migration is conservative and storage failures keep an honest tab-only mode',async t=>{
 const {page}=await setup(t,{storage:{'github-observatory-preferences':JSON.stringify({starMode:'gained',graphMode:'invalid'}),'github-observatory-chart-mode':'cumulative'},blocked:true});
 assert.equal(await page.getAttribute('[data-chart-mode="totals"]','aria-pressed'),'true');await page.click('[data-chart-mode="daily"]');assert.match(await page.locator('#toast').textContent(),/storage is unavailable/);
 await page.click('#settings');assert.equal(await page.inputValue('#graph-mode-setting'),'daily');await page.selectOption('#graph-mode-setting','totals');await page.click('#preferences-form button[type="submit"]');assert.match(await page.locator('#preferences-message').textContent(),/storage is unavailable/);
});
