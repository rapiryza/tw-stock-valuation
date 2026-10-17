"""產生最新快照：三市場的 P/E、P/S、月營收成長率、獲利成長率。

輸出：
    docs/data/latest.json   全市場個股最新指標
    docs/data/meta.json     資料日期、筆數、來源狀態
    docs/data/market.json   三市場加總的估值（各年度歷史由 rebuild_history.py 併入）
"""
from __future__ import annotations

import sys
from statistics import median
from typing import Any

import markets as M
import sources as S
from revenue import fetch_revenue
from ps_history import update_ps_history
from util import (
    DATA_DIR,
    log,
    month_key,
    now_taipei,
    num,
    pct_change,
    read_json,
    rnd,
    roc_ym,
    write_json,
)


# --------------------------------------------------------------- 抓取三市場

def _shares_from(rows: list[dict], code_keys: tuple[str, ...]) -> dict[str, dict]:
    """從公司基本資料取股數；沒有股數欄位時用實收資本額 ÷ 面額回推。"""
    out: dict[str, dict] = {}
    # 證交所用中文欄位、櫃買中心用英文欄位，兩邊拼法也不同，一併吸收
    share_keys = ("已發行普通股數或TDR原股發行股數", "已發行普通股數或TDR原發行股數",
                  "已發行普通股數", "IssueShares", "IssuedShares", "OutstandingShares")
    cap_keys = ("實收資本額", "Paidin.Capital.NTDollars", "Capitals", "CapitalStock", "PaidInCapital")
    for r in rows:
        code = ""
        for k in code_keys:
            if r.get(k):
                code = str(r[k]).strip()
                break
        if not code:
            continue
        shares = None
        for k in share_keys:
            if r.get(k) is not None:
                shares = num(r[k])
                if shares:
                    break
        if not shares:
            for k in cap_keys:
                if r.get(k) is not None:
                    cap = num(r[k])
                    if cap:
                        shares = cap / M.PAR_VALUE
                        break
        name = ""
        for k in ("公司簡稱", "CompanyAbbreviation", "Symbol", "公司名稱", "CompanyName"):
            if r.get(k):
                name = str(r[k]).strip()
                break
        out[code] = {"code": code, "name": name, "shares": shares}
    return out


def gather() -> tuple[dict[str, dict], dict[str, Any], Any]:
    """回傳 (個股資料, 來源狀態, 資料日期)。"""
    stocks: dict[str, dict] = {}
    status: dict[str, Any] = {}
    saved = read_json(DATA_DIR / "fundamentals.json", {}) or {}
    old_rows = read_json(DATA_DIR / "latest.json", []) or []

    def revenue(market):
        previous = {r["c"]: saved.get(r["c"], {}).get("revenue", {})
                    for r in old_rows if r["m"] == market}
        records, details = fetch_revenue(market, previous)
        status[f"{market}_revenue"] = len(records)
        status[f"{market}_revenue_details"] = details
        return records

    def note(key: str, rows: list) -> list:
        status[key] = len(rows)
        return rows

    # ---------------- 上市 ----------------
    # BWIBBU_d 一支就給名稱、收盤價、本益比、淨值比、殖利率
    log("上市…")
    day, daily = S.latest_trading_day("listed")
    note("listed_daily", daily)
    val = M.norm_daily_listed(daily)
    profile = _shares_from(note("listed_profile", S.fetch("listed_profile")), ("公司代號", "Code"))
    rev = revenue("listed")
    inc = M.norm_income(note("listed_income", S.fetch_income("listed")))
    merge(stocks, "listed", profile, val, rev, inc)

    # ---------------- 上櫃 ----------------
    log("上櫃…")
    quotes = note("otc_quotes", S.fetch("otc_quotes"))
    profile = _shares_from(note("otc_profile", S.fetch("otc_profile")), ("公司代號", "SecuritiesCompanyCode", "Code"))
    if not profile:
        profile = M.norm_profile_from_capital(quotes, "SecuritiesCompanyCode", "CompanyName", "Capitals")
    val = {}
    for r in quotes:
        code = str(r.get("SecuritiesCompanyCode", "")).strip()
        if code:
            val[code] = {"name": str(r.get("CompanyName", "")).strip(),
                         "price": num(r.get("Close")) or num(r.get("Average"))}
    for code, v in M.norm_valuation_otc(note("otc_pe", S.fetch("otc_pe"))).items():
        val.setdefault(code, {}).update(v)
    rev = revenue("otc")
    inc = M.norm_income(note("otc_income", S.fetch_income("otc")))
    merge(stocks, "otc", profile, val, rev, inc)

    # ---------------- 興櫃 ----------------
    # 官方未發布興櫃的綜合損益表，所以興櫃沒有獲利成長率。
    # 興櫃也沒有收盤價的概念，這裡用當日均價。
    log("興櫃…")
    esb = note("esb_quotes", S.fetch("esb_quotes"))
    profile = _shares_from(note("esb_profile", S.fetch("esb_profile")), ("公司代號", "SecuritiesCompanyCode", "Code"))
    val = {}
    for r in esb:
        code = str(r.get("SecuritiesCompanyCode", "")).strip()
        if code:
            val[code] = {"name": str(r.get("CompanyName", "")).strip(),
                         "price": num(r.get("Average")) or num(r.get("LatestPrice"))
                                  or num(r.get("PreviousAveragePrice"))}
    rev = revenue("esb")
    merge(stocks, "esb", profile, val, rev, {})

    return stocks, status, day


