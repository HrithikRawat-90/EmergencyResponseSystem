# Intelligent Emergency Response and Rescue Agent

An intelligent, interactive emergency response and rescue routing system built with **Python**, **Flask**, **OSMnx**, **NetworkX**, and **Leaflet.js**. Features graph pathfinding algorithms (BFS, DFS, Dijkstra, A*), simulated road hazards and closures with dynamic replanning, side-by-side performance benchmarking, and AI tactical dispatch analysis integrated with a multi-key Gemini rotator.

---

## Architecture and File Responsibilities

- **`app.py`**: Flask web server, persistent disk & in-memory caching of central Dehradun OSMnx road network, REST endpoints for graph data, route calculation, 4-algorithm benchmark comparison, simulated incident management, and Gemini AI tactical dispatch advice.
- **`algorithms.py`**: Core graph search algorithms (**BFS**, **DFS**, **Dijkstra**, and **A*** with admissible Haversine distance & travel-time heuristics) operating directly on NetworkX `MultiDiGraph` with directed and multi-edge preservation.
- **`tests.py`**: Complete automated test suite testing algorithm optimality, one-way enforcement, incident penalties, cache loading, and Flask API status codes.
- **`templates/index.html`**: Modern, responsive, full-screen map interface with collapsible mission control dashboard, floating legend, search order animation bar, comparison modal, and bottom metrics drawer.
- **`static/style.css`**: Curated modern dark-mode emergency response theme with glassmorphism overlays and responsive styling.
- **`static/app.js`**: Vanilla JavaScript Leaflet controller managing both Real Map & Dark Graph modes, interactive waypoint snapping, search order animations, incident placement, and live dispatch results.
- **`data/dehradun_drive_<lat>_<lon>_<distance>m.graphml`**: Cached drivable road network retrieved via OSMnx. Current sector: approximately **7 km × 7 km (49 km²)**, **5.44×** the original 3 km × 3 km area. The original `dehradun_drive.graphml` is retained but no longer loaded.

For future changes, read **`PROJECT_SUMMARY.md`** first. Coverage is controlled by `CENTER` and `DISTANCE_M` in `app.py`; the frontend receives the same bounds automatically. Changing coverage selects a new disk cache and requires an initial network download. Searches can traverse the entire graph without the former 5,000-node default cutoff.

---

## Windows Setup & Quickstart (Python 3.12)

### 1. Activate the Virtual Environment
Open PowerShell inside `E:\Projects\emergency-agent`:
```powershell
.\.venv\Scripts\Activate.ps1
```

### 2. Verify Dependencies
Dependencies in `requirements.txt`:
```powershell
pip install -r requirements.txt
```

### 3. (Optional) Configure Gemini API Keys for Tactical AI Advisor
Add free-tier Gemini API keys (one per line) to:
```text
C:\Users\Ramen\gemini_keys\api_keys.txt
```
The application connects automatically using `GeminiKeyRotator` configured for `gemini-3.5-flash` with automatic round-robin rotation, transient retry handling, and daily quota tracking.

### 4. Run the Application
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
  - **Safest Route**: Avoids narrow or unclassified alleys, prioritizes primary multi-lane corridors.

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
   - **Roadblock**: Completely blocks the road segment (`penalty = inf`).
   - **Accident**: Imposes heavy traffic delay (+350% time penalty).
   - **Traffic**: Imposes moderate delay (+200% penalty).
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

## Running the Automated Test Suite

To run all unit tests:
```powershell
.\.venv\Scripts\python.exe -m unittest tests.py
```
All 16 tests validate:
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
- REST API error handling
