// BA Field app (ba/index.html): the Payroll list (ba/docs/qbo-reimbursements.md, "Payroll list and the after-submit check",
// 2026-11-24). Runs the page's own PAYROLL MODEL block, with the QBO PLAN MODEL block and the payment helpers it uses,
// sliced out of the file into a vm; then the list's row and section words, and the page's wiring. Made-up people, amounts
// and ids only; nothing here reads or writes a database, QuickBooks or Gusto.
//   node --test tests/ba-payroll.test.mjs
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
vm.runInContext(between('/* ── PAYROLL MODEL ── */', '/* ── end PAYROLL MODEL ── */'), s);
const get = name => vm.runInContext(name, s);
const plain = x => JSON.parse(JSON.stringify(x));
const TODAY = '2026-11-24';

// ── made-up tables ──
const PD = o => ({ processed: false, late: false, paid: {}, ...o });
const PAYDAYS = [
  PD({ company: 'wtny', period_start: '2026-11-07', period_end: '2026-11-20', check_date: '2026-11-25', processed: true, payroll_uuid: 'pr-w-1125',
    paid: { 'g-ava': { total: 120.5, lines: [120.5] }, 'g-zed': { total: 15, lines: [15] } } }),
  PD({ company: 'filifera', period_start: '2026-11-07', period_end: '2026-11-20', check_date: '2026-11-25', processed: true, payroll_uuid: 'pr-f-1125' }),
  PD({ company: 'wafgus', period_start: '2026-11-07', period_end: '2026-11-20', check_date: '2026-11-25', payroll_uuid: 'pr-g-1125' }),
  PD({ company: 'wtny', period_start: '2026-11-21', period_end: '2026-12-04', check_date: '2026-12-09', payroll_uuid: 'pr-w-1209' }),
  PD({ company: 'filifera', period_start: '2026-11-21', period_end: '2026-12-04', check_date: '2026-12-09', payroll_uuid: 'pr-f-1209' }),
  PD({ company: 'wafgus', period_start: '2026-11-21', period_end: '2026-12-04', check_date: '2026-12-09', payroll_uuid: 'pr-g-1209' }),
  PD({ company: 'wtny', period_start: '2026-12-05', period_end: '2026-12-18', check_date: '2026-12-23', payroll_uuid: 'pr-w-1223' }),
  PD({ company: 'wtny', period_start: '2026-12-19', period_end: '2027-01-01', check_date: '2027-01-06', payroll_uuid: 'pr-w-0106' }),
];
const PER_A = { id: 'per-a', label: 'Nov 7 to Nov 20', start_date: '2026-11-07', end_date: '2026-11-20' };
const PER_B = { id: 'per-b', label: 'Nov 21 to Dec 4', start_date: '2026-11-21', end_date: '2026-12-04' };
const PEOPLE = [
  { profile_id: 'p-ava', company: 'wtny', gusto_uuid: 'g-ava' }, { profile_id: 'p-ben', company: 'wtny', gusto_uuid: 'g-ben' },
  { profile_id: 'p-cy', company: 'wtny', gusto_uuid: 'g-cy' }, { profile_id: 'p-dee', company: 'wtny', gusto_uuid: 'g-dee' },
  { profile_id: 'p-gus', company: 'wtny', gusto_uuid: 'g-gus' }, { profile_id: 'p-eli', company: 'filifera', gusto_uuid: 'g-eli' },
  { profile_id: 'p-fay', company: null, gusto_uuid: null },
];
const PROFILES = [
  { id: 'p-ava', full_name: 'Ava Stone', active: true }, { id: 'p-ben', full_name: 'Ben Cole', active: true },
  { id: 'p-cy', full_name: 'Cy Park', active: false }, { id: 'p-dee', full_name: 'Dee Lane', active: false },
  { id: 'p-gus', full_name: 'Gus Hale', active: true }, { id: 'p-eli', full_name: 'Eli Moss', active: true },
  { id: 'p-fay', full_name: 'Fay Wren', active: true }, { id: 'p-kim', full_name: 'Kim Roe', active: true },
];
const GUSTO = [{ company: 'wtny', gusto_uuid: 'g-zed', name: 'Zed Quill' }];
const T = [
  { id: 't1', ba_id: 'p-ava', period_id: 'per-b', amount: 30.1, status: 'approved' },
  { id: 't2', ba_id: 'p-ava', period_id: 'per-b', amount: '0.20', status: 'approved' },
  { id: 't3', ba_id: 'p-ben', period_id: 'per-b', amount: 40, status: 'submitted' },
  { id: 't4', ba_id: 'p-ava', period_id: 'per-a', amount: 120.5, status: 'approved' },
  { id: 't5', ba_id: 'p-ava', period_id: 'per-b', amount: 7, status: 'rejected' },
];
const E = [
  { id: 'e1', ba_id: 'p-ava', period_id: 'per-b', amount: 10, status: 'approved', payment: 'reimbursement' },
  { id: 'e2', ba_id: 'p-ava', period_id: 'per-b', amount: 99, status: 'approved', payment: 'company' },
  { id: 'e3', ba_id: 'p-ava', period_id: 'per-b', amount: 50, status: 'approved', payment: 'company_bank' },
  { id: 'e4', ba_id: 'p-ava', period_id: 'per-b', amount: 8, status: 'approved', payment: 'reimbursement', source: 'books' },
  { id: 'e5', ba_id: 'p-ava', period_id: 'per-b', amount: 5.55, status: 'submitted', payment: 'reimbursement' },
  { id: 'e6', ba_id: 'p-ava', period_id: 'per-b', amount: 1.5, status: 'approved', payment: null },
  { id: 'e7', ba_id: 'p-eli', period_id: 'per-b', amount: 20, status: 'draft', payment: 'reimbursement' },
  { id: 'e8', ba_id: 'p-fay', period_id: 'per-b', amount: 33, status: 'approved', payment: 'reimbursement' },
];
const SUBS = [{ ba_id: 'p-ava', period_id: 'per-b', status: 'approved' }, { ba_id: 'p-ben', period_id: 'per-b', status: 'submitted' },
  { ba_id: 'p-eli', period_id: 'per-b', status: 'draft' }, { ba_id: 'p-ava', period_id: 'per-a', status: 'approved' }];
const A = o => ({ company: 'wtny', check_date: '2026-12-09', reason: 'A made-up reason', created_at: '2026-11-24T10:00:00Z', cancelled_at: null,
  carried_from: null, carry_group: null, ...o });
const ADJ = [
  A({ id: 'a1', profile_id: 'p-ava', cents: -5000, reason: 'Paid twice on an earlier payday' }),
  A({ id: 'a2', profile_id: 'p-ben', cents: 2500, created_at: '2026-11-24T10:01:00Z' }),
  A({ id: 'a3', profile_id: 'p-dee', cents: -1000 }),
  A({ id: 'a4', profile_id: 'p-ava', cents: -999, cancelled_at: '2026-11-24T11:00:00Z' }),   // cancelled: never counts
  A({ id: 'a5', profile_id: 'p-ava', cents: 700, check_date: '2026-12-23' }),                // another payday
  A({ id: 'a6', profile_id: 'p-ava', cents: 300, company: 'filifera' }),                      // another company
];
const company = (o = {}) => get('payrollCompany')({ company: 'wtny', day: '2026-12-09', paydays: PAYDAYS, checks: [], people: PEOPLE, profiles: PROFILES,
  periods: [PER_A, PER_B], T, E, subs: SUBS, adjustments: ADJ, gustoPeople: GUSTO, today: TODAY, ...o });

test('dates in words: check dates, a period on a row, a period in full, the deadline in Pacific time', () => {
  const day = get('payrollDay'), range = get('payrollRange'), full = get('payrollRangeFull');
  assert.equal(day('2026-12-09', TODAY), 'Wed Dec 9');
  assert.equal(day('2027-01-06', TODAY), 'Wed Jan 6, 2027');                  // another year says so
  assert.equal(day('2026-10-14', TODAY), 'Wed Oct 14');
  assert.equal(day('nope', TODAY), '');
  assert.equal(range('2026-11-21', '2026-12-04', TODAY), 'Nov 21 to Dec 4');
  assert.equal(range('2026-12-19', '2027-01-01', TODAY), 'Dec 19 to Jan 1, 2027');
  assert.equal(full('2026-11-21', '2026-12-04'), 'Sat Nov 21 to Fri Dec 4, 2026');
  assert.equal(full('2026-12-19', '2027-01-01'), 'Sat Dec 19, 2026 to Fri Jan 1, 2027');
  const pac = get('payrollPacific');
  assert.equal(pac('2026-12-04T00:00:00Z'), 'Thu Dec 3, 4:00 PM Pacific');
  assert.equal(pac('2026-07-01T17:30:00Z'), 'Wed Jul 1, 10:30 AM Pacific');    // daylight time
  assert.equal(pac(null), ''); assert.equal(pac('x'), '');
  assert.equal(get('payrollNames')(['A']), 'A');
  assert.equal(get('payrollNames')(['A', 'B', 'C']), 'A, B and C');
  assert.equal(get('payrollSigned')(2500), '+$25.00');
  assert.equal(get('payrollSigned')(-123456), '-$1,234.56');
  assert.equal(get('qboUsd')(0), '$0.00');
});

