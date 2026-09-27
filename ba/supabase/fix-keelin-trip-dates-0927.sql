-- Keelin logged Sep 12-25 mileage on Sun 9/27 and every leg landed on 9/25: the day editor
-- could only move ALL of a day's legs to a new date, so she put the real dates in the notes.
-- Re-date the pairs whose note names the day (applied 2026-09-27). Id-scoped; draft rows only.
--   9/22  "USPS (LA)" out + back          (note "9/22" on the return leg)
--   9/26  Gardena out + back              (note "lat + fil 9/26"; Sep 26 is in the NEXT period)
-- Left on 9/25 for Keelin to date herself: "USPS Drop Off" pair (no date given) and
-- "network show 11/23" pair (11/23 can't be right for this period).
update public.trips set trip_date = '2026-09-22'
 where status = 'draft' and id in (select id from public.trips where id::text like '3c4d3bcc%' or id::text like 'b1ed67c9%')
   and ba_id = (select id from public.profiles where email = 'keelin@wizardtrees.com');
update public.trips set trip_date = '2026-09-26'
 where status = 'draft' and id in (select id from public.trips where id::text like '428d3328%' or id::text like '95e62904%')
   and ba_id = (select id from public.profiles where email = 'keelin@wizardtrees.com');
select left(id::text,8) as id, trip_date, (select end_date from public.pay_periods where id=period_id) as period_end, dest_label, miles, amount, note
  from public.trips where ba_id = (select id from public.profiles where email = 'keelin@wizardtrees.com') and trip_date >= '2026-09-12'
 order by trip_date, created_at;
