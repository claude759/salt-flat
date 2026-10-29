// BA Field app (ba/index.html): event costs synced from the books (supabase/ba-expense-events.sql).
// Runs the page's own functions, sliced out of the file into a vm the way the bank board tests do, with stubs for the
// DOM and Supabase. Synthetic rows only; nothing here reads or writes a database.
//   node --test tests/ba-events.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const html = fs.readFileSync(new URL('../ba/index.html', import.meta.url), 'utf8');
const between = (start, end) => { const a = html.indexOf(start), b = html.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return html.slice(a, b); };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const BRAND = 'b4319cde-2358-4a1f-8abc-23eec20a2d69', STORE = 'st-1', STORE2 = 'st-2';
const PUFF = 'PUFFCON 2026 (10/3/26)', ARL = 'STIIIZY ARLINGTON (10/24/26)';

function sandbox(extra = {}) {
  const sheets = [];
  const el = () => ({ onclick: null, click() {}, classList: { toggle() {}, contains: () => true, remove() {} }, addEventListener() {}, querySelectorAll: () => [] });
  const s = {
    esc, console, Set, Map, Promise,
    fmtDate: d => String(d || ''), rangeLabel: () => 'This period',
    state: { dispensaries: [{ id: BRAND, name: '* Brand event' }, { id: STORE, name: 'Zz Store', state: 'CA' }, { id: STORE2, name: 'Zz Two', state: 'NY' }], profile: { role: 'admin' } },
    isNonstoreKind: () => false, actingAsBA: () => false,
    openSheet: h => sheets.push(h), closeSheet() {}, toast() {}, signedUrl: async () => null,
    $: () => el(), document: { createElement: () => el() },
    ...extra,
  };
  s.sheets = sheets;
  vm.createContext(s);
  vm.runInContext(between('const money = n =>', 'const esc = s =>'), s);   // the page's own formatter
  // the payment helpers, the books helpers and the feature-detected select
  vm.runInContext(between('const isCoPaid = p =>', '/* ─────────────────────────── helpers'), s);
  vm.runInContext(between('function dispName(id){', '// dispensaries a BA can pick'), s);
  vm.runInContext(between('function itemIssues(x){', '// to-do card listing incomplete items'), s);
  vm.runInContext(between('function dgCanEdit(', 'function dgCanAdd('), s);
  vm.runInContext(between('function itemDetailSheet(kind, x){', '// back-comat name'), s);
  vm.runInContext(between('const isPlaceholderName=', 'function visitsCardsHtml('), s);
  vm.runInContext(between('function repDetailRow(it){', '// Admin: edit any single trip/expense'), s);
  vm.runInContext(between('function exportCSV(prof,per,T,E,H){', 'function exportPDF('), s);
  return s;
}
const get = (s, name) => vm.runInContext(name, s);
const plain = x => JSON.parse(JSON.stringify(x));   // arrays made inside the vm have that realm's prototypes
const exp = (id, extra = {}) => ({ id, ba_id: 'auto', expense_date: '2026-10-01', vendor: 'Wrap Legends', amount: 100, payment: 'company', status: 'approved', receipt_path: null, dispensary_id: BRAND, dispensary_ids: [BRAND], ...extra });

test('the build is bumped and every inline script parses', () => {
  const v = /const APP_VERSION = '([^']+)'/.exec(html)[1];
  assert.notEqual(v, '2026-10-15.124'); assert.match(v, /^2026-10-2\d\.\d+$/);
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const tmp = path.join(os.tmpdir(), `ba-inline-${process.pid}.mjs`);
  fs.writeFileSync(tmp, scripts.join('\n;\n'));
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); } finally { fs.rmSync(tmp, { force: true }); }
});

