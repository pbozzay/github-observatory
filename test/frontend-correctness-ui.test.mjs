import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const dates=['2026-07-19','2026-07-20'];
const balance=(label,value,day='2026-06-20')=>({label,kind:'balance',unit:label.toLowerCase(),value,observedAt:day+'T12:00:00Z',points:[{date:day,value}],coverage:{start:day,end:day,complete:false},source:'Synthetic',status:'ok'});
const repo=(id,metrics={},metricAvailability={})=>({id,owner:'fixture',name:id,url:'https://github.com/fixture/'+id,metrics,metricAvailability});
async function openFixture(t,dashboard){
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(6000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());assert.equal(url.hostname,'observatory.test');
    const send=body=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname==='/api/session')return send({csrf:'fixture-csrf'});
    if(url.pathname==='/api/dashboard')return send(dashboard);
    if(url.pathname==='/api/details')return send({items:[],total:0,offset:0,limit:50,hasMore:false,kind:'observations',complete:false,status:'ok',observedAt:'2026-06-20T12:00:00Z'});
    assert.ok(!url.pathname.startsWith('/api/'));
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.png')?'image/png':name.endsWith('.ico')?'image/x-icon':'text/html',body:await readFile(new URL('../public/'+name,import.meta.url))});
  });
  await page.goto('http://observatory.test');await page.waitForSelector('.project-card');
  t.after(()=>assert.deepEqual(errors,[]));
  return page;
}

test('retained stars outside the window say no observations in range on every surface',async t=>{
  const page=await openFixture(t,{dates,repos:[repo('retained',{stars:balance('Stars',1433)})]});
  const row=page.locator('[data-project="retained"] [data-metric="stars"]'),card=page.locator('[data-aggregate="stars"]');
  for(const surface of [row,card]){
    assert.match(await surface.textContent(),/1,433/);
    assert.equal(await surface.locator('.unavailable-label').textContent(),'No observations in this range');
    assert.equal(await surface.locator('.chart-axis,.chart-dot,.chart-area').count(),0);
    assert.doesNotMatch(await surface.textContent(),/Not collected yet/);
  }
  await row.click();
  assert.equal(await page.locator('#dialog .unavailable-label').textContent(),'No observations in this range');
  await page.click('#full-history');
  assert.equal(await page.locator('#detail .unavailable-label').textContent(),'No observations in this range');
  assert.match(await page.locator('#detail .detail-chart-top').textContent(),/1,433/);
});

test('gains outside the window differ from entirely missing gains regardless of total balance',async t=>{
  const dashboard={dates,repos:[
    repo('retained',{stars:balance('Stars',1433),star_activity:{...balance('Stars gained',15),kind:'event',points:dates.map(date=>({date,value:null}))}},{star_activity:{state:'available',label:'Available'}}),
    ...['no_access','error','not_collected'].map(state=>repo(state,{stars:balance('Stars',7)},{star_activity:{state}})),
  ]};
  const page=await openFixture(t,dashboard);await page.click('[data-star-mode="gained"]');
  for(const [id,label] of [['retained','No observations in this range'],['no_access','No access'],['error','Collection failed'],['not_collected','Not collected yet']]){
    const row=page.locator(`[data-project="${id}"] [data-metric="stars"]`);
    assert.equal(await row.locator('.unavailable-label').textContent(),label);
    assert.equal(await row.locator('.chart-axis,.chart-dot,.chart-area').count(),0);
    await row.click();assert.equal(await page.locator('#dialog .unavailable-label').textContent(),label);await page.keyboard.press('Escape');
  }
  await page.fill('#search','retained');
  assert.equal(await page.locator('[data-aggregate="stars"] .unavailable-label').textContent(),'No observations in this range');
});

test('aggregate warns about different or unknown retained dates even with no ranged observations',async t=>{
  const dashboard={dates,repos:[repo('alpha',{stars:{...balance('Stars',1433),points:[]}}),repo('beta',{stars:{...balance('Stars',7,'2026-06-21'),points:[]}})]};
  const page=await openFixture(t,dashboard),card=page.locator('[data-aggregate="stars"]');
  assert.match(await card.textContent(),/1,440/);assert.match(await card.textContent(),/not comparable/);
  await card.locator('.aggregate-value').click();assert.match(await page.locator('#dialog .chart-explanation').textContent(),/not comparable/);await page.keyboard.press('Escape');
  dashboard.repos[1].metrics.stars.observedAt='2026-06-20T23:00:00Z';
  await page.reload();await page.waitForSelector('.project-card');
  assert.doesNotMatch(await card.textContent(),/not comparable/);
  assert.equal(await card.locator('.unavailable-label').textContent(),'No observations in this range');
  for(const r of dashboard.repos)delete r.metrics.stars.observedAt;
  await page.reload();await page.waitForSelector('.project-card');
  assert.match(await card.textContent(),/not comparable.*unknown observation dates/);
});

