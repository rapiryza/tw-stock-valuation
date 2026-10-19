"""各公司最新一期法人說明會（公開資訊觀測站 t100sb02_1 法人說明會一覽表）。

每月、每市場（上市 sii／上櫃 otc／興櫃 rotc）一個請求。第一次回補近 24 個月，
之後每天只重抓最近 3 個月。只保留「召開日期 ≤ 今天」的最新一場。

輸出 docs/data/conferences.json：
  {"updatedAt": ..., "stocks": {"2330": ["2026-10-15", "233020261015M001.pdf", "233020261015E001.pdf", "https://..."]}}
  欄位：日期、中文簡報檔名、英文簡報檔名、公司網站法說會資訊；沒有就是 null。
  簡報檔下載網址：https://mopsov.twse.com.tw/nas/STR/<檔名>
"""
from __future__ import annotations

import argparse
import re
import time

import requests
from bs4 import BeautifulSoup

from util import DATA_DIR, log, now_taipei, read_json, write_json

URL = "https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1"
OUT = DATA_DIR / "conferences.json"
MARKETS = ("sii", "otc", "rotc")
GAP = 1.5
FILE_RE = re.compile(r"[0-9A-Za-z]{4,6}\d{8}[ME]\d{3}\.[A-Za-z0-9]{2,5}")


def roc_date(text: str) -> str | None:
    m = re.fullmatch(r"\s*(\d{2,3})/(\d{1,2})/(\d{1,2})\s*", text or "")
    if not m:
        return None
    return f"{int(m.group(1)) + 1911:04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"


def parse_listing(html: str) -> list[list]:
    """回傳 [代號, 日期, 中文檔, 英文檔, 公司網站]。"""
    soup = BeautifulSoup(html, "html.parser")
    rows = []
    for tr in soup.select("tr"):
        tds = tr.find_all("td", recursive=False)
        if len(tds) < 9:
            continue
        code = tds[0].get_text(strip=True)
        day = roc_date(tds[2].get_text(strip=True))
        if not (code and day and re.fullmatch(r"[0-9A-Z]{4,6}", code)):
            continue

        def file_in(td):
            m = FILE_RE.search(td.get_text(" ", strip=True))
            return m.group(0) if m else None

        site = None
        a = tds[8].find("a", href=True)
        if a and a["href"].startswith(("http://", "https://")):
            site = a["href"].strip()
        rows.append([code, day, file_in(tds[6]), file_in(tds[7]), site])
    return rows


def months_back(today, n: int) -> list[tuple[int, int]]:
    y, m = today.year, today.month
    out = []
    for _ in range(n):
        out.append((y, m))
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return out


def merge(stocks: dict, rows: list[list], today: str) -> None:
    """同一公司保留召開日期 ≤ 今天的最新一場；同日以有簡報檔者優先。"""
    for code, day, zh, en, site in rows:
        if day > today:
            continue
        cur = stocks.get(code)
        if cur is None or day > cur[0] or (day == cur[0] and zh and not cur[1]):
            stocks[code] = [day, zh, en, site]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", type=int, default=0, help="抓最近幾個月；0 表示自動（首次 24、之後 3）")
    args = ap.parse_args()
    data = read_json(OUT, {}) or {}
    stocks = data.get("stocks") or {}
    n = args.months or (3 if stocks else 24)
    now = now_taipei()
    today = now.date().isoformat()
    session = requests.Session()
    session.headers["User-Agent"] = "tw-stock-valuation/conferences (+https://roseamyclara.github.io/tw-stock-valuation/)"
    fetched = 0
    for y, m in months_back(now.date(), n):
        for market in MARKETS:
            body = {"encodeURIComponent": "1", "step": "1", "firstin": "1", "off": "1",
                    "TYPEK": market, "year": str(y - 1911), "month": f"{m:02d}", "co_id": ""}
            for attempt in range(3):
                try:
                    time.sleep(GAP)
                    r = session.post(URL, data=body, timeout=40)
                    r.raise_for_status()
                    r.encoding = "utf-8"
                    rows = parse_listing(r.text)
                    merge(stocks, rows, today)
                    fetched += 1
                    log(f"{y}-{m:02d} {market}: {len(rows)} 場")
                    break
                except Exception as exc:  # noqa: BLE001
                    log(f"[重試] {y}-{m:02d} {market}: {exc}")
                    time.sleep(5 * (attempt + 1))
    if not fetched:
        log("沒有成功抓到任何月份，保留舊資料")
        return 1
    write_json(OUT, {"updatedAt": now.isoformat(timespec="seconds"), "stocks": dict(sorted(stocks.items()))}, compact=True)
    log(f"法說會：{len(stocks)} 家")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
