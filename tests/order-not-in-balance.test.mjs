// Order Tracker: the figures shown beside the open balance (priced but not booked by the supplier,
// and estimates for orders with no price yet, bundles included), the double-count check that names
// the supplier's payment, and the type-to-search pick boxes. Run: node --test tests/order-*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../order-tracker.html', import.meta.url), 'utf8');
const source = html.split('<script>')[1].split('/* ---------- wiring ---------- */')[0];
const now = new Date(2026, 10, 16, 12).getTime();

const HEAD = ['Invoice No.', 'PO Number', 'Category', 'Desc.', 'Order Status', 'Ship Date', 'Due Date', 'QTY in Unit',
  'Total Price', 'Freight and Duty', 'Total including Freight', 'Paid to Date', 'Due', 'Not Yet Due', 'Comments'];
const KEY = { inv:'Invoice No.', po:'PO Number', category:'Category', desc:'Desc.', status:'Order Status', ship:'Ship Date',
  dueDate:'Due Date', qty:'QTY in Unit', product:'Total Price', freight:'Freight and Duty', total:'Total including Freight',
  paid:'Paid to Date', due:'Due', nyd:'Not Yet Due', comments:'Comments' };
const csv = (rows, pays = [], totals = null) => {
  const head = [...HEAD, ...pays.map(p => p.header)];
  const line = cells => cells.map(v => JSON.stringify(String(v ?? ''))).join(',');
  const out = [];
  if (totals) out.push(line([...HEAD.map(() => ''), ...pays.map(p => p.wire ?? '')]));
  out.push(line(head));
  for (const r of rows) out.push(line([...HEAD.map(h => { const k = Object.keys(KEY).find(x => KEY[x] === h); return r[k] ?? ''; }),
    ...pays.map(p => (r.pay || {})[p.header] ?? '')]));
  return out.join('\n');
};

function app(ca = [], ny = [], { asc = [], caPays = [], nyPays = [] } = {}) {
  const context = vm.createContext({ console, location: { hash: '#weekly' }, localStorage: { getItem: () => null } });
  vm.runInContext(source, context);
  const api = vm.runInContext(`({state,buildModel,rowPrice,unbookedFor,pricingFor,orderEstimatesFor,bundleShape,estimateBasisHtml,
    remainderOf,pendingCheck,computeAdjust,paymentsMeta,payDates,ledger,pickFrom,weeklyReportData,wkRangeFor,weeklySummaryText,
    weeklyEmailHtml,marketSheets})`, context);
  api.state.asc = asc;
  api.state.data.ca = api.buildModel(csv(ca, caPays, caPays.length ? true : null));
  api.state.data.ny = api.buildModel(csv(ny, nyPays, nyPays.length ? true : null));
  api.row = (inv, k = 'ny') => api.state.data[k].rows.find(r => r.c[0] === inv);
  api.est = (inv, k = 'ny') => api.orderEstimatesFor(api.state.data[k], k, now).get(api.row(inv, k).src);
  api.report = () => api.weeklyReportData(api.wkRangeFor('7d', now, null), now);
  return api;
}
const plain = v => JSON.parse(JSON.stringify(v));
const order = o => ({ category: 'Packaging', status: 'Shipped - In Transit', ship: '11/12/2026', dueDate: '12/12/2026', ...o });

/* ---------- priced, not in balance yet ---------- */

test('a priced order the supplier left out of Due and Not yet due counts, at its full price', () => {
  const a = app([], [
    order({ inv: 'INV-2639', po: '26101403', desc: 'Jar Purple NY x 70k', qty: '70,000', product: 73500, total: 73500 }),
    order({ inv: 'INV-2490', po: '26090301', desc: 'Bundle x 40k', qty: '40,000', product: 101200, total: 101200, paid: 50000, due: 51200 }),
    order({ inv: 'INV-2627', po: '26101206', desc: 'QR labels x 250k', status: 'Delivered', product: 3750, freight: 362, total: 4112, dueDate: '11/30/2026' }),
  ]);
  const u = a.unbookedFor(a.state.data.ny);
  assert.equal(u.all.n, 2);
  assert.equal(u.all.amt, 77612);
  assert.deepEqual(plain(u.items.map(i => i.r.c[0])), ['INV-2639', 'INV-2627']);
});