test('the check dates: one per day across the companies, saying what each pays and whether Gusto ran it, by company when they differ', () => {
  const ch = plain(get('payrollChoices')({ paydays: PAYDAYS, checks: [], today: TODAY }));
  assert.deepEqual(ch.map(c => c.day), ['2026-11-25', '2026-12-09', '2026-12-23', '2027-01-06']);
  assert.deepEqual(ch.map(c => c.label), [
    'Wed Nov 25 · pays Nov 7 to Nov 20 · run in Gusto for Wizard Trees NY and Filifera LLC, not run yet for Waf & Gus LLC',
    'Wed Dec 9 · pays Nov 21 to Dec 4 · not run yet',
    'Wed Dec 23 · pays Dec 5 to Dec 18 · not run yet',
    'Wed Jan 6, 2027 · pays Dec 19 to Jan 1, 2027 · not run yet',
  ]);
  assert.deepEqual(ch[0].cos.map(c => [c.co, c.run, c.open]), [['wtny', true, false], ['filifera', true, false], ['wafgus', false, true]]);
  // the Mac's after-submit check counts as run before the hourly copy says processed; an off-cycle one doesn't
  const checks = [{ company: 'wafgus', payroll_uuid: 'pr-g-1125', check_date: '2026-11-25', off_cycle: false, status: 'ok', lines: [] },
    { company: 'filifera', payroll_uuid: 'oc-1', check_date: '2026-11-27', off_cycle: true, status: 'ok', lines: [] }];
  const ch2 = plain(get('payrollChoices')({ paydays: PAYDAYS, checks, today: TODAY }));
  assert.equal(ch2[0].label, 'Wed Nov 25 · pays Nov 7 to Nov 20 · run in Gusto');
  // off_cycle rows are off-cycle payrolls and regular ones on another schedule (a crew payroll): never called off-cycle
  assert.equal(ch2[1].label, 'Fri Nov 27 · another payroll (Filifera LLC)');
  const crew = plain(get('payrollChoices')({ paydays: PAYDAYS, checks: [{ ...checks[1], check_date: '2026-11-25' }], today: TODAY }));
  assert.equal(crew[0].label, 'Wed Nov 25 · pays Nov 7 to Nov 20 · run in Gusto for Wizard Trees NY and Filifera LLC, not run yet for Waf & Gus LLC · and another payroll');
  // a check that found something says so, whichever payroll of the day it was
  const bad = plain(get('payrollChoices')({ paydays: PAYDAYS, checks: [{ ...checks[0], status: 'problems' }], today: TODAY }));
  assert.equal(bad[0].label, 'Wed Nov 25 · pays Nov 7 to Nov 20 · run in Gusto · the check found problems');
  const err = plain(get('payrollChoices')({ paydays: PAYDAYS, checks: [{ ...checks[1], status: 'error' }], today: TODAY }));
  assert.equal(err[1].label, 'Fri Nov 27 · another payroll (Filifera LLC) · the Mac couldn’t check it');
  // a check whose payroll Gusto moved to another day stays on its payday (no day of its own)
  const moved = plain(get('payrollChoices')({ paydays: PAYDAYS, checks: [{ company: 'wtny', payroll_uuid: 'pr-w-1209', check_date: '2026-12-10', off_cycle: false, status: 'ok' }], today: TODAY }));
  assert.ok(!moved.some(c => c.day === '2026-12-10'));
  assert.equal(moved.find(c => c.day === '2026-12-09').label, 'Wed Dec 9 · pays Nov 21 to Dec 4 · run in Gusto for Wizard Trees NY, not run yet for Filifera LLC and Waf & Gus LLC');
  // companies paying different periods on one day are named
  const odd = PAYDAYS.map(r => r.company === 'wafgus' && r.check_date === '2026-12-09' ? { ...r, period_start: '2026-11-14', period_end: '2026-11-27' } : r);
  assert.equal(plain(get('payrollChoices')({ paydays: odd, today: TODAY }))[1].label,
    'Wed Dec 9 · pays Nov 21 to Dec 4 (Wizard Trees NY and Filifera LLC); Nov 14 to Nov 27 (Waf & Gus LLC) · not run yet');
  assert.deepEqual(plain(get('payrollChoices')({ paydays: [], checks: [], today: TODAY })), []);
});

test('the list opens on the first check date on or after today that some company hasn\'t run, else the latest', () => {
  const ch = (pd, today = TODAY) => get('payrollDefaultDay')(get('payrollChoices')({ paydays: pd, today }), today);
  assert.equal(ch(PAYDAYS), '2026-11-25');                                                   // Waf & Gus hasn't run 11/25
  const ran = PAYDAYS.map(r => r.check_date === '2026-11-25' ? { ...r, processed: true } : r);
  assert.equal(ch(ran), '2026-12-09');
  assert.equal(ch(ran, '2026-12-10'), '2026-12-23');
  const all = ran.map(r => ({ ...r, processed: true }));
  assert.equal(ch(all), '2027-01-06');                                                       // everything ran: the latest
  assert.equal(ch(all, '2027-03-01'), '2027-01-06');
  assert.equal(get('payrollDefaultDay')([], TODAY), null);
  // right after a submit: a payroll whose check found problems, while it can still be cancelled, comes first (the soonest
  // deadline); once its deadline passed, the usual rule
  const now = Date.parse('2026-12-08T18:00:00Z');
  const chk = (company, payroll_uuid, status, deadline) => ({ company, payroll_uuid, check_date: '2026-12-09', off_cycle: false, status, deadline, lines: [] });
  const sub = ran.map(r => r.check_date === '2026-12-09' ? { ...r, processed: true } : r);
  const choices = checks => get('payrollChoices')({ paydays: sub, checks, today: '2026-12-08' });
  assert.equal(get('payrollDefaultDay')(choices([]), '2026-12-08', now), '2026-12-23');
  assert.equal(get('payrollDefaultDay')(choices([chk('wtny', 'pr-w-1209', 'problems', '2026-12-09T00:00:00Z')]), '2026-12-08', now), '2026-12-09');
  assert.equal(get('payrollDefaultDay')(choices([chk('wtny', 'pr-w-1209', 'error', '2026-12-09T00:00:00Z')]), '2026-12-08', now), '2026-12-09');
  assert.equal(get('payrollDefaultDay')(choices([chk('wtny', 'pr-w-1209', 'problems', '2026-12-08T17:00:00Z')]), '2026-12-08', now), '2026-12-23');   // too late to cancel
  assert.equal(get('payrollDefaultDay')(choices([chk('wtny', 'pr-w-1209', 'ok', '2026-12-09T00:00:00Z')]), '2026-12-08', now), '2026-12-23');
  assert.equal(get('payrollDefaultDay')(choices([chk('wtny', 'pr-w-1209', 'problems', '2026-12-09T00:00:00Z')]), '2026-12-08'), '2026-12-23');   // no clock given
});

test('the approved claim: approved trips and approved expenses the person paid; never company-paid or the books\'; waiting shown apart', () => {
  const c = get('payrollClaim');
  const mine = x => x.ba_id === 'p-ava' && x.period_id === 'per-b';
  assert.deepEqual(plain(c(T.filter(mine), E.filter(mine))), { approved: 3010 + 20 + 1000 + 150, waiting: 555 });
  assert.deepEqual(plain(c([{ amount: 0.1, status: 'approved' }, { amount: 0.2, status: 'approved' }], [])), { approved: 30, waiting: 0 });
  assert.deepEqual(plain(c([], [{ amount: 12, status: 'draft', payment: 'company' }, { amount: 4, status: 'draft' }])), { approved: 0, waiting: 400 });
  assert.deepEqual(plain(c(null, null)), { approved: 0, waiting: 0 });
  const st = get('payrollClaimState');
  assert.equal(st({ status: 'approved' }), 'approved'); assert.equal(st({ status: 'submitted' }), 'submitted');
  assert.equal(st({ status: 'rejected' }), 'rejected'); assert.equal(st({ status: 'draft' }), 'none'); assert.equal(st(null), 'none');
  assert.deepEqual(plain(get('PAYROLL_CLAIM')), { approved: 'Approved', submitted: 'Waiting for approval', rejected: 'Sent back', none: 'Not submitted' });
  const note = get('payrollClaimNote');
  assert.equal(note('approved', 555), '$5.55 more not approved yet, not counted');
  assert.equal(note('submitted', 4000), '$40.00 submitted, not counted');
  assert.equal(note('none', 2000), '$20.00 logged so far, not counted');
  assert.equal(note('approved', 0), '');
});

test('one company on one check date: approved + adjustments = Type in Gusto, for everyone linked who is active or has something', () => {
  const c = plain(company());
  assert.equal(c.name, 'Wizard Trees NY');
  assert.deepEqual([c.regular, c.run, c.open, c.start, c.end, c.src, c.next], [true, false, true, '2026-11-21', '2026-12-04', null, '2026-12-23']);
  assert.deepEqual(c.period, { id: 'per-b', label: 'Nov 21 to Dec 4' });
  // Cy is inactive with nothing: left out; Dee is inactive with an adjustment: in; Gus is active with nothing: a quiet row, last
  assert.deepEqual(c.rows.map(r => [r.name, r.state, r.approved, r.adjust, r.raw, r.type, r.short, r.quiet]), [
    ['Ava Stone', 'approved', 4180, -5000, -820, 0, 820, false],
    ['Ben Cole', 'submitted', 0, 2500, 2500, 2500, 0, false],
    ['Dee Lane', 'none', 0, -1000, -1000, 0, 1000, false],
    ['Gus Hale', 'none', 0, 0, 0, 0, 0, true],
  ]);
  const ava = c.rows[0];
  assert.deepEqual([ava.words, ava.note, ava.start, ava.end, ava.waiting, ava.settled], ['Approved', '$5.55 more not approved yet, not counted', '2026-11-21', '2026-12-04', 555, false]);
  assert.deepEqual(ava.adj.map(a => [a.id, a.cents, a.reason, a.canCancel]), [['a1', -5000, 'Paid twice on an earlier payday', true]]);   // not a4, a5 or a6
  assert.deepEqual(ava.carry, { short: 820, from: 'a1', cents: -820, to: '2026-12-23', whole: true });
  assert.equal(ava.paid, null);
  assert.equal(c.rows[1].note, '$40.00 submitted, not counted');
  assert.equal(c.rows[2].active, false);
  assert.deepEqual(c.totals, { approved: 4180, adjust: -3500, type: 2500, paid: null, outside: 0, mismatched: 0 });
  assert.deepEqual(c.outside, []);
  // Filifera that day: Eli's draft is waiting, nothing approved
  const f = plain(company({ company: 'filifera' }));
  assert.deepEqual(f.rows.map(r => [r.name, r.words, r.note, r.type]), [['Eli Moss', 'Not submitted', '$20.00 logged so far, not counted', 0]]);
  // no payday that day: null
  assert.equal(company({ company: 'wafgus', day: '2026-12-23' }), null);
  // a payday whose period the app doesn't have yet: no claims, adjustments still count
  const dec = plain(company({ day: '2026-12-23' }));
  assert.equal(dec.period, null);
  assert.deepEqual(dec.rows.filter(r => !r.quiet).map(r => [r.name, r.type]), [['Ava Stone', 700]]);
});

