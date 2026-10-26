const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
require('node:fs').mkdirSync('artifacts', {recursive: true});
(async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1100}});
    const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5009';
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.request.post(`${base}/api/traffic/control`, {data: {action: 'reset'}});
    await page.request.post(`${base}/api/fleet/control`, {data: {action: 'reset'}});
    await page.request.post(`${base}/api/incidents/clear`);
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('.fleet-unit').length === 4);
    assert.equal(await page.locator('.fleet-vehicle').count(), 0, 'fleet stays hidden until explicitly enabled');
    assert.equal(await page.locator('.clean-circle-marker').count(), 0);
    const initial = await (await page.request.get(`${base}/api/simulation`)).json();
    const candidates = await Promise.all(initial.fleet.units.filter(u => u.type === 'ambulance').map(async unit => {
      const response = await page.request.post(`${base}/api/route`, {data: {start: unit.position,
        destination: [30.3254, 78.0419], objective: 'time', algorithm: 'a*', unit_type: 'ambulance'}});
      return {id: unit.id, eta: (await response.json()).duration_s};
    }));
    const nearest = candidates.sort((a, b) => a.eta - b.eta)[0].id;
    async function queue(kind, priority, destination = 'clock_tower') {
      await page.locator('#select-vehicle').selectOption(kind);
      await page.locator('#select-priority').selectOption(priority);
      await page.locator('#dest-landmark-select').selectOption(destination);
      const response = page.waitForResponse(r => r.url().endsWith('/api/fleet/requests'));
      await page.locator('#fleet-queue-btn').click();
      const data = await (await response).json(); assert.equal(data.success, true); return data.request_id;
    }
    const low = await queue('ambulance', 'low');
    const critical = await queue('ambulance', 'critical');
    const high = await queue('ambulance', 'high');
    await queue('fire', 'high');
    await queue('police', 'medium', 'station');
    assert.equal(await page.locator('#fleet-requests tr[data-status="queued"]').count(), 5);
    await page.locator('#fleet-speed').selectOption('10');
    const started = page.waitForResponse(r => r.url().endsWith('/api/fleet/control') && r.request().postDataJSON()?.action === 'start');
    await page.locator('#fleet-start-btn').click();
    const assigned = await (await started).json();
    assert.equal(assigned.fleet.requests.find(r => r.id === critical).unit_id, nearest);
    assert.equal(assigned.fleet.requests.find(r => r.id === high).status, 'assigned');
    assert.equal(assigned.fleet.requests.find(r => r.id === low).status, 'queued');
    await page.waitForFunction(() => document.querySelectorAll('.fleet-vehicle').length === 4);
    await page.locator('#fleet-pause-btn').click();
    await page.waitForFunction(() => document.querySelector('#fleet-panel').dataset.running === 'false');
    const paused = await (await page.request.get(`${base}/api/simulation`)).json();
    await page.waitForTimeout(900);
    const still = await (await page.request.get(`${base}/api/simulation`)).json();
    assert.deepEqual(still.fleet.units.map(u => u.position), paused.fleet.units.map(u => u.position));
    await page.locator('#fleet-requests tr').filter({has: page.locator(`button[data-request-id="${low}"]`)}).locator('button').click();
    await page.waitForFunction(id => document.querySelector(`tr[data-request-id="${id}"]`).dataset.status === 'cancelled', low);
    await page.locator('.fleet-unit[data-unit-id="ambulance-2"] button[data-action="pause"]').click();
    await page.waitForFunction(() => document.querySelector('.fleet-unit[data-unit-id="ambulance-2"]').dataset.phase === 'paused');
    await page.locator('#fleet-start-btn').click();
    await page.waitForTimeout(400);
    const moving = await (await page.request.get(`${base}/api/simulation`)).json();
    assert.equal(moving.fleet.units.find(u => u.id === 'ambulance-2').phase, 'paused');
    assert.ok(moving.fleet.units.some(u => u.distance_m > 0));
    await page.locator('#nav-btn-graph').click();
    await page.waitForFunction(() => !document.querySelector('#nav-btn-graph').disabled);
    assert.equal(await page.locator('.fleet-vehicle').count(), 4);
    await page.locator('#fleet-panel .agent-model').filter({hasText: 'AI agent model'}).locator('summary').click();
    assert.match(await page.locator('#fleet-panel').textContent(), /fully observable/);
    await page.locator('#fleet-panel').screenshot({path: 'artifacts/fleet-dispatch-preview.png'});

    await page.locator('#nav-btn-traffic').click();
    await page.locator('#traffic-interval').selectOption('5');
    await page.locator('#traffic-seed').fill('19');
    await page.locator('#auto-traffic-status').click();
    await page.waitForTimeout(900);
    assert.equal(await page.locator('#traffic-interval').inputValue(), '5');
    assert.equal(await page.locator('#traffic-seed').inputValue(), '19');
    await page.locator('#auto-traffic-start').click();
    await page.waitForFunction(() => document.querySelectorAll('.hazard-chip').length >= 3);
    await page.waitForFunction(() => /[2-9] traffic updates/.test(document.querySelector('#auto-traffic-status').textContent), {timeout: 12000});
    await page.locator('#auto-traffic-pause').click();
    const traffic = await (await page.request.get(`${base}/api/simulation`)).json();
    assert.ok(traffic.fleet.units.some(u => u.replans > 0));
    assert.equal(traffic.fleet.traffic.seed, 19);
    assert.equal(traffic.fleet.traffic.interval_s, 5);
    assert.equal(traffic.incidents.filter(i => i.source === 'automatic').length, 3);
    // Current-road closure is shared with the paused fleet agent and cannot teleport it.
    const ambulance = traffic.fleet.units.find(u => u.id === 'ambulance-2');
    assert.ok(ambulance.current_road.length >= 2);
    const road = ambulance.current_road;
    let pair = [road[0], road.at(-1)], longest = 0;
    for (let i = 1; i < road.length; i++) {
      const length = (road[i][0] - road[i - 1][0]) ** 2 + (road[i][1] - road[i - 1][1]) ** 2;
      if (length > longest) {longest = length; pair = [road[i - 1], road[i]];}
    }
    const closure = await (await page.request.post(`${base}/api/incidents`, {data: {type: 'roadblock',
      lat: (pair[0][0] + pair[1][0]) / 2, lon: (pair[0][1] + pair[1][1]) / 2}})).json();
    assert.equal(closure.success, true);
    const blocked = await (await page.request.get(`${base}/api/simulation`)).json();
    const held = blocked.fleet.units.find(u => u.id === 'ambulance-2');
    assert.equal(held.phase, 'waiting');
    assert.deepEqual(held.position, ambulance.position);
    await page.request.delete(`${base}/api/incidents/${closure.incident.id}`);
    const cleared = await (await page.request.get(`${base}/api/simulation`)).json();
    assert.equal(cleared.fleet.units.find(u => u.id === 'ambulance-2').phase, 'paused');
    await page.locator('#auto-traffic-reset').click();
    await page.waitForFunction(() => document.querySelectorAll('.hazard-chip').length === 0);
    await page.locator('.fleet-unit[data-unit-id="ambulance-2"] button[data-action="resume"]').click();
    await page.locator('#fleet-speed').selectOption('60');
    await page.waitForFunction(() => [...document.querySelectorAll('#fleet-requests tr')].filter(r => r.dataset.status === 'completed').length >= 4);
    await page.locator('#fleet-reset-btn').click();
    await page.waitForFunction(() => document.querySelectorAll('#fleet-requests tr').length === 0);
    await page.locator('#fleet-show-map').uncheck();
    assert.deepEqual(errors, []);
    console.log('PASS: priority queue, compatible minimum ETA, four agents, per-unit/global pause, graph switching, automatic traffic, shared closure waiting, arrivals and reset');
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
