"""創新高／新低榜：只用站上已保存的官方資料，不另外連網。

輸出 docs/data/records.json：
  {"asOf": {...}, "lists": {key: [{c, n, m, i, cap, v, prev, period, ...}, ...]}}

口徑
  股價新高／新低   最新收盤 ≥（≤）所有可得歷史收盤：2013 起每月底收盤（P/S 重建檔、個股頁）
                   ＋近期每日收盤；未還原權息。期間內發行股數變動逾 20%（分割、減資、大額配股）
                   只比較變動之後的價格，避免價格斷層造成假新高／新低。至少 24 個月歷史。
  利潤率新高       最新一季毛利率／營業利益率／淨利率高於 2013Q1 起所有前期，至少 12 季歷史。
  月營收新高       最新月份單月營收高於 2013-01 起所有前期，至少 24 個月歷史。
  合約負債新高     最新一季合約負債（總額，未揭露總額時用流動）高於 2022Q1 起所有前期，至少 4 季。
  P/S 分位         目前 P/S 對照 2013 起每月 P/S（不含本月）：≥ 第 95 百分位、≤ 第 5 百分位、
                   或高於歷史最大值；至少 36 個月歷史。
"""
from __future__ import annotations

import glob
import json
import math
from pathlib import Path

from util import DATA_DIR, log, read_json, write_json

MIN_PRICE_MONTHS = 24
MIN_MARGIN_Q = 12
MIN_REV_MONTHS = 24
MIN_CONTRACT_Q = 4
MIN_PS_MONTHS = 36
SHARE_JUMP = 0.20
MARGIN_NAMES = ("gpm", "opm", "npm")


def finite(v) -> bool:
    return isinstance(v, (int, float)) and math.isfinite(v)


