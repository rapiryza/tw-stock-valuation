"""內部人持股月增減：以官方實際資料逐條驗證口徑。不連網。

fixtures/insider_2026.json 取自公開資訊觀測站內部人持股異動事後申報表（query6_1）
與證交所 IRB110（2026 年 6～8 月）。
"""
import json
import unittest
from pathlib import Path

from insider_holdings import compute_month, parse_irb110_html, parse_mopsov_html

FX = json.loads((Path(__file__).parent / "fixtures" / "insider_2026.json").read_text(encoding="utf-8"))


def run(code, month, prev_month):
    return compute_month(FX["detail"][f"{code}_{month}"], FX["irb110"][f"{code}_{month}"], FX["irb110"].get(f"{code}_{prev_month}"))


class InsiderHoldingTests(unittest.TestCase):
    def test_tsmc_gift_and_personnel_excluded(self):
        r = run("2330", "2026-08", "2026-07")
        # 明細歸戶後與 IRB110 董監、經理人欄逐股相符（魏哲家兼董事長／總經理、黃仁昭兼財務主管只算一次）
        self.assertTrue(r["verified"])
        # IRB110 總額變動 −5,460.054 張，但真正買賣只有田博仁 +1、袁立本 +2 張
        self.assertEqual(r["raw"], -5460.054)
        self.assertEqual(r["counted"], 3.0)
        self.assertEqual(r["rsu"], 0.0)
        # 曾繁城贈與配偶 5,000 張、副總解任名單異動 −463.054 張都列為剔除
        self.assertEqual(r["otherOut"], -5000.0)
        self.assertEqual(r["personnel"], -463.054)
        reasons = {x["name"]: x["reason"] for x in r["excluded"]}
        self.assertIn("贈與", reasons["曾繁城"])
        self.assertEqual({x["name"] for x in r["breakdown"]}, {"田博仁", "袁立本"})

    def test_corporate_director_with_two_reps_counted_once_and_rsu_labelled(self):
        r = run("6945", "2026-07", "2026-06")
        self.assertTrue(r["verified"])  # 浩鼎派兩位代表人，申報出現兩列，只算一次
        self.assertEqual(r["counted"], 240.0)
        self.assertEqual(r["rsu"], 240.0)
        item = r["breakdown"][0]
        self.assertEqual((item["name"], item["source"], item["note"]), ("何正宏", "rsu", "員工股/RSU"))

    def test_stock_split_excluded(self):
        r = run("5904", "2026-08", "2026-07")
        self.assertTrue(r["verified"])
        self.assertEqual(r["corpRatio"], 9.0)
        self.assertEqual(r["counted"], 0.0)
        self.assertEqual(r["rsu"], 0.0)  # 經理人分割取得的股數不能被誤認為 RSU
        self.assertTrue(all(x["reason"] in ("股票分割", "就任、解任，不是買賣") for x in r["excluded"]))
        self.assertGreater(r["raw"], 100000)  # IRB110 總額因分割暴增，但不計入

    def test_ten_percent_holder_not_in_total(self):
        r = run("2317", "2026-08", "2026-07")
        self.assertTrue(r["verified"])  # 郭台銘（大股東）不在 IRB110 董監＋經理人口徑內
        self.assertEqual(r["raw"], 0.0)
        self.assertEqual(r["counted"], 0.0)
        self.assertNotIn("郭台銘", [p["name"] for p in r["people"]])

    def test_rep_manager_left_out_when_irb110_does(self):
        # 統一 1216（2026-08 官方）：總經理羅智先同時是董事長法人代表人，IRB110 經理人欄只有 3,500 股
        rows = [
            ["董事長本人", "高權投資股份有限公司", 284330536, 0, 0, 0, 0, 284330536, "兼董事", "普通股"],
            ["董事長之法人代表人", "羅智先", 4059095, 0, 0, 0, 0, 4059095, "兼總經理", "普通股"],
            ["董事本人", "高權投資股份有限公司", 284330536, 0, 0, 0, 0, 284330536, "兼董事長", "普通股"],
            ["董事本人", "育鵬投資股份有限公司", 24188, 0, 0, 0, 0, 24188, "", "普通股"],
            ["董事本人", "侯博裕", 141697024, 0, 0, 0, 0, 141697024, "", "普通股"],
            ["董事本人", "永原投資股份有限公司", 11363389, 0, 0, 0, 0, 11363389, "", "普通股"],
            ["董事本人", "泰伯投資股份有限公司", 30582348, 0, 0, 0, 0, 30582348, "", "普通股"],
            ["董事本人", "林蒼生", 49916266, 0, 0, 0, 0, 49916266, "", "普通股"],
            ["董事本人", "品誌股份有限公司", 43881920, 0, 0, 0, 0, 43881920, "", "普通股"],
            ["總經理本人", "羅智先", 4059095, 0, 0, 0, 0, 4059095, "兼董事長之法人代表人", "普通股"],
            ["協理本人", "張立勳", 2500, 0, 0, 0, 0, 2500, "", "普通股"],
            ["協理本人", "王彥超", 1000, 0, 0, 0, 0, 1000, "", "普通股"],
        ]
        irb = {"issued": 5682015421, "dirInc": 0, "dirDec": 0, "dir": 561795671, "mgr": 3500, "big": 0}
        self.assertTrue(compute_month(rows, irb, irb)["verified"])

    def test_preferred_shares_counted_separately(self):
        # 台泥 1101（2026-08 官方）：同一人普通股、特別股分列，IRB110 兩者都計入
        rows = [
            ["董事本人", "中成開發投資股份有限公司", 30860136, 0, 0, 0, 0, 30860136, "", "普通股"],
            ["董事本人", "中成開發投資股份有限公司", 782130, 0, 0, 0, 0, 782130, "", "特別股"],
            ["獨立董事本人", "周玲臺", 1, 0, 0, 0, 0, 1, "", "普通股"],
            ["獨立董事本人", "周玲臺", 200000, 0, 0, 0, 0, 200000, "", "特別股"],
            ["副總經理本人", "黃健強", 1133421, 0, 0, 0, 0, 1133421, "", "普通股"],
            ["副總經理本人", "黃健強", 20616, 0, 0, 0, 0, 20616, "", "特別股"],
        ]
        irb = {"issued": 1, "dir": 30860136 + 782130 + 1 + 200000, "mgr": 1133421 + 20616}
        self.assertTrue(compute_month(rows, irb, None)["verified"])

    def test_parse_irb110_html(self):
        html = ("<TR><TD>2330台灣積體電路製造</TD><TD>25,932,370,067</TD><TD>0</TD><TD>5,000,000</TD>"
                "<TD>1,685,761,830</TD><TD>6.50</TD><TD>17,955,572</TD><TD>0</TD></TR>")
        self.assertEqual(parse_irb110_html(html)["2330"]["mgr"], 17955572)

    def test_parse_mopsov_html(self):
        html = ("<tr class='even'><td>董事本人</td><td>曾繁城</td><td>普通股</td>"
                "<td> 29,472,675<br> 29,472,675<br> 0<br> 0<br> 0</td>"
                "<td> 0<br> 0<br> 0<br> 0<br> 0<br></td>"
                "<td> 0<br> 5,000,000<br> 0<br> 0<br> 0</td>"
                "<td> 24,472,675<br> 0<br> 0<br> 0<br> 0<br>身份別備註：\r\n</td></tr>")
        self.assertEqual(parse_mopsov_html(html), [["董事本人", "曾繁城", 29472675, 0, 0, 0, 5000000, 24472675, "", "普通股"]])


