import io
import urllib.error
from unittest import mock

from datetime import datetime, timedelta, timezone

from django.core.cache import cache
from django.test import SimpleTestCase

from .risk import HIGH, LOW, MODERATE, NO_TRAVEL, SEVERE, classify, recommend, score, summarize
from .services import UpstreamError, _fetch, _forecast, _met_no_throttle, decode_polyline6, met_no_hourly


class RiskRules(SimpleTestCase):
    def test_thresholds(self):
        cases = [
            ((24.9, 0, 0), LOW), ((25, 0, 0), MODERATE), ((34.9, 0, 0), MODERATE), ((35, 0, 0), HIGH),
            ((45, 0, 0), SEVERE), ((55, 0, 0), NO_TRAVEL),
            ((0, 0.09, 0), LOW), ((0, 0.10, 0), MODERATE), ((0, 0.25, 0), HIGH), ((0, 1.00, 0), SEVERE),
            ((0, 1.01, 0), NO_TRAVEL),
            ((0, 0, 0.49), LOW), ((0, 0, 0.5), MODERATE), ((0, 0, 2.0), SEVERE), ((0, 0, 3.0), SEVERE),
            ((0, 0, 3.1), NO_TRAVEL),
            ((30, 0.3, 0), HIGH),  # worst condition wins
        ]
        for args, level in cases:
            self.assertEqual(classify(*args, load_lbs=0), level, args)

    def test_load_rules(self):
        self.assertEqual(classify(45, 0, 0, 30_000), SEVERE)
        self.assertEqual(classify(45, 0, 0, 30_001), NO_TRAVEL)
        self.assertEqual(classify(54.9, 0, 0, 30_001), NO_TRAVEL)
        self.assertEqual(classify(35, 0, 0, 40_000), HIGH)
        self.assertEqual(classify(35, 0, 0, 40_001), SEVERE)
        self.assertEqual(classify(34.9, 0, 0, 80_000), MODERATE)

    def test_heatmap_score_matches_level(self):
        for wind in range(0, 70, 3):
            for rain in (0, 0.1, 0.3, 0.7, 1.0, 1.5):
                for load in (0, 35_000, 45_000):
                    self.assertEqual(int(score(wind, rain, 0, load)), classify(wind, rain, 0, load))

    def test_summary_attributes_miles_to_nearest_checkpoint(self):
        cps = [{"mile": 0, "level": LOW}, {"mile": 10, "level": SEVERE}, {"mile": 20, "level": LOW}, {"mile": 25, "level": HIGH}]
        s = summarize(cps, 25)
        self.assertEqual(s["miles_by_level"], [12.5, 0, 2.5, 10, 0])
        self.assertEqual(s["avg_risk"], round((2.5 * 2 + 10 * 3) / 25, 2))

    def test_recommendation_order(self):
        def route(severe, high, avg, hours, no_travel=0):
            return {"miles_by_level": [0, 0, high, severe, no_travel], "avg_risk": avg, "duration_s": hours * 3600}

        self.assertEqual(recommend([route(10, 0, 1, 5), route(0, 50, 2, 9)])[0], 1)  # severe beats everything
        self.assertEqual(recommend([route(0, 20, 1, 5), route(0, 10, 2, 9)])[0], 1)  # then high
        self.assertEqual(recommend([route(0, 0, 0.5, 5), route(0, 0, 0.2, 9)])[0], 1)  # then average
        self.assertEqual(recommend([route(0, 0, 0, 9), route(0, 0, 0, 5)])[0], 1)  # then time
        self.assertEqual(recommend([route(0, 0, 0, 5, no_travel=5), route(9, 0, 3, 9)])[0], 1)  # no-travel worst
        self.assertIn("Fewer Severe miles: 0 mi vs 10 mi", recommend([route(10, 0, 1, 5), route(0, 50, 2, 9)])[1])


class Polyline(SimpleTestCase):
    def test_decode(self):
        # Google's reference polyline; at precision 6 the coordinates come out 10x smaller.
        self.assertEqual(decode_polyline6("_p~iF~ps|U_ulLnnqC_mqNvxq`@"), [(3.85, -12.02), (4.07, -12.095), (4.3252, -12.6453)])


