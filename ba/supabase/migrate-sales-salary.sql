-- ── Sales salary: salaried labor that isn't brand-ambassador work ──────────
-- Amanda is on biweekly salary doing SALES. Her pay should be recorded like the other
-- salaried people, but it must not read as brand-ambassador activity:
--   • job  = 'Sales'            → isSalesHours() picks it up, so it lands in the Sales
--                                 half of the labor split instead of the BA half;
--   • kind = 'Non-BA activity'  → one of the NONSTORE_KINDS, so it is never counted as
--                                 a store visit;
--   • parked on the '* Non-BA activity' placeholder rather than left to autolink.
--
-- That last one is the important part. generate_salary_labor inserts with no dispensary,
-- and trg_hours_before then AUTOLINKS the row to whatever stores the person drove to that
-- day (that's why the existing salaried BA's rows carry kinds like 'Store visit'). Amanda
-- has trips to CA stores in this period, so left alone her $3,461/period of sales salary
-- would be split across those stores and show up as per-store BA spend — in the app's
-- report and in the sales app's "BA Spend" column. Supplying a dispensary explicitly makes
-- trg_hours_before take its "hand-linked" branch and skip the autolink entirely.
--
-- profiles.salary_job is NULL for everyone else, so Maddy and Keelin are untouched.
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

alter table public.profiles add column if not exists salary_job text;
comment on column public.profiles.salary_job is
  'For salaried people whose work is not brand-ambassador activity (e.g. ''Sales''). '
  'NULL = ordinary BA salary, spread across the day''s stores like any BA labor. When set, '
  'generate_salary_labor stamps job=<this>, kind=''Non-BA activity'' and parks the row on '
  'the * Non-BA activity bucket so the salary never lands in per-store BA spend.';

create or replace function public.generate_salary_labor(p_ba uuid, p_period uuid)
 returns integer language plpgsql security definer set search_path to 'public' as $$
declare v_sal numeric; v_job text; v_start date; v_end date; v_days date[]; v_n int;
        v_per numeric; d date; v_bucket uuid;
begin
  if not (p_ba = auth.uid() or public.admin_sees_ba(p_ba)) then return 0; end if;
  select salary_per_period, salary_job into v_sal, v_job from public.profiles where id = p_ba;
  if v_sal is null or v_sal = 0 then return 0; end if;
  select start_date, end_date into v_start, v_end from public.pay_periods where id = p_period;
  if v_start is null then return 0; end if;
  select array_agg(g::date) into v_days
    from generate_series(v_start, v_end, interval '1 day') g
   where extract(isodow from g) between 1 and 5;          -- Mon–Fri
  v_n := coalesce(array_length(v_days,1),0);
  if v_n = 0 then return 0; end if;
  v_per := round(v_sal / v_n, 2);
  -- non-BA salary parks on the placeholder; supplying it suppresses the autolink
  if v_job is not null then
    select id into v_bucket from public.dispensaries where name = '* Non-BA activity' limit 1;
  end if;
  foreach d in array v_days loop
    insert into public.hours (ba_id, work_date, hours, source, amount, status, period_id,
                              job, kind, dispensary_ids)
    values (p_ba, d, 0, 'salary', v_per, 'draft', p_period,
            v_job,
            case when v_job is null then null else 'Non-BA activity' end,
            case when v_bucket is null then null else array[v_bucket] end)
    on conflict (ba_id, work_date, source) do update
      set amount = excluded.amount, period_id = excluded.period_id,
          job = excluded.job, kind = coalesce(excluded.kind, hours.kind)
      where hours.status not in ('submitted','approved');
  end loop;
  return v_n;
end;
$$;
grant execute on function public.generate_salary_labor(uuid, uuid) to authenticated;

-- ── Amanda ─────────────────────────────────────────────────────────────────
-- $90,000/yr biweekly = 90000/26 = $3,461.54 base, the same annual÷26 convention as the
-- other two salaried people. NOTE: her Gusto check for Aug 1–14 shows $5,219.79 gross —
-- the extra ~$1,758 is not base pay (commission/bonus), and it is deliberately NOT baked
-- in here, because salary_per_period is a fixed per-period figure and commission varies.
update public.profiles
   set salary_per_period = 3461.54,
       salary_job = 'Sales'
 where email = 'amanda@wizardtrees.com';

-- backfill the period she's being paid for (the app only self-generates for the ACTIVE one)
do $$
declare v_ba uuid; v_period uuid; v_n int;
begin
  select id into v_ba from public.profiles where email = 'amanda@wizardtrees.com';
  select id into v_period from public.pay_periods where end_date = '2026-08-14';
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_ba, 'email', 'amanda@wizardtrees.com', 'role', 'authenticated')::text, true);
  select public.generate_salary_labor(v_ba, v_period) into v_n;
  raise notice 'generated % sales-salary days', v_n;
end $$;

-- Verify — 10 weekdays, job Sales, kind Non-BA activity, all on the * Non-BA activity bucket:
--   select job, kind, count(*), sum(amount),
--          (select name from dispensaries d where d.id = h.dispensary_ids[1]) as bucket
--     from public.hours h where ba_id=(select id from profiles where email='amanda@wizardtrees.com')
--    group by 1,2,5;
