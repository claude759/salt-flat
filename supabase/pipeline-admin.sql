set role pipeline_owner;
-- Production Pipeline page (pipeline.html): the Admin page (behind ?beta). A pipeline admin manages, from the page,
-- who may change the sheet from the app and the switches of the save program (pipeline-sheet-write), with no SQL and
-- no one else's computer, and every change is logged here.
--   pipeline admin                     is_universal_admin(), or a pipeline_editors row with admin = true
--   pipeline_is_admin()                true when the signed-in caller is a pipeline admin (the page shows the tab then)
--   pipeline_admin_editors()           the editors list
--   pipeline_admin_editor_add(...)     add an editor; someone already on the list is refused and left as they are
--   pipeline_admin_editor_set(...)     add an editor or change one (email, scope plan|supply|all, admin)
--   pipeline_admin_editor_remove(...)  take an editor off the list (never the last admin)
--   pipeline_admin_settings()          the switches, whether a test copy is set, and the test copy's id
--   pipeline_admin_settings_set(...)   change the switches; an argument left out (null) stays as it is. A change that
--                                      lets Save write to the live sheet (or more of it) needs p_live_ok => true
--   pipeline_admin_log                 every change made through these: who, when, what (never a sheet id)
--   pipeline_admin_log_list(n)         the latest n changes
-- Every pipeline_admin_* function refuses anyone who is not a pipeline admin. The caller's email comes from
-- pipeline_jwt_email() (pipeline-access.sql); the tables are in pipeline-edits.sql, applied before this file.
-- No emails or file ids are in this file: admins add them from the page. Safe to re-run.

-- an editor marked admin may use the Admin page too
alter table public.pipeline_editors
  add column if not exists admin boolean not null default false;
comment on column public.pipeline_editors.admin is
  'A pipeline admin: may use the Admin page (editors and switches). Universal admins always may.';

create table if not exists public.pipeline_admin_log (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  email   text not null,                                   -- who made the change, from their sign-in
  action  text not null check (action in ('editor_add', 'editor_change', 'editor_remove', 'settings')),
  subject text,                                            -- the editor added, changed or removed; null for settings
  before  jsonb,                                           -- what it was (null for an add)
  after   jsonb                                            -- what it is now (null for a remove)
);
comment on table public.pipeline_admin_log is
  'Every change made on the Production Pipeline Admin page. Written only by the pipeline_admin_* functions; '
  'read through pipeline_admin_log_list(). Holds no sheet ids: a test copy change is logged as set, changed or cleared.';
create index if not exists pipeline_admin_log_at on public.pipeline_admin_log (at desc);
alter table public.pipeline_admin_log enable row level security;   -- no policies: only the functions below read it
revoke all on table public.pipeline_admin_log from public, anon, authenticated;

-- true when the signed-in caller may use the Admin page
create or replace function public.pipeline_is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.is_universal_admin()
      or exists (select 1 from public.pipeline_editors e
                 where e.admin
                   and e.email = public.pipeline_jwt_email()
                   and e.email like '%@wizardtrees.com');
$$;
revoke all on function public.pipeline_is_admin() from public, anon, service_role;
grant execute on function public.pipeline_is_admin() to authenticated;

-- the editors list: [{email, scope, admin, added_at}], by email
create or replace function public.pipeline_admin_editors()
returns json
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public.pipeline_is_admin() then
    raise exception 'Only pipeline admins can see this.' using errcode = '42501';
  end if;
  return coalesce((select json_agg(json_build_object('email', e.email, 'scope', e.scope, 'admin', e.admin,
                                                     'added_at', e.added_at) order by e.email)
                     from public.pipeline_editors e), '[]'::json);
end $$;
revoke all on function public.pipeline_admin_editors() from public, anon, service_role;
grant execute on function public.pipeline_admin_editors() to authenticated;

-- Adds an editor, or changes one's scope or admin flag. p_admin null keeps the flag as it is (false for someone new).
-- A new editor is also put on pipeline_viewers, so they can open the page they may now change.
-- Returns {email, scope, admin, added_at, added}.
create or replace function public.pipeline_admin_editor_set(p_email text, p_scope text, p_admin boolean default null)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_me     text := coalesce(nullif(public.pipeline_jwt_email(), ''), 'unknown');
  v_old    public.pipeline_editors;
  v_new    public.pipeline_editors;
  v_admin  boolean;
  v_viewer boolean := false;
