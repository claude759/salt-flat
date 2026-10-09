-- Manager Gusto Timesheets (timesheets.html): give a sign-in saved views. A manager granted a view
-- sees exactly that view's people, enforced by RLS, and the page opens straight onto the view.
-- Needs supabase/ts-ca-timesheets.sql and supabase/ts-views.sql; apply those first, then this.
--
-- Who sees which rows of ts_days / ts_people
--   An ACTIVE allowlisted caller (ts_access row, Google sign-in, see ts_my_email) sees a row when
--   ANY of these holds:
--     1. they are an active admin                                            (unchanged)
--     2. a ts_grants row matches: company|department, company|*, or '*' = every CA company   (unchanged)
--     3. a view granted to them (ts_view_grants) has a member {company, employee_uuid} equal to
--        the row's company + employee_uuid                                   (new: one person)
--     4. a view granted to them has a member {company, department} equal to the row's
--        company + department                                                (new: one department)
--   Inactive users, sessions that are not a Google sign-in, and anon still see nothing.
--   A view stays per company: a person member reaches that employee_uuid at that company only,
--   and a department member that department at that company only.
--
-- How the policy does it
--   ts_my_grant_keys() returns the caller's keys once per query, and a row is visible when they
--   overlap the row's own keys:
--     company|department     a department grant (ts_grants or a view's department member)
--     company|*              a whole-company grant (ts_grants only; '*' = every CA company)
--     company|@uuid:<uuid>   a view's person member
--   Company keys are [a-z0-9_]+ (ts_companies check), so the first '|' always ends the company.
--   Department names starting with '@uuid:' are reserved so a department can never pose as a
--   person: a view refuses such a department (trigger ts_views_reserved, below), the keys
--   ignore a ts_grants department spelled that way, and the policies give a row whose
--   department starts with '@uuid:' no department key (such a row is still seen by admins,
--   whole-company grants and its own person). A department of '*' in a view is refused too:
--   '*' means "every department" in ts_grants, never in a view. Ordinary names that merely
--   start with '@' (for example "@Home") are fine.
--   ts_can_view(company, department, employee_uuid) is the same rule written out as plain
--   joins, the reference the verify scripts compare the policies against row for row. The old
--   two-argument ts_can_view(company, department) still works: it asks the same question with
--   no person (an overload rather than a default, because a 3-argument function with a default
--   next to the 2-argument one makes every 2-argument call ambiguous).
--
-- Views for managers
--   ts_views is readable by admins (unchanged) and now also by a caller with an ACTIVE ts_access
--   row for the views granted to them, so a manager's page can show the view's label and members.
--   ts_me() adds views: [{id, label, sort}] (the caller's granted views; [] unless active).
--   ts_user_json(), and so ts_admin_list() and ts_admin_save_user(), add views: [id, ...].
--   Saving, deleting and assigning views stays admin-only.
--
-- Who writes ts_view_grants
--   Nobody directly. authenticated has SELECT only (anon nothing), no write policies. Writes:
--     ts_admin_set_user_views(p_email, p_views)   admins only; p_views = a list of view ids that
--                                                 REPLACES that sign-in's views; refuses unknown
--                                                 view ids and emails not already in ts_access;
--                                                 returns the user json (as ts_admin_save_user).
--   Deleting a view (ts_admin_delete_view) or a sign-in (ts_admin_delete_user) removes its
--   grants (on delete cascade). ts_admin_save_user leaves a sign-in's views alone.
--
-- Grants: Supabase's default privileges hand anon/authenticated ALL on every new public table and
-- EXECUTE on every new public function, so every grant below starts with an explicit revoke
-- naming them. ts_my_view_ids() is granted to authenticated because the ts_views policy calls it
-- (policies run with the caller's privileges); like ts_my_grant_keys it only describes the caller.
--
-- Nothing is seeded here (view grants name real sign-ins, and this repo is public).
--
-- Safe to re-run: create ... if not exists, create or replace, drop ... if exists. Re-running
-- ts-ca-timesheets.sql or ts-views.sql puts back their own versions of the functions and
-- policies this file replaces (managers then lose their views, nobody gains anything), so after
-- re-running either of them, re-run this file too.
-- Apply on the CA project (dhiqhgtmelxwelyoowle) from Gianni's computer, then run
-- supabase/ts-view-grants-verify.sql (it rolls itself back) and check every row says pass.

do $$ begin
  if to_regclass('public.ts_access') is null or to_regclass('public.ts_grants') is null
     or to_regclass('public.ts_companies') is null or to_regclass('public.ts_days') is null
     or to_regprocedure('public.ts_my_email()') is null or to_regprocedure('public.ts_is_admin()') is null then
    raise exception 'Apply supabase/ts-ca-timesheets.sql first';
  end if;
  if to_regclass('public.ts_views') is null or to_regprocedure('public.ts_views_clean()') is null then
    raise exception 'Apply supabase/ts-views.sql first (view grants need ts_views)';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------------------------

create table if not exists public.ts_view_grants (
  email      text not null references public.ts_access(email) on delete cascade,
  view_id    text not null references public.ts_views(id) on delete cascade on update cascade,
  created_at timestamptz not null default now(),
  updated_by text,
  primary key (email, view_id)
);
-- deleting or renaming a view looks its grants up by view_id
create index if not exists ts_view_grants_view_id_idx on public.ts_view_grants (view_id);

-- ---------------------------------------------------------------------------------------------
-- Reserved department names in views (see the header). A second trigger beside ts_views_clean,
-- so re-running ts-views.sql never drops it. Triggers of one kind fire in name order, so this
-- runs after ts_views_clean and checks the trimmed, deduplicated members (the member number is
-- its place in that cleaned list). Internal, not granted.
-- ---------------------------------------------------------------------------------------------

create or replace function public.ts_views_reserved()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_dep text;
  v_ord bigint;
begin
  select m->>'department', o into v_dep, v_ord
    from jsonb_array_elements(case jsonb_typeof(new.members) when 'array' then new.members else '[]'::jsonb end)
         with ordinality t(m, o)
   where jsonb_typeof(m) = 'object'
     and (m->>'department' = '*' or left(m->>'department', 6) = '@uuid:')
   order by o
   limit 1;
  if v_dep = '*' then
    raise exception 'View member %: "*" is not a department. Add each department or person instead', v_ord;
  elsif v_dep is not null then
    raise exception 'View member %: a department name cannot start with "@uuid:" (%)', v_ord, v_dep;
  end if;
  return new;
end $$;
revoke all on function public.ts_views_reserved() from public, anon, authenticated;

drop trigger if exists ts_views_reserved on public.ts_views;
create trigger ts_views_reserved before insert or update on public.ts_views
  for each row execute function public.ts_views_reserved();

-- ---------------------------------------------------------------------------------------------
-- Caller helpers (used by the policies; every relation is schema-qualified)
-- ---------------------------------------------------------------------------------------------

-- The ids of the views granted to the caller; empty unless the caller has an ACTIVE ts_access row.
create or replace function public.ts_my_view_ids()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(vg.view_id order by vg.view_id), '{}'::text[])
    from public.ts_access a
    join public.ts_view_grants vg on vg.email = a.email
   where a.email = public.ts_my_email() and a.active
$$;
revoke all on function public.ts_my_view_ids() from public, anon, authenticated;
grant execute on function public.ts_my_view_ids() to authenticated;   -- needed by the ts_views policy

-- The caller's keys (see the header); empty unless the caller has an ACTIVE ts_access row.
--   ts_grants:          company|department, a '*' company spelled out as one key per CA company
--   view person member: company|@uuid:<employee_uuid>
--   view department:    company|department
-- View members are read as stored (ts_views_clean trims and checks them); a member counts only
-- with exactly one of employee_uuid / department, a company that is in ts_companies, and (for a
-- department) a name that is not '*' and does not start with '@uuid:'. ts_can_view below states
-- the same rule as joins.
create or replace function public.ts_my_grant_keys()
returns text[] language sql stable security definer set search_path = public as $$
  with me as (select a.email from public.ts_access a
               where a.email = public.ts_my_email() and a.active),
       g as (select g.company, g.department
               from me join public.ts_grants g on g.email = me.email
              where left(g.department, 6) <> '@uuid:'),
       m as (select c.key as company,
                    nullif(e->>'employee_uuid', '') as emp,
                    nullif(e->>'department', '') as dep
               from me
               join public.ts_view_grants vg on vg.email = me.email
               join public.ts_views v on v.id = vg.view_id
               cross join lateral jsonb_array_elements(
                 case jsonb_typeof(v.members) when 'array' then v.members else '[]'::jsonb end) e
               join public.ts_companies c on c.key = e->>'company')
  select coalesce(array_agg(distinct k.key order by k.key), '{}'::text[])
    from (select g.company || '|' || g.department as key from g where g.company <> '*'
          union all
          select c.key || '|' || g.department from g join public.ts_companies c on c.region = 'CA'
           where g.company = '*'
          union all
          select m.company || '|@uuid:' || m.emp from m
           where m.emp is not null and m.dep is null
          union all
          select m.company || '|' || m.dep from m
           where m.dep is not null and m.emp is null
             and m.dep <> '*' and left(m.dep, 6) <> '@uuid:') k
$$;
revoke all on function public.ts_my_grant_keys() from public, anon, authenticated;
grant execute on function public.ts_my_grant_keys() to authenticated;   -- needed by the RLS policies

-- The reference rule: may the caller see the row of this company + department + person?
-- Written as joins, independent of ts_my_grant_keys; the verify scripts check that the
-- ts_days / ts_people policies and this function agree row for row. Internal, not granted.
create or replace function public.ts_can_view(p_company text, p_department text, p_employee_uuid text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.ts_is_admin()
      or exists (
           select 1 from public.ts_access a
            where a.email = public.ts_my_email() and a.active
              and (
                -- 2. a company + department grant ('*' department = all; '*' company = every CA company)
                exists (select 1 from public.ts_grants g
                         where g.email = a.email
                           and left(g.department, 6) <> '@uuid:'
                           and (g.company = p_company
                                or (g.company = '*' and exists (select 1 from public.ts_companies c
                                                                 where c.key = p_company and c.region = 'CA')))
                           and (g.department = '*' or g.department = p_department))
                -- 3 + 4. a person or department member of a view granted to them
                or exists (select 1
                             from public.ts_view_grants vg
                             join public.ts_views v on v.id = vg.view_id
                             cross join lateral jsonb_array_elements(
                               case jsonb_typeof(v.members) when 'array' then v.members else '[]'::jsonb end) m
                            where vg.email = a.email
                              and m->>'company' = p_company
                              and exists (select 1 from public.ts_companies c where c.key = p_company)
                              and ((nullif(m->>'employee_uuid', '') = p_employee_uuid
                                    and nullif(m->>'department', '') is null)
                                   or (nullif(m->>'department', '') = p_department
                                       and nullif(m->>'employee_uuid', '') is null
                                       and p_department <> '*' and left(p_department, 6) <> '@uuid:')))))
$$;
revoke all on function public.ts_can_view(text, text, text) from public, anon, authenticated;

-- The round-1 two-argument form: the same rule for a row with no person. Internal, not granted.
create or replace function public.ts_can_view(p_company text, p_department text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.ts_can_view(p_company, p_department, null::text)
$$;
revoke all on function public.ts_can_view(text, text) from public, anon, authenticated;

-- What the page needs after sign-in: ts-ca-timesheets.sql's answer plus the caller's views.
create or replace function public.ts_me()
returns jsonb language sql stable security definer set search_path = public as $$
  with me as (select public.ts_my_email() as email),
       acc as (select a.active, a.is_admin from public.ts_access a, me where a.email = me.email)
  select jsonb_build_object(
    'email',    (select email from me),
    'active',   coalesce((select active from acc), false),
    'is_admin', coalesce((select active and is_admin from acc), false),
    'grants',   case when coalesce((select active from acc), false) then
                  coalesce((select jsonb_agg(jsonb_build_object('company', g.company, 'department', g.department)
                                             order by g.company, g.department)
                              from public.ts_grants g, me where g.email = me.email), '[]'::jsonb)
                else '[]'::jsonb end,
    'views',    case when coalesce((select active from acc), false) then
                  coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'label', v.label, 'sort', v.sort)
                                             order by v.sort, v.label, v.id)
                              from public.ts_view_grants vg
                              join public.ts_views v on v.id = vg.view_id
                              join me on vg.email = me.email), '[]'::jsonb)
                else '[]'::jsonb end)
