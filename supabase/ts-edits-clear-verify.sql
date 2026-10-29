-- Verification for supabase/ts-edits-clear.sql (Manager Timesheets: a "Needs a look" Gusto has settled clears itself).
--
-- One transaction that ROLLS BACK, in the same harness as supabase/ts-edits-verify.sql: throwaway companies
-- 'zz_cl_a' (CA) and 'zz_cl_ny' (NY), synthetic people "Test Person zz-cl-...", day rows dated relative to TODAY
-- (inside and outside the edit window), edits written straight into ts_edits as the owner in the states a worker
-- leaves them in (conflict, failed, applied, pending, applying, cancelled), and a throwaway sync key. It plays each
-- identity, records what each can do, returns one pass/fail table and undoes everything. Run it with write access as
-- the project owner (SQL editor, or the management API without read_only) after ts-edits.sql and
-- ts-edits-clear.sql (and ts-edit-notes.sql on a table made before notes: the T checks store notes); the last result
-- set is the pass/fail table. Every row must say pass = true.
--
-- Identities: anon; admin = gianni@ (Google, an active admin row); automation@ (password) with and without the sync
-- key in the x-ts-sync-key header.

begin;

create temp table ts_v_results (
  seq serial primary key,
  test text not null,
  expected text not null,      -- a LIKE pattern (escape '!'); plain text means equal
  got text
) on commit drop;

-- Run p_sql as an identity and return its single value as text, or 'ERROR <sqlstate>: <message>' (as in
-- ts-edits-verify.sql: p_role null = the owner; 'anon'; 'authenticated' + a confirmed auth.users email).
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

