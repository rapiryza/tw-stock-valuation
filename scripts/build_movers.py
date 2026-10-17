"""算漲幅排行與「最近在漲什麼族群」。

讀 prices.json（每日收盤價）、latest.json（名稱／市場）、tags.json（業務標籤），
輸出 docs/data/movers.json：

    {"asOf": "2026-08-28",
     "periods": {
       "d1": {"days": 1, "from": "2026-08-27",
              "markets": {"listed": [ {c,n,r,p,t}, ... ], "otc": [...], "esb": [...]},   # 漲幅由高到低
              "losers":  {"listed": [...], "otc": [...], "esb": [...]},                # 跌幅由低到高
              "groups": [ {tag, n, med, top:[代號]}, ... ],         # 中位數由高到低，top 為組內漲最多
              "groupsDown": [ {tag, n, med, top:[代號]}, ... ]}}}   # 中位數由低到高，top 為組內跌最多

族群用「中位數」排名而不是平均：一檔飆股就能把平均拉起來，中位數要多數成員
一起漲才會高，比較接近「這個族群在動」的直覺。
"""
from __future__ import annotations

import sys
from collections import defaultdict
from statistics import median

from util import DATA_DIR, log, read_json, rnd, write_json

PERIODS = {"d1": 1, "d5": 5, "d10": 10, "d30": 30}
TOP_N = 40          # 每個市場列出的檔數
MIN_GROUP = 3       # 族群至少要有幾檔才納入排名
TOP_GROUPS = 25
LIMIT = 0.105       # 上市櫃單日漲跌幅上限 10%，含跳檔誤差；超過代表分割、減資或除權，價格不連續


def main() -> int:
    prices = read_json(DATA_DIR / "prices.json", None)
    rows = read_json(DATA_DIR / "latest.json", [])
    tags = read_json(DATA_DIR / "tags.json", {}) or {}
    if not prices or not prices.get("dates") or not rows:
        log("缺少 prices.json 或 latest.json，跳過")
        return 0

    dates = prices["dates"]
    px = prices["p"]
    meta = {r["c"]: r for r in rows}
    log(f"價格資料 {len(dates)} 個交易日、{len(px)} 檔")

    def price_at(code: str, idx: int) -> float | None:
        """取第 idx 個交易日的收盤價；當天沒有就往前找最多 3 天（停牌／無成交）。"""
        arr = px.get(code)
        if not arr or idx < 0 or idx >= len(arr):
            return None
        for j in range(idx, max(-1, idx - 4), -1):
            if arr[j] is not None:
                return arr[j]
        return None

    def has_gap(code: str, start: int, end: int) -> bool:
        """期間內任一天收盤相對前一筆收盤超過漲跌停範圍。"""
        arr = px.get(code) or []
        prev = None
        for j in range(max(0, start), min(end, len(arr) - 1) + 1):
            v = arr[j]
            if v is None:
                continue
            if prev and abs(v / prev - 1) > LIMIT:
                return True
            prev = v
        return False

    out: dict = {"asOf": dates[-1], "tradingDays": len(dates), "periods": {}}
    last = len(dates) - 1

    for key, n in PERIODS.items():
        base_i = last - n
        if base_i < 0:
            log(f"{key}：資料只有 {len(dates)} 天，不足 {n + 1} 天，略過")
            continue

        returns: dict[str, float] = {}
        for code in meta:
            now = price_at(code, last)
            then = price_at(code, base_i)
            if now and then and then > 0:
                if meta[code]["m"] in ("listed", "otc") and has_gap(code, base_i, last):
                    continue  # 期間內有分割／減資造成的價格斷層，算出來的不是真的漲跌
                returns[code] = (now / then - 1) * 100

        def item(c: str, r: float) -> dict:
            return {
                "c": c,
                "n": meta[c]["n"],
                "r": rnd(r),
                "p": meta[c].get("p"),
                "t": tags.get(c, [])[:3],
                "i": meta[c].get("i"),
            }

        markets: dict[str, list] = {}
        losers: dict[str, list] = {}
        for m in ("listed", "otc", "esb"):
            sel = [(c, r) for c, r in returns.items() if meta[c]["m"] == m]
            sel.sort(key=lambda x: (-x[1], x[0]))
            markets[m] = [item(c, r) for c, r in sel[:TOP_N] if r > 0]
            sel.sort(key=lambda x: (x[1], x[0]))
            losers[m] = [item(c, r) for c, r in sel[:TOP_N] if r < 0]

        # 族群：把每個標籤底下所有有報酬率的成員聚在一起
        by_tag: dict[str, list[tuple[str, float]]] = defaultdict(list)
        for code, r in returns.items():
            for t in tags.get(code, []):
                by_tag[t].append((code, r))
        groups = []
        for tag, members in by_tag.items():
            if len(members) < MIN_GROUP:
                continue
            vals = [r for _, r in members]
            members.sort(key=lambda x: (-x[1], x[0]))
            groups.append({
                "tag": tag,
                "n": len(members),
                "med": rnd(median(vals)),
                "top": [c for c, _ in members[:3]],
                "bottom": [c for c, _ in members[::-1][:3]],
            })
        groups.sort(key=lambda g: (-(g["med"] or 0), g["tag"]))
        up = [{k: g[k] for k in ("tag", "n", "med", "top")} for g in groups if (g["med"] or 0) > 0][:TOP_GROUPS]
        down = [{"tag": g["tag"], "n": g["n"], "med": g["med"], "top": g["bottom"]}
                for g in reversed(groups) if (g["med"] or 0) < 0][:TOP_GROUPS]

        out["periods"][key] = {
            "days": n,
            "from": dates[base_i],
            "counts": {m: sum(1 for c in returns if meta[c]["m"] == m) for m in ("listed", "otc", "esb")},
            "markets": markets,
            "losers": losers,
            "groups": up,
            "groupsDown": down,
        }
        log(f"{key}（{dates[base_i]} → {dates[last]}）：{len(returns)} 檔、{len(groups)} 個族群")

    write_json(DATA_DIR / "movers.json", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
