"""外幣兌換損益：從官方 iXBRL 財報附註讀取「外幣兌換利益（損失）」年初至今累計數。

為什麼要另外抓：
- 證交所／櫃買中心的綜合損益表 OpenAPI 只有「營業外收入及支出」合計，
  沒有拆出外幣兌換損益；這個數字只在財報附註（其他利益及損失）裡。
- 公開資訊觀測站的 iXBRL 以 `tifrs-notes:ForeignExchangeGainsLosses_n`
  標記這一列，期間為年初至季底（例：From20260101To20260630）。

輸出 docs/data/fx_gains.json：
    {"stocks": {"2330": {"year": 2026, "quarter": 2, "fx": 6598890000,
                         "status": "ok", "checkedAt": ...}}}
金額單位為新台幣「元」（已套用 iXBRL scale）。前端以此除以同期淨利算占比。

一家一份財報，全市場約兩千份，因此每次只處理 --max-requests 份並可接續：
已確認的 (公司, 期別) 不會重抓；網路失敗則留待下次重試，不會被誤標為「未揭露」。
金融保險業多半沒有這個附註科目，會標為 not_disclosed 並在網頁上留白。
"""
from __future__ import annotations

import argparse
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from build_note_disclosures import (
    NoteClient,
    _RAW_CONTEXT_RE,
    _RAW_FACT_RE,
    ixbrl_documents,
    quarter_end,
    raw_attrs,
    raw_fact_value,
)
from util import DATA_DIR, log, read_json, write_json

OUT = DATA_DIR / "fx_gains.json"
TZ = timezone(timedelta(hours=8))
PARSER_VERSION = 1
MAX_ATTEMPTS = 3

_START_RE = re.compile(r"<xbrli:startDate>([^<]+)</xbrli:startDate>", re.I)
_END_RE = re.compile(r"<xbrli:endDate>([^<]+)</xbrli:endDate>", re.I)
_MEMBER_RE = re.compile(r"<(?:[\w-]+:)?(?:explicitMember|typedMember)\b", re.I)

# 主要科目：附註「外幣兌換利益（損失）」，正數為利益。
PRIMARY = "foreignexchangegainslosses"
# 備援：IFRS 原生科目（少數公司只在主表標這兩個）。利益為正、損失記為負。
FALLBACK_SIGN = {"netforeignexchangegain": 1, "foreignexchangegain": 1, "foreignexchangeloss": -1}


def duration_contexts(document: str) -> dict[str, tuple[str, str]]:
    """context id → (startDate, endDate)，略過帶維度成員的 context。"""
    out: dict[str, tuple[str, str]] = {}
    for match in _RAW_CONTEXT_RE.finditer(document):
        body = match.group("body")
        if _MEMBER_RE.search(body):
            continue
        cid = raw_attrs(match.group("attrs")).get("id")
        start, end = _START_RE.search(body), _END_RE.search(body)
        if cid and start and end:
            out[cid] = (start.group(1).strip(), end.group(1).strip())
    return out


def local_name(concept: str) -> str:
    local = concept.split(":")[-1].lower()
    return re.sub(r"_n$", "", local)


def parse_fx_gain(document: str, period: str) -> int | None:
    """回傳年初至季底的外幣兌換損益（元）；查無則 None。"""
    year = period.split("Q")[0]
    target = (f"{year}-01-01", quarter_end(period))
    contexts = duration_contexts(document)
    primary: list[int] = []
    fallback: list[int] = []
    for match in _RAW_FACT_RE.finditer(document):
        attrs = raw_attrs(match.group("attrs") or match.group("selfattrs") or "")
        if contexts.get(attrs.get("contextref", "")) != target:
            continue
        local = local_name(attrs.get("name", ""))
        if local == PRIMARY:
            value = raw_fact_value(match.group("body"), attrs)
            if value is not None:
                primary.append(value)
        elif local in FALLBACK_SIGN:
            value = raw_fact_value(match.group("body"), attrs)
            if value is not None:
                fallback.append(-abs(value) if FALLBACK_SIGN[local] < 0 else value)
    if primary:
        return primary[0]
    if fallback:
        return fallback[0]
    return None


def parse_report(content: bytes, period: str) -> int | None:
    for doc in ixbrl_documents(content):
        value = parse_fx_gain(doc, period)
        if value is not None:
            return value
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codes", default="", help="只處理指定股票，逗號分隔")
    parser.add_argument("--max-requests", type=int, default=300, help="本次最多下載幾份 iXBRL")
    parser.add_argument("--refresh", action="store_true", help="已確認的也重抓")
    args = parser.parse_args()

    rows = read_json(DATA_DIR / "latest.json", []) or []
    store = read_json(OUT, {"stocks": {}}) or {"stocks": {}}
    stocks: dict[str, Any] = store.setdefault("stocks", {})
    selected = {c.strip() for c in args.codes.split(",") if c.strip()}

    jobs: list[tuple[float, str, str]] = []
    for r in rows:
        fin = r.get("fin") or {}
        code = str(r.get("c") or "")
        if not (fin.get("y") and fin.get("q")) or (selected and code not in selected):
            continue
        period = f"{fin['y']}Q{fin['q']}"
        rec = stocks.get(code) or {}
        same = rec.get("period") == period and rec.get("parserVersion") == PARSER_VERSION
        if same and not args.refresh:
            if rec.get("status") in ("ok", "not_disclosed"):
                continue
            if rec.get("attempts", 0) >= MAX_ATTEMPTS:
                continue
        jobs.append((-(r.get("cap") or 0), code, period))

    jobs.sort()
    if args.max_requests > 0:
        jobs = jobs[: args.max_requests]
    log(f"外幣兌換損益：本次 {len(jobs)} 份")

    client = NoteClient()
    done = 0
    for _cap, code, period in jobs:
        prev = stocks.get(code) or {}
        attempts = prev.get("attempts", 0) if prev.get("period") == period else 0
        now = datetime.now(TZ).isoformat(timespec="seconds")
        y, q = period.split("Q")
        try:
            content, report_id = client.download(code, period)
            value = parse_report(content, period)
            stocks[code] = {
                "year": int(y), "quarter": int(q), "period": period,
                "fx": value,
                "status": "ok" if value is not None else "not_disclosed",
                "reportType": "consolidated" if report_id == "C" else "standalone",
                "checkedAt": now, "parserVersion": PARSER_VERSION,
            }
            done += 1
        except Exception as exc:  # noqa: BLE001 — 留待下次重試
            stocks[code] = {
                "year": int(y), "quarter": int(q), "period": period, "fx": None,
                "status": "retry", "error": str(exc)[:200], "attempts": attempts + 1,
                "checkedAt": now, "parserVersion": PARSER_VERSION,
            }
            log(f"[外幣兌換損益待重試] {code} {period}: {exc}")
        if done and done % 25 == 0:
            write_json(OUT, store)

    store.update(
        updatedAt=datetime.now(TZ).isoformat(timespec="seconds"),
        unit="TWD",
        periodType="YTD",
        source="https://mopsov.twse.com.tw/server-java/t164sb01",
        concept="tifrs-notes:ForeignExchangeGainsLosses",
    )
    write_json(OUT, store)
    ok = sum(1 for v in stocks.values() if v.get("status") == "ok")
    log(f"外幣兌換損益完成：本次 {done}/{len(jobs)}，累計有值 {ok} 檔")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
