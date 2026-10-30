"""匯入隊友整理的個股調查資料，拆成每檔一個檔案供個股面板按需載入。

來源（不在 repo 內，由隊友提供）：
  captain.json  船長 · 法說助理：{generatedAt, source, count, fields, stocks: {代號: {...}}}
  ryza.json     Ryza 近一年新登錄興櫃調查：{source_agent, generated_at, ..., companies: [{...}]}

輸出 docs/data/research/（排程不會動到這個目錄，只有本腳本會改寫）：
  meta.json              兩份資料的產生時間、來源、欄位說明、備註，以及有資料的代號清單
  captain/<代號>.json     船長單檔，內容原樣保留
  ryza/<代號>.json        Ryza 單檔，內容原樣保留

文字一律原樣保留（含「（推論）」「（自行計算）」與 p14 之類的頁碼）。
重跑會先清掉 captain/、ryza/ 底下舊的 <代號>.json，避免殘留已下架的代號。

用法：python3 scripts/import_research.py [--captain PATH] [--ryza PATH]
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "docs" / "data" / "research"
SRC = Path.home() / "Downloads" / "stock-data"
CODE_RE = re.compile(r"[0-9A-Z]{4,6}")


def write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def split(name: str, records: dict[str, dict]) -> list[str]:
    folder = OUT / name
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob("*.json"):
        old.unlink()
    for code, rec in records.items():
        if not CODE_RE.fullmatch(code):
            raise SystemExit(f"{name}: 代號格式不符 {code!r}")
        write(folder / f"{code}.json", rec)
    return sorted(records)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--captain", type=Path, default=SRC / "captain.json")
    ap.add_argument("--ryza", type=Path, default=SRC / "ryza.json")
    args = ap.parse_args()

    cap = json.loads(args.captain.read_text(encoding="utf-8"))
    ryz = json.loads(args.ryza.read_text(encoding="utf-8"))

    cap_stocks = cap["stocks"]
    for code, rec in cap_stocks.items():
        if rec.get("code") != code:
            raise SystemExit(f"captain: 鍵 {code} 與 code {rec.get('code')} 不一致")
    ryz_stocks = {}
    for rec in ryz["companies"]:
        if rec["code"] in ryz_stocks:
            raise SystemExit(f"ryza: 代號重複 {rec['code']}")
        ryz_stocks[rec["code"]] = rec

    cap_codes = split("captain", cap_stocks)
    ryz_codes = split("ryza", ryz_stocks)

    meta = {
        "captain": {k: v for k, v in cap.items() if k != "stocks"},
        "ryza": {k: v for k, v in ryz.items() if k != "companies"},
    }
    meta["captain"]["codes"] = cap_codes
    meta["captain"]["nodata"] = sorted(c for c, r in cap_stocks.items() if r.get("nodata"))
    meta["ryza"]["codes"] = ryz_codes
    write(OUT / "meta.json", meta)
    print(f"captain {len(cap_codes)} 檔（無資料 {len(meta['captain']['nodata'])}）、ryza {len(ryz_codes)} 檔 → {OUT}")


if __name__ == "__main__":
    main()
