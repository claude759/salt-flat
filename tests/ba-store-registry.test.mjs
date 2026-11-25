// BA Field app (ba/index.html) Stores page: billed accounts that no store of the list answers to (2026-11-25), from
// the STORE PLAN MODEL block sliced into a vm, plus the shape of supabase/ba-store-registry-add.sql. Synthetic rows
// only; nothing here reads or writes a database.
//   node --test tests/ba-store-registry.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../ba/index.html', import.meta.url), 'utf8');
const between = (src, start, end) => { const a = src.indexOf(start), b = src.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return src.slice(a, b); };
const s = { Set, Map, Date, String, Number, Array, Math };
vm.createContext(s);
vm.runInContext(between(html, 'const SCHED_ALIASES=', 'const SCHED_COLORS='), s);
vm.runInContext(between(html, 'const SCHED_PAD=', '/* ── end STORE PLAN MODEL ── */'), s);
const get = name => vm.runInContext(name, s);
const plain = x => JSON.parse(JSON.stringify(x));

const STORES = [
  { id: 'a', name: 'Goat Global Westwood', state: 'CA', sales_key: 'goat global' },
  { id: 'd', name: 'Kush Alley North Hills', state: 'CA', sales_key: 'kush alley north hills', pistil_name: 'Kush Alley' },
  { id: 'h', name: 'Harvest of Chatsworth', state: 'CA', sales_key: 'at risk harvest of chatsworth', aliases: ['[At-Risk] Harvest of Chatsworth'] },
  { id: 'm', name: 'Megan’s Organic Market - SLO', state: 'CA', sales_key: 'megan s organic market slo', aliases: ["Megan's Organic Market San Luis Obispo"] },
  { id: 'c', name: 'Lemonnade Van Nuys', state: 'CA', sales_key: 'lemonnade' },
  { id: 'x', name: 'Home', state: 'CA', private: true, sales_key: 'home' },
  { id: 'e', name: 'PostNet Chatsworth', state: 'CA', retail: false },
  { id: 'n', name: 'Flowery NYC', state: 'NY', sales_key: 'flowery' },
  { id: 'p', name: '* General BA activity', state: 'CA' },
];
const acct = (sales_key, o = {}) => ({ sales_key, name: o.name || sales_key, net: 1000, orders: 1, first_order: '2026-11-01', last_order: '2026-11-01', channel: 'Nabis', dispensary_ids: [], ...o });

test('tierNorm: the page compares names exactly as the sales app does', () => {
  const ar = fs.readFileSync(new URL('../ar-reports.html', import.meta.url), 'utf8');
  const line = ar.match(/const tierNorm=s=>[^\n]*;/);
  assert.ok(line, "the sales app's tierNorm");
  const t = vm.runInNewContext(line[0] + ' tierNorm', { String });
  for (const n of ['[At-Risk] Harvest of Chatsworth', 'Megan’s Organic Market - SLO', "Megan's Organic Market San Luis Obispo",
    'Cookies on Melrose [Nabis]', '  STIIIZY   Pomona ', 'Vibe by California - Distro', 'Café Ñ', '', null, 'A [b] c [d]'])
    assert.equal(get('spNorm')(n), t(n), String(n));
});

test('an account the feed linked to nothing joins the stores that answer to its name: name, sales key, Pistil name, alias', () => {
  const rows = plain(get('spRows')({ stores: STORES, st: 'CA', todayIso: '2026-11-25', sales: [
    acct('kush alley', { name: 'Kush Alley', net: 7 }),                                    // d's Pistil name
    acct('at risk harvest of chatsworth', { name: '[At-Risk] Harvest of Chatsworth', net: 1475 }),   // h's alias
    acct('megan s organic market san luis obispo', { name: "Megan's Organic Market San Luis Obispo", net: 1600 }),  // m's alias
    acct('lemonnade van nuys', { name: 'Lemonnade Van Nuys', net: 5 }),                     // c's own name
    acct('home', { name: 'Home', net: 9 }),                                                 // a private place is no store
    acct('goat global', { net: 100, dispensary_ids: ['a'] }),                              // linked: as before
  ] }));
  const by = id => rows.find(r => r.id === id);
  assert.deepEqual(rows.map(r => r.id).sort(), ['a', 'c', 'd', 'h', 'm']);
  assert.equal(by('d').sales, 7); assert.equal(by('h').sales, 1475); assert.equal(by('m').sales, 1600);
  assert.equal(by('c').sales, 5); assert.equal(by('a').sales, 100);
});

