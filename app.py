"""Milestone 1 & 2: Intelligent Emergency Response and Rescue Agent.

Features:
- Persistent disk & in-memory caching of central Dehradun OSMnx road network.
- Fast, accurate GPS-to-node snapping.
- BFS, DFS, Dijkstra, and A* routing on real MultiDiGraph.
- Objective optimization (shortest distance vs. estimated travel time).
- Simulated incident management (accidents, congestion, road closures) with state restoration.
- Real-time comparison across all 4 pathfinding algorithms.
- Gemini AI Tactical Emergency Assessment (completely internal backend integration).
"""

from datetime import datetime
import json
import math
import os
from pathlib import Path
import threading
import time
from uuid import uuid4
from typing import Any, Dict, List, Optional, Set, Tuple

from flask import Flask, Response, jsonify, render_template, request, url_for
import networkx as nx
import osmnx as ox

import algorithms
import graph_context

# Optional Gemini API Rotator integration (internal backend only, NEVER exposed in UI)
gemini_rotator = None
try:
    from gemini_client import GeminiKeyRotator

    keys_file_path = Path(r"C:\Users\Ramen\gemini_keys\api_keys.txt")
    if keys_file_path.exists():
        gemini_rotator = GeminiKeyRotator(
            keys_file=str(keys_file_path),
            default_model="gemini-3.5-flash",
        )
except Exception:
    pass

app = Flask(__name__)

CENTER = (30.3165, 78.0322)  # latitude, longitude of central Dehradun (Clock Tower area)
DISTANCE_M = 3_500  # ~7 km by 7 km box: (3500 / 1500)^2 = 5.44x the original area
CACHE_DIR = Path(__file__).resolve().parent / "data"
# Key the cache by coverage so future changes cannot silently reuse a smaller graph.
CACHE_FILE = CACHE_DIR / f"dehradun_drive_{CENTER[0]}_{CENTER[1]}_{DISTANCE_M}m.graphml"

# Calculate bounding box for geographic validation
west, south, east, north = ox.utils_geo.bbox_from_point(CENTER, dist=DISTANCE_M)
BOUNDS = [[float(south), float(west)], [float(north), float(east)]]

road_graph: Optional[nx.MultiDiGraph] = None
_graph_json: Optional[str] = None
_node_cache: List[Tuple[Any, float, float]] = []  # (node_id, lat, lon)
_download_lock = threading.Lock()

# Simulated incident state:
# _incident_registry: dict of incident_id -> { "type": ..., "edges": [(u, v, key)], "penalty": ..., ... }
# _blocked_edges: Set of (u, v, key)
# _incident_penalties: Dict of (u, v, key) -> multiplier
_incident_registry: Dict[str, Dict[str, Any]] = {}
_blocked_edges: Set[Tuple[Any, Any, Any]] = set()
_incident_penalties: Dict[Tuple[Any, Any, Any], float] = {}


def _serialize_graph(graph: nx.MultiDiGraph) -> str:
    """Preserve curved OSM road geometry for accurate Leaflet GeoJSON rendering."""
    features = []
    for u, v, key, data in graph.edges(keys=True, data=True):
        geometry = data.get("geometry")
        if geometry is not None:
            coordinates = list(geometry.coords)
        else:
            coordinates = [
                (graph.nodes[u]["x"], graph.nodes[u]["y"]),
                (graph.nodes[v]["x"], graph.nodes[v]["y"]),
            ]
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": [
                        [round(float(x), 6), round(float(y), 6)]
                        for x, y in coordinates
                    ],
                },
                "properties": {
                    "u": str(u),
                    "v": str(v),
                    "key": int(key),
                    "length_m": round(float(data.get("length", 0)), 1),
                    "name": str(data.get("name", "Unnamed road")),
                    "highway": str(data.get("highway", "road")),
                    "maxspeed": str(data.get("maxspeed", "30")),
                },
            }
        )
    return json.dumps(
        {
            "type": "FeatureCollection",
            "features": features,
            "meta": {
                "center": list(CENTER),
                "bounds": BOUNDS,
                "node_count": graph.number_of_nodes(),
                "edge_count": graph.number_of_edges(),
                "distance_m": DISTANCE_M,
            },
        },
        separators=(",", ":"),
        allow_nan=False,
    )


