/* 登入分析與審計後台：登入地點（列表＋地圖）、登入頻率、IP 排除名單。
 * 資料權限由 Supabase RLS 控制：只有 login_admins 內的帳號讀得到。 */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const gate = $("admGate"), app = $("admApp");
  const cfg = window.SUPABASE_CONFIG || {};
  if (!cfg.url || !cfg.anonKey) {
    gate.innerHTML = "尚未設定 Supabase。請在 <code>docs/assets/supabase-config.js</code> 填入 Project URL 與 anon key。";
    return;
  }
  const sb = window.twAuth || window.supabase.createClient(cfg.url, cfg.anonKey);
  const state = { events: [], map: null, layer: null, tab: "events" };

  const fmtTime = (t) => t ? new Date(t).toLocaleString("zh-TW", { hour12: false }) : "—";
  const fmtGap = (sec) => {
    if (sec == null) return "—";
    const d = sec / 86400;
    if (d >= 1) return `${d.toFixed(1)} 天`;
    const h = sec / 3600;
    if (h >= 1) return `${h.toFixed(1)} 小時`;
    return `${Math.max(1, Math.round(sec / 60))} 分鐘`;
  };
  const device = (ua) => {
    if (!ua) return "—";
    const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
    const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
    return [br, os].filter(Boolean).join(" / ") || "其他";
  };

  function range() {
    const p = $("admPeriod").value;
    if (p === "custom") {
      const from = $("admFrom").value, to = $("admTo").value;
      if (!from || !to) return null;
      return [new Date(from + "T00:00:00"), new Date(new Date(to + "T00:00:00").getTime() + 86400000)];
    }
    const to = new Date();
    return [new Date(to.getTime() - Number(p) * 86400000), to];
  }

  // ---------------------------------------------------------------- 1. 登入紀錄與地點
  async function loadEvents() {
    const r = range(); if (!r) return;
    $("admEventsMsg").textContent = "載入中…";
    let q = sb.from("login_events_v").select("*").gte("created_at", r[0].toISOString()).lt("created_at", r[1].toISOString())
      .order("created_at", { ascending: false }).limit(2000);
    const email = $("admEmail").value.trim();
    if (email) q = q.ilike("email", `%${email}%`);
    if (!$("admShowEx").checked) q = q.eq("excluded", false);
    const { data, error } = await q;
    if (error) { $("admEventsMsg").textContent = error.message; return; }
    state.events = data || [];
    renderEvents();
  }

  function renderEvents() {
    const ev = state.events;
    const counted = ev.filter((e) => !e.excluded);
    const users = new Set(counted.map((e) => e.user_id)).size;
    const countries = new Set(counted.map((e) => e.country).filter(Boolean)).size;
    const ips = new Set(counted.map((e) => e.ip)).size;
    $("admKpis").innerHTML = [["登入次數（不含排除 IP）", counted.length], ["使用者數", users], ["不同 IP", ips], ["國家數", countries]]
      .map(([k, v]) => `<div class="adm-kpi"><div class="k">${k}</div><div class="v">${v.toLocaleString()}</div></div>`).join("");
    $("admEvents").innerHTML = ev.map((e) => `<tr>
        <td>${esc(fmtTime(e.created_at))}</td>
        <td>${esc(e.email || e.user_id)}</td>
        <td><code>${esc(e.ip)}</code>${e.excluded ? ' <span class="adm-badge">已排除</span>' : ""}</td>
        <td>${esc(e.country || "—")}</td>
        <td>${esc([e.city, e.region].filter(Boolean).join("，") || "—")}</td>
        <td class="adm-ua" title="${esc(e.user_agent)}">${esc(device(e.user_agent))}</td>
        <td>${e.excluded ? "" : `<button type="button" class="adm-btn" data-ex="${esc(e.ip)}">排除此 IP</button>`}</td>
      </tr>`).join("") || '<tr><td colspan="7">這段期間沒有登入紀錄。</td></tr>';
    $("admEventsMsg").textContent = ev.length >= 2000 ? "只顯示最近 2,000 筆；縮短期間或篩選使用者可看更早的紀錄。" : "";
    $("admEvents").querySelectorAll("[data-ex]").forEach((b) => b.addEventListener("click", () => {
      $("admExIp").value = b.dataset.ex; showTab("exclusions"); $("admExNote").focus();
    }));
    renderMap(counted.length ? counted : []);
  }

  function renderMap(ev) {
    if (!window.L) return;
    if (!state.map) {
      state.map = L.map("admMap", { worldCopyJump: true }).setView([23.7, 121], 3);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 12, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(state.map);
    }
    if (state.layer) state.layer.remove();
    const spots = new Map();
    for (const e of ev) {
      if (e.lat == null || e.lon == null) continue;
      const key = `${e.lat.toFixed(2)},${e.lon.toFixed(2)}`;
      const s = spots.get(key) || { lat: e.lat, lon: e.lon, label: [e.city, e.country].filter(Boolean).join("，"), n: 0, users: new Set() };
      s.n += 1; s.users.add(e.email || e.user_id); spots.set(key, s);
    }
    state.layer = L.layerGroup(
      [...spots.values()].map((s) => L.circleMarker([s.lat, s.lon], {
        radius: Math.min(26, 5 + Math.sqrt(s.n) * 3), color: "#087f8c", weight: 1.5, fillOpacity: 0.35,
      }).bindPopup(`<b>${esc(s.label || "未知地點")}</b><br>${s.n} 次登入・${s.users.size} 位使用者`))
    ).addTo(state.map);
    const pts = [...spots.values()].map((s) => [s.lat, s.lon]);
    if (pts.length) state.map.fitBounds(pts, { padding: [30, 30], maxZoom: 6 });
    setTimeout(() => state.map.invalidateSize(), 50);
  }

  // ---------------------------------------------------------------- 2. 登入頻率
  async function loadFrequency() {
    const r = range(); if (!r) return;
    $("admFreqMsg").textContent = "計算中…";
    const { data, error } = await sb.rpc("login_frequency", { p_from: r[0].toISOString(), p_to: r[1].toISOString(), p_user: null });
    if (error) { $("admFreqMsg").textContent = error.message; return; }
    const email = $("admEmail").value.trim().toLowerCase();
    const rows = (data || []).filter((x) => !email || (x.email || "").toLowerCase().includes(email));
    $("admFreq").innerHTML = rows.map((x) => `<tr>
        <td>${esc(x.email || x.user_id)}</td>
        <td class="num">${x.logins}</td>
        <td class="num">${esc(fmtGap(x.avg_interval_seconds))}</td>
        <td>${esc(fmtTime(x.first_login))}</td>
        <td>${esc(fmtTime(x.last_login))}</td>
        <td>${esc(fmtTime(x.last_login_any))}</td>
        <td>${esc((x.countries || []).join("、") || "—")}</td>
      </tr>`).join("") || '<tr><td colspan="7">這段期間沒有（未被排除的）登入紀錄。</td></tr>';
    $("admFreqMsg").textContent = `${rows.length} 位使用者`;
  }

  // ---------------------------------------------------------------- 3. IP 排除名單
  async function loadExclusions() {
    const [{ data, error }, hits] = await Promise.all([
      sb.from("ip_exclusions").select("*").order("created_at", { ascending: false }),
      sb.rpc("exclusion_hits"),
    ]);
    if (error) { $("admExMsg").textContent = error.message; return; }
    const count = new Map((hits.data || []).map((h) => [h.id, h.hits]));
    $("admExList").innerHTML = (data || []).map((x) => `<tr>
        <td><code>${esc(x.cidr)}</code></td>
        <td>${esc(x.note || "")}</td>
        <td class="num">${(count.get(x.id) ?? 0).toLocaleString()}</td>
        <td>${esc(fmtTime(x.created_at))}</td>
        <td><button type="button" class="adm-btn" data-del="${x.id}">刪除</button></td>
      </tr>`).join("") || '<tr><td colspan="5">尚未設定任何排除 IP。</td></tr>';
    $("admExList").querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!window.confirm("確定要從排除名單刪除？刪除後這個 IP 的登入會重新計入統計。")) return;
      const { error: e } = await sb.from("ip_exclusions").delete().eq("id", Number(b.dataset.del));
      setExMsg(e ? e.message : "已刪除", !!e);
      loadExclusions();
    }));
  }
  const setExMsg = (t, err) => { $("admExMsg").textContent = t; $("admExMsg").className = "adm-msg" + (err ? " err" : ""); };
  const validIp = (v) => /^(\d{1,3}\.){3}\d{1,3}(\/(\d|[12]\d|3[0-2]))?$/.test(v) && v.split("/")[0].split(".").every((n) => Number(n) <= 255)
    || /^[0-9a-f:]+(\/\d{1,3})?$/i.test(v) && v.includes(":");

  $("admExForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ip = $("admExIp").value.trim();
    if (!validIp(ip)) { setExMsg("格式不正確：請輸入 IPv4／IPv6 位址，或 CIDR 網段（例如 10.0.0.0/8）", true); return; }
    const { data: { user } } = await sb.auth.getUser();
    const { error } = await sb.from("ip_exclusions").insert({ cidr: ip, note: $("admExNote").value.trim() || null, created_by: user?.id });
    if (error) { setExMsg(error.code === "23505" ? "這個 IP／網段已在排除名單中" : error.message, true); return; }
    setExMsg(`已加入 ${ip}；統計已重算`);
    $("admExIp").value = ""; $("admExNote").value = "";
    loadExclusions();
  });
  $("admExMine").addEventListener("click", async () => {
    try {
      const r = await fetch("https://api.ipify.org?format=json");
      const { ip } = await r.json();
      $("admExIp").value = ip;
      $("admExNote").value = $("admExNote").value || "管理員目前的 IP";
    } catch (_) { setExMsg("無法取得目前 IP，請手動輸入", true); }
  });

  // ---------------------------------------------------------------- 分頁與篩選
  function showTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".page-tabs a[data-tab]").forEach((a) => {
      if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    document.querySelectorAll(".adm-section").forEach((s) => { s.hidden = s.dataset.section !== tab; });
    document.querySelector(".adm-filters").hidden = tab === "exclusions";
    $("admShowExWrap").hidden = tab !== "events";
    if (location.hash !== "#" + tab) history.replaceState(null, "", "#" + tab);
    refresh();
  }
  const refresh = () => (state.tab === "events" ? loadEvents() : state.tab === "frequency" ? loadFrequency() : loadExclusions());
  document.querySelectorAll(".page-tabs a[data-tab]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); showTab(a.dataset.tab); }));
  $("admPeriod").addEventListener("change", () => { $("admCustom").hidden = $("admPeriod").value !== "custom"; refresh(); });
  for (const id of ["admFrom", "admTo", "admShowEx"]) $(id).addEventListener("change", refresh);
  let t; $("admEmail").addEventListener("input", () => { clearTimeout(t); t = setTimeout(refresh, 300); });
  $("admReload").addEventListener("click", refresh);

  // ---------------------------------------------------------------- 權限
  async function boot(session) {
    if (!session) {
      gate.hidden = false; app.hidden = true;
      gate.innerHTML = "請先用右上角的「登入」按鈕登入管理員帳號。";
      return;
    }
    const { data: isAdmin } = await sb.rpc("is_login_admin");
    if (!isAdmin) {
      gate.hidden = false; app.hidden = true;
      gate.innerHTML = `目前登入的 ${esc(session.user.email)} 不是管理員。<br>請在 Supabase 把這個帳號加入 <code>login_admins</code> 資料表。`;
      return;
    }
    gate.hidden = true; app.hidden = false;
    const tab = location.hash.slice(1);
    showTab(["events", "frequency", "exclusions"].includes(tab) ? tab : "events");
  }
  sb.auth.getSession().then(({ data }) => boot(data.session));
  sb.auth.onAuthStateChange((event, session) => { if (event === "SIGNED_IN" || event === "SIGNED_OUT") boot(session); });
})();