test('a partly booked order counts only what is not booked; Total Price + freight stands in for a blank total', () => {
  const a = app([], [
    order({ inv: 'INV-1', po: '26100101', product: 1000, total: 1000, paid: 300, nyd: 200 }),
    order({ inv: 'INV-2', po: '26100102', product: 800, freight: 50 }),
    order({ inv: 'INV-3', po: '26100103', product: 500, total: 500, due: 500 }),
  ]);
  const m = a.state.data.ny;
  assert.equal(a.rowPrice(m, a.row('INV-2')), 850);
  const u = a.unbookedFor(m);
  assert.deepEqual(plain(u.items.map(i => [i.r.c[0], i.amt])), [['INV-2', 850], ['INV-1', 500]]);
  assert.equal(u.all.amt, 1350);
});

test('the rows of one invoice net together, so a partial shipment never counts twice', () => {
  const a = app([], [
    order({ inv: 'INV-100', po: '26100101', product: 1000, total: 1000 }),
    order({ inv: 'INV-100-1', po: '26100101-1', due: 400 }),
    order({ inv: 'INV-100-2', po: '26100101-2', paid: 600 }),
    order({ inv: 'INV-200', po: '26100201', product: 900, total: 900 }),
    order({ inv: 'INV-200-1', po: '26100201-1', due: 300 }),
  ]);
  const u = a.unbookedFor(a.state.data.ny);
  assert.deepEqual(plain(u.items.map(i => [i.r.c[0], i.amt])), [['INV-200', 600]]);
});

test('cancelled, void, returned and free orders are left out', () => {
  for (const v of [{ status: 'Cancelled' }, { status: 'Void' }, { status: 'Returned' }, { comments: 'No charge' }, { comments: 'Free sample' }]) {
    const a = app([], [order({ inv: 'INV-9', po: '26100101', product: 500, total: 500, ...v })]);
    assert.equal(a.unbookedFor(a.state.data.ny).all.n, 0, JSON.stringify(v));
  }
});

test('vape hardware and EU orders are split the same way as the balances', () => {
  const a = app([
    order({ inv: 'INV-C1', po: '26100101', desc: 'Wizard Trees 1.0g AIO Hardware and Packaging - Bundle (CA) x 10k', product: 36500, total: 36500 }),
    order({ inv: 'INV-C2', po: '26100102', desc: 'Wizard Trees 3.5g Jar Purple CA x 10k', product: 10500, total: 10500 }),
    order({ inv: 'INV-E1', po: '26100103', desc: 'Wizard Trees Mylar Bag EU x 5k', product: 2000, total: 2000 }),
  ]);
  const m = a.state.data.ca, [ca] = a.marketSheets('ca'), [eu] = a.marketSheets('eu');
  const u = a.unbookedFor(m, ca.keep);
  assert.equal(u.all.amt, 47000); assert.equal(u.vape.amt, 36500); assert.equal(u.nonvape.amt, 10500);
  assert.equal(a.unbookedFor(m, eu.keep).all.amt, 2000);
});

test('the ledger hover note and the figure use the same price rule', () => {
  const a = app([], [order({ inv: 'INV-2', po: '26100102', product: 800, freight: 50 })]);
  const m = a.state.data.ny, adj = a.computeAdjust(m, 'ny');
  const ev = a.ledger(m, adj, a.payDates(m, now)).find(e => e.kind === 'order');
  assert.equal(ev.amt, 0); assert.equal(ev.uninv, 850);
  assert.equal(a.unbookedFor(m).all.amt, 850);
});

