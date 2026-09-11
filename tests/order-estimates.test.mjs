import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../order-tracker.html', import.meta.url), 'utf8');
const source = html.split('<script>')[1].split('/* ---------- wiring ---------- */')[0];
const now = new Date(2026, 8, 11, 12).getTime();
const fields = [
  ['inv', 'Invoice No.'], ['po', 'PO Number'], ['category', 'Category'],
  ['desc', 'Desc.'], ['status', 'Order Status'], ['qty', 'QTY in Unit'],
  ['product', 'Total Price'], ['freight', 'Freight and Duty'],
  ['total', 'Total including Freight'], ['paid', 'Paid to Date'],
  ['due', 'Due'], ['nyd', 'Not Yet Due'], ['ship', 'Ship Date'],
  ['dueDate', 'Due Date'], ['comments', 'Comments'],
];
const bag = (design = 'Orange', quantity = '20k') =>
  `Wizard Trees - 3.5g Flower Mylar Bag ${design} CA x ${quantity}`;
const labels = (design = 'Orange', quantity = '200k') =>
  `Wizard Trees - 3.5g Jar Labels ${design} NY x ${quantity}`;
const order = (overrides = {}) => ({
  inv: 'INV-TARGET', po: '26091001', category: 'Packaging',
  desc: bag(), status: 'In Production', qty: '20,000', ...overrides,
});
const history = (overrides = {}) => order({
  inv: 'INV-HISTORY', po: '26080101', status: 'Delivered',
  product: 400, freight: 100, total: 500, paid: 500, ...overrides,
});
const plain = value => JSON.parse(JSON.stringify(value));

function app(ca = [], ny = []) {
  const context = vm.createContext({
    console, location: {hash: '#weekly'}, localStorage: {getItem: () => null},
  });
  vm.runInContext(source, context);
  const api = vm.runInContext(
    '({state,buildModel,orderPriceFields,estimateProduct,orderEstimatesFor,estimateBasisHtml,weeklyReportData,wkRangeFor,weeklyPriceSummary,weeklySummaryText,weeklyEmailHtml})',
    context,
  );
  api.model = rows => api.buildModel([
    fields.map(([, label]) => label),
    ...rows.map(row => fields.map(([key]) => row[key] ?? '')),
  ].map(row => row.map(value => JSON.stringify(String(value))).join(',')).join('\n'));
  api.state.data.ca = api.model(ca);
  api.state.data.ny = api.model(ny);
  api.estimates = (state = 'ca') => api.orderEstimatesFor(api.state.data[state], state, now);
  api.row = (invoice = 'INV-TARGET', state = 'ca') =>
    api.state.data[state].rows.find(row => row.c[0] === invoice);
  api.estimate = (invoice = 'INV-TARGET', state = 'ca') => api.estimates(state).get(api.row(invoice, state).src);
  api.report = () => api.weeklyReportData(api.wkRangeFor('7d', now, null), now);
  return api;
}

test('uses the median product unit price of the newest five same-state comparable orders', () => {
  const rates = [9, .08, .04, .06, .02, .10];
  const histories = rates.map((rate, i) => history({
    inv: `INV-SOURCE-${i}`, po: `26080${i + 1}01`, desc: bag(`Design ${i}`),
    product: rate * 20000, freight: 50000, total: rate * 20000 + 50000,
  }));
  const a = app([...histories, order()], [history({product: 180000, desc: bag()})]);
  const estimate = a.estimate();
  assert.equal(estimate.amount, 1200);
  assert.equal(estimate.unit, .06);
  assert.equal(estimate.low, 400);
  assert.equal(estimate.high, 2000);
  assert.deepEqual(Array.from(estimate.sources, s => s.inv),
    ['INV-SOURCE-5', 'INV-SOURCE-4', 'INV-SOURCE-3', 'INV-SOURCE-2', 'INV-SOURCE-1']);
  assert.ok(estimate.sources.every(s => s.state === 'ca' && s.product / s.qty === s.unit));
  assert.equal(estimate.match, 'Similar product, different designs');
});

