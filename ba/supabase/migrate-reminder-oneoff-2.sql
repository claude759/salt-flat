-- ── One-off reminder: Sun 2026-08-30, 9:30am Los Angeles ───────────────────
-- A nudge to whoever still hasn't submitted for the period that ended Fri 2026-08-28.
-- No reminder fires on its own today: the daily job looks for a period that ended
-- YESTERDAY (Aug 29) and none did, so it skips. The scheduled reminder for that
-- period already went out Sat Aug 29 at 11:00.
--
-- Same three overrides the last one-off needed, or this silently does nothing:
--   force=true   — the job returns early unless the LA hour is exactly 11, and again
--                  because that period already carries reminder_sent_at.
--   ended_on     — pins it to the Aug 15–28 period rather than "yesterday".
--   9:30am LA    = 16:30 UTC (PDT). pg_cron runs in UTC.
-- The recipient list is recomputed when it fires, so anyone who submits in the
-- meantime drops off by themselves.
--
-- '30 16 30 8 *' would return every Aug 30, so the job unschedules itself.

create or replace function public.ba_reminder_oneoff_2() returns void
language plpgsql security definer set search_path=public as $$
begin
  perform net.http_post(
    url := 'https://dhiqhgtmelxwelyoowle.supabase.co/functions/v1/ba-notify',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-notify-secret',(select decrypted_secret from vault.decrypted_secrets where name='ba_notify_secret')),
    body := jsonb_build_object('job','reminder','force',true,'ended_on','2026-08-28'));
  perform cron.unschedule('ba-reminder-oneoff-2');
end $$;

do $$ begin perform cron.unschedule('ba-reminder-oneoff-2'); exception when others then null; end $$;
select cron.schedule('ba-reminder-oneoff-2', '30 16 30 8 *', $$select public.ba_reminder_oneoff_2()$$);
