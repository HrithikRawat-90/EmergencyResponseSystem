/**
 * Intelligent Emergency Response & Rescue Agent — Minimalist Controller
 * Features:
 * - Spider-web search tree animation connecting parent-to-child nodes as algorithms expand.
 * - Smooth step animation with speed controls (0.23x, 0.5x, 1x, 1.5x, 2x).
 * - Complete search playback and distance-based route reveal with a soft teal glow.
 * - Robust map initialization with OpenStreetMap tiles and automatic resize invalidation.
 */

(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);

  function startApp() {
    if (!window.L) {
      console.warn("Leaflet library not ready yet, retrying...");
      setTimeout(startApp, 150);
      return;
    }

    const config = window.APP_CONFIG || {
      center: [30.3165, 78.0322],
      bounds: [[30.28502, 77.99574], [30.34798, 78.06866]],
    };
    const studyBounds = L.latLngBounds(config.bounds);

    // Landmark Preset Coordinates
    const LANDMARKS = {
      station:       { name: "Railway Station", lat: 30.3143, lng: 78.0334 },
      clock_tower:   { name: "Clock Tower",     lat: 30.3254, lng: 78.0419 },
      doon_hospital: { name: "Doon Hospital",   lat: 30.3189, lng: 78.0408 },
      parade_ground: { name: "Parade Ground",   lat: 30.3285, lng: 78.0482 },
    };

    const state = {
      start: null,
      destination: null,
      startLandmarkId: "",
      destLandmarkId: "",
      targetSetting: "start",

      // Animation State
      spiderWebLayer: null,
      activeRouteLayer: null,
      animationTimer: null,
      animationPaused: false,
      animSpeed: 1.0,
      routeRequestId: 0,
      latestResult: null,
      replanCount: 0,

      // Hazards
      placingIncident: false,
      incidentType: "roadblock",
      activeIncidents: [],
      incidentLayers: [],
    };

    // 1. Initialize Leaflet Map (Using reliable standard OpenStreetMap tiles)
    const map = L.map("map", {
      center: config.center,
      zoom: 14,
      minZoom: 2,
      maxZoom: 19,
      zoomControl: false,
      preferCanvas: true,
    });

    // Primary OpenStreetMap tile layer (100% reliable across all browsers & networks)
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    // Subdued Sector Boundary
    map.fitBounds(studyBounds, { padding: [30, 30] });
    L.rectangle(studyBounds, {
      color: "#1b4d44",
      weight: 1.5,
      dashArray: "4 6",
      fill: false,
      interactive: false,
    }).addTo(map);

    // Multiple invalidation calls to guarantee map dimensions render properly
    setTimeout(() => map.invalidateSize(), 100);
    setTimeout(() => map.invalidateSize(), 400);
    window.addEventListener("resize", () => map.invalidateSize());

    // Minimalist Circular Pin Icons (Matching Reference Design: Green "S" and Teal "D")
    function createCircleIcon(type) {
      const isStart = type === "start";
      const bg = isStart ? "#1b4d44" : "#1a5e52";
      const letter = isStart ? "S" : "D";
      return L.divIcon({
        className: "clean-circle-marker",
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        html: `
          <div style="
            width: 28px;
            height: 28px;
            border-radius: 50%;
            background-color: ${bg};
            border: 2px solid #ffffff;
            box-shadow: 0 2px 8px rgba(0,0,0,0.35);
            display: flex;
            align-items: center;
            justify-content: center;
            color: #ffffff;
            font-family: 'Inter', sans-serif;
            font-size: 11px;
            font-weight: 700;
          ">${letter}</div>
        `,
      });
    }

    const markers = { start: null, destination: null };

    function setWaypoint(kind, latlng, landmarkId = "custom") {
      resetRoute();
      state[kind] = latlng;
      if (!markers[kind]) {
        markers[kind] = L.marker(latlng, {
          icon: createCircleIcon(kind), draggable: true, autoPan: true,
        }).addTo(map);
        markers[kind].on("dragend", () => {
          setWaypoint(kind, markers[kind].getLatLng());
        });
      } else {
        markers[kind].setLatLng(latlng);
      }
      const isStart = kind === "start";
      state[isStart ? "startLandmarkId" : "destLandmarkId"] = landmarkId;
      byId(isStart ? "start-landmark-select" : "dest-landmark-select").value = landmarkId;
      state.targetSetting = !state.start ? "start" : !state.destination ? "destination" : (isStart ? "destination" : "start");
      byId("deck-instruction").textContent = state.start && state.destination
        ? "Waypoints ready. Calculate a route to begin exploring."
        : `Choose a ${state.start ? "destination" : "start"} on the map or from the menu.`;
    }

    // Toast Message
    function showToast(msg, duration = 3000) {
      const toast = byId("ops-toast");
      if (!toast) return;
      toast.textContent = msg;
      toast.hidden = false;
      clearTimeout(toast._timeout);
      toast._timeout = setTimeout(() => { toast.hidden = true; }, duration);
    }

    // Clear all existing animation / route layers
    function clearRouteLayers() {
      if (state.animationTimer !== null) {
        cancelAnimationFrame(state.animationTimer);
        state.animationTimer = null;
      }
      if (state.spiderWebLayer) {
        map.removeLayer(state.spiderWebLayer);
        state.spiderWebLayer = null;
      }
      if (state.activeRouteLayer) {
        map.removeLayer(state.activeRouteLayer);
        state.activeRouteLayer = null;
      }
    }

    function resetRoute() {
      ++state.routeRequestId;
      clearRouteLayers();
      state.latestResult = null;
      state.animationPaused = false;
      map.getContainer().classList.remove("playback-paused");
      byId("resume-playback-btn").textContent = "Pause";
      byId("resume-playback-btn").disabled = true;
      byId("replay-btn").disabled = true;
      ["distance", "time", "nodes", "algo"].forEach(key => {
        byId(`summary-${key}`).textContent = "—";
      });
      byId("summary-progress").textContent = "Choose points, then calculate a route.";
      byId("ops-status-text").textContent = "Ready · Select start and destination";
      byId("deck-instruction").textContent = "Choose two points, then calculate a route.";
      byId("turn-steps-list").textContent = "Route directions will appear after exploration finishes.";
      byId("tactical-briefing-box").hidden = true;
    }

    function updateLiveSummary(metrics, algorithm, message) {
      byId("summary-distance").textContent = `${(metrics.distance_m / 1000).toFixed(2)} km`;
      byId("summary-time").textContent = `${(metrics.duration_s / 60).toFixed(1)} min`;
      byId("summary-nodes").textContent = metrics.nodes_expanded.toLocaleString();
      byId("summary-algo").textContent = algorithm;
      byId("summary-replans").textContent = state.replanCount;
      byId("summary-progress").textContent = message;
    }

    // Calculate Route
    async function computeRoute() {
      if (!state.start || !state.destination) {
        showToast("Please choose both Start and Destination points.");
        return;
      }

      const algo = byId("algorithm-select").value;
      const objective = byId("select-objective").value;
      const vehicle = byId("select-vehicle").value;
      resetRoute();
      const requestId = state.routeRequestId;

      byId("ops-status-text").textContent = `Computing ${algo.toUpperCase()} route...`;

      try {
        const res = await fetch("/api/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            start: [state.start.lat, state.start.lng],
            destination: [state.destination.lat, state.destination.lng],
            algorithm: algo,
            objective: objective,
            unit_type: vehicle,
          }),
        });

        const data = await res.json();
        if (requestId !== state.routeRequestId) return;
        if (!data.success) {
          showToast(data.error || "No viable route found.");
          byId("ops-status-text").textContent = "No route found with current obstacles";
          clearRouteLayers();
          return;
        }

        state.latestResult = data;
        startSpiderWebAnimation(data);

      } catch (err) {
        if (requestId !== state.routeRequestId) return;
        showToast("Routing calculation error.");
        byId("ops-status-text").textContent = "Server connection error";
      }
    }

    // Update Metrics in UI
    function updateSummaryUI(data) {
      byId("summary-distance").textContent = `${(data.distance_m / 1000).toFixed(2)} km`;
      byId("summary-time").textContent = `${(data.duration_s / 60).toFixed(1)} min`;
      byId("summary-nodes").textContent = data.nodes_expanded.toLocaleString();
      byId("summary-replans").textContent = state.replanCount;
      byId("summary-algo").textContent = data.algorithm;

      byId("deck-instruction").textContent = `Route determined: ${(data.distance_m / 1000).toFixed(2)} km in ${(data.duration_s / 60).toFixed(1)} min via ${data.algorithm}.`;
      byId("ops-status-text").textContent = `Route Active · ${(data.distance_m / 1000).toFixed(2)} km (${data.algorithm})`;

      const stepsList = byId("turn-steps-list");
      if (stepsList) {
        let html = `<div style="font-size: 13px; display: flex; flex-direction: column; gap: 8px;">`;
        html += `<div><strong>1. Dispatch:</strong> Depart from origin point.</div>`;
        html += `<div><strong>2. Transit:</strong> Navigate primary corridor via ${data.algorithm} search.</div>`;
        html += `<div><strong>3. Maneuver:</strong> Proceed through central sector intersections.</div>`;
        html += `<div><strong>4. Arrival:</strong> Arrive at destination (${(data.distance_m / 1000).toFixed(2)} km).</div>`;
        html += `</div>`;
        stepsList.innerHTML = html;
      }
    }

    // Every returned parent/child connection is played in algorithm expansion order.
    // One canvas path holds the settled tree; SVG is reserved for the winning glow.
    function startSpiderWebAnimation(data) {
      ++state.routeRequestId;
      clearRouteLayers();
      state.animationPaused = false;
      map.getContainer().classList.remove("playback-paused");
      byId("resume-playback-btn").textContent = "Pause";
      byId("resume-playback-btn").disabled = false;
      byId("replay-btn").disabled = false;
      byId("tactical-briefing-box").hidden = true;
      byId("turn-steps-list").textContent = "Exploring roads. Directions appear when the route is found.";
      byId("deck-instruction").textContent = "Exploring roads from your selected start…";
      updateLiveSummary({distance_m: 0, duration_s: 0, nodes_expanded: 0}, data.algorithm, "Exploring · Current path from start");
      const edges = data.search_tree_edges || [];
      const route = data.route_geometry || [];
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const searchRenderer = L.canvas({ padding: 0.5 });
      const routeRenderer = L.svg({ padding: 0.5 });
      state.spiderWebLayer = L.layerGroup().addTo(map);
      state.activeRouteLayer = L.featureGroup().addTo(map);
      // Share one canvas for the blue search branches and their endpoint dots.
      const settled = L.polyline([], {
        renderer: searchRenderer, color: "#0284c7", weight: 2,
        opacity: 0.65, interactive: false, lineCap: "round",
      }).addTo(state.spiderWebLayer);
      const exploredDots = L.layerGroup().addTo(state.spiderWebLayer);
      const frontier = L.polyline([], {
        renderer: searchRenderer, color: "#0284c7", weight: 3,
        opacity: 0.95, interactive: false, lineCap: "round",
      }).addTo(state.spiderWebLayer);
      const tip = L.circleMarker(data.start.snapped, {
        renderer: searchRenderer, radius: 3.5, weight: 1,
        color: "#38bdf8", fillColor: "#7dd3fc", fillOpacity: 0.9,
        interactive: false,
      }).addTo(state.spiderWebLayer);

      const accumulated = [];
      let completed = 0;
      let searchTime = 0;
      let revealTime = 0;
      let phase = "search";
      let lastTime = null;
      let routeLayers = [];
      let head;
      // Bound playback duration, never the data: larger graphs batch ALL edges.
      const searchDuration = reducedMotion ? 0 : Math.min(16000, Math.max(1800, edges.length * 12));
      const revealDuration = reducedMotion ? 0 : 2400;
      const lengths = [0];
      for (let i = 1; i < route.length; i++) {
        lengths.push(lengths[i - 1] + map.distance(route[i - 1], route[i]));
      }
      const routeLength = lengths[lengths.length - 1] || 0;
      const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const setStatus = (text) => { byId("ops-status-text").textContent = text; };
      setStatus(`${data.algorithm} · Exploring 0 / ${edges.length.toLocaleString()} connections`);

      function beginReveal() {
        phase = "reveal";
        updateSummaryUI(data);
        byId("summary-progress").textContent = "Route found · Final distance and estimated time";
        frontier.setLatLngs([]);
        tip.setRadius(0);
        state.spiderWebLayer.removeLayer(exploredDots);
        const styles = [
          { color: "#153f43", weight: 9, opacity: 0.42, className: "route-casing" },
          { color: "#73cbbd", weight: 13, opacity: 0.34, className: "route-halo" },
          { color: "#318d84", weight: 5, opacity: 1, className: "route-core" },
          { color: "#c4eee1", weight: 1.8, opacity: 0.94, className: "route-highlight" },
        ];
        routeLayers = styles.map(style => L.polyline([], {
          ...style, renderer: routeRenderer, interactive: false,
          lineCap: "round", lineJoin: "round",
        }).addTo(state.activeRouteLayer));
        if (route.length) {
          head = L.circleMarker(route[0], {
            renderer: routeRenderer, radius: 5, color: "#e4f6ee", weight: 2,
            fillColor: "#489f91", fillOpacity: 1, className: "route-head",
            interactive: false,
          }).addTo(state.activeRouteLayer);
        }
        setStatus(`${data.algorithm} · Route found · Tracing the selected path`);
      }

      function frame(now) {
        const delta = lastTime === null ? 0 : Math.min(now - lastTime, 80);
        lastTime = now;
        if (!state.animationPaused) {
          const elapsed = delta * (parseFloat(state.animSpeed) || 1);
          if (phase === "search") {
            searchTime += elapsed;
            const progress = searchDuration ? Math.min(searchTime / searchDuration, 1) : 1;
            const position = progress * edges.length;
            const next = Math.floor(position);
            while (completed < next) {
              const branch = edges[completed++];
              accumulated.push(branch);
              L.circleMarker(branch[branch.length - 1], {
                renderer: searchRenderer, radius: 2, color: "#38bdf8",
                weight: 1, fillColor: "#7dd3fc", fillOpacity: 0.9,
                interactive: false,
              }).addTo(exploredDots);
            }
            const snapshots = data.search_progress || [];
            const snapshot = snapshots[Math.min(completed, snapshots.length - 1)];
            if (snapshot) updateLiveSummary(snapshot, data.algorithm, "Exploring · Current path from start");
            settled.setLatLngs(accumulated);
            const edge = edges[completed];
            if (edge) {
              const end = mix(edge[0], edge[edge.length - 1], position - next);
              frontier.setLatLngs([edge[0], end]);
              tip.setLatLng(end);
            }
            setStatus(`${data.algorithm} · Exploring ${completed.toLocaleString()} / ${edges.length.toLocaleString()} connections`);
            if (progress === 1) beginReveal();
          } else {
            revealTime += elapsed;
            const progress = revealDuration ? Math.min(revealTime / revealDuration, 1) : 1;
            // Gentle ease-in/out, measured by road distance rather than vertex count.
            const distance = routeLength * (progress * progress * (3 - 2 * progress));
            let index = 0;
            while (index + 1 < lengths.length && lengths[index + 1] <= distance) index++;
            const visible = route.slice(0, index + 1);
            if (index + 1 < route.length) {
              const span = lengths[index + 1] - lengths[index];
              visible.push(mix(route[index], route[index + 1], span ? (distance - lengths[index]) / span : 1));
            }
            routeLayers.forEach(layer => layer.setLatLngs(visible));
            if (head && visible.length) head.setLatLng(visible[visible.length - 1]);
            // Keep search context as the path emerges, then fade it in the same clock.
            settled.setStyle({ opacity: 0.65 * (1 - progress) });
            if (progress === 1) {
              map.removeLayer(state.spiderWebLayer);
              state.spiderWebLayer = null;
              // Release renderers explicitly on replay/replan to avoid accumulating canvases.
              map.removeLayer(searchRenderer);
              if (head) state.activeRouteLayer.removeLayer(head);
              if (route.length > 1 && !reducedMotion) {
                L.polyline(route, {
                  renderer: routeRenderer, color: "#d4f2e7", weight: 2.2,
                  opacity: 0.7, dashArray: "3 26", className: "route-flow",
                  interactive: false, lineCap: "round",
                }).addTo(state.activeRouteLayer);
              }
              if (route.length) {
                L.circleMarker(route[route.length - 1], {
                  renderer: routeRenderer, radius: 11, color: "#5ba99a", weight: 2,
                  fillOpacity: 0, className: "route-arrival", interactive: false,
                }).addTo(state.activeRouteLayer);
              }
              setStatus(`Route Active · ${(data.distance_m / 1000).toFixed(2)} km (${data.algorithm})`);
              state.animationTimer = null;
              requestAIBriefing(data);
              return;
            }
          }
        }
        state.animationTimer = requestAnimationFrame(frame);
      }
      // Renderer ownership belongs to this playback, including cancellation mid-reveal.
      state.spiderWebLayer.on("remove", () => map.removeLayer(searchRenderer));
      state.activeRouteLayer.on("remove", () => map.removeLayer(routeRenderer));
      state.animationTimer = requestAnimationFrame(frame);
    }

    // AI Briefing Request
    async function requestAIBriefing(data) {
      const requestId = state.routeRequestId;
      const box = byId("tactical-briefing-box");
      const content = byId("ai-briefing-content");
      const spinner = byId("ai-loading-spinner");

      box.hidden = false;
      content.textContent = "Analyzing route logistics and tactical priorities...";
      spinner.hidden = false;

      try {
        const res = await fetch("/api/ai/analyze-route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            algorithm: data.algorithm,
            distance_m: data.distance_m,
            duration_s: data.duration_s,
            incidents_count: state.activeIncidents.length,
            nodes_expanded: data.nodes_expanded,
            unit_type: byId("select-vehicle").value,
          }),
        });

        const aiData = await res.json();
        if (requestId !== state.routeRequestId) return;
        content.textContent = aiData.analysis || "Tactical assessment completed.";
      } catch {
        if (requestId !== state.routeRequestId) return;
        content.textContent = "AI tactical assessment is temporarily unavailable.";
      } finally {
        if (requestId === state.routeRequestId) spinner.hidden = true;
      }
    }

    // Benchmark Modal
    async function runBenchmark() {
      if (!state.start || !state.destination) {
        showToast("Set both waypoints to run benchmark.");
        return;
      }

      const objective = byId("select-objective").value;
      try {
        const res = await fetch("/api/compare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            start: [state.start.lat, state.start.lng],
            destination: [state.destination.lat, state.destination.lng],
            objective: objective,
          }),
        });

        const data = await res.json();
        if (!data.success) {
          showToast(data.error || "Benchmark failed.");
          return;
        }

        const tbody = byId("benchmark-table-body");
        tbody.innerHTML = "";

        data.comparisons.forEach((item) => {
          const tr = document.createElement("tr");
          const durMin = (item.duration_s / 60).toFixed(1);
          const optText = item.algorithm === "A*" || item.algorithm === "Dijkstra"
            ? '<span style="color: #10b981; font-weight: 600;">Optimal</span>'
            : '<span style="color: #d97706;">Sub-optimal</span>';

          tr.innerHTML = `
            <td><strong>${item.algorithm}</strong></td>
            <td>${item.found ? "✓ Route Found" : "✗ Blocked"}</td>
            <td>${item.found ? (item.distance_m / 1000).toFixed(2) + " km" : "—"}</td>
            <td>${item.found ? durMin + " min" : "—"}</td>
            <td>${item.nodes_expanded.toLocaleString()}</td>
            <td>${item.execution_time_ms} ms</td>
            <td>${optText}</td>
          `;
          tbody.appendChild(tr);
        });

        byId("compare-modal").hidden = false;
      } catch {
        showToast("Error retrieving benchmark comparison.");
      }
    }

    // Hazard Simulation
    async function placeHazard(latlng) {
      try {
        const res = await fetch("/api/incidents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lat: latlng.lat,
            lon: latlng.lng,
            type: state.incidentType,
            title: `Simulated ${state.incidentType.toUpperCase()}`,
          }),
        });

        const data = await res.json();
        if (!data.success) {
          showToast(data.error || "Could not place hazard.");
          return;
        }

        state.activeIncidents.push(data.incident);
        renderHazards();
        showToast(`Added ${state.incidentType}: ${data.incident.road_name}`);

        state.replanCount += 1;
        computeRoute();
      } catch {
        showToast("Failed to place hazard.");
      }
    }

    function renderHazards() {
      state.incidentLayers.forEach((l) => map.removeLayer(l));
      state.incidentLayers = [];

      const container = byId("hazards-list");
      if (!container) return;
      container.innerHTML = "";

      state.activeIncidents.forEach((inc) => {
        const color = inc.type === "roadblock" ? "#dc2626" : "#d97706";
        const line = L.polyline(inc.coordinates, {
          color: color,
          weight: 5,
          dashArray: "6 6",
          opacity: 0.9,
        }).addTo(map);

        line.bindPopup(`<b>${inc.title}</b><br>${inc.road_name}`);
        state.incidentLayers.push(line);

        const chip = document.createElement("div");
        chip.className = "hazard-chip";
        chip.innerHTML = `
          <span>${inc.type.toUpperCase()}: ${inc.road_name.slice(0, 16)}</span>
          <button data-id="${inc.id}" title="Remove">&times;</button>
        `;
        container.appendChild(chip);
      });
    }

    function setLandmark(kind, landmarkId) {
      const lmark = LANDMARKS[landmarkId];
      if (!lmark) return;

      setWaypoint(kind, L.latLng(lmark.lat, lmark.lng), landmarkId);

      map.panTo(state[kind]);
    }

    // Event Bindings
    byId("start-landmark-select").addEventListener("change", (e) => {
      if (LANDMARKS[e.target.value]) setLandmark("start", e.target.value);
      else state.targetSetting = "start";
    });

    byId("dest-landmark-select").addEventListener("change", (e) => {
      if (LANDMARKS[e.target.value]) setLandmark("destination", e.target.value);
      else state.targetSetting = "destination";
    });

    document.querySelectorAll(".landmark-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        if (state.startLandmarkId === id) {
          showToast(`${btn.querySelector('.landmark-name').textContent} is already the start point.`);
          return;
        }
        const kind = state.targetSetting;
        setLandmark(kind, id);
        showToast(`${kind === "start" ? "Start" : "Destination"}: ${btn.querySelector('.landmark-name').textContent}`);
      });
    });

    // Map Controls
    byId("btn-zoom-in").addEventListener("click", () => map.zoomIn());
    byId("btn-zoom-out").addEventListener("click", () => map.zoomOut());
    byId("btn-recenter").addEventListener("click", () => {
      map.fitBounds(studyBounds, { padding: [30, 30] });
    });

    // Action Buttons
    byId("calculate-route-btn").addEventListener("click", computeRoute);
    byId("dispatch-unit-btn").addEventListener("click", computeRoute);

    byId("clear-route-btn").addEventListener("click", () => {
      resetRoute();
      for (const kind of ["start", "destination"]) {
        if (markers[kind]) map.removeLayer(markers[kind]);
        markers[kind] = null;
        state[kind] = null;
      }
      state.startLandmarkId = state.destLandmarkId = "";
      byId("start-landmark-select").value = "";
      byId("dest-landmark-select").value = "";
      state.targetSetting = "start";
      state.replanCount = 0;
      byId("summary-replans").textContent = "0";
    });

    // Playback Controls
    byId("resume-playback-btn").addEventListener("click", () => {
      state.animationPaused = !state.animationPaused;
      map.getContainer().classList.toggle("playback-paused", state.animationPaused);
      byId("resume-playback-btn").textContent = state.animationPaused ? "Resume" : "Pause";
    });

    byId("replay-btn").addEventListener("click", () => {
      if (state.latestResult) {
        startSpiderWebAnimation(state.latestResult);
      }
    });

    // Speed Selector (0.23x, 0.5x, 1x, 1.5x, 2x)
    const speedSelect = byId("anim-speed-select");
    if (speedSelect) {
      speedSelect.addEventListener("change", (e) => {
        state.animSpeed = parseFloat(e.target.value) || 1.0;
        showToast(`Animation speed: ${state.animSpeed}x`);
      });
    }

    byId("benchmark-modal-btn").addEventListener("click", runBenchmark);

    // Modal Close
    const compareModal = byId("compare-modal");
    byId("close-modal-btn").addEventListener("click", () => { compareModal.hidden = true; });
    compareModal.addEventListener("click", (e) => {
      if (e.target === compareModal) compareModal.hidden = true;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") compareModal.hidden = true;
    });

    // Tabs
    const actionTabs = [
      { btn: "tab-action-route", panel: "tabpanel-route" },
      { btn: "tab-action-steps", panel: "tabpanel-steps" },
      { btn: "tab-action-units", panel: "tabpanel-units" },
    ];
    actionTabs.forEach((tab) => {
      byId(tab.btn).addEventListener("click", () => {
        actionTabs.forEach((t) => {
          byId(t.btn).classList.toggle("is-active", t.btn === tab.btn);
          byId(t.panel).hidden = t.btn !== tab.btn;
        });
      });
    });

    // Navigation Strip
    byId("nav-btn-traffic").addEventListener("click", () => {
      const panel = byId("traffic-hazard-panel");
      panel.hidden = !panel.hidden;
      byId("nav-btn-traffic").classList.toggle("is-active", !panel.hidden);
    });

    byId("nav-btn-route").addEventListener("click", () => {
      byId("nav-btn-route").classList.add("is-active");
      byId("nav-btn-traffic").classList.remove("is-active");
      byId("traffic-hazard-panel").hidden = true;
    });

    byId("nav-btn-settings").addEventListener("click", runBenchmark);
    byId("nav-btn-navigate").addEventListener("click", () => {
      map.fitBounds(studyBounds, { padding: [30, 30] });
    });

    // Hazard Controls
    document.querySelectorAll(".hazard-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".hazard-pill").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        state.incidentType = btn.dataset.type;
      });
    });

    byId("place-incident-btn").addEventListener("click", () => {
      state.placingIncident = !state.placingIncident;
      byId("place-incident-btn").textContent = state.placingIncident ? "Click Road on Map..." : "+ Place Hazard on Map";
      if (state.placingIncident) {
        showToast("Click on any road segment to drop simulated obstacle.");
      }
    });

    byId("clear-all-hazards-btn").addEventListener("click", async () => {
      await fetch("/api/incidents/clear", { method: "POST" });
      state.activeIncidents = [];
      renderHazards();
      state.replanCount = 0;
      byId("summary-replans").textContent = "0";
      computeRoute();
    });

    const hazardsList = byId("hazards-list");
    if (hazardsList) {
      hazardsList.addEventListener("click", async (e) => {
        if (e.target.tagName === "BUTTON") {
          const id = e.target.dataset.id;
          await fetch(`/api/incidents/${id}`, { method: "DELETE" });
          state.activeIncidents = state.activeIncidents.filter((i) => i.id !== id);
          renderHazards();
          computeRoute();
        }
      });
    }

    // Map Click
    map.on("click", (e) => {
      if (state.placingIncident) {
        placeHazard(e.latlng);
        state.placingIncident = false;
        byId("place-incident-btn").textContent = "+ Place Hazard on Map";
        return;
      }

      if (!studyBounds.contains(e.latlng)) {
        showToast("Click inside the Dehradun rescue sector boundary.");
        return;
      }

      if (state.targetSetting === "start") {
        setWaypoint("start", e.latlng);
        showToast("Start location placed. Now click for Destination.");
      } else {
        setWaypoint("destination", e.latlng);
        showToast("Destination location placed.");
      }
    });

    resetRoute();
  }

  // DOM Ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startApp);
  } else {
    startApp();
  }
})();
