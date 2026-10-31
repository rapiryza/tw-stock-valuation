/* 隱藏客戶暫收款相關欄位與面板項目（個股表與個股面板共用） */
(() => {
  const label = "\u5ba2\u6236\u66ab\u6536\u6b3e";
  const hiddenKeys = new Set(["customer_receipts", "customer_receipts_qoq", "customer_receipts_yoy"]);
  function ensureStyle() {
    let style = document.getElementById("customer-receipts-rerender-hide");
    if (!style) {
      style = document.createElement("style");
      style.id = "customer-receipts-rerender-hide";
      document.head.appendChild(style);
    }
    return style;
  }
  function hideTableColumn() {
    const table = document.getElementById("tbl");
    if (!table) return;
    const indexes = [...table.querySelectorAll("thead th")]
      .map((th, index) => ({ th, index }))
      .filter(({ th }) => hiddenKeys.has(th.dataset.k) || th.textContent.includes(label))
      .map(({ index }) => index);
    if (indexes.length) table.dataset.hiddenReceiptIndexes = indexes.join(",");
    const finalIndexes = (table.dataset.hiddenReceiptIndexes || "").split(",").filter(Boolean).map(Number);
    ensureStyle().textContent = finalIndexes.map((i) => `#tbl th:nth-child(${i + 1}),#tbl td:nth-child(${i + 1}){display:none!important}`).join("\n");
  }
  function clean(root = document) {
    hideTableColumn();
    root.querySelectorAll(".column-chip,#sortMobile option,#opMetric option,.scard-metrics .m,.op-summary .op-kpi").forEach((el) => {
      const key = el.dataset?.column || el.value || "";
      if (hiddenKeys.has(key) || key === "customerReceiptsTotal" || key === "contractAndReceipts" || el.textContent.includes(label)) el.remove();
    });
  }
  new MutationObserver(() => clean()).observe(document.body, { childList: true, subtree: true });
  clean();
})();
