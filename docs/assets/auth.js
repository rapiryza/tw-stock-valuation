/* 會員登入（Supabase Auth）：頂欄登入按鈕、登入／註冊視窗；登入成功後記錄一次登入（IP 與地點由伺服器端解析）。
 * 未設定 supabase-config.js 時整個功能隱藏，網站其他部分照常運作。 */
(function () {
  const cfg = window.SUPABASE_CONFIG || {};
  if (!cfg.url || !cfg.anonKey || !window.supabase) return;
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey);
  window.twAuth = sb;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const style = document.createElement("style");
  style.textContent = `
    .auth-btn{font:inherit;font-size:13px;font-weight:600;border:1px solid var(--border);background:var(--surface-1);color:var(--text-primary);
      border-radius:999px;padding:6px 14px;cursor:pointer;margin-left:auto;white-space:nowrap}
    .auth-btn:hover{border-color:var(--accent);color:var(--accent)}
    .auth-menu{position:relative;margin-left:auto}
    .auth-pop{position:absolute;right:0;top:calc(100% + 8px);min-width:200px;background:var(--surface-1);border:1px solid var(--border);
      border-radius:12px;padding:8px;box-shadow:var(--shadow-2);z-index:80}
    .auth-pop a,.auth-pop button{display:block;width:100%;text-align:left;font:inherit;font-size:13.5px;padding:8px 10px;border:0;background:none;
      color:var(--text-primary);border-radius:8px;cursor:pointer;text-decoration:none}
    .auth-pop a:hover,.auth-pop button:hover{background:var(--surface-2)}
    .auth-pop .who{font-size:12px;color:var(--muted);padding:6px 10px 8px;border-bottom:1px solid var(--border-soft);margin-bottom:4px;word-break:break-all}
    .auth-dialog{border:0;border-radius:16px;padding:0;width:min(380px,92vw);background:var(--surface-1);color:var(--text-primary)}
    .auth-dialog::backdrop{background:rgba(0,0,0,.4)}
    .auth-form{display:flex;flex-direction:column;gap:12px;padding:22px}
    .auth-form h3{margin:0;font-size:18px}
    .auth-form label{display:flex;flex-direction:column;gap:5px;font-size:13px;color:var(--text-secondary)}
    .auth-form input{font:inherit;font-size:15px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface-1);color:var(--text-primary)}
    .auth-form .primary{font:inherit;font-weight:700;padding:11px;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}
    .auth-form .link{font:inherit;font-size:13px;border:0;background:none;color:var(--accent);cursor:pointer;padding:0;align-self:flex-start}
    .auth-form .msg{font-size:13px;min-height:1.2em;color:var(--down)}
    .auth-form .msg.ok{color:var(--accent)}
    .auth-form .privacy{font-size:11.5px;color:var(--muted);line-height:1.6}
    .auth-form .row{display:flex;justify-content:space-between;align-items:center}
  `;
  document.head.appendChild(style);

  const slot = document.querySelector(".topbar-in");
  const holder = document.createElement("div");
  holder.className = "auth-menu";
  slot.insertBefore(holder, document.getElementById("themeToggle") || null);

  const dialog = document.createElement("dialog");
  dialog.className = "auth-dialog";
  dialog.innerHTML = `<form class="auth-form" method="dialog">
    <div class="row"><h3 id="authTitle">登入</h3><button type="button" class="link" id="authClose" aria-label="關閉">關閉</button></div>
    <label>Email<input type="email" id="authEmail" autocomplete="email" required></label>
    <label>密碼<input type="password" id="authPassword" autocomplete="current-password" minlength="6" required></label>
    <button type="submit" class="primary" id="authSubmit">登入</button>
    <div class="msg" id="authMsg" role="status"></div>
    <button type="button" class="link" id="authSwitch">還沒有帳號？註冊</button>
    <p class="privacy">登入時會記錄登入時間、IP 位址與其對應的大略地點（國家／城市），只用於帳號安全稽核與使用統計。</p>
  </form>`;
  document.body.appendChild(dialog);
  let mode = "in";
  const $ = (id) => document.getElementById(id);
  const setMode = (m) => {
    mode = m;
    $("authTitle").textContent = m === "in" ? "登入" : "註冊";
    $("authSubmit").textContent = m === "in" ? "登入" : "註冊";
    $("authSwitch").textContent = m === "in" ? "還沒有帳號？註冊" : "已有帳號？登入";
    $("authPassword").autocomplete = m === "in" ? "current-password" : "new-password";
    $("authMsg").textContent = "";
  };
  $("authSwitch").addEventListener("click", () => setMode(mode === "in" ? "up" : "in"));
  $("authClose").addEventListener("click", () => dialog.close());

  async function recordLogin() {
    try { await sb.functions.invoke("record-login", { method: "POST", body: {} }); } catch (_) { /* 記錄失敗不影響登入 */ }
  }

  dialog.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("authEmail").value.trim(), password = $("authPassword").value;
    const msg = $("authMsg");
    msg.className = "msg"; msg.textContent = "處理中…";
    if (mode === "up") {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) { msg.textContent = error.message; return; }
      if (data.session) { await recordLogin(); dialog.close(); return; }
      msg.className = "msg ok"; msg.textContent = "已寄出驗證信，請到信箱點連結完成註冊後再登入。";
      return;
    }
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) { msg.textContent = error.message === "Invalid login credentials" ? "Email 或密碼錯誤" : error.message; return; }
    await recordLogin();
    dialog.close();
  });

  async function render(session) {
    if (!session) {
      holder.innerHTML = `<button type="button" class="auth-btn">登入</button>`;
      holder.querySelector("button").addEventListener("click", () => { setMode("in"); dialog.showModal(); });
      return;
    }
    let isAdmin = false;
    try { const { data } = await sb.rpc("is_login_admin"); isAdmin = !!data; } catch (_) {}
    holder.innerHTML = `<button type="button" class="auth-btn" aria-haspopup="true">${esc(session.user.email.split("@")[0])} ▾</button>
      <div class="auth-pop" hidden><div class="who">${esc(session.user.email)}</div>
      ${isAdmin ? '<a href="admin.html">訪客分析後台</a>' : ""}<button type="button" data-out>登出</button></div>`;
    const pop = holder.querySelector(".auth-pop");
    holder.querySelector(".auth-btn").addEventListener("click", (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; });
    document.addEventListener("click", () => { pop.hidden = true; });
    holder.querySelector("[data-out]").addEventListener("click", () => sb.auth.signOut());
  }

  sb.auth.getSession().then(({ data }) => render(data.session));
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") render(session);
  });
})();