test('the open balance and payment timing totals do not change; the order shows under its due week, apart', () => {
  const base = order({ inv: 'INV-1', po: '26090101', product: 1000, total: 1000, due: 1000, dueDate: '11/20/2026' });
  const before = plain(app([], [base]).report());
  const a = app([], [base, order({ inv: 'INV-2639', po: '26101403', product: 73500, total: 73500, dueDate: '12/12/2026' })]);
  const after = plain(a.report());
  assert.deepEqual(after.ny.all, before.ny.all);
  assert.deepEqual(after.total.all, before.total.all);
  const wk = after.ny.due.find(b => b.nbN);
  assert.equal(wk.n, 0); assert.equal(wk.total, 0); assert.equal(wk.nbTotal, 73500);
  assert.equal(wk.label, 'Week of Dec 7');
  assert.equal(after.ny.due.find(b => b.n).total, 1000);
  assert.equal(after.ny.nbSum.all.amt, 73500); assert.equal(after.total.nbSum.all.n, 1);
  const text = a.weeklySummaryText(a.report());
  assert.match(text, /Priced, not yet booked by the supplier: \$73,500\.00 \(1 order: NY \$73,500\.00\)\. Not in the open balance\./);
  const email = a.weeklyEmailHtml(a.report(), 'https://example.test/order-tracker.html#weekly');
  assert.match(email, /Priced, not yet booked/);
  assert.match(email, /Not in that balance yet: <b[^>]*>\$73,500\.00<\/b> priced but not booked by the supplier \(1 order\)/);
  assert.match(email, /INV-2639/);
});

/* ---------- bundles priced from an earlier identical bundle ---------- */

const multipack = (q, tail = '(Jar / Insert  / Cap / Seal / 10CT Master Case / Cone x 5)') => `Wizard Trees 0.7g x 5 Multipack Preroll Bundle NY x ${q} ${tail}`;
const tube = (q, tail) => `Wizard Trees 1.0g Single Preroll Tube Purple Bundle NY x ${q} ${tail}`;

test('a bundle is estimated from an earlier order of the very same bundle, apart from the quantity', () => {
  const a = app([], [
    order({ inv: 'INV-2490', po: '26090301', desc: multipack('40k'), qty: '40,000', product: 101200, total: 101200, paid: 50000, due: 51200 }),
    order({ inv: 'INV-2654', po: '26102003', desc: multipack('40k'), qty: '40,000', status: 'In Production' }),
    order({ inv: '', po: '26111303', desc: multipack('100k', '(Jar / Insert / Cap / Seal / 10CT Master Case / Cone x 5)'), qty: '100,000', status: '' }),
  ]);
  const e = a.est('INV-2654');
  assert.equal(e.amount, 101200); assert.equal(e.unit, 2.53); assert.equal(e.match, 'Same bundle, same description');
  assert.deepEqual(plain(e.sources.map(s => s.inv)), ['INV-2490']);
  const cny = a.orderEstimatesFor(a.state.data.ny, 'ny', now).get(a.state.data.ny.rows.find(r => r.c[1] === '26111303').src);
  assert.equal(cny.amount, 253000);
});

test('full-width brackets, spaces inside brackets and case do not stop a match', () => {
  const a = app([], [
    order({ inv: 'INV-2492', po: '26090302', desc: tube('40k', '( Tube / Insert  / Cap / Seal / 10CT Master Case / Cone x 1)'), qty: '40,000', product: 34000, total: 34000 }),
    order({ inv: 'INV-2653', po: '26102002', desc: tube('40k', '( Tube / Insert  / Cap / Seal / 10CT Master Case / Cone x 1） '), qty: '40,000', status: 'In Production' }),
  ]);
  assert.equal(a.est('INV-2653').amount, 34000);
  const s1 = a.bundleShape(tube('40k', '( Tube / Cone x 1）'), '40000'), s2 = a.bundleShape(tube('100K', '(tube / cone x 1)'), '100,000');
  assert.equal(s1.key, s2.key);
});

