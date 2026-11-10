-- Production Pipeline page (pipeline.html): editing Victoria's sheet from the app (release 1a).
-- The page never writes to Google itself. It sends each edit to the Edge Function pipeline-sheet-write
-- (supabase/functions/pipeline-sheet-write/, owned by Gianni's Claude; CONTRACT.md there is the agreement with the
-- page). The function checks the edit against the sheet as it is right now, writes it with its own Google account,
-- and logs it here with each cell's earlier text and colored words, so one click can undo it.
--   pipeline_editors          who may edit: scope 'plan' (DISTRO PIPELINE), 'supply' (the two supply tabs) or 'all'
--   pipeline_can_edit(scope)  true when the signed-in caller is an editor for that scope
--   pipeline_write_settings   the switches, one row; no policies, so only the save program (service role) reads it
--   pipeline_edit_status()    what the page needs to show Edit: can_plan, can_supply, enabled, test_mode, target, tabs_on
--   pipeline_edits            the log of every save, dry run, refusal and conflict; read by pipeline_can_view() accounts
--   pipeline_edit_locks       a short lock per cell, so two saves of one cell cannot both run (save program only)
-- Editors and the settings row are seeded out-of-band (emails and file ids are never committed). Safe to re-run.

create table if not exists public.pipeline_editors (
  email    text primary key check (email = lower(email)),
  scope    text not null default 'plan' check (scope in ('plan', 'supply', 'all')),
  added_at timestamptz not null default now()
);
comment on table public.pipeline_editors is
  'Who may edit the Production Pipeline sheet from the app (pipeline-sheet-write). Changed from Gianni''s computer only.';
alter table public.pipeline_editors enable row level security;   -- no policies: read only through pipeline_can_edit()
revoke all on table public.pipeline_editors from anon, authenticated;

