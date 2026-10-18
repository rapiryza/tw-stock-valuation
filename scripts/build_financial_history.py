"""個股歷年月營收與季毛利率、營業利益率、淨利率。

官方來源：
  月營收   公開資訊觀測站 t21sc03 每月彙總 CSV（上市 sii／上櫃 otc／興櫃 rotc，2013 起）
  利潤率   公開資訊觀測站－財務比較 E 點通 compare/data
           GrossMargin（毛利率）、OperatingMargin（營業利益率）、NetIncomeMargin（稅後純益率），單季

輸出 docs/data/fin_history/<code>.json：
  {"c": "2330", "rev": {"2013-01": 千元, ...}, "margin": {"2013Q1": [毛利率, 營業利益率, 淨利率], ...}}

月營收逐月抓取一次後記在 _state.json；之後每次只補沒抓過的月份並重抓最近 3 個月（更正）。
利潤率每次整批重抓（約 3 項 × 母體 ÷ 10 檔一批）。缺值保留 null，不以 0 代替。
"""
from __future__ import annotations

import argparse
import time
from datetime import date

from build_operating_leads import (
    Http,
    chunks,
    code_in_text,
    company_short_alias,
    display_name,
    normalize_identity,
    parse_number,
)
from reconstruct_ps_history import MARKETS, fetch, months, parse_revenue, shift
from util import DATA_DIR, log, now_taipei, read_json, write_json

OUT = DATA_DIR / "fin_history"
STATE = OUT / "_state.json"
FIRST_MONTH = "2013-01"
REFRESH_RECENT = 3
MARGINS = (("GrossMargin", 0), ("OperatingMargin", 1), ("NetIncomeMargin", 2))


def last_published_month(today: date) -> str:
    """月營收在次月 10 日前公告，最新只可能到上個月；尚未公告就抓不到，下次再補。"""
    ym = f"{today.year:04d}-{today.month:02d}"
    return shift(ym, -1)


def parse_margin_payload(payload: dict, batch: list[str]) -> dict[str, dict[str, float | None]]:
    """把 compare/data 的 graphData 依公司身分對回代號；對不上的系列丟棄，不猜。"""
    periods = [str(v) for v in payload.get("xaxisList") or []]
    aliases = {code: {normalize_identity(code)} for code in batch}
    batch_set = set(batch)
    lists = [payload.get(k) or [] for k in ("checkedNameList", "showNameList", "displayCompanyId")]
    for index, raw in enumerate(lists[0]):
        code = code_in_text(str(raw), batch_set)
        if code is None:
            continue
        for values in lists:
            if index < len(values) and values[index]:
                aliases[code].add(normalize_identity(values[index]))
                short = company_short_alias(values[index])
                if short:
                    aliases[code].add(short)
    out: dict[str, dict[str, float | None]] = {}
    claimed: set[str] = set()
    for series in payload.get("graphData") or []:
        label = normalize_identity(series.get("label"))
        hits = [c for c in batch if c not in claimed and (label in aliases[c] or label == c.lower())]
        if len(hits) != 1:
            continue
        code = hits[0]
        claimed.add(code)
        vals = out.setdefault(code, {})
        for point in series.get("data") or []:
            if not isinstance(point, list) or len(point) < 2:
                continue
            try:
                i = int(point[0])
            except (TypeError, ValueError):
                continue
            if 0 <= i < len(periods):
                v = parse_number(point[1])
                vals[periods[i]] = None if v is None else round(v, 2)
    return out


def fetch_margins(http: Http, codes: list[str], meta: dict, max_batches: int = 0) -> dict[str, dict[str, list]]:
    result: dict[str, dict[str, list]] = {}
    for metric, slot in MARGINS:
        for n, batch in enumerate(chunks(codes, 10), start=1):
            if max_batches and n > max_batches:
                break
            fields = [("compareItem", metric), ("ylabel", "%"), ("quarter", "true"), ("revenue", "true"),
                      ("ys", "0"), ("qnumber", ""), ("bcodeAvg", "false"), ("companyAvg", "false")]
            fields += [("companyId", display_name(c, meta)) for c in batch]
            try:
                payload = http.post("/compare/data", fields).json()
            except Exception as exc:  # noqa: BLE001
                log(f"[利潤率略過] {metric} #{n} {batch}: {exc}")
                continue
            for code, series in parse_margin_payload(payload, batch).items():
                rows = result.setdefault(code, {})
                for period, value in series.items():
                    rows.setdefault(period, [None, None, None])[slot] = value
        log(f"{metric} 完成")
    return result


