-- ── unsubmit_period: hand a period back to the person who submitted it ─────
-- Submitting locks a period's rows. People routinely submit and then realise they
-- missed a day (Amanda submitted the wrong period on day 2; Leti submitted before
-- adding Aug 1), and until now undoing it meant hand-written UPDATEs each time.
--
-- What it does, and deliberately does NOT do:
--   • reverts only rows currently 'submitted' → 'draft'. Rows already APPROVED are
--     left alone: those are settled payroll (e.g. Gusto-synced hours), not something
--     the person edits, and silently unapproving them would hide a paid item.
--   • clears the submission back to 'open' with no submitted_at and empty totals, so
--     a stale snapshot can't be mistaken for a real submission.
--   • deletes nothing.
--
-- Admin-only in the app; open from the SQL editor (auth.uid() null) as break-glass,
-- the same rule the other admin functions use.
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

create or replace function public.unsubmit_period(p_ba uuid, p_period uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_t int; v_e int; v_h int; v_who text; v_period text;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'only an admin can reopen a submitted period';
  end if;

  update public.trips set status = 'draft'
   where ba_id = p_ba and period_id = p_period and status = 'submitted';
  get diagnostics v_t = row_count;

  update public.expenses set status = 'draft'
   where ba_id = p_ba and period_id = p_period and status = 'submitted';
  get diagnostics v_e = row_count;

  update public.hours set status = 'draft'
   where ba_id = p_ba and period_id = p_period and status = 'submitted';
  get diagnostics v_h = row_count;

  update public.submissions
     set status = 'open', submitted_at = null, totals = '{}'::jsonb
   where ba_id = p_ba and period_id = p_period and status = 'submitted';

  select full_name into v_who   from public.profiles    where id = p_ba;
  select label     into v_period from public.pay_periods where id = p_period;
  return jsonb_build_object('ba', v_who, 'period', v_period,
                            'trips', v_t, 'expenses', v_e, 'hours', v_h);
end $$;
grant execute on function public.unsubmit_period(uuid, uuid) to authenticated;

-- Leti: submitted Aug 1–14 at 7:32am, then realised she hadn't added Aug 1.
select public.unsubmit_period(
  (select id from public.profiles    where email    = 'leticia@wizardtrees.com'),
  (select id from public.pay_periods where end_date = '2026-08-14')) as result;
