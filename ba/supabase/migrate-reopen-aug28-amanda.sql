-- Reopen Aug 15 to 28 so Amanda can submit it (applied 2026-09-14).
-- It locked Aug 31; her 2 trips ($72.48) were unsubmitted on request and never resubmitted.
-- The email sent today asks her to submit it, so it has to be editable. Period-wide, so
-- anyone else still unsubmitted in Aug 15 to 28 can edit too (the verify below lists them).
-- Window: through Fri Sep 25 11pm Los Angeles, the end of the current period, so it stays
-- open until she is in the app submitting anyway.
update public.pay_periods
   set edit_until = timestamptz '2026-09-25 23:00:00 America/Los_Angeles'
 where end_date = '2026-08-28';

select json_build_object(
  'aug28_open_until', (select to_char(edit_until at time zone 'America/Los_Angeles','Dy Mon DD, HH12:MI AM') from public.pay_periods where end_date='2026-08-28'),
  'aug28_unsubmitted', (select json_agg(p.full_name order by p.full_name) from public.profiles p
                         where coalesce(p.active,true) and not coalesce(p.non_ba,false)
                           and (p.role='ba' or (p.role='admin' and coalesce(p.region,p.home_region) is not null))
                           and not exists (select 1 from public.submissions s where s.ba_id=p.id
                                             and s.period_id=(select id from public.pay_periods where end_date='2026-08-28')
                                             and s.status in ('submitted','approved'))),
  'amanda_sep25', (select json_build_object('status', s.status, 'submitted_at', s.submitted_at,
                     'draft_trips', (select count(*) from public.trips t where t.ba_id=s.ba_id and t.period_id=s.period_id and t.status='draft'),
                     'draft_exp', (select count(*) from public.expenses e where e.ba_id=s.ba_id and e.period_id=s.period_id and e.status='draft'))
                     from public.submissions s where s.ba_id=(select id from public.profiles where email='amanda@wizardtrees.com')
                      and s.period_id=(select id from public.pay_periods where end_date='2026-09-25'))
) as r;