test('billed but not in the store list: what joins no store of the board, newest first order first, with the sync\'s note', () => {
  const sales = [
    acct('goat global', { dispensary_ids: ['a'] }),                                         // linked
    acct('kush alley', { name: 'Kush Alley' }),                                             // joins d by its Pistil name
    acct('the artist tree beverly', { name: 'The Artist Tree Beverly', net: 1080, first_order: '2026-11-24' }),
    acct('torrey holistics inc', { name: 'TORREY HOLISTICS INC', net: 3200, first_order: '2026-11-18', channel: 'Distru' }),
    acct('cannavine distro', { name: 'Cannavine Distro', net: 29205, orders: 8, first_order: '2026-05-29' }),
    acct('lemonnade', { dispensary_ids: null }),                                            // saved without links: by sales_key, joins c
    acct('nobody here', { dispensary_ids: null, first_order: null }),                       // saved without links, no store
    acct('flowery', { name: 'Flowery', dispensary_ids: ['n', 'zz'], first_order: '2026-10-01' }),   // its stores aren't on this board
    acct('home', { name: 'Home', first_order: '2026-09-01' }),                              // only a private place answers
    acct('postnet chatsworth', { name: 'PostNet Chatsworth', first_order: '2026-08-01' }),  // only an errand stop answers
  ];
  const review = [
    { customer: 'The Artist Tree Beverly', sales_key: 'the artist tree beverly', kind: 'lookalike', candidate_id: 'zz-studio',
      why: 'registry row "The Artist Tree - Studio City" (4fc14165-27ba-4a36-a357-bb9241915321) may be this store', license: 'C10-0000537-LIC',
      legal_name: null, address: '8311 Beverly Blvd W, Los Angeles, CA 90048' },
    { customer: 'TORREY HOLISTICS INC', kind: 'not-a-store', why: 'a Commercial - Distributor licence' },   // no sales_key: by its name
    { customer: 'Cannavine Distro', sales_key: 'cannavine distro', kind: 'same-door-other-licence', license: 'C11-0001991-LIC' },
  ];
  const u = plain(get('spUnlinked')({ stores: STORES, sales, review, st: 'CA' }));
  assert.deepEqual(u.map(x => x.salesKey), ['the artist tree beverly', 'torrey holistics inc', 'flowery', 'home', 'postnet chatsworth',
    'cannavine distro', 'nobody here']);
  const at = u[0];
  assert.deepEqual({ ...at, review: !!at.review }, { name: 'The Artist Tree Beverly', salesKey: 'the artist tree beverly', net: 1080, orders: 1,
    firstOrder: '2026-11-24', lastOrder: '2026-11-01', channel: 'Nabis', review: true, notStore: false });
  assert.equal(at.review.license, 'C10-0000537-LIC');
  assert.equal(u[1].notStore, true);                     // the sync says a distributor
  assert.equal(u.find(x => x.salesKey === 'cannavine distro').notStore, true);   // a distributor's license (C11-)
  assert.equal(u.find(x => x.salesKey === 'flowery').review, null);
  // nothing billed, nothing to show; a manager's empty sales list (or none read) is empty too
  assert.deepEqual(plain(get('spUnlinked')({ stores: STORES, sales: [], review, st: 'CA' })), []);
  assert.deepEqual(plain(get('spUnlinked')({ stores: STORES, st: 'CA' })), []);
});

test('not a store: by the sync\'s kind or a California distributor license', () => {
  const ns = get('spNotStore');
  assert.equal(ns({ kind: 'not-a-store', why: 'not in the registry; licence C12-0000020-LIC is a Commercial - Microbusiness licence' }), true);
  assert.equal(ns({ kind: 'Distributor' }), true);
  assert.equal(ns({ kind: 'manufacturer' }), true);
  assert.equal(ns({ kind: 'same-door', license: ' c11-0001991-LIC' }), true);        // a distributor's license, whatever the kind
  assert.equal(ns({ kind: 'other-door', license: 'C12-0000655-LIC' }), false);       // a microbusiness can be a store
  assert.equal(ns({ kind: 'lookalike' }), false);
  // what isn't a store is the row it answers to (private, an errand stop): the account itself is one
  assert.equal(ns({ kind: 'not-a-store', why: 'answers to registry row "PostNet Chatsworth" (3b78), which is marked non-retail, not a store' }), false);
  assert.equal(ns({ kind: 'not-a-store', license: 'C10-0001066-LIC' }), false);     // a retailer's license is a store's
  assert.equal(ns(null), false);
});

