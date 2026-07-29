-- Custom per-store expense splits (applied to the live project 2026-07-28).
-- One invoice often covers work at many stores for DIFFERENT amounts (e.g. Studio 456
-- vinyl invoice: $662 Hii Bay Ridge, $1,374.42 The Flowery BX, …). expenses.alloc holds
-- [{d:<dispensary_id>, w:<dollars>}] — the same weighted-alloc shape hours already use,
-- so the shared dispSplit() honors it everywhere (reports, visits, drill-downs) with no
-- other changes. alloc null/absent = the historical even split across dispensary_ids.

alter table public.expenses add column if not exists alloc jsonb;

-- trg_expense_before addition: a custom split describes ONE specific store set. If an
-- update changes dispensary_ids without bringing a fresh alloc in the same statement
-- (e.g. a day-grid store-chip edit), the stale amounts would keep paying removed stores —
-- dispSplit prefers alloc over dispensary_ids. Reset to the even split instead.
create or replace function public.trg_expense_before() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
declare v_pid uuid;
begin
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
  if tg_op='UPDATE' and new.alloc is not distinct from old.alloc and new.alloc is not null
     and new.dispensary_ids is distinct from old.dispensary_ids then
    new.alloc := null;
  end if;
  select id into v_pid from public.pay_periods
   where new.expense_date between start_date and end_date order by start_date desc limit 1;
  if v_pid is not null then new.period_id := v_pid; end if;
  new.updated_at := now();
  return new;
end;
$fn$;
