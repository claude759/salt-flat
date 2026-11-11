// pipeline-marks-sync: the red cells of the DISTRO PIPELINE tab -> public.pipeline_marks, every 5 minutes (pg_cron,
// supabase/postgres/pipeline-sync-cron.sql). The cloud copy of ~/ar-automation/pipeline-marks-sync.mjs on Gianni's Mac.
// The work is in job.js (pure, checked by tests/pipeline-sync-check.mjs); runtime.ts (an identical copy in each sync
// function) checks the caller, holds the job, reads Google read-only as pipeline-writer and logs the run.
// Self-contained like pipeline-sheet-write. Deploy: supabase functions deploy pipeline-marks-sync --no-verify-jwt.
import { serveJob } from "./runtime.ts";
import * as job from "./job.js";

serveJob(job);
