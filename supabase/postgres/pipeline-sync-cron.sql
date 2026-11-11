-- Production Pipeline sync jobs: the pg_cron schedules that call the Edge Functions pipeline-marks-sync (every 5
-- minutes), pipeline-trims-sync and pipeline-batches-sync (hourly), and the header secret they send.
-- Runs as postgres, once, from Gianni's Mac (it needs cron and Vault, which pipeline_owner has no access to):
--   node ~/claude-sql/run-sql-ca.mjs "<repo>/supabase/postgres/pipeline-sync-cron.sql"
-- Needs supabase/pipeline-sync.sql applied first (the pipeline_sync_secret table).
-- The schedules are created SWITCHED OFF; supabase/postgres/pipeline-sync-cron-on.sql switches them on. Once on, what
-- each job does (off, shadow, write) is its mode in pipeline_sync_settings, which pipeline admins change from the page,
-- so nothing here needs touching again.
-- The secret is made here and kept only in Vault: nobody sees it, and the functions see only its sha256
-- (pipeline_sync_secret). Safe to re-run: it keeps the secret, and never touches a schedule that already exists (so a
-- re-run never switches a running job off).

begin;

do $$
declare s text;
begin
  if not exists (select 1 from vault.secrets where name = 'pipeline_sync_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'pipeline_sync_secret',
      'Header (x-pipeline-sync) the pipeline sync cron jobs send to the pipeline-*-sync Edge Functions');
  end if;
  select decrypted_secret into s from vault.decrypted_secrets where name = 'pipeline_sync_secret';
  insert into public.pipeline_sync_secret (id, token_hash) values (1, encode(sha256(convert_to(s, 'utf8')), 'hex'))
  on conflict (id) do update set token_hash = excluded.token_hash;
end $$;

-- the call: answered at once (the functions finish in the background), so 10 seconds is plenty
do $$
declare j record; v_id bigint;
begin
  for j in select * from (values
      ('pipeline-sync-marks',   '*/5 * * * *', 'pipeline-marks-sync'),
      ('pipeline-sync-trims',   '7 * * * *',   'pipeline-trims-sync'),
      ('pipeline-sync-batches', '12 * * * *',  'pipeline-batches-sync')) v(name, sched, fn)
  loop
    if not exists (select 1 from cron.job where jobname = j.name) then
      v_id := cron.schedule(j.name, j.sched, format($cmd$select net.http_post(
    url := 'https://dhiqhgtmelxwelyoowle.supabase.co/functions/v1/%s',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-pipeline-sync', (select decrypted_secret from vault.decrypted_secrets where name = 'pipeline_sync_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000)$cmd$, j.fn));
      perform cron.alter_job(v_id, active := false);
    end if;
  end loop;
end $$;

commit;

-- what is there now (no secret is shown)
select jobname, schedule, active from cron.job where jobname like 'pipeline-sync-%' order by jobname;
