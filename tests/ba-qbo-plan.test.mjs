// BA Field app (ba/index.html): "Book in QuickBooks" (ba/docs/qbo-reimbursements.md, 2026-11-21). Runs the page's own
// QBO PLAN MODEL block, sliced out of the file into a vm with the payment helpers it uses. Synthetic rows only; nothing
// here reads or writes a database, QuickBooks or Gusto.
//   node --test tests/ba-qbo-plan.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../ba/index.html', import.meta.url), 'utf8');
const between = (start, end) => { const a = html.indexOf(start), b = html.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return html.slice(a, b); };
const s = { Set, Map, Date, String, Number, Array, Math, Object, JSON };
vm.createContext(s);
vm.runInContext(between('const isCoPaid = p =>', '/* ─────────────────────────── helpers'), s);   // isCoPaid, isBooks
vm.runInContext(between('/* ── QBO PLAN MODEL ── */', '/* ── end QBO PLAN MODEL ── */'), s);
const get = name => vm.runInContext(name, s);
const plain = x => JSON.parse(JSON.stringify(x));

const SETUP = {
  company: 'filifera', label: 'Filifera LLC', realm: 'R-FILIFERA',
  credit: { id: '201', name: 'Reimbursements' },
  mileage: { id: '181', name: 'Cost of goods sold:Mileage Reimbursement' },
  categories: {
    'Travel/Parking/Tolls': { id: '123', name: 'Vehicle expenses:Parking & tolls' },
    Meals: { id: '45', name: 'Meals' }, 'Food for retailer': { id: '45', name: 'Meals' },
    Supplies: { id: '46', name: 'Office expenses' }, Events: { id: '1150040036', name: 'Events' },
    Lodging: '1150040026',                                              // a bare id is named from the accounts list
  },
  accounts: [
    { id: '181', name: 'Cost of goods sold:Mileage Reimbursement' }, { id: '123', name: 'Vehicle expenses:Parking & tolls' },
    { id: '124', name: 'Vehicle expenses:Vehicle gas & fuel' }, { id: '45', name: 'Meals' }, { id: '46', name: 'Office expenses' },
    { id: '1150040036', name: 'Events' }, { id: '1150040026', name: 'Travel:Lodgings' }, { id: '113', name: 'Travel:Airfare' },
  ],
  classes: [{ id: '1000000001', name: 'BA' }, { id: '666946', name: 'Sales' }],
  next_doc: 123138,
};
const PERSON = { profile_id: 'u1', company: 'filifera', gusto_uuid: 'g-cesar', gusto_name: 'Cesar Alquezada', department: 'BA Hourly',
  class: { id: '1000000001', name: 'BA' }, doc_name: 'Cesar', how: 'gusto_name', problem: null };
const PER = { id: 'p-nov7', start_date: '2026-11-07', end_date: '2026-11-20', label: 'Nov 7 – Nov 20' };
const PUFF = 'PUFFCON 2026 (10/3/26)';
const U = '5d0c9a6e-1b2c-4d3e-8f90-0a1b2c3d4e5f';                            // receipts are stored as "<uuid>/<file>"
const R = f => U + '/' + f;
const T = [
  { id: 't1', status: 'approved', amount: 12.3, trip_date: '2026-11-09', dest_label: 'Buzz Santee' },
  { id: 't2', status: 'approved', amount: '0.10', trip_date: '2026-11-10' },
  { id: 't3', status: 'draft', amount: 50, trip_date: '2026-11-11' },
  { id: 't4', status: 'approved', amount: 0.2, trip_date: '2026-11-12' },
];
const E = [
  { id: 'e1', status: 'approved', payment: 'reimbursement', category: 'Travel/Parking/Tolls', amount: 20.1, receipt_path: R('r1.jpg'), expense_date: '2026-11-08', vendor: 'Impark' },
  { id: 'e2', status: 'approved', payment: 'reimbursement', category: 'Meals', amount: 15.55, receipt_path: R('r2.jpg'), expense_date: '2026-11-09' },
  { id: 'e3', status: 'approved', payment: 'reimbursement', category: 'Food for retailer', amount: 9.45, receipt_path: R('r3.jpg'), expense_date: '2026-11-09' },
  { id: 'e4', status: 'approved', payment: 'company', category: 'Supplies', amount: 99, receipt_path: R('r4.jpg'), expense_date: '2026-11-10' },
  { id: 'e5', status: 'approved', payment: 'company', category: 'Events', amount: 50, receipt_path: R('r5.jpg'), source: 'books', expense_date: '2026-11-10' },
  { id: 'e6', status: 'approved', payment: 'reimbursement', category: 'Events', amount: 58.78, receipt_path: R('r6.jpg'), event_name: PUFF, expense_date: '2026-11-11' },
  { id: 'e7', status: 'approved', payment: 'reimbursement', category: 'Flights', amount: 210, receipt_path: R('r7.pdf'), expense_date: '2026-11-12' },
  { id: 'e8', status: 'submitted', payment: 'reimbursement', category: 'Meals', amount: 47.79, receipt_path: R('r8.jpg'), expense_date: '2026-11-13' },
  { id: 'e9', status: 'approved', payment: 'company_bank', category: 'Lodging', amount: 400, receipt_path: R('r1.jpg'), expense_date: '2026-11-14' },   // same file as e1
  { id: 'e10', status: 'approved', payment: 'reimbursement', category: 'Events', amount: 11.22, receipt_path: null, event_name: '  ' + PUFF + ' ', expense_date: '2026-11-15' },
  // company-paid, approved, with a receipt_path the app never wrote: never sent to the Mac
  { id: 'e11', status: 'approved', payment: 'company', category: 'Supplies', amount: 5, receipt_path: '../timesheets/2026-11-01_someone.pdf', expense_date: '2026-11-16' },
  { id: 'e12', status: 'approved', payment: 'company', category: 'Supplies', amount: 5, receipt_path: R('../../odometer/x.jpg'), expense_date: '2026-11-16' },
  { id: 'e13', status: 'approved', payment: 'company', category: 'Supplies', amount: 5, receipt_path: R('..'), expense_date: '2026-11-16' },
  { id: 'e14', status: 'approved', payment: 'company', category: 'Supplies', amount: 5, receipt_path: 'r14.jpg', expense_date: '2026-11-16' },
];
const plan = (o = {}) => get('qboPlan')({ T, E, taken: new Set(), setup: SETUP, person: PERSON, ...o });
const KEYS = get('qboPersonKeys')({ fullName: 'Cesar Alquezada', person: PERSON });   // PERSON's name keys, as the page builds them
const linesOf = p => plain(p.lines).map(l => [l.account ? l.account.id : '?' + l.category, l.description, l.cents]);

test('bookable: approved trips and approved expenses the person paid; never company-paid, the books\' rows or held items', () => {
  const p = plan();
  assert.deepEqual(plain(p.items).map(i => i.key).sort(), ['expense:e1', 'expense:e10', 'expense:e2', 'expense:e3', 'expense:e6', 'expense:e7', 'trip:t1', 'trip:t2', 'trip:t4']);
  // a live booking holds e1 and t1; a released one (live false) holds nothing
  const taken = get('qboTaken')([{ booking_id: 'b1', kind: 'expense', item_id: 'e1', live: true }, { booking_id: 'b1', kind: 'trip', item_id: 't1', live: true },
    { booking_id: 'b0', kind: 'expense', item_id: 'e2', live: false }]);
  const q = plan({ taken });
  assert.ok(!q.items.some(i => i.id === 'e1' || i.id === 't1'));
  assert.ok(q.items.some(i => i.id === 'e2'));                       // released by a failed, cancelled, expired or undone booking
  // a missing payment is the person's own (the database only refuses company and company_bank)
  const r = get('qboPlan')({ T: [], E: [{ id: 'x', status: 'approved', payment: null, category: 'Meals', amount: 5 }], setup: SETUP, person: PERSON });
  assert.equal(r.items.length, 1);
});

test('lines: one per (account, event); mileage first; two categories on one account share a line; tagged amounts are their own line', () => {
  const p = plan();
  assert.deepEqual(linesOf(p), [
    ['181', '', 1260],                                                // 12.30 + 0.10 + 0.20 trips, mileage first
    ['1150040036', 'Event: ' + PUFF, 7000],                           // e6 + e10 (trimmed), tagged: their own line
    ['45', '', 2500],                                                 // Meals 15.55 + Food for retailer 9.45
    ['123', '', 2010],
    ['?Flights', '', 21000],                                          // no default: waits for a pick, last
  ]);
  const ev = p.lines.find(l => l.description);
  assert.equal(ev.items.length, 2);
  assert.ok(p.lines[0].mileage && !p.lines[1].mileage);
  assert.equal(p.lines.find(l => l.account && l.account.id === '45').account.name, 'Meals');
});

