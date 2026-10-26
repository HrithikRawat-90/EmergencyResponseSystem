const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
require('node:fs').mkdirSync('artifacts', {recursive: true});
(async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5007';
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.request.post(`${base}/api/incidents/clear`);
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#ops-status-text').textContent.startsWith('Ready'));
    const main = await page.locator('nav[aria-label="Main Navigation"]').boundingBox();
    const shortcuts = await page.locator('.hazard-shortcuts').boundingBox();
    assert.equal(main.width, shortcuts.width);
    assert.ok(Math.abs(main.height - shortcuts.height) < 1);
    assert.ok(shortcuts.y >= main.y + main.height);
    assert.equal(await page.locator('#traffic-hazard-panel').isVisible(), false);
    const shortcut = type => page.locator(`.hazard-shortcut[data-hazard-type="${type}"]`);
    await shortcut('roadblock').click();
    assert.equal(await shortcut('roadblock').getAttribute('aria-pressed'), 'true');
    await shortcut('roadblock').click();
    assert.equal(await shortcut('roadblock').getAttribute('aria-pressed'), 'false');
    await shortcut('roadblock').click();
    await shortcut('accident').click();
    assert.equal(await shortcut('roadblock').getAttribute('aria-pressed'), 'false');
    assert.equal(await shortcut('accident').getAttribute('aria-pressed'), 'true');
    const mapBox = await page.locator('#map').boundingBox();
    for (const type of ['roadblock', 'accident', 'congestion']) {
      if (type === 'congestion') {
        await page.locator('#nav-btn-graph').click();
        await page.waitForFunction(() => !document.querySelector('#nav-btn-graph').disabled);
      }
      if (await shortcut(type).getAttribute('aria-pressed') !== 'true') await shortcut(type).click();
      assert.equal(await page.locator('#traffic-hazard-panel').isVisible(), false);
      assert.equal(await page.evaluate(() => window.scrollY), 0, 'shortcuts should not scroll to the old panel');
      const response = page.waitForResponse(r => r.url().endsWith('/api/incidents') && r.request().method() === 'POST');
      await page.mouse.click(mapBox.x + mapBox.width * 0.55, mapBox.y + mapBox.height * 0.48);
      const incident = await (await response).json();
      assert.equal(incident.success, true);
      assert.equal(incident.incident.type, type);
      assert.equal(await shortcut(type).getAttribute('aria-pressed'), 'false');
    }
    assert.equal(await page.locator('.clean-circle-marker').count(), 0);
    await page.screenshot({path: 'artifacts/hazard-shortcuts-preview.png'});
    await page.locator('#nav-btn-traffic').click();
    assert.equal(await page.locator('#traffic-hazard-panel').isVisible(), true);
    assert.equal(await page.locator('.hazard-chip').count(), 3);
    await page.locator('#place-incident-btn').click();
    assert.equal(await shortcut('congestion').getAttribute('aria-pressed'), 'true');
    await page.locator('#clear-all-hazards-btn').click();
    await page.waitForFunction(() => document.querySelectorAll('.hazard-chip').length === 0);
    assert.equal(await shortcut('congestion').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(errors, []);
    console.log('PASS: matching left panels, all shortcut hazard types, cancellation/type switching, no scroll, both map modes, original panel synchronization');
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
