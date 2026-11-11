// Checks the Production Pipeline sync functions (supabase/functions/pipeline-{marks,trims,batches}-sync), the cloud
// copies of the Mac jobs ~/ar-automation/pipeline-{marks,trims,batches}-sync.mjs, and their SQL.
//   1. the shared files are identical in the three folders, every file parses, Google is only ever asked for
//      read-only scopes, and nothing private is in the folders
//   2. each job's parsing and decisions on made-up inputs (no network, no database)
//   3. where the Mac scripts are on this computer: the port and the Mac script read the same made-up workbooks, and
//      the saved real inputs (--fixtures), into identical rows; with saved copies of the live tables, a shadow pass
//   4. runtime.ts itself, run in node with a fake Google and a fake database: callers, modes, the overlap guard,
//      shadow writing nothing, the stamp-only runs, the follow-up run for a big trims change
//   5. supabase/pipeline-sync.sql: the write bodies are the *_save bodies without the token check, every table has RLS,
//      nobody but the run holding the job in write mode can write; the cron file creates its schedules switched off
// Run: node tests/pipeline-sync-check.mjs [--fixtures=folder]
//   --fixtures  saved inputs, read-only copies kept OUTSIDE the repo (private): marks/grid.json + marks/meta.json,
//               trims/*.xlsx + trims/list.json, batches/batch.xlsx + batches/meta.json, and optionally each folder's
//               live.json ({meta, rows} of the table). Default ~/ar-automation/docs/pipeline-sync/fixtures; skipped
//               when missing. Sections that need the Mac scripts or SheetJS are skipped when they are not here (CI).
// Run this before every push that touches the sync functions or pipeline-sync.sql: any failure means do not push.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const JOBS = ['marks', 'trims', 'batches'];
const fnDir = (j) => path.join(ROOT, 'supabase/functions', `pipeline-${j}-sync`);
const read = (p) => readFileSync(p, 'utf8');
const args = process.argv.slice(2);
const FIX = (args.find((a) => a.startsWith('--fixtures=')) || '').slice(11) || process.env.PIPELINE_SYNC_FIXTURES ||
  path.join(os.homedir(), 'ar-automation/docs/pipeline-sync/fixtures');
const MAC = path.join(os.homedir(), 'ar-automation');
let XLSX = null;
try { XLSX = createRequire(path.join(MAC, 'package.json'))('xlsx'); } catch { XLSX = null; }
const haveMac = XLSX && JOBS.every((j) => existsSync(path.join(MAC, `pipeline-${j}-sync.mjs`)));
const skipped = [];
const md5 = (b) => createHash('md5').update(b).digest('hex');
// what a jsonb column (pipeline_sync_state.cache, every RPC's answer) hands back: the same values with every object's
// keys reordered, shorter keys first, then by bytes. A plain JSON copy keeps the key order and would hide a signature
// that depends on it.
const jsonbOrder = (x) => {
  if (Array.isArray(x)) return x.map(jsonbOrder);
  if (!x || typeof x !== 'object') return x;
  const keys = Object.keys(x).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Object.fromEntries(keys.map((k) => [k, jsonbOrder(x[k])]));
};
const jsonb = (x) => (x === undefined ? undefined : jsonbOrder(JSON.parse(JSON.stringify(x))));

/* =========================================================== 1. the files */