class BuildHoldingsTests(unittest.TestCase):
    def test_series_uses_irb110_total_and_detail_change_only(self):
        import build_insider_flows as b
        irb = {}
        for key, rec in FX["irb110"].items():
            code, month = key.split("_")
            irb.setdefault(month, {})[code] = dict(rec, m="listed")
        detail = {tuple(k.split("_")): v for k, v in FX["detail"].items()}
        orig = b.load_detail
        b.load_detail = lambda code, month: detail.get((code, month))
        try:
            out = b.build_holdings(irb)
        finally:
            b.load_detail = orig
        tsmc = out["2330"]
        self.assertEqual(tsmc["latestMonth"], "2026-08")
        self.assertEqual(tsmc["latestLots"], 1703717.402)   # IRB110 董監＋經理人
        self.assertEqual(tsmc["monthlyChange"], 3.0)        # 不是 −5,460 張
        self.assertEqual(tsmc["monthlyRaw"], -5460.054)
        self.assertTrue(tsmc["verified"])
        hon = out["2317"]
        self.assertEqual(hon["latestLots"], 3614.367)       # 不含郭台銘大股東持股
        self.assertEqual(hon["monthlyChange"], 0.0)
        self.assertEqual(out["6945"]["series"][-1][2], 240.0)
        self.assertEqual(out["6945"]["rsu"], 240.0)
        # 沒有前月 IRB110 的第一個月只有總額，沒有單月增減
        self.assertIsNone(out["5904"]["series"][0][2])
        self.assertEqual(out["5904"]["monthlyChange"], 0.0)


if __name__ == "__main__":
    unittest.main()