test('needsPick: an item with no default blocks the plan until it gets an account; a class is needed too', () => {
  const p = plan();
  assert.deepEqual(plain(p.needsPick), ['expense:e7']);
  assert.equal(p.ready, false);
  assert.equal(p.lines.at(-1).pick, true);
  assert.equal(p.lines.at(-1).category, 'Flights');
  const ok = plan({ overrides: { items: { 'expense:e7': { id: '113', name: 'Travel:Airfare' } } } });
  assert.deepEqual(plain(ok.needsPick), []);
  assert.equal(ok.ready, true);
  // no class from Gusto: not ready until one is picked on the card
  const noCls = plan({ person: { ...PERSON, class: null }, overrides: { items: { 'expense:e7': '113' } } });
  assert.equal(noCls.ready, false);
  assert.equal(noCls.cls, null);
  const picked = plan({ person: { ...PERSON, class: null }, cls: { id: '666946', name: 'Sales' }, overrides: { items: { 'expense:e7': '113' } } });
  assert.equal(picked.ready, true);
  assert.equal(picked.cls.name, 'Sales');
  // no setup, no name for the number, no credit account: never ready
  assert.equal(plan({ setup: null }).ready, false);
  assert.equal(plan({ person: { ...PERSON, doc_name: '' }, overrides: { items: { 'expense:e7': '113' } } }).ready, false);
  assert.equal(plan({ setup: { ...SETUP, credit: null }, overrides: { items: { 'expense:e7': '113' } } }).ready, false);
});

test('the JE\'s name: the first word of the profile\'s name as the page shows it (the Mac\'s rule), else the stored doc_name', () => {
  // a person who renamed themselves in the app books under the new name at once, not the Mac's last refresh
  assert.equal(plan({ fullName: 'Leticia Granados', person: { ...PERSON, doc_name: 'Leti' } }).docName, 'Leticia');
  assert.equal(plan({ fullName: '  Cesar  Alquezada ' }).docName, 'Cesar');
  assert.equal(plan({ fullName: '', person: { ...PERSON, doc_name: 'Cesar' } }).docName, 'Cesar');    // no name in the app
  assert.equal(plan({ fullName: null, person: { ...PERSON, doc_name: ' Cesar ' } }).docName, 'Cesar');
  assert.equal(plan({ fullName: '', person: { ...PERSON, doc_name: '' } }).docName, '');
  const p = plan({ fullName: 'Makkena Luffborough', overrides: { items: { 'expense:e7': '113' } } });
  assert.equal(get('qboRequestPlan')(p, null).doc_name, 'Makkena');                                   // the number uses the name as shown
  const d = get('qboDocNameOf');
  assert.equal(d('Leti Granados'), 'Leti'); assert.equal(d('  Drew '), 'Drew'); assert.equal(d(null), ''); assert.equal(d(''), '');
});

test('name key: accents off, lowercased, letters only, then the aliases; the same for a JE number and a person', () => {
  const k = get('qboNameKey');
  assert.equal(k('Makénna  O\'Neil'), 'makennaoneil');
  assert.equal(k('Makkena'), 'makenna');                                // the alias: Gianni's two JEs typed Makkena
  assert.equal(k('MAKKENA'), 'makenna');
  assert.equal(k('CÉSAR'), 'cesar');
  assert.equal(k('Jo3'), 'jo');                                         // digits are not letters
  assert.equal(k('Mary-Jane'), 'maryjane');
  assert.equal(k(null), '');
});

test('too old: a period that ended more than 400 days ago (what ba_qbo_request() refuses) is never booked here', () => {
  const old = get('qboTooOld');
  assert.equal(old({ end_date: '2025-10-17' }, '2026-11-21'), false);   // exactly 400 days: still bookable
  assert.equal(old({ end_date: '2025-10-16' }, '2026-11-21'), true);
  assert.equal(old({ end_date: '2026-11-20' }, '2026-11-21'), false);
  assert.equal(old(null, '2026-11-21'), false);
  assert.equal(old({ end_date: '2025-01-01' }, ''), false);
});

test('overrides: by line (its base key) or by item; the item\'s own wins; names come from the company\'s accounts', () => {
  // the parking line moves to gas & fuel by its base key, a bare id named from the list
  const byLine = plan({ overrides: { lines: { 'a123|': '124' } } });
  assert.deepEqual(linesOf(byLine).find(l => l[0] === '124'), ['124', '', 2010]);
  assert.equal(byLine.lines.find(l => l.account && l.account.id === '124').account.name, 'Vehicle expenses:Vehicle gas & fuel');
  assert.ok(!byLine.lines.some(l => l.account && l.account.id === '123'));
  // a pick line can be answered by its base key too: every Flights item without its own account takes it
  const pickLine = plan({ overrides: { lines: { '?Flights|': { id: '113', name: 'Travel:Airfare' } } } });
  assert.deepEqual(plain(pickLine.needsPick), []);
  // one Meals item moved on its own; the item override beats a line override on the same line
  const byItem = plan({ overrides: { lines: { 'a45|': '46' }, items: { 'expense:e3': '123' } } });
  // (lines after mileage go by account name: Office expenses, then Vehicle expenses:Parking & tolls)
  assert.deepEqual(linesOf(byItem).filter(l => ['46', '123'].includes(l[0])), [['46', '', 1555], ['123', '', 2955]]);
  // moving the tagged event cost to another account keeps its description (its own line there)
  const ev = plan({ overrides: { items: { 'expense:e6': '45' } } });
  assert.ok(linesOf(ev).some(l => l[0] === '45' && l[1] === 'Event: ' + PUFF && l[2] === 5878));
  assert.ok(linesOf(ev).some(l => l[0] === '1150040036' && l[2] === 1122));
});

test('cents: amounts are summed in whole cents, exactly, the way ba_qbo_request() checks them', () => {
  const c = get('qboCents');
  assert.equal(c(0.1) + c(0.2), 30);
  assert.equal(c('12.345'), 1235);            // half away from zero, like Postgres round(x, 2)
  assert.equal(c('-12.345'), -1235);
  assert.equal(c(1.005), 101);
  assert.equal(c('7'), 700); assert.equal(c('.5'), 50); assert.equal(c(null), 0); assert.equal(c('abc'), 0); assert.equal(c('1e2'), 10000);
  const p = plan({ overrides: { items: { 'expense:e7': '113' } } });
  assert.equal(p.cents, 1260 + 7000 + 2500 + 2010 + 21000);
  assert.equal(p.lines.reduce((a, l) => a + l.cents, 0), p.cents);
  const req = plain(get('qboRequestPlan')(p, { how: 'payday', note: 'Payday 11/25, from Gusto' }));
  assert.equal(req.total, 337.7);
  assert.equal(req.lines[0].amount, 12.6);                       // not 12.600000000000001
  const sum = req.lines.reduce((a, l) => a + Math.round(l.amount * 100), 0);
  assert.equal(sum, 33770);
  assert.equal(req.items.reduce((a, i) => a + Math.round(i.amount * 100), 0), 33770);
  for (const x of [...req.lines, ...req.items]) assert.match(String(x.amount), /^\d+(\.\d{1,2})?$/);
  // a zero item is held but makes no JE line; a line below zero is a problem, never a debit
  const z = get('qboPlan')({ T: [{ id: 'z', status: 'approved', amount: 0 }, { id: 'y', status: 'approved', amount: 5 }], E: [], setup: SETUP, person: PERSON });
  const zr = plain(get('qboRequestPlan')(z, null));
  assert.equal(zr.items.length, 2);
  assert.equal(zr.lines.length, 1);
  const neg = get('qboPlan')({ T: [], E: [{ id: 'n', status: 'approved', payment: 'reimbursement', category: 'Meals', amount: -4 }, { id: 'm', status: 'approved', payment: 'reimbursement', category: 'Supplies', amount: 9 }], setup: SETUP, person: PERSON });
  assert.equal(neg.ready, false);
  assert.equal(neg.problems.length, 1);
});

