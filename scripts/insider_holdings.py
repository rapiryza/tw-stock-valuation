"""內部人持股月增減：口徑與計算（純邏輯，不連網）。

規則（每一條都對應網站上的顯示）：
1. 總額只用證交所官方 IRB110「董事、監察人、經理人及百分之十以上大股東股權異動彙總表」：
   內部人總額 = 董事監察人實際持有股數 + 經理人實際持有股數。
   ‧IRB110 的董監欄不含法人代表人分戶集保股數、不含保留運用決定權信託股數。
   ‧百分之十以上大股東欄不計入：大股東常同時是法人董事，加總會重複計算。
2. 「單月增減」只計真正的買賣與員工股：
   ‧集中市場買進 − 集中市場賣出（公開資訊觀測站內部人持股異動事後申報表）；
   ‧員工股／RSU：經理人身分以「其他原因」取得、且不是配股／分割、也不是內部人之間的移轉，
     計入並明確標示「員工股/RSU」。
3. 不計入（列為「已剔除」並說明）：
   ‧除權配股、股票分割（取得股數與持股成同一比例，並與 IRB110 發行股數變動一致）；
   ‧贈與、轉讓、信託等「其他原因」減少，以及內部人之間的受贈；
   ‧董監經理人就任、解任造成的名單異動；
   ‧轉讓「事前申報」只是預定，不是成交，完全不進入持股增減。
4. 同一人具多重身分（董事長兼總經理、財務兼會計主管）、同一法人董事派多位代表人，
   都只算一次：以姓名歸戶，有董監身分者歸董監欄，其餘歸經理人欄——與 IRB110 的歸戶方式相同，
   因此明細加總可以逐月和 IRB110 核對。
5. 「選任時持股」與「目前持股」的差距是跨好幾年的累計，不是單月增減，一律不使用。
"""
from __future__ import annotations

import re
from typing import Any

# compact row: [身分別, 姓名, 上月持股, 本月增加(集中), 本月增加(其它), 本月減少(集中), 本月減少(其它), 本月實際自有持股, 身分別備註]
ID, NAME, PREV, INC_MKT, INC_OTH, DEC_MKT, DEC_OTH, CURR, NOTE = range(9)

DIR_ROLES = {"董事長", "副董事長", "董事", "獨立董事", "監察人", "常務董事", "獨立常務董事", "常駐監察人"}
MGR_HINT = ("經理", "總裁", "執行長", "協理", "主管", "營運長", "技術長", "策略長", "副總")
CORP_HINT = ("公司", "基金", "管理會", "銀行", "投資", "有限", "會社", "政府", "部", "院",
             "INC", "LTD", "CORP", "LLC", "專戶", "合作社", "信託")

# 配股／分割判定：發行股數變動至少 0.3%，且持股人取得股數與持股成同一比例
MIN_CORP_RATIO = 0.003
LOT = 1000.0


def to_lots(shares: float) -> float:
    return round(shares / LOT, 3)


def num(value: Any) -> float:
    s = re.sub(r"[,\s]", "", str(value if value is not None else ""))
    if not s or s in {"-", "—"}:
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def compact_api_rows(data: list[list[Any]]) -> list[list[Any]]:
    """把 MOPS query6_1 的 24 欄原始資料壓成計算需要的 9 欄。"""
    out = []
    for r in data or []:
        if len(r) < 19:
            continue
        out.append([
            str(r[0] or "").strip(), str(r[1] or "").strip(),
            num(r[4]), num(r[8]), num(r[9]), num(r[13]), num(r[14]), num(r[18]),
            str(r[23] or "").strip() if len(r) > 23 else "",
        ])
    return out


def role_of(identity: str) -> str | None:
    """身分別 → 角色；只有「○○本人」列入（配偶、未成年子女、利用他人名義、法人代表人都不列）。"""
    if not identity.endswith("本人") or "大股東" in identity:
        return None
    if "之" in identity:  # 例如「董事之法人代表人」不會以本人結尾，保險起見再擋一次
        return None
    return identity[: -len("本人")]


def is_corp(name: str) -> bool:
    upper = name.upper()
    return any(k in upper for k in CORP_HINT)


