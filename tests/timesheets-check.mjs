// node tests/timesheets-check.mjs : checks for the Manager Gusto Timesheets page (timesheets.html).
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
check('the app is called "Manager Gusto Timesheets" (title, sign-in gate, header, print) and the no-view message is the agreed text', () => {
  ok(/<title>Manager Gusto Timesheets<\/title>/.test(src), 'title');
  ok(/<div class="login-logo">Manager Gusto Timesheets<\/div>/.test(markup), 'sign-in gate');
  ok(/<b class="brand-name"><span class="bn-long">Manager Gusto Timesheets<\/span><span class="bn-short">Timesheets<\/span><\/b>/.test(markup), 'header brand (and "Timesheets" on phones)');
  ok(/<h1>Manager Gusto Timesheets<\/h1>/.test(block('ts-app')), 'print heading');
  ok(!/Manager Timesheets/.test(src), 'the old name "Manager Timesheets" is still in the file');
  ok(markup.includes("Your account doesn't have a timesheet view yet. Ask Gianni to add you."), 'no-view message');
  ok(markup.includes('Demo data, not real timesheets'), 'demo banner');
});
check('saved views: reads ts_views, saves and deletes through the spec RPCs and argument names', () => {
  const app = block('ts-app');
  ok(/sb\.from\('ts_views'\)\.select\('\*'\)\.order\('sort'\)\.order\('label'\)/.test(app), "sb.from('ts_views').select('*').order('sort').order('label')");
  ok(/sb\.rpc\('ts_admin_save_view', \{ p_id: [^}]*p_label: [^}]*p_sort: [^}]*p_members: /.test(app), 'ts_admin_save_view args');
  ok(/sb\.rpc\('ts_admin_delete_view', \{ p_id: /.test(app), 'ts_admin_delete_view args');
});
check('saved views stay optional: a missing table or a failed read never shows an error or blocks the page; Everyone is for admins only', () => {
  const app = block('ts-app');
  const m = app.match(/async function loadViews\(\) \{[\s\S]*?\n  \}/);
  ok(m, 'no loadViews()');
  ok(!/loadErr|throw/.test(m[0]), 'loadViews must not set S.loadErr or throw');
  ok(/!S\.me\.is_admin && !\(S\.me\.views \|\| \[\]\)\.length/.test(m[0]), 'loadViews must skip a manager who has no views');
  ok(/function crewInfo\(\) \{ return C\.crewsFor\(viewer\(\), S\.views\); \}/.test(app), 'the tabs come from crewsFor (Everyone only for admins; a preview gets the previewed sign-in\'s tabs)');
  ok(/function baseRows\(\) \{[^\n]*\n[^\n]*view: activeView\(\)/.test(app), 'the active view filters the base rows');
  ok(/function visibleCompanies\(\) \{ return C\.viewCompanyKeys\(allCompanies\(\), activeView\(\)\); \}/.test(app), 'company chips limited to the active view');
  ok(/function deptOptions\(base\) \{\s*return C\.departmentOptions\([^\n]*view: activeView\(\)/.test(app), 'department list limited to the active view');
  ok(/store\.get\('savedView'/.test(app) && /store\.set\('savedView'/.test(app), 'the chosen tab is remembered through the try/catch store');
});
check('decluttered layout: no freshness box, no KPI cards, the legend lives in the More menu', () => {
  ok(!/id="fresh"|class="fresh"|id="kpis"|class="kpi/.test(markup), 'old freshness box or KPI cards still in the markup');
  ok(/id="freshBtn"/.test(markup) && /id="freshPop"/.test(markup), 'header sync indicator and its popover');
  const more = markup.match(/<div class="pop" id="morePop"[\s\S]*?\n {6}<\/div>\n {4}<\/div>/);
  ok(more, 'no More popover');
  for (const want of ['data-act="fmt"', 'data-act="csv"', 'data-act="print"', 'data-act="key"', 'class="legend"']) ok(more[0].includes(want), 'More menu is missing ' + want);
  ok((markup.match(/class="legend"/g) || []).length === 1, 'the legend appears once, inside More');
  ok(/id="viewTabs"/.test(markup.match(/<header id="top">[\s\S]*?<\/header>/)[0]), 'the view tab strip sits in the header');
});
// one function's source from ts-app: a one-liner, or up to its closing brace at two-space indent
const appFn = name => {
  const m = block('ts-app').match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\) \\{(?:[^\\n]*\\}\\n|[\\s\\S]*?\\n  \\})'));
  if (!m) throw new Error('no ' + name + '()');
  return m[0];
};
check('phones and narrow windows: a range dropdown replaces the preset buttons, and Flagged only + More wrap as one piece', () => {
  ok(/<select id="presetSel" aria-label="Date range"><\/select>/.test(markup), 'no #presetSel dropdown');
  ok(/\$\('presetSel'\)\.addEventListener\('change', e => choosePreset\(e\.target\.value\)\)/.test(block('ts-app')), 'the dropdown is not wired to choosePreset');
  ok(/case 'preset': choosePreset\(d\.preset\)/.test(block('ts-app')), 'the preset buttons do not share choosePreset');
  ok(/\$\('presetSel'\)\.value = S\.preset;/.test(appFn('renderControls')), 'renderControls does not keep the dropdown in step');
  const tail = markup.match(/<div class="ctl-tail">([\s\S]*?)\n {6}<\/div>\n {4}<\/div>/);
  ok(tail && /id="flagChip"/.test(tail[1]) && /id="moreWrap"/.test(tail[1]), 'Flagged only and More are not grouped in .ctl-tail');
  ok(/@media \(max-width:919\.98px\),\(pointer:coarse\) and \(max-width:999px\),\(pointer:coarse\) and \(max-height:500px\)\{\s*#presets\{display:none\}\s*\.psel\{display:inline-flex\}/.test(src), 'dropdown breakpoint (also touch screens up to 999px wide or held sideways)');
  ok(/<label class="psel" id="pselWrap"><span class="psel-txt" aria-hidden="true"><b id="pselLabel"><\/b><span id="pselDates"><\/span><\/span><select id="presetSel"/.test(markup), 'the dropdown face (range name over its dates) wraps the real select');
  ok(/\.stats \.brk-sum\{display:none\}/.test(src), 'phones drop the break totals from the section lines');
});
check('no page-wide summary line (Gianni 2026-10-09: "this is clutter"); the section lines carry the totals', () => {
  ok(!/id="summary"/.test(src) && !/function renderSummary/.test(src), 'the summary line is back');
  ok(/function statLine/.test(src), 'section stat lines are gone too');
});
check('view tabs: short tooltip (head count), never the member list; the chosen tab is scrolled into sight sideways only', () => {
  const f = appFn('renderViewTabs');
  ok(!/describeViewMembers/.test(f), 'tab tooltips list every member');
  ok(/C\.viewHeadcount\(c, S\.people\)/.test(f), 'tab tooltip should be the head count');
  ok(!/scrollIntoView/.test(f) && /inn\.scrollLeft \+= /.test(f), 'must not scrollIntoView (that can jump the page); adjust scrollLeft');
  ok(/classList\.toggle\('fade-r'/.test(appFn('stripFade')) && /\.vstrip\.fade-r \.vstrip-in\{[^}]*mask-image/.test(src), 'no fade on the cut-off edge');
});
check('Export CSV names the active view in the file name', () => {
  eq(C.csvFilename('2026-09-26', '2026-10-09', 'trim-crew'), 'timesheets-trim-crew-2026-09-26-to-2026-10-09.csv');
  eq(C.csvFilename('2026-09-26', '2026-10-09', null), 'timesheets-2026-09-26-to-2026-10-09.csv', 'Everyone');
  eq(C.csvFilename('2026-09-26', '2026-10-09', '../Odd Name'), 'timesheets-odd-name-2026-09-26-to-2026-10-09.csv', 'only safe characters');
  ok(/a\.download = C\.csvFilename\(S\.from, S\.to, cur && cur\.id\)/.test(appFn('exportCsv')), 'exportCsv does not pass the active view');
});
check('a search that only finds people outside the active view says so and offers Show everyone', () => {
  const f = appFn('renderContent');
  ok(/if \(cur && S\.q\) \{/.test(f), 'no outside-the-view check for a search');
  ok(/!C\.viewHas\(cur, /.test(f) && /outside\.length === hits\.length/.test(f), 'must only fire when every match is outside the view');
  ok(/' is not in ' \+ cur\.label/.test(f) && /data-act="crew" data-crew="">Show everyone</.test(f), 'message or Show everyone button missing');
});
check('view editor: a new view checks the server list before picking its id; errors stay on screen; a thrown call never leaves "Saving..."', () => {
  const f = appFn('saveViewEditor');
  const read = f.indexOf("sb.from('ts_views')"), uniq = f.indexOf('C.uniqueViewId('), dup = f.indexOf('Another view already has that name.');
  ok(read > 0 && /if \(ed\.isNew && !DEMO\) \{\s*const \{ data, error \} = await sb\.from\('ts_views'\)/.test(f), 'new views must re-read ts_views first');
  ok(read < uniq && read < dup, 'the id and the duplicate-name check must use the fresh list');
  ok(/\} catch \(e\) \{[\s\S]*?return fail\(/.test(f), 'saveViewEditor needs a catch that shows the error');
  ok(/try \{ \(\{ error \} = await sb\.rpc\('ts_admin_delete_view'/.test(appFn('deleteView')) && /catch \(e\) \{ error = e; \}/.test(appFn('deleteView')), 'deleteView must catch a thrown call');
  for (const [msg, field] of [['Give the view a name.', 'vLabel'], ['Order is a whole number, for example 10.', 'vSort'], ['Tick at least one person or department.', 'vFind']])
    ok(f.includes("fail('" + msg + "', '" + field + "')"), msg + ' should put the cursor in #' + field);
  ok(/<div class="form-foot">\$\{ed\.err \? h`<div class="inline-err" id="vErr" role="alert">/.test(appFn('viewEditorHtml')), 'the error must sit inside the pinned footer');
  ok(/\.form-foot\{[^}]*position:sticky;bottom:0/.test(src), 'the form footer is not pinned');
  ok(/\.overlay\{[^}]*padding:0 16px;border:solid transparent;border-width:40px 0;overflow:auto\}/.test(src), 'the overlay gap must be a border so the pinned footer has nothing under it');
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
  row({ company: 'filifera', uuid: 'u2', name: 'test kilo', dept: 'Trim', date: '2026-10-06', flags: [W('type_unsure', 'info')] }),
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
  eq(d6.companies[0].departments[1].rows.map(r => r.employee_name), ['Test Alpha', 'test kilo'], 'names, case-insensitive');
  const d5 = g[2];
  eq(d5.companies.map(c => c.company), ['filifera', 'imperial']);
  eq(d5.companies[1].departments[0].department, 'No department', 'blank department becomes No department');
});
check('By Employee: Company > Department > Employee, days oldest first, a mover sits under their latest department once', () => {
  const g = C.groupByEmployee(ROWS);
  eq(g.map(c => c.company), ['filifera', 'slane', 'wafgus', 'imperial']);
  const fil = g[0];
  eq(fil.departments.map(d => d.department), ['Distro/Trim', 'Packaging', 'Trim']);
  eq(fil.departments.map(d => d.employees.map(e => e.name)), [['Test Charlie'], ['Test Golf'], ['Test Alpha', 'test kilo']]);
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
// saved views: a row is in a view when a member has its company and its person (uuid) or its department
const V = (...members) => C.normView({ id: 'v', label: 'V', sort: 0, members });
check('view filter: member by person (uuid), even after the person moved department', () => {
  const v = V({ company: 'filifera', employee_uuid: 'u7' });
  eq(C.filterRows(ROWS, { view: v }).map(r => r.employee_name + '@' + r.work_date + '/' + r.department),
    ['Test Golf@2026-10-05/Trim', 'Test Golf@2026-10-07/Packaging']);
  ok(C.viewHas(v, 'filifera', 'u7', 'Anything') && !C.viewHas(v, 'filifera', 'u1', 'Trim'), 'viewHas');
});
check('view filter: member by whole department, only that department on that day', () => {
  const v = V({ company: 'filifera', department: 'Trim' });
  eq(C.filterRows(ROWS, { view: v }).map(r => r.employee_uuid + '@' + r.work_date).sort(),
    ['u1@2026-10-05', 'u1@2026-10-06', 'u2@2026-10-06', 'u7@2026-10-05'], 'Golf is in only on the day he was in Trim');
  eq(C.filterRows(ROWS, { view: V({ company: 'imperial', department: 'No department' }) }).map(r => r.employee_name), ['Test Echo'], 'a blank department is "No department"');
});
check('view filter: company must match too (same uuid or same department at another company is not in)', () => {
  eq(C.filterRows(ROWS, { view: V({ company: 'slane', employee_uuid: 'u1' }) }).length, 0, 'uuid at the wrong company');
  eq(C.filterRows(ROWS, { view: V({ company: 'imperial', department: 'Trim' }) }).length, 0, 'department at the wrong company');
  ok(!C.viewHas(V(), 'filifera', 'u1', 'Trim'), 'an empty view has nobody');
  eq(C.filterRows(ROWS, { view: null }).length, ROWS.length, 'no view = everyone');
});
check('view filter runs before the other filters, and they still apply inside it', () => {
  const v = V({ company: 'filifera', department: 'Trim' }, { company: 'slane', employee_uuid: 'u4' });
  eq(C.filterRows(ROWS, { view: v }).length, 5);
  eq(C.filterRows(ROWS, { view: v, companies: ['slane'] }).map(r => r.employee_name), ['Test Delta']);
  eq(C.filterRows(ROWS, { view: v, flaggedOnly: true }).map(r => r.employee_name), ['Test Delta'], 'flagged only inside the view');
  eq(C.filterRows(ROWS, { view: v, search: 'kilo' }).map(r => r.employee_uuid), ['u2']);
  eq(C.filterRows(ROWS, { view: v, department: 'Packaging' }).length, 0, 'Golf in Packaging is outside this view');
});
check('inside a view, company chips and the department list only offer what the view contains', () => {
  const all = ['filifera', 'slane', 'wafgus', 'imperial'];
  const v = V({ company: 'filifera', department: 'Trim' }, { company: 'wafgus', employee_uuid: 'u6' });
  eq(C.viewCompanyKeys(all, v), ['filifera', 'wafgus']);
  eq(C.viewCompanyKeys(all, null), all, 'no view: every company');
  eq(C.viewCompanyKeys(['filifera'], v), ['filifera'], 'never adds a company the viewer cannot see');
  const ppl = [
    { company: 'filifera', employee_uuid: 'u1', department: 'Trim', active: true },
    { company: 'filifera', employee_uuid: 'u3', department: 'Distro/Trim', active: true },
    { company: 'filifera', employee_uuid: 'u8', department: 'Trim', active: false },
    { company: 'wafgus', employee_uuid: 'u6', department: 'Operations', active: true },
    { company: 'wafgus', employee_uuid: 'u9', department: 'Sales', active: true },
    { company: 'slane', employee_uuid: 'u4', department: 'Harvest', active: true },
  ];
  eq(C.departmentOptions(ppl, [], { view: v }), ['Operations', 'Trim']);
  eq(C.departmentOptions(ppl, [], {}), ['Distro/Trim', 'Harvest', 'Operations', 'Sales', 'Trim'], 'no view');
  eq(C.departmentOptions(ppl, [], { view: v, selected: ['wafgus'] }), ['Operations'], 'and the selected companies');
  eq(C.departmentOptions(ppl, [], { view: v, companies: ['filifera'] }), ['Trim'], 'and the visible companies');
  eq(C.departmentOptions(ppl, [], { view: v, viewer: { active: true, is_admin: false, grants: [{ company: 'wafgus', department: '*' }] } }), ['Operations'], 'and the viewer');
  const golfPackaging = ROWS.find(r => r.employee_uuid === 'u7' && r.department === 'Packaging');
  eq(C.departmentOptions([], [golfPackaging], { view: V({ company: 'filifera', employee_uuid: 'u7' }) }), ['Packaging'], 'a department on a loaded day in the view');
  eq(C.departmentOptions([], [golfPackaging], { view: v }), [], 'a loaded day outside the view adds nothing');
});
check('view members: invalid ones dropped, duplicates merged, a person already covered by their whole department dropped', () => {
  eq(C.normalizeMembers([
    { company: 'slane', employee_uuid: 'u4' }, { company: 'filifera', department: 'Trim' }, { company: 'slane', employee_uuid: 'u4' },
    { company: 'filifera', employee_uuid: 'u1', department: 'Trim' },   // both keys
    { company: 'filifera' }, { employee_uuid: 'u2' }, { company: ' ', department: 'Trim' }, { company: 'filifera', department: '  ' },
    null, 'x', { company: 'filifera', employee_uuid: 'u2' },
  ]), [{ company: 'filifera', department: 'Trim' }, { company: 'filifera', employee_uuid: 'u2' }, { company: 'slane', employee_uuid: 'u4' }]);
  const ppl = [{ company: 'filifera', employee_uuid: 'u2', department: 'Trim', active: true }, { company: 'filifera', employee_uuid: 'u3', department: 'Distro/Trim', active: true }];
  eq(C.normalizeMembers([{ company: 'filifera', department: 'Trim' }, { company: 'filifera', employee_uuid: 'u2' }, { company: 'filifera', employee_uuid: 'u3' }], ppl),
    [{ company: 'filifera', department: 'Trim' }, { company: 'filifera', employee_uuid: 'u3' }], 'u2 is inside Trim already');
  eq(C.normalizeMembers('nope'), []);
  for (const m of [{ company: 'slane', employee_uuid: 'a\nb' }, { company: 'filifera', department: 'Distro/Trim' }]) eq(C.memberFromKey(C.memberKey(m)), m, 'key round trip');
});
check('view members: a department the server refuses ("*", "@uuid:...", ts_views_reserved) is never a whole-department member; the editor offers its people one by one', () => {
  eq(C.normalizeMembers([{ company: 'filifera', department: '*' }, { company: 'filifera', department: '@uuid:u7' }, { company: 'filifera', department: ' @uuid:x' },
    { company: 'filifera', department: 'Trim' }, { company: 'filifera', employee_uuid: 'u7' }]),
    [{ company: 'filifera', department: 'Trim' }, { company: 'filifera', employee_uuid: 'u7' }]);
  ok(C.RESERVED_DEPT('*') && C.RESERVED_DEPT('@uuid:abc') && !C.RESERVED_DEPT('Trim') && !C.RESERVED_DEPT('@ Trim'), 'RESERVED_DEPT');
  const ve = block('ts-app').match(/function viewEditorHtml\(ed\) \{[\s\S]*?\n  \}/)[0];
  ok(/const reserved = C\.RESERVED_DEPT\(String\(dp\.department\)\.trim\(\)\);/.test(ve) && /reserved \? h`<div class="ck strong">\$\{dp\.department\} <span class="faint">pick people one by one<\/span><\/div>`/.test(ve),
    'the view editor must not offer a whole-department box for a reserved name');
  ok(/ts_views_reserved/.test(block('ts-core')), 'the comment names the trigger it mirrors');
});
check('views load sorted by order then name, with safe defaults', () => {
  const vs = C.normViews([{ id: 'b', label: 'beta', sort: 5, members: [] }, { id: 'a', label: 'Alpha', sort: 5 }, { id: 'z', label: '', sort: '1' },
    { id: 'n', label: 'No sort', sort: 'x', members: [{ company: 'slane', department: 'Harvest' }, { company: 'slane' }] }, null, { label: 'no id' }]);
  eq(vs.map(v => [v.id, v.label, v.sort]), [['n', 'No sort', 0], ['z', 'z', 1], ['a', 'Alpha', 5], ['b', 'beta', 5]]);
  eq(vs[0].members, [{ company: 'slane', department: 'Harvest' }], 'bad members dropped on load');
});
check('a new view id is the label as a slug, unique, and fits the ts_views id rule', () => {
  eq(C.slugify('Trim / Night Crew'), 'trim-night-crew');
  eq(C.slugify('  Équipe Été!  '), 'equipe-ete');
  eq(C.slugify('!!!'), 'view');
  eq(C.slugify('A'.repeat(70)), 'a'.repeat(40));
  eq(C.uniqueViewId('Trim Crew', ['trim-crew']), 'trim-crew-2');
  eq(C.uniqueViewId('Trim Crew', ['trim-crew', 'trim-crew-2']), 'trim-crew-3');
  eq(C.uniqueViewId('Grow', []), 'grow');
  const long = C.uniqueViewId('word '.repeat(20), [C.slugify('word '.repeat(20))]);
  ok(long.length <= 40 && long.endsWith('-2') && !long.includes('--'), long);
  for (const s of ['Trim / Night Crew', '!!!', 'A'.repeat(70), '-x-', '9 to 5', long]) ok(C.VIEW_ID_RE.test(C.slugify(s)) && C.VIEW_ID_RE.test(long), s);
});
check('view summaries: plain-words member list, headcount of active people, picker groups', () => {
  const ppl = [
    { company: 'filifera', employee_uuid: 'p1', name: 'Test Alpha', department: 'Trim', active: true },
    { company: 'filifera', employee_uuid: 'p2', name: 'Test Bravo', department: 'Trim', active: true },
    { company: 'filifera', employee_uuid: 'p3', name: 'Test Old', department: 'Trim', active: false },
    { company: 'wafgus', employee_uuid: 'p4', name: 'Test Delta', department: '', active: true },
  ];
  const v = V({ company: 'filifera', department: 'Trim' }, { company: 'wafgus', employee_uuid: 'p4' }, { company: 'wafgus', employee_uuid: 'gone' });
  eq(C.describeViewMembers(v, ppl), 'Filifera: all of Trim · Waf & Gus: someone no longer in Gusto, Test Delta');
  eq(C.describeViewMembers(V(), ppl), 'Nobody yet');
  eq(C.viewHeadcount(v, ppl), 3, 'two active in Trim plus one picked');
  eq(C.viewMemberCounts(v), { people: 2, departments: 1 });
  const pk = C.viewPicker(ppl, 'filifera', [{ company: 'filifera', department: 'Gone Dept' }, { company: 'filifera', employee_uuid: 'p3' }]);
  eq(pk.depts.map(d => [d.department, d.idle, d.people.map(p => p.name)]), [['Gone Dept', true, []], ['Trim', false, ['Test Alpha', 'Test Bravo']]]);
  eq(pk.extras.map(p => p.name), ['Test Old'], 'a picked person who is not active now stays listed');
  eq(C.viewPicker(ppl, 'wafgus', []).depts.map(d => d.department), ['No department']);
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
// 6b. a saved view reads flat (Gianni 2026-10-09: a crew view needs no company or department, it has to
//     be easy to skim). Everyone keeps Company > Department.
// ---------------------------------------------------------------------------------------------
const FLAT = [
  row({ company: 'wafgus', uuid: 'w1', name: 'Test Zulu', dept: 'Sales', date: '2026-10-06' }),
  row({ company: 'slane', uuid: 's1', name: 'Test  ALPHA', dept: 'Harvest', date: '2026-10-06', job: 'Harvest Tech' }),   // the same person at a second company, same day
  row({ company: 'filifera', uuid: 'f1', name: 'test alpha', dept: 'Trim', date: '2026-10-06', job: 'Trimmer' }),
  row({ company: 'slane', uuid: 's1', name: 'Test Alpha', dept: 'Harvest', date: '2026-10-07', job: 'Harvest Tech', flags: [W('no_meal')] }),
  row({ company: 'filifera', uuid: 'f1', name: 'Test Alpha', dept: 'Trim', date: '2026-10-05', job: 'Trimmer', worked: 300 }),
  row({ company: 'imperial', uuid: 'i1', name: 'Émile Test', dept: '', date: '2026-10-06' }),
  row({ company: 'filifera', uuid: 'f2', name: 'Test Mike', dept: 'Packaging', date: '2026-10-07' }),
  row({ company: 'wafgus', uuid: 'w2', name: 'test oscar', dept: 'Sales', date: '2026-10-07' }),
];
const at = r => r.company + ':' + r.employee_uuid + '@' + r.work_date;
check('flat By Day: newest date first, one A-Z list per day across companies and departments, no group levels', () => {
  const g = C.flatByDay(FLAT);
  eq(g.map(d => d.date), ['2026-10-07', '2026-10-06', '2026-10-05']);
  ok(g.every(d => Array.isArray(d.rows) && !('companies' in d) && !('departments' in d)), 'a flat day must not carry company or department groups');
  eq(g[1].rows.map(at), ['imperial:i1@2026-10-06', 'filifera:f1@2026-10-06', 'slane:s1@2026-10-06', 'wafgus:w1@2026-10-06'],
    'A-Z ignoring case and accents (Emile, alpha, Zulu); one person at two companies sits together, in company order');
  eq(g[0].rows.map(r => r.employee_name), ['Test Alpha', 'Test Mike', 'test oscar'], 'A-Z ignoring case');
  eq([g[1].totals.rows, g[1].totals.people], [4, 3], 'the person clocked at two companies counts once');
  eq(g.reduce((a, d) => a + d.totals.worked_min, 0), C.totals(FLAT).worked_min, 'day totals add up to the grand total');
  eq(g.reduce((a, d) => a + d.rows.length, 0), FLAT.length, 'every row shows once');
  eq(C.flatByDay([]), []);
});
check('flat By Employee: one card per person A-Z; the same name at two companies is ONE card, days in date order, both rows of a double-clocked day kept', () => {
  const p = C.flatByPerson(FLAT);
  eq(p.map(e => e.name), ['Émile Test', 'Test Alpha', 'Test Mike', 'test oscar', 'Test Zulu']);
  const alpha = p[1];
  eq(alpha.rows.map(at), ['filifera:f1@2026-10-05', 'filifera:f1@2026-10-06', 'slane:s1@2026-10-06', 'slane:s1@2026-10-07']);
  eq([alpha.totals.rows, alpha.totals.days, alpha.totals.people], [4, 3, 1], '4 rows on 3 calendar days, 1 person');
  eq(alpha.totals.worked_min, 300 + 480 * 3);
  eq(alpha.totals.warn, 1);
  eq(alpha.job, 'Harvest Tech', 'the job from their latest day');
  ok(!('company' in alpha) && !('department' in alpha), 'a flat card names no company or department');
  eq(p.reduce((a, e) => a + e.rows.length, 0), FLAT.length, 'every row lands on exactly one card');
});
check('flat: one person\'s two rows on the same day run in clock-in order (then company order), in both layouts and the CSV', () => {
  const two = [
    row({ company: 'filifera', uuid: 'f9', name: 'Test Quill', dept: 'Packaging', date: '2026-10-06', job: 'Packager', extra: { first_in: '2026-10-06T16:55:00Z' } }),
    row({ company: 'wafgus', uuid: 'w9', name: 'Test Quill', dept: 'Operations', date: '2026-10-06', job: 'Office', extra: { first_in: '2026-10-06T15:55:00Z' } }),
    row({ company: 'slane', uuid: 's9', name: 'Test Quill', dept: 'Harvest', date: '2026-10-07', extra: { first_in: null } }),
    row({ company: 'filifera', uuid: 'f9', name: 'Test Quill', dept: 'Packaging', date: '2026-10-07', extra: { first_in: '2026-10-07T16:00:00Z' } }),
  ];
  const card = C.flatByPerson(two);
  eq(card.length, 1, 'three companies, one person');
  eq(card[0].rows.map(r => r.company + '@' + r.work_date), ['wafgus@2026-10-06', 'filifera@2026-10-06', 'filifera@2026-10-07', 'slane@2026-10-07'], 'earliest first; no clock-in goes last');
  eq(C.flatByDay(two).map(d => d.rows.map(r => r.company)), [['filifera', 'slane'], ['wafgus', 'filifera']]);
  eq(parseCsv(C.buildCsv(two, { flat: true })).slice(1).map(c => c[1]), ['Waf & Gus', 'Filifera', 'Filifera', 'Slane']);
});
check('flat: two people with one name at the SAME company stay two; a nameless employee never merges with anyone', () => {
  const twins = [
    row({ company: 'filifera', uuid: 't1', name: 'Test Twin', dept: 'Trim', date: '2026-10-06' }),
    row({ company: 'filifera', uuid: 't2', name: 'Test Twin', dept: 'Packaging', date: '2026-10-06' }),
    row({ company: 'slane', uuid: 't3', name: 'test twin', dept: 'Harvest', date: '2026-10-07' }),
    row({ company: 'slane', uuid: 'n1', name: '', dept: 'Harvest', date: '2026-10-06' }),
    row({ company: 'wafgus', uuid: 'n2', name: '', dept: 'Sales', date: '2026-10-06' }),
  ];
  const p = C.flatByPerson(twins);
  eq(p.length, 4, 'two nameless cards + two Test Twin cards');
  const tw = p.filter(e => C.personKey(e.name) === 'test twin').map(e => e.rows.map(r => r.company + ':' + r.employee_uuid));
  eq(tw, [['filifera:t1', 'slane:t3'], ['filifera:t2']], 'the second company joins the first same-name person');
  eq(C.flatByDay(twins).find(d => d.date === '2026-10-06').totals.people, 4);
  eq(C.personKey('  Émile   TEST '), 'emile test');
});
check('layout: a saved view is flat and hides the company chips and department select; Everyone keeps them and Company > Department', () => {
  eq(C.layoutFor(null), { flat: false, companyChips: true, deptSelect: true }, 'Everyone');
  eq(C.layoutFor(V({ company: 'wafgus', department: 'Sales' })), { flat: true, companyChips: false, deptSelect: false }, 'any view, not just one');
  const g = C.groupByDay(FLAT);
  eq(g[1].companies.map(c => c.company), ['filifera', 'slane', 'wafgus', 'imperial'], 'Everyone By Day still groups by company');
  eq(C.groupByEmployee(FLAT).map(c => [c.company, c.departments.map(d => d.department)]),
    [['filifera', ['Packaging', 'Trim']], ['slane', ['Harvest']], ['wafgus', ['Sales']], ['imperial', ['No department']]], 'Everyone By Employee still groups by company and department');
  eq(C.groupByEmployee(FLAT).reduce((a, c) => a + c.departments.reduce((b, d) => b + d.employees.length, 0), 0), 6, 'and keeps one card per company login');
});
check('Job column: kept unless nobody in the view has a job title', () => {
  ok(C.anyJob(FLAT), 'jobs present');
  ok(!C.anyJob(FLAT.map(r => Object.assign({}, r, { job_title: '' }))), 'all blank');
  ok(!C.anyJob(FLAT.map(r => Object.assign({}, r, { job_title: r.company === 'filifera' ? '  ' : null }))), 'blank and missing');
  ok(!C.anyJob([]) && !C.anyJob(null), 'no rows');
});
check('CSV in a view: same columns (Company and Department stay for spreadsheets), each date sorted by name like the screen', () => {
  const p = parseCsv(C.buildCsv(FLAT, { flat: true }));
  eq(p[0], [...C.CSV_COLUMNS], 'columns');
  eq(p.slice(1).map(c => c[0] + ' ' + c[3] + ' ' + c[1]), [
    '2026-10-05 Test Alpha Filifera',
    '2026-10-06 Émile Test Imperial', '2026-10-06 test alpha Filifera', '2026-10-06 Test  ALPHA Slane', '2026-10-06 Test Zulu Waf & Gus',
    '2026-10-07 Test Alpha Slane', '2026-10-07 Test Mike Filifera', '2026-10-07 test oscar Waf & Gus']);
  eq(parseCsv(C.buildCsv(FLAT)).slice(1).filter(c => c[0] === '2026-10-06').map(c => c[1]), ['Filifera', 'Slane', 'Waf & Gus', 'Imperial'], 'Everyone keeps company order');
});
check('page: a view hides the company chips + department select and renders the flat layout; print and CSV follow it; Everyone renders as before', () => {
  ok(/function layout\(\) \{ return C\.layoutFor\(activeView\(\), \{ manager: managerMode\(\) \}\); \}/.test(block('ts-app')), 'layout() must follow the active view, and a manager is always flat');
  const rc = appFn('renderControls');
  ok(rc.includes("$('coChips').hidden = !lay.companyChips;") && rc.includes("$('deptSel').hidden = !lay.deptSelect;"), 'renderControls must hide the chips and department select in a view');
  ok(!/\$\('(q|flagChip|moreWrap|presets|presetSel)'\)\.hidden/.test(block('ts-app')), 'search, Flagged only, presets and More must stay');
  const r = appFn('render');
  ok(/if \(!lay\.companyChips\) S\.coSel = \[\];/.test(r) && /if \(!lay\.deptSelect\) S\.dept = '';/.test(r), 'a hidden control must stop filtering');
  const c = appFn('renderContent');
  ok(c.includes("if (lay.flat) setHTML(el, S.view === 'emp' ? flatEmpView(rows) : flatDayView(rows, C.anyJob(base)));"), 'a view renders flat');
  ok(c.includes("else setHTML(el, S.view === 'emp' ? empView(rows) : dayView(rows));"), 'Everyone renders grouped');
  const nc = c.slice(c.indexOf('off.length === sel.length'), c.indexOf('const names = off.map(coName)'));
  ok(/const inView = layout\(\)\.flat && activeView\(\);/.test(nc) && /inView\.label/.test(nc) && !/coName|department/.test(nc) && /return;/.test(nc),
    'the "not connected" empty state in a view names the view, never a company');
  for (const f of ['flatDayView', 'flatEmpView']) ok(!/coName|department|groupRow|co-head|dept-head|groupBy(Day|Employee)/.test(appFn(f)), f + ' names a company or department');
  ok(/C\.flatByDay\(rows\)/.test(appFn('flatDayView')) && /C\.flatByPerson\(rows\)/.test(appFn('flatEmpView')), 'flat views use the TSCore groupings');
  ok(/empCard\(e, null\)/.test(appFn('flatEmpView')) && /\$\{coKey \? h` <span class="emp-ctx print-only">/.test(appFn('empCard')), 'a flat card never prints the company line');
  ok(/layout\(\)\.flat \? \[\] : \[/.test(appFn('renderPrintHead')), 'print header lists companies and departments only outside a view');
  ok(/C\.buildCsv\(rows, \{ companyName: coName, flat: layout\(\)\.flat \}\)/.test(appFn('exportCsv')), 'CSV follows the layout');
  ok(/function dayRow\(r\) \{ return dayRowOf\(r, true\); \}/.test(block('ts-app')), 'dayRow stays a one-argument .map() callback with the Job column');
  ok(/@media \(max-width:1219\.98px\)\{[\s\S]*?table\.ts\.day-t\.nojob\{min-width:/.test(src), 'a table without the Job column needs its own min-width');
});
// ---------------------------------------------------------------------------------------------
// 6c. views given to a sign-in (ts_view_grants): a manager sees exactly the people in their views,
//     on the flat list, with only their own views as tabs. Mirrors ts_can_view(company, department,
//     employee_uuid) in supabase/ts-view-grants.sql.
// ---------------------------------------------------------------------------------------------
const KNOWN = C.normViews([
  { id: 'trim', label: 'Test Trim', sort: 10, members: [{ company: 'filifera', department: 'Trim' }] },
  { id: 'golf', label: 'Test Golf Crew', sort: 20, members: [{ company: 'filifera', employee_uuid: 'u7' }] },
  { id: 'harvest', label: 'Test Harvest', sort: 30, members: [{ company: 'slane', department: 'Harvest' }] },
]);
const MGR = (views, grants, extra) => Object.assign({ email: 'm@wizardtrees.com', active: true, is_admin: false,
  grants: grants || [], views: C.viewsFor(views, KNOWN) }, extra || {});
const seen = v => C.filterRows(ROWS, { viewer: v }).map(r => r.employee_uuid + '@' + r.work_date).sort();
check('view grants: a person member reaches that person at that company on every day, whatever their department', () => {
  eq(seen(MGR(['golf'])), ['u7@2026-10-05', 'u7@2026-10-07']);
  ok(C.canView(MGR(['golf']), 'filifera', 'Anything', 'u7') && !C.canView(MGR(['golf']), 'slane', 'Trim', 'u7'), 'company must match');
  ok(!C.canView(MGR(['golf']), 'filifera', 'Trim'), 'no uuid given: a person member cannot match');
});
check('view grants: a department member reaches that department at that company only; two views are the union; grants add on top', () => {
  eq(seen(MGR(['trim'])), ['u1@2026-10-05', 'u1@2026-10-06', 'u2@2026-10-06', 'u7@2026-10-05']);
  eq(seen(MGR(['trim', 'golf'])), ['u1@2026-10-05', 'u1@2026-10-06', 'u2@2026-10-06', 'u7@2026-10-05', 'u7@2026-10-07']);
  eq(seen(MGR(['golf'], [{ company: 'slane', department: '*' }])), ['u4@2026-10-06', 'u7@2026-10-05', 'u7@2026-10-07']);
  eq(seen(MGR(['harvest'])), ['u4@2026-10-06']);
});
check('view grants: turned off, nothing given, an unknown view, or a reserved department ("*", "@uuid:") sees nothing', () => {
  eq(seen(MGR(['trim'], [], { active: false })), [], 'inactive');
  eq(seen(MGR([])), [], 'no views, no grants');
  eq(seen(MGR(['no-such-view'])), [], 'a view whose members are unknown here');
  eq(seen(Object.assign(MGR([]), { views: [{ id: 'x', known: true, members: [{ company: 'filifera', department: '*' }] }] })), [], "a view's '*' department is not every department");
  eq(seen(Object.assign(MGR([]), { views: [{ id: 'x', known: true, members: [{ company: 'filifera', department: '@uuid:u7' }] }] })), [], "'@uuid:' department");
  eq(seen(MGR([], [{ company: 'filifera', department: '@uuid:u7' }])), [], "an '@uuid:' grant department");
  eq(seen({ active: true, is_admin: true, grants: [], views: [] }).length, ROWS.length, 'admin still sees everything');
});
check('viewsFor: ids or {id,label,sort} resolve to views with members, in tab order; unknown ones are kept by name, known:false', () => {
  const vs = C.viewsFor(['harvest', 'trim', 'trim', { id: 'gone', label: 'Old Crew', sort: 5 }, '', null], KNOWN);
  eq(vs.map(v => [v.id, v.label, v.known, v.members.length]), [['gone', 'Old Crew', false, 0], ['trim', 'Test Trim', true, 1], ['harvest', 'Test Harvest', true, 1]]);
  eq(C.viewsFor([{ id: 'trim', label: 'stale label', sort: 99 }], KNOWN)[0].label, 'Test Trim', 'ts_views is the source of a label');
  eq(C.viewsFor(null, KNOWN), []);
});
check('crewsFor: admin = Everyone + every view; manager = only their views, "All my people" last when they also have grants; unknown members = no tabs', () => {
  const a = C.crewsFor({ active: true, is_admin: true, grants: [] }, KNOWN);
  eq([a.everyone, a.list.map(c => c.id)], [true, ['trim', 'golf', 'harvest']]);
  const one = C.crewsFor(MGR(['golf']), KNOWN);
  eq([one.everyone, one.list.map(c => c.id), one.pending.length], [false, ['golf'], 0]);
  eq(C.crewsFor(MGR(['harvest', 'trim']), KNOWN).list.map(c => c.id), ['trim', 'harvest'], 'two views, tab order');
  const mix = C.crewsFor(MGR(['golf'], [{ company: 'slane', department: 'Harvest' }]), KNOWN).list;
  eq(mix.map(c => [c.id, c.label, !!c.all]), [['golf', 'Test Golf Crew', false], [C.ALL_MINE, 'All my people', true]]);
  ok(!C.VIEW_ID_RE.test(C.ALL_MINE), '"All my people" can never collide with a view id');
  const pend = C.crewsFor(MGR(['golf', 'missing']), KNOWN);
  eq([pend.everyone, pend.list.length, pend.pending.map(v => v.id).sort()], [false, 0, ['golf', 'missing']], 'members unknown: no tabs, and still no Everyone');
  eq(C.crewsFor(MGR([], [{ company: '*', department: '*' }]), KNOWN).list, [], 'grants only: no tabs');
  eq(C.crewsFor(MGR(['trim'], [], { active: false }), KNOWN).list, [], 'turned off: no tabs');
  ok(!C.crewsFor(MGR(['trim']), KNOWN).everyone, 'a manager never gets Everyone');
});
check('pickCrew: a ?view= link the sign-in may use, else the remembered tab, else Everyone (admin) or the first view (manager)', () => {
  const admin = C.crewsFor({ active: true, is_admin: true }, KNOWN), mgr = C.crewsFor(MGR(['harvest', 'golf']), KNOWN);
  eq(C.pickCrew(admin, 'harvest', 'trim'), { id: 'harvest', fromLink: true }, 'admin: any view');
  eq(C.pickCrew(admin, '', 'trim'), { id: 'trim', fromLink: false }, 'remembered');
  eq(C.pickCrew(admin, 'nope', ''), { id: '', fromLink: false }, 'admin default is Everyone');
  eq(C.pickCrew(mgr, 'trim', ''), { id: 'golf', fromLink: false }, 'a manager cannot open a view that is not theirs: ignored, first view');
  eq(C.pickCrew(mgr, 'harvest', 'golf'), { id: 'harvest', fromLink: true });
  eq(C.pickCrew(mgr, '', 'trim'), { id: 'golf', fromLink: false }, "another sign-in's remembered tab is not theirs");
  eq(C.pickCrew(C.crewsFor(MGR([]), KNOWN), 'trim', 'trim'), { id: '', fromLink: false }, 'no views');
});
check('describeAccess: views by name, then grants, in plain words', () => {
  eq(C.describeAccess({ is_admin: false, views: ['harvest', 'trim'], grants: [] }, KNOWN), 'Test Trim, Test Harvest');
  eq(C.describeAccess({ is_admin: false, views: ['golf'], grants: [{ company: 'slane', department: '*' }] }, KNOWN), 'Test Golf Crew · Slane: all departments');
  eq(C.describeAccess({ is_admin: false, views: [], grants: [] }, KNOWN), 'Nothing yet');
  eq(C.describeAccess({ is_admin: false, views: null, grants: [{ company: '*', department: '*' }] }, KNOWN), 'All CA', 'before view grants exist');
  eq(C.describeAccess({ is_admin: true, views: ['trim'] }, KNOWN), 'Everything');
});
check("a manager's companies and departments include their views' (sync indicator, previews)", () => {
  const cos = ['filifera', 'slane', 'wafgus', 'imperial'].map(key => ({ key, region: 'CA' }));
  eq(C.visibleCompanyKeys(MGR(['harvest']), cos, [], 'CA', []), ['slane']);
  eq(C.visibleCompanyKeys(MGR(['golf'], [{ company: 'imperial', department: 'Trim' }]), cos, [], 'CA', []), ['filifera', 'imperial']);
  const ppl = [{ company: 'filifera', employee_uuid: 'u7', department: 'Packaging', active: true }, { company: 'filifera', employee_uuid: 'u1', department: 'Trim', active: true }];
  eq(C.departmentOptions(ppl, [], { viewer: MGR(['golf']) }), ['Packaging'], 'a person member brings their department');
});
check('layout: a manager is always flat (with or without a view); an admin is flat only inside a view', () => {
  eq(C.layoutFor(null, { manager: true }), { flat: true, companyChips: false, deptSelect: false });
  eq(C.layoutFor(null, { manager: false }), { flat: false, companyChips: true, deptSelect: true });
  eq(C.layoutFor(KNOWN[0], { manager: false }).flat, true);
});
check('Admin > Sign-ins Save: views go out only when a box changed and the views were read; a failed read or an unlisted view never drops a grant', () => {
  eq(C.viewsToSave(new Set(['crew']), ['crew'], null), { views: ['crew'], changed: false }, 'ts_views read failed: leave them alone');
  eq(C.viewsToSave(new Set([]), ['crew'], null), { views: ['crew'], changed: false }, 'read failed and the form shows no boxes: still nothing sent');
  eq(C.viewsToSave(new Set(['crew']), ['crew'], ['crew', 'grow']), { views: ['crew'], changed: false }, 'nothing ticked or unticked');
  eq(C.viewsToSave(new Set(['grow', 'crew']), ['crew'], ['crew', 'grow']), { views: ['crew', 'grow'], changed: true }, 'ticked one');
  eq(C.viewsToSave(new Set([]), ['crew'], ['crew', 'grow']), { views: [], changed: true }, 'unticked the only one');
  eq(C.viewsToSave(new Set([]), ['new-elsewhere'], ['crew']), { views: ['new-elsewhere'], changed: false }, 'a view this page does not list (made in another tab) is kept');
  eq(C.viewsToSave(new Set(['crew']), ['new-elsewhere'], ['crew']), { views: ['crew', 'new-elsewhere'], changed: true }, 'and kept when another box changes');
  eq(C.viewsToSave(new Set(['crew']), [], []), { views: [], changed: false }, 'a box for a view that is gone sends nothing');
  const se = appFn('saveEditor');
  ok(/C\.viewsToSave\(ed\.views, ed\.viewsBefore, viewsKnown\(\) \? S\.views\.map\(v => v\.id\) : null\)/.test(se), 'saveEditor must go through C.viewsToSave with viewsKnown()');
  ok(!/\.filter\(id => S\.views\.some/.test(se), 'saveEditor must not filter the ids against S.views itself');
  ok(/function viewsKnown\(\) \{ return DEMO \|\| S\.viewsState === 'ok'; \}/.test(block('ts-app')), 'viewsKnown()');
  const vf = appFn('viewsFieldset');
  ok(/if \(!viewsKnown\(\)\)/.test(vf) && vf.includes("Views couldn't load, so saving leaves this sign-in's views as they are") && /data-act="views-retry"/.test(vf), 'a failed views read says so in the editor, with Try again');
  ok(/listFailed \? h`<p class="hint">The sign-ins list couldn't load/.test(vf) && /S\.accessState === 'error'/.test(vf), "a failed sign-ins list is not reported as a missing migration");
  const la = appFn('loadAccess');
  ok(/S\.accessState = 'error'/.test(la) && /S\.accessState = 'ok'/.test(la), 'loadAccess records whether the list loaded');
  ok(/case 'views-retry': syncEditor\(\);/.test(block('ts-app')) && /case 'access-retry': syncEditor\(\);/.test(block('ts-app')), 'Try again keeps what was typed on the form');
  ok(/u\.email \+ \(u\.active \? '' : ' \(off\)'\)/.test(appFn('viewsListHtml')), 'Admin > Views "Given to" marks a turned-off sign-in');
});
check('Admin > Views "Copy link" is the live page with ?view=<id>', () => {
  eq(C.LIVE_URL, 'https://claude759.github.io/salt-flat/timesheets.html');
  eq(C.viewLink('trim-crew'), 'https://claude759.github.io/salt-flat/timesheets.html?view=trim-crew');
  eq(C.viewLink('a b'), 'https://claude759.github.io/salt-flat/timesheets.html?view=a%20b', 'encoded');
  ok(/case 'v-link': copyLink\(C\.viewLink\(d\.id\)\)/.test(block('ts-app')), 'the button must copy C.viewLink');
  const cl = appFn('copyLink');
  ok(/navigator\.clipboard\.writeText\(url\)/.test(cl) && /execCommand\('copy'\)/.test(cl) && /window\.prompt\(/.test(cl), 'clipboard, then a hidden field, then a box to copy from');
});
check('page: ts_me views, the set-views RPC after save_user, previews carry views, deep links, one-line sync for flat pages', () => {
  const app = block('ts-app');
  ok(/views: Array\.isArray\(me\.views\)/.test(appFn('normMe')), 'normMe keeps ts_me().views');
  const se = appFn('saveEditor');
  const save = se.indexOf("sb.rpc('ts_admin_save_user'"), setv = se.indexOf("sb.rpc('ts_admin_set_user_views', { p_email: email, p_views: views })");
  ok(save > 0 && setv > save, 'ts_admin_set_user_views({ p_email, p_views }) must run after ts_admin_save_user');
  ok(/if \(viewsChanged\) \{/.test(se) && /viewGrantsReady\(\) && /.test(se), 'views are sent only when they changed, and only once the server has view grants');
  ok(/views: \(u\.views \|\| \[\]\)\.slice\(\)/.test(appFn('previewOf')), 'Preview carries the sign-in\'s views');
  ok(/const LINK_VIEW = C\.VIEW_ID_RE\.test\(QV\) \? QV : '';/.test(app) && /C\.pickCrew\(crewInfo\(\), LINK_VIEW, S\.crew\)/.test(appFn('applyLinkView')), '?view=<id> goes through pickCrew');
  ok(/view: \(QV === 'emp' \|\| QV === 'day' \? QV : store\.get\('view', 'day'\)\) === 'emp'/.test(app), '?view=emp still opens By Employee');
  const rf = appFn('renderFresh');
  const flat = rf.slice(rf.indexOf('if (layout().flat)'), rf.indexOf('return;', rf.indexOf('if (layout().flat)')));
  ok(flat.length > 40 && !/coName|items\.map/.test(flat), 'the flat sync popover must not name a company');
  const rc = appFn('renderContent');
  ok(/ci\.everyone \? h`<button type="button" class="btn" data-act="crew" data-crew="">Show everyone<\/button>` : ''/.test(rc), 'a manager is never offered Everyone');
  ok(/if \(!S\.viewer\) store\.set\('savedView'/.test(appFn('chooseCrew')), 'a preview never changes the admin\'s remembered tab');
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
check('flags cell: warnings are pills, info notes are one quiet "i" mark (never a pill), and only warnings count', () => {
  const info = C.flagsHtml([W('type_unsure', 'info')]).html;
  ok(!/class="flag\b/.test(info), 'an info flag rendered as a pill: ' + info);
  eq((info.match(/class="infomark"/g) || []).length, 1, 'one info mark');
  ok(/title="m type_unsure"/.test(info), 'the mark\'s tooltip lists the note');
  const both = C.flagsHtml([W('type_unsure', 'info'), W('no_meal'), { code: 'brand_new', sev: 'info', msg: 'second <note>' }]).html;
  eq((both.match(/class="flag warn"/g) || []).length, 1, 'one warning pill');
  eq((both.match(/class="infomark"/g) || []).length, 1, 'several info notes still make one mark');
  ok(both.includes('title="m type_unsure\nsecond &lt;note&gt;"'), 'every note in the tooltip, escaped: ' + both);
  ok(both.indexOf('flag warn') < both.indexOf('infomark'), 'the mark comes after the pills');
  eq(C.flagsHtml([]).html, ''); eq(C.flagsHtml(null).html, '');
  ok(!/flag info|class="flag \$\{/.test(src), 'the page still builds an info pill somewhere');
  eq(C.totals([row({ company: 'filifera', uuid: 'i1', name: 'Test Info', dept: 'Trim', date: '2026-10-06', flags: [W('type_unsure', 'info')] })]).warn, 0, 'info notes are not counted as flags');
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
check('header sync indicator: oldest connected company, amber when any is stale or pending, grey when none is connected', () => {
  const now = new Date('2026-10-08T18:00:00Z');   // 11:00 AM PDT
  const fil = { key: 'filifera', connected: true, last_sync_at: '2026-10-08T17:20:00Z', label_csv_at: '2026-10-08T09:10:00Z' };
  const waf = { key: 'wafgus', connected: true, last_sync_at: '2026-10-08T16:20:00Z' };
  const off = { key: 'imperial', connected: false };
  const s = C.freshSummary([fil, waf, off], now);
  eq([s.level, s.text, s.oldest], ['ok', 'Synced 9:20 AM', 'wafgus'], 'oldest wins; a company not connected yet does not turn it amber');
  eq(s.items.map(i => i.key + ': ' + i.sync), ['filifera: Synced 10:20 AM', 'wafgus: Synced 9:20 AM', 'imperial: Not connected yet'], 'every company for the popover');
  eq(s.items[0].labels, 'Break labels from Gusto through Oct 7');
  eq(C.freshSummary([fil, { key: 'slane', connected: true, last_sync_at: '2026-10-08T13:20:00Z' }], now).level, 'stale', 'one over 3 h old');
  eq(C.freshSummary([fil, { key: 'slane', connected: true }], now).level, 'stale', 'one waiting for its first sync');
  eq([C.freshSummary([off], now).level, C.freshSummary([off], now).text], ['off', 'Not connected yet']);
  eq(C.freshSummary([{ key: 'slane', connected: true }], now).text, 'First sync pending');
  eq(C.freshSummary([], now).items.length, 0);
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
const DEMO_VIEW_LABELS = ['Trim Crew', 'Grow Team', 'Ambassadors', 'Office and Drivers'];   // made-up crews, no person's name
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
  // and no real first or last name (4+ letters, as a capitalised word) anywhere in the page source
  const words = new Set();
  for (const f of files) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of t.matchAll(/Hours for ([^,\r\n"]+),\s*([^"\r\n]+)/g)) for (const w of (m[1] + ' ' + m[2]).trim().split(/\s+/)) if (/^[A-Z][A-Za-z'-]{3,}$/.test(w)) words.add(w);
  }
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inSrc = [...words].filter(w => new RegExp('(^|[^A-Za-z])' + reEsc(w) + '(?![A-Za-z])').test(src));
  ok(!inSrc.length, inSrc.length + ' real name word(s) from the local exports appear in the page (not printed here; search the page for them)');
});
check('no names in the page except the synthetic demo list (string literals shaped like a name are roster entries)', () => {
  const demoSrc = block('ts-demo');
  const allowed = new Set(D.ROSTER.flatMap(r => r.filter(x => typeof x === 'string')).concat(DEMO_VIEW_LABELS));
  const lits = [...demoSrc.matchAll(/'([A-Z][a-z]+(?: [A-Z][a-z]+)+)'/g)].map(m => m[1]);
  const strays = [...new Set(lits.filter(s => !allowed.has(s)))];
  ok(lits.length > 30 && !strays.length, 'name-like literals in ts-demo that are not on the roster: ' + J(strays));
  const rest = src.replace(demoSrc, '');
  const leaked = D.NAMES.filter(n => rest.includes(n) || rest.includes(n.split(' ')[1]));
  ok(!leaked.length, 'demo names used outside the demo block: ' + J(leaked));
  ok(!/'[A-Z][a-z]+ View'|"[A-Z][a-z]+ View"|>[A-Z][a-z]+ View</.test(src), 'a hard-coded "<Name> View" label; saved views come from the database');
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
check('demo views: 3-4 made-up crews over demo people only, valid ids, each with days this pay period', () => {
  const vs = C.normViews(demo.views);
  ok(vs.length >= 3 && vs.length <= 4, vs.length + ' views');
  eq(vs.map(v => v.label), DEMO_VIEW_LABELS, 'labels (in order)');
  ok(vs.every(v => C.VIEW_ID_RE.test(v.id)) && new Set(vs.map(v => v.id)).size === vs.length, 'ids');
  const ppl = new Set(demo.people.map(p => p.company + ':' + p.employee_uuid));
  const depts = new Set(demo.people.map(p => p.company + ':' + p.department));
  for (const v of vs) {
    eq(v.members.length, demo.views.find(x => x.id === v.id).members.length, v.id + ' members all valid');
    for (const m of v.members) ok(m.employee_uuid ? ppl.has(m.company + ':' + m.employee_uuid) && /^demo-/.test(m.employee_uuid) : depts.has(m.company + ':' + m.department), v.id + ' member ' + J(m));
    ok(C.filterRows(demo.rows, Object.assign({ view: v }, C.presetRange('period', demo.today))).length > 0, v.id + ' has days this period');
  }
  ok(vs.some(v => v.members.some(m => m.department)) && vs.some(v => v.members.some(m => m.employee_uuid)), 'whole departments and picked people');
});
check('demo views run through the flat pipeline: every row once, totals agree, A-Z, days in order', () => {
  const p = C.presetRange('period', demo.today);
  for (const v of C.normViews(demo.views)) {
    const rows = C.filterRows(demo.rows, Object.assign({ view: v }, p));
    const day = C.flatByDay(rows), emp = C.flatByPerson(rows);
    eq(day.reduce((a, d) => a + d.rows.length, 0), rows.length, v.id + ' by day');
    eq(emp.reduce((a, e) => a + e.rows.length, 0), rows.length, v.id + ' by person');
    eq(emp.reduce((a, e) => a + e.totals.worked_min, 0), C.totals(rows).worked_min, v.id + ' hours');
    eq(emp.length, new Set(rows.map(r => r.employee_name)).size, v.id + ' one card per name');
    const names = emp.map(e => C.personKey(e.name));
    eq(names, names.slice().sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })), v.id + ' A-Z');
    for (const d of day) { const n = d.rows.map(r => C.personKey(r.employee_name)); eq(n, n.slice().sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })), v.id + ' ' + d.date + ' A-Z'); }
    for (const e of emp) ok(e.rows.every((r, i) => !i || e.rows[i - 1].work_date <= r.work_date), v.id + ' ' + e.name + ' days in order');
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

check('demo sign-ins: a one-view manager, a two-view manager, a view plus a grant, grants only; views exist; previews see exactly their people', () => {
  const ids = new Set(demo.views.map(v => v.id));
  for (const a of demo.access) ok(Array.isArray(a.views) && a.views.every(v => ids.has(v)), a.email + ' views');
  const by = e => demo.access.find(a => a.email.startsWith(e + '@'));
  eq(by('trim.lead').views.length, 1); eq(by('field.lead').views.length, 2);
  ok(by('grow.manager').views.length && by('grow.manager').grants.length, 'view + grant');
  ok(!by('ops.manager').views.length && by('ops.manager').grants.length, 'grants only');
  const known = C.normViews(demo.views);
  const as = e => { const a = by(e); return Object.assign({}, a, { views: C.viewsFor(a.views, known) }); };
  const key = r => r.id;
  eq(C.filterRows(demo.rows, { viewer: as('trim.lead') }).map(key), C.filterRows(demo.rows, { view: known.find(v => v.id === 'trim-crew') }).map(key), 'one view = exactly that view');
  const grow = C.filterRows(demo.rows, { viewer: as('grow.manager') });
  const want = demo.rows.filter(r => C.viewHas(known.find(v => v.id === 'grow-team'), r.company, r.employee_uuid, r.department) || (r.company === 'imperial' && r.department === 'Distribution'));
  eq(grow.map(key).sort(), want.map(key).sort(), 'view + grant = the union');
  eq(C.filterRows(demo.rows, { viewer: as('ba.coordinator') }).length, 0, 'turned off');
});

// ---------------------------------------------------------------------------------------------
// 11. phones: cards instead of tables at 700px and below (and on a touch screen up to 999px wide or held
//     sideways); print stays tables
// ---------------------------------------------------------------------------------------------
const PHONE_CSS = '(max-width:700px),(pointer:coarse) and (max-width:999px),(pointer:coarse) and (max-height:500px)';
const brk = (s, e, kind, src, extra) => Object.assign({ start: '2026-10-06T' + s + ':00-07:00', end: e ? '2026-10-06T' + e + ':00-07:00' : null,
  min: e ? (+e.slice(0, 2) * 60 + +e.slice(3)) - (+s.slice(0, 2) * 60 + +s.slice(3)) : 0, kind, paid: kind === 'rest', src: src || 'gusto', open: !e }, extra || {});
const shift = (i, o, breaks, extra) => Object.assign({ id: 's' + i, in: '2026-10-06T' + i + ':00-07:00', out: o ? '2026-10-06T' + o + ':00-07:00' : null, span_min: 0, worked_min: 0, hours_only: false, breaks: breaks || [] }, extra || {});
check('card lines: "Mon 9/28", clock times per shift, open and hours-entered days', () => {
  eq(C.fmtDayShort('2026-09-28'), 'Mon 9/28'); eq(C.fmtDayShort('2026-12-05'), 'Sat 12/5'); eq(C.fmtDayShort('bad'), '');
  eq(C.shiftsText({ shifts: [shift('07:57', '16:20')] }), '7:57 AM - 4:20 PM');
  eq(C.shiftsText({ shifts: [shift('10:00', '13:30'), shift('14:15', '18:00')] }), '10:00 AM - 1:30 PM, 2:15 PM - 6:00 PM');
  eq(C.shiftsText({ shifts: [shift('06:31', null)] }), '6:31 AM - clocked in');
  eq(C.shiftsText({ shifts: [shift('08:00', '23:59', [], { hours_only: true })] }), 'hours entered');
  eq(C.shiftsText({ shifts: [], first_in: '2026-10-06T08:00:00-07:00', last_out: '2026-10-06T12:00:00-07:00' }), '8:00 AM - 12:00 PM', 'no shifts: first in / last out');
});
check('card lines: break summary "Meal 30m · Rest 10m, 10m", est. only for 21-24 min breaks, open breaks, time off between shifts', () => {
  const r = { shifts: [shift('07:00', '15:30', [brk('09:00', '09:10', 'rest'), brk('11:00', '11:30', 'meal'), brk('13:30', '13:40', 'rest')])] };
  eq(C.breakSummaryText(r), 'Meal 30m · Rest 10m, 10m');
  // est. only for the 21-24 min gray zone (Gianni 2026-10-09: "are all these est's necessary"); a guessed 10-min
  // rest or 30-min meal is shown plainly
  eq(C.breakSummaryText({ shifts: [shift('07:00', '15:30', [brk('09:00', '09:10', 'rest', 'rule'), brk('11:00', '11:22', 'meal', 'rule')])] }), 'Meal est. 22m · Rest 10m');
  eq(C.breakSummaryText({ shifts: [shift('07:00', '15:30', [brk('09:00', '09:10', 'rest', 'rule'), brk('11:00', '11:31', 'meal', 'rule')])] }), 'Meal 31m · Rest 10m', 'confident guesses carry no mark');
  eq(C.breakSummaryText({ shifts: [shift('07:00', '15:30', [brk('09:00', '09:10', 'rest'), brk('11:00', '11:30', 'meal'), brk('13:00', '13:22', 'meal', 'rule'), brk('14:30', '14:40', 'rest')])] }),
    'Meal 30m, 22m est. · Rest 10m, 10m', 'only the unsure break carries est., not the whole group');
  eq(C.breakSummaryText({ shifts: [shift('07:00', '15:30', [brk('09:00', '09:21', 'meal', 'rule'), brk('13:00', '13:24', 'meal', 'rule')])] }), 'Meal est. 21m, 24m', 'every meal unsure: one mark after the kind');
  ok(C.breakUnsure({ src: 'rule', end: 'x', min: 21 }) && C.breakUnsure({ src: 'rule', end: 'x', min: 24 }), 'the 21-24 min edges are unsure');
  ok(!C.breakUnsure({ src: 'rule', end: 'x', min: 20 }) && !C.breakUnsure({ src: 'rule', end: 'x', min: 25 }), '20 and 25 are confident');
  ok(!C.breakUnsure({ src: 'gusto', end: 'x', min: 22 }), 'a Gusto label is never unsure');
  ok(!/est = b\.src !== 'gusto'/.test(appFn('breakChip')), 'the desktop chip marks every guessed break again');
  const bl = appFn('breaksLine');
  ok(/g\.allEst \? est : ''/.test(bl) && /!g\.allEst && g\.ests\[i\] \? est : ''/.test(bl), 'the card line marks est. per kind or per break, like breakSummaryText');
  ok(/sepd\(parts, ' ·\\u00a0'\)/.test(bl), 'the " · " separator sticks to the item after it (no dot left at a line end)');
  eq(C.breakSummaryText({ shifts: [shift('07:00', '15:30', [brk('11:00', null, 'meal')])] }), 'Meal open');
  eq(C.breakSummaryText({ shifts: [shift('10:00', '13:30', [brk('11:00', '11:10', 'rest')]), shift('14:15', '18:00')] }), 'Rest 10m · Off 45m');
  eq(C.breakSummaryText({ shifts: [shift('09:00', '11:00')] }), 'No breaks');
  eq(C.breakSummaryText({ hours_only: true, shifts: [shift('08:00', '23:59', [], { hours_only: true })] }), '', 'hours entered: nothing to say');
  eq(C.breakSummary(r).groups.map(g => g.kind), ['meal', 'rest']);
});
check('phone header pieces: the dropdown face drops the year this year; the sync button has a short form; the flat popover has one labels line', () => {
  eq(C.fmtRangeShort('2026-09-26', '2026-10-09', '2026-10-08'), 'Sep 26 - Oct 9');
  eq(C.fmtRangeShort('2025-12-27', '2026-01-09', '2026-01-02'), 'Dec 27, 2025 - Jan 9, 2026', 'across a year end keeps the years');
  eq(C.fmtRangeShort('2026-10-06', '2026-10-06', '2026-10-08'), 'Oct 6');
  eq(C.PRESETS.map(p => p.short), ['This period', 'Last period', 'This week', 'Last week', 'Custom']);
  const now = new Date('2026-10-08T18:00:00Z');
  const fil = { key: 'filifera', connected: true, last_sync_at: '2026-10-08T17:20:00Z', label_csv_at: '2026-10-08T09:10:00Z' };
  const waf = { key: 'wafgus', connected: true, last_sync_at: '2026-10-08T16:20:00Z', label_csv_at: '2026-10-08T09:10:00Z' };
  eq([C.freshSummary([fil, waf], now).short, C.freshSummary([fil, waf], now).bare, C.freshSummary([fil, waf], now).labels], ['Synced 9:20', '9:20', 'Break labels from Gusto through Oct 7'], 'the phone pill says it is a sync time');
  eq(C.freshSummary([fil, { key: 'slane', connected: true, last_sync_at: '2026-10-08T17:20:00Z' }], now).labels, 'Some break types estimated from length');
  eq([C.freshSummary([{ key: 'slane', connected: true, last_sync_at: '2026-10-07T17:20:00Z' }], now)].map(x => [x.short, x.bare])[0], ['Synced yesterday', 'Yesterday']);
  eq([C.freshSummary([{ key: 'slane', connected: true, last_sync_at: '2026-10-05T17:20:00Z' }], now)].map(x => [x.short, x.bare])[0], ['Synced Oct 5', 'Oct 5']);
  eq([C.freshSummary([{ key: 'slane', connected: false }], now)].map(x => [x.short, x.bare])[0], ['Not synced', 'Not synced']);
  eq([C.freshSummary([{ key: 'slane', connected: true }], now)].map(x => [x.short, x.bare])[0], ['Sync pending', 'Pending']);
  ok(/<span class="fr-short" id="freshShort"><\/span><span class="fr-bare" id="freshBare"><\/span>/.test(markup) && /<svg class="fr-ico"/.test(markup), 'the pill has the short form and, for the narrowest phones, a sync glyph + bare time');
  const narrowest = src.match(/@media \(max-width:360px\)\{([\s\S]*?)\n  \}/)[1];
  ok(/\.freshbtn \.fr-short\{display:none\}/.test(narrowest) && /\.freshbtn \.fr-bare\{display:inline\}/.test(narrowest) && /\.freshbtn \.fr-ico\{display:block\}/.test(narrowest), '360px and below: glyph + bare time');
  ok(!/filifera|wafgus|Filifera/.test(C.freshSummary([fil, waf], now).labels), 'the labels line names no company');
});
check('phones render cards (By Day, By Employee, flat and grouped); desktop and print keep the tables', () => {
  const rc = appFn('renderContent');
  ok(rc.includes("if (compact()) setHTML(el, lay.flat ? (S.view === 'emp' ? phoneFlatEmp(rows) : phoneFlatDay(rows)) : (S.view === 'emp' ? phoneEmp(rows) : phoneDay(rows)));"), 'renderContent has no phone branch');
  ok(block('ts-app').includes("const PHONE_Q = '(max-width: 700px), (pointer: coarse) and (max-width: 999px), (pointer: coarse) and (max-height: 500px)';") &&
     /const PHONE_MQ = window\.matchMedia \? window\.matchMedia\(PHONE_Q\) : null;/.test(block('ts-app')), 'cards at 700px and below, and on a touch screen up to 999px wide or 500px tall (a phone held sideways)');
  ok(src.includes('@media ' + PHONE_CSS + '{'), 'the phone CSS block opens on the same condition as PHONE_Q');
  ok(/function compact\(\) \{ return !!\(PHONE_MQ && PHONE_MQ\.matches\) && !S\.printing; \}/.test(block('ts-app')), 'printing must switch to tables');
  ok(/'beforeprint', \(\) => \{ if \(!S\.printing\) \{ S\.printing = true; render\(\); \} \}/.test(block('ts-app')) && /'afterprint'/.test(block('ts-app')), 'beforeprint / afterprint');
  for (const f of ['phoneFlatDay', 'phoneDay', 'phoneFlatEmp', 'phoneEmp', 'dayCard', 'dayLine', 'personCard', 'detailBody', 'breaksLine', 'timesLine']) {
    const s = appFn(f);
    ok(!/<table|<tr|<td/.test(s), f + ' builds a table');
  }
  for (const f of ['phoneFlatDay', 'phoneFlatEmp', 'dayCard', 'dayLine', 'personCard']) ok(!/coName|department|glab\(/.test(appFn(f)), f + ' names a company or department (flat cards never do)');
  ok(/<details class="pc/.test(appFn('dayCard')) && /<summary>/.test(appFn('dayCard')) && /detailBody\(/.test(appFn('dayCard')), 'a day card opens on a tap (details/summary) to the detail body');
  ok(/<details class="dl/.test(appFn('dayLine')), 'a By Employee day line opens on a tap');
  ok(/C\.flatByDay\(rows\)/.test(appFn('phoneFlatDay')) && /C\.flatByPerson\(rows\)/.test(appFn('phoneFlatEmp')) && /C\.groupByDay\(rows\)/.test(appFn('phoneDay')) && /C\.groupByEmployee\(rows\)/.test(appFn('phoneEmp')), 'cards reuse the TSCore groupings');
  ok(/\.dhead\{position:sticky;top:env\(safe-area-inset-top,0px\)/.test(src), 'the day header sticks (below the status bar)');
  ok(/document\.addEventListener\('toggle', e => \{[\s\S]{0,260}S\.openCards\.(add|delete)/.test(block('ts-app')), 'opened cards survive a re-render');
  const db = appFn('detailBody');
  ok(/C\.flagMsg\(f\)/.test(db) && /r\.note/.test(db) && /breaksCell\(r\)/.test(db), 'the detail body writes out flags, the note and the break chips (phones have no tooltips)');
});
check('phone layout rules: compact header with a menu, two control rows, 40px taps, 15px text, 16px inputs, safe areas, no sideways page scroll', () => {
  const phone = src.match(new RegExp(PHONE_CSS.replace(/[()]/g, '\\$&') + '\\{([\\s\\S]*?)\\n  \\}\\n'));
  ok(phone, 'no 700px block');
  const p = phone[1];
  ok(/body\{font-size:15px\}/.test(p), 'primary text 15px');
  ok(/\.brand-name \.bn-long\{display:none\}/.test(p) && /\.brand-name \.bn-short\{display:inline\}/.test(p), 'short title "Timesheets"');
  ok(/#q\{[^}]*font-size:16px/.test(p) && /#deptSel\{[^}]*font-size:16px/.test(p) && /\.psel select\{[^}]*font-size:16px/.test(src), '16px fields (iPhone zooms into smaller ones)');
  ok(/\.chip\{min-height:40px/.test(p) && /\.vtab\{min-height:46px/.test(p) && /\.pop-item\{min-height:44px/.test(p) && /\.iconbtn\{[^}]*width:40px;height:40px/.test(src), 'tap targets');
  ok(/\.freshbtn \.fr-short\{display:inline\}/.test(p), 'the sync button keeps its dot and a short time');
  const narrow = src.match(/@media \(max-width:919\.98px\),\(pointer:coarse\) and \(max-width:999px\),\(pointer:coarse\) and \(max-height:500px\)\{([\s\S]*?)\n  \}/)[1];
  ok(/\.who,#adminBtn,#signOutBtn\{display:none\}/.test(narrow) && /#menuWrap\{display:inline-flex\}/.test(narrow), 'email, Admin and Sign out fold into the menu');
  const menu = markup.match(/<div class="pop" id="menuPop" hidden>[\s\S]*?\n {6}<\/div>/);
  ok(menu && /data-act="admin-open"/.test(menu[0]) && /data-act="signout"/.test(menu[0]) && /id="menuWho"/.test(menu[0]), 'the menu holds Admin, Sign out and who is signed in');
  ok(/<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/.test(src), 'viewport-fit=cover');
  for (const side of ['top', 'bottom', 'left', 'right']) ok(new RegExp('env\\(safe-area-inset-' + side).test(src), 'safe-area-inset-' + side);
  ok(/\.bar,\.vstrip-in,main,\.banner\{padding-left:max\(16px,env\(safe-area-inset-left,0px\)\);padding-right:max\(16px,env\(safe-area-inset-right,0px\)\)\}/.test(src), '16px side gutters, wider beside a notch');
  ok(!/\.bar\{padding:|main\{[^}]*padding:\d|\.vstrip-in\{[^}]*padding:0 16px/.test(src.replace(/@media print\{[\s\S]*$/, '')), 'a padding shorthand would undo the safe-area gutters');
  ok(/@media print\{[\s\S]*#top,\.controls,\.pop,\.loaderr,#adminPanel,#toast,#login-gate,\.a2hs,\.no-print\{display:none!important\}/.test(src), 'print hides the controls and the home-screen note');
  ok(/#q\{[^}]*min-width:76px/.test(p), 'the search box never shrinks past "Search": Flagged and More wrap below it instead');
});
check('phone cards stay readable: By Employee times wrap inside their column, the name sticks, secondary marks 13px+ at 4.5:1, nothing reads "0.00 hours" this morning', () => {
  ok(/\.dl-times \.tm,\.dl-times \.pill\{white-space:normal\}/.test(src), 'By Employee times must be able to wrap (they ran under the hours at 320px)');
  const tl = appFn('timesLine');
  ok(/\$\{nbsp\(p\.in\)\}&nbsp;- /.test(tl) && /nbsp\(p\.out\)/.test(tl), 'each clock time stays whole; the only break is after the dash');
  ok(/\.ec-head\{[^}]*position:sticky;top:env\(safe-area-inset-top,0px\)/.test(src) && /\.ec\{overflow:hidden;overflow:clip\}/.test(src), "a By Employee card's name sticks while its lines scroll (clip, not hidden, so it can)");
  const rule = sel => { const m = src.match(new RegExp('\\n  ' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}')); ok(m, 'no rule ' + sel); return m[1]; };
  for (const sel of ['.estm', '.tagm', '.bs-sep']) ok(/color:var\(--muted\)/.test(rule(sel)), sel + ' uses --muted (6.8:1), not --faint (3.65:1)');
  for (const [sel, min] of [['.estm', 13], ['.tagm', 13], ['.pd .brk .bk', 12]]) { const px = +(rule(sel).match(/font-size:([\d.]+)px/) || [])[1]; ok(px >= min, sel + ' is ' + px + 'px, want ' + min + '+'); }
  ok(/onClockOnly\(t\) \? '' : h`<span><b>\$\{hrs\(t\.worked_min\)\}<\/b> hours<\/span>`/.test(appFn('phoneDayHead')), 'a day with only open shifts shows who is clocked in, not 0.00 hours');
});

// ---------------------------------------------------------------------------------------------
// 12. home screen: manifest, icons, Apple tags, the one-time note, sign-in in a home-screen app
// ---------------------------------------------------------------------------------------------
const pngSize = f => {   // width, height, color type from the IHDR chunk
  const b = fs.readFileSync(path.join(ROOT, f));
  ok(b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.toString('latin1', 12, 16) === 'IHDR', f + ' is not a PNG');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), type: b[25] };
};
check('timesheets.webmanifest: valid JSON, the agreed names, start_url and scope, standalone, page colours, 192 + 512 icons for any and maskable', () => {
  const text = fs.readFileSync(path.join(ROOT, 'timesheets.webmanifest'), 'utf8');
  ok(!text.includes('\u2014'), 'em dash in the manifest');
  const m = JSON.parse(text);
  // scope is the page, not the whole salt-flat site: an installed Android app claims every link inside its
  // scope, and the other apps on this site must keep opening in the browser
  eq([m.name, m.short_name, m.start_url, m.scope, m.display], ['Manager Gusto Timesheets', 'Timesheets', './timesheets.html', './timesheets.html', 'standalone']);
  ok(m.id === './timesheets.html', 'id');
  const bg = src.match(/--bg:(#[0-9a-f]{6})/i)[1];
  eq([m.theme_color, m.background_color], [bg, bg], 'colours come from the page tokens');
  for (const size of ['192x192', '512x512']) for (const purpose of ['any', 'maskable'])
    ok(m.icons.some(i => i.sizes === size && i.type === 'image/png' && String(i.purpose).split(/\s+/).includes(purpose)), size + ' ' + purpose);
  for (const i of m.icons) { const n = +i.sizes.split('x')[0], s = pngSize(i.src); eq([s.w, s.h], [n, n], i.src); }
});
check('icons: 192, 512 and the 180 apple-touch icon exist at those sizes, opaque (iPhone turns transparency black)', () => {
  for (const [f, n] of [['timesheets-icon-192.png', 192], ['timesheets-icon-512.png', 512], ['timesheets-apple-touch-icon.png', 180]]) {
    const s = pngSize(f);
    eq([s.w, s.h], [n, n], f);
    ok(s.type === 2, f + ' should be RGB with no alpha (color type 2), got ' + s.type);
  }
});
check('page head: manifest, apple-touch-icon, theme-color, Apple home-screen tags, an SVG favicon', () => {
  const head = src.slice(0, src.indexOf('</head>'));
  ok(/<link rel="manifest" href="timesheets\.webmanifest">/.test(head), 'manifest link');
  ok(/<link rel="apple-touch-icon" href="timesheets-apple-touch-icon\.png">/.test(head), 'apple-touch-icon');
  ok(/<meta name="theme-color" content="#0f1115">/.test(head), 'theme-color');
  ok(/<meta name="apple-mobile-web-app-capable" content="yes">/.test(head) && /<meta name="apple-mobile-web-app-title" content="Timesheets">/.test(head) &&
     /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/.test(head), 'Apple tags');
  ok(/<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,[^"]+">/.test(head), 'SVG favicon');
  for (const f of ['timesheets.webmanifest', 'timesheets-apple-touch-icon.png', 'timesheets-icon-192.png']) ok(fs.existsSync(path.join(ROOT, f)), f + ' missing');
});
check('"Add to Home Screen" note: phones only, never in the home-screen app, once per browser, dismissible, in the page flow', () => {
  const f = appFn('showA2hs');
  ok(/if \(standalone\(\)\) return;/.test(f), 'never in the home-screen app');
  ok(/!phoneLike\(\) \|\| store\.get\('a2hs', ''\) === 'shown'/.test(f) && /store\.set\('a2hs', 'shown'\)/.test(f), 'once per browser, phones only, through the try/catch store');
  ok(/<div class="a2hs" id="a2hs" role="note" hidden>/.test(markup) && /data-act="a2hs-close"/.test(markup), 'dismissible');
  ok(markup.indexOf('id="a2hs"') > markup.indexOf('<main>') && markup.indexOf('id="a2hs"') < markup.indexOf('class="controls"'), 'sits in <main> above the controls, not over the data');
  ok(!/\.a2hs\{[^}]*position:(fixed|absolute)/.test(src), 'must not float over the page');
  ok(/beforeinstallprompt/.test(block('ts-app')) && /e\.prompt\(\)/.test(appFn('installApp')), "Android's install prompt behind the note's Add button");
});
check('sign-in in a home-screen app: an "open in Safari" hint when Google sign-in fails or stalls; the GSI button fits a 320px phone', () => {
  ok(/<div class="login-standalone" id="login-standalone" hidden>[^<]*<a id="login-safari"[^>]*target="_blank"[^>]*>open timesheets in Safari<\/a>/.test(markup), 'hint markup');
  ok(/if \(!standalone\(\)\) return;/.test(appFn('safariHint')), 'only in a home-screen app');
  ok(/and use it there for now\.<span id="login-sa-note"> Signing in to Safari does not sign in this icon\.<\/span><\/div>/.test(markup), 'the hint must not suggest a Safari sign-in carries over to the icon (iPhone keeps them apart)');
  ok(/if \(!isIOS\(\)\) \{ \$\('login-safari'\)\.textContent = 'open timesheets in your browser'; \$\('login-sa-note'\)\.hidden = true; \}/.test(appFn('safariHint')), 'not "Safari" off an iPhone');
  const gis = appFn('showGISButton');
  ok(/click_listener: \(\) => watchSignInStall\(\d+\)/.test(gis) && /safariHint\(true\)/.test(gis), 'a tap that brings no sign-in, or a script that never loads, shows it');
  ok(/Math\.min\(260, \$\('gsi-button'\)\.clientWidth \|\| 260\)/.test(gis), 'button width follows the box');
});

// not a check: a reminder that the page links these files, so they must be committed with it, by name
try {
  const files = ['timesheets.webmanifest', 'timesheets-icon-192.png', 'timesheets-icon-512.png', 'timesheets-apple-touch-icon.png'];
  const tracked = execFileSync('git', ['ls-files', '--', ...files], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n').filter(Boolean);
  const missing = files.filter(f => !tracked.includes(f));
  if (missing.length) console.log('\n  NOTE  not in git yet (the page links them; git add them by name with timesheets.html): ' + missing.join(' '));
} catch (e) { /* not a git checkout */ }
console.log(bad ? `\n✗ ${bad} of ${count} check(s) failed, do not push` : `\n✓ all ${count} checks passed`);
process.exit(bad ? 1 : 0);
