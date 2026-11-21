-- Verification for supabase/ts-edit-cross-period-midnight.sql (Manager Timesheets: a forgotten clock-out Gusto ran past
-- midnight into the next pay period, fixed with a new end on its first day; Gianni 2026-11-21).
--
-- One transaction that ROLLS BACK, in the harness of supabase/ts-edit-whole-shift-blank-day-verify.sql: throwaway companies
-- 'zz_xp_a' (CA) and 'zz_xp_n' (NY), synthetic people "Test Person zz-xp-..." and a throwaway sync key. It plays each identity,
-- records what each can do, returns one pass/fail table and undoes everything. Run it with write access as the project owner
-- (SQL editor, or the management API without read_only) after ts-edit-cross-period-midnight.sql; the last result set is the
-- pass/fail table. Every row must say pass = true.
--
-- Identities (real auth.users rows are needed only for gianni@ and automation@, looked up by email): admin = gianni@ (Google,
-- an active admin row); a department manager = gianni@ set to an active NON-admin row with one department grant (rolled back);
-- automation@ (password) with the sync key in the x-ts-sync-key header (the edit worker).
--
-- The days (TODAY = today in Los Angeles; E = the last day of the previous pay period, always inside the edit window and in the
-- past, E1 = E + 1, the current period's first day, today or earlier; EN, EN1 = the same on the New York clock; N = a day that
-- is not the last day of a pay period, with N + 1 in the past, for the one-period regression). A split is day E with the
-- sync's midnight_split flag and the shift to 11:59:59 PM, and day E1 with the same id from 12:00:00 AM:
--   zz-xp-1   8:15 AM, E1 still clocked in: X1                  zz-xp-2   8:15 AM, E1 to 2:05 AM: X2
--   zz-xp-3   a department manager: X3                          zz-xp-n1  at zz_xp_n (NY, Eastern), EN1 still clocked in: X4
--   zz-xp-n2  at zz_xp_n, punched in Pacific (23:59:59 as written), 4:00 PM to 6:30 AM: X5
--   zz-xp-6, zz-xp-6b, zz-xp-13: the pay period guards (X6, X6b, X13)
--   zz-xp-7   no flag: X7                                       zz-xp-8   E1 ends 11:59:59 PM again: X8
--   zz-xp-9   a break after midnight: X9                        zz-xp-10  a waiting change on E1: X10
--   zz-xp-11  a change on E1 being sent, then sent: X11          zz-xp-12  a waiting note on E1: X12
--   zz-xp-14  ends left at 11:59 PM (a break added, or the start moved), or after midnight: X14
--   zz-xp-15  no E1 row: N1                                     zz-xp-16  E1 shows another id: N2
--   zz-xp-17  E1 in Packaging, a Distro/Trim manager: N3        zz-xp-18  the first part ends 11:58:59 PM: N4
--   zz-xp-19  N to N + 1 in one pay period: N5                  zz-xp-21  a fix sent, then another change before the sync: N6
--   zz-xp-24  a plain delete of the first part: N7               zz-xp-20  TODAY to tomorrow, only when TODAY ends a pay period: X15
--   zz-xp-30, zz-xp-31  day E flagged for ANOTHER shift (one carried in at 12:00 AM), this one 10:00 PM to 6:00 AM: X7b, X7c
--   zz-xp-32  4:35 PM to 2:05 AM, back in at 2:07 AM: X2c         zz-xp-25  a waiting fix put back as Gusto has it: X17
--   zz-xp-26  a waiting fix, then changes of that id on E1: X18  zz-xp-27  a fix cancelled, then a change on E1: X18j
-- X15 can only be checked on a day that ends a pay period: a cross fix needs day N to be one, and its day N + 1 is in the future
-- only when day N is today. Every other row runs on any day and at any time of day (the changes made on E1 are deletes and a
-- note, which no clock check stops).

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

-- A shift Gusto ran past midnight under one id p_id: day p_d (department p_dept1, flagged when p_flag1) from p_in to
-- 11:59:59 PM (p_out1), and, when p_dept2 is given, day p_d + 1 (department p_dept2, flagged when p_flag2) with id p_id2 (else
-- p_id) from 12:00:00 AM to p_out2 (null = still clocked in) with breaks p_brks2. Times on p_tz. Returns day p_d's id.
create function pg_temp.ts_v_xsplit(p_company text, p_region text, p_uuid text, p_d date, p_tz text, p_id text,
                                    p_in text, p_out1 text, p_flag1 boolean, p_dept1 text,
                                    p_out2 text, p_flag2 boolean, p_dept2 text, p_brks2 jsonb default '[]', p_id2 text default null) returns text
language plpgsql as $f$
declare
  v_flag constant jsonb := '[{"code": "midnight_split", "sev": "warn", "msg": "Likely a missed clock-out"}]';
  v_id text;
begin
  v_id := pg_temp.ts_v_day(p_company, p_region, p_uuid, p_dept1, p_d,
            jsonb_build_array(pg_temp.ts_v_shift(p_id, p_d, p_tz, p_in, p_out1, '[]')), case when p_flag1 then v_flag else '[]'::jsonb end);
  if p_dept2 is not null then
    perform pg_temp.ts_v_day(p_company, p_region, p_uuid, p_dept2, p_d + 1,
              jsonb_build_array(pg_temp.ts_v_shift(coalesce(p_id2, p_id), p_d + 1, p_tz, '00:00:00', p_out2, p_brks2)),
              case when p_flag2 then v_flag else '[]'::jsonb end);
  end if;
  return v_id;
end $f$;

