-- Verification for supabase/ts-edit-start-waits.sql (Manager Timesheets: a change that moves only the start of a shift still
-- clocked in, which the edit worker sends once Gusto shows the clock-out; Gianni 2026-11-09: clock-in tap fix).
--
-- One transaction that ROLLS BACK, in the harness of supabase/ts-edits-verify.sql: a throwaway company 'zz_sw_a' (CA),
-- synthetic people "Test Person zz-sw-...", day rows two days back (T = today in Los Angeles - 2: always inside the edit
-- window, and every time in a check is in the past whatever time the script runs), a made-up job id 'zz-sw-job-1' and a
-- throwaway sync key. It plays each identity, records what each can do, returns one pass/fail table and undoes everything.
-- Run it with write access as the project owner (SQL editor, or the management API without read_only) after
-- ts-edit-start-waits.sql; the last result set is the pass/fail table. Every row must say pass = true.
--
-- Identities: admin = gianni@ (Google, an active admin row); automation@ (password) with the sync key in the x-ts-sync-key
-- header (the edit worker).
--
-- The synthetic days (all on T, Pacific; every row last synced an hour ago) and their shifts:
--   d1  zz-sw-1  c1 12:00 AM to 7:46:12 AM: the part Gusto carried past midnight from the day before (the tap ended it)
--                s1 8:02:38 AM, still clocked in, no breaks
--   d2  zz-sw-2  s2 8 AM to 4 PM: a shift that has ended
--   d3  zz-sw-3  s3 8 AM, still clocked in, a rest from 10:00 to 10:10
--   d4  zz-sw-4  s4 8:02 AM, still clocked in, on a meal that started at 12:00, job zz-sw-job-1
--   d5  zz-sw-5  s5a 7:50 to 7:58 AM (a tap in and out), s5 8:02 AM still clocked in
--   d6  zz-sw-6  s6 8:02 AM, still clocked in; its start alone reaches Gusto, and the row then shows the clock-out (5 PM)

begin;

create temp table ts_v_results (
  seq serial primary key,
  test text not null,
  expected text not null,      -- a LIKE pattern (escape '!'); plain text means equal
  got text
) on commit drop;

-- Run p_sql as an identity and return its single value as text, or 'ERROR <sqlstate>: <message>'
-- (as in ts-edit-jobs-verify.sql)
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

-- ---------------------------------------------------------------- time helpers (owner only, as in ts-edits-verify.sql)
-- A local clock time on a date in a zone (null stays null).
create function pg_temp.ts_v_at(p_d date, p_hm text, p_tz text) returns timestamptz
language sql stable as $f$
  select case when p_hm is null then null else (p_d + p_hm::time) at time zone p_tz end
$f$;

