"""三率篩選頁的彙整檔：只用站上已保存的資料，不另外連網。

輸入
  docs/data/latest.json            代號、名稱、市場、產業、市值（元）
  docs/data/fin_history/<c>.json   季毛利率／營業利益率／淨利率（%）、月營收（千元）

輸出 docs/data/screener.json：
  {"asOf": {"quarter": 全市場最新季, "cap": 市值資料日, "builtAt": ...},
   "n": 每檔保存季數,
   "stocks": [[代號, 名稱, 市場, 產業, 市值(億), 最新季, 單季營收(億),
               [毛利率×n], [營業利益率×n], [淨利率×n]], ...]}

口徑
  每檔以自己最新一季為「本季」，往前取連續 n 季（缺季保留 null），陣列最後一格是本季；
  最新季早於全市場最新季的公司前端標示為財報落後。落後超過 MAX_LAG 季的不收錄。
  單季營收 = 該季三個月月營收加總；任一月缺漏則為 null。
"""
from __future__ import annotations

import math
import re

from util import DATA_DIR, log, now_taipei, read_json, write_json

N_QUARTERS = 9  # 本季 + 去年同季 + 8 季走勢圖 + 連續 8 季成長
MAX_LAG = 4


def finite(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def q_index(label: str) -> int | None:
    m = re.fullmatch(r"(\d{4})Q([1-4])", label or "")
    return int(m[1]) * 4 + int(m[2]) - 1 if m else None


def q_label(idx: int) -> str:
    return f"{idx // 4}Q{idx % 4 + 1}"


def quarter_revenue(rev: dict, label: str) -> float | None:
    """單季營收（千元）＝三個月月營收加總。"""
    idx = q_index(label)
    if idx is None:
        return None
    y, q = idx // 4, idx % 4
    vals = [rev.get(f"{y:04d}-{q * 3 + k:02d}") for k in (1, 2, 3)]
    return sum(vals) if all(finite(v) for v in vals) else None


def latest_quarter(margin: dict) -> str | None:
    """最新一季：至少有一個比率有值的最後一期。"""
    keys = [k for k, v in margin.items()
            if q_index(k) is not None and isinstance(v, list) and any(finite(x) for x in v[:3])]
    return max(keys, key=q_index) if keys else None


def series(margin: dict, end: int, n: int = N_QUARTERS) -> list[list[float | None]]:
    out: list[list[float | None]] = [[], [], []]
    for idx in range(end - n + 1, end + 1):
        row = margin.get(q_label(idx))
        for slot in range(3):
            v = row[slot] if isinstance(row, list) and len(row) > slot else None
            out[slot].append(round(float(v), 2) if finite(v) else None)
    return out


def build_row(r: dict, fin: dict, newest: int | None) -> list | None:
    margin = fin.get("margin") or {}
    last = latest_quarter(margin)
    if last is None:
        return None
    end = q_index(last)
    if newest is not None and newest - end > MAX_LAG:
        return None
    rev = quarter_revenue(fin.get("rev") or {}, last)
    cap = r.get("cap")
    g, o, n = series(margin, end)
    return [
        str(r["c"]), r.get("n") or "", r.get("m") or "", r.get("i") or "",
        round(cap / 1e8, 1) if finite(cap) else None,  # 元 → 億
        last,
        round(rev / 1e5, 2) if rev is not None else None,  # 千元 → 億
        g, o, n,
    ]


def main() -> int:
    latest = read_json(DATA_DIR / "latest.json", []) or []
    if not latest:
        raise SystemExit("latest.json 沒有可用股票母體")
    meta = read_json(DATA_DIR / "meta.json", {}) or {}
    fins = {}
    for r in latest:
        code = str(r.get("c", ""))
        if code:
            fins[code] = read_json(DATA_DIR / "fin_history" / f"{code}.json", {}) or {}

    # 全市場最新季：多數公司已公布的那一期（同 build_records）
    counts: dict[str, int] = {}
    for f in fins.values():
        last = latest_quarter(f.get("margin") or {})
        if last:
            counts[last] = counts.get(last, 0) + 1
    newest = max(counts, key=lambda k: (counts[k], q_index(k))) if counts else None
    newest_idx = q_index(newest) if newest else None

    stocks = []
    for r in latest:
        code = str(r.get("c", ""))
        row = build_row(r, fins.get(code) or {}, newest_idx)
        if row:
            stocks.append(row)
    stocks.sort(key=lambda s: -(s[4] or 0))

    result = {
        "asOf": {"quarter": newest, "cap": meta.get("asOf"), "builtAt": now_taipei().isoformat(timespec="seconds")},
        "n": N_QUARTERS,
        "stocks": stocks,
    }
    write_json(DATA_DIR / "screener.json", result, compact=True)
    lag = sum(1 for s in stocks if s[5] != newest)
    log(f"三率篩選：{len(stocks)} 檔，最新季 {newest}，財報落後 {lag} 檔")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
