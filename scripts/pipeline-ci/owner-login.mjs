#!/usr/bin/env node
// Turns on (or replaces) pipeline_owner's login, without the password ever reaching Postgres, its log, the screen or
// this repo. Run on Gianni's Mac after supabase/postgres/pipeline-owner-bootstrap.sql (and lockdown-public-execute.sql):
//   node scripts/pipeline-ci/owner-login.mjs [--host <session pooler host>]
// It makes a new random password and:
//   1. writes ~/claude-sql/pending/pipeline-owner-login.sql (readable only by Gianni's account): ALTER ROLE ... LOGIN
//      PASSWORD with a SCRAM-SHA-256 verifier computed here. Postgres stores a verifier as it is, so only the verifier
//      (not the password) is in the statement Postgres logs;
//   2. puts the connection string (session pooler, port 5432, user pipeline_owner.<project ref>) on the clipboard.
// Then, in this order: paste the clipboard into GitHub, environment pipeline-db, secret PIPELINE_DB_URL; apply
//   node ~/claude-sql/run-sql-ca.mjs ~/claude-sql/pending/pipeline-owner-login.sql
// and delete that file. Running this again replaces the password: do all three steps again.
// To stop the role logging in: apply "alter role pipeline_owner nologin;" the same way.
// The pooler host is read from the Supabase Management API with the CLI token already on this Mac (as run-sql-ca.mjs
// does), unless --host is given (Dashboard, Connect, Session pooler).
import { randomBytes, pbkdf2Sync, createHmac, createHash } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_REF } from './lib.mjs';

const PENDING = path.join(os.homedir(), 'claude-sql', 'pending');
const OUT = path.join(PENDING, 'pipeline-owner-login.sql');

export function scramVerifier(password, salt = randomBytes(16), iterations = 4096) {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

async function poolerHost() {
  const i = process.argv.indexOf('--host');
  if (i > 0) return process.argv[i + 1];
  const tokenFile = path.join(os.homedir(), '.supabase', 'access-token');
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
  if (!token) throw new Error('no Supabase CLI token on this Mac; pass --host <session pooler host> (Dashboard, Connect, Session pooler)');
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/config/database/pooler`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30e3) });
  if (!r.ok) throw new Error(`the Management API answered ${r.status}; pass --host <session pooler host> instead`);
  const body = await r.json();
  const list = Array.isArray(body) ? body : [body];
  const hit = list.find((p) => p && (p.database_type ?? 'PRIMARY') === 'PRIMARY' && /\.pooler\.supabase\.com$/.test(p.db_host || ''));
  if (!hit) throw new Error('the Management API gave no session pooler host; pass --host <session pooler host> instead');
  return hit.db_host;
}

async function main() {
  const host = String(await poolerHost() || '').trim().toLowerCase();
  if (!/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host)) throw new Error('the pooler host should look like aws-0-<region>.pooler.supabase.com');
  const password = randomBytes(32).toString('base64url');
  const verifier = scramVerifier(password);
  mkdirSync(PENDING, { recursive: true });
  writeFileSync(OUT, [
    '-- Turns on pipeline_owner\'s login with a password verifier made by scripts/pipeline-ci/owner-login.mjs.',
    '-- Apply once with run-sql-ca.mjs, then delete this file. Never commit it.',
    `alter role pipeline_owner with login password '${verifier}';`,
    '',
  ].join('\n'), { mode: 0o600 });
  const url = `postgresql://pipeline_owner.${PROJECT_REF}:${password}@${host}:5432/postgres`;
  const copy = spawnSync('pbcopy', { input: url });
  if (copy.status !== 0) throw new Error('could not put the connection string on the clipboard (pbcopy); nothing else was changed');
  console.log(`Wrote ${OUT} (a password verifier, not the password).`);
  console.log('The connection string for GitHub is on the clipboard (it is not shown here).');
  console.log('Next: paste it as the pipeline-db environment secret PIPELINE_DB_URL, apply the file with run-sql-ca.mjs, then delete the file.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`owner-login: ${e.message}`); process.exit(1); });
}
