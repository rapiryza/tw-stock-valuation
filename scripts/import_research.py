"""匯入隊友整理的個股調查資料，拆成每檔一個檔案供個股面板按需載入。

來源（不在 repo 內，由隊友提供）：
  captain.json  船長 · 法說助理：{generatedAt, source, count, fields, stocks: {代號: {...}}}
  ryza.json     Ryza 近一年新登錄興櫃調查：{source_agent, generated_at, ..., companies: [{...}]}

輸出 docs/data/research/（排程不會動到這個目錄，只有本腳本會改寫）：
  meta.json              兩份資料的產生時間、來源、欄位說明、備註，以及有資料的代號清單
  captain/<代號>.json     船長單檔
  ryza/<代號>.json        Ryza 單檔

文字除了去掉第三方法說彙整站的字樣與連結（見 strip_bg）之外原樣保留（含「（推論）」「（自行計算）」與 p14 之類的頁碼）；
sources 裡指向該站的條目整筆移除。
重跑會先清掉 captain/、ryza/ 底下舊的 <代號>.json，避免殘留已下架的代號。

用法：python3 scripts/import_research.py [--captain PATH] [--ryza PATH]
      python3 scripts/import_research.py --reclean   # 不讀來源，只對 repo 內現有檔案重跑清理
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "docs" / "data" / "research"
SRC = Path.home() / "Downloads" / "stock-data"
CODE_RE = re.compile(r"[0-9A-Z]{4,6}")

# 去掉第三方法說彙整站（下稱彙整站，站名以 BG 比對，不分大小寫）的字樣與連結，依序：
#   1. 彙整站網址整段刪除；「站名/TDnet」只留 TDnet
#   2. deck：以站名開頭的「；」分段（該站有沒有場次）、以「（站名」開頭的括號整段刪除；
#      source：以站名開頭的「；、」分段（該站財經新聞、法說彙整）刪除
#   3. 「站名 法說彙整／法說逐字稿／逐字稿／未具名／重訊」只拿掉站名
#   4. 只剩站名、或「站名 無…」「站名 連結」的子句（以「、；，且」分句）整句刪除
#   5. 其餘敘述裡的站名（如「站名 將 X 寫成 Y」）改稱「法說彙整」
BG = "b[i]ggo"
BG_URL_RE = re.compile(rf"\s*https?://(?:[\w-]+\.)*{BG}\.com(?:\.tw)?[A-Za-z0-9._~:/?#@!$&'*+,;=%-]*", re.I)
BG_SLASH_RE = re.compile(rf"{BG}\s*/\s*", re.I)
BG_DECK_RE = re.compile(rf"(?:^|；)\s*(?:依\s*)?{BG}(?:[^；（]|（[^（）]*）)*|（\s*{BG}[^（）]*）", re.I)
BG_SOURCE_RE = re.compile(rf"(?:^|[；、])\s*{BG}[^；、]*", re.I)
BG_WORD_RE = re.compile(rf"(\s*){BG}\s*(?=法說|逐字稿|未具名|重訊)", re.I)
BG_CLAUSE_RE = re.compile(rf"(?:^|[、；，且])\s*{BG}\s*(?:(?:無|連結)[^、；，。（）()]*|(?=$|[、；，。）)]))", re.I)
BG_REST_RE = re.compile(rf"(\s*){BG}(\s*)", re.I)
BG_ANY_RE = re.compile(BG, re.I)


def _keep_space(s: str, m: re.Match, group: int, text: str) -> str:
    """站名前後的空白只在鄰接英數字時保留，鄰接中文就拿掉。"""
    if not m.group(group):
        return text
    near = s[m.start() - 1] if group == 1 and m.start() > 0 else s[m.end()] if group == 2 and m.end() < len(s) else ""
    return (" " + text if group == 1 else text + " ") if near.isascii() and near.isalnum() else text


def strip_bg(s: str, key: str = "") -> str:
    if not BG_ANY_RE.search(s):
        return s
    s = BG_SLASH_RE.sub("", BG_URL_RE.sub("", s))
    if key == "deck":
        s = BG_DECK_RE.sub("", s)
    elif key == "source":
        s = BG_SOURCE_RE.sub("", s)
    s = BG_WORD_RE.sub(lambda m: _keep_space(s, m, 1, ""), s)
    s = BG_CLAUSE_RE.sub("", s)
    s = BG_REST_RE.sub(lambda m: _keep_space(s, m, 2, _keep_space(s, m, 1, "法說彙整")), s)
    s = re.sub(r"；{2,}", "；", s).strip().strip("；、，").strip()
    if BG_ANY_RE.search(s):
        raise SystemExit(f"彙整站字樣未清乾淨：{s!r}")
    return s


def clean(obj, key: str = ""):
    """遞迴清掉彙整站字樣；sources 裡指向彙整站的條目整筆移除。"""
    if isinstance(obj, str):
        return strip_bg(obj, key)
    if isinstance(obj, list):
        if key == "sources":
            obj = [x for x in obj if not (isinstance(x, dict) and BG_ANY_RE.search(f"{x.get('type', '')} {x.get('url', '')}"))]
        return [clean(x, key) for x in obj]
    if isinstance(obj, dict):
        return {k: clean(v, k) for k, v in obj.items()}
    return obj


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
    ap.add_argument("--reclean", action="store_true", help="只對 docs/data/research 現有檔案重跑清理")
    args = ap.parse_args()

    if args.reclean:
        files = sorted(OUT.rglob("*.json"))
        for f in files:
            write(f, clean(json.loads(f.read_text(encoding="utf-8"))))
        print(f"重新清理 {len(files)} 個檔案 → {OUT}")
        return

    cap = clean(json.loads(args.captain.read_text(encoding="utf-8")))
    ryz = clean(json.loads(args.ryza.read_text(encoding="utf-8")))

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
