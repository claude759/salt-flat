-- Undo Amanda's premature submission of Aug 15–28.
-- The period runs to Aug 28 and she submitted on Aug 16 (day 2 of 14) with 2 trips,
-- which locked her rows — she couldn't have added the next twelve days of mileage.
-- Reversing it: the submission goes back to 'open' and her locked items back to 'draft'.
-- Her totals snapshot is cleared too, so it can't be mistaken for a real submission.
-- Nothing is deleted; she can re-submit in one tap if it WAS intentional.
begin;

update public.trips t set status = 'draft'
  from public.submissions s, public.pay_periods p
 where s.id = (select s2.id from public.submissions s2 join public.pay_periods p2 on p2.id = s2.period_id
                where s2.ba_id = (select id from public.profiles where email='amanda@wizardtrees.com')
                  and p2.end_date = '2026-08-28')
   and p.id = s.period_id and t.ba_id = s.ba_id and t.period_id = s.period_id
   and t.status = 'submitted';

update public.expenses e set status = 'draft'
  from public.submissions s
 where s.ba_id = (select id from public.profiles where email='amanda@wizardtrees.com')
   and s.period_id = (select id from public.pay_periods where end_date='2026-08-28')
   and e.ba_id = s.ba_id and e.period_id = s.period_id and e.status = 'submitted';

update public.hours h set status = 'draft'
  from public.submissions s
 where s.ba_id = (select id from public.profiles where email='amanda@wizardtrees.com')
   and s.period_id = (select id from public.pay_periods where end_date='2026-08-28')
   and h.ba_id = s.ba_id and h.period_id = s.period_id and h.status = 'submitted';

update public.submissions s
   set status = 'open', submitted_at = null, totals = '{}'::jsonb
 where s.ba_id = (select id from public.profiles where email='amanda@wizardtrees.com')
   and s.period_id = (select id from public.pay_periods where end_date='2026-08-28');

select s.status, s.submitted_at, s.totals,
       (select coalesce(string_agg(distinct t.status,','),'—') from public.trips t
         where t.ba_id=s.ba_id and t.period_id=s.period_id) as trips,
       (select coalesce(string_agg(distinct h.status,','),'—') from public.hours h
         where h.ba_id=s.ba_id and h.period_id=s.period_id) as hours
from public.submissions s
where s.ba_id=(select id from public.profiles where email='amanda@wizardtrees.com')
  and s.period_id=(select id from public.pay_periods where end_date='2026-08-28');
commit;
