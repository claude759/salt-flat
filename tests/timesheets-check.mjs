// node tests/timesheets-check.mjs : checks for the Manager Timesheets page (timesheets.html).
// Runs the page's pure logic (<script id="ts-core">) and demo data (<script id="ts-demo">) in a vm,
// plus static checks on the file. Synthetic data only; nothing here reads or writes the database.
// Exit 0 = safe to push. Any FAIL = do not push; fix first.
//
// The whole run happens with the machine clock set to New Zealand time, so any place that leans on the
// viewer's own time zone instead of America/Los_Angeles shows up as a failure.
process.env.TZ = 'Pacific/Auckland';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'timesheets.html');   // optional path, for checking a copy
const src = fs.readFileSync(FILE, 'utf8');
let bad = 0, count = 0;
const say = (ok, m) => { count++; console.log((ok ? '  PASS  ' : '  FAIL  ') + m); if (!ok) bad++; };
const J = x => JSON.stringify(x);
function check(name, fn) {
  try { const r = fn(); say(r !== false, name); }
  catch (e) { say(false, name + '\n          ' + String((e && e.message) || e).split('\n').slice(0, 3).join('\n          ')); }
}
function eq(got, want, what) { if (J(got) !== J(want)) throw new Error((what ? what + ': ' : '') + 'got ' + J(got) + ', want ' + J(want)); }
function ok(cond, what) { if (!cond) throw new Error(what || 'condition failed'); }

// ---------------------------------------------------------------------------------------------
// 0. load the blocks
// ---------------------------------------------------------------------------------------------
const block = id => {
  const m = src.match(new RegExp('<script id="' + id + '">([\\s\\S]*?)</script>'));
  if (!m) throw new Error('no <script id="' + id + '"> block');
  return m[1];
};
const ctx = vm.createContext({ window: {} });
vm.runInContext(block('ts-core'), ctx, { filename: 'ts-core' });
vm.runInContext(block('ts-demo'), ctx, { filename: 'ts-demo' });
const C = ctx.window.TSCore, D = ctx.window.TSDemo;
console.log('timesheets.html checks (machine TZ ' + process.env.TZ + ')');

// ---------------------------------------------------------------------------------------------
// 1. the file is whole and every inline script parses
// ---------------------------------------------------------------------------------------------
check(`file is complete (${(src.length / 1024).toFixed(0)} KB, ends with </html>)`, () => /<\/html>\s*$/i.test(src) && src.length > 40_000);
{
  const scripts = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const tmp = path.join(os.tmpdir(), `ts-inline-${process.pid}.js`);
  fs.writeFileSync(tmp, scripts.join('\n;\n'));
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); say(true, `${scripts.length} inline scripts parse`); }
  catch (e) { say(false, 'inline script syntax error:\n' + String(e.stderr || e.message).split('\n').slice(0, 6).join('\n')); }
  finally { fs.rmSync(tmp, { force: true }); }
}
check('TSCore and TSDemo load in a vm with no DOM', () => !!C && !!D && typeof C.groupByDay === 'function' && typeof D.build === 'function');

