-- ── non_ba_from: someone stops being a BA on a date ────────────────────────
-- Keelin's Florida work through 7/31 WAS brand-ambassador work and belongs in the BA
-- reports. From 8/1, when she moved to CA, it isn't. The existing `non_ba` flag is
-- all-or-nothing and its trigger fires on UPDATE too, so setting it on her would
-- rewrite her FL history the first time anything touched an old row.
--
-- non_ba_from is the dated form: rows ON OR AFTER that date are non-BA, everything
-- before is left exactly as it was recorded.
--
-- Also fixes a real bug in the original trigger. It set dispensary_id/ids to NULL,
-- but BEFORE triggers fire alphabetically — aa_force_non_ba runs, then hours_before
-- sees a NULL link and AUTOLINKS the row right back onto that day's stores (or the
-- '* General BA activity' bucket). Parking the row on '* Non-BA activity' instead
-- makes hours_before take its hand-linked branch and skip the autolink entirely,
-- which is the same technique the sales-salary path already uses.
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

alter table public.profiles add column if not exists non_ba_from date;
comment on column public.profiles.non_ba_from is
  'Date this person stopped doing brand-ambassador work. Rows dated on/after it are '
  'filed as Non-BA activity and never attributed to a store; earlier rows are untouched. '
  'NULL = not applicable. See also non_ba (true = never a BA, any date).';

-- the bucket, resolved once (mirrors general_ba_disp)
create or replace function public.non_ba_disp() returns uuid
 language sql stable security definer set search_path=public as $$
  select id from public.dispensaries
   where name = '* Non-BA activity' and coalesce(active,true) order by created_at limit 1;
$$;

create or replace function public.trg_force_non_ba() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_always boolean; v_from date; v_date date; v_bucket uuid;
begin
  select non_ba, non_ba_from into v_always, v_from from public.profiles where id = new.ba_id;
  -- Leave before touching any date column: this trigger runs on EVERY write to these
  -- three tables, and the date column has a different name in each. A single CASE over
  -- new.trip_date/new.expense_date/new.work_date resolves ALL of its branches against
  -- the actual record, so it errors on whichever table doesn't have that column —
  -- which took out every hours/trips/expenses write, not just this person's.
  if not coalesce(v_always,false) and v_from is null then return new; end if;
  if    tg_table_name = 'trips'    then v_date := new.trip_date;
  elsif tg_table_name = 'expenses' then v_date := new.expense_date;
  else                                  v_date := new.work_date;
  end if;
  if not (coalesce(v_always,false) or v_date >= v_from) then
    return new;                       -- dated before they stopped being a BA
  end if;
  v_bucket := public.non_ba_disp();
  -- The three tables do NOT share an attribution shape, and PL/pgSQL resolves a field
  -- reference against the actual record — so each table gets only the columns it has:
  --   trips    → kind, dispensary_id            (no dispensary_ids, no alloc)
  --   expenses → dispensary_id, dispensary_ids, alloc   (no kind)
  --   hours    → all of them
  -- Park on the Non-BA bucket rather than clearing the link: a NULL link would be
  -- re-autolinked onto real stores by hours_before, which runs after this trigger.
  if tg_table_name = 'trips' then
    new.kind := 'Non-BA activity';
    new.dispensary_id := v_bucket;
  elsif tg_table_name = 'expenses' then
    new.dispensary_id  := v_bucket;
    new.dispensary_ids := case when v_bucket is null then null else array[v_bucket] end;
    new.alloc := null;
  else
    new.kind := 'Non-BA activity';
    new.dispensary_id  := v_bucket;
    new.dispensary_ids := case when v_bucket is null then null else array[v_bucket] end;
    new.alloc := null;
  end if;
  return new;
end $$;

-- ── Keelin: not a BA from 2026-08-01 ───────────────────────────────────────
update public.profiles set non_ba_from = '2026-08-01' where email = 'keelin@wizardtrees.com';

-- Re-file what she already has on/after that date; a no-op UPDATE is enough, the
-- trigger does the work. APPROVED rows are included on purpose: this changes which
-- bucket the work is REPORTED under, not whether it was paid. Her rows are already
-- approved, so skipping them would have re-filed nothing at all. The amounts are
-- protected either way — trg_hours_before pins amount := old.amount on an approved
-- row, so a re-file cannot move money.
update public.hours set updated_at = now()
 where ba_id = (select id from public.profiles where email='keelin@wizardtrees.com')
   and work_date >= '2026-08-01';
update public.trips set updated_at = now()
 where ba_id = (select id from public.profiles where email='keelin@wizardtrees.com')
   and trip_date >= '2026-08-01';
update public.expenses set updated_at = now()
 where ba_id = (select id from public.profiles where email='keelin@wizardtrees.com')
   and expense_date >= '2026-08-01';

-- Verify — FL history still on real stores, everything from 8/1 on the Non-BA bucket:
--   select case when work_date < '2026-08-01' then 'before 8/1' else 'from 8/1' end as era,
--          kind, count(*), sum(amount),
--          (select name from dispensaries d where d.id = h.dispensary_ids[1]) as bucket
--     from public.hours h where ba_id=(select id from profiles where email='keelin@wizardtrees.com')
--    group by 1,2,5 order by 1;