def people_in_scope(rows: list[list[Any]]) -> dict[str, dict[str, Any]]:
    """依 IRB110 口徑歸戶：同名只算一次。"""
    people: dict[str, dict[str, Any]] = {}
    for r in rows:
        role = role_of(r[ID])
        name = r[NAME].strip()
        if role is None or not name:
            continue
        p = people.get(name)
        if p is None:
            p = people[name] = {
                "name": name, "roles": [], "prev": r[PREV], "curr": r[CURR],
                "inc_mkt": r[INC_MKT], "dec_mkt": r[DEC_MKT],
                "inc_oth": r[INC_OTH], "dec_oth": r[DEC_OTH], "note": r[NOTE],
            }
        if role not in p["roles"]:
            p["roles"].append(role)
        if r[NOTE] and r[NOTE] not in p["note"]:
            p["note"] = (p["note"] + "、" + r[NOTE]).strip("、")
    for p in people.values():
        p["is_dir"] = any(role in DIR_ROLES for role in p["roles"])
        p["is_mgr"] = any(role not in DIR_ROLES for role in p["roles"]) or any(h in p["note"] for h in MGR_HINT)
        p["is_corp"] = is_corp(p["name"])
        p["title"] = "兼".join(p["roles"][:2])
    return people


def corp_action_ratio(rows: list[list[Any]], issued_prev: float | None, issued_cur: float | None) -> float | None:
    """除權配股／股票分割的比例：IRB110 發行股數變動，並須由申報明細中同比例取得證實。"""
    if not issued_prev or not issued_cur:
        return None
    g = issued_cur / issued_prev - 1
    if g < MIN_CORP_RATIO:
        return None
    holders = [r for r in rows if r[PREV] > 0 and r[INC_OTH] > 0]
    if not holders:
        return None
    matching = [r for r in holders if abs(r[INC_OTH] / r[PREV] - g) <= max(0.02 * g, 0.0005)]
    if len(matching) >= 2 or (len(holders) == 1 and matching):
        return g
    return None


def compute_month(
    rows: list[list[Any]],
    irb_cur: dict[str, float],
    irb_prev: dict[str, float] | None,
) -> dict[str, Any]:
    """單一公司單月：核對 IRB110、拆出可計入與應剔除的變動。單位：張。"""
    people = people_in_scope(rows)
    dir_sum = sum(p["curr"] for p in people.values() if p["is_dir"])
    mgr_sum = sum(p["curr"] for p in people.values() if not p["is_dir"])
    verified = round(dir_sum) == round(irb_cur.get("dir", -1)) and round(mgr_sum) == round(irb_cur.get("mgr", -1))

    g = corp_action_ratio(rows, (irb_prev or {}).get("issued"), irb_cur.get("issued"))
    gift_out = {r[DEC_OTH] for r in rows if r[DEC_OTH] > 0}

    counted: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    market = rsu = corp = other_out = other_in = 0.0

    for p in people.values():
        base = {"name": p["name"], "title": p["title"] or "內部人", "is_exec": p["is_mgr"], "is_person": not p["is_corp"]}
        mkt = p["inc_mkt"] - p["dec_mkt"]
        if mkt:
            market += mkt
            counted.append({**base, "delta": to_lots(mkt), "source": "market",
                            "pct": round(abs(mkt) / p["prev"] * 100, 2) if p["prev"] > 0 else None})

        inc = p["inc_oth"]
        if inc > 0 and g and p["prev"] > 0 and inc >= p["prev"] * g * 0.98:
            part = min(inc, round(p["prev"] * g))
            if inc - part <= LOT:  # 零股進位差
                part = inc
            corp += part
            inc -= part
            excluded.append({**base, "delta": to_lots(part), "reason": "股票分割" if g >= 0.5 else "除權配股"})
        if inc > 0:
            if inc in gift_out:
                other_in += inc
                excluded.append({**base, "delta": to_lots(inc), "reason": "內部人間移轉（受贈等）"})
            elif p["is_mgr"] and not p["is_corp"]:
                rsu += inc
                counted.append({**base, "delta": to_lots(inc), "source": "rsu", "note": "員工股/RSU",
                                "pct": round(inc / p["prev"] * 100, 2) if p["prev"] > 0 else None})
            else:
                other_in += inc
                excluded.append({**base, "delta": to_lots(inc), "reason": "其他原因取得（受贈、繼承等）"})
        if p["dec_oth"] > 0:
            other_out += p["dec_oth"]
            excluded.append({**base, "delta": to_lots(-p["dec_oth"]), "reason": "贈與、轉讓、信託等其他原因減少"})

    total_cur = irb_cur["dir"] + irb_cur["mgr"]
    raw = None if irb_prev is None else total_cur - (irb_prev["dir"] + irb_prev["mgr"])
    in_scope_prev = sum(p["prev"] for p in people.values())
    personnel = None if irb_prev is None else in_scope_prev - (irb_prev["dir"] + irb_prev["mgr"])
    if personnel:
        excluded.append({"name": "董監經理人名單異動", "title": "", "delta": to_lots(personnel),
                         "reason": "就任、解任，不是買賣", "is_person": False, "is_exec": False})

    counted.sort(key=lambda x: -abs(x["delta"]))
    excluded.sort(key=lambda x: -abs(x["delta"]))
    top = sorted(people.values(), key=lambda p: -p["curr"])[:12]
    return {
        "verified": verified,
        "counted": to_lots(market + rsu),
        "market": to_lots(market),
        "rsu": to_lots(rsu),
        "raw": None if raw is None else to_lots(raw),
        "corp": to_lots(corp),
        "otherOut": to_lots(-other_out),
        "otherIn": to_lots(other_in),
        "personnel": None if personnel is None else to_lots(personnel),
        "corpRatio": None if g is None else round(g, 4),
        "breakdown": counted,
        "excluded": excluded[:20],
        "people": [{"name": p["name"], "title": p["title"], "lots": to_lots(p["curr"])} for p in top],
        "detailDir": to_lots(dir_sum),
        "detailMgr": to_lots(mgr_sum),
    }


