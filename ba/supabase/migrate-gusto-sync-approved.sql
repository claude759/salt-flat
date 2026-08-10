-- Let the Gusto sync correct already-approved payroll hours (applied live 2026-08-10).
--
-- All Gusto-imported hours land as status='approved' (Gusto is the source of truth). But
-- trg_hours_before froze hours on approved/submitted rows for any NON-admin caller — and the
-- nightly sync runs as the service role, which is_admin()=false. So a mid-period correction
-- in Gusto (Terrance: forgot to clock out 8/2 → stuck at 24h, fixed in Gusto) never flowed
-- back: the importer PATCHed the hours, the trigger reverted them to old.hours.
--
-- Fix: the "can correct approved hours" branch now also fires for source='gusto' rows, so the
-- sync (and only the sync, since BAs are blocked from editing approved rows by RLS) can push
-- Gusto's corrected value and the amount recomputes at that day's effective rate. The whole
-- trigger below is VERBATIM from the live DB with ONLY that one condition widened.

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
  elsif tg_op='UPDATE' and new.status in ('submitted','approved') and (public.is_admin() or coalesce(new.source,'') = 'gusto') then
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