test('never borrows a historical price from the other state', () => {
  const a = app([history()], [order()]);
  const estimate = a.estimate('INV-TARGET', 'ny');
  assert.match(estimate.reason, /No comparable/);
  assert.equal(Object.hasOwn(estimate, 'amount'), false);
});

test('uses NY description quantity for a 390k label order without multiplying its design breakdown', () => {
  const a = app([], [
    history({desc: labels('Older'), qty: '200,000', product: 14000}),
    order({desc: '3.5g Jar Labels x 390k (First / Second x 20k each, Third x 10k each)', qty: ''}),
  ]);
  const estimate = a.estimate('INV-TARGET', 'ny');
  assert.equal(estimate.qty, 390000);
  assert.equal(estimate.quantitySource, 'order description');
  assert.equal(estimate.amount, 27300);
  assert.equal(estimate.sources.length, 1);
});

test('a confirmed product, total or booked amount prevents a forecast without inferring its components', () => {
  for (const field of ['product', 'total', 'due', 'nyd', 'paid']) {
    const a = app([history(), order({[field]: 123})]);
    const row = a.row(), price = a.orderPriceFields(a.state.data.ca, row);
    assert.equal(price.hasValue, true, field);
    assert.equal(price.value, 123, field);
    assert.equal(a.estimates().has(row.src), false, field);
  }
});

test('freight alone leaves the product unpriced and accompanies its estimate as a separate disclosed cost', () => {
  const a = app([history(), order({freight: 123})]);
  const price = a.orderPriceFields(a.state.data.ca, a.row());
  assert.equal(price.hasValue, false);
  assert.equal(price.value, 0);
  assert.equal(price.product, 0);
  assert.equal(price.freight, 123);
  const estimate = a.estimate();
  assert.equal(estimate.amount, 400);
  assert.equal(estimate.knownFreight, 123);
  assert.match(a.estimateBasisHtml(estimate), /\$123\.00 for freight and duty separately/);
  const report = a.report();
  assert.equal(report.ca.forecast.amount, 400);
  assert.equal(report.ca.newOrders.find(o => o.inv === 'INV-TARGET').value, 0);
  assert.equal(report.ca.nsum.val, 0);
});

test('uses confirmed product and freight or booked balances without estimating them again', () => {
  const a = app([order({product: 150, freight: 25})]);
  assert.equal(a.orderPriceFields(a.state.data.ca, a.row()).value, 175);
  a.state.data.ca = a.model([order({product: 150, freight: 25, due: 70, nyd: 20, paid: 10})]);
  assert.equal(a.orderPriceFields(a.state.data.ca, a.row()).value, 100);
  assert.equal(a.estimates().size, 0);
});

test('replaces a forecast as soon as the supplier supplies an actual product price', () => {
  const a = app([history(), order()]);
  assert.equal(a.estimate().amount, 400);
  const row = a.row(), productColumn = fields.findIndex(([key]) => key === 'product');
  row.c[productColumn] = '475';
  assert.equal(a.estimates().has(row.src), false);
  assert.equal(a.orderPriceFields(a.state.data.ca, row).value, 475);
  assert.equal(a.report().ca.forecast.amount, 0);
});

test('does not estimate an unpriced parent PO or invoice already covered by a priced row', () => {
  const a = app([
    history({inv: 'INV-CHILD', po: '26091001-1'}), order(),
    history({inv: 'INV-SHARED', po: '26080102'}),
    order({inv: 'INV-SHARED', po: '26091002'}),
  ]);
  assert.equal(a.estimates().size, 0);
});

test('excludes delivered, cancelled, void, returned and explicitly free orders', () => {
  const variants = [
    {status: 'Delivered'}, {status: 'Delivered and Full Paid'},
    {status: 'Cancelled'}, {status: 'Void'}, {status: 'Returned'},
    {comments: 'No charge'}, {comments: 'Invoice not required'},
    {comments: 'Free replacement'}, {comments: 'Free sample'}, {product: '/'},
  ];
  for (const variant of variants) {
    const a = app([history(), order(variant)]);
    assert.equal(a.estimates().has(a.row().src), false, JSON.stringify(variant));
  }
});