test('once Gusto ran it: what it paid from the Mac\'s check when there is one, else the hourly copy; payments outside the app listed', () => {
  // the hourly copy only (processed, no check row yet)
  const c = plain(company({ day: '2026-11-25' }));
  assert.deepEqual([c.run, c.open, c.src], [true, false, 'payday']);
  const ava = c.rows.find(r => r.name === 'Ava Stone');
  assert.deepEqual([ava.approved, ava.type, ava.paid.cents, ava.same, ava.carry], [12050, 12050, 12050, true, null]);
  assert.deepEqual(c.outside, [{ name: 'Zed Quill', cents: 1500, text: '', tone: '' }]);
  assert.equal(c.totals.paid, 12050);
  assert.equal(c.totals.outside, 1500);
  const w = get('payrollPaidWords');
  assert.deepEqual(plain(w(ava)), { ok: true, main: 'Gusto paid $120.50', note: '' });
  // the Mac's check of that payroll wins: its line for Ava says it is off, and Zed's line is outside
  const check = { company: 'wtny', payroll_uuid: 'pr-w-1125', check_date: '2026-11-25', off_cycle: false, status: 'problems', summary: '1 reimbursement is off.',
    checked_at: '2026-11-24T21:00:00Z', processed_at: '2026-11-24T20:50:00Z', deadline: '2026-11-25T00:00:00Z',
    lines: [{ gusto_uuid: 'g-ava', profile_id: 'p-ava', name: 'Ava Stone', paid_cents: 15000, expected_cents: 12050, kind: 'mismatch', tone: 'warn', text: 'Paid $150.00; the approved claim is $120.50.' },
      { gusto_uuid: 'g-zed', profile_id: null, name: 'Zed Quill', paid_cents: 1500, kind: 'outside', tone: 'info', text: 'Not in the BA app.' }] };
  const k = plain(company({ day: '2026-11-25', checks: [check] }));
  const a2 = k.rows.find(r => r.name === 'Ava Stone');
  assert.deepEqual([k.src, a2.paid.cents, a2.same], ['check', 15000, false]);
  assert.deepEqual(plain(w(a2)), { ok: false, main: 'Gusto paid $150.00', note: 'Paid $150.00; the approved claim is $120.50.' });
  assert.deepEqual(k.outside, [{ name: 'Zed Quill', cents: 1500, text: 'Not in the BA app.', tone: 'info' }]);
  assert.deepEqual(k.check, { status: 'problems', summary: '1 reimbursement is off.', checkedAt: '2026-11-24T21:00:00Z', processedAt: '2026-11-24T20:50:00Z', deadline: '2026-11-25T00:00:00Z' });
  assert.equal(k.totals.mismatched, 1);
  // the app changed since the Mac looked: its words, and what the app says now
  const stale = { ...check, lines: [{ ...check.lines[0], expected_cents: 11000 }] };
  assert.equal(w(company({ day: '2026-11-25', checks: [stale] }).rows.find(r => r.name === 'Ava Stone')).note,
    'Paid $150.00; the approved claim is $120.50. The app now says $120.50.');
  // no words from the Mac: the difference; and nothing paid at all
  assert.equal(w({ type: 12050, paid: { cents: 15000, line: null } }).note, 'That’s $29.50 more than Type in Gusto.');
  assert.deepEqual(plain(w({ type: 2500, paid: { cents: 0, line: null } })), { ok: false, main: 'Gusto paid no reimbursement', note: 'That’s $25.00 less than Type in Gusto.' });
  // a matching line with the Mac's note (info) keeps the note, quietly
  assert.deepEqual(plain(w({ type: 100, paid: { cents: 100, line: { tone: 'info', text: 'With an adjustment.' } } })), { ok: true, main: 'Gusto paid $1.00', note: 'With an adjustment.' });
  // the Mac couldn't read it: the hourly copy if processed, else nothing read yet
  assert.equal(company({ day: '2026-11-25', checks: [{ ...check, status: 'error', lines: [] }] }).src, 'payday');
  const unread = plain(company({ day: '2026-12-09', checks: [{ company: 'wtny', payroll_uuid: 'pr-w-1209', check_date: '2026-12-09', off_cycle: false, status: 'error', lines: [] }] }));
  assert.deepEqual([unread.run, unread.open, unread.src, unread.totals.paid], [true, false, null, null]);
  assert.ok(unread.rows.every(r => r.paid === null && r.carry === null));   // ran: nothing to carry from here
  // an off-cycle payroll that day is listed with what it paid
  const off = { company: 'wtny', payroll_uuid: 'oc-2', check_date: '2026-12-09', off_cycle: true, status: 'problems', summary: 'An off-cycle payroll paid a reimbursement.',
    lines: [{ gusto_uuid: 'g-ben', profile_id: 'p-ben', name: 'Ben Cole', paid_cents: 4200, kind: 'offcycle', tone: 'warn', text: 'Off-cycle reimbursement.' }, { name: 'Nobody', paid_cents: 0 }] };
  const o = plain(company({ checks: [off] }));
  assert.equal(o.open, true);                                                    // an off-cycle check doesn't close the payday
  assert.deepEqual(o.offs.map(x => [x.status, x.lines.map(l => [l.name, l.cents])]), [['problems', [['Ben Cole', 4200]]]]);
});

test('carry: below zero, the shortfall goes to the next payday Gusto hasn\'t run, from what an adjustment still holds there', () => {
  const carry = get('payrollCarry'), left = get('payrollAdjLeft');
  const a1 = A({ id: 'a1', profile_id: 'p-ava', cents: -5000 });
  // an earlier carry of 20.00 off 12/9 (its two halves): a1 still holds 30.00 there
  const c1 = A({ id: 'c1', profile_id: 'p-ava', cents: 2000, carried_from: 'a1', carry_group: 'g1', created_at: '2026-11-24T12:00:00Z' });
  const c2 = A({ id: 'c2', profile_id: 'p-ava', cents: -2000, carried_from: 'a1', carry_group: 'g1', check_date: '2026-12-23', created_at: '2026-11-24T12:00:00Z' });
  const all = [a1, c1, c2];
  assert.equal(left(a1, all), -3000);
  assert.equal(left(c2, all), -2000);
  assert.equal(left(a1, [a1, { ...c1, cancelled_at: '2026-11-24T13:00:00Z' }]), -5000);   // a cancelled carry gives it back
  // raw = 0 approved + (-50.00 + 20.00) on 12/9: all of it fits in a1; the half that came back (c1) is never carried
  assert.deepEqual(plain(carry({ raw: -3000, adjustments: [a1, c1], all, next: '2026-12-23' })), { short: 3000, from: 'a1', cents: -3000, to: '2026-12-23', whole: true });
  assert.deepEqual(plain(carry({ raw: -1000, adjustments: [a1, c1], all, next: '2026-12-23' })), { short: 1000, from: 'a1', cents: -1000, to: '2026-12-23', whole: true });
  // two that each hold less than the shortfall: the larger first, in steps
  const b1 = A({ id: 'b1', profile_id: 'p-ava', cents: -2000, created_at: '2026-11-24T09:00:00Z' }), b2 = A({ id: 'b2', profile_id: 'p-ava', cents: -1500, created_at: '2026-11-24T08:00:00Z' });
  assert.deepEqual(plain(carry({ raw: -3500, adjustments: [b1, b2], all: [b1, b2], next: '2026-12-23' })), { short: 3500, from: 'b1', cents: -2000, to: '2026-12-23', whole: false });
  // both hold enough: the oldest
  assert.equal(carry({ raw: -1000, adjustments: [b1, b2], all: [b1, b2], next: '2026-12-23' }).from, 'b2');
  // nothing to carry (the claim itself is below zero), or nowhere to carry it
  assert.deepEqual(plain(carry({ raw: -500, adjustments: [], all: [], next: '2026-12-23' })), { short: 500, why: 'claim' });
  assert.deepEqual(plain(carry({ raw: -500, adjustments: [A({ id: 'p', cents: 300 })], all: [], next: '2026-12-23' })), { short: 500, why: 'claim' });
  assert.deepEqual(plain(carry({ raw: -500, adjustments: [b1], all: [b1], next: null })), { short: 500, why: 'later' });
  assert.equal(carry({ raw: 0, adjustments: [b1], all: [b1], next: '2026-12-23' }), null);
  // the next payday Gusto hasn't run: a processed one, or one the Mac checked, is skipped
  const next = get('payrollNextOpen');
  assert.equal(next('wtny', '2026-12-09', PAYDAYS, []), '2026-12-23');
  assert.equal(next('wtny', '2026-12-09', PAYDAYS.map(r => r.check_date === '2026-12-23' ? { ...r, processed: true } : r), []), '2027-01-06');
  assert.equal(next('wtny', '2026-12-09', PAYDAYS, [{ company: 'wtny', payroll_uuid: 'pr-w-1223', check_date: '2026-12-23', off_cycle: false, status: 'ok' }]), '2027-01-06');
  assert.equal(next('wafgus', '2026-12-09', PAYDAYS, []), null);
  assert.deepEqual(plain(get('payrollOpenDays')('wtny', PAYDAYS, [])), ['2026-12-09', '2026-12-23', '2027-01-06']);
  // in the list: the half a carry left on 12/9 counts there, the other half on 12/23, where it can be carried on again
  const ava = o => plain(company({ adjustments: [a1, c1, c2, A({ id: 'a5', profile_id: 'p-ava', cents: 700, check_date: '2026-12-23' })], ...o }).rows.find(x => x.name === 'Ava Stone'));
  assert.deepEqual([ava().raw, ava().type, ava().short, ava().carry], [4180 - 5000 + 2000, 1180, 0, null]);
  const dec = ava({ day: '2026-12-23' });
  assert.deepEqual([dec.raw, dec.type, dec.short], [700 - 2000, 0, 1300]);
  assert.deepEqual(dec.carry, { short: 1300, from: 'c2', cents: -1300, to: '2027-01-06', whole: true });
  // once a payday ran, nothing is carried from it
  assert.equal(ava({ day: '2026-12-23', paydays: PAYDAYS.map(r => r.check_date === '2026-12-23' ? { ...r, processed: true } : r) }).carry, null);
});