def load_or_fetch_graph() -> Optional[nx.MultiDiGraph]:
    """Load road network from persistent disk cache or fetch from Overpass."""
    global road_graph, _graph_json, _node_cache

    if road_graph is not None:
        return road_graph

    with _download_lock:
        if road_graph is not None:
            return road_graph

        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        if CACHE_FILE.exists():
            try:
                app.logger.info("Loading graph from disk cache: %s", CACHE_FILE)
                g = ox.load_graphml(CACHE_FILE)
                if g.number_of_nodes() > 0 and g.number_of_edges() > 0:
                    road_graph = g
                    _node_cache = [(n, float(d["y"]), float(d["x"])) for n, d in g.nodes(data=True)]
                    _graph_json = _serialize_graph(g)
                    app.logger.info("Successfully loaded cached graph: %d nodes, %d edges.", len(g.nodes), len(g.edges))
                    return road_graph
            except Exception:
                app.logger.warning("Corrupt graph cache file. Re-downloading...", exc_info=True)

        endpoints = [
            "https://overpass-api.de/api",
            "https://overpass.private.coffee/api",
            "https://overpass.kumi.systems/api",
            "https://maps.mail.ru/osm/tools/overpass/api",
        ]
        for ep in endpoints:
            try:
                ox.settings.requests_timeout = 60
                ox.settings.overpass_url = ep
                g = ox.graph_from_point(CENTER, dist=DISTANCE_M, network_type="drive", simplify=True)
                if g.number_of_edges() > 0:
                    ox.save_graphml(g, CACHE_FILE)
                    road_graph = g
                    _node_cache = [(n, float(d["y"]), float(d["x"])) for n, d in g.nodes(data=True)]
                    _graph_json = _serialize_graph(g)
                    return road_graph
            except Exception:
                app.logger.warning("Road graph download failed via %s", ep, exc_info=True)

    return None


# Preload graph on startup
load_or_fetch_graph()


def snap_coordinate_to_node(lat: float, lon: float) -> Tuple[Any, float, float, float]:
    """Find nearest graph node to given coordinates.
    
    Returns (node_id, node_lat, node_lon, distance_meters).
    """
    global _node_cache, road_graph
    if not _node_cache and road_graph:
        _node_cache = [(n, float(d["y"]), float(d["x"])) for n, d in road_graph.nodes(data=True)]

    if not _node_cache:
        raise ValueError("Graph not loaded.")

    cos_lat = math.cos(math.radians(lat))
    best_node_tuple = min(
        _node_cache,
        key=lambda item: ((item[2] - lon) * cos_lat) ** 2 + (item[1] - lat) ** 2,
    )
    node_id, n_lat, n_lon = best_node_tuple
    dist_m = algorithms.haversine_distance_m(lat, lon, n_lat, n_lon)
    return node_id, n_lat, n_lon, dist_m


def extract_route_geometry(graph: nx.MultiDiGraph, path_edges: List[Tuple[Any, Any, Any]]) -> List[List[float]]:
    """Convert edge list into continuous coordinate list [lat, lon] for Leaflet."""
    latlngs: List[List[float]] = []
    for u, v, key in path_edges:
        if not graph.has_edge(u, v, key):
            continue
        data = graph[u][v][key]
        geom = data.get("geometry")
        if geom is not None:
            coords = [[float(y), float(x)] for x, y in list(geom.coords)]
        else:
            coords = [
                [float(graph.nodes[u]["y"]), float(graph.nodes[u]["x"])],
                [float(graph.nodes[v]["y"]), float(graph.nodes[v]["x"])],
            ]
        if latlngs and coords:
            latlngs.extend(coords[1:])
        else:
            latlngs.extend(coords)
    return latlngs