test('isBooks, the event pill and the read-only note', () => {
  const s = sandbox();
  assert.equal(get(s, 'isBooks')({ source: 'books' }), true);
  assert.equal(get(s, 'isBooks')({ source: null }), false);
  assert.equal(get(s, 'isBooks')({}), false);
  assert.equal(get(s, 'isBooks')(null), false);
  assert.equal(get(s, 'eventPill')(''), '');
  assert.equal(get(s, 'eventPill')('A <b> (1/1/26)'), '<span class="pill ev" title="Event">🎪 A &lt;b&gt; (1/1/26)</span>');
  assert.equal(get(s, 'BOOKS_NOTE'), 'Synced from QuickBooks. Fix it in the books.');
  assert.equal(get(s, 'BOOKS_OWNER'), 'From the books');
});

// a stand-in for supabase.from('expenses').select(cols).<filters>: resolves like PostgREST would, with or without the
// event columns in the table
function fakeSupabase({ hasCols, error = null }) {
  const calls = [];
  const from = table => ({ select(cols) {
    const call = { table, cols, filters: [] }; calls.push(call);
    const b = { eq: (k, v) => (call.filters.push(['eq', k, v]), b), gte: (k, v) => (call.filters.push(['gte', k, v]), b), lte: (k, v) => (call.filters.push(['lte', k, v]), b),
      then(res, rej) {
        if (error) return Promise.resolve({ data: null, error }).then(res, rej);
        if (!hasCols && /event_name|books_key|source/.test(cols)) return Promise.resolve({ data: null, error: { code: '42703', message: 'column expenses.event_name does not exist' } }).then(res, rej);
        return Promise.resolve({ data: [{ id: 'e1', ...(hasCols ? { source: null, event_name: null } : {}) }], error: null }).then(res, rej);
      } };
    return b;
  } });
  return { from, calls };
}

test('selectExpenses asks for the event columns, and falls back for good when the SQL is not applied yet', async () => {
  const s = sandbox();
  s.supabase = fakeSupabase({ hasCols: false });
  const r1 = await get(s, 'selectExpenses')('id,amount', q => q.gte('expense_date', '2026-10-01').lte('expense_date', '2026-10-14'));
  assert.equal(r1.error, null); assert.deepEqual(r1.data, [{ id: 'e1' }]);
  assert.deepEqual(s.supabase.calls.map(c => c.cols), ['id,amount,event_name,event_id,books_key,source', 'id,amount']);
  assert.deepEqual(s.supabase.calls[1].filters, [['gte', 'expense_date', '2026-10-01'], ['lte', 'expense_date', '2026-10-14']], 'the fallback keeps the filters');
  assert.equal(get(s, 'expEventCols'), false);
  await get(s, 'selectExpenses')('id', q => q);
  assert.deepEqual(s.supabase.calls.slice(2).map(c => c.cols), ['id'], 'no second try once it knows');
});

test('selectExpenses after the SQL: one query with the columns; any other error is returned, not retried', async () => {
  const s = sandbox();
  s.supabase = fakeSupabase({ hasCols: true });
  const r = await get(s, 'selectExpenses')('id', q => q.eq('ba_id', 'u1'));
  assert.equal(r.error, null); assert.equal(s.supabase.calls.length, 1); assert.equal(get(s, 'expEventCols'), true);
  const s2 = sandbox();
  s2.supabase = fakeSupabase({ hasCols: true, error: { code: 'PGRST301', message: 'JWT expired' } });
  const r2 = await get(s2, 'selectExpenses')('id', q => q);
  assert.equal(r2.error.code, 'PGRST301'); assert.equal(s2.supabase.calls.length, 1); assert.equal(get(s2, 'expEventCols'), null);
  assert.equal(get(s, 'missingColumn')({ code: '42703' }), true);
  assert.equal(get(s, 'missingColumn')({ message: 'column expenses.source does not exist' }), true);
  assert.equal(get(s, 'missingColumn')({ code: '42501', message: 'permission denied' }), false);
  assert.equal(get(s, 'missingColumn')(null), false);
});

test('eventDateOf reads the date group at the end of an event name', () => {
  const s = sandbox(), f = get(s, 'eventDateOf');
  assert.equal(f(PUFF), '2026-10-03');
  assert.equal(f('THE BRIGHT SPOT (SPRING SOLSTICE 2025) (3/21/25)'), '2025-03-21');
  assert.equal(f('GWG GALENTINES (2/13/2026)'), '2026-02-13');
  assert.equal(f('no date'), '');
  assert.equal(f(null), '');
});

