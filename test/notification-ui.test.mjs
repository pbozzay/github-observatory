import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const origin='http://observatory.test';
const item=n=>({id:String(n),repositoryId:'a',repository:'fixture/alpha',type:n%2?'pull_request':'issue_comment',title:'Review change '+n,url:'https://github.com/fixture/alpha/pull/'+n,actor:{login:'contributor',name:'Contributor'},occurredAt:'2026-01-01T12:00:00Z',readAt:null});
async function setup(t,{count=51,authenticated=true,status='ready'}={}){
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(6000);await page.clock.install();
 let items=Array.from({length:count},(_,i)=>item(i+1)),snapshot=count,failRead=false,failGet=false,expired=false,pendingGet=null,pendingWrite=null,transform=data=>data;
 const calls=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 const response=(url)=>{const unread=url.searchParams.get('unread')!=='false',offset=Number(url.searchParams.get('offset')),filtered=items.filter(i=>!unread||!i.readAt);return {items:filtered.slice(offset,offset+50),total:filtered.length,unreadCount:items.filter(i=>!i.readAt).length,offset,limit:50,hasMore:offset+50<filtered.length,snapshot,coverage:{complete:false,label:'Retained owned-repository events only · bounded to 300 events / 30 days; collection can be delayed.'},status,updatedAt:'2026-01-01T12:00:00Z'};};
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());assert.equal(url.hostname,'observatory.test');calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),method:request.method(),body:request.method()==='POST'?request.postDataJSON():null,csrf:request.headers()['x-csrf-token']});
  const send=(v,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(v)});
  if(url.pathname==='/api/session'){if(request.postDataJSON()?.key==='fixture-key')authenticated=true;return authenticated?send({csrf:'test-csrf'}):send({},401);}
  if(url.pathname.startsWith('/api/')&&expired)return send({},401);
  if(url.pathname==='/api/dashboard')return send({dates:['2026-01-01'],repos:[{id:'a',owner:'fixture',name:'alpha',metrics:{}}]});
  if(url.pathname==='/api/notifications'){
   const data=transform(response(url));if(pendingGet){const hold=pendingGet;pendingGet=null;await hold;}
   return failGet?send({},500):send(data);
  }
  if(url.pathname==='/api/notifications/read'||url.pathname==='/api/notifications/read-all'){
   assert.equal(request.method(),'POST');assert.equal(request.headers()['x-csrf-token'],'test-csrf');
   if(pendingWrite){const hold=pendingWrite;pendingWrite=null;await hold;}
   if(failRead)return send({},500);
   const body=request.postDataJSON();items=items.map(i=>(body.id===i.id||body.through!==undefined&&Number(i.id)<=body.through)?{...i,readAt:'2026-01-02T12:00:00Z'}:i);snapshot++;
   return send({ok:true});
  }
  assert.ok(!url.pathname.startsWith('/api/'));
  const name=url.pathname==='/'?'index.html':url.pathname.slice(1);return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.png')?'image/png':name.endsWith('.ico')?'image/x-icon':'text/html',body:await readFile(new URL('../public/'+name,import.meta.url))});
 });
 await page.goto(origin);if(authenticated)await page.waitForSelector('.project-card');else await page.waitForSelector('#unlock-form:not([hidden])');
 t.after(()=>assert.deepEqual(errors,[]));
 return {page,calls,setFailRead:v=>failRead=v,setFailGet:v=>failGet=v,setStatus:v=>status=v,setTransform:fn=>transform=fn,setExpired:v=>expired=v,add:()=>{const n=++snapshot;items.unshift(item(n));},holdGet:()=>{let release;pendingGet=new Promise(r=>release=r);return release;},holdWrite:()=>{let release;pendingWrite=new Promise(r=>release=r);return release;}};
}
test('bell waits for auth; unread list, bounded paging, local per-item and snapshot bulk reads verify through GET',async t=>{
 const h=await setup(t,{authenticated:false}),{page,calls}=h;
 assert.equal(calls.filter(c=>c.path==='/api/notifications').length,0);assert.equal(await page.locator('#notifications').isVisible(),false);
 await page.fill('#unlock-key','fixture-key');await page.click('#unlock-form button');await page.waitForSelector('#notification-badge:not([hidden])');assert.equal(await page.locator('#notification-badge').textContent(),'51');assert.match(await page.locator('#notifications').getAttribute('aria-label'),/51 unread/);
 await page.locator('#notifications').focus();await page.keyboard.press('Enter');await page.waitForSelector('.notification-item');assert.equal(await page.locator('.notification-item').count(),50);assert.match(await page.locator('#notification-coverage').textContent(),/300 events/);assert.match(await page.locator('#dialog-body').textContent(),/Read status is saved in Observatory/);
 await page.click('#notifications-more');await page.waitForFunction(()=>document.querySelectorAll('.notification-item').length===51);assert.deepEqual(calls.filter(c=>c.path==='/api/notifications').map(c=>c.query.offset),['0','0','50']);
 const release=h.holdWrite();await page.locator('[data-notification-read="1"]').click();assert.equal(await page.locator('#notification-badge').textContent(),'51','no optimistic clearing');release();await page.waitForFunction(()=>document.querySelector('#notification-badge').textContent==='50');assert.equal(await page.locator('[data-notification-read="1"]').count(),0);
 const displayedSnapshot=52;h.add();await page.click('#notifications-read-all');await page.waitForFunction(()=>document.querySelector('#notification-badge').textContent==='1');assert.equal(calls.findLast(c=>c.path==='/api/notifications/read-all').body.through,displayedSnapshot);assert.equal(await page.locator('.notification-item').count(),1,'new arrivals after the displayed snapshot remain unread');
 await page.click('#notifications-read-all');await page.waitForFunction(()=>document.querySelector('#notifications-state').textContent.includes('No unread notifications'));assert.equal(await page.locator('#notification-badge').isVisible(),false);
 await page.selectOption('#notifications-filter','all');await page.waitForSelector('.notification-item');assert.match(await page.locator('.notification-item').first().textContent(),/Read/);assert.equal(await page.locator('.notification-item a').first().getAttribute('rel'),'noopener noreferrer');
 await page.keyboard.press('Escape');assert.equal(await page.locator('#notifications').evaluate(el=>el===document.activeElement),true);
});
test('failures preserve rows/counts, unavailable never looks healthy, late dialogs and logout cannot leak inbox data',async t=>{
 const h=await setup(t,{count:2}),{page}=h;await page.click('#notifications');await page.waitForSelector('.notification-item');
 h.setFailRead(true);await page.locator('[data-notification-read="1"]').click();await page.waitForFunction(()=>document.querySelector('#notifications-state').textContent.includes('could not'));assert.equal(await page.locator('.notification-item').count(),2);assert.equal(await page.locator('#notification-badge').textContent(),'2');
 h.setFailRead(false);await page.click('#notifications-retry');await page.waitForFunction(()=>!document.querySelector('[data-notification-read="1"]').disabled);const release=h.holdWrite();await page.locator('[data-notification-read="1"]').click();await page.keyboard.press('Escape');await page.click('#settings');release();await page.waitForTimeout(100);assert.equal(await page.locator('#dialog-title').textContent(),'Settings');assert.equal(await page.locator('#dialog-message').textContent(),'');await page.keyboard.press('Escape');
 h.setFailGet(true);await page.click('#notifications');await page.waitForFunction(()=>document.querySelector('#notifications-state').textContent.includes('unavailable'));assert.match(await page.locator('#notifications').getAttribute('aria-label'),/unavailable/i);assert.equal(await page.locator('#notification-badge').textContent(),'!');
 h.setFailGet(false);await page.click('#notifications-retry');await page.waitForSelector('.notification-item');
 const releaseGet=h.holdGet();await page.click('#notifications-retry');await page.keyboard.press('Escape');await page.click('#settings');releaseGet();await page.waitForTimeout(100);assert.equal(await page.locator('#dialog-title').textContent(),'Settings');assert.equal(await page.locator('.notification-item').count(),0);await page.keyboard.press('Escape');
 await page.click('#notifications');await page.waitForSelector('.notification-item');h.setExpired(true);await page.click('#notifications-retry');await page.waitForSelector('#locked:not([hidden])');assert.equal(await page.locator('#notifications').isVisible(),false);assert.equal(await page.locator('#notification-badge').textContent(),'');assert.equal(await page.locator('#dialog-body').textContent(),'');
});
test('coverage/status empty states, safe links and phone keyboard layout',async t=>{
 const h=await setup(t,{count:0,status:'not_configured'}),{page}=h;await page.click('#notifications');await page.waitForFunction(()=>document.querySelector('#notifications-state').textContent.includes('configured'));assert.doesNotMatch(await page.locator('#notifications-state').textContent(),/No unread/);
 h.setStatus('no_access');await page.click('#notifications-retry');await page.waitForFunction(()=>document.querySelector('#notifications-state').textContent.includes('access'));
 h.setStatus('ready');await page.click('#notifications-retry');await page.waitForFunction(()=>document.querySelector('#notifications-state').textContent.includes('No unread'));
 h.add();await page.click('#notifications-retry');await page.waitForSelector('.notification-item');await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.ok(await page.locator('#dialog').evaluate(e=>e.scrollWidth<=e.clientWidth));
 await page.locator('#notifications-more').isVisible();await page.locator('#close').focus();await page.keyboard.press('Shift+Tab');assert.notEqual(await page.evaluate(()=>document.activeElement.id),'notifications');
 await page.keyboard.press('Escape');assert.equal(await page.locator('#notifications').evaluate(e=>e===document.activeElement),true);
});