class Fetch(SimpleTestCase):
    def setUp(self):
        patcher = mock.patch("time.sleep")
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_retries_server_errors_and_dropped_connections(self):
        ok = mock.MagicMock()
        ok.__enter__.return_value = io.BytesIO(b'{"ok": 1}')
        unavailable = urllib.error.HTTPError("u", 503, "Unavailable", {}, io.BytesIO(b""))
        reset = urllib.error.URLError(ConnectionResetError("reset"))
        with mock.patch("urllib.request.urlopen", side_effect=[unavailable, reset, ok]):
            self.assertEqual(_fetch("https://x.test/"), {"ok": 1})

    def test_timeouts_fail_fast_naming_the_host(self):
        slow = TimeoutError("The read operation timed out")
        for error in (slow, urllib.error.URLError(slow)):  # read timeout, TLS handshake timeout
            with mock.patch("urllib.request.urlopen", side_effect=error) as urlopen:
                with self.assertRaisesRegex(UpstreamError, "^x.test: The read operation timed out$"):
                    _fetch("https://x.test/")
            self.assertEqual(urlopen.call_count, 1)

    def test_trickling_response_hits_the_deadline(self):
        trickle = mock.MagicMock()
        trickle.__enter__.return_value.read.side_effect = [b'{"a"', b": 1}", b""]
        with mock.patch("urllib.request.urlopen", return_value=trickle), mock.patch("time.monotonic", side_effect=[0, 30, 61]):
            with self.assertRaisesRegex(UpstreamError, "^x.test: response too slow$"):
                _fetch("https://x.test/")

    def test_gives_up_after_repeated_server_errors(self):
        unavailable = urllib.error.HTTPError("u", 503, "Unavailable", {}, io.BytesIO(b""))
        with mock.patch("urllib.request.urlopen", side_effect=unavailable) as urlopen:
            with self.assertRaisesRegex(UpstreamError, "^x.test: HTTP Error 503"):
                _fetch("https://x.test/")
        self.assertEqual(urlopen.call_count, 5)

    def test_client_errors_are_not_retried(self):
        rate_limited = urllib.error.HTTPError("u", 429, "Too Many", {}, io.BytesIO(b'{"error": true, "reason": "Slow down"}'))
        with mock.patch("urllib.request.urlopen", side_effect=rate_limited) as urlopen:
            with self.assertRaisesRegex(UpstreamError, "^x.test: Slow down$"):
                _fetch("https://x.test/")
        self.assertEqual(urlopen.call_count, 1)


class BackupWeather(SimpleTestCase):
    START = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def step(self, hour, wind_ms, period=None, mm=0, symbol="rain"):
        data = {"instant": {"details": {"wind_speed": wind_ms}}}
        if period:
            data[period] = {"summary": {"symbol_code": symbol}, "details": {"precipitation_amount": mm}}
        return {"time": f"2026-01-01T{hour:02d}:00:00Z", "data": data}

    def test_met_no_converts_units_and_spreads_six_hour_blocks(self):
        series = met_no_hourly([
            self.step(0, 10, "next_1_hours", 2.54),
            self.step(1, 0, "next_1_hours", 2.54, "lightsnow"),
            self.step(2, 5, "next_6_hours", 15.24, "heavyrain"),
            self.step(8, 1, "next_6_hours", 0, "cloudy"),
        ], self.START, 8)
        rounded = [tuple(round(v, 2) for v in hour) for hour in series]
        self.assertEqual(rounded[0], (22.37, 0.1, 0))  # 10 m/s, 2.54 mm rain in the next hour
        self.assertEqual(rounded[1], (0, 0, 0.7))  # snow: 2.54 mm liquid -> 1.78 cm -> 0.7 in
        self.assertEqual(rounded[2:8], [(11.18, 0.1, 0)] * 6)  # 15.24 mm over 6 h = 0.1 in/hr each hour
        self.assertEqual(rounded[8], (2.24, 0, 0))

    def run_forecast(self, start, met_no, open_meteo, n=2):
        cache.clear()
        with mock.patch("routing.services._met_no", **met_no) as m, mock.patch("routing.services._open_meteo", **open_meteo) as o:
            return _forecast([(40 + i, -95) for i in range(n)], start, 0), m, o

    def test_near_term_uses_met_no_then_open_meteo(self):
        soon = datetime.now(timezone.utc)
        got, met, om = self.run_forecast(soon, {"return_value": [[(1, 0, 0)]] * 2}, {"return_value": [[(2, 0, 0)]] * 2})
        self.assertEqual(got, [("MET Norway", [(1, 0, 0)])] * 2)
        self.assertEqual(om.call_count, 0)

        down = {"side_effect": UpstreamError("api.met.no: HTTP Error 503: Unavailable")}
        got, met, om = self.run_forecast(soon, down, {"return_value": [[(2, 0, 0)]] * 2})
        self.assertEqual(got, [("Open-Meteo", [(2, 0, 0)])] * 2)

    def test_beyond_met_no_hourly_range_open_meteo_goes_first(self):
        later = datetime.now(timezone.utc) + timedelta(days=4)
        got, met, om = self.run_forecast(later, {"return_value": [[(1, 0, 0)]] * 2}, {"return_value": [[(2, 0, 0)]] * 2})
        self.assertEqual(got, [("Open-Meteo", [(2, 0, 0)])] * 2)
        self.assertEqual(met.call_count, 0)

    def test_both_sources_down_reports_both(self):
        got = lambda msg: {"side_effect": UpstreamError(msg)}
        with self.assertRaisesRegex(UpstreamError, "^api.met.no: timed out; api.open-meteo.com: HTTP Error 503$"):
            self.run_forecast(datetime.now(timezone.utc), got("api.met.no: timed out"), got("api.open-meteo.com: HTTP Error 503"))


class Throttle(SimpleTestCase):
    def test_met_no_calls_are_spaced_at_the_rate_limit(self):
        sleeps = []
        with mock.patch("routing.services._met_no_next", 0.0), mock.patch("time.monotonic", return_value=1000.0), \
                mock.patch("time.sleep", side_effect=sleeps.append):
            for _ in range(4):
                _met_no_throttle()
        self.assertEqual([round(x, 3) for x in sleeps], [0, 0.067, 0.133, 0.2])  # 15/s, even when called at once
