-- ── One-off second reminder: Sun 2026-08-16, 8:30am Los Angeles ────────────
-- A follow-up nudge to whoever still hasn't submitted for the period that ended
-- Fri 2026-08-14 (the Saturday 11am reminder already went out).
--
-- Three things the payload has to override, or this quietly does nothing:
--   • force=true  — the job returns early unless the LA hour is exactly 11, and
--                   again if the period already has reminder_sent_at (it does).
--   • ended_on    — without it the job looks for the period that ended YESTERDAY.
--                   Run on Aug 16 that means Aug 15, and no period ends then, so it
--                   would skip with "no pay period ended 2026-08-15".
--   • the recipient list is recomputed when it fires, so anyone who submits
--     overnight is dropped automatically — it only ever chases what's outstanding.
--
-- 8:30am LA = 15:30 UTC (PDT, UTC-7). pg_cron runs in UTC, and '30 15 16 8 *'
-- would come back every August 16, so the job removes itself after firing.
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

create or replace function public.ba_reminder_oneoff() returns void
language plpgsql security definer set search_path=public as $$
begin
  perform net.http_post(
    url := 'https://dhiqhgtmelxwelyoowle.supabase.co/functions/v1/ba-notify',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-notify-secret',(select decrypted_secret from vault.decrypted_secrets where name='ba_notify_secret')),
    body := jsonb_build_object('job','reminder','force',true,'ended_on','2026-08-14'));
  -- fire once, then take itself off the schedule
  perform cron.unschedule('ba-reminder-oneoff');
end $$;

do $$ begin perform cron.unschedule('ba-reminder-oneoff'); exception when others then null; end $$;
select cron.schedule('ba-reminder-oneoff', '30 15 16 8 *', $$select public.ba_reminder_oneoff()$$);

-- Verify:
--   select jobname, schedule, active from cron.job where jobname='ba-reminder-oneoff';
--   -- after it fires, that row should be GONE and this should show the send:
--   select status_code, content::text from net._http_response order by id desc limit 1;
-- Cancel before it fires:
--   select cron.unschedule('ba-reminder-oneoff');
