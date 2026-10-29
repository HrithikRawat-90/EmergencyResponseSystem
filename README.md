# Intelligent Emergency Response and Rescue Agent

An intelligent, interactive emergency response and rescue routing system built with **Python**, **Flask**, **OSMnx**, **NetworkX**, and **Leaflet.js**. Features graph pathfinding algorithms (BFS, DFS, Dijkstra, A*), simulated road hazards and closures with dynamic replanning, side-by-side performance benchmarking, vehicle dispatch simulation, a priority-based multi-agent fleet, and a seeded dynamic traffic environment.

---

## Architecture and File Responsibilities

- **`app.py`**: Flask web server, persistent disk & in-memory caching of central Dehradun OSMnx road network, REST endpoints for graph data, route calculation, 4-algorithm benchmark comparison, simulated incident management, fleet scheduling, and the shared traffic environment.
- **`algorithms.py`**: Core graph search algorithms (**BFS**, **DFS**, **Dijkstra**, and **A*** with admissible Haversine distance & travel-time heuristics) operating directly on NetworkX `MultiDiGraph` with directed and multi-edge preservation.
- **`simulation.py`**: Shared multi-agent fleet, priority/ETA dispatcher and automatic traffic clock.
- **`static/fleet.js`**: Fleet dashboard, markers/routes, request queue and automatic traffic controls.
- **`tests.py` / `test_simulation.py`**: Complete automated test suite testing algorithm optimality, one-way enforcement, incident penalties, cache loading, and Flask API status codes.
- **`templates/index.html`**: Modern, responsive, full-screen map interface with collapsible mission control dashboard, floating legend, search order animation bar, comparison modal, and bottom metrics drawer.
- **`static/style.css`**: Curated modern dark-mode emergency response theme with glassmorphism overlays and responsive styling.
- **`static/app.js`**: Vanilla JavaScript Leaflet controller managing both Real Map & Dark Graph modes, interactive waypoint snapping, search order animations, incident placement, and live dispatch results.
- **`data/dehradun_drive_<lat>_<lon>_<distance>m.graphml`**: Cached drivable road network retrieved via OSMnx. Current sector: approximately **7 km × 7 km (49 km²)**, **5.44×** the original 3 km × 3 km area. The original `dehradun_drive.graphml` is retained but no longer loaded.

For future changes, read **`PROJECT_SUMMARY.md`** first. Coverage is controlled by `CENTER` and `DISTANCE_M` in `app.py`; the frontend receives the same bounds automatically. Changing coverage selects a new disk cache and requires an initial network download. Searches can traverse the entire graph without the former 5,000-node default cutoff.

---

## Windows Setup & Quickstart (Python 3.12)

### Validated Windows launch (2026-10-28)

This machine has a working `.venv312` environment. Start from the project folder:

```powershell
.\run.cmd
```

This explicitly uses Python 3.12, pandas 2.2.3, and NumPy 2.2.6. Bare `python app.py` currently selects the global Python 3.15 installation whose pandas binary is blocked by Windows App Control. The original `.venv` also uses 3.15 and remains untouched.

To reproduce on a machine with Python 3.12 installed:

```powershell
py -3.12 -m venv .venv312
.\.venv312\Scripts\python.exe -m pip install -r requirements-windows312.txt
.\run.cmd
```

The environment on this machine was created with the available Codex Python 3.12.14 runtime. Its `pyvenv.cfg` references that runtime; recreate the environment with your own Python 3.12 installation if the runtime is removed. No Windows application policies were changed.

