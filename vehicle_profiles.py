"""Educational vehicle assumptions; these are not real emergency driving rules."""
PROFILES = {
    "ambulance": {"label": "Ambulance", "speed_factor": 1.0, "max_kph": 50,
                  "local_delay": 1.0, "service_delay": 1.15,
                  "description": "Medical response · 50 km/h simulation cap; small service-road delay."},
    "fire": {"label": "Fire brigade", "speed_factor": 0.78, "max_kph": 40,
             "local_delay": 1.3, "service_delay": 1.8,
             "description": "Fire response · slower large vehicle; local/service roads incur extra delay."},
    "police": {"label": "Police", "speed_factor": 1.08, "max_kph": 55,
               "local_delay": 1.0, "service_delay": 1.05,
               "description": "Police response · 55 km/h simulation cap; light service-road delay."},
}


def prepare_graph(graph, unit_type, penalties):
    """Copy edge attributes per request so profiles/incidents never mutate base data."""
    profile = PROFILES[unit_type]
    result = graph.copy()
    result.graph["vehicle_max_speed_mps"] = profile["max_kph"] / 3.6
    for u, v, key, edge in result.edges(keys=True, data=True):
        highway = edge.get("highway", "")
        if isinstance(highway, list):
            highway = highway[0] if highway else ""
        delay = profile["service_delay"] if highway in ("service", "living_street") else (
            profile["local_delay"] if highway in ("residential", "unclassified") else 1.0)
        edge["vehicle_speed_factor"] = profile["speed_factor"]
        edge["vehicle_max_speed_mps"] = profile["max_kph"] / 3.6
        edge["vehicle_road_delay"] = delay
        edge["incident_metric_factor"] = penalties.get((u, v, key), penalties.get((u, v), 1.0))
    return result


def public_profile(unit_type):
    return {"type": unit_type, "label": PROFILES[unit_type]["label"],
            "description": PROFILES[unit_type]["description"], "simulated": True}
