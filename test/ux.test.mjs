import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {request} from 'node:http';
import {chromium} from 'playwright';
import {createServer} from '../src/server.mjs';
import {chart,chartView,exportCSV} from '../public/metrics.js';

const publicDir=fileURLToPath(new URL('../public',import.meta.url));
const launch=()=>chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
const dates=['2026-01-01','2026-01-02','2026-01-03'];
const dashboard={dates,credentialConfigured:true,repos:[{id:'synthetic',owner:'example',name:'fixture',visibility:'private',metrics:Object.fromEntries(['commits','stars','views','issues'].map(key=>[key,{label:{commits:'Commits',stars:'Stars',views:'Views',issues:'Open issues'}[key],kind:'balance',unit:key,value:0,points:dates.map(date=>({date,value:0}))}]))}]};

test('actual server renders only a harmless runtime mode in both index routes',async t=>{
  for(const proxy of [false,true]){
    const server=createServer({publicDir,service:{},unlockKey:'synthetic-local-key',...(proxy?{publicOrigin:'https://observatory.example.test',proxyKey:'synthetic-proxy-key-at-least-32-characters'}:{})});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    for(const path of ['/','/index.html']){
      const response=await new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,path,headers:proxy?{Host:'observatory.example.test','X-Observatory-Proxy-Key':'synthetic-proxy-key-at-least-32-characters'}:{}},res=>{let html='';res.on('data',chunk=>html+=chunk);res.on('end',()=>resolve({status:res.statusCode,html}));});req.on('error',reject);req.end();});
      assert.equal(response.status,200);const {html}=response;
      assert.match(html,new RegExp(`data-auth-mode="${proxy?'proxy':'local'}"`));
      assert.doesNotMatch(html,/synthetic-local-key|synthetic-proxy-key/);
      assert.match(html,/<form id="unlock-form" hidden/);
      assert.match(html,/Connecting/);
    }
  }
});

test('versioned icon routes serve exact bytes with image MIME, behind the same proxy gate',async t=>{
  const proxyKey='synthetic-proxy-key-at-least-32-characters';
  const server=createServer({publicDir,service:{},unlockKey:'synthetic-key',publicOrigin:'https://observatory.example.test',proxyKey});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const call=(name,trusted)=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,path:'/'+name+'?v=0.3.1',headers:{Host:'observatory.example.test',...(trusted?{'X-Observatory-Proxy-Key':proxyKey}:{})}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end();});
  for(const [name,type] of [['icon.svg','image/svg+xml'],['icon-32.png','image/png'],['icon-180.png','image/png'],['favicon.ico','image/x-icon']]){
    assert.equal((await call(name,false)).status,403);
    const response=await call(name,true);assert.equal(response.status,200);assert.equal(response.headers['content-type'],type);
    assert.deepEqual(response.body,await readFile(new URL('../public/'+name,import.meta.url)));
  }
});

async function ui(t,mode='proxy'){
  const browser=await launch();t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.clock.install();
  const control={sessions:0,status:200,expired:false,hold:null,bodies:[],errors:[]};page.on('pageerror',e=>control.errors.push(e.message));
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());assert.equal(url.hostname,'observatory.test');
    const send=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname==='/api/session'){
      control.sessions++;control.bodies.push(route.request().postDataJSON());
      if(control.hold)await control.hold;
      return send(control.status===200?{ok:true,csrf:'synthetic-csrf'}:{error:'withheld'},control.status);
    }
    if(url.pathname.startsWith('/api/')){
      if(control.expired)return send({error:'expired'},401);
      if(url.pathname==='/api/dashboard')return send(dashboard);
      if(url.pathname==='/api/discover')return send({repositories:[]});
      throw Error('Unexpected API '+url.pathname);
    }
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    assert.ok(['index.html','app.js','metrics.js','style.css','icon.svg','icon-32.png','icon-180.png','favicon.ico'].includes(name));
    let body=await readFile(new URL('../public/'+name,import.meta.url));
    if(name==='index.html')body=body.toString().replace('data-auth-mode="local"',`data-auth-mode="${mode}"`);
    return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.png')?'image/png':name.endsWith('.ico')?'image/x-icon':'text/html',body});
  });
  return {page,control};
}

