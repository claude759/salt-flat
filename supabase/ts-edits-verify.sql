-- RLS + RPC verification for supabase/ts-edits.sql (Manager Gusto Timesheets: managers edit shifts).
--
-- One transaction that ROLLS BACK, in the same harness as supabase/ts-ca-timesheets-verify.sql: it
-- writes throwaway rows (temporary companies 'zz_ed_a' and 'zz_ed_b' (CA) and 'zz_ed_ny' (NY),
-- synthetic people "Test Person zz-ed-...", day rows dated relative to TODAY so they fall inside
-- and outside the edit window, views 'zz-ed-...', a throwaway creator email
-- zz-ed-other@wizardtrees.com, a throwaway sync key), plays each identity, records what each one can
-- see or do, returns one pass/fail table, and undoes everything. Run it with write access as the
-- project owner (SQL editor or the management API without read_only) after the four earlier ts
-- files and ts-edits.sql; the API shows the last result set, which is the pass/fail table. Every
-- row must say pass = true.
--
-- Identities (real auth.users rows are needed only for gianni@ and automation@, looked up by email;
-- each session carries a JWT amr 'oauth' unless a check says otherwise, and automation@ always signs
-- in with a password):
--   anon                  role anon, no JWT
--   stranger              role authenticated, a random sub with no auth.users and no ts_access row
--   automation@           the sync account (password): no ts_access row; the workers' identity
--   BA                    gianni@ (Google) with his ts_access row removed: any Google sign-in
--                         that is not on the allowlist
--   admin                 gianni@ (Google), an active admin row
--   password session      gianni@ signed in by password / OTP / a JWT without amr
--   managers              gianni@ (Google) set to an active NON-admin row with, in turn: one
--                         department grant; one view with one person; a '@uuid:' department grant
--                         plus a view person (the reserved-name collisions); ('*','*'); a NY grant
--   inactive              the same with active = false (manager, then admin)
-- The manager states are set on gianni's own row as the owner (rolled back), as in the other verify
-- scripts; his real view grants, if any, are cleared first (rolled back too). Expected rows are
-- computed as the owner (no RLS), so real rows already in the tables do not break the checks.
--
-- The synthetic days (TODAY = today in Los Angeles, T = TODAY - 2, W = first day of the previous pay
-- period, NT = today in New York - 2, TF = the Los Angeles date 30 minutes ago, so today or yesterday)
-- and why each is there. Recent days are two days back, so no shift in a check ends later than now
-- whatever time the script runs (the server refuses an end more than 5 minutes after now). Every day
-- row is stamped synced_at one hour ago, so a part a worker marks applied during the run counts as
-- applied since the last sync.
--   a1 zz_ed_a  zz-ed-1 Distro/Trim     T     shifts s1 8:00-4:30 (rest 10:00-10:10, meal 12:00-12:30), s2 5-7 PM
--   a2 zz_ed_a  zz-ed-1 Distro/Trim     W     s3 8-4: the oldest editable day
--   a3 zz_ed_a  zz-ed-1 Distro/Trim     W-1   s4: one day too old
--   a4 zz_ed_a  zz-ed-1 Distro/Trim     TODAY+1  s5: the future
--   a5 zz_ed_a  zz-ed-2 Cultivation     T     s6: another department of the same company; later the
--                                             apply-then-revert and just-deleted checks
--   a6 zz_ed_a  zz-ed-4 Packing         T     s8: reached only as a view's person member
--   a7 zz_ed_a  zz-ed-5 "@uuid:zz-ed-1" T     s10: a department spelled like a person key
--   a8 zz_ed_a  zz-ed-6 Distro/Trim     T     s11 still clocked in, with an open meal break
--   aF zz_ed_a  zz-ed-7 Distro/Trim     TF    no shifts: an add around now (the end-later-than-now rule)
--   aH zz_ed_a  zz-ed-10 Distro/Trim    T     h1: hours entered in Gusto without clock times
--   aS zz_ed_a  zz-ed-12 Distro/Trim    T     s15 1:48:42 PM to 5:09:49 PM with a meal Gusto put at 1:48:00
--                                             (42 s before the clock-in, as in live data); later p_expect
--   aX zz_ed_a  zz-ed-11 Distro/Trim    T     s14 8-4: moved to Cultivation and back (who sees its edits)
--   b1 zz_ed_b  zz-ed-3 Distro/Trim     T     s7: the same department name at another company
--   n1 zz_ed_ny zz-ed-9 Distro Hourly   NT    s9 8-4 Eastern (meal 12:00-12:30)
--   n2 zz_ed_ny zz-ed-8 Distro Hourly   NT-1  s12 11:30 PM to 3 AM PACIFIC (a New York BA punching in California):
--                                             in Eastern its start falls on the next date

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
-- A local clock time on a date in a zone; '+hh:mm' = that time on the next day.
create function pg_temp.ts_v_at(p_d date, p_hm text, p_tz text) returns timestamptz
language sql stable as $f$
  select case when p_hm is null then null
              when left(p_hm, 1) = '+' then ((p_d + 1) + substr(p_hm, 2)::time) at time zone p_tz
              else (p_d + p_hm::time) at time zone p_tz end
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
-- p_brks = [["10:00", "10:10", "rest"], ...] on day p_d ('+hh:mm' = next day).
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

-- The same shift as ts-edits.sql should store it (row-zone offsets; give the breaks in time order).
create function pg_temp.ts_v_stored(p_d date, p_tz text, p_in text, p_out text, p_brks jsonb) returns jsonb
language sql as $f$
  select jsonb_build_object(
    'in',  pg_temp.ts_v_iso(pg_temp.ts_v_at(p_d, p_in, p_tz), p_tz),
    'out', pg_temp.ts_v_iso(pg_temp.ts_v_at(p_d, p_out, p_tz), p_tz),
    'breaks', coalesce((select jsonb_agg(jsonb_build_object(
                          'start', pg_temp.ts_v_iso(pg_temp.ts_v_at(p_d, b->>0, p_tz), p_tz),
                          'end',   pg_temp.ts_v_iso(pg_temp.ts_v_at(p_d, b->>1, p_tz), p_tz),
                          'kind',  b->2) order by o)
                          from jsonb_array_elements(p_brks) with ordinality t(b, o)), '[]'::jsonb))
$f$;