def _recompute_incident_state():
    """Cleanly recompute _blocked_edges and _incident_penalties from active registry."""
    global _blocked_edges, _incident_penalties, _incident_registry
    _blocked_edges.clear()
    _incident_penalties.clear()

    for inc in _incident_registry.values():
        inc_type = inc["type"]
        edges = inc.get("edges", [])
        penalty = inc.get("penalty", 1.0)
        for edge_tuple in edges:
            if inc_type == "roadblock":
                _blocked_edges.add(edge_tuple)
            else:
                # Accumulate multiplier if multiple incidents exist on same edge
                curr = _incident_penalties.get(edge_tuple, 1.0)
                _incident_penalties[edge_tuple] = curr * penalty


app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0


@app.after_request
def add_no_cache_headers(response):
    if request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


@app.get("/")
def index():
    cache_bust = int(time.time())
    return render_template(
        "index.html",
        cache_buster=cache_bust,
        app_config={
            "center": list(CENTER),
            "bounds": BOUNDS,
            "graph_url": url_for("graph_data"),
            "graph_context_url": url_for("graph_context_data"),
        },
    )


@app.get("/api/graph")
def graph_data():
    global road_graph, _graph_json
    if _graph_json is not None:
        response = Response(_graph_json, mimetype="application/geo+json")
        response.headers["Cache-Control"] = "public, max-age=3600"
        return response

    g = load_or_fetch_graph()
    if g is not None and _graph_json is not None:
        response = Response(_graph_json, mimetype="application/geo+json")
        response.headers["Cache-Control"] = "public, max-age=3600"
        return response

    return jsonify(
        error="graph_unavailable",
        message="Could not load the road graph. Please check your network or restart the server.",
    ), 503


@app.get("/api/nodes")
def working_nodes_data():
    """Actual routing nodes inside the selectable sector, independent of playback."""
    graph = load_or_fetch_graph()
    if graph is None:
        return jsonify(error="graph_unavailable"), 503
    nodes = [
        {"id": str(node), "lat": float(data["y"]), "lon": float(data["x"])}
        for node, data in graph.nodes(data=True)
        if BOUNDS[0][0] <= float(data["y"]) <= BOUNDS[1][0]
        and BOUNDS[0][1] <= float(data["x"]) <= BOUNDS[1][1]
    ]
    response = jsonify(nodes=nodes, count=len(nodes), bounds=BOUNDS)
    response.headers["Cache-Control"] = "public, max-age=3600"
    return response


@app.get("/api/graph-context")
def graph_context_data():
    try:
        response = Response(graph_context.load_context(CENTER, BOUNDS, CACHE_DIR), mimetype="application/geo+json")
        response.headers["Cache-Control"] = "public, max-age=86400"
        return response
    except RuntimeError as exc:
        return jsonify(error="context_unavailable", message=str(exc)), 503


