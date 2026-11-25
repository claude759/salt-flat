// BA Field app (ba/index.html): what keeps new stores from going missing from the app again (2026-11-25, after the
// Stores page missed new stores). The store list is read whole past the API's 1,000-row cap (readAll and readStores,
// run in a vm over a stand-in that caps every request at 1,000 rows as PostgREST does), and no read of it skips them;
// the street number check (addrHasNumber) is the database's own rule (store_address_key); the Stores page says when
// the registry sync has stopped (spSyncStale); and the store forms use all of it. Synthetic rows only; nothing here
// reads or writes a database.
//   node --test tests/ba-store-prevent.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../ba/index.html', import.meta.url), 'utf8');
const sql = fs.readFileSync(new URL('../supabase/ba-store-registry-add.sql', import.meta.url), 'utf8');
const between = (src, start, end) => { const a = src.indexOf(start), b = src.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return src.slice(a, b); };
const fn = name => { const a = html.indexOf(`function ${name}(`); assert.ok(a >= 0, name); return html.slice(a, html.indexOf('\n}\n', a)); };
const lineOf = i => html.slice(0, i).split('\n').length;
const plain = x => JSON.parse(JSON.stringify(x));

// ── the store list, read whole ─────────────────────────────────────────────────────────────────────
const PAGED = between(html, '/* ── PAGED READS', '/* ── end PAGED READS ── */');
// A PostgREST stand-in: eq filters, order, range, at most o.cap (1,000) rows a request whatever is asked, and with
// select(cols, {count:'exact'}) the count of every matching row (o.noCount: a server that sends none). o.failAt: the
// request number that fails; o.ignoreRange: a server that answers every page from the top; o.after(n, rows): runs
// after request n is answered (to change the table between two pages).
function api(rows, o = {}) {
  const log = [];
  const run = st => {
    log.push({ table: st.table, cols: st.cols, count: st.count, order: st.order.join(','), range: st.range && st.range.join('-') });
    if (o.failAt === log.length) return { data: null, error: { message: 'fake failure' } };
    let out = rows.filter(r => st.filters.every(f => f(r)));
    const total = out.length;
    if (st.order.length) out = out.slice().sort((a, b) => { for (const c of st.order) { if (a[c] < b[c]) return -1; if (a[c] > b[c]) return 1; } return 0; });
    if (st.range && !o.ignoreRange) out = out.slice(st.range[0], st.range[1] + 1);
    out = out.slice(0, o.cap || 1000).map(r => ({ ...r }));
    if (o.after) o.after(log.length, rows);
    return { data: out, error: null, count: st.count && !o.noCount ? total : null };
  };
  const from = table => {
    const st = { table, cols: null, count: null, filters: [], order: [], range: null };
    const b = {
      select(c, opts) { st.cols = c; st.count = (opts && opts.count) || null; return b; },
      eq(c, v) { st.filters.push(r => r[c] === v); return b; },
      order(c) { st.order.push(c); return b; },
      range(a, z) { st.range = [a, z]; return b; },
      then(res, rej) { return Promise.resolve().then(() => run(st)).then(res, rej); },
    };
    return b;
  };
  return { client: { from }, log };
}
function paged(client) {
  const s = { supabase: client, Set, Map, Array, Promise };
  vm.createContext(s);
  vm.runInContext(PAGED, s);
  return s;
}
// 2,345 active stores (and some turned off), ids not in name order, so the order really is name then id
const pad = n => String(n).padStart(4, '0');
const stores = (n, off = 0) => Array.from({ length: n }, (_, i) => ({ id: 'id-' + pad((i * 7919) % n), name: 'Store ' + pad(i), state: 'CA', active: true }))
  .concat(Array.from({ length: off }, (_, i) => ({ id: 'off-' + pad(i), name: 'Old store ' + pad(i), state: 'CA', active: false })));