test('cancel takes the other half of a carry and anything carried on, and only while every payday it touches is open', () => {
  const fam = (all, id) => plain(get('payrollCancelFamily')(all, id)).map(a => a.id).sort();
  const a1 = A({ id: 'a1', profile_id: 'p-ava', cents: -5000 });
  const c1 = A({ id: 'c1', profile_id: 'p-ava', cents: 2000, carried_from: 'a1', carry_group: 'g1' });
  const c2 = A({ id: 'c2', profile_id: 'p-ava', cents: -2000, carried_from: 'a1', carry_group: 'g1', check_date: '2026-12-23' });
  const d1 = A({ id: 'd1', profile_id: 'p-ava', cents: 2000, carried_from: 'c2', carry_group: 'g2', check_date: '2026-12-23' });
  const d2 = A({ id: 'd2', profile_id: 'p-ava', cents: -2000, carried_from: 'c2', carry_group: 'g2', check_date: '2027-01-06' });
  const x = A({ id: 'x', profile_id: 'p-ava', cents: 100 });
  const all = [a1, c1, c2, d1, d2, x, A({ id: 'gone', carried_from: 'a1', cancelled_at: '2026-11-24T00:00:00Z', cents: 1 })];
  assert.deepEqual(fam(all, 'a1'), ['a1', 'c1', 'c2', 'd1', 'd2']);
  assert.deepEqual(fam(all, 'c1'), ['c1', 'c2', 'd1', 'd2']);
  assert.deepEqual(fam(all, 'd1'), ['d1', 'd2']);
  assert.deepEqual(fam(all, 'x'), ['x']);
  assert.deepEqual(fam(all, 'gone'), []);
  // in the list: a1 can be cancelled while 12/9, 12/23 and 1/6 are all open; not once 1/6 ran
  const row = adj => company({ adjustments: adj }).rows.find(r => r.name === 'Ava Stone');
  assert.equal(row(all).adj.find(a => a.id === 'a1').canCancel, true);
  assert.equal(row(all).adj.find(a => a.id === 'a1').family.length, 5);
  const ran = PAYDAYS.map(r => r.check_date === '2027-01-06' ? { ...r, processed: true } : r);
  assert.equal(company({ adjustments: all, paydays: ran }).rows.find(r => r.name === 'Ava Stone').adj.find(a => a.id === 'a1').canCancel, false);
  assert.equal(company({ adjustments: all, paydays: ran }).rows.find(r => r.name === 'Ava Stone').adj.find(a => a.id === 'x').canCancel, true);
});

test('a payday Gusto moved: its list keeps the adjustments added for the old day, which the app can\'t cancel or carry', () => {
  // made-up: the WTNY payroll for Nov 21 to Dec 4 missed its deadline, and the booking worker moved its row from 12/9 to 12/11
  const MOVED = PAYDAYS.map(r => r.payroll_uuid === 'pr-w-1209' ? { ...r, check_date: '2026-12-11', late: true } : r);
  const ch = plain(get('payrollChoices')({ paydays: MOVED, today: TODAY }));
  assert.deepEqual(ch.filter(c => ['2026-12-09', '2026-12-11'].includes(c.day)).map(c => [c.day, c.cos.map(x => x.co)]),
    [['2026-12-09', ['filifera', 'wafgus']], ['2026-12-11', ['wtny']]]);
  assert.equal(company({ paydays: MOVED }), null);                                // nothing for WTNY on 12/9 any more
  const c = plain(company({ paydays: MOVED, day: '2026-12-11' }));
  assert.deepEqual(c.rows.filter(r => !r.quiet).map(r => [r.name, r.adjust, r.type, r.short]),
    [['Ava Stone', -5000, 0, 820], ['Ben Cole', 2500, 2500, 0], ['Dee Lane', -1000, 0, 1000]]);   // the 12/9 adjustments still count
  const ava = c.rows[0];
  assert.deepEqual(ava.adj.map(a => [a.id, a.day, a.moved, a.canCancel, a.lock]), [['a1', '2026-12-09', true, false, 'moved']]);
  assert.deepEqual(ava.carry, { short: 820, why: 'moved' });                          // the database can't carry from a day with no payday
  assert.equal(c.open, true);                                                         // new adjustments can go on 12/11
  assert.deepEqual(plain(get('payrollOpenDays')('wtny', MOVED, [])), ['2026-12-11', '2026-12-23', '2027-01-06']);
  // the words on the row
  const h = page.payrollRowHtml(company({ paydays: MOVED, day: '2026-12-11' }), company({ paydays: MOVED, day: '2026-12-11' }).rows[0], TODAY);
  assert.ok(h.includes('Added for Wed Dec 9, before Gusto moved this payday. It still counts here.'));
  assert.ok(h.includes('The app can’t cancel it, since its payday moved.'));
  assert.ok(!h.includes('data-paycancel') && !h.includes('data-paycarry'));
  assert.ok(h.includes('Its adjustments were added before Gusto moved this payday, so the app can’t carry them.'));
  // nothing is left off every list (but a6: Ava isn't linked to Filifera)
  assert.deepEqual(plain(get('payrollStranded')({ adjustments: ADJ, people: PEOPLE, profiles: PROFILES, paydays: MOVED, checks: [] })).map(x => [x.id, x.why]), [['a6', 'link']]);
  // a 12/9 Wizard Trees NY section and the Mac's check agree: the adjustments belong to the payroll that pays the period
  const run = get('payrollRunOn')('wtny', '2026-12-11', MOVED, []);
  assert.deepEqual([run.period_start, run.check_date, run.planned], ['2026-11-21', '2026-12-11', '2026-12-11']);
  assert.equal(get('payrollDbOpen')('wtny', '2026-12-09', MOVED, []), false);
  assert.equal(get('payrollDbOpen')('wtny', '2026-12-11', MOVED, []), true);
  assert.equal(get('payrollDbOpen')('wtny', '2026-12-11', MOVED, [{ company: 'wtny', check_date: '2026-12-11', off_cycle: false }]), false);
  assert.equal(get('payrollDbOpen')('wtny', '2026-12-11', MOVED, [{ company: 'wtny', check_date: '2026-12-11', off_cycle: true }]), true);
});

test('adjustments no list shows are listed apart: no payday takes their day, or the person isn\'t linked to that company', () => {
  const adj = [...ADJ, A({ id: 'z1', profile_id: 'p-ava', cents: -700, check_date: '2027-02-03' }),   // after the last WTNY payday read
    A({ id: 'z2', profile_id: 'p-eli', cents: 400 }),                                                  // Eli is linked to Filifera
    A({ id: 'z3', profile_id: 'p-ava', cents: 100, check_date: '2026-10-28' })];                       // before the oldest payday read
  const s = plain(get('payrollStranded')({ adjustments: adj, people: PEOPLE, profiles: PROFILES, paydays: PAYDAYS, checks: [] }));
  assert.deepEqual(s.map(x => [x.id, x.name, x.company, x.day, x.cents, x.why, x.canCancel]), [
    ['a6', 'Ava Stone', 'filifera', '2026-12-09', 300, 'link', true],                                 // Ava is linked to WTNY
    ['z2', 'Eli Moss', 'wtny', '2026-12-09', 400, 'link', true],
    ['z1', 'Ava Stone', 'wtny', '2027-02-03', -700, 'day', false],
  ]);
  // Eli's adjustment is on no WTNY row either
  assert.ok(!plain(company({ adjustments: adj })).rows.some(r => r.adj.some(a => a.id === 'z2')));
  const t = textOf(page.payrollStrandedHtml(get('payrollStranded')({ adjustments: adj, people: PEOPLE, profiles: PROFILES, paydays: PAYDAYS, checks: [] }), TODAY));
  assert.ok(t.startsWith('Adjustments not on any list ⚠ These adjustments aren’t in any payday’s Type in Gusto below.'), t);
  assert.ok(t.includes('Eli Moss · Wizard Trees NY · added for Wed Dec 9 +$4.00 A made-up reason Eli Moss isn’t linked to Wizard Trees NY in Gusto any more, so its list doesn’t show them. Cancel'));
  assert.ok(t.includes('Ava Stone · Wizard Trees NY · added for Wed Feb 3, 2027 -$7.00 A made-up reason No payday the app has from Gusto takes Wed Feb 3, 2027 (Gusto may have moved it).'));
});

test('a claim counts once it is approved, as the Mac\'s check counts it; approved items under a claim that isn\'t are shown apart', () => {
  // made-up: Ben's claim was approved, then one $50.00 trip went back to submitted (Undo approval), so the claim is submitted
  const T2 = [...T, { id: 't9', ba_id: 'p-ben', period_id: 'per-b', amount: 100, status: 'approved' }];
  const c = plain(company({ T: T2, adjustments: [] }));
  const ben = c.rows.find(r => r.name === 'Ben Cole');
  assert.deepEqual([ben.state, ben.approved, ben.counted, ben.held, ben.waiting, ben.raw, ben.type, ben.settled], ['submitted', 10000, 0, 10000, 4000, 0, 0, false]);
  assert.equal(c.totals.approved, 4180);                                              // Ava's only
  const h = textOf(page.payrollRowHtml(company({ T: T2, adjustments: [] }), company({ T: T2, adjustments: [] }).rows.find(r => r.name === 'Ben Cole'), TODAY));
  assert.ok(h.includes('Approved $0.00 $100.00 of items approved, not counted until the claim is approved. Type in Gusto $0.00'), h);
  // the same for a claim sent back, or never submitted
  for (const status of ['rejected', 'draft']) {
    const r = plain(company({ T: T2, adjustments: [], subs: SUBS.map(x => x.ba_id === 'p-ben' ? { ...x, status } : x) })).rows.find(x => x.name === 'Ben Cole');
    assert.deepEqual([r.counted, r.held, r.type], [0, 10000, 0], status);
  }
  // approved: it counts
  const ok = plain(company({ T: T2, adjustments: [], subs: SUBS.map(x => x.ba_id === 'p-ben' ? { ...x, status: 'approved' } : x) })).rows.find(x => x.name === 'Ben Cole');
  assert.deepEqual([ok.counted, ok.held, ok.type], [10000, 0, 10000]);
  // once the payroll ran: the Mac's line expects 0 (claim not approved), so paying $40.00 is its warning, and $0.00 matches
  const ran = PAYDAYS.map(r => r.payroll_uuid === 'pr-w-1209' ? { ...r, processed: true } : r);
  const line = paid => ({ company: 'wtny', payroll_uuid: 'pr-w-1209', check_date: '2026-12-09', off_cycle: false, status: paid ? 'problems' : 'ok', summary: '',
    lines: paid ? [{ gusto_uuid: 'g-ben', profile_id: 'p-ben', name: 'Ben Cole', claim_status: 'submitted', approved_cents: null, adjust_cents: 0, expected_cents: 0, paid_cents: paid,
      kind: 'unapproved', tone: 'warn', text: 'Paid $40.00, but their claim for Nov 21 to Dec 4 isn’t approved yet.' }] : [] });
  const b40 = plain(company({ T: T2, adjustments: [], paydays: ran, checks: [line(4000)] })).rows.find(x => x.name === 'Ben Cole');
  assert.deepEqual([b40.same, b40.pw.note], [false, 'Paid $40.00, but their claim for Nov 21 to Dec 4 isn’t approved yet.']);
  const b0 = plain(company({ T: T2, adjustments: [], paydays: ran, checks: [line(0)] })).rows.find(x => x.name === 'Ben Cole');
  assert.deepEqual([b0.same, b0.pw.main], [true, 'Gusto paid no reimbursement']);
});

