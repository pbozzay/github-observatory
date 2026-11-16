import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {DEMO_ORIGIN,DEMO_TIME,installSyntheticDemo,syntheticDetails,syntheticEvents} from './synthetic-demo.mjs';
test('date-only issue and commit records keep their calendar day in a western timezone',async t=>{
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});t.after(()=>browser.close());
 const context=await browser.newContext({timezoneId:'America/Denver',locale:'en-US'});
 const {blocked}=await installSyntheticDemo(context,{api:async({url,send})=>{
  if(url.pathname!=='/api/events')return false;
  const data=syntheticEvents(url);data.events[0].date='2026-04-30';data.events[1].date='2026-04-30T00:34:56Z';await send(data);return true;
 },details:({url,send})=>{const data=syntheticDetails(url);for(const item of data.items)item.date=item.date.slice(0,10);return send(data);}});
 const page=await context.newPage();await page.goto(DEMO_ORIGIN);await page.waitForSelector('[data-project="atlas"]');
 for(const [metric,date] of [['issues','2026-03-10'],['commits','2026-04-30']]){
  await page.click(`[data-project="atlas"] [data-metric="${metric}"]`);await page.waitForSelector('.record-table tbody tr');
  assert.equal(await page.locator('.record-table tbody tr').first().locator('td').first().textContent(),date);
  const timestamp=await page.evaluate(value=>new Date(value).toLocaleString(),DEMO_TIME);assert.ok((await page.locator('#records-state').textContent()).includes(timestamp),'actual observation timestamps still localize');
  await page.keyboard.press('Escape');
 }
 await page.click('[data-page="activity"]');await page.waitForFunction(()=>document.querySelector('#activity').getAttribute('aria-busy')==='false');
 assert.equal(await page.locator('#events .event time').first().textContent(),'2026-04-30');
 const occurred=await page.evaluate(()=>new Date('2026-04-30T00:34:56Z').toLocaleString());
 assert.equal(await page.locator('#events .event time').nth(1).textContent(),occurred);assert.match(occurred,/4\/29\/2026/);
 assert.deepEqual(blocked,[]);
});