test('retained issue counts keep current availability warnings in rows, dialogs and full history',async t=>{
  const fixtures=[['disabled','Disabled on repo'],['no_access','No access'],['error','Collection failed']];
  const dashboard={dates,repos:fixtures.map(([state,label])=>repo(state,{issues:{...balance('Open issues',4,dates[1]),status:state==='disabled'?'disabled':'ok'}},{issues:{state,label:'provider secret'}}))};
  const page=await openFixture(t,dashboard);
  for(const [state,label] of fixtures){
    const row=page.locator(`[data-project="${state}"] [data-metric="issues"]`);
    assert.equal(await row.locator('.spark-value').textContent(),'4');
    assert.match(await row.textContent(),new RegExp(label));
    assert.match(await row.getAttribute('aria-label'),new RegExp(label));
    assert.equal(await row.locator('.chart-dot').count(),1,'retained observations remain charted');
    await row.click();
    assert.match(await page.locator('#dialog .provenance').textContent(),new RegExp(label));
    assert.match(await page.locator('#dialog .detail-chart-top').textContent(),/4/);
    await page.click('#full-history');
    assert.match(await page.locator('#detail .provenance').textContent(),new RegExp(label));
    assert.match(await page.locator('#detail .detail-chart-top').textContent(),/4/);
    assert.equal(await page.locator('#detail .chart-dot').count(),1);
    await page.click('#back');
  }
  assert.doesNotMatch(await page.locator('body').textContent(),/provider secret/);
});

test('mixed aggregate collection warnings report affected projects instead of inheriting the first status',async t=>{
  const dashboard={dates,repos:[
    repo('healthy',{issues:balance('Open issues',2,dates[1])}),
    repo('disabled',{issues:{...balance('Open issues',4,dates[1]),status:'disabled'}},{issues:{state:'disabled',label:'Disabled on repo'}}),
    repo('denied',{issues:balance('Open issues',3,dates[1])},{issues:{state:'no_access',label:'No access'}}),
    repo('failed',{issues:balance('Open issues',1,dates[1])},{issues:{state:'error',label:'Collection failed'}}),
  ]};
  const page=await openFixture(t,dashboard),card=page.locator('[data-aggregate="issues"]');
  assert.equal(await card.locator('strong').textContent(),'10');
  for(const label of ['Disabled on repo','No access','Collection failed'])assert.match(await card.textContent(),new RegExp(label+': 1 of 4 projects'));
  await card.locator('.aggregate-value').click();
  for(const label of ['Disabled on repo','No access','Collection failed'])assert.match(await page.locator('#dialog .provenance').textContent(),new RegExp(label+': 1 of 4 projects'));
  assert.equal(await page.locator('.contribution-table tbody tr').count(),4);
  await page.click('[data-contribution="disabled"]');
  assert.match(await page.locator('#dialog .provenance').textContent(),/Disabled on repo/);
});

test('bounded no-observation and collecting labels survive rows, cards and missing detail',async t=>{
  const page=await openFixture(t,{dates,repos:[repo('empty',{}, {stars:{state:'not_collected',label:'No observations yet'},views:{state:'not_collected',label:'Collection in progress'},issues:{state:'not_collected',label:'provider secret'}})]});
  for(const [key,label] of [['stars','No observations yet'],['views','Collection in progress'],['issues','Not collected yet']]){
    for(const selector of [`[data-project="empty"] [data-metric="${key}"]`,`[data-aggregate="${key}"]`])assert.equal(await page.locator(selector+' .unavailable-label').textContent(),label);
    await page.click(`[data-project="empty"] [data-metric="${key}"]`);
    assert.equal(await page.locator('#records-state').textContent(),label);
    assert.equal(await page.locator('#dialog .unavailable-label').textContent(),label);
    await page.keyboard.press('Escape');
  }
  assert.doesNotMatch(await page.locator('body').textContent(),/provider secret/);
});
