-- RLS + RPC verification for supabase/ts-view-grants.sql (Manager Gusto Timesheets: views given
-- to sign-ins).
--
-- One transaction that ROLLS BACK, in the same harness as supabase/ts-ca-timesheets-verify.sql:
-- it writes throwaway rows (synthetic people "Test Person ...", uuids 'zz-vg-...', dates in 2001,
-- views 'zz-vg-...', a temporary NY company 'zz_vg_ny', a throwaway allowlist email
-- zz-vg-mgr@wizardtrees.com), plays each identity, records what each one can see or do, returns
-- one pass/fail table, and undoes everything. Run it with write access as the project owner (SQL
-- editor or the management API without read_only) after ts-ca-timesheets.sql, ts-views.sql and
-- ts-view-grants.sql; the API shows the last result set, which is the pass/fail table. Every row
-- must say pass = true.
--
-- Identities (real auth.users rows are needed only for gianni@ and automation@, looked up by
-- email; each session carries a JWT amr 'oauth' unless a check says otherwise, and automation@
-- always signs in with a password):
--   anon                  role anon, no JWT
--   stranger              role authenticated, a random sub with no auth.users and no ts_access row
--   automation@           the sync account (password): passes is_staff(), never holds a view
--   no-access Google user gianni@ (Google) with his ts_access row removed (any BA)
--   manager               gianni@ (Google) set to an active NON-admin row with no ts_grants and
--                         one view, then two views, then views plus a ts_grants row
--   password session      the same manager signed in by password / OTP (after a BA-app reset)
--   inactive manager      the same manager with active = false
--   admin                 gianni@ (Google), an active admin row
-- The manager states are set on gianni's own row as the owner (rolled back), as in the other two
-- verify scripts. His real view grants, if any, are cleared first (rolled back too). Expected
-- rows are computed as the owner (no RLS) with the rule written out by hand, so real rows and
-- views already in the tables do not break the checks.
--
-- The synthetic crew (company / uuid / department) and why each is there:
--   filifera zz-vg-1 Distro/Trim            person member of view 1
--   filifera zz-vg-2 Distro/Trim            same department, not a member: a person member is one person
--   slane    zz-vg-1 Packing                same uuid at another company: a person member is per company
--   slane    zz-vg-3 Distro/Trim            department member of view 1 (slane / Distro/Trim)
--   filifera zz-vg-5 "@uuid:zz-vg-1"        a department spelled like a person key: must stay hidden
--   filifera zz-vg-6 "@Home"                a department that merely starts with '@': view 2 member
--   wafgus   zz-vg-7 Cultivation            department member of view 2
--   wafgus   zz-vg-10 "*"                   a department literally named "*": no department grant reaches it
--   imperial zz-vg-8 Trim                   only in view 3, which the manager never gets
--   zz_vg_ny zz-vg-9 Cultivation            person member of view 2 at a non-CA company (explicit company)

begin;

create temp table ts_v_results (
  seq serial primary key,
  test text not null,
  expected text not null,      -- a LIKE pattern (escape '!'); plain text means equal
  got text
) on commit drop;

