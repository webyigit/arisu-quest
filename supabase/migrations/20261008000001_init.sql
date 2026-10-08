-- 아리수 퀘스트: 사용자별 하루 방문 목록, 설정, 사진 인식 사용 기록
-- 무료 플랜 한도(DB 500MB) 안에서 쓰도록 문서 크기와 개수를 제한한다.

create table public.days (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date date not null,
  data jsonb not null default '{}'::jsonb,
  share_token text unique,
  updated_at timestamptz not null default now(),
  primary key (user_id, date),
  constraint days_data_size check (pg_column_size(data) < 200000),
  constraint days_token_len check (share_token is null or length(share_token) >= 20)
);

create table public.settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint settings_data_size check (pg_column_size(data) < 50000)
);

create table public.ocr_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'image',
  created_at timestamptz not null default now()
);
create index ocr_log_user_time on public.ocr_log (user_id, created_at);
create index ocr_log_time on public.ocr_log (created_at);

alter table public.days enable row level security;
alter table public.settings enable row level security;
alter table public.ocr_log enable row level security;

create policy days_own on public.days for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy settings_own on public.settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy ocr_log_read_own on public.ocr_log for select to authenticated
  using (user_id = (select auth.uid()));

-- 한 사람당 저장 일수 상한 (약 1년 반)
create or replace function public.days_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.days where user_id = new.user_id) >= 550 then
    raise exception 'DAY_LIMIT: 저장 가능한 날짜 수(550일)를 넘었어요. 오래된 날짜를 지워 주세요.';
  end if;
  return new;
end $$;
create trigger days_limit before insert on public.days
  for each row execute function public.days_limit();

create or replace function public.touch_updated() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
create trigger days_touch before update on public.days for each row execute function public.touch_updated();
create trigger settings_touch before update on public.settings for each row execute function public.touch_updated();

-- 공유 링크로 하루 목록 읽기 (로그인 없이, 토큰을 아는 사람만)
create or replace function public.get_shared_day(p_token text)
returns table (date date, data jsonb)
language sql stable security definer set search_path = '' as $$
  select d.date, d.data from public.days d
  where p_token is not null and length(p_token) >= 20 and d.share_token = p_token
$$;
revoke all on function public.get_shared_day(text) from public;
grant execute on function public.get_shared_day(text) to anon, authenticated;

-- 무료 플랜 한도 대비 사용량 (로그인한 사용자만)
create or replace function public.usage_status()
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'db_limit', 500 * 1024 * 1024,
    'ocr_month', (select count(*) from public.ocr_log where created_at >= date_trunc('month', now())),
    'fn_limit', 500000,
    'users', (select count(*) from auth.users),
    'mau_limit', 50000,
    'my_ocr_today', (select count(*) from public.ocr_log where user_id = (select auth.uid()) and created_at >= date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul'),
    'my_ocr_daily_limit', 30
  )
$$;
revoke all on function public.usage_status() from public;
grant execute on function public.usage_status() to authenticated;

revoke all on function public.days_limit() from public, anon, authenticated;