def merge(
    stocks: dict[str, dict],
    market: str,
    profile: dict[str, dict],
    val: dict[str, dict],
    rev: dict[str, dict],
    inc: dict[str, dict],
) -> None:
    """把同一市場的各項資料合併成個股紀錄。

    val 是當日報價與估值（名稱／收盤價／本益比／淨值比／殖利率），
    profile 提供股數，rev 是月營收，inc 是綜合損益表。
    """
    codes = set(profile) | set(val) | set(rev)
    for code in codes:
        # 濾掉 ETF / 權證 / 受益證券：只留 4 位數純數字的普通股代號
        if not (len(code) == 4 and code.isdigit()):
            continue
        p = profile.get(code, {})
        r = rev.get(code, {})
        v = val.get(code, {})
        i = inc.get(code, {})

        name = p.get("name") or v.get("name") or r.get("name") or ""
        px = v.get("price")
        shares = p.get("shares")
        cap = px * shares if (px and shares) else None

        stocks[code] = {
            "c": code,
            "n": name,
            "m": market,
            "i": r.get("industry"),
            "p": rnd(px),
            "cap": round(cap) if cap else None,
            "pe": rnd(v.get("pe")),
            **({"peReason": v["peReason"]} if v.get("peReason") else {}),
            "pb": rnd(v.get("pb")),
            "dy": rnd(v.get("dy")),
            "_shares": shares,
            "_rev": r,
            "_inc": i,
        }


# --------------------------------------------------------------- 指標計算

def ttm_revenue(r: dict) -> tuple[float | None, str]:
    """近十二個月營收（千元）與其計算基礎。

    月營收公布的是「今年累計」與「去年同期累計」，但沒有「去年全年」。
    有歷史資料時用精確公式；沒有時用去年同期的季節性比例推估。
    """
    cum, cum_ly, ym = r.get("cum"), r.get("cum_ly"), r.get("ym")
    parsed = roc_ym(ym) if ym else None
    if not (cum and parsed):
        return None, "無"
    month = parsed[1]
    if month >= 12:
        return cum, "實際"

    fy_ly = r.get("_fy_last_year")          # 由歷史資料填入（去年 12 月累計營收）
    if fy_ly:
        return cum + (fy_ly - (cum_ly or 0)), "實際"

    if cum_ly and cum_ly > 0:
        # 去年剩餘月份營收 ≈ 去年同期累計 × (12−M)/M
        return cum + cum_ly * (12 - month) / month, "估算"
    return cum * 12 / month, "估算"


