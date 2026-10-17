"""內部人持股月增減與轉讓事前申報 → docs/data/insider_flows.json

持股（口徑詳見 insider_holdings.py）：
- 總額：證交所 IRB110（董監實際持有 + 經理人實際持有），唯一總額依據。
- 單月增減：公開資訊觀測站內部人持股異動事後申報表（query6_1）之
  集中市場買賣 + 員工股/RSU（明確標示）；配股、分割、贈與、轉讓、名單異動一律剔除並列出。
  明細尚未取得的月份，單月增減留白（不拿總額差代替）。
- 明細加總逐月與 IRB110 核對，結果寫在 verified。

轉讓（t187ap12）：每日轉讓「事前申報」，只是預定轉讓，不是成交，也不計入持股增減。

單位：張（1 張 = 1,000 股）。
"""
from __future__ import annotations

import re
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any

from insider_holdings import compute_month, to_lots
from insider_sources import load_detail, load_irb110, latest_months, month_back
from util import DATA_DIR, get_json, log, num, read_json, roc_to_date, rows_from_fields, write_json

OUT = DATA_DIR / "insider_flows.json"
PRICES = DATA_DIR / "prices.json"
TW = timezone(timedelta(hours=8))

TRANSFER_SOURCES = [
    {"name": "twse", "market": "listed", "url": "https://openapi.twse.com.tw/v1/opendata/t187ap12_L"},
    {"name": "tpex", "market": "otc", "url": "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap12_O"},
    {"name": "esb", "market": "esb", "url": "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap12_R", "optional": True},
]

WINDOWS = {"d1": 1, "d5": 5, "d10": 10, "d30": 30}
HOLDING_WINDOWS = {"m1": 1, "m3": 3, "m6": 6}
KEEP_TRANSFER_DAYS = 420
IRB_MONTHS = 24          # IRB110 總額保留月數
DETAIL_MONTHS = 6        # 單月增減需要明細的月數（m6 彙總）


def clean_code(value: Any) -> str | None:
    m = re.search(r"\d{4}", str(value or ""))
    return m.group(0) if m else None


def norm_key(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or ""))


def clean_title(t: str) -> str:
    for suffix in ["本人", "之法人代表人", "之配偶、未成年子女及利用他人名義持有者"]:
        t = t.replace(suffix, "")
    return t.strip()


def pick(row: dict[str, Any], *candidates: str) -> Any:
    normalized = {norm_key(k): v for k, v in row.items()}
    for candidate in candidates:
        key = norm_key(candidate)
        if key in normalized:
            return normalized[key]
    return None


def lots(value: Any) -> float:
    n = num(value)
    return 0.0 if n is None else round(n / 1000.0, 3)


# ------------------------------------------------------------ 轉讓事前申報

def transfer_rows(src: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        payload = get_json(src["url"], tries=3)
    except Exception as exc:  # noqa: BLE001
        if src.get("optional"):
            log(f"  跳過 {src['name']}：{exc}")
            return []
        raise
    out: list[dict[str, Any]] = []
    for row in rows_from_fields(payload):
        code = clean_code(pick(row, "公司代號", "SecuritiesCompanyCode", "股票代號", "Code"))
        d = roc_to_date(str(pick(row, "出表日期", "Date", "申報日期", "資料日期") or ""))
        amount = lots(pick(row, "預定轉讓方式及股數-轉讓股數", "預定轉讓總股數-自有持股"))
        if not code or not d or amount <= 0:
            continue
        out.append({
            "date": d.isoformat(), "code": code, "lots": amount,
            "title": clean_title(str(pick(row, "申報人身分", "申請人身分", "身分別", "職稱") or "")) or "內部人",
            "name": str(pick(row, "姓名", "Name") or "").strip() or "未揭露",
            "method": str(pick(row, "預定轉讓方式及股數-轉讓方式", "轉讓方式") or "").strip(),
        })
    log(f"  {src['name']} 轉讓申報：{len(out)} 筆")
    return out


def trading_anchor_and_starts() -> tuple[date, dict[str, date]]:
    prices = read_json(PRICES, {}) or {}
    parsed = sorted({datetime.strptime(str(d), "%Y-%m-%d").date() for d in prices.get("dates") or []
                     if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(d))})
    anchor = parsed[-1] if parsed else date.today()
    usable = [d for d in parsed if d <= anchor]
    starts = {k: (usable[max(0, len(usable) - n)] if usable else anchor - timedelta(days=n - 1)) for k, n in WINDOWS.items()}
    return anchor, starts