test('eventGroups: one group per event, newest first, expenses counted once across store shares', () => {
  const s = sandbox();
  const it = (id, event, amount, extra = {}) => ({ kind: 'exp', id, event, amount, payment: 'company', date: '2026-10-01', books: true, ...extra });
  const groups = get(s, 'eventGroups')([
    it('a', PUFF, 300), it('b', PUFF, 50, { payment: 'reimbursement', books: false, date: '2026-09-28' }),
    it('c', ARL, 60), it('c', ARL, 40),           // one expense split across two stores
    it('d', '', 999), it('e', null, 5),           // untagged lines stay out
  ]);
  assert.deepEqual(plain(groups.map(g => [g.name, g.date, g.n, g.total, g.card, g.exp, g.books])),
    [[ARL, '2026-10-24', 1, 100, 100, 0, 100], [PUFF, '2026-10-03', 2, 350, 300, 50, 300]]);
  assert.deepEqual(plain(groups[1].items.map(i => i.id)), ['b', 'a'], 'items oldest first inside a group');
  assert.equal('ids' in groups[0], false);
  const bar = get(s, 'eventsTotbar')(groups);
  assert.match(bar, />Events<\/div><div class="v">2</); assert.match(bar, /Event spend<\/div><div class="v">\$450\.00</);
  assert.deepEqual(plain(get(s, 'eventGroups')([])), []);
});

test('the Events card lists each event with its lines, and says plainly when there are none', () => {
  const s = sandbox();
  const groups = get(s, 'eventGroups')([{ kind: 'exp', id: 'a', event: PUFF, amount: 300, payment: 'company', date: '2026-10-01', books: true, vendor: 'Wrap Legends', ba: 'From the books', splitN: 1, fullAmount: 300 }]);
  const card = get(s, 'eventsCardHtml')(groups, 'all');
  assert.match(card, /data-disp="ev0"/); assert.match(card, /data-for="ev0"/);
  assert.match(card, /PUFFCON 2026 \(10\/3\/26\)/); assert.match(card, /1 expense · 💳 \$300\.00 company-paid · \$300\.00 from the books/);
  assert.match(card, /data-item="exp:a"/, 'the lines are the report\'s own repDetailRow lines (same tap handler)');
  assert.match(get(s, 'eventsCardHtml')([], 'NY'), /No expenses tagged with an event in NY for this range yet/);
});

test('repDetailRow: the event pill on an expense line, the books owner, and no false "no receipt"', () => {
  const s = sandbox(), row = get(s, 'repDetailRow');
  const books = row({ kind: 'exp', id: 'a', ba: 'From the books', vendor: 'Wrap Legends', date: '2026-10-01', payment: 'company', receipt: '', amount: 300, fullAmount: 300, splitN: 1, event: PUFF, books: true });
  assert.match(books, /<div class="t">From the books · Wrap Legends<\/div>/);
  assert.match(books, /receipt in QuickBooks/); assert.doesNotMatch(books, /no receipt/);
  assert.match(books, /· <span class="pill ev" title="Event">🎪 PUFFCON 2026 \(10\/3\/26\)<\/span>/);
  const plain = row({ kind: 'exp', id: 'b', ba: 'Joanna', vendor: 'Shell', date: '2026-10-01', payment: 'reimbursement', receipt: '', amount: 9, fullAmount: 9, splitN: 1, event: '' });
  assert.match(plain, /no receipt/); assert.doesNotMatch(plain, /pill ev/);
});

test('buildVisits skips rows from the books; the same cost entered by a BA is still a visit', () => {
  const s = sandbox();
  const ctx = { keep: () => true, baName: () => 'X', dnm: id => id, homeOf: () => '' };
  const visits = get(s, 'buildVisits')([], [exp('bk', { source: 'books', dispensary_id: STORE, dispensary_ids: [STORE] }), exp('ba', { ba_id: 'jo', dispensary_id: STORE, dispensary_ids: [STORE] })], [], ctx);
  assert.deepEqual(plain(visits.map(v => [v.ba_id, v.disp_id, v.card])), [['jo', STORE, 100]]);
});