def profit_growth(cur: dict, prev: dict | None) -> dict | None:
    """獲利成長率：本年度累計 vs 去年同期累計。"""
    if not cur or not cur.get("year"):
        return None
    out: dict[str, Any] = {
        "y": cur["year"] + 1911,
        "q": cur.get("quarter"),
        "eps": rnd(cur.get("eps")),
        "rev": cur.get("revenue"),
    }
    # 利潤率（不需要去年資料就能算）
    revv = cur.get("revenue")
    if revv and revv > 0:
        out["gpm"] = rnd((cur.get("gross") or 0) / revv * 100) if cur.get("gross") else None
        out["opm"] = rnd((cur.get("op") or 0) / revv * 100) if cur.get("op") else None
        out["npm"] = rnd((cur.get("net") or 0) / revv * 100) if cur.get("net") else None
    # 業外占比：業外收支 ÷ 稅前淨利、÷ 營業利益。分母 ≤ 0 時比例沒有意義，留白。
    # 損益表沒有單列業外時（部分業別），以「稅前淨利 − 營業利益」回推。
    op, pretax = cur.get("op"), cur.get("pretax")
    nonop = cur.get("nonop")
    if nonop is None and op is not None and pretax is not None:
        nonop = pretax - op
    if nonop is not None:
        out["nonop"] = nonop
        out["nonop_pt"] = rnd(nonop / pretax * 100) if pretax and pretax > 0 else None
        out["nonop_op"] = rnd(nonop / op * 100) if op and op > 0 else None
    # 淨利（千元）供前端計算外匯損益占淨利
    if cur.get("net") is not None:
        out["net"] = cur.get("net")
    if prev:
        out["net_yoy"] = rnd(pct_change(cur.get("net"), prev.get("net")))
        out["op_yoy"] = rnd(pct_change(cur.get("op"), prev.get("op")))
        out["gp_yoy"] = rnd(pct_change(cur.get("gross"), prev.get("gross")))
        out["eps_yoy"] = rnd(pct_change(cur.get("eps"), prev.get("eps")))
        out["rev_yoy"] = rnd(pct_change(cur.get("revenue"), prev.get("revenue")))
    return out


def finalise(stocks: dict[str, dict]) -> list[dict]:
    """算出 P/S 與各項成長率，並清掉內部欄位。"""
    fundamentals = read_json(DATA_DIR / "fundamentals.json", {}) or {}
    out = []
    for code, s in sorted(stocks.items()):
        hist = fundamentals.get(code, {})
        r = s.pop("_rev", {}) or {}
        i = s.pop("_inc", {}) or {}
        shares = s.pop("_shares", None)

        # 去年全年營收（若歷史中有 12 月的累計數）
        parsed = roc_ym(r.get("ym", "")) if r.get("ym") else None
        if parsed:
            last_dec = (hist.get("rev_cum") or {}).get(month_key(parsed[0] - 1, 12))
            if last_dec:
                r["_fy_last_year"] = last_dec

        ttm, basis = ttm_revenue(r)
        cap = s.get("cap")
        # 營收單位是千元，市值是元 → 換算後相除
        s["ps"] = rnd(cap / (ttm * 1000)) if (cap and ttm and ttm > 0) else None
        s["ps_basis"] = basis

        if r:
            s["rev"] = {
                "ym": month_key(*parsed) if parsed else None,
                "amt": r.get("month"),
                "note": r.get("note", ""),
                "source": r.get("source"),
                "publishedAt": r.get("publishedAt"),
                "mom": rnd(r.get("mom")),
                "yoy": rnd(r.get("yoy")),
                "cum_yoy": rnd(r.get("cum_yoy")),
            }

        # 去年同期的損益表（來自歷史累積）
        prev = None
        if i and i.get("year") and i.get("quarter"):
            prev = (hist.get("income") or {}).get(f"{i['year'] - 1}Q{i['quarter']}")
        pg = profit_growth(i, prev)
        if pg:
            s["fin"] = pg

        out.append(s)
    return out


def update_fundamentals(stocks: dict[str, dict]) -> None:
    """把這次看到的月營收累計數與損益表存進歷史，供之後計算年增率使用。"""
    path = DATA_DIR / "fundamentals.json"
    store = read_json(path, {}) or {}
    for code, s in stocks.items():
        r = s.get("_rev") or {}
        i = s.get("_inc") or {}
        entry = store.setdefault(code, {})
        if r.get("ym") and r.get("month") is not None:
            entry["revenue"] = {k: v for k, v in r.items() if not k.startswith("_")}
        if r.get("ym") and r.get("cum") is not None:
            parsed = roc_ym(r["ym"])
            if parsed:
                entry.setdefault("rev_cum", {})[month_key(*parsed)] = r["cum"]
        if i.get("year") and i.get("quarter"):
            entry.setdefault("income", {})[f"{i['year']}Q{i['quarter']}"] = {
                k: i.get(k) for k in ("revenue", "gross", "op", "pretax", "nonop", "net", "eps")
            }
    write_json(path, store)