@app.post("/api/route")
def calculate_route():
    """Route calculation endpoint supporting BFS, DFS, Dijkstra, and A*."""
    global road_graph
    if road_graph is None:
        road_graph = load_or_fetch_graph()
        if road_graph is None:
            return jsonify(success=False, error="Graph data is not yet available."), 503

    payload = request.get_json(silent=True) or {}
    start_coords = payload.get("start")
    dest_coords = payload.get("destination")
    algorithm_name = payload.get("algorithm", "a*")
    objective = payload.get("objective", "length")

    if not start_coords or not dest_coords or len(start_coords) != 2 or len(dest_coords) != 2:
        return jsonify(success=False, error="Both start and destination [lat, lon] must be provided."), 400

    try:
        s_lat, s_lon = float(start_coords[0]), float(start_coords[1])
        d_lat, d_lon = float(dest_coords[0]), float(dest_coords[1])
    except (ValueError, TypeError):
        return jsonify(success=False, error="Invalid coordinate format."), 400

    pad = 0.05
    if not (BOUNDS[0][0] - pad <= s_lat <= BOUNDS[1][0] + pad and BOUNDS[0][1] - pad <= s_lon <= BOUNDS[1][1] + pad):
        return jsonify(
            success=False,
            error="Start coordinate is outside the central Dehradun rescue routing area.",
            bounds=BOUNDS,
        ), 400

    if not (BOUNDS[0][0] - pad <= d_lat <= BOUNDS[1][0] + pad and BOUNDS[0][1] - pad <= d_lon <= BOUNDS[1][1] + pad):
        return jsonify(
            success=False,
            error="Destination coordinate is outside the central Dehradun rescue routing area.",
            bounds=BOUNDS,
        ), 400

    s_node, s_snap_lat, s_snap_lon, s_snap_dist = snap_coordinate_to_node(s_lat, s_lon)
    d_node, d_snap_lat, d_snap_lon, d_snap_dist = snap_coordinate_to_node(d_lat, d_lon)

    try:
        result = algorithms.run_algorithm(
            graph=road_graph,
            algorithm=algorithm_name,
            start_node=s_node,
            dest_node=d_node,
            objective=objective,
            blocked_edges=_blocked_edges,
            incident_penalties=_incident_penalties,
        )
    except Exception as exc:
        return jsonify(success=False, error=f"Pathfinding algorithm error: {str(exc)}"), 500

    if not result.get("found"):
        return jsonify(
            success=False,
            error="No passable route found with current road closures. Try clearing roadblocks or selecting different points.",
            algorithm=algorithm_name,
            nodes_expanded=result.get("nodes_expanded", 0),
            execution_time_ms=result.get("execution_time_ms", 0),
            visited_coords=[
                [float(road_graph.nodes[n]["y"]), float(road_graph.nodes[n]["x"])]
                for n in result.get("visited_nodes", [])
            ],
            notes=result.get("notes", ""),
        ), 200

    path_edges = result.get("path_edges", [])
    route_latlngs = extract_route_geometry(road_graph, path_edges)

    visited_nodes = result.get("visited_nodes", [])
    visited_coords = [
        [float(road_graph.nodes[n]["y"]), float(road_graph.nodes[n]["x"])]
        for n in visited_nodes
        if n in road_graph
    ]

    tree_edges = result.get("tree_edges", [])
    search_tree_edges = []
    for u, v in tree_edges:
        if u in road_graph and v in road_graph:
            search_tree_edges.append([
                [float(road_graph.nodes[u]["y"]), float(road_graph.nodes[u]["x"])],
                [float(road_graph.nodes[v]["y"]), float(road_graph.nodes[v]["x"])],
            ])

    return jsonify(
        success=True,
        algorithm=result["algorithm"],
        objective=objective,
        start={
            "original": [s_lat, s_lon],
            "snapped": [s_snap_lat, s_snap_lon],
            "node_id": str(s_node),
            "snap_distance_m": round(s_snap_dist, 1),
        },
        destination={
            "original": [d_lat, d_lon],
            "snapped": [d_snap_lat, d_snap_lon],
            "node_id": str(d_node),
            "snap_distance_m": round(d_snap_dist, 1),
        },
        route_geometry=route_latlngs,
        search_tree_edges=search_tree_edges,
        search_progress=result.get("search_progress", [{"distance_m": 0, "duration_s": 0, "nodes_expanded": 1}]),
        distance_m=result["distance_m"],
        duration_s=result["duration_s"],
        nodes_expanded=result["nodes_expanded"],
        edges_considered=result.get("edges_considered", 0),
        execution_time_ms=result["execution_time_ms"],
        cost=result["cost"],
        visited_coords=visited_coords,
        total_visited_count=len(visited_nodes),
        notes=result.get("notes", ""),
    )


