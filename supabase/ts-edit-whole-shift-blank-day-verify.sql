-- Verification for supabase/ts-edit-whole-shift-blank-day.sql (Manager Timesheets: (A) a forgotten clock-out Gusto ran past
-- midnight, deleted as a whole from its first day; (B) an add for someone with no time that day; Gianni 2026-11-16).
--
-- One transaction that ROLLS BACK, in the harness of supabase/ts-edits-verify.sql and ts-edit-start-waits-verify.sql:
-- throwaway companies 'zz_wb_a' (CA) and 'zz_wb_n' (NY), synthetic people "Test Person zz-wb-...", a view 'zz-wb-v1', a
-- made-up job id 'zz-wb-job-1' and a throwaway sync key. It plays each identity, records what each can do, returns one
-- pass/fail table and undoes everything. Run it with write access as the project owner (SQL editor, or the management API
-- without read_only) after ts-edit-whole-shift-blank-day.sql; the last result set is the pass/fail table. Every row must say
-- pass = true.
--
-- Identities (real auth.users rows are needed only for gianni@ and automation@, looked up by email): admin = gianni@
-- (Google, an active admin row); managers = gianni@ set to an active NON-admin row with, in turn, one department grant, one
-- view of one person, a ('*','*') grant (rolled back); automation@ (password) with the sync key in the x-ts-sync-key header
-- (the edit worker).
--
-- The days (TODAY = today in Los Angeles; T = TODAY - 2, always inside the edit window and in the past; N = T - 1, unless
-- N would be the last day of a pay period, then N = T - 2, so N and N + 1 are always in one period; E = the last day of
-- the previous pay period, inside the window; W = the window's first day; NT, NN = the same in New York):
--   no-row adds (people in ts_people, no ts_days row):
--     zz-wb-1  Distro/Trim  T (B1, B10, B12, B13, B15), W - 1 (B11), TODAY + 1 (B11b), 1999-01-01 (B18)
--     zz-wb-2  Distro/Trim  T (B2, a department manager)       zz-wb-3  Packaging  T (B3, a view's person)
--     zz-wb-4  Distro/Trim  T (B4 a (*,*) manager, B14)        zz-wb-5  Distro/Trim  hidden from a Packaging manager
--     zz-wb-6  in no ts_people row                              zz-wb-7  Distro/Trim, inactive
--     zz-wb-8  Distro/Trim with jobs (B17)                      zz-wb-9  Distro/Trim (B16, the payroll guard)
--     zz-wb-n1 at zz_wb_n (NY), NT
--   whole-shift deletes: a split shift is day N with the sync's midnight_split flag and the shift from 4:35:06 PM to
--   11:59:59 PM, and day N + 1 (flagged too, as the sync flags every day the shift touches) with the same id from
--   12:00:00 AM to 7:03 AM (14 h 28 min in all, over the sync's 14-hour line, so the sync flags this shift itself):
--     zz-wb-10  N also has w0, 4:35:00 to 4:35:04 PM (the incident's tap): W1, W2, W12, W13, W15, W16, W17
--     zz-wb-11  no flag (real overnight work): W3            zz-wb-12  the first part ends 11:58:59 PM: W4
--     zz-wb-26  N + 1 shows another id: W4b                  zz-wb-13  no N + 1 row: W5
--     zz-wb-14  N + 1 in Packaging (a Distro/Trim manager): W6
--     zz-wb-15  N + 1 still clocked in: W7                   zz-wb-16  N + 1 ends 11:59:59 PM again: W8
--     zz-wb-17  E to E + 1, across two pay periods: W9
--     zz-wb-18  a waiting change on N + 1: W10               zz-wb-24  a waiting note on N + 1: W10b
--     zz-wb-19  a change on N + 1 sent since its sync: W11   zz-wb-22  a delete without the marker: W14
--     zz-wb-21  the payroll guard: W18                       zz-wb-20  at zz_wb_n (NY), NN: W19
--     zz-wb-29  at zz_wb_n, punched in Pacific (the punch text has its own offset), 4:00 PM to 6:30 AM: W19c
--     zz-wb-23  the whole delete being sent, then sent: W20 zz-wb-25  a department manager: W21
--     zz-wb-27  N = TODAY, N + 1 = tomorrow: W22
--   the flag is per day, not per shift (review 2026-11-16): day N is flagged for ANOTHER shift (yesterday's missed clock-out
--   carried into N, 12:00 AM to 7:03 AM), and the shift deleted is real overnight work, 10:00 PM to 6:00 AM:
--     zz-wb-30  N + 1 not flagged: W24                      zz-wb-31  N + 1 flagged for yet another shift: W24b
--     zz-wb-32  the same 8 h, but a new clock-in 10 seconds after its 6:00:10 AM end (the sync's re-clock rule): W24c
--     zz-wb-33  5:00 PM to 7:00 AM, exactly 14 h, the next clock-in 5 min 1 s after its end: W24d

begin;

create temp table ts_v_results (
  seq serial primary key,
  test text not null,
  expected text not null,      -- a LIKE pattern (escape '!'); plain text means equal
  got text
) on commit drop;

-- Run p_sql as an identity and return its single value as text, or 'ERROR <sqlstate>: <message>' (as in ts-edits-verify.sql).
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

-- ---------------------------------------------------------------- time helpers (owner only)
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

-- UTC with milliseconds and 'Z', as a browser's toISOString() sends it.
create function pg_temp.ts_v_z(p_ts timestamptz) returns text
language sql stable as $f$ select to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $f$;

-- An edit's after as the page sends it: UTC 'Z' times, breaks in the order given.
-- p_brks = [["10:00", "10:10", "rest"], ...] on day p_d.
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

-- A ts_days shift as the producer writes it (times with p_tz's offsets; p_out null = still clocked in).
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

-- One synthetic day row, last synced an hour ago; returns its id.
create function pg_temp.ts_v_day(p_company text, p_region text, p_uuid text, p_dept text, p_d date, p_shifts jsonb,
                                 p_flags jsonb default '[]') returns text
language sql as $f$
  insert into public.ts_days (id, company, region, employee_uuid, employee_name, department, work_date, first_in, last_out, shifts, flags, "open", synced_at)
  values (p_company || ':' || p_uuid || ':' || to_char(p_d, 'YYYY-MM-DD'), p_company, p_region, p_uuid, 'Test Person ' || p_uuid,
          p_dept, p_d, (p_shifts->0->>'in')::timestamptz, (p_shifts->-1->>'out')::timestamptz, p_shifts, p_flags,
          exists (select 1 from jsonb_array_elements(p_shifts) s where s->>'out' is null), now() - interval '1 hour')
  returning id
$f$;

-- A shift Gusto ran past midnight under one id p_id: day p_d (department p_dept1) from p_in to p_out1, and, when p_dept2
-- is given, day p_d + 1 (department p_dept2) with id p_id2 (else p_id) from 12:00:00 AM to p_out2 (null = still clocked
-- in); both days carry the sync's midnight_split flag when p_flag. Returns day p_d's id.
create function pg_temp.ts_v_split(p_company text, p_region text, p_uuid text, p_d date, p_tz text, p_id text,
                                   p_in text, p_out1 text, p_out2 text, p_flag boolean,
                                   p_dept1 text, p_dept2 text, p_id2 text default null) returns text
language plpgsql as $f$
declare
  v_flags jsonb := case when p_flag then '[{"code": "midnight_split", "sev": "warn", "msg": "Likely a missed clock-out"}]'::jsonb
                        else '[]'::jsonb end;
  v_id text;
begin
  v_id := pg_temp.ts_v_day(p_company, p_region, p_uuid, p_dept1, p_d,
            jsonb_build_array(pg_temp.ts_v_shift(p_id, p_d, p_tz, p_in, p_out1, '[]')), v_flags);
  if p_dept2 is not null then
    perform pg_temp.ts_v_day(p_company, p_region, p_uuid, p_dept2, p_d + 1,
              jsonb_build_array(pg_temp.ts_v_shift(coalesce(p_id2, p_id), p_d + 1, p_tz, '00:00:00', p_out2, '[]')), v_flags);
  end if;
  return v_id;
end $f$;

-- ---------------------------------------------------------------- SQL builders
-- submit, returning 'action/times_status/breaks_status'
create function pg_temp.ts_v_sub(p_day text, p_shift text, p_action text, p_after jsonb, p_note text) returns text
language sql immutable as $f$
  select format($q$select (r->>'action') || '/' || (r->>'times_status') || '/' || (r->>'breaks_status') from (select public.ts_edit_submit(%L, %L, %L, %L::jsonb, %L) r) s$q$,
                p_day, p_shift, p_action, p_after::text, p_note)
$f$;
-- the same with p_expect (the ids of the edits of that shift the caller saw waiting)
create function pg_temp.ts_v_subx(p_day text, p_shift text, p_action text, p_after jsonb, p_note text, p_expect jsonb) returns text
language sql immutable as $f$
  select format($q$select (r->>'action') || '/' || (r->>'times_status') || '/' || (r->>'breaks_status') from (select public.ts_edit_submit(%L, %L, %L, %L::jsonb, %L, %L::jsonb) r) s$q$,
                p_day, p_shift, p_action, p_after::text, p_note, p_expect::text)
$f$;
-- cancel, returning 'times_status/breaks_status/cancelled_by'
create function pg_temp.ts_v_cancel(p_id uuid) returns text
language sql immutable as $f$
  select format($q$select (r->>'times_status') || '/' || (r->>'breaks_status') || '/' || coalesce(r->>'cancelled_by', '(none)') from (select public.ts_edit_cancel(%L::uuid) r) s$q$, p_id)
$f$;
-- worker mark, returning 'status/error/applied_at is set' for that part
create function pg_temp.ts_v_mark(p_id uuid, p_part text, p_status text, p_error text) returns text
language sql immutable as $f$
  select format($q$select (r->>(%L || '_status')) || '/' || coalesce(r->>(%L || '_error'), '(none)') || '/' || (r->>(%L || '_applied_at') is not null) from (select public.ts_edit_mark(%L::uuid, %L, %L, %L) r) s$q$,
                p_part, p_part, p_part, p_id, p_part, p_status, p_error)
$f$;
-- (owner) the edit saved with this note, and its 'times/breaks/cancelled_by'
create function pg_temp.ts_v_id(p_note text) returns uuid
language sql as $f$ select e.id from public.ts_edits e where e.note = p_note $f$;
create function pg_temp.ts_v_st(p_note text) returns text
language sql as $f$
  select coalesce(string_agg(e.times_status || '/' || e.breaks_status || '/' || coalesce(e.cancelled_by, '(none)'), ','), '(no edit)')
    from public.ts_edits e where e.note = p_note
$f$;

-- ------------------------------------------------------------------ setup (as owner, rolled back)
select pg_temp.ts_v_gianni(true, true, '[]');
select pg_temp.ts_v_gianni_views('[]');
insert into public.ts_companies (key, name, region) values
  ('zz_wb_a', 'Verify Whole Blank A', 'CA'), ('zz_wb_n', 'Verify Whole Blank NY', 'NY')
on conflict do nothing;
insert into public.ts_views (id, label, sort, members, updated_by) values
  ('zz-wb-v1', 'Verify Whole Blank One', 994, '[{"company":"zz_wb_a","employee_uuid":"zz-wb-3"}]', 'verify');
-- the sync key for this run (the worker RPCs check the x-ts-sync-key request header against its sha256)
insert into public.ts_sync_keys (key_hash, label)
values (encode(sha256(convert_to('zz-wb-sync-key', 'utf8')), 'hex'), 'verify whole blank (rolled back)');
select set_config('request.headers', '', true);

-- ------------------------------------------------------------------ checks
do $v$
declare
  adm    constant text := 'gianni@wizardtrees.com';
  aut    constant text := 'automation@wizardtrees.com';
  la     constant text := 'America/Los_Angeles';
  nyz    constant text := 'America/New_York';
  key_on constant text := '{"x-ts-sync-key": "zz-wb-sync-key"}';
  mk     constant text := 'Delete the whole shift on both days';
  today  constant date := (now() at time zone 'America/Los_Angeles')::date;
  t      constant date := (now() at time zone 'America/Los_Angeles')::date - 2;
  -- day N: T - 1, unless that is the last day of a pay period (periods end on the Fridays 2026-10-09 + 14k); then T - 2
  n      constant date := case when mod((t - 1) - date '2026-10-09', 14) = 0 then t - 2 else t - 1 end;
  -- the window's first day (the previous pay period's first day) and the previous pay period's last day, worked out here
  -- independently of ts_edit_window: periods start on the Saturdays 2026-09-26 + 14k
  w      constant date := date '2026-09-26' + 14 * floor((((now() at time zone 'America/Los_Angeles')::date) - date '2026-09-26') / 14.0)::int - 14;
  e      constant date := date '2026-09-26' + 14 * floor((((now() at time zone 'America/Los_Angeles')::date) - date '2026-09-26') / 14.0)::int - 1;
  nt     constant date := (now() at time zone 'America/New_York')::date - 2;
  nn     constant date := case when mod((nt - 1) - date '2026-10-09', 14) = 0 then nt - 2 else nt - 1 end;
  no_day constant text := 'ERROR 42501: No such day, or you cannot edit it';
  future constant text := 'ERROR P0001: You cannot edit a day that has not happened yet';
  first_part constant text := 'ERROR P0001: Only the first day''s part of a shift Gusto ran past midnight can be deleted as a whole. Change it in Gusto';
  -- the pay period of a day: its last day (a Friday) and first day
  pe_n   constant date := date '2026-10-09' + 14 * ceil((n - date '2026-10-09') / 14.0)::int;
  pe_t   constant date := date '2026-10-09' + 14 * ceil((t - date '2026-10-09') / 14.0)::int;
  b1  text; b2 text; b3 text; b4 text; nb1 text;
  d10 text; d10n text; d11 text; d12 text; d13 text; d14 text; d15 text; d16 text; d17 text; d18 text; d18n text;
  d19 text; d19n text; d20 text; d21 text; d22 text; d23 text; d23n text; d24 text; d24n text; d25 text; d26 text;
  d27 text; d29 text; d30 text; d31 text; d32 text; d33 text;
  v_flag constant jsonb := '[{"code": "midnight_split", "sev": "warn", "msg": "Likely a missed clock-out"}]';
begin
  -- ---------------------------------------------------------------- fixtures (as owner)
  insert into public.ts_people (company, employee_uuid, name, department, job_title, active, jobs) values
    ('zz_wb_a', 'zz-wb-1', 'Test Person zz-wb-1', 'Distro/Trim', 'Distro Packager', true, null),
    ('zz_wb_a', 'zz-wb-2', 'Test Person zz-wb-2', 'Distro/Trim', 'Distro Packager', true, null),
    ('zz_wb_a', 'zz-wb-3', 'Test Person zz-wb-3', 'Packaging', 'Packer', true, null),
    ('zz_wb_a', 'zz-wb-4', 'Test Person zz-wb-4', 'Distro/Trim', 'Distro Packager', true, null),
    ('zz_wb_a', 'zz-wb-5', 'Test Person zz-wb-5', 'Distro/Trim', 'Distro Packager', true, null),
    ('zz_wb_a', 'zz-wb-7', 'Test Person zz-wb-7', 'Distro/Trim', 'Distro Packager', false, null),
    ('zz_wb_a', 'zz-wb-8', 'Test Person zz-wb-8', 'Distro/Trim', 'Distro Packager', true, jsonb_build_array(
       jsonb_build_object('id', 'zz-wb-job-1', 'title', 'Distro Packager', 'primary', true, 'start', t - 60),
       jsonb_build_object('id', 'zz-wb-job-2', 'title', 'Deleaf/Harvest', 'primary', false, 'start', t + 1))),
    ('zz_wb_a', 'zz-wb-9', 'Test Person zz-wb-9', 'Distro/Trim', 'Distro Packager', true, null),
    ('zz_wb_n', 'zz-wb-n1', 'Test Person zz-wb-n1', 'Distro Hourly', 'Packer', true, null);
  b1  := 'zz_wb_a:zz-wb-1:' || to_char(t, 'YYYY-MM-DD');
  b2  := 'zz_wb_a:zz-wb-2:' || to_char(t, 'YYYY-MM-DD');
  b3  := 'zz_wb_a:zz-wb-3:' || to_char(t, 'YYYY-MM-DD');
  b4  := 'zz_wb_a:zz-wb-4:' || to_char(t, 'YYYY-MM-DD');
  nb1 := 'zz_wb_n:zz-wb-n1:' || to_char(nt, 'YYYY-MM-DD');

  -- zz-wb-10: the incident's day N (the 4-second tap w0, then w1 to 11:59:59 PM) and day N + 1 (w1 to 7:03 AM)
  d10 := pg_temp.ts_v_day('zz_wb_a', 'CA', 'zz-wb-10', 'Distro/Trim', n, jsonb_build_array(
           pg_temp.ts_v_shift('zz-wb-w0', n, la, '16:35:00', '16:35:04', '[]'),
           pg_temp.ts_v_shift('zz-wb-w1', n, la, '16:35:06', '23:59:59', '[]')), v_flag);
  d10n := pg_temp.ts_v_day('zz_wb_a', 'CA', 'zz-wb-10', 'Distro/Trim', n + 1, jsonb_build_array(
           pg_temp.ts_v_shift('zz-wb-w1', n + 1, la, '00:00:00', '07:03:00', '[]')), v_flag);
  d11 := pg_temp.ts_v_split('zz_wb_a', 'CA', 'zz-wb-11', n, la, 'zz-wb-w11', '16:35:06', '23:59:59', '07:03', false, 'Distro/Trim', 'Distro/Trim');
  d12 := pg_temp.ts_v_split('zz_wb_a', 'CA', 'zz-wb-12', n, la, 'zz-wb-w12', '16:35:06', '23:58:59', '07:03', true, 'Distro/Trim', 'Distro/Trim');
  d26 := pg_temp.ts_v_split('zz_wb_a', 'CA', 'zz-wb-26', n, la, 'zz-wb-w26', '16:35:06', '23:59:59', '07:03', true, 'Distro/Trim', 'Distro/Trim', 'zz-wb-w26-other');
  d13 := pg_temp.ts_v_split('zz_wb_a', 'CA', 'zz-wb-13', n, la, 'zz-wb-w13', '16:35:06', '23:59:59', null, true, 'Distro/Trim', null);
  d14 := pg_temp.ts_v_split('zz_wb_a', 'CA', 'zz-wb-14', n, la, 'zz-wb-w14', '16:35:06', '23:59:59', '07:03', true, 'Distro/Trim', 'Packaging');
  d15 := pg_temp.ts_v_split('zz_wb_a', 'CA', 'zz-wb-15', n, la, 'zz-wb-w15', '16:35:06', '23:59:59', null, true, 'Distro/Trim', 'Distro/Trim');
  d16 := pg_temp.ts_v_split('zz_wb_a', 'CA', 'zz-wb-16', n, la, 'zz-wb-w16', '16:35:06', '23:59:59', '23:59:59', true, 'Distro/Trim', 'Distro/Trim');
  d17 := pg_temp.ts_v_split('zz_wb_a', 'CA', 'zz-wb-17', e, la, 'zz-wb-w17', '16:35:06', '23:59:59', '07:03', true, 'Distro/Trim', 'Distro/Trim');
  d18 := pg_temp.ts_v_split('zz_wb_a', 'CA', 'zz-wb-18', n, la, 'zz-wb-w18', '16:35:06', '23:59:59', '07:03', true, 'Distro/Trim', 'Distro/Trim');
  d18n := 'zz_wb_a:zz-wb-18:' || to_char(n + 1, 'YYYY-MM-DD');
  d19 := pg_temp.ts_v_split('zz_wb_a', 'CA', 'zz-wb-19', n, la, 'zz-wb-w19', '16:35:06', '23:59:59', '07:03', true, 'Distro/Trim', 'Distro/Trim');
  d19n := 'zz_wb_a:zz-wb-19:' || to_char(n + 1, 'YYYY-MM-DD');
  d20 := pg_temp.ts_v_split('zz_wb_n', 'NY', 'zz-wb-20', nn, nyz, 'zz-wb-w20', '16:35:06', '23:59:59', '07:03', true, 'Distro Hourly', 'Distro Hourly');
  d29 := pg_temp.ts_v_split('zz_wb_n', 'NY', 'zz-wb-29', nn, la, 'zz-wb-w29', '16:00:00', '23:59:59', '06:30', true, 'Distro Hourly', 'Distro Hourly');
  d21 := pg_temp.ts_v_split('zz_wb_a', 'CA', 'zz-wb-21', n, la, 'zz-wb-w21', '16:35:06', '23:59:59', '07:03', true, 'Distro/Trim', 'Distro/Trim');
  d22 := pg_temp.ts_v_split('zz_wb_a', 'CA', 'zz-wb-22', n, la, 'zz-wb-w22', '16:35:06', '23:59:59', '07:03', true, 'Distro/Trim', 'Distro/Trim');
  d23 := pg_temp.ts_v_split('zz_wb_a', 'CA', 'zz-wb-23', n, la, 'zz-wb-w23', '16:35:06', '23:59:59', '07:03', true, 'Distro/Trim', 'Distro/Trim');
  d23n := 'zz_wb_a:zz-wb-23:' || to_char(n + 1, 'YYYY-MM-DD');
  d24 := pg_temp.ts_v_split('zz_wb_a', 'CA', 'zz-wb-24', n, la, 'zz-wb-w24', '16:35:06', '23:59:59', '07:03', true, 'Distro/Trim', 'Distro/Trim');
  d24n := 'zz_wb_a:zz-wb-24:' || to_char(n + 1, 'YYYY-MM-DD');
  d25 := pg_temp.ts_v_split('zz_wb_a', 'CA', 'zz-wb-25', n, la, 'zz-wb-w25', '16:35:06', '23:59:59', '07:03', true, 'Distro/Trim', 'Distro/Trim');
  d27 := pg_temp.ts_v_split('zz_wb_a', 'CA', 'zz-wb-27', today, la, 'zz-wb-w27', '16:35:06', '23:59:59', '07:03', true, 'Distro/Trim', 'Distro/Trim');
  -- day N flagged for another shift (a, the 12:00 AM part of yesterday's missed clock-out), and real overnight work (w30..w33)
  d30 := pg_temp.ts_v_day('zz_wb_a', 'CA', 'zz-wb-30', 'Distro/Trim', n, jsonb_build_array(
           pg_temp.ts_v_shift('zz-wb-w30a', n, la, '00:00:00', '07:03:00', '[]'),
           pg_temp.ts_v_shift('zz-wb-w30', n, la, '22:00:00', '23:59:59', '[]')), v_flag);
  perform pg_temp.ts_v_day('zz_wb_a', 'CA', 'zz-wb-30', 'Distro/Trim', n + 1, jsonb_build_array(
           pg_temp.ts_v_shift('zz-wb-w30', n + 1, la, '00:00:00', '06:00:00', '[]')), '[]');
  d31 := pg_temp.ts_v_day('zz_wb_a', 'CA', 'zz-wb-31', 'Distro/Trim', n, jsonb_build_array(
           pg_temp.ts_v_shift('zz-wb-w31a', n, la, '00:00:00', '07:03:00', '[]'),
           pg_temp.ts_v_shift('zz-wb-w31', n, la, '22:00:00', '23:59:59', '[]')), v_flag);
  perform pg_temp.ts_v_day('zz_wb_a', 'CA', 'zz-wb-31', 'Distro/Trim', n + 1, jsonb_build_array(
           pg_temp.ts_v_shift('zz-wb-w31', n + 1, la, '00:00:00', '06:00:00', '[]'),
           pg_temp.ts_v_shift('zz-wb-w31c', n + 1, la, '22:00:00', '23:59:59', '[]')), v_flag);
  d32 := pg_temp.ts_v_day('zz_wb_a', 'CA', 'zz-wb-32', 'Distro/Trim', n, jsonb_build_array(
           pg_temp.ts_v_shift('zz-wb-w32', n, la, '22:00:00', '23:59:59', '[]')), v_flag);
  perform pg_temp.ts_v_day('zz_wb_a', 'CA', 'zz-wb-32', 'Distro/Trim', n + 1, jsonb_build_array(
           pg_temp.ts_v_shift('zz-wb-w32', n + 1, la, '00:00:00', '06:00:10', '[]'),
           pg_temp.ts_v_shift('zz-wb-w32r', n + 1, la, '06:00:20', '14:00:00', '[]')), v_flag);
  d33 := pg_temp.ts_v_day('zz_wb_a', 'CA', 'zz-wb-33', 'Distro/Trim', n, jsonb_build_array(
           pg_temp.ts_v_shift('zz-wb-w33', n, la, '17:00:00', '23:59:59', '[]')), v_flag);
  perform pg_temp.ts_v_day('zz_wb_a', 'CA', 'zz-wb-33', 'Distro/Trim', n + 1, jsonb_build_array(
           pg_temp.ts_v_shift('zz-wb-w33', n + 1, la, '00:00:00', '07:00:00', '[]'),
           pg_temp.ts_v_shift('zz-wb-w33r', n + 1, la, '07:05:01', '15:00:00', '[]')), v_flag);
  perform set_config('request.headers', key_on, true);

  -- ---------------------------------------------------------------- A. catalog
  perform pg_temp.ts_v('A1 ts_edit_submit keeps its one signature: security definer, search_path=public, run by authenticated, not anon', null, null,
    $q$select count(*) || '/' || bool_and(p.prosecdef and coalesce(array_to_string(p.proconfig, ',') like '%search_path=public%', false))
              || '/' || bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
              || '/' || bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE'))
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'ts_edit_submit'$q$,
    '1/true/true/true');
  perform pg_temp.ts_v('A2 it is this file''s: it knows a start alone, a whole delete, a day with no row, and the marker byte for byte', null, null,
    $q$select (d like '%v!_start!_only%' escape '!') || '/' || (d like '%v!_whole%' escape '!') || '/' || (d like '%v!_blank%' escape '!')
              || '/' || (strpos(d, 'c_whole    constant text := ''Delete the whole shift on both days'';') > 0)
         from (select pg_get_functiondef('public.ts_edit_submit(text,text,text,jsonb,text,jsonb)'::regprocedure) d) x$q$, 'true/true/true/true');
  perform pg_temp.ts_v('A3 ts_edit_submit has one signature: the five page arguments plus p_expect (default null)', null, null,
    $q$select count(*) || '/' || string_agg(pg_get_function_identity_arguments(p.oid), ',') || '/' || string_agg(pg_get_expr(p.proargdefaults, 0), ',')
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'ts_edit_submit'$q$,
    '1/p_day_id text, p_shift_id text, p_action text, p_after jsonb, p_note text, p_expect jsonb/NULL::jsonb');
  -- (the list of ts-edits-verify.sql A6: no function is new)
  perform pg_temp.ts_v('A4 authenticated can execute exactly the ts_ functions it could before', null, null,
    $q$select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'ts\_%' and has_function_privilege('authenticated', p.oid, 'EXECUTE')$q$,
    pg_temp.ts_v_lit('ts_admin_delete_user,ts_admin_delete_view,ts_admin_list,ts_admin_save_user,ts_admin_save_view,ts_admin_set_user_views,'
                  || 'ts_edit_cancel,' || case when to_regprocedure('public.ts_edit_clear(uuid,text)') is not null then 'ts_edit_clear,' else '' end
                  || 'ts_edit_mark,ts_edit_submit,ts_edits_pending,'
                  || case when to_regprocedure('public.ts_edits_to_recheck()') is not null then 'ts_edits_to_recheck,' else '' end
                  || 'ts_is_admin,ts_me,ts_my_email,ts_my_grant_keys,ts_my_view_ids,'
                  || case when to_regprocedure('public.ts_pay_periods_sync(text,jsonb)') is not null then 'ts_pay_periods_sync,' else '' end
                  || 'ts_sync'));
  perform pg_temp.ts_v('A5 no ts_ function has job in its name, and PUBLIC and anon can execute no edit function', null, null,
    $q$select count(*) filter (where p.proname like '%job%') || '/'
              || count(*) filter (where (p.proname like 'ts!_edit!_%' escape '!' or p.proname like 'ts!_edits!_%' escape '!')
                                    and (has_function_privilege('public', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE')))
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'ts\_%'$q$, '0/0');
  perform pg_temp.ts_v('A6 ts_edits still has one policy, SELECT to authenticated, and it is the ts_days policy OR the edit''s day row is visible (unchanged)', null, null,
    $q$select (select count(*) || '/' || string_agg(cmd || ':' || array_to_string(roles, ','), ',') from pg_policies
                where schemaname = 'public' and tablename = 'ts_edits')
              || '/' || starts_with((select qual from pg_policies where schemaname = 'public' and tablename = 'ts_edits'),
                          (select left(qual, length(qual) - 1) || ' OR (EXISTS' from pg_policies where schemaname = 'public' and tablename = 'ts_days'))::text
              || '/' || (select (qual like '%@uuid:%' and qual like '%ts!_my!_grant!_keys()%' escape '!' and qual like '%ts!_is!_admin()%' escape '!'
                                 and qual like '%OR (EXISTS ( SELECT 1%FROM ts!_days d%WHERE (d.id = ts!_edits.day!_id))))' escape '!')::text
                           from pg_policies where schemaname = 'public' and tablename = 'ts_edits')$q$, '1/SELECT:authenticated/true/true');

  -- ---------------------------------------------------------------- B. an add for someone with no time that day (admin first)
  perform pg_temp.ts_v('B1 admin adds a shift on a day with no row (zz-wb-1, T)', 'authenticated', adm,
    pg_temp.ts_v_sub(b1, null, 'add', pg_temp.ts_v_after(t, la, '13:00', '16:30', '[]'), 'zz-wb B1'), 'add/pending/none');
  perform pg_temp.ts_v('B1b ... stored under that day id, with ts_people''s department, ts_companies'' region, the day''s date and no before', null, null,
    $q$select day_id || '/' || department || '/' || region || '/' || work_date || '/' || company || '/' || employee_uuid
              || '/' || coalesce(shift_id, '(null)') || '/' || coalesce(before::text, '(null)') || '/' || created_by
         from public.ts_edits where note = 'zz-wb B1'$q$,
    pg_temp.ts_v_lit(b1 || '/Distro/Trim/CA/' || to_char(t, 'YYYY-MM-DD') || '/zz_wb_a/zz-wb-1/(null)/(null)/' || adm));
  perform pg_temp.ts_v('B1c ... and no ts_days row was written', null, null,
    format($q$select count(*) from public.ts_days where id = %L$q$, b1), '0');
  perform pg_temp.ts_v('B1d the worker gets it in its times list, under that day id', 'authenticated', aut,
    format($q$select count(*) filter (where x.k = 't' and e->>'day_id' = %L) || '/' || count(*) filter (where x.k = 'b')
                from (select 't' k, public.ts_edits_pending('times') l union all select 'b', public.ts_edits_pending('breaks')) x
               cross join lateral jsonb_array_elements(x.l) e where e->>'note' = 'zz-wb B1'$q$, b1), '1/0');
  perform pg_temp.ts_v('B1e a New York person with no row: region NY and Eastern times from ts_companies', 'authenticated', adm,
    pg_temp.ts_v_sub(nb1, null, 'add', pg_temp.ts_v_after(nt, nyz, '09:00', '12:00', '[]'), 'zz-wb B1e'), 'add/pending/none');
  perform pg_temp.ts_v('B1f ... stored with region NY, its department and the start with an Eastern offset', null, null,
    $q$select region || '/' || department || '/' || (after->>'in') from public.ts_edits where note = 'zz-wb B1e'$q$,
    'NY/Distro Hourly/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(nt, '09:00', nyz), nyz));
  perform pg_temp.ts_v('B6 a person with no ts_people row gets the hidden-day answer', 'authenticated', adm,
    pg_temp.ts_v_sub('zz_wb_a:zz-wb-6:' || to_char(t, 'YYYY-MM-DD'), null, 'add', pg_temp.ts_v_after(t, la, '13:00', '16:30', '[]'), 'zz-wb B6'), no_day);
  perform pg_temp.ts_v('B7 a person who is no longer active gets the hidden-day answer', 'authenticated', adm,
    pg_temp.ts_v_sub('zz_wb_a:zz-wb-7:' || to_char(t, 'YYYY-MM-DD'), null, 'add', pg_temp.ts_v_after(t, la, '13:00', '16:30', '[]'), 'zz-wb B7'), no_day);
  perform pg_temp.ts_v('B8 an id with no date gets the hidden-day answer', 'authenticated', adm,
    pg_temp.ts_v_sub('zz_wb_a:zz-wb-1', null, 'add', pg_temp.ts_v_after(t, la, '13:00', '16:30', '[]'), 'zz-wb B8'), no_day);
  perform pg_temp.ts_v('B8b ... a date that is not a date (2026-13-40)', 'authenticated', adm,
    pg_temp.ts_v_sub('zz_wb_a:zz-wb-1:2026-13-40', null, 'add', pg_temp.ts_v_after(t, la, '13:00', '16:30', '[]'), 'zz-wb B8b'), no_day);
  perform pg_temp.ts_v('B8c ... a date that does not exist (2026-02-30)', 'authenticated', adm,
    pg_temp.ts_v_sub('zz_wb_a:zz-wb-1:2026-02-30', null, 'add', pg_temp.ts_v_after(t, la, '13:00', '16:30', '[]'), 'zz-wb B8c'), no_day);
  perform pg_temp.ts_v('B8d ... a company spelled in capitals', 'authenticated', adm,
    pg_temp.ts_v_sub('ZZ_WB_A:zz-wb-1:' || to_char(t, 'YYYY-MM-DD'), null, 'add', pg_temp.ts_v_after(t, la, '13:00', '16:30', '[]'), 'zz-wb B8d'), no_day);
  perform pg_temp.ts_v('B8e ... an id with four parts', 'authenticated', adm,
    pg_temp.ts_v_sub('zz_wb_a:zz:wb:' || to_char(t, 'YYYY-MM-DD'), null, 'add', pg_temp.ts_v_after(t, la, '13:00', '16:30', '[]'), 'zz-wb B8e'), no_day);
  perform pg_temp.ts_v('B9 a company that is not in ts_companies gets the hidden-day answer', 'authenticated', adm,
    pg_temp.ts_v_sub('zz_wb_x:zz-wb-1:' || to_char(t, 'YYYY-MM-DD'), null, 'add', pg_temp.ts_v_after(t, la, '13:00', '16:30', '[]'), 'zz-wb B9'), no_day);
  perform pg_temp.ts_v('B10 an update on a day with no row gets the hidden-day answer', 'authenticated', adm,
    pg_temp.ts_v_sub(b1, 'zz-wb-x', 'update', pg_temp.ts_v_after(t, la, '13:00', '16:30', '[]'), 'zz-wb B10'), no_day);
  perform pg_temp.ts_v('B10b ... a delete', 'authenticated', adm, pg_temp.ts_v_sub(b1, 'zz-wb-x', 'delete', null, 'zz-wb B10b'), no_day);
  perform pg_temp.ts_v('B10c ... a note', 'authenticated', adm, pg_temp.ts_v_sub(b1, 'zz-wb-x', 'note', null, 'zz-wb B10c'), no_day);
  perform pg_temp.ts_v('B11 a visible person on a day before the window gets the window''s answer', 'authenticated', adm,
    pg_temp.ts_v_sub('zz_wb_a:zz-wb-1:' || to_char(w - 1, 'YYYY-MM-DD'), null, 'add', pg_temp.ts_v_after(w - 1, la, '13:00', '16:30', '[]'), 'zz-wb B11'),
    'ERROR P0001: Only the current and previous pay periods can be edited (from ' || to_char(w, 'Dy Mon FMDD') || ')');
  perform pg_temp.ts_v('B11b a visible person tomorrow: You cannot edit a day that has not happened yet', 'authenticated', adm,
    pg_temp.ts_v_sub('zz_wb_a:zz-wb-1:' || to_char(today + 1, 'YYYY-MM-DD'), null, 'add', pg_temp.ts_v_after(today + 1, la, '13:00', '16:30', '[]'), 'zz-wb B11b'), future);
  perform pg_temp.ts_v('B12 the same add again is already waiting', 'authenticated', adm,
    pg_temp.ts_v_sub(b1, null, 'add', pg_temp.ts_v_after(t, la, '13:00', '16:30', '[]'), 'zz-wb B12'),
    'ERROR P0001: This shift is already waiting to be added');
  perform pg_temp.ts_v('B13 an add over the waiting one is refused as an overlap', 'authenticated', adm,
    pg_temp.ts_v_sub(b1, null, 'add', pg_temp.ts_v_after(t, la, '15:00', '17:00', '[]'), 'zz-wb B13'),
    'ERROR P0001: This shift overlaps the 1:00 PM to 4:30 PM shift');
  perform pg_temp.ts_v('B13b an add right after it (from the minute it ends) is fine', 'authenticated', adm,
    pg_temp.ts_v_sub(b1, null, 'add', pg_temp.ts_v_after(t, la, '16:30', '17:30', '[]'), 'zz-wb B13b'), 'add/pending/none');
  perform pg_temp.ts_v('B17 a job from ts_people.jobs on an add with no row', 'authenticated', adm,
    pg_temp.ts_v_sub('zz_wb_a:zz-wb-8:' || to_char(t, 'YYYY-MM-DD'), null, 'add',
                     pg_temp.ts_v_after(t, la, '13:00', '16:30', '[]') || '{"job": {"id": "zz-wb-job-1"}}', 'zz-wb B17'), 'add/pending/none');
  perform pg_temp.ts_v('B17b ... is stored in after.job with the title ts_people has', null, null,
    $q$select (after->'job')::text from public.ts_edits where note = 'zz-wb B17'$q$, '{"id": "zz-wb-job-1", "title": "Distro Packager"}');
  perform pg_temp.ts_v('B17c ... and a job that starts after the day is refused', 'authenticated', adm,
    pg_temp.ts_v_sub('zz_wb_a:zz-wb-8:' || to_char(t, 'YYYY-MM-DD'), null, 'add',
                     pg_temp.ts_v_after(t, la, '17:00', '18:00', '[]') || '{"job": {"id": "zz-wb-job-2"}}', 'zz-wb B17c'),
    'ERROR P0001: That job starts on ' || to_char(t + 1, 'Mon FMDD') || ' in Gusto, after this day.');
  perform pg_temp.ts_v('B18 an update of a day that does not exist still gets the same answer (no probing)', 'authenticated', adm,
    pg_temp.ts_v_sub('zz_wb_a:zz-wb-1:1999-01-01', 'zz-wb-s1', 'update', pg_temp.ts_v_after(t, la, '08:00', '16:00', '[]'), 'zz-wb B18'), no_day);

  -- ---------------------------------------------------------------- B. managers
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"zz_wb_a","department":"Distro/Trim"}]');
  perform pg_temp.ts_v('B2 a department manager (zz_wb_a / Distro/Trim) adds for someone with no row', 'authenticated', adm,
    pg_temp.ts_v_sub(b2, null, 'add', pg_temp.ts_v_after(t, la, '13:00', '16:30', '[]'), 'zz-wb B2'), 'add/pending/none');
  perform pg_temp.ts_v('B2b ... and reads it back through ts_edits', 'authenticated', adm,
    $q$select count(*) from public.ts_edits where note = 'zz-wb B2'$q$, '1');
  perform pg_temp.ts_v('B2c ... and can cancel it (no day row: the edit''s own keys)', 'authenticated', adm,
    pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-wb B2')), 'cancelled/none/' || adm);
  perform pg_temp.ts_v('B2d ... cannot add for the Packaging person', 'authenticated', adm,
    pg_temp.ts_v_sub(b3, null, 'add', pg_temp.ts_v_after(t, la, '13:00', '16:30', '[]'), 'zz-wb B2d'), no_day);
  perform pg_temp.ts_v_gianni(false, true, '[]');
  perform pg_temp.ts_v_gianni_views('["zz-wb-v1"]');
  perform pg_temp.ts_v('B3 a manager with a view of one person adds for that person', 'authenticated', adm,
    pg_temp.ts_v_sub(b3, null, 'add', pg_temp.ts_v_after(t, la, '13:00', '16:30', '[]'), 'zz-wb B3'), 'add/pending/none');
  perform pg_temp.ts_v('B3b ... and reads it back through ts_edits', 'authenticated', adm,
    $q$select count(*) || '/' || min(department) from public.ts_edits where note = 'zz-wb B3'$q$, '1/Packaging');
  perform pg_temp.ts_v('B3c ... cannot add for anyone else', 'authenticated', adm,
    pg_temp.ts_v_sub('zz_wb_a:zz-wb-5:' || to_char(t, 'YYYY-MM-DD'), null, 'add', pg_temp.ts_v_after(t, la, '13:00', '16:30', '[]'), 'zz-wb B3c'), no_day);
  perform pg_temp.ts_v_gianni_views('[]');
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"*","department":"*"}]');
  perform pg_temp.ts_v('B4 an all-CA (*,*) manager adds for someone with no row', 'authenticated', adm,
    pg_temp.ts_v_sub(b4, null, 'add', pg_temp.ts_v_after(t, la, '08:00', '12:00', '[]'), 'zz-wb B4'), 'add/pending/none');
  perform pg_temp.ts_v('B4b ... but not in New York', 'authenticated', adm,
    pg_temp.ts_v_sub(nb1, null, 'add', pg_temp.ts_v_after(nt, nyz, '13:00', '15:00', '[]'), 'zz-wb B4b'), no_day);
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"zz_wb_a","department":"Packaging"}]');
  perform pg_temp.ts_v('B5 a Packaging manager adding for a Distro/Trim person gets the hidden-day answer', 'authenticated', adm,
    pg_temp.ts_v_sub('zz_wb_a:zz-wb-5:' || to_char(t, 'YYYY-MM-DD'), null, 'add', pg_temp.ts_v_after(t, la, '13:00', '16:30', '[]'), 'zz-wb B5'), no_day);
  perform pg_temp.ts_v('B11c ... also for tomorrow (the window is checked after who: no probing)', 'authenticated', adm,
    pg_temp.ts_v_sub('zz_wb_a:zz-wb-5:' || to_char(today + 1, 'YYYY-MM-DD'), null, 'add', pg_temp.ts_v_after(today + 1, la, '13:00', '16:30', '[]'), 'zz-wb B11c'), no_day);
  perform pg_temp.ts_v('B11d ... while their own Packaging person tomorrow gets the window''s answer', 'authenticated', adm,
    pg_temp.ts_v_sub('zz_wb_a:zz-wb-3:' || to_char(today + 1, 'YYYY-MM-DD'), null, 'add', pg_temp.ts_v_after(today + 1, la, '13:00', '16:30', '[]'), 'zz-wb B11d'), future);
  perform pg_temp.ts_v_gianni(true, true, '[]');

  -- ---------------------------------------------------------------- B. an add that reached Gusto, then the real row
  perform pg_temp.ts_v('B14 (worker) claims B4''s add ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-wb B4'), 'times', 'applying', null), 'applying/(none)/false');
  perform pg_temp.ts_v('B14b ... and applies it', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-wb B4'), 'times', 'applied', null), 'applied/(none)/true');
  perform pg_temp.ts_v('B14c an add over the applied one (no row yet: it still counts) is refused as an overlap', 'authenticated', adm,
    pg_temp.ts_v_sub(b4, null, 'add', pg_temp.ts_v_after(t, la, '11:00', '13:00', '[]'), 'zz-wb B14c'),
    'ERROR P0001: This shift overlaps the 8:00 AM to 12:00 PM shift');
  -- (owner) the sync writes zz-wb-1's real row for T, under the same id
  perform pg_temp.ts_v_day('zz_wb_a', 'CA', 'zz-wb-1', 'Distro/Trim', t, jsonb_build_array(pg_temp.ts_v_shift('zz-wb-r1', t, la, '08:00', '12:00', '[]')));
  perform pg_temp.ts_v('B15 once the row exists, a change of its shift goes the usual way', 'authenticated', adm,
    pg_temp.ts_v_sub(b1, 'zz-wb-r1', 'update', pg_temp.ts_v_after(t, la, '08:00', '12:30', '[]'), 'zz-wb B15'), 'update/pending/none');
  perform pg_temp.ts_v('B15b ... the earlier add''s day id is the row''s id, and the change has the row''s', null, null,
    format($q$select (select (day_id = %L)::text from public.ts_edits where note = 'zz-wb B1') || '/'
                  || (select (day_id = %L)::text from public.ts_edits where note = 'zz-wb B15')$q$, b1, b1), 'true/true');
  perform pg_temp.ts_v('B15c ... and an add over B1''s waiting add is still an overlap (the real row wins, its adds still count)', 'authenticated', adm,
    pg_temp.ts_v_sub(b1, null, 'add', pg_temp.ts_v_after(t, la, '14:00', '15:00', '[]'), 'zz-wb B15c'),
    'ERROR P0001: This shift overlaps the 1:00 PM to 4:30 PM shift');
  perform pg_temp.ts_v('B19 the refused adds stored nothing', null, null,
    $q$select count(*) from public.ts_edits where note ~ '^zz-wb (B2d|B3c|B4b|B5|B6|B7|B8|B8b|B8c|B8d|B8e|B9|B10|B10b|B10c|B11|B11b|B11c|B11d|B12|B13|B14c|B15c|B17c|B18)$'$q$, '0');

  -- ---------------------------------------------------------------- W. whole-shift deletes (admin)
  perform pg_temp.ts_v('W15 a marked delete of the 12:00 AM part, on its own day, is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d10n, 'zz-wb-w1', 'delete', null, mk || ': zz-wb W15'), first_part);
  perform pg_temp.ts_v('W16 a marked delete of a shift that did not run past midnight (the 4-second tap) is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d10, 'zz-wb-w0', 'delete', null, mk || ': zz-wb W16'), first_part);
  perform pg_temp.ts_v('W13a a waiting change of the first part (a new end) ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d10, 'zz-wb-w1', 'update', pg_temp.ts_v_after(n, la, '16:35:06', '21:00', '[]'), 'zz-wb W13a'), 'update/pending/none');
  perform pg_temp.ts_v('W1 a marked delete of the first part, from the page that showed W13a', 'authenticated', adm,
    pg_temp.ts_v_subx(d10, 'zz-wb-w1', 'delete', null, mk || ': zz-wb W1', jsonb_build_array(pg_temp.ts_v_id('zz-wb W13a'))), 'delete/none/pending');
  perform pg_temp.ts_v('W1b ... stored on day N with before.carried = the 12:00 AM part and its day, before''s end 11:59:59 PM', null, null,
    format($q$select day_id || '/' || shift_id || '/' || coalesce(after::text, '(null)') || '/' || (before->>'in') || '/' || (before->>'out')
                  || '/' || (before->'carried'->>'date') || '/' || (before->'carried'->>'in') || '/' || (before->'carried'->>'out')
                  || '/' || (before->'carried'->'breaks')::text
                from public.ts_edits where note = %L$q$, mk || ': zz-wb W1'),
    pg_temp.ts_v_lit(d10 || '/zz-wb-w1/(null)/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(n, '16:35:06', la), la)
                     || '/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(n, '23:59:59', la), la)
                     || '/' || to_char(n + 1, 'YYYY-MM-DD') || '/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(n + 1, '00:00:00', la), la)
                     || '/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(n + 1, '07:03:00', la), la) || '/[]'));
  perform pg_temp.ts_v('W2 the note is stored as sent: the marker, then the reason', null, null,
    format($q$select count(*) from public.ts_edits where note = %L$q$, 'Delete the whole shift on both days: zz-wb W1'), '1');
  perform pg_temp.ts_v('W13 ... W13a was replaced by the whole delete', null, null, $q$select pg_temp.ts_v_st('zz-wb W13a')$q$, 'cancelled/none/superseded');
  perform pg_temp.ts_v('W1c the worker gets it in its breaks list (not times), with before.carried', 'authenticated', aut,
    format($q$select count(*) filter (where x.k = 't') || '/' || count(*) filter (where x.k = 'b' and e->'before'->'carried'->>'date' = %L)
                from (select 't' k, public.ts_edits_pending('times') l union all select 'b', public.ts_edits_pending('breaks')) x
               cross join lateral jsonb_array_elements(x.l) e where e->>'note' = %L$q$,
           to_char(n + 1, 'YYYY-MM-DD'), mk || ': zz-wb W1'), '0/1');
  perform pg_temp.ts_v('W12 while it waits, "End it at 11:59 PM" on the 12:00 AM part is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d10n, 'zz-wb-w1', 'delete', null, 'End the shift at 11:59 PM: zz-wb W12'),
    'ERROR P0001: This shift waits to be deleted as a whole from ' || to_char(n, 'Dy Mon FMDD') || '. Cancel that change first, or reload after the next sync');
  perform pg_temp.ts_v('W12b ... and so is a change of it', 'authenticated', adm,
    pg_temp.ts_v_sub(d10n, 'zz-wb-w1', 'update', pg_temp.ts_v_after(n + 1, la, '00:00', '06:30', '[]'), 'zz-wb W12b'),
    'ERROR P0001: This shift waits to be deleted as a whole from ' || to_char(n, 'Dy Mon FMDD') || '. Cancel that change first, or reload after the next sync');
  perform pg_temp.ts_v('W12c ... and a note on it', 'authenticated', adm,
    pg_temp.ts_v_sub(d10n, 'zz-wb-w1', 'note', null, 'zz-wb W12c'),
    'ERROR P0001: This shift waits to be deleted as a whole from ' || to_char(n, 'Dy Mon FMDD') || '. Cancel that change first, or reload after the next sync');
  perform pg_temp.ts_v('W12d ... while the tap on day N (another id) can still change', 'authenticated', adm,
    pg_temp.ts_v_sub(d10, 'zz-wb-w0', 'update', pg_temp.ts_v_after(n, la, '13:00', '16:35', '[]'), 'zz-wb W12d'), 'update/pending/none');
  perform pg_temp.ts_v('W17 its creator cancels the whole delete', 'authenticated', adm,
    pg_temp.ts_v_cancel(pg_temp.ts_v_id(mk || ': zz-wb W1')), 'none/cancelled/' || adm);
  perform pg_temp.ts_v('W17b ... and then the 12:00 AM part can change again', 'authenticated', adm,
    pg_temp.ts_v_sub(d10n, 'zz-wb-w1', 'update', pg_temp.ts_v_after(n + 1, la, '00:00', '06:30', '[]'), 'zz-wb W17b'), 'update/pending/none');

  perform pg_temp.ts_v('W3 no midnight_split flag (real overnight work) is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d11, 'zz-wb-w11', 'delete', null, mk || ': zz-wb W3'),
    'ERROR P0001: Only a shift the sync marked as a likely missed clock-out can be deleted as a whole here. Delete it in Gusto');
  perform pg_temp.ts_v('W4 a first part that ends 11:58:59 PM is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d12, 'zz-wb-w12', 'delete', null, mk || ': zz-wb W4'), first_part);
  perform pg_temp.ts_v('W4b day N+1 shows another id (Gusto gave the rest a new one) is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d26, 'zz-wb-w26', 'delete', null, mk || ': zz-wb W4b'),
    'ERROR P0001: Gusto does not show the rest of this shift on ' || to_char(n + 1, 'Dy Mon FMDD') || '. Reload after the next sync');
  perform pg_temp.ts_v('W5 no row on day N+1 is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d13, 'zz-wb-w13', 'delete', null, mk || ': zz-wb W5'),
    'ERROR P0001: The rest of this shift (on ' || to_char(n + 1, 'Dy Mon FMDD') || ') is not on a day you can change, so it cannot be deleted as a whole here. Delete it in Gusto');
  perform pg_temp.ts_v('W7 the 12:00 AM part still clocked in is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d15, 'zz-wb-w15', 'delete', null, mk || ': zz-wb W7'),
    'ERROR P0001: The rest of this shift (on ' || to_char(n + 1, 'Dy Mon FMDD') || ') is still clocked in, so it cannot be deleted here yet');
  perform pg_temp.ts_v('W8 a shift on more than two days is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d16, 'zz-wb-w16', 'delete', null, mk || ': zz-wb W8'),
    'ERROR P0001: Gusto keeps this shift on more than two days under one id. Change it in Gusto');
  perform pg_temp.ts_v('W9 a shift from the last day of a pay period into the next is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d17, 'zz-wb-w17', 'delete', null, mk || ': zz-wb W9'),
    'ERROR P0001: The rest of this shift (on ' || to_char(e + 1, 'Dy Mon FMDD') || ') is in the next pay period, so it cannot be deleted as a whole here. Fix it in Gusto');
  perform pg_temp.ts_v('W10a a waiting change of the 12:00 AM part ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d18n, 'zz-wb-w18', 'update', pg_temp.ts_v_after(n + 1, la, '00:00', '06:30', '[]'), 'zz-wb W10a'), 'update/pending/none');
  perform pg_temp.ts_v('W10 ... blocks a whole delete', 'authenticated', adm,
    pg_temp.ts_v_sub(d18, 'zz-wb-w18', 'delete', null, mk || ': zz-wb W10'),
    'ERROR P0001: A change of this shift on ' || to_char(n + 1, 'Dy Mon FMDD') || ' is waiting or was just sent to Gusto. Cancel it there, or reload after the next sync, then try again');
  perform pg_temp.ts_v('W10b a waiting note on the 12:00 AM part ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d24n, 'zz-wb-w24', 'note', null, 'zz-wb W10b'), 'note/none/pending');
  perform pg_temp.ts_v('W10c ... does not block one', 'authenticated', adm,
    pg_temp.ts_v_sub(d24, 'zz-wb-w24', 'delete', null, mk || ': zz-wb W10c'), 'delete/none/pending');
  perform pg_temp.ts_v('W11a a change of the 12:00 AM part ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d19n, 'zz-wb-w19', 'update', pg_temp.ts_v_after(n + 1, la, '00:00', '06:45', '[]'), 'zz-wb W11a'), 'update/pending/none');
  perform pg_temp.ts_v('W11b ... that the worker claims ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-wb W11a'), 'times', 'applying', null), 'applying/(none)/false');
  perform pg_temp.ts_v('W11c ... (being sent blocks a whole delete) ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d19, 'zz-wb-w19', 'delete', null, mk || ': zz-wb W11c'),
    'ERROR P0001: A change of this shift on ' || to_char(n + 1, 'Dy Mon FMDD') || ' is waiting or was just sent to Gusto. Cancel it there, or reload after the next sync, then try again');
  perform pg_temp.ts_v('W11d ... and sends ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-wb W11a'), 'times', 'applied', null), 'applied/(none)/true');
  perform pg_temp.ts_v('W11 ... sent since that row''s sync blocks a whole delete', 'authenticated', adm,
    pg_temp.ts_v_sub(d19, 'zz-wb-w19', 'delete', null, mk || ': zz-wb W11'),
    'ERROR P0001: A change of this shift on ' || to_char(n + 1, 'Dy Mon FMDD') || ' is waiting or was just sent to Gusto. Cancel it there, or reload after the next sync, then try again');
  perform pg_temp.ts_v('W14 a delete without the marker (the words later in the reason) is stored as before ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d22, 'zz-wb-w22', 'delete', null, 'zz-wb W14 ' || mk), 'delete/none/pending');
  perform pg_temp.ts_v('W14b ... with no carried key', null, null,
    format($q$select (before ? 'carried')::text || '/' || jsonb_typeof(before) from public.ts_edits where note = %L$q$, 'zz-wb W14 ' || mk), 'false/object');
  perform pg_temp.ts_v('W19 a New York split (Eastern) is deleted as a whole the same way', 'authenticated', adm,
    pg_temp.ts_v_sub(d20, 'zz-wb-w20', 'delete', null, mk || ': zz-wb W19'), 'delete/none/pending');
  perform pg_temp.ts_v('W19b ... stored with region NY and the 12:00 AM part in Eastern', null, null,
    format($q$select region || '/' || (before->'carried'->>'date') || '/' || (before->'carried'->>'in') || '/' || (before->>'out')
                from public.ts_edits where note = %L$q$, mk || ': zz-wb W19'),
    'NY/' || to_char(nn + 1, 'YYYY-MM-DD') || '/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(nn + 1, '00:00:00', nyz), nyz)
          || '/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(nn, '23:59:59', nyz), nyz));
  perform pg_temp.ts_v('W19c a New York split punched in Pacific (midnight as written in the punch, not on the Eastern clock) is taken', 'authenticated', adm,
    pg_temp.ts_v_sub(d29, 'zz-wb-w29', 'delete', null, mk || ': zz-wb W19c'), 'delete/none/pending');
  perform pg_temp.ts_v('W19d ... stored with the 12:00 AM part as Gusto has it (on the Eastern clock)', null, null,
    format($q$select (before->'carried'->>'date') || '/' || (before->'carried'->>'in') from public.ts_edits where note = %L$q$, mk || ': zz-wb W19c'),
    to_char(nn + 1, 'YYYY-MM-DD') || '/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(nn + 1, '00:00:00', la), nyz));
  perform pg_temp.ts_v('W22 a split whose 12:00 AM part is tomorrow is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d27, 'zz-wb-w27', 'delete', null, mk || ': zz-wb W22'), future);

  -- ---------------------------------------------------------------- W. the flag is per day, not per shift (review 2026-11-16)
  perform pg_temp.ts_v('W24 real overnight work on a day flagged for another shift (yesterday''s missed clock-out carried in) is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d30, 'zz-wb-w30', 'delete', null, mk || ': zz-wb W24'),
    'ERROR P0001: Only a shift the sync marked as a likely missed clock-out can be deleted as a whole here. Delete it in Gusto');
  perform pg_temp.ts_v('W24b ... also when day N+1 is flagged for yet another shift (the sync''s own rule for this shift says no)', 'authenticated', adm,
    pg_temp.ts_v_sub(d31, 'zz-wb-w31', 'delete', null, mk || ': zz-wb W24b'),
    'ERROR P0001: Only a shift the sync marked as a likely missed clock-out can be deleted as a whole here. Delete it in Gusto');
  perform pg_temp.ts_v('W24c an 8 h split whose person clocked straight back in after it (within 5 minutes) is taken', 'authenticated', adm,
    pg_temp.ts_v_sub(d32, 'zz-wb-w32', 'delete', null, mk || ': zz-wb W24c'), 'delete/none/pending');
  perform pg_temp.ts_v('W24d a split of exactly 14 hours, the next clock-in 5 min 1 s after it, is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d33, 'zz-wb-w33', 'delete', null, mk || ': zz-wb W24d'),
    'ERROR P0001: Only a shift the sync marked as a likely missed clock-out can be deleted as a whole here. Delete it in Gusto');

  -- ---------------------------------------------------------------- W. a whole delete being sent, then sent (zz-wb-23)
  perform pg_temp.ts_v('W20 a whole delete ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d23, 'zz-wb-w23', 'delete', null, mk || ': zz-wb W20'), 'delete/none/pending');
  perform pg_temp.ts_v('W20b ... the worker claims it ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id(mk || ': zz-wb W20'), 'breaks', 'applying', null), 'applying/(none)/false');
  perform pg_temp.ts_v('W20c ... (a change of the 12:00 AM part waits meanwhile) ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d23n, 'zz-wb-w23', 'update', pg_temp.ts_v_after(n + 1, la, '00:00', '06:30', '[]'), 'zz-wb W20c'),
    'ERROR P0001: This shift waits to be deleted as a whole from ' || to_char(n, 'Dy Mon FMDD') || '. Cancel that change first, or reload after the next sync');
  perform pg_temp.ts_v('W20d ... sends it ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id(mk || ': zz-wb W20'), 'breaks', 'applied', null), 'applied/(none)/true');
  perform pg_temp.ts_v('W20e ... (and until the next sync, still) ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d23n, 'zz-wb-w23', 'update', pg_temp.ts_v_after(n + 1, la, '00:00', '06:30', '[]'), 'zz-wb W20e'),
    'ERROR P0001: This shift waits to be deleted as a whole from ' || to_char(n, 'Dy Mon FMDD') || '. Cancel that change first, or reload after the next sync');
  -- (owner) day N+1's row synced after the delete went
  update public.ts_days set synced_at = now() + interval '1 minute' where id = d23n;
  perform pg_temp.ts_v('W20f ... after day N+1''s next sync, it no longer waits', 'authenticated', adm,
    pg_temp.ts_v_sub(d23n, 'zz-wb-w23', 'update', pg_temp.ts_v_after(n + 1, la, '00:00', '06:30', '[]'), 'zz-wb W20f'), 'update/pending/none');

  -- ---------------------------------------------------------------- W. a department manager (zz_wb_a / Distro/Trim)
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"zz_wb_a","department":"Distro/Trim"}]');
  perform pg_temp.ts_v('W6 day N+1 in a department the manager cannot see is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d14, 'zz-wb-w14', 'delete', null, mk || ': zz-wb W6'),
    'ERROR P0001: The rest of this shift (on ' || to_char(n + 1, 'Dy Mon FMDD') || ') is not on a day you can change, so it cannot be deleted as a whole here. Delete it in Gusto');
  perform pg_temp.ts_v('W21 the manager deletes a whole shift (the marker in lower case, no reason)', 'authenticated', adm,
    pg_temp.ts_v_sub(d25, 'zz-wb-w25', 'delete', null, lower(mk)), 'delete/none/pending');
  perform pg_temp.ts_v('W21b ... stored with before.carried, and the manager reads it back', 'authenticated', adm,
    format($q$select count(*) || '/' || min(before->'carried'->>'date') from public.ts_edits where note = %L$q$, lower(mk)),
    '1/' || to_char(n + 1, 'YYYY-MM-DD'));
  perform pg_temp.ts_v_gianni(true, true, '[]');

  perform pg_temp.ts_v('W23 the refused whole deletes and blocked changes stored nothing', null, null,
    $q$select count(*) from public.ts_edits where note ~ 'zz-wb (W3|W4|W4b|W5|W6|W7|W8|W9|W10|W11|W11c|W12|W12b|W12c|W15|W16|W20c|W20e|W22|W24|W24b|W24d)$'$q$, '0');

  -- ---------------------------------------------------------------- the payroll guard (B16, W18): Gusto processed the periods
  -- of T and of N (they may be one period) at zz_wb_a
  update public.ts_companies
     set pay_periods = (select jsonb_agg(distinct jsonb_build_object('start', p - 13, 'end', p, 'schedule', 'zz-wb-sched', 'closed', true,
                                                                     'why', 'processed', 'sent_at', null, 'processed_at', null))
                          from unnest(array[pe_n, pe_t]) p)
   where key = 'zz_wb_a';
  perform pg_temp.ts_v('B16 an add with no row in a processed pay period gets the payroll answer', 'authenticated', adm,
    pg_temp.ts_v_sub('zz_wb_a:zz-wb-9:' || to_char(t, 'YYYY-MM-DD'), null, 'add', pg_temp.ts_v_after(t, la, '13:00', '16:30', '[]'), 'zz-wb B16'),
    'ERROR P0001: Payroll for ' || to_char(pe_t - 13, 'Dy Mon FMDD') || ' to ' || to_char(pe_t, 'Dy Mon FMDD')
      || ' has already been processed in Gusto, so this day can no longer be changed here. Fix it in Gusto, or have the hours added to the next payroll');
  perform pg_temp.ts_v('W18 a whole delete in a processed pay period gets the payroll answer', 'authenticated', adm,
    pg_temp.ts_v_sub(d21, 'zz-wb-w21', 'delete', null, mk || ': zz-wb W18'),
    'ERROR P0001: Payroll for ' || to_char(pe_n - 13, 'Dy Mon FMDD') || ' to ' || to_char(pe_n, 'Dy Mon FMDD')
      || ' has already been processed in Gusto, so this day can no longer be changed here. Fix it in Gusto, or have the hours added to the next payroll');
  perform pg_temp.ts_v('B16b ... both stored nothing', null, null,
    format($q$select count(*) from public.ts_edits where note in ('zz-wb B16', %L)$q$, mk || ': zz-wb W18'), '0');
  update public.ts_companies set pay_periods = null where key = 'zz_wb_a';

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
