"""Third-party calls (Photon geocoding, Valhalla truck routing, Open-Meteo forecasts) and route sampling."""

import bisect
import itertools
import json
import math
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from django.core.cache import cache

from . import risk

PHOTON = "https://photon.komoot.io/api/"
VALHALLA = "https://valhalla1.openstreetmap.de/route"
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
HEADERS = {"User-Agent": "truckapp-assessment/1.0", "Content-Type": "application/json"}

EMPTY_RIG_LBS = 35_000  # tractor + empty trailer; Valhalla wants gross weight
HEATMAP_HOURS = 48
DETOURS = (0.15, -0.15, 0.3, -0.3)  # via-point offsets (share of trip length) when Valhalla returns < 3 routes


class UpstreamError(Exception):
    pass


def _fetch(url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data, HEADERS), timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            body = json.load(e)
            msg = body.get("reason") or body.get("error")  # Open-Meteo / Valhalla error shapes
        except ValueError:
            msg = None
        raise UpstreamError(msg if isinstance(msg, str) else str(e)) from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise UpstreamError(str(e)) from e


def geocode(query, limit=5):
    key = f"geo:{limit}:{urllib.parse.quote(query.lower())}"
    if (hit := cache.get(key)) is not None:
        return hit
    data = _fetch(PHOTON + "?" + urllib.parse.urlencode({"q": query, "limit": limit}))
    places = []
    for f in data["features"]:
        p = f["properties"]
        name = p.get("name") or " ".join(filter(None, (p.get("housenumber"), p.get("street"))))
        parts = (name, p.get("city"), p.get("state"), p.get("country"))
        label = ", ".join(dict.fromkeys(filter(None, parts)))
        if all(label != q["label"] for q in places):  # Photon often returns a city as both node and boundary
            lon, lat = f["geometry"]["coordinates"]
            places.append({"label": label, "lat": lat, "lon": lon})
    cache.set(key, places, 86400)
    return places


# --- geometry ---------------------------------------------------------------