$$;
revoke all on function public.ts_me() from public, anon, authenticated;
grant execute on function public.ts_me() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Admin RPCs (ts_access admins only)
-- ---------------------------------------------------------------------------------------------

-- One user as the admin panel shows it, now with views: [id, ...] in tab order. Internal.
create or replace function public.ts_user_json(p_email text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'email', a.email, 'is_admin', a.is_admin, 'active', a.active, 'note', a.note,
    'created_at', a.created_at, 'updated_at', a.updated_at, 'updated_by', a.updated_by,
    'grants', coalesce((select jsonb_agg(jsonb_build_object('company', g.company, 'department', g.department)
                                         order by g.company, g.department)
                          from public.ts_grants g where g.email = a.email), '[]'::jsonb),
    'views',  coalesce((select jsonb_agg(vg.view_id order by v.sort, v.label, v.id)
                          from public.ts_view_grants vg join public.ts_views v on v.id = vg.view_id
                         where vg.email = a.email), '[]'::jsonb))
    from public.ts_access a where a.email = p_email
$$;
revoke all on function public.ts_user_json(text) from public, anon, authenticated;

-- REPLACE one sign-in's views with p_views (a list of view ids; null = none). Ids are trimmed,
-- lowercased and deduplicated. The sign-in must already be in ts_access (save it with
-- ts_admin_save_user first). Grants it keeps are left as they were; the rest go.
-- Returns {ok: true} plus the user json (as ts_admin_save_user does).
create or replace function public.ts_admin_set_user_views(p_email text, p_views jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me    text := public.ts_my_email();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_views jsonb := coalesce(p_views, '[]'::jsonb);
  v_ids   text[];
  v_bad   text;
begin
  if not public.ts_is_admin() then
    raise exception 'Only timesheet admins can do this' using errcode = '42501';
  end if;
  -- the row lock also keeps two admins' saves of the same sign-in from interleaving
  perform 1 from public.ts_access a where a.email = v_email for update;
  if not found then
    raise exception 'No timesheet sign-in for "%". Save the sign-in first, then give it views', v_email;
  end if;
  if jsonb_typeof(v_views) <> 'array' then
    raise exception 'Views must be a list of view ids';
  end if;
  select e::text into v_bad from jsonb_array_elements(v_views) e where jsonb_typeof(e) <> 'string' limit 1;
  if v_bad is not null then
    raise exception 'View ids must be text, not %', v_bad;
  end if;
  v_ids := array(select distinct lower(btrim(e)) from jsonb_array_elements_text(v_views) e);
  select x into v_bad from unnest(v_ids) x
   where not exists (select 1 from public.ts_views v where v.id = x)
   order by x limit 1;
  if v_bad is not null then
    raise exception 'Unknown view: "%"', v_bad;
  end if;

  delete from public.ts_view_grants vg where vg.email = v_email and not (vg.view_id = any (v_ids));
  insert into public.ts_view_grants (email, view_id, updated_by)
  select v_email, x, v_me from unnest(v_ids) x
  on conflict (email, view_id) do nothing;

  return jsonb_build_object('ok', true) || public.ts_user_json(v_email);
end $$;
revoke all on function public.ts_admin_set_user_views(text, jsonb) from public, anon, authenticated;
grant execute on function public.ts_admin_set_user_views(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------

alter table public.ts_view_grants enable row level security;
revoke all on table public.ts_view_grants from public, anon, authenticated;
grant select on table public.ts_view_grants to authenticated;

drop policy if exists ts_view_grants_select on public.ts_view_grants;
create policy ts_view_grants_select on public.ts_view_grants for select to authenticated
  using ((select public.ts_is_admin()) or email = (select public.ts_my_email()));

-- = ts_can_view(company, department, employee_uuid), with the caller's keys fetched once per
-- query. A department starting with '@uuid:' gets no department key (null never overlaps).
drop policy if exists ts_days_select on public.ts_days;
create policy ts_days_select on public.ts_days for select to authenticated
  using ((select public.ts_is_admin())
         or (select public.ts_my_grant_keys())
            && array[case when left(department, 6) <> '@uuid:' then company || '|' || department end,
                     company || '|*',
                     company || '|@uuid:' || employee_uuid]);

drop policy if exists ts_people_select on public.ts_people;
create policy ts_people_select on public.ts_people for select to authenticated
  using ((select public.ts_is_admin())
         or (select public.ts_my_grant_keys())
            && array[case when left(department, 6) <> '@uuid:' then company || '|' || department end,
                     company || '|*',
                     company || '|@uuid:' || employee_uuid]);

-- admins see every view; an active manager sees the views granted to them
drop policy if exists ts_views_select on public.ts_views;
create policy ts_views_select on public.ts_views for select to authenticated
  using ((select public.ts_is_admin()) or (select public.ts_my_view_ids()) @> array[id]);

notify pgrst, 'reload schema';

-- Post-apply checks (all read-only):
--   select relrowsecurity from pg_class where oid = 'public.ts_view_grants'::regclass;   -- true
--   anon GET /rest/v1/ts_view_grants?select=email -> 401/permission denied
--   then run, in any order, supabase/ts-ca-timesheets-verify.sql, supabase/ts-views-verify.sql and
--   supabase/ts-view-grants-verify.sql: every row pass = true, and each rolls back.
