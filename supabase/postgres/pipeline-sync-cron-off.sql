-- Production Pipeline sync jobs: switch the three pg_cron schedules OFF (they stay defined; pipeline-sync-cron-on.sql
-- switches them on again). Runs as postgres, from Gianni's Mac:
--   node ~/claude-sql/run-sql-ca.mjs "<repo>/supabase/postgres/pipeline-sync-cron-off.sql"
-- Usually not needed: setting a job's mode to 'off' (pipeline_sync_set, from the page) stops it too.
select cron.alter_job(jobid, active := false)
  from cron.job where jobname in ('pipeline-sync-marks', 'pipeline-sync-trims', 'pipeline-sync-batches');
select jobname, schedule, active from cron.job where jobname like 'pipeline-sync-%' order by jobname;
