-- Auto-link hours → mileage, with a "General BA activity" fallback, plus salaried
-- daily labor (Maddy). Two behaviours the user asked for:
--   1. A day's hours attach to that day's real-store trips (already did this); when a
--      day has NO mileage, the hours fall back to the "* General BA activity" bucket
--      instead of being left unlinked.
--   2. Salaried BAs (profiles.salary_per_period set) get their pay split evenly across
--      the pay period's workweek days (Mon–Fri); each day's slice is auto-linked to
--      that day's mileage (or General BA activity) just like hourly hours.

-- 1. the placeholder dispensary that represents non-store "General BA activity"
create or replace function public.general_ba_disp() returns uuid
 language sql stable security definer set search_path=public as $$
  select id from public.dispensaries where name='* General BA activity' limit 1;
$$;

-- 2. the day's link target: the real stores visited, else the General BA activity bucket
create or replace function public.autolink_disps_for(p_ba uuid, p_date date) returns uuid[]
 language sql stable security definer set search_path=public as $$
  select coalesce(public.trip_disps_for(p_ba, p_date), array[public.general_ba_disp()]);
$$;

-- 3. re-point the day-level relink at the new fallback-aware target
create or replace function public.autolink_hours_day(p_ba uuid, p_date date)
 returns integer language plpgsql security definer set search_path to 'public' as $$
declare v_set uuid[]; v_n integer;
begin
  v_set := public.autolink_disps_for(p_ba, p_date);
  perform set_config('ba.autolink', '1', true);
  update public.hours h
     set dispensary_ids = v_set,
         dispensary_id  = case when v_set is null then null else v_set[1] end
   where h.ba_id = p_ba and h.work_date = p_date
     and (h.disp_auto or (h.dispensary_id is null and coalesce(array_length(h.dispensary_ids,1),0) = 0))
     and h.dispensary_ids is distinct from v_set;
  get diagnostics v_n = row_count;
  perform set_config('ba.autolink', '0', true);
  return v_n;
end;
$$;

-- 4. hours row trigger: salary rows keep their directly-set amount; auto-link uses the
--    General-BA-activity-aware target on insert and on a day change.
create or replace function public.trg_hours_before()
 returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_pid uuid;
begin
  if new.source = 'salary' then
    -- salaried daily labor: amount is set directly (salary ÷ workweek-days), not hours×rate
    new.rate := 0;
    if tg_op='UPDATE' and new.status in ('submitted','approved') and not public.is_admin() then
      new.amount := old.amount;                 -- locked once submitted (non-admin)
    end if;
    if new.amount is null then new.amount := 0; end if;
  elsif tg_op='UPDATE' and new.status in ('submitted','approved') and public.is_admin() then
    new.rate   := old.rate;
    new.amount := round(coalesce(new.hours,0) * coalesce(old.rate, public.effective_hourly_rate(new.ba_id)), 2);
  elsif tg_op='UPDATE' and new.status in ('submitted','approved') then
    new.hours := old.hours; new.rate := old.rate; new.amount := old.amount;
  else
    new.rate   := public.effective_hourly_rate(new.ba_id);
    new.amount := round(coalesce(new.hours,0) * new.rate, 2);
  end if;

  -- auto-link from same-day trips (real stores, else the General BA activity bucket)
  if tg_op='INSERT' then
    if new.dispensary_id is null and coalesce(array_length(new.dispensary_ids,1),0)=0 then
      new.dispensary_ids := public.autolink_disps_for(new.ba_id, new.work_date);
      new.disp_auto := new.dispensary_ids is not null;
    else
      new.disp_auto := false;                      -- link provided by the writer
    end if;
  elsif new.dispensary_id is distinct from old.dispensary_id
     or new.dispensary_ids is distinct from old.dispensary_ids then
    new.disp_auto := coalesce(current_setting('ba.autolink', true),'') = '1'
                     and (new.dispensary_id is not null or coalesce(array_length(new.dispensary_ids,1),0) > 0);
  elsif new.work_date is distinct from old.work_date
        and (old.disp_auto or (new.dispensary_id is null and coalesce(array_length(new.dispensary_ids,1),0)=0)) then
    new.dispensary_ids := public.autolink_disps_for(new.ba_id, new.work_date);
    new.dispensary_id  := case when new.dispensary_ids is null then null else new.dispensary_ids[1] end;
    new.disp_auto      := new.dispensary_ids is not null;
  end if;

  if tg_op='UPDATE' and new.dispensary_id is distinct from old.dispensary_id
     and new.dispensary_ids is not distinct from old.dispensary_ids then
    new.dispensary_ids := case when new.dispensary_id is null then null else array[new.dispensary_id] end;
  elsif coalesce(array_length(new.dispensary_ids,1),0) > 0 then
    new.dispensary_id := new.dispensary_ids[1];
  elsif new.dispensary_id is not null then
    new.dispensary_ids := array[new.dispensary_id];
  else
    new.dispensary_ids := null;
  end if;

  select id into v_pid from public.pay_periods
   where new.work_date between start_date and end_date order by start_date desc limit 1;
  if v_pid is not null then new.period_id := v_pid; end if;
  new.updated_at := now();
  return new;
end;
$$;

-- 5. salaried BAs: a per-period salary the app can set on the profile
alter table public.profiles add column if not exists salary_per_period numeric;

-- 6. allow a third hours source: 'salary' (generated daily slices)
do $$ declare cn text;
begin
  select conname into cn from pg_constraint
    where conrelid='public.hours'::regclass and pg_get_constraintdef(oid) ilike '%source%';
  if cn is not null then execute format('alter table public.hours drop constraint %I', cn); end if;
end $$;
alter table public.hours add constraint hours_source_check
  check (source = any (array['manual','gusto','salary']));

-- 7. generate/refresh a salaried BA's daily labor for one pay period. Idempotent:
--    re-running just resets the (still-draft) day amounts to salary ÷ workweek-days.
create or replace function public.generate_salary_labor(p_ba uuid, p_period uuid)
 returns integer language plpgsql security definer set search_path to 'public' as $$
declare v_sal numeric; v_start date; v_end date; v_days date[]; v_n int; v_per numeric; d date;
begin
  if not (p_ba = auth.uid() or public.admin_sees_ba(p_ba)) then return 0; end if;
  select salary_per_period into v_sal from public.profiles where id = p_ba;
  if v_sal is null or v_sal = 0 then return 0; end if;
  select start_date, end_date into v_start, v_end from public.pay_periods where id = p_period;
  if v_start is null then return 0; end if;
  select array_agg(g::date) into v_days
    from generate_series(v_start, v_end, interval '1 day') g
   where extract(isodow from g) between 1 and 5;          -- Mon–Fri
  v_n := coalesce(array_length(v_days,1),0);
  if v_n = 0 then return 0; end if;
  v_per := round(v_sal / v_n, 2);
  foreach d in array v_days loop
    insert into public.hours (ba_id, work_date, hours, source, amount, status, period_id)
    values (p_ba, d, 0, 'salary', v_per, 'draft', p_period)
    on conflict (ba_id, work_date, source) do update
      set amount = excluded.amount, period_id = excluded.period_id
      where hours.status not in ('submitted','approved');
  end loop;
  return v_n;
end;
$$;
grant execute on function public.generate_salary_labor(uuid, uuid) to authenticated;
grant execute on function public.autolink_disps_for(uuid, date) to authenticated;
grant execute on function public.general_ba_disp() to authenticated;