test('mixed products, conflicting quantities and missing quantities remain unresolved rather than zero', () => {
  const variants = [
    {desc: `${bag()} + stickers x 20k`},
    {desc: `${bag()}\nPre-roll tubes x 20k`, qty: '40000'},
    {desc: bag('Orange', '20k'), qty: '30,000'},
    {desc: '3.5g Flower Mylar Bag Orange', qty: ''},
    {desc: bag(), qty: 'unknown'},
  ];
  for (const variant of variants) {
    const a = app([history(), order(variant)]), estimate = a.estimate();
    assert.equal(typeof estimate.reason, 'string', JSON.stringify(variant));
    assert.equal(Object.hasOwn(estimate, 'amount'), false);
    assert.equal(a.report().ca.forecast.pending, 1);
    assert.equal(a.report().ca.forecast.estimated, 0);
  }
});

test('supports multiple label lines only when all line quantities agree with the total', () => {
  const a = app();
  const description = `${labels('First', '150k')}\n${labels('Second', '50k')}`;
  assert.equal(a.estimateProduct(description, '200,000').qty, 200000);
  assert.match(a.estimateProduct(description, '250,000').reason, /disagree/);
  assert.match(a.estimateProduct(`${labels('First', '150k')}\n3.5g Jar Labels Second`, '200,000').reason, /each product line/);
});

test('refuses multiple quantities on one product line even when the quantity column is filled', () => {
  const a = app([history(), order({desc: `${bag()} x 5k`, qty: '20,000'})]);
  const estimate = a.estimate();
  assert.match(estimate.reason, /Multiple quantities/);
  assert.equal(Object.hasOwn(estimate, 'amount'), false);
  assert.equal(a.report().ca.forecast.pending, 1);
  assert.equal(a.report().ca.forecast.estimated, 0);
});

test('prioritizes an exact product description over newer prices for different designs', () => {
  const a = app([
    history({inv: 'INV-EXACT', po: '26070101', desc: bag('Orange', '10k'), qty: 10000, product: 500}),
    history({inv: 'INV-FAMILY', po: '26080901', desc: bag('Purple'), product: 100}),
    order(),
  ]);
  const estimate = a.estimate();
  assert.equal(estimate.amount, 1000);
  assert.equal(estimate.match, 'Same product description');
  assert.deepEqual(Array.from(estimate.sources, s => s.inv), ['INV-EXACT']);
});

test('excludes future, undated, stale and materially different quantity sources', () => {
  const a = app([
    history({inv: 'INV-USABLE', po: '26090101', product: 600}),
    history({inv: 'INV-LATER-THAN-ORDER', po: '26091101', product: 10000}),
    history({inv: 'INV-FUTURE', po: '26100101', product: 10000}),
    history({inv: 'INV-STALE', po: '25090901', product: 10000}),
    history({inv: 'INV-UNDATED', po: 'n/a', product: 10000}),
    history({inv: 'INV-TOO-SMALL', po: '26090201', desc: bag('Orange', '1k'), qty: 1000, product: 1000}),
    history({inv: 'INV-CANCELLED', po: '26090301', status: 'Cancelled', product: 10000}),
    order(),
  ]);
  const estimate = a.estimate();
  assert.equal(estimate.amount, 600);
  assert.deepEqual(Array.from(estimate.sources, s => s.inv), ['INV-USABLE']);
});

test('multiple unresolved rows on the same PO are held instead of multiplying an estimate', () => {
  const a = app([
    history(), order({inv: 'INV-PARENT'}),
    order({inv: 'INV-SPLIT', po: '26091001-1'}),
  ]);
  const estimates = a.estimates();
  assert.equal(estimates.size, 2);
  for (const estimate of estimates.values()) {
    assert.match(estimate.reason, /Multiple rows/);
    assert.equal(Object.hasOwn(estimate, 'amount'), false);
  }
});

