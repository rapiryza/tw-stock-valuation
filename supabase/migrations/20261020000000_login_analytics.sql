-- 使用者登入分析與審計後台（Login Analytics）
-- 在 Supabase SQL Editor 執行一次即可；重複執行不會出錯。
--
-- 資料表
--   login_admins   可以看後台的管理員
--   login_events   每次登入一筆：IP、國家、城市、經緯度、User-Agent（由 Edge Function record-login 寫入）
--   ip_exclusions  排除名單：單一 IP 或網段（CIDR），名單內的登入不計入統計
--
-- 排除名單在「查詢時」比對，所以新增或刪除排除 IP 後，所有歷史統計會立即跟著變動。

create table if not exists public.login_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.login_events (
  id bigserial primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  email text,
  ip inet not null,
  country text,
  country_code text,
  region text,
  city text,
  lat double precision,
  lon double precision,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists login_events_user_time on public.login_events (user_id, created_at desc);
create index if not exists login_events_time on public.login_events (created_at desc);

create table if not exists public.ip_exclusions (
  id bigserial primary key,
  cidr cidr not null unique,
  note text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- 權限判斷
create or replace function public.is_login_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.login_admins where user_id = auth.uid());
$$;

create or replace function public.ip_is_excluded(addr inet)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ip_exclusions where addr <<= cidr);
$$;

alter table public.login_admins enable row level security;
alter table public.login_events enable row level security;
alter table public.ip_exclusions enable row level security;

drop policy if exists "admins read admins" on public.login_admins;
create policy "admins read admins" on public.login_admins
  for select using (user_id = auth.uid() or public.is_login_admin());

-- 登入紀錄只有管理員能讀；寫入只經由 Edge Function（service role，不受 RLS 限制）
drop policy if exists "admins read events" on public.login_events;
create policy "admins read events" on public.login_events
  for select using (public.is_login_admin());

drop policy if exists "admins read exclusions" on public.ip_exclusions;
create policy "admins read exclusions" on public.ip_exclusions
  for select using (public.is_login_admin());
drop policy if exists "admins add exclusions" on public.ip_exclusions;
create policy "admins add exclusions" on public.ip_exclusions
  for insert with check (public.is_login_admin());
drop policy if exists "admins edit exclusions" on public.ip_exclusions;
create policy "admins edit exclusions" on public.ip_exclusions
  for update using (public.is_login_admin()) with check (public.is_login_admin());
drop policy if exists "admins delete exclusions" on public.ip_exclusions;
create policy "admins delete exclusions" on public.ip_exclusions
  for delete using (public.is_login_admin());

-- ---------------------------------------------------------------- 後台列表：附上是否被排除
create or replace view public.login_events_v with (security_invoker = true) as
  select e.*, public.ip_is_excluded(e.ip) as excluded
  from public.login_events e;

-- ---------------------------------------------------------------- 登入頻率統計（已扣除排除名單）
-- p_user 為 null 時回傳期間內每位使用者；有值時只回傳該使用者。
-- avg_interval_seconds：期間內相鄰兩次登入的平均間隔（秒），少於 2 次為 null。
-- last_login_any：不限期間的最後登入時間（同樣扣除排除名單）。
create or replace function public.login_frequency(
  p_from timestamptz,
  p_to timestamptz,
  p_user uuid default null
)
returns table (
  user_id uuid,
  email text,
  logins bigint,
  avg_interval_seconds double precision,
  first_login timestamptz,
  last_login timestamptz,
  last_login_any timestamptz,
  countries text[]
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_login_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
  with counted as (
    select e.user_id, e.email, e.created_at, e.country,
           e.created_at - lag(e.created_at) over (partition by e.user_id order by e.created_at) as gap
    from public.login_events e
    where e.created_at >= p_from and e.created_at < p_to
      and (p_user is null or e.user_id = p_user)
      and not public.ip_is_excluded(e.ip)
  )
  select c.user_id,
         max(c.email),
         count(*),
         extract(epoch from avg(c.gap))::double precision,
         min(c.created_at),
         max(c.created_at),
         (select max(a.created_at) from public.login_events a
           where a.user_id = c.user_id and not public.ip_is_excluded(a.ip)),
         array_remove(array_agg(distinct c.country), null)
  from counted c
  group by c.user_id
  order by count(*) desc, max(c.created_at) desc;
end;
$$;

-- 每條排除規則各擋掉多少次登入（不限期間）
create or replace function public.exclusion_hits()
returns table (id bigint, hits bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_login_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
  select x.id, count(e.id)
  from public.ip_exclusions x
  left join public.login_events e on e.ip <<= x.cidr
  group by x.id;
end;
$$;

grant execute on function public.login_frequency(timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.exclusion_hits() to authenticated;
grant execute on function public.is_login_admin() to authenticated;
grant select on public.login_events_v to authenticated;

-- 第一位管理員：把下面的 email 換成你的登入帳號後執行
-- insert into public.login_admins (user_id) select id from auth.users where email = 'you@example.com' on conflict do nothing;