test('the request: the shape the SQL comments give, with accounts as {id, name}', () => {
  const p = plan({ overrides: { items: { 'expense:e7': '113' } } });
  const req = plain(get('qboRequestPlan')(p, { how: 'payday', note: 'Payday 11/25, from Gusto' }));
  assert.deepEqual(Object.keys(req).sort(), ['checked_jes', 'class', 'credit', 'date_how', 'date_note', 'doc_name', 'full', 'items', 'lines', 'receipts', 'total']);
  assert.deepEqual(req.checked_jes, []);                                // Book all ready: nothing confirmed
  // the JEs to check Gianni booked past on the card ("Book anyway?"): their ids, as strings, once each
  assert.deepEqual(plain(get('qboRequestPlan')(p, null, ['6751', 6752, '6751', null, ''])).checked_jes, ['6751', '6752']);
  assert.equal(req.doc_name, 'Cesar');
  assert.deepEqual(req.class, { id: '1000000001', name: 'BA' });
  assert.deepEqual(req.credit, { id: '201', name: 'Reimbursements' });
  assert.equal(req.date_how, 'payday');
  assert.deepEqual(req.items.find(i => i.id === 'e7'), { kind: 'expense', id: 'e7', amount: 210, account: { id: '113', name: 'Travel:Airfare' }, description: '' });
  assert.deepEqual(req.items.find(i => i.id === 't1'), { kind: 'trip', id: 't1', amount: 12.3, account: { id: '181', name: 'Cost of goods sold:Mileage Reimbursement' }, description: '' });
  assert.deepEqual(req.lines.find(l => l.description), { account: { id: '1150040036', name: 'Events' }, amount: 70, description: 'Event: ' + PUFF });
  assert.equal(new Set(req.items.map(i => i.kind + i.id)).size, req.items.length);   // nothing listed twice
});

test('receipts: a full booking takes every APPROVED expense\'s receipt (company-paid too, not the books\'); a partial one only its own', () => {
  const full = plan();
  assert.equal(full.full, true);
  // no r5 (books), no r8 (submitted, not approved), r1 once, and none of e11 to e14 (not "<uuid>/<file>")
  assert.deepEqual(plain(full.receipts), ['r1.jpg', 'r2.jpg', 'r3.jpg', 'r4.jpg', 'r6.jpg', 'r7.pdf'].map(R));
  const taken = get('qboTaken')([{ booking_id: 'b1', kind: 'expense', item_id: 'e1', live: true }]);
  const part = plan({ taken });
  assert.equal(part.full, false);
  assert.deepEqual(plain(part.receipts), ['r2.jpg', 'r3.jpg', 'r6.jpg', 'r7.pdf'].map(R));
  // a held item that isn't bookable anyway (a company-paid one can't be held) doesn't make it partial
  const odd = plan({ taken: get('qboTaken')([{ kind: 'expense', item_id: 'e4', live: true }]) });
  assert.equal(odd.full, true);
  // a bookable item whose receipt_path isn't one the app stored: the item is booked, its file never sent
  const bad = get('qboPlan')({ T: [], E: [{ id: 'x1', status: 'approved', payment: 'reimbursement', category: 'Meals', amount: 5, receipt_path: 'receipts/../timesheets/a.pdf' }], setup: SETUP, person: PERSON });
  assert.equal(bad.items.length, 1);
  assert.deepEqual(plain(bad.receipts), []);
  const ok = get('qboReceiptOk');
  assert.equal(ok(R('1731111111111-ab_c.JPG')), true);
  assert.equal(ok(U.toUpperCase() + '/x.png'), true);
  for (const p of [null, '', 'x.jpg', U, U + '/', U + '/a/b.jpg', U + '/..', U + '/.', '../' + U + '/a.jpg', U + '/a b.jpg', U + '/a%2e%2e.jpg', 'zz' + U.slice(2) + '/a.jpg'])
    assert.equal(ok(p), false, String(p));
});

const PAY = (o) => ({ company: 'filifera', processed: false, late: false, paid: {}, ...o });
test('date 1: the period\'s payroll hasn\'t run: its check date, from Gusto', () => {
  const d = get('qboDefaultDate')({ period: PER, paydays: [PAY({ period_start: '2026-11-07', period_end: '2026-11-20', check_date: '2026-11-25' })], gustoUuid: 'g-cesar', cents: 33770, today: '2026-11-21' });
  assert.deepEqual(plain(d), { date: '2026-11-25', how: 'payday', note: 'Payday 11/25, from Gusto' });
  const late = get('qboDefaultDate')({ period: PER, paydays: [PAY({ period_start: '2026-11-07', check_date: '2026-11-30', late: true })], cents: 1, today: '2026-11-21' });
  assert.equal(late.date, '2026-11-30');
  assert.match(late.note, /^Payday 11\/30, from Gusto \(Gusto has this payroll as late\)$/);
});

test('date 2: a payroll on or after the period\'s payday paid this exact amount, as a total or one line: that day', () => {
  const OCT = { id: 'p-oct24', start_date: '2026-10-24', end_date: '2026-11-06' };
  const rows = [
    PAY({ period_start: '2026-10-10', check_date: '2026-10-28', processed: true, paid: { 'g-cesar': { total: 120.5, lines: [120.5] } } }),   // before: never
    PAY({ period_start: '2026-10-24', check_date: '2026-11-10', processed: true, paid: { 'g-cesar': { total: 300, lines: [300] } } }),
    PAY({ period_start: '2026-11-07', check_date: '2026-11-25', processed: true, paid: { 'g-cesar': { total: 431.36, lines: [311.86, 119.5] } } }),
  ];
  const f = get('qboDefaultDate');
  assert.deepEqual(plain(f({ period: OCT, paydays: rows, gustoUuid: 'g-cesar', cents: 30000, today: '2026-11-21' })), { date: '2026-11-10', how: 'paid', note: 'Gusto paid this on 11/10' });
  assert.equal(f({ period: OCT, paydays: rows, gustoUuid: 'g-cesar', cents: 31186, today: '2026-11-30' }).date, '2026-11-25');   // a later line
  assert.equal(f({ period: OCT, paydays: rows, gustoUuid: 'g-cesar', cents: 43136, today: '2026-11-30' }).date, '2026-11-25');   // a later total
  assert.notEqual(f({ period: OCT, paydays: rows, gustoUuid: 'g-cesar', cents: 12050, today: '2026-11-30' }).how, 'paid');     // only on or after its own
  assert.notEqual(f({ period: OCT, paydays: rows, gustoUuid: 'g-other', cents: 30000, today: '2026-11-30' }).how, 'paid');     // someone else's money
});

test('date 2: Gusto paid it together with another period: their total less their JEs on that check date is this amount', () => {
  // Leti, Jun 20 - Jul 3: $1,206.00 approved; the 7/8 payroll paid her nothing; 7/22 paid one $2,004.80 line, which is this
  // plus Jul 4 - 17's $798.80, booked by hand as 2059 Leti on 7/22
  const JUN = { id: 'p-jun20', start_date: '2026-06-20', end_date: '2026-07-03' };
  const WP = o => PAY({ company: 'wafgus', ...o });
  const rows = [WP({ period_start: '2026-06-20', check_date: '2026-07-08', processed: true, paid: { 'g-drew': { total: 133.94, lines: [133.94] } } }),
    WP({ period_start: '2026-07-04', check_date: '2026-07-22', processed: true, paid: { 'g-leti': { total: '2004.80', lines: ['2004.80'] } } }),
    WP({ period_start: '2026-11-07', check_date: '2026-11-25' })];
  const jes = [{ company: 'wafgus', je_id: '6837', txn_date: '2026-07-22', doc_number: '2059 Leti', name_key: 'leti', total: '798.80', booking_id: 'b-2059' }];
  const f = get('qboDefaultDate');
  const leti = o => f({ period: JUN, paydays: rows, gustoUuid: 'g-leti', cents: 120600, today: '2026-11-21', jes, company: 'wafgus', nameKey: 'Leti', ...o });
  assert.deepEqual(plain(leti()), { date: '2026-07-22', how: 'paid', note: 'Gusto paid this on 7/22, with another period' });
  // without that JE (or someone else's, or another company's, or another day's) it is late, as before
  assert.equal(leti({ jes: [] }).how, 'late');
  assert.equal(leti({ jes: [{ ...jes[0], name_key: 'drew' }] }).how, 'late');
  assert.equal(leti({ jes: [{ ...jes[0], company: 'filifera' }] }).how, 'late');
  assert.equal(leti({ jes: [{ ...jes[0], txn_date: '2026-07-21' }] }).how, 'late');
  assert.equal(leti({ company: null }).how, 'late');
  // two JEs on that day: both come off; a cent off is no match
  assert.equal(leti({ jes: [{ ...jes[0], total: 700 }, { ...jes[0], je_id: '6838', total: 98.8 }] }).date, '2026-07-22');
  assert.equal(leti({ cents: 120601 }).how, 'late');
  // the person's key matches however the JE number wrote the name (accents, the Makkena alias)
  assert.equal(leti({ jes: [{ ...jes[0], name_key: 'LETÍ' }] }).date, '2026-07-22');
  assert.equal(leti({ nameKey: 'Makenna', jes: [{ ...jes[0], name_key: 'makkena' }] }).date, '2026-07-22');
  // an exact line or total on an earlier payroll still wins; and a payroll before the period's own never counts
  const early = [WP({ period_start: '2026-06-20', check_date: '2026-07-08', processed: true, paid: { 'g-leti': { total: 1206, lines: [1206] } } }), ...rows.slice(1)];
  assert.deepEqual(plain(leti({ paydays: early })), { date: '2026-07-08', how: 'paid', note: 'Gusto paid this on 7/8' });
  const before = [WP({ period_start: '2026-06-06', check_date: '2026-06-24', processed: true, paid: { 'g-leti': { total: 2004.8 } } }), rows[0], rows[2]];
  assert.equal(leti({ paydays: before, jes: [{ ...jes[0], txn_date: '2026-06-24' }] }).how, 'late');
});

