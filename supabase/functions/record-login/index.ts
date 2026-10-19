// 記錄一次登入：IP 由伺服器端從連線標頭取得（前端無法偽造），再解析成國家／城市。
// 前端在 signInWithPassword 成功後以使用者的 access token 呼叫一次。
//
// 部署：supabase functions deploy record-login
// 環境變數（Supabase 會自動提供）：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const DEDUPE_SECONDS = 10; // 同一使用者、同一 IP 10 秒內重複呼叫只記一次（避免連點或重送）

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip") || req.headers.get("cf-connecting-ip") || null;
}

async function geolocate(ip: string) {
  // 私有網段／本機位址不查詢
  if (/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd)/i.test(ip)) return {};
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country,country_code,region,city,latitude,longitude`,
      { signal: AbortSignal.timeout(4000) });
    const g = await res.json();
    if (!g.success) return {};
    return { country: g.country, country_code: g.country_code, region: g.region, city: g.city, lat: g.latitude, lon: g.longitude };
  } catch {
    return {}; // 查不到位置仍然記錄登入，只是沒有地點
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "missing token" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) return json({ error: "invalid token" }, 401);

  const ip = clientIp(req);
  if (!ip) return json({ error: "no client ip" }, 400);

  const since = new Date(Date.now() - DEDUPE_SECONDS * 1000).toISOString();
  const { data: recent } = await admin.from("login_events").select("id")
    .eq("user_id", user.id).eq("ip", ip).gte("created_at", since).limit(1);
  if (recent && recent.length) return json({ ok: true, deduped: true });

  const geo = await geolocate(ip);
  const { error: insertError } = await admin.from("login_events").insert({
    user_id: user.id,
    email: user.email,
    ip,
    user_agent: (req.headers.get("user-agent") || "").slice(0, 400),
    ...geo,
  });
  if (insertError) return json({ error: insertError.message }, 500);
  return json({ ok: true, country: geo.country ?? null, city: geo.city ?? null });
});