-- An after whose end is on another day (p_d2): the in on p_d, the out on p_d2, no breaks.
create function pg_temp.ts_v_after2(p_d date, p_in text, p_d2 date, p_out text, p_tz text) returns jsonb
language sql stable as $f$
  select jsonb_build_object('in', pg_temp.ts_v_z(pg_temp.ts_v_at(p_d, p_in, p_tz)), 'out', pg_temp.ts_v_z(pg_temp.ts_v_at(p_d2, p_out, p_tz)), 'breaks', '[]'::jsonb)
$f$;
-- (owner) what an edit's before carries: 'date/in/out/breaks' of before.carried, or '(no carried)'
create function pg_temp.ts_v_car(p_note text) returns text
language sql as $f$
  select coalesce(string_agg(case when e.before ? 'carried'
                                  then (e.before->'carried'->>'date') || '/' || (e.before->'carried'->>'in') || '/' || coalesce(e.before->'carried'->>'out', '(null)')
                                       || '/' || (e.before->'carried'->'breaks')::text
                                  else '(no carried)' end, ','), '(no edit)')
    from public.ts_edits e where e.note = p_note
$f$;

-- ------------------------------------------------------------------ setup (as owner, rolled back)
select pg_temp.ts_v_gianni(true, true, '[]');
select pg_temp.ts_v_gianni_views('[]');
insert into public.ts_companies (key, name, region) values
  ('zz_xp_a', 'Verify Cross A', 'CA'), ('zz_xp_n', 'Verify Cross NY', 'NY')
on conflict do nothing;
-- the sync key for this run (the worker RPCs check the x-ts-sync-key request header against its sha256)
insert into public.ts_sync_keys (key_hash, label)
values (encode(sha256(convert_to('zz-xp-sync-key', 'utf8')), 'hex'), 'verify cross period (rolled back)');
select set_config('request.headers', '', true);

-- ------------------------------------------------------------------ checks
do $v$
declare
  adm    constant text := 'gianni@wizardtrees.com';
  aut    constant text := 'automation@wizardtrees.com';
  la     constant text := 'America/Los_Angeles';
  nyz    constant text := 'America/New_York';
  key_on constant text := '{"x-ts-sync-key": "zz-xp-sync-key"}';
  today  constant date := (now() at time zone 'America/Los_Angeles')::date;
  -- E: the last day of the previous pay period (periods start on the Saturdays 2026-09-26 + 14k), worked out here independently
  -- of ts_edit_window; E1 = the current period's first day
  e      constant date := date '2026-09-26' + 14 * floor((((now() at time zone 'America/Los_Angeles')::date) - date '2026-09-26') / 14.0)::int - 1;
  e1     constant date := date '2026-09-26' + 14 * floor((((now() at time zone 'America/Los_Angeles')::date) - date '2026-09-26') / 14.0)::int;
  en     constant date := date '2026-09-26' + 14 * floor((((now() at time zone 'America/New_York')::date) - date '2026-09-26') / 14.0)::int - 1;
  t      constant date := (now() at time zone 'America/Los_Angeles')::date - 2;
  -- N: T - 1, unless that is the last day of a pay period; then T - 2 (N and N + 1 in one period)
  n      constant date := case when mod((t - 1) - date '2026-10-09', 14) = 0 then t - 2 else t - 1 end;
  dy     constant text := 'Dy Mon FMDD';
  future constant text := 'ERROR P0001: You cannot edit a day that has not happened yet';
  x_flag constant text := 'ERROR P0001: Only a shift the sync marked as a likely missed clock-out can have its end fixed here across two pay periods. Fix it in Gusto';
  x_long constant text := 'ERROR P0001: Gusto keeps this shift on more than two days under one id. Change it in Gusto';
  d1 text; d2 text; d3 text; dn1 text; dn2 text; d6 text; d6b text; d7 text; d8 text; d9 text; d10 text; d10n text; d11 text; d11n text;
  d12 text; d12n text; d13 text; d14 text; d15 text; d16 text; d17 text; d18 text; d19 text; d20 text; d21 text; d24 text;
  d25 text; d26 text; d26n text; d27 text; d27n text; d30 text; d31 text; d32 text;
  x_end  text;
  x_wait text;
  flg    constant jsonb := '[{"code": "midnight_split", "sev": "warn", "msg": "Likely a missed clock-out"}]';
