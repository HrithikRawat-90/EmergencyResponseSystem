// Delayed local mutations must not duplicate or overwrite a newer shared-world snapshot.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1100}});
    const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5010';
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.request.post(`${base}/api/traffic/control`, {data: {action: 'reset'}});
    await page.request.post(`${base}/api/fleet/control`, {data: {action: 'reset'}});
    await page.request.post(`${base}/api/incidents/clear`);
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('.fleet-unit').length === 4);
    let routeRequests = 0;
    page.on('request', request => {if (request.url().endsWith('/api/route')) routeRequests++;});
    await page.locator('#start-landmark-select').selectOption('station');
    await page.locator('#dest-landmark-select').selectOption('clock_tower');
    await page.locator('#anim-speed-select').selectOption('2');
    let release, signal;
    const held = new Promise(resolve => {release = resolve;});
    const committed = new Promise(resolve => {signal = resolve;});
    await page.route('**/api/incidents', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch(); signal(); await held;
      await route.fulfill({response});
    });
    await page.locator('.hazard-shortcut[data-hazard-type="roadblock"]').click();
    await page.locator('#map').click({position: {x: 500, y: 240}});
    await committed;
    await page.waitForFunction(() => document.querySelectorAll('.hazard-chip').length === 1);
    release(); await page.waitForTimeout(300);
    assert.equal(await page.locator('.hazard-chip').count(), 1, 'late add reply must not duplicate the polled incident');
    assert.equal(routeRequests, 0, 'incident updates must not start a route before Calculate is clicked');
    let clearRelease, clearSignal;
    const clearHeld = new Promise(resolve => {clearRelease = resolve;});
    const clearCommitted = new Promise(resolve => {clearSignal = resolve;});
    await page.route('**/api/incidents/clear', async route => {
      const response = await route.fetch(); clearSignal(); await clearHeld;
      await route.fulfill({response});
    });
    await page.locator('#nav-btn-traffic').click();
    await page.locator('#clear-all-hazards-btn').click();
    await clearCommitted;
    await page.request.post(`${base}/api/traffic/control`, {data: {action: 'start', seed: 42, interval_s: 20}});
    await page.waitForFunction(() => document.querySelectorAll('.hazard-chip').length === 3);
    clearRelease(); await page.waitForTimeout(300);
    assert.equal(await page.locator('.hazard-chip').count(), 3, 'late clear reply must not erase newer automatic traffic');
    assert.match(await page.locator('#hazards-list').textContent(), /AUTO CONGESTION/);
    await page.request.post(`${base}/api/traffic/control`, {data: {action: 'reset'}});
    await page.waitForFunction(() => document.querySelectorAll('.hazard-chip').length === 0);
    assert.equal(routeRequests, 0);
    let planRelease, planSignal, first = true;
    const planHeld = new Promise(resolve => {planRelease = resolve;});
    const planCommitted = new Promise(resolve => {planSignal = resolve;});
    await page.route('**/api/route', async route => {
      if (!first) return route.continue();
      first = false;
      const response = await route.fetch(); planSignal(); await planHeld;
      await route.fulfill({response});
    });
    await page.locator('#calculate-route-btn').click();
    await planCommitted;
    await page.request.post(`${base}/api/traffic/control`, {data: {action: 'start', seed: 42, interval_s: 20}});
    await page.waitForFunction(() => document.querySelectorAll('.hazard-chip').length === 3);
    planRelease();
    await page.waitForFunction(() => document.querySelector('#ops-status-text').textContent.startsWith('Route Active'));
    assert.ok(routeRequests >= 2, 'an obsolete route response must be replaced with a fresh plan');
    await page.request.post(`${base}/api/traffic/control`, {data: {action: 'reset'}});
    assert.deepEqual(errors, []);
    console.log('PASS: shared-world sync rejects duplicate/stale hazard replies and obsolete plans; traffic does not auto-start discovery');
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
