from django.test import SimpleTestCase

from .risk import HIGH, LOW, MODERATE, NO_TRAVEL, SEVERE, classify, recommend, score, summarize
from .services import decode_polyline6


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
