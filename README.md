# Weather-Aware Truck Routing

React + Django app that compares three truck routes between two places, forecasts the weather each
checkpoint will see **when the truck gets there**, classifies risk with the load-aware rules from the
brief, and recommends the safest route.

**Live:** _add hosted URL_ · **Walkthrough:** _add Loom URL_

## Run locally

```bash
# API (Python 3.12+)
cd backend
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python manage.py runserver          # http://127.0.0.1:8000

# UI (Node 22+), in another terminal
cd frontend
npm install && npm run dev                    # http://localhost:5173, proxies /api to Django
```

Tests (risk thresholds, load rules, mile attribution, ranking, polyline decoding):

```bash
cd backend && .venv/bin/python manage.py test routing
```

No API keys are needed. Every upstream is a free public service.

## Deploy

`Dockerfile` builds the React app and serves it and the API from one gunicorn process (WhiteNoise
serves the static files, so there's no CORS and a single URL). On Render, Railway or Fly, point a
Docker web service at the repo. It listens on `$PORT`. Optional env: `SECRET_KEY`, `ALLOWED_HOSTS`.

## Using the app

* **Timeline:** ▶ plays the 48-hour forecast. A truck marker for each route moves to where that truck will be at that
  moment; the selected route's truck shows its mile and current risk. Each route's arrival time is marked on the slider.
* **Checkpoints:** hover or click dots on the map. Clicking a row in a route's checkpoint table flies the map there.
* **Share:** the URL holds the trip (`?from=&to=&depart=&load=&every=`) and plans it on open. **Copy link** copies it.
* Follows the system light/dark theme and reduced-motion setting, and works at phone width.

## How it works

```
React (Vite, MapLibre GL) ── POST /api/routes ──▶ Django
                                                   ├─ Valhalla (truck costing, load weight) → up to 3 routes
                                                   ├─ sample checkpoints every 10/25/50 mi with ETAs
                                                   ├─ MET Norway / Open-Meteo hourly forecast (checkpoints + corridor grid)
                                                   └─ risk.py: classify → summarize → recommend
```

| Piece | Where | Notes |
|---|---|---|
| Geocoding | Photon (`/api/geocode`) | Autocomplete via native `<datalist>`. Free text is also accepted and geocoded server-side. |
| Routing | Valhalla public server, `truck` costing | Gross weight = 35,000 lb rig + load, so weight-restricted roads are avoided. Travel times are Valhalla's truck speeds. |
| 3 options | `services.find_routes` | Valhalla alternates first. If fewer than 3 come back, a via point is offset perpendicular to the trip at ±15% and ±30% of its length (snapped to primary roads). Candidates that overlap an existing route by 80% or more are dropped. When the road network has fewer distinct routes (e.g. the Outer Banks), the UI says so. |
| ETAs | `services._profile` | Each Valhalla maneuver's drive time is spread over its shape points by distance. A checkpoint's ETA is departure plus the interpolated time at its mile. |
| Weather | MET Norway Locationforecast, with Open-Meteo hourly `wind_speed_10m`, `rain + showers` and `snowfall` | MET Norway goes first when the trip's forecast window ends within 60 h, while it still has hourly data. It answers one point per request (~0.8 s); at most 10 run at once, which keeps under its 20 req/s limit, and a trip takes ~20 s. Further out MET Norway only has 6-hour blocks, which hide short bursts of heavy rain, so Open-Meteo (hourly for 16 days, 50 points per request) goes first. Each backs up the other per 50-point batch. MET Norway's m/s become mph, and its liquid mm become rain, or snow at Open-Meteo's 7:1 ratio, according to the period's weather symbol. The UI shows which service supplied the trip's weather, because the models can disagree. Uses the forecast hour nearest each checkpoint's ETA. Cached for 30 min per location. |
| Risk | `routing/risk.py` (pure, unit-tested) | See below. |
| Heatmap | `services._corridor_grid` | Lattice points within 30 mi of any route (≤150 points), each with 49 hourly risk scores sent in one response. The timeline only changes the MapLibre heatmap layer's weight expression, blending the two nearest hours in fifths, so playback is smooth (measured ~120 fps, no frames over 34 ms) and never refetches. |

### Risk rules

* Ranges are lower-inclusive: 25 mph is Moderate, 0.25 in/hr rain is High. Rain/snow No Travel is strictly
  greater than 1.00 / 3.0, as written in the brief.
* Load rules: wind ≥55 mph is No Travel; 45–54 mph with >30,000 lb is No Travel; 35–44 mph with >40,000 lb is Severe.
* A checkpoint's level is the worst of wind (after load rules), rain and snow.
* Each mile of a route is attributed to its **nearest checkpoint**, which gives miles per level and a
  mile-weighted average level (0 = Low … 4 = No Travel).

### Recommendation

Lexicographic, in the brief's order: fewest **No Travel** miles (not in the brief, but strictly worse
than Severe), then fewest Severe miles, fewest High miles, lowest average risk, shortest travel time. Miles
are compared to 0.1 mi, average risk to 0.01 and time to 0.1 h. The card shows the first criterion that
separated the winner from the runner-up.

### Heatmap score

Continuous 0–4: each condition is linearly interpolated between its thresholds (30 mph → 1.5), the
max is taken, then clamped into the checkpoint's level band so `floor(score) == level` (load rules
included). The colors therefore line up with the checkpoint dots. Slider hour 0 is the departure hour.

## Known limits

* No Hours-of-Service breaks: ETAs assume continuous driving. Adding 30-min / 10-h rests is a function from drive time to clock time inside `plan_trip`.
* Sustained wind is classified, not gusts.
* Weather requests scale with points: one trip uses roughly 150 grid points plus its checkpoints. MET Norway handles
  ~12 points/s here; Open-Meteo's free tier allows 600 locations/min. Repeats hit the cache.
* The public Valhalla, Photon, Open-Meteo and MET Norway servers are best-effort. Calls retry 5xx errors and
  dropped connections (timeouts aren't retried), and every request has a total time limit. A trip fails only if
  both weather services fail for the same batch, or routing fails. Batches that succeeded stay cached, so a retry only
  refetches what failed.
* Departures are limited to the next 7 days, which keeps the whole trip inside the forecast window.