_TD_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S | re.I)
_TR_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)


def _cell_values(cell: str) -> list[str]:
    cell = re.sub(r"身份別備註：.*", "", cell, flags=re.S)
    parts = re.split(r"<br\s*/?>", cell, flags=re.I)
    return [re.sub(r"<[^>]+>|&nbsp;|\s+", "", x) for x in parts if re.sub(r"<[^>]+>|&nbsp;|\s+", "", x) != ""]


def parse_mopsov_html(html: str) -> list[list[Any]]:
    """公開資訊觀測站（mopsov）ajax_query6_1 的 HTML → compact rows。

    每列 7 格：身分別、姓名、持股種類、[選任,上月,上月信託,上月設質,上月私募]、
    [增加:集中,其它,私募,信託,設質]、[減少:集中,其它,私募,信託,解質]、[本月自有,分戶,信託,設質,私募 + 身份別備註]。
    """
    rows: list[list[Any]] = []
    for tr in _TR_RE.findall(html):
        tds = _TD_RE.findall(tr)
        if len(tds) != 7:
            continue
        identity = re.sub(r"<[^>]+>|&nbsp;|\s+", "", tds[0])
        if not identity or identity == "身份別":
            continue
        name = re.sub(r"<[^>]+>|&nbsp;", "", tds[1]).strip()
        before, inc, dec, after = (_cell_values(tds[i]) for i in (3, 4, 5, 6))
        if len(before) < 2 or len(inc) < 2 or len(dec) < 2 or len(after) < 1:
            continue
        note_m = re.search(r"身份別備註：(.*)", re.sub(r"<[^>]+>", "", tds[6]), re.S)
        note = re.sub(r"\s+", "", note_m.group(1)) if note_m else ""
        rows.append([identity, name, num(before[1]), num(inc[0]), num(inc[1]), num(dec[0]), num(dec[1]), num(after[0]), note])
    return rows


def parse_irb110_html(html: str) -> dict[str, dict[str, float]]:
    """IRB110 → {公司代號: {issued, dirInc, dirDec, dir, mgr, big}}（單位：股）。"""
    out: dict[str, dict[str, float]] = {}
    for tr in re.split(r"</tr>", html, flags=re.I):
        tds = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S | re.I)
        if len(tds) < 8:
            continue
        clean = [re.sub(r"<[^>]+>|&nbsp;|\s+", "", td) for td in tds]
        m = re.match(r"^(\d{4})(?!\d)", clean[0])
        if not m:
            continue
        vals = [num(x) for x in clean[1:8]]
        out[m.group(1)] = {
            "issued": vals[0], "dirInc": vals[1], "dirDec": vals[2], "dir": vals[3],
            "mgr": vals[5], "big": vals[6],
        }
    return out
