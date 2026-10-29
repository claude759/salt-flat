-- Verification for supabase/ts-pay-periods.sql (Manager Timesheets: pay periods Gusto has closed take no new change).
--
-- One transaction that ROLLS BACK, in the harness of supabase/ts-edits-clear-verify.sql: throwaway companies
-- 'zz_pp_a', 'zz_pp_b' and 'zz_pp_c' (CA), synthetic people "Test Person zz-pp-...", day rows on the first day of the
-- previous pay period (inside the edit window), and a throwaway sync key. It plays each identity, records what each
-- can do, returns one pass/fail table and undoes everything. Run it with write access as the project owner after
-- ts-pay-periods.sql; the last result set is the pass/fail table. Every row must say pass = true.

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

-- one synthetic day row with one shift 8:00 AM to 4:00 PM (shift id <uuid>-s); returns its id
create function pg_temp.ts_v_day(p_company text, p_uuid text, p_d date) returns text
language sql as $f$
  insert into public.ts_days (id, company, region, employee_uuid, employee_name, department, work_date, first_in, last_out, shifts, "open", synced_at)
  values (p_company || ':' || p_uuid || ':' || to_char(p_d, 'YYYY-MM-DD'), p_company, 'CA', p_uuid, 'Test Person ' || p_uuid,
          'Distro/Trim', p_d, (p_d + time '08:00') at time zone 'America/Los_Angeles', (p_d + time '16:00') at time zone 'America/Los_Angeles',
          jsonb_build_array(jsonb_build_object('id', p_uuid || '-s', 'in', pg_temp.ts_v_iso(p_d, '08:00', 'America/Los_Angeles'),
            'out', pg_temp.ts_v_iso(p_d, '16:00', 'America/Los_Angeles'), 'span_min', 480, 'worked_min', 480, 'hours_only', false, 'breaks', '[]'::jsonb)),
          false, now() - interval '1 hour')
  returning id
$f$;
-- a manager's delete of that day's shift through ts_edit_submit, returning 'action/times/breaks'
create function pg_temp.ts_v_del(p_day text, p_shift text) returns text
language sql immutable as $f$
  select format($q$select (r->>'action') || '/' || (r->>'times_status') || '/' || (r->>'breaks_status') from (select public.ts_edit_submit(%L, %L, 'delete', null, 'zz-pp verify') r) s$q$, p_day, p_shift)
$f$;
-- the worker's write as SQL text, returning 'periods/closed'
create function pg_temp.ts_v_sync(p_company text, p_periods jsonb) returns text
language sql immutable as $f$
  select format($q$select (r->>'periods') || '/' || (r->>'closed') from (select public.ts_pay_periods_sync(%L, %L::jsonb) r) s$q$, p_company, p_periods::text)
$f$;
-- one period as the worker sends it
create function pg_temp.ts_v_p(p_start date, p_sched text, p_closed boolean, p_why text default null, p_sent text default null) returns jsonb
language sql immutable as $f$
  select jsonb_build_object('start', p_start, 'end', p_start + 13, 'schedule', p_sched, 'closed', p_closed, 'why', p_why, 'sent_at', p_sent, 'processed_at', null)
$f$;

-- ------------------------------------------------------------------ setup (as owner, rolled back)
insert into public.ts_access (email, is_admin, active, note) values ('gianni@wizardtrees.com', true, true, 'owner')
on conflict (email) do update set is_admin = true, active = true;
insert into public.ts_companies (key, name, region) values ('zz_pp_a', 'Verify Periods A', 'CA'), ('zz_pp_b', 'Verify Periods B', 'CA'),
  ('zz_pp_c', 'Verify Periods C', 'CA')
on conflict do nothing;
insert into public.ts_sync_keys (key_hash, label) values (encode(sha256(convert_to('zz-pp-sync-key', 'utf8')), 'hex'), 'verify periods (rolled back)');
select set_config('request.headers', '', true);

do $v$
declare
  adm  constant text := 'gianni@wizardtrees.com';
  aut  constant text := 'automation@wizardtrees.com';
  -- the first day of the previous pay period (periods start on the Saturdays 2026-09-26 + 14k)
  w    constant date := date '2026-09-26' + 14 * floor((((now() at time zone 'America/Los_Angeles')::date) - date '2026-09-26') / 14.0)::int - 14;
  key_on constant text := '{"x-ts-sync-key": "zz-pp-sync-key"}';
  da text; db text; dc text; da2 text; dn text;