test('a 2,345-store list comes back whole, a page of 1,000 at a time, in name then id order', async () => {
  const rows = stores(2345, 40), { client, log } = api(rows), s = paged(client);
  const r = await vm.runInContext("readStores('*', q=>q.eq('active',true))", s);
  assert.equal(r.error, null);
  assert.equal(r.data.length, 2345);
  assert.equal(new Set(r.data.map(d => d.id)).size, 2345);
  assert.equal(r.data[0].name, 'Store 0000');
  assert.equal(r.data[2344].name, 'Store 2344');       // the end of the alphabet, which one request would lose
  assert.ok(r.data.every(d => d.active));
  assert.deepEqual(log, ['0-999', '1000-1999', '2000-2999'].map(range => ({ table: 'dispensaries', cols: '*', count: 'exact', order: 'name,id', range })));
  // the stand-in caps like the API: the same read in one request loses 1,345 stores
  const one = await client.from('dispensaries').select('*').eq('active', true).order('name');
  assert.equal(one.data.length, 1000);
});

test('page edges: under 1,000 stores is one request, and the count saves the empty last one', async () => {
  for (const [n, reqs] of [[0, 1], [12, 1], [999, 1], [1000, 1], [1001, 2], [2000, 2]]) {
    const { client, log } = api(stores(n)), s = paged(client);
    const r = await vm.runInContext("readStores('id,name,state')", s);
    assert.equal(r.data.length, n, `${n} rows`);
    assert.equal(log.length, reqs, `${n} rows: ${reqs} requests`);
    assert.ok(log.every(x => x.cols === 'id,name,state' && x.count === 'exact' && x.order === 'name,id'));
  }
  // with no count (a server that sends none), a short page ends the read: a full last page costs one empty request
  for (const [n, reqs] of [[999, 1], [1000, 2], [2000, 3], [2345, 3]]) {
    const { client, log } = api(stores(n), { noCount: true });
    const r = await vm.runInContext("readStores('*')", paged(client));
    assert.equal(r.data.length, n, `no count, ${n} rows`);
    assert.equal(log.length, reqs, `no count, ${n} rows: ${reqs} requests`);
  }
});

test('a cap set lower than 1,000 one day can\'t cut the list: the count keeps it reading', async () => {
  const { client, log } = api(stores(2345), { cap: 500 });
  const r = await vm.runInContext("readStores('*')", paged(client));
  assert.equal(r.data.length, 2345);
  assert.equal(new Set(r.data.map(d => d.id)).size, 2345);
  assert.deepEqual(log.map(x => x.range), ['0-999', '500-1499', '1000-1999', '1500-2499', '2000-2999']);
});

test('an error on any page is the answer\'s error, with no rows (a caller that keeps its list keeps it whole)', async () => {
  const { client } = api(stores(2345), { failAt: 2 }), s = paged(client);
  const r = await vm.runInContext("readStores('*')", s);
  assert.equal(r.data, null);
  assert.deepEqual(plain(r.error), { message: 'fake failure' });
});

test('a store added between two pages is read once; a server that ignores the range doesn\'t loop', async () => {
  // a store whose name sorts first arrives after page 1: page 2 starts one row early, and that row is kept once
  const { client } = api(stores(2345), { after: (n, rows) => { if (n === 1) rows.push({ id: 'new', name: 'Aaa new store', state: 'CA', active: true }); } });
  const r = await vm.runInContext("readStores('*')", paged(client));
  assert.equal(r.data.length, 2345);
  assert.equal(new Set(r.data.map(d => d.id)).size, 2345);
  const bad = api(stores(2345), { ignoreRange: true });
  const r2 = await vm.runInContext("readStores('*')", paged(bad.client));
  assert.equal(r2.data.length, 1000);
  assert.equal(bad.log.length, 2);
});

