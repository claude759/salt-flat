// node tests/timesheets-check.mjs : checks for the Manager Gusto Timesheets page (timesheets.html).
// Runs the page's pure logic (<script id="ts-core">) and demo data (<script id="ts-demo">) in a vm,
// plus static checks on the file. Synthetic data only; nothing here reads or writes the database.
// Exit 0 = safe to push. Any FAIL = do not push; fix first.
//
// The whole run happens with the machine clock set to New Zealand time, so any place that leans on the
// viewer's own time zone instead of the row's company zone (America/Los_Angeles for California,
// America/New_York for Wizard Trees NY) shows up as a failure.
process.env.TZ = 'Pacific/Auckland';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  // the browser task still signs its Gusto notes "Changed through Wizard Trees Manager Timesheets for <email>" (its
  // noteFor), and the page reads those notes back (C.APP_EDIT_PREFIX): that line is Gusto's text, not the page's name
  ok(!/Manager Timesheets/.test(src.split(C.APP_EDIT_PREFIX).join('')), 'the old name "Manager Timesheets" is still in the file');
  eq(C.APP_EDIT_PREFIX, 'Changed through Wizard Trees Manager Timesheets for', "the browser task's own words");
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
  ok(/function crewInfo\(\) \{ return C\.crewsFor\(viewer\(\), S\.views, S\.region\); \}/.test(app), 'the tabs come from crewsFor for the active region (Everyone only for admins; a preview gets the previewed sign-in\'s tabs)');
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
  ok(/C\.buildCsv\(rows, \{ companyName: coName, flat: layout\(\)\.flat, edits: editsLoaded\(\) \}\)/.test(appFn('exportCsv')), 'CSV follows the layout');
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
check('number columns line up: est. and + hang to the right of the number, never push it left; totals use the same padding', () => {
  ok(/\.ts \.nslot abbr\.est\{position:absolute;left:100%/.test(src) && /\.ts \.nslot \.plus\{position:absolute;left:100%/.test(src), 'est. and + must sit outside the number');
  ok(/\.ts th\.c-ot,\.ts td\.c-ot\{padding-right:38px\}/.test(src) && /\.ts th\.c-hours,\.ts td\.c-hours\{padding-right:18px\}/.test(src), 'header and cells share the reserved padding');
  ok(/<span class="nslot"><span class="ot">\$\{hrs\(ot\)\}<\/span>/.test(appFn('otCell')), 'otCell wraps the number in a slot');
  ok((src.match(/class="num c-hours">\$\{(minCell|hrs)\(t\.worked_min\)\}/g) || []).length === 2, 'group and total Hours cells need c-hours (else 8px off)');
  ok(/class="num c-hours" title="Hours worked/.test(src) && /class="num c-ot">OT<\/th>/.test(src), 'headers carry the column classes');
});
check('break policy line: one quiet sentence; company names only where the page shows companies', () => {
  const nm = { filifera: 'Filifera', slane: 'Slane', wafgus: 'Waf & Gus', imperial: 'Imperial' };
  eq(C.breakPolicyText(['filifera', 'slane', 'wafgus', 'imperial'], k => nm[k]),
    'Breaks: a paid rest break every 4 hours (10 min at Imperial, 15 min at Filifera, Slane and Waf & Gus), and an unpaid 30-min meal by the 5th hour (a second after 10 hours).');
  eq(C.breakPolicyText(['imperial', 'wafgus'], null), 'Breaks: a paid 10 or 15-min rest break every 4 hours, and an unpaid 30-min meal by the 5th hour (a second after 10 hours).', 'a crew list never names companies');
  eq(C.breakPolicyText(['filifera', 'wafgus'], null), 'Breaks: a paid 15-min rest break every 4 hours, and an unpaid 30-min meal by the 5th hour (a second after 10 hours).', 'Filifera moved to 15-min rests on 2026-10-12');
  eq(C.breakPolicyText(['wafgus'], null), 'Breaks: a paid 15-min rest break every 4 hours, and an unpaid 30-min meal by the 5th hour (a second after 10 hours).');
  ok(/C\.breakPolicyText\(keys, lay\.flat \? null : coName, S\.region\)/.test(src), 'renderPolicy must pass no names in a flat (crew) layout and the active region');
  const rp = appFn('renderPolicy');
  ok(/setHTML\(el, h`<span class="pol-k">Break policy<\/span>/.test(rp) && !/innerHTML/.test(rp), 'the policy box goes through setHTML(h``), never raw HTML');
  ok(/\.policy\{display:flex[^}]*border-left:3px solid var\(--accent\)/.test(src), 'the policy is a highlighted box, not fine print');
});
check('marks explain themselves on click or tap: i, est., note and flag pills open a bubble (hover alone did nothing on phones)', () => {
  ok(/<div id="tipPop" class="tip-pop" role="tooltip" hidden><\/div>/.test(src), 'the shared bubble element is missing');
  ok(/const TIP_SEL = '\.infomark, abbr\.est, \.notemark, \.flag';/.test(src), 'the marks that open the bubble');
  const oc = appFn('onClick');
  ok(/const tipEl = e\.target\.closest\(TIP_SEL\);/.test(oc) && /showTip\(tipEl\)/.test(oc), 'a click on a mark must open its bubble');
  ok(/t\.textContent = text;/.test(appFn('showTip')), 'the bubble text must go in as text, never HTML');
  ok(/e\.key === 'Enter' \|\| e\.key === ' '/.test(src), 'Enter or Space on a focused mark opens it too');
  ok(!/hover for why|hover to read it/.test(src), 'the Key still says hover');
});
check('full viewer (every company and department granted, not admin): the admin\'s page with their views as tabs, no Admin', () => {
  const ALL = [{ company: '*', department: '*' }];
  const fv = MGR(['harvest', 'trim', 'golf'], ALL);
  ok(C.fullViewer(fv), 'a (*,*) grant makes a full viewer');
  const c = C.crewsFor(fv, KNOWN);
  eq([c.everyone, c.list.map(x => x.id)], [true, ['trim', 'golf', 'harvest']], 'Everyone + their views in tab order, no "All my people"');
  ok(!C.fullViewer(MGR(['trim'], [{ company: '*', department: 'Trim' }])), 'a partial grant is still a manager');
  ok(!C.fullViewer(MGR(['trim'], ALL, { active: false })), 'turned off: not a full viewer');
  ok(!C.fullViewer({ active: true, is_admin: true, grants: ALL }), 'an admin is an admin, not a full viewer');
  eq(C.crewsFor(MGR(['trim', 'missing'], ALL), KNOWN).list.map(x => x.id), ['trim'], 'a view whose members did not load is left out, Everyone still works');
  ok(/function managerMode\(\) \{[^}]*!C\.fullViewer\(v, S\.region\)/.test(src), 'managerMode must exclude full viewers (they get the grouped Everyone page), in California only');
  ok(/\$\('adminBtn'\)\.hidden = !\(me && me\.is_admin\)/.test(src), 'the Admin button stays admins-only');
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
const SPEC_FLAGS = ['no_meal', 'late_meal', 'short_meal', 'no_second_meal', 'few_rest', 'short_rest', 'break_open', 'missed_out', 'long_day', 'type_unsure', 'gusto_mismatch',
  // the producer's data-error flags (2026-10-24): warnings, labelled on the board
  'tiny_shift', 'midnight_split', 'long_rest', 'shift_overlap',
  // a person who clocks in outside Pacific time (the producer's personAway, review 2026-10-25): an info note
  'other_zone'];
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
  ok(/function rolledPreset\(\) \{[\s\S]*?C\.presetRange\(S\.preset, today\(\), regionDef\(\)\)/.test(app), 'rolledPreset() recomputes from today() on the active region\'s calendar');
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
const DEMO_VIEW_LABELS = ['Trim Crew', 'Grow Team', 'Ambassadors', 'Office and Drivers', 'Packing and Distro'];   // made-up crews, no person's name
const DEMO_CA_VIEWS = 4;   // the first four are California crews; the last is the New York one
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
  // 'Claude Claude' is Gusto's name for the sign-in the browser task writes notes as (the demo's app notes), not a person
  const allowed = new Set(D.ROSTER.flatMap(r => r.filter(x => typeof x === 'string')).concat(DEMO_VIEW_LABELS, ['Claude Claude']));
  const lits = [...demoSrc.matchAll(/'([A-Z][a-z]+(?: [A-Z][a-z]+)+)'/g)].map(m => m[1]);
  const strays = [...new Set(lits.filter(s => !allowed.has(s)))];
  ok(lits.length > 30 && !strays.length, 'name-like literals in ts-demo that are not on the roster: ' + J(strays));
  const rest = src.replace(demoSrc, '');
  const leaked = D.NAMES.filter(n => rest.includes(n) || rest.includes(n.split(' ')[1]));
  ok(!leaked.length, 'demo names used outside the demo block: ' + J(leaked));
  ok(!/'[A-Z][a-z]+ View'|"[A-Z][a-z]+ View"|>[A-Z][a-z]+ View</.test(src), 'a hard-coded "<Name> View" label; saved views come from the database');
});
check('demo covers all four CA companies and Wizard Trees NY, several departments, every flag, both label sources, open + hours-entered days, OT est + Gusto', () => {
  eq([...new Set(demo.rows.map(r => r.company))].sort(), ['filifera', 'imperial', 'slane', 'wafgus', 'wtny']);
  ok(new Set(demo.rows.map(r => r.company + '/' + r.department)).size >= 8, 'want 8+ departments');
  ok(demo.rows.some(r => r.department === 'No department'), 'a No department row');
  const codes = new Set(demo.rows.flatMap(r => r.flags.map(f => f.code)));
  // other_zone is the producer's verdict on a person over all their days (personAway): the demo has no one out of state
  const missing = SPEC_FLAGS.filter(c => !codes.has(c) && c !== 'other_zone');
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
    const missing = SPEC_FLAGS.filter(c => !codes.has(c) && c !== 'other_zone');   // the producer's, per person (see above)
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
      // notes: only on a shift that has some (the sync leaves the key out otherwise), shaped like the sync writes them
      eq(Object.keys(s).filter(k => k !== 'notes').sort(), ['breaks', 'hours_only', 'id', 'in', 'out', 'span_min', 'worked_min'], 'shift keys');
      if ('notes' in s) {
        ok(Array.isArray(s.notes) && s.notes.length, 'notes on ' + s.id + ' are a list with something in it');
        for (const n of s.notes) {
          eq(Object.keys(n).sort(), ['app', 'at', 'author', 'by', 'kind', 'src', 'text'], 'note keys');
          ok(['note', 'edit', 'other'].includes(n.kind) && ['csv', 'gusto'].includes(n.src) && typeof n.app === 'boolean', 'note ' + J(n));
          ok(n.app ? /@wizardtrees\.com$/.test(n.by) && n.kind !== 'other' : n.by === null && n.kind === 'other', 'app notes carry their manager: ' + J(n));
          // the morning export has no times; Gusto's read has them, except on claude@'s lines (no one line owns its time)
          ok(n.at === null ? (n.src === 'csv' || (n.app && n.src === 'gusto')) : !isNaN(Date.parse(n.at)) && n.src === 'gusto' && !n.app, 'the morning export has no times');
        }
      }
      for (const b of s.breaks) {
        eq(Object.keys(b).sort(), ['end', 'kind', 'min', 'open', 'paid', 'src', 'start'], 'break keys');
        ok((b.kind === 'rest' || b.kind === 'meal') && b.paid === (b.kind === 'rest') && (b.src === 'gusto' || b.src === 'rule'), 'break ' + J(b));
        if (b.src === 'rule') ok(b.kind === (b.min <= 20 ? 'rest' : 'meal'), 'length rule ' + J(b));
      }
    }
  }
});
check('demo arithmetic holds: worked = span - unpaid, break totals, OT split, Gusto labels only before the CSV day', () => {
  for (const r of demo.rows) {
    const closed = r.shifts.filter(s => s.out && !s.hours_only);
    for (const s of closed) eq(s.worked_min, s.span_min - s.breaks.filter(b => !b.paid).reduce((a, b) => a + b.min, 0), 'shift ' + s.id);
    eq(r.worked_min, r.shifts.reduce((a, s) => a + s.worked_min, 0), 'day worked ' + r.id);
    eq(r.paid_break_min, r.shifts.flatMap(s => s.breaks).filter(b => b.paid).reduce((a, b) => a + b.min, 0), 'paid ' + r.id);
    eq(r.unpaid_break_min, r.shifts.flatMap(s => s.breaks).filter(b => !b.paid).reduce((a, b) => a + b.min, 0), 'unpaid ' + r.id);
    if (r.reg_min != null) eq(r.reg_min + r.ot_min + r.dt_min, r.worked_min, 'reg+ot+dt ' + r.id);
    if (r.flags.some(f => f.code === 'gusto_mismatch')) ok(Math.abs(r.gusto_total_min - r.worked_min) > 1, 'mismatch is real');
    const rToday = demo.todays[r.region];   // each row's own region clock (New York's day starts first)
    if (r.work_date >= rToday) ok(r.shifts.every(s => s.breaks.every(b => b.src === 'rule')), 'today has no Gusto labels yet');
    ok(r.work_date <= rToday, 'no future rows');
  }
});
check('demo views: 4 made-up California crews and 1 New York crew over demo people only, valid ids, each with days this pay period', () => {
  const vs = C.normViews(demo.views);
  eq(vs.length, 5, 'views');
  eq(vs.map(v => v.label), DEMO_VIEW_LABELS, 'labels (in order)');
  eq(vs.map(v => C.viewRegions(v).join('+')), ['CA', 'CA', 'CA', 'CA', 'NY'], 'regions');
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
  ok(/C\.flagMsg\(f, r\.region\)/.test(db) && /notesList\(r, rowNotes\(r\)\)/.test(db) && /breaksCell\(r\)/.test(db), 'the detail body writes out flags, the notes and the break chips (phones have no tooltips)');
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
  ok(/\$\{tint\(p\.edIn, nbsp\(p\.in\)\)\}&nbsp;- /.test(tl) && /tint\(p\.edOut, nbsp\(p\.out\)\)/.test(tl), 'each clock time stays whole; the only break is after the dash');
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

// ---------------------------------------------------------------------------------------------
// 13. New York (Wizard Trees NY, company wtny): its own region tab, Eastern clock times, weekly-only
//     overtime, its own break rule. California must read exactly as before.
// ---------------------------------------------------------------------------------------------
const NYR = o => row(Object.assign({ company: 'wtny', dept: 'Distro Hourly' }, o, { extra: Object.assign({ region: 'NY' }, o.extra || {}) }));
check('regions: California (Pacific) and New York (Eastern); wtny is New York, every CA company is Pacific', () => {
  eq(C.REGIONS.map(g => [g.key, g.label, g.tz]), [['CA', 'California', 'America/Los_Angeles'], ['NY', 'New York', 'America/New_York']]);
  eq(C.REGIONS.find(g => g.key === 'NY').companies, ['wtny']);
  eq(C.COMPANY_TZ, { filifera: 'America/Los_Angeles', slane: 'America/Los_Angeles', wafgus: 'America/Los_Angeles', imperial: 'America/Los_Angeles', wtny: 'America/New_York' });
  eq(['filifera', 'wtny', 'nobody'].map(k => C.regionOfCompany(k)), ['CA', 'NY', 'CA'], 'unknown companies are California');
  eq(C.regionOfCompany('newco', [{ key: 'newco', region: 'NY' }]), 'NY', 'a ts_companies row says where a new company is');
  eq(C.rowTz({ company: 'wtny' }), 'America/New_York');
  eq(C.rowTz({ company: 'slane', region: 'CA' }), 'America/Los_Angeles');
  eq(C.rowTz({ company: 'newco', region: 'NY' }), 'America/New_York', 'unknown company: its region\'s zone');
  eq(C.rowTz({}), 'America/Los_Angeles');
  eq(C.COMPANY_NAMES.wtny, 'Wizard Trees NY');
  eq(C.normRow({ id: 'x', company: 'wtny', employee_uuid: 'n', work_date: '2026-10-06' }).region, 'NY', 'a row without a region takes its company\'s');
  eq(C.normRow({ id: 'x', company: 'filifera', employee_uuid: 'n', work_date: '2026-10-06' }).region, 'CA');
});
check('per-row clock: an 8:00 AM Eastern punch shows 8:00 AM on a New York row, and the same instant 5:00 AM on a California row', () => {
  const inET = '2026-10-06T08:00:00-04:00', outET = '2026-10-06T16:30:00-04:00';
  const ny = NYR({ uuid: 'n1', name: 'Test Nyla', date: '2026-10-06', extra: { first_in: inET, last_out: outET, shifts: [{ id: 's', in: inET, out: outET, span_min: 510, worked_min: 480, hours_only: false, breaks: [] }] } });
  const ca = row({ company: 'filifera', uuid: 'c1', name: 'Test Cali', dept: 'Trim', date: '2026-10-06', extra: { first_in: inET, last_out: outET, shifts: [{ id: 's', in: inET, out: outET, span_min: 510, worked_min: 480, hours_only: false, breaks: [] }] } });
  eq(C.fmtTime(inET, C.rowTz(ny)), '8:00 AM'); eq(C.fmtTime(inET, C.rowTz(ca)), '5:00 AM');
  eq(C.fmtTime(inET), '5:00 AM', 'no zone given: Los Angeles, as before');
  eq(C.shiftsText(ny), '8:00 AM - 4:30 PM'); eq(C.shiftsText(ca), '5:00 AM - 1:30 PM');
  eq(C.fmtClock('2026-10-06T13:04:00-04:00', 'America/New_York'), '1:04');
  eq(C.fmtTime('2026-12-01T13:05:00Z', 'America/New_York'), '8:05 AM', 'winter, EST');
  const p = parseCsv(C.buildCsv([ca, ny], { companyName: k => C.COMPANY_NAMES[k] }));
  eq(p.slice(1).map(c => [c[1], c[5], c[6]]), [['Filifera', '5:00 AM', '1:30 PM'], ['Wizard Trees NY', '8:00 AM', '4:30 PM']], 'CSV First in / Last out per row');
});
check('a late-evening Eastern shift stays on its New York date; "today" turns over at New York midnight', () => {
  eq(C.zDate('2026-10-08T03:30:00Z', 'America/New_York'), '2026-10-07', '11:30 PM EDT is still the 7th');
  eq(C.fmtTime('2026-10-08T03:30:00Z', 'America/New_York'), '11:30 PM');
  eq(C.todayIn('America/New_York', new Date('2026-10-08T04:30:00Z')), '2026-10-08', '12:30 AM EDT');
  eq(C.todayLA(new Date('2026-10-08T04:30:00Z')), '2026-10-07', 'still 9:30 PM in Los Angeles');
  eq(C.zIso('2026-10-06', 480, 'America/New_York'), '2026-10-06T08:00:00-04:00');
  eq(C.zIso('2026-12-01', 480, 'America/New_York'), '2026-12-01T08:00:00-05:00');
  eq(C.zIso('2026-10-06', 1439 + 59 / 60, 'America/New_York'), '2026-10-06T23:59:59-04:00');
  eq(C.zIso('2026-10-06', 632, C.TZ), C.laIso('2026-10-06', 632), 'laIso is zIso in Los Angeles');
  // an automatic 11:59:59 PM clock-out counts as midnight on the row's own clock
  eq(C.gustoMinute('2026-10-06T23:59:59-04:00', 'America/New_York') - C.gustoMinute('2026-10-06T23:00:00-04:00', 'America/New_York'), 60);
  eq(C.gustoMinute('2026-10-06T23:59:59-04:00') - C.gustoMinute('2026-10-06T23:00:00-04:00'), 59, 'in Los Angeles that instant is 8:59:59 PM, nothing special');
});
check('sync times read on the company\'s clock: "Synced 2:20 PM" for New York is 11:20 AM in California', () => {
  const now = new Date('2026-10-08T18:30:00Z');
  const ny = { key: 'wtny', region: 'NY', connected: true, last_sync_at: '2026-10-08T18:20:00Z', label_csv_at: '2026-10-08T09:10:00Z' };
  const ca = { key: 'filifera', region: 'CA', connected: true, last_sync_at: '2026-10-08T18:20:00Z', label_csv_at: '2026-10-08T09:10:00Z' };
  eq(C.freshness(ny, now).sync, 'Synced 2:20 PM'); eq(C.freshness(ca, now).sync, 'Synced 11:20 AM');
  eq(C.freshSummary([ny], now).short, 'Synced 2:20');
  eq(C.freshness(ny, now).labels, 'Break labels from Gusto through Oct 7');
  eq(C.freshness({ key: 'wtny', connected: true, last_sync_at: '2026-10-08T03:50:00Z' }, new Date('2026-10-08T05:00:00Z')).sync, 'Synced yesterday, 11:50 PM', 'yesterday on the New York calendar');
});
check('presets per region: New York periods end Fridays from 2026-03-13 (the same 14-day grid as California), worked out on its own calendar', () => {
  const NY = C.regionDef('NY');
  eq([NY.anchorEnd, C.dow(NY.anchorEnd), NY.weekStart], ['2026-03-13', 5, 6]);
  for (let d = '2026-01-01'; d <= '2027-03-31'; d = C.addDays(d, 1))
    for (const id of ['period', 'lastperiod', 'week', 'lastweek']) eq(C.presetRange(id, d, 'NY'), C.presetRange(id, d, 'CA'), id + ' ' + d);
  eq(C.presetRange('period', '2026-10-08', 'NY'), { from: '2026-09-26', to: '2026-10-09' });
  eq(C.presetRange('period', '2026-10-08'), C.presetRange('period', '2026-10-08', 'CA'), 'no region = California, as before');
  // Friday 9:30 PM in California is already Saturday in New York: the New York tab is on the next period
  const t = new Date('2026-10-10T04:30:00Z');
  eq(C.presetRange('period', C.todayLA(t), 'CA'), { from: '2026-09-26', to: '2026-10-09' });
  eq(C.presetRange('period', C.todayIn(NY.tz, t), 'NY'), { from: '2026-10-10', to: '2026-10-23' });
  // and a region with another anchor computes its own periods
  eq(C.presetRange('period', '2026-10-08', { key: 'XX', anchorEnd: '2026-10-02', weekStart: 6 }), { from: '2026-10-03', to: '2026-10-16' });
  ok(/function defaultWindow\(\) \{[\s\S]*?C\.regionsPresent\(S\.companies, \[\]\)[\s\S]*?C\.presetRange\('lastperiod', t, g\)/.test(block('ts-app')), 'the first load covers every region\'s last and current period');
});
check('break policy line per region: California unchanged, New York one short sentence', () => {
  const nm = { filifera: 'Filifera', slane: 'Slane', wafgus: 'Waf & Gus', imperial: 'Imperial' };
  eq(C.breakPolicyText(['wtny'], k => 'Wizard Trees NY', 'NY'), 'Breaks: an unpaid 30-min meal on shifts over 6 hours; breaks of 20 min or less are paid.');
  eq(C.breakPolicyText(['wtny'], null, 'NY'), 'Breaks: an unpaid 30-min meal on shifts over 6 hours; breaks of 20 min or less are paid.');
  eq(C.breakPolicyText(['filifera', 'slane', 'wafgus', 'imperial'], k => nm[k], 'CA'), C.breakPolicyText(['filifera', 'slane', 'wafgus', 'imperial'], k => nm[k]), 'CA with or without the region');
});
check('New York flags: same codes, New York words (a meal on a shift over 6 hours); the row\'s own msg always wins', () => {
  eq(C.FLAG_CODES.length, SPEC_FLAGS.length, 'no new codes');
  eq(C.flagMsg({ code: 'no_meal' }, 'NY'), 'No meal break on a shift over 6 hours');
  eq(C.flagMsg({ code: 'short_meal' }, 'NY'), 'Meal break under 30 min');
  eq(C.flagMsg({ code: 'no_meal' }, 'CA'), 'No meal break on a shift over 5 hours');
  eq(C.flagMsg({ code: 'no_meal' }), 'No meal break on a shift over 5 hours');
  eq(C.flagMsg({ code: 'no_meal', msg: 'from the producer' }, 'NY'), 'from the producer');
  eq(C.flagMsg({ code: 'break_open' }, 'NY'), 'Break never ended in Gusto', 'shared rules keep their words');
  ok(C.flagsHtml([{ code: 'no_meal', sev: 'warn' }], 'NY').html.includes('title="No meal break on a shift over 6 hours"'), 'the pill tooltip');
  ok(/C\.flagsHtml\(r\.flags, r\.region\)/.test(appFn('flagsCell')) && /flagMsg\(f, r\.region\)/.test(block('ts-core')), 'table cells and the CSV pass the row region');
});
// views over both regions (synthetic)
const NYVIEWS = C.normViews([
  { id: 'trim', label: 'Test Trim', sort: 10, members: [{ company: 'filifera', department: 'Trim' }] },
  { id: 'pack', label: 'Test Pack', sort: 20, members: [{ company: 'wtny', department: 'Distro Hourly' }] },
  { id: 'both', label: 'Test Both', sort: 30, members: [{ company: 'slane', department: 'Harvest' }, { company: 'wtny', employee_uuid: 'n2' }] },
]);
const NYMGR = (views, grants, extra) => Object.assign({ email: 'm@wizardtrees.com', active: true, is_admin: false, grants: grants || [], views: C.viewsFor(views, NYVIEWS) }, extra || {});
const ADMIN = { email: 'a@wizardtrees.com', active: true, is_admin: true, grants: [], views: [] };
check('view tabs follow the region: a view whose members are all in the other region is not shown there; Everyone is the region\'s companies', () => {
  eq(C.crewsFor(ADMIN, NYVIEWS, 'CA').list.map(c => c.id), ['trim', 'both']);
  eq(C.crewsFor(ADMIN, NYVIEWS, 'NY').list.map(c => c.id), ['pack', 'both']);
  eq(C.crewsFor(ADMIN, NYVIEWS).list.map(c => c.id), ['trim', 'both'], 'no region = California');
  eq(C.crewsFor(NYMGR(['pack']), NYVIEWS, 'NY').list.map(c => c.id), ['pack']);
  eq(C.crewsFor(NYMGR(['pack']), NYVIEWS, 'CA').list.map(c => c.id), [], 'not offered in California');
  eq(C.crewsFor(NYMGR(['trim', 'pack']), NYVIEWS, 'CA').list.map(c => c.id), ['trim']);
  eq(C.crewsFor(NYMGR(['pack'], [{ company: 'slane', department: '*' }]), NYVIEWS, 'NY').list.map(c => c.id), ['pack'], '"All my people" only where the grants reach');
  eq(C.crewsFor(NYMGR(['pack'], [{ company: 'wtny', department: 'BA Hourly' }]), NYVIEWS, 'NY').list.map(c => c.id), ['pack', C.ALL_MINE]);
  eq(C.viewRegions(NYVIEWS[2]), ['CA', 'NY']); eq(C.viewRegions({ members: [] }), ['CA']);
  const cos = [{ key: 'filifera', region: 'CA' }, { key: 'wtny', region: 'NY' }];
  eq(C.visibleCompanyKeys(ADMIN, cos, [], 'NY', []), ['wtny'], 'Everyone in New York = its companies');
  eq(C.visibleCompanyKeys(ADMIN, cos, [], 'CA', []), ['filifera']);
  const rows = [NYR({ uuid: 'n1', name: 'Test Nyla', date: '2026-10-06' }), row({ company: 'filifera', uuid: 'c1', name: 'Test Cali', dept: 'Trim', date: '2026-10-06' })];
  eq(C.filterRows(rows, { region: 'NY' }).map(r => r.company), ['wtny']);
  eq(C.filterRows(rows, { region: 'CA' }).map(r => r.company), ['filifera']);
});
check('region tabs: an admin gets New York once its company or rows exist; anyone else the regions their grants, views and rows reach', () => {
  const caCos = ['filifera', 'slane', 'wafgus', 'imperial'].map(key => ({ key, region: 'CA' }));
  const withNY = caCos.concat([{ key: 'wtny', region: 'NY' }]);
  eq(C.viewerRegions(ADMIN, caCos, []), ['CA'], 'before the wtny row: California only, exactly as today');
  eq(C.viewerRegions(ADMIN, withNY, []), ['CA', 'NY']);
  eq(C.viewerRegions(ADMIN, caCos, [NYR({ uuid: 'n1', name: 'Test Nyla', date: '2026-10-06' })]), ['CA', 'NY'], 'or once a New York row loads');
  eq(C.regionsPresent([], []), ['CA']);
  eq(C.viewerRegions(NYMGR(['pack']), withNY, []), ['NY'], 'a New York-only manager');
  eq(C.viewerRegions(NYMGR(['trim']), withNY, []), ['CA']);
  eq(C.viewerRegions(NYMGR(['trim', 'pack']), withNY, []), ['CA', 'NY']);
  eq(C.viewerRegions(NYMGR([], [{ company: 'wtny', department: '*' }]), withNY, []), ['NY'], 'a New York grant');
  eq(C.viewerRegions(NYMGR([], [{ company: 'slane', department: 'Harvest' }]), withNY, []), ['CA']);
  eq(C.viewerRegions(NYMGR([], []), withNY, [NYR({ uuid: 'n1', name: 'Test Nyla', date: '2026-10-06' })]), ['NY'], 'rows the server let through');
  eq(C.viewerRegions(NYMGR([], []), withNY, []), ['CA'], 'nothing yet: California (the "nothing shared" page)');
  eq(C.viewerRegions(NYMGR(['pack'], [], { active: false }), withNY, []), ['CA'], 'turned off');
  eq(C.pickRegion(['NY'], ['CA']), 'NY', 'a New York-only sign-in lands on New York, whatever was remembered');
  eq(C.pickRegion(['CA'], ['NY']), 'CA', 'and a California-only one on California');
  eq(C.pickRegion(['CA', 'NY'], ['', 'NY']), 'NY', 'an admin gets the region remembered in this browser');
  eq(C.pickRegion(['CA', 'NY'], ['NY', 'CA']), 'NY', 'a ?view= link\'s region comes first');
  eq(C.pickRegion(['CA', 'NY'], []), 'CA');
  eq(C.pickRegion([], []), 'CA');
});
check('full viewers ("*", "*") stay California: "*" is every CA company (the server rule), never New York', () => {
  const ALL = [{ company: '*', department: '*' }];
  const fv = NYMGR([], ALL);
  ok(C.fullViewer(fv) && C.fullViewer(fv, 'CA') && !C.fullViewer(fv, 'NY'), 'a full viewer in California only');
  const withNY = [{ key: 'filifera', region: 'CA' }, { key: 'wtny', region: 'NY' }];
  eq(C.viewerRegions(fv, withNY, []), ['CA'], 'no New York tab');
  eq(C.viewerRegions(NYMGR(['pack'], ALL), withNY, []), ['CA', 'NY'], 'unless they are also given a New York view');
  ok(!C.canView(fv, 'wtny', 'Distro Hourly', 'n1', 'NY') && !C.canView(fv, 'wtny', 'Distro Hourly', 'n1'), 'canView: "*" never reaches a New York row');
  ok(C.canView(fv, 'filifera', 'Trim', 'c1', 'CA') && C.canView(fv, 'imperial', 'Trim'), 'every California row');
  ok(!C.canView(NYMGR([], [{ company: '*', department: 'Distro Hourly' }]), 'wtny', 'Distro Hourly', 'n1', 'NY'), 'nor does a "*" company with one department');
  ok(C.canView(NYMGR([], [{ company: 'wtny', department: '*' }]), 'wtny', 'Distro Hourly', 'n1', 'NY'), 'a grant that names wtny does');
  const rows = [NYR({ uuid: 'n1', name: 'Test Nyla', date: '2026-10-06' }), row({ company: 'filifera', uuid: 'c1', name: 'Test Cali', dept: 'Trim', date: '2026-10-06' })];
  eq(C.filterRows(rows, { viewer: fv }).map(r => r.company), ['filifera']);
  eq(C.visibleCompanyKeys(fv, withNY, [], 'NY', [{ company: 'wtny', department: 'Distro Hourly', active: true }]), [], 'no New York company chips');
  eq(C.visibleCompanyKeys(NYMGR([], [{ company: '*', department: 'Distro Hourly' }]), withNY, [], 'NY', [{ company: 'wtny', department: 'Distro Hourly', active: true }]), []);
  eq(C.visibleCompanyKeys(fv, withNY, [], 'CA', []), ['filifera']);
  const c = C.crewsFor(NYMGR(['pack', 'trim'], ALL), NYVIEWS, 'NY');
  eq([c.everyone, c.list.map(x => x.id)], [false, ['pack']], 'in New York they are a manager with their New York views');
  eq(C.grantsIn(ALL, 'NY'), []); eq(C.grantsIn(ALL, 'CA'), ALL);
});
check('"All CA" plus a New York grant keeps both (the server does): normalised, described, regions, tabs and rows', () => {
  const both = [{ company: '*', department: '*' }, { company: 'wtny', department: '*' }];
  eq(C.normalizeGrants(both), both, 'the New York grant is not swallowed by "All CA"');
  eq(C.normalizeGrants([{ company: 'wtny', department: 'BA Hourly' }, { company: 'slane', department: 'Harvest' }, { company: '*', department: 'Trim' },
    { company: 'wtny', department: '*' }, { company: '*', department: '*' }]), both, 'California grants it covers go, New York ones stay (whole company wins)');
  eq(C.normalizeGrants([{ company: 'wtny', department: 'BA Hourly' }, { company: '*', department: '*' }]),
    [{ company: '*', department: '*' }, { company: 'wtny', department: 'BA Hourly' }]);
  eq(C.normalizeGrants([{ company: '*', department: '*' }, { company: 'filifera', department: '*' }]), [{ company: '*', department: '*' }], 'California only: as before');
  eq(C.describeGrants(both), 'All CA · Wizard Trees NY: all departments');
  eq(C.describeGrants([{ company: '*', department: '*' }, { company: 'wtny', department: 'Distro Hourly' }, { company: 'wtny', department: 'BA Hourly' }]),
    'All CA · Wizard Trees NY: BA Hourly, Distro Hourly');
  eq(C.describeAccess({ is_admin: false, views: [], grants: both }, NYVIEWS), 'All CA · Wizard Trees NY: all departments', 'the sign-ins list and the preview bar');
  const fv = NYMGR([], both), withNY = [{ key: 'filifera', region: 'CA' }, { key: 'wtny', region: 'NY' }];
  ok(C.fullViewer(fv, 'CA') && !C.fullViewer(fv, 'NY'), 'still the full page in California, a manager in New York');
  eq(C.viewerRegions(fv, withNY, []), ['CA', 'NY'], 'both region tabs');
  eq(C.grantsIn(both, 'NY'), [both[1]]); eq(C.grantsIn(both, 'CA'), [both[0]]);
  eq(C.crewsFor(NYMGR(['pack'], both), NYVIEWS, 'NY').list.map(c => c.id), ['pack', C.ALL_MINE], '"All my people" in New York');
  ok(C.canView(fv, 'wtny', 'Distro Hourly', 'n1', 'NY') && C.canView(fv, 'filifera', 'Trim', 'c1', 'CA'), 'rows in both regions');
  ok(/const grants = C\.normalizeGrants\(\[\.\.\.ed\.grants\]\.map\(C\.grantFromKey\)\);/.test(appFn('saveEditor')), 'Save sends the normalised grants');
});
check('demo New York: Wizard Trees NY with made-up people in Cultivation Hourly, BA Hourly and Distro Hourly, Eastern punches, a New York view and a New York-only sign-in', () => {
  const co = demo.companies.find(c => c.key === 'wtny');
  ok(co && co.region === 'NY' && co.connected && co.name === 'Wizard Trees NY', 'the demo company');
  const ny = demo.rows.filter(r => r.company === 'wtny');
  ok(ny.length > 20 && ny.every(r => r.region === 'NY'), 'New York rows');
  eq([...new Set(ny.map(r => r.department))].sort(), ['BA Hourly', 'Cultivation Hourly', 'Distro Hourly']);
  ok(ny.every(r => D.NAMES.includes(r.employee_name)), 'made-up names from the roster');
  ok(ny.every(r => r.shifts.every(s => /-0[45]:00$/.test(s.in))), 'punches carry an Eastern offset');
  ok(demo.rows.filter(r => r.region === 'CA').every(r => r.shifts.every(s => /-0[78]:00$/.test(s.in))), 'California punches stay Pacific');
  ok(ny.some(r => r.shifts.some(s => s.out && C.zMinutes(s.out, 'America/New_York') >= 23 * 60 && C.zDate(s.out, 'America/New_York') === r.work_date)), 'a late-evening Eastern shift on its own date');
  ok(ny.some(r => r.flags.some(f => f.code === 'no_meal' && f.msg === 'No meal break on a shift over 6 hours')), 'a New York no_meal');
  ok(ny.some(r => r.flags.some(f => f.code === 'short_meal')), 'a New York short_meal');
  // the producer's New York meal rule: one warning at most, and none once a 30-min meal (or 30 min off the clock) exists
  const has = (r, c) => r.flags.some(f => f.code === c);
  ok(ny.every(r => !(has(r, 'no_meal') && has(r, 'short_meal'))), 'never both no_meal and short_meal');
  ok(ny.every(r => !(has(r, 'no_meal') || has(r, 'short_meal')) || (r.worked_min > 360 &&
    !r.shifts.some(s => s.breaks.some(b => b.kind === 'meal' && !b.open && b.min >= 30)) && !C.shiftGaps(r.shifts, 'America/New_York').some(g => g.min >= 30))),
    'a meal warning only on a shift over 6 hours with no 30-min meal');
  ok(ny.every(r => !has(r, 'short_meal') || r.shifts.some(s => s.breaks.some(b => b.kind === 'meal' && !b.open))), 'short_meal only when there was a meal');
  const quick = ny.find(r => r.employee_name === 'Clementine Hobnail' && r.note === 'Quick lunch, flower room move');
  ok(quick && has(quick, 'short_meal') && !has(quick, 'no_meal'), 'the quick-lunch day: only a 25-min meal, short_meal');
  ok(ny.some(r => r.flags.some(f => f.code === 'missed_out')), 'a New York missed clock-out');
  ok(ny.every(r => !r.flags.some(f => ['late_meal', 'no_second_meal', 'few_rest', 'short_rest'].includes(f.code))), 'no California-only flags on New York rows');
  ok(ny.every(r => r.reg_min == null || (r.dt_min === 0 && r.reg_min + r.ot_min === r.worked_min)), 'no double time, reg + OT = worked');
  // weekly only: in each person's Sat-Fri week, OT starts only once 40 regular hours are used up
  const weeks = new Map();
  for (const r of ny) if (r.reg_min != null) { const k = r.employee_uuid + C.weekStart(r.work_date); if (!weeks.has(k)) weeks.set(k, []); weeks.get(k).push(r); }
  for (const [k, ds] of weeks) {
    ds.sort((a, b) => a.work_date < b.work_date ? -1 : 1);
    let reg = 0;
    for (const d of ds) { ok(!d.ot_min || reg + d.reg_min === 2400, k + ' OT before 40 h'); reg += d.reg_min; }
    ok(reg <= 2400, k + ' over 40 regular hours');
  }
  ok(ny.some(r => r.ot_min > 0 && r.worked_min <= 600), 'weekly OT on an ordinary-length day');
  ok(ny.some(r => r.worked_min > 480 && !r.ot_min), 'no daily OT over 8 hours');
  const nyView = C.normViews(demo.views).find(v => v.id === 'packing-and-distro');
  ok(nyView && C.viewInRegion(nyView, 'NY') && !C.viewInRegion(nyView, 'CA'), 'the New York view');
  const lead = demo.access.find(a => a.email === 'ny.lead@wizardtrees.com');
  const as = Object.assign({}, lead, { views: C.viewsFor(lead.views, C.normViews(demo.views)) });
  eq(C.viewerRegions(as, demo.companies, []), ['NY'], 'the New York lead lands on New York');
  ok(C.filterRows(demo.rows, { viewer: as }).every(r => r.region === 'NY') && C.filterRows(demo.rows, { viewer: as }).length > 0, 'and sees only New York people');
  eq(C.viewerRegions(demo.me, demo.companies, demo.rows), ['CA', 'NY'], 'the demo admin gets both tabs');
  const ops = demo.access.find(a => a.email.startsWith('ops.manager@'));
  eq(C.viewerRegions(Object.assign({}, ops, { views: [] }), demo.companies, []), ['CA'], 'the demo full viewer stays California');
  const late = D.build('2026-10-10T04:30:00Z');   // Friday 9:30 PM Pacific, Saturday 12:30 AM Eastern
  eq(late.todays, { CA: '2026-10-09', NY: '2026-10-10' }, 'the New York day has already turned');
  ok(late.rows.every(r => r.work_date <= late.todays[r.region]) && late.rows.some(r => r.region === 'NY' && r.work_date === '2026-10-09'), 'each region\'s rows run to its own today');
});
check('page: region tabs from the sign-in, every clock time on its row\'s zone, region-aware tips, print and admin', () => {
  const app = block('ts-app');
  const rh = appFn('renderHeader');
  ok(/const regs = regionKeys\(\);/.test(rh) && /C\.REGIONS\.filter\(r => regs\.includes\(r\.key\)\)/.test(rh) && /classList\.toggle\('single', regs\.length < 2\)/.test(rh), 'region tabs only for the regions this sign-in has');
  ok(/return C\.viewerRegions\(viewer\(\), S\.companies, rows\);/.test(appFn('regionKeys')), 'regionKeys() goes through C.viewerRegions');
  ok(/const today = \(\) => C\.todayIn\(regionDef\(\)\.tz, new Date\(\)\);/.test(app), 'today() is the active region\'s date');
  // every clock time the page itself formats names a zone
  const calls = [...app.matchAll(/C\.fmt(Time|Clock)\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)].map(m => m[2]);
  ok(calls.length >= 8 && calls.every(a => /,\s*tz\s*$/.test(a)), 'a clock time formatted without its row zone: ' + J(calls.filter(a => !/,\s*tz\s*$/.test(a))));
  ok(/tz = C\.rowTz\(r\)/.test(appFn('inOutCells')) && /const tz = C\.rowTz\(r\);/.test(appFn('breaksCell')) && /C\.shiftGaps\(r\.shifts, tz\)/.test(appFn('breaksCell')), 'in/out and break chips on the row clock');
  ok(/r\.work_date < rowToday\(r\)/.test(appFn('inOutCells')) && /r\.work_date < rowToday\(r\)/.test(appFn('timesLine')), 'the stale clocked-in pill uses the row\'s own today');
  ok(/estMark\(otTip\(r\.region\)\)/.test(appFn('otCell')) && /New York rules: over 40 h in the Saturday to Friday workweek is OT/.test(app), 'the est. OT tip says New York rules on a New York row');
  ok(/Times are \$\{regionDef\(\)\.tzName\}\./.test(appFn('renderPrintHead')), 'print says Pacific or Eastern');
  ok(/S\.region = C\.pickRegion\(regionKeys\(\), \[linkRegion\(\), S\.viewer \? '' : store\.get\('region', ''\)\]\);/.test(appFn('startApp')), 'start: a link\'s region, else the remembered one, else the first (NY-only lands on NY)');
  ok(/C\.presetRange\('period', today\(\), regionDef\(\)\)/.test(appFn('startApp')), 'the opening pay period is on that region\'s calendar');
  ok(/if \(!pick\.fromLink\) return;\s*(\/\/[^\n]*\n\s*)?if \(!S\.viewer\) \{ store\.set\('savedView', S\.crew\); store\.set\('region', S\.region\); \}/.test(appFn('applyLinkView')),
    'a ?view= link remembers its view and its region tab (not in a preview), so a reload lands on both');
  ok(/case 'region': enterRegion\(d\.region\); break;/.test(app) && /regionRange\(\)/.test(appFn('enterRegion')) && /store\.set\('region'/.test(appFn('enterRegion')), 'a region tab moves the presets and is remembered');
  ok(/S\.region = C\.pickRegion\(regionKeys\(\), \[S\.region\]\)/.test(appFn('startPreview')) && /S\.regionBeforePreview/.test(appFn('exitPreview')), 'Preview of a New York-only sign-in opens New York; Exit preview goes back');
  const ed = appFn('editorHtml');
  ok(/const cov = allCA && co\.region === 'CA';/.test(ed), '"All CA companies" never covers New York in the grants editor');
  ok(/C\.regionsPresent\(S\.companies, \[\.\.\.S\.rows\.values\(\)\]\)/.test(appFn('adminCompanyKeys')) && /adminCompanyKeys\(\)/.test(appFn('viewEditorHtml')), 'the admin editors list every region\'s companies (only California until New York exists)');
  ok(/\.bar\.regions2 #regionTabs\{order:9;flex:1 1 100%\}/.test(src) && /\$\('topBar'\)\.classList\.toggle\('regions2', regs\.length > 1\)/.test(rh), 'on a phone two region tabs get their own row');
  ok(/if \(!regs\.includes\(S\.region\)\) \{ S\.region = regs\[0\];/.test(appFn('render')), 'render never shows a region this sign-in does not have');
});

// ---------------------------------------------------------------------------------------------
// 14. changes made on this page (ts_edits, supabase/ts-edits.sql): the window, the editor's rules
//     (mirroring ts_edit_submit), the board's overlay of waiting changes, status pills, supersede,
//     the demo flow, and the page wiring. Synthetic rows only.
// ---------------------------------------------------------------------------------------------
const EP = t => '2026-10-06T' + t + ':00-07:00';                     // a Pacific wall time on 2026-10-06
const EB = (s, e, kind, extra) => Object.assign({ start: EP(s), end: e ? EP(e) : null, min: e ? (+e.slice(0, 2) * 60 + +e.slice(3)) - (+s.slice(0, 2) * 60 + +s.slice(3)) : 0,
  kind, paid: kind === 'rest', src: 'gusto', open: !e }, extra || {});
const ES = (id, i, o, breaks) => {
  const span = o ? (+o.slice(0, 2) * 60 + +o.slice(3)) - (+i.slice(0, 2) * 60 + +i.slice(3)) : 0;
  return { id, in: EP(i), out: o ? EP(o) : null, span_min: span, worked_min: o ? span - (breaks || []).filter(b => !b.paid).reduce((a, b) => a + b.min, 0) : 0, hours_only: false, breaks: breaks || [] };
};
const ED_S1 = ES('s1', '07:00', '15:30', [EB('09:00', '09:10', 'rest'), EB('11:30', '12:00', 'meal')]);
const edRow = (shifts, extra) => {
  const all = shifts.flatMap(s => s.breaks);
  return C.normRow(Object.assign({ id: 'filifera:e1:2026-10-06', company: 'filifera', region: 'CA', employee_uuid: 'e1', employee_name: 'Test Edit', department: 'Trim',
    job_title: 'Tester', work_date: '2026-10-06', first_in: shifts.length ? shifts[0].in : null, last_out: shifts.length ? shifts[shifts.length - 1].out : null, shifts,
    span_min: shifts.reduce((a, s) => a + s.span_min, 0), worked_min: shifts.reduce((a, s) => a + s.worked_min, 0),
    paid_break_min: all.filter(b => b.paid).reduce((a, b) => a + b.min, 0), unpaid_break_min: all.filter(b => !b.paid).reduce((a, b) => a + b.min, 0),
    reg_min: 480, ot_min: 0, dt_min: 0, ot_src: 'gusto', label_src: 'gusto', gusto_total_min: null, approval: null, note: null, flags: [], open: shifts.some(s => !s.out),
    hours_only: false, synced_at: '2026-10-07T12:00:00Z' }, extra || {}));
};
const EDIT_COLS = ['id', 'day_id', 'company', 'region', 'employee_uuid', 'department', 'work_date', 'shift_id', 'action', 'before', 'after', 'note', 'times_status',
  'breaks_status', 'times_error', 'breaks_error', 'times_applied_at', 'breaks_applied_at', 'created_by', 'created_at', 'cancelled_by', 'cancelled_at'];
const ED = o => Object.assign({ id: 'x1', day_id: 'filifera:e1:2026-10-06', company: 'filifera', region: 'CA', employee_uuid: 'e1', department: 'Trim', work_date: '2026-10-06',
  shift_id: 's1', action: 'update', before: C.shiftSnap(ED_S1), after: null, note: null, times_status: 'none', breaks_status: 'none', times_error: null, breaks_error: null,
  times_applied_at: null, breaks_applied_at: null, created_by: 'm@wizardtrees.com', created_at: '2026-10-07T15:00:00Z', cancelled_by: null, cancelled_at: null }, o);
const AFTER = (i, o, breaks) => ({ in: EP(i), out: EP(o), breaks: (breaks || []).map(([s, e, kind]) => ({ start: EP(s), end: EP(e), kind })) });
const OV = (r, edits, today) => C.overlayDay(r, edits, { today: today || '2026-10-08' });
const codes = errs => errs.map(e => e.code);
const SQL_EDITS = (() => { try { return fs.readFileSync(path.join(ROOT, 'supabase', 'ts-edits.sql'), 'utf8'); } catch { return ''; } })();

check('edit window: the current and previous pay period through today, exactly like ts_edit_window (anchor Friday 2026-10-09, 14-day periods)', () => {
  eq(C.EDIT_ANCHOR_END, '2026-10-09'); eq(C.dow(C.EDIT_ANCHOR_END), 5, 'a Friday');
  // the SQL formula, written out: period_end = anchor + 14 * ceil((today - anchor) / 14); from = period_end - 27
  const sqlWin = today => { const end = C.addDays('2026-10-09', 14 * Math.ceil(C.daysBetween('2026-10-09', today) / 14)); return { from: C.addDays(end, -27), to: today }; };
  for (let d = '2026-01-01'; d <= '2027-12-31'; d = C.addDays(d, 1)) eq(C.editWindow(d), sqlWin(d), d);
  eq(C.editWindow('2026-10-21'), { from: '2026-09-26', to: '2026-10-21' });
  eq(C.editWindow('2026-10-10'), { from: '2026-09-26', to: '2026-10-10' }, 'the first day of a period keeps the one before');
  eq(C.editWindow('2026-10-09'), { from: '2026-09-12', to: '2026-10-09' });
  ok(C.canEditDate('2026-09-26', '2026-10-21') && !C.canEditDate('2026-09-25', '2026-10-21'), 'the first editable day');
  ok(C.canEditDate('2026-10-21', '2026-10-21') && !C.canEditDate('2026-10-22', '2026-10-21'), 'never a future day');
  ok(!C.canEditDate('bad', '2026-10-21') && !C.canEditDate('2026-10-20', ''), 'bad dates');
  // the same 14-day grid as both regions' pay periods
  for (const g of C.REGIONS) eq(C.daysBetween(g.anchorEnd, C.EDIT_ANCHOR_END) % 14, 0, g.key + ' grid');
  if (SQL_EDITS) ok(/date '2026-10-09'/.test(SQL_EDITS) && /period_end - 27/.test(SQL_EDITS), 'supabase/ts-edits.sql has another window');
  ok(/function canEditRow\(r\) \{ return editsOn\(\) && !!r && C\.canEditForRun\(r\.work_date, C\.rowTz\(r\), Date\.now\(\)\) && \(rowRegion\(r\) !== 'NY' \|\| mayEdit\('ny'\)\) && !periodClosed\(r\); \}/.test(block('ts-app')), 'Edit shows only inside the window (now and at the next run), on the row\'s own calendar, and never in a pay period Gusto has closed');
});
check('editor rules mirror ts_edit_submit: start and end, the same day or overnight within 16 h, the start on the work date', () => {
  const v = (a, extra) => codes(C.validateAfter(a, Object.assign({ tz: C.TZ, date: '2026-10-06' }, extra || {})));
  eq(v(AFTER('07:00', '15:30')), [], 'a normal shift');
  eq(v({ in: null, out: EP('15:30'), breaks: [] }), ['no_in']); eq(v({ in: EP('07:00'), out: '', breaks: [] }), ['no_out']);
  eq(v(AFTER('15:30', '07:00')), ['order']); eq(v(AFTER('07:00', '07:00')), ['order'], 'end must be after start');
  eq(v({ in: EP('22:00'), out: '2026-10-07T06:00:00-07:00', breaks: [] }), [], 'overnight 8 h');
  eq(v({ in: EP('14:00'), out: '2026-10-07T06:00:00-07:00', breaks: [] }), [], 'overnight exactly 16 h');
  eq(v({ in: EP('13:59'), out: '2026-10-07T06:00:00-07:00', breaks: [] }), ['overnight'], 'overnight over 16 h');
  eq(v({ in: EP('22:00'), out: '2026-10-08T01:00:00-07:00', breaks: [] }), ['overnight'], 'two days later');
  eq(v({ in: EP('00:30'), out: EP('23:59'), breaks: [] }), [], 'one long day is still the same day');
  eq(v({ in: '2026-10-05T22:00:00-07:00', out: EP('06:00'), breaks: [] }), ['in_date'], 'the start on another day');
  eq(v({ in: '2026-10-05T22:00:00-07:00', out: EP('06:00'), breaks: [] }, { beforeIn: '2026-10-05T21:30:00-07:00' }), [], 'an update may keep the date its start already has');
  eq(v({ in: EP('07:00'), out: EP('15:30'), breaks: [] }, { now: Date.parse(EP('15:00')) }), ['future'], 'the page refuses an end later than now');
  // New York: its own clock decides the day
  eq(codes(C.validateAfter({ in: '2026-10-06T20:00:00-04:00', out: '2026-10-06T23:30:00-04:00', breaks: [] }, { tz: 'America/New_York', date: '2026-10-06' })), []);
  eq(codes(C.validateAfter({ in: '2026-10-06T20:00:00-04:00', out: '2026-10-06T23:30:00-04:00', breaks: [] }, { tz: C.TZ, date: '2026-10-06' })), [], 'the same instants in Pacific are 5 PM to 8:30 PM');
  if (SQL_EDITS) {
    ok(/interval '16 hours'/.test(SQL_EDITS) && /v_out <= v_in/.test(SQL_EDITS), 'ts_edit_submit has other shift rules');
    eq(C.EDIT_RULES.overnightMaxSec, 16 * 3600);
  }
});
check('editor rules mirror ts_edit_submit: at most 6 breaks, each 1 to 240 min, rest or meal, inside the shift, none overlapping', () => {
  const v = (breaks, i, o) => codes(C.validateAfter(AFTER(i || '07:00', o || '15:30', breaks), { tz: C.TZ, date: '2026-10-06' }));
  eq(v([['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']]), []);
  eq(v([['07:00', '07:10', 'rest'], ['15:00', '15:30', 'meal']]), [], 'a break may start at the clock-in and end at the clock-out');
  eq(v([['09:00', '09:01', 'rest']]), [], '1 minute');
  eq(v([['09:00', '13:00', 'meal']]), [], '240 minutes');
  eq(v([['09:00', '13:01', 'meal']]), ['brk_len'], '241 minutes');
  eq(v([['09:00', '09:00', 'rest']]), ['brk_order']); eq(v([['09:10', '09:00', 'rest']]), ['brk_order']);
  eq(v([['06:50', '07:05', 'rest']]), ['brk_outside']); eq(v([['15:20', '15:40', 'rest']]), ['brk_outside']);
  eq(v([['09:00', '09:30', 'meal'], ['09:20', '09:30', 'rest']]), ['brk_overlap']);
  eq(v([['09:00', '09:30', 'meal'], ['09:30', '09:40', 'rest']]), [], 'one may start the minute another ends');
  eq(v([['09:00', '09:10', 'nap']]), ['brk_kind']);
  eq(v([['08:00', '08:05', 'rest'], ['08:10', '08:15', 'rest'], ['08:20', '08:25', 'rest'], ['08:30', '08:35', 'rest'], ['08:40', '08:45', 'rest'], ['08:50', '08:55', 'rest']]), [], 'six breaks');
  eq(v([['08:00', '08:05', 'rest'], ['08:10', '08:15', 'rest'], ['08:20', '08:25', 'rest'], ['08:30', '08:35', 'rest'], ['08:40', '08:45', 'rest'], ['08:50', '08:55', 'rest'], ['09:00', '09:05', 'rest']]), ['too_many']);
  eq(codes(C.validateAfter({ in: EP('07:00'), out: EP('15:30'), breaks: [{ start: EP('09:00'), end: null, kind: 'rest' }] }, { tz: C.TZ })), ['brk_missing']);
  // seconds count for order like the server (it keeps seconds): a kept 7:00:30 start is after a 7:00 break
  eq(codes(C.validateAfter({ in: '2026-10-06T07:00:30-07:00', out: EP('15:30'), breaks: [{ start: EP('07:00'), end: EP('07:10'), kind: 'rest' }] }, { tz: C.TZ })), ['brk_outside']);
  const bi = C.validateAfter(AFTER('07:00', '15:30', [['09:00', '09:10', 'rest'], ['06:00', '06:10', 'rest']]), { tz: C.TZ });
  eq(bi.map(e => [e.code, e.brk]), [['brk_outside', 1]], 'an error names its break');
  ok(C.validateAfter(AFTER('07:00', '15:30', [['06:00', '06:10', 'rest']]), { tz: C.TZ })[0].msg.includes('7:00 AM to 3:30 PM'), 'the message says where the shift is');
  if (SQL_EDITS) ok(/jsonb_array_length\(p_after->'breaks'\) > 6/.test(SQL_EDITS) && /interval '1 minute'/.test(SQL_EDITS) && /interval '240 minutes'/.test(SQL_EDITS) &&
    /v_bs < v_in or v_be > v_out/.test(SQL_EDITS) && /in \('rest', 'meal'\)/.test(SQL_EDITS), 'ts_edit_submit has other break rules');
  eq([C.EDIT_RULES.maxBreaks, C.EDIT_RULES.breakMinSec, C.EDIT_RULES.breakMaxSec, C.EDIT_RULES.noteMax], [6, 60, 14400, 500]);
  if (SQL_EDITS) ok(/length\(note\) between 1 and 500/.test(SQL_EDITS), 'the reason limit differs from the table');
});
check('what changed is decided to the minute (seconds never count), like ts_edit_key; add and delete set their parts', () => {
  const before = C.shiftSnap(ED_S1);
  eq(C.editParts('update', before, Object.assign({}, before, { in: '2026-10-06T07:00:59-07:00' })), { times: 'none', breaks: 'none' }, 'seconds');
  eq(C.editParts('update', before, Object.assign({}, before, { out: EP('15:31') })), { times: 'pending', breaks: 'none' });
  eq(C.editParts('update', before, Object.assign({}, before, { breaks: before.breaks.slice().reverse() })), { times: 'none', breaks: 'none' }, 'break order does not matter');
  eq(C.editParts('update', before, Object.assign({}, before, { breaks: [before.breaks[0], Object.assign({}, before.breaks[1], { kind: 'rest' })] })), { times: 'none', breaks: 'pending' }, 'a type change');
  eq(C.editParts('add', null, AFTER('16:00', '18:00')), { times: 'pending', breaks: 'none' });
  eq(C.editParts('add', null, AFTER('16:00', '18:00', [['17:00', '17:10', 'rest']])), { times: 'pending', breaks: 'pending' });
  eq(C.editParts('delete', before, null), { times: 'none', breaks: 'pending' }, 'the browser task deletes a shift');
  ok(C.sameMinute('2026-10-06T14:00:00Z', EP('07:00')), 'the same minute in two spellings');
  ok(C.sameMinute(null, '') && !C.sameMinute(null, EP('07:00')));
});
check('editor fields: an untouched field keeps its timestamp, a changed one is that wall time on the row\'s clock (the next day past midnight)', () => {
  const en = C.entryOf(Object.assign({}, ED_S1, { out: '2026-10-06T15:30:42-07:00' }), C.TZ);
  eq([en.inT, en.outT, en.breaks.map(b => [b.startT, b.endT, b.kind])], ['07:00', '15:30', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']]]);
  eq(C.entryAfter(en, '2026-10-06', C.TZ).out, '2026-10-06T15:30:42-07:00', 'left alone: seconds kept');
  en.outT = '16:15'; en.inT = '06:45';
  const a = C.entryAfter(en, '2026-10-06', C.TZ);
  eq([a.in, a.out], ['2026-10-06T06:45:00-07:00', '2026-10-06T16:15:00-07:00']);
  eq(C.entryAfter(Object.assign(C.newEntry('n'), { inT: '22:00', outT: '06:00', breaks: [{ startT: '01:00', endT: '01:30', kind: 'meal' }] }), '2026-10-06', C.TZ),
    { in: '2026-10-06T22:00:00-07:00', out: '2026-10-07T06:00:00-07:00', breaks: [{ start: '2026-10-07T01:00:00-07:00', end: '2026-10-07T01:30:00-07:00', kind: 'meal' }] }, 'past midnight');
  eq(C.entryAfter(Object.assign(C.newEntry('n'), { inT: '08:00', outT: '16:30' }), '2026-10-06', 'America/New_York'), { in: '2026-10-06T08:00:00-04:00', out: '2026-10-06T16:30:00-04:00', breaks: [] }, 'New York offsets');
  eq(C.entryAfter(Object.assign(C.newEntry('n'), { inT: '08:00', outT: '16:30' }), '2026-12-01', C.TZ).in, '2026-12-01T08:00:00-08:00', 'winter offset');
  eq(C.entryAfter(C.newEntry('n'), '2026-10-06', C.TZ), { in: null, out: null, breaks: [] }, 'blank fields');
  eq([C.parseHhmm('07:05'), C.parseHhmm('7:05'), C.parseHhmm('23:59:00'), C.parseHhmm('24:00'), C.parseHhmm('')].map(x => isNaN(x) ? 'NaN' : x), [425, 425, 1439, 'NaN', 'NaN']);
  eq([C.fmtHhmm('07:05'), C.fmtHhmm('00:00'), C.fmtHhmm('12:30'), C.fmtHhmm('x')], ['7:05 AM', '12:00 AM', '12:30 PM', '']);
  ok(C.entryKey(en) !== C.entryKey(C.entryOf(ED_S1, C.TZ)) && C.entryKey(C.entryOf(ED_S1, C.TZ)) === C.entryKey(C.entryOf(ED_S1, C.TZ)), 'entryKey tells a change');
});
check('overlay math: a waiting change shows the EDITED times and breaks, worked = span - unpaid, totals and first in / last out follow', () => {
  const r = edRow([ED_S1]);
  ok(OV(r, []) === r && OV(r, [ED({ day_id: 'other:day' , times_status: 'pending', after: AFTER('07:30', '15:30') })]) === r, 'a day without edits is the very same row');
  const t = OV(r, [ED({ times_status: 'pending', after: AFTER('07:30', '16:00', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']]) })]);
  eq([t.first_in, t.last_out, t.span_min, t.worked_min, t.paid_break_min, t.unpaid_break_min], [EP('07:30'), EP('16:00'), 510, 480, 10, 30]);
  eq(t.shifts[0].edited, { times: 'pending', breaks: null, in: true, out: true }, 'only the times are the edit\'s');
  ok(t.shifts[0].breaks === ED_S1.breaks, 'breaks stay Gusto\'s when only the times change');
  eq([t.edit.pending.length, t.edit.attention.length], [1, 0]);
  const b = OV(r, [ED({ breaks_status: 'pending', after: AFTER('07:00', '15:30', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal'], ['13:30', '13:52', 'meal']]) })]);
  eq([b.worked_min, b.paid_break_min, b.unpaid_break_min], [510 - 52, 10, 52]);
  ok(b.shifts[0].breaks.every(x => x.src === 'edit') && !b.shifts[0].breaks.some(C.breakUnsure), 'a typed break is never a guess (no est. on a 22 min meal)');
  for (const d of [t, b]) for (const s of d.shifts) eq(s.worked_min, s.span_min - s.breaks.filter(x => !x.paid).reduce((a, x) => a + x.min, 0), 'worked = span - unpaid');
  // the 11:59:59 PM automatic clock-out counts as midnight, like the producer
  eq(C.editedShift(null, { in: EP('16:00'), out: EP('23:59').replace(':00-', ':59-'), breaks: [] }, C.TZ).span_min, 480);
});
check('overlay: delete, add, Gusto refusing a change, a change already in Gusto, cancelled, and the latest edit of a shift wins', () => {
  const s2 = ES('s2', '16:00', '18:00');
  const r = edRow([ED_S1, s2]);
  const del = OV(r, [ED({ shift_id: 's2', action: 'delete', after: null, breaks_status: 'pending' })]);
  eq([del.shifts.map(s => s.id), del.worked_min, del.edit.pending.length], [['s1'], 480, 1]);
  const all = OV(edRow([ED_S1]), [ED({ action: 'delete', after: null, breaks_status: 'pending' })]);
  eq([all.deleted_all, all.shifts.length, all.worked_min, C.shiftsText(all)], [true, 0, 0, 'shift deleted'], 'every shift waiting to be deleted');
  const add = OV(edRow([ED_S1]), [ED({ id: 'a1', shift_id: null, action: 'add', before: null, after: AFTER('16:00', '18:00'), times_status: 'pending' })]);
  eq([add.shifts.map(s => s.id), add.shifts[1].add_edit, add.worked_min, add.last_out], [['s1', 'edit:a1'], 'a1', 600, EP('18:00')]);
  // Gusto would not take it: Gusto's values, a Needs a look, nothing pending
  const con = OV(r, [ED({ times_status: 'conflict', times_error: 'clock-in moved', after: AFTER('07:30', '15:30', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']]) })]);
  eq([con.first_in, con.worked_min, con.edit.pending.length, con.edit.attention.length], [EP('07:00'), 600, 0, 1]);
  ok(OV(r, [ED({ times_status: 'failed', after: C.shiftSnap(ED_S1) })]) === r, 'a refused change Gusto already shows needs no look');
  // in Gusto: shown until the next sync brings it, then Gusto's own row is enough
  const sent = OV(r, [ED({ times_status: 'applied', times_applied_at: '2026-10-07T13:00:00Z', after: AFTER('07:30', '15:30', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']]) })]);
  eq([sent.first_in, sent.edit.pending.length, sent.edit.sent, sent.shifts[0].edited.times], [EP('07:30'), 0, true, 'sent'], 'applied after the last sync: still shown, no pill');
  ok(OV(r, [ED({ times_status: 'applied', times_applied_at: '2026-10-07T11:00:00Z', after: AFTER('07:30', '15:30') })]) === r, 'applied before the last sync: plain');
  ok(OV(r, [ED({ times_status: 'cancelled', cancelled_by: 'm@wizardtrees.com', cancelled_at: '2026-10-07T16:00:00Z', after: AFTER('07:30', '15:30') })]) === r, 'cancelled edits never show');
  const two = OV(r, [ED({ id: 'old', times_status: 'conflict', after: AFTER('07:30', '15:30'), created_at: '2026-10-07T10:00:00Z' }),
    ED({ id: 'new', times_status: 'pending', after: AFTER('07:45', '15:30', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']]), created_at: '2026-10-07T11:00:00Z' })]);
  eq([two.first_in, two.edit.attention.length, two.edit.pending.map(e => e.id)], [EP('07:45'), 0, ['new']], 'the newer edit of a shift decides');
  // an added shift in Gusto and synced, its breaks still waiting: they go on Gusto's new shift, never a second copy
  const synced = edRow([ED_S1, ES('g9', '16:00', '18:00')]);
  const tw = OV(synced, [ED({ id: 'a1', shift_id: null, action: 'add', before: null, after: AFTER('16:00', '18:00', [['17:00', '17:10', 'rest']]),
    times_status: 'applied', times_applied_at: '2026-10-07T11:00:00Z', breaks_status: 'pending' })]);
  eq([tw.shifts.map(s => s.id), tw.shifts[1].breaks.length, tw.edit.pending.length], [['s1', 'g9'], 1, 1]);
});
check('overlay: flags and overtime follow the edited day (estimated), Gusto\'s own total no longer applies', () => {
  const noMeal = edRow([ES('s1', '07:00', '15:30', [EB('09:00', '09:10', 'rest'), EB('13:00', '13:10', 'rest')])], {
    flags: [{ code: 'no_meal', sev: 'warn', msg: 'No meal break on a shift over 5 hours' }], gusto_total_min: 510 });
  const fixed = OV(noMeal, [ED({ breaks_status: 'pending', after: AFTER('07:00', '15:30', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal'], ['13:00', '13:10', 'rest']]) })]);
  eq(fixed.flags.map(f => f.code), [], 'the meal is there now: no flag (and no "differs from Gusto")');
  ok(!C.hasWarn(fixed) && C.hasWarn(noMeal), 'Flagged only follows the board');
  const long = OV(edRow([ED_S1]), [ED({ times_status: 'pending', after: AFTER('07:00', '17:30', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']]) })]);
  eq([long.worked_min, long.reg_min, long.ot_min, long.dt_min, long.ot_src], [600, 480, 120, 0, 'est'], 'California daily OT, estimated');
  eq(C.estOvertime({ region: 'CA', worked_min: 480, reg_min: 0, ot_min: 480, dt_min: 0 }, { worked_min: 540, shifts: [{ out: 'x' }] }), { reg_min: 0, ot_min: 540, dt_min: 0, ot_src: 'est' }, 'a day already all OT (past 40 h) stays all OT');
  eq(C.estOvertime({ region: 'NY', company: 'wtny', worked_min: 480, reg_min: 300, ot_min: 180, dt_min: 0 }, { worked_min: 540, shifts: [{ out: 'x' }] }), { reg_min: 300, ot_min: 240, dt_min: 0, ot_src: 'est' }, 'New York past 40 h: added minutes are OT');
  eq(C.estOvertime({ region: 'NY', company: 'wtny', worked_min: 480, reg_min: 480, ot_min: 0, dt_min: 0 }, { worked_min: 600, shifts: [{ out: 'x' }] }), { reg_min: 600, ot_min: 0, dt_min: 0, ot_src: 'est' }, 'New York has no daily OT');
  const same = OV(edRow([ED_S1], { ot_min: 30, reg_min: 450, ot_src: 'gusto' }), [ED({ times_status: 'pending', after: AFTER('07:30', '16:00', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']]) })]);
  eq([same.reg_min, same.ot_min, same.ot_src], [450, 30, 'gusto'], 'hours unchanged: Gusto\'s overtime stays');
  const open = OV(edRow([ES('s1', '07:00', null, [EB('09:00', '09:10', 'rest')])], { work_date: '2026-10-06', reg_min: null, flags: [{ code: 'missed_out', sev: 'warn' }] }),
    [ED({ times_status: 'pending', breaks_status: 'pending', after: AFTER('07:00', '15:00', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal'], ['13:30', '13:40', 'rest']]) })]);
  eq([open.open, open.worked_min, open.flags.map(f => f.code)], [false, 450, []], 'a missed clock-out filled in: closed, counted, no flag');
  const timesOnly = OV(edRow([ES('s1', '07:00', null, [EB('09:00', '09:10', 'rest')])], { reg_min: null }), [ED({ times_status: 'pending', after: AFTER('07:00', '15:00', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']]) })]);
  eq([timesOnly.worked_min, timesOnly.shifts[0].breaks.length], [480, 1], 'only the times waiting: the breaks stay Gusto\'s');
});
check('status pills: Pending and Needs a look, with a bubble that says what changed, who made it and when it reaches Gusto', () => {
  const now = Date.parse('2026-10-07T18:30:00Z');   // 11:30 AM Pacific
  eq(['pending', 'attention', 'applied', 'cancelled', 'none', 'replaced'].map(k => C.EDIT_STATUS_WORDS[k]), ['Pending', 'Needs a look', 'In Gusto', 'Cancelled', 'Undone', 'Replaced']);
  eq([ED({ times_status: 'pending' }), ED({ times_status: 'conflict', breaks_status: 'pending' }), ED({ breaks_status: 'failed' }), ED({ times_status: 'applied', breaks_status: 'applied' }),
    ED({ times_status: 'cancelled', cancelled_at: 'x' }), ED({ times_status: 'applied', breaks_status: 'cancelled', cancelled_at: 'x' }), ED({})].map(C.editStatus),
    ['pending', 'attention', 'attention', 'applied', 'cancelled', 'cancelled', 'none']);
  const e = ED({ times_status: 'pending', breaks_status: 'pending', note: 'forgot', created_at: '2026-10-07T18:20:00Z', after: AFTER('07:30', '15:30', [['09:00', '09:10', 'rest'], ['12:00', '12:30', 'meal']]) });
  eq(C.describeEdit(e, C.TZ), ['Start 7:00 AM → 7:30 AM', 'Meal 11:30-12:00 → 12:00-12:30']);
  const tip = C.editTip(e, C.TZ, now);
  for (const want of ['Pending: changed here, not in Gusto yet.', 'Start 7:00 AM → 7:30 AM', 'Start, end and breaks: going to Gusto at noon today',
    'By m@wizardtrees.com, Oct 7, 11:20 AM.', 'Reason: forgot']) ok(tip.includes(want), 'tip is missing ' + J(want) + ': ' + tip);
  ok(!/within minutes/.test(src), 'nothing on the page promises "within minutes" any more: every change goes at 5 AM, noon or 7 PM Pacific');
  // the runs, Pacific wall clock (Gianni 2026-10-23: 5 AM, noon and 7 PM)
  eq(C.EDIT_RUNS_PT, [300, 720, 1140]);
  // overdue: 30 min after the first 5 AM, noon or 7 PM Pacific run that came after the change, for every part
  // (start and end, breaks, deletes: the same run, the same Gusto save); the page says Late instead of
  // promising when
  eq(C.EDIT_LATE_SEC, 1800);
  const at = (t, part, made) => C.partLate(ED({ [part + '_status']: 'pending', created_at: made || '2026-10-07T15:00:00Z' }), part, t);   // made 8:00 AM Pacific
  eq([at('2026-10-07T15:30:00Z', 'times'), at('2026-10-07T19:29:00Z', 'times'), at('2026-10-07T19:30:00Z', 'times')], [false, false, true], 'start and end: the noon run, plus 30 minutes (no longer within minutes)');
  eq([at('2026-10-07T19:29:00Z', 'breaks'), at('2026-10-07T19:30:00Z', 'breaks')], [false, true], 'breaks: the noon run, plus 30 minutes');
  eq([at('2026-10-08T02:29:00Z', 'breaks', '2026-10-07T20:05:00Z'), at('2026-10-08T02:30:00Z', 'breaks', '2026-10-07T20:05:00Z')], [false, true], 'made at 1:05 PM: the 7 PM run');
  eq([at('2026-10-08T02:29:00Z', 'times', '2026-10-07T20:05:00Z'), at('2026-10-08T02:30:00Z', 'times', '2026-10-07T20:05:00Z')], [false, true], 'start and end the same');
  eq([at('2026-10-08T12:29:00Z', 'times', '2026-10-08T03:00:00Z'), at('2026-10-08T12:30:00Z', 'times', '2026-10-08T03:00:00Z')], [false, true], 'made at 8 PM: the next morning\'s 5 AM run');
  eq(C.firstEditRun('2026-10-08T02:30:00Z'), Date.parse('2026-10-08T12:00:00Z') / 1000, 'after 7 PM: the next day\'s 5 AM run');
  eq(C.firstEditRun('2026-10-07T11:59:59Z'), Date.parse('2026-10-07T12:00:00Z') / 1000, 'a second before 5 AM: that run');
  eq(C.firstEditRun('2026-10-07T12:00:00Z'), Date.parse('2026-10-07T19:00:00Z') / 1000, 'exactly 5 AM: the noon run');
  eq(C.firstEditRun('2026-10-07T18:59:59Z'), Date.parse('2026-10-07T19:00:00Z') / 1000, 'a second before noon: that run');
  eq(C.firstEditRun('2026-11-10T02:30:00Z'), Date.parse('2026-11-10T03:00:00Z') / 1000, 'standard time: 7 PM PST');
  ok(!C.partLate(ED({ times_status: 'applied', created_at: '2026-10-01T15:00:00Z' }), 'times', now) && !C.partLate(ED({ times_status: 'conflict' }), 'times', now), 'only a waiting part is late');
  const both = ED({ times_status: 'pending', breaks_status: 'pending', after: AFTER('07:30', '15:30', [['09:00', '09:10', 'rest'], ['12:00', '12:30', 'meal']]) });   // made 8:00 AM
  eq(C.editPartLines(both, C.TZ, now), ['Start, end and breaks: going to Gusto at noon today'], 'both parts wait for the same run: one line');
  eq(C.editPartLines(both, C.TZ, '2026-10-07T19:10:00Z'), ['Start, end and breaks: going to Gusto now'], 'while its run is on');
  eq(C.editPartLines(both, C.TZ, '2026-10-07T21:00:00Z'), ['Start, end and breaks: late, not in Gusto yet']);
  ok(C.editTip(both, C.TZ, '2026-10-07T21:00:00Z').startsWith('Late: not in Gusto yet.') && !/going to Gusto/.test(C.editTip(both, C.TZ, '2026-10-07T21:00:00Z')), 'the bubble says Late, never the promise');
  ok(C.editTip(both, C.TZ, now).startsWith('Pending: changed here, not in Gusto yet.'), 'on time: Pending');
  eq(C.editPartLines(ED({ times_status: 'applied', breaks_status: 'pending', after: AFTER('07:30', '15:30', [['12:00', '12:30', 'meal']]) }), C.TZ, now),
    ['Start and end: in Gusto', 'Breaks: going to Gusto at noon today'], 'one part in, one waiting: a line each');
  eq(C.editPartLines(ED({ action: 'add', before: null, shift_id: null, times_status: 'pending', breaks_status: 'pending', after: AFTER('16:00', '18:00', [['17:00', '17:10', 'rest']]) }), C.TZ, now),
    ['The new shift: going to Gusto at noon today'], 'an added shift and its breaks: one line');
  eq(C.editPartLines(ED({ action: 'add', before: null, shift_id: null, times_status: 'pending', after: AFTER('16:00', '18:00') }), C.TZ, now), ['The new shift: going to Gusto at noon today']);
  eq(C.editPartLines(ED({ action: 'delete', after: null, breaks_status: 'pending' }), C.TZ, now), ['Deleting it: going to Gusto at noon today']);
  ok(/Deleting it: late, not in Gusto yet/.test(C.editTip(ED({ action: 'delete', after: null, breaks_status: 'pending' }), C.TZ, '2026-10-07T21:00:00Z')), 'a delete waits for the same run');
  // a New York row reads the same runs on its own clock: 5 AM Pacific is 8 AM Eastern, noon is 3 PM, 7 PM is 10 PM
  eq(C.editPartLines(both, 'America/New_York', now), ['Start, end and breaks: going to Gusto at 3 PM today']);
  eq(C.editPartLines(Object.assign({}, both, { created_at: '2026-10-07T21:00:00Z' }), 'America/New_York', '2026-10-07T21:10:00Z'), ['Start, end and breaks: going to Gusto at 10 PM today']);
  eq(C.editPartLines(Object.assign({}, both, { created_at: '2026-10-07T21:00:00Z' }), C.TZ, '2026-10-07T21:10:00Z'), ['Start, end and breaks: going to Gusto at 7 PM today']);
  eq(C.editPartLines(Object.assign({}, both, { created_at: '2026-10-08T03:00:00Z' }), 'America/New_York', '2026-10-08T03:10:00Z'), ['Start, end and breaks: going to Gusto at 8 AM tomorrow'], 'made at 11 PM Eastern');
  eq(C.editPartLines(Object.assign({}, both, { created_at: '2026-10-08T03:00:00Z' }), C.TZ, '2026-10-08T03:10:00Z'), ['Start, end and breaks: going to Gusto at 5 AM tomorrow'], 'made at 8 PM Pacific');
  ok(C.editTip(ED({ times_status: 'conflict', times_error: 'Clock-in moved in Gusto.', after: AFTER('07:30', '15:30') }), C.TZ, now).includes('Clock-in moved in Gusto.'), 'the reason Gusto gave');
  eq(C.describeEdit(ED({ action: 'delete', after: null }), C.TZ), ['Delete the shift 7:00 AM - 3:30 PM']);
  eq(C.describeEdit(ED({ action: 'add', before: null, after: AFTER('16:00', '18:00', [['17:00', '17:10', 'rest']]) }), C.TZ), ['Add a shift 4:00 PM - 6:00 PM', 'with rest 5:00-5:10']);
  eq(C.describeEdit(ED({ after: C.shiftSnap(ED_S1) }), C.TZ), ['Back to what Gusto has']);
  eq(C.describeEdit(ED({ after: AFTER('07:00', '15:30', [['09:00', '09:10', 'rest']]) }), C.TZ), ['Remove meal 11:30-12:00']);
  eq(C.editPartLines(ED({ times_status: 'cancelled', cancelled_by: 'superseded', cancelled_at: 'x' }), C.TZ, now), ['Replaced by a later change']);
  eq(C.editPartLines(ED({ times_status: 'cancelled', cancelled_by: 'superseded', cancelled_at: 'x' }), C.TZ, now, ED({ id: 'x2', created_by: 'b@wizardtrees.com', created_at: '2026-10-07T17:05:00Z' })),
    ["Replaced by b@wizardtrees.com's change, Oct 7, 10:05 AM"], 'naming the change that replaced it');
  // when changes reach Gusto: 5 AM, noon and 7 PM Pacific, said on the row's clock
  eq(C.editTimingText(C.TZ, now), 'Changes go to Gusto at 5 AM, noon and 7 PM.');
  eq(C.editTimingText('America/New_York', now), 'Changes go to Gusto at 8 AM, 3 PM and 10 PM.');
  eq([C.editRunsText(C.TZ, '2026-01-15T20:00:00Z'), C.editRunsText('America/New_York', '2026-01-15T20:00:00Z')], ['5 AM, noon and 7 PM', '8 AM, 3 PM and 10 PM'], 'the same in winter (standard time)');
  eq([C.clockShort('2026-10-07T12:00:00-07:00', C.TZ), C.clockShort('2026-10-07T00:00:00-07:00', C.TZ), C.clockShort('2026-10-07T12:30:00-07:00', C.TZ)], ['noon', 'midnight', '12:30 PM']);
  eq([C.nextEditRun(now, C.TZ), C.nextEditRun('2026-10-07T21:00:00Z', C.TZ), C.nextEditRun('2026-10-08T02:00:00Z', 'America/New_York'), C.nextEditRun('2026-10-08T05:00:00Z', C.TZ)],
    ['at noon today', 'at 7 PM today', 'at 8 AM tomorrow', 'at 5 AM tomorrow']);
  eq([C.nextEditRun('2026-10-07T15:00:00Z', 'America/New_York'), C.nextEditRun('2026-10-07T10:00:00Z', C.TZ), C.nextEditRun('2026-10-07T10:00:00Z', 'America/New_York')],
    ['at 3 PM today', 'at 5 AM today', 'at 8 AM today'], 'New York at 11 AM; 3 AM Pacific (6 AM Eastern)');
  eq(C.nextEditRun('2026-10-08T02:00:00Z', C.TZ), 'at 5 AM tomorrow', 'exactly 7 PM: that run has started, so the next one');
  eq(C.nextEditRun('2026-10-07T19:00:00Z', C.TZ), 'at 7 PM today', 'exactly noon: the 7 PM run');
  // New York just after midnight Eastern (9:30 PM Pacific the evening before): the 5 AM Pacific run is 8 AM that day
  eq(C.nextEditRun('2026-10-07T04:30:00Z', 'America/New_York'), 'at 8 AM today', '12:30 AM Eastern');
  eq(C.nextEditRun('2026-10-07T04:30:00Z', C.TZ), 'at 5 AM tomorrow', 'the same moment on a Pacific row');
  // the 5 AM run on the daylight saving days: Sun Nov 1 2026 (fall back at 2 AM) and Sun Mar 14 2027 (spring forward)
  eq(C.firstEditRun('2026-11-01T08:30:00Z'), Date.parse('2026-11-01T13:00:00Z') / 1000, 'Nov 1, 1:30 AM PDT: 5 AM is PST');
  eq(C.firstEditRun('2026-11-01T09:30:00Z'), Date.parse('2026-11-01T13:00:00Z') / 1000, 'Nov 1, the second 1:30 AM (PST)');
  eq(C.firstEditRun('2026-11-01T13:00:00Z'), Date.parse('2026-11-01T20:00:00Z') / 1000, 'Nov 1, at 5 AM: noon PST');
  eq([C.nextEditRun('2026-11-01T09:30:00Z', C.TZ), C.nextEditRun('2026-11-01T09:30:00Z', 'America/New_York')], ['at 5 AM today', 'at 8 AM today']);
  eq(C.firstEditRun('2027-03-14T09:30:00Z'), Date.parse('2027-03-14T12:00:00Z') / 1000, 'Mar 14, 1:30 AM PST: 5 AM is PDT');
  eq(C.firstEditRun('2027-03-14T12:00:00Z'), Date.parse('2027-03-14T19:00:00Z') / 1000, 'Mar 14, at 5 AM: noon PDT');
  eq([C.nextEditRun('2027-03-14T09:30:00Z', C.TZ), C.nextEditRun('2027-03-14T09:30:00Z', 'America/New_York')], ['at 5 AM today', 'at 8 AM today']);
  eq([C.editRunsText(C.TZ, '2026-11-01T20:00:00Z'), C.editRunsText('America/New_York', '2027-03-14T20:00:00Z')], ['5 AM, noon and 7 PM', '8 AM, 3 PM and 10 PM'], 'the words on both days');
  eq([C.partLate(ED({ times_status: 'pending', created_at: '2026-11-01T09:30:00Z' }), 'times', '2026-11-01T13:29:00Z'),
    C.partLate(ED({ times_status: 'pending', created_at: '2026-11-01T09:30:00Z' }), 'times', '2026-11-01T13:30:00Z')], [false, true], 'Late 30 minutes after 5 AM PST');
  // the page: the pills sit above the flag pills, open the same bubble, and never count as flags
  const app = block('ts-app');
  ok(/class="flag eatt" title="\$\{tip\(ed\.attention\)\}" tabindex="0">Needs a look</.test(appFn('editPills')) && /class="flag epend" title="\$\{tip\(ed\.pending\)\}" tabindex="0">\$\{word\}</.test(appFn('editPills')) && /\? 'Late' : 'Pending'/.test(appFn('editPills')), 'pills');
  ok(/C\.flagsHtml\(r\.flags, r\.region\)/.test(appFn('flagsCell')) && /editPills\(r\)/.test(appFn('flagsCell')) && /editPills\(r\)/.test(appFn('flagPills')), 'table cells and phone cards both carry them');
  ok(/const TIP_SEL = '[^']*\.flag[^']*';/.test(app), 'a pill opens the bubble like a flag');
  const pend = OV(edRow([ED_S1]), [ED({ times_status: 'pending', after: AFTER('07:30', '15:30', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']]) })]);
  eq(C.totals([pend]).warn, pend.flags.filter(f => C.flagSev(f) === 'warn').length, 'a Pending pill is not a flag');
  ok(pend.flags.every(f => C.FLAG_CODES.includes(f.code)), 'only the spec flag codes');
  ok(/\.flag\.epend\{/.test(src) && /\.flag\.eatt\{/.test(src), 'pill styles');
  const leg = markup.match(/<div class="legend">[\s\S]*?\n {14}<\/div>/)[0];
  ok(/flag epend">Pending</.test(leg) && /flag eatt">Needs a look</.test(leg), 'the Key explains both');
});
check('supersede and submit: a later edit of the same shift replaces a waiting one, like ts_edit_submit; the server\'s refusals', () => {
  const raw = edRow([ED_S1, ES('s2', '16:00', '18:00')]);
  const ctx = (id, extra) => Object.assign({ email: 'm@wizardtrees.com', now: '2026-10-07T18:00:00Z', today: '2026-10-07', id }, extra || {});
  let res = C.submitEdit([], raw, { shift_id: 's1', action: 'update', after: AFTER('07:30', '15:30', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']]), note: '  late bus ' }, ctx('e1'));
  ok(res.ok, res.error);
  eq(Object.keys(res.edit).sort(), [...EDIT_COLS].sort(), 'a ts_edits row');
  eq([res.edit.times_status, res.edit.breaks_status, res.edit.note, res.edit.shift_id, res.edit.created_by], ['pending', 'none', 'late bus', 's1', 'm@wizardtrees.com']);
  eq(res.edit.before, C.shiftSnap(ED_S1), 'before = the shift as Gusto has it');
  const marked = res.edits.map(e => Object.assign({}, e, { breaks_status: 'conflict' }));   // pretend its breaks part had failed
  res = C.submitEdit(marked, raw, { shift_id: 's1', action: 'update', after: AFTER('07:45', '15:30') }, ctx('e2'));
  ok(res.ok, res.error);
  const old = res.edits.find(e => e.id === 'e1');
  eq([old.times_status, old.breaks_status, old.cancelled_by], ['cancelled', 'conflict', 'superseded'], 'waiting parts cancelled, others kept');
  eq([res.edit.times_status, res.edit.breaks_status], ['pending', 'pending']);
  const other = C.submitEdit(res.edits, raw, { shift_id: 's2', action: 'delete' }, ctx('e3'));
  ok(other.ok && other.edits.find(e => e.id === 'e2').times_status === 'pending', 'another shift is left alone');
  eq([other.edit.times_status, other.edit.breaks_status, other.edit.after], ['none', 'pending', null]);
  // nothing changed: refused, unless it replaces a waiting edit (putting the shift back as Gusto has it)
  ok(!C.submitEdit([], raw, { shift_id: 's1', action: 'update', after: C.shiftSnap(ED_S1) }, ctx('x')).ok, 'nothing to change');
  const back = C.submitEdit(other.edits, raw, { shift_id: 's1', action: 'update', after: C.shiftSnap(ED_S1) }, ctx('e4'));
  ok(back.ok && back.edit.times_status === 'none' && back.edit.breaks_status === 'none' && back.edits.find(e => e.id === 'e2').cancelled_by === 'superseded', 'a revert replaces the waiting edit');
  // adds never supersede; the same add twice is refused
  const a1 = C.submitEdit([], raw, { shift_id: null, action: 'add', after: AFTER('19:00', '20:00') }, ctx('a1'));
  ok(a1.ok && a1.edit.shift_id === null && a1.edit.before === null);
  ok(!C.submitEdit(a1.edits, raw, { action: 'add', after: AFTER('19:00', '20:00') }, ctx('a2')).ok, 'the same add again');
  ok(C.submitEdit(a1.edits, raw, { action: 'add', after: AFTER('19:00', '20:30') }, ctx('a3')).ok, 'another add');
  // refusals
  const no = (input, c) => C.submitEdit([], raw, input, c || ctx('n')).error;
  ok(/pay periods/.test(no({ shift_id: 's1', action: 'update', after: AFTER('07:30', '15:30') }, ctx('n', { today: '2026-11-20' }))), 'outside the window');
  ok(/not happened yet/.test(no({ shift_id: 's1', action: 'update', after: AFTER('07:30', '15:30') }, ctx('n', { today: '2026-10-05' }))), 'a future day');
  ok(/not on this day any more/.test(no({ shift_id: 'gone', action: 'update', after: AFTER('07:30', '15:30') })), 'a shift no longer on the row');
  ok(/no Gusto shift id/.test(no({ shift_id: 's1', action: 'add', after: AFTER('19:00', '20:00') })), 'an add with a shift id');
  ok(/update, add, delete or note/.test(no({ shift_id: 's1', action: 'merge' })), 'unknown action');
  ok(/End must be after|end must be after/i.test(no({ shift_id: 's1', action: 'update', after: AFTER('15:30', '07:30') })), 'the shift rules');
  ok(/500 characters/.test(no({ shift_id: 's1', action: 'update', after: AFTER('07:30', '15:30'), note: 'x'.repeat(501) })), 'the reason limit');
  // cancel: the creator or an admin, only while something waits
  const c1 = C.submitEdit([], raw, { shift_id: 's1', action: 'update', after: AFTER('07:30', '15:30', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']]) }, ctx('c1'));
  ok(!C.cancelEdit(c1.edits, 'c1', { email: 'someone@wizardtrees.com' }).ok, 'someone else');
  const cx = C.cancelEdit(c1.edits, 'c1', { email: 'boss@wizardtrees.com', is_admin: true, now: '2026-10-07T19:00:00Z' });
  ok(cx.ok && cx.edit.times_status === 'cancelled' && cx.edit.breaks_status === 'none' && cx.edit.cancelled_by === 'boss@wizardtrees.com', 'an admin');
  ok(!C.cancelEdit(cx.edits, 'c1', { email: 'm@wizardtrees.com' }).ok, 'nothing waits any more');
  ok(C.cancelEdit(c1.edits, 'c1', { email: 'm@wizardtrees.com' }).ok, 'the creator');
  if (SQL_EDITS) ok(/cancelled_by = 'superseded'/.test(SQL_EDITS) && /'pending' in \(e\.times_status, e\.breaks_status\)/.test(SQL_EDITS) && /This shift is already waiting to be added/.test(SQL_EDITS), 'supersede differs from ts_edit_submit');
  // an older edit Gusto refused reads as Replaced once a later edit of the shift exists
  const rep = C.replacedEdits([ED({ id: 'r1', times_status: 'conflict', created_at: '2026-10-07T10:00:00Z' }), ED({ id: 'r2', times_status: 'pending', created_at: '2026-10-07T11:00:00Z' })]);
  eq([...rep], ['r1']);
  eq(C.editShownStatus(ED({ id: 'r1', times_status: 'conflict' }), rep), 'replaced');
});
check('the day editor: entries as the board shows them, what Save sends (one submit per changed shift), and the preview', () => {
  const s2 = ES('s2', '16:00', '18:00');
  const raw = edRow([ED_S1, s2]);
  const waitDel = ED({ id: 'd1', shift_id: 's2', action: 'delete', after: null, breaks_status: 'pending' });
  const waitAdd = ED({ id: 'a1', shift_id: null, action: 'add', before: null, after: AFTER('19:00', '20:00'), times_status: 'pending', created_by: 'other@wizardtrees.com' });
  const edits = [waitDel, waitAdd];
  const board = OV(raw, edits);
  const me = { email: 'm@wizardtrees.com', is_admin: false };
  const en = C.editorEntries(raw, board, edits, me);
  eq(en.map(e => [e.kind, e.id, !!e.del, e.readonly || '', e.pendingIds]), [['shift', 's1', false, '', []], ['shift', 's2', true, '', ['d1']], ['add', null, false, 'theirs', []]]);
  ok(C.editorEntries(raw, board, edits, { email: 'boss@wizardtrees.com', is_admin: true })[2].readonly === undefined, 'an admin may change anyone\'s add');
  const plan0 = C.editPlan(raw, en, {});
  eq([plan0.ops, plan0.errors], [[], {}], 'nothing touched: nothing sent');
  // change shift 1's end and keep shift 2 (undo the waiting delete): one update, one revert that replaces the delete
  en[0].outT = '16:00'; en[0].outT = '15:45'; en[1].del = false;
  const plan = C.editPlan(raw, en, {});
  eq(plan.ops.map(o => [o.type, o.action, o.shift_id]), [['submit', 'update', 's1'], ['submit', 'update', 's2']]);
  eq(plan.ops[0].after.out, EP('15:45'));
  eq(plan.ops[1].after, C.shiftSnap(s2), 'shift 2 back as Gusto has it');
  // a new shift, and deleting a shift
  const en2 = C.editorEntries(raw, OV(raw, []), [], me);
  en2[1].del = true;
  en2.push(Object.assign(C.newEntry('n1'), { inT: '19:00', outT: '20:00' }));
  eq(C.editPlan(raw, en2, {}).ops.map(o => [o.type, o.action, o.shift_id]), [['submit', 'delete', 's2'], ['submit', 'add', null]]);
  // a waiting add of mine that changes: cancelled and added again; deleted: cancelled
  const mine = C.editorEntries(raw, OV(raw, [Object.assign({}, waitAdd, { created_by: me.email })]), [Object.assign({}, waitAdd, { created_by: me.email })], me);
  mine[2].outT = '20:30';
  eq(C.editPlan(raw, mine, {}).ops.map(o => [o.type, o.id || o.action]), [['cancel', 'a1'], ['submit', 'add']]);
  mine[2].del = true;
  eq(C.editPlan(raw, mine, {}).ops.map(o => [o.type, o.id]), [['cancel', 'a1']]);
  // putting a shift back with nothing waiting sends nothing
  const en3 = C.editorEntries(raw, OV(raw, []), [], me);
  en3[0].outT = '16:00'; en3[0].outT = '15:30';
  eq(C.editPlan(raw, en3, {}).ops, []);
  // any problem: nothing is sent, the shift with the problem says why
  en3[0].outT = '06:00'; en3.push(Object.assign(C.newEntry('n2'), { inT: '19:00', outT: '20:00' }));
  const bad = C.editPlan(raw, en3, {});
  eq([bad.ops, Object.keys(bad.errors)], [[], [en3[0].key]]);
  const ov = C.editorEntries(raw, OV(raw, []), [], me); ov.push(Object.assign(C.newEntry('n3'), { inT: '17:00', outT: '19:00' }));
  eq(C.editPlan(raw, ov, {}).errors.n3.map(e => e.code), ['shift_overlap'], 'a new shift over an existing one');
  // hours entered: read-only, its hours still count in the preview
  const he = edRow([Object.assign(ES('h1', '00:00', '23:59'), { hours_only: true, worked_min: 360, span_min: 360 })], { hours_only: true });
  const hen = C.editorEntries(he, he, [], me);
  eq([hen[0].readonly, C.editPlan(he, hen, {}).ops, C.entriesPreview(hen, he.work_date, C.TZ).worked], ['hours', [], 360]);
  // the preview: worked = span - unpaid, as on the board
  const pv = C.editorEntries(raw, OV(raw, []), [], me);
  eq(C.entriesPreview(pv, raw.work_date, C.TZ), { worked: 480 + 120, paid: 10, unpaid: 30, incomplete: false });
  pv[1].breaks.push({ startT: '17:00', endT: '17:30', kind: 'meal', orig: null }); pv[0].outT = '16:00';
  eq(C.entriesPreview(pv, raw.work_date, C.TZ), { worked: 510 + 90, paid: 10, unpaid: 60, incomplete: false });
  pv.push(C.newEntry('blank'));
  ok(C.entriesPreview(pv, raw.work_date, C.TZ).incomplete, 'a shift without times is left out and said so');
});
check('demo: made-up edits shaped like ts_edits (waiting, a conflict, a failure, in Gusto, cancelled, a New York add), all inside the window and valid', () => {
  const es = demo.edits;
  ok(Array.isArray(es) && es.length >= 6, 'demo edits');
  const emails = new Set(demo.access.map(a => a.email));
  for (const e of es) {
    eq(Object.keys(e).sort(), [...EDIT_COLS].sort(), 'columns of ' + e.id);
    ok(/^demo-edit-\d+$/.test(e.id), 'id ' + e.id);
    ok(emails.has(e.created_by) && (!e.cancelled_by || emails.has(e.cancelled_by) || e.cancelled_by === 'superseded'), 'made-up sign-ins only: ' + e.created_by);
    const r = demo.rows.find(x => x.id === e.day_id);
    ok(r && r.company === e.company && r.employee_uuid === e.employee_uuid && r.work_date === e.work_date && r.department === e.department, e.id + ' day');
    ok(C.canEditDate(e.work_date, demo.todays[r.region]), e.id + ' inside the window');
    if (e.after) eq(C.validateAfter(e.after, { tz: C.rowTz(r), date: r.work_date, beforeIn: e.before && e.before.in }), [], e.id + ' after is valid');
    if (e.shift_id) ok(r.shifts.some(s => s.id === e.shift_id), e.id + ' shift on the row');
  }
  const st = es.map(e => C.editStatus(e));
  for (const want of ['pending', 'attention', 'applied', 'cancelled']) ok(st.includes(want), 'a ' + want + ' edit');
  ok(es.some(e => e.times_status === 'conflict') && es.some(e => e.breaks_status === 'failed'), 'a conflict and a failure');
  ok(es.some(e => e.action === 'add' && e.region === 'NY' && e.times_status === 'pending'), 'a New York shift waiting to be added');
  ok(es.every(e => !/gianni|kelsey|scott/i.test(e.created_by)), 'no real sign-ins');
  // the board: waiting changes show, the cancelled one does not, the one in Gusto is plain; a note added here never
  // touches the hours or their pills (section 18 checks how notes show)
  const idx = new Map(); for (const e of es) { if (!idx.has(e.day_id)) idx.set(e.day_id, []); idx.get(e.day_id).push(e); }
  for (const [id, list] of idx) {
    const r = C.normRow(demo.rows.find(x => x.id === id));
    const o = C.overlayDay(r, list, { today: demo.todays[r.region] });
    const s = list.filter(e => !C.isNoteEdit(e)).map(C.editStatus);
    if (!s.length) { ok(o === r, id + ' only notes: the row as Gusto has it'); continue; }
    if (s.includes('pending')) ok(o.edit && o.edit.pending.length, id + ' Pending');
    if (s.includes('attention')) ok(o.edit && o.edit.attention.length && o.worked_min === r.worked_min, id + ' Needs a look, Gusto\'s hours');
    if (s.every(x => x === 'cancelled' || x === 'applied')) ok(o === r, id + ' plain');
    for (const sh of o.shifts) if (!sh.hours_only && sh.out) eq(sh.worked_min, sh.span_min - sh.breaks.filter(b => !b.paid).reduce((a, b) => a + b.min, 0), id + ' worked = span - unpaid');
  }
  // the whole flow in memory, as the demo page runs it: submit, the board shows it, cancel, it is gone
  const r = C.normRow(demo.rows.filter(x => !x.open && !x.hours_only && x.shifts.length === 1 && x.region === 'CA' && C.canEditDate(x.work_date, demo.todays.CA) && !idx.has(x.id))[0]);
  const snap = C.shiftSnap(r.shifts[0]);
  const later = C.zIso(C.zDate(Date.parse(snap.out) + 900000, C.TZ), C.zMinutes(Date.parse(snap.out) + 900000, C.TZ), C.TZ);
  const sub = C.submitEdit(es, r, { shift_id: r.shifts[0].id, action: 'update', after: Object.assign({}, snap, { out: later }) }, { email: 'trim.lead@wizardtrees.com', now: NOW, id: 'demo-edit-900' });
  ok(sub.ok, sub.error);
  const shown = C.overlayDay(r, sub.edits, { today: demo.todays.CA });
  eq([shown.worked_min - r.worked_min, shown.edit.pending.length], [15, 1]);
  const gone = C.cancelEdit(sub.edits, 'demo-edit-900', { email: 'trim.lead@wizardtrees.com', now: NOW });
  ok(gone.ok && C.overlayDay(r, gone.edits, { today: demo.todays.CA }) === r, 'cancelled: the row is Gusto\'s again');
  // the demo flags still come from the producer's rules, now shared with the board's overlay
  ok(/const flagsFor = \(day, today\) => C\.dayFlagsCA\(day, today\);/.test(block('ts-demo')) && /const flagsForNY = \(day, today, tz\) => C\.dayFlagsNY\(day, today, tz\);/.test(block('ts-demo')), 'one copy of the flag rules');
  ok(/S\.edits = new Map\(\(d\.edits \|\| \[\]\)\.map\(e => \[e\.id, e\]\)\); S\.editsState = 'ok';/.test(appFn('loadDemo')), 'the demo page loads them');
  ok(/C\.submitEdit\(list, raw,/.test(appFn('runEditOp')) && /C\.cancelEdit\(list, op\.id,/.test(appFn('runEditOp')), 'demo saves with the same rules, in memory');
});
check('page: reads ts_edits with the days (paged), a missing table turns Edit off without an error, saves through ts_edit_submit / ts_edit_cancel', () => {
  const app = block('ts-app');
  const fe = appFn('fetchEdits');
  ok(/fetchAll\(\(\) => sb\.from\('ts_edits'\)\.select\('\*'\)\.gte\('work_date', from\)\.lte\('work_date', to\)\.order\('created_at'\)\.order\('id'\)\)/.test(fe), 'paged read of the visible dates');
  ok(/\} catch \(e\) \{/.test(fe) && /isSetupError\(e\) \? 'missing'/.test(fe) && !/loadErr|throw/.test(fe), 'never throws, never shows a page error; a missing table = feature off');
  ok(/await fetchEdits\(from, to\);/.test(appFn('fetchDays')), 'after the days load');
  ok(/function editsLoaded\(\) \{ return DEMO \|\| S\.editsState === 'ok' \|\| S\.editsState === 'error'; \}/.test(app) &&
    /function editsOn\(\) \{ return !!S\.me && editsLoaded\(\) && \(DEMO \|\| !!S\.me\.is_admin \|\| EDITS_FOR_MANAGERS\); \}/.test(app), 'Edit only while the server has ts_edits');
  ok(/if \(S\.editsState === 'missing'\) S\.editsState = 'off';/.test(appFn('reload')), 'a reload tries again (the SQL may have been applied since)');
  const ro = appFn('runEditOp');
  ok(/sb\.rpc\('ts_edit_submit', Object\.assign\(\{ p_day_id: raw\.id, p_shift_id: op\.shift_id, p_action: op\.action, p_after: op\.after, p_note: note \|\| null \},\s*op\.shift_id != null \? \{ p_expect: op\.expect \|\| \[\] \} : \{\}\)\)/.test(ro), 'ts_edit_submit args (p_expect for an update or delete)');
  ok(/sb\.rpc\('ts_edit_cancel', \{ p_id: op\.id \}\)/.test(ro), 'ts_edit_cancel args');
  ok(/C\.supersede\(/.test(ro) && /await fetchEdits\(raw\.work_date, raw\.work_date\)/.test(appFn('saveDayEdits')), 'replaced edits marked at once, then the day re-read');
  if (SQL_EDITS) ok(/function public\.ts_edit_submit\(p_day_id text, p_shift_id text, p_action text,\s*p_after jsonb, p_note text\)/.test(SQL_EDITS) && /function public\.ts_edit_cancel\(p_id uuid\)/.test(SQL_EDITS), 'the RPCs in supabase/ts-edits.sql');
  ok(/function boardRows\(\) \{ return C\.overlayRows\(\[\.\.\.S\.rows\.values\(\)\], editIndex\(\), \{ now: Date\.now\(\), todayOf: rowToday, known: d => covered\(d, d\) \}\); \}/.test(app) && /C\.filterRows\(boardRows\(\),/.test(appFn('baseRows')), 'the board (tables, cards, totals, CSV) shows waiting changes, midnight settled with the days it has loaded');
  ok(/C\.editPlan\(raw0, E\.entries, \{ now: Date\.now\(\), neighbors: neighborShifts\(raw0\) \}\)/.test(appFn('saveDayEdits')) && /if \(Object\.keys\(plan\.errors\)\.length\)/.test(appFn('saveDayEdits')), 'Save checks everything first');
  ok(/if \(failed\.has\(op\.key\)\) continue;/.test(appFn('saveDayEdits')), 'a failed cancel never lets its new add through');
});
check('page: an Edit button at the row end (desktop) and in a card\'s detail (phone), the editor copy, history, and the admin Edits list', () => {
  const app = block('ts-app');
  ok(/\$\{editCell\(r\)\}<\/tr>/.test(appFn('dayRowOf')) && /\$\{editCell\(r\)\}<\/tr>/.test(appFn('empRow')), 'the last cell of a day row');
  ok(/data-act="edit-day" data-k="\$\{r\.id\}"/.test(appFn('editCell')) && /canEditRow\(r\)/.test(appFn('editCell')), 'only inside the window');
  ok(/edTd\(\)/.test(appFn('groupRow')) && /edTd\(\)/.test(appFn('empCard')), 'group and total rows keep the column count');
  ok(/canEditRow\(r\) \? h`<div class="pd-act"><button type="button" class="btn" data-act="edit-day"/.test(appFn('detailBody')) && /histList\(r\)/.test(appFn('detailBody')), 'phone: in the detail, with the history');
  const eb = appFn('editorBody');
  ok(/C\.editTimingText\(tz\)/.test(eb) && /Times are \$\{C\.regionDef\(raw\.region\)\.tzName\}/.test(eb), 'the editor says when changes reach Gusto, and the time zone');
  ok(/data-act="ed-add-shift"/.test(eb) && /id="edNote"/.test(eb) && /id="edPreview"/.test(eb) && /editorHistory\(raw, tz\)/.test(eb), 'add a shift, reason, preview, history');
  const eh = appFn('entryHtml');
  for (const want of ['Paid rest', 'Unpaid meal', 'data-act="ed-add-brk"', 'data-act="ed-rm-brk"', 'Delete this shift', 'Keep this shift', 'type="time"'])
    ok(eh.includes(want), 'the editor is missing ' + want);
  ok(/<div id="editPanel" class="overlay no-print" hidden>/.test(markup) && /<form class="sheet-body" id="edForm" novalidate><\/form>/.test(markup), 'the editor container (never printed)');
  const phone = src.match(new RegExp(PHONE_CSS.replace(/[()]/g, '\\$&') + '\\{([\\s\\S]*?)\\n  \\}\\n'))[1];
  ok(/#editPanel\{padding:0;border-width:0\}/.test(phone) && /#editPanel \.sheet\{width:100%;min-height:100%/.test(phone), 'a full-screen sheet on a phone');
  ok(/#editPanel input,#editPanel select\{font-size:16px;min-height:44px;width:100%;max-width:none\}/.test(phone), '16px fields, 44px taps');
  ok(/\.ed-brk\{display:grid;grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/.test(phone), 'break rows fit 320px (no sideways scroll)');
  ok(/env\(safe-area-inset-bottom/.test(phone.slice(phone.indexOf('#editPanel'))), 'Save clears the home indicator');
  ok(/if \(!\$\('editPanel'\)\.hidden\) \{ requestCloseEditor\(\); return; \}/.test(app) && /editorDirty\(\) && E\.confirm !== 'close'/.test(appFn('requestCloseEditor')), 'Escape asks before throwing typed changes away');
  ok(/\.ts th\.c-edit,\.ts td\.c-edit,\.ts col\.w-edit\{display:none\}/.test(src.slice(src.indexOf('@media print'))), 'print leaves the Edit column out');
  ok(/table\.ts\.day-t\.ed\{min-width:1460px\}/.test(src), 'the narrower-window tables make room for the Edit column');
  const ea = appFn('editsAdminHtml');
  ok(/\['all', 'All'\], \['pending', 'Pending'\], \['conflict', 'Conflict'\], \['failed', 'Failed'\]/.test(ea) && /e\.work_date >= S\.from && e\.work_date <= S\.to/.test(ea), 'Admin > Edits: the dates on screen, filtered to pending / conflict / failed');
  ok(/canX = mayCancel\(e\) && \(st === 'pending' \|\| clear\)/.test(appFn('editAdminRow')) && /canX \? h`<button type="button" class="btn sm \$\{done \? 'primary' : 'danger'\}" data-act="adm-e-x"/.test(appFn('editAdminRow')) && /case 'adm-e-x-yes': adminCancelEdit\(d\.id\); break;/.test(app), 'Cancel for waiting ones and Clear for Needs a look, after a confirm');
  ok(/editsOn\(\) \? \[\['edits', 'Edits'\]\] : \[\]/.test(appFn('renderAdminTabs')), 'the Edits tab only once the server has ts_edits');
  ok(/\(a\.is_admin \|\| e\.created_by === a\.email\)/.test(appFn('mayCancel')), 'cancel: the creator or an admin, like ts_edit_cancel');
  ok(!/em dash/.test('') && !src.includes('—'), 'no em dashes');
});

check('Save never sends from a stale copy: the editor reads the day again when it opens and before Save, and refuses when it changed', () => {
  const s2 = ES('s2', '16:00', '18:00');
  const raw = edRow([ED_S1, s2]);
  const st0 = C.dayStamp(raw, []);
  eq(C.dayStamp(C.normRow(JSON.parse(JSON.stringify(raw))), []), st0, 'the same day reads the same');
  eq(C.dayStamp(edRow([ED_S1, s2], { synced_at: '2026-10-08T12:00:00Z' }), []), st0, 'a sync that changed nothing is no change');
  eq(C.dayStamp(edRow([Object.assign({}, ED_S1, { out: '2026-10-06T15:30:40-07:00' }), s2]), []), st0, 'seconds never count');
  ok(C.dayStamp(edRow([ES('s1', '07:00', '15:45', ED_S1.breaks), s2]), []) !== st0, 'Gusto moved the end since');
  ok(C.dayStamp(edRow([ES('s1', '07:00', '15:30', [EB('09:00', '09:10', 'rest'), EB('11:30', '12:00', 'rest')]), s2]), []) !== st0, 'Gusto relabelled a break');
  ok(C.dayStamp(edRow([ED_S1]), []) !== st0, 'a shift went');
  const wait = ED({ id: 'w1', times_status: 'pending', after: AFTER('07:30', '15:30') });
  ok(C.dayStamp(raw, [wait]) !== st0, 'someone else made a change since');
  ok(C.dayStamp(raw, [Object.assign({}, wait, { times_status: 'applied', times_applied_at: '2026-10-07T13:00:00Z' })]) !== C.dayStamp(raw, [wait]), 'a change went to Gusto since');
  eq(C.dayStamp(raw, [ED({ id: 'o1', day_id: 'other:day', times_status: 'pending' })]), st0, 'other days do not count');
  eq(C.dayStamp(null, []), '');
  const app = block('ts-app');
  const oe = appFn('openEditor'), sv = appFn('saveDayEdits'), rd = appFn('refreshDay');
  ok(/sb\.from\('ts_days'\)\.select\('\*'\)\.eq\('id', dayId\)/.test(rd) && /await fetchEdits\(date, date\)/.test(rd) && /if \(DEMO\) return \{ ok: true \};/.test(rd), 'one day: its row by id and its changes');
  ok(/await Promise\.all\(\[refreshDay\(dayId\), neighborDays\(S\.rows\.get\(dayId\)\)\]\);/.test(oe) && /if \(tok !== edTok\) return;/.test(oe) && oe.indexOf('refreshDay(dayId)') < oe.indexOf('C.editorEntries(') && /E\.stamp = C\.dayStamp\(raw, editsFor\(dayId\)\);/.test(oe), 'the form is built after the read, and remembers the day it opened on');
  ok(/const fresh = await refreshDay\(k\);/.test(sv) && /C\.dayStamp\(raw, editsFor\(k\)\) !== E\.stamp/.test(sv) && sv.indexOf('await refreshDay(k)') < sv.indexOf('runEditOp('), 'Save reads the day again before it sends anything');
  ok(sv.includes('This day changed since you opened it. Reload it and try again.') && /E\.stale = fresh\.ok;/.test(sv) && /data-act="ed-reload">Reload this day</.test(appFn('editorBody')) && /case 'ed-reload': reloadEditor\(\); break;/.test(app), 'refused, in plain words, with a way to reload the day');
  ok(/Couldn't check this day for newer changes, so nothing was saved/.test(sv), 'a failed read sends nothing either');
  ok(/E\.stamp = C\.dayStamp\(S\.rows\.get\(k\), editsFor\(k\)\);/.test(sv), 'what this form saved does not block its own retry');
  ok(/if \(E\.loading\) return h`<p class="faint ed-load" role="status">/.test(appFn('editorBody')) && /if \(E\.busy \|\| E\.loading\) return;/.test(sv), 'while the day loads: no form, no Save');
  ok(/return done;/.test(appFn('fetchEdits')), 'fetchEdits says whether it read');
});
check('the runs the page promises are the ones the LaunchAgent source fires at (checked on the Mac that has ~/gusto-sync)', () => {
  const f = path.join(os.homedir(), 'gusto-sync', 'launchd', 'com.wizardtrees.ts-edit-worker.plist');
  if (!fs.existsSync(f)) return;   // anywhere else: nothing to compare with
  const sci = (fs.readFileSync(f, 'utf8').match(/<key>StartCalendarInterval<\/key>\s*<array>([\s\S]*?)<\/array>/) || [])[1];
  ok(sci, 'StartCalendarInterval in ' + f);
  const runs = [...sci.matchAll(/<dict>\s*<key>Hour<\/key>\s*<integer>(\d+)<\/integer>\s*<key>Minute<\/key>\s*<integer>(\d+)<\/integer>\s*<\/dict>/g)].map(m => +m[1] * 60 + +m[2]);
  ok(runs.length === (sci.match(/<dict>/g) || []).length, 'every entry is one Hour and one Minute');
  eq(runs.sort((a, b) => a - b), C.EDIT_RUNS_PT, 'EDIT_RUNS_PT and the LaunchAgent');
});
check('the launch switch went on with the LaunchAgent (launched 2026-10-22); no ?beta switch any more', () => {
  const app = block('ts-app');
  ok(/const EDITS_FOR_MANAGERS = true;/.test(app), 'managers have Edit: the worker runs on its own at 5 AM, noon and 7 PM');
  ok(/Turn it on in the SAME step that installs the LaunchAgent/.test(app), 'it says when it may go on');
  ok(!/\bBETA\b/.test(app) && !/QS\.has\('beta'\)/.test(app), 'no ?beta switch left over');
  ok(/edits: editsLoaded\(\)/.test(appFn('exportCsv')), 'the CSV marks changes whenever the board shows them, Edit or not');
  // what a manager may change is the server's call (ts_edit_submit); the page only hides Edit outside the window
  ok(/function canEditRow\(r\) \{ return editsOn\(\) && !!r && C\.canEditForRun\(r\.work_date, C\.rowTz\(r\), Date\.now\(\)\)/.test(app), 'Edit inside the current and previous pay period');
  if (SQL_EDITS) ok(/ts_can_view\(/.test(SQL_EDITS) && /grant execute on function public\.ts_edit_submit\([^)]*\) to authenticated/i.test(SQL_EDITS), 'ts_edit_submit is open to signed-in managers and checks who can see the day');
});
check('every promise of timing says 5 AM, noon and 7 PM Pacific (8 AM, 3 PM and 10 PM Eastern), for start and end times too', () => {
  const app = block('ts-app');
  ok(/<p class="ed-copy">\$\{C\.editTimingText\(tz\)\} Times are \$\{C\.regionDef\(raw\.region\)\.tzName\}\.<\/p>/.test(appFn('editorBody')), 'the editor: when, on the row\'s clock, and the zone');
  ok(!/Deleting a shift goes to Gusto with the breaks/.test(src), 'a delete has no separate timing line (the editor\'s top line covers it)');
  ok(/<span class="flag epend">Pending<\/span><span>changed here, goes to Gusto at <span id="keyRuns">5 AM, noon and 7 PM<\/span>; the row shows the change \(the pill reads Late if a run passed without it\)<\/span>/.test(markup), 'the Key (one grid cell for the words: the legend rows are display:contents)');
  ok(/if \(S\.pop === 'key'\) \$\('keyRuns'\)\.textContent = C\.editRunsText\(regionDef\(\)\.tz\);/.test(appFn('setPop')), 'the Key reads the region\'s clock (8 AM, 3 PM and 10 PM on New York)');
  ok(/Changes go to Gusto at 5 AM, noon and 7 PM Pacific \(8 AM, 3 PM and 10 PM Eastern\), start and end times and breaks together\./.test(app), 'Admin > Edits says both clocks');
  ok(/<span id="edHintRuns">5 AM, noon and 7 PM<\/span>/.test(markup), 'the first-use hint before it fills in');
  ok(!/\b(1|4|9) PM and (9 PM|midnight)\b/.test(src), 'nothing left of the old 1 PM and 9 PM runs');
  ok(/toast\(C\.saveMessage\(done, C\.nextEditRun\(Date\.now\(\), C\.rowTz\(raw\)\)\)\);/.test(appFn('saveDayEdits')) && /done\.push\(\{ op, edit: res\.edit \}\)/.test(appFn('saveDayEdits')), 'Save says when, on the row\'s clock, from what the server stored');
  ok(/Changes made here stay in this tab and never go to Gusto\./.test(markup), 'the demo bar says nothing reaches Gusto');
  ok(!/breaks task|Breaks go to Gusto|within minutes/.test(src.replace(block('ts-core'), '')), 'no copy left from the old two-speed plan');
  // the demo editor on a New York day and on a California day, as words
  const ny = demo.rows.find(r => r.region === 'NY');
  eq([C.editTimingText(C.rowTz(ny), NOW), C.regionDef(ny.region).tzName], ['Changes go to Gusto at 8 AM, 3 PM and 10 PM.', 'Eastern']);
});
check('a first-use hint for managers: one line, Got it closes it for good on this device, never for admins', () => {
  const app = block('ts-app');
  ok(/<div class="a2hs edhint no-print" id="edHint" role="note" hidden>/.test(markup) && /data-act="edhint-close">Got it</.test(markup), 'the note, hidden until wanted, never printed');
  const hint = markup.match(/<div class="a2hs edhint[\s\S]*?<\/div>/)[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  ok(hint.length < 120, 'one short line: ' + hint);
  const rh = appFn('renderEdHint');
  ok(/edHintCan && editsOn\(\) && !!v && !v\.is_admin && !shut && \$\('a2hs'\)\.hidden && !S\.printing/.test(rh), 'managers only, only with an Edit button on screen, never beside the home-screen note');
  ok(/store\.get\('edHint', ''\) === 'closed'/.test(rh) && /C\.editRunsText\(regionDef\(\)\.tz\)/.test(rh), 'remembered; the runs on the region\'s clock');
  const cl = appFn('closeEdHint');
  ok(/edHintShut = true;/.test(cl) && /if \(!DEMO && !S\.viewer\) store\.set\('edHint', 'closed'\);/.test(cl), 'a demo or a preview never writes it');
  ok(/edHintCan = rows\.some\(canEditRow\); renderEdHint\(\);/.test(appFn('render')) && /case 'edhint-close': closeEdHint\(\); break;/.test(app), 'wired');
  ok(/case 'a2hs-close': \$\('a2hs'\)\.hidden = true; renderEdHint\(\); break;/.test(app), 'it can show once the home-screen note is closed');
});
check('overdue: a waiting part past its time reads Late, and the demo shows one on time and one late', () => {
  const late = demo.edits.filter(e => C.editLate(e, NOW)), onTime = demo.edits.filter(e => C.editStatus(e) === 'pending' && !C.editLate(e, NOW) && e.times_status === 'pending');
  ok(late.some(e => e.times_status === 'pending'), 'a late start and end in the demo');
  ok(onTime.length >= 1, 'a start and end still on time in the demo');
  // at any time of day (the runs are 5 AM, noon and 7 PM Pacific, so "late" depends on the clock): one late, the rest on time
  for (let i = 0; i < 48; i++) {
    const t = Date.parse(NOW) + i * 30 * 60000 + 7 * 60000, d = D.build(t), wait = d.edits.filter(e => C.editStatus(e) === 'pending');
    const lateN = wait.filter(e => C.editLate(e, t)).length;
    ok(lateN === 1 && wait.length - lateN >= 2, new Date(t).toISOString() + ': ' + lateN + ' late of ' + wait.length + ' waiting');
  }
});
check("today's open shift is read-only in the editor (Still working); a missed clock-out on a past day stays editable", () => {
  const tdy = '2026-10-21', at = t => '2026-10-21T' + t + ':00-07:00', now = Date.parse('2026-10-21T18:00:00Z');   // 11 AM Pacific
  const open = { id: 'o1', in: at('06:30'), out: null, span_min: 0, worked_min: 0, hours_only: false, breaks: [{ start: at('09:00'), end: at('09:10'), min: 10, kind: 'rest', paid: true, src: 'gusto' }] };
  const done = { id: 'o0', in: at('05:00'), out: at('06:00'), span_min: 60, worked_min: 60, hours_only: false, breaks: [] };
  const raw = C.normRow(Object.assign({}, edRow([]), { id: 'filifera:e1:' + tdy, work_date: tdy, shifts: [done, open], first_in: done.in, last_out: null, open: true }));
  const me = { email: 'm@wizardtrees.com', is_admin: false };
  const en = C.editorEntries(raw, raw, [], me, { today: tdy, now });
  eq(en.map(e => e.readonly || ''), ['', 'open'], 'the open shift only');
  ok(C.stillWorking(open, tdy, tdy, now) && !C.stillWorking(done, tdy, tdy, now), 'stillWorking');
  ok(C.stillWorking(Object.assign({}, open, { in: '2026-10-20T22:00:00-07:00' }), '2026-10-20', tdy, now), 'past midnight, started 13 h ago: still going');
  ok(!C.stillWorking(Object.assign({}, open, { in: '2026-10-20T07:00:00-07:00' }), '2026-10-20', tdy, now), 'yesterday 7 AM, still open: a missed clock-out');
  eq(C.editPlan(raw, en, { now }).ops, [], 'nothing to send for it');
  en[0].outT = '06:15';
  eq(C.editPlan(raw, en, { now }).ops.map(o => [o.shift_id, o.action]), [['o0', 'update']], "the day's other shifts still change");
  eq(C.entriesPreview(C.editorEntries(raw, raw, [], me, { today: tdy, now }), tdy, C.TZ), { worked: 60, paid: 10, unpaid: 0, incomplete: false }, 'the preview counts it as the board does');
  const past = C.editorEntries(edRow([ES('s1', '07:00', null, [EB('09:00', '09:10', 'rest')])]), null, [], me, { today: tdy, now });
  ok(past[0].readonly === undefined && past[0].wasOpen, "a past day's open shift: fill in the clock-out");
  const eh = appFn('entryHtml');
  ok(eh.includes('Still working: this shift can be changed here after they clock out.'), 'the editor says why');
  ok(/C\.editorEntries\(raw, boardRow\(raw\), editsFor\(dayId\), actor\(\), \{ today: rowToday\(raw\), now: Date\.now\(\), neighbors: rawNeighbors\(raw\),/.test(appFn('openEditor')), "on the row's own clock");
});
check('history keeps replaced changes (muted, naming the change that replaced them) and shows the reason on a phone too', () => {
  const raw = edRow([ED_S1]);
  const ctx = (id, at, email) => ({ email: email || 'm@wizardtrees.com', now: at, today: '2026-10-07', id });
  const a = C.submitEdit([], raw, { shift_id: 's1', action: 'update', after: AFTER('07:30', '15:30', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']]), note: 'late bus' }, ctx('h1', '2026-10-07T16:00:00Z'));
  const b = C.submitEdit(a.edits, raw, { shift_id: 's1', action: 'update', after: AFTER('07:45', '15:30', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']]) }, ctx('h2', '2026-10-07T17:05:00Z', 'b@wizardtrees.com'));
  const old = b.edits.find(e => e.id === 'h1');
  eq([C.editStatus(old), C.editShownStatus(old, C.replacedEdits(b.edits))], ['cancelled', 'replaced'], 'replaced, not cancelled');
  eq(C.replacedBy(old, b.edits).id, 'h2');
  eq(C.replacedBy(b.edit, b.edits), null, 'the latest replaced nothing');
  eq(C.editPartLines(old, C.TZ, '2026-10-07T17:10:00Z', C.replacedBy(old, b.edits)), ["Replaced by b@wizardtrees.com's change, Oct 7, 10:05 AM"]);
  const byUser = C.cancelEdit(a.edits, 'h1', { email: 'm@wizardtrees.com', now: '2026-10-07T16:30:00Z' }).edit;
  eq(C.editShownStatus(byUser, new Set()), 'cancelled', 'cancelled by its maker stays Cancelled');
  const app = block('ts-app');
  ok(!/superseded/.test(appFn('histItems')), 'no edit of the day is left out');
  ok(/C\.replacedBy\(e, editsFor\(e\.day_id\)\)/.test(appFn('edLines')) && /st === 'replaced' && !e\.cancelled_at/.test(appFn('edLines')), 'one way to word it, in the editor, the phone card and Admin');
  for (const fn of ['histList', 'editorHistory', 'editAdminRow']) ok(/edLines\(e, /.test(appFn(fn)), fn + ' uses edLines');
  ok(/oldEdit\(st\) \? ' old' : ''/.test(appFn('histList')) && /oldEdit\(st\) \? h` class="old"` : ''/.test(appFn('editorHistory')) && /\.ed-hist li\.old\{color:var\(--muted\)\}/.test(src), 'muted');
  ok(/C\.editReason\(e\) \? \['Reason: ' \+ e\.note\] : \[\]/.test(appFn('histList')), 'the phone card shows the reason (a note\'s text is the change itself)');
});
check('the CSV marks a day showing a change Gusto does not have yet, in a last column', () => {
  const r = edRow([ED_S1]);
  const pend = OV(r, [ED({ times_status: 'pending', after: AFTER('07:30', '15:30', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']]) })]);
  const att = OV(edRow([ED_S1], { id: 'filifera:e2:2026-10-06', employee_uuid: 'e2', employee_name: 'Test Other' }), [ED({ day_id: 'filifera:e2:2026-10-06', times_status: 'conflict', after: AFTER('07:30', '15:30') })]);
  const lines = C.buildCsv([pend, att, edRow([ED_S1], { id: 'filifera:e3:2026-10-06', employee_uuid: 'e3', employee_name: 'Test Plain' })], { edits: true }).trim().split('\r\n');
  eq(lines[0].split(',').slice(-2), ['Flags', 'Change made here']);
  eq(lines.slice(1).map(l => [l.split(',')[3], l.split(',').pop()]), [['Test Edit', 'pending'], ['Test Other', 'needs a look'], ['Test Plain', '']]);
  eq(C.buildCsv([pend]).split('\r\n')[0], C.CSV_COLUMNS.join(','), 'without ts_edits the columns are as before');
  eq(C.csvEditCell(Object.assign({}, r, { edit: { pending: [1], attention: [1] } })), 'pending; needs a look');
});
check('only the time that moved is tinted; a break typed before a day shift starts is outside it (not "ends before it starts")', () => {
  const r = edRow([ES('s1', '07:00', null, [EB('09:00', '09:10', 'rest')])], { reg_min: null });
  const filled = OV(r, [ED({ times_status: 'pending', after: AFTER('07:00', '15:00', [['09:00', '09:10', 'rest']]) })]);
  eq([filled.shifts[0].edited.in, filled.shifts[0].edited.out], [false, true], 'a missed clock-out filled in: the start stays plain');
  eq(C.shiftParts(filled).map(p => [p.edIn, p.edOut]), [[false, true]]);
  const add = OV(edRow([ED_S1]), [ED({ id: 'a1', shift_id: null, action: 'add', before: null, after: AFTER('16:00', '18:00'), times_status: 'pending' })]);
  eq([add.shifts[1].edited.in, add.shifts[1].edited.out], [true, true], 'an added shift: both');
  ok(/s\.edited && s\.edited\[k\]/.test(appFn('inOutCells')) && /ed\(s, 'in'\)/.test(appFn('inOutCells')) && /ed\(s, 'out'\)/.test(appFn('inOutCells')), 'the table tints In and Out apart');
  // a 7:00 to 15:30 shift: a 6:55 break stays on its day, so it reads as outside the shift
  const en = C.entryOf(ED_S1, C.TZ);
  en.breaks.push({ startT: '06:55', endT: '07:00', kind: 'rest', orig: null });
  const a = C.entryAfter(en, '2026-10-06', C.TZ);
  eq([a.breaks[2].start, a.breaks[2].end], [EP('06:55'), EP('07:00')]);
  eq(codes(C.validateAfter(a, { tz: C.TZ, date: '2026-10-06' })), ['brk_outside']);
  // past midnight: a break in the after-midnight part goes to the next day (one across midnight too); one
  // typed before the start stays on its day, outside the shift
  const night = Object.assign(C.newEntry('n'), { inT: '22:00', outT: '06:00', breaks: [{ startT: '23:50', endT: '00:10', kind: 'rest' }, { startT: '03:00', endT: '03:30', kind: 'meal' }] });
  const na = C.entryAfter(night, '2026-10-06', C.TZ);
  eq(na.breaks.map(b => [b.start, b.end]), [['2026-10-06T23:50:00-07:00', '2026-10-07T00:10:00-07:00'], ['2026-10-07T03:00:00-07:00', '2026-10-07T03:30:00-07:00']]);
  eq(codes(C.validateAfter(na, { tz: C.TZ, date: '2026-10-06' })), []);
  night.breaks.push({ startT: '21:50', endT: '22:00', kind: 'rest' });
  const nb = C.entryAfter(night, '2026-10-06', C.TZ);
  eq([nb.breaks[2].start, nb.breaks[2].end], [EP('21:50'), EP('22:00')]);
  eq(codes(C.validateAfter(nb, { tz: C.TZ, date: '2026-10-06' })), ['brk_outside']);
});
check('after Save the row\'s Edit button gets the focus back; a reason alone keeps the editor open and says why', () => {
  const ce = appFn('closeEditor');
  ok(/const to = b && b\.isConnected \? b : rowEditTarget\(k\);/.test(ce) && /const k = E\.rowId;/.test(ce), 'focus goes back to the day\'s new Edit button');
  ok(/x\.dataset\.k === k && x\.getClientRects\(\)\.length/.test(appFn('rowEditTarget')) && /details\[data-k\]/.test(appFn('rowEditTarget')), 'on a phone, the card when its detail is closed');
  const sv = appFn('saveDayEdits');
  ok(sv.includes('A reason needs a change to go with it: change a time or a break, or clear the reason.') && sv.indexOf('A reason needs') < sv.indexOf("toast('Nothing changed')"), 'a reason alone is not thrown away silently');
  ok(/<th>By <span class="faint">\(Pacific time\)<\/span><\/th>/.test(appFn('editsAdminHtml')) && /C\.stampText\(e\.created_at, C\.TZ\)/.test(appFn('editAdminRow')), 'Admin > Edits: when each change was made, all in Pacific');
});

// ---------------------------------------------------------------------------------------------
// 15. the editor's Breaks line, a filled-in "+ Add break" and "Add missing breaks" (Gianni 2026-10-21:
//     "auto-generate a start end time that makes sense given the shift" and "show what kinds of breaks
//     are missing"). Synthetic rows only.
// ---------------------------------------------------------------------------------------------
const BK_ME = { email: 'm@wizardtrees.com', is_admin: true }, BK_NOW = Date.parse('2026-10-21T18:00:00Z');
const bkCtx = r => ({ date: r.work_date, tz: C.rowTz(r), company: r.company, region: r.region });
const bkEntries = r => C.editorEntries(r, r, [], BK_ME, { today: '2026-10-21', now: BK_NOW });
const bkStatus = (shifts, extra) => { const r = edRow(shifts, extra); return C.editorBreakStatus(bkEntries(r), bkCtx(r)); };
const BK_NY = { id: 'wtny:e1:2026-10-06', company: 'wtny', region: 'NY' };
const NE = (inT, outT, brks, key) => Object.assign(C.newEntry(key || 'n'), { inT, outT, breaks: (brks || []).map(([s, e, k]) => ({ startT: s, endT: e, kind: k, orig: null })) });
const CTX_F = { date: '2026-10-06', tz: C.TZ, company: 'filifera', region: 'CA' };
const CTX_NY = { date: '2026-10-06', tz: 'America/New_York', company: 'wtny', region: 'NY' };
const sug = (ents, key, c) => { const b = C.suggestBreak(ents, key || ents[0].key, c || CTX_F); return [b.startT, b.endT, b.kind]; };
const applyAdds = (ents, c) => { const adds = C.missingBreakAdds(ents, c || CTX_F); for (const a of adds) ents.find(e => e.key === a.key).breaks.push(a.brk); return adds; };
let bkSeed = 20261021;
const bkRnd = k => { bkSeed = (bkSeed * 1103515245 + 12345) % 2147483648; return Math.floor(bkSeed / 2147483648 * k); };
const hm = m => String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0') + ':' + String(((m % 60) + 60) % 60).padStart(2, '0');
// a made-up day as editor entries: 1 to 3 shifts (some past midnight), each with 0 to 3 breaks inside it
function bkDay() {
  const ents = [];
  let t = bkRnd(1200);
  for (let k = 1 + bkRnd(3); k > 0 && t < 1430; k--) {
    const len = Math.min(20 + bkRnd(720), 1430 - t + (ents.length ? 0 : 600)), brks = [];
    let b = t + 20 + bkRnd(150);
    for (let j = bkRnd(4); j > 0; j--) {
      const bl = [5, 10, 15, 20, 25, 30, 45][bkRnd(7)];
      if (b + bl > t + len) break;
      brks.push([hm(b), hm(b + bl), bkRnd(2) ? 'rest' : 'meal']);
      b += bl + 20 + bkRnd(150);
    }
    ents.push(NE(hm(t), hm(t + len), brks, 'f' + ents.length));
    t += len + [5, 20, 29, 30, 45][bkRnd(5)];
  }
  return ents;
}

check("the Breaks line uses the board's own rules: on every demo day and 600 made-up days it lists exactly the board's break flags", () => {
  eq([...C.BREAK_NEED_CODES].sort(), ['few_rest', 'late_meal', 'no_meal', 'no_second_meal', 'short_meal', 'short_rest']);
  const BC = new Set(C.BREAK_NEED_CODES);
  let n = 0;
  for (const r0 of demo.rows) {
    const r = C.normRow(r0);
    if (r.hours_only || r.shifts.some(s => !s.out)) continue;
    const want = r.flags.map(f => f.code).filter(c => BC.has(c)).sort();
    eq(C.missingBreaks(r.shifts, r.company, r.region, C.rowTz(r)).map(i => i.code).sort(), want, r.id);
    const st = C.editorBreakStatus(bkEntries(r), bkCtx(r));
    eq([st.state, st.items.map(i => i.code).sort()], [want.length ? 'missing' : 'ok', want], r.id + ' through the editor');
    n++;
  }
  ok(n > 200 && demo.rows.some(r => r.region === 'NY'), 'demo days checked: ' + n);
  // made-up days, rebuilt the way the board rebuilds an edited day, against dayFlags itself
  for (let i = 0; i < 600; i++) {
    const company = ['filifera', 'slane', 'wafgus', 'imperial', 'wtny'][bkRnd(5)], region = C.regionOfCompany(company), tz = C.rowTz({ company, region });
    const c = { date: '2026-10-06', tz, company, region };
    const d = C.entriesShifts(bkDay(), c.date, tz);
    const day = { company, region, work_date: c.date, shifts: d.shifts, worked_min: d.shifts.reduce((a, s) => a + s.worked_min, 0), hours_only: false, gusto_total_min: null, span_min: 0 };
    const want = C.dayFlags(day, '2026-10-21').map(f => f.code).filter(x => BC.has(x)).sort();
    eq(C.missingBreaks(d.shifts, company, region, tz).map(x => x.code).sort(), want, 'made-up day ' + i + ' (' + company + ')');
  }
  eq(C.missingBreaks([], 'filifera', 'CA'), [], 'no shifts');
  eq(C.missingBreaks([Object.assign(ES('h1', '00:00', '23:59'), { hours_only: true, worked_min: 600 })], 'filifera', 'CA'), [], 'hours entered: nothing to check');
});
check('the Breaks line in words: what is missing (the meal by its deadline), what to fix, complete, still clocked in', () => {
  const t = (shifts, extra) => { const s = bkStatus(shifts, extra); return [s.tone, s.text]; };
  eq(t([ES('s1', '07:00', '15:30')]), ['warn', 'Missing: an unpaid 30-min meal by 12:00 PM · 2 paid 15-min rests']);
  eq(t([ED_S1]), ['warn', 'Missing: 1 more paid 15-min rest']);
  eq(t([ES('s1', '07:00', '15:30', [EB('09:00', '09:15', 'rest'), EB('11:30', '12:00', 'meal'), EB('13:30', '13:45', 'rest')])]), ['ok', 'Breaks look complete']);
  eq(t([ES('s1', '07:00', '15:30', [EB('09:00', '09:15', 'rest'), EB('12:30', '13:00', 'meal'), EB('14:00', '14:15', 'rest')])])[1], 'Meal starts too late: start it by 12:00 PM');
  eq(t([ES('s1', '07:00', '15:30', [EB('09:00', '09:05', 'rest'), EB('11:00', '11:20', 'meal'), EB('13:00', '13:15', 'rest')])])[1], 'Meal under 30 min · Rest under 10 min');
  eq(t([ES('s1', '06:00', '18:30')])[1], 'Missing: an unpaid 30-min meal by 11:00 AM · a second unpaid 30-min meal · 3 paid 15-min rests');
  eq(t([ES('s1', '07:00', '15:30')], { id: 'imperial:e1:2026-10-06', company: 'imperial' })[1], 'Missing: an unpaid 30-min meal by 12:00 PM · 2 paid 10-min rests', 'Imperial rests are 10 min');
  eq(t([ES('s1', '07:00', '11:00'), ES('s2', '11:30', '16:00')])[1], 'Missing: 2 paid 15-min rests', '30 min off the clock is the meal');
  eq(t([ES('s1', '07:00', '11:00'), ES('s2', '11:15', '16:00')])[1], 'Missing: an unpaid 30-min meal by 12:15 PM · 2 paid 15-min rests', 'a 15-min gap is not, and the deadline counts time on the clock only');
  eq(t([ES('s1', '07:00', '10:00')]), ['ok', 'Breaks look complete'], 'a short day needs none');
  // New York: a 30-min meal over 6 hours, no rests (Pacific 05:00 is 8:00 AM Eastern)
  eq(t([ES('s1', '05:00', '13:30')], BK_NY), ['warn', 'Missing: an unpaid 30-min meal (over 6 hours worked)']);
  eq(t([ES('s1', '05:00', '11:00')], BK_NY), ['ok', 'Breaks look complete'], '6 hours exactly');
  eq(t([ES('s1', '05:00', '13:30', [EB('09:00', '09:20', 'meal')])], BK_NY)[1], 'Meal under 30 min');
  eq(t([ES('s1', '05:00', '13:30', [EB('09:00', '09:30', 'meal')])], BK_NY)[1], 'Breaks look complete');
  ok(!/rest/i.test(t([ES('s1', '05:00', '15:30')], BK_NY)[1]), 'never a rest in New York');
  // still clocked in, a shift without times, hours entered, no shifts
  const tdy = '2026-10-21', at = x => tdy + 'T' + x + ':00-07:00';
  const open = C.normRow(Object.assign({}, edRow([]), { id: 'filifera:e1:' + tdy, work_date: tdy, open: true,
    shifts: [{ id: 'o1', in: at('06:30'), out: null, span_min: 0, worked_min: 0, hours_only: false, breaks: [] }] }));
  const os = C.editorBreakStatus(bkEntries(open), bkCtx(open));
  eq([os.state, os.tone, os.text], ['open', 'info', 'Breaks are checked after they clock out']);
  const blank = bkEntries(edRow([ED_S1])); blank.push(C.newEntry('nb'));
  eq(C.editorBreakStatus(blank, CTX_F).text, 'Breaks are checked once each shift has a start and an end');
  const he = edRow([Object.assign(ES('h1', '00:00', '23:59'), { hours_only: true, worked_min: 480, span_min: 480 })], { hours_only: true });
  eq([C.editorBreakStatus(bkEntries(he), bkCtx(he)).state, C.editorBreakStatus(bkEntries(he), bkCtx(he)).text], ['hours', '']);
  eq(C.editorBreakStatus([], CTX_F).text, '');
  // live: the day as edited, deleted shifts left out
  const en = bkEntries(edRow([ED_S1]));
  en[0].outT = '12:00';
  eq(C.editorBreakStatus(en, CTX_F).text, 'Breaks look complete', '5 hours less the meal needs one rest');
  en[0].outT = '15:30'; en[0].breaks.push({ startT: '13:30', endT: '13:45', kind: 'rest', orig: null });
  eq(C.editorBreakStatus(en, CTX_F).text, 'Breaks look complete');
  en[0].breaks[1].kind = 'rest';
  eq(C.editorBreakStatus(en, CTX_F).text, 'Missing: an unpaid 30-min meal by 12:00 PM', 'a meal changed to a paid rest');
  en[0].del = true;
  eq(C.editorBreakStatus(en, CTX_F).text, '', 'every shift deleted: no line');
  ok(!src.includes('—'), 'no em dashes');
});
check('+ Add break comes filled in: a missing meal about 4 hours in (1 to 5 hours, by the deadline), else a paid rest of the company length mid-stretch; inside the shift, never over a break', () => {
  eq(sug([NE('07:00', '15:30')]), ['11:00', '11:30', 'meal'], 'a meal 4 hours in');
  eq(sug([NE('07:00', '11:30')]), ['09:10', '09:25', 'rest'], 'no meal needed: a 15-min rest in the middle');
  eq(sug([NE('07:00', '11:30')], null, Object.assign({}, CTX_F, { company: 'imperial' })), ['09:10', '09:20', 'rest'], 'Imperial: 10 min');
  eq(sug(bkEntries(edRow([ED_S1]))), ['13:40', '13:55', 'rest'], 'the longest stretch, 12:00 to 3:30');
  // the next free slot, a minute clear of the rest (Gusto has not been seen to take two breaks edge to edge), on a 5-minute mark
  eq(sug([NE('07:00', '15:30', [['10:55', '11:10', 'rest']])]), ['11:15', '11:45', 'meal'], 'over a break: the next free slot');
  eq(sug([NE('07:00', '15:30', [['10:50', '12:00', 'rest']])]), ['10:15', '10:45', 'meal'], 'never past the 5-hour mark: earlier instead (a minute clear of the rest)');
  eq(sug([NE('06:00', '18:30', [['10:00', '10:30', 'meal']])]), ['14:30', '15:00', 'meal'], 'a second meal 4 hours after the first');
  eq(sug([NE('07:00', '09:00', null, 'a'), NE('09:15', '15:00', null, 'b')], 'b'), ['12:15', '12:45', 'meal'], 'by the day\'s deadline (5 hours on the clock), before 4 hours into this shift');
  eq(sug([NE('07:00', '15:30', [['09:00', '09:15', 'rest'], ['11:30', '12:00', 'meal'], ['13:30', '13:45', 'rest']])]), ['10:15', '10:30', 'rest'], 'complete: another rest the same way (the middle of 9:15 to 11:30)');
  // the clock-in's seconds: the break never starts before it
  const sec = C.entryOf({ id: 's9', in: '2026-10-06T07:02:30-07:00', out: '2026-10-06T15:31:10-07:00', breaks: [] }, C.TZ);
  sec.key = 'k9';
  eq(sug([sec]), ['11:05', '11:35', 'meal'], 'on a 5-minute mark');
  // tiny, zero-length and blank shifts never fail
  eq(sug([NE('07:00', '07:20')]), ['07:00', '07:10', 'rest'], 'under 30 min: a 10-min rest at the start');
  eq(sug([NE('07:00', '07:00')]), ['07:00', '07:10', 'rest'], 'zero length');
  eq(sug([NE('', '')]), ['', '', 'rest'], 'no times yet: blank, as before');
  eq(sug([NE('07:00', '')]), ['', '', 'rest'], 'no end yet');
  // New York: the meal the same way, a 10-min rest otherwise; past midnight on the next day
  eq(sug([NE('08:00', '16:30')], null, CTX_NY), ['12:00', '12:30', 'meal']);
  eq(sug([NE('08:00', '12:00')], null, CTX_NY), ['09:55', '10:05', 'rest']);
  eq(sug([NE('22:00', '06:30')]), ['02:00', '02:30', 'meal'], 'past midnight');
  // pure: the entries are never changed
  const ents = [NE('07:00', '15:30')]; sug(ents); C.missingBreakAdds(ents, CTX_F);
  eq(ents[0].breaks.length, 0, 'nothing added by asking');
  // made-up shifts: the break fits inside, never overlaps, and a meal keeps to its window when it can
  for (let i = 0; i < 400; i++) {
    const day = bkDay(), en = day[bkRnd(day.length)];
    const b = C.suggestBreak(day, en.key, CTX_F);
    const sm = C.entryAfter(en, '2026-10-06', C.TZ), span = (Date.parse(sm.out) - Date.parse(sm.in)) / 60000;
    en.breaks.push(b);
    const errs = C.validateAfter(C.entryAfter(en, '2026-10-06', C.TZ), { tz: C.TZ, date: '2026-10-06' }).filter(e => e.brk === en.breaks.length - 1 || e.code === 'brk_overlap');
    if (span > 0 && b.startT) eq(errs.map(e => e.code), [], 'made-up day ' + i + ': ' + J([en.inT, en.outT, en.breaks]));
    if (span > 0 && !b.startT) { const sm = C.entryAfter(Object.assign({}, en, { breaks: en.breaks.slice(0, -1) }), '2026-10-06', C.TZ);
      ok(!C.freeStretches(Date.parse(sm.in) / 60000, Date.parse(sm.out) / 60000, sm.breaks.map(x => [Date.parse(x.start) / 60000, Date.parse(x.end) / 60000])).some(g => g[1] - g[0] >= 1), 'made-up day ' + i + ': blank only on a full shift'); }
    if (b.kind === 'meal' && span >= 330) {
      const st = C.parseHhmm(b.startT), inM = C.parseHhmm(en.inT), off = ((st - inM) % 1440 + 1440) % 1440;
      ok(off >= 60 || en.breaks.length > 1, 'made-up day ' + i + ': a meal under 1 hour in ' + J([en.inT, b]));
    }
  }
});
check('Add missing breaks: every missing meal and rest in one tap, placed the same way, only on shifts that can change; the day then reads complete', () => {
  const day = [NE('07:00', '15:30')];
  eq(applyAdds(day).map(a => [a.brk.startT, a.brk.endT, a.brk.kind]), [['08:55', '09:10', 'rest'], ['11:00', '11:30', 'meal'], ['13:25', '13:40', 'rest']], 'in time order');
  eq(C.editorBreakStatus(day, CTX_F).state, 'ok');
  eq(C.missingBreakAdds(day, CTX_F), [], 'complete: nothing to add');
  const long = [NE('06:00', '18:30')];
  eq(applyAdds(long).map(a => a.brk.kind), ['rest', 'meal', 'rest', 'meal', 'rest']);
  eq(C.editorBreakStatus(long, CTX_F).state, 'ok', '12.5 hours: two meals, three rests');
  const night = [NE('22:00', '06:30')];
  applyAdds(night);
  eq([C.editorBreakStatus(night, CTX_F).state, codes(C.validateAfter(C.entryAfter(night[0], '2026-10-06', C.TZ), { tz: C.TZ, date: '2026-10-06' }))], ['ok', []], 'past midnight');
  const two = [NE('07:00', '11:00', null, 'a'), NE('11:15', '16:00', null, 'b')];
  const ta = applyAdds(two);
  eq(ta.filter(a => a.brk.kind === 'meal').map(a => [a.key, a.brk.startT]), [['b', '12:15']], 'the meal on the shift its deadline falls in');
  eq(C.editorBreakStatus(two, CTX_F).state, 'ok');
  const ro = [NE('07:00', '15:30', null, 'a'), NE('16:00', '18:00', null, 'b')]; ro[0].readonly = 'sent';
  ok(applyAdds(ro).every(a => a.key === 'b'), 'never on a shift that cannot change');
  const ny = [NE('08:00', '16:30')];
  eq(applyAdds(ny, CTX_NY).map(a => [a.brk.startT, a.brk.endT, a.brk.kind]), [['12:00', '12:30', 'meal']], 'New York: the meal only');
  eq(C.editorBreakStatus(ny, CTX_NY).state, 'ok');
  // made-up days: what is added is valid and never overlaps, and nothing addable is left unless a shift is full
  for (let i = 0; i < 300; i++) {
    const d = bkDay(), adds = applyAdds(d);
    for (const en of d) eq(codes(C.validateAfter(C.entryAfter(en, '2026-10-06', C.TZ), { tz: C.TZ, date: '2026-10-06' })), [], 'made-up day ' + i + ' ' + J(d.map(e => [e.inT, e.outT, e.breaks.map(b => [b.startT, b.endT, b.kind])])));
    const left = C.editorBreakStatus(d, CTX_F).items.filter(x => C.BREAK_ADD_CODES.includes(x.code));
    ok(!left.length || d.some(en => en.breaks.length >= C.EDIT_RULES.maxBreaks), 'made-up day ' + i + ' still missing ' + J(left) + ' after ' + adds.length);
  }
});
check('the Missing line lists what to add once the needed meals are in (a meal is 30 min less worked), the same as Add missing breaks adds', () => {
  const tx = (ents, c) => C.editorBreakStatus(ents, c || CTX_F).text, cs = (ents, c) => C.editorBreakStatus(ents, c || CTX_F).items.map(i => i.code);
  const d1 = [NE('07:00', '13:30')];
  eq(tx(d1), 'Missing: an unpaid 30-min meal by 12:00 PM · a paid 15-min rest', '6.5 hours: 6 once the meal is in, one rest');
  eq(cs(d1), ['no_meal', 'few_rest'], "the board's codes stay");
  eq(applyAdds(d1).length, 2); eq(tx(d1), 'Breaks look complete');
  eq(tx([NE('07:00', '13:15')]), 'Missing: an unpaid 30-min meal by 12:00 PM · a paid 15-min rest');
  const d2 = [NE('07:00', '17:15')];
  eq(tx(d2), 'Missing: an unpaid 30-min meal by 12:00 PM · 2 paid 15-min rests', '10.25 hours: under 10 once the meal is in, no second meal');
  eq(cs(d2), ['no_meal', 'no_second_meal', 'few_rest']);
  eq(applyAdds(d2).length, 3); eq(tx(d2), 'Breaks look complete');
  const d3 = [NE('07:00', '19:30', [['09:00', '09:15', 'rest'], ['15:00', '15:15', 'rest']])];
  eq(tx(d3), 'Missing: an unpaid 30-min meal by 12:00 PM · a second unpaid 30-min meal · 1 more paid 15-min rest');
  // made-up days: the line's counts are exactly what the one tap adds, and the day then reads complete
  for (let i = 0; i < 300; i++) {
    const company = ['filifera', 'imperial', 'wtny'][bkRnd(3)], region = C.regionOfCompany(company), c = { date: '2026-10-06', tz: C.rowTz({ company, region }), company, region };
    const d = bkDay(), want = C.editorBreakStatus(d, c).items.reduce((a, x) => a + x.add, 0), adds = applyAdds(d, c);
    if (d.some(en => en.breaks.length >= C.EDIT_RULES.maxBreaks)) continue;
    eq([adds.length, C.editorBreakStatus(d, c).items.filter(x => x.add > 0)], [want, []], 'made-up day ' + i + ' ' + J(d.map(e => [e.inT, e.outT, e.breaks.map(b => [b.startT, b.endT, b.kind])])));
  }
});
check('a meal that starts too late gets an on-time one when that is the fix; meals leave work after them and go on the right shift', () => {
  const tx = ents => C.editorBreakStatus(ents, CTX_F).text;
  // a late meal on a day that also needs a second: one meal by the deadline covers both
  const l1 = [NE('07:00', '18:00', [['13:00', '13:30', 'meal']])];
  eq(tx(l1), 'Missing: an unpaid 30-min meal by 12:00 PM (the 1:00 PM meal starts too late) · 2 paid 15-min rests');
  eq(sug(l1), ['11:00', '11:30', 'meal'], '+ Add break: the on-time meal');
  eq(applyAdds(l1).map(a => [a.brk.startT, a.brk.kind]), [['08:55', 'rest'], ['11:00', 'meal'], ['15:40', 'rest']]);
  eq(tx(l1), 'Breaks look complete');
  // the late one is time off the clock between shifts: nothing to move, so a meal on the first shift
  const l2 = [NE('06:00', '12:00', null, 'a'), NE('12:45', '14:45', null, 'b')];
  eq(tx(l2), 'Missing: an unpaid 30-min meal by 11:00 AM (the 12:00 PM time off the clock starts too late) · 2 paid 15-min rests');
  eq(sug(l2, 'a'), ['10:00', '10:30', 'meal']);
  eq(sug(l2, 'b'), ['13:40', '13:55', 'rest'], 'Shift 2 starts after the deadline: a rest');
  eq(applyAdds(l2).filter(a => a.brk.kind === 'meal').map(a => [a.key, a.brk.startT]), [['a', '10:00']]);
  eq(tx(l2), 'Breaks look complete');
  // a late meal that can just move: the line says so and the one tap adds no extra meal; + Add break offers an on-time one
  const l3 = [NE('07:00', '15:30', [['09:00', '09:15', 'rest'], ['12:30', '13:00', 'meal'], ['14:00', '14:15', 'rest']])];
  eq(tx(l3), 'Meal starts too late: start it by 12:00 PM');
  eq(C.missingBreakAdds(l3, CTX_F), []);
  eq(sug(l3), ['11:00', '11:30', 'meal']);
  // a meal keeps 30 minutes of work after it; on a later shift past the deadline, 1 hour in
  eq(sug([NE('08:00', '12:00', null, 'a'), NE('12:10', '16:10', null, 'b')], 'b', CTX_NY), ['15:10', '15:40', 'meal'], 'New York, Shift 2: not the last 30 minutes');
  eq(sug([NE('06:00', '12:00', null, 'a'), NE('12:15', '18:15', null, 'b')], 'b'), ['13:15', '13:45', 'meal'], 'deadline 11:00 AM passed before Shift 2');
  eq(sug([NE('07:00', '18:00', [['10:00', '10:30', 'meal'], ['14:00', '14:15', 'rest']])]), ['14:30', '15:00', 'meal'], 'a second meal 4 hours after the first');
  // two equal shifts: the second meal on the shift 4 hours after the first one ends
  const e2 = [NE('06:00', '12:00', null, 'a'), NE('12:15', '18:15', null, 'b')];
  eq(applyAdds(e2).filter(a => a.brk.kind === 'meal').map(a => [a.key, a.brk.startT]), [['a', '10:00'], ['b', '14:30']]);
  eq(tx(e2), 'Breaks look complete');
  // made-up shifts with room: a suggested meal never ends in the last 30 minutes
  for (let i = 0; i < 300; i++) {
    const day = bkDay(), en = day[bkRnd(day.length)];
    if (en.breaks.length) continue;
    const b = C.suggestBreak(day, en.key, CTX_F);
    const span = ((C.parseHhmm(en.outT) - C.parseHhmm(en.inT)) % 1440 + 1440) % 1440;
    if (b.kind === 'meal' && span >= 90) ok(((C.parseHhmm(en.outT) - C.parseHhmm(b.endT)) % 1440 + 1440) % 1440 >= 30, 'made-up day ' + i + ': ' + J([en.inT, en.outT, b]));
  }
});
check('tiny or full shifts: + Add break never overlaps a break or runs past the end (blank when there is no room); added breaks go in time order', () => {
  eq(sug([NE('07:00', '07:25', [['07:00', '07:10', 'rest']])]), ['07:11', '07:21', 'rest'], 'the next free minute, a minute clear of the rest');
  eq(sug([NE('07:00', '07:20', [['07:00', '07:10', 'rest']])]), ['07:11', '07:20', 'rest'], 'a minute clear, shorter to fit');
  eq(sug([NE('07:00', '07:11', [['07:00', '07:10', 'rest']])]), ['07:10', '07:11', 'rest'], 'no room for the minute: edge to edge rather than nothing');
  eq(sug([NE('07:00', '07:05')]), ['07:00', '07:05', 'rest'], 'cut to the shift');
  eq(sug([NE('07:00', '08:00', [['07:00', '07:30', 'rest'], ['07:30', '08:00', 'rest']])]), ['', '', 'rest'], 'no free minute: blank');
  const tiny = [NE('07:00', '07:25')];
  for (let k = 0; k < 6; k++) { const b = C.suggestBreak(tiny, tiny[0].key, CTX_F); if (!b.startT) break; tiny[0].breaks.push(b); }
  // a minute between breaks while there is room; a gap of a minute is not filled with a sliver of a break
  eq(tiny[0].breaks.map(b => [b.startT, b.endT]), [['07:00', '07:10'], ['07:11', '07:21'], ['07:22', '07:25']], 'pressed again and again: never stacked');
  eq(codes(C.validateAfter(C.entryAfter(tiny[0], '2026-10-06', C.TZ), { tz: C.TZ, date: '2026-10-06' })), []);
  const zero = [NE('07:00', '07:00', [['07:00', '07:10', 'rest']])];
  eq(sug(zero), ['', '', 'rest'], 'zero length: the 10-min rest once');
  // a break with only a start (still open) or only an end keeps 15 minutes beside that time clear
  const open = [NE('08:00', '16:25', [['09:55', '10:05', 'rest'], ['12:10', '', 'rest'], ['14:10', '14:20', 'rest']])];
  const om = applyAdds(open).map(a => a.brk).find(b => b.kind === 'meal');
  ok(om && (C.parseHhmm(om.endT) <= 12 * 60 + 10 || C.parseHhmm(om.startT) >= 12 * 60 + 25), 'meal clear of the open 12:10 break: ' + J(om));
  const half = [NE('08:00', '16:30', [['', '12:00', 'rest']])], hb = C.suggestBreak(half, half[0].key, CTX_F);
  ok(C.parseHhmm(hb.endT) <= 11 * 60 + 45 || C.parseHhmm(hb.startT) >= 12 * 60, 'clear of a break with only its 12:00 end: ' + J(hb));
  // time order (Save sorts them too)
  const o = NE('07:00', '15:30', [['10:50', '11:05', 'rest'], ['14:30', '15:00', 'meal']]);
  const nb = (s, e) => ({ startT: s, endT: e, kind: 'rest', orig: null });
  eq([C.breakIndexFor(o, nb('12:40', '12:55'), '2026-10-06', C.TZ), C.breakIndexFor(o, nb('07:30', '07:45'), '2026-10-06', C.TZ),
    C.breakIndexFor(o, nb('15:10', '15:20'), '2026-10-06', C.TZ), C.breakIndexFor(o, nb('', ''), '2026-10-06', C.TZ)], [1, 0, 2, 2]);
  const night = NE('22:00', '06:00', [['23:00', '23:15', 'rest']]);
  eq([C.breakIndexFor(night, nb('02:00', '02:15'), '2026-10-06', C.TZ), C.breakIndexFor(night, nb('22:30', '22:45'), '2026-10-06', C.TZ)], [1, 0], 'past midnight: 2:00 AM comes after 11:00 PM');
});
check('page: the Breaks line sits under the shifts and updates as times change; + Add break comes filled in; Add missing breaks adds them all', () => {
  const app = block('ts-app'), eb = appFn('editorBody');
  ok(/<div id="edBreaks" aria-live="polite">\$\{breakLineHtml\(raw, tz\)\}<\/div>/.test(eb), 'the line');
  ok(eb.indexOf('entryHtml(en, i, tz)') < eb.indexOf('id="edBreaks"') && eb.indexOf('id="edBreaks"') < eb.indexOf('data-act="ed-add-shift"'), 'under the shifts, above + Add a shift');
  const bl = appFn('breakLineHtml');
  ok(/C\.editorBreakStatus\(E\.entries, ctx\)/.test(bl) && /class="ed-bline \$\{st\.tone\}"/.test(bl) && /data-act="ed-add-missing">Add missing breaks</.test(bl) && /C\.missingBreakAdds\(E\.entries, ctx\)\.length > 0/.test(bl), 'status, tone, and the one-tap link only when it would add something');
  ok(/const region = raw\.region \|\| C\.regionOfCompany\(raw\.company\), z = tz \|\| C\.rowTz\(raw\)/.test(appFn('edCtx')) && /tz: z, company: raw\.company, region,/.test(appFn('edCtx')), "the row's own region and clock");
  ok(/setHTML\(\$\('edBreaks'\), breakLineHtml\(raw, tz\)\)/.test(appFn('onEditorInput')), 'live as times and types change');
  ok(/edInsertBreak\(raw, en, C\.suggestBreak\(E\.entries, k, edCtx\(raw\)\)\)/.test(appFn('edAddBreak')) && /edFocus\(k, 'bs', i\)/.test(appFn('edAddBreak')), '+ Add break is filled in, and the new break gets the focus');
  ok(/C\.breakIndexFor\(en, b, raw\.work_date, C\.rowTz\(raw\)\); en\.breaks\.splice\(i, 0, b\)/.test(appFn('edInsertBreak')) && /edInsertBreak\(raw, en, a\.brk\)/.test(appFn('edAddMissing')) && !/en\.breaks\.push/.test(appFn('edAddBreak') + appFn('edAddMissing')), 'added breaks go in among the others in time order');
  ok(/case 'ed-add-missing': edAddMissing\(\); break;/.test(app) && /C\.missingBreakAdds\(E\.entries, edCtx\(raw\)\)/.test(appFn('edAddMissing')) && /Check the times, then save\./.test(appFn('edAddMissing')), 'Add missing breaks, then a note to check them');
  ok(/\.ed-bline\.warn\{border-color:var\(--unpaid-line\)/.test(src) && /\.ed-bline\.ok\{border-color:var\(--paid-line\)/.test(src), 'amber while missing, green when complete');
});

// ---------------------------------------------------------------------------------------------
// 16. the rollout review of 2026-10-21 (Gianni: "roll out the edit feature to all the current managers"):
//     one check per fix. Synthetic rows only.
// ---------------------------------------------------------------------------------------------
check('review: a change being sent to Gusto (applying) stays Pending with its times, says "going to Gusto now", and cannot be changed or cancelled meanwhile', () => {
  const raw = edRow([ED_S1]), me = { email: 'm@wizardtrees.com', is_admin: false };
  const after = AFTER('07:30', '15:30', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']]);
  const sending = ED({ times_status: 'applying', times_claimed_at: '2026-10-07T19:00:05Z', after });   // claimed by the noon run
  eq([C.editStatus(sending), C.editShownStatus(sending, new Set()), C.partShow(sending, 'times', 0)], ['pending', 'pending', 'pending'], 'never Undone');
  const o = OV(raw, [sending]);
  eq([o.first_in, o.edit.pending.length, o.shifts[0].edited.times], [EP('07:30'), 1, 'pending'], 'the board keeps the change and its Pending pill');
  eq(C.editPartLines(sending, C.TZ, '2026-10-07T19:10:00Z'), ['Start and end: going to Gusto now']);
  eq(C.editPartLines(sending, C.TZ, '2026-10-07T19:40:00Z'), ['Start and end: late, not in Gusto yet'], 'a claim half an hour old: the run stopped half way');
  ok(C.editTip(sending, C.TZ, '2026-10-07T19:10:00Z').startsWith('Pending: changed here, not in Gusto yet.'), 'the bubble');
  eq(C.editorEntries(raw, o, [sending], me).map(e => e.readonly || ''), ['applying'], 'read-only in the editor');
  const del = ED({ id: 'd1', action: 'delete', after: null, breaks_status: 'applying' });
  eq(C.editorEntries(raw, OV(raw, [del]), [del], me).map(e => [e.del, e.readonly]), [[true, 'applying']], 'a delete being sent');
  ok(!C.cancelEdit([sending], 'x1', { email: 'boss@wizardtrees.com', is_admin: true }).ok, 'nobody cancels it then (ts_edit_cancel refuses)');
  ok(/being sent to Gusto right now/.test(C.submitEdit([sending], raw, { shift_id: 's1', action: 'update', after: AFTER('07:45', '15:30') }, { email: me.email, now: '2026-10-07T20:05:00Z', today: '2026-10-07', id: 'n' }).error), 'nor replaces it (ts_edit_submit refuses)');
  ok(/'applying'/.test(SQL_EDITS || "'applying'"), 'the server has the status');
  const app = block('ts-app');
  ok(/!C\.editSending\(e\)/.test(appFn('mayCancel')), 'no Cancel button while it is sent');
  ok(appFn('entryHtml').includes('Being sent to Gusto right now. It can be changed here once that is done.'), 'the editor says why');
  ok(/pending: e => has\(e, 'pending'\) \|\| has\(e, 'applying'\)/.test(appFn('editsAdminHtml')), 'Admin > Edits counts it as Pending');
  ok(/being sent to Gusto right now\/i\.test\(errText\(error\)\)/.test(appFn('runEditOp')), "the server's \"try again in a few minutes\" is not repeated");
});
check('review: Needs a look can be cleared by its maker or an admin once Gusto is checked and right (ts_edit_cancel allows it)', () => {
  const raw = edRow([ED_S1]);
  const att = ED({ id: 'c1', times_status: 'conflict', times_error: 'Clock-in moved in Gusto.', after: AFTER('07:30', '15:30', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']]) });
  const cl = C.cancelEdit([att], 'c1', { email: 'm@wizardtrees.com', now: '2026-10-08T15:00:00Z' });
  ok(cl.ok, cl.error);
  eq([cl.edit.times_status, cl.edit.times_error, cl.edit.cancelled_by, C.editStatus(cl.edit)], ['cancelled', 'Clock-in moved in Gusto.', 'm@wizardtrees.com', 'cancelled'], 'cleared, the reason kept');
  ok(OV(raw, cl.edits) === raw, 'the Needs a look pill is gone');
  ok(C.cancelEdit([att], 'c1', { email: 'boss@wizardtrees.com', is_admin: true }).ok, 'an admin');
  ok(!C.cancelEdit([att], 'c1', { email: 'other@wizardtrees.com' }).ok, 'nobody else');
  const half = ED({ id: 'h1', times_status: 'applied', breaks_status: 'failed', after: AFTER('07:30', '15:30') });
  eq(['times_status', 'breaks_status'].map(k => C.cancelEdit([half], 'h1', { email: 'm@wizardtrees.com' }).edit[k]), ['applied', 'cancelled'], 'what is in Gusto stays In Gusto');
  ok(!C.cancelEdit(cl.edits, 'c1', { email: 'm@wizardtrees.com' }).ok, 'once');
  if (SQL_EDITS) ok(/in \('pending', 'conflict', 'failed'\) then 'cancelled'/.test(SQL_EDITS), 'ts_edit_cancel clears conflict and failed parts too');
  const app = block('ts-app');
  ok(/C\.CANCELLABLE\.includes\(e\.times_status\)/.test(appFn('mayCancel')) && /!e\.cancelled_at/.test(appFn('mayCancel')), 'Cancel or Clear: waiting, conflict or failed parts');
  const eh = appFn('editorHistory');
  ok(/st === 'pending' \|\| clear/.test(eh) && eh.includes("'Gusto is right: clear this'") && eh.includes("'Clear it'"), 'the editor offers Clear on a Needs a look');
  ok(/clear \? 'Clear' : 'Cancel'/.test(appFn('editAdminRow')) && /Cleared\. Gusto keeps what it has\./.test(appFn('adminCancelEdit')) && /Cleared\. Gusto keeps what it has\./.test(appFn('edCancelChange')), 'and Admin > Edits; the toast says so');
});
check('review: a day can be edited only while the next run can still take the change to Gusto; a last-period day says paid days are fixed in Gusto', () => {
  // the old previous period (Sep 26 to Oct 9) drops out when the period of Oct 24 starts
  ok(C.canEditForRun('2026-10-01', C.TZ, '2026-10-24T01:00:00Z'), 'Friday 6 PM Pacific: the 7 PM run is still Friday');
  ok(C.canEditForRun('2026-10-01', C.TZ, '2026-10-24T01:59:59Z'), 'a second before 7 PM Friday');
  ok(!C.canEditForRun('2026-10-01', C.TZ, '2026-10-24T02:00:00Z'), 'Friday 7 PM Pacific: that run has started; the next is Saturday 5 AM, a new period');
  ok(!C.canEditForRun('2026-10-01', C.TZ, '2026-10-24T02:30:00Z'), 'Friday 7:30 PM Pacific: the next run is Saturday 5 AM, a new period');
  ok(C.canEditForRun('2026-10-12', C.TZ, '2026-10-24T02:30:00Z'), 'a day of the current period stays');
  ok(C.canEditForRun('2026-10-01', 'America/New_York', '2026-10-24T01:30:00Z'), 'New York, 9:30 PM Friday: the 10 PM run is Friday');
  ok(!C.canEditForRun('2026-10-01', 'America/New_York', '2026-10-24T02:30:00Z'), 'New York after 10 PM Friday: the next run is 8 AM Saturday');
  // a Friday that ends no pay period (Oct 16, in the period of Oct 10 to 23): after the 7 PM run the previous period stays
  ok(C.canEditForRun('2026-09-28', C.TZ, '2026-10-17T02:30:00Z') && C.canEditForRun('2026-09-28', 'America/New_York', '2026-10-17T02:30:00Z'), 'Fri Oct 16, 7:30 PM Pacific: Sep 28 can still be changed');
  ok(C.canEditForRun('2026-09-26', C.TZ, '2026-10-17T06:59:59Z'), 'up to midnight that Friday');
  // the next period end, Fri Nov 6 (standard time by then): the same 7 PM cut-off, Pacific and New York
  ok(C.canEditForRun('2026-10-12', C.TZ, '2026-11-07T02:59:59Z') && !C.canEditForRun('2026-10-12', C.TZ, '2026-11-07T03:00:00Z'), 'Fri Nov 6: to 6:59:59 PM PST, not from 7 PM');
  ok(C.canEditForRun('2026-10-12', 'America/New_York', '2026-11-07T02:59:59Z') && !C.canEditForRun('2026-10-12', 'America/New_York', '2026-11-07T03:00:00Z'), 'New York: to 9:59:59 PM EST, not from 10 PM');
  ok(!C.canEditForRun('2026-09-20', C.TZ, '2026-10-21T18:00:00Z') && !C.canEditForRun('2026-10-22', C.TZ, '2026-10-21T18:00:00Z'), 'outside the window, a future day');
  eq([C.inLastPeriod('2026-10-05', '2026-10-21'), C.inLastPeriod('2026-10-12', '2026-10-21'), C.inLastPeriod('2026-10-09', '2026-10-09')], [true, false, false]);
  const app = block('ts-app');
  ok(/This pay period closes for changes before the next run \(/.test(appFn('noEditMsg')), 'the button is gone and the reason is said');
  ok(/\$\{periodHint\(raw, tz\)\}/.test(appFn('editorBody')) && /if \(!ps && C\.inLastPeriod\(raw\.work_date, rowToday\(raw\)\)\) return h`<p class="hint">This day is in the last pay period\. If its payroll has already run, Gusto will not take a change: fix it in Gusto instead\.<\/p>`/.test(appFn('periodHint')), 'the editor says it for a last-period day while nothing is known about its pay period');
  ok(/noEditMsg\(raw0\) \+ '\.'/.test(appFn('saveDayEdits')), 'Save refuses with the same words');
});
check('review: Save says nothing goes to Gusto when the server stored nothing waiting (a pending change put back to what Gusto has)', () => {
  const raw = edRow([ED_S1]), me = { email: 'm@wizardtrees.com', is_admin: false };
  const ctx = (id, at) => ({ email: me.email, now: at || '2026-10-07T18:00:00Z', today: '2026-10-07', id });
  const a = C.submitEdit([], raw, { shift_id: 's1', action: 'update', after: AFTER('07:30', '15:30', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']]) }, ctx('p1'));
  const en = C.editorEntries(raw, OV(raw, a.edits), a.edits, me);
  en[0].inT = '07:00';                                   // back to what Gusto has
  const plan = C.editPlan(raw, en, {});
  eq(plan.ops.map(o => [o.type, o.action, o.expect]), [['submit', 'update', ['p1']]], 'still sent: it takes the waiting change back');
  const b = C.submitEdit(a.edits, raw, { shift_id: 's1', action: 'update', after: plan.ops[0].after, expect: plan.ops[0].expect }, ctx('p2', '2026-10-07T18:05:00Z'));
  ok(b.ok, b.error);
  eq([b.edit.times_status, b.edit.breaks_status], ['none', 'none']);
  eq(C.saveMessage([{ op: plan.ops[0], edit: b.edit }], 'at noon today'), 'Saved. The shift is back to what Gusto has, so nothing goes to Gusto.');
  eq(C.saveMessage([{ op: { type: 'submit' }, edit: a.edit }], 'at noon today'), 'Saved. It goes to Gusto at noon today and shows as Pending until then.');
  eq(C.saveMessage([{ op: { type: 'cancel' }, edit: null }], 'at noon today'), 'Saved.', 'a cancel alone');
  eq(C.saveMessage([{ op: { type: 'cancel' } }, { op: { type: 'submit' }, edit: { times_status: 'pending', breaks_status: 'none' } }], 'at 7 PM today'), 'Saved. It goes to Gusto at 7 PM today and shows as Pending until then.', 'an add changed: cancelled and added again');
});
check('review: an update or delete sends p_expect (the waiting changes the editor showed), so another manager\'s newer change is never replaced unseen', () => {
  const raw = edRow([ED_S1, ES('s2', '16:00', '18:00')]);
  const ctx = (id, email, at) => ({ email: email || 'm@wizardtrees.com', now: at || '2026-10-07T18:00:00Z', today: '2026-10-07', id });
  const up = after => ({ shift_id: 's1', action: 'update', after });
  const mine = C.submitEdit([], raw, Object.assign(up(AFTER('07:30', '15:30', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']])), { expect: [] }), ctx('m1'));
  ok(mine.ok, mine.error);
  // a page opened before m1 was saved shows nothing waiting: refused
  const late = C.submitEdit(mine.edits, raw, Object.assign(up(AFTER('07:45', '15:30')), { expect: [] }), ctx('t1', 'other@wizardtrees.com', '2026-10-07T18:01:00Z'));
  ok(!late.ok && /Someone changed this shift since you opened it/.test(late.error), late.error);
  ok(C.submitEdit(mine.edits, raw, Object.assign(up(AFTER('07:45', '15:30')), { expect: ['m1'] }), ctx('t2', 'other@wizardtrees.com')).ok, 'shown: it may replace it');
  const gone = C.cancelEdit(mine.edits, 'm1', { email: 'm@wizardtrees.com', now: '2026-10-07T18:02:00Z' }).edits;
  ok(/Someone changed this shift/.test(C.submitEdit(gone, raw, Object.assign(up(AFTER('07:45', '15:30')), { expect: ['m1'] }), ctx('t3')).error || ''), 'one it showed was cancelled since');
  ok(C.submitEdit(mine.edits, raw, up(AFTER('07:45', '15:30')), ctx('t4')).ok, 'no expect: no check (as p_expect null)');
  const en = C.editorEntries(raw, OV(raw, mine.edits), mine.edits, { email: 'm@wizardtrees.com', is_admin: false });
  en[0].outT = '15:45'; en[1].del = true;
  eq(C.editPlan(raw, en, {}).ops.map(o => [o.action, o.expect]), [['update', ['m1']], ['delete', []]], 'the editor sends what it showed');
  if (SQL_EDITS) ok(/p_expect jsonb default null/.test(SQL_EDITS) && /Someone changed this shift since you opened it/.test(SQL_EDITS), 'ts_edit_submit takes p_expect');
});
check('review: managers are offered only the kinds of change the worker has sent with a person watching (adding, deleting and New York wait for a supervised run)', () => {
  const app = block('ts-app');
  ok(/const EDIT_PROVEN = \{ add: true, delete: true, ny: true,[^}]*midnight: false, midnightEnd: false,[^}]*note: false, nyNote: false \};/.test(app), 'adding and deleting shifts and New York days proven 2026-10-22/23; the two midnight fixes not yet (review 2026-10-25), nor notes in either region (2026-10-29)');
  ok(/function mayEdit\(what\) \{ const a = actor\(\); return !!\(a && a\.is_admin\) \|\| C\.fullViewer\(a\) \|\| !!EDIT_PROVEN\[what\]; \}/.test(app), 'admins and full viewers keep them all');
  const fv = { is_admin: false, active: true, grants: [{ company: '*', department: '*' }] }, mgr = { is_admin: false, active: true, grants: [{ company: 'filifera', department: 'Trim' }] };
  ok(C.fullViewer(fv) && !C.fullViewer(mgr), 'a full viewer (every CA company) gets add and delete; a department manager does not');
  ok(/rowRegion\(r\) !== 'NY' \|\| mayEdit\('ny'\)/.test(app.match(/function canEditRow\(r\) \{[^\n]*\}/)[0]), 'no Edit on a New York day for a manager');
  ok(/New York days cannot be changed here yet: change this day in Gusto/.test(appFn('noEditMsg')), 'and why');
  ok(/\$\{mayEdit\('add'\) \? h`<div class="ed-more"><button type="button" class="btn sm" data-act="ed-add-shift"/.test(appFn('editorBody')), '+ Add a shift');
  const eh = appFn('entryHtml');
  ok(/const canDel = en\.kind !== 'shift' \|\| mayEdit\('delete'\);/.test(eh) && /\$\{canDel \? h`<button type="button" class="linkbtn danger" data-act="ed-del"/.test(eh), 'Delete this shift (a waiting add can still be taken back)');
});
check('review: the hint names the phone button, and a Pending pill reads Late once its run passed', () => {
  ok(/<b id="edHintHow">Edit<\/b>/.test(markup) && /phoneLike\(\) \? 'Edit times or breaks \(open a day\)' : 'Edit'/.test(appFn('renderEdHint')), 'on a phone: Edit times or breaks, inside a day');
  const late = demo.edits.filter(e => C.editLate(e, NOW));
  ok(late.length >= 1 && late.every(e => C.editStatus(e) === 'pending'), 'the demo has a late one');
  ok(/ed\.pending\.every\(e => C\.editLate\(e, now\)\) \? 'Late' : 'Pending'/.test(appFn('editPills')), 'the pill says Late when every waiting change on the day is late');
});

// ---------------------------------------------------------------------------------------------
// 16. nothing Gusto refuses for overlap (Gianni 2026-10-24: "can we make sure the app doesn't suggest break times that
//     would overlap and get denied by gusto?", after a change reached Gusto with a meal inside a rest that was never
//     ended). Synthetic rows only.
// ---------------------------------------------------------------------------------------------
check('overlap errors say what is in the way and sit on the break at fault; seconds show when only seconds are at fault', () => {
  const v = a => C.validateAfter(a, { tz: C.TZ, date: '2026-10-06' });
  eq(v(AFTER('07:00', '15:30', [['09:00', '09:30', 'meal'], ['09:20', '09:35', 'rest']])).map(e => [e.code, e.brk, e.msg]), [['brk_overlap', 1, "Overlaps the 9:00 AM meal. Breaks can't overlap."]]);
  // a rest Gusto ended at 10:17:20 shows as 10:17 here: a meal typed at 10:17 overlaps it by seconds, and the message says so
  const kept = { in: EP('07:00'), out: EP('15:30'), breaks: [{ start: '2026-10-06T10:04:10-07:00', end: '2026-10-06T10:17:20-07:00', kind: 'rest' }, { start: EP('10:17'), end: EP('10:47'), kind: 'meal' }] };
  eq(v(kept).map(e => [e.brk, e.msg]), [[1, "Overlaps the 10:04 AM rest (it ends at 10:17:20 AM). Breaks can't overlap."]]);
  kept.breaks[1] = { start: EP('10:18'), end: EP('10:48'), kind: 'meal' };
  eq(v(kept), [], 'a minute later is fine');
  // a start Gusto keeps to the second: a break in that same minute is outside the shift, and the message shows the seconds
  eq(v({ in: '2026-10-06T08:03:05-07:00', out: EP('15:30'), breaks: [{ start: EP('08:03'), end: EP('08:13'), kind: 'rest' }] }).map(e => e.msg), ['Breaks must be inside the shift (8:03:05 AM to 3:30 PM).']);
  eq(v(AFTER('07:00', '15:30', [['06:00', '06:10', 'rest']])).map(e => e.msg), ['Breaks must be inside the shift (7:00 AM to 3:30 PM).'], 'no seconds when they do not matter');
  eq(C.fmtTimeSec('2026-10-06T10:17:20-07:00', C.TZ), '10:17:20 AM'); eq(C.fmtTimeSec(EP('10:17'), C.TZ), '10:17 AM');
  // the page: a break's error under that break, a shift's under the shift, the cursor on the field at fault
  const sv = appFn('saveDayEdits'), eh = appFn('entryHtml'), bm = appFn('brkMsgHtml');
  ok(/en\.err = es\.filter\(x => x\.brk == null\)/.test(sv) && /if \(x\.brk != null\) en\.brkErr\[x\.brk\]/.test(sv), 'errors split by break');
  ok(/\$\{brkMsgHtml\(en, j, notes\[j\]\)\}\n\s+<\/div>`\)/.test(eh) && /<p class="ed-bmsg err" role="alert">\$\{e\}<\/p>/.test(bm), 'shown inside that break\'s row');
  ok(/en\.brkErr = null/.test(appFn('edInsertBreak')) && /en\.brkErr = null/.test(appFn('edRmBreak')), 'a break added or removed clears the old ones (the rows moved)');
  ok(/shift_overlap\|shift_overlap_day\|shift_swap\|split_shift\)\$\/\.test\(er\.code\) \? 'in'/.test(sv), 'an overlap puts the cursor on the start');
  ok(/\.ed-bmsg\{flex-basis:100%;grid-column:1\/-1;/.test(src), 'a full-width line in the row, also in the phone grid');
});
check('a changed shift may not run into another shift: the same day (one still clocked in runs on), or the day before or after around midnight', () => {
  const me = { email: 'm@wizardtrees.com', is_admin: true }, at = { today: '2026-10-21', now: Date.parse('2026-10-21T18:00:00Z') };
  const raw = edRow([ES('s1', '07:00', '11:00'), ES('s2', '13:00', null)]);   // s2: a clock-out forgotten on a past day
  const en = C.editorEntries(raw, raw, [], me, at);
  en.push(Object.assign(C.newEntry('n1'), { inT: '14:00', outT: '15:00' }));
  eq(C.editPlan(raw, en, {}).errors.n1.map(e => [e.code, e.msg]), [['shift_overlap', 'This shift overlaps the shift from 1:00 PM, still clocked in.']]);
  en[2].inT = '11:30'; en[2].outT = '12:30';
  eq(C.editPlan(raw, en, {}).errors, {}, 'before it is fine');
  en[2].inT = '10:30';
  eq(C.editPlan(raw, en, {}).errors.n1.map(e => e.msg), ['This shift overlaps the 7:00 AM to 11:00 AM shift.']);
  // the day before: a night shift to 6:00 AM, and this day's start moved earlier into it
  const day = edRow([ES('s1', '07:00', '15:30')]);
  const de = C.editorEntries(day, day, [], me, at);
  const prev = [{ in: '2026-10-05T22:00:00-07:00', out: EP('06:00'), date: '2026-10-05' }];
  de[0].inT = '05:00';
  eq(C.editPlan(day, de, { neighbors: prev }).errors[de[0].key].map(e => [e.code, e.msg]), [['shift_overlap_day', 'This shift overlaps the 10:00 PM to 6:00 AM shift on Mon, Oct 5.']]);
  eq(C.editPlan(day, de, {}).errors, {}, 'without the day before on the page, nothing to check');
  de[0].inT = '06:00';
  eq(C.editPlan(day, de, { neighbors: prev }).errors, {}, 'starting as it ends is fine');
  // the day after: this shift now runs past midnight into an early shift
  de[0].inT = '16:00'; de[0].outT = '02:00';
  const next = [{ in: '2026-10-07T01:00:00-07:00', out: '2026-10-07T09:00:00-07:00', date: '2026-10-07' }];
  eq(C.editPlan(day, de, { neighbors: next }).errors[de[0].key].map(e => e.code), ['shift_overlap_day']);
  // an untouched shift is never blamed, and a shift with its own error is fixed first (it does not blame others)
  eq(C.editPlan(day, C.editorEntries(day, day, [], me, at), { neighbors: [{ in: EP('06:00'), out: EP('08:00'), date: '2026-10-05' }] }).errors, {});
  // the page passes the person's shifts of the day before and after, as the board shows them (closed ones: an open
  // shift's end is not known)
  const nf = appFn('neighborShifts');
  ok(/C\.addDays\(raw\.work_date, -1\), C\.addDays\(raw\.work_date, 1\)/.test(nf) && /r\.company !== raw\.company \|\| r\.employee_uuid !== raw\.employee_uuid/.test(nf)
    && /boardRow\(r\)\.shifts/.test(nf) && /!s\.hours_only && s\.in && s\.out/.test(nf), 'the same person, the board\'s shifts, closed ones');
});
check('a rest over 30 minutes gets a warning under it (was it ever ended, or is it a meal?), never a block; typing keeps it current', () => {
  const lr = (s, e, k) => C.longRestText({ start: EP(s), end: EP(e), kind: k || 'rest' });
  eq([lr('10:04', '12:15'), lr('10:00', '10:45'), lr('10:00', '12:00'), lr('10:00', '10:30'), lr('12:00', '13:00', 'meal')],
    ['This rest runs 2 h 11 min: was it ever ended, or is it a meal?', 'This rest runs 45 min: was it ever ended, or is it a meal?', 'This rest runs 2 h: was it ever ended, or is it a meal?', '', '']);
  const raw = edRow([ES('s1', '08:03', '12:37', [EB('10:04', '12:15', 'rest')])]);
  const en = bkEntries(raw);
  eq(C.entryBreakNotes(en[0], raw.work_date, C.TZ), ['This rest runs 2 h 11 min: was it ever ended, or is it a meal?']);
  en[0].outT = '17:37';
  eq(C.editPlan(raw, en, {}).errors, {}, 'a warning, not an error: it still saves');
  en[0].breaks[0].endT = '10:17';
  eq(C.entryBreakNotes(en[0], raw.work_date, C.TZ), [''], 'gone once it is shortened');
  const bm = appFn('brkMsgHtml'), oi = appFn('onEditorInput');
  ok(/<p class="ed-bmsg warn" data-bw="\$\{en\.key \+ ':' \+ j\}"\$\{note \? '' : ' hidden'\}>/.test(bm), 'under its break, hidden when there is nothing to say');
  ok(/C\.entryBreakNotes\(en, raw\.work_date, tz\)\.forEach/.test(oi) && /el\.textContent = note; el\.hidden = !note;/.test(oi), 'updated as times are typed, without a re-render');
});
check('+ Add break and Add missing breaks keep clear of where Gusto still has a long rest, even once it is shortened here (the case of 2026-10-23)', () => {
  // Gusto: 8:03 AM to 12:37 PM with a rest from 10:04 AM that ran to 12:15 PM. The manager fixes the end (5:37 PM) and the rest (to 10:17 AM).
  const raw = edRow([ES('s1', '08:03', '12:37', [EB('10:04', '12:15', 'rest')])]);
  const fix = () => { const e = bkEntries(raw); e[0].outT = '17:37'; e[0].breaks[0].endT = '10:17'; return e; };
  eq(fix()[0].held, [[Date.parse(EP('10:04')) / 60000, Date.parse(EP('12:15')) / 60000]], 'held: where Gusto has the long rest (epoch minutes)');
  const day = fix(), adds = applyAdds(day, bkCtx(raw));
  // a minute clear of where the rest ends in Gusto (12:15), on a 5-minute mark: not edge to edge (review 2026-10-24)
  eq(adds.map(a => [a.brk.startT, a.brk.endT, a.brk.kind]), [['12:20', '12:50', 'meal'], ['15:05', '15:20', 'rest']], 'the meal after the rest as Gusto has it, not at noon');
  eq(C.editorBreakStatus(day, bkCtx(raw)).state, 'ok', 'and the day reads complete');
  eq(codes(C.validateAfter(C.entryAfter(day[0], raw.work_date, C.TZ), { tz: C.TZ, date: raw.work_date })), []);
  eq(sug(fix(), null, bkCtx(raw)), ['12:20', '12:50', 'meal'], '+ Add break the same way');
  // removed here: still clear of it
  const gone = bkEntries(raw); gone[0].outT = '17:37'; gone[0].breaks = [];
  const g = sug(gone, null, bkCtx(raw));
  ok(g[2] === 'meal' && (C.parseHhmm(g[1]) <= 10 * 60 + 4 || C.parseHhmm(g[0]) >= 12 * 60 + 15), J(g));
  // left as it is: busy like any break
  const left = bkEntries(raw); left[0].outT = '17:37';
  const l = sug(left, null, bkCtx(raw));
  ok(C.parseHhmm(l[1]) <= 10 * 60 + 4 || C.parseHhmm(l[0]) >= 12 * 60 + 15, J(l));
  // a long rest over the whole usual meal window: no spot clear of it there, so the meal goes where it always would (the
  // browser task then saves the change in a safe order: the rest first, the meal after)
  const wide = edRow([ES('s1', '08:00', '17:00', [EB('09:00', '13:30', 'rest')])]);
  const w = bkEntries(wide); w[0].breaks[0].endT = '09:15';
  const plain = bkEntries(edRow([ES('s1', '08:00', '17:00', [EB('09:00', '09:15', 'rest')])]));
  eq(sug(w, null, bkCtx(wide)), sug(plain, null, bkCtx(wide)), 'as with no long rest');
  // made-up days with a long rest from Gusto, shortened here: whatever is added is valid and never overlaps
  for (let i = 0; i < 200; i++) {
    const st = 360 + bkRnd(240), len = 300 + bkRnd(360), rs = st + 30 + bkRnd(120), rl = 31 + bkRnd(150);
    if (rs + rl > st + len) continue;
    const r = edRow([ES('s1', hm(st), hm(st + len), [EB(hm(rs), hm(rs + rl), 'rest')])]);
    const d = bkEntries(r); d[0].breaks[0].endT = hm(rs + 5 + bkRnd(10));
    applyAdds(d, bkCtx(r));
    eq(codes(C.validateAfter(C.entryAfter(d[0], r.work_date, C.TZ), { tz: C.TZ, date: r.work_date })), [], 'made-up day ' + i + ' ' + J([d[0].inT, d[0].outT, d[0].breaks.map(b => [b.startT, b.endT, b.kind])]));
  }
});

// review 2026-10-24 (editor): every break Gusto has now steers the suggestions, from Gusto's own shift; the page orders
// changes across shifts the way Gusto can take them; messages show the seconds at fault and sit on the break typed here.
const mins = t => Date.parse(EP(t)) / 60000;
const clearOf = (b, from, to) => C.parseHhmm(b[1]) < C.parseHhmm(from) || C.parseHhmm(b[0]) > C.parseHhmm(to);   // a minute or more clear
check('suggestions keep clear of every break Gusto has now: moved, removed, never ended, or changed by a change still waiting', () => {
  // (a) a rest moved away in the editor: its old place stays held until the change goes in
  const ra = edRow([ES('s1', '07:00', '15:30', [EB('11:00', '11:10', 'rest')])]);
  const a = bkEntries(ra);
  eq(a[0].held, [[mins('11:00'), mins('11:10')]], 'held: every break Gusto has, not only long rests');
  a[0].breaks[0].startT = '14:00'; a[0].breaks[0].endT = '14:10';
  const sa = sug(a, null, bkCtx(ra));
  ok(sa[2] === 'meal' && clearOf(sa, '11:00', '11:10'), 'moved: ' + J(sa));
  // (b) a rest removed in the editor: Add missing breaks keeps clear of where it was
  const rb = edRow([ES('s1', '07:00', '15:30', [EB('10:50', '11:20', 'rest')])]);
  const b = bkEntries(rb); b[0].breaks = [];
  const ab = applyAdds(b, bkCtx(rb));
  ok(ab.length && ab.every(x => clearOf([x.brk.startT, x.brk.endT], '10:50', '11:20')), 'removed: ' + J(ab.map(x => [x.brk.startT, x.brk.endT])));
  // (c) a rest Gusto never ended: it runs on in Gusto until the change goes in, so the meal goes before it when it can
  const rc = edRow([ES('s1', '08:03', '17:37', [EB('10:04', null, 'rest')])]);
  const cc = bkEntries(rc);
  eq(cc[0].held, [[mins('10:04'), Infinity]].map(x => x.map(v => v === Infinity ? null : v)), 'open: runs on (Infinity)');
  cc[0].breaks[0].endT = '10:15';
  const sc = sug(cc, null, bkCtx(rc));
  ok(sc[2] === 'meal' && C.parseHhmm(sc[1]) < C.parseHhmm('10:04'), 'never ended: ' + J(sc));
  eq(codes(C.validateAfter(C.entryAfter(Object.assign({}, cc[0], { breaks: cc[0].breaks.concat([{ startT: sc[0], endT: sc[1], kind: sc[2], orig: null }]) }), rc.work_date, C.TZ), { tz: C.TZ, date: rc.work_date })), []);
  // (d) a change still waiting shortened the long rest: the board shows 10:17, but Gusto has 10:04 to 12:15 until the run
  const rd = edRow([ES('s1', '08:03', '12:37', [EB('10:04', '12:15', 'rest')])]);
  const w = ED({ id: 'w1', shift_id: 's1', before: C.shiftSnap(rd.shifts[0]), after: { in: EP('08:03'), out: EP('17:37'), breaks: [{ start: EP('10:04'), end: EP('10:17'), kind: 'rest' }] },
    times_status: 'pending', breaks_status: 'pending', created_at: '2026-10-21T15:00:00Z' });
  const d = C.editorEntries(rd, OV(rd, [w], '2026-10-21'), [w], BK_ME, { today: '2026-10-21', now: BK_NOW });
  eq([d[0].breaks[0].endT, d[0].outT], ['10:17', '17:37'], 'the editor shows the waiting change');
  eq(d[0].held, [[mins('10:04'), mins('12:15')]], 'held from Gusto\'s shift, not the board\'s');
  const ad = applyAdds(d, bkCtx(rd));
  ok(ad.length && ad.every(x => clearOf([x.brk.startT, x.brk.endT], '10:04', '12:15')), 'waiting: ' + J(ad.map(x => [x.brk.startT, x.brk.endT])));
  // a shift Gusto does not have yet holds nothing
  eq(C.entryOf({ in: EP('07:00'), out: EP('15:00'), breaks: [EB('10:00', '10:10', 'rest')] }, C.TZ, null).held, []);
  // the page builds entries this way
  const ee = (src.match(/function editorEntries\([\s\S]*?\n  \}/) || [''])[0];
  ok(/entryOf\(b \|\| s, tz, s\)/.test(ee) && /entryOf\(s, tz, null\)/.test(ee), 'held from the raw Gusto shift; none for a waiting add');
});
check('Save orders changes across shifts the way Gusto can take them: one moving out of the way first; two trading times are refused', () => {
  const me = { email: 'm@wizardtrees.com', is_admin: true }, at = { today: '2026-10-21', now: Date.parse('2026-10-21T18:00:00Z') };
  const raw = edRow([ES('s1', '07:00', '11:00'), ES('s2', '11:30', '15:00')]);
  const en = C.editorEntries(raw, raw, [], me, at);
  en[0].outT = '12:00'; en[1].inT = '12:30'; en[1].outT = '16:00';
  const p = C.editPlan(raw, en, {});
  eq(p.errors, {});
  eq(p.ops.map(o => [o.shift_id, o.wait || null]), [['s2', null], ['s1', [en[1].key]]], 's2 leaves 11:30 first; s1 waits on it');
  // nothing in the way: the order the editor shows
  const e2 = C.editorEntries(raw, raw, [], me, at); e2[0].outT = '10:30'; e2[1].outT = '16:00';
  eq(C.editPlan(raw, e2, {}).ops.map(o => [o.shift_id, o.wait || null]), [['s1', null], ['s2', null]]);
  // a delete makes room for a shift moving into its time: the delete first
  const e3 = C.editorEntries(raw, raw, [], me, at); e3[0].del = true; e3[1].inT = '08:00';
  eq(C.editPlan(raw, e3, {}).ops.map(o => [o.action, o.shift_id]), [['delete', 's1'], ['update', 's2']]);
  // each into the other's time: no order works
  const sw = edRow([ES('s1', '07:00', '09:00'), ES('s2', '10:00', '12:00')]);
  const e4 = C.editorEntries(sw, sw, [], me, at);
  e4[0].inT = '10:00'; e4[0].outT = '12:00'; e4[1].inT = '07:00'; e4[1].outT = '09:00';
  const p4 = C.editPlan(sw, e4, {});
  eq(p4.ops, []);
  eq(p4.errors[e4[0].key].map(e => [e.code, e.msg]), [['shift_swap', "This shift moves into the time the 10:00 AM to 12:00 PM shift has in Gusto now, and that shift moves into this one's. Gusto takes one change at a time, so save one of them now and the other after the next run."]]);
  // the page: a change that waits on one that did not save does not go either
  const sv = appFn('saveDayEdits');
  ok(/if \(\(op\.wait \|\| \[\]\)\.some\(w => failed\.has\(w\)\)\) \{ failed\.add\(op\.key\);/.test(sv), 'skipped when what it waits on failed');
});
check('a shift Gusto split at midnight (2026-10-25): its first day\'s part takes a real end (both days at once), the 12:00 AM part is carried over, and "End it at 11:59 PM" asks for exactly that', () => {
  const me = { email: 'm@wizardtrees.com', is_admin: true }, at = { today: '2026-10-21', now: Date.parse('2026-10-21T18:00:00Z'), midnight: { fix: true, end: true } };
  const first = { id: 's9', in: '2026-10-06T17:50:00-07:00', out: '2026-10-06T23:59:59-07:00', span_min: 370, worked_min: 370, hours_only: false, breaks: [] };
  // the producer flagged it as a forgotten clock-out (midnight_split): the only kind the editor offers to fix
  const MF = k => ({ code: 'midnight_split', sev: 'warn', msg: C.MIDNIGHT_MSG[k] });
  const day = edRow([first], { flags: [MF('start')] });
  const nb = [{ id: 's9', in: '2026-10-07T00:00:00-07:00', out: '2026-10-07T08:06:00-07:00', date: '2026-10-07', breaks: [] }];
  const fresh = (n) => C.editorEntries(day, day, [], me, Object.assign({ neighbors: n || nb }, at));
  const de = fresh();
  eq([de[0].readonly || null, de[0].split.role, de[0].split.date, de[0].split.breaks, de[0].split.fix], [null, 'first', '2026-10-07', 0, true], 'the first day\'s part is editable and knows its other part');
  // a real end before midnight: one update of the shift, nothing refused
  de[0].outT = '22:30';
  const p = C.editPlan(day, de, {});
  eq(p.errors, {});
  eq(p.ops.map(o => [o.action, o.shift_id, o.after.in, o.after.out]), [['update', 's9', '2026-10-06T17:50:00-07:00', '2026-10-06T22:30:00-07:00']]);
  // the end left at 11:59 PM with another change: it asks for the real end
  const d2 = fresh(); d2[0].inT = '17:30';
  eq(C.editPlan(day, d2, {}).errors[d2[0].key].map(e => [e.code, e.msg]), [['split_end', 'Gusto ran this shift past midnight (it goes on as 12:00 AM to 8:06 AM on Wed, Oct 7, likely a missed clock-out). Give its real end time here: both days are fixed at once, and your other changes go with it.']]);
  // an end after midnight
  const d3 = fresh(); d3[0].outT = '01:00';
  eq(C.editPlan(day, d3, {}).errors[d3[0].key].map(e => [e.code, e.msg]), [['split_end', 'This shift ran past midnight in Gusto: end it before midnight on Tue, Oct 6 here (that fixes both days at once). To end it after midnight, change it in Gusto.']]);
  // breaks after midnight would be left outside it
  const d4 = fresh([Object.assign({}, nb[0], { breaks: [{ start: '2026-10-07T02:00:00-07:00', end: '2026-10-07T02:15:00-07:00' }] })]); d4[0].outT = '22:30';
  eq(C.editPlan(day, d4, {}).errors[d4[0].key].map(e => e.code), ['split_breaks']);
  // deleting it would take both days
  const d5 = fresh(); d5[0].del = true;
  eq(C.editPlan(day, d5, {}).errors[d5[0].key].map(e => e.msg), ['Gusto ran this shift past midnight under one id, so deleting it would also take 12:00 AM to 8:06 AM on Wed, Oct 7. To fix a missed clock-out, give it its real end time instead (both days are fixed at once); to remove the whole shift, delete it in Gusto.']);
  eq(C.editPlan(day, fresh(), {}).errors, {}, 'left alone: nothing to say');
  // another shift id after midnight, or a part that does not end at 11:59:59 PM: an ordinary shift
  eq(fresh([Object.assign({}, nb[0], { id: 's10' })])[0].split, undefined);
  eq(C.splitRole(Object.assign({}, first, { out: '2026-10-06T23:59:00-07:00' }), '2026-10-06', nb, C.TZ, 'tz'), null);
  // a person punching in Eastern time is split at ET midnight: read on the punch's own clock
  eq(C.splitRole({ id: 'f1', in: '2026-10-06T15:00:00-04:00', out: '2026-10-06T23:59:59-04:00' }, '2026-10-06',
    [{ id: 'f1', in: '2026-10-07T00:00:00-04:00', out: '2026-10-07T02:00:00-04:00', date: '2026-10-07' }], C.TZ, 'tz').role, 'first');
  // the 12:00 AM part: carried over, read-only here; "End it at 11:59 PM" is a delete of it with the worker's reason
  const carried = { id: 's9', in: '2026-10-07T00:00:00-07:00', out: '2026-10-07T08:06:00-07:00', span_min: 486, worked_min: 486, hours_only: false, breaks: [] };
  const cday = edRow([carried], { id: 'filifera:e1:2026-10-07', work_date: '2026-10-07', flags: [MF('cont')] });
  const prev = [{ id: 's9', in: first.in, out: first.out, date: '2026-10-06', breaks: [] }];
  const ce = C.editorEntries(cday, cday, [], me, Object.assign({ neighbors: prev }, at));
  eq([ce[0].readonly, ce[0].split.role, ce[0].split.date], ['carried', 'carried', '2026-10-06']);
  ce[0].outT = '01:00';
  eq(C.editPlan(cday, ce, {}), { ops: [], errors: {} }, 'nothing typed on it is sent');
  const ce2 = C.editorEntries(cday, cday, [], me, Object.assign({ neighbors: prev }, at)); ce2[0].endAtMidnight = true; ce2[0].del = true;
  eq(C.editPlan(cday, ce2, {}).ops.map(o => [o.type, o.action, o.shift_id, o.after, o.note]), [['submit', 'delete', 's9', null, 'End the shift at 11:59 PM']]);
  eq(C.entriesPreview(ce2, cday.work_date, C.TZ).worked, 0, 'the preview drops the part that goes');
  // the worker reads the same words (ts-edit-plan.mjs END_AT_MIDNIGHT_NOTE), checked on the Mac that has it
  const planFile = path.join(os.homedir(), 'gusto-sync', 'ts-edit-plan.mjs');
  if (fs.existsSync(planFile)) ok(fs.readFileSync(planFile, 'utf8').includes("export const END_AT_MIDNIGHT_NOTE = '" + C.END_AT_MIDNIGHT_NOTE + "';"), 'the worker\'s reason is the page\'s');
  // the page: Gusto's own shifts around the day (still clocked in ones and breaks included), the days read when the editor
  // opened; Save sends the op's own reason first; the carried part's buttons
  const nf = appFn('neighborShifts'), nd = appFn('neighborDays'), oe = appFn('openEditor'), rn = appFn('rawNeighbors');
  ok(/id: s\.id != null \? String\(s\.id\) : null/.test(nf) && /E\.nbRows/.test(nf), 'neighbors carry the shift id, and the days read when the editor opened');
  ok(/for \(const s of r\.shifts \|\| \[\]\) if \(s && !s\.hours_only && s\.in\) out\.push\(\{ id: s\.id != null \? String\(s\.id\) : null, in: s\.in, out: s\.out \|\| null, date: d, breaks: s\.breaks \|\| \[\] \}\)/.test(rn) && /E\.nbRows/.test(rn),
    'the split check reads Gusto\'s own shifts around the day');
  ok(/!\(S\.fetched \|\| \[\]\)\.some\(f => f\.from <= d && d <= f\.to\)/.test(nd) && /\.eq\('company', raw\.company\)\.eq\('employee_uuid', raw\.employee_uuid\)\.in\('work_date', want\)/.test(nd)
    && /catch \(e\) \{ console\.warn\('days around this one not read', e\); return \[\]; \}/.test(nd), 'only days not loaded; a failed read is no neighbors');
  ok(/E\.nbRows = nb;/.test(oe), 'kept for Save');
  ok(/runEditOp\(raw, op, op\.note \? C\.cutUnits\(op\.note \+ \(note \? ': ' \+ note : ''\), C\.EDIT_RULES\.noteMax\) : note\)/.test(appFn('saveDayEdits')), 'the op\'s own reason goes first');
  ok(/case 'ed-end-midnight': edEndMidnight\(d\.ek, true\); break;/.test(src) && /case 'ed-end-midnight-undo': edEndMidnight\(d\.ek, false\); break;/.test(src)
    && /case 'ed-open-day': edOpenDay\(d\.k\); break;/.test(src), 'the carried part\'s buttons are wired');
  ok(/if \(en\.readonly === 'carried'\) return carriedHtml\(en, label, pend, times\);/.test(appFn('entryHtml')) && /const canEnd = !!en\.split\.end && /.test(appFn('carriedHtml')), 'carried over parts say where to fix them; ending at 11:59 PM only where the core allowed it');
  ok(/en\.endAtMidnight/.test(appFn('editorDirty')), 'choosing 11:59 PM counts as a change on Cancel');
});
check('review 2026-10-25: a split shift is offered for a fix only when it is a forgotten clock-out in one pay period, to a sign-in the worker will serve', () => {
  const me = { email: 'm@wizardtrees.com', is_admin: false }, base = { today: '2026-10-21', now: Date.parse('2026-10-21T18:00:00Z') };
  const MF = k => ({ code: 'midnight_split', sev: 'warn', msg: C.MIDNIGHT_MSG[k] });
  const first = { id: 's9', in: '2026-10-06T17:50:00-07:00', out: '2026-10-06T23:59:59-07:00', span_min: 370, worked_min: 370, hours_only: false, breaks: [] };
  const nb = [{ id: 's9', in: '2026-10-07T00:00:00-07:00', out: '2026-10-07T08:06:00-07:00', date: '2026-10-07', breaks: [] }];
  const ent = (row, n, mid) => C.editorEntries(row, row, [], me, Object.assign({ neighbors: n || nb, midnight: mid }, base));
  // (F10) a forgotten clock-out, but the worker still holds 'midnight-split': a manager is told to fix it in Gusto, as before
  const flagged = edRow([first], { flags: [MF('start')] });
  const held = ent(flagged, null, { fix: false, end: false });
  eq([held[0].readonly, held[0].split.fix], ['split', false]);
  eq(C.splitWhy(held[0], C.TZ), 'Gusto ran this shift past midnight: it goes on as 12:00 AM to 8:06 AM on Wed, Oct 7 (likely a missed clock-out). Fix its end time in Gusto.');
  held[0].outT = '22:30';
  eq(C.editPlan(flagged, held, {}).ops, [], 'nothing typed on a read-only part is sent');
  delete held[0].readonly;   // ... and Save refuses it even if it got past the read-only view
  eq(C.editPlan(flagged, held, {}).errors[held[0].key].map(e => e.code), ['split_shift']);
  // (F12) real overnight work (no midnight_split flag): never offered as a missed clock-out, whoever is signed in
  const night = edRow([Object.assign({}, first, { in: '2026-10-06T20:54:00-07:00' })]);
  const nn = ent(night, [Object.assign({}, nb[0], { out: '2026-10-07T00:26:17-07:00' })], { fix: true, end: true });
  eq([nn[0].readonly, nn[0].split.forgotten, nn[0].split.fix], ['split', false, false]);
  eq(C.splitWhy(nn[0], C.TZ), 'This shift ran past midnight: Gusto keeps it on two days under one id (it goes on as 12:00 AM to 12:26 AM on Wed, Oct 7). Change it in Gusto.');
  ok(!/missed clock-out/.test(C.splitWhy(nn[0], C.TZ)), 'no "missed clock-out" for real overnight work');
  const nc = C.editorEntries(edRow([Object.assign({}, nb[0], { span_min: 26, worked_min: 26 })], { id: 'filifera:e1:2026-10-07', work_date: '2026-10-07' }), null, [], me,
    Object.assign({ neighbors: [{ id: 's9', in: first.in, out: first.out, date: '2026-10-06', breaks: [] }], midnight: { fix: true, end: true } }, base));
  eq([nc[0].readonly, nc[0].split.end], ['carried', false], 'its 12:00 AM part gets no "End it at 11:59 PM"');
  nc[0].endAtMidnight = true; nc[0].del = true;
  eq(C.editPlan(edRow([nb[0]], { id: 'filifera:e1:2026-10-07', work_date: '2026-10-07' }), nc, {}).ops, [], 'and Save sends nothing for it');
  // the two parts in different pay periods (Fri Oct 9 into Sat Oct 10): the browser task cannot see both
  const fri = edRow([Object.assign({}, first, { in: '2026-10-09T17:50:00-07:00', out: '2026-10-09T23:59:59-07:00' })], { id: 'filifera:e1:2026-10-09', work_date: '2026-10-09', flags: [MF('start')] });
  const fe = ent(fri, [{ id: 's9', in: '2026-10-10T00:00:00-07:00', out: '2026-10-10T08:06:00-07:00', date: '2026-10-10', breaks: [] }], { fix: true, end: true });
  eq([fe[0].readonly, fe[0].split.samePeriod, fe[0].split.fix], ['split', false, false]);
  ok(/is in another pay period\. Fix its end time in Gusto\.$/.test(C.splitWhy(fe[0], C.TZ)), C.splitWhy(fe[0], C.TZ));
  // (F12) a chain over three days: the middle part, and a first part whose next part runs past another midnight
  const mid = { id: 's9', in: '2026-10-07T00:00:00-07:00', out: '2026-10-07T23:59:59-07:00', date: '2026-10-07', breaks: [] };
  eq(C.splitRole(Object.assign({}, mid), '2026-10-07', [{ id: 's9', in: first.in, out: first.out, date: '2026-10-06' }, { id: 's9', in: '2026-10-08T00:00:00-07:00', out: '2026-10-08T03:00:00-07:00', date: '2026-10-08' }], C.TZ, 'tz').role, 'long');
  eq(C.splitRole(first, '2026-10-06', [mid], C.TZ, 'tz').role, 'long');
  eq(C.splitRole({ id: 's9', in: '2026-10-08T00:00:00-07:00', out: '2026-10-08T03:00:00-07:00' }, '2026-10-08', [Object.assign({}, mid, { date: '2026-10-07' })], C.TZ, 'tz').role, 'long');
  const le = ent(flagged, [mid], { fix: true, end: true });
  eq([le[0].readonly, le[0].split.fix], ['split', false]);
  eq(C.splitWhy(le[0], C.TZ), 'Gusto keeps this shift on more than two days under one id (it ran past midnight more than once). Change it in Gusto.');
  // the page: the switches, what each sign-in may send, and the carried part's words (no "fix it on the day before" when that
  // day is not offered for a fix)
  const app = block('ts-app');
  ok(/midnight: \{ fix: mayEdit\('midnight'\), end: mayEdit\('midnightEnd'\) \}/.test(appFn('openEditor')), 'the editor knows what this sign-in may send');
  const ch = appFn('carriedHtml');
  ok(/const canOpen = en\.split\.forgotten && en\.split\.samePeriod && mayEdit\('midnight'\) && S\.rows\.has\(prevKey\) && canEditRow\(S\.rows\.get\(prevKey\)\);/.test(ch), 'Open <day before> only where that day can take the fix');
  const ct = appFn('carriedText');
  ok(/Fix its end on ' \+ prevDay \+ ': a new end there fixes both days at once\./.test(ct) && /Fix its end time in Gusto/.test(ct) && /Change it in Gusto\./.test(ct), 'each case says where to fix it');
  ok(/if \(en\.readonly === 'split'\) return h`[^\n]*C\.splitWhy\(en, tz\)/.test(appFn('entryHtml')), 'read-only parts say why');
  ok(/en\.split && en\.split\.fix \? h`<p class="pd-fine ed-split">/.test(appFn('entryHtml')), 'the "set its real end here" note only where it can be done');
  ok(/if \(!en \|\| en\.readonly !== 'carried' \|\| !en\.split \|\| !en\.split\.end\) return;/.test(appFn('edEndMidnight')), 'the button cannot be forced');
  ok(/midnight: false, midnightEnd: false,[^}]*\};/.test(app), 'both off until a supervised run proves each');
});
check('messages show the seconds that cause them, and an overlap is marked on the break typed here, not the one Gusto has', () => {
  const me = { email: 'm@wizardtrees.com', is_admin: true }, at = { today: '2026-10-21', now: Date.parse('2026-10-21T18:00:00Z') };
  // the day before ends at 6:00:30 AM; a start typed at 6:00 AM
  const day = edRow([ES('s1', '07:00', '15:30')]);
  const de = C.editorEntries(day, day, [], me, at); de[0].inT = '06:00';
  eq(C.editPlan(day, de, { neighbors: [{ id: 'p1', in: '2026-10-05T22:00:00-07:00', out: '2026-10-06T06:00:30-07:00', date: '2026-10-05' }] }).errors[de[0].key].map(e => e.msg),
    ['This shift overlaps the 10:00 PM to 6:00:30 AM shift on Mon, Oct 5.']);
  de[0].inT = '05:00';
  eq(C.editPlan(day, de, { neighbors: [{ id: 'p1', in: '2026-10-05T22:00:00-07:00', out: '2026-10-06T06:00:30-07:00', date: '2026-10-05' }] }).errors[de[0].key].map(e => e.msg),
    ['This shift overlaps the 10:00 PM to 6:00 AM shift on Mon, Oct 5.'], 'by an hour: no seconds');
  // the same day: a shift ending at 11:00:40 AM and a new one typed from 11:00 AM
  const two = edRow([Object.assign(ES('s1', '07:00', '11:00'), { out: '2026-10-06T11:00:40-07:00' })]);
  const te = C.editorEntries(two, two, [], me, at); te.push(Object.assign(C.newEntry('n1'), { inT: '11:00', outT: '13:00' }));
  eq(C.editPlan(two, te, {}).errors.n1.map(e => e.msg), ['This shift overlaps the 7:00 AM to 11:00:40 AM shift.']);
  // a kept rest Gusto ended at 3:20:30 PM, the end typed as 3:20 PM
  const v = a => C.validateAfter(a, { tz: C.TZ, date: '2026-10-06' });
  eq(v({ in: EP('07:00'), out: EP('15:20'), breaks: [{ start: EP('15:10'), end: '2026-10-06T15:20:30-07:00', kind: 'rest' }] }).map(e => e.msg),
    ['Breaks must be inside the shift (7:00 AM to 3:20 PM). This break ends at 3:20:30 PM.']);
  // a meal typed at 9:47 to 10:17 before a rest Gusto keeps from 10:16:40: the meal is marked, not the rest
  const kept = { in: EP('07:00'), out: EP('15:30'), breaks: [{ start: EP('09:47'), end: EP('10:17'), kind: 'meal' }, { start: '2026-10-06T10:16:40-07:00', end: EP('10:30'), kind: 'rest' }] };
  eq(C.validateAfter(kept, { tz: C.TZ, date: '2026-10-06', kept: [false, true] }).map(e => [e.brk, e.msg]), [[0, "Overlaps the 10:16 AM rest (it starts at 10:16:40 AM). Breaks can't overlap."]]);
  eq(v(kept).map(e => e.brk), [1], 'without kept: the later one, as before');
  // through the editor: the kept rest is the one Gusto has, left alone
  const r = edRow([ES('s1', '07:00', '15:30', [EB('10:16', '10:30', 'rest', { start: '2026-10-06T10:16:40-07:00' })])]);
  const en = C.editorEntries(r, r, [], me, at);
  en[0].breaks.unshift({ startT: '09:47', endT: '10:17', kind: 'meal', orig: null });
  eq(C.editPlan(r, en, {}).errors[en[0].key].map(e => [e.code, e.brk]), [['brk_overlap', 0]]);
});

// ---------------------------------------------------------------------------------------------
// 17. data errors (the producer's tiny_shift, long_rest, shift_overlap and midnight_split of 2026-10-24,
//     ~/gusto-sync/ca-ts-core.mjs dataFlags and its midnight pass): the page computes the same flags in the
//     same words, for the demo and for a day changed here. Made-up days only. Where the producer is on this
//     machine both run on the same days and must agree; elsewhere the expected answers below (taken from the
//     producer's own tests) stand in for it.
// ---------------------------------------------------------------------------------------------
const PRODUCER_FILE = path.join(os.homedir(), 'gusto-sync', 'ca-ts-core.mjs');
let P = null;
try { if (fs.existsSync(PRODUCER_FILE)) P = await import(pathToFileURL(PRODUCER_FILE).href); }
catch (e) { console.log('          (the producer did not load: ' + String((e && e.message) || e).split('\n')[0] + ')'); }
if (!P) console.log('          (no ~/gusto-sync/ca-ts-core.mjs here: data-error flags checked against the expected answers only)');
const DATA_CODES = ['tiny_shift', 'midnight_split', 'long_rest', 'shift_overlap'];
const ALL_COS = ['filifera', 'slane', 'wafgus', 'imperial', 'wtny'];
const cOpts = co => ({ tz: C.rowTz({ company: co }), clock: C.rowClock({ company: co }) });
const pOpts = co => ({ tz: P.settingsFor(co).tz, clock: P.settingsFor(co).clock });
const zOff = co => co === 'wtny' ? '-04:00' : '-07:00';                       // October: EDT / PDT
const XT = (date, t, off) => date + 'T' + (t.length === 5 ? t + ':00' : t) + off;
const pad2 = n => String(n).padStart(2, '0');
const hmsOf = sec => pad2(Math.floor(sec / 3600)) + ':' + pad2(Math.floor(sec / 60) % 60) + ':' + pad2(sec % 60);
let dsSeq = 0;
// a stored ts_days shift on 2026-10-06 (wall times on the company's offset, or o.off); breaks [start, end|null, kind, {open}]
function DS(co, a, b, o) {
  const opt = o || {}, off = opt.off || zOff(co), date = opt.date || '2026-10-06';
  const t = v => v == null ? null : XT(date, v, off);
  const gm = v => Math.floor(Date.parse(v) / 60000);
  const breaks = (opt.breaks || []).map(([s, e, kind, x]) => ({ start: t(s), end: t(e), min: e ? Math.max(0, gm(t(e)) - gm(t(s))) : 0, kind, paid: kind === 'rest', src: 'gusto', open: !e || !!(x && x.open) }));
  return { id: opt.id || 'ds' + (++dsSeq), in: t(a), out: t(b), span_min: 0, worked_min: opt.hoursOnly || 0, hours_only: !!opt.hoursOnly, breaks };
}
const DHO = (co, min) => DS(co, '00:00:00', '23:59:59', { hoursOnly: min || 480 });
const ALONE1 = "The day's only shift lasted 1 min or less: was a clock-in missed? Fix the times in Gusto.";
const RETAP1 = 'Clocked in and out within 1 min: likely a mis-tap. Delete it or fix the times.';
const OVERLAP = 'Two shifts overlap: fix the times in Gusto.', TWICE = 'Same shift entered twice: delete one in Gusto.';
const LONG8 = [['10:00', '10:10', 'rest'], ['12:00', '12:30', 'meal']];
const sameId = DS('filifera', '08:00', '12:00');
const DF_CASES = [
  // tiny_shift
  ['the 4:44 PM - 4:44 PM day', 'filifera', [DS('filifera', '16:44:39', '16:44:50')], [['tiny_shift', ALONE1]]],
  ['zero length', 'filifera', [DS('filifera', '09:00:00', '09:00:00')], [['tiny_shift', ALONE1]]],
  ['a second under 5 minutes', 'filifera', [DS('filifera', '09:00:00', '09:04:59')], [['tiny_shift', "The day's only shift lasted 5 min or less: was a clock-in missed? Fix the times in Gusto."]]],
  ['exactly 5 minutes is a (short) shift', 'filifera', [DS('filifera', '09:00:00', '09:05:00')], []],
  ['two taps and nothing else', 'filifera', [DS('filifera', '16:44:39', '16:44:50'), DS('filifera', '16:45:02', '16:45:09')],
    [['tiny_shift', "The day's only 2 shifts each lasted 1 min or less: was a clock-in missed? Fix the times in Gusto."]]],
  ['a tap beside a running shift', 'filifera', [DS('filifera', '07:00:00', '07:00:20'), DS('filifera', '07:00:30', null)], [['tiny_shift', RETAP1]]],
  ['a tap beside an hours-entered shift', 'filifera', [DHO('filifera'), DS('filifera', '16:44:39', '16:44:50')], [['tiny_shift', RETAP1]]],
  ['two re-taps after a real shift', 'filifera', [DS('filifera', '08:01:07', '17:08:04', { breaks: LONG8 }), DS('filifera', '17:08:07', '17:08:23'), DS('filifera', '17:08:32', '17:08:36')],
    [['tiny_shift', '2 shifts clocked in and out within 1 min: likely mis-taps. Delete them or fix the times.']]],
  ['a shift still running has no length yet', 'filifera', [DS('filifera', '12:00', null)], []],
  ['a 12:00 AM piece is never a tap', 'filifera', [DS('filifera', '00:00:00', '00:02:18')], []],
  ['nor one Gusto closed at 11:59:59 PM', 'filifera', [DS('filifera', '23:58:30', '23:59:59')], []],
  ['nor an hours-entered shift, whatever its hours', 'filifera', [DHO('filifera', 3)], []],
  ['New York too', 'wtny', [DS('wtny', '16:44:39', '16:44:50')], [['tiny_shift', ALONE1]]],
  ['Waf & Gus punching in Eastern: the ET midnight piece is exempt on the Los Angeles clock', 'wafgus', [DS('wafgus', '00:00:00', '00:02:10', { off: '-04:00' })], []],
  ['... and the 11:59:59 PM ET cut', 'wafgus', [DS('wafgus', '23:57:00', '23:59:59', { off: '-04:00' })], []],
  ['... a Pacific tap at 9 PM is still one', 'wafgus', [DS('wafgus', '21:00:00', '21:02:10')], [['tiny_shift', "The day's only shift lasted 3 min or less: was a clock-in missed? Fix the times in Gusto."]]],
  ['New York: a Pacific punch cut at Pacific midnight is a midnight piece', 'wtny', [DS('wtny', '23:57:00', '23:59:59', { off: '-07:00' })], []],
  // long_rest
  ['a Gusto Rest of 2 h 8 min (New York)', 'wtny', [DS('wtny', '08:01:19', '16:55:31', { breaks: [['10:06', '12:14', 'rest']] })], [['long_rest', 'Rest of 2 h 8 min: was it ever ended?']]],
  ['a rest of 30 minutes is fine', 'filifera', [DS('filifera', '08:00', '16:30', { breaks: [['10:00', '10:30', 'rest'], ['12:00', '12:30', 'meal']] })], []],
  ['31 minutes', 'filifera', [DS('filifera', '08:00', '16:30', { breaks: [['10:00', '10:31', 'rest'], ['12:00', '12:30', 'meal']] })], [['long_rest', 'Rest of 31 min: was it ever ended?']]],
  ['an hour reads plainly', 'filifera', [DS('filifera', '08:00', '16:30', { breaks: [['10:00', '11:00', 'rest']] })], [['long_rest', 'Rest of 1 h: was it ever ended?']]],
  ['the longest one is named', 'filifera', [DS('filifera', '08:00', '16:30', { breaks: [['09:00', '09:40', 'rest'], ['13:00', '14:15', 'rest']] })], [['long_rest', 'Rest of 1 h 15 min: was it ever ended?']]],
  ['a long meal is no rest', 'filifera', [DS('filifera', '08:00', '16:30', { breaks: [['12:00', '12:40', 'meal']] })], []],
  ['a rest that ran to the clock-out is the open break\'s', 'filifera', [DS('filifera', '08:00', '12:06:44', { breaks: [['10:05', '12:06', 'rest', { open: true }]] })], []],
  ['a break with no end is 0 min', 'filifera', [DS('filifera', '08:00', '12:00', { breaks: [['10:00', null, 'rest']] })], []],
  // shift_overlap
  ['two shifts on the clock at once', 'filifera', [DS('filifera', '08:00', '12:00'), DS('filifera', '11:30', '16:00')], [['shift_overlap', OVERLAP]]],
  ['the same shift twice, to the minute', 'filifera', [DS('filifera', '08:00:12', '16:30:40'), DS('filifera', '08:00:00', '16:30:00')], [['shift_overlap', TWICE]]],
  ['back to back 3 seconds apart', 'filifera', [DS('filifera', '08:00', '12:06:29'), DS('filifera', '12:06:32', '13:00')], []],
  ['45 seconds of overlap', 'filifera', [DS('filifera', '08:00', '12:01:00'), DS('filifera', '12:00:15', '13:00')], []],
  ['a full minute', 'filifera', [DS('filifera', '08:00', '12:01:00'), DS('filifera', '12:00:00', '13:00')], [['shift_overlap', OVERLAP]]],
  ['a running shift covers what comes after it', 'filifera', [DS('filifera', '08:00', null), DS('filifera', '12:00', '13:00')], [['shift_overlap', OVERLAP]]],
  ['... and a shift that ends after it started', 'filifera', [DS('filifera', '08:00', null), DS('filifera', '06:00', '09:00')], [['shift_overlap', OVERLAP]]],
  ['... not one that ended before', 'filifera', [DS('filifera', '06:00', '07:00'), DS('filifera', '08:00', null)], []],
  ['one record listed twice is not two shifts', 'filifera', [sameId, Object.assign({}, sameId)], []],
  ['an hours-entered shift never overlaps a punch', 'filifera', [DHO('filifera', 240), DS('filifera', '13:00', '16:00')], []],
  ['New York too', 'wtny', [DS('wtny', '08:00', '10:00'), DS('wtny', '09:30', '11:00')], [['shift_overlap', OVERLAP]]],
  // together, in the producer's order
  ['a tap and an overlap', 'filifera', [DS('filifera', '08:00', '09:00'), DS('filifera', '08:30', '09:30'), DS('filifera', '13:00:05', '13:00:40')], [['tiny_shift', RETAP1], ['shift_overlap', OVERLAP]]],
  ['a long rest, a tap and an overlap', 'filifera', [DS('filifera', '08:00', '12:00', { breaks: [['09:00', '09:45', 'rest']] }), DS('filifera', '11:00', '15:00'), DS('filifera', '15:10:00', '15:10:30')],
    [['long_rest', 'Rest of 45 min: was it ever ended?'], ['tiny_shift', RETAP1], ['shift_overlap', OVERLAP]]],
];
check('data errors: each company reads punch times on the producer\'s clock (California converted to Los Angeles, New York on the punch\'s own)', () => {
  for (const co of ALL_COS) eq(cOpts(co), co === 'wtny' ? { tz: 'America/New_York', clock: 'punch' } : { tz: 'America/Los_Angeles', clock: 'tz' }, co);
  if (P) for (const co of ALL_COS) eq(cOpts(co), pOpts(co), co + ' (the producer)');
  eq(C.punchParts('2026-10-06T23:59:59-07:00', 'America/New_York'), { date: '2026-10-06', h: 23, m: 59, s: 59 }, 'as written');
  eq(C.clockParts('2026-10-06T23:59:59-07:00', 'America/New_York', 'tz'), C.zParts('2026-10-07T02:59:59-04:00', 'America/New_York'), 'converted');
  eq(C.punchParts('2026-10-07T06:59:59Z', C.TZ), C.zParts('2026-10-07T06:59:59Z', C.TZ), 'no numeric offset: read in the zone');
});
check('data errors: the page\'s dataFlags gives the producer\'s tiny_shift, long_rest and shift_overlap, in its words, on made-up days', () => {
  for (const [what, co, shifts, want] of DF_CASES) {
    const got = C.dataFlags(shifts, cOpts(co));
    eq(got.map(f => [f.code, f.msg]), want, what);
    ok(got.every(f => f.sev === 'warn'), what + ': warnings');
    if (P) eq(got, P.dataFlags(shifts, pOpts(co)), what + ' (the producer)');
  }
  eq(C.dataFlags([]), []); eq(C.dataFlags(null), []);
  for (const f of DF_CASES.flatMap(c => c[3]).concat(Object.entries(C.MIDNIGHT_MSG))) ok(!/[\u2013\u2014]/.test(f[1]) && f[1].length < 110, 'plain short words: ' + f[1]);
  // a day's own flags carry them (the demo and an edited day), next to the labor-rule flags
  const day = { company: 'filifera', region: 'CA', work_date: '2026-10-06', hours_only: false, gusto_total_min: null, shifts: DF_CASES[0][2], worked_min: 0, span_min: 0 };
  eq(C.dayFlags(day, '2026-10-08').map(f => f.code), ['tiny_shift']);
  const ny = { company: 'wtny', region: 'NY', work_date: '2026-10-06', hours_only: false, gusto_total_min: null, shifts: DF_CASES.find(c => c[0].startsWith('a Gusto Rest of 2 h 8 min'))[2], worked_min: 534, span_min: 534 };
  eq(C.dayFlags(ny, '2026-10-08').map(f => f.code), ['no_meal', 'long_rest'], 'New York: no meal on a shift over 6 hours, and the long rest');
});
check('data errors: on 4,000 random made-up days the page and the producer give the same tiny_shift, long_rest and shift_overlap', () => {
  if (!P) { console.log('          (skipped: the producer is not on this machine)'); return true; }
  let seed = 20261024;
  const rnd = k => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 2147483648 * k); };
  const pick = a => a[rnd(a.length)];
  const seen = {};
  for (let i = 0; i < 4000; i++) {
    const co = pick(['filifera', 'slane', 'wafgus', 'wtny']);
    const off = co === 'wtny' ? pick(['-04:00', '-04:00', '-07:00']) : co === 'wafgus' ? pick(['-07:00', '-07:00', '-04:00']) : '-07:00';
    const t = sec => XT('2026-10-06', hmsOf(sec), off);
    const shifts = [];
    for (let k = 1 + rnd(3); k > 0; k--) {
      const a = pick([0, 0, rnd(86400), 86399 - rnd(400), 25200 + rnd(36000), 25200 + rnd(36000)]);
      const len = pick([0, rnd(60), 299, 300, 301, rnd(900), 3600 + rnd(60), rnd(10 * 3600), rnd(10 * 3600)]);
      const b = rnd(6) === 0 ? 86399 : Math.min(a + len, 86399), ho = rnd(15) === 0, open = !ho && rnd(10) === 0;
      const breaks = [];
      for (let j = ho ? 0 : rnd(3); j > 0; j--) {
        const bs = a + rnd(Math.max(1, b - a)), be = rnd(8) === 0 ? null : Math.min(bs + pick([5, 10, 25, 30, 31, 45, 128]) * 60 + rnd(60), 86399);
        const kind = pick(['rest', 'rest', 'meal']);
        breaks.push({ start: t(bs), end: be == null ? null : t(be), min: be == null ? 0 : Math.floor(be / 60) - Math.floor(bs / 60), kind, paid: kind === 'rest', src: 'gusto', open: be == null || rnd(12) === 0 });
      }
      shifts.push({ id: shifts.length && rnd(15) === 0 ? shifts[0].id : 'r' + i + '-' + k, in: ho ? t(0) : t(a), out: ho ? t(86399) : open ? null : t(b),
        span_min: 0, worked_min: ho ? 240 : 0, hours_only: ho, breaks });
    }
    const got = C.dataFlags(shifts, cOpts(co));
    eq(got, P.dataFlags(shifts, pOpts(co)), 'random day ' + i + ' (' + co + ') ' + J(shifts.map(s => [s.in, s.out, s.hours_only])));
    for (const f of got) seen[f.msg.replace(/\d+/g, 'n')] = (seen[f.msg.replace(/\d+/g, 'n')] || 0) + 1;
  }
  const kinds = Object.keys(seen);
  ok(kinds.length >= 7 && kinds.every(k => seen[k] >= 5), 'the random days reach every wording often enough: ' + J(seen));
});

// one made-up person's days as Gusto's API lists the shifts ([date, in, out|null, {off, hoursOnly}]), for the
// producer, and as stored ts_days rows (grouped by Gusto's date, spans in Gusto's minutes), for the page
let fxSeq = 0;
function fxApi(co, list) {
  return list.map(([date, a, b, o]) => {
    const opt = o || {}, off = opt.off || zOff(co), inT = XT(date, a, off), outT = b ? XT(date, b, off) : null;
    return { id: 'fx' + (++fxSeq), date, clockInTimestamp: inT, clockOutTimestamp: outT,
      clockInPlatform: opt.hoursOnly ? null : 'IOS', clockOutPlatform: opt.hoursOnly || !outT ? null : 'IOS',
      durationInMinutes: opt.hoursOnly ? opt.hoursOnly : outT ? Math.floor((Date.parse(outT) - Date.parse(inT)) / 60000) : null,
      breaks: [], firstName: 'Test', lastName: 'Fixture', preferredName: 'Test Fixture', workerType: 'employee', employeeUuid: 'fx-1' };
  });
}
function fxRows(co, list) {
  const { tz, clock } = cOpts(co);
  const gm = t => { const p = C.clockParts(t, tz, clock); return Math.floor(Date.parse(t) / 60000) + (p && p.h === 23 && p.m === 59 && p.s === 59 ? 1 : 0); };
  const byDate = new Map();
  for (const s of fxApi(co, list)) {
    const ho = !s.clockInPlatform, span = s.clockOutTimestamp ? gm(s.clockOutTimestamp) - gm(s.clockInTimestamp) : 0;
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push({ id: s.id, in: s.clockInTimestamp, out: s.clockOutTimestamp, span_min: ho ? s.durationInMinutes : span,
      worked_min: ho ? s.durationInMinutes : span, hours_only: ho, breaks: [] });
  }
  return [...byDate].map(([date, shifts]) => ({ id: co + ':fx-1:' + date, company: co, region: C.regionOfCompany(co), employee_uuid: 'fx-1', work_date: date, shifts, flags: [] }));
}
const fxProducer = (co, list, today) => P.buildDays(fxApi(co, list), [{ company: co, employee_uuid: 'fx-1', name: 'Test Fixture', department: 'Test', job_title: null, active: true }],
  null, null, { company: co, today, syncedAt: '2026-10-08T19:00:00.000Z' });
const midOf = r => (r.flags.find(f => f.code === 'midnight_split') || {}).msg;
// [what, company, today, shifts, {date: 'start' | 'cont' | 'cutoff' | 'recut'}] (the producer's own test days)
const MID_CASES = [
  ['a forgotten clock-out: in at 11:50 AM, out the next morning and straight back in', 'slane', '2026-10-08',
    [['2026-10-05', '11:50:29', '23:59:59'], ['2026-10-06', '00:00:00', '08:06:29'], ['2026-10-06', '08:06:33', '16:38:12']], { '2026-10-05': 'start', '2026-10-06': 'cont' }],
  ['over 14 hours in all (9 AM to 2 AM), nothing after', 'filifera', '2026-10-08', [['2026-10-05', '09:00', '23:59:59'], ['2026-10-06', '00:00:00', '02:00']], { '2026-10-05': 'start', '2026-10-06': 'cont' }],
  ['out and back in within 5 minutes, under 14 hours', 'filifera', '2026-10-08',
    [['2026-10-05', '20:00', '23:59:59'], ['2026-10-06', '00:00:00', '07:00:10'], ['2026-10-06', '07:04:00', '15:00']], { '2026-10-05': 'start', '2026-10-06': 'cont' }],
  ['6 minutes later is a new shift', 'filifera', '2026-10-08', [['2026-10-05', '20:00', '23:59:59'], ['2026-10-06', '00:00:00', '07:00:10'], ['2026-10-06', '07:06:10', '15:00']], {}],
  ['still on the clock: each finished day says so, the running piece keeps No clock-out', 'filifera', '2026-10-08',
    [['2026-10-06', '07:00', '23:59:59'], ['2026-10-07', '00:00:00', '23:59:59'], ['2026-10-08', '00:00:00', null]], { '2026-10-06': 'start', '2026-10-07': 'cont' }],
  ['an evening start still running today', 'filifera', '2026-10-08', [['2026-10-07', '17:00', '23:59:59'], ['2026-10-08', '00:00:00', null]], { '2026-10-07': 'start' }],
  ['closed by Gusto at 11:59:59 PM, nothing carried into the next day', 'filifera', '2026-10-08', [['2026-10-05', '14:32:24', '23:59:59'], ['2026-10-06', '14:38:10', '19:17:45']], { '2026-10-05': 'cutoff' }],
  ['... not while that day is still today', 'filifera', '2026-10-05', [['2026-10-05', '14:32:24', '23:59:59']], {}],
  ['an hours-entered day after it is no continuation', 'filifera', '2026-10-08', [['2026-10-05', '16:00', '23:59:59'], ['2026-10-06', '00:00:00', '23:59:59', { hoursOnly: 480 }]], { '2026-10-05': 'cutoff' }],
  ['hours-entered days back to back never chain', 'filifera', '2026-10-08', [['2026-10-06', '00:00:00', '23:59:59', { hoursOnly: 480 }], ['2026-10-07', '00:00:00', '23:59:59', { hoursOnly: 480 }]], {}],
  ['a BA event to 12:21 AM', 'wafgus', '2026-10-08', [['2026-10-05', '18:34', '23:59:59'], ['2026-10-06', '00:00:00', '00:21']], {}],
  ['the 8:54 PM - 12:26 AM night', 'filifera', '2026-10-08', [['2026-10-05', '20:54', '23:59:59'], ['2026-10-06', '00:00:00', '00:26:17']], {}],
  ['an 8 h night shift', 'filifera', '2026-10-08', [['2026-10-05', '20:00', '23:59:59'], ['2026-10-06', '00:00:00', '04:00']], {}],
  ['an overnight entry split by hand at 11:59 PM (no :59 seconds)', 'wtny', '2026-10-08', [['2026-10-05', '15:45', '23:59'], ['2026-10-06', '00:00', '00:45']], {}],
  ['New York, an Eastern shift', 'wtny', '2026-10-08', [['2026-10-05', '11:00', '23:59:59'], ['2026-10-06', '00:00:00', '08:00']], { '2026-10-05': 'start', '2026-10-06': 'cont' }],
  ['New York, a Pacific punch Gusto closed at Pacific midnight', 'wtny', '2026-10-08',
    [['2026-10-05', '14:32:24', '23:59:59', { off: '-07:00' }], ['2026-10-06', '14:38:10', '19:17:45']], { '2026-10-05': 'cutoff' }],
  ['Gusto cut a shift still being worked, back in at 12:01:30 AM (New York)', 'wtny', '2026-10-08', [['2026-10-05', '20:00', '23:59:59'], ['2026-10-06', '00:01:30', '04:00']], { '2026-10-05': 'recut' }],
  ['back in at 12:04:59 AM (California)', 'filifera', '2026-10-08', [['2026-10-05', '20:00', '23:59:59'], ['2026-10-06', '00:04:59', '04:00']], { '2026-10-05': 'recut' }],
  ['back in at 12:05:10 AM is a new shift', 'filifera', '2026-10-08', [['2026-10-05', '20:00', '23:59:59'], ['2026-10-06', '00:05:10', '04:00']], { '2026-10-05': 'cutoff' }],
  ['a chain that ran on keeps its own words', 'filifera', '2026-10-08', [['2026-10-05', '09:00', '23:59:59'], ['2026-10-06', '00:00:00', '02:00'], ['2026-10-06', '02:01', '03:00']], { '2026-10-05': 'start', '2026-10-06': 'cont' }],
];
check('midnight_split: the page\'s chain rule gives the producer\'s flag and words on every made-up day (both days of a forgotten clock-out, never real overnight work)', () => {
  for (const [what, co, today, list, want] of MID_CASES) {
    const rows = fxRows(co, list);
    const m = C.midnightByRow(rows, { todayOf: () => today, known: () => true });
    for (const r of rows) {
      const got = m.get(r.id);
      ok(got && got.sure, what + ' ' + r.work_date + ': every day is known, so the page decides');
      eq(got.flag ? [got.flag.code, got.flag.sev, got.flag.msg] : null, want[r.work_date] ? ['midnight_split', 'warn', C.MIDNIGHT_MSG[want[r.work_date]]] : null, what + ' ' + r.work_date);
    }
    if (P) {
      const prows = fxProducer(co, list, today);
      eq(prows.map(r => [r.work_date, midOf(r) || null]), rows.map(r => [r.work_date, want[r.work_date] ? C.MIDNIGHT_MSG[want[r.work_date]] : null]), what + ' (the producer)');
      // and the page reading the producer's own rows (flags taken off) finds the same
      const pm = C.midnightByRow(prows.map(r => Object.assign({}, r, { flags: [] })), { todayOf: () => today, known: () => true });
      eq(prows.map(r => (pm.get(r.id).flag || {}).msg || null), prows.map(r => midOf(r) || null), what + ' (the page on the producer\'s rows)');
    }
  }
});
check('midnight_split: with days around it missing the page never guesses, it says unsure (and the producer\'s flag stays); a day it can decide alone it decides', () => {
  let unsure = 0, sure = 0;
  for (const [what, co, today, list, want] of MID_CASES) {
    const rows = fxRows(co, list);
    // every run of the days present, the rest of the dates not loaded
    for (let i = 0; i < rows.length; i++) for (let j = i; j < rows.length; j++) {
      const part = rows.slice(i, j + 1), have = new Set(part.map(r => r.work_date));
      const m = C.midnightByRow(part, { todayOf: () => today, known: d => have.has(d) });
      for (const r of part) {
        const got = m.get(r.id);
        if (!got.sure) { unsure++; continue; }
        sure++;
        eq((got.flag || {}).msg || null, want[r.work_date] ? C.MIDNIGHT_MSG[want[r.work_date]] : null, what + ' ' + r.work_date + ' with ' + J([...have]));
      }
    }
  }
  ok(unsure > 10 && sure > 30, 'both kinds happen: ' + J({ unsure, sure }));
  // the day it started is not loaded: the carried-over day cannot say, so the producer's own flag stays
  const rows = fxRows('filifera', [['2026-10-02', '09:00', '23:59:59'], ['2026-10-03', '00:00:00', '07:59:58'], ['2026-10-03', '08:00:01', '12:00']]);
  eq(C.midnightByRow([rows[1]], { todayOf: () => '2026-10-08', known: () => false }).get(rows[1].id), { flag: null, sure: false });
  eq(C.midnightByRow([rows[1]], { todayOf: () => '2026-10-08', known: () => true }).get(rows[1].id).sure, true, 'loaded and empty: no shift the day before');
  // the day after a cut is not loaded: a lone 11:59:59 PM cut could still run on
  const cut = fxRows('filifera', [['2026-10-05', '14:32:24', '23:59:59']]);
  eq(C.midnightByRow(cut, { todayOf: () => '2026-10-08' }).get(cut[0].id).sure, false);
  eq(C.midnightByRow(cut, { todayOf: () => '2026-10-08', known: () => true }).get(cut[0].id).flag.msg, C.MIDNIGHT_MSG.cutoff);
  // a day with no piece at midnight is decided alone
  const plain = fxRows('filifera', [['2026-10-05', '08:00', '16:30']]);
  eq(C.midnightByRow(plain, {}).get(plain[0].id), { flag: null, sure: true });
});
check('midnight_split: on 2,500 random made-up runs of days the page, reading the producer\'s rows, finds exactly the producer\'s flags', () => {
  if (!P) { console.log('          (skipped: the producer is not on this machine)'); return true; }
  let seed = 7243;
  const rnd = k => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 2147483648 * k); };
  const pick = a => a[rnd(a.length)];
  const dates = ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'];
  const seen = {};
  for (let i = 0; i < 2500; i++) {
    const co = pick(['filifera', 'slane', 'wafgus', 'wtny']), today = pick(['2026-10-06', '2026-10-07', '2026-10-08']), list = [];
    for (const d of dates) {
      if (d > today) break;
      const off = co === 'wtny' && rnd(5) === 0 ? '-07:00' : undefined;
      const o = off ? { off } : undefined;
      const hm = sec => hmsOf(sec);
      for (let k = rnd(3); k > 0; k--) {
        const kind = pick(['cut', 'cut', 'cont', 'cont', 'day', 'ho', 'after']);
        if (kind === 'cut') list.push([d, hm(pick([28800, 39600, 54000, 64800, 72000, 79200]) + rnd(3600)), '23:59:59', o]);
        else if (kind === 'cont') list.push([d, '00:00:00', pick(['00:21:00', '02:00:00', '04:00:00', '07:00:10', '08:06:29', '23:59:59', null, null]), o]);
        else if (kind === 'day') list.push([d, hm(25200 + rnd(7200)), hm(46800 + rnd(18000)), o]);
        else if (kind === 'ho') list.push([d, '00:00:00', '23:59:59', { hoursOnly: 240 + rnd(240) }]);
        else list.push([d, hm(pick([0, 30, 89, 299, 301, 400]) + pick([0, 1260, 25200, 29170])), hm(57600 + rnd(3600)), o]);   // just after midnight or just after a morning clock-out
      }
    }
    if (!list.length) continue;
    const prows = fxProducer(co, list, today);
    const pm = C.midnightByRow(prows.map(r => Object.assign({}, r, { flags: [] })), { todayOf: () => today, known: () => true });
    for (const r of prows) {
      const got = pm.get(r.id);
      ok(got.sure, 'random run ' + i + ' ' + r.work_date + ': decided');
      eq((got.flag || {}).msg || null, midOf(r) || null, 'random run ' + i + ' (' + co + ', today ' + today + ') ' + r.work_date + ' ' + J(list));
      if (got.flag) seen[got.flag.msg] = (seen[got.flag.msg] || 0) + 1;
    }
  }
  ok(Object.keys(seen).length === 4 && Object.values(seen).every(n => n >= 5), 'every wording comes up: ' + J(seen));
});
// the demo's days as Gusto's API lists them, for the producer's buildDays (one entry per shift, on its row's date)
const demoApi = rows => rows.flatMap(r => r.shifts.map(s => ({ id: s.id, date: r.work_date, clockInTimestamp: s.in, clockOutTimestamp: s.out,
  clockInPlatform: s.hours_only ? null : 'IOS', clockOutPlatform: s.hours_only || !s.out ? null : 'IOS',
  durationInMinutes: s.hours_only ? s.worked_min : s.out ? Math.floor((Date.parse(s.out) - Date.parse(s.in)) / 60000) : null,
  breaks: s.breaks.map((b, i) => ({ uuid: s.id + '-' + i, startTime: b.start, endTime: b.end })),
  firstName: r.employee_name.split(' ')[0], lastName: r.employee_name.split(' ')[1], workerType: 'employee', employeeUuid: r.employee_uuid })));
check('demo: the data-error flags come from the made-up scenarios, in the producer\'s words, and the producer reading the demo days agrees', () => {
  const by = (name, code) => demo.rows.filter(r => r.employee_name === name && r.flags.some(f => f.code === code));
  const msgs = (name, code) => by(name, code).map(r => r.flags.find(f => f.code === code).msg);
  eq(msgs('Pepper Moonwhistle', 'tiny_shift'), [RETAP1], 'a re-tap after the day\'s shift');
  eq(msgs('Bramble Featherstone', 'tiny_shift'), [ALONE1], 'a New York day whose only shift is a tap');
  eq(msgs('Oakley Whistledown', 'shift_overlap'), [OVERLAP], 'a second shift typed over the first');
  eq(msgs('Dewberry Quillon', 'long_rest'), ['Rest of 1 h 8 min: was it ever ended?'], 'a New York rest Gusto labelled, over an hour');
  eq(msgs('Cedar Puddlejump', 'midnight_split'), [C.MIDNIGHT_MSG.start, C.MIDNIGHT_MSG.cont], 'a forgotten clock-out, both days');
  const cedar = by('Cedar Puddlejump', 'midnight_split');
  eq(C.addDays(cedar[0].work_date, 1), cedar[1].work_date, 'the next day');
  ok(cedar[0].shifts[0].out.includes('T23:59:59-0') && cedar[1].shifts[0].in.includes('T00:00:00-0'), 'Gusto\'s own 11:59:59 PM and 12:00:00 AM');
  eq(cedar[0].span_min, 1440 - 690, 'the 11:59:59 PM clock-out counts as midnight');
  ok(cedar[1].work_date < demo.todays.CA, 'both days are over');
  const strays = demo.rows.filter(r => r.flags.some(f => DATA_CODES.includes(f.code)) && !['Pepper Moonwhistle', 'Bramble Featherstone', 'Oakley Whistledown', 'Dewberry Quillon', 'Cedar Puddlejump'].includes(r.employee_name));
  eq(strays.map(r => r.id), [], 'no data-error flag on an ordinary made-up day');
  if (!P) return;
  // the producer on the demo's own days: its dataFlags on each row, and its midnight pass on the shifts given back as Gusto lists them
  for (const r of demo.rows) eq(C.dataFlags(r.shifts, cOpts(r.company)), P.dataFlags(r.shifts, pOpts(r.company)), r.id);
  for (const co of ALL_COS) {
    const rows = demo.rows.filter(r => r.company === co);
    const today = demo.todays[C.regionOfCompany(co)];
    const prows = P.buildDays(demoApi(rows), demo.people.filter(p => p.company === co), null, null, { company: co, today, syncedAt: '2026-10-08T19:00:00.000Z' });
    const pmid = new Map(prows.map(r => [r.id, midOf(r) || null]));
    for (const r of rows) eq((r.flags.find(f => f.code === 'midnight_split') || {}).msg || null, pmid.get(r.id), r.id + ' midnight_split (the producer)');
    eq(prows.map(r => r.id).sort(), rows.map(r => r.id).sort(), co + ': the producer builds the same days');
  }
});
// Review 2026-10-24: the demo's forgotten clock-out used to be clocked out on arrival the next morning and straight back
// in. The demo judges meals and rests one calendar day at a time, the producer judges the 12:00 AM piece with the day
// before, so the next day showed Late meal, No 2nd meal and Missing rest pills the producer never writes there. Its two
// parts also had two ids, so the demo editor took a change Gusto (and the live board) refuses.
check('demo: the forgotten clock-out shows on both days exactly the pills the producer writes, meals and rests included, whenever it is opened; its two parts carry one Gusto id, so the editor refuses a change to either, as the live board does', () => {
  const me = { email: 'demo.owner@wizardtrees.com', is_admin: true };
  let builds = 0, compared = 0;
  for (let i = 0; i < 14 * 24; i += 13) {          // every hour of the day once, on every weekday, over two weeks
    const t = Date.parse(NOW) + i * 3600000, d = D.build(t), today = d.todays.CA;
    const cedar = d.rows.filter(r => r.employee_name === 'Cedar Puddlejump' && r.flags.some(f => f.code === 'midnight_split'));
    const at = ' (opened ' + new Date(t).toISOString() + ')';
    if (P) {
      const co = 'slane', mine = d.rows.filter(r => r.company === co);
      const prows = P.buildDays(demoApi(mine), d.people.filter(p => p.company === co), null, null, { company: co, today, syncedAt: '2026-10-08T19:00:00.000Z' });
      for (const r of cedar) { eq(r.flags, (prows.find(x => x.id === r.id) || {}).flags, r.id + ' (the producer)' + at); compared++; }
    }
    eq(cedar.map(r => r.flags), ['start', 'cont'].map(k => [{ code: 'midnight_split', sev: 'warn', msg: C.MIDNIGHT_MSG[k] }]), 'the forgotten clock-out\'s two days carry only the midnight pill' + at);
    eq(C.addDays(cedar[0].work_date, 1), cedar[1].work_date, 'the next day' + at);
    ok(cedar[1].work_date < today, 'both days are over' + at);
    ok(cedar[0].span_min + cedar[1].span_min > 840 && cedar.every(r => r.span_min <= 840), 'over 14 hours in all, neither day over 14 on its own' + at);
    const [a, b] = cedar.map(r => r.shifts);
    ok(a.length === 1 && b.length === 1 && a[0].id === b[0].id, 'one Gusto id for both parts' + at);
    ok(d.rows.every(r => r === cedar[0] || r === cedar[1] || !r.shifts.some(s => s.id === a[0].id)), 'and on no other day' + at);
    builds++;
  }
  ok(builds === 26, 'builds: ' + builds);
  if (P) ok(compared === 52, 'compared with the producer: ' + compared);
  // the editor (2026-10-25): a real end on the 11:59:59 PM part fixes both days; the next day's 12:00 AM part is carried over
  // (read-only, fixed on the day before); deleting the first part would take both days
  const rows = demo.rows.filter(r => r.employee_name === 'Cedar Puddlejump');
  const [mon, tue] = rows.filter(r => r.flags.some(f => f.code === 'midnight_split'));
  const nbOf = raw => rows.filter(r => r.work_date === C.addDays(raw.work_date, -1) || r.work_date === C.addDays(raw.work_date, 1))
    .flatMap(r => r.shifts.filter(s => !s.hours_only && s.in).map(s => ({ id: String(s.id), in: s.in, out: s.out || null, date: r.work_date, breaks: s.breaks || [] })));
  const ctx = { today: demo.todays.CA, now: Date.parse(NOW), midnight: { fix: true, end: true } };   // an admin's editor
  for (const raw of [mon, tue]) ok(C.canEditDate(raw.work_date, demo.todays.CA), raw.work_date + ' is inside the editable window');
  const en = C.editorEntries(mon, mon, [], me, Object.assign({ neighbors: nbOf(mon) }, ctx));
  eq([en[0].readonly || null, en[0].split.role], [null, 'first'], 'the first day: open for its real end');
  const lastBrk = Math.max(...en[0].breaks.map(b => +b.endT.slice(0, 2) * 60 + +b.endT.slice(3)));
  const endT = String(Math.floor((lastBrk + 30) / 60)).padStart(2, '0') + ':' + String((lastBrk + 30) % 60).padStart(2, '0');
  en[0].outT = endT;
  const pm = C.editPlan(mon, en, {});
  eq(pm.errors, {}, 'a real end after its breaks (' + endT + ') goes');
  eq(pm.ops.map(o => [o.action, o.shift_id]), [['update', String(mon.shifts[0].id)]]);
  const gone = C.editorEntries(mon, mon, [], me, Object.assign({ neighbors: nbOf(mon) }, ctx)); gone[0].del = true;
  eq(Object.values(C.editPlan(mon, gone, {}).errors).flat().map(e => e.code), ['split_delete'], 'deleting it is refused');
  const te = C.editorEntries(tue, tue, [], me, Object.assign({ neighbors: nbOf(tue) }, ctx));
  eq(te.map(e => e.readonly || null), ['carried'], tue.work_date + ': carried over, read-only');
});

// a made-up person over midnight: Mon 10/5 in at 11:50 AM, never out; Gusto split it at midnight; out Tue morning and straight back in
const MT = (date, t) => XT(date, t, '-07:00');
function MSH(id, date, a, b, breaks) {
  const gm = t => C.gustoMinute(t, C.TZ), inT = MT(date, a), outT = b ? MT(date, b) : null;
  const bs = (breaks || []).map(([s, e, kind]) => ({ start: MT(date, s), end: MT(date, e), min: gm(MT(date, e)) - gm(MT(date, s)), kind, paid: kind === 'rest', src: 'gusto', open: false }));
  const span = outT ? gm(outT) - gm(inT) : 0;
  return { id, in: inT, out: outT, span_min: span, worked_min: outT ? span - bs.filter(x => !x.paid).reduce((a, x) => a + x.min, 0) : 0, hours_only: false, breaks: bs };
}
function MROW(date, shifts, flags) {
  const all = shifts.flatMap(s => s.breaks), sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  return C.normRow({ id: 'filifera:m1:' + date, company: 'filifera', region: 'CA', employee_uuid: 'm1', employee_name: 'Test Midnight', department: 'Trim', job_title: 'Tester',
    work_date: date, first_in: shifts[0].in, last_out: shifts[shifts.length - 1].out, shifts, span_min: sum(shifts, s => s.span_min), worked_min: sum(shifts, s => s.worked_min),
    paid_break_min: sum(all.filter(b => b.paid), b => b.min), unpaid_break_min: sum(all.filter(b => !b.paid), b => b.min), reg_min: 480, ot_min: 0, dt_min: 0, ot_src: 'gusto',
    label_src: 'gusto', gusto_total_min: null, approval: null, note: null, flags: flags || [], open: shifts.some(s => !s.out), hours_only: false, synced_at: '2026-10-07T12:00:00Z' });
}
const MFLAG = k => ({ code: 'midnight_split', sev: 'warn', msg: C.MIDNIGHT_MSG[k] });
const M5 = MSH('m5', '2026-10-05', '11:50:29', '23:59:59', [['14:00', '14:10', 'rest'], ['17:00', '17:30', 'meal'], ['20:00', '20:10', 'rest']]);
const M6A = MSH('m6a', '2026-10-06', '00:00:00', '08:06:29'), M6B = MSH('m6b', '2026-10-06', '08:06:33', '16:38:12', [['10:00', '10:10', 'rest'], ['12:00', '12:30', 'meal'], ['14:00', '14:10', 'rest']]);
const MDAY5 = MROW('2026-10-05', [M5], [MFLAG('start'), { code: 'few_rest', sev: 'info', msg: 'm' }]);
const MDAY6 = MROW('2026-10-06', [M6A, M6B], [MFLAG('cont'), { code: 'long_day', sev: 'warn', msg: 'Over 14 hours, check for a missed clock-out' }]);
const MED = (row, s, o) => ED(Object.assign({ day_id: row.id, employee_uuid: 'm1', work_date: row.work_date, shift_id: s ? s.id : null, before: s ? C.shiftSnap(s) : null }, o));
const MFIX = MED(MDAY5, M5, { id: 'mx1', times_status: 'pending', after: { in: M5.in, out: MT('2026-10-05', '20:30'), breaks: C.snapBreaks(M5.breaks) } });          // out at 8:30 PM
const MBRK = MED(MDAY5, M5, { id: 'mx2', breaks_status: 'pending', after: { in: M5.in, out: M5.out, breaks: C.snapBreaks(M5.breaks.concat([{ start: MT('2026-10-05', '22:00'), end: MT('2026-10-05', '22:10'), kind: 'rest' }])) } });
const MDEL = MED(MDAY6, M6A, { id: 'mx3', action: 'delete', after: null, breaks_status: 'pending' });
const MLATE = MED(MDAY6, M6B, { id: 'mx4', breaks_status: 'pending', after: { in: M6B.in, out: M6B.out, breaks: C.snapBreaks(M6B.breaks.concat([{ start: MT('2026-10-06', '15:00'), end: MT('2026-10-06', '15:10'), kind: 'rest' }])) } });
const OVR = (rows, edits, known) => C.overlayRows(rows, edits, { todayOf: () => '2026-10-08', known: known || (() => true) });
const midMsg = r => (r.flags.find(f => f.code === 'midnight_split') || {}).msg || null;
check('overlay: a changed day keeps the producer\'s midnight_split while it still runs into midnight, and loses it once it no longer does', () => {
  const kept = OV(MDAY5, [MBRK]);
  ok(kept !== MDAY5 && kept.edit.pending.length === 1, 'the change shows');
  eq(midMsg(kept), C.MIDNIGHT_MSG.start, 'a rest added: the day still ends at 11:59:59 PM, so the flag stays (it used to drop until the next sync)');
  ok(kept.flags.filter(f => f.code === 'midnight_split').length === 1, 'once');
  eq(midMsg(OV(MDAY5, [MFIX])), null, 'the end fixed to 8:30 PM: nothing at midnight any more');
  eq(midMsg(OV(MDAY6, [MLATE])), C.MIDNIGHT_MSG.cont, 'the carried-over day, a rest added to its later shift');
  eq(midMsg(OV(MDAY6, [MDEL])), null, 'the 12:00 AM piece deleted');
});
check('overlay across days: fixing a forgotten clock-out clears both days; deleting the 12:00 AM piece leaves an 11:59 PM cut-off; a day next to one not loaded keeps the producer\'s flag', () => {
  // the end fixed on Monday: Tuesday (no change of its own) is no longer carried over
  let out = OVR([MDAY5, MDAY6], new Map([[MDAY5.id, [MFIX]]]));
  eq(out.map(midMsg), [null, null]);
  ok(out[1] !== MDAY6 && out[1].shifts === MDAY6.shifts && !out[1].edit, 'Tuesday: Gusto\'s shifts, a new flag list, no edit pill');
  eq(out[1].flags.map(f => f.code), ['long_day'], 'Tuesday keeps its other flags');
  // a rest added on Monday changes nothing at midnight: both keep the producer's own words
  out = OVR([MDAY5, MDAY6], new Map([[MDAY5.id, [MBRK]]]));
  eq(out.map(midMsg), [C.MIDNIGHT_MSG.start, C.MIDNIGHT_MSG.cont]);
  ok(out[1] === MDAY6, 'Tuesday is the very same row');
  // Tuesday's 12:00 AM piece deleted: Monday is a lone cut-off at 11:59:59 PM
  out = OVR([MDAY5, MDAY6], [MDEL]);
  eq(out.map(midMsg), [C.MIDNIGHT_MSG.cutoff, null]);
  // Tuesday not loaded: Monday cannot tell, so it keeps the producer's flag (and so does a change that leaves midnight alone)
  eq(OVR([MDAY5], [MBRK], d => d === '2026-10-05').map(midMsg), [C.MIDNIGHT_MSG.start]);
  // Monday not loaded: Tuesday cannot tell whether its 12:00 AM piece was carried over
  eq(OVR([MDAY6], [MLATE], d => d === '2026-10-06').map(midMsg), [C.MIDNIGHT_MSG.cont]);
  eq(OVR([MDAY6], [MDEL], d => d === '2026-10-06').map(midMsg), [null], 'the piece itself deleted: nothing left at midnight');
  // a day the change did not move keeps the producer's own words, even where the page would word it otherwise
  const odd = MROW('2026-10-05', [M5], [MFLAG('cutoff')]);
  eq(OVR([odd, MDAY6], [MLATE]).map(midMsg), [C.MIDNIGHT_MSG.cutoff, C.MIDNIGHT_MSG.cont]);
  // nobody's days move: every row is the same object, in order
  const plain = [MDAY5, MDAY6, edRow([ED_S1])];
  const same = OVR(plain, new Map());
  ok(same.length === 3 && same.every((r, i) => r === plain[i]), 'untouched');
  // a change on one person never moves another person's flags
  const other = Object.assign({}, MDAY6, { id: 'filifera:m2:2026-10-06', employee_uuid: 'm2' });
  ok(OVR([MDAY5, other], new Map([[MDAY5.id, [MFIX]]]))[1] === other, 'another person');
  // the demo's own changes: rows of people without one are the very same objects
  const idx = new Map(); for (const e of demo.edits) { if (!idx.has(e.day_id)) idx.set(e.day_id, []); idx.get(e.day_id).push(e); }
  const rows = demo.rows.map(r => C.normRow(r)), shown = C.overlayRows(rows, idx, { todayOf: r => demo.todays[r.region], known: () => true });
  const edited = new Set(demo.edits.map(e => e.company + ':' + e.employee_uuid));
  ok(rows.every((r, i) => edited.has(r.company + ':' + r.employee_uuid) || shown[i] === r), 'untouched demo rows');
  ok(rows.every((r, i) => !idx.has(r.id) || J(shown[i]) === J(C.overlayDay(r, idx.get(r.id), { today: demo.todays[r.region] }))), 'a changed demo day is overlayDay\'s');
});
check('overlay: tiny_shift, long_rest and shift_overlap follow the edited day (they used to drop until the next sync)', () => {
  const tap = ES('t1', '15:31', '15:32');
  const r = edRow([ED_S1, tap], { flags: [{ code: 'tiny_shift', sev: 'warn', msg: RETAP1 }] });
  const withRest = OV(r, [ED({ breaks_status: 'pending', after: AFTER('07:00', '15:30', [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal'], ['13:30', '13:40', 'rest']]) })]);
  eq(withRest.flags.filter(f => DATA_CODES.includes(f.code)), [{ code: 'tiny_shift', sev: 'warn', msg: RETAP1 }], 'a rest added elsewhere: the tap is still there');
  const gone = OV(r, [ED({ id: 'x2', shift_id: 't1', action: 'delete', before: C.shiftSnap(tap), after: null, breaks_status: 'pending' })]);
  eq(gone.flags.filter(f => DATA_CODES.includes(f.code)), [], 'the tap deleted');
  const long = OV(edRow([ED_S1]), [ED({ breaks_status: 'pending', after: AFTER('07:00', '15:30', [['09:00', '09:45', 'rest'], ['11:30', '12:00', 'meal']]) })]);
  eq(long.flags.filter(f => DATA_CODES.includes(f.code)).map(f => [f.code, f.msg]), [['long_rest', 'Rest of 45 min: was it ever ended?']], 'a rest typed at 45 min');
  const over = OV(edRow([ED_S1]), [ED({ id: 'a9', shift_id: null, action: 'add', before: null, after: AFTER('15:00', '18:00'), times_status: 'pending' })]);
  eq(over.flags.filter(f => DATA_CODES.includes(f.code)).map(f => [f.code, f.msg]), [['shift_overlap', OVERLAP]], 'a shift added over the day\'s');
  const nyRow = edRow([ES('n1', '05:00', '13:00', [EB('07:00', '07:10', 'rest'), EB('09:00', '09:30', 'meal')])], { id: 'wtny:e1:2026-10-06', company: 'wtny', region: 'NY' });
  const nyEd = OV(nyRow, [ED({ day_id: 'wtny:e1:2026-10-06', company: 'wtny', region: 'NY', shift_id: 'n1', before: C.shiftSnap(nyRow.shifts[0]), breaks_status: 'pending',
    after: AFTER('05:00', '13:00', [['07:00', '08:20', 'rest'], ['09:00', '09:30', 'meal']]) })]);
  eq(nyEd.flags.map(f => [f.code, f.msg]), [['long_rest', 'Rest of 1 h 20 min: was it ever ended?']], 'New York too');
});

// ---------------------------------------------------------------------------------------------
// 2026-10-25 (Gianni: "I feel like we shouldn't have this many needs a look notices")
// ---------------------------------------------------------------------------------------------
check('out of state: a person clocking in in another zone keeps California break flags as notes on every day, and the editor pushes no California breaks', () => {
  const ET = t => '2026-10-17T' + t + ':00-04:00';
  const sh = { id: 'f1', in: ET('12:00'), out: ET('22:30'), span_min: 630, worked_min: 630, hours_only: false, breaks: [] };
  // the producer decided it over the person's days (personAway) and marked each of them with other_zone
  const ZF = { code: 'other_zone', sev: 'info', msg: 'Clocks in on Eastern time, not Pacific: California break rules are shown as notes only' };
  const raw = edRow([sh], { id: 'wafgus:e2:2026-10-17', company: 'wafgus', work_date: '2026-10-17', flags: [ZF] });
  ok(C.rowAway(raw) && !C.rowAway(edRow([sh], { company: 'wafgus' })), 'the board reads the producer\'s flag, never one day\'s punches');
  eq([C.flagLabel(ZF), C.flagSev({ code: 'other_zone' })], ['Other time zone', 'info']);
  const flags = C.dayFlags(raw, '2026-10-25');
  eq(flags.filter(f => C.AWAY_CODES.includes(f.code)).map(f => [f.code, f.sev]), [['no_meal', 'info'], ['no_second_meal', 'info'], ['few_rest', 'info']]);
  ok(flags.filter(f => C.AWAY_CODES.includes(f.code)).every(f => f.msg.endsWith(C.AWAY_NOTE)), 'each says why');
  ok(!C.hasWarn(Object.assign({}, raw, { flags: flags.concat([ZF]) })), 'no red on the board');
  // (review F13) a changed time is written on the row's Pacific offset: the day stays the person's, notes not warnings
  const me = { email: 'm@wizardtrees.com', is_admin: true }, at = { today: '2026-10-21', now: Date.parse('2026-10-21T18:00:00Z') };
  const moved = C.overlayDay(raw, [{ id: 'z1', day_id: raw.id, company: 'wafgus', region: 'CA', work_date: raw.work_date, shift_id: 'f1', action: 'update',
    before: C.shiftSnap(sh), after: { in: '2026-10-17T08:30:00-07:00', out: sh.out, breaks: [] }, times_status: 'pending', breaks_status: 'none',
    created_by: 'm@wizardtrees.com', created_at: '2026-10-17T20:00:00Z' }], { today: '2026-10-21' });
  ok(moved.shifts[0].in.endsWith('-07:00'), 'the overlay writes the new start on Pacific time');
  eq(moved.flags.filter(f => C.AWAY_CODES.includes(f.code)).map(f => f.sev).filter(v => v === 'warn'), [], 'still notes after the edit');
  ok(moved.flags.some(f => f.code === 'other_zone'), 'the person\'s note stays');
  // without the producer's flag (a California person with one oddly stamped day): California's rules, in red
  const plain = edRow([sh], { id: 'wafgus:e3:2026-10-17', company: 'wafgus', work_date: '2026-10-17' });
  const pf = C.dayFlags(plain, '2026-10-25').filter(f => C.AWAY_CODES.includes(f.code));
  ok(pf.some(f => f.code === 'no_meal' && f.sev === 'warn') && pf.every(f => !f.msg.endsWith(C.AWAY_NOTE)), J(pf));
  // the producer writes the same flags for the same person (~/gusto-sync/ca-ts-core.mjs, on the Mac that has it)
  if (P && P.personAway) {
    const mk = (id, date, i, o) => ({ id, date, clockInTimestamp: date + 'T' + i + ':00-04:00', clockOutTimestamp: date + 'T' + o + ':00-04:00', clockInPlatform: 'IOS',
      durationInMinutes: Math.round((Date.parse(date + 'T' + o + ':00-04:00') - Date.parse(date + 'T' + i + ':00-04:00')) / 60000), breaks: [],
      firstName: 'Fl', lastName: 'Test', workerType: 'employee', employeeUuid: 'e2' });
    const prows = P.buildDays([mk('f1', '2026-10-17', '12:00', '22:30'), mk('f2', '2026-10-19', '09:00', '13:00')], [{ company: 'wafgus', employee_uuid: 'e2', name: 'Fl Test', department: 'D' }], null, null,
      { company: 'wafgus', today: '2026-10-25' });
    const prow = prows.find(r => r.work_date === '2026-10-17');
    eq(prow.flags.filter(f => C.AWAY_CODES.includes(f.code)).map(f => [f.code, f.sev, f.msg.endsWith(C.AWAY_NOTE)]), [['no_meal', 'info', true], ['no_second_meal', 'info', true], ['few_rest', 'info', true]], 'the producer agrees');
    for (const r of prows) eq(r.flags.filter(f => f.code === 'other_zone'), [ZF], 'every day of the person carries the note: ' + r.work_date);
    eq(P.AWAY_NOTE, C.AWAY_NOTE, 'the same words');
    ok(P.FLAG_ORDER.includes('other_zone') && C.FLAG_CODES.includes('other_zone'), 'both know the code');
  }
  // the editor: no Missing line, no Add missing breaks, + Add break comes blank (and the page shows none), even on a day
  // with no Gusto punch of its own (review F13: a missed clock-in day) and after a time was changed here
  const en = C.editorEntries(raw, raw, [], me, at), ctx = { date: raw.work_date, tz: C.TZ, company: 'wafgus', region: 'CA', away: true };
  eq(C.editorBreakStatus(en, ctx), { state: 'away', items: [], tone: 'info', text: C.AWAY_EDITOR_TEXT });
  ok(/Add or retype breaks for this person in Gusto/.test(C.AWAY_EDITOR_TEXT) && !/[–—]/.test(C.AWAY_EDITOR_TEXT), 'it says where breaks go (review F14)');
  eq(C.missingBreakAdds(en, ctx), []);
  eq(C.suggestBreak(en, en[0].key, ctx), { startT: '', endT: '', kind: 'rest', orig: null });
  const empty = edRow([], { id: 'wafgus:e2:2026-10-18', company: 'wafgus', work_date: '2026-10-18', flags: [ZF] });
  const added = C.editorEntries(empty, empty, [], me, at).concat([Object.assign(C.newEntry('n1'), { inT: '09:00', outT: '19:30' })]);
  const ectx = { date: empty.work_date, tz: C.TZ, company: 'wafgus', region: 'CA', away: C.rowAway(empty) };
  eq([C.editorBreakStatus(added, ectx).state, C.missingBreakAdds(added, ectx)], ['away', []], 'a missed clock-in day for the person');
  eq(C.editorBreakStatus(added, Object.assign({}, ectx, { away: false })).state, 'missing', 'the same day for anyone else: California rules');
  // the page tells the editor from the producer's flag, and the shift has no + Add break for such a person
  ok(/away: region !== 'NY' && C\.rowAway\(raw\)/.test(appFn('edCtx')), 'edCtx reads the person\'s flag');
  ok(/const away = !!raw && edCtx\(raw, tz\)\.away;/.test(appFn('entryHtml')) && /\$\{away \? h`<span class="faint ed-none">Add breaks for this person in Gusto\.<\/span>`/.test(appFn('entryHtml')), 'no + Add break for them');
  ok(!/punchAway/.test(src), 'no day-by-day guess left on the page');
});
check('Needs a look that the timesheet sync cleared (supabase/ts-edits-clear.sql) reads Cleared, with the reason, and is history', () => {
  const e = { id: 'c1', day_id: 'filifera:e1:2026-10-06', company: 'filifera', region: 'CA', work_date: '2026-10-06', shift_id: 's1', action: 'update',
    before: C.shiftSnap(ED_S1), after: AFTER('07:00', '15:00'), times_status: 'cancelled', breaks_status: 'none', times_error: 'Gusto already sent the hours for Sat Oct 10 to Fri Oct 23 to payroll',
    created_by: 'm@wizardtrees.com', created_at: '2026-10-07T15:00:00Z', cancelled_by: 'gusto-sync', cancelled_at: '2026-10-08T02:00:00Z', cancel_reason: 'Gusto now matches: Gusto reads as this change asked (7:00 AM to 3:00 PM)' };
  eq([C.editStatus(e), C.editShownStatus(e, new Set()), C.EDIT_STATUS_WORDS.cleared, C.CLEARED_BY], ['cancelled', 'cleared', 'Cleared', 'gusto-sync']);
  eq(C.editPartLines(e, C.TZ, Date.parse('2026-10-08T03:00:00Z')), ['Cleared automatically: Gusto now matches: Gusto reads as this change asked (7:00 AM to 3:00 PM)']);
  eq(C.editPartLines(Object.assign({}, e, { cancel_reason: null }), C.TZ, Date.parse('2026-10-08T03:00:00Z')), ['Cleared automatically: Gusto settled it'], 'before the column exists');
  eq(C.editShownStatus(Object.assign({}, e, { cancelled_by: 'm@wizardtrees.com' }), new Set()), 'cancelled', 'a manager\'s Clear stays Cancelled');
  const ov = C.overlayDay(edRow([ED_S1]), [e], { today: '2026-10-21' });
  ok(!(ov.edit && ov.edit.attention.length), 'no Needs a look pill on the board');
  const still = C.overlayDay(edRow([ED_S1]), [Object.assign({}, e, { times_status: 'conflict', cancelled_by: null, cancelled_at: null, cancel_reason: null })], { today: '2026-10-21' });
  eq(still.edit.attention.length, 1, 'while it needed a look, it had one');
  ok(/st === 'cleared'/.test(src.match(/const oldEdit = [^\n]+/)[0]) && /cleared: 'flag ecanc'/.test(src), 'muted in the history, a grey pill');
});

check('pay periods Gusto closed take no change; one sent to payroll warns; Missed payroll has its own list with Done (Gianni 2026-10-27)', () => {
  const cos = [
    { key: 'filifera', pay_periods: [
      { start: '2026-10-10', end: '2026-10-23', schedule: '77', closed: true, why: 'processed', sent_at: '2026-10-24T15:20:14+00:00', processed_at: null },
      { start: '2026-10-24', end: '2026-11-06', schedule: '77', closed: false, why: null, sent_at: null, processed_at: null }] },
    { key: 'slane', pay_periods: [
      { start: '2026-10-10', end: '2026-10-23', schedule: '1', closed: false, why: null, sent_at: '2026-10-24T15:20:14+00:00', processed_at: null }] },
    { key: 'wafgus', pay_periods: [
      { start: '2026-10-10', end: '2026-10-23', schedule: '1', closed: true, why: 'PAYROLL_PROCESSED' },
      { start: '2026-10-10', end: '2026-10-23', schedule: '2', closed: false }] },
    { key: 'imperial', pay_periods: null },
  ];
  eq(C.periodState(cos, 'filifera', '2026-10-19'), { closed: true, why: 'processed', start: '2026-10-10', end: '2026-10-23', sentAt: null });
  eq(C.periodState(cos, 'filifera', '2026-10-26'), { closed: false, why: null, start: '2026-10-24', end: '2026-11-06', sentAt: null });
  eq(C.periodState(cos, 'slane', '2026-10-23'), { closed: false, why: null, start: '2026-10-10', end: '2026-10-23', sentAt: '2026-10-24T15:20:14+00:00' });
  eq(C.periodState(cos, 'wafgus', '2026-10-19').closed, false, 'one schedule still open keeps the day open, as the server');
  eq([C.periodState(cos, 'imperial', '2026-10-19'), C.periodState(cos, 'nope', '2026-10-19'), C.periodState(cos, 'filifera', '2026-10-09'), C.periodState(cos, 'filifera', 'x')], [null, null, null, null]);
  eq(C.periodClosedText(C.periodState(cos, 'filifera', '2026-10-19')), 'Payroll for Sat, Oct 10 to Fri, Oct 23 has already been processed in Gusto, so this day can no longer be changed here. Fix it in Gusto, or have the hours added to the next payroll');
  ok(/^Gusto has locked the Sat, Oct 10 to Fri, Oct 23 pay period, so this day/.test(C.periodClosedText({ closed: true, why: 'PAYROLL_PROCESSED', start: '2026-10-10', end: '2026-10-23' })), 'locked words');
  const app = block('ts-app');
  ok(/if \(periodClosed\(raw\)\) return C\.periodClosedText\(rowPeriod\(raw\)\);/.test(appFn('noEditMsg')), 'a closed day says why Edit is not offered');
  ok(/ps && ps\.sentAt/.test(appFn('periodHint')) && /Gusto sent this pay period's hours to payroll on/.test(appFn('periodHint')), 'the editor warns when the hours went to payroll');
  ok(/fetchAll\(\(\) => sb\.from\('ts_companies'\)\.select\('\*'\)/.test(app), 'pay_periods come with ts_companies');
  if (fs.existsSync(path.join(ROOT, 'supabase', 'ts-pay-periods.sql'))) {
    const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'ts-pay-periods.sql'), 'utf8');
    ok(/before insert on public\.ts_edits/.test(sql) && /has already been processed in Gusto, so this day can no longer be changed here\. Fix it in Gusto, or have the hours added to the next payroll/.test(sql), 'the server refuses the same days with the same words');
  }
  // Missed payroll
  const base = { id: 'm1', day_id: 'x', times_status: 'conflict', breaks_status: 'none', times_error: 'Payroll for Sat Oct 10 to Fri Oct 23 has already been processed in Gusto', breaks_error: null, cancelled_at: null };
  eq([C.isMissedEdit(base), C.isMissedEdit(Object.assign({}, base, { times_error: 'Gusto already sent the hours for Sat Oct 10 to Fri Oct 23 to payroll (2026-10-24); change them in Gusto' })),
    C.isMissedEdit(Object.assign({}, base, { cancelled_at: '2026-10-27T00:00:00Z', cancelled_by: 'gianni@wizardtrees.com', times_status: 'cancelled' })),
    C.isMissedEdit(Object.assign({}, base, { times_status: 'none', breaks_status: 'failed', times_error: null, breaks_error: 'Gusto marks Mon Oct 19 as already paid (partly locked)' }))], [true, false, false, true]);
  eq(C.EDIT_STATUS_WORDS.missed, 'Missed payroll');
  ok(/^Missed payroll: Gusto had already processed this payroll/.test(C.editTip(base, C.TZ, Date.now())), 'the pill bubble says Missed payroll');
  const ea = appFn('editsAdminHtml');
  ok(/\['missed', 'Missed payroll'\]/.test(ea) && /const list = f === 'missed' \? missed : inRange\.filter\(F\[f\]\);/.test(ea), 'Admin > Edits has a Missed payroll filter over every date');
  ok(/done \? 'Done' : clear \? 'Clear' : 'Cancel'/.test(appFn('editAdminRow')) && /A\.ePick === e\.id \? ' picked' : ''/.test(appFn('editAdminRow')), 'Done on a Missed payroll row; the linked one is picked out');
  ok(/if \(!QS\.has\('missed'\) \|\| DEMO\) return;/.test(appFn('openMissedLink')) && /if \(!\(S\.me && S\.me\.is_admin\)\)/.test(appFn('openMissedLink')) && /openMissedLink\(\);/.test(appFn('startApp')), '?missed opens it for admins, from the daily list');
  ok(/\.is\('cancelled_at', null\)/.test(appFn('fetchMissed')), 'the list loads every open one, whatever the dates on screen');
});

// ---------------------------------------------------------------------------------------------
// 18. notes in Gusto (Gianni 2026-10-29: "can we add the feature to add gusto notes and see gusto notes?"): Gusto's notes
//     per shift (ts_days.shifts[i].notes from the timesheet sync; the day's one ts_days.note before that), notes added
//     here (ts_edits action 'note', supabase/ts-edit-notes.sql), and how a note stays out of everything about hours.
//     Made-up days and people only.
// ---------------------------------------------------------------------------------------------
const NOW_N = '2026-10-07T16:00:00Z';     // 9 AM Pacific, the day after the made-up day
const GN = (text, author, o) => Object.assign({ text, author, at: null, app: false, by: null, kind: 'other', src: 'csv' }, o || {});
const AN = (kind, by, text, o) => GN(text, 'Claude Claude', Object.assign({ app: true, by, kind }, o || {}));
const NTE = o => ED(Object.assign({ id: 'n1', action: 'note', after: null, note: 'Last day, 8 hours as agreed', breaks_status: 'pending' }, o));
const withNotes = (s, notes) => Object.assign({}, s, { notes });
const SQL_NOTES = (() => { try { return fs.readFileSync(path.join(ROOT, 'supabase', 'ts-edit-notes.sql'), 'utf8'); } catch { return ''; } })();
const PA = C.APP_EDIT_PREFIX;
// the lines the browser task writes (design part A), kept apart, run together, and around other people's words
const PARSE_SAMPLES = [PA + ' v@wizardtrees.com', PA + ' v@wizardtrees.com: forgot to clock out', 'Note from o@wizardtrees.com: Last day, 8 hours as agreed',
  [PA + ' v@wizardtrees.com: forgot', 'Note from o@wizardtrees.com: last day', PA + ' o@wizardtrees.com'].join('\n'),
  [PA + ' v@wizardtrees.com: forgot', 'Note from o@wizardtrees.com: last day', PA + ' o@wizardtrees.com'].join(' '),
  [PA + ' v@wizardtrees.com: forgot', 'Note from o@wizardtrees.com: last day'].join('\r\n\r\n'),
  'Imperial deleaf', 'Note from the doctor: rest at home', '', '   ', 'Picked up keys ' + PA + ' v@wizardtrees.com', PA + ' v@wizardtrees.com\nleft thru normal door',
  'Note from o@wizardtrees.com: line one\nline two', PA + ' a manager', PA + ' a manager: late bus', 'pop up at the store \nbreak for food at 4:30',
  PA + ' v@wizardtrees.com : a space before the colon'];
check('parseAppNote reads the lines the browser task writes, kept apart or run together, and anything else as one note', () => {
  const E1 = { kind: 'edit', by: 'v@wizardtrees.com', text: 'forgot' }, N1 = { kind: 'note', by: 'o@wizardtrees.com', text: 'last day' }, E2 = { kind: 'edit', by: 'o@wizardtrees.com', text: '' };
  const P = C.parseAppNote;
  eq(P(PARSE_SAMPLES[0]), [{ kind: 'edit', by: 'v@wizardtrees.com', text: '' }], 'a change with no reason');
  eq(P(PARSE_SAMPLES[1]), [{ kind: 'edit', by: 'v@wizardtrees.com', text: 'forgot to clock out' }], 'a change with its reason');
  eq(P(PARSE_SAMPLES[2]), [{ kind: 'note', by: 'o@wizardtrees.com', text: 'Last day, 8 hours as agreed' }], 'a note added here');
  for (const i of [3, 4]) eq(P(PARSE_SAMPLES[i]), [E1, N1, E2], i === 3 ? 'one line each' : 'lines run together with spaces');
  eq(P(PARSE_SAMPLES[5]), [E1, N1], "Gusto's blank line between them");
  eq(P('Imperial deleaf'), [{ kind: 'other', by: null, text: 'Imperial deleaf' }], "someone's own note");
  eq(P('Note from the doctor: rest at home'), [{ kind: 'other', by: null, text: 'Note from the doctor: rest at home' }], 'no email: not a line of ours');
  eq([P(''), P('   '), P(null)], [[], [], []], 'nothing');
  eq(P(PARSE_SAMPLES[10]), [{ kind: 'other', by: null, text: 'Picked up keys' }, { kind: 'edit', by: 'v@wizardtrees.com', text: '' }], 'words before a line of ours');
  eq(P(PARSE_SAMPLES[11]), [{ kind: 'edit', by: 'v@wizardtrees.com', text: '' }, { kind: 'other', by: null, text: 'left thru normal door' }], 'no ": " after the email: no reason');
  eq(P(PARSE_SAMPLES[12]), [{ kind: 'note', by: 'o@wizardtrees.com', text: 'line one line two' }], 'a note on two lines is one note');
  eq([P(PARSE_SAMPLES[13]), P(PARSE_SAMPLES[14])], [[{ kind: 'edit', by: null, text: '' }], [{ kind: 'edit', by: null, text: 'late bus' }]], '"a manager": a change made without an email');
  eq(P(PARSE_SAMPLES[16]), [{ kind: 'edit', by: 'v@wizardtrees.com', text: 'a space before the colon' }]);
  eq(C.APP_NOTE_PREFIX, 'Note from');
});
// its twins (~/gusto-sync/ca-ts-core.mjs, the timesheet sync, and ~/gusto-sync/ts-edit-plan.mjs, the browser task) must read
// every sample the same, on the Mac that has them (TS_GUSTO_SYNC_DIR checks another copy, a staging folder say: there both
// must be found, so a wrong folder fails instead of passing unchecked). Where the browser task has notes, its daily list's
// isMissed (ts-edit-mail.mjs) must also agree with isMissedEdit: a note never misses a payroll.
{
  const named = !!process.env.TS_GUSTO_SYNC_DIR, dir = process.env.TS_GUSTO_SYNC_DIR || path.join(os.homedir(), 'gusto-sync'), twins = [];
  const where = dir.replace(os.homedir(), '~'), load = async f => {
    const file = path.join(dir, f);
    try { return fs.existsSync(file) ? await import(pathToFileURL(file).href) : null; }
    catch (e) { console.log('          (' + f + ' did not load: ' + String((e && e.message) || e).split('\n')[0] + ')'); return null; }
  };
  for (const [who, f] of [['the timesheet sync', 'ca-ts-core.mjs'], ['the browser task', 'ts-edit-plan.mjs']]) {
    const m = await load(f); if (m && typeof m.parseAppNote === 'function') twins.push([who, m.parseAppNote]);
  }
  check('parseAppNote reads the same on the page as in the timesheet sync and the browser task (where ' + where + ' has them)', () => {
    if (named && twins.length < 2) throw new Error('TS_GUSTO_SYNC_DIR is ' + where + ', but ' + (twins.length ? 'only ' + twins[0][0] + ' has' : 'neither ca-ts-core.mjs nor ts-edit-plan.mjs has') + ' parseAppNote there');
    if (!twins.length) { console.log('          (skipped: no parseAppNote in ' + where + ' yet)'); return true; }
    for (const [who, f] of twins) for (const s of PARSE_SAMPLES) eq(f(s), C.parseAppNote(s), who + ' on ' + J(s));
  });
  const plan = twins.some(t => t[0] === 'the browser task') ? await load('ts-edit-plan.mjs') : null, mail = plan ? await load('ts-edit-mail.mjs') : null;
  check('Missed payroll reads the same on the page as in the daily list (where ' + where + ' has notes): never a note', () => {
    if (named && !(mail && typeof mail.isMissed === 'function')) throw new Error('TS_GUSTO_SYNC_DIR is ' + where + ', but ' + (plan ? 'its ts-edit-mail.mjs has no isMissed' : 'its browser task has no notes (no parseAppNote in ts-edit-plan.mjs)'));
    if (!mail || typeof mail.isMissed !== 'function') { console.log('          (skipped: no notes in ' + where + ' yet)'); return true; }
    eq(String(plan.MISSED_PAYROLL), String(C.MISSED_PAYROLL), 'MISSED_PAYROLL');
    const MISS = 'Payroll for Sat Oct 10 to Fri Oct 23 has already been processed in Gusto, so this change never reached Gusto', PAID = 'Gusto marks Mon Oct 19 as already paid (partly locked)';
    const samples = [ED({ times_status: 'conflict', times_error: MISS }), ED({ breaks_status: 'failed', breaks_error: PAID }), ED({ times_status: 'conflict', times_error: 'Gusto changed after this edit was made.' }),
      ED({ times_status: 'cancelled', times_error: MISS, cancelled_at: NOW_N, cancelled_by: 'm@wizardtrees.com' }), ED({ times_status: 'applied' }),
      NTE({ breaks_status: 'conflict', breaks_error: MISS }), NTE({ breaks_status: 'failed', breaks_error: PAID }), NTE({ breaks_status: 'failed', breaks_error: "Couldn't open this timesheet in Gusto." }), NTE()];
    for (const e of samples) eq(mail.isMissed(e), C.isMissedEdit(e), e.action + ' ' + e.times_status + '/' + e.breaks_status + ' ' + J(e.times_error || e.breaks_error));
    eq(samples.map(C.isMissedEdit), [true, true, false, false, false, false, false, false, false]);
  });
}
check("dayNotes: each shift's notes in shift order (a manager's line under their email), a change with no reason left out, the day's one note only when no shift has any", () => {
  const s2 = ES('s2', '16:00', '18:00');
  const r = edRow([withNotes(ED_S1, [GN('Just walked in', 'Test Person'), AN('edit', 'v@wizardtrees.com', ''), AN('edit', 'v@wizardtrees.com', 'forgot to clock out', { at: '2026-10-06T23:00:00Z', src: 'gusto' })]),
    withNotes(s2, [GN('Pop-up at the store', 'Test Lead', { at: '2026-10-06T23:10:00Z', src: 'gusto' }), AN('note', 'o@wizardtrees.com', 'Second stop ran long')])], { note: 'the summary' });
  const ns = C.dayNotes(r, []);
  eq(ns.map(n => [n.shiftId, n.shiftNo, n.text, C.noteWho(n), n.status]), [['s1', 1, 'Just walked in', 'Test Person', 'gusto'], ['s1', 1, 'forgot to clock out', 'v@wizardtrees.com via this app', 'gusto'],
    ['s2', 2, 'Pop-up at the store', 'Test Lead', 'gusto'], ['s2', 2, 'Second stop ran long', 'o@wizardtrees.com via this app', 'gusto']], 'the summary is not shown again');
  eq(C.noteMeta(ns[1], C.TZ, true), 'v@wizardtrees.com via this app, Oct 6, 4:00 PM · Shift 7:00 AM - 3:30 PM');
  eq(C.noteMeta(ns[0], C.TZ, false), 'Test Person', 'the morning export has no times');
  eq([C.notesLabel(ns), C.notesLabel(ns.slice(0, 1)), C.notesLook(ns)], ['4 notes', '1 note', '']);
  eq(C.notesTip(ns.slice(0, 2), r, NOW_N), 'Just walked in\nTest Person · Shift 7:00 AM - 3:30 PM\n\nforgot to clock out\nv@wizardtrees.com via this app, Oct 6, 4:00 PM · Shift 7:00 AM - 3:30 PM', 'the bubble');
  eq(C.notesTip(C.dayNotes(edRow([withNotes(ED_S1, [GN('Just walked in', 'Test Person')])]), []), r, NOW_N).split('\n')[0], 'Just walked in');
  // before notes came per shift (and Slane and Imperial, which have no export): the day's one note
  eq(C.dayNotes(edRow([ED_S1], { note: 'Ran deliveries through lunch' }), []).map(n => [n.shiftId, n.text, C.noteWho(n), n.kind]), [[null, 'Ran deliveries through lunch', '', 'other']]);
  eq([C.dayNotes(edRow([ED_S1]), []), C.dayNotes(edRow([withNotes(ED_S1, [AN('edit', 'v@wizardtrees.com', '')])]), [])], [[], []], 'none, or only a change with no reason');
  // a stored note that came without its kind is read again (parseAppNote)
  const raw = edRow([withNotes(ED_S1, [{ text: PA + ' v@wizardtrees.com: late bus\nNote from o@wizardtrees.com: OK by me', author: 'Claude Claude', at: null, src: 'csv' }])]);
  eq(C.dayNotes(raw, []).map(n => [n.kind, n.by, n.text, n.app]), [['edit', 'v@wizardtrees.com', 'late bus', true], ['note', 'o@wizardtrees.com', 'OK by me', true]]);
  eq(C.dayNotes(null, []), [], 'no day');
});
check('dayNotes: a note added here reads Pending until its run (Late after it), Needs a look when Gusto did not take it, In Gusto until the sync brings Gusto\'s copy, then only that copy', () => {
  const r = edRow([ED_S1]);
  const pend = NTE();          // made Oct 7 8 AM Pacific: the noon run takes it
  let ns = C.dayNotes(r, [pend]);
  eq(ns.map(n => [n.shiftId, n.text, n.status, C.noteWho(n), n.edit.id]), [['s1', 'Last day, 8 hours as agreed', 'pending', 'm@wizardtrees.com via this app', 'n1']]);
  eq(C.notesLook(ns), 'pend');
  eq([C.noteStatusText(ns[0], NOW_N, C.TZ), C.noteStatusText(ns[0], '2026-10-07T19:10:00Z', C.TZ), C.noteStatusText(ns[0], '2026-10-07T19:30:00Z', C.TZ)],
    ['Goes to Gusto at noon today.', 'Going to Gusto now.', 'Late, not in Gusto yet.']);
  eq(C.noteStatusText(ns[0], NOW_N, 'America/New_York'), 'Goes to Gusto at 3 PM today.', "on the row's own clock");
  // while the worker holds notes in the region (the page's EDIT_PROVEN), a waiting note says so instead of a run time or Late
  C.setNoteHeld(e => e.id === 'n1');
  eq([C.noteStatusText(ns[0], NOW_N, C.TZ), C.noteStatusText(ns[0], '2026-10-07T19:30:00Z', C.TZ)], ['Waits for the first note run Gianni watches, then goes to Gusto.', 'Waits for the first note run Gianni watches, then goes to Gusto.']);
  eq(C.noteStatusText(C.dayNotes(r, [NTE({ breaks_status: 'failed', breaks_error: 'x.' })])[0], NOW_N, C.TZ), 'Not in Gusto: x.', 'a refused one still says why');
  eq(C.editPartLines(pend, C.TZ, '2026-10-07T19:30:00Z'), ['The note: waits for the first note run Gianni watches'], 'Changes to this day says the same');
  ok(C.noteIsHeld(pend) && !C.noteIsHeld(NTE({ breaks_status: 'applied' })) && !C.noteIsHeld(ED({ id: 'n1', times_status: 'pending' })), 'only a waiting note');
  C.setNoteHeld(null);
  eq(C.noteStatusText(ns[0], NOW_N, C.TZ), 'Goes to Gusto at noon today.');
  eq(C.noteStatusText(C.dayNotes(r, [NTE({ breaks_status: 'applying', breaks_claimed_at: '2026-10-07T19:00:00Z' })])[0], '2026-10-07T19:05:00Z', C.TZ), 'Going to Gusto now.');
  eq(C.notesTip(ns, r, NOW_N), 'Last day, 8 hours as agreed\nm@wizardtrees.com via this app, Oct 7, 8:00 AM\nGoes to Gusto at noon today.', 'the bubble says when it goes');
  const failed = NTE({ breaks_status: 'failed', breaks_error: "Couldn't open this timesheet in Gusto." });
  ns = C.dayNotes(r, [failed]);
  eq([ns[0].status, C.notesLook(ns), C.noteStatusText(ns[0], NOW_N, C.TZ)], ['attention', 'att', "Not in Gusto: Couldn't open this timesheet in Gusto."]);
  eq(C.notesLook(C.dayNotes(r, [failed, NTE({ id: 'n2' })])), 'att', 'Needs a look shows over Pending');
  const applied = NTE({ breaks_status: 'applied', breaks_applied_at: '2026-10-07T19:02:00Z' });
  eq(C.dayNotes(r, [applied]).map(n => [n.status, C.noteStatusText(n, NOW_N, C.TZ)]), [['applied', 'In Gusto. It shows here as Gusto has it after the next sync.']]);
  const copy = by => edRow([withNotes(ED_S1, [AN('note', by, ' Last day,  8 hours as agreed ', { at: '2026-10-07T19:02:00Z', src: 'gusto' })])]);
  eq(C.dayNotes(copy('M@wizardtrees.com'), [applied]).map(n => [n.status, n.text]), [['gusto', 'Last day,  8 hours as agreed']], "Gusto's copy only (case and spaces do not count)");
  eq(C.dayNotes(copy('M@wizardtrees.com'), [failed]).map(n => n.status), ['gusto'], 'a Needs a look Gusto has since: its copy only');
  eq(C.dayNotes(copy('M@wizardtrees.com'), [pend]).map(n => n.status), ['gusto', 'pending'], 'a waiting one stays (the browser task finds it there and adds nothing)');
  eq(C.dayNotes(copy('other@wizardtrees.com'), [applied]).map(n => n.status), ['gusto', 'applied'], "another manager's same words are not its copy");
  // words typed in Gusto as claude@ on the next line read as part of the line (parseAppNote): its start is still its copy
  eq(C.dayNotes(edRow([withNotes(ED_S1, [AN('note', 'm@wizardtrees.com', 'Last day, 8 hours as agreed Typed by hand', { src: 'gusto' })])]), [applied]).map(n => n.status), ['gusto'], 'its copy with words typed after it');
  eq(C.dayNotes(edRow([withNotes(ED_S1, [AN('note', 'm@wizardtrees.com', 'Last day, 8 hours', { src: 'gusto' })])]), [applied]).map(n => n.status), ['gusto', 'applied'], 'a shorter line is not its copy');
  // one Gusto did not take stays on screen next to an older, longer line of the same manager's (word for word only)
  const older = edRow([withNotes(ED_S1, [AN('note', 'm@wizardtrees.com', 'Left early to see the doctor', { src: 'gusto' })])]);
  const lf = NTE({ id: 'f1', note: 'Left early', breaks_status: 'failed', breaks_error: "Couldn't open this timesheet in Gusto." }), lc = NTE({ id: 'c1', note: 'Left early', breaks_status: 'conflict', breaks_error: 'x.' });
  const kept = C.dayNotes(older, [lf, lc]);
  eq([kept.map(n => n.status), C.notesLook(kept), C.notesLabel(kept)], [['gusto', 'attention', 'attention'], 'att', '3 notes']);
  eq(C.dayNotes(edRow([ED_S1], { note: 'Last day, 8 hours as agreed (m@wizardtrees.com)' }), [applied]).map(n => n.status), ['gusto'], "a day with only its one note: inside it");
  // there, only as the sync's summary ("<words> (<email>)") or the line the browser task wrote, never the same letters
  // somewhere in someone else's words (a short note like "OK")
  const ok1 = NTE({ note: 'OK', breaks_status: 'applied', breaks_applied_at: '2026-10-07T19:02:00Z' }), only = note => C.dayNotes(edRow([ED_S1], { note }), [ok1]).map(n => n.status);
  eq([only('OK from me'), only('Not OK (Test Lead)'), only('OK (other@wizardtrees.com)'), only('Note from other@wizardtrees.com: OK'), only('Note from m@wizardtrees.com: OK then')],
    [['gusto', 'applied'], ['gusto', 'applied'], ['gusto', 'applied'], ['gusto', 'applied'], ['gusto', 'applied']], 'not its copy');
  eq([only('OK (M@wizardtrees.com)'), only('Ran late (Test Lead) · OK (m@wizardtrees.com)'), only('Note from m@wizardtrees.com: OK'), only('Note from m@wizardtrees.com: OK - Claude Claude'),
    only("Took the van - Test Person Note from m@wizardtrees.com: OK - Claude Claude Note from v@wizardtrees.com: fine")], [['gusto'], ['gusto'], ['gusto'], ['gusto'], ['gusto']], 'its copy');
  // never shown: cancelled, cleared by the sync, another day's, an empty one
  eq(C.dayNotes(r, [NTE({ breaks_status: 'cancelled', cancelled_by: 'm@wizardtrees.com', cancelled_at: NOW_N }), NTE({ id: 'n3', breaks_status: 'cancelled', cancelled_by: 'gusto-sync', cancelled_at: NOW_N }),
    NTE({ id: 'n4', day_id: 'filifera:e9:2026-10-06' }), NTE({ id: 'n5', note: '  ' }), ED({ id: 'u1', times_status: 'pending', after: AFTER('07:30', '15:30'), note: 'a reason' })]), []);
  // a shift no longer on the day: last, with the shift it was for
  const s2 = ES('s2', '16:00', '18:00'), two = edRow([withNotes(ED_S1, [GN('Just walked in', 'Test Person')]), s2]);
  eq(C.dayNotes(two, [NTE({ id: 'g1', shift_id: 'gone', before: C.shiftSnap(ES('gone', '19:00', '20:00')) }), NTE({ id: 'n6', shift_id: 's2', before: C.shiftSnap(s2) })]).map(n => [n.key, n.shiftNo, C.spanLabel(n.shift, C.TZ)]),
    [['g:s1:0:0', 1, '7:00 AM - 3:30 PM'], ['e:n6', 2, '4:00 PM - 6:00 PM'], ['e:g1', null, '7:00 PM - 8:00 PM']]);
});
check('a note added here (action note): what ts_edit_submit stores, its refusals (the server\'s words), several on one shift, cancel and clear', () => {
  const s2 = ES('s2', '16:00', '18:00'), h1 = Object.assign(ES('h1', '00:00', '23:59'), { hours_only: true, worked_min: 60, span_min: 60 });
  const raw = edRow([ED_S1, s2, h1, ES('o1', '19:00', null)]);
  const ctx = (id, extra) => Object.assign({ email: 'm@wizardtrees.com', now: NOW_N, today: '2026-10-07', id }, extra || {});
  const res = C.submitEdit([], raw, { shift_id: 's1', action: 'note', after: { in: 'ignored' }, note: '  Last day, 8 hours as agreed  ' }, ctx('n1'));
  ok(res.ok, res.error);
  eq(Object.keys(res.edit).sort(), [...EDIT_COLS].sort(), 'a ts_edits row');
  eq([res.edit.action, res.edit.shift_id, res.edit.after, res.edit.note, res.edit.times_status, res.edit.breaks_status, res.edit.created_by, C.editStatus(res.edit)],
    ['note', 's1', null, 'Last day, 8 hours as agreed', 'none', 'pending', 'm@wizardtrees.com', 'pending']);
  eq(res.edit.before, C.shiftSnap(ED_S1), 'before = the shift as Gusto has it (the browser task sends its times back as they are)');
  const two = C.submitEdit(res.edits, raw, { shift_id: 's1', action: 'NOTE', note: 'And one more thing' }, ctx('n2'));
  ok(two.ok && two.edits.length === 2 && two.edits.every(e => e.breaks_status === 'pending' && !e.cancelled_at), 'several notes on one shift all wait');
  const no = (input, list, c) => C.submitEdit(list || [], raw, Object.assign({ action: 'note' }, input), c || ctx('x')).error || '';
  eq([no({ shift_id: 's1', note: '   ' }), no({ shift_id: 's1', note: 'x'.repeat(401) }), no({ note: 'hi' })],
    ['Write the note first.', 'A note can be at most 400 characters.', 'Say which shift the note is for.']);
  ok(C.submitEdit([], raw, { shift_id: 's1', action: 'note', note: 'x'.repeat(400) }, ctx('x')).ok, '400 characters is fine (a reason can still be 500)');
  ok(/not on this day any more/.test(no({ shift_id: 'gone', note: 'hi' })), 'a shift no longer on the day');
  ok(/hours entered in Gusto without clock times: add the note in Gusto/.test(no({ shift_id: 'h1', note: 'hi' })), 'hours entered');
  ok(/still clocked in: add the note once it has an end/.test(no({ shift_id: 'o1', note: 'hi' })), 'still clocked in (the note goes with its start and end)');
  ok(/pay periods/.test(no({ shift_id: 's1', note: 'hi' }, [], ctx('x', { today: '2026-11-20' }))) && /not happened yet/.test(no({ shift_id: 's1', note: 'hi' }, [], ctx('x', { today: '2026-10-05' }))), 'the window, like any change');
  const sending = ED({ id: 'a1', times_status: 'applying', times_claimed_at: NOW_N, after: AFTER('07:30', '15:30') });
  ok(/being sent to Gusto right now/.test(no({ shift_id: 's1', note: 'hi' }, [sending])), 'not while a run writes a change of the shift');
  ok(/being sent to Gusto right now/.test(C.submitEdit([Object.assign({}, res.edit, { breaks_status: 'applying' })], raw, { shift_id: 's1', action: 'update', after: AFTER('07:30', '15:30') }, ctx('x')).error || ''), 'nor a change while a run writes a note');
  ok(C.submitEdit([sending], raw, { shift_id: 's2', action: 'note', note: 'hi' }, ctx('x')).ok, 'another shift is free');
  ok(C.submitEdit([ED({ id: 'w1', times_status: 'pending', after: AFTER('07:30', '15:30') })], raw, { shift_id: 's1', action: 'note', note: 'hi', expect: [] }, ctx('x')).ok, "a note's p_expect is never checked");
  // cancel and clear, like any change; then it shows nowhere
  const cx = C.cancelEdit(res.edits, 'n1', { email: 'm@wizardtrees.com', now: NOW_N });
  ok(cx.ok && cx.edit.breaks_status === 'cancelled' && cx.edit.times_status === 'none' && !C.dayNotes(raw, cx.edits).length, 'cancelled by its maker: gone');
  ok(!C.cancelEdit(res.edits, 'n1', { email: 'other@wizardtrees.com' }).ok, 'only its maker or an admin');
  ok(C.cancelEdit([Object.assign({}, res.edit, { breaks_status: 'failed' })], 'n1', { email: 'boss@wizardtrees.com', is_admin: true }).ok, 'an admin clears one Gusto did not take');
  ok(!C.cancelEdit([Object.assign({}, res.edit, { breaks_status: 'applying' })], 'n1', { email: 'm@wizardtrees.com' }).ok, 'never while a run sends it');
  // the page's own check before it sends: what it sends is one line (the browser task keeps a line per note)
  eq([C.cleanNoteText('  Last day,\n8 hours\tas agreed '), C.noteProblem(''), C.noteProblem(' a '), C.noteProblem('x'.repeat(401))], ['Last day, 8 hours as agreed', 'Write the note first.', '', 'A note can be at most 400 characters.']);
  eq(C.EDIT_RULES.gustoNoteMax, 400);
  // a note or reason holding a line start of this page's is refused, as ts_edit_submit does (GN47/GN48), split over lines
  // and spaces too; someone's own "Note from the doctor:" is fine (GN49)
  const FORGED = what => 'Leave "Note from <email>:" and "Changed through Wizard Trees Manager Timesheets for" out of the ' + what + ': the board would show them as lines written through this app.';
  eq([C.noteProblem('ok Note from other@wizardtrees.com: OT approved'), C.noteProblem('see\nNote   from\nother@wizardtrees.com: OT approved'),
    C.noteProblem('Changed through Wizard Trees Manager Timesheets for a manager'), C.noteProblem('Note from the doctor: rest until Monday')], [FORGED('note'), FORGED('note'), FORGED('note'), '']);
  eq([no({ shift_id: 's1', note: 'ok Note from other@wizardtrees.com: OT approved' }), no({ shift_id: 's1', note: 'see\nNote   from\nother@wizardtrees.com: OT approved' }),
    no({ shift_id: 's1', note: 'Note from the doctor: rest until Monday' })], [FORGED('note'), FORGED('note'), '']);
  eq([C.submitEdit([], raw, { shift_id: 's1', action: 'update', after: AFTER('07:30', '15:30'), note: 'Changed through Wizard Trees Manager Timesheets for other@wizardtrees.com: moved' }, ctx('r1')).error,
    C.submitEdit([], raw, { shift_id: 's1', action: 'update', after: AFTER('07:30', '15:30'), note: 'see\nNote\tfrom other@wizardtrees.com: moved' }, ctx('r2')).error,
    C.submitEdit([], raw, { shift_id: 's1', action: 'update', after: AFTER('07:30', '15:30'), note: 'late bus' }, ctx('r3')).error], [FORGED('reason'), FORGED('reason'), undefined]);
  if (SQL_NOTES) ok(SQL_NOTES.includes('Leave "Note from <email>:" and "Changed through Wizard Trees Manager Timesheets for" out of the %: the board would show them as lines written through this app'), 'the server says the same');
  // the same check for a reason, which Save changes runs before it sends anything
  eq([C.reasonProblem(''), C.reasonProblem('late bus'), C.reasonProblem('see\nNote\tfrom other@wizardtrees.com: moved'), C.reasonProblem('x'.repeat(501))],
    ['', '', FORGED('reason'), 'The reason can be at most 500 characters.']);
  const sde = src.slice(src.indexOf('async function saveDayEdits()'), src.indexOf('E.busy = true; E.stale = false;', src.indexOf('async function saveDayEdits()')));
  ok(/const note = E\.note\.trim\(\), rp = C\.reasonProblem\(note\);\s*if \(rp && plan\.ops\.some\(o => o\.type === 'submit'\)\)/.test(sde), 'Save changes refuses such a reason before it sends');
  ok(!/E\.note\.trim\(\)/.test(src.slice(src.indexOf('E.busy = true; E.stale = false;', src.indexOf('async function saveDayEdits()')), src.indexOf('async function', src.indexOf('E.busy = true; E.stale = false;', src.indexOf('async function saveDayEdits()'))))), 'and sends the reason it checked, not one typed during the refresh');
  // the change's own words and the reason, cut to 500 without splitting an emoji
  const cu = C.cutUnits('End it at 11:59 PM: ' + '\u{1F600}'.repeat(240), C.EDIT_RULES.noteMax);
  ok(cu.length <= 500 && !/[\uD800-\uDBFF]$/.test(cu) && C.cutUnits('abc', 5) === 'abc', 'cutUnits');
  // a closed pay period: the note words, from the page's own check and from the server's refusal alike
  ok((src.match(/\bNOTE_CLOSED\b/g) || []).length === 3 && /periodClosed\(raw\) \? NOTE_CLOSED/.test(src) && /\? NOTE_CLOSED\n/.test(src), 'NOTE_CLOSED in edSaveNote and runEditOp');
  if (SQL_NOTES) {
    for (const m of ['Write the note first', 'A note can be at most 400 characters', 'Say which shift the note is for', 'add the note in Gusto', 'add the note once it has an end', 'The action must be update, add, delete or note'])
      ok(SQL_NOTES.includes(m), 'supabase/ts-edit-notes.sql does not say ' + J(m));
    ok(/length\(v_note\) > 400/.test(SQL_NOTES) && /v_action <> 'note' and e\.action <> 'note'/.test(SQL_NOTES), 'the same 400, and a note neither replaces nor is replaced');
    ok(SQL_NOTES.includes('The action must be update, add or delete'), 'what the server says before the file is applied (the page reads it as not switched on yet)');
  }
});
check('a note never touches the hours: no Pending pill, nothing replaced either way, never in p_expect or the day\'s stamp, never Replaced', () => {
  const raw = edRow([ED_S1]), BR = [['09:00', '09:10', 'rest'], ['11:30', '12:00', 'meal']];
  const ctx = (id, at) => ({ email: 'm@wizardtrees.com', now: at, today: '2026-10-07', id });
  const t1 = C.submitEdit([], raw, { shift_id: 's1', action: 'update', after: AFTER('07:30', '15:30', BR), note: 'late bus' }, ctx('t1', '2026-10-07T15:00:00Z'));
  const n1 = C.submitEdit(t1.edits, raw, { shift_id: 's1', action: 'note', note: 'Bus was late' }, ctx('n1', '2026-10-07T15:10:00Z'));
  const t1a = n1.edits.find(e => e.id === 't1');
  ok(n1.ok && t1a.times_status === 'pending' && !t1a.cancelled_at, 'a note leaves a waiting change alone');
  const t2 = C.submitEdit(n1.edits, raw, { shift_id: 's1', action: 'update', after: AFTER('07:45', '15:30', BR), expect: ['t1'] }, ctx('t2', '2026-10-07T15:20:00Z'));
  ok(t2.ok, 'the waiting note is not "someone changed this shift": ' + t2.error);
  eq([t2.edits.find(e => e.id === 't1').cancelled_by, t2.edits.find(e => e.id === 'n1').breaks_status, t2.edits.find(e => e.id === 'n1').cancelled_at], ['superseded', 'pending', null], 'a later change replaces the change, never the note');
  ok(/Nothing changed/.test(C.submitEdit([n1.edit], raw, { shift_id: 's1', action: 'update', after: C.shiftSnap(ED_S1) }, ctx('x', NOW_N)).error || ''), 'a waiting note is no change to go back from');
  eq(C.supersede([n1.edit], raw.id, 's1', NOW_N), [n1.edit]);
  // the board, its pills and the CSV
  ok(C.overlayDay(raw, [n1.edit]) === raw, 'only a note: the row as Gusto has it, no pill');
  eq(OV(raw, [t1.edit, n1.edit]).edit.pending.map(e => e.id), ['t1'], 'beside a change: only the change is Pending');
  eq(C.buildCsv([C.overlayDay(raw, [n1.edit])], { edits: true }), C.buildCsv([raw], { edits: true }), 'the CSV is as before');
  // Replaced: a note never makes an older change Replaced, and is never Replaced itself
  eq([...C.replacedEdits([ED({ id: 'c1', times_status: 'conflict', created_at: '2026-10-07T10:00:00Z' }), NTE({ id: 'n9', created_at: '2026-10-07T11:00:00Z' })])], [], 'a later note replaces nothing');
  eq([...C.replacedEdits(t2.edits)], [], 'and the note stays its own');
  eq(C.replacedBy(t2.edits.find(e => e.id === 't1'), t2.edits).id, 't2', 'replaced by the change, not the note');
  // the editor: the note is no waiting change of the shift; while a run writes it, the shift waits (the server refuses then)
  const en = C.editorEntries(raw, OV(raw, [n1.edit]), [n1.edit], { email: 'm@wizardtrees.com' });
  eq([en[0].pendingIds, en[0].readonly], [[], undefined]);
  eq(C.editorEntries(raw, raw, [Object.assign({}, n1.edit, { breaks_status: 'applying' })], { email: 'm@wizardtrees.com' })[0].readonly, 'applying');
  // Save's stamp: a note added meanwhile (here or in Gusto) changes no time, so it never stops Save
  eq(C.dayStamp(raw, [n1.edit]), C.dayStamp(raw, []));
  eq(C.dayStamp(edRow([withNotes(ED_S1, [GN('Just walked in', 'Test Person')])]), []), C.dayStamp(raw, []));
  // Gusto's notes stay on a shift while a change of its times waits
  const moved = OV(edRow([withNotes(ED_S1, [GN('Just walked in', 'Test Person')])]), [ED({ times_status: 'pending', after: AFTER('07:30', '15:30', BR) })]);
  eq([moved.shifts[0].in, C.dayNotes(moved, []).map(n => n.text)], [EP('07:30'), ['Just walked in']]);
  ok(!('notes' in C.editedShift(ED_S1, AFTER('07:30', '15:30'), C.TZ)), 'no notes key on a shift without notes');
  // in words: Changes made here, the editor's history and Admin > Edits
  eq(C.describeEdit(n1.edit, C.TZ), ['Note: "Bus was late"', 'Shift 7:00 AM - 3:30 PM']);
  eq(C.editPartLines(n1.edit, C.TZ, NOW_N), ['The note: going to Gusto at noon today']);
  eq(C.editPartLines(Object.assign({}, n1.edit, { breaks_status: 'failed', breaks_error: 'Gusto said no.' }), C.TZ, NOW_N), ['The note: Gusto said no.']);
  eq([C.editReason(n1.edit), C.editReason(t1.edit), C.editReason(null)], ['', 'late bus', '']);
  const tip = C.editTip(n1.edit, C.TZ, NOW_N);
  ok(/Note: "Bus was late"/.test(tip) && !/Reason:/.test(tip), 'no Reason line repeating the note');
  ok(C.isNoteEdit(n1.edit) && !C.isNoteEdit(t1.edit) && !C.isNoteEdit(null));
});
check("a note Gusto refused because its payroll was processed (or its day locked) reads Needs a look, never Missed payroll, as in the daily list, and is cleared, not marked done", () => {
  const MISS = 'Payroll for Sat Oct 10 to Fri Oct 23 has already been processed in Gusto, so this change never reached Gusto: add the hours to the next payroll or fix them in Gusto, then mark it done';
  const nt = NTE({ breaks_status: 'conflict', breaks_error: MISS }), hrs = ED({ id: 'u1', breaks_status: 'conflict', breaks_error: MISS, after: AFTER('07:30', '15:30') });
  eq([C.isMissedEdit(nt), C.isMissedEdit(NTE({ breaks_status: 'failed', breaks_error: 'Gusto marks Mon Oct 19 as already paid (partly locked)' })), C.isMissedEdit(hrs)], [false, false, true]);
  eq([C.editStatus(nt), C.editTip(nt, C.TZ, NOW_N).split('\n')[0]], ['attention', 'Needs a look: Gusto did not take all of this change.']);
  // the page's own pill and Admin > Edits > Missed payroll filter, run as written
  const app = block('ts-app'), rep = C.replacedEdits([nt, hrs]);
  const pillOf = new Function('C', 'return ' + app.match(/const pillOf = ([^\n]+);\n/)[1])(C);
  const missed = new Function('C', 'rep', 'return ' + appFn('editsAdminHtml').match(/missed: (e => [^\n]+) \};/)[1])(C, rep);
  eq([pillOf(nt, C.editShownStatus(nt, rep)), pillOf(hrs, C.editShownStatus(hrs, rep))], ['attention', 'missed']);
  eq([nt, hrs].filter(missed).map(e => e.id), ['u1'], 'only the change of hours is on Missed payroll');
  ok(/done = clear && C\.isMissedEdit\(e\)/.test(appFn('editAdminRow')) && /done = C\.isMissedEdit\(S\.edits\.get\(id\)\)/.test(appFn('adminCancelEdit')), 'so Admin > Edits offers Clear on the note, not Done');
  eq(C.dayNotes(edRow([ED_S1]), [nt]).map(n => [n.status, C.notesLook([n]), C.noteStatusText(n, NOW_N, C.TZ).slice(0, 14)]), [['attention', 'att', 'Not in Gusto: ']], 'the note itself reads Not in Gusto');
  ok(/A note never goes on this list: one Gusto did not take reads Needs a look\./.test(appFn('editsAdminHtml')), 'the Missed payroll help says so');
});
check('noteShifts: a note can go on a Gusto shift with a clock-in and a clock-out, never hours entered, still open, split at midnight or waiting to be deleted', () => {
  const s2 = ES('s2', '16:00', '18:00'), h1 = Object.assign(ES('h1', '00:00', '23:59'), { hours_only: true });
  const raw = edRow([ED_S1, s2, h1, ES('o1', '19:00', null)]);
  eq(C.noteShifts(raw, {}).map(s => s.id), ['s1', 's2']);
  const del = st => ED({ id: 'd1', shift_id: 's2', action: 'delete', after: null, breaks_status: st, cancelled_at: st === 'cancelled' ? NOW_N : null });
  eq([C.noteShifts(raw, { edits: [del('pending')] }), C.noteShifts(raw, { edits: [del('applied')] }), C.noteShifts(raw, { edits: [del('cancelled')] })].map(l => l.map(s => s.id)),
    [['s1'], ['s1'], ['s1', 's2']], 'a delete waiting or just done; a cancelled one');
  // Gusto split it at midnight: 11:59:59 PM, and the same id goes on at 12:00 AM the next day
  const cut = { id: 'c9', in: EP('17:00'), out: '2026-10-06T23:59:59-07:00', span_min: 420, worked_min: 420, hours_only: false, breaks: [] };
  eq(C.noteShifts(edRow([cut]), { neighbors: [{ id: 'c9', in: '2026-10-07T00:00:00-07:00', out: '2026-10-07T02:00:00-07:00', date: '2026-10-07' }] }), [], 'split at midnight');
  eq(C.noteShifts(edRow([cut]), {}).map(s => s.id), ['c9'], 'without the next day: an ordinary shift');
  eq(C.noteShifts(null, {}), []);
});
check('demo: shifts carry notes as the sync writes them, with a note waiting, one Gusto did not take, one in Gusto, and one Gusto already shows', () => {
  const noted = demo.rows.filter(r => r.shifts.some(s => (s.notes || []).length));
  ok(noted.some(r => r.shifts.filter(s => (s.notes || []).length).length >= 2), 'notes on two shifts of one day');
  const all = noted.flatMap(r => r.shifts.flatMap(s => s.notes || []));
  ok(all.some(n => n.app && n.kind === 'note') && all.some(n => n.app && n.kind === 'edit' && n.text) && all.some(n => n.app && n.kind === 'edit' && !n.text) && all.some(n => !n.app), 'a manager\'s note, a reason, a change with no reason, someone\'s own');
  ok(all.some(n => n.src === 'csv') && all.some(n => n.src === 'gusto'), 'from the morning export and from Gusto');
  for (const r of noted) {
    eq(r.note, r.shifts.flatMap(s => s.notes || []).filter(n => n.text).map(n => n.text + ' (' + (n.app ? n.by : n.author) + ')').join(' · ') || null, r.id + ': the sync\'s summary');
    const ns = C.dayNotes(C.normRow(r), []);
    ok(ns.length && ns.every(n => n.text && n.shiftId), r.id + ': every note on its shift, none empty');
  }
  ok(demo.rows.some(r => r.note && !r.shifts.some(s => (s.notes || []).length)), 'and days with only their one note, as before');
  const notes = demo.edits.filter(C.isNoteEdit), st = notes.map(C.editStatus);
  ok(st.includes('pending') && st.includes('attention') && st.includes('applied'), 'waiting, not taken, in Gusto: ' + J(st));
  ok(notes.some(e => e.region === 'NY' && e.breaks_status === 'failed'), 'a New York one Gusto did not take');
  ok(notes.every(e => e.before && e.after === null && e.times_status === 'none' && e.note && e.note.length <= C.EDIT_RULES.gustoNoteMax), 'shaped like ts_edit_submit stores them');
  ok(notes.every(e => !C.editLate(e, NOW)), 'none late (the demo keeps one late change)');
  let copies = 0;
  for (const e of notes) {
    const ns = C.dayNotes(C.normRow(demo.rows.find(x => x.id === e.day_id)), demo.edits);
    const mine = ns.find(n => n.edit && n.edit.id === e.id), copy = ns.some(n => n.status === 'gusto' && n.app && n.by === e.created_by && n.text === e.note);
    if (copy) copies++;
    ok(copy ? !mine : !!mine && mine.status === C.editStatus(e), e.id + (copy ? ": only Gusto's copy" : ': shows as ' + C.editStatus(e)));
  }
  ok(copies === 1, 'one shows only as Gusto has it');
  for (let i = 0; i < 7; i++) {
    const d = D.build(Date.parse(NOW) + i * 86400000 + 5 * 3600000);
    ok(d.edits.filter(C.isNoteEdit).length >= 4 && d.rows.filter(r => r.shifts.some(s => (s.notes || []).length)).length >= 2, d.today + ': notes in the demo');
  }
});
check('page: the note mark ("1 note", "2 notes") and its bubble on desktop rows, a tag on phone cards and day lines, the notes written out when a card opens', () => {
  const app = block('ts-app'), nm = appFn('noteMark');
  ok(/function rowNotes\(r\) \{ return r \? C\.dayNotes\(r, editsFor\(r\.id\)\) : \[\]; \}/.test(app), "every note of the day: Gusto's and the ones added here");
  ok(/const tip = C\.notesTip\(ns, r, Date\.now\(\)\);/.test(nm) && /<span class="notemark\$\{noteCls\(ns\)\}" title="\$\{tip\}"/.test(nm) && /tabindex="0">\$\{C\.notesLabel\(ns\)\}<\/span>/.test(nm), 'the mark, its bubble and its words');
  ok(/\$\{noteMark\(r\)\}/.test(appFn('dayRowOf')) && /\$\{noteMark\(r\)\}/.test(appFn('empRow')), 'By Day after the name, By Employee after the date');
  ok(/nt = noteTag\(r\)/.test(appFn('breaksLine')) && /flagPills\(r, 'dl-flags', noteTag\(r\)\)/.test(appFn('dayLine')) && /\$\{extra \|\| ''\}/.test(appFn('flagPills')), 'a tag on a By Day card and on a By Employee day line');
  const nl = appFn('notesList');
  ok(/<span class="pd-k">Notes in Gusto<\/span><ul class="pd-list">/.test(nl) && /C\.noteMeta\(n, tz, multi\)/.test(nl) && /statusPill\(n\.status\)/.test(nl) && /C\.noteStatusText\(n, now, tz\)/.test(nl), 'the card: each note, who and when, and where one added here stands');
  ok(/canNoteRow\(r\) \? h`<button type="button" class="btn" data-act="note-day" data-k="\$\{r\.id\}">Add a note<\/button>`/.test(appFn('detailBody')) && /case 'note-day': openEditor\(d\.k, el, \{ note: true \}\); break;/.test(app), 'phones: Add a note next to Edit times or breaks');
  ok(/function canNoteRow\(r\) \{[^\n]*canEditRow\(raw\) && mayNote\(raw\) && noteTargets\(raw\)\.length > 0; \}/.test(app) && /C\.noteShifts\(raw, \{ neighbors: rawNeighbors\(raw\), edits: editsFor\(raw\.id\) \}\)/.test(app), 'whoever may change the day, once notes are proven there, on a shift that can take one');
  ok(/\.notemark\.pend,\.tagm\.pend\{border-color:rgba\(56,189,248,\.55\);color:var\(--ot-text\)/.test(src) && /\.notemark\.att,\.tagm\.att\{border-color:rgba\(240,173,78,\.62\);color:var\(--unpaid-text\)/.test(src), 'waiting looks like Pending, not taken like Needs a look');
  const leg = markup.match(/<div class="legend">[\s\S]*?\n {14}<\/div>/)[0];
  ok(/<span class="notemark">1 note<\/span>/.test(leg) && /<span class="notemark pend">1 note<\/span>/.test(leg), 'the Key shows both looks');
  ok(/const TIP_SEL = '\.infomark, abbr\.est, \.notemark, \.flag';/.test(app), 'the mark opens the bubble on a click or tap');
});
check('page: the editor lists the day\'s notes by shift and adds one with its own Save note, never touching typed times', () => {
  const app = block('ts-app'), eb = appFn('editorBody'), en = appFn('editorNotes'), nb = appFn('noteBox'), sn = appFn('edSaveNote');
  ok(/\$\{editorNotes\(raw, tz\)\}/.test(eb) && eb.indexOf('editorNotes(raw, tz)') < eb.indexOf('editorHistory(raw, tz)'), 'Notes in Gusto above the changes to the day');
  ok(/<span class="ed-k">Notes in Gusto<\/span>/.test(en) && /C\.dayNotes\(raw, editsFor\(raw\.id\)\)/.test(en) && /'Shift ' \+ C\.spanLabel\(g\.shift, tz\)/.test(en) && /statusPill\(n\.status\)/.test(en), 'grouped by shift on a day with more than one');
  ok(/data-act="ed-note-open"/.test(nb) && />\+ Add a note</.test(nb) && /class="linkbtn ed-nadd"/.test(nb), '+ Add a note');
  ok(/targets\.length > 1 \|\| \(targets\.length && !picked\) \? h`<label class="ed-f"><span>Shift<\/span><select id="edNoteShift">/.test(nb), 'a shift picker only when more than one shift can take a note (or the one picked left the list)');
  ok(/<textarea id="edNoteText" rows="3" maxlength="\$\{max\}"/.test(nb) && /max = C\.EDIT_RULES\.gustoNoteMax/.test(nb) && /id="edNoteCount">\$\{E\.noteText\.length \+ ' \/ ' \+ max\}</.test(nb), 'a box of 400 characters with a counter (Enter makes a new line there)');
  ok(/<button type="button" class="btn sm primary" data-act="ed-note-save"/.test(nb) && /<button type="button" class="btn sm" data-act="ed-note-cancel"/.test(nb), 'its own Save note and Cancel, type="button"');
  ok(nb.includes('Notes are visible to the employee in Gusto.'), 'the hint');
  ok(/runEditOp\(raw, \{ type: 'submit', key: 'note', shift_id: String\(s\.id\), action: 'note', after: null,/.test(sn) && /C\.noteProblem\(text\)/.test(sn) && /C\.cleanNoteText\(E\.noteText\)/.test(sn), 'Save note: the same RPC path as a change');
  ok(!/closeEditor\(|openEditor\(/.test(sn) && /resetNoteBox\(\); if \(E\.err === NOTE_FIRST\) E\.err = '';\n\s+render\(\); renderEditor\(\);/.test(sn) && /if \(!res\.error && !DEMO\) await fetchEdits\(raw\.work_date, raw\.work_date\);/.test(sn), 'then the same form again (typed times stay), with the day\'s changes read again');
  ok(/if \(E\.noteOpen && E\.noteText\.trim\(\)\) \{ E\.err = NOTE_FIRST;/.test(appFn('saveDayEdits')) && block('ts-app').includes("const NOTE_FIRST = 'Save the note first (Save note, under Notes in Gusto), or cancel it.';"), 'Save changes neither sends nor drops a typed note');
  ok(/if \(E\.err === NOTE_FIRST\) E\.err = '';/.test(appFn('edNoteClose')), 'and says so only until the note is saved or cancelled');
  ok(/\(E\.noteOpen && E\.noteText\.trim\(\) !== ''\)/.test(appFn('editorDirty')) && /if \(E\.busy \|\| E\.noteBusy\) return;/.test(appFn('requestCloseEditor')), 'a typed note counts when closing; never closes mid-save');
  ok(/if \(t\.id === 'edNoteText'\) \{ E\.noteText = t\.value;/.test(appFn('onEditorInput')) && /if \(t\.id === 'edNoteShift'\) \{ E\.noteShift = t\.value; return; \}/.test(appFn('onEditorInput')), 'typing keeps the box in step without a re-render');
  for (const a of ['ed-note-open', 'ed-note-cancel', 'ed-note-save']) ok(new RegExp("case '" + a + "': ").test(app), a + ' is wired');
  ok(/resetNoteBox\(\)/.test(appFn('openEditor')) && /resetNoteBox\(\)/.test(appFn('closeEditor')), 'a fresh box for every day');
  ok(/if \(opts && opts\.note && canNoteRow\(raw\)\) \{ E\.noteOpen = true;/.test(appFn('openEditor')) && /if \(E\.noteOpen\) \{ noteFocus\(\); return; \}/.test(appFn('openEditor')), "a phone's Add a note opens the box ready to type (only where the day's Add a note is offered)");
  const phone = src.match(new RegExp(PHONE_CSS.replace(/[()]/g, '\\$&') + '\\{([\\s\\S]*?)\\n  \\}\\n'))[1];
  ok(/#editPanel textarea\{font-size:16px\}/.test(phone), '16px on a phone (an iPhone zooms into smaller)');
});
// The page's own note functions, run as written with stand-ins: who is signed in, the editor's state, and the shifts that can
// take a note (C.noteShifts on the day as given). proven: EDIT_PROVEN as it will be after a supervised run.
function notePage(me, E, proven) {
  const app = block('ts-app'), pick = re => { const m = app.match(re); if (!m) throw new Error('not in ts-app: ' + re); return m[0]; };
  const code = [proven ? 'const EDIT_PROVEN = ' + J(proven) + ';' : pick(/const EDIT_PROVEN = \{[\s\S]*?\};/), pick(/const rowRegion = [^\n]*\n/),
    appFn('mayEdit'), appFn('mayNote'), pick(/const NOTE_NO_SHIFT = [^\n]*\n/), appFn('noteBox'), 'return { EDIT_PROVEN, mayEdit, mayNote, noteBox };'].join('\n');
  return new Function('C', 'h', 'actor', 'noteTargets', 'E', code)(C, C.h, () => me, raw => C.noteShifts(raw, {}), E);
}
const NOTE_BOX = o => Object.assign({ noteOpen: false, noteText: '', noteShift: '', noteErr: '', noteBusy: false, busy: false }, o || {});
check('notes are a held kind: a manager gets Add a note only once a supervised run proved notes in the day\'s region (CA and NY apart); admins and full viewers now', () => {
  const mgr = { email: 'm@wizardtrees.com', is_admin: false, active: true, grants: [{ company: 'filifera', department: 'Trim' }] };
  const fv = { email: 'v@wizardtrees.com', is_admin: false, active: true, grants: [{ company: '*', department: '*' }] }, admin = { email: 'boss@wizardtrees.com', is_admin: true, active: true, grants: [] };
  const ca = edRow([ED_S1]), ny = edRow([ED_S1], { id: 'wtny:e1:2026-10-06', company: 'wtny', region: 'NY' });
  const P = notePage(mgr, NOTE_BOX());
  eq([P.EDIT_PROVEN.note, P.EDIT_PROVEN.nyNote], [false, false], 'neither proven yet');
  eq([P.mayNote(ca), P.mayNote(ny)], [false, false], 'a manager: no notes yet');
  eq([notePage(admin, NOTE_BOX()).mayNote(ca), notePage(admin, NOTE_BOX()).mayNote(ny), notePage(fv, NOTE_BOX()).mayNote(ca)], [true, true, true], 'admins and full viewers: now');
  eq(String(P.noteBox(ca, C.TZ)), '', 'the editor offers a manager no + Add a note');
  ok(/data-act="ed-note-open"[^>]*>\+ Add a note</.test(String(notePage(admin, NOTE_BOX()).noteBox(ca, C.TZ))), 'an admin gets + Add a note');
  const caOnly = Object.assign({}, P.EDIT_PROVEN, { note: true });
  eq([notePage(mgr, NOTE_BOX(), caOnly).mayNote(ca), notePage(mgr, NOTE_BOX(), caOnly).mayNote(ny), notePage(mgr, NOTE_BOX(), Object.assign({}, caOnly, { nyNote: true })).mayNote(ny)], [true, false, true],
    'once CA:note is proven, California days; New York days wait for NY:note');
  // every way in asks the same: the phone's Add a note (canNoteRow), the editor opening with the box ready, + Add a note, Save note
  const app = block('ts-app');
  ok(/function mayNote\(r\) \{ return mayEdit\('note'\) && \(rowRegion\(r\) !== 'NY' \|\| mayEdit\('nyNote'\)\); \}/.test(app), 'mayNote');
  ok(/canEditRow\(raw\) && mayNote\(raw\) && noteTargets\(raw\)\.length > 0/.test(appFn('canNoteRow')) && /opts\.note && canNoteRow\(raw\)/.test(appFn('openEditor')), 'the phone button and the box it opens');
  ok(/if \(!raw \|\| !mayNote\(raw\) \|\| !t\.length \|\| E\.busy\) return;/.test(appFn('edNoteOpen')) && /!mayNote\(raw\) \? 'A note cannot be added here yet: add it in Gusto\.'/.test(appFn('edSaveNote')), '+ Add a note and Save note');
});
check('the note box once open: stays (to copy the note, or cancel it) when no shift can take it any more, never moves a note to a shift nobody picked, and never focuses a box that is gone', () => {
  const admin = { email: 'boss@wizardtrees.com', is_admin: true, active: true, grants: [] };
  const s2 = ES('s2', '16:00', '18:00'), two = edRow([ED_S1, s2]), none = edRow([Object.assign(ES('h1', '00:00', '23:59'), { hours_only: true })]);
  // closed: + Add a note, or why there is none
  ok(/A note can go here only on a finished shift with clock times, not one split at midnight or waiting to be deleted\./.test(String(notePage(admin, NOTE_BOX()).noteBox(none, C.TZ))), 'why a day has no shift for a note');
  // open, and the shift that could take it is gone: the typed note stays, with Cancel; Save note is off
  const gone = String(notePage(admin, NOTE_BOX({ noteOpen: true, noteText: 'Last day', noteShift: 's1' })).noteBox(none, C.TZ));
  ok(/<textarea id="edNoteText"[^>]*>Last day<\/textarea>/.test(gone) && gone.includes("None of this day&#39;s shifts can take a note now. Copy it into Gusto, or cancel it.") && /data-act="ed-note-cancel">Cancel/.test(gone), 'the note and Cancel stay: ' + gone);
  ok(/data-act="ed-note-save" disabled>/.test(gone) && !/<select/.test(gone), 'Save note is off, and there is no shift to pick');
  // open on a picked shift that left the list: "Pick the shift", never the first shift in its place (one shift left, too)
  const lost = n => String(notePage(admin, NOTE_BOX({ noteOpen: true, noteText: 'x', noteShift: 'gone' })).noteBox(n, C.TZ));
  for (const [r, opts] of [[two, 2], [edRow([s2]), 1]]) {
    const html = lost(r);
    ok(/<select id="edNoteShift"><option value="" selected disabled>Pick the shift<\/option>/.test(html) && (html.match(/<option value="s/g) || []).length === opts && !/<option value="s[^"]*" selected/.test(html), opts + ' shift(s) left: ' + html);
  }
  ok(!/<select/.test(String(notePage(admin, NOTE_BOX({ noteOpen: true, noteShift: 's2' })).noteBox(edRow([s2]), C.TZ))), 'one shift, the one picked: no picker');
  ok(/<option value="s2" selected>/.test(String(notePage(admin, NOTE_BOX({ noteOpen: true, noteShift: 's2' })).noteBox(two, C.TZ))), 'two shifts: the one picked shows picked');
  // Save note sends only to the shift picked; with nothing picked, the day's one shift
  ok(/s = targets\.find\(x => String\(x\.id\) === E\.noteShift\) \|\| \(targets\.length === 1 && !E\.noteShift \? targets\[0\] : null\);/.test(appFn('edSaveNote')) &&
     /\(s \? '' : targets\.length \? 'Pick the shift the note is for\.' : NOTE_NO_SHIFT\)/.test(appFn('edSaveNote')), 'Save note');
  // the box's text field only when it is there (the editor may have closed or lost the box meanwhile)
  const app = block('ts-app');
  ok(/function noteFocus\(\) \{ const t = \$\('edNoteText'\); if \(t\) t\.focus\(\); \}/.test(app) && !/\$\('edNoteText'\)\.focus\(\)/.test(app), 'every focus of it goes through noteFocus');
  ok(/if \(E\.noteOpen && E\.noteText\.trim\(\)\) \{ E\.err = NOTE_FIRST; renderEditor\(\); noteFocus\(\); return; \}/.test(appFn('saveDayEdits')), 'Save changes points at the box it refuses for, which is on screen');
});
check('page: a note goes through ts_edit_submit (action note), says when the server cannot take one yet, replaces nothing, and reads Note: "..." with Cancel and Clear', () => {
  const ro = appFn('runEditOp');
  ok(/: op\.action === 'note' && \/action must be update, add or delete\/i\.test\(errText\(error\)\) \? 'Adding notes is not switched on yet\.'/.test(ro), 'before supabase/ts-edit-notes.sql is applied: not switched on yet');
  ok(/if \(op\.type === 'submit' && op\.shift_id != null && op\.action !== 'note'\) for \(const x of C\.supersede\(/.test(ro), 'a note replaces nothing here either');
  ok(/C\.submitEdit\(list, raw, \{ shift_id: op\.shift_id, action: op\.action, after: op\.after, note, expect: op\.expect \}/.test(ro), 'demo: the same rules, in memory');
  ok(/C\.editReason\(e\) \? h`<div class="faint">Reason: \$\{e\.note\}<\/div>`/.test(appFn('editorHistory')) && /C\.editReason\(e\) \? h`<span class="faint">Reason: \$\{e\.note\}<\/span>`/.test(appFn('editAdminRow')), 'no Reason line repeating a note');
  ok(/nt \? \(clear \? 'Clear this note' : 'Cancel this note'\)/.test(appFn('editorHistory')), 'Cancel or clear a note in the editor, like any change');
  const cc = appFn('edCancelChange');
  ok(/if \(!note && editorDirty\(\) && E\.confirm !== id\)/.test(cc) && /if \(note\) \{ toast\([^\n]*renderEditor\(\); return; \}/.test(cc), 'cancelling a note keeps what is typed');
  ok(/C\.describeEdit\(e, tz\)/.test(appFn('editAdminRow')) && /C\.describeEdit\(e, tz\)\.join\(' · '\)/.test(appFn('histList')), 'Admin > Edits and Changes made here read Note: "..."');
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
