// Reproduce with: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome node scripts/screenshots.mjs
// Reads only public assets and synthetic fixtures; never starts the app/server.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {DEMO_ORIGIN,DEMO_TIME,installSyntheticDemo,syntheticDashboard} from '../test/synthetic-demo.mjs';
// Publish the current history contract, not the deliberately legacy fixture used
// by compatibility tests. These baselines are fictional, like every demo count.
const dashboard=syntheticDashboard();
for(const [index,repo] of dashboard.repos.entries())for(const [key,metric] of Object.entries(repo.metrics)){
  const balance=metric.kind==='balance',traffic=['views','clones'].includes(key);
  const baseline=balance?null:(index+1)*100;
  let total=baseline??0;
  const points=metric.points.map(p=>({...p,value:typeof p.value!=='number'?null:balance?p.value:(total+=p.value)}));
  metric.history={value:balance?metric.value:total,points,baseline,from:balance?dashboard.dates[0]:'2025-01-01',complete:!balance&&!traffic,status:balance||traffic?'limited':'complete',kind:traffic?'retained':'recorded',label:traffic?'Since tracking began':balance?'Observed balances':'Recorded history'};
}
const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{}),args:['--disable-background-networking','--disable-component-update','--disable-sync']});
try{
  const context=await browser.newContext({viewport:{width:1600,height:1050},deviceScaleFactor:1,locale:'en-US',timezoneId:'UTC',colorScheme:'light',reducedMotion:'reduce',serviceWorkers:'block'});
  const {blocked,calls}=await installSyntheticDemo(context,{dashboard});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.clock.install({time:new Date(DEMO_TIME)});
  await page.goto(DEMO_ORIGIN);await page.waitForSelector('[data-project="atlas"]');
  await page.evaluate(()=>document.fonts.ready);
  const directory=new URL('../docs/screenshots/',import.meta.url);await mkdir(directory,{recursive:true});
  const capture=async name=>{
    assert.ok(await page.locator('.synthetic-banner').isVisible(),'Synthetic disclosure must remain visible');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow');
    await page.screenshot({path:fileURLToPath(new URL(name,directory)),fullPage:name!=='issues-modal.png',animations:'disabled'});
    console.log(`docs/screenshots/${name}`);
  };
  await capture('dashboard.png');
  await page.click('[data-project="atlas"] [data-metric="issues"]');
  await page.waitForSelector('.record-table tbody tr');assert.equal(await page.locator('.record-table tbody tr').count(),5);
  assert.match(await page.locator('#records-state').textContent(),/Current snapshot/);
  await capture('issues-modal.png');
  await page.keyboard.press('Escape');await page.waitForSelector('#dialog',{state:'hidden'});
  await page.setViewportSize({width:390,height:1000});await page.fill('#search','atlas');
  await page.evaluate(()=>window.scrollTo(0,0));await capture('mobile.png');
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[],'Unexpected traffic was blocked; investigate before publication');
  assert.ok(calls.every(c=>c.path==='/api/session'?c.method==='POST':c.method==='GET'&&['/api/dashboard','/api/details','/api/notifications'].includes(c.path)),JSON.stringify(calls));
  console.log('Verified: 3 synthetic screenshots; API interception and external-network blocking enabled.');
}finally{await browser.close();}
