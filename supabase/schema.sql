-- ============================================================================
-- WeTab · 一起记账 —— Supabase 建表脚本
--
-- 用法：Supabase 后台 → SQL Editor → New query → 整个粘进去 → Run
-- 可以重复跑，不会重复建东西。
--
-- 安全模型：
--   两张数据表都开了 RLS 且「一条策略都不给」，所以拿着 anon key 也没法直接读写它们。
--   所有访问都必须走下面几个 security definer 函数，函数第一件事就是校验账本码。
--   账本码是 12 位随机字符（去掉了 0/O/1/l/i 这些容易看错的），约 31^12 种组合，
--   猜不出来。但它就是钥匙 —— 谁拿到谁就能看账，别发到公开的地方。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 表
-- 注：函数名沿用 tally_ 前缀。项目改名 WeTab 之前就已经部署上线了，
--     改名要同时改数据库和前端，收益为零、风险不为零，所以保持不动。
-- ---------------------------------------------------------------------------
create table if not exists public.ledgers (
  id         uuid primary key default gen_random_uuid(),
  code       text unique not null,
  members    jsonb not null default '[]'::jsonb,   -- [{id:'a',name:'Chloe'}, ...]
  display    text not null default 'HKD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.trips (
  id         text primary key,                     -- 客户端生成，方便离线先记
  ledger_id  uuid not null references public.ledgers(id) on delete cascade,
  name       text not null,
  from_date  date,
  to_date    date,
  currency   text,
  deleted    boolean not null default false,       -- 软删除：不然对方那台机器删不掉
  updated_at timestamptz not null default now()
);

create table if not exists public.entries (
  id         text primary key,
  ledger_id  uuid not null references public.ledgers(id) on delete cascade,
  type       text not null default 'expense',      -- 'expense' | 'settle'
  payer_id   text not null,                        -- 'a' | 'b'
  amount     numeric(14, 2) not null,
  currency   text not null,
  cat        text,
  merchant   text,
  note       text,
  entry_date date not null,
  split      text,                                 -- 两人时代的遗留列，只读不写
  participants jsonb,                              -- 这笔由谁分摊（多人）
  to_id      text,                                 -- 结算：转给谁
  archived_at timestamptz,                         -- 结清后整批归档的时刻，同一批同一个值
  trip_id    text,
  deleted    boolean not null default false,
  created_at bigint,                               -- 客户端时间戳，仅用于同日排序
  updated_at timestamptz not null default now()
);

-- 多人支持：participants 是这笔由谁分摊，to_id 是结算转给谁。
-- 老库直接跑这段就能升级，旧行由下面的 update 就地迁移。
alter table public.entries add column if not exists participants jsonb;
alter table public.entries add column if not exists to_id text;
-- 归档：结清之后整批收起来。同一批共用一个时间戳，恢复时按这个值整批取回。
alter table public.entries add column if not exists archived_at timestamptz;

-- 旧行迁移：split 三选一 → participants 集合。只跑一次，之后 participants 非空就跳过。
update public.entries e set participants = (
  case
    when e.type = 'settle' then '[]'::jsonb
    when e.split = 'payer'  then jsonb_build_array(e.payer_id)
    when e.split = 'other'  then (
      select coalesce(jsonb_agg(m->>'id'), '[]'::jsonb)
      from ledgers l, jsonb_array_elements(l.members) m
      where l.id = e.ledger_id and m->>'id' <> e.payer_id)
    else (
      select coalesce(jsonb_agg(m->>'id'), '[]'::jsonb)
      from ledgers l, jsonb_array_elements(l.members) m
      where l.id = e.ledger_id)
  end)
where e.participants is null;

update public.entries e set to_id = (
  select m->>'id' from ledgers l, jsonb_array_elements(l.members) m
  where l.id = e.ledger_id and m->>'id' <> e.payer_id limit 1)
where e.type = 'settle' and e.to_id is null;

-- 增量拉取靠这两个索引
create index if not exists entries_ledger_updated_idx on public.entries (ledger_id, updated_at);
create index if not exists trips_ledger_updated_idx   on public.trips   (ledger_id, updated_at);

-- ---------------------------------------------------------------------------
-- RLS：全锁死。anon key 碰不到表，只能调下面的函数。
-- ---------------------------------------------------------------------------
alter table public.ledgers enable row level security;
alter table public.trips   enable row level security;
alter table public.entries enable row level security;

revoke all on public.ledgers from anon, authenticated;
revoke all on public.trips   from anon, authenticated;
revoke all on public.entries from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 账本码生成：去掉 0 O o 1 l I i，避免手抄时看错
-- ---------------------------------------------------------------------------
create or replace function public.tally_gen_code()
returns text
language sql
volatile
as $$
  select string_agg(
    substr('abcdefghjkmnpqrstuvwxyz23456789',
           (floor(random() * 31) + 1)::int, 1), '')
  from generate_series(1, 12);
$$;

-- ---------------------------------------------------------------------------
-- 内部：按 code 找账本，找不到就报错
-- ---------------------------------------------------------------------------
create or replace function public.tally_ledger_id(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  select id into v_id from ledgers where code = p_code;
  if v_id is null then
    raise exception '账本码不对' using errcode = 'P0002';
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 建账本：返回 { id, code }
-- ---------------------------------------------------------------------------
create or replace function public.tally_create(p_members jsonb, p_display text default 'HKD')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_code text; v_id uuid;
begin
  loop
    v_code := tally_gen_code();
    exit when not exists (select 1 from ledgers where code = v_code);
  end loop;

  insert into ledgers (code, members, display)
  values (v_code, coalesce(p_members, '[]'::jsonb), coalesce(p_display, 'HKD'))
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'code', v_code);
end;
$$;