@app.post("/api/compare")
def compare_algorithms():
    """Compare BFS, DFS, Dijkstra, and A* for the same start, destination, and incident state."""
    global road_graph
    if road_graph is None:
        road_graph = load_or_fetch_graph()
        if road_graph is None:
            return jsonify(success=False, error="Graph data unavailable."), 503

    payload = request.get_json(silent=True) or {}
    start_coords = payload.get("start")
    dest_coords = payload.get("destination")
    objective = payload.get("objective", "length")

    if not start_coords or not dest_coords:
        return jsonify(success=False, error="Start and destination required."), 400

    s_node, _, _, _ = snap_coordinate_to_node(float(start_coords[0]), float(start_coords[1]))
    d_node, _, _, _ = snap_coordinate_to_node(float(dest_coords[0]), float(dest_coords[1]))

    comparisons = []
    for algo in ["a*", "dijkstra", "bfs", "dfs"]:
        res = algorithms.run_algorithm(
            graph=road_graph,
            algorithm=algo,
            start_node=s_node,
            dest_node=d_node,
            objective=objective,
            blocked_edges=_blocked_edges,
            incident_penalties=_incident_penalties,
        )
        comparisons.append(
            {
                "algorithm": res.get("algorithm", algo.upper()),
                "found": res.get("found", False),
                "distance_m": res.get("distance_m", 0.0),
                "duration_s": res.get("duration_s", 0.0),
                "nodes_expanded": res.get("nodes_expanded", 0),
                "edges_considered": res.get("edges_considered", 0),
                "execution_time_ms": res.get("execution_time_ms", 0.0),
                "cost": res.get("cost", 0.0),
                "notes": res.get("notes", ""),
            }
        )

    return jsonify(success=True, comparisons=comparisons)


@app.get("/api/incidents")
def list_incidents():
    """Return all active simulated incidents and road closures."""
    return jsonify(
        incidents=list(_incident_registry.values()),
        blocked_count=len(_blocked_edges),
    )


@app.post("/api/incidents")
def add_incident():
    """Add a simulated incident (accident, congestion, or roadblock) on a nearby road segment."""
    global road_graph, _blocked_edges, _incident_penalties, _incident_registry
    if road_graph is None:
        return jsonify(success=False, error="Graph unavailable."), 503

    payload = request.get_json(silent=True) or {}
    try:
        lat = float(payload.get("lat", CENTER[0]))
        lon = float(payload.get("lon", CENTER[1]))
    except (TypeError, ValueError):
        return jsonify(success=False, error="Incident coordinates must be numeric."), 400
    if not math.isfinite(lat) or not math.isfinite(lon):
        return jsonify(success=False, error="Incident coordinates must be finite."), 400
    if not (BOUNDS[0][0] <= lat <= BOUNDS[1][0] and
            BOUNDS[0][1] <= lon <= BOUNDS[1][1]):
        return jsonify(success=False, error="Place incidents inside the Dehradun sector."), 400
    incident_type = payload.get("type", "accident")
    if incident_type not in ("accident", "congestion", "roadblock"):
        return jsonify(success=False, error="Invalid incident type."), 400

    name = payload.get("title", f"Simulated {incident_type.title()}")

    if road_graph.number_of_edges() == 0:
        return jsonify(success=False, error="No road segment found near this coordinate."), 400
    u, v, key = ox.distance.nearest_edges(road_graph, lon, lat)
    data = road_graph[u][v][key]
    n_lat, n_lon = float(road_graph.nodes[u]["y"]), float(road_graph.nodes[u]["x"])
    incident_id = f"inc_{uuid4().hex}"

    geom = data.get("geometry")
    if geom is not None:
        line_coords = [[float(y), float(x)] for x, y in list(geom.coords)]
    else:
        line_coords = [
            [float(road_graph.nodes[u]["y"]), float(road_graph.nodes[u]["x"])],
            [float(road_graph.nodes[v]["y"]), float(road_graph.nodes[v]["x"])],
        ]

    affected_edges = [(u, v, key)]
    if incident_type == "roadblock":
        affected_edges = [(u, v, k) for k in road_graph[u][v]]
        if road_graph.has_edge(v, u):
            for r_key in road_graph[v][u]:
                affected_edges.append((v, u, r_key))
        penalty = None  # Closure is represented by blocked edges; JSON must stay finite.
    elif incident_type == "accident":
        penalty = 3.5
    elif incident_type == "congestion":
        penalty = 2.0
    else:
        penalty = 1.0

    incident_record = {
        "id": incident_id,
        "type": incident_type,
        "title": name,
        "edges": [[str(x[0]), str(x[1]), int(x[2])] for x in affected_edges],
        "penalty": penalty,
        "lat": n_lat,
        "lon": n_lon,
        "road_name": str(data.get("name", "Dehradun Sector Road")),
        "coordinates": line_coords,
        "created_at": datetime.now().strftime("%H:%M:%S"),
    }
    
    # Store with actual typed tuples
    actual_incident_store = dict(incident_record)
    actual_incident_store["edges"] = affected_edges
    _incident_registry[incident_id] = actual_incident_store
    
    _recompute_incident_state()

    return jsonify(success=True, incident=incident_record)


