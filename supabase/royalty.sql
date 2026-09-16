-- Royalty / licensing dashboard (royalty.html): Waf & Gus LLC QuickBooks open balances and
-- payments per licensing partner. One snapshot row, rewritten hourly by the Mac-side producer
-- (~/ar-automation/lib/royalty-feed.mjs). Viewers read ONLY through royalty_read(p_key), which
-- resolves the key to a scope and returns just that scope's slice:
--   all      = the team board (every partner, other licensing customers, anomalies); the
--              admin-only material (CA intercompany detail, config, realm id) is stripped here
--   admin    = the whole snapshot; may also write config (royalty_save_config)
--   partner:<key> = that partner's public statement slice only
--   producer = write-only (royalty_save); the only scope that can write data
-- Unlike olympic_tracker there is NO select policy on the snapshot: the anon key is public
-- (it sits in the page source on a public Pages repo), so a select policy would make every
-- partner's balances world-readable. RLS on + zero policies = nothing reachable except the RPCs.
-- Key hashes are inserted out of band (see the minting note at the bottom); never committed.

create table if not exists public.royalty_snapshot (
  id text primary key default 'main' check (id = 'main'),
  data jsonb not null default '{}'::jsonb,     -- producer-owned: {meta, config, states, totals, partners:{<key>: public slice}, team:{...}}
  config jsonb not null default '{}'::jsonb,   -- admin-owned overrides (unused in v1; reserved for an in-page editor)
  generated_at timestamptz,                    -- when the producer pulled QBO
  rev bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.royalty_snapshot enable row level security;   -- RLS on, NO policies
insert into public.royalty_snapshot (id) values ('main') on conflict do nothing;

create table if not exists public.royalty_keys (
  key_hash text primary key,                   -- encode(sha256(convert_to(plaintext,'utf8')),'hex')
  scope text not null check (scope in ('all','admin','producer') or scope like 'partner:%'),
  label text not null,                         -- who holds it: 'Gianni', 'The Flowery', 'run-nightly producer'
  created_at timestamptz not null default now(),
  revoked_at timestamptz                       -- set instead of deleting: keeps the audit trail
);
alter table public.royalty_keys enable row level security;       -- RLS on, NO policies

-- Resolve a plaintext key to its scope; null when unknown or revoked. Internal only (not granted).
create or replace function public.royalty_scope_of(p_key text)
returns text language sql security definer set search_path = public stable as $$
  select scope from public.royalty_keys
   where key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'utf8')), 'hex')
     and revoked_at is null
$$;
-- Supabase's default privileges hand anon/authenticated EXECUTE on every new public function,
-- so the revoke must name them explicitly (revoking from public alone leaves it callable).
revoke all on function public.royalty_scope_of(text) from public, anon, authenticated;

create or replace function public.royalty_read(p_key text)
returns jsonb language plpgsql security definer set search_path = public stable as $$
declare s text; snap public.royalty_snapshot%rowtype; pk text;
begin
  s := public.royalty_scope_of(p_key);
  if s is null or s = 'producer' then raise exception 'bad key'; end if;
  select * into snap from public.royalty_snapshot where id = 'main';
  if s = 'admin' then
    return jsonb_build_object('ok', true, 'scope', s, 'rev', snap.rev, 'generated_at', snap.generated_at,
                              'data', snap.data, 'config', snap.config);
  end if;
  if s = 'all' then
    -- team board: everything except the admin-only material. The footer tie-out still works because
    -- meta.reconciliation keeps the intercompany TOTAL; only the per-company detail is admin.
    return jsonb_build_object('ok', true, 'scope', s, 'rev', snap.rev, 'generated_at', snap.generated_at,
      'data', jsonb_set(jsonb_set(snap.data - 'config', '{team}', coalesce(snap.data->'team', '{}'::jsonb) - 'intercompany'),
                        '{meta}', coalesce(snap.data->'meta', '{}'::jsonb) - 'realm_id'),
      'config', '{}'::jsonb);
  end if;
  pk := substr(s, 9);   -- after 'partner:'
  -- Partner branch: only meta essentials + that partner's PUBLIC slice. Nothing under
  -- data.team, data.config, data.states, data.totals or another partner can reach this key.
  -- A partner missing from the snapshot (minted before its first pull) gets an empty slice,
  -- not 'bad key', so the link keeps working.
  return jsonb_build_object('ok', true, 'scope', s, 'partner', pk, 'rev', snap.rev, 'generated_at', snap.generated_at,
    'data', jsonb_build_object(
      'meta', jsonb_build_object(
        'generated_at', snap.data->'meta'->'generated_at',
        'as_of',        snap.data->'meta'->'as_of',
        'year',         snap.data->'meta'->'year',
        'company_name', snap.data->'meta'->'company_name',
        'contact_from', snap.data->'meta'->'contact_from'),
      'partners', jsonb_build_object(pk, coalesce(snap.data->'partners'->pk, '{}'::jsonb))),
    'config', '{}'::jsonb);
