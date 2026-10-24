// node tests/ca-labor-check.mjs : run before every push that touches the CA Labor Tracker
// (labor-calculator.html) or labor-billing-core.js. Exit 0 = safe to push. Any FAIL = do not
// push; fix first. Works from any folder (paths resolve from this file).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'labor-calculator.html');
const src = fs.readFileSync(FILE, 'utf8');
let bad = 0; const say = (ok, m) => { console.log((ok ? '  PASS  ' : '  FAIL  ') + m); if (!ok) bad++; };

// 1. the file is whole: a truncated write is the one mistake that takes the whole board down
say(src.length > 150_000 && /<\/html>\s*$/i.test(src), `file is complete (${(src.length / 1024).toFixed(0)} KB, ends with </html>)`);

// 2. every inline script parses, each checked on its own so an error names its script
const scripts = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-labor-inline-'));
try {
  const errs = [];
  scripts.forEach((code, i) => {
    const f = path.join(tmpDir, `inline-${i + 1}.js`);
    fs.writeFileSync(f, code);
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch (e) { errs.push(`script ${i + 1}:\n` + String(e.stderr || e.message).split('\n').slice(0, 6).join('\n')); }
  });
  say(scripts.length > 0 && !errs.length, errs.length ? 'inline script syntax error:\n' + errs.join('\n') : `${scripts.length} inline script(s) parse`);
} finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }

// 2b. every LOCAL <script src> exists and parses (the page loads labor-billing-core.js)
const localSrcs = [...src.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]).filter(s => !/^(https?:)?\/\//i.test(s));
for (const s of localSrcs) {
  const f = path.join(ROOT, s.split(/[?#]/)[0]);
  if (!fs.existsSync(f)) { say(false, `script ${s} is missing (the page would load without it)`); continue; }
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); say(true, `script ${s} exists and parses`); }
  catch (e) { say(false, `script ${s} syntax error:\n` + String(e.stderr || e.message).split('\n').slice(0, 6).join('\n')); }
}

// 3. every tab has its page, and every page has its tab
const markup = src.replace(/<script[\s\S]*?<\/script>/g, '');   // markup only: code comments show examples
const tabs = [...markup.matchAll(/class="tab[^"]*"[^>]*data-tab="([^"]+)"/g)].map(m => m[1]);
const views = [...markup.matchAll(/<div id="view-([^"]+)"/g)].map(m => m[1]);
const orphanTabs = tabs.filter(t => !views.includes(t)), orphanViews = views.filter(v => !tabs.includes(v));
say(tabs.length && !orphanTabs.length && !orphanViews.length, `tabs ↔ pages match (${tabs.join(', ')})` + (orphanTabs.length ? ` · tab with no view-: ${orphanTabs}` : '') + (orphanViews.length ? ` · view- with no tab: ${orphanViews}` : ''));

// 4. every Reports option has a section, and every section has an option
const selBody = (markup.match(/<select id="reportSel">([\s\S]*?)<\/select>/) || [])[1] || '';
const opts = [...selBody.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
const reps = [...new Set([...markup.matchAll(/data-report="([^"]+)"/g)].map(m => m[1]))];
const noSection = opts.filter(o => !reps.includes(o)), noOption = reps.filter(r => !opts.includes(r));
say(opts.length && !noSection.length && !noOption.length, `reports ↔ sections match (${opts.join(', ')})` + (noSection.length ? ` · option with no section: ${noSection}` : '') + (noOption.length ? ` · section with no option: ${noOption}` : ''));

// 5. Gusto-owned keys are read but never written: shiftToTs keeps source/source_id, SHIFT_COL never sends them
const shiftCol = (src.match(/^const SHIFT_COL = \{[\s\S]*?^\};/m) || [''])[0];
const toTs = (src.match(/^function shiftToTs\(x\)\{[\s\S]*?^\}/m) || [''])[0];
say(shiftCol && !/\bsource(_id)?\s*:/.test(shiftCol), 'SHIFT_COL never sends source / source_id');
say(/\bsource\s*:\s*x\.source\b/.test(toTs) && /\bsource_id\s*:\s*x\.source_id\b/.test(toTs), 'shiftToTs keeps source and source_id');

// 5b. Gusto-paid harvest days never reach Norma's pay. Runs the REAL isGustoHarvestShift /
// isGustoDistro / isGustoPaidRow out of the page (brace-matched, as tests/inflight-edit-race.mjs
// does), once with the inline fallback and once with labor-billing-core.js loaded.
function grab(startRe) {
  const m = src.match(startRe);
  if (!m) return null;
  let depth = 0, started = false;
  for (let j = m.index; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return src.slice(m.index, j + 1); }
  }
  return null;
}
{
  const fns = [/^function isGustoHarvestShift\(s\)\{/m, /^function isGustoDistro\(s\)\{/m, /^function isGustoPaidRow\(s\)\{/m].map(grab);
  if (fns.some(f => !f)) say(false, 'isGustoHarvestShift / isGustoDistro / isGustoPaidRow not found in the page');
  else {
    const gustoHv = { id: 'a', category: 'harvest', source: 'import', source_id: 'gusto-filifera-hv:x', team: "Norma's Team", last: 'Test', first: 'Ana', work_date: '2026-10-20' };
    const sheetHv = { id: 'b', category: 'harvest', source: 'ocr', source_id: null, team: "Norma's Team", last: 'Test', first: 'Ana', work_date: '2026-10-20' };
    const otherImport = { id: 'c', category: 'harvest', source: 'import', source_id: 'deleaf-2026-10-20/x', team: '', last: 'Test', first: 'Ana', work_date: '2026-10-20' };
    // any Gusto import is Gusto-paid, even a packager row on Norma's Team for someone not ticked "Gusto distro"
    const gustoPkg = { id: 'd', category: 'distro', source: 'import', source_id: 'gusto-filifera-pkg:x:2026-10-20', team: "Norma's Team", last: 'Test', first: 'Ana', work_date: '2026-10-20' };
    const run = (withCore) => {
      const ctx = { roster: [], rosterMatch: () => null };
      ctx.window = ctx;
      vm.createContext(ctx);
      if (withCore) vm.runInContext(fs.readFileSync(path.join(ROOT, 'labor-billing-core.js'), 'utf8'), ctx);
      vm.runInContext(fns.join('\n'), ctx);
      return [ctx.isGustoDistro(gustoHv), ctx.isGustoPaidRow(gustoHv), !ctx.isGustoDistro(sheetHv), !ctx.isGustoPaidRow(sheetHv), !ctx.isGustoDistro(otherImport), ctx.isGustoPaidRow(gustoPkg)];
    };
    let inline = [], core = [], err = '';
    try { inline = run(false); core = run(true); } catch (e) { err = String(e && e.message || e); }
    say(!err && inline.length && inline.every(Boolean) && core.every(Boolean),
      "a Gusto Deleaf/Harvest import (source 'import', source_id 'gusto-filifera-hv:x') is Gusto-paid, a sheet row is not (inline fallback and core)"
      + (err ? ': ' + err : (inline.every(Boolean) ? '' : ' · inline ' + inline) + (core.every(Boolean) ? '' : ' · core ' + core)));
  }
  // the inline fallback uses the core's prefix, and every split goes through isGustoPaidRow
  const coreSrc = fs.existsSync(path.join(ROOT, 'labor-billing-core.js')) ? fs.readFileSync(path.join(ROOT, 'labor-billing-core.js'), 'utf8') : '';
  const pre = (coreSrc.match(/GUSTO_HV_PREFIX = '([^']+)'/) || [])[1];
  say(!!pre && (grab(/^function isGustoHarvestShift\(s\)\{/m) || '').includes(`startsWith('${pre}')`), `inline fallback prefix matches the core (${pre || 'not found'})`);
  const cmp = grab(/^function renderCompare\(\)\{/m) || '';
  say(/const isGustoRow = s => isGustoPaidRow\(s\);/.test(cmp) && /splitGusto = tsState\.compareView === 'cards' \|\| tsState\.compareView === 'simplified'/.test(cmp),
    "Combined: Norma's Team drops Gusto-paid rows; By person / Simplified put them on a separate Gusto line");
  // Combined > Norma's Team / Gusto Distro: a sheet row overlapping a Gusto row keeps its banner. The
  // pairs are checked against the person's rows from BEFORE the view dropped the other side.
  const before = cmp.indexOf('const rowsBeforeView = new Map(byEmp);'), viewFilter = cmp.indexOf("if (tsState.compareView === 'norma' || tsState.compareView === 'gusto'){");
  say(before > 0 && viewFilter > before && /const fullIds = new Set\(\(fullOf\.get\(base\) \|\| rowsBeforeView\.get\(base\) \|\| list\)/.test(cmp),
    "Combined > Norma's Team keeps the double-pay banner and Keep both for an overlap that crosses a Gusto row");
}

// 5b-2. Distro Hours > By Employee Simplified and its Copy for Google Sheets: a Gusto-paid day never rolls
// into a crew team's row. Runs the REAL renderTsSimplified / copyTsSimplified / tsTotbar from the page in vm
// against a made-up board, with the DOM stubbed.
{
  const names = [/^function isGustoHarvestShift\(s\)\{/m, /^function isGustoDistro\(s\)\{/m, /^function isGustoPaidRow\(s\)\{/m,
    /^function tsTotbar\(items\)\{/m, /^function renderTsSimplified\(\)\{/m, /^function copyTsSimplified\(list\)\{/m];
  const fns = names.map(grab);
  if (fns.some(f => !f)) say(false, 'Distro Hours > Simplified: renderTsSimplified / copyTsSimplified / tsTotbar not found in the page');
  else {
    const roster = [
      { id: 'rL', last: 'Torres', first: 'Lucero', team: "Norma's Team", gusto_distro: true, gusto_distro_from: '2026-09-16' },
      { id: 'rE', last: 'Lopez', first: 'Elena', team: "Norma's Team", gusto_distro: false },
    ];
    const d = (o) => ({ category: 'distro', company: 'Filifera', source: 'ocr', source_id: null, note: null, ...o });
    const rows = [
      d({ id: '1', roster_id: 'rL', last: 'Torres', first: 'Lucero', team: "Norma's Team", work_date: '2026-10-11', hours: 8, total: 160 }),   // Gusto-paid (on Gusto since 9/16)
      d({ id: '2', roster_id: 'rL', last: 'Torres', first: 'Lucero', team: "Norma's Team", work_date: '2026-09-10', hours: 5, total: 100 }),   // before 9/16: crew pay
      d({ id: '3', roster_id: 'rE', last: 'Lopez', first: 'Elena', team: "Norma's Team", work_date: '2026-10-11', hours: 6, total: 120 }),
      d({ id: '4', roster_id: null, last: 'Martinez', first: 'Jorge', team: 'Gusto Team', work_date: '2026-10-11', hours: 4.5, total: 90 }),
    ];
    const els = {}; let copied = null;
    const el = (id) => (els[id] ||= { id, innerHTML: '', onclick: null });
    const ctx = {
      roster, rosterMatch: (l, f) => roster.find(r => r.last === l && r.first === f) || null,
      filteredShifts: () => rows.slice(),
      tsNum: (n) => (Math.round((+n || 0) * 100) / 100).toFixed(2), tsMoney: (n) => '$' + (+n || 0).toFixed(2),
      hhmmss: (h) => String(h), esc: (s) => String(s ?? ''), toast: () => {},
      document: {
        getElementById: el, body: { appendChild() {} },
        createElement: () => ({ style: {}, value: '', focus() {}, select() {}, remove() {} }),
        execCommand: () => true,
      },
    };
    ctx.window = ctx;
    // the textarea copyTsSimplified fills is what reaches Google Sheets
    ctx.document.body.appendChild = (ta) => { copied = ta; };
    let err = '', lines = [], table = '', totbar = '';
    try {
      vm.createContext(ctx);
      vm.runInContext(fns.join('\n'), ctx);
      ctx.renderTsSimplified();
      table = el('tsTable').innerHTML; totbar = el('ts-totbar').innerHTML;
      el('ts-copysimple').onclick();
      lines = String(copied && copied.value || '').split('\n').filter(Boolean).slice(1).map(l => l.split('\t'));
    } catch (e) { err = String(e && e.message || e); }
    const line = (last, team) => lines.find(c => c[0] === last && c[2] === team);
    const crewLines = lines.filter(c => c[2] !== 'Gusto');
    const ok = !err
      && lines.length === 4
      && line('Torres', "Norma's Team")?.[3] === '100.00'   // only her crew day, never the Gusto-paid one
      && line('Torres', 'Gusto')?.[3] === '160.00'
      && line('Lopez', "Norma's Team")?.[3] === '120.00'
      && line('Martinez', 'Gusto')?.[3] === '90.00'
      && crewLines.reduce((a, c) => a + Number(c[3]), 0) === 220
      && (table.match(/<td>Gusto<\/td>/g) || []).length === 2
      && /People<\/div><div class="v">3</.test(totbar)
      && /Already paid by Gusto<\/div><div class="v">\$250\.00/.test(totbar);
    say(ok, "Distro Hours > By Employee Simplified and Copy for Google Sheets put Gusto-paid days on a 'Gusto' row, never under a crew team"
      + (ok ? '' : ': ' + (err || JSON.stringify({ lines, totbar }))));
  }
}

// 5c. the Labor billing report is wired: its Reports option and its section both exist
say(/<select id="reportSel">[\s\S]*?<option value="billing">[\s\S]*?<\/select>/.test(markup)
  && /<section data-report="billing" id="rep-billing"[^>]*>[\s\S]*?<div id="billOut"><\/div>/.test(markup),
  'Reports > Labor billing: option and section (#rep-billing, #billOut) present');

// 5d. paged loads order by a unique key, so a page boundary cannot skip or repeat a row
const fa = grab(/^async function fetchAll\(table, orderCol\)\{/m) || '';
say(/q = q\.order\(key\)/.test(fa) && /const FETCH_KEY = \{ packaging_notes: 'work_date', packaging_units_days: 'work_date' \};/.test(src),
  'fetchAll pages in a stable order (orderCol, then id or the day key)');

// 6. the regression tests
for (const [t, args] of [['tests/inflight-edit-race.mjs', [FILE]], ['tests/labor-billing-core.test.mjs', []]]) {
  const f = path.join(ROOT, t);
  if (!fs.existsSync(f)) { if (t.includes('inflight')) say(false, t + ' is missing'); else console.log('  skip  ' + t + ' (not present)'); continue; }
  try { execFileSync(process.execPath, [f, ...args], { stdio: 'pipe', cwd: ROOT }); say(true, t); }
  catch (e) { say(false, t + '\n' + (String(e.stdout || '') + String(e.stderr || '')).split('\n').filter(l => /FAIL|Error|assert/i.test(l)).slice(0, 5).join('\n')); }
}
console.log(bad ? `\n✗ ${bad} check(s) failed, do not push` : '\n✓ safe to push');
process.exit(bad ? 1 : 0);
