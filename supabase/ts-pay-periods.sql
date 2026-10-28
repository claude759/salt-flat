-- Manager Timesheets (timesheets.html): each company's pay periods as Gusto has them, so the board stops offering a
-- change Gusto can no longer take. Gianni 2026-10-27, on a daily list of six "needs a look" that were all changes to
-- the Oct 10 to 23 period made after Gusto had sent its hours to payroll and then processed it: "come up with a way
-- to reduce the frequency these come up".
--
-- Needs supabase/ts-ca-timesheets.sql and supabase/ts-edits.sql (apply those first). Safe to re-run: add column if not
-- exists, create or replace, drop trigger if exists. Apply on the CA project (dhiqhgtmelxwelyoowle), then run
-- supabase/ts-pay-periods-verify.sql (it rolls back) and check every row says pass.
--
-- What it adds
--   ts_companies.pay_periods     the company's hourly pay periods around the editable window as the edit worker
--                                (~/gusto-sync/ts-edit-worker.mjs) last read them in Gusto: a jsonb list of
--                                {start, end, schedule, closed, why, sent_at, processed_at}. closed = Gusto processed
--                                that payroll or locked the period for edits; why = 'processed' or Gusto's lock reason;
--                                sent_at = when Gusto sent the period's hours to payroll (null: not yet, or not read).
--                                Only periods of the board's 14-day grid (Saturday to Friday), so another schedule of
--                                the company (a salaried one) never closes a day. null until the worker first reads it.
--   ts_companies.pay_periods_at  when the worker last wrote them
--   ts_pay_periods_sync(p_company, p_periods)
--                                the worker's write (ts_edit_worker_gate: automation@ AND the sync key in the
--                                x-ts-sync-key header, like ts_edit_mark). Checks every field and stores a clean copy.
--   ts_edit_period_closed(p_company, p_date)
--                                the period holding that day when Gusto has closed it (every listed period holding the
--                                day is closed), else null. Internal: no grant.
--   trigger ts_edits_payroll_guard (before insert on ts_edits)
--                                refuses a new change of a day whose pay period Gusto has closed, and says what to do
--                                instead. Gusto would refuse it at the next run and it would only come back as Needs a
--                                look. Cancel, clear and the worker's marks are updates: never touched.
--   ts_companies is already readable by every active sign-in (its freshness), so the page reads the periods with it.
--
-- Grants: each function starts with an explicit revoke from public, anon and authenticated (Supabase's default
-- privileges grant EXECUTE on every new function); only ts_pay_periods_sync is then granted to authenticated (its
-- body checks who is calling). security definer, search_path = public.

do $$ begin
  if to_regclass('public.ts_companies') is null or to_regclass('public.ts_edits') is null
     or to_regprocedure('public.ts_edit_worker_gate(text)') is null then
    raise exception 'Apply supabase/ts-ca-timesheets.sql and supabase/ts-edits.sql first';
  end if;
end $$;

alter table public.ts_companies add column if not exists pay_periods jsonb;
alter table public.ts_companies add column if not exists pay_periods_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint c where c.conrelid = 'public.ts_companies'::regclass and c.conname = 'ts_companies_pay_periods_check') then
    alter table public.ts_companies add constraint ts_companies_pay_periods_check
      check (pay_periods is null or jsonb_typeof(pay_periods) = 'array');
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- ts_pay_periods_sync: the worker's write of one company's periods
-- ---------------------------------------------------------------------------------------------