-- ---------------------------------------------------------------------------
-- 拉取：p_since 之后有变动的记录。首次同步传 null 就是全量。
-- 字段名直接转成前端用的驼峰 / 简名，省得两边对不上。
-- ---------------------------------------------------------------------------
create or replace function public.tally_pull(p_code text, p_since timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid := tally_ledger_id(p_code);
  v_since timestamptz := coalesce(p_since, '-infinity'::timestamptz);
begin
  return jsonb_build_object(
    'serverTime', now(),
    'members', (select members from ledgers where id = v_id),
    'display', (select display from ledgers where id = v_id),
    'trips', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'from', t.from_date, 'to', t.to_date,
        'currency', t.currency, 'deleted', t.deleted, 'updatedAt', t.updated_at))
      from trips t where t.ledger_id = v_id and t.updated_at > v_since
    ), '[]'::jsonb),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'type', e.type, 'payerId', e.payer_id, 'amount', e.amount,
        'currency', e.currency, 'cat', e.cat, 'merchant', e.merchant, 'note', e.note,
        'date', e.entry_date, 'participants', coalesce(e.participants, '[]'::jsonb),
        'toId', e.to_id, 'tripId', e.trip_id, 'archivedAt', e.archived_at,
        'deleted', e.deleted, 'createdAt', e.created_at, 'updatedAt', e.updated_at))
      from entries e where e.ledger_id = v_id and e.updated_at > v_since
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 推送：按条 upsert，后写的赢。
-- 传数组进来，一次提交多条（离线攒下来的队列也是这样冲）。
-- ---------------------------------------------------------------------------
create or replace function public.tally_push(
  p_code    text,
  p_entries jsonb default '[]'::jsonb,
  p_trips   jsonb default '[]'::jsonb,
  p_members jsonb default null,
  p_display text  default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := tally_ledger_id(p_code);
  r jsonb;
begin
  for r in select * from jsonb_array_elements(coalesce(p_trips, '[]'::jsonb)) loop
    insert into trips (id, ledger_id, name, from_date, to_date, currency, deleted, updated_at)
    values (
      r->>'id', v_id, coalesce(r->>'name', ''),
      nullif(r->>'from', '')::date, nullif(r->>'to', '')::date,
      nullif(r->>'currency', ''), coalesce((r->>'deleted')::boolean, false), now())
    on conflict (id) do update set
      name = excluded.name, from_date = excluded.from_date, to_date = excluded.to_date,
      currency = excluded.currency, deleted = excluded.deleted, updated_at = now()
    where trips.ledger_id = v_id;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) loop
    insert into entries (id, ledger_id, type, payer_id, amount, currency, cat,
                         merchant, note, entry_date, participants, to_id, trip_id,
                         archived_at, deleted, created_at, updated_at)
    values (
      r->>'id', v_id, coalesce(r->>'type', 'expense'), r->>'payerId',
      (r->>'amount')::numeric, r->>'currency', nullif(r->>'cat', ''),
      nullif(r->>'merchant', ''), nullif(r->>'note', ''), (r->>'date')::date,
      coalesce(r->'participants', '[]'::jsonb), nullif(r->>'toId', ''),
      nullif(r->>'tripId', ''),
      nullif(r->>'archivedAt', '')::timestamptz,
      coalesce((r->>'deleted')::boolean, false),
      nullif(r->>'createdAt', '')::bigint, now())
    on conflict (id) do update set
      type = excluded.type, payer_id = excluded.payer_id, amount = excluded.amount,
      currency = excluded.currency, cat = excluded.cat, merchant = excluded.merchant,
      note = excluded.note, entry_date = excluded.entry_date,
      participants = excluded.participants, to_id = excluded.to_id,
      trip_id = excluded.trip_id, archived_at = excluded.archived_at,
      deleted = excluded.deleted, updated_at = now()
    where entries.ledger_id = v_id;
  end loop;

  if p_members is not null or p_display is not null then
    update ledgers set
      members = coalesce(p_members, members),
      display = coalesce(p_display, display),
      updated_at = now()
    where id = v_id;
  end if;

  return jsonb_build_object('serverTime', now());
end;
$$;

-- ---------------------------------------------------------------------------
-- 只把这几个函数开放给 anon，表本身依旧碰不到
-- ---------------------------------------------------------------------------
revoke execute on function public.tally_gen_code()  from anon, authenticated, public;
revoke execute on function public.tally_ledger_id(text) from anon, authenticated, public;

grant execute on function public.tally_create(jsonb, text) to anon;
grant execute on function public.tally_pull(text, timestamptz) to anon;
grant execute on function public.tally_push(text, jsonb, jsonb, jsonb, text) to anon;

-- ---------------------------------------------------------------------------
-- 跑完之后可以用这句自测一下（会真的建一个测试账本，记下返回的 code）：
--   select public.tally_create('[{"id":"a","name":"Chloe"},{"id":"b","name":"Wen"}]'::jsonb, 'HKD');
-- 然后：
--   select public.tally_pull('<上面返回的 code>');
-- 测完删掉：
--   delete from public.ledgers where code = '<那个 code>';
-- ---------------------------------------------------------------------------
