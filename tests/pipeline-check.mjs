// Checks the Production Pipeline page's sheet parsers (pipeline.html) on a made-up week laid out
// the way the DISTRO PIPELINE tab is, a made-up DISTRO SUPPLY tab, made-up Batch Label Sheet rows, and
// made-up task tracker rows for plan vs actual.
// Run: node tests/pipeline-check.mjs [real pipeline export.csv] [--supply=real supply export.csv]
//        [--batches=pipeline_batches rows as JSON] [--tasks=packaging_tasks rows as JSON] [--trims=pipeline_trims rows as JSON]
//        [--live=folder with the write-back research's saved copies of the sheet (grid.json, meta.json, sup/)]
// Run this before every push that touches pipeline.html: any failure means do not push.
import { readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../pipeline.html', import.meta.url), 'utf8');

// the page as a whole: a truncated write or one syntax error takes the whole board down for the crew
assert.ok(html.length > 150_000 && /<\/html>\s*$/i.test(html), `pipeline.html is complete (${Math.round(html.length / 1024)} KB, ends with </html>)`);
{
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const tmp = path.join(os.tmpdir(), `pipeline-inline-${process.pid}.js`);
  writeFileSync(tmp, scripts.join('\n;\n'));
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  catch (e) { assert.fail('an inline script does not parse:\n' + String(e.stderr || e.message).split('\n').slice(0, 6).join('\n')); }
  finally { rmSync(tmp, { force: true }); }
  // every page is three pieces: its nav button, its <section id="view-X">, and its entry in RENDER
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, '');
  const nav = [...markup.matchAll(/<button[^>]*data-view="([^"]+)"/g)].map(m => m[1]);
  const secs = [...markup.matchAll(/<section id="view-([^"]+)"/g)].map(m => m[1]);
  const rend = [...((html.match(/const RENDER = \{(.*)\};/) || [])[1] || '').matchAll(/(?:^|,)\s*([\w-]+):/g)].map(m => m[1]);
  for (const v of nav) assert.ok(secs.includes(v) && rend.includes(v), `page "${v}" has a nav button, a <section id="view-${v}"> and a RENDER entry`);
  for (const v of secs) assert.ok(nav.includes(v), `<section id="view-${v}"> has a nav button`);
  console.log(`page structure: ${scripts.length} inline script(s) parse; pages ${nav.join(', ')} each have a button, a section and a renderer`);
  // the Delivery/Visit schedule: beta until its owner says launch; its frame lives outside <main> (a frame inside a hidden
  // section has no size, and moving a loaded frame reloads it); the address and messages are the agreement with ba/index.html
  assert.match(markup, /<button[^>]*data-view="visits"[^>]*data-beta/, 'the Delivery/Visit schedule tab keeps data-beta until launch');
  assert.match(markup, /<\/main>\s*(?:<!--[\s\S]*?-->\s*)?<div id="vs-host"/, 'the schedule frame host sits right after </main>');
  assert.ok(!/<main[\s\S]*id="vs-host"[\s\S]*<\/main>/.test(markup), 'the schedule frame host is not inside <main>');
  assert.ok(html.includes(`'ba/index.html?embed=schedule&board=CA'`), 'the frame opens the BA app in schedule-only mode for the CA board');
  assert.ok(/source: 'pipeline', type/.test(html) && /d\.source !== 'ba-schedule'/.test(html) && /e\.origin !== location\.origin/.test(html),
    'the page speaks the agreed messages and checks where they come from');
  // the Week | Month toggle is drawn by the script (data-wkmode), never a static page button
  assert.ok(!/data-view="month"/.test(markup) && !/<section id="view-month"/.test(markup), 'the month view is a mode of the production schedule, not a page');
  // the Admin page: beta until its owner says launch, and hidden until pipeline_is_admin() says yes for this account
  assert.match(markup, /<button(?=[^>]*data-view="admin")(?=[^>]*data-beta)(?=[^>]*\shidden)[^>]*>/, 'the Admin tab keeps data-beta and starts hidden');
  assert.ok(/sb\.rpc\('pipeline_is_admin'\)/.test(html) && /btn\.hidden = !ok/.test(html), 'the Admin tab shows only when pipeline_is_admin() says yes');
  for (const fn of ['pipeline_admin_editors', 'pipeline_admin_settings', 'pipeline_admin_log_list', 'pipeline_admin_settings_set', 'pipeline_admin_editor_set',
    'pipeline_admin_editor_add', 'pipeline_admin_editor_remove', 'pipeline_sync_status', 'pipeline_sync_set'])
    assert.ok(html.includes(`sb.rpc('${fn}'`), `the Admin page calls ${fn}`);
  assert.ok(!/from\('pipeline_(editors|write_settings|admin_log|sync_settings|sync_state|sync_runs)'\)/.test(html),
    'the page never reads the editors, the switches, the admin log or the sync tables directly');
  // Add only adds: it calls pipeline_admin_editor_add, never the add-or-change pipeline_admin_editor_set
  const addFn = (html.match(/\nfunction adminAdd\(\) \{[\s\S]*?\n\}\n/) || [''])[0];
  assert.ok(addFn.includes("sb.rpc('pipeline_admin_editor_add'") && !addFn.includes('pipeline_admin_editor_set') && addFn.includes("'editor-exists'"),
    'Add calls pipeline_admin_editor_add and handles its "already on the list" refusal');
  // the live-sheet yes: sent only after a confirm, and asked again when the server says the page's switches were out of date
  const setFn = (html.match(/\nfunction adminSet\(patch, after\) \{[\s\S]*?\n\}\n/) || [''])[0];
  assert.ok(/ADMIN\.liveAsk\(s, patch\)/.test(setFn) && /p_live_ok: true/.test(setFn) && /hint === 'confirm-live'/.test(setFn) &&
    /sb\.rpc\('pipeline_admin_settings'\)/.test(setFn) && (setFn.match(/confirm\(/g) || []).length === 2,
    'a change that opens real writes asks first, and asks again on fresh switches when the server refuses it');
  // the server side of both: pipeline-admin.sql refuses without the yes, and Add refuses someone already listed
  const adminSql = readFileSync(new URL('../supabase/pipeline-admin.sql', import.meta.url), 'utf8');
  assert.match(adminSql, /p_live_ok\s+boolean default null\)/, 'pipeline_admin_settings_set takes p_live_ok');
  assert.match(adminSql, /drop function if exists public\.pipeline_admin_settings_set\(boolean, boolean, text, text\[\], text\[\], text\);/,
    'the old six-argument pipeline_admin_settings_set is dropped');
  assert.match(adminSql, /if v_now and not coalesce\(p_live_ok, false\)[\s\S]*?hint = 'confirm-live'/, 'the server refuses new real writes without the yes');
  assert.match(adminSql, /pipeline_admin_editor_add[\s\S]*?lock table public\.pipeline_editors[\s\S]*?hint = 'editor-exists'[\s\S]*?return public\.pipeline_admin_editor_set\(/,
    'pipeline_admin_editor_add refuses someone already listed, under the editors lock, before adding');
  assert.match(adminSql, /grant execute on function public\.pipeline_admin_editor_add\(text, text, boolean\) to authenticated;/);
  // a sync job's source id never reaches the page in full: the status gives only its last characters
  assert.ok(!/\.source_id\b/.test(html), 'the page never reads a sync source id');
}
const src = html.split('/* ===== PIPELINE PARSER START =====')[1].split('/* ===== PIPELINE PARSER END ===== */')[0];
const PIPE = new Function(`/*${src}; return PIPE;`)();
const supSrc = html.split('/* ===== SUPPLY PARSER START =====')[1].split('/* ===== SUPPLY PARSER END ===== */')[0];
const SUP = new Function('PIPE', `/*${supSrc}; return SUP;`)(PIPE);
const weekSrc = html.split('/* ===== WEEK MODEL START =====')[1].split('/* ===== WEEK MODEL END ===== */')[0];
const WEEK = new Function('PIPE', `/*${weekSrc}; return WEEK;`)(PIPE);
const batSrc = html.split('/* ===== BATCH MODEL START =====')[1].split('/* ===== BATCH MODEL END ===== */')[0];
const BAT = new Function(`/*${batSrc}; return BAT;`)();
const actSrc = html.split('/* ===== ACTUALS MODEL START =====')[1].split('/* ===== ACTUALS MODEL END ===== */')[0];
const ACT = new Function('PIPE', `/*${actSrc}; return ACT;`)(PIPE);
const trySrc = html.split('/* ===== TRIM YIELD MODEL START =====')[1].split('/* ===== TRIM YIELD MODEL END ===== */')[0];
const TRIMY = new Function('PIPE', `/*${trySrc}; return TRIMY;`)(PIPE);
// the edit model reads crew lines back with WEEK.parseCrew, which the page defines later in the same script
const editSrc = html.split('/* ===== EDIT MODEL START =====')[1].split('/* ===== EDIT MODEL END ===== */')[0];
const EDIT = new Function('PIPE', 'SUP', 'WEEK', `/*${editSrc}; return EDIT;`)(PIPE, SUP, WEEK);
const adminSrc = html.split('/* ===== ADMIN MODEL START =====')[1].split('/* ===== ADMIN MODEL END ===== */')[0];
const ADMIN = new Function(`/*${adminSrc}; return ADMIN;`)();
const args = process.argv.slice(2), realPipe = args.find(a => !a.startsWith('--')),
  realSup = (args.find(a => a.startsWith('--supply=')) || '').slice(9),
  realBat = (args.find(a => a.startsWith('--batches=')) || '').slice(10),
  realTasks = (args.find(a => a.startsWith('--tasks=')) || '').slice(8),
  realTrims = (args.find(a => a.startsWith('--trims=')) || '').slice(8),
  // read-only copies of the live sheet saved by the write-back research, outside the repo; skipped when missing
  liveDir = (args.find(a => a.startsWith('--live=')) || '').slice(7) || path.join(os.homedir(), 'ar-automation/docs/pipeline-writeback/research-scripts');

// one week band: 14 columns, a (task, detail) pair per day
const blank = () => Array(14).fill('');
const rows = [['WIZARD TREES PRODUTION PIPELINE ', ...Array(13).fill('')]];
const hdr = blank();
['OCTOBER, MONDAY 12TH', 'OCTOBER, TUESDAY 13TH', 'OCTOBER, WEDNESDAY 14TH (LORENZO OOO)', 'OCTOBER, THURSDAY 15TH',
  'OCTOBER, FRIDAY 16TH', 'OCTOBER, SATURDAY 17TH', 'OCTOBER,SUNDAY 18TH'].forEach((t, k) => { hdr[k * 2] = t; });
rows.push(hdr);
const put = (r, day, task, detail) => { while (rows.length <= r) rows.push(blank()); rows[r][day * 2] = task; rows[r][day * 2 + 1] = detail; };
// Monday: trim with room + strain list (lights), crew line, a preroll run with strain rows
put(2, 0, 'TRIM - JUSTIN', 'ROOM a @ 15TH - ');
put(3, 0, '', 'ZANGBANGER\t8\t\nM8\t8\nBLACK LIGHT #6\t 1/2');
put(4, 0, 'NOURI ON CALL FOR PORTAL WORK', '');
put(5, 0, 'PREROLLS- GRIND, PRODUCE, PACKAGE, ADD BATCH LABEL (ADD VERIFICATION STICKER)', '');
put(6, 0, 'BLUEBANGER', '5PK .7G -- 500');
put(7, 0, '', '1G PREROLL- 450');
put(8, 0, 'TIDE', '5PK .7G -- 700');
put(9, 0, '', '1G PREROLL- 700');
put(10, 0, 'STAGE NABIS FOR NOV DROP 1', '');
// Tuesday: jars run (two strains), staff off, testing with a drop
put(2, 1, 'LORENZO & JUSTIN  - OFF', '');
put(3, 1, 'SORT/PACKAGE TO JARS (ADD VERIFICATION STICKER): BLACK MAGIC', '10 LBS- 3.5G (4-5 NUG MAX)');
put(4, 1, '', '10 CASES OF 1.5G BAGS (1-2  NUG MAX)');
put(5, 1, 'SORT/PACKAGE TO JARS (ADD VERIFICATION STICKER): SMOOTHIE', '12 LBS- 3.5G (4-5 NUG MAX)');
put(6, 1, 'TESTING SCHEDULED FOR NOV DROP 1 -  BLUEBANGER, TIDEBANGER, BLACK MAGIC', '');
put(7, 1, 'NABISPICKUP - NOV DROP 1', '');
// Wednesday: harvest, supply, "drop off" is not a day off, bare strain rows under a task
put(2, 2, 'HARVEST @ 23rd- ROOM 1', '');
put(3, 2, 'PREROLL ORDER ARRIVES- ADD TO SUPPLY SHEET', '');
put(4, 2, 'STIIIZY DROP OFF @ 9AM', '');
put(5, 2, 'PUFFCON - PACKAGE & LABEL - 3.5g', '');
put(6, 2, 'RIPTIDE', '1 LB');
put(7, 2, 'RIPETIDE', '2 LBS');
// next week header so the band closes
const hdr2 = blank();
['OCTOBER, MONDAY 19TH', 'OCTOBER, TUESDAY 20TH', 'OCTOBER, WEDNESDAY 21ST', 'OCTOBER, THURSDAY 22ND',
  'OCTOBER, FRIDAY 23RD', 'OCTOBER, SATURDAY 24TH', 'OCTOBER,SUNDAY 25TH'].forEach((t, k) => { hdr2[k * 2] = t; });
rows.push(blank(), hdr2);
const csv = rows.map(r => r.map(c => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',')).join('\n');

const weeks = PIPE.parse(csv);
// every item keeps the sheet cells it came from (row, column of the export), so the sheet's red marks can be tied back
{
  const mon = weeks[0].days[0].items;
  const trim = mon.find(i => i.type === 'trim'), pre = mon.find(i => i.type === 'prerolls');
  assert.deepEqual(trim.raw[0].at, [[2, 0], [2, 1], [3, 1]], 'the trim title cell and its two detail cells');
  assert.deepEqual(pre.raw[0].at, [[5, 0]], 'the pre-roll instruction row');
  assert.deepEqual(pre.lines.find(l => l.strain === 'TIDE' && l.size === '5pk').at, [[8, 0], [8, 1], [9, 1]], 'a strain line keeps its strain row');
  // and, for editing, the one cell its amount was read from, and every item its title cell
  assert.deepEqual(pre.lines.map(l => l.cell), [[6, 1], [7, 1], [8, 1], [9, 1]], 'each pre-roll line keeps the cell its amount is in');
  assert.deepEqual([trim.cell, pre.cell, mon.find(i => i.type === 'crew').cell], [[2, 0], [5, 0], [4, 0]], 'an item keeps its title cell');
  const jr = weeks[0].days[1].items.find(i => i.type === 'jars');
  assert.deepEqual([jr.cell, jr.lines.map(l => l.cell)], [null, [[3, 2], [5, 2]]], 'a jar run has no title cell of its own; each jar line keeps the cell naming its strain');
  assert.deepEqual(weeks.map(x => [x.headRow, x.lastRow]), [[1, 11], [12, 12]], 'each week keeps its header row and last row');
}
assert.equal(weeks.length, 2, 'two week bands');
const [w] = weeks;
assert.equal(w.start, '2026-10-12');
assert.deepEqual(w.days.map(d => d.date), ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
assert.equal(w.days[2].note, 'LORENZO OOO');

const mon = w.days[0].items, tue = w.days[1].items, wed = w.days[2].items;
const trim = mon.find(i => i.type === 'trim');
assert.equal(trim.crew, 'JUSTIN');
assert.equal(trim.room, 'A'); assert.equal(trim.site, '15TH');
assert.deepEqual(trim.strains, [{ strain: 'ZANGBANGER', n: 8 }, { strain: 'M8', n: 8 }, { strain: 'BLACK LIGHT #6', n: 0.5 }]);
assert.ok(mon.some(i => i.type === 'crew' && /ON CALL/.test(i.title)));
const pre = mon.find(i => i.type === 'prerolls');
assert.deepEqual(pre.lines.map(l => [l.strain, l.size, l.n]),
  [['BLUEBANGER', '5pk', 500], ['BLUEBANGER', '1g', 450], ['TIDE', '5pk', 700], ['TIDE', '1g', 700]]);
const stage = mon.find(i => i.type === 'orders');
assert.equal(stage.drop, 'NOV DROP 1');

assert.equal(tue[0].type, 'crew', 'LORENZO & JUSTIN - OFF is a crew line');
const jars = tue.find(i => i.type === 'jars');
assert.equal(jars.note, 'ADD VERIFICATION STICKER');
assert.deepEqual(jars.lines.map(l => [l.strain, l.lbs, l.size, l.cases, l.caseSize]),
  [['BLACK MAGIC', 10, '3.5g', 10, '1.5g'], ['SMOOTHIE', 12, '3.5g', null, '']]);
const test = tue.find(i => i.type === 'testing');
assert.equal(test.drop, 'NOV DROP 1');
assert.deepEqual(test.strains.map(s => s.strain), ['BLUEBANGER', 'TIDEBANGER', 'BLACK MAGIC']);
assert.ok(tue.some(i => i.type === 'orders' && i.drop === 'NOV DROP 1'), 'pickup names the drop');

const hv = wed.find(i => i.type === 'harvest');
assert.equal(hv.room, '1'); assert.equal(hv.site, '23RD');
assert.ok(wed.some(i => i.type === 'supply'));
assert.equal(wed.find(i => /STIIIZY/.test(i.title)).type, 'orders', 'a drop off is not a day off');
const puff = wed.find(i => /PUFFCON/.test(i.title));
assert.deepEqual(puff.sub, [{ strain: 'RIPTIDE', text: '1 LB' }, { strain: 'RIPTIDE', text: '2 LBS' }], 'strain rows fold into the task, typo alias applies');

// helpers
assert.deepEqual(PIPE.prerollQtys('5PK- 128 UNITS\n1G- 1362 UNITS'), [{ size: '5pk', n: 128, note: '' }, { size: '1g', n: 1362, note: '' }]);
assert.equal(PIPE.dropName('STAGE NABIS PICK UP FOR NOV PREROLL DROP'), 'NOV PREROLL DROP');
assert.equal(PIPE.strainKey('Zanganger'), 'ZANGBANGER');

// year rollover: December -> January
const roll = PIPE.parse('"DECEMBER, MONDAY 28TH",,TUESDAY 29TH,,WEDNESDAY 30TH,,THURSDAY 31ST,,JANUARY FRIDAY 1ST,,SATURDAY 2ND,,SUNDAY 3RD,\n' +
  '"JANUARY, MONDAY 4TH",,TUESDAY 5TH,,WEDNESDAY 6TH,,THURSDAY 7TH,,FRIDAY 8TH,,SATURDAY 9TH,,SUNDAY 10TH,');
assert.deepEqual(roll.map(x => x.start), ['2026-12-28', '2027-01-04']);

// supplies: header row found by name, site columns between PAR and Vendor, empty formula rows skipped
const supCsv = [
  'Column 1,ITEM,TOTAL QTY,STATUS,PAR ,23RD,25TH,PORTAL,VOID,Vendor ,NOTES',
  'Jar - 3.5g,JAR,53400,IN STOCK,"20,000",50352,3048,,,ZACK  - CHINA,50K JAR ORDER COMING',
  'Black Light - 3.5g - Label,LABEL,1200,IN STOCK,"5,000",,"1,200",,,CGA ,',
  'Zoza - 1.5g - Preroll Jar,PRE-LABELED JAR,2000,NOT REORDERING,3500,1600,400,,,ZACK  - CHINA,NO RE ORDER',
  'Preroll Papers - 1g,PREROLL,0,OOS,5000,0,0,,,ZACK  - CHINA,',
  'Lid - 1g,LIDS,40,Running Low,0,,40,,,,',
  'Smoothie - Bundle (10ct Box),BUNDLE,0,IN STOCK,,,,,6(1.5 LBS),,2 1/2 lbs per 10ct ',
  ',,0,,,,,,,,',
  ',,0,,,,,,,,',
].join('\n');
const sp = SUP.parse(supCsv, 'DISTRO SUPPLY');
assert.deepEqual(sp.sites, ['23RD', '25TH', 'PORTAL', 'VOID']);
assert.equal(sp.items.length, 6, 'empty formula rows are skipped');
const [jar, bl, zoza, papers, lid, bundle] = sp.items;
assert.deepEqual([jar.total, jar.par, jar.status, jar.at, jar.below, jar.row], [53400, 20000, 'IN STOCK', { '23RD': 50352, '25TH': 3048 }, false, 2]);
assert.equal(jar.vendor, 'ZACK - CHINA');
assert.deepEqual([bl.at['25TH'], bl.below], [1200, true], 'comma numbers parse; total under par is flagged');
assert.equal(zoza.below, false, 'an item no longer reordered is not flagged below par');
assert.deepEqual([papers.status, papers.below, papers.total], ['OOS', true, 0]);
assert.deepEqual([lid.cat, lid.status, lid.below], ['LID', 'RUNNING LOW', false], 'category alias; status normalised; PAR 0 = no par');
assert.deepEqual([bundle.at.VOID, bundle.raw.VOID, bundle.total, bundle.sum], [6, '6(1.5 LBS)', 0, 0], 'a text cell keeps its words');
const acc = SUP.parse('Column 1,ITEM,TOTAL QTY,STATUS,PAR ,23RD,25TH,PORTAL,MYLARS,Vendor ,NOTES\nWizzy Lego,ACCESSORY,1560,IN STOCK,,,,1560,,,', 'ACCESSORY SUPPLY');
assert.deepEqual([acc.sites[3], acc.items[0].par, acc.items[0].below], ['MYLARS', null, false]);
assert.equal(SUP.parse('nothing,here\n1,2', 'X'), null, 'a tab without the header row is refused');
// for editing: each item's row (0-based), the column of each header, its ITEM cell as written; the tab's headers as written
assert.deepEqual([jar.r, jar.cols['23RD'], jar.cols.PAR, jar.cols.NOTES, jar.catText, lid.catText], [1, 5, 4, 10, 'JAR', 'LIDS']);
assert.deepEqual([sp.headRow, sp.headers[4], sp.grid[1][0]], [0, 'PAR ', 'Jar - 3.5g']);

// ---------------- Week board model ----------------
// parser fixes: "5PK .7G PREROLL- 700", and "PREROLLS- ...: SMOOTHIE" naming the strain its lines are for
assert.deepEqual(PIPE.prerollQtys('5PK .7G PREROLL- 700'), [{ size: '5pk', n: 700, note: '' }]);
{
  const [it] = PIPE.structure([{ title: 'PREROLLS- GRIND, PRODUCE, PACKAGE (ADD VERIFICATION STICKER): SMOOTHIE', details: ['1G PREROLL- 500', '5PK .7G PREROLL- 700'] }]);
  assert.deepEqual(it.lines.map(l => [l.strain, l.size, l.n]), [['SMOOTHIE', '1g', 500], ['SMOOTHIE', '5pk', 700]]);
  const [j] = PIPE.structure([{ title: 'SORT/PACKAGE TO JARS (ADD VERIFICATION STICKER): TIDE', details: ['10 LBS- 3.5G (4-5 NUG MAX)'] }]);
  assert.equal(j.lines[0].lbsNote, '4-5 NUG MAX', 'jar notes are kept');
}

// crew lines -> one status per person
const crew = t => { const r = WEEK.parseCrew(t); return [Object.entries(r.people).map(([n, v]) => `${n} ${v.st}${v.note ? ' (' + v.note + ')' : ''}`).sort().join(', '), r.flag, r.unparsed]; };
assert.deepEqual(crew('LORENZO @ DISTRO'), ['LORENZO DISTRO', '', false]);
assert.deepEqual(crew('NOURI ON CALL FOR PORTAL WORK'), ['NOURI ON CALL (PORTAL WORK)', '', false]);
assert.deepEqual(crew('JUSTIN OFF / LORENZO OFF // DREA DISTRO LEAD'), ['DREA LEAD, JUSTIN OFF, LORENZO OFF', '', false]);
assert.deepEqual(crew('LORENZO OFF // JUSTIN DISTRO LEAD'), ['JUSTIN LEAD, LORENZO OFF', '', false]);
assert.deepEqual(crew('DISTRO OFF'), ['', 'DISTRO OFF', false]);
assert.deepEqual(crew('JUSTIN / DISTRO OFF'), ['JUSTIN OFF', 'DISTRO OFF', false]);
assert.deepEqual(crew('LORENZO / JUSTIN DISTRO'), ['JUSTIN DISTRO, LORENZO DISTRO', '', false]);
assert.deepEqual(crew('JUSTIN/NOURI/LORENZO OFF'), ['JUSTIN OFF, LORENZO OFF, NOURI OFF', '', false]);
assert.deepEqual(crew('LOREZNO & JUSTIN DISTRO'), ['JUSTIN DISTRO, LORENZO DISTRO', '', false]);
assert.deepEqual(crew('NO DISTRO WORK'), ['', 'NO DISTRO WORK', false]);
assert.deepEqual(crew('JUSTIN @ TRIM / LORENZO @ DISTRO'), ['JUSTIN TRIM, LORENZO DISTRO', '', false]);
assert.deepEqual(crew('LORENZO @ DISTRO w/ DREA, JORGE, THANH?'), ['DREA DISTRO, JORGE DISTRO, LORENZO DISTRO, THANH DISTRO', '', false]);
assert.deepEqual(crew('CARLOS OOO'), ['CARLOS OOO', '', false]);
assert.equal(WEEK.parseCrew('VIC - NY').unparsed, true, 'unknown wording is shown as written');
assert.deepEqual(crew('NO DISTRO WORK - JUSTIN / NOURI OFF'), ['JUSTIN OFF, NOURI OFF', 'NO DISTRO WORK', false], 'names after the team phrase take the next status');
assert.deepEqual(crew('NOURI OFF - CC & JUSTIN ON SCHEDULE'), ['NOURI OFF', '', true], 'a name is not a note; the line is shown as written');
assert.deepEqual(crew('THANKSGIVING - DISTRO OFF'), ['', 'DISTRO OFF', true], 'a holiday is not a person');
assert.equal(WEEK.parseCrew('CC ON CALL FOR PORTAL/DISTRO WORK IF NEED').unparsed, true, 'a status for nobody keeps the line visible');
// light counts stand apart from names; a number after a cross "x" is a pheno
assert.deepEqual(PIPE.parseStrainLines('(phenos) ZOZA x 2424\n2424 - 7 lights\nM8\n2424 x 2424 #2,9,26').map(l => l.n), [null, 7, null, null]);
// headlines lose dangling punctuation
assert.notEqual(WEEK.headline(PIPE.structure([{ title: 'NOURI & JUSTIN PRINT 3.5G  LABELS FOR PREROLLS, 3.5G & 1.5G BUDTENDER SAMPS', details: [] }])[0]).head.slice(-1), ',');
// testing keeps the sheet's words the parser could not place
{
  const it = PIPE.structure([{ title: 'TESTING SCHEDULED FOR 7 STRAINS :DARK MATTER, ZANGBANGER, LIMELIGHT, JUNGLE JUICE (TOAD VENOM) -- RUSH TESTING', details: [] }])[0];
  const M1 = WEEK.buildModel([{ start: '2026-03-23', days: [0, 1, 2, 3, 4, 5, 6].map(k => ({ date: PIPE.addDays('2026-03-23', k), dow: k, note: '', items: k ? [] : [it] })) }]);
  const card = WEEK.dayBoard(M1, '2026-03-23', { drops: new Map() }).cards[0];
  assert.ok(JSON.stringify(card).includes('RUSH TESTING'), 'RUSH TESTING is not dropped');
}
{
  const d = WEEK.crewDay({ note: 'LORENZO OOO', items: [{ type: 'crew', title: 'JUSTIN/NOURI/LORENZO OFF' }] });
  assert.deepEqual([d.people.LORENZO.st, d.people.JUSTIN.st, d.people.NOURI.st, d.flag], ['OOO', 'OFF', 'OFF', 'DISTRO OFF'], 'OOO beats OFF; all core crew off = distro off');
}

// headlines: the short bold line a bar leads with
const hl = (title, drop) => WEEK.headline(Object.assign(PIPE.structure([{ title, details: [] }])[0], drop ? { drop } : {}));
assert.deepEqual([hl('PREROLLS- GRIND, PRODUCE, PACKAGE, ADD BATCH LABEL (ADD VERIFICATION STICKER)').head, hl('PREROLLS- GRIND, PRODUCE, PACKAGE, ADD BATCH LABEL (ADD VERIFICATION STICKER)').detail],
  ['GRIND, PRODUCE, PACKAGE', ['ADD BATCH LABEL', 'ADD VERIFICATION STICKER']]);
assert.equal(hl('FINISH 5PK PREROLLS').head, 'FINISH 5-PACK PRE-ROLLS');
{
  const t = hl('TBD TESTING SCHEDULED FOR NOV DROP 2 -  ZANGBANGER, VOODOO, TEA PARTY (2 FACILITIES, 2 CHAIN OF CUSTODIES)');
  assert.deepEqual([t.head, t.tbd], ['TESTING SCHEDULED · NOV DROP 2', true]);
}
assert.deepEqual([hl('FINISH PREROLLS FOR TESTING !!!').head, hl('FINISH PREROLLS FOR TESTING !!!').urgent], ['FINISH PRE-ROLLS FOR TESTING', true]);
assert.equal(hl('NABISPICKUP - NOV DROP 1').head, 'NABIS PICKUP · NOV DROP 1');
assert.equal(hl('STAGE NABIS FOR NOV DROP 1').head, 'STAGE NABIS · NOV DROP 1');
assert.equal(hl('DCR - INSPECTION @ 25TH').head, 'DCR - INSPECTION @ 25TH', 'a one-word left part is not cut');
assert.equal(hl('#36 THE VOID - FINISH STICKERING GAS GIMLET').head, '#36 THE VOID');

// a made-up week shaped like the sheet's Oct 12 band: repeats on several days must become one bar each
{
  const rows2 = [blank()], hdrW = blank();
  ['OCTOBER, MONDAY 12TH', 'OCTOBER, TUESDAY 13TH', 'OCTOBER, WEDNESDAY 14TH', 'OCTOBER, THURSDAY 15TH', 'OCTOBER, FRIDAY 16TH',
    'OCTOBER, SATURDAY 17TH', 'OCTOBER,SUNDAY 18TH'].forEach((t, k) => { hdrW[k * 2] = t; });
  rows2.push(hdrW);
  const at = (r, day, task, detail) => { while (rows2.length <= r) rows2.push(blank()); rows2[r][day * 2] = task; rows2[r][day * 2 + 1] = detail; };
  const room2 = 'RIPTIDE 5.5\nKINGTIDE 1.5\nTIDEBANGER 3.5';
  at(2, 0, 'TRIM - JUSTIN', 'ROOM a @ 15TH - '); at(3, 0, '', 'ZANGBANGER 8\nM8 8');
  at(4, 0, 'NOURI ON CALL FOR PORTAL WORK', '');
  at(5, 0, 'PREROLLS- GRIND, PRODUCE, PACKAGE, ADD BATCH LABEL (ADD VERIFICATION STICKER)', '');
  at(6, 0, 'BLUEBANGER', '5PK .7G -- 500'); at(7, 0, '', '1G PREROLL- 450');
  at(8, 0, 'TIDE', '5PK .7G -- 700'); at(9, 0, '', '1G PREROLL- 700');
  at(10, 0, 'PICK SELF DISTRO ORDERS', '');
  at(2, 1, 'JUSTIN OFF / LORENZO OFF // DREA DISTRO LEAD', '');
  at(3, 1, 'TIDE', '5PK .7G -- 700'); at(4, 1, '', '1G PREROLL- 700');
  at(5, 1, 'WIZZY', '5PK .7G -- 600');
  at(6, 1, 'PICK SELF DISTRO ORDERS', '');
  at(2, 2, 'BLUEBANGER', '5PK .7G -- 500'); at(3, 2, '', '1G PREROLL- 450');
  at(4, 2, 'TIDE', '5PK .7G -- 700'); at(5, 2, '', '1G PREROLL- 700');
  at(6, 2, 'NABIS PICKUP', '');
  at(2, 3, 'TRIM - JUSTIN', 'ROOM 2 @ 25TH - '); at(3, 3, '', room2);
  at(4, 3, 'PREROLLS- GRIND, PRODUCE, PACKAGE, ADD BATCH LABEL (ADD VERIFICATION STICKER)', '');
  at(2, 4, 'TRIM - JUSTIN', 'ROOM 2 @ 25TH - '); at(3, 4, '', room2);
  at(4, 4, 'FINISH 5PK PREROLLS', '');
  at(5, 4, 'BLUEBANGER', '5PK .7G -- 500'); at(6, 4, '', '1G PREROLL- 450');
  at(7, 4, 'TBD TESTING SCHEDULED FOR NOV DROP 2 -  ZANGBANGER, VOODOO', '');
  at(2, 5, 'DISTRO OFF', ''); at(3, 5, 'TRIM - JUSTIN', 'ROOM 2 @ 25TH - '); at(4, 5, '', room2);
  at(2, 6, 'JUSTIN / DISTRO OFF', '');
  const toCsv = rs => rs.map(r => r.map(c => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',')).join('\n');
  const wks = PIPE.parse(toCsv(rows2));
  const M = WEEK.buildModel(wks);
  const B = WEEK.buildBoard(M, '2026-10-12', { today: '2026-10-15', summary: WEEK.summarize(wks[0]), drops: new Map() });
  const lane = id => B.lanes.find(l => l.id === id);
  const span = b => b.a === b.b ? WEEK.DOWS[b.a] : `${WEEK.DOWS[b.a]}-${WEEK.DOWS[b.b]}`;
  const rowSpans = (id, key) => lane(id).rows.find(r => r.key === key).tracks.flat().map(span).join(' ');
  assert.equal(rowSpans('trim', '15TH|A'), 'MON');
  assert.equal(rowSpans('trim', '25TH|2'), 'THU-SAT', 'a room trimmed three days running is one bar');
  assert.equal(lane('trim').total, '2 rooms · 26.5 lights');
  assert.deepEqual(lane('prerolls').headTracks.flat().map(b => `${span(b)} ${b.head}`), ['MON-THU GRIND, PRODUCE, PACKAGE', 'FRI FINISH 5-PACK PRE-ROLLS'],
    'strain-only days take the instruction from Monday');
  assert.equal(rowSpans('prerolls', 'TIDE'), 'MON-WED');
  assert.equal(rowSpans('prerolls', 'BLUEBANGER'), 'MON WED FRI', 'a gap shows as separate blocks');
  assert.equal(rowSpans('prerolls', 'WIZZY'), 'TUE');
  const nl = id => lane('prerolls').rows.find(r => r.key === id).notListed;
  assert.deepEqual([nl('BLUEBANGER'), nl('TIDE'), nl('WIZZY')], [[3], [3], []], 'Thursday lists no strains: hatch only the strains listed next to it');
  assert.equal(lane('prerolls').total, '3 strains listed · 1,800 5-packs · 1,150 1g');
  assert.deepEqual(lane('orders').headTracks.flat().map(b => `${span(b)} ${b.head}`), ['MON-TUE PICK SELF DISTRO ORDERS', 'WED NABIS PICKUP']);
  const t = lane('testing').headTracks.flat()[0];
  assert.deepEqual([span(t), t.head, t.tbd], ['FRI', 'TESTING SCHEDULED · NOV DROP 2', true]);
  const justin = lane('crew').rows.find(r => r.key === 'JUSTIN').tracks.map(tr => tr.map(b => `${span(b)} ${b.head}`).join(' | '));
  assert.deepEqual(justin, ['TUE OFF | SUN OFF', 'MON TRIM ROOM A @ 15TH | THU-SAT TRIM ROOM 2 @ 25TH']);
  assert.deepEqual(B.days.map(d => d.flag), ['', '', '', '', '', 'DISTRO OFF', 'DISTRO OFF']);
  assert.deepEqual(B.days.map(d => d.tasks), [3, 2, 2, 2, 3, 1, 0], 'strain rows fold into one pre-roll task per day');
  // the day view
  const tue = WEEK.dayBoard(M, '2026-10-13', { drops: new Map() }).cards.find(c => c.lane === 'prerolls');
  assert.deepEqual(tue.changes.map(c => `${c.kind} ${c.strain}`), ['add WIZZY', 'gone BLUEBANGER']);
  assert.equal(tue.inheritedFrom, '2026-10-12');
  assert.deepEqual(tue.table.total, { '5pk': 1300, '1g': 700 });
  const thu = WEEK.dayBoard(M, '2026-10-15', { drops: new Map() });
  const thuPre = thu.cards.find(c => c.lane === 'prerolls');
  assert.deepEqual([thuPre.n, thuPre.m, thuPre.borrowedFrom], [4, 5, '2026-10-14'], 'no list on Thursday: show Wednesday\'s, labelled');
  const thuTrim = thu.cards.find(c => c.lane === 'trim');
  assert.deepEqual([thuTrim.n, thuTrim.m, thuTrim.range], [1, 3, 'THU – SAT']);
}

// the lane buttons (beta): what a link's &lanes= opens, and what a press does
{
  assert.deepEqual(WEEK.pickLanes('prerolls,jars,bogus,jars'), ['jars', 'prerolls'], 'board order, no repeats, unknown names dropped');
  assert.deepEqual(WEEK.pickLanes(' Testing , ORDERS'), ['testing', 'orders']);
  assert.deepEqual(WEEK.pickLanes(''), [], 'none picked: everything shows');
  assert.deepEqual(WEEK.pickLanes(null), []);
  assert.deepEqual(WEEK.pickLanes(WEEK.LANES.join(',')), [], 'every lane picked is the same as none');
  assert.deepEqual(WEEK.toggleLane([], 'testing'), ['testing']);
  assert.deepEqual(WEEK.toggleLane(['testing'], 'jars'), ['jars', 'testing']);
  assert.deepEqual(WEEK.toggleLane(['jars', 'testing'], 'jars'), ['testing']);
  assert.deepEqual(WEEK.toggleLane(['testing'], 'testing'), [], 'the last one off shows everything again');
  assert.deepEqual(WEEK.toggleLane(WEEK.LANES.filter(l => l !== 'crew'), 'crew'), [], 'pressing the last lane left is everything');
  assert.ok(WEEK.LANES.every(l => WEEK.laneShown([], l)), 'nothing picked shows every lane');
  assert.ok(WEEK.laneShown(['supplies'], 'supply') && WEEK.laneShown(['supplies'], 'labels') && WEEK.laneShown(['supplies'], 'other'),
    'supply, labels and other items sit in Supplies & other');
  assert.ok(WEEK.laneShown(['jars'], 'jars') && !WEEK.laneShown(['jars'], 'prerolls') && !WEEK.laneShown(['jars'], 'crew'));
}

// the month view (beta): a month's week rows, Monday first, and moving by months
{
  assert.deepEqual(WEEK.monthWeeks('2026-11'), ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'],
    'Nov 1 2026 is a Sunday and Nov 30 a Monday: six rows');
  assert.deepEqual(WEEK.monthWeeks('2027-02'), ['2027-02-01', '2027-02-08', '2027-02-15', '2027-02-22'], 'Feb 2027 starts on a Monday and fills four rows');
  assert.deepEqual(WEEK.monthWeeks('2026-12'), ['2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21', '2026-12-28']);
  for (const ym of ['2026-01', '2026-02', '2026-05', '2026-08', '2026-10', '2027-03', '2028-02']) {
    const ws = WEEK.monthWeeks(ym);
    assert.ok(ws.length >= 4 && ws.length <= 6 && ws.every(w => WEEK.dowIdx(w) === 0), `${ym}: 4 to 6 Mondays`);
    const [y, m] = ym.split('-').map(Number), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const covered = ws.flatMap(w => Array.from({ length: 7 }, (_, k) => PIPE.addDays(w, k))).filter(d => d.startsWith(ym));
    assert.equal(covered.length, days, `${ym}: every day of the month is in exactly one row`);
  }
  assert.deepEqual([WEEK.monthWeeks('2026-13'), WEEK.monthWeeks(''), WEEK.monthWeeks('Nov')], [[], [], []], 'a bad month gives no rows');
  assert.deepEqual([WEEK.addMonths('2026-11', 1), WEEK.addMonths('2026-12', 1), WEEK.addMonths('2027-01', -1), WEEK.addMonths('2026-11', -12)],
    ['2026-12', '2027-01', '2026-12', '2025-11']);
  // a month row is the board's own week: a run that crosses Sunday continues on the next row
  const rows3 = [blank()], hd = blank();
  ['OCTOBER, MONDAY 26TH', 'OCTOBER, TUESDAY 27TH', 'OCTOBER, WEDNESDAY 28TH', 'OCTOBER, THURSDAY 29TH', 'OCTOBER, FRIDAY 30TH',
    'OCTOBER, SATURDAY 31ST', 'NOVEMBER, SUNDAY 1ST'].forEach((t, k) => { hd[k * 2] = t; });
  rows3.push(hd);
  const hd2 = blank();
  ['NOVEMBER, MONDAY 2ND', 'NOVEMBER, TUESDAY 3RD', 'NOVEMBER, WEDNESDAY 4TH', 'NOVEMBER, THURSDAY 5TH', 'NOVEMBER, FRIDAY 6TH',
    'NOVEMBER, SATURDAY 7TH', 'NOVEMBER, SUNDAY 8TH'].forEach((t, k) => { hd2[k * 2] = t; });
  const at3 = (r, day, task, detail) => { while (rows3.length <= r) rows3.push(blank()); rows3[r][day * 2] = task; rows3[r][day * 2 + 1] = detail; };
  at3(2, 5, 'TESTING SCHEDULED FOR NOV DROP 1 - BLUEBANGER', ''); at3(2, 6, 'TESTING SCHEDULED FOR NOV DROP 1 - BLUEBANGER', '');
  rows3.push(blank(), hd2);
  const r2 = rows3.length;
  at3(r2, 0, 'TESTING SCHEDULED FOR NOV DROP 1 - BLUEBANGER', '');
  const toCsv3 = rs => rs.map(r => r.map(c => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',')).join('\n');
  const wks3 = PIPE.parse(toCsv3(rows3));
  assert.deepEqual(wks3.map(w => w.start), ['2026-10-26', '2026-11-02']);
  const M3 = WEEK.buildModel(wks3);
  const [row1, row2] = WEEK.monthWeeks('2026-11').slice(0, 2).map(ws => WEEK.buildBoard(M3, ws, { today: '2026-11-10', summary: { jars: [], pre: [] }, drops: new Map() }));
  const t1 = row1.lanes.find(l => l.id === 'testing').headTracks.flat()[0], t2 = row2.lanes.find(l => l.id === 'testing').headTracks.flat()[0];
  assert.deepEqual([t1.a, t1.b, t1.contL, t1.contR, t2.a, t2.b, t2.contL, t2.contR], [5, 6, false, true, 0, 0, true, false],
    'Sat-Mon testing: Sat-Sun on the first row, carried on to Monday on the next');
  console.log('lane buttons and month view: &lanes= reads in board order, presses toggle, every month has 4 to 6 Monday rows, runs carry across rows');
}

// the Batches view: batch codes, statuses, item names and grouping, as the Batch Label Sheet writes them
{
  const dc = c => { const d = BAT.decode(c); return [d.room, d.site, d.harvest].join(' '); };
  assert.equal(dc('F2-BM-9126-S'), 'F2 23RD 2026-09-01');
  assert.equal(dc('FA-Z-10226-I'), 'FA 15TH ', '10226 reads as 10/2 or 1/02: no harvest guessed');
  assert.equal(dc('F1-BB-92226-S'), 'F1 23RD 2026-09-22');
  assert.equal(dc('V-92226-S-5PK'), ' 23RD 2026-09-22', 'a code that starts with the strain has no room');
  assert.equal(dc('B- LL-31726-I'), 'B 15TH 2026-03-17');
  assert.equal(dc('A-A-8426-I'), 'A 15TH 2026-08-04', 'room A, strain A (Antidote)');
  assert.equal(dc('F1-82426-A-F'), 'F1 25TH 2026-08-24', 'strain after the date; the last site letter wins');
  assert.equal(dc('F1-BL-42026.7-F'), 'F1 25TH 2026-04-20');
  assert.equal(dc('F2-BM-92826-O'), 'F2 OLYMPIC 2026-09-28');
  assert.equal(dc('F3-ZB-10232025'), 'F3  2025-10-23', 'old MMDDYYYY codes carry no site');
  assert.equal(dc('F1-121725ZB'), 'F1  ', 'digits run into letters: nothing read');
  assert.equal(dc(''), '  ');
  assert.equal(BAT.codeDate('242026'), null, 'a typo date is not guessed');

  assert.deepEqual(['PACKAGING', 'Awaiting pkg / labeling', 'waiting on coa', 'WAITING FOR TESTING ', 'Failed testing', 'DONE', 'QA HOLD', '']
    .map(BAT.statusKey), ['PACKAGING', 'AWAITING PKG/LABELING', 'WAITING FOR COA', 'WAITING FOR TESTING', 'FAILED TESTING', 'DONE', 'QA HOLD', '']);
  assert.equal(BAT.info('QA HOLD').label, 'Qa hold');
  assert.deepEqual(['FLOWER', '5PK', '1G', '1.0G PREROLL', '1.5g prerolls', '.7g prerolls', 'Infused cone'].map(BAT.itemLabel),
    ['Flower', '5-pack', '1g pre-roll', '1g pre-roll', '1.5g pre-rolls', '0.7g pre-rolls', 'Infused cone']);

  const row = (sheet_row, status, extra = {}) => ({ sheet_row, status, finished: false, strain: 'TIDE', ...extra });
  const g = BAT.groups([
    row(3, 'WAITING FOR TESTING'), row(4, 'WAITING FOR TESTING'), row(14, 'AWAITING PKG/LABELING'), row(24, 'NOT STARTED'),
    row(30, 'PACKAGING'), row(31, 'PACKAGING'), row(23, 'LABELING BATCH INFO'), row(33, 'DONE'), row(35, 'QA HOLD'),
    row(234, 'DONE', { finished: true, package_date: '2026-10-02' }), row(238, 'DONE', { finished: true, package_date: '2026-10-02' }),
    row(220, 'FAILED TESTING', { finished: true, nabis_date: '2026-09-28' }), row(150, 'DONE', { finished: true, coa_date: '2026-10-05' }),
  ]);
  assert.deepEqual(g.map(x => `${x.label} ${x.rows.map(r => r.sheet_row).join(',')}`), [
    'Packaging 30,31', 'Labeling batch info 23', 'Awaiting packaging & labeling 14', 'Qa hold 35',
    'Waiting for testing 3,4', 'Not started 24', 'Finished 33,150,238,234,220'],
    'work in progress first, sheet order inside a group; DONE above the divider leads Finished; then newest first');
  assert.equal(BAT.lastDate({ harvest_date: '2026-08-03', package_date: '2026-09-15', nabis_date: '2026-09-30' }), '2026-09-30');
}

// plan vs actual: tracker task names and units, runs from the sheet, the batch sheet matched to runs
{
  const k = t => { const x = ACT.taskKind(t); return [x.prod, x.step, x.market].join(' '); };
  assert.equal(k('5pk (.7g) pre-roll produced(rec)'), '5pk made rec');
  assert.equal(k('5pk (.7g) pre-roll labeled (post COA)(rec)'), '5pk label2 rec');
  assert.equal(k('1g pre-roll labeled (pre COA)(rec)'), '1g label1 rec');
  assert.equal(k('1.5g pre-roll produced (rec)'), '1.5g made rec');
  assert.equal(k('1.5g budtender samples (packaged)(rec)'), 'bud made rec');
  assert.equal(k('3.5g jar packed (rec)'), 'jar made rec');
  assert.equal(k('3.5g jar labeled (void)'), 'jar label void');
  assert.equal(k('3.5g pouch prepped (void)'), 'pouch prep void');
  assert.equal(k('General packaging activities'), '  rec');
  assert.equal(ACT.taskKind('Lunch').rest, true);
  assert.equal(ACT.taskKind('Breaking down 18 Pallets').rest, false, 'breaking down pallets is work, not a break');
  assert.equal(ACT.units({ packaged: 800, labeled: 0 }, 'label'), 800, 'a count typed in the other column still counts');
  assert.equal(ACT.units({ packaged: 128, labeled: 128 }, 'made'), 128);
  const days = ACT.byDay([
    { work_date: '2026-10-14', task: '5pk (.7g) pre-roll produced(rec)', people: 8, hours: 8.15, packaged: 3400, labeled: 0, begin_at: '08:00:00' },
    { work_date: '2026-10-14', task: '5pk (.7g) pre-roll produced(rec)', people: 2, hours: 1, packaged: 3, labeled: 0, begin_at: '16:10:00' },
    { work_date: '2026-10-14', task: 'Lunch', people: 8, hours: 0.5, packaged: 0, labeled: 0, begin_at: '12:00:00' }]);
  const d = days.get('2026-10-14'), p = d.prods['5pk'];
  assert.deepEqual([p.sticks, p.made, Math.round(p.madePh * 10) / 10], [3403, 680.6, 67.2], '5-pack sticks are added first, then divided by 5');
  assert.equal(Math.round(d.ph * 10) / 10, 67.2, 'a lunch row stays out of the day\'s person-hours');

  assert.deepEqual(['PREROLLS FOR CARLOS- GRIND', 'FINISH PREROLLS FOR CARLOS / REC', 'MAKE PREROLLS FOR EVENT  - CUSTOM LABELS',
    'MAKE 200 TIDEBANGER PREOLLS FOR TORCHES PARTY', 'MAKE PREROLLS FOR CA- 1G PREROLLS', 'FINISH PREROLLS FOR REC',
    'PREROLLS- START GRINDING FOR PREROLLS', 'PREROLLS- GRIND, PRODUCE, PACKAGE', 'TESTING SCHEDULED FOR NOV DROP 1'].map(ACT.jobOf),
    ['CARLOS', 'CARLOS', 'EVENT', 'TORCHES PARTY', '', '', '', '', '']);

  // runs: a weekend gap joins when the list carries on; a new jar list a weekend later is its own run; side jobs stay out
  const it = (type, title, lines) => ({ type, title, lines });
  const pr = (strain, n5, n1) => [{ strain, size: '5pk', n: n5 }, { strain, size: '1g', n: n1 }];
  const wk = (start, byDate) => ({ start, days: Object.entries(byDate).map(([date, items]) => ({ date, items })) });
  const weeks = [
    wk('2026-10-05', {
      '2026-10-07': [it('prerolls', 'PREROLLS- GRIND', [...pr('TIDE', 700, 700), ...pr('VOODOO', 500, 400)])],
      '2026-10-08': [it('prerolls', 'PREROLLS- GRIND', [...pr('TIDE', 700, 700), ...pr('VOODOO', 500, 400)])],
      '2026-10-10': [it('prerolls', 'PREROLLS- GRIND', pr('TIDE', 700, 650)), it('prerolls', 'PREROLLS FOR CARLOS', pr('M8', 128, 454))] }),
    wk('2026-10-12', {
      '2026-10-12': [it('prerolls', 'PREROLLS- GRIND', pr('TIDE', 700, 650))],
      '2026-10-13': [it('prerolls', 'Pre-rolls', [{ strain: 'WIZZY', size: '5pk', n: 600 }])],
      '2026-10-15': [it('prerolls', 'PREROLLS- GRIND', [])],
      '2026-10-19': [it('jars', 'Package to jars', [{ strain: 'SMOOTHIE', lbs: 10, cases: 10 }])],
      '2026-10-20': [it('jars', 'Package to jars', [{ strain: 'SMOOTHIE', lbs: 10, cases: 10 }])] }),
    wk('2026-10-26', { '2026-10-26': [it('jars', 'Package to jars', [{ strain: 'NEBULA', lbs: 8, cases: 5 }])] }),
  ];
  const runs = ACT.runs(weeks, 'prerolls');
  assert.equal(runs.length, 1, 'Oct 7-15 is one pre-roll run across the weekend and the empty-list day');
  const r = runs[0];
  assert.deepEqual([r.start, r.end, r.days.length], ['2026-10-07', '2026-10-15', 6]);
  assert.deepEqual([...r.plan.keys()], ['TIDE|5pk', 'TIDE|1g', 'VOODOO|5pk', 'VOODOO|1g', 'WIZZY|5pk'], 'the plan is every strain and size listed, never a sum over days');
  assert.deepEqual([r.plan.get('TIDE|1g').n, r.plan.get('TIDE|1g').firstN], [650, 700], 'a changed amount keeps the latest and remembers the first');
  assert.deepEqual(r.side.map(x => `${x.job} ${x.strain} ${x.size}`), ['CARLOS M8 5pk', 'CARLOS M8 1g'], 'a job for Carlos is kept out of the plan');
  assert.deepEqual(ACT.runs(weeks, 'jars').map(x => `${x.start}..${x.end}`), ['2026-10-19..2026-10-20', '2026-10-26..2026-10-26'], 'new jar strains a weekend later start a new run');

  // the batch sheet: counted rows by strain and size; packaging or not started is not counted
  const bat = [
    { strain: 'Tide', item: '5PK', package_date: '2026-10-14', total_units: 700, status: 'LABELING BATCH INFO' },
    { strain: 'TIDE', item: '1G', package_date: '2026-10-14', total_units: null, status: 'NOT STARTED' },
    { strain: 'VOODOO', item: '5PK', package_date: '2026-10-14', total_units: 500, status: 'WAITING FOR TESTING' },
    { strain: 'VOODOO', item: '1G', package_date: '2026-10-14', total_units: 120, status: 'PACKAGING' },
    { strain: 'BLACK LIGHT', item: '5PK', package_date: '2026-10-14', total_units: 300, status: 'DONE' },
    { strain: 'SMOOTHIE', item: 'FLOWER', package_date: '2026-10-21', total_units: 1139, budtender_units: 150, status: 'DONE' },
  ];
  const tasks = [
    { work_date: '2026-10-07', task: '5pk (.7g) pre-roll produced(rec)', people: 6, hours: 5.25, packaged: 2500, labeled: 0 },
    { work_date: '2026-10-08', task: '1g pre-roll produced (rec)', people: 6, hours: 4, packaged: 700, labeled: 0 },
    { work_date: '2026-10-17', task: '5pk (.7g) pre-roll produced(rec)', people: 6, hours: 1, packaged: 100, labeled: 0 },
    { work_date: '2026-10-04', task: '1g pre-roll produced (rec)', people: 6, hours: 1, packaged: 50, labeled: 0 },
    { work_date: '2026-10-21', task: '5pk (.7g) pre-roll produced(rec)', people: 6, hours: 1, packaged: 999, labeled: 0 },
    { work_date: '2026-10-21', task: 'General packaging activities', people: 6, hours: 1, packaged: 0, labeled: 0 },
    { work_date: '2026-10-07', task: 'General packaging activities', people: 4, hours: 1, packaged: 0, labeled: 0 },
    { work_date: '2026-10-28', task: '5pk (.7g) pre-roll labeled (post COA)(rec)', people: 5, hours: 3, packaged: 0, labeled: 1200 },
  ];
  // lab turnaround and the expected results date on the Batches view
  {
    const labs = [{ sent_date: '2026-10-01', completed: '2026-10-07' }, { sent_date: '2026-10-02', collected: '2026-10-03', completed: '2026-10-08' },
      { sent_date: '2026-10-05', completed: '2026-10-12' }, { collected: '2026-10-10', completed: '2026-10-15' }, { sent_date: '2026-10-20' }, null];
    const t = BAT.turnaround(labs);
    assert.deepEqual([t.n, t.sent, t.sent90, t.nColl, t.coll], [3, 6, 7, 2, 5], 'days from sending (and from collection) to the COA, middle and 9 in 10');
    assert.deepEqual(BAT.expectedCoa({ sent_date: '2026-10-20' }, null, t, '2026-10-24'), { date: '2026-10-26', from: '2026-10-20', basis: 'sent', days: 6, late: 0 });
    assert.equal(BAT.expectedCoa({ sent_date: '2026-10-20T00:00:00' }, null, t, '2026-10-29').late, 3, 'three days past the expected day');
    assert.deepEqual(BAT.expectedCoa({ collected: '2026-10-21' }, null, t, '2026-10-22'), { date: '2026-10-26', from: '2026-10-21', basis: 'collected', days: 5, late: 0 });
    assert.equal(BAT.expectedCoa(null, '2026-10-20', t, '2026-10-21').date, '2026-10-25', "the sheet's TEST DATE is the collection day");
    assert.deepEqual([BAT.expectedCoa(null, null, t, '2026-10-21'), BAT.expectedCoa({ sent_date: '2026-10-20' }, null, null, '2026-10-21')], [null, null], 'nothing to count from');
    assert.equal(BAT.turnaround([]).sent, null);
  }
  const A = ACT.build(weeks, tasks, bat, '2026-10-16', BAT.statusKey);
  const R = A.byId.get('prerolls-2026-10-07'), line = key => R.act.lines.find(l => l.strain + '|' + l.size === key);
  assert.deepEqual([line('TIDE|5pk').counted, line('TIDE|1g').counted, line('VOODOO|5pk').counted, line('VOODOO|1g').counted], [700, null, 500, null],
    'counted = units on the batch sheet past packaging');
  assert.deepEqual(R.act.extra.map(x => x.strain), ['BLACK LIGHT'], 'a counted batch the plan never listed is shown apart');
  const five = R.prods.find(x => x.prod === '5pk'), one = R.prods.find(x => x.prod === '1g');
  assert.deepEqual([five.plan, five.made, five.counted, five.label2], [1800, 520, 1200, 1200],
    'made counts to 5 days after the run (Oct 17 in, Oct 21 out); after-COA labels count up to 3 weeks on');
  assert.deepEqual([one.plan, one.made, one.counted], [1050, 750, null], 'and from 3 days before it (Oct 4)');
  assert.equal(R.act.otherPh, 4, 'general hours on a pre-roll day go to the pre-roll run; Oct 21 is outside every window');
  assert.deepEqual(R.act.missing, ['2026-10-10', '2026-10-12', '2026-10-13', '2026-10-15'], 'planned past days with nothing logged');
  assert.equal(R.act.closed, false);
  const J = A.byId.get('jars-2026-10-19');
  assert.deepEqual(J.prods.map(x => `${x.prod} ${x.plan} ${x.counted}`), ['jar 10 1139', 'bud 10 150'], 'jars plan in lb, samples in cases; counts in jars and bags');
  assert.equal(ACT.runForWeek(A, 'prerolls', '2026-10-12').id, 'prerolls-2026-10-07');
  // labels go to the run that made the product, even when the next run has started; a blank sample count stays blank
  const B2 = ACT.build(weeks, [
    { work_date: '2026-10-19', task: '3.5g jar packed (rec)', people: 5, hours: 4, packaged: 1000, labeled: 0 },
    { work_date: '2026-10-26', task: '3.5g jar labeled (rec)', people: 8, hours: 5, packaged: 0, labeled: 900 },
  ], [{ strain: 'NEBULA', item: 'FLOWER', package_date: '2026-10-27', total_units: 700, budtender_units: null, status: 'DONE' }], '2026-11-02', BAT.statusKey);
  const j1 = B2.byId.get('jars-2026-10-19').prods.find(x => x.prod === 'jar'), j2 = B2.byId.get('jars-2026-10-26');
  assert.deepEqual([j1.made, j1.label, j1.labelPh], [1000, 900, 40], 'Oct 26 labels belong to the Oct 19 run that packed the jars');
  assert.equal(j2.prods.find(x => x.prod === 'jar').label, 0);
  assert.equal(j2.act.lines[0].buds, null, 'a blank budtender count is not a zero');
  assert.equal(ACT.runOn(A, 'prerolls', '2026-10-11').id, 'prerolls-2026-10-07', 'a weekend inside a run belongs to it');
}

// trim estimates: past trims from the trim sheets -> pounds per light; a trim to come = room lights x the site's last 3
{
  const LB = TRIMY.LB;
  const line = (file, tab, start, end, room, lights, strain, bigs, littles, trim, l, block = 0) =>
    ({ file, tab, block, line: l, site: file.startsWith('SLANE') ? '23RD' : '25TH', room, start_date: start, end_date: end, lights, strain, bigs_g: bigs, littles_g: littles, trim_g: trim });
  const lbs = n => n * LB;   // grams for n pounds
  const rows = [
    line('SLANE 2026.xlsx', 'Aug 4-5', '2026-08-04', '2026-08-05', '1', 48, 'Tide', lbs(100), lbs(20), lbs(40), 0),       // 2.50 / light
    line('SLANE 2026.xlsx', 'Aug 19-21', '2026-08-19', '2026-08-21', '3', 45, 'Zang Banger', lbs(110), lbs(25), lbs(45), 0), // 3.00
    line('SLANE 2026.xlsx', 'Sep 11-13', '2026-09-11', '2026-09-13', '2', 54, 'Wizzy', lbs(120), lbs(15), lbs(54), 0),     // 2.50
    line('SLANE 2026.xlsx', 'Oct 2-4', '2026-10-02', '2026-10-04', '1', 48, 'Antidote', lbs(80), lbs(16), lbs(30), 0),     // 2.00
    // a one-strain early harvest, then the room's full trim that repeats it: the early tab is dropped
    line('FILIFERA 2026.xlsx', 'Oct. 6(RM2 early harvest)', '2026-10-06', '2026-10-06', '2', 21, 'Rip Tide', 5000, 900, 0, 0),
    line('FILIFERA 2026.xlsx', 'Oct. 15', '2026-10-15', '2026-10-15', '2', 21, 'Bluebanger', lbs(40), lbs(8), lbs(15), 0),
    line('FILIFERA 2026.xlsx', 'Oct. 15', '2026-10-15', '2026-10-15', '2', 21, 'Rip Tide', 5000, 900, 0, 1),
    // a partial first tab whose strain shows as zero on the later one: folded in
    line('FILIFERA 2026.xlsx', 'April 16-(1 strain)', '2026-04-16', '2026-04-16', '1', 37, 'Zoza x Tide #17', lbs(9), lbs(0.4), 0, 0),
    line('FILIFERA 2026.xlsx', 'April 16 Cont.-(April 30-May 1)', '2026-04-30', '2026-05-01', '1', 37, 'Zoza x Tide #17', 0, 0, 0, 0),
    line('FILIFERA 2026.xlsx', 'April 16 Cont.-(April 30-May 1)', '2026-04-30', '2026-05-01', '1', 37, 'Tidebanger', lbs(90), lbs(10), lbs(30), 1),
  ];
  const ev = TRIMY.events(rows);
  assert.deepEqual(ev.map(e => e.tab), ['April 16 Cont.-(April 30-May 1)', 'Aug 4-5', 'Aug 19-21', 'Sep 11-13', 'Oct 2-4', 'Oct. 15'],
    'the repeated early-harvest tab is dropped and the partial April tab is folded into the next one');
  const apr = ev[0];
  assert.equal(Math.round(apr.lb * 10) / 10, 109.4, 'the folded strain counts once, in the room\'s full trim');
  const r = TRIMY.rate(ev, '23RD', '2026-10-17');
  assert.deepEqual([r.from.map(e => e.tab), Math.round(r.perLight * 1000) / 1000, r.scope], [['Aug 19-21', 'Sep 11-13', 'Oct 2-4'], 2.5, 'site'],
    'the site\'s last 3 trims before the date: (3.00 + 2.50 + 2.00) / 3');
  assert.equal(TRIMY.roomLights(ev, '23RD', '1'), 48);
  const item = { site: '23RD', room: '3', strains: [{ strain: 'ANTIDOTE', n: 8 }, { strain: 'BLUEBANGER', n: null }, { strain: 'RIPTIDE', n: 8 }] };
  const e = TRIMY.estimate(ev, item, '2026-10-17', 0.1);
  assert.deepEqual([e.lights, e.lightsFrom, e.sheetLights, Math.round(e.lb * 10) / 10, Math.round(e.lo), Math.round(e.hi)], [45, 'room', 16, 112.5, 101, 124],
    'the room\'s lights as the trim sheets count them (45) times 2.5 lb, with the usual miss either side');
  assert.deepEqual(e.strains.map(x => `${x.strain} ${x.lb}`), ['ANTIDOTE 20', 'RIPTIDE 20']);
  assert.equal(TRIMY.match(ev, '25TH', '2', '2026-10-16').tab, 'Oct. 15', 'a sheet day within 3 days of the tab finds it');
  assert.equal(TRIMY.match(ev, '25TH', '2', '2026-10-20'), null);
  assert.equal(TRIMY.estimate(ev, { site: 'OLYMPIC', room: '3', strains: [] }, '2026-12-10'), null, 'no lights anywhere: no estimate');
  const all = TRIMY.rate(ev, 'OLYMPIC', '2026-12-10');
  assert.equal(all.scope, 'all', 'a site with no trims yet borrows the last trims of every site');
  const bt = TRIMY.backtest(ev);
  assert.ok(bt && bt.n === 4, 'the backtest scores every trim that had earlier trims at its site (3 at Slane, 1 at Filifera)');
  // the folded early harvests stay findable on their own days, and a past trim's estimate uses its own lights
  const mp = TRIMY.matchPart(ev, '25TH', '2', '2026-10-06');
  assert.deepEqual([mp.of.tab, mp.part.tab, Math.round(mp.part.lb * 10) / 10], ['Oct. 15', 'Oct. 6(RM2 early harvest)', 13]);
  assert.equal(TRIMY.match(ev, '25TH', '2', '2026-10-06'), null);
  assert.equal(TRIMY.estimate(ev, item, '2026-10-02', 0.1, 40).lights, 40, 'a lights override wins over the room\'s latest count');
  // an early harvest with no later tab yet never sets the site's rate
  const early = TRIMY.events([...rows.slice(0, 4), line('SLANE 2026.xlsx', 'Oct 10 (RM2 early)', '2026-10-10', '2026-10-10', '2', 54, 'Wizzy', lbs(20), 0, 0, 0)]);
  assert.equal(Math.round(TRIMY.rate(early, '23RD', '2026-10-17').perLight * 1000) / 1000, 2.5, 'the 0.37 lb/light early harvest is left out');
}

// the endless board: any run of days drawn side by side; a job that runs Sunday into Monday is one bar across the line
{
  const blankW = () => Array(14).fill('');
  const hdr = (labels) => { const h = blankW(); labels.forEach((t, k) => { h[k * 2] = t; }); return h; };
  const g = [blankW(),
    hdr(['OCTOBER, MONDAY 5TH', 'OCTOBER, TUESDAY 6TH', 'OCTOBER, WEDNESDAY 7TH', 'OCTOBER, THURSDAY 8TH', 'OCTOBER, FRIDAY 9TH', 'OCTOBER, SATURDAY 10TH', 'OCTOBER,SUNDAY 11TH']),
    blankW(), blankW(), blankW(),
    hdr(['OCTOBER, MONDAY 12TH', 'OCTOBER, TUESDAY 13TH', 'OCTOBER, WEDNESDAY 14TH', 'OCTOBER, THURSDAY 15TH', 'OCTOBER, FRIDAY 16TH', 'OCTOBER, SATURDAY 17TH', 'OCTOBER,SUNDAY 18TH']),
    blankW(), blankW(), blankW(), blankW()];
  // a trim Sat 10 - Mon 12, and a testing note on Fri 9 with room to spill to the right
  g[2][10] = 'TRIM - JUSTIN'; g[2][11] = 'ROOM 2 @ 25TH'; g[2][12] = 'TRIM - JUSTIN'; g[2][13] = 'ROOM 2 @ 25TH';
  g[6][0] = 'TRIM - JUSTIN'; g[6][1] = 'ROOM 2 @ 25TH';
  g[3][8] = 'TESTING SCHEDULED FOR NOV DROP 1 - BLUEBANGER, TIDEBANGER, BLACK MAGIC, SMOOTHIE, WIZZY';
  const wk = PIPE.parse(g.map(r => r.map(c => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',')).join('\n'));
  const M = WEEK.buildModel(wk);
  const R = WEEK.buildRange(M, '2026-10-05', 14, { today: '', drops: new Map() });
  assert.deepEqual([R.n, R.days[0].date, R.days[13].date, R.ix('2026-10-12'), R.days[7].dow], [14, '2026-10-05', '2026-10-18', 7, 0]);
  const trim = R.bars.filter(b => b.lane === 'trim');
  assert.deepEqual(trim.map(b => [b.a, b.b, b.contL, b.contR]), [[5, 7, false, false]], 'Sat 10 to Mon 12 is one bar across the week line');
  const w1 = WEEK.buildBoard(M, '2026-10-05', { today: '', drops: new Map() }), w2 = WEEK.buildBoard(M, '2026-10-12', { today: '', drops: new Map() });
  assert.deepEqual(w1.bars.filter(b => b.lane === 'trim').map(b => [b.a, b.b, b.contR]), [[5, 6, true]], 'the week board still clips it at Sunday');
  assert.deepEqual(w2.bars.filter(b => b.lane === 'trim').map(b => [b.a, b.b, b.contL]), [[0, 0, true]]);
  const test = R.bars.find(b => b.lane === 'testing');
  assert.equal(test.spillEnd, 6, 'a note spills right only to its own Sunday, never into the next week');
}

// the Admin page (beta): what an admin types, the words it shows, the warning before real writes, the change log
{
  // an editor's address: lower case, Wizard Trees only, a bare name gets the domain
  assert.deepEqual(ADMIN.email('  Maria.Lopez' + '@WizardTrees.com '), { email: 'maria.lopez' + '@wizardtrees.com' });
  assert.deepEqual(ADMIN.email('maria'), { email: 'maria' + '@wizardtrees.com' }, 'a bare name gets the Wizard Trees domain');
  for (const bad of ['', '   ', 'maria' + '@gmail.com', 'maria' + '@wizardtrees.com.evil.io', 'ma ria', '@wizardtrees.com', 'maria' + '@sub.wizardtrees.com'])
    assert.ok(ADMIN.email(bad).error, `"${bad}" is refused`);
  // a test copy's id from its address or the bare id; anything else is ''
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abcd';
  assert.equal(ADMIN.sheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`), id);
  assert.equal(ADMIN.sheetId(`https://docs.google.com/spreadsheets/d/${id}`), id);
  assert.equal(ADMIN.sheetId(`https://docs.google.com/spreadsheets/u/1/d/${id}/edit?usp=sharing`), '', 'only the plain /spreadsheets/d/ address');
  assert.equal(ADMIN.sheetId(`  ${id} `), id, 'a bare id is taken as it is');
  for (const bad of ['', 'not a sheet', `https://drive.google.com/file/d/${id}/view`, 'https://docs.google.com/spreadsheets/d/e/2PACX/pubhtml', 'short_id'])
    assert.equal(ADMIN.sheetId(bad), '', `"${bad}" is not a sheet id`);
  // only what is changing goes to pipeline_admin_settings_set; '' clears the test copy
  assert.deepEqual(ADMIN.args({ enabled: true }), { p_enabled: true });
  assert.deepEqual(ADMIN.args({ test_workbook: '', tabs_on: [] }), { p_tabs_on: [], p_test_workbook: '' });
  assert.deepEqual(ADMIN.args({ test_mode: false, target: 'live', kinds_on: ['rewrite', 'add'], extra: 1 }), { p_test_mode: false, p_target: 'live', p_kinds_on: ['rewrite', 'add'] });
  // ticking a tab or a kind keeps the fixed order, with no repeats
  assert.deepEqual(ADMIN.toggled(ADMIN.TABS, ['ACCESSORY SUPPLY'], 'DISTRO PIPELINE', true), ['DISTRO PIPELINE', 'ACCESSORY SUPPLY']);
  assert.deepEqual(ADMIN.toggled(ADMIN.TABS, ADMIN.TABS, 'DISTRO SUPPLY', false), ['DISTRO PIPELINE', 'ACCESSORY SUPPLY']);
  assert.deepEqual(ADMIN.toggled(ADMIN.KINDS, ['add'], 'rewrite', true), ['rewrite', 'add']);
  assert.deepEqual(ADMIN.toggled(ADMIN.KINDS, null, 'add', true), ['add']);
  // real writes to the live sheet start only with saving on, test mode off and the real sheet picked: that change asks first
  const off = { enabled: false, test_mode: true, target: 'test', tabs_on: ADMIN.TABS, kinds_on: ['rewrite'], has_test_copy: true };
  const almost = { ...off, enabled: true, test_mode: false, target: 'test' };
  assert.equal(ADMIN.goesLive(almost, { target: 'live' }), true, 'pointing an unlocked save at the real sheet asks first');
  assert.equal(ADMIN.goesLive({ ...off, target: 'live', test_mode: false }, { enabled: true }), true, 'switching saving on when it would write the real sheet asks first');
  assert.equal(ADMIN.goesLive({ ...off, enabled: true, target: 'live' }, { test_mode: false }), true, 'turning test mode off on the real sheet asks first');
  assert.equal(ADMIN.goesLive(off, { enabled: true }), false, 'test mode on: no warning');
  assert.equal(ADMIN.goesLive(almost, { tabs_on: ['DISTRO PIPELINE'] }), false, 'the test copy: no warning');
  assert.equal(ADMIN.goesLive({ ...almost, target: 'live' }, { tabs_on: ['DISTRO PIPELINE'] }), false, 'already live, fewer tabs: no second warning');
  // every way real writes become possible asks, not only the three main switches
  const liveNoTabs = { ...almost, target: 'live', tabs_on: [] };
  assert.equal(ADMIN.isLive(liveNoTabs), false, 'no tabs on: nothing can be written');
  assert.equal(ADMIN.goesLive(liveNoTabs, { tabs_on: ['DISTRO PIPELINE'] }), true, 'ticking the first tab with everything else live asks');
  assert.equal(ADMIN.goesLive({ ...almost, target: 'live', kinds_on: [] }, { kinds_on: ['add'] }), true, 'ticking the first kind with everything else live asks');
  const liveRewrite = { ...almost, target: 'live', kinds_on: ['rewrite'] };
  assert.equal(ADMIN.goesLive(liveRewrite, { kinds_on: ['rewrite', 'add'] }), true, 'adding new lines while live asks');
  assert.equal(ADMIN.goesLive({ ...liveRewrite, tabs_on: ['DISTRO PIPELINE'] }, { tabs_on: ['DISTRO PIPELINE', 'DISTRO SUPPLY'] }), true, 'another tab while live asks');
  assert.equal(ADMIN.goesLive(liveRewrite, { kinds_on: [] }), false, 'switching a kind off asks nothing');
  assert.equal(ADMIN.goesLive(liveRewrite, { test_mode: true }), false, 'test mode back on asks nothing');
  assert.equal(ADMIN.goesLive(liveRewrite, { test_workbook: '' }), false, 'clearing the test copy while live asks nothing');
  assert.equal(ADMIN.liveAsk(almost, { target: 'live' }),
    'Saves from the app will change the real sheet the whole crew works from, right away: changing lines on the DISTRO PIPELINE, DISTRO SUPPLY and ACCESSORY SUPPLY tabs.\n\nTurn this on?');
  assert.equal(ADMIN.liveAsk({ ...liveRewrite, tabs_on: ['DISTRO PIPELINE'] }, { kinds_on: ['rewrite', 'add'] }),
    'Saves from the app already change the real sheet the whole crew works from. After this they can also add new lines on the DISTRO PIPELINE tab, right away.\n\nGo ahead?');
  assert.equal(ADMIN.liveAsk({ ...liveRewrite, tabs_on: ['DISTRO PIPELINE'] }, { tabs_on: ['DISTRO PIPELINE', 'DISTRO SUPPLY'] }),
    'Saves from the app already change the real sheet the whole crew works from. After this they can also change lines on the DISTRO SUPPLY tab, right away.\n\nGo ahead?');
  assert.equal(ADMIN.liveAsk(liveRewrite, { kinds_on: [] }), '');
  // the same rule as the server's, case by case (pipeline_admin_settings_set: v_now and (not v_was or a new tab or kind))
  const server = (b, p) => { const a = { ...b, ...p }, L = x => x.enabled && !x.test_mode && x.target === 'live' && x.tabs_on.length > 0 && x.kinds_on.length > 0;
    return L(a) && (!L(b) || a.tabs_on.some(t => !b.tabs_on.includes(t)) || a.kinds_on.some(k => !b.kinds_on.includes(k))); };
  const states = [];
  for (const enabled of [false, true]) for (const test_mode of [false, true]) for (const target of ['test', 'live'])
    for (const tabs_on of [[], ['DISTRO PIPELINE'], ADMIN.TABS]) for (const kinds_on of [[], ['rewrite'], ['rewrite', 'add']])
      states.push({ enabled, test_mode, target, tabs_on, kinds_on, has_test_copy: true });
  const patches = [{ enabled: true }, { enabled: false }, { test_mode: false }, { test_mode: true }, { target: 'live' }, { target: 'test' },
    { tabs_on: [] }, { tabs_on: ['DISTRO PIPELINE'] }, { tabs_on: ADMIN.TABS }, { kinds_on: [] }, { kinds_on: ['rewrite'] }, { kinds_on: ['add'] }, { kinds_on: ['rewrite', 'add'] }];
  for (const st of states) for (const p of patches)
    assert.equal(ADMIN.goesLive(st, p), server(st, p), `page and server agree on ${JSON.stringify(st)} + ${JSON.stringify(p)}`);
  // what Save does right now, in one sentence
  assert.match(ADMIN.summary(off), /^Saving to the sheet from the app is off\./);
  assert.match(ADMIN.summary({ ...off, enabled: true }), /^Test mode: Save checks each change against the test copy and writes nothing\. Only changing lines\.$/);
  assert.match(ADMIN.summary({ ...off, enabled: true, has_test_copy: false }), /no test copy is set/);
  assert.match(ADMIN.summary({ ...off, enabled: true, has_test_copy: false, target: 'live' }), /^Test mode: Save checks each change against the real sheet/, 'the real sheet needs no test copy');
  assert.match(ADMIN.summary({ ...off, enabled: true, tabs_on: [] }), /no tabs are switched on/);
  assert.match(ADMIN.summary({ ...off, enabled: true, kinds_on: [] }), /no kinds of change/);
  assert.equal(ADMIN.summary({ ...almost, target: 'live', tabs_on: ['DISTRO PIPELINE'], kinds_on: ['rewrite', 'add'] }),
    'Saving is on: Save writes each change to the real sheet the crew works from. Only the DISTRO PIPELINE tab.');
  assert.equal(ADMIN.summary({ ...almost, tabs_on: ['DISTRO SUPPLY', 'ACCESSORY SUPPLY'], kinds_on: ['add'] }),
    'Saving is on: Save writes each change to the test copy. Only the DISTRO SUPPLY and ACCESSORY SUPPLY tabs. Only adding new lines.');
  assert.equal(ADMIN.isLive({ ...almost, target: 'live' }), true);
  assert.equal(ADMIN.isLive({ ...almost, target: 'live', enabled: false }), false);
  // the last admin on the list stays: never removed, never made not-admin (yourself included)
  const eds = [{ email: 'a', admin: true }, { email: 'b', admin: false }];
  assert.ok(ADMIN.removeBlock(eds, 'a') && ADMIN.changeBlock(eds, 'a', false), 'the only admin cannot be removed or lose admin');
  assert.equal(ADMIN.changeBlock(eds, 'a', true), '', 'the only admin can still change what they edit');
  assert.equal(ADMIN.removeBlock(eds, 'b'), '');
  assert.equal(ADMIN.removeBlock([...eds, { email: 'c', admin: true }], 'a'), '', 'with another admin, an admin can go');
  assert.equal(ADMIN.removeBlock([{ email: 'b', admin: false }], 'b'), '', 'no admins on the list (universal admins only): editors can go');
  // the change log, as sentences (never a sheet id)
  const at = '2026-11-11T15:29:40Z', who = 'pat.lee' + '@wizardtrees.com', m = 'maria' + '@wizardtrees.com';
  assert.equal(ADMIN.nameOf(who), 'Pat');
  assert.equal(ADMIN.describe({ at, email: who, action: 'editor_add', subject: m, after: { scope: 'plan', admin: true, viewer_added: true } }),
    `Added ${m} as an editor of the plan, and an admin`);
  assert.equal(ADMIN.describe({ at, email: who, action: 'editor_change', subject: m, before: { scope: 'plan', admin: true }, after: { scope: 'all', admin: false } }),
    `Changed ${m}: can now change the plan and supplies, no longer an admin`);
  assert.equal(ADMIN.describe({ at, email: who, action: 'editor_remove', subject: m, before: { scope: 'supply', admin: false } }), `Took ${m} off the editors list`);
  const before = { enabled: false, test_mode: true, target: 'test', tabs_on: ['DISTRO PIPELINE', 'DISTRO SUPPLY', 'ACCESSORY SUPPLY'], kinds_on: ['rewrite'], test_copy: true };
  assert.equal(ADMIN.describe({ at, email: who, action: 'settings', before,
    after: { ...before, enabled: true, test_mode: false, target: 'live', tabs_on: ['DISTRO PIPELINE'], kinds_on: ['rewrite', 'add'] } }),
    'Turned saving to the sheet on; turned test mode off; pointed saves at the real sheet; switched off the DISTRO SUPPLY and ACCESSORY SUPPLY tabs; switched on adding new lines');
  assert.equal(ADMIN.describe({ at, email: who, action: 'settings', before, after: { ...before, test_copy: true, test_copy_changed: true } }), 'Changed the test copy');
  assert.equal(ADMIN.describe({ at, email: who, action: 'settings', before, after: { ...before, test_copy: false } }), 'Cleared the test copy');
  assert.equal(ADMIN.describe({ at, email: who, action: 'settings', before: { ...before, test_copy: false }, after: before }), 'Set the test copy');
  assert.equal(ADMIN.describe({ at, email: who, action: 'settings', before, after: { ...before, kinds_on: [] } }), 'Switched off changing lines');
  // Add says what the server did, not what was asked
  assert.equal(ADMIN.alreadyListed({ email: m, scope: 'all', admin: true }), `${m} is already on the list, and can change the plan and supplies, and is an admin. Nothing was changed.`);
  assert.equal(ADMIN.addedSay({ email: m, scope: 'plan', admin: false, added: true }, m),
    `Added ${m}. They can change the plan whenever saving is on.`);
  assert.equal(ADMIN.addedSay({ email: m, scope: 'all', admin: true, added: false }, m),
    `${m} was already on the list, so nothing new was added. They can change the plan and supplies whenever saving is on. They are also an admin.`);
  assert.match(ADMIN.addedSay(null, m), /^Saved\. The list below shows/);
  assert.equal(ADMIN.changedSay({ email: m, scope: 'supply', admin: false, added: false }, m), `Saved: ${m} can change the supplies.`);
  assert.match(ADMIN.changedSay({ email: m, scope: 'supply', admin: false, added: true }, m), /no longer on the list \(someone took them off meanwhile\), so they were added back/);
  console.log('admin page: addresses, test copy ids, the live-sheet warning, the summary sentence, the last-admin rule and the change log read right');
  console.log('admin page: the live-sheet question comes up however real writes are opened, page and server agree, and Add reports what the server did');
}

// the Admin page's cloud sync jobs card (supabase/pipeline-sync.sql): links, words, the comparison report
{
  const [marks, trims, batches] = ADMIN.SYNC;
  assert.deepEqual(ADMIN.SYNC.map(j => j.job), ['marks', 'trims', 'batches'], 'the three jobs pipeline-sync.sql seeds');
  assert.deepEqual(ADMIN.SYNC_MODES.map(x => x[0]), ['off', 'shadow', 'write'], 'the modes pipeline_sync_settings allows');
  // a pasted link becomes the bare Drive id; a file where a folder belongs (or the other way round) is refused
  const fid = '1AbCdEfGhIjKlMnOpQrStUv_wx-YZ0123';
  assert.deepEqual(ADMIN.driveId(`https://drive.google.com/drive/folders/${fid}?usp=sharing`, trims), { id: fid });
  assert.deepEqual(ADMIN.driveId(`https://drive.google.com/drive/u/0/folders/${fid}`, trims), { id: fid });
  assert.deepEqual(ADMIN.driveId(`https://docs.google.com/spreadsheets/d/${fid}/edit#gid=0`, batches), { id: fid });
  assert.deepEqual(ADMIN.driveId(`https://drive.google.com/file/d/${fid}/view?usp=drive_link`, batches), { id: fid });
  assert.deepEqual(ADMIN.driveId(`https://drive.google.com/open?id=${fid}`, batches), { id: fid });
  assert.deepEqual(ADMIN.driveId(`  ${fid} `, trims), { id: fid }, 'a bare id is taken as it is');
  assert.match(ADMIN.driveId(`https://drive.google.com/file/d/${fid}/view`, trims).error, /^That's the address of a file/);
  assert.match(ADMIN.driveId(`https://drive.google.com/drive/folders/${fid}`, batches).error, /^That's the address of a folder/);
  assert.match(ADMIN.driveId(`https://docs.google.com/spreadsheets/d/${fid}/edit`, batches, fid).error, /WIZARD TREES workbook/, 'the board\'s own workbook is refused');
  for (const bad of ['', 'not a link', 'https://example.com/nothing', 'short'])
    assert.ok(ADMIN.driveId(bad, trims).error, `"${bad}" is refused`);
  // a job reads only once its source is set (red cells read the board's own workbook)
  assert.equal(ADMIN.syncNeedsSource(marks, { source_set: false }), false);
  assert.equal(ADMIN.syncNeedsSource(trims, { source_set: false }), true);
  assert.match(ADMIN.syncModeBlock(trims, { source_set: false }, 'shadow'), /^Paste the address of the 2026 TRIM SHEETS folder first/);
  assert.equal(ADMIN.syncModeBlock(trims, { source_set: false }, 'off'), '', 'Off never needs a source');
  assert.equal(ADMIN.syncModeBlock(trims, { source_set: true }, 'write'), '');
  // Write asks first and says how the comparisons went; leaving Write asks too; Off to Compare only does not
  const okRun = { status: 'compared', at: '2026-11-10T10:00:00Z', diff: { ok: true, next: 362, live: 362, added: 0, removed: 0, changed: 0, same: 362, dup: 0, sample: [] } };
  const badRun = { status: 'compared', at: '2026-11-11T10:00:00Z', diff: { ok: false, next: 913, live: 912, added: 1, removed: 0, changed: 1, same: 911, dup: 0,
    sample: [{ key: '3|6', what: 'added' }, { key: '14|3', what: 'changed', fields: { fill: [false, true], txt: ['VOODOO', 'VOODOO 6'] } }] } };
  assert.match(ADMIN.syncModeAsk(trims, { mode: 'shadow', runs: [okRun] }, 'write'), /^Switch Trim pounds to Write\?\n\nThe cloud job will write the trim pounds into the app on its next run\. Its last comparison matched\./);
  assert.match(ADMIN.syncModeAsk(marks, { mode: 'shadow', runs: [badRun, okRun] }, 'write'), /Its last comparison found differences\./);
  assert.match(ADMIN.syncModeAsk(marks, { mode: 'off', runs: [] }, 'write'), /It hasn't compared yet\./);
  assert.match(ADMIN.syncModeAsk(marks, { mode: 'write', runs: [] }, 'off'), /stops writing the red cells into the app\. If the job on Gianni's computer has been switched off, ask him to turn it back on/);
  assert.equal(ADMIN.syncModeAsk(marks, { mode: 'off', runs: [] }, 'shadow'), '');
  assert.match(ADMIN.syncModeSaid(batches, 'shadow', 'write'), /^Write\. On its next run the cloud job writes the batches into the app/);
  assert.match(ADMIN.syncModeSaid(batches, 'write', 'off'), /^Off\. The cloud job does nothing now\. If the job on Gianni's computer/);
  // where a difference is, and what it is, in the sheet's own terms
  assert.equal(ADMIN.syncWhere('marks', '14|3'), 'Cell D15');
  assert.equal(ADMIN.syncWhere('marks', '0|27'), 'Cell AB1');
  assert.equal(ADMIN.syncWhere('trims', 'SLANE 2026.xlsx|Oct 2-4|0|2'), 'SLANE 2026.xlsx, tab Oct 2-4, room 1, strain 3');
  assert.equal(ADMIN.syncWhere('batches', '41'), 'Row 41');
  assert.equal(ADMIN.syncDiffSay(trims, okRun.diff), 'all 362 trim lines match the app');
  assert.equal(ADMIN.syncDiffSay(marks, badRun.diff), "2 differences in 913 marked cells (1 the app doesn't have, 1 that differ)");
  assert.deepEqual(ADMIN.syncDiffItems('marks', badRun.diff), ["Cell G4: the cloud job found it, the app doesn't have it",
    'Cell D15: red fill is no in the app, yes as the cloud job read it; the text is VOODOO in the app, VOODOO 6 as the cloud job read it']);
  assert.deepEqual(ADMIN.syncDiffItems('batches', { sample: [{ key: '7', what: 'removed' }, { key: '9', what: 'changed', fields: { coa_date: [null, '2026-11-02'] } }] }),
    ["Row 7: the app has it, the cloud job didn't find it", 'Row 9: coa date is blank in the app, 2026-11-02 as the cloud job read it']);
  assert.equal(ADMIN.syncRunSay(trims, { status: 'saved', n_rows: 362 }), 'Saved 362 trim lines to the app');
  assert.equal(ADMIN.syncRunSay(marks, { status: 'error', error: 'Google: could not read the sheet (HTTP 403)' }), 'Failed: Google: could not read the sheet (HTTP 403)');
  assert.equal(ADMIN.syncRunSay(marks, { status: 'settings', mode: 'shadow', run_by: 'pat.lee' + '@wizardtrees.com' }), 'Settings changed by Pat: now Compare only');
  for (const st of ['saved', 'unchanged', 'compared', 'waiting', 'partial', 'busy', 'settings', 'error'])
    assert.ok(ADMIN.syncRunSay(marks, { status: st, mode: 'shadow', diff: okRun.diff }) && !/undefined/.test(ADMIN.syncRunSay(marks, { status: st, mode: 'shadow', diff: okRun.diff })), `a ${st} run reads as a sentence`);
  const day = at => at.slice(0, 10);
  assert.equal(ADMIN.syncTrack([], day), 'No comparisons yet.');
  assert.equal(ADMIN.syncTrack([okRun, { status: 'busy' }, okRun], day), '2 comparisons since 2026-11-10: all matched.');
  assert.equal(ADMIN.syncTrack([badRun, okRun], day), '2 comparisons since 2026-11-10: 1 of them found differences; the newest did too.');
  assert.equal(ADMIN.syncTrack([okRun, badRun], day), '2 comparisons since 2026-11-11: 1 of them found differences; the newest matched.');
  assert.equal(ADMIN.syncTrack([badRun], day), '1 comparison since 2026-11-11: none matched.');
  // what Compare now answered
  assert.deepEqual(ADMIN.syncCompareSay(trims, 200, { status: 'compared', diff: okRun.diff }), { bad: false, text: 'Compared just now: all 362 trim lines match the app.' });
  assert.equal(ADMIN.syncCompareSay(trims, 200, { ok: true, skipped: 'busy' }).text, "It's running right now. Try again in a minute.");
  assert.match(ADMIN.syncCompareSay(trims, 404, null).text, /isn't on the server yet/);
  assert.match(ADMIN.syncCompareSay(trims, 401, { ok: false }).text, /didn't accept your sign-in/);
  assert.match(ADMIN.syncCompareSay(trims, 0, null).text, /Couldn't reach the cloud job/);
  assert.match(ADMIN.syncCompareSay(batches, 200, { status: 'error', error: 'Batch Label Sheet.xlsx is in the trash' }).text, /^It failed: Batch Label Sheet\.xlsx is in the trash$/);
  for (const st of ['waiting', 'unchanged', 'partial']) assert.ok(ADMIN.syncCompareSay(marks, 200, { status: st }).text, `Compare now: ${st}`);
  console.log('admin page, cloud sync jobs: links become Drive ids, Write asks first, and runs and differences read in plain words');
  // the page's words, with no em dashes anywhere on the Admin page
  const adminPage = html.split('/* ---------------- Admin page (beta, pipeline admins only) ----------------')[1].split('/* ---------------- Delivery/Visit schedule')[0];
  assert.ok(!/\u2014/.test(adminSrc + adminPage), 'no em dashes on the Admin page');
}

// optional: a real export of the tab, to see it parses end to end
if (realSup) {
  const real = SUP.parse(readFileSync(realSup, 'utf8'), 'DISTRO SUPPLY');
  assert.ok(real && real.items.length > 100, 'real supply export parses');
  console.log(`real supply export: ${real.items.length} items, ${real.items.filter(i => i.below).length} below par, sites ${real.sites.join(' ')}`);
}
if (realBat) {
  const rows = JSON.parse(readFileSync(realBat, 'utf8'));
  const groups = BAT.groups(rows);
  assert.equal(groups.reduce((a, x) => a + x.rows.length, 0), rows.length, 'every batch lands in a group');
  assert.ok(groups[groups.length - 1].finished, 'finished batches come last');
  const coded = rows.filter(r => BAT.decode(r.batch_code).site).length;
  console.log(`real batches: ${rows.length} rows, ${coded} with a site in the code; ${groups.map(x => `${x.label} ${x.rows.length}`).join(', ')}`);
}
if (realPipe) {
  const real = PIPE.parse(readFileSync(realPipe, 'utf8'));
  const n = real.reduce((a, x) => a + x.days.reduce((b, d) => b + d.items.length, 0), 0);
  assert.ok(real.length > 10 && n > 100, 'real export parses');
  // every week builds a board, and no bar is left without a headline
  const M = WEEK.buildModel(real);
  let bars = 0;
  for (const w of real) {
    const B = WEEK.buildBoard(M, w.start, { today: '', summary: WEEK.summarize(w), drops: new Map() });
    for (const l of B.lanes) for (const b of [...l.headTracks.flat(), ...l.rows.flatMap(r => r.tracks.flat())]) {
      bars++;
      if (!(l.id === 'jars' || l.id === 'prerolls') || b.kind === 'head') assert.ok(b.head, `bar with no headline in ${w.start} ${l.id}`);
    }
    for (const d of w.days) WEEK.dayBoard(M, d.date, { drops: new Map() });
  }
  console.log(`real export: ${real.length} weeks, ${n} items, ${bars} bars, ${real[0].start} to ${real[real.length - 1].start}`);
  if (realTrims) {
    const ev = TRIMY.events(JSON.parse(readFileSync(realTrims, 'utf8')));
    const bt = TRIMY.backtest(ev);
    assert.ok(ev.length >= 40 && bt && bt.miss < 0.2, 'real trims parse and the estimate stays within 20% on average');
    console.log(`real trims: ${ev.length} trims; estimates off by ${Math.round(bt.miss * 1000) / 10}% on average, within 10% on ${bt.within10} of ${bt.n}`);
  }
  if (realTasks && realBat) {
    // plan vs actual on the real sheets: September's run is closed, so its figures hold still
    const A = ACT.build(real, JSON.parse(readFileSync(realTasks, 'utf8')), JSON.parse(readFileSync(realBat, 'utf8')), '2026-10-15', BAT.statusKey);
    const sep = A.byId.get('prerolls-2026-09-07');
    assert.ok(sep, 'the Sep 7-15 pre-roll run is found');
    const f = sep.prods.find(x => x.prod === '5pk'), g = sep.prods.find(x => x.prod === '1g');
    assert.deepEqual([f.plan, g.plan, f.sticks, f.label2, g.label2], [4450, 3000, 10350, 2773, 1820]);
    console.log(`real plan vs actual: ${A.runs.prerolls.length} pre-roll runs, ${A.runs.jars.length} jar runs; Sep 7-15 5-packs plan ${f.plan}, made ${f.made}, counted ${f.counted}`);
  }
}
// the live sheet's wording that the reader used to miss (cells E669, I668 and A642 on 2026-11-10)
{
  const [j] = PIPE.structure([{ title: 'SORT/PACKAGE TO JARS (ADD VERIFICATION STICKER): \nBLACK MAGIC --- 3.5G & 1.5G BUDTENDER SAMPLE', details: [] }]);
  assert.equal(j.type, 'jars');
  assert.deepEqual(j.lines.map(l => [l.strain, l.lbs, l.notes]), [['BLACK MAGIC', null, ['3.5G & 1.5G BUDTENDER SAMPLE']]], 'a jar job written "STRAIN --- products" names its strain, with no pounds');
  assert.deepEqual(PIPE.listedStrains('TBD - TESTING SCHEDULED FOR DEC DROP 2-  TIDEBANGER, ANTIDOTE, BLUEBANGER, ZANGBANGER, VOODOO'),
    ['TIDEBANGER', 'ANTIDOTE', 'BLUEBANGER', 'ZANGBANGER', 'VOODOO'], '"DROP 2-  TIDEBANGER" keeps its first strain');
  assert.deepEqual(PIPE.listedStrains('TESTING SCHEDULED FOR NOV DROP 1 - BLUEBANGER, TIDEBANGER'), ['BLUEBANGER', 'TIDEBANGER']);
  assert.equal(PIPE.typeOf('JUSTIN DISTRO / LORENZO TRIM'), 'crew', 'a who-is-where line is crew');
  assert.equal(PIPE.typeOf('LOREZNO OFF / JUSTIN DISTRO'), 'crew');
  assert.equal(PIPE.typeOf('TRIM -LORENZO'), 'trim', 'a trim led by a person stays a trim');
  console.log('live wording: current jar lines, "DROP 2-" testing lists and who-is-where crew lines read right');
}

// ---------------- Edit model (release 1a): an edit -> the exact cells to rewrite, proven by reading them back ----------------
{
  const blankE = () => Array(14).fill('');
  const g = [['WIZARD TREES PRODUTION PIPELINE ', ...Array(13).fill('')]];
  const head = labels => { const h = blankE(); labels.forEach((t, k) => { h[k * 2] = t; }); return h; };
  g.push(head(['NOVEMBER, MONDAY 2ND', 'NOVEMBER, TUESDAY 3RD', 'NOVEMBER, WEDNESDAY 4TH', 'NOVEMBER, THURSDAY 5TH', 'NOVEMBER, FRIDAY 6TH',
    'NOVEMBER, SATURDAY 7TH', 'NOVEMBER,SUNDAY 8TH']));
  const put = (r, day, task, detail = '') => { while (g.length <= r) g.push(blankE()); g[r][day * 2] = task; g[r][day * 2 + 1] = detail; };
  const JAR = s => `SORT/PACKAGE TO JARS (ADD VERIFICATION STICKER): \n${s} --- 3.5G & 1.5G BUDTENDER SAMPLE`;
  // Mon: two crew lines, a pre-roll run, two jar lines (one written "TIDE---")
  put(2, 0, 'JUSTIN DISTRO / LORENZO TRIM'); put(3, 0, 'NOURI ON CALL FOR PORTAL WORK');
  put(4, 0, 'PREROLLS- GRIND, PRODUCE, PACKAGE, ADD BATCH LABEL (ADD VERIFICATION STICKER)');
  put(5, 0, 'VOODOO', '5PK .7G -- 600'); put(6, 0, '', '1G PREROLL- 600');
  put(7, 0, 'TIDE', '5PK .7G -- 1,200'); put(8, 0, '', '1G PREROLL- 700');
  put(9, 0, JAR('BLACK MAGIC')); put(10, 0, 'SORT/PACKAGE TO JARS (ADD VERIFICATION STICKER): \nTIDE--- 3.5G & 1.5G BUDTENDER SAMPLE');
  // Tue: both TIDE sizes in one cell with a CRLF; VOODOO 1g at 500, not 600; a Nabis line
  put(2, 1, 'LOREZNO & JUSTIN DISTRO');
  put(3, 1, 'TIDE', '5PK .7G -- 1,200\r\n1G PREROLL- 700');
  put(4, 1, 'VOODOO', '5PK .7G -- 600'); put(5, 1, '', '1G PREROLL- 500');
  put(6, 1, JAR('BLACK MAGIC')); put(7, 1, 'STAGE DEC DROP 3 FOR NABIS');
  // Wed: a pre-roll job with no strain list (does not end the run), an older-style jar job, testing
  put(2, 2, 'PREROLLS- GRIND, PRODUCE, PACKAGE');
  put(3, 2, 'SORT/PACKAGE TO JARS (ADD VERIFICATION STICKER): SMOOTHIE', '10 LBS- 3.5G (4-5 NUG MAX)'); put(4, 2, '', '10 CASES OF 1.5G BAGS (1-2  NUG MAX)');
  put(5, 2, 'TBD - TESTING SCHEDULED FOR DEC DROP 2-  TIDEBANGER, ANTIDOTE');
  // Thu: the strain list again; Fri: no pre-rolls (the run ends); Sat: VOODOO 1g in two jobs
  put(2, 3, 'VOODOO', '5PK .7G -- 600'); put(3, 3, '', '1G PREROLL- 600');
  put(4, 3, 'TIDE', '5PK .7G -- 1,200'); put(5, 3, '', '1G PREROLL- 700'); put(6, 3, 'DEC DROP 1');
  put(2, 4, 'MAKE SURE SUPPLY COUNTS ARE ON POINT FOR 25TH & 23RD!!');
  put(2, 5, 'PREROLLS FOR CARLOS- GRIND'); put(3, 5, 'VOODOO', '1G PREROLL- 100'); put(4, 5, 'FINISH PREROLLS'); put(5, 5, 'VOODOO', '1G PREROLL- 200');
  put(2, 6, 'JUSTIN/NOURI/LORENZO OFF');
  put(11, 0, '');
  // the next week lists VOODOO too: a run never leaves its own week band
  g.push(head(['NOVEMBER, MONDAY 9TH', 'NOVEMBER, TUESDAY 10TH', 'NOVEMBER, WEDNESDAY 11TH', 'NOVEMBER, THURSDAY 12TH', 'NOVEMBER, FRIDAY 13TH',
    'NOVEMBER, SATURDAY 14TH', 'NOVEMBER,SUNDAY 15TH']));
  put(13, 0, 'VOODOO', '5PK .7G -- 600'); put(14, 0, '', '1G PREROLL- 600');
  const W = PIPE.parse(g), HEAD = 'NOVEMBER, MONDAY 2ND';
  const frozen = JSON.stringify(g);
  const cellsOf = r => r.ops.map(o => [o.r, o.c]);
  EDIT.setToday('2026-11-02');   // the made-up week is "this week"; past weeks are hidden in the sheet and never edited
  const okR = (r, why) => { assert.ok(r.ok, `${why}: ${r.message}`); return r; };
  const no = (r, re, why) => { assert.equal(r.ok, false, why); assert.match(r.message, re, why); assert.ok(!/—/.test(r.message), 'no em dash in messages'); };

  // pre-roll amount: every day of the run, only the number changes, each op carries its week header and day
  const v1 = okR(EDIT.prerollAmount(W, g, { date: '2026-11-02', strain: 'VOODOO', size: '1g', n: 450 }), 'VOODOO 1g run');
  assert.deepEqual(cellsOf(v1), [[6, 1], [5, 3], [3, 7]], 'Mon and Tue, past the listless Wednesday to Thu; Fri ends the run');
  assert.deepEqual(v1.ops.map(o => [o.expect, o.text]), [['1G PREROLL- 600', '1G PREROLL- 450'], ['1G PREROLL- 500', '1G PREROLL- 450'], ['1G PREROLL- 600', '1G PREROLL- 450']]);
  assert.ok(v1.ops.every(o => o.tab === 'DISTRO PIPELINE' && o.find.week === HEAD && o.find.day === o.c >> 1 && o.find.owner === 'VOODOO' && o.number === false), 'every op names its week, day and strain');
  assert.deepEqual([v1.intent, v1.summary], ['VOODOO 1g pre-rolls to 450, every day of the run', 'Writes 3 cells: 1G PREROLL- 450 on Mon, Tue, Thu']);
  assert.deepEqual(v1.cells.map(c => c.a1), ['B7', 'D6', 'H4']);
  assert.deepEqual(v1.reads, ['Mon Nov 2: VOODOO 1g 450', 'Tue Nov 3: VOODOO 1g 450', 'Thu Nov 5: VOODOO 1g 450']);
  {
    const after = PIPE.parse(EDIT.apply(g, v1.ops));
    const n1 = (wk, k) => after[wk].days[k].items.filter(i => i.type === 'prerolls').flatMap(i => i.lines).filter(l => l.strain === 'VOODOO' && l.size === '1g').map(l => l.n);
    assert.deepEqual([n1(0, 0), n1(0, 1), n1(0, 3), n1(0, 5), n1(1, 0)], [[450], [450], [450], [100, 200], [600]], 'the next week and the Saturday jobs keep their amounts');
    assert.equal(JSON.stringify(g), frozen, 'apply works on a copy');
  }
  const t5 = okR(EDIT.prerollAmount(W, g, { date: '2026-11-03', strain: 'TIDE', size: '5pk', n: '1500' }), 'TIDE 5-pack run');
  assert.deepEqual(t5.ops.map(o => o.text), ['5PK .7G -- 1,500', '5PK .7G -- 1,500\r\n1G PREROLL- 700', '5PK .7G -- 1,500'],
    'commas kept; in a cell holding both sizes only the 5-pack line changes and the line break stays');
  assert.equal(t5.intent, 'TIDE 5-pack pre-rolls 1200 to 1500, every day of the run');
  const only = okR(EDIT.prerollAmount(W, g, { date: '2026-11-05', strain: 'VOODOO', size: '1g', n: 450, only: true }), 'only Thursday');
  assert.deepEqual([cellsOf(only), only.intent], [[[3, 7]], 'VOODOO 1g pre-rolls 600 to 450, only Thu Nov 5']);
  no(EDIT.prerollAmount(W, g, { date: '2026-11-07', strain: 'VOODOO', size: '1g', n: 450, only: true }), /more than once on Sat/, 'two jobs list VOODOO 1g on Saturday');
  const sat = okR(EDIT.prerollAmount(W, g, { date: '2026-11-07', strain: 'VOODOO', size: '1g', n: 150, only: true, cell: [3, 11] }), 'the clicked Saturday line');
  assert.deepEqual([cellsOf(sat), sat.ops[0].text], [[[3, 11]], '1G PREROLL- 150']);
  no(EDIT.prerollAmount(W, g, { date: '2026-11-05', strain: 'VOODOO', size: '1g', n: 600, only: true }), /Nothing to change/, 'same amount');
  no(EDIT.prerollAmount(W, g, { date: '2026-11-05', strain: 'VOODOO', size: '1g', n: 'lots' }), /whole number/, 'not a number');
  no(EDIT.prerollAmount(W, g, { date: '2026-11-05', strain: 'NEBULA', size: '1g', n: 5 }), /isn't on Thu/, 'a strain the day does not list');
  no(EDIT.prerollAmount(W, g, { date: '2027-03-01', strain: 'VOODOO', size: '1g', n: 5 }), /Couldn't find that day/, 'a day the sheet does not have');
  assert.deepEqual([EDIT.rewriteAmount('1.5G PREROLL- 300', '1.5g', 250).text, EDIT.rewriteAmount('5PK- 128 UNITS', '5pk', 130).text, EDIT.rewriteAmount('JUST A NOTE', '1g', 5)],
    ['1.5G PREROLL- 250', '5PK- 130 UNITS', null], 'the amount is the first number that is not part of a size');

  // jar strain swap: only the name changes, so colored words around it keep their places
  const j1 = okR(EDIT.jarStrain(W, g, { date: '2026-11-03', strain: 'BLACK MAGIC', to: 'tea  party' }), 'BLACK MAGIC to TEA PARTY');
  assert.deepEqual(cellsOf(j1), [[9, 0], [6, 2]], 'Mon and Tue; Wednesday packs another strain');
  assert.ok(j1.ops.every(o => o.text === JAR('TEA PARTY') && o.expect === JAR('BLACK MAGIC')));
  assert.deepEqual([j1.intent, j1.summary], ['Jars BLACK MAGIC to TEA PARTY, every day of the run', 'Writes 2 cells: TEA PARTY in place of BLACK MAGIC on Mon to Tue']);
  const j2 = okR(EDIT.jarStrain(W, g, { date: '2026-11-02', strain: 'TIDE', to: 'NEBULA' }), 'TIDE--- style');
  assert.equal(j2.ops[0].text, 'SORT/PACKAGE TO JARS (ADD VERIFICATION STICKER): \nNEBULA--- 3.5G & 1.5G BUDTENDER SAMPLE', 'her spacing around --- is kept');
  const j3 = okR(EDIT.jarStrain(W, g, { date: '2026-11-04', strain: 'SMOOTHIE', to: 'ZOZA' }), 'older style with pounds');
  assert.equal(j3.ops[0].text, 'SORT/PACKAGE TO JARS (ADD VERIFICATION STICKER): ZOZA');
  {
    const wed = PIPE.parse(EDIT.apply(g, j3.ops))[0].days[2].items.find(i => i.type === 'jars').lines[0];
    assert.deepEqual([wed.strain, wed.lbs, wed.cases], ['ZOZA', 10, 10], 'the pounds and cases lines stay with it');
  }
  no(EDIT.jarStrain(W, g, { date: '2026-11-03', strain: 'BLACK MAGIC', to: 'TEA & PARTY' }), /new strain name/, 'a name the reader would not take');
  no(EDIT.jarStrain(W, g, { date: '2026-11-03', strain: 'BLACK MAGIC', to: 'Black Magic' }), /Nothing to change/, 'same strain');

  // a run never rewrites a day before today: that work is done. Those days keep what they say, and the run goes on past them
  EDIT.setToday('2026-11-05');
  const p1 = okR(EDIT.prerollAmount(W, g, { date: '2026-11-05', strain: 'VOODOO', size: '1g', n: 450 }), 'run from Thursday, today Thursday');
  assert.deepEqual([cellsOf(p1), p1.intent, p1.summary], [[[3, 7]], 'VOODOO 1g pre-rolls 600 to 450, every day of the run from today',
    'Writes 1 cell: 1G PREROLL- 450 on Thu (Mon to Tue are past and keep their amounts)'], 'Mon and Tue are past');
  EDIT.setToday('2026-11-03');
  const p2 = okR(EDIT.prerollAmount(W, g, { date: '2026-11-05', strain: 'VOODOO', size: '1g', n: 450 }), 'run from Thursday, today Tuesday');
  assert.deepEqual([cellsOf(p2), p2.summary], [[[5, 3], [3, 7]], 'Writes 2 cells: 1G PREROLL- 450 on Tue, Thu (Mon is past and keeps its amount)']);
  no(EDIT.prerollAmount(W, g, { date: '2026-11-02', strain: 'VOODOO', size: '1g', n: 450 }), /Mon Nov 2 is already past, so a change from it can't follow the run/, 'a run is never changed from a past day');
  const p3 = okR(EDIT.prerollAmount(W, g, { date: '2026-11-02', strain: 'VOODOO', size: '1g', n: 450, only: true }), 'only the past Monday');
  assert.deepEqual([cellsOf(p3), p3.intent], [[[6, 1]], 'VOODOO 1g pre-rolls 600 to 450, only Mon Nov 2'], 'a past day of this week can still be changed on its own');
  const p4 = okR(EDIT.prerollAmount(W, g, { date: '2026-11-05', strain: 'VOODOO', size: '1g', n: 450, only: true }), 'only Thursday, today Tuesday');
  assert.deepEqual([cellsOf(p4), p4.summary], [[[3, 7]], 'Writes 1 cell: 1G PREROLL- 450 on Thu'], 'only this day says nothing about past days');
  const j4 = okR(EDIT.jarStrain(W, g, { date: '2026-11-03', strain: 'BLACK MAGIC', to: 'TEA PARTY' }), 'jars from Tuesday, today Tuesday');
  assert.deepEqual([cellsOf(j4), j4.intent, j4.summary], [[[6, 2]], 'Jars BLACK MAGIC to TEA PARTY, every day of the run from today',
    'Writes 1 cell: TEA PARTY in place of BLACK MAGIC on Tue (Mon is past and keeps its strain)']);
  EDIT.setToday('2026-11-05');
  no(EDIT.jarStrain(W, g, { date: '2026-11-03', strain: 'BLACK MAGIC', to: 'TEA PARTY' }), /Tue Nov 3 is already past/, 'jars: never a run from a past day');
  const j5 = okR(EDIT.jarStrain(W, g, { date: '2026-11-04', strain: 'SMOOTHIE', to: 'ZOZA' }), 'a past day whose run is only that day');
  assert.deepEqual([cellsOf(j5), j5.intent], [cellsOf(j3), 'Jars SMOOTHIE to ZOZA, every day of the run'], 'nothing else to follow, so it is allowed');
  EDIT.setToday('2026-11-02');

  // one-line tasks: reworded in capitals; the kind of job must stay the same unless asked
  const n1 = okR(EDIT.taskText(W, g, { date: '2026-11-03', cell: [7, 2], text: 'stage dec drop 2 for nabis' }), 'Nabis line');
  assert.deepEqual([n1.ops[0].expect, n1.ops[0].text, n1.ops[0].find.day, n1.reads[0]],
    ['STAGE DEC DROP 3 FOR NABIS', 'STAGE DEC DROP 2 FOR NABIS', 1, 'Tue Nov 3: Orders & Nabis, DEC DROP 2']);
  no(EDIT.taskText(W, g, { date: '2026-11-03', cell: [7, 2], text: 'DEC DROP 3' }), /move this from Orders & Nabis to Supplies & other/, 'a Nabis line that would read as Other');
  okR(EDIT.taskText(W, g, { date: '2026-11-03', cell: [7, 2], text: 'DEC DROP 3', anyKind: true }), 'unless that is asked for');
  const t1 = okR(EDIT.taskText(W, g, { date: '2026-11-04', cell: [5, 4], text: 'TBD - TESTING SCHEDULED FOR DEC DROP 2-  TIDEBANGER, ANTIDOTE, VOODOO' }), 'testing list');
  assert.equal(t1.reads[0], 'Wed Nov 4: Testing, DEC DROP 2: TIDEBANGER, ANTIDOTE, VOODOO', 'the new strain list reads back');
  no(EDIT.taskText(W, g, { date: '2026-11-02', cell: [4, 0], text: 'PREROLLS- GRIND' }), /more than one cell/, 'a pre-roll job with its strain rows');
  no(EDIT.taskText(W, g, { date: '2026-11-03', cell: [7, 2], text: '  ' }), /Type the new wording/, 'empty wording');
  no(EDIT.taskText(W, g, { date: '2026-11-03', cell: [9, 9], text: 'X' }), /Couldn't find that line/, 'a cell with no item');
  assert.equal(t1.ops[0].text, 'TBD - TESTING SCHEDULED FOR DEC DROP 2-  TIDEBANGER, ANTIDOTE, VOODOO', 'her double space is kept');
  assert.deepEqual([EDIT.wording('FOO  BAR baz ', 'FOO  BAR ', false), EDIT.wording('FOO  baz ', 'FOO  BAR ', false), EDIT.wording('A\r\nb', 'A\r\nX', false), EDIT.wording('  new  words ', 'OLD', false),
    EDIT.wording('Keep  me', 'Keep  it', true)], ['FOO  BAR BAZ', 'FOO  BAZ ', 'A\r\nB', 'NEW WORDS', 'Keep  me'], 'only the changed stretch is tidied');
  // a past week: hidden in the sheet, so no edit is built for it
  EDIT.setToday('2026-11-09');
  no(EDIT.prerollAmount(W, g, { date: '2026-11-05', strain: 'VOODOO', size: '1g', n: 450, only: true }), /week is over/, 'last week');
  no(EDIT.taskText(W, g, { date: '2026-11-03', cell: [7, 2], text: 'stage dec drop 2 for nabis' }), /week is over/, 'last week, wording');
  assert.deepEqual([EDIT.pastDay('2026-11-08'), EDIT.pastDay('2026-11-09'), EDIT.pastDay('2026-11-15')], [true, false, false]);
  EDIT.setToday('2026-11-02');

  // Who's on: written the way Victoria writes it, and read back by the board's own crew reader
  const crewT = (date, cell, people) => EDIT.crew(W, g, { date, cell, people });
  const c1 = okR(crewT('2026-11-02', [2, 0], [{ name: 'Lorenzo', st: 'off' }, { name: 'Justin', st: 'Distro' }]), 'A3 crew line');
  assert.deepEqual([c1.ops[0].expect, c1.ops[0].text, c1.intent], ['JUSTIN DISTRO / LORENZO TRIM', 'LORENZO OFF / JUSTIN DISTRO', "Who's on, Mon Nov 2: LORENZO OFF / JUSTIN DISTRO"]);
  assert.equal(okR(crewT('2026-11-03', [2, 2], [{ name: 'JUSTIN', st: 'DISTRO' }, { name: 'NOURI', st: 'DISTRO' }]), 'two on distro').ops[0].text, 'JUSTIN & NOURI DISTRO');
  assert.equal(okR(crewT('2026-11-03', [2, 2], [{ name: 'JUSTIN', st: 'TRIM' }, { name: 'LORENZO', st: 'TRIM' }]), 'two trimming').ops[0].text, 'JUSTIN TRIM / LORENZO TRIM',
    '"JUSTIN & LORENZO TRIM" would not read as Who\'s on, so each person gets a status');
  assert.equal(okR(crewT('2026-11-08', [2, 12], [{ name: 'JUSTIN', st: 'OFF' }, { name: 'NOURI', st: 'OFF' }, { name: 'LORENZO', st: 'OOO' }]), 'Sunday').ops[0].text, 'JUSTIN OFF / NOURI OFF / LORENZO OOO');
  assert.equal(okR(crewT('2026-11-02', [3, 0], [{ name: 'NOURI', st: 'On call', note: 'distro work' }]), 'on call').ops[0].text, 'NOURI ON CALL FOR DISTRO WORK');
  assert.equal(okR(crewT('2026-11-02', [2, 0], [{ name: 'DREA', st: 'LEAD' }, { name: 'JUSTIN', st: 'OFF' }]), 'lead').ops[0].text, 'DREA DISTRO LEAD / JUSTIN OFF');
  no(crewT('2026-11-02', [2, 0], [{ name: 'LORENZO', st: 'TRIM' }]), /couldn't read that line back/, '"LORENZO TRIM" alone reads as a task, not Who\'s on');
  no(crewT('2026-11-02', [2, 0], [{ name: 'LORENZO', st: 'NAPPING' }]), /Pick a status/, 'an unknown status');
  no(crewT('2026-11-02', [2, 0], [{ name: 'JUSTIN', st: 'DISTRO' }, { name: 'LORENZO', st: 'TRIM' }]), /Nothing to change/, 'the line already says that');
  no(crewT('2026-11-03', [7, 2], [{ name: 'JUSTIN', st: 'OFF' }]), /Who's on line/, 'a Nabis line is not a crew line');

  // verify refuses what the board would read differently, or cells that are not what this page read
  const bad = (ops, check, re, why) => { const v = EDIT.verify(g, ops, check); assert.equal(v.ok, false, why); assert.ok(v.problems.some(p => re.test(p)), `${why}: ${v.problems.join(' | ')}`); };
  const ownerAt = (r, c) => { if (!(c % 2)) return undefined; for (let k = r; k > 1; k--) if ((g[k] || [])[c - 1]) return g[k][c - 1]; return ''; };
  const op = (r, c, expect, text, extra = {}) => Object.assign({ tab: 'DISTRO PIPELINE', r, c, expect, text, find: Object.assign({ week: HEAD, day: c >> 1 }, c % 2 ? { owner: ownerAt(r, c) } : {}), number: false }, extra);
  const vcheck = { kind: 'prerolls', start: '2026-11-02', strain: 'VOODOO', size: '1g', n: 450 };
  assert.ok(EDIT.verify(g, v1.ops, v1.check).ok, 'the builder\'s own ops verify');
  bad([op(6, 1, '1G PREROLL- 650', '1G PREROLL- 450')], vcheck, /changed in the sheet since/, 'a stale expect');
  bad([op(6, 1, '1G PREROLL- 600', '1G PREROLL- 450', { find: { week: HEAD, day: 0 } })], vcheck, /item it belongs to/, 'no owner');
  bad([op(6, 1, '1G PREROLL- 600', '1G PRE-ROLL- 450')], vcheck, /read differently/, 'words around the amount changed');
  bad([op(9, 0, JAR('BLACK MAGIC'), JAR('TEA PARTY').replace('VERIFICATION', 'VERIFY'))], { kind: 'jars', start: '2026-11-02', strain: 'BLACK MAGIC', to: 'TEA PARTY' }, /read differently/, 'words around the strain changed');
  bad([op(8, 1, '1G PREROLL- 700', '1G PREROLL- 450')], vcheck, /Mon Nov 2 would read differently/, 'a cell of another strain');
  bad([op(1, 0, 'NOVEMBER, MONDAY 2ND', 'NOVEMBER, MONDAY 3RD')], vcheck, /not inside a week/, 'a week header');
  bad([op(6, 1, '1G PREROLL- 600', '1G PREROLL- 450', { find: { week: HEAD, day: 3 } })], vcheck, /labelled with its week and day/, 'the wrong day');
  bad([op(6, 1, '1G PREROLL- 600', '1G PREROLL- 450', { find: { week: 'NOVEMBER, MONDAY 9TH', day: 0 } })], vcheck, /labelled with its week and day/, 'the wrong week header');
  bad([op(11, 0, '', 'NEW TASK')], { kind: 'task', start: '2026-11-02' }, /only cells that already hold something/, 'an empty cell');
  {
    const gO = EDIT.apply(g, [{ r: 6, c: 14, text: 'X' }]), v = EDIT.verify(gO, [op(6, 14, 'X', 'Y')], vcheck);
    assert.ok(!v.ok && v.problems.some(p => /columns A to N/.test(p)), 'past column N');
  }
  bad(Array.from({ length: 21 }, (_, i) => op(6, 1, '1G PREROLL- 600', '1G PREROLL- 45' + i)), vcheck, /at most 20 cells/, 'too many cells');
  bad([op(6, 1, '1G PREROLL- 600', '1G PREROLL- 450'), op(6, 1, '1G PREROLL- 600', '1G PREROLL- 451')], vcheck, /changed twice/, 'one cell twice');
  bad([op(7, 2, 'STAGE DEC DROP 3 FOR NABIS', 'TIDE')], { kind: 'task', start: '2026-11-02', type: 'orders' }, /move this from|read differently/, 'a reword that turns into a strain row');

  assert.deepEqual([EDIT.kindsFor(W[0].days[0].items.find(i => i.type === 'prerolls')), EDIT.kindsFor(W[0].days[0].items.find(i => i.type === 'jars')),
    EDIT.kindsFor(W[0].days[0].items.find(i => i.type === 'crew')), EDIT.kindsFor(W[0].days[1].items.find(i => i.type === 'orders'))],
  [['prerollAmount'], ['jarStrain'], ['crew', 'taskText'], ['taskText']], 'the edits each item offers');

  // supplies: counts as numbers, STATUS / PAR / NOTES as text, never TOTAL QTY; the row found by item + category, the column by header
  const sup1 = (item, header, value) => EDIT.supply(sp, { item, header, value });
  const s1 = okR(sup1(jar, '23RD', 50000), 'a site count');
  assert.deepEqual(s1.ops, [{ tab: 'DISTRO SUPPLY', r: 1, c: 5, expect: '50352', text: '50000', find: { item: 'Jar - 3.5g', category: 'JAR', header: '23RD' }, number: true }]);
  assert.deepEqual([s1.intent, s1.reads], ['Jar - 3.5g: 23RD count 50352 to 50000', ['Jar - 3.5g: 23RD count 50000']]);
  assert.deepEqual(okR(sup1(jar, 'portal', '12'), 'an empty count').ops[0], { tab: 'DISTRO SUPPLY', r: 1, c: 7, expect: '', text: '12', find: { item: 'Jar - 3.5g', category: 'JAR', header: 'PORTAL' }, number: true },
    'a count may fill an empty cell');
  no(sup1(bl, '25TH', '1,200'), /Nothing to change/, '"1,200" is 1200');
  no(sup1(bundle, 'VOID', 7), /has words in it/, 'a count with words is left to the sheet');
  no(sup1(jar, '23RD', -5), /as a number/, 'a negative count');
  const st1 = okR(sup1(lid, 'status', 'in stock'), 'status');
  assert.deepEqual([st1.ops[0].expect, st1.ops[0].text, st1.ops[0].number, st1.ops[0].find.category], ['Running Low', 'IN STOCK', false, 'LIDS']);
  no(sup1(lid, 'STATUS', 'maybe'), /Pick a status/, 'not a status');
  const par = okR(sup1(jar, 'PAR', '25,000'), 'PAR');
  assert.deepEqual([par.ops[0].expect, par.ops[0].text, par.ops[0].number, par.ops[0].find.header], ['20,000', '25000', true, 'PAR'], 'PAR goes as a number; its header is named without the sheet\'s trailing space');
  assert.equal(okR(sup1(jar, 'NOTES', '  50K jar order   arrives Friday '), 'notes').ops[0].text, '50K jar order arrives Friday');
  no(sup1(jar, 'NOTES', ''), /later release/, 'a note is not emptied in 1a');
  // an item listed twice (same name and category) can't be told apart by the save program
  const twin = Object.assign({}, sp, { items: [...sp.items, Object.assign({}, jar, { r: 99 })], grid: Object.assign([], sp.grid, { 99: sp.grid[jar.r] }) });
  no(EDIT.supply(twin, { item: jar, header: '23RD', value: 5 }), /listed twice/, 'a twin row');
  assert.equal(EDIT.listedTwice(sp, jar), false);
  no(sup1(bl, 'NOTES', 'new note'), /no NOTES in the sheet yet/, 'release 1a does not fill an empty note');
  no(sup1(jar, 'TOTAL QTY', 1), /sheet's own sum/, 'TOTAL QTY');
  no(sup1(jar, 'Vendor', 'X'), /Only the site counts/, 'vendor');
  {
    const bs = (ops, re, why) => { const v = EDIT.verify(sp.grid, ops, { kind: 'supply', tab: 'DISTRO SUPPLY' }); assert.equal(v.ok, false, why); assert.ok(v.problems.some(p => re.test(p)), `${why}: ${v.problems.join(' | ')}`); };
    const sop = (c, header, text, number, extra = {}) => Object.assign({ tab: 'DISTRO SUPPLY', r: 1, c, expect: sp.grid[1][c], text, find: { item: 'Jar - 3.5g', category: 'JAR', header }, number }, extra);
    assert.ok(EDIT.verify(sp.grid, s1.ops, s1.check).ok);
    bs([sop(4, '23RD', '5', true)], /not under 23RD/, 'a header that is not the cell\'s column');
    bs([sop(2, 'TOTAL QTY', '5', true)], /never written/, 'TOTAL QTY by hand');
    bs([sop(5, '23RD', '5', false)], /written as a number/, 'a count sent as text');
    bs([sop(5, '23RD', '5', true, { find: { item: 'Lid - 1g', category: 'JAR', header: '23RD' } })], /row of the item it names/, 'another item\'s name');
  }
  const acc1 = SUP.parse('Column 1,ITEM,TOTAL QTY,STATUS,PAR ,23RD,25TH,PORTAL,MYLARS,Vendor ,NOTES\nWizzy Lego,ACCESSORY,1560,IN STOCK,,,,1560,,,', 'ACCESSORY SUPPLY');
  no(EDIT.supply(acc1, { item: acc1.items[0], header: 'PAR', value: 100 }), /no PAR in the sheet yet/, 'an empty PAR');
  assert.equal(okR(EDIT.supply(acc1, { item: acc1.items[0], header: 'MYLARS', value: 3 }), 'accessory count').ops[0].tab, 'ACCESSORY SUPPLY');
  console.log('edit model: pre-roll amounts, jar strains, task wording, Who\'s on and supplies build and read back right');

  // release 1b, adding a line: it goes in the row under the day's last line (never a new row), names that last line and a
  // line of the same kind to take the look from (CONTRACT.md "Op: add a line"), and the day must read as before plus it
  {
    EDIT.setToday('2026-11-02');
    const D = k => `2026-11-0${2 + k}`;   // Mon Nov 2 + k days
    const TIDE_JAR = 'SORT/PACKAGE TO JARS (ADD VERIFICATION STICKER): \nTIDE--- 3.5G & 1.5G BUDTENDER SAMPLE', TESTING = 'TBD - TESTING SCHEDULED FOR DEC DROP 2-  TIDEBANGER, ANTIDOTE';
    const NABIS = { date: D(1), text: 'STAGE DEC DROP 3 FOR NABIS' }, at1 = o => EDIT.a1(o.r, o.c);
    // where each day's line goes: the row under its last line, whatever column that line is in
    const sl = [0, 1, 2, 3, 4, 5, 6].map(k => EDIT.slotOf(W, g, D(k)));
    assert.deepEqual(sl.map(s => EDIT.a1(s.r, s.c)), ['A12', 'C9', 'E7', 'G8', 'I4', 'K7', 'M4'], 'each day: the row under its last line');
    assert.deepEqual(sl.map(s => [s.after, s.afterOwner, s.full]).slice(0, 3), [[TIDE_JAR, '', false], ['STAGE DEC DROP 3 FOR NABIS', '', false], [TESTING, '', false]]);
    const s9 = EDIT.slotOf(W, g, '2026-11-09'), s10 = EDIT.slotOf(W, g, '2026-11-10');
    assert.deepEqual([s9.r, s9.after, s9.afterOwner, s9.full, s9.lastWeek], [15, '1G PREROLL- 600', 'VOODOO', true, true],
      'the last week ends after its last row holding text: Monday Nov 9 is full; its last line is in the right column, with its owner');
    assert.deepEqual([s10.r, s10.after, s10.afterOwner, s10.full], [13, '', '', false], 'an empty day: the row under the header');

    // Copy a line: one-line items only, no Who's on lines, nothing the day has already
    assert.deepEqual(EDIT.addSources(W, g, D(3)).map(s => [s.label, s.text]), [['Tue Nov 3', 'STAGE DEC DROP 3 FOR NABIS'],
      ['Wed Nov 4', 'PREROLLS- GRIND, PRODUCE, PACKAGE'], ['Wed Nov 4', TESTING], ['Fri Nov 6', 'MAKE SURE SUPPLY COUNTS ARE ON POINT FOR 25TH & 23RD!!']],
    'what Thursday can copy');
    const cp = okR(EDIT.addItem(W, g, { mode: 'copy', date: D(3), source: NABIS }), 'copy the Tuesday Nabis line to Thursday');
    assert.deepEqual(cp.ops, [{ kind: 'add', tab: 'DISTRO PIPELINE', r: 7, c: 6, expect: '', text: 'STAGE DEC DROP 3 FOR NABIS',
      find: { week: HEAD, day: 3, after: 'DEC DROP 1', afterOwner: '' }, like: { week: HEAD, day: 1, text: 'STAGE DEC DROP 3 FOR NABIS' }, number: false }],
    'the op as CONTRACT.md has it');
    assert.deepEqual([cp.intent, cp.summary, cp.reads, cp.cells[0].range, cp.cells[0].like], ['Add to Thu Nov 5: STAGE DEC DROP 3 FOR NABIS',
      'Adds 1 line: STAGE DEC DROP 3 FOR NABIS on Thu (G8), styled like C8', ['Thu Nov 5: Orders & Nabis, DEC DROP 3'], 'G8:H8', 'C8']);
    {
      const thu = PIPE.parse(EDIT.apply(g, cp.ops))[0].days[3].items;
      assert.deepEqual(thu.map(i => [i.type, i.cell]), [['prerolls', null], ['other', [6, 6]], ['orders', [7, 6]]], 'Thursday reads as before plus the new line');
      assert.equal(JSON.stringify(g), frozen, 'apply works on a copy');
    }
    const cp3 = okR(EDIT.addItem(W, g, { mode: 'copy', date: D(3), days: [D(5), D(3), D(4)], source: NABIS, text: 'stage dec drop 1 for nabis' }), 'reworded, on three days');
    assert.deepEqual(cp3.ops.map(o => [at1(o), o.text, o.find.after, o.like.day]), [['G8', 'STAGE DEC DROP 1 FOR NABIS', 'DEC DROP 1', 1],
      ['I4', 'STAGE DEC DROP 1 FOR NABIS', 'MAKE SURE SUPPLY COUNTS ARE ON POINT FOR 25TH & 23RD!!', 1], ['K7', 'STAGE DEC DROP 1 FOR NABIS', 'VOODOO', 1]]);
    assert.deepEqual([cp3.summary, cp3.reads.length], ['Adds 3 lines: STAGE DEC DROP 1 FOR NABIS on Thu to Sat (G8, I4, K7), styled like C8', 3]);
    no(EDIT.addItem(W, g, { mode: 'copy', date: D(3), source: NABIS, text: 'DEC DROP 3' }), /move this from Orders & Nabis to Supplies & other/, 'a reworded copy that changes lane');
    no(EDIT.addItem(W, g, { mode: 'copy', date: D(1), source: NABIS }), /Tue already has a line that says exactly that/, 'a twin line on the day');
    no(EDIT.addItem(W, g, { mode: 'copy', date: D(3), days: [D(3), D(3)], source: NABIS }), /one line can be added to each day/, 'two lines on one day');
    no(EDIT.addItem(W, g, { mode: 'copy', date: D(3), days: [D(3), '2026-11-10'], source: NABIS }), /same week/, 'a day of another week');
    no(EDIT.addItem(W, g, { mode: 'copy', date: D(3), source: { date: D(1), text: 'NOT IN THE SHEET' } }), /isn't in the sheet the same way/, 'a line that is gone');
    no(EDIT.addItem(W, g, { mode: 'copy', date: D(3), source: { date: D(0), text: 'JUSTIN DISTRO / LORENZO TRIM' } }), /Who's on lines aren't copied/, 'a Who\'s on line');
    no(EDIT.addItem(W, g, { mode: 'copy', date: D(3), source: { date: D(0), text: 'PREROLLS- GRIND, PRODUCE, PACKAGE, ADD BATCH LABEL (ADD VERIFICATION STICKER)' } }),
      /more than one cell/, 'a pre-roll job with its strain rows');
    no(EDIT.addItem(W, g, { mode: 'copy', date: D(3), source: NABIS, text: '   ' }), /Type what the new line should say/, 'no words');

    // Jars: the nearest "STRAIN --- products" jar line with only the strain changed (Wednesday's own is the older style)
    const jr = okR(EDIT.addItem(W, g, { mode: 'jars', date: D(0), days: [D(0), D(1), D(2)], strain: 'tea  party' }), 'TEA PARTY jars, Mon to Wed');
    assert.deepEqual(jr.ops.map(o => [at1(o), o.text, o.like, o.find.after]), [['A12', JAR('TEA PARTY'), { week: HEAD, day: 0, text: JAR('BLACK MAGIC') }, TIDE_JAR],
      ['C9', JAR('TEA PARTY'), { week: HEAD, day: 1, text: JAR('BLACK MAGIC') }, 'STAGE DEC DROP 3 FOR NABIS'],
      ['E7', JAR('TEA PARTY'), { week: HEAD, day: 1, text: JAR('BLACK MAGIC') }, TESTING]]);
    assert.deepEqual([jr.summary, jr.reads], ['Adds 3 lines: TEA PARTY jars on Mon to Wed (A12, C9, E7), styled like A10, C7',
      ['Mon Nov 2: jars of TEA PARTY', 'Tue Nov 3: jars of TEA PARTY', 'Wed Nov 4: jars of TEA PARTY']]);
    {
      const wk = PIPE.parse(EDIT.apply(g, jr.ops))[0];
      assert.deepEqual(wk.days[0].items.filter(i => i.type === 'jars').map(i => i.lines.map(l => l.strain)), [['BLACK MAGIC', 'TIDE', 'TEA PARTY']],
        'Monday: the line joins the jar run the day ends with');
      assert.deepEqual(wk.days[1].items.map(i => i.type).slice(-2), ['orders', 'jars'], 'Tuesday: a jar run of its own under the Nabis line');
    }
    // a line marked urgent in the sheet (red fill) never lends its look: the next nearest one does, and Copy doesn't list it
    const urgent = (r, c) => r === 6 && c === 2;   // C7, Tuesday's jar line
    assert.equal(okR(EDIT.addItem(W, g, { mode: 'jars', date: D(1), strain: 'TEA PARTY', avoid: urgent }), 'past an urgent line').cells[0].like, 'A10');
    assert.ok(!EDIT.addSources(W, g, D(3), (r, c) => r === 7 && c === 2).some(s => s.text === 'STAGE DEC DROP 3 FOR NABIS'), 'an urgent line is not offered to copy');
    no(EDIT.addItem(W, g, { mode: 'jars', date: D(1), strain: 'BLACK MAGIC' }), /BLACK MAGIC jars are already on Tue/, 'a strain the day lists already');
    no(EDIT.addItem(W, g, { mode: 'jars', date: D(2), strain: 'smoothie' }), /SMOOTHIE jars are already on Wed/, 'also in the older style');
    no(EDIT.addItem(W, g, { mode: 'jars', date: D(3), strain: 'TEA & PARTY' }), /Type the strain name/, 'a bad strain name');
    no(EDIT.addItem(W, g, { mode: 'jars', date: D(3), strain: 'THE VOID' }), /read the new line as Orders & Nabis, not jars/, '"THE VOID" reads as an order');

    // Who's on: only for a day without one, in the look of the nearest Who's on line (an On call line for On call)
    const wo = okR(EDIT.addItem(W, g, { mode: 'crew', date: D(3), people: [{ name: 'Drea', st: 'lead' }] }), "Who's on, Thursday");
    assert.deepEqual([wo.ops[0].text, at1(wo.ops[0]), wo.ops[0].like, wo.reads], ['DREA DISTRO LEAD', 'G8', { week: HEAD, day: 1, text: 'LOREZNO & JUSTIN DISTRO' },
      ["Thu Nov 5, Who's on: DREA LEAD"]]);
    const oc = okR(EDIT.addItem(W, g, { mode: 'crew', date: D(4), people: [{ name: 'NOURI', st: 'On call', note: 'distro work' }] }), 'On call, Friday');
    assert.deepEqual([oc.ops[0].text, oc.ops[0].like.text], ['NOURI ON CALL FOR DISTRO WORK', 'NOURI ON CALL FOR PORTAL WORK']);
    no(EDIT.addItem(W, g, { mode: 'crew', date: D(0), people: [{ name: 'DREA', st: 'LEAD' }] }), /Mon already has a Who's on line/, 'a day with a Who\'s on line');
    no(EDIT.addItem(W, g, { mode: 'crew', date: D(3), people: [] }), /Pick at least one person/, 'nobody');

    // only today or later, never a hidden week, never a full day
    EDIT.setToday('2026-11-04');
    no(EDIT.addItem(W, g, { mode: 'jars', date: D(3), days: [D(1), D(3)], strain: 'TEA PARTY' }), /Tue Nov 3 is already past/, 'a day before today');
    okR(EDIT.addItem(W, g, { mode: 'jars', date: D(2), strain: 'TEA PARTY' }), 'today itself, in the look of a past day of the week');
    assert.deepEqual([EDIT.beforeToday('2026-11-03'), EDIT.beforeToday('2026-11-04')], [true, false]);
    EDIT.setToday('2026-11-09');
    no(EDIT.addItem(W, g, { mode: 'jars', date: D(3), strain: 'TEA PARTY' }), /week is over/, 'a past week');
    no(EDIT.addItem(W, g, { mode: 'jars', date: '2026-11-09', strain: 'TEA PARTY' }),
      /^Monday, Nov 9 is in the last week in the sheet, and that day has no row left under its last line\. Add the line in the sheet\.$/, 'a full day in the last week');
    no(EDIT.addItem(W, g, { mode: 'jars', date: '2026-11-10', strain: 'TEA PARTY' }), /no jar line .* to copy the look from/, 'no jar line to copy the look from');
    EDIT.setToday('2026-11-02');
    {
      const g2 = EDIT.apply(g, [{ r: 11, c: 0, text: 'LABEL PREROLLS WITH THC%' }]);
      no(EDIT.addItem(PIPE.parse(g2), g2, { mode: 'copy', date: D(0), source: NABIS }),
        /^Monday, Nov 2 has no empty row left under its last line in the sheet\. Add a row at the bottom of that week in the sheet, then try again\.$/, 'a full day');
    }

    // verify: an added line only into the empty pair under the day's last line, which must be the line the op names
    const addOp = (r, c, text, after, extra = {}) => Object.assign({ kind: 'add', tab: 'DISTRO PIPELINE', r, c, expect: '', text,
      find: { week: HEAD, day: c >> 1, after, afterOwner: '' }, like: { week: HEAD, day: 1, text: 'STAGE DEC DROP 3 FOR NABIS' }, number: false }, extra);
    const ac = { kind: 'add', start: '2026-11-02', adds: [{ day: 3, mode: 'copy', type: 'orders' }, { day: 4, mode: 'copy', type: 'orders' }] };
    assert.ok(EDIT.verify(g, cp.ops, cp.check).ok && EDIT.verify(g, jr.ops, jr.check).ok, "the builder's own adds verify");
    bad([addOp(6, 6, 'STAGE DEC DROP 3 FOR NABIS', 'DEC DROP 1')], ac, /G7 is not empty in the sheet/, 'a filled slot');
    bad([addOp(8, 6, 'STAGE DEC DROP 3 FOR NABIS', 'DEC DROP 1')], ac, /G9 is not the first empty row under Thu Nov 5's last line/, 'a row lower down');
    {
      const g3 = EDIT.apply(g, [{ r: 5, c: 8, text: 'LABEL PREROLLS WITH THC%' }]), v = EDIT.verify(g3, [addOp(3, 8, 'STAGE DEC DROP 3 FOR NABIS', 'LABEL PREROLLS WITH THC%')], ac);
      assert.ok(!v.ok && v.problems.some(p => /I4 is not the first empty row under Fri Nov 6's last line/.test(p)), 'a gap above the last line');
    }
    bad([addOp(7, 6, 'STAGE DEC DROP 3 FOR NABIS', 'TIDE')], ac, /Thu Nov 5 ends with a different line in the sheet/, 'a stale after');
    bad([addOp(7, 6, 'STAGE DEC DROP 3 FOR NABIS', 'DEC DROP 1', { find: { week: HEAD, day: 3, after: 'DEC DROP 1', afterOwner: 'VOODOO' } })], ac, /ends with a different line/, 'a stale owner');
    bad([addOp(12, 2, 'STAGE DEC DROP 3 FOR NABIS', '')], ac, /C13 is not empty in the sheet/, 'a header row');
    bad([addOp(7, 7, 'STAGE DEC DROP 3 FOR NABIS', 'DEC DROP 1')], ac, /not the first column of a day/, 'the right column');
    bad([addOp(7, 6, 'STAGE DEC DROP 3 FOR NABIS', 'DEC DROP 1', { expect: 'X' })], ac, /not sent as a new line/, 'an add that expects text');
    bad([addOp(7, 6, 'STAGE DEC DROP 3 FOR NABIS', 'DEC DROP 1', { like: { week: HEAD, day: 1, text: 'GONE' } })], ac, /copies its look from isn't in the sheet/, 'a look line that is gone');
    bad([addOp(7, 6, 'STAGE DEC DROP 3 FOR NABIS', 'DEC DROP 1', { like: { week: 'NOVEMBER, MONDAY 9TH', day: 0, text: 'VOODOO' } })], ac, /is not a one-line item/, 'a look line with a detail beside it');
    bad([addOp(7, 6, 'STAGE DEC DROP 3 FOR NABIS', 'DEC DROP 1', { like: { week: 'NOVEMBER, MONDAY 99TH', day: 1, text: 'STAGE DEC DROP 3 FOR NABIS' } })], ac, /copies its look from isn't/, 'a look line in a week the sheet does not have');
    bad([addOp(7, 6, 'DEC DROP 3', 'DEC DROP 1')], ac, /move this from Orders & Nabis to Supplies & other/, 'a copy that changes lane');
    bad([addOp(7, 6, 'STAGE DEC DROP 3 FOR NABIS', 'DEC DROP 1'), op(6, 1, '1G PREROLL- 600', '1G PREROLL- 450')], ac, /saved separately/, 'an add with a rewrite');
    bad([addOp(7, 6, 'STAGE DEC DROP 3 FOR NABIS', 'DEC DROP 1'), addOp(7, 6, 'STAGE DEC DROP 2 FOR NABIS', 'DEC DROP 1')], ac, /changed twice|one line can be added/, 'two adds on one day');
    bad(Array.from({ length: 11 }, (_, i) => addOp(7, 6, 'LINE ' + i, 'DEC DROP 1')), ac, /at most 20 cells; this one changes 22/, 'eleven adds are 22 cells');
    bad([addOp(7, 6, 'STAGE DEC DROP 3 FOR NABIS', 'DEC DROP 1', { kind: 'unadd' })], ac, /only add a line/, 'the page never sends an undo of its own');
    bad([op(11, 0, '', 'NEW TASK')], { kind: 'task', start: '2026-11-02' }, /only cells that already hold something/, 'a 1a op into an empty cell is still refused');
    console.log("adding a line: slots under each day's last line, Copy, Jars and Who's on build and read back; past, full, twin, lane and look refusals hold");
  }
}

// the plan's examples on the saved copy of the live sheet (2026-11-10), when that copy is on this computer
{
  const gridFile = path.join(liveDir, 'grid.json');
  if (existsSync(gridFile)) {
    const dense = rows => { for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = []; return rows; };
    const g = [];
    for (const d of JSON.parse(readFileSync(gridFile, 'utf8')).sheets[0].data)
      (d.rowData || []).forEach((row, i) => { g[(d.startRow || 0) + i] = (row.values || []).map(v => v.formattedValue || ''); });
    dense(g);
    EDIT.setToday('2026-11-09');
    const W = PIPE.parse(g), HEAD = 'NOVEMBER, MONDAY 9TH', JAR = s => `SORT/PACKAGE TO JARS (ADD VERIFICATION STICKER): \n${s} --- 3.5G & 1.5G BUDTENDER SAMPLE`;
    const okR = (r, why) => { assert.ok(r.ok, `${why}: ${r.message}`); return r; };
    const vo = okR(EDIT.prerollAmount(W, g, { date: '2026-11-12', strain: 'VOODOO', size: '1g', n: 450 }), 'live VOODOO 1g');
    assert.deepEqual(vo.cells.map(c => c.a1), ['B651', 'D650', 'F648', 'H647', 'J648', 'L647'], 'VOODOO 1g is six cells, Mon to Sat');
    assert.ok(vo.ops.every(o => o.expect === '1G PREROLL- 600' && o.text === '1G PREROLL- 450' && o.find.week === HEAD && o.find.owner === 'VOODOO'), 'only the number changes');
    assert.deepEqual([vo.intent, vo.summary], ['VOODOO 1g pre-rolls 600 to 450, every day of the run', 'Writes 6 cells: 1G PREROLL- 450 on Mon to Sat']);
    EDIT.setToday('2026-11-10');   // the day the test copy run found it: from Thursday, Monday is past and keeps its amount
    const vt = okR(EDIT.prerollAmount(W, g, { date: '2026-11-12', strain: 'VOODOO', size: '1g', n: 450 }), 'live VOODOO 1g on Tuesday');
    assert.deepEqual([vt.cells.map(c => c.a1), vt.intent, vt.summary], [['D650', 'F648', 'H647', 'J648', 'L647'],
      'VOODOO 1g pre-rolls 600 to 450, every day of the run from today', 'Writes 5 cells: 1G PREROLL- 450 on Tue to Sat (Mon is past and keeps its amount)']);
    EDIT.setToday('2026-11-09');
    const bm = okR(EDIT.jarStrain(W, g, { date: '2026-11-11', strain: 'BLACK MAGIC', to: 'TEA PARTY' }), 'live BLACK MAGIC jars');
    assert.deepEqual(bm.cells.map(c => c.a1), ['A673', 'C671', 'E669']);
    assert.ok(bm.ops.every(o => o.expect === JAR('BLACK MAGIC') && o.text === JAR('TEA PARTY')));
    const mon = W.find(w => w.start === '2026-11-09').days[0].items.find(i => i.type === 'crew' && /LORENZO TRIM/.test(i.title));
    const cr = okR(EDIT.crew(W, g, { date: '2026-11-09', cell: mon.cell, people: [{ name: 'LORENZO', st: 'OFF' }, { name: 'JUSTIN', st: 'DISTRO' }] }), 'live crew');
    assert.deepEqual([cr.cells[0].a1, cr.ops[0].expect, cr.ops[0].text, cr.ops[0].find], ['A642', 'JUSTIN DISTRO / LORENZO TRIM', 'LORENZO OFF / JUSTIN DISTRO', { week: HEAD, day: 0 }]);
    // a status change keeps how Victoria joined the note ("FOR PORTAL WORK", not "- PORTAL WORK")
    const ocDay = W.find(w => w.start === '2026-11-09').days.find(d => d.items.some(i => i.type === 'crew' && i.cell && /ON CALL FOR PORTAL WORK/.test(g[i.cell[0]][i.cell[1]])));
    if (ocDay) {
      const oc = ocDay.items.find(i => i.type === 'crew' && i.cell && /ON CALL FOR PORTAL WORK/.test(g[i.cell[0]][i.cell[1]]));
      const note = WEEK.parseCrew(g[oc.cell[0]][oc.cell[1]]).people.NOURI.note;
      assert.equal(okR(EDIT.crew(W, g, { date: ocDay.date, cell: oc.cell, people: [{ name: 'NOURI', st: 'OFF', note }] }), 'on call to off').ops[0].text, 'NOURI OFF FOR PORTAL WORK');
    }
    const nb = okR(EDIT.taskText(W, g, { date: '2026-11-12', cell: [665, 6], text: 'STAGE DEC DROP 2 FOR NABIS' }), 'live Nabis line');
    assert.deepEqual([nb.cells[0].a1, nb.ops[0].expect], ['G666', 'STAGE DEC DROP 3 FOR NABIS']);
    // every pre-roll amount and jar line from Nov 9 on can be rewritten on its own day and reads back
    let tried = 0;
    for (const w of W.filter(x => x.start >= '2026-11-09')) for (const d of w.days) {
      const lines = d.items.filter(i => i.type === 'prerolls').flatMap(i => i.lines);
      for (const size of ['5pk', '1g']) {
        const l = lines.find(x => x.size === size && x.cell);
        if (l) { okR(EDIT.prerollAmount(W, g, { date: d.date, strain: l.strain, size, n: l.n + 1, only: true, cell: l.cell }), `${d.date} ${l.strain} ${size}`); tried++; }
      }
      const jl = d.items.filter(i => i.type === 'jars').flatMap(i => i.lines).find(x => x.cell);
      if (jl) { okR(EDIT.jarStrain(W, g, { date: d.date, strain: jl.strain, to: 'ZZTEST', only: true, cell: jl.cell }), `${d.date} ${jl.strain} jars`); tried++; }
    }
    // release 1b, adding a line: the design's two examples, the full Monday of the last week, and every day from today on
    let adds = 0;
    {
      EDIT.setToday('2026-11-10');
      const no = (r, re, why) => { assert.equal(r.ok, false, why); assert.match(r.message, re, why); assert.ok(!/—/.test(r.message), 'no em dash in messages'); };
      const ad = okR(EDIT.addItem(W, g, { mode: 'copy', date: '2026-11-19', source: { date: '2026-11-20', text: g[678][8] } }), 'live copy of I679 to Thu Nov 19');
      assert.deepEqual([ad.cells[0].a1, ad.cells[0].like, ad.ops[0].find, ad.ops[0].like, ad.summary, ad.reads], ['G682', 'I679',
        { week: 'NOVEMBER, MONDAY 16TH', day: 3, after: 'TBD - TESTING SCHEDULED FOR DEC PREROLL DROP ', afterOwner: '' },
        { week: 'NOVEMBER, MONDAY 16TH', day: 4, text: 'DEC DROP 1 - STAGE FOR NABIS PICKUP' },
        'Adds 1 line: DEC DROP 1 - STAGE FOR NABIS PICKUP on Thu (G682), styled like I679', ['Thu Nov 19: Orders & Nabis, DEC DROP 1']], 'the CONTRACT.md example: G682 under G681');
      const aj = okR(EDIT.addItem(W, g, { mode: 'jars', date: '2026-11-12', strain: 'TEA PARTY' }), 'live jars on Thu Nov 12');
      assert.deepEqual([aj.cells[0].a1, aj.ops[0].text, aj.ops[0].find.after], ['G667', JAR('TEA PARTY'), 'STAGE DEC DROP 3 FOR NABIS'], 'jars go to G667, under G666');
      no(EDIT.addItem(W, g, { mode: 'jars', date: '2026-11-12', strain: 'THE VOID' }), /not jars/, 'live THE VOID reads as an order');
      no(EDIT.addItem(W, g, { mode: 'jars', date: '2027-01-18', strain: 'TEA PARTY' }), /^Monday, Jan 18 is in the last week in the sheet/, 'Mon Jan 18 has no row left (A869, A870)');
      for (const w of W.filter(x => x.start >= '2026-11-09')) for (const d of w.days) {
        if (EDIT.beforeToday(d.date)) continue;
        if (EDIT.slotOf(W, g, d.date).full) { no(EDIT.addItem(W, g, { mode: 'copy', date: d.date, source: {} }), /no row left|no empty row/, `${d.date} is full`); continue; }
        const src = EDIT.addSources(W, g, d.date)[0];
        if (src) { okR(EDIT.addItem(W, g, { mode: 'copy', date: d.date, source: src }), `${d.date} copy of ${src.text}`); adds++; }
        okR(EDIT.addItem(W, g, { mode: 'jars', date: d.date, strain: 'ZZTEST' }), `${d.date} jars`); adds++;
        if (!d.items.some(i => i.type === 'crew')) { okR(EDIT.addItem(W, g, { mode: 'crew', date: d.date, people: [{ name: 'DREA', st: 'LEAD' }] }), `${d.date} Who's on`); adds++; }
      }
      EDIT.setToday('2026-11-09');
    }
    // the whole tab gives the same cells as the saved part of it
    const metaFile = path.join(liveDir, 'meta.json');
    if (existsSync(metaFile)) {
      const full = dense(JSON.parse(readFileSync(metaFile, 'utf8')).grid.rowData.map(r => (r.values || []).map(v => v.formattedValue || '')));
      const vf = okR(EDIT.prerollAmount(PIPE.parse(full), full, { date: '2026-11-12', strain: 'VOODOO', size: '1g', n: 450 }), 'whole tab VOODOO 1g');
      assert.deepEqual(vf.ops, vo.ops, 'the whole tab gives the same ops');
    }
    // one supply row from the saved DISTRO SUPPLY tab
    const supDir = path.join(liveDir, 'sup');
    const dsFile = existsSync(supDir) && readdirSync(supDir).filter(f => /^ds-\d+\.csv$/.test(f)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]).pop();
    if (dsFile) {
      const ds = SUP.parse(readFileSync(path.join(supDir, dsFile), 'utf8'), 'DISTRO SUPPLY');
      const it = ds.items.find(i => i.name === 'Black Light - 3.5g - Label');
      const s = okR(EDIT.supply(ds, { item: it, header: '23RD', value: 5000 }), 'live supply count');
      assert.deepEqual([s.cells[0].a1, s.ops[0].expect, s.ops[0].text, s.ops[0].number, s.ops[0].find], ['F11', '5250', '5000', true, { item: 'Black Light - 3.5g - Label', category: 'LABEL', header: '23RD' }]);
      const st = okR(EDIT.supply(ds, { item: it, header: 'STATUS', value: 'Running low' }), 'live supply status');
      assert.deepEqual([st.cells[0].a1, st.ops[0].expect, st.ops[0].text], ['D11', 'IN STOCK', 'RUNNING LOW']);
    }
    console.log(`edit model on the saved live sheet: the plan's examples match (VOODOO 6 cells, BLACK MAGIC jars, A642, G666${dsFile ? ', a supply row' : ''}); ${tried} more amounts and jar lines rewrite and read back`);
    console.log(`adding a line on the saved live sheet: copy of I679 lands at G682, jars at G667, Mon Jan 18 is full; ${adds} more adds from today on build and read back`);
  }
}
console.log('pipeline-check: all checks passed');