def update_month_history(rows: list[dict], day) -> None:
    """把當月的估值快照寫進 docs/data/history/<年>.json。

    這件事非做不可：歷史月份原本只有「歷史回補」那支手動流程會寫，
    每日更新只讀不寫，各年度走勢圖就會永遠停在最後一次回補的月份。
    這裡每天用當日數值覆蓋「當月」那一筆，月底自然就停在該月最後一個交易日，
    新的月份也會自己長出來，跟回補的結果一致。
    """
    path = DATA_DIR / "history" / f"{day.year}.json"
    store = read_json(path, {}) or {}
    key = month_key(day.year, day.month)

    stocks = {}
    for s in rows:
        pe, pb, dy, p = s.get("pe"), s.get("pb"), s.get("dy"), s.get("p")
        if pe is None and pb is None and dy is None and not s.get("peReason"):
            continue
        stocks[s["c"]] = [pe, pb, dy, p]
        if s.get("peReason"):
            stocks[s["c"]].append(s["peReason"])
    if not stocks:
        return

    store[key] = {"d": day.isoformat(), "s": stocks}
    write_json(path, dict(sorted(store.items())))
    log(f"當月歷史 {key}（{day}）：{len(stocks)} 檔")


def market_aggregate(rows: list[dict]) -> dict:
    """三市場的估值水準：成分股的中位數。

    刻意用中位數而非市值加權，理由有二：一是與歷年走勢圖同口徑（歷史缺少當時的
    在外流通股數，加權算不出來），二是中位數不會被少數超大型股拉著走。
    另外附上市值加權值供對照。
    """
    agg: dict[str, dict] = {}
    for m in M.MARKETS:
        sel = [s for s in rows if s["m"] == m]
        pes = sorted(s["pe"] for s in sel if s.get("pe"))
        pss = sorted(s["ps"] for s in sel if s.get("ps"))
        cap = sum(s["cap"] for s in sel if s.get("cap"))
        earnings = sum(s["cap"] / s["pe"] for s in sel if s.get("cap") and s.get("pe"))
        sales = sum(s["cap"] / s["ps"] for s in sel if s.get("cap") and s.get("ps"))
        agg[m] = {
            "label": M.MARKET_LABEL[m],
            "count": len(sel),
            "cap": round(cap) if cap else None,
            "pe": rnd(median(pes)) if pes else None,
            "ps": rnd(median(pss)) if pss else None,
            "peWeighted": rnd(cap / earnings) if earnings else None,
            "psWeighted": rnd(cap / sales) if sales else None,
            "withPE": len(pes),
            "withPS": len(pss),
        }
    return agg


# --------------------------------------------------------------- 主流程

def main() -> int:
    stocks, status, day = gather()
    if not stocks:
        log("錯誤：完全沒有抓到任何個股資料")
        return 1

    update_fundamentals(stocks)
    rows = finalise(stocks)
    data_date = day.isoformat() if day else None

    write_json(DATA_DIR / "latest.json", rows)
    write_json(
        DATA_DIR / "market.json",
        {"asOf": data_date, "markets": market_aggregate(rows)},
        compact=False,
    )
    write_json(
        DATA_DIR / "meta.json",
        {
            "asOf": data_date,
            "updatedAt": now_taipei().isoformat(timespec="seconds"),
            "counts": {m: sum(1 for s in rows if s["m"] == m) for m in M.MARKETS},
            "total": len(rows),
            "sources": status,
            "withPE": sum(1 for s in rows if s.get("pe")),
            "withPS": sum(1 for s in rows if s.get("ps")),
            "withRevenue": sum(1 for s in rows if s.get("rev")),
            "withFinancials": sum(1 for s in rows if s.get("fin")),
        },
        compact=False,
    )

    log(f"完成：{len(rows)} 檔，資料日期 {data_date}")
    for m in M.MARKETS:
        n = sum(1 for s in rows if s["m"] == m)
        log(f"  {M.MARKET_LABEL[m]}：{n} 檔")

    if day:
        update_month_history(rows, day)
        update_ps_history(rows, day, now_taipei().isoformat(timespec="seconds"))

    # 每日快照的後兩段：收當天收盤價，再由收盤價算漲幅排行與族群。
    # 順序不能顛倒 —— build_movers 需要上面剛寫好的 latest.json。
    log("收集每日收盤價…")
    import fetch_prices
    fetch_prices.main()

    import build_profit_growth
    build_profit_growth.main()

    log("計算漲幅排行與族群…")
    import build_movers
    build_movers.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
