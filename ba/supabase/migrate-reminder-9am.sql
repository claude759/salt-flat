-- ── Reminder time 11am → 9am, Ledy on Leti's, period open till Sun 6pm ─────
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

-- 1. Ledy CC'd on Leti's reminders (appended; Joanna stays)
update public.profiles p
   set reminder_cc = (select array(select distinct e
                        from unnest(p.reminder_cc || array['ledyy1016@gmail.com']) e))
 where p.email = 'leticia@wizardtrees.com'
   and not ('ledyy1016@gmail.com' = any(p.reminder_cc));

-- 2. The daily job fires at 9am Los Angeles instead of 11am.
--    Two UTC slots so it lands at 9am local across DST (16:00 UTC = 9am PDT,
--    17:00 UTC = 9am PST); ba-notify itself only proceeds in the real 9am LA hour.
do $$ begin perform cron.unschedule('ba-reminders'); exception when others then null; end $$;
select cron.schedule('ba-reminders', '0 16,17 * * *', $CRON$
  select net.http_post(
    url := 'https://dhiqhgtmelxwelyoowle.supabase.co/functions/v1/ba-notify',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-notify-secret',(select decrypted_secret from vault.decrypted_secrets where name='ba_notify_secret')),
    body := jsonb_build_object('job','reminder'));
$CRON$);

-- 3. Aug 29–Sep 11 stays editable until Sunday Sep 13, 6:00pm Los Angeles
--    (it would otherwise lock at 11am Sunday).
update public.pay_periods
   set edit_until = timestamptz '2026-09-13 18:00:00 America/Los_Angeles'
 where end_date = '2026-09-11';

select (select array_to_string(reminder_cc, ', ') from public.profiles where email='leticia@wizardtrees.com') as leti_cc,
       (select schedule from cron.job where jobname='ba-reminders') as reminder_cron_utc,
       (select to_char(edit_until at time zone 'America/Los_Angeles','Dy Mon DD, HH12:MI AM')
          from public.pay_periods where end_date='2026-09-11') as sep11_open_until;