test('"AlO" (the supplier\'s typo) and "AIO" are the same; a five-times larger order is priced but flagged as maybe high', () => {
  const a = app([], [
    order({ inv: 'INV-2176', po: '26060203', desc: 'Wizard Trees 1.0g AIO Hardware and Packaging - Bundle NY x 10k', qty: '10,000', product: 36500, total: 36500, paid: 36500 }),
    order({ inv: '', po: '26111304', desc: 'Wizard Trees 1.0g AlO Hardware and Packaging - Bundle NY x 50k', qty: '50,000', status: '' }),
  ]);
  const src = a.state.data.ny.rows.find(r => r.c[1] === '26111304').src;
  const e = a.orderEstimatesFor(a.state.data.ny, 'ny', now).get(src);
  assert.equal(e.amount, 182500); assert.equal(e.unit, 3.65);
  assert.match(a.estimateBasisHtml(e), /The earlier order was smaller \(10,000 units against 50,000\)\. A bigger order often costs less per unit, so this estimate may be high\./);
});

test('a bundle whose only identical earlier order is over five times smaller, newer, or another bundle stays unpriced', () => {
  const a = app([], [
    order({ inv: 'INV-TINY', po: '26090101', desc: multipack('5k'), qty: '5,000', product: 12650, total: 12650 }),
    order({ inv: 'INV-LATER', po: '26110101', desc: multipack('40k'), qty: '40,000', product: 101200, total: 101200 }),
    order({ inv: 'INV-OTHER', po: '26090201', desc: multipack('40k').replace('0.7g x 5', '0.7g x 3'), qty: '40,000', product: 90000, total: 90000 }),
    order({ inv: 'INV-T', po: '26102003', desc: multipack('40k'), qty: '40,000', status: 'In Production' }),
  ]);
  const e = a.est('INV-T');
  assert.equal(Object.hasOwn(e, 'amount'), false);
  assert.match(e.reason, /Product contents/);
});

test('the quantity column must agree with the quantity in the bundle description', () => {
  const a = app([], [
    order({ inv: 'INV-2490', po: '26090301', desc: multipack('40k'), qty: '40,000', product: 101200, total: 101200 }),
    order({ inv: 'INV-T', po: '26102003', desc: multipack('40k'), qty: '30,000', status: 'In Production' }),
  ]);
  assert.match(a.bundleShape(multipack('40k'), '30,000').reason, /disagree/);
  assert.equal(Object.hasOwn(a.est('INV-T'), 'amount'), false);
});

test('bundle estimates never borrow from the other state and leave balances untouched', () => {
  const src = order({ inv: 'INV-2490', po: '26090301', desc: multipack('40k'), qty: '40,000', product: 101200, total: 101200 });
  const a = app([src], [order({ inv: 'INV-T', po: '26102003', desc: multipack('40k'), qty: '40,000', status: 'In Production' })]);
  assert.equal(Object.hasOwn(a.est('INV-T'), 'amount'), false);
  const b = app([], [src, order({ inv: 'INV-T', po: '26102003', desc: multipack('40k'), qty: '40,000', status: 'In Production' })]);
  const p = b.pricingFor(b.state.data.ny, 'ny');
  assert.deepEqual(plain(p.all), { n: 1, estimated: 1, amount: 101200, pending: 0 });
  assert.deepEqual(plain(b.report().ny.all), plain(app([], [src]).report().ny.all));
});

/* ---------- double counting: name the payment that now covers it ---------- */

const remainderNote = '$5,000.00 of the $100,000.00 general wire sent 2026-10-06 that the supplier did not credit (they posted $95,000.00 as Payment 6 - Wire 6th Oct 2026)';
const pay = (id, amount, note, extra = {}) => ({ id, state: 'ny', mode: 'payment', payment_key: '__paid__', invoice_no: '__nonvape__',
  amount, paid_on: '2026-10-06', note: `temp: ${note}; not yet on the supplier sheet`, sheet_paid_at_entry: 1000, ...extra });

