// pipeline-trims-sync: the site trim workbooks (2026 TRIM SHEETS folder) -> public.pipeline_trims, hourly (pg_cron,
// supabase/postgres/pipeline-sync-cron.sql). The cloud copy of ~/ar-automation/pipeline-trims-sync.mjs on Gianni's Mac.
// The work is in job.js (pure, checked by tests/pipeline-sync-check.mjs); runtime.ts (an identical copy in each sync
// function) checks the caller, holds the job, reads Google read-only as pipeline-writer and logs the run.
// Self-contained like pipeline-sheet-write. Deploy: supabase functions deploy pipeline-trims-sync --no-verify-jwt.
// SheetJS is pinned to 0.18.5, the version the Mac job reads the workbooks with, so both read them the same way.
import XLSXmod from "npm:xlsx@0.18.5";
import { serveJob } from "./runtime.ts";
import * as job from "./job.js";

// deno-lint-ignore no-explicit-any
const XLSX: any = (XLSXmod as any)?.read ? XLSXmod : (XLSXmod as any)?.default;
serveJob(job, { XLSX });