begin
  da := pg_temp.ts_v_day('zz_pp_a', 'zz-pp-1', w);
  da2 := pg_temp.ts_v_day('zz_pp_a', 'zz-pp-2', w + 14);
  db := pg_temp.ts_v_day('zz_pp_b', 'zz-pp-3', w);
  dc := pg_temp.ts_v_day('zz_pp_c', 'zz-pp-4', w);
  dn := pg_temp.ts_v_day('zz_pp_b', 'zz-pp-5', w);   -- the notes (E10): B's open period, no change waiting

  -- ---------------------------------------------------------------- A. structure and grants
  perform pg_temp.ts_v('A1 ts_companies has pay_periods (jsonb) and pay_periods_at (timestamptz), readable through its SELECT grant', null, null,
    $q$select string_agg(a.attname || '=' || format_type(a.atttypid, a.atttypmod) || '/' || has_column_privilege('authenticated', 'public.ts_companies', a.attname, 'SELECT'), ',' order by a.attname)
         from pg_attribute a where a.attrelid = 'public.ts_companies'::regclass and a.attname in ('pay_periods', 'pay_periods_at') and not a.attisdropped$q$,
    'pay_periods=jsonb/true,pay_periods_at=timestamp with time zone/true');
  perform pg_temp.ts_v('A2 only ts_pay_periods_sync is executable by authenticated; none by PUBLIC or anon', null, null,
    $q$select string_agg(p.proname || '=' || has_function_privilege('authenticated', p.oid, 'EXECUTE') || '/' || has_function_privilege('public', p.oid, 'EXECUTE')
                         || '/' || has_function_privilege('anon', p.oid, 'EXECUTE'), ',' order by p.proname)
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
          and p.proname in ('ts_pay_periods_sync', 'ts_edit_period_closed', 'ts_edits_payroll_guard')$q$,
    pg_temp.ts_v_lit('ts_edit_period_closed=false/false/false,ts_edits_payroll_guard=false/false/false,ts_pay_periods_sync=true/false/false'));
  perform pg_temp.ts_v('A3 all three are security definer with search_path=public', null, null,
    $q$select count(*) filter (where p.prosecdef and coalesce(array_to_string(p.proconfig, ',') like '%search_path=public%', false)) || '/' || count(*)
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
          and p.proname in ('ts_pay_periods_sync', 'ts_edit_period_closed', 'ts_edits_payroll_guard')$q$, '3/3');
  perform pg_temp.ts_v('A4 the guard is a BEFORE INSERT row trigger on ts_edits, enabled', null, null,
    $q$select t.tgenabled::text || '/' || (t.tgtype & 2 = 2) || '/' || (t.tgtype & 4 = 4) || '/' || (t.tgtype & 16 = 16) from pg_trigger t
        where t.tgrelid = 'public.ts_edits'::regclass and t.tgname = 'ts_edits_payroll_guard'$q$, 'O/true/true/false');

  -- ---------------------------------------------------------------- G. who may write the periods
  perform pg_temp.ts_v('G1 an admin (Google) cannot write them', 'authenticated', adm,
    pg_temp.ts_v_sync('zz_pp_a', jsonb_build_array(pg_temp.ts_v_p(w, 's1', true, 'processed'))), 'ERROR 42501: ts_pay_periods_sync is for the timesheet sync account only');
  perform pg_temp.ts_v('G2 anon cannot write them', 'anon', null,
    pg_temp.ts_v_sync('zz_pp_a', jsonb_build_array(pg_temp.ts_v_p(w, 's1', true, 'processed'))), 'ERROR 42501%');
  perform pg_temp.ts_v('G3 automation@ without the sync key cannot write them', 'authenticated', aut,
    pg_temp.ts_v_sync('zz_pp_a', jsonb_build_array(pg_temp.ts_v_p(w, 's1', true, 'processed'))), 'ERROR 42501: ts_pay_periods_sync needs the sync key');
  perform pg_temp.ts_v('G4 nothing was written', null, null, $q$select coalesce(pay_periods::text, '(none)') from public.ts_companies where key = 'zz_pp_a'$q$, '(none)');
  perform set_config('request.headers', key_on, true);
  perform pg_temp.ts_v('G5 an admin (Google) WITH the key still cannot write them', 'authenticated', adm,
    pg_temp.ts_v_sync('zz_pp_a', jsonb_build_array(pg_temp.ts_v_p(w, 's1', true, 'processed'))), 'ERROR 42501: ts_pay_periods_sync is for the timesheet sync account only');

  -- ---------------------------------------------------------------- S. what the worker may write (automation@ + key)
  perform pg_temp.ts_v('S1 an unknown company is refused', 'authenticated', aut,
    pg_temp.ts_v_sync('zz_pp_nope', '[]'), 'ERROR P0001: Unknown company: zz!_pp!_nope');
  perform pg_temp.ts_v('S2 not a list is refused', 'authenticated', aut, pg_temp.ts_v_sync('zz_pp_a', '{}'), 'ERROR P0001: p!_periods must be a list');
  perform pg_temp.ts_v('S3 a period that is not 14 days is refused', 'authenticated', aut,
    pg_temp.ts_v_sync('zz_pp_a', jsonb_build_array(jsonb_build_object('start', w, 'end', w + 14, 'schedule', 's1', 'closed', true))), 'ERROR P0001: period 1: must be 14 days, start to end');
  perform pg_temp.ts_v('S4 a bad date is refused', 'authenticated', aut,
    pg_temp.ts_v_sync('zz_pp_a', jsonb_build_array(jsonb_build_object('start', 'soon', 'end', w + 13, 'schedule', 's1', 'closed', true))), 'ERROR P0001: period 1: start and end must be dates%');
  perform pg_temp.ts_v('S5 closed must be a boolean', 'authenticated', aut,
    pg_temp.ts_v_sync('zz_pp_a', jsonb_build_array(jsonb_build_object('start', w, 'end', w + 13, 'schedule', 's1', 'closed', 'yes'))), 'ERROR P0001: period 1: closed must be true or false');
  perform pg_temp.ts_v('S6 a schedule id with odd characters is refused', 'authenticated', aut,
    pg_temp.ts_v_sync('zz_pp_a', jsonb_build_array(jsonb_build_object('start', w, 'end', w + 13, 'schedule', 's1''; drop', 'closed', true))), 'ERROR P0001: period 1: bad schedule id');
  perform pg_temp.ts_v('S7 more than 20 periods are refused', 'authenticated', aut,
    pg_temp.ts_v_sync('zz_pp_a', (select jsonb_agg(pg_temp.ts_v_p(w - 14 * g, 's1', false)) from generate_series(0, 20) g)), 'ERROR P0001: p!_periods can hold at most 20 periods');
  perform pg_temp.ts_v('S8 A: the previous period closed (processed), the current one open and sent', 'authenticated', aut,
    pg_temp.ts_v_sync('zz_pp_a', jsonb_build_array(pg_temp.ts_v_p(w + 14, 's1', false, null, '2026-10-24T13:20:14-07:00'), pg_temp.ts_v_p(w, 's1', true, 'processed') || '{"extra": "dropped"}')), '2/1');
  perform pg_temp.ts_v('S9 stored in date order, extra keys dropped, times kept', null, null,
    $q$select (pay_periods->0->>'start')::date - (pay_periods->1->>'start')::date || '/' || (pay_periods->0 ? 'extra') || '/' || ((pay_periods->1->>'sent_at')::timestamptz = timestamptz '2026-10-24T13:20:14-07:00')
              || '/' || (pay_periods_at > now() - interval '1 minute')
         from public.ts_companies where key = 'zz_pp_a'$q$, '-14/false/true/true');
  perform pg_temp.ts_v('S10 B: the previous period open', 'authenticated', aut,
    pg_temp.ts_v_sync('zz_pp_b', jsonb_build_array(pg_temp.ts_v_p(w, 's2', false))), '1/0');
  perform pg_temp.ts_v('S11 C: two schedules on the same dates, one closed, one still open', 'authenticated', aut,
    pg_temp.ts_v_sync('zz_pp_c', jsonb_build_array(pg_temp.ts_v_p(w, 's3', true, 'PAYROLL_PROCESSED'), pg_temp.ts_v_p(w, 's4', false))), '2/1');
  perform set_config('request.headers', '', true);

  -- ---------------------------------------------------------------- C. which days are closed
  perform pg_temp.ts_v('C1 A, the previous period: closed', null, null,
    format($q$select (public.ts_edit_period_closed('zz_pp_a', %L)->>'why')$q$, w + 3), 'processed');
  perform pg_temp.ts_v('C2 A, the current period: open', null, null,
    format($q$select coalesce(public.ts_edit_period_closed('zz_pp_a', %L)::text, 'open')$q$, w + 14), 'open');
  perform pg_temp.ts_v('C3 B: open', null, null,
    format($q$select coalesce(public.ts_edit_period_closed('zz_pp_b', %L)::text, 'open')$q$, w), 'open');
  perform pg_temp.ts_v('C4 C: one schedule still open keeps the day open', null, null,
    format($q$select coalesce(public.ts_edit_period_closed('zz_pp_c', %L)::text, 'open')$q$, w), 'open');
  perform pg_temp.ts_v('C5 a company never read: open', null, null,
    format($q$select coalesce(public.ts_edit_period_closed('filifera_never', %L)::text, 'open')$q$, w), 'open');

  -- ---------------------------------------------------------------- E. the guard on new changes (an admin, through ts_edit_submit)
  perform pg_temp.ts_v('E1 a change of a day in a processed period is refused, saying what to do', 'authenticated', adm,
    pg_temp.ts_v_del(da, 'zz-pp-1-s'), 'ERROR P0001: Payroll for ' || to_char(w, 'Dy Mon FMDD') || ' to ' || to_char(w + 13, 'Dy Mon FMDD')
      || ' has already been processed in Gusto, so this day can no longer be changed here. Fix it in Gusto, or have the hours added to the next payroll');
  perform pg_temp.ts_v('E2 ... and nothing was stored', null, null, format($q$select count(*)::text from public.ts_edits where day_id = %L$q$, da), '0');
  perform pg_temp.ts_v('E3 a change in the open current period goes through', 'authenticated', adm, pg_temp.ts_v_del(da2, 'zz-pp-2-s'), 'delete/none/pending');
  perform pg_temp.ts_v('E4 a change where the period is open goes through', 'authenticated', adm, pg_temp.ts_v_del(db, 'zz-pp-3-s'), 'delete/none/pending');
  perform pg_temp.ts_v('E5 a change where one schedule is still open goes through', 'authenticated', adm, pg_temp.ts_v_del(dc, 'zz-pp-4-s'), 'delete/none/pending');
  perform pg_temp.ts_v('E6 a period locked for another reason says locked', null, null,
    $q$update public.ts_companies set pay_periods = jsonb_set(pay_periods, '{1,closed}', 'true') where key = 'zz_pp_c' returning 'ok'$q$, 'ok');
  perform pg_temp.ts_v('E7 ... then the day is closed and a further change is refused', 'authenticated', adm,
    pg_temp.ts_v_del(dc, 'zz-pp-4-s'), 'ERROR P0001: Gusto has locked the ' || to_char(w, 'Dy Mon FMDD') || ' to ' || to_char(w + 13, 'Dy Mon FMDD') || ' pay period%');
  perform pg_temp.ts_v('E8 cancelling a waiting change of a closed day still works (an update, not a new change)', 'authenticated', adm,
    format($q$select (r->>'breaks_status') from (select public.ts_edit_cancel((select id from public.ts_edits where day_id = %L)) r) s$q$, dc), 'cancelled');
  -- a note for Gusto (action 'note', supabase/ts-edit-notes.sql) is a new change like any other
  perform pg_temp.ts_v('E9 a note on a day in a processed period is refused the same way', 'authenticated', adm,
    format($q$select (r->>'action') from (select public.ts_edit_submit(%L, 'zz-pp-1-s', 'note', null, 'zz-pp note') r) s$q$, da),
    'ERROR P0001: Payroll for ' || to_char(w, 'Dy Mon FMDD') || ' to ' || to_char(w + 13, 'Dy Mon FMDD') || ' has already been processed in Gusto%');
  perform pg_temp.ts_v('E10 a note where the period is open goes through', 'authenticated', adm,
    format($q$select (r->>'action') || '/' || (r->>'times_status') || '/' || (r->>'breaks_status')
                from (select public.ts_edit_submit(%L, 'zz-pp-5-s', 'note', null, 'zz-pp note') r) s$q$, dn), 'note/none/pending');
  perform pg_temp.ts_v('E10b a note on the shift E4 is waiting to delete is refused (the delete goes first: the note would have nowhere to go)', 'authenticated', adm,
    format($q$select (r->>'action') from (select public.ts_edit_submit(%L, 'zz-pp-3-s', 'note', null, 'zz-pp note') r) s$q$, db),
    'ERROR P0001: That shift is waiting to be deleted, so a note has nowhere to go. Cancel the delete first');
  perform pg_temp.ts_v('E11 the refused notes were not stored: nothing on A''s closed day, only E4''s delete on B''s', null, null,
    format($q$select (select count(*) from public.ts_edits where day_id = %L) || '/'
                  || (select string_agg(e.action || ':' || e.breaks_status, ',' order by e.action) from public.ts_edits e where e.day_id = %L)$q$, da, db),
    '0/delete:pending');
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
