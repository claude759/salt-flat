// Order Tracker: Coming due by month (booked, priced but not booked, and our estimates), the
// expected due date of an order the sheet has no due date for, and the hand-over from an
// estimate to the supplier's own price. Run: node --test tests/order-*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../order-tracker.html', import.meta.url), 'utf8');
const source = html.split('<script>')[1].split('/* ---------- wiring ---------- */')[0];
const now = new Date(2026, 10, 16, 12).getTime();
const DAY = 86400000;
const month = (y, m) => String(y * 12 + m);          // the schedule's month keys (m is 0-based)
const plain = v => JSON.parse(JSON.stringify(v));    // arrays made inside the page's context

const HEAD = ['Invoice No.', 'PO Number', 'Category', 'Desc.', 'Order Status', 'Ship Date', 'Due Date', 'QTY in Unit',
  'Total Price', 'Freight and Duty', 'Total including Freight', 'Paid to Date', 'Due', 'Not Yet Due', 'Comments'];
const KEY = { inv:'Invoice No.', po:'PO Number', category:'Category', desc:'Desc.', status:'Order Status', ship:'Ship Date',
  dueDate:'Due Date', qty:'QTY in Unit', product:'Total Price', freight:'Freight and Duty', total:'Total including Freight',
  paid:'Paid to Date', due:'Due', nyd:'Not Yet Due', comments:'Comments' };
const csv = rows => [HEAD, ...rows.map(r => HEAD.map(h => r[Object.keys(KEY).find(x => KEY[x] === h)] ?? ''))]
  .map(cells => cells.map(v => JSON.stringify(String(v))).join(',')).join('\n');

function app(ca = [], ny = []) {
  const context = vm.createContext({ console, location: { hash: '#weekly' }, localStorage: { getItem: () => null } });
  vm.runInContext(source, context);
  const api = vm.runInContext(`({state,buildModel,comingDueFor,dueDateOf,leadTimes,ledger,computeAdjust,payDates,
    marketBalances,filteredRows,estimateCheckFor,orderEstimatesFor,weeklyReportData,wkRangeFor,weeklyEmailHtml,weeklySummaryText})`, context);
  api.state.asc = [];
  api.state.data.ca = api.buildModel(csv(ca));
  api.state.data.ny = api.buildModel(csv(ny));
  api.row = (inv, k = 'ny') => api.state.data[k].rows.find(r => r.c[0] === inv);
  api.due = (markets = ['ny'], opts = {}) => api.comingDueFor(markets, { now, ...opts });
  api.col = (cd, key) => cd.cols.find(c => c.key === key) || { booked:0, priced:0, est:0, pending:0, total:0 };
  return api;
}
const bag = (design = 'Orange', quantity = '20k') => `Wizard Trees - 3.5g Flower Mylar Bag ${design} NY x ${quantity}`;
const history = o => ({ category: 'Packaging', status: 'Delivered', qty: '20,000', ...o });

/* the NY sheet used by most tests: one order of each kind */
const sheet = () => [
  // booked: in the supplier's Due
  { inv: 'INV-A', po: '26090101', desc: 'Labels A x 1k', status: 'Delivered', ship: '9/20/2026', dueDate: '10/20/2026', product: 1000, total: 1000, due: 1000 },
  // booked: Not yet due, its due date already past -> this month
  { inv: 'INV-B', po: '26100101', desc: 'Labels B x 1k', status: 'Delivered', ship: '10/10/2026', dueDate: '11/9/2026', product: 500, total: 500, nyd: 500 },
  // booked: Not yet due in December
  { inv: 'INV-C', po: '26101001', desc: 'Labels C x 1k', status: 'Shipped - In Transit', ship: '11/20/2026', dueDate: '12/20/2026', product: 700, total: 700, nyd: 700 },
  // priced by the supplier, not booked: December
  { inv: 'INV-D', po: '26101501', desc: 'Labels D x 1k', status: 'In Production', ship: '12/1/2026', dueDate: '12/31/2026', product: 300, total: 300 },
  // an earlier order of the same bag, and the same bag with no price yet, due in January
  history({ inv: 'INV-H', po: '26080101', desc: bag(), ship: '8/21/2026', dueDate: '9/20/2026', product: 400, total: 400, paid: 400 }),
  { inv: 'INV-E', po: '26110101', desc: bag(), status: 'In Production', qty: '20,000', ship: '12/16/2026', dueDate: '1/15/2027' },
];

