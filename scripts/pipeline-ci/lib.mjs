// Shared by the Pipeline deploy workflow's scripts (.github/workflows/pipeline-deploy.yml). No dependencies, so the
// check job can run it without installing anything and without any secret.
//
// What it knows:
//   * supabase/pipeline-order.txt, the files the workflow applies and their order
//   * the checks every listed file must pass before anything touches the database (checkSqlText)
//   * how to hash a file (exactly as ~/claude-sql/run-sql-ca.mjs does) and a save-program folder
//   * how to print to a public Actions log without leaking anything (mask, annotate)
//   * whether main has moved on since this run's commit (mainHasNewerDeployChanges), which every deploy job asks first
import { readFileSync, readdirSync, lstatSync, existsSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PROJECT_REF = 'dhiqhgtmelxwelyoowle';           // the shared CA Supabase project (public: it is in every page)
export const ORDER_FILE = 'supabase/pipeline-order.txt';
export const NO_VERIFY_JWT_FILE = 'scripts/pipeline-ci/no-verify-jwt.txt';
export const FILE_RE = /^pipeline-[a-z0-9][a-z0-9-]*\.sql$/;
export const FUNCTION_RE = /^pipeline-[a-z0-9][a-z0-9-]*$/;
// ~/claude-sql/run-sql-ca.mjs's refusal, character for character, tested the same way (on the text with -- comments cut)
export const REFUSE = /(^|;)\s*(drop\s+(table|schema|database)\b|truncate\b)/im;

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// ---------------------------------------------------------------------------------------------------------------
// Printing. Actions logs and job summaries of this public repo can be read by anyone: print file names, hashes,
// statuses and counts only. Never rows, never an error's DETAIL, never a connection string.
export function mask(s) {
  return String(s ?? '')
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '[url]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g, '[email]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[hash]')
    .replace(/[A-Za-z0-9_-]{25,}/g, (t) => (/[0-9]/.test(t) && /[A-Za-z]/.test(t) ? '[id]' : t))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}
const escData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
export function annotate(level, message, { file, line, title } = {}) {
  const props = [file && `file=${escProp(file)}`, line && `line=${escProp(line)}`, title && `title=${escProp(title)}`]
    .filter(Boolean).join(',');
  const text = mask(message);
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::${level}${props ? ' ' + props : ''}::${escData(text)}`);
  else console.log(`${level.toUpperCase()}${file ? ` ${file}${line ? ':' + line : ''}` : ''}: ${text}`);
}
export function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown.endsWith('\n') ? markdown : markdown + '\n');
  else console.log(markdown);
}
export function setOutput(name, value) {
  const v = String(value ?? '');
  if (/[\r\n]/.test(v)) throw new Error('output values must be one line');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${v}\n`);
  else console.log(`(output) ${name}=${v}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Is this run old? Every deploy job (database, functions, record) applies or deploys only what is at its own commit.
// When main has since moved on in any path that decides what the database or the save program gets, the newer
// commit's run applies that, and this run must not touch anything: a "Re-run" of an old run would otherwise put older
// SQL, older function code or an older deploy record back. These paths all start the workflow (its push filter), so a
// newer commit that changes them always has a run of its own. Returns { stale } or { error } (could not tell: the
// caller deploys nothing). Off GitHub it always says fresh, as there is no checkout of main to compare with.
export const DEPLOY_PATHS = ['supabase/pipeline-order.txt', 'supabase/pipeline-*.sql', 'supabase/functions/pipeline-*',
  'supabase/functions/_shared', 'scripts/pipeline-ci'];
export function mainHasNewerDeployChanges({ onGithub = process.env.GITHUB_ACTIONS === 'true', root = ROOT } = {}) {
  if (!onGithub) return { stale: false };
  try {
    execFileSync('git', ['fetch', '--no-tags', '--quiet', '--depth=1', 'origin', 'refs/heads/main'], { cwd: root, stdio: 'ignore', timeout: 60000 });
  } catch {
    return { error: 'could not fetch main from GitHub' };
  }
  try {
    execFileSync('git', ['diff', '--quiet', 'HEAD', 'FETCH_HEAD', '--', ...DEPLOY_PATHS], { cwd: root, stdio: 'ignore', timeout: 60000 });
    return { stale: false };
  } catch (e) {
    return e.status === 1 ? { stale: true } : { error: 'could not compare this commit with main' };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The SQL scanner. Splits a file into statements and gives, for each, the "code": the same text with comments
// blanked and the insides of 'strings' and $$ bodies blanked (newlines kept, so positions and lines line up), and
// "quoted" identifiers kept. Rules then read the code, so a word inside a comment, a string or a function body never
// counts as a statement.
export function scanSql(sql) {
  const n = sql.length;
  const code = new Array(n);
  const problems = [];
  const statements = [];
  let start = 0;
  const blank = (i) => { code[i] = sql[i] === '\n' ? '\n' : ' '; };
  const lineAt = (i) => sql.slice(0, i).split('\n').length;
  let i = 0;
  while (i < n) {
    const c = sql[i], d = sql[i + 1];
    if (c === '-' && d === '-') { while (i < n && sql[i] !== '\n') blank(i++); continue; }
    if (c === '/' && d === '*') {
      let depth = 0;
      const from = i;
      while (i < n) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; blank(i++); blank(i++); continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth--; blank(i++); blank(i++); if (depth === 0) break; continue; }
        blank(i++);
      }
      if (depth > 0) problems.push({ line: lineAt(from), message: 'a /* comment is never closed' });
      continue;
    }
    if (c === "'") {
      const escapes = /[eE]/.test(sql[i - 1] || '') && !/[A-Za-z0-9_]/.test(sql[i - 2] || '');
      const from = i;
      code[i++] = "'";
      let closed = false;
      while (i < n) {
        if (escapes && sql[i] === '\\') { blank(i++); if (i < n) blank(i++); continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { blank(i++); blank(i++); continue; }
          code[i++] = "'"; closed = true; break;
        }
        blank(i++);
      }
      if (!closed) problems.push({ line: lineAt(from), message: 'a quoted string is never closed' });
      continue;
    }
    if (c === '"') {
      const from = i;
      code[i] = c; i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { code[i] = sql[i]; code[i + 1] = sql[i + 1]; i += 2; continue; }
          code[i] = '"'; i++; closed = true; break;
        }
        code[i] = sql[i]; i++;
      }
      if (!closed) problems.push({ line: lineAt(from), message: 'a quoted name is never closed' });
      continue;
    }
    if (c === '$' && !/[A-Za-z0-9_$]/.test(sql[i - 1] || '')) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) {
          problems.push({ line: lineAt(i), message: `a ${tag} body is never closed` });
          for (let k = i; k < n; k++) blank(k);
          i = n;
          continue;
        }
        for (let k = 0; k < tag.length; k++) code[i + k] = tag[k];
        for (let k = i + tag.length; k < end; k++) blank(k);
        for (let k = 0; k < tag.length; k++) code[end + k] = tag[k];
        i = end + tag.length;
        continue;
      }
    }
    code[i] = c;
    if (c === ';') {
      statements.push({ from: start, to: i + 1 });
      start = i + 1;
    }
    i++;
  }
  if (start < n) statements.push({ from: start, to: n });
  const codeText = code.join('');
  const out = [];
  for (const s of statements) {
    const raw = sql.slice(s.from, s.to);
    const c = codeText.slice(s.from, s.to);
    const lead = c.search(/\S/);
    if (lead < 0) continue;                       // only whitespace or comments
    const norm = c.replace(/;\s*$/, '').replace(/\s+/g, ' ').trim();
    if (!norm) continue;
    out.push({ text: raw, code: c, norm: norm.toLowerCase(), normCase: norm, line: lineAt(s.from + lead) });
  }
  return { statements: out, code: codeText, problems };
}

// ---------------------------------------------------------------------------------------------------------------
// Names. A pipeline object is public.pipeline_* (or pipeline_* with no schema).
const IDENT = String.raw`(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)`;
const QNAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;
function unquoteName(q) {
  return [...q.trim().matchAll(new RegExp(IDENT, 'gi'))]
    .map((m) => (m[0].startsWith('"') ? m[0].slice(1, -1).replace(/""/g, '"') : m[0].toLowerCase()));
}
export function isPipelineName(q) {
  const parts = unquoteName(q.trim());
  if (parts.length === 2) return parts[0] === 'public' && /^pipeline_[a-z0-9_]+$/.test(parts[1]);
  return parts.length === 1 && /^pipeline_[a-z0-9_]+$/.test(parts[0]);
}
const bare = (q) => { const p = unquoteName(q.trim()); return p[p.length - 1]; };
// drop (...) groups, so commas inside argument lists or column lists do not split names
function noParens(s) { let t = s, prev; do { prev = t; t = t.replace(/\([^()]*\)/g, ''); } while (t !== prev); return t; }

const ALLOWED_LEAD = /^(create|alter|drop|comment|grant|revoke|insert|update|delete|select|do|set|reset|lock|analyze|with)\b/;
const REFUSALS = [
  [/^(begin|start transaction|commit|end|rollback|abort|savepoint|release|prepare transaction)\b/, 'has transaction control: the workflow runs each file in its own transaction'],
  [/^alter system\b/, 'changes server settings (ALTER SYSTEM)'],
  [/^(create|alter|drop) (role|user|group)\b/, 'creates or changes a role'],
  [/^(drop|reassign) owned\b/, 'drops or reassigns everything a role owns'],
  [/^(create|alter|drop) (extension|event trigger|schema|database|tablespace|publication|subscription|server|foreign data wrapper|user mapping|language|trusted language|procedural language|cast|operator|collation|conversion|text search|access method|statistics|transform)\b/, 'creates or changes something outside the pipeline tables and functions'],
  [/^create (or replace )?(trusted |procedural )+language\b/, 'creates a language'],
  [/^alter default privileges\b/, 'changes default privileges (set once, by the bootstrap in supabase/postgres/)'],
  [/^(set|reset) session authorization\b/, 'switches the session user'],
  [/^set (local |session )?role (?!pipeline_owner$)/, 'switches to a role other than pipeline_owner'],
  [/^drop (table|schema|database)\b/, 'drops a table, schema or database (do that by hand in the Supabase dashboard; there is no point-in-time recovery)'],
  [/\bconcurrently\b/, 'uses CONCURRENTLY, which cannot run inside a transaction'],
];

// Schemas a pipeline file must never reach (see checkSqlText). One entry per line of text: a reason, or ''.
const SHUT_SCHEMAS = 'net|vault|cron|supabase_functions';
const SHUT_NAMED = new RegExp(String.raw`(^|[^A-Za-z0-9_$."/-])"?(${SHUT_SCHEMAS})"?\s*\.\s*"?[A-Za-z_]`, 'i');
const SHUT_PATH = new RegExp(String.raw`(^|[\s,='"(])"?(${SHUT_SCHEMAS})"?(?=[\s,;'")]|$)`, 'i');
export function otherSchemaLines(text) {
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/--[^\n]*/g, '');
  return plain.split('\n').map((l) => {
    let m = SHUT_NAMED.exec(l);
    if (m) return `names schema ${m[2].toLowerCase()} (pg_net, Vault or cron, which hold other apps' calls and secrets): the pipeline never reads or writes them`;
    if (/search_path/i.test(l) && (m = SHUT_PATH.exec(l))) return `puts schema ${m[2].toLowerCase()} on a search_path (pg_net, Vault or cron hold other apps' calls and secrets): the pipeline never reaches them`;
    return '';
  });
}

// Checks one file's text. Returns { errors, warnings, defs }: errors stop the workflow before anything is applied.
export function checkSqlText(name, text, { verify = false } = {}) {
  const errors = [];
  const warnings = [];
  const defs = [];
  const err = (line, message) => errors.push({ line, message });

  // privacy, on the raw text (comments included): the repo and its Actions logs are public
  const lines = text.split('\n');
  lines.forEach((l, k) => {
    for (const m of l.matchAll(/[A-Za-z0-9]@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) {
      if (!/@(example\.(com|org|net)|[a-z0-9.-]+\.invalid)$/i.test(m[0])) err(k + 1, 'contains an email address (the repo is public; add people on the admin page instead)');
    }
    for (const m of l.matchAll(/[A-Za-z0-9_-]{25,}/g)) {
      const t = m[0];
      if (/[0-9]/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t)) err(k + 1, 'contains what looks like a file id, key or token (the repo is public)');
    }
    if (/\b[0-9a-f]{32,}\b/i.test(l)) err(k + 1, 'contains what looks like a hash or key (the repo is public)');
    if (/\b(sbp_|sb_secret_|sb_publishable_|sk_live_|eyJ[A-Za-z0-9_-]{8,})|SCRAM-SHA-256\$/.test(l)) err(k + 1, 'contains what looks like a key, token or password verifier (the repo is public)');
  });
  if (verify) return { errors, warnings, defs };

  if (REFUSE.test(text.replace(/--[^\n]*/g, ''))) err(undefined, 'drops a table, schema or database, or truncates (refused, as run-sql-ca.mjs refuses it)');
  // pg_net, Vault, cron: every role, pipeline_owner included, can read, change and empty pg_net's request queue and its
  // responses (other apps' queued calls carry Vault secrets in their headers), and Postgres gives no way to shut one
  // role out of that. So a pipeline file never names those schemas, not even inside a function body or a string, and
  // never puts them on a search_path, so the pipeline does not hand that data to the page or block other apps' calls
  // by mistake. This stops mistakes and plain attempts, not SQL built up in pieces, and whoever can push to main can
  // also change this check.
  otherSchemaLines(text).forEach((why, k) => { if (why) err(k + 1, why); });
  const scan = scanSql(text);
  for (const p of scan.problems) err(p.line, p.message);
  scan.code.split('\n').forEach((l, k) => { if (/^\s*\\/.test(l)) err(k + 1, 'has a psql backslash command'); });

  const st = scan.statements;
  if (!st.length) err(1, 'has no statements');
  else {
    if (!/^set (local )?role pipeline_owner$/.test(st[0].norm)) warnings.push({ line: st[0].line, message: 'should start with "set role pipeline_owner;" so a run from Gianni\'s Mac also leaves everything owned by pipeline_owner' });
    if (st[st.length - 1].norm !== 'reset role') warnings.push({ line: st[st.length - 1].line, message: 'should end with "reset role;"' });
  }

  for (const s of st) {
    const q = s.norm;
    const L = s.line;
    let refused = false;
    for (const [re, why] of REFUSALS) if (re.test(q)) { err(L, why); refused = true; }
    if (/^truncate\b/.test(q)) { err(L, 'truncates a table'); continue; }
    if (refused && !/^(create|alter|drop|grant|revoke|set|reset) /.test(q)) continue;
    if (!ALLOWED_LEAD.test(q)) { err(L, `has a statement this workflow does not run: "${q.split(' ').slice(0, 3).join(' ')}"`); continue; }
    if (/^delete from /.test(q) && !/\bwhere\b/.test(q)) err(L, 'deletes without a WHERE');
    if (/^update /.test(q) && !/\bwhere\b/.test(q)) err(L, 'updates without a WHERE');
    if (/\bowner to (?!pipeline_owner\b)/.test(q)) err(L, 'gives an object to a role other than pipeline_owner');

    let m;
    // create ...
    if ((m = new RegExp(String.raw`^create (?:or replace )?((?:(?:global |local )?(?:temp|temporary) )?)(?:unlogged |unique |constraint |recursive |materialized )*(table|view|function|procedure|index|sequence|type|trigger|policy|aggregate|domain|rule)\b(?: if not exists)?\s*(.*)$`).exec(q))) {
      const [, temp, kind, rest] = m;
      if (temp && kind === 'table') continue;
      const restCase = s.normCase.slice(s.normCase.length - rest.length);
      if (kind === 'index') {
        const im = new RegExp(String.raw`^(?:(${QNAME}) )?on (?:only )?(${QNAME})`, 'i').exec(restCase);
        if (!im) { err(L, 'creates an index this check cannot read'); continue; }
        if (im[1] && !isPipelineName(im[1])) err(L, `creates index ${im[1]}, which is not named pipeline_*`);
        if (!isPipelineName(im[2])) err(L, `creates an index on ${im[2]}, which is not a pipeline table`);
        if (im[1]) defs.push({ kind: 'index', key: bare(im[1]), line: L });
        continue;
      }
      const nm = new RegExp(String.raw`^(${QNAME})`, 'i').exec(restCase);
      if (!nm) { err(L, `creates a ${kind} this check cannot read`); continue; }
      if (kind === 'policy' || kind === 'trigger' || kind === 'rule') {
        const on = new RegExp(String.raw`\bon (?:only )?(${QNAME})`, 'i').exec(restCase.slice(nm[0].length));
        if (!on || !isPipelineName(on[1])) { err(L, `creates a ${kind} on something that is not a pipeline table`); continue; }
        defs.push({ kind, key: `${bare(on[1])}.${bare(nm[1])}`, line: L });
        continue;
      }
      if (!isPipelineName(nm[1])) { err(L, `creates ${kind} ${nm[1]}, which is not named pipeline_* in schema public`); continue; }
      defs.push({ kind: kind === 'procedure' ? 'function' : kind, key: bare(nm[1]), line: L });
      continue;
    }
    // alter ...
    if ((m = new RegExp(String.raw`^alter (table|view|materialized view|function|procedure|routine|sequence|index|type|policy|trigger|aggregate|domain|rule)(?: if exists)?(?: only)? (${QNAME})(.*)$`, 'i').exec(s.normCase))) {
      const [, kind, nameQ, rest] = m;
      const k = kind.toLowerCase();
      if (k === 'policy' || k === 'trigger' || k === 'rule') {
        const on = new RegExp(String.raw`\bon (?:only )?(${QNAME})`, 'i').exec(rest);
        if (!on || !isPipelineName(on[1])) err(L, `changes a ${k} on something that is not a pipeline table`);
      } else if (!isPipelineName(nameQ)) err(L, `changes ${k} ${nameQ}, which is not a pipeline object`);
      const rn = new RegExp(String.raw`\brename to (${QNAME})`, 'i').exec(rest);
      if (rn && !['policy', 'trigger', 'rule'].includes(k) && !isPipelineName(rn[1])) err(L, `renames to ${rn[1]}, which is not named pipeline_*`);
      continue;
    }
    if (/^alter /.test(q)) { err(L, 'changes something that is not a pipeline table, view, function, sequence, index, type or policy'); continue; }
    // drop ...
    if ((m = new RegExp(String.raw`^drop (view|materialized view|function|procedure|routine|index|sequence|type|policy|trigger|aggregate|domain|rule)(?: if exists)? (.*)$`, 'i').exec(noParens(s.normCase)))) {
      const [, kind, rest] = m;
      const k = kind.toLowerCase();
      if (k === 'policy' || k === 'trigger' || k === 'rule') {
        const on = new RegExp(String.raw`\bon (?:only )?(${QNAME})`, 'i').exec(rest);
        if (!on || !isPipelineName(on[1])) err(L, `drops a ${k} on something that is not a pipeline table`);
      } else {
        const names = rest.replace(/\s+(cascade|restrict)\s*$/i, '').split(/\s*,\s*/);
        for (const nmq of names) if (!isPipelineName(nmq)) err(L, `drops ${k} ${nmq}, which is not a pipeline object`);
        if (/\bcascade\s*$/i.test(rest)) err(L, 'drops with CASCADE, which can take other things with it');
      }
      continue;
    }
    if (/^drop /.test(q)) { err(L, 'drops something this workflow does not drop'); continue; }
    // grant / revoke
    if (/^(grant|revoke) /.test(q)) {
      const g = noParens(s.normCase);
      const gm = /\son\s+(.*?)\s+(to|from)\s/i.exec(g);
      if (!gm) { err(L, 'grants or revokes a role membership'); continue; }
      let target = gm[1];
      if (/^all \w+ in schema\b/i.test(target)) { err(L, 'grants or revokes on everything in a schema'); continue; }
      if (/^(schema|database|tablespace|language|large object|foreign data wrapper|foreign server|parameter)\b/i.test(target)) { err(L, 'grants or revokes on something that is not a pipeline object'); continue; }
      target = target.replace(/^(table|function|procedure|routine|sequence|type|domain)\s+/i, '');
      for (const nmq of target.split(/\s*,\s*/)) if (!isPipelineName(nmq)) err(L, `grants or revokes on ${nmq}, which is not a pipeline object`);
      continue;
    }
    // comment on
    if (/^comment on /.test(q)) {
      const cm = new RegExp(String.raw`^comment on (table|column|view|materialized view|function|procedure|index|sequence|type|policy|trigger|constraint) (${QNAME}(?:\s*\.\s*${IDENT})?)(?:\s*\([^)]*\))?(?: on (${QNAME}))? is\b`, 'i').exec(s.normCase);
      if (!cm) { err(L, 'comments on something that is not a pipeline object'); continue; }
      const kind = cm[1].toLowerCase();
      const target = ['policy', 'trigger', 'constraint'].includes(kind) ? cm[3] : kind === 'column' ? cm[2].replace(/\s*\.\s*[^.]+$/, '') : cm[2];
      if (!target || !isPipelineName(target)) err(L, `comments on ${cm[2]}, which is not a pipeline object`);
      continue;
    }
    // writes to tables
    if ((m = new RegExp(String.raw`^(?:insert into|update(?: only)?|delete from(?: only)?) (${QNAME})`, 'i').exec(s.normCase))) {
      if (!isPipelineName(m[1])) err(L, `writes to ${m[1]}, which is not a pipeline table`);
      continue;
    }
  }
  return { errors, warnings, defs };
}

// ---------------------------------------------------------------------------------------------------------------
// The list and the files.
export function readOrder() {
  const errors = [];
  const files = [];
  const orderPath = path.join(ROOT, ORDER_FILE);
  if (!existsSync(orderPath)) return { files, errors: [{ file: ORDER_FILE, message: 'is missing' }] };
  readFileSync(orderPath, 'utf8').split('\n').forEach((l, k) => {
    const name = l.replace(/#.*$/, '').trim();
    if (!name) return;
    const at = { file: ORDER_FILE, line: k + 1 };
    if (!FILE_RE.test(name)) return errors.push({ ...at, message: `"${name}" is not a supabase/pipeline-*.sql file name` });
    if (/-verify\.sql$/.test(name)) return errors.push({ ...at, message: `${name} is a check; the workflow never applies *-verify.sql` });
    if (files.includes(name)) return errors.push({ ...at, message: `${name} is listed twice` });
    const p = path.join(ROOT, 'supabase', name);
    if (!existsSync(p)) return errors.push({ ...at, message: `${name} does not exist` });
    const st = lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink()) return errors.push({ ...at, message: `${name} is not a plain file` });
    files.push(name);
  });
  for (const f of readdirSync(path.join(ROOT, 'supabase'))) {
    if (!/^pipeline-.*\.sql$/.test(f) || /-verify\.sql$/.test(f) || files.includes(f)) continue;
    if (errors.some((e) => e.message.startsWith(`${f} `))) continue;
    errors.push({ file: `supabase/${f}`, message: `is not in ${ORDER_FILE}, so it would never be applied: add it there` });
  }
  return { files, errors };
}
export function readSql(name) {
  const text = readFileSync(path.join(ROOT, 'supabase', name), 'utf8');
  return { text, sha: sha256(text) };
}

// Checks the list and every listed file (and the privacy of every *-verify.sql, and that no email address is in
// tests/pipeline-* or a function folder). Used by the check job and again by
// the database job before it connects.
export function checkAll() {
  const order = readOrder();
  const errors = [...order.errors];
  const warnings = [];
  const seen = new Map();
  for (const name of order.files) {
    const { text } = readSql(name);
    const r = checkSqlText(name, text);
    for (const e of r.errors) errors.push({ file: `supabase/${name}`, ...e });
    for (const w of r.warnings) warnings.push({ file: `supabase/${name}`, ...w });
    for (const d of r.defs) {
      const k = `${d.kind} ${d.key}`;
      if (!seen.has(k)) seen.set(k, []);
      const where = seen.get(k);
      if (!where.some((x) => x.name === name)) where.push({ name, line: d.line });
    }
  }
  for (const [k, where] of seen) {
    if (where.length < 2) continue;
    for (const w of where.slice(1)) errors.push({ file: `supabase/${w.name}`, line: w.line, message: `${k} is also defined in ${where[0].name}: define each table, function and policy in one file only, or whichever file changes last silently wins` });
  }
  for (const f of readdirSync(path.join(ROOT, 'supabase'))) {
    if (!/^pipeline-.*-verify\.sql$/.test(f)) continue;
    const r = checkSqlText(f, readFileSync(path.join(ROOT, 'supabase', f), 'utf8'), { verify: true });
    for (const e of r.errors) errors.push({ file: `supabase/${f}`, ...e });
  }
  // email addresses in the other files that start this workflow too (tests/pipeline-*, every save-program folder and
  // _shared): the repo is public. Emails only; their made-up ids and hashes are test data.
  const codeFiles = existsSync(path.join(ROOT, 'tests')) ? readdirSync(path.join(ROOT, 'tests')).filter((f) => /^pipeline-/.test(f)).map((f) => `tests/${f}`) : [];
  for (const n of [...functionNames(), '_shared']) {
    const dir = path.join(ROOT, 'supabase', 'functions', n);
    try { if (existsSync(dir)) codeFiles.push(...walk(dir).map((f) => `supabase/functions/${n}/${f}`)); } catch { /* a symbolic link: reported below */ }
  }
  for (const f of codeFiles) {
    if (!lstatSync(path.join(ROOT, f)).isFile()) continue;
    const r = checkSqlText(f, readFileSync(path.join(ROOT, f), 'utf8'), { verify: true });
    for (const e of r.errors) if (/email address/.test(e.message)) errors.push({ file: f, line: e.line, message: 'contains an email address (the repo is public; a test builds one by concatenation, as \'name\' + \'@wizardtrees.com\')' });
  }
  const fn = checkFunctionList();
  errors.push(...fn.errors);
  warnings.push(...fn.warnings);
  return { files: order.files, errors, warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// Save-program folders (supabase/functions/pipeline-*). Each is deployed on its own when its hash changes.
export function functionNames() {
  const dir = path.join(ROOT, 'supabase', 'functions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => FUNCTION_RE.test(f) && lstatSync(path.join(dir, f)).isDirectory()).sort();
}
export function noVerifyJwt() {
  const p = path.join(ROOT, NO_VERIFY_JWT_FILE);
  if (!existsSync(p)) return new Set();
  return new Set(readFileSync(p, 'utf8').split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean));
}
function walk(dir, base = dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    if (f.startsWith('.') || f === 'node_modules') continue;
    const p = path.join(dir, f);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`${rel(p)} is a symbolic link; the workflow does not deploy those`);
    if (st.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}
// sha256 over every file in the folder (path and content), plus supabase/functions/_shared if it exists, plus how it
// is deployed, so a change to any of them deploys it again
export function functionHash(name) {
  const parts = [];
  const dir = path.join(ROOT, 'supabase', 'functions', name);
  for (const f of walk(dir)) parts.push(`${name}/${f}\0${sha256(readFileSync(path.join(dir, f)))}\n`);
  const shared = path.join(ROOT, 'supabase', 'functions', '_shared');
  if (existsSync(shared)) for (const f of walk(shared)) parts.push(`_shared/${f}\0${sha256(readFileSync(path.join(shared, f)))}\n`);
  parts.push(`verify_jwt=${noVerifyJwt().has(name) ? 'off' : 'on'}\n`);
  return sha256(parts.join(''));
}
function checkFunctionList() {
  const errors = [];
  const warnings = [];
  const names = functionNames();
  const off = noVerifyJwt();
  for (const n of off) {
    if (!FUNCTION_RE.test(n)) errors.push({ file: NO_VERIFY_JWT_FILE, message: `"${n}" is not a pipeline-* function name` });
    else if (!names.includes(n)) errors.push({ file: NO_VERIFY_JWT_FILE, message: `${n} has no folder in supabase/functions` });
  }
  for (const n of names) {
    const dir = path.join(ROOT, 'supabase', 'functions', n);
    if (!existsSync(path.join(dir, 'index.ts'))) { errors.push({ file: `supabase/functions/${n}`, message: 'has no index.ts' }); continue; }
    const says = readFileSync(path.join(dir, 'index.ts'), 'utf8').includes('--no-verify-jwt');
    if (says && !off.has(n)) errors.push({ file: `supabase/functions/${n}/index.ts`, message: `says it is deployed with --no-verify-jwt, but ${n} is not in ${NO_VERIFY_JWT_FILE}` });
    try { functionHash(n); } catch (e) { errors.push({ file: `supabase/functions/${n}`, message: e.message }); }
  }
  if (existsSync(path.join(ROOT, 'supabase', 'config.toml'))) warnings.push({ file: 'supabase/config.toml', message: 'exists; the Supabase CLI reads it on every deploy (check it does not change how pipeline functions deploy)' });
  return { errors, warnings };
}