begin
  if not public.pipeline_is_admin() then
    raise exception 'Only pipeline admins can change who edits the sheet.' using errcode = '42501';
  end if;
  if v_email !~ '^[a-z0-9._%+-]+@wizardtrees[.]com$' then
    raise exception 'Use their Wizard Trees Google account (the address ends in @wizardtrees.com).' using errcode = '22023';
  end if;
  if p_scope is null or p_scope not in ('plan', 'supply', 'all') then
    raise exception 'Pick what they may change: the plan, the supplies, or both.' using errcode = '22023';
  end if;
  -- one admin change at a time, so two admins at once can never both take away the last admin
  lock table public.pipeline_editors in share row exclusive mode;
  select * into v_old from public.pipeline_editors where email = v_email;
  v_admin := coalesce(p_admin, v_old.admin, false);
  if v_old.email is not null and v_old.admin and not v_admin
     and not exists (select 1 from public.pipeline_editors where admin and email <> v_email) then
    raise exception 'They are the only admin on the list, so they stay an admin. Make someone else an admin first.'
      using errcode = '22023';
  end if;

  if v_old.email is null then
    insert into public.pipeline_editors (email, scope, admin) values (v_email, p_scope, v_admin)
      returning * into v_new;
    insert into public.pipeline_viewers (email) values (v_email) on conflict (email) do nothing;
    v_viewer := found;
    insert into public.pipeline_admin_log (email, action, subject, after)
    values (v_me, 'editor_add', v_email,
            jsonb_build_object('scope', v_new.scope, 'admin', v_new.admin, 'viewer_added', v_viewer));
  elsif v_old.scope is distinct from p_scope or v_old.admin is distinct from v_admin then
    update public.pipeline_editors set scope = p_scope, admin = v_admin where email = v_email
      returning * into v_new;
    insert into public.pipeline_admin_log (email, action, subject, before, after)
    values (v_me, 'editor_change', v_email,
            jsonb_build_object('scope', v_old.scope, 'admin', v_old.admin),
            jsonb_build_object('scope', v_new.scope, 'admin', v_new.admin));
  else
    v_new := v_old;   -- nothing to change, nothing logged
  end if;
  return json_build_object('email', v_new.email, 'scope', v_new.scope, 'admin', v_new.admin,
                           'added_at', v_new.added_at, 'added', v_old.email is null);
end $$;
revoke all on function public.pipeline_admin_editor_set(text, text, boolean) from public, anon, service_role;
grant execute on function public.pipeline_admin_editor_set(text, text, boolean) to authenticated;

-- Adds a new editor, and only that: someone already on the list is refused (hint 'editor-exists') and left exactly as
-- they are, so an Add pressed on a page that has not caught up with another admin's change can never rewrite their
-- scope or admin flag. Checked under the same table lock pipeline_admin_editor_set takes, which then does the add.
-- Returns {email, scope, admin, added_at, added}.
create or replace function public.pipeline_admin_editor_add(p_email text, p_scope text, p_admin boolean default false)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not public.pipeline_is_admin() then
    raise exception 'Only pipeline admins can change who edits the sheet.' using errcode = '42501';
  end if;
  lock table public.pipeline_editors in share row exclusive mode;
  if exists (select 1 from public.pipeline_editors where email = v_email) then
    raise exception 'They are already on the editors list, so nothing was changed. Press Change on their line to change what they can do.'
      using errcode = '22023', hint = 'editor-exists';
  end if;
  return public.pipeline_admin_editor_set(v_email, p_scope, coalesce(p_admin, false));
end $$;
revoke all on function public.pipeline_admin_editor_add(text, text, boolean) from public, anon, service_role;
grant execute on function public.pipeline_admin_editor_add(text, text, boolean) to authenticated;

-- Takes an editor off the list (they keep seeing the page if they are on pipeline_viewers). Never the last admin,
-- which also means an admin can never remove themselves while they are the last one. Returns {removed}.
create or replace function public.pipeline_admin_editor_remove(p_email text)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_me    text := coalesce(nullif(public.pipeline_jwt_email(), ''), 'unknown');
  v_old   public.pipeline_editors;
begin
  if not public.pipeline_is_admin() then
    raise exception 'Only pipeline admins can change who edits the sheet.' using errcode = '42501';
  end if;
  lock table public.pipeline_editors in share row exclusive mode;
  select * into v_old from public.pipeline_editors where email = v_email;
  if v_old.email is null then
    raise exception 'That person is not on the editors list.' using errcode = '22023';
  end if;
  if v_old.admin and not exists (select 1 from public.pipeline_editors where admin and email <> v_email) then
    raise exception 'They are the only admin on the list, so they cannot be removed. Make someone else an admin first.'
      using errcode = '22023';
  end if;
  delete from public.pipeline_editors where email = v_email;   -- the one row named, by its primary key
  insert into public.pipeline_admin_log (email, action, subject, before)
  values (v_me, 'editor_remove', v_email, jsonb_build_object('scope', v_old.scope, 'admin', v_old.admin));
  return json_build_object('removed', v_email);
end $$;
revoke all on function public.pipeline_admin_editor_remove(text) from public, anon, service_role;
grant execute on function public.pipeline_admin_editor_remove(text) to authenticated;