test('date 3: it ran without paying this: late, the next payday that hasn\'t run (else the next one on the grid)', () => {
  const OCT = { id: 'p-oct24', start_date: '2026-10-24', end_date: '2026-11-06' };
  const f = get('qboDefaultDate');
  const rows = [PAY({ period_start: '2026-10-24', check_date: '2026-11-10', processed: true, paid: { 'g-cesar': { total: 99 } } }),
    PAY({ period_start: '2026-11-07', check_date: '2026-11-25' }), PAY({ period_start: '2026-11-21', check_date: '2026-12-09' })];
  assert.deepEqual(plain(f({ period: OCT, paydays: rows, gustoUuid: 'g-cesar', cents: 30000, today: '2026-11-21' })), { date: '2026-11-25', how: 'late', note: 'Late: next payday 11/25' });
  // no unprocessed payday read yet: the grid's next payday on or after today
  const only = [PAY({ period_start: '2026-10-24', check_date: '2026-11-10', processed: true })];
  const est = f({ period: OCT, paydays: only, gustoUuid: 'g-cesar', cents: 30000, today: '2026-11-21' });
  assert.deepEqual(plain(est), { date: '2026-11-25', how: 'late', note: 'Late: next payday 11/25 (estimated)' });
  assert.equal(f({ period: OCT, paydays: only, gustoUuid: 'g-cesar', cents: 30000, today: '2026-11-26' }).date, '2026-12-09');
});

test('date 4: no payday from Gusto: period end + 5 days, the bank day before a holiday (estimated)', () => {
  const f = get('qboDefaultDate');
  assert.deepEqual(plain(f({ period: PER, paydays: [], cents: 100, today: '2026-11-21' })), { date: '2026-11-25', how: 'estimated', note: 'Payday 11/25 (estimated)' });
  // Oct 24 - Nov 6: Wed Nov 11 is Veterans Day, so Tue Nov 10 (what Gusto did)
  assert.equal(f({ period: { start_date: '2026-10-24', end_date: '2026-11-06' }, paydays: [], cents: 100 }).date, '2026-11-10');
  // a row for another period is no row for this one
  assert.equal(f({ period: PER, paydays: [PAY({ period_start: '2026-10-24', check_date: '2026-11-10', processed: true })], cents: 1 }).how, 'estimated');
  const back = get('qboBankDayBack'), est = get('qboEstPayday');
  assert.equal(back('2026-12-25'), '2026-12-24');      // Christmas (a Friday)
  assert.equal(back('2027-07-05'), '2027-07-02');      // Independence Day observed on Monday: back past the weekend
  assert.equal(back('2026-11-28'), '2026-11-27');      // a Saturday
  assert.equal(back('2026-11-27'), '2026-11-27');      // the Friday after Thanksgiving is a bank day
  assert.equal(back('2026-11-26'), '2026-11-25');      // Thanksgiving
  assert.equal(back('2026-07-03'), '2026-07-03');      // Jul 4 2026 is a Saturday: the Friday stays a bank day
  assert.equal(est('2026-11-20'), '2026-11-25');
  for (const d of get('QBO_BANK_HOLIDAYS')) { const wd = new Date(d + 'T12:00:00Z').getUTCDay(); assert.ok(wd >= 1 && wd <= 5, d); }
  assert.equal(f({ period: null }), null);
});

test('Gusto paid: once the period\'s payroll has run, what it paid this person, and whether that is this amount', () => {
  const g = get('qboGustoPaid');
  const rows = [PAY({ period_start: '2026-11-07', check_date: '2026-11-25', processed: true, paid: { 'g-cesar': { total: 819.37, lines: [311.86, 507.51] } } })];
  assert.deepEqual(plain(g({ period: PER, paydays: rows, gustoUuid: 'g-cesar', cents: 81937 })), { date: '2026-11-25', cents: 81937, lines: [31186, 50751], same: true });
  assert.equal(g({ period: PER, paydays: rows, gustoUuid: 'g-cesar', cents: 50751 }).same, true);     // one of its lines
  assert.equal(g({ period: PER, paydays: rows, gustoUuid: 'g-cesar', cents: 70000 }).same, false);
  assert.deepEqual(plain(g({ period: PER, paydays: rows, gustoUuid: 'g-nobody', cents: 1 })), { date: '2026-11-25', cents: 0, lines: [], same: false });
  assert.equal(g({ period: PER, paydays: [PAY({ period_start: '2026-11-07', check_date: '2026-11-25' })], gustoUuid: 'g-cesar', cents: 1 }), null);   // not run yet
});

test('hand JEs: same company and name key, after the period ends and within 120 days, that no live booking holds (by je_id)', () => {
  const w = get('qboHandWarnings'), H = get('qboHeldJes');
  const jes = [
    { company: 'filifera', je_id: '6751', txn_date: '2026-11-25', doc_number: '123137 Cesar', name_key: 'cesar', total: 337.7, booking_id: null },
    { company: 'filifera', je_id: '6752', txn_date: '2026-12-09', doc_number: '123139 CESAR', name_key: 'CÉSAR', total: 10, booking_id: 'b-undone' },
    { company: 'filifera', je_id: '6753', txn_date: '2026-11-25', doc_number: '123140 Cesar', name_key: 'Cesar', total: 10, booking_id: 'b-live' },
    { company: 'filifera', je_id: '6754', txn_date: '2026-11-20', name_key: 'cesar', total: 10 },                          // on the last day: not after
    { company: 'filifera', je_id: '6755', txn_date: '2027-03-21', name_key: 'cesar', total: 10 },                          // 121 days on
    { company: 'filifera', je_id: '6756', txn_date: '2027-03-20', name_key: 'cesar', total: 10, booking_id: 'b-unknown' },  // day 120, unknown booking
    { company: 'wtny', je_id: '3066', txn_date: '2026-11-25', name_key: 'cesar', total: 10 },
    { company: 'filifera', je_id: '6757', txn_date: '2026-11-25', name_key: 'joanna', total: 10 },
    // ba_qbo_jes.booking_id names nothing, but a live booking of ANOTHER period carries the JE's id: held, no warning
    { company: 'filifera', je_id: '6758', txn_date: '2026-11-25', doc_number: '123141 Cesar', name_key: 'cesar', total: 10, booking_id: null },
    // its booking_id names a live booking, but no live booking carries its id (that booking holds another JE): a warning
    { company: 'filifera', je_id: '6759', txn_date: '2026-11-25', doc_number: '123142 Cesar', name_key: 'cesar', total: 10, booking_id: 'b-live' },
  ];
  const bookings = [
    { id: 'b-undone', company: 'filifera', je_id: '6752', status: 'undone' },
    { id: 'b-live', company: 'filifera', je_id: '6753', status: 'booked', period_id: 'p-nov7' },
    { id: 'b-other', company: 'filifera', je_id: '6758', status: 'undo_failed', period_id: 'p-oct24' },     // the JE is still there
    { id: 'b-ny', company: 'wtny', je_id: '6751', status: 'booked' },                                          // another company's 6751
    { id: 'b-q', company: 'filifera', je_id: null, status: 'queued' },
  ];
  const held = H(bookings);
  assert.deepEqual([...held].sort(), ['filifera|6753', 'filifera|6758', 'wtny|6751']);
  const out = plain(w({ jes, company: 'filifera', nameKey: 'Cesar', periodEnd: '2026-11-20', held }));
  assert.deepEqual(out.map(j => j.je_id), ['6751', '6759', '6752', '6756']);
  assert.deepEqual(plain(w({ jes, company: 'filifera', nameKey: '', periodEnd: '2026-11-20', held })), []);
  assert.deepEqual(plain(w({ jes, company: 'wtny', nameKey: 'cesar', periodEnd: '2026-11-20', held })).map(j => j.je_id), ['3066']);
  // the alias: a JE numbered "... Makkena" is Makenna's
  assert.deepEqual(plain(w({ jes: [{ company: 'filifera', je_id: '6626', txn_date: '2026-11-25', name_key: 'makkena', total: 1 }], company: 'filifera', nameKey: 'Makenna', periodEnd: '2026-11-20' })).map(j => j.je_id), ['6626']);
});

