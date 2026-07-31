-- Effective-dated hourly rates (applied to the live project 2026-07-30).
--
-- WHY: hours.rate is stamped at INSERT from the BA's CURRENT profile rate, and the nightly
-- Gusto sync imports hours for days that ALREADY happened. So editing profiles.hourly_rate
-- to schedule a raise silently re-prices the PAST: set Drew to $22 today and tonight's
-- import of this week's hours pays July days at August's rate. The rate must be chosen by
-- the day the work happened, not the day the row lands.

create table if not exists public.ba_rates (
  id             uuid primary key default gen_random_uuid(),
  ba_id          uuid not null references public.profiles(id) on delete cascade,
  effective_from date not null,                -- first WORK DATE this rate applies to
  hourly_rate    numeric(10,2) not null check (hourly_rate >= 0),
  note           text,
  created_at     timestamptz not null default now(),
  unique (ba_id, effective_from)
);
create index if not exists ba_rates_lookup on public.ba_rates (ba_id, effective_from desc);

alter table public.ba_rates enable row level security;
drop policy if exists ba_rates_select on public.ba_rates;
create policy ba_rates_select on public.ba_rates for select
  using (ba_id = auth.uid() or public.is_admin());     -- a BA may see their own rate history
drop policy if exists ba_rates_write on public.ba_rates;
create policy ba_rates_write on public.ba_rates for all
  using (public.is_admin()) with check (public.is_admin());

-- Date-aware overload. The 1-arg version stays (callers that legitimately mean "right now",
-- e.g. the admin UI's rate display) and now delegates, so the two can never disagree.
create or replace function public.effective_hourly_rate(p uuid, on_date date)
returns numeric language sql stable security definer set search_path to 'public' as $fn$
  select coalesce(
    (select r.hourly_rate from public.ba_rates r
      where r.ba_id = p and r.effective_from <= on_date
      order by r.effective_from desc limit 1),
    (select hourly_rate from public.profiles where id = p),
    (select hourly_rate from public.app_settings where id = 1),
    0
  );
$fn$;

create or replace function public.effective_hourly_rate(p uuid)
returns numeric language sql stable security definer set search_path to 'public' as $fn$
  select public.effective_hourly_rate(p, current_date);
$fn$;

-- trg_hours_before, VERBATIM from the live database with exactly one change: both rate
-- lookups now pass new.work_date. Everything else (autolink branches, the dispensary
-- reconciliation, the period assignment) is byte-identical to what was running.
CREATE OR REPLACE FUNCTION public.trg_hours_before()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
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
    new.amount := round(coalesce(new.hours,0) * coalesce(old.rate, public.effective_hourly_rate(new.ba_id, new.work_date)), 2);
  elsif tg_op='UPDATE' and new.status in ('submitted','approved') then
    new.hours := old.hours; new.rate := old.rate; new.amount := old.amount;
  else
    new.rate   := public.effective_hourly_rate(new.ba_id, new.work_date);
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
$fn$
;