def fetch_revenue_months(todo: list[tuple[str, str]], deadline: float, recent: set[str]) -> tuple[dict, list]:
    """回傳 {(code, ym): 千元} 與成功抓到的 (market, ym)。"""
    values: dict[tuple[str, str], float] = {}
    done: list[tuple[str, str]] = []
    for i, (market, ym) in enumerate(todo, start=1):
        if time.monotonic() > deadline:
            log(f"月營收達時間上限，剩 {len(todo) - i + 1} 個檔案下次補")
            break
        y, m = map(int, ym.split("-"))
        url = f"https://mopsov.twse.com.tw/nas/t21/{MARKETS[market]}/t21sc03_{y - 1911}_{m}.csv"
        try:
            rows = parse_revenue(fetch(url), ym)
        except Exception as exc:  # noqa: BLE001
            log(f"[月營收略過] {market} {ym}: {exc}")
            if ym not in recent:
                done.append((market, ym))  # 舊月份官方沒有檔案（例如興櫃早年），記下來不再重試
            continue
        for code, (amount, _) in rows.items():
            if amount is not None:
                values[(code, ym)] = amount
        done.append((market, ym))
        if i % 50 == 0:
            log(f"月營收 {i}/{len(todo)}")
    return values, done


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--codes", default="", help="除錯用：逗號分隔代號（只影響利潤率）")
    ap.add_argument("--skip-margins", action="store_true")
    ap.add_argument("--skip-revenue", action="store_true")
    ap.add_argument("--max-batches", type=int, default=0)
    ap.add_argument("--max-minutes", type=float, default=40)
    args = ap.parse_args()
    deadline = time.monotonic() + args.max_minutes * 60

    latest = read_json(DATA_DIR / "latest.json", []) or []
    meta = {str(r["c"]): r for r in latest if len(str(r.get("c", ""))) == 4 and str(r.get("c", "")).isdigit()}
    if not meta:
        raise SystemExit("latest.json 沒有可用股票母體")
    OUT.mkdir(parents=True, exist_ok=True)
    state = read_json(STATE, {}) or {}
    fetched = {m: set(state.get("fetched", {}).get(m, [])) for m in MARKETS}

    docs: dict[str, dict] = {}

    def doc(code: str) -> dict:
        if code not in docs:
            d = read_json(OUT / f"{code}.json", {}) or {}
            d.setdefault("rev", {})
            d.setdefault("margin", {})
            d["c"] = code
            docs[code] = d
        return docs[code]

    if not args.skip_revenue:
        end = last_published_month(now_taipei().date())
        recent = set(months(shift(end, -(REFRESH_RECENT - 1)), end))
        todo = [(mk, ym) for ym in sorted(months(FIRST_MONTH, end), reverse=True) for mk in MARKETS
                if ym in recent or ym not in fetched[mk]]
        log(f"月營收待抓 {len(todo)} 個檔案")
        values, done = fetch_revenue_months(todo, deadline, recent)
        for (code, ym), amount in values.items():
            if code in meta:
                doc(code)["rev"][ym] = amount
        for mk, ym in done:
            fetched[mk].add(ym)
        state["fetched"] = {m: sorted(v) for m, v in fetched.items()}

    if not args.skip_margins:
        codes = sorted(meta)
        if args.codes:
            wanted = {c.strip() for c in args.codes.split(",") if c.strip()}
            codes = [c for c in codes if c in wanted]
        margins = fetch_margins(Http(), codes, meta, args.max_batches)
        for code, rows in margins.items():
            d = doc(code)
            for period, triple in rows.items():
                if any(v is not None for v in triple):
                    d["margin"][period] = triple
        log(f"利潤率：{len(margins)} 檔")

    for code, d in docs.items():
        d["rev"] = dict(sorted(d["rev"].items()))
        d["margin"] = dict(sorted(d["margin"].items()))
        write_json(OUT / f"{code}.json", {"c": code, "rev": d["rev"], "margin": d["margin"]}, compact=True)
    state["updatedAt"] = now_taipei().isoformat(timespec="seconds")
    write_json(STATE, state, compact=True)
    log(f"寫出 {len(docs)} 檔")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
