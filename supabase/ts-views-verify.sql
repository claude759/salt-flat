-- RLS + RPC verification for supabase/ts-views.sql (Manager Gusto Timesheets saved views).
--
-- One transaction that ROLLS BACK, in the same harness as supabase/ts-ca-timesheets-verify.sql:
-- it saves throwaway views (ids 'zz-verify-...', members with synthetic uuids 'zz-verify-1' and
-- department titles only), plays each identity, records what each one can see or do, returns
-- one pass/fail table, and undoes everything. Run it with write access as the project owner (SQL
-- editor or the management API without read_only) after ts-ca-timesheets.sql and ts-views.sql;
-- the API shows the last result set, which is the pass/fail table. Every row must say pass = true.
--
-- Identities (real auth.users rows are needed only for gianni@ and automation@, looked up by
-- email; each session carries a JWT amr 'oauth' unless a check says otherwise, and automation@
-- always signs in with a password):
--   anon                  role anon, no JWT
--   stranger              role authenticated, a random sub with no auth.users and no ts_access row
--   automation@           the sync account (password): passes is_staff(), never holds a view
--   no-access Google user gianni@ (Google) with his ts_access row removed: any Google sign-in
--                         that is not on the allowlist, a BA for example
--   manager               gianni@ (Google) set to an active NON-admin row, first with an all-CA
--                         grant ('*','*'), then a one-department grant
--   inactive admin        gianni@ with is_admin but active = false
--   password session      gianni@ as admin but signed in by password (as after a BA-app reset)
--   admin                 gianni@ (Google), forced to an active admin row
--   owner                 the script itself (the seed path: a direct insert as the owner)
-- The non-admin states are set on gianni's own row as the owner (rolled back), as in the
-- round-1 verify. Expected counts are computed as the owner (no RLS), so real views already in
-- the table (the seed) do not break the checks.

begin;

create temp table ts_v_results (
  seq serial primary key,
  test text not null,
  expected text not null,      -- a LIKE pattern (escape '!'); plain text means equal
  got text
) on commit drop;

-- Run p_sql as an identity and return its single value as text, or 'ERROR <sqlstate>: <message>'.
-- p_role null = as the script owner; 'anon' = no JWT; 'authenticated' + p_email = that confirmed
-- auth.users row; 'authenticated' + null email = a signed-in sub with no auth.users row.
-- p_amr = the JWT's sign-in method: null = 'password' for automation@, else 'oauth'; 'none' = no amr.
create function pg_temp.ts_v_as(p_role text, p_email text, p_sql text, p_amr text default null) returns text
language plpgsql as $f$
declare v_me text := current_user; v_sub text; v_claims text := ''; v_out text; v_amr text;
begin
  if p_role = 'authenticated' then
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
      perform set_config('role', p_role, true);
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
-- one view that exists before anyone plays: the non-admin identities must not see it
insert into public.ts_views (id, label, sort, members, updated_by)
values ('zz-verify-seed', 'Verify Seed', 99, '[{"company":"filifera","department":"Distro/Trim"}]', 'verify');

-- ------------------------------------------------------------------ checks
do $v$
declare
  adm  constant text := 'gianni@wizardtrees.com';
  aut  constant text := 'automation@wizardtrees.com';
  vcount   constant text := 'select count(*) from public.ts_views';
  save_any constant text := $q$select public.ts_admin_save_view('zz-verify-x', 'Verify X', 0, '[{"company":"filifera","department":"Distro/Trim"}]')::text$q$;
  del_seed constant text := $q$select public.ts_admin_delete_view('zz-verify-seed')::text$q$;
  ins_any  constant text := $q$insert into public.ts_views (id, label) values ('zz-verify-direct', 'Direct') returning id$q$;
  upd_seed constant text := $q$update public.ts_views set label = 'Changed' where id = 'zz-verify-seed' returning id$q$;
  del_any  constant text := $q$delete from public.ts_views where id = 'zz-verify-seed' returning id$q$;
  -- save(id, label, sort, members) as the admin, returning 'id/label/sort/members/updated_by'
  row_txt  constant text := $q$select (r->>'id') || '/' || (r->>'label') || '/' || (r->>'sort') || '/' || (r->'members')::text || '/' || coalesce(r->>'updated_by', '(null)') from (select public.ts_admin_save_view(%L, %L, %s, %L::jsonb) r) s$q$;
  admin_only constant text := 'ERROR 42501: Only timesheet admins can do this';
  long41 constant text := 'a' || repeat('b', 40);
  long40 constant text := 'a' || repeat('b', 39);
