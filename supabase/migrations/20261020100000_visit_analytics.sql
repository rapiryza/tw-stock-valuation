-- 訪客分析：每個連上網站的人（不需登入）記錄 IP、國家／城市與造訪次數
-- 在 Supabase SQL Editor 執行一次即可；重複執行不會出錯。需先執行 20261020000000_login_analytics.sql
-- （沿用其中的 login_admins、ip_exclusions、is_login_admin、ip_is_excluded）。
--
-- 一次「造訪」＝同一個瀏覽器（visitor_id）在同一個 IP 上，距離上次紀錄超過 30 分鐘才再算一次，
-- 所以重新整理、切換分頁不會灌水。寫入只經由 Edge Function record-visit（service role）。

create table if not exists public.visit_events (
  id bigserial primary key,
  visitor_id text,
  ip inet not null,
  country text,
  country_code text,
  region text,
  city text,
  lat double precision,
  lon double precision,
  user_agent text,
  path text,
  referrer text,
  created_at timestamptz not null default now()
);
create index if not exists visit_events_time on public.visit_events (created_at desc);
create index if not exists visit_events_ip_time on public.visit_events (ip, created_at desc);
create index if not exists visit_events_visitor_time on public.visit_events (visitor_id, created_at desc);

alter table public.visit_events enable row level security;
drop policy if exists "admins read visits" on public.visit_events;
create policy "admins read visits" on public.visit_events
  for select using (public.is_login_admin());

create or replace view public.visit_events_v with (security_invoker = true) as
  select v.*, public.ip_is_excluded(v.ip) as excluded
  from public.visit_events v;
grant select on public.visit_events_v to authenticated;

-- 依 IP 統計期間內造訪次數（已扣除排除名單）
-- avg_interval_seconds：同一 IP 相鄰兩次造訪的平均間隔（秒），少於 2 次為 null。
-- last_visit_any：不限期間的最後造訪時間。
create or replace function public.visit_stats(p_from timestamptz, p_to timestamptz)
returns table (
  ip inet,
  visits bigint,
  browsers bigint,
  country text,
  country_code text,
  city text,
  avg_interval_seconds double precision,
  first_visit timestamptz,
  last_visit timestamptz,
  last_visit_any timestamptz,
  user_agent text
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_login_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
  with counted as (
    select v.ip, v.visitor_id, v.country, v.country_code, v.city, v.user_agent, v.created_at,
           v.created_at - lag(v.created_at) over (partition by v.ip order by v.created_at) as gap
    from public.visit_events v
    where v.created_at >= p_from and v.created_at < p_to
      and not public.ip_is_excluded(v.ip)
  )
  select c.ip,
         count(*),
         count(distinct c.visitor_id),
         (array_agg(c.country order by c.created_at desc))[1],
         (array_agg(c.country_code order by c.created_at desc))[1],
         (array_agg(c.city order by c.created_at desc))[1],
         extract(epoch from avg(c.gap))::double precision,
         min(c.created_at),
         max(c.created_at),
         (select max(a.created_at) from public.visit_events a where a.ip = c.ip),
         (array_agg(c.user_agent order by c.created_at desc))[1]
  from counted c
  group by c.ip
  order by count(*) desc, max(c.created_at) desc;
end;
$$;
grant execute on function public.visit_stats(timestamptz, timestamptz) to authenticated;

-- 每條排除規則各擋掉多少次造訪（不限期間）
drop function if exists public.exclusion_hits();
create function public.exclusion_hits()
returns table (id bigint, hits bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_login_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
  select x.id, count(v.id)
  from public.ip_exclusions x
  left join public.visit_events v on v.ip <<= x.cidr
  group by x.id;
end;
$$;
grant execute on function public.exclusion_hits() to authenticated;