test('itemIssues and dgCanEdit: a row from the books is nobody\'s to-do and never opens an editor', () => {
  const s = sandbox();
  const issues = get(s, 'itemIssues'), canEdit = get(s, 'dgCanEdit');
  assert.deepEqual(plain(issues({ ...exp('bk', { source: 'books', amount: -20, status: 'approved', dispensary_id: null, dispensary_ids: null }), _k: 'exp' })), []);
  assert.deepEqual(plain(issues({ ...exp('x', { amount: 0, status: 'draft', dispensary_id: null, dispensary_ids: null }), _k: 'exp' })), ['a dispensary', 'an amount', 'a receipt']);
  assert.equal(canEdit({ isAdmin: true }, 'exp', exp('bk', { source: 'books' })), false);
  assert.equal(canEdit({ isAdmin: true }, 'exp', exp('x')), true);
  assert.equal(canEdit({ isAdmin: false }, 'exp', exp('x', { status: 'draft' })), true);
});

test('itemDetailSheet: the event, the books note, and no admin edit for a row from the books', () => {
  const s = sandbox();
  get(s, 'itemDetailSheet')('exp', exp('bk', { source: 'books', event_name: PUFF }));
  const h = s.sheets.pop();
  assert.match(h, /Synced from QuickBooks\. Fix it in the books\./); assert.doesNotMatch(h, /dvEdit/); assert.doesNotMatch(h, /View only/);
  assert.match(h, /<span class="muted small">Event<\/span><span style="text-align:right">PUFFCON 2026 \(10\/3\/26\)<\/span>/);
  get(s, 'itemDetailSheet')('exp', exp('x', { status: 'submitted', event_name: PUFF }));
  const h2 = s.sheets.pop();
  assert.match(h2, /dvEdit/); assert.match(h2, /View only — this item is submitted/);
});

test('exportCSV puts the event in the Detail column', () => {
  let blob = null;
  const s = sandbox({ URL: { createObjectURL: b => { blob = b; return 'blob:x'; } }, Blob: class { constructor(parts) { this.text = parts.join(''); } } });
  get(s, 'exportCSV')({ full_name: 'Zz Person' }, { start_date: '2026-10-01' }, [], [exp('a', { event_name: PUFF, category: 'Events', dispensary_id: BRAND }), exp('b', { vendor: 'Shell', category: 'Meals' })], []);
  const lines = blob.text.split('\n');
  assert.equal(lines[1].split(',')[3], 'Wrap Legends (Events) · Event: PUFFCON 2026 (10/3/26)');
  assert.equal(lines[2].split(',')[3], 'Shell (Meals)');
});

test('adminEditItem opens a row from the books read-only, before any editor or query', async () => {
  const seen = [];
  const s = sandbox({ supabase: { from() { throw new Error('no query expected'); } } });
  s.itemDetailSheet = (k, x) => seen.push([k, x.id]);   // after the slices, which define the real one
  vm.runInContext(between('async function adminEditItem(kind, id, onSaved, preloaded){', 'async function adminDash(m){'), s);
  await get(s, 'adminEditItem')('exp', 'bk', () => {}, exp('bk', { source: 'books' }));
  assert.deepEqual(seen, [['exp', 'bk']]); assert.equal(s.sheets.length, 0);
});

