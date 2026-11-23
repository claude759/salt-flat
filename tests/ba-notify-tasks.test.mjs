// BA app ba-notify: the 9 AM "Your tasks" email (job 'tasks', 2026-11-21). Runs the function's own
// "Your tasks" email block, sliced out of ba/supabase/functions/ba-notify/index.ts with its types
// stripped, in a vm beside the function's esc and APP_URL and mail.ts's mailShell and btn. Synthetic
// tasks only; nothing is sent.
//   node --test tests/ba-notify-tasks.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const read = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
const fn = read('../ba/supabase/functions/ba-notify/index.ts'), mail = read('../ba/supabase/functions/_shared/mail.ts');
const between = (src, start, end) => { const a = src.indexOf(start), b = src.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return src.slice(a, b); };
const s = {};
vm.createContext(s);
const run = code => vm.runInContext(stripTypeScriptTypes(code), s);
run(between(fn, 'const APP_URL =', 'const TZ ='));
run(between(fn, 'const esc =', '// current wall-clock date'));
run(between(mail, 'export function mailShell', '// The new-user invite.').replace(/^export /gm, ''));
run(between(fn, '// ── "Your tasks" email', '// ── end "Your tasks" email ──'));
const get = name => vm.runInContext(name, s);
const T = o => ({ id: 'x', date: '2026-11-21', time: null, kind: 'visit', title: null, account: '', notes: null, booking: null, ...o });
const email = (name, lists) => get('tasksEmail')(name, '2026-11-21', { today: [], added: [], overdue: [], ...lists });
const FOOT = 'Visits mark themselves done when you log a trip or hours at that store that day, or file the post-visit report. Tap Done in the app for trainings and follow-ups.';

test('subject and title name the day; only the sections with something show', () => {
  const m = email('Ledy', { today: [T({ time: '10:30', account: 'Kolas Arden' })] });
  assert.equal(m.subject, 'Your tasks for Saturday, Nov 21');
  assert.match(m.html, /🌲 Your tasks for Saturday, Nov 21</);
  assert.match(m.html, /Hi Ledy, here are your tasks\./);
  assert.match(m.html, />Today</);
  assert.doesNotMatch(m.html, /New for you|Past due/);
  assert.match(m.text, /^Hi Ledy, here are your tasks for Saturday, Nov 21\.\n\nToday\n- 10:30 AM · Visit · Kolas Arden\n\nOpen the app: /);
});

test('sections in order, Today, New for you, Past due; lines outside Today carry their day', () => {
  const m = email('Ledy', {
    today: [T({ account: 'Today Store' })],
    added: [T({ date: '2026-11-24', time: '09:00', account: 'Next Store' })],
    overdue: [T({ date: '2026-11-19', kind: 'followup', title: 'Reorder check', account: 'Old Store' })] });
  assert.match(m.text, /^Today\n- Visit · Today Store$/m);
  assert.match(m.text, /^New for you\n- Tue Nov 24 · 9 AM · Visit · Next Store$/m);
  assert.match(m.text, /^Past due\n- Thu Nov 19 · Follow-up · Reorder check · Old Store$/m);
  const at = h => m.html.indexOf(`>${h}<`);
  assert.ok(at('Today') > 0 && at('Today') < at('New for you') && at('New for you') < at('Past due'));
});

test('each type in words; a title that only repeats the type is not said twice', () => {
  const line = o => get('taskLine')(T({ account: 'Store', ...o }), false).text;
  assert.equal(line({ kind: 'visit' }), '- Visit · Store');
  assert.equal(line({ kind: 'pad' }), '- Demo / PAD · Store');
  assert.equal(line({ kind: 'edu' }), '- Education talk · Store');
  assert.equal(line({ kind: 'training' }), '- Training · Store');
  assert.equal(line({ kind: 'followup' }), '- Follow-up · Store');
  assert.equal(line({ kind: 'training', title: 'training' }), '- Training · Store');
  assert.equal(line({ kind: 'training', title: 'New vape line', account: '' }), '- Training · New vape line');
});

test('times read like the app (9 AM, 10:30 AM); days like My tasks (Tue Nov 24)', () => {
  const t = get('taskTime'), d = get('taskDay');
  assert.equal(t('09:00'), '9 AM');
  assert.equal(t('10:30'), '10:30 AM');
  assert.equal(t('12:00'), '12 PM');
  assert.equal(t('13:05'), '1:05 PM');
  assert.equal(t('00:05'), '12:05 AM');
  assert.equal(t('23:59'), '11:59 PM');
  for (const bad of [null, '', '9am', '24:00', '7:5']) assert.equal(t(bad), '');
  assert.equal(d('2026-11-21', true), 'Saturday, Nov 21');
  assert.equal(d('2026-11-24'), 'Tue Nov 24');
  assert.equal(d('2027-01-01'), 'Fri Jan 1');
  assert.equal(d(''), '');
});

test('notes on one line, cut at a word near 120 characters; Needs scheduling only when booking is needs', () => {
  const long = 'Bring the new 5-pack display and the updated menu cards, ask for Jen about the reorder,\n and check the vape wall facings before you leave';
  const n = get('taskNote')(long);
  assert.ok(n.endsWith('…') && n.length <= 121 && n.length >= 100, n);
  assert.ok(long.replace(/\s+/g, ' ').startsWith(n.slice(0, -1)));
  assert.equal(get('taskNote')('  short\n note '), 'short note');
  const l = get('taskLine')(T({ time: '14:00', kind: 'pad', title: 'Holiday demo', account: 'Kolas Arden', notes: long, booking: 'needs' }), false);
  assert.equal(l.text, `- 2 PM · Demo / PAD · Holiday demo · Kolas Arden · ${n} (Needs scheduling)`);
  assert.match(l.html, /^<li[^>]*><b>2 PM · Demo \/ PAD<\/b> · Holiday demo · Kolas Arden <span[^>]*>· [^<]+…<\/span> <span[^>]*>Needs scheduling<\/span><\/li>$/);
  for (const booking of ['confirmed', null]) assert.doesNotMatch(get('taskLine')(T({ booking }), false).html, /Needs scheduling/);
});

