import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createObservatory} from '../src/data.mjs';
import {createServer} from '../src/server.mjs';

test('real collector → SQLite → HTTP → browser preserves rich activity and unwatch history',async()=>{
 const now='2026-06-20T12:00:00Z',date='2026-06-19T03:04:05Z';let upstream=0;
 const service=await createObservatory({dbPath:':memory:',now:()=>new Date(now),fetchImpl:async input=>{
  upstream++;const url=new URL(input);assert.equal(url.origin,'https://api.github.com');const endpoint=url.pathname.split('/').slice(4).join('/');
  if(!endpoint)return Response.json({id:101,name:'sample',owner:{login:'example'},private:false,archived:false,default_branch:'main',stargazers_count:60,forks_count:1});
  if(endpoint==='commits')return Response.json([{sha:'abcdef123456',commit:{message:'Repair connection retry ordering\n\nPreserve queued work when reconnecting.',author:{name:'Demo Author'},committer:{date}},author:{login:'demo-author'}}]);
  if(endpoint==='events')return Response.json(Array.from({length:60},(_,i)=>({id:String(i+1),type:'WatchEvent',created_at:date,actor:{login:'demo-reader-'+i},repo:{id:101},payload:{action:'started'}})));
  if(endpoint==='traffic/views')return Response.json({views:[]});if(endpoint==='traffic/clones')return Response.json({clones:[]});
  assert.ok(['issues','pulls','releases','stargazers/history'].includes(endpoint));return Response.json([]);
 }});
 let server,browser;
 try{
  await service.addWatch({repository:'example/sample',access:'public'});await service.sync();const collectedCalls=upstream;
  server=createServer({service,publicDir:fileURLToPath(new URL('../public/',import.meta.url)),unlockKey:'synthetic-integration-key'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  const context=await browser.newContext(),page=await context.newPage(),errors=[];page.on('pageerror',err=>errors.push(err.message));
  await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  await page.goto(base+'/#unlock=synthetic-integration-key');await page.locator('[data-project="101"]').waitFor();
  assert.match(await page.locator('#sort').textContent(),/recent activity/);
  await page.click('[data-project="101"] [data-metric="commits"]');await page.locator('.record-table tbody tr').waitFor();
  assert.match(await page.locator('.record-table').textContent(),/Repair connection retry ordering/);assert.match(await page.locator('.record-table').textContent(),/Demo Author/);assert.match(await page.locator('.record-table').textContent(),/Preserve queued work/);await page.keyboard.press('Escape');
  await page.click('[data-project="101"] [data-metric="stars"]');await page.locator('.record-table tbody tr').first().waitFor();assert.match(await page.locator('.record-table').textContent(),/demo-reader/);assert.match(await page.locator('#records-state').textContent(),/not.*complete|partial/i);await page.keyboard.press('Escape');
  await page.click('[data-page="activity"]');await page.waitForFunction(()=>document.querySelectorAll('#events article').length===50);await page.click('#events-more');await page.waitForFunction(()=>document.querySelectorAll('#events article').length===61);
  assert.match(await page.locator('#events').textContent(),/Repair connection retry ordering/);assert.match(await page.locator('#events-state').textContent(),/61 of 61/);assert.equal(upstream,collectedCalls,'UI reads must not trigger upstream collection');
  await page.click('[data-page="overview"]');await page.click('#repository-settings');assert.equal(await page.evaluate(()=>document.activeElement.id),'repository-graphs');
  const closeBox=await page.locator('#close').boundingBox(),dialogBox=await page.locator('#dialog').boundingBox();assert.ok(closeBox.y>=dialogBox.y&&closeBox.y+closeBox.height<=dialogBox.y+dialogBox.height,'Settings Close must remain onscreen after section jump');
  await page.keyboard.press('Escape');
  await page.click('#settings');await page.click('[data-watched="101"] [data-unwatch="101"]');await page.click('#confirm-pause');await page.waitForFunction(()=>!document.querySelector('[data-project="101"]'));assert.equal(service.activity().total,0);
  await page.click('#add');await page.fill('#repository','example/sample');await page.click('#watch-form button');await page.locator('[data-project="101"]').waitFor();assert.equal(service.activity().total,61);await page.keyboard.press('Escape');
  await page.click('[data-page="collection"]');assert.equal(await page.locator('#page-title').textContent(),'Logs');assert.deepEqual(errors,[]);
  await context.close();
 }finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await service.close();}
});
