/* 訪客紀錄：每次開啟網站呼叫一次 Edge Function record-visit（不需登入）。
 * IP 與國家由伺服器端判斷；這裡只送一個隨機的瀏覽器代號，讓同一個人 30 分鐘內重新整理不重複計算。
 * 未設定 supabase-config.js 時不做任何事。 */
(function () {
  const cfg = window.SUPABASE_CONFIG || {};
  if (!cfg.url || !cfg.anonKey) return;
  let vid = null;
  try {
    vid = localStorage.getItem("tw_visitor_id");
    if (!vid) {
      vid = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
      localStorage.setItem("tw_visitor_id", vid);
    }
  } catch (_) { /* 無痕模式等情況拿不到 localStorage，仍以 IP 記錄 */ }
  const send = () => fetch(cfg.url.replace(/\/$/, "") + "/functions/v1/record-visit", {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json", apikey: cfg.anonKey, Authorization: "Bearer " + cfg.anonKey },
    body: JSON.stringify({ visitor_id: vid, path: location.pathname + location.hash, referrer: document.referrer || null }),
  }).catch(() => {});
  if (document.readyState === "complete") setTimeout(send, 300);
  else window.addEventListener("load", () => setTimeout(send, 300), { once: true });
})();