-- ISO text with the zone's own offset, worked out independently of ts_edit_iso: the session zone is
-- switched for one to_char call and switched back.
create function pg_temp.ts_v_iso(p_ts timestamptz, p_tz text) returns text
language plpgsql as $f$
declare v_old text := current_setting('TimeZone'); v text;
begin
  if p_ts is null then return null; end if;
  perform set_config('TimeZone', p_tz, true);
  v := to_char(p_ts, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM');
  perform set_config('TimeZone', v_old, true);
  return v;
end $f$;

-- UTC with milliseconds and 'Z', as a browser's toISOString() sends it (null stays null).
create function pg_temp.ts_v_z(p_ts timestamptz) returns text
language sql stable as $f$ select to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $f$;

-- An edit's after as the page sends it: UTC 'Z' times (p_out null = no end), breaks in the order given.
-- p_brks = [["10:00", "10:10", "rest"], ...] on day p_d (an end null = a break still running).
create function pg_temp.ts_v_after(p_d date, p_tz text, p_in text, p_out text, p_brks jsonb) returns jsonb
language sql stable as $f$
  select jsonb_build_object(
    'in',  pg_temp.ts_v_z(pg_temp.ts_v_at(p_d, p_in, p_tz)),
    'out', pg_temp.ts_v_z(pg_temp.ts_v_at(p_d, p_out, p_tz)),
    'breaks', coalesce((select jsonb_agg(jsonb_build_object(
                          'start', pg_temp.ts_v_z(pg_temp.ts_v_at(p_d, b->>0, p_tz)),
                          'end',   pg_temp.ts_v_z(pg_temp.ts_v_at(p_d, b->>1, p_tz)),
                          'kind',  b->2) order by o)
                          from jsonb_array_elements(p_brks) with ordinality t(b, o)), '[]'::jsonb))
$f$;

-- A ts_days shift as the sync writes it (p_out null = still clocked in), breaks as for ts_v_after.
create function pg_temp.ts_v_shift(p_id text, p_d date, p_tz text, p_in text, p_out text, p_brks jsonb) returns jsonb
language sql as $f$
  select jsonb_build_object(
    'id', p_id, 'in', pg_temp.ts_v_iso(pg_temp.ts_v_at(p_d, p_in, p_tz), p_tz),
    'out', pg_temp.ts_v_iso(pg_temp.ts_v_at(p_d, p_out, p_tz), p_tz),
    'span_min', 0, 'worked_min', 0, 'hours_only', false,
    'breaks', coalesce((select jsonb_agg(jsonb_build_object(
                          'start', pg_temp.ts_v_iso(pg_temp.ts_v_at(p_d, b->>0, p_tz), p_tz),
                          'end',   pg_temp.ts_v_iso(pg_temp.ts_v_at(p_d, b->>1, p_tz), p_tz),
                          'min', 0, 'kind', b->2, 'paid', b->>2 = 'rest', 'src', 'gusto', 'open', b->>1 is null) order by o)
                          from jsonb_array_elements(p_brks) with ordinality t(b, o)), '[]'::jsonb))
$f$;

-- One synthetic day row of 'zz_sw_a' (Distro/Trim), last synced an hour ago; returns its id.
create function pg_temp.ts_v_day(p_uuid text, p_d date, p_shifts jsonb) returns text
language sql as $f$
  insert into public.ts_days (id, company, region, employee_uuid, employee_name, department, work_date, first_in, last_out, shifts, "open", synced_at)
  values ('zz_sw_a:' || p_uuid || ':' || to_char(p_d, 'YYYY-MM-DD'), 'zz_sw_a', 'CA', p_uuid, 'Test Person ' || p_uuid,
          'Distro/Trim', p_d, (p_shifts->0->>'in')::timestamptz, (p_shifts->-1->>'out')::timestamptz, p_shifts,
          exists (select 1 from jsonb_array_elements(p_shifts) s where s->>'out' is null), now() - interval '1 hour')
  returning id
$f$;

-- ---------------------------------------------------------------- SQL builders
-- submit, returning 'action/times_status/breaks_status'
create function pg_temp.ts_v_sub(p_day text, p_shift text, p_action text, p_after jsonb, p_note text) returns text
language sql immutable as $f$
  select format($q$select (r->>'action') || '/' || (r->>'times_status') || '/' || (r->>'breaks_status') from (select public.ts_edit_submit(%L, %L, %L, %L::jsonb, %L) r) s$q$,
                p_day, p_shift, p_action, p_after::text, p_note)
$f$;
-- worker mark, returning 'status/error/applied_at is set' for that part
create function pg_temp.ts_v_mark(p_id uuid, p_part text, p_status text, p_error text) returns text
language sql immutable as $f$
  select format($q$select (r->>(%L || '_status')) || '/' || coalesce(r->>(%L || '_error'), '(none)') || '/' || (r->>(%L || '_applied_at') is not null) from (select public.ts_edit_mark(%L::uuid, %L, %L, %L) r) s$q$,
                p_part, p_part, p_part, p_id, p_part, p_status, p_error)
$f$;
-- (owner) the edit saved with this reason, and its 'times/breaks/cancelled_by'
create function pg_temp.ts_v_id(p_note text) returns uuid
language sql as $f$ select e.id from public.ts_edits e where e.note = p_note $f$;
create function pg_temp.ts_v_st(p_note text) returns text
language sql as $f$
  select coalesce(string_agg(e.times_status || '/' || e.breaks_status || '/' || coalesce(e.cancelled_by, '(none)'), ','), '(no edit)')
    from public.ts_edits e where e.note = p_note
$f$;

-- ------------------------------------------------------------------ setup (as owner, rolled back)
insert into public.ts_access (email, is_admin, active, note) values ('gianni@wizardtrees.com', true, true, 'owner')
on conflict (email) do update set is_admin = true, active = true;
insert into public.ts_companies (key, name, region) values ('zz_sw_a', 'Verify Start Waits', 'CA')
on conflict do nothing;
-- the sync key for this run (the worker RPCs check the x-ts-sync-key request header against its sha256)
insert into public.ts_sync_keys (key_hash, label) values (encode(sha256(convert_to('zz-sw-sync-key', 'utf8')), 'hex'), 'verify start waits (rolled back)');
select set_config('request.headers', '', true);

do $v$
declare
  adm    constant text := 'gianni@wizardtrees.com';
  aut    constant text := 'automation@wizardtrees.com';
  la     constant text := 'America/Los_Angeles';
  t      constant date := (now() at time zone 'America/Los_Angeles')::date - 2;
  key_on constant text := '{"x-ts-sync-key": "zz-sw-sync-key"}';
  job1   constant jsonb := '{"id": "zz-sw-job-1", "title": "Distro Packager", "src": "csv"}';
  alone  constant text := 'ERROR P0001: This shift is still clocked in: without an end only its start can change';
  d1 text; d2 text; d3 text; d4 text; d5 text; d6 text;
begin
  -- ---------------------------------------------------------------- fixtures (as owner)
  d1 := pg_temp.ts_v_day('zz-sw-1', t, jsonb_build_array(
          pg_temp.ts_v_shift('zz-sw-c1', t, la, '00:00:00', '07:46:12', '[]'),
          pg_temp.ts_v_shift('zz-sw-s1', t, la, '08:02:38', null, '[]')));
  d2 := pg_temp.ts_v_day('zz-sw-2', t, jsonb_build_array(pg_temp.ts_v_shift('zz-sw-s2', t, la, '08:00', '16:00', '[]')));
  d3 := pg_temp.ts_v_day('zz-sw-3', t, jsonb_build_array(pg_temp.ts_v_shift('zz-sw-s3', t, la, '08:00', null, '[["10:00","10:10","rest"]]')));
  d4 := pg_temp.ts_v_day('zz-sw-4', t, jsonb_build_array(
          pg_temp.ts_v_shift('zz-sw-s4', t, la, '08:02', null, '[["12:00",null,"meal"]]') || jsonb_build_object('job', job1)));
  d5 := pg_temp.ts_v_day('zz-sw-5', t, jsonb_build_array(
          pg_temp.ts_v_shift('zz-sw-s5a', t, la, '07:50', '07:58', '[]'),
          pg_temp.ts_v_shift('zz-sw-s5', t, la, '08:02', null, '[]')));
  d6 := pg_temp.ts_v_day('zz-sw-6', t, jsonb_build_array(pg_temp.ts_v_shift('zz-sw-s6', t, la, '08:02', null, '[]')));
  perform set_config('request.headers', key_on, true);

  -- ---------------------------------------------------------------- A. the function
  perform pg_temp.ts_v('A1 ts_edit_submit keeps its one signature: security definer, search_path=public, run by authenticated, not anon', null, null,
    $q$select count(*) || '/' || bool_and(p.prosecdef and coalesce(array_to_string(p.proconfig, ',') like '%search_path=public%', false))
              || '/' || bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
              || '/' || bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE'))
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'ts_edit_submit'$q$,
    '1/true/true/true');
  perform pg_temp.ts_v('A2 it is this file''s (it knows a start alone)', null, null,
    $q$select (pg_get_functiondef('public.ts_edit_submit(text,text,text,jsonb,text,jsonb)'::regprocedure) like '%v_start!_only%' escape '!')::text$q$, 'true');

  -- ---------------------------------------------------------------- S. a start alone (admin, Google)
  perform pg_temp.ts_v('S1 a start alone on a shift still clocked in, at the tap that ended the day before''s shift', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-sw-s1', 'update', pg_temp.ts_v_after(t, la, '07:46:12', null, '[]'), 'zz-sw S1'), 'update/pending/none');
  perform pg_temp.ts_v('S2 ... stored: after has the new start, no end and before''s breaks; before is the shift with no end', null, null,
    $q$select (after->>'in') || '/' || jsonb_typeof(after->'out') || '/' || (after->'breaks' = before->'breaks')::text
              || '/' || jsonb_typeof(before->'out') || '/' || (before->>'in') || '/' || (after ? 'job')::text
         from public.ts_edits where note = 'zz-sw S1'$q$,
    pg_temp.ts_v_iso(pg_temp.ts_v_at(t, '07:46:12', la), la) || '/null/true/null/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(t, '08:02:38', la), la) || '/false');
  perform pg_temp.ts_v('S3 ... the worker gets it in its times list, with no end, and not in its breaks list', 'authenticated', aut,
    $q$select count(*) filter (where x.k = 't' and jsonb_typeof(e->'after'->'out') = 'null') || '/' || count(*) filter (where x.k = 'b')
         from (select 't' k, public.ts_edits_pending('times') l union all select 'b', public.ts_edits_pending('breaks')) x
        cross join lateral jsonb_array_elements(x.l) e where e->>'note' = 'zz-sw S1'$q$, '1/0');
  perform pg_temp.ts_v('S4 the start it has (to the minute) is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-sw-s1', 'update', pg_temp.ts_v_after(t, la, '08:02', null, '[]'), 'zz-sw S4'),
    alone || ', and this is the start it has');
  perform pg_temp.ts_v('S5 a break the shift does not have is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-sw-s1', 'update', pg_temp.ts_v_after(t, la, '07:46', null, '[["12:00","12:30","meal"]]'), 'zz-sw S5'),
    alone || ', so send its breaks as they are');
  perform pg_temp.ts_v('S6 another job is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-sw-s1', 'update', pg_temp.ts_v_after(t, la, '07:46', null, '[]') || '{"job": {"id": "zz-sw-job-2"}}', 'zz-sw S6'),
    alone || ', so its job stays as it is');
  perform pg_temp.ts_v('S7 no end for a shift that has ended: End is missing, as before', 'authenticated', adm,
    pg_temp.ts_v_sub(d2, 'zz-sw-s2', 'update', pg_temp.ts_v_after(t, la, '07:30', null, '[]'), 'zz-sw S7'), 'ERROR P0001: End is missing');
  perform pg_temp.ts_v('S8 an add with no end: End is missing, as before', 'authenticated', adm,
    pg_temp.ts_v_sub(d2, null, 'add', pg_temp.ts_v_after(t, la, '17:00', null, '[]'), 'zz-sw S8'), 'ERROR P0001: End is missing');
  perform pg_temp.ts_v('S9 a new start after one of the shift''s breaks is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d3, 'zz-sw-s3', 'update', pg_temp.ts_v_after(t, la, '10:30', null, '[["10:00","10:10","rest"]]'), 'zz-sw S9'),
    'ERROR P0001: The 10:00 AM break would be before the new start');
  perform pg_temp.ts_v('S10 an earlier start keeps the break ("job": null is no job change)', 'authenticated', adm,
    pg_temp.ts_v_sub(d3, 'zz-sw-s3', 'update', pg_temp.ts_v_after(t, la, '07:30', null, '[["10:00","10:10","rest"]]') || '{"job": null}', 'zz-sw S10'),
    'update/pending/none');
  perform pg_temp.ts_v('S10b ... stored with the row''s break, its type as stored', null, null,
    $q$select (after->'breaks' = before->'breaks')::text || '/' || jsonb_array_length(after->'breaks') || '/' || (after->'breaks'->0->>'kind')
         from public.ts_edits where note = 'zz-sw S10'$q$, 'true/1/rest');
  perform pg_temp.ts_v('S11 a break still running stays running, and the shift''s own job may be sent', 'authenticated', adm,
    pg_temp.ts_v_sub(d4, 'zz-sw-s4', 'update', pg_temp.ts_v_after(t, la, '07:45', null, '[["12:00",null,"meal"]]') || '{"job": {"id": "zz-sw-job-1"}}', 'zz-sw S11'),
    'update/pending/none');
  perform pg_temp.ts_v('S11b ... stored with the open break and the shift''s job', null, null,
    $q$select (after->'breaks'->0->>'end' is null)::text || '/' || (after->'breaks'->0->>'kind') || '/' || (after->'breaks' = before->'breaks')::text
              || '/' || (after->'job'->>'id') || '/' || (after->'job' = before->'job')::text
         from public.ts_edits where note = 'zz-sw S11'$q$, 'true/meal/true/zz-sw-job-1/true');
  perform pg_temp.ts_v('S12 a new start over another shift of the day is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d5, 'zz-sw-s5', 'update', pg_temp.ts_v_after(t, la, '07:40', null, '[]'), 'zz-sw S12'),
    'ERROR P0001: This shift overlaps the 7:50 AM to 7:58 AM shift');
  perform pg_temp.ts_v('S13 a new start the minute the other shift ends is fine', 'authenticated', adm,
    pg_temp.ts_v_sub(d5, 'zz-sw-s5', 'update', pg_temp.ts_v_after(t, la, '07:58', null, '[]'), 'zz-sw S13'), 'update/pending/none');
  perform pg_temp.ts_v('S14 a start alone replaces a waiting start alone of the shift', 'authenticated', adm,
    pg_temp.ts_v_sub(d5, 'zz-sw-s5', 'update', pg_temp.ts_v_after(t, la, '07:59', null, '[]'), 'zz-sw S14'), 'update/pending/none');
  perform pg_temp.ts_v('S14b ... (S13 replaced)', null, null, $q$select pg_temp.ts_v_st('zz-sw S13')$q$, 'cancelled/none/superseded');
  perform pg_temp.ts_v('S15 a new start before the end of the part carried past midnight is refused (the day before''s end goes first)', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-sw-s1', 'update', pg_temp.ts_v_after(t, la, '07:40', null, '[]'), 'zz-sw S15'),
    'ERROR P0001: This shift overlaps the 12:00 AM to 7:46 AM shift');
  perform pg_temp.ts_v('S16 a new start on another day is refused, as before', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-sw-s1', 'update', pg_temp.ts_v_after(t - 1, la, '07:46', null, '[]'), 'zz-sw S16'),
    'ERROR P0001: Start must be on ' || to_char(t, 'Dy Mon FMDD'));
  perform pg_temp.ts_v('S17 a note on the shift still clocked in is still refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-sw-s1', 'note', null, 'zz-sw S17'), 'ERROR P0001: This shift is still clocked in: add the note once it has an end');
  perform pg_temp.ts_v('S18 a change with an end (the clock-out filled in) works as before ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-sw-s1', 'update', pg_temp.ts_v_after(t, la, '07:46:12', '16:00', '[]'), 'zz-sw S18'), 'update/pending/none');
  perform pg_temp.ts_v('S18b ... and replaces the waiting start alone', null, null, $q$select pg_temp.ts_v_st('zz-sw S1')$q$, 'cancelled/none/superseded');
  perform pg_temp.ts_v('S19 the refused submits stored nothing', null, null,
    $q$select count(*) from public.ts_edits
        where note in ('zz-sw S4', 'zz-sw S5', 'zz-sw S6', 'zz-sw S7', 'zz-sw S8', 'zz-sw S9', 'zz-sw S12', 'zz-sw S15', 'zz-sw S16', 'zz-sw S17')$q$, '0');

  -- ---------------------------------------------------------------- R. a start alone that reached Gusto before the next sync
  perform pg_temp.ts_v('R1 (admin) a start alone on d6''s shift', 'authenticated', adm,
    pg_temp.ts_v_sub(d6, 'zz-sw-s6', 'update', pg_temp.ts_v_after(t, la, '07:46', null, '[]'), 'zz-sw R1'), 'update/pending/none');
  perform pg_temp.ts_v('R2 (worker) claims its times part once Gusto shows the clock-out ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-sw R1'), 'times', 'applying', null), 'applying/(none)/false');
  perform pg_temp.ts_v('R3 ... and applies it', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-sw R1'), 'times', 'applied', null), 'applied/(none)/true');
  -- (owner) the row's last sync (an hour ago) already showed the clock-out at 5 PM, with the old start
  update public.ts_days set shifts = jsonb_build_array(pg_temp.ts_v_shift('zz-sw-s6', t, la, '08:02', '17:00', '[]')), "open" = false where id = d6;
  perform pg_temp.ts_v('R4 before the next sync, a new end for that shift ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d6, 'zz-sw-s6', 'update', pg_temp.ts_v_after(t, la, '07:46', '17:30', '[]'), 'zz-sw R4'), 'update/pending/none');
  perform pg_temp.ts_v('R5 ... has the start Gusto has now (the applied one) and the row''s own end in before (a start alone has none)', null, null,
    $q$select (before->>'in') || '/' || coalesce(before->>'out', '(null)') from public.ts_edits where note = 'zz-sw R4'$q$,
    pg_temp.ts_v_iso(pg_temp.ts_v_at(t, '07:46', la), la) || '/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(t, '17:00', la), la));
  perform pg_temp.ts_v('R6 ... and with that end, a change with no end is End is missing again', 'authenticated', adm,
    pg_temp.ts_v_sub(d6, 'zz-sw-s6', 'update', pg_temp.ts_v_after(t, la, '07:40', null, '[]'), 'zz-sw R6'), 'ERROR P0001: End is missing');
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
