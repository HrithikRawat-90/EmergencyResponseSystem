// End-to-end dispatch, profiles, live metrics, view switches and incident rerouting.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
require('node:fs').mkdirSync('artifacts', {recursive: true});
(async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1200}});
    const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5006';
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Expose the map only in this test to click exact road positions through the UI.
    await page.route('**/static/app.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: 'L.Map.addInitHook(function(){window.testMap=this;});\n' + await response.text()});
    });
    await page.request.post(`${base}/api/incidents/clear`);
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#ops-status-text').textContent.startsWith('Ready'));
    await page.locator('#select-vehicle').selectOption('fire');
    await page.locator('#start-landmark-select').selectOption('station');
    await page.locator('#dest-landmark-select').selectOption('clock_tower');
    await page.locator('#anim-speed-select').selectOption('2');
    const initialResponse = page.waitForResponse(r => r.url().endsWith('/api/route'));
    await page.locator('#calculate-route-btn').click();
    const initial = await (await initialResponse).json();
    await page.waitForFunction(() => !document.querySelector('#begin-dispatch-btn').disabled);
    assert.equal(await page.locator('.journey-vehicle').count(), 0);
    assert.equal(initial.unit_type, 'fire');
    await page.locator('#journey-speed-select').selectOption('10');
    await page.locator('#begin-dispatch-btn').click();
    await page.waitForFunction(() => Number(document.querySelector('#journey-panel').dataset.travelled) > 8);
    await page.locator('#journey-pause-btn').click();
    const position = await page.locator('.journey-vehicle').getAttribute('data-position');
    const travelled = await page.locator('#journey-panel').getAttribute('data-travelled');
    const currentIndex = Number(await page.locator('#journey-panel').getAttribute('data-leg-index'));
    const currentLeg = initial.journey_segments[currentIndex];
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.journey-vehicle').getAttribute('data-position'), position);
    assert.equal(await page.locator('#journey-panel').getAttribute('data-travelled'), travelled);
    await page.locator('#nav-btn-graph').click();
    await page.waitForFunction(() => !document.querySelector('#nav-btn-graph').disabled);
    assert.equal(await page.locator('#journey-panel').getAttribute('data-phase'), 'paused');
    assert.equal(await page.locator('.journey-vehicle').getAttribute('data-position'), position);

    async function place(type, leg) {
      let best = [leg.geometry[0], leg.geometry[leg.geometry.length - 1]], longest = 0;
      for (let i = 1; i < leg.geometry.length; i++) {
        const a = leg.geometry[i - 1], b = leg.geometry[i];
        const span = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
        if (span > longest) { longest = span; best = [a, b]; }
      }
      const coord = [(best[0][0] + best[1][0]) / 2, (best[0][1] + best[1][1]) / 2];
      if (!(await page.locator('#traffic-hazard-panel').isVisible())) await page.locator('#nav-btn-traffic').click();
      await page.locator(`.hazard-pill[data-type="${type}"]`).click();
      await page.locator('#place-incident-btn').click();
      const point = await page.evaluate(coord => {
        const p = window.testMap.latLngToContainerPoint(coord);
        const rect = document.querySelector('#map').getBoundingClientRect();
        return {x: rect.left + p.x, y: rect.top + p.y};
      }, coord);
      const response = page.waitForResponse(r => r.url().endsWith('/api/incidents') && r.request().method() === 'POST');
      await page.mouse.click(point.x, point.y);
      const result = await (await response).json();
      assert.equal(result.success, true);
      return result.incident;
    }
    // Congestion forces a new plan while the current vehicle position and pause survive.
    const replanResponse = page.waitForResponse(r => r.url().endsWith('/api/route'));
    await place('congestion', initial.journey_segments[Math.min(currentIndex + 3, initial.journey_segments.length - 1)]);
    const replanned = await replanResponse;
    const start = replanned.request().postDataJSON().start;
    assert.notDeepEqual(start, initial.start.original, 'replan must not restart at original origin');
    await page.waitForFunction(() => document.querySelector('#journey-panel').dataset.phase === 'paused');
    assert.equal(await page.locator('.journey-vehicle').getAttribute('data-position'), position);
    assert.equal(await page.locator('#journey-panel').getAttribute('data-travelled'), travelled);
    assert.equal(await page.locator('.journey-route').count(), 1);
    await page.screenshot({path: 'artifacts/vehicle-dispatch-preview.png'});

    // Closing the currently occupied road must stop movement, not teleport or drive through it.
    const block = await place('roadblock', currentLeg);
    assert.ok(block.edges.some(edge => edge.every((v, i) => String(v) === String(currentLeg.edge[i]))));
    await page.waitForFunction(() => document.querySelector('#journey-panel').dataset.phase === 'waiting');
    assert.equal(await page.locator('.journey-vehicle').getAttribute('data-position'), position);
    await page.locator('.hazard-chip').filter({hasText: 'ROADBLOCK'}).locator('button').click();
    await page.waitForFunction(() => document.querySelector('#journey-panel').dataset.phase === 'paused');
    await page.locator('#journey-speed-select').selectOption('60');
    await page.locator('#journey-pause-btn').click();
    await page.waitForFunction(() => document.querySelector('#journey-panel').dataset.phase === 'completed');
    assert.equal(await page.locator('#journey-progress-text').textContent(), '100%');
    assert.equal(await page.locator('#journey-remaining').textContent(), '0.00 km');
    assert.match(await page.locator('#unit-status-fire').textContent(), /Mission completed/);
    await page.locator('#clear-route-btn').click();
    assert.equal(await page.locator('.journey-vehicle').count(), 0);
    assert.equal(await page.locator('.journey-route').count(), 0);
    assert.equal(await page.locator('#journey-panel').isVisible(), false);
    // Coincident endpoints complete immediately rather than leaving an endless mission.
    await page.locator('#start-landmark-select').selectOption('station');
    await page.locator('#dest-landmark-select').selectOption('station');
    await page.locator('#calculate-route-btn').click();
    await page.waitForFunction(() => !document.querySelector('#begin-dispatch-btn').disabled);
    await page.locator('#begin-dispatch-btn').click();
    await page.waitForFunction(() => document.querySelector('#journey-panel').dataset.phase === 'completed');
    assert.equal(await page.locator('#journey-progress-text').textContent(), '100%');
    await page.locator('#clear-route-btn').click();

    // Disabling automatic replans stops the vehicle until a manual retry; clearing
    // while that retry is in flight must reject its eventual response.
    await page.locator('#start-landmark-select').selectOption('station');
    await page.locator('#dest-landmark-select').selectOption('clock_tower');
    const nextPlan = page.waitForResponse(r => r.url().endsWith('/api/route'));
    await page.locator('#calculate-route-btn').click();
    const plan = await (await nextPlan).json();
    await page.waitForFunction(() => !document.querySelector('#begin-dispatch-btn').disabled);
    await page.locator('#journey-speed-select').selectOption('10');
    await page.locator('#begin-dispatch-btn').click();
    await page.waitForFunction(() => Number(document.querySelector('#journey-panel').dataset.travelled) > 4);
    await page.locator('#journey-pause-btn').click();
    await page.locator('#tab-right-settings').click();
    await page.locator('#auto-replan-toggle').uncheck();
    await place('congestion', plan.journey_segments[Math.min(3, plan.journey_segments.length - 1)]);
    await page.waitForFunction(() => document.querySelector('#journey-panel').dataset.phase === 'waiting');
    let release, signal;
    const releasePromise = new Promise(resolve => {release = resolve;});
    const intercepted = new Promise(resolve => {signal = resolve;});
    await page.route('**/api/route', async route => {
      const response = await route.fetch();
      signal(); await releasePromise;
      await route.fulfill({response});
    });
    await page.locator('#retry-dispatch-btn').click();
    await intercepted;
    await page.locator('#clear-route-btn').click();
    release();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.journey-vehicle').count(), 0);
    assert.equal(await page.locator('#journey-panel').isVisible(), false);
    await page.request.post(`${base}/api/incidents/clear`);
    assert.deepEqual(errors, []);
    console.log('PASS: vehicle dispatch, live journey, pause, graph switching, current-position replan, current-road closure waiting, arrival, zero-distance, manual retry and clear during rerouting');
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
