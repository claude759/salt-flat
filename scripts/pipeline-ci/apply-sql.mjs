#!/usr/bin/env node
// The Pipeline deploy workflow's database step. It signs in as pipeline_owner (never postgres) with PIPELINE_DB_URL.
//   MODE=apply             every file in supabase/pipeline-order.txt whose sha256 differs from its last applied copy
//                          (public.pipeline_sql_applied) is applied, in list order, each in its own transaction with
//                          the checks below run inside it, so a file that breaks something is rolled back. Then a smoke
//                          test, and the save-program folders whose files changed since their last deploy go to the
//                          output "functions" for the deploy job.
//   MODE=plan              says what apply would do; changes nothing, and takes no lock (plan runs outside the deploy
//                          queue, so it must never hold up an apply).
//   MODE=record-functions  records the folders in DEPLOYED (space separated) as deployed at this commit.
// apply and record-functions first ask whether main has moved on since this commit (lib.mjs mainHasNewerDeployChanges).
// If it has, they change nothing and set the output "stale" (the workflow then starts a fresh run of main when this
// was a re-run); if they cannot tell, they stop with an error and change nothing.
// Nothing it prints is data: only file names, hashes, statuses, counts and masked error messages (never an error's
// DETAIL, a row, or the connection string), because this repo's Actions logs are public.
// Env: PIPELINE_DB_URL (the pipeline-db environment's secret), MODE, DEPLOYED, GITHUB_SHA, RUN_URL.
// Locally (never on GitHub), PIPELINE_CI_LOCAL_TEST=1 lets it talk to a throwaway Postgres on localhost.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';