begin
  x_end := 'ERROR P0001: This shift ran past midnight in Gusto: end it before midnight on ' || to_char(e, dy)
           || ' here (that fixes both days at once). To end it after midnight, change it in Gusto';
  x_wait := 'ERROR P0001: The end of this shift waits to be fixed from ' || to_char(e, dy) || '. Cancel that change first, or reload after the next sync';
  -- ---------------------------------------------------------------- fixtures (as owner)
  d1  := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-1', e, la, 'zz-xp-s1', '08:15:00', '23:59:59', true, 'Distro/Trim', null, false, 'Distro/Trim');
  d2  := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-2', e, la, 'zz-xp-s2', '08:15:00', '23:59:59', true, 'Distro/Trim', '02:05:00', true, 'Distro/Trim');
  d3  := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-3', e, la, 'zz-xp-s3', '08:15:00', '23:59:59', true, 'Distro/Trim', null, false, 'Distro/Trim');
  dn1 := pg_temp.ts_v_xsplit('zz_xp_n', 'NY', 'zz-xp-n1', en, nyz, 'zz-xp-sn1', '08:15:00', '23:59:59', true, 'Distro Hourly', null, false, 'Distro Hourly');
  dn2 := pg_temp.ts_v_xsplit('zz_xp_n', 'NY', 'zz-xp-n2', en, la, 'zz-xp-sn2', '16:00:00', '23:59:59', true, 'Distro Hourly', '06:30:00', true, 'Distro Hourly');
  d6  := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-6', e, la, 'zz-xp-s6', '08:15:00', '23:59:59', true, 'Distro/Trim', null, false, 'Distro/Trim');
  d6b := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-6b', e, la, 'zz-xp-s6b', '08:15:00', '23:59:59', true, 'Distro/Trim', null, false, 'Distro/Trim');
  d7  := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-7', e, la, 'zz-xp-s7', '08:15:00', '23:59:59', false, 'Distro/Trim', '02:05:00', false, 'Distro/Trim');
  d8  := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-8', e, la, 'zz-xp-s8', '08:15:00', '23:59:59', true, 'Distro/Trim', '23:59:59', true, 'Distro/Trim');
  d9  := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-9', e, la, 'zz-xp-s9', '08:15:00', '23:59:59', true, 'Distro/Trim', '02:05:00', true, 'Distro/Trim',
           '[["01:00", "01:10", "rest"]]');
  d10 := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-10', e, la, 'zz-xp-s10', '08:15:00', '23:59:59', true, 'Distro/Trim', '02:05:00', true, 'Distro/Trim');
  d10n := 'zz_xp_a:zz-xp-10:' || to_char(e1, 'YYYY-MM-DD');
  d11 := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-11', e, la, 'zz-xp-s11', '08:15:00', '23:59:59', true, 'Distro/Trim', '02:05:00', true, 'Distro/Trim');
  d11n := 'zz_xp_a:zz-xp-11:' || to_char(e1, 'YYYY-MM-DD');
  d12 := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-12', e, la, 'zz-xp-s12', '08:15:00', '23:59:59', true, 'Distro/Trim', '02:05:00', true, 'Distro/Trim');
  d12n := 'zz_xp_a:zz-xp-12:' || to_char(e1, 'YYYY-MM-DD');
  d13 := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-13', e, la, 'zz-xp-s13', '08:15:00', '23:59:59', true, 'Distro/Trim', null, false, 'Distro/Trim');
  d14 := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-14', e, la, 'zz-xp-s14', '08:15:00', '23:59:59', true, 'Distro/Trim', null, false, 'Distro/Trim');
  d15 := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-15', e, la, 'zz-xp-s15', '08:15:00', '23:59:59', true, 'Distro/Trim', null, false, null);
  d16 := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-16', e, la, 'zz-xp-s16', '08:15:00', '23:59:59', true, 'Distro/Trim', null, false, 'Distro/Trim', '[]', 'zz-xp-s16-other');
  d17 := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-17', e, la, 'zz-xp-s17', '08:15:00', '23:59:59', true, 'Distro/Trim', null, false, 'Packaging');
  d18 := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-18', e, la, 'zz-xp-s18', '08:15:00', '23:58:59', true, 'Distro/Trim', null, false, 'Distro/Trim');
  d19 := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-19', n, la, 'zz-xp-s19', '16:35:06', '23:59:59', true, 'Distro/Trim', '07:03:00', true, 'Distro/Trim');
  d21 := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-21', e, la, 'zz-xp-s21', '08:15:00', '23:59:59', true, 'Distro/Trim', '02:05:00', true, 'Distro/Trim');
  d24 := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-24', e, la, 'zz-xp-s24', '08:15:00', '23:59:59', true, 'Distro/Trim', '02:05:00', true, 'Distro/Trim');
  d25 := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-25', e, la, 'zz-xp-s25', '08:15:00', '23:59:59', true, 'Distro/Trim', null, false, 'Distro/Trim');
  -- E1 has another shift too (zz-xp-s26b, 3:00 to 4:00 AM)
  d26 := pg_temp.ts_v_day('zz_xp_a', 'CA', 'zz-xp-26', 'Distro/Trim', e, jsonb_build_array(pg_temp.ts_v_shift('zz-xp-s26', e, la, '08:15:00', '23:59:59', '[]')), flg);
  d26n := pg_temp.ts_v_day('zz_xp_a', 'CA', 'zz-xp-26', 'Distro/Trim', e1, jsonb_build_array(pg_temp.ts_v_shift('zz-xp-s26', e1, la, '00:00:00', '02:05:00', '[]'),
            pg_temp.ts_v_shift('zz-xp-s26b', e1, la, '03:00:00', '04:00:00', '[]')), flg);
  d27 := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-27', e, la, 'zz-xp-s27', '08:15:00', '23:59:59', true, 'Distro/Trim', '02:05:00', true, 'Distro/Trim');
  d27n := 'zz_xp_a:zz-xp-27:' || to_char(e1, 'YYYY-MM-DD');
  -- day E flagged for the 12:00 AM shift carried in from the day before (another id); this shift 10:00 PM to 6:00 AM, real
  -- overnight work: day E1 not flagged (zz-xp-30), or flagged (zz-xp-31; 8 hours, nobody back in within 5 minutes)
  d30 := pg_temp.ts_v_day('zz_xp_a', 'CA', 'zz-xp-30', 'Distro/Trim', e, jsonb_build_array(pg_temp.ts_v_shift('zz-xp-s30x', e, la, '00:00:00', '07:03:00', '[]'),
            pg_temp.ts_v_shift('zz-xp-s30', e, la, '22:00:00', '23:59:59', '[]')), flg);
  perform pg_temp.ts_v_day('zz_xp_a', 'CA', 'zz-xp-30', 'Distro/Trim', e1, jsonb_build_array(pg_temp.ts_v_shift('zz-xp-s30', e1, la, '00:00:00', '06:00:00', '[]')), '[]');
  d31 := pg_temp.ts_v_day('zz_xp_a', 'CA', 'zz-xp-31', 'Distro/Trim', e, jsonb_build_array(pg_temp.ts_v_shift('zz-xp-s31x', e, la, '00:00:00', '07:03:00', '[]'),
            pg_temp.ts_v_shift('zz-xp-s31', e, la, '22:00:00', '23:59:59', '[]')), flg);
  perform pg_temp.ts_v_day('zz_xp_a', 'CA', 'zz-xp-31', 'Distro/Trim', e1, jsonb_build_array(pg_temp.ts_v_shift('zz-xp-s31', e1, la, '00:00:00', '06:00:00', '[]')), flg);
  -- 4:35 PM to 2:05 AM (under 14 hours), then back in at 2:07 AM: the sync's other sign of a missed clock-out
  d32 := pg_temp.ts_v_day('zz_xp_a', 'CA', 'zz-xp-32', 'Distro/Trim', e, jsonb_build_array(pg_temp.ts_v_shift('zz-xp-s32', e, la, '16:35:06', '23:59:59', '[]')), flg);
  perform pg_temp.ts_v_day('zz_xp_a', 'CA', 'zz-xp-32', 'Distro/Trim', e1, jsonb_build_array(pg_temp.ts_v_shift('zz-xp-s32', e1, la, '00:00:00', '02:05:00', '[]'),
            pg_temp.ts_v_shift('zz-xp-s32b', e1, la, '02:07:00', '06:00:00', '[]')), flg);
  if mod(today - date '2026-10-09', 14) = 0 then
    d20 := pg_temp.ts_v_xsplit('zz_xp_a', 'CA', 'zz-xp-20', today, la, 'zz-xp-s20', '08:15:00', '23:59:59', true, 'Distro/Trim', '02:05:00', true, 'Distro/Trim');
  end if;
  perform set_config('request.headers', key_on, true);

  -- ---------------------------------------------------------------- A. catalog
  perform pg_temp.ts_v('A1 ts_edit_submit keeps its one signature: security definer, search_path=public, run by authenticated, not anon', null, null,
    $q$select count(*) || '/' || bool_and(p.prosecdef and coalesce(array_to_string(p.proconfig, ',') like '%search_path=public%', false))
              || '/' || bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
              || '/' || bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE'))
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'ts_edit_submit'$q$,
    '1/true/true/true');
  perform pg_temp.ts_v('A2 it is this file''s: it knows the cross-period fix, a whole delete, a day with no row, a start alone, and the whole marker byte for byte', null, null,
    $q$select (d like '%v!_cross%' escape '!') || '/' || (d like '%v!_whole%' escape '!') || '/' || (d like '%v!_blank%' escape '!')
              || '/' || (d like '%v!_start!_only%' escape '!')
              || '/' || (strpos(d, 'c_whole    constant text := ''Delete the whole shift on both days'';') > 0)
         from (select pg_get_functiondef('public.ts_edit_submit(text,text,text,jsonb,text,jsonb)'::regprocedure) d) x$q$, 'true/true/true/true/true');
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
                  || case when to_regprocedure('public.ts_flag_dismiss(text,text,text,text)') is not null then 'ts_flag_dismiss,ts_flag_undismiss,' else '' end
                  || 'ts_is_admin,ts_me,ts_my_email,ts_my_grant_keys,ts_my_view_ids,'
                  || case when to_regprocedure('public.ts_pay_periods_sync(text,jsonb)') is not null then 'ts_pay_periods_sync,' else '' end
                  || 'ts_sync'));
  perform pg_temp.ts_v('A5 PUBLIC and anon can execute no edit function, and ts_edit_period_closed stays the owner''s', null, null,
    $q$select count(*) filter (where (p.proname like 'ts!_edit!_%' escape '!' or p.proname like 'ts!_edits!_%' escape '!')
                                    and (has_function_privilege('public', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE')))
              || '/' || bool_or(p.proname = 'ts_edit_period_closed' and has_function_privilege('authenticated', p.oid, 'EXECUTE'))
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'ts\_%'$q$, '0/false');

  -- ---------------------------------------------------------------- X. stored with before.carried (admin)
  perform pg_temp.ts_v('X1 admin: a new end on the first day of a forgotten clock-out that ran into the next pay period, the rest still clocked in', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-xp-s1', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp X1'), 'update/pending/none');
  perform pg_temp.ts_v('X1b ... stored on day E: before is the first part as Gusto has it, before.carried the 12:00 AM part (out null) and its day', null, null,
    $q$select day_id || '/' || shift_id || '/' || action || '/' || (before->>'in') || '/' || (before->>'out') || '/' || (after->>'out')
              || '/' || (before->'carried'->>'date') || '/' || (before->'carried'->>'in') || '/' || jsonb_typeof(before->'carried'->'out')
              || '/' || (before->'carried'->'breaks')::text
         from public.ts_edits where note = 'zz-xp X1'$q$,
    pg_temp.ts_v_lit(d1 || '/zz-xp-s1/update/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(e, '08:15:00', la), la)
                     || '/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(e, '23:59:59', la), la)
                     || '/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(e, '16:45', la), la)
                     || '/' || to_char(e1, 'YYYY-MM-DD') || '/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(e1, '00:00:00', la), la) || '/null/[]'));
  perform pg_temp.ts_v('X1c the worker gets it in its times list (not breaks), with before.carried', 'authenticated', aut,
    format($q$select count(*) filter (where x.k = 't' and e->'before'->'carried'->>'date' = %L) || '/' || count(*) filter (where x.k = 'b')
                from (select 't' k, public.ts_edits_pending('times') l union all select 'b', public.ts_edits_pending('breaks')) x
               cross join lateral jsonb_array_elements(x.l) e where e->>'note' = 'zz-xp X1'$q$, to_char(e1, 'YYYY-MM-DD')), '1/0');
  perform pg_temp.ts_v('X1d a second fix of the same shift replaces the first, and is stored the same way', 'authenticated', adm,
    pg_temp.ts_v_sub(d1, 'zz-xp-s1', 'update', pg_temp.ts_v_after(e, la, '08:15', '17:00', '[]'), 'zz-xp X1d'), 'update/pending/none');
  perform pg_temp.ts_v('X1e ... the first is superseded, the second carries the 12:00 AM part', null, null,
    $q$select pg_temp.ts_v_st('zz-xp X1') || ' ' || pg_temp.ts_v_car('zz-xp X1d')$q$,
    pg_temp.ts_v_lit('cancelled/none/superseded ' || to_char(e1, 'YYYY-MM-DD') || '/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(e1, '00:00:00', la), la) || '/(null)/[]'));
  perform pg_temp.ts_v('X2 the 12:00 AM part closed at 2:05 AM: stored with its clock-out', 'authenticated', adm,
    pg_temp.ts_v_sub(d2, 'zz-xp-s2', 'update', pg_temp.ts_v_after(e, la, '08:15', '21:00', '[]'), 'zz-xp X2'), 'update/pending/none');
  perform pg_temp.ts_v('X2b ... before.carried has 12:00 AM to 2:05 AM on E1', null, null, $q$select pg_temp.ts_v_car('zz-xp X2')$q$,
    pg_temp.ts_v_lit(to_char(e1, 'YYYY-MM-DD') || '/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(e1, '00:00:00', la), la)
                     || '/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(e1, '02:05:00', la), la) || '/[]'));
  perform pg_temp.ts_v('X2c under 14 hours, but back in within 5 minutes of the 2:05 AM end (E1 flagged too): stored with its clock-out', 'authenticated', adm,
    pg_temp.ts_v_sub(d32, 'zz-xp-s32', 'update', pg_temp.ts_v_after(e, la, '16:35:06', '21:00', '[]'), 'zz-xp X2c'), 'update/pending/none');
  perform pg_temp.ts_v('X2d ... before.carried has 12:00 AM to 2:05 AM on E1', null, null, $q$select pg_temp.ts_v_car('zz-xp X2c')$q$,
    pg_temp.ts_v_lit(to_char(e1, 'YYYY-MM-DD') || '/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(e1, '00:00:00', la), la)
                     || '/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(e1, '02:05:00', la), la) || '/[]'));
  perform pg_temp.ts_v('X4 a New York split (Eastern) is fixed the same way', 'authenticated', adm,
    pg_temp.ts_v_sub(dn1, 'zz-xp-sn1', 'update', pg_temp.ts_v_after(en, nyz, '08:15', '16:45', '[]'), 'zz-xp X4'), 'update/pending/none');
  perform pg_temp.ts_v('X4b ... stored with region NY, the 12:00 AM part in Eastern, still clocked in', null, null,
    $q$select region || '/' || pg_temp.ts_v_car('zz-xp X4') from public.ts_edits where note = 'zz-xp X4'$q$,
    pg_temp.ts_v_lit('NY/' || to_char(en + 1, 'YYYY-MM-DD') || '/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(en + 1, '00:00:00', nyz), nyz) || '/(null)/[]'));
  perform pg_temp.ts_v('X5 a New York split punched in Pacific (midnight as written in the punch, not on the Eastern clock) is taken', 'authenticated', adm,
    pg_temp.ts_v_sub(dn2, 'zz-xp-sn2', 'update', pg_temp.ts_v_after(en, la, '16:00', '18:30', '[]'), 'zz-xp X5'), 'update/pending/none');
  perform pg_temp.ts_v('X5b ... stored with the 12:00 AM part as Gusto has it (on the Eastern clock)', null, null, $q$select pg_temp.ts_v_car('zz-xp X5')$q$,
    pg_temp.ts_v_lit(to_char(en + 1, 'YYYY-MM-DD') || '/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(en + 1, '00:00:00', la), nyz)
                     || '/' || pg_temp.ts_v_iso(pg_temp.ts_v_at(en + 1, '06:30:00', la), nyz) || '/[]'));

  -- ---------------------------------------------------------------- X. refused, word for word (admin)
  perform pg_temp.ts_v('X7 no midnight_split flag on day E (real overnight work) is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d7, 'zz-xp-s7', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp X7'), x_flag);
  perform pg_temp.ts_v('X7b day E flagged for another shift (carried in at 12:00 AM), this one real overnight work to 6:00 AM, E1 not flagged: refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d30, 'zz-xp-s30', 'update', pg_temp.ts_v_after(e, la, '22:00', '23:30', '[]'), 'zz-xp X7b'), x_flag);
  perform pg_temp.ts_v('X7c ... and with E1 flagged too, 8 hours and nobody back in within 5 minutes: refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d31, 'zz-xp-s31', 'update', pg_temp.ts_v_after(e, la, '22:00', '23:30', '[]'), 'zz-xp X7c'), x_flag);
  perform pg_temp.ts_v('X8 a shift on more than two days is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d8, 'zz-xp-s8', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp X8'), x_long);
  perform pg_temp.ts_v('X9 a break after midnight is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d9, 'zz-xp-s9', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp X9'),
    'ERROR P0001: Gusto has a break after midnight on this shift (on ' || to_char(e1, dy) || '), which a new end here would leave outside it. Fix it in Gusto');
  perform pg_temp.ts_v('X10a a waiting change of the 12:00 AM part (a delete: no clock check) ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d10n, 'zz-xp-s10', 'delete', null, 'zz-xp X10a'), 'delete/none/pending');
  perform pg_temp.ts_v('X10 ... blocks the fix', 'authenticated', adm,
    pg_temp.ts_v_sub(d10, 'zz-xp-s10', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp X10'),
    'ERROR P0001: A change of this shift on ' || to_char(e1, dy) || ' is waiting or was just sent to Gusto. Cancel it there, or reload after the next sync, then try again');
  perform pg_temp.ts_v('X11a a change of the 12:00 AM part (a delete) ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d11n, 'zz-xp-s11', 'delete', null, 'zz-xp X11a'), 'delete/none/pending');
  perform pg_temp.ts_v('X11b ... that the worker claims ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-xp X11a'), 'breaks', 'applying', null), 'applying/(none)/false');
  perform pg_temp.ts_v('X11c ... (being sent blocks the fix) ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d11, 'zz-xp-s11', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp X11c'),
    'ERROR P0001: A change of this shift on ' || to_char(e1, dy) || ' is waiting or was just sent to Gusto. Cancel it there, or reload after the next sync, then try again');
  perform pg_temp.ts_v('X11d ... and sends ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-xp X11a'), 'breaks', 'applied', null), 'applied/(none)/true');
  perform pg_temp.ts_v('X11 ... sent since that row''s sync blocks the fix', 'authenticated', adm,
    pg_temp.ts_v_sub(d11, 'zz-xp-s11', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp X11'),
    'ERROR P0001: A change of this shift on ' || to_char(e1, dy) || ' is waiting or was just sent to Gusto. Cancel it there, or reload after the next sync, then try again');
  -- (owner) day E1's row synced after the change went
  update public.ts_days set synced_at = now() + interval '1 minute' where id = d11n;
  perform pg_temp.ts_v('X11e ... after day E1''s next sync, the fix goes', 'authenticated', adm,
    pg_temp.ts_v_sub(d11, 'zz-xp-s11', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp X11e'), 'update/pending/none');
  perform pg_temp.ts_v('X12a a waiting note on the 12:00 AM part ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d12n, 'zz-xp-s12', 'note', null, 'zz-xp X12a'), 'note/none/pending');
  perform pg_temp.ts_v('X12 ... does not block the fix', 'authenticated', adm,
    pg_temp.ts_v_sub(d12, 'zz-xp-s12', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp X12'), 'update/pending/none');
  perform pg_temp.ts_v('X12b ... stored with before.carried', null, null, $q$select (before->'carried'->>'date') from public.ts_edits where note = 'zz-xp X12'$q$,
    to_char(e1, 'YYYY-MM-DD'));
  perform pg_temp.ts_v('X14 an end left at 11:59 PM with a break added is refused (the same times and breaks as Gusto are a put-back: X17)', 'authenticated', adm,
    pg_temp.ts_v_sub(d14, 'zz-xp-s14', 'update', pg_temp.ts_v_after(e, la, '08:15', '23:59', '[["12:00", "12:30", "meal"]]'), 'zz-xp X14'), x_end);
  perform pg_temp.ts_v('X14b ... and so is an end after midnight (on E1)', 'authenticated', adm,
    pg_temp.ts_v_sub(d14, 'zz-xp-s14', 'update', pg_temp.ts_v_after2(e, '08:15', e1, '01:00', la), 'zz-xp X14b'), x_end);
  perform pg_temp.ts_v('X14c ... and a start moved with the end kept at 11:59:59 PM', 'authenticated', adm,
    pg_temp.ts_v_sub(d14, 'zz-xp-s14', 'update', pg_temp.ts_v_after(e, la, '09:00', '23:59:59', '[]'), 'zz-xp X14c'), x_end);
  perform pg_temp.ts_v('X14d ... while 11:58 PM is taken', 'authenticated', adm,
    pg_temp.ts_v_sub(d14, 'zz-xp-s14', 'update', pg_temp.ts_v_after(e, la, '08:15', '23:58', '[]'), 'zz-xp X14d'), 'update/pending/none');
  -- a waiting fix put back exactly as Gusto has it (the page's take-back): a plain update that replaces it
  perform pg_temp.ts_v('X17a a fix of a shift that ran into the next pay period ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d25, 'zz-xp-s25', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp X17a'), 'update/pending/none');
  perform pg_temp.ts_v('X17 ... put back to 11:59 PM, as Gusto has it: a plain take-back (nothing goes to Gusto)', 'authenticated', adm,
    pg_temp.ts_v_subx(d25, 'zz-xp-s25', 'update', pg_temp.ts_v_after(e, la, '08:15', '23:59', '[]'), 'zz-xp X17',
                      jsonb_build_array(pg_temp.ts_v_id('zz-xp X17a')::text)), 'update/none/none');
  perform pg_temp.ts_v('X17b ... it replaced the fix, and keeps no carried part', null, null,
    $q$select pg_temp.ts_v_st('zz-xp X17a') || ' ' || pg_temp.ts_v_car('zz-xp X17')$q$, 'cancelled/none/superseded (no carried)');
  perform pg_temp.ts_v('X17c ... put back again with nothing waiting: nothing changed', 'authenticated', adm,
    pg_temp.ts_v_subx(d25, 'zz-xp-s25', 'update', pg_temp.ts_v_after(e, la, '08:15', '23:59:59', '[]'), 'zz-xp X17c', '[]'),
    'ERROR P0001: Nothing changed: the shift already has these times and breaks');
  perform pg_temp.ts_v('X17d ... fixed again ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d25, 'zz-xp-s25', 'update', pg_temp.ts_v_after(e, la, '08:15', '17:00', '[]'), 'zz-xp X17d'), 'update/pending/none');
  perform pg_temp.ts_v('X17e ... and put back with Gusto''s own 11:59:59 PM: the same take-back', 'authenticated', adm,
    pg_temp.ts_v_subx(d25, 'zz-xp-s25', 'update', pg_temp.ts_v_after(e, la, '08:15', '23:59:59', '[]'), 'zz-xp X17e',
                      jsonb_build_array(pg_temp.ts_v_id('zz-xp X17d')::text)), 'update/none/none');
  perform pg_temp.ts_v('X17f ... which replaced that fix too', null, null,
    $q$select pg_temp.ts_v_st('zz-xp X17d') || ' ' || pg_temp.ts_v_car('zz-xp X17e')$q$, 'cancelled/none/superseded (no carried)');

  -- while a fix waits on E, is being sent, or was sent since E1's last sync, nothing else changes that id on E1
  perform pg_temp.ts_v('X18a a fix waits on day E ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d26, 'zz-xp-s26', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp X18a'), 'update/pending/none');
  perform pg_temp.ts_v('X18 ... so a delete of its 12:00 AM part on E1 is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d26n, 'zz-xp-s26', 'delete', null, 'zz-xp X18'), x_wait);
  perform pg_temp.ts_v('X18b ... and so is a note there (it would have nowhere to go)', 'authenticated', adm,
    pg_temp.ts_v_sub(d26n, 'zz-xp-s26', 'note', null, 'zz-xp X18b'), x_wait);
  perform pg_temp.ts_v('X18c ... while another shift on E1 still takes a change', 'authenticated', adm,
    pg_temp.ts_v_sub(d26n, 'zz-xp-s26b', 'delete', null, 'zz-xp X18c'), 'delete/none/pending');
  perform pg_temp.ts_v('X18d the worker claims the fix ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-xp X18a'), 'times', 'applying', null), 'applying/(none)/false');
  perform pg_temp.ts_v('X18e ... (being sent: refused) ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d26n, 'zz-xp-s26', 'delete', null, 'zz-xp X18e'), x_wait);
  perform pg_temp.ts_v('X18f ... and sends it ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-xp X18a'), 'times', 'applied', null), 'applied/(none)/true');
  perform pg_temp.ts_v('X18g ... (sent since E1''s last sync: refused) ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d26n, 'zz-xp-s26', 'delete', null, 'zz-xp X18g'), x_wait);
  -- (owner) day E1's row synced after the fix went
  update public.ts_days set synced_at = now() + interval '1 minute' where id = d26n;
  perform pg_temp.ts_v('X18h ... after E1''s next sync, a change there goes again', 'authenticated', adm,
    pg_temp.ts_v_sub(d26n, 'zz-xp-s26', 'delete', null, 'zz-xp X18h'), 'delete/none/pending');
  perform pg_temp.ts_v('X18i a fix ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d27, 'zz-xp-s27', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp X18i'), 'update/pending/none');
  perform pg_temp.ts_v('X18j ... cancelled ...', 'authenticated', adm, pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-xp X18i')), 'cancelled/none/' || adm);
  perform pg_temp.ts_v('X18k ... no longer stops a change of its 12:00 AM part on E1', 'authenticated', adm,
    pg_temp.ts_v_sub(d27n, 'zz-xp-s27', 'delete', null, 'zz-xp X18k'), 'delete/none/pending');
  if d20 is not null then
    perform pg_temp.ts_v('X15 a split whose 12:00 AM part is tomorrow is refused (TODAY ends a pay period)', 'authenticated', adm,
      pg_temp.ts_v_sub(d20, 'zz-xp-s20', 'update', pg_temp.ts_v_after(today, la, '08:15', '16:45', '[]'), 'zz-xp X15'), future);
  else
    perform pg_temp.ts_v('X15 a split whose 12:00 AM part is tomorrow (only checked on a day that ends a pay period; today does not)', null, null,
      $q$select 'not checked today'$q$, 'not checked today');
  end if;

  -- ---------------------------------------------------------------- N. not this fix: stored exactly as before, with no carried part
  perform pg_temp.ts_v('N1 no row on day E1: an ordinary update', 'authenticated', adm,
    pg_temp.ts_v_sub(d15, 'zz-xp-s15', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp N1'), 'update/pending/none');
  perform pg_temp.ts_v('N2 day E1 shows another id: an ordinary update', 'authenticated', adm,
    pg_temp.ts_v_sub(d16, 'zz-xp-s16', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp N2'), 'update/pending/none');
  perform pg_temp.ts_v('N4 a first part that ends 11:58:59 PM: an ordinary update', 'authenticated', adm,
    pg_temp.ts_v_sub(d18, 'zz-xp-s18', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp N4'), 'update/pending/none');
  perform pg_temp.ts_v('N5 a new end on a split in one pay period (the fix of before): an ordinary update', 'authenticated', adm,
    pg_temp.ts_v_sub(d19, 'zz-xp-s19', 'update', pg_temp.ts_v_after(n, la, '16:35:06', '21:00', '[]'), 'zz-xp N5'), 'update/pending/none');
  perform pg_temp.ts_v('N6a a fix ...', 'authenticated', adm,
    pg_temp.ts_v_sub(d21, 'zz-xp-s21', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp N6a'), 'update/pending/none');
  perform pg_temp.ts_v('N6b ... the worker claims it ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-xp N6a'), 'times', 'applying', null), 'applying/(none)/false');
  perform pg_temp.ts_v('N6c ... and sends it ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-xp N6a'), 'times', 'applied', null), 'applied/(none)/true');
  perform pg_temp.ts_v('N6 ... then, before the next sync, another change of day E is an ordinary update (Gusto now ends it at 4:45 PM)', 'authenticated', adm,
    pg_temp.ts_v_sub(d21, 'zz-xp-s21', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:30', '[]'), 'zz-xp N6'), 'update/pending/none');
  perform pg_temp.ts_v('N6d ... whose before is the end that was sent', null, null, $q$select before->>'out' from public.ts_edits where note = 'zz-xp N6'$q$,
    pg_temp.ts_v_iso(pg_temp.ts_v_at(e, '16:45', la), la));
  perform pg_temp.ts_v('N7 a plain delete of the first part is stored as before (on a delete, a carried part would mean a whole delete)', 'authenticated', adm,
    pg_temp.ts_v_sub(d24, 'zz-xp-s24', 'delete', null, 'zz-xp N7'), 'delete/none/pending');
  perform pg_temp.ts_v('N8 none of N1 to N7 carries a 12:00 AM part', null, null,
    $q$select string_agg(pg_temp.ts_v_car(x), ',' order by x) from unnest(array['zz-xp N1', 'zz-xp N2', 'zz-xp N4', 'zz-xp N5', 'zz-xp N6', 'zz-xp N7']) x$q$,
    '(no carried),(no carried),(no carried),(no carried),(no carried),(no carried)');

  -- ---------------------------------------------------------------- X and N. a department manager (zz_xp_a / Distro/Trim)
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"zz_xp_a","department":"Distro/Trim"}]');
  perform pg_temp.ts_v('X3 a department manager fixes one', 'authenticated', adm,
    pg_temp.ts_v_sub(d3, 'zz-xp-s3', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp X3'), 'update/pending/none');
  perform pg_temp.ts_v('X3b ... stored with before.carried, and the manager reads it back', 'authenticated', adm,
    $q$select count(*) || '/' || min(before->'carried'->>'date') from public.ts_edits where note = 'zz-xp X3'$q$, '1/' || to_char(e1, 'YYYY-MM-DD'));
  perform pg_temp.ts_v('N3 day E1 in a department the manager cannot see: an ordinary update, which tells nothing about that day', 'authenticated', adm,
    pg_temp.ts_v_sub(d17, 'zz-xp-s17', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp N3'), 'update/pending/none');
  perform pg_temp.ts_v('N3b ... with no carried part', null, null, $q$select pg_temp.ts_v_car('zz-xp N3')$q$, '(no carried)');
  perform pg_temp.ts_v_gianni(true, true, '[]');

  perform pg_temp.ts_v('X16 the refused fixes stored nothing', null, null,
    $q$select count(*) from public.ts_edits where note ~ '^zz-xp (X7|X7b|X7c|X8|X9|X10|X11|X11c|X14|X14b|X14c|X15|X17c|X18|X18b|X18e|X18g)$'$q$, '0');

  -- ---------------------------------------------------------------- pay periods (zz_xp_a): sent, processed, and the next one closed
  update public.ts_companies
     set pay_periods = jsonb_build_array(jsonb_build_object('start', e - 13, 'end', e, 'schedule', 'zz-xp-sched', 'closed', false,
                                                            'why', null, 'sent_at', now() - interval '1 hour', 'processed_at', null))
   where key = 'zz_xp_a';
  perform pg_temp.ts_v('X6 day E''s pay period sent to payroll (not processed): the fix is still taken', 'authenticated', adm,
    pg_temp.ts_v_sub(d6, 'zz-xp-s6', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp X6'), 'update/pending/none');
  perform pg_temp.ts_v('X6c ... with before.carried', null, null, $q$select (before->'carried'->>'date') from public.ts_edits where note = 'zz-xp X6'$q$, to_char(e1, 'YYYY-MM-DD'));
  update public.ts_companies
     set pay_periods = jsonb_build_array(jsonb_build_object('start', e - 13, 'end', e, 'schedule', 'zz-xp-sched', 'closed', true,
                                                            'why', 'processed', 'sent_at', null, 'processed_at', null))
   where key = 'zz_xp_a';
  perform pg_temp.ts_v('X6b day E''s pay period processed: the payroll answer', 'authenticated', adm,
    pg_temp.ts_v_sub(d6b, 'zz-xp-s6b', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp X6b'),
    'ERROR P0001: Payroll for ' || to_char(e - 13, dy) || ' to ' || to_char(e, dy)
      || ' has already been processed in Gusto, so this day can no longer be changed here. Fix it in Gusto, or have the hours added to the next payroll');
  update public.ts_companies
     set pay_periods = jsonb_build_array(
           jsonb_build_object('start', e - 13, 'end', e, 'schedule', 'zz-xp-sched', 'closed', false, 'why', null, 'sent_at', null, 'processed_at', null),
           jsonb_build_object('start', e1, 'end', e1 + 13, 'schedule', 'zz-xp-sched', 'closed', true, 'why', 'locked', 'sent_at', null, 'processed_at', null))
   where key = 'zz_xp_a';
  perform pg_temp.ts_v('X13 day E1''s pay period closed in Gusto (day E''s still open): refused', 'authenticated', adm,
    pg_temp.ts_v_sub(d13, 'zz-xp-s13', 'update', pg_temp.ts_v_after(e, la, '08:15', '16:45', '[]'), 'zz-xp X13'),
    'ERROR P0001: The rest of this shift (on ' || to_char(e1, dy) || ') is in a pay period Gusto has closed, so its end cannot be fixed here. Fix it in Gusto');
  perform pg_temp.ts_v('X13b ... both stored nothing', null, null, $q$select count(*) from public.ts_edits where note in ('zz-xp X6b', 'zz-xp X13')$q$, '0');
  update public.ts_companies set pay_periods = null where key = 'zz_xp_a';

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
