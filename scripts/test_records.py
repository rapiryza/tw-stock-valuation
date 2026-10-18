"""創新高榜判定規則。不連網。"""
import unittest

from build_records import latest_beats, quantile


class RecordTests(unittest.TestCase):
    def test_quantile_matches_linear_interpolation(self):
        xs = list(range(1, 101))
        self.assertAlmostEqual(quantile(xs, 0.95), 95.05)
        self.assertAlmostEqual(quantile(xs, 0.05), 5.95)

    def test_latest_must_beat_every_prior_period(self):
        s = {"2025Q4": 50.0, "2026Q1": 55.0, "2026Q2": 56.0}
        hit = latest_beats(s, 2, "2026Q2")
        self.assertEqual((hit["v"], hit["prev"], hit["prevPeriod"]), (56.0, 55.0, "2026Q1"))
        self.assertIsNone(latest_beats(dict(s, **{"2026Q2": 55.0}), 2, "2026Q2"))  # 持平不算新高

    def test_stale_period_or_short_history_excluded(self):
        s = {"2025Q4": 50.0, "2026Q1": 60.0}
        self.assertIsNone(latest_beats(s, 1, "2026Q2"))   # 還沒公布最新一季
        self.assertIsNone(latest_beats(s, 5, "2026Q1"))   # 歷史太短

    def test_missing_values_ignored(self):
        s = {"2025Q3": None, "2025Q4": 10.0, "2026Q1": 12.0}
        self.assertEqual(latest_beats(s, 1, "2026Q1")["prev"], 10.0)


if __name__ == "__main__":
    unittest.main()
