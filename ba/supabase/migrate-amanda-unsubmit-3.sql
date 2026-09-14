-- Amanda, third early submission (applied to the live project Mon 2026-09-14).
-- She submitted Sep 12 to 25 on Sep 12 at 11:00 AM, the first day of the period, which
-- locks it against the trips she'll log over the next two weeks. Revert it to draft the
-- same way as the previous two times (unsubmit_period never touches approved rows).
select public.unsubmit_period(
  (select id from public.profiles where email = 'amanda@wizardtrees.com'),
  (select id from public.pay_periods where end_date = '2026-09-25')) as unsubmit;