-- A ts_days shift as the producer writes it (times in the row zone with offsets).
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
create function pg_temp.ts_v_day(p_company text, p_region text, p_uuid text, p_dept text, p_d date, p_shifts jsonb) returns text
language sql as $f$
  insert into public.ts_days (id, company, region, employee_uuid, employee_name, department, work_date, first_in, last_out, shifts, "open", synced_at)
  values (p_company || ':' || p_uuid || ':' || to_char(p_d, 'YYYY-MM-DD'), p_company, p_region, p_uuid, 'Test Person ' || p_uuid,
          p_dept, p_d, (p_shifts->0->>'in')::timestamptz, (p_shifts->-1->>'out')::timestamptz, p_shifts,
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
-- (owner) what the worker's list for a part should be, worked out here: the synthetic edits whose
-- part is pending, or claimed more than 15 minutes ago, oldest first
create function pg_temp.ts_v_queue(p_part text) returns text
language sql as $f$
  select coalesce(string_agg(e.id::text, ',' order by e.created_at, e.id), '(none)') from public.ts_edits e
   where e.day_id like 'zz!_ed!_%' escape '!'
     and case p_part
           when 'times' then e.times_status = 'pending' or (e.times_status = 'applying' and e.times_claimed_at < now() - interval '15 minutes')
           else e.breaks_status = 'pending' or (e.breaks_status = 'applying' and e.breaks_claimed_at < now() - interval '15 minutes') end
$f$;

-- ------------------------------------------------------------------ setup (as owner, rolled back)
select pg_temp.ts_v_gianni(true, true, '[]');
select pg_temp.ts_v_gianni_views('[]');
insert into public.ts_companies (key, name, region) values
  ('zz_ed_a', 'Verify Edits A', 'CA'), ('zz_ed_b', 'Verify Edits B', 'CA'), ('zz_ed_ny', 'Verify Edits NY', 'NY')
on conflict do nothing;
insert into public.ts_views (id, label, sort, members, updated_by) values
  ('zz-ed-v1', 'Verify Edits One', 991, '[{"company":"zz_ed_a","employee_uuid":"zz-ed-4"}]', 'verify'),
  ('zz-ed-v2', 'Verify Edits Two', 992, '[{"company":"zz_ed_a","employee_uuid":"zz-ed-1"}]', 'verify');
-- the sync key for this run (the worker RPCs check the x-ts-sync-key request header against its sha256)
insert into public.ts_sync_keys (key_hash, label)
values (encode(sha256(convert_to('zz-ed-sync-key', 'utf8')), 'hex'), 'verify edits (rolled back)');
select set_config('request.headers', '', true);

-- ------------------------------------------------------------------ checks
do $v$
declare
  adm  constant text := 'gianni@wizardtrees.com';
  aut  constant text := 'automation@wizardtrees.com';
  oth  constant text := 'zz-ed-other@wizardtrees.com';
  la   constant text := 'America/Los_Angeles';
  nyz  constant text := 'America/New_York';
  today  constant date := (now() at time zone 'America/Los_Angeles')::date;
  ntoday constant date := (now() at time zone 'America/New_York')::date;
  -- the recent fixture days: two days back, always inside the window (it reaches 14+ days back)
  t    constant date := (now() at time zone 'America/Los_Angeles')::date - 2;
  nt   constant date := (now() at time zone 'America/New_York')::date - 2;
  -- the Los Angeles date of 30 minutes ago: an add from then to just after now starts on it
  tf   constant date := ((now() - interval '30 minutes') at time zone 'America/Los_Angeles')::date;
  -- the first day of the previous pay period, worked out here independently of ts_edit_window:
  -- periods start on the Saturdays 2026-09-26 + 14k, and the previous one starts 14 days before
  -- the current one
  w    constant date := date '2026-09-26' + 14 * floor((((now() at time zone 'America/Los_Angeles')::date) - date '2026-09-26') / 14.0)::int - 14;
  nw   constant date := date '2026-09-26' + 14 * floor((((now() at time zone 'America/New_York')::date) - date '2026-09-26') / 14.0)::int - 14;
  a1 text; a2 text; a3 text; a4 text; a5 text; a6 text; a7 text; a8 text; b1 text; n1 text; n2 text;
  af text; ah text; as_ text; ax text;
  being_sent constant text := 'ERROR P0001: A change of this shift is being sent to Gusto right now. Try again in a few minutes';
  someone    constant text := 'ERROR P0001: Someone changed this shift since you opened it. Reload and try again';
  s1_brks  constant jsonb := '[["10:00","10:10","rest"],["12:00","12:30","meal"]]';
  base_a2  jsonb;   -- a2's shift s3 as it is (08:00 to 16:00, no breaks), as the page sends it
  only_sign_ins constant text := 'ERROR 42501: Only timesheet sign-ins can edit timesheets';
  cant_cancel   constant text := 'ERROR 42501: Only timesheet sign-ins can cancel edits';
  no_day        constant text := 'ERROR 42501: No such day, or you cannot edit it';
  -- everything the caller can read in ts_edits, and what the reference rule allows: the edit's own
  -- keys, or its day row as it is now
  rls_e constant text := $q$select md5(coalesce((select string_agg(id::text, ',' order by id) from public.ts_edits), ''))$q$;
  ref_e constant text := $q$select md5(coalesce((select string_agg(e.id::text, ',' order by e.id) from public.ts_edits e
                                                   where public.ts_can_view(e.company, e.department, e.employee_uuid)
                                                      or exists (select 1 from public.ts_days d where d.id = e.day_id
                                                                    and public.ts_can_view(d.company, d.department, d.employee_uuid))), ''))$q$;
  -- the synthetic days the caller sees edits of = the synthetic day rows the caller sees (every
  -- synthetic day has at least one edit), then how many
  same_q constant text := $q$select (coalesce((select string_agg(distinct day_id, ',' order by day_id) from public.ts_edits where day_id like 'zz!_ed!_%' escape '!'), '')
                                   = coalesce((select string_agg(id, ',' order by id) from public.ts_days where id like 'zz!_ed!_%' escape '!'), ''))::text
                                 || '/' || (select count(distinct day_id) from public.ts_edits where day_id like 'zz!_ed!_%' escape '!')$q$;
  ecount constant text := 'select count(*) from public.ts_edits';
  pend_times constant text := $q$select coalesce(string_agg(e->>'id', ',' order by o), '(none)') from jsonb_array_elements(public.ts_edits_pending('times')) with ordinality x(e, o) where e->>'day_id' like 'zz!_ed!_%' escape '!'$q$;
  pend_brks  constant text := $q$select coalesce(string_agg(e->>'id', ',' order by o), '(none)') from jsonb_array_elements(public.ts_edits_pending('breaks')) with ordinality x(e, o) where e->>'day_id' like 'zz!_ed!_%' escape '!'$q$;
begin
  -- ---------------------------------------------------------------- fixtures (as owner)
  a1 := pg_temp.ts_v_day('zz_ed_a', 'CA', 'zz-ed-1', 'Distro/Trim', t, jsonb_build_array(
          pg_temp.ts_v_shift('zz-ed-s1', t, la, '08:00', '16:30', s1_brks),
          pg_temp.ts_v_shift('zz-ed-s2', t, la, '17:00', '19:00', '[]')));
  a2 := pg_temp.ts_v_day('zz_ed_a', 'CA', 'zz-ed-1', 'Distro/Trim', w, jsonb_build_array(pg_temp.ts_v_shift('zz-ed-s3', w, la, '08:00', '16:00', '[]')));
  a3 := pg_temp.ts_v_day('zz_ed_a', 'CA', 'zz-ed-1', 'Distro/Trim', w - 1, jsonb_build_array(pg_temp.ts_v_shift('zz-ed-s4', w - 1, la, '08:00', '16:00', '[]')));
  a4 := pg_temp.ts_v_day('zz_ed_a', 'CA', 'zz-ed-1', 'Distro/Trim', today + 1, jsonb_build_array(pg_temp.ts_v_shift('zz-ed-s5', today + 1, la, '08:00', '16:00', '[]')));
  a5 := pg_temp.ts_v_day('zz_ed_a', 'CA', 'zz-ed-2', 'Cultivation', t, jsonb_build_array(pg_temp.ts_v_shift('zz-ed-s6', t, la, '07:00', '15:00', '[]')));
  a6 := pg_temp.ts_v_day('zz_ed_a', 'CA', 'zz-ed-4', 'Packing', t, jsonb_build_array(pg_temp.ts_v_shift('zz-ed-s8', t, la, '09:00', '17:00', '[]')));
  a7 := pg_temp.ts_v_day('zz_ed_a', 'CA', 'zz-ed-5', '@uuid:zz-ed-1', t, jsonb_build_array(pg_temp.ts_v_shift('zz-ed-s10', t, la, '08:00', '12:00', '[]')));
  a8 := pg_temp.ts_v_day('zz_ed_a', 'CA', 'zz-ed-6', 'Distro/Trim', t, jsonb_build_array(
          pg_temp.ts_v_shift('zz-ed-s11', t, la, '08:00', null, '[["12:00",null,"meal"]]')));
  b1 := pg_temp.ts_v_day('zz_ed_b', 'CA', 'zz-ed-3', 'Distro/Trim', t, jsonb_build_array(pg_temp.ts_v_shift('zz-ed-s7', t, la, '08:00', '16:00', '[]')));
  n1 := pg_temp.ts_v_day('zz_ed_ny', 'NY', 'zz-ed-9', 'Distro Hourly', nt, jsonb_build_array(
          pg_temp.ts_v_shift('zz-ed-s9', nt, nyz, '08:00', '16:00', '[["12:00","12:30","meal"]]')));
  n2 := pg_temp.ts_v_day('zz_ed_ny', 'NY', 'zz-ed-8', 'Distro Hourly', nt - 1, jsonb_build_array(
          pg_temp.ts_v_shift('zz-ed-s12', nt - 1, la, '23:30', '+03:00', '[]')));
  af := pg_temp.ts_v_day('zz_ed_a', 'CA', 'zz-ed-7', 'Distro/Trim', tf, '[]');
  ah := pg_temp.ts_v_day('zz_ed_a', 'CA', 'zz-ed-10', 'Distro/Trim', t, jsonb_build_array(
          pg_temp.ts_v_shift('zz-ed-h1', t, la, '00:00', '23:59:59', '[]') || '{"hours_only": true, "span_min": 480, "worked_min": 480}'));
  update public.ts_days set hours_only = true, worked_min = 480 where id = ah;
  as_ := pg_temp.ts_v_day('zz_ed_a', 'CA', 'zz-ed-12', 'Distro/Trim', t, jsonb_build_array(
          pg_temp.ts_v_shift('zz-ed-s15', t, la, '13:48:42', '17:09:49', '[["13:48:00","14:18:00","meal"]]')));
  ax := pg_temp.ts_v_day('zz_ed_a', 'CA', 'zz-ed-11', 'Distro/Trim', t, jsonb_build_array(pg_temp.ts_v_shift('zz-ed-s14', t, la, '08:00', '16:00', '[]')));
  base_a2 := pg_temp.ts_v_after(w, la, '08:00', '16:00', '[]');

  -- ---------------------------------------------------------------- A. catalog
  perform pg_temp.ts_v('A1 RLS is on for ts_edits', null, null,
    $q$select relrowsecurity::text from pg_class where oid = 'public.ts_edits'::regclass$q$, 'true');
  perform pg_temp.ts_v('A2 ts_edits has exactly one policy: SELECT to authenticated', null, null,
    $q$select count(*) || '/' || string_agg(cmd || ':' || array_to_string(roles, ','), ',') from pg_policies
        where schemaname = 'public' and tablename = 'ts_edits'$q$, '1/SELECT:authenticated');
  perform pg_temp.ts_v('A3 the ts_edits policy is the ts_days policy word for word, OR the edit''s day row is visible', null, null,
    $q$select starts_with((select qual from pg_policies where schemaname = 'public' and tablename = 'ts_edits'),
                          (select left(qual, length(qual) - 1) || ' OR (EXISTS' from pg_policies where schemaname = 'public' and tablename = 'ts_days'))::text
              || '/' || (select (qual like '%@uuid:%' and qual like '%ts!_my!_grant!_keys()%' escape '!' and qual like '%ts!_is!_admin()%' escape '!'
                                 and qual like '%OR (EXISTS ( SELECT 1%FROM ts!_days d%WHERE (d.id = ts!_edits.day!_id))))' escape '!')::text
                           from pg_policies where schemaname = 'public' and tablename = 'ts_edits')$q$, 'true/true');
  perform pg_temp.ts_v('A4 anon holds no privilege on ts_edits', null, null,
    $q$select count(*) from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
        where has_table_privilege('anon', 'public.ts_edits', p)$q$, '0');
  perform pg_temp.ts_v('A5 authenticated holds SELECT and nothing else on ts_edits', null, null,
    $q$select count(*) filter (where p = 'SELECT') || '/' || count(*)
         from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
        where has_table_privilege('authenticated', 'public.ts_edits', p)$q$, '1/1');
  -- (supabase/ts-edits-clear.sql, when applied, adds the workers' ts_edit_clear and ts_edits_to_recheck)
  perform pg_temp.ts_v('A6 authenticated can execute exactly these ts_ functions (all five files, and ts-edits-clear.sql and ts-pay-periods.sql when applied)', null, null,
    $q$select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'ts\_%' and has_function_privilege('authenticated', p.oid, 'EXECUTE')$q$,
    pg_temp.ts_v_lit('ts_admin_delete_user,ts_admin_delete_view,ts_admin_list,ts_admin_save_user,ts_admin_save_view,ts_admin_set_user_views,'
                  || 'ts_edit_cancel,' || case when to_regprocedure('public.ts_edit_clear(uuid,text)') is not null then 'ts_edit_clear,' else '' end
                  || 'ts_edit_mark,ts_edit_submit,ts_edits_pending,'
                  || case when to_regprocedure('public.ts_edits_to_recheck()') is not null then 'ts_edits_to_recheck,' else '' end
                  || 'ts_is_admin,ts_me,ts_my_email,ts_my_grant_keys,ts_my_view_ids,'
                  || case when to_regprocedure('public.ts_pay_periods_sync(text,jsonb)') is not null then 'ts_pay_periods_sync,' else '' end
                  || 'ts_sync'));
  perform pg_temp.ts_v('A7 PUBLIC and anon can execute none of the edit functions', null, null,
    $q$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and (p.proname like 'ts!_edit!_%' escape '!' or p.proname like 'ts!_edits!_%' escape '!')
          and (has_function_privilege('public', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE'))$q$, '0');
  perform pg_temp.ts_v('A8 the edit helpers are internal: authenticated can execute none of them', null, null,
    $q$select count(*) || '/' || count(*) filter (where has_function_privilege('authenticated', p.oid, 'EXECUTE'))
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('ts_edit_tz','ts_edit_window','ts_edit_ts','ts_edit_iso','ts_edit_hm',
                                                     'ts_edit_min','ts_edit_shape','ts_edit_key','ts_edit_worker_gate')$q$, '9/0');
  perform pg_temp.ts_v('A8b ts_edit_submit has one signature: the five page arguments plus p_expect (default null)', null, null,
    $q$select count(*) || '/' || string_agg(pg_get_function_identity_arguments(p.oid), ',') || '/' || string_agg(pg_get_expr(p.proargdefaults, 0), ',')
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'ts_edit_submit'$q$,
    '1/p_day_id text, p_shift_id text, p_action text, p_after jsonb, p_note text, p_expect jsonb/NULL::jsonb');
  perform pg_temp.ts_v('A9 every ts_ function is security definer with search_path=public', null, null,
    $q$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'ts\_%'
          and not (p.prosecdef and coalesce(array_to_string(p.proconfig, ',') like '%search_path=public%', false))$q$, '0');
  perform pg_temp.ts_v('A10 the only foreign key is the company (the log outlives a deleted day row)', null, null,
    $q$select string_agg(c.confrelid::regclass::text, ',') from pg_constraint c
        where c.conrelid = 'public.ts_edits'::regclass and c.contype = 'f'$q$, '%ts!_companies');
  perform pg_temp.ts_v('A11 even the owner cannot store an add that carries a shift id', null, null,
    $q$insert into public.ts_edits (day_id, company, region, employee_uuid, department, work_date, shift_id, action, after, created_by)
       values ('zz_ed_a:zz-ed-1:2001-01-01', 'zz_ed_a', 'CA', 'zz-ed-1', 'Distro/Trim', '2001-01-01', 'x', 'add', '{}', 'verify') returning id::text$q$, 'ERROR 23514%');
  perform pg_temp.ts_v('A12 ... nor a delete whose times are pending', null, null,
    $q$insert into public.ts_edits (day_id, company, region, employee_uuid, department, work_date, shift_id, action, before, created_by)
       values ('zz_ed_a:zz-ed-1:2001-01-01', 'zz_ed_a', 'CA', 'zz-ed-1', 'Distro/Trim', '2001-01-01', 'x', 'delete', '{}', 'verify') returning id::text$q$, 'ERROR 23514%');
  perform pg_temp.ts_v('A13 ... nor an update with no before', null, null,
    $q$insert into public.ts_edits (day_id, company, region, employee_uuid, department, work_date, shift_id, action, after, created_by)
       values ('zz_ed_a:zz-ed-1:2001-01-01', 'zz_ed_a', 'CA', 'zz-ed-1', 'Distro/Trim', '2001-01-01', 'x', 'update', '{}', 'verify') returning id::text$q$, 'ERROR 23514%');
  perform pg_temp.ts_v('A13b ... nor an add with no after', null, null,
    $q$insert into public.ts_edits (day_id, company, region, employee_uuid, department, work_date, action, created_by)
       values ('zz_ed_a:zz-ed-1:2001-01-01', 'zz_ed_a', 'CA', 'zz-ed-1', 'Distro/Trim', '2001-01-01', 'add', 'verify') returning id::text$q$, 'ERROR 23514%');
  perform pg_temp.ts_v('A13c ... nor an after that is not an object', null, null,
    $q$insert into public.ts_edits (day_id, company, region, employee_uuid, department, work_date, action, after, created_by)
       values ('zz_ed_a:zz-ed-1:2001-01-01', 'zz_ed_a', 'CA', 'zz-ed-1', 'Distro/Trim', '2001-01-01', 'add', '[]', 'verify') returning id::text$q$, 'ERROR 23514%');
  perform pg_temp.ts_v('A13d the owner can store a well-formed edit (the seed path); removed again right away', null, null,
    $q$with x as (insert into public.ts_edits (day_id, company, region, employee_uuid, department, work_date, action, after, created_by)
                  values ('zz_ed_a:zz-ed-1:2001-01-01', 'zz_ed_a', 'CA', 'zz-ed-1', 'Distro/Trim', '2001-01-01', 'add', '{}', 'verify') returning id)
       select count(*)::text from x$q$, '1');
  delete from public.ts_edits where day_id = 'zz_ed_a:zz-ed-1:2001-01-01' and created_by = 'verify';
  perform pg_temp.ts_v('A14 ... nor an unknown status', null, null,
    $q$insert into public.ts_edits (day_id, company, region, employee_uuid, department, work_date, action, after, times_status, created_by)
       values ('zz_ed_a:zz-ed-1:2001-01-01', 'zz_ed_a', 'CA', 'zz-ed-1', 'Distro/Trim', '2001-01-01', 'add', '{}', 'done', 'verify') returning id::text$q$, 'ERROR 23514%');
  perform pg_temp.ts_v('A15 ... nor an unknown company', null, null,
    $q$insert into public.ts_edits (day_id, company, region, employee_uuid, department, work_date, action, after, created_by)
       values ('acme:zz-ed-1:2001-01-01', 'acme', 'CA', 'zz-ed-1', 'Distro/Trim', '2001-01-01', 'add', '{}', 'verify') returning id::text$q$, 'ERROR 23503%');
  perform pg_temp.ts_v('A16 the refused owner inserts left nothing behind', null, null,
    $q$select count(*) from public.ts_edits where work_date = '2001-01-01' and created_by = 'verify'$q$, '0');

  -- ---------------------------------------------------------------- W. the edit window
  perform pg_temp.ts_v('W1 Los Angeles window: first day of the previous pay period through today', null, null,
    format($q$select to_char(win_from, 'YYYY-MM-DD') || '/' || to_char(win_to, 'YYYY-MM-DD') from public.ts_edit_window(%L)$q$, la),
    to_char(w, 'YYYY-MM-DD') || '/' || to_char(today, 'YYYY-MM-DD'));
  perform pg_temp.ts_v('W2 New York window uses New York''s today', null, null,
    format($q$select to_char(win_from, 'YYYY-MM-DD') || '/' || to_char(win_to, 'YYYY-MM-DD') from public.ts_edit_window(%L)$q$, nyz),
    to_char(nw, 'YYYY-MM-DD') || '/' || to_char(ntoday, 'YYYY-MM-DD'));
  perform pg_temp.ts_v('W3 known dates: 14-day periods ending Fridays from 2026-10-09', null, null,
    $q$select string_agg(to_char(d, 'YYYY-MM-DD') || '>' || to_char(w.win_from, 'YYYY-MM-DD') || '..' || to_char(w.win_to, 'MM-DD'), ',' order by d)
         from unnest(array[date '2026-01-02', date '2026-08-28', date '2026-09-12', date '2026-10-09', date '2026-10-10',
                           date '2026-10-21', date '2026-10-23', date '2026-10-24', date '2027-01-01']) d,
              lateral public.ts_edit_window('America/Los_Angeles', d) w$q$,
    '2026-01-02>2025-12-06..01-02,2026-08-28>2026-08-01..08-28,2026-09-12>2026-08-29..09-12,2026-10-09>2026-09-12..10-09,'
    || '2026-10-10>2026-09-26..10-10,2026-10-21>2026-09-26..10-21,2026-10-23>2026-09-26..10-23,2026-10-24>2026-10-10..10-24,'
    || '2027-01-01>2026-12-05..01-01');
  perform pg_temp.ts_v('W4 the anchor 2026-10-09 is a Friday and the window starts on a Saturday', null, null,
    $q$select extract(isodow from date '2026-10-09') || '/' || extract(isodow from (public.ts_edit_window('America/Los_Angeles')).win_from)$q$, '5/6');

  -- ---------------------------------------------------------------- S. admin (gianni@, Google): what an edit records
  perform pg_temp.ts_v('S1 seconds and break order do not count: start 30 s later, breaks reversed = nothing changed', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '08:00:30', '16:30', '[["12:00","12:30","meal"],["10:00","10:10","rest"]]'), 'zz-ed S1'),
    'ERROR P0001: Nothing changed: the shift already has these times and breaks');
  perform pg_temp.ts_v('S2 changing a break''s type: times none, breaks pending', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '08:00', '16:30', '[["12:00","12:30","meal"],["10:00","10:10","meal"]]'), '  zz-ed S2  '),
    'update/none/pending');
  perform pg_temp.ts_v('S3 the saved edit copies the day row, records the caller, trims the reason', null, null,
    $q$select day_id || '|' || company || '|' || region || '|' || employee_uuid || '|' || department || '|' || to_char(work_date, 'YYYY-MM-DD')
              || '|' || shift_id || '|' || created_by || '|' || (created_at is not null) || '|' || coalesce(cancelled_by, '(none)')
         from public.ts_edits where note = 'zz-ed S2'$q$,
    pg_temp.ts_v_lit(a1 || '|zz_ed_a|CA|zz-ed-1|Distro/Trim|' || to_char(t, 'YYYY-MM-DD') || '|zz-ed-s1|' || adm || '|true|(none)'));
  perform pg_temp.ts_v('S4 before = the shift as the day row has it (times in the row zone, kinds kept)', null, null,
    format($q$select (before = %L::jsonb)::text from public.ts_edits where note = 'zz-ed S2'$q$,
           pg_temp.ts_v_stored(t, la, '08:00', '16:30', s1_brks)), 'true');
  perform pg_temp.ts_v('S5 after is stored in the row zone (sent as UTC Z), breaks put in time order', null, null,
    format($q$select (after = %L::jsonb)::text from public.ts_edits where note = 'zz-ed S2'$q$,
           pg_temp.ts_v_stored(t, la, '08:00', '16:30', '[["10:00","10:10","meal"],["12:00","12:30","meal"]]')), 'true');
  perform pg_temp.ts_v('S6 moving the start only: times pending, breaks none', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '07:45', '16:30', s1_brks), 'zz-ed S6'), 'update/pending/none');
  perform pg_temp.ts_v('S7 ... and that superseded S2 (its pending part cancelled, by superseded)', null, null,
    $q$select pg_temp.ts_v_st('zz-ed S2') || '/' || (select (cancelled_at is not null)::text from public.ts_edits where note = 'zz-ed S2')$q$,
    'none/cancelled/superseded/true');
  perform pg_temp.ts_v('S8 going back to what the day row shows is allowed while an edit waits: none/none', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '08:00', '16:30', s1_brks), 'zz-ed S8'), 'update/none/none');
  perform pg_temp.ts_v('S9 ... and it superseded S6', null, null, $q$select pg_temp.ts_v_st('zz-ed S6')$q$, 'cancelled/none/superseded');
  perform pg_temp.ts_v('S10 with nothing waiting for the shift, the same no-change edit is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '08:00', '16:30', s1_brks), 'zz-ed S10'),
    'ERROR P0001: Nothing changed%');
  perform pg_temp.ts_v('S11 adding an overnight shift with a break: times pending, breaks pending', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, null, 'add', pg_temp.ts_v_after(t, la, '20:00', '+04:00', '[["23:00","23:30","meal"]]'), 'zz-ed S11'), 'add/pending/pending');
  perform pg_temp.ts_v('S12 an add has no shift id and no before', null, null,
    $q$select (shift_id is null)::text || '/' || (before is null)::text || '/' || jsonb_array_length(after->'breaks') from public.ts_edits where note = 'zz-ed S11'$q$,
    'true/true/1');
  perform pg_temp.ts_v('S13 the same add again is refused while the first waits', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, null, 'add', pg_temp.ts_v_after(t, la, '20:00', '+04:00', '[["23:00","23:30","meal"]]'), 'zz-ed S13'),
    'ERROR P0001: This shift is already waiting to be added');
  perform pg_temp.ts_v('S14 an add with no breaks: times pending, breaks none', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, '  ', 'add', pg_temp.ts_v_after(t, la, '06:00', '07:00', '[]'), 'zz-ed S14'), 'add/pending/none');
  perform pg_temp.ts_v('S15 two adds on one day do not supersede each other', null, null,
    $q$select pg_temp.ts_v_st('zz-ed S11') || ',' || pg_temp.ts_v_st('zz-ed S14')$q$, 'pending/pending/(none),pending/none/(none)');
  perform pg_temp.ts_v('S16 deleting a shift: times none, breaks pending (the browser task deletes it)', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, 'zz-ed-s2', 'delete', null, 'zz-ed S16'), 'delete/none/pending');
  perform pg_temp.ts_v('S17 a delete stores no after and the shift as before', null, null,
    format($q$select (after is null)::text || '/' || (before = %L::jsonb)::text from public.ts_edits where note = 'zz-ed S16'$q$,
           pg_temp.ts_v_stored(t, la, '17:00', '19:00', '[]')), 'true/true');
  perform pg_temp.ts_v('S18 a delete ignores any after it is sent', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, 'zz-ed-s2', 'delete', '{"in":"nonsense"}', 'zz-ed S18'), 'delete/none/pending');
  perform pg_temp.ts_v('S19 ... stored without one, and the earlier delete of that shift was superseded', null, null,
    $q$select (select (after is null)::text from public.ts_edits where note = 'zz-ed S18') || '/' || pg_temp.ts_v_st('zz-ed S16')$q$,
    'true/none/cancelled/superseded');
  perform pg_temp.ts_v('S20 a shift still clocked in (open break) can be closed: times and breaks pending', 'authenticated', adm,
    pg_temp.ts_v_sub(a8, 'zz-ed-s11', 'update', pg_temp.ts_v_after(t, la, '08:00', '16:00', '[["12:00","12:30","meal"]]'), 'zz-ed S20'),
    'update/pending/pending');
  perform pg_temp.ts_v('S21 ... its before keeps the open end and the open break', null, null,
    $q$select (before->>'out' is null)::text || '/' || (before->'breaks'->0->>'end' is null)::text || '/' || (before->'breaks'->0->>'kind')
         from public.ts_edits where note = 'zz-ed S20'$q$, 'true/true/meal');
  perform pg_temp.ts_v('S22 the reason is optional: blank stores none', 'authenticated', adm,
    format($q$select (r->>'times_status') || '/' || coalesce(r->>'note', '(none)') from (select public.ts_edit_submit(%L, 'zz-ed-s3', 'update', %L::jsonb, '   ') r) s$q$,
           a2, pg_temp.ts_v_after(w, la, '08:05', '16:00', '[]')), 'pending/(none)');
  perform pg_temp.ts_v('S23 limits that pass: 16 h overnight, 6 breaks, 1 and 240 minutes, touching breaks, kind any case', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', pg_temp.ts_v_after(w, la, '12:00', '+04:00',
      '[["12:30","12:31"," Rest "],["13:00","17:00","MEAL"],["17:00","17:10","rest"],["18:00","18:10","rest"],["19:00","19:10","rest"],["20:00","20:10","rest"]]'), 'zz-ed S23'),
    'update/pending/pending');
  perform pg_temp.ts_v('S24 ... stored with lowercase kinds, all 6 breaks', null, null,
    $q$select (select string_agg(b->>'kind', ',' order by o) from jsonb_array_elements(after->'breaks') with ordinality x(b, o)) || '/' || jsonb_array_length(after->'breaks')
         from public.ts_edits where note = 'zz-ed S23'$q$, 'rest,meal,rest,rest,rest,rest/6');

  -- ---------------------------------------------------------------- O. no overlapping shifts (admin, day a1 as it is now:
  -- s1 8:00 to 4:30, s2 5 to 7 PM waiting to be deleted (S18), adds waiting: 8 PM to 4 AM (S11), 6 to 7 AM (S14))
  perform pg_temp.ts_v('O1 an add over a shift of the day is refused, even when it differs only by seconds', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, null, 'add', pg_temp.ts_v_after(t, la, '08:00:01', '16:00', '[]'), 'zz-ed O1'),
    'ERROR P0001: This shift overlaps the 8:00 AM to 4:30 PM shift');
  perform pg_temp.ts_v('O2 an add over a shift waiting to be added is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, null, 'add', pg_temp.ts_v_after(t, la, '21:00', '22:00', '[]'), 'zz-ed O2'),
    'ERROR P0001: This shift overlaps the 8:00 PM to 4:00 AM shift');
  perform pg_temp.ts_v('O3 a shift waiting to be deleted no longer counts: its slot can be added', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, null, 'add', pg_temp.ts_v_after(t, la, '17:00', '19:00', '[]'), 'zz-ed O3'), 'add/pending/none');
  perform pg_temp.ts_v('O4 an update over a shift waiting to be added is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '08:00', '17:30', s1_brks), 'zz-ed O4'),
    'ERROR P0001: This shift overlaps the 5:00 PM to 7:00 PM shift');
  perform pg_temp.ts_v('O5 touching is fine: s1 may start the minute the 6 to 7 AM add ends', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '07:00', '16:30', s1_brks), 'zz-ed O5'), 'update/pending/none');
  perform pg_temp.ts_v('O6 a shift counts with the times of its waiting update (s1 now from 7 AM)', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, null, 'add', pg_temp.ts_v_after(t, la, '07:15', '07:45', '[]'), 'zz-ed O6'),
    'ERROR P0001: This shift overlaps the 7:00 AM to 4:30 PM shift');
  perform pg_temp.ts_v('O7 the same add again, to the minute, is the duplicate message (8:00:20 PM = 8:00 PM)', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, null, 'add', pg_temp.ts_v_after(t, la, '20:00:20', '+04:00', '[["23:00","23:30:10","meal"]]'), 'zz-ed O7'),
    'ERROR P0001: This shift is already waiting to be added');
  perform pg_temp.ts_v('O8 (s1 back to what the day row has, replacing O5)', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '08:00', '16:30', s1_brks), 'zz-ed O8'), 'update/none/none');
  perform pg_temp.ts_v('O9 the refused overlaps wrote nothing', null, null,
    $q$select count(*) from public.ts_edits where note in ('zz-ed O1', 'zz-ed O2', 'zz-ed O4', 'zz-ed O6', 'zz-ed O7')$q$, '0');

  -- ---------------------------------------------------------------- V. validation (admin, day a2 shift s3 = 8 AM to 4 PM)
  perform pg_temp.ts_v('V1 refuses an unknown action', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'move', base_a2, 'zz-ed V1'), 'ERROR P0001: The action must be update, add or delete');
  perform pg_temp.ts_v('V2 refuses an update with no shift id', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, null, 'update', base_a2, 'zz-ed V2'), 'ERROR P0001: Say which shift to update');
  perform pg_temp.ts_v('V3 refuses an update of a shift that is not on the row', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-nope', 'update', base_a2, 'zz-ed V3'), 'ERROR P0001: That shift is not on this day any more%');
  perform pg_temp.ts_v('V4 refuses a delete of a shift that is not on the row', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s1', 'delete', null, 'zz-ed V4'), 'ERROR P0001: That shift is not on this day any more%');
  perform pg_temp.ts_v('V5 refuses an add that carries a shift id', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'add', base_a2, 'zz-ed V5'), 'ERROR P0001: A new shift has no Gusto shift id yet%');
  perform pg_temp.ts_v('V6 refuses an update with no after', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', null, 'zz-ed V6'), 'ERROR P0001: Give the shift''s start, end and breaks');
  perform pg_temp.ts_v('V7 refuses an after that is not an object', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', '[]', 'zz-ed V7'), 'ERROR P0001: Give the shift''s start, end and breaks');
  perform pg_temp.ts_v('V8 refuses a missing start', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', base_a2 - 'in', 'zz-ed V8'), 'ERROR P0001: Start is missing');
  perform pg_temp.ts_v('V9 refuses a null end', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', jsonb_set(base_a2, '{out}', 'null'), 'zz-ed V9'), 'ERROR P0001: End is missing');
  perform pg_temp.ts_v('V10 refuses an end before the start', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', pg_temp.ts_v_after(w, la, '16:00', '08:00', '[]'), 'zz-ed V10'), 'ERROR P0001: End must be after start');
  perform pg_temp.ts_v('V11 refuses an end equal to the start', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', pg_temp.ts_v_after(w, la, '08:00', '08:00', '[]'), 'zz-ed V11'), 'ERROR P0001: End must be after start');
  perform pg_temp.ts_v('V12 refuses a time with no zone offset', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', jsonb_set(base_a2, '{in}', to_jsonb(to_char(w, 'YYYY-MM-DD') || 'T08:00:00')), 'zz-ed V12'),
    'ERROR P0001: Start must be a full time with its zone offset%');
  perform pg_temp.ts_v('V13 refuses a time that is not text', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', jsonb_set(base_a2, '{in}', '800'), 'zz-ed V13'), 'ERROR P0001: Start must be a time');
  perform pg_temp.ts_v('V14 refuses words for a time', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', jsonb_set(base_a2, '{out}', '"tomorrow"'), 'zz-ed V14'), 'ERROR P0001: End must be a full time%');
  perform pg_temp.ts_v('V15 refuses a date that does not exist', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', jsonb_set(base_a2, '{in}', '"2026-02-30T08:00:00Z"'), 'zz-ed V15'), 'ERROR P0001: Start is not a real time%');
  perform pg_temp.ts_v('V16 refuses a start on another day', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', jsonb_build_object('in', pg_temp.ts_v_z(pg_temp.ts_v_at(w - 1, '22:00', la)),
                                                                  'out', pg_temp.ts_v_z(pg_temp.ts_v_at(w, '06:00', la)), 'breaks', '[]'::jsonb), 'zz-ed V16'),
    'ERROR P0001: Start must be on ' || to_char(w, 'Dy Mon FMDD'));
  perform pg_temp.ts_v('V17 refuses an overnight shift over 16 hours', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', pg_temp.ts_v_after(w, la, '08:00', '+01:00', '[]'), 'zz-ed V17'),
    'ERROR P0001: A shift must end the same day, or overnight within 16 hours of its start');
  perform pg_temp.ts_v('V18 refuses an end two days later', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', jsonb_set(pg_temp.ts_v_after(w, la, '23:00', '23:30', '[]'), '{out}',
                                                         to_jsonb(pg_temp.ts_v_z(pg_temp.ts_v_at(w + 2, '01:00', la)))), 'zz-ed V18'),
    'ERROR P0001: A shift must end the same day%');
  perform pg_temp.ts_v('V19 refuses a missing break list', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', base_a2 - 'breaks', 'zz-ed V19'), 'ERROR P0001: Breaks must be a list (an empty list for none)');
  perform pg_temp.ts_v('V20 refuses breaks that are not a list', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', jsonb_set(base_a2, '{breaks}', '{}'), 'zz-ed V20'), 'ERROR P0001: Breaks must be a list%');
  perform pg_temp.ts_v('V21 refuses 7 breaks', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', pg_temp.ts_v_after(w, la, '08:00', '16:00',
      '[["09:00","09:05","rest"],["10:00","10:05","rest"],["11:00","11:05","rest"],["12:00","12:05","rest"],["13:00","13:05","rest"],["14:00","14:05","rest"],["15:00","15:05","rest"]]'), 'zz-ed V21'),
    'ERROR P0001: A shift can have at most 6 breaks');
  perform pg_temp.ts_v('V22 refuses a break that is not an object', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', jsonb_set(base_a2, '{breaks}', '["10:00"]'), 'zz-ed V22'), 'ERROR P0001: Break 1: give its start, end and type');
  perform pg_temp.ts_v('V23 refuses a break with no end', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', pg_temp.ts_v_after(w, la, '08:00', '16:00', '[["10:00",null,"rest"]]'), 'zz-ed V23'),
    'ERROR P0001: Break 1: needs a start and an end');
  perform pg_temp.ts_v('V24 refuses a break type other than rest or meal', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', pg_temp.ts_v_after(w, la, '08:00', '16:00', '[["10:00","10:10","lunch"]]'), 'zz-ed V24'),
    'ERROR P0001: Break 1: the type must be rest (paid) or meal (unpaid)');
  perform pg_temp.ts_v('V25 refuses a break with no type', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', pg_temp.ts_v_after(w, la, '08:00', '16:00', '[["10:00","10:10",null]]'), 'zz-ed V25'),
    'ERROR P0001: Break 1: the type must be%');
  perform pg_temp.ts_v('V26 refuses a 0-minute break', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', pg_temp.ts_v_after(w, la, '08:00', '16:00', '[["10:00","10:00","rest"]]'), 'zz-ed V26'),
    'ERROR P0001: Break 1: must be 1 to 240 minutes long');
  perform pg_temp.ts_v('V27 refuses a 241-minute break', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', pg_temp.ts_v_after(w, la, '08:00', '16:00', '[["09:00","13:01","meal"]]'), 'zz-ed V27'),
    'ERROR P0001: Break 1: must be 1 to 240 minutes long');
  perform pg_temp.ts_v('V28 refuses a break that starts before the shift', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', pg_temp.ts_v_after(w, la, '08:00', '16:00', '[["07:50","08:10","rest"]]'), 'zz-ed V28'),
    'ERROR P0001: Break 1: must be inside the shift (8:00 AM to 4:00 PM)');
  perform pg_temp.ts_v('V29 refuses a break that ends after the shift', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', pg_temp.ts_v_after(w, la, '08:00', '16:00', '[["15:50","16:10","rest"]]'), 'zz-ed V29'),
    'ERROR P0001: Break 1: must be inside the shift%');
  perform pg_temp.ts_v('V30 names the bad break when an earlier one is fine', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', pg_temp.ts_v_after(w, la, '08:00', '16:00', '[["10:00","10:10","rest"],["12:00","12:30","nap"]]'), 'zz-ed V30'),
    'ERROR P0001: Break 2: the type must be%');
  perform pg_temp.ts_v('V31 refuses overlapping breaks', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', pg_temp.ts_v_after(w, la, '08:00', '16:00', '[["10:05","10:20","rest"],["10:00","10:15","rest"]]'), 'zz-ed V31'),
    'ERROR P0001: Breaks cannot overlap (the 10:00 AM break and the 10:05 AM break)');
  perform pg_temp.ts_v('V32 refuses a break start that is not text', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', jsonb_set(base_a2, '{breaks}', jsonb_build_array(jsonb_build_object('start', 5, 'end', base_a2->'out', 'kind', 'rest'))), 'zz-ed V32'),
    'ERROR P0001: Break 1 start must be a time');
  perform pg_temp.ts_v('V33 refuses a reason over 500 characters', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', pg_temp.ts_v_after(w, la, '08:01', '16:00', '[]'), 'zz-ed V33 ' || repeat('x', 491)),
    'ERROR P0001: The reason can be at most 500 characters');
  perform pg_temp.ts_v('V34 a reason of exactly 500 characters is kept', 'authenticated', adm,
    format($q$select length(r->>'note') || '/' || (r->>'times_status') from (select public.ts_edit_submit(%L, 'zz-ed-s3', 'update', %L::jsonb, %L) r) s$q$,
           a2, pg_temp.ts_v_after(w, la, '08:01', '16:00', '[]'), 'zz-ed V34 ' || repeat('x', 490)), '500/pending');
  perform pg_temp.ts_v('V35 refused submits wrote nothing', null, null,
    $q$select count(*) from public.ts_edits where note like 'zz-ed V%' and note not like 'zz-ed V34%'$q$, '0');

  -- ---------------------------------------------------------------- F. no hours that have not been worked yet (day aF, 30 minutes ago)
  perform pg_temp.ts_v('F1 an end more than 5 minutes after now is refused', 'authenticated', adm,
    pg_temp.ts_v_sub(af, null, 'add', jsonb_build_object('in', pg_temp.ts_v_z(now() - interval '30 minutes'),
                                                         'out', pg_temp.ts_v_z(now() + interval '10 minutes'), 'breaks', '[]'::jsonb), 'zz-ed F1'),
    'ERROR P0001: End cannot be later than now');
  perform pg_temp.ts_v('F2 ... an end within 5 minutes of now is fine (a clock a little ahead)', 'authenticated', adm,
    pg_temp.ts_v_sub(af, null, 'add', jsonb_build_object('in', pg_temp.ts_v_z(now() - interval '30 minutes'),
                                                         'out', pg_temp.ts_v_z(now() + interval '4 minutes'), 'breaks', '[]'::jsonb), 'zz-ed F2'),
    'add/pending/none');
  perform pg_temp.ts_v('F3 the refused one wrote nothing', null, null, $q$select count(*) from public.ts_edits where note = 'zz-ed F1'$q$, '0');

  -- ---------------------------------------------------------------- L. hours entered in Gusto without clock times (day aH)
  perform pg_temp.ts_v('L1 an hours-only entry cannot be changed here', 'authenticated', adm,
    pg_temp.ts_v_sub(ah, 'zz-ed-h1', 'update', pg_temp.ts_v_after(t, la, '06:00', '22:00', '[]'), 'zz-ed L1'),
    'ERROR P0001: These are hours entered in Gusto without clock times: change them in Gusto');
  perform pg_temp.ts_v('L2 ... nor deleted', 'authenticated', adm,
    pg_temp.ts_v_sub(ah, 'zz-ed-h1', 'delete', null, 'zz-ed L2'),
    'ERROR P0001: These are hours entered in Gusto without clock times: change them in Gusto');
  perform pg_temp.ts_v('L3 a shift can be added on that day (its placeholder clock times overlap nothing)', 'authenticated', adm,
    pg_temp.ts_v_sub(ah, null, 'add', pg_temp.ts_v_after(t, la, '06:00', '07:00', '[]'), 'zz-ed L3'), 'add/pending/none');
  perform pg_temp.ts_v('L4 the refused ones wrote nothing', null, null,
    $q$select count(*) from public.ts_edits where note in ('zz-ed L1', 'zz-ed L2')$q$, '0');

  -- ---------------------------------------------------------------- I. breaks inside the shift and apart to the minute (day aS:
  -- s15 1:48:42 PM to 5:09:49 PM, its meal 1:48:00 to 2:18:00, as Gusto had it in live data)
  perform pg_temp.ts_v('I1 changing only the end: the untouched meal 42 s before the clock-in (same minute) is inside', 'authenticated', adm,
    pg_temp.ts_v_sub(as_, 'zz-ed-s15', 'update', pg_temp.ts_v_after(t, la, '13:48:42', '17:30', '[["13:48:00","14:18:00","meal"]]'), 'zz-ed I1'),
    'update/pending/none');
  perform pg_temp.ts_v('I2 ... before and after keep the seconds Gusto had', null, null,
    format($q$select (before = %L::jsonb)::text || '/' || (after->'breaks' = %L::jsonb)::text from public.ts_edits where note = 'zz-ed I1'$q$,
           pg_temp.ts_v_stored(t, la, '13:48:42', '17:09:49', '[["13:48:00","14:18:00","meal"]]'),
           pg_temp.ts_v_stored(t, la, '13:48:42', '17:30', '[["13:48:00","14:18:00","meal"]]')->'breaks'), 'true/true');
  perform pg_temp.ts_v('I3 a break in the minute before the clock-in is still outside', 'authenticated', adm,
    pg_temp.ts_v_sub(as_, 'zz-ed-s15', 'update', pg_temp.ts_v_after(t, la, '13:48:42', '17:09:49', '[["13:47:59","14:18:00","meal"]]'), 'zz-ed I3'),
    'ERROR P0001: Break 1: must be inside the shift (1:48 PM to 5:09 PM)');
  perform pg_temp.ts_v('I4 a break ending seconds after the clock-out, in the same minute, is inside', 'authenticated', adm,
    pg_temp.ts_v_sub(as_, 'zz-ed-s15', 'update', pg_temp.ts_v_after(t, la, '13:48:42', '17:09:49', '[["13:48:00","14:18:00","meal"],["17:00:00","17:09:59","rest"]]'), 'zz-ed I4'),
    'update/none/pending');
  perform pg_temp.ts_v('I5 ... but one ending in the next minute is outside', 'authenticated', adm,
    pg_temp.ts_v_sub(as_, 'zz-ed-s15', 'update', pg_temp.ts_v_after(t, la, '13:48:42', '17:09:49', '[["17:00:00","17:10:00","rest"]]'), 'zz-ed I5'),
    'ERROR P0001: Break 1: must be inside the shift%');
  perform pg_temp.ts_v('I6 breaks a few seconds apart in the same minute do not overlap', 'authenticated', adm,
    pg_temp.ts_v_sub(as_, 'zz-ed-s15', 'update', pg_temp.ts_v_after(t, la, '13:48:42', '17:09:49', '[["13:48:00","14:18:00","meal"],["15:00:00","15:10:30","rest"],["15:10:10","15:20:00","rest"]]'), 'zz-ed I6'),
    'update/none/pending');
  perform pg_temp.ts_v('I7 ... a break that starts the minute before the other ends overlaps', 'authenticated', adm,
    pg_temp.ts_v_sub(as_, 'zz-ed-s15', 'update', pg_temp.ts_v_after(t, la, '13:48:42', '17:09:49', '[["15:00:00","15:10:30","rest"],["15:09:50","15:20:00","rest"]]'), 'zz-ed I7'),
    'ERROR P0001: Breaks cannot overlap (the 3:00 PM break and the 3:09 PM break)');
  perform pg_temp.ts_v('I8 the refused ones wrote nothing', null, null,
    $q$select count(*) from public.ts_edits where note in ('zz-ed I3', 'zz-ed I5', 'zz-ed I7')$q$, '0');

  -- ---------------------------------------------------------------- E. p_expect: a save never replaces a change its page did not
  -- show (day aS, where I6 is waiting)
  perform pg_temp.ts_v('E1 a save that saw nothing waiting, while I6 waits, is refused', 'authenticated', adm,
    pg_temp.ts_v_subx(as_, 'zz-ed-s15', 'update', pg_temp.ts_v_after(t, la, '13:48:42', '17:40', '[["13:48:00","14:18:00","meal"]]'), 'zz-ed E1', '[]'),
    someone);
  perform pg_temp.ts_v('E2 the same save that saw I6 goes through (and replaces it)', 'authenticated', adm,
    pg_temp.ts_v_subx(as_, 'zz-ed-s15', 'update', pg_temp.ts_v_after(t, la, '13:48:42', '17:40', '[["13:48:00","14:18:00","meal"]]'), 'zz-ed E2',
                      jsonb_build_array(pg_temp.ts_v_id('zz-ed I6'))), 'update/pending/none');
  perform pg_temp.ts_v('E3 a page that still shows I6 (replaced since, E2 waiting) is refused', 'authenticated', adm,
    pg_temp.ts_v_subx(as_, 'zz-ed-s15', 'update', pg_temp.ts_v_after(t, la, '13:48:42', '17:50', '[["13:48:00","14:18:00","meal"]]'), 'zz-ed E3',
                      jsonb_build_array(pg_temp.ts_v_id('zz-ed I6'))), someone);
  perform pg_temp.ts_v('E4 a delete is checked the same way', 'authenticated', adm,
    pg_temp.ts_v_subx(as_, 'zz-ed-s15', 'delete', null, 'zz-ed E4', '[]'), someone);
  perform pg_temp.ts_v('E5 the ids compare in any letter case', 'authenticated', adm,
    pg_temp.ts_v_subx(as_, 'zz-ed-s15', 'update', pg_temp.ts_v_after(t, la, '13:48:42', '17:50', '[["13:48:00","14:18:00","meal"]]'), 'zz-ed E5',
                      jsonb_build_array(upper(pg_temp.ts_v_id('zz-ed E2')::text))), 'update/pending/none');
  perform pg_temp.ts_v('E6 p_expect must be a list', 'authenticated', adm,
    pg_temp.ts_v_subx(as_, 'zz-ed-s15', 'update', pg_temp.ts_v_after(t, la, '13:48:42', '17:55', '[]'), 'zz-ed E6', '{}'),
    'ERROR P0001: p_expect must be a list of edit ids%');
  perform pg_temp.ts_v('E7 an add has no shift to compare: its p_expect ids do not matter', 'authenticated', adm,
    pg_temp.ts_v_subx(as_, null, 'add', pg_temp.ts_v_after(t, la, '06:00', '07:00', '[]'), 'zz-ed E7', '["nope"]'), 'add/pending/none');
  perform pg_temp.ts_v('E8 the refused ones wrote nothing, and what was waiting still waits', null, null,
    $q$select (select count(*) from public.ts_edits where note in ('zz-ed E1', 'zz-ed E3', 'zz-ed E4', 'zz-ed E6')) || '/' || pg_temp.ts_v_st('zz-ed E2') || '/' || pg_temp.ts_v_st('zz-ed E5')$q$,
    '0/cancelled/none/superseded/pending/none/(none)');

  -- ---------------------------------------------------------------- seed: one more edit on every synthetic day, made by
  -- someone else (an add at 5:00 to 5:30 AM in the row zone, so it never collides with the edits above)
  insert into public.ts_edits (day_id, company, region, employee_uuid, department, work_date, action, after,
                               times_status, breaks_status, note, created_by)
  select d.id, d.company, d.region, d.employee_uuid, d.department, d.work_date, 'add',
         pg_temp.ts_v_stored(d.work_date, public.ts_edit_tz(d.region), '05:00', '05:30', '[]'),
         'pending', 'none', 'zz-ed seed ' || d.id, oth
    from public.ts_days d where d.id like 'zz!_ed!_%' escape '!';

  -- ---------------------------------------------------------------- R. admin sees every edit
  perform pg_temp.ts_v('R1 admin sees every ts_edits row', 'authenticated', adm, ecount, (select count(*)::text from public.ts_edits));
  perform pg_temp.ts_v('R2 admin: RLS rows = ts_can_view rows', 'authenticated', adm, rls_e, pg_temp.ts_v_as('claims', adm, ref_e));
  perform pg_temp.ts_v('R3 admin: edits of all 15 synthetic days, the same days as the day rows seen', 'authenticated', adm, same_q, 'true/15');
  perform pg_temp.ts_v('R4 admin cannot insert into ts_edits directly', 'authenticated', adm,
    format($q$insert into public.ts_edits (day_id, company, region, employee_uuid, department, work_date, action, after, created_by)
              values (%L, 'zz_ed_a', 'CA', 'zz-ed-1', 'Distro/Trim', %L, 'add', '{}', 'x') returning id::text$q$, a1, t), 'ERROR 42501%');
  perform pg_temp.ts_v('R5 admin cannot update ts_edits directly', 'authenticated', adm,
    $q$update public.ts_edits set times_status = 'applied' where day_id like 'zz!_ed!_%' escape '!' returning id::text$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('R6 admin cannot delete from ts_edits directly', 'authenticated', adm,
    $q$delete from public.ts_edits where day_id like 'zz!_ed!_%' escape '!' returning id::text$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('R7 admin cannot call the worker RPCs', 'authenticated', adm,
    $q$select public.ts_edits_pending('times')::text$q$, 'ERROR 42501: ts_edits_pending is for the timesheet sync account only');
  perform pg_temp.ts_v('R8 admin cannot call an internal helper', 'authenticated', adm,
    $q$select (public.ts_edit_window('America/Los_Angeles')).win_from::text$q$, 'ERROR 42501%');

  -- ---------------------------------------------------------------- M. manager with one department: zz_ed_a / Distro/Trim
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"zz_ed_a","department":"Distro/Trim"}]');
  perform pg_temp.ts_v('M0 (setup) active, not admin, one grant key', 'authenticated', adm,
    $q$select (public.ts_me()->>'active') || '/' || (public.ts_me()->>'is_admin') || '/' || array_to_string(public.ts_my_grant_keys(), ',')$q$,
    pg_temp.ts_v_lit('true/false/zz_ed_a|Distro/Trim'));
  perform pg_temp.ts_v('M1 department manager: RLS rows = ts_can_view rows', 'authenticated', adm, rls_e, pg_temp.ts_v_as('claims', adm, ref_e));
  perform pg_temp.ts_v('M2 department manager: edits of exactly the 9 visible days (a1 to a4, a8, aF, aH, aS, aX)', 'authenticated', adm, same_q, 'true/9');
  perform pg_temp.ts_v('M3 can edit a day in the grant', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '07:30', '16:30', s1_brks), 'zz-ed M3'), 'update/pending/none');
  perform pg_temp.ts_v('M4 ... recorded as made by the manager', null, null,
    $q$select created_by from public.ts_edits where note = 'zz-ed M3'$q$, adm);
  perform pg_temp.ts_v('M5 cannot edit another department of the same company', 'authenticated', adm,
    pg_temp.ts_v_sub(a5, 'zz-ed-s6', 'update', pg_temp.ts_v_after(t, la, '07:30', '15:00', '[]'), 'zz-ed M5'), no_day);
  perform pg_temp.ts_v('M6 cannot edit another company (same department name)', 'authenticated', adm,
    pg_temp.ts_v_sub(b1, 'zz-ed-s7', 'update', pg_temp.ts_v_after(t, la, '07:30', '16:00', '[]'), 'zz-ed M6'), no_day);
  perform pg_temp.ts_v('M7 cannot edit New York', 'authenticated', adm,
    pg_temp.ts_v_sub(n1, 'zz-ed-s9', 'update', pg_temp.ts_v_after(nt, nyz, '07:30', '16:00', '[]'), 'zz-ed M7'), no_day);
  perform pg_temp.ts_v('M8 a day that does not exist gets the same answer (no probing)', 'authenticated', adm,
    pg_temp.ts_v_sub('zz_ed_a:zz-ed-1:1999-01-01', 'zz-ed-s1', 'update', base_a2, 'zz-ed M8'), no_day);
  perform pg_temp.ts_v('M9 cannot edit a visible day before the previous pay period', 'authenticated', adm,
    pg_temp.ts_v_sub(a3, 'zz-ed-s4', 'update', pg_temp.ts_v_after(w - 1, la, '08:30', '16:00', '[]'), 'zz-ed M9'),
    'ERROR P0001: Only the current and previous pay periods can be edited (from ' || to_char(w, 'Dy Mon FMDD') || ')');
  perform pg_temp.ts_v('M10 cannot edit a visible day in the future', 'authenticated', adm,
    pg_temp.ts_v_sub(a4, 'zz-ed-s5', 'update', pg_temp.ts_v_after(today + 1, la, '08:30', '16:00', '[]'), 'zz-ed M10'),
    'ERROR P0001: You cannot edit a day that has not happened yet');
  perform pg_temp.ts_v('M11 can edit the first day of the previous pay period', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', pg_temp.ts_v_after(w, la, '08:10', '16:00', '[]'), 'zz-ed M11'), 'update/pending/none');
  perform pg_temp.ts_v('M12 refused manager edits wrote nothing', null, null,
    $q$select count(*) from public.ts_edits where note in ('zz-ed M5','zz-ed M6','zz-ed M7','zz-ed M8','zz-ed M9','zz-ed M10')$q$, '0');
  perform pg_temp.ts_v('M13 reads the edit''s before and after (the page shows what changed)', 'authenticated', adm,
    $q$select (before->>'in' is not null and after->>'in' is not null)::text from public.ts_edits where note = 'zz-ed M11'$q$, 'true');
  perform pg_temp.ts_v('M14 cannot insert into ts_edits directly', 'authenticated', adm,
    format($q$insert into public.ts_edits (day_id, company, region, employee_uuid, department, work_date, action, after, created_by)
              values (%L, 'zz_ed_a', 'CA', 'zz-ed-1', 'Distro/Trim', %L, 'add', '{}', 'x') returning id::text$q$, a1, t), 'ERROR 42501%');
  perform pg_temp.ts_v('M15 cannot update ts_edits directly', 'authenticated', adm,
    $q$update public.ts_edits set breaks_status = 'cancelled' where note = 'zz-ed M3' returning id::text$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('M16 cannot call ts_edits_pending', 'authenticated', adm,
    $q$select public.ts_edits_pending('breaks')::text$q$, 'ERROR 42501: ts_edits_pending is for the timesheet sync account only');
  perform pg_temp.ts_v('M17 cannot call ts_edit_mark', 'authenticated', adm,
    format($q$select public.ts_edit_mark(%L::uuid, 'times', 'applied', null)::text$q$, pg_temp.ts_v_id('zz-ed M3')),
    'ERROR 42501: ts_edit_mark is for the timesheet sync account only');
  perform pg_temp.ts_v('M18 cancels own pending edit: the pending part becomes cancelled, by the manager', 'authenticated', adm,
    pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed M3')), pg_temp.ts_v_lit('cancelled/none/' || adm));
  perform pg_temp.ts_v('M19 cancelling it again is refused', 'authenticated', adm,
    pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed M3')), 'ERROR P0001: This edit is no longer waiting to go to Gusto, so it cannot be cancelled');
  perform pg_temp.ts_v('M20 cannot cancel someone else''s pending edit, even on a day in the grant', 'authenticated', adm,
    pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed seed ' || a1)), 'ERROR 42501: Only the person who made this edit, or an admin, can cancel it');
  perform pg_temp.ts_v('M21 ... which left it pending', null, null, format($q$select pg_temp.ts_v_st(%L)$q$, 'zz-ed seed ' || a1), 'pending/none/(none)');

  -- ---------------------------------------------------------------- U. manager with one view of one person (zz-ed-4)
  perform pg_temp.ts_v_gianni(false, true, '[]');
  perform pg_temp.ts_v_gianni_views('["zz-ed-v1"]');
  perform pg_temp.ts_v('U1 one-person view: RLS rows = ts_can_view rows', 'authenticated', adm, rls_e, pg_temp.ts_v_as('claims', adm, ref_e));
  perform pg_temp.ts_v('U2 one-person view: edits of that person''s day only', 'authenticated', adm, same_q, 'true/1');
  perform pg_temp.ts_v('U3 can edit the view''s person', 'authenticated', adm,
    pg_temp.ts_v_sub(a6, 'zz-ed-s8', 'update', pg_temp.ts_v_after(t, la, '09:15', '17:00', '[]'), 'zz-ed U3'), 'update/pending/none');
  perform pg_temp.ts_v('U4 cannot edit anyone else at that company', 'authenticated', adm,
    pg_temp.ts_v_sub(a5, 'zz-ed-s6', 'update', pg_temp.ts_v_after(t, la, '07:30', '15:00', '[]'), 'zz-ed U4'), no_day);
  perform pg_temp.ts_v('U5 cannot cancel the seeded edit of the view''s person (someone else made it)', 'authenticated', adm,
    pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed seed ' || a6)), 'ERROR 42501: Only the person who made this edit%');

  -- ---------------------------------------------------------------- Z. reserved names: a '@uuid:' ts_grants department + a view of zz-ed-1
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"zz_ed_a","department":"@uuid:zz-ed-4"}]');
  perform pg_temp.ts_v_gianni_views('["zz-ed-v2"]');
  perform pg_temp.ts_v('Z1 collisions: RLS rows = ts_can_view rows', 'authenticated', adm, rls_e, pg_temp.ts_v_as('claims', adm, ref_e));
  perform pg_temp.ts_v('Z2 collisions: edits of zz-ed-1''s 4 days only', 'authenticated', adm, same_q, 'true/4');
  perform pg_temp.ts_v('Z3 a department spelled like the person key stays out of reach', 'authenticated', adm,
    pg_temp.ts_v_sub(a7, 'zz-ed-s10', 'update', pg_temp.ts_v_after(t, la, '08:30', '12:00', '[]'), 'zz-ed Z3'), no_day);
  perform pg_temp.ts_v('Z4 a ts_grants department spelled like a person key reaches nobody', 'authenticated', adm,
    pg_temp.ts_v_sub(a6, 'zz-ed-s8', 'update', pg_temp.ts_v_after(t, la, '09:30', '17:00', '[]'), 'zz-ed Z4'), no_day);
  perform pg_temp.ts_v('Z5 ... and neither person''s other edits are readable', 'authenticated', adm,
    $q$select count(*) from public.ts_edits where employee_uuid in ('zz-ed-4', 'zz-ed-5')$q$, '0');
  perform pg_temp.ts_v_gianni_views('[]');

  -- ---------------------------------------------------------------- G. all-CA manager ('*','*'); then a New York grant
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"*","department":"*"}]');
  perform pg_temp.ts_v('G1 all-CA manager: RLS rows = ts_can_view rows', 'authenticated', adm, rls_e, pg_temp.ts_v_as('claims', adm, ref_e));
  perform pg_temp.ts_v('G2 all-CA manager: edits of the 13 California days, none in New York', 'authenticated', adm, same_q, 'true/13');
  perform pg_temp.ts_v('G3 can edit another CA company', 'authenticated', adm,
    pg_temp.ts_v_sub(b1, 'zz-ed-s7', 'update', pg_temp.ts_v_after(t, la, '08:20', '16:00', '[]'), 'zz-ed G3'), 'update/pending/none');
  perform pg_temp.ts_v('G4 * does not reach New York', 'authenticated', adm,
    pg_temp.ts_v_sub(n1, 'zz-ed-s9', 'update', pg_temp.ts_v_after(nt, nyz, '08:20', '16:00', '[["12:00","12:30","meal"]]'), 'zz-ed G4'), no_day);
  perform pg_temp.ts_v('G5 is still not an admin: cannot cancel someone else''s edit', 'authenticated', adm,
    pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed seed ' || b1)), 'ERROR 42501: Only the person who made this edit%');
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"zz_ed_ny","department":"*"}]');
  perform pg_temp.ts_v('Y1 NY manager: RLS rows = ts_can_view rows', 'authenticated', adm, rls_e, pg_temp.ts_v_as('claims', adm, ref_e));
  perform pg_temp.ts_v('Y2 NY manager: edits of the two New York days only', 'authenticated', adm, same_q, 'true/2');
  perform pg_temp.ts_v('Y3 can edit the New York day (window and times in Eastern)', 'authenticated', adm,
    pg_temp.ts_v_sub(n1, 'zz-ed-s9', 'update', pg_temp.ts_v_after(nt, nyz, '08:30', '16:00', '[["12:00","12:30","meal"]]'), 'zz-ed Y3'), 'update/pending/none');
  perform pg_temp.ts_v('Y4 ... stored with Eastern offsets and region NY', null, null,
    format($q$select (after = %L::jsonb)::text || '/' || region || '/' || (before = %L::jsonb)::text from public.ts_edits where note = 'zz-ed Y3'$q$,
           pg_temp.ts_v_stored(nt, nyz, '08:30', '16:00', '[["12:00","12:30","meal"]]'),
           pg_temp.ts_v_stored(nt, nyz, '08:00', '16:00', '[["12:00","12:30","meal"]]')), 'true/NY/true');
  perform pg_temp.ts_v('Y4b a shift whose start is on the next date in Eastern (punched in Pacific) may keep that date', 'authenticated', adm,
    pg_temp.ts_v_sub(n2, 'zz-ed-s12', 'update', pg_temp.ts_v_after(nt - 1, la, '23:30', '+03:30', '[]'), 'zz-ed Y4b'), 'update/pending/none');
  perform pg_temp.ts_v('Y4c ... but a new shift on that day must start on the day itself', 'authenticated', adm,
    pg_temp.ts_v_sub(n2, null, 'add', pg_temp.ts_v_after(nt, nyz, '02:30', '05:00', '[]'), 'zz-ed Y4c'),
    'ERROR P0001: Start must be on ' || to_char(nt - 1, 'Dy Mon FMDD'));
  perform pg_temp.ts_v('Y5 cannot edit California', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '07:40', '16:30', s1_brks), 'zz-ed Y5'), no_day);

  -- ---------------------------------------------------------------- H. inactive (manager, then admin)
  perform pg_temp.ts_v_gianni(false, false, '[{"company":"*","department":"*"}]');
  perform pg_temp.ts_v('H1 inactive manager sees no edit', 'authenticated', adm, ecount, '0');
  perform pg_temp.ts_v('H2 inactive manager: RLS rows = ts_can_view rows', 'authenticated', adm, rls_e, pg_temp.ts_v_as('claims', adm, ref_e));
  perform pg_temp.ts_v('H3 inactive manager cannot edit', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '07:40', '16:30', s1_brks), 'zz-ed H3'), only_sign_ins);
  perform pg_temp.ts_v('H4 inactive manager cannot cancel even their own edit', 'authenticated', adm,
    pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed M11')), cant_cancel);
  perform pg_temp.ts_v_gianni(true, false, '[]');
  perform pg_temp.ts_v('H5 inactive admin sees no edit', 'authenticated', adm, ecount, '0');
  perform pg_temp.ts_v('H6 inactive admin cannot edit', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '07:40', '16:30', s1_brks), 'zz-ed H6'), only_sign_ins);
  perform pg_temp.ts_v('H7 inactive admin cannot cancel', 'authenticated', adm,
    pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed seed ' || a5)), cant_cancel);
  perform pg_temp.ts_v_gianni(true, true, '[]');

  -- ---------------------------------------------------------------- P. the admin in a session that was not a Google sign-in
  perform pg_temp.ts_v('P1 password session of an admin sees no edit', 'authenticated', adm, ecount, '0', 'password');
  perform pg_temp.ts_v('P2 password session of an admin cannot edit', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '07:40', '16:30', s1_brks), 'zz-ed P2'), only_sign_ins, 'password');
  perform pg_temp.ts_v('P3 password session of an admin cannot cancel', 'authenticated', adm,
    pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed seed ' || a5)), cant_cancel, 'password');
  perform pg_temp.ts_v('P4 password session: RLS rows = ts_can_view rows', 'authenticated', adm, rls_e,
    pg_temp.ts_v_as('claims', adm, ref_e, 'password'), 'password');
  perform pg_temp.ts_v('P5 OTP / magic-link session cannot edit', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '07:40', '16:30', s1_brks), 'zz-ed P5'), only_sign_ins, 'otp');
  perform pg_temp.ts_v('P6 a JWT without amr cannot edit', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '07:40', '16:30', s1_brks), 'zz-ed P6'), only_sign_ins, 'none');
  perform pg_temp.ts_v('P7 a JWT without amr sees no edit', 'authenticated', adm, ecount, '0', 'none');

  -- ---------------------------------------------------------------- N. a Google sign-in with no ts_access row (any BA)
  delete from public.ts_access where email = adm;   -- restored right below (and rolled back)
  perform pg_temp.ts_v('N1 BA sees no edit', 'authenticated', adm, ecount, '0');
  perform pg_temp.ts_v('N2 BA cannot edit', 'authenticated', adm,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '07:40', '16:30', s1_brks), 'zz-ed N2'), only_sign_ins);
  perform pg_temp.ts_v('N3 BA cannot cancel', 'authenticated', adm, pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed seed ' || a5)), cant_cancel);
  perform pg_temp.ts_v('N4 BA: RLS rows = ts_can_view rows', 'authenticated', adm, rls_e, pg_temp.ts_v_as('claims', adm, ref_e));
  perform pg_temp.ts_v_gianni(true, true, '[]');

  -- ---------------------------------------------------------------- C / D / B. stranger, automation@, anon
  perform pg_temp.ts_v('C1 stranger sees no edit', 'authenticated', null, ecount, '0');
  perform pg_temp.ts_v('C2 stranger cannot edit', 'authenticated', null,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '07:40', '16:30', s1_brks), 'zz-ed C2'), only_sign_ins);
  perform pg_temp.ts_v('C3 stranger cannot cancel', 'authenticated', null, pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed seed ' || a5)), cant_cancel);
  perform pg_temp.ts_v('C4 stranger cannot call the worker RPCs', 'authenticated', null,
    $q$select public.ts_edits_pending('times')::text$q$, 'ERROR 42501: ts_edits_pending is for the timesheet sync account only');
  perform pg_temp.ts_v('D1 automation@ sees no edit', 'authenticated', aut, ecount, '0');
  perform pg_temp.ts_v('D2 automation@ cannot edit (no ts_access row)', 'authenticated', aut,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '07:40', '16:30', s1_brks), 'zz-ed D2'), only_sign_ins);
  perform pg_temp.ts_v('D3 automation@ cannot cancel', 'authenticated', aut, pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed seed ' || a5)), cant_cancel);
  perform pg_temp.ts_v('B1 anon cannot read ts_edits', 'anon', null, ecount, 'ERROR 42501%');
  perform pg_temp.ts_v('B2 anon cannot call ts_edit_submit', 'anon', null,
    pg_temp.ts_v_sub(a1, 'zz-ed-s1', 'update', pg_temp.ts_v_after(t, la, '07:40', '16:30', s1_brks), 'zz-ed B2'), 'ERROR 42501%');
  perform pg_temp.ts_v('B3 anon cannot call ts_edit_cancel', 'anon', null, pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed seed ' || a5)), 'ERROR 42501%');
  perform pg_temp.ts_v('B4 anon cannot call ts_edits_pending', 'anon', null, $q$select public.ts_edits_pending('times')::text$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('B5 anon cannot call ts_edit_mark', 'anon', null,
    format($q$select public.ts_edit_mark(%L::uuid, 'times', 'applied', null)::text$q$, pg_temp.ts_v_id('zz-ed M11')), 'ERROR 42501%');
  perform pg_temp.ts_v('B6 nothing above wrote an edit', null, null,
    $q$select count(*) from public.ts_edits where note ~ '^zz-ed (H|P|N|C|D|B|Y4c|Y5|G4|U4|U5|Z)'$q$, '0');

  -- ---------------------------------------------------------------- K. admin cancels
  perform pg_temp.ts_v('K1 admin cancels someone else''s pending edit', 'authenticated', adm,
    pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed seed ' || a5)), pg_temp.ts_v_lit('cancelled/none/' || adm));
  perform pg_temp.ts_v('K2 cancelling an edit that does not exist', 'authenticated', adm,
    pg_temp.ts_v_cancel(gen_random_uuid()), 'ERROR P0001: No such edit');

  -- ---------------------------------------------------------------- Q. the workers (automation@ + the sync key)
  perform pg_temp.ts_v('Q1 automation@ without the sync key is refused', 'authenticated', aut,
    $q$select public.ts_edits_pending('times')::text$q$, 'ERROR 42501: ts_edits_pending needs the sync key');
  perform set_config('request.headers', '{"x-ts-sync-key":"wrong-key"}', true);
  perform pg_temp.ts_v('Q2 automation@ with a wrong key is refused', 'authenticated', aut,
    $q$select public.ts_edits_pending('times')::text$q$, 'ERROR 42501: ts_edits_pending needs the sync key');
  perform set_config('request.headers', '{"x-ts-sync-key":"zz-ed-sync-key"}', true);
  perform pg_temp.ts_v('Q3 the key alone is not enough: admin (Google) with the key is refused', 'authenticated', adm,
    $q$select public.ts_edits_pending('times')::text$q$, 'ERROR 42501: ts_edits_pending is for the timesheet sync account only');
  perform pg_temp.ts_v('Q4 ... and so is a stranger with the key', 'authenticated', null,
    format($q$select public.ts_edit_mark(%L::uuid, 'times', 'applied', null)::text$q$, pg_temp.ts_v_id('zz-ed M11')),
    'ERROR 42501: ts_edit_mark is for the timesheet sync account only');
  perform pg_temp.ts_v('Q5 pending times: exactly the edits whose times wait, oldest first', 'authenticated', aut, pend_times,
    pg_temp.ts_v_lit(pg_temp.ts_v_queue('times')));
  perform pg_temp.ts_v('Q6 pending breaks: exactly the edits whose breaks wait', 'authenticated', aut, pend_brks,
    pg_temp.ts_v_lit(pg_temp.ts_v_queue('breaks')));
  perform pg_temp.ts_v('Q7 refuses an unknown part', 'authenticated', aut,
    $q$select public.ts_edits_pending('both')::text$q$, 'ERROR P0001: The part must be times or breaks');
  perform pg_temp.ts_v('Q8 a part cannot be marked applied before a worker claims it', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed M11'), 'times', 'applied', null),
    'ERROR 55000: The times part of edit % is pending, not applying (claim it with the status applying first)');
  perform pg_temp.ts_v('Q8b claims a times part: applying, not stamped applied', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed M11'), 'times', 'applying', null), 'applying/(none)/false');
  perform pg_temp.ts_v('Q8c ... stamped as claimed now', null, null,
    $q$select (times_claimed_at = now())::text || '/' || (breaks_claimed_at is null)::text from public.ts_edits where note = 'zz-ed M11'$q$, 'true/true');
  perform pg_temp.ts_v('Q8d marks the claimed part applied (stamped, no error)', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed M11'), 'times', 'applied', null), 'applied/(none)/true');
  perform pg_temp.ts_v('Q9 ... which leaves the pending list', 'authenticated', aut,
    format($q$select count(*) from jsonb_array_elements(public.ts_edits_pending('times')) e where e->>'id' = %L$q$, pg_temp.ts_v_id('zz-ed M11')), '0');
  perform pg_temp.ts_v('Q10 marking it again is refused', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed M11'), 'times', 'applied', null), 'ERROR 55000: The times part of edit % is applied, not applying%');
  perform pg_temp.ts_v('Q10b ... and so is claiming it again', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed M11'), 'times', 'applying', null), 'ERROR 55000: The times part of edit % is applied, not pending');
  perform pg_temp.ts_v('Q11 a part that does not change cannot be claimed', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed S18'), 'times', 'applying', null), 'ERROR 55000: % is none, not pending');
  perform pg_temp.ts_v('Q12 a cancelled part cannot be claimed', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed S2'), 'breaks', 'applying', null), 'ERROR 55000: % is cancelled, not pending');
  perform pg_temp.ts_v('Q13 refuses an unknown status', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed S20'), 'times', 'pending', null), 'ERROR P0001: The status must be applying, applied, conflict or failed');
  perform pg_temp.ts_v('Q14 refuses an edit that does not exist', 'authenticated', aut,
    pg_temp.ts_v_mark(gen_random_uuid(), 'times', 'applied', null), 'ERROR P0001: No such edit: %');
  perform pg_temp.ts_v('Q15 (claims S20''s times, then) marks a conflict with its reason (not stamped applied)', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed S20'), 'times', 'applying', null), 'applying/(none)/false');
  perform pg_temp.ts_v('Q15b ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed S20'), 'times', 'conflict', '  Gusto shows a different start  '), 'conflict/Gusto shows a different start/false');
  perform pg_temp.ts_v('Q16 (claims S20''s breaks, then) a failure with no reason gets one', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed S20'), 'breaks', 'applying', null), 'applying/(none)/false');
  perform pg_temp.ts_v('Q16b ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed S20'), 'breaks', 'failed', '   '), 'failed/No details given/false');
  perform pg_temp.ts_v('Q17 (claims, then) marks a breaks part applied (stamped)', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed S11'), 'breaks', 'applying', null), 'applying/(none)/false');
  perform pg_temp.ts_v('Q17b ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed S11'), 'breaks', 'applied', null), 'applied/(none)/true');

  -- ---------------------------------------------------------------- K (continued). clearing a Needs a look when Gusto is right
  perform pg_temp.ts_v('K3 the creator (here an admin) clears a conflict and a failure: both parts become cancelled', 'authenticated', adm,
    pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed S20')), pg_temp.ts_v_lit('cancelled/cancelled/' || adm));
  perform pg_temp.ts_v('K4 ... the reasons Gusto gave are kept', null, null,
    $q$select times_error || '/' || breaks_error || '/' || (cancelled_at is not null) from public.ts_edits where note = 'zz-ed S20'$q$,
    'Gusto shows a different start/No details given/true');
  perform pg_temp.ts_v('K5 an edit with nothing waiting and nothing to look at cannot be cancelled', 'authenticated', adm,
    pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed M11')), 'ERROR P0001: This edit is no longer waiting to go to Gusto, so it cannot be cancelled');

  perform pg_temp.ts_v('Q18 (admin) edits a shift''s times and breaks', 'authenticated', adm,
    pg_temp.ts_v_sub(a6, 'zz-ed-s8', 'update', pg_temp.ts_v_after(t, la, '09:05', '17:00', '[["12:00","12:30","meal"]]'), 'zz-ed Q18'), 'update/pending/pending');
  perform pg_temp.ts_v('Q19 (worker) claims and applies its times', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed Q18'), 'times', 'applying', null), 'applying/(none)/false');
  perform pg_temp.ts_v('Q19b ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed Q18'), 'times', 'applied', null), 'applied/(none)/true');
  perform pg_temp.ts_v('Q20 (admin) edits the same shift again, having seen Q18: the times Gusto has now count, only the breaks wait', 'authenticated', adm,
    pg_temp.ts_v_subx(a6, 'zz-ed-s8', 'update', pg_temp.ts_v_after(t, la, '09:05', '17:00', '[["12:00","12:20","meal"]]'), 'zz-ed Q20',
                      jsonb_build_array(pg_temp.ts_v_id('zz-ed Q18'))), 'update/none/pending');
  perform pg_temp.ts_v('Q20b ... its before has the times now in Gusto (Q18''s), not the day row''s', null, null,
    format($q$select (before = %L::jsonb)::text from public.ts_edits where note = 'zz-ed Q20'$q$, pg_temp.ts_v_stored(t, la, '09:05', '17:00', '[]')), 'true');
  perform pg_temp.ts_v('Q21 supersede cancels only the part still pending: applied times stay applied', null, null,
    $q$select pg_temp.ts_v_st('zz-ed Q18') || '/' || pg_temp.ts_v_st('zz-ed U3')$q$, 'applied/cancelled/superseded/cancelled/none/superseded');
  -- a claim is a lock: nobody replaces or cancels a part while a worker writes it; one left behind is taken again
  perform pg_temp.ts_v('Q21b (worker) claims Q20''s breaks', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed Q20'), 'breaks', 'applying', null), 'applying/(none)/false');
  perform pg_temp.ts_v('Q21c ... a fresh claim is not handed out again', 'authenticated', aut,
    format($q$select count(*) from jsonb_array_elements(public.ts_edits_pending('breaks')) e where e->>'id' = %L$q$, pg_temp.ts_v_id('zz-ed Q20')), '0');
  perform pg_temp.ts_v('Q21d ... meanwhile the shift cannot be changed', 'authenticated', adm,
    pg_temp.ts_v_sub(a6, 'zz-ed-s8', 'update', pg_temp.ts_v_after(t, la, '09:05', '17:00', '[]'), 'zz-ed Q21d'), being_sent);
  perform pg_temp.ts_v('Q21e ... nor the edit cancelled', 'authenticated', adm,
    pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed Q20')), 'ERROR P0001: This change is being sent to Gusto right now, so it cannot be cancelled. Try again in a few minutes');
  update public.ts_edits set breaks_claimed_at = now() - interval '20 minutes' where note = 'zz-ed Q20';   -- the worker stopped
  perform pg_temp.ts_v('Q21f a claim older than 15 minutes is in the list again', 'authenticated', aut,
    format($q$select count(*) from jsonb_array_elements(public.ts_edits_pending('breaks')) e where e->>'id' = %L$q$, pg_temp.ts_v_id('zz-ed Q20')), '1');
  perform pg_temp.ts_v('Q21g ... and may be claimed again', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed Q20'), 'breaks', 'applying', null), 'applying/(none)/false');
  perform pg_temp.ts_v('Q21h ... claimed now', null, null,
    $q$select (breaks_claimed_at = now())::text from public.ts_edits where note = 'zz-ed Q20'$q$, 'true');
  perform pg_temp.ts_v('Q21i (worker) gives up on it with a reason', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed Q20'), 'breaks', 'failed', 'The Gusto page did not load'), 'failed/The Gusto page did not load/false');
  perform pg_temp.ts_v('K6 an admin clears that failure (times stay none)', 'authenticated', adm,
    pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed Q20')), pg_temp.ts_v_lit('none/cancelled/' || adm));
  perform pg_temp.ts_v('Q21j the refused submit wrote nothing', null, null, $q$select count(*) from public.ts_edits where note = 'zz-ed Q21d'$q$, '0');

  perform pg_temp.ts_v('Q22 (admin) edits a shift''s times and breaks; (worker) applies the breaks', 'authenticated', adm,
    pg_temp.ts_v_sub(b1, 'zz-ed-s7', 'update', pg_temp.ts_v_after(t, la, '08:25', '16:00', '[["12:00","12:30","meal"]]'), 'zz-ed Q22'), 'update/pending/pending');
  perform pg_temp.ts_v('Q23 ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed Q22'), 'breaks', 'applying', null), 'applying/(none)/false');
  perform pg_temp.ts_v('Q23b ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed Q22'), 'breaks', 'applied', null), 'applied/(none)/true');
  perform pg_temp.ts_v('Q24 cancel keeps the applied part: times cancelled, breaks applied', 'authenticated', adm,
    pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed Q22')), pg_temp.ts_v_lit('cancelled/applied/' || adm));

  -- ---------------------------------------------------------------- J. a change that reached Gusto before the next sync
  -- (the day row still shows the old value: what Gusto has is the applied edit's after)
  perform pg_temp.ts_v('J1 breaks only, as the day row has the times: the meal in Gusto since Q22 is a break to remove', 'authenticated', adm,
    pg_temp.ts_v_sub(b1, 'zz-ed-s7', 'update', pg_temp.ts_v_after(t, la, '08:00', '16:00', '[]'), 'zz-ed J1'), 'update/none/pending');
  perform pg_temp.ts_v('J2 ... its before has that meal', null, null,
    format($q$select (before = %L::jsonb)::text from public.ts_edits where note = 'zz-ed J1'$q$,
           pg_temp.ts_v_stored(t, la, '08:00', '16:00', '[["12:00","12:30","meal"]]')), 'true');
  perform pg_temp.ts_v('J3 the meal back while J1 waits: back to what Gusto has, none/none', 'authenticated', adm,
    pg_temp.ts_v_sub(b1, 'zz-ed-s7', 'update', pg_temp.ts_v_after(t, la, '08:00', '16:00', '[["12:00","12:30","meal"]]'), 'zz-ed J3'), 'update/none/none');
  perform pg_temp.ts_v('J4 ... then the same again is "Nothing changed"', 'authenticated', adm,
    pg_temp.ts_v_sub(b1, 'zz-ed-s7', 'update', pg_temp.ts_v_after(t, la, '08:00', '16:00', '[["12:00","12:30","meal"]]'), 'zz-ed J4'), 'ERROR P0001: Nothing changed%');
  perform pg_temp.ts_v('J5 (admin) moves the end of a5''s shift from 3 PM to 4 PM; (worker) claims it', 'authenticated', adm,
    pg_temp.ts_v_sub(a5, 'zz-ed-s6', 'update', pg_temp.ts_v_after(t, la, '07:00', '16:00', '[]'), 'zz-ed J5'), 'update/pending/none');
  perform pg_temp.ts_v('J6 ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed J5'), 'times', 'applying', null), 'applying/(none)/false');
  perform pg_temp.ts_v('J7 ... a claimed part is not claimed twice', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed J5'), 'times', 'applying', null), 'ERROR 55000: The times part of edit % is applying, not pending');
  perform pg_temp.ts_v('J8 ... and applied', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed J5'), 'times', 'applied', null), 'applied/(none)/true');
  perform pg_temp.ts_v('J9 before the next sync, the end back to 3 PM plus a meal: BOTH parts wait (4 PM is in Gusto)', 'authenticated', adm,
    pg_temp.ts_v_subx(a5, 'zz-ed-s6', 'update', pg_temp.ts_v_after(t, la, '07:00', '15:00', '[["12:00","12:30","meal"]]'), 'zz-ed J9',
                      jsonb_build_array(pg_temp.ts_v_id('zz-ed J5'))), 'update/pending/pending');
  perform pg_temp.ts_v('J10 ... its before is what Gusto has (the 4 PM end); J5 stays applied', null, null,
    format($q$select (before = %L::jsonb)::text || '/' || pg_temp.ts_v_st('zz-ed J5') from public.ts_edits where note = 'zz-ed J9'$q$,
           pg_temp.ts_v_stored(t, la, '07:00', '16:00', '[]')), 'true/applied/none/(none)');
  perform pg_temp.ts_v('J11 ... and its times are in the worker''s list', 'authenticated', aut,
    format($q$select count(*) from jsonb_array_elements(public.ts_edits_pending('times')) e where e->>'id' = %L$q$, pg_temp.ts_v_id('zz-ed J9')), '1');
  perform pg_temp.ts_v('J12 the end back to 3 PM alone is a change too (not "Nothing changed")', 'authenticated', adm,
    pg_temp.ts_v_sub(a5, 'zz-ed-s6', 'update', pg_temp.ts_v_after(t, la, '07:00', '15:00', '[]'), 'zz-ed J12'), 'update/pending/none');
  perform pg_temp.ts_v('J13 4 PM (what Gusto has) while J12 waits: back to Gusto, none/none', 'authenticated', adm,
    pg_temp.ts_v_sub(a5, 'zz-ed-s6', 'update', pg_temp.ts_v_after(t, la, '07:00', '16:00', '[]'), 'zz-ed J13'), 'update/none/none');
  perform pg_temp.ts_v('J14 ... and with nothing waiting it is "Nothing changed", although the day row still says 3 PM', 'authenticated', adm,
    pg_temp.ts_v_sub(a5, 'zz-ed-s6', 'update', pg_temp.ts_v_after(t, la, '07:00', '16:00', '[]'), 'zz-ed J14'), 'ERROR P0001: Nothing changed%');
  -- the next sync, after the apply; Gusto shows 4:10 PM (someone changed it there since)
  update public.ts_edits set times_applied_at = now() - interval '40 minutes' where note = 'zz-ed J5';
  update public.ts_days set shifts = jsonb_build_array(pg_temp.ts_v_shift('zz-ed-s6', t, la, '07:00', '16:10', '[]')),
                            synced_at = now() - interval '30 minutes' where id = a5;
  perform pg_temp.ts_v('J15 after a sync the day row counts again: 4 PM is a change from its 4:10 PM', 'authenticated', adm,
    pg_temp.ts_v_sub(a5, 'zz-ed-s6', 'update', pg_temp.ts_v_after(t, la, '07:00', '16:00', '[]'), 'zz-ed J15'), 'update/pending/none');
  perform pg_temp.ts_v('J16 ... with the synced 4:10 PM as before', null, null,
    format($q$select (before = %L::jsonb)::text from public.ts_edits where note = 'zz-ed J15'$q$, pg_temp.ts_v_stored(t, la, '07:00', '16:10', '[]')), 'true');
  perform pg_temp.ts_v('J17 (admin) deletes the shift; (worker) claims and applies that', 'authenticated', adm,
    pg_temp.ts_v_sub(a5, 'zz-ed-s6', 'delete', null, 'zz-ed J17'), 'delete/none/pending');
  perform pg_temp.ts_v('J18 ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed J17'), 'breaks', 'applying', null), 'applying/(none)/false');
  perform pg_temp.ts_v('J19 ...', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed J17'), 'breaks', 'applied', null), 'applied/(none)/true');
  perform pg_temp.ts_v('J20 until a sync drops it, the deleted shift cannot be changed', 'authenticated', adm,
    pg_temp.ts_v_sub(a5, 'zz-ed-s6', 'update', pg_temp.ts_v_after(t, la, '07:00', '15:00', '[]'), 'zz-ed J20'),
    'ERROR P0001: That shift was just deleted in Gusto. Reload after the next sync');
  perform pg_temp.ts_v('J21 ... nor deleted again', 'authenticated', adm,
    pg_temp.ts_v_sub(a5, 'zz-ed-s6', 'delete', null, 'zz-ed J21'), 'ERROR P0001: That shift was just deleted in Gusto%');
  perform pg_temp.ts_v('J22 ... and its slot is free for an add', 'authenticated', adm,
    pg_temp.ts_v_sub(a5, null, 'add', pg_temp.ts_v_after(t, la, '07:00', '15:00', '[]'), 'zz-ed J22'), 'add/pending/none');
  perform pg_temp.ts_v('J23 the refused J submits wrote nothing', null, null,
    $q$select count(*) from public.ts_edits where note in ('zz-ed J4', 'zz-ed J14', 'zz-ed J20', 'zz-ed J21')$q$, '0');

  perform pg_temp.ts_v('Q25 a finished edit is never superseded: a new edit of its shift leaves it alone', 'authenticated', adm,
    pg_temp.ts_v_sub(a2, 'zz-ed-s3', 'update', pg_temp.ts_v_after(w, la, '08:15', '16:00', '[]'), 'zz-ed Q25'), 'update/pending/none');
  perform pg_temp.ts_v('Q26 ... still applied/none, not cancelled', null, null, $q$select pg_temp.ts_v_st('zz-ed M11')$q$, 'applied/none/(none)');
  perform pg_temp.ts_v('Q27 the pending lists track every change above', 'authenticated', aut,
    format($q$select (%s) || '|' || (%s)$q$, pend_times, pend_brks),
    pg_temp.ts_v_lit(pg_temp.ts_v_queue('times') || '|' || pg_temp.ts_v_queue('breaks')));
  perform pg_temp.ts_v('Q28 automation@ reads no ts_edits rows directly, key or not', 'authenticated', aut, ecount, '0');
  update public.ts_sync_keys set revoked_at = now() where label = 'verify edits (rolled back)';
  perform pg_temp.ts_v('Q29 a revoked key is refused', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed Q25'), 'times', 'applying', null), 'ERROR 42501: ts_edit_mark needs the sync key');
  update public.ts_sync_keys set revoked_at = null where label = 'verify edits (rolled back)';
  perform set_config('request.headers', '', true);
  perform pg_temp.ts_v('Q30 a missing key is refused', 'authenticated', aut,
    pg_temp.ts_v_mark(pg_temp.ts_v_id('zz-ed Q25'), 'times', 'applying', null), 'ERROR 42501: ts_edit_mark needs the sync key');
  perform pg_temp.ts_v('Q31 the refused marks changed nothing', null, null, $q$select pg_temp.ts_v_st('zz-ed Q25')$q$, 'pending/none/(none)');

  -- ---------------------------------------------------------------- T. a sync moves the person to another department (day aX)
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"zz_ed_a","department":"Distro/Trim"}]');
  perform pg_temp.ts_v('T1 (Distro/Trim manager) edits aX', 'authenticated', adm,
    pg_temp.ts_v_sub(ax, 'zz-ed-s14', 'update', pg_temp.ts_v_after(t, la, '08:00', '16:30', '[]'), 'zz-ed T1'), 'update/pending/none');
  update public.ts_days set department = 'Cultivation' where id = ax;   -- what ts_sync may do to today's row
  perform pg_temp.ts_v('T2 the old department''s manager no longer sees the day, still sees the 2 edits made under it', 'authenticated', adm,
    format($q$select (select count(*) from public.ts_days where id = %L) || '/' || (select count(*) from public.ts_edits where day_id = %L)$q$, ax, ax), '0/2');
  perform pg_temp.ts_v('T3 ... but cannot cancel even their own edit of it', 'authenticated', adm,
    pg_temp.ts_v_cancel(pg_temp.ts_v_id('zz-ed T1')), 'ERROR 42501: You can no longer see this day, so you cannot cancel its edits');
  perform pg_temp.ts_v('T4 ... nor edit the day', 'authenticated', adm,
    pg_temp.ts_v_sub(ax, 'zz-ed-s14', 'update', pg_temp.ts_v_after(t, la, '08:00', '16:40', '[]'), 'zz-ed T4'), no_day);
  perform pg_temp.ts_v('T5 old department: RLS rows = reference rows', 'authenticated', adm, rls_e, pg_temp.ts_v_as('claims', adm, ref_e));
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"zz_ed_a","department":"Cultivation"}]');
  perform pg_temp.ts_v('T6 the new department''s manager sees the day and both edits of it, made under the old department', 'authenticated', adm,
    format($q$select (select count(*) from public.ts_days where id = %L) || '/' || (select count(*) from public.ts_edits where day_id = %L)$q$, ax, ax), '1/2');
  perform pg_temp.ts_v('T7 new department: RLS rows = reference rows', 'authenticated', adm, rls_e, pg_temp.ts_v_as('claims', adm, ref_e));
  perform pg_temp.ts_v('T8 a save that did not show T1 is refused', 'authenticated', adm,
    pg_temp.ts_v_subx(ax, 'zz-ed-s14', 'update', pg_temp.ts_v_after(t, la, '08:00', '16:00', '[["12:00","12:30","meal"]]'), 'zz-ed T8', '[]'), someone);
  perform pg_temp.ts_v('T9 the same save that showed T1 goes through', 'authenticated', adm,
    pg_temp.ts_v_subx(ax, 'zz-ed-s14', 'update', pg_temp.ts_v_after(t, la, '08:00', '16:30', '[["12:00","12:30","meal"]]'), 'zz-ed T9',
                      jsonb_build_array(pg_temp.ts_v_id('zz-ed T1'))), 'update/pending/pending');
  perform pg_temp.ts_v('T10 ... it copies the day row''s department as it is now, and replaced T1', null, null,
    $q$select department || '/' || pg_temp.ts_v_st('zz-ed T1') from public.ts_edits where note = 'zz-ed T9'$q$, 'Cultivation/cancelled/none/superseded');
  perform pg_temp.ts_v('T11 the refused ones wrote nothing', null, null, $q$select count(*) from public.ts_edits where note in ('zz-ed T4', 'zz-ed T8')$q$, '0');
  update public.ts_days set department = 'Distro/Trim' where id = ax;
  perform pg_temp.ts_v_gianni(true, true, '[]');

  -- ---------------------------------------------------------------- X. at the end, every identity again: RLS = reference
  perform pg_temp.ts_v('X1 admin at the end: RLS rows = ts_can_view rows', 'authenticated', adm, rls_e, pg_temp.ts_v_as('claims', adm, ref_e));
  perform pg_temp.ts_v('X2 stranger at the end: RLS rows = ts_can_view rows', 'authenticated', null, rls_e, pg_temp.ts_v_as('claims', null, ref_e));
  perform pg_temp.ts_v('X3 automation@ at the end: RLS rows = ts_can_view rows', 'authenticated', aut, rls_e, pg_temp.ts_v_as('claims', aut, ref_e));
  perform pg_temp.ts_v_gianni(false, true, '[{"company":"zz_ed_a","department":"Distro/Trim"},{"company":"zz_ed_ny","department":"Distro Hourly"}]');
  perform pg_temp.ts_v_gianni_views('["zz-ed-v1"]');
  perform pg_temp.ts_v('X4 grants + a view together: RLS rows = ts_can_view rows', 'authenticated', adm, rls_e, pg_temp.ts_v_as('claims', adm, ref_e));
  perform pg_temp.ts_v('X5 grants + a view together: edits of the 12 days of the union', 'authenticated', adm, same_q, 'true/12');
  perform pg_temp.ts_v_gianni(true, true, '[]');
  perform pg_temp.ts_v_gianni_views('[]');
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
