-- Production Pipeline sync jobs: switch the three pg_cron schedules ON (made switched off by pipeline-sync-cron.sql).
-- Runs as postgres, from Gianni's Mac: node ~/claude-sql/run-sql-ca.mjs "<repo>/supabase/postgres/pipeline-sync-cron-on.sql"
-- Safe on its own: a job whose mode in pipeline_sync_settings is 'off' answers at once and does nothing, so what each
-- job does is still decided by its mode (off, shadow, write), which pipeline admins change from the page.
-- To stop all three again: supabase/postgres/pipeline-sync-cron-off.sql.
select cron.alter_job(jobid, active := true)
  from cron.job where jobname in ('pipeline-sync-marks', 'pipeline-sync-trims', 'pipeline-sync-batches');
select jobname, schedule, active from cron.job where jobname like 'pipeline-sync-%' order by jobname;
