// Fleet resource editing must not change manual waypoints or leave ghost markers.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1100}});
    const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5015';
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('.fleet-unit').length === 4);
    await page.locator('#fleet-add-type').selectOption('police');
    await page.locator('#fleet-add-btn').click();
    assert.equal(await page.locator('#fleet-placement').isVisible(), true);
    await page.locator('#map').click({position: {x: 340, y: 270}});
    await page.waitForFunction(() => document.querySelectorAll('.fleet-unit').length === 5);
    assert.equal(await page.locator('.clean-circle-marker').count(), 0);
    assert.equal(await page.locator('.fleet-vehicle').count(), 5);
    let state = await (await page.request.get(`${base}/api/simulation`)).json();
    const added = state.fleet.units.find(u => u.id === 'police-2');
    assert.ok(added);
    const card = page.locator('.fleet-unit[data-unit-id="police-2"]');
    await card.locator('[data-action="move"]').click();
    await page.locator('#map').click({position: {x: 440, y: 310}});
    await page.waitForFunction(() => document.querySelector('#fleet-placement').hidden);
    state = await (await page.request.get(`${base}/api/simulation`)).json();
    const moved = state.fleet.units.find(u => u.id === added.id);
    assert.notDeepEqual(moved.position, added.position);
    assert.equal(await page.locator('.clean-circle-marker').count(), 0);
    await page.locator('#fleet-reset-btn').click();
    state = await (await page.request.get(`${base}/api/simulation`)).json();
    assert.equal(state.fleet.units.length, 5);
    assert.deepEqual(state.fleet.units.find(u => u.id === added.id).position, moved.position);
    await card.locator('[data-action="remove"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.fleet-unit').length === 4);
    assert.equal(await page.locator('.fleet-vehicle[data-unit-id="police-2"]').count(), 0);
    await page.locator('#nav-btn-graph').click();
    await page.locator('#fleet-add-btn').click();
    await page.locator('#fleet-placement-cancel').click();
    assert.equal(await page.locator('#fleet-placement').isVisible(), false);
    await page.locator('.fleet-unit[data-unit-id="police-1"] [data-action="move"]').click();
    await page.locator('#map').click({position: {x: 360, y: 280}});
    await page.waitForFunction(() => document.querySelector('#fleet-placement').hidden);
    assert.equal(await page.locator('.clean-circle-marker').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: add/move/remove, marker cleanup, reset persistence, graph placement and waypoint isolation');
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