test('badges: in flight, in QuickBooks, then what the rest needs; "Ready to book" only when Book all ready takes them', () => {
  const b = get('qboBadge');
  const P = { company: 'filifera' };
  assert.equal(b({ bookings: [{ status: 'queued' }, { status: 'booked' }], cents: 100, person: P, ready: true }).label, 'Waiting for the Mac');
  assert.equal(b({ bookings: [{ status: 'undoing' }], cents: 0 }).k, 'wait');
  assert.deepEqual(plain(b({ bookings: [{ status: 'booked' }], cents: 4779, person: P })), { k: 'part', label: 'Part in QuickBooks' });
  assert.deepEqual(plain(b({ bookings: [{ status: 'booked', source: 'hand' }, { status: 'failed' }], cents: 0 })), { k: 'in', label: 'In QuickBooks' });
  assert.equal(b({ bookings: [{ status: 'undo_failed' }], cents: 0 }).k, 'in');            // the JE is still there
  assert.deepEqual(plain(b({ bookings: [{ status: 'undone' }, { status: 'expired' }], cents: 500, person: P, ready: true })), { k: 'ready', label: 'Ready to book' });
  // a JE to check: amber, whatever else holds (even with part of the period booked)
  assert.deepEqual(plain(b({ bookings: [], cents: 500, person: P, warnings: [{ je_id: '1' }], ready: false })), { k: 'check', label: 'Check QuickBooks' });
  assert.equal(b({ bookings: [{ status: 'booked' }], cents: 500, person: P, warnings: [{ je_id: '1' }] }).k, 'check');
  // nobody to book it under yet
  assert.deepEqual(plain(b({ bookings: [], cents: 500, person: null })), { k: 'link', label: 'Link to Gusto' });
  assert.equal(b({ bookings: [], cents: 500, person: { company: null } }).k, 'link');
  // something else for the card (an account, a class, a date to check): never "Ready to book"
  assert.deepEqual(plain(b({ bookings: [], cents: 500, person: P, ready: false })), { k: 'look', label: 'Needs a look' });
  // too old to book here: no tag, unless part of it is in QuickBooks already
  assert.equal(b({ bookings: [], cents: 500, person: P, warnings: [{ je_id: '1' }], tooOld: true, ready: true }), null);
  assert.equal(b({ bookings: [], cents: 500, person: null, tooOld: true }), null);
  assert.equal(b({ bookings: [{ status: 'booked' }], cents: 500, person: P, tooOld: true }).k, 'part');
  assert.equal(b({ bookings: [{ status: 'booked' }], cents: 0, tooOld: true }).k, 'in');
  assert.equal(b({ bookings: [], cents: 0 }), null);
  assert.equal(b({ bookings: [{ status: 'cancelled' }], cents: 0 }), null);
});

test('Book all ready: linked with a class, nothing to pick, no JE to check, a date from Gusto, not too old; otherwise the reasons', () => {
  const why = (o) => plain(get('qboReadyWhy')({ keys: KEYS, ...o }));
  const ok = plan({ overrides: { items: { 'expense:e7': '113' } } });
  const PD = { date: '2026-11-25', how: 'payday', note: 'Payday 11/25, from Gusto' };
  assert.deepEqual(why({ plan: ok, person: PERSON, setup: SETUP, warnings: [], date: PD }), []);
  assert.deepEqual(why({ plan: ok, person: PERSON, setup: SETUP, warnings: [], date: { date: '2026-11-10', how: 'paid', note: 'Gusto paid this on 11/10' } }), []);
  assert.deepEqual(why({ plan: plan(), person: PERSON, setup: SETUP, warnings: [], date: PD }), ['Flights needs an account']);
  assert.deepEqual(why({ plan: ok, person: { ...PERSON, company: null }, setup: SETUP, date: PD }), ['not linked to anyone in Gusto yet']);
  assert.deepEqual(why({ plan: ok, person: PERSON, setup: null, date: PD }), ['their QuickBooks company isn’t set up yet']);
  const noCls = plan({ person: { ...PERSON, class: null, problem: 'Getting their department from Gusto…' }, overrides: { items: { 'expense:e7': '113' } } });
  assert.deepEqual(why({ plan: noCls, person: { ...PERSON, class: null, problem: 'Getting their department from Gusto…' }, setup: SETUP, date: PD }), ['Getting their department from Gusto…', 'no class yet']);
  assert.deepEqual(why({ plan: ok, person: PERSON, setup: SETUP, warnings: [{ je_id: '1' }], date: PD }), ['QuickBooks has a JE to check first']);
  assert.deepEqual(why({ plan: get('qboPlan')({ T: [], E: [], setup: SETUP, person: PERSON }), person: PERSON, setup: SETUP, date: PD }), ['nothing to book']);
  // a date that isn't the period's payday or what Gusto paid: booked from the card, where Gusto's amount shows
  assert.deepEqual(why({ plan: ok, person: PERSON, setup: SETUP, date: { date: '2026-11-25', how: 'late', note: 'Late: next payday 11/25' } }),
    ['Gusto already ran this period’s payroll without paying exactly this, so check the date on the card']);
  assert.deepEqual(why({ plan: ok, person: PERSON, setup: SETUP, date: { date: '2026-11-25', how: 'estimated', note: 'Payday 11/25 (estimated)' } }),
    ['Gusto has no payday for this period, so its date is a guess: check it on the card']);
  assert.deepEqual(why({ plan: ok, person: PERSON, setup: SETUP, date: null }), ['no date yet']);
  // too old: the one reason, whatever else holds
  assert.deepEqual(why({ plan: plan(), person: null, setup: null, warnings: [{ je_id: '1' }], date: PD, tooOld: true }), ['older than the JEs the Mac reads from QuickBooks; book it by hand']);
  // no name key to check their JEs by (an empty set, or none given): never booked from Book all ready
  assert.deepEqual(why({ plan: ok, person: PERSON, setup: SETUP, warnings: [], date: PD, keys: new Set() }), ['No name to match their QuickBooks JEs']);
  assert.deepEqual(plain(get('qboReadyWhy')({ plan: ok, person: PERSON, setup: SETUP, warnings: [], date: PD })), ['No name to match their QuickBooks JEs']);
  assert.deepEqual(why({ plan: ok, person: PERSON, setup: SETUP, warnings: [], date: PD, keys: ['', '--', '2'] }), ['No name to match their QuickBooks JEs']);
  assert.deepEqual(why({ plan: plan(), person: PERSON, setup: SETUP, warnings: [], date: PD, keys: [] }), ['Flights needs an account', 'No name to match their QuickBooks JEs']);
  assert.deepEqual(why({ plan: ok, person: PERSON, setup: SETUP, warnings: [], date: PD, keys: ['Ces'] }), []);
});

