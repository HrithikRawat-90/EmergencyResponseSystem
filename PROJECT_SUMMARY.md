# Project summary

Purpose: educational Dehradun emergency vehicle routing simulator. Python Flask + OSMnx/NetworkX backend; vanilla JavaScript + Leaflet frontend. No build step. Dependencies: requirements.txt. No live traffic feeds.

## Files and change locations
- app.py: Flask server; CENTER / DISTANCE_M / BOUNDS; load_or_fetch_graph; GraphML disk cache, in-memory graph/GeoJSON/node cache; GPS snapping; curved route geometry; incident registries and cost penalties; optional Gemini advisory.
- algorithms.py: BFS (fewest hops), DFS (first found path), Dijkstra and A* (weighted search). run_algorithm dispatches; get_edge_weight applies length/time/traffic/safety objectives and blocked-edge/incident penalties; calculate_route_metrics returns distance/time. Uses directed MultiDiGraph edges including parallel keys. Default search limit is None; explicit limits remain supported.
- templates/index.html: dashboard markup and most current styling inline; injects window.APP_CONFIG from Flask; Leaflet CDN. UI controls: landmarks, vehicle, objective, algorithm, route, animation, incidents, benchmark, advisory.
- static/app.js: startApp, map/sector boundary, landmarks, draggable waypoints, route requests, parent/child search animation, playback, benchmarks, hazards, advisory. Initial view/recenter fit backend bounds. Fallback bounds mirror the current sector. requestAnimationFrame plays every search connection using a shared Canvas path; bounded duration batches large traces without truncation. Then a distance-based SVG route reveal uses a soft teal halo, moving highlight and arrival ring (style.css). Pause/speed apply during both phases; replay cancels old frames and removes owned renderers. Reduced-motion preferences skip the animated reveal/flow. Request IDs reject stale route responses.
- static/style.css: additional/older styles; check inline template styles before changing appearance.
- tests.py: unittest algorithms + Flask test client, including >5,000-node traversal, routing outside the old sector, and complete 1,200-edge animation traces for all four algorithms. test_animation.cjs: Playwright/Edge browser check; Flask must run on port 5001. Requires Node + playwright (or PLAYWRIGHT_MODULE pointing to it).
- test_api.py / test_objectives.py: HTTP integration scripts requiring a running server at 127.0.0.1:5000.
- README.md: setup and feature guide. PROGRESS.md: historical work log; may describe superseded UI.

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
- Latest validation (2026-10-24): 19 unittests passed using the expanded real cache, including outer-sector routing and 1,200-edge trace regression across all algorithms. Browser checks exercise progressive reveal, pause/resume, live speed, replay and renderer cleanup. Real Railway Station -> Clock Tower Dijkstra/time trace: 780 connections / 781 expanded nodes. Initial download attempts encountered public server errors, but the expanded cache is now available.
- Local environment found during this change: .venv launcher points to a removed Python312 installation. Bundled Codex Python 3.12 works with PYTHONPATH set to .venv/Lib/site-packages; system Python 3.15 lacks project dependencies. Recreate the venv with a working Python 3.12 installation if its launcher still fails.

## Existing limitations to consider only when relevant
- Search styling restored to the original visible blue: #0284c7 branches at 2 px / 0.65 opacity, with cyan/light-blue endpoint dots on the shared Canvas renderer. This applies only during exploration; the smooth teal winning-route reveal is retained.
- Routing estimates/traffic/safety are simulated. Snapping scans nodes linearly. Expanded searches/animations may be longer, especially DFS.
- /api/route accepts a 0.05-degree pad beyond BOUNDS; compare/incidents have separate validation. Map clicks enforce the drawn bounds.
- Gemini client is optional/external. Avoid reading key files or committing credentials.