begin
  -- A. catalog
  perform pg_temp.ts_v('A1 RLS is on for ts_views', null, null,
    $q$select relrowsecurity::text from pg_class where oid = 'public.ts_views'::regclass$q$, 'true');
  perform pg_temp.ts_v('A2 ts_views has exactly one policy: SELECT to authenticated', null, null,
    $q$select count(*) || '/' || string_agg(cmd || ':' || array_to_string(roles, ','), ',') from pg_policies
        where schemaname = 'public' and tablename = 'ts_views'$q$, '1/SELECT:authenticated');
  perform pg_temp.ts_v('A3 the ts_views policy is the admin check', null, null,
    $q$select qual from pg_policies where schemaname = 'public' and tablename = 'ts_views'$q$, '%ts!_is!_admin()%');
  perform pg_temp.ts_v('A4 anon holds no privilege on ts_views', null, null,
    $q$select count(*) from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
        where has_table_privilege('anon', 'public.ts_views', p)$q$, '0');
  perform pg_temp.ts_v('A5 authenticated holds SELECT and nothing else on ts_views', null, null,
    $q$select count(*) filter (where p = 'SELECT') || '/' || count(*)
         from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
        where has_table_privilege('authenticated', 'public.ts_views', p)$q$, '1/1');
  perform pg_temp.ts_v('A6 PUBLIC and anon can execute none of the view functions', null, null,
    $q$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('ts_admin_save_view','ts_admin_delete_view','ts_views_clean')
          and (has_function_privilege('public', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE'))$q$, '0');
  perform pg_temp.ts_v('A7 authenticated can execute the two RPCs, not the trigger function', null, null,
    $q$select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('ts_admin_save_view','ts_admin_delete_view','ts_views_clean')
          and has_function_privilege('authenticated', p.oid, 'EXECUTE')$q$,
    pg_temp.ts_v_lit('ts_admin_delete_view,ts_admin_save_view'));
  perform pg_temp.ts_v('A8 the three view functions are security definer with search_path=public', null, null,
    $q$select count(*) filter (where p.prosecdef and coalesce(array_to_string(p.proconfig, ',') like '%search_path=public%', false))
              || '/' || count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('ts_admin_save_view','ts_admin_delete_view','ts_views_clean')$q$, '3/3');
  perform pg_temp.ts_v('A9 the clean-up trigger is on for inserts and updates', null, null,
    $q$select count(*) from pg_trigger t
        where t.tgrelid = 'public.ts_views'::regclass and t.tgname = 'ts_views_clean' and not t.tgisinternal
          and t.tgenabled = 'O' and t.tgfoid = 'public.ts_views_clean()'::regprocedure
          and (t.tgtype & 2) <> 0 and (t.tgtype & 4) <> 0 and (t.tgtype & 16) <> 0 and (t.tgtype & 1) <> 0$q$, '1');
  perform pg_temp.ts_v('A10 the round-1 ts tables still have exactly 5 SELECT policies', null, null,
    $q$select count(*) filter (where cmd = 'SELECT') || '/' || count(*) from pg_policies
        where schemaname = 'public' and tablename in ('ts_companies','ts_people','ts_days','ts_access','ts_grants')$q$, '5/5');
  perform pg_temp.ts_v('A11 authenticated can execute exactly the round-1 ts_ functions plus the two view RPCs', null, null,
    $q$select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'ts\_%' and has_function_privilege('authenticated', p.oid, 'EXECUTE')$q$,
    pg_temp.ts_v_lit('ts_admin_delete_user,ts_admin_delete_view,ts_admin_list,ts_admin_save_user,ts_admin_save_view,ts_is_admin,ts_me,ts_my_email,ts_my_grant_keys,ts_sync'));

  -- B. anon: no table, no function
  perform pg_temp.ts_v('B1 anon cannot read ts_views',              'anon', null, vcount,   'ERROR 42501%');
  perform pg_temp.ts_v('B2 anon cannot call ts_admin_save_view',    'anon', null, save_any, 'ERROR 42501%');
  perform pg_temp.ts_v('B3 anon cannot call ts_admin_delete_view',  'anon', null, del_seed, 'ERROR 42501%');
  perform pg_temp.ts_v('B4 anon cannot insert into ts_views',       'anon', null, ins_any,  'ERROR 42501%');

  -- C. signed-in stranger (no auth.users row, no ts_access row)
  perform pg_temp.ts_v('C1 stranger sees no view',                  'authenticated', null, vcount,   '0');
  perform pg_temp.ts_v('C2 stranger cannot save a view',            'authenticated', null, save_any, admin_only);
  perform pg_temp.ts_v('C3 stranger cannot delete a view',          'authenticated', null, del_seed, admin_only);

  -- D. automation@ (password sign-in, passes is_staff, no ts_access row)
  perform pg_temp.ts_v('D1 automation@ sees no view',               'authenticated', aut, vcount,   '0');
  perform pg_temp.ts_v('D2 automation@ cannot save a view',         'authenticated', aut, save_any, admin_only);
  perform pg_temp.ts_v('D3 automation@ cannot delete a view',       'authenticated', aut, del_seed, admin_only);
  perform pg_temp.ts_v('D4 automation@ cannot insert into ts_views','authenticated', aut, ins_any,  'ERROR 42501%');

  -- N. a Google sign-in that is not on the allowlist (any BA)
  delete from public.ts_access where email = adm;   -- restored right below (and rolled back)
  perform pg_temp.ts_v('N0 (setup) the Google user has no timesheet access', 'authenticated', adm,
    $q$select (public.ts_me()->>'email') || '/' || (public.ts_me()->>'active')$q$, pg_temp.ts_v_lit(adm) || '/false');
  perform pg_temp.ts_v('N1 no-access Google user sees no view',       'authenticated', adm, vcount,   '0');
  perform pg_temp.ts_v('N2 no-access Google user cannot save a view', 'authenticated', adm, save_any, admin_only);
  perform pg_temp.ts_v('N3 no-access Google user cannot delete a view','authenticated', adm, del_seed, admin_only);

  -- M. allowlisted manager, not an admin: first the broadest grant, then one department
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"*","department":"*"}]');
  perform pg_temp.ts_v('M0 (setup) the manager is active, not admin, and can read timesheet rows', 'authenticated', adm,
    $q$select (public.ts_me()->>'active') || '/' || (public.ts_me()->>'is_admin') || '/' || cardinality(public.ts_my_grant_keys())::text$q$,
    'true/false/' || (select count(*)::text from public.ts_companies where region = 'CA'));
  perform pg_temp.ts_v('M1 all-CA manager sees no view',             'authenticated', adm, vcount,   '0');
  perform pg_temp.ts_v('M2 all-CA manager cannot save a view',       'authenticated', adm, save_any, admin_only);
  perform pg_temp.ts_v('M3 all-CA manager cannot delete a view',     'authenticated', adm, del_seed, admin_only);
  perform pg_temp.ts_v('M4 all-CA manager cannot insert into ts_views', 'authenticated', adm, ins_any,  'ERROR 42501%');
  perform pg_temp.ts_v('M5 all-CA manager cannot update ts_views',   'authenticated', adm, upd_seed, 'ERROR 42501%');
  perform pg_temp.ts_v('M6 all-CA manager cannot delete from ts_views', 'authenticated', adm, del_any, 'ERROR 42501%');
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"filifera","department":"Distro/Trim"}]');
  perform pg_temp.ts_v('M7 one-department manager sees no view, even one that is exactly their department', 'authenticated', adm, vcount, '0');
  perform pg_temp.ts_v('M8 one-department manager cannot save a view', 'authenticated', adm, save_any, admin_only);

  -- H. inactive admin; P. the admin in a session that was not a Google sign-in
  perform pg_temp.ts_v_gianni(true, false, '[]');
  perform pg_temp.ts_v('H1 inactive admin sees no view',             'authenticated', adm, vcount,   '0');
  perform pg_temp.ts_v('H2 inactive admin cannot save a view',       'authenticated', adm, save_any, admin_only);
  perform pg_temp.ts_v_gianni(true, true, '[]');
  perform pg_temp.ts_v('P1 admin in a password session sees no view',     'authenticated', adm, vcount,   '0', 'password');
  perform pg_temp.ts_v('P2 admin in a password session cannot save a view','authenticated', adm, save_any, admin_only, 'password');
  perform pg_temp.ts_v('P3 admin in a password session cannot delete a view','authenticated', adm, del_seed, admin_only, 'password');

  -- E. admin (gianni@, Google sign-in): save, list, re-save, delete
  perform pg_temp.ts_v('E1 admin sees every view', 'authenticated', adm, vcount, (select count(*)::text from public.ts_views));
  perform pg_temp.ts_v('E2 admin saves a new view: id lowercased, label tidied, members cleaned + deduped, updated_by = admin', 'authenticated', adm,
    format(row_txt, ' ZZ-Verify-A ', '  Verify   Crew A ', 5,
      '[{"company":" Filifera ","employee_uuid":" zz-verify-1 ","name":"dropped"},
        {"company":"filifera","department":"Distro/Trim"},
        {"company":"FILIFERA","employee_uuid":"zz-verify-1"},
        {"company":"slane","department":" Distro/Trim ","employee_uuid":""},
        {"company":"filifera","department":"Distro/Trim","employee_uuid":null}]'),
    pg_temp.ts_v_lit('zz-verify-a/Verify Crew A/5/'
      || '[{"company":"filifera","employee_uuid":"zz-verify-1"},{"company":"filifera","department":"Distro/Trim"},{"company":"slane","department":"Distro/Trim"}]'::jsonb::text
      || '/' || adm));
  perform pg_temp.ts_v('E3 stored row matches (3 members, updated_at set)', null, null,
    $q$select jsonb_array_length(members) || '/' || (updated_at is not null) || '/' || updated_by from public.ts_views where id = 'zz-verify-a'$q$,
    pg_temp.ts_v_lit('3/true/' || adm));
  perform pg_temp.ts_v('E4 admin saves a second view with sort 1', 'authenticated', adm,
    format(row_txt, 'zz-verify-b', 'Verify Crew B', 1, '[{"company":"wafgus","department":"Packing"}]'),
    pg_temp.ts_v_lit('zz-verify-b/Verify Crew B/1/' || '[{"company":"wafgus","department":"Packing"}]'::jsonb::text || '/' || adm));
  perform pg_temp.ts_v('E5 admin lists views ordered by sort, label', 'authenticated', adm,
    $q$select string_agg(id, ',' order by sort, label) from public.ts_views where id like 'zz-verify-%'$q$,
    'zz-verify-b,zz-verify-a,zz-verify-seed');
  perform pg_temp.ts_v('E6 re-saving an id replaces label, sort and members (no duplicate row)', 'authenticated', adm,
    format(row_txt, 'zz-verify-a', 'Verify Crew A2', 3, '[{"company":"imperial","employee_uuid":"zz-verify-2"}]'),
    pg_temp.ts_v_lit('zz-verify-a/Verify Crew A2/3/' || '[{"company":"imperial","employee_uuid":"zz-verify-2"}]'::jsonb::text || '/' || adm));
  perform pg_temp.ts_v('E7 still one row for that id', null, null,
    $q$select count(*) from public.ts_views where id = 'zz-verify-a'$q$, '1');
  perform pg_temp.ts_v('E8 an empty member list is allowed; null sort and members become 0 and []', 'authenticated', adm,
    format(row_txt, 'zz-verify-c', 'Verify Empty', 'null', null), pg_temp.ts_v_lit('zz-verify-c/Verify Empty/0/[]/' || adm));
  perform pg_temp.ts_v('E9 a 40-character id and a 60-character label are accepted', 'authenticated', adm,
    format($q$select length(r->>'id') || '/' || length(r->>'label') from (select public.ts_admin_save_view(%L, %L, 0, '[]') r) s$q$,
           long40, repeat('L', 60)), '40/60');
  perform pg_temp.ts_v('E10 admin cannot insert into ts_views directly', 'authenticated', adm, ins_any,  'ERROR 42501%');
  perform pg_temp.ts_v('E11 admin cannot update ts_views directly',      'authenticated', adm, upd_seed, 'ERROR 42501%');
  perform pg_temp.ts_v('E12 admin cannot delete from ts_views directly', 'authenticated', adm, del_any,  'ERROR 42501%');
  perform pg_temp.ts_v('E13 admin cannot call the trigger function',     'authenticated', adm,
    'select public.ts_views_clean()::text', 'ERROR 42501%');
  perform pg_temp.ts_v('E14 admin deletes a view (id normalised): ok, deleted 1', 'authenticated', adm,
    $q$select (r->>'ok') || '/' || (r->>'deleted') from (select public.ts_admin_delete_view(' ZZ-Verify-B ') r) s$q$, 'true/1');
  perform pg_temp.ts_v('E15 deleting it again: ok, deleted 0', 'authenticated', adm,
    $q$select (r->>'ok') || '/' || (r->>'deleted') from (select public.ts_admin_delete_view('zz-verify-b') r) s$q$, 'true/0');
  perform pg_temp.ts_v('E16 the deleted view is gone, the others stay', null, null,
    $q$select string_agg(id, ',' order by id) from public.ts_views where id in ('zz-verify-a','zz-verify-b','zz-verify-c','zz-verify-seed')$q$,
    'zz-verify-a,zz-verify-c,zz-verify-seed');
  perform pg_temp.ts_v('E17 delete of a null id is a no-op', 'authenticated', adm,
    $q$select public.ts_admin_delete_view(null)->>'deleted'$q$, '0');

  -- V. validation (as the admin); every refused save writes nothing
  perform pg_temp.ts_v('V1 refuses a blank id', 'authenticated', adm,
    format(row_txt, '  ', 'Verify V', 0, '[]'), 'ERROR %View id must be%');
  perform pg_temp.ts_v('V2 refuses a null id', 'authenticated', adm,
    $q$select public.ts_admin_save_view(null, 'Verify V', 0, '[]')::text$q$, 'ERROR %View id must be%');
  perform pg_temp.ts_v('V3 refuses an id with a space or punctuation', 'authenticated', adm,
    format(row_txt, 'zz-verify bad!', 'Verify V', 0, '[]'), 'ERROR %View id must be%');
  perform pg_temp.ts_v('V4 refuses an id that starts with a hyphen', 'authenticated', adm,
    format(row_txt, '-zz-verify-v', 'Verify V', 0, '[]'), 'ERROR %View id must be%');
  perform pg_temp.ts_v('V5 refuses a 41-character id', 'authenticated', adm,
    format(row_txt, long41, 'Verify V', 0, '[]'), 'ERROR %View id must be%');
  perform pg_temp.ts_v('V6 refuses a non-ASCII id', 'authenticated', adm,
    format(row_txt, 'zz-verify-ñ', 'Verify V', 0, '[]'), 'ERROR %View id must be%');
  perform pg_temp.ts_v('V7 refuses a blank label', 'authenticated', adm,
    format(row_txt, 'zz-verify-v', '   ', 0, '[]'), 'ERROR %View name must be 1 to 60 characters%');
  perform pg_temp.ts_v('V8 refuses a null label', 'authenticated', adm,
    $q$select public.ts_admin_save_view('zz-verify-v', null, 0, '[]')::text$q$, 'ERROR %View name must be 1 to 60 characters%');
  perform pg_temp.ts_v('V9 refuses a 61-character label', 'authenticated', adm,
    format(row_txt, 'zz-verify-v', repeat('L', 61), 0, '[]'), 'ERROR %View name must be 1 to 60 characters%');
  perform pg_temp.ts_v('V10 refuses members that are not a list', 'authenticated', adm,
    format(row_txt, 'zz-verify-v', 'Verify V', 0, '{"company":"filifera","department":"Trim"}'), 'ERROR %members must be a list%');
  perform pg_temp.ts_v('V11 refuses a member that is not an object', 'authenticated', adm,
    format(row_txt, 'zz-verify-v', 'Verify V', 0, '["filifera"]'), 'ERROR %View member 1: must be%');
  perform pg_temp.ts_v('V12 refuses an unknown company', 'authenticated', adm,
    format(row_txt, 'zz-verify-v', 'Verify V', 0, '[{"company":"acme","department":"Trim"}]'), 'ERROR %View member 1: unknown company "acme"%');
  perform pg_temp.ts_v('V13 refuses the * company (a view is per company)', 'authenticated', adm,
    format(row_txt, 'zz-verify-v', 'Verify V', 0, '[{"company":"*","department":"Trim"}]'), 'ERROR %unknown company%');
  perform pg_temp.ts_v('V14 refuses a member with no company', 'authenticated', adm,
    format(row_txt, 'zz-verify-v', 'Verify V', 0, '[{"department":"Trim"}]'), 'ERROR %View member 1: needs a company%');
  perform pg_temp.ts_v('V15 refuses a member with a blank company', 'authenticated', adm,
    format(row_txt, 'zz-verify-v', 'Verify V', 0, '[{"company":"  ","employee_uuid":"zz-verify-1"}]'), 'ERROR %needs a company%');
  perform pg_temp.ts_v('V16 refuses a member with both a person and a department', 'authenticated', adm,
    format(row_txt, 'zz-verify-v', 'Verify V', 0, '[{"company":"filifera","employee_uuid":"zz-verify-1","department":"Trim"}]'), 'ERROR %not both%');
  perform pg_temp.ts_v('V17 refuses a member with neither a person nor a department', 'authenticated', adm,
    format(row_txt, 'zz-verify-v', 'Verify V', 0, '[{"company":"filifera"}]'), 'ERROR %give a person (employee!_uuid) or a department%');
  perform pg_temp.ts_v('V18 refuses a member whose person and department are blank', 'authenticated', adm,
    format(row_txt, 'zz-verify-v', 'Verify V', 0, '[{"company":"filifera","employee_uuid":"  ","department":""}]'), 'ERROR %give a person%');
  perform pg_temp.ts_v('V19 refuses a non-text employee_uuid', 'authenticated', adm,
    format(row_txt, 'zz-verify-v', 'Verify V', 0, '[{"company":"filifera","employee_uuid":123}]'), 'ERROR %must be text%');
  perform pg_temp.ts_v('V20 refuses a non-text company', 'authenticated', adm,
    format(row_txt, 'zz-verify-v', 'Verify V', 0, '[{"company":7,"department":"Trim"}]'), 'ERROR %needs a company%');
  perform pg_temp.ts_v('V21 names the bad member when an earlier one is fine', 'authenticated', adm,
    format(row_txt, 'zz-verify-v', 'Verify V', 0, '[{"company":"filifera","department":"Trim"},{"company":"slane"}]'), 'ERROR %View member 2:%');
  perform pg_temp.ts_v('V22 refused saves wrote nothing', null, null,
    format($q$select count(*) from public.ts_views where id like '%%verify-v%%' or id like '%%verify bad%%' or id in (%L, 'zz-verify-ñ')$q$, long41), '0');
  perform pg_temp.ts_v('V23 a refused re-save leaves the existing view unchanged', 'authenticated', adm,
    format(row_txt, 'zz-verify-a', 'Verify Crew A3', 0, '[{"company":"filifera","employee_uuid":"zz-verify-1","department":"Trim"}]'), 'ERROR %not both%');
  perform pg_temp.ts_v('V24 ... still the earlier label and members', null, null,
    $q$select label || '/' || members::text from public.ts_views where id = 'zz-verify-a'$q$,
    pg_temp.ts_v_lit('Verify Crew A2/' || '[{"company":"imperial","employee_uuid":"zz-verify-2"}]'::jsonb::text));
  perform pg_temp.ts_v('V25 accepts a view with exactly 500 members', 'authenticated', adm,
    $q$select jsonb_array_length(public.ts_admin_save_view('zz-verify-cap', 'Verify Cap', 0,
         (select jsonb_agg(jsonb_build_object('company', 'filifera', 'department', 'zz-verify-d' || g)) from generate_series(1, 500) g)) -> 'members')::text$q$,
    '500');
  perform pg_temp.ts_v('V26 refuses a view with 501 members', 'authenticated', adm,
    $q$select public.ts_admin_save_view('zz-verify-cap', 'Verify Cap', 0,
         (select jsonb_agg(jsonb_build_object('company', 'filifera', 'department', 'zz-verify-d' || g)) from generate_series(1, 501) g))::text$q$,
    'ERROR %View can hold at most 500 members%');
  perform pg_temp.ts_v('V27 ... the refused 501 left the 500-member view as it was', null, null,
    $q$select jsonb_array_length(members)::text from public.ts_views where id = 'zz-verify-cap'$q$, '500');
  perform pg_temp.ts_v('V28 refuses an employee_uuid over 100 characters', 'authenticated', adm,
    format(row_txt, 'zz-verify-v', 'Verify V', 0, jsonb_build_array(jsonb_build_object('company', 'filifera', 'employee_uuid', repeat('u', 101)))),
    'ERROR %View member 1: employee!_uuid is over 100 characters%');
  perform pg_temp.ts_v('V29 refuses a department over 100 characters (named as member 2)', 'authenticated', adm,
    format(row_txt, 'zz-verify-v', 'Verify V', 0, jsonb_build_array(jsonb_build_object('company', 'filifera', 'department', 'Trim'),
                                                                     jsonb_build_object('company', 'slane', 'department', repeat('d', 101)))),
    'ERROR %View member 2: department is over 100 characters%');
  perform pg_temp.ts_v('V30 a 100-character department is accepted (measured after trimming)', 'authenticated', adm,
    format($q$select length(r->'members'->0->>'department')::text from (select public.ts_admin_save_view('zz-verify-len', 'Verify Len', 0, %L::jsonb) r) s$q$,
           jsonb_build_array(jsonb_build_object('company', 'filifera', 'department', '  ' || repeat('d', 100) || '  '))),
    '100');

  -- O. the owner's direct insert (how a seed lands) gets the same checks and clean-up
  perform pg_temp.ts_v('O1 owner insert is cleaned like a save', null, null,
    $q$insert into public.ts_views (id, label, members, updated_by)
       values ('zz-verify-o', ' Verify   Owner ', '[{"company":"Slane ","department":"Trim","note":"x"},{"company":"slane","department":"Trim"}]', 'verify')
       returning label || '/' || sort || '/' || members::text$q$,
    pg_temp.ts_v_lit('Verify Owner/0/' || '[{"company":"slane","department":"Trim"}]'::jsonb::text));
  perform pg_temp.ts_v('O2 owner insert with an unknown company is refused', null, null,
    $q$insert into public.ts_views (id, label, members) values ('zz-verify-o2', 'Verify', '[{"company":"acme","department":"Trim"}]') returning id$q$,
    'ERROR %unknown company%');
  perform pg_temp.ts_v('O3 owner insert with a bad id is refused by the check constraint', null, null,
    $q$insert into public.ts_views (id, label) values ('Verify Bad', 'Verify') returning id$q$, 'ERROR 23514%');
  perform pg_temp.ts_v('O4 owner update to both keys is refused', null, null,
    $q$update public.ts_views set members = '[{"company":"slane","department":"Trim","employee_uuid":"zz-verify-1"}]' where id = 'zz-verify-o' returning id$q$,
    'ERROR %not both%');
  perform pg_temp.ts_v('O5 owner insert with a 61-character label is refused', null, null,
    format($q$insert into public.ts_views (id, label) values ('zz-verify-o5', %L) returning id$q$, repeat('L', 61)),
    'ERROR %View name must be 1 to 60 characters%');
  perform pg_temp.ts_v('O5b owner insert with 501 members is refused', null, null,
    $q$insert into public.ts_views (id, label, members)
       select 'zz-verify-o6', 'Verify', jsonb_agg(jsonb_build_object('company', 'slane', 'department', 'zz-verify-d' || g)) from generate_series(1, 501) g
       returning id$q$,
    'ERROR %View can hold at most 500 members%');
  perform pg_temp.ts_v('O6 the admin sees the owner-inserted view', 'authenticated', adm,
    $q$select count(*) from public.ts_views where id = 'zz-verify-o'$q$, '1');
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"*","department":"*"}]');
  perform pg_temp.ts_v('O7 a manager still sees none of them', 'authenticated', adm, vcount, '0');
  perform pg_temp.ts_v_gianni(true, true, '[]');
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