test('each month adds booked, priced and estimated; the booked line adds up to the open balance', () => {
  const a = app([], sheet()), cd = a.due();
  const mb = a.marketBalances('ny');
  assert.equal(a.col(cd, 'now').booked, 1000);                       // the supplier's Due
  assert.equal(a.col(cd, 'now').booked, mb.vape.odue + mb.nonvape.odue);
  assert.equal(a.col(cd, month(2026, 10)).booked, 500);              // past-dated, not in Due: this month
  assert.equal(a.col(cd, month(2026, 11)).booked, 700);
  assert.equal(a.col(cd, month(2026, 11)).priced, 300);
  assert.equal(a.col(cd, month(2027, 0)).est, 400);
  assert.equal(a.col(cd, month(2027, 0)).total, 400);
  const booked = cd.cols.reduce((s, c) => s + c.booked, 0);
  assert.equal(booked, mb.all.bal);
  assert.deepEqual(plain(cd.cols.map(c => c.key)), ['now', month(2026, 10), month(2026, 11), month(2027, 0)]);
  assert.equal(a.col(cd, month(2026, 10)).sub, 'this month + past dates');
});

test('an estimate gives way to the supplier’s price, and the price to the booked amount, in the same month', () => {
  const rows = sheet();
  const e = rows.find(r => r.inv === 'INV-E');
  let cd = app([], rows).due();
  assert.deepEqual([a0(cd).est, a0(cd).priced, a0(cd).booked], [400, 0, 0]);
  function a0(x) { return x.cols.find(c => c.key === month(2027, 0)); }
  Object.assign(e, { product: 520, total: 520 });                      // the supplier prices it
  cd = app([], rows).due();
  assert.deepEqual([a0(cd).est, a0(cd).priced, a0(cd).booked], [0, 520, 0]);
  Object.assign(e, { nyd: 520 });                                       // then books it
  cd = app([], rows).due();
  assert.deepEqual([a0(cd).est, a0(cd).priced, a0(cd).booked], [0, 0, 520]);
});

test('an order with no due date: ship date + 30 days once shipped, else PO date + the usual days to ship + 30', () => {
  const lead = (inv, po, ship, days) => history({ inv, po, desc: bag('L' + inv), ship, dueDate: '', product: 400, total: 400, paid: 400, _d: days });
  const a = app([], [
    lead('INV-1', '26080101', '8/21/2026'), lead('INV-2', '26080201', '9/1/2026'), lead('INV-3', '26080301', '9/12/2026'),  // 20, 30, 40 days
    { inv: 'INV-F', po: '26103001', desc: 'Labels F x 1k', status: 'Shipped - In Transit', ship: '11/10/2026', product: 200, total: 200, nyd: 200 },
    { inv: '', po: '26111301', desc: bag('New'), status: '', qty: '20,000' },
  ]);
  const lt = a.leadTimes();
  assert.equal(lt.by['Mylar bags'].days, 30);
  const cd = a.due();
  const f = cd.dates.get('ny:' + a.row('INV-F').src);
  assert.equal(f.expected, 'shipped');
  assert.equal(f.ts, new Date(2026, 11, 10).getTime());
  assert.equal(a.col(cd, month(2026, 11)).booked, 200);
  const g = a.state.data.ny.rows.find(r => r.c[1] === '26111301');
  const gd = cd.dates.get('ny:' + g.src);
  assert.equal(gd.expected, 'ordered');
  assert.equal(gd.days, 30);
  assert.equal(gd.ts, new Date(2027, 0, 12).getTime());               // 11/13 + 30 + 30
});

test('a kind of product with fewer than 3 past orders uses the usual days over every order', () => {
  const a = app([], [
    history({ inv: 'INV-1', po: '26080101', desc: bag('A'), ship: '8/11/2026', product: 400, total: 400, paid: 400 }),   // 10 days
    history({ inv: 'INV-2', po: '26080101', desc: 'Labels x 1k', ship: '8/21/2026', product: 40, total: 40, paid: 40 }), // 20 days
    history({ inv: 'INV-3', po: '26080101', desc: 'Labels y x 1k', ship: '8/31/2026', product: 40, total: 40, paid: 40 }), // 30 days
  ]);
  const lt = a.leadTimes();
  assert.equal(lt.by['Mylar bags'], undefined);
  assert.equal(lt.all, 20);
  const r = { dueTs: null, orderedTs: new Date(2026, 10, 1).getTime(), type: 'Mylar bags', c: [] };
  const d = a.dueDateOf(a.state.data.ny, r, lt);
  assert.equal(d.typed, false);
  assert.equal(d.ts, new Date(2026, 11, 21).getTime());          // 11/1 + 20 + 30 days, by the calendar
});