test('why the sync waited, in a few words, naming the store it may be', () => {
  const w = get('spHeldWhy'), nameOf = id => ({ s1: 'The Artist Tree - Studio City', c1: 'Cookies Melrose' })[id] || '';
  assert.equal(w(null), 'The store sync has no note on it yet');
  assert.equal(w({ kind: 'lookalike', candidate_id: 's1' }, nameOf), 'It may be The Artist Tree - Studio City, so the sync waited');
  // a store this page doesn't list (turned off, say): named from the sync's own words
  assert.equal(w({ kind: 'lookalike', candidate_id: 'gone', why: 'but registry row "PostNet Chatsworth" (3b78) may be' }, nameOf), 'It may be PostNet Chatsworth, so the sync waited');
  assert.equal(w({ kind: 'lookalike' }, nameOf), 'It may be a store already in the list, so the sync waited');
  // the sync's kinds (ca-registry.mjs), and the dry run's longer names for them
  for (const k of ['same-door', 'same-door-other-licence'])
    assert.equal(w({ kind: k, candidate_id: 'c1' }, nameOf), 'Same address as Cookies Melrose, under a new license');
  for (const k of ['other-door', 'row-licence-other-door'])
    assert.equal(w({ kind: k, why: 'registry row "Meltd" (57f2) carries licence' }, nameOf), 'Its license is on Meltd, at another address');
  assert.equal(w({ kind: 'not-a-store' }, nameOf), 'A distributor or maker, not a store');
  assert.equal(w({ kind: 'not-a-store', license: 'C10-0001066-LIC', why: 'answers to registry row "PostNet Chatsworth" (3b78), which is marked non-retail, not a store' }, nameOf),
    "It answers to PostNet Chatsworth, which isn't marked as a store");
  for (const k of ['several-rows', 'several-rows-answer']) assert.equal(w({ kind: k }, nameOf), 'More than one store answers to this name');
  assert.equal(w({ kind: 'inactive-row', candidate_id: 'c1' }, nameOf), 'It matches Cookies Melrose, which is turned off or not marked as a store');
  assert.equal(w({ kind: 'dead-licence' }, nameOf), 'Its license is no longer active');
  for (const k of ['licence', 'licence-unknown-or-disagrees']) assert.equal(w({ kind: k }, nameOf), 'Its license could not be confirmed');
  for (const k of ['address', 'address-differs']) assert.equal(w({ kind: k }, nameOf), 'Its address does not match the store list');
  assert.equal(w({ kind: 'held' }, nameOf), 'Not decided yet: the sync tries again on its next run');
  for (const k of ['other', 'something new']) assert.equal(w({ kind: k }, nameOf), 'Left for a person to check');
  for (const k of ['lookalike', 'same-door', 'not-a-store', 'held', 'other']) assert.doesNotMatch(w({ kind: k }, nameOf), /—/);
});

test('Why? in plain words from the note\'s fields; a billing name without its tags', () => {
  const t = get('spWhyPlain'), nameOf = id => ({ s1: 'The Artist Tree - Studio City', c1: 'Cookies Melrose', m1: 'Meltd' })[id] || '';
  const look = t({ kind: 'lookalike', license: 'C10-0000537-LIC', legal_name: 'Artist Tree Beverly LLC', address: '8311 Beverly Blvd W, Los Angeles, CA 90048',
    candidate_id: 's1', why: 'registry row "The Artist Tree - Studio City" (4fc14165-27ba-4a36-a357-bb9241915321) may be this store' }, nameOf);
  assert.match(look, /^The state lists it under license C10-0000537-LIC \(Artist Tree Beverly LLC\) at 8311 Beverly Blvd W, Los Angeles, CA 90048\. /);
  assert.match(look, /The Artist Tree - Studio City may be the same store/);
  assert.match(t({ kind: 'same-door', candidate_id: 'c1' }, nameOf), /^Cookies Melrose is at the same address under another license/);
  assert.match(t({ kind: 'other-door', candidate_id: 'm1', license: 'C12-0000655-LIC' }, nameOf), /The list has this license on Meltd, at another address/);
  assert.match(t({ kind: 'not-a-store', license: 'C11-0001141-LIC', legal_name: 'Torrey Holistics, Inc.' }, nameOf), /distributor's or maker's license/);
  assert.equal(t(null), '');
  for (const k of ['lookalike', 'same-door', 'other-door', 'several-rows', 'inactive-row', 'dead-licence', 'licence', 'address', 'held', 'not-a-store', 'other']) {
    const w = t({ kind: k, why: 'registry row "X" (4fc14165-27ba-4a36-a357-bb9241915321) ... DCC ... crosswalk ... not linked, not created', candidate_id: 's1' }, nameOf);
    assert.ok(w.length > 10, k);
    assert.doesNotMatch(w, /registry row|DCC|crosswalk|not linked|licence|[0-9a-f]{8}-[0-9a-f]{4}|—/, k);
  }
  const c = get('spCleanName');
  assert.equal(c('[At-Risk] Harvest of Chatsworth'), 'Harvest of Chatsworth');
  assert.equal(c('Cookies on Melrose [Nabis]'), 'Cookies on Melrose');
  assert.equal(c('  The Artist Tree  WeHo '), 'The Artist Tree WeHo');
});

