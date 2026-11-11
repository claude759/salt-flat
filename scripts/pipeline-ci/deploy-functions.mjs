#!/usr/bin/env node
// The Pipeline deploy workflow's function step: deploys each save-program folder named in FUNCTIONS (space separated,
// worked out by apply-sql.mjs from the deploy record) to the CA project with the Supabase CLI already on PATH, one at a
// time, from the repo root (pipeline-sheet-write imports files beside it). Folders listed in no-verify-jwt.txt are
// deployed with --no-verify-jwt (pg_cron calls them with their own secret header); every other one keeps Supabase's
// sign-in check. Writes the ones that deployed to the output "deployed", for the record job. Never prints the token.
// Deploys nothing (output "stale") when main has moved on since this run's commit, and nothing (failing) when it cannot
// tell.
// Env: SUPABASE_ACCESS_TOKEN (the supabase-functions environment's secret), FUNCTIONS.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';

const names = (process.env.FUNCTIONS || '').split(/\s+/).filter(Boolean);
const known = L.functionNames();
const off = L.noVerifyJwt();

if (!names.length) {
  L.setOutput('deployed', '');
  L.summary('### Save-program deploys\n\nNothing to deploy.');
  process.exit(0);
}
if (!process.env.SUPABASE_ACCESS_TOKEN) {
  L.setOutput('deployed', '');
  L.annotate('notice', 'SUPABASE_ACCESS_TOKEN is not set up yet (supabase-functions environment), so nothing was deployed.');
  L.summary(`### Save-program deploys\n\nNot set up yet: the \`supabase-functions\` environment has no \`SUPABASE_ACCESS_TOKEN\` secret. Waiting: ${names.join(', ')}.`);
  process.exit(0);
}
for (const n of names) {
  if (!L.FUNCTION_RE.test(n) || !known.includes(n) || !existsSync(path.join(L.ROOT, 'supabase', 'functions', n, 'index.ts'))) {
    L.annotate('error', `Refused to deploy "${n}": not a supabase/functions/pipeline-* folder with an index.ts`);
    process.exit(1);
  }
}
// An older run must never deploy older code over a newer commit's: "Re-run failed jobs" on an old run re-runs this job
// with that run's commit and its database job's list. When main has moved on, the newer commit's run deploys instead.
const fresh = L.mainHasNewerDeployChanges();
if (fresh.error) {
  L.setOutput('deployed', '');
  L.annotate('error', `Could not check main for newer pipeline changes (${fresh.error}), so nothing was deployed; the version already live keeps running. Re-run this job.`);
  L.summary(`### Save-program deploys\n\nNothing deployed: could not check main for newer pipeline changes. Waiting: ${names.join(', ')}.`);
  process.exit(1);
}
if (fresh.stale) {
  L.setOutput('deployed', '');
  L.setOutput('stale', 'true');
  L.annotate('notice', `A newer commit on main changes pipeline files; its own run deploys them. Nothing was deployed by this older run (it would have put older code live): ${names.join(', ')}.`);
  L.summary(`### Save-program deploys\n\nSkipped: a newer commit on main changes pipeline files, and its own run deploys them. Not deployed by this older run: ${names.join(', ')}.`);
  process.exit(0);
}

const deployed = [];
const rows = [];
for (const n of names) {
  const args = ['functions', 'deploy', n, '--project-ref', L.PROJECT_REF, '--use-api'];
  if (off.has(n)) args.push('--no-verify-jwt');
  const group = process.env.GITHUB_ACTIONS === 'true';
  console.log(`${group ? '::group::' : ''}Deploy ${n}${off.has(n) ? ' (--no-verify-jwt)' : ''}`);
  const t0 = Date.now();
  const r = spawnSync('supabase', args, { cwd: L.ROOT, stdio: 'inherit', env: process.env, timeout: 10 * 60e3 });
  if (group) console.log('::endgroup::');
  const s = ((Date.now() - t0) / 1000).toFixed(0);
  if (r.status === 0) {
    deployed.push(n);
    rows.push(`| ${n} | deployed | ${off.has(n) ? 'off (cron)' : 'on'} | ${s} |`);
  } else {
    rows.push(`| ${n} | FAILED (the version already live keeps running) | ${off.has(n) ? 'off (cron)' : 'on'} | ${s} |`);
    L.annotate('error', `Deploying ${n} failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}; the version already live keeps running, and the next run tries again.`, { file: `supabase/functions/${n}/index.ts`, title: 'Function deploy failed' });
  }
}
L.setOutput('deployed', deployed.join(' '));
L.summary(['### Save-program deploys', '', '| Function | Result | Sign-in check | Seconds |', '|---|---|---|---|', ...rows].join('\n'));
process.exit(deployed.length === names.length ? 0 : 1);
