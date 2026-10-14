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


from build_insider_flows import is_individual, clean_title
from mops_insider import fetch_mops_insider, parse_mops_records

MONTHS = [("115", "06", "2026-06"), ("115", "07", "2026-07"), ("115", "08", "2026-08")]


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

    # 2. Extract genuine centralized market transactions (B_market and S_market) from MOPS query6_1
    for code, ytd_ret in top_5_pct:
        name = stock_names.get(code, code)
        stock_tags = tags_map.get(code, [])
        company_market_net = 0.0
        seen_person_month = set()

        for yr, mo, mo_str in MONTHS:
            mops_data = fetch_mops_insider(code, yr, mo)
            records = parse_mops_records(mops_data)
            for r in records:
                net_mkt = r["net_mkt"]
                p_name = r["name"].strip()
                title = clean_title(r["title"])

                if net_mkt != 0:
                    company_market_net += net_mkt

                    if p_name and is_individual(p_name):
                        dedup_key = (code, mo_str, p_name, "mkt", net_mkt)
                        if dedup_key not in seen_person_month:
                            seen_person_month.add(dedup_key)
                            prev_hold = r["prev"]
                            if prev_hold > 0:
                                pct = round(abs(net_mkt) / prev_hold * 100, 2)
                                orig = prev_hold
                            else:
                                curr_hold = r["curr"]
                                orig = round(curr_hold - net_mkt, 3)
                                pct = 100.0 if orig <= 0 else round(abs(net_mkt) / orig * 100, 2)

                            pct = min(100.0, pct)
                            person_txs.append({
                                "code": code,
                                "stockName": name,
                                "tags": stock_tags,
                                "month": mo_str,
                                "name": p_name,
                                "title": title or "內部人",
                                "delta": net_mkt,
                                "orig": orig,
                                "pct": pct,
                                "ytd": ytd_ret,
                                "type": "buy" if net_mkt > 0 else "sell",
                                "source": "market",
                            })

                if r.get("rsu", 0) > 0:
                    rsu_lots = r["rsu"]
                    company_market_net += rsu_lots
                    if p_name and is_individual(p_name):
                        dedup_key = (code, mo_str, p_name, "rsu", rsu_lots)
                        if dedup_key not in seen_person_month:
                            seen_person_month.add(dedup_key)
                            prev_hold = r["prev"]
                            if prev_hold > 0:
                                pct = round(rsu_lots / prev_hold * 100, 2)
                                orig = prev_hold
                            else:
                                curr_hold = r["curr"]
                                orig = round(curr_hold - rsu_lots, 3)
                                pct = 100.0 if orig <= 0 else round(rsu_lots / orig * 100, 2)

                            pct = min(100.0, pct)
                            person_txs.append({
                                "code": code,
                                "stockName": name,
                                "tags": stock_tags,
                                "month": mo_str,
                                "name": p_name,
                                "title": title or "主管",
                                "delta": rsu_lots,
                                "orig": orig,
                                "pct": pct,
                                "ytd": ytd_ret,
                                "type": "rsu",
                                "source": "rsu",
                                "note": "RSU/員工股",
                            })

        s = insider.get("stocks", {}).get(code)
        latest_lots = s.get("holding", {}).get("latestLots") if s else None
        if latest_lots and latest_lots > 0:
            orig_comp = round(latest_lots - company_market_net, 3)
            pct_comp = round(abs(company_market_net) / orig_comp * 100, 2) if orig_comp > 0 else 0.0
            company_m3_list.append({
                "code": code,
                "stockName": name,
                "tags": stock_tags,
                "ytd": ytd_ret,
                "m3": round(company_market_net, 3),
                "latestLots": latest_lots,
                "orig": orig_comp,
                "pct": pct_comp,
                "type": "buy" if company_market_net > 0 else ("sell" if company_market_net < 0 else "flat"),
            })

    all_pcts = [tx["pct"] for tx in person_txs]
    buy_pcts = [tx["pct"] for tx in person_txs if tx["type"] == "buy"]
    sell_pcts = [tx["pct"] for tx in person_txs if tx["type"] == "sell"]
    rsu_pcts = [tx["pct"] for tx in person_txs if tx["type"] == "rsu"]
    active_m3 = [c["pct"] for c in company_m3_list if c["pct"] > 0]
    all_m3 = [c["pct"] for c in company_m3_list]

    out = {
        "updatedAt": datetime.now(TW).isoformat(timespec="seconds"),
        "evaluatedCount": total_evaluated,
        "topPercent": 5,
        "topCount": top_5_pct_count,
        "cutoffReturn": cutoff_return,
        "periodDescription": "最近3個月（依公開資訊觀測站官方集中市場買賣及員工認股/RSU）",
        "personStats": {
            "overallMedianPct": round(statistics.median(all_pcts), 2) if all_pcts else None,
            "sellMedianPct": round(statistics.median(sell_pcts), 2) if sell_pcts else None,
            "buyMedianPct": round(statistics.median(buy_pcts), 2) if buy_pcts else None,
            "rsuMedianPct": round(statistics.median(rsu_pcts), 2) if rsu_pcts else None,
            "totalTxCount": len(person_txs),
            "buyTxCount": len(buy_pcts),
            "sellTxCount": len(sell_pcts),
            "rsuTxCount": len(rsu_pcts),
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