def _miles(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 7917.6 * math.asin(math.sqrt(h))  # Earth diameter in miles


def decode_polyline6(s):
    nums, cur, shift = [], 0, 0
    for ch in s:
        b = ord(ch) - 63
        cur |= (b & 0x1F) << shift
        shift += 5
        if b < 0x20:
            nums.append(~(cur >> 1) if cur & 1 else cur >> 1)
            cur = shift = 0
    lats, lons = itertools.accumulate(nums[::2]), itertools.accumulate(nums[1::2])
    return [(lat / 1e6, lon / 1e6) for lat, lon in zip(lats, lons)]


def _marks(total, step):
    """Mile marks 0, step, 2*step, ... plus the destination."""
    marks = [i * step for i in range(int(total // step) + 1)]
    return marks + [total] if total - marks[-1] > 0.01 else marks


def _at(route, mile):
    """Interpolated ((lat, lon), seconds from departure) at a distance along the route."""
    m, s, pts = route["miles"], route["secs"], route["pts"]
    i = min(max(bisect.bisect_right(m, mile), 1), len(m) - 1)
    t = (mile - m[i - 1]) / ((m[i] - m[i - 1]) or 1)
    (la1, lo1), (la2, lo2) = pts[i - 1], pts[i]
    return (la1 + t * (la2 - la1), lo1 + t * (lo2 - lo1)), s[i - 1] + t * (s[i] - s[i - 1])


def _overlap(a, b):
    """Share of route a's 5-mile samples lying within ~1.5 miles of route b."""
    cells = {(round(lat * 50), round(lon * 50)) for lat, lon in (_at(b, m)[0] for m in _marks(b["miles"][-1], 0.5))}
    samples = [_at(a, m)[0] for m in _marks(a["miles"][-1], 5)]
    near = sum(
        any((round(lat * 50) + i, round(lon * 50) + j) in cells for i in (-1, 0, 1) for j in (-1, 0, 1))
        for lat, lon in samples
    )
    return near / len(samples)


# --- routing ------------------------------------------------------------------


def _profile(trip):
    """Valhalla trip -> shape points with cumulative miles and drive seconds per point."""
    leg = trip["legs"][0]  # no "break" via points are used, so a trip is always one leg
    pts = decode_polyline6(leg["shape"])
    seg = [_miles(a, b) for a, b in zip(pts, pts[1:])]
    secs = [0.0] * len(pts)
    # Maneuvers carry drive time over a shape range; spread it by distance within the range.
    for man in leg["maneuvers"]:
        b, e = man["begin_shape_index"], man["end_shape_index"]
        dist = sum(seg[b:e])
        for k in range(b, e):
            secs[k + 1] = secs[k] + man["time"] * (seg[k] / dist if dist else 1 / (e - b))
    return {"pts": pts, "miles": list(itertools.accumulate(seg, initial=0.0)), "secs": secs}


def _join(a, b):
    m0, s0 = a["miles"][-1], a["secs"][-1]
    return {
        "pts": a["pts"] + b["pts"][1:],
        "miles": a["miles"] + [m + m0 for m in b["miles"][1:]],
        "secs": a["secs"] + [s + s0 for s in b["secs"][1:]],
    }


def _valhalla(locations, load_lbs, alternates=0):
    """Truck routes between (lat, lon) tuples or ready-made Valhalla location dicts."""
    body = {
        "locations": [p if isinstance(p, dict) else {"lat": p[0], "lon": p[1]} for p in locations],
        "costing": "truck",
        "costing_options": {"truck": {"weight": round((EMPTY_RIG_LBS + load_lbs) / 2204.6, 1)}},
        "alternates": alternates,
        "directions_type": "maneuvers",
    }
    data = _fetch(VALHALLA, body)
    return [_profile(t) for t in (data["trip"], *(a["trip"] for a in data.get("alternates", ())))]


def _detour(route, origin, dest, offset):
    """Via point off the route's midpoint, perpendicular to the origin->destination line."""
    (lat, lon), _ = _at(route, route["miles"][-1] / 2)
    kx = math.cos(math.radians(lat))
    dx, dy = (dest[1] - origin[1]) * kx, dest[0] - origin[0]
    # Snap to primary roads or bigger so the detour doesn't end in a dead-end spur.
    return {"lat": lat + offset * dx, "lon": lon - offset * dy / kx, "search_filter": {"min_road_class": "primary"}}


def find_routes(origin, dest, load_lbs):
    routes = _valhalla([origin, dest], load_lbs, alternates=2)
    for offset in DETOURS:
        if len(routes) >= 3:
            break
        via = _detour(routes[0], origin, dest, offset)
        try:
            r = _valhalla([origin, {**via, "type": "through"}, dest], load_lbs)[0]
        except UpstreamError:  # public server caps multi-stop routes at 1500 km; route the legs separately
            try:
                r = _join(_valhalla([origin, via], load_lbs)[0], _valhalla([via, dest], load_lbs)[0])
            except UpstreamError:
                continue
        if all(_overlap(r, other) < 0.8 for other in routes):
            routes.append(r)
    return routes[:3]


# --- weather ------------------------------------------------------------------


def _forecast(points, start, hours):
    """Hourly (wind mph, rain in/hr, snow in/hr) for each point from `start`, cached per rounded point."""
    keys = [f"wx:{lat:.2f},{lon:.2f}:{start:%Y%m%d%H}:{hours}" for lat, lon in points]
    found = cache.get_many(keys)
    missing = list({k: p for k, p in zip(keys, points) if k not in found}.items())

    def fetch(chunk):
        params = {
            "latitude": ",".join(f"{p[0]:.2f}" for _, p in chunk),
            "longitude": ",".join(f"{p[1]:.2f}" for _, p in chunk),
            "hourly": "wind_speed_10m,rain,showers,snowfall",
            "wind_speed_unit": "mph",
            "precipitation_unit": "inch",  # also makes snowfall inches
            "timezone": "GMT",
            "start_hour": f"{start:%Y-%m-%dT%H:%M}",
            "end_hour": f"{start + timedelta(hours=hours):%Y-%m-%dT%H:%M}",
        }
        data = _fetch(OPEN_METEO + "?" + urllib.parse.urlencode(params))
        out = {}
        for (key, _), loc in zip(chunk, data if isinstance(data, list) else [data]):
            h = loc["hourly"]
            # ponytail: a null hour (past the model horizon) reads as calm; departures are capped at 7 days out
            out[key] = [
                (h["wind_speed_10m"][i] or 0, (h["rain"][i] or 0) + (h["showers"][i] or 0), h["snowfall"][i] or 0)
                for i in range(len(h["time"]))
            ]
        return out

    with ThreadPoolExecutor(4) as pool:
        for got in pool.map(fetch, [missing[i : i + 100] for i in range(0, len(missing), 100)]):
            cache.set_many(got, 1800)
            found.update(got)
    return [found[k] for k in keys]


# ponytail: capped so a trip stays well under Open-Meteo's free 600 locations/minute; raise with a paid key
def _corridor_grid(routes, buffer_mi=30, max_points=150):
    """Lattice points within `buffer_mi` of any route, coarsened until there are at most `max_points`."""
    samples = [_at(r, m)[0] for r in routes for m in _marks(r["miles"][-1], 10)]
    kx = math.cos(math.radians(sum(lat for lat, _ in samples) / len(samples)))
    step = 0.2
    while True:
        reach = math.ceil(buffer_mi / 69 / step)
        cells = set()
        for lat, lon in samples:
            i0, j0 = round(lat / step), round(lon * kx / step)
            for i in range(i0 - reach, i0 + reach + 1):
                for j in range(j0 - reach, j0 + reach + 1):
                    if _miles((lat, lon), (i * step, j * step / kx)) <= buffer_mi:
                        cells.add((i, j))
        if len(cells) <= max_points:
            return [(i * step, j * step / kx) for i, j in cells], step
        step *= 1.4


# --- trip planning ------------------------------------------------------------


def plan_trip(origin, dest, departure, load_lbs, interval_miles):
    routes = find_routes((origin["lat"], origin["lon"]), (dest["lat"], dest["lon"]), load_lbs)
    start = departure.replace(minute=0, second=0, microsecond=0)
    lead = (departure - start).total_seconds()
    hours = max(HEATMAP_HOURS, math.ceil((lead + max(r["secs"][-1] for r in routes)) / 3600))

    for r in routes:
        r["cps"] = [(m, *_at(r, m)) for m in _marks(r["miles"][-1], interval_miles)]
    grid, step = _corridor_grid(routes)
    weather = iter(_forecast([pt for r in routes for _, pt, _ in r["cps"]] + grid, start, hours))

    out = []
    for r in routes:
        checkpoints = []
        for mile, (lat, lon), secs in r["cps"]:
            wind, rain, snow = next(weather)[round((lead + secs) / 3600)]  # nearest forecast hour to the ETA
            checkpoints.append({
                "mile": round(mile, 1),
                "lat": round(lat, 5),
                "lon": round(lon, 5),
                "eta": (departure + timedelta(seconds=round(secs))).isoformat(),
                "wind_mph": round(wind, 1),
                "rain_in_hr": round(rain, 3),
                "snow_in_hr": round(snow, 2),
                "level": risk.classify(wind, rain, snow, load_lbs),
            })
        total, duration = r["miles"][-1], r["secs"][-1]
        # ponytail: drop shape points closer than 0.1 mi for the map; Douglas-Peucker if corners look cut
        last, geometry = -1.0, []
        for (lat, lon), m in zip(r["pts"], r["miles"]):
            if m - last >= 0.1 or m == total:
                geometry.append([round(lon, 5), round(lat, 5)])
                last = m
        out.append({
            "distance_mi": round(total, 1),
            "duration_s": round(duration),
            "arrival": (departure + timedelta(seconds=round(duration))).isoformat(),
            "geometry": geometry,
            "checkpoints": checkpoints,
            **risk.summarize(checkpoints, total),
        })

    best, reason = risk.recommend(out)
    heat = [
        [round(lon, 3), round(lat, 3), *(round(risk.score(*w, load_lbs), 1) for w in series[: HEATMAP_HOURS + 1])]
        for (lat, lon), series in zip(grid, weather)
    ]
    return {
        "routes": out,
        "recommended": best,
        "reason": reason,
        "heatmap": {"start": start.isoformat(), "step_deg": round(step, 3), "points": heat},
    }
