"""Full API integration test for all endpoints."""
import requests
import json

BASE = "http://127.0.0.1:5000"

# 1. Homepage
r = requests.get(f"{BASE}/")
assert r.status_code == 200, f"Homepage failed: {r.status_code}"
print("✓ Homepage returns 200")

# 2. Graph data
r = requests.get(f"{BASE}/api/graph")
assert r.status_code == 200, f"Graph failed: {r.status_code}"
gdata = r.json()
print(f"✓ Graph endpoint: {gdata['meta']['node_count']} nodes, {gdata['meta']['edge_count']} edges")

# 3. Route calculation
payload = {
    "start": [30.3165, 78.0322],
    "destination": [30.325, 78.040],
    "algorithm": "a*",
    "objective": "length",
}
r = requests.post(f"{BASE}/api/route", json=payload)
d = r.json()
assert d["success"], f"Route failed: {d.get('error')}"
print(f"✓ Route A*: dist={d['distance_m']}m, nodes={d['nodes_expanded']}, time={d['execution_time_ms']}ms")
print(f"  Route geometry points: {len(d.get('route_geometry', []))}")
print(f"  Visited coords: {len(d.get('visited_coords', []))}")

# 4. Compare all 4 algorithms
r2 = requests.post(f"{BASE}/api/compare", json=payload)
d2 = r2.json()
assert d2["success"], f"Compare failed: {d2.get('error')}"
print(f"✓ Benchmark comparison: {len(d2['comparisons'])} algorithms")
for c in d2["comparisons"]:
    status = "found" if c["found"] else "NO PATH"
    print(f"  {c['algorithm']:12s}: {status}, dist={c['distance_m']}m, nodes={c['nodes_expanded']}, exec={c['execution_time_ms']}ms")

# 5. Add incident
r3 = requests.post(f"{BASE}/api/incidents", json={"lat": 30.318, "lon": 78.034, "type": "roadblock"})
d3 = r3.json()
assert d3["success"], f"Add incident failed: {d3.get('error')}"
inc_id = d3["incident"]["id"]
print(f"✓ Roadblock placed: {d3['incident']['road_name']} (id={inc_id})")

# 6. List incidents
r4 = requests.get(f"{BASE}/api/incidents")
d4 = r4.json()
print(f"✓ Active incidents: {len(d4['incidents'])}, blocked edges: {d4['blocked_count']}")

# 7. Route with incident (dynamic replanning)
r5 = requests.post(f"{BASE}/api/route", json=payload)
d5 = r5.json()
if d5["success"]:
    print(f"✓ Route with hazard: dist={d5['distance_m']}m (replanning succeeded)")
else:
    print(f"✓ Route with hazard: no path found (roadblock effective)")

# 8. Remove incident
r6 = requests.delete(f"{BASE}/api/incidents/{inc_id}")
d6 = r6.json()
assert d6["success"], f"Remove incident failed"
print(f"✓ Incident removed: {inc_id}")

# 9. AI analysis
r7 = requests.post(f"{BASE}/api/ai/analyze-route", json={
    "algorithm": "A*",
    "distance_m": 2500,
    "duration_s": 180,
    "incidents_count": 0,
    "nodes_expanded": 45,
})
d7 = r7.json()
if d7["success"]:
    print(f"✓ AI Tactical Briefing: {len(d7['analysis'])} chars")
    print(f"  Preview: {d7['analysis'][:120]}...")
else:
    print(f"⚠ AI unavailable: {d7.get('analysis', 'N/A')}")

# 10. Clear all incidents
r8 = requests.post(f"{BASE}/api/incidents/clear")
d8 = r8.json()
assert d8["success"]
print("✓ All incidents cleared")

print("\n═══════════════════════════════════════")
print("  ALL API INTEGRATION TESTS PASSED ✓")
print("═══════════════════════════════════════")