test('forecast calculations leave supplier data, confirmed balances and payment timing unchanged', () => {
  const known = history({product: 400, total: 500, paid: 150, due: 200, nyd: 150, dueDate: '9/20/2026'});
  const a = app([known]);
  const before = plain(a.report());
  a.state.data.ca = a.model([known, order()]);
  const dataBefore = JSON.stringify(a.state.data.ca);
  const after = plain(a.report());
  assert.equal(after.ca.forecast.amount, 400);
  assert.equal(after.ca.forecast.estimated, 1);
  assert.equal(after.ca.forecast.pending, 0);
  assert.deepEqual(after.total.all, before.total.all);
  assert.deepEqual(after.ca.all, {bal: 350, due: 200, nyd: 150});
  assert.deepEqual(after.ca.due, before.ca.due);
  assert.equal(after.ca.nsum.val, 0);
  assert.equal(JSON.stringify(a.state.data.ca), dataBefore);
});

test('mixed product contents remain unresolved inside parentheses or across slash and comma separators', () => {
  for (const desc of [
    '3.5g Flower Mylar Bags x 20k (includes 20k jar labels)',
    '3.5g Flower Mylar Bags x 20k / 3.5g Jar Labels x 20k',
    '3.5g Flower Mylar Bags x 20k, 3.5g Jar Labels x 20k',
  ]) {
    const a = app([history(), order({desc})]), estimate = a.estimate();
    assert.match(estimate.reason, /Product contents/);
    assert.equal(Object.hasOwn(estimate, 'amount'), false);
    assert.equal(a.report().ca.forecast.pending, 1);
  }
});

test('omits every ambiguous priced PO or invoice group instead of weighting shipment copies', () => {
  const groups = [
    [
      history({inv: 'INV-1234', po: '26080201-1', product: 1000}),
      history({inv: 'INV-5678', po: '26080201-2', product: 2000}),
    ],
    [
      history({inv: 'INV-1234-1', po: '26080201', product: 1000}),
      history({inv: 'INV-1234-2', po: '26080301', product: 2000}),
    ],
    [
      history({inv: 'INV-1234', po: '26080201', product: 1000}),
      history({inv: 'INV-1234-1', po: '26080301', product: 2000}),
    ],
  ];
  for (const group of groups) {
    const a = app([history({inv: 'INV-9999', product: 400}), ...group, order()]);
    const estimate = a.estimate();
    assert.equal(estimate.amount, 400);
    assert.deepEqual(Array.from(estimate.sources, s => s.inv), ['INV-9999']);
    assert.equal(estimate.low, 400);
    assert.equal(estimate.high, 400);
  }
});

test('distinct numeric invoice roots remain independent historical orders', () => {
  const a = app([
    history({inv: 'INV-1234', po: '26080101', product: 400}),
    history({inv: 'INV-5678', po: '26080201', product: 800}),
    order(),
  ]);
  const estimate = a.estimate();
  assert.equal(estimate.amount, 600);
  assert.equal(estimate.unit, .03);
  assert.deepEqual(Array.from(estimate.sources, s => s.inv), ['INV-5678', 'INV-1234']);
});

test('copied and email summaries distinguish supplier prices, forecasts and unresolved new orders', () => {
  const a = app([
    history(), order(),
    order({inv: 'INV-PRICED', po: '26090901', desc: bag('Priced'), product: 250, freight: 50, total: 300, nyd: 300}),
    order({inv: 'INV-UNRESOLVED', po: '26090902', desc: `${bag()} / Jar Labels x 20k`}),
  ]);
  const report = a.report();
  assert.equal(report.total.nsum.n, 3);
  assert.equal(report.total.nsum.val, 300);
  assert.equal(report.total.nsum.estimateVal, 400);
  const summary = a.weeklyPriceSummary(report.total.nsum);
  assert.equal(summary, '$300.00 priced · Est. $400.00 + freight · 1 pricing pending');
  const copied = a.weeklySummaryText(report);
  assert.ok(copied.includes(summary));
  assert.match(copied, /Open balance: \$300\.00/);
  assert.match(copied, /Estimates are additional to the open balance/);
  const email = a.weeklyEmailHtml(report, 'https://example.test/order-tracker.html#weekly');
  assert.ok(email.includes(summary));
  assert.match(email, /Supplier-priced total: \$300\.00/);
  assert.match(email, /Estimated product costs are separate and exclude freight\/duty/);
  assert.doesNotMatch(email, /Supplier-priced total: \$700\.00/);
});
