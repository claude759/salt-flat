-- ── Multiple dispensaries per expense / hours entry (cost split evenly across them) ──
-- dispensary_ids is the source of truth; dispensary_id stays in sync as the first element
-- (kept for back-compat with single-dispensary code paths).
alter table public.expenses add column if not exists dispensary_ids uuid[];
alter table public.hours    add column if not exists dispensary_ids uuid[];

update public.expenses set dispensary_ids = array[dispensary_id]
  where dispensary_id is not null and dispensary_ids is null;
update public.hours    set dispensary_ids = array[dispensary_id]
  where dispensary_id is not null and dispensary_ids is null;

create or replace function public.trg_expense_before()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_pid uuid;
begin
  -- normalize dispensary link(s): dispensary_ids is canonical; dispensary_id = first element
  if new.dispensary_ids is not null and array_length(new.dispensary_ids,1) > 0 then
    new.dispensary_id := new.dispensary_ids[1];
  elsif new.dispensary_id is not null then
    new.dispensary_ids := array[new.dispensary_id];
  else
    new.dispensary_ids := null;
  end if;
  select id into v_pid from public.pay_periods
   where new.expense_date between start_date and end_date order by start_date desc limit 1;
  if v_pid is not null then new.period_id := v_pid; end if;
  new.updated_at := now();
  return new;
end;
$function$;

create or replace function public.trg_hours_before()
 returns trigger language plpgsql security definer set search_path = public
as $function$
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
  if new.dispensary_ids is not null and array_length(new.dispensary_ids,1) > 0 then
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
$function$;

select
  (select count(*) from public.expenses where dispensary_ids is not null) as exp_backfilled,
  (select count(*) from public.hours    where dispensary_ids is not null) as hours_backfilled;