// ---------------------------------------------------------------------------------------------
// 2. static rules
// ---------------------------------------------------------------------------------------------
const markup = src.replace(/<script[\s\S]*?<\/script>/g, '');
const outsideCore = src.replace(block('ts-core'), '');
check('no em dash characters anywhere in the file', () => {
  const at = src.indexOf('—');
  ok(at < 0, 'em dash at offset ' + at + ': ' + J(src.slice(Math.max(0, at - 40), at + 20)));
  ok(!/&mdash;|\\u2014/i.test(src), 'escaped em dash (&mdash; or \\u2014) found');
});
check('never calls is_staff (access is the ts_access allowlist via ts_me)', () => ok(!/is_staff/.test(src), 'is_staff found'));
check("after sign-in it asks ts_me()", () => ok(/sb\.rpc\('ts_me'\)/.test(src), "no sb.rpc('ts_me')"));
check('admin RPCs use the spec names and argument names', () => {
  ok(/sb\.rpc\('ts_admin_list'\)/.test(src), 'ts_admin_list');
  ok(/sb\.rpc\('ts_admin_save_user', \{ p_email: [^}]*p_is_admin: [^}]*p_active: [^}]*p_note: [^}]*p_grants: /.test(src), 'ts_admin_save_user args');
  ok(/sb\.rpc\('ts_admin_delete_user', \{ p_email: /.test(src), 'ts_admin_delete_user args');
});
check('reads the ts_ tables, paging ts_days 1000 rows at a time', () => {
  for (const t of ['ts_companies', 'ts_people', 'ts_days']) ok(src.includes(`sb.from('${t}')`), t);
  ok(/\.range\(i, i \+ 999\)/.test(src), 'no .range(i, i + 999) paging');
});
check('sign-in matches the labor tracker (same project, key, Google client, local sign-out)', () => {
  ok(src.includes("'https://dhiqhgtmelxwelyoowle.supabase.co'"), 'SB_URL');
  ok(src.includes("'sb_publishable_FtScmtn1C0tE1bwUsavJFg_koiVEu14'"), 'SB_KEY');
  ok(src.includes("'168134930971-2au6foq8njul8tjja6a2v306mt10r45i.apps.googleusercontent.com'"), 'GOOGLE_CLIENT_ID');
  ok(src.includes("AUTH_DOMAIN = 'wizardtrees.com'"), 'hd wizardtrees.com');
  ok(/signInWithIdToken\(\{ provider: 'google', token: [^,]+, nonce: gisRawNonce \}\)/.test(src), 'signInWithIdToken with raw nonce');
  ok(/sha256hex\(gisRawNonce\)/.test(src), 'hashed nonce to Google');
  ok(/signOut\(\{ scope: 'local' \}\)/.test(src), "signOut({ scope: 'local' })");
  ok(src.includes('<script src="https://accounts.google.com/gsi/client" async defer></script>'), 'GSI script');
  ok(src.includes('<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>'), 'supabase-js@2 UMD');
});
check('title is "Manager Timesheets" and the no-view message is the agreed text', () => {
  ok(/<title>Manager Timesheets<\/title>/.test(src), 'title');
  ok(markup.includes("Your account doesn't have a timesheet view yet. Ask Gianni to add you."), 'no-view message');
  ok(markup.includes('Demo data, not real timesheets'), 'demo banner');
});
check('every data-driven innerHTML goes through esc(): one sink, and it only takes h`` output', () => {
  const n = (src.match(/innerHTML/g) || []).length;
  ok(n === 1, 'innerHTML appears ' + n + ' times (want exactly 1, inside setHTML)');
  ok(/function setHTML\(el, html\) \{\s*if \(!\(html instanceof C\.SafeHTML\)\) throw [^\n]*\n\s*el\.innerHTML = html\.html;/.test(src), 'setHTML must refuse anything but SafeHTML');
  ok(!/insertAdjacentHTML|outerHTML|document\.write|createContextualFragment|DOMParser/.test(src), 'another HTML sink found');
  ok(!/new\s+[\w.]*SafeHTML\(/.test(outsideCore), 'SafeHTML is constructed outside ts-core (would bypass escaping)');
  ok(/function fragment\(v\)[\s\S]*?return esc\(v\);/.test(block('ts-core')), 'h`` must escape plain values with esc()');
});
check('no inline event handlers (markup or templates)', () => {
  const m = src.match(/<[a-z][^<>]*\son[a-z]+\s*=/i);
  ok(!m, 'inline handler: ' + (m && m[0].slice(0, 80)));
});
check('no real-looking ids or pay fields in the page (UUIDs, wages, rates)', () => {
  const u = src.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  ok(!u, 'UUID-shaped string in the page: ' + (u && u[0]));
  const p = src.match(/pay_rate|hourly_rate|\bwages?\b|compensation|gross_pay/i);
  ok(!p, 'pay field mentioned: ' + (p && p[0]));
});
check('localStorage only inside the try/catch store helper', () => {
  const lines = src.split('\n').filter(l => l.includes('localStorage'));
  ok(lines.length === 2 && lines.every(l => /try \{/.test(l)), lines.join('\n'));
});

// ---------------------------------------------------------------------------------------------
// 3. pay periods, weeks, presets
// ---------------------------------------------------------------------------------------------
check('pay period: 2026-10-08 is inside 2026-09-26..2026-10-09', () => eq(C.payPeriodFor('2026-10-08'), { from: '2026-09-26', to: '2026-10-09' }));
check('pay period edges (first day, last day, next day, the anchor itself, before the anchor)', () => {
  eq(C.payPeriodFor('2026-09-26'), { from: '2026-09-26', to: '2026-10-09' }, 'first day');
  eq(C.payPeriodFor('2026-10-09'), { from: '2026-09-26', to: '2026-10-09' }, 'last day');
  eq(C.payPeriodFor('2026-10-10'), { from: '2026-10-10', to: '2026-10-23' }, 'next day');
  eq(C.payPeriodFor('2025-04-11'), { from: '2025-03-29', to: '2025-04-11' }, 'anchor');
  eq(C.payPeriodFor('2025-04-12'), { from: '2025-04-12', to: '2025-04-25' }, 'after anchor');
  eq(C.payPeriodFor('2025-03-28'), { from: '2025-03-15', to: '2025-03-28' }, 'before anchor');
});
check('pay periods 2024-2027: always Sat..Fri, 14 days, contain the date, end = 2025-04-11 + 14k', () => {
  for (let d = '2024-01-01'; d <= '2027-12-31'; d = C.addDays(d, 1)) {
    const p = C.payPeriodFor(d);
    ok(C.dow(p.from) === 6 && C.dow(p.to) === 5, d + ' period not Sat..Fri: ' + J(p));
    ok(C.daysBetween(p.from, p.to) === 13 && p.from <= d && d <= p.to, d + ' bad period ' + J(p));
    ok(((C.daysBetween('2025-04-11', p.to) % 14) + 14) % 14 === 0, d + ' period end off the 14-day grid');
  }
});
check('workweek Sat..Fri: every day of 2026-10-03..09 maps to that week', () => {
  for (let d = '2026-10-03'; d <= '2026-10-09'; d = C.addDays(d, 1)) eq(C.weekFor(d), { from: '2026-10-03', to: '2026-10-09' }, d);
  eq(C.weekFor('2026-10-10'), { from: '2026-10-10', to: '2026-10-16' });
  eq(C.weekStart('2026-10-08', 0), '2026-10-04', 'Sunday start');
  eq(C.weekStart('2026-10-08', 1), '2026-10-05', 'Monday start');
});
check('presets on 2026-10-08 (Thu)', () => {
  eq(C.presetRange('period', '2026-10-08'), { from: '2026-09-26', to: '2026-10-09' }, 'this pay period');
  eq(C.presetRange('lastperiod', '2026-10-08'), { from: '2026-09-12', to: '2026-09-25' }, 'last pay period');
  eq(C.presetRange('week', '2026-10-08'), { from: '2026-10-03', to: '2026-10-09' }, 'this week');
  eq(C.presetRange('lastweek', '2026-10-08'), { from: '2026-09-26', to: '2026-10-02' }, 'last week');
  eq(C.presetRange('custom', '2026-10-08'), null, 'custom has no range');
  eq(C.PRESETS.map(p => p.label), ['This pay period', 'Last pay period', 'This week', 'Last week', 'Custom'], 'labels');
});
check('presets on the first day of a period (Sat 2026-09-26) and across a year end', () => {
  eq(C.presetRange('period', '2026-09-26'), { from: '2026-09-26', to: '2026-10-09' });
  eq(C.presetRange('lastperiod', '2026-09-26'), { from: '2026-09-12', to: '2026-09-25' });
  eq(C.presetRange('week', '2026-09-26'), { from: '2026-09-26', to: '2026-10-02' });
  eq(C.presetRange('lastweek', '2026-09-26'), { from: '2026-09-19', to: '2026-09-25' });
  eq(C.presetRange('lastweek', '2027-01-01'), { from: '2026-12-19', to: '2026-12-25' });
});
check('calendar math ignores daylight saving', () => {
  eq(C.addDays('2026-03-07', 1), '2026-03-08'); eq(C.addDays('2026-03-08', 1), '2026-03-09');
  eq(C.addDays('2026-11-01', 1), '2026-11-02'); eq(C.daysBetween('2026-03-01', '2026-03-31'), 30);
  eq(C.eachDate('2026-10-30', '2026-11-03'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
});
check('custom range clamps to 93 days and swaps a backwards range', () => {
  eq(C.clampRange('2026-01-01', '2026-09-20', 93), { from: '2026-06-20', to: '2026-09-20', clamped: true });
  eq(C.clampRange('2026-10-09', '2026-09-26', 93), { from: '2026-09-26', to: '2026-10-09', clamped: false });
  ok(C.isIsoDate('2026-02-28') && !C.isIsoDate('2026-02-30') && !C.isIsoDate('10/08/26'), 'isIsoDate');
});
check('date labels', () => {
  eq(C.fmtDay('2026-10-06'), 'Tue, Oct 6'); eq(C.fmtDay('2026-10-05'), 'Mon, Oct 5');
  eq(C.fmtRange('2026-09-26', '2026-10-09'), 'Sep 26 - Oct 9, 2026');
  eq(C.fmtRange('2025-12-27', '2026-01-09'), 'Dec 27, 2025 - Jan 9, 2026');
  eq(C.fmtRange('2026-10-06', '2026-10-06'), 'Oct 6, 2026');
});

// ---------------------------------------------------------------------------------------------
// 4. clock times are Los Angeles, whatever the machine says
// ---------------------------------------------------------------------------------------------
check('times render in America/Los_Angeles (PDT and PST), never the machine zone', () => {
  eq(C.fmtTime('2026-10-06T10:32:00-07:00'), '10:32 AM');
  eq(C.fmtTime('2026-10-06T17:32:00Z'), '10:32 AM', 'UTC input');
  eq(C.fmtTime('2026-12-01T18:05:00Z'), '10:05 AM', 'winter, PST');
  eq(C.fmtTime('2026-10-06T00:05:00-07:00'), '12:05 AM');
  eq(C.fmtTime('2026-10-06T12:00:00-07:00'), '12:00 PM');
  eq(C.fmtClock('2026-10-06T13:04:00-07:00'), '1:04');
  eq(C.fmtTime(null), ''); eq(C.fmtTime('not a date'), '');
});
check('LA calendar date and "today" roll over at LA midnight', () => {
  eq(C.laDate('2026-10-07T06:30:00Z'), '2026-10-06', '11:30 PM PDT is still the 6th');
  eq(C.todayLA(new Date('2026-10-08T05:00:00Z')), '2026-10-07');
  eq(C.todayLA(new Date('2026-10-08T08:00:00Z')), '2026-10-08');
});
check('laIso builds wall-clock LA timestamps with the right offset', () => {
  eq(C.laIso('2026-10-06', 632), '2026-10-06T10:32:00-07:00');
  eq(C.laIso('2026-12-01', 605), '2026-12-01T10:05:00-08:00');
  eq(C.laIso('2026-10-06', 1439 + 59 / 60), '2026-10-06T23:59:59-07:00');
  eq(C.fmtTime(C.laIso('2026-03-09', 7 * 60)), '7:00 AM', 'day after spring forward');
});

// ---------------------------------------------------------------------------------------------
// 5. hours formatting, both modes
// ---------------------------------------------------------------------------------------------
check('hours: decimal and h:mm', () => {
  eq(C.fmtHours(512, 'dec'), '8.53'); eq(C.fmtHours(512, 'hm'), '8:32');
  eq(C.fmtHours(0, 'dec'), '0.00'); eq(C.fmtHours(0, 'hm'), '0:00');
  eq(C.fmtHours(5, 'hm'), '0:05'); eq(C.fmtHours(600, 'dec'), '10.00'); eq(C.fmtHours(1, 'dec'), '0.02');
  eq(C.fmtHours(123456, 'dec'), '2,057.60'); eq(C.fmtHours(123456, 'hm'), '2,057:36');
  eq(C.fmtHours(-30, 'dec'), '-0.50'); eq(C.fmtHours(null, 'dec'), ''); eq(C.fmtHours(undefined, 'hm'), '');
  eq(C.fmtHours(512), '8.53', 'decimal is the default');
});
check('hours: 0..5000 minutes round-trip in both modes', () => {
  for (let m = 0; m <= 5000; m++) {
    const d = C.fmtHours(m, 'dec').replace(/,/g, ''), hm = C.fmtHours(m, 'hm').replace(/,/g, '').split(':');
    ok(Math.abs(+d - m / 60) <= 0.005 + 1e-9, m + ' dec ' + d);
    ok(+hm[0] * 60 + +hm[1] === m && hm[1].length === 2, m + ' hm ' + hm.join(':'));
  }
  eq(C.hoursPlain(512), '8.53'); eq(C.hoursPlain(123456), '2057.60'); eq(C.hoursPlain(null), '');
  eq(C.fmtMins(10), '10m'); eq(C.fmtMins(105), '1h 45m'); eq(C.fmtMins(60), '1h');
});

// ---------------------------------------------------------------------------------------------
// 6. grouping, totals, filtering (synthetic rows)
// ---------------------------------------------------------------------------------------------
const W = (code, sev) => ({ code, sev: sev || 'warn', msg: 'm ' + code });
function row(o) {
  return C.normRow(Object.assign({
    id: o.company + ':' + o.uuid + ':' + o.date, region: 'CA', employee_uuid: o.uuid, employee_name: o.name,
    department: o.dept, job_title: o.job || 'Tester', work_date: o.date,
    first_in: o.date + 'T14:02:00Z', last_out: o.date + 'T22:30:00Z',
    shifts: [], span_min: 0, worked_min: o.worked ?? 480, paid_break_min: o.paid ?? 20, unpaid_break_min: o.unpaid ?? 30,
    reg_min: o.reg == null ? 480 : o.reg, ot_min: o.ot || 0, dt_min: o.dt || 0, ot_src: o.ot_src || 'gusto',
    label_src: o.label_src || 'gusto', flags: o.flags || [], open: !!o.open, hours_only: !!o.hours_only,
  }, o.extra || {}, { company: o.company }));
}
const ROWS = [
  row({ company: 'imperial', uuid: 'u5', name: 'Test Echo', dept: '', date: '2026-10-05' }),
  row({ company: 'filifera', uuid: 'u1', name: 'Test Alpha', dept: 'Trim', date: '2026-10-05', worked: 500, ot: 20, reg: 480, ot_src: 'est' }),
  row({ company: 'filifera', uuid: 'u1', name: 'Test Alpha', dept: 'Trim', date: '2026-10-06' }),
  row({ company: 'filifera', uuid: 'u2', name: 'test bravo', dept: 'Trim', date: '2026-10-06', flags: [W('type_unsure', 'info')] }),
  row({ company: 'filifera', uuid: 'u3', name: 'Test Charlie', dept: 'Distro/Trim', date: '2026-10-06', worked: 700, ot: 220, dt: 0 }),
  row({ company: 'slane', uuid: 'u4', name: 'Test Delta', dept: 'Harvest', date: '2026-10-06', flags: [W('no_meal'), W('few_rest')] }),
  row({ company: 'wafgus', uuid: 'u6', name: 'José Testa', dept: 'Operations', date: '2026-10-06', open: true, worked: 0, reg: null }),
  row({ company: 'filifera', uuid: 'u7', name: 'Test Golf', dept: 'Trim', date: '2026-10-05' }),
  row({ company: 'filifera', uuid: 'u7', name: 'Test Golf', dept: 'Packaging', date: '2026-10-07', flags: [W('late_meal')] }),
];
check('By Day: dates newest first, Company > Department > employee name', () => {
  const g = C.groupByDay(ROWS);
  eq(g.map(d => d.date), ['2026-10-07', '2026-10-06', '2026-10-05']);
  const d6 = g[1];
  eq(d6.companies.map(c => c.company), ['filifera', 'slane', 'wafgus'], 'company order');
  eq(d6.companies[0].departments.map(d => d.department), ['Distro/Trim', 'Trim'], 'departments A-Z');
  eq(d6.companies[0].departments[1].rows.map(r => r.employee_name), ['Test Alpha', 'test bravo'], 'names, case-insensitive');
  const d5 = g[2];
  eq(d5.companies.map(c => c.company), ['filifera', 'imperial']);
  eq(d5.companies[1].departments[0].department, 'No department', 'blank department becomes No department');
});
check('By Employee: Company > Department > Employee, days oldest first, a mover sits under their latest department once', () => {
  const g = C.groupByEmployee(ROWS);
  eq(g.map(c => c.company), ['filifera', 'slane', 'wafgus', 'imperial']);
  const fil = g[0];
  eq(fil.departments.map(d => d.department), ['Distro/Trim', 'Packaging', 'Trim']);
  eq(fil.departments.map(d => d.employees.map(e => e.name)), [['Test Charlie'], ['Test Golf'], ['Test Alpha', 'test bravo']]);
  eq(fil.departments[1].employees[0].rows.map(r => r.work_date), ['2026-10-05', '2026-10-07']);
  eq(fil.departments[2].employees[0].rows.map(r => r.work_date), ['2026-10-05', '2026-10-06']);
  eq(fil.departments[2].totals.rows, 3, 'department totals cover its employees\' rows');
});
check('totals: sums, distinct people, warn vs info flags, open shifts, estimated OT', () => {
  const t = C.totals(ROWS);
  eq(t.rows, 9); eq(t.people, 7);
  eq(t.worked_min, 480 * 6 + 500 + 700 + 0); eq(t.ot_min, 240); eq(t.dt_min, 0);
  eq(t.paid_break_min, 180); eq(t.unpaid_break_min, 270);
  eq(t.warn, 3); eq(t.info, 1); eq(t.flagged, 2); eq(t.open, 1); eq(t.ot_est, true);
  eq(C.totals([]).people, 0);
});
check('totals reconcile on two dimensions (by day and by company) to the grand total', () => {
  const t = C.totals(ROWS);
  const byDay = C.groupByDay(ROWS), byEmp = C.groupByEmployee(ROWS);
  for (const k of ['worked_min', 'paid_break_min', 'unpaid_break_min', 'ot_min', 'warn', 'rows']) {
    eq(byDay.reduce((a, d) => a + d.totals[k], 0), t[k], 'by day ' + k);
    eq(byEmp.reduce((a, c) => a + c.totals[k], 0), t[k], 'by company ' + k);
    eq(byDay.flatMap(d => d.companies).reduce((a, c) => a + c.departments.reduce((b, x) => b + x.totals[k], 0), 0), t[k], 'day departments ' + k);
  }
});
check('filter: company, department, search (case and accents), flagged only, dates', () => {
  const names = rs => rs.map(r => r.employee_name + '@' + r.work_date);
  eq(names(C.filterRows(ROWS, { companies: ['slane'] })), ['Test Delta@2026-10-06']);
  eq(C.filterRows(ROWS, { companies: ['slane', 'wafgus'] }).length, 2);
  eq(C.filterRows(ROWS, { companies: [] }).length, ROWS.length, 'empty selection = all');
  eq(C.filterRows(ROWS, { department: 'Trim' }).length, 4);
  eq(C.filterRows(ROWS, { department: 'No department' }).map(r => r.employee_name), ['Test Echo']);
  eq(names(C.filterRows(ROWS, { search: 'ALPHA' })), ['Test Alpha@2026-10-05', 'Test Alpha@2026-10-06']);
  eq(C.filterRows(ROWS, { search: 'jose' }).map(r => r.employee_name), ['José Testa'], 'accent-insensitive');
  eq(C.filterRows(ROWS, { search: 'test  gol' }).length, 2, 'every word must match');
  eq(C.filterRows(ROWS, { search: 'Tester' }).length, 0, 'search is by name, not job');
  eq(names(C.filterRows(ROWS, { flaggedOnly: true })).sort(), ['Test Delta@2026-10-06', 'Test Golf@2026-10-07'], 'info-only flags do not count');
  eq(C.filterRows(ROWS, { from: '2026-10-06', to: '2026-10-06' }).length, 5);
  eq(C.filterRows(ROWS, { companies: ['filifera'], department: 'Trim', search: 'golf' }).length, 1, 'filters combine');
});
check('viewer filter mirrors ts_can_view (admin, inactive, company/department wildcards)', () => {
  const v = g => ({ email: 'x@wizardtrees.com', active: true, is_admin: false, grants: g });
  eq(C.filterRows(ROWS, { viewer: v([{ company: 'filifera', department: 'Trim' }]) }).length, 4);
  eq(C.filterRows(ROWS, { viewer: v([{ company: '*', department: 'Trim' }]) }).length, 4);
  eq(C.filterRows(ROWS, { viewer: v([{ company: 'filifera', department: '*' }]) }).length, 6);
  eq(C.filterRows(ROWS, { viewer: v([{ company: '*', department: '*' }]) }).length, ROWS.length);
  eq(C.filterRows(ROWS, { viewer: v([]) }).length, 0, 'no grants sees nothing');
  eq(C.filterRows(ROWS, { viewer: { active: true, is_admin: true, grants: [] } }).length, ROWS.length, 'admin sees all');
  eq(C.filterRows(ROWS, { viewer: { active: false, is_admin: true, grants: [] } }).length, 0, 'inactive admin sees nothing');
  eq(C.filterRows(ROWS, { viewer: Object.assign(v([{ company: '*', department: '*' }]), { active: false }) }).length, 0, 'inactive manager sees nothing');
});
check('company chips: what the viewer can see, intersected with companies and people that exist', () => {
  const cos = [{ key: 'filifera', region: 'CA' }, { key: 'slane', region: 'CA' }, { key: 'wafgus', region: 'CA' }, { key: 'imperial', region: 'CA' }];
  const ppl = [{ company: 'filifera', department: 'Trim', active: true }, { company: 'imperial', department: 'Trim', active: false },
    { company: 'slane', department: 'Harvest', active: true }];
  const mgr = g => ({ active: true, is_admin: false, grants: g });
  eq(C.visibleCompanyKeys({ active: true, is_admin: true }, cos, [], 'CA', ppl), ['filifera', 'slane', 'wafgus', 'imperial'], 'admin: every company');
  eq(C.visibleCompanyKeys({ active: true, is_admin: true }, cos.slice(0, 2), [], 'CA', ppl), ['filifera', 'slane'], 'admin: only companies that exist');
  eq(C.visibleCompanyKeys(mgr([{ company: 'slane', department: '*' }]), cos, [], 'CA', ppl), ['slane']);
  eq(C.visibleCompanyKeys(mgr([{ company: 'wafgus', department: 'Operations' }]), cos, [], 'CA', []), ['wafgus'], 'a named company shows before anyone syncs');
  eq(C.visibleCompanyKeys(mgr([{ company: 'nowhere', department: '*' }]), cos, [], 'CA', ppl), [], 'a company that does not exist');
  eq(C.visibleCompanyKeys(mgr([{ company: '*', department: 'Trim' }]), cos, [], 'CA', ppl), ['filifera'], 'any company, one department: where an active person has it');
  eq(C.visibleCompanyKeys(mgr([{ company: '*', department: 'Trim' }]), cos, [ROWS[1]].map(r => Object.assign({}, r, { company: 'wafgus' })), 'CA', ppl),
    ['filifera', 'wafgus'], 'plus companies rows came back for');
  eq(C.visibleCompanyKeys(mgr([{ company: '*', department: '*' }]), cos, [], 'CA', []), ['filifera', 'slane', 'wafgus', 'imperial'], 'All CA');
  eq(C.visibleCompanyKeys(mgr([]), cos, [], 'CA', ppl), [], 'no grants');
  eq(C.visibleCompanyKeys({ active: false, is_admin: true }, cos, [], 'CA', ppl), []);
});
check('admin department pickers: departments of active people only, saved grants kept and marked', () => {
  const ppl = [
    { company: 'filifera', department: 'Trim', active: true }, { company: 'filifera', department: 'Packaging', active: true },
    { company: 'filifera', department: 'Old Crew', active: false }, { company: 'filifera', department: '', active: true },
    { company: 'filifera', department: 'Office', active: true },   // salaried people count like anyone else
    { company: 'slane', department: 'Harvest', active: true },
  ];
  eq(C.pickerDepartments(ppl, 'filifera', []), { depts: ['Office', 'Packaging', 'Trim', 'No department'], idle: [] }, 'inactive department left out');
  eq(C.pickerDepartments(ppl, 'filifera', [{ company: 'filifera', department: 'Old Crew' }, { company: 'filifera', department: '*' }, { company: 'slane', department: 'Gone' }]),
    { depts: ['Office', 'Old Crew', 'Packaging', 'Trim', 'No department'], idle: ['Old Crew'] }, 'a saved grant stays, marked idle');
  eq(C.pickerDepartments(ppl, 'imperial', []), { depts: [], idle: [] }, 'nobody synced yet');
});
check('grants: plain-words summary and normalisation', () => {
  eq(C.describeGrants([{ company: 'slane', department: '*' }, { company: 'filifera', department: 'Trim' }, { company: 'filifera', department: 'Distro/Trim' }]),
    'Filifera: Distro/Trim, Trim · Slane: all departments');
  eq(C.describeGrants([{ company: '*', department: '*' }, { company: 'slane', department: 'Harvest' }]), 'All CA');
  eq(C.describeGrants([]), 'Nothing yet');
  eq(C.describeGrants([{ company: '*', department: 'Trim' }]), 'Any company: Trim');
  eq(C.normalizeGrants([{ company: 'slane', department: 'Harvest' }, { company: 'slane', department: '*' }, { company: 'filifera', department: 'Trim' }, { company: 'filifera', department: 'Trim' }, { company: ' ', department: 'x' }]),
    [{ company: 'filifera', department: 'Trim' }, { company: 'slane', department: '*' }]);
  eq(C.grantFromKey(C.grantKey('filifera', 'Distro/Trim')), { company: 'filifera', department: 'Distro/Trim' });
});

// ---------------------------------------------------------------------------------------------
// 7. flags and breaks
// ---------------------------------------------------------------------------------------------
const SPEC_FLAGS = ['no_meal', 'late_meal', 'short_meal', 'no_second_meal', 'few_rest', 'short_rest', 'break_open', 'missed_out', 'long_day', 'type_unsure', 'gusto_mismatch'];
check('flag codes match the spec exactly; labels and messages exist; type_unsure is info', () => {
  eq([...C.FLAG_CODES].sort(), [...SPEC_FLAGS].sort());
  for (const c of SPEC_FLAGS) ok(C.flagLabel({ code: c }) && C.flagMsg({ code: c }), c);
  eq(C.flagSev({ code: 'type_unsure' }), 'info'); eq(C.flagSev({ code: 'no_meal' }), 'warn');
  eq(C.flagMsg({ code: 'few_rest', msg: '1 rest break, 2 expected for 8.00 h' }), '1 rest break, 2 expected for 8.00 h', 'producer msg wins');
  eq(C.flagLabel({ code: 'brand_new_code' }), 'brand new code', 'unknown codes still render');
  eq(C.sortFlags([W('type_unsure', 'info'), W('gusto_mismatch'), W('no_meal')]).map(f => f.code), ['no_meal', 'gusto_mismatch', 'type_unsure']);
});
check('gaps between shifts (off the clock) are measured', () => {
  const s = [{ in: '2026-10-06T10:00:00-07:00', out: '2026-10-06T13:30:00-07:00' }, { in: '2026-10-06T14:15:00-07:00', out: '2026-10-06T18:00:00-07:00' }];
  eq(C.shiftGaps(s).map(g => g.min), [45]);
  eq(C.shiftGaps(s)[0].meal, true, '45 min counts as a meal period');
  eq(C.shiftGaps([s[0], { in: s[1].in, out: null }]).length, 1, 'gap before an open shift still counts');
  eq(C.shiftGaps([{ in: s[0].in, out: null }, s[1]]).length, 0, 'no gap after an open shift');
});
check("gap minutes use Gusto's (and the producer's) truncated minutes, so the chip agrees with no_meal", () => {
  // 11:59:10 to 12:28:50 is 29 min 40 s: Gusto and the producer count 29 (no meal), rounding would say 30
  const g = C.shiftGaps([{ in: '2026-10-06T07:00:00-07:00', out: '2026-10-06T11:59:10-07:00' }, { in: '2026-10-06T12:28:50-07:00', out: '2026-10-06T16:00:00-07:00' }]);
  eq(g.map(x => [x.min, x.meal]), [[29, false]]);
  const g2 = C.shiftGaps([{ in: '2026-10-06T07:00:00-07:00', out: '2026-10-06T11:59:50-07:00' }, { in: '2026-10-06T12:29:05-07:00', out: '2026-10-06T16:00:00-07:00' }]);
  eq(g2.map(x => [x.min, x.meal]), [[30, true]], '11:59:50 to 12:29:05 is 30 in Gusto minutes');
  eq(C.gustoMinute('2026-10-06T23:59:59-07:00') - C.gustoMinute('2026-10-06T23:00:00-07:00'), 60, '11:59:59 PM counts as midnight');
  eq(C.gustoMinute('2026-10-06T10:32:59-07:00') - C.gustoMinute('2026-10-06T10:32:00-07:00'), 0, 'seconds are dropped');
  ok(isNaN(C.gustoMinute(null)) && isNaN(C.gustoMinute('nope')), 'bad input is NaN');
  eq(C.shiftGaps([{ in: '2026-10-06T07:00:00-07:00', out: '2026-10-06T12:00:20-07:00' }, { in: '2026-10-06T12:00:40-07:00', out: '2026-10-06T16:00:00-07:00' }]).length, 0, 'a same-minute re-punch is no gap');
});
check('hours-entered days never carry long_day; other flags and other days keep theirs', () => {
  const he = C.normRow({ id: 'x', company: 'imperial', employee_uuid: 'h1', work_date: '2026-10-05', hours_only: true,
    flags: [{ code: 'long_day', sev: 'warn', msg: 'm' }, { code: 'gusto_mismatch', sev: 'warn', msg: 'm' }] });
  eq(he.flags.map(f => f.code), ['gusto_mismatch']);
  const clocked = C.normRow({ id: 'y', company: 'imperial', employee_uuid: 'h2', work_date: '2026-10-05', hours_only: false, flags: [{ code: 'long_day', sev: 'warn', msg: 'm' }] });
  eq(clocked.flags.map(f => f.code), ['long_day']);
  ok(D.build('2026-10-08T18:30:00Z').rows.filter(r => r.hours_only).every(r => !r.flags.some(f => f.code === 'long_day')), 'demo hours-entered days');
});
check('Custom date fields: half-typed years are ignored and the fields are never overwritten while Custom is on', () => {
  const app = block('ts-app');
  const fn = name => {   // one function's source: a one-liner, or up to its closing brace at two-space indent
    const m = app.match(new RegExp('function ' + name + '\\([^)]*\\) \\{(?:[^\\n]*\\}\\n|[\\s\\S]*?\\n  \\})'));
    ok(m, 'no ' + name + '()'); return m[0];
  };
  const apply = fn('applyCustom');
  ok(/inCustomWindow\(a\)/.test(apply) && /inCustomWindow\(b\)/.test(apply), 'applyCustom must check both dates against the window');
  ok(!/\.value\s*=[^=]/.test(apply), 'applyCustom writes into a date field');
  ok(/CUSTOM_MIN = '20[2-9]\d-01-01'/.test(app) && /s >= CUSTOM_MIN/.test(fn('inCustomWindow')), 'a year floor, so 0202-09-26 from a half-typed 2025 is ignored');
  ok(/if \(!custom\) \{ \$\('fromIn'\)\.value = S\.from; \$\('toIn'\)\.value = S\.to; \}/.test(fn('renderControls')), 'renderControls may only fill the fields when Custom is off');
  ok(/addEventListener\('change', onCustomChange\)/.test(app) && /setTimeout\(applyCustom, \d{3}\)/.test(fn('onCustomChange')), "'change' settles before loading");
  // Chrome's keystroke-by-keystroke values for typing 2025 into the year: none may load
  for (const s of ['0002-09-26', '0020-09-26', '0202-09-26']) ok(!(C.isIsoDate(s) && s >= '2020-01-01'), s + ' would load');
});
check('presets roll over in a tab left open (reload and the visibility / minute checks re-read today)', () => {
  const app = block('ts-app');
  ok(/async function reload\(quiet\) \{\s*rollPreset\(\);/.test(app), 'reload() must start by moving the preset to today');
  ok(/function rolledPreset\(\) \{[\s\S]*?C\.presetRange\(S\.preset, today\(\)\)/.test(app), 'rolledPreset() recomputes from today()');
  ok(/visibilitychange[\s\S]{0,300}rolledPreset\(\)/.test(app), 'coming back to the tab checks for a rolled preset');
  ok(/setInterval\(\(\) => \{[\s\S]{0,200}rolledPreset\(\)/.test(app), 'a tab kept on screen checks too');
  eq(C.presetRange('period', '2026-10-10'), { from: '2026-10-10', to: '2026-10-23' }, 'Sat Oct 10 is the next period');
  eq(C.presetRange('week', '2026-10-10'), { from: '2026-10-10', to: '2026-10-16' }, 'and the next week');
});
check('freshness strip text', () => {
  const now = new Date('2026-10-08T18:00:00Z');   // 11:00 AM PDT
  eq(C.freshness({ key: 'imperial', connected: false }, now).sync, 'Not connected yet');
  eq(C.freshness({ key: 'filifera', connected: true, last_sync_at: '2026-10-08T17:20:00Z' }, now).sync, 'Synced 10:20 AM');
  eq(C.freshness({ key: 'filifera', connected: true, last_sync_at: '2026-10-08T04:20:00Z' }, now).sync, 'Synced yesterday, 9:20 PM');
  eq(C.freshness({ key: 'filifera', connected: true, last_sync_at: '2026-10-06T04:20:00Z' }, now).sync, 'Synced Oct 5, 9:20 PM');
  eq(C.freshness({ key: 'filifera', connected: true, last_sync_at: '2026-10-08T17:20:00Z', label_csv_at: '2026-10-08T09:10:00Z' }, now).labels, 'Break labels from Gusto through Oct 7');
  eq(C.freshness({ key: 'slane', connected: true, last_sync_at: '2026-10-08T17:20:00Z', label_csv_at: null }, now).labels, 'Break types estimated from length');
  eq(C.freshness({ key: 'slane', connected: true, last_sync_at: '2026-10-08T13:20:00Z' }, now).stale, true, 'over 3 h is stale');
});

// ---------------------------------------------------------------------------------------------
// 8. CSV
// ---------------------------------------------------------------------------------------------
function parseCsv(text) {        // RFC 4180, for checking our own output round-trips
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
check('CSV header is exactly the spec column list', () => {
  const head = C.buildCsv([]).split('\r\n')[0];
  eq(head, 'Date,Company,Department,Employee,Job,First in,Last out,Paid break min,Unpaid break min,Hours worked,Regular,OT,DT,OT source,Break labels,Flags');
  eq(C.csvFilename('2026-09-26', '2026-10-09'), 'timesheets-2026-09-26-to-2026-10-09.csv');
});
check('CSV quoting: commas, quotes, newlines; formula guard; CRLF lines', () => {
  eq(C.csvCell('Smith, Jr. "Bud"'), '"Smith, Jr. ""Bud"""');
  eq(C.csvCell('Trim\nLead'), '"Trim\nLead"');
  eq(C.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  eq(C.csvCell('+1'), "'+1"); eq(C.csvCell('@x'), "'@x"); eq(C.csvCell(12), '12'); eq(C.csvCell(null), '');
  const r = row({ company: 'filifera', uuid: 'q1', name: 'Smith, Jr. "Bud"', dept: 'Trim, Night', job: 'Line 1\nLine 2', date: '2026-10-06',
    flags: [{ code: 'few_rest', sev: 'warn', msg: '1 rest break, 2 expected for 8.00 h' }, W('type_unsure', 'info')] });
  const text = C.buildCsv([r]);
  ok(text.endsWith('\r\n') && text.split('\r\n').length === 3, 'two CRLF-terminated lines');
  const parsed = parseCsv(text);
  eq(parsed.length, 2, 'one header + one row after parsing');
  const rec = Object.fromEntries(parsed[0].map((h, i) => [h, parsed[1][i]]));
  eq(rec.Employee, 'Smith, Jr. "Bud"'); eq(rec.Department, 'Trim, Night'); eq(rec.Job, 'Line 1\nLine 2');
  eq(rec.Flags, '1 rest break, 2 expected for 8.00 h; m type_unsure');
});
check('CSV values: LA times, decimal hours, OT source, labels, open and hours-entered days', () => {
  const rows = [
    row({ company: 'slane', uuid: 'c1', name: 'Test Csv', dept: 'Harvest', date: '2026-10-06', worked: 512, paid: 20, unpaid: 31, reg: 480, ot: 32, ot_src: 'est', label_src: 'rule' }),
    row({ company: 'wafgus', uuid: 'c2', name: 'Test Open', dept: 'Operations', date: '2026-10-06', worked: 0, reg: null, open: true, extra: { last_out: null, ot_src: null, reg_min: null, ot_min: null, dt_min: null, label_src: 'none' } }),
    row({ company: 'imperial', uuid: 'c3', name: 'Test Entered', dept: '', date: '2026-10-05', worked: 360, paid: 0, unpaid: 0, hours_only: true,
      extra: { shifts: [{ id: 's', in: '2026-10-05T15:00:00Z', out: '2026-10-06T06:59:59Z', hours_only: true, breaks: [] }], label_src: 'none' } }),
  ];
  const p = parseCsv(C.buildCsv(rows, { companyName: k => ({ slane: 'Slane', wafgus: 'Waf & Gus', imperial: 'Imperial' }[k]) }));
  const H = p[0], rec = i => Object.fromEntries(H.map((h, j) => [h, p[i][j]]));
  const a = rec(2), b = rec(3), c = rec(1);         // sorted by date, then company order
  eq([c.Date, a.Date, b.Date], ['2026-10-05', '2026-10-06', '2026-10-06'], 'date sort');
  eq([a.Company, a['First in'], a['Last out'], a['Hours worked'], a.Regular, a.OT, a.DT, a['OT source'], a['Break labels'], a['Paid break min'], a['Unpaid break min']],
     ['Slane', '7:02 AM', '3:30 PM', '8.53', '8.00', '0.53', '0.00', 'Estimated', 'Estimated from length', '20', '31']);
  eq([b.Company, b['Last out'], b['Hours worked'], b.Regular, b['OT source']], ['Waf & Gus', 'clocked in', '0.00', '', '']);
  eq([c.Department, c['First in'], c['Last out'], c['Hours worked']], ['No department', 'hours entered', '', '6.00']);
});

// ---------------------------------------------------------------------------------------------
// 9. HTML escaping
// ---------------------------------------------------------------------------------------------
check('esc() and h`` escape every data value, once', () => {
  eq(C.esc(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  const evil = '"><img src=x onerror=alert(1)>';
  const out = C.h`<td title="${evil}">${evil}</td>`;
  ok(out instanceof C.SafeHTML, 'h returns SafeHTML');
  eq(out.html, '<td title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</td>');
  eq(C.h`<p>${C.h`<b>${'a&b'}</b>`}</p>`.html, '<p><b>a&amp;b</b></p>', 'nested h`` is not double-escaped');
  eq(C.h`<ul>${['<1>', C.h`<li>2</li>`]}</ul>`.html, '<ul>&lt;1&gt;<li>2</li></ul>', 'arrays');
  eq(C.h`${null}${undefined}${false}${0}`.html, '0', 'null/undefined/false render nothing, 0 renders');
  eq(C.h`<i>${{ html: '<b>' }}</i>`.html, '<i>[object Object]</i>', 'look-alike objects are not trusted');
});

// ---------------------------------------------------------------------------------------------
// 10. demo data: synthetic, complete, and shaped like ts_days
// ---------------------------------------------------------------------------------------------
const NOW = '2026-10-08T18:30:00Z';      // Thu 11:30 AM PDT
const demo = D.build(NOW);
const DAY_COLS = ['id', 'company', 'region', 'employee_uuid', 'employee_name', 'department', 'job_title', 'work_date', 'first_in', 'last_out',
  'shifts', 'span_min', 'worked_min', 'paid_break_min', 'unpaid_break_min', 'reg_min', 'ot_min', 'dt_min', 'ot_src', 'label_src',
  'gusto_total_min', 'approval', 'note', 'flags', 'open', 'hours_only', 'synced_at'];
check('demo names: every row and person is on the synthetic list, and the list is obviously made up', () => {
  const NAMES = [...D.NAMES];
  ok(NAMES.length >= 30 && new Set(NAMES).size === NAMES.length, 'need 30+ unique names');
  ok(NAMES.every(n => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(n)), 'names are "First Last"');
  const set = new Set(NAMES);
  const strays = [...new Set(demo.rows.map(r => r.employee_name).concat(demo.people.map(p => p.name)))].filter(n => !set.has(n));
  ok(!strays.length, 'names not on the list: ' + J(strays));
  ok(demo.access.every(a => /@wizardtrees\.com$/.test(a.email) && !/gianni|kelsey|scott/i.test(a.email)), 'demo sign-ins are made up');
  ok(demo.rows.every(r => /^demo-/.test(r.employee_uuid)), 'demo uuids are demo-*');
});
check('demo names do not match anyone in the local Gusto exports (if present; names never printed)', () => {
  const dir = path.join(os.homedir(), 'gusto-sync');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^latest-.*\.csv$/.test(f)); } catch { /* not on this machine */ }
  if (!files.length) { console.log('          (skipped: no ~/gusto-sync/latest-*.csv here)'); return true; }
  const key = s => s.toLowerCase().split(/[\s,]+/).filter(Boolean).sort().join(' ');
  const real = new Set(), realLast = new Set();
  for (const f of files) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of t.matchAll(/Hours for ([^,\r\n"]+),\s*([^"\r\n]+)/g)) { real.add(key(m[1] + ' ' + m[2])); realLast.add(m[1].trim().toLowerCase()); }
  }
  const hits = D.NAMES.filter(n => real.has(key(n)) || realLast.has(n.split(' ')[1].toLowerCase()));
  console.log(`          (compared ${D.NAMES.length} demo names with ${real.size} names in ${files.length} local export(s))`);
  ok(!hits.length, 'demo names that collide with a real export: ' + J(hits));
});
check('demo covers all four companies, several departments, every flag, both label sources, open + hours-entered days, OT est + Gusto', () => {
  eq([...new Set(demo.rows.map(r => r.company))].sort(), ['filifera', 'imperial', 'slane', 'wafgus']);
  ok(new Set(demo.rows.map(r => r.company + '/' + r.department)).size >= 8, 'want 8+ departments');
  ok(demo.rows.some(r => r.department === 'No department'), 'a No department row');
  const codes = new Set(demo.rows.flatMap(r => r.flags.map(f => f.code)));
  const missing = SPEC_FLAGS.filter(c => !codes.has(c));
  ok(!missing.length, 'flags never shown: ' + J(missing));
  const ls = new Set(demo.rows.map(r => r.label_src));
  ok(ls.has('gusto') && ls.has('rule') && ls.has('mixed'), 'label sources ' + J([...ls]));
  ok(demo.rows.some(r => r.open && r.work_date < demo.today), 'an open shift from a previous day');
  ok(demo.rows.some(r => r.hours_only), 'an hours-entered day');
  ok(demo.rows.some(r => r.ot_src === 'est' && r.ot_min > 0) && demo.rows.some(r => r.ot_src === 'gusto' && r.ot_min > 0), 'OT est and Gusto');
  ok(demo.rows.some(r => r.dt_min > 0), 'some double time');
  ok(demo.rows.some(r => r.note && /[",]/.test(r.note)), 'a note with quotes/commas');
  ok(demo.rows.some(r => r.shifts.length > 1), 'a split shift');
});
check('demo flags show up on any weekday it is opened (scenarios follow "now")', () => {
  for (let i = 0; i < 7; i++) {
    const d = D.build(Date.parse(NOW) + i * 86400000);
    const codes = new Set(d.rows.flatMap(r => r.flags.map(f => f.code)));
    const missing = SPEC_FLAGS.filter(c => !codes.has(c));
    ok(!missing.length, d.today + ' missing ' + J(missing));
  }
  ok(D.build('2026-10-08T09:00:00Z').rows.length > 0, '2 AM build works');
});
check('demo rows have exactly the ts_days shape, shifts and breaks shapes', () => {
  for (const r of demo.rows) {
    eq(Object.keys(r).sort(), [...DAY_COLS].sort(), 'columns of ' + r.id);
    ok(r.id === r.company + ':' + r.employee_uuid + ':' + r.work_date, 'id ' + r.id);
    ok(['gusto', 'rule', 'mixed', 'none'].includes(r.label_src), 'label_src');
    ok(r.ot_src == null || r.ot_src === 'gusto' || r.ot_src === 'est', 'ot_src');
    for (const f of r.flags) ok(SPEC_FLAGS.includes(f.code) && (f.sev === 'warn' || f.sev === 'info') && f.msg, 'flag ' + J(f));
    for (const s of r.shifts) {
      eq(Object.keys(s).sort(), ['breaks', 'hours_only', 'id', 'in', 'out', 'span_min', 'worked_min'], 'shift keys');
      for (const b of s.breaks) {
        eq(Object.keys(b).sort(), ['end', 'kind', 'min', 'open', 'paid', 'src', 'start'], 'break keys');
        ok((b.kind === 'rest' || b.kind === 'meal') && b.paid === (b.kind === 'rest') && (b.src === 'gusto' || b.src === 'rule'), 'break ' + J(b));
        if (b.src === 'rule') ok(b.kind === (b.min <= 20 ? 'rest' : 'meal'), 'length rule ' + J(b));
      }
    }
  }
});
check('demo arithmetic holds: worked = span - unpaid, break totals, CA OT split, Gusto labels only before the CSV day', () => {
  for (const r of demo.rows) {
    const closed = r.shifts.filter(s => s.out && !s.hours_only);
    for (const s of closed) eq(s.worked_min, s.span_min - s.breaks.filter(b => !b.paid).reduce((a, b) => a + b.min, 0), 'shift ' + s.id);
    eq(r.worked_min, r.shifts.reduce((a, s) => a + s.worked_min, 0), 'day worked ' + r.id);
    eq(r.paid_break_min, r.shifts.flatMap(s => s.breaks).filter(b => b.paid).reduce((a, b) => a + b.min, 0), 'paid ' + r.id);
    eq(r.unpaid_break_min, r.shifts.flatMap(s => s.breaks).filter(b => !b.paid).reduce((a, b) => a + b.min, 0), 'unpaid ' + r.id);
    if (r.reg_min != null) eq(r.reg_min + r.ot_min + r.dt_min, r.worked_min, 'reg+ot+dt ' + r.id);
    if (r.flags.some(f => f.code === 'gusto_mismatch')) ok(Math.abs(r.gusto_total_min - r.worked_min) > 1, 'mismatch is real');
    if (r.work_date >= demo.today) ok(r.shifts.every(s => s.breaks.every(b => b.src === 'rule')), 'today has no Gusto labels yet');
    ok(r.work_date <= demo.today, 'no future rows');
  }
});
check('demo runs through the page pipeline (filter, both groupings, CSV) and totals agree', () => {
  const t = C.totals(demo.rows);
  const day = C.groupByDay(demo.rows), emp = C.groupByEmployee(demo.rows);
  eq(day.reduce((a, d) => a + d.totals.worked_min, 0), t.worked_min);
  eq(emp.reduce((a, c) => a + c.departments.reduce((b, d) => b + d.employees.reduce((x, e) => x + e.totals.worked_min, 0), 0), 0), t.worked_min);
  eq(emp.reduce((a, c) => a + c.departments.reduce((b, d) => b + d.employees.length, 0), 0), t.people, 'one card per person');
  eq(parseCsv(C.buildCsv(demo.rows)).length - 1, demo.rows.length, 'one CSV line per employee-day');
  const p = C.presetRange('period', demo.today);
  ok(C.filterRows(demo.rows, p).length > 0 && C.filterRows(demo.rows, C.presetRange('lastperiod', demo.today)).length > 0, 'presets have data');
});

console.log(bad ? `\n✗ ${bad} of ${count} check(s) failed, do not push` : `\n✓ all ${count} checks passed`);
process.exit(bad ? 1 : 0);
