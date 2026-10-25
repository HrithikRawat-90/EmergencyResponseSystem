# Project summary

Purpose: educational Dehradun emergency vehicle routing simulator. Python Flask + OSMnx/NetworkX backend; vanilla JavaScript + Leaflet frontend. No build step. Dependencies: requirements.txt. No live traffic feeds.

## Files and change locations
- app.py: Flask server; CENTER / DISTANCE_M / BOUNDS; load_or_fetch_graph; GraphML disk cache, in-memory graph/GeoJSON/node cache; GPS snapping; curved route geometry; incident registries and cost penalties; optional Gemini advisory.
- algorithms.py: BFS (fewest hops), DFS (first found path), Dijkstra and A* (weighted search). run_algorithm dispatches; get_edge_weight applies length/time/traffic/safety objectives and blocked-edge/incident penalties; calculate_route_metrics returns distance/time. Uses directed MultiDiGraph edges including parallel keys. Default search limit is None; explicit limits remain supported.
- templates/index.html: dashboard markup and most current styling inline; injects window.APP_CONFIG from Flask; Leaflet CDN. UI controls: waypoint menus, vehicle, objective, algorithm, route, animation, incidents, benchmark; working right Route/Details/Settings panels.
- static/app.js: startApp, map/sector boundary, landmarks, draggable waypoints, route requests, parent/child search animation, playback, benchmarks and hazards. Initial view/recenter fit backend bounds. Fallback bounds mirror the current sector. requestAnimationFrame plays every search connection using a shared Canvas path; bounded duration batches large traces without truncation. Then a distance-based SVG route reveal uses a soft teal halo, moving highlight and arrival ring (style.css). Pause/speed apply during both phases; replay cancels old frames and removes owned renderers. Reduced-motion preferences skip the animated reveal/flow. Request IDs reject stale route responses.
- static/style.css: additional/older styles; check inline template styles before changing appearance.
- tests.py: unittest algorithms + Flask test client, including >5,000-node traversal, routing outside the old sector, and complete 1,200-edge animation traces for all four algorithms. test_animation.cjs: Playwright/Edge browser check; Flask must run on port 5001. Requires Node + playwright (or PLAYWRIGHT_MODULE pointing to it).
- test_api.py / test_objectives.py: HTTP integration scripts requiring a running server at 127.0.0.1:5000.
- README.md: setup and feature guide. PROGRESS.md: historical work log; may describe superseded UI.

## Interaction changes (2026-10-25)
- Initial endpoints are null; menus show placeholders, markers are created only on selection, and startup never requests a route. Choose points through menus or map, then Calculate/Find Route.
- static/app.js: setWaypoint centralizes selection/dragging and invalidates old routes; resetRoute cancels playback and rejects stale route responses. Clear resets both markers/menus, route/search layers, summary, replay and replan count. Hazards remain separate.
- algorithms.py: record_search_progress snapshots actual start-to-current-node distance/time and explored count on each expansion for all four searches, preserving selected parallel-edge keys. Raw totals avoid rounding drift; JSON snapshots round to tenths. app.py exposes search_progress in visited order (including origin; same-node route has one zero snapshot).
- Animation summary uses search_progress[completed connections] during exploration, labeled Current path from start; values can increase/decrease as branches change. Final metrics/directions appear when search finishes. Tactical advisory UI and requests have been removed. Pause/Resume freezes playback and metrics in both phases; Replay resets progress. Backend computes the trace first; pause controls its visualization.
- Relevant UI: templates/index.html summary-progress, clear-route-btn, resume-playback-btn; no frontend build. Regression checks: tests.py covers per-expansion metrics and complete 1,201-snapshot API traces; test_animation.cjs covers manual startup, frozen summary, replay and clear cleanup.