test('the watcher\'s note is read back: the column it came from and what it showed then', () => {
  const a = app();
  assert.deepEqual(plain(a.remainderOf({ note: `temp: ${remainderNote}; not yet on the supplier sheet` })),
    { wire: 100000, acct: 'general', sent: '2026-10-06', postedThen: 95000, key: 'Payment 6 - Wire 6th Oct 2026' });
  assert.equal(a.remainderOf({ note: 'temp: $24,000.00 wire for the CA general balance (confirmation 1)' }), null);
  assert.equal(a.remainderOf({ note: null }), null);
});

const p6 = wire => [{ header: 'Payment 6 - Wire 6th Oct 2026', wire }];
const sheetRow = amount => order({ inv: 'INV-1', po: '26090101', product: amount, total: amount, paid: amount, pay: { 'Payment 6 - Wire 6th Oct 2026': amount } });

test('a remainder whose payment the supplier raised to the full wire is counted twice, and says which payment', () => {
  const a = app([], [sheetRow(100000)], { nyPays: p6('$100,000'), asc: [pay('x', 5000, remainderNote)] });
  const m = a.state.data.ny, c = a.pendingCheck(m, a.state.asc[0]);
  assert.equal(c.kind, 'covered');
  assert.match(c.text, /^Payment 6 - Wire 6th Oct 2026 now shows \$100,000\.00 \(it showed \$95,000\.00 when this was recorded\), so this \$5,000\.00 is on the supplier's sheet and is counted twice\. Remove it\.$/);
});

test('a remainder whose payment still shows the short amount is not flagged', () => {
  const a = app([], [sheetRow(95000)], { nyPays: p6('$95,000'), asc: [pay('x', 5000, remainderNote)] });
  const c = a.pendingCheck(a.state.data.ny, a.state.asc[0]);
  assert.equal(c.kind, 'short'); assert.equal(c.covered, false);
  assert.match(c.text, /still shows \$95,000\.00/);
});

test('a payment raised part of the way, or gone from the sheet, asks for a check without claiming a double count', () => {
  let a = app([], [sheetRow(97000)], { nyPays: p6('$97,000'), asc: [pay('x', 5000, remainderNote)] });
  let c = a.pendingCheck(a.state.data.ny, a.state.asc[0]);
  assert.equal(c.kind, 'risk'); assert.equal(c.covered, false); assert.match(c.text, /went up by \$2,000\.00/);
  a = app([], [order({ inv: 'INV-1', po: '26090101', product: 10, total: 10, paid: 10 })], { asc: [pay('x', 5000, remainderNote)] });
  c = a.pendingCheck(a.state.data.ny, a.state.asc[0]);
  assert.equal(c.kind, 'risk'); assert.match(c.text, /no longer on the supplier's sheet/);
});

test('any other recorded payment keeps the paid-to-date rule and names payments dated near it', () => {
  const a = app([], [order({ inv: 'INV-1', po: '26090101', product: 101000, total: 101000, paid: 101000, pay: { 'Payment 6 - Wire 6th Oct 2026': 100000 } })],
    { nyPays: p6('$100,000'), asc: [pay('y', 100000, '$100,000.00 wire for the NY general balance (confirmation 4b473f)')] });
  const c = a.pendingCheck(a.state.data.ny, a.state.asc[0]);
  assert.equal(c.kind, 'risk'); assert.equal(c.covered, true);
  assert.match(c.text, /^The supplier has posted \$100,000\.00 since this was recorded\. Their payments dated near it: Payment 6 - Wire 6th Oct 2026 \(6 Oct 2026, \$100,000\.00\)\. If that includes this payment, remove it so it is not counted twice\.$/);
});

/* ---------- pick boxes ---------- */

test('a pick box takes the exact entry in any case, else the one entry that contains the text, else nothing', () => {
  const a = app();
  const list = ['Last 7 days', 'Last week (Mon to Sun)', 'Last month', 'Custom'];
  assert.equal(a.pickFrom(list, 'last month'), 'Last month');
  assert.equal(a.pickFrom(list, 'cust'), 'Custom');
  assert.equal(a.pickFrom(list, 'mon to'), 'Last week (Mon to Sun)');
  assert.equal(a.pickFrom(list, 'last'), null);
  assert.equal(a.pickFrom(list, 'nothing'), null);
  assert.equal(a.pickFrom(list, '   '), null);
  const opts = [{ label: 'General (non-vape)' }, { label: '💨 Vapes' }];
  assert.equal(a.pickFrom(opts, 'vapes', o => o.label).label, '💨 Vapes');
  assert.equal(a.pickFrom(opts, 'vape', o => o.label), null);
});

test('the page has no plain dropdowns left', () => {
  assert.doesNotMatch(html, /<select[\s>]/i);
});

/* ---------- review fixes ---------- */

test('a split invoice is listed on the row its unbooked money sits on, not the larger booked row', () => {
  const a = app([], [
    order({ inv: 'INV-800', po: '26090101', product: 6000, total: 6000, due: 6000, dueDate: '10/1/2026' }),
    order({ inv: 'INV-800-1', po: '26090101-1', product: 4000, total: 4000, dueDate: '12/15/2026' }),
  ]);
  const u = a.unbookedFor(a.state.data.ny);
  assert.deepEqual(plain(u.items.map(i => [i.r.c[0], i.amt, i.srcs.length])), [['INV-800-1', 4000, 2]]);
  const wk = plain(a.report()).ny.due.find(b => b.nbN);
  assert.equal(wk.label, 'Week of Dec 14'); assert.equal(wk.nb[0].inv, 'INV-800-1');
});

test('the ledger marks only what the card counts: a split invoice is netted, a cancelled order is not marked', () => {
  const a = app([], [
    order({ inv: 'INV-200', po: '26100201', product: 900, total: 900 }),
    order({ inv: 'INV-200-1', po: '26100201-1', due: 300 }),
    order({ inv: 'INV-300', po: '26100301', product: 500, total: 500, status: 'Cancelled' }),
  ]);
  const m = a.state.data.ny, evs = a.ledger(m, a.computeAdjust(m, 'ny'), a.payDates(m, now)).filter(e => e.kind === 'order');
  const by = inv => evs.find(e => e.r.c[0] === inv);
  assert.equal(by('INV-200').uninv, 600); assert.equal(by('INV-200-1').uninv, 0); assert.equal(by('INV-300').uninv, 0);
});

test('a credit row (negative total and Due) is not counted as priced but not booked', () => {
  const a = app([], [order({ inv: 'INV-900', po: '26100101', product: -500, total: -500, due: -500 })]);
  assert.equal(a.rowPrice(a.state.data.ny, a.row('INV-900')), -500);
  assert.equal(a.unbookedFor(a.state.data.ny).all.n, 0);
});

test('bundle quantities written with a dash or a space are found, and checked against the QTY column', () => {
  const a = app();
  assert.equal(a.bundleShape('Wizard Trees AIO Hardware and Packaging Bundle NY-10K', '10,000').key,
               a.bundleShape('Wizard Trees AIO Hardware and Packaging Bundle NY-50K', '50,000').key);
  assert.match(a.bundleShape('Wizard Trees AIO Hardware and Packaging Bundle NY 10K', '50,000').reason, /disagree/);
  assert.match(a.bundleShape('Wizard Trees AIO Bundle x 10k（AIO / Box）', '50,000').reason, /disagree/);
  assert.equal(a.bundleShape(multipack('40k'), '40,000').fixed, false);
  assert.equal(a.bundleShape('Wizard Trees Tube Bundle x 40k (with Labels x 20k)', '40,000').fixed, true);
});

test('a bundle holding another whole-order count is priced only from an order of the same size', () => {
  const desc = q => `Wizard Trees Tube Bundle NY x ${q} (with Labels x 20k)`;
  const a = app([], [
    order({ inv: 'INV-A', po: '26090101', desc: desc('20k'), qty: '20,000', product: 20000, total: 20000 }),
    order({ inv: 'INV-T', po: '26102003', desc: desc('40k'), qty: '40,000', status: 'In Production' }),
  ]);
  assert.equal(Object.hasOwn(a.est('INV-T'), 'amount'), false);
  const b = app([], [
    order({ inv: 'INV-A', po: '26090101', desc: desc('40k'), qty: '40,000', product: 30000, total: 30000 }),
    order({ inv: 'INV-T', po: '26102003', desc: desc('40k'), qty: '40,000', status: 'In Production' }),
  ]);
  assert.equal(b.est('INV-T').amount, 30000);
});

test('when a bundle\'s own quantity is refused, that reason is shown', () => {
  const a = app([], [
    order({ inv: 'INV-2490', po: '26090301', desc: multipack('40k'), qty: '40,000', product: 101200, total: 101200 }),
    order({ inv: 'INV-T', po: '26102003', desc: multipack('40k'), qty: '30,000', status: 'In Production' }),
  ]);
  assert.match(a.est('INV-T').reason, /Quantity column and description disagree/);
});

test('a corrected vape remainder made before the watcher update says to re-attribute it; a newer one is left to the watcher', () => {
  const vapeNote = '$10.00 of the $84,381.00 vape wire sent 2026-09-18 that the supplier did not credit (they posted $84,371.00 as Payment 6 - Wire 6th Oct 2026)';
  const old = { ...pay('v', 10, vapeNote, { invoice_no: '__vape__', created_at: '2026-11-04T03:15:00Z' }) };
  let a = app([], [order({ inv: 'INV-1', po: '26090101', product: 84381, total: 84381, paid: 84381, pay: { 'Payment 6 - Wire 6th Oct 2026': 84381 } })],
    { nyPays: p6('$84,381'), asc: [old] });
  let c = a.pendingCheck(a.state.data.ny, a.state.asc[0]);
  assert.equal(c.kind, 'covered'); assert.equal(c.byHand, true);
  assert.match(c.text, /counted twice\. Remove it, then attribute \$10\.00 of payments to 💨 Vapes balance/);
  const fresh = { ...old, created_at: '2026-11-20T10:00:00Z' };
  a = app([], [order({ inv: 'INV-1', po: '26090101', product: 84381, total: 84381, paid: 84381, pay: { 'Payment 6 - Wire 6th Oct 2026': 84381 } })],
    { nyPays: p6('$84,381'), asc: [fresh] });
  c = a.pendingCheck(a.state.data.ny, a.state.asc[0]);
  assert.equal(c.byHand, false);
  assert.match(c.text, /until the wire watcher's next hourly run removes it, keeping it on vapes\. Nothing to do\.$/);
});

test('a pick box ignores line breaks and runs of spaces in its entries', () => {
  const a = app();
  const opts = [{ label: 'INV-2265 INV-2266 (has $5.00)' }, { label: 'INV-2283 (has $9.00)' }];
  assert.equal(a.pickFrom(opts, 'inv-2265   inv-2266', o => o.label).label, 'INV-2265 INV-2266 (has $5.00)');
  assert.equal(a.pickFrom(['A\nB'], 'a b'), 'A\nB');
});

test('the e-mail\'s Coming due table leaves out weeks that hold only orders not yet booked', () => {
  const a = app([], [
    order({ inv: 'INV-1', po: '26090101', product: 1000, total: 1000, due: 1000, dueDate: '11/20/2026' }),
    order({ inv: 'INV-2639', po: '26101403', product: 73500, total: 73500, dueDate: '12/12/2026' }),
  ]);
  const email = a.weeklyEmailHtml(a.report(), 'https://example.test/x');
  const coming = email.split('Coming due')[1].split('</table>')[0];
  assert.doesNotMatch(coming, /Week of Dec 7/);
  assert.match(email, /INV-2639/);
});