### 1. Create and Activate a Virtual Environment
Open PowerShell inside your cloned project folder:
```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### 2. Verify Dependencies
Dependencies in `requirements.txt`:
```powershell
pip install -r requirements.txt
```

### 3. Run the Application
```powershell
python app.py
```
Open your browser at:
```
http://127.0.0.1:5000
```

---

## Features & Demonstration Guide

### 1. Real Map vs. Dark Graph View
- **Real Map View**: High-resolution OpenStreetMap tiles. Allows zooming out to view India or the whole world while keeping central Dehradun as the primary sector.
- **Graph View**: High-contrast dark visualization displaying exact drivable road geometry (thin white lines) on an ultra-dark background.

### 2. Waypoint Selection & Snapping
- Click anywhere in central Dehradun to set the **Start** (Green pin) and **Destination** (Red pin).
- Markers can be freely dragged; the backend automatically snaps coordinates to the nearest drivable intersection or road node.

### 3. Emergency Units & Routing Objectives
- **Emergency Units**:
  - 🚑 **Ambulance**: Medical emergency response (emerald green).
  - 🚒 **Fire Brigade**: Fire & rescue emergency (amber/orange).
  - 🚓 **Police Patrol**: Tactical law enforcement (cobalt blue).
- **Routing Objectives**:
  - **Min Distance**: Physical shortest road distance.
  - **Min Travel Time**: Fastest traversal based on OSM max speeds.
  - **Min Traffic**: Avoids dense residential lanes, favors higher highway hierarchies.
  - **Safest Route**: Minimizes simulated road-class and incident penalties; this is a risk proxy, not a verified safety rating.

### 4. Running Pathfinding Algorithms
Choose from the algorithm dropdown:
- **A* Search**: Guided by an admissible Haversine distance/time heuristic (lowest node expansions, optimal distance).
- **Dijkstra's Algorithm**: Exhaustive shortest weighted path calculation.
- **BFS (Breadth-First Search)**: Explores level by level; minimizes number of turns/edges, not physical distance.
- **DFS (Depth-First Search)**: Explores deep branches; yields non-optimal winding paths for educational contrast.

Click **Find Route** to trigger the search animation and display path statistics.

### 5. Algorithm Comparison Benchmark
Click **Benchmark 4** to launch the comparison modal. It runs BFS, DFS, Dijkstra, and A* simultaneously over the exact same waypoints, showing:
- Route found (Yes/No)
- Physical distance in meters
- Estimated travel time
- Graph nodes visited/expanded
- Execution time in milliseconds
- Path optimality status

### 5. Simulated Hazards, Closures, and Dynamic Replanning
1. Click **+ Place on Map** under *Simulated Scenarios*.
2. Select hazard type:
   - **Roadblock**: Completely blocks the road segment in both directions.
   - **Accident**: Applies a 3.5× incident multiplier to weighted costs and estimated travel time.
   - **Traffic**: Applies a 2× incident multiplier to weighted costs and estimated travel time.
3. Click on any road segment on the map to drop the hazard.
4. The system automatically recalculates the route around the hazard, demonstrating real-time dynamic rescue replanning.

---

## Dispatch a Vehicle After Finding a Route

1. Choose Ambulance, Fire Brigade, or Police, then select both waypoints and calculate the route.
2. Wait for exploration and the route reveal to finish. Click **Dispatch vehicle** in the journey panel.
3. Watch the selected unit follow the road with live distance remaining, estimated arrival, distance travelled, simulated elapsed time and progress.
4. Use **Pause journey**, **Resume journey**, **Cancel dispatch**, and the separate **Travel simulation** speed (10×, 30× or 60×). The existing animation speed controls algorithm playback.
5. Add an incident during travel. Automatic replanning keeps the vehicle position and continues via its next junction. If the road currently occupied is closed, the unit waits until the closure is removed. With automatic replanning off, use **Retry route** to continue.
6. Arrival shows **Mission completed**; the Units tab reflects the selected unit's status. Clear resets the mission and endpoints. Changing routing parameters cancels the existing plan so the next dispatch uses the correct profile.

Vehicle profiles are educational assumptions: the fire brigade is slower and incurs larger delays on local/service roads; ambulance and police profiles have different speed caps and service-road delays. Weighted routing and ETA use these profiles and simulated incidents. Minimum-distance routing still minimizes physical distance, and BFS/DFS preserve their algorithm behavior. There are no live driving/clearance guarantees. Profile constants are in `vehicle_profiles.py`.

---

## Multi-Agent Fleet and Emergency Priorities

1. Choose an emergency **Destination**, **Vehicle**, **Priority**, algorithm and objective in the existing controls. A start waypoint is not required for fleet requests: agents start at their own positions.
2. In **Multi-agent emergency fleet**, click **Queue selected destination**. Queue several emergencies before starting to demonstrate priority ordering.
3. Click **Start dispatcher**. The fleet contains two ambulances, one fire brigade and one police unit. It serves Critical, High, Medium and Low requests in that order, FIFO for ties. The available compatible unit with the lowest planned ETA is assigned. Existing missions are not interrupted by a newly queued request.
4. Agents travel concurrently and retain independent positions, routes, missions and pause/resume/cancel controls. Their markers animate along authoritative road samples between server updates. Start brings active journeys into view; available, paused and blocked units remain stationary. Global Pause fleet freezes their travel; Reset fleet cancels requests and returns units to simulated depots. Fleet speed and map visibility have their own controls. Queue at least one emergency before starting. After updating the app, restart Flask and refresh the browser to load the matching API and animation code.

Choose **New vehicle** and **Add on map**, then click inside the working sector to add an ambulance, fire brigade or police vehicle. Each available vehicle has **move** and **remove** buttons. Move selects its new starting position with a map click; positions snap to road nodes in either map view. **Cancel placement** or Escape stops picking. Assigned vehicles must finish or cancel their mission before editing (pause the fleet first if other requests are waiting). Reset fleet keeps the edited fleet configuration and returns vehicles to their chosen starting positions. Restarting the server restores the four defaults. All viewers share fleet edits; requests remain queued when no compatible vehicles exist, and retry when a suitable vehicle is added.

You can also enable **Show fleet agents and routes on map** and drag any available vehicle icon to its new position in either map view. Drops snap to road nodes; invalid drops return to the saved position. Vehicles with assigned missions cannot be dragged.
5. Shared road changes trigger independent replanning. Vehicles retain their current position and unfinished directed road. A vehicle on a closed road waits; queued requests without a passable route wait for changes. Arrival releases the unit for the next compatible emergency.
6. The request table shows priority, assignment/status and waiting time. Expand **Dispatcher event log** to explain assignment and replanning decisions.

The existing single-vehicle Dispatch vehicle workflow remains available as a separate manual demonstration. Both workflows observe the same road conditions.

## Automatic Traffic Environment

Open **Traffic** and use **Start traffic**, **Pause traffic**, or **Reset traffic**. Choose a 5, 10 or 20 second update interval and a random seed. Three simulated congestion events with changing 1.5–3× costs are generated each update. Pause freezes the current congestion; reset removes generated incidents and resets the seed sequence while preserving manually placed hazards. Reset before changing a seed after it has been used.

Traffic starts stopped. The browser polls the shared simulation every 750 ms and the server advances its clock on requests; long unobserved gaps are capped rather than replayed as a large jump. This is an interactive simulation, not an always-running traffic service. All connected viewers share the fleet and incidents. State is held in memory and resets on restart; run one application worker with threads if hosting it.

## States, Actions, Costs and Environment Classification

- **State:** vehicle position and availability; assigned destination, route and progress; queued emergencies and priorities; known road conditions; simulation time.
- **Initial state:** idle agents at simulated snapped depots, no emergency requests and stopped automatic traffic. Manual route waypoints are initially empty.
- **Actions:** queue/assign a compatible unit, traverse an adjacent directed road, wait, pause/resume, reroute, cancel, and complete a mission.
- **Transition:** road traversal changes vehicle position and time; incident events change edge costs/availability; assignment changes queue and unit states; arrival releases a unit.
- **Goal test:** a vehicle reaches its assigned snapped emergency destination.
- **Costs:** minimum distance uses physical road length only; time uses vehicle estimates and incident delays; traffic/safety use documented road-class proxies and incident penalties. Blocked edges are excluded for every objective. Dijkstra/A* optimize weighted objectives; BFS optimizes hop count and DFS returns a first path.
- **PEAS:** performance = priority order, compatible ETA, waiting/travel time, distance, completions and replans; environment = roads, units, emergency requests and incidents; actuators = movement, dispatch and rerouting; sensors = the known road graph, shared incident registry and unit positions.
- **Classification:** fully observable simulated state; sequential and dynamic; deterministic planning on each snapshot with stochastic, seed-reproducible traffic changes; cooperative multi-agent fleet with a centralized dispatcher; discrete graph states plus continuous movement interpolation. There is no live traffic feed.

These explanations are also available in the fleet panel's **AI agent model and environment classification** disclosure. The exploration animation replays a completed backend search rather than streaming a paused backend algorithm.

---

## Running the Automated Test Suite

To run all unit tests:
```powershell
.\.venv\Scripts\python.exe -m unittest tests.py test_simulation.py
```
The 41 backend tests validate:
- BFS hop minimization
- DFS deep traversal
- Dijkstra shortest path
- A* agreement with Dijkstra
- Directed one-way road adherence
- Multi-edge traversal
- Road closure rerouting and incident penalties
- Unreachable destinations
- Traffic & Safety routing objectives
- Emergency unit types (Ambulance, Fire, Police)
- REST API error handling and incident CRUD lifecycle
- Priority/FIFO and compatible-ETA dispatch, concurrent agents and independent pause
- Shared-road closure waiting, safe resume and seeded automatic traffic
- REST API validation and simulation reset behavior