def build_transfers(old: dict[str, Any], anchor: date, starts: dict[str, date]) -> dict[str, dict[str, Any]]:
    per_day: dict[str, dict[str, float]] = defaultdict(dict)
    people: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    for code, obj in (old.get("stocks") or {}).items():
        for item in (obj.get("transfer") or {}).get("series") or []:
            if isinstance(item, list) and len(item) >= 2 and float(item[1] or 0) > 0:
                per_day[code][str(item[0])] = float(item[1])
                if len(item) >= 3 and isinstance(item[2], list):
                    people[code][str(item[0])] = item[2]

    fresh: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    fresh_people: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    for src in TRANSFER_SOURCES:
        try:
            events = transfer_rows(src)
        except Exception as exc:  # noqa: BLE001
            log(f"  轉讓申報 {src['name']} 失敗，沿用舊資料：{exc}")
            continue
        for e in events:
            fresh[e["code"]][e["date"]] += e["lots"]
            fresh_people[e["code"]][e["date"]].append({k: e[k] for k in ("title", "name", "lots", "method")})
    for code, days in fresh.items():
        for d, amount in days.items():
            per_day[code][d] = round(amount, 3)
            people[code][d] = fresh_people[code][d]

    cutoff = anchor - timedelta(days=KEEP_TRANSFER_DAYS)
    out: dict[str, dict[str, Any]] = {}
    for code, days in per_day.items():
        series = [[d, round(v, 3), people[code].get(d, [])] for d, v in sorted(days.items())
                  if v > 0 and datetime.strptime(d, "%Y-%m-%d").date() >= cutoff]
        if not series:
            continue
        summary = {
            k: round(sum(v for d, v, _ in series if start <= datetime.strptime(d, "%Y-%m-%d").date() <= anchor), 3)
            for k, start in starts.items()
        }
        out[code] = {"latestDate": series[-1][0], "latestLots": series[-1][1], "summary": summary, "series": series[-180:]}
    return out


# ------------------------------------------------------------ 持股（IRB110 + 明細）

