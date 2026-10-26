const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1100}, reducedMotion: 'reduce'});
    const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5016';
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.request.post(`${base}/api/fleet/control`, {data: {action: 'reset'}});
    await page.request.patch(`${base}/api/fleet/units/fire-1`, {data: {position: [30.3285, 78.0482]}});
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('.fleet-unit').length === 4);
    await page.locator('#fleet-show-map').check();
    await page.locator('#map').scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    const marker = page.locator('.fleet-vehicle[data-unit-id="fire-1"]');
    async function state() {return (await (await page.request.get(`${base}/api/simulation`)).json()).fleet;}
    async function drag(dx, dy, hold = false) {
      const box = await marker.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, {steps: 12});
      if (hold) {
        const transform = await marker.evaluate(el => el.style.transform);
        await page.waitForTimeout(1100);
        assert.equal(await marker.evaluate(el => el.style.transform), transform, 'polling must not reset an active drag');
      }
      const response = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().endsWith('/api/fleet/units/fire-1'));
      await page.mouse.up();
      return response;
    }
    const before = (await state()).units.find(u => u.id === 'fire-1').position;
    assert.equal(await marker.getAttribute('data-draggable'), 'true');
    assert.equal((await drag(-65, 50, true)).status(), 200);
    await page.waitForFunction(() => document.querySelector('.fleet-vehicle[data-unit-id="fire-1"]').dataset.draggable === 'true');
    const moved = (await state()).units.find(u => u.id === 'fire-1').position;
    assert.notDeepEqual(moved, before);
    const visual = JSON.parse(await marker.getAttribute('data-position'));
    assert.deepEqual([visual.lat, visual.lng], moved, 'drop uses the server snapped node');
    assert.equal(await page.locator('.clean-circle-marker').count(), 0);
    await page.locator('#nav-btn-graph').click();
    await page.waitForFunction(() => Number(document.querySelector('.graph-canvas')?.dataset.roads) > 8000);
    assert.equal((await drag(40, 35)).status(), 200);
    const graphPosition = (await state()).units.find(u => u.id === 'fire-1').position;
    assert.notDeepEqual(graphPosition, moved);
    await page.route('**/api/fleet/units/fire-1', route => route.request().method() === 'PATCH'
      ? route.fulfill({status: 400, contentType: 'application/json', body: JSON.stringify({success: false, error: 'Rejected drop'})})
      : route.continue());
    assert.equal((await drag(-25, -25)).status(), 400);
    await page.waitForFunction(position => {
      const el = document.querySelector('.fleet-vehicle[data-unit-id="fire-1"]');
      const p = JSON.parse(el.dataset.position);
      return el.dataset.draggable === 'true' && p.lat === position[0] && p.lng === position[1];
    }, graphPosition);
    await page.unroute('**/api/fleet/units/fire-1');
    await page.locator('#select-vehicle').selectOption('fire');
    await page.locator('#dest-landmark-select').selectOption('station');
    await page.locator('#fleet-queue-btn').click();
    await page.locator('#fleet-start-btn').click();
    await page.waitForFunction(() => document.querySelector('.fleet-vehicle[data-unit-id="fire-1"]').dataset.draggable === 'false');
    assert.equal(await marker.evaluate(el => el.classList.contains('leaflet-marker-draggable')), false);
    assert.equal(await page.locator('.clean-circle-marker').count(), 1, 'only the explicitly selected destination exists');
    assert.deepEqual(errors, []);
    console.log('PASS: real/graph dragging, polling during drag, road snap, rejected-drop rollback, assigned-unit lock and waypoint isolation');
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