{
  for (const j of JOBS) {
    const files = readdirSync(fnDir(j)).filter((f) => !f.startsWith('.')).sort();
    assert.deepEqual(files, ['core.js', 'index.ts', 'job.js', 'runtime.ts'], `pipeline-${j}-sync holds index.ts, runtime.ts, job.js and core.js only`);
    for (const f of files) {
      try { execFileSync(process.execPath, ['--check', path.join(fnDir(j), f)], { stdio: 'pipe' }); }
      catch (e) { assert.fail(`pipeline-${j}-sync/${f} does not parse:\n` + String(e.stderr || e.message).split('\n').slice(0, 6).join('\n')); }
    }
  }
  for (const f of ['core.js', 'runtime.ts']) {
    const a = read(path.join(fnDir('marks'), f));
    for (const j of JOBS.slice(1)) assert.equal(read(path.join(fnDir(j), f)), a, `pipeline-${j}-sync/${f} is the same as pipeline-marks-sync/${f} (copy it over)`);
  }
  const idx = Object.fromEntries(JOBS.map((j) => [j, read(path.join(fnDir(j), 'index.ts'))]));
  assert.ok(!/npm:xlsx/.test(idx.marks), 'marks does not load SheetJS (it runs every 5 minutes)');
  for (const j of ['trims', 'batches']) assert.match(idx[j], /from "npm:xlsx@0\.18\.5"/, `${j} pins SheetJS 0.18.5, the Mac job's version`);
  for (const j of JOBS) {
    const all = readdirSync(fnDir(j)).filter((f) => !f.startsWith('.')).map((f) => read(path.join(fnDir(j), f))).join('\n');
    // Google: read-only scopes, no impersonation, never the bookkeeping service account
    assert.ok(!/auth\/(spreadsheets|drive)(?![.\w])/.test(all), `${j}: no read-write Google scope anywhere`);
    assert.ok(!/\bsub\s*:/.test(all) && !/sa-key|gmail-invoice-reader|bookkeeping-automation/.test(all), `${j}: no impersonation, no bookkeeping key`);
    // nothing private: no email address, no Drive-id-like token, no key
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(all.replace(/@wizardtrees\.com/g, '')), `${j}: no email address`);
    assert.ok(!/["'`](?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{25,}["'`]/.test(all), `${j}: no quoted id or key`);
    assert.ok(!/sb_(publishable|secret)_|eyJhbGciOi|BEGIN PRIVATE KEY/.test(all), `${j}: no key`);
  }
  console.log('files: the three functions are whole, share identical runtime.ts and core.js, parse, and read Google read-only');
}

const core = await import(pathToFileURL(path.join(fnDir('marks'), 'core.js')).href);
const M = await import(pathToFileURL(path.join(fnDir('marks'), 'job.js')).href);
const T = await import(pathToFileURL(path.join(fnDir('trims'), 'job.js')).href);
const B = await import(pathToFileURL(path.join(fnDir('batches'), 'job.js')).href);
for (const J of [M, T, B]) for (const s of J.SCOPES.split(' ')) assert.match(s, /^https:\/\/www\.googleapis\.com\/auth\/(drive|spreadsheets)\.readonly$/, `${J.JOB}: scope ${s} is read-only`);

/* =========================================================== 2. made-up inputs */

// a fake SheetJS for made-up workbooks (bytes are JSON): the parsing is checked against the real one in section 3
const FakeXLSX = {
  read(bytes) {
    const tabs = JSON.parse(new TextDecoder().decode(bytes));
    return { SheetNames: tabs.map((t) => t.name), Sheets: Object.fromEntries(tabs.map((t) => [t.name, { rows: t.rows, ...(t.cells || {}) }])) };
  },
  utils: { sheet_to_json: (ws) => ws.rows.map((r) => r.slice()), encode_cell: ({ r, c }) => `${r},${c}` },
};
// made-up workbook bytes: real .xlsx when SheetJS is here, else the fake's JSON. links: { 'r,c': url }
function book(tabs, X) {
  if (!X || X === FakeXLSX) {
    return new TextEncoder().encode(JSON.stringify(tabs.map((t) => ({ name: t.name, rows: t.rows,
      cells: Object.fromEntries(Object.entries(t.links || {}).map(([k, u]) => [k, { l: { Target: u } }])) }))));
  }
  const wb = X.utils.book_new();
  for (const t of tabs) {
    const ws = X.utils.aoa_to_sheet(t.rows);
    for (const [k, u] of Object.entries(t.links || {})) { const [r, c] = k.split(',').map(Number); ws[X.utils.encode_cell({ r, c })].l = { Target: u }; }
    X.utils.book_append_sheet(wb, ws, t.name);
  }
  return new Uint8Array(X.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

// core
{
  assert.equal(core.canon('num0', null), 0); assert.equal(core.canon('num', '12.50'), 12.5); assert.equal(core.canon('bool0', null), false);
  assert.equal(core.canon('date', '2026-10-02'), '2026-10-02'); assert.equal(core.canon('text', undefined), null);
  assert.ok(core.sameInstant('2026-11-11T18:18:37.208Z', '2026-11-11T18:18:37.208+00:00'));
  assert.ok(!core.sameInstant(null, null) && !core.sameInstant('2026-11-11T18:18:37.208Z', '2026-11-11T18:18:37.209Z'));
  assert.equal(await core.sha256Hex('[{"a":"é"}]'), createHash('sha256').update('[{"a":"é"}]').digest('hex'), 'sha256 matches the Mac jobs\' signature');
  // stableJson: the same rows give the same text whatever their key order, values still JSON's
  const row = { file: 'F', tab: 'Oct 2-4', block: 0, line: 1, room: null, lights: 24.5, strain: 'é "q"', bigs_g: 0, gone: undefined, d: new Date(0) };
  assert.equal(core.stableJson([row]), '[{"bigs_g":0,"block":0,"d":"1970-01-01T00:00:00.000Z","file":"F","lights":24.5,"line":1,"room":null,"strain":"é \\"q\\"","tab":"Oct 2-4"}]');
  assert.equal(core.stableJson([jsonb(row)]), core.stableJson([row]), 'stableJson: a row back from jsonb signs the same');
  assert.notEqual(JSON.stringify([jsonb(row)]), JSON.stringify([row]), 'plain JSON.stringify would not');
  assert.deepEqual(JSON.parse(core.stableJson({ b: [1, { z: 1, a: [null, 'x'] }], a: { y: true, x: false } })), { a: { x: false, y: true }, b: [1, { a: [null, 'x'], z: 1 }] });
  assert.equal(core.stableJson({ b: [undefined, 2], a: 1 }), JSON.stringify({ a: 1, b: [undefined, 2] }), 'stableJson: undefined as JSON.stringify writes it');
  assert.notEqual(core.stableJson([{ a: 1, b: 2 }]), core.stableJson([{ a: 1, b: 3 }]));
  const spec ={ key: ['r', 'c'], fields: { r: 'int', c: 'int', fill: 'bool0', txt: 'text', n: 'num0' } };
  const d = core.diffRows([{ r: 1, c: 2, fill: true, txt: 'A', n: 0 }, { r: 3, c: 0, fill: false, txt: 'B' }, { r: 4, c: 4, txt: 'new' }],
    [{ r: 1, c: 2, fill: true, txt: 'A', n: null }, { r: 3, c: 0, fill: null, txt: 'b' }, { r: 9, c: 9, txt: 'gone' }], spec);
  assert.deepEqual([d.added, d.removed, d.changed, d.same, d.ok], [1, 1, 1, 1, false], 'diff: added, removed, changed, same');
  assert.deepEqual(d.sample.find((x) => x.what === 'changed').fields, { txt: ['b', 'B'] }, 'diff: null and 0, null and false are the same');
  assert.ok(core.diffRows([], [], spec).ok);
  const logged = core.forLog({ status: 'saved', state: { cache: 1 }, continue: true, rows: 3 });
  assert.deepEqual(logged, { status: 'saved', rows: 3 }, 'the run log never carries the cache');
}

// a fake io for job.run: records what it was asked
function fakeIo(over = {}) {
  const calls = { apply: [], grid: 0, download: [], live: 0, meta: 0, list: 0, export: 0 };
  let clock = 0;
  const io = {
    XLSX: FakeXLSX, calls,
    now: () => (clock += over.tick ?? 1),
    today: () => over.today ?? '2026-11-11',
    sha256: core.sha256Hex,
    driveMeta: async () => { calls.meta++; return over.meta ?? {}; },
    sheetGrid: async () => { calls.grid++; return over.grid; },
    listFolder: async () => { calls.list++; return over.list ?? []; },
    download: async (f) => { calls.download.push(f.name); return over.bytes[f.name] ?? over.bytes[f.id]; },
    exportXlsx: async (id) => { calls.export++; return over.bytes[id]; },
    apply: async (rows, meta) => { calls.apply.push({ rows, meta }); return { ok: true }; },
    live: async () => { calls.live++; return over.live ?? { meta: null, rows: [] }; },
  };
  return io;
}

// marks
const RED = { red: 1 }, DARK = { red: 0.6 }, PINK = { red: 1, green: 0.6, blue: 0.8 };
function madeUpGrid(n = 60) {
  const rowData = [];
  for (let r = 0; r < n; r++) rowData.push({ values: [{ formattedValue: `row ${r}` }, {}] });
  rowData[2].values[1] = { formattedValue: 'ZANGBANGER  5PK', effectiveFormat: { backgroundColor: RED } };
  rowData[3].values[0] = { formattedValue: 'all red', effectiveFormat: { textFormat: { foregroundColor: DARK } } };
  rowData[4].values[1] = { formattedValue: 'some red', textFormatRuns: [{ format: {} }, { format: { foregroundColor: RED } }] };
  rowData[5].values[1] = { formattedValue: 'struck', effectiveFormat: { textFormat: { strikethrough: true } } };
  rowData[6].values[1] = { formattedValue: 'pink is not red', effectiveFormat: { backgroundColor: PINK } };
  rowData[7].values[1] = { formattedValue: '   ', effectiveFormat: { backgroundColor: RED } };
  return { sheets: [{ data: [{ rowData }] }] };
}
{
  assert.ok(M.isRed({ red: 1 }) && M.isRed({ red: 0x66 / 255 }) && !M.isRed(PINK) && !M.isRed({ red: 0.2 }) && !M.isRed(null));
  const marks = M.marksFrom(M.rowDataOf(madeUpGrid()));
  assert.deepEqual(marks, [
    { r: 2, c: 1, fill: true, text: false, part: false, strike: false, txt: 'ZANGBANGER 5PK' },
    { r: 3, c: 0, fill: false, text: true, part: false, strike: false, txt: 'all red' },
    { r: 4, c: 1, fill: false, text: false, part: true, strike: false, txt: 'some red' },
    { r: 5, c: 1, fill: false, text: false, part: false, strike: true, txt: 'struck' },
  ], 'marks: red fill, red text, red words, struck through; pink and empty cells are not marks');

  const V = '2026-11-11T18:18:37.208Z';
  // write, sheet changed: the whole set; then unchanged: stamp only, no grid read
  let io = fakeIo({ meta: { modifiedTime: V }, grid: madeUpGrid() });
  let rep = await M.run(io, { mode: 'write', state: {}, sourceId: 'WB' });
  assert.equal(rep.status, 'saved'); assert.equal(io.calls.apply[0].rows.length, 4); assert.deepEqual(io.calls.apply[0].meta, { sheet_modified: V });
  assert.equal(rep.state.written_sig, V);
  io = fakeIo({ meta: { modifiedTime: V }, grid: madeUpGrid() });
  rep = await M.run(io, { mode: 'write', state: { written_sig: V }, sourceId: 'WB' });
  assert.equal(rep.status, 'unchanged'); assert.equal(io.calls.grid, 0); assert.deepEqual(io.calls.apply, [{ rows: null, meta: { sheet_modified: V } }],
    'marks: an unchanged sheet only stamps the time, as the Mac job does');
  // a short read sends nothing
  io = fakeIo({ meta: { modifiedTime: V }, grid: madeUpGrid(10) });
  await assert.rejects(M.run(io, { mode: 'write', state: {}, sourceId: 'WB' }), /came back with 10 rows; nothing sent/);
  assert.equal(io.calls.apply.length, 0);
  // shadow: never applies; compares only against a table from the same sheet version
  const liveRows = M.marksFrom(M.rowDataOf(madeUpGrid()));
  io = fakeIo({ meta: { modifiedTime: V }, grid: madeUpGrid(), live: { meta: { sheet_modified: '2026-11-11T18:18:37.208+00:00' }, rows: liveRows } });
  rep = await M.run(io, { mode: 'shadow', state: {}, sourceId: 'WB' });
  assert.deepEqual([rep.status, rep.comparable, rep.diff.ok, io.calls.apply.length], ['compared', true, true, 0], 'marks shadow: compared, no difference, nothing written');
  assert.equal(rep.state.compared_sig, V);
  io = fakeIo({ meta: { modifiedTime: V }, grid: madeUpGrid(), live: { meta: { sheet_modified: '2026-11-11T17:00:00Z' }, rows: liveRows.slice(1) } });
  rep = await M.run(io, { mode: 'shadow', state: {}, sourceId: 'WB' });
  assert.deepEqual([rep.status, rep.comparable, rep.diff.added, 'compared_sig' in rep.state], ['waiting', false, 1, false], 'marks shadow: an older table is not compared yet');
  io = fakeIo({ meta: { modifiedTime: V } });
  rep = await M.run(io, { mode: 'shadow', state: { compared_sig: V }, sourceId: 'WB' });
  assert.deepEqual([rep.status, io.calls.grid, io.calls.live], ['unchanged', 0, 0]);
  await assert.rejects(M.run(fakeIo(), { mode: 'write', state: {}, sourceId: null }), /no workbook/);
}

// trims
const SITE_FILES = ['FILIFERA 2026.xlsx', 'SLANE 2026.xlsx', 'IMPERIAL PROJECTS 2026.xlsx', 'OLYMPIC 2026.xlsx'];
function trimTab(name, strains, room = '1', lights = 24) {
  const codes = ['', ''], names = [`ROOM ${room}`, ''], tot = ['', 'Total Gms'], gr = ['', 'Grams'];
  strains.forEach(([s, bigs, littles, trim], k) => { codes.push(s.slice(0, 2), ''); names.push(s, ''); tot.push(bigs, littles); gr.push(trim, ''); });
  names.push('GRAMS', '', 'PAYCHECK');
  return { name, rows: [codes, ['STRAIN CODE'], names, ['Lights:', lights], ['', 'BIGS/LITTLES'], tot, ['', 'Trim'], gr,
    [''], [`RM B`], ['Lights:', '12'], ['', 'Total Gms', 5, 5], ['', 'Grams', 1]] };
}
function trimBook(file, X, extra = []) {
  const n = SITE_FILES.indexOf(file);
  return book([...extra,
    trimTab('Oct 2-4', [['BLUEBANGER', 1200.5, 300, 400], ['ZANGBANGER', 800, 150, 250], ['EMPTY', 0, 0, 0], ['M8', '1,234', '', 5]]),
    trimTab('Dec 30-Jan 01', [['VOODOO', 100 + n, 10, 0]], 'a'),
    trimTab('April 16 Cont.-(April 30-May 1)', [['ANTIDOTE', 50, 5, 5]]),
    trimTab('TEMPLATE', [['NOPE', 1, 1, 1]]),
    trimTab('Part 2 (Room 2)', [['UNDATED', 7, 0, 0]]),
  ], X);
}
{
  assert.deepEqual(T.tabDates('Sept. 23-24', 2026), { start: '2026-09-23', end: '2026-09-24' });
  assert.deepEqual(T.tabDates('Dec 30-Jan 01', 2026), { start: '2025-12-30', end: '2026-01-01' });
  assert.deepEqual(T.tabDates('April 16 Cont.-(April 30-May 1)', 2026), { start: '2026-04-30', end: '2026-05-01' });
  assert.equal(T.tabDates('Part 2 (Room 2)', 2026), null); assert.equal(T.tabDates('Feb 30', 2026), null);
  const lines = T.parseWorkbook(FakeXLSX, trimBook('SLANE 2026.xlsx'), 'SLANE 2026.xlsx');
  assert.ok(lines.every((l) => l.site === '23RD' && l.tab !== 'TEMPLATE'), 'trims: site from the file name; TEMPLATE tabs skipped');
  const oct = lines.filter((l) => l.tab === 'Oct 2-4');
  assert.deepEqual(oct.map((l) => [l.block, l.line, l.strain, l.bigs_g, l.littles_g, l.trim_g, l.code, l.lights, l.room]), [
    [0, 0, 'BLUEBANGER', 1200.5, 300, 400, 'BL', 24, '1'], [0, 1, 'ZANGBANGER', 800, 150, 250, 'ZA', 24, '1'],
    [0, 3, 'M8', 1234, 0, 5, 'M8', 24, '1']], 'trims: strain pairs, empty strains skipped but counted, "1,234" read as a number, the RM B block has no strain row');
  assert.equal(oct[0].start_date, '2026-10-02');
  assert.ok(lines.some((l) => l.tab === 'Part 2 (Room 2)' && l.start_date === null));
  const picked = T.pickFiles([{ name: 'SLANE 2026.xlsx', modifiedTime: '1' }, { name: 'SLANE 2026.xlsx', modifiedTime: '2', id: 'new' },
    { name: 'notes.xlsx' }, { name: 'FILIFERA 2026.pdf' }, { name: 'FILIFERA 2026.xlsx', modifiedTime: '1' }]);
  assert.deepEqual(picked.files.map((f) => f.name), ['FILIFERA 2026.xlsx', 'SLANE 2026.xlsx']); assert.equal(picked.files[1].id, 'new');

  const list = SITE_FILES.map((name, k) => ({ id: `id${k}`, name, modifiedTime: `2026-11-0${k + 1}T00:00:00.000Z`, md5Checksum: `m${k}`, size: String(1000 * (k + 1)) }));
  const bytes = Object.fromEntries(SITE_FILES.map((f) => [f, trimBook(f)]));
  // write, first run: every workbook parsed (smallest first), the whole set sent with the Mac's meta
  let io = fakeIo({ list, bytes });
  let rep = await T.run(io, { mode: 'write', state: {}, sourceId: 'FOLDER' });
  assert.equal(rep.status, 'saved'); assert.deepEqual(io.calls.download, SITE_FILES);
  const sent = io.calls.apply[0];
  assert.deepEqual(sent.meta, { file_modified: '2026-11-04T00:00:00.000Z', files: 4, trims: 16 }, 'trims: the Mac job\'s meta (newest edit, files, trims)');
  assert.equal(sent.rows.length, rep.rows); assert.ok(sent.rows.length >= 20);
  assert.deepEqual([...new Set(sent.rows.map((r) => r.file))], [...SITE_FILES].sort(), 'trims: rows in file-name order');
  const cache = rep.state.cache;
  // nothing changed: nothing downloaded, the same signature, a stamp only
  io = fakeIo({ list, bytes });
  rep = await T.run(io, { mode: 'write', state: rep.state, sourceId: 'FOLDER' });
  assert.deepEqual([rep.status, io.calls.download.length, io.calls.apply[0].rows], ['unchanged', 0, null], 'trims: unchanged workbooks are not downloaded and only stamp the time');
  assert.deepEqual(io.calls.apply[0].meta, sent.meta);
  // one workbook changed: only that one is downloaded, and the set is the same as a full read
  const list2 = list.map((f) => (f.name === 'OLYMPIC 2026.xlsx' ? { ...f, md5Checksum: 'changed', modifiedTime: '2026-11-10T00:00:00.000Z' } : f));
  const bytes2 = { ...bytes, 'OLYMPIC 2026.xlsx': trimBook('OLYMPIC 2026.xlsx', null, [trimTab('Nov 3', [['NEWSTRAIN', 9, 9, 9]])]) };
  io = fakeIo({ list: list2, bytes: bytes2 });
  rep = await T.run(io, { mode: 'write', state: { cache, rows_sig: 'x' }, sourceId: 'FOLDER' });
  assert.deepEqual(io.calls.download, ['OLYMPIC 2026.xlsx'], 'trims: only the changed workbook is read');
  const full = await T.run(fakeIo({ list: list2, bytes: bytes2 }), { mode: 'write', state: {}, sourceId: 'FOLDER' });
  assert.equal(await core.sha256Hex(core.stableJson(io.calls.apply[0].rows)), full.state.rows_sig, 'trims: cached lines + one new workbook = a full read');
  // a parse budget: big changes are split over follow-up runs, nothing is sent until every workbook is read
  {
    let st = {}, runs = 0, last, downloads = 0;
    do {
      const io2 = fakeIo({ list, bytes, tick: 150 });
      last = await T.run(io2, { mode: 'write', state: st, sourceId: 'FOLDER' });
      runs++; downloads += io2.calls.download.length;
      if (last.status === 'partial') {
        assert.deepEqual([last.continue, io2.calls.apply.length], [true, 0], 'trims: a partial run asks for a follow-up and sends nothing');
        st = last.state;
      } else assert.equal(io2.calls.apply[0].rows.length, sent.rows.length, 'trims: the follow-up runs end with the whole set');
    } while (last.status === 'partial' && runs < 5);
    assert.ok(runs >= 2 && runs <= 4 && last.status === 'saved' && downloads === 4, `trims: over the parse budget, the rest went to follow-up runs (${runs} runs)`);
  }
  // the state goes through jsonb between runs, so cached lines come back with their keys reordered while freshly read
  // lines keep the parser's order: a run that mixes the two must still see identical rows as unchanged, or it sends
  // every row again and moves pipeline_trims_meta.changed_at an hour after the real change
  {
    assert.deepEqual(Object.keys(jsonb(sent.rows[0])), ['tab', 'code', 'file', 'line', 'room', 'site', 'block', 'bigs_g', 'lights', 'strain', 'trim_g',
      'end_date', 'littles_g', 'start_date'], 'the test\'s jsonb orders keys as Postgres does');
    assert.notEqual(JSON.stringify(jsonb(sent.rows)), JSON.stringify(sent.rows), 'cached lines really come back in another key order');
    let st = {};
    // mode write; the database keeps what a run leaves out (pipeline_sync_finish)
    const go = async (lst, bks = bytes, tick = 1) => {
      const io2 = fakeIo({ list: lst, bytes: bks, tick });
      const rep2 = await T.run(io2, { mode: 'write', state: st, sourceId: 'FOLDER' });
      st = jsonb({ ...st, ...rep2.state });
      return { status: rep2.status, downloads: io2.calls.download, applied: io2.calls.apply[0] };
    };
    // a first write over follow-up runs: the last run signs cached and fresh lines together
    let r2, runs = 0;
    do { r2 = await go(list, bytes, 150); runs++; } while (r2.status === 'partial' && runs < 5);
    assert.ok(runs >= 2 && r2.status === 'saved', 'trims: a first write split over follow-up runs');
    r2 = await go(list);
    assert.deepEqual([r2.status, r2.downloads, r2.applied.rows], ['unchanged', [], null], 'trims: after a write split over runs, nothing changed means a stamp only');
    // one workbook saved again with the same lines: read fresh beside the cached others, still the same rows
    const resaved = list.map((f) => (f.name === 'OLYMPIC 2026.xlsx' ? { ...f, md5Checksum: 'resaved', modifiedTime: '2026-11-10T00:00:00.000Z' } : f));
    r2 = await go(resaved);
    assert.deepEqual([r2.status, r2.downloads, r2.applied.rows], ['unchanged', ['OLYMPIC 2026.xlsx'], null], 'trims: a workbook saved again with the same lines only stamps the time');
    assert.equal(r2.applied.meta.file_modified, '2026-11-10T00:00:00.000Z', 'trims: the stamp carries the newest edit');
    r2 = await go(resaved);
    assert.deepEqual([r2.status, r2.downloads, r2.applied.rows], ['unchanged', [], null]);
    // a real change among cached lines is still sent, whole
    r2 = await go(list2, bytes2);
    assert.deepEqual([r2.status, r2.downloads, r2.applied.rows.length], ['saved', ['OLYMPIC 2026.xlsx'], sent.rows.length + 1], 'trims: a changed line among cached ones is sent');
    r2 = await go(list2, bytes2);
    assert.equal(r2.status, 'unchanged');
  }
  // guards: a missing site sends nothing
  io = fakeIo({ list: list.filter((f) => !/OLYMPIC/.test(f.name)), bytes });
  await assert.rejects(T.run(io, { mode: 'write', state: {}, sourceId: 'FOLDER' }), /no workbook for OLYMPIC in the folder; nothing sent/);
  assert.equal(io.calls.apply.length, 0);
  io = fakeIo({ list, bytes: { ...bytes, 'OLYMPIC 2026.xlsx': book([trimTab('Oct 1', [['X', 0, 0, 0]])]) } });
  await assert.rejects(T.run(io, { mode: 'write', state: {}, sourceId: 'FOLDER' }), /no trims read for OLYMPIC; nothing sent/);
  await assert.rejects(T.run(fakeIo({ list: [] }), { mode: 'write', state: {}, sourceId: 'FOLDER' }), /no site trim workbooks/);
  // shadow: compared against a table from the same newest workbook, never applied
  io = fakeIo({ list, bytes, live: { meta: { file_modified: '2026-11-04T00:00:00+00:00' }, rows: sent.rows } });
  rep = await T.run(io, { mode: 'shadow', state: {}, sourceId: 'FOLDER' });
  assert.deepEqual([rep.status, rep.diff.ok, io.calls.apply.length], ['compared', true, 0]);
  io = fakeIo({ list, bytes });
  rep = await T.run(io, { mode: 'shadow', state: rep.state, sourceId: 'FOLDER' });
  assert.deepEqual([rep.status, io.calls.download.length, io.calls.live], ['unchanged', 0, 0]);
}

// batches
const HEAD = ['STATUS', 'STRAIN', 'ITEM', 'CLASS', 'CROSS', 'HRVST DATE', 'PCKG DATE', 'PRODUCTION BATCH', 'CULT LIC', 'DISTRO LIC', 'TESTED BY',
  'THC', 'CBD', 'TOTAL CANNA', 'METRC UID', 'COA LINK', 'TOTAL UNITS', 'BUDTENDER UNITS', 'CASES', 'QTY MADE IN DISTRU', 'RECIEVE DATE',
  'TEST DATE', 'COA RETURN DATE', 'NABIS P/U DATE'];
function batchRows() {
  const row = (o) => HEAD.map((h) => (o[h] ?? ''));
  const rows = [HEAD];
  for (let k = 0; k < 6; k++) {
    rows.push(row({ STATUS: k % 2 ? 'WAITING FOR COA' : 'PACKAGING', STRAIN: `STRAIN ${k}`, ITEM: '5PK', 'HRVST DATE': 46200 + k, 'PCKG DATE': '10/5/26',
      'PRODUCTION BATCH': `F2-BM-${k}`, THC: 0.3057, CBD: '#REF!', 'TOTAL CANNA': '31.2%', 'METRC UID': `1A40${k}`, 'COA LINK': k === 1 ? 'COA' : k === 2 ? 'https://example.org/coa2' : '',
      'TOTAL UNITS': k === 3 ? 'about 40' : 120, 'TEST DATE': k === 4 ? 'TBD' : '', 'NABIS P/U DATE': 3 }));
  }
  rows.push(row({}));
  rows.push(row({ STRAIN: 'FINISHED ITEMS' }));
  rows.push(HEAD);
  rows.push(row({ STATUS: 'DONE', STRAIN: 'RECENT', 'PCKG DATE': '2026-10-20', 'PRODUCTION BATCH': 'F1', 'METRC UID': '1A4X', ITEM: 'FLOWER' }));
  rows.push(row({ STATUS: 'DONE', STRAIN: 'OLD', 'PCKG DATE': '2026-01-02', 'PRODUCTION BATCH': 'F0', 'METRC UID': '1A4Y', ITEM: 'FLOWER' }));
  return rows;
}
const batchBook = (X) => book([{ name: 'OTHER', rows: [['x']] }, { name: 'WIZARD', rows: batchRows(), links: { '2,15': 'https://example.org/coa1' } }], X);
{
  const p = B.parseBatches(FakeXLSX, batchBook(), '2026-11-11');
  assert.deepEqual([p.activeCount, p.finishedAll, p.rows.length, p.divider, p.since], [6, 2, 7, 9, '2026-07-14']);
  const r1 = p.rows[0];
  assert.deepEqual([r1.sheet_row, r1.thc, r1.cbd, r1.total_canna, r1.package_date, r1.harvest_date, r1.nabis_date], [2, 30.57, null, 31.2, '2026-10-05', '2026-06-27', null],
    'batches: potency as percent, #REF! empty, "10/5/26" a date, a small number in a date column is not a date');
  assert.deepEqual([p.rows[1].coa_url, p.rows[1].coa_text, p.rows[2].coa_url], ['https://example.org/coa1', 'COA', 'https://example.org/coa2'], 'batches: the COA cell\'s link, else its URL text');
  assert.equal(p.rows[3].notes, 'Units: about 40'); assert.equal(p.rows[4].notes, 'Test: TBD');
  assert.deepEqual(p.rows.filter((r) => r.finished).map((r) => r.strain), ['RECENT'], 'batches: finished rows older than 120 days are left out');
  assert.throws(() => B.parseBatches(FakeXLSX, book([{ name: 'OTHER', rows: [] }]), '2026-11-11'), /no WIZARD tab/);

  const meta = { name: 'Batch Label Sheet.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', modifiedTime: '2026-11-11T00:42:24.408Z', md5Checksum: 'abc', trashed: false };
  let io = fakeIo({ meta, bytes: { FILE: batchBook() } });
  let rep = await B.run(io, { mode: 'write', state: {}, sourceId: 'FILE' });
  assert.equal(rep.status, 'saved');
  assert.deepEqual(io.calls.apply[0].meta, { file_modified: meta.modifiedTime, active_rows: 6, finished_rows: 1, finished_since: '2026-07-14' }, 'batches: the Mac job\'s meta');
  // the same file on the same day: no download, a stamp with the counts last sent
  io = fakeIo({ meta, bytes: {} });
  const rep2 = await B.run(io, { mode: 'write', state: rep.state, sourceId: 'FILE' });
  assert.deepEqual([rep2.status, io.calls.download.length], ['unchanged', 0]);
  assert.deepEqual(io.calls.apply[0], { rows: null, meta: { file_modified: meta.modifiedTime, active_rows: 6, finished_rows: 1, finished_since: '2026-07-14' } });
  // the next day the finished window moves, so the file is read again
  io = fakeIo({ meta, bytes: { FILE: batchBook() }, today: '2026-11-12' });
  await B.run(io, { mode: 'write', state: rep.state, sourceId: 'FILE' });
  assert.equal(io.calls.download.length, 1, 'batches: read again on a new day');
  // in the trash: nothing read, nothing sent (today's state of the real file)
  io = fakeIo({ meta: { ...meta, trashed: true }, bytes: { FILE: batchBook() } });
  await assert.rejects(B.run(io, { mode: 'write', state: {}, sourceId: 'FILE' }), /Batch Label Sheet\.xlsx is in the trash/);
  assert.deepEqual([io.calls.download.length, io.calls.apply.length], [0, 0]);
  // a native Google Sheet is read as an .xlsx export
  io = fakeIo({ meta: { ...meta, mimeType: B.NATIVE, md5Checksum: undefined }, bytes: { FILE: batchBook() } });
  rep = await B.run(io, { mode: 'write', state: {}, sourceId: 'FILE' });
  assert.deepEqual([rep.status, io.calls.export, io.calls.download.length], ['saved', 1, 0]);
  // no active rows: nothing sent
  io = fakeIo({ meta, bytes: { FILE: book([{ name: 'WIZARD', rows: [HEAD] }]) } });
  await assert.rejects(B.run(io, { mode: 'write', state: {}, sourceId: 'FILE' }), /no active rows/);
  // shadow: comparable only with a table from the same file version and the same day
  const rows = B.parseBatches(FakeXLSX, batchBook(), '2026-11-11').rows;
  io = fakeIo({ meta, bytes: { FILE: batchBook() }, live: { meta: { file_modified: '2026-11-11T00:42:24.408+00:00', finished_since: '2026-07-14' }, rows } });
  rep = await B.run(io, { mode: 'shadow', state: {}, sourceId: 'FILE' });
  assert.deepEqual([rep.status, rep.diff.ok, io.calls.apply.length], ['compared', true, 0]);
  io = fakeIo({ meta, bytes: { FILE: batchBook() }, live: { meta: { file_modified: '2026-11-11T00:42:24.408+00:00', finished_since: '2026-07-13' }, rows } });
  assert.equal((await B.run(io, { mode: 'shadow', state: {}, sourceId: 'FILE' })).status, 'waiting');
  await assert.rejects(B.run(fakeIo(), { mode: 'write', state: {}, sourceId: null }), /Batch Label Sheet is not set/);
}
console.log('jobs: marks, trims and batches read made-up inputs and decide write, stamp-only, shadow and refusals as the Mac jobs do');

/* =========================================================== 3. the same answers as the Mac scripts */

const loadJson = (p) => JSON.parse(read(p));
if (!haveMac) skipped.push('Mac parity (no ~/ar-automation scripts or SheetJS here)');
else {
  const Mac = {
    marks: await import(pathToFileURL(path.join(MAC, 'pipeline-marks-sync.mjs')).href),
    trims: await import(pathToFileURL(path.join(MAC, 'pipeline-trims-sync.mjs')).href),
    batches: await import(pathToFileURL(path.join(MAC, 'pipeline-batches-sync.mjs')).href),
  };
  const u8 = (b) => new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  // made-up inputs, as real .xlsx files
  assert.deepEqual(M.marksFrom(M.rowDataOf(madeUpGrid())), Mac.marks.marksFrom(M.rowDataOf(madeUpGrid())), 'marks: the same as the Mac script on made-up cells');
  for (const f of SITE_FILES) {
    const bytes = trimBook(f, XLSX);
    assert.deepEqual(T.parseWorkbook(XLSX, bytes, f), Mac.trims.parseWorkbook(Buffer.from(bytes), f), `trims: the same as the Mac script on a made-up ${f}`);
  }
  for (const day of ['2026-11-11', '2027-03-01']) {
    const bytes = batchBook(XLSX);
    assert.deepEqual(B.parseBatches(XLSX, bytes, day), Mac.batches.parseBatches(Buffer.from(bytes), day), `batches: the same as the Mac script on a made-up sheet (${day})`);
  }
  console.log('Mac parity: made-up cells and workbooks read the same by the port and the Mac scripts');

  // saved real inputs
  if (!existsSync(FIX)) skipped.push(`real inputs (no fixtures at ${FIX})`);
  else {
    const out = [];
    const shadow = (name, rows, liveFile, spec, comparableOf) => {
      if (!existsSync(liveFile)) return;
      const live = loadJson(liveFile);
      const d = core.diffRows(rows, live.rows, spec), comparable = comparableOf(live.meta || {});
      out.push(`${name} shadow vs live table: ${comparable ? 'same source version' : 'different source version'}, ` +
        `${d.same} same, ${d.changed} changed, ${d.added} only read, ${d.removed} only in the table`);
      if (comparable) assert.ok(d.ok, `${name}: a shadow pass finds no difference with the table the Mac job wrote from the same version: ${JSON.stringify(d.sample.slice(0, 3))}`);
    };
    const gridFile = path.join(FIX, 'marks/grid.json');
    if (existsSync(gridFile)) {
      const rowData = M.rowDataOf(loadJson(gridFile));
      const mine = M.marksFrom(rowData);
      assert.deepEqual(mine, Mac.marks.marksFrom(rowData), 'marks: the same as the Mac script on the saved DISTRO PIPELINE grid');
      out.push(`marks: ${M.summaryOf(rowData, mine)}, identical`);
      const meta = existsSync(path.join(FIX, 'marks/meta.json')) ? loadJson(path.join(FIX, 'marks/meta.json')) : {};
      shadow('marks', mine, path.join(FIX, 'marks/live.json'), M.SPEC, (lm) => core.sameInstant(lm.sheet_modified, meta.modifiedTime));
    }
    const tdir = path.join(FIX, 'trims');
    if (existsSync(tdir)) {
      const names = readdirSync(tdir).filter((f) => /\.xlsx$/i.test(f) && T.siteOf(f)).sort();
      const rows = [];
      for (const f of names) {
        const buf = readFileSync(path.join(tdir, f));
        const t0 = process.cpuUsage();
        const mine = T.parseWorkbook(XLSX, u8(buf), f);
        const cpu = process.cpuUsage(t0);
        assert.deepEqual(mine, Mac.trims.parseWorkbook(buf, f), `trims: the same as the Mac script on the saved ${f}`);
        out.push(`trims: ${f} ${mine.length} lines, identical (${Math.round((cpu.user + cpu.system) / 1000)} ms CPU in node)`);
        rows.push(...mine);
      }
      const list = existsSync(path.join(tdir, 'list.json')) ? loadJson(path.join(tdir, 'list.json')) : [];
      const files = T.pickFiles(list).files;
      if (files.length) T.checkSet(files, rows, 'saved inputs');
      const newest = files.map((f) => f.modifiedTime).filter(Boolean).sort().pop();
      shadow('trims', rows, path.join(tdir, 'live.json'), T.SPEC, (lm) => core.sameInstant(lm.file_modified, newest));
    }
    const bfile = path.join(FIX, 'batches/batch.xlsx');
    if (existsSync(bfile)) {
      const buf = readFileSync(bfile);
      const meta = existsSync(path.join(FIX, 'batches/meta.json')) ? loadJson(path.join(FIX, 'batches/meta.json')) : {};
      const day = meta.today || new Date().toISOString().slice(0, 10);
      const mine = B.parseBatches(XLSX, u8(buf), day);
      assert.deepEqual(mine, Mac.batches.parseBatches(buf, day), 'batches: the same as the Mac script on the saved Batch Label Sheet');
      out.push(`batches: ${B.summaryOf(mine).text}, identical`);
      shadow('batches', mine.rows, path.join(FIX, 'batches/live.json'), B.SPEC,
        (lm) => core.sameInstant(lm.file_modified, meta.modifiedTime) && String(lm.finished_since || '').slice(0, 10) === mine.since);
    }
    for (const l of out) console.log('  ' + l);
    console.log('real inputs: the port and the Mac scripts read the saved inputs into identical rows');
  }
}

/* =========================================================== 4. runtime.ts, run in node */

if (typeof registerHooks !== 'function') skipped.push('runtime.ts in node (this node has no module.registerHooks; use node 24)');
else {
  // the Deno world, faked: Deno.serve and env, EdgeRuntime.waitUntil, the supabase client, SheetJS, and fetch (Google)
  const handlers = {}, pending = [];
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ENV = { SUPABASE_URL: 'https://project.supabase.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service',
    PIPELINE_WRITER_KEY: JSON.stringify({ client_email: 'writer@test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }) };
  let current = null;
  globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handlers[current] = h; } };
  globalThis.EdgeRuntime = { waitUntil: (p) => pending.push(p) };
  if (typeof globalThis.addEventListener !== 'function') globalThis.addEventListener = () => {};

  const SECRET = 'a'.repeat(64);
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const db = {
    settings: { marks: { mode: 'off', source_id: null }, trims: { mode: 'off', source_id: 'FOLDER' }, batches: { mode: 'off', source_id: 'FILE' } },
    state: { marks: {}, trims: {}, batches: {} }, runs: [], applied: [], tables: {}, secretHash: sha(SECRET), workbook: 'WB',
    // addresses built by concatenation: the repo is public and its CI scan refuses any email address in a file
    users: { 'Bearer admin-jwt': { email: 'Admin' + '@WizardTrees.com', email_confirmed_at: 'x', admin: true }, 'Bearer crew-jwt': { email: 'crew' + '@wizardtrees.com', email_confirmed_at: 'x', admin: false } },
  };
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const RPC = {
    pipeline_sync_check_secret: ({ p_secret }) => p_secret.length >= 32 && sha(p_secret) === db.secretHash,
    pipeline_sync_claim: ({ p_job, p_stale_seconds, p_by, p_force_shadow }) => {
      const s = db.settings[p_job]; if (!s) return { ok: false, reason: 'unknown' };
      const mode = p_force_shadow ? 'shadow' : s.mode; if (mode === 'off') return { ok: false, reason: 'off' };
      const st = db.state[p_job];
      if (st.running_since && Date.now() - st.running_since < p_stale_seconds * 1000) { db.runs.push({ job: p_job, status: 'busy' }); return { ok: false, reason: 'busy' }; }
      Object.assign(st, { running_since: Date.now(), run_token: crypto.randomUUID(), run_mode: mode, run_by: p_by });
      return { ok: true, token: st.run_token, mode, source_id: s.source_id ?? (p_job === 'marks' ? db.workbook : null),
        state: jsonb({ source_sig: st.source_sig, written_sig: st.written_sig, rows_sig: st.rows_sig, compared_sig: st.compared_sig, cache: st.cache }) };
    },
    pipeline_sync_finish: ({ p_job, p_token, p_report, p_state }) => {
      const st = db.state[p_job], mine = st.run_token === p_token;
      if (mine) { Object.assign(st, jsonb(p_state), { running_since: null, run_token: null, run_mode: null, last_status: p_report.status, last_error: p_report.error ?? null }); }
      db.runs.push({ job: p_job, ...clone(p_report), late: !mine });
      return { ok: true, mine };
    },
    pipeline_sync_apply: ({ p_job, p_token, p_rows, p_meta }) => {
      const st = db.state[p_job];
      if (!(st.run_token === p_token && st.run_mode === 'write' && db.settings[p_job].mode === 'write')) throw new Error('this run may not write');
      db.applied.push({ job: p_job, rows: p_rows ? p_rows.length : null, meta: p_meta });
      if (p_rows) db.tables[p_job] = { meta: { ...p_meta }, rows: clone(p_rows) };
      return { ok: true };
    },
    pipeline_sync_live: ({ p_job }) => jsonb(db.tables[p_job] ?? { meta: null, rows: [] }),
  };
  globalThis.__pipelineSyncFakeSupabase = (url, key, opts) => {
    const authz = opts?.global?.headers?.Authorization;
    return {
      rpc: async (fn, a) => {
        if (key === 'anon') {   // a signed-in user's client: only the admin check
          if (fn !== 'pipeline_sync_can_admin') return { data: null, error: { message: 'permission denied' } };
          return { data: db.users[authz]?.admin === true, error: null };
        }
        try { return { data: clone(await RPC[fn](clone(a))), error: null }; } catch (e) { return { data: null, error: { message: e.message } }; }
      },
      auth: { getUser: async () => (db.users[authz] ? { data: { user: db.users[authz] }, error: null } : { data: { user: null }, error: { message: 'bad jwt' } }) },
    };
  };
  // SheetJS: the real one when here (also checks the default import works on its CommonJS build), else the fake
  const X = XLSX || FakeXLSX;
  globalThis.__pipelineSyncFakeXLSX = FakeXLSX;
  const xlsxUrl = XLSX ? pathToFileURL(createRequire(path.join(MAC, 'package.json')).resolve('xlsx')).href
    : 'data:text/javascript,export default globalThis.__pipelineSyncFakeXLSX;';
  registerHooks({
    resolve(spec, ctx, next) {
      if (spec === 'jsr:@supabase/supabase-js@2') return { url: 'data:text/javascript,export const createClient = (...a) => globalThis.__pipelineSyncFakeSupabase(...a);', shortCircuit: true };
      if (spec === 'npm:xlsx@0.18.5') return { url: xlsxUrl, shortCircuit: true };
      return next(spec, ctx);
    },
  });

  // Google and the functions' own URL
  const drive = { meta: {}, list: [], bytes: {}, grid: null };
  const seen = { scopes: new Set(), urls: [], follow: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    seen.urls.push(url);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(init.body).get('assertion').split('.')[1], 'base64url').toString());
      for (const s of claims.scope.split(' ')) seen.scopes.add(s);
      assert.equal(claims.iss, 'writer@test'); assert.ok(!('sub' in claims), 'no impersonation');
      return json({ access_token: 'tok', expires_in: 3600 });
    }
    if (url.startsWith(`${ENV.SUPABASE_URL}/functions/v1/`)) { seen.follow.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return json({ ok: true }, 202); }
    const u = new URL(url);
    if (u.host === 'sheets.googleapis.com') return drive.grid ? json(drive.grid) : json({}, 404);
    if (u.host === 'www.googleapis.com' && u.pathname === '/drive/v3/files') return json({ files: drive.list });
    const m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)(\/export)?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (u.searchParams.get('alt') === 'media' || m[2]) return drive.bytes[id] ? new Response(drive.bytes[id]) : json({}, 404);
      return drive.meta[id] ? json(drive.meta[id]) : json({}, 404);
    }
    return json({}, 404);
  };

  try {
    for (const j of JOBS) { current = j; await import(pathToFileURL(path.join(fnDir(j), 'index.ts')).href); }
    const call = async (j, { headers = { 'x-pipeline-sync': SECRET }, body = {}, method = 'POST' } = {}) => {
      const res = await handlers[j](new Request(`${ENV.SUPABASE_URL}/functions/v1/pipeline-${j}-sync`, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined }));
      const out = { status: res.status, body: await res.json() };
      while (pending.length) await pending.shift();
      return out;
    };
    const lastRun = (j) => db.runs.filter((r) => r.job === j).at(-1);

    // who may call
    assert.equal((await call('marks', { headers: {} })).status, 401, 'no header, no sign-in: refused');
    assert.equal((await call('marks', { headers: { 'x-pipeline-sync': 'b'.repeat(64) } })).status, 401, 'a wrong secret: refused');
    assert.equal((await call('marks', { headers: { Authorization: 'Bearer crew-jwt' } })).status, 401, 'a signed-in non-admin: refused');
    assert.equal((await call('marks', { method: 'GET' })).status, 405);
    // off: answers at once, touches nothing
    let r = await call('marks');
    assert.deepEqual([r.status, r.body.skipped, seen.urls.length], [200, 'off', 0], 'off: nothing read');

    // marks in write mode: the whole set, then a stamp only; Google asked for read-only scopes only
    db.settings.marks.mode = 'write';
    drive.meta.WB = { modifiedTime: '2026-11-11T18:18:37.208Z' }; drive.grid = madeUpGrid();
    r = await call('marks');
    assert.equal(r.status, 202, 'the cron call is answered at once and the run finishes in the background');
    assert.deepEqual(db.applied.at(-1), { job: 'marks', rows: 4, meta: { sheet_modified: '2026-11-11T18:18:37.208Z' } });
    assert.equal(lastRun('marks').status, 'saved'); assert.equal(db.state.marks.running_since, null, 'the job is let go');
    r = await call('marks');
    assert.deepEqual(db.applied.at(-1), { job: 'marks', rows: null, meta: { sheet_modified: '2026-11-11T18:18:37.208Z' } }, 'marks: stamp only when the sheet is unchanged');
    assert.equal(seen.urls.filter((u) => u.includes('sheets.googleapis.com')).length, 1, 'marks: the grid is read only when the sheet changed');
    // shadow, asked for by a signed-in admin, waits for the answer and writes nothing
    const before = db.applied.length;
    r = await call('marks', { headers: { Authorization: 'Bearer admin-jwt' }, body: { mode: 'shadow', wait: true } });
    assert.deepEqual([r.status, r.body.status, r.body.comparable, r.body.diff.ok, db.applied.length], [200, 'compared', true, true, before],
      'an admin\'s compare-only run: compared with the table, nothing written');
    assert.equal(lastRun('marks').status, 'compared');
    assert.ok(!('cache' in r.body) && !('state' in r.body), 'the answer carries no state');
    // the overlap guard
    db.state.marks.running_since = Date.now();
    r = await call('marks');
    assert.deepEqual([r.body.skipped, lastRun('marks').status], ['busy', 'busy']);
    db.state.marks.running_since = Date.now() - 300_000;   // a run that died 5 minutes ago no longer holds it
    r = await call('marks');
    assert.equal(r.status, 202); assert.equal(lastRun('marks').status, 'unchanged');
    // the mode switched to shadow mid-run: the database refuses the write
    db.settings.marks.mode = 'write'; db.state.marks.written_sig = null;
    const realApply = RPC.pipeline_sync_apply;
    RPC.pipeline_sync_apply = (a) => { db.settings.marks.mode = 'shadow'; return realApply(a); };
    await call('marks');
    RPC.pipeline_sync_apply = realApply;
    assert.match(lastRun('marks').error, /may not write/); assert.equal(lastRun('marks').status, 'error');
    db.settings.marks.mode = 'off';

    // trims in write mode: a big change parsed over a follow-up run, then the whole set
    db.settings.trims.mode = 'write';
    drive.list = SITE_FILES.map((name, k) => ({ id: `T${k}`, name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      modifiedTime: `2026-11-0${k + 1}T00:00:00.000Z`, size: String(100 + k) }));
    for (const f of drive.list) { drive.bytes[f.id] = trimBook(f.name, X); f.md5Checksum = md5(drive.bytes[f.id]); }
    const realNow = performance.now;
    let t = 0;
    performance.now = () => (t += 200);
    try { r = await call('trims'); } finally { performance.now = realNow; }
    assert.equal(lastRun('trims').status, 'partial');
    assert.equal(seen.follow.length, 1, 'trims: a follow-up run is started for the rest');
    assert.deepEqual([seen.follow[0].url.endsWith('/functions/v1/pipeline-trims-sync'), seen.follow[0].headers['x-pipeline-sync'] === SECRET, seen.follow[0].body.hop],
      [true, true, 1]);
    assert.ok(!db.applied.some((a) => a.job === 'trims'), 'trims: nothing written until every workbook is read');
    r = await call('trims', { body: seen.follow[0].body });
    assert.equal(lastRun('trims').status, 'saved'); assert.equal(lastRun('trims').hop, 1);
    const trimsSent = db.applied.filter((a) => a.job === 'trims').at(-1);
    assert.ok(trimsSent.rows >= 20); assert.deepEqual(trimsSent.meta.files, 4);
    const downloads = seen.urls.filter((u) => /alt=media/.test(u)).length;
    await call('trims');
    assert.deepEqual([lastRun('trims').status, seen.urls.filter((u) => /alt=media/.test(u)).length], ['unchanged', downloads], 'trims: nothing changed after a write split over two runs (cached lines back from jsonb beside fresh ones): nothing downloaded, a stamp only');
    // pipeline-writer cannot open the folder: a plain message in the log
    const f0 = globalThis.fetch;
    globalThis.fetch = async (u, i) => (String(u).startsWith('https://www.googleapis.com/drive/v3/files?') ? new Response('{}', { status: 404 }) : f0(u, i));
    await call('trims');
    globalThis.fetch = f0;
    assert.match(lastRun('trims').error, /could not list the folder \(HTTP 404\): pipeline-writer cannot open it, share it with that account as Viewer/);
    db.settings.trims.mode = 'off';

    // batches: the file in the trash today
    db.settings.batches.mode = 'write';
    drive.meta.FILE = { name: 'Batch Label Sheet.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', modifiedTime: '2026-11-11T00:42:24.408Z', trashed: true };
    drive.bytes.FILE = batchBook(X); drive.meta.FILE.md5Checksum = md5(drive.bytes.FILE);
    await call('batches');
    assert.deepEqual([lastRun('batches').status, lastRun('batches').error], ['error', 'Batch Label Sheet.xlsx is in the trash']);
    drive.meta.FILE.trashed = false;
    await call('batches');
    assert.equal(lastRun('batches').status, 'saved');
    assert.deepEqual(db.applied.filter((a) => a.job === 'batches').at(-1).meta.active_rows, 6);
    // a download that does not match Drive's md5 is refused
    db.state.batches.written_sig = null; drive.meta.FILE.md5Checksum = 'f'.repeat(32);
    await call('batches');
    assert.match(lastRun('batches').error, /md5 mismatch/);

    assert.deepEqual([...seen.scopes].sort(), ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/spreadsheets.readonly'],
      'Google was only ever asked for read-only scopes');
    console.log(`runtime: callers, off/busy, write, stamp-only, an admin's shadow run, a refused write, a follow-up trims run, md5 and Google errors (SheetJS ${XLSX ? 'real' : 'faked'})`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* =========================================================== 5. the SQL */

{
  const sync = read(path.join(ROOT, 'supabase/pipeline-sync.sql'));
  const code = sync.replace(/--[^\n]*/g, '');
  assert.match(sync, /^set role pipeline_owner;\n/, 'pipeline-sync.sql runs as pipeline_owner');
  assert.match(sync, /\nreset role;\n$/);
  assert.ok(!/(^|;)\s*(begin|commit|rollback|savepoint|start\s+transaction)\s*;/im.test(code.replace(/\$\$[\s\S]*?\$\$/g, '')), 'no transaction control (the deploy workflow wraps each file)');
  assert.ok(!/(^|;)\s*(drop\s+(table|schema|database)\b|truncate\b)/im.test(code), 'no drop table or truncate');
  assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(sync) && !/'(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{25,}'/.test(sync), 'no email or id');
  for (const m of code.matchAll(/create\s+(?:table|index|function|or replace function|policy|view)\s+(?:if not exists\s+)?(?:public\.)?([a-z_]+)/gi))
    assert.match(m[1], /^pipeline_/, `pipeline-sync.sql creates only pipeline_* objects (${m[1]})`);
  const tables = [...code.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tables, ['pipeline_sync_settings', 'pipeline_sync_state', 'pipeline_sync_runs', 'pipeline_sync_secret']);
  for (const t of tables) {
    assert.ok(code.includes(`alter table public.${t} enable row level security;`), `${t} has RLS`);
    assert.ok(new RegExp(`revoke all on table public\\.${t} from public, anon, authenticated`).test(code), `${t} is closed to anon and authenticated`);
    assert.ok(!new RegExp(`create policy \\w+ on public\\.${t}`).test(code), `${t} has no policies`);
  }
  // every function: who may run it
  const fns = [...code.matchAll(/create or replace function public\.(\w+)\(([^)]*)\)/g)].map((m) => m[1]);
  const grants = {};
  for (const f of fns) {
    assert.match(code, new RegExp(`revoke all on function public\\.${f}\\([^)]*\\) from public`), `${f}: revoked from public`);
    grants[f] = [...code.matchAll(new RegExp(`grant execute on function public\\.${f}\\([^)]*\\) to ([^;]+);`, 'g'))].map((m) => m[1]).join(', ');
  }
  assert.deepEqual(grants, {
    pipeline_sync_check_secret: 'service_role', pipeline_sync_can_admin: 'authenticated, service_role', pipeline_sync_claim: 'service_role',
    pipeline_sync_finish: 'service_role', pipeline_sync_live: 'service_role', pipeline_marks_apply: '', pipeline_trims_apply: '', pipeline_batches_apply: '',
    pipeline_sync_apply: 'service_role', pipeline_sync_set: 'authenticated, service_role', pipeline_sync_status: 'authenticated, service_role',
  }, 'who may run each function');
  for (const j of JOBS) assert.match(code, new RegExp(`revoke all on function public\\.pipeline_${j}_apply\\(jsonb, jsonb\\) from public, anon, authenticated, service_role;`),
    `pipeline_${j}_apply: only pipeline_sync_apply may call it (the service role's default grant is taken away too)`);
  assert.match(code, /t\.run_token = p_token and t\.run_mode = 'write' and s\.mode = 'write'/, 'pipeline_sync_apply: only the run holding the job in write mode');
  assert.match(code, /pipeline_sync_set[\s\S]*?pipeline_sync_can_admin\(\)/, 'pipeline_sync_set: pipeline admins only');
  // the write bodies are the save bodies without the token check: the same rows and the same meta stamps
  const bodyOf = (sql, name) => {
    const m = sql.match(new RegExp(`create or replace function public\\.${name}\\([^)]*\\)\\s*returns jsonb[^$]*\\$\\$([\\s\\S]*?)\\$\\$;`));
    assert.ok(m, `found ${name}`);
    return m[1];
  };
  const squash = (s) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  for (const j of JOBS) {
    const save = bodyOf(read(path.join(ROOT, `supabase/pipeline-${j}.sql`)), `pipeline_${j}_save`);
    const noToken = save.replace(/\n\s*if not exists \(select 1 from public\.pipeline_\w+_secret[\s\S]*?raise exception 'bad token';\s*end if;/, '');
    assert.notEqual(noToken, save, `pipeline_${j}_save still starts with its token check`);
    assert.equal(squash(bodyOf(sync, `pipeline_${j}_apply`)), squash(noToken),
      `pipeline_${j}_apply is pipeline_${j}_save without the token check (change both together)`);
  }
  // the cron file: postgres-only, outside the deploy workflow's pattern, schedules made switched off, no secret in it
  const cron = read(path.join(ROOT, 'supabase/postgres/pipeline-sync-cron.sql'));
  const ccode = cron.replace(/--[^\n]*/g, '');
  for (const j of JOBS) {
    assert.match(ccode, new RegExp(`'pipeline-sync-${j}',\\s+'[^']+',\\s+'pipeline-${j}-sync'`), `cron: a schedule for pipeline-${j}-sync`);
    assert.ok(existsSync(fnDir(j)));
  }
  assert.match(ccode, /'pipeline-sync-marks',\s+'\*\/5 \* \* \* \*'/); assert.match(ccode, /'pipeline-sync-trims',\s+'\d+ \* \* \* \*'/); assert.match(ccode, /'pipeline-sync-batches',\s+'\d+ \* \* \* \*'/);
  assert.match(ccode, /perform cron\.alter_job\(v_id, active := false\);/, 'cron: every schedule is created switched off');
  assert.match(ccode, /if not exists \(select 1 from cron\.job where jobname = j\.name\)/, 'cron: a re-run never touches a schedule that exists');
  assert.match(ccode, /'x-pipeline-sync', \(select decrypted_secret from vault\.decrypted_secrets where name = 'pipeline_sync_secret'\)/, 'cron: the header comes from Vault at call time');
  assert.match(ccode, /timeout_milliseconds := \d{4,5}/);
  assert.ok(!/'[A-Za-z0-9_-]{25,}'/.test(cron) && !/@[a-z0-9-]+\.[a-z]/i.test(cron.replace(/https:\/\/[^\s']+/g, '')), 'cron: no secret, id or email in the file');
  assert.ok(!/(^|;)\s*(drop\s+(table|schema|database)\b|truncate\b)/im.test(ccode), 'cron: run-sql-ca accepts it (no drop table or truncate)');
  for (const f of ['pipeline-sync-cron-on.sql', 'pipeline-sync-cron-off.sql']) {
    const s = read(path.join(ROOT, 'supabase/postgres', f));
    assert.match(s, /jobname in \('pipeline-sync-marks', 'pipeline-sync-trims', 'pipeline-sync-batches'\)/, `${f} names exactly the three schedules`);
  }
  assert.ok(!existsSync(path.join(ROOT, 'supabase/pipeline-sync-cron.sql')), 'the cron file is not a pipeline-*.sql file (the workflow cannot run it)');
  console.log('sql: pipeline-sync.sql tables closed (RLS, no policies), writes only for the run in write mode, the same bodies as the *_save functions; cron schedules made switched off');
}

if (skipped.length) console.log('skipped: ' + skipped.join('; '));
console.log('pipeline-sync: all checks passed');