def quantile(values: list[float], q: float) -> float:
    """線性內插百分位（與 numpy 預設相同）。"""
    xs = sorted(values)
    pos = (len(xs) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def is_stock(code: str) -> bool:
    return len(code) == 4 and code.isdigit() and not code.startswith("00")


def load_month_end(dir_: Path) -> dict[str, list[tuple[str, float, float | None]]]:
    """{code: [(ym, close, shares), ...]}，來自 P/S 重建檔（2013 起每月底）。"""
    out: dict[str, list] = {}
    for path in sorted(glob.glob(str(dir_ / "20*.json"))):
        data = read_json(Path(path), {}) or {}
        for ym, rec in data.items():
            for code, row in (rec.get("s") or {}).items():
                if isinstance(row, list) and len(row) >= 3 and finite(row[1]) and row[1] > 0:
                    out.setdefault(code, []).append((ym, float(row[1]), row[2] if finite(row[2]) else None))
    return out


def price_records(rows, month_end, stock_hist, daily_dates, daily, today: str):
    highs, lows = [], []
    for code, r in rows.items():
        p = r.get("p")
        if not finite(p) or p <= 0:
            continue
        series = sorted(month_end.get(code, []))
        # 發行股數跳動：只保留最後一次跳動之後的月份
        start = 0
        for i in range(1, len(series)):
            a, b = series[i - 1][2], series[i][2]
            if a and b and abs(b / a - 1) > SHARE_JUMP:
                start = i
        series = series[start:]
        first_ym = series[0][0] if series else None
        closes = {ym: c for ym, c, _ in series}
        for row in stock_hist.get(code, []):
            ym, close = row[0], row[4] if len(row) > 4 else None
            if finite(close) and close > 0 and (first_ym is None or ym >= first_ym):
                closes.setdefault(ym, float(close))
        months = sorted(closes)
        if len(months) < MIN_PRICE_MONTHS:
            continue
        hist = [(f"{ym} 月底", closes[ym]) for ym in months if ym < today[:7]]
        first_day = f"{months[0]}-01"
        for d, v in zip(daily_dates, daily.get(code, [])):
            if d < today and d >= first_day and finite(v) and v > 0:
                hist.append((d, float(v)))
        if not hist:
            continue
        hi_d, hi_v = max(hist, key=lambda x: x[1])
        lo_d, lo_v = min(hist, key=lambda x: x[1])
        base = {"since": months[0]}
        if p >= hi_v:
            highs.append(dict(base, c=code, v=p, prev=hi_v, period=hi_d))
        if p <= lo_v:
            lows.append(dict(base, c=code, v=p, prev=lo_v, period=lo_d))
    return highs, lows


def latest_beats(series: dict[str, float | None], min_prior: int, newest: str | None):
    """series 依期別排序；最新期需等於全市場最新期，且嚴格高於所有前期。"""
    keys = [k for k in sorted(series) if finite(series[k])]
    if len(keys) < min_prior + 1:
        return None
    last = keys[-1]
    if newest and last != newest:
        return None
    prior = keys[:-1]
    pk = max(prior, key=lambda k: series[k])
    if series[last] > series[pk]:
        return {"v": series[last], "prev": series[pk], "period": last, "prevPeriod": pk, "since": keys[0]}
    return None


def main() -> int:
    latest = read_json(DATA_DIR / "latest.json", []) or []
    rows = {str(r["c"]): r for r in latest if is_stock(str(r.get("c", "")))}
    if not rows:
        raise SystemExit("latest.json 沒有可用股票母體")
    prices = read_json(DATA_DIR / "prices.json", {}) or {}
    daily_dates = prices.get("dates") or []
    today = daily_dates[-1] if daily_dates else ""

    month_end = load_month_end(DATA_DIR / "ps_reconstructed")
    stock_hist, ps_hist = {}, {}
    fin, contract = {}, {}
    for code in rows:
        d = read_json(DATA_DIR / "stock" / f"{code}.json", {}) or {}
        stock_hist[code] = d.get("hist") or []
        ps_hist[code] = d.get("psHist") or []
        fin[code] = read_json(DATA_DIR / "fin_history" / f"{code}.json", {}) or {}
        op = read_json(DATA_DIR / "operating" / f"{code}.json", {}) or {}
        contract[code] = {
            k: (v.get("contractTotal") if v.get("contractTotal") is not None else v.get("contractCurrent"))
            for k, v in (op.get("periods") or {}).items()
        }

    lists: dict[str, list] = {}
    lists["price_high"], lists["price_low"] = price_records(
        rows, month_end, stock_hist, daily_dates, prices.get("p") or {}, today)

    # 全市場最新期：多數公司已公布的那一期才算數，避免舊期別的公司混入
    def newest_period(per_code: dict[str, list[str]]) -> str | None:
        counts: dict[str, int] = {}
        for keys in per_code.values():
            if keys:
                counts[keys[-1]] = counts.get(keys[-1], 0) + 1
        return max(counts, key=lambda k: (counts[k], k)) if counts else None

    rev_newest = newest_period({c: sorted(f.get("rev") or {}) for c, f in fin.items()})
    q_newest = newest_period({c: sorted(f.get("margin") or {}) for c, f in fin.items()})
    c_newest = newest_period({c: sorted(k for k, v in s.items() if v is not None) for c, s in contract.items()})

    for slot, name in enumerate(MARGIN_NAMES):
        out = []
        for code, f in fin.items():
            series = {q: (v[slot] if isinstance(v, list) and len(v) > slot else None) for q, v in (f.get("margin") or {}).items()}
            hit = latest_beats(series, MIN_MARGIN_Q, q_newest)
            if hit:
                out.append(dict(hit, c=code))
        lists[f"{name}_high"] = out

    out = []
    for code, f in fin.items():
        hit = latest_beats(f.get("rev") or {}, MIN_REV_MONTHS, rev_newest)
        if hit:
            out.append(dict(hit, c=code, v=hit["v"] * 1000, prev=hit["prev"] * 1000))  # 千元 → 元
    lists["revenue_high"] = out

    out = []
    for code, s in contract.items():
        hit = latest_beats(s, MIN_CONTRACT_Q, c_newest)
        if hit and hit["v"] > 0:
            out.append(dict(hit, c=code))
    lists["contract_high"] = out

    ps_hi, ps_q95, ps_q05 = [], [], []
    for code, r in rows.items():
        cur = r.get("ps")
        hist = [p.get("v") for p in ps_hist[code][:-1] if finite(p.get("v")) and p.get("v") > 0]
        if not finite(cur) or cur <= 0 or len(hist) < MIN_PS_MONTHS:
            continue
        q95, q05, top = quantile(hist, 0.95), quantile(hist, 0.05), max(hist)
        base = {"c": code, "v": cur, "q95": round(q95, 2), "q05": round(q05, 2), "max": top,
                "since": ps_hist[code][0].get("ym")}
        if cur > top:
            ps_hi.append(dict(base, prev=top))
        if cur >= q95:
            ps_q95.append(dict(base, prev=round(q95, 2)))
        if cur <= q05:
            ps_q05.append(dict(base, prev=round(q05, 2)))
    lists["ps_high"], lists["ps_q95"], lists["ps_q05"] = ps_hi, ps_q95, ps_q05

    for key, items in lists.items():
        for it in items:
            r = rows[it["c"]]
            it.update(n=r.get("n"), m=r.get("m"), i=r.get("i"), cap=r.get("cap"))
        items.sort(key=lambda it: -(it.get("cap") or 0))

    result = {
        "asOf": {"price": today, "revenue": rev_newest, "quarter": q_newest, "contract": c_newest},
        "counts": {k: len(v) for k, v in lists.items()},
        "lists": lists,
    }
    write_json(DATA_DIR / "records.json", result, compact=True)
    log("創新高榜：" + "、".join(f"{k} {len(v)}" for k, v in lists.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