const MODE = (process.env.MODE || 'apply').trim();
const ON_GITHUB = process.env.GITHUB_ACTIONS === 'true';
const git = (args) => execFileSync('git', args, { cwd: L.ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const COMMIT = process.env.GITHUB_SHA || git(['rev-parse', 'HEAD']);
const RUN_URL = process.env.RUN_URL || null;
const LOCK = [746170, 1];   // pg advisory lock: one deploy at a time, whoever runs it

function fail(message, opts) {
  L.annotate('error', message, opts);
  L.summary(`### Pipeline database\n\n**Stopped:** ${L.mask(message)}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------------------------
// What must stay true after every file (checked inside each file's transaction, and again at the end).
const REQUIRED_TABLES = [
  'pipeline_viewers', 'pipeline_batches', 'pipeline_batches_meta', 'pipeline_batches_secret', 'pipeline_marks',
  'pipeline_marks_meta', 'pipeline_marks_secret', 'pipeline_batch_labs', 'pipeline_batch_labs_meta',
  'pipeline_batch_labs_secret', 'pipeline_trims', 'pipeline_trims_meta', 'pipeline_trims_secret', 'pipeline_inventory',
  'pipeline_inventory_meta', 'pipeline_inventory_secret', 'pipeline_editors', 'pipeline_write_settings',
  'pipeline_edits', 'pipeline_edit_locks', 'pipeline_sql_applied',
];
const REQUIRED_FUNCTIONS = [
  'pipeline_jwt_email()', 'pipeline_source()', 'pipeline_can_view()', 'pipeline_can_edit(text)', 'pipeline_edit_status()',
  'pipeline_marks_save(text,jsonb,jsonb)', 'pipeline_batches_save(text,jsonb,jsonb)', 'pipeline_batch_labs_save(text,jsonb)',
  'pipeline_trims_save(text,jsonb,jsonb)', 'pipeline_inventory_save(text,text,jsonb,jsonb)',
  'pipeline_lock_cells(text[],integer,text,text)', 'pipeline_unlock_cells(text[],text)', 'schedule_board_ca_workbook()',
];
// [function signature or table, role, privilege, must have it?, what breaks or leaks otherwise]
const PAGE_TABLES = ['pipeline_batches', 'pipeline_batches_meta', 'pipeline_marks', 'pipeline_marks_meta', 'pipeline_batch_labs',
  'pipeline_batch_labs_meta', 'pipeline_trims', 'pipeline_trims_meta', 'pipeline_inventory', 'pipeline_inventory_meta', 'pipeline_edits'];
const PRIVILEGES = [
  ['pipeline_source()', 'authenticated', 'execute', true, 'the page could not get the workbook'],
  ['pipeline_source()', 'anon', 'execute', false, 'signed-out visitors could ask for the workbook'],
  ['pipeline_can_view()', 'authenticated', 'execute', true, 'the page tables could not check who may read them'],
  ['pipeline_edit_status()', 'authenticated', 'execute', true, 'the page could not tell whether to show Edit'],
  ['pipeline_edit_status()', 'anon', 'execute', false, 'signed-out visitors could read the edit switches'],
  ['pipeline_can_edit(text)', 'authenticated', 'execute', true, 'the save program could not check editors'],
  ['pipeline_lock_cells(text[],integer,text,text)', 'service_role', 'execute', true, 'the save program could not lock cells'],
  ['pipeline_lock_cells(text[],integer,text,text)', 'anon', 'execute', false, 'anyone could lock cells'],
  ['pipeline_lock_cells(text[],integer,text,text)', 'authenticated', 'execute', false, 'anyone signed in could lock cells'],
  ['pipeline_unlock_cells(text[],text)', 'service_role', 'execute', true, 'the save program could not unlock cells'],
  ['pipeline_unlock_cells(text[],text)', 'anon', 'execute', false, 'anyone could unlock cells'],
  ['pipeline_unlock_cells(text[],text)', 'authenticated', 'execute', false, 'anyone signed in could unlock cells'],
  ['schedule_board_ca_workbook()', 'anon', 'execute', false, 'the workbook id would leak'],
  ['schedule_board_ca_workbook()', 'authenticated', 'execute', false, 'the workbook id would leak'],
  ['pipeline_write_settings', 'anon', 'select', false, 'the test copy id would leak'],
  ['pipeline_write_settings', 'authenticated', 'select', false, 'the test copy id would leak'],
  ['pipeline_write_settings', 'service_role', 'select', true, 'the save program could not read its switches'],
  ['pipeline_editors', 'anon', 'select', false, 'editor emails would leak'],
  ['pipeline_editors', 'authenticated', 'select', false, 'editor emails would leak'],
  ['pipeline_edit_locks', 'anon', 'select', false, 'lock holders would leak'],
  ['pipeline_edit_locks', 'authenticated', 'select', false, 'lock holders would leak'],
  ['pipeline_edits', 'anon', 'select', false, 'the edit log would leak'],
  ['pipeline_edits', 'authenticated', 'insert', false, 'anyone signed in could write the edit log'],
  ['pipeline_edits', 'service_role', 'insert', true, 'the save program could not log edits'],
  ['pipeline_sql_applied', 'anon', 'select', false, 'the deploy record would be public'],
  ['pipeline_sql_applied', 'authenticated', 'select', false, 'the deploy record would be readable from the page'],
  ...PAGE_TABLES.map((t) => [t, 'authenticated', 'select', true, 'the page could not read it']),
];

// Structure: everything pipeline is owned by pipeline_owner and protected; pipeline_owner owns nothing else.
const STRUCTURE_SQL = String.raw`
with me as (select oid from pg_catalog.pg_roles where rolname = session_user),
     pub as (select oid from pg_catalog.pg_namespace where nspname = 'public')
select problem from (
  select 'not owned by pipeline_owner: ' || c.relname as problem
    from pg_class c, me, pub
   where c.relnamespace = pub.oid and c.relname like 'pipeline\_%' and c.relkind in ('r','p','v','m','S','f','i','I')
     and c.relowner <> me.oid
  union all
  select 'row level security is off on ' || c.relname
    from pg_class c, pub
   where c.relnamespace = pub.oid and c.relname like 'pipeline\_%' and c.relkind in ('r','p') and not c.relrowsecurity
  union all
  select 'token table ' || c.relname || ' has a policy (nobody may read it)'
    from pg_class c, pub
   where c.relnamespace = pub.oid and c.relname ~ '^pipeline_.*_secret$' and c.relkind = 'r'
     and exists (select 1 from pg_policy p where p.polrelid = c.oid)
  union all
  select 'view ' || c.relname || ' can be read from the page without its own row checks (make it security_invoker)'
    from pg_class c, pub
   where c.relnamespace = pub.oid and c.relname like 'pipeline\_%'
     and (c.relkind = 'm' or (c.relkind = 'v' and not exists (select 1 from unnest(c.reloptions) o
                                                               where o ~* '^security_invoker=(true|on|yes|1)$')))
     and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))
  union all
  select 'function not owned by pipeline_owner: ' || p.proname
    from pg_proc p, me, pub
   where p.pronamespace = pub.oid and p.proname like 'pipeline\_%' and p.proowner <> me.oid
  union all
  select 'security definer function without a fixed search_path: ' || p.proname
    from pg_proc p, pub
   where p.pronamespace = pub.oid and p.proname like 'pipeline\_%' and p.prosecdef
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) s where s like 'search\_path=%')
  union all
  select 'pipeline_owner owns ' || n.nspname || '.' || c.relname || ', which is not a public.pipeline_* object'
    from pg_class c join pg_namespace n on n.oid = c.relnamespace, me, pub
   where c.relowner = me.oid and n.nspname not like 'pg\_%' and not (c.relnamespace = pub.oid and c.relname like 'pipeline\_%')
  union all
  select 'pipeline_owner owns function ' || n.nspname || '.' || p.proname || ', which is not named pipeline_*'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace, me, pub
   where p.proowner = me.oid and not (p.pronamespace = pub.oid and p.proname like 'pipeline\_%')
  union all
  select 'pipeline_owner owns type ' || n.nspname || '.' || t.typname || ', which is not named pipeline_*'
    from pg_type t join pg_namespace n on n.oid = t.typnamespace, me, pub
   where t.typowner = me.oid and n.nspname not like 'pg\_%'
     and not (t.typnamespace = pub.oid and (t.typname like 'pipeline\_%' or t.typname like '\_pipeline\_%'))
  union all
  select 'pipeline_owner owns schema ' || n.nspname from pg_namespace n, me where n.nspowner = me.oid
  union all
  select 'pipeline_owner has been made a member of ' || r.rolname
    from pg_auth_members a join pg_roles r on r.oid = a.roleid, me where a.member = me.oid
  union all
  select 'pipeline_owner has more power than it should'
    from pg_roles r, me where r.oid = me.oid and (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls)
  -- pg_net: every role, this one included, can read, change and empty net.http_request_queue (other apps' queued calls,
  -- Vault secrets in their headers) and net._http_response, and run net.http_*; postgres cannot take that away. These
  -- keep pipeline objects that name those schemas, read them, hang triggers or foreign keys on them from going live by
  -- mistake (SQL built up in pieces at run time still gets past them).
  union all
  select 'function ' || p.proname || ' reaches schema net, vault, cron or supabase_functions (they hold other apps'' calls and secrets)'
    from pg_proc p, pub
   where p.pronamespace = pub.oid and p.proname like 'pipeline\_%'
     and (p.prosrc ~* '(^|[^a-z0-9_$."/-])"?(net|vault|cron|supabase_functions)"?\s*\.\s*"?[a-z_]'
          or exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) s
                      where s ~* '^search_path=(.*[\s,"])?(net|vault|cron|supabase_functions)("|,|\s|$)'))
  union all
  select distinct 'view ' || v.relname || ' uses schema ' || n.nspname || ' (it holds other apps'' calls and secrets)'
    from pg_class v
    join pg_rewrite w on w.ev_class = v.oid
    join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = w.oid
    join pg_namespace n on n.oid = case d.refclassid
                                     when 'pg_class'::regclass then (select c2.relnamespace from pg_class c2 where c2.oid = d.refobjid)
                                     when 'pg_proc'::regclass then (select p2.pronamespace from pg_proc p2 where p2.oid = d.refobjid)
                                   end, pub
   where v.relnamespace = pub.oid and v.relname like 'pipeline\_%' and v.relkind in ('v', 'm')
     and n.nspname in ('net', 'vault', 'cron', 'supabase_functions')
  union all
  select 'trigger ' || t.tgname || ' on ' || n.nspname || '.' || c.relname || ' runs pipeline function ' || p.proname
         || ', but that table is not a pipeline table'
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid, me, pub
   where not t.tgisinternal and p.proowner = me.oid and not (c.relnamespace = pub.oid and c.relname like 'pipeline\_%')
  union all
  select 'table ' || c.relname || ' has a foreign key into ' || n.nspname || '.' || f.relname
         || ', which is not a pipeline table (it could hold up that table''s deletes)'
    from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_class f on f.oid = k.confrelid
    join pg_namespace n on n.oid = f.relnamespace, pub
   where k.contype = 'f' and c.relnamespace = pub.oid and c.relname like 'pipeline\_%'
     and not (f.relnamespace = pub.oid and f.relname like 'pipeline\_%')
) x
order by 1`;

const CLAIMS = JSON.stringify({ role: 'authenticated', sub: '00000000-0000-0000-0000-000000000000', email: 'pipeline-ci-smoke@example.invalid' });
// [function, a query returning one boolean "ok", what is wrong when it is false]
const CALLS = [
  ['pipeline_can_view()', 'select public.pipeline_can_view() = false as ok', 'pipeline_can_view() lets a stranger in'],
  ['pipeline_source()', 'select public.pipeline_source() is null as ok', 'pipeline_source() hands a stranger the workbook'],
  ['pipeline_can_edit(text)', "select public.pipeline_can_edit('plan') = false as ok", 'pipeline_can_edit() lets a stranger edit'],
  ['pipeline_edit_status()', "select (public.pipeline_edit_status() ->> 'can_plan') = 'false' as ok", 'pipeline_edit_status() says a stranger may edit'],
  ['schedule_board_ca_workbook()', 'select public.schedule_board_ca_workbook() is not null as ok', 'schedule_board_ca_workbook() finds no CA workbook, so the page would get none'],
];

const errText = (e) => L.mask(`${e.code ? e.code + ' ' : ''}${e.message || e}${e.hint ? ` (hint: ${e.hint})` : ''}`);

// Runs every check inside the caller's transaction. requireAll: missing required objects count as problems.
async function checks(client, requireAll) {
  const problems = [];
  const present = new Set();
  const { rows: have } = await client.query(
    `select f, to_regprocedure('public.' || f) is not null as here from unnest($1::text[]) f
     union all
     select t, to_regclass('public.' || t) is not null from unnest($2::text[]) t`,
    [REQUIRED_FUNCTIONS, REQUIRED_TABLES]);
  for (const r of have) {
    if (r.here) present.add(r.f);
    else if (requireAll) problems.push(`missing: ${r.f}`);
  }
  const { rows } = await client.query(STRUCTURE_SQL);
  problems.push(...rows.map((r) => r.problem));

  for (const [obj, role, priv, want, why] of PRIVILEGES) {
    if (!present.has(obj)) continue;
    const sql = obj.includes('(')
      ? 'select has_function_privilege($1, $2, $3) as ok'
      : 'select has_table_privilege($1, $2, $3) as ok';
    const { rows: [r] } = await client.query(sql, [role, `public.${obj}`, priv]);
    if (r.ok !== want) problems.push(`${role} ${want ? 'lost' : 'got'} ${priv} on ${obj}: ${why}`);
  }

  await client.query("select set_config('request.jwt.claims', $1, true)", [CLAIMS]);
  for (const [fn, sql, why] of CALLS) {
    if (!present.has(fn)) continue;
    try {
      await client.query('savepoint pipeline_ci_call');
      const { rows: [r] } = await client.query(sql);
      await client.query('release savepoint pipeline_ci_call');
      if (r.ok !== true) problems.push(why);
    } catch (e) {
      await client.query('rollback to savepoint pipeline_ci_call');
      problems.push(`${fn} failed when called: ${errText(e)}`);
    }
  }
  await client.query("select set_config('request.jwt.claims', '', true)");
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
function connectionConfig(raw) {
  let u;
  try { u = new URL(raw); } catch { fail('PIPELINE_DB_URL is not a connection string (postgresql://user:password@host:5432/postgres)'); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) fail('PIPELINE_DB_URL must start with postgresql://');
  const user = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = Number(u.port || 5432);
  const database = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres';
  if (ON_GITHUB && password) console.log(`::add-mask::${password}`);
  const local = process.env.PIPELINE_CI_LOCAL_TEST === '1' && !ON_GITHUB && ['localhost', '127.0.0.1', '::1'].includes(host);
  if (local) {
    if (user !== 'pipeline_owner') fail('PIPELINE_DB_URL must sign in as pipeline_owner');
    return { config: { host, port, user, password, database, ssl: false }, tls: 'none (local test)' };
  }
  const pooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host);
  const direct = host === `db.${L.PROJECT_REF}.supabase.co`;
  if (!pooler && !direct) fail(`PIPELINE_DB_URL must point at the CA project: its session pooler (*.pooler.supabase.com) or db.${L.PROJECT_REF}.supabase.co`);
  if (port !== 5432) fail('PIPELINE_DB_URL must use port 5432 (session mode); 6543 is transaction mode, which cannot run these files');
  const want = pooler ? `pipeline_owner.${L.PROJECT_REF}` : 'pipeline_owner';
  if (user !== want) fail(`PIPELINE_DB_URL must sign in as ${want}, never as postgres or another role`);
  if (database !== 'postgres') fail('PIPELINE_DB_URL must name the database postgres');
  // TLS: verified against the project's CA when scripts/pipeline-ci/supabase-ca.crt is committed (it is public: Dashboard,
  // Database settings, SSL Configuration, Download certificate); otherwise encrypted but not verified.
  const caPath = path.join(L.ROOT, 'scripts', 'pipeline-ci', 'supabase-ca.crt');
  const ssl = existsSync(caPath) ? { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true } : { rejectUnauthorized: false };
  return { config: { host, port, user, password, database, ssl }, tls: ssl.rejectUnauthorized ? 'verified against supabase-ca.crt' : 'encrypted, server certificate not verified (commit scripts/pipeline-ci/supabase-ca.crt to verify it)' };
}

function pendingFunctions(latest) {
  return L.functionNames()
    .map((n) => ({ name: n, sha: L.functionHash(n) }))
    .filter((f) => latest.get(`function supabase/functions/${f.name}`) !== f.sha);
}

// ---------------------------------------------------------------------------------------------------------------
async function main() {
  if (!['apply', 'plan', 'record-functions'].includes(MODE)) fail(`Unknown MODE "${MODE}" (apply, plan or record-functions)`);

  const chk = L.checkAll();
  for (const w of chk.warnings) L.annotate('warning', w.message, { file: w.file, line: w.line });
  if (chk.errors.length) {
    for (const e of chk.errors) L.annotate('error', e.message, { file: e.file, line: e.line });
    fail(`${chk.errors.length} problem(s) in the SQL files; nothing was applied`);
  }

  if (!process.env.PIPELINE_DB_URL) {
    L.annotate('notice', 'PIPELINE_DB_URL is not set up yet (pipeline-db environment), so nothing was applied.');
    L.summary('### Pipeline database\n\nNot set up yet: the `pipeline-db` environment has no `PIPELINE_DB_URL` secret. Nothing was applied.');
    return 0;
  }
  // An older run (a "Re-run" of one, say) must never put older SQL or an older deploy record over a newer commit's.
  if (MODE === 'apply' || MODE === 'record-functions') {
    const what = MODE === 'apply' ? 'applied' : 'recorded';
    const fresh = L.mainHasNewerDeployChanges();
    if (fresh.error) fail(`Could not check main for newer pipeline changes (${fresh.error}), so nothing was ${what}. Re-run this job.`);
    if (fresh.stale) {
      L.setOutput('stale', 'true');
      if (MODE === 'apply') L.setOutput('functions', '');
      L.annotate('notice', `A newer commit on main changes pipeline files; its own run applies them. Nothing was ${what} by this older run.`);
      L.summary(`### Pipeline database\n\nSkipped: a newer commit on main changes pipeline files, and its own run applies them. Nothing was ${what} by this older run.`);
      return 0;
    }
  }

  const { config, tls } = connectionConfig(process.env.PIPELINE_DB_URL);
  const require = createRequire(import.meta.url);
  let pg;
  try { pg = require('pg'); } catch { fail('The Postgres client is not installed (npm ci --prefix scripts/pipeline-ci --ignore-scripts)'); }
  const client = new pg.Client({
    ...config, application_name: `github-pipeline-deploy ${COMMIT.slice(0, 7)}`,
    connectionTimeoutMillis: 20000, query_timeout: 300000, keepAlive: true,
  });
  let dropped = null;
  client.on('error', (e) => { dropped = e; });
  try { await client.connect(); } catch (e) { fail(`Could not connect as pipeline_owner: ${errText(e)}`); }

  try {
    // plan changes nothing, so it takes no lock: it runs outside the deploy queue and must never hold up an apply
    const { rows: [who] } = await client.query(
      `select current_user::text as cu, session_user::text as su,
              to_regclass('public.pipeline_sql_applied') is not null as has_record,
              case when $3::boolean then pg_try_advisory_lock($1, $2) else true end as locked`, [...LOCK, MODE !== 'plan']);
    if (who.cu !== 'pipeline_owner' || who.su !== 'pipeline_owner') fail(`PIPELINE_DB_URL signs in as ${who.su}, not pipeline_owner; refusing to run anything`);
    if (!who.has_record) fail('public.pipeline_sql_applied is missing: Gianni runs supabase/postgres/pipeline-owner-bootstrap.sql first');
    if (!who.locked) fail('Another deploy holds the pipeline deploy lock; try again in a minute');

    const { rows: rec } = await client.query(
      `select distinct on (kind, file) kind, file, sha256 from public.pipeline_sql_applied order by kind, file, id desc`);
    const latest = new Map(rec.map((r) => [`${r.kind} ${r.file}`, r.sha256]));

    if (MODE === 'record-functions') {
      const names = (process.env.DEPLOYED || '').split(/\s+/).filter(Boolean);
      const known = L.functionNames();
      for (const n of names) if (!known.includes(n)) fail(`"${n}" is not a supabase/functions/pipeline-* folder`);
      await client.query('begin');
      for (const n of names) {
        await client.query(
          `insert into public.pipeline_sql_applied (kind, file, sha256, git_commit, run_url) values ('function', $1, $2, $3, $4)`,
          [`supabase/functions/${n}`, L.functionHash(n), COMMIT, RUN_URL]);
      }
      await client.query('commit');
      L.summary(`### Save-program deploys recorded\n\n${names.length ? names.map((n) => `- ${n} (\`${L.functionHash(n).slice(0, 12)}\`)`).join('\n') : 'None.'}`);
      console.log(`recorded ${names.length} deploy(s): ${names.join(' ') || 'none'}`);
      return 0;
    }

    const files = chk.files.map((name) => ({ name, ...L.readSql(name) }));
    const pending = files.filter((f) => latest.get(`sql supabase/${f.name}`) !== f.sha);
    const fnPending = pendingFunctions(latest);
    const rows = [];
    let failed = null;

    if (MODE === 'plan') {
      for (const f of files) rows.push([f.name, f.sha, pending.includes(f) ? 'would apply' : 'unchanged', '']);
    } else {
      for (const f of files) {
        if (!pending.includes(f)) { rows.push([f.name, f.sha, 'unchanged', '']); continue; }
        if (failed) { rows.push([f.name, f.sha, 'not tried (an earlier file failed)', '']); continue; }
        const t0 = Date.now();
        try {
          await client.query('begin');
          await client.query("set local lock_timeout = '5s'");
          await client.query("set local statement_timeout = '120s'");
          await client.query(f.text);
          const problems = await checks(client, false);
          if (problems.length) {
            const e = new Error(`the file ran, but it would break this: ${problems.join('; ')}`);
            e.checks = true;
            throw e;
          }
          await client.query(
            `insert into public.pipeline_sql_applied (kind, file, sha256, git_commit, run_url) values ('sql', $1, $2, $3, $4)`,
            [`supabase/${f.name}`, f.sha, COMMIT, RUN_URL]);
          await client.query('commit');
          const s = ((Date.now() - t0) / 1000).toFixed(1);
          rows.push([f.name, f.sha, 'applied', s]);
          console.log(`applied supabase/${f.name} (sha256 ${f.sha.slice(0, 12)}) in ${s} s`);
        } catch (e) {
          try { await client.query('rollback'); } catch { /* the connection may be gone */ }
          const s = ((Date.now() - t0) / 1000).toFixed(1);
          let line;
          if (!e.checks && e.position) line = f.text.slice(0, Number(e.position) - 1).split('\n').length;
          failed = { name: f.name, message: e.checks ? L.mask(e.message) : errText(e), line };
          rows.push([f.name, f.sha, 'FAILED, rolled back', s]);
          L.annotate('error', `${failed.message} (rolled back; nothing in this file was applied)`, { file: `supabase/${f.name}`, line, title: 'Pipeline SQL failed' });
        } finally {
          try { await client.query('reset all'); await client.query('reset role'); } catch { /* ignore */ }
        }
        if (dropped) break;
      }
    }

    // the smoke test, on what is live now (in a transaction that is rolled back)
    let smoke = [];
    if (!dropped) {
      try {
        await client.query('begin');
        smoke = await checks(client, true);
      } catch (e) {
        smoke = [`the smoke test itself failed: ${errText(e)}`];
      } finally {
        try { await client.query('rollback'); } catch { /* ignore */ }
      }
    } else smoke = [`the database connection dropped: ${errText(dropped)}`];
    for (const p of smoke) L.annotate('error', `Smoke test: ${p}`, { title: 'Pipeline smoke test' });

    const ok = !failed && !smoke.length;
    const deploy = MODE === 'apply' && ok ? fnPending.map((f) => f.name) : [];
    L.setOutput('functions', deploy.join(' '));

    const md = [`### Pipeline database (${MODE})`, '', '| File | sha256 | Result | Seconds |', '|---|---|---|---|'];
    for (const [n, sha, res, s] of rows) md.push(`| supabase/${n} | \`${sha.slice(0, 12)}\` | ${res} | ${s} |`);
    md.push('');
    if (failed) md.push(`**supabase/${failed.name} failed${failed.line ? ` at line ${failed.line}` : ''}:** ${failed.message}`, '', 'It was rolled back. Fix it and push again; files after it were not tried.', '');
    md.push(smoke.length ? `**Smoke test: ${smoke.length} problem(s)**\n\n${smoke.map((p) => `- ${L.mask(p)}`).join('\n')}` : 'Smoke test: passed (ownership, row level security, privileges, and the page functions called as a stranger).');
    md.push('');
    if (MODE === 'plan') md.push(`Save-program functions that would deploy: ${fnPending.map((f) => f.name).join(', ') || 'none'}.`);
    else md.push(`Save-program functions to deploy: ${deploy.join(', ') || 'none'}${!ok && fnPending.length ? ' (held back by the problem above)' : ''}.`);
    md.push('', `Connection: ${tls}.`);
    L.summary(md.join('\n'));
    console.log(`pipeline database: ${rows.filter((r) => r[2] === 'applied').length} applied, ${rows.filter((r) => r[2] === 'unchanged').length} unchanged, smoke ${smoke.length ? 'FAILED' : 'passed'}`);
    return ok ? 0 : 1;
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

main().then((code) => process.exit(code), (e) => fail(`Unexpected: ${errText(e)}`));
