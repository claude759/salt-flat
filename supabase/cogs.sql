-- COGS page of the Production Pipeline app (pipeline.html, view "cogs"): flower cost of goods per grow and per harvest.
-- Gianni's, not the pipeline's: applied from Gianni's computer (~/claude-sql/run-sql-ca.mjs), never by the Pipeline deploy
-- job, and owned by postgres, so pipeline_owner (and so any change pushed to supabase/pipeline-*.sql) can't widen who sees
-- it. The page shows dollars (each grow's pay totals, rent, utilities): only the accounts in cogs_viewers see the tab or
-- the numbers. cogs_viewers is filled from Gianni's computer (the repo is public, so no email address is written here).
-- The data is one row, written by ~/ar-automation/cogs-sync.mjs (after the financials feed, 4 times a day) through
-- cogs_save(), token-gated; the token's hash is seeded from Gianni's computer, never committed. Safe to re-run.

create table if not exists public.cogs_viewers (
  email    text primary key check (email = lower(email)),
  added_at timestamptz not null default now()
);
alter table public.cogs_viewers enable row level security;   -- no policies: nobody reads or changes it through the API
revoke all on table public.cogs_viewers from anon, authenticated;

-- the signed-in caller's email in lower case, '' when there is none, read straight from the request's claims (the same
-- answer as pipeline_jwt_email(), kept separate so a change to the pipeline's functions can't change who sees COGS)
create or replace function public.cogs_jwt_email()
returns text
language sql stable
set search_path = ''
as $$
  select lower(coalesce(coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                                 nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'email', ''));
$$;
revoke all on function public.cogs_jwt_email() from public, anon;
grant execute on function public.cogs_jwt_email() to authenticated;

create or replace function public.cogs_can_view()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.cogs_viewers v where v.email = public.cogs_jwt_email() and v.email <> '');
$$;
revoke all on function public.cogs_can_view() from public, anon;
grant execute on function public.cogs_can_view() to authenticated;

create table if not exists public.cogs_snapshot (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null,           -- what the page draws (see ~/ar-automation/lib/cogs-core.mjs buildCogs)
  sig        text,                     -- the job's fingerprint of data, to skip unchanged saves
  synced_at  timestamptz,              -- the job's last run
  changed_at timestamptz               -- the last run that changed data
);
comment on table public.cogs_snapshot is
  'Flower COGS per grow and harvest for the COGS page of pipeline.html. Written only by cogs_save() from Gianni''s computer; read by cogs_viewers.';
alter table public.cogs_snapshot enable row level security;
revoke all on table public.cogs_snapshot from anon;
revoke insert, update, delete, truncate, references, trigger on table public.cogs_snapshot from authenticated;
grant select on table public.cogs_snapshot to authenticated;
drop policy if exists cogs_snapshot_select on public.cogs_snapshot;
create policy cogs_snapshot_select on public.cogs_snapshot
  for select to authenticated using (public.cogs_can_view());

create table if not exists public.cogs_secret (
  id         int primary key default 1 check (id = 1),
  token_hash text not null
);
alter table public.cogs_secret enable row level security;   -- no policies: nobody reads it
revoke all on table public.cogs_secret from anon, authenticated;

-- p_data null: nothing changed, only the sync time is stamped
create or replace function public.cogs_save(p_token text, p_data jsonb, p_sig text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_changed boolean := false;
begin
  if not exists (select 1 from public.cogs_secret
                 where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex')) then
    raise exception 'bad token';
  end if;
  if p_data is null then
    update public.cogs_snapshot set synced_at = now() where id = 1;
    return jsonb_build_object('ok', true, 'changed', false);
  end if;
  if jsonb_typeof(p_data) <> 'object' or jsonb_typeof(p_data->'facilities') <> 'array'
     or jsonb_array_length(p_data->'facilities') < 1 then
    raise exception 'p_data must be the whole COGS snapshot';   -- an empty build must never wipe what the page shows
  end if;
  select coalesce(s.sig, '') is distinct from coalesce(p_sig, '') into v_changed from public.cogs_snapshot s where s.id = 1;
  insert into public.cogs_snapshot as s (id, data, sig, synced_at, changed_at)
  values (1, p_data, p_sig, now(), now())
  on conflict (id) do update set data = excluded.data, sig = excluded.sig, synced_at = now(),
    changed_at = case when s.sig is distinct from excluded.sig then now() else s.changed_at end;
  return jsonb_build_object('ok', true, 'changed', coalesce(v_changed, true));
end $$;
revoke all on function public.cogs_save(text, jsonb, text) from public;
grant execute on function public.cogs_save(text, jsonb, text) to anon, authenticated;