// ── the name key set (shared with the Mac): one person, every name they have been booked under ──
test('name keys: the app first name, the last word of every booking\'s JE number (any source, status or period), the first word of the Name in Gusto', () => {
  const K = o => [...get('qboPersonKeys')(o)].sort();
  const dk = get('qboDocKey');
  assert.equal(dk('123138 Cesar'), 'cesar'); assert.equal(dk('  2059   Letí '), 'leti'); assert.equal(dk('PF-A95129A18E Makkena'), 'makenna');
  assert.equal(dk('123138'), ''); assert.equal(dk(''), ''); assert.equal(dk(null), ''); assert.equal(dk('2116 Mary-Jane'), 'maryjane');
  // Cesar renamed himself "Ces Alquezada": his old JEs' name still comes from his Gusto name and his bookings' numbers
  assert.deepEqual(K({ fullName: 'Ces Alquezada', person: PERSON }), ['ces', 'cesar']);
  assert.deepEqual(K({ fullName: 'Ces Alquezada', person: { ...PERSON, gusto_name: null },
    bookings: [{ doc_number: '2124 Cesar', source: 'hand', status: 'booked' }, { doc_number: '123137 César', status: 'undone' }, { doc_number: null }, { doc_number: '' }] }), ['ces', 'cesar']);
  // any period, any status: a failed booking's reserved number and an undone one's still name them
  assert.deepEqual(K({ fullName: 'Kenna Luffborough', person: { gusto_name: 'Makenna Luffborough' }, bookings: ['2116 Makkena', { doc_number: '123150 Kenna', status: 'failed' }] }), ['kenna', 'makenna']);
  // the Gusto name's first word, keyed the same way (accents off, the alias)
  assert.deepEqual(K({ fullName: 'Leti Granados', person: { gusto_name: '  Leticia  Granados' } }), ['leti', 'leticia']);
  // no letters anywhere: an empty set (the page offers no Book, the Mac refuses)
  assert.deepEqual(K({ fullName: '- Cesar', person: { gusto_name: '2 Cesar' }, bookings: ['123138'] }), []);
  assert.deepEqual(K({ fullName: '', person: null, bookings: [] }), []);
  assert.deepEqual(K({}), []);
  assert.deepEqual(K(null), []);
  // not the stored doc_name: the Mac's set doesn't have it either
  assert.deepEqual(K({ fullName: '', person: { doc_name: 'Cesar', gusto_name: null } }), []);
  // the set's own helper: names or keys, one more name, '' left out; a string is one name, not its letters
  const S = (k, n) => [...get('qboKeySet')(k, n)].sort();
  assert.deepEqual(S(new Set(['cesar', 'Ces']), 'Makkena'), ['ces', 'cesar', 'makenna']);
  assert.deepEqual(S('Cesar'), ['cesar']);
  assert.deepEqual(S(null, ''), []);
  assert.deepEqual(S(['', '7', null]), []);
  // a name like an Object property is a plain name, not an alias
  assert.equal(get('qboNameKey')('Constructor'), 'constructor');
  assert.equal(get('qboNameKey')('toString'), 'tostring');
});

test('hand JEs and the date by the key set: a rename in the app can\'t hide a JE under the old name', () => {
  const w = get('qboHandWarnings'), keysOf = get('qboPersonKeys');
  // live, 11/21: Cesar's Jul 18 - 31 ($575.45) is already in QuickBooks as 2124 Cesar (8/4), held by no booking
  const JUL = { end_date: '2026-07-31' };
  const jes = [{ company: 'filifera', je_id: '5489', txn_date: '2026-08-04', doc_number: '2124 Cesar', name_key: 'cesar', total: '575.45' },
    { company: 'filifera', je_id: '5490', txn_date: '2026-08-04', doc_number: '2125 Joanna', name_key: 'joanna', total: '10.00' }];
  const ids = o => plain(w({ jes, company: 'filifera', periodEnd: JUL.end_date, ...o })).map(j => j.je_id);
  assert.deepEqual(ids({ keys: keysOf({ fullName: 'Cesar Alquezada', person: PERSON }) }), ['5489']);
  assert.deepEqual(ids({ keys: keysOf({ fullName: 'Ces Alquezada', person: PERSON }) }), ['5489']);                       // by the Gusto name
  assert.deepEqual(ids({ keys: keysOf({ fullName: 'Ces Alquezada', person: { ...PERSON, gusto_name: 'C Alquezada' }, bookings: ['2083 Cesar'] }) }), ['5489']);   // by an old number
  assert.deepEqual(ids({ keys: keysOf({ fullName: 'Ces Alquezada', person: { ...PERSON, gusto_name: 'C Alquezada' } }) }), []);   // nothing names him Cesar
  assert.deepEqual(ids({ keys: new Set() }), []);
  assert.deepEqual(ids({ keys: ['joanna', 'cesar'] }), ['5489', '5490']);
  // the single name still works as before, and adds to the set
  assert.deepEqual(ids({ nameKey: 'Cesar' }), ['5489']);
  assert.deepEqual(ids({ keys: ['ces'], nameKey: 'Joanna' }), ['5490']);
  // rule 2 "with another period" counts the JEs under any of their names: Leti, renamed Leticia, still has 2059 Leti on 7/22
  const JUN = { id: 'p-jun20', start_date: '2026-06-20', end_date: '2026-07-03' };
  const WP = o => PAY({ company: 'wafgus', ...o });
  const rows = [WP({ period_start: '2026-06-20', check_date: '2026-07-08', processed: true, paid: {} }),
    WP({ period_start: '2026-07-04', check_date: '2026-07-22', processed: true, paid: { 'g-leti': { total: '2004.80', lines: ['2004.80'] } } }),
    WP({ period_start: '2026-11-07', check_date: '2026-11-25' })];
  const lj = [{ company: 'wafgus', je_id: '6837', txn_date: '2026-07-22', doc_number: '2059 Leti', name_key: 'leti', total: '798.80' }];
  const f = o => get('qboDefaultDate')({ period: JUN, paydays: rows, gustoUuid: 'g-leti', cents: 120600, today: '2026-11-21', jes: lj, company: 'wafgus', ...o });
  const leti = { gusto_name: 'Leti Granados' };
  assert.equal(f({ keys: keysOf({ fullName: 'Leticia Granados', person: leti }) }).note, 'Gusto paid this on 7/22, with another period');
  assert.equal(f({ keys: keysOf({ fullName: 'Leticia Granados', person: { gusto_name: 'Leticia Granados' }, bookings: [{ doc_number: '2059 Leti' }] }) }).how, 'paid');
  assert.equal(f({ keys: keysOf({ fullName: 'Leticia Granados', person: { gusto_name: 'Leticia Granados' } }) }).how, 'late');
  assert.equal(f({ keys: new Set() }).how, 'late');
});

// ── outside the model: the guard's words, and the review fixes' wiring (the e2e harness drives them on the real page) ──
const fnSrc = name => { const a = html.indexOf(name); assert.ok(a >= 0, name); const b = html.indexOf('\n}\n', a); return html.slice(a, b + 2); };

test('the guard\'s words: every refusal of ba_qbo_held_msg() is shown as it is, by status; any other error is not one', () => {
  const line = html.split('\n').find(l => l.startsWith('const qboRefusal = e =>'));
  assert.ok(line);
  const ctx = {}; vm.createContext(ctx); vm.runInContext(line.replace('const qboRefusal', 'globalThis.qboRefusal'), ctx);
  const r = m => ctx.qboRefusal({ message: m });
  for (const m of [
    // booked (app), for a booker and for anyone else
    'This is in QuickBooks as JE 123138 Cesar. Undo the booking first.',
    'This is in QuickBooks as JE 123138 Cesar. Ask Gianni to undo that booking first.',
    // booked by hand
    "This is in QuickBooks as JE 2061 Chandler, booked by hand, so it can't change here. If that JE isn't for these items, use Not these items in their QuickBooks section.",
    "This period is in QuickBooks as JE 2061 Chandler, booked by hand, so it can't change here. Ask Gianni.",
    // queued
    'This is on its way to QuickBooks. Cancel that booking first.',
    'This period is on its way to QuickBooks. Ask Gianni to cancel that booking first.',
    // working, with the number the Mac took and before it took one
    'This is being booked in QuickBooks right now as JE 123138 Cesar, so try again in a few minutes.',
    'This period is being booked in QuickBooks right now as JE 123138 Cesar, so try again in a few minutes.',
    'This is being booked in QuickBooks right now, so try again in a few minutes.',
    // an undo asked or under way
    'This is being taken out of QuickBooks right now, so try again in a few minutes.',
    'This period is being taken out of QuickBooks right now, so try again in a few minutes.',
    // the words before 11/21's status change still read as the guard's
    'This is on its way to QuickBooks. Cancel or undo that booking first.']) assert.equal(r(m), m);
  for (const m of ['new row violates row-level security policy', 'Only Gianni can do this.', 'Some of these items are already in QuickBooks or on their way there. Open it again.',
    'It isn’t waiting anymore: the Mac already has it.', 'Only a JE this app booked can be undone here.', 'fake trips error', ''])
    assert.equal(r(m), '');
  assert.equal(ctx.qboRefusal(null), '');
  // Undo approval's "The period stays approved because part of it ..." follows the same words
  const a = html.indexOf('const qboPartWords = m =>'), b = html.indexOf("';\n", a);
  assert.ok(a >= 0 && b > a);
  vm.runInContext(html.slice(a, b + 2).replace('const qboPartWords', 'globalThis.qboPartWords'), ctx);
  const pw = m => ctx.qboPartWords(m);
  assert.equal(pw('This period is on its way to QuickBooks. Cancel that booking first.'), 'is on its way to QuickBooks');
  assert.equal(pw('This period is being booked in QuickBooks right now as JE 123138 Cesar, so try again in a few minutes.'), 'is being booked in QuickBooks right now');
  assert.equal(pw('This period is being booked in QuickBooks right now, so try again in a few minutes.'), 'is being booked in QuickBooks right now');
  assert.equal(pw('This period is being taken out of QuickBooks right now, so try again in a few minutes.'), 'is being taken out of QuickBooks right now');
  assert.equal(pw('This period is in QuickBooks as JE 123120 Amanda. Undo the booking first.'), 'is in QuickBooks');
  assert.equal(pw("This period is in QuickBooks as JE 2061 Chandler, booked by hand, so it can't change here. Ask Gianni."), 'is in QuickBooks');
});

