"""Unit tests for the Intelligent Emergency Response and Rescue Agent.

Tests:
- BFS, DFS, Dijkstra, and A* algorithm correctness.
- Directed edge and one-way handling.
- Multi-edge between node pairs.
- Unreachable destinations.
- Road closures and simulated incident penalties.
- Snapping and route metric calculation.
- Flask API endpoints and error response structures.
"""

import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
import networkx as nx

import algorithms
import app


class TestAlgorithms(unittest.TestCase):
    def setUp(self):
        """Create a controlled synthetic MultiDiGraph fixture for testing."""
        self.g = nx.MultiDiGraph()

        # Add nodes with coordinates
        self.g.add_node(1, y=30.3165, x=78.0322)
        self.g.add_node(2, y=30.3175, x=78.0332)
        self.g.add_node(3, y=30.3185, x=78.0342)
        self.g.add_node(4, y=30.3195, x=78.0352)
        self.g.add_node(5, y=30.3205, x=78.0362)  # Isolated node

        # Add directed edges:
        # Path A: 1 -> 2 -> 4 (lengths: 100, 200 => total 300)
        # Path B: 1 -> 3 -> 4 (lengths: 50, 60 => total 110) - Shorter physical distance
        # Multi-edge between 1 and 2: key 0 (len 100), key 1 (len 80)
        self.g.add_edge(1, 2, key=0, length=100.0, highway="primary", maxspeed="40")
        self.g.add_edge(1, 2, key=1, length=80.0, highway="primary", maxspeed="40")
        self.g.add_edge(2, 4, key=0, length=200.0, highway="secondary", maxspeed="30")
        
        self.g.add_edge(1, 3, key=0, length=50.0, highway="residential", maxspeed="20")
        self.g.add_edge(3, 4, key=0, length=60.0, highway="residential", maxspeed="20")

        # One-way edge: 4 -> 1 does NOT exist

    def test_dijkstra_shortest_path(self):
        res = algorithms.dijkstra_search(self.g, start_node=1, dest_node=4, objective="length")
        self.assertTrue(res["found"])
        self.assertEqual(res["path_nodes"], [1, 3, 4])
        self.assertEqual(res["distance_m"], 110.0)

    def test_routes_beyond_original_search_limit(self):
        """Expanded coverage must not truncate searches at the old 5,000 nodes."""
        graph = nx.MultiDiGraph()
        for node in range(5_010):
            graph.add_node(node, y=30.3, x=78.0 + node * 0.000001)
            if node:
                graph.add_edge(node - 1, node, length=1.0)
        for name in ("bfs", "dfs", "dijkstra", "a*"):
            with self.subTest(algorithm=name):
                result = algorithms.run_algorithm(graph, name, 0, 5_009)
                self.assertTrue(result["found"])
                self.assertEqual(result["distance_m"], 5_009)

    def test_live_search_metrics_follow_actual_paths(self):
        # Each snapshot measures the expanded parent path, not a fraction of the final route.
        for name in ("bfs", "dfs", "dijkstra", "astar"):
            with self.subTest(algorithm=name):
                result = algorithms.run_algorithm(self.g, name, 1, 4, "length")
                progress = result["search_progress"]
                self.assertEqual(len(progress), result["nodes_expanded"])
                self.assertEqual([p["nodes_expanded"] for p in progress],
                                 list(range(1, len(progress) + 1)))
                self.assertEqual(progress[0]["distance_m"], 0)
                self.assertEqual(progress[-1]["distance_m"], result["distance_m"])
                self.assertAlmostEqual(progress[-1]["duration_s"], result["duration_s"], delta=0.2)
                if name in ("dijkstra", "astar"):
                    self.assertEqual(progress[-1]["distance_m"], 110)

    def test_a_star_agreement_with_dijkstra(self):
        res_dijkstra = algorithms.dijkstra_search(self.g, start_node=1, dest_node=4, objective="length")
        res_astar = algorithms.a_star_search(self.g, start_node=1, dest_node=4, objective="length")
        self.assertTrue(res_astar["found"])
        self.assertEqual(res_dijkstra["distance_m"], res_astar["distance_m"])
        self.assertEqual(res_astar["path_nodes"], [1, 3, 4])

    def test_bfs_minimum_hops(self):
        res = algorithms.breadth_first_search(self.g, start_node=1, dest_node=4)
        self.assertTrue(res["found"])
        # BFS minimizes number of hops (both 1->2->4 and 1->3->4 have 2 hops)
        self.assertEqual(len(res["path_edges"]), 2)

    def test_dfs_finds_path(self):
        res = algorithms.depth_first_search(self.g, start_node=1, dest_node=4)
        self.assertTrue(res["found"])
        self.assertEqual(res["path_nodes"][0], 1)
        self.assertEqual(res["path_nodes"][-1], 4)

    def test_unreachable_destination(self):
        # Node 5 has no inbound or outbound edges
        res = algorithms.dijkstra_search(self.g, start_node=1, dest_node=5)
        self.assertFalse(res["found"])

    def test_directed_one_way(self):
        # Path exists 1 -> 4, but not 4 -> 1
        res = algorithms.dijkstra_search(self.g, start_node=4, dest_node=1)
        self.assertFalse(res["found"])

    def test_road_closure_rerouting(self):
        # Block edge (1, 3, 0)
        blocked = {(1, 3, 0)}
        res = algorithms.dijkstra_search(self.g, start_node=1, dest_node=4, blocked_edges=blocked)
        self.assertTrue(res["found"])
        # Should now take path via node 2 with shorter key 1 (80 + 200 = 280)
        self.assertEqual(res["path_nodes"], [1, 2, 4])
        self.assertEqual(res["distance_m"], 280.0)

    def test_incident_penalty(self):
        # Introduce a high penalty on (3, 4, 0) of 10x (60 * 10 = 600)
        # Total Path B cost becomes 50 + 600 = 650
        # Dijkstra should now prefer Path A (80 + 200 = 280)
        penalties = {(3, 4, 0): 10.0}
        res = algorithms.dijkstra_search(self.g, start_node=1, dest_node=4, incident_penalties=penalties)
        self.assertTrue(res["found"])
        self.assertEqual(res["path_nodes"], [1, 2, 4])

    def test_traffic_objective(self):
        # Primary highway has lower traffic penalty than residential
        res = algorithms.dijkstra_search(self.g, start_node=1, dest_node=4, objective="traffic")
        self.assertTrue(res["found"])

    def test_safety_objective(self):
        # Safest route evaluates highway safety factors
        res = algorithms.dijkstra_search(self.g, start_node=1, dest_node=4, objective="safety")
        self.assertTrue(res["found"])


