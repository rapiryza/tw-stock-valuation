"""Calculate insider holding changes for top 5% YTD gainers.

Computes the median percentage of their own holdings that insiders
bought or sold over the past 3 months for stocks in the top 5% YTD gainers.

Output: docs/data/insider_ytd_stat.json
"""
from __future__ import annotations

import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
import statistics
import sys

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "docs" / "data"
TW = timezone(timedelta(hours=8))


def generate_stat() -> dict:
    perf_file = DATA_DIR / "performance.json"
    insider_file = DATA_DIR / "insider_flows.json"
    latest_file = DATA_DIR / "latest.json"

    with open(perf_file, encoding="utf-8") as f:
        perf = json.load(f)
    with open(insider_file, encoding="utf-8") as f:
        insider = json.load(f)
    with open(latest_file, encoding="utf-8") as f:
        latest = json.load(f)

    stock_names = {s["c"]: s["n"] for s in latest if "c" in s}
    stock_industries = {s["c"]: s.get("i", "") for s in latest if "c" in s}

    tags_file = DATA_DIR / "tags.json"
    tags_map = {}
    if tags_file.exists():
        with open(tags_file, encoding="utf-8") as f:
            tags_map = json.load(f)

    # 1. Evaluate stocks with valid YTD returns
    valid_ytd = []
    for code, s in perf.get("stocks", {}).items():
        ret = s.get("returns", {}).get("ytd")
        if ret is not None:
            valid_ytd.append((code, round(float(ret), 2)))

    valid_ytd.sort(key=lambda x: x[1], reverse=True)
    total_evaluated = len(valid_ytd)
    top_5_pct_count = int(total_evaluated * 0.05)
    top_5_pct = valid_ytd[:top_5_pct_count]
    cutoff_return = top_5_pct[-1][1] if top_5_pct else 0.0

    person_txs = []
    company_m3_list = []

    # 2. Collect transactions from last 3 months for top 5% gainers
    for code, ytd_ret in top_5_pct:
        s = insider.get("stocks", {}).get(code)
        if not s:
            continue
        name = stock_names.get(code, code)
        ind = stock_industries.get(code, "")
        stock_tags = tags_map.get(code, [])
        h = s.get("holding", {})
        series = h.get("series", [])
        last_3 = series[-3:] if len(series) >= 3 else series

        m3 = h.get("summary", {}).get("m3")
        latest_lots = h.get("latestLots")
        if m3 is not None and latest_lots and latest_lots > 0:
            orig = latest_lots - m3
            if orig > 0:
                pct = round(abs(m3) / orig * 100, 2)
                company_m3_list.append({
                    "code": code,
                    "stockName": name,
                    "industry": ind,
                    "tags": stock_tags,
                    "ytd": ytd_ret,
                    "m3": round(m3, 3),
                    "latestLots": latest_lots,
                    "orig": round(orig, 3),
                    "pct": pct,
                    "type": "buy" if m3 > 0 else ("sell" if m3 < 0 else "flat"),
                })

        for row in last_3:
            month = row[0]
            breakdowns = row[3] if len(row) > 3 else []
            for b in breakdowns:
                if b.get("is_person") and b.get("pct") is not None:
                    person_txs.append({
                        "code": code,
                        "stockName": name,
                        "industry": ind,
                        "tags": stock_tags,
                        "month": month,
                        "name": b.get("name"),
                        "title": b.get("title"),
                        "delta": b.get("delta"),
                        "orig": b.get("orig"),
                        "pct": b.get("pct"),
                        "ytd": ytd_ret,
                        "type": "buy" if b.get("delta", 0) > 0 else "sell",
                    })

    all_pcts = [tx["pct"] for tx in person_txs]
    buy_pcts = [tx["pct"] for tx in person_txs if tx["type"] == "buy"]
    sell_pcts = [tx["pct"] for tx in person_txs if tx["type"] == "sell"]
    active_m3 = [c["pct"] for c in company_m3_list if c["pct"] > 0]
    all_m3 = [c["pct"] for c in company_m3_list]

    out = {
        "updatedAt": datetime.now(TW).isoformat(timespec="seconds"),
        "evaluatedCount": total_evaluated,
        "topPercent": 5,
        "topCount": top_5_pct_count,
        "cutoffReturn": cutoff_return,
        "periodDescription": "最近3個月（依各檔最新持股月報）",
        "personStats": {
            "overallMedianPct": round(statistics.median(all_pcts), 2) if all_pcts else None,
            "sellMedianPct": round(statistics.median(sell_pcts), 2) if sell_pcts else None,
            "buyMedianPct": round(statistics.median(buy_pcts), 2) if buy_pcts else None,
            "totalTxCount": len(person_txs),
            "buyTxCount": len(buy_pcts),
            "sellTxCount": len(sell_pcts),
        },
        "companyStats": {
            "activeMedianPct": round(statistics.median(active_m3), 2) if active_m3 else None,
            "allMedianPct": round(statistics.median(all_m3), 2) if all_m3 else None,
            "activeCount": len(active_m3),
            "totalCount": len(company_m3_list),
        },
        "personTransactions": sorted(person_txs, key=lambda x: -x["pct"]),
        "topGainersCompanies": sorted(company_m3_list, key=lambda x: -x["ytd"]),
    }

    out_file = DATA_DIR / "insider_ytd_stat.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    return out


def main() -> int:
    stat = generate_stat()
    p_med = stat["personStats"]["overallMedianPct"]
    s_med = stat["personStats"]["sellMedianPct"]
    b_med = stat["personStats"]["buyMedianPct"]
    print(f"完成飆股內部人統計：總計評估 {stat['evaluatedCount']} 檔，前 5% 門檻 YTD>={stat['cutoffReturn']}% ({stat['topCount']} 檔)")
    print(f"個人中位數：全體 {p_med}%，減持 {s_med}%，增持 {b_med}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
