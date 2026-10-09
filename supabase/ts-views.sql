-- Manager Gusto Timesheets (timesheets.html): saved views. A view is a named crew shown as a tab
-- at the top of the page ("Everyone" plus one tab per view). Needs supabase/ts-ca-timesheets.sql
-- (ts_companies, ts_my_email, ts_is_admin); apply that first.
--
-- What a view is
--   members is a list of crew entries, each one of:
--     {"company": "<ts_companies.key>", "employee_uuid": "<Gusto employee uuid>"}   one person at one company
--     {"company": "<ts_companies.key>", "department":    "<department title>"}      a whole department at one company
--   The page keeps a ts_days row when some member has the same company and the same
--   employee_uuid or the same department. A view is only a FILTER over rows the caller can
--   already read under the ts_days / ts_people policies: it never grants access to anything.
--   Members hold uuids and department titles, never names (the page resolves names via
--   ts_people). Labels are typed by an admin.
--
-- Who can see and change views
--   For now only ts_access admins (ts_is_admin(): an active admin row AND a Google sign-in, see
--   ts_my_email). Everyone else, managers included, reads zero rows and cannot call the RPCs.
--   Nobody writes the table directly: authenticated has SELECT only (anon has nothing), there
--   are no insert/update/delete policies, and writes go through two security definer RPCs:
--     ts_admin_save_view(p_id, p_label, p_sort, p_members)   upsert one view, returns the saved row
--     ts_admin_delete_view(p_id)                             returns {ok, deleted}
--   This file does not change any ts_access / ts_grants rule or any existing policy.
--
-- Clean-up and checks live in a trigger (ts_views_clean), so a view the owner inserts directly
-- (for example a seed pasted in the SQL editor) gets exactly the same checks as one saved from
-- the page: label trimmed (inner whitespace collapsed) and 1 to 60 characters; members a list of
-- at most 500 objects whose company exists in ts_companies (lowercased, trimmed) with exactly one
-- of a non-blank employee_uuid or a non-blank department, at most 100 characters after trimming;
-- anything else in a member is dropped;
-- duplicates are dropped, first one kept, order kept. The id format is a check constraint
-- (lowercase letters, digits, '-' or '_', 1 to 40, starting with a letter or digit); the save
-- RPC lowercases and trims the id first.
--
-- Later: letting managers use views is a small step that needs no change here. Add
-- ts_view_grants(email references ts_access(email) on delete cascade,
--                view_id references ts_views(id) on delete cascade, primary key (email, view_id))
-- and widen ts_views_select to admins OR a matching ts_view_grants row for ts_my_email() of an
-- active ts_access row. Rows stay scoped by ts_grants, as above.
--
-- Grants: Supabase's default privileges hand anon/authenticated ALL on every new public table and
-- EXECUTE on every new public function, so every grant below starts with an explicit revoke
-- naming them.
--
-- No views are seeded here: labels name real people and members carry Gusto uuids, and this
-- repo is public. Seed them separately (directly as the owner, or from the page's admin panel).
--
-- Safe to re-run: create ... if not exists, create or replace, drop ... if exists.
-- Apply on the CA project (dhiqhgtmelxwelyoowle) from Gianni's computer, then run
-- supabase/ts-views-verify.sql (it rolls itself back) and check every row says pass.

do $$ begin
  if to_regprocedure('public.ts_is_admin()') is null or to_regprocedure('public.ts_my_email()') is null
     or to_regclass('public.ts_companies') is null then
    raise exception 'Apply supabase/ts-ca-timesheets.sql first (ts_views needs ts_companies, ts_my_email, ts_is_admin)';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------------------------

create table if not exists public.ts_views (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  label text not null check (length(btrim(label)) between 1 and 60),
  sort int not null default 0,
  members jsonb not null default '[]' check (jsonb_typeof(members) = 'array'),
     -- each element is {company, employee_uuid} (one person at one company)
     --              or {company, department}    (a whole department at one company)
  updated_at timestamptz not null default now(),
  updated_by text
);

-- ---------------------------------------------------------------------------------------------
-- Clean-up + checks for every insert and update (see the header). Internal, not granted:
-- triggers fire without EXECUTE, and nobody can call a trigger function directly.
-- ---------------------------------------------------------------------------------------------

create or replace function public.ts_views_clean()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_el    jsonb;
  v_ord   bigint;
  v_co    text;
  v_emp   text;
  v_dep   text;
  v_clean jsonb := '[]'::jsonb;
begin
  new.label := btrim(regexp_replace(coalesce(new.label, ''), '\s+', ' ', 'g'));
  if length(new.label) not between 1 and 60 then
    raise exception 'View name must be 1 to 60 characters';
  end if;
  new.sort := coalesce(new.sort, 0);
  new.members := coalesce(new.members, '[]'::jsonb);
  if jsonb_typeof(new.members) <> 'array' then
    raise exception 'View members must be a list';
  end if;
  if jsonb_array_length(new.members) > 500 then
    raise exception 'View can hold at most 500 members';
  end if;

  for v_el, v_ord in select e, o from jsonb_array_elements(new.members) with ordinality t(e, o) loop
    if jsonb_typeof(v_el) <> 'object' then
      raise exception 'View member %: must be {company, employee_uuid} or {company, department}', v_ord;
    end if;
    if coalesce(jsonb_typeof(v_el->'company'), 'null') <> 'string' or btrim(v_el->>'company') = '' then
      raise exception 'View member %: needs a company', v_ord;
    end if;
    v_co := lower(btrim(v_el->>'company'));
    if not exists (select 1 from public.ts_companies c where c.key = v_co) then
      raise exception 'View member %: unknown company "%"', v_ord, v_el->>'company';
    end if;
    if coalesce(jsonb_typeof(v_el->'employee_uuid'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(v_el->'department'), 'null') not in ('string', 'null') then
      raise exception 'View member %: employee_uuid and department must be text', v_ord;
    end if;
    v_emp := nullif(btrim(coalesce(v_el->>'employee_uuid', '')), '');
    v_dep := nullif(btrim(coalesce(v_el->>'department', '')), '');
    if v_emp is not null and v_dep is not null then
      raise exception 'View member %: give one person or one department, not both', v_ord;
    end if;
    if v_emp is null and v_dep is null then
      raise exception 'View member %: give a person (employee_uuid) or a department', v_ord;
    end if;
    if length(coalesce(v_emp, v_dep)) > 100 then
      raise exception 'View member %: % is over 100 characters', v_ord,
        case when v_emp is not null then 'employee_uuid' else 'department' end;
    end if;
    v_clean := v_clean || jsonb_build_array(case when v_emp is not null
                                                 then jsonb_build_object('company', v_co, 'employee_uuid', v_emp)
                                                 else jsonb_build_object('company', v_co, 'department', v_dep) end);
  end loop;

  -- drop exact duplicates, keep the first one and the order
  select coalesce(jsonb_agg(x.m order by x.o), '[]'::jsonb) into new.members
    from (select distinct on (d.m) d.m, d.o
            from jsonb_array_elements(v_clean) with ordinality d(m, o)
           order by d.m, d.o) x;

  new.updated_at := now();
  return new;
end $$;
revoke all on function public.ts_views_clean() from public, anon, authenticated;

drop trigger if exists ts_views_clean on public.ts_views;
create trigger ts_views_clean before insert or update on public.ts_views
  for each row execute function public.ts_views_clean();

-- ---------------------------------------------------------------------------------------------
-- Admin RPCs (ts_access admins only)
-- ---------------------------------------------------------------------------------------------

-- Upsert one view by id (an existing id is overwritten: the page picks a unique id for a new
-- view). p_id is lowercased and trimmed; label and members are checked and cleaned by the
-- ts_views_clean trigger. Returns the saved row as jsonb {id, label, sort, members, updated_at,
-- updated_by}.
create or replace function public.ts_admin_save_view(p_id text, p_label text, p_sort int, p_members jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me  text := public.ts_my_email();
  v_id  text := lower(btrim(coalesce(p_id, '')));
  v_row jsonb;
begin
  if not public.ts_is_admin() then
    raise exception 'Only timesheet admins can do this' using errcode = '42501';
  end if;
  if v_id !~ '^[a-z0-9][a-z0-9_-]{0,39}$' then
    raise exception 'View id must be 1 to 40 lowercase letters, digits, - or _, starting with a letter or digit';
  end if;

  insert into public.ts_views as tv (id, label, sort, members, updated_at, updated_by)
  values (v_id, coalesce(p_label, ''), coalesce(p_sort, 0), coalesce(p_members, '[]'::jsonb), now(), v_me)
  on conflict (id) do update
     set label = excluded.label, sort = excluded.sort, members = excluded.members,
         updated_at = now(), updated_by = excluded.updated_by
  returning to_jsonb(tv.*) into v_row;

  return v_row;
end $$;
revoke all on function public.ts_admin_save_view(text, text, int, jsonb) from public, anon, authenticated;
grant execute on function public.ts_admin_save_view(text, text, int, jsonb) to authenticated;

create or replace function public.ts_admin_delete_view(p_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id text := lower(btrim(coalesce(p_id, ''))); v_n int;
begin
  if not public.ts_is_admin() then
    raise exception 'Only timesheet admins can do this' using errcode = '42501';
  end if;
  delete from public.ts_views v where v.id = v_id;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'deleted', v_n);
end $$;
revoke all on function public.ts_admin_delete_view(text) from public, anon, authenticated;
grant execute on function public.ts_admin_delete_view(text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Row level security: SELECT only, to authenticated, admins only. No write policies.
-- ---------------------------------------------------------------------------------------------

alter table public.ts_views enable row level security;
revoke all on table public.ts_views from public, anon, authenticated;
grant select on table public.ts_views to authenticated;

drop policy if exists ts_views_select on public.ts_views;
create policy ts_views_select on public.ts_views for select to authenticated
  using ((select public.ts_is_admin()));

notify pgrst, 'reload schema';

-- Post-apply checks (all read-only):
--   select relrowsecurity from pg_class where oid = 'public.ts_views'::regclass;   -- true
--   anon GET /rest/v1/ts_views?select=id -> 401/permission denied
--   then run supabase/ts-views-verify.sql: every row pass = true, and it rolls back.
--   supabase/ts-ca-timesheets-verify.sql check A6 pins the exact ts_ functions authenticated may
--   execute. With this file applied that list also has ts_admin_delete_view and ts_admin_save_view,
--   so if A6's expected value there still names only the round-1 functions, A6 reports fail (and
--   only A6). That is expected, not a problem with this file; its expected value should read
--   'ts!_admin!_delete!_user,ts!_admin!_delete!_view,ts!_admin!_list,ts!_admin!_save!_user,ts!_admin!_save!_view,ts!_is!_admin,ts!_me,ts!_my!_email,ts!_my!_grant!_keys,ts!_sync'.
--   ts-views-verify.sql check A11 pins that same full list.
