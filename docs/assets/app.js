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
    performance: { stocks: {} }, returnPeriod: "d1", revenueNotes: {}, profitGrowth: {stocks:{}}, fxGains: {stocks:{}}, operating: {stocks:{}}, insider: {stocks:{}}, selectedColumns: ["p", "cap", "priceReturn", "pe", "ps", "rev_yoy", "rev_cum", "contract_yoy", "customer_receipts_yoy", "net_yoy", "rev_note"],
    // sorts: [{k, dir}]，最多 3 個，陣列順序就是優先序（索引 0 最優先）
    // 空陣列代表沒設任何條件，套用 DEFAULT_SORTS
    sorts: [], filterMarket: "", industry: "", tag: "", q: "",
    shown: 200, period: "d1", moverMarket: "listed", moverDir: "up", records: null, recordKind: "price_high", recordMarket: "", recordShown: 50, recordSort: null, recordReturn: "d1", recordExtra: ["p", "cap", "ret", "pe", "ps", "rev_yoy", "rev_cum", "contract_yoy", "customer_receipts_yoy", "net_yoy", "rev_note"],
  };

  const tagsOf = (code) => state.tags[code] || [];

  const RETURN_PERIODS = { d1: "1日", w1: "1週", m1: "30天", m3: "3個月", ytd: "今年迄今", y1: "1年", y3: "3年", y5: "5年" };
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

  // ---------------------------------------------------------------- 工具（與個股面板 stock-panel.js 共用）
  const SP = window.StockPanel;
  const { fmt, human, esc, cell, getJSON } = SP.util;

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
    if (v == null) return `<span class="na">—</span>${small}`;
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

  // ---------------------------------------------------------------- 分頁
  // 個股指標為首頁；#movers 漲跌幅排行與族群、#records 創新高與新低榜
  const PAGES = { stocks: "stocks", movers: "moversSection", records: "recordsSection" };
  function showPage() {
    const key = location.hash.slice(1);
    const page = key === "movers" || key === "records" ? key : "stocks";
    for (const [name, id] of Object.entries(PAGES)) $(id).hidden = name !== page;
    document.querySelectorAll(".page-tabs a[data-page]").forEach((a) => {
      if (a.dataset.page === page) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    if (page === "records") loadRecords();
    if (page === "movers") renderMovers();
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", showPage);

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
  // 外匯損益占淨利：計算在 stock-panel.js，與面板同一份 fx_gains（init 時以 setData 交給面板）
  const fxRecord = (r) => SP.fxRecord(r);
  const fxValue = (r) => SP.fxValue(r);
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

  // ---------------------------------------------------------------- 個股面板（stock-panel.js）
  function openStock(code) {
    window.openStock = openStock;
    return SP.open(code, {
      onRecordBadge(kind, close) {
        state.recordKind = kind; state.recordShown = 50; state.recordSort = null;
        if ($("recordKind").options.length > 1) $("recordKind").value = kind;
        close();
        if (location.hash === "#records") renderRecords();
      },
    });
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

  // ---------------------------------------------------------------- 漲跌幅排行
  function renderMovers() {
    const mv = state.movers;
    const note = $("moversNote");
    if (!mv || !mv.periods || !Object.keys(mv.periods).length) {
      note.textContent = "漲跌幅資料尚未產生 —— 到 GitHub 的 Actions 頁執行一次「每日更新」即可。";
      $("groupBars").innerHTML = "";
      $("rankList").innerHTML = "";
      return;
    }
    const keys = Object.keys(mv.periods);
    if (!mv.periods[state.period]) state.period = keys[0];
    const p = mv.periods[state.period];
    const down = state.moverDir === "down";
    const word = down ? "跌幅" : "漲幅";
    $("groupTitle").textContent = down ? "最近在跌什麼" : "最近在漲什麼";
    $("groupNote").textContent = down
      ? "依業務標籤分組，取組內漲跌幅中位數由低到高排序。中位數要多數成員一起跌才會低，一檔重挫拉不動。"
      : "依業務標籤分組，取組內漲跌幅中位數由高到低排序。中位數要多數成員一起漲才會高，一檔飆股拉不動。";

    note.innerHTML = `以 <strong>${p.from}</strong> 收盤為基準，比到 <strong>${mv.asOf}</strong>，`
      + `共 ${p.days} 個交易日。`
      + (p.counts.esb ? "" : "<strong>興櫃的中長天期漲跌幅要等資料累積</strong>——官方沒有整批的興櫃歷史每日行情端點，只能從本站開始逐日收集。");

    // ---- 族群長條 ----
    const gs = ((down ? p.groupsDown : p.groups) || []).filter((g) => g.med != null).slice(0, 12);
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
      : `<p class="note">${down && !p.groupsDown ? "跌幅族群要等下一次每日更新產生。" : `這個期間沒有中位數${down ? "下跌" : "上漲"}的族群。`}</p>`;

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
    const src = down ? p.losers : p.markets;
    const list = (src && src[state.moverMarket]) || [];
    $("rankTitle").textContent = `${LABEL[state.moverMarket]}${word}排行`;
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
      : `<li class="empty">${down && !src ? "跌幅排行要等下一次每日更新產生。" : `${LABEL[state.moverMarket]}在這個期間沒有${down ? "下跌" : "上漲"}的個股。`}</li>`;
    $("rankList").querySelectorAll("li[data-c]").forEach((li) =>
      li.addEventListener("click", () => openStock(li.dataset.c))
    );
  }

  // ---------------------------------------------------------------- 創新高／新低榜
  const RECORD_KINDS = SP.RECORD_KINDS;

  async function ensureRecords() {
    if (!state.records) state.records = await SP.ensureRecords();
    return state.records;
  }

  async function loadRecords() {
    if ($("recordKind").options.length > 1) return renderRecords();
    await ensureRecords();
    const sel = $("recordKind");
    sel.innerHTML = Object.entries(RECORD_KINDS).map(([k, [t]]) =>
      `<option value="${k}">${esc(t)}（${(state.records.counts || {})[k] ?? 0}）</option>`).join("");
    sel.value = state.recordKind;
    renderRecords();
  }

  // 各榜單自己的欄位；其後接個股指標的同名欄位（數值與格式一致）
  // 可選欄位：預設不顯示，像個股指標一樣點選或拖入表格才加入
  const RECORD_EXTRA = ["p", "cap", "pe", "ps", "rev_yoy", "rev_cum", "contract_yoy", "customer_receipts_yoy", "net_yoy", "rev_note"];
  const TEXT_KEYS = new Set(["c", "n", "tags", "period", "prevPeriod", "rev_note"]);
  const RECORD_RETURN = Object.entries(RETURN_PERIODS);
  const recordReturnOf = (c) => (performanceOf(c).returns || {})[state.recordReturn] ?? null;
  const noteText = (r) => String((r.rev && r.rev.note) || state.revenueNotes[r.c]?.note || "").trim() || null;

  function recordColumns(kind, unit) {
    const num = (k, t, d = 2, f = null) => ({ k, t, val: (it) => it[k] ?? null,
      get: (it) => it[k] == null ? '<span class="na">—</span>' : esc(f ? f(it[k]) : fmt(it[k], d)) });
    const metric = {
      price_high: "收盤價", price_low: "收盤價", gpm_high: "毛利率%", opm_high: "營業利益率%",
      npm_high: "淨利率%", revenue_high: "單月營收", contract_high: "合約負債",
    }[kind];
    const prevWord = kind === "price_low" ? "前低" : "前高";
    let own;
    if (unit === "ps") {
      own = [num("v", "目前 P/S"), num("q95", "P95 上界"), num("q05", "P5 下界"), num("max", "歷史最高")];
    } else if (unit === "amt") {
      own = [num("v", metric, 0, human), num("prev", prevWord, 0, human),
        { k: "prevPeriod", t: `${prevWord}期別`, val: (it) => it.prevPeriod, get: (it) => esc(it.prevPeriod || "—") }];
    } else if (unit === "pct") {
      own = [num("v", metric), num("prev", `${prevWord}%`),
        { k: "prevPeriod", t: `${prevWord}期別`, val: (it) => it.prevPeriod, get: (it) => esc(it.prevPeriod || "—") }];
    } else {
      own = [num("v", metric), num("prev", prevWord),
        { k: "period", t: `${prevWord}日期`, val: (it) => it.period, get: (it) => esc(it.period || "—") }];
    }
    const extras = RECORD_EXTRA.map((k) => {
      const col = COLS.find((c) => c.k === k);
      if (k === "cap") return { k, t: "市值", extra: true, val: (it) => it.cap ?? null, get: (it) => esc(human(it.cap) ?? "—") };
      return { k, t: col.t, cls: col.cls, extra: true,
        val: (it, r) => (k === "rev_note" ? noteText(r) : valueOf(r, k)),
        get: (it, r) => col.get(r) ?? '<span class="na">—</span>' };
    });
    return [
      { k: "c", t: "代號", val: (it) => it.c, get: (it) => it.c, fixed: true },
      { k: "n", t: "名稱", val: (it) => it.n, fixed: true,
        get: (it) => `${esc(it.n)} <span class="tag static">${LABEL[it.m] || ""}</span>` },
      { k: "tags", t: "業務標籤", cls: "ind",
        val: (it) => (tagsOf(it.c)[0] || it.i || null),
        get: (it) => {
          const ts = tagsOf(it.c);
          return ts.length ? `<div class="rec-tags">${ts.map((t) => `<span class="tag static">${esc(t)}</span>`).join("")}</div>`
            : it.i ? `<span class="tag static ind-tag">${esc(it.i)}</span>` : '<span class="na">—</span>';
        }, fixed: true },
      ...own,
      { k: "ret", t: "漲跌幅%", val: (it) => recordReturnOf(it.c), get: (it) => cell(recordReturnOf(it.c), 2, true),
        head: `<select class="return-period" id="recordReturn" aria-label="選擇漲跌幅期間">${RECORD_RETURN.map(([k, t]) =>
          `<option value="${k}"${state.recordReturn === k ? " selected" : ""}>${t}</option>`).join("")}</select>` },
      ...extras,
    ];
  }

  // 代號、名稱、業務標籤固定；其他欄位預設與個股指標相同，都可拖回可選欄位，或從可選欄位點選、拖入
  function visibleRecordColumns(all) {
    return [
      ...all.filter((c) => c.fixed),
      ...state.recordExtra.map((k) => all.find((c) => c.k === k && !c.fixed)).filter(Boolean),
    ];
  }

  function changeRecordColumn(k, remove = false, before = null) {
    const all = recordColumns(state.recordKind, RECORD_KINDS[state.recordKind][2]);
    const col = all.find((c) => c.k === k);
    if (!col || col.fixed) return;
    const next = state.recordExtra.filter((x) => x !== k);
    if (!remove) {
      const at = before ? next.indexOf(before) : -1;
      next.splice(at < 0 ? next.length : at, 0, k);
    }
    state.recordExtra = next;
    renderRecords();
  }

  function renderRecordPicker(all, shown) {
    const pool = $("recordPool");
    const on = new Set(shown.map((c) => c.k));
    const avail = all.filter((c) => !c.fixed && !on.has(c.k));
    pool.innerHTML = avail.map((c) =>
      `<button type="button" class="column-chip" draggable="true" data-rec-col="${c.k}" aria-label="加入${esc(c.t)}">＋ ${esc(c.t)}</button>`).join("")
      || '<span class="column-empty">所有欄位都已加入；拖曳表頭到此處即可移除</span>';
    pool.querySelectorAll("[data-rec-col]").forEach((el) => {
      el.addEventListener("click", () => changeRecordColumn(el.dataset.recCol));
      el.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", "rec:" + el.dataset.recCol));
    });
  }

  function bindRecordDrop() {
    const keyOf = (e) => { const v = e.dataTransfer.getData("text/plain"); return v.startsWith("rec:") ? v.slice(4) : null; };
    const pool = $("recordPool"), table = document.querySelector("#recordsSection .table-scroll");
    for (const el of [pool, table]) el.addEventListener("dragover", (e) => e.preventDefault());
    pool.addEventListener("drop", (e) => { e.preventDefault(); const k = keyOf(e); if (k) changeRecordColumn(k, true); });
    table.addEventListener("drop", (e) => {
      e.preventDefault();
      const k = keyOf(e); if (!k) return;
      const th = e.target.closest("th.rec-extra");
      changeRecordColumn(k, false, th && th.dataset.k !== k ? th.dataset.k : null);
    });
  }

  function sortRecordsBy(k) {
    const cur = state.recordSort;
    const first = TEXT_KEYS.has(k) ? 1 : -1;
    if (!cur || cur.k !== k) state.recordSort = { k, dir: first };
    else if (cur.dir === first) state.recordSort = { k, dir: -first };
    else state.recordSort = null;
    state.recordShown = 50;
    renderRecords();
  }

  function renderRecords() {
    const rec = state.records;
    if (!rec) return;
    const [title, rule, unit] = RECORD_KINDS[state.recordKind];
    const a = rec.asOf || {};
    $("recordsNote").textContent = `股價 ${a.price || "—"}、月營收 ${a.revenue || "—"}、財報 ${a.quarter || "—"}、合約負債 ${a.contract || "—"}。點欄位標題排序：第一次由大到小、再點一次由小到大、第三次回到市值排序。`;
    if (!state.rowByCode || state.rowByCode.size !== state.rows.length) state.rowByCode = new Map(state.rows.map((r) => [r.c, r]));
    const allCols = recordColumns(state.recordKind, unit);
    const cols = visibleRecordColumns(allCols);
    if (state.recordSort && !cols.some((c) => c.k === state.recordSort.k)) state.recordSort = null;
    const sort = state.recordSort || { k: "cap", dir: -1 };
    const col = cols.find((c) => c.k === sort.k) || { val: (it) => it.cap ?? null };
    renderRecordPicker(allCols, cols);
    const rowOf = (c) => state.rowByCode.get(c) || { c, rev: {} };
    const list = ((rec.lists || {})[state.recordKind] || [])
      .filter((it) => !state.recordMarket || it.m === state.recordMarket)
      .map((it) => ({ it, r: rowOf(it.c), key: col.val(it, rowOf(it.c)) }));
    list.sort((x, y) => {
      if (x.key == null && y.key == null) return 0;
      if (x.key == null) return 1;
      if (y.key == null) return -1;
      return (typeof x.key === "string" || typeof y.key === "string")
        ? String(x.key).localeCompare(String(y.key), "zh-Hant") * sort.dir
        : (x.key - y.key) * sort.dir;
    });
    $("recordTitle").textContent = `${title}（${list.length} 檔）`;
    $("recordRule").textContent = rule;
    $("recordHead").innerHTML = cols.map((c) => {
      const on = state.recordSort && state.recordSort.k === c.k;
      const aria = on ? (state.recordSort.dir > 0 ? "ascending" : "descending") : "none";
      const ind = on ? `<span class="sort-ind" aria-hidden="true">${state.recordSort.dir > 0 ? "↑" : "↓"}</span>` : "";
      return `<th data-k="${c.k}" aria-sort="${aria}"${c.fixed ? "" : ' draggable="true" class="rec-extra"'} title="點一次由大到小、再點一次由小到大、第三次回到市值排序${c.fixed ? "" : "；拖回可選欄位即可移除"}">${esc(c.t)}${ind}${c.head ? `<br>${c.head}` : ""}</th>`;
    }).join("");
    $("recordBody").innerHTML = list.length
      ? list.slice(0, state.recordShown).map(({ it, r }) =>
          `<tr data-c="${it.c}">${cols.map((c) => `<td class="${c.cls || ""}">${c.get(it, r)}</td>`).join("")}</tr>`).join("")
      : `<tr><td colspan="${cols.length}" class="na" style="text-align:left">目前沒有符合的個股。</td></tr>`;
    $("recordMore").style.display = list.length > state.recordShown ? "" : "none";
    $("recordHead").querySelectorAll("th").forEach((th) => th.addEventListener("click", (e) => {
      if (!e.target.closest("select")) sortRecordsBy(th.dataset.k);
    }));
    $("recordReturn")?.addEventListener("change", (e) => { state.recordReturn = e.target.value; renderRecords(); });
    $("recordHead").querySelectorAll("th.rec-extra").forEach((th) => th.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", "rec:" + th.dataset.k);
    }));
    $("recordBody").querySelectorAll("tr[data-c]").forEach((tr) =>
      tr.addEventListener("click", (e) => { if (!e.target.closest("a")) openStock(tr.dataset.c); }));
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
    SP.setData({ rows: state.rows, tags: state.tags, fxGains: state.fxGains });

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
    bindSeg("moverDirSeg", "dir", "moverDir", renderMovers);
    bindSeg("recordMarketSeg", "rm", "recordMarket", () => { state.recordShown = 50; renderRecords(); });
    $("recordKind").addEventListener("change", (e) => { state.recordKind = e.target.value; state.recordShown = 50; state.recordSort = null; renderRecords(); });
    $("recordMore").addEventListener("click", () => { state.recordShown += 100; renderRecords(); });
    bindRecordDrop();
    showPage();

    // 其他頁（例如三率篩選）以 index.html?stock=代號 連過來時，直接打開該股詳細面板
    const deepLink = new URLSearchParams(location.search).get("stock");
    if (deepLink && state.rows.some((r) => r.c === deepLink)) openStock(deepLink);

    // 桌機／手機切換時重畫圖表尺寸
    MOBILE.addEventListener("change", () => draw());
  })();
})();
