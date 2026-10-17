"""內部人資料的官方來源與本機快取。

- IRB110：證交所 siis（上市 sii／上櫃 otc／興櫃 rotc），每月一份全市場彙總表，約次月中旬公布。
  快取於 docs/data/insider_irb110/YYYY-MM.json；最近兩個月每天重抓，以吸收更正。
- 內部人持股異動事後申報表：公開資訊觀測站 query6_1，一家公司一個月一份。
  快取於 docs/data/insider_detail/YYYY-MM/代號.json（只存計算需要的 9 欄）。
  舊版 docs/data/mops_cache/代號_民國年_月.json 仍可讀取，不必重抓。
"""
from __future__ import annotations

import json
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests

from insider_holdings import compact_api_rows, parse_irb110_html, parse_mopsov_html
from util import DATA_DIR, log

TW = timezone(timedelta(hours=8))
IRB_DIR = DATA_DIR / "insider_irb110"
DETAIL_DIR = DATA_DIR / "insider_detail"
LEGACY_DIR = DATA_DIR / "mops_cache"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
MARKETS = {"sii": "listed", "otc": "otc", "rotc": "esb"}


def now() -> datetime:
    return datetime.now(TW)


def month_back(month: str, n: int) -> str:
    y, m = map(int, month.split("-"))
    idx = y * 12 + (m - 1) - n
    return f"{idx // 12:04d}-{idx % 12 + 1:02d}"


def roc(month: str) -> tuple[str, str]:
    y, m = month.split("-")
    return str(int(y) - 1911), m


def _read(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


# ------------------------------------------------------------------ IRB110

def fetch_irb110(month: str, session: requests.Session) -> dict[str, dict[str, Any]] | None:
    y, m = roc(month)
    stocks: dict[str, dict[str, Any]] = {}
    found = False
    for mkt, label in MARKETS.items():
        url = f"https://siis.twse.com.tw/publish/{mkt}/{y}IRB110_{m}.HTM"
        try:
            r = session.get(url, timeout=20)
        except requests.RequestException as exc:
            raise RuntimeError(f"IRB110 {month} {mkt}: {exc}") from exc
        if r.status_code == 404:
            continue
        r.raise_for_status()
        text = r.content.decode("big5", errors="ignore")
        if "IRB110" not in text:
            continue
        found = True
        for code, rec in parse_irb110_html(text).items():
            stocks[code] = {**rec, "m": label}
    return stocks if found else None


def load_irb110(months: list[str], refresh_recent: int = 2) -> dict[str, dict[str, dict[str, Any]]]:
    """回傳 {月份: {代號: IRB110 紀錄}}；只含官方已公布的月份。"""
    session = requests.Session()
    session.headers["User-Agent"] = UA
    out: dict[str, dict[str, dict[str, Any]]] = {}
    recent = set(sorted(months)[-refresh_recent:])
    for month in sorted(months):
        path = IRB_DIR / f"{month}.json"
        cached = _read(path)
        stale = month in recent and (
            not cached or (now() - datetime.fromisoformat(cached["fetchedAt"])).total_seconds() > 20 * 3600
        )
        if cached and not stale:
            out[month] = cached["stocks"]
            continue
        try:
            stocks = fetch_irb110(month, session)
            time.sleep(1.0)
        except RuntimeError as exc:
            log(f"  {exc}；沿用快取")
            stocks = None
        if stocks:
            _write(path, {"fetchedAt": now().isoformat(timespec="seconds"), "month": month, "stocks": stocks})
            out[month] = stocks
        elif cached:
            out[month] = cached["stocks"]
    return out


# ------------------------------------------------------------- query6_1 明細

def detail_path(code: str, month: str) -> Path:
    return DETAIL_DIR / month / f"{code}.json"


def load_detail(code: str, month: str) -> list[list[Any]] | None:
    rec = _read(detail_path(code, month))
    if rec is not None:
        return rec.get("rows") if rec.get("rows") else ([] if rec.get("empty") else None)
    y, m = roc(month)
    legacy = _read(LEGACY_DIR / f"{code}_{y}_{m}.json")
    if legacy and (legacy.get("result") or {}).get("data"):
        return compact_api_rows(legacy["result"]["data"])
    return None


def detail_needs_fetch(code: str, month: str) -> bool:
    rec = _read(detail_path(code, month))
    if rec is None:
        return load_detail(code, month) is None
    if rec.get("rows"):
        return False
    # 公司尚未申報：兩天後再試
    fetched = datetime.fromisoformat(rec.get("fetchedAt"))
    return (now() - fetched).total_seconds() > 2 * 86400


class DetailClient:
    def __init__(self, gap: float = 1.0) -> None:
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept-Language": "zh-TW,zh;q=0.9"})
        self.gap = gap
        self.last = 0.0

    def _wait(self) -> None:
        dt = time.monotonic() - self.last
        if dt < self.gap:
            time.sleep(self.gap - dt)
        self.last = time.monotonic()

    def _mopsov(self, code: str, month: str) -> list[list[Any]] | None:
        y, m = roc(month)
        self._wait()
        r = self.s.post(
            "https://mopsov.twse.com.tw/mops/web/ajax_query6_1",
            data={"encodeURIComponent": "1", "step": "1", "firstin": "1", "off": "1", "queryName": "co_id",
                  "inpuType": "co_id", "TYPEK": "all", "isnew": "false", "co_id": code, "year": y, "month": m},
            headers={"Referer": "https://mopsov.twse.com.tw/mops/web/query6_1"},
            timeout=30,
        )
        r.raise_for_status()
        try:  # 回應標頭不一定帶字元集，直接依內容解碼
            text = r.content.decode("utf-8")
        except UnicodeDecodeError:
            text = r.content.decode("big5hkscs", errors="replace")
        if any(x in text for x in ("因為安全性考量", "Access Denied", "請稍後再試")):
            raise RuntimeError("官方站台要求暫停")
        rows = parse_mopsov_html(text)
        if rows:
            return rows
        if "查無" in text or "無應申報" in text or "不存在" in text:
            return []
        return None

    def _mops_api(self, code: str, month: str) -> list[list[Any]] | None:
        y, m = roc(month)
        self._wait()
        r = self.s.post(
            "https://mops.twse.com.tw/mops/api/query6_1",
            json={"companyId": code, "dataType": "2", "subsidiaryCompanyId": "", "year": y, "month": m},
            headers={"Origin": "https://mops.twse.com.tw", "Referer": "https://mops.twse.com.tw/"},
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        if data.get("code") == 200 and (data.get("result") or {}).get("data"):
            return compact_api_rows(data["result"]["data"])
        if data.get("code") in (406, 500, 501):
            return []
        return None

    def fetch(self, code: str, month: str) -> tuple[list[list[Any]] | None, str]:
        errors = []
        for name, fn in (("mopsov", self._mopsov), ("mops", self._mops_api)):
            try:
                rows = fn(code, month)
            except (requests.RequestException, ValueError, RuntimeError) as exc:
                errors.append(f"{name}: {exc}")
                continue
            if rows is not None:
                return rows, name
        raise RuntimeError("; ".join(errors) or "兩個官方來源都沒有回傳可解析的資料")


def save_detail(code: str, month: str, rows: list[list[Any]], source: str) -> None:
    _write(detail_path(code, month), {
        "fetchedAt": now().isoformat(timespec="seconds"), "source": source,
        "rows": rows, "empty": not rows,
    })


def latest_months(today: date | None = None, count: int = 24) -> list[str]:
    today = today or now().date()
    cur = f"{today.year:04d}-{today.month:02d}"
    return [month_back(cur, n) for n in range(count, 0, -1)]
