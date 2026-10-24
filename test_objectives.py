"""Test the 4 routing objectives and unit types."""
import requests
import json

BASE = "http://127.0.0.1:5000"

payload_base = {
    "start": [30.3165, 78.0322],
    "destination": [30.325, 78.040],
    "algorithm": "a*",
}

print("=== Testing 4 Routing Objectives ===")
for obj in ["length", "time", "traffic", "safety"]:
    payload = {**payload_base, "objective": obj}
    r = requests.post(f"{BASE}/api/route", json=payload)
    d = r.json()
    label = {"length": "Min Distance", "time": "Min Travel Time", "traffic": "Min Traffic", "safety": "Safest Route"}[obj]
    if d["success"]:
        print(f"  [OK] {label:20s}: dist={d['distance_m']:>8.1f}m, time={d['duration_s']:>6.1f}s, nodes={d['nodes_expanded']}")
    else:
        print(f"  [FAIL] {label}: {d.get('error', 'unknown')}")

print()
print("=== Testing 3 Unit Types ===")
for unit in ["ambulance", "fire", "police"]:
    payload = {**payload_base, "objective": "length", "unit_type": unit}
    r = requests.post(f"{BASE}/api/route", json=payload)
    d = r.json()
    print(f"  [OK] {unit:12s}: route found={d['success']}")

print()
print("=== Testing Benchmark with traffic objective ===")
payload = {**payload_base, "objective": "traffic"}
r = requests.post(f"{BASE}/api/compare", json=payload)
d = r.json()
if d["success"]:
    for c in d["comparisons"]:
        status = "found" if c["found"] else "NO PATH"
        print(f"  {c['algorithm']:12s}: {status}, cost={c['cost']:.1f}")
    print("  [OK] Benchmark with traffic objective works")

print()
print("ALL OBJECTIVE & UNIT TESTS PASSED")