test('a row\'s check mark follows the Mac\'s verdict while it expected what the app says, and the header counts only its warnings', () => {
  const ran = PAYDAYS.map(r => r.payroll_uuid === 'pr-w-1125' ? { ...r, paid: { 'g-ava': { total: 220.5 } } } : r);
  const L = o => ({ gusto_uuid: 'g-ava', profile_id: 'p-ava', name: 'Ava Stone', claim_status: 'approved', approved_cents: 12050, adjust_cents: 0, expected_cents: 12050, ...o });
  const chk = (status, l) => ({ company: 'wtny', payroll_uuid: 'pr-w-1125', check_date: '2026-11-25', off_cycle: false, status, summary: status === 'ok' ? 'Every reimbursement matches, with 1 note.' : '1 reimbursement doesn’t match.', lines: [l] });
  // an off-cycle payroll already paid it: the amounts agree, the Mac warns
  const dbl = plain(company({ day: '2026-11-25', paydays: ran, checks: [chk('problems', L({ paid_cents: 12050, kind: 'offcycle', tone: 'warn', text: 'Paid $120.50, but the off-cycle payroll of Fri Dec 4 already paid it.' }))] }));
  const a = dbl.rows.find(r => r.name === 'Ava Stone');
  assert.deepEqual([a.same, a.pw.ok, a.pw.note, dbl.totals.mismatched], [false, false, 'Paid $120.50, but the off-cycle payroll of Fri Dec 4 already paid it.', 1]);
  // a late claim paid on top: the amounts differ, the Mac's note is a check mark, and the header shows its all-clear
  const late = company({ day: '2026-11-25', paydays: ran, checks: [chk('ok', L({ paid_cents: 22050, kind: 'late', tone: 'info', text: 'Paid $220.50: the $120.50 due plus $100.00, a late claim.' }))] });
  const b = late.rows.find(r => r.name === 'Ava Stone');
  assert.deepEqual([b.same, b.pw.ok, b.pw.note, late.totals.mismatched], [true, true, 'Paid $220.50: the $120.50 due plus $100.00, a late claim.', 0]);
  const head = textOf(page.payrollSectionHtml(late, TODAY));
  assert.ok(head.includes('✓ Every reimbursement matches, with 1 note.') && !head.includes('doesn’t match Type in Gusto'), head);
  assert.ok(textOf(page.payrollRowHtml(late, b, TODAY)).includes('✓ Gusto paid $220.50 Paid $220.50: the $120.50 due plus $100.00, a late claim.'));
  // the app changed since the Mac looked: the page's own comparison, with the Mac's words and what the app says now
  const stale = plain(company({ day: '2026-11-25', paydays: ran, checks: [chk('ok', L({ expected_cents: 9000, paid_cents: 22050, kind: 'late', tone: 'info', text: 'An old note.' }))] }));
  const s = stale.rows.find(r => r.name === 'Ava Stone');
  assert.deepEqual([s.same, s.pw.note, stale.totals.mismatched], [false, 'An old note. The app now says $120.50.', 1]);
});

test('late claims: an approved claim its own payday didn\'t pay shows on the next payday until something pays it', () => {
  // made-up: Ben's Nov 7 to Nov 20 claim ($50.00) was approved after the 11/25 payroll ran, which paid him nothing
  const T3 = [...T, { id: 'tl', ba_id: 'p-ben', period_id: 'per-a', amount: 50, status: 'approved' }];
  const S3 = [...SUBS, { ba_id: 'p-ben', period_id: 'per-a', status: 'approved' }];
  const ben = o => plain(company({ T: T3, subs: S3, ...o })).rows.find(r => r.name === 'Ben Cole');
  const b = ben();
  assert.deepEqual(b.late.map(i => [i.start, i.end, i.ownDay, i.approved, i.owed, i.partly, i.here, i.later, i.rest, i.reason]),
    [['2026-11-07', '2026-11-20', '2026-11-25', 5000, 5000, false, 0, [], 5000, 'Late claim for Nov 7 to Nov 20, not paid on Nov 25']]);
  assert.deepEqual([b.type, b.lateRest], [2500, 5000]);                                     // Type in Gusto is the formula, never a guess
  const c = company({ T: T3, subs: S3 });
  const h = page.payrollRowHtml(c, c.rows.find(r => r.name === 'Ben Cole'), TODAY);
  assert.ok(textOf(h).includes('⚠ Still owed: $50.00, their approved claim for Nov 7 to Nov 20, which the Wed Nov 25 payroll didn’t pay.'), textOf(h));
  assert.match(h, /data-paylate="2026-11-07" data-pid="p-ben"[^>]*>Add \$50\.00 to this payday<\/button>/);
  // added to this payday (source: the payday that didn't pay it): Type in Gusto has it, and the row says nothing more
  const tag = A({ id: 'l1', profile_id: 'p-ben', cents: 5000, reason: 'Late claim for Nov 7 to Nov 20, not paid on Nov 25', source_check_date: '2026-11-25' });
  const added = ben({ adjustments: [...ADJ, tag] });
  assert.deepEqual([added.type, added.late.map(i => [i.here, i.rest]), added.lateRest], [7500, [[5000, 0]], 0]);
  const c2 = company({ T: T3, subs: S3, adjustments: [...ADJ, tag] });
  assert.ok(!page.payrollRowHtml(c2, c2.rows.find(r => r.name === 'Ben Cole'), TODAY).includes('Still owed'));
  // added to a later payday instead: this one says so, and offers nothing
  const later = ben({ adjustments: [...ADJ, { ...tag, check_date: '2026-12-23' }] });
  assert.deepEqual(later.late.map(i => [i.here, i.later, i.rest]), [[0, [{ day: '2026-12-23', cents: 5000 }], 0]]);
  const c3 = company({ T: T3, subs: S3, adjustments: [...ADJ, { ...tag, check_date: '2026-12-23' }] });
  const h3 = page.payrollRowHtml(c3, c3.rows.find(r => r.name === 'Ben Cole'), TODAY);
  assert.ok(textOf(h3).includes('Late claim: their approved claim for Nov 7 to Nov 20, which the Wed Nov 25 payroll didn’t pay. $50.00 of it is added to Wed Dec 23.'));
  assert.ok(!h3.includes('data-paylate'));
  // on the 12/23 payday it is settled by what 12/9 adds, run or not
  assert.deepEqual(ben({ day: '2026-12-23', adjustments: [...ADJ, tag] }).late, []);
  // 12/9 ran and paid it on top of Type in Gusto (the hourly copy, no check from the Mac): a check mark that says so
  const ran = PAYDAYS.map(r => r.payroll_uuid === 'pr-w-1209' ? { ...r, processed: true, paid: { 'g-ben': { total: 75 } } } : r);
  const r = ben({ paydays: ran });
  assert.deepEqual([r.same, r.pw.note], [true, 'That’s Type in Gusto plus $50.00, their approved claim for Nov 7 to Nov 20, which the Wed Nov 25 payroll didn’t pay.']);
  const c4 = company({ T: T3, subs: S3, paydays: ran });
  assert.ok(!page.payrollRowHtml(c4, c4.rows.find(x => x.name === 'Ben Cole'), TODAY).includes('Still owed'));
  // ...and then the 12/23 payday doesn't owe it any more; had 12/9 paid only Type in Gusto, it would
  assert.deepEqual(ben({ day: '2026-12-23', paydays: ran }).late, []);
  const short = PAYDAYS.map(x => x.payroll_uuid === 'pr-w-1209' ? { ...x, processed: true, paid: { 'g-ben': { total: 25 } } } : x);
  assert.deepEqual(ben({ day: '2026-12-23', paydays: short }).late.map(i => [i.start, i.rest]), [['2026-11-07', 5000]]);
  // a run payday that didn't pay it: the row says to add it to one Gusto hasn't run
  const c5 = company({ T: T3, subs: S3, paydays: short });
  assert.ok(textOf(page.payrollRowHtml(c5, c5.rows.find(x => x.name === 'Ben Cole'), TODAY)).includes('Add it to a payday Gusto hasn’t run (pick one above).'));
  // an inactive person with only a late claim still gets a row
  assert.ok(plain(company({ T: [...T, { id: 'tc', ba_id: 'p-cy', period_id: 'per-a', amount: 9, status: 'approved' }], subs: [...SUBS, { ba_id: 'p-cy', period_id: 'per-a', status: 'approved' }] }))
    .rows.some(x => x.name === 'Cy Park' && x.late.length === 1 && !x.quiet));
});

test('late claims follow the Mac\'s ledger: paid in part, paid on top of a later payroll, an off-cycle payment, the 120-day window', () => {
  const L = get('payrollLedger');
  const run = (period_start, check_date, paid, processed = true) => ({ period_start, check_date, planned: check_date, processed, paid });
  const runs = [run('2026-10-10', '2026-10-28', 40000), run('2026-10-24', '2026-11-10', 30000), run('2026-11-07', '2026-11-25', 10000), run('2026-11-21', '2026-12-09', 0, false)];
  const claims = [{ start: '2026-10-10', end: '2026-10-23', approved: 61500 }, { start: '2026-10-24', end: '2026-11-06', approved: 30000 }, { start: '2026-11-07', end: '2026-11-20', approved: 10000 }];
  const owed = o => plain(L({ claims, runs, day: '2026-12-09', before: '2026-11-21', ...o })).filter(i => i.owed > 0 && !i.paidOn).map(i => [i.start, i.owed, i.partly]);
  assert.deepEqual(owed({}), [['2026-10-10', 21500, true]]);                              // paid only in part on 10/28
  // a later payroll paid exactly that on top of its own claim: settled there
  const extra = runs.map(r => r.check_date === '2026-11-10' ? { ...r, paid: 30000 + 21500 } : r);
  assert.deepEqual(owed({ runs: extra }), []);
  assert.equal(plain(L({ claims, runs: extra, day: '2026-12-09', before: '2026-11-21' }))[0].paidOn, '2026-11-10');
  // an off-cycle payroll paid it
  assert.deepEqual(owed({ offs: [{ check_date: '2026-11-02', paid: 21500 }] }), []);
  // an adjustment added for it on a payday after its own (run or not) settles that much
  assert.deepEqual(owed({ tagged: (ownDay, r) => (ownDay === '2026-10-28' && r.check_date === '2026-11-25' ? 20000 : 0) }), [['2026-10-10', 1500, true]]);
  // its own payday more than 120 days before: left alone
  assert.deepEqual(owed({ day: '2027-03-01', before: '2027-02-20' }), []);
  // adjustments on its own payday count in what was due there
  assert.deepEqual(owed({ adjOn: r => (r.check_date === '2026-10-28' ? -21500 : 0) }), []);
  assert.deepEqual(plain(L({ claims, runs, day: 'nope' })), []);
  // the words and the reason
  assert.equal(get('payrollLateWords')({ start: '2026-10-10', end: '2026-10-23', ownDay: '2026-10-28', partly: true }, TODAY),
    'the rest of their approved claim for Oct 10 to Oct 23, which the Wed Oct 28 payroll paid only in part');
  assert.equal(get('payrollLateReason')({ start: '2026-10-10', end: '2026-10-23', ownDay: '2026-10-28', partly: true }, TODAY),
    'Rest of the claim for Oct 10 to Oct 23, paid only in part on Oct 28');
});

