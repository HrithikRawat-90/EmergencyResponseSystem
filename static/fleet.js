/* Shared server fleet: independent agents, central priority/ETA assignment, shared hazards. */
(() => {
  "use strict";
  window.createFleetDashboard = ({map, getSelection, onWorld, onError, onPositionMode, audio}) => {
    const byId = id => document.getElementById(id);
    const colors = {ambulance: "#1baf96", fire: "#ed913f", police: "#438bfa"};
    const layers = new Map(), cards = new Map(), rows = new Map();
    let renderer = null, latest = null, polling = false, disposed = false, initial = true, lastEvent = -1, lastSnapshot = -1, trafficDraft = false;
    let animation = null;
    let instance = null;
    let placement = null, placing = false;
    let suppressMapClickUntil = 0;
    function cancelPlacement() {
      placement = null;
      byId("fleet-placement").hidden = true;
      map.getContainer().style.cursor = "";
    }
    function beginPlacement(mode) {
      onPositionMode?.();
      placement = mode;
      byId("fleet-placement").hidden = false;
      const message = mode.id ? "Click the map to move this vehicle." : `Click the map to add a ${mode.type} vehicle.`;
      byId("fleet-placement-status").textContent = message;
      map.getContainer().style.cursor = "crosshair";
      map.getContainer().scrollIntoView({behavior: "smooth", block: "center"});
      onError(message);
    }
    function handleMapClick(point) {
      // Leaflet can emit a click after dragend when dragging is disabled while
      // saving. Consume that release click before waypoint/hazard handlers run.
      if (performance.now() < suppressMapClickUntil || [...layers.values()].some(owned => owned.dragging)) return true;
      if (!placement) return false;
      if (placing) return true;
      const mode = placement;
      placing = true;
      byId("fleet-show-map").checked = true;
      call(mode.id ? `/api/fleet/units/${mode.id}` : "/api/fleet/units",
        {unit_type: mode.type, position: [point.lat, point.lng]}, mode.id ? "PATCH" : "POST")
        .then(() => { if (placement === mode) cancelPlacement(); })
        .catch(error => onError(error.message)).finally(() => {placing = false;});
      return true;
    }
    const retiredInstances = new Set();
    const pollInterval = 750;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const phaseLabels = {idle: "Available", enroute: "En route", paused: "Paused", waiting: "Waiting for a route"};
    map.createPane("fleetRoutePane").style.zIndex = "475";
    function element(tag, className, text) {
      const el = document.createElement(tag);
      if (className) el.className = className;
      if (text !== undefined) el.textContent = text;
      return el;
    }
    function positionAt(trace, time) {
      let low = 0, high = trace.length - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (trace[middle].time_s <= time) low = middle; else high = middle - 1;
      }
      const a = trace[low], b = trace[Math.min(low + 1, trace.length - 1)];
      const span = b.time_s - a.time_s;
      const t = span ? Math.max(0, Math.min(1, (time - a.time_s) / span)) : 1;
      return [a.position[0] + (b.position[0] - a.position[0]) * t,
        a.position[1] + (b.position[1] - a.position[1]) * t];
    }
    function animate(now) {
      animation = null;
      if (disposed) return;
      let moving = false;
      for (const owned of layers.values()) {
        if (!owned.motion) continue;
        const motion = owned.motion;
        const fraction = Math.max(0, Math.min(1, (now - motion.started) / motion.duration));
        owned.displayTime = motion.from + (motion.to - motion.from) * fraction;
        window.vehicleIcons.setPosition(owned.marker, positionAt(motion.trace, owned.displayTime));
        owned.marker.getElement().dataset.position = JSON.stringify(owned.marker.getLatLng());
        if (fraction === 1) owned.motion = null; else moving = true;
        owned.marker.getElement().dataset.animating = String(owned.motion !== null);
      }
      if (moving) animation = requestAnimationFrame(animate);
    }
    function updatePosition(owned, unit, running, force) {
      // Polls may update mission state during a drag, but must not move the marker
      // out from under the pointer or undo a drop before its PATCH completes.
      if (owned.dragging || owned.saving) return;
      const trace = unit.motion_trace || [];
      const sameMission = owned.requestId === unit.request_id || (!unit.request_id && unit.message.startsWith("Arrived"));
      const canAnimate = !force && !reducedMotion && running && sameMission && trace.length > 1
        && (unit.phase === "enroute" || unit.message.startsWith("Arrived"))
        && owned.displayTime >= trace[0].time_s && unit.elapsed_s > owned.displayTime;
      if (canAnimate) {
        if (!owned.motion || owned.motion.to < unit.elapsed_s) {
          owned.motion = {from: owned.displayTime, to: unit.elapsed_s,
            trace, started: performance.now(), duration: pollInterval};
        }
      } else {
        owned.motion = null; owned.displayTime = unit.elapsed_s;
        window.vehicleIcons.setPosition(owned.marker, unit.position);
      }
      owned.requestId = unit.request_id;
      const element = owned.marker.getElement();
      element.dataset.phase = unit.phase;
      element.dataset.running = String(running);
      element.dataset.animating = String(owned.motion !== null);
      element.setAttribute("aria-label", `${unit.label}: ${phaseLabels[unit.phase] || unit.phase}`);
      element.dataset.position = JSON.stringify(owned.marker.getLatLng());
      owned.marker.setOpacity(unit.phase === "idle" ? 0.6 : 1);
      if (owned.motion && animation === null) animation = requestAnimationFrame(animate);
    }
    function mapLayers(units, force = false) {
      const show = byId("fleet-show-map").checked;
      const ids = new Set(units.map(unit => unit.id));
      for (const [id, owned] of layers) if (!ids.has(id)) {
        map.removeLayer(owned.marker); if (owned.route) map.removeLayer(owned.route); layers.delete(id);
      }
      for (const unit of units) {
        let owned = layers.get(unit.id);
        if (!show) {
          if (owned) { map.removeLayer(owned.marker); if (owned.route) map.removeLayer(owned.route); layers.delete(unit.id); }
          continue;
        }
        if (!owned) {
          const icon = L.divIcon({className: "fleet-vehicle", iconSize: [44, 56], iconAnchor: [22, 28],
            html: window.vehicleIcons.html(unit.type, unit.label, colors[unit.type])});
          const marker = L.marker(unit.position, {icon, zIndexOffset: 300, draggable: !unit.request_id,
            autoPan: true, bubblingMouseEvents: false, riseOnHover: true}).addTo(map);
          marker.bindTooltip(unit.label);
          owned = {marker, route: null, requestId: unit.request_id, displayTime: unit.elapsed_s,
            motion: null, dragging: false, saving: false}; layers.set(unit.id, owned);
          const resource = owned;
          marker.on("dragstart", () => {
            cancelPlacement(); onPositionMode?.();
            resource.dragging = true; resource.motion = null;
            marker.closeTooltip();
            marker.getElement().dataset.animating = "false";
          });
          marker.on("dragend", async () => {
            suppressMapClickUntil = performance.now() + 300;
            resource.dragging = false; resource.saving = true;
            marker.dragging.disable();
            const point = marker.getLatLng();
            try {
              await call(`/api/fleet/units/${unit.id}`, {position: [point.lat, point.lng]}, "PATCH");
            } catch (error) {
              onError(error.message);
            } finally {
              resource.saving = false;
              // Use the latest authoritative state for snapping or rejection,
              // including a mission assigned by another viewer during the drag.
              if (layers.get(unit.id) === resource && latest) {
                const current = latest.fleet.units.find(item => item.id === unit.id);
                if (current) updatePosition(resource, current, latest.fleet.running, true);
                mapLayers(latest.fleet.units);
              }
            }
          });
        }
        updatePosition(owned, unit, latest.fleet.running, force);
        owned.marker.getElement().dataset.unitId = unit.id;
        if (!owned.dragging) {
          const draggable = !unit.request_id && !owned.saving;
          if (draggable) owned.marker.dragging.enable(); else owned.marker.dragging.disable();
          owned.marker.getElement().dataset.draggable = String(draggable);
          owned.marker.getElement().title = draggable ? `${unit.label}: drag to move` : `${unit.label}: finish or cancel the mission to move`;
        }
        if (unit.route_geometry.length) {
          if (!renderer) renderer = L.svg({pane: "fleetRoutePane"});
          if (!owned.route) owned.route = L.polyline([], {pane: "fleetRoutePane", renderer,
            color: colors[unit.type], weight: 3, opacity: 0.8, interactive: false,
            dashArray: unit.id === "ambulance-2" ? "7 6" : null, className: "fleet-route"}).addTo(map);
          owned.route.setLatLngs(unit.route_geometry);
          owned.route.setStyle({opacity: unit.phase === "waiting" ? 0.35 : 0.8});
        } else if (owned.route) { map.removeLayer(owned.route); owned.route = null; }
      }
      if (!show && renderer) { map.removeLayer(renderer); renderer = null; }
      if (!show && animation !== null) { cancelAnimationFrame(animation); animation = null; }
    }
    function render(data) {
      const fleet = data.fleet;
      if (fleet.instance_id && fleet.instance_id !== instance) {
        if (retiredInstances.has(fleet.instance_id)) return;
        if (instance) {
          retiredInstances.add(instance);
          if (animation !== null) cancelAnimationFrame(animation);
          animation = null;
          for (const owned of layers.values()) {
            map.removeLayer(owned.marker); if (owned.route) map.removeLayer(owned.route);
          }
          layers.clear();
          if (renderer) { map.removeLayer(renderer); renderer = null; }
        }
        instance = fleet.instance_id; lastSnapshot = -1; lastEvent = -1;
      }
      if (fleet.sequence <= lastSnapshot) return;
      lastSnapshot = fleet.sequence;
      latest = data;
      audio?.setVehicles("fleet", fleet.running ? fleet.units.filter(unit => unit.request_id && unit.phase === "enroute") : []);
      if (initial) { if (fleet.running) byId("fleet-show-map").checked = true; initial = false; }
      byId("fleet-panel").dataset.running = String(fleet.running);
      byId("fleet-panel").dataset.instanceId = instance || "";
      byId("fleet-status").textContent = `${fleet.running ? "Running" : "Paused"} · ${fleet.units.filter(u => u.request_id).length} assigned · ${fleet.requests.filter(r => r.status === "queued").length} queued`;
      byId("fleet-speed").value = String(fleet.speed);
      byId("fleet-count").textContent = `${fleet.units.length} vehicles · ${fleet.units.filter(u => u.type === "ambulance").length} ambulances · ${fleet.units.filter(u => u.type === "fire").length} fire · ${fleet.units.filter(u => u.type === "police").length} police`;
      const unitIds = new Set(fleet.units.map(unit => unit.id));
      for (const [id, card] of cards) if (!unitIds.has(id)) {card.remove(); cards.delete(id);}
      if (placement?.id && !unitIds.has(placement.id)) cancelPlacement();
      for (const unit of fleet.units) {
        let card = cards.get(unit.id);
        if (!card) {
          card = element("article", "fleet-unit"); card.dataset.unitId = unit.id;
          card.append(element("strong", "fleet-unit-label", unit.label), element("span", "fleet-unit-phase"),
            element("p", "fleet-unit-detail"), element("p", "fleet-unit-metrics"));
          const actions = element("div", "fleet-unit-actions");
          for (const action of ["pause", "resume", "cancel", "move", "remove"]) {
            const button = element("button", "btn-outline-subtle", action === "resume" ? "Resume / retry" : action);
            button.type = "button"; button.dataset.action = action; button.dataset.unitId = unit.id; actions.append(button);
          }
          card.append(actions); cards.set(unit.id, card); byId("fleet-units").append(card);
        }
        card.dataset.phase = unit.phase;
        card.querySelector(".fleet-unit-phase").textContent = `${phaseLabels[unit.phase] || unit.phase}${!fleet.running && unit.request_id ? " · fleet paused" : ""}`;
        card.querySelector(".fleet-unit-detail").textContent = unit.message;
        card.querySelector(".fleet-unit-metrics").textContent = unit.request_id
          ? `${unit.request_id} · ${(unit.remaining_m / 1000).toFixed(2)} km left · ETA ${(unit.remaining_s / 60).toFixed(1)} min · ${unit.replans} replans`
          : `${unit.position[0].toFixed(4)}, ${unit.position[1].toFixed(4)}`;
        for (const button of card.querySelectorAll("button")) {
          if (["move", "remove"].includes(button.dataset.action)) {
            button.disabled = Boolean(unit.request_id);
            button.title = unit.request_id ? "Finish or cancel this mission before editing the vehicle." : "";
            continue;
          }
          button.disabled = !unit.request_id || (button.dataset.action === "pause" ? unit.phase === "paused" :
            button.dataset.action === "resume" ? !["paused", "waiting"].includes(unit.phase) : false);
        }
      }
      const ids = new Set();
      for (const job of fleet.requests) {
        ids.add(job.id);
        let row = rows.get(job.id);
        if (!row) {
          row = element("tr"); row.dataset.requestId = job.id;
          for (let i = 0; i < 6; i++) row.append(element("td"));
          const button = element("button", "btn-outline-subtle", "Cancel"); button.type = "button"; button.dataset.requestId = job.id;
          row.children[5].append(button); rows.set(job.id, row);
        }
        const values = [job.id, job.priority, job.unit_type, `${job.status}${job.unit_id ? ` · ${job.unit_id}` : ""}`, `${job.wait_s.toFixed(1)} s`];
        values.forEach((value, index) => { row.children[index].textContent = value; });
        row.title = job.message; row.dataset.status = job.status;
        row.children[5].firstChild.disabled = !["queued", "assigned"].includes(job.status);
        byId("fleet-requests").append(row); // Keep priority/FIFO order as assignment changes.
      }
      for (const [id, row] of rows) if (!ids.has(id)) {row.remove(); rows.delete(id);}
      byId("fleet-empty").hidden = fleet.requests.length > 0;
      const eventId = fleet.events.at(-1)?.id || 0;
      if (lastEvent !== eventId) {
        lastEvent = eventId;
        byId("fleet-events").replaceChildren(...fleet.events.slice(-6).reverse().map(event => element("li", "", event.message)));
      }
      byId("auto-traffic-status").textContent = `${fleet.traffic.running ? "Running" : "Paused"} · ${fleet.traffic.ticks} traffic updates · seed ${fleet.traffic.seed}`;
      byId("traffic-seed").disabled = fleet.traffic.ticks > 0;
      if (!trafficDraft) byId("traffic-seed").value = String(fleet.traffic.seed);
      if (!trafficDraft) byId("traffic-interval").value = String(fleet.traffic.interval_s);
      mapLayers(fleet.units); onWorld(data);
    }
    async function call(path, payload, method = "POST") {
      const response = await fetch(path, {method, headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)});
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Simulation action failed.");
      if (path === "/api/traffic/control" && payload.action !== "pause") trafficDraft = false;
      render(data); return data;
    }
    async function refresh() {
      if (disposed || polling) return;
      polling = true;
      try {
      const response = await fetch("/api/simulation", {cache: "no-store"});
        const data = await response.json();
        if (response.ok && data.success && !disposed) render(data);
        else if (!disposed) audio?.setVehicles("fleet", []);
      } catch { audio?.setVehicles("fleet", []); byId("fleet-status").textContent = "Simulation connection unavailable"; }
      finally { polling = false; }
    }
    function action(button, operation) {
      button.addEventListener("click", async () => {
        audio?.unlock();
        button.disabled = true;
        try { await operation(); } catch (error) {onError(error.message);}
        finally {button.disabled = false;}
      });
    }
    action(byId("fleet-queue-btn"), async () => {
      const selection = getSelection();
      if (!selection.destination) throw new Error("Choose an emergency destination on the map or in the destination menu.");
      await call("/api/fleet/requests", selection);
    });
    action(byId("fleet-start-btn"), async () => {
      if (!latest?.fleet.requests.some(job => ["queued", "assigned"].includes(job.status))) {
        throw new Error("Queue an emergency destination first, then start the dispatcher. Only assigned units move.");
      }
      byId("fleet-show-map").checked = true;
      const data = await call("/api/fleet/control", {action: "start"});
      const moving = data.fleet.units.filter(unit => unit.phase === "enroute");
      if (moving.length) {
        map.fitBounds(L.latLngBounds(moving.flatMap(unit => [unit.position, unit.destination])), {padding: [45, 45], maxZoom: 15});
        map.getContainer().scrollIntoView({behavior: reducedMotion ? "instant" : "smooth", block: "center"});
      } else if (data.fleet.requests.some(job => job.status === "assigned")) {
        onError("The fleet is running. Resume paused units or clear the road closure before they can move.");
      } else if (data.fleet.requests.some(job => job.status === "queued")) {
        onError("Requests are waiting for a compatible available unit with a passable route.");
      }
      return data;
    });
    action(byId("fleet-pause-btn"), () => call("/api/fleet/control", {action: "pause"}));
    action(byId("fleet-reset-btn"), () => call("/api/fleet/control", {action: "reset"}));
    byId("fleet-speed").addEventListener("change", event => {
      call("/api/fleet/control", {action: "speed", speed: Number(event.target.value)}).catch(error => onError(error.message));
    });
    byId("fleet-show-map").addEventListener("change", () => { if (latest) mapLayers(latest.fleet.units); });
    byId("fleet-add-btn").addEventListener("click", () => beginPlacement({type: byId("fleet-add-type").value}));
    byId("fleet-placement-cancel").addEventListener("click", cancelPlacement);
    document.addEventListener("keydown", event => {if (event.key === "Escape") cancelPlacement();});
    byId("fleet-units").addEventListener("click", event => {
      const button = event.target.closest("button[data-unit-id]");
      if (!button || button.disabled) return;
      audio?.unlock();
      if (button.dataset.action === "move") {beginPlacement({id: button.dataset.unitId}); return;}
      if (button.dataset.action === "remove") {
        call(`/api/fleet/units/${button.dataset.unitId}`, undefined, "DELETE").catch(error => onError(error.message)); return;
      }
      call(`/api/fleet/units/${button.dataset.unitId}`, {action: button.dataset.action}).catch(error => onError(error.message));
    });
    byId("fleet-requests").addEventListener("click", event => {
      const button = event.target.closest("button[data-request-id]");
      if (button) call(`/api/fleet/requests/${button.dataset.requestId}`, undefined, "DELETE").catch(error => onError(error.message));
    });
    byId("traffic-seed").addEventListener("input", () => {trafficDraft = true;});
    byId("traffic-interval").addEventListener("change", () => {trafficDraft = true;});
    for (const type of ["start", "pause", "reset"]) action(byId(`auto-traffic-${type}`), () => call("/api/traffic/control",
      {action: type, interval_s: Number(byId("traffic-interval").value), seed: Number(byId("traffic-seed").value)}));
    refresh();
    const interval = setInterval(refresh, pollInterval);
    window.addEventListener("pagehide", () => {
      audio?.setVehicles("fleet", []);
      disposed = true; clearInterval(interval);
      if (animation !== null) cancelAnimationFrame(animation);
    }, {once: true});
    return {refresh, handleMapClick, cancelPlacement};
  };
})();
