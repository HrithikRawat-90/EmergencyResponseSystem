/**
 * Intelligent Emergency Response & Rescue Agent — Minimalist Controller
 * Features:
 * - Spider-web search tree animation connecting parent-to-child nodes as algorithms expand.
 * - Smooth step animation with speed controls (0.23x, 0.5x, 1x, 1.5x, 2x).
 * - Destination highlight with automatic 1-second fade-out of search branches.
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
      bounds: [[30.303, 78.016], [30.330, 78.048]],
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
      start: L.latLng(LANDMARKS.station.lat, LANDMARKS.station.lng),
      destination: L.latLng(LANDMARKS.clock_tower.lat, LANDMARKS.clock_tower.lng),
      startLandmarkId: "station",
      destLandmarkId: "clock_tower",
      targetSetting: "start",

      // Animation State
      spiderWebLayer: null,
      activeRouteLayer: null,
      animationTimer: null,
      animationPaused: false,
      animSpeed: 1.0,
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

    const markers = {
      start: L.marker(state.start, {
        icon: createCircleIcon("start"),
        draggable: true,
        autoPan: true,
      }).addTo(map),

      destination: L.marker(state.destination, {
        icon: createCircleIcon("destination"),
        draggable: true,
        autoPan: true,
      }).addTo(map),
    };

    markers.start.on("dragend", () => {
      state.start = markers.start.getLatLng();
      state.startLandmarkId = "custom";
      byId("start-landmark-select").value = "custom";
    });

    markers.destination.on("dragend", () => {
      state.destination = markers.destination.getLatLng();
      state.destLandmarkId = "custom";
      byId("dest-landmark-select").value = "custom";
    });

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
      if (state.animationTimer) {
        clearInterval(state.animationTimer);
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

    // Calculate Route
    async function computeRoute() {
      if (!state.start || !state.destination) {
        showToast("Please choose both Start and Destination points.");
        return;
      }

      const algo = byId("algorithm-select").value;
      const objective = byId("select-objective").value;
      const vehicle = byId("select-vehicle").value;

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
        if (!data.success) {
          showToast(data.error || "No viable route found.");
          byId("ops-status-text").textContent = "No route found with current obstacles";
          clearRouteLayers();
          return;
        }

        state.latestResult = data;
        updateSummaryUI(data);
        startSpiderWebAnimation(data);
        requestAIBriefing(data);

      } catch (err) {
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

    // Smooth Spider-Web Search Tree Animation
    function startSpiderWebAnimation(data) {
      clearRouteLayers();

      const edges = data.search_tree_edges || [];
      const routeGeom = data.route_geometry || [];
      const visitedCoords = data.visited_coords || [];

      // Create LayerGroup for spider-web lines
      state.spiderWebLayer = L.layerGroup().addTo(map);

      // Determine step delay and batch size based on user-selected speed
      const speed = parseFloat(state.animSpeed) || 1.0;
      let intervalMs = 30;
      let batchSize = 1;

      if (speed <= 0.25) {
        intervalMs = 50;
        batchSize = 1; // 0.23x: extremely slow, fine detail
      } else if (speed <= 0.5) {
        intervalMs = 35;
        batchSize = 1; // 0.5x: slow
      } else if (speed <= 1.0) {
        intervalMs = 25;
        batchSize = 2; // 1x: standard
      } else if (speed <= 1.5) {
        intervalMs = 20;
        batchSize = 4; // 1.5x: fast
      } else {
        intervalMs = 15;
        batchSize = 8; // 2x: rapid
      }

      let edgeIdx = 0;
      const totalEdges = edges.length;

      // Fallback if tree_edges empty: connect visited coords sequentially
      const hasTree = totalEdges > 0;
      const totalItems = hasTree ? totalEdges : visitedCoords.length - 1;

      state.animationTimer = setInterval(() => {
        if (state.animationPaused) return;

        const limit = Math.min(edgeIdx + batchSize, totalItems);

        for (let i = edgeIdx; i < limit; i++) {
          let linePts;
          if (hasTree) {
            linePts = edges[i]; // [[p_lat, p_lon], [c_lat, c_lon]]
          } else {
            linePts = [visitedCoords[i], visitedCoords[i + 1]];
          }

          if (linePts && linePts[0] && linePts[1]) {
            // Glowing spider-web branch line
            const branch = L.polyline(linePts, {
              color: "#0284c7",
              weight: 2,
              opacity: 0.65,
              lineCap: "round",
            });
            state.spiderWebLayer.addLayer(branch);

            // Subtle explorer pulse dot at branch tip
            const pulseDot = L.circleMarker(linePts[1], {
              radius: 2,
              color: "#38bdf8",
              weight: 1,
              fillColor: "#7dd3fc",
              fillOpacity: 0.9,
            });
            state.spiderWebLayer.addLayer(pulseDot);
          }
        }

        edgeIdx = limit;

        // Search has reached destination!
        if (edgeIdx >= totalItems) {
          clearInterval(state.animationTimer);
          state.animationTimer = null;

          // 1. Immediately highlight the winning optimal route in bold
          if (routeGeom && routeGeom.length > 0) {
            const glowRoute = L.polyline(routeGeom, {
              color: "#34d399",
              weight: 9,
              opacity: 0.5,
              lineJoin: "round",
            });

            const mainRoute = L.polyline(routeGeom, {
              color: "#10b981",
              weight: 5.5,
              opacity: 0.95,
              lineJoin: "round",
            });

            state.activeRouteLayer = L.featureGroup([glowRoute, mainRoute]).addTo(map);
          }

          // 2. Exactly after 1 second (1000ms), all spider web lines disappear
          setTimeout(() => {
            if (state.spiderWebLayer) {
              map.removeLayer(state.spiderWebLayer);
              state.spiderWebLayer = null;
            }
          }, 1000);
        }
      }, intervalMs);
    }

    // AI Briefing Request
    async function requestAIBriefing(data) {
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
        content.textContent = aiData.analysis || "Tactical assessment completed.";
      } catch {
        content.textContent = "AI tactical assessment is temporarily unavailable.";
      } finally {
        spinner.hidden = true;
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

      state[kind] = L.latLng(lmark.lat, lmark.lng);
      markers[kind].setLatLng(state[kind]);

      if (kind === "start") {
        state.startLandmarkId = landmarkId;
        byId("start-landmark-select").value = landmarkId;
      } else {
        state.destLandmarkId = landmarkId;
        byId("dest-landmark-select").value = landmarkId;
      }

      map.panTo(state[kind]);
    }

    // Event Bindings
    byId("start-landmark-select").addEventListener("change", (e) => {
      if (e.target.value !== "custom") setLandmark("start", e.target.value);
    });

    byId("dest-landmark-select").addEventListener("change", (e) => {
      if (e.target.value !== "custom") setLandmark("destination", e.target.value);
    });

    document.querySelectorAll(".landmark-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        if (state.startLandmarkId === id) {
          showToast(`${btn.querySelector('.landmark-name').textContent} is already the start point.`);
          return;
        }
        setLandmark("destination", id);
        showToast(`Destination: ${btn.querySelector('.landmark-name').textContent}`);
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

    // Playback Controls
    byId("resume-playback-btn").addEventListener("click", () => {
      state.animationPaused = !state.animationPaused;
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
        showToast("Click inside central Dehradun.");
        return;
      }

      if (state.targetSetting === "start") {
        state.start = e.latlng;
        markers.start.setLatLng(e.latlng);
        state.startLandmarkId = "custom";
        byId("start-landmark-select").value = "custom";
        state.targetSetting = "destination";
        showToast("Start location placed. Now click for Destination.");
      } else {
        state.destination = e.latlng;
        markers.destination.setLatLng(e.latlng);
        state.destLandmarkId = "custom";
        byId("dest-landmark-select").value = "custom";
        state.targetSetting = "start";
        showToast("Destination location placed.");
      }
    });

    // Auto-compute route after initial load
    setTimeout(computeRoute, 350);
  }

  // DOM Ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startApp);
  } else {
    startApp();
  }
})();