test('proxy startup is neutral even while session establishment is slow, with no unlock flash',async t=>{
  const {page,control}=await ui(t);let release;control.hold=new Promise(resolve=>release=resolve);
  await page.addInitScript(()=>{window.unlockFlashes=[];new MutationObserver(()=>{const form=document.querySelector('#unlock-form');if(form&&!form.hidden)window.unlockFlashes.push('visible');}).observe(document,{subtree:true,attributes:true,childList:true});});
  await page.goto('http://observatory.test/#unlock=must-not-send-in-proxy');
  await page.waitForFunction(()=>document.querySelector('#locked').getAttribute('aria-busy')==='true');
  await page.clock.runFor(5000);
  assert.match(await page.locator('#locked').innerText(),/Connecting/);
  assert.doesNotMatch(await page.locator('#locked').innerText(),/local|unlock/i);
  assert.equal(await page.locator('#unlock-form').isVisible(),false);assert.equal(await page.locator('#workspace').isVisible(),false);
  assert.deepEqual(control.bodies,[{}]);release();await page.waitForSelector('.project-card');
  assert.deepEqual(await page.evaluate(()=>window.unlockFlashes),[]);assert.deepEqual(control.errors,[]);
});

test('proxy failure and expiry require explicit retry, never a local key or an automatic loop',async t=>{
  const {page,control}=await ui(t);control.status=503;await page.goto('http://observatory.test/');
  await page.waitForSelector('#session-retry');assert.match(await page.locator('#locked').innerText(),/connect/i);
  assert.doesNotMatch(await page.locator('#locked').innerText(),/local|unlock/i);assert.equal(await page.locator('#unlock-form').isVisible(),false);
  await page.clock.runFor(65000);assert.equal(control.sessions,1);
  for(const status of [401,403]){
    control.status=status;await page.click('#session-retry');await page.waitForSelector('#session-retry');
    assert.equal(await page.locator('#unlock-form').isVisible(),false);assert.doesNotMatch(await page.locator('#locked').innerText(),/local|unlock/i);
  }
  const attempts=control.sessions;
  control.status=200;await page.click('#session-retry');await page.waitForSelector('.project-card');
  await page.click('#settings');await page.fill('#repository','private/draft');
  control.expired=true;await page.click('#discover');await page.waitForSelector('#session-retry');
  assert.equal(await page.locator('#workspace').isVisible(),false);assert.equal(await page.locator('#settings').isVisible(),false);assert.equal(await page.locator('#dialog').isVisible(),false);
  for(const selector of ['#cards','#aggregate','#dialog-body','#dialog-title','#dialog-message'])assert.equal(await page.locator(selector).textContent(),'');
  assert.match(await page.locator('#locked').innerText(),/expired/i);assert.equal(await page.locator('#unlock-form').isVisible(),false);
  await page.clock.runFor(65000);assert.equal(control.sessions,attempts+1);
  control.expired=false;await page.click('#session-retry');await page.waitForSelector('.project-card');assert.equal(control.sessions,attempts+2);assert.deepEqual(control.errors,[]);
});

test('local mode shows a key only when needed, clears it, supports retry and existing sessions',async t=>{
  const {page,control}=await ui(t,'local');control.status=503;await page.goto('http://observatory.test/');
  await page.waitForSelector('#session-retry');assert.equal(await page.locator('#unlock-form').isVisible(),false);
  control.status=401;await page.click('#session-retry');await page.waitForSelector('#unlock-key');
  assert.match(await page.locator('#locked').innerText(),/local unlock key/i);
  await page.fill('#unlock-key','wrong-synthetic-key');await page.click('#unlock-form button');await page.waitForFunction(()=>document.querySelector('#unlock-message').textContent.includes('Check'));
  assert.equal(await page.inputValue('#unlock-key'),'');control.status=200;
  await page.fill('#unlock-key','synthetic-key');await page.click('#unlock-form button');await page.waitForSelector('.project-card');
  assert.deepEqual(control.bodies.at(-1),{key:'synthetic-key'});assert.equal(await page.inputValue('#unlock-key'),'');
  await page.reload();await page.waitForSelector('.project-card');assert.deepEqual(control.bodies.at(-1),{});
  assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage)),[]);assert.deepEqual(control.errors,[]);
});

test('empty and zero charts have a full-width zero reference without invented observations',()=>{
  for(const values of [[],[null,null,null],[null,null,0],[0,null,0],[0,0,0]])for(const options of [{small:true},{compact:true},{width:600},{small:true,kind:'event'}]){
    const points=values.map((value,i)=>({date:dates[i],value})),before=JSON.stringify(points),svg=chart(points,options);
    assert.match(svg,/class="chart-baseline chart-zero-reference"/);assert.doesNotMatch(svg,/NaN|Infinity/);
    const small=options.small,w=small?180:options.width||390,h=small?38:options.compact?100:180;
    assert.ok(svg.includes(`x1="${small?4:42}" y1="${h-(small?4:options.compact?20:26)}" x2="${w-8}"`));
    assert.equal((svg.match(/class="chart-hit"/g)||[]).length,small?0:values.filter(v=>v===0).length);
    assert.equal(JSON.stringify(points),before);
    if(!values.some(v=>v===0))assert.doesNotMatch(svg,/chart-dot|class="chart-line"|class="chart-area"|<title>.*: 0/);
  }
  for(const kind of ['event','balance']){
    const points=[0,null,2].map((value,i)=>({date:dates[i],value}));
    assert.doesNotMatch(chart(points,{kind}),/chart-zero-reference/);
    assert.equal((chart(points,{kind}).match(new RegExp(kind==='event'?'class="chart-line"':'class="chart-dot"','g'))||[]).length,2);
  }
  const metric={kind:'event',value:null,points:dates.map(date=>({date,value:null}))};
  assert.deepEqual(chartView(metric,dates).points,metric.points);
  assert.equal(exportCSV([{owner:'example',name:'empty',metrics:{commits:metric}}],'30').split('\r\n').length,1);
});

