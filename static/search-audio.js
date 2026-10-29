/* Exploration-driven scan ticks, the original destination arpeggio, and vehicle sirens. */
(() => {
  "use strict";

  window.createSearchAudio = () => {
    let context = null, master = null, mix = null, searchMix = null, tickWave = null;
    let enabled = true, phase = null, slot = -1, foundVoice = null;
    const volumes = {search: 0.85, found: 0.65, vehicles: 0.65};
    const channels = {};
    let lastExpansion = 0, lastPulseAt = -Infinity, lastSoundAt = -Infinity;
    const notes = new Set(), sirens = new Map(), groups = new Map();
    const arrivalNotes = [523.25, 659.25, 783.99, 1046.50, 1318.51, 1567.98];
    // Gentle demo patterns at a natural cadence, independent of travel acceleration.
    const profiles = {
      ambulance: {center: 700, depth: 130, rate: 0.85, wave: "square"},
      fire: {center: 550, depth: 200, rate: 0.25, wave: "sine"},
      police: {center: 800, depth: 230, rate: 1.65, wave: "triangle"},
    };
    try {
      const stored = JSON.parse(localStorage.getItem("emergency-audio") || "null");
      if (stored) {
        enabled = stored.enabled !== false;
        for (const name of Object.keys(volumes)) {
          const value = stored.volumes?.[name];
          if (Number.isFinite(value)) volumes[name] = Math.max(0, Math.min(1, value));
          // Keep legacy found/siren levels, but raise search to its new default.
          else if (Number.isFinite(stored.volume) && (name !== "search" || stored.volume === 0)) {
            volumes[name] = Math.max(0, Math.min(1, stored.volume));
          }
        }
      }
    } catch { /* Private browsing or invalid preferences can use the defaults. */ }

    const audible = () => enabled && !document.hidden && context?.state === "running";
    function retire(voice) {
      if (voice.stopped) return;
      voice.stopped = true;
      const now = context.currentTime;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0, now, 0.008);
      voice.sources.forEach(source => source.stop(now + 0.06));
    }
    function clearNotes() {
      if (searchMix) searchMix.gain.setValueAtTime(0, context.currentTime);
      for (const voice of notes) retire(voice);
      notes.clear(); foundVoice = null;
    }
    function clearSirens() { for (const voice of sirens.values()) retire(voice); sirens.clear(); }
    function stop() { clearNotes(); phase = null; slot = -1; lastExpansion = 0; lastPulseAt = lastSoundAt = -Infinity; }

    function createSiren(profile) {
      const oscillator = context.createOscillator(), lfo = context.createOscillator();
      const depth = context.createGain(), smooth = context.createBiquadFilter();
      const filter = context.createBiquadFilter(), gain = context.createGain();
      oscillator.type = "triangle"; oscillator.frequency.value = profile.center;
      lfo.type = profile.wave; lfo.frequency.value = profile.rate;
      depth.gain.value = profile.depth;
      // Round off tone changes and remove shrill harmonics.
      smooth.type = "lowpass"; smooth.frequency.value = 5; smooth.Q.value = 0.5;
      filter.type = "lowpass"; filter.frequency.value = 1500; filter.Q.value = 0.5;
      gain.gain.value = 0;
      lfo.connect(smooth); smooth.connect(depth); depth.connect(oscillator.frequency);
      oscillator.connect(filter); filter.connect(gain); gain.connect(channels.vehicles);
      const voice = {gain, sources: [oscillator, lfo], stopped: false};
      oscillator.onended = () => [oscillator, lfo, depth, smooth, filter, gain].forEach(node => node.disconnect());
      oscillator.start(); lfo.start();
      return voice;
    }
    function reconcile() {
      if (!audible() || volumes.vehicles === 0) { clearSirens(); return; }
      const desired = new Map();
      for (const [group, units] of groups) for (const unit of units) {
        if (profiles[unit.type]) desired.set(`${group}:${unit.id}`, unit.type);
      }
      try {
        for (const [id, voice] of sirens) if (desired.get(id) !== voice.type) {
          retire(voice); sirens.delete(id);
        }
        for (const [id, type] of desired) if (!sirens.has(id)) {
          sirens.set(id, {...createSiren(profiles[type]), type});
        }
        // Active vehicles share the same loudness budget instead of stacking volume.
        const level = 0.045 / Math.sqrt(Math.max(1, sirens.size));
        for (const voice of sirens.values()) voice.gain.gain.setTargetAtTime(level, context.currentTime, 0.06);
      } catch { clearSirens(); }
    }
    function unlock() {
      try {
        if (!enabled || Object.values(volumes).every(value => value === 0)) return;
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        if (!context) {
          context = new AudioContext();
          // A little harmonic body helps short ticks carry on laptop/phone speakers.
          tickWave = context.createPeriodicWave(new Float32Array([0,0,0,0]), new Float32Array([0,1,0.18,0.04]));
          mix = context.createDynamicsCompressor();
          mix.threshold.value = -20; mix.knee.value = 18; mix.ratio.value = 6;
          mix.attack.value = 0.005; mix.release.value = 0.15;
          searchMix = context.createGain(); searchMix.connect(mix);
          for (const name of Object.keys(volumes)) {
            channels[name] = context.createGain(); channels[name].gain.value = volumes[name];
            channels[name].connect(name === "vehicles" ? mix : searchMix);
          }
          master = context.createGain(); master.gain.value = 1;
          mix.connect(master); master.connect(context.destination);
        }
        if (context.state === "suspended") context.resume().then(reconcile).catch(() => {});
        else reconcile();
      } catch { /* Audio support must never affect routing or dispatch. */ }
    }
    function note(frequency, duration, level) {
      const oscillator = context.createOscillator(), gain = context.createGain(), now = context.currentTime;
      oscillator.setPeriodicWave(tickWave); oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(level, now + 0.008);
      gain.gain.setValueAtTime(level, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.00001, now + duration);
      oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.82, now + duration);
      oscillator.connect(gain); gain.connect(channels.search);
      const voice = {gain, sources: [oscillator], stopped: false};
      notes.add(voice);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); notes.delete(voice); };
      oscillator.start(now); oscillator.stop(now + duration + 0.01);
    }
    function update(nextPhase, progress, expansion) {
      if (phase !== nextPhase) { clearNotes(); phase = nextPhase; slot = -1; lastExpansion = 0; lastPulseAt = lastSoundAt = -Infinity; }
      const fraction = Math.max(0, Math.min(1, progress));
      if (!audible()) return;
      try {
        if (nextPhase === "search") {
          const expanded = expansion?.expanded || 0, elapsed = expansion?.elapsedMs || 0;
          if (expanded <= lastExpansion) return;
          lastExpansion = expanded;
          if (volumes.search === 0) return;
          // A tick belongs to newly painted roads, not a separate musical rhythm.
          // Dense batches coalesce without backlog; the simulation clock follows speed/pause.
          // Some devices report "running" before their audio clock starts advancing.
          // Never stack ticks at the same audio timestamp during that startup gap.
          if (elapsed - lastPulseAt < 80 || context.currentTime - lastSoundAt < 0.025) return;
          searchMix.gain.setValueAtTime(1, context.currentTime);
          note(420 + (expanded % 9) * 18, 0.08, sirens.size ? 0.12 : 0.16);
          lastPulseAt = elapsed; lastSoundAt = context.currentTime;
        } else {
          const nextSlot = Math.min(19, Math.floor(fraction * 20));
          const now = context.currentTime;
          if (!foundVoice) {
            const oscillator = context.createOscillator(), gain = context.createGain();
            oscillator.type = "sine"; oscillator.frequency.value = arrivalNotes[nextSlot % arrivalNotes.length];
            gain.gain.value = 0; gain.gain.setTargetAtTime(0.07, now, 0.006);
            searchMix.gain.setValueAtTime(1, now);
            oscillator.connect(gain); gain.connect(channels.found);
            foundVoice = {gain, sources:[oscillator], stopped:false}; notes.add(foundVoice);
            const voice = foundVoice;
            oscillator.onended = () => {oscillator.disconnect(); gain.disconnect(); notes.delete(voice);};
            oscillator.start();
          }
          if (nextSlot !== slot) foundVoice.sources[0].frequency.setTargetAtTime(arrivalNotes[nextSlot % arrivalNotes.length], now, 0.004);
          slot = nextSlot;
        }
      } catch { clearNotes(); }
    }
    function setVehicles(group, units) {
      // Manual journey frames do not need to rebuild an unchanged audio graph.
      const previous = groups.get(group) || [];
      if (previous.length === units.length && previous.every((unit, i) => unit.id === units[i].id && unit.type === units[i].type)) return;
      groups.set(group, units.map(({id, type}) => ({id, type}))); reconcile();
    }
    function settings(nextEnabled, nextVolumes) {
      enabled = !!nextEnabled;
      for (const name of Object.keys(volumes)) if (Number.isFinite(nextVolumes?.[name])) {
        volumes[name] = Math.max(0, Math.min(1, nextVolumes[name]));
      }
      try { localStorage.setItem("emergency-audio", JSON.stringify({enabled, volumes})); } catch {}
      if (master) {
        master.gain.setTargetAtTime(enabled ? 1 : 0, context.currentTime, 0.01);
        for (const name of Object.keys(volumes)) channels[name].gain.setTargetAtTime(volumes[name], context.currentTime, 0.01);
      }
      if (!enabled || Object.values(volumes).every(value => value === 0)) { clearNotes(); clearSirens(); }
      else unlock();
    }
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { clearNotes(); clearSirens(); } else reconcile();
    });
    window.addEventListener("pagehide", () => { stop(); clearSirens(); groups.clear(); });
    return {unlock, update, stop, setVehicles, settings, getSettings: () => ({enabled, volumes: {...volumes}}),
      pause: paused => { if (paused) clearNotes(); else unlock(); }};
  };
})();