test('leaving vapes out drops vape orders from every line, the supplier’s Due included', () => {
  const rows = [...sheet(),
    { inv: 'INV-V', po: '26100501', desc: 'Wizard Trees 1.0g AIO Hardware and Packaging - Bundle NY x 20k', status: 'Delivered',
      ship: '10/1/2026', dueDate: '10/31/2026', qty: '20,000', product: 9000, total: 9000, due: 9000 }];
  const a = app([], rows);
  assert.equal(a.col(a.due(), 'now').booked, 10000);
  assert.equal(a.col(a.due(['ny'], { buckets: ['nonvape'] }), 'now').booked, 1000);
});

test('a month of the table lists exactly the orders behind it', () => {
  const a = app([], sheet());
  a.state.page = 'ny';
  const f = a.state.data.ny && a.state.filters.ny;
  f.only = 'due:' + month(2026, 11);
  assert.deepEqual(plain(a.filteredRows(a.state.data.ny).map(r => r.c[0]).sort()), ['INV-C', 'INV-D']);
  f.only = 'due:' + month(2027, 0);
  assert.deepEqual(plain(a.filteredRows(a.state.data.ny).map(r => r.c[0])), ['INV-E']);
  f.only = 'due:now';
  assert.deepEqual(plain(a.filteredRows(a.state.data.ny).map(r => r.c[0])), ['INV-A']);
});

test('a new PO with no date sits at its expected ship date in the ledger and moves no balance', () => {
  const final = rows => { const a = app([], rows), m = a.state.data.ny;
    return { a, evs: a.ledger(m, a.computeAdjust(m, 'ny'), a.payDates(m, now)) }; };
  const { evs } = final([...sheet(), { inv: '', po: '26111301', desc: bag('New'), status: '', qty: '20,000' }]);
  const g = evs.find(e => e.kind === 'order' && e.r.c[1] === '26111301');
  assert.equal(g.amt, 0);
  assert.ok(g.expShip > g.r.orderedTs);
  assert.equal(g.date, g.expShip);
  assert.equal(evs.at(-1).bal, final(sheet()).evs.at(-1).bal);      // the balance is the same without it
  const booked = evs.find(e => e.kind === 'order' && e.r.c[0] === 'INV-C');
  assert.equal(booked.expShip, null);                                  // dated orders keep their own date
});

test('a priced order shows what the estimate would have been, from the orders before it', () => {
  const a = app([], [...sheet(),
    { inv: 'INV-P', po: '26100201', desc: bag(), status: 'Delivered', qty: '20,000', ship: '10/20/2026', dueDate: '11/19/2026', product: 500, total: 500, paid: 500 }]);
  const chk = a.estimateCheckFor(a.state.data.ny, 'ny', a.row('INV-P'));
  assert.equal(chk.est, 400);
  assert.equal(chk.actual, 500);
  assert.equal(a.estimateCheckFor(a.state.data.ny, 'ny', a.row('INV-H')), null);   // nothing before it
});

test('days are added by the calendar: a ship date of 11/1 is due 12/1, in December, across the clock change', () => {
  const a = app([], [{ inv: 'INV-S', po: '26101001', desc: 'Labels S x 1k', status: 'Shipped - In Transit', ship: '11/1/2026', product: 200, total: 200, nyd: 200 }]);
  const cd = a.due(), d = cd.dates.get('ny:' + a.row('INV-S').src);
  assert.equal(d.ts, new Date(2026, 11, 1).getTime());
  assert.equal(a.col(cd, month(2026, 11)).booked, 200);
  assert.equal(a.col(cd, month(2026, 10)).booked, 0);
});

test('the whole California sheet nets an invoice split between its EU and CA rows once, as the card does', () => {
  const a = app([
    { inv: 'INV-600', po: '26100601', desc: 'Wizard Trees AIO EU x 20k', status: 'In Production', ship: '11/10/2026', dueDate: '12/10/2026', qty: '20,000', product: 20000, total: 20000 },
    { inv: 'INV-600-1', po: '26100601-1', desc: 'Wizard Trees AIO x 20k', status: 'In Production', ship: '11/10/2026', dueDate: '12/10/2026', qty: '20,000', nyd: 20000 },
  ], []);
  const cd = a.due(['ca', 'eu']), dec = a.col(cd, month(2026, 11));
  assert.equal(dec.booked, 20000);
  assert.equal(dec.priced, 0);
});

