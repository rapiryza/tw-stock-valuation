/* 內部人持股月增減、轉讓事前申報與股價歷史圖（支援即時游標十字線、浮動提示與下方當事人看板） */
(() => {
  "use strict";

  const DATA_URL = "data/insider_flows.json?v=20261014-no-board";
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
      .insider-crosshair{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3;pointer-events:none}
      .insider-hit{fill:transparent;cursor:crosshair}
      .insider-price-line{fill:none;stroke:var(--accent);stroke-width:2.2}
      .insider-price-dot{fill:var(--accent)}
      .insider-label{fill:var(--muted);font-size:12px}
      .insider-legend{display:flex;gap:14px;align-items:center;flex-wrap:wrap;color:var(--muted);font-size:.9rem;margin-top:8px}
      .insider-legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:5px;vertical-align:-1px}
      .insider-legend i.buy{background:#ef4444}
      .insider-legend i.sell{background:#16a34a}
      .insider-legend i.transfer{background:rgba(22,163,74,.35);border:1px solid #16a34a;box-sizing:border-box}
      .insider-breakdown-list{margin-top:14px;font-size:.85rem;display:flex;flex-direction:column;gap:6px;border-top:1px dashed var(--line);padding-top:10px}
      .insider-breakdown-head{font-weight:600;color:var(--muted);margin-bottom:4px}
      .insider-breakdown-item{display:flex;align-items:center;gap:8px;padding:3px 0}
      .insider-breakdown-tag{font-size:.75rem;padding:1px 6px;border-radius:3px;font-weight:bold}
      .insider-breakdown-tag.buy{background:rgba(239,68,68,.15);color:#ef4444}
      .insider-breakdown-tag.sell{background:rgba(22,163,74,.15);color:#16a34a}
      .insider-breakdown-tag.neutral{background:rgba(125,125,125,.15);color:var(--muted)}
      .insider-breakdown-tag.info{background:rgba(59,130,246,.15);color:#3b82f6}
      .insider-breakdown-tag.rsu{background:rgba(59,130,246,.15);color:#2563eb;border:1px solid rgba(59,130,246,.35)}
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

  function drawChart(svg, code, cardEl, tipEl) {
    const rec = stock(code);
    const executives = rec?.holding?.executives || [];
    const transfer = (rec?.transfer?.series || [])
      .map(([d, lots, breakdown]) => ({
        d,
        lots: Number(lots || 0),
        breakdown: Array.isArray(breakdown) ? breakdown : [],
      }))
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
    const byHoldingMonth = new Map(holding.map(x => [x.month, x]));
    const priceMap = new Map(prices);

    // 每月持股增減長柱只在該月份最後一個交易日（月底位置）繪製一次，避免日線圖中整個月天天重複出現長柱
    const renderedHoldingMonths = new Set();
    // 找出每個月份在 labels 中最後出現的索引位置
    const monthLastIdx = new Map();
    labels.forEach((d, idx) => {
      const ym = d.slice(0, 7);
      monthLastIdx.set(ym, idx);
    });

    labels.forEach((d, idx) => {
      const x0 = X(idx);
      const ym = d.slice(0, 7);

      // 持股月增減長柱：僅在該月份的代表日（月底日）繪製一支柱子
      if (idx === monthLastIdx.get(ym) && !renderedHoldingMonths.has(ym)) {
        const h = byHoldingMonth.get(ym);
        if (h && h.delta) {
          renderedHoldingMonths.add(ym);
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
          svg.appendChild(rect);
        }
      }

      // 轉讓事前申報長柱：按具體申報日繪製
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
        svg.appendChild(rect);
      }
    });

    const values = labels.map(d => priceMap.get(d)).filter(v => v != null);
    let Yp = () => baseline;
    if (values.length) {
      let lo = Math.min(...values), hi = Math.max(...values);
      if (lo === hi) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.12 || 1;
      lo -= pad; hi += pad;
      Yp = (v) => top + (hi - v) / (hi - lo) * (baseline - top - 18);
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

    // 游標層：十字輔助線與點（仿照歷年本益比）
    const cross = mk("line", { class: "insider-crosshair", y1: M.t, y2: H - M.b, x1: -99, x2: -99 });
    svg.appendChild(cross);
    const dot = mk("circle", { cx: -99, cy: -99, r: 4.5, fill: "var(--accent)" });
    svg.appendChild(dot);
    const hit = mk("rect", { class: "insider-hit", x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b });
    svg.appendChild(hit);

    const hide = () => {
      if (tipEl) tipEl.hidden = true;
      cross.setAttribute("x1", -99);
      cross.setAttribute("x2", -99);
      dot.setAttribute("cx", -99);
      dot.setAttribute("cy", -99);
    };

    const move = (ev) => {
      const box = svg.getBoundingClientRect();
      const cx = ((ev.clientX - box.left) / box.width) * W;
      let idx = Math.round(((cx - M.l) / (W - M.l - M.r)) * (labels.length - 1));
      idx = Math.max(0, Math.min(labels.length - 1, idx));
      const x = X(idx);
      const d = labels[idx];

      cross.setAttribute("x1", x);
      cross.setAttribute("x2", x);

      const pVal = priceMap.get(d);
      if (pVal != null) {
        dot.setAttribute("cx", x);
        dot.setAttribute("cy", Yp(pVal));
      } else {
        dot.setAttribute("cx", -99);
        dot.setAttribute("cy", -99);
      }

      const h = byHolding.get(d) || byHoldingMonth.get(d.slice(0, 7));
      const tr = byTransfer.get(d);

      // 1. 更新圖表浮動 Tooltip (tipEl)
      if (tipEl) {
        const rows = [];
        if (pVal != null) {
          rows.push(`<div class="tt-r"><span><span class="swatch" style="display:inline-block;background:var(--accent);width:8px;height:8px;border-radius:2px;margin-right:4px;"></span> 股價</span><span>${Number(pVal).toFixed(2)} 元</span></div>`);
        }
        if (h && h.delta != null) {
          const deltaColor = h.delta > 0 ? BUY : (h.delta < 0 ? SELL : 'var(--muted)');
          const deltaSign = h.delta > 0 ? '+' : '';
          const deltaIcon = h.delta > 0 ? '▲' : (h.delta < 0 ? '▼' : '━');
          rows.push(`<div class="tt-r"><span style="color:${deltaColor}">${deltaIcon} 持股月增減</span><span style="color:${deltaColor};font-weight:bold;">${deltaSign}${h.delta} 張</span></div>`);
          if (h.breakdown && h.breakdown.length > 0) {
            h.breakdown.slice(0, 4).forEach(b => {
              const isRsu = b.source === 'rsu' || (b.note && b.note.includes('RSU'));
              const rsuBadge = isRsu ? ' <span style="display:inline-block;padding:1px 4px;border-radius:3px;font-size:10px;background:rgba(59,130,246,0.15);color:#2563eb;font-weight:600;">RSU/員工股</span>' : '';
              const bColor = isRsu ? '#2563eb' : (b.delta > 0 ? BUY : (b.delta < 0 ? SELL : 'var(--muted)'));
              const pctStr = (b.pct != null) ? ` (佔原持股 ${b.pct}%)` : '';
              rows.push(`<div class="tt-r" style="font-size:11.5px;color:var(--muted)"><span>• ${b.title || '主管'} ${b.name}${rsuBadge}</span><span style="color:${bColor}">${b.delta > 0 ? '+' : ''}${b.delta} 張${pctStr}</span></div>`);
            });
          }
        }
        if (tr) {
          rows.push(`<div class="tt-r"><span style="color:${SELL}">⚑ 轉讓事前申報</span><span style="color:${SELL}">${tr.lots} 張</span></div>`);
          if (tr.breakdown && tr.breakdown.length > 0) {
            tr.breakdown.slice(0, 3).forEach(b => {
              rows.push(`<div class="tt-r" style="font-size:11.5px;color:var(--muted)"><span>• ${b.title || '內部人'} ${b.name}</span><span style="color:${SELL}">${b.lots} 張</span></div>`);
            });
          }
        }

        if (rows.length) {
          const title = h ? `${d.slice(0, 7)} 持股月報` : d;
          tipEl.innerHTML = `<div class="tt-h">${title}</div>${rows.join("")}`;
          tipEl.hidden = false;
          const wrapBox = tipEl.parentElement.getBoundingClientRect();
          let left = ev.clientX - wrapBox.left + 14;
          if (left + tipEl.offsetWidth > wrapBox.width) left = ev.clientX - wrapBox.left - tipEl.offsetWidth - 14;
          tipEl.style.left = Math.max(0, left) + "px";
          tipEl.style.top = Math.max(0, ev.clientY - wrapBox.top - 10) + "px";
        } else {
          tipEl.hidden = true;
        }
      }
    };

    hit.addEventListener("mousemove", move);
    hit.addEventListener("mouseleave", hide);
    svg.addEventListener("touchmove", (e) => { if (e.touches[0]) move(e.touches[0]); }, { passive: true });
    svg.addEventListener("touchend", hide);

    // 在圖表下方列出所有近期經理人/主管買賣明細清單
    if (cardEl) {
      let listEl = cardEl.querySelector(".insider-breakdown-list");
      if (listEl) listEl.remove();

      const recentItems = [];
      holding.slice(-12).reverse().forEach(h => {
        (h.breakdown || []).forEach(b => {
          recentItems.push({ month: h.month, ...b });
        });
      });

      if (recentItems.length > 0) {
        listEl = document.createElement("div");
        listEl.className = "insider-breakdown-list";
        listEl.innerHTML = `
          <div class="insider-breakdown-head">📋 歷史內部人／經理人個別增減持明細清單：</div>
          ${recentItems.slice(0, 10).map(item => {
            const isRsu = item.source === 'rsu' || (item.note && item.note.includes('RSU'));
            const tagClass = isRsu ? 'rsu' : (item.delta > 0 ? 'buy' : 'sell');
            const tagLabel = isRsu ? 'RSU/員工股' : (item.delta > 0 ? '增持' : '減持');
            const itemColor = isRsu ? '#2563eb' : (item.delta > 0 ? BUY : SELL);
            const pctStr = (item.pct != null)
              ? ` <span class="insider-pct" style="font-weight:normal;color:var(--muted);font-size:.82rem;">(佔原持股 ${item.pct}%)</span>`
              : '';
            return `
              <div class="insider-breakdown-item">
                <span class="insider-breakdown-tag ${tagClass}">${tagLabel}</span>
                <span style="color:var(--muted);">${item.month}</span>
                <span>${item.title || '公司主管'} <strong>${item.name}</strong></span>
                <span class="insider-breakdown-amount" style="color:${itemColor}">
                  ${item.delta > 0 ? '+' : ''}${item.delta} 張${pctStr}
                </span>
              </div>
            `;
          }).join("")}
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
    const latestLots = rec?.holding?.latestLots != null ? Number(rec.holding.latestLots).toLocaleString() : "";
    const mChange = rec?.holding?.monthlyChange;
    const changeTxt = mChange != null ? `，本期增減：${mChange > 0 ? '+' : ''}${mChange} 張` : "";
    const section = document.createElement("div");
    section.className = "insider-panel";
    section.innerHTML = `
      <h4>內部人持股／轉讓申報 vs 股價</h4>
      <p class="insider-panel-note">
        持股月增減是官方持股餘額月報相鄰月份的變化${latestMonth ? `（${latestMonth} 內部人總持股 ${latestLots} 張${changeTxt}）` : ""}；
        轉讓申報是<strong>事前申報</strong>，不代表股票已實際賣出成交。
        紅色向上＝持股增加，綠色向下＝持股減少，半透明綠柱＝轉讓申報。
      </p>
      <div class="card insider-chart-card">
        <div class="chart-wrap">
          <div class="chart-scroll">
            <svg class="insider-chart" role="img" aria-label="內部人持股月增減、轉讓申報與股價歷史圖"></svg>
          </div>
          <div class="tooltip insider-tooltip" hidden></div>
        </div>
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

    const svg = section.querySelector("svg");
    const cardEl = section.querySelector(".insider-chart-card");
    const tipEl = section.querySelector(".insider-tooltip");

    drawChart(svg, code, cardEl, tipEl);
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
