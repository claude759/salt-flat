-- ── Keelin moves to biweekly salary ────────────────────────────────────────
-- $90,000/yr paid BIWEEKLY (26 periods), not twice-monthly (24) — so the per-period
-- figure is 90000/26 = $3,461.54, which is exactly what Gusto shows for Aug 1–14.
-- The app's pay periods are already 14-day biweekly, so one period = one paycheck.
--
-- Salaried people are handled like Maddy (the existing salaried BA):
--   • salary_per_period set, hourly_rate NULL — the Gusto importer skips anyone with a
--     salary ("labor comes from the salary split, not Gusto hours"), and a null hourly
--     rate means nothing can price stray manual hours at an obsolete $35/hr;
--   • generate_salary_labor() spreads the period's salary evenly across its Mon–Fri
--     days as hours rows with source='salary', which the app calls automatically
--     whenever a salaried person opens their active period.
--
-- Her 83 historical FL hours (source='gusto', Mar–Jul, $19,747.57) are NOT touched:
-- that was hourly work in Florida and it stays exactly as it was recorded.
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

update public.profiles
   set salary_per_period = 3461.54,     -- 90,000 / 26
       hourly_rate = null
 where email = 'keelin@wizardtrees.com';

-- Backfill the Aug 1–14 period she's being paid salary for. The app self-generates for
-- whichever period is ACTIVE when she next opens it, but it will never revisit a closed
-- one — and that period currently shows no labor at all for her (her Gusto hours stop
-- 7/31). generate_salary_labor authorises on auth.uid(), so run it as her.
do $$
declare v_ba uuid; v_period uuid; v_n int;
begin
  select id into v_ba from public.profiles where email = 'keelin@wizardtrees.com';
  select id into v_period from public.pay_periods where end_date = '2026-08-14';
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_ba, 'email', 'keelin@wizardtrees.com', 'role', 'authenticated')::text, true);
  select public.generate_salary_labor(v_ba, v_period) into v_n;
  raise notice 'generated % salary days for Aug 1-14', v_n;
end $$;

-- Verify — expect 10 weekday rows at $346.15 (= $3,461.50; the 4c remainder is the
-- same even-split rounding the other salaried BA has), and the FL history untouched:
--   select source, coalesce(state,'—') as state, count(*), sum(amount)
--     from public.hours where ba_id=(select id from profiles where email='keelin@wizardtrees.com')
--    group by 1,2 order by 1,2;
