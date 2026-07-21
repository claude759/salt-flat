-- ============================================================================
--  Wizard Trees NY Labor Tracker · GUSTO IMPORT support · 2026-07-21
-- ----------------------------------------------------------------------------
--  Idempotent (safe to re-run). Additive on top of ny-tracker-phase0.sql.
--
--  Almost every imported row carries real clock times, so the trigger's own math
--  keeps owning `hours`. The exception is PAID LEAVE (Gusto's "Paid time off"
--  column, and any timesheet Gusto pays without a punch): those days have hours
--  but no in/out, and forcing them to 0 would drop paid time the tracker is
--  supposed to show. So: for source='import' rows with no clock times, whatever
--  hours the importer supplies stands.
--
--  Manual rows are untouched — clearing the times on a hand-typed row still
--  zeroes its hours, exactly as before.
-- ============================================================================

create or replace function public.ny_shift_calc()
returns trigger language plpgsql as $$
declare mins int;
begin
  if new.clock_in is not null and new.clock_out is not null then
    mins := (extract(epoch from (new.clock_out - new.clock_in)) / 60)::int;
    if mins < 0 then mins := mins + 24*60; end if;      -- overnight
    mins := mins - coalesce(new.break_minutes, 0);
    if mins < 0 then mins := 0; end if;
    new.hours := round(mins / 60.0, 3);
  elsif new.source = 'import' then
    new.hours := coalesce(new.hours, 0);                -- paid leave: importer's number stands
  else
    new.hours := 0;
  end if;
  new.total := round(coalesce(new.hours,0) * coalesce(new.rate,0) * coalesce(new.people,1), 2);
  new.updated_at := now();
  return new;
end $$;

-- the sync reconciles a whole date window each run, so it reads by (source, work_date)
create index if not exists ny_shifts_source_date_ix
  on public.ny_shifts(source, work_date);

select 'ny tracker gusto import ready' as result;