-- Run p_sql as an identity and return its single value as text, or 'ERROR <sqlstate>: <message>'.
-- p_role null = as the script owner; 'anon' = no JWT; 'authenticated' + p_email = that confirmed
-- auth.users row; 'authenticated' + null email = a signed-in sub with no auth.users row;
-- 'claims' = the owner's privileges (no RLS) but that identity's JWT, used to evaluate the
-- internal reference rule ts_can_view() for the same person.
-- p_amr = the JWT's sign-in method: null = 'password' for automation@, else 'oauth'; 'none' = no amr.
create function pg_temp.ts_v_as(p_role text, p_email text, p_sql text, p_amr text default null) returns text
language plpgsql as $f$
declare v_me text := current_user; v_sub text; v_claims text := ''; v_out text; v_amr text;
begin
  if p_role in ('authenticated', 'claims') then
    if p_email is null then
      v_sub := gen_random_uuid()::text;
    else
      select u.id::text into v_sub from auth.users u
       where lower(u.email) = lower(p_email) and u.email_confirmed_at is not null limit 1;
      if v_sub is null then raise exception 'verify needs a confirmed auth.users row for %', p_email; end if;
    end if;
    v_amr := coalesce(p_amr, case when lower(p_email) = 'automation@wizardtrees.com' then 'password' else 'oauth' end);
    v_claims := (jsonb_build_object('sub', v_sub, 'role', 'authenticated', 'aal', 'aal1')
                 || case when v_amr = 'none' then '{}'::jsonb
                         else jsonb_build_object('amr', jsonb_build_array(jsonb_build_object(
                                'method', v_amr, 'timestamp', extract(epoch from now())::bigint))) end)::text;
  end if;
  begin
    if p_role is not null then
      perform set_config('request.jwt.claims', v_claims, true);
      perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
      if p_role <> 'claims' then perform set_config('role', p_role, true); end if;
    end if;
    execute p_sql into v_out;
  exception when others then
    v_out := 'ERROR ' || sqlstate || ': ' || sqlerrm;   -- the failed statement's writes roll back
  end;
  perform set_config('role', v_me, true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return coalesce(v_out, '(null)');
end $f$;

create function pg_temp.ts_v(p_test text, p_role text, p_email text, p_sql text, p_expected text,
                             p_amr text default null) returns void
language sql as $f$
  insert into pg_temp.ts_v_results (test, expected, got)
  values (p_test, coalesce(p_expected, '(null)'), pg_temp.ts_v_as(p_role, p_email, p_sql, p_amr));
$f$;

-- A literal as a LIKE pattern (escape '!'), for expected values that contain _ or %.
create function pg_temp.ts_v_lit(p text) returns text
language sql immutable as $f$ select replace(replace(replace(p, '!', '!!'), '%', '!%'), '_', '!_') $f$;

-- As the owner: set gianni@'s own allowlist row and grants (rolled back with everything else).
-- View grants are left alone here; ts_v_gianni_views sets them.
create function pg_temp.ts_v_gianni(p_is_admin boolean, p_active boolean, p_grants jsonb) returns void
language plpgsql as $f$
begin
  insert into public.ts_access (email, is_admin, active, note)
  values ('gianni@wizardtrees.com', p_is_admin, p_active, 'owner')
  on conflict (email) do update set is_admin = excluded.is_admin, active = excluded.active;
  delete from public.ts_grants where email = 'gianni@wizardtrees.com';
  insert into public.ts_grants (email, company, department)
  select 'gianni@wizardtrees.com', g->>'company', g->>'department' from jsonb_array_elements(p_grants) g;
end $f$;

-- As the owner: REPLACE gianni@'s view grants with this list of view ids.
create function pg_temp.ts_v_gianni_views(p_views jsonb) returns void
language plpgsql as $f$
begin
  delete from public.ts_view_grants where email = 'gianni@wizardtrees.com';
  insert into public.ts_view_grants (email, view_id, updated_by)
  select 'gianni@wizardtrees.com', v, 'verify' from jsonb_array_elements_text(p_views) v;
end $f$;

-- ------------------------------------------------------------------ setup (as owner, rolled back)
select pg_temp.ts_v_gianni(true, true, '[]');
select pg_temp.ts_v_gianni_views('[]');

insert into public.ts_companies (key, name, region) values ('zz_vg_ny', 'Verify Grants NY', 'NY') on conflict do nothing;

insert into public.ts_people (company, employee_uuid, name, department) values
  ('filifera', 'zz-vg-1',  'Test Person One',       'Distro/Trim'),
  ('filifera', 'zz-vg-2',  'Test Person Two',       'Distro/Trim'),
  ('slane',    'zz-vg-1',  'Test Person One Slane', 'Packing'),
  ('slane',    'zz-vg-3',  'Test Person Three',     'Distro/Trim'),
  ('filifera', 'zz-vg-5',  'Test Person Five',      '@uuid:zz-vg-1'),
  ('filifera', 'zz-vg-6',  'Test Person Six',       '@Home'),
  ('wafgus',   'zz-vg-7',  'Test Person Seven',     'Cultivation'),
  ('wafgus',   'zz-vg-10', 'Test Person Ten',       '*'),
  ('imperial', 'zz-vg-8',  'Test Person Eight',     'Trim'),
  ('zz_vg_ny', 'zz-vg-9',  'Test Person Nine',      'Cultivation');
insert into public.ts_days (id, company, region, employee_uuid, employee_name, department, work_date, worked_min)
select p.company || ':' || p.employee_uuid || ':' || d, p.company,
       case when p.company = 'zz_vg_ny' then 'NY' else 'CA' end,
       p.employee_uuid, p.name, p.department, d::date, 420
  from public.ts_people p, unnest(array['2001-01-01', '2001-01-02']) d
 where p.employee_uuid like 'zz-vg-%';

insert into public.ts_views (id, label, sort, members, updated_by) values
  ('zz-vg-v1', 'Verify Grant One',   901, '[{"company":"filifera","employee_uuid":"zz-vg-1"},{"company":"slane","department":"Distro/Trim"}]', 'verify'),
  ('zz-vg-v2', 'Verify Grant Two',   902, '[{"company":"filifera","department":"@Home"},{"company":"wafgus","department":"Cultivation"},{"company":"zz_vg_ny","employee_uuid":"zz-vg-9"}]', 'verify'),
  ('zz-vg-v3', 'Verify Grant Three', 903, '[{"company":"imperial","department":"Trim"}]', 'verify');

-- the throwaway sign-in the admin RPCs are tried on (no auth.users row needed)
insert into public.ts_access (email, is_admin, active, note) values ('zz-vg-mgr@wizardtrees.com', false, true, 'verify');

-- ------------------------------------------------------------------ checks
do $v$
declare
  adm  constant text := 'gianni@wizardtrees.com';
  aut  constant text := 'automation@wizardtrees.com';
  mgr  constant text := 'zz-vg-mgr@wizardtrees.com';
  admin_only constant text := 'ERROR 42501: Only timesheet admins can do this';
  -- the rows RLS lets the caller see, and the rows the reference rule ts_can_view() allows
  rls_rows constant text := $q$select md5(coalesce((select string_agg(id, ',' order by id) from public.ts_days), '')
                                   || '#' || coalesce((select string_agg(company || ':' || employee_uuid, ',' order by company, employee_uuid) from public.ts_people), '')
                                   || '#' || coalesce((select string_agg(id, ',' order by id) from public.ts_views), ''))$q$;
  ref_rows constant text := $q$select md5(coalesce((select string_agg(id, ',' order by id) from public.ts_days where public.ts_can_view(company, department, employee_uuid)), '')
                                   || '#' || coalesce((select string_agg(company || ':' || employee_uuid, ',' order by company, employee_uuid) from public.ts_people where public.ts_can_view(company, department, employee_uuid)), '')
                                   || '#' || coalesce((select string_agg(v.id, ',' order by v.id) from public.ts_views v
                                                        where public.ts_is_admin()
                                                           or exists (select 1 from public.ts_view_grants g join public.ts_access a on a.email = g.email
                                                                       where g.view_id = v.id and a.email = public.ts_my_email() and a.active)), ''))$q$;
  -- everything the caller can read in ts_days, ts_people, ts_views and ts_view_grants
  all_rows constant text := $q$select (select count(*) from public.ts_days) + (select count(*) from public.ts_people)
                                   + (select count(*) from public.ts_views) + (select count(*) from public.ts_view_grants)$q$;
  -- the synthetic rows the caller can see, readable (byte order, so the lists below hold under any collation)
  syn_days constant text := $q$select coalesce(string_agg(id, ',' order by id collate "C"), '(none)') from public.ts_days where employee_uuid like 'zz-vg-%'$q$;
  syn_ppl  constant text := $q$select coalesce(string_agg(company || ':' || employee_uuid, ',' order by company || ':' || employee_uuid collate "C"), '(none)') from public.ts_people where employee_uuid like 'zz-vg-%'$q$;
  syn_view constant text := $q$select coalesce(string_agg(id, ',' order by id collate "C"), '(none)') from public.ts_views where id like 'zz-vg-%'$q$;
  me_views constant text := $q$select (public.ts_me()->>'active') || '/' || (public.ts_me()->'views')::text$q$;
  -- the hand-written rule for each manager state, as day ids and person keys (owner, no RLS)
  v1_rule  constant text := $r$(company = 'filifera' and employee_uuid = 'zz-vg-1') or (company = 'slane' and department = 'Distro/Trim')$r$;
  v2_rule  constant text := $r$(company = 'filifera' and department = '@Home') or (company = 'wafgus' and department = 'Cultivation') or (company = 'zz_vg_ny' and employee_uuid = 'zz-vg-9')$r$;
  exp_sql  constant text := $q$select md5(coalesce((select string_agg(id, ',' order by id) from public.ts_days where %1$s), '')
                                   || '#' || coalesce((select string_agg(company || ':' || employee_uuid, ',' order by company, employee_uuid) from public.ts_people where %1$s), ''))$q$;
  got_sql  constant text := $q$select md5(coalesce((select string_agg(id, ',' order by id) from public.ts_days), '')
                                   || '#' || coalesce((select string_agg(company || ':' || employee_uuid, ',' order by company, employee_uuid) from public.ts_people), ''))$q$;
  set_views constant text := $q$select (r->>'ok') || '/' || (r->>'email') || '/' || (r->'views')::text from (select public.ts_admin_set_user_views(%L, %L::jsonb) r) s$q$;
  v1_days  constant text := 'filifera:zz-vg-1:2001-01-01,filifera:zz-vg-1:2001-01-02,slane:zz-vg-3:2001-01-01,slane:zz-vg-3:2001-01-02';
  v2_days  constant text := 'filifera:zz-vg-6:2001-01-01,filifera:zz-vg-6:2001-01-02,wafgus:zz-vg-7:2001-01-01,wafgus:zz-vg-7:2001-01-02,zz_vg_ny:zz-vg-9:2001-01-01,zz_vg_ny:zz-vg-9:2001-01-02';
  v12_days constant text := 'filifera:zz-vg-1:2001-01-01,filifera:zz-vg-1:2001-01-02,filifera:zz-vg-6:2001-01-01,filifera:zz-vg-6:2001-01-02,slane:zz-vg-3:2001-01-01,slane:zz-vg-3:2001-01-02,wafgus:zz-vg-7:2001-01-01,wafgus:zz-vg-7:2001-01-02,zz_vg_ny:zz-vg-9:2001-01-01,zz_vg_ny:zz-vg-9:2001-01-02';
begin
  -- A. catalog
  perform pg_temp.ts_v('A1 RLS is on for ts_view_grants', null, null,
    $q$select relrowsecurity::text from pg_class where oid = 'public.ts_view_grants'::regclass$q$, 'true');
  perform pg_temp.ts_v('A2 ts_view_grants has exactly one policy: SELECT to authenticated, admin or own email', null, null,
    $q$select count(*) || '/' || string_agg(cmd || ':' || array_to_string(roles, ','), ',')
              || '/' || bool_and(qual like '%ts_is_admin()%' and qual like '%ts_my_email()%')
         from pg_policies where schemaname = 'public' and tablename = 'ts_view_grants'$q$, '1/SELECT:authenticated/true');
  perform pg_temp.ts_v('A3 anon holds no privilege on ts_view_grants', null, null,
    $q$select count(*) from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
        where has_table_privilege('anon', 'public.ts_view_grants', p)$q$, '0');
  perform pg_temp.ts_v('A4 authenticated holds SELECT and nothing else on ts_view_grants', null, null,
    $q$select count(*) filter (where p = 'SELECT') || '/' || count(*)
         from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
        where has_table_privilege('authenticated', 'public.ts_view_grants', p)$q$, '1/1');
  perform pg_temp.ts_v('A5 both foreign keys cascade (email on delete; view_id on delete and on update)', null, null,
    $q$select string_agg(a.attname || ':' || c.confdeltype::text || c.confupdtype::text, ',' order by a.attname)
         from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.conrelid = 'public.ts_view_grants'::regclass and c.contype = 'f'$q$, 'email:ca,view!_id:cc');
  perform pg_temp.ts_v('A6 authenticated can execute exactly these ts_ functions', null, null,
    $q$select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'ts\_%' and has_function_privilege('authenticated', p.oid, 'EXECUTE')$q$,
    pg_temp.ts_v_lit('ts_admin_delete_user,ts_admin_delete_view,ts_admin_list,ts_admin_save_user,ts_admin_save_view,ts_admin_set_user_views,ts_is_admin,ts_me,ts_my_email,ts_my_grant_keys,ts_my_view_ids,ts_sync'));
  perform pg_temp.ts_v('A7 PUBLIC and anon can execute none of the new functions, nor either ts_can_view', null, null,
    $q$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('ts_admin_set_user_views','ts_my_view_ids','ts_views_reserved','ts_can_view','ts_user_json')
          and (has_function_privilege('public', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE'))$q$, '0');
  perform pg_temp.ts_v('A8 both ts_can_view forms exist and authenticated can execute neither', null, null,
    $q$select string_agg(p.oid::regprocedure::text || '=' || has_function_privilege('authenticated', p.oid, 'EXECUTE'), ',' order by p.pronargs)
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'ts_can_view'$q$,
    pg_temp.ts_v_lit('ts_can_view(text,text)=false,ts_can_view(text,text,text)=false'));
  perform pg_temp.ts_v('A9 every ts_ function is security definer with search_path=public', null, null,
    $q$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'ts\_%'
          and not (p.prosecdef and coalesce(array_to_string(p.proconfig, ',') like '%search_path=public%', false))$q$, '0');
  perform pg_temp.ts_v('A10 the reserved-department trigger is on for inserts and updates, after ts_views_clean', null, null,
    $q$select string_agg(t.tgname, ',' order by t.tgname) from pg_trigger t
        where t.tgrelid = 'public.ts_views'::regclass and not t.tgisinternal and t.tgenabled = 'O'
          and (t.tgtype & 2) <> 0 and (t.tgtype & 4) <> 0 and (t.tgtype & 16) <> 0 and (t.tgtype & 1) <> 0$q$,
    pg_temp.ts_v_lit('ts_views_clean,ts_views_reserved'));
  perform pg_temp.ts_v('A11 the ts_days and ts_people policies carry the person key', null, null,
    $q$select count(*) filter (where qual like '%@uuid:%' and qual like '%ts!_my!_grant!_keys()%' escape '!') || '/' || count(*)
         from pg_policies where schemaname = 'public' and tablename in ('ts_days','ts_people')$q$, '2/2');
  perform pg_temp.ts_v('A12 ts_views still has exactly one policy: SELECT to authenticated', null, null,
    $q$select count(*) || '/' || string_agg(cmd || ':' || array_to_string(roles, ','), ',') from pg_policies
        where schemaname = 'public' and tablename = 'ts_views'$q$, '1/SELECT:authenticated');

  -- B. anon, stranger, automation@, a Google user with no ts_access row: nothing, no RPC
  perform pg_temp.ts_v('B1 anon cannot read ts_view_grants', 'anon', null, 'select count(*) from public.ts_view_grants', 'ERROR 42501%');
  perform pg_temp.ts_v('B2 anon cannot call ts_admin_set_user_views', 'anon', null,
    format(set_views, mgr, '["zz-vg-v1"]'), 'ERROR 42501%');
  perform pg_temp.ts_v('B3 anon cannot call ts_my_view_ids', 'anon', null, 'select public.ts_my_view_ids()::text', 'ERROR 42501%');
  perform pg_temp.ts_v('B4 anon cannot call ts_can_view (3 arguments)', 'anon', null,
    $q$select public.ts_can_view('filifera', 'Distro/Trim', 'zz-vg-1')::text$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('B5 stranger sees nothing', 'authenticated', null, all_rows, '0');
  perform pg_temp.ts_v('B6 stranger cannot set views', 'authenticated', null, format(set_views, mgr, '["zz-vg-v1"]'), admin_only);
  perform pg_temp.ts_v('B7 stranger cannot call internal ts_can_view', 'authenticated', null,
    $q$select public.ts_can_view('filifera', 'Distro/Trim', 'zz-vg-1')::text$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('B8 stranger: RLS rows = reference rows', 'authenticated', null, rls_rows, pg_temp.ts_v_as('claims', null, ref_rows));
  perform pg_temp.ts_v('B9 automation@ sees nothing', 'authenticated', aut, all_rows, '0');
  perform pg_temp.ts_v('B10 automation@ cannot set views', 'authenticated', aut, format(set_views, mgr, '["zz-vg-v1"]'), admin_only);
  perform pg_temp.ts_v('B11 automation@: RLS rows = reference rows', 'authenticated', aut, rls_rows, pg_temp.ts_v_as('claims', aut, ref_rows));

  -- E. admin (gianni@, Google): gives views through the RPC
  perform pg_temp.ts_v('E1 admin sets a sign-in''s views: ids trimmed, lowercased, deduped; returns the user json', 'authenticated', adm,
    format(set_views, ' ZZ-VG-Mgr@WizardTrees.com ', '[" ZZ-VG-V2 ", "zz-vg-v1", "zz-vg-v2"]'),
    pg_temp.ts_v_lit('true/' || mgr || '/["zz-vg-v1", "zz-vg-v2"]'));
  perform pg_temp.ts_v('E2 stored grants carry updated_by = admin', null, null,
    format($q$select string_agg(view_id || '|' || updated_by, ',' order by view_id) from public.ts_view_grants where email = %L$q$, mgr),
    pg_temp.ts_v_lit('zz-vg-v1|' || adm || ',zz-vg-v2|' || adm));
  perform pg_temp.ts_v('E3 ts_admin_list shows the sign-in''s views', 'authenticated', adm,
    format($q$select (e->'views')::text from jsonb_array_elements(public.ts_admin_list()) e where e->>'email' = %L$q$, mgr),
    pg_temp.ts_v_lit('["zz-vg-v1", "zz-vg-v2"]'));
  perform pg_temp.ts_v('E4 every ts_admin_list user has a views list', 'authenticated', adm,
    $q$select count(*) filter (where jsonb_typeof(e->'views') = 'array') || '/' || count(*) from jsonb_array_elements(public.ts_admin_list()) e$q$,
    (select count(*)::text || '/' || count(*)::text from public.ts_access));
  perform pg_temp.ts_v('E5 setting views REPLACES them', 'authenticated', adm,
    format(set_views, mgr, '["zz-vg-v3"]'), pg_temp.ts_v_lit('true/' || mgr || '/["zz-vg-v3"]'));
  perform pg_temp.ts_v('E6 refuses an unknown view id', 'authenticated', adm,
    format(set_views, mgr, '["zz-vg-v1", "zz-vg-nope"]'), 'ERROR %Unknown view: "zz-vg-nope"%');
  perform pg_temp.ts_v('E7 refuses an email that is not a sign-in yet', 'authenticated', adm,
    format(set_views, 'zz-vg-nobody@wizardtrees.com', '["zz-vg-v1"]'), 'ERROR %Save the sign-in first%');
  perform pg_temp.ts_v('E8 refuses the sync account (never a sign-in)', 'authenticated', adm,
    format(set_views, aut, '["zz-vg-v1"]'), 'ERROR %Save the sign-in first%');
  perform pg_temp.ts_v('E9 refuses views that are not a list', 'authenticated', adm,
    format(set_views, mgr, '{"id":"zz-vg-v1"}'), 'ERROR %must be a list%');
  perform pg_temp.ts_v('E10 refuses a view id that is not text', 'authenticated', adm,
    format(set_views, mgr, '["zz-vg-v1", 7]'), 'ERROR %must be text%');
  perform pg_temp.ts_v('E11 refused saves changed nothing', null, null,
    format($q$select string_agg(view_id, ',' order by view_id) || '/' || (select count(*) from public.ts_view_grants where email like 'zz-vg-nobody%%') from public.ts_view_grants where email = %L$q$, mgr),
    'zz-vg-v3/0');
  perform pg_temp.ts_v('E12 ts_admin_save_user keeps the views and returns them', 'authenticated', adm,
    format($q$select (r->'views')::text || '/' || jsonb_array_length(r->'grants') from (select public.ts_admin_save_user(%L, false, true, 'verify', '[{"company":"filifera","department":"Cultivation"}]') r) s$q$, mgr),
    pg_temp.ts_v_lit('["zz-vg-v3"]/1'));
  perform pg_temp.ts_v('E13 null views clears them', 'authenticated', adm,
    format($q$select (public.ts_admin_set_user_views(%L, null)->'views')::text$q$, mgr), '[]');
  perform pg_temp.ts_v('E14 admin cannot insert into ts_view_grants directly', 'authenticated', adm,
    format($q$insert into public.ts_view_grants (email, view_id) values (%L, 'zz-vg-v1') returning email$q$, mgr), 'ERROR 42501%');
  perform pg_temp.ts_v('E15 admin cannot delete from ts_view_grants directly', 'authenticated', adm,
    $q$delete from public.ts_view_grants returning email$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('E16 admin gives himself views 1 and 2 (allowed; admins see everything anyway)', 'authenticated', adm,
    format(set_views, adm, '["zz-vg-v1","zz-vg-v2"]'), pg_temp.ts_v_lit('true/' || adm || '/["zz-vg-v1", "zz-vg-v2"]'));
  perform pg_temp.ts_v('E17 admin still sees every ts_days, ts_people and ts_views row', 'authenticated', adm,
    $q$select (select count(*) from public.ts_days) || '/' || (select count(*) from public.ts_people) || '/' || (select count(*) from public.ts_views)$q$,
    (select (select count(*) from public.ts_days) || '/' || (select count(*) from public.ts_people) || '/' || (select count(*) from public.ts_views)));
  perform pg_temp.ts_v('E18 admin sees every ts_view_grants row', 'authenticated', adm,
    'select count(*) from public.ts_view_grants', (select count(*)::text from public.ts_view_grants));
  perform pg_temp.ts_v('E19 admin ts_me lists his granted views as {id, label, sort}', 'authenticated', adm, me_views,
    pg_temp.ts_v_lit('true/[{"id": "zz-vg-v1", "sort": 901, "label": "Verify Grant One"}, {"id": "zz-vg-v2", "sort": 902, "label": "Verify Grant Two"}]'));
  perform pg_temp.ts_v('E20 admin: RLS rows = reference rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));

  -- R. reserved department names in views (save RPC and the owner's direct insert alike)
  perform pg_temp.ts_v('R1 a view refuses a department starting with @uuid:', 'authenticated', adm,
    $q$select public.ts_admin_save_view('zz-vg-r', 'Verify R', 0, '[{"company":"filifera","department":"@uuid:zz-vg-1"}]')::text$q$,
    'ERROR %View member 1: a department name cannot start with "@uuid:"%');
  perform pg_temp.ts_v('R2 ... also after trimming, and names the member', 'authenticated', adm,
    $q$select public.ts_admin_save_view('zz-vg-r', 'Verify R', 0, '[{"company":"filifera","department":"Trim"},{"company":"slane","department":"  @uuid:x "}]')::text$q$,
    'ERROR %View member 2: a department name cannot start with "@uuid:"%');
  perform pg_temp.ts_v('R3 a view refuses "*" as a department', 'authenticated', adm,
    $q$select public.ts_admin_save_view('zz-vg-r', 'Verify R', 0, '[{"company":"wafgus","department":"*"}]')::text$q$,
    'ERROR %View member 1: "*" is not a department%');
  perform pg_temp.ts_v('R4 the owner''s direct insert is refused too', null, null,
    $q$insert into public.ts_views (id, label, members) values ('zz-vg-r', 'Verify R', '[{"company":"filifera","department":"@uuid:zz-vg-1"}]') returning id$q$,
    'ERROR %cannot start with "@uuid:"%');
  perform pg_temp.ts_v('R5 ... and so is the owner''s update', null, null,
    $q$update public.ts_views set members = '[{"company":"filifera","department":"@uuid:zz-vg-1"}]' where id = 'zz-vg-v1' returning id$q$,
    'ERROR %cannot start with "@uuid:"%');
  perform pg_temp.ts_v('R6 refused saves wrote nothing, view 1 unchanged', null, null,
    $q$select (select count(*) from public.ts_views where id = 'zz-vg-r') || '/' || (select members::text from public.ts_views where id = 'zz-vg-v1')$q$,
    pg_temp.ts_v_lit('0/' || '[{"company":"filifera","employee_uuid":"zz-vg-1"},{"company":"slane","department":"Distro/Trim"}]'::jsonb::text));
  perform pg_temp.ts_v('R7 a department that merely starts with @ is fine, and a person uuid may start with @uuid:', 'authenticated', adm,
    $q$select (public.ts_admin_save_view('zz-vg-r', 'Verify R', 0, '[{"company":"filifera","department":"@Home"},{"company":"slane","employee_uuid":"@uuid:odd"}]')->'members')::text$q$,
    pg_temp.ts_v_lit('[{"company":"filifera","department":"@Home"},{"company":"slane","employee_uuid":"@uuid:odd"}]'::jsonb::text));
  perform pg_temp.ts_v('R8 (clean-up) that view is deleted', 'authenticated', adm,
    $q$select public.ts_admin_delete_view('zz-vg-r')->>'deleted'$q$, '1');

  -- M. manager with exactly one view (gianni@ demoted: active, not admin, no ts_grants)
  perform pg_temp.ts_v_gianni(false, true, '[]');
  perform pg_temp.ts_v_gianni_views('["zz-vg-v1"]');
  perform pg_temp.ts_v('M1 one view: sees exactly its person and department members (every row)', 'authenticated', adm, got_sql,
    pg_temp.ts_v_as(null, null, format(exp_sql, v1_rule)));
  perform pg_temp.ts_v('M2 one view: the synthetic days seen', 'authenticated', adm, syn_days, pg_temp.ts_v_lit(v1_days));
  perform pg_temp.ts_v('M3 one view: the synthetic people seen', 'authenticated', adm, syn_ppl,
    pg_temp.ts_v_lit('filifera:zz-vg-1,slane:zz-vg-3'));
  perform pg_temp.ts_v('M4 a person member is one person: the same department at the same company stays hidden', 'authenticated', adm,
    $q$select count(*) from public.ts_days where employee_uuid = 'zz-vg-2'$q$, '0');
  perform pg_temp.ts_v('M5 a person member is per company: the same uuid at another company stays hidden', 'authenticated', adm,
    $q$select count(*) from public.ts_days where company = 'slane' and employee_uuid = 'zz-vg-1'$q$, '0');
  perform pg_temp.ts_v('M6 a department spelled like a person key does not reach that person''s grant', 'authenticated', adm,
    $q$select count(*) from public.ts_days where employee_uuid = 'zz-vg-5'$q$, '0');
  perform pg_temp.ts_v('M7 a department member is per company: filifera Distro/Trim stays hidden', 'authenticated', adm,
    $q$select count(*) from public.ts_days where company = 'filifera' and department = 'Distro/Trim' and employee_uuid <> 'zz-vg-1'$q$, '0');
  perform pg_temp.ts_v('M8 one view: sees that view only in ts_views', 'authenticated', adm, syn_view, 'zz-vg-v1');
  perform pg_temp.ts_v('M9 one view: every ts_views row seen is granted (no real view leaks)', 'authenticated', adm,
    $q$select string_agg(id, ',' order by id) from public.ts_views$q$, 'zz-vg-v1');
  perform pg_temp.ts_v('M10 one view: the view''s label and members are readable', 'authenticated', adm,
    $q$select label || '/' || jsonb_array_length(members) from public.ts_views where id = 'zz-vg-v1'$q$, 'Verify Grant One/2');
  perform pg_temp.ts_v('M11 one view: ts_me is active, not admin, no grants, that view', 'authenticated', adm,
    $q$select (public.ts_me()->>'active') || '/' || (public.ts_me()->>'is_admin') || '/' || jsonb_array_length(public.ts_me()->'grants') || '/' || (public.ts_me()->'views')::text$q$,
    pg_temp.ts_v_lit('true/false/0/[{"id": "zz-vg-v1", "sort": 901, "label": "Verify Grant One"}]'));
  perform pg_temp.ts_v('M12 one view: reads only own ts_view_grants rows', 'authenticated', adm,
    $q$select string_agg(email || ':' || view_id, ',') from public.ts_view_grants$q$, pg_temp.ts_v_lit(adm || ':zz-vg-v1'));
  perform pg_temp.ts_v('M13 one view: grant keys', 'authenticated', adm,
    $q$select array_to_string(public.ts_my_grant_keys(), ',')$q$, pg_temp.ts_v_lit('filifera|@uuid:zz-vg-1,slane|Distro/Trim'));
  perform pg_temp.ts_v('M14 reference rule: person, department, company scoping, collision', 'claims', adm,
    $q$select public.ts_can_view('filifera', 'Distro/Trim', 'zz-vg-1') || '/' || public.ts_can_view('filifera', 'Distro/Trim', 'zz-vg-2')
              || '/' || public.ts_can_view('slane', 'Packing', 'zz-vg-1') || '/' || public.ts_can_view('slane', 'Distro/Trim', 'anyone')
              || '/' || public.ts_can_view('filifera', '@uuid:zz-vg-1', 'zz-vg-5') || '/' || public.ts_can_view('slane', 'Distro/Trim')
              || '/' || public.ts_can_view('filifera', 'Distro/Trim')$q$,
    'true/false/false/true/false/true/false');
  perform pg_temp.ts_v('M15 one view: RLS rows = reference rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));
  perform pg_temp.ts_v('M16 one view: still cannot use the admin RPCs', 'authenticated', adm,
    'select public.ts_admin_list()::text', admin_only);
  perform pg_temp.ts_v('M17 one view: cannot set own views', 'authenticated', adm,
    format(set_views, adm, '["zz-vg-v1","zz-vg-v2","zz-vg-v3"]'), admin_only);
  perform pg_temp.ts_v('M18 one view: cannot save a view', 'authenticated', adm,
    $q$select public.ts_admin_save_view('zz-vg-v1', 'Mine', 0, '[{"company":"imperial","department":"Trim"}]')::text$q$, admin_only);
  perform pg_temp.ts_v('M19 one view: cannot delete a view', 'authenticated', adm,
    $q$select public.ts_admin_delete_view('zz-vg-v1')::text$q$, admin_only);
  perform pg_temp.ts_v('M20 one view: cannot grant self a view directly', 'authenticated', adm,
    $q$insert into public.ts_view_grants (email, view_id) values ('gianni@wizardtrees.com', 'zz-vg-v3') returning email$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('M21 one view: cannot widen the view directly', 'authenticated', adm,
    $q$update public.ts_views set members = '[{"company":"imperial","department":"Trim"}]' where id = 'zz-vg-v1' returning id$q$, 'ERROR 42501%');

  -- U. two views = the union
  perform pg_temp.ts_v_gianni_views('["zz-vg-v1","zz-vg-v2"]');
  perform pg_temp.ts_v('U1 two views: sees the union of both (every row)', 'authenticated', adm, got_sql,
    pg_temp.ts_v_as(null, null, format(exp_sql, '(' || v1_rule || ') or (' || v2_rule || ')')));
  perform pg_temp.ts_v('U2 two views: the synthetic days seen', 'authenticated', adm, syn_days, pg_temp.ts_v_lit(v12_days));
  perform pg_temp.ts_v('U3 a department name "*" is not reached by a department member', 'authenticated', adm,
    $q$select count(*) from public.ts_days where employee_uuid = 'zz-vg-10'$q$, '0');
  perform pg_temp.ts_v('U4 two views: both in ts_views, not the third', 'authenticated', adm, syn_view, 'zz-vg-v1,zz-vg-v2');
  perform pg_temp.ts_v('U5 two views: ts_me lists both, in tab order', 'authenticated', adm,
    $q$select string_agg(v->>'id', ',' order by o) from jsonb_array_elements(public.ts_me()->'views') with ordinality t(v, o)$q$, 'zz-vg-v1,zz-vg-v2');
  perform pg_temp.ts_v('U6 two views: RLS rows = reference rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));
  perform pg_temp.ts_v_gianni_views('["zz-vg-v2"]');
  perform pg_temp.ts_v('U7 view 2 alone: exactly its members, incl. the explicit NY person', 'authenticated', adm, syn_days, pg_temp.ts_v_lit(v2_days));
  perform pg_temp.ts_v('U8 view 2 alone: RLS rows = reference rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));

  -- G. views together with ts_grants: the union; a ts_grants row never reveals a view
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"imperial","department":"*"}]');
  perform pg_temp.ts_v_gianni_views('["zz-vg-v1"]');
  perform pg_temp.ts_v('G1 view + whole-company grant: the union (every row)', 'authenticated', adm, got_sql,
    pg_temp.ts_v_as(null, null, format(exp_sql, '(' || v1_rule || $r$) or company = 'imperial'$r$)));
  perform pg_temp.ts_v('G2 ... but view 3 (all imperial) stays unreadable', 'authenticated', adm, syn_view, 'zz-vg-v1');
  perform pg_temp.ts_v('G3 view + grant: RLS rows = reference rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"filifera","department":"@uuid:zz-vg-2"},{"company":"wafgus","department":"*"}]');
  perform pg_temp.ts_v_gianni_views('[]');
  perform pg_temp.ts_v('G4 a ts_grants department spelled like a person key reaches nobody; (wafgus,*) reaches the "*" department', 'authenticated', adm,
    $q$select (select count(*) from public.ts_days where company = 'filifera') || '/' || (select count(*) from public.ts_days where employee_uuid = 'zz-vg-10')$q$, '0/2');
  perform pg_temp.ts_v('G5 grants only: RLS rows = reference rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));
  perform pg_temp.ts_v('G6 grants only: no view readable', 'authenticated', adm, 'select count(*) from public.ts_views', '0');

  -- P. the manager's account in a session that was not a Google sign-in: nothing
  perform pg_temp.ts_v_gianni(false, true, '[]');
  perform pg_temp.ts_v_gianni_views('["zz-vg-v1","zz-vg-v2"]');
  perform pg_temp.ts_v('P1 password session of a manager with views sees nothing', 'authenticated', adm, all_rows, '0', 'password');
  perform pg_temp.ts_v('P2 password session: ts_me has no email and no views', 'authenticated', adm,
    $q$select coalesce(public.ts_me()->>'email', '(none)') || '/' || (public.ts_me()->'views')::text$q$, '(none)/[]', 'password');
  perform pg_temp.ts_v('P3 password session: no grant keys, no view ids', 'authenticated', adm,
    $q$select cardinality(public.ts_my_grant_keys()) || '/' || cardinality(public.ts_my_view_ids())$q$, '0/0', 'password');
  perform pg_temp.ts_v('P4 OTP / magic-link session sees nothing', 'authenticated', adm, all_rows, '0', 'otp');
  perform pg_temp.ts_v('P5 password session: RLS rows = reference rows', 'authenticated', adm, rls_rows,
    pg_temp.ts_v_as('claims', adm, ref_rows, 'password'), 'password');
  perform pg_temp.ts_v('P6 the same account signed in with Google sees both views', 'authenticated', adm, syn_view, 'zz-vg-v1,zz-vg-v2');

  -- H. deactivated: nothing (the grants stay, for when the sign-in is turned back on)
  perform pg_temp.ts_v_gianni(false, false, '[]');
  perform pg_temp.ts_v('H1 inactive manager with views sees no day, person or view', 'authenticated', adm,
    $q$select (select count(*) from public.ts_days) + (select count(*) from public.ts_people) + (select count(*) from public.ts_views)$q$, '0');
  perform pg_temp.ts_v('H2 inactive: ts_me inactive, no views', 'authenticated', adm, me_views, 'false/[]');
  perform pg_temp.ts_v('H3 inactive: no grant keys, no view ids', 'authenticated', adm,
    $q$select cardinality(public.ts_my_grant_keys()) || '/' || cardinality(public.ts_my_view_ids())$q$, '0/0');
  perform pg_temp.ts_v('H4 inactive: RLS rows = reference rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));
  perform pg_temp.ts_v_gianni(true, false, '[]');
  perform pg_temp.ts_v('H5 inactive admin with views sees nothing', 'authenticated', adm,
    $q$select (select count(*) from public.ts_days) + (select count(*) from public.ts_people) + (select count(*) from public.ts_views)$q$, '0');

  -- N. a Google sign-in with no ts_access row: its old grants went with the row (cascade)
  delete from public.ts_access where email = adm;
  perform pg_temp.ts_v('N1 removing a sign-in removes its view grants', null, null,
    format('select count(*) from public.ts_view_grants where email = %L', adm), '0');
  perform pg_temp.ts_v('N2 no-access Google user sees nothing', 'authenticated', adm, all_rows, '0');
  perform pg_temp.ts_v('N3 no-access Google user: RLS rows = reference rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));
  perform pg_temp.ts_v_gianni(true, true, '[]');

  -- X. revoking through the RPC, then deleting and renaming a view
  perform pg_temp.ts_v('X1 (admin) gives himself view 1 again', 'authenticated', adm,
    format(set_views, adm, '["zz-vg-v1"]'), pg_temp.ts_v_lit('true/' || adm || '/["zz-vg-v1"]'));
  perform pg_temp.ts_v_gianni(false, true, '[]');
  perform pg_temp.ts_v('X2 (demoted) sees view 1''s crew', 'authenticated', adm, syn_days, pg_temp.ts_v_lit(v1_days));
  perform pg_temp.ts_v_gianni(true, true, '[]');
  perform pg_temp.ts_v('X3 (admin) revokes all his views', 'authenticated', adm,
    format(set_views, adm, '[]'), pg_temp.ts_v_lit('true/' || adm || '/[]'));
  perform pg_temp.ts_v_gianni(false, true, '[]');
  perform pg_temp.ts_v('X4 revoked: sees nothing', 'authenticated', adm, all_rows, '0');
  perform pg_temp.ts_v('X5 revoked: RLS rows = reference rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));
  perform pg_temp.ts_v_gianni(true, true, '[]');
  perform pg_temp.ts_v('X6 (admin) gives the throwaway sign-in and himself view 2', 'authenticated', adm,
    format($q$select (public.ts_admin_set_user_views(%L, '["zz-vg-v2"]')->'views')::text || (public.ts_admin_set_user_views(%L, '["zz-vg-v2","zz-vg-v1"]')->'views')::text$q$, mgr, adm),
    pg_temp.ts_v_lit('["zz-vg-v2"]["zz-vg-v1", "zz-vg-v2"]'));
  perform pg_temp.ts_v('X7 (admin) deletes view 2', 'authenticated', adm,
    $q$select public.ts_admin_delete_view('zz-vg-v2')->>'deleted'$q$, '1');
  perform pg_temp.ts_v('X8 deleting a view removed every grant of it', null, null,
    $q$select count(*) from public.ts_view_grants where view_id = 'zz-vg-v2'$q$, '0');
  perform pg_temp.ts_v('X9 ... and left the other grants', null, null,
    format($q$select string_agg(email || ':' || view_id, ',' order by email, view_id) from public.ts_view_grants where email in (%L, %L)$q$, adm, mgr),
    pg_temp.ts_v_lit(adm || ':zz-vg-v1'));
  perform pg_temp.ts_v_gianni(false, true, '[]');
  perform pg_temp.ts_v('X10 (demoted) view 2''s crew is gone, view 1''s stays', 'authenticated', adm, syn_days, pg_temp.ts_v_lit(v1_days));
  perform pg_temp.ts_v('X11 (demoted) ts_me lists view 1 only', 'authenticated', adm,
    $q$select string_agg(v->>'id', ',') from jsonb_array_elements(public.ts_me()->'views') v$q$, 'zz-vg-v1');
  update public.ts_views set id = 'zz-vg-v1b' where id = 'zz-vg-v1';
  perform pg_temp.ts_v('X12 renaming a view''s id carries its grants along', 'authenticated', adm,
    $q$select string_agg(view_id, ',') || '/' || array_to_string(public.ts_my_view_ids(), ',') from public.ts_view_grants$q$, 'zz-vg-v1b/zz-vg-v1b');
  perform pg_temp.ts_v('X13 renamed: RLS rows = reference rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));
  perform pg_temp.ts_v_gianni(true, true, '[]');
  perform pg_temp.ts_v('X14 deleting the throwaway sign-in removes its grants', 'authenticated', adm,
    format($q$select (public.ts_admin_set_user_views(%L, '["zz-vg-v3"]')->>'ok') || '/' || (public.ts_admin_delete_user(%L)->>'deleted') || '/' || (select count(*) from public.ts_view_grants where email = %L)$q$, mgr, mgr, mgr),
    'true/1/0');
  perform pg_temp.ts_v('X15 the owner cannot grant a view to an email that is not a sign-in', null, null,
    $q$insert into public.ts_view_grants (email, view_id) values ('zz-vg-nobody@wizardtrees.com', 'zz-vg-v3') returning email$q$, 'ERROR 23503%');
  perform pg_temp.ts_v('X16 ... nor a view that does not exist', null, null,
    $q$insert into public.ts_view_grants (email, view_id) values ('gianni@wizardtrees.com', 'zz-vg-nope') returning email$q$, 'ERROR 23503%');
  perform pg_temp.ts_v('X17 admin at the end: RLS rows = reference rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));
end $v$;

-- ------------------------------------------------------------------ result (then everything rolls back)
select seq, test, expected, got, pass
  from (select seq, test, expected, got, (got like expected escape '!') as pass from ts_v_results
        union all
        select 0, 'SUMMARY: ' || count(*) filter (where got like expected escape '!') || ' of ' || count(*) || ' checks pass',
               '', '', bool_and(got like expected escape '!')
          from ts_v_results) r
 order by seq;

rollback;
