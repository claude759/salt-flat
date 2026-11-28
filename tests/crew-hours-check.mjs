// Check for the Crew hours page (crew-hours.html), its email schedule (supabase/functions/crew-hours-notify) and its
// SQL (supabase/crew-hours.sql). Run: node tests/crew-hours-check.mjs  (exit 0 = safe to push)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'crew-hours.html'), 'utf8');
const sql = fs.readFileSync(path.join(ROOT, 'supabase/crew-hours.sql'), 'utf8');
let failed = 0, passed = 0;
function check(name, fn){
  try { const r = fn(); if (r === false) throw new Error('returned false'); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message || e)); }
}
const ok = (c, msg) => { if (!c) throw new Error(msg); };
const eq = (a, b, msg) => { const A = JSON.stringify(a), B = JSON.stringify(b); if (A !== B) throw new Error(msg + ': got ' + A + ', want ' + B); };

check('page is whole and its script parses', () => {
  ok(src.trimEnd().endsWith('</html>'), 'does not end with </html>');
  const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  ok(scripts.length === 1, 'expected one inline script, found ' + scripts.length);
  const tmp = path.join(ROOT, 'tests', '.crew-hours-script.tmp.js');
  fs.writeFileSync(tmp, scripts[0]);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  finally { fs.unlinkSync(tmp); }
});
check('every pick-list is typable (no <select>), no em dashes, no pay on the page', () => {
  ok(!/<select/i.test(src), 'a <select> is on the page (Gianni: every pick-list is typable)');
  ok(!/—|&mdash;/.test(src), 'an em dash is on the page');
  ok(!/\.total\b|rate \* |toFixed\(2\)|\$\{?money/.test(src.replace(/rate: p\.default_rate[^,]*,/, '')), 'the page shows pay (it is hours only, like the Timesheet app)');
  for (const id of ['siteIn', 'periodIn']) ok(new RegExp(`id="${id}" list="`).test(src), id + ' should be an input with a datalist');
});

const model = src.match(/\/\* CREW MODEL[^\n]*\n([\s\S]*?)\/\* END CREW MODEL \*\//);
const ctx = {}; vm.createContext(ctx);
vm.runInContext(model[1] + '\nthis.CM = CM;', ctx);
const CM = ctx.CM;

check('pay periods: 14 days from Sat 2026-07-04, labels, the period a page opens on, when Submit opens', () => {
  eq(CM.periodStart('2026-11-24'), '2026-11-21', 'periodStart');
  eq(CM.periodStart('2026-11-21'), '2026-11-21', 'first day');
  eq(CM.periodStart('2026-11-20'), '2026-11-07', 'last day of the one before');
  eq(CM.periodEnd('2026-11-21'), '2026-12-04', 'periodEnd');
  eq(CM.periodLabel('2026-11-21'), 'Nov 21 to Dec 4', 'periodLabel');
  eq(CM.dayLabel('2026-12-05'), 'Sat Dec 5', 'dayLabel');
  eq(CM.periodChoices('2026-11-24', 2), ['2026-11-21', '2026-11-07', '2026-10-24'], 'periodChoices');
  eq(CM.defaultPeriod('2026-12-05', {}), '2026-11-21', 'Saturday after the end opens the period just ended');
  eq(CM.defaultPeriod('2026-12-07', {}), '2026-11-21', 'through Monday');
  eq(CM.defaultPeriod('2026-12-08', {}), '2026-12-05', 'then the new one');
  eq(CM.defaultPeriod('2026-12-05', { '2026-11-21': { status: 'submitted' } }), '2026-12-05', 'once submitted, the new one');
  ok(CM.canSubmit('2026-11-21', '2026-12-04') && !CM.canSubmit('2026-11-21', '2026-12-03'), 'Submit opens on the last day');
});
check('times and hours match the database trigger (overnight-safe, lunch taken off, never negative)', () => {
  eq(CM.hours({ clock_in: '08:00', clock_out: '12:30', break_minutes: 0 }), 4.5, '8 to 12:30');
  eq(CM.hours({ clock_in: '07:00', clock_out: '17:55', break_minutes: 30 }), 10.417, 'with lunch');
  eq(CM.hours({ clock_in: '22:00', clock_out: '02:00', break_minutes: 0 }), 4, 'overnight');
  eq(CM.hours({ clock_in: '08:00', clock_out: '08:30', break_minutes: 60 }), 0, 'never negative');
  eq(CM.fmtTime('13:05:00'), '1:05 pm', 'fmtTime');
  eq(CM.fmtTime('08:00'), '8 am', 'fmtTime on the hour');
});
const roster = [
  { id: 'a', last: 'Parra', first: 'Tany', team: "Norma's Team", aliases: ['Tani', 'Tony', 'Santana Parra Villa'], gusto_distro: true, gusto_distro_from: '2026-10-28' },
  { id: 'b', last: 'Hernandez', first: 'Delio', team: "Norma's Team", aliases: null },
  { id: 'c', last: 'Perez', first: 'Ritzy', team: "Norma's Team", aliases: null },
  { id: 'd', last: 'Gomez', first: 'Brenda', team: "Norma's Team", aliases: ['Gomec'] },
  { id: 'e', last: 'Nguyen', first: 'Thanh', team: "Justin's Team", aliases: null, gusto_distro: true },
];
check("names land on the same person as the tracker's rosterMatch, typed either way round", () => {
  eq(CM.rosterMatch(roster, 'Parra', 'Tani').id, 'a', 'alias first name with the same last name');
  eq(CM.rosterMatch(roster, 'Hernandez', 'Delio').id, 'b', 'exact');
  eq(CM.rosterMatch(roster, 'Gomec', 'Brenda').id, 'd', 'alias last name');
  eq(CM.rosterMatch(roster, 'Perez', 'Ricky'), null, 'no guessing');
  eq(CM.matchTyped(roster, 'Delio Hernandez').id, 'b', 'First Last');
  eq(CM.matchTyped(roster, 'hernandez delio').id, 'b', 'Last First, any case');
  eq(CM.matchTyped(roster, 'Tani Parra').id, 'a', 'alias');
});
check("Gusto people: by the roster's Gusto date, or by their Gusto name on the day (aliases, first + last), never by a shared last name alone", () => {
  ok(CM.isGustoPerson(roster[0], '2026-11-24') && !CM.isGustoPerson(roster[0], '2026-10-27'), 'Tany is on Gusto from 10/28');
  const day = [{ name: 'Santana Parra Villa', shifts: [{ in: '07:53', out: '12:40' }] }, { name: 'Wendy Hernandez Martinez', shifts: [] }, { name: 'Albert Perez', shifts: [] }];
  eq(CM.gustoFor(day, roster[0]).map(g => g.name), ['Santana Parra Villa'], 'alias');
  eq(CM.gustoFor(day, roster[1]).length, 0, 'Delio is not Wendy Hernandez Martinez');
  eq(CM.gustoFor(day, roster[2]).length, 0, 'Ritzy is not Albert Perez');
  eq(CM.gustoFor([{ name: 'Delio Hernandez', shifts: [] }], roster[1]).length, 1, 'first + last');
});
check('what stops a line and what only warns', () => {
  const base = { day: '2026-11-24', today: '2026-11-28', gusto: [], existing: [], others: [] };
  const L = o => Object.assign({ include: true, name: 'Delio Hernandez', person: roster[1], clock_in: '08:00', clock_out: '12:30', break_minutes: 0 }, o);
  const stops = (l, c) => CM.lineIssues(l, Object.assign({}, base, c)).filter(x => x.level === 'stop').map(x => x.text);
  const warns = (l, c) => CM.lineIssues(l, Object.assign({}, base, c)).filter(x => x.level === 'warn').map(x => x.text);
  eq(stops(L({})), [], 'a clean line');
  ok(stops(L({ clock_out: '' })).some(t => /No time out/.test(t)), 'no time out');
  ok(stops(L({ break_minutes: null })).some(t => /Lunch couldn/.test(t)), 'an unreadable lunch is never saved as 0');
  ok(stops(L({ person: null, name: 'Luis Albarenga' })).some(t => /Not on the roster/.test(t)), 'unknown name');
  eq(stops(L({ person: null, name: 'Luis Albarenga', newPerson: true, last: 'Albarenga', first: 'Luis' })), [], 'unless ticked New person');
  ok(stops(L({ person: roster[0], name: 'Tany Parra' })).some(t => /On Gusto since Oct 28/.test(t)), "a Gusto person's day isn't crew pay");
  ok(stops(L({}), { gusto: [{ name: 'Delio Hernandez', shifts: [{ in: '08:03', out: '12:02' }] }] }).some(t => /In Gusto that day as Delio Hernandez \(8:03 am to 12:02 pm\)/.test(t)), 'in Gusto that day');
  ok(stops(L({}), { existing: [{ roster_id: 'b', clock_in: '07:00:00', clock_out: '09:00:00', company: 'Imperial' }] }).some(t => /Already on the board 7 am to 9 am at Imperial/.test(t)), 'overlaps a saved row');
  eq(stops(L({}), { existing: [{ roster_id: 'b', clock_in: '13:00:00', clock_out: '17:20:00', company: 'Slane' }] }), [], 'the afternoon at another site is fine');
  const a = L({}), b = L({ clock_in: '09:00' });
  ok(stops(a, { others: [a, b] }).some(t => /twice/.test(t)), 'twice on the sheet');
  ok(stops(L({}), { day: '2026-11-29' }).some(t => /hasn/.test(t)), 'a future day');
  ok(warns(L({ clock_in: '07:00', clock_out: '17:55' })).some(t => /no lunch/.test(t)), 'over 6 hours with no lunch');
  ok(warns(L({ clock_in: '05:00', clock_out: '18:00', break_minutes: 30 })).some(t => /Over 12/.test(t)), 'over 12 hours');
});
check("crew rows are the tracker's Norma's Team crew pay, the same rule as crew-hours.sql's crew_row_is_crew", () => {
  const r = o => Object.assign({ team: "Norma's Team", category: 'harvest', work_date: '2026-11-24', roster_id: 'b' }, o);
  ok(CM.isCrewRow(r({}), roster), 'a sheet harvest row');
  ok(!CM.isCrewRow(r({ source_id: 'gusto-filifera-hv:x' }), roster), 'a Gusto harvest import');
  ok(!CM.isCrewRow(r({ team: 'Gusto Team' }), roster), 'Gusto Team');
  ok(!CM.isCrewRow(r({ category: 'distro', roster_id: 'a' }), roster), "a Gusto person's distro day");
  ok(CM.isCrewRow(r({ category: 'distro', roster_id: 'a', work_date: '2026-10-27' }), roster), 'before Gusto');
  ok(CM.isCrewRow(r({ category: 'distro', roster_id: 'a', note: 'x [crew pay]' }), roster), '[crew pay]');
  ok(!CM.isCrewRow(r({ team: "Justin's Team", category: 'distro', roster_id: 'e' }), roster), "Justin's Team");
  eq(CM.rowPeriod({ work_date: '2026-11-19', pay_period: '2026-11-21' }), '2026-11-21', 'a missed day pays with its pay_period');
  for (const t of [/ilike 'norma%'/, /!~ '\^gusto-'/, /!~\* 'gusto'/, /= 'harvest'/, /\\\[crew pay\\\]/, /gusto_distro_from is null or r\.work_date >= e\.gusto_distro_from/])
    ok(t.test(sql), 'crew-hours.sql crew_row_is_crew lost ' + t);
});
check('pickFrom: the exact entry in any case, else the one entry that holds the text', () => {
  const list = ['25th St (Filifera)', '23rd St (Slane)', '25th St distro (packing)'];
  eq(CM.pickFrom(list, '23rd'), '23rd St (Slane)', 'one hit');
  eq(CM.pickFrom(list, '25th'), null, 'two hits: refused');
  eq(CM.pickFrom(list, '25TH ST (FILIFERA)'), '25th St (Filifera)', 'exact, any case');
  eq(CM.pickFrom(list, 'Olympic'), null, 'none');
});
check('the SQL: approver-only reopen and approve, Diana and Gianni seeded, the lock trigger, the half-hour reminder job, no secret in the file', () => {
  ok(/create trigger crew_lock_guard before insert or update or delete on public\.distro_shifts/.test(sql), 'lock trigger');
  ok(/'diana@wizardtrees\.com',\s*true, false/.test(sql) && /'gianni@wizardtrees\.com', true, true/.test(sql), 'Diana enters, Gianni approves');
  ok(/only Gianni approves/.test(sql) && /only Gianni reopens/.test(sql), 'approve and reopen are the approver\'s');
  ok(/cron\.schedule\('crew-hours-reminders', '0,30 \* \* \* \*'/.test(sql), 'the reminder job runs every half hour');
  ok(/gen_random_bytes/.test(sql) && !/[0-9a-f]{40,}/.test(sql), 'the secret is made in the database, never written here');
  ok(!/drop table|truncate/i.test(sql), 'the SQL runner refuses drops');
});
const sched = await import(pathToFileURL(path.join(ROOT, 'supabase/functions/crew-hours-notify/schedule.js')).href);
check('reminders: Friday from 6:30 pm, Saturday and Sunday from 11 am, Los Angeles time across daylight saving', () => {
  eq(sched.dueReminder('2026-12-04', 18 * 60 + 29), null, 'Friday 6:29 pm');
  eq(sched.dueReminder('2026-12-04', 18 * 60 + 30), { kind: 'friday', period: '2026-11-21' }, 'Friday 6:30 pm');
  eq(sched.dueReminder('2026-12-05', 10 * 60 + 59), null, 'Saturday 10:59 am');
  eq(sched.dueReminder('2026-12-05', 11 * 60), { kind: 'saturday', period: '2026-11-21' }, 'Saturday 11 am');
  eq(sched.dueReminder('2026-12-06', 11 * 60 + 30), { kind: 'sunday', period: '2026-11-21' }, 'Sunday');
  eq(sched.dueReminder('2026-12-07', 12 * 60), null, 'Monday: nothing');
  eq(sched.dueReminder('2026-11-28', 18 * 60 + 30), null, 'a mid-period Saturday');
  eq(sched.laNow(new Date('2026-12-05T02:30:00Z')), { date: '2026-12-04', mins: 18 * 60 + 30 }, 'winter: UTC-8');
  eq(sched.laNow(new Date('2026-07-17T01:30:00Z')), { date: '2026-07-16', mins: 18 * 60 + 30 }, 'summer: UTC-7');
  eq(sched.periodLabel('2026-11-21'), 'Nov 21 - Dec 4', 'ASCII label for subjects');
  eq(sched.periodStart('2026-12-04'), '2026-11-21', 'the same periods as the page');
});
check('the email function imports its schedule and never sends on a dry run', () => {
  const fn = fs.readFileSync(path.join(ROOT, 'supabase/functions/crew-hours-notify/index.ts'), 'utf8');
  ok(/from "\.\/schedule\.js"/.test(fn), 'index.ts must import ./schedule.js');
  ok(/if \(dry\) return \{ dry: true/.test(fn), 'dry run returns before sending');
  ok(/crew_notify_authorized/.test(fn), 'callers prove themselves with the vault secret');
});

console.log(`\n${failed ? '✗ ' + failed + ' of ' + (passed + failed) + ' check(s) failed, do not push' : '✓ all ' + passed + ' checks passed'}`);
process.exit(failed ? 1 : 0);
