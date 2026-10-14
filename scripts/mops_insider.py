"""MOPS insider monthly report (query6_1) fetcher and parser.

Extracts official centralized market buy/sell shares (B_market and S_market),
completely filtering out stock dividends, gifts, trusts, private placements,
and capital reductions.
"""
from __future__ import annotations

import json
from pathlib import Path
import time
import requests

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "docs" / "data" / "mops_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

HEADERS = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Origin': 'https://mops.twse.com.tw',
    'Referer': 'https://mops.twse.com.tw/'
}
URL = 'https://mops.twse.com.tw/mops/api/query6_1'


def get_cache_path(code: str, year: str, month: str) -> Path:
    return CACHE_DIR / f"{code}_{year}_{month}.json"


def fetch_mops_insider(
    code: str,
    year: str,
    month: str,
    session: requests.Session | None = None,
    use_cache: bool = True
) -> dict | None:
    """Fetch query6_1 report for a given stock code and ROC year/month."""
    cache_file = get_cache_path(code, year, month)
    if use_cache and cache_file.exists():
        try:
            with open(cache_file, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass

    payload = {
        'companyId': code,
        'dataType': '2',
        'subsidiaryCompanyId': '',
        'year': year,
        'month': month
    }
    client = session or requests
    for attempt in range(3):
        try:
            r = client.post(URL, headers=HEADERS, json=payload, timeout=25)
            if r.status_code == 200:
                data = r.json()
                if data.get("code") == 200 and data.get("result"):
                    with open(cache_file, "w", encoding="utf-8") as f:
                        json.dump(data, f, ensure_ascii=False)
                    return data
                elif data.get("code") in [406, 500, 501]:
                    # No data or invalid company/month
                    return None
        except Exception:
            time.sleep(1 + attempt)
    return None


def parse_mops_records(mops_data: dict | None) -> list[dict]:
    """Parse query6_1 result rows into structured insider records.
    
    Columns mapping:
    [00] 身份別
    [01] 姓名
    [02] 持股種類
    [03] 選任當時持有股數
    [04] 上月實際持有股數
    [08] 本月增加-自有股數(集中) -> B_market
    [09] 本月增加-自有股數(其它原因－不含私募) -> I_other (除權配股、受贈等)
    [13] 本月減少-自有股數(集中) -> S_market
    [14] 本月減少-自有股數(其它原因－不含私募) -> D_other (贈與、轉讓等)
    [18] 本月實際自有持有股數 -> S_t
    """
    if not mops_data or not isinstance(mops_data, dict):
        return []
    res = mops_data.get("result") or {}
    data = res.get("data") or []
    out = []
    for row in data:
        if len(row) < 19:
            continue
        title = str(row[0] or "").strip()
        name = str(row[1] or "").strip()
        try:
            prev_shares = float(str(row[4]).replace(",", "") or 0)
            curr_shares = float(str(row[18]).replace(",", "") or 0)
            b_mkt = float(str(row[8]).replace(",", "") or 0)
            s_mkt = float(str(row[13]).replace(",", "") or 0)
            other_inc = float(str(row[9]).replace(",", "") or 0)
            other_dec = float(str(row[14]).replace(",", "") or 0)
        except ValueError:
            continue

        out.append({
            "title": title,
            "name": name,
            "prev": round(prev_shares / 1000.0, 3),
            "curr": round(curr_shares / 1000.0, 3),
            "b_mkt": round(b_mkt / 1000.0, 3),
            "s_mkt": round(s_mkt / 1000.0, 3),
            "net_mkt": round((b_mkt - s_mkt) / 1000.0, 3),
            "other_inc": round(other_inc / 1000.0, 3),
            "other_dec": round(other_dec / 1000.0, 3),
        })
    return out
