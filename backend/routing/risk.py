"""Weather risk and route ranking rules from the assessment brief. Pure functions, no I/O."""

LEVELS = ("Low", "Moderate", "High", "Severe", "No Travel")
LOW, MODERATE, HIGH, SEVERE, NO_TRAVEL = range(5)

# Lower bounds of Moderate, High, Severe, No Travel. Ranges are lower-inclusive
# (25 mph is Moderate, 0.25 in/hr is High), except rain/snow No Travel which the
# brief defines as strictly greater (">1.00", ">3.0").
WIND_MPH = (25, 35, 45, 55)
RAIN_IN_HR = (0.10, 0.25, 0.50, 1.00)
SNOW_IN_HR = (0.5, 1.0, 2.0, 3.0)


def _level(value, bounds, top_inclusive=False):
    if value > bounds[3] or (top_inclusive and value == bounds[3]):
        return NO_TRAVEL
    return sum(value >= b for b in bounds[:3])


def wind_level(mph, load_lbs):
    level = _level(mph, WIND_MPH, top_inclusive=True)
    if level == SEVERE and load_lbs > 30_000:
        return NO_TRAVEL
    if level == HIGH and load_lbs > 40_000:
        return SEVERE
    return level


def classify(wind_mph, rain_in_hr, snow_in_hr, load_lbs):
    """Risk level of one checkpoint: the worst of wind (with load rules), rain and snow."""
    return max(
        wind_level(wind_mph, load_lbs),
        _level(rain_in_hr, RAIN_IN_HR),
        _level(snow_in_hr, SNOW_IN_HR),
    )


def _ramp(value, bounds):
    """0..4, linear between thresholds, so 30 mph wind -> 1.5."""
    lo = 0
    for i, hi in enumerate(bounds):
        if value < hi:
            return i + (value - lo) / (hi - lo)
        lo = hi
    return 4.0


def score(wind_mph, rain_in_hr, snow_in_hr, load_lbs):
    """Continuous 0..4 risk for the heatmap; floor(score) == classify(...)."""
    level = classify(wind_mph, rain_in_hr, snow_in_hr, load_lbs)
    raw = max(_ramp(wind_mph, WIND_MPH), _ramp(rain_in_hr, RAIN_IN_HR), _ramp(snow_in_hr, SNOW_IN_HR))
    return max(level, min(raw, level + 0.99))


def summarize(checkpoints, total_miles):
    """Miles per risk level (each mile belongs to its nearest checkpoint) and mile-weighted average level."""
    miles = [0.0] * len(LEVELS)
    marks = [c["mile"] for c in checkpoints]
    for i, c in enumerate(checkpoints):
        lo = (marks[i - 1] + marks[i]) / 2 if i else 0
        hi = (marks[i] + marks[i + 1]) / 2 if i + 1 < len(marks) else total_miles
        miles[c["level"]] += hi - lo
    avg = sum(level * m for level, m in enumerate(miles)) / total_miles if total_miles else 0
    return {"miles_by_level": [round(m, 1) for m in miles], "avg_risk": round(avg, 2)}


# Brief order: fewest Severe miles, fewest High miles, lowest average risk, shortest time.
# No Travel isn't listed; it is worse than Severe, so it ranks first.
CRITERIA = (
    ("Fewer No Travel miles", lambda r: r["miles_by_level"][NO_TRAVEL], "{} mi"),
    ("Fewer Severe miles", lambda r: r["miles_by_level"][SEVERE], "{} mi"),
    ("Fewer High miles", lambda r: r["miles_by_level"][HIGH], "{} mi"),
    ("Lower average risk", lambda r: r["avg_risk"], "{}"),
    ("Shorter travel time", lambda r: round(r["duration_s"] / 3600, 1), "{} h"),
)


def recommend(routes):
    """Index of the best route and a one-line reason (the first criterion that beat the runner-up)."""
    order = sorted(range(len(routes)), key=lambda i: (*(f(routes[i]) for _, f, _ in CRITERIA), routes[i]["duration_s"]))
    best = order[0]
    if len(order) == 1:
        return best, "Only route found."
    runner = order[1]
    for phrase, f, unit in CRITERIA:
        a, b = f(routes[best]), f(routes[runner])
        if a != b:
            return best, f"{phrase}: {unit.format(a)} vs {unit.format(b)} on Route {'ABC'[runner]}."
    return best, "Routes are equivalent on risk; fastest listed first."
