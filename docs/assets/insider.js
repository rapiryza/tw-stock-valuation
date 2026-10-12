/* 內部人持股月增減、轉讓事前申報與股價歷史圖 */
(() => {
  "use strict";

  const DATA_URL = "data/insider_flows.json";
  const PRICES_URL = "data/prices.json";
  const BUY = "#ef4444";
  const SELL = "#16a34a";
  const $ = (id) => document.getElementById(id);

  let flowData = null;
  let priceData = null;
  let loading = null;
  let pending = false;

  function ensureStyle() {
    if ($("insider-flow-style")) return;
    const style = document.createElement("style");
    style.id = "insider-flow-style";
    style.textContent = `
      .insider-panel-note{margin:6px 0 10px;color:var(--muted);font-size:.9rem;line-height:1.55}
      .insider-chart-card{margin-top:12px}
      .insider-chart{display:block;width:100%;min-width:720px;height:auto}
      .insider-axis,.insider-grid{stroke:var(--line);stroke-width:1}
      .insider-grid{opacity:.65}
      .insider-price-line{fill:none;stroke:var(--accent);stroke-width:2.2}
      .insider-price-dot{fill:var(--accent)}
      .insider-label{fill:var(--muted);font-size:12px}
      .insider-legend{display:flex;gap:14px;align-items:center;flex-wrap:wrap;color:var(--muted);font-size:.9rem;margin-top:8px}
      .insider-legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:5px;vertical-align:-1px}
      .insider-legend i.buy{background:#ef4444}
      .insider-legend i.sell{background:#16a34a}
      .insider-legend i.transfer{background:rgba(22,163,74,.35);border:1px solid #16a34a;box-sizing:border-box}
      .insider-breakdown-list{margin-top:12px;font-size:.85rem;display:flex;flex-direction:column;gap:6px;border-top:1px dashed var(--line);padding-top:10px}
      .insider-breakdown-head{font-weight:600;color:var(--muted);margin-bottom:2px}
      .insider-breakdown-item{display:flex;align-items:center;gap:8px;padding:3px 0}
      .insider-breakdown-tag{font-size:.75rem;padding:1px 6px;border-radius:3px;font-weight:bold}
      .insider-breakdown-tag.buy{background:rgba(239,68,68,.15);color:#ef4444}
      .insider-breakdown-tag.sell{background:rgba(22,163,74,.15);color:#16a34a}
      .insider-breakdown-amount{margin-left:auto;font-weight:bold}
    `;
    document.head.appendChild(style);
  }

  async function loadData() {
    if (flowData) return flowData;
    if (!loading) {
      loading = Promise.all([
        fetch(DATA_URL, { cache: "no-cache" }).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(PRICES_URL, { cache: "no-cache" }).then(r => r.ok ? r.json() : null).catch(() => null),
      ]).then(([flows, prices]) => {
        flowData = flows && flows.stocks ? flows : { stocks: {} };
        priceData = prices || { dates: [], p: {} };
        return flowData;
      });
    }
    return loading;
  }

  function stock(code) {
    return flowData?.stocks?.[code] || null;
  }

  function priceSeries(code) {
    const dates = priceData?.dates || [];
    const arr = priceData?.p?.[code] || [];
    return dates.map((d, i) => [d, arr[i]]).filter(([, v]) => v != null).slice(-180);
  }

  function drawChart(svg, code, cardEl) {
    const rec = stock(code);
    const transfer = (rec?.transfer?.series || [])
      .map(([d, lots]) => ({ d, lots: Number(lots || 0) }))
      .filter(x => x.lots > 0)
      .slice(-180);
    const holding = (rec?.holding?.series || [])
      .map(([month, total, delta, breakdown]) => ({
        d: `${month}-01`,
        month,
        total: Number(total || 0),
        delta: delta == null ? null : Number(delta),
        breakdown: Array.isArray(breakdown) ? breakdown : [],
      }))
      .filter(x => x.delta != null)
      .slice(-36);
    const prices = priceSeries(code);

    const labels = [...new Set([
      ...prices.map(p => p[0]),
      ...transfer.map(x => x.d),
      ...holding.map(x => x.d),
    ])].sort().slice(-180);

    const W = 900, H = 310, M = { t: 16, r: 58, b: 34, l: 54 };
    const ns = "http://www.w3.org/2000/svg";
    const mk = (name, attrs = {}) => {
      const el = document.createElementNS(ns, name);
      Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
      return el;
    };

    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = "";
    if (!labels.length || (!transfer.length && !holding.length && !prices.length)) {
      const t = mk("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "insider-label" });
      t.textContent = "尚無內部人資料";
      svg.appendChild(t);
      return;
    }

    const X = (idx) => M.l + (labels.length <= 1 ? 0 : idx * (W - M.l - M.r) / (labels.length - 1));
    const baseline = H - M.b - 76;
    const top = M.t + 10;
    svg.appendChild(mk("line", { x1: M.l, x2: W - M.r, y1: baseline, y2: baseline, class: "insider-axis" }));

    const lotsMax = Math.max(
      1,
      ...transfer.map(x => x.lots),
      ...holding.map(x => Math.abs(x.delta || 0)),
    );
    const barSpace = (W - M.l - M.r) / Math.max(labels.length, 20);
    const barW = Math.max(3, Math.min(12, barSpace * 0.36));

    const byTransfer = new Map(transfer.map(x => [x.d, x]));
    const byHolding = new Map(holding.map(x => [x.d, x]));
    labels.forEach((d, idx) => {
      const x0 = X(idx);
      const h = byHolding.get(d);
      if (h && h.delta) {
        const height = Math.max(2, Math.abs(h.delta) / lotsMax * 68);
        const positive = h.delta > 0;
        const rect = mk("rect", {
          x: x0 - barW - 1,
          y: positive ? baseline - height : baseline,
          width: barW,
          height,
          rx: 2,
          fill: positive ? BUY : SELL,
        });
        let tip = `${h.month} 持股月增減 ${h.delta > 0 ? "+" : ""}${h.delta} 張`;
        if (h.breakdown && h.breakdown.length > 0) {
          const details = h.breakdown
            .filter(b => (positive ? b.delta > 0 : b.delta < 0))
            .map(b => `  • ${b.title || '公司派'} ${b.name}: ${b.delta > 0 ? '+' : ''}${b.delta} 張`)
            .join("\n");
          if (details) tip += `\n明細:\n${details}`;
        }
        rect.appendChild(mk("title")).textContent = tip;
        svg.appendChild(rect);
      }

      const tr = byTransfer.get(d);
      if (tr) {
        const height = Math.max(2, tr.lots / lotsMax * 68);
        const rect = mk("rect", {
          x: x0 + 1,
          y: baseline,
          width: barW,
          height,
          rx: 2,
          fill: SELL,
          "fill-opacity": "0.35",
          stroke: SELL,
          "stroke-width": "1",
        });
        rect.appendChild(mk("title")).textContent =
          `${d} 轉讓事前申報 ${tr.lots} 張（不代表已成交）`;
        svg.appendChild(rect);
      }
    });

    const priceMap = new Map(prices);
    const values = labels.map(d => priceMap.get(d)).filter(v => v != null);
    if (values.length) {
      let lo = Math.min(...values), hi = Math.max(...values);
      if (lo === hi) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.12 || 1;
      lo -= pad; hi += pad;
      const Yp = (v) => top + (hi - v) / (hi - lo) * (baseline - top - 18);
      let connected = false;
      const path = labels.map((d, idx) => {
        const v = priceMap.get(d);
        if (v == null) { connected = false; return ""; }
        const cmd = connected ? "L" : "M";
        connected = true;
        return `${cmd}${X(idx).toFixed(1)},${Yp(v).toFixed(1)}`;
      }).join(" ");
      svg.appendChild(mk("path", { d: path, class: "insider-price-line" }));

      const last = [...labels].reverse().find(d => priceMap.get(d) != null);
      if (last) {
        const idx = labels.indexOf(last), v = priceMap.get(last);
        svg.appendChild(mk("circle", { cx: X(idx), cy: Yp(v), r: 3.5, class: "insider-price-dot" }));
        const t = mk("text", { x: Math.min(W - M.r, X(idx) + 8), y: Yp(v) + 4, class: "insider-label" });
        t.textContent = `股價 ${Number(v).toFixed(2)}`;
        svg.appendChild(t);
      }
    }

    let lastYear = "", lastX = -999;
    labels.forEach((d, idx) => {
      const year = d.slice(0, 4), x = X(idx);
      if (year === lastYear || x - lastX < 60) return;
      lastYear = year; lastX = x;
      const t = mk("text", { x, y: H - 12, "text-anchor": "middle", class: "insider-label" });
      t.textContent = year;
      svg.appendChild(t);
    });

    // 若有高階經理人/董監事個人明細，在圖表卡片下方列出摘要
    if (cardEl) {
      let listEl = cardEl.querySelector(".insider-breakdown-list");
      if (listEl) listEl.remove();

      const recentItems = [];
      holding.slice(-6).reverse().forEach(h => {
        (h.breakdown || []).forEach(b => {
          recentItems.push({ month: h.month, ...b });
        });
      });

      if (recentItems.length > 0) {
        listEl = document.createElement("div");
        listEl.className = "insider-breakdown-list";
        listEl.innerHTML = `
          <div class="insider-breakdown-head">📋 近期公司派與內部人持股異動明細：</div>
          ${recentItems.slice(0, 8).map(item => `
            <div class="insider-breakdown-item">
              <span class="insider-breakdown-tag ${item.delta > 0 ? 'buy' : 'sell'}">${item.delta > 0 ? '增持' : '減持'}</span>
              <span style="color:var(--muted);">${item.month}</span>
              <span>${item.title || '公司派'} <strong>${item.name}</strong></span>
              <span class="insider-breakdown-amount" style="color:${item.delta > 0 ? BUY : SELL}">
                ${item.delta > 0 ? '+' : ''}${item.delta} 張
              </span>
            </div>
          `).join("")}
        `;
        cardEl.appendChild(listEl);
      }
    }
  }

  function panelCode(panel) {
    const h = panel.querySelector(".panel-head h3, h3");
    const m = h && h.textContent.match(/\b\d{4}\b/);
    return m ? m[0] : null;
  }

  function augmentPanel(panel) {
    if (!panel || panel.dataset.insiderDone || !flowData) return;
    const code = panelCode(panel);
    if (!code) return;
    panel.dataset.insiderDone = "1";

    const rec = stock(code);
    const latestMonth = rec?.holding?.latestMonth || "";
    const section = document.createElement("div");
    section.className = "insider-panel";
    section.innerHTML = `
      <h4>內部人持股／轉讓申報 vs 股價</h4>
      <p class="insider-panel-note">
        持股月增減是官方持股餘額月報相鄰月份的變化${latestMonth ? `（最新 ${latestMonth}）` : ""}；
        轉讓申報是<strong>事前申報</strong>，不代表股票已實際賣出成交。
        紅色向上＝持股增加，綠色向下＝持股減少，半透明綠柱＝轉讓申報。
      </p>
      <div class="card insider-chart-card">
        <div class="chart-wrap"><div class="chart-scroll"><svg class="insider-chart" role="img" aria-label="內部人持股月增減、轉讓申報與股價歷史圖"></svg></div></div>
        <div class="insider-legend">
          <span><i style="background:${BUY}"></i>持股增加</span>
          <span><i style="background:${SELL}"></i>持股減少</span>
          <span><i class="transfer"></i>轉讓事前申報</span>
          <span><i style="background:var(--accent)"></i>股價</span>
        </div>
      </div>
    `;
    const before = [...panel.querySelectorAll("h4")].find(h => h.textContent.includes("歷年本益比"));
    if (before) before.before(section);
    else panel.appendChild(section);
    drawChart(section.querySelector("svg"), code, section.querySelector(".insider-chart-card"));
  }

  function sync() {
    if (!flowData) return;
    ensureStyle();
    document.querySelectorAll(".overlay .panel").forEach(augmentPanel);
  }

  function scheduleSync() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      sync();
    });
  }

  loadData().then(scheduleSync);
  new MutationObserver(() => { if (flowData) scheduleSync(); })
    .observe(document.body, { childList: true, subtree: true });
})();