@app.delete("/api/incidents/<incident_id>")
def remove_incident(incident_id: str):
    """Remove a simulated incident and restore baseline graph costs."""
    global _incident_registry
    if incident_id not in _incident_registry:
        return jsonify(success=False, error="Incident not found."), 404

    _incident_registry.pop(incident_id)
    _recompute_incident_state()
    return jsonify(success=True, removed_id=incident_id)


@app.post("/api/incidents/clear")
def clear_all_incidents():
    """Clear all simulated incidents and restore baseline graph costs."""
    global _blocked_edges, _incident_penalties, _incident_registry
    _incident_registry.clear()
    _recompute_incident_state()
    return jsonify(success=True, message="All simulated incidents cleared.")


@app.post("/api/ai/analyze-route")
def ai_analyze_route():
    """Tactical AI assessment using internal Gemini integration without UI exposure."""
    if gemini_rotator is None:
        return jsonify(
            success=False,
            analysis="AI tactical assessment is temporarily unavailable.",
        )

    payload = request.get_json(silent=True) or {}
    algorithm = payload.get("algorithm", "A*")
    distance_m = payload.get("distance_m", 0)
    duration_s = payload.get("duration_s", 0)
    incidents_count = payload.get("incidents_count", 0)
    nodes_expanded = payload.get("nodes_expanded", 0)
    unit_type = payload.get("unit_type", "ambulance")

    unit_labels = {
        "ambulance": "Ambulance (Emergency Medical)",
        "fire": "Fire Brigade (Fire & Rescue)",
        "police": "Police Patrol (Law Enforcement)",
    }
    unit_label = unit_labels.get(unit_type, "Emergency Unit")

    prompt = (
        f"You are the Tactical AI Dispatcher for Emergency Operations in Dehradun, Uttarakhand. "
        f"Provide a concise, 3-point tactical briefing on the following emergency response route:\n"
        f"- Responding Unit: {unit_label}\n"
        f"- Pathfinding Algorithm: {algorithm}\n"
        f"- Route Distance: {distance_m} m\n"
        f"- Estimated Travel Time: {round(duration_s/60, 1)} minutes\n"
        f"- Nodes Explored: {nodes_expanded}\n"
        f"- Active Road Hazards/Closures: {incidents_count}\n"
        f"Format strictly as 3 bullet points focusing on dispatch speed, detour safety, and navigation confidence. "
        f"Complete each bullet point fully within 120 words."
    )

    try:
        response_text = gemini_rotator.generate(
            prompt=prompt,
            temperature=0.3,
            max_output_tokens=700,
            system_instruction="You are a professional tactical emergency rescue coordinator. Deliver complete, direct, concise bullet points without preamble.",
        )
        return jsonify(success=True, analysis=response_text.strip())
    except Exception as exc:
        app.logger.warning("Gemini AI dispatch error: %s", exc)
        return jsonify(success=False, analysis="AI tactical assessment is temporarily unavailable.")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False, use_reloader=False, threaded=True)
