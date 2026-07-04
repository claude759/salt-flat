-- ── Auto-link hours to dispensaries from that day's trips ────────────────────
-- Hours (Gusto or manual) with no dispensary get the distinct dispensaries of the
-- BA's same-day trips. Works in both directions: hours inserted after trips link
-- immediately (hours BEFORE trigger); trips logged / re-tagged / re-dated / deleted
-- later re-link that day's hours (trips AFTER trigger). hours.disp_auto records
-- provenance: auto links follow future trip edits, hand-set links are never touched.

alter table public.hours add column if not exists disp_auto boolean not null default false;

-- Distinct real dispensaries the BA drove to that day (first-visited first).
-- Rejected trips and "* …" placeholder stores don't count.
create or replace function public.trip_disps_for(p_ba uuid, p_date date)
returns uuid[] language sql stable security definer set search_path = public as $$
  select array_agg(dispensary_id order by first_at, dispensary_id) from (
    select t.dispensary_id, min(t.created_at) as first_at
    from public.trips t
    join public.dispensaries d on d.id = t.dispensary_id
    where t.ba_id = p_ba and t.trip_date = p_date
      and t.status <> 'rejected'
      and d.name not like '* %'
    group by t.dispensary_id
  ) s;
$$;

-- Re-link one (BA, day): fills empty links and refreshes auto ones; manual links stay.
-- The transaction-local 'ba.autolink' flag tells trg_hours_before this write is ours.
create or replace function public.autolink_hours_day(p_ba uuid, p_date date)
returns integer language plpgsql security definer set search_path = public as $$
declare v_set uuid[]; v_n integer;
begin
  v_set := public.trip_disps_for(p_ba, p_date);
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

-- hours BEFORE trigger: live definition + the auto-link block (kept: admin/BA freeze
-- rules, single-select-write detection, period-by-date, updated_at).
create or replace function public.trg_hours_before()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_pid uuid;
begin
  if tg_op='UPDATE' and new.status in ('submitted','approved') and public.is_admin() then
    new.rate   := old.rate;
    new.amount := round(coalesce(new.hours,0) * coalesce(old.rate, public.effective_hourly_rate(new.ba_id)), 2);
  elsif tg_op='UPDATE' and new.status in ('submitted','approved') then
    new.hours := old.hours; new.rate := old.rate; new.amount := old.amount;
  else
    new.rate   := public.effective_hourly_rate(new.ba_id);
    new.amount := round(coalesce(new.hours,0) * new.rate, 2);
  end if;

  -- auto-link from same-day trips
  if tg_op='INSERT' then
    if new.dispensary_id is null and coalesce(array_length(new.dispensary_ids,1),0)=0 then
      new.dispensary_ids := public.trip_disps_for(new.ba_id, new.work_date);
      new.disp_auto := new.dispensary_ids is not null;
    else
      new.disp_auto := false;                      -- link provided by the writer
    end if;
  elsif new.dispensary_id is distinct from old.dispensary_id
     or new.dispensary_ids is distinct from old.dispensary_ids then
    -- link changed by this write: ours (trips trigger) → auto; anyone else → manual
    new.disp_auto := coalesce(current_setting('ba.autolink', true),'') = '1'
                     and (new.dispensary_id is not null or coalesce(array_length(new.dispensary_ids,1),0) > 0);
  elsif new.work_date is distinct from old.work_date
        and (old.disp_auto or (new.dispensary_id is null and coalesce(array_length(new.dispensary_ids,1),0)=0)) then
    -- day changed: refresh an auto/empty link from the new day's trips
    new.dispensary_ids := public.trip_disps_for(new.ba_id, new.work_date);
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

-- trips AFTER trigger: any change to a day's trip set re-links that day's hours
create or replace function public.trg_trip_autolink()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE'
     and new.ba_id = old.ba_id and new.trip_date = old.trip_date
     and new.dispensary_id is not distinct from old.dispensary_id
     and new.status = old.status then
    return null;                                   -- nothing link-relevant changed
  end if;
  if tg_op in ('INSERT','UPDATE') then
    perform public.autolink_hours_day(new.ba_id, new.trip_date);
  end if;
  if tg_op = 'DELETE'
     or (tg_op = 'UPDATE' and (old.ba_id <> new.ba_id or old.trip_date <> new.trip_date)) then
    perform public.autolink_hours_day(old.ba_id, old.trip_date);
  end if;
  return null;
end;
$$;

drop trigger if exists trips_autolink_hours on public.trips;
create trigger trips_autolink_hours after insert or update or delete on public.trips
  for each row execute function public.trg_trip_autolink();

-- backfill: link every currently-unlinked hours row from its day's trips
select
  coalesce(sum(n), 0) as hours_rows_linked,
  count(*)            as days_checked
from (
  select public.autolink_hours_day(d.ba_id, d.work_date) as n
  from (select distinct ba_id, work_date from public.hours
        where dispensary_id is null and coalesce(array_length(dispensary_ids,1),0)=0) d
) s;
