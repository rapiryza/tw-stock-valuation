"""法說會一覽表解析：公開資訊觀測站 t100sb02_1 實際回應片段。不連網。"""
import unittest
from datetime import date

from build_conferences import merge, months_back, parse_listing

ROW = """<table><tr class="even" data-type="body">
<td style="text-align:left !important;">1203</td><td>味王</td>
<td align="center">115/10/14</td>
<td align="center">14:30</td>
<td style="text-align:left !important;">臺灣證券交易所1樓資訊展示中心(台北市信義路五段7號)</td>
<td style="text-align:left !important;">公司概況、財務報告及營運概況。</td>
<td style="text-align:left !important;"><a href="#" onclick="document.fm_fileDownload.fileName.value=&quot;120320261013M001.pptx&quot;;document.fm_fileDownload.submit();"><font color="blue"><u>120320261013M001.pptx</u></font></a></td>
<td style="text-align:left !important;"><a href="#" onclick="document.fm_fileDownload.fileName.value=&quot;120320261013E001.pptx&quot;;document.fm_fileDownload.submit();"><font color="blue"><u>120320261013E001.pptx</u></font></a></td>
<td style="text-align:left !important;"><a href="https://www.vewong.com/ec99/ushop20069/profile-11.asp" target="_blink"><font color="blue"><u>https://www.vewong.com/ec99/ushop20069/profile-11.asp</u></font></a></td>
<td style="text-align:left !important;">無</td>
<td style="text-align:left !important;">無</td>
<td align="center"><input type="button" value="查詢"></td>
</tr></table>"""


class ConferenceTests(unittest.TestCase):
    def test_parse_row(self):
        self.assertEqual(parse_listing(ROW), [["1203", "2026-10-14", "120320261013M001.pptx", "120320261013E001.pptx",
                                               "https://www.vewong.com/ec99/ushop20069/profile-11.asp"]])

    def test_latest_past_conference_kept(self):
        s = {}
        merge(s, [["2330", "2026-07-17", "a.pdf", None, None], ["2330", "2026-10-15", "b.pdf", None, None],
                  ["2330", "2027-01-15", None, None, None]], "2026-10-20")
        self.assertEqual(s["2330"][:2], ["2026-10-15", "b.pdf"])   # 未來場次不算

    def test_months_back_crosses_year(self):
        self.assertEqual(months_back(date(2026, 2, 3), 3), [(2026, 2), (2026, 1), (2025, 12)])


if __name__ == "__main__":
    unittest.main()