test('everything from the Schedule and the profile is escaped', () => {
  const m = email('<b>Ledy</b>', { today: [T({ title: '<script>x</script>', account: 'Kolas & "Co"', notes: '<img src=x onerror=alert(1)>' })] });
  assert.doesNotMatch(m.html, /<script|<img|<b>Ledy/);
  assert.match(m.html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(m.html, /Kolas &amp; &quot;Co&quot;/);
  assert.match(m.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(m.html, /Hi &lt;b&gt;Ledy&lt;\/b&gt;,/);
});

test('the button opens the app, the closing line explains Done, no em dash, and nothing breaks when flattened', () => {
  const m = email('', { added: [T({ date: '2026-11-22' })] });
  const url = get('APP_URL');
  assert.ok(m.html.includes(`href="${url}"`) && m.html.includes('Open the app →'));
  assert.ok(m.text.includes(`Open the app: ${url}`));
  assert.ok(m.html.includes(FOOT) && m.text.endsWith(FOOT));
  assert.match(m.html, /Hi there, here are your tasks\./);
  for (const x of [m.subject, m.html, m.text]) assert.ok(!x.includes('\u2014'), 'em dash');
  assert.match(m.subject, /^[\x20-\x7E]+$/);
  // sendMail drops every newline and the indent after it: they may only sit between tags
  for (const g of m.html.matchAll(/\n\s*/g)) {
    assert.equal(m.html[g.index - 1], '>', JSON.stringify(m.html.slice(g.index - 20, g.index + 20)));
    assert.equal(m.html[g.index + g[0].length], '<');
  }
});

test('first names', () => {
  const f = get('firstName');
  assert.equal(f('Leti Granados'), 'Leti');
  assert.equal(f('  Makenna   Smith '), 'Makenna');
  assert.equal(f(null), '');
});

// ── the "New task" email (job 'task-notices', 2026-11-23): a few minutes after a task is given to someone ──
const notice = (name, tasks) => get('noticeEmail')(name, tasks);

test('new task email: one task names what, where and the day; the line carries its day', () => {
  const m = notice('Joanna', [T({ date: '2026-11-25', time: '14:00', kind: 'pad', account: 'A/0 Cannabis', notes: 'Demo 2-4pm' })]);
  assert.equal(m.subject, 'New task for Wed Nov 25: Demo / PAD at A/0 Cannabis');
  assert.match(m.html, /🌲 A new task for you</);
  assert.match(m.html, /Hi Joanna, this was just added to your schedule\./);
  assert.match(m.html, /<b>Wed Nov 25 · 2 PM · Demo \/ PAD<\/b> · A\/0 Cannabis/);
  assert.match(m.text, /^Hi Joanna, this was just added to your schedule\.\n\n- Wed Nov 25 · 2 PM · Demo \/ PAD · A\/0 Cannabis · Demo 2-4pm\n\nOpen the app: /);
  assert.ok(m.text.endsWith(FOOT));
});

test('new task email: a title stands for the type; several tasks are counted; Needs scheduling shows', () => {
  const one = notice('Cesar', [T({ date: '2026-11-24', kind: 'followup', title: 'Order draft - Vapes', account: 'The Cake House San Jose' })]);
  assert.equal(one.subject, 'New task for Tue Nov 24: Order draft - Vapes at The Cake House San Jose');
  const same = notice('Cesar', [T({ date: '2026-11-24', kind: 'training', title: 'training', account: 'Goat Global Westwood' })]);
  assert.equal(same.subject, 'New task for Tue Nov 24: Training at Goat Global Westwood');
  const many = notice('Ledy', [T({ date: '2026-11-24', account: 'Kanna', booking: 'needs' }), T({ id: 'y', date: '2026-11-27', account: 'CBCB' })]);
  assert.equal(many.subject, '2 new tasks on your schedule');
  assert.match(many.html, /🌲 2 new tasks for you</);
  assert.match(many.html, /these were just added to your schedule/);
  assert.match(many.html, /Kanna[^]*Needs scheduling[^]*CBCB/);
  assert.match(many.text, /- Tue Nov 24 · Visit · Kanna \(Needs scheduling\)\n- Fri Nov 27 · Visit · CBCB\n/);
});

test('new task email: long names are cut at a word, everything is escaped, the subject stays plain', () => {
  const long = 'Very Long Store Name That Keeps Going Well Past Fifty Characters Of Text';
  const m = notice('<b>x</b>', [T({ date: '2026-11-24', account: long, title: '<script>' })]);
  assert.ok(m.subject.length < 130, m.subject);
  assert.match(m.subject, /^New task for Tue Nov 24: <script> at Very Long Store Name That Keeps Going Well Past\.\.\.$/);
  assert.doesNotMatch(m.html, /<script>|<b>x<\/b>/);
  assert.match(m.html, /&lt;script&gt;/);
  assert.doesNotMatch(m.subject + m.html + m.text, /—/);
  const empty = notice('', []);
  assert.equal(empty.subject, '0 new tasks on your schedule');
});
