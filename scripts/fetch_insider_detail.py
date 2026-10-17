"""漸進補抓內部人持股異動事後申報表（公開資訊觀測站 query6_1），一家公司一個月一份。

只抓 IRB110 已公布的最近 6 個月；最新月份優先，同月份內總額有變動、市值大的公司優先。
已抓到的不再重抓；官方「查無資料」的兩天後再試；網路失敗留待下次。
"""
from __future__ import annotations

import argparse

from insider_sources import DetailClient, detail_needs_fetch, latest_months, load_irb110, save_detail
from util import DATA_DIR, log, read_json

DETAIL_MONTHS = 6


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-requests", type=int, default=700)
    ap.add_argument("--codes", default="")
    args = ap.parse_args()

    irb = load_irb110(latest_months(count=DETAIL_MONTHS + 2))
    months = sorted(irb)[-DETAIL_MONTHS:]
    if not months:
        log("IRB110 尚無資料")
        return 1
    cap = {r["c"]: r.get("cap") or 0 for r in read_json(DATA_DIR / "latest.json", []) or []}
    only = {c.strip() for c in args.codes.split(",") if c.strip()}

    jobs = []
    for rank, month in enumerate(reversed(months)):
        prev = irb.get(sorted(irb)[sorted(irb).index(month) - 1]) if sorted(irb).index(month) > 0 else {}
        for code, rec in irb[month].items():
            if only and code not in only:
                continue
            if not detail_needs_fetch(code, month):
                continue
            p = (prev or {}).get(code)
            changed = p is None or rec["dirInc"] or rec["dirDec"] or (rec["dir"] + rec["mgr"]) != (p["dir"] + p["mgr"])
            jobs.append((rank, 0 if changed else 1, -cap.get(code, 0), code, month))
    jobs.sort()
    total = len(jobs)
    jobs = jobs[: args.max_requests] if args.max_requests > 0 else jobs
    log(f"內部人申報明細：待抓 {total} 份，本次 {len(jobs)} 份（月份 {months[0]}～{months[-1]}）")

    client = DetailClient()
    ok = fail = 0
    for _, _, _, code, month in jobs:
        try:
            rows, source = client.fetch(code, month)
            save_detail(code, month, rows, source)
            ok += 1
        except RuntimeError as exc:
            fail += 1
            log(f"  [待重試] {code} {month}: {exc}")
            if fail >= 25 and ok == 0:
                log("連續失敗，可能被官方站台限制，提前結束")
                break
    log(f"內部人申報明細完成：成功 {ok}、失敗 {fail}、尚餘 {max(0, total - ok)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
