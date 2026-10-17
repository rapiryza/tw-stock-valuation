/* 台股估值追蹤 — 前端 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MARKETS = ["listed", "otc", "esb"];
  const LABEL = { listed: "上市", otc: "上櫃", esb: "興櫃" };
  const SERIES = { listed: "var(--series-1)", otc: "var(--series-2)", esb: "var(--series-3)" };

  // 平板以下改用卡片列表；桌機用完整表格。斷點與 style.css 的 860px 一致。
  const MOBILE = window.matchMedia("(max-width: 860px)");

  // 公開資訊觀測站的市場代碼
  const MOPS_TYPE = { listed: "sii", otc: "otc", esb: "rotc" };

  // 官方開放資料的「產業別」→ 產業價值鏈資訊平台對應的產業鏈說明頁。
  // 只是連結，不是把對方的分類抄過來：他們的使用條款禁止重製與散布其內容。
  const CHAIN = {
    半導體業: "D000", 電腦及週邊設備業: "F000", 光電業: "G000", 通信網路業: "I000",
    電子零組件業: "J000", 資訊服務業: "R000", 其他電子業: "X000",
    生技醫療業: "C100", 農業科技: "C300",
    水泥工業: "1000", 食品工業: "M000", 塑膠工業: "N000", 化學工業: "N000",
    橡膠工業: "N000", 紡織纖維: "O000", 電機機械: "P000", 電器電纜: "P000",
    造紙工業: "2000", 鋼鐵工業: "Q000", 汽車工業: "3000",
    建材營造業: "S000", 航運業: "T000", 觀光餐旅: "B000", 觀光事業: "B000",
    金融保險業: "U000", 貿易百貨業: "V000", 油電燃氣業: "W000",
    文化創意業: "Y000", 電子商務: "R300", 數位雲端: "5400", 運動休閒: "5800",
    居家生活: "V000", 玻璃陶瓷: "X000", 綜合: "X000", 其他業: "X000", 其他: "X000",
  };

  const chainUrl = (ind) => (CHAIN[ind] ? `https://ic.tpex.org.tw/introduce.php?ic=${CHAIN[ind]}` : null);
  const mopsUrl = (r) => `https://mopsov.twse.com.tw/mops/web/t05st03?TYPEK=${MOPS_TYPE[r.m] || "sii"}&co_id=${r.c}`;

  const state = {
    rows: [], view: [], meta: null, market: null, tags: {}, movers: null, history: null,
    tdcc: { date: null, base: null, d: {} },
    performance: { stocks: {} }, returnPeriod: "d1", revenueNotes: {}, profitGrowth: {stocks:{}}, fxGains: {stocks:{}}, operating: {stocks:{}}, insider: {stocks:{}}, selectedColumns: ["p", "cap", "priceReturn", "insider_holding", "pe", "ps", "rev_yoy", "rev_cum", "contract_yoy", "customer_receipts_yoy", "net_yoy", "rev_note"],
    // sorts: [{k, dir}]，最多 3 個，陣列順序就是優先序（索引 0 最優先）
    // 空陣列代表沒設任何條件，套用 DEFAULT_SORTS
    sorts: [], filterMarket: "", industry: "", tag: "", q: "",
    shown: 200, period: "d1", moverMarket: "listed",
  };

  const tagsOf = (code) => state.tags[code] || [];

  const RETURN_PERIODS = { d1: "一日", y5: "五年", y1: "一年", ytd: "今年迄今", m3: "三個月", m1: "一個月", w1: "一週" };
  const performanceOf = (code) => state.performance.stocks[code] || {};
  const operatingOf = (code) => state.operating.stocks[code] || {};
  const insiderOf = (code) => state.insider.stocks[code] || {};
  const returnOf = (code) => (performanceOf(code).returns || {})[state.returnPeriod] ?? null;
  const insiderTransferValue = (code) => insiderOf(code).transfer?.latestLots ?? null;
  const insiderTransferDate = (code) => insiderOf(code).transfer?.latestDate || "";
  const insiderHoldingChange = (code) => insiderOf(code).holding?.monthlyChange ?? null;
  const insiderHoldingMonth = (code) => insiderOf(code).holding?.latestMonth || "";
  const periodOptions = () => Object.entries(RETURN_PERIODS).map(([k, t]) =>
    `<option value="${k}"${state.returnPeriod === k ? " selected" : ""}>${t}</option>`).join("");
  function changeReturnPeriod(value) {
    if (!Object.hasOwn(RETURN_PERIODS, value)) return;
    state.returnPeriod = value;
    state.shown = 200;
    applyFilters();
    paintHead();
    const mobile = $("returnPeriodMobile");
    if (mobile) mobile.value = value;
  }

  // 集保「400 張以上」大股東：[占集保庫存比例%, 與四週前的差(百分點)]
  const tdccOf = (code) => state.tdcc.d[code] || [null, null];

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

  const insiderTransferCell = (code) => {
    const v = insiderTransferValue(code), d = insiderTransferDate(code);
    if (v == null) return `<span class="na">—</span>${d ? `<small class="profit-period">${esc(d)}</small>` : ""}`;
    return `<span title="${esc(d)} 轉讓事前申報：預定轉讓 ${fmt(v, 0)} 張，不代表已成交，也不計入持股增減">${fmt(v, v >= 100 ? 0 : 2)} 張</span><small class="profit-period">${esc(d)} 申報</small>`;
  };
  // 內部人持股增減：IRB110 為總額依據；單月增減只計集中市場買賣＋員工股/RSU
  const insiderHoldingCell = (code) => {
    const h = insiderOf(code).holding || {};
    const v = h.monthlyChange ?? null, month = h.latestMonth || "";
    const small = month ? `<small class="profit-period">${esc(month)}</small>` : "";
    if (v == null) {
      const why = !month ? "IRB110 月報沒有這家公司" : h.detail ? `${month} 為第一個月份，沒有前月可比較` : `${month} 事後申報明細尚未取得`;
      return `<span class="na" title="${esc(why)}">—</span>${small}`;
    }
    const lotsTxt = (x) => (x == null ? "—" : `${x > 0 ? "+" : ""}${fmt(x, Math.abs(x) >= 100 ? 0 : 2)} 張`);
    const tip = [
      `${month} 內部人總持股 ${fmt(h.latestLots, 0)} 張（IRB110）`,
      `本月增減 ${lotsTxt(v)}（集中市場買賣＋員工股/RSU）`,
      h.rsu ? `其中員工股/RSU ${lotsTxt(h.rsu)}` : "",
      h.verified === false ? "注意：申報明細加總與 IRB110 不符" : "",
    ].filter(Boolean).join("\n");
    const rsu = h.rsu ? ' <span class="est" title="含員工股/RSU">RSU</span>' : "";
    return `<span title="${esc(tip)}">${cell(v, 2, true)}</span>${rsu}${small}`;
  };

  const revenueCell = (r, field) => {
    const rev = r.rev || {};
    return `${cell(rev[field], 2, true)}<small class="profit-period">${esc(rev.ym || "尚無營收月份")}</small>`;
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

  // ---------------------------------------------------------------- 主題
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
  const applyTheme = (t) => {
    if (t) document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
    paintToggle();
  };
  try {
    const saved = localStorage.getItem("theme");
    if (saved) applyTheme(saved);
  } catch (_) {}
  paintToggle();
  themeBtn.addEventListener("click", () => {
    const next = isDarkNow() ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem("theme", next); } catch (_) {}
    draw();
  });

  // 顯示模式只改呈現，保留搜尋、欄位與排序狀態。
  function applyDisplayMode(mode) {
    const working = mode !== "off";
    document.body.classList.toggle("work-sheet", working);
    document.body.classList.toggle("off-hours", !working);
    document.querySelectorAll("[data-display-mode]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.displayMode === (working ? "work" : "off")));
    });
    document.title = working ? "資料工作表" : "台股觀測站｜價格、產業與估值";
    document.querySelector(".brand-txt").textContent = working ? "資料工作表" : "台股觀測站";
    document.querySelector(".brand-mark").textContent = working ? "▤" : "TW";
    $("moversSection").open = !working;
  }
  let savedDisplayMode = "work";
  try { savedDisplayMode = localStorage.getItem("tw-display-mode") || "work"; } catch (_) {}
  applyDisplayMode(savedDisplayMode);
  document.querySelectorAll("[data-display-mode]").forEach(button => {
    button.addEventListener("click", () => {
      const mode = button.dataset.displayMode;
      applyDisplayMode(mode);
      try { localStorage.setItem("tw-display-mode", mode); } catch (_) {}
    });
  });

  $("sheetSearch")?.addEventListener("click", () => $("q").focus());
  $("sheetColumns")?.addEventListener("click", () => {
    document.querySelector(".column-picker").scrollIntoView({ block: "center" });
    document.querySelector(".column-chip")?.focus({ preventScroll: true });
  });
  for (const id of ["sheetAnalysis", "sheetAnalysisTab"]) {
    $(id)?.addEventListener("click", () => {
      $("moversSection").open = true;
      $("moversSection").scrollIntoView({ block: "start" });
    });
  }

  // ---------------------------------------------------------------- 頂欄與回頂端
  const topbar = $("topbar");
  const toTop = $("toTop");
  const onScroll = () => {
    const y = window.scrollY;
    topbar.classList.toggle("is-stuck", y > 8);
    toTop.classList.toggle("show", y > 900);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

  // 釘住的篩選列高度會隨換行改變，量出來給表頭的 sticky top 用
  const stockBar = document.querySelector(".stock-bar");
  if (stockBar) {
    const measure = () =>
      document.documentElement.style.setProperty("--stickbar-h", stockBar.offsetHeight + "px");
    measure();
    if (window.ResizeObserver) new ResizeObserver(measure).observe(stockBar);
    else window.addEventListener("resize", measure);
  }

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

  // ---------------------------------------------------------------- 迷你走勢線
  /** 近三年的月本益比，畫成卡片下方的小走勢線。沒有歷史（興櫃）就不畫。 */
  function sparkline(marketKey) {
    const monthly = state.history && state.history.monthly;
    if (!monthly) return "";
    const keys = Object.keys(monthly).sort().slice(-36);
    const pts = keys
      .map((k) => {
        const m = monthly[k] && monthly[k].m && monthly[k].m[marketKey];
        return m && m.pe != null ? [k, m.pe] : null;
      })
      .filter(Boolean);
    if (pts.length < 6) {
      return '<div class="spark spark-empty"><div class="spark-lbl">官方未發布這個板塊的歷史本益比，無走勢可畫。</div></div>';
    }

    const W = 260, H = 40;
    const vals = pts.map((p) => p[1]);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.16;
    lo -= pad; hi += pad;
    const X = (i) => (i * W) / (pts.length - 1);
    const Y = (v) => H - ((v - lo) / (hi - lo)) * H;

    const d = pts.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ");
    const area = `${d} L${W},${H} L0,${H} Z`;
    const gid = `sg-${marketKey}`;
    const first = pts[0][1], last = pts[pts.length - 1][1];
    const diff = last - first;
    const since = pts[0][0];

    return `<div class="spark">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${LABEL[marketKey]}近三年本益比走勢">
        <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${SERIES[marketKey]}" stop-opacity="0.26"/>
          <stop offset="100%" stop-color="${SERIES[marketKey]}" stop-opacity="0"/>
        </linearGradient></defs>
        <path d="${area}" fill="url(#${gid})" stroke="none"/>
        <path d="${d}" stroke="${SERIES[marketKey]}" vector-effect="non-scaling-stroke"/>
      </svg>
      <div class="spark-lbl">本益比走勢 ${since} 起　<span class="${diff >= 0 ? "pos" : "neg"}">${diff >= 0 ? "+" : ""}${diff.toFixed(1)}</span></div>
    </div>`;
  }

  // ---------------------------------------------------------------- 表格欄位
  function revenueNote(r) {
    const rev = r.rev || {}, fallback = state.revenueNotes[r.c];
    const note = Object.prototype.hasOwnProperty.call(rev, "note") ? rev.note
      : fallback && fallback.ym === rev.ym ? fallback.note : null;
    if (note == null) return "";
    const clean = String(note).trim();
    const text = !clean || /^[—–－-]+$/.test(clean) ? "公司未填寫原因" : clean;
    const marketPath = { listed: "sii", otc: "otc", esb: "rotc" }[r.m];
    const source = rev.source && /^https:\/\/(mopsov\.twse\.com\.tw|openapi\.twse\.com\.tw|www\.tpex\.org\.tw)\//.test(rev.source)
      ? rev.source : `https://mopsov.twse.com.tw/nas/t21/${marketPath}/`;
    return `<div class="revenue-note"><span>${esc(text)}</span><small>${esc(rev.ym || "")} · 公司申報原文 <a href="${esc(source)}" target="_blank" rel="noopener noreferrer">官方來源 ↗</a></small></div>`;
  }

  function profitRecord(r) {
    const d = state.profitGrowth.stocks[r.c];
    if (!d || (r.fin && (d.year !== r.fin.y || d.quarter !== r.fin.q))) return null;
    return d;
  }
  function profitCell(r) {
    const d = profitRecord(r);
    if (!d || d.status === "missing") return cell(null);
    const basis = d.basis === "parent" ? "歸屬母公司淨利" : "本期稅後淨利";
    const label = d.yoy == null ? esc(d.status) : cell(d.yoy, 1, true);
    return `<span title="${d.year} Q${d.quarter} 年初至今累計，對比去年同期；${basis}">${label}</span><small class="profit-period">${d.year} Q${d.quarter} 累計</small>`;
  }

  // 業外占比：分母（稅前淨利／營業利益）為正時才有值，來自綜合損益表年初至今累計。
  function nonopCell(r, field, label) {
    const fin = r.fin || {};
    const v = fin[field];
    const period = fin.y ? `${fin.y} Q${fin.q} 累計` : "";
    if (v == null) {
      const why = fin.y ? `${period}：${label}為負或為零、或損益表未提供業外收支，比例不適用` : "尚無財報資料";
      return `<span class="na" title="${esc(why)}">—</span>${period ? `<small class="profit-period">${esc(period)}</small>` : ""}`;
    }
    return `<span title="${esc(period)}；業外收支 ÷ ${esc(label)}">${cell(v, 1, true)}</span><small class="profit-period">${esc(period)}</small>`;
  }
  // 外匯損益占淨利：外幣兌換利益（損失）取自 iXBRL 財報附註，需與損益表同一期別才計算。
  function fxRecord(r) {
    const d = state.fxGains.stocks[r.c], fin = r.fin || {};
    if (!d || d.status !== "ok" || d.fx == null || !fin.y || d.year !== fin.y || d.quarter !== fin.q) return null;
    return d;
  }
  function fxValue(r) {
    const d = fxRecord(r), net = r.fin && r.fin.net;
    if (!d || net == null || net <= 0) return null;
    return Math.round(d.fx / (net * 1000) * 10000) / 100;
  }
  function fxCell(r) {
    const fin = r.fin || {}, d = fxRecord(r), v = fxValue(r);
    const period = fin.y ? `${fin.y} Q${fin.q} 累計` : "";
    const small = period ? `<small class="profit-period">${esc(period)}</small>` : "";
    if (v == null) {
      const raw = state.fxGains.stocks[r.c];
      const why = !fin.y ? "尚無財報資料"
        : d ? "淨利為負或為零，比例不適用"
        : raw && raw.status === "not_disclosed" && raw.year === fin.y && raw.quarter === fin.q ? "財報附註未揭露外幣兌換損益"
        : "財報附註尚未讀取";
      return `<span class="na" title="${esc(why)}">—</span>${small}`;
    }
    return `<span title="${esc(period)}；外幣兌換損益 ${esc(human(d.fx))} ÷ 歸屬母公司淨利">${cell(v, 1, true)}</span>${small}`;
  }

  function operatingAmountCell(r, field, periodField) {
    const d = operatingOf(r.c), value = d[field], period = d[periodField];
    if (value == null) return cell(null);
    return `<span title="${esc(period || "")}">${human(value)}</span><small class="profit-period">${esc(period || "")}</small>`;
  }
  function operatingChangeValue(r, changeField, kind) {
    const d = operatingOf(r.c), change = d[changeField] || {};
    return change[kind] ?? null;
  }
  function operatingChangeCell(r, changeField, kind) {
    return cell(operatingChangeValue(r, changeField, kind), 1, true);
  }

  const COLS = [
    { k: "c", t: "代號", cls: "code", get: (r) => r.c },
    { k: "n", t: "名稱", cls: "name-cell", get: (r) => `${esc(r.n)} <span class="mkt">${LABEL[r.m]}</span>` },
    {
      k: "i", t: "業務標籤", cls: "ind",
      // 有業務標籤就顯示業務標籤；沒有的話退回官方產業別（樣式做區隔，一眼看得出來源不同）
      get: (r) => {
        const ts = tagsOf(r.c);
        if (ts.length) {
          return ts.map((t) => `<button type="button" class="tag${state.tag === t ? " is-active" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`).join(" ");
        }
        return r.i ? `<button type="button" class="tag ind-tag${state.industry === r.i ? " is-active" : ""}" data-ind="${esc(r.i)}">${esc(r.i)}</button>` : '<span class="na">—</span>';
      },
    },
    { k: "p", t: "股價", get: (r) => cell(r.p) },
    { k: "priceReturn", t: "漲跌幅%", get: (r) => cell(returnOf(r.c), 2, true), val: (r) => returnOf(r.c) },
    { k: "insider_transfer", t: "最新轉讓申報", sel: "內部人最新轉讓申報", get: (r) => insiderTransferCell(r.c), val: (r) => insiderTransferValue(r.c) },
    { k: "insider_holding", t: "最新持股增減", sel: "內部人最新持股增減", get: (r) => insiderHoldingCell(r.c), val: (r) => insiderHoldingChange(r.c) },
    { k: "fromLow52", t: "距52週低點%", get: (r) => cell(performanceOf(r.c).fromLow52, 2, true), val: (r) => performanceOf(r.c).fromLow52 },
    { k: "fromHigh52", t: "距52週高點%", get: (r) => cell(performanceOf(r.c).fromHigh52, 2, true), val: (r) => performanceOf(r.c).fromHigh52 },
    { k: "cap", t: "市值", get: (r) => human(r.cap) ?? '<span class="na">—</span>' },
    { k: "pe", t: "本益比", get: (r) => cell(r.pe) },
    { k: "ps", t: "股價營收比", get: (r) => (r.ps == null ? '<span class="na">—</span>' : cell(r.ps) + (r.ps_basis === "估算" ? '<span class="est">估</span>' : "")) },
    { k: "pb", t: "淨值比", get: (r) => cell(r.pb) },
    { k: "dy", t: "殖利率%", get: (r) => cell(r.dy) },
    { k: "rev_yoy", t: "月營收年增%", get: (r) => revenueCell(r, "yoy"), val: (r) => r.rev && r.rev.yoy },
    { k: "rev_note", t: "營收變動說明", cls: "revenue-note-cell", get: revenueNote },
    { k: "rev_cum", t: "累計年增%", get: (r) => revenueCell(r, "cum_yoy"), val: (r) => r.rev && r.rev.cum_yoy },
    { k: "contract", t: "合約負債", sel: "合約負債－流動", get: (r) => operatingAmountCell(r, "contractCurrent", "contractCurrentPeriod"), val: (r) => operatingOf(r.c).contractCurrent ?? null },
    { k: "contract_qoq", t: "合約負債QoQ%", get: (r) => operatingChangeCell(r, "contractCurrentChange", "qoq"), val: (r) => operatingChangeValue(r, "contractCurrentChange", "qoq") },
    { k: "contract_yoy", t: "合約負債YoY%", get: (r) => operatingChangeCell(r, "contractCurrentChange", "yoy"), val: (r) => operatingChangeValue(r, "contractCurrentChange", "yoy") },
    { k: "customer_receipts", t: "客戶暫收款", sel: "客戶暫收款", get: (r) => operatingAmountCell(r, "customerReceiptsTotal", "customerReceiptsPeriod"), val: (r) => operatingOf(r.c).customerReceiptsTotal ?? null },
    { k: "customer_receipts_qoq", t: "客戶暫收款QoQ%", get: (r) => operatingChangeCell(r, "customerReceiptsChange", "qoq"), val: (r) => operatingChangeValue(r, "customerReceiptsChange", "qoq") },
    { k: "customer_receipts_yoy", t: "客戶暫收款YoY%", get: (r) => operatingChangeCell(r, "customerReceiptsChange", "yoy"), val: (r) => operatingChangeValue(r, "customerReceiptsChange", "yoy") },
    { k: "inventory", t: "存貨", get: (r) => operatingAmountCell(r, "inventory", "inventoryPeriod"), val: (r) => operatingOf(r.c).inventory ?? null },
    { k: "inventory_qoq", t: "存貨QoQ%", get: (r) => operatingChangeCell(r, "inventoryChange", "qoq"), val: (r) => operatingChangeValue(r, "inventoryChange", "qoq") },
    { k: "inventory_yoy", t: "存貨YoY%", get: (r) => operatingChangeCell(r, "inventoryChange", "yoy"), val: (r) => operatingChangeValue(r, "inventoryChange", "yoy") },
    { k: "qrev", t: "季營收", sel: "財報期營收", get: (r) => operatingAmountCell(r, "revenue", "revenuePeriod"), val: (r) => operatingOf(r.c).revenue ?? null },
    { k: "qrev_qoq", t: "季營收QoQ%", get: (r) => operatingChangeCell(r, "revenueChange", "qoq"), val: (r) => operatingChangeValue(r, "revenueChange", "qoq") },
    { k: "qrev_yoy", t: "季營收YoY%", get: (r) => operatingChangeCell(r, "revenueChange", "yoy"), val: (r) => operatingChangeValue(r, "revenueChange", "yoy") },
    { k: "net_yoy", t: "淨利年增%", get: profitCell, val: (r) => profitRecord(r)?.yoy ?? null },
    { k: "eps", t: "EPS", get: (r) => cell(r.fin && r.fin.eps), val: (r) => r.fin && r.fin.eps },
    { k: "nonop_pt", t: "業外占稅前淨利%", get: (r) => nonopCell(r, "nonop_pt", "稅前淨利"), val: (r) => r.fin?.nonop_pt ?? null },
    { k: "nonop_op", t: "業外占營業利益%", get: (r) => nonopCell(r, "nonop_op", "營業利益"), val: (r) => r.fin?.nonop_op ?? null },
    { k: "fx_net", t: "外匯損益占淨利%", get: fxCell, val: fxValue },
    // 籌碼面：集保股權分散表，一張 = 1,000 股，所以「400 張以上」= 400,000 股以上
    { k: "big", t: "大戶持股%", sel: "400張以上大戶持股%", get: (r) => cell(tdccOf(r.c)[0]), val: (r) => tdccOf(r.c)[0] },
    { k: "big_chg", t: "月增減", sel: "大戶持股月增減", get: (r) => cell(tdccOf(r.c)[1], 2, true), val: (r) => tdccOf(r.c)[1] },
  ];

  const FIXED_COLUMNS = ["c", "n", "i"];
  const visibleCols = () => [...FIXED_COLUMNS, ...state.selectedColumns].map(k => COLS.find(c => c.k === k));
  const columnLabel = c => c.k === "priceReturn" ? "漲跌幅（可選期間）" : (c.sel || c.t);
  let draggedColumn = null;

  function changeColumn(key, before = null, remove = false) {
    if (FIXED_COLUMNS.includes(key) || !COLS.some(c => c.k === key)) return;
    if (key === before) return;
    const next = state.selectedColumns.filter(k => k !== key);
    if (!remove) {
      const at = next.indexOf(before);
      next.splice(at < 0 ? next.length : at, 0, key);
    }
    state.selectedColumns = next;
    state.sorts = state.sorts.filter(s => FIXED_COLUMNS.includes(s.k) || next.includes(s.k));
    paintHead();
    renderColumnPicker();
    applyFilters();
    $("columnStatus").textContent = `${columnLabel(COLS.find(c => c.k === key))}已${remove ? "移回可選欄位" : "放入表格"}`;
  }

  function bindColumnDrag(el, key) {
    el.addEventListener("dragstart", e => {
      if (e.target.closest("select")) { e.preventDefault(); return; }
      draggedColumn = key;
      e.dataTransfer.setData("text/plain", key);
      e.dataTransfer.effectAllowed = "move";
      document.querySelector(".column-picker")?.classList.add("is-dragging");
    });
    el.addEventListener("dragend", () => {
      draggedColumn = null;
      document.querySelector(".column-picker")?.classList.remove("is-dragging");
      document.querySelectorAll(".drop-active").forEach(n => n.classList.remove("drop-active"));
    });
  }

  function bindColumnDrop(el, remove = false, before = null) {
    if (!el) return;
    el.addEventListener("dragover", e => {
      if (!draggedColumn) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("drop-active");
    });
    el.addEventListener("dragleave", e => {
      if (!el.contains(e.relatedTarget)) el.classList.remove("drop-active");
    });
    el.addEventListener("drop", e => {
      if (!draggedColumn) return;
      e.preventDefault(); e.stopPropagation();
      const key = draggedColumn;
      draggedColumn = null;
      document.querySelectorAll(".drop-active, .is-dragging").forEach(n => n.classList.remove("drop-active", "is-dragging"));
      changeColumn(key, before, remove);
    });
  }

  function renderColumnPicker() {
    const pool = $("columnPool");
    if (!pool) return;
    const available = COLS.filter(c => !FIXED_COLUMNS.includes(c.k) && !state.selectedColumns.includes(c.k));
    pool.innerHTML = available.map(c => `<button type="button" class="column-chip" draggable="true" data-column="${c.k}" aria-label="加入${columnLabel(c)}">＋ ${columnLabel(c)}</button>`).join("") || '<span class="column-empty">所有欄位都已加入；拖曳表頭到此處即可移除</span>';
    pool.querySelectorAll("[data-column]").forEach(el => {
      const key = el.dataset.column;
      bindColumnDrag(el, key);
      el.addEventListener("click", () => {
        changeColumn(key);
        pool.querySelector("[data-column]")?.focus();
      });
    });
  }

  // 手機排序選單只放有意義的數值欄位
  const SORTABLE = ["priceReturn", "insider_transfer", "insider_holding", "fromLow52", "fromHigh52", "cap", "p", "pe", "ps", "pb", "dy", "rev_yoy", "rev_cum",
                    "contract", "contract_qoq", "contract_yoy",
                    "customer_receipts", "customer_receipts_qoq", "customer_receipts_yoy",
                    "inventory", "inventory_qoq", "inventory_yoy",
                    "qrev", "qrev_qoq", "qrev_yoy", "net_yoy", "eps", "nonop_pt", "nonop_op", "fx_net", "big", "big_chg"];

  // ------------------------------------------------------------ 多欄排序
  const DEFAULT_SORTS = [{ k: "cap", dir: -1 }];   // 沒設條件時：市值由大到小
  const MAX_SORTS = 3;
  // 文字欄位第一次點由小到大比較直覺；數值欄位習慣先看大的
  const FIRST_DIR = { c: 1, n: 1, i: 1 };
  const firstDir = (k) => FIRST_DIR[k] || -1;
  const activeSorts = () => (state.sorts.length ? state.sorts : (state.selectedColumns.includes("cap") ? DEFAULT_SORTS : [{ k: "c", dir: 1 }]));

  const valueOf = (r, k) => {
    const col = COLS.find((c) => c.k === k);
    const v = col && col.val ? col.val(r) : r[k];
    return v === undefined ? null : v;
  };

  const HEAD_HINT = `點一次由大到小、再點一次由小到大、第三次移除；最多同時 ${MAX_SORTS} 欄，數字越小越優先`;

  function thHtml(c, columnIndex) {
    const i = state.sorts.findIndex((s) => s.k === c.k);
    const s = i >= 0 ? state.sorts[i] : null;
    const aria = s ? (s.dir > 0 ? "ascending" : "descending") : "none";
    const ind = s
      ? `<span class="sort-ind" aria-hidden="true">${s.dir > 0 ? "↑" : "↓"}<b>${i + 1}</b></span>`
      : "";

    if (c.k === "rev_note") return `<th draggable="true" data-letter="${String.fromCharCode(65 + columnIndex)}" data-k="rev_note" title="公司申報原文；拖曳可移動或移出表格">${c.t}</th>`;
    const tip = c.sel ? `${c.sel}｜${HEAD_HINT}` : HEAD_HINT;
    if (c.k === "priceReturn") return `<th draggable="${!FIXED_COLUMNS.includes(c.k)}" data-letter="${String.fromCharCode(65 + columnIndex)}" data-k="${c.k}" aria-sort="${aria}" title="${HEAD_HINT}">
      <button type="button" class="return-sort" aria-label="排序漲跌幅">${c.t}${ind}</button>
      <select class="return-period" aria-label="選擇漲跌幅期間">${periodOptions()}</select></th>`;
    return `<th draggable="${!FIXED_COLUMNS.includes(c.k)}" data-letter="${String.fromCharCode(65 + columnIndex)}" data-k="${c.k}" aria-sort="${aria}" title="${tip}">${c.t}${ind}</th>`;
  }

  /** 只重畫表頭（排序條件變動時呼叫），innerHTML 會換掉節點所以事件要重綁 */
  function paintHead() {
    const thead = $("thead");
    thead.innerHTML = visibleCols().map(thHtml).join("");
    bindReturnPeriod();
    thead.querySelectorAll("th").forEach(th => {
      th.addEventListener("click", e => {
        if (th.dataset.k !== "rev_note" && !e.target.closest("select")) sortBy(th.dataset.k);
      });
      const key = th.dataset.k;
      if (!FIXED_COLUMNS.includes(key)) {
        bindColumnDrag(th, key);
        bindColumnDrop(th, false, key);
      }
    });
  }

  function bindReturnPeriod() {
    const select = $("thead").querySelector(".return-period");
    if (select) select.addEventListener("change", (e) => {
      changeReturnPeriod(e.target.value);
      $("thead").querySelector(".return-period")?.focus();
    });
  }

  function renderHead() {
    paintHead();

    const sel = $("sortMobile");
    sel.innerHTML = SORTABLE.map((k) => {
      const c = COLS.find((x) => x.k === k);
      const t = c.sel || c.t;
      return `<option value="${k}">${t}　由大到小</option><option value="${k}:asc">${t}　由小到大</option>`;
    }).join("");
    sel.value = DEFAULT_SORTS[0].k;
    // 手機的下拉選單維持單欄排序：選了就取代掉整組條件
    sel.addEventListener("change", (e) => {
      const [k, dir] = e.target.value.split(":");
      state.sorts = [{ k, dir: dir === "asc" ? 1 : -1 }];
      state.shown = 200;
      applyFilters();
      syncSortUI();
    });
  }

  /**
   * 點欄位標題：第一次加入條件、第二次反向、第三次移除。
   * 條件可以同時存在最多 MAX_SORTS 個，箭頭旁的數字就是優先序。
   */
  function sortBy(k) {
    if (!COLS.some((c) => c.k === k)) return;
    const i = state.sorts.findIndex((s) => s.k === k);
    if (i >= 0) {
      const s = state.sorts[i];
      if (s.dir === firstDir(k)) s.dir = -firstDir(k);   // 第二次：反向
      else state.sorts.splice(i, 1);                     // 第三次：移除
    } else {
      if (state.sorts.length >= MAX_SORTS) { toast(`最多同時排序 ${MAX_SORTS} 欄，請先取消一個`); return; }
      state.sorts.push({ k, dir: firstDir(k) });
    }
    state.shown = 200;
    applyFilters();
    syncSortUI();
  }

  /** 還原成預設排序（市值由大到小） */
  function resetSort() {
    if (!state.sorts.length) return;
    state.sorts = [];
    state.shown = 200;
    applyFilters();
    syncSortUI();
  }

  function syncSortUI() {
    paintHead();
    const sel = $("sortMobile");
    const primary = activeSorts()[0];
    if (SORTABLE.includes(primary.k)) {
      sel.value = primary.dir > 0 ? `${primary.k}:asc` : primary.k;
    }
  }

  let toastTimer = null;
  function toast(msg) {
    let el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-on"), 2000);
  }

  // 點到頁面「真正的空白處」才還原預設排序；點表格、控制項、卡片都不算
  const KEEP_SORT = "#tbl, #sortMobile, a, button, input, select, textarea, label," +
    " [role='button'], [role='group'], dialog, .modal, .sheet, .card, .tile," +
    " .stock-cards, .rank, details, summary, .toast";
  // 用捕獲階段判斷：等到冒泡才判斷的話，表格早就重繪了，e.target 已經脫離 DOM，
  // closest() 會一律回傳 null，變成點表頭也被當成「點空白處」。
  document.addEventListener("click", (e) => {
    if (!state.sorts.length) return;
    const t = e.target;
    if (t instanceof Element && (t.closest(KEEP_SORT) || !t.isConnected)) return;
    resetSort();
  }, true);

  // 固定高度的表格捲動區；表頭與左右捲動共用同一個容器。
  const shell = document.querySelector(".table-shell");
  const scroller = document.querySelector(".table-scroll");
  function syncOverflowHint() {
    if (!shell || !scroller || !$("tableScrollHint")) return;
    const max = scroller.scrollWidth - scroller.clientWidth;
    const overflowing = max > 1;
    shell.classList.toggle("has-more", overflowing && max - scroller.scrollLeft > 2);
    $("tablePrev").disabled = !overflowing || scroller.scrollLeft < 2;
    $("tableNext").disabled = !overflowing || max - scroller.scrollLeft < 2;
    $("tableScrollHint").textContent = overflowing
      ? "左右捲動查看其餘欄位；代號與名稱固定在左側"
      : "上下捲動瀏覽股票；表頭固定在表格頂端";
  }
  if (scroller) {
    scroller.addEventListener("scroll", syncOverflowHint, { passive: true });
    window.addEventListener("resize", syncOverflowHint);
    for (const [id, direction] of [["tablePrev", -1], ["tableNext", 1]]) {
      $(id)?.addEventListener("click", () => scroller.scrollBy({
        left: direction * Math.max(200, scroller.clientWidth - 248),
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      }));
    }
  }
  bindColumnDrop($("columnPool"), true);
  bindColumnDrop(scroller);
  // 只有確實放到網頁中、表格外時移除；取消拖曳不影響欄位。
  document.addEventListener("dragover", e => {
    if (!draggedColumn || e.target.closest(".table-scroll")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });
  document.addEventListener("drop", e => {
    if (!draggedColumn || e.target.closest(".table-scroll")) return;
    e.preventDefault();
    const key = draggedColumn;
    draggedColumn = null;
    document.querySelectorAll(".drop-active, .is-dragging").forEach(el => el.classList.remove("drop-active", "is-dragging"));
    changeColumn(key, null, true);
  });


  function applyFilters() {
    const terms = state.q.toLowerCase().split(/\s+/u).filter(Boolean);
    let v = state.rows.filter((r) => {
      if (state.filterMarket && r.m !== state.filterMarket) return false;
      if (state.industry && r.i !== state.industry) return false;
      if (state.tag && !tagsOf(r.c).includes(state.tag)) return false;
      // 空白分隔的條件採 OR；市場、產業與標籤篩選仍同時適用。
      if (terms.length && !terms.some(q => r.c.includes(q) || (r.n || "").toLowerCase().includes(q)
                 || tagsOf(r.c).some((t) => t.toLowerCase().includes(q)))) return false;
      return true;
    });
    // 依序比對每個排序條件，先分出勝負的那個決定順序
    const sorts = activeSorts();
    v.sort((a, b) => {
      for (const s of sorts) {
        const x = valueOf(a, s.k), y = valueOf(b, s.k);
        if (x == null && y == null) continue;
        if (x == null) return 1;        // 無資料一律排最後
        if (y == null) return -1;
        const d = (typeof x === "string" || typeof y === "string")
          ? String(x).localeCompare(String(y), "zh-Hant") * s.dir
          : (x - y) * s.dir;
        if (d) return d;
      }
      return 0;
    });
    state.view = v;
    renderBody();
  }

  /** 手機用：一檔一張卡，重點指標直接攤開，不必左右拖 */
  function stockCard(r) {
    const ts = tagsOf(r.c);
    const tags = ts.length
      ? ts.slice(0, 4).map((t) => `<button type="button" class="tag${state.tag === t ? " is-active" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`).join("")
      : (r.i ? `<button type="button" class="tag ind-tag${state.industry === r.i ? " is-active" : ""}" data-ind="${esc(r.i)}">${esc(r.i)}</button>` : "");
    const metrics = visibleCols().filter(c => !["c", "n", "i", "p", "cap"].includes(c.k))
      .map(c => [c.k === "priceReturn" ? RETURN_PERIODS[state.returnPeriod] + "漲跌幅%" : (c.sel || c.t), c.get(r)]);
    return `<div class="scard" data-c="${r.c}" role="button" tabindex="0">
      <div class="scard-top">
        <div class="scard-id">
          <div class="scard-name"><span class="nm">${esc(r.n)}</span><span class="mkt">${LABEL[r.m]}</span></div>
          <div class="scard-code">${r.c}</div>
        </div>
        <div class="scard-price">
          ${state.selectedColumns.includes("p") ? `<div class="p">${fmt(r.p) ?? "—"}</div>` : ""}
          ${state.selectedColumns.includes("cap") ? `<div class="cap">市值 ${human(r.cap) ?? "—"}</div>` : ""}
        </div>
      </div>
      ${tags ? `<div class="scard-tags">${tags}</div>` : ""}
      <div class="scard-metrics">
        ${metrics.map(([k, v]) => `<div class="m"><div class="mk">${k}</div><div class="mv">${v}</div></div>`).join("")}
      </div>
    </div>`;
  }

  function renderBody() {
    const slice = state.view.slice(0, state.shown);

    $("tbody").innerHTML = slice
      .map((r, rowIndex) => `<tr data-row="${rowIndex + 1}" data-c="${r.c}">${visibleCols().map((c) => `<td data-row="${rowIndex + 1}" class="${c.cls || ""}">${c.get(r) ?? '<span class="na">—</span>'}</td>`).join("")}</tr>`)
      .join("");
    $("cards").innerHTML = slice.map(stockCard).join("");

    const active = state.tag || state.industry;
    $("count").innerHTML = active
      ? `<button type="button" class="clear-filter" id="clearFilter">${esc(active)} ✕</button> ${state.view.length} 檔`
      : `${state.view.length} 檔`;
    const cf = $("clearFilter");
    if (cf) cf.addEventListener("click", () => {
      state.tag = ""; state.industry = ""; $("industry").value = "";
      state.shown = 200; applyFilters();
    });

    $("more").hidden = state.view.length <= state.shown;
    syncOverflowHint();

    // 點標籤是篩選，不是打開個股。再點一次同一個就取消。
    const onPick = (el, code) => (e) => {
      const tag = e.target.closest(".tag");
      if (tag) {
        e.stopPropagation();
        if (tag.dataset.tag !== undefined) {
          state.tag = state.tag === tag.dataset.tag ? "" : tag.dataset.tag;
          state.industry = "";
        } else {
          state.industry = state.industry === tag.dataset.ind ? "" : tag.dataset.ind;
          state.tag = "";
        }
        $("industry").value = state.industry;
        state.shown = 200;
        applyFilters();
        return;
      }
      openStock(code);
    };

    $("tbody").querySelectorAll("tr").forEach((tr) =>
      tr.addEventListener("click", onPick(tr, tr.dataset.c)));

    $("cards").querySelectorAll(".scard").forEach((el) => {
      el.addEventListener("click", onPick(el, el.dataset.c));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openStock(el.dataset.c); }
      });
    });
  }

  // ---------------------------------------------------------------- 個股面板
  const CLOSE_ICON = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5.5 5.5 9 9m0-9-9 9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';

  async function openStock(code) {
    window.openStock = openStock;
    const base = state.rows.find((r) => r.c === code);
    if (!base) return;
    // 個股檔只存歷史；營運先行指標另按需載入，不增加首頁初始下載量。
    const [dRaw, opRaw] = await Promise.all([
      getJSON(`data/stock/${code}.json`, null),
      getJSON(`data/operating/${code}.json`, null),
    ]);
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
      <div class="links">
        <a href="${mopsUrl(base)}" target="_blank" rel="noopener">公開資訊觀測站</a>
        ${chainUrl(base.i) ? `<a href="${chainUrl(base.i)}" target="_blank" rel="noopener">${esc(base.i)}產業鏈說明</a>` : ""}
      </div>
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

    const close = () => {
      ov.remove();
      document.body.style.overflow = "";
      document.removeEventListener("keydown", esc2);
    };
    function esc2(e) { if (e.key === "Escape") close(); }
    ov.querySelector(".close").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    document.addEventListener("keydown", esc2);
    ov.querySelector(".close").focus();

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
  }

  // ---------------------------------------------------------------- 事件
  /** attr = data-* 屬性名，key = state 上的欄位名 */
  function bindSeg(id, attr, key, after) {
    const seg = $(id);
    const buttons = [...seg.querySelectorAll("button")];
    seg.style.setProperty("--n", buttons.length);
    const paint = () => {
      const i = buttons.findIndex((b) => b.getAttribute("aria-pressed") === "true");
      seg.style.setProperty("--i", Math.max(0, i));
    };
    buttons.forEach((b) =>
      b.addEventListener("click", () => {
        buttons.forEach((x) => x.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        paint();
        state[key] = b.dataset[attr];
        after();
      })
    );
    paint();
  }

  // ---------------------------------------------------------------- 漲幅排行
  function renderMovers() {
    const mv = state.movers;
    const note = $("moversNote");
    if (!mv || !mv.periods || !Object.keys(mv.periods).length) {
      note.textContent = "漲幅資料尚未產生 —— 到 GitHub 的 Actions 頁執行一次「每日更新」即可。";
      $("groupBars").innerHTML = "";
      $("rankList").innerHTML = "";
      return;
    }
    const keys = Object.keys(mv.periods);
    if (!mv.periods[state.period]) state.period = keys[0];
    const p = mv.periods[state.period];

    note.innerHTML = `以 <strong>${p.from}</strong> 收盤為基準，比到 <strong>${mv.asOf}</strong>，`
      + `共 ${p.days} 個交易日。`
      + (p.counts.esb ? "" : "<strong>興櫃的中長天期漲幅要等資料累積</strong>——官方沒有整批的興櫃歷史每日行情端點，只能從本站開始逐日收集。");

    // ---- 族群長條 ----
    const gs = (p.groups || []).filter((g) => g.med != null).slice(0, 12);
    const maxAbs = Math.max(...gs.map((g) => Math.abs(g.med)), 1);
    $("groupBars").innerHTML = gs.length
      ? gs.map((g) => {
          const w = (Math.abs(g.med) / maxAbs) * 100;
          const cls = g.med >= 0 ? "up" : "down";
          return `<button type="button" class="grow" data-tag="${esc(g.tag)}" data-w="${w.toFixed(1)}">
            <span class="gname">${esc(g.tag)}</span>
            <span class="gbar"><span class="gfill ${cls}"></span></span>
            <span class="gval ${g.med >= 0 ? "pos" : "neg"}">${g.med > 0 ? "+" : ""}${fmt(g.med, 1)}%</span>
            <span class="gn">${g.n} 檔</span>
          </button>`;
        }).join("")
      : '<p class="note">這個期間還沒有足夠的族群資料。</p>';

    // 下一幀才設寬度，讓長條有一次生長動畫
    requestAnimationFrame(() => {
      $("groupBars").querySelectorAll(".grow").forEach((b) => {
        b.querySelector(".gfill").style.width = b.dataset.w + "%";
      });
    });

    $("groupBars").querySelectorAll(".grow").forEach((b) =>
      b.addEventListener("click", () => {
        state.tag = b.dataset.tag; state.industry = ""; $("industry").value = "";
        state.shown = 200; applyFilters();
        document.getElementById("stocks").scrollIntoView({ behavior: "smooth", block: "start" });
      })
    );

    // ---- 個股排行 ----
    const list = (p.markets && p.markets[state.moverMarket]) || [];
    $("rankTitle").textContent = `${LABEL[state.moverMarket]}漲幅排行`;
    $("rankList").innerHTML = list.length
      ? list.slice(0, 25).map((s) => {
          const ts = (s.t && s.t.length ? s.t : (s.i ? [s.i] : []));
          return `<li data-c="${s.c}">
            <div class="rinfo">
              <div class="rhead"><span class="rc">${s.c}</span><span class="rn">${esc(s.n)}</span></div>
              ${ts.length ? `<div class="rt">${ts.map((t) => `<span class="tag static">${esc(t)}</span>`).join("")}</div>` : ""}
            </div>
            <span class="rr ${s.r >= 0 ? "pos" : "neg"}">${s.r > 0 ? "+" : ""}${fmt(s.r, 1)}%</span>
          </li>`;
        }).join("")
      : `<li class="empty">${LABEL[state.moverMarket]}在這個期間還沒有資料。</li>`;
    $("rankList").querySelectorAll("li[data-c]").forEach((li) =>
      li.addEventListener("click", () => openStock(li.dataset.c))
    );
  }

  function draw() { renderMovers(); }

  // ---------------------------------------------------------------- 啟動
  (async function init() {
    const [meta, market, rows, tags, movers, history, tdcc, performance, revenueNotes, profitGrowth, operating, insider, fxGains] = await Promise.all([
      getJSON("data/meta.json", null),
      getJSON("data/market.json", null),
      getJSON("data/latest.json", []),
      getJSON("data/tags.json", {}),
      getJSON("data/movers.json", null),
      getJSON("data/market_history.json", null),
      getJSON("data/tdcc.json", null),
      getJSON("data/performance.json", null),
      getJSON("data/revenue_notes.json", {}),
      getJSON("data/profit_growth.json", {stocks:{}}),
      getJSON("data/operating_latest.json", {stocks:{}}),
      getJSON("data/insider_flows.json?v=20261017-irb110", {stocks:{}}),
      getJSON("data/fx_gains.json", {stocks:{}}),
    ]);
    state.meta = meta; state.market = market;
    state.revenueNotes = revenueNotes || {};
    state.profitGrowth = profitGrowth || {stocks:{}};
    state.fxGains = fxGains && fxGains.stocks ? fxGains : {stocks:{}};
    state.operating = operating || {stocks:{}};
    state.insider = insider || {stocks:{}};
    state.rows = rows || []; state.tags = tags || {}; state.movers = movers;
    state.history = history;
    if (performance && performance.stocks) state.performance = performance;

    const returnMobile = $("returnPeriodMobile");
    returnMobile.innerHTML = periodOptions();
    returnMobile.addEventListener("change", (e) => changeReturnPeriod(e.target.value));
    if (tdcc && tdcc.d) state.tdcc = tdcc;

    // 更新時間在窄螢幕以 CSS 隱藏，只留資料日期，避免頂欄被截斷
    $("asof").innerHTML = meta && meta.asOf
      ? `${meta.asOf}<span class="asof-more">・快照更新於 ${esc((meta.updatedAt || "").replace("T", " ").slice(0, 16))}</span>`
      : "尚無資料 — 請先在 GitHub Actions 執行一次「每日更新」";

    if (meta) {
      $("coverage").textContent =
        `共 ${meta.total} 檔：有本益比 ${meta.withPE}、有股價營收比 ${meta.withPS}、有月營收 ${meta.withRevenue}、有財報 ${meta.withFinancials}。`;
    }

    const revenueCoverage = $("revenueCoverage");
    if (revenueCoverage) {
      const months = [...new Set(state.rows.map(r => r.rev?.ym).filter(Boolean))].sort();
      revenueCoverage.textContent = `營收資料月份：${months.join("、") || "尚無資料"}。各公司依申報進度更新；快照更新時間不代表最新營收已公告。`;
    }

    const cov = $("tagCoverage");
    if (cov) cov.textContent = String(Object.keys(state.tags).length);

    const tn = $("tdccNote");
    if (tn) {
      tn.textContent = state.tdcc.date
        ? (state.tdcc.base
            ? `目前為 ${state.tdcc.date} 那一週，月增減是與 ${state.tdcc.base} 相比。`
            : `目前為 ${state.tdcc.date} 那一週；月增減要再累積約四週才會有數字。`)
        : "尚未抓取。";
    }

    const inds = [...new Set(state.rows.map((r) => r.i).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hant"));
    $("industry").innerHTML = '<option value="">所有產業</option>' + inds.map((i) => `<option>${esc(i)}</option>`).join("");

    renderHead();
    renderColumnPicker();
    draw();
    applyFilters();

    $("q").addEventListener("input", (e) => { state.q = e.target.value; state.shown = 200; applyFilters(); });
    $("industry").addEventListener("change", (e) => {
      state.industry = e.target.value; state.tag = ""; state.shown = 200; applyFilters();
    });
    $("more").addEventListener("click", () => { state.shown += 300; renderBody(); });
    bindSeg("marketSeg", "market", "filterMarket", () => { state.shown = 200; applyFilters(); });
    bindSeg("periodSeg", "period", "period", renderMovers);
    bindSeg("moverMarketSeg", "mm", "moverMarket", renderMovers);

    // 桌機／手機切換時重畫圖表尺寸
    MOBILE.addEventListener("change", () => draw());
  })();
})();
