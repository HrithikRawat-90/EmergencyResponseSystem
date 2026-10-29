// Real Web Audio and marker regression: expansion ticks, original arpeggio, sirens and top-down icons.
// Start Flask first; TEST_BASE_URL defaults to http://127.0.0.1:5017.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({channel:'msedge', headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1100}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const NativeAudio = window.AudioContext;
      window.__sound = {context:null, voices:[], analyser:null};
      Object.defineProperty(window,'createSearchAudio',{configurable:true,set(factory) {
        const wrapped = (...args) => {
          const audio = factory(...args), update = audio.update;
          audio.update = (phase, progress, expansion) => {
            window.__audioFrame = {phase, expanded:expansion?.expanded,
              visible:document.querySelector('#ops-status-text')?.textContent};
            try { return update(phase,progress,expansion); } finally { window.__audioFrame = null; }
          };
          return audio;
        };
        Object.defineProperty(window,'createSearchAudio',{value:wrapped,writable:true,configurable:true});
      }});
      window.AudioContext = class extends NativeAudio {
        constructor(...args) {
          super(...args); window.__sound.context = this;
          window.__sound.analyser = this.createAnalyser();
        }
        createOscillator() {
          const oscillator = super.createOscillator();
          const info = {node:oscillator, ended:false, frame:window.__audioFrame ? {...window.__audioFrame} : null};
          const start=oscillator.start.bind(oscillator), stop=oscillator.stop.bind(oscillator);
          oscillator.start=(when=this.currentTime)=>{info.startAt=when;return start(when);};
          oscillator.stop=(when=this.currentTime)=>{info.stopAt=when;return stop(when);};
          oscillator.addEventListener('ended', () => {info.ended=true;});
          window.__sound.voices.push(info); return oscillator;
        }
        createGain() {
          const gain = super.createGain(), connect = gain.connect.bind(gain);
          gain.connect = destination => {
            if (destination === this.destination) connect(window.__sound.analyser);
            return connect(destination);
          };
          return gain;
        }
      };
      window.__rms = () => {
        const analyser = window.__sound.analyser;
        if (!analyser) return 0;
        const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((sum,x)=>sum+x*x,0)/samples.length);
      };
      window.__carriers = () => window.__sound.voices.filter(v=>!v.ended && v.node.type==='triangle' && v.node.frequency.value>100).map(v=>v.node.frequency.value).sort((a,b)=>a-b);
    });
    const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5017';
    async function resetWorld() {
      await page.request.post(`${base}/api/traffic/control`,{data:{action:'reset'}});
      await page.request.post(`${base}/api/fleet/control`,{data:{action:'reset'}});
      await page.request.post(`${base}/api/incidents/clear`);
    }
    async function quiet(message) {
      await page.waitForTimeout(180);
      await page.waitForFunction(()=>window.__rms()<.00015,null,{timeout:3000});
      const output=await page.evaluate(()=>({rms:window.__rms(), state:window.__sound.context?.state,
        time:window.__sound.context?.currentTime, button:document.querySelector('#resume-playback-btn')?.textContent,
        sources:window.__sound.voices.filter(v=>!v.ended).map(v=>({frequency:v.node.frequency.value,frame:v.frame,start:v.startAt,stop:v.stopAt}))}));
      assert.ok(output.rms < .00015,message+' '+JSON.stringify(output));
    }
    const count = () => page.evaluate(()=>window.__sound.voices.length);
    async function volume(id,value) {
      await page.locator('#'+id).evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));},value);
    }
    await resetWorld(); await page.goto(base);
    await page.waitForFunction(()=>document.querySelector('#ops-status-text').textContent.startsWith('Ready'));
    assert.equal(await page.evaluate(()=>window.__sound.context),null,'no audio context or sound on load');
    assert.equal(await page.locator('#search-volume').inputValue(),'85','search starts at the louder default');
    assert.equal(await page.locator('#found-volume').inputValue(),'65');
    assert.equal(await page.locator('#vehicle-volume').inputValue(),'65');
    await page.locator('#algorithm-select').selectOption('dijkstra');
    for (const graph of [false,true]) {
      if(graph) await page.locator('#nav-btn-graph').click();
      await page.locator('#start-landmark-select').selectOption('station');
      await page.locator('#dest-landmark-select').selectOption('clock_tower');
      const before = await count();
      await page.locator('#calculate-route-btn').click();
      await page.waitForFunction(()=>window.__rms() > .015);
      assert.ok(await page.evaluate(()=>window.__rms()) < .18,'fuller search output is audible and stays bounded');
      await page.waitForFunction(n=>window.__sound.voices.length>n+1,before);
      assert.ok(await page.evaluate(n=>window.__sound.voices.slice(n).filter(v=>v.frame?.phase==='search').every(v=>v.stopAt-v.startAt<=.1),before),'search emits short scan ticks rather than a sustained sweep');
      const ticks = await page.evaluate(n=>window.__sound.voices.slice(n).filter(v=>v.frame?.phase==='search').map(v=>v.frame),before);
      assert.ok(ticks.length>1);
      assert.ok(ticks.every((tick,i)=>tick.expanded>0 && (!i || tick.expanded>ticks[i-1].expanded)), 'every tick corresponds to newly explored roads');
      assert.ok(ticks.every(tick=>Number(tick.visible.match(/Exploring ([\d,]+)/)[1].replaceAll(',',''))===tick.expanded), 'sound count agrees with the displayed exploration count');
      if (!graph) {
        await page.locator('#tab-right-settings').click();
        await volume('search-volume',0); await quiet('search slider alone silences exploration');
        await volume('found-volume',0); await volume('search-volume',85);
        await page.waitForFunction(()=>window.__rms()>.001);
        await volume('found-volume',65);
        await page.locator('#tab-right-route').click();
      }
      await page.locator('#resume-playback-btn').click(); await quiet('search pause is silent');
      const paused = await count(); await page.waitForTimeout(350);
      assert.equal(await count(),paused,'paused playback cannot schedule more notes');
      await page.locator('#anim-speed-select').selectOption('2');
      await page.locator('#resume-playback-btn').click();
      await page.waitForFunction(n=>window.__sound.voices.length>n,paused);
      if (!graph) await volume('search-volume',0);
      await page.waitForFunction(()=>/(?:Route|route) found/.test(document.querySelector('#ops-status-text').textContent));
      await page.waitForFunction(()=>window.__rms()>.001);
      if (!graph) {
        await volume('found-volume',0); await quiet('found slider independently silences the arpeggio');
        await volume('found-volume',65);
      }
      const arpeggio = await page.evaluate(()=>window.__sound.voices.filter(v=>v.frame?.phase==='found').at(-1).node.frequency.value);
      assert.ok([523.25,659.25,783.99,1046.5,1318.51,1567.98].some(note=>Math.abs(note-arpeggio)<25),'restored original destination arpeggio');
      await page.waitForFunction(()=>document.querySelector('#ops-status-text').textContent.startsWith('Route Active'));
      await quiet('completed search is silent');
      if (!graph) await volume('search-volume',85);
      await page.locator('#replay-btn').click(); await page.waitForFunction(()=>window.__rms()>.001);
      await page.locator('#clear-route-btn').click(); await quiet('clear cancels notes');
    }
    // Dispatch every manual vehicle type and check distinct real audio sources and pause/cancel.
    await page.locator('#algorithm-select').selectOption('a*');
    for (const [type,frequency] of [['ambulance',700],['fire',550],['police',800]]) {
      await page.locator('#select-vehicle').selectOption(type);
      await page.locator('#start-landmark-select').selectOption('station');
      await page.locator('#dest-landmark-select').selectOption('parade_ground');
      await page.locator('#calculate-route-btn').click();
      await page.waitForFunction(()=>!document.querySelector('#begin-dispatch-btn').disabled);
      await quiet('ready vehicle has no siren');
      await page.locator('#journey-speed-select').selectOption('10');
      await page.locator('#begin-dispatch-btn').click();
      await page.waitForFunction(()=>window.__rms()>.003);
      const artwork=page.locator('.journey-vehicle .vehicle-art');
      assert.ok((await artwork.getAttribute('src')).endsWith(`/vehicles/${type}.svg`));
      await page.waitForFunction(()=>document.querySelector('.journey-vehicle .vehicle-art')?.naturalWidth>0);
      const size=await artwork.evaluate(el=>({width:parseFloat(getComputedStyle(el).width),height:parseFloat(getComputedStyle(el).height)}));
      assert.ok(Math.abs(size.width-18)<.2 && size.height===28,'moving vehicles use compact 18 by 28 artwork');
      await page.waitForFunction(()=>Number.isFinite(Number(document.querySelector('.journey-vehicle')?.dataset.heading)));
      assert.match(await artwork.getAttribute('style'),/rotate\(/,'top-down artwork follows movement without rotating Leaflet positioning');
      if (process.env.VEHICLE_PREVIEW && type==='fire') await page.screenshot({path:process.env.VEHICLE_PREVIEW});
      assert.deepEqual(await page.evaluate(()=>window.__carriers()),[frequency],`${type} has its own siren`);
      await page.locator('#journey-pause-btn').click(); await quiet('manual pause stops siren');
      assert.equal(await artwork.evaluate(el=>parseFloat(getComputedStyle(el).height)),36,'paused marker returns to its resting size');
      await page.locator('#journey-pause-btn').click(); await page.waitForFunction(()=>window.__rms()>.003);
      if (type === 'police') {
        await page.locator('#journey-speed-select').selectOption('60');
        await page.waitForFunction(()=>document.querySelector('#journey-panel').dataset.phase==='completed');
        await quiet('arrival stops the siren');
      } else {
        await page.locator('#cancel-dispatch-btn').click(); await quiet('manual cancellation stops siren');
      }
    }
    // Fleet voices follow authoritative independent states, even with several units moving.
    for(const type of ['ambulance','fire','police']) {
      await page.locator('#select-vehicle').selectOption(type);
      await page.locator('#dest-landmark-select').selectOption(type === 'ambulance' ? 'parade_ground' : 'station');
      const queued = page.waitForResponse(r=>r.url().endsWith('/api/fleet/requests'));
      await page.locator('#fleet-queue-btn').click(); await queued;
    }
    await page.locator('#fleet-speed').selectOption('10');
    await page.locator('#fleet-start-btn').click();
    await page.waitForFunction(()=>window.__carriers().length===3);
    assert.deepEqual(await page.evaluate(()=>window.__carriers()),[550,700,800]);
    assert.equal(await page.locator('.fleet-vehicle .vehicle-art').count(),4,'all fleet markers use top-down artwork');
    assert.equal(await page.locator('.unit-vehicle-icon').count(),3,'Units panel uses the same artwork');
    assert.ok(await page.locator('.fleet-vehicle .vehicle-art').evaluateAll(images=>images.every(image=>image.complete&&image.naturalWidth>0)));
    assert.ok(await page.locator('.fleet-vehicle[data-phase="enroute"] .vehicle-art').evaluateAll(images=>images.every(image=>parseFloat(getComputedStyle(image).height)===28)),'travelling fleet units are compact too');
    const first = await page.locator('.fleet-unit[data-phase="enroute"]').first().getAttribute('data-unit-id');
    await page.locator(`.fleet-unit[data-unit-id="${first}"] button[data-action="pause"]`).click();
    await page.waitForFunction(()=>window.__carriers().length===2);
    assert.ok(await page.evaluate(()=>window.__rms())<.05,'simultaneous sirens share a quiet mix');
    await page.locator('#fleet-pause-btn').click(); await quiet('global fleet pause is silent');
    assert.ok(await page.locator('.fleet-vehicle .vehicle-art').evaluateAll(images=>images.every(image=>parseFloat(getComputedStyle(image).height)===36)),'global pause restores resting marker size');
    await page.locator('#fleet-start-btn').click(); await page.waitForFunction(()=>window.__carriers().length===2);
    await page.locator('#tab-right-settings').click();
    if (process.env.SOUND_PREVIEW) await page.locator('#tabpanel-right-settings').screenshot({path:process.env.SOUND_PREVIEW});
    await page.locator('#sound-enabled-toggle').uncheck(); await quiet('mute stops all voices');
    await page.locator('#sound-enabled-toggle').check(); await page.waitForFunction(()=>window.__carriers().length===2);
    await volume('vehicle-volume',0);
    await quiet('vehicle slider silences sirens with search/found still enabled');
    await volume('vehicle-volume',35);
    await page.waitForFunction(()=>window.__rms()>.001);
    await volume('search-volume',0); await volume('found-volume',0);
    assert.ok(await page.evaluate(()=>window.__rms())>.001,'vehicle sirens do not depend on search/found sliders');
    await volume('search-volume',45); await volume('found-volume',75);
    await page.reload();
    await page.waitForFunction(()=>document.querySelectorAll('.fleet-unit').length===4);
    assert.equal(await page.locator('#search-volume').inputValue(),'45','search preference survives reload');
    assert.equal(await page.locator('#found-volume').inputValue(),'75','found preference survives reload');
    assert.equal(await page.locator('#vehicle-volume').inputValue(),'35','vehicle preference survives reload');
    assert.equal(await page.evaluate(()=>window.__sound.context),null,'a restored running fleet cannot autoplay before a gesture');
    await page.locator('#fleet-reset-btn').click(); await quiet('reset does not leave sirens behind');
    await page.evaluate(()=>localStorage.setItem('emergency-audio',JSON.stringify({enabled:true,volume:.35})));
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#search-volume')?.value==='85');
    assert.equal(await page.locator('#found-volume').inputValue(),'35','legacy found volume migrates');
    assert.equal(await page.locator('#vehicle-volume').inputValue(),'35','legacy vehicle volume migrates');
    // Unsupported Web Audio must leave ordinary route playback working.
    await page.reload();
    await page.evaluate(()=>{window.AudioContext=undefined;window.webkitAudioContext=undefined;});
    await page.locator('#start-landmark-select').selectOption('station');
    await page.locator('#dest-landmark-select').selectOption('clock_tower');
    await page.locator('#calculate-route-btn').click();
    await page.waitForFunction(()=>document.querySelector('#ops-status-text').textContent.includes('Exploring'));
    assert.deepEqual(errors,[]);
    console.log('PASS: louder synced search, independent search/found/vehicle volume and migration, smaller top-down icons, manual/fleet sirens, pause/cancel/arrival and graceful missing audio');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