test('with vapes left out, an invoice is filed by its lead row, as the Priced, not in balance figures are', () => {
  const a = app([], [
    { inv: 'INV-500-1', po: '26100501-1', desc: 'Wizard Trees 1.0g AIO Hardware and Packaging - Bundle NY x 10k', status: 'In Production', ship: '12/1/2026', dueDate: '12/31/2026', qty: '10,000', product: 1000, total: 1000 },
    { inv: 'INV-500-2', po: '26100501-2', desc: bag('Mix', '10k'), status: 'In Production', ship: '12/1/2026', dueDate: '12/31/2026', qty: '10,000', product: 200, total: 200 },
  ]);
  assert.equal(a.col(a.due(), month(2026, 11)).priced, 1200);
  assert.equal(a.col(a.due(['ny'], { buckets: ['nonvape'] }), month(2026, 11)).priced, 0);
  assert.equal(a.col(a.due(['ny'], { buckets: ['vape'] }), month(2026, 11)).priced, 1200);
});

test('the usual days to ship come from orders placed in the past year', () => {
  const old = (inv, po, ship) => history({ inv, po, desc: bag('Old' + inv), ship, product: 400, total: 400, paid: 400 });
  const a = app([], [
    old('INV-1', '24030101', '3/11/2024'), old('INV-2', '24030201', '3/12/2024'), old('INV-3', '24030301', '3/13/2024'),   // 10 days, 2024
    old('INV-4', '26060101', '7/31/2026'), old('INV-5', '26060201', '8/1/2026'), old('INV-6', '26060301', '8/2/2026'),     // 60 days
  ]);
  assert.equal(a.leadTimes(now).by['Mylar bags'].days, 60);
});

test('cancelled, delivered and free orders with no dates keep their old place in the ledger', () => {
  const a = app([], [...sheet(),
    { inv: 'INV-Q', po: '26100801', desc: 'Labels Q x 1k', status: 'Cancelled' },
    { inv: 'INV-Z', po: '26100802', desc: 'Labels Z x 1k', status: 'Delivered', comments: 'Free sample, no charge' },
    { inv: 'INV-N', po: '26100803', desc: 'Labels N x 1k', status: 'In Production' }]);
  const m = a.state.data.ny, evs = a.ledger(m, a.computeAdjust(m, 'ny'), a.payDates(m, now));
  const ev = inv => evs.find(e => e.kind === 'order' && e.r.c[0] === inv);
  assert.equal(ev('INV-Q').expShip, null);
  assert.equal(ev('INV-Z').expShip, null);
  assert.ok(ev('INV-N').expShip > 0);
});

/* ---------- pricing from similar earlier orders ---------- */

const est = (a, inv, k = 'ny') => a.orderEstimatesFor(a.state.data[k], k, now).get(a.row(inv, k).src);
const priced = (inv, po, desc, qty, product, extra = {}) => ({ inv, po, desc, qty, product, total: product, status: 'Delivered', paid: product, ...extra });
const open = (inv, po, desc, qty) => ({ inv, po, desc, qty, status: 'In Production' });

test('an order worded differently from an earlier one is priced from it', () => {
  const a = app([], [
    priced('INV-1959', '26041701', 'Wizard Trees Small Rolling Tray (New Design) - 4K pcs  (Ship to NY)', '4,000', 3760),
    open('INV-2689', '26102602', 'Wizard Trees NY - Small Rolling Tray NY x 4k (BM House / Wizzy x 2k each)', '4,000'),
  ]);
  const e = est(a, 'INV-2689');
  assert.equal(e.amount, 3760);
  assert.equal(e.similar, true);
});

test('a label is never priced from a box, nor a 14g bag from a 3.5g bag', () => {
  const a = app([], [
    priced('INV-1', '26080101', 'Wizard Trees - 3.5g Flower Master Case 32ct All States x 11k', '11,000', 28600),
    open('INV-2', '26100101', 'Wizard Trees - 3.5g Flower Label - Master Case Label x 11k', '11,000'),
    priced('INV-3', '26080201', 'Wizard Trees - 3.5g Flower Mylar Bag Orange NY x 2k', '2,000', 300),
    open('INV-4', '26100201', 'Wizard Trees - 14.0g Mylar Bag for Flower NY x 2k', '2,000'),
  ]);
  assert.match(est(a, 'INV-2').reason, /No similar earlier order/);
  assert.match(est(a, 'INV-4').reason, /No similar earlier order/);
});