// the row words of a booking, run from the page with its own esc, money and fmtDate (and a fixed clock for qboWhen)
const rowCtx = (() => {
  const c = { Number, String, Math, Array, Date, JSON, Object };
  vm.createContext(c);
  const lineOf = start => { const l = html.split('\n').find(x => x.startsWith(start)); assert.ok(l, start); return l.replace(/^const (\w+)\s*=/, 'globalThis.$1 ='); };
  for (const s of ['const money = n =>', 'const esc = s =>', 'const fmtDate = s =>', 'const qboPlural=', 'const qboNoteAsks=']) vm.runInContext(lineOf(s), c);
  vm.runInContext("globalThis.qboWhen = ts => ts ? '10:05 AM' : '';", c);
  for (const f of ['function qboBookingRowHtml(', 'function qboAllWords(']) vm.runInContext(fnSrc(f), c);
  return c;
})();
const textOf = h => h.replace(/<\/?(b|span)\b[^>]*>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();   // inline tags add no space
test('working and booked rows: the number the Mac took and its note (section and Book all ready); a booked JE\'s note is a check', () => {
  const sec = b => textOf(rowCtx.qboBookingRowHtml({ id: 'bk1', total: 88.91, txn_date: '2026-11-25', attachments: [], ...b }, 3));
  const all = b => rowCtx.qboAllWords({ id: 'bk1', ...b });
  const NOTE = "QuickBooks didn't answer while this was being booked as JE 123138 Cesar, so the Mac will look for it there in about 15 minutes and finish this then.";
  // working: no number yet, then the reserved number, then the Mac's note
  assert.equal(sec({ status: 'working' }), '⏳ The Mac is booking $88.91 now… Usually done within a minute.');
  assert.equal(sec({ status: 'working', doc_number: '123138 Cesar' }), '⏳ The Mac is booking $88.91 as JE 123138 Cesar now… Usually done within a minute.');
  assert.equal(sec({ status: 'working', doc_number: '123138 Cesar', detail: NOTE }), `⏳ The Mac is booking $88.91 as JE 123138 Cesar… ${NOTE}`);
  assert.equal(all({ status: 'working' }), '⏳ Booking now…');
  assert.equal(all({ status: 'working', doc_number: '123138 Cesar' }), '⏳ Booking as JE 123138 Cesar now…');
  assert.equal(textOf(all({ status: 'working', doc_number: '123138 Cesar', detail: NOTE })), `⏳ Booking as JE 123138 Cesar… ${NOTE}`);
  // the Mac's words are escaped
  assert.ok(!/<b>x/.test(rowCtx.qboBookingRowHtml({ id: 'b', status: 'working', total: 1, doc_number: '1 <b>x', detail: '<img src=x>' }, 0)));
  assert.ok(!/<img/.test(all({ status: 'working', detail: '<img src=x>' })));
  // booked by this app: its note (only when the Mac asks for a check), amber, beside Undo
  const CHECK = "Booked as JE 123138 Cesar, but this file didn't attach, so attach it in QuickBooks: 2026-11-12_receipt_UPS_251.37.jpg.";
  assert.equal(sec({ status: 'booked', source: 'app', doc_number: '123138 Cesar', attachments: [{}, {}] }), '✓ In QuickBooks: JE 123138 Cesar · Nov 25 · $88.91 2 files attached · 3 items Undo');
  const bk = rowCtx.qboBookingRowHtml({ id: 'bk1', status: 'booked', source: 'app', doc_number: '123138 Cesar', total: 88.91, txn_date: '2026-11-25', attachments: [{}], detail: CHECK }, 3);
  assert.match(bk, /<div class="qbo-warn"[^>]*>⚠ Booked as JE 123138 Cesar, but this file didn't attach/);
  assert.equal(textOf(bk), `✓ In QuickBooks: JE 123138 Cesar · Nov 25 · $88.91 1 file attached · 3 items ⚠ ${CHECK} Undo`);
  const GOOD = 'JE 123138 Cesar is in QuickBooks; the Mac attached all 3 files after a delay.';
  const ok = rowCtx.qboBookingRowHtml({ id: 'bk1', status: 'booked', source: 'app', doc_number: '123138 Cesar', total: 88.91, txn_date: '2026-11-25', attachments: [{}, {}, {}], detail: GOOD }, 3);
  assert.ok(!/qbo-warn/.test(ok) && !/⚠/.test(ok)); assert.match(ok, /class="muted"[^>]*>JE 123138 Cesar is in QuickBooks; the Mac attached all 3 files/);
  // a hand booking's note is the Mac's matching note, not a check: not shown (the row says it in its own words)
  assert.equal(sec({ status: 'booked', source: 'hand', doc_number: '2124 Cesar', detail: 'Booked by hand in QuickBooks; matched to these items by amount.' }),
    '✓ Booked by hand: JE 2124 Cesar · Nov 25 · $88.91 The Mac matched this JE to 3 items here. Not these items');
  assert.equal(textOf(all({ status: 'booked', doc_number: '123138 Cesar' })), '✓ Booked JE 123138 Cesar Undo');
  assert.match(all({ status: 'booked', doc_number: '123138 Cesar', detail: CHECK }), /<div class="qbo-warn">⚠ Booked as JE 123138 Cesar, but this file didn't attach/);
  assert.equal(textOf(rowCtx.qboAllWords({ id: 'bk1', status: 'booked', doc_number: '123138 Cesar', detail: CHECK }, false)), `✓ Booked JE 123138 Cesar ⚠ ${CHECK}`);   // after its Undo was pressed
});

test('the JE numbers for the name keys are read in pages of 1,000, numbers only, and an error stops the read', async () => {
  const src = fnSrc('async function qboLoadDocs(');
  const run = async (pages, fail) => {
    const calls = [];
    const sb = { from: t => { const st = { t, f: [] }; const q = {
      select: c => { st.cols = c; return q; }, not: (c, op, v) => { st.f.push(['not', c, op, v]); return q; }, eq: (c, v) => { st.f.push(['eq', c, v]); return q; },
      order: c => { st.order = c; return q; }, range: (a, z) => { st.range = [a, z]; calls.push(st); const p = a / 1000;
        return Promise.resolve(fail === p ? { data: null, error: { message: 'fake error' } } : { data: pages[p] || [], error: null }); } }; return q; } };
    const c = { supabase: sb, String, Error, Promise }; vm.createContext(c);
    vm.runInContext(src.replace('async function qboLoadDocs', 'globalThis.qboLoadDocs = async function'), c);
    return { calls, out: c.qboLoadDocs };
  };
  const page = (n, pre) => Array.from({ length: n }, (_, i) => ({ ba_id: 'u' + (i % 3), doc_number: i % 50 ? `${pre}${i} Cesar` : null }));
  const r = await run([page(1000, 'a'), page(1000, 'b'), page(7, 'c')]);
  const out = await r.out('u1');
  assert.equal(r.calls.length, 3);
  assert.deepEqual(r.calls.map(s => s.range), [[0, 999], [1000, 1999], [2000, 2999]]);
  assert.ok(r.calls.every(s => s.t === 'ba_qbo_bookings' && s.cols === 'ba_id,doc_number' && s.order === 'id'
    && JSON.stringify(s.f) === JSON.stringify([['not', 'doc_number', 'is', null], ['eq', 'ba_id', 'u1']])));
  assert.equal(out.length, 2007 - 41);   // the rows without a number (every 50th) are left out
  assert.ok(out.every(x => x.doc_number && Object.keys(x).join() === 'ba_id,doc_number'));
  const all = await run([page(3, 'x')]);
  await all.out(null);
  assert.deepEqual(all.calls[0].f, [['not', 'doc_number', 'is', null]]);   // everyone's (the Review list)
  const bad = await run([page(1000, 'a'), page(5, 'b')], 1);
  await assert.rejects(() => bad.out('u1'), e => !!e && e.message === 'fake error');
});

test('wiring: the key set wherever one name key was used, the numbers read with the rest, a reserved number heard', () => {
  // no single name key is left at any call: the section, the card, the Review list (its tags and Book all ready)
  assert.ok(!/nameKey:\s*(plan|P)\.docName/.test(html));
  const sec = fnSrc('function qboDrawSection(');
  assert.match(sec, /const keys=qboCtxKeys\(ctx\);/);
  assert.match(sec, /qboHandWarnings\(\{ jes:ctx\.jes, company:person\.company, keys, periodEnd:per\.end_date, held:ctx\.held \}\)/);
  assert.match(sec, /else if\(!keys\.size\) parts\.push\(`<div class="qbo-row" id="qboNoKey">/);   // no Book button without a key
  assert.ok(sec.indexOf('else if(!keys.size)') < sec.indexOf('data-qbo="book"'));
  const card = fnSrc('function qboBookCard(');
  assert.match(card, /const keys=qboCtxKeys\(ctx\);/);
  assert.match(card, /qboDefaultDate\(\{ period:per, paydays:ctx\.paydays, gustoUuid:person\.gusto_uuid, cents:P\.cents, today:todayISO\(\), jes:ctx\.jes, company:person\.company, keys, adjustments:ctx\.adjustments \}\)/);
  assert.match(card, /qboHandWarnings\(\{ jes:ctx\.jes, company:person\.company, keys, periodEnd:per\.end_date, held:ctx\.held \}\)/);
  assert.match(card, /if\(!keys\.size\) return QBO_NOKEY_WHY\+'\. Add their name in the app first\.';/);
  const sum = fnSrc('function qboPersonSummary(');
  assert.match(sum, /const keys=qboPersonKeys\(\{ fullName:b\.full_name, person, bookings:\(d\.docsBy\|\|\{\}\)\[b\.id\]\|\|\[\] \}\);/);
  assert.match(sum, /jes:d\.jes, company:co, keys, adjustments:\(d\.adjBy\|\|\{\}\)\[b\.id\]\|\|\[\] \}\);/);
  assert.match(sum, /qboHandWarnings\(\{ jes:d\.jes, company:co, keys, periodEnd:per\.end_date, held:d\.held \}\)/);
  assert.match(sum, /qboReadyWhy\(\{ plan, person, setup, warnings, date, tooOld, keys \}\)/);
  assert.match(html, /const qboCtxKeys=ctx=>qboPersonKeys\(\{ fullName:\(ctx\.prof\|\|\{\}\)\.full_name, person:ctx\.person, bookings:ctx\.docs \}\);/);
  // the numbers come with the person's and the period's other reads (a failed read fails the whole load)
  const lp = fnSrc('async function qboLoadPerson(');
  assert.match(lp, /const \[pp, st, bk, wk, docs\]=await Promise\.all\(\[/); assert.match(lp, /qboLoadDocs\(baId\),\n  \]\);/); assert.match(lp, /docs:\(docs\|\|\[\]\)/);
  const ld = fnSrc('async function qboLoadPeriod(');
  assert.match(ld, /const \[st, pp, bk, wk, tr, ex, pd, je, docs\]=await Promise\.all\(\[/); assert.match(ld, /qboLoadDocs\(null\),\n  \]\);/); assert.match(ld, /docsBy \};/);
  // following a booking hears the number the Mac reserves while it stays 'working'
  assert.match(fnSrc('async function qboTick('), /w\.last\.status!==row\.status \|\| w\.last\.detail!==row\.detail \|\| w\.last\.doc_number!==row\.doc_number/);
  // the card: the number and the note while working; a booked JE's note under it
  assert.match(card, /else if\(s==='working'\) html=`⏳ <b>The Mac is booking it\$\{r\.doc_number\?' as '\+je:''\}\$\{r\.detail\?'…':' now…'\}<\/b> \$\{r\.detail\?esc\(r\.detail\):'Each receipt takes a second or two to attach\.'\}`;/);
  assert.match(card, /\$\{r\.detail\?\(qboNoteAsks\(r\.detail\)\?`<div class="qbo-warn" id="qbStatusNote" style="margin-top:6px">⚠ \$\{esc\(r\.detail\)\}<\/div>`:`<div class="muted" id="qbStatusNote" style="margin-top:6px">\$\{esc\(r\.detail\)\}<\/div>`\):''\}\$\{btn\('undo','Undo'\)\}/);
  // the toast of a booked JE says the Mac left a note (the rows and the card show it in full)
  assert.match(fnSrc('function qboToastResult('), /toastAction\(`Booked \$\{je\} in QuickBooks\$\{b\.detail&&qboNoteAsks\(b\.detail\)\?', with a note from the Mac to check':''\}\.`, 'Undo', \(\)=>qboUndo\(b\), 12000\)/);
});

test('wiring: Approve late items for every admin, Undo approval item first, Book all ready rows after Undo, former Gusto people, typable Method', () => {
  // 7: the action row has it (single period, approved, a draft or submitted trip, expense or hours row); the QuickBooks
  // section no longer has a bookers-only copy
  const det = fnSrc('async function adminBaDetail(');
  assert.match(det, /const lateN=\(!allPer && S\.status==='approved'\) \? \[\.\.\.\(T\|\|\[\]\),\.\.\.\(E\|\|\[\]\),\.\.\.\(H\|\|\[\]\)\]\.filter\(x=>x\.status==='draft'\|\|x\.status==='submitted'\)/);
  assert.match(det, /id="approveLateBtn">Approve late items</);
  assert.match(det, /approveLateBtn'\)\.onclick=async\(\)=>\{ await flushGrid\(\$\('#admGrid'\)\); const c=gridCtx\(\); approveSubmission\(baId,per\.id,c\.T,c\.E,c\.H,'approved',\{ reopen:true \}\);/);
  assert.ok(!html.includes('data-qbo="approve"'));
  // 8: the item goes first (as on main), then the period; a QuickBooks refusal of the period keeps it approved
  const undo = fnSrc('async function undoApproval(');
  assert.ok(undo.indexOf("from(table).update({status:'submitted'})") < undo.indexOf("from('submissions')"));
  assert.match(undo, /The period stays approved because part of it \$\{qboPartWords\(qboRefusal\(e2\)\)\}; this item went back to submitted\./);
  // 10: a row's Undo lowers the booked count and follows the undo with a text-only watcher
  const all = fnSrc('function qboBookAllSheet(');
  assert.match(all, /booked=Math\.max\(0,booked-1\); tally\(\);/);
  assert.match(all, /qboWatch\(r\.id,'allu',row=>\{ rowsBy\[row\.id\]=row; setSt\(i, qboAllWords\(row, false\), clsOf\(row\)\);/);
  // 11: no active-only filter; the people who left are labeled
  const link = fnSrc('async function qboLinkPick(');
  assert.ok(!link.includes(".eq('active',true)"));
  assert.match(link, /\(left\)/);
  // 12: Method in the admin trip editor is type-to-search
  assert.match(html, /<select id="aMethod" data-searchable>/);
});

test('a booked note is amber only when it asks for something; a first name with no letters is never booked', () => {
  const asks = get('qboNoteAsks');
  assert.equal(asks('JE 123138 Cesar is in QuickBooks; the Mac attached all 3 files after a delay.'), false);
  assert.equal(asks("JE 123138 Cesar is in QuickBooks and the Mac attached its files after a delay, but this file didn't attach, so attach it in QuickBooks: a.jpg."), true);
  assert.equal(asks('The Mac stopped partway through, but JE 123138 Cesar is in QuickBooks with 1 file attached; check that every receipt is there.'), true);
  assert.equal(asks(null), false);
  const why = get('qboReadyWhy'), NONAME = get('QBO_NONAME_WHY');
  const plan = { cents: 1000, lines: [], items: [{}], cls: { id: '1' }, credit: { id: '201' }, docName: '-', problems: [] };
  const person = { company: 'filifera' }, setup = {}, date = { date: '2026-11-25', how: 'payday' };
  assert.ok(why({ plan, person, setup, date, keys: new Set(['cesar']) }).includes(NONAME));
  assert.ok(!why({ plan: { ...plan, docName: 'Cesar' }, person, setup, date, keys: new Set(['cesar']) }).includes(NONAME));
});
