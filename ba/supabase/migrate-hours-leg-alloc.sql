-- ── Miles-weighted hours allocation (2026-07-16) ─────────────────────────────
-- A day's labor hours are split across that day's trip LEGS in proportion to
-- each leg's miles, carrying the leg's category (kind) and store/bucket:
--   hours.alloc = [{"d": <dispensary uuid>, "k": "<kind>", "w": <weight>}, …]
-- The alloc holds WEIGHTS, not absolute shares, so the hour total can change
-- (Gusto re-import) without recomputation: share_i = value × w_i / Σw.
-- Legs with no store link fall to the * General BA activity bucket; placeholder
-- stops (Office / Brand event / …) ARE legit buckets here — a 40-mile office
-- commute's labor share belongs to the office, not the day's one real store.
-- Rows an admin hand-linked (disp_auto=false) are never touched; hand-editing
-- clears alloc. All-zero-mile days fall back to equal weight per leg.

alter table public.hours add column if not exists alloc jsonb;

-- the day's legs → merged (store/bucket, kind) weights. NULL when no legs.
create or replace function public.trip_alloc_for(p_ba uuid, p_date date, p_fallback_kind text)
returns jsonb
language sql stable security definer set search_path to 'public'
as $$
  with legs as (
    select coalesce(t.dispensary_id, public.general_ba_disp())            as d,
           coalesce(nullif(t.kind,''), p_fallback_kind, 'Store visit')    as k,
           greatest(coalesce(t.miles,0),0)                                as mi,
           t.created_at                                                   as at
    from public.trips t
    where t.ba_id = p_ba and t.trip_date = p_date and t.status <> 'rejected'
  ), grp as (
    select d, k, sum(mi) as mi, count(*) as legs, min(at) as first_at
    from legs group by d, k
  ), tot as (select sum(mi) as tmi from grp)
  select case when (select count(*) from grp) = 0 then null else
    (select jsonb_agg(jsonb_build_object(
              'd', g.d, 'k', g.k,
              'w', case when (select tmi from tot) > 0 then round(g.mi,2) else g.legs end)
            order by g.first_at, g.k)
     from grp g)
  end;
$$;

-- re-link + re-weight every AUTO hours row of the day (hand-set rows untouched)
create or replace function public.autolink_hours_day(p_ba uuid, p_date date)
returns integer
language plpgsql security definer set search_path to 'public'
as $$
declare v_set uuid[]; v_alloc jsonb; v_n integer;
begin
  v_set   := public.autolink_disps_for(p_ba, p_date);
  v_alloc := public.trip_alloc_for(p_ba, p_date, null);
  perform set_config('ba.autolink', '1', true);
  update public.hours h
     set dispensary_ids = v_set,
         dispensary_id  = case when v_set is null then null else v_set[1] end,
         alloc          = v_alloc
   where h.ba_id = p_ba and h.work_date = p_date
     and (h.disp_auto or (h.dispensary_id is null and coalesce(array_length(h.dispensary_ids,1),0) = 0))
     and (h.dispensary_ids is distinct from v_set or h.alloc is distinct from v_alloc);
  get diagnostics v_n = row_count;
  perform set_config('ba.autolink', '0', true);
  return v_n;
end;
$$;

-- hours BEFORE trigger: also maintain alloc on insert / date move / hand edit
create or replace function public.trg_hours_before()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare v_pid uuid;
begin
  if new.source = 'salary' then
    new.rate := 0;
    if tg_op='UPDATE' and new.status in ('submitted','approved') and not public.is_admin() then
      new.amount := old.amount;
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

  if tg_op='INSERT' then
    if new.dispensary_id is null and coalesce(array_length(new.dispensary_ids,1),0)=0 then
      new.dispensary_ids := public.autolink_disps_for(new.ba_id, new.work_date);
      new.disp_auto := new.dispensary_ids is not null;
      new.alloc := public.trip_alloc_for(new.ba_id, new.work_date, new.kind);
    else
      new.disp_auto := false;
      new.alloc := null;
    end if;
  elsif new.dispensary_id is distinct from old.dispensary_id
     or new.dispensary_ids is distinct from old.dispensary_ids then
    new.disp_auto := coalesce(current_setting('ba.autolink', true),'') = '1'
                     and (new.dispensary_id is not null or coalesce(array_length(new.dispensary_ids,1),0) > 0);
    if not new.disp_auto then new.alloc := null; end if;   -- hand-linked → the manual link wins
  elsif new.work_date is distinct from old.work_date
        and (old.disp_auto or (new.dispensary_id is null and coalesce(array_length(new.dispensary_ids,1),0)=0)) then
    new.dispensary_ids := public.autolink_disps_for(new.ba_id, new.work_date);
    new.dispensary_id  := case when new.dispensary_ids is null then null else new.dispensary_ids[1] end;
    new.disp_auto      := new.dispensary_ids is not null;
    new.alloc          := public.trip_alloc_for(new.ba_id, new.work_date, new.kind);
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

-- trips AFTER trigger: alloc weights depend on MILES + KIND now, so those edits
-- must re-run the day's allocation too (the old guard skipped them)
create or replace function public.trg_trip_autolink()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  if tg_op = 'UPDATE'
     and new.ba_id = old.ba_id and new.trip_date = old.trip_date
     and new.dispensary_id is not distinct from old.dispensary_id
     and new.status = old.status
     and new.miles is not distinct from old.miles
     and new.kind  is not distinct from old.kind then
    return null;                                   -- nothing allocation-relevant changed
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
