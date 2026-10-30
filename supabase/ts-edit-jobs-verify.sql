-- Verification for supabase/ts-edit-jobs.sql (Manager Timesheets: each shift's Gusto job, and a manager picks another
-- of the person's jobs).
--
-- One transaction that ROLLS BACK, in the harness of supabase/ts-pay-periods-verify.sql: throwaway companies 'zz_jb_a'
-- (the edits) and 'zz_jb_s' (the sync of people's jobs), both CA, synthetic people "Test Person zz-jb-...", made-up job
-- ids 'zz-jb-job-...', day rows dated relative to TODAY (inside the edit window), and a throwaway sync key. It plays each
-- identity, records what each can do, returns one pass/fail table and undoes everything. Run it with write access as the
-- project owner (SQL editor, or the management API without read_only) after ts-edit-jobs.sql; the last result set is the
-- pass/fail table. Every row must say pass = true.
--
-- Identities: admin = gianni@ (Google, an active admin row); automation@ (password) with the sync key in the
-- x-ts-sync-key header (the timesheet sync and the edit worker).
--
-- The synthetic days (T = today in Los Angeles - 2) and their shifts:
--   d1  zz-jb-1  T    s1 8 AM to noon, job zz-jb-job-1 (as the sync writes it: {id, title, src})
--                     s2 1 to 5 PM, no job
--                     s3 8 to 9 PM, a job known only by its title (id null)
--   d2  zz-jb-2  T    s5 8 AM to noon, job zz-jb-job-7: a person whose jobs are not loaded (ts_people.jobs null)
--   d3  zz-jb-1  T-1  s4 8 AM to noon, job zz-jb-job-1: a job change that reaches Gusto before the next sync
-- zz-jb-1's jobs: zz-jb-job-1 Distro Packager (primary), zz-jb-job-2 Deleaf/Harvest (no start), zz-jb-job-4 with no
-- title, zz-jb-job-5 starting on T, zz-jb-job-3 starting on T+1.

begin;

create temp table ts_v_results (
  seq serial primary key,
  test text not null,
  expected text not null,      -- a LIKE pattern (escape '!'); plain text means equal
  got text
) on commit drop;

-- Run p_sql as an identity and return its single value as text, or 'ERROR <sqlstate>: <message>'
-- (as in ts-edits-clear-verify.sql)
create function pg_temp.ts_v_as(p_role text, p_email text, p_sql text) returns text
language plpgsql as $f$
declare v_me text := current_user; v_sub text; v_claims text := ''; v_out text; v_amr text;
begin
  if p_role = 'authenticated' then
    select u.id::text into v_sub from auth.users u where lower(u.email) = lower(p_email) and u.email_confirmed_at is not null limit 1;
    if v_sub is null then raise exception 'verify needs a confirmed auth.users row for %', p_email; end if;
    v_amr := case when lower(p_email) = 'automation@wizardtrees.com' then 'password' else 'oauth' end;
    v_claims := jsonb_build_object('sub', v_sub, 'role', 'authenticated', 'aal', 'aal1',
                  'amr', jsonb_build_array(jsonb_build_object('method', v_amr, 'timestamp', extract(epoch from now())::bigint)))::text;
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

create function pg_temp.ts_v(p_test text, p_role text, p_email text, p_sql text, p_expected text) returns void
language sql as $f$
  insert into pg_temp.ts_v_results (test, expected, got)
  values (p_test, coalesce(p_expected, '(null)'), pg_temp.ts_v_as(p_role, p_email, p_sql));
$f$;

create function pg_temp.ts_v_lit(p text) returns text
language sql immutable as $f$ select replace(replace(replace(p, '!', '!!'), '%', '!%'), '_', '!_') $f$;

create function pg_temp.ts_v_iso(p_d date, p_hm text, p_tz text) returns text
language plpgsql as $f$
declare v_old text := current_setting('TimeZone'); v text;
begin
  perform set_config('TimeZone', p_tz, true);
  v := to_char((p_d + p_hm::time) at time zone p_tz, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM');
  perform set_config('TimeZone', v_old, true);
  return v;
end $f$;

-- a ts_days shift as the sync writes it (Pacific), with no breaks; p_job null = no job key
create function pg_temp.ts_v_shift(p_id text, p_d date, p_in text, p_out text, p_job jsonb) returns jsonb
language sql as $f$
  select jsonb_build_object('id', p_id, 'in', pg_temp.ts_v_iso(p_d, p_in, 'America/Los_Angeles'),
           'out', pg_temp.ts_v_iso(p_d, p_out, 'America/Los_Angeles'), 'span_min', 0, 'worked_min', 0,
           'hours_only', false, 'breaks', '[]'::jsonb)
         || case when p_job is null then '{}'::jsonb else jsonb_build_object('job', p_job) end
$f$;
-- one synthetic day row (Distro/Trim), last synced an hour ago; returns its id
create function pg_temp.ts_v_day(p_company text, p_uuid text, p_d date, p_shifts jsonb) returns text
language sql as $f$
  insert into public.ts_days (id, company, region, employee_uuid, employee_name, department, work_date, first_in, last_out, shifts, "open", synced_at)
  values (p_company || ':' || p_uuid || ':' || to_char(p_d, 'YYYY-MM-DD'), p_company, 'CA', p_uuid, 'Test Person ' || p_uuid,
          'Distro/Trim', p_d, (p_shifts->0->>'in')::timestamptz, (p_shifts->-1->>'out')::timestamptz, p_shifts, false, now() - interval '1 hour')
  returning id
$f$;
-- an edit's after as the page sends it, no breaks; p_job null = no job key ('null'::jsonb sends "job": null)
create function pg_temp.ts_v_after(p_d date, p_in text, p_out text, p_job jsonb) returns jsonb
language sql as $f$
  select jsonb_build_object('in', pg_temp.ts_v_iso(p_d, p_in, 'America/Los_Angeles'), 'out', pg_temp.ts_v_iso(p_d, p_out, 'America/Los_Angeles'),
                            'breaks', '[]'::jsonb)
         || case when p_job is null then '{}'::jsonb else jsonb_build_object('job', p_job) end
$f$;
-- submit as SQL text, returning 'action/times_status/breaks_status'
create function pg_temp.ts_v_sub(p_day text, p_shift text, p_action text, p_after jsonb, p_note text) returns text
language sql immutable as $f$
  select format($q$select (r->>'action') || '/' || (r->>'times_status') || '/' || (r->>'breaks_status') from (select public.ts_edit_submit(%L, %L, %L, %L::jsonb, %L) r) s$q$,
                p_day, p_shift, p_action, p_after::text, p_note)
$f$;
-- worker mark as SQL text, returning 'status/error/applied_at is set' for that part
create function pg_temp.ts_v_mark(p_id uuid, p_part text, p_status text, p_error text) returns text
language sql immutable as $f$
  select format($q$select (r->>(%L || '_status')) || '/' || coalesce(r->>(%L || '_error'), '(none)') || '/' || (r->>(%L || '_applied_at') is not null) from (select public.ts_edit_mark(%L::uuid, %L, %L, %L) r) s$q$,
                p_part, p_part, p_part, p_id, p_part, p_status, p_error)
$f$;
-- (owner) the edit saved with this reason, its 'times/breaks/cancelled_by', and its 'before job > after job'
create function pg_temp.ts_v_id(p_note text) returns uuid
language sql as $f$ select e.id from public.ts_edits e where e.note = p_note $f$;
create function pg_temp.ts_v_st(p_note text) returns text
language sql as $f$
  select coalesce(string_agg(e.times_status || '/' || e.breaks_status || '/' || coalesce(e.cancelled_by, '(none)'), ','), '(no edit)')
    from public.ts_edits e where e.note = p_note
$f$;
create function pg_temp.ts_v_jobs(p_note text) returns text
language sql as $f$
  select coalesce(string_agg(coalesce((e.before->'job')::text, 'none') || ' > ' || coalesce((e.after->'job')::text, 'none'), ','), '(no edit)')
    from public.ts_edits e where e.note = p_note
$f$;
-- the timesheet sync of 'zz_jb_s' as SQL text, returning 'people/deactivated'
create function pg_temp.ts_v_sync(p_days jsonb, p_people jsonb) returns text
language sql immutable as $f$
  select format($q$select (r->>'people') || '/' || (r->>'deactivated') from (select public.ts_sync('zz_jb_s', '2001-03-01', '2001-03-31', %L::jsonb, %L::jsonb, '{}') r) s$q$,
                p_days::text, p_people::text)
$f$;

-- ------------------------------------------------------------------ setup (as owner, rolled back)
insert into public.ts_access (email, is_admin, active, note) values ('gianni@wizardtrees.com', true, true, 'owner')
on conflict (email) do update set is_admin = true, active = true;
insert into public.ts_companies (key, name, region) values ('zz_jb_a', 'Verify Jobs A', 'CA'), ('zz_jb_s', 'Verify Jobs Sync', 'CA')
on conflict do nothing;
insert into public.ts_sync_keys (key_hash, label) values (encode(sha256(convert_to('zz-jb-sync-key', 'utf8')), 'hex'), 'verify jobs (rolled back)');
select set_config('request.headers', '', true);

do $v$
declare
  adm  constant text := 'gianni@wizardtrees.com';
  aut  constant text := 'automation@wizardtrees.com';
  la   constant text := 'America/Los_Angeles';
  t    constant date := (now() at time zone 'America/Los_Angeles')::date - 2;
  key_on constant text := '{"x-ts-sync-key": "zz-jb-sync-key"}';
  d1 text; d2 text; d3 text;
  job1 constant jsonb := '{"id": "zz-jb-job-1", "title": "Distro Packager", "src": "csv"}';
  -- the jobs as the edits store them
  j1 constant text := '{"id": "zz-jb-job-1", "title": "Distro Packager"}';
  j2 constant text := '{"id": "zz-jb-job-2", "title": "Deleaf/Harvest"}';
  j4 constant text := '{"id": "zz-jb-job-4", "title": ""}';
  j5 constant text := '{"id": "zz-jb-job-5", "title": "Deleaf/Harvest - Site One"}';
  j7 constant text := '{"id": "zz-jb-job-7", "title": "Packer"}';
  nothing     constant text := 'ERROR P0001: Nothing changed: the shift already has these times and breaks';
  not_one     constant text := 'ERROR P0001: That job is not one of this person''s jobs in Gusto.';
  not_loaded  constant text := 'ERROR P0001: This person''s Gusto jobs are not loaded yet, so the job can''t be changed here.';
  starts_late constant text := 'ERROR P0001: That job starts on ' || to_char(t + 1, 'Mon FMDD') || ' in Gusto, after this day.';
  bad_jobs    constant text := pg_temp.ts_v_lit('ERROR P0001: Bad jobs for zz_jb_s: zz-jb-p1 (a list of {id, title, primary, start})');
  -- a person's jobs as the sync sends them (with two keys a Gusto job also has, which must not be kept), and as stored
  p1_sent constant jsonb := '[{"id": "zz-jb-job-11", "title": "Distro Packager", "primary": true, "start": "2026-01-05", "rate": "zz-not-kept", "compensations": [{"uuid": "zz-not-kept"}]},
                              {"id": "zz-jb-job-12", "title": "", "primary": false, "start": null},
                              {"id": "zz-jb-job-13", "title": "Deleaf/Harvest", "primary": false}]';
  p1_kept constant jsonb := '[{"id": "zz-jb-job-11", "title": "Distro Packager", "primary": true, "start": "2026-01-05"},
                              {"id": "zz-jb-job-12", "title": "", "primary": false, "start": null},
                              {"id": "zz-jb-job-13", "title": "Deleaf/Harvest", "primary": false, "start": null}]';
  p2_jobs constant jsonb := '[{"id": "zz-jb-job-21", "title": "Packer", "primary": true, "start": "2026-02-01"}]';
  v_lbl text; v_bad jsonb;
begin
  -- ---------------------------------------------------------------- fixtures (as owner)
  insert into public.ts_people (company, employee_uuid, name, department, job_title, jobs) values
    ('zz_jb_a', 'zz-jb-1', 'Test Person zz-jb-1', 'Distro/Trim', 'Distro Packager', jsonb_build_array(
       jsonb_build_object('id', 'zz-jb-job-1', 'title', 'Distro Packager', 'primary', true, 'start', t - 60),
       jsonb_build_object('id', 'zz-jb-job-2', 'title', 'Deleaf/Harvest', 'primary', false, 'start', null),
       jsonb_build_object('id', 'zz-jb-job-4', 'title', '', 'primary', false, 'start', t - 60),
       jsonb_build_object('id', 'zz-jb-job-5', 'title', 'Deleaf/Harvest - Site One', 'primary', false, 'start', t),
       jsonb_build_object('id', 'zz-jb-job-3', 'title', 'Deleaf/Harvest - Site Two', 'primary', false, 'start', t + 1))),
    ('zz_jb_a', 'zz-jb-2', 'Test Person zz-jb-2', 'Distro/Trim', 'Packer', null);
  d1 := pg_temp.ts_v_day('zz_jb_a', 'zz-jb-1', t, jsonb_build_array(
          pg_temp.ts_v_shift('zz-jb-s1', t, '08:00', '12:00', job1),
          pg_temp.ts_v_shift('zz-jb-s2', t, '13:00', '17:00', null),
          pg_temp.ts_v_shift('zz-jb-s3', t, '20:00', '21:00', '{"id": null, "title": "Old title", "src": "csv"}')));
  d2 := pg_temp.ts_v_day('zz_jb_a', 'zz-jb-2', t, jsonb_build_array(
          pg_temp.ts_v_shift('zz-jb-s5', t, '08:00', '12:00', '{"id": "zz-jb-job-7", "title": "Packer", "src": "only"}')));
  d3 := pg_temp.ts_v_day('zz_jb_a', 'zz-jb-1', t - 1, jsonb_build_array(pg_temp.ts_v_shift('zz-jb-s4', t - 1, '08:00', '12:00', job1)));
  perform set_config('request.headers', key_on, true);

  -- ---------------------------------------------------------------- A. structure and helpers
  perform pg_temp.ts_v('A1 ts_people has jobs (jsonb), readable through its SELECT grant', null, null,
    $q$select format_type(a.atttypid, a.atttypmod) || '/' || has_column_privilege('authenticated', 'public.ts_people', 'jobs', 'SELECT')
         from pg_attribute a where a.attrelid = 'public.ts_people'::regclass and a.attname = 'jobs' and not a.attisdropped$q$, 'jsonb/true');
  perform pg_temp.ts_v('A2 its check refuses anything but a list or null, even for the owner', null, null,
    $q$update public.ts_people set jobs = '{"id": "zz-jb-job-7"}' where company = 'zz_jb_a' and employee_uuid = 'zz-jb-2' returning employee_uuid$q$, 'ERROR 23514%');
  perform pg_temp.ts_v('A3 no new function: ts_sync and ts_edit_submit keep one signature each, the shape and key helpers stay internal', null, null,
    $q$select count(*) filter (where p.proname = 'ts_sync') || '/' || count(*) filter (where p.proname = 'ts_edit_submit') || '/'
              || count(*) filter (where p.proname in ('ts_edit_shape', 'ts_edit_key')) || '/'
              || count(*) filter (where p.proname in ('ts_edit_shape', 'ts_edit_key') and has_function_privilege('authenticated', p.oid, 'EXECUTE')) || '/'
              || count(*) filter (where p.proname like '%job%')
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'ts\_%'$q$, '1/1/2/0/0');
  -- (A6 in ts-ca-timesheets-verify.sql runs this query and expects the list without ts_pay_periods_sync, so it fails
  -- once ts-pay-periods.sql is applied, before and after this file; this check passes when that is the one difference)
  perform pg_temp.ts_v('A3b what ts-ca-timesheets-verify.sql A6 sees: its own list, plus ts_pay_periods_sync when ts-pay-periods.sql is applied', null, null,
    $q$select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'ts\_%' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
          and p.proname not in ('ts_admin_save_view', 'ts_admin_delete_view', 'ts_admin_set_user_views', 'ts_my_view_ids',
                                'ts_edit_submit', 'ts_edit_cancel', 'ts_edits_pending', 'ts_edit_mark', 'ts_edit_clear', 'ts_edits_to_recheck')$q$,
    pg_temp.ts_v_lit('ts_admin_delete_user,ts_admin_list,ts_admin_save_user,ts_is_admin,ts_me,ts_my_email,ts_my_grant_keys,'
                  || case when to_regprocedure('public.ts_pay_periods_sync(text,jsonb)') is not null then 'ts_pay_periods_sync,' else '' end
                  || 'ts_sync'));
  perform pg_temp.ts_v('A4 all four are security definer with search_path=public', null, null,
    $q$select count(*) filter (where p.prosecdef and coalesce(array_to_string(p.proconfig, ',') like '%search_path=public%', false)) || '/' || count(*)
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
          and p.proname in ('ts_sync', 'ts_edit_shape', 'ts_edit_key', 'ts_edit_submit')$q$, '4/4');
  perform pg_temp.ts_v('A5 the shape of a shift with a job carries its id and title, nothing else of it', null, null,
    format($q$select (public.ts_edit_shape(%L::jsonb, %L)->'job')::text$q$, pg_temp.ts_v_shift('x', t, '08:00', '12:00', job1), la), j1);
  perform pg_temp.ts_v('A6 no job key for a shift with no job, a job known only by its title, or a blank id', null, null,
    format($q$select (public.ts_edit_shape(%L::jsonb, %L) ? 'job') || '/' || (public.ts_edit_shape(%L::jsonb, %L) ? 'job') || '/' || (public.ts_edit_shape(%L::jsonb, %L) ? 'job')$q$,
           pg_temp.ts_v_shift('x', t, '08:00', '12:00', null), la,
           pg_temp.ts_v_shift('x', t, '08:00', '12:00', '{"id": null, "title": "Old title"}'), la,
           pg_temp.ts_v_shift('x', t, '08:00', '12:00', '{"id": "", "title": "Old title"}'), la), 'false/false/false');
  perform pg_temp.ts_v('A7 a job with an id and no title gets the title ''''', null, null,
    format($q$select (public.ts_edit_shape(%L::jsonb, %L)->'job')::text$q$, pg_temp.ts_v_shift('x', t, '08:00', '12:00', '{"id": "zz-jb-job-4"}'), la), j4);
  perform pg_temp.ts_v('A8 the times key carries the job''s id after [in, out]; without a job it is the key it always was', null, null,
    format($q$select (public.ts_edit_key(s, 'times') = public.ts_edit_key(s - 'job', 'times') || '["zz-jb-job-1"]'::jsonb) || '/' || jsonb_array_length(public.ts_edit_key(s - 'job', 'times'))
                     || '/' || (public.ts_edit_key(s, 'breaks') = public.ts_edit_key(s - 'job', 'breaks'))
                from (select public.ts_edit_shape(%L::jsonb, %L) s) x$q$, pg_temp.ts_v_shift('x', t, '08:00', '12:00', job1), la), 'true/2/true');

  -- ---------------------------------------------------------------- P. the timesheet sync stores people's jobs (automation@ + key)
  perform pg_temp.ts_v('P1 a sync with each person''s jobs', 'authenticated', aut,
    pg_temp.ts_v_sync('[]', jsonb_build_array(
      jsonb_build_object('employee_uuid', 'zz-jb-p1', 'name', 'Test Person zz-jb-p1', 'department', 'Distro/Trim', 'job_title', 'Distro Packager', 'jobs', p1_sent),
      jsonb_build_object('employee_uuid', 'zz-jb-p2', 'name', 'Test Person zz-jb-p2'))), '2/0');
  perform pg_temp.ts_v('P2 ... stores a clean copy: exactly id, title, primary and start, in the order sent (start null when null or left out)', null, null,
    format($q$select (jobs = %L::jsonb)::text from public.ts_people where company = 'zz_jb_s' and employee_uuid = 'zz-jb-p1'$q$, p1_kept), 'true');
  perform pg_temp.ts_v('P3 ... and nothing else a Gusto job carries (no rate, no compensations)', null, null,
    $q$select (jobs::text not like '%rate%' and jobs::text not like '%compensation%' and jobs::text not like '%zz-not-kept%')::text
         from public.ts_people where company = 'zz_jb_s' and employee_uuid = 'zz-jb-p1'$q$, 'true');
  perform pg_temp.ts_v('P4 a person sent without jobs has none (null: not known)', null, null,
    $q$select coalesce(jobs::text, '(null)') from public.ts_people where company = 'zz_jb_s' and employee_uuid = 'zz-jb-p2'$q$, '(null)');
  perform pg_temp.ts_v('P5 an older producer (no jobs key) ...', 'authenticated', aut,
    pg_temp.ts_v_sync('[]', '[{"employee_uuid": "zz-jb-p1", "name": "Test Person zz-jb-p1", "department": "Distro/Trim", "job_title": "Packer"},
                              {"employee_uuid": "zz-jb-p2", "name": "Test Person zz-jb-p2"}]'), '2/0');
  perform pg_temp.ts_v('P6 ... keeps the stored jobs and still updates the rest of the row', null, null,
    format($q$select job_title || '/' || (jobs = %L::jsonb) from public.ts_people where company = 'zz_jb_s' and employee_uuid = 'zz-jb-p1'$q$, p1_kept), 'Packer/true');
  perform pg_temp.ts_v('P7 jobs null keeps them too', 'authenticated', aut,
    pg_temp.ts_v_sync('[]', '[{"employee_uuid": "zz-jb-p1", "name": "Test Person zz-jb-p1", "department": "Distro/Trim", "job_title": "Packer", "jobs": null},
                              {"employee_uuid": "zz-jb-p2", "name": "Test Person zz-jb-p2"}]'), '2/0');
  perform pg_temp.ts_v('P7b ... (still the same list)', null, null,
    format($q$select (jobs = %L::jsonb)::text from public.ts_people where company = 'zz_jb_s' and employee_uuid = 'zz-jb-p1'$q$, p1_kept), 'true');
  perform pg_temp.ts_v('P8 an empty list replaces them (no jobs in Gusto), and a new list is stored', 'authenticated', aut,
    pg_temp.ts_v_sync('[]', jsonb_build_array(
      jsonb_build_object('employee_uuid', 'zz-jb-p1', 'name', 'Test Person zz-jb-p1', 'department', 'Distro/Trim', 'job_title', 'Packer', 'jobs', '[]'::jsonb),
      jsonb_build_object('employee_uuid', 'zz-jb-p2', 'name', 'Test Person zz-jb-p2', 'jobs', p2_jobs))), '2/0');
  perform pg_temp.ts_v('P8b ... stored as sent', null, null,
    format($q$select (select jobs::text from public.ts_people where company = 'zz_jb_s' and employee_uuid = 'zz-jb-p1') || '/'
                  || (select (jobs = %L::jsonb)::text from public.ts_people where company = 'zz_jb_s' and employee_uuid = 'zz-jb-p2')$q$, p2_jobs), '[]/true');
  perform pg_temp.ts_v('P9 the roster rule is unchanged: a person missing from a full list is set inactive ...', 'authenticated', aut,
    pg_temp.ts_v_sync('[]', '[{"employee_uuid": "zz-jb-p1", "name": "Test Person zz-jb-p1", "department": "Distro/Trim", "job_title": "Packer"}]'), '1/1');
  perform pg_temp.ts_v('P9b ... and keeps their jobs', null, null,
    format($q$select active || '/' || (jobs = %L::jsonb) from public.ts_people where company = 'zz_jb_s' and employee_uuid = 'zz-jb-p2'$q$, p2_jobs), 'false/true');
  -- each bad list fails the whole sync (with a day row and a changed title in it, which must not land either)
  for v_lbl, v_bad in select * from (values
      ('not a list', '{"id": "zz-jb-job-11"}'::jsonb),
      ('text, not a list', '"zz-jb-job-11"'),
      ('a job that is not an object', '[5]'),
      ('no id', '[{"title": "Packer", "primary": true, "start": null}]'),
      ('a blank id', '[{"id": "", "title": "Packer", "primary": true, "start": null}]'),
      ('an id of 101 characters', jsonb_build_array(jsonb_build_object('id', repeat('x', 101), 'title', 'Packer', 'primary', true, 'start', null))),
      ('an id that is a number', '[{"id": 11, "title": "Packer", "primary": true, "start": null}]'),
      ('no title', '[{"id": "zz-jb-job-11", "primary": true, "start": null}]'),
      ('a null title', '[{"id": "zz-jb-job-11", "title": null, "primary": true, "start": null}]'),
      ('a title of 201 characters', jsonb_build_array(jsonb_build_object('id', 'zz-jb-job-11', 'title', repeat('x', 201), 'primary', true, 'start', null))),
      ('primary as text', '[{"id": "zz-jb-job-11", "title": "Packer", "primary": "yes", "start": null}]'),
      ('no primary', '[{"id": "zz-jb-job-11", "title": "Packer", "start": null}]'),
      ('a start that is not a date', '[{"id": "zz-jb-job-11", "title": "Packer", "primary": true, "start": "soon"}]'),
      ('a start that is no real day', '[{"id": "zz-jb-job-11", "title": "Packer", "primary": true, "start": "2026-02-30"}]'),
      ('a start with a time', '[{"id": "zz-jb-job-11", "title": "Packer", "primary": true, "start": "2026-10-26T08:00:00Z"}]'),
      ('a start that is a number', '[{"id": "zz-jb-job-11", "title": "Packer", "primary": true, "start": 20261026}]')) x(lbl, jobs) loop
    perform pg_temp.ts_v('P10 refused: ' || v_lbl, 'authenticated', aut,
      pg_temp.ts_v_sync('[{"id": "zz_jb_s:zz-jb-p1:2001-03-02", "employee_uuid": "zz-jb-p1", "employee_name": "Test Person zz-jb-p1", "work_date": "2001-03-02"}]',
        jsonb_build_array(jsonb_build_object('employee_uuid', 'zz-jb-p1', 'name', 'Test Person zz-jb-p1', 'department', 'Distro/Trim', 'job_title', 'zz-changed', 'jobs', v_bad))),
      bad_jobs);
  end loop;
  perform pg_temp.ts_v('P11 the refused syncs wrote nothing: no day row, the person''s title and jobs as they were', null, null,
    $q$select (select count(*) from public.ts_days where company = 'zz_jb_s') || '/'
              || (select job_title || '/' || jobs::text from public.ts_people where company = 'zz_jb_s' and employee_uuid = 'zz-jb-p1')$q$, '0/Packer/[]');

  -- ---------------------------------------------------------------- E. a manager picks a job (admin, Google)
  perform pg_temp.ts_v('E1 the shift''s own job with its own times, nothing waiting: Nothing changed', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-jb-s1', 'update', pg_temp.ts_v_after(t, '08:00', '12:00', '{"id": "zz-jb-job-1"}'), 'zz-jb E1'), nothing);
  perform pg_temp.ts_v('E2 a change of the job alone is a change, and it rides the times part', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-jb-s1', 'update', pg_temp.ts_v_after(t, '08:00', '12:00', '{"id": "zz-jb-job-2", "title": "Made up", "rate": "zz-not-kept"}'), 'zz-jb E2'),
    'update/pending/none');
  perform pg_temp.ts_v('E3 ... before has the shift''s job from the day row, after the picked job with its title from ts_people (not the one sent)', null, null,
    $q$select pg_temp.ts_v_jobs('zz-jb E2')$q$, j1 || ' > ' || j2);
  perform pg_temp.ts_v('E4 ... after holds in, out, breaks and job, and its job only id and title', null, null,
    $q$select (select string_agg(k, ',' order by k) from jsonb_object_keys(after) k) || '/' || (select string_agg(k, ',' order by k) from jsonb_object_keys(after->'job') k)
         from public.ts_edits where note = 'zz-jb E2'$q$, 'breaks,in,job,out/id,title');
  perform pg_temp.ts_v('E5 ... the worker gets it in the times list, with its job, and not in the breaks list', 'authenticated', aut,
    $q$select count(*) filter (where x.k = 't' and e->'after'->'job'->>'id' = 'zz-jb-job-2') || '/' || count(*) filter (where x.k = 'b')
         from (select 't' k, public.ts_edits_pending('times') l union all select 'b', public.ts_edits_pending('breaks')) x
        cross join lateral jsonb_array_elements(x.l) e where e->>'note' = 'zz-jb E2'$q$, '1/0');
  perform pg_temp.ts_v('E6 a change sent with no job keeps the shift''s job, and replaces the waiting job change (so the page sends the job it wants)', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-jb-s1', 'update', pg_temp.ts_v_after(t, '08:00', '12:30', null), 'zz-jb E6'), 'update/pending/none');
  perform pg_temp.ts_v('E7 ... its after has the shift''s job, and E2 was replaced', null, null,
    $q$select pg_temp.ts_v_jobs('zz-jb E6') || '/' || pg_temp.ts_v_st('zz-jb E2')$q$, j1 || ' > ' || j1 || '/cancelled/none/superseded');
  perform pg_temp.ts_v('E8 "job": null is the same as no job', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-jb-s1', 'update', pg_temp.ts_v_after(t, '08:00', '12:15', 'null'), 'zz-jb E8'), 'update/pending/none');
  perform pg_temp.ts_v('E9 ... after has the shift''s job', null, null, $q$select pg_temp.ts_v_jobs('zz-jb E8')$q$, j1 || ' > ' || j1);
  perform pg_temp.ts_v('E10 Gusto''s times and job again while E8 waits: back to Gusto, none/none', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-jb-s1', 'update', pg_temp.ts_v_after(t, '08:00', '12:00', '{"id": "zz-jb-job-1"}'), 'zz-jb E10'), 'update/none/none');
  perform pg_temp.ts_v('E11 a job that starts on the day itself can be picked', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-jb-s1', 'update', pg_temp.ts_v_after(t, '08:00', '12:00', '{"id": "zz-jb-job-5"}'), 'zz-jb E11'), 'update/pending/none');
  perform pg_temp.ts_v('E11b ... stored with its title', null, null, $q$select pg_temp.ts_v_jobs('zz-jb E11')$q$, j1 || ' > ' || j5);
  perform pg_temp.ts_v('E12 a job that is not one of the person''s is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-jb-s1', 'update', pg_temp.ts_v_after(t, '08:00', '12:00', '{"id": "zz-jb-job-9"}'), 'zz-jb E12'), not_one);
  perform pg_temp.ts_v('E13 ... and so is a job given as text, not as {id}', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-jb-s1', 'update', pg_temp.ts_v_after(t, '08:00', '12:00', '"zz-jb-job-2"'), 'zz-jb E13'), not_one);
  perform pg_temp.ts_v('E14 ... and a job whose id is not text', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-jb-s1', 'update', pg_temp.ts_v_after(t, '08:00', '12:00', '{"id": 2}'), 'zz-jb E14'), not_one);
  perform pg_temp.ts_v('E15 a job that starts after the day is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-jb-s1', 'update', pg_temp.ts_v_after(t, '08:00', '12:00', '{"id": "zz-jb-job-3"}'), 'zz-jb E15'), starts_late);
  perform pg_temp.ts_v('E16 a person whose jobs are not loaded: picking a job is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d2, 'zz-jb-s5', 'update', pg_temp.ts_v_after(t, '08:00', '12:00', '{"id": "zz-jb-job-8"}'), 'zz-jb E16'), not_loaded);
  perform pg_temp.ts_v('E17 ... but sending the shift''s own job is the same as none, and the times can still change', 'authenticated', adm,
    pg_temp.ts_v_sub(d2, 'zz-jb-s5', 'update', pg_temp.ts_v_after(t, '08:00', '12:30', '{"id": "zz-jb-job-7"}'), 'zz-jb E17'), 'update/pending/none');
  perform pg_temp.ts_v('E17b ... and the shift keeps its job', null, null, $q$select pg_temp.ts_v_jobs('zz-jb E17')$q$, j7 || ' > ' || j7);
  perform pg_temp.ts_v('E18 the refused submits stored nothing, and E11 still waits', null, null,
    $q$select (select count(*) from public.ts_edits where note in ('zz-jb E1', 'zz-jb E12', 'zz-jb E13', 'zz-jb E14', 'zz-jb E15', 'zz-jb E16'))
              || '/' || pg_temp.ts_v_st('zz-jb E11')$q$, '0/pending/none/(none)');

  -- ---------------------------------------------------------------- B. shifts with no job, or a job known only by its title
  perform pg_temp.ts_v('B1 a times change of a shift with no job ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-jb-s2', 'update', pg_temp.ts_v_after(t, '13:00', '17:30', null), 'zz-jb B1'), 'update/pending/none');
  perform pg_temp.ts_v('B2 ... has no job in before or after, as before this file', null, null,
    $q$select (before ? 'job') || '/' || (after ? 'job') from public.ts_edits where note = 'zz-jb B1'$q$, 'false/false');
  perform pg_temp.ts_v('B3 picking a job for it (one with no title) with Gusto''s times is a change of the times part', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-jb-s2', 'update', pg_temp.ts_v_after(t, '13:00', '17:00', '{"id": "zz-jb-job-4"}'), 'zz-jb B3'), 'update/pending/none');
  perform pg_temp.ts_v('B4 ... stored with the blank title', null, null, $q$select pg_temp.ts_v_jobs('zz-jb B3')$q$, 'none > ' || j4);
  perform pg_temp.ts_v('B5 a shift whose job is known only by its title ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-jb-s3', 'update', pg_temp.ts_v_after(t, '20:00', '21:30', null), 'zz-jb B5'), 'update/pending/none');
  perform pg_temp.ts_v('B6 ... has no job in before or after either', null, null,
    $q$select (before ? 'job') || '/' || (after ? 'job') from public.ts_edits where note = 'zz-jb B5'$q$, 'false/false');

  -- ---------------------------------------------------------------- D. adding a shift with a job
  perform pg_temp.ts_v('D1 an add with a job (one with no title)', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, null, 'add', pg_temp.ts_v_after(t, '18:00', '19:00', '{"id": "zz-jb-job-4", "title": "Made up"}'), 'zz-jb D1'), 'add/pending/none');
  perform pg_temp.ts_v('D2 ... stored with that job and no before', null, null, $q$select pg_temp.ts_v_jobs('zz-jb D1')$q$, 'none > ' || j4);
  perform pg_temp.ts_v('D3 the same add with the same job again is the duplicate', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, null, 'add', pg_temp.ts_v_after(t, '18:00', '19:00', '{"id": "zz-jb-job-4"}'), 'zz-jb D3'),
    'ERROR P0001: This shift is already waiting to be added');
  perform pg_temp.ts_v('D4 the same times with another job is not the same add, but it overlaps the first one', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, null, 'add', pg_temp.ts_v_after(t, '18:00', '19:00', '{"id": "zz-jb-job-2"}'), 'zz-jb D4'),
    'ERROR P0001: This shift overlaps the 6:00 PM to 7:00 PM shift');
  perform pg_temp.ts_v('D5 an add with no job leaves the job to the worker', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, null, 'add', pg_temp.ts_v_after(t, '17:15', '17:45', null), 'zz-jb D5'), 'add/pending/none');
  perform pg_temp.ts_v('D6 ... no job in its after', null, null, $q$select pg_temp.ts_v_jobs('zz-jb D5')$q$, 'none > none');
  perform pg_temp.ts_v('D7 an add with a job that starts after the day is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, null, 'add', pg_temp.ts_v_after(t, '21:30', '22:00', '{"id": "zz-jb-job-3"}'), 'zz-jb D7'), starts_late);
  perform pg_temp.ts_v('D8 an add with a job for a person whose jobs are not loaded is refused (even that person''s usual job)', 'authenticated', adm,
    pg_temp.ts_v_sub(d2, null, 'add', pg_temp.ts_v_after(t, '13:00', '14:00', '{"id": "zz-jb-job-7"}'), 'zz-jb D8'), not_loaded);
  perform pg_temp.ts_v('D9 the refused adds stored nothing', null, null,
    $q$select count(*) from public.ts_edits where note in ('zz-jb D3', 'zz-jb D4', 'zz-jb D7', 'zz-jb D8')$q$, '0');

  -- ---------------------------------------------------------------- N. a note and a delete keep the job in before
  perform pg_temp.ts_v('N1 a note on a shift with a job', 'authenticated', adm,
    format($q$select (r->>'action') || '/' || (r->>'times_status') || '/' || (r->>'breaks_status') from (select public.ts_edit_submit(%L, 'zz-jb-s1', 'note', null, 'zz-jb N1') r) s$q$, d1),
    'note/none/pending');
  perform pg_temp.ts_v('N2 ... its before has the job', null, null, $q$select pg_temp.ts_v_jobs('zz-jb N1')$q$, j1 || ' > none');
  perform pg_temp.ts_v('N3 deleting a shift with a job', 'authenticated', adm,
    pg_temp.ts_v_sub(d2, 'zz-jb-s5', 'delete', null, 'zz-jb N3'), 'delete/none/pending');
  perform pg_temp.ts_v('N4 ... its before has the job too', null, null, $q$select pg_temp.ts_v_jobs('zz-jb N3')$q$, j7 || ' > none');

  -- ---------------------------------------------------------------- O. a job change that reached Gusto before the next sync
  -- (the day row still shows the old job: what Gusto has is the applied edit's job)
  perform pg_temp.ts_v('O1 (admin) moves d3''s shift to another job', 'authenticated', adm,
    pg_temp.ts_v_sub(d3, 'zz-jb-s4', 'update', pg_temp.ts_v_after(t - 1, '08:00', '12:00', '{"id": "zz-jb-job-2"}'), 'zz-jb O1'), 'update/pending/none');
  perform pg_temp.ts_v('O2 (worker) claims its times part ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-jb O1'), 'times', 'applying', null), 'applying/(none)/false');
  perform pg_temp.ts_v('O3 ... and applies it', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-jb O1'), 'times', 'applied', null), 'applied/(none)/true');
  perform pg_temp.ts_v('O4 before the next sync, a times change with no job ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d3, 'zz-jb-s4', 'update', pg_temp.ts_v_after(t - 1, '08:00', '12:30', null), 'zz-jb O4'), 'update/pending/none');
  perform pg_temp.ts_v('O5 ... has the job Gusto has now (the applied one) in before, and keeps it', null, null,
    $q$select pg_temp.ts_v_jobs('zz-jb O4')$q$, j2 || ' > ' || j2);
  perform pg_temp.ts_v('O6 the first job again with Gusto''s times is a change, since Gusto has the applied one', 'authenticated', adm,
    pg_temp.ts_v_sub(d3, 'zz-jb-s4', 'update', pg_temp.ts_v_after(t - 1, '08:00', '12:00', '{"id": "zz-jb-job-1"}'), 'zz-jb O6'), 'update/pending/none');
  perform pg_temp.ts_v('O7 ... stored as a change from the applied job, and O4 was replaced', null, null,
    $q$select pg_temp.ts_v_jobs('zz-jb O6') || '/' || pg_temp.ts_v_st('zz-jb O4')$q$, j2 || ' > ' || j1 || '/cancelled/none/superseded');
  perform set_config('request.headers', '', true);
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
