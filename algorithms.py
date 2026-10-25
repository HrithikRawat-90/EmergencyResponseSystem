"""Graph search algorithms for emergency rescue routing.

Implements BFS, DFS, Dijkstra, and A* on NetworkX MultiDiGraph representations of
real OpenStreetMap road networks. Supports edge weights based on distance or
estimated travel time, simulated road closures, and incident penalties.
"""

from collections import deque
import heapq
import math
import time
from typing import Any, Dict, List, Optional, Set, Tuple


def haversine_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Compute the great-circle distance between two GPS coordinates in meters."""
    R = 6371000.0  # Earth's radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return R * c


def get_edge_weight(
    u: Any,
    v: Any,
    key: Any,
    data: Dict[str, Any],
    objective: str = "length",
    blocked_edges: Optional[Set[Tuple[Any, Any, Any]]] = None,
    incident_penalties: Optional[Dict[Tuple[Any, Any, Any], float]] = None,
    max_network_speed_mps: float = 16.67,  # ~60 km/h in m/s
) -> Optional[float]:
    """Calculate the effective traversal weight of an edge.
    
    Returns None if the edge is impassable (e.g., blocked).
    Otherwise returns a positive float cost.
    """
    if blocked_edges and ((u, v, key) in blocked_edges or (u, v) in blocked_edges):
        return None

    # Base length in meters
    length = float(data.get("length", 1.0))
    if length <= 0:
        length = 0.1

    # Parse highway classification (used by multiple objectives)
    highway = data.get("highway")
    if isinstance(highway, list):
        highway = highway[0] if highway else ""

    # Parse speed limit
    speed_val = data.get("maxspeed")
    speed_kph = 30.0  # Default urban speed in central Dehradun
    if speed_val:
        if isinstance(speed_val, list):
            speed_val = speed_val[0]
        try:
            tokens = str(speed_val).split()
            speed_num = float(tokens[0])
            if len(tokens) > 1 and "mph" in tokens[1].lower():
                speed_kph = speed_num * 1.60934
            else:
                speed_kph = speed_num
        except (ValueError, IndexError):
            speed_kph = 30.0

    # Highway classification speed fallbacks
    if speed_kph <= 0:
        if highway in ("primary", "primary_link", "trunk"):
            speed_kph = 45.0
        elif highway in ("secondary", "secondary_link"):
            speed_kph = 35.0
        elif highway in ("tertiary", "tertiary_link"):
            speed_kph = 25.0
        elif highway in ("residential", "living_street"):
            speed_kph = 20.0
        else:
            speed_kph = 25.0

    speed_mps = max(speed_kph * (1000.0 / 3600.0), 1.0)

    if objective == "time":
        base_cost = length / speed_mps
    elif objective == "traffic":
        # Traffic-aware: penalizes lower-class roads that are more congestion-prone
        # Major arterials assumed to have better traffic flow; residential streets penalized
        traffic_multiplier = {
            "trunk": 1.0, "trunk_link": 1.1,
            "primary": 1.1, "primary_link": 1.2,
            "secondary": 1.3, "secondary_link": 1.4,
            "tertiary": 1.6, "tertiary_link": 1.7,
            "residential": 2.0, "living_street": 2.2,
            "unclassified": 1.8, "service": 2.5,
        }.get(str(highway), 1.5)
        # Combine distance with traffic penalty
        base_cost = length * traffic_multiplier
    elif objective == "safety":
        # Safety-aware: prefers lower-speed residential streets over high-speed arterials
        # Lower speed = safer for emergency maneuvering through congested areas
        safety_multiplier = {
            "trunk": 2.5, "trunk_link": 2.2,
            "primary": 2.0, "primary_link": 1.8,
            "secondary": 1.5, "secondary_link": 1.4,
            "tertiary": 1.2, "tertiary_link": 1.2,
            "residential": 1.0, "living_street": 1.0,
            "unclassified": 1.3, "service": 1.1,
        }.get(str(highway), 1.3)
        base_cost = length * safety_multiplier
    else:
        # Default: distance objective (shortest path by meters)
        base_cost = length

    # Apply simulated incident penalty if present (multiplier)
    if incident_penalties:
        penalty = incident_penalties.get((u, v, key), incident_penalties.get((u, v), 1.0))
        base_cost *= penalty

    return base_cost


def reconstruct_path(
    parent_map: Dict[Any, Tuple[Any, Any]],
    destination_node: Any,
) -> List[Tuple[Any, Any, Any]]:
    """Reconstruct edge path from parent_map: child -> (parent, key).
    
    Returns list of (u, v, key) tuples in order from start to destination.
    """
    path_edges: List[Tuple[Any, Any, Any]] = []
    curr = destination_node
    while curr in parent_map:
        prev, key = parent_map[curr]
        path_edges.append((prev, curr, key))
        curr = prev
    path_edges.reverse()
    return path_edges


def calculate_route_metrics(graph, path_edges: List[Tuple[Any, Any, Any]], *, rounded=True) -> Dict[str, float]:
    """Calculate total distance (m) and estimated duration (s) along path edges."""
    total_length = 0.0
    total_duration = 0.0
    for u, v, key in path_edges:
        if graph.has_edge(u, v, key):
            data = graph[u][v][key]
            l = float(data.get("length", 0.0))
            total_length += l
            time_cost = get_edge_weight(u, v, key, data, objective="time")
            if time_cost:
                total_duration += time_cost
            else:
                total_duration += l / 8.33  # ~30 km/h fallback
    return {
        "distance_m": round(total_length, 1) if rounded else total_length,
        "duration_s": round(total_duration, 1) if rounded else total_duration,
    }


def record_search_progress(graph, node, parent_map, totals, progress):
    """Snapshot the actual parent path at expansion, preserving parallel-edge choice."""
    distance, duration = 0.0, 0.0
    if node in parent_map:
        parent, key = parent_map[node]
        distance, duration = totals[parent]
        edge = calculate_route_metrics(graph, [(parent, node, key)], rounded=False)
        distance += edge["distance_m"]
        duration += edge["duration_s"]
    totals[node] = (distance, duration)
    progress.append({"distance_m": round(distance, 1), "duration_s": round(duration, 1),
                     "nodes_expanded": len(progress) + 1})


def breadth_first_search(
    graph,
    start_node: Any,
    dest_node: Any,
    blocked_edges: Optional[Set[Tuple[Any, Any, Any]]] = None,
    incident_penalties: Optional[Dict[Tuple[Any, Any, Any], float]] = None,
    max_visited_nodes: Optional[int] = None,
) -> Dict[str, Any]:
    """Breadth-First Search (BFS).
    
    Finds the path minimizing edge hops. Unweighted search.
    """
    t0 = time.perf_counter()
    if start_node not in graph or dest_node not in graph:
        return {"found": False, "error": "Start or destination node not in graph."}

    if start_node == dest_node:
        return {
            "found": True,
            "path_nodes": [start_node],
            "path_edges": [],
            "visited_nodes": [start_node],
            "nodes_expanded": 1,
            "edges_considered": 0,
            "cost": 0.0,
            "distance_m": 0.0,
            "duration_s": 0.0,
            "execution_time_ms": round((time.perf_counter() - t0) * 1000, 2),
            "algorithm": "BFS",
            "notes": "Start and destination are identical.",
        }

    queue = deque([start_node])
    visited: Set[Any] = {start_node}
    search_order: List[Any] = []
    parent_map: Dict[Any, Tuple[Any, Any]] = {}  # child -> (parent, key)
    search_progress = []
    path_totals = {}
    edges_considered = 0
    found = False

    while queue:
        u = queue.popleft()
        search_order.append(u)
        record_search_progress(graph, u, parent_map, path_totals, search_progress)

        if u == dest_node:
            found = True
            break

        if max_visited_nodes is not None and len(search_order) >= max_visited_nodes:
            break

        # Deterministic neighbor traversal
        neighbors = sorted(list(graph.adj[u].items()), key=lambda item: str(item[0]))
        for v, edge_dict in neighbors:
            for key, data in sorted(edge_dict.items(), key=lambda item: item[0]):
                edges_considered += 1
                w = get_edge_weight(u, v, key, data, "length", blocked_edges, incident_penalties)
                if w is None:
                    continue  # Impassable
                if v not in visited:
                    visited.add(v)
                    parent_map[v] = (u, key)
                    queue.append(v)

    tree_edges = [(parent_map[v][0], v) for v in search_order if v in parent_map]
    exec_time = round((time.perf_counter() - t0) * 1000, 2)
    if not found:
        return {
            "found": False,
            "visited_nodes": search_order,
            "tree_edges": tree_edges,
            "search_progress": search_progress,
            "nodes_expanded": len(search_order),
            "edges_considered": edges_considered,
            "execution_time_ms": exec_time,
            "algorithm": "BFS",
            "notes": "No path could be found between start and destination.",
        }

    path_edges = reconstruct_path(parent_map, dest_node)
    path_nodes = [start_node] + [v for _, v, _ in path_edges]
    metrics = calculate_route_metrics(graph, path_edges)

    return {
        "found": True,
        "path_nodes": path_nodes,
        "path_edges": path_edges,
        "visited_nodes": search_order,
        "tree_edges": tree_edges,
        "search_progress": search_progress,
        "nodes_expanded": len(search_order),
        "edges_considered": edges_considered,
        "cost": float(len(path_edges)),  # Hops
        "distance_m": metrics["distance_m"],
        "duration_s": metrics["duration_s"],
        "execution_time_ms": exec_time,
        "algorithm": "BFS",
        "notes": "BFS guarantees minimum edge count, not minimum physical distance or travel time.",
    }


def depth_first_search(
    graph,
    start_node: Any,
    dest_node: Any,
    blocked_edges: Optional[Set[Tuple[Any, Any, Any]]] = None,
    incident_penalties: Optional[Dict[Tuple[Any, Any, Any], float]] = None,
    max_visited_nodes: Optional[int] = None,
) -> Dict[str, Any]:
    """Depth-First Search (DFS).
    
    Explores paths deeply using an explicit LIFO stack. Does not guarantee shortest path.
    """
    t0 = time.perf_counter()
    if start_node not in graph or dest_node not in graph:
        return {"found": False, "error": "Start or destination node not in graph."}

    if start_node == dest_node:
        return {
            "found": True,
            "path_nodes": [start_node],
            "path_edges": [],
            "visited_nodes": [start_node],
            "nodes_expanded": 1,
            "edges_considered": 0,
            "cost": 0.0,
            "distance_m": 0.0,
            "duration_s": 0.0,
            "execution_time_ms": round((time.perf_counter() - t0) * 1000, 2),
            "algorithm": "DFS",
            "notes": "Start and destination are identical.",
        }

    stack = [start_node]
    visited: Set[Any] = set()
    search_order: List[Any] = []
    parent_map: Dict[Any, Tuple[Any, Any]] = {}
    search_progress = []
    path_totals = {}
    edges_considered = 0
    found = False

    while stack:
        u = stack.pop()
        if u in visited:
            continue
        visited.add(u)
        search_order.append(u)
        record_search_progress(graph, u, parent_map, path_totals, search_progress)

        if u == dest_node:
            found = True
            break

        if max_visited_nodes is not None and len(search_order) >= max_visited_nodes:
            break

        # Push neighbors in reverse order so lowest key is popped first
        neighbors = sorted(list(graph.adj[u].items()), key=lambda item: str(item[0]), reverse=True)
        for v, edge_dict in neighbors:
            for key, data in sorted(edge_dict.items(), key=lambda item: item[0], reverse=True):
                edges_considered += 1
                w = get_edge_weight(u, v, key, data, "length", blocked_edges, incident_penalties)
                if w is None:
                    continue
                if v not in visited:
                    parent_map[v] = (u, key)
                    stack.append(v)

    tree_edges = [(parent_map[v][0], v) for v in search_order if v in parent_map]
    exec_time = round((time.perf_counter() - t0) * 1000, 2)
    if not found:
        return {
            "found": False,
            "visited_nodes": search_order,
            "tree_edges": tree_edges,
            "search_progress": search_progress,
            "nodes_expanded": len(search_order),
            "edges_considered": edges_considered,
            "execution_time_ms": exec_time,
            "algorithm": "DFS",
            "notes": "No path could be found between start and destination.",
        }

    path_edges = reconstruct_path(parent_map, dest_node)
    path_nodes = [start_node] + [v for _, v, _ in path_edges]
    metrics = calculate_route_metrics(graph, path_edges)

    return {
        "found": True,
        "path_nodes": path_nodes,
        "path_edges": path_edges,
        "visited_nodes": search_order,
        "tree_edges": tree_edges,
        "search_progress": search_progress,
        "nodes_expanded": len(search_order),
        "edges_considered": edges_considered,
        "cost": float(len(path_edges)),
        "distance_m": metrics["distance_m"],
        "duration_s": metrics["duration_s"],
        "execution_time_ms": exec_time,
        "algorithm": "DFS",
        "notes": "DFS explores branch by branch; routes are typically convoluted and non-optimal.",
    }


def dijkstra_search(
    graph,
    start_node: Any,
    dest_node: Any,
    objective: str = "length",
    blocked_edges: Optional[Set[Tuple[Any, Any, Any]]] = None,
    incident_penalties: Optional[Dict[Tuple[Any, Any, Any], float]] = None,
    max_visited_nodes: Optional[int] = None,
) -> Dict[str, Any]:
    """Dijkstra's Algorithm.
    
    Guarantees shortest weighted path for non-negative edge costs.
    """
    t0 = time.perf_counter()
    if start_node not in graph or dest_node not in graph:
        return {"found": False, "error": "Start or destination node not in graph."}

    if start_node == dest_node:
        return {
            "found": True,
            "path_nodes": [start_node],
            "path_edges": [],
            "visited_nodes": [start_node],
            "nodes_expanded": 1,
            "edges_considered": 0,
            "cost": 0.0,
            "distance_m": 0.0,
            "duration_s": 0.0,
            "execution_time_ms": round((time.perf_counter() - t0) * 1000, 2),
            "algorithm": "Dijkstra",
            "notes": "Start and destination are identical.",
        }

    # Priority queue stores tuples: (distance, count, node)
    counter = 0
    pq: List[Tuple[float, int, Any]] = [(0.0, counter, start_node)]
    dist: Dict[Any, float] = {start_node: 0.0}
    parent_map: Dict[Any, Tuple[Any, Any]] = {}
    search_progress = []
    path_totals = {}
    visited_nodes: List[Any] = []
    settled: Set[Any] = set()
    edges_considered = 0
    found = False

    while pq:
        d, _, u = heapq.heappop(pq)
        if u in settled:
            continue
        settled.add(u)
        visited_nodes.append(u)
        record_search_progress(graph, u, parent_map, path_totals, search_progress)

        if u == dest_node:
            found = True
            break

        if max_visited_nodes is not None and len(visited_nodes) >= max_visited_nodes:
            break

        for v, edge_dict in graph.adj[u].items():
            for key, data in edge_dict.items():
                edges_considered += 1
                w = get_edge_weight(u, v, key, data, objective, blocked_edges, incident_penalties)
                if w is None or w < 0:
                    continue
                new_dist = d + w
                if new_dist < dist.get(v, float("inf")):
                    dist[v] = new_dist
                    parent_map[v] = (u, key)
                    counter += 1
                    heapq.heappush(pq, (new_dist, counter, v))

    tree_edges = [(parent_map[v][0], v) for v in visited_nodes if v in parent_map]
    exec_time = round((time.perf_counter() - t0) * 1000, 2)
    if not found:
        return {
            "found": False,
            "visited_nodes": visited_nodes,
            "tree_edges": tree_edges,
            "search_progress": search_progress,
            "nodes_expanded": len(visited_nodes),
            "edges_considered": edges_considered,
            "execution_time_ms": exec_time,
            "algorithm": "Dijkstra",
            "notes": "No route could be found with the specified constraints.",
        }

    path_edges = reconstruct_path(parent_map, dest_node)
    path_nodes = [start_node] + [v for _, v, _ in path_edges]
    metrics = calculate_route_metrics(graph, path_edges)

    return {
        "found": True,
        "path_nodes": path_nodes,
        "path_edges": path_edges,
        "visited_nodes": visited_nodes,
        "tree_edges": tree_edges,
        "search_progress": search_progress,
        "nodes_expanded": len(visited_nodes),
        "edges_considered": edges_considered,
        "cost": round(dist[dest_node], 2),
        "distance_m": metrics["distance_m"],
        "duration_s": metrics["duration_s"],
        "execution_time_ms": exec_time,
        "algorithm": "Dijkstra",
        "notes": f"Optimal route found minimizing {objective}.",
    }


def a_star_search(
    graph,
    start_node: Any,
    dest_node: Any,
    objective: str = "length",
    blocked_edges: Optional[Set[Tuple[Any, Any, Any]]] = None,
    incident_penalties: Optional[Dict[Tuple[Any, Any, Any], float]] = None,
    max_visited_nodes: Optional[int] = None,
) -> Dict[str, Any]:
    """A* Search Algorithm with Admissible Haversine Heuristic.
    
    Uses physical straight-line geographic distance to prune unnecessary expansions.
    For time objective, heuristic is scaled by maximum urban speed to ensure admissibility.
    """
    t0 = time.perf_counter()
    if start_node not in graph or dest_node not in graph:
        return {"found": False, "error": "Start or destination node not in graph."}

    if start_node == dest_node:
        return {
            "found": True,
            "path_nodes": [start_node],
            "path_edges": [],
            "visited_nodes": [start_node],
            "nodes_expanded": 1,
            "edges_considered": 0,
            "cost": 0.0,
            "distance_m": 0.0,
            "duration_s": 0.0,
            "execution_time_ms": round((time.perf_counter() - t0) * 1000, 2),
            "algorithm": "A*",
            "notes": "Start and destination are identical.",
        }

    dest_lat = float(graph.nodes[dest_node]["y"])
    dest_lon = float(graph.nodes[dest_node]["x"])

    # Max speed in m/s for time heuristic admissibility (e.g., 60 km/h = 16.67 m/s)
    max_speed_mps = 16.67

    def heuristic(node: Any) -> float:
        node_lat = float(graph.nodes[node]["y"])
        node_lon = float(graph.nodes[node]["x"])
        h_dist = haversine_distance_m(node_lat, node_lon, dest_lat, dest_lon)
        if objective == "time":
            return h_dist / max_speed_mps
        return h_dist

    counter = 0
    h_start = heuristic(start_node)
    pq: List[Tuple[float, float, int, Any]] = [(h_start, 0.0, counter, start_node)]  # (f, g, count, node)
    g_score: Dict[Any, float] = {start_node: 0.0}
    parent_map: Dict[Any, Tuple[Any, Any]] = {}
    search_progress = []
    path_totals = {}
    visited_nodes: List[Any] = []
    settled: Set[Any] = set()
    edges_considered = 0
    found = False

    while pq:
        f, g, _, u = heapq.heappop(pq)
        if u in settled:
            continue
        settled.add(u)
        visited_nodes.append(u)
        record_search_progress(graph, u, parent_map, path_totals, search_progress)

        if u == dest_node:
            found = True
            break

        if max_visited_nodes is not None and len(visited_nodes) >= max_visited_nodes:
            break

        for v, edge_dict in graph.adj[u].items():
            for key, data in edge_dict.items():
                edges_considered += 1
                w = get_edge_weight(u, v, key, data, objective, blocked_edges, incident_penalties)
                if w is None or w < 0:
                    continue
                tentative_g = g + w
                if tentative_g < g_score.get(v, float("inf")):
                    g_score[v] = tentative_g
                    parent_map[v] = (u, key)
                    counter += 1
                    h_val = heuristic(v)
                    heapq.heappush(pq, (tentative_g + h_val, tentative_g, counter, v))

    tree_edges = [(parent_map[v][0], v) for v in visited_nodes if v in parent_map]
    exec_time = round((time.perf_counter() - t0) * 1000, 2)
    if not found:
        return {
            "found": False,
            "visited_nodes": visited_nodes,
            "tree_edges": tree_edges,
            "search_progress": search_progress,
            "nodes_expanded": len(visited_nodes),
            "edges_considered": edges_considered,
            "execution_time_ms": exec_time,
            "algorithm": "A*",
            "notes": "No route could be found with the specified constraints.",
        }

    path_edges = reconstruct_path(parent_map, dest_node)
    path_nodes = [start_node] + [v for _, v, _ in path_edges]
    metrics = calculate_route_metrics(graph, path_edges)

    return {
        "found": True,
        "path_nodes": path_nodes,
        "path_edges": path_edges,
        "visited_nodes": visited_nodes,
        "tree_edges": tree_edges,
        "search_progress": search_progress,
        "nodes_expanded": len(visited_nodes),
        "edges_considered": edges_considered,
        "cost": round(g_score[dest_node], 2),
        "distance_m": metrics["distance_m"],
        "duration_s": metrics["duration_s"],
        "execution_time_ms": exec_time,
        "algorithm": "A*",
        "notes": f"Optimal path found via A* guided by Euclidean/Haversine heuristic ({objective}).",
    }


def run_algorithm(
    graph,
    algorithm: str,
    start_node: Any,
    dest_node: Any,
    objective: str = "length",
    blocked_edges: Optional[Set[Tuple[Any, Any, Any]]] = None,
    incident_penalties: Optional[Dict[Tuple[Any, Any, Any], float]] = None,
) -> Dict[str, Any]:
    """Uniform entry point for running any of the four algorithms."""
    algo_normalized = algorithm.strip().lower()
    if algo_normalized in ("bfs", "breadth_first_search"):
        return breadth_first_search(graph, start_node, dest_node, blocked_edges, incident_penalties)
    elif algo_normalized in ("dfs", "depth_first_search"):
        return depth_first_search(graph, start_node, dest_node, blocked_edges, incident_penalties)
    elif algo_normalized in ("dijkstra", "dijkstras"):
        return dijkstra_search(graph, start_node, dest_node, objective, blocked_edges, incident_penalties)
    elif algo_normalized in ("a*", "astar", "a_star"):
        return a_star_search(graph, start_node, dest_node, objective, blocked_edges, incident_penalties)
    else:
        raise ValueError(f"Unsupported algorithm: '{algorithm}'. Choose from BFS, DFS, Dijkstra, A*.")
