import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {aggregate,chart,csvCell,githubURL} from '../public/metrics.js';

// Synthetic API responses are confined to this test. No collector or GitHub call.
const dates=['2025-01-01','2025-01-02','2025-01-03'];
const metric=(label,kind,values,value,extra={})=>({label,kind,unit:label.toLowerCase(),value,delta:null,points:dates.map((date,i)=>({date,value:values[i]})),coverage:{start:dates[0],end:dates[2],complete:false},status:'ok',lastSuccess:'2025-01-03T10:00:00Z',source:'GitHub REST API',...extra});
function data(){return {dates,updatedAt:'2025-01-03T10:00:00Z',collecting:false,credentialConfigured:true,repos:[
  {id:'one',owner:'test-owner',name:'alpha',visibility:'public',archived:false,language:'JavaScript',description:'A test repository',url:'https://github.com/test-owner/alpha',metrics:{commits:metric('Commits','event',[2,null,4],6),stars:metric('Stars','balance',[null,null,0],0),views:metric('Views','event',[0,0,0],0),unknown:metric('Unknown','event',[null,null,null],null)}},
  {id:'two',owner:'test-owner',name:'beta',visibility:'private',archived:true,language:null,description:'<img src=x onerror=alert(1)>',url:'javascript:alert(1)',metrics:{commits:metric('Commits','event',[1,null,3],4),stars:metric('Stars','balance',[null,null,3],3)}},
  {id:'three',owner:'test-owner',name:'gamma',visibility:'public',archived:true,language:'Python',description:'Different event coverage',url:'https://github.com/test-owner/gamma',metrics:{commits:metric('Commits','event',[null,90,80],170)}}
]};}

test('metric invariants: compatible cohorts, null gaps, one point, links, CSV',()=>{
  const d=data(),m=aggregate(d.repos,'commits',dates);
  assert.equal(m.value,10);assert.deepEqual(m.points.map(p=>p.value),[3,null,7]);assert.equal(m.contributors.length,2);
  assert.equal(aggregate(d.repos,'stars',dates).value,3);
  assert.equal(aggregate(d.repos,'unknown',dates),null);
  const svg=chart(d.repos[0].metrics.stars.points);assert.match(svg,/chart-dot/);assert.doesNotMatch(svg,/class="chart-line"/);
  const gaps=chart(d.repos[0].metrics.commits.points);assert.equal((gaps.match(/class="chart-dot"/g)||[]).length,2);assert.doesNotMatch(gaps,/class="chart-line"/);
  assert.equal(githubURL('https://github.com.evil.test/x'),null);assert.equal(githubURL('https://user:pass@github.com/x'),null);assert.equal(githubURL('javascript:alert(1)'),null);
  assert.equal(csvCell('=SUM(A1)'), '"\'=SUM(A1)"');assert.equal(csvCell('\t+cmd'), '"\'\t+cmd"');assert.equal(csvCell('a"b'), '"a""b"');assert.equal(csvCell(0),'"0"');
});

