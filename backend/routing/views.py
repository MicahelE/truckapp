import json
from datetime import datetime, timedelta, timezone

from django.http import JsonResponse
from django.views.decorators.http import require_GET, require_POST

from .services import UpstreamError, geocode as geocode_places, plan_trip

INTERVALS = (10, 25, 50)
MAX_LOAD_LBS = 80_000


def _error(msg, status=400):
    return JsonResponse({"error": msg}, status=status)


@require_GET
def geocode(request):
    q = request.GET.get("q", "").strip()
    if len(q) < 3:
        return JsonResponse({"results": []})
    try:
        return JsonResponse({"results": geocode_places(q)})
    except UpstreamError as e:
        return _error(f"Geocoding failed: {e}", 502)


def _place(value):
    """{"label", "lat", "lon"} as given, or the top geocoding hit for free text."""
    if isinstance(value, str):
        hits = geocode_places(value, limit=1) if value.strip() else []
        if not hits:
            raise ValueError(f"Could not find '{value}'")
        return hits[0]
    lat, lon = float(value["lat"]), float(value["lon"])
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("Coordinates out of range")
    return {"label": str(value.get("label", f"{lat:.4f}, {lon:.4f}")), "lat": lat, "lon": lon}


@require_POST
def routes(request):
    try:
        body = json.loads(request.body)
        departure = datetime.fromisoformat(body["departure"])
        if departure.tzinfo is None:
            raise ValueError("Departure needs a timezone offset")
        now = datetime.now(timezone.utc)
        if not now - timedelta(hours=1) <= departure <= now + timedelta(days=7):
            raise ValueError("Departure must be within the next 7 days (forecast range)")
        load = float(body["load_lbs"])
        if not 0 <= load <= MAX_LOAD_LBS:
            raise ValueError(f"Load must be 0–{MAX_LOAD_LBS:,} lb")
        interval = int(body.get("interval_miles", 25))
        if interval not in INTERVALS:
            raise ValueError(f"Sampling interval must be one of {INTERVALS} miles")
        origin, dest = _place(body["origin"]), _place(body["destination"])
    except (KeyError, TypeError) as e:
        return _error(f"Missing or invalid field: {e}")
    except ValueError as e:
        return _error(str(e))
    except UpstreamError as e:
        return _error(f"Geocoding failed: {e}", 502)

    try:
        trip = plan_trip(origin, dest, departure, load, interval)
    except UpstreamError as e:
        return _error(f"Routing/weather service failed: {e}", 502)
    return JsonResponse({"origin": origin, "destination": dest, "departure": departure.isoformat(), "load_lbs": load, **trip})
