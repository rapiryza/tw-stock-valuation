"""歷年月營收與利潤率：以公開資訊觀測站財務比較 E 點通的實際回應驗證解析。不連網。"""
import unittest
from datetime import date

from build_financial_history import last_published_month, parse_margin_payload

# 2026-10-18 實際回應（OperatingMargin，只保留最後 4 季）
PAYLOAD = {
    "xaxisList": ["2025Q3", "2025Q4", "2026Q1", "2026Q2"],
    "ylabel": "%",
    "checkedNameList": ["2330 台積電 (上市半導體業)", "2882 國泰金 (上市金融保險業)", "6488 環球晶 (上櫃半導體業)"],
    "showNameList": ["2330 台積電 (上市半導體業)", "2882 國泰金 (上市金融保險業)", "6488 環球晶 (上櫃半導體業)"],
    "displayCompanyId": ["2330 台積電 (上市半導體業)", "2882 國泰金 (上市金融保險業)", "6488 環球晶 (上櫃半導體業)"],
    "graphData": [
        {"label": "台積電", "data": [[0, 50.58, "C"], [1, 54, "C"], [2, 58.1, "C"], [3, 60.34, "C"]]},
        {"label": "國泰金", "data": [[0, None, "C"], [1, None, "C"], [2, None, "C"], [3, None, "C"]]},
        {"label": "環球晶", "data": [[0, 8.49, "C"], [1, 16.41, "C"], [2, 10.55, "C"], [3, 9.35, "C"]]},
    ],
}


class MarginTests(unittest.TestCase):
    def test_series_mapped_by_company_identity(self):
        out = parse_margin_payload(PAYLOAD, ["2330", "2882", "6488"])
        self.assertEqual(out["2330"]["2026Q2"], 60.34)
        self.assertEqual(out["6488"]["2025Q4"], 16.41)
        # 金融業沒有營業利益率：保留 null，不補 0
        self.assertIsNone(out["2882"]["2026Q1"])

    def test_unknown_label_dropped(self):
        payload = dict(PAYLOAD, graphData=[{"label": "不存在公司", "data": [[0, 1, "C"]]}])
        self.assertEqual(parse_margin_payload(payload, ["2330"]), {})

    def test_latest_month(self):
        self.assertEqual(last_published_month(date(2026, 10, 18)), "2026-09")
        self.assertEqual(last_published_month(date(2026, 1, 5)), "2025-12")


if __name__ == "__main__":
    unittest.main()