test('stores whose license is no longer active, with the new one the shop at that door trades under', () => {
  const n = get('spLicenseNotes');
  const stores = [{ id: 'c1', name: 'Cookies Melrose', state: 'CA', license: 'C10-0000219-LIC' }, { id: 'w1', name: 'WeedWay Tujunga', state: 'CA', license: 'C10-0001808-LIC' },
    { id: 'x1', name: 'Gone', state: 'CA', active: false, license: 'C10-1' }];
  const review = [
    { kind: 'same-door', conflict: false, customer: 'Cookies on Melrose', license: 'C10-0001834-LIC', legal_name: 'Cmel2 LLC', candidate_id: 'c1' },
    { kind: 'same-door', conflict: false, customer: 'Cookies on Melrose again', license: 'C10-0001834-LIC', candidate_id: 'c1' },          // one note a store
    { kind: 'same-door', conflict: false, customer: 'Tujunga Hills Cannabis', license: 'c10 0001808', candidate_id: 'w1' },           // already updated
    { kind: 'same-door', conflict: true, customer: 'Cannavine Distro', license: 'C11-0001991-LIC', candidate_id: 'c1' },              // a conflict, not this
    { kind: 'lookalike', conflict: false, customer: 'X', license: 'C10-9', candidate_id: 'c1' },
    { kind: 'same-door', conflict: false, customer: 'Y', license: 'C10-2', candidate_id: 'x1' }];                                   // not on the board
  const out = plain(n({ stores, review, st: 'CA' }));
  assert.deepEqual(out.map(x => [x.store.id, x.license, x.legal, x.customer]), [['c1', 'C10-0001834-LIC', 'Cmel2 LLC', 'Cookies on Melrose']]);
  assert.deepEqual(plain(n({ stores, review: [], st: 'CA' })), []);
});

test('the screens this touched have no plain dropdowns', () => {
  const fn = name => between(html, `function ${name}(`, '\n}\n');
  for (const name of ['dispSheet', 'storeAddSheet']) {
    const src = fn(name), selects = src.match(/<select\b[^>]*>/g) || [];
    assert.ok(selects.length > 0, name);
    for (const sel of selects) assert.match(sel, /data-searchable/, `${name}: ${sel}`);
  }
});

test('the SQL: one file, safe to run again, the sync-only writer closed to the app', () => {
  const sql = fs.readFileSync(new URL('../supabase/ba-store-registry-add.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists public\.store_registry_review/);
  assert.match(sql, /alter table public\.store_registry_review enable row level security/);
  assert.match(sql, /revoke all on public\.store_registry_review from anon, authenticated;\s*grant select on public\.store_registry_review to authenticated;/);
  assert.match(sql, /revoke all on function public\.store_registry_review_replace\(text, jsonb\) from public, anon, authenticated;/);
  assert.doesNotMatch(sql, /grant execute on function public\.store_registry_review_replace/);
  for (const f of ['store_registry_match(text, text, text, text, text[])', 'store_registry_add(jsonb)', 'store_registry_link(uuid, text)']) {
    assert.ok(sql.includes(`revoke all on function public.${f} from public, anon;`), f);
    assert.ok(sql.includes(`grant execute on function public.${f} to authenticated;`), f);
  }
  // every security definer function pins its search path; no drop or truncate; ends by reloading the API's schema
  const definers = sql.match(/security definer[^\n]*/g) || [];
  assert.equal(definers.length, 4);
  for (const d of definers) assert.match(d, /set search_path = public/);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ''), /(^|;)\s*(drop\s+(table|schema|function)|truncate)\b/im);
  assert.match(sql.trim(), /notify pgrst, 'reload schema';$/);
});
