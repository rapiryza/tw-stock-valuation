/* 訪客分析後台：客群分析圖表、訪客紀錄、各 IP 造訪次數、IP 排除名單。訪客不需登入；後台本身需管理員登入。
 * 資料權限由 Supabase RLS 控制：只有 login_admins 內的帳號讀得到。 */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const gate = $("admGate"), app = $("admApp");
  const cfg = window.SUPABASE_CONFIG || {};
  if (!cfg.url || !cfg.anonKey) {
    gate.innerHTML = "尚未設定 Supabase。";
    return;
  }
  const sb = window.twAuth || window.supabase.createClient(cfg.url, cfg.anonKey);
  const state = { all: null, loading: null, tab: "audience" };
  const TZ = "Asia/Taipei";
  const nf = (n) => Number(n).toLocaleString("zh-TW");
  const pct = (a, b) => (b ? (a / b * 100) : 0);

  const fmtTime = (t) => t ? new Date(t).toLocaleString("zh-TW", { hour12: false, timeZone: TZ }) : "—";
  const fmtGap = (sec) => {
    if (sec == null) return "—";
    const d = sec / 86400;
    if (d >= 1) return `${d.toFixed(1)} 天`;
    const h = sec / 3600;
    if (h >= 1) return `${h.toFixed(1)} 小時`;
    return `${Math.max(1, Math.round(sec / 60))} 分鐘`;
  };

  // ---------------------------------------------------------------- 分類
  const osOf = (ua) => !ua ? "未知" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /CrOS/.test(ua) ? "ChromeOS"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "其他";
  const deviceOf = (ua) => !ua ? "未知" : /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? "平板"
    : /Mobi|iPhone|iPod|Android/.test(ua) ? "手機" : "電腦";
  const browserOf = (ua) => !ua ? "未知" : / Line\//i.test(ua) ? "LINE App" : /FBAN|FBAV|FB_IAB/.test(ua) ? "Facebook App" : /Instagram/.test(ua) ? "Instagram App"
    : /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung 瀏覽器" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox|FxiOS/.test(ua) ? "Firefox"
    : /Chrome|CriOS/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "其他";
  const device = (ua) => ua ? `${browserOf(ua)} / ${osOf(ua)}` : "—";
  function refOf(r) {
    if (!r) return "直接進站";
    let h = "";
    try { h = new URL(r).hostname.replace(/^www\./, ""); } catch (_) { return "其他"; }
    if (h === location.hostname) return "站內連結";
    const map = [[/google\./, "Google"], [/bing\./, "Bing"], [/yahoo\./, "Yahoo"], [/duckduckgo/, "DuckDuckGo"], [/facebook\.|fb\.|messenger/, "Facebook"],
      [/instagram/, "Instagram"], [/threads\./, "Threads"], [/(^|\.)line\.|line\.me/, "LINE"], [/ptt\.cc/, "PTT"], [/dcard/, "Dcard"],
      [/(^|\.)t\.co$|twitter|x\.com/, "X (Twitter)"], [/youtube|youtu\.be/, "YouTube"], [/reddit/, "Reddit"], [/github/, "GitHub"],
      [/chatgpt|openai|perplexity|claude\.ai/, "AI 助理"]];
    for (const [re, name] of map) if (re.test(h)) return name;
    return h;
  }
  function pageLabel(p) {
    if (!p) return "—";
    const h = (p.split("#")[1] || "").split(/[?&]/)[0];
    return { "": "個股指標", stocks: "個股指標", movers: "漲跌幅排行", records: "創新高與新低榜" }[h] || (h ? `#${h}` : p);
  }
  const tpFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" });
  const tpParts = (t) => {
    const p = Object.fromEntries(tpFmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, wd: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday) };
  };
  const tpDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

  function range() {
    const p = $("admPeriod").value;
    if (p === "custom") {
      const from = $("admFrom").value, to = $("admTo").value;
      if (!from || !to) return null;
      return [new Date(from + "T00:00:00+08:00"), new Date(new Date(to + "T00:00:00+08:00").getTime() + 86400000)];
    }
    const to = new Date();
    return [new Date(to.getTime() - Number(p) * 86400000), to];
  }
  const filterText = () => $("admEmail").value.trim().toLowerCase();
  const matches = (x, f) => !f || [x.ip, x.country, x.city, x.region].some((v) => String(v || "").toLowerCase().includes(f));

  // ---------------------------------------------------------------- 資料：一次分頁抓完全部紀錄（PostgREST 每次最多 1,000 筆）
  async function loadAll(force) {
    if (state.all && !force) return state.all;
    if (state.loading && !force) return state.loading;
    const msg = $("admLoadMsg");
    msg.className = "adm-msg"; msg.textContent = "載入中…";
    state.loading = (async () => {
      const rows = [];
      for (let from = 0; from < 200000; from += 1000) {
        const { data, error } = await sb.from("visit_events_v")
          .select("id,visitor_id,ip,country,region,city,user_agent,path,referrer,created_at,excluded")
          .order("id", { ascending: true }).range(from, from + 999);
        if (error) throw error;
        rows.push(...data);
        if (data.length < 1000) break;
      }
      for (const r of rows) { r.key = r.visitor_id || `ip:${r.ip}`; r.ts = new Date(r.created_at).getTime(); Object.assign(r, tpParts(r.created_at)); }
      // 每位訪客第一次造訪（不限期間、不含排除 IP）→ 判斷新訪客／回訪客
      const first = new Map();
      for (const r of rows) if (!r.excluded && !first.has(r.key)) first.set(r.key, r.id);
      for (const r of rows) r.isNew = first.get(r.key) === r.id;
      state.all = rows;
      msg.textContent = `共 ${nf(rows.length)} 筆紀錄・更新於 ${new Date().toLocaleTimeString("zh-TW", { hour12: false })}`;
      return rows;
    })();
    try { return await state.loading; }
    catch (e) { msg.textContent = e.message; msg.className = "adm-msg err"; throw e; }
    finally { state.loading = null; }
  }
  async function slice(includeExcluded) {
    const r = range(); if (!r) return null;
    const all = await loadAll();
    const f = filterText(), a = r[0].getTime(), b = r[1].getTime();
    return { from: r[0], to: r[1], rows: all.filter((x) => x.ts >= a && x.ts < b && (includeExcluded || !x.excluded) && matches(x, f)) };
  }

  // ---------------------------------------------------------------- 提示框（文字一律用 textContent）
  const tip = $("vizTip");
  function showTip(e, title, rows) {
    tip.replaceChildren();
    const t = document.createElement("div"); t.className = "t"; t.textContent = title; tip.appendChild(t);
    for (const [color, label, value] of rows) {
      const r = document.createElement("div"); r.className = "r";
      const i = document.createElement("i"); i.style.background = color || "transparent"; r.appendChild(i);
      const b = document.createElement("b"); b.textContent = value; r.appendChild(b);
      const s = document.createElement("span"); s.textContent = label; r.appendChild(s);
      tip.appendChild(r);
    }
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + w > innerWidth - 8) x = e.clientX - w - 14;
    if (y + h > innerHeight - 8) y = e.clientY - h - 14;
    tip.style.left = Math.max(8, x) + "px"; tip.style.top = Math.max(8, y) + "px";
  }
  const hideTip = () => { tip.hidden = true; };
  const cssVar = (name) => `var(${name})`;

  // ---------------------------------------------------------------- 圖表元件（純 SVG／HTML，不依賴外部函式庫）
  const SVGNS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  };
  // y 軸固定 4 格，每格取整數好讀的間距
  const niceMax = (v) => {
    const raw = Math.max(1, v) / 4;
    if (raw <= 10) return Math.ceil(raw) * 4;
    const p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p * 4;
  };
  const dayList = (from, to) => {
    const out = [], seen = new Set();
    for (let t = from.getTime(); t < to.getTime() + 3600000; t += 3600000 * 6) {
      const d = tpDay(new Date(t)); if (!seen.has(d)) { seen.add(d); out.push(d); }
    }
    const last = tpDay(new Date(to.getTime() - 1));
    return out.filter((d) => d <= last);
  };
  const shortDay = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  const tickEvery = (n, iw) => Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 56))));
  const showTick = (i, n, step) => i === n - 1 || (i % step === 0 && n - 1 - i >= step * 0.6);

  function frame(host) {
    host.replaceChildren();
    const W = Math.max(320, host.clientWidth || 600), H = 220, m = { l: 40, r: 14, t: 16, b: 26 };
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "viz-svg", role: "img" }, host);
    return { svg, W, H, m, iw: W - m.l - m.r, ih: H - m.t - m.b };
  }
  function yGrid(f, max) {
    const { svg, m, ih, W } = f;
    for (let i = 0; i <= 4; i++) {
      const y = m.t + ih - ih * i / 4;
      el("line", { x1: m.l, x2: W - m.r, y1: y, y2: y, class: i ? "grid" : "axis" }, svg);
      const t = el("text", { x: m.l - 6, y: y + 4, "text-anchor": "end" }, svg); t.textContent = nf(Math.round(max * i / 4));
    }
  }

  function lineChart(host, days, series, label) {
    if (!days.length) { host.innerHTML = '<div class="viz-empty">沒有資料</div>'; return; }
    const f = frame(host), { svg, m, iw, ih } = f;
    svg.setAttribute("aria-label", label);
    const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
    yGrid(f, max);
    const n = days.length, last = n - 1;
    const X = (i) => m.l + (n === 1 ? iw / 2 : iw * i / last);
    const Y = (v) => m.t + ih - ih * v / max;
    const step = tickEvery(n, iw);
    days.forEach((d, i) => { if (showTick(i, n, step)) { const t = el("text", { x: X(i), y: m.t + ih + 18, "text-anchor": i === last && n > 1 ? "end" : "middle" }, svg); t.textContent = shortDay(d); } });
    for (const s of series) {
      el("path", { d: s.values.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(""), fill: "none", stroke: cssVar(s.color), "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      if (n <= 45) s.values.forEach((v, i) => el("circle", { cx: X(i), cy: Y(v), r: 3.5, fill: cssVar(s.color), stroke: "var(--surface-1)", "stroke-width": 2 }, svg));
    }
    const hair = el("line", { y1: m.t, y2: m.t + ih, class: "axis", visibility: "hidden" }, svg);
    const hit = el("rect", { x: m.l - 10, y: 0, width: iw + 20, height: m.t + ih, fill: "transparent" }, svg);
    hit.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect(), sx = (e.clientX - r.left) * f.W / r.width;
      const i = n === 1 ? 0 : Math.max(0, Math.min(last, Math.round((sx - m.l) / (iw / last))));
      hair.setAttribute("x1", X(i)); hair.setAttribute("x2", X(i)); hair.setAttribute("visibility", "visible");
      showTip(e, days[i], series.map((s) => [cssVar(s.color), s.name, nf(s.values[i])]));
    });
    hit.addEventListener("pointerleave", () => { hair.setAttribute("visibility", "hidden"); hideTip(); });
  }

  function barPath(x, y, w, h, r) {
    if (h <= 0) return "";
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  function stackedBars(host, days, series, label) {
    if (!days.length) { host.innerHTML = '<div class="viz-empty">沒有資料</div>'; return; }
    const f = frame(host), { svg, m, iw, ih } = f;
    svg.setAttribute("aria-label", label);
    const n = days.length;
    const tot = days.map((_, i) => series.reduce((a, s) => a + s.values[i], 0));
    const max = niceMax(Math.max(1, ...tot));
    yGrid(f, max);
    const bw = iw / n, w = Math.max(2, Math.min(28, bw - 2));
    const step = tickEvery(n, iw);
    days.forEach((d, i) => {
      const cx = m.l + bw * i + bw / 2;
      let yTop = m.t + ih;
      const drawn = series.map((s) => s.values[i]).map((v, k) => [v, k]).filter(([v]) => v > 0);
      drawn.forEach(([v, k], j) => {
        const h = ih * v / max;
        const isTop = j === drawn.length - 1;
        const gap = j > 0 ? 2 : 0; // 堆疊區段之間 2px 表面間隔
        el("path", { d: barPath(cx - w / 2, yTop - h, w, Math.max(0.5, h - gap), isTop ? 4 : 0), fill: cssVar(series[k].color) }, svg);
        yTop -= h;
      });
      if (showTick(i, n, step)) { const t = el("text", { x: cx, y: m.t + ih + 18, "text-anchor": "middle" }, svg); t.textContent = shortDay(d); }
      const hit = el("rect", { x: m.l + bw * i, y: m.t, width: bw, height: ih, fill: "transparent" }, svg);
      hit.addEventListener("pointermove", (e) => showTip(e, d, [...series.map((s) => [cssVar(s.color), s.name, nf(s.values[i])]),
        ["", "回訪占比", tot[i] ? `${pct(series[1].values[i], tot[i]).toFixed(0)}%` : "—"]]));
      hit.addEventListener("pointerleave", hideTip);
    });
  }

  function hbars(host, entries, { top = 10, unit = "次造訪" } = {}) {
    host.replaceChildren();
    if (!entries.length) { host.innerHTML = '<div class="viz-empty">沒有資料</div>'; return; }
    const sum = entries.reduce((a, [, v]) => a + v, 0);
    let list = entries;
    if (top && entries.length > top) {
      const rest = entries.slice(top - 1).reduce((a, [, v]) => a + v, 0);
      list = [...entries.slice(0, top - 1), ["其他", rest]];
    }
    const max = Math.max(...list.map(([, v]) => v));
    const wrap = document.createElement("div"); wrap.className = "hbar";
    for (const [label, v] of list) {
      const row = document.createElement("div"); row.className = "row";
      const lab = document.createElement("div"); lab.className = "lab"; lab.textContent = label; lab.title = label;
      const track = document.createElement("div"); track.className = "track";
      const fill = document.createElement("div"); fill.className = "fill"; fill.style.width = `${(v / max * 100).toFixed(1)}%`; track.appendChild(fill);
      const val = document.createElement("div"); val.className = "val"; val.textContent = nf(v);
      const sm = document.createElement("small"); sm.textContent = `${pct(v, sum).toFixed(1)}%`; val.appendChild(sm);
      row.append(lab, track, val);
      for (const node of [lab, track, val]) {
        node.addEventListener("pointermove", (e) => { fill.classList.add("hl"); showTip(e, label, [["var(--viz-1)", unit, nf(v)], ["", "占比", `${pct(v, sum).toFixed(1)}%`]]); });
        node.addEventListener("pointerleave", () => { fill.classList.remove("hl"); hideTip(); });
      }
      wrap.appendChild(row);
    }
    host.appendChild(wrap);
  }
  const countBy = (rows, fn) => {
    const m = new Map();
    for (const r of rows) { const k = fn(r) || "未知"; m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  function heatmap(host, rows) {
    host.replaceChildren();
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const r of rows) if (r.wd >= 0) grid[r.wd][r.hour] += 1;
    const max = Math.max(0, ...grid.flat());
    const steps = 7;
    const box = document.createElement("div"); box.className = "heat";
    box.appendChild(document.createElement("div"));
    for (let h = 0; h < 24; h++) { const c = document.createElement("div"); c.className = "h"; c.textContent = h % 3 === 0 ? String(h) : ""; box.appendChild(c); }
    const names = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"];
    grid.forEach((row, d) => {
      const lab = document.createElement("div"); lab.className = "d"; lab.textContent = names[d]; box.appendChild(lab);
      row.forEach((v, h) => {
        const c = document.createElement("div"); c.className = "c";
        if (v) c.style.background = `var(--seq-${Math.min(steps - 1, Math.ceil(v / max * steps) - 1)})`;
        c.addEventListener("pointermove", (e) => showTip(e, `${names[d]} ${String(h).padStart(2, "0")}:00–${String(h).padStart(2, "0")}:59`, [["var(--viz-1)", "次造訪", nf(v)]]));
        c.addEventListener("pointerleave", hideTip);
        box.appendChild(c);
      });
    });
    host.appendChild(box);
    const sc = document.createElement("div"); sc.className = "heat-scale";
    sc.append("少");
    for (let i = 0; i < steps; i++) { const s = document.createElement("i"); s.style.background = `var(--seq-${i})`; sc.appendChild(s); }
    sc.append(`多（單格最多 ${nf(max)} 次）`);
    host.appendChild(sc);
  }

  // ---------------------------------------------------------------- 1. 客群分析
  async function loadAudience() {
    const root = document.querySelector('[data-section="audience"]');
    root.classList.add("viz-loading");
    let s;
    try { s = await slice(false); } finally { root.classList.remove("viz-loading"); }
    if (!s) return;
    const rows = s.rows;
    const days = dayList(s.from, s.to);
    const byDay = new Map(days.map((d) => [d, { v: 0, keys: new Set(), n: 0, r: 0 }]));
    for (const r of rows) { const b = byDay.get(r.day); if (!b) continue; b.v++; b.keys.add(r.key); if (r.isNew) b.n++; else b.r++; }
    const visitors = new Set(rows.map((r) => r.key)), ips = new Set(rows.map((r) => r.ip));
    const newCount = rows.filter((r) => r.isNew).length;
    const returning = new Set(rows.filter((r) => !r.isNew).map((r) => r.key)).size;
    const mobile = rows.filter((r) => deviceOf(r.user_agent) === "手機").length;
    const countries = new Set(rows.map((r) => r.country).filter(Boolean)).size;
    const kpis = [
      ["造訪次數", nf(rows.length), `平均每天 ${(rows.length / Math.max(1, days.length)).toFixed(1)} 次`],
      ["不同訪客", nf(visitors.size), `不同 IP ${nf(ips.size)} 個`],
      ["新訪客", nf(newCount), `占造訪 ${pct(newCount, rows.length).toFixed(0)}%`],
      ["回訪的訪客", nf(returning), `占訪客 ${pct(returning, visitors.size).toFixed(0)}%`],
      ["每位訪客平均造訪", visitors.size ? (rows.length / visitors.size).toFixed(1) : "—", "次"],
      ["手機占比", `${pct(mobile, rows.length).toFixed(0)}%`, `來自 ${nf(countries)} 個國家／地區`],
    ];
    $("vizKpis").innerHTML = kpis.map(([k, v, sub]) => `<div class="adm-kpi"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(sub)}</div></div>`).join("");

    const b = days.map((d) => byDay.get(d));
    lineChart($("vizDaily"), days, [
      { name: "造訪次數", color: "--viz-1", values: b.map((x) => x.v) },
      { name: "不同訪客", color: "--viz-2", values: b.map((x) => x.keys.size) },
    ], "每日造訪次數與不同訪客數折線圖");
    stackedBars($("vizNewRet"), days, [
      { name: "新訪客", color: "--viz-1", values: b.map((x) => x.n) },
      { name: "回訪客", color: "--viz-2", values: b.map((x) => x.r) },
    ], "每日新訪客與回訪客堆疊長條圖");
    heatmap($("vizHeat"), rows);
    hbars($("vizCountry"), countBy(rows, (r) => r.country));
    hbars($("vizCity"), countBy(rows, (r) => r.city ? (r.country && r.country !== "Taiwan" ? `${r.city}（${r.country}）` : r.city) : "未知"));
    hbars($("vizDevice"), countBy(rows, (r) => deviceOf(r.user_agent)), { top: 0 });
    hbars($("vizOs"), countBy(rows, (r) => osOf(r.user_agent)), { top: 0 });
    hbars($("vizBrowser"), countBy(rows, (r) => browserOf(r.user_agent)));
    hbars($("vizRef"), countBy(rows, (r) => refOf(r.referrer)));
    hbars($("vizPage"), countBy(rows, (r) => pageLabel(r.path)));
    const per = new Map(); for (const r of rows) per.set(r.key, (per.get(r.key) || 0) + 1);
    const bins = [["1 次", 1, 1], ["2 次", 2, 2], ["3–5 次", 3, 5], ["6–10 次", 6, 10], ["11–30 次", 11, 30], ["31 次以上", 31, Infinity]];
    const loyal = bins.map(([l, a, z]) => [l, [...per.values()].filter((k) => k >= a && k <= z).length]).filter(([, k]) => k);
    hbars($("vizLoyal"), loyal, { top: 0, unit: "位訪客" });
  }

  // ---------------------------------------------------------------- 2. 訪客紀錄
  async function loadEvents() {
    $("admEventsMsg").textContent = "載入中…";
    const s = await slice($("admShowEx").checked); if (!s) return;
    const ev = s.rows.slice().reverse();
    const shown = ev.slice(0, 1000);
    $("admEvents").innerHTML = shown.map((e) => `<tr>
        <td>${esc(fmtTime(e.created_at))}</td>
        <td><code>${esc(e.ip)}</code>${e.excluded ? ' <span class="adm-badge">已排除</span>' : ""}${e.isNew && !e.excluded ? ' <span class="adm-badge">新訪客</span>' : ""}</td>
        <td>${esc(e.country || "—")}</td>
        <td>${esc([e.city, e.region].filter(Boolean).join("，") || "—")}</td>
        <td class="adm-ua" title="${esc(e.user_agent)}">${esc(device(e.user_agent))}</td>
        <td>${esc(pageLabel(e.path))}</td>
        <td>${esc(refOf(e.referrer))}</td>
        <td>${e.excluded ? "" : `<button type="button" class="adm-btn" data-ex="${esc(e.ip)}">排除此 IP</button>`}</td>
      </tr>`).join("") || '<tr><td colspan="8">這段期間沒有造訪紀錄。</td></tr>';
    $("admEventsMsg").textContent = ev.length > shown.length ? `共 ${nf(ev.length)} 筆，只列出最近 1,000 筆；縮短期間或篩選可看更早的紀錄。` : `共 ${nf(ev.length)} 筆`;
    bindExclude($("admEvents"));
  }

  // ---------------------------------------------------------------- 3. 各 IP 造訪次數
  async function loadFrequency() {
    const r = range(); if (!r) return;
    $("admFreqMsg").textContent = "計算中…";
    const { data, error } = await sb.rpc("visit_stats", { p_from: r[0].toISOString(), p_to: r[1].toISOString() });
    if (error) { $("admFreqMsg").textContent = error.message; return; }
    const f = filterText();
    const rows = (data || []).filter((x) => matches(x, f));
    $("admFreq").innerHTML = rows.map((x) => `<tr>
        <td><code>${esc(x.ip)}</code></td>
        <td>${esc(x.country || "—")}</td>
        <td>${esc(x.city || "—")}</td>
        <td class="num">${x.visits}</td>
        <td class="num">${x.browsers}</td>
        <td class="num">${esc(fmtGap(x.avg_interval_seconds))}</td>
        <td>${esc(fmtTime(x.first_visit))}</td>
        <td>${esc(fmtTime(x.last_visit))}</td>
        <td>${esc(fmtTime(x.last_visit_any))}</td>
        <td class="adm-ua" title="${esc(x.user_agent)}">${esc(device(x.user_agent))}</td>
        <td><button type="button" class="adm-btn" data-ex="${esc(x.ip)}">排除此 IP</button></td>
      </tr>`).join("") || '<tr><td colspan="11">這段期間沒有（未被排除的）造訪紀錄。</td></tr>';
    const total = rows.reduce((a, x) => a + Number(x.visits), 0);
    $("admFreqMsg").textContent = `${rows.length} 個 IP，共 ${nf(total)} 次造訪`;
    bindExclude($("admFreq"));
  }
  function bindExclude(root) {
    root.querySelectorAll("[data-ex]").forEach((b) => b.addEventListener("click", () => {
      $("admExIp").value = b.dataset.ex; showTab("exclusions"); $("admExNote").focus();
    }));
  }

  // ---------------------------------------------------------------- 4. IP 排除名單
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
        <td class="num">${nf(count.get(x.id) ?? 0)}</td>
        <td>${esc(fmtTime(x.created_at))}</td>
        <td><button type="button" class="adm-btn" data-del="${x.id}">刪除</button></td>
      </tr>`).join("") || '<tr><td colspan="5">尚未設定任何排除 IP。</td></tr>';
    $("admExList").querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!window.confirm("確定要從排除名單刪除？刪除後這個 IP 的造訪會重新計入統計。")) return;
      const { error: e } = await sb.from("ip_exclusions").delete().eq("id", Number(b.dataset.del));
      setExMsg(e ? e.message : "已刪除", !!e);
      state.all = null;
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
    state.all = null;
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
  const TABS = ["audience", "events", "frequency", "exclusions"];
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
  const refresh = () => (state.tab === "audience" ? loadAudience() : state.tab === "events" ? loadEvents() : state.tab === "frequency" ? loadFrequency() : loadExclusions()).catch(() => {});
  document.querySelectorAll(".page-tabs a[data-tab]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); showTab(a.dataset.tab); }));
  $("admPeriod").addEventListener("change", () => { $("admCustom").hidden = $("admPeriod").value !== "custom"; refresh(); });
  for (const id of ["admFrom", "admTo", "admShowEx"]) $(id).addEventListener("change", refresh);
  let t; $("admEmail").addEventListener("input", () => { clearTimeout(t); t = setTimeout(refresh, 300); });
  $("admReload").addEventListener("click", () => { state.all = null; refresh(); });
  let rz, lastW = innerWidth;
  addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (innerWidth !== lastW && state.tab === "audience" && state.all) { lastW = innerWidth; loadAudience(); } }, 200); });

  // ---------------------------------------------------------------- 權限
  async function boot(session) {
    if (!session) {
      gate.hidden = false; app.hidden = true;
      gate.innerHTML = "這裡是管理員專用的訪客分析後台。<br>請用右上角的「登入」按鈕登入管理員帳號。";
      return;
    }
    const { data: isAdmin } = await sb.rpc("is_login_admin");
    if (!isAdmin) {
      gate.hidden = false; app.hidden = true;
      gate.innerHTML = `目前登入的 ${esc(session.user.email)} 沒有後台權限。`;
      return;
    }
    gate.hidden = true; app.hidden = false;
    const tab = location.hash.slice(1);
    showTab(TABS.includes(tab) ? tab : "audience");
  }
  sb.auth.getSession().then(({ data }) => boot(data.session));
  sb.auth.onAuthStateChange((event, session) => { if (event === "SIGNED_IN" || event === "SIGNED_OUT") boot(session); });
})();