test('reportItemSheet: kv Event, From the books, and the note in place of Edit', () => {
  const s = sandbox();
  vm.runInContext(between('function reportItemSheet(it){', '// Admin: edit any single trip/expense'), s);
  const it = { kind: 'exp', id: 'a', ba: 'From the books', vendor: 'Wrap Legends', date: '2026-10-01', payment: 'company', category: 'Events', amount: 300, fullAmount: 300, splitN: 1, status: 'approved', event: PUFF, books: true, disp: '* Brand event' };
  get(s, 'reportItemSheet')(it);
  const h = s.sheets.pop();
  assert.match(h, />BA<\/div><div [^>]*>From the books</); assert.match(h, />Event<\/div><div [^>]*>PUFFCON 2026 \(10\/3\/26\)</);
  assert.match(h, /Synced from QuickBooks\. Fix it in the books\./); assert.doesNotMatch(h, /riEdit/);
  get(s, 'reportItemSheet')({ ...it, books: false, ba: 'Joanna', event: '' });
  const h2 = s.sheets.pop();
  assert.match(h2, /riEdit/); assert.doesNotMatch(h2, />Event</);
});

// Credits arrive from the event sync as NEGATIVE amounts (a card refund, a vendor credit). Every place a row from the
// books shows must carry the sign and net it, never print $-12.34 or hide it.
test('money: a credit reads -$12.34; positive amounts format exactly as before', () => {
  const s = sandbox(), m = get(s, 'money');
  const old = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  for (const n of [0, 0.004, 0.005, 1.005, 2.675, 12.3, 1234.5, 1e6, '45.6', null, undefined, 'x', NaN]) assert.equal(m(n), old(n), String(n));
  assert.equal(m(-50), '-$50.00'); assert.equal(m(-1234.567), '-$1,234.57'); assert.equal(m('-9.5'), '-$9.50');
  assert.equal(m(-0.004), '$0.00', 'float dust is not a credit'); assert.equal(m(-0), '$0.00');
  assert.equal(m(0.1 + 0.2 - 0.3 - 1e-16 * 3), '$0.00');
});

test('a credit from the books: its line, both sheets and the Events view show the sign and net it', () => {
  const s = sandbox();
  const line = (id, event, amount, extra = {}) => ({ kind: 'exp', id, event, amount, fullAmount: amount, splitN: 1, payment: 'company', date: '2026-10-01', books: true,
    ba: 'From the books', vendor: 'Wrap Legends', receipt: '', category: 'Events', status: 'approved', disp: '* Brand event', ...extra });
  const row = get(s, 'repDetailRow')(line('cr', PUFF, -120));
  assert.match(row, /<div class="amt">-\$120\.00<\/div>/); assert.doesNotMatch(row, /\$-/);
  get(s, 'reportItemSheet')(line('cr', PUFF, -120));
  const sheet = s.sheets.pop();
  assert.match(sheet, /<div class="small muted">-\$120\.00<\/div>/); assert.match(sheet, />Amount<\/div><div [^>]*>-\$120\.00</); assert.doesNotMatch(sheet, /\$-/);
  get(s, 'itemDetailSheet')('exp', exp('cr', { source: 'books', amount: -120, event_name: PUFF }));
  const detail = s.sheets.pop();
  assert.match(detail, /<span class="muted small">Amount<\/span><span style="text-align:right">-\$120\.00<\/span>/);
  // PUFFCON: a charge and its full refund net to zero; ARLINGTON: only a refund in this range; GALPIN: a normal charge
  const GAL = 'GALPIN (10/9/26)';
  const groups = get(s, 'eventGroups')([line('a', PUFF, 300), line('b', PUFF, -300, { date: '2026-10-05' }),
    line('c', ARL, -120), line('d', GAL, 0.1), line('e', GAL, 0.2), line('f', GAL, -0.3), line('g', GAL, 400)]);
  assert.deepEqual(plain(groups.map(g => [g.name, g.n, Math.round(g.total * 100) / 100])), [[ARL, 1, -120], [GAL, 4, 400], [PUFF, 2, 0]]);
  const card = get(s, 'eventsCardHtml')(groups, 'all');
  const block = i => card.split('data-disp="ev').slice(1)[i];
  assert.match(block(0), /-\$120\.00<\/div>/); assert.match(block(0), /width:0%/, 'a net credit gets no bar');
  assert.match(block(0), /1 expense · 💳 -\$120\.00 company-paid · -\$120\.00 from the books/);
  assert.match(block(1), /width:100%/); assert.match(block(1), /4 expenses · 💳 \$400\.00 company-paid · \$400\.00 from the books/);
  assert.match(block(2), />\$0\.00<\/div>/); assert.match(block(2), /width:0%/);
  assert.match(block(2), /<div class="small muted">2 expenses<\/div>/, 'a charge and its refund leave no $0.00 parts');
  assert.doesNotMatch(card, /\$-/);
  assert.match(get(s, 'eventsTotbar')(groups), /Event spend<\/div><div class="v">\$280\.00</, 'the total nets the credits');
});

