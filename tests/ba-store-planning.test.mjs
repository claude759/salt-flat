// BA Field app (ba/index.html) Stores page: the STORE PLAN MODEL block (2026-11-21), sliced out of the page into a vm
// with the task model it uses. Synthetic rows only; nothing here reads or writes a database.
//   node --test tests/ba-store-planning.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../ba/index.html', import.meta.url), 'utf8');
const between = (start, end) => { const a = html.indexOf(start), b = html.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return html.slice(a, b); };
const s = { Set, Map, Date, String, Number, Array, Math };
vm.createContext(s);
vm.runInContext(between('const SCHED_ALIASES=', 'const SCHED_COLORS='), s);
vm.runInContext(between('const SCHED_PAD=', '/* ── end STORE PLAN MODEL ── */'), s);
const get = name => vm.runInContext(name, s);
const plain = x => JSON.parse(JSON.stringify(x));

const STORES = [
  { id: 'a', name: 'Goat Global Westwood', state: 'CA', sales_key: 'goat global', address: '2299 Westwood Blvd' },
  { id: 'b', name: 'Goat Global South Bay', state: 'CA', sales_key: 'goat global' },
  { id: 'c', name: 'Lemonnade Van Nuys', state: 'CA', sales_key: 'lemonnade' },
  { id: 'd', name: 'Kush Alley North Hills', state: 'CA', sales_key: 'kush alley' },
  { id: 'p', name: '* General BA activity', state: 'CA' },                        // a placeholder, not a store
  { id: 'x', name: 'Private Spot', state: 'CA', private: true },
  { id: 'n', name: 'Flowery NYC', state: 'NY' },
  { id: 'z', name: 'Closed Store', state: 'CA', active: false },
];
const build = (extra = {}) => plain(get('spRows')({
  stores: STORES, st: 'CA', todayIso: '2026-11-21',
  plans: [{ dispensary_id: 'a', territory: 'SoCal', team: ['Cesar', 'Jesse'] }, { dispensary_id: 'c', territory: 'SoCal', team: [] }],
  sales: [{ sales_key: 'goat global', net: 221802.4, orders: 31, last_order: '2026-11-18' }, { sales_key: 'lemonnade', net: 38045, orders: 9 }],
  visits: [{ dispensary_id: 'a', last_visit: '2026-10-14', visits: 7, edu: 0, pad: 5, last_by: 'Cesar Alquezada' },
           { dispensary_id: 'c', last_visit: '2026-11-18', visits: 12, edu: 2, last_edu: '2026-11-18', pad: 7 }],
  tasks: [{ dbId: 't1', account: 'Goat Global Westwood', kind: 'training', doneAt: null },
          { dbId: 't2', account: 'Goat Global Westwood', kind: 'visit', doneAt: '2026-11-20T10:00:00Z' },
          { dbId: 't3', account: 'Goat Global Westwood', kind: null, soNum: 'SO-9', doneAt: null }],
  taskStore: v => (v.account === 'Goat Global Westwood' ? 'a' : null),
  ...extra,
}));

test('rows: the board\'s real stores only, with plan, sales, visits and open tasks', () => {
  const rows = build();
  assert.deepEqual(rows.map(r => r.id).sort(), ['a', 'b', 'c', 'd']);   // no placeholder, private, other state or inactive
  const a = rows.find(r => r.id === 'a');
  assert.equal(a.territory, 'SoCal');
  assert.deepEqual(a.team, ['Cesar', 'Jesse']);
  assert.equal(a.sales, 221802.4);
  assert.equal(a.salesShared, 2);                // Goat Global's sales account covers two stores
  assert.equal(a.daysSince, 38);
  assert.equal(a.edu, 0); assert.equal(a.pad, 5);
  assert.deepEqual(a.tasks.map(t => t.dbId), ['t1']);   // done and delivery tasks don't count as open
  const d = rows.find(r => r.id === 'd');
  assert.equal(d.sales, null);                   // no sales row (or not a manager): no figure, not $0
  assert.equal(d.daysSince, null);
  assert.deepEqual(d.team, []);
});

test('sales: the stores the sales app links an account to, else the sales_key; shared accounts say so', () => {
  const rows = build({ sales: [
    // linked by the sales app to a (Westwood) only, though b shares its sales_key
    { sales_key: 'goat global', net: 100, orders: 2, last_order: '2026-11-10', dispensary_ids: ['a'] },
    // a second account linked to a and to d: adds up on a, shared on d
    { sales_key: 'goat global wholesale', net: 50, orders: 1, last_order: '2026-11-12', dispensary_ids: ['a', 'd', 'n'] },
    // an account saved without links: joined by sales_key
    { sales_key: 'lemonnade', net: 38045, orders: 9, dispensary_ids: null },
    // linked to no store of the board (a distributor): shown nowhere, even where a sales_key would match
    { sales_key: 'kush alley', net: 7, orders: 1, dispensary_ids: [] },
  ] });
  const by = id => rows.find(r => r.id === id);
  assert.equal(by('a').sales, 150); assert.equal(by('a').orders, 3); assert.equal(by('a').lastOrder, '2026-11-12');
  assert.equal(by('a').salesShared, 2);           // the wholesale account is shared with d (n is another state's store)
  assert.equal(by('b').sales, null);              // same sales_key, but the sales app doesn't link it
  assert.equal(by('d').sales, 50); assert.equal(by('d').salesShared, 2);   // not the unlinked 'kush alley' 7
  assert.equal(by('c').sales, 38045); assert.equal(by('c').salesShared, 1);
});