def build_holdings(irb: dict[str, dict[str, dict[str, Any]]]) -> dict[str, dict[str, Any]]:
    months = sorted(irb)
    codes = sorted({c for m in months for c in irb[m]})
    detail_months = set(months[-DETAIL_MONTHS:])
    out: dict[str, dict[str, Any]] = {}
    for code in codes:
        series: list[list[Any]] = []
        prev_rec = None
        prev_month = None
        latest_people: list[dict[str, Any]] = []
        for month in months:
            rec = irb[month].get(code)
            if rec is None:
                prev_rec, prev_month = None, None
                continue
            total = to_lots(rec["dir"] + rec["mgr"])
            # 前月 IRB110 必須是緊鄰的上一個月，否則「月增減」不成立
            adj_prev = prev_rec if prev_month == month_back(month, 1) else None
            raw = None if adj_prev is None else to_lots((rec["dir"] + rec["mgr"]) - (adj_prev["dir"] + adj_prev["mgr"]))
            meta: dict[str, Any] = {"raw": raw, "dir": to_lots(rec["dir"]), "mgr": to_lots(rec["mgr"]), "detail": False}
            counted = None
            breakdown: list[dict[str, Any]] = []
            rows = load_detail(code, month) if month in detail_months else None
            if rows:
                res = compute_month(rows, rec, adj_prev)
                meta.update(
                    detail=True, verified=res["verified"], market=res["market"], rsu=res["rsu"],
                    corp=res["corp"], otherOut=res["otherOut"], otherIn=res["otherIn"],
                    personnel=res["personnel"], corpRatio=res["corpRatio"], excluded=res["excluded"],
                )
                if not res["verified"]:
                    meta["detailTotal"] = round(res["detailDir"] + res["detailMgr"], 3)
                # 有前月 IRB110 才有「單月」；第一個月只能顯示總額
                if adj_prev is not None:
                    counted = res["counted"]
                breakdown = res["breakdown"]
                latest_people = res["people"]
            elif rows == [] and month in detail_months:
                meta["noFiling"] = True  # 官方查無申報
            series.append([month, total, counted, breakdown, meta])
            prev_rec, prev_month = rec, month

        if not series:
            continue
        last = series[-1]
        summary: dict[str, float | None] = {}
        for key, n in HOLDING_WINDOWS.items():
            window = series[-n:]
            vals = [s[2] for s in window]
            summary[key] = round(sum(vals), 3) if len(window) == n and all(v is not None for v in vals) else None
        out[code] = {
            "latestMonth": last[0],
            "latestLots": last[1],
            "monthlyChange": last[2],
            "monthlyRaw": last[4].get("raw"),
            "rsu": last[4].get("rsu"),
            "verified": last[4].get("verified"),
            "detail": last[4].get("detail", False),
            "market": irb[last[0]][code].get("m"),
            "summary": summary,
            "series": series[-IRB_MONTHS:],
            "people": latest_people,
        }
    return out


def main() -> int:
    old = read_json(OUT, {}) or {}
    anchor, starts = trading_anchor_and_starts()

    log("內部人持股：讀取證交所 IRB110 官方彙總表…")
    irb = load_irb110(latest_months(count=IRB_MONTHS + 1))
    if not irb:
        log("IRB110 一個月份都取不到，保留舊檔不覆寫")
        return 1
    holdings = build_holdings(irb)

    log("轉讓事前申報（t187ap12）…")
    transfers = build_transfers(old, anchor, starts)

    stocks: dict[str, Any] = {}
    for code in sorted(set(holdings) | set(transfers)):
        stocks[code] = {
            "transfer": transfers.get(code) or {"latestDate": None, "latestLots": None, "summary": {}, "series": []},
            "holding": holdings.get(code) or {"latestMonth": None, "latestLots": None, "monthlyChange": None, "series": []},
        }

    latest_irb = max(irb)
    out = {
        "asOf": anchor.isoformat(),
        "updatedAt": datetime.now(TW).isoformat(timespec="seconds"),
        "unit": "張",
        "windows": WINDOWS,
        "holdingWindows": HOLDING_WINDOWS,
        "irb110Latest": latest_irb,
        "method": {
            "total": "證交所 IRB110：董事監察人實際持有股數＋經理人實際持有股數（不含百分之十以上大股東欄、法人代表人分戶、保留運用決定權信託）",
            "change": "公開資訊觀測站內部人持股異動事後申報表：集中市場買進−賣出＋員工股/RSU（標示）",
            "excluded": "除權配股、股票分割、贈與、轉讓、信託、內部人間移轉、董監經理人名單異動",
            "transfer": "轉讓事前申報只是預定，不是成交，不計入持股增減",
        },
        "stocks": stocks,
    }
    write_json(OUT, out)

    h = [s["holding"] for s in stocks.values() if s["holding"].get("latestMonth")]
    log(
        f"完成：IRB110 最新 {latest_irb}；持股 {len(h)} 檔，最新月有明細 {sum(1 for x in h if x.get('detail'))} 檔、"
        f"核對相符 {sum(1 for x in h if x.get('verified'))} 檔；轉讓申報 {sum(1 for s in stocks.values() if s['transfer']['series'])} 檔"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