test('the Book card dates a late claim on the payday it was added to', () => {
  const PER = { id: 'per-a', start_date: '2026-11-07', end_date: '2026-11-20' };
  const rows = [PD({ company: 'wtny', period_start: '2026-11-07', check_date: '2026-11-25', processed: true, paid: {} }),
    PD({ company: 'wtny', period_start: '2026-11-21', check_date: '2026-12-09' }), PD({ company: 'wtny', period_start: '2026-12-05', check_date: '2026-12-23' })];
  const tag = A({ id: 'l1', profile_id: 'p-ben', cents: 5000, source_check_date: '2026-11-25', check_date: '2026-12-23' });
  const f = (o = {}) => plain(get('qboDefaultDate')({ period: PER, paydays: rows, gustoUuid: 'g-ben', cents: 5000, today: '2026-12-01', company: 'wtny', ...o }));
  assert.deepEqual(f(), { date: '2026-12-09', how: 'late', note: 'Late: next payday 12/9' });                  // as before
  assert.deepEqual(f({ adjustments: [tag] }), { date: '2026-12-23', how: 'late', note: 'Late: added to the 12/23 payday' });
  const ran = rows.map(r => r.check_date === '2026-12-23' ? { ...r, processed: true, paid: { 'g-ben': { total: 95 } } } : r);
  assert.deepEqual(f({ paydays: ran, adjustments: [tag], today: '2026-12-24' }), { date: '2026-12-23', how: 'paid', note: 'Gusto paid this on 12/23, added there as a late claim' });
  // another amount, or another source, isn't this claim
  assert.equal(f({ adjustments: [{ ...tag, cents: 4000 }] }).date, '2026-12-09');
  assert.equal(f({ adjustments: [{ ...tag, source_check_date: '2026-11-10' }] }).date, '2026-12-09');
});

test('people with a claim who aren\'t linked to a company in Gusto are listed apart', () => {
  const u = plain(get('payrollUnlinked')({ people: PEOPLE, profiles: PROFILES, periods: [PER_B], T, E, subs: SUBS }));
  assert.deepEqual(u, [{ profileId: 'p-fay', name: 'Fay Wren', start: '2026-11-21', end: '2026-12-04', state: 'none', words: 'Not submitted', approved: 3300, waiting: 0 }]);
  assert.deepEqual(plain(get('payrollUnlinked')({ people: PEOPLE, profiles: PROFILES, periods: [], T, E })), []);
});

test('the line under the shared period picker: Gusto already paid the period picked (companies named when their days differ)', () => {
  const n = rows => get('payrollPaidNote')(rows, TODAY);
  const R = (company, check_date, processed = true) => ({ company, check_date, processed });
  assert.equal(n([R('wtny', '2026-10-14'), R('filifera', '2026-10-14'), R('wafgus', '2026-10-14')]), 'Gusto already paid this period on Wed Oct 14.');
  assert.equal(n([R('wtny', '2026-10-14'), R('filifera', '2026-10-14'), R('wafgus', '2026-10-15')]),
    'Gusto already paid this period on Wed Oct 14 (Wizard Trees NY and Filifera LLC) and Thu Oct 15 (Waf & Gus LLC).');
  assert.equal(n([R('wtny', '2026-11-25'), R('filifera', '2026-11-25', false), R('wafgus', '2026-11-25', false)]), 'Gusto already paid this period on Wed Nov 25 (Wizard Trees NY).');
  assert.equal(n([R('wtny', '2026-12-09', false)]), '');
  assert.equal(n([]), '');
});

test('an amount typed in the form: dollars and cents above zero, in cents; anything else is refused', () => {
  const p = get('payrollParseAmount');
  for (const [t, c] of [['25', 2500], ['25.5', 2550], [' $1,234.56 ', 123456], ['.5', 50], ['0.07', 7], ['$ 12', 1200], ['1000000', 100000000]]) assert.equal(p(t), c, t);
  for (const t of ['', ' ', 'abc', '-5', '0', '0.00', '1.234', '1,23', '12.', '1e2', '$', '25 dollars', null, undefined]) assert.equal(p(t), null, String(t));
});

// ── Book in QuickBooks: a payroll that paid a claim plus that payday's adjustments paid the claim ──
test('the Book card\'s date and Gusto line count a payday\'s adjustments; without any, everything is as before', () => {
  const PER = { id: 'per-b', start_date: '2026-11-21', end_date: '2026-12-04' };
  const rows = [PD({ company: 'wtny', period_start: '2026-11-21', check_date: '2026-12-09', processed: true, paid: { 'g-ava': { total: 250, lines: [250] } } }),
    PD({ company: 'wtny', period_start: '2026-12-05', check_date: '2026-12-23' })];
  const adj = [A({ id: 'a1', profile_id: 'p-ava', cents: -15000 })];
  const f = o => plain(get('qboDefaultDate')({ period: PER, paydays: rows, gustoUuid: 'g-ava', cents: 40000, today: '2026-12-10', company: 'wtny', ...o }));
  assert.deepEqual(f({ adjustments: adj }), { date: '2026-12-09', how: 'paid', note: 'Gusto paid this on 12/9, with $150.00 taken off by adjustments' });
  assert.deepEqual(f({}), { date: '2026-12-23', how: 'late', note: 'Late: next payday 12/23' });                         // as before
  assert.equal(f({ adjustments: [{ ...adj[0], cancelled_at: '2026-12-01T00:00:00Z' }] }).how, 'late');
  assert.equal(f({ adjustments: [{ ...adj[0], company: 'filifera' }] }).how, 'late');
  assert.equal(f({ adjustments: [{ ...adj[0], check_date: '2026-12-23' }] }).how, 'late');
  assert.equal(f({ adjustments: [] }).how, 'late');
  const up = [PD({ ...rows[0], paid: { 'g-ava': { total: 450 } } }), rows[1]];
  assert.deepEqual(f({ paydays: up, adjustments: [{ ...adj[0], cents: 5000 }] }), { date: '2026-12-09', how: 'paid', note: 'Gusto paid this on 12/9, with $50.00 added by adjustments' });
  // an exact amount still wins, and says nothing about adjustments
  assert.deepEqual(f({ cents: 25000, adjustments: adj }), { date: '2026-12-09', how: 'paid', note: 'Gusto paid this on 12/9' });
  // the Gusto line: same, with the adjustments it counted; none given (or an exact hit): the shape as before
  const g = o => plain(get('qboGustoPaid')({ period: PER, paydays: rows, gustoUuid: 'g-ava', cents: 40000, company: 'wtny', ...o }));
  assert.deepEqual(g({ adjustments: adj }), { date: '2026-12-09', cents: 25000, lines: [25000], same: true, adj: -15000 });
  assert.deepEqual(g({}), { date: '2026-12-09', cents: 25000, lines: [25000], same: false });
  assert.deepEqual(g({ cents: 25000, adjustments: adj }), { date: '2026-12-09', cents: 25000, lines: [25000], same: true });
  assert.deepEqual(g({ adjustments: [{ ...adj[0], cents: -1000 }] }), { date: '2026-12-09', cents: 25000, lines: [25000], same: false, adj: -1000 });
  assert.equal(get('qboAdjCents')(adj, 'wtny', rows[0], rows), -15000);
  assert.equal(get('qboAdjCents')(null, 'wtny', rows[0], rows), 0);
  assert.equal(get('qboAdjWords')(-15000), 'with $150.00 taken off by adjustments');
});

test('the Book card: adjustments taking all of a claim off match a payroll that paid them nothing', () => {
  // made-up: a $100.00 claim, $150.00 taken off on 12/9 and $50.00 of that carried to 12/23, so $0.00 typed on 12/9
  const PER = { id: 'per-b', start_date: '2026-11-21', end_date: '2026-12-04' };
  const rows = [PD({ company: 'wtny', period_start: '2026-11-21', check_date: '2026-12-09', processed: true, paid: { 'g-other': { total: 10 } } }),
    PD({ company: 'wtny', period_start: '2026-12-05', check_date: '2026-12-23' })];
  const adj = [A({ id: 'x1', profile_id: 'p-ava', cents: -15000 }), A({ id: 'x2', profile_id: 'p-ava', cents: 5000, carried_from: 'x1', carry_group: 'g' }),
    A({ id: 'x3', profile_id: 'p-ava', cents: -5000, carried_from: 'x1', carry_group: 'g', check_date: '2026-12-23' })];
  const d = plain(get('qboDefaultDate')({ period: PER, paydays: rows, gustoUuid: 'g-ava', cents: 10000, today: '2026-12-10', company: 'wtny', adjustments: adj }));
  assert.deepEqual(d, { date: '2026-12-09', how: 'paid', note: 'Nothing was due on 12/9: adjustments took all of this off' });
  assert.deepEqual(plain(get('qboGustoPaid')({ period: PER, paydays: rows, gustoUuid: 'g-ava', cents: 10000, company: 'wtny', adjustments: adj })),
    { date: '2026-12-09', cents: 0, lines: [], same: true, adj: -10000 });
  // a payroll that paid them nothing while something was due still doesn't match
  assert.equal(get('qboDefaultDate')({ period: PER, paydays: rows, gustoUuid: 'g-ava', cents: 12000, today: '2026-12-10', company: 'wtny', adjustments: adj }).how, 'late');
  assert.equal(get('qboGustoPaid')({ period: PER, paydays: rows, gustoUuid: 'g-ava', cents: 12000, company: 'wtny', adjustments: adj }).same, false);
});