## UI and incidents update (2026-10-25)
- Removed only the standalone Landmarks card and left navigation Settings button; waypoint landmark menus remain. Action deck fills the freed width. Removed tactical advisory markup/styles/client requests; legacy AI endpoint remains unused.
- Right tabs: tabpanel-right-route retains routing fields; Details shows selected coordinates/objective and final edge count/runtime/notes only after exploration; Settings controls synchronized playback speed, search visibility, blue working-area node visibility, and auto-replanning after incident changes. updateDetails refreshes on selection/reset/search completion.
- Roadblock parse error: Infinity in JSON replaced with null; closures still use _blocked_edges. add_incident validates finite in-sector coordinates, snaps to nearest road edge via ox.distance.nearest_edges, blocks all parallel keys and reverse direction, and uses UUID ids. Deleting/clearing restores baseline costs.
- Incident drawer has wrapping controls, clear selection state, placement cancellation/crosshair/status, safe text chips, and guarded CRUD error handling. Startup loads saved incidents. Replans require both endpoints and honor auto-replan; disabling it invalidates stale route visuals after incident changes.
- test_controls.cjs (TEST_BASE_URL defaults to port 5002) checks all three incident types/add/remove/clear, right tabs/settings/details, narrow incident layout, and zero advisory calls. test_animation.cjs also accepts TEST_BASE_URL; default 5001. Browser tests need CDN access for Leaflet. Both use PLAYWRIGHT_MODULE when needed.

## Graph view (2026-10-25)
- Left nav Graph toggle below Traffic switches to black road-network canvas; button becomes Real map. Waypoints, map zoom/pan, incidents and controls are shared. Switching replays the existing result in the chosen renderer (preserves pause choice), without another route request. No startup route calculation.
- static/graph-view.js: independent createGraphView canvas layer in graphPane. Lazy-loads/caches /api/graph, draws all curved roads in dim blue-gray, and colors roads incident to each expanded node using visited_coords order. Exact reverse geometry is deduplicated; distinct parallel shapes remain. Coordinate keys round to 6 decimals to match GeoJSON.
- Graph animation: Dijkstra cyan, A* purple, BFS blue, DFS pink; red start/green destination glow; explored road field stays visible while a white neon route traces by geographic distance. Own RAF clock honors pause/speed/reduced motion, live search_progress metrics, show-search setting, replay/clear, and renderer cleanup. Cached base/search canvases avoid redrawing the full network each frame; see performance/context update below for movement behavior.
- static/app.js startRoutePlayback dispatches by viewMode; original startSpiderWebAnimation function is unchanged. Real-map tile layer temporarily removed in graph mode. Graph-only presentation in templates/index.html; existing real-map route CSS untouched. Routing backend unchanged; display-only surrounding context has a separate API below.
- Reference video inspected via sampled frames: black background, dim street network, bright advancing exploration field, glowing final path. Algorithm names reflect existing supported searches; no greedy search was added.
- test_graph.cjs (TEST_BASE_URL defaults to 5003) checks graph loading/cache, selection, exploration/reveal pause, zoom, switching without API recalculation, real route effects, clear and graph map clicks. Preview images: artifacts/graph-search-preview.png and graph-route-preview.png.

## Graph performance and surrounding roads (2026-10-25)
- Graph and real-map panels are both 520 px high; graph initially matches the real-map viewport and both recenter on the same working bounds. The original 7 km × 7 km selectable sector remains a dashed rectangle. Each mode preserves its own center/zoom. Graph city label removed; only boundary/context status and OSM attribution remain.
- graph-view.js caches world coordinates at zoom zero, culls offscreen roads, batches Path2D strokes, and uses padded cached bitmaps during gestures. CSS transforms animate zoom; a coalesced RAF rebuild occurs on moveend/zoomend/resize, never every move/zoom event. Canvas dimensions reset only when size changes. Viewport profiling uses data-rebuilds/data-rebuild-ms.
- graph_context.py + GET /api/graph-context provide a display-only ~14 km × 14 km road backdrop. Data never enters road_graph, routing, snapping, incident validation, or BOUNDS. Dim outside roads surround the unchanged active sector; out-of-bounds clicks/dragging are rejected.
- Context cache: data/dehradun_context_30.3165_78.0322_7000m.geojson (~4.5 MB; 15,415 OSM ways), downloaded and verified. Separate in-memory/disk cache; lazy nonblocking fetch after core graph load; failed context downloads leave core visualization/routing working. Overpass mail.ru GET succeeded; other endpoints returned 406/429. No extra download on zoom or mode switches.
- Tests: 25 unit/API tests, including context isolation/cache/failure; test_graph.cjs checks matching panel sizes, outside-click rejection, context caching, and at most two rebuilds per zoom along with playback/selection regressions. Preview: artifacts/graph-context-preview.png. Real-map animation function remains unchanged.

