/* 個股面板：內部人持股（IRB110 總額＋事後申報明細）vs 股價 */
(() => {
  "use strict";

  const DATA_URL = "data/insider_flows.json?v=20261017-irb110";
  const $ = (sel, root = document) => root.querySelector(sel);
  const NS = "http://www.w3.org/2000/svg";

  let flowData = null;
  let loading = null;
  let pending = false;
  const stockCache = new Map();

  // ------------------------------------------------------------ 工具
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtLots = (v, signed = false) => {
    if (v == null || Number.isNaN(v)) return "—";
    const a = Math.abs(v);
    const s = a >= 100 ? Math.round(a).toLocaleString("zh-TW")
      : a.toLocaleString("zh-TW", { maximumFractionDigits: 3 });
    const sign = v > 0 ? (signed ? "+" : "") : v < 0 ? "−" : "";
    return `${sign}${s}`;
  };
  const signCls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
  const lotsHtml = (v, signed = true) =>
    v == null ? '<span class="na">—</span>' : `<span class="${signed ? signCls(v) : ""}">${fmtLots(v, signed)}</span>`;
  const mk = (name, attrs = {}) => {
    const el = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  function ensureStyle() {
    if (document.getElementById("insider-style")) return;
    const style = document.createElement("style");
    style.id = "insider-style";
    style.textContent = `
      .ins-sec .note{margin:6px 0 0}
      .ins-status{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0}
      .ins-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:600;
        background:var(--chip);color:var(--text-secondary);white-space:nowrap}
      .ins-badge.ok{background:var(--down-soft);color:var(--down)}
      .ins-badge.warn{background:var(--up-soft);color:var(--up)}
      .ins-badge.rsu{background:var(--accent-soft);color:var(--accent)}
      .ins-kv .v small{display:block;font-size:11px;font-weight:500;color:var(--muted);letter-spacing:0;margin-top:2px}
      .ins-card{margin-top:12px;padding:14px 14px 10px}
      .ins-card .card-h{display:flex;justify-content:space-between;gap:8px;align-items:baseline;flex-wrap:wrap}
      .ins-card .card-h small{font-weight:500;color:var(--muted);font-size:11.5px}
      svg.ins-chart{display:block;width:100%;height:auto;overflow:visible;touch-action:pan-y}
      svg.ins-chart .tick{fill:var(--muted);font-size:10.5px;font-variant-numeric:tabular-nums}
      svg.ins-chart .grid{stroke:var(--grid);stroke-width:1}
      svg.ins-chart .zero{stroke:var(--axis);stroke-width:1}
      svg.ins-chart .price{fill:none;stroke:var(--text-secondary);stroke-dasharray:4 3;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
      svg.ins-chart .cross{stroke:var(--axis);stroke-width:1;stroke-dasharray:3 4;pointer-events:none}
      svg.ins-chart .hit{fill:transparent;cursor:crosshair}
      .ins-legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:6px;color:var(--muted);font-size:11.5px}
      .ins-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
      .ins-legend i.line{height:2px;width:14px;border-radius:1px;vertical-align:3px}
      .ins-months{margin-top:10px;border-top:1px solid var(--border-soft)}
      .ins-month{border-bottom:1px solid var(--border-soft)}
      .ins-month>summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:5.6em 1fr 1fr 14px;gap:8px;
        align-items:center;padding:9px 2px;font-size:13px;font-variant-numeric:tabular-nums}
      .ins-month>summary::-webkit-details-marker{display:none}
      .ins-month>summary::after{content:"›";color:var(--muted);transition:transform .2s var(--ease)}
      .ins-month[open]>summary::after{transform:rotate(90deg)}
      .ins-month>summary .r{text-align:right}
      .ins-month>summary .m{font-weight:600;white-space:nowrap}
      .ins-head{display:grid;grid-template-columns:5.6em 1fr 1fr 14px;gap:8px;padding:8px 2px 4px;font-size:11px;color:var(--muted)}
      .ins-head .r{text-align:right}
      .ins-body{padding:2px 2px 12px;font-size:12.5px}
      .ins-body h5{margin:8px 0 4px;font-size:11.5px;color:var(--muted);font-weight:600}
      .ins-line{display:flex;justify-content:space-between;gap:10px;padding:3px 0}
      .ins-line span:first-child{color:var(--text-secondary);min-width:0;overflow-wrap:anywhere}
      .ins-line span:last-child{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}
      .ins-line em{font-style:normal;color:var(--muted);font-size:11.5px;margin-left:4px}
      .ins-method{margin-top:12px}
      .ins-method ul{margin:6px 0 0;padding-left:18px;font-size:12.5px;color:var(--text-secondary);line-height:1.6}
      @media (max-width:520px){
        .ins-month>summary,.ins-head{grid-template-columns:5.4em 1fr 1fr 12px}
      }
    `;
    document.head.appendChild(style);
  }

  async function loadData() {
    if (flowData) return flowData;
    if (!loading) {
      loading = fetch(DATA_URL, { cache: "no-cache" })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null)
        .then((d) => (flowData = d && d.stocks ? d : { stocks: {} }));
    }
    return loading;
  }

  async function monthlyPrices(code) {
    if (!stockCache.has(code)) {
      stockCache.set(code, fetch(`data/stock/${code}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    }
    const d = await stockCache.get(code);
    const map = new Map();
    for (const row of (d && d.hist) || []) if (row && row[4] != null) map.set(row[0], Number(row[4]));
    return map;
  }

  // ------------------------------------------------------------ 資料整理
  function months(rec) {
    return (rec?.holding?.series || []).map(([month, total, counted, breakdown, meta]) => ({
      month, total, counted, breakdown: Array.isArray(breakdown) ? breakdown : [], meta: meta || {},
    }));
  }

  // ------------------------------------------------------------ 圖：月增減長條 + 月底股價
  function drawHoldingChart(svg, tip, list, prices) {
    const data = list.slice(-12);
    const W = 640, H = 250, M = { t: 14, r: 48, b: 26, l: 52 };
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = "";
    if (!data.length) {
      const t = mk("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "tick" });
      t.textContent = "尚無 IRB110 月報";
      svg.appendChild(t);
      return;
    }
    const n = data.length;
    const step = (W - M.l - M.r) / n;
    const X = (i) => M.l + step * (i + 0.5);
    const vals = data.map((d) => d.counted).filter((v) => v != null);
    const maxAbs = Math.max(1, ...vals.map(Math.abs));
    const top = M.t, bottom = H - M.b, mid = (top + bottom) / 2;
    const Y = (v) => mid - (v / maxAbs) * (mid - top);

    // 格線與左軸（張）
    for (const v of [maxAbs, maxAbs / 2, 0, -maxAbs / 2, -maxAbs]) {
      const y = Y(v);
      svg.appendChild(mk("line", { x1: M.l, x2: W - M.r, y1: y, y2: y, class: v === 0 ? "zero" : "grid" }));
      const t = mk("text", { x: M.l - 6, y: y + 3.5, "text-anchor": "end", class: "tick" });
      t.textContent = fmtLots(v, true);
      svg.appendChild(t);
    }
    const unit = mk("text", { x: M.l - 6, y: top - 3, "text-anchor": "end", class: "tick" });
    unit.textContent = "張";
    svg.appendChild(unit);

    // 長條：計入增減；沒有明細的月份畫灰色虛框
    const bw = Math.max(4, Math.min(18, step * 0.55));
    data.forEach((d, i) => {
      const x = X(i) - bw / 2;
      if (d.counted == null) return;
      if (d.counted === 0) {
        svg.appendChild(mk("rect", { x, y: mid - 1, width: bw, height: 2, fill: "var(--muted)" }));
        return;
      }
      const y = Y(d.counted);
      const h = Math.max(2, Math.abs(y - mid));
      svg.appendChild(mk("rect", { x, y: d.counted > 0 ? mid - h : mid, width: bw, height: h, rx: 2,
        fill: d.counted > 0 ? "var(--up)" : "var(--down)" }));
      if (d.meta.rsu) {
        svg.appendChild(mk("circle", { cx: X(i), cy: (d.counted > 0 ? mid - h : mid + h) + (d.counted > 0 ? -5 : 5), r: 2.5, fill: "var(--accent)" }));
      }
    });

    // 月底股價（右軸）
    const pts = data.map((d, i) => [i, prices.get(d.month)]).filter(([, p]) => p != null);
    let PY = null;
    if (pts.length) {
      let lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
      if (lo === hi) { lo *= 0.95; hi *= 1.05; }
      const pad = (hi - lo) * 0.1;
      lo -= pad; hi += pad;
      PY = (v) => top + (hi - v) / (hi - lo) * (bottom - top);
      const path = pts.map(([i, p], k) => `${k ? "L" : "M"}${X(i).toFixed(1)},${PY(p).toFixed(1)}`).join("");
      svg.appendChild(mk("path", { d: path, class: "price" }));
      for (const v of [hi - pad, (hi + lo) / 2, lo + pad]) {
        const t = mk("text", { x: W - M.r + 6, y: PY(v) + 3.5, class: "tick" });
        t.textContent = v >= 1000 ? Math.round(v).toLocaleString("zh-TW") : v.toFixed(v >= 100 ? 0 : 1);
        svg.appendChild(t);
      }
      const ru = mk("text", { x: W - M.r + 6, y: top - 3, class: "tick" });
      ru.textContent = "元";
      svg.appendChild(ru);
    }

    // X 軸月份
    const every = Math.ceil(n / 8);
    data.forEach((d, i) => {
      if ((n - 1 - i) % every) return;
      const t = mk("text", { x: X(i), y: H - 8, "text-anchor": "middle", class: "tick" });
      t.textContent = i === 0 || d.month.endsWith("-01") ? d.month : d.month.slice(5) + "月";
      svg.appendChild(t);
    });

    // 互動：十字線 + 浮動說明
    const cross = mk("line", { x1: -9, x2: -9, y1: top, y2: bottom, class: "cross" });
    svg.appendChild(cross);
    const hit = mk("rect", { x: M.l, y: top, width: W - M.l - M.r, height: bottom - top, class: "hit" });
    svg.appendChild(hit);
    const show = (ev) => {
      const box = svg.getBoundingClientRect();
      const cx = ((ev.clientX - box.left) / box.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.floor((cx - M.l) / step)));
      const d = data[i];
      cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i));
      const p = prices.get(d.month);
      const rows = [
        ["內部人總持股（IRB110）", `${fmtLots(d.total)} 張`],
      ];
      if (d.counted != null) rows.push(["本月增減", `${fmtLots(d.counted, true)} 張`]);
      if (d.meta.market) rows.push(["　集中市場買賣", `${fmtLots(d.meta.market, true)} 張`]);
      if (d.meta.rsu) rows.push(["　員工股/RSU", `${fmtLots(d.meta.rsu, true)} 張`]);
      if (p != null) rows.push(["月底股價", `${p.toLocaleString("zh-TW")} 元`]);
      tip.innerHTML = `<div class="tt-h">${esc(d.month)}</div>` +
        rows.map(([k, v]) => `<div class="tt-r"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join("");
      tip.hidden = false;
      const wrap = tip.parentElement.getBoundingClientRect();
      let left = ev.clientX - wrap.left + 12;
      if (left + tip.offsetWidth > wrap.width) left = ev.clientX - wrap.left - tip.offsetWidth - 12;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${Math.max(0, ev.clientY - wrap.top - tip.offsetHeight - 10)}px`;
    };
    const hide = () => { tip.hidden = true; cross.setAttribute("x1", -9); cross.setAttribute("x2", -9); };
    hit.addEventListener("pointermove", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", hide);
  }

  // ------------------------------------------------------------ 月份明細
  function personLines(items, kind) {
    return items.map((b) => {
      const tag = kind === "counted"
        ? (b.source === "rsu" ? '<span class="ins-badge rsu">員工股/RSU</span>' : '<em>集中市場</em>')
        : `<em>${esc(b.reason || "")}</em>`;
      const pct = kind === "counted" && b.pct != null ? `<em>占原持股 ${b.pct}%</em>` : "";
      return `<div class="ins-line"><span>${esc(b.title || "")} ${esc(b.name || "")} ${tag}</span><span>${lotsHtml(b.delta)}${pct}</span></div>`;
    }).join("");
  }

  function monthRow(m) {
    const verified = m.meta.verified === true ? '<span class="ins-badge ok">✓ 明細與 IRB110 相符</span>'
      : m.meta.verified === false ? `<span class="ins-badge warn">明細加總 ${fmtLots(m.meta.detailTotal)} 張與 IRB110 不符</span>` : "";
    const counted = m.breakdown.length ? personLines(m.breakdown, "counted") : '<p class="note">本月沒有買賣或員工股取得。</p>';
    const body = `<div class="ins-status">${verified}</div>${counted}`;
    return `<details class="ins-month">
      <summary><span class="m">${esc(m.month)}</span>
        <span class="r">${fmtLots(m.total)}</span>
        <span class="r">${lotsHtml(m.counted)}${m.meta.rsu ? ' <span class="ins-badge rsu" title="含員工股/RSU">RSU</span>' : ""}</span>
      </summary>
      <div class="ins-body">${body}</div>
    </details>`;
  }

  // ------------------------------------------------------------ 面板
  function panelCode(panel) {
    const h = panel.querySelector(".panel-head h3, h3");
    const m = h && h.textContent.match(/(?:^|\D)(\d{4})(?!\d)/);
    return m ? m[1] : null;
  }

  async function augmentPanel(panel) {
    const code = panelCode(panel);
    if (!code || (panel.dataset.insiderCode === code && panel.querySelector(".ins-sec"))) return;
    panel.dataset.insiderCode = code;
    panel.querySelectorAll(".ins-sec").forEach((el) => el.remove());

    const rec = flowData.stocks[code] || {};
    const h = rec.holding || {};
    const list = months(rec);
    const last = list[list.length - 1];

    const statusBadges = [];
    if (h.verified === true) statusBadges.push('<span class="ins-badge ok">✓ 申報明細與 IRB110 逐股相符</span>');
    if (h.verified === false) statusBadges.push('<span class="ins-badge warn">申報明細與 IRB110 不符，請以官方為準</span>');
    if (h.rsu) statusBadges.push(`<span class="ins-badge rsu">含員工股/RSU ${fmtLots(h.rsu, true)} 張</span>`);

    const sec = document.createElement("div");
    sec.className = "ins-sec";
    sec.innerHTML = `
      <h4>內部人持股 vs 股價</h4>
      ${last ? `
      <div class="kv ins-kv">
        <div><div class="k">內部人總持股</div><div class="v">${fmtLots(h.latestLots)}<small>${esc(h.latestMonth)}・IRB110 張</small></div></div>
        <div><div class="k">本月增減</div><div class="v">${lotsHtml(h.monthlyChange)}<small>集中市場買賣＋員工股/RSU</small></div></div>
        <div><div class="k">其中員工股/RSU</div><div class="v">${h.detail ? lotsHtml(h.rsu ?? 0) : '<span class="na">—</span>'}<small>經理人取得</small></div></div>
      </div>
      <div class="ins-status">${statusBadges.join("")}</div>
      <div class="card ins-card">
        <div class="card-h">每月增減與月底股價<small>點選月份看明細</small></div>
        <div class="chart-wrap">
          <svg class="ins-chart ins-hold" role="img" aria-label="內部人每月持股增減與月底股價"></svg>
          <div class="tooltip" hidden></div>
        </div>
        <div class="ins-legend">
          <span><i style="background:var(--up)"></i>增加</span>
          <span><i style="background:var(--down)"></i>減少</span>
          <span><i style="background:var(--accent);border-radius:50%"></i>含員工股/RSU</span>
          <span><i class="line" style="background:var(--text-secondary)"></i>月底股價（虛線）</span>
        </div>
        <div class="ins-head"><span>月份</span><span class="r">總持股（張）</span><span class="r">增減（張）</span><span></span></div>
        <div class="ins-months">${list.filter((m) => m.counted != null).slice(-6).reverse().map(monthRow).join("")}</div>
      </div>` : '<p class="note">IRB110 月報沒有這家公司的內部人持股資料。</p>'}

      <details class="disclosure ins-method">
        <summary>計算方式與資料來源</summary>
        <ul>
          <li><b>總持股</b>只用證交所 IRB110：董事監察人實際持有＋經理人實際持有。不含百分之十以上大股東欄（常與法人董事重複）、法人代表人分戶與保留運用決定權信託。</li>
          <li>同一人兼任多職、同一法人董事派多位代表人，都只算一次。</li>
          <li><b>本月增減</b>只計公開資訊觀測站內部人持股異動事後申報表的集中市場買進−賣出，以及經理人取得的<b>員工股/RSU</b>（明確標示）。</li>
          <li>「選任時持股」與目前持股的差距是任期內累計，不當成單月增減。</li>
        </ul>
      </details>`;

    const before = [...panel.querySelectorAll("h4")].find((x) => x.textContent.includes("歷年本益比"));
    if (before) before.before(sec); else panel.appendChild(sec);

    if (last) {
      const prices = await monthlyPrices(code);
      const card = sec.querySelector(".ins-hold").closest(".chart-wrap");
      drawHoldingChart(sec.querySelector(".ins-hold"), card.querySelector(".tooltip"), list, prices);
    }
  }

  function sync() {
    if (!flowData) return;
    ensureStyle();
    document.querySelectorAll(".overlay .panel").forEach((p) => { augmentPanel(p); });
  }
  function scheduleSync() {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; sync(); }, 0);
  }

  loadData().then(scheduleSync);
  new MutationObserver(() => { if (flowData) scheduleSync(); })
    .observe(document.body, { childList: true, subtree: true });
})();
