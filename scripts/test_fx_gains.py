"""離線測試：外幣兌換損益解析與業外占比計算。不連網。"""
import unittest

from build_fx_gains import parse_fx_gain
from build_snapshot import profit_growth


def ctx(cid, start, end, member=False):
    scenario = (
        '<xbrli:scenario><xbrldi:explicitMember dimension="a:Axis">a:Member</xbrldi:explicitMember></xbrli:scenario>'
        if member else ""
    )
    return (
        f'<xbrli:context id="{cid}"><xbrli:entity><xbrli:identifier scheme="http://www.twse.com.tw">2330'
        f'</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>{start}</xbrli:startDate>'
        f'<xbrli:endDate>{end}</xbrli:endDate></xbrli:period>{scenario}</xbrli:context>'
    )


def fact(name, cid, text, sign=False):
    s = ' sign="-"' if sign else ""
    return (f'<ix:nonFraction name="{name}" contextRef="{cid}" format="ixt:numdotdecimal" '
            f'scale="3"{s} decimals="-3" unitRef="TWD">{text}</ix:nonFraction>')


# 取自台積電 2026Q2 官方 iXBRL（N7230 外幣兌換利益（損失））
TSMC = "".join([
    ctx("From20260401To20260630", "2026-04-01", "2026-06-30"),
    ctx("From20260101To20260630", "2026-01-01", "2026-06-30"),
    ctx("From20250101To20250630", "2025-01-01", "2025-06-30"),
    ctx("From20260101To20260630_X", "2026-01-01", "2026-06-30", member=True),
    fact("ifrs-full:AdjustmentsForUnrealisedForeignExchangeLossesGains", "From20260101To20260630", "4,354,953", True),
    fact("tifrs-notes:ForeignExchangeGainsLosses_n", "From20260401To20260630", "419,968"),
    fact("tifrs-notes:ForeignExchangeGainsLosses_n", "From20260101To20260630_X", "1"),
    fact("tifrs-notes:ForeignExchangeGainsLosses_n", "From20260101To20260630", "6,598,890"),
    fact("tifrs-notes:ForeignExchangeGainsLosses_n", "From20250101To20250630", "1,244,213", True),
])


class FxTests(unittest.TestCase):
    def test_tsmc_ytd(self):
        self.assertEqual(parse_fx_gain(TSMC, "2026Q2"), 6_598_890_000)

    def test_prior_year_loss(self):
        self.assertEqual(parse_fx_gain(TSMC, "2025Q2"), -1_244_213_000)

    def test_missing(self):
        self.assertIsNone(parse_fx_gain(TSMC, "2026Q3"))

    def test_ifrs_loss_fallback(self):
        doc = ctx("C", "2026-01-01", "2026-06-30") + fact("ifrs-full:ForeignExchangeLoss", "C", "99")
        self.assertEqual(parse_fx_gain(doc, "2026Q2"), -99_000)


class NonopTests(unittest.TestCase):
    def test_ratios(self):
        out = profit_growth({"year": 115, "quarter": 2, "revenue": 1000, "op": 200, "pretax": 250,
                             "nonop": 50, "net": 210, "eps": 1}, None)
        self.assertEqual(out["nonop_pt"], 20.0)
        self.assertEqual(out["nonop_op"], 25.0)
        self.assertEqual(out["net"], 210)

    def test_fallback_and_negative_denominator(self):
        out = profit_growth({"year": 115, "quarter": 2, "revenue": 1000, "op": -100, "pretax": 50,
                             "net": 40, "eps": 1}, None)
        self.assertEqual(out["nonop"], 150)
        self.assertEqual(out["nonop_pt"], 300.0)
        self.assertIsNone(out["nonop_op"])


if __name__ == "__main__":
    unittest.main()