test('repository rows repeat metric labels by default and persist the optional setting on phones',async t=>{
  const {page}=await ui(t);await page.goto('http://observatory.test/');await page.waitForSelector('.project-card');
  const labels=page.locator('#cards .spark-label');assert.equal(await labels.count(),4);
  for(const label of await labels.all())assert.equal(await label.isVisible(),true);
  assert.equal(await page.locator('#cards [data-unwatch]').count(),0);
  const status=page.locator('.project-name-row .visibility-icon');
  assert.equal(await status.getAttribute('aria-label'),'Private repository');assert.equal(await status.getAttribute('title'),'Private repository');
  assert.equal(await status.locator('.eye-slash').count(),1);assert.equal(await page.locator('#cards .badge.private').count(),0);
  await page.click('#settings');assert.equal(await page.isChecked('#show-graph-labels'),true);assert.equal(await page.locator('#watched-repositories [data-unwatch]').count(),1);
  await page.uncheck('#show-graph-labels');await page.click('#preferences-form button[type=submit]');await page.keyboard.press('Escape');
  for(const label of await labels.all())assert.equal(await label.isVisible(),false);
  assert.match(await page.locator('.spark-metric').first().getAttribute('aria-label'),/Commits/);
  await page.reload();await page.waitForSelector('.project-card');assert.equal(await labels.first().isVisible(),false);
  await page.setViewportSize({width:390,height:900});assert.equal(await labels.first().isVisible(),false);
  assert.equal(await page.locator('.metric-select').count(),4);
  await page.click('#settings');assert.equal(await page.isChecked('#show-graph-labels'),false);await page.check('#show-graph-labels');await page.click('#preferences-form button[type=submit]');await page.keyboard.press('Escape');
  for(const label of await labels.all())assert.equal(await label.isVisible(),true);
  await page.reload();await page.waitForSelector('.project-card');for(const label of await labels.all())assert.equal(await label.isVisible(),true);
  await page.click('.project-name');assert.equal(await page.locator('#pause').isVisible(),true);assert.equal(await page.locator('#detail .visibility-icon').getAttribute('aria-label'),'Private repository');assert.equal(await page.locator('#detail [data-detail-metric]').count(),4);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
});

test('native aggregate select keeps its arrow close for desktop, phone and long labels',async t=>{
  const {page}=await ui(t);await page.goto('http://observatory.test/');await page.waitForSelector('.project-card');
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:900});
    for(const key of ['stars','issues','commits']){
      await page.selectOption('[data-slot="0"]',key);
      const geometry=await page.locator('[data-slot="0"]').evaluate(select=>{
        const picker=select.closest('.metric-picker'),label=picker?.querySelector('.metric-selected-label');if(!picker||!label)return null;
        const range=document.createRange();range.selectNodeContents(label);
        return {text:range.getBoundingClientRect().width,width:select.getBoundingClientRect().width,tag:select.tagName,overflow:document.documentElement.scrollWidth>innerWidth};
      });
      assert.ok(geometry,'native select needs a selected-label sizing wrapper');assert.equal(geometry.tag,'SELECT');assert.ok(geometry.width-geometry.text>=18&&geometry.width-geometry.text<=23,JSON.stringify(geometry));assert.equal(geometry.overflow,false);
    }
    await page.locator('[data-slot="0"]').evaluate(select=>{const label='An exceptionally long observed metric name';select.selectedOptions[0].textContent=label;select.closest('.metric-picker').querySelector('.metric-selected-label').textContent=label;});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const bounds=await page.locator('.aggregate-header').first().evaluate(header=>{const select=header.querySelector('select').getBoundingClientRect(),button=header.querySelector('button').getBoundingClientRect();return {right:select.right,left:button.left};});assert.ok(bounds.right<=bounds.left);
  }
  await page.locator('[data-slot="0"]').focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  assert.equal(await page.locator('#dialog').isVisible(),false);
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.slot),'0');
});