test('no read of the store list skips readStores (writes may still return what they wrote)', () => {
  const def = html.indexOf('function readStores('), defEnd = html.indexOf('\n}\n', def);
  let reads = 0;
  for (const h of html.matchAll(/from\(\s*(['"`])dispensaries\1\s*\)/g)) {
    if (h.index > def && h.index < defEnd) { reads++; continue; }
    const method = (/^\s*\.\s*(\w+)\s*\(/.exec(html.slice(h.index + h[0].length)) || [])[1];
    assert.ok(['insert', 'update', 'upsert', 'delete'].includes(method),
      `ba/index.html line ${lineOf(h.index)} reads the store list (.${method}) without readStores, so past 1,000 stores it would stop at 1,000: use readStores(cols, q=>q.eq(...))`);
  }
  assert.equal(reads, 1, 'readStores reads the store list once, through readAll');
  assert.match(fn('readStores'), /return readAll\(\(\)=>\{ const q=supabase\.from\('dispensaries'\)\.select\(cols, \{ count:'exact' \}\)/);
  assert.doesNotMatch(html, /rest\/v1\/dispensaries/);
  // the reads there were: the boot load, Report, Settings' Locations, reloadDispensaries and the embedded schedule
  assert.match(fn('loadMe'), /await withTimeout\(readStores\('\*', q=>q\.eq\('active',true\)\)\)/);
  assert.match(fn('adminReport'), /readStores\('id,name,state'\)/);
  assert.match(fn('adminSettings'), /readStores\('\*'\)/);
  assert.match(fn('reloadDispensaries'), /return readStores\('\*', q=>q\.eq\('active',true\)\)/);
  assert.match(fn('bootEmbed'), /withTimeout\(readStores\('id,name,address,lat,lng,license,state,private,retail,sales_key,pistil_name,aliases',\s*q=>q\.eq\('active',true\)\)\)/);
});

// ── addresses with a street number ─────────────────────────────────────────────────────────────────
const addr = (() => { const s = { String }; vm.createContext(s); vm.runInContext(between(html, '/* ── ADDRESS CHECK', '/* ── end ADDRESS CHECK ── */'), s); return s; })();
const has = x => vm.runInContext('addrHasNumber', addr)(x);

test('the street number rule is the database\'s own (store_address_key), character for character', () => {
  const m = /create or replace function public\.store_address_key[\s\S]*?regexp_match\(lower\(coalesce\(p, ''\)\),\s*'([^']+)'\) as hs/.exec(sql);
  assert.ok(m, 'store_address_key\'s house number pattern');
  assert.equal(vm.runInContext('ADDR_NUMBER_RE.source', addr), m[1]);
  assert.equal(vm.runInContext('ADDR_NUMBER_RE.flags', addr), '');   // the SQL lower-cases first; so does addrHasNumber
});

test('a place\'s name and street has no street number; a house number then the street does, unit styles too', () => {
  // the 12 live rows saved with a place label (all made in the app), and other things that aren't a house number
  for (const x of ['11th Hour Coffee, Center Street, Santa Cruz, CA, USA', 'Perfect Union Weed Dispensary Morro Bay, Quintana Road, Morro Bay, CA, USA',
    'Treehouse Dispensary, Soquel Drive, Soquel, CA, USA', 'Authentic 209, McHenry Avenue, Modesto, CA, USA', 'CannaCruz - Watsonville, Kearney Street, Watsonville, CA, USA',
    "Megan's Organic Market - Dispensary, Hollister Avenue, Goleta, CA, USA", 'PostNet, Topanga Canyon Boulevard, Chatsworth, CA, USA',
    "Megan's Organic Market, SLO, Higuera Street, San Luis Obispo, CA, USA", 'Los Angeles Center Studios, South Bixel Street, Los Angeles, CA, USA',
    'Gemme Verdi - North Beach Dispensary, Columbus Avenue, San Francisco, CA, USA', 'NUG Vallejo, Lewis Brown Drive, Vallejo, CA, USA',
    'ASHE Society, North H Street, San Bernardino, CA, USA',
    'Unit 102', '#5', 'Suite 200, Main Street, Fresno, CA', '42nd Street, New York, NY, USA', 'Highway 1, Big Sur, CA, USA', 'Fresno, CA 93711',
    '123', '280', 'Route 66 Dispensary, Barstow, CA', 'PO Box 123, Fresno, CA', '7-Eleven, Main Street, Fresno, CA', '', null, undefined])
    assert.equal(has(x), false, String(x));
  for (const x of ['280 Higuera St, San Luis Obispo, CA 93401', 'Unit 102, 3257 W Shaw Ave, Fresno, CA 93711', '3257 W Shaw Ave, Unit 102/111, Fresno, CA 93711',
    '18-33 42nd St, Astoria, NY 11105', '100 Main St #5, Fresno, CA', '#5, 100 Main St, Fresno, CA', '9851 Topanga Canyon Blvd, Unit 9851-9853, Chatsworth, CA 91311',
    '1515 N. Cahuenga Blvd, Los Angeles, CA 90028', '29370 Hunco Way, Lake Elsinore, CA 92530', 'Cookies Melrose, 7569 Melrose Ave, Los Angeles, CA, USA',
    '12B Elm St, Oakland, CA', '  8625 Santa Monica Blvd, Unit A, W Hollywood, CA 90069', '4756 WEST IMPERIAL HIGHWAY, INGLEWOOD, CA', '1 Main St, Fresno, CA'])
    assert.equal(has(x), true, x);
  // a number being typed at the front of the address or of a comma part: the list doesn't ask for one then
  const started = vm.runInContext('addrNumberStarted', addr);
  for (const x of ['2', '280', '280 Hig', 'Unit 102, 3']) assert.equal(started(x), true, x);
  for (const x of ['Megan', 'Unit 102', 'Higuera Street, SLO', '']) assert.equal(started(x), false, x);
  assert.equal(vm.runInContext('ADDR_HINT', addr), 'No street number: add it so the store can be matched to its license.');
});

test('the store forms take only numbered addresses and say so when one has none; trip legs are as they were', () => {
  const ta = fn('attachPlaceTypeahead');
  assert.match(ta, /\(!numbered\(\) \|\| addrHasNumber\(s\.label\)\)/);
  assert.match(ta, /numbered\(\) && !addr\.length && !addrNumberStarted\(q\) \? 'Type the street number too' : ''/);
  assert.match(ta, /const numbered=\(\)=>!!opts\.addressOnly && \(!opts\.numbered \|\| !!opts\.numbered\(\)\);/);
  assert.match(ta, /if\(input\.disabled\) return;/);                                                     // no pick into a locked field
  assert.match(ta, /if\(input\.value!==q \|\| input\.disabled \|\| document\.activeElement!==input\) return;/);
  assert.match(ta, /<div class="sg note">/);
  // who asks for addresses only: the three store forms and the home address; the trip legs keep stores and places
  const calls = [...html.matchAll(/(?<!function )attachPlaceTypeahead\(([^\n]*)/g)].map(m => m[1]);
  assert.equal(calls.length, 6);
  assert.equal(calls.filter(c => /addressOnly:true/.test(c)).length, 4);
  assert.equal(calls.filter(c => /\{home:homeAddr\}\);?\s*$/.test(c) && !/addressOnly/.test(c)).length, 2);
  for (const [name, input, hint] of [['quickAddRetailerSheet', 'qrAddr', 'qrHint'], ['dispSheet', 'dAddr', 'dAddrHint'], ['storeAddSheet', 'saAddr', 'saAddrHint']]) {
    const src = fn(name);
    assert.match(src, new RegExp(`attachPlaceTypeahead\\([^\\n]*#${input}[^\\n]*\\{addressOnly:true(, numbered:shop)?\\}\\)`), name);
    assert.match(src, new RegExp(`<div id="${hint}" class="small addr-hint" hidden>\\$\\{esc\\(ADDR_HINT\\)\\}</div>`), name);
    assert.match(src, new RegExp(`addrHint\\([^\\n]*#${input}[^\\n]*#${hint}`), name);
    assert.match(src, /hint\(true\);/, `${name} says it again on save, and saves anyway`);
  }
  assert.match(fn('dispSheet'), /const shop=\(\)=>!sh\.querySelector\('#dPrivate'\)\.checked && sh\.querySelector\('#dRetail'\)\.checked;/);   // not a home or an errand stop
  assert.match(fn('dispSheet'), /addrHint\([^\n]*#dAddrHint'\), shop\);/);
});

test('the quick add checks the store list before it adds, and adds as before when it can\'t', () => {
  const q = fn('quickAddRetailerSheet');
  assert.match(q, /ms=await withTimeout\(storesMatch\(st, \{ name, address \}, \[\]\), 10000\)/);
  assert.match(q, /catch\(e\)\{ console\.warn\('the store list check did not run', e\); \}/);
  assert.match(q, /regMatchPanel\(q\('#qrMatch'\), ms, \{ mgr, onUse:use, onRevive:revive, onNew:/);
  assert.match(q, /onSaved&&onSaved\(d\|\|\{ \.\.\.row, active:true \}\)/);   // Use this one goes back through the same callback
  assert.match(q, /const lock=on=>b\.querySelectorAll\('input,#qrMatch button,#qrSave'\)/);
  assert.match(q, /\.insert\(\{name, state:st, private:false, active:true, address, created_by:state\.session\.user\.id\}\)/);
  // an add that fails after the form was closed offers it back with what was typed
  assert.match(q, /toastAction\(`Couldn't add \$\{name\}: \$\{error\.message\}`,'Open it',\(\)=>quickAddRetailerSheet\(onSaved, \{ name, address \}\), 30000\)/);
  assert.doesNotMatch(q, /<select\b/);   // nothing to pick from a plain dropdown
});

// ── the registry sync's notes, and when they say it stopped ────────────────────────────────────────
const model = (() => {
  const s = { Set, Map, Date, String, Number, Array, Math };
  vm.createContext(s);
  vm.runInContext(between(html, 'const SCHED_ALIASES=', 'const SCHED_COLORS='), s);
  vm.runInContext(between(html, 'const SCHED_PAD=', '/* ── end STORE PLAN MODEL ── */'), s);
  return s;
})();
const stale = o => plain(vm.runInContext('spSyncStale', model)(o));
const localDay = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('the sync has stopped when its newest note is more than 26 hours old', () => {
  const H = 3600e3, saved = '2026-11-24T04:52:30.123456+00:00', at = Date.parse(saved);
  const rows = [{ customer: 'A', updated_at: saved }, { customer: 'B', updated_at: '2026-11-20T10:00:00+00:00' }];
  assert.equal(stale({ review: rows, st: 'CA', unlinked: 5, now: at + 6 * H }), null);
  assert.equal(stale({ review: rows, st: 'CA', unlinked: 5, now: at + 26 * H }), null);         // a day of runs, just
  assert.deepEqual(stale({ review: rows, st: 'CA', unlinked: 5, now: at + 26 * H + 60e3 }), { since: localDay(at) });
  assert.deepEqual(stale({ review: rows, st: 'CA', unlinked: 0, now: at + 40 * H }), { since: localDay(at) });
  // the newest note counts, whatever the order; a time that isn't one is left out
  assert.equal(stale({ review: [{ updated_at: 'soon' }, rows[1], rows[0]], st: 'CA', unlinked: 1, now: at + H }), null);
});

test('no notes at all: stopped only for CA, and only while billed names no store answers to are waiting', () => {
  const now = Date.parse('2026-11-25T18:00:00Z');
  assert.deepEqual(stale({ review: [], st: 'CA', unlinked: 3, now }), { since: '' });
  assert.equal(stale({ review: [], st: 'CA', unlinked: 0, now }), null);
  assert.equal(stale({ review: [], st: 'NY', unlinked: 3, now }), null);     // the registry sync is California's only
  assert.equal(stale({ review: [{ updated_at: null }], st: 'FL', unlinked: 3, now }), null);
  assert.deepEqual(stale({ review: undefined, st: 'CA', unlinked: 1, now }), { since: '' });
});

test('the Stores page shows the line to managers only, from a notes read that worked', () => {
  const load = fn('storesLoad'), draw = fn('storesDrawUnl');
  assert.match(load, /from\('store_registry_review'\)\.select\('[^']*\bupdated_at\b[^']*'\)\.eq\('state',st\)/);
  assert.match(load, /reviewOk:mgr && !rv\.error && Array\.isArray\(rv\.data\)/);
  assert.match(draw, /const stale=mgr && D\.reviewOk \? spSyncStale\(\{ review:D\.review, st, unlinked:all\.length, now:D\.at\|\|Date\.now\(\) \}\) : null;/);
  assert.match(draw, /The store list hasn't updated from the sales app since \$\{spShort\(stale\.since\)\}, so new stores may be missing\. Tell Gianni\./);
  // at the top of the box, whatever else it shows
  assert.match(draw, /if\(!list\.length && !lic\.length\)\{ box\.innerHTML=staleHtml; return; \}/);
  assert.match(draw, /box\.innerHTML=staleHtml\+licHtml\+`<div class="sp-unl">/);
  assert.doesNotMatch(draw, /—/);
});