-- a local clock time on a date in a zone, as ISO with the zone's offset
create function pg_temp.ts_v_iso(p_d date, p_hm text, p_tz text) returns text
language plpgsql as $f$
declare v_old text := current_setting('TimeZone'); v text;
begin
  perform set_config('TimeZone', p_tz, true);
  v := to_char((p_d + p_hm::time) at time zone p_tz, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM');
  perform set_config('TimeZone', v_old, true);
  return v;
end $f$;

-- one synthetic day row with one shift 8:00 AM to 4:00 PM, last synced an hour ago; returns its id
create function pg_temp.ts_v_day(p_company text, p_region text, p_uuid text, p_d date, p_tz text) returns text
language sql as $f$
  insert into public.ts_days (id, company, region, employee_uuid, employee_name, department, work_date, first_in, last_out, shifts, "open", synced_at)
  values (p_company || ':' || p_uuid || ':' || to_char(p_d, 'YYYY-MM-DD'), p_company, p_region, p_uuid, 'Test Person ' || p_uuid,
          'Distro/Trim', p_d, (p_d + time '08:00') at time zone p_tz, (p_d + time '16:00') at time zone p_tz,
          jsonb_build_array(jsonb_build_object('id', p_uuid || '-s', 'in', pg_temp.ts_v_iso(p_d, '08:00', p_tz), 'out', pg_temp.ts_v_iso(p_d, '16:00', p_tz),
            'span_min', 480, 'worked_min', 480, 'hours_only', false, 'breaks', '[]'::jsonb)), false, now() - interval '1 hour')
  returning id
$f$;

-- (owner) one edit of that day's shift, in the given part states; note = its tag; returns its id
create function pg_temp.ts_v_edit(p_day text, p_tag text, p_times text, p_breaks text, p_terr text, p_berr text) returns uuid
language sql as $f$
  insert into public.ts_edits (day_id, company, region, employee_uuid, department, work_date, shift_id, action, before, after, note,
                               times_status, breaks_status, times_error, breaks_error, times_claimed_at, breaks_claimed_at, created_by, created_at)
  select d.id, d.company, d.region, d.employee_uuid, d.department, d.work_date, d.shifts->0->>'id', 'update',
         jsonb_build_object('in', d.shifts->0->'in', 'out', d.shifts->0->'out', 'breaks', '[]'::jsonb),
         jsonb_build_object('in', d.shifts->0->'in', 'out', d.shifts->0->'out', 'breaks', '[]'::jsonb),
         p_tag, p_times, p_breaks, p_terr, p_berr,
         case when p_times = 'applying' then now() else now() - interval '1 hour' end,
         case when p_breaks = 'applying' then now() else now() - interval '1 hour' end, 'zz-cl-lead@wizardtrees.com',
         clock_timestamp()   -- one after the other, so "oldest first" has one answer
    from public.ts_days d where d.id = p_day
  returning id
$f$;
create function pg_temp.ts_v_id(p_tag text) returns uuid language sql as $f$ select e.id from public.ts_edits e where e.note = p_tag $f$;
-- (owner) 'times/breaks/cancelled_by/cancel_reason/times_error/breaks_error' of the edit with that tag
create function pg_temp.ts_v_st(p_tag text) returns text
language sql as $f$
  select coalesce(string_agg(e.times_status || '/' || e.breaks_status || '/' || coalesce(e.cancelled_by, '(none)') || '/' || coalesce(e.cancel_reason, '(none)')
                             || '/' || coalesce(e.times_error, '(none)') || '/' || coalesce(e.breaks_error, '(none)') || '/' || (e.cancelled_at is not null), ','), '(no edit)')
    from public.ts_edits e where e.note = p_tag
$f$;
-- the worker's clear as SQL text, returning 'times/breaks/cancelled_by/cancel_reason'
create function pg_temp.ts_v_clear(p_id uuid, p_reason text) returns text
language sql immutable as $f$
  select format($q$select (r->>'times_status') || '/' || (r->>'breaks_status') || '/' || coalesce(r->>'cancelled_by', '(none)') || '/' || coalesce(r->>'cancel_reason', '(none)')
                    from (select public.ts_edit_clear(%L::uuid, %L) r) s$q$, p_id, p_reason)
$f$;
-- the synthetic edits ts_edits_to_recheck lists, by tag, in its order
create function pg_temp.ts_v_recheck_q() returns text
language sql immutable as $f$
  select $q$select coalesce(string_agg(e->>'note', ',' order by o), '(none)') from jsonb_array_elements(public.ts_edits_to_recheck()) with ordinality x(e, o)
            where e->>'day_id' like 'zz!_cl!_%' escape '!'$q$
$f$;

-- ------------------------------------------------------------------ setup (as owner, rolled back)
insert into public.ts_access (email, is_admin, active, note) values ('gianni@wizardtrees.com', true, true, 'owner')
on conflict (email) do update set is_admin = true, active = true;
insert into public.ts_companies (key, name, region) values ('zz_cl_a', 'Verify Clear A', 'CA'), ('zz_cl_ny', 'Verify Clear NY', 'NY')
on conflict do nothing;
insert into public.ts_sync_keys (key_hash, label) values (encode(sha256(convert_to('zz-cl-sync-key', 'utf8')), 'hex'), 'verify clear (rolled back)');
select set_config('request.headers', '', true);

do $v$
declare
  adm  constant text := 'gianni@wizardtrees.com';
  aut  constant text := 'automation@wizardtrees.com';
  la   constant text := 'America/Los_Angeles';
  nyz  constant text := 'America/New_York';
  t    constant date := (now() at time zone 'America/Los_Angeles')::date - 2;
  nt   constant date := (now() at time zone 'America/New_York')::date - 2;
  -- the first day of the previous pay period (periods start on the Saturdays 2026-09-26 + 14k), worked out here
  w    constant date := date '2026-09-26' + 14 * floor((((now() at time zone 'America/Los_Angeles')::date) - date '2026-09-26') / 14.0)::int - 14;
  d1 text; d2 text; d3 text; d4 text; d5 text; d6 text; d7 text; d8 text; dn text; dold text;
  key_on  constant text := '{"x-ts-sync-key": "zz-cl-sync-key"}';
  long_reason constant text := repeat('x', 320);
begin
  d1 := pg_temp.ts_v_day('zz_cl_a', 'CA', 'zz-cl-1', t, la);
  d2 := pg_temp.ts_v_day('zz_cl_a', 'CA', 'zz-cl-2', t, la);
  d3 := pg_temp.ts_v_day('zz_cl_a', 'CA', 'zz-cl-3', t, la);
  d4 := pg_temp.ts_v_day('zz_cl_a', 'CA', 'zz-cl-4', t, la);
  d5 := pg_temp.ts_v_day('zz_cl_a', 'CA', 'zz-cl-5', t, la);
  d6 := pg_temp.ts_v_day('zz_cl_a', 'CA', 'zz-cl-6', t, la);
  d7 := pg_temp.ts_v_day('zz_cl_a', 'CA', 'zz-cl-7', w, la);
  d8 := pg_temp.ts_v_day('zz_cl_a', 'CA', 'zz-cl-8', t, la);
  dold := pg_temp.ts_v_day('zz_cl_a', 'CA', 'zz-cl-9', w - 1, la);
  dn := pg_temp.ts_v_day('zz_cl_ny', 'NY', 'zz-cl-n', nt, nyz);
  perform pg_temp.ts_v_edit(d1, 'zz-cl E1', 'conflict', 'conflict', 'Gusto keeps this shift on two days', 'Gusto keeps this shift on two days');
  perform pg_temp.ts_v_edit(d2, 'zz-cl E2', 'none', 'failed', null, 'Gusto refused the change: Breaks cannot overlap');
  perform pg_temp.ts_v_edit(d3, 'zz-cl E3', 'applied', 'conflict', null, 'Gusto already sent the hours to payroll');
  perform pg_temp.ts_v_edit(d4, 'zz-cl E4', 'pending', 'conflict', null, 'odd: one part still waits');
  perform pg_temp.ts_v_edit(d5, 'zz-cl E5', 'applying', 'failed', null, 'odd: one part being sent');
  perform pg_temp.ts_v_edit(d6, 'zz-cl E6', 'applied', 'applied', null, null);
  perform pg_temp.ts_v_edit(d7, 'zz-cl E7', 'conflict', 'none', 'the oldest editable day', null);
  perform pg_temp.ts_v_edit(d8, 'zz-cl E8', 'cancelled', 'cancelled', 'a manager cleared it', 'a manager cleared it');
  update public.ts_edits set cancelled_by = 'zz-cl-lead@wizardtrees.com', cancelled_at = now() where note = 'zz-cl E8';
  perform pg_temp.ts_v_edit(dold, 'zz-cl E9', 'conflict', 'conflict', 'too old', 'too old');
  perform pg_temp.ts_v_edit(dn, 'zz-cl N1', 'none', 'conflict', null, 'New York');

  -- ---------------------------------------------------------------- A. structure and grants
  perform pg_temp.ts_v('A1 ts_edits has cancel_reason (text), readable through the table''s SELECT grant', null, null,
    $q$select format_type(a.atttypid, a.atttypmod) || '/' || has_column_privilege('authenticated', 'public.ts_edits', 'cancel_reason', 'SELECT')
         from pg_attribute a where a.attrelid = 'public.ts_edits'::regclass and a.attname = 'cancel_reason' and not a.attisdropped$q$, 'text/true');
  perform pg_temp.ts_v('A2 a cancel_reason over 300 characters (or blank) cannot be stored, even by the owner', null, null,
    $q$update public.ts_edits set cancel_reason = repeat('y', 301) where note = 'zz-cl E6' returning id::text$q$, 'ERROR 23514%');
  perform pg_temp.ts_v('A3 authenticated can execute both worker RPCs; PUBLIC and anon neither', null, null,
    $q$select string_agg(p.proname || '=' || has_function_privilege('authenticated', p.oid, 'EXECUTE') || '/' || has_function_privilege('public', p.oid, 'EXECUTE')
                         || '/' || has_function_privilege('anon', p.oid, 'EXECUTE'), ',' order by p.proname)
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('ts_edit_clear', 'ts_edits_to_recheck')$q$,
    pg_temp.ts_v_lit('ts_edit_clear=true/false/false,ts_edits_to_recheck=true/false/false'));
  perform pg_temp.ts_v('A4 both are security definer with search_path=public, one signature each', null, null,
    $q$select count(*) filter (where p.prosecdef and coalesce(array_to_string(p.proconfig, ',') like '%search_path=public%', false)) || '/' || count(*)
              || '/' || string_agg(p.oid::regprocedure::text, ',' order by p.proname)
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('ts_edit_clear', 'ts_edits_to_recheck')$q$,
    pg_temp.ts_v_lit('2/2/ts_edit_clear(uuid,text),ts_edits_to_recheck()'));
  perform pg_temp.ts_v('A5 ts_edit_mark still takes only applying, applied, conflict or failed (clearing is ts_edit_clear''s alone)', null, null,
    $q$select pg_get_function_identity_arguments('public.ts_edit_mark(uuid,text,text,text)'::regprocedure)$q$, 'p_id uuid, p_part text, p_status text, p_error text');

  -- ---------------------------------------------------------------- G. who may call them
  perform pg_temp.ts_v('G1 an admin (Google) cannot list them', 'authenticated', adm,
    $q$select public.ts_edits_to_recheck()::text$q$, 'ERROR 42501: ts_edits_to_recheck is for the timesheet sync account only');
  perform pg_temp.ts_v('G2 an admin (Google) cannot clear one', 'authenticated', adm,
    pg_temp.ts_v_clear(pg_temp.ts_v_id('zz-cl E1'), 'Gusto now matches'), 'ERROR 42501: ts_edit_clear is for the timesheet sync account only');
  perform pg_temp.ts_v('G3 anon can call neither', 'anon', null, $q$select public.ts_edits_to_recheck()::text$q$, 'ERROR 42501%');
  perform pg_temp.ts_v('G4 anon cannot clear', 'anon', null, pg_temp.ts_v_clear(pg_temp.ts_v_id('zz-cl E1'), 'Gusto now matches'), 'ERROR 42501%');
  perform pg_temp.ts_v('G5 automation@ without the sync key cannot list', 'authenticated', aut,
    $q$select public.ts_edits_to_recheck()::text$q$, 'ERROR 42501: ts_edits_to_recheck needs the sync key');
  perform pg_temp.ts_v('G6 automation@ without the sync key cannot clear', 'authenticated', aut,
    pg_temp.ts_v_clear(pg_temp.ts_v_id('zz-cl E1'), 'Gusto now matches'), 'ERROR 42501: ts_edit_clear needs the sync key');
  perform pg_temp.ts_v('G7 the refused calls changed nothing', null, null, $q$select pg_temp.ts_v_st('zz-cl E1')$q$,
    pg_temp.ts_v_lit('conflict/conflict/(none)/(none)/Gusto keeps this shift on two days/Gusto keeps this shift on two days/false'));
  perform set_config('request.headers', key_on, true);
  perform pg_temp.ts_v('G8 an admin (Google) WITH the key still cannot clear', 'authenticated', adm,
    pg_temp.ts_v_clear(pg_temp.ts_v_id('zz-cl E1'), 'Gusto now matches'), 'ERROR 42501: ts_edit_clear is for the timesheet sync account only');

  -- ---------------------------------------------------------------- L. what needs a recheck (automation@ + key)
  perform pg_temp.ts_v('L1 lists the edits in conflict or failed inside the window, oldest first: none waiting, being sent, done, cleared or too old', 'authenticated', aut,
    pg_temp.ts_v_recheck_q(), 'zz-cl E1,zz-cl E2,zz-cl E3,zz-cl E7,zz-cl N1');
  perform pg_temp.ts_v('L2 each row is a whole edit row (its parts, errors and before/after)', 'authenticated', aut,
    $q$select string_agg(distinct (e ? 'before')::text || (e ? 'after')::text || (e ? 'breaks_error')::text || (e ? 'cancel_reason')::text, ',')
         from jsonb_array_elements(public.ts_edits_to_recheck()) e where e->>'day_id' like 'zz!_cl!_%' escape '!'$q$, 'truetruetruetrue');

  -- ---------------------------------------------------------------- C. clearing
  perform pg_temp.ts_v('C1 a blank reason is refused', 'authenticated', aut, pg_temp.ts_v_clear(pg_temp.ts_v_id('zz-cl E1'), '   '),
    'ERROR P0001: Say why the edit is cleared');
  perform pg_temp.ts_v('C2 no such edit', 'authenticated', aut, pg_temp.ts_v_clear(gen_random_uuid(), 'Gusto now matches'), 'ERROR P0001: No such edit: %');
  perform pg_temp.ts_v('C3 conflict + conflict: both parts cleared, by gusto-sync, with the reason', 'authenticated', aut,
    pg_temp.ts_v_clear(pg_temp.ts_v_id('zz-cl E1'), '  Fixed in Gusto by hand: the shift changed in Gusto  '),
    'cancelled/cancelled/gusto-sync/Fixed in Gusto by hand: the shift changed in Gusto');
  perform pg_temp.ts_v('C4 ... the error texts stay, and the edit is cancelled', null, null, $q$select pg_temp.ts_v_st('zz-cl E1')$q$,
    pg_temp.ts_v_lit('cancelled/cancelled/gusto-sync/Fixed in Gusto by hand: the shift changed in Gusto/Gusto keeps this shift on two days/Gusto keeps this shift on two days/true'));
  perform pg_temp.ts_v('C5 a part that does not change stays none; a failed part is cleared', 'authenticated', aut,
    pg_temp.ts_v_clear(pg_temp.ts_v_id('zz-cl E2'), 'Gusto now matches'), 'none/cancelled/gusto-sync/Gusto now matches');
  perform pg_temp.ts_v('C6 an applied part stays applied', 'authenticated', aut,
    pg_temp.ts_v_clear(pg_temp.ts_v_id('zz-cl E3'), long_reason), 'applied/cancelled/gusto-sync/' || pg_temp.ts_v_lit(repeat('x', 300)));
  perform pg_temp.ts_v('C7 ... a reason over 300 characters is cut to 300', null, null,
    $q$select length(cancel_reason) from public.ts_edits where note = 'zz-cl E3'$q$, '300');
  perform pg_temp.ts_v('C8 a New York edit clears the same way', 'authenticated', aut,
    pg_temp.ts_v_clear(pg_temp.ts_v_id('zz-cl N1'), 'Gusto now matches'), 'none/cancelled/gusto-sync/Gusto now matches');
  perform pg_temp.ts_v('C9 the oldest editable day can be cleared', 'authenticated', aut,
    pg_temp.ts_v_clear(pg_temp.ts_v_id('zz-cl E7'), 'Gusto now matches'), 'cancelled/none/gusto-sync/Gusto now matches');

  -- ---------------------------------------------------------------- R. refused, nothing changes (55000)
  perform pg_temp.ts_v('R1 already cleared: refused', 'authenticated', aut, pg_temp.ts_v_clear(pg_temp.ts_v_id('zz-cl E1'), 'again'),
    'ERROR 55000: Edit % is already cancelled or replaced');
  perform pg_temp.ts_v('R2 cleared by a manager: refused', 'authenticated', aut, pg_temp.ts_v_clear(pg_temp.ts_v_id('zz-cl E8'), 'again'),
    'ERROR 55000: Edit % is already cancelled or replaced');
  perform pg_temp.ts_v('R3 a part still waiting: refused', 'authenticated', aut, pg_temp.ts_v_clear(pg_temp.ts_v_id('zz-cl E4'), 'Gusto now matches'),
    'ERROR 55000: Edit % is still going to Gusto (times pending, breaks conflict), so it is not cleared');
  perform pg_temp.ts_v('R4 a part being sent: refused', 'authenticated', aut, pg_temp.ts_v_clear(pg_temp.ts_v_id('zz-cl E5'), 'Gusto now matches'),
    'ERROR 55000: Edit % is still going to Gusto (times applying, breaks failed), so it is not cleared');
  perform pg_temp.ts_v('R5 nothing to look at (both applied): refused', 'authenticated', aut, pg_temp.ts_v_clear(pg_temp.ts_v_id('zz-cl E6'), 'Gusto now matches'),
    'ERROR 55000: Edit % does not need a look (times applied, breaks applied)');
  perform pg_temp.ts_v('R6 the refused ones are unchanged', null, null,
    $q$select string_agg(note || '=' || times_status || '/' || breaks_status || '/' || coalesce(cancelled_by, '(none)') || '/' || coalesce(cancel_reason, '(none)'), ',' order by note)
         from public.ts_edits where note in ('zz-cl E4', 'zz-cl E5', 'zz-cl E6', 'zz-cl E8')$q$,
    pg_temp.ts_v_lit('zz-cl E4=pending/conflict/(none)/(none),zz-cl E5=applying/failed/(none)/(none),zz-cl E6=applied/applied/(none)/(none),')
      || pg_temp.ts_v_lit('zz-cl E8=cancelled/cancelled/zz-cl-lead@wizardtrees.com/(none)'));

  -- ---------------------------------------------------------------- K. after a clear
  perform pg_temp.ts_v('K1 a cleared edit is no longer listed (only the out-of-window one is left, and it is not listed either)', 'authenticated', aut,
    pg_temp.ts_v_recheck_q(), '(none)');
  perform pg_temp.ts_v('K2 nor waiting for the workers: their lists hold only E4''s waiting part', 'authenticated', aut,
    $q$select coalesce(string_agg(e->>'note', ','), '(none)') from jsonb_array_elements(public.ts_edits_pending('times') || public.ts_edits_pending('breaks')) e
        where e->>'note' like 'zz-cl %'$q$, 'zz-cl E4');
  perform pg_temp.ts_v('K3 every cleared edit is cancelled in both parts that needed a look, none left pending', null, null,
    $q$select count(*) || '/' || count(*) filter (where 'pending' in (times_status, breaks_status) or 'conflict' in (times_status, breaks_status) or 'failed' in (times_status, breaks_status))
         from public.ts_edits where note like 'zz-cl %' and cancelled_by = 'gusto-sync'$q$, '5/0');
  perform pg_temp.ts_v('K4 a manager''s Clear of a cleared edit is refused (it is no longer waiting)', 'authenticated', adm,
    format($q$select (public.ts_edit_cancel(%L::uuid))::text$q$, pg_temp.ts_v_id('zz-cl E2')), 'ERROR P0001: This edit is no longer waiting to go to Gusto, so it cannot be cancelled');
  perform pg_temp.ts_v('K5 a manager''s Clear still works on its own and leaves cancel_reason empty', 'authenticated', adm,
    format($q$select (r->>'cancelled_by') || '/' || coalesce(r->>'cancel_reason', '(none)') from (select public.ts_edit_cancel(%L::uuid) r) s$q$, pg_temp.ts_v_id('zz-cl E9')),
    'gianni@wizardtrees.com/(none)');
  perform pg_temp.ts_v('K6 the board (an admin) reads the reason through RLS', 'authenticated', adm,
    $q$select cancel_reason from public.ts_edits where note = 'zz-cl E2'$q$, 'Gusto now matches');
  perform pg_temp.ts_v('K7 anon reads nothing', 'anon', null, $q$select count(*) from public.ts_edits$q$, 'ERROR 42501%');

  -- ---------------------------------------------------------------- T. notes (action 'note', supabase/ts-edit-notes.sql): a note rides
  -- the breaks part, so it needs a look, is rechecked and is cleared like any edit (still automation@ + key)
  insert into public.ts_edits (day_id, company, region, employee_uuid, department, work_date, shift_id, action, before, note,
                               times_status, breaks_status, breaks_error, breaks_claimed_at, created_by, created_at)
  select d.id, d.company, d.region, d.employee_uuid, d.department, d.work_date, d.shifts->0->>'id', 'note',
         jsonb_build_object('in', d.shifts->0->'in', 'out', d.shifts->0->'out', 'breaks', '[]'::jsonb), x.tag,
         'none', x.brk, x.err, now() - interval '1 hour', 'zz-cl-lead@wizardtrees.com', clock_timestamp()
    from public.ts_days d
   cross join (values ('zz-cl T1 note', 'conflict', 'Gusto did not keep the note'), ('zz-cl T2 note', 'pending', null)) x(tag, brk, err)
   where d.id = d6;
  perform pg_temp.ts_v('T1 a note that needs a look is listed; a waiting note is not', 'authenticated', aut, pg_temp.ts_v_recheck_q(), 'zz-cl T1 note');
  perform pg_temp.ts_v('T2 ... the waiting one is in the workers'' breaks list (and not the times list)', 'authenticated', aut,
    $q$select coalesce(string_agg(x.k || ':' || (e->>'note'), ',' order by x.k), '(none)')
         from (select 'b' k, public.ts_edits_pending('breaks') l union all select 't', public.ts_edits_pending('times')) x
        cross join lateral jsonb_array_elements(x.l) e where e->>'note' like 'zz-cl T%'$q$, 'b:zz-cl T2 note');
  perform pg_temp.ts_v('T3 the sync clears the note that needs a look', 'authenticated', aut,
    pg_temp.ts_v_clear(pg_temp.ts_v_id('zz-cl T1 note'), 'Gusto now has the note'), 'none/cancelled/gusto-sync/Gusto now has the note');
  perform pg_temp.ts_v('T4 ... its error text stays', null, null, $q$select pg_temp.ts_v_st('zz-cl T1 note')$q$,
    'none/cancelled/gusto-sync/Gusto now has the note/(none)/Gusto did not keep the note/true');
  perform pg_temp.ts_v('T5 the waiting note is not cleared (it is still going to Gusto)', 'authenticated', aut,
    pg_temp.ts_v_clear(pg_temp.ts_v_id('zz-cl T2 note'), 'Gusto now has the note'),
    'ERROR 55000: Edit % is still going to Gusto (times none, breaks pending), so it is not cleared');
  perform pg_temp.ts_v('T6 nothing is left to recheck', 'authenticated', aut, pg_temp.ts_v_recheck_q(), '(none)');
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
