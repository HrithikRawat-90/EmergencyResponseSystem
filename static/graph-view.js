/* Independent, canvas-only road graph and playback. Real-map rendering lives in app.js. */
(() => {
  "use strict";
  // One cached canvas for every actual node: no thousands of interactive markers.
  window.createWorkingNodesOverlay = ({map, url}) => {
    let enabled = false, loading = null, frame = null, anchor = null;
    let points = [], generation = 0;
    const canvas = document.createElement("canvas");
    canvas.className = "working-nodes-canvas leaflet-zoom-animated";
    canvas.setAttribute("aria-label", "All working-area routing nodes shown in blue");
    const ctx = canvas.getContext("2d");
    map.createPane("workingNodesPane").style.zIndex = "460";

    function rebuild() {
      frame = null;
      if (!enabled) return;
      const size = map.getSize(), padding = size.multiplyBy(0.25);
      const width = Math.ceil(size.x * 1.5), height = Math.ceil(size.y * 1.5);
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
        canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      anchor = map.containerPointToLatLng(padding.multiplyBy(-1));
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint(padding.multiplyBy(-1)));
      const origin = map.project(anchor, map.getZoom()), scale = map.getZoomScale(map.getZoom(), 0);
      const dots = new Path2D();
      let visible = 0;
      for (const point of points) {
        const x = point.x * scale - origin.x, y = point.y * scale - origin.y;
        if (x < -3 || y < -3 || x > width + 3 || y > height + 3) continue;
        dots.moveTo(x + 2, y); dots.arc(x, y, 2, 0, 2 * Math.PI); visible++;
      }
      ctx.fillStyle = "#238bff"; ctx.fill(dots);
      canvas.dataset.nodes = String(points.length);
      canvas.dataset.visibleNodes = String(visible);
    }
    function schedule() {
      if (enabled && frame === null) frame = requestAnimationFrame(rebuild);
    }
    function animateZoom(event) {
      if (!enabled || !anchor) return;
      const origin = map.project(event.center, event.zoom).subtract(map.getSize().divideBy(2));
      const offset = map.project(anchor, event.zoom).subtract(origin);
      L.DomUtil.setTransform(canvas, map.containerPointToLayerPoint(offset), map.getZoomScale(event.zoom));
    }
    const Layer = L.Layer.extend({
      onAdd() {
        this.getPane().appendChild(canvas);
        map.on("moveend zoomend resize", schedule); map.on("zoomanim", animateZoom);
        rebuild();
      },
      onRemove() {
        map.off("moveend zoomend resize", schedule); map.off("zoomanim", animateZoom);
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null; canvas.remove();
      },
    });
    const layer = new Layer({pane: "workingNodesPane"});
    return {
      async setVisible(visible) {
        enabled = visible;
        const current = ++generation;
        if (!visible) { map.removeLayer(layer); return; }
        if (!loading) loading = fetch(url).then(async response => {
          if (!response.ok) throw new Error("Working-area nodes could not be loaded.");
          const data = await response.json();
          points = data.nodes.map(node => map.project([node.lat, node.lon], 0));
        }).catch(error => { loading = null; throw error; });
        try { await loading; }
        catch (error) { if (current === generation) throw error; return; }
        if (enabled && current === generation) layer.addTo(map);
      },
    };
  };

  window.createGraphView = ({map, url, contextUrl, workingBounds, getState, onProgress, onFound, onComplete, onStatus}) => {
    const colors = {Dijkstra: "#00c9ff", "A*": "#c481ff", BFS: "#42aeff", DFS: "#f078ce"};
    let roads = [], projected = [], adjacency = new Map(), loading = null;
    let worlds = [], surroundings = [], contextLoading = null;
    let rebuildFrame = null, anchor = null, padding = L.point(0, 0);
    let rebuildCount = 0;
    const sector = L.latLngBounds(workingBounds);
    let enabled = false, result = null, expanded = 0, routeProgress = 0;
    let timer = null, lastTime = null, searchElapsed = 0, routeElapsed = 0;
    let phase = "idle", routePoints = [], routeLengths = [], routeLength = 0;
    let width = 0, height = 0;
    const painted = new Set();
    const canvas = document.createElement("canvas");
    const base = document.createElement("canvas");
    const search = document.createElement("canvas");
    canvas.className = "graph-canvas leaflet-zoom-animated";
    canvas.setAttribute("aria-label", "Road network graph with animated algorithm exploration");
    const ctx = canvas.getContext("2d"), baseCtx = base.getContext("2d"), searchCtx = search.getContext("2d");
    const key = coord => `${Number(coord[0]).toFixed(6)},${Number(coord[1]).toFixed(6)}`;
    const tint = () => colors[result?.algorithm] || "#00c9ff";
    const badge = document.getElementById("graph-view-status");

    // Keep geographic positions and real road curves; there is no force-layout distortion.
    const Layer = L.Layer.extend({
      onAdd() {
        this.getPane().appendChild(canvas);
        map.on("moveend zoomend resize", scheduleRebuild);
        map.on("zoomanim", animateZoom);
        rebuild();
      },
      onRemove() {
        map.off("moveend zoomend resize", scheduleRebuild);
        map.off("zoomanim", animateZoom);
        if (rebuildFrame !== null) cancelAnimationFrame(rebuildFrame);
        rebuildFrame = null;
        canvas.remove();
      },
    });
    map.createPane("graphPane").style.zIndex = "450";
    const layer = new Layer({pane: "graphPane"});

    function stroke(context, points) {
      if (!points?.length) return;
      context.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) context.lineTo(points[i].x, points[i].y);
    }

    // Project once at zoom zero. Zoom/pan use a cached bitmap until movement ends.
    function worldRoad(coords) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const points = new Float64Array(coords.length * 2);
      coords.forEach((coord, i) => {
        const p = map.project(coord, 0); points[i * 2] = p.x; points[i * 2 + 1] = p.y;
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      });
      return {points, minX, minY, maxX, maxY};
    }

    function scheduleRebuild() {
      if (!enabled || rebuildFrame !== null) return;
      rebuildFrame = requestAnimationFrame(() => { rebuildFrame = null; rebuild(); });
    }

    function animateZoom(event) {
      if (!enabled || !anchor) return;
      const scale = map.getZoomScale(event.zoom);
      const newOrigin = map.project(event.center, event.zoom).subtract(map.getSize().divideBy(2));
      const topLeft = map.project(anchor, event.zoom).subtract(newOrigin);
      L.DomUtil.setTransform(canvas, map.containerPointToLayerPoint(topLeft), scale);
    }

    function rebuild() {
      if (!enabled) return;
      const started = performance.now();
      const size = map.getSize(); padding = size.multiplyBy(0.25);
      width = Math.ceil(size.x + 2 * padding.x); height = Math.ceil(size.y + 2 * padding.y);
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      for (const surface of [canvas, base, search]) {
        // Resizing destroys the bitmap: do it only when the viewport actually changes.
        if (surface.width !== Math.round(width * ratio) || surface.height !== Math.round(height * ratio)) {
          surface.width = Math.round(width * ratio); surface.height = Math.round(height * ratio);
          surface.style.width = `${width}px`; surface.style.height = `${height}px`;
        }
        surface.getContext("2d").setTransform(ratio, 0, 0, ratio, 0, 0);
      }
      anchor = map.containerPointToLatLng(padding.multiplyBy(-1));
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint(padding.multiplyBy(-1)));
      const scale = map.getZoomScale(map.getZoom(), 0);
      const origin = map.project(anchor, map.getZoom());
      const viewport = {minX: origin.x / scale, minY: origin.y / scale,
        maxX: (origin.x + width) / scale, maxY: (origin.y + height) / scale};
      function projectRoad(road) {
        if (road.maxX < viewport.minX || road.minX > viewport.maxX || road.maxY < viewport.minY || road.minY > viewport.maxY) return null;
        const path = new Path2D();
        for (let i = 0; i < road.points.length; i += 2) {
          const x = road.points[i] * scale - origin.x, y = road.points[i + 1] * scale - origin.y;
          if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
        }
        return path;
      }
      baseCtx.fillStyle = "#030609"; baseCtx.fillRect(0, 0, width, height);
      const backgroundPath = new Path2D();
      for (const road of surroundings) { const path = projectRoad(road); if (path) backgroundPath.addPath(path); }
      baseCtx.strokeStyle = "#182536"; baseCtx.lineWidth = 0.7; baseCtx.stroke(backgroundPath);
      projected = worlds.map(projectRoad);
      const activePath = new Path2D();
      for (const road of projected) if (road) activePath.addPath(road);
      baseCtx.strokeStyle = "#293a50"; baseCtx.lineWidth = 0.8; baseCtx.stroke(activePath);
      const nw = map.latLngToContainerPoint(sector.getNorthWest()).add(padding);
      const se = map.latLngToContainerPoint(sector.getSouthEast()).add(padding);
      baseCtx.strokeStyle = "#548b91"; baseCtx.lineWidth = 1; baseCtx.setLineDash([5, 7]);
      baseCtx.strokeRect(nw.x, nw.y, se.x - nw.x, se.y - nw.y); baseCtx.setLineDash([]);
      searchCtx.clearRect(0, 0, width, height);
      painted.clear(); paintExpansions(0, expanded); draw();
      canvas.dataset.rebuilds = String(++rebuildCount);
      canvas.dataset.rebuildMs = (performance.now() - started).toFixed(1);
    }

    function paintExpansions(from, to) {
      if (!result) return;
      searchCtx.strokeStyle = tint(); searchCtx.lineWidth = 1.25; searchCtx.lineJoin = "round";
      const path = new Path2D();
      const visited = result.visited_coords || [];
      for (let i = from; i < to; i++) {
        for (const index of adjacency.get(key(visited[i])) || []) {
          if (painted.has(index)) continue;
          painted.add(index); if (projected[index]) path.addPath(projected[index]);
        }
      }
      searchCtx.stroke(path);
      canvas.dataset.expanded = String(to);
    }

    function draw() {
      if (!enabled) return;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(base, 0, 0, width, height);
      if (getState().showSearch) ctx.drawImage(search, 0, 0, width, height);
      ctx.save();
      const origin = map.project(anchor, map.getZoom());
      const graphPoint = coord => map.project(coord, map.getZoom()).subtract(origin);
      // Incidents use the same geometry and positions as the real map.
      for (const incident of getState().activeIncidents) {
        ctx.strokeStyle = incident.type === "roadblock" ? "#ff655e" : "#ffbe55";
        ctx.lineWidth = 3; ctx.beginPath();
        stroke(ctx, incident.coordinates.map(graphPoint)); ctx.stroke();
      }
      if (result && routeProgress > 0 && routePoints.length) {
        const target = routeLength * routeProgress;
        const visible = [routePoints[0]];
        for (let i = 1; i < routePoints.length; i++) {
          if (routeLengths[i] <= target) visible.push(routePoints[i]);
          else {
            const span = routeLengths[i] - routeLengths[i - 1];
            const fraction = span ? (target - routeLengths[i - 1]) / span : 1;
            visible.push([routePoints[i - 1][0] + (routePoints[i][0] - routePoints[i - 1][0]) * fraction,
              routePoints[i - 1][1] + (routePoints[i][1] - routePoints[i - 1][1]) * fraction]);
            break;
          }
        }
        const points = visible.map(graphPoint);
        ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.shadowColor = tint(); ctx.shadowBlur = 16;
        ctx.strokeStyle = tint(); ctx.lineWidth = 5; ctx.beginPath(); stroke(ctx, points); ctx.stroke();
        ctx.shadowBlur = 0; ctx.strokeStyle = "#eeffff"; ctx.lineWidth = 2;
        ctx.beginPath(); stroke(ctx, points); ctx.stroke();
      }
      const visited = result?.visited_coords || [];
      if (getState().showSearch && phase === "search" && expanded && visited[expanded - 1]) {
        const point = graphPoint(visited[expanded - 1]);
        ctx.fillStyle = "#d9faff"; ctx.shadowColor = tint(); ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.arc(point.x, point.y, 3, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
      }
      ctx.restore();
      canvas.dataset.phase = phase;
      canvas.dataset.routeProgress = String(routeProgress);
    }

    async function load() {
      if (loading) return loading;
      badge.textContent = "Loading road graph…";
      loading = fetch(url).then(async response => {
        if (!response.ok) throw new Error("Road graph unavailable. Toggle back and retry.");
        const data = await response.json();
        // Opposite directions share a base stroke; adjacency retains both endpoints.
        const seen = new Set();
        for (const feature of data.features) {
          const coords = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
          if (coords.length < 2) continue;
          const first = key(coords[0]), last = key(coords[coords.length - 1]);
          const forward = coords.map(key).join("|");
          const reverse = coords.slice().reverse().map(key).join("|");
          const identity = forward < reverse ? forward : reverse;
          if (seen.has(identity)) continue;
          seen.add(identity);
          const index = roads.push(coords) - 1;
          for (const endpoint of new Set([first, last])) {
            if (!adjacency.has(endpoint)) adjacency.set(endpoint, []);
            adjacency.get(endpoint).push(index);
          }
        }
        worlds = roads.map(worldRoad);
        canvas.dataset.roads = String(roads.length);
        badge.textContent = `${data.meta.node_count.toLocaleString()} nodes · ${data.meta.edge_count.toLocaleString()} edges`;
        scheduleRebuild();
        loadContext();
      }).catch(error => {
        loading = null; badge.textContent = error.message; throw error;
      });
      return loading;
    }

    function loadContext() {
      if (!contextUrl || contextLoading) return;
      contextLoading = fetch(contextUrl).then(async response => {
        if (!response.ok) throw new Error("Surrounding roads unavailable; working sector is still ready.");
        const data = await response.json();
        surroundings = data.features.map(feature => worldRoad(feature.geometry.coordinates.map(([lon, lat]) => [lat, lon])));
        canvas.dataset.contextRoads = String(surroundings.length);
        badge.textContent = "Dashed boundary: working sector · Outside roads are display only";
        scheduleRebuild();
      }).catch(error => { contextLoading = null; badge.textContent = error.message; });
    }

    function clearPlayback() {
      if (timer !== null) cancelAnimationFrame(timer);
      timer = null; result = null; expanded = 0; routeProgress = 0;
      phase = "idle"; painted.clear();
      searchCtx.clearRect(0, 0, width, height);
      canvas.dataset.expanded = "0";
      draw();
    }

    function play(data) {
      clearPlayback(); result = data; phase = "search";
      const legend = document.querySelector(".graph-key.explored");
      legend.style.background = tint(); legend.style.boxShadow = `0 0 6px ${tint()}`;
      lastTime = null; searchElapsed = 0; routeElapsed = 0;
      routePoints = data.route_geometry || []; routeLengths = [0];
      for (let i = 1; i < routePoints.length; i++) routeLengths.push(routeLengths[i - 1] + map.distance(routePoints[i - 1], routePoints[i]));
      routeLength = routeLengths[routeLengths.length - 1] || 0;
      const visited = data.visited_coords || [];
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const duration = reduced ? 0 : Math.min(16000, Math.max(2400, visited.length * 10));
      function frame(now) {
        const delta = lastTime === null ? 0 : Math.min(now - lastTime, 80); lastTime = now;
        if (!getState().animationPaused) {
          const elapsed = delta * getState().animSpeed;
          if (phase === "search") {
            searchElapsed += elapsed;
            const fraction = duration ? Math.min(searchElapsed / duration, 1) : 1;
            const next = Math.floor(visited.length * fraction);
            paintExpansions(expanded, next); expanded = next;
            const snapshot = data.search_progress?.[expanded - 1] || {distance_m: 0, duration_s: 0, nodes_expanded: 0};
            onProgress(snapshot, data.algorithm, "Graph exploration · Current path from start");
            onStatus(`${data.algorithm} · Exploring ${expanded.toLocaleString()} / ${visited.length.toLocaleString()} nodes`);
            if (fraction === 1) { phase = "route"; onFound(data); }
          } else {
            routeElapsed += elapsed;
            routeProgress = reduced ? 1 : Math.min(routeElapsed / 2200, 1);
            onStatus(`${data.algorithm} · Graph route found · Tracing path`);
            if (routeProgress === 1) {
              phase = "complete"; draw(); timer = null;
              onStatus(`Route Active · ${(data.distance_m / 1000).toFixed(2)} km (${data.algorithm})`);
              onComplete(data);
              return;
            }
          }
          draw();
        }
        timer = requestAnimationFrame(frame);
      }
      timer = requestAnimationFrame(frame);
    }

    return {
      async setVisible(visible) {
        enabled = visible;
        if (visible) { layer.addTo(map); await load(); loadContext(); }
        else { clearPlayback(); map.removeLayer(layer); }
      },
      play, clearPlayback, redraw: draw,
    };
  };
})();
