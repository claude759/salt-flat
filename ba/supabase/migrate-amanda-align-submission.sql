-- Amanda submitted Aug 1-14 BEFORE her salary labor existed, so that period holds
-- draft hours rows and a totals snapshot saying labor:0. Bring both in line with what
-- is actually recorded. Her REIMBURSE total is untouched at $114.40 — labor is recorded,
-- never reimbursed (the submission email lists it as a separate "Labor (recorded)" line).
update public.hours h
   set status = 'submitted'
  from public.submissions s, public.pay_periods p
 where s.ba_id = h.ba_id and s.period_id = h.period_id and p.id = s.period_id
   and h.ba_id = (select id from public.profiles where email='amanda@wizardtrees.com')
   and p.end_date = '2026-08-14' and s.status = 'submitted' and h.status = 'draft';

update public.submissions s
   set totals = jsonb_set(s.totals, '{labor}', to_jsonb(
         (select round(coalesce(sum(h.amount),0),2) from public.hours h
           where h.ba_id = s.ba_id and h.period_id = s.period_id)))
  from public.pay_periods p
 where p.id = s.period_id and p.end_date = '2026-08-14'
   and s.ba_id = (select id from public.profiles where email='amanda@wizardtrees.com');

select s.status, s.totals,
       (select string_agg(distinct h.status,',') from public.hours h
         where h.ba_id=s.ba_id and h.period_id=s.period_id) as hours_row_status
from public.submissions s join public.pay_periods p on p.id=s.period_id
where s.ba_id=(select id from public.profiles where email='amanda@wizardtrees.com')
  and p.end_date='2026-08-14';