create or replace function public.pipeline_can_edit(p_scope text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(p_scope in ('plan', 'supply'), false)
     and exists (select 1 from public.pipeline_editors e
                 where e.email = lower(coalesce(auth.jwt()->>'email', ''))
                   and e.email like '%@wizardtrees.com'
                   and e.scope in ('all', p_scope));
$$;
revoke all on function public.pipeline_can_edit(text) from public, anon;
grant execute on function public.pipeline_can_edit(text) to authenticated;

create table if not exists public.pipeline_write_settings (
  id            int primary key default 1 check (id = 1),
  enabled       boolean not null default false,          -- the master switch
  test_mode     boolean not null default true,           -- check and plan every save, never write
  target        text not null default 'test' check (target in ('test', 'live')),
  test_workbook text,                                    -- id of the private test copy (target 'test')
  tabs_on       text[] not null default '{}'
                check (tabs_on <@ array['DISTRO PIPELINE', 'DISTRO SUPPLY', 'ACCESSORY SUPPLY']::text[]),
  updated_at    timestamptz not null default now()
);
comment on table public.pipeline_write_settings is
  'Switches for pipeline-sheet-write. Target ''live'' writes the workbook in schedule_board (state CA). '
  'No policies: only the service role reads it, so test_workbook never reaches a browser.';
alter table public.pipeline_write_settings enable row level security;   -- no policies: nobody reads it from the page
revoke all on table public.pipeline_write_settings from anon, authenticated;

-- what the page needs to decide whether to show Edit (never a workbook id)
create or replace function public.pipeline_edit_status()
returns json
language sql stable security definer
set search_path = public
as $$
  select json_build_object(
    'can_plan',   public.pipeline_can_edit('plan'),
    'can_supply', public.pipeline_can_edit('supply'),
    'enabled',    coalesce(s.enabled, false),
    'test_mode',  coalesce(s.test_mode, true),
    'target',     coalesce(s.target, 'test'),
    'tabs_on',    coalesce(to_json(s.tabs_on), '[]'::json))
  from (select 1) one
  left join public.pipeline_write_settings s on s.id = 1;
$$;
revoke all on function public.pipeline_edit_status() from public, anon;
grant execute on function public.pipeline_edit_status() to authenticated;

-- One row per save attempt. cells: [{tab, r, c, a1, find, moved, before: {text, runs, number}, after: {...}}], where
-- runs are the cell's textFormatRuns (its colored words) as the Sheets API gave them. Written only by the save
-- program (service role); the person is stamped there from their sign-in, never sent by the page.
create table if not exists public.pipeline_edits (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  email     text not null,
  uid       uuid,
  intent    text,                                         -- what they meant, e.g. "VOODOO 1g 600 to 450, every day"
  action    text not null check (action in ('write', 'dry', 'undo')),
  target    text not null check (target in ('test', 'live')),
  status    text not null check (status in ('dry', 'written', 'refused', 'conflict', 'failed')),
  cells     jsonb not null default '[]'::jsonb,
  message   text,                                         -- what the person was told, or why it failed
  undo_of   bigint references public.pipeline_edits(id),  -- this row undid that edit
  undone_by bigint references public.pipeline_edits(id)   -- this edit was undone by that row
);
comment on table public.pipeline_edits is
  'Log and undo record of Production Pipeline sheet edits made from the app (pipeline-sheet-write). '
  'Written by the Edge Function with the service role; read by pipeline_can_view() accounts.';
create index if not exists pipeline_edits_at on public.pipeline_edits (at desc);
alter table public.pipeline_edits enable row level security;
drop policy if exists pipeline_edits_select on public.pipeline_edits;
create policy pipeline_edits_select on public.pipeline_edits
  for select to authenticated using (public.pipeline_can_view());
revoke all on table public.pipeline_edits from anon;
revoke insert, update, delete, truncate, references, trigger on table public.pipeline_edits from authenticated;

-- cell_key = '<target>:<tab>!<A1>'. A lock lasts for the save (a few seconds) and expires by itself if the save dies.
create table if not exists public.pipeline_edit_locks (
  cell_key   text primary key,
  expires_at timestamptz not null,
  email      text,                                        -- who is saving, so the other person can be told
  token      text                                         -- the save that holds it; unlocking needs it
);
alter table public.pipeline_edit_locks enable row level security;   -- no policies: save program only
revoke all on table public.pipeline_edit_locks from anon, authenticated;

-- All or nothing: either every key is locked for this save, or none is and the reply names who holds one.
create or replace function public.pipeline_lock_cells(p_keys text[], p_seconds int default 30,
                                                      p_email text default null, p_token text default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare v_cell text; v_email text;
begin
  if p_keys is null or cardinality(p_keys) = 0 then return jsonb_build_object('ok', true); end if;
  delete from public.pipeline_edit_locks where expires_at < now();
  begin
    insert into public.pipeline_edit_locks (cell_key, expires_at, email, token)
    select distinct k, now() + make_interval(secs => greatest(1, least(coalesce(p_seconds, 30), 300))), p_email, p_token
      from unnest(p_keys) as k
     where k is not null
     order by 1;   -- the same order in every save, so two saves on overlapping cells wait instead of deadlocking
  exception when unique_violation then
    select l.cell_key, l.email into v_cell, v_email
      from public.pipeline_edit_locks l where l.cell_key = any(p_keys) limit 1;
    return jsonb_build_object('ok', false, 'cell', v_cell, 'email', v_email);
  end;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.pipeline_lock_cells(text[], int, text, text) from public, anon, authenticated;
grant execute on function public.pipeline_lock_cells(text[], int, text, text) to service_role;

-- Releases this save's locks (p_token), or the named keys whoever holds them when p_token is null.
create or replace function public.pipeline_unlock_cells(p_keys text[], p_token text default null)
returns int
language plpgsql security definer
set search_path = public
as $$
declare n int;
begin
  delete from public.pipeline_edit_locks
   where cell_key = any(p_keys) and (p_token is null or token = p_token);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.pipeline_unlock_cells(text[], text) from public, anon, authenticated;
grant execute on function public.pipeline_unlock_cells(text[], text) to service_role;
