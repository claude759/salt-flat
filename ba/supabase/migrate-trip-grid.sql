-- Trip free-text start/destination + GPS + round-trip, and a 'manual' method,
-- to back the spreadsheet-style Quick-entry grid and the auto-distance flow.
-- Idempotent — safe to run once.

alter table public.trips add column if not exists start_label text;
alter table public.trips add column if not exists dest_label  text;
alter table public.trips add column if not exists start_lat   double precision;
alter table public.trips add column if not exists start_lng   double precision;
alter table public.trips add column if not exists roundtrip   boolean not null default true;

alter table public.trips drop constraint if exists trips_method_check;
alter table public.trips add  constraint trips_method_check check (method in ('distance','odometer','manual'));

-- Replace the trip trigger: rate is server-owned + amount derived; miles come from
-- the client (calc-distance / odometer / typed); start labels+GPS stored for audit;
-- everything freezes once the trip is submitted/approved.
create or replace function public.trg_trip_before()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.status in ('submitted','approved') then
    new.miles := old.miles; new.miles_source := old.miles_source;
    new.rate := old.rate;   new.amount := old.amount;
    new.start_label := old.start_label; new.dest_label := old.dest_label;
    new.start_lat := old.start_lat;     new.start_lng := old.start_lng;
    new.roundtrip := old.roundtrip;
  else
    new.rate   := public.effective_rate(new.ba_id);
    new.amount := round(coalesce(new.miles, 0) * new.rate, 2);
  end if;
  if new.period_id is null then
    select id into new.period_id
      from public.pay_periods
     where new.trip_date between start_date and end_date
     order by start_date desc
     limit 1;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
