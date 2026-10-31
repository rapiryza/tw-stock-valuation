/* 三率篩選 — 讀 data/screener.json（build_screener.py 產生），全部在瀏覽器端篩選 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const NAMES = ["毛利率", "營業利益率", "淨利率"];
  const SHORT = ["毛利率", "營益率", "淨利率"];
  const COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];
  const METRIC = { g: [0], o: [1], n: [2], all: [0, 1, 2] };
  const NEAR_ZERO = 1; // 比較季 |比率| < 1 個百分點視為近零
  const SPARK_Q = 8;
  const SLIDER_MAX = 1000;
  const PAGE = 200;

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const NA = '<span class="na">—</span>';
  const fmt = (v, d = 2) => (v == null ? null : Number(v).toFixed(d));
  const signed = (v, d = 1, unit = "%") => {
    if (v == null) return NA;
    const cls = v > 0 ? "pos" : v < 0 ? "neg" : "";
    return `<span class="${cls}">${v > 0 ? "+" : ""}${v.toFixed(d)}${unit}</span>`;
  };
  const capText = (v) => (v == null ? null : v >= 10000 ? (v / 10000).toFixed(2) + " 兆" : v.toFixed(0) + " 億");

  // ---------------------------------------------------------------- 主題（與 app.js 相同的 localStorage 鍵）
  const SUN = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="3.6" stroke="currentColor" stroke-width="1.7"/><path d="M10 1.6v2M10 16.4v2M18.4 10h-2M3.6 10h-2M15.9 4.1l-1.4 1.4M5.5 14.5l-1.4 1.4M15.9 15.9l-1.4-1.4M5.5 5.5 4.1 4.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  const MOON = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M17 12.2A7.4 7.4 0 0 1 7.8 3a7.4 7.4 0 1 0 9.2 9.2Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  const themeBtn = $("themeToggle");
  const isDarkNow = () => {
    const cur = document.documentElement.getAttribute("data-theme");
    return cur === "dark" || (!cur && window.matchMedia("(prefers-color-scheme: dark)").matches);
  };
  const paintToggle = () => {
    const dark = isDarkNow();
    themeBtn.innerHTML = dark ? SUN : MOON;
    themeBtn.setAttribute("aria-label", dark ? "切換為淺色" : "切換為深色");
  };
  try {
    const saved = localStorage.getItem("theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  } catch (_) {}
  paintToggle();
  themeBtn.addEventListener("click", () => {
    const next = isDarkNow() ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    paintToggle();
    try { localStorage.setItem("theme", next); } catch (_) {}
  });

  // ---------------------------------------------------------------- 計算
  /** 相對變化：(cur − base) / |base| × 100；base ≤ 0 或近零時不算，回傳 flag 與百分點差 */
  function relChange(cur, base) {
    if (cur == null || base == null) return { v: null };
    if (base <= 0 || Math.abs(base) < NEAR_ZERO) return { v: null, flag: true, pp: cur - base };
    return { v: ((cur - base) / Math.abs(base)) * 100 };
  }

  function streak(s) {
    let n = 0;
    for (let i = s.length - 1; i > 0; i--) {
      if (s[i] == null || s[i - 1] == null || !(s[i] > s[i - 1])) break;
      n++;
    }
    return n;
  }

  function prepare(raw) {
    const [c, name, m, ind, cap, q, rev, g, o, n] = raw;
    const ser = [g, o, n];
    const L = g.length - 1;
    return {
      c, name, m, ind, cap, q, rev, ser,
      cur: ser.map((s) => s[L]),
      prev: ser.map((s) => s[L - 1]),
      qoq: ser.map((s) => relChange(s[L], s[L - 1])),
      yoy: ser.map((s) => relChange(s[L], s[L - 4])),
      grow: ser.map(streak),
    };
  }

  // ---------------------------------------------------------------- 狀態與網址
  const FIELDS = ["qmin", "qmax", "ymin", "ymax", "grow", "rev", "cmin", "cmax", "fg", "fo", "fn"];
  const CHECKS = { tOp: "top", tNet: "tnet", same: "same" };
  const FLOORS = { fg: 0, fo: 1, fn: 2 };
  const state = { data: null, rows: [], view: [], metric: "g", sort: { k: "cap", dir: -1 }, shown: PAGE, maxCap: 1 };

  const num = (id) => {
    const v = $(id).value.trim();
    if (v === "") return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };

  function readUrl() {
    const p = new URLSearchParams(location.search);
    if (METRIC[p.get("m")]) state.metric = p.get("m");
    for (const f of FIELDS) if (p.has(f)) $(f).value = p.get(f);
    for (const [id, key] of Object.entries(CHECKS)) $(id).checked = p.get(key) === "1";
    for (const f of Object.keys(FLOORS)) $(f + "On").checked = p.has(f);
    const s = p.get("sort");
    if (s) state.sort = { k: s.replace(/^-/, ""), dir: s.startsWith("-") ? -1 : 1 };
  }

  function writeUrl() {
    const p = new URLSearchParams();
    if (state.metric !== "g") p.set("m", state.metric);
    for (const f of FIELDS) {
      const v = $(f).value.trim();
      if (f in FLOORS) { if ($(f + "On").checked) p.set(f, v); }
      else if (v !== "") p.set(f, v);
    }
    for (const [id, key] of Object.entries(CHECKS)) if ($(id).checked) p.set(key, "1");
    if (state.sort.k !== "cap" || state.sort.dir !== -1) p.set("sort", (state.sort.dir < 0 ? "-" : "") + state.sort.k);
    const qs = p.toString();
    // 保留開著的個股面板（#stock=代號）與其歷史狀態
    history.replaceState(history.state, "", (qs ? `?${qs}` : location.pathname) + location.hash);
  }

  // ---------------------------------------------------------------- 市值雙滑桿（對數刻度）
  const posToCap = (pos) => (pos <= 0 ? 0 : pos >= SLIDER_MAX ? state.maxCap : Math.pow(state.maxCap, pos / SLIDER_MAX));
  const capToPos = (v) => (v == null || v <= 1 ? 0 : Math.min(SLIDER_MAX, Math.round((Math.log(v) / Math.log(state.maxCap)) * SLIDER_MAX)));
  const roundCap = (v) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);

  function paintSlider() {
    const lo = Number($("capLo").value), hi = Number($("capHi").value);
    $("capFill").style.left = (lo / SLIDER_MAX) * 100 + "%";
    $("capFill").style.right = (100 - (hi / SLIDER_MAX) * 100) + "%";
    $("capLo").setAttribute("aria-valuetext", lo ? `${capText(posToCap(lo))}` : "不限");
    $("capHi").setAttribute("aria-valuetext", hi < SLIDER_MAX ? `${capText(posToCap(hi))}` : "不限");
  }
  function sliderFromInputs() {
    const lo = num("cmin"), hi = num("cmax");
    $("capLo").value = capToPos(lo);
    $("capHi").value = hi == null ? SLIDER_MAX : capToPos(hi);
    paintSlider();
  }
  function inputsFromSlider(which) {
    let lo = Number($("capLo").value), hi = Number($("capHi").value);
    if (lo > hi) {
      if (which === "lo") $("capHi").value = hi = lo;
      else $("capLo").value = lo = hi;
    }
    $("cmin").value = lo <= 0 ? "" : roundCap(posToCap(lo));
    $("cmax").value = hi >= SLIDER_MAX ? "" : roundCap(posToCap(hi));
    paintSlider();
  }

  // ---------------------------------------------------------------- 篩選
  const inRange = (v, lo, hi) => (lo == null || v >= lo) && (hi == null || v <= hi);

  function applyFilters() {
    const ks = METRIC[state.metric];
    const qmin = num("qmin"), qmax = num("qmax"), ymin = num("ymin"), ymax = num("ymax");
    const grow = num("grow"), rev = num("rev"), cmin = num("cmin"), cmax = num("cmax");
    const floors = Object.entries(FLOORS).filter(([f]) => $(f + "On").checked && num(f) != null).map(([f, k]) => [k, num(f)]);
    const tOp = $("tOp").checked, tNet = $("tNet").checked, same = $("same").checked;
    const newest = state.data.asOf.quarter;
    const useQ = qmin != null || qmax != null, useY = ymin != null || ymax != null;

    state.view = state.rows.filter((r) => {
      if (same && r.q !== newest) return false;
      for (const k of ks) {
        if (useQ && (r.qoq[k].v == null || !inRange(r.qoq[k].v, qmin, qmax))) return false;
        if (useY && (r.yoy[k].v == null || !inRange(r.yoy[k].v, ymin, ymax))) return false;
        if (grow != null && grow > 0 && r.grow[k] < grow) return false;
      }
      if (tOp && !(r.prev[1] != null && r.prev[1] < 0 && r.cur[1] > 0)) return false;
      if (tNet && !(r.prev[2] != null && r.prev[2] < 0 && r.cur[2] > 0)) return false;
      if (rev != null && (r.rev == null || r.rev < rev)) return false;
      if ((cmin != null || cmax != null) && (r.cap == null || !inRange(r.cap, cmin, cmax))) return false;
      for (const [k, min] of floors) if (r.cur[k] == null || r.cur[k] < min) return false;
      return true;
    });
    sortView();
    state.shown = PAGE;
    writeUrl();
    render();
  }

  // ---------------------------------------------------------------- 欄位與排序
  function columns() {
    const cols = [
      { k: "c", t: "代號", v: (r) => r.c },
      { k: "name", t: "名稱", v: (r) => r.name },
      { k: "cap", t: "市值", v: (r) => r.cap },
      { k: "rev", t: "單季營收（億）", v: (r) => r.rev },
      ...[0, 1, 2].map((k) => ({ k: "r" + k, t: SHORT[k], v: (r) => r.cur[k] })),
    ];
    for (const k of METRIC[state.metric]) {
      const pre = state.metric === "all" ? SHORT[k] + " " : "";
      cols.push({ k: "q" + k, t: pre + "對比上季", v: (r) => r.qoq[k].v, chg: "qoq", m: k });
      cols.push({ k: "y" + k, t: pre + "對比去年同季", v: (r) => r.yoy[k].v, chg: "yoy", m: k });
    }
    cols.push({ k: "spark", t: `近 ${SPARK_Q} 季走勢`, nosort: true });
    return cols;
  }

  function sortView() {
    const col = columns().find((c) => c.k === state.sort.k) || columns().find((c) => c.k === "cap");
    const dir = state.sort.dir;
    state.view.sort((a, b) => {
      const x = col.v(a), y = col.v(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1; // 缺值永遠排最後
      if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y, "zh-Hant") : x - y) * dir;
    });
  }

  // ---------------------------------------------------------------- 走勢圖
  function sparkline(r) {
    const W = 92, H = 28, P = 2;
    const sers = r.ser.map((s) => s.slice(-SPARK_Q));
    const vals = sers.flat().filter((v) => v != null);
    if (!vals.length) return NA;
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    const x = (i) => P + (i * (W - 2 * P)) / (SPARK_Q - 1);
    const y = (v) => P + (1 - (v - lo) / (hi - lo)) * (H - 2 * P);
    const qs = quarterLabels(r.q, SPARK_Q);
    const tip = qs.map((q, i) => `${q}　${sers.map((s, k) => `${SHORT[k]} ${s[i] == null ? "—" : s[i].toFixed(1) + "%"}`).join("　")}`).join("\n");
    const zero = lo < 0 && hi > 0 ? `<line x1="${P}" x2="${W - P}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="spark-zero"/>` : "";
    const paths = sers.map((s, k) => {
      let d = "", pen = false;
      s.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
        pen = true;
      });
      const last = s[s.length - 1];
      const dot = last == null ? "" : `<circle cx="${x(s.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="1.8" fill="${COLORS[k]}"/>`;
      return `<path d="${d}" stroke="${COLORS[k]}"/>${dot}`;
    }).join("");
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(r.name)} 近 ${SPARK_Q} 季三率走勢"><title>${esc(tip)}</title>${zero}${paths}</svg>`;
  }

  function quarterLabels(last, n) {
    const m = /^(\d{4})Q([1-4])$/.exec(last);
    if (!m) return Array(n).fill("");
    let idx = Number(m[1]) * 4 + Number(m[2]) - 1 - (n - 1);
    return Array.from({ length: n }, () => { const i = idx++; return `${Math.floor(i / 4)}Q${(i % 4) + 1}`; });
  }

  // ---------------------------------------------------------------- 表格
  function changeCell(ch) {
    if (ch.flag) {
      return `<span class="scr-flag" title="比較季比率 ≤ 0 或絕對值 < ${NEAR_ZERO} 個百分點，不計算相對變化">基期為負/近零</span>`
        + `<small class="profit-period">${ch.pp >= 0 ? "+" : ""}${ch.pp.toFixed(2)} 百分點</small>`;
    }
    return signed(ch.v);
  }

  function cellHtml(col, r) {
    const newest = state.data.asOf.quarter;
    switch (col.k) {
      case "c": return `<td class="code"><a href="#stock=${encodeURIComponent(r.c)}">${esc(r.c)}</a></td>`;
      case "name": {
        const lag = r.q !== newest
          ? ` <span class="scr-lag${r.q < newest ? "" : " ahead"}" title="${r.q < newest ? "財報落後：最新只有" : "已公布較新一季："}${esc(r.q)}">${esc(r.q)}</span>` : "";
        return `<td class="name-cell">${esc(r.name)}${lag}</td>`;
      }
      case "cap": return `<td>${capText(r.cap) ?? NA}</td>`;
      case "rev": return `<td>${fmt(r.rev, r.rev != null && r.rev >= 100 ? 0 : 2) ?? NA}</td>`;
      case "spark": return `<td class="spark-cell">${sparkline(r)}</td>`;
    }
    if (col.chg) return `<td>${changeCell(r[col.chg][col.m])}</td>`;
    const k = Number(col.k.slice(1));
    const v = r.cur[k];
    const hl = METRIC[state.metric].includes(k) && state.metric !== "all" ? " scr-hl" : "";
    return `<td class="${hl.trim()}">${v == null ? NA : `<span class="${v < 0 ? "neg" : ""}">${v.toFixed(2)}%</span>`}</td>`;
  }

  function renderHead() {
    $("scrHead").innerHTML = columns().map((c) => {
      if (c.nosort) return `<th scope="col" data-k="${c.k}" class="nosort">${c.t}</th>`;
      const on = state.sort.k === c.k;
      const aria = on ? ` aria-sort="${state.sort.dir > 0 ? "ascending" : "descending"}"` : "";
      return `<th scope="col" data-k="${c.k}"${aria} tabindex="0">${c.t}${on ? `<span class="sort-ind">${state.sort.dir > 0 ? "↑" : "↓"}</span>` : ""}</th>`;
    }).join("");
  }

  function render() {
    const cols = columns();
    renderHead();
    const rows = state.view.slice(0, state.shown);
    $("scrBody").innerHTML = rows.length
      ? rows.map((r) => `<tr data-c="${esc(r.c)}" tabindex="0">${cols.map((c) => cellHtml(c, r)).join("")}</tr>`).join("")
      : `<tr class="empty"><td colspan="${cols.length}">沒有符合條件的公司</td></tr>`;
    $("count").textContent = `符合 ${state.view.length} 檔／共 ${state.rows.length} 檔`;
    $("more").hidden = state.view.length <= state.shown;
  }

  function sortBy(k) {
    const textual = k === "c" || k === "name";
    state.sort = state.sort.k === k ? { k, dir: -state.sort.dir } : { k, dir: textual ? 1 : -1 };
    sortView();
    writeUrl();
    render();
  }

  // ---------------------------------------------------------------- 個股面板（stock-panel.js，與首頁共用）
  // 在本頁直接開面板，篩選結果留在底下。開啟時 pushState 加上 #stock=代號（保留篩選查詢字串），
  // 上一頁只會關閉面板；關閉鈕、Esc、點背景則回到開面板前的那一筆歷史。
  StockPanel.setAddons([
    "assets/op-ui.js?v=20261007-select-redraw-fix",
    "assets/insider.js?v=20261018-finhist",
    "assets/op-layout-fix.js?v=20261008-insider-visible",
    "assets/receipts-hide.js?v=20261031-panel",
  ]);
  const hashStock = () => (/^#stock=([0-9A-Za-z]+)$/.exec(location.hash) || [])[1] || null;
  const urlFor = (code) => location.pathname + location.search + (code ? `#stock=${encodeURIComponent(code)}` : "");
  let panel = null, opening = false;

  /** 移除網址的 #stock：本頁 push 的就回上一頁，直接開連結進來的則改寫網址 */
  function leaveStock() {
    if (!hashStock()) return;
    if (history.state && history.state.scrStock) history.back();
    else history.replaceState(null, "", urlFor(null));
  }

  async function showStock(code, push) {
    if (panel || opening) return;
    opening = true;
    const opener = document.activeElement;
    if (push) history.pushState({ scrStock: code }, "", urlFor(code));
    let h = null;
    try {
      h = await StockPanel.open(code, {
        recordsHref: "./#records",
        onRecordBadge: () => {}, // 照連結前往首頁榜單；回上一頁會回到這個面板
        onClose: () => {
          const byUser = panel !== null; // popstate 關閉時已先清掉 panel
          panel = null;
          if (byUser) leaveStock();
          if (opener && opener.isConnected && opener.focus) opener.focus();
        },
      });
    } finally {
      opening = false;
    }
    if (!h) { leaveStock(); return; } // 代號不在個股資料內
    if (hashStock() !== code) { h.close(); return; } // 載入期間已按上一頁
    panel = h;
  }

  window.addEventListener("popstate", () => {
    const code = hashStock();
    if (panel && panel.code !== code) { const h = panel; panel = null; h.close(); }
    if (code && !panel) showStock(code, false);
  });

  const openRow = (code) => showStock(code, true);

  // ---------------------------------------------------------------- 啟動
  function syncMetricSeg() {
    document.querySelectorAll("#metricSeg button").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.metric === state.metric)));
  }

  (async function init() {
    let data = null;
    try {
      const res = await fetch("data/screener.json", { cache: "no-cache" });
      if (res.ok) data = await res.json();
    } catch (_) {}
    if (!data || !Array.isArray(data.stocks)) {
      $("scrNote").textContent = "尚無三率彙整資料，請先執行 scripts/build_screener.py。";
      $("asof").textContent = "尚無資料";
      return;
    }
    state.data = data;
    state.rows = data.stocks.map(prepare);
    state.maxCap = Math.ceil(Math.max(1, ...state.rows.map((r) => r.cap || 0)));
    const top = state.rows.reduce((a, r) => ((r.cap || 0) > (a.cap || 0) ? r : a), state.rows[0]);
    const newest = data.asOf.quarter;
    const other = state.rows.filter((r) => r.q !== newest).length;

    $("asof").textContent = `財報 ${newest}・市值 ${data.asOf.cap || "—"}`;
    $("scrNote").innerHTML =
      `財報季別：<strong>${esc(newest)}</strong>（全市場多數公司已公布的最新一季）；${other} 家公司的最新一季與此不同，名稱旁以季別標示（灰底為落後、框線為已公布較新一季）。`
      + `市值為 ${esc(data.asOf.cap || "—")} 收盤，滑桿上限為最大市值 ${esc(top.name)} ${capText(top.cap)}。`;
    $("cmax").placeholder = `最大 ${roundCap(state.maxCap)}`;

    readUrl();
    syncMetricSeg();
    sliderFromInputs();

    document.querySelectorAll("#metricSeg button").forEach((b) => b.addEventListener("click", () => {
      state.metric = b.dataset.metric;
      if (!columns().some((c) => c.k === state.sort.k)) state.sort = { k: "cap", dir: -1 };
      syncMetricSeg();
      applyFilters();
    }));
    $("scrForm").addEventListener("input", (e) => {
      const id = e.target.id;
      if (id === "capLo" || id === "capHi") inputsFromSlider(id === "capLo" ? "lo" : "hi");
      else if (id === "cmin" || id === "cmax") sliderFromInputs();
      // 輸入下限數字時自動勾選對應的 checkbox
      if (id in FLOORS && e.target.value.trim() !== "") $(id + "On").checked = true;
      applyFilters();
    });
    $("reset").addEventListener("click", () => {
      for (const f of FIELDS) $(f).value = "";
      for (const id of [...Object.keys(CHECKS), ...Object.keys(FLOORS).map((f) => f + "On")]) $(id).checked = false;
      state.metric = "g";
      state.sort = { k: "cap", dir: -1 };
      syncMetricSeg();
      sliderFromInputs();
      applyFilters();
    });
    $("scrHead").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-k]:not(.nosort)");
      if (th) sortBy(th.dataset.k);
    });
    $("scrHead").addEventListener("keydown", (e) => {
      const th = e.target.closest("th[data-k]:not(.nosort)");
      if (th && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); sortBy(th.dataset.k); }
    });
    $("scrBody").addEventListener("click", (e) => {
      const a = e.target.closest("a");
      // 代號連結：一般點擊在本頁開面板；Ctrl/⌘/中鍵照連結開新分頁（新分頁同樣直接開面板）
      if (a && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)) return;
      const tr = e.target.closest("tr[data-c]");
      if (!tr) return;
      if (a) e.preventDefault();
      openRow(tr.dataset.c);
    });
    $("scrBody").addEventListener("keydown", (e) => {
      const tr = e.target.closest("tr[data-c]");
      if (tr && e.key === "Enter" && !e.target.closest("a")) openRow(tr.dataset.c);
    });
    $("more").addEventListener("click", () => { state.shown += 300; render(); });

    applyFilters();
    // 直接開 screener.html?…#stock=代號 時打開該股面板
    if (hashStock()) showStock(hashStock(), false);
  })();
})();
