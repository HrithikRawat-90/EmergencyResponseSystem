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

    def test_api_graph_route(self):
        res = self.client.get("/api/graph")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data.get("type"), "FeatureCollection")

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