-- The switches as the save program reads them. test_workbook (the test copy's id) goes only to pipeline admins: this
-- whole function is admin-only; everyone else gets has_test_copy at most, through pipeline_edit_status().
create or replace function public.pipeline_admin_settings()
returns json
language plpgsql stable security definer
set search_path = public
as $$
declare s public.pipeline_write_settings;
begin
  if not public.pipeline_is_admin() then
    raise exception 'Only pipeline admins can see this.' using errcode = '42501';
  end if;
  select * into s from public.pipeline_write_settings where id = 1;
  return json_build_object(
    'set_up',        s.id is not null,
    'enabled',       coalesce(s.enabled, false),
    'test_mode',     coalesce(s.test_mode, true),
    'target',        coalesce(s.target, 'test'),
    'tabs_on',       coalesce(to_json(s.tabs_on), '[]'::json),
    'kinds_on',      coalesce(to_json(s.kinds_on), '["rewrite"]'::json),
    'has_test_copy', nullif(btrim(coalesce(s.test_workbook, '')), '') is not null,
    'test_workbook', nullif(btrim(coalesce(s.test_workbook, '')), ''),
    'updated_at',    s.updated_at);
end $$;
revoke all on function public.pipeline_admin_settings() from public, anon, service_role;
grant execute on function public.pipeline_admin_settings() to authenticated;

-- Changes the switches, checked like the table's own checks. Each argument left null stays as it is; p_test_workbook
-- '' clears the test copy. Tabs and kinds are kept in a fixed order with no repeats. The test copy can never be the
-- live workbook. Logs what changed (the test copy only as set, changed or cleared) and returns the new switches,
-- shaped like pipeline_admin_settings().
-- Real writes to the live sheet: Save writes it when saving is on, test mode is off, the target is live and at least
-- one tab and one kind of change are on. A change that makes that true, or adds a tab or a kind while it is true, is
-- refused (hint 'confirm-live', nothing changed) unless p_live_ok is true. It is judged here, under the row lock, on the
-- switches as they are now, so a page showing switches another admin has since changed still has to ask first.
-- (The earlier version had no p_live_ok: dropped, so no call can reach it and PostgREST never has two to choose from.)
drop function if exists public.pipeline_admin_settings_set(boolean, boolean, text, text[], text[], text);
create or replace function public.pipeline_admin_settings_set(
  p_enabled       boolean default null,
  p_test_mode     boolean default null,
  p_target        text    default null,
  p_tabs_on       text[]  default null,
  p_kinds_on      text[]  default null,
  p_test_workbook text    default null,
  p_live_ok       boolean default null)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  c_tabs  constant text[] := array['DISTRO PIPELINE', 'DISTRO SUPPLY', 'ACCESSORY SUPPLY'];
  c_kinds constant text[] := array['rewrite', 'add'];
  v_me    text := coalesce(nullif(public.pipeline_jwt_email(), ''), 'unknown');
  v_old   public.pipeline_write_settings;
  v_new   public.pipeline_write_settings;
  v_copy  text;
  v_live  text;
  v_b     jsonb;
  v_a     jsonb;
  v_was   boolean;
  v_now   boolean;
begin
  if not public.pipeline_is_admin() then
    raise exception 'Only pipeline admins can change these switches.' using errcode = '42501';
  end if;
  if p_target is not null and p_target not in ('test', 'live') then
    raise exception 'Saves go either to the test copy or to the real sheet.' using errcode = '22023';
  end if;
  if p_tabs_on is not null and exists (select 1 from unnest(p_tabs_on) t where t is null or not (t = any (c_tabs))) then
    raise exception 'The app can change only the DISTRO PIPELINE, DISTRO SUPPLY and ACCESSORY SUPPLY tabs.'
      using errcode = '22023';
  end if;
  if p_kinds_on is not null and exists (select 1 from unnest(p_kinds_on) k where k is null or not (k = any (c_kinds))) then
    raise exception 'The kinds of change are changing lines and adding lines.' using errcode = '22023';
  end if;
  if p_test_workbook is not null then
    v_copy := nullif(btrim(p_test_workbook), '');
    if v_copy is not null and v_copy !~ '^[A-Za-z0-9_-]{20,100}$' then
      raise exception 'That does not look like a Google Sheets address.' using errcode = '22023';
    end if;
    if v_copy is not null then
      begin
        v_live := public.schedule_board_ca_workbook();
      exception when undefined_function then
        v_live := null;   -- the bridge is made by the one-time setup; the page checks this too
      end;
      if v_copy = v_live then
        raise exception 'That is the real sheet the crew works from, not a test copy. Make a copy of it and use the copy.'
          using errcode = '22023';
      end if;
    end if;
  end if;

  insert into public.pipeline_write_settings (id) values (1) on conflict (id) do nothing;
  select * into v_old from public.pipeline_write_settings where id = 1 for update;
  v_new := v_old;
  v_new.enabled   := coalesce(p_enabled, v_old.enabled);
  v_new.test_mode := coalesce(p_test_mode, v_old.test_mode);
  v_new.target    := coalesce(p_target, v_old.target);
  if p_tabs_on is not null then
    v_new.tabs_on := array(select t from unnest(c_tabs) with ordinality u(t, i) where t = any (p_tabs_on) order by i);
  end if;
  if p_kinds_on is not null then
    v_new.kinds_on := array(select k from unnest(c_kinds) with ordinality u(k, i) where k = any (p_kinds_on) order by i);
  end if;
  if p_test_workbook is not null then
    v_new.test_workbook := v_copy;
  end if;

  -- a change that starts real writes to the live sheet, or lets them reach another tab or kind of change, needs a yes
  v_was := v_old.enabled and not v_old.test_mode and v_old.target = 'live'
           and cardinality(v_old.tabs_on) > 0 and cardinality(v_old.kinds_on) > 0;
  v_now := v_new.enabled and not v_new.test_mode and v_new.target = 'live'
           and cardinality(v_new.tabs_on) > 0 and cardinality(v_new.kinds_on) > 0;
  if v_now and not coalesce(p_live_ok, false)
     and (not v_was
          or exists (select 1 from unnest(v_new.tabs_on) t where not (t = any (v_old.tabs_on)))
          or exists (select 1 from unnest(v_new.kinds_on) k where not (k = any (v_old.kinds_on)))) then
    raise exception 'This change would let saves from the app write to the real sheet the crew works from, so it needs a clear yes first. Nothing was changed.'
      using errcode = '22023', hint = 'confirm-live';
  end if;

  v_b := jsonb_build_object('enabled', v_old.enabled, 'test_mode', v_old.test_mode, 'target', v_old.target,
                            'tabs_on', to_jsonb(v_old.tabs_on), 'kinds_on', to_jsonb(v_old.kinds_on),
                            'test_copy', nullif(btrim(coalesce(v_old.test_workbook, '')), '') is not null);
  v_a := jsonb_build_object('enabled', v_new.enabled, 'test_mode', v_new.test_mode, 'target', v_new.target,
                            'tabs_on', to_jsonb(v_new.tabs_on), 'kinds_on', to_jsonb(v_new.kinds_on),
                            'test_copy', nullif(btrim(coalesce(v_new.test_workbook, '')), '') is not null);
  if v_old.test_workbook is not null and v_new.test_workbook is not null
     and v_old.test_workbook is distinct from v_new.test_workbook then
    v_a := v_a || jsonb_build_object('test_copy_changed', true);
  end if;

  if v_a is distinct from v_b then
    update public.pipeline_write_settings
       set enabled = v_new.enabled, test_mode = v_new.test_mode, target = v_new.target, tabs_on = v_new.tabs_on,
           kinds_on = v_new.kinds_on, test_workbook = v_new.test_workbook, updated_at = now()
     where id = 1
     returning * into v_new;
    insert into public.pipeline_admin_log (email, action, before, after) values (v_me, 'settings', v_b, v_a);
  end if;

  return json_build_object(
    'set_up',        true,
    'enabled',       v_new.enabled,
    'test_mode',     v_new.test_mode,
    'target',        v_new.target,
    'tabs_on',       to_json(v_new.tabs_on),
    'kinds_on',      to_json(v_new.kinds_on),
    'has_test_copy', nullif(btrim(coalesce(v_new.test_workbook, '')), '') is not null,
    'test_workbook', nullif(btrim(coalesce(v_new.test_workbook, '')), ''),
    'updated_at',    v_new.updated_at);
end $$;
revoke all on function public.pipeline_admin_settings_set(boolean, boolean, text, text[], text[], text, boolean)
  from public, anon, service_role;
grant execute on function public.pipeline_admin_settings_set(boolean, boolean, text, text[], text[], text, boolean) to authenticated;

-- the latest changes, newest first: [{at, email, action, subject, before, after}]
create or replace function public.pipeline_admin_log_list(p_limit int default 50)
returns json
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public.pipeline_is_admin() then
    raise exception 'Only pipeline admins can see this.' using errcode = '42501';
  end if;
  return coalesce((select json_agg(json_build_object('at', l.at, 'email', l.email, 'action', l.action,
                                                     'subject', l.subject, 'before', l.before, 'after', l.after)
                                   order by l.at desc, l.id desc)
                     from (select * from public.pipeline_admin_log
                            order by at desc, id desc
                            limit greatest(1, least(coalesce(p_limit, 50), 200))) l), '[]'::json);
end $$;
revoke all on function public.pipeline_admin_log_list(int) from public, anon, service_role;
grant execute on function public.pipeline_admin_log_list(int) to authenticated;

reset role;
