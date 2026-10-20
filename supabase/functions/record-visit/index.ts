// 記錄一次網站造訪（不需登入）：IP 由伺服器端從連線標頭取得（前端無法偽造），再解析成國家／城市。
// 前端 visit.js 在每次開啟網站時呼叫；同一瀏覽器、同一 IP 30 分鐘內只算一次造訪。
//
// 部署：supabase functions deploy record-visit
// 環境變數（Supabase 會自動提供）：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SESSION_MINUTES = 30;   // 距離上次紀錄超過 30 分鐘才算新的一次造訪
const IP_HOURLY_CAP = 120;    // 同一 IP 一小時最多記 120 筆，避免被灌爆

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip") || req.headers.get("cf-connecting-ip") || null;
}

async function geolocate(ip: string) {
  if (/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd)/i.test(ip)) return {};
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country,country_code,region,city,latitude,longitude`,
      { signal: AbortSignal.timeout(4000) });
    const g = await res.json();
    if (!g.success) return {};
    return { country: g.country, country_code: g.country_code, region: g.region, city: g.city, lat: g.latitude, lon: g.longitude };
  } catch {
    return {};
  }
}

const clip = (v: unknown, n: number) => (typeof v === "string" && v ? v.slice(0, n) : null);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const ip = clientIp(req);
  if (!ip) return json({ error: "no client ip" }, 400);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* 沒有 body 也照樣記錄 */ }
  const visitorId = clip(body.visitor_id, 64);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const since = new Date(Date.now() - SESSION_MINUTES * 60_000).toISOString();
  let recentQ = db.from("visit_events").select("id").eq("ip", ip).gte("created_at", since).limit(1);
  recentQ = visitorId ? recentQ.eq("visitor_id", visitorId) : recentQ.is("visitor_id", null);
  const { data: recent } = await recentQ;
  if (recent && recent.length) return json({ ok: true, counted: false });

  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await db.from("visit_events").select("id", { count: "exact", head: true })
    .eq("ip", ip).gte("created_at", hourAgo);
  if ((count ?? 0) >= IP_HOURLY_CAP) return json({ ok: true, counted: false, capped: true });

  const geo = await geolocate(ip);
  const { error } = await db.from("visit_events").insert({
    visitor_id: visitorId,
    ip,
    user_agent: clip(req.headers.get("user-agent"), 400),
    path: clip(body.path, 300),
    referrer: clip(body.referrer, 300),
    ...geo,
  });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, counted: true });
});
