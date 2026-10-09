-- RLS + RPC verification for supabase/ts-ca-timesheets.sql (Manager Timesheets, CA).
--
-- One transaction that ROLLS BACK: it writes throwaway rows (synthetic people "Test Person ...",
-- dates in 2001-2002, temporary companies 'zz_verify' (CA) and 'zz_verify_ny' (NY), a throwaway
-- allowlist email zz-verify-mgr@wizardtrees.com), plays each identity, records what each one can
-- see or do, returns one pass/fail table, and undoes everything. Run it with write access as the
-- project owner (SQL editor or the management API without read_only); the API shows the last
-- result set, which is the pass/fail table. Every row must say pass = true.
--
-- Identities. Real auth.users rows are needed only for gianni@ and automation@ (looked up by email).
-- Each simulated session carries a JWT amr: 'oauth' (a Google sign-in, what the page makes) unless
-- a check says otherwise; automation@ always signs in with a password.
--   anon                  role anon, no JWT
--   stranger              role authenticated, a random sub with no auth.users and no ts_access row
--   no-access staff       automation@ (password): a confirmed @wizardtrees.com sign-in that passes
--                         is_staff(), with no ts_access row (ts_access refuses that email)
--   BA                    gianni@ (Google) with his ts_access row removed: any Google sign-in
--                         that is not on the allowlist
--   admin                 gianni@ (Google), forced to an active admin row
--   password session      gianni@ signed in by password / OTP / recovery / a JWT without amr, as
--                         after a BA-app admin resets his password: must see nothing
--   limited manager       gianni@ (Google) with his row set to non-admin + (filifera, 'Distro/Trim')
--   all-access manager    gianni@ with ('*','*'), then ('slane','*'), then mixed grants, then NY
--   inactive              gianni@ with active = false
--   producer              automation@ (password) calling ts_sync (gated on the email, not ts_access)
-- The manager states are set on gianni's own row as the owner (rolled back), because the admin
-- RPCs refuse self-demotion and no other real Google account is assumed to exist.
-- If the E checks fail with the admin seeing nothing, gianni's auth.identities Google row lacks
-- the wizardtrees.com hd claim or his email (see ts_my_email).
-- Expected counts are computed as the owner (which bypasses RLS), so real rows already in the
-- tables do not break the checks.

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

-- As the owner: set gianni@'s own allowlist row and grants (rolled back with everything else).
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

-- ------------------------------------------------------------------ setup (as owner, rolled back)
select pg_temp.ts_v_gianni(true, true, '[]');

insert into public.ts_companies (key, name) values ('zz_verify', 'Verify Test Co') on conflict do nothing;
insert into public.ts_companies (key, name, region) values ('zz_verify_ny', 'Verify Test NY', 'NY') on conflict do nothing;

insert into public.ts_people (company, employee_uuid, name, department) values
  ('filifera',     'zz-verify-1', 'Test Person One',   'Distro/Trim'),
  ('filifera',     'zz-verify-2', 'Test Person Two',   'Cultivation'),
  ('slane',        'zz-verify-3', 'Test Person Three', 'Distro/Trim'),
  ('zz_verify_ny', 'zz-verify-9', 'Test Person Nine',  'Cultivation'),
  ('zz_verify',    'zz-B',        'Test Person B',     'No department'),
  ('zz_verify',    'zz-F',        'Test Person F',     'No department');
insert into public.ts_days (id, company, region, employee_uuid, employee_name, department, work_date, worked_min) values
  ('filifera:zz-verify-1:2001-01-01',     'filifera',     'CA', 'zz-verify-1', 'Test Person One',   'Distro/Trim', '2001-01-01', 480),
  ('filifera:zz-verify-1:2001-01-02',     'filifera',     'CA', 'zz-verify-1', 'Test Person One',   'Distro/Trim', '2001-01-02', 450),
  ('filifera:zz-verify-2:2001-01-01',     'filifera',     'CA', 'zz-verify-2', 'Test Person Two',   'Cultivation', '2001-01-01', 300),
  ('slane:zz-verify-3:2001-01-01',        'slane',        'CA', 'zz-verify-3', 'Test Person Three', 'Distro/Trim', '2001-01-01', 420),
  ('zz_verify_ny:zz-verify-9:2001-01-01', 'zz_verify_ny', 'NY', 'zz-verify-9', 'Test Person Nine',  'Cultivation', '2001-01-01', 400);

-- the sync key for this run (ts_sync checks the x-ts-sync-key request header against its sha256)
insert into public.ts_sync_keys (key_hash, label)
values (encode(sha256(convert_to('zz-verify-sync-key', 'utf8')), 'hex'), 'verify (rolled back)');
select set_config('request.headers', '{"x-ts-sync-key":"zz-verify-sync-key"}', true);

-- ts_sync fixtures in the temporary CA company
insert into public.ts_days (id, company, employee_uuid, employee_name, work_date) values
  ('zz_verify:zz-A:2001-02-01', 'zz_verify', 'zz-A', 'Test Person A', '2001-02-01'),
  ('zz_verify:zz-A:2001-02-02', 'zz_verify', 'zz-A', 'Test Person A', '2001-02-02'),
  ('zz_verify:zz-A:2001-02-03', 'zz_verify', 'zz-A', 'Test Person A', '2001-02-03'),
  ('zz_verify:zz-B:2001-02-01', 'zz_verify', 'zz-B', 'Test Person B', '2001-02-01'),   -- not active in Gusto
  ('zz_verify:zz-F:2001-02-10', 'zz_verify', 'zz-F', 'Test Person F', '2001-02-10'),   -- active, but no shifts in the pull
  ('zz_verify:zz-F:2001-02-11', 'zz_verify', 'zz-F', 'Test Person F', '2001-02-11'),
  ('zz_verify:zz-F:2001-02-12', 'zz_verify', 'zz-F', 'Test Person F', '2001-02-12'),
  ('zz_verify:zz-A:2001-03-15', 'zz_verify', 'zz-A', 'Test Person A', '2001-03-15');   -- outside the window
