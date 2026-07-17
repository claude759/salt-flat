-- ── Email reminders + submission alerts (drives the ba-notify edge function) ──
-- 1. BA reminder: cron pings ba-notify at the two UTC hours that straddle 11am LA;
--    the function itself gates on "11am America/Los_Angeles" + "a period ended
--    yesterday" + "not already sent", so it fires exactly once per period, DST-safe.
-- 2. Submission alert: a trigger pings ba-notify the instant a submission becomes
--    'submitted', so gianni@ hears about it server-side (not reliant on the app).
-- Auth: a random secret in Vault; ba-notify verifies it via ba_notify_authorized().

create extension if not exists pg_net;
create extension if not exists pg_cron;

alter table public.pay_periods add column if not exists reminder_sent_at timestamptz;

-- shared secret (generated once, lives only in Vault)
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'ba_notify_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-',''),
      'ba_notify_secret',
      'Shared secret the cron job / submission trigger present to the ba-notify edge function');
  end if;
end $$;

-- ba-notify calls this to check the x-notify-secret header without ever holding the
-- raw secret. service_role only (the edge function runs as service_role).
create or replace function public.ba_notify_authorized(candidate text)
returns boolean language sql security definer set search_path = public, vault as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'ba_notify_secret' and decrypted_secret = candidate);
$$;
revoke all on function public.ba_notify_authorized(text) from public, anon, authenticated;
grant execute on function public.ba_notify_authorized(text) to service_role;

-- fire ba-notify when a submission transitions INTO 'submitted' (not on approve/edits,
-- and NOT on an admin undoing an approval — approved→submitted is not a BA submitting)
create or replace function public.trg_submission_notify()
returns trigger language plpgsql security definer set search_path = public, vault, net as $$
begin
  if new.status = 'submitted' and (tg_op = 'INSERT'
       or (old.status is distinct from 'submitted' and old.status is distinct from 'approved')) then
    perform net.http_post(
      url := 'https://dhiqhgtmelxwelyoowle.supabase.co/functions/v1/ba-notify',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'x-notify-secret',(select decrypted_secret from vault.decrypted_secrets where name='ba_notify_secret')),
      body := jsonb_build_object('job','submitted','ba_id',new.ba_id,'period_id',new.period_id));
  end if;
  return new;
end;
$$;
drop trigger if exists submission_notify on public.submissions;
create trigger submission_notify after insert or update on public.submissions
  for each row execute function public.trg_submission_notify();

-- daily reminder ping (18:00 & 19:00 UTC = the two clock times that hit 11am LA
-- across DST; the function proceeds only in the real 11am LA hour)
do $$ begin perform cron.unschedule('ba-reminders'); exception when others then null; end $$;
select cron.schedule('ba-reminders', '0 18,19 * * *', $CRON$
  select net.http_post(
    url := 'https://dhiqhgtmelxwelyoowle.supabase.co/functions/v1/ba-notify',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-notify-secret',(select decrypted_secret from vault.decrypted_secrets where name='ba_notify_secret')),
    body := jsonb_build_object('job','reminder'));
$CRON$);

notify pgrst, 'reload schema';

select
  (select count(*) from vault.secrets where name='ba_notify_secret') as secret_rows,
  (select count(*) from cron.job where jobname='ba-reminders') as cron_rows,
  (select count(*) from pg_trigger where tgname='submission_notify') as trigger_rows,
  (select extname from pg_extension where extname='pg_net') as pg_net,
  (select extname from pg_extension where extname='pg_cron') as pg_cron;
