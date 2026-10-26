"""Shared, request-driven multi-agent simulation with a priority dispatcher."""
import copy
import math
import random
import time
from uuid import uuid4

from algorithms import haversine_distance_m

PRIORITIES = {"critical": 0, "high": 1, "medium": 2, "low": 3}


class Simulation:
    def __init__(self, depots, planner, conditions, generate_traffic, clear_traffic, clock=time.monotonic):
        self.depots = copy.deepcopy(depots)
        self.planner, self.conditions = planner, conditions
        self.generate_traffic, self.clear_traffic = generate_traffic, clear_traffic
        self.clock = clock
        self.instance_id = uuid4().hex
        self.running, self.speed = False, 30
        self.traffic = {"running": False, "seed": 42, "interval_s": 10, "ticks": 0}
        self.rng = random.Random(42)
        self.traffic_elapsed = 0
        self.requests, self.events = [], []
        self.counter = self.event_counter = self.snapshot_counter = 0
        self.dirty, self.dispatch_dirty = False, False
        self.units = []
        self.last = clock()
        self._reset_units()

    def _reset_units(self):
        self.units = [{**copy.deepcopy(depot), "phase": "idle", "request_id": None,
                       "legs": [], "index": 0, "leg_elapsed": 0, "elapsed_s": 0,
                       "distance_m": 0, "replans": 0, "resume_paused": False, "message": "Available", "_motion": []}
                      for depot in self.depots]

    def _event(self, message):
        self.event_counter += 1
        self.events.append({"id": self.event_counter, "message": message})
        self.events = self.events[-40:]

    def edit_unit(self, action, unit_id=None, kind=None, position=None):
        """Edit available resources; assigned missions must be cancelled first."""
        self.advance()
        if action not in ("add", "move", "remove"):
            raise ValueError("Choose add, move or remove.")
        unit = next((item for item in self.units if item["id"] == unit_id), None)
        if action != "add":
            if unit is None:
                raise ValueError("Vehicle no longer exists.")
            if unit["request_id"]:
                raise ValueError("Cancel this vehicle's mission before moving or removing it.")
        if action in ("add", "move"):
            if not isinstance(position, (list, tuple)) or len(position) != 2:
                raise ValueError("Choose a vehicle position on the map.")
            position = [float(value) for value in position]
            if not all(math.isfinite(value) for value in position):
                raise ValueError("Vehicle position must be finite.")
        if action == "add":
            if kind not in ("ambulance", "fire", "police"):
                raise ValueError("Choose ambulance, fire, or police.")
            number = 1
            # Never reuse an id referenced by completed requests or existing resources.
            used = {item["id"] for item in self.depots} | {job["unit_id"] for job in self.requests}
            used.update(getattr(self, "retired_units", set()))
            while f"{kind}-{number}" in used:
                number += 1
            unit_id = f"{kind}-{number}"
            depot = {"id": unit_id, "type": kind, "label": f"{ {'ambulance': 'Ambulance', 'fire': 'Fire brigade', 'police': 'Police'}[kind]} {number}", "position": position[:]}
            self.depots.append(depot)
            unit = {**copy.deepcopy(depot), "phase": "idle", "request_id": None, "legs": [],
                    "index": 0, "leg_elapsed": 0, "elapsed_s": 0, "distance_m": 0,
                    "replans": 0, "resume_paused": False, "message": "Available", "_motion": []}
            self.units.append(unit)
        elif action == "move":
            unit.update(position=position[:], legs=[], index=0, leg_elapsed=0, elapsed_s=0,
                        distance_m=0, replans=0, _motion=[], message="Available")
            next(item for item in self.depots if item["id"] == unit_id)["position"] = position[:]
        else:
            self.units.remove(unit)
            self.depots = [item for item in self.depots if item["id"] != unit_id]
            if not hasattr(self, "retired_units"):
                self.retired_units = set()
            self.retired_units.add(unit_id)
        self._event(f"{unit['label']}: { {'add': 'added', 'move': 'position updated', 'remove': 'removed'}[action]}")
        self.dispatch_dirty = True
        self._dispatch()
        return unit_id

    def environment_changed(self):
        self.dirty = self.dispatch_dirty = True

    @staticmethod
    def _legs(legs):
        result = copy.deepcopy(legs)
        for leg in result:
            lengths = [0]
            for a, b in zip(leg["geometry"], leg["geometry"][1:]):
                lengths.append(lengths[-1] + haversine_distance_m(*a, *b))
            leg["_lengths"] = lengths
        return result

    @staticmethod
    def _point(leg, fraction):
        points, lengths = leg["geometry"], leg["_lengths"]
        target = lengths[-1] * fraction
        index = 0
        while index + 1 < len(points) and lengths[index + 1] <= target:
            index += 1
        if index + 1 == len(points):
            return list(points[-1]), [list(points[-1])]
        span = lengths[index + 1] - lengths[index]
        t = (target - lengths[index]) / span if span else 1
        point = [points[index][j] + (points[index + 1][j] - points[index][j]) * t for j in (0, 1)]
        return point, [point, *points[index + 1:]]

    def _plan(self, unit, job):
        """Preserve an occupied directed road before planning from its next junction."""
        leg = unit["legs"][unit["index"]] if unit["index"] < len(unit["legs"]) else None
        partial = leg and (unit["leg_elapsed"] > 0 or leg.get("started_mid_edge"))
        prefix = None
        if partial:
            blocked, penalties = self.conditions()
            edge = tuple(map(str, leg["edge"]))
            if edge in blocked:
                return None, "Current road closed; waiting for clearance"
            fraction = unit["leg_elapsed"] / leg["duration_s"] if leg["duration_s"] else 1
            multiplier = penalties.get(edge, 1)
            _, tail = self._point(leg, fraction)
            prefix = {key: value for key, value in leg.items() if not key.startswith("_")}
            prefix.update(geometry=tail, distance_m=leg["distance_m"] * (1 - fraction),
                          duration_s=(leg["duration_s"] - unit["leg_elapsed"]) * multiplier / leg.get("incident_multiplier", 1),
                          incident_multiplier=multiplier, started_mid_edge=True)
        origin = prefix["geometry"][-1] if prefix else unit["position"]
        route = self.planner({"start": origin, "destination": job["destination"], "unit_type": unit["type"],
                              "priority": job["priority"], "algorithm": job["algorithm"], "objective": job["objective"]})
        if not route.get("success"):
            return None, "No passable route; waiting for road changes"
        legs = ([prefix] if prefix else []) + route["journey_segments"]
        return {"legs": self._legs(legs), "eta_s": sum(leg["duration_s"] for leg in legs),
                "destination": route["destination"]["snapped"]}, None

    def queue(self, payload):
        self.advance()
        priority, kind = payload.get("priority", "critical"), payload.get("unit_type", "ambulance")
        if not isinstance(priority, str) or priority not in PRIORITIES:
            raise ValueError("Choose critical, high, medium, or low priority.")
        if kind not in ("ambulance", "fire", "police"):
            raise ValueError("Choose ambulance, fire, or police.")
        destination = payload.get("destination")
        if not isinstance(destination, (list, tuple)) or len(destination) != 2:
            raise ValueError("Select an emergency destination first.")
        try:
            destination = [float(value) for value in destination]
        except (TypeError, ValueError):
            raise ValueError("Destination must contain numeric coordinates.") from None
        if not all(math.isfinite(value) for value in destination):
            raise ValueError("Destination must contain finite coordinates.")
        if payload.get("algorithm", "a*") not in ("a*", "dijkstra", "bfs", "dfs"):
            raise ValueError("Unsupported search algorithm.")
        if payload.get("objective", "time") not in ("time", "length", "traffic", "safety"):
            raise ValueError("Unsupported routing objective.")
        self.counter += 1
        job = {"id": f"R{self.counter}", "sequence": self.counter, "priority": priority, "unit_type": kind,
               "destination": destination, "algorithm": payload.get("algorithm", "a*"),
               "objective": payload.get("objective", "time"), "status": "queued", "unit_id": None,
               "created": self.clock(), "wait_s": 0, "message": "Awaiting suitable unit"}
        self.requests.append(job)
        self.dispatch_dirty = True
        self._event(f"{job['id']} queued: {priority} {kind} request")
        self._dispatch()
        return job["id"]

    def _dispatch(self):
        if not self.running or not self.dispatch_dirty:
            return
        self.dispatch_dirty = False
        queue = sorted((job for job in self.requests if job["status"] == "queued"),
                       key=lambda job: (PRIORITIES[job["priority"]], job["sequence"]))
        for job in queue:
            choices = []
            for unit in self.units:
                if unit["phase"] == "idle" and unit["type"] == job["unit_type"]:
                    plan, reason = self._plan(unit, job)
                    if plan:
                        choices.append((plan["eta_s"], unit["id"], unit, plan))
                    else:
                        job["message"] = reason
            if not choices:
                continue
            eta, _, unit, plan = min(choices, key=lambda item: (item[0], item[1]))
            job.update(status="assigned", unit_id=unit["id"], wait_s=max(0, self.clock() - job["created"]),
                       message=f"Assigned to {unit['label']} (ETA {eta / 60:.1f} min)")
            unit.update(phase="enroute", request_id=job["id"], legs=plan["legs"], index=0, leg_elapsed=0,
                        elapsed_s=0, distance_m=0, replans=0, resume_paused=False,
                        destination=plan["destination"], message=f"En route to {job['id']}",
                        _motion=[{"time_s": 0, "position": list(unit["position"])}])
            self._event(f"{job['id']} ({job['priority']}) assigned to {unit['label']} by minimum compatible ETA")
            if not unit["legs"]:
                self._arrive(unit)

    def _arrive(self, unit):
        job = next(job for job in self.requests if job["id"] == unit["request_id"])
        job.update(status="completed", message=f"Completed by {unit['label']}")
        unit.update(position=list(unit["destination"]), phase="idle", request_id=None,
                    legs=[], index=0, leg_elapsed=0, message=f"Arrived at {job['id']} · Available")
        self._event(f"{unit['label']} completed {job['id']}")
        self.dispatch_dirty = True

    def _replan(self):
        if not self.dirty:
            return
        self.dirty = False
        for unit in self.units:
            if unit["phase"] == "idle":
                continue
            job = next(job for job in self.requests if job["id"] == unit["request_id"])
            plan, reason = self._plan(unit, job)
            if not plan:
                unit.update(phase="waiting", message=reason)
                continue
            unit.update(legs=plan["legs"], index=0, leg_elapsed=0,
                        phase="paused" if unit["resume_paused"] else "enroute", message="Route updated from current position")
            unit["replans"] += 1
            self._event(f"{unit['label']} replanned for shared road changes")

    def advance(self):
        now = self.clock()
        delta = max(0, min(now - self.last, 2))
        self.last = now
        if self.traffic["running"]:
            self.traffic_elapsed += delta
            if self.traffic_elapsed >= self.traffic["interval_s"]:
                self.traffic_elapsed %= self.traffic["interval_s"]
                self._traffic_step()
        self._replan()
        self._dispatch()
        if not self.running:
            return
        for unit in self.units:
            if unit["phase"] != "enroute":
                continue
            budget = delta * self.speed
            while budget > 0 and unit["index"] < len(unit["legs"]):
                leg = unit["legs"][unit["index"]]
                before_time, before_leg = unit["elapsed_s"], unit["leg_elapsed"]
                step = min(budget, max(0, leg["duration_s"] - unit["leg_elapsed"]))
                unit["leg_elapsed"] += step
                unit["elapsed_s"] += step
                unit["distance_m"] += leg["distance_m"] * step / leg["duration_s"] if leg["duration_s"] else leg["distance_m"]
                budget -= step
                fraction = unit["leg_elapsed"] / leg["duration_s"] if leg["duration_s"] else 1
                # Retain the road vertices actually crossed, not a straight chord between polls.
                length = leg["_lengths"][-1]
                if length and leg["duration_s"]:
                    for point, distance in zip(leg["geometry"], leg["_lengths"]):
                        vertex_time = leg["duration_s"] * distance / length
                        if before_leg < vertex_time < unit["leg_elapsed"]:
                            unit["_motion"].append({"time_s": before_time + vertex_time - before_leg,
                                                    "position": list(point)})
                unit["position"], _ = self._point(leg, fraction)
                unit["_motion"].append({"time_s": unit["elapsed_s"], "position": list(unit["position"])})
                if unit["leg_elapsed"] >= leg["duration_s"]:
                    unit["index"] += 1
                    unit["leg_elapsed"] = 0
            # Bounded authoritative history supports smooth rendering without predicting through closures.
            cutoff = unit["elapsed_s"] - 180
            unit["_motion"] = [sample for sample in unit["_motion"] if sample["time_s"] >= cutoff][-1024:]
            if unit["index"] >= len(unit["legs"]):
                self._arrive(unit)
        self._dispatch()

    def _traffic_step(self):
        self.traffic["ticks"] += 1
        self.generate_traffic(self.rng, self.traffic["ticks"])
        self.environment_changed()
        self._event(f"Traffic environment updated (tick {self.traffic['ticks']})")

    def traffic_control(self, payload):
        self.advance()
        action = payload.get("action")
        if action not in ("start", "pause", "reset"):
            raise ValueError("Choose start, pause, or reset traffic.")
        if action == "reset":
            self.traffic.update(running=False, ticks=0)
            self.traffic_elapsed = 0
            self.rng = random.Random(self.traffic["seed"])
            self.clear_traffic()
            self.environment_changed()
        elif action == "pause":
            self.traffic["running"] = False
        else:
            interval, seed = int(payload.get("interval_s", self.traffic["interval_s"])), int(payload.get("seed", self.traffic["seed"]))
            if interval not in (5, 10, 20) or not 0 <= seed <= 4294967295:
                raise ValueError("Traffic interval must be 5, 10 or 20 seconds; seed must be 0–4294967295.")
            if seed != self.traffic["seed"] and self.traffic["ticks"]:
                raise ValueError("Reset traffic before changing the seed.")
            self.traffic.update(running=True, seed=seed, interval_s=interval)
            if not self.traffic["ticks"]:
                self.rng = random.Random(seed)
                self._traffic_step()
        self._replan()
        self._dispatch()

    def control(self, payload):
        self.advance()
        action = payload.get("action")
        if action not in ("start", "pause", "reset", "speed"):
            raise ValueError("Choose start, pause, reset or speed.")
        speed = int(payload.get("speed", self.speed))
        if speed not in (10, 30, 60):
            raise ValueError("Fleet speed must be 10, 30 or 60.")
        if action == "reset":
            self.running = False
            self.requests.clear()
            self._reset_units()
            self._event("Fleet reset; all units returned to simulated depots")
        elif action == "pause":
            self.running = False
        elif action == "start":
            self.running, self.dispatch_dirty = True, True
            self.dirty = True
        self.speed = speed
        self._replan()
        self._dispatch()

    def unit_control(self, unit_id, action):
        self.advance()
        unit = next((unit for unit in self.units if unit["id"] == unit_id), None)
        if unit is None or action not in ("pause", "resume", "cancel"):
            raise ValueError("Choose a valid unit and pause, resume or cancel action.")
        if unit["phase"] == "idle":
            return
        if action == "cancel":
            job = next(job for job in self.requests if job["id"] == unit["request_id"])
            job.update(status="cancelled", message="Mission cancelled")
            unit.update(phase="idle", request_id=None, message="Available", resume_paused=False)
            self.dispatch_dirty = True
        elif action == "pause":
            unit["resume_paused"] = True
            if unit["phase"] != "waiting":
                unit.update(phase="paused", message="Unit paused")
        else:
            unit["resume_paused"] = False
            self.dirty = True  # Always revalidate closures before resuming movement.
        self._replan()
        self._dispatch()

    def cancel_request(self, request_id):
        self.advance()
        job = next((job for job in self.requests if job["id"] == request_id), None)
        if job is None:
            raise ValueError("Unknown emergency request.")
        if job["status"] == "assigned":
            self.unit_control(job["unit_id"], "cancel")
        elif job["status"] == "queued":
            job.update(status="cancelled", message="Cancelled before assignment", wait_s=max(0, self.clock() - job["created"]))

    def snapshot(self):
        self.advance()
        units = []
        for unit in self.units:
            remaining_s = remaining_m = 0
            for index, leg in enumerate(unit["legs"]):
                if index < unit["index"]:
                    continue
                fraction = 1 - unit["leg_elapsed"] / leg["duration_s"] if index == unit["index"] and leg["duration_s"] else 1
                remaining_s += leg["duration_s"] * fraction
                remaining_m += leg["distance_m"] * fraction
            public = {key: copy.deepcopy(value) for key, value in unit.items()
                      if key not in ("legs", "index", "leg_elapsed", "resume_paused", "_motion")}
            public.update(remaining_s=remaining_s if unit["request_id"] else 0,
                          remaining_m=remaining_m if unit["request_id"] else 0,
                          motion_trace=copy.deepcopy(unit["_motion"]),
                          current_edge=unit["legs"][unit["index"]]["edge"] if unit["request_id"] and unit["index"] < len(unit["legs"]) else None,
                          current_road=unit["legs"][unit["index"]]["geometry"] if unit["request_id"] and unit["index"] < len(unit["legs"]) else [],
                          route_geometry=[point for leg in unit["legs"][unit["index"]:] for point in leg["geometry"]]
                          if unit["request_id"] else [])
            units.append(public)
        requests = []
        for job in sorted(self.requests, key=lambda item: (PRIORITIES[item["priority"]], item["sequence"])):
            public = {key: value for key, value in job.items() if key != "created"}
            if job["status"] == "queued":
                public["wait_s"] = max(0, self.clock() - job["created"])
            requests.append(public)
        self.snapshot_counter += 1
        return {"instance_id": self.instance_id, "sequence": self.snapshot_counter, "running": self.running, "speed": self.speed, "units": units, "requests": requests,
                "traffic": dict(self.traffic), "events": list(self.events)}
