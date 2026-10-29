/* Vehicle dispatch has its own clock and layers; route-discovery playback stays separate. */
(() => {
  "use strict";
  window.createDispatchSimulation = ({map, requestRoute, onStatus, onChange, onReplanned, onCancel, audio}) => {
    const byId = id => document.getElementById(id);
    const units = {ambulance: {label: "Ambulance", color: "#169b82"},
      fire: {label: "Fire brigade", color: "#e88032"},
      police: {label: "Police", color: "#3984eb"}};
    let data = null, legs = [], index = 0, legElapsed = 0, elapsed = 0, travelled = 0;
    let phase = "idle", marker = null, line = null, renderer = null, timer = null, last = null;
    let generation = 0, resumePaused = false;
    const active = () => ["running", "paused", "replanning", "waiting"].includes(phase);
    map.createPane("journeyRoutePane").style.zIndex = "480";

    function geometry(leg, fraction) {
      const points = leg.geometry;
      const lengths = [0];
      for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + map.distance(points[i - 1], points[i]));
      const target = (lengths[lengths.length - 1] || 0) * fraction;
      let i = 0;
      while (i + 1 < lengths.length && lengths[i + 1] <= target) i++;
      if (i + 1 >= points.length) return {point: points[points.length - 1], tail: [points[points.length - 1]]};
      const span = lengths[i + 1] - lengths[i], t = span ? (target - lengths[i]) / span : 1;
      const point = [points[i][0] + (points[i + 1][0] - points[i][0]) * t,
        points[i][1] + (points[i + 1][1] - points[i][1]) * t];
      return {point, tail: [point, ...points.slice(i + 1)]};
    }
    function location() {
      if (index >= legs.length) return data.destination.snapped;
      return geometry(legs[index], legs[index].duration_s ? legElapsed / legs[index].duration_s : 1).point;
    }
    function remaining() {
      let seconds = 0, distance = 0;
      for (let i = index; i < legs.length; i++) {
        const fraction = i === index && legs[i].duration_s ? 1 - legElapsed / legs[i].duration_s : 1;
        seconds += legs[i].duration_s * fraction; distance += legs[i].distance_m * fraction;
      }
      return {seconds: Math.max(0, seconds), distance: Math.max(0, distance)};
    }
    function update(message) {
      audio?.setVehicles("journey", phase === "running" && data ? [{id: "manual", type: data.unit_type}] : []);
      const left = remaining(), total = travelled + left.distance;
      const progress = phase === "completed" ? 100 : total ? Math.min(100, travelled / total * 100) : 0;
      byId("journey-panel").dataset.phase = phase;
      byId("journey-panel").dataset.travelled = String(travelled);
      byId("journey-panel").dataset.legIndex = String(index);
      byId("journey-panel").dataset.edge = JSON.stringify(legs[index]?.edge || []);
      byId("journey-status").textContent = message;
      byId("journey-remaining").textContent = `${(left.distance / 1000).toFixed(2)} km`;
      byId("journey-eta").textContent = ["waiting", "replanning"].includes(phase) ? "Waiting for route" : `${(left.seconds / 60).toFixed(1)} min`;
      byId("journey-travelled").textContent = `${(travelled / 1000).toFixed(2)} km`;
      byId("journey-elapsed").textContent = `${(elapsed / 60).toFixed(1)} min`;
      byId("journey-progress").value = progress;
      byId("journey-progress-text").textContent = `${Math.floor(progress)}%`;
      byId("begin-dispatch-btn").disabled = phase !== "ready";
      byId("journey-pause-btn").disabled = !["running", "paused"].includes(phase);
      byId("journey-pause-btn").textContent = phase === "paused" ? "Resume journey" : "Pause journey";
      byId("cancel-dispatch-btn").disabled = !active();
      byId("retry-dispatch-btn").hidden = phase !== "waiting";
      for (const type of Object.keys(units)) {
        byId(`unit-status-${type}`).textContent = data?.unit_type === type && phase !== "idle" ? message : "Available";
      }
      if (marker) {
        const position = marker.getLatLng();
        marker.getElement().dataset.phase = phase;
        marker.getElement().dataset.position = JSON.stringify([position.lat, position.lng]);
      }
      onChange(phase);
    }
    function drawRoute() {
      const coords = legs.flatMap(leg => leg.geometry);
      if (!renderer) renderer = L.svg({pane: "journeyRoutePane"});
      if (!line) line = L.polyline(coords, {pane: "journeyRoutePane", renderer,
        color: units[data.unit_type].color, weight: 5, opacity: 0.95,
        className: "journey-route", interactive: false}).addTo(map);
      else line.setLatLngs(coords);
    }
    function clear() {
      ++generation;
      if (timer !== null) cancelAnimationFrame(timer);
      timer = null;
      if (marker) map.removeLayer(marker);
      if (line) map.removeLayer(line);
      if (renderer) map.removeLayer(renderer);
      marker = line = renderer = null;
      data = null; legs = []; index = legElapsed = travelled = elapsed = 0;
      phase = "idle";
      byId("journey-panel").hidden = true;
      update("Awaiting route");
    }
    function prepare(route) {
      clear(); data = route; legs = route.journey_segments || [];
      phase = "ready";
      byId("journey-panel").hidden = false;
      byId("journey-vehicle-label").textContent = route.vehicle_profile?.label || units[route.unit_type].label;
      byId("journey-profile").textContent = `${(route.priority || "critical").toUpperCase()} priority · ${route.vehicle_profile?.description || "Simulated vehicle profile"}`;
      update("Ready to dispatch");
    }
    function frame(now) {
      const delta = last === null ? 0 : Math.min(now - last, 80) / 1000; last = now;
      if (phase === "running") {
        let budget = delta * Number(byId("journey-speed-select").value);
        while (budget > 0 && index < legs.length) {
          const leg = legs[index], left = Math.max(0, leg.duration_s - legElapsed);
          const step = Math.min(budget, left);
          legElapsed += step; elapsed += step;
          travelled += leg.duration_s ? leg.distance_m * step / leg.duration_s : leg.distance_m;
          budget -= step;
          if (legElapsed >= leg.duration_s) { index++; legElapsed = 0; }
        }
        window.vehicleIcons.setPosition(marker, location());
        if (index >= legs.length) {
          phase = "completed";
          update("Mission completed · Unit arrived");
          onStatus(`${units[data.unit_type].label} arrived · Mission completed`);
          timer = null; return;
        }
        update("En route");
      }
      timer = requestAnimationFrame(frame);
    }
    function start() {
      if (phase !== "ready") return;
      audio?.unlock();
      const unit = units[data.unit_type];
      marker = L.marker(data.start.snapped, {interactive: false, zIndexOffset: 500,
        icon: L.divIcon({className: "journey-vehicle", iconSize: [44, 56], iconAnchor: [22, 28],
          html: window.vehicleIcons.html(data.unit_type, unit.label, unit.color)})}).addTo(map);
      const firstRoad = legs.find(leg => leg.geometry.length > 1)?.geometry;
      if (firstRoad) window.vehicleIcons.face(marker, firstRoad[0], firstRoad[1]);
      drawRoute(); phase = "running"; last = null;
      update("En route"); onStatus(`${unit.label} dispatched · Simulation in progress`);
      timer = requestAnimationFrame(frame);
    }
    function invalidate() {
      if (!active()) return;
      ++generation;
      resumePaused = phase === "paused" || resumePaused;
      phase = "waiting";
      update("Incidents changed · Recalculate to continue");
      onStatus("Vehicle stopped · Updated route required");
    }
    async function replan(incidents) {
      if (!active() || !data) return;
      const request = ++generation;
      resumePaused = phase === "paused" || (["waiting", "replanning"].includes(phase) && resumePaused);
      phase = "replanning"; update("Recalculating from vehicle position");
      const leg = legs[index];
      const partial = leg && (legElapsed > 0 || leg.started_mid_edge);
      const matches = edge => leg?.edge && edge.every((part, i) => String(part) === String(leg.edge[i]));
      if (partial && incidents.some(inc => inc.type === "roadblock" && inc.edges.some(matches))) {
        phase = "waiting"; update("Current road blocked · Clear closure to continue");
        onStatus("Vehicle waiting · Current road is closed"); return;
      }
      let prefix = null;
      if (partial) {
        const fraction = legElapsed / leg.duration_s;
        const multiplier = incidents.reduce((cost, inc) => inc.type !== "roadblock" && inc.edges.some(matches) ? cost * inc.penalty : cost, 1);
        prefix = {...leg, geometry: geometry(leg, fraction).tail,
          duration_s: (leg.duration_s - legElapsed) * multiplier / (leg.incident_multiplier || 1),
          distance_m: leg.distance_m * (1 - fraction), incident_multiplier: multiplier, started_mid_edge: true};
      }
      const startPoint = prefix ? prefix.geometry[prefix.geometry.length - 1] : location();
      try {
        const route = await requestRoute(startPoint, data);
        if (request !== generation) return;
        if (!route.success) throw new Error("No passable route · Remove a closure and retry");
        const combined = {...route,
          start: {...route.start, snapped: prefix ? prefix.geometry[0] : route.start.snapped},
          journey_segments: [...(prefix ? [prefix] : []), ...route.journey_segments],
          route_geometry: [...(prefix ? prefix.geometry : []), ...route.route_geometry],
          distance_m: route.distance_m + (prefix?.distance_m || 0),
          duration_s: route.duration_s + (prefix?.duration_s || 0)};
        data = combined; legs = combined.journey_segments; index = legElapsed = 0;
        drawRoute(); phase = resumePaused ? "paused" : "running"; last = null;
        onReplanned(combined); update(resumePaused ? "Journey paused" : "En route · Route updated");
        onStatus(resumePaused ? "Vehicle route updated · Journey paused" : "Vehicle route updated · Continuing from current position");
      } catch (error) {
        if (request !== generation) return;
        phase = "waiting"; update(error.message); onStatus("Vehicle waiting · No updated route");
      }
    }
    byId("begin-dispatch-btn").addEventListener("click", start);
    byId("journey-pause-btn").addEventListener("click", () => {
      if (!["running", "paused"].includes(phase)) return;
      audio?.unlock();
      phase = phase === "running" ? "paused" : "running"; resumePaused = phase === "paused";
      update(resumePaused ? "Journey paused" : "En route");
      onStatus(resumePaused ? "Vehicle journey paused" : "Vehicle en route");
    });
    byId("cancel-dispatch-btn").addEventListener("click", () => {
      if (!data) return;
      clear(); onCancel();
      onStatus("Dispatch cancelled · Calculate a route before dispatching again");
    });
    return {prepare, clear, replan, invalidate, active, hasMission: () => active() || phase === "completed"};
  };
})();
