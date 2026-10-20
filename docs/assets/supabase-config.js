// Supabase 專案設定：填入 Project URL 與 anon public key（Settings → API）。
// anon key 是公開金鑰，可以放在前端；資料權限由資料庫的 RLS 控制。
// 千萬不要把 service_role key 放在這裡。
window.SUPABASE_CONFIG = {
  url: "https://kwpqguaekodzfmmyqhak.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt3cHFndWFla29kemZtbXlxaGFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0MjQzNDEsImV4cCI6MjEwODAwMDM0MX0.gZyUrP5fNH6B7o1wB7kXf-zOs3WcW58aeUGxxokXYBs",
};