test('the Book card: a payday Gusto moved keeps the adjustments added for its old day, and never takes the payday before\'s', () => {
  const PER = { id: 'per-b', start_date: '2026-11-21', end_date: '2026-12-04' };
  // made-up: the 11/7 period's payday ran late on 11/27 (planned 11/25), and the 11/21 period's moved from 12/9 to 12/11
  const rows = [PD({ company: 'wtny', period_start: '2026-11-07', check_date: '2026-11-27', processed: true, paid: { 'g-ava': { total: 90 } } }),
    PD({ company: 'wtny', period_start: '2026-11-21', check_date: '2026-12-11', processed: true, paid: { 'g-ava': { total: 320 } } }),
    PD({ company: 'wtny', period_start: '2026-12-05', check_date: '2026-12-23' })];
  const adj = [A({ id: 'm1', profile_id: 'p-ava', cents: -18000 }),                                   // added for 12/9
    A({ id: 'm2', profile_id: 'p-ava', cents: -1000, check_date: '2026-11-25' })];                     // the 11/27 payday's, added for 11/25
  assert.equal(get('qboAdjCents')(adj, 'wtny', rows[1], rows), -18000);
  assert.equal(get('qboAdjCents')(adj, 'wtny', rows[0], rows), -1000);
  assert.equal(get('qboAdjCents')(adj, 'wtny', rows[2], rows), 0);
  assert.deepEqual(plain(get('qboDefaultDate')({ period: PER, paydays: rows, gustoUuid: 'g-ava', cents: 50000, today: '2026-12-12', company: 'wtny', adjustments: adj })),
    { date: '2026-12-11', how: 'paid', note: 'Gusto paid this on 12/11, with $180.00 taken off by adjustments' });
  assert.equal(get('qboGustoPaid')({ period: PER, paydays: rows, gustoUuid: 'g-ava', cents: 50000, company: 'wtny', adjustments: adj }).same, true);
  // the moved payday not run yet: the claim's own payday, as before
  const open = rows.map((r, i) => i === 1 ? { ...r, processed: false, paid: {} } : r);
  assert.deepEqual(plain(get('qboDefaultDate')({ period: PER, paydays: open, gustoUuid: 'g-ava', cents: 50000, today: '2026-12-01', company: 'wtny', adjustments: adj })),
    { date: '2026-12-11', how: 'payday', note: 'Payday 12/11, from Gusto' });
  // the home rule: the payday's day, its day in the table, or a day after the payday before that no payday has any more
  const runs = get('qboRuns')(rows, [], 'wtny');
  assert.deepEqual(plain(runs).map(r => [r.period_start, r.check_date, r.planned, r.processed]),
    [['2026-11-07', '2026-11-27', '2026-11-27', true], ['2026-11-21', '2026-12-11', '2026-12-11', true], ['2026-12-05', '2026-12-23', '2026-12-23', false]]);
  const home = get('qboAdjHome')(runs[1], runs);
  assert.deepEqual(['2026-11-27', '2026-11-28', '2026-12-09', '2026-12-11', '2026-12-12', '2026-12-23'].map(home), [false, true, true, true, false, false]);
  // the Mac's check of a payroll the hourly copy doesn't have as run yet: run, on the check's day
  const chk = plain(get('qboRuns')(open, [{ company: 'wtny', payroll_uuid: null, period_start: '2026-11-21', check_date: '2026-12-11', off_cycle: false }], 'wtny'));
  assert.deepEqual([chk[1].check_date, chk[1].processed], ['2026-12-11', true]);
});

// ── the list's words, run from the page with its own esc and the model ──
const fnSrc = name => { const a = html.indexOf(name); assert.ok(a >= 0, name); const b = html.indexOf('\n}\n', a); return html.slice(a, b + 2); };
const page = (() => {
  const c = { Number, String, Math, Array, Date, JSON, Object, Set, Map };
  vm.createContext(c);
  vm.runInContext(between('const isCoPaid = p =>', '/* ─────────────────────────── helpers'), c);
  vm.runInContext(between('/* ── QBO PLAN MODEL ── */', '/* ── end QBO PLAN MODEL ── */'), c);
  vm.runInContext(between('/* ── PAYROLL MODEL ── */', '/* ── end PAYROLL MODEL ── */'), c);
  const lineOf = start => { const l = html.split('\n').find(x => x.startsWith(start)); assert.ok(l, start); return l.replace(/^const (\w+)\s*=/, 'globalThis.$1 ='); };
  vm.runInContext(lineOf('const esc = s =>'), c);
  vm.runInContext("globalThis.qboAgo = ts => ts ? '5 min ago' : ''; globalThis.payrollWhen = ts => ts ? 'today at 2:14 PM' : '';", c);
  for (const f of ['function payrollRowHtml(', 'function payrollShortHtml(', 'function payrollLateHtml(', 'function payrollSectionHtml(', 'function payrollGustoHtml(',
    'function payrollOutsideHtml(', 'function payrollUnlinkedHtml(', 'function payrollStrandedHtml(']) vm.runInContext(fnSrc(f), c);
  return c;
})();
// the words as the list reads (every tag a break: the rows lay their parts out side by side)
const textOf = h => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

test('a row: the person, the period, the state, the approved amount, each adjustment with its reason, Type in Gusto with Copy', () => {
  const c = company();
  const [ava, ben, dee, gus] = c.rows;
  const a = page.payrollRowHtml(c, ava, TODAY);
  assert.match(textOf(a), /^Ava Stone Approved Nov 21 to Dec 4 · \$5\.55 more not approved yet, not counted Approved \$41\.80 Taken off -\$50\.00 Paid twice on an earlier payday Cancel Type in Gusto \$0\.00 Copy/);
  assert.ok(a.includes('Type $0.00. $8.20 doesn’t fit this payday.'));
  assert.ok(a.includes('isn’t approved yet, so this may still fit once it is.'));        // the claim can still grow
  assert.match(a, /data-paycarry="p-ava"[^>]*>Carry \$8\.20 to Wed Dec 23<\/button>/);
  assert.match(a, /data-paycopy="0\.00"/);
  assert.match(a, /data-paycancel="a1" data-pid="p-ava">Cancel</);
  assert.match(a, /data-payadd="p-ava">Add or take off</);
  const b = page.payrollRowHtml(c, ben, TODAY);
  assert.match(textOf(b), /^Ben Cole Waiting for approval Nov 21 to Dec 4 · \$40\.00 submitted, not counted Approved \$0\.00 Added \+\$25\.00 A made-up reason Cancel Type in Gusto \$25\.00 Copy/);
  assert.match(b, /data-paycopy="25\.00"/);
  assert.ok(!b.includes('doesn’t fit'));
  assert.match(page.payrollRowHtml(c, dee, TODAY), /Dee Lane<\/b> <span class="badge draft">Not submitted<\/span> <span class="pill">inactive<\/span>/);
  assert.ok(page.payrollRowHtml(c, dee, TODAY).includes('Their claim for Nov 21 to Dec 4 isn’t in yet, so this may still fit once it’s approved.'));
  assert.ok(a.includes('Part of their claim for Nov 21 to Dec 4 isn’t approved yet'));
  // a quiet row still says who, the period, the state and Type in Gusto
  assert.equal(textOf(page.payrollRowHtml(c, gus, TODAY)), 'Gus Hale · Nov 21 to Dec 4 · Not submitted Type in Gusto $0.00 Add or take off');
  // every row prints its period
  for (const r of c.rows) assert.ok(page.payrollRowHtml(c, r, TODAY).includes('Nov 21 to Dec 4'), r.name);
  // the Mac's words, a reason and a name are escaped
  const odd = { ...ava, name: '<img src=x>', adj: [{ ...ava.adj[0], reason: '<script>x</script>' }] };
  const h = page.payrollRowHtml(c, odd, TODAY);
  assert.ok(!/<img|<script/.test(h));
  // the claim settled and still below zero: the carry without the wait note; in steps when no single adjustment holds it
  const settled = page.payrollRowHtml(c, { ...ava, settled: true, carry: { short: 820, from: 'a1', cents: -500, to: '2026-12-23', whole: false } }, TODAY);
  assert.ok(!settled.includes('isn’t approved yet'));
  assert.ok(settled.includes('No single adjustment here holds all $8.20, so carry it in steps: $5.00 now, then the rest.'));
  assert.ok(page.payrollRowHtml(c, { ...ava, carry: { short: 820, why: 'claim' } }, TODAY).includes('Nothing here can be carried'));
});

test('a payday Gusto ran: read only, what Gusto paid on each row, and its state in the header', () => {
  const check = { company: 'wtny', payroll_uuid: 'pr-w-1125', check_date: '2026-11-25', off_cycle: false, status: 'problems', summary: '1 reimbursement is off.',
    checked_at: '2026-11-24T21:00:00Z', processed_at: '2026-11-24T20:50:00Z', deadline: '2099-12-04T00:00:00Z',
    lines: [{ gusto_uuid: 'g-ava', profile_id: 'p-ava', name: 'Ava Stone', paid_cents: 15000, expected_cents: 12050, kind: 'mismatch', tone: 'warn', text: 'Paid $150.00; the approved claim is $120.50.' },
      { gusto_uuid: 'g-zed', profile_id: null, name: 'Zed Quill', paid_cents: 1500, kind: 'outside', tone: 'info', text: 'Not in the BA app.' }] };
  const c = company({ day: '2026-11-25', checks: [check], adjustments: [A({ id: 'r1', profile_id: 'p-ava', cents: -100, check_date: '2026-11-25' })] });
  const h = page.payrollSectionHtml(c, TODAY);
  const t = textOf(h);
  assert.ok(t.startsWith('Wizard Trees NY Check date Wed Nov 25 · pays Sat Nov 7 to Fri Nov 20, 2026 Run in Gusto today at 2:14 PM. The Mac checked it 5 min ago.'), t);
  assert.ok(t.includes(`It can be cancelled in Gusto until ${get('payrollPacific')('2099-12-04T00:00:00Z')}.`));
  assert.ok(t.includes('⚠ 1 reimbursement is off.'));
  assert.ok(t.includes('Approved $120.50 Adjustments -$1.00 Type in Gusto $119.50 Gusto paid $150.00'));
  assert.ok(t.includes('⚠ Gusto paid $150.00 Paid $150.00; the approved claim is $120.50. The app now says $119.50.'));
  assert.ok(t.includes('Paid in Gusto, not in the app Zed Quill $15.00 Not in the BA app.'));
  assert.ok(!h.includes('data-payadd') && !h.includes('data-paycancel') && !h.includes('data-paycarry'));   // adjustments are read only now
  // not run yet: says so, no Gusto paid total
  const open = textOf(page.payrollSectionHtml(company(), TODAY));
  assert.ok(open.includes('Check date Wed Dec 9 · pays Sat Nov 21 to Fri Dec 4, 2026 Not run in Gusto yet.'));
  assert.ok(!open.includes('Gusto paid'));
  // run with every line matching: a check mark from the Mac's summary
  const ok = company({ day: '2026-11-25', checks: [{ ...check, status: 'ok', summary: 'Every reimbursement matches.', deadline: null,
    lines: [{ ...check.lines[0], paid_cents: 12050, expected_cents: 12050, kind: 'ok', tone: 'ok', text: '' }] }] });
  const okText = textOf(page.payrollSectionHtml(ok, TODAY));
  assert.ok(okText.includes('✓ Every reimbursement matches.') && okText.includes('✓ Gusto paid $120.50'));
  assert.ok(!okText.includes('can be cancelled'));
  // the unlinked list
  const u = textOf(page.payrollUnlinkedHtml(get('payrollUnlinked')({ people: PEOPLE, profiles: PROFILES, periods: [PER_B], T, E, subs: SUBS }), TODAY));
  assert.ok(u.includes('Fay Wren · Nov 21 to Dec 4 · Not submitted Approved $33.00'));
});

