"""Display-only OpenStreetMap roads surrounding the routing sector."""
import json
import threading
from pathlib import Path

import requests

_lock = threading.Lock()
_memory = {}
CONTEXT_DISTANCE_M = 7000


def load_context(center, working_bounds, cache_dir):
    """Cache the larger backdrop separately; never replace the routing graph."""
    cache = Path(cache_dir) / f"dehradun_context_{center[0]}_{center[1]}_{CONTEXT_DISTANCE_M}m.geojson"
    with _lock:
        if str(cache) in _memory:
            return _memory[str(cache)]
        if cache.exists():
            try:
                result = cache.read_text(encoding="utf-8")
                json.loads(result)
                _memory[str(cache)] = result
                return result
            except ValueError:
                pass  # Replace an incomplete/corrupt cache after a successful download.
        south, west = working_bounds[0]
        north, east = working_bounds[1]
        # Twice the existing half-width, without changing the selectable sector.
        bounds = [[center[0] + 2 * (south - center[0]), center[1] + 2 * (west - center[1])],
                  [center[0] + 2 * (north - center[0]), center[1] + 2 * (east - center[1])]]
        bbox = f"{bounds[0][0]},{bounds[0][1]},{bounds[1][0]},{bounds[1][1]}"
        query = ('[out:json][timeout:25];way["highway"~'
                 '"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service)(_link)?$"]'
                 f'({bbox});out geom;')
        error = None
        for endpoint in ("https://maps.mail.ru/osm/tools/overpass/api/interpreter",
                         "https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"):
            try:
                response = requests.get(endpoint, params={"data": query}, timeout=35)
                response.raise_for_status()
                features = []
                for way in response.json().get("elements", []):
                    coords = [[round(p["lon"], 6), round(p["lat"], 6)] for p in way.get("geometry", [])]
                    if len(coords) > 1:
                        features.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords},
                                         "properties": {"id": str(way["id"])}})
                if not features:
                    raise ValueError("No surrounding road geometry returned.")
                result = json.dumps({"type": "FeatureCollection", "features": features,
                                     "meta": {"bounds": bounds, "working_bounds": working_bounds, "context_only": True}},
                                    separators=(",", ":"), allow_nan=False)
                cache.parent.mkdir(parents=True, exist_ok=True)
                temporary = cache.with_suffix(".tmp")
                temporary.write_text(result, encoding="utf-8")
                temporary.replace(cache)
                _memory[str(cache)] = result
                return result
            except (requests.RequestException, ValueError) as exc:
                error = exc
        raise RuntimeError("Surrounding road graph temporarily unavailable.") from error