insert into public.ts_days (id, company, employee_uuid, employee_name, work_date)
select 'zz_verify:' || e.uuid || ':' || to_char(d, 'YYYY-MM-DD'), 'zz_verify', e.uuid, 'Test Person ' || e.uuid, d::date
  from (values ('zz-C', date '2001-04-01', 40), ('zz-D', date '2001-06-01', 40), ('zz-E', date '2001-08-01', 100),
               ('zz-G', date '2002-01-01', 40), ('zz-H', date '2002-01-01', 100))
       as e(uuid, start_day, n),
       generate_series(e.start_day, e.start_day + (e.n - 1), interval '1 day') d;

-- ------------------------------------------------------------------ checks
do $v$
declare
  adm  constant text := 'gianni@wizardtrees.com';
  aut  constant text := 'automation@wizardtrees.com';
  mgr  constant text := 'zz-verify-mgr@wizardtrees.com';
  sync_any constant text := $q$select public.ts_sync('filifera', '2001-01-01', '2001-01-31', '[]', '[]', '{}')::text$q$;
  -- everything the caller can read in the five tables
  all_rows constant text := $q$select (select count(*) from public.ts_days) + (select count(*) from public.ts_people)
                                   + (select count(*) from public.ts_companies) + (select count(*) from public.ts_access)
                                   + (select count(*) from public.ts_grants)$q$;
  -- the rows RLS lets the caller see, and the rows the reference rule ts_can_view() allows
  rls_rows constant text := $q$select md5(coalesce((select string_agg(id, ',' order by id) from public.ts_days), '')
                                   || '#' || coalesce((select string_agg(company || ':' || employee_uuid, ',' order by company, employee_uuid) from public.ts_people), ''))$q$;
  ref_rows constant text := $q$select md5(coalesce((select string_agg(id, ',' order by id) from public.ts_days where public.ts_can_view(company, department)), '')
                                   || '#' || coalesce((select string_agg(company || ':' || employee_uuid, ',' order by company, employee_uuid) from public.ts_people where public.ts_can_view(company, department)), ''))$q$;
  me_txt   constant text := $q$select coalesce(public.ts_me()->>'email', '(none)') || '/' || (public.ts_me()->>'active') || '/' || (public.ts_me()->>'is_admin') || '/' || jsonb_array_length(public.ts_me()->'grants')$q$;
  payload jsonb;