test('filters: territory, person, training, recency, open tasks; search by name or address', () => {
  const f = get('spFilter'), rows = build();
  const ids = x => plain(x).map(r => r.id);
  assert.deepEqual(ids(f(rows, { territory: 'SoCal', sort: 'name' })), ['a', 'c']);
  assert.deepEqual(ids(f(rows, { territory: '~none', sort: 'name' })), ['b', 'd']);
  assert.deepEqual(ids(f(rows, { person: 'Jesse' })), ['a']);
  assert.deepEqual(ids(f(rows, { person: '~none', sort: 'name' })), ['b', 'd', 'c']);
  assert.deepEqual(ids(f(rows, { show: 'noedu', sort: 'name' })), ['b', 'a', 'd']);
  assert.deepEqual(ids(f(rows, { show: 'd30', sort: 'name' })), ['b', 'a', 'd']);   // never visited counts as 30+ days
  assert.deepEqual(ids(f(rows, { show: 'd60', sort: 'name' })), ['b', 'd']);
  assert.deepEqual(ids(f(rows, { show: 'never', sort: 'name' })), ['b', 'd']);
  assert.deepEqual(ids(f(rows, { show: 'tasks' })), ['a']);
  assert.deepEqual(ids(f(rows, { q: 'westwood blvd' })), ['a']);
  assert.deepEqual(ids(f(rows, { q: 'kush' })), ['d']);
});

test('sorts: sales (unknown last), longest since a visit (never first), most recent, name', () => {
  const f = get('spFilter'), rows = build();
  const ids = x => plain(x).map(r => r.id);
  assert.deepEqual(ids(f(rows, { sort: 'sales' })), ['b', 'a', 'c', 'd']);   // a shared account: same figure, then by name
  // a shared account ranks by each store's share: $60,000 over two stores is $30,000 each, under Lemonnade's
  // $38,045 on one store, though each card still shows the whole $60,000
  const shared = build({ sales: [{ sales_key: 'goat global', net: 60000, orders: 8 }, { sales_key: 'lemonnade', net: 38045, orders: 9 }] });
  assert.deepEqual(ids(f(shared, { sort: 'sales' })), ['c', 'b', 'a', 'd']);
  assert.equal(plain(shared).find(r => r.id === 'a').sales, 60000);
  assert.deepEqual(ids(f(rows, { sort: 'longest' })), ['b', 'd', 'a', 'c']);
  assert.deepEqual(ids(f(rows, { sort: 'recent' })), ['c', 'a', 'b', 'd']);
  assert.deepEqual(ids(f(rows, { sort: 'name' })), ['b', 'a', 'd', 'c']);
});

test('days since a visit: never negative, and in words', () => {
  // a record dated after today (hours entered ahead) counts as a visit today
  const rows = build({ visits: [{ dispensary_id: 'a', last_visit: '2026-11-25', visits: 1, edu: 0, pad: 0 }] });
  assert.equal(rows.find(r => r.id === 'a').daysSince, 0);
  const ago = get('spAgo');
  assert.equal(ago(0), 'today'); assert.equal(ago(1), 'yesterday'); assert.equal(ago(38), '38 days ago');
  assert.equal(ago(-3), 'today'); assert.equal(ago(null), '');
});

test('a team after a bulk change: add, whole team, take off, hand over', () => {
  const edit = (...a) => plain(get('spTeamEdit')(...a));
  assert.deepEqual(edit(['Cesar', 'Jesse'], 'add', ['Jesse', 'Keelin']), ['Cesar', 'Jesse', 'Keelin']);
  assert.deepEqual(edit(['Cesar', 'Jesse'], 'whole', ['Keelin']), ['Keelin']);
  assert.deepEqual(edit(['Cesar', 'Jesse'], 'remove', ['Jesse', 'Nobody Here']), ['Cesar']);
  assert.deepEqual(edit(['Jesse'], 'remove', ['Jesse']), []);
  // hand over: the people picked take the place of the one handing over, in their spot, never twice
  assert.deepEqual(edit(['Cesar', 'Jesse', 'Ledy'], 'swap', ['Keelin'], 'Jesse'), ['Cesar', 'Keelin', 'Ledy']);
  assert.deepEqual(edit(['Cesar', 'Jesse', 'Ledy'], 'swap', ['Ledy', 'Keelin'], 'Jesse'), ['Cesar', 'Ledy', 'Keelin']);
  assert.deepEqual(edit(['Jesse', 'Cesar'], 'swap', ['Cesar'], 'Jesse'), ['Cesar']);
  // a team without that person is left exactly as it is
  assert.deepEqual(edit(['Cesar', 'Ledy'], 'swap', ['Keelin'], 'Jesse'), ['Cesar', 'Ledy']);
  assert.deepEqual(edit([], 'swap', ['Keelin'], 'Jesse'), []);
  // odd input: no team yet, blanks, a name twice, an unknown change
  assert.deepEqual(edit(null, 'add', ['Keelin', '', 'Keelin']), ['Keelin']);
  assert.deepEqual(edit(['Cesar', 'Cesar', null], 'remove', []), ['Cesar']);
  assert.deepEqual(edit(['Cesar'], 'nothing', ['Keelin']), ['Cesar']);
  // the team handed in is never changed in place
  const team = ['Cesar', 'Jesse']; get('spTeamEdit')(team, 'remove', ['Jesse']); assert.deepEqual(team, ['Cesar', 'Jesse']);
});

test('a task\'s own time reads like the calendar\'s', () => {
  const c = get('schedClock');
  assert.deepEqual(plain(c('14:30')), { mins: 870, label: '2:30 PM' });
  assert.deepEqual(plain(c('09:00')), { mins: 540, label: '9 AM' });
  assert.deepEqual(plain(c('00:15')), { mins: 15, label: '12:15 AM' });
  assert.equal(c(''), null);
  assert.equal(c('25:00'), null);
});
