// Check actual marker animation between polls, not only changing server statistics.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  let releasePoll = () => {};
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1100}});
    const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5013';
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.request.post(`${base}/api/traffic/control`, {data: {action: 'reset'}});
    await page.request.post(`${base}/api/fleet/control`, {data: {action: 'reset'}});
    await page.request.post(`${base}/api/incidents/clear`);
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('.fleet-unit').length === 4);
    await page.locator('#select-vehicle').selectOption('fire');
    await page.locator('#dest-landmark-select').selectOption('station');
    await page.locator('#fleet-queue-btn').click();
    await page.locator('#fleet-speed').selectOption('10');
    await page.locator('#fleet-start-btn').click();
    const marker = page.locator('.fleet-vehicle[data-unit-id="fire-1"]');
    await page.waitForFunction(() => document.querySelector('.fleet-vehicle[data-unit-id="fire-1"]')?.dataset.animating === 'true');
    let hold = true, signal;
    const blocked = new Promise(resolve => {signal = resolve;});
    const released = new Promise(resolve => {releasePoll = resolve;});
    await page.route('**/api/simulation', async route => {
      if (!hold) return route.continue();
      const response = await route.fetch(); signal(); await released;
      await route.fulfill({response});
    });
    const positions = [], transforms = [];
    for (let i = 0; i < 9; i++) {
      positions.push(await marker.getAttribute('data-position'));
      transforms.push(await marker.evaluate(el => el.style.transform));
      await page.waitForTimeout(55);
    }
    assert.ok(new Set(positions).size >= 5, 'vehicle coordinates must animate between network snapshots');
    assert.ok(new Set(transforms).size >= 3, 'the visible map marker must move, not only its statistics');
    await blocked;
    await page.locator('#fleet-pause-btn').click();
    await page.waitForFunction(() => document.querySelector('#fleet-panel').dataset.running === 'false');
    const paused = await marker.getAttribute('data-position');
    assert.equal(await marker.getAttribute('data-animating'), 'false');
    hold = false; releasePoll();
    await page.waitForTimeout(300);
    assert.equal(await marker.getAttribute('data-position'), paused, 'late pre-pause snapshots must not restart animation');
    await page.locator('#fleet-start-btn').click();
    await page.waitForFunction(() => document.querySelector('.fleet-vehicle[data-unit-id="fire-1"]')?.dataset.animating === 'true');
    await page.locator('#nav-btn-graph').click();
    await page.waitForFunction(() => !document.querySelector('#nav-btn-graph').disabled);
    await page.waitForFunction(() => document.querySelector('.fleet-vehicle[data-unit-id="fire-1"]')?.dataset.animating === 'true');
    await page.locator('.fleet-unit[data-unit-id="fire-1"] button[data-action="pause"]').click();
    await page.waitForFunction(() => document.querySelector('.fleet-vehicle[data-unit-id="fire-1"]')?.dataset.phase === 'paused');
    const unitPaused = await marker.getAttribute('data-position');
    await page.waitForTimeout(250);
    assert.equal(await marker.getAttribute('data-position'), unitPaused);
    await page.locator('.fleet-unit[data-unit-id="fire-1"] button[data-action="resume"]').click();
    await page.locator('#fleet-speed').selectOption('60');
    await page.waitForFunction(() => document.querySelector('.fleet-unit[data-unit-id="fire-1"]')?.dataset.phase === 'idle');
    await page.waitForFunction(() => document.querySelector('.fleet-vehicle[data-unit-id="fire-1"]')?.dataset.animating === 'false');
    const snapshot = await (await page.request.get(`${base}/api/simulation`)).json();
    const destination = snapshot.fleet.units.find(unit => unit.id === 'fire-1').position;
    const displayed = JSON.parse(await marker.getAttribute('data-position'));
    const error = await page.evaluate(({displayed, destination}) => L.latLng(displayed).distanceTo(destination), {displayed, destination});
    assert.ok(error < 0.1, 'animation must finish at the authoritative destination');
    await page.locator('#fleet-reset-btn').click();
    await page.locator('#fleet-start-btn').click();
    assert.match(await page.locator('#ops-toast').textContent(), /Queue an emergency destination first/);
    assert.equal(await page.locator('#fleet-panel').getAttribute('data-running'), 'false');
    let replaceWorld = true;
    await page.route('**/api/simulation', async route => {
      if (!replaceWorld) return route.continue();
      replaceWorld = false;
      const response = await route.fetch();
      const data = await response.json();
      data.fleet.instance_id = 'replacement-server';
      data.fleet.sequence = 1;
      await route.fulfill({response, json: data});
    });
    await page.waitForFunction(() => document.querySelector('#fleet-panel').dataset.instanceId === 'replacement-server');
    await page.waitForTimeout(850);
    assert.equal(await page.locator('#fleet-panel').getAttribute('data-instance-id'), 'replacement-server', 'old-instance replies cannot restore the obsolete world');
    assert.deepEqual(errors, []);
    console.log('PASS: visible frame-by-frame fleet motion, pause/stale reply, graph mode, independent resume, arrival, empty queue and server restart recovery');
  } finally {releasePoll(); await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
