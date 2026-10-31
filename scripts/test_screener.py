"""三率篩選彙整規則。不連網。"""
import unittest

from build_screener import build_row, latest_quarter, q_index, quarter_revenue, series


class ScreenerTests(unittest.TestCase):
    def test_quarter_revenue_sums_three_months(self):
        rev = {"2026-04": 100.0, "2026-05": 200.0, "2026-06": 300.0}
        self.assertEqual(quarter_revenue(rev, "2026Q2"), 600.0)
        self.assertIsNone(quarter_revenue({"2026-04": 1.0, "2026-05": 2.0}, "2026Q2"))  # 缺月不估

    def test_series_spans_year_boundary_and_keeps_gaps(self):
        margin = {"2025Q4": [1, 2, 3], "2026Q2": [7, 8, None]}
        g, o, n = series(margin, q_index("2026Q2"), 3)
        self.assertEqual(g, [1.0, None, 7.0])
        self.assertEqual(n, [3.0, None, None])

    def test_latest_quarter_ignores_all_null_rows(self):
        self.assertEqual(latest_quarter({"2026Q1": [1, 2, 3], "2026Q2": [None, None, None]}), "2026Q1")

    def test_stale_company_dropped(self):
        r = {"c": "9999", "n": "x", "cap": 1e9}
        fin = {"margin": {"2024Q4": [1, 2, 3]}}
        self.assertIsNone(build_row(r, fin, q_index("2026Q2")))
        row = build_row(r, {"margin": {"2026Q1": [1, 2, 3]}}, q_index("2026Q2"))
        self.assertEqual((row[4], row[5]), (10.0, "2026Q1"))


if __name__ == "__main__":
    unittest.main()
