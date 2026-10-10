"""把逐月的歷史快照整理成網站要用的兩種檔案。

    docs/data/market_history.json  三個市場各年月的估值水準（中位數）
    docs/data/stock/<代號>.json    個股的歷史估值、月營收、獲利

市場層級用「中位數」而非市值加權：歷史上的在外流通股數會因增減資而變動，
官方開放資料只給得到最新股數，用它回推十年前的市值會失真。中位數不需要股數，
口徑在三個市場之間也一致。
"""
from __future__ import annotations

from pe_evidence import with_pe_evidence
from pe_periods import with_period_evidence

import json
from collections import defaultdict
from statistics import median

from ps_history import PS_HISTORY, stock_series, load_reconstructed, merge_history
from util import DATA_DIR, log, read_json, rnd, write_json

HIST_DIR = DATA_DIR / "history"
STOCK_DIR = DATA_DIR / "stock"

MARKETS = ("listed", "otc", "esb")
LABEL = {"listed": "上市", "otc": "上櫃", "esb": "興櫃"}


def load_history() -> dict[str, dict]:
    """讀入所有年度檔，回傳 {年月: {代號: [pe, pb, dy, price]}}"""
    months: dict[str, dict] = {}
    if not HIST_DIR.exists():
        return months
    for path in sorted(HIST_DIR.glob("*.json")):
        data = read_json(path, {}) or {}
        for ym, snap in data.items():
            months[ym] = snap
    return dict(sorted(months.items()))


def main() -> None:
    latest = read_json(DATA_DIR / "latest.json", []) or []
    if not latest:
        log("找不到 latest.json，先跑 build_snapshot.py")
        return

    meta = {s["c"]: s for s in latest}
    market_of = {s["c"]: s["m"] for s in latest}
    months = load_history()
    log(f"歷史月份 {len(months)} 個、個股 {len(latest)} 檔")

    # ---------------- 市場層級 ----------------
    market_hist: dict[str, dict] = {}
    for ym, snap in months.items():
        buckets: dict[str, dict[str, list[float]]] = {
            m: {"pe": [], "pb": [], "dy": []} for m in MARKETS
        }
        for code, vals in snap.get("s", {}).items():
            m = market_of.get(code)
            if not m:
                continue
            pe, pb, dy = (vals + [None, None, None])[:3]
            if pe:
                buckets[m]["pe"].append(pe)
            if pb:
                buckets[m]["pb"].append(pb)
            if dy:
                buckets[m]["dy"].append(dy)
        row = {}
        for m in MARKETS:
            b = buckets[m]
            if not b["pe"] and not b["pb"]:
                continue
            row[m] = {
                "n": len(b["pe"]),
                "pe": rnd(median(b["pe"])) if b["pe"] else None,
                "pb": rnd(median(b["pb"])) if b["pb"] else None,
                "dy": rnd(median(b["dy"])) if b["dy"] else None,
            }
        if row:
            market_hist[ym] = {"d": snap.get("d"), "m": row}

    # 各年度：取該年最後一個有資料的月份，另附全年平均
    yearly: dict[str, dict] = defaultdict(dict)
    per_year: dict[str, dict[str, list]] = defaultdict(lambda: defaultdict(list))
    for ym, row in market_hist.items():
        y = ym[:4]
        for m, v in row["m"].items():
            if v.get("pe"):
                per_year[y][m].append(v["pe"])
    for y, mk in per_year.items():
        yearly[y] = {
            m: {"pe_avg": rnd(sum(v) / len(v)), "months": len(v)} for m, v in mk.items()
        }

    write_json(
        DATA_DIR / "market_history.json",
        {"monthly": market_hist, "yearly": dict(sorted(yearly.items())), "labels": LABEL},
        compact=False,
    )
    log(f"market_history.json：{len(market_hist)} 個月、{len(yearly)} 個年度")

    # ---------------- 個股 ----------------
    fundamentals = read_json(DATA_DIR / "fundamentals.json", {}) or {}
    STOCK_DIR.mkdir(parents=True, exist_ok=True)

    ps_months = merge_history(load_reconstructed(), read_json(PS_HISTORY, {}) or {})
    pe_evidence = read_json(DATA_DIR / "pe_evidence.json", {}) or {}
    report_periods = (read_json(DATA_DIR / 'pe_report_periods.json', {}) or {}).get('months', {})
    eps_data = read_json(DATA_DIR / 'pe_eps.json', {}) or {}
    per_stock: dict[str, list] = defaultdict(list)
    for ym, snap in months.items():
        for code, vals in snap.get("s", {}).items():
            values = with_pe_evidence(vals, code, snap.get("d"), pe_evidence)
            values = with_period_evidence(values, code, snap.get('d'), report_periods.get(ym, {}), eps_data)
            per_stock[code].append([ym] + values)

    written = 0
    for code, s in meta.items():
        hist = per_stock.get(code, [])
        fund = fundamentals.get(code, {})
        # 刻意不放當前股價與估值：那些每天都在變，會讓這 2000 多個檔案天天進 commit。
        # 前端要顯示當前值時直接用已經載入的 latest.json，個股檔只負責歷史，
        # 這樣它一個月才變動一次。
        doc = {
            "c": code,
            "n": s.get("n"),
            "m": s.get("m"),
            "i": s.get("i"),
            "hist": hist,
            "psHist": stock_series(ps_months, code),
            # 只留最近 36 個月的累計營收，避免個股檔無限膨脹
            "revHist": dict(sorted((fund.get("rev_cum") or {}).items())[-36:]),
            "incHist": fund.get("income") or {},
        }
        write_json(STOCK_DIR / f"{code}.json", doc)
        written += 1

    log(f"個股檔：{written} 個")

    # 索引檔：讓前端知道哪些個股有歷史頁
    write_json(
        DATA_DIR / "stock_index.json",
        sorted(meta.keys()),
    )


if __name__ == "__main__":
    main()