-- p_periods: [{start, end, schedule, closed, why, sent_at, processed_at}], at most 20, each a 14-day period. The
-- stored list is rebuilt from the checked fields only, ordered by start. Returns {ok, company, periods, closed}.
create or replace function public.ts_pay_periods_sync(p_company text, p_periods jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_list  jsonb := coalesce(p_periods, 'null'::jsonb);
  v_out   jsonb := '[]'::jsonb;
  x       jsonb;
  v_start date;
  v_end   date;
  v_sched text;
  v_why   text;
  v_sent  timestamptz;
  v_proc  timestamptz;
  v_n     int := 0;
  v_shut  int := 0;
begin
  perform public.ts_edit_worker_gate('ts_pay_periods_sync');
  if not exists (select 1 from public.ts_companies c where c.key = p_company) then
    raise exception 'Unknown company: %', p_company;
  end if;
  if jsonb_typeof(v_list) <> 'array' then raise exception 'p_periods must be a list'; end if;
  if jsonb_array_length(v_list) > 20 then raise exception 'p_periods can hold at most 20 periods'; end if;
  for x in select e from jsonb_array_elements(v_list) e order by e->>'start', e->>'schedule' loop
    v_n := v_n + 1;
    if jsonb_typeof(x) <> 'object' then raise exception 'period %: must be an object', v_n; end if;
    begin
      v_start := (x->>'start')::date;
      v_end := (x->>'end')::date;
      v_sent := nullif(x->>'sent_at', '')::timestamptz;
      v_proc := nullif(x->>'processed_at', '')::timestamptz;
    exception when others then
      raise exception 'period %: start and end must be dates, sent_at and processed_at times or null', v_n;
    end;
    if v_start is null or v_end is null or v_end - v_start <> 13 then
      raise exception 'period %: must be 14 days, start to end', v_n;
    end if;
    v_sched := x->>'schedule';
    if v_sched is null or v_sched !~ '^[A-Za-z0-9_-]{1,40}$' then raise exception 'period %: bad schedule id', v_n; end if;
    if jsonb_typeof(x->'closed') is distinct from 'boolean' then raise exception 'period %: closed must be true or false', v_n; end if;
    v_why := nullif(btrim(coalesce(x->>'why', '')), '');
    if v_why is not null and v_why !~ '^[A-Za-z0-9_ -]{1,40}$' then raise exception 'period %: bad why', v_n; end if;
    if (x->>'closed')::boolean then v_shut := v_shut + 1; end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('start', v_start, 'end', v_end, 'schedule', v_sched,
      'closed', (x->>'closed')::boolean, 'why', v_why, 'sent_at', v_sent, 'processed_at', v_proc));
  end loop;
  update public.ts_companies set pay_periods = v_out, pay_periods_at = now() where key = p_company;
  return jsonb_build_object('ok', true, 'company', p_company, 'periods', v_n, 'closed', v_shut);
end $$;
revoke all on function public.ts_pay_periods_sync(text, jsonb) from public, anon, authenticated;
grant execute on function public.ts_pay_periods_sync(text, jsonb) to authenticated;   -- the body checks who is calling

-- ---------------------------------------------------------------------------------------------
-- ts_edit_period_closed: the closed pay period holding a day, or null
-- ---------------------------------------------------------------------------------------------

-- Closed only when every listed period holding the day is closed (two hourly schedules on the same dates: one
-- still open keeps the day open). A company the worker has not read yet, or a day no period lists: null (open).
create or replace function public.ts_edit_period_closed(p_company text, p_date date)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when count(*) > 0 and bool_and(coalesce((p->>'closed')::boolean, false)) then (array_agg(p order by p->>'schedule'))[1] end
    from public.ts_companies c
   cross join lateral jsonb_array_elements(case jsonb_typeof(c.pay_periods) when 'array' then c.pay_periods else '[]'::jsonb end) p
   where c.key = p_company and (p->>'start')::date <= p_date and p_date <= (p->>'end')::date
$$;
revoke all on function public.ts_edit_period_closed(text, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- The guard: no new change of a day in a pay period Gusto has closed
-- ---------------------------------------------------------------------------------------------

create or replace function public.ts_edits_payroll_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v jsonb := public.ts_edit_period_closed(new.company, new.work_date);
  v_range text;
begin
  if v is null then return new; end if;
  v_range := to_char((v->>'start')::date, 'Dy Mon FMDD') || ' to ' || to_char((v->>'end')::date, 'Dy Mon FMDD');
  if coalesce(v->>'why', 'processed') = 'processed' then
    raise exception 'Payroll for % has already been processed in Gusto, so this day can no longer be changed here. Fix it in Gusto, or have the hours added to the next payroll', v_range;
  end if;
  raise exception 'Gusto has locked the % pay period, so this day can no longer be changed here. Fix it in Gusto, or have the hours added to the next payroll', v_range;
end $$;
revoke all on function public.ts_edits_payroll_guard() from public, anon, authenticated;

drop trigger if exists ts_edits_payroll_guard on public.ts_edits;
create trigger ts_edits_payroll_guard before insert on public.ts_edits
  for each row execute function public.ts_edits_payroll_guard();

notify pgrst, 'reload schema';
