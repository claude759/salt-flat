-- Verification for supabase/ts-flag-dismissals.sql (Manager Timesheets: mark a Job vs place warning as checked, for
-- everyone; Gianni 2026-11-20).
--
-- One transaction that ROLLS BACK, in the harness of supabase/ts-edit-whole-shift-blank-day-verify.sql: throwaway
-- companies 'zz_fd_a' (CA) and 'zz_fd_n' (NY), synthetic people "Test Person zz-fd-...", a view 'zz-fd-v1', made-up shift
-- ids 'zz-fd-s..' and job ids 'zz-fd-job-..'. It plays each identity, records what each can do, returns one pass/fail
-- table (a SUMMARY row first) and undoes everything. Run it with write access as the project owner (SQL editor, or the
-- management API without read_only) after ts-flag-dismissals.sql; the last result set is the pass/fail table. Every row
-- must say pass = true.
--
-- Identities. This file names no one: the admin it plays is the first active ts_access admin who signs in with Google (an
-- auth.users row with a Google identity of the wizardtrees.com Workspace, as ts_my_email reads it), found below. That
-- sign-in's own ts_access row is then set, in turn (all rolled back), to: no row at all, inactive, a manager with one
-- department grant, a manager with one view of one person, a manager of another department, a ('*', '*') manager, and the
-- admin again; then, with checks stored, an inactive admin and an inactive ('*', '*') manager with a view. Also: anon; a
-- signed-in sub with no auth.users row (a stranger); the admin's email in a password session.
--
-- The days (T = today in Los Angeles - 2; NT = the same in New York; OLD = 2026-01-16, long before the edit window):
--   zz-fd-1  Distro/Trim  T    s1 at Slane (named, in) on Distro Packager; s2 near Filifera, out at Slane, on
--                              Deleaf/Harvest; s3 no place; s4 clocked out elsewhere, no job; s5 at Imperial, a job
--                              with no title
--   zz-fd-2  Packaging    T    s21, s22, s23 at Slane on Distro Packager
--   zz-fd-3  Packaging    T    s31 at Imperial (the view's one person)
--   zz-fd-4  Distro/Trim  OLD  s41 at Olympic
--   zz-fd-5  the day row in Distro/Trim, the person now in Packaging (a finished day keeps its department)  T  s51, s52
--   zz-fd-6  Distro/Trim, no day row
--   zz-fd-n1 at zz_fd_n (NY), Distro Hourly, NT  sn1

begin;

create temp table ts_v_results (
  seq serial primary key,
  test text not null,
  expected text not null,      -- a LIKE pattern (escape '!'); plain text means equal
  got text
) on commit drop;

-- The admin this run plays (see the header), found here so the file names no one.
create temp table ts_v_me on commit drop as
select lower(u.email)::text as email
  from auth.users u
  join public.ts_access a on a.email = lower(u.email) and a.active and a.is_admin
 where u.email_confirmed_at is not null
   and (coalesce(u.raw_app_meta_data->'providers', '[]'::jsonb) @> '["google"]'::jsonb
        or u.raw_app_meta_data->>'provider' = 'google')
   and exists (select 1 from auth.identities i
                where i.user_id = u.id and i.provider = 'google'
                  and lower(i.identity_data->>'email') = lower(u.email)
                  and lower(i.identity_data->'custom_claims'->>'hd') = 'wizardtrees.com')
 order by 1
 limit 1;
do $$ begin
  if not exists (select 1 from pg_temp.ts_v_me) then
    raise exception 'verify needs an active timesheet admin who signs in with Google';
  end if;
end $$;

-- Run p_sql as an identity and return its single value as text, or 'ERROR <sqlstate>: <message>' (as in ts-edits-verify.sql).
-- p_role 'claims' keeps the owner's role and sets only the sign-in (for the reference rule, which is not granted).
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
      if v_sub is null then raise exception 'verify needs a confirmed auth.users row for the admin it plays'; end if;
    end if;
    v_amr := coalesce(p_amr, 'oauth');
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

-- As the owner: set the played admin's own allowlist row and grants (rolled back with everything else).
create function pg_temp.ts_v_me_set(p_is_admin boolean, p_active boolean, p_grants jsonb) returns void
language plpgsql as $f$
declare v_email text := (select email from pg_temp.ts_v_me);
begin
  insert into public.ts_access (email, is_admin, active, note)
  values (v_email, p_is_admin, p_active, 'verify')
  on conflict (email) do update set is_admin = excluded.is_admin, active = excluded.active;
  delete from public.ts_grants where email = v_email;
  insert into public.ts_grants (email, company, department)
  select v_email, g->>'company', g->>'department' from jsonb_array_elements(p_grants) g;
end $f$;

-- As the owner: REPLACE the played admin's view grants with this list of view ids.
create function pg_temp.ts_v_me_views(p_views jsonb) returns void
language plpgsql as $f$
declare v_email text := (select email from pg_temp.ts_v_me);
begin
  delete from public.ts_view_grants where email = v_email;
  insert into public.ts_view_grants (email, view_id, updated_by)
  select v_email, v, 'verify' from jsonb_array_elements_text(p_views) v;
end $f$;

-- A ts_days shift as the sync writes it (only what this file needs): id, in, out, and place and job when given.
create function pg_temp.ts_v_shift(p_id text, p_d date, p_in text, p_out text, p_place jsonb, p_job jsonb) returns jsonb
language sql immutable as $f$
  select jsonb_build_object('id', p_id, 'in', to_char(p_d, 'YYYY-MM-DD') || 'T' || p_in || ':00-08:00',
                            'out', to_char(p_d, 'YYYY-MM-DD') || 'T' || p_out || ':00-08:00',
                            'span_min', 0, 'worked_min', 0, 'hours_only', false, 'breaks', '[]'::jsonb)
         || case when p_place is null then '{}'::jsonb else jsonb_build_object('place', p_place) end
         || case when p_job is null then '{}'::jsonb else jsonb_build_object('job', p_job) end
$f$;

-- One synthetic day row, last synced an hour ago; returns its id.
create function pg_temp.ts_v_day(p_company text, p_region text, p_uuid text, p_dept text, p_d date, p_shifts jsonb) returns text
language sql as $f$
  insert into public.ts_days (id, company, region, employee_uuid, employee_name, department, work_date, first_in, last_out, shifts, flags, "open", synced_at)
  values (p_company || ':' || p_uuid || ':' || to_char(p_d, 'YYYY-MM-DD'), p_company, p_region, p_uuid, 'Test Person ' || p_uuid,
          p_dept, p_d, (p_shifts->0->>'in')::timestamptz, (p_shifts->-1->>'out')::timestamptz, p_shifts, '[]'::jsonb, false,
          now() - interval '1 hour')
  returning id
$f$;

-- ---------------------------------------------------------------- SQL builders
-- dismiss, returning 'shift / job / place / reason / dismissed_by / undone_by'
create function pg_temp.ts_v_dis(p_day text, p_shift text, p_code text, p_reason text) returns text
language sql immutable as $f$
  select format($q$select concat_ws(' / ', r->>'shift_id', coalesce(r->>'job', '(no job)'), coalesce(r->>'place', '(no place)'),
                                   coalesce(r->>'reason', '(no reason)'), r->>'dismissed_by', coalesce(r->>'undone_by', '(active)'))
                     from (select public.ts_flag_dismiss(%L, %L, %L, %L) r) s$q$, p_day, p_shift, p_code, p_reason)
$f$;
-- the same with three arguments (the reason left to its default)
create function pg_temp.ts_v_dis3(p_day text, p_shift text, p_code text) returns text
language sql immutable as $f$
  select format($q$select concat_ws(' / ', r->>'shift_id', coalesce(r->>'job', '(no job)'), coalesce(r->>'place', '(no place)'),
                                   coalesce(r->>'reason', '(no reason)'), r->>'dismissed_by', coalesce(r->>'undone_by', '(active)'))
                     from (select public.ts_flag_dismiss(%L, %L, %L) r) s$q$, p_day, p_shift, p_code)
$f$;
-- dismiss, returning the row's id
create function pg_temp.ts_v_dis_id(p_day text, p_shift text, p_code text) returns text
language sql immutable as $f$
  select format($q$select r->>'id' from (select public.ts_flag_dismiss(%L, %L, %L) r) s$q$, p_day, p_shift, p_code)
$f$;
-- undo, returning 'shift / undone_by / undone_at is set'
create function pg_temp.ts_v_undo(p_id uuid) returns text
language sql immutable as $f$
  select format($q$select concat_ws(' / ', r->>'shift_id', coalesce(r->>'undone_by', '(active)'), (r->>'undone_at' is not null)::text)
                     from (select public.ts_flag_undismiss(%L::uuid) r) s$q$, p_id)
$f$;
-- (owner) the active dismissal of a day and shift, and 'rows/active' of them
create function pg_temp.ts_v_active(p_day text, p_shift text) returns uuid
language sql as $f$
  select f.id from public.ts_flag_dismissals f where f.day_id = p_day and f.shift_id = p_shift and f.undone_at is null
$f$;
create function pg_temp.ts_v_n(p_day text, p_shift text) returns text
language sql as $f$
  select count(*) || '/' || count(*) filter (where f.undone_at is null)
    from public.ts_flag_dismissals f where f.day_id = p_day and f.shift_id = p_shift
$f$;

-- ------------------------------------------------------------------ setup (as owner, rolled back)
select pg_temp.ts_v_me_set(true, true, '[]');
select pg_temp.ts_v_me_views('[]');
insert into public.ts_companies (key, name, region) values
  ('zz_fd_a', 'Verify Flag Dismissals A', 'CA'), ('zz_fd_n', 'Verify Flag Dismissals NY', 'NY')
on conflict do nothing;
insert into public.ts_views (id, label, sort, members, updated_by) values
  ('zz-fd-v1', 'Verify Flag Dismissals One', 993, '[{"company":"zz_fd_a","employee_uuid":"zz-fd-3"}]', 'verify');

-- ------------------------------------------------------------------ checks
do $v$
declare
  adm    constant text := (select email from pg_temp.ts_v_me);
  t      constant date := (now() at time zone 'America/Los_Angeles')::date - 2;
  nt     constant date := (now() at time zone 'America/New_York')::date - 2;
  old    constant date := date '2026-01-16';
  no_day constant text := 'ERROR 42501: No such day, or you cannot see it';
  no_row constant text := 'ERROR 42501: No such check, or you cannot see it';
  no_in  constant text := 'ERROR 42501: Only timesheet sign-ins can mark a warning as checked';
    denied constant text := 'ERROR 42501: permission denied for table ts_flag_dismissals';
  slane  constant jsonb := '{"site": "Slane", "how": "named", "at": "in"}';
  pack   constant jsonb := '{"id": "zz-fd-job-1", "title": "Distro Packager", "src": "gusto"}';
  sentinel constant timestamptz := timestamptz '2026-01-01 00:00:00+00';
  -- what each identity sees, and what the reference rule (ts_flag_can_see, as that sign-in) says it may see
  vis    constant text := $q$select coalesce(string_agg(distinct employee_uuid, ',' order by employee_uuid), '(none)')
                              from public.ts_flag_dismissals where employee_uuid like 'zz-fd-%'$q$;
  ids    constant text := $q$select coalesce(string_agg(id::text, ',' order by id), '(none)')
                              from public.ts_flag_dismissals where employee_uuid like 'zz-fd-%'$q$;
  ref    constant text := $q$select coalesce(string_agg(id::text, ',' order by id), '(none)')
                              from public.ts_flag_dismissals where employee_uuid like 'zz-fd-%'
                               and public.ts_flag_can_see(day_id)$q$;
  d1 text; d2 text; d3 text; d4 text; d5 text; dn text;
  id1 uuid; id2 uuid; id4 uuid; id21 uuid; idn uuid; id3 uuid; id52 uuid;
  v_n int;
  cfg record;
begin
  -- ---------------------------------------------------------------- fixtures (as owner)
  insert into public.ts_people (company, employee_uuid, name, department, job_title, active) values
    ('zz_fd_a', 'zz-fd-1', 'Test Person zz-fd-1', 'Distro/Trim', 'Distro Packager', true),
    ('zz_fd_a', 'zz-fd-2', 'Test Person zz-fd-2', 'Packaging', 'Distro Packager', true),
    ('zz_fd_a', 'zz-fd-3', 'Test Person zz-fd-3', 'Packaging', 'Distro Packager', true),
    ('zz_fd_a', 'zz-fd-4', 'Test Person zz-fd-4', 'Distro/Trim', 'Distro Packager', true),
    ('zz_fd_a', 'zz-fd-5', 'Test Person zz-fd-5', 'Packaging', 'Distro Packager', true),
    ('zz_fd_a', 'zz-fd-6', 'Test Person zz-fd-6', 'Distro/Trim', 'Distro Packager', true),
    ('zz_fd_n', 'zz-fd-n1', 'Test Person zz-fd-n1', 'Distro Hourly', 'Packer', true);
  d1 := pg_temp.ts_v_day('zz_fd_a', 'CA', 'zz-fd-1', 'Distro/Trim', t, jsonb_build_array(
          pg_temp.ts_v_shift('zz-fd-s1', t, '06:00', '08:00', slane, pack),
          pg_temp.ts_v_shift('zz-fd-s2', t, '08:30', '10:00', '{"site": "Filifera", "how": "near", "at": "in", "other": "Slane"}',
                             '{"id": "zz-fd-job-2", "title": "Deleaf/Harvest", "src": "gusto"}'),
          pg_temp.ts_v_shift('zz-fd-s3', t, '10:30', '11:00', null, pack),
          pg_temp.ts_v_shift('zz-fd-s4', t, '11:30', '12:00', '{"site": null, "how": "elsewhere", "at": "out"}', null),
          pg_temp.ts_v_shift('zz-fd-s5', t, '12:30', '13:00', '{"site": "Imperial", "how": "named", "at": "in"}', '{"id": "zz-fd-job-9"}')));
  d2 := pg_temp.ts_v_day('zz_fd_a', 'CA', 'zz-fd-2', 'Packaging', t, jsonb_build_array(
          pg_temp.ts_v_shift('zz-fd-s21', t, '06:00', '08:00', slane, pack),
          pg_temp.ts_v_shift('zz-fd-s22', t, '08:30', '10:00', slane, pack),
          pg_temp.ts_v_shift('zz-fd-s23', t, '10:30', '12:00', slane, pack)));
  d3 := pg_temp.ts_v_day('zz_fd_a', 'CA', 'zz-fd-3', 'Packaging', t, jsonb_build_array(
          pg_temp.ts_v_shift('zz-fd-s31', t, '06:00', '08:00', '{"site": "Imperial", "how": "named", "at": "in"}', pack)));
  d4 := pg_temp.ts_v_day('zz_fd_a', 'CA', 'zz-fd-4', 'Distro/Trim', old, jsonb_build_array(
          pg_temp.ts_v_shift('zz-fd-s41', old, '06:00', '08:00', '{"site": "Olympic", "how": "named", "at": "in"}', pack)));
  d5 := pg_temp.ts_v_day('zz_fd_a', 'CA', 'zz-fd-5', 'Distro/Trim', t, jsonb_build_array(
          pg_temp.ts_v_shift('zz-fd-s51', t, '06:00', '08:00', slane, pack),
          pg_temp.ts_v_shift('zz-fd-s52', t, '08:30', '10:00', slane, pack)));
  dn := pg_temp.ts_v_day('zz_fd_n', 'NY', 'zz-fd-n1', 'Distro Hourly', nt, jsonb_build_array(
          pg_temp.ts_v_shift('zz-fd-sn1', nt, '06:00', '08:00', slane, '{"id": "zz-fd-job-3", "title": "Packer", "src": "gusto"}')));

  -- ---------------------------------------------------------------- A. catalog
  perform pg_temp.ts_v('A1 the table has the contract''s columns, types and nulls, in order', null, null,
    $q$select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position)
         from information_schema.columns where table_schema = 'public' and table_name = 'ts_flag_dismissals'$q$,
    pg_temp.ts_v_lit('id:uuid:NO,day_id:text:NO,company:text:NO,employee_uuid:text:NO,work_date:date:NO,shift_id:text:NO,code:text:NO,'
                  || 'job:text:YES,place:text:YES,reason:text:YES,dismissed_by:text:NO,dismissed_at:timestamp with time zone:NO,'
                  || 'undone_by:text:YES,undone_at:timestamp with time zone:YES'));
  perform pg_temp.ts_v('A2 id defaults to gen_random_uuid() and dismissed_at to now(); no other column has a default', null, null,
    $q$select string_agg(column_name || '=' || column_default, ',' order by column_name)
         from information_schema.columns where table_schema = 'public' and table_name = 'ts_flag_dismissals' and column_default is not null$q$,
    pg_temp.ts_v_lit('dismissed_at=now(),id=gen_random_uuid()'));
  perform pg_temp.ts_v('A3 its constraints: the key, the company, the code, the reason, a lower-case dismissed_by, undone_by and undone_at together', null, null,
    $q$select string_agg(c.conname || ':' || c.contype::text, ',' order by c.conname) from pg_constraint c
        where c.conrelid = 'public.ts_flag_dismissals'::regclass$q$,
    pg_temp.ts_v_lit('ts_flag_dismissals_by:c,ts_flag_dismissals_code_check:c,ts_flag_dismissals_company_fkey:f,ts_flag_dismissals_pkey:p,'
                  || 'ts_flag_dismissals_reason:c,ts_flag_dismissals_undone:c'));
  perform pg_temp.ts_v('A3b ... the only foreign key is the company (a dismissal outlives its day row)', null, null,
    $q$select string_agg(c.confrelid::regclass::text, ',') from pg_constraint c
        where c.conrelid = 'public.ts_flag_dismissals'::regclass and c.contype = 'f'$q$, '%ts!_companies');
  perform pg_temp.ts_v('A4 even the owner cannot store another code', null, null,
    $q$insert into public.ts_flag_dismissals (day_id, company, employee_uuid, work_date, shift_id, code, dismissed_by)
       values ('zz_fd_a:zz-fx-1:2026-01-16', 'zz_fd_a', 'zz-fx-1', date '2026-01-16', 'x', 'midnight_split', 'demo.owner@wizardtrees.com') returning id::text$q$,
    'ERROR 23514%');
  perform pg_temp.ts_v('A4c ... a reason of 201 characters', null, null,
    $q$insert into public.ts_flag_dismissals (day_id, company, employee_uuid, work_date, shift_id, code, reason, dismissed_by)
       values ('zz_fd_a:zz-fx-1:2026-01-16', 'zz_fd_a', 'zz-fx-1', date '2026-01-16', 'x', 'job_place', repeat('r', 201), 'demo.owner@wizardtrees.com') returning id::text$q$,
    'ERROR 23514%');
  perform pg_temp.ts_v('A4d ... an empty reason', null, null,
    $q$insert into public.ts_flag_dismissals (day_id, company, employee_uuid, work_date, shift_id, code, reason, dismissed_by)
       values ('zz_fd_a:zz-fx-1:2026-01-16', 'zz_fd_a', 'zz-fx-1', date '2026-01-16', 'x', 'job_place', '', 'demo.owner@wizardtrees.com') returning id::text$q$,
    'ERROR 23514%');
  perform pg_temp.ts_v('A4e ... a dismissed_by in capitals', null, null,
    $q$insert into public.ts_flag_dismissals (day_id, company, employee_uuid, work_date, shift_id, code, dismissed_by)
       values ('zz_fd_a:zz-fx-1:2026-01-16', 'zz_fd_a', 'zz-fx-1', date '2026-01-16', 'x', 'job_place', 'Demo.Owner@wizardtrees.com') returning id::text$q$,
    'ERROR 23514%');
  perform pg_temp.ts_v('A4f ... an undone_at without undone_by', null, null,
    $q$insert into public.ts_flag_dismissals (day_id, company, employee_uuid, work_date, shift_id, code, dismissed_by, undone_at)
       values ('zz_fd_a:zz-fx-1:2026-01-16', 'zz_fd_a', 'zz-fx-1', date '2026-01-16', 'x', 'job_place', 'demo.owner@wizardtrees.com', now()) returning id::text$q$,
    'ERROR 23514%');
  perform pg_temp.ts_v('A5 the indexes: one active dismissal per day, shift and code, and work_date', null, null,
    $q$select string_agg(indexdef, ';' order by indexname) from pg_indexes
        where schemaname = 'public' and tablename = 'ts_flag_dismissals' and indexname <> 'ts_flag_dismissals_pkey'$q$,
    pg_temp.ts_v_lit('CREATE UNIQUE INDEX ts_flag_dismissals_active_idx ON public.ts_flag_dismissals USING btree (day_id, shift_id, code) WHERE (undone_at IS NULL);'
                  || 'CREATE INDEX ts_flag_dismissals_work_date_idx ON public.ts_flag_dismissals USING btree (work_date)'));
  perform pg_temp.ts_v('A5b even the owner cannot store two active dismissals of one shift', null, null,
    $q$insert into public.ts_flag_dismissals (day_id, company, employee_uuid, work_date, shift_id, code, dismissed_by)
       values ('zz_fd_a:zz-fx-1:2026-01-16', 'zz_fd_a', 'zz-fx-1', date '2026-01-16', 'x', 'job_place', 'demo.owner@wizardtrees.com'),
              ('zz_fd_a:zz-fx-1:2026-01-16', 'zz_fd_a', 'zz-fx-1', date '2026-01-16', 'x', 'job_place', 'demo.owner@wizardtrees.com') returning id::text$q$,
    'ERROR 23505%');
  perform pg_temp.ts_v('A5c ... but any number of undone ones beside one active one', null, null,
    $q$with a as (insert into public.ts_flag_dismissals (day_id, company, employee_uuid, work_date, shift_id, code, dismissed_by, undone_by, undone_at)
                  values ('zz_fd_a:zz-fx-1:2026-01-16', 'zz_fd_a', 'zz-fx-1', date '2026-01-16', 'x', 'job_place', 'demo.owner@wizardtrees.com', 'demo.owner@wizardtrees.com', now()),
                         ('zz_fd_a:zz-fx-1:2026-01-16', 'zz_fd_a', 'zz-fx-1', date '2026-01-16', 'x', 'job_place', 'demo.owner@wizardtrees.com', 'demo.owner@wizardtrees.com', now()),
                         ('zz_fd_a:zz-fx-1:2026-01-16', 'zz_fd_a', 'zz-fx-1', date '2026-01-16', 'x', 'job_place', 'demo.owner@wizardtrees.com', null, null)
                  returning 1)
       select count(*)::text from a$q$, '3');
  delete from public.ts_flag_dismissals where employee_uuid = 'zz-fx-1';
  perform pg_temp.ts_v('A6 RLS is on, with one policy, SELECT to authenticated', null, null,
    $q$select (select relrowsecurity from pg_class where oid = 'public.ts_flag_dismissals'::regclass)::text || '/'
              || (select count(*) || '/' || string_agg(cmd || ':' || array_to_string(roles, ','), ',') from pg_policies
                   where schemaname = 'public' and tablename = 'ts_flag_dismissals')$q$, 'true/1/SELECT:authenticated');
  perform pg_temp.ts_v('A7 authenticated may only SELECT the table; anon and PUBLIC nothing', null, null,
    $q$select string_agg(r || '=' || coalesce((select string_agg(p, '+' order by p)
                                                 from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
                                                where has_table_privilege(r, 'public.ts_flag_dismissals', p)), ''), ',' order by r)
         from unnest(array['anon', 'authenticated', 'public']) r$q$, 'anon=,authenticated=SELECT,public=');
  perform pg_temp.ts_v('A8 the two RPCs: one signature each, security definer, search_path=public, run by authenticated, not PUBLIC or anon', null, null,
    $q$select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')=' || p.prosecdef
                         || '/' || coalesce(array_to_string(p.proconfig, ',') like '%search_path=public%', false)
                         || '/' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
                         || '/' || has_function_privilege('public', p.oid, 'EXECUTE')
                         || '/' || has_function_privilege('anon', p.oid, 'EXECUTE'), ',' order by p.proname)
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('ts_flag_dismiss', 'ts_flag_undismiss')$q$,
    pg_temp.ts_v_lit('ts_flag_dismiss(p_day_id text, p_shift_id text, p_code text, p_reason text)=true/true/true/false/false,'
                  || 'ts_flag_undismiss(p_id uuid)=true/true/true/false/false'));
  perform pg_temp.ts_v('A8b ... ts_flag_dismiss takes no job or place from the caller, and its reason defaults to null', null, null,
    $q$select pg_get_expr(p.proargdefaults, 0) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'ts_flag_dismiss'$q$, 'NULL::text');
  perform pg_temp.ts_v('A9 the two helpers are internal: security definer, search_path=public, run by nobody', null, null,
    $q$select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')=' || p.prosecdef
                         || '/' || coalesce(array_to_string(p.proconfig, ',') like '%search_path=public%', false)
                         || '/' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
                         || '/' || has_function_privilege('public', p.oid, 'EXECUTE')
                         || '/' || has_function_privilege('anon', p.oid, 'EXECUTE'), ',' order by p.proname)
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('ts_flag_place_text', 'ts_flag_can_see')$q$,
    pg_temp.ts_v_lit('ts_flag_can_see(p_day_id text)=true/true/false/false/false,'
                  || 'ts_flag_place_text(p_place jsonb)=true/true/false/false/false'));
  perform pg_temp.ts_v('A10 no ts_ function has job in its name, and every ts_flag_ function is security definer with search_path=public', null, null,
    $q$select count(*) filter (where p.proname like '%job%') || '/'
              || count(*) filter (where p.proname like 'ts!_flag!_%' escape '!'
                                    and not (p.prosecdef and coalesce(array_to_string(p.proconfig, ',') like '%search_path=public%', false)))
              || '/' || count(*) filter (where p.proname like 'ts!_flag!_%' escape '!')
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'ts\_%'$q$, '0/0/4');
  perform pg_temp.ts_v('A11 a place as text: the jsonb as Postgres writes it (keys shortest first, then A to Z); null for no place', null, null,
    $q$select string_agg(coalesce(public.ts_flag_place_text(x), '(null)'), ' ; ' order by o)
         from unnest(array['{"site": "Slane", "how": "named", "at": "in"}',
                           '{"site": null, "how": "elsewhere", "at": "out"}',
                           '{"site": "Filifera", "how": "near", "at": "in", "other": "Slane"}',
                           '{"how": "none", "at": "in", "site": 7}',
                           '{}', 'null', '"Slane"']::jsonb[]) with ordinality u(x, o)$q$,
    pg_temp.ts_v_lit('{"at": "in", "how": "named", "site": "Slane"} ; {"at": "out", "how": "elsewhere", "site": null} ; {"at": "in", "how": "near", "site": "Filifera", "other": "Slane"} ; {"at": "in", "how": "none", "site": 7} ; {} ; (null) ; (null)'));
  perform pg_temp.ts_v('A11b ... and a SQL null is no place', null, null,
    $q$select coalesce(public.ts_flag_place_text(null), '(null)')$q$, '(null)');

  -- ---------------------------------------------------------------- B. who may not
  perform pg_temp.ts_v('B1 anon cannot mark a warning as checked', 'anon', null, pg_temp.ts_v_dis(d1, 'zz-fd-s1', 'job_place', null),
    'ERROR 42501: permission denied for function ts_flag_dismiss');
  perform pg_temp.ts_v('B2 anon cannot undo one', 'anon', null, pg_temp.ts_v_undo(gen_random_uuid()),
    'ERROR 42501: permission denied for function ts_flag_undismiss');
  perform pg_temp.ts_v('B3 anon cannot read the table', 'anon', null, vis, denied);
  perform pg_temp.ts_v('B4 a signed-in stranger (no auth.users row) cannot mark one', 'authenticated', null,
    pg_temp.ts_v_dis(d1, 'zz-fd-s1', 'job_place', null), no_in);
  perform pg_temp.ts_v('B4b ... nor undo one', 'authenticated', null, pg_temp.ts_v_undo(gen_random_uuid()), no_in);
  perform pg_temp.ts_v('B4c ... and sees none', 'authenticated', null, vis, '(none)');
  perform pg_temp.ts_v('B5 the admin''s email in a password session (not Google) cannot mark one', 'authenticated', adm,
    pg_temp.ts_v_dis(d1, 'zz-fd-s1', 'job_place', null), no_in, 'password');
  perform pg_temp.ts_v('B5b ... nor in a session with no amr', 'authenticated', adm,
    pg_temp.ts_v_dis(d1, 'zz-fd-s1', 'job_place', null), no_in, 'none');
  delete from public.ts_access where email = adm;
  perform pg_temp.ts_v('B6 a Google sign-in with no access (no ts_access row) cannot mark one', 'authenticated', adm,
    pg_temp.ts_v_dis(d1, 'zz-fd-s1', 'job_place', null), no_in);
  perform pg_temp.ts_v('B6b ... nor undo one', 'authenticated', adm, pg_temp.ts_v_undo(gen_random_uuid()), no_in);
  perform pg_temp.ts_v('B6c ... and sees none', 'authenticated', adm, vis, '(none)');
  perform pg_temp.ts_v_me_set(true, false, '[]');
  perform pg_temp.ts_v('B7 an inactive admin cannot mark one', 'authenticated', adm,
    pg_temp.ts_v_dis(d1, 'zz-fd-s1', 'job_place', null), no_in);
  perform pg_temp.ts_v_me_set(true, true, '[]');
  perform pg_temp.ts_v('B8 the refused calls stored nothing', null, null,
    $q$select count(*)::text from public.ts_flag_dismissals where employee_uuid like 'zz-fd-%'$q$, '0');

  -- ---------------------------------------------------------------- C. the admin
  perform pg_temp.ts_v('C1 the admin marks s1 (At Slane on Distro Packager) as checked, with no reason (three arguments)', 'authenticated', adm,
    pg_temp.ts_v_dis3(d1, 'zz-fd-s1', 'job_place'),
    pg_temp.ts_v_lit('zz-fd-s1 / Distro Packager / {"at": "in", "how": "named", "site": "Slane"} / (no reason) / ' || adm || ' / (active)'));
  id1 := pg_temp.ts_v_active(d1, 'zz-fd-s1');
  perform pg_temp.ts_v('C1b ... stored with the day row''s id, company, person and date, the code and a time', null, null,
    format($q$select day_id || '/' || company || '/' || employee_uuid || '/' || work_date || '/' || code || '/' || (dismissed_at is not null)
                from public.ts_flag_dismissals where id = %L$q$, id1),
    pg_temp.ts_v_lit(d1 || '/zz_fd_a/zz-fd-1/' || to_char(t, 'YYYY-MM-DD') || '/job_place/true'));
  -- (owner) an earlier time, so the next check can see whether the row was rewritten (now() is one time in a transaction)
  update public.ts_flag_dismissals set dismissed_at = sentinel where id = id1;
  perform pg_temp.ts_v('C2 marking it again gives back the same row (no error)', 'authenticated', adm,
    pg_temp.ts_v_dis_id(d1, 'zz-fd-s1', 'job_place'), id1::text);
  perform pg_temp.ts_v('C2b ... the code in any case gives it back too', 'authenticated', adm,
    pg_temp.ts_v_dis_id(d1, 'zz-fd-s1', ' JOB_Place '), id1::text);
  perform pg_temp.ts_v('C2c ... with a reason this time: the row stays as it was (one row, its time and no reason)', 'authenticated', adm,
    pg_temp.ts_v_dis(d1, 'zz-fd-s1', 'job_place', 'second try'),
    pg_temp.ts_v_lit('zz-fd-s1 / Distro Packager / {"at": "in", "how": "named", "site": "Slane"} / (no reason) / ' || adm || ' / (active)'));
  perform pg_temp.ts_v('C2d ... one row, still active, still dismissed at its first time', null, null,
    format($q$select (select count(*) || '/' || count(*) filter (where undone_at is null) from public.ts_flag_dismissals
                        where day_id = %L and shift_id = 'zz-fd-s1') || '/' || (dismissed_at = %L::timestamptz)
                from public.ts_flag_dismissals where id = %L$q$, d1, sentinel, id1), '1/1/true');
  perform pg_temp.ts_v('C3 s2 with a reason over several lines: one line, its whitespace evened; the place with its clock-out site', 'authenticated', adm,
    pg_temp.ts_v_dis(d1, 'zz-fd-s2', 'job_place', E'  job\n  is \t right  '),
    pg_temp.ts_v_lit('zz-fd-s2 / Deleaf/Harvest / {"at": "in", "how": "near", "site": "Filifera", "other": "Slane"} / job is right / ' || adm || ' / (active)'));
  perform pg_temp.ts_v('C4 s4 has no job: job is null, the place reads clocked out elsewhere', 'authenticated', adm,
    pg_temp.ts_v_dis(d1, 'zz-fd-s4', 'job_place', null),
    pg_temp.ts_v_lit('zz-fd-s4 / (no job) / {"at": "out", "how": "elsewhere", "site": null} / (no reason) / ' || adm || ' / (active)'));
  id4 := pg_temp.ts_v_active(d1, 'zz-fd-s4');
  perform pg_temp.ts_v('C5 s5''s job has no title: job is null', 'authenticated', adm,
    pg_temp.ts_v_dis(d1, 'zz-fd-s5', 'job_place', null),
    pg_temp.ts_v_lit('zz-fd-s5 / (no job) / {"at": "in", "how": "named", "site": "Imperial"} / (no reason) / ' || adm || ' / (active)'));
  perform pg_temp.ts_v('C6 a reason of only whitespace is stored as none (s21, Packaging)', 'authenticated', adm,
    pg_temp.ts_v_dis(d2, 'zz-fd-s21', 'job_place', E'  \n\t '),
    pg_temp.ts_v_lit('zz-fd-s21 / Distro Packager / {"at": "in", "how": "named", "site": "Slane"} / (no reason) / ' || adm || ' / (active)'));
  id21 := pg_temp.ts_v_active(d2, 'zz-fd-s21');
  perform pg_temp.ts_v('C7 a New York day', 'authenticated', adm,
    pg_temp.ts_v_dis(dn, 'zz-fd-sn1', 'job_place', null),
    pg_temp.ts_v_lit('zz-fd-sn1 / Packer / {"at": "in", "how": "named", "site": "Slane"} / (no reason) / ' || adm || ' / (active)'));
  idn := pg_temp.ts_v_active(dn, 'zz-fd-sn1');
  perform pg_temp.ts_v('C8 no edit window: a day long before it (OLD), with a reason of exactly 200 characters after trimming', 'authenticated', adm,
    format($q$select length(r->>'reason') || '/' || (r->>'work_date') from (select public.ts_flag_dismiss(%L, 'zz-fd-s41', 'job_place', %L) r) s$q$,
           d4, '  ' || repeat('y', 200) || E' \n'), '200/2026-01-16');
  -- (owner) Gusto processed the pay period of T at zz_fd_a
  update public.ts_companies
     set pay_periods = jsonb_build_array(jsonb_build_object('start', t - 13, 'end', t + 1, 'schedule', 'zz-fd-sched', 'closed', true,
                                                           'why', 'processed', 'sent_at', null, 'processed_at', null))
   where key = 'zz_fd_a';
  perform pg_temp.ts_v('C9 no pay period check: the period of T reads as processed ...', null, null,
    format($q$select (public.ts_edit_period_closed('zz_fd_a', %L::date) is not null)::text$q$, t), 'true');
  perform pg_temp.ts_v('C9b ... and a shift on T is still marked as checked (s51)', 'authenticated', adm,
    pg_temp.ts_v_dis(d5, 'zz-fd-s51', 'job_place', null),
    pg_temp.ts_v_lit('zz-fd-s51 / Distro Packager / {"at": "in", "how": "named", "site": "Slane"} / (no reason) / ' || adm || ' / (active)'));
  update public.ts_companies set pay_periods = null where key = 'zz_fd_a';

  -- ---------------------------------------------------------------- R. refusals, in their words
  perform pg_temp.ts_v('R1 another code is refused', 'authenticated', adm, pg_temp.ts_v_dis(d1, 'zz-fd-s1', 'midnight_split', null),
    'ERROR P0001: Only a Job vs place warning can be marked as checked');
  perform pg_temp.ts_v('R1b ... and no code', 'authenticated', adm, pg_temp.ts_v_dis(d1, 'zz-fd-s1', null, null),
    'ERROR P0001: Only a Job vs place warning can be marked as checked');
  perform pg_temp.ts_v('R2 a reason of 201 characters on a shift with no place gets the place''s answer (the place is checked first)', 'authenticated', adm,
    pg_temp.ts_v_dis(d1, 'zz-fd-s3', 'job_place', repeat('r', 201)),
    'ERROR P0001: That shift has no clock-in place, so it has no Job vs place warning');
  perform pg_temp.ts_v('R2b ... on a shift with a place: the reason''s answer', 'authenticated', adm,
    pg_temp.ts_v_dis(d3, 'zz-fd-s31', 'job_place', repeat('r', 201)), 'ERROR P0001: The reason can be at most 200 characters');
  perform pg_temp.ts_v('R3 a day with no row', 'authenticated', adm,
    pg_temp.ts_v_dis('zz_fd_a:zz-fd-6:' || to_char(t, 'YYYY-MM-DD'), 'zz-fd-s1', 'job_place', null), no_day);
  perform pg_temp.ts_v('R3b ... no day at all', 'authenticated', adm, pg_temp.ts_v_dis(null, 'zz-fd-s1', 'job_place', null), no_day);
  perform pg_temp.ts_v('R4 no shift gets the shift''s answer', 'authenticated', adm, pg_temp.ts_v_dis(d1, '  ', 'job_place', null),
    'ERROR P0001: That shift is not on this day any more (it may have changed in Gusto). Reload and try again');
  perform pg_temp.ts_v('R4b ... a null shift', 'authenticated', adm, pg_temp.ts_v_dis(d1, null, 'job_place', null),
    'ERROR P0001: That shift is not on this day any more (it may have changed in Gusto). Reload and try again');
  perform pg_temp.ts_v('R5 a shift that is not on the day row', 'authenticated', adm, pg_temp.ts_v_dis(d1, 'zz-fd-s21', 'job_place', null),
    'ERROR P0001: That shift is not on this day any more (it may have changed in Gusto). Reload and try again');
  perform pg_temp.ts_v('R6 a shift with no place', 'authenticated', adm, pg_temp.ts_v_dis(d1, 'zz-fd-s3', 'job_place', null),
    'ERROR P0001: That shift has no clock-in place, so it has no Job vs place warning');
  perform pg_temp.ts_v('R7 the refused calls stored nothing (s3, zz-fd-3, zz-fd-6, and no row with another code)', null, null,
    format($q$select count(*)::text from public.ts_flag_dismissals
                where (day_id = %L and shift_id in ('zz-fd-s3', 'zz-fd-s21')) or employee_uuid in ('zz-fd-3', 'zz-fd-6') or code <> 'job_place'$q$, d1), '0');

  -- ---------------------------------------------------------------- D. undo
  perform pg_temp.ts_v('D1 the admin undoes s1''s', 'authenticated', adm, pg_temp.ts_v_undo(id1),
    pg_temp.ts_v_lit('zz-fd-s1 / ' || adm || ' / true'));
  perform pg_temp.ts_v('D1b ... stored with who and when; no active one is left', null, null,
    format($q$select (undone_by = %L) || '/' || (undone_at is not null) || '/' || pg_temp.ts_v_n(day_id, shift_id)
                from public.ts_flag_dismissals where id = %L$q$, adm, id1), 'true/true/1/0');
  -- (owner) an earlier undo time, so the next check can see whether the row was rewritten
  update public.ts_flag_dismissals set undone_at = sentinel where id = id1;
  perform pg_temp.ts_v('D2 undoing it again gives the row back as it is', 'authenticated', adm, pg_temp.ts_v_undo(id1),
    pg_temp.ts_v_lit('zz-fd-s1 / ' || adm || ' / true'));
  perform pg_temp.ts_v('D2b ... its undo time unchanged', null, null,
    format($q$select (undone_at = %L::timestamptz)::text from public.ts_flag_dismissals where id = %L$q$, sentinel, id1), 'true');
  perform pg_temp.ts_v('D3 marking s1 again after the undo stores a new row', 'authenticated', adm,
    format($q$select (r->>'id' <> %L) || '/' || coalesce(r->>'undone_by', '(active)') from (select public.ts_flag_dismiss(%L, 'zz-fd-s1', 'job_place') r) s$q$, id1, d1),
    'true/(active)');
  perform pg_temp.ts_v('D3b ... two rows, one active', null, null, format($q$select pg_temp.ts_v_n(%L, 'zz-fd-s1')$q$, d1), '2/1');
  perform pg_temp.ts_v('D4 undoing an id that does not exist', 'authenticated', adm, pg_temp.ts_v_undo(gen_random_uuid()), no_row);
  perform pg_temp.ts_v('D4b ... no id', 'authenticated', adm, pg_temp.ts_v_undo(null), no_row);

  -- ---------------------------------------------------------------- E. job and place come from the day row at that moment
  -- (owner) the next sync gives s1 the job "Deleaf/Harvest - Slane"
  update public.ts_days
     set shifts = (select jsonb_agg(case when s->>'id' = 'zz-fd-s1'
                                         then s || '{"job": {"id": "zz-fd-job-4", "title": "Deleaf/Harvest - Slane", "src": "gusto"}}'::jsonb
                                         else s end order by o)
                     from jsonb_array_elements(shifts) with ordinality u(s, o))
   where id = d1;
  perform pg_temp.ts_v('E1 after Gusto moved s1 to another job, marking it stores the new job (the old check no longer counts)', 'authenticated', adm,
    pg_temp.ts_v_dis(d1, 'zz-fd-s1', 'job_place', null),
    pg_temp.ts_v_lit('zz-fd-s1 / Deleaf/Harvest - Slane / {"at": "in", "how": "named", "site": "Slane"} / (no reason) / ' || adm || ' / (active)'));
  perform pg_temp.ts_v('E1b ... the old active row was closed as superseded; the undone one stays as it was', null, null,
    format($q$select string_agg(x, ',' order by x) from (
                select job || '=' || case when undone_by is null then 'active' when undone_by = 'superseded' then 'superseded'
                                          when undone_by = %L then 'undone' else undone_by end as x
                  from public.ts_flag_dismissals where day_id = %L and shift_id = 'zz-fd-s1') y$q$, adm, d1),
    'Deleaf/Harvest - Slane=active,Distro Packager=superseded,Distro Packager=undone');
  -- (owner) the worker read s2 again, now clocked in and out at Slane
  update public.ts_days
     set shifts = (select jsonb_agg(case when s->>'id' = 'zz-fd-s2'
                                         then s || jsonb_build_object('place', '{"site": "Slane", "how": "named", "at": "in"}'::jsonb)
                                         else s end order by o)
                     from jsonb_array_elements(shifts) with ordinality u(s, o))
   where id = d1;
  perform pg_temp.ts_v('E2 after the place of s2 changed, marking it stores the new place (and no reason: the old one stays with its row)', 'authenticated', adm,
    pg_temp.ts_v_dis(d1, 'zz-fd-s2', 'job_place', null),
    pg_temp.ts_v_lit('zz-fd-s2 / Deleaf/Harvest / {"at": "in", "how": "named", "site": "Slane"} / (no reason) / ' || adm || ' / (active)'));
  perform pg_temp.ts_v('E2b ... two rows of s2, one active', null, null, format($q$select pg_temp.ts_v_n(%L, 'zz-fd-s2')$q$, d1), '2/1');

  -- ---------------------------------------------------------------- F. a department manager (zz_fd_a / Distro/Trim)
  perform pg_temp.ts_v_me_set(false, true, '[{"company":"zz_fd_a","department":"Distro/Trim"}]');
  update public.ts_flag_dismissals set dismissed_at = sentinel where id = id4;
  perform pg_temp.ts_v('F1 marking a shift the admin already checked (s4) gives back that row unchanged', 'authenticated', adm,
    format($q$select (r->>'id' = %L) || '/' || ((r->>'dismissed_at')::timestamptz = %L::timestamptz)
                from (select public.ts_flag_dismiss(%L, 'zz-fd-s4', 'job_place') r) s$q$, id4, sentinel, d1), 'true/true');
  perform pg_temp.ts_v('F2 marks s52, a day row in Distro/Trim whose person is now in Packaging', 'authenticated', adm,
    pg_temp.ts_v_dis(d5, 'zz-fd-s52', 'job_place', 'packing that day'),
    pg_temp.ts_v_lit('zz-fd-s52 / Distro Packager / {"at": "in", "how": "named", "site": "Slane"} / packing that day / ' || adm || ' / (active)'));
  id52 := pg_temp.ts_v_active(d5, 'zz-fd-s52');
  perform pg_temp.ts_v('F3 cannot mark a Packaging day (s22)', 'authenticated', adm, pg_temp.ts_v_dis(d2, 'zz-fd-s22', 'job_place', null), no_day);
  perform pg_temp.ts_v('F4 cannot mark a New York day', 'authenticated', adm, pg_temp.ts_v_dis(dn, 'zz-fd-sn1', 'job_place', null), no_day);
  perform pg_temp.ts_v('F5 sees the checks of the people whose days they see, and no one else''s', 'authenticated', adm, vis,
    'zz-fd-1,zz-fd-4,zz-fd-5');
  perform pg_temp.ts_v('F6 undoes the admin''s check of s4', 'authenticated', adm, pg_temp.ts_v_undo(id4),
    pg_temp.ts_v_lit('zz-fd-s4 / ' || adm || ' / true'));
  perform pg_temp.ts_v('F7 cannot undo a Packaging person''s (s21)', 'authenticated', adm, pg_temp.ts_v_undo(id21), no_row);
  perform pg_temp.ts_v('F8 cannot undo a New York one', 'authenticated', adm, pg_temp.ts_v_undo(idn), no_row);
  perform pg_temp.ts_v('F9 ... both are still active', null, null,
    format($q$select count(*)::text from public.ts_flag_dismissals where id in (%L, %L) and undone_at is null$q$, id21, idn), '2');

  -- ---------------------------------------------------------------- V. a manager with a view of one person (zz-fd-3)
  perform pg_temp.ts_v_me_set(false, true, '[]');
  perform pg_temp.ts_v_me_views('["zz-fd-v1"]');
  perform pg_temp.ts_v('V1 marks that person''s shift (s31)', 'authenticated', adm, pg_temp.ts_v_dis(d3, 'zz-fd-s31', 'job_place', null),
    pg_temp.ts_v_lit('zz-fd-s31 / Distro Packager / {"at": "in", "how": "named", "site": "Imperial"} / (no reason) / ' || adm || ' / (active)'));
  id3 := pg_temp.ts_v_active(d3, 'zz-fd-s31');
  perform pg_temp.ts_v('V2 cannot mark anyone else''s (zz-fd-1)', 'authenticated', adm, pg_temp.ts_v_dis(d1, 'zz-fd-s5', 'job_place', null), no_day);
  perform pg_temp.ts_v('V3 ... nor a colleague in the same department (zz-fd-2)', 'authenticated', adm, pg_temp.ts_v_dis(d2, 'zz-fd-s22', 'job_place', null), no_day);
  perform pg_temp.ts_v('V4 sees only that person''s', 'authenticated', adm, vis, 'zz-fd-3');
  perform pg_temp.ts_v('V5 undoes it ...', 'authenticated', adm, pg_temp.ts_v_undo(id3), pg_temp.ts_v_lit('zz-fd-s31 / ' || adm || ' / true'));
  perform pg_temp.ts_v('V6 ... and marks it again', 'authenticated', adm,
    format($q$select (r->>'id' <> %L)::text from (select public.ts_flag_dismiss(%L, 'zz-fd-s31', 'job_place') r) s$q$, id3, d3), 'true');
  perform pg_temp.ts_v('V7 cannot undo anyone else''s', 'authenticated', adm, pg_temp.ts_v_undo(id21), no_row);
  perform pg_temp.ts_v_me_views('[]');

  -- ---------------------------------------------------------------- P. a manager of the other department (zz_fd_a / Packaging)
  perform pg_temp.ts_v_me_set(false, true, '[{"company":"zz_fd_a","department":"Packaging"}]');
  perform pg_temp.ts_v('P1 sees Packaging''s checks, not zz-fd-5''s: its day row is in Distro/Trim, though the person is now in Packaging', 'authenticated', adm, vis,
    'zz-fd-2,zz-fd-3');
  perform pg_temp.ts_v('P2 cannot mark zz-fd-5''s day: the day row is in Distro/Trim', 'authenticated', adm, pg_temp.ts_v_dis(d5, 'zz-fd-s52', 'job_place', null), no_day);
  perform pg_temp.ts_v('P3 ... nor undo zz-fd-5''s check', 'authenticated', adm, pg_temp.ts_v_undo(id52), no_row);
  perform pg_temp.ts_v('P3b ... which is still active', null, null,
    format($q$select count(*)::text from public.ts_flag_dismissals where id = %L and undone_at is null$q$, id52), '1');
  perform pg_temp.ts_v('P4 marks a Packaging shift (s22)', 'authenticated', adm, pg_temp.ts_v_dis(d2, 'zz-fd-s22', 'job_place', null),
    pg_temp.ts_v_lit('zz-fd-s22 / Distro Packager / {"at": "in", "how": "named", "site": "Slane"} / (no reason) / ' || adm || ' / (active)'));
  perform pg_temp.ts_v('P5 cannot undo a Distro/Trim one (s2)', 'authenticated', adm,
    pg_temp.ts_v_undo(pg_temp.ts_v_active(d1, 'zz-fd-s2')), no_row);

  -- ---------------------------------------------------------------- W. a ('*', '*') manager: every CA company
  perform pg_temp.ts_v_me_set(false, true, '[{"company":"*","department":"*"}]');
  perform pg_temp.ts_v('W1 marks any CA shift (s23)', 'authenticated', adm, pg_temp.ts_v_dis(d2, 'zz-fd-s23', 'job_place', null),
    pg_temp.ts_v_lit('zz-fd-s23 / Distro Packager / {"at": "in", "how": "named", "site": "Slane"} / (no reason) / ' || adm || ' / (active)'));
  perform pg_temp.ts_v('W2 cannot mark a New York day ("*" is California only)', 'authenticated', adm,
    pg_temp.ts_v_dis(dn, 'zz-fd-sn1', 'job_place', null), no_day);
  perform pg_temp.ts_v('W3 sees every CA check, not New York''s', 'authenticated', adm, vis, 'zz-fd-1,zz-fd-2,zz-fd-3,zz-fd-4,zz-fd-5');
  perform pg_temp.ts_v('W4 cannot undo the New York one', 'authenticated', adm, pg_temp.ts_v_undo(idn), no_row);

  -- ---------------------------------------------------------------- X. the admin again
  perform pg_temp.ts_v_me_set(true, true, '[]');
  perform pg_temp.ts_v('X1 the admin sees every check', 'authenticated', adm, vis, 'zz-fd-1,zz-fd-2,zz-fd-3,zz-fd-4,zz-fd-5,zz-fd-n1');
  perform pg_temp.ts_v('X2 the admin undoes the New York one', 'authenticated', adm, pg_temp.ts_v_undo(idn),
    pg_temp.ts_v_lit('zz-fd-sn1 / ' || adm || ' / true'));

  -- ---------------------------------------------------------------- G. the select policy is the reference rule, row for row
  for cfg in
    select * from (values
      (1, 'an admin', true, true, '[]'::jsonb, '[]'::jsonb),
      (2, 'a Distro/Trim manager', false, true, '[{"company":"zz_fd_a","department":"Distro/Trim"}]', '[]'),
      (3, 'a Packaging manager', false, true, '[{"company":"zz_fd_a","department":"Packaging"}]', '[]'),
      (4, 'a manager with a view of one person', false, true, '[]', '["zz-fd-v1"]'),
      (5, 'a (*, *) manager', false, true, '[{"company":"*","department":"*"}]', '[]'),
      (6, 'a manager of a New York department', false, true, '[{"company":"zz_fd_n","department":"Distro Hourly"}]', '[]'),
      (7, 'an inactive admin', true, false, '[]', '[]'),
      (8, 'an inactive (*, *) manager with a view of one person', false, false, '[{"company":"*","department":"*"}]',
       '["zz-fd-v1"]')) c(n, label, is_admin, active, grants, views)
    order by n
  loop
    perform pg_temp.ts_v_me_set(cfg.is_admin, cfg.active, cfg.grants);
    perform pg_temp.ts_v_me_views(cfg.views);
    perform pg_temp.ts_v('G' || cfg.n || ' ' || cfg.label || ': what the policy shows is what ts_flag_can_see allows, row for row',
      'authenticated', adm, ids, pg_temp.ts_v_lit(pg_temp.ts_v_as('claims', adm, ref)));
    if not cfg.active then
      -- stated outright, not only as the reference rule's answer: an inactive sign-in sees no check and undoes none
      perform pg_temp.ts_v('G' || cfg.n || 'b ... which is none', 'authenticated', adm, ids, '(none)');
      perform pg_temp.ts_v('G' || cfg.n || 'c ... and it cannot undo one (s21''s, active)', 'authenticated', adm,
        pg_temp.ts_v_undo(id21), no_in);
    end if;
  end loop;
  perform pg_temp.ts_v('G9 (and the rows compared are not none: the admin sees them all)', null, null,
    $q$select (count(*) >= 10)::text from public.ts_flag_dismissals where employee_uuid like 'zz-fd-%'$q$, 'true');
  perform pg_temp.ts_v('G10 ... and s21''s check is still active', null, null,
    format($q$select count(*)::text from public.ts_flag_dismissals where id = %L and undone_at is null$q$, id21), '1');
  perform pg_temp.ts_v_me_views('[]');
  perform pg_temp.ts_v_me_set(true, true, '[]');

  -- ---------------------------------------------------------------- H. nobody writes the table directly
  select count(*) into v_n from public.ts_flag_dismissals;
  perform pg_temp.ts_v('H1 the admin cannot insert a row directly', 'authenticated', adm,
    format($q$insert into public.ts_flag_dismissals (day_id, company, employee_uuid, work_date, shift_id, code, dismissed_by)
              values (%L, 'zz_fd_a', 'zz-fd-1', %L::date, 'zz-fd-s3', 'job_place', %L) returning id::text$q$, d1, t, adm), denied);
  perform pg_temp.ts_v('H2 ... nor update one', 'authenticated', adm,
    $q$update public.ts_flag_dismissals set reason = 'changed' where employee_uuid like 'zz-fd-%' returning id::text$q$, denied);
  perform pg_temp.ts_v('H3 ... nor delete one', 'authenticated', adm,
    $q$delete from public.ts_flag_dismissals where employee_uuid like 'zz-fd-%' returning id::text$q$, denied);
  perform pg_temp.ts_v_me_set(false, true, '[{"company":"*","department":"*"}]');
  perform pg_temp.ts_v('H4 a manager cannot update one either', 'authenticated', adm,
    $q$update public.ts_flag_dismissals set undone_by = 'x', undone_at = now() where employee_uuid like 'zz-fd-%' returning id::text$q$, denied);
  perform pg_temp.ts_v_me_set(true, true, '[]');
  perform pg_temp.ts_v('H5 ... and nothing changed', null, null,
    format($q$select (count(*) = %s and count(*) filter (where reason = 'changed') = 0)::text from public.ts_flag_dismissals$q$, v_n), 'true');
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
