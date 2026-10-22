-- Wizard Trees financials board (financials.html): monthly P&L, EBITDA, balance sheets and
-- intercompany eliminations for the 7 companies, pulled from QuickBooks by a Mac-side producer
-- (~/ar-automation/lib/financials-feed.mjs). Same hardened pattern as royalty.sql:
--   one snapshot row, RLS on with ZERO policies, reads ONLY through fin_read(p_key), which
--   resolves the key to a scope server-side.
--   admin    = Gianni's link (whole snapshot)
--   viewer   = an owner's link (whole snapshot; v1 shows the same board)
--   producer = write-only (fin_save); the only scope that can write data
-- The anon key is public (it sits in the page source on a public Pages repo), so never add a
-- select policy on fin_snapshot. Key hashes are inserted out of band by
-- ~/ar-automation/tools/financials-key.mjs; plaintexts are never committed.

create table if not exists public.fin_snapshot (
  id text primary key default 'main' check (id = 'main'),
  data jsonb not null default '{}'::jsonb,     -- producer-owned: {meta, companies, eliminations, consolidated, ...}
  generated_at timestamptz,                    -- when the producer pulled QuickBooks
  rev bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.fin_snapshot enable row level security;      -- RLS on, NO policies
insert into public.fin_snapshot (id) values ('main') on conflict do nothing;

create table if not exists public.fin_keys (
  key_hash text primary key,                   -- encode(sha256(convert_to(plaintext,'utf8')),'hex')
  scope text not null check (scope in ('admin','viewer','producer')),
  label text not null,                         -- who holds it: 'Gianni', 'Scott', 'financials producer'
  created_at timestamptz not null default now(),
  revoked_at timestamptz                       -- set instead of deleting: keeps the audit trail
);
alter table public.fin_keys enable row level security;          -- RLS on, NO policies

create or replace function public.fin_scope_of(p_key text)
returns text language sql security definer set search_path = public stable as $$
  select scope from public.fin_keys
   where key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'utf8')), 'hex')
     and revoked_at is null
$$;
-- Supabase's default privileges hand anon/authenticated EXECUTE on every new public function,
-- so the revoke must name them explicitly.
revoke all on function public.fin_scope_of(text) from public, anon, authenticated;

create or replace function public.fin_read(p_key text)
returns jsonb language plpgsql security definer set search_path = public stable as $$
declare s text; snap public.fin_snapshot%rowtype;
begin
  s := public.fin_scope_of(p_key);
  if s is null or s = 'producer' then raise exception 'bad key'; end if;
  select * into snap from public.fin_snapshot where id = 'main';
  return jsonb_build_object('ok', true, 'scope', s, 'rev', snap.rev, 'generated_at', snap.generated_at, 'data', snap.data);
end $$;
revoke all on function public.fin_read(text) from public;
grant execute on function public.fin_read(text) to anon, authenticated;

-- Cheap freshness probe (a few bytes instead of the snapshot).
create or replace function public.fin_rev(p_key text)
returns jsonb language plpgsql security definer set search_path = public stable as $$
declare s text; snap public.fin_snapshot%rowtype;
begin
  s := public.fin_scope_of(p_key);
  if s is null or s = 'producer' then raise exception 'bad key'; end if;
  select * into snap from public.fin_snapshot where id = 'main';
  return jsonb_build_object('ok', true, 'scope', s, 'rev', snap.rev, 'generated_at', snap.generated_at);
end $$;
revoke all on function public.fin_rev(text) from public;
grant execute on function public.fin_rev(text) to anon, authenticated;

-- Producer write: replaces data wholesale (every run is a full QuickBooks re-pull).
create or replace function public.fin_save(p_token text, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s text; newrev bigint;
begin
  s := public.fin_scope_of(p_token);
  if s is null or s <> 'producer' then raise exception 'bad token'; end if;
  update public.fin_snapshot
     set data = p_data,
         generated_at = coalesce((p_data->'meta'->>'generated_at')::timestamptz, now()),
         rev = rev + 1, updated_at = now()
   where id = 'main' returning rev into newrev;
  return jsonb_build_object('ok', true, 'rev', newrev);
end $$;
revoke all on function public.fin_save(text, jsonb) from public;
grant execute on function public.fin_save(text, jsonb) to anon, authenticated;

-- Post-apply checks: both tables rowsecurity = true with 0 policies;
--   anon GET /rest/v1/fin_snapshot?select=id returns [] ; rpc/fin_read {"p_key":"nope"} -> 400 'bad key'.
