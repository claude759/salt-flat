#!/usr/bin/env node
// The Pipeline deploy workflow's database-free check (also handy before a push):
//   node scripts/pipeline-ci/check-sql.mjs
// Checks supabase/pipeline-order.txt and every file on it, the *-verify.sql checks (privacy only), and the save-program
// folders, without any secret or database. Exits 1 on any error; warnings are printed but do not fail.
import { checkAll, readSql, functionNames, functionHash, noVerifyJwt, annotate, summary } from './lib.mjs';

const r = checkAll();
for (const w of r.warnings) annotate('warning', w.message, { file: w.file, line: w.line });
for (const e of r.errors) annotate('error', e.message, { file: e.file, line: e.line });

const off = noVerifyJwt();
const lines = ['### Pipeline SQL check', '', '| # | File | sha256 |', '|---|---|---|'];
r.files.forEach((f, k) => lines.push(`| ${k + 1} | supabase/${f} | \`${readSql(f).sha.slice(0, 12)}\` |`));
lines.push('', '| Save-program function | sha256 | Sign-in check |', '|---|---|---|');
for (const n of functionNames()) {
  let h = '(unreadable)';
  try { h = functionHash(n).slice(0, 12); } catch { /* reported above */ }
  lines.push(`| ${n} | \`${h}\` | ${off.has(n) ? 'off (cron)' : 'on'} |`);
}
lines.push('', r.errors.length ? `**${r.errors.length} problem(s); nothing will be applied.**` : 'All listed files pass.');
summary(lines.join('\n'));
if (r.errors.length) process.exit(1);
console.log(`pipeline sql check: ${r.files.length} files and ${functionNames().length} functions pass${r.warnings.length ? ` (${r.warnings.length} warning(s))` : ''}`);
