// Browser regression: complete trace, progressive reveal, pause, replay and cleanup.
// Requires Playwright and installed Edge; start Flask on port 5001 first.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
require('node:fs').mkdirSync('artifacts', {recursive: true});
(async () => {
  const browser = await chromium.launch({channel:'msedge', headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:5001');
    await page.waitForFunction(() => document.querySelector('#ops-status-text').textContent.includes('Exploring'));
    await page.screenshot({path:'artifacts/search-preview.png'});
    await page.locator('#resume-playback-btn').click();
    const paused = await page.locator('#ops-status-text').textContent();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#ops-status-text').textContent(), paused);
    await page.locator('#resume-playback-btn').click();
    await page.locator('#anim-speed-select').selectOption('2');
    await page.waitForFunction(() => document.querySelectorAll('.route-core').length === 1);
    await page.waitForTimeout(150);
    const partial = await page.locator('.route-core').getAttribute('d');
    await page.screenshot({path:'artifacts/route-reveal-preview.png'});
    await page.waitForFunction(() => document.querySelector('#ops-status-text').textContent.startsWith('Route Active'));
    const full = await page.locator('.route-core').getAttribute('d');
    assert.notEqual(partial, full, 'route must grow progressively');
    assert.equal(await page.locator('.route-flow').count(), 1);
    await page.screenshot({path:'artifacts/route-preview.png'});
    await page.locator('#resume-playback-btn').click();
    assert.equal(await page.locator('.route-flow').evaluate(e => getComputedStyle(e).animationPlayState), 'paused');
    await page.locator('#replay-btn').click();
    assert.equal(await page.locator('#resume-playback-btn').textContent(), 'Pause');
    assert.equal(await page.locator('.route-core').count(), 0);
    await page.waitForFunction(() => document.querySelector('#ops-status-text').textContent.startsWith('Route Active'));
    // Replay must replace previous paths/renderers, with no delayed cleanup deleting new layers.
    assert.equal(await page.locator('.route-core').count(), 1);
    // The sector boundary owns the one persistent default canvas.
    assert.equal(await page.locator('#map .leaflet-overlay-pane canvas').count(), 1);
    assert.equal(await page.locator('#map .leaflet-overlay-pane svg').count(), 1);
    await page.locator('#algorithm-select').selectOption('dijkstra');
    await page.locator('#calculate-route-btn').click();
    await page.waitForFunction(() => {
      const status = document.querySelector('#ops-status-text').textContent;
      const progress = status.match(/Exploring ([\d,]+) \/ ([\d,]+)/);
      return progress && Number(progress[1].replaceAll(',', '')) > 600;
    });
    await page.locator('#resume-playback-btn').click();
    await page.screenshot({path:'artifacts/search-preview.png'});
    assert.match(await page.locator('#ops-status-text').textContent(), /Dijkstra.*Exploring/);
    await page.locator('#resume-playback-btn').click();
    await page.waitForFunction(() => document.querySelector('#ops-status-text').textContent.startsWith('Route Active'));
    // Restart in the middle of the route reveal, not only after completion.
    await page.locator('#replay-btn').click();
    await page.waitForFunction(() => document.querySelectorAll('.route-core').length === 1);
    await page.locator('#replay-btn').click();
    assert.equal(await page.locator('.route-core').count(), 0);
    await page.waitForFunction(() => document.querySelector('#ops-status-text').textContent.startsWith('Route Active'));
    assert.equal(await page.locator('.route-core').count(), 1);
    assert.equal(await page.locator('#map .leaflet-overlay-pane canvas').count(), 1);
    assert.equal(await page.locator('#map .leaflet-overlay-pane svg').count(), 1);
    assert.deepEqual(errors, []);
    console.log('PASS: real Dijkstra trace past 600 edges, progressive reveal, pause/resume, live speed, replay during reveal, renderer cleanup, no browser errors');
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode=1;});
