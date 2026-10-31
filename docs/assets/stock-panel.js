/* 個股詳細面板 — index.html（app.js）與 screener.html 共用
 * window.StockPanel.open(code, opts) 打開面板；所需資料第一次開啟時才載入，
 * index.html 由 app.js 以 setData() 直接交給已載入的資料，不重複下載。 */
(() => {
  "use strict";

  const LABEL = { listed: "上市", otc: "上櫃", esb: "興櫃" };
  const SERIES = { listed: "var(--series-1)", otc: "var(--series-2)", esb: "var(--series-3)" };

  // 斷點與 style.css 的 860px 一致
  const MOBILE = window.matchMedia("(max-width: 860px)");

  // ---------------------------------------------------------------- 工具
  const fmt = (v, d = 2) =>
    v === null || v === undefined || Number.isNaN(v) ? null : Number(v).toFixed(d);

  const human = (n) => {
    if (n === null || n === undefined) return null;
    const a = Math.abs(n);
    if (a >= 1e12) return (n / 1e12).toFixed(2) + " 兆";
    if (a >= 1e8) return (n / 1e8).toFixed(1) + " 億";
    if (a >= 1e4) return (n / 1e4).toFixed(0) + " 萬";
    return String(Math.round(n));
  };

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const cell = (v, d = 2, signed = false) => {
    const s = fmt(v, d);
    if (s === null) return '<span class="na">—</span>';
    if (!signed) return s;
    const cls = v > 0 ? "pos" : v < 0 ? "neg" : "";
    return `<span class="${cls}">${v > 0 ? "+" : ""}${s}</span>`;
  };

  async function getJSON(path, fallback) {
    try {
      const r = await fetch(path, { cache: "no-cache" });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch (_) {
      return fallback;
    }
  }

  // ---------------------------------------------------------------- 資料（按需載入、只載一次）
  const data = {
    rows: null, tags: {}, fxGains: { stocks: {} },
    records: null, conferences: null, researchMeta: null,
  };
  let baseP = null, recordsP = null, conferencesP = null, addonsP = null, addonList = [];

  const tagsOf = (code) => data.tags[code] || [];

  /** 個股基本列（latest.json）、業務標籤、外匯損益；index.html 已載入時由 setData 提供 */
  function ensureBase() {
    return baseP || (baseP = Promise.all([
      getJSON("data/latest.json", []),
      getJSON("data/tags.json", {}),
      getJSON("data/fx_gains.json", { stocks: {} }),
    ]).then(([rows, tags, fx]) => {
      data.rows = rows || [];
      data.tags = tags || {};
      data.fxGains = fx && fx.stocks ? fx : { stocks: {} };
    }));
  }
  function ensureRecords() {
    return recordsP || (recordsP = getJSON("data/records.json", { lists: {}, counts: {}, asOf: {} })
      .then((v) => (data.records = v)));
  }
  function ensureConferences() {
    return conferencesP || (conferencesP = getJSON("data/conferences.json", { stocks: {} })
      .then((v) => (data.conferences = v)));
  }
  /** 面板增強腳本（op-ui.js、insider.js…）：其他頁在第一次開面板前才依序載入 */
  function ensureAddons() {
    return addonsP || (addonsP = Promise.all(addonList.map((src) => new Promise((done) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = false; // 保持載入順序，與 index.html 的 <script> 順序一致
      s.onload = s.onerror = () => done();
      document.head.appendChild(s);
    }))));
  }

  // 外匯損益占淨利：外幣兌換利益（損失）取自 iXBRL 財報附註，需與損益表同一期別才計算。
  function fxRecord(r) {
    const d = data.fxGains.stocks[r.c], fin = r.fin || {};
    if (!d || d.status !== "ok" || d.fx == null || !fin.y || d.year !== fin.y || d.quarter !== fin.q) return null;
    return d;
  }
  function fxValue(r) {
    const d = fxRecord(r), net = r.fin && r.fin.net;
    if (!d || net == null || net <= 0) return null;
    return Math.round(d.fx / (net * 1000) * 10000) / 100;
  }

  // ---------------------------------------------------------------- 創新高／新低榜（面板徽章與 app.js 榜單共用）
  const RECORD_KINDS = {
    price_high: ["股價創歷史新高", "最新收盤 ≥ 所有可得歷史收盤（2013 起每月底收盤＋近期每日收盤，未還原權息；股數變動逾 20% 只比較變動後）。", "price"],
    price_low: ["股價創歷史新低", "最新收盤 ≤ 所有可得歷史收盤（口徑同上）。", "price"],
    gpm_high: ["毛利率創歷史新高", "最新一季毛利率高於 2013Q1 起所有前期。", "pct"],
    opm_high: ["營業利益率創歷史新高", "最新一季營業利益率高於 2013Q1 起所有前期。", "pct"],
    npm_high: ["淨利率創歷史新高", "最新一季稅後純益率高於 2013Q1 起所有前期。", "pct"],
    revenue_high: ["單月營收創歷史新高", "最新月份單月營收金額高於 2013-01 起所有月份。", "amt"],
    contract_high: ["合約負債創歷史新高", "最新一季合約負債（總額；未揭露總額時用流動部分）高於 2022Q1 起所有前期。", "amt"],
    ps_high: ["P/S 創歷史新高", "目前股價營收比高於 2013 起每月 P/S 的最大值。", "ps"],
    ps_q95: ["P/S ≥ 第 95 百分位上界", "目前股價營收比 ≥ 2013 起每月 P/S 的第 95 百分位（不含本月）。", "ps"],
    ps_q05: ["P/S ≤ 第 5 百分位下界", "目前股價營收比 ≤ 2013 起每月 P/S 的第 5 百分位（不含本月）。", "ps"],
  };

  // ---------------------------------------------------------------- 折線圖
  /**
   * series: [{key, name, color, points: [[label, value], ...]}]
   * 單一系列不畫圖例（標題已說明是什麼）；兩個以上一律有圖例並直接標註。
   */
  function lineChart(svg, tipEl, series, opts = {}) {
    const W = 900, H = opts.height || 300;
    const M = { t: 14, r: 62, b: 26, l: 44 };
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = "";

    const labels = [];
    series.forEach((s) => s.points.forEach(([l]) => { if (!labels.includes(l)) labels.push(l); }));
    labels.sort();
    const vals = series.flatMap((s) => s.points.map(([, v]) => v)).filter((v) => v != null);
    if (!labels.length || !vals.length) {
      svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="tick">尚無資料</text>`;
      return;
    }

    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.12 || 1;
    lo = opts.allowNegative ? lo - pad : Math.max(0, lo - pad); hi = hi + pad;

    const X = (i) => M.l + (labels.length === 1 ? 0 : (i * (W - M.l - M.r)) / (labels.length - 1));
    const Y = (v) => H - M.b - ((v - lo) / (hi - lo)) * (H - M.t - M.b);
    const ns = "http://www.w3.org/2000/svg";
    const mk = (n, a) => { const e = document.createElementNS(ns, n); for (const k in a) e.setAttribute(k, a[k]); return e; };

    // 水平網格 + 刻度
    const TICKS = 5;
    for (let i = 0; i <= TICKS; i++) {
      const v = lo + ((hi - lo) * i) / TICKS, y = Y(v);
      svg.appendChild(mk("line", { class: "gridline", x1: M.l, x2: W - M.r, y1: y, y2: y }));
      const t = mk("text", { class: "tick", x: M.l - 7, y: y + 3.5, "text-anchor": "end" });
      t.textContent = v >= 100 ? v.toFixed(0) : v.toFixed(1);
      svg.appendChild(t);
    }
    svg.appendChild(mk("line", { class: "axis", x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b }));

    // X 軸只標年份；再要求標籤之間至少隔 46px，避免年份擠在一起
    let lastYear = "", lastX = -Infinity;
    labels.forEach((l, i) => {
      const y = opts.showMonths ? String(l) : String(l).slice(0, 4);
      if (y === lastYear) return;
      const x = X(i);
      if (x - lastX < 46) { lastYear = y; return; }
      lastYear = y; lastX = x;
      const t = mk("text", { class: "tick", x, y: H - M.b + 15, "text-anchor": "middle" });
      t.textContent = y;
      svg.appendChild(t);
    });

    // 線
    series.forEach((s) => {
      const pts = labels.map((label, i) => {
        const point = s.points.find(p => p[0] === label);
        return point && point[1] != null && !point[2] ? [X(i), Y(point[1])] : null;
      });
      let connected = false;
      const path = pts.map(point => {
        if (!point) { connected = false; return ""; }
        const command = connected ? "L" : "M";
        connected = true;
        return `${command}${point[0].toFixed(1)},${point[1].toFixed(1)}`;
      }).join(" ");
      const validPoints = pts.filter(Boolean);
      // 負 EPS 只在該月份的範圍畫水平虛線，單一月份也能看見。
      // 正常折線在負 EPS 期間中斷，不跨過該期連成實線。
      s.points.forEach((point) => {
        if (!point[2]) return;
        const i = labels.indexOf(point[0]), x = X(i), y = Y(0);
        const monthIndex = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7));
        const adjacentNegative = (j) => s.points.some(p => p[0] === labels[j] && p[2])
          && Math.abs(monthIndex(labels[j]) - monthIndex(point[0])) === 1;
        const half = labels.length > 1 ? (W - M.l - M.r) / (labels.length - 1) / 2 : 10;
        const left = adjacentNegative(i - 1) ? half : Math.min(10, half);
        const right = adjacentNegative(i + 1) ? half : Math.min(10, half);
        svg.appendChild(mk("path", { class: "line", stroke: s.color,
          "stroke-dasharray": "5 4",
          d: `M${Math.max(M.l, x - left)},${y} L${Math.min(W - M.r, x + right)},${y}` }));
      });
      if (!validPoints.length) return;
      svg.appendChild(mk("path", {class: "line", stroke: s.color, d: path}));
      validPoints.forEach(([cx, cy]) => svg.appendChild(mk("circle", {
        cx, cy, r: 3, fill: s.color,
      })));
      // 直接標註在線的末端
      const last = validPoints[validPoints.length - 1];
      const t = mk("text", { class: "lbl", x: last[0] + 8, y: last[1] + 4, fill: s.color });
      t.textContent = s.name;
      svg.appendChild(t);
    });

    // 游標層
    const cross = mk("line", { class: "crosshair", y1: M.t, y2: H - M.b, x1: -99, x2: -99 });
    svg.appendChild(cross);
    const dots = mk("g", {});
    svg.appendChild(dots);

    const hit = mk("rect", { class: "hit", x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b });
    svg.appendChild(hit);

    const hide = () => { tipEl.hidden = true; cross.setAttribute("x1", -99); cross.setAttribute("x2", -99); dots.innerHTML = ""; };
    const move = (ev) => {
      const box = svg.getBoundingClientRect();
      const cx = ((ev.clientX - box.left) / box.width) * W;
      let idx = Math.round(((cx - M.l) / (W - M.l - M.r)) * (labels.length - 1));
      idx = Math.max(0, Math.min(labels.length - 1, idx));
      const x = X(idx);
      cross.setAttribute("x1", x); cross.setAttribute("x2", x);
      dots.innerHTML = "";
      const rows = [];
      series.forEach((s) => {
        const p = s.points.find((q) => q[0] === labels[idx]);
        if (!p || p[1] == null) return;
        dots.appendChild(mk("circle", { class: "pt", cx: x, cy: Y(p[1]), r: 4.5, fill: s.color }));
        rows.push(`<div class="tt-r"><span><span class="swatch" style="display:inline-block;background:${s.color}"></span> ${s.name}</span><span>${p[2] ? "該期間 EPS 為負，不予顯示" : `${fmt(p[1])}${opts.unit || ""}`}</span></div>`);
      });
      if (!rows.length) return hide();
      const extra = opts.tooltipNote ? `<div class="tt-h">${esc(opts.tooltipNote(labels[idx]) || "")}</div>` : "";
      tipEl.innerHTML = `<div class="tt-h">${labels[idx]}</div>${rows.join("")}${extra}`;
      tipEl.hidden = false;
      const wrapBox = tipEl.parentElement.getBoundingClientRect();
      let left = ev.clientX - wrapBox.left + 14;
      if (left + tipEl.offsetWidth > wrapBox.width) left = ev.clientX - wrapBox.left - tipEl.offsetWidth - 14;
      tipEl.style.left = Math.max(0, left) + "px";
      tipEl.style.top = Math.max(0, ev.clientY - wrapBox.top - 10) + "px";
    };
    hit.addEventListener("mousemove", move);
    hit.addEventListener("mouseleave", hide);
    svg.addEventListener("touchmove", (e) => { if (e.touches[0]) move(e.touches[0]); }, { passive: true });
    svg.addEventListener("touchend", hide);
  }

  // 第六欄保留資料來源確認的原因；不可由 null、最新 EPS 或單季 EPS 推測歷史。
  function peHistoryPoints(history) {
    return history.map(([ym, pe, , , , reason]) => {
      const negative = !(pe > 0) && (reason === "negative_eps" || (Number.isFinite(pe) && pe < 0));
      return [ym, negative ? 0 : pe, negative];
    }).filter((point) => point[1] != null);
  }

  // ---------------------------------------------------------------- 隊友調查（法說會重點、興櫃新登錄）
  // meta.json 列出有資料的代號；只對清單內的代號抓單檔，不產生 404。
  // 文字一律原樣顯示（含「（推論）」與頁碼），只做跳脫與網址轉連結；不顯示資料來源、彙整時間與簡報說明。
  // 放在「最新法說會簡報」連結正下方（沒有該連結時放在估值數字下方的同一位置）。
  const rsMeta = () => data.researchMeta ||
    (data.researchMeta = getJSON("data/research/meta.json", null).then((m) => {
      if (m) for (const k of ["captain", "ryza"]) if (m[k]) m[k].codeSet = new Set(m[k].codes || []);
      return m;
    }));
  const rsLink = (s) => esc(s).replace(/https?:\/\/[^\s<>"'，；、。）)]+/g,
    (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  const rsBlock = (label, body) => (body ? `<div class="rs-block"><div class="rs-label">${esc(label)}</div>${body}</div>` : "");
  const rsPara = (s) => (s == null || s === "" ? "" : `<p class="rs-text">${rsLink(s)}</p>`);
  const rsTags = (list) => (Array.isArray(list) && list.length
    ? `<div class="panel-tags">${list.map((t) => `<span class="tag static">${esc(t)}</span>`).join("")}</div>` : "");
  const rsTable = (head, rows) => (rows.length
    ? `<div class="rs-table-wrap"><table class="rs-table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td>${rsLink(c ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : "");
  const rsCustomers = (list) => rsTable(["產業別", "客戶", "供應產品"],
    (list || []).map((x) => [x.sector, x.names, x.supply]));
  const rsEvents = (list) => (Array.isArray(list) && list.length
    ? `<ul class="rs-events">${list.map((e) => `<li><span class="rs-ev-date">${esc(e.date)}</span>${e.type ? `<span class="tag static">${esc(e.type)}</span>` : ""}<div class="rs-text">${rsLink(e.description ?? e.text ?? "")}</div>${
        e.source ? `<div class="rs-src">來源：${rsLink(e.source)}</div>` : ""}</li>`).join("")}</ul>`
    : `<p class="rs-text na">無</p>`);
  const rsPipeline = (list) => {
    if (!Array.isArray(list)) return "";
    if (!list.length) return `<p class="rs-text na">無</p>`;
    return rsTable(["代號", "標的", "適應症", "進度"], list.flatMap((p) => {
      const items = p.items && p.items.length ? p.items : [{}];
      return items.map((it, i) => [i ? "" : p.code, i ? "" : p.target, it.indication, it.stage]);
    })) + list.filter((p) => p.note).map((p) => `<p class="rs-src">${esc(p.code)}：${rsLink(p.note)}</p>`).join("");
  };
  const rsLicenses = (list) => (!Array.isArray(list) ? "" : !list.length ? `<p class="rs-text na">無</p>`
    : rsTable(["藥品", "地區", "被授權方", "條件"], list.map((x) => [x.drug, x.territory, x.licensee, x.terms])));
  const rsBiotech = (r) => [
    rsBlock("臨床管線", rsPipeline(r.pipeline)),
    rsBlock("臨床前管線", rsPipeline(r.preclinical)),
    rsBlock("授權", rsLicenses(r.licenses)),
    rsBlock("其他產品", rsTags(r.otherProducts)),
  ].join("");

  function renderCaptain(r) {
    const head = `<h4>法說會重點</h4>`;
    if (r.nodata || r.template === "nodata") return `${head}<p class="note">尚無法說會資料。</p>`;
    return head + [
      rsBlock("產業及產品", rsTags(r["產業及產品"])),
      rsBlock("新領域", (r["新領域摘要"] ? `<p class="rs-text rs-sum">${rsLink(r["新領域摘要"])}</p>` : "") + rsPara(r["新領域"])),
      rsBlock("客戶及供應產品", rsCustomers(r["客戶及供應產品"]) + (r["客戶備註"] ? `<p class="rs-src">${rsLink(r["客戶備註"])}</p>` : "")),
      rsBlock("業績展望", (r["業績展望摘要"] ? `<p class="rs-text rs-sum">${rsLink(r["業績展望摘要"])}</p>` : "") + rsPara(r["業績展望"])),
      rsBlock("重大事件", rsEvents(r["重大事件"])),
      r.template === "biotech" ? rsBiotech(r) : "",
    ].join("");
  }

  function renderRyza(r, m) {
    const dd = m.data_dates || {};
    const ps = r.ps_ratio == null ? "—" : fmt(r.ps_ratio);
    return `<h4>興櫃新登錄調查</h4>
      <div class="kv">
        <div><div class="k">評分（暫定）</div><div class="v">${r.score == null ? "—" : `${esc(r.score)}<small class="rs-of">/10</small>`}</div></div>
        <div><div class="k">股價營收比（估算）</div><div class="v">${ps}</div></div>
        <div><div class="k">興櫃登錄日</div><div class="v rs-date">${esc(r.regDate || "—")}</div></div>
      </div>
      <p class="note">${esc((m.fields || {}).score || "評分（滿分10，暫定）")}。股價營收比以 ${esc(dd.ps_ratio_price || "—")} 股價、${esc(dd.ps_ratio_revenue || "—")} 營收估算。</p>` + [
      rsBlock("評價", rsPara(r.review)),
      rsBlock("產業及產品", rsTags(r.tags)),
      rsBlock("新領域", rsPara(r.expansion)),
      rsBlock("業績展望", rsPara(r.outlook)),
      rsBlock("客戶及供應產品", rsCustomers(r.customers) + (r.customerNote ? `<p class="rs-src">${rsLink(r.customerNote)}</p>` : "")),
      rsBlock("重大事件", rsEvents(r.majorEvents)),
      r.kind === "biotech" ? rsBiotech(r) : "",
    ].join("");
  }

  async function loadResearch(code, box) {
    if (!box) return;
    try {
      const m = await rsMeta();
      if (!m) return;
      const has = (k) => m[k] && m[k].codeSet.has(code);
      const [cap, ryz] = await Promise.all([
        has("captain") ? getJSON(`data/research/captain/${code}.json`, null) : null,
        has("ryza") ? getJSON(`data/research/ryza/${code}.json`, null) : null,
      ]);
      if (!box.isConnected) return;
      box.innerHTML = (cap ? renderCaptain(cap) : "") + (ryz ? renderRyza(ryz, m.ryza) : "");
    } catch (_) {
      box.innerHTML = "";
    }
  }

  // ---------------------------------------------------------------- 個股面板
  const CLOSE_ICON ='<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5.5 5.5 9 9m0-9-9 9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';

  /**
   * opts.onClose()：面板關閉後呼叫（關閉鈕、Esc、點背景、程式呼叫 close() 皆同）
   * opts.onRecordBadge(kind, close)：點創新高／新低徽章；未提供時只關面板、照連結前往
   * opts.recordsHref：徽章連結，預設 "#records"
   * 回傳 { code, close }；找不到代號時回傳 null。
   */
  async function open(code, opts = {}) {
    await ensureBase();
    const base = data.rows.find((r) => r.c === code);
    if (!base) return null;
    // 個股檔只存歷史；營運先行指標另按需載入，不增加首頁初始下載量。
    const [dRaw, opRaw, fhRaw] = await Promise.all([
      getJSON(`data/stock/${code}.json`, null),
      getJSON(`data/operating/${code}.json`, null),
      getJSON(`data/fin_history/${code}.json`, null),
      ensureRecords(),
      ensureConferences(),
      ensureAddons(),
    ]);
    // 最新一期法說會：優先連到官方簡報檔，沒有簡報檔再連公司網站的法說會資訊
    const conf = ((data.conferences || {}).stocks || {})[code];
    const confHref = conf && (conf[1] ? `https://mopsov.twse.com.tw/nas/STR/${encodeURIComponent(conf[1])}` : conf[3]);
    const confLink = confHref
      ? `<a href="${esc(confHref)}" target="_blank" rel="noopener">最新法說會${conf[1] ? "簡報" : ""}（${esc(conf[0])}）</a>`
      : "";
    // 出現在創新高與新低榜的項目，在詳細頁最上方醒目標注；可同時多個
    const recordHits = Object.keys(RECORD_KINDS).filter((k) =>
      ((data.records.lists || {})[k] || []).some((it) => it.c === code));
    const fh = fhRaw || {};
    const revMonths = Object.keys(fh.rev || {}).sort();
    const marginQuarters = Object.keys(fh.margin || {}).sort();
    const d = dRaw || {}, op = opRaw || {};
    const rev = base.rev || {}, fin = base.fin || {};
    const opPeriods = op.periods || {};
    const opLabels = Object.keys(opPeriods).sort();
    for (const row of Object.values(opPeriods)) {
      // The combined observation uses the disclosed total, or the explicitly
      // labelled current amount when a full contract total is unavailable.
      row.contractObserved = row.contractTotal ?? row.contractCurrent ?? null;
      row.contractAndReceipts = row.contractObserved == null || row.customerReceiptsTotal == null
        ? null : row.contractObserved + row.customerReceiptsTotal;
    }

    const prevQuarter = (period) => {
      const m = /^(\d{4})Q([1-4])$/.exec(period || "");
      if (!m) return null;
      let y = Number(m[1]), q = Number(m[2]) - 1;
      if (!q) { y -= 1; q = 4; }
      return `${y}Q${q}`;
    };
    const prevYear = (period) => {
      const m = /^(\d{4})Q([1-4])$/.exec(period || "");
      return m ? `${Number(m[1]) - 1}Q${m[2]}` : null;
    };
    const opDelta = (period, field, kind) => {
      const cur = opPeriods[period] && opPeriods[period][field];
      const prior = kind === "qoq" ? prevQuarter(period) : prevYear(period);
      const old = prior && opPeriods[prior] && opPeriods[prior][field];
      if (cur == null || old == null || old === 0) return null;
      return (cur - old) / Math.abs(old) * 100;
    };
    const latestOpValue = (field) => {
      const period = [...opLabels].reverse().find(p => opPeriods[p] && opPeriods[p][field] != null);
      return period ? [period, opPeriods[period][field]] : [null, null];
    };
    const opSummaryBox = (title, field, sourceField = null) => {
      const [period, value] = latestOpValue(field);
      const row = period ? (opPeriods[period] || {}) : {};
      const source = sourceField && row[sourceField]
        ? (["notes", "ixbrl_notes", "pdf_notes"].includes(row[sourceField]) ? " · 附註" : row[sourceField] === "balance_sheet" ? " · 主表" : "")
        : "";
      return `<div class="op-kpi"><div class="k">${title}</div><div class="v">${value == null ? "—" : human(value)}</div><div class="op-sub">${period || "尚無資料"}${source} · YoY ${period ? (cell(opDelta(period, field, "yoy"), 1, true)) : "—"}</div></div>`;
    };

    const psHistory = d.psHist || [];
    const psAvailable = psHistory.filter(p => p.v != null);
    const psHasEstimates = psAvailable.some(p => p.basis === "估算");
    const psHasRebuilt = psAvailable.some(p => p.basis === "歷史重建");
    const psNote = psAvailable.length
      ? `資料自 ${psAvailable[0].ym} 起；每月一筆，本月持續更新。${psHasRebuilt ? "歷史重建採當時股數 × 股價 ÷ 前一月底止完整12個月營收；興櫃用日均價。歷史申報可能事後更正，不代表當時已知資訊。" : ""}${psHasEstimates ? "含當時保存的估算值。" : ""}游標可查看日期與計算基礎；缺值留白。`
      : "尚無可用歷史 P/S；取得完整營收與歷史股數後會自動累積。";

    const ov = document.createElement("div");
    ov.className = "overlay";
    ov.innerHTML = `<div class="panel" role="dialog" aria-modal="true" aria-label="${esc(base.n)} 詳細">
      <div class="panel-grip" aria-hidden="true"></div>
      <div class="panel-head">
        <h3>${base.c} ${esc(base.n)}</h3>
        <span class="mkt">${LABEL[base.m]}</span>
        <span class="ind-lbl">${esc(base.i || "")}</span>
        <button class="close" type="button" aria-label="關閉">${CLOSE_ICON}</button>
      </div>
      ${recordHits.length ? `<div class="record-badges" aria-label="創新高與新低榜">${recordHits.map((k) =>
        `<a class="record-badge${k === "price_low" || k === "ps_q05" ? " low" : ""}" href="${esc(opts.recordsHref || "#records")}" data-kind="${k}">${esc(RECORD_KINDS[k][0])}</a>`).join("")}</div>` : ""}
      ${tagsOf(base.c).length
        ? `<div class="panel-tags">${tagsOf(base.c).map((t) => `<span class="tag static">${esc(t)}</span>`).join("")}</div>`
        : ""}
      <div class="kv">
        <div><div class="k">股價</div><div class="v">${fmt(base.p) ?? "—"}</div></div>
        <div><div class="k">本益比</div><div class="v">${fmt(base.pe) ?? "—"}</div></div>
        <div><div class="k">股價營收比</div><div class="v">${fmt(base.ps) ?? "—"}</div></div>
        <div><div class="k">淨值比</div><div class="v">${fmt(base.pb) ?? "—"}</div></div>
        <div><div class="k">市值</div><div class="v">${human(base.cap) ?? "—"}</div></div>
      </div>
      ${confLink ? `<div class="links">${confLink}</div>` : ""}
      <div class="research"></div>
      <h4>營收</h4>
      <p class="note">最新月份 ${rev.ym || "—"}${
        base.i && base.i.includes("金融") ? "。金融保險業的營收認列基礎與一般產業不同，成長率的擺盪幅度天生就大。" : ""
      }</p>
      <div class="kv">
        <div><div class="k">當月營收</div><div class="v">${rev.amt != null ? human(rev.amt * 1000) : "—"}</div></div>
        <div><div class="k">年增率</div><div class="v">${cell(rev.yoy, 2, true)}</div></div>
        <div><div class="k">累計年增率</div><div class="v">${cell(rev.cum_yoy, 2, true)}</div></div>
        <div><div class="k">月增率</div><div class="v">${cell(rev.mom, 2, true)}</div></div>
      </div>
      <h4>獲利</h4>
      <p class="note">${fin.y ? `${fin.y} 年第 ${fin.q} 季累計` : "尚無財報資料"}</p>
      <div class="kv">
        <div><div class="k">EPS</div><div class="v">${fmt(fin.eps) ?? "—"}</div></div>
        <div><div class="k">毛利率%</div><div class="v">${fmt(fin.gpm, 1) ?? "—"}</div></div>
        <div><div class="k">營益率%</div><div class="v">${fmt(fin.opm, 1) ?? "—"}</div></div>
        <div><div class="k">淨利率%</div><div class="v">${fmt(fin.npm, 1) ?? "—"}</div></div>
        <div><div class="k">淨利年增%</div><div class="v">${cell(fin.net_yoy, 1, true)}</div></div>
        <div><div class="k">營益年增%</div><div class="v">${cell(fin.op_yoy, 1, true)}</div></div>
        <div><div class="k">業外占稅前淨利%</div><div class="v">${cell(fin.nonop_pt, 1, true)}</div></div>
        <div><div class="k">業外占營業利益%</div><div class="v">${cell(fin.nonop_op, 1, true)}</div></div>
        <div><div class="k">外匯損益占淨利%</div><div class="v">${cell(fxValue(base), 1, true)}</div></div>
      </div>
      <h4>營運先行指標</h4>
      <p class="note">合約負債先讀資產負債表主表；主表未單獨列示時，再讀官方 iXBRL／PDF 財報附註。客戶暫收款獨立儲存。合計圖非會計科目，只供營運觀察；合約負債使用已揭露總額，未揭露總額時使用流動部分。缺值維持空白，不以 0 代替。</p>
      <div class="op-summary">
        ${opSummaryBox("合約負債（總額／流動）", "contractObserved", "data_source")}
        ${opSummaryBox("客戶暫收款", "customerReceiptsTotal", "customerReceiptsTotalSource")}
        ${opSummaryBox("存貨", "inventory")}
        ${opSummaryBox("財報期營收", "revenue")}
      </div>
      <div class="op-controls" role="group" aria-label="營運指標圖表模式">
        <button type="button" data-op-mode="amount" aria-pressed="true">金額</button>
        <button type="button" data-op-mode="qoq" aria-pressed="false">QoQ</button>
        <button type="button" data-op-mode="yoy" aria-pressed="false">YoY</button>
      </div>
      <div class="card op-normalized">
        <div class="op-chart-head"><strong>四項指標比較</strong><span>各系列首個可用期＝100</span></div>
        <div class="chart-wrap"><div class="chart-scroll"><svg class="chart" id="opCompareChart" role="img" aria-label="合約負債、客戶暫收款、存貨、營收標準化比較"></svg></div><div class="tooltip" id="opCompareTip" hidden></div></div>
      </div>
      <div class="op-controls" role="group" aria-label="選擇營運指標">
        <label for="opMetric">指標</label>
        <select id="opMetric">
          <option value="contractObserved">1) 合約負債</option>
          <option value="customerReceiptsTotal">2) 客戶暫收款</option>
          <option value="contractAndReceipts">3) 合約負債＋客戶暫收款</option>
          <option value="inventory">4) 存貨</option>
          <option value="revenue">5) 季營收</option>
        </select>
      </div>
      <p class="note" id="opCombinedNote" hidden>非會計科目，只供營運觀察。採同季合約負債總額（未揭露總額時採流動部分）＋客戶暫收款合計；任一項缺值即不顯示合計。</p>
      <p class="note" id="opSourceNote"></p>
      <div class="card"><div class="op-chart-head"><strong id="opSelectedTitle">合約負債</strong><span id="opSelectedUnit">億元</span></div><div class="chart-wrap"><div class="chart-scroll"><svg class="chart" id="opSelectedChart" role="img" aria-label="所選營運指標"></svg></div><div class="tooltip" id="opSelectedTip" hidden></div></div></div>
      <h4 id="finHistHead">歷年月營收</h4>
      <p class="note">${revMonths.length ? `公開資訊觀測站每月營收彙總表，${revMonths[0]} 至 ${revMonths[revMonths.length - 1]}，每月一筆；缺值留白。` : "歷年月營收每日自動補抓中，尚無這家公司的資料。"}</p>
      <div class="op-controls" role="group" aria-label="月營收圖表模式">
        <button type="button" data-rev-mode="amount" aria-pressed="true">金額</button>
        <button type="button" data-rev-mode="mom" aria-pressed="false">MoM</button>
        <button type="button" data-rev-mode="yoy" aria-pressed="false">YoY</button>
      </div>
      <div class="card"><div class="op-chart-head"><strong>月營收</strong><span id="revHistUnit">億元</span></div><div class="chart-wrap"><div class="chart-scroll"><svg class="chart" id="revHistChart" role="img" aria-label="${esc(base.n)} 歷年月營收"></svg></div><div class="tooltip" id="revHistTip" hidden></div></div></div>
      <h4>歷年毛利率、營業利益率、淨利率</h4>
      <p class="note">${marginQuarters.length ? `公開資訊觀測站財務比較 E 點通單季數字，${marginQuarters[0]} 至 ${marginQuarters[marginQuarters.length - 1]}；淨利率為稅後純益率。金融業沒有毛利率與營業利益率，缺值留白。` : "利潤率每日自動補抓中，尚無這家公司的資料。"}</p>
      <div class="card"><div class="op-chart-head"><strong>單季毛利率、營業利益率、淨利率</strong><span>%</span></div><div class="op-chart-head" style="justify-content:flex-start;gap:14px;font-size:12px"><span><i style="display:inline-block;width:14px;height:3px;border-radius:2px;background:var(--accent);vertical-align:3px;margin-right:5px"></i>毛利率</span><span><i style="display:inline-block;width:14px;height:3px;border-radius:2px;background:var(--series-1);vertical-align:3px;margin-right:5px"></i>營業利益率</span><span><i style="display:inline-block;width:14px;height:3px;border-radius:2px;background:var(--series-2);vertical-align:3px;margin-right:5px"></i>淨利率</span></div><div class="chart-wrap"><div class="chart-scroll"><svg class="chart" id="marginChart" role="img" aria-label="${esc(base.n)} 歷年毛利率、營業利益率、淨利率"></svg></div><div class="tooltip" id="marginTip" hidden></div></div></div>
      <h4>歷年本益比</h4>
      <div class="card" style="margin-top:12px"><div class="chart-wrap">
        <div class="chart-scroll"><svg class="chart" id="stockChart" role="img" aria-label="${esc(base.n)} 歷年本益比"></svg></div>
        <div class="tooltip" id="stockTip" hidden></div>
      </div></div>
      <h4>歷年股價營收比（P/S）</h4>
      <p class="note" id="psHistoryNote">${esc(psNote)} <a href="https://github.com/roseamyclara/tw-stock-valuation/blob/main/docs/ps-history-sources.md" target="_blank" rel="noopener">資料來源與計算說明 ↗</a></p>
      <div class="card" style="margin-top:12px"><div class="chart-wrap">
        <div class="chart-scroll"><svg class="chart" id="stockPsChart" role="img" aria-label="${esc(base.n)} 歷年股價營收比"></svg></div>
        <div class="tooltip" id="stockPsTip" hidden></div>
      </div></div>
    </div>`;
    document.body.appendChild(ov);
    document.body.style.overflow = "hidden";

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      ov.remove();
      document.body.style.overflow = "";
      document.removeEventListener("keydown", esc2);
      if (opts.onClose) opts.onClose();
    };
    function esc2(e) { if (e.key === "Escape") close(); }
    ov.querySelector(".close").addEventListener("click", close);
    ov.querySelectorAll(".record-badge").forEach((a) => a.addEventListener("click", () => {
      if (opts.onRecordBadge) opts.onRecordBadge(a.dataset.kind, close);
      else close();
    }));
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    document.addEventListener("keydown", esc2);
    ov.querySelector(".close").focus();
    // 隊友調查只在面板開啟後按需載入，不擋住數字與圖表
    loadResearch(code, ov.querySelector(".research"));

    const opSeries = (field, mode) => opLabels.map(period => {
      const raw = opPeriods[period] && opPeriods[period][field];
      if (mode === "amount") return [period, raw == null ? null : raw / 1e8];
      return [period, opDelta(period, field, mode)];
    });

    const normalized = (field) => {
      const basePeriod = opLabels.find(period => opPeriods[period] && opPeriods[period][field] != null && opPeriods[period][field] !== 0);
      if (!basePeriod) return [];
      const baseValue = opPeriods[basePeriod][field];
      return opLabels
        .filter(period => period >= basePeriod)
        .map(period => {
          const value = opPeriods[period] && opPeriods[period][field];
          return [period, value == null ? null : value / baseValue * 100];
        });
    };

    let selectedOpMode = "amount";
    const renderOperating = (mode) => {
      selectedOpMode = mode;
      const selected = ov.querySelector("#opMetric");
      const field = selected.value;
      const title = selected.options[selected.selectedIndex].textContent.replace(/^\d\) /, "");
      ov.querySelector("#opSelectedTitle").textContent = title;
      ov.querySelector("#opCombinedNote").hidden = field !== "contractAndReceipts";
      ov.querySelector("#opSelectedUnit").textContent = mode === "amount" ? "億元" : "%";
      const sourceLines = opLabels.map(period => {
        const row = opPeriods[period];
        if (row[field] == null) return null;
        const contractSource = row.contractTotal != null ? row.contractTotalSource : row.contractCurrentSource;
        const source = field === "customerReceiptsTotal" ? row.customerReceiptsTotalSource
          : field === "contractObserved" || field === "contractAndReceipts" ? contractSource : null;
        if (!source) return null;
        const basis = (field === "contractObserved" || field === "contractAndReceipts")
          ? (row.contractTotal != null ? "總額" : "流動部分") : "";
        return `${period}：${source === "balance_sheet" ? "主表" : "附註"}${basis ? `（${basis}）` : ""}`;
      }).filter(Boolean);
      ov.querySelector("#opSourceNote").textContent = sourceLines.join("；");
      lineChart(ov.querySelector("#opSelectedChart"), ov.querySelector("#opSelectedTip"),
        [{key: field, name: title, color: "var(--accent)", points: opSeries(field, mode)}],
        {unit: mode === "amount" ? "億元" : "%", allowNegative: mode !== "amount", height: MOBILE.matches ? 220 : 250});
    };

    lineChart(
      ov.querySelector("#opCompareChart"),
      ov.querySelector("#opCompareTip"),
      [
        { key: "contract", name: "合約負債", color: "var(--accent)", points: normalized("contractObserved") },
        { key: "customer", name: "客戶暫收款", color: "var(--series-1)", points: normalized("customerReceiptsTotal") },
        { key: "inventory", name: "存貨", color: "var(--series-2)", points: normalized("inventory") },
        { key: "revenue", name: "營收", color: "var(--series-3)", points: normalized("revenue") },
      ],
      { unit: "", height: MOBILE.matches ? 220 : 250 }
    );
    ov.querySelector("#opMetric").addEventListener("change", () => renderOperating(selectedOpMode));
    renderOperating("amount");
    ov.querySelectorAll("[data-op-mode]").forEach(button => {
      button.addEventListener("click", () => {
        ov.querySelectorAll("[data-op-mode]").forEach(b => b.setAttribute("aria-pressed", "false"));
        button.setAttribute("aria-pressed", "true");
        renderOperating(button.dataset.opMode);
      });
    });

    // 歷年月營收（千元 → 億元）與 MoM／YoY
    const revOf = (ym) => (fh.rev || {})[ym] ?? null;
    const revShift = (ym, n) => {
      const t = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
      return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, "0")}`;
    };
    const revDelta = (ym, back) => {
      const cur = revOf(ym), old = revOf(revShift(ym, -back));
      return cur == null || old == null || old === 0 ? null : (cur - old) / Math.abs(old) * 100;
    };
    const renderRevenue = (mode) => {
      ov.querySelector("#revHistUnit").textContent = mode === "amount" ? "億元" : "%";
      const points = revMonths.map((ym) => [ym, mode === "amount" ? (revOf(ym) == null ? null : revOf(ym) / 1e5)
        : revDelta(ym, mode === "mom" ? 1 : 12)]);
      lineChart(ov.querySelector("#revHistChart"), ov.querySelector("#revHistTip"),
        revMonths.length ? [{ key: "rev", name: mode === "amount" ? "月營收" : mode === "mom" ? "月增率" : "年增率", color: "var(--accent)", points }] : [],
        { unit: mode === "amount" ? "億元" : "%", allowNegative: mode !== "amount", height: MOBILE.matches ? 220 : 250 });
    };
    renderRevenue("amount");
    ov.querySelectorAll("[data-rev-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        ov.querySelectorAll("[data-rev-mode]").forEach((b) => b.setAttribute("aria-pressed", "false"));
        button.setAttribute("aria-pressed", "true");
        renderRevenue(button.dataset.revMode);
      });
    });
    const marginSeries = (slot) => marginQuarters.map((q) => [q, (fh.margin[q] || [])[slot] ?? null]);
    lineChart(ov.querySelector("#marginChart"), ov.querySelector("#marginTip"),
      marginQuarters.length ? [
        { key: "gpm", name: "毛利率", color: "var(--accent)", points: marginSeries(0) },
        { key: "opm", name: "營益率", color: "var(--series-1)", points: marginSeries(1) },
        { key: "npm", name: "淨利率", color: "var(--series-2)", points: marginSeries(2) },
      ].filter((s) => s.points.some((p) => p[1] != null)) : [],
      { unit: "%", allowNegative: true, height: MOBILE.matches ? 220 : 250 });

    const hist = peHistoryPoints(d.hist || []);
    lineChart(ov.querySelector("#stockChart"), ov.querySelector("#stockTip"),
      hist.length ? [{ key: "pe", name: "本益比", color: SERIES[base.m], points: hist }] : [],
      { unit: "倍", height: MOBILE.matches ? 200 : 240 });
    lineChart(ov.querySelector("#stockPsChart"), ov.querySelector("#stockPsTip"),
      psAvailable.length ? [{ key: "ps", name: "股價營收比", color: "var(--series-2)", points: psHistory.map(p => [p.ym, p.v]) }] : [],
      { unit: "倍", height: MOBILE.matches ? 200 : 240, showMonths: psHistory.length <= 24,
        tooltipNote: month => {
          const p = psHistory.find(p => p.ym === month);
          return p ? `${p.d} · 營收 ${p.revenueMonth || "期別不明"} · ${p.basis}` : "";
        } });
    return { code, close };
  }

  window.StockPanel = {
    open,
    /** index.html：把 app.js 已載入的資料交給面板，避免重複下載 */
    setData({ rows, tags, fxGains }) {
      data.rows = rows || [];
      data.tags = tags || {};
      data.fxGains = fxGains && fxGains.stocks ? fxGains : { stocks: {} };
      baseP = Promise.resolve();
    },
    /** 其他頁：設定第一次開面板前要載入的增強腳本 */
    setAddons(list) { addonList = list || []; },
    ensureRecords,
    fxRecord, fxValue, RECORD_KINDS,
    util: { fmt, human, esc, cell, getJSON },
  };
})();