class TestFlaskAPI(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()

    def test_index_route(self):
        res = self.client.get("/")
        self.assertEqual(res.status_code, 200)
        self.assertIn(b"EMERGENCY", res.data)

    def test_animation_includes_search_beyond_600_edges(self):
        graph = nx.MultiDiGraph()
        for node in range(1_201):
            graph.add_node(node, y=30.3165, x=78.02 + node * 0.00001)
            if node:
                graph.add_edge(node - 1, node, length=1.0)
        nodes = [(n, d["y"], d["x"]) for n, d in graph.nodes(data=True)]
        with patch.object(app, "road_graph", graph), patch.object(app, "_node_cache", nodes):
            for algorithm in ("bfs", "dfs", "dijkstra", "a*"):
                with self.subTest(algorithm=algorithm):
                    response = self.client.post("/api/route", json={
                        "start": [30.3165, 78.02],
                        "destination": [30.3165, 78.032],
                        "algorithm": algorithm,
                    })
                    data = response.get_json()
                    self.assertTrue(data["success"])
                    self.assertEqual(len(data["search_tree_edges"]), 1_200)
                    self.assertEqual(len(data["visited_coords"]), 1_201)
                    self.assertEqual(len(data["search_progress"]), 1_201)
                    self.assertEqual(data["search_progress"][-1]["distance_m"], data["distance_m"])
                    self.assertEqual(data["search_progress"][-1]["duration_s"], data["duration_s"])
                    self.assertEqual(data["search_progress"][-1]["nodes_expanded"], data["nodes_expanded"])
                    self.assertEqual(data["search_tree_edges"][-1][-1], data["destination"]["snapped"])

    def test_api_graph_route(self):
        res = self.client.get("/api/graph")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data.get("type"), "FeatureCollection")

    def test_expanded_coverage(self):
        self.assertGreaterEqual((app.DISTANCE_M / 1_500) ** 2, 5)
        self.assertIn(f"{app.DISTANCE_M}m", app.CACHE_FILE.name)
        # Outside the old 1.5 km half-width, inside the expanded western sector.
        response = self.client.post("/api/route", json={
            "start": [30.3165, 78.005],
            "destination": [30.3165, 78.0322],
            "algorithm": "dijkstra",
        })
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["success"])
        self.assertLess(response.get_json()["start"]["snap_distance_m"], 500)

    def test_route_calculation_api(self):
        payload = {
            "start": [30.3165, 78.0322],
            "destination": [30.3200, 78.0380],
            "algorithm": "a*",
            "objective": "length",
            "unit_type": "ambulance",
        }
        res = self.client.post("/api/route", json=payload)
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data.get("success"))
        self.assertIn("route_geometry", data)
        self.assertGreater(data.get("distance_m", 0), 0)

    def test_route_all_objectives(self):
        for obj in ["length", "time", "traffic", "safety"]:
            payload = {
                "start": [30.3165, 78.0322],
                "destination": [30.3200, 78.0380],
                "algorithm": "dijkstra",
                "objective": obj,
                "unit_type": "fire",
            }
            res = self.client.post("/api/route", json=payload)
            self.assertEqual(res.status_code, 200, f"Failed for objective {obj}")
            self.assertTrue(res.get_json().get("success"))

    def test_invalid_coordinates(self):
        # Coordinate far outside Dehradun (e.g. London)
        payload = {
            "start": [51.5074, -0.1278],
            "destination": [30.3165, 78.0322],
            "algorithm": "dijkstra",
        }
        res = self.client.post("/api/route", json=payload)
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertFalse(data.get("success"))

    def test_roadblock_strict_json_nearest_segment_and_parallel_edges(self):
        graph = nx.MultiDiGraph(crs="EPSG:4326")
        graph.add_node(1, y=30.31, x=78.03)
        graph.add_node(2, y=30.33, x=78.03)
        graph.add_node(3, y=30.31, x=78.05)
        graph.add_edge(1, 3, key=0, length=2000)
        graph.add_edge(1, 2, key=3, length=2200)
        graph.add_edge(1, 2, key=4, length=2200)
        graph.add_edge(2, 1, key=8, length=2200)
        with patch.object(app, "road_graph", graph), patch.object(app, "_incident_registry", {}), \
             patch.object(app, "_blocked_edges", set()), patch.object(app, "_incident_penalties", {}):
            response = self.client.post("/api/incidents", json={"lat": 30.32, "lon": 78.0301, "type": "roadblock"})
            self.assertEqual(response.status_code, 200)
            def reject_constant(value):
                raise ValueError(f"Invalid JSON constant: {value}")
            data = json.loads(response.get_data(as_text=True), parse_constant=reject_constant)
            self.assertIsNone(data["incident"]["penalty"])
            self.assertEqual(app._blocked_edges, {(1, 2, 3), (1, 2, 4), (2, 1, 8)})
            self.assertFalse(algorithms.dijkstra_search(graph, 1, 2, blocked_edges=app._blocked_edges)["found"])
            json.loads(self.client.get("/api/incidents").get_data(as_text=True), parse_constant=reject_constant)
            self.client.delete(f"/api/incidents/{data['incident']['id']}")
            self.assertFalse(app._blocked_edges)
            self.assertTrue(algorithms.dijkstra_search(graph, 1, 2, blocked_edges=app._blocked_edges)["found"])

    def test_incident_invalid_coordinates(self):
        for lat, lon in ((None, 78.03), ("invalid", 78.03), (float("nan"), 78.03), (0, 0)):
            with self.subTest(lat=lat):
                response = self.client.post("/api/incidents", json={"lat": lat, "lon": lon, "type": "roadblock"})
                self.assertEqual(response.status_code, 400)
                self.assertFalse(response.get_json()["success"])

    def test_working_nodes_include_isolated_nodes_and_exclude_outside(self):
        graph = nx.MultiDiGraph()
        graph.add_node(1, y=app.CENTER[0], x=app.CENTER[1])
        graph.add_node(2, y=app.BOUNDS[0][0], x=app.BOUNDS[0][1])
        graph.add_node(3, y=app.BOUNDS[1][0] + 0.01, x=app.CENTER[1])
        with patch.object(app, "road_graph", graph):
            response = self.client.get("/api/nodes")
            self.assertEqual(response.status_code, 200)
            data = response.get_json()
            self.assertEqual(data["count"], 2)
            self.assertEqual({node["id"] for node in data["nodes"]}, {"1", "2"})
            self.assertEqual(data["bounds"], app.BOUNDS)
            self.assertEqual(data["nodes"][0]["lat"], app.CENTER[0])

    def test_graph_context_is_separate_and_cached(self):
        original_graph = app.road_graph
        original_bounds = [list(point) for point in app.BOUNDS]
        response_data = {"elements": [{"id": 42, "geometry": [
            {"lat": 30.3165, "lon": 78.09}, {"lat": 30.32, "lon": 78.10}]}]}
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(app.graph_context.requests, "get") as download:
                download.return_value.json.return_value = response_data
                with patch.object(app, "CACHE_DIR", Path(temporary)):
                    response = self.client.get("/api/graph-context")
                    self.assertEqual(response.status_code, 200)
                    data = response.get_json()
                    self.assertTrue(data["meta"]["context_only"])
                    self.assertEqual(data["meta"]["working_bounds"], original_bounds)
                    self.assertLess(data["meta"]["bounds"][0][0], original_bounds[0][0])
                    self.assertGreater(data["meta"]["bounds"][1][1], original_bounds[1][1])
                    self.assertEqual(self.client.get("/api/graph-context").get_data(), response.get_data())
                    download.assert_called_once()
                    self.assertTrue(list(Path(temporary).glob("*.geojson")))
        self.assertIs(app.road_graph, original_graph)
        self.assertEqual(app.BOUNDS, original_bounds)

    def test_graph_context_failure_keeps_routing_available(self):
        with patch.object(app.graph_context, "load_context", side_effect=RuntimeError("Temporarily unavailable")):
            self.assertEqual(self.client.get("/api/graph-context").status_code, 503)
            self.assertEqual(self.client.get("/api/graph").status_code, 200)

    def test_incidents_crud(self):
        # 1. Add incident
        add_res = self.client.post("/api/incidents", json={
            "lat": 30.3165,
            "lon": 78.0322,
            "type": "roadblock",
            "title": "Main Street Barricade"
        })
        self.assertEqual(add_res.status_code, 200)
        inc_data = add_res.get_json()
        self.assertTrue(inc_data.get("success"))
        inc_id = inc_data["incident"]["id"]

        # 2. List incidents
        list_res = self.client.get("/api/incidents")
        self.assertEqual(list_res.status_code, 200)
        self.assertGreaterEqual(list_res.get_json().get("blocked_count", 0), 1)

        # 3. Delete incident
        del_res = self.client.delete(f"/api/incidents/{inc_id}")
        self.assertEqual(del_res.status_code, 200)

        # 4. Clear all
        clear_res = self.client.post("/api/incidents/clear")
        self.assertEqual(clear_res.status_code, 200)


if __name__ == "__main__":
    unittest.main()