end $$;
revoke all on function public.royalty_read(text) from public;
grant execute on function public.royalty_read(text) to anon, authenticated;

-- Cheap freshness probe for pollers: rev + generated_at only (a few bytes instead of the ~150 KB
-- snapshot), so an open tab polling every 5 minutes and the watchdog every 30 minutes cost no
-- egress until something actually changed. Same key rules as royalty_read.
create or replace function public.royalty_rev(p_key text)
returns jsonb language plpgsql security definer set search_path = public stable as $$
declare s text; snap public.royalty_snapshot%rowtype;
begin
  s := public.royalty_scope_of(p_key);
  if s is null or s = 'producer' then raise exception 'bad key'; end if;
  select * into snap from public.royalty_snapshot where id = 'main';
  return jsonb_build_object('ok', true, 'scope', s, 'rev', snap.rev, 'generated_at', snap.generated_at);
end $$;
revoke all on function public.royalty_rev(text) from public;
grant execute on function public.royalty_rev(text) to anon, authenticated;

-- Producer write: replaces data wholesale (every run is a full QBO re-pull, so no rev merge).
-- Producer-ONLY: the admin key lives in a browser's localStorage, so it must never be able to
-- rewrite what every viewer sees; the producer token never enters a browser.
create or replace function public.royalty_save(p_token text, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s text; newrev bigint;
begin
  s := public.royalty_scope_of(p_token);
  if s is null or s <> 'producer' then raise exception 'bad token'; end if;
  update public.royalty_snapshot
     set data = p_data,
         generated_at = coalesce((p_data->'meta'->>'generated_at')::timestamptz, now()),
         rev = rev + 1, updated_at = now()
   where id = 'main' returning rev into newrev;
  return jsonb_build_object('ok', true, 'rev', newrev);
end $$;
revoke all on function public.royalty_save(text, jsonb) from public;
grant execute on function public.royalty_save(text, jsonb) to anon, authenticated;

-- Admin config write (separate column so a producer data write can never clobber it).
create or replace function public.royalty_save_config(p_token text, p_config jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s text; newrev bigint;
begin
  s := public.royalty_scope_of(p_token);
  if s is null or s <> 'admin' then raise exception 'bad token'; end if;
  update public.royalty_snapshot set config = p_config, rev = rev + 1, updated_at = now()
   where id = 'main' returning rev into newrev;
  return jsonb_build_object('ok', true, 'rev', newrev);
end $$;
revoke all on function public.royalty_save_config(text, jsonb) from public;
grant execute on function public.royalty_save_config(text, jsonb) to anon, authenticated;

-- Minting a key (run out of band, never commit the plaintext or the hash):
--   plaintext: node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"
--   insert into public.royalty_keys (key_hash, scope, label)
--     values (encode(sha256(convert_to('<plaintext>', 'utf8')), 'hex'), 'partner:flowery', 'The Flowery');
-- Revoke: update public.royalty_keys set revoked_at = now() where label = 'The Flowery';
-- Post-apply checks: both tables rowsecurity = true with 0 policies;
--   anon GET /rest/v1/royalty_snapshot?select=id returns [] ; rpc/royalty_read {"p_key":"nope"} -> 400 'bad key'.