begin
  -- A. catalog
  perform pg_temp.ts_v('A1 RLS is on for all five ts tables', null, null,
    $q$select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
          and c.relname in ('ts_companies','ts_people','ts_days','ts_access','ts_grants')$q$, '5');
  perform pg_temp.ts_v('A2 ts tables have exactly 5 policies, all SELECT', null, null,
    $q$select count(*) filter (where cmd = 'SELECT') || '/' || count(*) from pg_policies
        where schemaname = 'public' and tablename in ('ts_companies','ts_people','ts_days','ts_access','ts_grants')$q$, '5/5');
  perform pg_temp.ts_v('A3 anon holds no privilege on any ts table', null, null,
    $q$select count(*) from unnest(array['ts_companies','ts_people','ts_days','ts_access','ts_grants']) t,
        unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
        where has_table_privilege('anon', 'public.' || t, p)$q$, '0');
  perform pg_temp.ts_v('A4 authenticated holds SELECT and nothing else on ts tables', null, null,
    $q$select count(*) filter (where p = 'SELECT') || '/' || count(*) from unnest(array['ts_companies','ts_people','ts_days','ts_access','ts_grants']) t,
        unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
        where has_table_privilege('authenticated', 'public.' || t, p)$q$, '5/5');
  perform pg_temp.ts_v('A5 anon can execute no ts_ function', null, null,
    $q$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'ts\_%' and has_function_privilege('anon', p.oid, 'EXECUTE')$q$, '0');
  -- (the saved-view RPCs from ts-views.sql are checked by ts-views-verify.sql, so this list holds
  --  with or without that file applied)
  perform pg_temp.ts_v('A6 authenticated can execute exactly these ts_ functions', null, null,
    $q$select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'ts\_%' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
          and p.proname not in ('ts_admin_save_view', 'ts_admin_delete_view')$q$,
    'ts!_admin!_delete!_user,ts!_admin!_list,ts!_admin!_save!_user,ts!_is!_admin,ts!_me,ts!_my!_email,ts!_my!_grant!_keys,ts!_sync');
  perform pg_temp.ts_v('A7 every ts_ function is security definer with search_path=public', null, null,
    $q$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'ts\_%'
          and not (p.prosecdef and coalesce(array_to_string(p.proconfig, ',') like '%search_path=public%', false))$q$, '0');

  -- B. anon: no table, no function
  perform pg_temp.ts_v('B1 anon cannot read ts_days',      'anon', null, 'select count(*) from public.ts_days',      'ERROR 42501%');
  perform pg_temp.ts_v('B2 anon cannot read ts_people',    'anon', null, 'select count(*) from public.ts_people',    'ERROR 42501%');
  perform pg_temp.ts_v('B3 anon cannot read ts_companies', 'anon', null, 'select count(*) from public.ts_companies', 'ERROR 42501%');
  perform pg_temp.ts_v('B4 anon cannot read ts_access',    'anon', null, 'select count(*) from public.ts_access',    'ERROR 42501%');
  perform pg_temp.ts_v('B5 anon cannot read ts_grants',    'anon', null, 'select count(*) from public.ts_grants',    'ERROR 42501%');
  perform pg_temp.ts_v('B6 anon cannot call ts_me',        'anon', null, 'select public.ts_me()::text',              'ERROR 42501%');
  perform pg_temp.ts_v('B7 anon cannot call ts_is_admin',  'anon', null, 'select public.ts_is_admin()::text',        'ERROR 42501%');
  perform pg_temp.ts_v('B8 anon cannot call ts_my_email',  'anon', null, 'select public.ts_my_email()',              'ERROR 42501%');
  perform pg_temp.ts_v('B9 anon cannot call ts_can_view',  'anon', null, $q$select public.ts_can_view('filifera','Distro/Trim')::text$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('B10 anon cannot call ts_sync',     'anon', null, sync_any,                                   'ERROR 42501%');
  perform pg_temp.ts_v('B11 anon cannot call ts_admin_list', 'anon', null, 'select public.ts_admin_list()::text',    'ERROR 42501%');
  perform pg_temp.ts_v('B12 anon cannot call ts_admin_save_user', 'anon', null,
    $q$select public.ts_admin_save_user('x@wizardtrees.com', true, true, null, '[]')::text$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('B13 anon cannot call ts_admin_delete_user', 'anon', null,
    $q$select public.ts_admin_delete_user('gianni@wizardtrees.com')::text$q$, 'ERROR 42501%');

  -- C. signed-in stranger (no auth.users row, no ts_access row)
  perform pg_temp.ts_v('C1 stranger sees no ts_days',      'authenticated', null, 'select count(*) from public.ts_days',      '0');
  perform pg_temp.ts_v('C2 stranger sees no ts_people',    'authenticated', null, 'select count(*) from public.ts_people',    '0');
  perform pg_temp.ts_v('C3 stranger sees no ts_companies', 'authenticated', null, 'select count(*) from public.ts_companies', '0');
  perform pg_temp.ts_v('C4 stranger sees no ts_access',    'authenticated', null, 'select count(*) from public.ts_access',    '0');
  perform pg_temp.ts_v('C5 stranger sees no ts_grants',    'authenticated', null, 'select count(*) from public.ts_grants',    '0');
  perform pg_temp.ts_v('C6 stranger ts_me is inactive, no grants', 'authenticated', null,
    $q$select (public.ts_me()->>'active') || '/' || (public.ts_me()->>'is_admin') || '/' || jsonb_array_length(public.ts_me()->'grants')$q$, 'false/false/0');
  perform pg_temp.ts_v('C7 stranger cannot call ts_admin_list', 'authenticated', null, 'select public.ts_admin_list()::text', 'ERROR 42501%');
  perform pg_temp.ts_v('C8 stranger cannot call ts_sync',  'authenticated', null, sync_any, 'ERROR 42501%');
  perform pg_temp.ts_v('C9 stranger cannot call internal ts_can_view', 'authenticated', null,
    $q$select public.ts_can_view('filifera','Distro/Trim')::text$q$, 'ERROR 42501%');

  -- D. confirmed @wizardtrees.com sign-ins with no ts_access row
  perform pg_temp.ts_v('D1 no-access staff passes is_staff() (same as a BA)', 'authenticated', aut, 'select public.is_staff()::text', 'true');
  perform pg_temp.ts_v('D2 no-access staff sees no ts_days',      'authenticated', aut, 'select count(*) from public.ts_days',      '0');
  perform pg_temp.ts_v('D3 no-access staff sees no ts_people',    'authenticated', aut, 'select count(*) from public.ts_people',    '0');
  perform pg_temp.ts_v('D4 no-access staff sees no ts_companies', 'authenticated', aut, 'select count(*) from public.ts_companies', '0');
  perform pg_temp.ts_v('D5 no-access staff sees no ts_access or ts_grants', 'authenticated', aut,
    'select (select count(*) from public.ts_access) + (select count(*) from public.ts_grants)', '0');
  perform pg_temp.ts_v('D6 no-access staff ts_me is inactive, no grants', 'authenticated', aut, me_txt, aut || '/false/false/0');
  perform pg_temp.ts_v('D7 no-access staff cannot call ts_admin_list', 'authenticated', aut, 'select public.ts_admin_list()::text', 'ERROR 42501%');
  perform pg_temp.ts_v('D8 no-access staff: RLS rows = ts_can_view rows', 'authenticated', aut, rls_rows, pg_temp.ts_v_as('claims', aut, ref_rows));
  delete from public.ts_access where email = adm;   -- the BA case; restored right below (and rolled back)
  perform pg_temp.ts_v('D9 Google sign-in with no ts_access row (any BA): ts_me inactive', 'authenticated', adm, me_txt, adm || '/false/false/0');
  perform pg_temp.ts_v('D10 Google sign-in with no ts_access row sees nothing in any ts table', 'authenticated', adm, all_rows, '0');
  perform pg_temp.ts_v('D11 Google sign-in with no ts_access row: RLS rows = ts_can_view rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));
  perform pg_temp.ts_v_gianni(true, true, '[]');

  -- E. admin (gianni@, Google sign-in)
  perform pg_temp.ts_v('E1 admin sees every ts_days row',     'authenticated', adm, 'select count(*) from public.ts_days',      (select count(*)::text from public.ts_days));
  perform pg_temp.ts_v('E2 admin sees every ts_people row',   'authenticated', adm, 'select count(*) from public.ts_people',    (select count(*)::text from public.ts_people));
  perform pg_temp.ts_v('E3 admin sees every ts_companies row','authenticated', adm, 'select count(*) from public.ts_companies', (select count(*)::text from public.ts_companies));
  perform pg_temp.ts_v('E4 admin sees every ts_access row',   'authenticated', adm, 'select count(*) from public.ts_access',    (select count(*)::text from public.ts_access));
  perform pg_temp.ts_v('E5 admin sees every ts_grants row',   'authenticated', adm, 'select count(*) from public.ts_grants',    (select count(*)::text from public.ts_grants));
  perform pg_temp.ts_v('E6 admin ts_is_admin and ts_me',      'authenticated', adm,
    $q$select public.ts_is_admin()::text || '/' || (public.ts_me()->>'active') || '/' || (public.ts_me()->>'is_admin')$q$, 'true/true/true');
  perform pg_temp.ts_v('E6b admin: RLS rows = ts_can_view rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));
  perform pg_temp.ts_v('E6c even an admin cannot call internal ts_user_json', 'authenticated', adm,
    $q$select public.ts_user_json('gianni@wizardtrees.com')::text$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('E7 admin ts_admin_list lists every user', 'authenticated', adm,
    'select jsonb_array_length(public.ts_admin_list())::text', (select count(*)::text from public.ts_access));
  perform pg_temp.ts_v('E8 admin cannot remove own admin flag', 'authenticated', adm,
    $q$select public.ts_admin_save_user('gianni@wizardtrees.com', false, true, 'owner', '[{"company":"*","department":"*"}]')::text$q$, 'ERROR %own admin access%');
  perform pg_temp.ts_v('E9 admin cannot deactivate self', 'authenticated', adm,
    $q$select public.ts_admin_save_user('gianni@wizardtrees.com', true, false, 'owner', '[]')::text$q$, 'ERROR %own admin access%');
  perform pg_temp.ts_v('E10 self-lockout check survives case and spaces', 'authenticated', adm,
    $q$select public.ts_admin_save_user('  Gianni@WizardTrees.com ', null, true, null, '[]')::text$q$, 'ERROR %own admin access%');
  perform pg_temp.ts_v('E11 admin cannot delete self', 'authenticated', adm,
    $q$select public.ts_admin_delete_user('GIANNI@wizardtrees.com')::text$q$, 'ERROR %own access%');
  perform pg_temp.ts_v('E12 save refuses a non-company email', 'authenticated', adm,
    $q$select public.ts_admin_save_user('someone@gmail.com', false, true, null, '[]')::text$q$, 'ERROR %@wizardtrees.com%');
  perform pg_temp.ts_v('E13 save refuses an unknown company grant', 'authenticated', adm,
    $q$select public.ts_admin_save_user(' ZZ-Verify-Mgr@WizardTrees.com', false, true, null, '[{"company":"acme","department":"*"}]')::text$q$, 'ERROR %Unknown company%');
  perform pg_temp.ts_v('E14 save refuses a blank department grant', 'authenticated', adm,
    $q$select public.ts_admin_save_user('zz-verify-mgr@wizardtrees.com', false, true, null, '[{"company":"filifera","department":" "}]')::text$q$, 'ERROR %blank department%');
  perform pg_temp.ts_v('E15 refused saves wrote nothing', null, null,
    format('select count(*) from public.ts_access where email = %L', mgr), '0');
  perform pg_temp.ts_v('E16 admin cannot insert into ts_access directly', 'authenticated', adm,
    $q$insert into public.ts_access (email) values ('zz-direct@wizardtrees.com') returning email$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('E17 admin cannot update ts_days directly', 'authenticated', adm,
    $q$update public.ts_days set note = 'x' where id = 'filifera:zz-verify-1:2001-01-01' returning id$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('E18 admin cannot delete ts_grants directly', 'authenticated', adm,
    $q$delete from public.ts_grants where email = 'gianni@wizardtrees.com' returning email$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('E19 admin cannot call ts_sync', 'authenticated', adm, sync_any, 'ERROR 42501%');
  perform pg_temp.ts_v('E20 admin adds a manager (email normalised)', 'authenticated', adm,
    $q$select public.ts_admin_save_user(' ZZ-Verify-Mgr@WizardTrees.com ', false, true, 'verify',
         '[{"company":"filifera","department":"Cultivation"},{"company":"slane","department":"*"}]')->>'email'$q$, mgr);
  perform pg_temp.ts_v('E21 re-save REPLACES the grants', 'authenticated', adm,
    $q$select jsonb_array_length(public.ts_admin_save_user('zz-verify-mgr@wizardtrees.com', false, true, 'verify',
         '[{"company":"Filifera","department":"Distro/Trim"},{"company":"filifera","department":"Distro/Trim"}]')->'grants')::text$q$, '1');
  perform pg_temp.ts_v('E22 stored grant is exactly filifera / Distro/Trim, updated_by = admin', null, null,
    format('select string_agg(company || $$|$$ || department || $$|$$ || updated_by, $$,$$) from public.ts_grants where email = %L', mgr),
    'filifera|Distro/Trim|gianni@wizardtrees.com');
  perform pg_temp.ts_v('E23 admin can save an all-CA grant', 'authenticated', adm,
    $q$select public.ts_admin_save_user('zz-verify-mgr@wizardtrees.com', false, true, 'verify', '[{"company":"*","department":"*"}]')->'grants'->0->>'company'$q$, '*');
  perform pg_temp.ts_v('E24 admin cannot give the sync account a view', 'authenticated', adm,
    $q$select public.ts_admin_save_user(' Automation@WizardTrees.com', false, true, null, '[{"company":"*","department":"*"}]')::text$q$, 'ERROR %sync account%');
  perform pg_temp.ts_v('E25 even the owner cannot put the sync account in ts_access', null, null,
    $q$insert into public.ts_access (email) values ('automation@wizardtrees.com') returning email$q$, 'ERROR 23514%');

  -- P. the admin's account in a session that was NOT a Google sign-in (e.g. after a BA-app admin
  --    reset his password, or a magic link): nothing at all
  perform pg_temp.ts_v('P1 password session of an admin: ts_me has no email, inactive', 'authenticated', adm, me_txt, '(none)/false/false/0', 'password');
  perform pg_temp.ts_v('P2 password session of an admin sees nothing in any ts table', 'authenticated', adm, all_rows, '0', 'password');
  perform pg_temp.ts_v('P3 password session of an admin is not an admin', 'authenticated', adm,
    'select public.ts_is_admin()::text || cardinality(public.ts_my_grant_keys())', 'false0', 'password');
  perform pg_temp.ts_v('P4 password session of an admin cannot list users', 'authenticated', adm, 'select public.ts_admin_list()::text', 'ERROR 42501%', 'password');
  perform pg_temp.ts_v('P5 password session of an admin cannot grant anyone anything', 'authenticated', adm,
    $q$select public.ts_admin_save_user('zz-verify-mgr@wizardtrees.com', true, true, null, '[{"company":"*","department":"*"}]')::text$q$, 'ERROR 42501%', 'password');
  perform pg_temp.ts_v('P6 OTP / magic-link session of an admin sees nothing', 'authenticated', adm, all_rows, '0', 'otp');
  perform pg_temp.ts_v('P7 recovery session of an admin sees nothing', 'authenticated', adm, all_rows, '0', 'recovery');
  perform pg_temp.ts_v('P8 a JWT without amr sees nothing', 'authenticated', adm, all_rows, '0', 'none');
  perform pg_temp.ts_v('P9 password session: RLS rows = ts_can_view rows', 'authenticated', adm, rls_rows,
    pg_temp.ts_v_as('claims', adm, ref_rows, 'password'), 'password');
  perform pg_temp.ts_v('P10 the same account signed in with Google is still admin', 'authenticated', adm,
    $q$select public.ts_is_admin()::text$q$, 'true', 'oauth');

  -- F. limited manager: (filifera, Distro/Trim)
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"filifera","department":"Distro/Trim"}]');
  perform pg_temp.ts_v('F1 manager sees every filifera Distro/Trim day', 'authenticated', adm, 'select count(*) from public.ts_days',
    (select count(*)::text from public.ts_days where company = 'filifera' and department = 'Distro/Trim'));
  perform pg_temp.ts_v('F2 manager sees no day outside the grant', 'authenticated', adm,
    $q$select count(*) from public.ts_days where not (company = 'filifera' and department = 'Distro/Trim')$q$, '0');
  perform pg_temp.ts_v('F3 manager sees the synthetic Distro/Trim days', 'authenticated', adm,
    $q$select count(*) from public.ts_days where id like 'filifera:zz-verify-1:%'$q$, '2');
  perform pg_temp.ts_v('F4 manager sees every filifera Distro/Trim person', 'authenticated', adm, 'select count(*) from public.ts_people',
    (select count(*)::text from public.ts_people where company = 'filifera' and department = 'Distro/Trim'));
  perform pg_temp.ts_v('F5 manager sees no person outside the grant', 'authenticated', adm,
    $q$select count(*) from public.ts_people where not (company = 'filifera' and department = 'Distro/Trim')$q$, '0');
  perform pg_temp.ts_v('F6 manager sees company freshness rows', 'authenticated', adm, 'select count(*) from public.ts_companies',
    (select count(*)::text from public.ts_companies));
  perform pg_temp.ts_v('F7 manager reads only own ts_access row', 'authenticated', adm,
    'select string_agg(email, $$,$$) from public.ts_access', adm);
  perform pg_temp.ts_v('F8 manager reads only own ts_grants rows', 'authenticated', adm,
    $q$select count(*) filter (where email <> 'gianni@wizardtrees.com') || '/' || count(*) from public.ts_grants$q$, '0/1');
  perform pg_temp.ts_v('F9 manager ts_me: active, not admin, one grant', 'authenticated', adm,
    $q$select (public.ts_me()->>'active') || '/' || (public.ts_me()->>'is_admin') || '/' || (public.ts_me()->'grants'->0->>'company') || '/' || (public.ts_me()->'grants'->0->>'department')$q$,
    'true/false/filifera/Distro/Trim');
  perform pg_temp.ts_v('F10 manager grant keys', 'authenticated', adm,
    $q$select array_to_string(public.ts_my_grant_keys(), ',')$q$, 'filifera|Distro/Trim');
  perform pg_temp.ts_v('F10b reference rule ts_can_view matches the grant only', 'claims', adm,
    $q$select public.ts_can_view('filifera','Distro/Trim') || '/' || public.ts_can_view('filifera','Cultivation') || '/' || public.ts_can_view('slane','Distro/Trim')$q$,
    'true/false/false');
  perform pg_temp.ts_v('F10c limited manager: RLS rows = ts_can_view rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));
  perform pg_temp.ts_v('F10d limited manager in a password session sees nothing', 'authenticated', adm, all_rows, '0', 'password');
  perform pg_temp.ts_v('F11 manager cannot call ts_admin_list', 'authenticated', adm, 'select public.ts_admin_list()::text', 'ERROR 42501%');
  perform pg_temp.ts_v('F12 manager cannot make self admin', 'authenticated', adm,
    $q$select public.ts_admin_save_user('gianni@wizardtrees.com', true, true, null, '[{"company":"*","department":"*"}]')::text$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('F13 manager cannot delete a user', 'authenticated', adm,
    $q$select public.ts_admin_delete_user('zz-verify-mgr@wizardtrees.com')::text$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('F14 manager cannot update ts_days directly', 'authenticated', adm,
    $q$update public.ts_days set note = 'x' where id = 'filifera:zz-verify-1:2001-01-01' returning id$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('F15 manager cannot grant self more via ts_grants', 'authenticated', adm,
    $q$insert into public.ts_grants (email, company, department) values ('gianni@wizardtrees.com', '*', '*') returning email$q$, 'ERROR 42501%');

  -- G. all-CA manager ('*','*'), a whole-company grant ('slane','*'), mixed grants, a NY grant.
  --    A '*' company means the CA companies only: the temporary NY company stays hidden.
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"*","department":"*"}]');
  perform pg_temp.ts_v('G1 (*,*) manager sees every CA ts_days row', 'authenticated', adm, 'select count(*) from public.ts_days',
    (select count(*)::text from public.ts_days t join public.ts_companies c on c.key = t.company where c.region = 'CA'));
  perform pg_temp.ts_v('G1b (*,*) manager sees no NY ts_days row', 'authenticated', adm,
    $q$select count(*) from public.ts_days where company = 'zz_verify_ny'$q$, '0');
  perform pg_temp.ts_v('G2 (*,*) manager sees every CA ts_people row', 'authenticated', adm, 'select count(*) from public.ts_people',
    (select count(*)::text from public.ts_people p join public.ts_companies c on c.key = p.company where c.region = 'CA'));
  perform pg_temp.ts_v('G2b (*,*) manager sees no NY ts_people row', 'authenticated', adm,
    $q$select count(*) from public.ts_people where company = 'zz_verify_ny'$q$, '0');
  perform pg_temp.ts_v('G3 (*,*) manager is still not an admin', 'authenticated', adm,
    $q$select public.ts_is_admin()::text || '/' || (public.ts_me()->>'is_admin')$q$, 'false/false');
  perform pg_temp.ts_v('G4 (*,*) manager cannot call ts_admin_list', 'authenticated', adm, 'select public.ts_admin_list()::text', 'ERROR 42501%');
  perform pg_temp.ts_v('G4b (*,*) manager: RLS rows = ts_can_view rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));
  perform pg_temp.ts_v('G4c (*,*) grant keys = one key per CA company', 'authenticated', adm,
    $q$select array_to_string(public.ts_my_grant_keys(), ',')$q$,
    (select replace(replace(string_agg(k, ',' order by k), '!', '!!'), '_', '!_')
       from (select key || '|*' as k from public.ts_companies where region = 'CA') s));
  perform pg_temp.ts_v('G4d reference rule: * matches CA, not NY', 'claims', adm,
    $q$select public.ts_can_view('imperial','Anything') || '/' || public.ts_can_view('zz_verify_ny','Cultivation')$q$, 'true/false');
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"slane","department":"*"}]');
  perform pg_temp.ts_v('G6 (slane,*) manager sees every slane day', 'authenticated', adm, 'select count(*) from public.ts_days',
    (select count(*)::text from public.ts_days where company = 'slane'));
  perform pg_temp.ts_v('G7 (slane,*) manager sees no other company', 'authenticated', adm,
    $q$select count(*) from public.ts_days where company <> 'slane'$q$, '0');
  perform pg_temp.ts_v('G8 (slane,*) manager: RLS rows = ts_can_view rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"*","department":"Cultivation"},{"company":"filifera","department":"Distro/Trim"}]');
  perform pg_temp.ts_v('G10 (*,dept) + (co,dept) manager sees exactly those CA days', 'authenticated', adm, 'select count(*) from public.ts_days',
    (select count(*)::text from public.ts_days t join public.ts_companies c on c.key = t.company
      where c.region = 'CA' and (t.department = 'Cultivation' or (t.company = 'filifera' and t.department = 'Distro/Trim'))));
  perform pg_temp.ts_v('G10b (*,Cultivation) does not reach NY Cultivation', 'authenticated', adm,
    $q$select count(*) from public.ts_days where company = 'zz_verify_ny'$q$, '0');
  perform pg_temp.ts_v('G11 mixed-grant manager: RLS rows = ts_can_view rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"zz_verify_ny","department":"*"}]');
  perform pg_temp.ts_v('G12 an explicit NY company grant sees exactly that company', 'authenticated', adm,
    $q$select count(*) filter (where company = 'zz_verify_ny') || '/' || count(*) from public.ts_days$q$,
    (select count(*)::text || '/' || count(*)::text from public.ts_days where company = 'zz_verify_ny'));
  perform pg_temp.ts_v('G13 NY-grant manager: RLS rows = ts_can_view rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));

  -- H. inactive user
  perform pg_temp.ts_v_gianni(false, false, '[{"company":"*","department":"*"}]');
  perform pg_temp.ts_v('H1 inactive sees no ts_days',      'authenticated', adm, 'select count(*) from public.ts_days',      '0');
  perform pg_temp.ts_v('H2 inactive sees no ts_people',    'authenticated', adm, 'select count(*) from public.ts_people',    '0');
  perform pg_temp.ts_v('H3 inactive sees no ts_companies', 'authenticated', adm, 'select count(*) from public.ts_companies', '0');
  perform pg_temp.ts_v('H4 inactive ts_me: inactive, no grants', 'authenticated', adm,
    $q$select (public.ts_me()->>'active') || '/' || jsonb_array_length(public.ts_me()->'grants')$q$, 'false/0');
  perform pg_temp.ts_v('H4b inactive: no grant keys', 'authenticated', adm,
    $q$select cardinality(public.ts_my_grant_keys())::text$q$, '0');
  perform pg_temp.ts_v('H4c inactive: RLS rows = ts_can_view rows', 'authenticated', adm, rls_rows, pg_temp.ts_v_as('claims', adm, ref_rows));
  perform pg_temp.ts_v_gianni(true, false, '[]');
  perform pg_temp.ts_v('H6 inactive admin is not an admin', 'authenticated', adm,
    $q$select public.ts_is_admin() || '/' || (public.ts_me()->>'is_admin') || '/' || (select count(*) from public.ts_days)$q$, 'false/false/0');
  perform pg_temp.ts_v_gianni(true, true, '[]');

  -- I. ts_sync (producer = automation@, password sign-in, gated on its email)
  perform pg_temp.ts_v('I1 sync: upserts 2, deletes 2 stale days, 2 people, 1 inactive, holds the 3 days of an active person with no shifts', 'authenticated', aut,
    $q$select (r->>'upserted') || '/' || (r->>'deleted') || '/' || (r->>'people') || '/' || (r->>'deactivated') || '/' || (r->>'held')
              || '/' || (r->'held_people')::text || '/' || (r->>'note')
         from (select public.ts_sync('zz_verify', '2001-02-01', '2001-02-28',
        '[{"id":"zz_verify:zz-A:2001-02-01","company":"zz_verify","employee_uuid":"zz-A","employee_name":"Test Person A","department":"Packing","work_date":"2001-02-01","worked_min":465,"paid_break_min":20,"unpaid_break_min":30,"note":"updated","label_src":"gusto","open":false,"shifts":[{"id":"s1","in":"2001-02-01T08:00:00-08:00","out":"2001-02-01T16:15:00-08:00","span_min":495,"worked_min":465,"hours_only":false,"breaks":[]}],"flags":[{"code":"type_unsure","sev":"info","msg":"Break type guessed from its length"}]},
          {"id":"zz_verify:zz-A:2001-02-04","employee_uuid":"zz-A","employee_name":"Test Person A","work_date":"2001-02-04","open":true}]',
        '[{"employee_uuid":"zz-A","name":"Test Person A","department":"Packing","job_title":"Packer"},{"employee_uuid":"zz-F","name":"Test Person F"}]',
        '{"active_uuids":["zz-A","zz-F"],"gusto_uuid":"zz-gusto","label_csv_at":"2001-02-05T08:00:00Z"}') r) s$q$,
    '2/2/2/1/3/["zz-F"]/kept 3 day rows of 1 active people %');
  perform pg_temp.ts_v('I2 kept: inactive person day, out-of-window day, held days', null, null,
    $q$select string_agg(id, ',' order by id) from public.ts_days where company = 'zz_verify' and employee_uuid in ('zz-A','zz-B','zz-F')$q$,
    'zz!_verify:zz-A:2001-02-01,zz!_verify:zz-A:2001-02-04,zz!_verify:zz-A:2001-03-15,zz!_verify:zz-B:2001-02-01,zz!_verify:zz-F:2001-02-10,zz!_verify:zz-F:2001-02-11,zz!_verify:zz-F:2001-02-12');
  perform pg_temp.ts_v('I3 upserted row carries the payload, defaults fill gaps', null, null,
    $q$select (select note || '/' || department || '/' || label_src || '/' || worked_min || '/' || jsonb_array_length(shifts) || '/' || (flags->0->>'code')
                 from public.ts_days where id = 'zz_verify:zz-A:2001-02-01') || ' ; ' ||
              (select department || '/' || label_src || '/' || "open" || '/' || jsonb_typeof(shifts) || '/' || jsonb_typeof(flags) || '/' || (synced_at is not null)
                 from public.ts_days where id = 'zz_verify:zz-A:2001-02-04')$q$,
    'updated/Packing/gusto/465/1/type!_unsure ; No department/none/true/array/array/true');
  perform pg_temp.ts_v('I4 ts_companies freshness updated', null, null,
    $q$select connected || '/' || day_rows || '/' || gusto_uuid || '/' || sync_from || '/' || sync_to || '/' || (label_csv_at = '2001-02-05T08:00:00Z') || '/' || (last_sync_at is not null)
         from public.ts_companies where key = 'zz_verify'$q$,
    'true/' || (select count(*) from public.ts_days where company = 'zz_verify')::text || '/zz-gusto/2001-02-01/2001-02-28/true/true');
  perform pg_temp.ts_v('I5 ts_people upserted for the company', null, null,
    $q$select name || '/' || department || '/' || job_title || '/' || active from public.ts_people where company = 'zz_verify' and employee_uuid = 'zz-A'$q$,
    'Test Person A/Packing/Packer/true');
  perform pg_temp.ts_v('I5b a person missing from the people list is set inactive, never deleted', null, null,
    $q$select string_agg(employee_uuid || '=' || active, ',' order by employee_uuid) from public.ts_people where company = 'zz_verify'$q$,
    'zz-A=true,zz-B=false,zz-F=true');
  perform pg_temp.ts_v('I6 empty payload deletes nothing (log-only), empty people list deactivates nobody', 'authenticated', aut,
    $q$select (r->>'deleted') || '/' || (r->>'deactivated') || '/' || coalesce(r->>'note', '') from (select public.ts_sync('zz_verify', '2001-02-01', '2001-02-28', '[]', '[]', '{"active_uuids":["zz-A","zz-F"],"allow_mass_delete":true}') r) s$q$,
    '0/0/empty payload, nothing deleted');
  perform pg_temp.ts_v('I7 rows and people unchanged after the empty payload', null, null,
    $q$select (select count(*) from public.ts_days where company = 'zz_verify' and work_date between '2001-02-01' and '2001-02-28') || '/' ||
              (select string_agg(employee_uuid || '=' || active, ',' order by employee_uuid) from public.ts_people where company = 'zz_verify')$q$,
    '6/zz-A=true,zz-B=false,zz-F=true');
  perform pg_temp.ts_v('I8 sync refuses another company''s row', 'authenticated', aut,
    $q$select public.ts_sync('zz_verify', '2001-02-01', '2001-02-28',
        '[{"id":"filifera:zz-A:2001-02-01","company":"filifera","employee_uuid":"zz-A","employee_name":"Test Person A","work_date":"2001-02-01"}]', '[]', '{"active_uuids":["zz-A"]}')::text$q$,
    'ERROR %Bad day row%');
  perform pg_temp.ts_v('I9 sync refuses an unknown company', 'authenticated', aut,
    $q$select public.ts_sync('acme', '2001-02-01', '2001-02-28', '[]', '[]', '{}')::text$q$, 'ERROR %Unknown company%');
  perform set_config('request.headers', '{"x-ts-sync-key":"wrong-key"}', true);
  perform pg_temp.ts_v('I9b sync refuses a wrong sync key (password alone is not enough)', 'authenticated', aut,
    $q$select public.ts_sync('zz_verify', '2001-02-01', '2001-02-28', '[]', '[]', '{}')::text$q$, 'ERROR 42501: ts_sync needs the sync key');
  perform set_config('request.headers', '', true);
  perform pg_temp.ts_v('I9c sync refuses a missing sync key', 'authenticated', aut,
    $q$select public.ts_sync('zz_verify', '2001-02-01', '2001-02-28', '[]', '[]', '{}')::text$q$, 'ERROR 42501: ts_sync needs the sync key');
  update public.ts_sync_keys set revoked_at = now() where label = 'verify (rolled back)';
  perform set_config('request.headers', '{"x-ts-sync-key":"zz-verify-sync-key"}', true);
  perform pg_temp.ts_v('I9d sync refuses a revoked sync key', 'authenticated', aut,
    $q$select public.ts_sync('zz_verify', '2001-02-01', '2001-02-28', '[]', '[]', '{}')::text$q$, 'ERROR 42501: ts_sync needs the sync key');
  update public.ts_sync_keys set revoked_at = null where label = 'verify (rolled back)';
  perform pg_temp.ts_v('I9e anon cannot read the sync key table', 'anon', null,
    $q$select count(*) from public.ts_sync_keys$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('I9f a signed-in admin cannot read the sync key table', 'authenticated', adm,
    $q$select count(*) from public.ts_sync_keys$q$, 'ERROR 42501%');
  -- department freeze: a finished day keeps its department, today's day follows Gusto
  insert into public.ts_days (id, company, employee_uuid, employee_name, department, work_date)
  values ('zz_verify:zz-K:2003-01-05', 'zz_verify', 'zz-K', 'Test Person K', 'Trim', '2003-01-05');
  perform pg_temp.ts_v('I9g first sync of today''s day and a finished day', 'authenticated', aut,
    format($q$select public.ts_sync('zz_verify', '2003-01-01', %L::date,
        jsonb_build_array(
          '{"id":"zz_verify:zz-K:2003-01-05","employee_uuid":"zz-K","employee_name":"Test Person K","department":"Packing","work_date":"2003-01-05"}'::jsonb,
          jsonb_build_object('id', 'zz_verify:zz-K:' || %L, 'employee_uuid', 'zz-K', 'employee_name', 'Test Person K', 'department', 'Packing', 'work_date', %L)),
        '[]', '{"active_uuids":[]}')->>'upserted'$q$,
      (now() at time zone 'America/Los_Angeles')::date, (now() at time zone 'America/Los_Angeles')::date, (now() at time zone 'America/Los_Angeles')::date),
    '2');
  perform pg_temp.ts_v('I9h a department change moves today but not a finished day', 'authenticated', aut,
    format($q$select public.ts_sync('zz_verify', '2003-01-01', %L::date,
        jsonb_build_array(jsonb_build_object('id', 'zz_verify:zz-K:' || %L, 'employee_uuid', 'zz-K', 'employee_name', 'Test Person K', 'department', 'Trim', 'work_date', %L)),
        '[]', '{"active_uuids":[]}')->>'upserted'$q$,
      (now() at time zone 'America/Los_Angeles')::date, (now() at time zone 'America/Los_Angeles')::date, (now() at time zone 'America/Los_Angeles')::date),
    '1');
  perform pg_temp.ts_v('I9i finished day kept Trim, today follows Gusto', null, null,
    $q$select string_agg(department, ',' order by work_date) from public.ts_days where employee_uuid = 'zz-K'$q$, 'Trim,Trim');
  delete from public.ts_days where employee_uuid = 'zz-K' and company = 'zz_verify';
  perform pg_temp.ts_v('I10 sync refuses a backwards window', 'authenticated', aut,
    $q$select public.ts_sync('zz_verify', '2001-02-28', '2001-02-01', '[]', '[]', '{}')::text$q$, 'ERROR %Bad sync window%');
  -- allow_mass_delete releases held rows
  payload := (select jsonb_agg(to_jsonb(t)) from public.ts_days t
               where t.company = 'zz_verify' and t.employee_uuid = 'zz-A' and t.work_date between '2001-02-01' and '2001-02-28');
  perform pg_temp.ts_v('I10b allow_mass_delete releases the held days', 'authenticated', aut,
    format($q$select (r->>'deleted') || '/' || (r->>'held') from (select public.ts_sync('zz_verify', '2001-02-01', '2001-02-28', %L::jsonb, '[]',
             '{"active_uuids":["zz-A","zz-F"],"allow_mass_delete":true}') r) s$q$, payload),
    '3/0');
  perform pg_temp.ts_v('I10c held days are gone after the override, the rest stays', null, null,
    $q$select string_agg(id, ',' order by id) from public.ts_days where company = 'zz_verify' and work_date between '2001-02-01' and '2001-02-28'$q$,
    'zz!_verify:zz-A:2001-02-01,zz!_verify:zz-A:2001-02-04,zz!_verify:zz-B:2001-02-01');

  -- breaker: 40 zz-C days in window, payload keeps 1 => would delete 39 (> 25 and > 30%)
  payload := (select jsonb_agg(to_jsonb(t)) from public.ts_days t where t.id = 'zz_verify:zz-C:2001-04-01');
  perform pg_temp.ts_v('I11 breaker trips on a mass delete', 'authenticated', aut,
    format($q$select public.ts_sync('zz_verify', '2001-04-01', '2001-05-31', %L::jsonb, '[]', '{"active_uuids":["zz-C"]}')::text$q$, payload),
    'ERROR %breaker%');
  perform pg_temp.ts_v('I12 tripped breaker deleted nothing', null, null,
    $q$select count(*) from public.ts_days where employee_uuid = 'zz-C'$q$, '40');
  perform pg_temp.ts_v('I13 allow_mass_delete overrides the breaker', 'authenticated', aut,
    format($q$select public.ts_sync('zz_verify', '2001-04-01', '2001-05-31', %L::jsonb, '[]', '{"active_uuids":["zz-C"],"allow_mass_delete":true}')->>'deleted'$q$, payload),
    '39');
  -- 40 zz-D days, payload keeps 15 => delete 25 (not over 25): allowed
  payload := (select jsonb_agg(to_jsonb(t)) from public.ts_days t where t.employee_uuid = 'zz-D' and t.work_date < '2001-06-16');
  perform pg_temp.ts_v('I14 delete of exactly 25 passes the breaker', 'authenticated', aut,
    format($q$select public.ts_sync('zz_verify', '2001-06-01', '2001-07-31', %L::jsonb, '[]', '{"active_uuids":["zz-D"]}')->>'deleted'$q$, payload),
    '25');
  -- 100 zz-E days, payload keeps 74 => delete 26 (over 25 but 26% of the window): allowed
  payload := (select jsonb_agg(to_jsonb(t)) from public.ts_days t where t.employee_uuid = 'zz-E' and t.work_date < date '2001-08-01' + 74);
  perform pg_temp.ts_v('I15 delete of 26 that is under 30% passes the breaker', 'authenticated', aut,
    format($q$select public.ts_sync('zz_verify', '2001-08-01', '2001-12-31', %L::jsonb, '[]', '{"active_uuids":["zz-E"]}')->>'deleted'$q$, payload),
    '26');
  perform pg_temp.ts_v('I16 rows of people not in active_uuids are never deleted', 'authenticated', aut,
    $q$select public.ts_sync('zz_verify', '2001-01-01', '2001-12-31',
        '[{"id":"zz_verify:zz-A:2001-02-01","employee_uuid":"zz-A","employee_name":"Test Person A","work_date":"2001-02-01"}]', '[]', '{"active_uuids":[]}')->>'deleted'$q$, '0');
  perform pg_temp.ts_v('I17 sync never touched other companies', null, null,
    $q$select count(*) from public.ts_days where id like '%:zz-verify-_:2001-01-0_'$q$, '5');
  -- 40 active zz-G days + 100 days of zz-H (not active) in the window, payload keeps 1 zz-G day =>
  -- 39 of 40 active rows: trips, although it is only 28% of all 140 rows
  payload := (select jsonb_agg(to_jsonb(t)) from public.ts_days t where t.id = 'zz_verify:zz-G:2002-01-01');
  perform pg_temp.ts_v('I18 inactive people''s rows do not dilute the breaker', 'authenticated', aut,
    format($q$select public.ts_sync('zz_verify', '2002-01-01', '2002-06-30', %L::jsonb, '[]', '{"active_uuids":["zz-G"]}')::text$q$, payload),
    'ERROR %would delete 39 of 40 %');
  perform pg_temp.ts_v('I19 that tripped breaker changed nothing', null, null,
    $q$select (select count(*) from public.ts_days where employee_uuid = 'zz-G') || '/' || (select count(*) from public.ts_days where employee_uuid = 'zz-H')$q$,
    '40/100');

  -- J. clean-up path through the RPC
  perform pg_temp.ts_v('J1 admin deletes the manager', 'authenticated', adm,
    format('select public.ts_admin_delete_user(%L)->>$$deleted$$', mgr), '1');
  perform pg_temp.ts_v('J2 its grants went with it', null, null,
    format('select count(*) from public.ts_grants where email = %L', mgr), '0');
  perform pg_temp.ts_v('J3 the admin list no longer has it', 'authenticated', adm,
    format('select count(*) from jsonb_array_elements(public.ts_admin_list()) e where e->>$$email$$ = %L', mgr), '0');
  perform pg_temp.ts_v('J4 producer works without a ts_access row', 'authenticated', aut,
    $q$select public.ts_sync('zz_verify', '2001-02-01', '2001-02-28', '[]', '[]', '{}')->>'ok'$q$, 'true');
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
