// Labor billing core: pay periods, pay dates, employer payroll tax, and who gets billed.
// Run: node --test tests/labor-billing-core.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../labor-billing-core.js', import.meta.url), 'utf8');
const load = () => { const sandbox = {}; vm.runInNewContext(SRC, sandbox); return sandbox.LaborBilling; };
const LB = load();
// Objects from the vm realm have their own prototypes; compare them as plain JSON.
const plain = v => JSON.parse(JSON.stringify(v));
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} expected ${b}, got ${a}`);
const DAY = 86400000;
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

test('exposes the contract', () => {
  for (const k of ['TAX', 'SITES', 'GUSTO_HV_PREFIX', 'PAY_LAG_DAYS', 'isGustoHarvest', 'isGustoPaid', 'periodStartOf', 'periodEnd',
    'payDateOf', 'taxYearOf', 'ytdStartOf', 'employerTax', 'compute']) {
    assert.ok(k in LB, k);
  }
  assert.equal(LB.GUSTO_HV_PREFIX, 'gusto-filifera-hv:');
  assert.equal(LB.PAY_LAG_DAYS, 5);
  assert.deepEqual(plain(LB.SITES), {
    Slane: { customer: 'Slane Inc (Customer)', label: '23rd Street', legal: 'Slane Inc.', key: 'slane' },
    Imperial: { customer: 'Imperial Project LLC (Customer)', label: 'Imperial', legal: 'Imperial Project LLC', key: 'imperial' },
  });
  near(LB.TAX.allWagesRate, LB.TAX.socialSecurity + LB.TAX.medicare, 'FICA');
  near(LB.TAX.underBaseRate, LB.TAX.futa + LB.TAX.caSui + LB.TAX.caEtt, 'unemployment');
  assert.equal(LB.TAX.wageBase, 7000);
});

test('the header says year-to-date comes only from the board and the base may be crossed earlier', () => {
  const head = SRC.slice(0, SRC.indexOf('(function'));
  assert.match(head, /Year-to-date pay comes ONLY from Gusto-paid rows on this board/);
  assert.match(head, /trimmer jobs/);
  assert.match(head, /cross \$7,000\s+earlier than the board shows/);
  assert.match(head, /PAY DATE/);
});

test('no em dashes in the core or its user-facing text', () => {
  assert.equal(SRC.includes(String.fromCharCode(0x2014)), false);
});

test('pay periods: 14 days from 2026-07-04, across month and year boundaries', () => {
  const cases = {   // date -> period start (checked independently with Python date math)
    '2026-07-04': '2026-07-04', '2026-07-17': '2026-07-04', '2026-07-18': '2026-07-18',
    '2026-07-31': '2026-07-18', '2026-08-01': '2026-08-01',
    '2026-10-23': '2026-10-10', '2026-10-24': '2026-10-24', '2026-11-06': '2026-10-24',
    '2026-12-18': '2026-12-05', '2026-12-19': '2026-12-19', '2026-12-31': '2026-12-19',
    '2027-01-01': '2026-12-19', '2027-01-02': '2027-01-02',
    '2026-07-03': '2026-06-20', '2026-01-01': '2025-12-20',
    '2028-02-29': '2028-02-26', '2028-03-01': '2028-02-26',
  };
  for (const [d, start] of Object.entries(cases)) assert.equal(LB.periodStartOf(d), start, d);
  assert.equal(LB.periodEnd('2026-10-10'), '2026-10-23');
  assert.equal(LB.periodEnd('2026-10-24'), '2026-11-06');
  assert.equal(LB.periodEnd('2026-07-18'), '2026-07-31');
  assert.equal(LB.periodEnd('2026-12-19'), '2027-01-01');
  assert.equal(LB.periodEnd('2028-02-26'), '2028-03-10');
  assert.equal(LB.periodStartOf('2026-10-24T23:30:00'), '2026-10-24', 'timestamp suffix ignored');
  for (const bad of ['', null, undefined, 'garbage', '2026-02-30', '2026-13-01']) assert.equal(LB.periodStartOf(bad), null, String(bad));
});

test('pay periods: every day 2025 to 2028 falls in an aligned 14-day window', () => {
  const anchor = Date.UTC(2026, 6, 4);
  for (let t = Date.UTC(2025, 0, 1); t <= Date.UTC(2028, 11, 31); t += DAY) {
    const d = new Date(t).toISOString().slice(0, 10);
    const s = LB.periodStartOf(d), e = LB.periodEnd(s);
    assert.ok(s <= d && d <= e, `${d} in ${s}..${e}`);
    const offset = (Date.parse(s + 'T00:00:00Z') - anchor) / DAY;
    assert.equal(((offset % 14) + 14) % 14, 0, `${s} aligned`);
    assert.equal((Date.parse(e + 'T00:00:00Z') - Date.parse(s + 'T00:00:00Z')) / DAY, 13);
  }
});

test('pay periods do not depend on the local time zone', () => {
  const saved = process.env.TZ;
  try {
    for (const tz of ['Pacific/Kiritimati', 'America/Los_Angeles', 'Pacific/Pago_Pago']) {
      process.env.TZ = tz;
      const L = load();
      assert.equal(L.periodStartOf('2026-10-24'), '2026-10-24', tz);
      assert.equal(L.periodStartOf('2026-10-23'), '2026-10-10', tz);
      assert.equal(L.periodEnd('2026-12-19'), '2027-01-01', tz);
      assert.equal(L.payDateOf('2026-12-19'), '2027-01-06', tz);
      assert.equal(L.ytdStartOf('2027-01-02'), '2026-12-19', tz);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

test('pay dates: 5 days after the period ends; the tax year is the pay year', () => {
  assert.equal(LB.payDateOf('2026-09-26'), '2026-10-14', 'Sep 26 to Oct 9 was paid Oct 14');
  assert.equal(LB.payDateOf('2026-10-01'), '2026-10-14', 'any date in the period');
  assert.equal(LB.payDateOf('2026-10-10'), '2026-10-28');
  assert.equal(LB.payDateOf('2026-12-05'), '2026-12-23');
  assert.equal(LB.payDateOf('2026-12-19'), '2027-01-06');
  assert.equal(LB.payDateOf('2027-01-02'), '2027-01-20');
  assert.equal(LB.taxYearOf('2026-12-05'), '2026');
  assert.equal(LB.taxYearOf('2026-12-19'), '2027');
  assert.equal(LB.taxYearOf('2026-12-31'), '2027', 'worked in 2026, paid in 2027');
  for (const bad of ['', null, 'soon', '2026-02-30']) {
    assert.equal(LB.payDateOf(bad), null, String(bad));
    assert.equal(LB.taxYearOf(bad), null, String(bad));
    assert.equal(LB.ytdStartOf(bad), null, String(bad));
  }
  // the reviewer's known answers
  assert.equal(LB.ytdStartOf('2027-01-02'), '2026-12-19');
  assert.equal(LB.ytdStartOf('2026-12-19'), '2026-12-19');
  assert.equal(LB.ytdStartOf('2026-12-05'), '2025-12-20');
  assert.equal(LB.ytdStartOf('2026-10-10'), '2025-12-20');
  assert.equal(LB.ytdStartOf('2026-01-03'), '2025-12-20');
});

test('ytdStartOf is the first period paid in the same year, for every period 2025 to 2032', () => {
  for (let s = LB.periodStartOf('2025-01-01'); s <= '2032-12-31'; s = addDays(s, 14)) {
    const y = LB.taxYearOf(s), ys = LB.ytdStartOf(s);
    assert.equal(LB.payDateOf(s).slice(0, 4), y, s);
    assert.ok(ys <= s, `${s}: ytd start ${ys} is not after the period`);
    assert.equal(LB.periodStartOf(ys), ys, `${s}: ${ys} is a period start`);
    assert.equal(LB.taxYearOf(ys), y, `${s}: ${ys} is paid in ${y}`);
    assert.equal(LB.taxYearOf(addDays(ys, -14)), String(+y - 1), `${s}: the period before ${ys} is paid in ${+y - 1}`);
  }
});

test('employer tax: 13.55% under the $7,000 base, 7.65% over it, split when crossing', () => {
  assert.equal(LB.employerTax(1000, 0), 135.5);
  assert.equal(LB.employerTax(1000, 7500), 76.5);
  assert.equal(LB.employerTax(1000, 7000), 76.5);
  assert.equal(LB.employerTax(1000, 6500), 106);          // 76.50 + 29.50
  assert.equal(LB.employerTax(500, 6800), 50.05);         // 38.25 + 11.80
  assert.equal(LB.employerTax(7000, 0), 948.5);
  assert.equal(LB.employerTax(8000, 0), 1025.0);          // 612.00 + 413.00
  assert.equal(LB.employerTax(0, 0), 0);
  assert.equal(LB.employerTax(333.33, 0), 45.17);         // 45.166215
  // rounded once at the end: 7.65765 + 5.9059 = 13.56355 -> 13.56 (rounding each part first gives 13.57)
  assert.equal(LB.employerTax(100.1, 0), 13.56);
});

test('isGustoHarvest: only Gusto Deleaf/Harvest imports', () => {
  const base = { category: 'harvest', source: 'import', source_id: 'gusto-filifera-hv:r1:2026-10-20:slane' };
  assert.equal(LB.isGustoHarvest(base), true);
  assert.equal(LB.isGustoHarvest({ ...base, source: 'manual' }), false, "Norma's sheet row");
  assert.equal(LB.isGustoHarvest({ ...base, source: 'ocr' }), false);
  assert.equal(LB.isGustoHarvest({ ...base, source_id: 'gusto-filifera-pkg:r1:2026-10-20' }), false, 'packager import');
  assert.equal(LB.isGustoHarvest({ ...base, source_id: null }), false);
  assert.equal(LB.isGustoHarvest({ ...base, category: 'distro' }), false);
});

test('isGustoPaid: Gusto harvest rows, and distro rows of Gusto people from their start date', () => {
  const roster = [
    { id: 'g1', last: 'A', first: 'X', gusto_distro: true, gusto_distro_from: '2026-09-16' },
    { id: 'g2', last: 'B', first: 'Y', gusto_distro: true, gusto_distro_from: null },
    { id: 'n1', last: 'C', first: 'Z', gusto_distro: false },
  ];
  const distro = (roster_id, work_date, extra = {}) => ({ category: 'distro', roster_id, work_date, ...extra });
  assert.equal(LB.isGustoPaid(distro('g1', '2026-09-15'), roster), false, 'before gusto_distro_from');
  assert.equal(LB.isGustoPaid(distro('g1', '2026-09-16'), roster), true, 'on gusto_distro_from');
  assert.equal(LB.isGustoPaid(distro('g2', '2026-01-05'), roster), true, 'no start date');
  assert.equal(LB.isGustoPaid(distro('n1', '2026-10-01'), roster), false, 'not a Gusto person');
  assert.equal(LB.isGustoPaid(distro(null, '2026-10-01', { last: 'A', first: 'X' }), roster), false, 'matched by roster_id only');
  assert.equal(LB.isGustoPaid({ roster_id: 'g2', work_date: '2026-10-01' }, roster), true, 'missing category means distro');
  assert.equal(LB.isGustoPaid({ category: 'harvest', source: 'manual', roster_id: 'g1', work_date: '2026-10-01' }, roster), false, 'sheet harvest row');
  assert.equal(LB.isGustoPaid({ category: 'harvest', source: 'import', source_id: 'gusto-filifera-hv:n1:2026-10-20:slane', roster_id: 'n1', work_date: '2026-10-20' }, roster), true, 'Gusto harvest is Gusto-paid whoever it is');
});

// ---- compute() fixtures -------------------------------------------------------
const ROSTER = [
  { id: 'r-luc', last: 'Lucero', first: 'Ana', team: "Norma's Team", gusto_distro: true, gusto_distro_from: '2026-09-16', aliases: [], active: true },
  { id: 'r-wen', last: 'Hernandez', first: 'Wendy', team: "Norma's Team", gusto_distro: true, gusto_distro_from: '2026-10-15', aliases: [], active: true },
  { id: 'r-dor', last: 'Lopez', first: 'Dora', team: "Norma's Team", gusto_distro: false, gusto_distro_from: null, aliases: [], active: true },
  { id: 'r-old', last: 'Over', first: 'Base', team: 'Gusto Team', gusto_distro: true, gusto_distro_from: null, aliases: [], active: true },
  { id: 'r-nor', last: 'Diaz', first: 'Nora', team: "Norma's Team", gusto_distro: false, gusto_distro_from: null, aliases: [], active: true },
  { id: 'r-chu', last: 'Gomez', first: 'Jesus', team: "Norma's Team", gusto_distro: true, gusto_distro_from: null, aliases: ['Chuy'], active: true },
  { id: 'r-tom', last: 'Ruiz', first: 'Tomas', team: "Norma's Team", gusto_distro: false, gusto_distro_from: null, aliases: [], active: true },
];
let seq = 0;
const row = (o) => ({
  id: 'row-' + (++seq), category: 'distro', company: 'Filifera', last: '', first: '', roster_id: null,
  clock_in: '08:00', clock_out: '16:30', break_minutes: 30, hours: 8, rate: 20, total: 160,
  people: 1, team: null, source: 'manual', source_id: null, note: null, pay_period: null, ...o,
});
const gustoHv = (rosterId, date, company, o = {}) => row({
  category: 'harvest', company, work_date: date, roster_id: rosterId, team: 'Gusto Team',
  source: 'import', source_id: `gusto-filifera-hv:${rosterId || 'x'}:${date}:${company.toLowerCase()}`, ...o,
});
const gustoDistro = (rosterId, date, total, o = {}) => row({ roster_id: rosterId, work_date: date, total, hours: total / 20, ...o });
const sheetHv = (rosterId, date, company, o = {}) => row({ category: 'harvest', company, work_date: date, roster_id: rosterId, team: 'Harvest', source: 'ocr', ...o });

const ROWS = [
  // Ana Lucero: board YTD 6,500 (Gusto distro from 9/16 on), period Gusto pay 1,000
  gustoDistro('r-luc', '2026-09-20', 3000),
  gustoDistro('r-luc', '2026-10-05', 3500),
  gustoDistro('r-luc', '2026-09-10', 400),                          // before gusto_distro_from: not Gusto-paid
  gustoDistro('r-luc', '2025-12-30', 1000, { pay_period: null }),    // before gusto_distro_from: not Gusto-paid
  row({ category: 'harvest', company: 'Slane', roster_id: 'r-luc', work_date: '2026-10-01', total: 300, source: 'ocr' }), // sheet row, earlier period
  gustoHv('r-luc', '2026-10-13', 'Slane', { pay_period: '2026-10-24', note: 'Approved in Gusto' }),   // carried pay_period; work_date still in period
  gustoHv('r-luc', '2026-10-14', 'Slane', { note: 'Unapproved in Gusto' }),
  gustoHv('r-luc', '2026-10-15', 'Imperial'),                        // other site: counts toward period pay, not billed to Slane
  gustoDistro('r-luc', '2026-10-16', 160),
  gustoDistro('r-luc', '2026-10-19', 160),
  gustoDistro('r-luc', '2026-10-20', 200, { hours: 10 }),            // over 8h, but on a day with nothing billed
  gustoHv('r-luc', '2026-10-25', 'Slane', { pay_period: '2026-10-10' }),   // next period by work_date
  row({ category: 'harvest', company: 'Slane', roster_id: 'r-luc', work_date: '2026-10-14', total: 150, hours: 7.5, source: 'manual', team: 'Deleaf' }), // a sheet row for a Gusto person
  // Wendy Hernandez: no earlier board pay, one 10-hour Gusto harvest day at Slane
  gustoHv('r-wen', '2026-10-20', 'Slane', { clock_in: '07:00', clock_out: '17:30', hours: 10, total: 200 }),
  // Felipe Ramirez: Gusto harvest row with no roster link
  gustoHv(null, '2026-10-21', 'Slane', { last: 'Ramirez', first: 'Felipe', hours: 4, total: 80 }),
  // Norma's crew and look-alikes that must never be billed
  row({ category: 'harvest', company: 'Slane', roster_id: 'r-dor', work_date: '2026-10-14', total: 200, hours: 10, source: 'ocr', team: 'Harvest' }),
  row({ category: 'harvest', company: 'Slane', roster_id: 'r-dor', work_date: '2026-10-15', total: 170, source: 'import', source_id: 'gusto-filifera-pkg:r-dor:2026-10-15' }),
  row({ category: 'harvest', company: 'Slane', roster_id: 'r-dor', work_date: '2026-10-16', total: 170, source: 'import', source_id: null }),
  gustoHv('r-dor', '2026-10-17', 'Olympic'),                          // Olympic is not billed to Slane (and makes Dora a Gusto person)
  sheetHv('r-tom', '2026-10-14', 'Slane'),                            // Norma's crew, never on Gusto: no warning
];

test("compute: bills only Gusto harvest rows at the company in the period, at each person's blended rate", () => {
  const out = LB.compute({ rows: ROWS, roster: ROSTER, company: 'Slane', periodStart: '2026-10-10' });
  assert.equal(out.company, 'Slane');
  assert.equal(out.periodStart, '2026-10-10');
  assert.equal(out.periodEnd, '2026-10-23');
  assert.equal(out.payDate, '2026-10-28');
  assert.equal(out.taxYear, '2026');
  assert.equal(out.ytdStart, '2025-12-20');
  assert.deepEqual(plain(out.site), plain(LB.SITES.Slane));
  assert.deepEqual(plain(out.people.map(p => p.name)), ['Ana Lucero', 'Felipe Ramirez', 'Wendy Hernandez']);

  const [ana, felipe, wendy] = out.people;
  assert.equal(ana.rosterId, 'r-luc');
  assert.deepEqual(plain(ana.rows.map(r => r.work_date)), ['2026-10-13', '2026-10-14']);
  assert.ok(ana.rows.every(r => r.source === 'import'), 'no sheet rows billed');
  assert.deepEqual(plain(ana.rows.map(r => r.note)), ['Approved in Gusto', 'Unapproved in Gusto'], 'each row keeps its note');
  assert.equal(ana.hours, 16);
  assert.equal(ana.wages, 320);
  assert.equal(ana.ytdBefore, 6500);
  assert.equal(ana.periodGustoWages, 1000);              // 320 Slane + 160 Imperial + 520 distro
  near(ana.taxRate, 0.106);                              // employerTax(1000, 6500) = 106.00
  assert.equal(ana.tax, 33.92);
  assert.equal(ana.total, 353.92);
  // the rows behind ytdBefore and periodGustoWages
  const basis = plain(ana.basisRows);
  assert.deepEqual(basis.filter(b => b.inYtd).map(b => [b.work_date, b.category, b.total]), [['2026-09-20', 'distro', 3000], ['2026-10-05', 'distro', 3500]]);
  assert.deepEqual(basis.filter(b => !b.inYtd).map(b => [b.work_date, b.category, b.company]), [
    ['2026-10-13', 'harvest', 'Slane'], ['2026-10-14', 'harvest', 'Slane'], ['2026-10-15', 'harvest', 'Imperial'],
    ['2026-10-16', 'distro', 'Filifera'], ['2026-10-19', 'distro', 'Filifera'], ['2026-10-20', 'distro', 'Filifera'],
  ]);
  assert.equal(basis.filter(b => !b.inYtd).reduce((s, b) => s + b.total, 0), ana.periodGustoWages);

  assert.equal(wendy.rosterId, 'r-wen');
  assert.equal(wendy.ytdBefore, 0);
  assert.equal(wendy.periodGustoWages, 200);
  near(wendy.taxRate, 0.1355);
  assert.equal(wendy.tax, 27.1);
  assert.equal(wendy.total, 227.1);

  assert.equal(felipe.rosterId, null);
  assert.equal(felipe.wages, 80);
  assert.equal(felipe.tax, 10.84);

  assert.deepEqual(plain(out.totals), { hours: 30, wages: 600, tax: 71.86, total: 671.86 });

  const w = out.warnings.join('\n');
  assert.match(w, /Wendy Hernandez worked 10 Gusto-paid hours on 2026-10-20 \(all jobs and sites\)\. Gusto pays overtime past 8 hours a day/);
  assert.doesNotMatch(w, /Ana Lucero worked/, 'her 10-hour distro day has nothing billed on it');
  assert.match(w, /Not linked to a roster person.*Felipe Ramirez/);
  assert.match(w, /Ana Lucero is on Gusto but has harvest hours at 23rd Street on 2026-10-14 \(7\.5 h, team Deleaf\): entered from the sheet, paid in Norma's Team, not billed\. If Gusto paid it, remove the sheet row\./);
  assert.match(w, /Dora Lopez is on Gusto but has harvest hours at 23rd Street on 2026-10-14 \(10 h, team Harvest\), 2026-10-15 \(8 h\), 2026-10-16 \(8 h\)/);
  assert.doesNotMatch(w, /Tomas Ruiz/, "Norma's crew who are never on Gusto");
  assert.match(w, /Year-to-date pay counts only Gusto-paid rows on this board .* paid in 2026\. Other Filifera Gusto pay, such as trimmer jobs, is not on the board/);
  assert.equal(w.includes(String.fromCharCode(0x2014)), false, 'no em dashes');
  assert.equal(out.warnings.length, 5);
});

test('compute: keeps the shape the page and the script read', () => {
  const out = LB.compute({ rows: ROWS, roster: ROSTER, company: 'Slane', periodStart: '2026-10-10' });
  for (const k of ['company', 'site', 'periodStart', 'periodEnd', 'people', 'totals', 'warnings', 'payDate']) assert.ok(k in out, k);
  assert.deepEqual(Object.keys(out.totals).sort(), ['hours', 'tax', 'total', 'wages']);
  for (const p of out.people) {
    for (const k of ['rosterId', 'name', 'rows', 'hours', 'wages', 'ytdBefore', 'periodGustoWages', 'taxRate', 'tax', 'total']) assert.ok(k in p, k);
    for (const k of ['hours', 'wages', 'ytdBefore', 'periodGustoWages', 'taxRate', 'tax', 'total']) assert.ok(Number.isFinite(p[k]), `${p.name} ${k}`);
    assert.ok(p.rows.every(r => ROWS.includes(r)), 'billed rows are the board rows themselves');
  }
});

test('compute: the same person at Imperial is billed at the same blended rate', () => {
  const out = LB.compute({ rows: ROWS, roster: ROSTER, company: 'Imperial', periodStart: '2026-10-10' });
  assert.deepEqual(plain(out.site), plain(LB.SITES.Imperial));
  assert.equal(out.people.length, 1);
  const [ana] = out.people;
  assert.equal(ana.wages, 160);
  assert.equal(ana.periodGustoWages, 1000);
  assert.equal(ana.tax, 16.96);                          // 160 x 10.6%
  assert.deepEqual(plain(out.totals), { hours: 8, wages: 160, tax: 16.96, total: 176.96 });
  assert.doesNotMatch(out.warnings.join('\n'), /is on Gusto but has harvest hours/, 'the sheet rows are at Slane');
});

test("compute: Norma's crew and distro rows are never billed, even at the billed company", () => {
  const rows = [
    row({ category: 'harvest', company: 'Slane', roster_id: 'r-dor', work_date: '2026-10-14', source: 'ocr' }),
    row({ category: 'harvest', company: 'Slane', roster_id: 'r-dor', work_date: '2026-10-15', source: 'manual' }),
    row({ category: 'harvest', company: 'Slane', roster_id: 'r-luc', work_date: '2026-10-15', source: 'notes' }),
    gustoDistro('r-luc', '2026-10-16', 160, { company: 'Slane' }),
    gustoDistro('r-old', '2026-10-16', 160, { company: 'Slane' }),
  ];
  const out = LB.compute({ rows, roster: ROSTER, company: 'Slane', periodStart: '2026-10-10' });
  assert.equal(out.people.length, 0);
  assert.deepEqual(plain(out.totals), { hours: 0, wages: 0, tax: 0, total: 0 });
  // Dora is not on Gusto here (no Gusto row of hers in this set); Ana is, so her sheet row is flagged
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /^Ana Lucero is on Gusto but has harvest hours at 23rd Street on 2026-10-15 \(8 h\): entered from the sheet/);
});

test('compute: someone past $7,000 on the board is billed 7.65%; year-to-date follows the pay date', () => {
  const rows = [
    gustoDistro('r-old', '2025-12-19', 500),              // 2025-12-06 period, paid 2025-12-24: the 2025 base
    gustoDistro('r-old', '2025-12-22', 400),              // 2025-12-20 period, paid 2026-01-07: the 2026 base
    gustoDistro('r-old', '2026-03-02', 5000),
    gustoDistro('r-old', '2026-06-01', 3000),
    gustoDistro('r-old', '2026-10-09', 999),              // the day before the period: still YTD
    gustoHv('r-old', '2026-10-10', 'Slane', { total: 100, hours: 5 }),
  ];
  const [p] = LB.compute({ rows, roster: ROSTER, company: 'Slane', periodStart: '2026-10-10' }).people;
  assert.equal(p.ytdBefore, 9399);
  assert.equal(p.periodGustoWages, 100);
  near(p.taxRate, 0.0765);
  assert.equal(p.tax, 7.65);
  assert.equal(p.total, 107.65);
  assert.deepEqual(plain(p.basisRows.filter(b => b.inYtd).map(b => b.work_date)), ['2025-12-22', '2026-03-02', '2026-06-01', '2026-10-09']);
});

// ---- the $7,000 base across New Year: the reviewer's examples -----------------
const DEC = [
  gustoDistro('r-old', '2026-06-01', 9000),                          // paid in 2026
  gustoHv('r-old', '2026-12-21', 'Slane', { total: 800, hours: 8 }),
  gustoHv('r-old', '2026-12-28', 'Slane', { total: 800, hours: 8 }),
];

test('year boundary: the 2026-12-19 period is paid 2027-01-06, so its year-to-date is 0', () => {
  const out = LB.compute({ rows: DEC, roster: ROSTER, company: 'Slane', periodStart: '2026-12-19' });
  assert.equal(out.periodEnd, '2027-01-01');
  assert.equal(out.payDate, '2027-01-06');
  assert.equal(out.taxYear, '2027');
  assert.equal(out.ytdStart, '2026-12-19');
  const [p] = out.people;
  assert.equal(p.ytdBefore, 0, 'the $9,000 paid in 2026 does not count');
  assert.equal(p.periodGustoWages, 1600);
  assert.equal(p.tax, 216.8);                             // 1,600 x 13.55%
  assert.equal(p.total, 1816.8);
  const w = out.warnings.join('\n');
  assert.match(w, /paid on 2027-01-06, the first payday of 2027, so the \$7,000 unemployment-tax base starts over/);
  assert.match(w, /paid in 2027\./);
});

test('year boundary: the 2027-01-02 period counts the 12/19 to 12/31 wages, which were paid in 2027', () => {
  const rows = [...DEC, gustoHv('r-old', '2027-01-04', 'Slane', { total: 6000, hours: 8 })];
  const out = LB.compute({ rows, roster: ROSTER, company: 'Slane', periodStart: '2027-01-02' });
  assert.equal(out.payDate, '2027-01-20');
  assert.equal(out.ytdStart, '2026-12-19');
  const [p] = out.people;
  assert.equal(p.ytdBefore, 1600);
  assert.equal(p.periodGustoWages, 6000);
  assert.equal(p.tax, 777.6);                             // 6,000 x 7.65% + 5,400 x 5.9% (not 813.00)
  assert.match(out.warnings.join('\n'), /Year-to-date counts Gusto wages paid in 2027, which starts with the 2026-12-19 to 2027-01-01 pay period \(paid 2027-01-06\)/);
});

test('year boundary: the 2026-12-05 period is paid 2026-12-23 and keeps the 2026 year-to-date', () => {
  const rows = [...DEC, gustoHv('r-old', '2026-12-07', 'Slane', { total: 500, hours: 8 })];
  const out = LB.compute({ rows, roster: ROSTER, company: 'Slane', periodStart: '2026-12-05' });
  assert.equal(out.payDate, '2026-12-23');
  const [p] = out.people;
  assert.equal(p.ytdBefore, 9000);
  assert.equal(p.tax, 38.25);
  assert.doesNotMatch(out.warnings.join('\n'), /first payday|starts with the/);
});

test('year boundary: the 2026-01-03 period counts the 2025-12-20 period (paid 2026-01-07), not earlier December', () => {
  const rows = [
    gustoDistro('r-old', '2025-12-10', 5000),             // paid 2025-12-24
    gustoDistro('r-old', '2025-12-22', 6500),             // paid 2026-01-07
    gustoHv('r-old', '2026-01-05', 'Slane', { total: 1000, hours: 8 }),
  ];
  const out = LB.compute({ rows, roster: ROSTER, company: 'Slane', periodStart: '2026-01-03' });
  assert.equal(out.ytdStart, '2025-12-20');
  const [p] = out.people;
  assert.equal(p.ytdBefore, 6500);
  assert.equal(p.tax, 106);                               // 76.50 + 500 x 5.9%
  assert.match(out.warnings.join('\n'), /starts with the 2025-12-20 to 2026-01-02 pay period \(paid 2026-01-07\)/);
});

test('year boundary: a January 1 payday (2030-12-14 period) says to check the Gusto pay date', () => {
  const out = LB.compute({ rows: [gustoHv('r-old', '2030-12-16', 'Slane')], roster: ROSTER, company: 'Slane', periodStart: '2030-12-14' });
  assert.equal(out.payDate, '2031-01-01');
  assert.equal(out.ytdStart, '2030-12-14');
  assert.match(out.warnings.join('\n'), /payday works out to 2031-01-01, a bank holiday\. If Gusto paid on 2030-12-31 instead, these wages count toward the 2030 base/);
});

test('year notes appear only when someone is billed', () => {
  assert.deepEqual(plain(LB.compute({ rows: [], roster: ROSTER, company: 'Slane', periodStart: '2026-12-19' }).warnings), []);
  assert.deepEqual(plain(LB.compute({ rows: [], roster: ROSTER, company: 'Slane', periodStart: '2026-12-05' }).warnings), []);
});

// ---- precision ----------------------------------------------------------------
test('compute: hours keep 3 decimals and wages are exactly the sum of the row totals', () => {
  const rows = [
    gustoHv('r-wen', '2026-10-20', 'Imperial', { hours: 4.367, total: 87.34 }),
    gustoHv('r-wen', '2026-10-21', 'Imperial', { hours: 2.333, total: 46.66 }),
    gustoHv('r-wen', '2026-10-22', 'Imperial', { hours: 1.001, total: 20.02 }),
  ];
  const out = LB.compute({ rows, roster: ROSTER, company: 'Imperial', periodStart: '2026-10-10' });
  const [p] = out.people;
  assert.equal(p.hours, 7.701);
  assert.equal(p.wages, 154.02);
  near(p.wages / p.hours, 20, 'unit price');
  assert.equal(out.totals.hours, 7.701);
  assert.equal(p.tax, 20.87);                             // 154.02 x 13.55% = 20.86971
  assert.equal(p.total, 174.89);

  // ten 10-cent rows: floating point would sum to 0.9999999999999999
  const dimes = Array.from({ length: 10 }, (_, i) => gustoHv('r-old', '2026-10-1' + i, 'Slane', { hours: 0.005, total: 0.1 }));
  const [q] = LB.compute({ rows: dimes, roster: ROSTER, company: 'Slane', periodStart: '2026-10-10' }).people;
  assert.equal(q.wages, 1);
  assert.equal(q.hours, 0.05);
  assert.equal(q.periodGustoWages, 1);

  const one = LB.compute({ rows: [gustoHv('r-wen', '2026-10-20', 'Imperial', { hours: 4.367, total: 87.34 })], roster: ROSTER, company: 'Imperial', periodStart: '2026-10-10' });
  assert.equal(one.people[0].hours, 4.367, "Wendy's 10/20 row: 4.367 h, not 4.37");
  assert.equal(one.people[0].wages / one.people[0].hours, 20);
});

// ---- overtime -----------------------------------------------------------------
test('overtime: a billed day over 8 Gusto-paid hours across all jobs and sites is flagged; sheet hours do not count', () => {
  const rows = [
    gustoDistro('r-luc', '2026-10-12', 80, { hours: 4 }),                       // distro morning
    gustoHv('r-luc', '2026-10-12', 'Slane', { hours: 5, total: 100 }),          // harvest afternoon: 9 h
    gustoHv('r-luc', '2026-10-13', 'Slane', { hours: 5, total: 100 }),          // two sites: 9 h
    gustoHv('r-luc', '2026-10-13', 'Imperial', { hours: 4, total: 80 }),
    sheetHv('r-luc', '2026-10-14', 'Slane', { hours: 4, total: 80 }),           // sheet row: not Gusto-paid
    gustoHv('r-luc', '2026-10-14', 'Slane', { hours: 5, total: 100 }),
    gustoDistro('r-luc', '2026-10-15', 60, { hours: 3 }),                       // exactly 8 h
    gustoHv('r-luc', '2026-10-15', 'Slane', { hours: 5, total: 100 }),
  ];
  const slane = LB.compute({ rows, roster: ROSTER, company: 'Slane', periodStart: '2026-10-10' }).warnings.filter(w => /overtime/.test(w));
  assert.deepEqual(plain(slane), [
    'Ana Lucero worked 9 Gusto-paid hours on 2026-10-12 (all jobs and sites). Gusto pays overtime past 8 hours a day; only straight-time wages are billed.',
    'Ana Lucero worked 9 Gusto-paid hours on 2026-10-13 (all jobs and sites). Gusto pays overtime past 8 hours a day; only straight-time wages are billed.',
  ]);
  const imperial = LB.compute({ rows, roster: ROSTER, company: 'Imperial', periodStart: '2026-10-10' }).warnings.filter(w => /overtime/.test(w));
  assert.deepEqual(plain(imperial), [
    'Ana Lucero worked 9 Gusto-paid hours on 2026-10-13 (all jobs and sites). Gusto pays overtime past 8 hours a day; only straight-time wages are billed.',
  ]);
});

test('overtime: a Saturday-to-Friday week over 40 Gusto-paid hours is flagged', () => {
  const rows = [
    gustoDistro('r-old', '2026-10-10', 140, { hours: 7 }),   // Saturday
    gustoDistro('r-old', '2026-10-12', 140, { hours: 7 }),
    gustoDistro('r-old', '2026-10-13', 140, { hours: 7 }),
    gustoDistro('r-old', '2026-10-14', 140, { hours: 7 }),
    gustoDistro('r-old', '2026-10-15', 140, { hours: 7 }),
    gustoHv('r-old', '2026-10-16', 'Slane', { hours: 7, total: 140 }),   // Friday: 42 h for the week
  ];
  const w = LB.compute({ rows, roster: ROSTER, company: 'Slane', periodStart: '2026-10-10' }).warnings.filter(x => /overtime/.test(x));
  assert.deepEqual(plain(w), ['Base Over worked 42 Gusto-paid hours in the week 2026-10-10 to 2026-10-16 (Saturday to Friday, all jobs and sites). Gusto pays overtime past 40 hours a week; only straight-time wages are billed.']);
});

test('overtime: weeks break on Saturday, so 49 hours Monday to Sunday is not a 40-hour week', () => {
  const rows = [
    ...['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'].map(d => gustoDistro('r-old', d, 140, { hours: 7 })),
    gustoHv('r-old', '2026-10-16', 'Slane', { hours: 7, total: 140 }),   // week 1: 35 h
    gustoHv('r-old', '2026-10-17', 'Slane', { hours: 7, total: 140 }),   // week 2: 14 h
    gustoHv('r-old', '2026-10-18', 'Slane', { hours: 7, total: 140 }),
  ];
  const w = LB.compute({ rows, roster: ROSTER, company: 'Slane', periodStart: '2026-10-10' }).warnings;
  assert.equal(w.filter(x => /overtime/.test(x)).length, 0);
});

// ---- Gusto wins over sheets ---------------------------------------------------
test('sheet rows of Gusto people at the billed site are flagged; others are not', () => {
  const rows = [
    sheetHv('r-luc', '2026-10-14', 'Slane'),                                  // Gusto for distro since 9/16
    sheetHv('r-wen', '2026-10-12', 'Slane'),                                  // before her Gusto start (10/15): quiet
    sheetHv('r-wen', '2026-10-16', 'Slane', { source: 'manual', team: "Norma's Team", hours: 6.25 }),
    sheetHv('r-dor', '2026-10-14', 'Slane'),                                  // never on Gusto here: quiet
    gustoHv('r-nor', '2026-09-30', 'Imperial'),                               // Nora: a Gusto harvest row elsewhere, earlier
    sheetHv(null, '2026-10-13', 'Slane', { last: 'Diaz', first: 'Nora' }),    // unlinked sheet row, found by name
    gustoHv(null, '2026-10-21', 'Imperial', { last: 'Ramirez', first: 'Felipe' }), // unlinked Gusto row
    sheetHv(null, '2026-10-15', 'Slane', { last: 'Ramirez', first: 'Felipe' }),
    sheetHv(null, '2026-10-19', 'Slane', { last: 'Gomez', first: 'Chuy' }),   // alias of Jesus Gomez (Gusto)
    sheetHv('r-luc', '2026-10-14', 'Imperial'),                               // other site: not on the Slane bill
    sheetHv('r-luc', '2026-10-24', 'Slane'),                                  // next period
    gustoDistro('r-luc', '2026-10-15', 160, { company: 'Slane' }),            // distro, not harvest
  ];
  const out = LB.compute({ rows, roster: ROSTER, company: 'Slane', periodStart: '2026-10-10' });
  assert.equal(out.people.length, 0);
  const tail = ": entered from the sheet, paid in Norma's Team, not billed. If Gusto paid it, remove the sheet row.";
  assert.deepEqual(plain(out.warnings), [
    'Ana Lucero is on Gusto but has harvest hours at 23rd Street on 2026-10-14 (8 h, team Harvest)' + tail,
    'Felipe Ramirez is on Gusto but has harvest hours at 23rd Street on 2026-10-15 (8 h, team Harvest)' + tail,
    'Jesus Gomez is on Gusto but has harvest hours at 23rd Street on 2026-10-19 (8 h, team Harvest)' + tail,
    'Nora Diaz is on Gusto but has harvest hours at 23rd Street on 2026-10-13 (8 h, team Harvest)' + tail,
    "Wendy Hernandez is on Gusto but has harvest hours at 23rd Street on 2026-10-16 (6.25 h, team Norma's Team)" + tail,
  ]);
});

test('sheet-row warning only counts Gusto harvest rows from the year-to-date start to the period end', () => {
  const rows = [
    sheetHv('r-nor', '2026-10-13', 'Slane'),
    gustoHv('r-nor', '2026-10-28', 'Imperial'),   // after the period: the script never reads it, so the page must not use it either
    sheetHv(null, '2026-10-14', 'Slane', { last: 'Ramirez', first: 'Felipe' }),
    gustoHv(null, '2025-12-19', 'Imperial', { last: 'Ramirez', first: 'Felipe' }),   // before the year-to-date start (2025-12-20)
  ];
  const out = LB.compute({ rows, roster: ROSTER, company: 'Slane', periodStart: '2026-10-10' });
  assert.equal(out.ytdStart, '2025-12-20');
  assert.equal(out.warnings.filter(w => /is on Gusto but has harvest hours/.test(w)).length, 0);
  // the same Gusto rows inside the window (the year-to-date start itself and the period end) do count
  const inside = [
    sheetHv('r-nor', '2026-10-13', 'Slane'),
    gustoHv('r-nor', '2026-10-23', 'Imperial'),
    sheetHv(null, '2026-10-14', 'Slane', { last: 'Ramirez', first: 'Felipe' }),
    gustoHv(null, '2025-12-20', 'Imperial', { last: 'Ramirez', first: 'Felipe' }),
  ];
  const w = LB.compute({ rows: inside, roster: ROSTER, company: 'Slane', periodStart: '2026-10-10' }).warnings
    .filter(x => /is on Gusto but has harvest hours/.test(x));
  assert.deepEqual(plain(w.map(x => x.split(' is on Gusto')[0])), ['Felipe Ramirez', 'Nora Diaz']);
});

// ---- other cases --------------------------------------------------------------
test('compute: a billed row with no pay (no clock times) bills no tax and says so', () => {
  const rows = [gustoHv('r-wen', '2026-10-21', 'Slane', { clock_in: null, clock_out: null, hours: 0, total: 0 })];
  const out = LB.compute({ rows, roster: ROSTER, company: 'Slane', periodStart: '2026-10-10' });
  assert.equal(out.people.length, 1);
  assert.equal(out.people[0].taxRate, 0);
  assert.equal(out.people[0].tax, 0);
  assert.match(out.warnings.join('\n'), /Wendy Hernandez has no Gusto wages on the board this pay period/);
});

test('compute: a mid-period start snaps to its pay period; repeated rows count once', () => {
  const r = gustoHv('r-wen', '2026-10-20', 'Slane', { hours: 8, total: 160 });
  const out = LB.compute({ rows: [r, r], roster: ROSTER, company: 'Slane', periodStart: '2026-10-15' });
  assert.equal(out.periodStart, '2026-10-10');
  assert.equal(out.periodEnd, '2026-10-23');
  assert.equal(out.totals.wages, 160);
  assert.equal(out.totals.hours, 8);
  assert.equal(out.people[0].tax, 21.68);                // 160 x 13.55%
  const w = out.warnings.join('\n');
  assert.match(w, /2026-10-15 is not the first day of a pay period/);
  assert.match(w, /Skipped 1 repeated row/);
  assert.doesNotMatch(w, /overtime/, 'the repeated row is not counted twice toward the day');
});

test('compute: only Slane and Imperial are billed; any other company or a bad start throws', () => {
  for (const co of ['Olympic', 'Filifera', 'Portal', 'slane', '', undefined, null, 'toString', '__proto__']) {
    assert.throws(() => LB.compute({ rows: ROWS, roster: ROSTER, company: co, periodStart: '2026-10-10' }),
      /company must be Slane or Imperial/, String(co));
  }
  assert.throws(() => LB.compute({ rows: [], roster: [], company: 'Slane', periodStart: 'soon' }), /periodStart/);
  assert.throws(() => LB.compute(), /periodStart/);
});