test('Spend by dispensary keeps a store a credit left negative, so its total nets it (both reports)', () => {
  for (const [name, src] of [['adminReport', between('async function adminReport(m){', '// ── Visits:')], ['baReport', between('async function baReport(m){', 'function periodItems(){')]]) {
    assert.match(src, /\.filter\(r=>Math\.abs\(r\.total\)>=0\.005\)\.sort\(\(a,b\)=>b\.total-a\.total\);/, name + ' keeps a negative store');
    assert.doesNotMatch(src, /\.filter\(r=>r\.total>0\)/, name);
    assert.match(src, /width:\$\{r\.total>0\?Math\.max\(3,Math\.round\(r\.total\/max\*100\)\):0\}%/, name + ' no bar for a negative store');
    assert.match(src, /\$\{Math\.abs\(r\.card\)>=0\.005\?` · 💳 \$\{money\(r\.card\)\} card`:''\}/, name + ' a negative card part shows');
    assert.match(src, /const grand=rows\.reduce\(\(a,r\)=>a\+r\.total,0\)/, name + ' Total spend sums the listed stores');
  }
});

test('the reports read row state, the event columns and offer the Events view', () => {
  const admin = between('async function adminReport(m){', '// ── Visits:'), mine = between('async function baReport(m){', 'function periodItems(){');
  for (const [name, src] of [['adminReport', admin], ['baReport', mine]]) {
    assert.match(src, /from\('trips'\)\.select\('[^']*,status,state'\)/, name + ' trips state');
    assert.match(src, /selectExpenses\('[^']*,status,state', q=>q/, name + ' expenses via selectExpenses with state');
    assert.match(src, /from\('hours'\)\.select\('[^']*,state'\)/, name + ' hours state');
    assert.match(src, /event:x\.event_name\|\|'',books:isBooks\(x\)/, name + ' event on the item');
    assert.match(src, /it&&it\.ba_id&&it\.date&&!it\.books\) dayAuditSheet/, name + ' books lines open their own detail');
  }
  assert.match(admin, /ba:isBooks\(x\)\?BOOKS_OWNER:baName\(x\.ba_id\)/);
  assert.match(admin, /<button data-v="events" class="\$\{view==='events'\?'on':''\}">Events<\/button>/);
  assert.match(admin, /\$\{view==='spend'\?spendBody:view==='events'\?eventsBody:visitsBody\}/);
  assert.match(admin, /if\(view==='spend'\|\|view==='events'\)\{/);
  assert.doesNotMatch(mine, /data-v="events"/, 'the BA\'s own report keeps its two views');
  // the Dashboard leaves rows from the books out of team activity
  const dash = between('async function adminDash(m){', '// live-refresh the admin review header');
  assert.match(dash, /selectExpenses\('ba_id,amount,status,payment,receipt_path', perQ\)/);
  assert.match(dash, /E\.forEach\(x=>\{ if\(isBooks\(x\)\) return;/);
  // dayAuditSheet: the event and no edit on a row from the books
  const day = between('async function dayAuditSheet(', 'function exportVisitsCSV(');
  assert.match(day, /kv\('Event', esc\(x\.event_name\|\|''\)\)/);
  assert.match(day, /if\(isBooks\(x\)\) out\+=`<div class="small muted" style="margin-top:8px">\$\{BOOKS_NOTE\}<\/div>`;\n\s*else if\(ctx\.isAdmin/);
});
