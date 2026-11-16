import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const dates=['2026-01-01','2026-01-02','2026-01-03'];
const metric=(label,kind,value,values)=>({label,kind,value,unit:label.toLowerCase(),points:dates.map((date,i)=>({date,value:values[i]})),coverage:{start:dates[0],end:dates[2],complete:false},source:'Synthetic',status:'ok'});
test('Stars toggle, all-cohort totals, placeholders, persistence and unchanged record paging',async t=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(6000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));const offsets=[];
 const dashboard={dates,repos:[
 {id:'a',owner:'fixture',name:'alpha',url:'https://github.com/fixture/alpha',metrics:{stars:metric('Stars','balance',1433,[1418,null,1433]),star_activity:metric('Stars gained','event',15,[5,null,10]),commits:metric('Commits','event',0,[0,null,0])},metricAvailability:{issues:{state:'disabled',label:'Disabled on repo'},views:{state:'no_access',label:'No access'},releases:{state:'error',label:'Collection failed'}}},
 {id:'b',owner:'fixture',name:'beta',metrics:{},metricAvailability:{commits:{state:'empty_repository',label:'No commits yet'}}}
 ]};
 await context.route('**/*',async route=>{
 const url=new URL(route.request().url());assert.equal(url.hostname,'observatory.test');
 const send=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 if(url.pathname==='/api/session')return send({csrf:'test-csrf'});
 if(url.pathname==='/api/dashboard')return send(dashboard);
 if(url.pathname==='/api/details'){
 const offset=Number(url.searchParams.get('offset'));offsets.push(offset);assert.equal(url.searchParams.get('metric'),'stars');
 return send({items:Array.from({length:offset?1:50},(_,i)=>({id:String(offset+i),title:'Star event '+(offset+i),date:dates[2]})),total:51,offset,limit:50,hasMore:!offset,kind:'events',complete:false,status:'ok',observedAt:dates[2]});
 }
 assert.ok(!url.pathname.startsWith('/api/'));
 const name=url.pathname==='/'?'index.html':url.pathname.slice(1);return route.fulfill({contentType:name.endsWith('.svg')?'image/svg+xml':name.endsWith('.png')?'image/png':name.endsWith('.ico')?'image/x-icon':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html',body:await readFile(new URL('../public/'+name,import.meta.url))});
 });
 await page.goto('http://observatory.test');await page.waitForSelector('.project-card');
 assert.equal(await page.getAttribute('[data-star-mode="total"]','aria-pressed'),'true');
 const card=page.locator('[data-aggregate="stars"]'),row=page.locator('[data-project="a"] [data-metric="stars"]');
 assert.equal(await card.locator('strong').textContent(),'1,433');assert.match(await card.locator('.chart-axis').first().textContent(),/1,433/);
 assert.match(await card.locator('.aggregate-footer').textContent(),/incomplete/i,'missing repository count explicitly disclosed');
 assert.equal(await page.locator('[data-project="b"] .spark-metric').count(),4);
 assert.equal(await page.locator('[data-project="a"] [data-metric="issues"] .spark-value').textContent(),'—');
 assert.match(await page.locator('[data-project="a"] [data-metric="issues"]').textContent(),/Disabled on repo/);
 assert.match(await page.locator('[data-project="b"] [data-metric="issues"]').textContent(),/Not collected yet/);
 assert.doesNotMatch(await page.locator('[data-project="b"]').textContent(),/Disabled on repo/);
 assert.match(await page.locator('[data-project="b"] [data-metric="commits"]').textContent(),/No commits yet/);
 assert.equal(await page.locator('[data-project="a"] [data-metric="commits"] .spark-value').textContent(),'0');
 assert.equal(await page.locator('[data-project="b"] .chart-dot,[data-project="b"] .chart-area,[data-project="b"] .chart-axis').count(),0);
 assert.equal(await page.locator('[data-slot="0"] option').count(),8);
 assert.match(await page.locator('[data-project="a"] [data-metric="views"]').textContent(),/No access/);
 const alignment=await page.evaluate(()=>['commits','stars','views','issues'].every(key=>Math.abs(document.querySelector(`[data-project="a"] [data-metric="${key}"]`).getBoundingClientRect().x-document.querySelector(`[data-project="b"] [data-metric="${key}"]`).getBoundingClientRect().x)<1));assert.equal(alignment,true);
 await page.click('[data-project="b"] [data-metric="issues"]');assert.equal(await page.locator('#records-state').textContent(),'Not collected yet');assert.equal(await page.locator('#dialog .chart-axis').count(),0);await page.keyboard.press('Escape');
 if(process.env.UI_SCREENSHOT_DIR)await page.screenshot({path:process.env.UI_SCREENSHOT_DIR+'/stars-total-placeholder-desktop.png',fullPage:true});
 await page.selectOption('[data-slot="2"]','releases');assert.match(await page.locator('[data-project="a"] [data-metric="releases"]').textContent(),/Collection failed/);
 assert.equal(await page.locator('[data-aggregate="releases"] strong').textContent(),'—');
 await page.click('[data-star-mode="gained"]');assert.equal(await row.locator('.spark-value').textContent(),'1,433');
 assert.match(await card.locator('.aggregate-footer').textContent(),/Cumulative stars gained/);assert.equal(await card.locator('.chart-axis').first().textContent(),'15');
 await page.reload();await page.waitForSelector('.project-card');assert.equal(await page.getAttribute('[data-star-mode="gained"]','aria-pressed'),'true');
 await row.click();await page.waitForSelector('#records-more:not([hidden])');await page.click('#records-more');await page.waitForFunction(()=>document.querySelectorAll('.record-table tbody tr').length===51);
 assert.deepEqual(offsets,[0,50]);assert.equal(await page.locator('#dialog .chart-axis').first().textContent(),'15');await page.click('#full-history');
 await page.click('[data-star-mode="total"]');assert.equal(await page.locator('#detail .chart-axis').first().textContent(),'1,433');
 await page.click('[data-chart-mode="daily"]');assert.equal(await page.locator('#detail .chart-axis').first().textContent(),'1,433');await page.click('#back');
 dashboard.repos[1].metrics.stars={...metric('Stars','balance',7,[null,null,7]),coverage:{start:dates[2],end:dates[2],complete:false}};
 await page.reload();await page.waitForSelector('.project-card');assert.equal(await card.locator('strong').textContent(),'1,440');assert.equal(await card.locator('.chart-axis').first().textContent(),'1,440');assert.equal(await card.locator('.chart-hit').count(),1);
 dashboard.repos[1].metrics.stars.points=[{date:dates[1],value:7}];await page.reload();await page.waitForSelector('.project-card');
 assert.match(await card.locator('.aggregate-footer').textContent(),/not comparable/i);assert.equal(await card.locator('.chart-axis').count(),0);assert.equal(await card.locator('strong').textContent(),'1,440');
 await page.click('[data-star-mode="gained"]');assert.match(await page.locator('[data-project="b"] [data-metric="stars"]').textContent(),/Not collected yet/);assert.equal(await page.locator('[data-project="b"] [data-metric="stars"] .chart-dot').count(),0);
 await page.click('#settings');assert.equal(await page.inputValue('#star-mode-setting'),'gained');await page.selectOption('#star-mode-setting','total');await page.click('#preferences-form button[type="submit"]');await page.keyboard.press('Escape');assert.equal(await page.getAttribute('[data-star-mode="total"]','aria-pressed'),'true');
 await page.setViewportSize({width:390,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 if(process.env.UI_SCREENSHOT_DIR)await page.screenshot({path:process.env.UI_SCREENSHOT_DIR+'/stars-total-placeholder-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);
});