test('stale pagination stays locked through a failed refresh; duplicate pages are rejected',async t=>{
 const h=await setup(t),{page}=h;await page.click('#notifications');await page.waitForSelector('.notification-item');
 h.add();await page.click('#notifications-more');await page.waitForFunction(()=>document.querySelector('#notifications-state').textContent.includes('changed while paging'));
 assert.equal(await page.locator('.notification-item').count(),50);assert.equal(await page.locator('#notifications-more').isVisible(),false);assert.equal(await page.locator('#notifications-read-all').isDisabled(),true);
 h.setFailGet(true);await page.click('#notifications-retry');await page.waitForFunction(()=>!document.querySelector('#notifications-retry').disabled);assert.match(await page.locator('#notifications-state').textContent(),/changed while paging/);assert.equal(await page.locator('#notifications-more').isVisible(),false);
 h.setFailGet(false);await page.click('#notifications-retry');await page.waitForFunction(()=>!document.querySelector('#notifications-retry').disabled);assert.doesNotMatch(await page.locator('#notifications-state').textContent(),/changed while paging/);assert.equal(await page.locator('#notifications-more').isVisible(),true);
 h.setTransform(data=>data.offset?{...data,items:[item(1),item(2)]}:data);await page.click('#notifications-more');await page.waitForFunction(()=>document.querySelector('#notifications-state').textContent.includes('changed while paging'));assert.equal(await page.locator('.notification-item').count(),50);
});
test('failed mutation readback never clears the list optimistically; cadence fetches count and malicious content stays inert',async t=>{
 const h=await setup(t,{count:1}),{page,calls}=h;
 h.setTransform(data=>({...data,items:data.items.map(i=>({...i,title:'<img src=x onerror=alert(1)>',url:'javascript:alert(1)',actor:{login:'<script>unsafe</script>'}}))}));
 await page.click('#notifications');await page.waitForSelector('.notification-item');assert.equal(await page.locator('.notification-item a,.notification-item img,.notification-item script').count(),0);assert.match(await page.locator('.notification-item h3').textContent(),/<img/);
 h.setFailGet(true);await page.locator('[data-notification-read="1"]').click();await page.waitForFunction(()=>document.querySelector('#notifications-state').textContent.includes('accepted, but inbox refresh failed'));assert.equal(await page.locator('.notification-item').count(),1);assert.equal(await page.locator('#notification-badge').textContent(),'!');
 const writes=calls.filter(c=>c.method==='POST'&&c.path.includes('notifications')).length;h.setFailGet(false);await page.click('#notifications-retry');await page.waitForFunction(()=>document.querySelector('#notifications-state').textContent.includes('No unread'));assert.equal(calls.filter(c=>c.method==='POST'&&c.path.includes('notifications')).length,writes,'verification retry is read-only');
 await page.keyboard.press('Escape');const count=calls.filter(c=>c.path==='/api/notifications').length;h.add();await page.clock.fastForward(30001);await page.waitForFunction(()=>document.querySelector('#notification-badge').textContent==='1');assert.equal(calls.filter(c=>c.path==='/api/notifications').length,count+1);
});
