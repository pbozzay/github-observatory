// Reproduce with: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome node scripts/screenshots.mjs
// Reads only public assets and synthetic fixtures; never starts the app/server.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {DEMO_ORIGIN,DEMO_TIME,installSyntheticDemo} from '../test/synthetic-demo.mjs';
const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{}),args:['--disable-background-networking','--disable-component-update','--disable-sync']});
try{
  const context=await browser.newContext({viewport:{width:1600,height:1050},deviceScaleFactor:1,locale:'en-US',timezoneId:'UTC',colorScheme:'light',reducedMotion:'reduce',serviceWorkers:'block'});
  const {blocked,calls}=await installSyntheticDemo(context);
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
  assert.ok(calls.every(c=>['/api/session','/api/dashboard','/api/details'].includes(c.path)));
  console.log('Verified: 3 synthetic screenshots; API interception and external-network blocking enabled.');
}finally{await browser.close();}