// ── the page's wiring ──
const block = between('/* ── Payroll list: the page side (bookers only) ──', '/* ── Admin: review queue ── */');
test('wiring: a Payroll tab after Review for bookers only, its own check date, a typable picker, the RPCs, read-only once run', () => {
  const nav = fnSrc('function renderAdmin(');
  assert.match(nav, /data-t="review"[^\n]*\n\s*\$\{state\.qboCanBook\?`<button data-t="payroll" class="\$\{state\.adminTab==='payroll'\?'on':''\}">Payroll<\/button>`:''\}/);
  assert.match(fnSrc('function drawAdmin('), /if\(state\.adminTab==='payroll'\) return state\.qboCanBook \? adminPayroll\(m\) : adminDash\(m\);/);
  // never the shared pay period picker's period
  assert.ok(!/state\.period\b/.test(block));
  assert.ok(!/state\.period\b/.test(between('/* ── PAYROLL MODEL ── */', '/* ── end PAYROLL MODEL ── */')));
  assert.match(block, /state\.payrollDay=sel\.value/);
  // the check date and the form's payday are typable pickers (searchifySelect; openSheet searchifies a sheet's selects)
  assert.match(block, /<select id="paySel" data-searchable>/);
  assert.match(block, /searchifySelect\(sel, 'Check date'\)/);
  assert.match(block, /<select id="payDay" data-searchable>/);
  assert.ok(!/<select(?![^>]*data-searchable)/.test(block));
  // adjustments only through the RPCs, with integer cents; Cancel asks first
  assert.match(block, /supabase\.rpc\('ba_reimb_adjust_add',\{ p:\{ profile_id:r\.profileId, company:c\.company, check_date:day, cents:sign\*cents, reason \} \}\)/);
  assert.match(block, /supabase\.rpc\('ba_reimb_adjust_carry',\{ p_id:k\.from, p_cents:k\.cents, p_to:k\.to \}\)/);
  const cancel = fnSrc('async function payrollCancel(');
  assert.ok(cancel.indexOf('confirm(') >= 0 && cancel.indexOf('confirm(') < cancel.indexOf("rpc('ba_reimb_adjust_cancel',{ p_id:a.id })"));
  assert.ok(!/from\('ba_reimb_adjustments'\)\.(insert|update|delete|upsert)/.test(html));
  // errors are the RPC's own words in a toast
  assert.match(block, /toast\(error\.message,'err',9000\)/);
  // adding, cancelling and carrying are offered only while the payday is open
  const row = fnSrc('function payrollRowHtml(');
  assert.match(row, /const add=c\.open \?/);
  assert.match(row, /!c\.open \? '' : a\.canCancel \?/);
  assert.match(fnSrc('function payrollShortHtml('), /if\(!c\.open\) return h\+/);
  // the whole payroll tables come in pages (a cut-off read would understate a claim)
  assert.match(block, /payrollPaged\(\(a,z\)=>supabase\.from\('trips'\)/);
  assert.match(block, /payrollPaged\(\(a,z\)=>selectExpenses\(/);
  // a late claim is added in one press, after a confirm, as an adjustment naming the payday that didn't pay it
  const late = fnSrc('async function payrollLateAdd(');
  assert.ok(late.indexOf('confirm(') >= 0 && late.indexOf('confirm(') < late.indexOf("rpc('ba_reimb_adjust_add'"));
  assert.match(late, /supabase\.rpc\('ba_reimb_adjust_add',\{ p:\{ profile_id:r\.profileId, company:c\.company, check_date:c\.day, cents:i\.rest, reason:i\.reason, source_check_date:i\.ownDay \} \}\)/);
  assert.match(late, /if\(!btn \|\| btn\.disabled \|\| !c\.open \|\| !\(i\.rest>0\)\) return;/);
  // the claims of the periods before the date are read too (late claims), and the adjustments no list shows sit on top
  assert.match(block, /Object\.assign\(d, await payrollLoadClaims\(\[\.\.\.d\.pers, \.\.\.d\.hist\]\.map\(p=>p\.id\)\)\);/);
  assert.match(block, /const stranded=payrollStranded\(\{ adjustments:d\.adjustments, people:d\.people, profiles:d\.profiles, paydays:d\.paydays, checks:d\.checks \}\);/);
  assert.match(block, /\$\{stranded\.length \? payrollStrandedHtml\(stranded, today\) : ''\}/);
  // it opens on a payroll whose check found problems while it can be cancelled
  assert.match(block, /state\.payrollDay=payrollDefaultDay\(d\.choices, today, Date\.now\(\)\);/);
});

test('wiring: already-paid periods named under the shared picker for bookers; Review says Approved, not reimbursed', () => {
  const dash = fnSrc('async function adminDash(');
  assert.match(dash, /\(state\.qboCanBook && !all && per\)\?`<div id="payPaidD" data-start="\$\{esc\(per\.start_date\)\}"><\/div>`:''/);
  assert.match(dash, /if\(state\.qboCanBook && !all && per\) payrollPaidPeriodNote\(per, 'payPaidD'\);/);
  const det = fnSrc('async function adminBaDetail(');
  assert.match(det, /\(state\.qboCanBook && !allPer\)\?`<div id="payPaidS" data-start="\$\{esc\(per\.start_date\)\}" data-ba="\$\{esc\(baId\)\}"><\/div>`:''/);
  assert.match(det, /if\(state\.qboCanBook && !allPer\) payrollPaidPeriodNote\(per, 'payPaidS', baId\);/);
  const note = fnSrc('async function payrollPaidPeriodNote(');
  assert.match(note, /if\(!state\.qboCanBook \|\| !per \|\| isAllPeriods\(per\)/);
  assert.match(note, /from\('ba_qbo_paydays'\)\.select\(baId \? 'company,check_date,processed,paid' : 'company,check_date,processed'\)\.eq\('period_start',per\.start_date\)/);
  assert.match(note, /from\('ba_qbo_people'\)\.select\('company,gusto_uuid'\)\.eq\('profile_id',baId\)\.maybeSingle\(\)/);
  // a sheet opened since for someone else never gets this person's line
  assert.match(note, /\(baId && h\.dataset\.ba!==String\(baId\)\)\) return;/);
  assert.match(note, /const words=baId \? payrollPaidPersonNote\(rows, person, todayISO\(\)\) : payrollPaidNote\(rows, todayISO\(\)\);/);
  assert.match(note, /To type amounts into a payroll, use the <button[^>]*>Payroll tab<\/button>\./);
  assert.ok(!html.includes('Approved & reimbursed'));
  assert.match(fnSrc('async function adminReview('), /sub='Approved'\+hrsTag;/);
  // the Book card and the Review list pass each person's adjustments to the date and Gusto rules
  assert.match(fnSrc('function qboBookCard('), /qboGustoPaid\(\{ period:per, paydays:ctx\.paydays, gustoUuid:person\.gusto_uuid, cents:P\.cents, adjustments:ctx\.adjustments, company:person\.company \}\)/);
  assert.match(fnSrc('async function qboLoadPerson('), /qboLoadAdjustments\(baId\),\n  \]\);/);
  assert.match(fnSrc('async function qboLoadPeriod('), /qboLoadAdjustments\(null\)\]\);/);
  // the paydays come from the one before the period's own, for the rule that keeps a moved payday's adjustments with it;
  // the adjustments with the payday a late claim was added for
  assert.match(fnSrc('async function qboLoadPerson('), /from\('ba_qbo_paydays'\)\.select\('\*'\)\.eq\('company',co\)\.gte\('period_start',qboAddDays\(per\.start_date,-31\)\)/);
  assert.match(fnSrc('async function qboLoadPeriod('), /from\('ba_qbo_paydays'\)\.select\('\*'\)\.gte\('period_start',qboAddDays\(per\.start_date,-31\)\)/);
  assert.match(fnSrc('async function qboLoadAdjustments('), /select\('id,profile_id,company,check_date,cents,source_check_date,cancelled_at'\)/);
});

test('the person sheet\'s line is about that person: what the payroll for the period paid them', () => {
  const n = (rows, person) => get('payrollPaidPersonNote')(rows, person, TODAY);
  const R = (company, check_date, processed, paid = {}) => ({ company, check_date, processed, paid });
  const rows = [R('wtny', '2026-11-25', true, { 'g-ava': { total: 120.5, lines: [120.5] } }), R('filifera', '2026-11-25', false)];
  assert.equal(n(rows, { company: 'wtny', gusto_uuid: 'g-ava' }), 'The Wed Nov 25 payroll, which pays this period, paid them $120.50.');
  assert.equal(n(rows, { company: 'wtny', gusto_uuid: 'g-ben' }), 'The Wed Nov 25 payroll, which pays this period, paid them no reimbursement.');
  assert.equal(n(rows, { company: 'filifera', gusto_uuid: 'g-eli' }), '');                     // their company's hasn't run
  assert.equal(n(rows, null), 'Gusto already paid this period on Wed Nov 25 (Wizard Trees NY).');   // not linked: the Dashboard's words
  assert.equal(n(rows, { company: null, gusto_uuid: null }), 'Gusto already paid this period on Wed Nov 25 (Wizard Trees NY).');
});

test('no em dashes in anything the Payroll list added', () => {
  const css = between('/* the Payroll list (bookers only)', '@media(min-width:760px)');
  for (const [name, text] of [['model', between('/* ── PAYROLL MODEL ── */', '/* ── end PAYROLL MODEL ── */')], ['page', block], ['css', css],
    ['qbo helpers', between('const qboPaidTotal=', 'const qboAdjWords=')]]) assert.ok(!text.includes('\u2014'), name);
});
