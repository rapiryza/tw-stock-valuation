/* 今年迄今漲幅前 5% 飆股內部人持股動向統計模組 */
(() => {
  "use strict";

  const STAT_DATA_URL = "data/insider_ytd_stat.json?v=20261014-v4";
  const BUY_COLOR = "#ef4444";
  const SELL_COLOR = "#16a34a";
  const $ = (id) => document.getElementById(id);

  let statData = null;
  let currentTab = "all"; // "all" | "sell" | "buy" | "company"

  function esc(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderTags(tags) {
    if (!tags || !tags.length) return '<span style="color:var(--muted);font-size:12px;">—</span>';
    return `<div class="insider-tags-wrap">${tags.map(t => `<span class="tag static">${esc(t)}</span>`).join("")}</div>`;
  }

  function ensureStyle() {
    if ($("insider-stat-style")) return;
    const style = document.createElement("style");
    style.id = "insider-stat-style";
    style.textContent = `
      .insider-ytd-card {
        margin-top: 18px;
        background: var(--surface, #fff);
        border: 1px solid var(--border, #e5e7eb);
        border-radius: 10px;
        padding: 16px 18px;
        transition: box-shadow .2s ease, border-color .2s ease;
      }
      .insider-ytd-card.highlight-focus {
        border-color: var(--accent, #3b82f6);
        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25);
      }
      .insider-ytd-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 14px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--border, #e5e7eb);
      }
      .insider-ytd-title {
        font-size: 1.05rem;
        font-weight: 700;
        color: var(--fg);
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 4px 0;
      }
      .insider-ytd-pill {
        font-size: .76rem;
        font-weight: 600;
        padding: 2px 7px;
        border-radius: 4px;
        background: rgba(59, 130, 246, 0.12);
        color: var(--accent, #3b82f6);
      }
      .insider-ytd-desc {
        margin: 0;
        color: var(--muted);
        font-size: .84rem;
        line-height: 1.5;
      }
      .insider-kpi-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 12px;
        margin-bottom: 16px;
      }
      .insider-kpi-box {
        background: var(--surface-2, rgba(125,125,125,.06));
        border: 1px solid var(--border, var(--line, #e5e7eb));
        border-radius: 8px;
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .insider-kpi-title {
        font-size: .78rem;
        color: var(--muted);
        font-weight: 600;
      }
      .insider-kpi-val {
        font-size: 1.45rem;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
        line-height: 1.2;
      }
      .insider-kpi-sub {
        font-size: .75rem;
        color: var(--muted);
      }
      .insider-stat-tabs {
        display: flex;
        gap: 6px;
        margin-bottom: 12px;
        flex-wrap: wrap;
      }
      .insider-stat-tab-btn {
        background: var(--surface-2, rgba(125,125,125,.08));
        border: 1px solid var(--border, transparent);
        border-radius: 6px;
        padding: 5px 12px;
        font-size: .82rem;
        font-weight: 600;
        color: var(--muted);
        cursor: pointer;
        transition: all .15s ease;
      }
      .insider-stat-tab-btn:hover {
        color: var(--fg);
        background: var(--surface-2, rgba(125,125,125,.16));
      }
      .insider-stat-tab-btn.active {
        color: var(--fg);
        background: var(--surface, #fff);
        border-color: var(--accent, #3b82f6);
        box-shadow: 0 1px 3px rgba(0,0,0,.08);
      }
      .insider-table-container {
        overflow-x: auto;
        border: 1px solid var(--border, #e5e7eb);
        border-radius: 8px;
      }
      .insider-stat-table {
        width: 100%;
        border-collapse: collapse;
        font-size: .84rem;
        font-variant-numeric: tabular-nums;
      }
      .insider-stat-table th, .insider-stat-table td {
        padding: 9px 12px;
        text-align: left;
        border-bottom: 1px solid var(--border, rgba(125,125,125,.15));
      }
      .insider-stat-table th {
        background: var(--surface-2, rgba(125,125,125,.06));
        color: var(--muted);
        font-weight: 600;
        font-size: .78rem;
        white-space: nowrap;
      }
      .insider-stat-table tbody tr {
        cursor: pointer;
        transition: background .12s ease;
      }
      .insider-stat-table tbody tr:hover {
        background: var(--surface-2, rgba(125,125,125,.08));
      }
      .insider-stat-tag {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 3px;
        font-size: .72rem;
        font-weight: 700;
        white-space: nowrap;
      }
      .insider-stat-tag.buy { background: rgba(239,68,68,.14); color: #ef4444; }
      .insider-stat-tag.sell { background: rgba(22,163,74,.14); color: #16a34a; }
      .insider-stat-tag.flat { background: rgba(125,125,125,.14); color: var(--muted); }
      .insider-stat-tag.rsu { background: rgba(59,130,246,.14); color: #2563eb; border: 1px solid rgba(59,130,246,.35); }
      .insider-pct-strong {
        font-weight: 800;
        font-size: .95rem;
      }
      .insider-tags-wrap {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        max-width: 240px;
      }
      .insider-tags-wrap .tag {
        font-size: 11px;
        padding: 1px 6px;
        border-radius: 3px;
        white-space: nowrap;
      }
    `;
    document.head.appendChild(style);
  }

  async function loadStatData() {
    if (statData) return statData;
    try {
      const res = await fetch(STAT_DATA_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      statData = await res.json();
      return statData;
    } catch (e) {
      console.warn("無法載入飆股內部人統計資料：", e);
      return null;
    }
  }

  function renderCard(data) {
    const cardEl = $("insiderYtdCard");
    if (!cardEl || !data) return;

    const p = data.personStats || {};
    const c = data.companyStats || {};
    const allTxs = data.personTransactions || [];
    const companies = data.topGainersCompanies || [];

    // Filter transactions based on current tab
    let displayList = [];
    if (currentTab === "all") {
      displayList = allTxs;
    } else if (currentTab === "sell") {
      displayList = allTxs.filter(x => x.type === "sell");
    } else if (currentTab === "buy") {
      displayList = allTxs.filter(x => x.type === "buy");
    } else if (currentTab === "rsu") {
      displayList = allTxs.filter(x => x.type === "rsu" || x.source === "rsu");
    }

    const tableHtml = currentTab === "company"
      ? `
        <div class="insider-table-container">
          <table class="insider-stat-table">
            <thead>
              <tr>
                <th>代號</th>
                <th>股票名稱</th>
                <th>業務標籤</th>
                <th style="text-align:right">今年迄今漲幅 (YTD)</th>
                <th style="text-align:right">近3個月內部人淨增減</th>
                <th style="text-align:right">佔總持股比例</th>
                <th>最新總持股</th>
              </tr>
            </thead>
            <tbody>
              ${companies.map(item => `
                <tr data-code="${item.code}">
                  <td><strong>${item.code}</strong></td>
                  <td>${item.stockName}</td>
                  <td>${renderTags(item.tags)}</td>
                  <td style="text-align:right;font-weight:700;color:${BUY_COLOR};">+${Number(item.ytd).toFixed(1)}%</td>
                  <td style="text-align:right;font-weight:600;color:${item.m3 > 0 ? BUY_COLOR : (item.m3 < 0 ? SELL_COLOR : 'var(--muted)')};">
                    ${item.m3 > 0 ? '+' : ''}${item.m3} 張
                  </td>
                  <td style="text-align:right;font-weight:700;color:${item.m3 > 0 ? BUY_COLOR : (item.m3 < 0 ? SELL_COLOR : 'var(--muted)')};">
                    ${item.pct > 0 ? (item.m3 > 0 ? '+' : '-') + item.pct + '%' : '0%'}
                  </td>
                  <td>${Number(item.latestLots).toLocaleString()} 張</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `
      : `
        <div class="insider-table-container">
          <table class="insider-stat-table">
            <thead>
              <tr>
                <th>代號</th>
                <th>股票名稱</th>
                <th>業務標籤</th>
                <th>月份</th>
                <th>身分職稱</th>
                <th>姓名</th>
                <th>類別</th>
                <th style="text-align:right">增減張數</th>
                <th style="text-align:right;background:rgba(59,130,246,.08);color:var(--fg);">佔原持股比例</th>
                <th style="text-align:right">今年迄今漲幅 (YTD)</th>
              </tr>
            </thead>
            <tbody>
              ${displayList.map(tx => {
                const isRsu = tx.type === 'rsu' || tx.source === 'rsu';
                const tagClass = isRsu ? 'rsu' : (tx.type === 'buy' ? 'buy' : 'sell');
                const tagLabel = isRsu ? 'RSU/員工股' : (tx.type === 'buy' ? '增持' : '減持');
                const valColor = isRsu ? '#2563eb' : (tx.type === 'buy' ? BUY_COLOR : SELL_COLOR);
                return `
                <tr data-code="${tx.code}">
                  <td><strong>${tx.code}</strong></td>
                  <td>${tx.stockName}</td>
                  <td>${renderTags(tx.tags)}</td>
                  <td style="color:var(--muted);">${tx.month}</td>
                  <td><span style="color:var(--muted);">${tx.title || '內部人'}</span></td>
                  <td><strong>${tx.name}</strong></td>
                  <td><span class="insider-stat-tag ${tagClass}">${tagLabel}</span></td>
                  <td style="text-align:right;font-weight:600;color:${valColor};">
                    ${tx.delta > 0 ? '+' : ''}${tx.delta} 張
                  </td>
                  <td style="text-align:right;background:rgba(59,130,246,.05);">
                    <span class="insider-pct-strong" style="color:${valColor};">
                      ${tx.pct}%
                    </span>
                  </td>
                  <td style="text-align:right;font-weight:700;color:${BUY_COLOR};">
                    +${Number(tx.ytd).toFixed(1)}%
                  </td>
                </tr>
              `}).join("")}
            </tbody>
          </table>
        </div>
      `;

    cardEl.innerHTML = `
      <div class="insider-ytd-head">
        <div>
          <h3 class="insider-ytd-title">
            <span>🔥 飆股內部人持股動向統計</span>
            <span class="insider-ytd-pill">今年迄今漲幅前 5%</span>
          </h3>
          <p class="insider-ytd-desc">
            全市場評估 <strong>${data.evaluatedCount || 1904}</strong> 檔股票，今年迄今漲幅前 5% 門檻為 <strong>+${data.cutoffReturn}%</strong>（共 <strong>${data.topCount}</strong> 檔飆股）。
            統計其內部人／董監事在<strong>${data.periodDescription}</strong>增減持股數佔自己持有股數之比例中位數。
          </p>
        </div>
      </div>

      <div class="insider-kpi-grid">
        <div class="insider-kpi-box" style="border-left:4px solid ${SELL_COLOR};">
          <div class="insider-kpi-title">減持佔原持股中位數</div>
          <div class="insider-kpi-val" style="color:${SELL_COLOR};">${p.sellMedianPct ?? '--'}%</div>
          <div class="insider-kpi-sub">共 ${p.sellTxCount} 筆個人集中市場實際減持</div>
        </div>
        <div class="insider-kpi-box" style="border-left:4px solid ${BUY_COLOR};">
          <div class="insider-kpi-title">集中增持佔原持股中位數</div>
          <div class="insider-kpi-val" style="color:${BUY_COLOR};">${p.buyMedianPct ?? '--'}%</div>
          <div class="insider-kpi-sub">共 ${p.buyTxCount} 筆個人集中市場實際買進</div>
        </div>
        ${(p.rsuTxCount && p.rsuTxCount > 0) ? `
          <div class="insider-kpi-box" style="border-left:4px solid #2563eb;">
            <div class="insider-kpi-title">員工股/RSU佔原持股中位數</div>
            <div class="insider-kpi-val" style="color:#2563eb;">${p.rsuMedianPct ?? '--'}%</div>
            <div class="insider-kpi-sub">共 ${p.rsuTxCount} 筆主管取得員工股/RSU</div>
          </div>
        ` : ''}
      </div>

      <div class="insider-stat-tabs">
        <button type="button" class="insider-stat-tab-btn ${currentTab === 'all' ? 'active' : ''}" data-tab="all">
          全部個人交易 (${allTxs.length} 筆)
        </button>
        <button type="button" class="insider-stat-tab-btn ${currentTab === 'sell' ? 'active' : ''}" data-tab="sell">
          僅減持 (${allTxs.filter(x => x.type === 'sell').length} 筆)
        </button>
        <button type="button" class="insider-stat-tab-btn ${currentTab === 'buy' ? 'active' : ''}" data-tab="buy">
          集中買進 (${allTxs.filter(x => x.type === 'buy').length} 筆)
        </button>
        ${allTxs.some(x => x.type === 'rsu') ? `
          <button type="button" class="insider-stat-tab-btn ${currentTab === 'rsu' ? 'active' : ''}" data-tab="rsu">
            員工股/RSU (${allTxs.filter(x => x.type === 'rsu').length} 筆)
          </button>
        ` : ''}
        <button type="button" class="insider-stat-tab-btn ${currentTab === 'company' ? 'active' : ''}" data-tab="company">
          ${companies.length} 檔飆股全體內部人持股彙總
        </button>
      </div>

      ${tableHtml}
    `;

    // Hook tab buttons
    cardEl.querySelectorAll(".insider-stat-tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        currentTab = btn.dataset.tab;
        renderCard(data);
      });
    });

    // Hook stock row clicks to open modal
    cardEl.querySelectorAll("tr[data-code]").forEach(tr => {
      tr.addEventListener("click", () => {
        const code = tr.dataset.code;
        if (typeof window.openStock === "function") {
          window.openStock(code);
        }
      });
    });
  }

  function scrollToStatCard() {
    const moversSection = $("moversSection");
    if (moversSection) {
      moversSection.open = true;
    }
    const cardEl = $("insiderYtdCard");
    if (cardEl) {
      cardEl.scrollIntoView({ behavior: "smooth", block: "start" });
      cardEl.classList.add("highlight-focus");
      setTimeout(() => cardEl.classList.remove("highlight-focus"), 1800);
    }
  }

  function setupButtons() {
    const btnIds = ["sheetInsiderStat", "sheetInsiderTab"];
    btnIds.forEach(id => {
      const btn = $(id);
      if (btn) {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          scrollToStatCard();
        });
      }
    });
  }

  async function init() {
    ensureStyle();
    setupButtons();
    const data = await loadStatData();
    if (data) {
      renderCard(data);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
