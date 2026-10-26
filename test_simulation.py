import copy
import unittest
from unittest.mock import patch

import app
from simulation import Simulation


class Clock:
    def __init__(self):
        self.now = 0

    def __call__(self):
        return self.now


class TestDispatcher(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.blocked, self.penalties, self.traffic_values = set(), {}, []
        self.fail = False
        self.calls = []
        depots = [{"id": "a1", "label": "Ambulance 1", "type": "ambulance", "position": [0, 0]},
                  {"id": "a2", "label": "Ambulance 2", "type": "ambulance", "position": [0, 10]},
                  {"id": "f1", "label": "Fire 1", "type": "fire", "position": [1, 1]},
                  {"id": "p1", "label": "Police 1", "type": "police", "position": [2, 2]}]
        self.sim = Simulation(depots, self.plan, lambda: (self.blocked, self.penalties),
                              lambda rng, tick: self.traffic_values.append((tick, rng.random())),
                              lambda: self.traffic_values.clear(), self.clock)

    def plan(self, payload):
        self.calls.append(copy.deepcopy(payload))
        if self.fail:
            return {"success": False}
        origin, target = payload["start"], payload["destination"]
        distance = sum((a - b) ** 2 for a, b in zip(origin, target)) ** 0.5
        legs = [{"edge": ["u", "v", 0], "geometry": [origin, target], "distance_m": distance * 100,
                 "duration_s": distance * 10, "incident_multiplier": 1}] if distance else []
        return {"success": True, "journey_segments": legs, "destination": {"snapped": target}}

    def queue(self, priority="critical", kind="ambulance", destination=None):
        return self.sim.queue({"priority": priority, "unit_type": kind, "destination": destination or [0, 9]})

    def tick(self, seconds=0.1):
        self.clock.now += seconds
        return self.sim.snapshot()

    def test_priority_fifo_and_minimum_compatible_eta(self):
        low = self.queue("low")
        critical = self.queue("critical")
        high = self.queue("high")
        self.assertTrue(all(job["status"] == "queued" for job in self.sim.requests))
        self.sim.control({"action": "start"})
        assigned = {job["id"]: job for job in self.sim.requests}
        self.assertEqual(assigned[critical]["unit_id"], "a2")
        self.assertEqual(assigned[high]["unit_id"], "a1")
        self.assertEqual(assigned[low]["status"], "queued")
        later = self.queue("critical")
        self.assertEqual(assigned[high]["status"], "assigned", "New priority must not preempt active missions")
        self.tick(0.4)  # Nearby a2 completes; later Critical outranks earlier Low.
        self.assertEqual(next(job for job in self.sim.requests if job["id"] == later)["status"], "completed")
        self.assertNotEqual(next(job for job in self.sim.requests if job["id"] == low)["unit_id"], "a1")

    def test_fifo_ties_and_type_compatibility(self):
        first, second = self.queue("high"), self.queue("high")
        fire = self.queue("critical", "fire")
        self.sim.control({"action": "start"})
        self.assertEqual(next(job for job in self.sim.requests if job["id"] == first)["unit_id"], "a2")
        self.assertEqual(next(job for job in self.sim.requests if job["id"] == second)["unit_id"], "a1")
        self.assertEqual(next(job for job in self.sim.requests if job["id"] == fire)["unit_id"], "f1")

    def test_concurrent_units_independent_pause_and_global_pause(self):
        self.queue(destination=[0, 8])
        self.queue(kind="fire", destination=[0, 8])
        self.queue(kind="police", destination=[0, 8])
        self.sim.control({"action": "start", "speed": 10})
        before = {unit["id"]: unit["position"][:] for unit in self.sim.units}
        self.tick()
        active = [unit for unit in self.sim.units if unit["request_id"]]
        self.assertEqual(len(active), 3)
        self.assertTrue(all(unit["position"] != before[unit["id"]] for unit in active))
        ambulance = next(unit for unit in active if unit["type"] == "ambulance")
        self.sim.unit_control(ambulance["id"], "pause")
        stopped = ambulance["position"][:]
        self.tick()
        self.assertEqual(ambulance["position"], stopped)
        self.assertEqual(ambulance["phase"], "paused")
        self.sim.control({"action": "pause"})
        positions = [unit["position"][:] for unit in self.sim.units]
        self.tick(1)
        self.assertEqual(positions, [unit["position"] for unit in self.sim.units])

    def test_shared_closure_holds_position_then_restores_paused_agent(self):
        self.queue()
        self.sim.control({"action": "start", "speed": 10})
        self.tick(0.1)
        unit = next(unit for unit in self.sim.units if unit["request_id"])
        self.sim.unit_control(unit["id"], "pause")
        position, travelled = unit["position"][:], unit["distance_m"]
        self.blocked.add(("u", "v", "0"))
        self.sim.environment_changed()
        self.tick()
        self.assertEqual(unit["phase"], "waiting")
        self.assertEqual(unit["position"], position)
        self.blocked.clear()
        self.sim.environment_changed()
        self.sim.snapshot()
        self.assertEqual(unit["phase"], "paused")
        self.assertEqual(unit["position"], position)
        self.assertEqual(unit["distance_m"], travelled)
        self.assertTrue(unit["legs"][0]["started_mid_edge"])

    def test_no_route_retries_on_environment_change_and_cancel_releases_unit(self):
        self.fail = True
        job_id = self.queue()
        self.sim.control({"action": "start"})
        self.assertEqual(self.sim.requests[0]["status"], "queued")
        calls = len(self.calls)
        self.tick()
        self.assertEqual(len(self.calls), calls, "Do not recompute unreachable plans every poll")
        self.fail = False
        self.sim.environment_changed()
        self.sim.snapshot()
        self.assertEqual(self.sim.requests[0]["status"], "assigned")
        self.sim.cancel_request(job_id)
        self.assertEqual(self.sim.requests[0]["status"], "cancelled")
        self.assertTrue(all(unit["request_id"] is None for unit in self.sim.units))

    def test_pause_resume_cannot_bypass_a_closed_occupied_road(self):
        self.queue()
        self.sim.control({"action": "start", "speed": 10})
        self.tick(0.1)
        unit = next(unit for unit in self.sim.units if unit["request_id"])
        position = unit["position"][:]
        self.blocked.add(("u", "v", "0"))
        self.sim.environment_changed()
        self.sim.snapshot()
        self.sim.unit_control(unit["id"], "pause")
        self.sim.unit_control(unit["id"], "resume")
        self.tick(0.1)
        self.assertEqual(unit["phase"], "waiting")
        self.assertEqual(unit["position"], position)

    def test_motion_trace_keeps_crossed_corners_and_never_predicts(self):
        def curved_plan(payload):
            origin, target = payload["start"], payload["destination"]
            return {"success": True, "destination": {"snapped": target}, "journey_segments": [{
                "edge": ["u", "v", 0], "geometry": [origin, [1, 0], target],
                "distance_m": 400, "duration_s": 100, "incident_multiplier": 1}]}
        self.sim.planner = curved_plan
        self.queue(destination=[1, 3])
        self.sim.control({"action": "start", "speed": 30})
        snapshot = self.tick(1)
        unit = next(unit for unit in snapshot["units"] if unit["request_id"])
        trace = unit["motion_trace"]
        self.assertIn([1, 0], [sample["position"] for sample in trace])
        self.assertEqual(trace[-1]["position"], unit["position"])
        self.assertEqual(trace[-1]["time_s"], unit["elapsed_s"])
        self.assertEqual([sample["time_s"] for sample in trace], sorted(sample["time_s"] for sample in trace))
        self.assertTrue(all(sample["time_s"] <= unit["elapsed_s"] for sample in trace))
        self.assertNotIn("_motion", unit)

    def test_motion_trace_is_bounded_on_long_missions(self):
        original = self.sim.planner
        def long_plan(payload):
            result = original(payload)
            for leg in result["journey_segments"]:
                leg["duration_s"] = 100000
            return result
        self.sim.planner = long_plan
        self.queue()
        self.sim.control({"action": "start", "speed": 60})
        for _ in range(200):
            snapshot = self.tick(2)
        unit = next(unit for unit in snapshot["units"] if unit["request_id"])
        self.assertLessEqual(len(unit["motion_trace"]), 1024)
        self.assertTrue(all(sample["time_s"] >= unit["elapsed_s"] - 180 for sample in unit["motion_trace"]))

    def test_seeded_automatic_traffic_pause_reset(self):
        self.sim.traffic_control({"action": "start", "seed": 17, "interval_s": 5})
        first = self.traffic_values[0]
        for _ in range(3):
            self.tick(2)
        self.assertEqual(self.sim.traffic["ticks"], 2)
        self.sim.traffic_control({"action": "pause"})
        self.tick(2)
        self.assertEqual(self.sim.traffic["ticks"], 2)
        self.sim.traffic_control({"action": "reset"})
        self.assertEqual(self.traffic_values, [])
        self.sim.traffic_control({"action": "start", "seed": 17, "interval_s": 5})
        self.assertEqual(self.traffic_values[0], first)

    def test_instance_identity_survives_reset_but_changes_for_new_server(self):
        first = self.sim.snapshot()
        self.sim.control({"action": "reset"})
        reset = self.sim.snapshot()
        self.assertEqual(reset["instance_id"], first["instance_id"])
        self.assertGreater(reset["sequence"], first["sequence"])
        replacement = Simulation(self.sim.depots, self.plan, lambda: (set(), {}), lambda rng, tick: None, lambda: None, self.clock)
        self.assertNotEqual(replacement.snapshot()["instance_id"], first["instance_id"])

    def test_invalid_controls_do_not_start_dispatcher(self):
        with self.assertRaises(ValueError):
            self.sim.control({"action": "start", "speed": 999})
        self.assertFalse(self.sim.running)
        with self.assertRaises(ValueError):
            self.queue("urgent")

    def test_edit_resources_and_reset_preserves_configuration(self):
        unit_id = self.sim.edit_unit("add", kind="police", position=[3, 3])
        self.sim.edit_unit("move", unit_id, position=[4, 4])
        self.sim.edit_unit("remove", "p1")
        self.sim.control({"action": "reset"})
        self.assertEqual(len(self.sim.units), 4)
        self.assertEqual(next(u for u in self.sim.units if u["id"] == unit_id)["position"], [4, 4])
        self.assertNotIn("p1", [u["id"] for u in self.sim.units])
        self.sim.edit_unit("remove", unit_id)
        replacement = self.sim.edit_unit("add", kind="police", position=[3, 3])
        self.assertNotEqual(replacement, unit_id)

    def test_resource_edits_protect_assigned_missions(self):
        self.queue(kind="police", destination=[0, 9])
        self.sim.control({"action": "start"})
        for action in ("remove", "move"):
            with self.assertRaisesRegex(ValueError, "Cancel"):
                self.sim.edit_unit(action, "p1", position=[5, 5])
        self.assertEqual(self.sim.requests[0]["status"], "assigned")
        self.assertEqual(self.sim.requests[0]["unit_id"], "p1")

    def test_zero_vehicles_wait_until_compatible_resource_added(self):
        for unit in list(self.sim.units):
            self.sim.edit_unit("remove", unit["id"])
        self.queue(kind="police", destination=[0, 9])
        self.sim.control({"action": "start"})
        self.assertEqual(self.sim.requests[0]["status"], "queued")
        unit_id = self.sim.edit_unit("add", kind="police", position=[0, 8])
        self.assertEqual(self.sim.requests[0]["unit_id"], unit_id)
        self.assertEqual(self.calls[-1]["start"], [0, 8])


class TestSimulationAPI(unittest.TestCase):
    def setUp(self):
        self.patches = [patch.object(app, "_simulation", None), patch.object(app, "_incident_registry", {}),
                        patch.object(app, "_blocked_edges", set()), patch.object(app, "_incident_penalties", {}),
                        patch.object(app, "_environment_revision", 0)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        self.client = app.app.test_client()

    def test_vehicle_crud_snaps_positions_and_validates(self):
        created = self.client.post("/api/fleet/units", json={"unit_type": "fire", "position": [30.3165, 78.0322]})
        self.assertEqual(created.status_code, 200)
        unit_id = created.get_json()["unit_id"]
        self.assertEqual(len(created.get_json()["fleet"]["units"]), 5)
        updated = self.client.patch(f"/api/fleet/units/{unit_id}", json={"position": [30.3254, 78.0419]})
        self.assertEqual(updated.status_code, 200)
        unit = next(u for u in updated.get_json()["fleet"]["units"] if u["id"] == unit_id)
        _, lat, lon, _ = app.snap_coordinate_to_node(30.3254, 78.0419)
        self.assertEqual(unit["position"], [lat, lon])
        for point in ([0, 0], None, ["bad", 78], [float("nan"), 78]):
            self.assertEqual(self.client.patch(f"/api/fleet/units/{unit_id}", json={"position": point}).status_code, 400)
        self.assertEqual(self.client.post("/api/fleet/units", json={"unit_type": "plane", "position": [30.3165, 78.0322]}).status_code, 400)
        deleted = self.client.delete(f"/api/fleet/units/{unit_id}")
        self.assertEqual(len(deleted.get_json()["fleet"]["units"]), 4)
        self.assertEqual(self.client.delete(f"/api/fleet/units/{unit_id}").status_code, 400)

    def test_queue_dispatch_snapshot_and_validation(self):
        response = self.client.get("/api/simulation")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        initial = response.get_json()
        self.assertEqual(len(initial["fleet"]["units"]), 4)
        self.assertFalse(initial["fleet"]["running"])
        body = {"destination": [30.3254, 78.0419], "unit_type": "ambulance", "priority": "low"}
        low = self.client.post("/api/fleet/requests", json=body).get_json()["request_id"]
        body["priority"] = "critical"
        critical = self.client.post("/api/fleet/requests", json=body).get_json()["request_id"]
        result = self.client.post("/api/fleet/control", json={"action": "start"}).get_json()
        self.assertEqual(result["fleet"]["requests"][0]["id"], critical)
        self.assertEqual(sum(unit["request_id"] is not None for unit in result["fleet"]["units"]), 2)
        self.assertTrue(all(unit["type"] == "ambulance" for unit in result["fleet"]["units"] if unit["request_id"]))
        self.assertEqual(self.client.delete(f"/api/fleet/requests/{low}").status_code, 200)
        self.assertEqual(self.client.post("/api/fleet/requests", json={**body, "destination": [0, 0]}).status_code, 400)
        self.assertEqual(self.client.post("/api/fleet/control", json=["invalid"]).status_code, 400)
        self.assertEqual(self.client.post("/api/fleet/control", json={"action": "start", "speed": 999}).status_code, 400)

    def test_automatic_traffic_is_seeded_and_reset_preserves_manual(self):
        manual = self.client.post("/api/incidents", json={"lat": 30.3165, "lon": 78.0322, "type": "accident"}).get_json()["incident"]
        body = {"action": "start", "seed": 42, "interval_s": 5}
        first = self.client.post("/api/traffic/control", json=body).get_json()
        automatic = [inc for inc in first["incidents"] if inc.get("source") == "automatic"]
        self.assertEqual(len(automatic), 3)
        self.assertTrue(all(inc["type"] == "congestion" for inc in automatic))
        reset = self.client.post("/api/traffic/control", json={"action": "reset"}).get_json()
        self.assertEqual([inc["id"] for inc in reset["incidents"]], [manual["id"]])
        repeated = self.client.post("/api/traffic/control", json=body).get_json()
        again = [inc for inc in repeated["incidents"] if inc.get("source") == "automatic"]
        self.assertEqual([(inc["edges"], inc["penalty"]) for inc in automatic], [(inc["edges"], inc["penalty"]) for inc in again])
        self.assertGreater(repeated["revision"], first["revision"])
        self.assertEqual(self.client.post("/api/traffic/control", json={"action": "start", "seed": -1}).status_code, 400)

    def test_priority_round_trip_and_invalid_priority(self):
        body = {"start": [30.3143, 78.0334], "destination": [30.3254, 78.0419], "priority": "high"}
        first = self.client.post("/api/route", json=body).get_json()
        self.assertEqual(first["priority"], "high")
        self.client.post("/api/incidents", json={"lat": 30.3165, "lon": 78.0322, "type": "congestion"})
        self.assertGreater(self.client.post("/api/route", json=body).get_json()["revision"], first["revision"])
        body["priority"] = "unknown"
        self.assertEqual(self.client.post("/api/route", json=body).status_code, 400)


if __name__ == "__main__":
    unittest.main()