test('frontend contract and responsive interactions',async t=>{
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();await page.clock.install();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  let authenticated=false,failDashboard=false,expired=false,dashboard=data();const calls=[];
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    assert.equal(url.hostname,'observatory.test','No external requests permitted');
    if(url.pathname.startsWith('/api/')){
      const body=request.method()==='POST'?request.postDataJSON():null;calls.push({path:url.pathname,query:url.search,method:request.method(),body,headers:request.headers()});
      const send=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
      if(url.pathname==='/api/session'){
        if(body?.key==='test-only-key')authenticated=true;
        return authenticated?send({ok:true,csrf:'test-csrf'}):send({error:'locked'},401);
      }
      if(!authenticated||expired)return send({error:'locked'},401);
      if(request.method()==='POST')assert.equal(request.headers()['x-csrf-token'],'test-csrf');
      if(url.pathname==='/api/dashboard')return failDashboard?send({error:'private upstream error must not render'},500):send(dashboard);
      if(url.pathname==='/api/discover')return send({repositories:[{id:'owned',owner:'test-owner',name:'owned-repository',visibility:'private',archived:false,watched:calls.some(c=>c.path==='/api/watches'&&c.body?.access==='token')}]});
      if(url.pathname==='/api/watches'){
        const full=body.repository.replace('https://github.com/',''),[owner,name]=full.split('/');
        const repository={id:name,owner,name,visibility:body.access==='token'?'private':'public',archived:false,language:null,description:null,url:'https://github.com/'+full,metrics:{}};
        dashboard.repos.push(repository);return send({repository});
      }
      if(url.pathname.endsWith('/pause')){for(const m of Object.values(dashboard.repos.find(r=>r.id==='one').metrics))m.status='paused';return send({ok:true});}
      if(url.pathname==='/api/sync')return send({started:true},202);
      if(url.pathname==='/api/events')return send({events:[{id:'event',repository:'test-owner/alpha',type:'commit',date:dates[2],title:'<script>bad()</script>',url:'https://evil.test/'}]});
      if(url.pathname==='/api/status')return send({collecting:false,credentialConfigured:true,lastAttempt:null,lastSuccess:null,runs:[{repository:'test-owner/alpha',metric:'commits',status:'error',lastAttempt:dates[2],lastSuccess:dates[0],message:'Collection failed'}]});
      throw Error('Unexpected API route '+url.pathname);
    }
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    assert.ok(['index.html','app.js','style.css','metrics.js'].includes(name));
    return route.fulfill({contentType:name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':'text/html',body:await readFile(new URL('../public/'+name,import.meta.url))});
  });
  await t.test('locked shell, manual unlock and no secret persistence',async()=>{
    await page.goto('http://observatory.test/?search=private-name');
    await page.waitForSelector('#unlock-message:not(:empty)');
    assert.equal(await page.locator('#workspace').isVisible(),false);
    assert.equal(await page.locator('.project-card').count(),0);
    assert.ok(!page.url().includes('private-name'));
    await page.fill('#unlock-key','test-only-key');await page.click('#unlock-form button');
    await page.waitForSelector('.project-card');assert.equal(await page.inputValue('#unlock-key'),'');
    assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage)),[]);
  });
  await t.test('three graphs, true zero, omitted unknowns, sparse series',async()=>{
    assert.equal(await page.locator('.aggregate-panel').count(),3);
    assert.equal(await page.locator('[data-aggregate="commits"] .aggregate-value strong').textContent(),'10');
    assert.equal(await page.locator('[data-project="one"] [data-metric="stars"] .spark-value').textContent(),'0');
    assert.equal(await page.locator('[data-project="one"] [data-metric="stars"] path').count(),0);
    assert.equal(await page.locator('[data-project="one"] [data-metric="stars"] circle.chart-dot').count(),1);
    assert.equal(await page.locator('option').filter({hasText:'Unknown'}).count(),0);
    assert.equal(await page.locator('[data-project="two"] .badge.private').count(),1);assert.equal(await page.locator('[data-project="two"] .badge.archived').count(),1);
    await page.click('[data-aggregate-detail="commits"]');assert.match(await page.locator('#dialog-body').textContent(),/2 of 3 filtered projects/);await page.keyboard.press('Escape');assert.equal(await page.locator('#dialog').isVisible(),false);
  });
  await t.test('filters, range persistence, independent archive, detail and safe metadata',async()=>{
    await page.selectOption('#scope-filter','private');assert.equal(await page.locator('.project-card').count(),1);await page.check('#archived');assert.equal(await page.locator('.project-card').count(),1);
    await page.fill('#search','beta');assert.ok(!page.url().includes('beta'));
    await page.click('[data-range="7"]');await page.waitForFunction(()=>document.querySelector('[data-range="7"]').getAttribute('aria-pressed')==='true');assert.ok(page.url().includes('range=7'));
    await page.click('[data-project="two"] [data-metric="commits"]');
    assert.match(await page.locator('#detail').textContent(),/<img src=x onerror=alert\(1\)>/);assert.equal(await page.locator('#detail img').count(),0);assert.equal(await page.locator('#detail a').count(),0);
    await page.click('#detail summary');assert.match(await page.locator('#detail table').textContent(),/Not observed/);assert.match(await page.locator('#detail').textContent(),/GitHub REST API/);
    await page.click('#back');await page.fill('#search','');await page.uncheck('#archived');await page.selectOption('#scope-filter','all');
  });
  await t.test('configurable graphs survive refresh and failed refresh retains data',async()=>{
    await page.selectOption('[data-slot="0"]','views');
    failDashboard=true;await page.click('#sync');await page.waitForSelector('#error:not([hidden])');assert.equal(await page.locator('.project-card').count(),3);assert.doesNotMatch(await page.locator('#error').textContent(),/private upstream/);
    failDashboard=false;await page.click('#sync');await page.waitForSelector('#error[hidden]',{state:'attached'});assert.equal(await page.inputValue('[data-slot="0"]'),'views');
  });
  await t.test('failed range request never relabels old observations; polling uses dashboard only',async()=>{
    failDashboard=true;await page.click('[data-range="90"]');await page.waitForSelector('#error:not([hidden])');
    assert.ok(page.url().includes('range=7'));await page.fill('#search','alpha');assert.match(await page.locator('#scope-summary').textContent(),/last 7 days/);await page.fill('#search','');
    failDashboard=false;const before=calls.length;await page.clock.fastForward(30001);await page.waitForSelector('#error[hidden]',{state:'attached'});
    assert.ok(calls.slice(before).some(c=>c.path==='/api/dashboard'));assert.ok(calls.slice(before).every(c=>c.method==='GET'));
  });
  await t.test('CSV export follows the current filtered scope',async()=>{
    await page.selectOption('#scope-filter','private');
    const downloaded=page.waitForEvent('download');await page.click('#export');const download=await downloaded;
    assert.equal(download.suggestedFilename(),'github-observatory.csv');const stream=await download.createReadStream();let csv='';for await(const chunk of stream)csv+=chunk;
    assert.match(csv,/test-owner\/beta/);assert.doesNotMatch(csv,/test-owner\/alpha/);assert.match(csv,/coverage_complete/);
    await page.selectOption('#scope-filter','all');
  });
  await t.test('connections explicit token add and public add, modal keyboard, pause',async()=>{
    await page.click('#settings');await page.click('#discover');await page.waitForSelector('[data-add-owned]');await page.click('[data-add-owned]');await page.waitForFunction(()=>document.querySelector('[data-add-owned]')?.textContent==='Watching');
    assert.ok(calls.some(c=>c.path==='/api/watches'&&c.body.access==='token'&&c.body.repository==='test-owner/owned-repository'));
    await page.fill('#repository','https://github.com/test-owner/public-repository');await page.click('#watch-form button');await page.waitForFunction(()=>document.querySelector('#dialog-message').textContent==='Public watch added.');
    assert.ok(calls.some(c=>c.path==='/api/watches'&&c.body.access==='public'));
    await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'settings');
    await page.click('[data-project="one"] .project-name');await page.click('#pause');await page.click('#confirm-pause');await page.waitForSelector('#dialog',{state:'hidden'});assert.ok(calls.some(c=>c.path==='/api/watches/one/pause'));await page.click('#back');
  });
  await t.test('activity and collection retrieve persisted endpoints safely',async()=>{
    await page.click('[data-page="activity"]');await page.waitForSelector('.event');assert.match(await page.locator('#events').textContent(),/<script>bad\(\)<\/script>/);assert.equal(await page.locator('#events a').count(),0);
    await page.click('[data-page="collection"]');await page.waitForSelector('#collection-content .event');assert.match(await page.locator('#collection-content').textContent(),/Collection failed/);await page.click('[data-page="overview"]');
  });
  await t.test('desktop, breakpoint and phone geometry, light/dark, accessible navigation',async()=>{
    for(const key of ['forks','merged_prs','issues','releases','clones','star_activity'])dashboard.repos[0].metrics[key]=metric(key,'event',[1,0,1],2);
    await page.reload();await page.waitForSelector('.project-card');
    for(const width of [1440,1024,840,700,390,320]){
      await page.setViewportSize({width,height:1000});
      for(const theme of ['dark','light']){
        if(await page.evaluate(()=>document.body.classList.contains('light')) !== (theme==='light'))await page.click('#theme');
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width}px ${theme}: no page overflow`);
        if(width<=700)assert.ok(await page.locator('#search').evaluate(e=>e.getBoundingClientRect().width>=200),'mobile search stays usable');
        await page.click('#settings');assert.ok(await page.evaluate(()=>document.querySelector('dialog').getBoundingClientRect().right<=innerWidth));await page.keyboard.press('Escape');
      }
    }
    await page.setViewportSize({width:1440,height:1000});
    const geom=await page.locator('[data-project="one"]').evaluate(row=>{const name=row.querySelector('.project-heading').getBoundingClientRect(),metrics=row.querySelector('.metric-grid').getBoundingClientRect(),badges=row.querySelector('.badges').getBoundingClientRect();return {horizontal:metrics.x>name.x,badgesRight:badges.x>metrics.x};});assert.deepEqual(geom,{horizontal:true,badgesRight:true});
    const aligned=await page.evaluate(()=>{
      const a=document.querySelector('[data-project="one"]'),b=document.querySelector('[data-project="two"]');
      const cells=[...a.querySelectorAll('.spark-metric')].map(e=>e.getBoundingClientRect());
      return {singleLine:cells.every(e=>Math.abs(e.y-cells[0].y)<1),aligned:Math.abs(a.querySelector('[data-metric="stars"]').getBoundingClientRect().x-b.querySelector('[data-metric="stars"]').getBoundingClientRect().x)<1,headers:getComputedStyle(document.querySelector('.project-column-head')).display!=='none'};
    });assert.deepEqual(aligned,{singleLine:true,aligned:true,headers:true});
    if(process.env.UI_SCREENSHOT_DIR){await page.screenshot({path:process.env.UI_SCREENSHOT_DIR+'/observatory-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:1000});await page.screenshot({path:process.env.UI_SCREENSHOT_DIR+'/observatory-mobile.png',fullPage:true});}
  });
  await t.test('empty state, fragment authentication, expiry removes private DOM',async()=>{
    dashboard={...dashboard,repos:[]};await page.reload();await page.waitForSelector('#empty-add');assert.match(await page.locator('#cards').textContent(),/start collecting real history/);
    dashboard=data();authenticated=false;await page.goto('http://observatory.test/#unlock=test-only-key');await page.waitForSelector('.project-card');assert.equal(new URL(page.url()).hash,'');assert.ok(calls.some(c=>c.path==='/api/session'&&c.body.key==='test-only-key'));
    expired=true;await page.click('#sync');await page.waitForSelector('#locked');assert.equal(await page.locator('.project-card').count(),0);assert.equal(await page.locator('#workspace').isVisible(),false);
    assert.deepEqual(errors,[]);
  });
});
