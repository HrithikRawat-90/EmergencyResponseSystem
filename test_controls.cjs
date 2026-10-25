// Regression: right tabs, incident CRUD, removed cards, and no advisory requests.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1100}});
    const errors = [];
    const advisoryRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.url().includes('/api/ai/')) advisoryRequests.push(request.url());
    });
    const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5002';
    await page.request.post(`${base}/api/incidents/clear`);
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#ops-status-text').textContent.startsWith('Ready'));
    assert.equal(await page.locator('.landmarks-card, #nav-btn-settings, #tactical-briefing-box').count(), 0);
    await page.locator('#tab-right-details').click();
    assert.equal(await page.locator('#tabpanel-right-details').isVisible(), true);
    assert.equal(await page.locator('#tabpanel-right-route').isVisible(), false);
    assert.equal(await page.locator('#details-start').textContent(), 'Not selected');
    await page.locator('#tab-right-settings').click();
    await page.locator('#settings-speed-select').selectOption('2');
    assert.equal(await page.locator('#anim-speed-select').inputValue(), '2');
    await page.locator('#auto-replan-toggle').uncheck();
    await page.locator('#show-search-toggle').uncheck();
    await page.locator('#tab-action-steps').click();
    await page.locator('#nav-btn-traffic').click();
    assert.equal(await page.locator('#traffic-hazard-panel').isVisible(), true);
    const mapBox = await page.locator('#map').boundingBox();
    for (const type of ['roadblock', 'accident', 'congestion']) {
      await page.locator(`.hazard-pill[data-type="${type}"]`).click();
      await page.locator('#place-incident-btn').click();
      assert.equal(await page.locator('#place-incident-btn').getAttribute('aria-pressed'), 'true');
      const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/incidents') && r.request().method() === 'POST');
      await page.mouse.click(mapBox.x + mapBox.width * 0.55, mapBox.y + mapBox.height * 0.48);
      const response = await responsePromise;
      assert.equal(response.status(), 200);
      const incident = await response.json();
      assert.equal(incident.success, true);
      assert.equal(incident.incident.type, type);
      await page.waitForFunction(() => document.querySelectorAll('.hazard-chip').length > 0);
    }
    assert.equal(await page.locator('.hazard-chip').count(), 3);
    assert.equal(await page.locator('.clean-circle-marker').count(), 0, 'placing incidents must not select waypoints');
    await page.screenshot({path: 'artifacts/incident-controls-preview.png'});
    await page.locator('.hazard-chip button').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.hazard-chip').length === 2);
    await page.locator('#clear-all-hazards-btn').click();
    await page.waitForFunction(() => document.querySelectorAll('.hazard-chip').length === 0);
    await page.locator('#tab-right-route').click();
    await page.locator('#start-landmark-select').selectOption('station');
    await page.locator('#dest-landmark-select').selectOption('clock_tower');
    await page.locator('#calculate-route-btn').click();
    await page.waitForFunction(() => document.querySelector('#ops-status-text').textContent.includes('Exploring'));
    await page.locator('#tab-right-settings').click();
    await page.locator('#show-search-toggle').check();
    await page.locator('#tab-right-details').click();
    assert.match(await page.locator('#details-start').textContent(), /30\.3143/);
    await page.waitForFunction(() => document.querySelector('#ops-status-text').textContent.startsWith('Route Active'));
    assert.match(await page.locator('#details-result').textContent(), /road edges considered/);
    assert.deepEqual(advisoryRequests, []);
    assert.deepEqual(errors, []);
    // Check the incident design at a narrow viewport too.
    await page.setViewportSize({width: 390, height: 844});
    await page.locator('#nav-btn-route').click();
    await page.locator('#nav-btn-traffic').click();
    const panel = page.locator('#traffic-hazard-panel');
    assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    console.log('PASS: right tabs/settings/details, all incident types and CRUD, contained incident layout, no removed cards or AI requests, no browser errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