## Working-area node toggle (2026-10-25)
- Settings: show-nodes-toggle, default off, independent of exploration visibility; applies in graph and real-map views. GET /api/nodes returns actual routing graph nodes inside BOUNDS, including isolated nodes and boundary points. Display-only context nodes are excluded.
- static/graph-view.js createWorkingNodesOverlay: one blue (#238bff), 2 px dot per node on a separate cached canvas in workingNodesPane (z460). Lazy-load once; on/off, mode switches, pause and route clearing do not refetch or alter routes. Uses cached world projections, viewport culling, padded bitmap zoom transforms and coalesced end-of-gesture rebuilds.
- Graph height override removed; both views inherit original 520 px styling. Initial graph framing uses the real viewport; each mode retains its subsequent pan/zoom. Surrounding dim roads remain available.
- Validation: 25 backend tests include isolated/in-bounds/outside node filtering; graph browser regression covers node toggle/cache in both modes, matching map sizes, independent route clearing, existing animation and zoom behavior. Preview: artifacts/graph-nodes-preview.png.

## Current coverage (2026-10-24)
- CENTER = (30.3165, 78.0322); DISTANCE_M = 3_500 (box half-width).
- Approx. 7 km × 7 km = 49 km²; original half-width 1,500 m => 9 km². Area factor = (3500/1500)^2 = 5.44. This is bounding-box coverage, not a promise of roads at every location.
- BOUNDS calculated by ox.utils_geo.bbox_from_point; used by frontend config and graph metadata. Real OSM drivable roads fetched by graph_from_point(..., network_type="drive", simplify=True).
- Cache path anchored to app.py: data/dehradun_drive_30.3165_78.0322_3500m.graphml. Expanded cache is now present and verified: 8,877 nodes / 21,010 edges. Filename includes center and half-width, preventing reuse of the original small graph after a coverage change. Old data/dehradun_drive.graphml retained.
- Startup preloads the graph; subsequent requests reuse memory/disk. New coverage needs network once; failed downloads log endpoint errors and APIs return 503 when no graph is available.
- To expand later: change DISTANCE_M (linear scale is square root of desired area factor), update JS fallback bounds and this summary; generate the new cache and verify real outer-sector routes.

## API map
- GET /: dashboard with APP_CONFIG (center, bounds, graph_url).
- GET /api/graph: GeoJSON streets plus metadata.
- POST /api/route: start/destination [lat, lon], algorithm, objective; snapped endpoints, route geometry, search tree, distance/time/expansion metrics. Complete search_tree_edges in expansion order and complete visited_coords; never restore the former 600-edge / 300-node presentation caps (they caused search animation to stop halfway).
- POST /api/compare: same waypoints/objective, runs four algorithms.
- GET/POST /api/incidents; DELETE /api/incidents/<id>; POST /api/incidents/clear: simulated closures, accidents, congestion; penalties rebuilt when incidents change.
- POST /api/ai/analyze-route: optional Gemini tactical advice; unavailable integration has a fallback. Never expose credentials. Existing local key state is ignored by Git.

## Run and verify
- Normal setup: Python 3.12 virtualenv; pip install -r requirements.txt; python app.py.
- Unit/API tests: python -m unittest tests.py -v. HTTP checks: python test_api.py and python test_objectives.py with server running.
- Latest validation (2026-10-25): 25 unittests passed using the expanded real cache, including outer-sector routing and 1,200-edge trace regression across all algorithms. Browser checks exercise progressive reveal, pause/resume, live speed, replay and renderer cleanup. Real Railway Station -> Clock Tower Dijkstra/time trace: 780 connections / 781 expanded nodes. Initial download attempts encountered public server errors, but the expanded cache is now available.
- Local environment found during this change: .venv launcher points to a removed Python312 installation. Bundled Codex Python 3.12 works with PYTHONPATH set to .venv/Lib/site-packages; system Python 3.15 lacks project dependencies. Recreate the venv with a working Python 3.12 installation if its launcher still fails.

## Existing limitations to consider only when relevant
- Search styling restored to the original visible blue: #0284c7 branches at 2 px / 0.65 opacity, with cyan/light-blue endpoint dots on the shared Canvas renderer. This applies only during exploration; the smooth teal winning-route reveal is retained.
- Routing estimates/traffic/safety are simulated. Snapping scans nodes linearly. Expanded searches/animations may be longer, especially DFS.
- /api/route accepts a 0.05-degree pad beyond BOUNDS; compare/incidents have separate validation. Map clicks enforce the drawn bounds.
- Gemini client is optional/external. Avoid reading key files or committing credentials.