test('an EU order is priced from EU orders first; a CA order from the closest description', () => {
  const a = app([
    priced('INV-2175', '26060201', 'Wizard Trees AIO Hardware and Packaging - 20K CA', '20,000', 73000),
    priced('INV-2177', '26060202', 'Wizard Trees AIO Hardware and Packaging - 20K CE', '20,000', 65400),
    open('INV-2680', '26102104', 'Wizard Trees 1.0g AlO Hardware and Packaging - Bundle (CE) x 20k', '20,000'),
    open('INV-2660', '26102103', 'Wizard Trees 1.0g AIO Hardware and Packaging - Bundle (CA) x 20k', '20,000'),
  ], [
    priced('INV-2176', '26060203', 'Wizard Trees 1.0g AlO Hardware and Packaging - Bundle NY x 10k', '10,000', 36500),
  ]);
  assert.equal(est(a, 'INV-2680', 'ca').amount, 65400);
  assert.equal(est(a, 'INV-2660', 'ca').amount, 73000);
});

test('counts given per design are not the order quantity; a pound bag is priced from a pound bag', () => {
  const a = app([], [
    priced('INV-2536', '26091701', 'Wizard Trees - Flower Mylar Bag - Pound Bag NY x 5k', '5,000', 4350),
    open('INV-2736', '26110402', 'Wizard Trees - Flower Mylar Bag - Pound Bag - Roller NY x 1k', '1,000'),
    open('INV-2735', '26110401', 'Wizard Trees - Flower Mylar Bag - Pound Bag NY x 3k ( Zoap / Zangria / Black Magic x 1k each)', '3,000'),
  ]);
  assert.equal(est(a, 'INV-2736').amount, 870);
  assert.equal(est(a, 'INV-2735').amount, 2610);
});

test('"Seed Mylars" are mylar bags: a seeds mylar bag is priced from them', () => {
  const a = app([], [
    priced('INV-1679', '25122401', 'Wizard Trees EU Seed Mylars - 10K - Digital Print', '10,000', 1300),
    open('INV-2735', '26110401', 'Wizard Trees - Seeds Mylar Bag NY x 3k ( Zoap / Zangria / Black Magic x 1k each)', '3,000'),
  ]);
  assert.equal(est(a, 'INV-2735').amount, 390);
});

test('the weekly email shows not yet due with what is coming, month by month, per market and for vapes', () => {
  const a = app([], [...sheet(),
    { inv: 'INV-V', po: '26100501', desc: 'Wizard Trees 1.0g AIO Hardware and Packaging - Bundle NY x 20k', status: 'Delivered', ship: '9/1/2026', dueDate: '10/1/2026', qty: '20,000', product: 73000, total: 73000, paid: 73000 },
    { inv: 'INV-V2', po: '26110201', desc: 'Wizard Trees 1.0g AIO Hardware and Packaging - Bundle NY x 20k', status: 'In Production', ship: '12/5/2026', dueDate: '1/4/2027', qty: '20,000' }]);
  const f = a;
  const d = f.weeklyReportData(f.wkRangeFor('7d', now, null), now);
  // NY: 500 + 700 booked not yet due, 300 priced, 400 + 73,000 estimated
  const ah = d.ny.coming.cols.filter(c => c.key !== 'now').reduce((s, c) => s + c.total, 0);
  assert.equal(ah, 500 + 700 + 300 + 400 + 73000);
  const email = f.weeklyEmailHtml(d, 'https://example.test/x');
  assert.match(email, /Not yet due, with what is coming: <b[^>]*>≈ \$74,900\.00<\/b> · Nov 2026 \$500\.00 · Dec 2026 \$1,000\.00 · Jan 2027 ≈ \$73,400\.00/);
  assert.match(email, /<b>NY vapes<\/b>.*?≈ \$73,000\.00<\/b><br><span[^>]*>Jan 2027 ≈ \$73,000\.00/);
  assert.match(email, /Coming due by month/);
  assert.doesNotMatch(email, /—/);
  assert.match(f.weeklySummaryText(d), /Not yet due, with what is coming .*approximately \$74,900\.00/);
});
