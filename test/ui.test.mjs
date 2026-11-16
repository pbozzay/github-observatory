import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {aggregate,chart,csvCell,githubURL} from '../public/metrics.js';
import {DEMO_ORIGIN,DEMO_TIME,syntheticDashboard,syntheticDetails,installSyntheticDemo} from './synthetic-demo.mjs';

// Synthetic API responses are confined to this test. No collector or GitHub call.
const dates=['2025-01-01','2025-01-02','2025-01-03'];
const metric=(label,kind,values,value,extra={})=>({label,kind,unit:label.toLowerCase(),value,delta:null,points:dates.map((date,i)=>({date,value:values[i]})),coverage:{start:dates[0],end:dates[2],complete:false},status:'ok',lastSuccess:'2025-01-03T10:00:00Z',source:'GitHub REST API',...extra});
function data(){return {dates,updatedAt:'2025-01-03T10:00:00Z',collecting:false,credentialConfigured:true,repos:[
  {id:'one',owner:'test-owner',name:'alpha',visibility:'public',archived:false,language:'JavaScript',description:'A test repository',url:'https://github.com/test-owner/alpha',metrics:{commits:metric('Commits','event',[2,null,4],6),stars:metric('Stars','balance',[null,null,0],0),views:metric('Views','event',[0,0,0],0),star_activity:metric('Stars gained','event',[1,0,1],2),issues:metric('Open issues','balance',[null,null,2],2),unknown:metric('Unknown','event',[null,null,null],null)}},
  {id:'two',owner:'test-owner',name:'beta',visibility:'private',archived:true,language:null,description:'<img src=x onerror=alert(1)>',url:'javascript:alert(1)',metrics:{commits:metric('Commits','event',[1,null,3],4),stars:metric('Stars','balance',[null,null,3],3),issues:metric('Open issues','balance',[null,null,4],4)}},
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
      if(url.pathname==='/api/dashboard')return failDashboard?send({error:'private upstream error must not render'},500):send({...dashboard,repos:[...dashboard.repos].reverse()});
      if(url.pathname==='/api/details')return send({items:[],total:0,hasMore:false,offset:Number(url.searchParams.get('offset')),limit:50,kind:'observations',observedAt:null,status:'ok',complete:false});
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
    assert.ok(['index.html','app.js','style.css','metrics.js','icon.svg'].includes(name));
    return route.fulfill({contentType:name.endsWith('.svg')?'image/svg+xml':name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':'text/html',body:await readFile(new URL('../public/'+name,import.meta.url))});
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
  await t.test('four graphs including open issues, true zero, omitted unknowns, sparse series',async()=>{
    assert.equal(await page.locator('.aggregate-panel').count(),4);
    assert.equal(await page.locator('.aggregate-panel').nth(3).getAttribute('data-aggregate'),'issues');
    assert.equal(await page.locator('[data-aggregate="issues"] strong').textContent(),'6');
    assert.match(await page.locator('[data-aggregate="issues"] .aggregate-value').getAttribute('class'),/issue-danger/);
    assert.equal(await page.locator('[data-aggregate="commits"] .aggregate-value strong').textContent(),'10');
    assert.equal(await page.locator('[data-project="one"] [data-metric="stars"] .spark-value').textContent(),'0');
    assert.equal(await page.locator('[data-project="one"] [data-metric="stars"] .chart-area').count(),1);
    assert.equal(await page.locator('[data-metric="star_activity"]').count(),0);assert.equal(await page.locator('option[value="star_activity"]').count(),0);
    assert.equal(await page.locator('option').filter({hasText:'Unknown'}).count(),0);
    assert.equal(await page.locator('[data-project="two"] .badge.private').count(),1);assert.equal(await page.locator('[data-project="two"] .badge.archived').count(),1);
    await page.click('[data-aggregate-detail="commits"]');assert.match(await page.locator('#dialog-body').textContent(),/2 of 3 filtered projects/);await page.keyboard.press('Escape');assert.equal(await page.locator('#dialog').isVisible(),false);
  });
  await t.test('Settings chooses all four cards and persists without losing choices under filters',async()=>{
    await page.click('#settings');assert.equal(await page.locator('[data-card-setting]').count(),4);assert.equal(await page.inputValue('#card-metric-3'),'issues');
    await page.selectOption('#card-metric-0','views');await page.selectOption('#card-metric-2','commits');await page.click('#preferences-form button[type="submit"]');await page.keyboard.press('Escape');
    assert.equal(await page.inputValue('[data-slot="0"]'),'views');assert.equal(await page.inputValue('[data-slot="2"]'),'commits');
    await page.reload();await page.waitForSelector('.project-card');assert.equal(await page.inputValue('[data-slot="0"]'),'views');
    await page.selectOption('#scope-filter','private');assert.equal(await page.locator('[data-aggregate="views"]').count(),0);assert.equal(await page.locator('[data-aggregate="issues"]').count(),1);
    await page.selectOption('#scope-filter','all');assert.equal(await page.inputValue('[data-slot="0"]'),'views');
    await page.click('#settings');await page.selectOption('#card-metric-0','stars');await page.click('#preferences-form button[type="submit"]');assert.match(await page.locator('#preferences-message').textContent(),/different/);
    await page.selectOption('#card-metric-0','commits');await page.selectOption('#card-metric-2','views');await page.click('#preferences-form button[type="submit"]');await page.keyboard.press('Escape');
    await page.selectOption('[data-slot="0"]','issues');await page.reload();await page.waitForSelector('.project-card');assert.equal(await page.inputValue('[data-slot="0"]'),'issues');assert.equal(await page.inputValue('[data-slot="3"]'),'commits');
    await page.selectOption('[data-slot="0"]','commits');
  });
  await t.test('cumulative defaults, mode switches all charts and persists without changing counts',async()=>{
    assert.equal(await page.getAttribute('[data-chart-mode="cumulative"]','aria-pressed'),'true');
    const row=page.locator('[data-project="one"] [data-metric="stars"]');
    const initial=await row.locator('.chart-line').getAttribute('d');
    assert.match(await row.locator('.spark-caption').textContent(),/Cumulative stars gained/);
    const count=await row.locator('.spark-value').textContent();
    const height=await page.locator('.aggregate-panel').first().evaluate(e=>e.getBoundingClientRect().height);assert.ok(height>=175&&height<=215,'top cards approximately 30% shorter');
    await page.click('[data-chart-mode="daily"]');assert.match(await row.locator('.spark-caption').textContent(),/Daily stars gained/);assert.notEqual(await row.locator('.chart-line').getAttribute('d'),initial);assert.equal(await row.locator('.spark-value').textContent(),count);
    await page.reload();await page.waitForSelector('.project-card');assert.equal(await page.getAttribute('[data-chart-mode="daily"]','aria-pressed'),'true');
    await page.click('[data-project="one"] [data-metric="stars"]');await page.click('#full-history');assert.match(await page.locator('#detail .chart-explanation').first().textContent(),/Daily stars gained/);
    await page.click('[data-chart-mode="cumulative"]');assert.match(await page.locator('#detail .chart-explanation').first().textContent(),/Cumulative stars gained/);assert.match(await page.locator('#detail').textContent(),/selected range/);await page.click('#back');
    await page.reload();await page.waitForSelector('.project-card');assert.equal(await page.getAttribute('[data-chart-mode="cumulative"]','aria-pressed'),'true');
  });
  await t.test('name sorting is the default and resets after reload',async()=>{
    const names=()=>page.locator('.project-name').allTextContents();
    assert.deepEqual(await names(),['alpha','beta','gamma']);
    await page.click('#sort');assert.equal((await names())[0],'gamma');
    await page.reload();await page.waitForSelector('.project-card');
    assert.equal(await page.locator('#sort').textContent(),'Sort: name');
    assert.deepEqual(await names(),['alpha','beta','gamma']);
  });
  await t.test('issue colors and saved settings thresholds update rows and survive reload',async()=>{
    const warning=page.locator('[data-project="one"] [data-metric="issues"]');
    const danger=page.locator('[data-project="two"] [data-metric="issues"]');
    assert.match(await warning.getAttribute('class'),/issue-warning/);assert.match(await danger.getAttribute('class'),/issue-danger/);
    await page.click('#settings');assert.equal(await page.inputValue('#issue-warning'),'1');assert.equal(await page.inputValue('#issue-danger'),'3');
    await page.fill('#issue-warning','2');await page.fill('#issue-danger','5');await page.click('#preferences-form button[type="submit"]');await page.keyboard.press('Escape');
    assert.doesNotMatch(await warning.getAttribute('class'),/issue-warning|issue-danger/);assert.match(await danger.getAttribute('class'),/issue-warning/);
    await page.reload();await page.waitForSelector('.project-card');assert.match(await danger.getAttribute('class'),/issue-warning/);
    await page.click('#settings');assert.equal(await page.inputValue('#issue-danger'),'5');await page.fill('#issue-danger','1');await page.click('#preferences-form button[type="submit"]');assert.match(await page.locator('#preferences-message').textContent(),/higher/);
    await page.fill('#issue-warning','1');await page.fill('#issue-danger','3');await page.click('#preferences-form button[type="submit"]');await page.keyboard.press('Escape');
    await page.click('[data-project="two"] [data-metric="issues"]');await page.click('#full-history');assert.match(await page.locator('#detail .detail-chart-top strong').getAttribute('class'),/issue-danger/);await page.click('#back');
    await page.click('[data-project="one"] [data-metric="stars"]');await page.click('#full-history');assert.match(await page.locator('#detail').textContent(),/Cumulative stars gained/);assert.equal(await page.locator('[data-detail-metric="star_activity"]').count(),0);await page.click('#back');
  });
  await t.test('Stars details preserve graph failure and provenance separately from a healthy count',async()=>{
    const source=dashboard.repos.find(r=>r.id==='one').metrics.star_activity,original={...source};
    Object.assign(source,{status:'error',source:'Daily star history <untrusted>',coverage:{...source.coverage,complete:false}});
    await page.reload();await page.waitForSelector('.project-card');await page.click('[data-project="one"] [data-metric="stars"]');await page.click('#full-history');
    assert.match(await page.locator('#detail').textContent(),/Graph collection.*Latest graph collection failed/);
    assert.match(await page.locator('#detail').textContent(),/Graph source.*Daily star history <untrusted>/);
    assert.equal(await page.locator('#detail untrusted').count(),0);
    assert.match(await page.locator('#detail .detail-chart-top strong').textContent(),/^0 /);await page.click('#back');
    await page.click('[data-aggregate-detail="stars"]');assert.match(await page.locator('#dialog-body').textContent(),/Latest graph collection failed/);assert.match(await page.locator('#dialog-body').textContent(),/partial/);await page.keyboard.press('Escape');
    Object.assign(source,original);await page.reload();await page.waitForSelector('.project-card');
  });
  await t.test('filters, range persistence, independent archive, detail and safe metadata',async()=>{
    await page.selectOption('#scope-filter','private');assert.equal(await page.locator('.project-card').count(),1);await page.check('#archived');assert.equal(await page.locator('.project-card').count(),1);
    await page.fill('#search','beta');assert.ok(!page.url().includes('beta'));
    await page.click('[data-range="7"]');await page.waitForFunction(()=>document.querySelector('[data-range="7"]').getAttribute('aria-pressed')==='true');assert.ok(page.url().includes('range=7'));
    await page.click('[data-project="two"] [data-metric="commits"]');await page.click('#full-history');
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
    const geom=await page.locator('[data-project="one"]').evaluate(row=>{const name=row.querySelector('.project-name').getBoundingClientRect(),metrics=row.querySelector('.metric-grid').getBoundingClientRect(),badges=row.querySelector('.badges').getBoundingClientRect();return {horizontal:metrics.x>name.x,badgesBelow:badges.top>=name.bottom&&badges.x<metrics.x};});assert.deepEqual(geom,{horizontal:true,badgesBelow:true});
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

test('actionable drill-downs, accessibility, pagination and request isolation',async t=>{
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'UTC',locale:'en-US',serviceWorkers:'block'});
  const page=await context.newPage();await page.clock.install({time:new Date(DEMO_TIME)});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const dashboard=syntheticDashboard();dashboard.repos[0].metrics.commits.points[1].value=null;
  let mode='normal',pending=[];
  const harness=await installSyntheticDemo(context,{dashboard,details:async({url,send})=>{
    const data=syntheticDetails(url,dashboard);
    if(mode==='slow')return new Promise(resolve=>pending.push(async()=>{try{await send({...data,items:data.items.map(x=>({...x,title:'LATE RESPONSE MUST NOT APPEAR'}))});}catch{}resolve();}));
    if(mode==='error')return send({error:'sensitive upstream response'},500);
    if(mode==='expired')return send({error:'locked'},401);
    if(mode==='stale')return send({...data,status:'error',complete:false});
    if(mode==='empty')return send({...data,items:[],total:0,hasMore:false,complete:false,observedAt:null});
    if(mode==='changed')return send({...data,observedAt:'2026-04-30T16:02:00Z'});
    if(mode==='invalid')return send({...data,items:[],hasMore:true,total:20});
    if(mode==='unsafe')return send({...data,items:[{id:'untrusted',date:null,title:'<img src=x onerror=alert(1)>',url:'https://github.com.evil.test/not-safe',author:'<script>bad()</script>'}],total:1,hasMore:false});
    return send(data);
  }});
  const loaded=()=>page.waitForFunction(()=>document.querySelector('#records-state')&&!document.querySelector('#records-state').textContent.includes('Loading'));
  const close=async()=>{await page.keyboard.press('Escape');await page.waitForSelector('#dialog',{state:'hidden'});};
  const open=async key=>{await page.click(`[data-project="atlas"] [data-metric="${key}"]`);await loaded();};
  await page.goto(DEMO_ORIGIN);await page.waitForSelector('.project-card');
  assert.equal(await page.locator('link[rel=icon]').getAttribute('href'),'/icon.svg');
  const icon=await page.evaluate(async()=>{const response=await fetch('/icon.svg');return {type:response.headers.get('content-type'),svg:await response.text()};});
  assert.match(icon.type,/image\/svg\+xml/);assert.match(icon.svg,/viewBox="0 0 64 64"/);assert.doesNotMatch(icon.svg,/<script|<image|href=|url\(/);
  await t.test('every top count, graph and project count opens contributions; selects stay independent',async()=>{
    for(const key of ['commits','stars','views','issues']){
      for(const part of ['.aggregate-value','.large-chart','.scope-button']){
        const selector=`[data-aggregate="${key}"] ${part}`;
        await page.locator(selector).focus();await page.keyboard.press('Enter');
        assert.equal(await page.locator('#dialog').isVisible(),true);
        assert.ok(await page.locator('.contribution-table tbody tr').count()>0);
        assert.equal(await page.locator('#dialog details').getAttribute('open'),'');
        assert.equal(await page.locator('#dialog .chart-button').count(),0,'no recursive modal chart');
        await close();assert.equal(await page.locator(selector).evaluate(e=>e===document.activeElement),true);
      }
    }
    await page.selectOption('[data-slot="0"]','forks');assert.equal(await page.locator('#dialog').isVisible(),false);
    for(const key of ['forks','merged_prs','releases','clones']){
      await page.selectOption('[data-slot="0"]',key);await page.click(`[data-aggregate="${key}"] .large-chart`);
      assert.equal(await page.locator('.contribution-table .metric-action').count(),4);await close();
    }
    await page.selectOption('[data-slot="0"]','commits');
    await page.click('[data-aggregate="stars"] .aggregate-value');
    assert.match(await page.locator('.cohort-note').textContent(),/3 of 4 count contributors/);
    assert.match(await page.locator('.contribution-table').textContent(),/Count only/);
    await page.click('[data-contribution="atlas"]');await loaded();
    assert.match(await page.locator('#records-state').textContent(),/Daily observations only/);
    await page.click('#contribution-back');assert.equal(await page.locator('.contribution-table').isVisible(),true);await close();
  });
  await t.test('all repository metrics and detail graphs open real record/observation tables',async()=>{
    for(const key of ['commits','stars','views','issues','merged_prs','releases','forks','clones']){
      await open(key);
      const last=harness.calls.filter(c=>c.path==='/api/details').at(-1);
      assert.deepEqual(last.query,{repository:'atlas',metric:key,range:'30',offset:'0',limit:'50'});assert.equal(last.method,'GET');
      assert.ok(await page.locator('#dialog .metric-action').count());
      assert.equal(await page.locator('#dialog details').getAttribute('open'),'');
      assert.equal(await page.locator('#overview').isVisible(),true,'metrics leave overview behind modal');
      if(key==='commits')assert.match(await page.locator('#dialog details').textContent(),/Not observed/);
      if(key==='issues'){
        assert.match(await page.locator('#records-state').textContent(),/Current snapshot.*not filtered/);
        assert.equal(await page.locator('.record-table tbody tr').count(),5);
        assert.match(await page.locator('.record-table tbody').textContent(),/2026-03-10/,'snapshot includes issues created before range');
        assert.equal(new URL(await page.locator('#dialog .metric-action').getAttribute('href')).searchParams.get('q'),'is:issue is:open');
      }
      await close();
    }
    await page.click('[data-project="atlas"] .project-name');assert.equal(await page.locator('#dialog').isVisible(),false);
    for(const key of ['commits','stars','views','issues','merged_prs','releases','forks','clones']){
      await page.click(`[data-detail-metric="${key}"]`);await page.locator('#detail .chart-button').focus();await page.keyboard.press('Space');await loaded();
      assert.equal(await page.locator('#dialog .chart-button').count(),0);await close();assert.equal(await page.locator('#detail .chart-button').evaluate(e=>e===document.activeElement),true);
    }
    await page.click('#detail .detail-count');await loaded();await close();await page.click('#back');
  });
  await t.test('bounded load more, retry, empty and stale states never fabricate records',async()=>{
    await open('commits');assert.equal(await page.locator('.record-table tbody tr').count(),50);
    mode='error';await page.click('#records-more');await loaded();assert.match(await page.locator('#records-state').textContent(),/Existing rows are unchanged/);assert.equal(await page.locator('.record-table tbody tr').count(),50);
    mode='normal';await page.click('#records-more');await loaded();assert.equal(await page.locator('.record-table tbody tr').count(),57);assert.equal(await page.locator('#records-more').isVisible(),false);
    assert.equal(harness.calls.filter(c=>c.path==='/api/details').at(-1).query.offset,'50');await close();
    mode='error';await open('issues');assert.match(await page.locator('#records-state').textContent(),/could not be loaded/);assert.doesNotMatch(await page.locator('#dialog').textContent(),/sensitive upstream/);assert.equal(await page.locator('#dialog details tbody tr').count(),30);await close();
    mode='empty';await open('issues');assert.match(await page.locator('#records-state').textContent(),/No stored records.*does not establish/);assert.match(await page.locator('#records-state').textContent(),/Observation time unavailable/);await close();
    mode='stale';await open('issues');assert.match(await page.locator('#records-state').textContent(),/stale or incomplete.*not a complete inventory/);assert.equal(await page.locator('.record-table tbody tr').count(),5);await close();
    mode='invalid';await open('commits');assert.match(await page.locator('#records-state').textContent(),/could not be loaded/);assert.equal(await page.locator('.record-table').count(),0);await close();
    mode='normal';await open('commits');mode='changed';await page.click('#records-more');await loaded();assert.match(await page.locator('#records-state').textContent(),/inventory changed.*Close and reopen/);assert.equal(await page.locator('.record-table tbody tr').count(),50);assert.equal(await page.locator('#records-more').isVisible(),false);await close();
    mode='unsafe';await open('issues');assert.match(await page.locator('.record-table').textContent(),/<img src=x/);assert.equal(await page.locator('.record-table a,.record-table img,.record-table script').count(),0);await close();mode='normal';
  });
  await t.test('late requests cannot replace closed or switched dialogs; focus survives polling',async()=>{
    mode='slow';await page.click('[data-project="atlas"] [data-metric="issues"]');await page.waitForFunction(()=>document.querySelector('#records-state').textContent.includes('Loading'));
    await close();mode='normal';await open('stars');for(const finish of pending.splice(0))await finish();
    assert.match(await page.locator('#dialog-title').textContent(),/Stars/);assert.doesNotMatch(await page.locator('#dialog').textContent(),/LATE RESPONSE/);await close();
    mode='slow';await page.click('[data-aggregate="issues"] .aggregate-value');await page.click('[data-contribution="atlas"]');
    await page.waitForFunction(()=>document.querySelector('#records-state').textContent.includes('Loading'));
    await page.click('#contribution-back');for(const finish of pending.splice(0))await finish();
    assert.equal(await page.locator('.contribution-table').isVisible(),true);assert.doesNotMatch(await page.locator('#dialog').textContent(),/LATE RESPONSE/);await close();mode='normal';
    await open('issues');dashboard.updatedAt='2026-04-30T16:01:00Z';await page.clock.fastForward(30001);
    await page.waitForFunction(()=>document.querySelector('#freshness').textContent.includes('4:01:00'));
    assert.equal(await page.evaluate(()=>document.querySelector('#dialog').contains(document.activeElement)),true,'polling does not steal focus from the modal');
    await close();assert.equal(await page.locator('[data-project="atlas"] [data-metric="issues"]').evaluate(e=>e===document.activeElement),true);
  });
  await t.test('modal tables and focus trap fit phones; range and filter match the drill-down',async()=>{
    await page.click('[data-range="7"]');await page.waitForFunction(()=>document.querySelector('[data-range="7"]').getAttribute('aria-pressed')==='true');
    await page.fill('#search','atlas');await page.click('[data-aggregate="issues"] .large-chart');assert.equal(await page.locator('.contribution-table tbody tr').count(),1);await close();
    for(const width of [390,320]){
      await page.setViewportSize({width,height:800});
      for(const theme of ['dark','light']){
        if(await page.evaluate(()=>document.body.classList.contains('light'))!==(theme==='light'))await page.click('#theme');
        await open('issues');assert.equal(harness.calls.filter(c=>c.path==='/api/details').at(-1).query.range,'7');
        assert.ok(await page.evaluate(()=>{const d=document.querySelector('#dialog');return document.documentElement.scrollWidth<=innerWidth&&d.scrollWidth<=d.clientWidth&&d.getBoundingClientRect().right<=innerWidth;}));
        for(let i=0;i<14;i++){await page.keyboard.press('Tab');assert.ok(await page.evaluate(()=>document.querySelector('#dialog').contains(document.activeElement)));}
        await close();await page.click('[data-aggregate="stars"] .large-chart');assert.ok(await page.locator('#dialog').evaluate(d=>d.scrollWidth<=d.clientWidth));await close();
      }
    }
    await page.setViewportSize({width:1440,height:1000});await page.fill('#search','');
  });
  await t.test('locking cancels pending detail data and clears the private DOM',async()=>{
    mode='slow';await page.click('[data-project="atlas"] [data-metric="issues"]');
    await page.waitForFunction(()=>document.querySelector('#records-state').textContent.includes('Loading'));
    // A 401 on the normal polling channel locks while the record request is pending.
    await context.route('**/api/dashboard?*',route=>route.fulfill({status:401,contentType:'application/json',body:'{}'}));
    await page.clock.fastForward(30001);await page.waitForSelector('#locked');
    for(const finish of pending.splice(0))await finish();
    assert.equal(await page.locator('#dialog').isVisible(),false);assert.equal(await page.locator('#dialog-body').textContent(),'');assert.equal(await page.locator('.project-card').count(),0);
    assert.deepEqual(errors,[]);assert.deepEqual(harness.blocked,[]);
  });
});
