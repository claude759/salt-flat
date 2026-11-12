// Checks the rules of the program that saves Production Pipeline edits to Victoria's sheet
// (supabase/functions/pipeline-sheet-write/rules.js): on made-up tabs laid out like DISTRO PIPELINE and DISTRO SUPPLY,
// and, when the saved reads of the real tab are on this computer (they stay out of this public repo), on real cells.
// Run: node tests/pipeline-write-check.mjs [--real=<folder holding format.json and grid.json>]
// Run this before every push that touches pipeline-sheet-write: any failure means do not push.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as R from '../supabase/functions/pipeline-sheet-write/rules.js';

const PLAN = 'DISTRO PIPELINE', SUP = 'DISTRO SUPPLY';
const PINK = { foregroundColor: { red: 0.9019608, green: 0.3529412, blue: 0.6745098 } };
const GREY = { foregroundColor: { red: 0.4, green: 0.4, blue: 0.4 } };
const BLACK = { foregroundColor: {} };
const DARKRED = { foregroundColor: { red: 0.59607846 } };
const JAR = 'SORT/PACKAGE TO JARS (ADD VERIFICATION STICKER): \nBLACK MAGIC --- 3.5G & 1.5G BUDTENDER SAMPLE';
const JAR_RUNS = [{ format: {} }, { startIndex: 21, format: PINK }, { startIndex: 47, format: {} },
  { startIndex: 48, format: BLACK }, { startIndex: 62, format: GREY }];
const TEST = 'TBD - TESTING SCHEDULED FOR DEC DROP 2-  TIDEBANGER, ANTIDOTE';
const TEST_RUNS = [{ format: DARKRED }, { startIndex: 38, format: {} }];

/* ---------- a made-up tab, shaped like a Sheets API read ---------- */

// "B7" -> [6, 1]; "A7:A8" -> a merge
const cellRef = s => { const m = /^([A-Z]+)(\d+)$/.exec(s); let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return [+m[2] - 1, c - 1]; };
const mergeRef = s => { const [a, b] = s.split(':').map(cellRef); return { startRowIndex: a[0], endRowIndex: b[0] + 1, startColumnIndex: a[1], endColumnIndex: b[1] + 1 }; };
// cells: {A1: text | number | {formula, shows} | {text, runs} | {raw: the API's CellData}}; formats: {A1: userEnteredFormat}
function sheetOf(title, cells, { merges = [], hidden = [], rows = 30, cols = 14, formats = {} } = {}) {
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({})));
  for (const [ref, v] of Object.entries(cells)) {
    const [r, c] = cellRef(ref);
    if (typeof v === 'number') grid[r][c] = { userEnteredValue: { numberValue: v }, formattedValue: String(v) };
    else if (typeof v === 'string') grid[r][c] = { userEnteredValue: { stringValue: v }, formattedValue: v };
    else if (v.raw) grid[r][c] = structuredClone(v.raw);
    else if (v.formula) grid[r][c] = { userEnteredValue: { formulaValue: v.formula }, formattedValue: v.shows };
    else grid[r][c] = { userEnteredValue: { stringValue: v.text }, formattedValue: v.text, textFormatRuns: v.runs };
  }
  for (const [ref, f] of Object.entries(formats)) { const [r, c] = cellRef(ref); grid[r][c].userEnteredFormat = structuredClone(f); }
  return { properties: { title, sheetId: 7, gridProperties: { rowCount: rows, columnCount: cols } },
    merges: merges.map(mergeRef),
    data: [{ rowMetadata: grid.map((_, r) => (hidden.includes(r + 1) ? { hiddenByUser: true } : { pixelSize: 21 })),
      rowData: grid.map(values => ({ values })) }] };
}
// rows inserted the way Sheets does it: everything at or below `at` moves down, merges move or grow
function insertRows(sheet, at, n) {
  const s = structuredClone(sheet);
  for (const d of s.data) {
    const i = at - (d.startRow || 0);
    if (i < 0 || i > (d.rowData || []).length) { if (i < 0) d.startRow = (d.startRow || 0) + n; continue; }
    d.rowData.splice(i, 0, ...Array.from({ length: n }, () => ({ values: [] })));
    d.rowMetadata.splice(i, 0, ...Array.from({ length: n }, () => ({ pixelSize: 21 })));
  }
  for (const m of s.merges || []) {
    if (m.startRowIndex >= at) { m.startRowIndex += n; m.endRowIndex += n; }
    else if (m.endRowIndex > at) m.endRowIndex += n;
  }
  return s;
}
// rows inserted from the Sheets menu: as insertRows, and each new cell takes the look of the cell above it
function insertRowsLike(sheet, at, n) {
  const s = insertRows(sheet, at, n), d = s.data.find(b => at - (b.startRow || 0) >= 1 && at - (b.startRow || 0) < (b.rowData || []).length);
  const above = d.rowData[at - 1 - (d.startRow || 0)].values || [];
  for (let k = 0; k < n; k++)
    d.rowData[at + k - (d.startRow || 0)].values = above.map(v => (v && v.userEnteredFormat ? { userEnteredFormat: structuredClone(v.userEnteredFormat) } : {}));
  return s;
}
// rows deleted the way Sheets does it: everything below `at` moves up, merges move or shrink (a merge inside is gone)
function deleteRows(sheet, at, n) {
  const s = structuredClone(sheet);
  for (const d of s.data) {
    const i = at - (d.startRow || 0);
    if (i >= 0 && i < (d.rowData || []).length) { d.rowData.splice(i, n); d.rowMetadata.splice(i, n); }
  }
  const move = x => (x <= at ? x : x >= at + n ? x - n : at);
  s.merges = (s.merges || []).map(m => ({ ...m, startRowIndex: move(m.startRowIndex), endRowIndex: move(m.endRowIndex) }))
    .filter(m => m.endRowIndex > m.startRowIndex && (m.endRowIndex - m.startRowIndex > 1 || m.endColumnIndex - m.startColumnIndex > 1));
  return s;
}
const days = (month, first) => ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']
  .map((d, k) => `${month}, ${d} ${first + k}TH`);
const header = (row, month, first) => Object.fromEntries(days(month, first).map((t, k) => [R.colName(2 * k) + row, t]));
const headerMerges = row => [0, 1, 2, 3, 4, 5, 6].map(k => `${R.colName(2 * k)}${row}:${R.colName(2 * k + 1)}${row}`);

const PLAN_CELLS = {
  A1: 'WIZARD TREES PRODUTION PIPELINE ',
  ...header(2, 'OCTOBER', 26),                                  // a past week, hidden like rows 2-637 of the real tab
  A3: 'NABIS PICK UP - NOV DROP 1',
  ...header(4, 'NOVEMBER', 9),
  A5: 'JUSTIN DISTRO / LORENZO TRIM', B5: 'OLD',                  // B5 sits under the A5:B5 merge
  A6: { text: 'PREROLLS- GRIND, PRODUCE, PACKAGE, ADD BATCH LABEL (ADD VERIFICATION STICKER)',
    runs: [{ format: BLACK }, { startIndex: 9, format: {} }, { startIndex: 51, format: PINK }] },
  A7: 'NEBULA', B7: '5PK .7G -- 600', B8: '1G PREROLL- 600',
  A9: 'VOODOO', B9: '5PK .7G -- 600', B10: '1G PREROLL- 600',
  C7: 'VOODOO', D7: '5PK .7G -- 600', D8: '1G PREROLL- 600',
  C9: 'NEBULA', D9: '5PK .7G -- 600', D10: '1G PREROLL- 600',
  A11: { text: JAR, runs: JAR_RUNS }, C11: { text: JAR, runs: JAR_RUNS },
  I12: { text: TEST, runs: TEST_RUNS },
  E13: { formula: '=6*7', shows: '42' },
  A14: 'TRIM -LORENZO', B14: 'ROOM 2 @ 23RD', B15: 'ANTIDOTE\t7\r\nZANGBANGER\t7',
  ...header(17, 'NOVEMBER', 16),
  A18: 'STAGE DEC DROP 3 FOR NABIS', G18: 'STAGE DEC DROP 3 FOR NABIS',
};
const PLAN_MERGES = ['A1:N1', ...headerMerges(2), 'A3:B3', ...headerMerges(4), 'A5:B5', 'A6:B6', 'A7:A8', 'A9:A10',
  'C7:C8', 'C9:C10', 'A11:B11', 'C11:D11', 'I12:J12', 'A14:A15', ...headerMerges(17), 'A18:B18', 'G18:H18'];
const planSheet = sheetOf(PLAN, PLAN_CELLS, { merges: PLAN_MERGES, hidden: [2, 3] });
const planGrid = sheet => ({ [PLAN]: R.gridFromSheet(sheet, PLAN) });

const SUP_CELLS = {
  A1: 'Column 1', B1: 'ITEM', C1: 'TOTAL QTY', D1: 'STATUS', E1: 'PAR ', F1: '23RD', G1: '25TH', H1: 'PORTAL', I1: 'VOID',
  J1: 'Vendor ', K1: 'NOTES',
  A2: 'Antidote - 3.5g - Label', B2: 'LABEL', C2: { formula: '=SUM(F2:I2)', shows: '700' }, D2: 'RUNNING LOW', E2: 2500, G2: 700,
  A3: 'Antidote - 3.5g - Mylar', B3: 'MYLAR', C3: { formula: '=SUM(F3:I3)', shows: '10800' }, D3: 'IN STOCK', E3: 5000, I3: 10800,
  A4: 'Bluebanger - 1g - Preroll Label', B4: 'LABEL', C4: { formula: '=SUM(F4:I4)', shows: '0' },
  A5: 'Bluebanger - 1g - Preroll Label', B5: 'LABEL', C5: { formula: '=SUM(F5:I5)', shows: '0' },
  A6: 'Glob Mops', B6: 'ACCESSORY', C6: { formula: '=SUM(F6:I6)', shows: '0' },
};
const supSheet = sheetOf(SUP, SUP_CELLS, { cols: 13 });
const supGrid = sheet => ({ [SUP]: R.gridFromSheet(sheet, SUP) });

const op = (o) => ({ tab: PLAN, number: false, ...o });
const wk = (day, owner) => ({ week: 'NOVEMBER, MONDAY 9TH', day, ...(owner ? { owner } : {}) });
const one = (res) => { assert.equal(res.ok, true, `planned: ${res.message || ''}`); return res.cells; };
// the text each run of a cell covers: [[text, format], ...]
const pieces = (text, runs) => runs.map((x, i) => [text.slice(x.startIndex || 0, i + 1 < runs.length ? runs[i + 1].startIndex : text.length), x.format]);
let n = 0;
const ok = (label) => { n++; if (process.env.VERBOSE) console.log('  ok', label); };

/* ---------- basics ---------- */

assert.equal(R.a1(649, 1), 'B650'); assert.equal(R.a1(0, 0), 'A1'); assert.equal(R.colName(13), 'N');
assert.equal(R.colName(25), 'Z'); assert.equal(R.colName(26), 'AA'); ok('A1 notation');
assert.equal(R.nl('A\r\nB\rC\nD'), 'A\nB\nC\nD'); ok('line endings');
assert.deepEqual(R.diffStretch('1G PREROLL- 600', '1G PREROLL- 450'), { p: 12, oe: 14, ne: 14 });
assert.deepEqual(R.diffStretch('DEC DROP 2', 'DEC DROP 12'), { p: 9, oe: 9, ne: 10 }); ok('one changed stretch');

/* ---------- colored words ---------- */
{
  const next = JAR.replace('BLACK MAGIC', 'TEA PARTY'), res = R.carryRuns(JAR, next, JAR_RUNS);
  assert.ok(res.ok, 'a strain swap inside one color is carried');
  assert.deepEqual(pieces(next, res.runs).map(p => p[0]),
    ['SORT/PACKAGE TO JARS ', '(ADD VERIFICATION STICKER)', ':', ' \nTEA PARTY ', '--- 3.5G & 1.5G BUDTENDER SAMPLE'],
    'the pink sticker note and the grey tail stay on the same words');
  assert.deepEqual(res.runs.map(x => x.format), [{}, PINK, {}, BLACK, GREY]);
  // a change that runs from the strain into the pink note crosses a color change
  assert.equal(R.carryRuns(JAR, JAR.replace('STICKER): \nBLACK', 'LABEL): \nRED'), JAR_RUNS).ok, false);
  // appending at the end takes the last color; inserting inside a color is fine
  const tail = R.carryRuns(JAR, JAR + ' (RUSH)', JAR_RUNS);
  assert.ok(tail.ok); assert.equal(pieces(JAR + ' (RUSH)', tail.runs).pop()[0], '--- 3.5G & 1.5G BUDTENDER SAMPLE (RUSH)');
  // at a color change an insertion is ambiguous, unless it can slide to a spot inside one color
  const AB = [{ format: {} }, { startIndex: 1, format: PINK }];
  assert.equal(R.carryRuns('AB', 'AXB', AB).ok, false, 'X between two colors is refused');
  const slid = R.carryRuns('AB', 'AAB', AB);
  assert.ok(slid.ok); assert.deepEqual(pieces('AAB', slid.runs).map(p => p[0]), ['AA', 'B'], 'an inserted A slides into the A');
  // deleting a whole colored stretch drops its run and joins the neighbours
  const del = R.carryRuns('AAABBBAAA', 'AAAAAA', [{ format: {} }, { startIndex: 3, format: PINK }, { startIndex: 6, format: {} }]);
  assert.ok(del.ok); assert.deepEqual(del.runs, [{ startIndex: 0, format: {} }]);
  // the testing line: the drop number is inside the dark red part, the strain list inside the black part
  assert.ok(R.carryRuns(TEST, TEST.replace('DROP 2', 'DROP 3'), TEST_RUNS).ok);
  assert.ok(R.carryRuns(TEST, TEST.replace('ANTIDOTE', 'ANTIDOTE, VOODOO'), TEST_RUNS).ok);
  assert.equal(R.carryRuns(TEST, TEST.replace('DEC DROP 2-  TIDE', 'JAN DROP 1, TIDE'), TEST_RUNS).ok, false);
  ok('colored words carried or refused');
}

/* ---------- DISTRO PIPELINE: finding the cell ---------- */
{
  const g = planGrid(planSheet);
  // VOODOO's 1g line on Monday: "1G PREROLL- 600" is under NEBULA too, so the strain (owner) picks the cell
  const cells = one(R.plan([op({ r: 9, c: 1, expect: '1G PREROLL- 600', text: '1G PREROLL- 450', find: wk(0, 'VOODOO') })], g));
  assert.equal(cells[0].a1, 'B10'); assert.equal(cells[0].moved, false); assert.equal(cells[0].find.owner, 'VOODOO');
  assert.deepEqual(cells[0].request, { updateCells: {
    range: { sheetId: 7, startRowIndex: 9, endRowIndex: 10, startColumnIndex: 1, endColumnIndex: 2 },
    rows: [{ values: [{ userEnteredValue: { stringValue: '1G PREROLL- 450' } }] }], fields: 'userEnteredValue' } },
    'a plain cell gets its text only, as a string');
  const twice = R.plan([op({ r: 9, c: 1, expect: '1G PREROLL- 600', text: '1G PREROLL- 450', find: wk(0) })], g);
  assert.equal(twice.reason, 'refused', 'without the strain, a detail line is refused');
  // Tuesday's VOODOO is the first block there; the op's c says which day
  assert.equal(one(R.plan([op({ r: 7, c: 3, expect: '1G PREROLL- 600', text: '1G PREROLL- 450', find: wk(1, 'VOODOO') })], g))[0].a1, 'D8');
  ok('pre-roll line found by week, day and strain');

  // Victoria adds a 2-row strain block above: the old row now holds NEBULA's 1g line, which reads the same.
  // The owner keeps the save on VOODOO's line instead of writing the wrong strain.
  const shifted = insertRows(planSheet, 6, 2);
  const s = R.gridFromSheet(shifted, PLAN);
  assert.equal(R.cellAt(s, 9, 1).text, '1G PREROLL- 600');
  assert.equal(R.ownerOf(s, 3, 9, 1), 'NEBULA');
  const moved = one(R.plan([op({ r: 9, c: 1, expect: '1G PREROLL- 600', text: '1G PREROLL- 450', find: wk(0, 'VOODOO') })], planGrid(shifted)));
  assert.equal(moved[0].a1, 'B12'); assert.equal(moved[0].moved, true);
  ok('a moved cell is found again, never the look-alike in its old row');

  // a one-line task that moved
  const t = one(R.plan([op({ r: 4, c: 0, expect: 'JUSTIN DISTRO / LORENZO TRIM', text: 'LORENZO OFF / JUSTIN DISTRO', find: wk(0) })], planGrid(insertRows(planSheet, 4, 1))));
  assert.equal(t[0].a1, 'A6'); assert.equal(t[0].moved, true);
  // changed in the sheet: conflict, and the reply says what it holds now
  const changed = R.plan([op({ r: 4, c: 0, expect: 'NOURI ON CALL', text: 'NOURI OFF', find: wk(0) })], g);
  assert.equal(changed.reason, 'conflict'); assert.equal(changed.cells[0].found, 'JUSTIN DISTRO / LORENZO TRIM');
  // the week header is gone
  assert.equal(R.plan([op({ r: 4, c: 0, expect: 'JUSTIN DISTRO / LORENZO TRIM', text: 'X', find: { week: 'NOVEMBER, MONDAY 2ND', day: 0 } })], g).reason, 'conflict');
  // the same text twice on one day with no owner to tell them apart
  const dup = sheetOf(PLAN, { ...PLAN_CELLS, A16: 'STAGE DEC DROP 3 FOR NABIS', A19: 'STAGE DEC DROP 3 FOR NABIS' }, { merges: PLAN_MERGES, hidden: [2, 3] });
  assert.equal(R.plan([op({ r: 17, c: 0, expect: 'STAGE DEC DROP 3 FOR NABIS', text: 'STAGE DEC DROP 2 FOR NABIS', find: { week: 'NOVEMBER, MONDAY 16TH', day: 0 } })], planGrid(dup)).reason, 'conflict');
  ok('conflicts: changed, week gone, two matches');

  // the jar line keeps its colors; the trim strain list keeps its \r\n
  const jar = one(R.plan([op({ r: 10, c: 0, expect: JAR, text: JAR.replace('BLACK MAGIC', 'TEA PARTY'), find: wk(0) })], g))[0];
  assert.equal(jar.request.updateCells.fields, 'userEnteredValue,textFormatRuns');
  assert.equal(jar.request.updateCells.rows[0].values[0].textFormatRuns[4].startIndex, 60);
  const trim = one(R.plan([op({ r: 14, c: 1, expect: 'ANTIDOTE\t7\nZANGBANGER\t7', text: 'ANTIDOTE\t8\nZANGBANGER\t7', find: wk(0, 'TRIM -LORENZO') })], g))[0];
  assert.equal(trim.request.updateCells.rows[0].values[0].userEnteredValue.stringValue, 'ANTIDOTE\t8\r\nZANGBANGER\t7');
  ok('rich cell sends runs; \\r\\n kept');
}

/* ---------- DISTRO PIPELINE: where it may not write ---------- */
{
  const g = planGrid(planSheet), refused = (o, re, label) => {
    const res = R.plan([op(o)], g);
    assert.equal(res.ok, false, label); assert.equal(res.reason, 'refused', `${label}: ${res.message}`);
    if (re) assert.match(res.message, re, label);
  };
  refused({ r: 2, c: 0, expect: 'NABIS PICK UP - NOV DROP 1', text: 'X', find: { week: 'OCTOBER, MONDAY 26TH', day: 0 } }, /hidden/, 'hidden row');
  refused({ r: 3, c: 0, expect: 'NOVEMBER, MONDAY 9TH', text: 'NOVEMBER, MONDAY 9TH (HALF DAY)', find: wk(0) }, /week header/, 'week header');
  refused({ r: 12, c: 4, expect: '42', text: '43', find: wk(2) }, /formula/, 'formula');
  refused({ r: 4, c: 1, expect: 'OLD', text: 'NEW', find: wk(0, 'JUSTIN DISTRO / LORENZO TRIM') }, /merged/, 'under a merge that starts elsewhere');
  refused({ r: 20, c: 0, expect: '', text: 'NEW TASK', find: wk(0) }, /already hold something/, 'empty cell');
  refused({ r: 4, c: 0, expect: 'JUSTIN DISTRO / LORENZO TRIM', text: '', find: wk(0) }, /cannot empty/, 'emptying a cell');
  refused({ r: 4, c: 14, expect: 'X', text: 'Y', find: wk(7) }, /columns A to N/, 'column O');
  refused({ r: 4, c: 2, expect: 'JUSTIN DISTRO / LORENZO TRIM', text: 'X', find: wk(0) }, /could not read/, 'c outside the day');
  refused({ tab: 'NOV 2026', r: 4, c: 0, expect: 'X', text: 'Y', find: wk(0) }, /only change the DISTRO PIPELINE/, 'other tabs');
  refused({ r: 4, c: 0, expect: 'JUSTIN DISTRO / LORENZO TRIM', text: 'JUSTIN DISTRO / LORENZO TRIM', find: wk(0) }, /already says/, 'no change');
  refused({ r: 10, c: 0, expect: JAR, text: JAR.replace('STICKER): \nBLACK', 'LABEL): \nRED'), find: wk(0) }, /different color/, 'across a color');
  const many = Array.from({ length: 21 }, () => op({ r: 4, c: 0, expect: 'A', text: 'B', find: wk(0) }));
  assert.match(R.plan(many, g).message, /At most 20/);
  const same = R.plan([op({ r: 4, c: 0, expect: 'JUSTIN DISTRO / LORENZO TRIM', text: 'A', find: wk(0) }),
    op({ r: 4, c: 0, expect: 'JUSTIN DISTRO / LORENZO TRIM', text: 'B', find: wk(0) })], g);
  assert.match(same.message, /same cell/);
  assert.equal(R.isWeekHeaderRow(g[PLAN], 3), true); assert.equal(R.isWeekHeaderRow(g[PLAN], 4), false);
  ok('hidden, header, formula, merged, empty, columns, tabs, cap, duplicates refused');
}

/* ---------- supply tabs ---------- */
{
  const g = supGrid(supSheet), sup = (o) => ({ tab: SUP, ...o });
  const find = (header, item = 'Antidote - 3.5g - Label', category = 'LABEL') => ({ item, category, header });
  const count = one(R.plan([sup({ r: 1, c: 6, expect: '700', text: '650', number: true, find: find('25TH') })], g))[0];
  assert.deepEqual(count.request.updateCells.rows[0].values[0], { userEnteredValue: { numberValue: 650 } }, 'a count is written as a number');
  assert.equal(count.after.number, 650);
  const status = one(R.plan([sup({ r: 1, c: 3, expect: 'RUNNING LOW', text: 'ON ORDER', find: find('STATUS') })], g))[0];
  assert.deepEqual(status.request.updateCells.rows[0].values[0], { userEnteredValue: { stringValue: 'ON ORDER' } }, 'a status is written as text');
  // PAR's header is "PAR " in the sheet; an empty site count may be set; 1,500 reads as 1500
  assert.equal(one(R.plan([sup({ r: 1, c: 4, expect: '2500', text: '1,500', number: true, find: find('PAR') })], g))[0].after.number, 1500);
  assert.equal(one(R.plan([sup({ r: 1, c: 5, expect: '', text: '40', number: true, find: find('23RD') })], g))[0].a1, 'F2');
  // a row inserted above: found by item, category and column header
  const moved = one(R.plan([sup({ r: 1, c: 6, expect: '700', text: '650', number: true, find: find('25TH') })], supGrid(insertRows(supSheet, 1, 1))))[0];
  assert.equal(moved.a1, 'G3'); assert.equal(moved.moved, true);
  // refusals and conflicts
  const why = o => R.plan([sup(o)], g);
  assert.match(why({ r: 1, c: 2, expect: '700', text: '650', number: true, find: find('TOTAL QTY') }).message, /formula/);
  assert.match(why({ r: 1, c: 9, expect: '', text: 'ACME', find: find('VENDOR') }).message, /only the site counts/);
  assert.match(why({ r: 1, c: 6, expect: '700', text: '650', find: find('25TH') }).message, /as numbers/);
  assert.match(why({ r: 1, c: 3, expect: 'RUNNING LOW', text: '5', number: true, find: find('STATUS') }).message, /as words/);
  assert.match(why({ r: 1, c: 6, expect: '700', text: 'lots', number: true, find: find('25TH') }).message, /number of 0 or more/);
  assert.match(why({ r: 1, c: 6, expect: '700', text: '-5', number: true, find: find('25TH') }).message, /number of 0 or more/);
  assert.match(why({ r: 5, c: 3, expect: '', text: 'IN STOCK', find: find('STATUS', 'Glob Mops', 'ACCESSORY') }).message, /already hold something/);
  assert.match(why({ r: 0, c: 3, expect: 'STATUS', text: 'X', find: find('STATUS', 'Column 1', 'ITEM') }).message, /changed since|no longer/);
  assert.equal(why({ r: 1, c: 6, expect: '800', text: '650', number: true, find: find('25TH') }).cells[0].found, '700');
  assert.match(why({ r: 3, c: 5, expect: '', text: '9', number: true, find: find('23RD', 'Bluebanger - 1g - Preroll Label') }).message, /listed twice/);
  assert.match(why({ r: 1, c: 6, expect: '700', text: '650', number: true, find: find('25TH', 'Antidote - 3.5g - Label', 'MYLAR') }).message, /no longer/);
  // the page's category spelling ("LABELS") reads as LABEL, and a count may be emptied
  const cleared = one(R.plan([sup({ r: 1, c: 6, expect: '700', text: '', number: true, find: find('25TH', 'Antidote - 3.5g - Label', 'LABELS') })], g))[0];
  assert.deepEqual(cleared.request.updateCells.rows[0].values[0], {}, 'an emptied count clears the value');
  ok('supply counts as numbers, status as text, found by item, guarded');
}

/* ---------- undo, confirm, windows ---------- */
{
  const g = planGrid(planSheet);
  // swap the jar strain and rename Monday's VOODOO with its 1g line in one save
  const p = R.plan([
    op({ r: 10, c: 0, expect: JAR, text: JAR.replace('BLACK MAGIC', 'TEA PARTY'), find: wk(0) }),
    op({ r: 8, c: 0, expect: 'VOODOO', text: 'M8', find: wk(0) }),
    op({ r: 9, c: 1, expect: '1G PREROLL- 600', text: '1G PREROLL- 450', find: wk(0, 'VOODOO') })], g);
  assert.ok(p.ok, p.message);
  assert.equal(p.cells[2].find.owner, 'M8', 'a line whose strain is renamed in the same save is found by the new name');
  // apply the writes to a copy of the tab, the way Google would
  const after = structuredClone(planSheet);
  for (const x of p.cells) {
    const v = x.request.updateCells.rows[0].values[0];
    Object.assign(after.data[0].rowData[x.r].values[x.c], { userEnteredValue: v.userEnteredValue, formattedValue: v.userEnteredValue.stringValue, textFormatRuns: v.textFormatRuns });
  }
  assert.deepEqual(R.checkWritten(p.cells, planGrid(after)), { ok: true, wrong: [] });
  assert.equal(R.checkWritten(p.cells, g).ok, false, 'the old sheet does not hold the new text');
  // undo puts back exactly the old text and colored words, found again after rows moved
  const edit = { cells: p.cells.map(x => ({ tab: x.tab, r: x.r, c: x.c, a1: x.a1, find: x.find, before: x.before, after: x.after })) };
  const u = R.plan(R.undoOps(edit), planGrid(insertRows(after, 4, 3)));
  assert.ok(u.ok, u.message);
  const jarBack = u.cells.find(x => x.before.text.includes('TEA PARTY'));
  assert.equal(jarBack.a1, 'A14'); assert.equal(jarBack.moved, true);
  assert.deepEqual(jarBack.request.updateCells.rows[0].values[0], { userEnteredValue: { stringValue: JAR }, textFormatRuns: JAR_RUNS });
  assert.equal(jarBack.request.updateCells.fields, 'userEnteredValue,textFormatRuns');
  assert.ok(u.cells.some(x => x.a1 === 'B13' && x.after.text === '1G PREROLL- 600'));
  // an undo finds nothing when the sheet was changed again since
  const later = structuredClone(after);
  later.data[0].rowData[9].values[1] = { userEnteredValue: { stringValue: '1G PREROLL- 500' }, formattedValue: '1G PREROLL- 500' };
  assert.equal(R.plan(R.undoOps(edit), planGrid(later)).reason, 'conflict');
  // a supply count set where there was none is undone by emptying it
  const sp = R.plan([{ tab: SUP, r: 1, c: 5, expect: '', text: '40', number: true, find: { item: 'Antidote - 3.5g - Label', category: 'LABEL', header: '23RD' } }], supGrid(supSheet));
  const sAfter = structuredClone(supSheet);
  sAfter.data[0].rowData[1].values[5] = { userEnteredValue: { numberValue: 40 }, formattedValue: '40' };
  const su = R.plan(R.undoOps({ cells: sp.cells }), supGrid(sAfter));
  assert.ok(su.ok, su.message); assert.deepEqual(su.cells[0].request.updateCells.rows[0].values[0], {});
  ok('undo restores exact text, colors and numbers, and refuses when the sheet moved on');

  // an undo stops when someone recolored words in the cell after the edit (the text alone still matches)
  const recolored = structuredClone(after);
  recolored.data[0].rowData[10].values[0].textFormatRuns = [{ format: {} }, { startIndex: 5, format: PINK }];
  const ru = R.plan(R.undoOps(edit), planGrid(recolored));
  assert.equal(ru.reason, 'conflict', 'recolored after the edit: undo would wipe that');
  assert.ok(ru.cells.some(x => x.a1 === 'A11'));
  ok('undo refuses when the colored words changed since the edit');

  // a week cut short by the rows that were read is a conflict, never a smaller week
  const windowed = (sheet, s, e, toEnd = false) => {
    const w = structuredClone(sheet), d = w.data[0];
    w.data = [{ startRow: s, rowData: d.rowData.slice(s, e), rowMetadata: d.rowMetadata.slice(s, e) }];
    const g = R.gridFromSheet(w, PLAN); g.toEnd = toEnd; return { [PLAN]: g };
  };
  const jarOp = [op({ r: 10, c: 0, expect: JAR, text: JAR.replace('BLACK MAGIC', 'TEA PARTY'), find: wk(0) })];
  assert.equal(R.plan(jarOp, windowed(planSheet, 3, 12)).reason, 'conflict', 'Nov 9 read only to row 12, before its end');
  assert.equal(R.plan(jarOp, windowed(planSheet, 3, 20)).ok, true, 'Nov 9 read past the next header');
  const nov16 = [op({ r: 17, c: 6, expect: 'STAGE DEC DROP 3 FOR NABIS', text: 'STAGE DEC DROP 2 FOR NABIS', find: { week: 'NOVEMBER, MONDAY 16TH', day: 3 } })];
  assert.equal(R.plan(nov16, windowed(planSheet, 16, 19)).reason, 'conflict', 'the last week read only partway');
  assert.equal(R.plan(nov16, windowed(planSheet, 16, 19, true)).ok, true, 'the last week read to the end of the sheet');
  ok('a week cut short by the read window is a conflict');

  // which rows to read: the week band and a few more, from the text-only read
  const vg = R.gridFromValues(Object.values(R.gridFromSheet(planSheet, PLAN).rows).map(row => row.map(x => x.text)), PLAN);
  assert.deepEqual(R.windowsFor(vg, [{ find: wk(0) }], 30), [[3, 24]]);
  assert.deepEqual(R.windowsFor(vg, [{ find: wk(0) }, { find: { week: 'NOVEMBER, MONDAY 16TH', day: 0 } }], 30), [[3, Infinity]], 'the last week is read to the end of the sheet');
  assert.deepEqual(R.windowsFor(vg, [{ find: { week: 'DECEMBER, MONDAY 7TH', day: 0 } }], 30), []);
  assert.equal(R.windowsFor(R.gridFromValues([], SUP), [], null), null, 'a supply tab is read whole');
  ok('read windows');
}

/* ---------- release 1b: adding a line (made-up tab) ---------- */

// Google's batchUpdate, imitated on a spreadsheets.get-shaped sheet. All or nothing: a bad request throws, and the
// sheet passed in is never changed (a changed copy is returned). updateCells with a field mask, mergeCells (MERGE_ALL
// keeps only the top-left value; it may not touch an existing merge) and unmergeCells (it may not cut a merge in
// two). With unmergeCopies, unmerging copies the top-left cell's format into the freed cells, the way the sheet looked
// after M641:M649 were unmerged; an undo must come out exact either way.
function applyRequests(sheet, requests, { unmergeCopies = true } = {}) {
  const s = structuredClone(sheet), sid = s.properties.sheetId;
  const cell = (r, c) => {
    const d = s.data.find(b => r >= (b.startRow || 0) && r < (b.startRow || 0) + (b.rowData || []).length);
    if (!d) throw new Error(`row ${r + 1} is not in the sheet`);
    const row = d.rowData[r - (d.startRow || 0)];
    row.values ||= [];
    return (row.values[c] ||= {});
  };
  const box = q => { if (q.sheetId !== sid) throw new Error('wrong sheetId'); return q; };
  const meets = (m, q) => m.startRowIndex < q.endRowIndex && q.startRowIndex < m.endRowIndex && m.startColumnIndex < q.endColumnIndex && q.startColumnIndex < m.endColumnIndex;
  const inside = (m, q) => m.startRowIndex >= q.startRowIndex && m.endRowIndex <= q.endRowIndex && m.startColumnIndex >= q.startColumnIndex && m.endColumnIndex <= q.endColumnIndex;
  const each = (q, fn) => { for (let r = q.startRowIndex; r < q.endRowIndex; r++) for (let c = q.startColumnIndex; c < q.endColumnIndex; c++) fn(r, c, r === q.startRowIndex && c === q.startColumnIndex); };
  for (const req of requests) {
    const kinds = Object.keys(req);
    if (kinds.length !== 1) throw new Error('one request per entry');
    if (kinds[0] === 'updateCells') {
      const u = req.updateCells, q = box(u.range), fields = u.fields.split(',');
      for (const f of fields) if (!['userEnteredValue', 'userEnteredFormat', 'textFormatRuns'].includes(f)) throw new Error('field mask ' + f);
      if (u.rows.length !== q.endRowIndex - q.startRowIndex) throw new Error('one row of data per row');
      each(q, (r, c) => {
        const v = u.rows[r - q.startRowIndex].values[c - q.startColumnIndex];
        if (!v) throw new Error('no data for ' + R.a1(r, c));
        const x = cell(r, c);
        if (fields.includes('userEnteredValue')) {
          if (v.userEnteredValue) { x.userEnteredValue = structuredClone(v.userEnteredValue); x.formattedValue = v.userEnteredValue.stringValue ?? String(v.userEnteredValue.numberValue); }
          else { delete x.userEnteredValue; delete x.formattedValue; }
          if (!fields.includes('textFormatRuns')) delete x.textFormatRuns;     // a new value drops the old colored words
        }
        if (fields.includes('userEnteredFormat')) { if (v.userEnteredFormat) x.userEnteredFormat = structuredClone(v.userEnteredFormat); else delete x.userEnteredFormat; }
        if (fields.includes('textFormatRuns')) { if (v.textFormatRuns) x.textFormatRuns = structuredClone(v.textFormatRuns); else delete x.textFormatRuns; }
      });
    } else if (kinds[0] === 'mergeCells') {
      const q = box(req.mergeCells.range);
      if (req.mergeCells.mergeType !== 'MERGE_ALL') throw new Error('merge type');
      if ((s.merges || []).some(m => meets(m, q))) throw new Error('merge runs into a merged cell');
      (s.merges ||= []).push({ startRowIndex: q.startRowIndex, endRowIndex: q.endRowIndex, startColumnIndex: q.startColumnIndex, endColumnIndex: q.endColumnIndex });
      each(q, (r, c, top) => { if (!top) { const x = cell(r, c); delete x.userEnteredValue; delete x.formattedValue; delete x.textFormatRuns; } });
    } else if (kinds[0] === 'unmergeCells') {
      const q = box(req.unmergeCells.range), gone = [];
      s.merges = (s.merges || []).filter(m => { if (!meets(m, q)) return true; if (!inside(m, q)) throw new Error('unmerge cuts a merge'); gone.push(m); return false; });
      if (unmergeCopies) for (const m of gone) {
        const f = cell(m.startRowIndex, m.startColumnIndex).userEnteredFormat;
        each(m, (r, c, top) => { if (!top) { const x = cell(r, c); if (f) x.userEnteredFormat = structuredClone(f); else delete x.userEnteredFormat; } });
      }
    } else throw new Error('request ' + kinds[0]);
  }
  return s;
}
// everything in a tab that a save could change: values, formats, colored words, merges, hidden rows
function tabState(sheet) {
  const cells = {}, hidden = [];
  for (const d of sheet.data) {
    (d.rowData || []).forEach((row, i) => ((row && row.values) || []).forEach((v, c) => {
      const o = {};
      for (const k of ['userEnteredValue', 'formattedValue', 'userEnteredFormat', 'textFormatRuns']) if (v && v[k] != null) o[k] = v[k];
      if (Object.keys(o).length) cells[R.a1((d.startRow || 0) + i, c)] = o;
    }));
    (d.rowMetadata || []).forEach((m, i) => { if (m && (m.hiddenByUser || m.hiddenByFilter)) hidden.push((d.startRow || 0) + i); });
  }
  const merges = (sheet.merges || []).map(m => `${R.a1(m.startRowIndex, m.startColumnIndex)}:${R.a1(m.endRowIndex - 1, m.endColumnIndex - 1)}`).sort();
  return { cells, merges, hidden };
}
// one save the way index.ts runs it: plan on the fresh tab, one batchUpdate, read back, check, and the log entry
// (pipeline_edits.cells is jsonb, so it goes through JSON)
function saveOn(sheet, ops, opts) {
  const p = R.plan(ops, planGrid(sheet));
  assert.equal(p.ok, true, `planned: ${p.message || ''}`);
  const written = applyRequests(sheet, p.requests, opts), back = planGrid(written);
  assert.deepEqual(R.checkWritten(p.cells, back), { ok: true, wrong: [] }, 'the sheet reads back as written');
  const cells = p.cells.map(x => { const a = R.readAfter(x, back); return a ? { ...x, after: a } : x; });
  return { p, sheet: written, edit: JSON.parse(JSON.stringify({ cells: cells.map(R.logCell) })) };
}
const reqKinds = p => p.requests.map(q => Object.keys(q)[0]);

// the looks on the made-up tab, stored the way the real tab stores them
const side = { style: 'SOLID', width: 1, color: {}, colorStyle: { rgbColor: {} } };
const ALL4 = { top: side, bottom: side, left: side, right: side };
const look = (o, borders = { top: side, left: side, right: side }) =>
  ({ borders, horizontalAlignment: 'CENTER', verticalAlignment: 'BOTTOM', wrapStrategy: 'WRAP', ...o });
const font = (size, extra = {}) => ({ textFormat: { fontFamily: 'Archivo', fontSize: size, bold: true, ...extra } });
const fill = rgb => ({ backgroundColor: rgb, backgroundColorStyle: { rgbColor: rgb } });
const redText = { foregroundColor: { red: 1 }, foregroundColorStyle: { rgbColor: { red: 1 } } };
const PERI = look({ ...fill({ red: 0.5372549, green: 0.5372549, blue: 0.92156863 }), ...font(16) });   // G666: no bottom side
const CYAN = look({ ...fill({ green: 1, blue: 1 }), ...font(18) }, ALL4);
const PINKF = look({ ...fill({ red: 0.9019608, green: 0.3529412, blue: 0.6745098 }), ...font(16) });
const JARF = look(font(14, redText));
const TESTF = look({ ...font(14, { foregroundColor: { red: 0.59607846 } }), verticalAlignment: 'MIDDLE' }, { bottom: side, left: side, right: side });
const TRIMF = look({ ...fill({ red: 1, green: 0.9490196, blue: 0.8 }), ...font(18) }, ALL4);
const RED14 = look(font(14, redText), { left: side, right: side });                // a leftover, like G682
const WHITE12 = look({ ...fill({ red: 1, green: 1, blue: 1 }), ...font(12) }, ALL4); // like H682
const BLACK12 = look(font(12), ALL4);
const URGENT = look({ ...fill({ red: 1 }), ...font(16) });                           // like I571
const STRUCK = look(font(16, { strikethrough: true }));
const YELLOW = look({ ...fill({ red: 1, green: 1 }), ...font(15) });
const NOBORDER = { horizontalAlignment: 'CENTER', ...font(16) };
const BLANK16 = { borders: ALL4, wrapStrategy: 'WRAP', textFormat: { fontFamily: 'Archivo', fontSize: 16 } };   // rows 871-884
const withAll4 = f => ({ ...f, borders: ALL4 });

// Week of Nov 9: every day ends differently (rows 5-11). Nov 16 holds the templates that are refused. Nov 23 is the
// last week: it ends at row 23, its last used row, and the bordered blank rows 24-30 under it are never written.
const W9 = days('NOVEMBER', 9)[0], W16 = days('NOVEMBER', 16)[0], W23 = days('NOVEMBER', 23)[0], W26 = days('OCTOBER', 26)[0];
const ADD_CELLS = {
  A1: 'WIZARD TREES PRODUTION PIPELINE ',
  ...header(2, 'OCTOBER', 26), A3: 'NABIS PICK UP - NOV DROP 1',                        // a hidden past week
  ...header(4, 'NOVEMBER', 9),
  A5: 'JUSTIN DISTRO / LORENZO TRIM', A6: { text: JAR, runs: JAR_RUNS }, A7: 'TRIM -LORENZO', B7: 'ROOM 2 @ 23RD', B8: 'ANTIDOTE\t7\r\nZANGBANGER\t7',
  C5: 'STAGE DEC DROP 3 FOR NABIS', C6: 'VOODOO', D6: '5PK .7G -- 600',                // C6:C7, its second row empty
  E5: 'NOURI ON CALL',                                                                  // E6:F6 an empty 1x2 with a red look
  I5: { text: TEST, runs: TEST_RUNS },                                                  // I6:I7 an empty 2x1
  K5: 'SMOOTHIE', L5: '5PK .7G -- 600', L6: '1G PREROLL- 600',
  M5: 'BEGIN PACKAGING JAN DROP 1',
  ...header(12, 'NOVEMBER', 16),
  A13: 'DEC DROP 1', C13: 'CALL LAB', E13: 'DONE THING', G13: 'LABELS', G14: 'LABELS', G15: 'PLAIN',
  I13: { formula: '=UPPER("loose")', shows: 'LOOSE' }, K13: 'SINGLE', M13: 'NO BORDERS',
  ...header(20, 'NOVEMBER', 23),
  A21: 'JUSTIN DISTRO', A22: 'NOURI ON CALL', A23: 'LORENZO TRIM', C21: 'JUSTIN DISTRO',
};
const ADD_MERGES = ['A1:N1', ...headerMerges(2), 'A3:B3', ...headerMerges(4), 'A5:B5', 'A6:B6', 'A7:A8', 'C5:D5', 'C6:C7',
  'E5:F5', 'E6:F6', 'I5:J5', 'I6:I7', 'K5:K6', 'M5:N5', ...headerMerges(12), 'A13:B13', 'C13:D13', 'E13:F13', 'G13:H13',
  'G14:H14', 'G15:H15', 'I13:J13', 'M13:N13', ...headerMerges(20), 'A21:B21', 'A22:B22', 'A23:B23', 'C21:D21'];
const ADD_FORMATS = {
  A3: PERI, A5: CYAN, A6: JARF, A7: TRIMF, C5: PERI, C6: BLACK12, E5: PINKF, E6: RED14, G5: RED14, H5: WHITE12,
  I5: TESTF, I6: BLACK12, K5: BLACK12, M5: PERI,
  A13: PERI, C13: URGENT, E13: STRUCK, G13: YELLOW, G14: YELLOW, I13: PERI, K13: PERI, M13: NOBORDER, N13: WHITE12,
  A21: CYAN, A22: PINKF, A23: CYAN, C21: CYAN,
  ...Object.fromEntries(Array.from({ length: 7 * 14 }, (_, i) => [R.colName(i % 14) + (24 + Math.floor(i / 14)), BLANK16])),
};
const addSheetOf = (extra = {}) => sheetOf(PLAN, { ...ADD_CELLS, ...(extra.cells || {}) },
  { merges: extra.merges || ADD_MERGES, hidden: extra.hidden || [2, 3], formats: { ...ADD_FORMATS, ...(extra.formats || {}) } });
const addSheet = addSheetOf();
// what each day of Nov 9 ends with, as the page reads the CSV ([after, afterOwner]), and where the line goes
const END9 = [['ANTIDOTE\t7\nZANGBANGER\t7', 'TRIM -LORENZO'], ['VOODOO'], ['NOURI ON CALL'], [''], [TEST], ['1G PREROLL- 600', 'SMOOTHIE'], ['BEGIN PACKAGING JAN DROP 1']];
const SLOT9 = ['A9', 'C8', 'E6', 'G5', 'I6', 'K7', 'M6'];
const END16 = ['DEC DROP 1', 'CALL LAB', 'DONE THING', 'PLAIN', 'LOOSE', 'SINGLE', 'NO BORDERS'];
const LIKE_NABIS = { week: W9, day: 1, text: 'STAGE DEC DROP 3 FOR NABIS' };         // C5, periwinkle, no bottom side
const LIKE_DROP = { week: W16, day: 0, text: 'DEC DROP 1' };                         // A13, in the next week
const addOp = (week, day, r, [after, afterOwner], like, text) => ({ kind: 'add', tab: PLAN, r, c: 2 * day, expect: '', text,
  number: false, find: { week, day, after, ...(afterOwner ? { afterOwner } : {}) }, like });
const add9 = (day, like = LIKE_NABIS, text = 'DEC DROP 1 - STAGE FOR NABIS PICKUP', r = cellRef(SLOT9[day])[0]) => addOp(W9, day, r, END9[day], like, text);
const planAdd = (ops, sheet = addSheet) => R.plan(Array.isArray(ops) ? ops : [ops], planGrid(sheet));
const refusedAdd = (ops, re, label, sheet) => {
  const res = planAdd(ops, sheet);
  assert.equal(res.reason, 'refused', `${label}: ${res.message}`); assert.match(res.message, re, label);
};
const conflictAdd = (ops, why, role, label, sheet) => {
  const res = planAdd(ops, sheet);
  assert.equal(res.reason, 'conflict', `${label}: ${res.message}`);
  assert.equal(res.cells[0].why, why, label); assert.equal(res.cells[0].role, role, label);
  return res;
};

/* ---------- 1b: where the new line goes ---------- */
{
  // an empty day (Thu Nov 12): the first row under the header; the pair gets merged
  const thu = planAdd(add9(3));
  assert.equal(thu.ok, true, thu.message);
  const x = thu.cells[0];
  assert.equal(x.kind, 'add'); assert.equal(x.a1, 'G5'); assert.equal(x.range, 'G5:H5'); assert.equal(x.moved, false);
  assert.equal(x.merged, true); assert.deepEqual(x.cleared, []);
  assert.deepEqual(reqKinds(thu), ['updateCells', 'mergeCells']);
  assert.deepEqual(thu.keys, [`${PLAN}!G5`, `${PLAN}!H5`], 'an empty day has no anchor to lock');
  const u = thu.requests[0].updateCells;
  assert.deepEqual(u.range, { sheetId: 7, startRowIndex: 4, endRowIndex: 5, startColumnIndex: 6, endColumnIndex: 8 });
  assert.equal(u.fields, 'userEnteredValue,userEnteredFormat,textFormatRuns', 'the field mask clears what the slot held');
  assert.deepEqual(thu.requests[1], { mergeCells: { range: u.range, mergeType: 'MERGE_ALL' } });
  assert.deepEqual(u.rows[0].values[0].userEnteredValue, { stringValue: 'DEC DROP 1 - STAGE FOR NABIS PICKUP' }, 'written raw, as text');
  assert.deepEqual(x.before.formats, [RED14, WHITE12], 'the leftover looks in the slot are logged for undo');
  assert.deepEqual(x.like, { ...LIKE_NABIS, a1: 'C5' });
  ok('1b: an empty day takes the row under the header');

  // after a right-column line, found with its item (Sat: L6 "1G PREROLL- 600" belongs to SMOOTHIE)
  const sat = planAdd(add9(5));
  assert.equal(sat.cells[0].a1, 'K7'); assert.deepEqual(sat.keys, [`${PLAN}!K7`, `${PLAN}!L7`, `${PLAN}!L6`], 'the anchor is locked, never written');
  const other = conflictAdd(addOp(W9, 5, 6, ['1G PREROLL- 600', 'VOODOO'], LIKE_NABIS, 'X'), 'changed', 'after', 'another strain\'s 1g line');
  assert.equal(other.cells[0].found, '1G PREROLL- 600');
  assert.equal(other.message, 'Saturday changed in the sheet since you opened this, so nothing was saved.');
  // a 2x1 strain name whose second row is empty in the CSV: the line goes under the merge, not into C7
  const tue = planAdd(add9(1, LIKE_NABIS, 'STAGE DEC DROP 1 FOR NABIS', 6));
  assert.equal(tue.cells[0].a1, 'C8'); assert.equal(tue.cells[0].moved, true, 'the page guessed C7');
  assert.deepEqual(tue.keys, [`${PLAN}!C8`, `${PLAN}!D8`, `${PLAN}!C6`]);
  // an empty 1x2 merge with a red look in the slot is reused: no new merge, the whole look replaced
  const wed = planAdd(add9(2, { week: W9, day: 2, text: 'NOURI ON CALL' }, 'JUSTIN ON CALL'));
  assert.equal(wed.cells[0].a1, 'E6'); assert.equal(wed.cells[0].merged, false); assert.equal(wed.cells[0].before.merged, true);
  assert.deepEqual(reqKinds(wed), ['updateCells']);
  assert.deepEqual(wed.cells[0].before.formats, [RED14, null]);
  assert.deepEqual(wed.requests[0].updateCells.rows[0].values, [{ userEnteredValue: { stringValue: 'JUSTIN ON CALL' }, userEnteredFormat: withAll4(PINKF) }, {}]);
  // Mon after the trim block (its list in B8, owner TRIM -LORENZO)
  assert.equal(planAdd(add9(0)).cells[0].a1, 'A9');
  ok('1b: slot under a right-column line, under a 2x1 merge, and in a reused 1x2');

  // the day changed since the page read it
  const stale = conflictAdd(addOp(W9, 0, 6, [JAR], LIKE_NABIS, 'X'), 'changed', 'after', 'a stale anchor');
  assert.equal(stale.cells[0].found, 'ANTIDOTE\t7\r\nZANGBANGER\t7', 'the reply says what the day ends with now');
  assert.equal(stale.cells[0].expect, JAR);
  assert.match(stale.message, /^Monday changed in the sheet since you opened this/);
  conflictAdd(addOp(W9, 0, 4, [''], LIKE_NABIS, 'X'), 'changed', 'after', 'an empty day that is no longer empty');
  conflictAdd(addOp(W9, 3, 4, ['SOMETHING'], LIKE_NABIS, 'X'), 'changed', 'after', 'a line that is gone');
  conflictAdd(addOp('NOVEMBER, MONDAY 2ND', 3, 4, [''], LIKE_NABIS, 'X'), 'week-gone', 'after', 'a week that is gone');
  // Victoria adds 2 rows under the header: the slot moves with the day, and the reply says so
  const pushed = planAdd(add9(0), insertRows(addSheet, 4, 2));
  assert.equal(pushed.cells[0].a1, 'A11'); assert.equal(pushed.cells[0].moved, true);
  assert.ok(pushed.keys.includes(`${PLAN}!B10`), 'the anchor moved too');
  ok('1b: a stale anchor is a conflict; inserted rows move the slot');

  // a full day: Mon Nov 9 has rows 9, 10 and 11; the fourth add is refused, and so is the first one on a full day
  let s = addSheet, after = END9[0];
  for (const [k, a] of ['A9', 'A10', 'A11'].entries()) {
    const text = `NEW LINE ${k + 1}`, res = saveOn(s, [addOp(W9, 0, 8 + k, after, LIKE_DROP, text)]);
    assert.equal(res.p.cells[0].a1, a);
    s = res.sheet; after = [text];
  }
  const full = conflictAdd(addOp(W9, 0, 11, after, LIKE_DROP, 'NEW LINE 4'), 'full', 'slot', 'a full day', s);
  assert.equal(full.message, 'Monday, Nov 9 has no empty row left under its last line in the sheet. Add a row at the bottom of that week in the sheet, then try again.');
  // the last week ends at its last used row (23): Monday is full, Tuesday has two rows, the blank rows below never
  assert.equal(R.bandEnd(R.gridFromSheet(addSheet, PLAN), { start: 19, end: 30 }), 23);
  assert.equal(R.bandEnd(R.gridFromSheet(addSheet, PLAN), { start: 3, end: 11 }), 11, 'a week ends at the next header');
  // the last week's message says so and never says to add a row: a blank row there never makes room
  const LAST_FULL = 'Monday, Nov 23 is in the last week in the sheet, and that day has no row left under its last line. Add the line in the sheet.';
  const monLast = addOp(W23, 0, 23, ['LORENZO TRIM'], LIKE_DROP, 'X');
  assert.equal(conflictAdd(monLast, 'full', 'slot', 'Mon Nov 23').message, LAST_FULL);
  for (const rows of [1, 2]) {
    const more = conflictAdd(monLast, 'full', 'slot', `Mon Nov 23 with ${rows} blank rows added under the week`, insertRows(addSheet, 23, rows));
    assert.equal(more.message, LAST_FULL, 'the same message: inserting blank rows changed nothing');
    assert.doesNotMatch(more.message, /Add a row|try again/);
  }
  assert.doesNotMatch(full.message, /last week/, 'other weeks keep their message');
  s = addSheet; after = ['JUSTIN DISTRO'];
  for (const [k, a] of ['C22', 'C23'].entries()) {
    const text = `NEW LINE ${k + 1}`, res = saveOn(s, [addOp(W23, 1, 21 + k, after, LIKE_DROP, text)]);
    assert.equal(res.p.cells[0].a1, a);
    s = res.sheet; after = [text];
  }
  const tueFull = conflictAdd(addOp(W23, 1, 23, after, LIKE_DROP, 'NEW LINE 3'), 'full', 'slot', 'Tue Nov 24, row 24 is past the week', s);
  assert.match(tueFull.message, /^Tuesday, Nov 24 is in the last week in the sheet, and that day has no row left under its last line\. Add the line in the sheet\.$/);
  assert.equal(planAdd(addOp(W23, 6, 20, [''], LIKE_DROP, 'X')).cells[0].a1, 'M21', 'an empty day in the last week');
  ok('1b: a full day is refused; the last week ends at its last used row and its message never says to add a row');
}

/* ---------- 1b: rows the line may not take ---------- */
{
  // an empty 2x1 merge starting on the slot row inside the day is cleared first (Fri Nov 13: I6:I7)
  const fri = planAdd(add9(4, { week: W9, day: 4, text: TEST }, TEST.replace('DROP 2', 'DROP 3')));
  assert.equal(fri.ok, true, fri.message);
  const x = fri.cells[0];
  assert.equal(x.a1, 'I6'); assert.deepEqual(x.cleared, ['I6:I7']); assert.equal(x.merged, true);
  assert.deepEqual(reqKinds(fri), ['unmergeCells', 'updateCells', 'mergeCells']);
  assert.deepEqual(fri.requests[0], { unmergeCells: { range: { sheetId: 7, startRowIndex: 5, endRowIndex: 7, startColumnIndex: 8, endColumnIndex: 9 } } });
  assert.deepEqual(x.before.freed, [{ r: 6, c: 8, a1: 'I7', format: null }], 'the freed cell and its earlier look are logged');
  assert.deepEqual(x.before.cleared, [{ r0: 5, r1: 7, c0: 8, c1: 9 }]);
  assert.deepEqual(fri.keys, [`${PLAN}!I6`, `${PLAN}!J6`, `${PLAN}!I7`, `${PLAN}!I5`], 'the freed cell is locked too');
  assert.equal(x.count, 3); assert.equal(x.read, 'I6:J7');
  // ...but only an empty merge that starts on the slot row, stays inside the day and the week, and hides no row
  const fri4 = add9(4, { week: W9, day: 4, text: TEST }, TEST.replace('DROP 2', 'DROP 3'));
  refusedAdd(fri4, /merged cells the app cannot clear/, 'a covered cell holds a value', addSheetOf({ cells: { I7: { raw: { userEnteredValue: { stringValue: '' }, formattedValue: '' } } } }));
  refusedAdd(fri4, /merged cells the app cannot clear/, 'a merge over a hidden row', addSheetOf({ hidden: [2, 3, 7] }));
  refusedAdd(fri4, /merged cells the app cannot clear/, 'a merge into the next day', addSheetOf({ merges: ADD_MERGES.map(m => (m === 'I6:I7' ? 'I6:K6' : m)) }));
  refusedAdd(addOp(W9, 5, 6, ['SMOOTHIE'], LIKE_NABIS, 'X'), /merged cells the app cannot clear/, 'a merge that starts above the slot',
    addSheetOf({ cells: { L6: '' }, merges: [...ADD_MERGES, 'L6:L7'] }));
  refusedAdd(addOp(W23, 1, 21, ['JUSTIN DISTRO'], LIKE_DROP, 'X'), /merged cells the app cannot clear/, 'a merge past the end of the week',
    addSheetOf({ merges: [...ADD_MERGES, 'C22:C24'] }));
  // the slot row itself: hidden, a value that shows nothing, a formula
  refusedAdd(add9(0), /hidden/, 'a hidden slot row', addSheetOf({ hidden: [2, 3, 9] }));
  refusedAdd(add9(3), /holds something the app cannot show/, 'an empty-looking value', addSheetOf({ cells: { G5: { raw: { userEnteredValue: { stringValue: '' }, formattedValue: '' } } } }));
  refusedAdd(add9(3), /formula/, 'a formula that shows nothing', addSheetOf({ cells: { H5: { formula: '=""', shows: '' } } }));
  refusedAdd(add9(3), /hidden/, 'a past week', addSheetOf({ hidden: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }));
  // a line the day already has: 1a finds lines by their text, so a twin could never be edited
  refusedAdd(add9(0, LIKE_DROP, 'JUSTIN DISTRO / LORENZO TRIM'), /already has a line that says exactly that/, 'a twin line');
  refusedAdd(add9(0, LIKE_DROP, 'TRIM -LORENZO'), /already has a line/, 'a twin of a 2x1 title');
  assert.equal(planAdd(add9(0, LIKE_DROP, 'STAGE DEC DROP 3 FOR NABIS')).ok, true, 'the same words on another day are fine');
  ok('1b: an empty 2x1 is cleared; other merges, hidden rows, hidden values and twins are refused');
}

/* ---------- 1b: the look, copied from a template ---------- */
{
  // left and right cells are copied separately; missing border sides are filled from the template's own solid black side
  const sep = planAdd(add9(3, { week: W16, day: 6, text: 'NO BORDERS' }, 'NEW LINE'));
  assert.deepEqual(sep.requests[0].updateCells.rows[0].values, [
    { userEnteredValue: { stringValue: 'NEW LINE' }, userEnteredFormat: { ...NOBORDER, borders: ALL4 } },
    { userEnteredFormat: WHITE12 }], 'no sides: solid black width 1; the right cell takes the template right cell\'s look');
  const peri = planAdd(add9(3)).requests[0].updateCells.rows[0].values;
  assert.deepEqual(peri, [{ userEnteredValue: { stringValue: 'DEC DROP 1 - STAGE FOR NABIS PICKUP' }, userEnteredFormat: withAll4(PERI) }, {}],
    'the bottom side G666-style templates lack is filled; no right look clears the slot\'s white 12 bold');
  const test = planAdd(add9(3, { week: W9, day: 4, text: TEST }, TEST.replace('DROP 2', 'DROP 3'))).requests[0].updateCells.rows[0].values[0];
  assert.deepEqual(test.userEnteredFormat.borders, ALL4, 'G681-style (no top) gets its top');
  assert.equal(test.userEnteredFormat.verticalAlignment, 'MIDDLE');
  // slotFormat: a non-black or dashed side is kept, and never copied into a missing side
  const red = { style: 'SOLID', width: 1, color: { red: 1 }, colorStyle: { rgbColor: { red: 1 } } };
  const dashed = { style: 'DASHED', width: 1, color: {} };
  assert.deepEqual(R.slotFormat({ borders: { top: red, left: dashed } }).borders, { top: red, left: dashed, bottom: side, right: side });
  assert.deepEqual(R.slotFormat({ borders: { top: red, right: side, bottom: { style: 'NONE' } } }).borders, { top: red, right: side, bottom: side, left: side });
  const kept = { borders: { top: side, bottom: side, left: side, right: side }, textFormat: { bold: true } };
  assert.deepEqual(R.slotFormat(kept), kept); assert.notEqual(R.slotFormat(kept), kept, 'a copy, never the read itself');
  // a template in the next week works; windowsFor reads that week too
  const later = planAdd(add9(3, LIKE_DROP, 'DEC DROP 2'));
  assert.equal(later.ok, true); assert.equal(later.cells[0].like.a1, 'A13');
  const vg = R.gridFromValues(R.gridFromSheet(addSheet, PLAN).rows.map(row => row.map(x => x.text)), PLAN);
  assert.deepEqual(R.windowsFor(vg, [add9(3)], 30), [[3, 19]]);
  assert.deepEqual(R.windowsFor(vg, [add9(3, LIKE_DROP)], 30), [[3, 27]], 'the template\'s week is read too');
  // the text read leaves out blank rows at the bottom: the last week is still read to the end of the sheet
  const trimmed = R.gridFromValues(R.gridFromSheet(addSheet, PLAN).rows.slice(0, 23).map(row => row.map(x => x.text)), PLAN);
  assert.deepEqual(R.windowsFor(trimmed, [{ find: { week: W23, day: 1 } }], 1000), [[19, Infinity]]);
  assert.deepEqual(R.windowsFor(trimmed, [{ find: { week: W9, day: 1 } }], 1000), [[3, 19]]);
  ok('1b: the template\'s look is copied cell by cell with border sides filled; its week is read');

  // templates that are refused or no longer found
  const like = (l, text = 'NEW LINE') => add9(3, l, text);
  const twice = conflictAdd(like({ week: W16, day: 3, text: 'LABELS' }), 'twice', 'like', 'a template on its day twice');
  assert.match(twice.message, /on its day twice/);
  const gone = conflictAdd(like({ week: W16, day: 3, text: 'NOT THERE' }), 'changed', 'like', 'a template that is gone');
  assert.equal(gone.message, 'The line the new one copies its look from changed in the sheet, so nothing was saved. Reload and try again.');
  conflictAdd(like({ week: 'DECEMBER, MONDAY 7TH', day: 0, text: 'X' }), 'week-gone', 'like', 'a template week that is gone');
  refusedAdd(like({ week: W9, day: 0, text: W9 }), /week header/, 'a week header');
  refusedAdd(like({ week: W9, day: 0, text: 'TRIM -LORENZO' }), /not a one-line item/, 'a 2x1 trim title');
  refusedAdd(like({ week: W16, day: 5, text: 'SINGLE' }), /not a one-line item/, 'a cell that is not merged');
  refusedAdd(like({ week: W16, day: 1, text: 'CALL LAB' }), /urgent or crossed out/, 'an urgent (red fill) template');
  refusedAdd(like({ week: W16, day: 2, text: 'DONE THING' }), /urgent or crossed out/, 'a crossed-out template');
  refusedAdd(like({ week: W16, day: 0, text: 'DEC DROP 1' }), /urgent or crossed out/, 'some crossed-out words',
    addSheetOf({ cells: { A13: { text: 'DEC DROP 1', runs: [{ format: {} }, { startIndex: 4, format: { strikethrough: true } }] } } }));
  refusedAdd(like({ week: W16, day: 4, text: 'LOOSE' }), /formula/, 'a formula template');
  refusedAdd(like({ week: W16, day: 3, text: 'PLAIN' }), /could not read the look/, 'a template whose look was not read');
  refusedAdd(like({ week: W26, day: 0, text: 'NABIS PICK UP - NOV DROP 1' }), /hidden past week/, 'a template in a past week');
  ok('1b: twin, gone, header, 2x1, unmerged, urgent, crossed-out, formula, unread and past templates');

  // colored words: a jar line with another strain keeps the pink note and the grey tail
  const jar = planAdd(add9(0, { week: W9, day: 0, text: JAR }, JAR.replace('BLACK MAGIC', 'TEA PARTY')));
  assert.equal(jar.ok, true, jar.message);
  const v = jar.requests[0].updateCells.rows[0].values[0];
  assert.deepEqual(v.textFormatRuns.map(x => x.startIndex), [0, 21, 47, 48, 60]);
  assert.deepEqual(pieces(v.userEnteredValue.stringValue, v.textFormatRuns).map(p => p[0]),
    ['SORT/PACKAGE TO JARS ', '(ADD VERIFICATION STICKER)', ':', ' \nTEA PARTY ', '--- 3.5G & 1.5G BUDTENDER SAMPLE']);
  assert.deepEqual(v.textFormatRuns.map(x => x.format), [{}, PINK, {}, BLACK, GREY]);
  assert.deepEqual(v.userEnteredFormat, withAll4(JARF));
  assert.deepEqual(jar.cells[0].after.runs, v.textFormatRuns);
  // a change in two places across the testing line's two colors is refused; a template with no colored words sends none
  refusedAdd(add9(3, { week: W9, day: 4, text: TEST }, TEST.replace('DEC DROP 2-  TIDE', 'JAN DROP 1, TIDE')), /Add it as it is, then change the wording/, 'two stretches');
  assert.equal('textFormatRuns' in planAdd(add9(3)).requests[0].updateCells.rows[0].values[0], false);
  // deleting the whole pink part leaves one plain run, which is not sent
  const plain = R.plan([add9(3, { week: W9, day: 0, text: JAR }, JAR.slice(0, 21) + JAR.slice(47))], planGrid(addSheetOf({
    formats: {}, cells: { A6: { text: JAR, runs: [{ format: {} }, { startIndex: 21, format: PINK }, { startIndex: 47, format: {} }] } } })));
  assert.equal(plain.ok, true, plain.message); assert.equal(plain.cells[0].after.runs, null);
  ok('1b: colored words carried from the template, or refused');
}

/* ---------- 1b: the shape of an add, and limits ---------- */
{
  const bad = (o, re, label) => { const m = R.checkOps(Array.isArray(o) ? o : [o]); assert.ok(m, label); assert.match(m, re, label); };
  const a = add9(3);
  bad({ ...a, kind: 'insert' }, /could not read/, 'an unknown kind');
  bad({ ...a, kind: 'unadd' }, /could not read/, 'an unadd without its log entry');
  bad({ ...a, restore: { text: '' } }, /could not read/, 'restore on an add');
  bad({ ...a, expect: 'X' }, /could not read/, 'expect must be empty');
  bad({ ...a, c: 7 }, /could not read/, 'the right column');
  bad({ ...a, c: 4 }, /could not read/, 'another day\'s column');
  bad({ ...a, number: true }, /could not read/, 'a number');
  bad({ ...a, like: undefined }, /could not read/, 'no template');
  bad({ ...a, like: { ...LIKE_NABIS, day: 7 } }, /could not read/, 'template day 7');
  bad({ ...a, find: { ...a.find, after: undefined } }, /could not read/, 'no anchor');
  bad({ ...a, find: { ...a.find, afterOwner: 5 } }, /could not read/, 'a bad owner');
  bad({ ...a, text: '  \n ' }, /Type what the new line should say/, 'no words');
  bad({ ...a, text: 'X'.repeat(2001) }, /too long/, 'too long');
  bad({ ...a, tab: SUP }, /only be added to the DISTRO PIPELINE/, 'a supply tab');
  bad({ ...a, tab: 'NOV 2026' }, /only change the DISTRO PIPELINE/, 'another tab');
  bad([a, op({ r: 4, c: 0, expect: 'JUSTIN DISTRO / LORENZO TRIM', text: 'X', find: wk(0) })], /saved separately/, 'an add with a rewrite');
  bad([a, { ...a, text: 'ANOTHER' }], /Only one line can be added to each day/, 'two adds on one day');
  bad([a, { ...a, find: { ...a.find, week: ' november,  monday 9th ' } }], /Only one line/, 'the same week spelled differently');
  // the existing 1a refusal of an empty cell still holds
  assert.match(R.checkOps([op({ r: 20, c: 0, expect: '', text: 'NEW TASK', find: wk(0) })]), /already hold something/);
  assert.match(R.checkOps([op({ kind: null, r: 20, c: 0, expect: '', text: 'NEW TASK', find: wk(0) })]), /already hold something/);
  // 20 cells: an add counts 2, plus the cells a cleared merge frees
  const ten = [0, 1, 2, 3, 5, 6].map(d => add9(d, LIKE_DROP, `NEW LINE ${d}`))
    .concat([0, 1, 2, 3].map(d => addOp(W16, d, 13, [END16[d]], LIKE_DROP, `NEW LINE ${d}`)));
  const p10 = planAdd(ten);
  assert.equal(p10.ok, true, p10.message); assert.equal(p10.cells.length, 10); assert.equal(p10.requests.length, 19);
  assert.match(R.checkOps([...ten, addOp(W16, 4, 13, [END16[4]], LIKE_DROP, 'X')]), /At most 20/, '11 adds');
  const withFri = ten.slice(0, 9).concat([add9(4, LIKE_DROP, 'NEW LINE 4')]);
  assert.equal(R.checkOps(withFri), null);
  assert.match(planAdd(withFri).message, /At most 20/, '9 adds and one that frees a cell: 21 cells');
  assert.equal(planAdd(withFri.slice(1)).ok, true, '8 adds and one that frees a cell: 19 cells');
  // every add is checked: one stale anchor among several is a conflict for the whole save
  const mixed = planAdd([add9(3), addOp(W9, 0, 8, [JAR], LIKE_NABIS, 'X')]);
  assert.equal(mixed.reason, 'conflict'); assert.equal(mixed.cells.length, 1);
  const two = planAdd([addOp(W9, 0, 8, [JAR], LIKE_NABIS, 'X'), addOp(W9, 6, 5, ['OLD'], LIKE_NABIS, 'X')]);
  assert.equal(two.message, '2 days changed in the sheet since you opened this, so nothing was saved.');
  ok('1b: op shape, no mixing, one add per day, 20 cells');

  // the check under the lock gives the same keys when nothing moved, other keys when the slot moved
  const before = planAdd(add9(0)), again = planAdd(add9(0));
  assert.deepEqual(again.keys, before.keys);
  assert.notDeepEqual(planAdd(add9(0), insertRows(addSheet, 4, 1)).keys, before.keys);
  ok('1b: lock keys follow the slot');
}

/* ---------- 1b: read back, log and undo ---------- */
{
  // checkWritten: the left cell holds the text and its colored words, the right cell is blank, the pair is merged
  const jarOp = add9(0, { week: W9, day: 0, text: JAR }, JAR.replace('BLACK MAGIC', 'TEA PARTY'));
  const p = planAdd(jarOp), written = applyRequests(addSheet, p.requests);
  assert.deepEqual(R.checkWritten(p.cells, planGrid(written)), { ok: true, wrong: [] });
  assert.equal(R.checkWritten(p.cells, planGrid(addSheet)).ok, false, 'the old sheet does not hold the line');
  assert.equal(R.checkWritten(p.cells, planGrid(applyRequests(addSheet, p.requests.slice(0, 1)))).ok, false, 'not merged');
  const recolor = structuredClone(written); recolor.data[0].rowData[8].values[0].textFormatRuns = [{ format: PINK }];
  assert.equal(R.checkWritten(p.cells, planGrid(recolor)).ok, false, 'other colored words');
  const filled = structuredClone(written); filled.data[0].rowData[8].values[1] = { userEnteredValue: { stringValue: 'X' }, formattedValue: 'X' };
  assert.equal(R.checkWritten(p.cells, planGrid(filled)).ok, false, 'something in the right cell');
  // readAfter and logCell: the log records both cells' looks as read back, and the merge
  const back = R.readAfter(p.cells[0], planGrid(written));
  assert.deepEqual(back, { text: JAR.replace('BLACK MAGIC', 'TEA PARTY'), runs: p.cells[0].after.runs, number: null,
    formats: [withAll4(JARF), null], merged: true });
  const logged = R.logCell({ ...p.cells[0], after: back });
  assert.deepEqual(Object.keys(logged).sort(), ['a1', 'after', 'before', 'c', 'cleared', 'find', 'kind', 'like', 'merged', 'moved', 'r', 'range', 'tab']);
  assert.deepEqual(logged.find, { week: W9, day: 0, after: END9[0][0], afterOwner: 'TRIM -LORENZO', prev: 'TRIM -LORENZO' }, 'with the line above it, for undo');
  assert.equal(R.readAfter(p.cells[0], {}), null);
  // a 1a cell's log entry and after-image keep their old shape
  const one1a = R.plan([op({ r: 4, c: 0, expect: 'JUSTIN DISTRO / LORENZO TRIM', text: 'LORENZO OFF', find: wk(0) })], planGrid(planSheet)).cells[0];
  assert.deepEqual(Object.keys(R.logCell(one1a)).sort(), ['a1', 'after', 'before', 'c', 'find', 'moved', 'r', 'tab']);
  assert.deepEqual(Object.keys(R.readAfter(one1a, planGrid(planSheet))).sort(), ['number', 'runs', 'text']);
  ok('1b: checkWritten, readAfter and the log entry');

  // undo round trips: add, write, undo, write: the whole tab is exactly as it was (values, looks, colored words, merges)
  const roundTrip = (ops, label, { between = s => s, start = addSheet, ...opts } = {}) => {
    const added = saveOn(start, ops, opts);
    const moved = between(added.sheet);
    const u = R.plan(R.undoOps(added.edit), planGrid(moved));
    assert.equal(u.ok, true, `${label}: undo planned: ${u.message || ''}`);
    assert.ok(u.cells.every(x => x.kind === 'unadd'));
    const undone = saveOn(moved, R.undoOps(added.edit), opts);
    assert.deepEqual(tabState(undone.sheet), tabState(between(start)), `${label}: the tab is exactly as before`);
    return { added, undone, u };
  };
  for (const unmergeCopies of [true, false]) {
    const o = { unmergeCopies };
    const thu = roundTrip([add9(3)], 'a new merge', o);
    assert.deepEqual(reqKinds(thu.u), ['unmergeCells', 'updateCells'], 'only the merge the add made is undone');
    assert.deepEqual(thu.u.requests[1].updateCells.rows[0].values, [{ userEnteredFormat: RED14 }, { userEnteredFormat: WHITE12 }]);
    const wed = roundTrip([add9(2, { week: W9, day: 2, text: 'NOURI ON CALL' }, 'JUSTIN ON CALL')], 'a reused merge', o);
    assert.deepEqual(reqKinds(wed.u), ['updateCells'], 'a merge that was there before stays');
    const fri = roundTrip([add9(4, { week: W9, day: 4, text: TEST }, TEST.replace('DROP 2', 'DROP 3'))], 'a cleared merge', o);
    assert.deepEqual(reqKinds(fri.u), ['unmergeCells', 'updateCells', 'updateCells', 'mergeCells']);
    assert.equal(fri.u.cells[0].read, 'I6:J7');
    roundTrip([jarOp], 'colored words', o);
    roundTrip([add9(3), add9(4, { week: W9, day: 4, text: TEST }, TEST.replace('DROP 2', 'DROP 3')), add9(5, LIKE_DROP, 'X')], 'three days in one save', o);
    // rows inserted above between the add and the undo: the line and the merge it cleared are found where they went
    const pushed = roundTrip([add9(4, { week: W9, day: 4, text: TEST }, TEST.replace('DROP 2', 'DROP 3'))], 'rows inserted between', { ...o, between: s => insertRows(s, 4, 2) });
    assert.equal(pushed.u.cells[0].a1, 'I8'); assert.equal(pushed.u.cells[0].moved, true); assert.deepEqual(pushed.u.cells[0].cleared, ['I8:I9']);
  }
  ok('1b: undo puts the whole tab back exactly (new, reused and cleared merges, rows moved)');

  // undo is refused when the line is no longer as the add left it, and nothing is written
  const added = saveOn(addSheet, [add9(3), add9(4, { week: W9, day: 4, text: TEST }, TEST.replace('DROP 2', 'DROP 3'))]);
  const S = added.sheet, cellAtS = (sh, ref) => { const [r, c] = cellRef(ref); return sh.data[0].rowData[r].values[c]; };
  const undoOn = change => { const sh = structuredClone(S); change(sh); return R.plan(R.undoOps(added.edit), planGrid(sh)); };
  const refusedUndo = (change, label, why = 'changed') => {
    const res = undoOn(change);
    assert.equal(res.reason, 'conflict', `${label}: ${res.message}`); assert.equal(res.cells[0].why, why, label);
    assert.equal(res.cells[0].role, 'line', label);
    return res;
  };
  assert.equal(undoOn(() => {}).ok, true);
  const reworded = refusedUndo(sh => { Object.assign(cellAtS(sh, 'G5'), { userEnteredValue: { stringValue: 'DEC DROP 1 - NABIS' }, formattedValue: 'DEC DROP 1 - NABIS' }); }, 'reworded in the sheet or by 1a');
  assert.match(reworded.message, /changed in the sheet since it was added/);
  refusedUndo(sh => { cellAtS(sh, 'G5').userEnteredFormat.backgroundColor = { red: 1 }; }, 'marked urgent');
  refusedUndo(sh => { cellAtS(sh, 'H5').userEnteredFormat = { textFormat: { bold: true } }; }, 'the right cell\'s look changed');
  refusedUndo(sh => { cellAtS(sh, 'G5').textFormatRuns = [{ format: {} }, { startIndex: 4, format: PINK }]; }, 'some words recolored');
  refusedUndo(sh => { Object.assign(cellAtS(sh, 'H5'), { userEnteredValue: { stringValue: 'NOTE' }, formattedValue: 'NOTE' }); }, 'a filled right cell');
  refusedUndo(sh => { sh.merges = sh.merges.filter(m => !(m.startRowIndex === 4 && m.startColumnIndex === 6)); }, 'unmerged by hand');
  refusedUndo(sh => { Object.assign(cellAtS(sh, 'I7'), { userEnteredValue: { stringValue: 'X' }, formattedValue: 'X' }); }, 'the freed cell was filled');
  refusedUndo(sh => { sh.merges.push(mergeRef('I7:J7')); }, 'the freed cell was merged');
  // a twin of the line typed right under it: the undo finds its own line by the line it was added under (find.prev)
  // and takes that one out, never the twin; an add logged before find.prev existed still refuses a twin
  const LINE = 'DEC DROP 1 - STAGE FOR NABIS PICKUP', say = (sh, ref, t) => Object.assign(cellAtS(sh, ref), { userEnteredValue: { stringValue: t }, formattedValue: t });
  const twinUnder = undoOn(sh => say(sh, 'G6', LINE));
  assert.equal(twinUnder.ok, true, twinUnder.message); assert.equal(twinUnder.cells[0].a1, 'G5', 'its own line, not the twin under it');
  const legacy = JSON.parse(JSON.stringify({ cells: added.edit.cells.map(x => ({ ...x, find: { ...x.find, prev: undefined } })) }));
  const legacyTwin = structuredClone(S); say(legacyTwin, 'G6', LINE);
  const lt = R.plan(R.undoOps(legacy), planGrid(legacyTwin));
  assert.equal(lt.reason, 'conflict'); assert.equal(lt.cells[0].why, 'twice', 'logged without prev: a twin is refused');
  // its own line reworded in the sheet and its words typed on the next row: that row is never taken for it
  refusedUndo(sh => { say(sh, 'G5', 'DEC DROP 1 - DONE'); say(sh, 'G6', LINE); }, 'reworded, with its words typed on the next row');
  // a hidden row is refused (reason 'refused', the hidden-row message, no role), not a conflict, as CONTRACT.md says
  const hid = undoOn(sh => { sh.data[0].rowMetadata[4] = { hiddenByUser: true }; });
  assert.equal(hid.reason, 'refused'); assert.equal(hid.message, R.MSG.hidden); assert.equal(hid.cells[0].role, undefined);
  // an undo of an undo, or of a kind this program does not know, is refused before reading the sheet
  assert.match(R.checkOps(R.undoOps({ cells: [{ kind: 'unadd', tab: PLAN, r: 4, c: 6, find: { week: W9, day: 3 }, before: {}, after: {} }] })), /could not read/);
  ok('1b: undo refused after a rewording, a recolor, a filled or freed cell, a hand unmerge, a hidden row; a twin is never taken for it');

  // [1]/[6] the look each freed cell has right after the add is logged from the read-back, and an undo that would wipe
  // a look given to it by hand since is refused (it would otherwise write the earlier look over it and merge it away)
  const fri = added.edit.cells.find(x => x.a1 === 'I6');
  assert.deepEqual(fri.after.freed, [{ a1: 'I7', format: BLACK12 }], 'Google gave the freed I7 the merge\'s look; that is logged');
  assert.deepEqual(R.undoOps({ cells: [fri] })[0].undo.freed, [{ r: 6, c: 8, a1: 'I7', format: null, after: BLACK12 }]);
  refusedUndo(sh => { cellAtS(sh, 'I7').userEnteredFormat = { ...BLACK12, ...fill({ red: 1, green: 1 }) }; }, 'the freed cell filled yellow by hand');
  refusedUndo(sh => { delete cellAtS(sh, 'I7').userEnteredFormat; }, 'the freed cell\'s look cleared by hand');
  // when unmerging leaves the freed cell its own look, that is what is logged and compared
  const bare = saveOn(addSheet, [add9(4, { week: W9, day: 4, text: TEST }, TEST.replace('DROP 2', 'DROP 3'))], { unmergeCopies: false });
  assert.deepEqual(bare.edit.cells[0].after.freed, [{ a1: 'I7', format: null }]);
  const bareSheet = structuredClone(bare.sheet); cellAtS(bareSheet, 'I7').userEnteredFormat = fill({ red: 1, green: 1 });
  assert.equal(R.plan(R.undoOps(bare.edit), planGrid(bareSheet)).reason, 'conflict', 'a yellow fill on a freed cell that had no look');
  assert.equal(R.plan(R.undoOps(bare.edit), planGrid(bare.sheet)).ok, true);
  // a log written without the read-back (no look for the freed cell): refused rather than guessed
  const unread = structuredClone(fri); delete unread.after.freed;
  const noLook = R.plan(R.undoOps({ cells: [unread] }), planGrid(S));
  assert.equal(noLook.reason, 'conflict'); assert.equal(noLook.cells[0].role, 'line');
  assert.equal(R.checkOps(R.undoOps({ cells: [{ ...fri, after: { ...fri.after, freed: [{ a1: 'I7', format: 'red' }] } }] })), R.MSG.bad, 'a look that is not an object');
  ok('1b: [1]/[6] a freed cell\'s look after the add is logged, and a later look on it stops the undo');

  // [4] a row inserted, or deleted, between the line and the cell a cleared merge freed: the freed cell does not move with
  // the line, so the undo would merge the line with a row the add never touched and write the freed cell's old look on
  // it. In the sheet that row's look differs from the freed cell's look after the add (a row inserted from the menu
  // copies the line's look; Google gave the freed cell the merge's look), so the undo is refused: it is either refused
  // or restores exactly, never merges a new row.
  for (const unmergeCopies of [true, false]) {
    const o = { unmergeCopies }, op4 = add9(4, { week: W9, day: 4, text: TEST }, TEST.replace('DROP 2', 'DROP 3'));
    const a4 = saveOn(addSheet, [op4], o);
    const cases = [['a row inserted from the menu under the line', s => insertRowsLike(s, 6, 1), [6]],
      ['two rows inserted from the menu under the line', s => insertRowsLike(s, 6, 2), [6, 7]]];
    if (unmergeCopies) cases.push(['a bare row inserted under the line', s => insertRows(s, 6, 1), [6]], ['the freed row deleted', s => deleteRows(s, 6, 1), [6]]);
    for (const [label, change, rows] of cases) {
      const sh = change(a4.sheet), u = R.plan(R.undoOps(a4.edit), planGrid(sh)), what = `${label} (unmerge copies the look: ${unmergeCopies})`;
      if (u.ok) {
        // planned: it must not merge a row the add never touched, and must leave the tab as it was before the add
        const done = applyRequests(sh, u.requests, o);
        assert.ok(!done.merges.some(m => m.startColumnIndex <= 8 && m.endColumnIndex > 8 && rows.some(r => m.startRowIndex <= r && r < m.endRowIndex)),
          `${what}: never merged with a row the add did not touch`);
        assert.deepEqual(tabState(done), tabState(change(addSheet)), `${what}: restored exactly`);
      } else {
        assert.equal(u.reason, 'conflict', `${what}: ${u.message}`);
        assert.equal(u.cells[0].role, 'line'); assert.equal(u.cells[0].why, 'changed');
        assert.match(u.message, /^The added line changed in the sheet since it was added/);
      }
    }
    // rows inserted above the line move the line and its freed cell together: the undo still works (and is exact)
    const above = insertRowsLike(a4.sheet, 5, 1);
    assert.equal(R.plan(R.undoOps(a4.edit), planGrid(above)).ok, true, 'a row inserted above the line');
  }
  ok('1b: [4] a row inserted or deleted between the line and its freed cell stops the undo');

  // [2] a detail line typed under the added line in the day's right column belongs to it on the board: undo refuses,
  // so that line is never handed to the item above (Sat Nov 14: BLUEBANGER at K7 under SMOOTHIE's L6)
  const sat = saveOn(addSheet, [add9(5, LIKE_NABIS, 'BLUEBANGER')]);
  assert.equal(sat.p.cells[0].a1, 'K7');
  const typed = (cells) => { const sh = structuredClone(sat.sheet); for (const [ref, t] of Object.entries(cells)) Object.assign(cellAtS(sh, ref), { userEnteredValue: { stringValue: t }, formattedValue: t }); return sh; };
  const UNDER = 'Lines were added under the added line in the sheet since it was added, so it was not taken out. Make that change in the sheet.';
  for (const [label, cells] of [['L8 right under it', { L8: '1G PREROLL- 300' }], ['L9, a blank row between', { L9: '1G PREROLL- 300' }]]) {
    const sh = typed(cells), [r, c] = cellRef(Object.keys(cells)[0]);
    assert.equal(R.ownerOf(R.gridFromSheet(sh, PLAN), 3, r, c), 'BLUEBANGER', `${label}: on the board it belongs to the added line`);
    const u = R.plan(R.undoOps(sat.edit), planGrid(sh));
    assert.equal(u.reason, 'conflict', label); assert.equal(u.cells[0].role, 'line'); assert.equal(u.cells[0].why, 'changed');
    assert.equal(u.message, UNDER, label); assert.equal(u.cells[0].found, 'BLUEBANGER');
  }
  // a detail under a new item typed below it belongs to that item: the undo goes ahead, and that detail keeps its item
  const other = typed({ K8: 'OTHER', L8: '1G PREROLL- 300' });
  const uo = R.plan(R.undoOps(sat.edit), planGrid(other));
  assert.equal(uo.ok, true, uo.message);
  assert.equal(R.ownerOf(R.gridFromSheet(applyRequests(other, uo.requests), PLAN), 3, 7, 11), 'OTHER');
  assert.equal(R.plan(R.undoOps(sat.edit), planGrid(sat.sheet)).ok, true, 'nothing under it: undone');
  ok('1b: [2] undo refused when a right-column line typed under the added line belongs to it');

  // [0] an older add whose line was reworded in the sheet, and the same line copied to that day again from the app: by
  // its words alone the newer line looks like hers. Since find.prev the rules tell them apart; for edits logged before
  // it, and as a second guard, index.ts asks the log first:
  // newerOnDay names the later written, not undone edits on the same workbook, tab, week and day, and the undo is
  // refused (MSG.undoNewer) until they are undone.
  const X = 'DEC DROP 1 - STAGE FOR NABIS PICKUP', Y = 'DEC DROP 2 - STAGE FOR NABIS PICKUP';
  const A = saveOn(addSheet, [add9(3, LIKE_NABIS, X)]);
  const reworded0 = structuredClone(A.sheet); Object.assign(cellAtS(reworded0, 'G5'), { userEnteredValue: { stringValue: Y }, formattedValue: Y });
  const C = saveOn(reworded0, [addOp(W9, 3, 5, [Y], LIKE_NABIS, X)]);
  assert.equal(C.p.cells[0].a1, 'G6');
  const alone = R.plan(R.undoOps(A.edit), planGrid(C.sheet));
  assert.equal(alone.reason, 'conflict', 'the line hers was added under (find.prev) tells the newer line from hers');
  // logged before find.prev existed, the words alone point at the newer line: newerOnDay is what stops it then
  const legacyA = JSON.parse(JSON.stringify({ cells: A.edit.cells.map(x => ({ ...x, find: { ...x.find, prev: undefined } })) }));
  const legacyAlone = R.plan(R.undoOps(legacyA), planGrid(C.sheet));
  assert.equal(legacyAlone.ok && legacyAlone.cells[0].a1, 'G6', 'without prev the rules alone cannot tell the newer line from hers');
  const logA = { id: 10, target: 'test', ...A.edit }, logC = { id: 12, target: 'test', ...C.edit };
  assert.deepEqual(R.newerOnDay(logA, [logC]), [12], 'the newer add on Thursday blocks the undo');
  assert.equal(R.MSG.undoNewer, 'A newer change on that day was made from the app. Undo that one first.');
  // undo the newer one first; then the older add is refused as changed (its words were reworded) and hers stays
  const undoneC = saveOn(C.sheet, R.undoOps(C.edit));
  assert.deepEqual(tabState(undoneC.sheet), tabState(reworded0), 'the newer line is taken out exactly');
  assert.deepEqual(R.newerOnDay(logA, []), [], 'with the newer one undone (index.ts reads only edits not undone)');
  const thenA = R.plan(R.undoOps(A.edit), planGrid(undoneC.sheet));
  assert.equal(thenA.reason, 'conflict'); assert.equal(thenA.cells[0].role, 'line'); assert.equal(thenA.cells[0].why, 'changed');
  // which later edits count: any change from the app on the same tab, week (spaces and case aside) and day, on the
  // same workbook; not another day, week, tab or workbook, and not the edit itself. An edit with no add is never blocked.
  const at = (id, cells, target = 'test') => ({ id, target, cells });
  const rewrite = (week, day) => ({ tab: PLAN, a1: 'G5', find: { week, day, owner: '' }, before: { text: 'A' }, after: { text: 'B' } });
  assert.deepEqual(R.newerOnDay(logA, [at(13, [rewrite(W9, 3)]), at(14, [rewrite(` ${W9.toLowerCase()}  `, 3)])]), [13, 14], 'a rewording on that day');
  assert.deepEqual(R.newerOnDay(logA, [at(15, [rewrite(W9, 2)]), at(16, [rewrite(W16, 3)]), at(17, [{ ...rewrite(W9, 3), tab: 'DISTRO SUPPLY' }]),
    at(18, [rewrite(W9, 3)], 'live'), at(19, [{ tab: SUP, a1: 'G5', find: { item: 'X', category: '', header: '25TH' } }]), { ...logA }]), []);
  assert.deepEqual(R.newerOnDay({ id: 10, target: 'test', cells: [rewrite(W9, 3)] }, [logC]), [], 'a rewording being undone is not checked this way');
  assert.deepEqual(R.newerOnDay(logA, [at(21, [rewrite(W9, 3)]), logC]), [12, 21], 'oldest first');
  // a twin typed again by hand further down: the undo takes out its own line (still under the line it was added
  // under), never the twin; logged without find.prev, a twin stops the undo
  const twin = structuredClone(A.sheet); Object.assign(cellAtS(twin, 'G7'), { userEnteredValue: { stringValue: X }, formattedValue: X });
  const tw = R.plan(R.undoOps(A.edit), planGrid(twin));
  assert.equal(tw.ok, true, tw.message); assert.equal(tw.cells[0].a1, 'G5', 'its own line, not the twin');
  const twl = R.plan(R.undoOps(legacyA), planGrid(twin));
  assert.equal(twl.reason, 'conflict'); assert.equal(twl.cells[0].why, 'twice'); assert.match(twl.message, /on its day twice/);
  ok('1b: [0] an older add is not undone while a newer change on that day is not; a twin line is never taken for it');
}
/* ---------- going live (2026-11-12): twins, the line above, date-formatted counts, rows moved under the write ---------- */
{
  const g = planGrid(planSheet);
  const refused = (res, msg, label) => { assert.equal(res.reason, 'refused', `${label}: ${res.message}`); assert.equal(res.message, msg, label); };
  // a rewrite never makes a line that says exactly what another line on that day says (same owner for a detail line)
  refused(R.plan([op({ r: 6, c: 0, expect: 'NEBULA', text: 'VOODOO', find: wk(0) })], g), R.MSG.twinLine, 'a task line made a twin');
  refused(R.plan([op({ r: 9, c: 1, expect: '1G PREROLL- 600', text: '5PK .7G -- 600', find: wk(0, 'VOODOO') })], g), R.MSG.twinLine, 'a detail line made a twin under its strain');
  refused(R.plan([op({ r: 6, c: 0, expect: 'NEBULA', text: 'X', find: wk(0) }), op({ r: 8, c: 0, expect: 'VOODOO', text: 'X', find: wk(0) })], g),
    R.MSG.twinLine, 'two lines made twins in one save');
  assert.equal(R.plan([op({ r: 7, c: 1, expect: '1G PREROLL- 600', text: '1G PREROLL- 450', find: wk(0, 'NEBULA') }),
    op({ r: 9, c: 1, expect: '1G PREROLL- 600', text: '1G PREROLL- 450', find: wk(0, 'VOODOO') })], g).ok, true, 'the same amount under two strains');
  assert.equal(R.plan([op({ r: 6, c: 0, expect: 'NEBULA', text: 'STAGE DEC DROP 3 FOR NABIS', find: wk(0) })], g).ok, true, 'a line that is on another week');
  refused(R.plan([op({ r: 8, c: 0, expect: 'VOODOO', text: 'M8', find: wk(0) }), op({ r: 8, c: 1, expect: '5PK .7G -- 600', text: '1G PREROLL- 600', find: wk(0, 'VOODOO') })], g),
    R.MSG.twinLine, 'a strain renamed in the same save: its lines are compared under the new name');
  ok('a rewrite never makes a twin line on its day');

  // a 1a undo takes only its own cell: still under the line it was under (find.prev)
  const m8 = saveOn(planSheet, [op({ r: 8, c: 0, expect: 'VOODOO', text: 'M8', find: wk(0) })]);
  assert.equal(m8.edit.cells[0].find.prev, 'NEBULA', 'the line above A9 is A7 (A8 is under its merge)');
  const typed = (sheet, cells) => { const sh = structuredClone(sheet); for (const [ref, t] of Object.entries(cells)) { const [r, c] = cellRef(ref); sh.data[0].rowData[r].values[c] = { userEnteredValue: { stringValue: t }, formattedValue: t }; } return sh; };
  const elsewhere = typed(m8.sheet, { A9: 'M8 - DONE', A16: 'M8' });
  const ue = R.plan(R.undoOps(m8.edit), planGrid(elsewhere));
  assert.equal(ue.reason, 'conflict', 'its own cell retyped and its words typed elsewhere: never that other line');
  const legacy = JSON.parse(JSON.stringify({ cells: m8.edit.cells.map(x => ({ ...x, find: { ...x.find, prev: undefined } })) }));
  assert.equal(R.plan(R.undoOps(legacy), planGrid(elsewhere)).cells[0].a1, 'A16', 'without prev the words alone would take A16');
  const beside = R.plan(R.undoOps(m8.edit), planGrid(typed(m8.sheet, { A16: 'M8' })));
  assert.equal(beside.ok, true, beside.message); assert.equal(beside.cells[0].a1, 'A9', 'a twin typed elsewhere: its own cell is undone');
  assert.equal(R.plan(R.undoOps(m8.edit), planGrid(insertRows(m8.sheet, 4, 2))).cells[0].a1, 'A11', 'rows inserted above: followed');
  const aboveChanged = R.plan(R.undoOps(m8.edit), planGrid(typed(m8.sheet, { A7: 'NEBULA - DONE' })));
  assert.equal(aboveChanged.ok, true, aboveChanged.message); assert.equal(aboveChanged.cells[0].a1, 'A9', 'the line above reworded: its own cell, still at its row');
  const addAbove = saveOn(addSheet, [add9(1)]), addCell = addAbove.edit.cells[0];
  assert.equal(addCell.find.prev, 'VOODOO', 'the add on Tuesday went under VOODOO (C6:C7)');
  const anchorChanged = typed(addAbove.sheet, { C6: 'VOODOO - DONE' });
  assert.equal(R.plan(R.undoOps(addAbove.edit), planGrid(anchorChanged)).ok, true, 'an add whose anchor line was reworded is still undone');
  assert.match(R.checkOps([op({ r: 8, c: 0, expect: 'VOODOO', text: 'M8', find: { ...wk(0), prev: 'NEBULA' } })]), /could not read/, 'the page never sends prev');
  ok('a 1a undo is found by its words and the line above it');

  // a count into a cell formatted as a date is refused (120 would show as 4/29); a hidden supply row says so plainly
  const dated = sheetOf(SUP, SUP_CELLS, { cols: 13, formats: { F6: { numberFormat: { type: 'DATE', pattern: 'm/d' } }, G6: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } } });
  const mops = (header, text) => ({ tab: SUP, r: 5, c: header === '23RD' ? 5 : 6, expect: '', text, number: true, find: { item: 'Glob Mops', category: 'ACCESSORY', header } });
  refused(R.plan([mops('23RD', '120')], supGrid(dated)), R.MSG.countFormat, 'a count into a date cell');
  assert.equal(R.plan([mops('25TH', '120')], supGrid(dated)).ok, true, 'a number format is fine');
  refused(R.plan([mops('23RD', '120')], supGrid(sheetOf(SUP, SUP_CELLS, { cols: 13, hidden: [6] }))), R.MSG.hiddenSupply, 'a hidden supply row');
  ok('supply: date-formatted counts and hidden rows refused with their own messages');

  // rows moved under the write: the cells around it read differently (a write one row off), though the written cell
  // itself reads back as sent
  const b10 = R.plan([op({ r: 9, c: 1, expect: '1G PREROLL- 600', text: '1G PREROLL- 450', find: wk(0, 'VOODOO') })], g);
  assert.deepEqual(R.aroundRanges(b10.cells), [{ tab: PLAN, range: 'A4:B17' }], "Monday's two columns in its week, and the next week's header row");
  const fine = applyRequests(planSheet, b10.requests);
  assert.deepEqual(R.changedAround(b10.cells, g, planGrid(fine)), [], 'nothing moved');
  const shifted = applyRequests(insertRows(planSheet, 5, 1), b10.requests);
  assert.equal(R.checkWritten(b10.cells, planGrid(shifted)).ok, true, 'the written cell alone looks fine');
  assert.ok(R.changedAround(b10.cells, g, planGrid(shifted)).length > 0, 'the cells around it show the move');
  const typedNext = applyRequests(typed(planSheet, { B12: 'NEW LINE' }), b10.requests);
  assert.deepEqual(R.changedAround(b10.cells, g, planGrid(typedNext)), [{ tab: PLAN, a1: 'B12' }], 'something typed beside it');
  const sp = R.plan([{ tab: SUP, r: 1, c: 5, expect: '', text: '40', number: true, find: { item: 'Antidote - 3.5g - Label', category: 'LABEL', header: '23RD' } }], supGrid(supSheet));
  assert.deepEqual(R.aroundRanges(sp.cells), [{ tab: SUP, range: 'A2:M2' }], 'the supply row, as wide as its header row');
  const spDone = structuredClone(supSheet); spDone.data[0].rowData[1].values[5] = { userEnteredValue: { numberValue: 40 }, formattedValue: '40' };
  spDone.data[0].rowData[1].values[2].formattedValue = '740';
  assert.deepEqual(R.changedAround(sp.cells, supGrid(supSheet), supGrid(spDone)), [], 'TOTAL QTY (a formula) moving with the count is expected');
  // (Wednesday: its slot E6:F6 is an empty merge the add reuses, so the batch has no mergeCells for Google to refuse
  // when merges moved; on an empty day a row inserted under the header only makes the line land in that blank row)
  const added = saveOn(addSheet, [add9(2)]);
  assert.deepEqual(R.changedAround(added.p.cells, planGrid(addSheet), planGrid(added.sheet)), [], 'an add, nothing moved');
  assert.ok(R.changedAround(added.p.cells, planGrid(addSheet), planGrid(applyRequests(insertRows(addSheet, 4, 1), added.p.requests))).length > 0, 'an add one row off');
  ok('rows moved under a write are seen around it');
}
console.log(`made-up tabs: ${n} groups of checks pass`);

/* ---------- the real tab, when its saved reads are on this computer ---------- */
const realArg = process.argv.find(a => a.startsWith('--real='));
const realDir = realArg ? realArg.slice(7) : path.join(os.homedir(), 'ar-automation/docs/pipeline-writeback/research-scripts');
const gridFile = path.join(realDir, 'grid.json'), formatFile = path.join(realDir, 'format.json');
if (!existsSync(gridFile) || !existsSync(formatFile)) {
  console.log('real tab: saved reads not found, skipped');
} else {
  let m = 0;
  // grid.json: rows 600-760 and 860-900 of DISTRO PIPELINE with full colored words (a windowed read, like index.ts makes)
  const windowed = JSON.parse(readFileSync(gridFile, 'utf8')).sheets[0];
  windowed.properties = { title: PLAN, sheetId: 7 };
  const g = { [PLAN]: R.gridFromSheet(windowed, PLAN) };
  const NOV9 = 'NOVEMBER, MONDAY 9TH';
  const at = (r, c) => R.cellAt(g[PLAN], r, c).text;

  // VOODOO 1g from 600 to 450 on every day of the run: B651 D650 F648 H647 J648 L647
  const voodoo = [[650, 1], [649, 3], [647, 5], [646, 7], [647, 9], [646, 11]];
  const vOps = voodoo.map(([r, c]) => op({ r, c, expect: '1G PREROLL- 600', text: '1G PREROLL- 450', find: { week: NOV9, day: c >> 1, owner: 'VOODOO' } }));
  const v = one(R.plan(vOps, g));
  assert.deepEqual(v.map(x => x.a1), ['B651', 'D650', 'F648', 'H647', 'J648', 'L647']);
  assert.ok(v.every(x => !x.moved && x.request.updateCells.fields === 'userEnteredValue' &&
    x.request.updateCells.rows[0].values[0].userEnteredValue.stringValue === '1G PREROLL- 450'));
  assert.equal(R.plan(vOps.map(o => ({ ...o, find: { week: NOV9, day: o.find.day } })), g).reason, 'refused',
    'without the strain the 1g line is 13 cells a day');
  m++;

  // BLACK MAGIC to TEA PARTY at A673, C671, E669: the pink sticker note and the grey tail stay on their words
  const jars = [[672, 0], [670, 2], [668, 4]];
  const realJar = at(668, 4);
  const jOps = jars.map(([r, c]) => op({ r, c, expect: realJar, text: realJar.replace('BLACK MAGIC', 'TEA PARTY'), find: { week: NOV9, day: c >> 1 } }));
  for (const x of one(R.plan(jOps, g))) {
    const w = x.request.updateCells.rows[0].values[0], text = w.userEnteredValue.stringValue;
    const by = pieces(text, w.textFormatRuns);
    assert.ok(by.some(([t, f]) => t === '(ADD VERIFICATION STICKER)' && f.foregroundColor && f.foregroundColor.blue > 0.6), `${x.a1} sticker note stays pink`);
    assert.ok(by.some(([t, f]) => t.startsWith('--- 3.5G') && f.foregroundColor && f.foregroundColor.red === 0.4), `${x.a1} tail stays grey`);
    assert.ok(by.some(([t]) => t.includes('TEA PARTY')), `${x.a1} new strain in one piece`);
  }
  assert.equal(R.plan([op({ ...jOps[2], text: realJar.replace('STICKER): \nBLACK', 'LABEL): \nRED') })], g).reason, 'refused',
    'a change across the pink note is refused');
  m++;

  // the testing line I668: the drop number sits in the dark red part
  const realTest = at(667, 8), tOp = text => op({ r: 667, c: 8, expect: realTest, text, find: { week: NOV9, day: 4 } });
  assert.ok(R.plan([tOp(realTest.replace('DEC DROP 2', 'DEC DROP 3'))], g).ok);
  assert.equal(R.plan([tOp(realTest.replace('DEC DROP 2-  TIDE', 'JAN DROP 1, TIDE'))], g).reason, 'refused');
  // the crew line A642 (a merged A:B cell) as plain text
  assert.equal(one(R.plan([op({ r: 641, c: 0, expect: 'JUSTIN DISTRO / LORENZO TRIM', text: 'LORENZO OFF / JUSTIN DISTRO', find: { week: NOV9, day: 0 } })], g))[0].a1, 'A642');
  m++;

  // rows inserted under the week header: every VOODOO cell is found two rows down
  const moved = { [PLAN]: R.gridFromSheet(insertRows(windowed, 639, 2), PLAN) };
  const mv = one(R.plan(vOps, moved));
  assert.deepEqual(mv.map(x => x.a1), ['B653', 'D652', 'F650', 'H649', 'J650', 'L649']); assert.ok(mv.every(x => x.moved));
  m++;

  // a past week: its rows are hidden
  const past = 'NOVEMBER, MONDAY 2ND', pr = 622;
  const pc = [0, 1, 2, 3].find(c => at(pr, c) && !R.coveredElsewhere(g[PLAN], pr, c));
  const hid = R.plan([op({ r: pr, c: pc, expect: at(pr, pc), text: at(pr, pc) + ' X', find: { week: past, day: pc >> 1 } })], g);
  assert.equal(hid.reason, 'refused'); assert.match(hid.message, /hidden/);
  m++;

  // format.json: the whole tab and both supply tabs (its colored words lack positions, so they are not used here)
  const whole = JSON.parse(readFileSync(formatFile, 'utf8'));
  const tab = R.gridFromSheet({ ...whole.pipe, properties: { ...whole.pipe.properties, title: PLAN } }, PLAN);
  const vg = R.gridFromValues(tab.rows.map(row => Array.from({ length: 14 }, (_, c) => (row[c] ? row[c].text : ''))), PLAN);
  assert.deepEqual(R.windowsFor(vg, [{ find: { week: NOV9 } }], tab.rowCount), [[637, 682]], 'Nov 9 band is rows 638-674, plus 8');
  assert.equal(tab.hidden.filter(Boolean).length >= 600, true, 'past weeks are hidden');
  const ds = { [SUP]: R.gridFromSheet({ ...whole.dsup, properties: { ...whole.dsup.properties, title: SUP } }, SUP) };
  const label = { item: 'Antidote - 3.5g - Label', category: 'LABEL' };
  const c25 = one(R.plan([{ tab: SUP, r: 4, c: 6, expect: '700', text: '650', number: true, find: { ...label, header: '25TH' } }], ds))[0];
  assert.equal(c25.a1, 'G5'); assert.deepEqual(c25.request.updateCells.rows[0].values[0], { userEnteredValue: { numberValue: 650 } });
  assert.match(R.plan([{ tab: SUP, r: 4, c: 2, expect: '700', text: '650', number: true, find: { ...label, header: 'TOTAL QTY' } }], ds).message, /formula/);
  assert.equal(one(R.plan([{ tab: SUP, r: 4, c: 3, expect: 'RUNNING LOW', text: 'ON ORDER', find: { ...label, header: 'STATUS' } }], ds))[0]
    .request.updateCells.rows[0].values[0].userEnteredValue.stringValue, 'ON ORDER');
  const twiceListed = R.plan([{ tab: SUP, r: 1, c: 5, expect: '', text: '1', number: true, find: { item: 'Bluebanger - 1g - Preroll Label', category: 'LABEL', header: '23RD' } }], ds);
  assert.equal(twiceListed.reason, 'conflict', 'an item listed twice on the real supply tab cannot be told apart');
  m++;
  console.log(`real tab: ${m} groups of checks pass (VOODOO run, jar colors, testing line, moved rows, hidden week, supply)`);
}

/* ---------- release 1b on the real tab: grid.json carries every cell's look, colored words and merges ---------- */
if (existsSync(gridFile)) {
  let m = 0;
  const sheet = JSON.parse(readFileSync(gridFile, 'utf8')).sheets[0];
  sheet.properties = { title: PLAN, sheetId: 7 };
  const g0 = R.gridFromSheet(sheet, PLAN), t = (r, c) => R.cellAt(g0, r, c).text;
  const plan1 = (o, sh = sheet) => R.plan([o], planGrid(sh));
  const NOV9 = 'NOVEMBER, MONDAY 9TH', NOV16 = 'NOVEMBER, MONDAY 16TH', NOV30 = 'NOVEMBER, MONDAY 30TH (VIC OOO)', JAN18 = 'JANUARY, MONDAY 18TH';
  const DROP1 = { week: NOV16, day: 3, text: 'DEC DROP 1' };                              // G677, periwinkle
  const roundTrip = (o, label, between = s => s) => {
    const added = saveOn(sheet, [o]), moved = between(added.sheet);
    const undone = saveOn(moved, R.undoOps(added.edit));
    assert.deepEqual(tabState(undone.sheet), tabState(between(sheet)), `${label}: the tab is exactly as before`);
    return added;
  };

  // Copy I679 to Thu Nov 19: G682:H682 under G681 (whose text ends in a space), merged new; G682's leftover look logged
  const I679 = t(678, 8);
  assert.equal(I679, 'DEC DROP 1 - STAGE FOR NABIS PICKUP');
  const copyOp = addOp(NOV16, 3, 681, [t(680, 6)], { week: NOV16, day: 4, text: I679 }, I679);
  assert.equal(copyOp.find.after, 'TBD - TESTING SCHEDULED FOR DEC PREROLL DROP ');
  const copy = plan1(copyOp);
  assert.equal(copy.ok, true, copy.message);
  const x = copy.cells[0];
  assert.equal(x.range, 'G682:H682'); assert.equal(x.merged, true); assert.equal(x.like.a1, 'I679');
  assert.deepEqual(reqKinds(copy), ['updateCells', 'mergeCells']);
  assert.deepEqual(copy.keys, [`${PLAN}!G682`, `${PLAN}!H682`, `${PLAN}!G681`]);
  assert.equal(x.before.formats[0].textFormat.fontSize, 14); assert.deepEqual(x.before.formats[0].textFormat.foregroundColor, { red: 1 });
  assert.equal(x.before.formats[1].textFormat.fontSize, 12, 'H682 white 12 bold, logged and cleared');
  const [left, right] = copy.requests[0].updateCells.rows[0].values;
  const I679f = R.cellAt(g0, 678, 8).format;
  assert.deepEqual(left.userEnteredFormat, { ...I679f, borders: { ...I679f.borders, bottom: I679f.borders.left } }, 'I679\'s look with its missing bottom side');
  assert.deepEqual(right, {}, 'J679 has no look of its own');
  roundTrip(copyOp, 'G682');
  m++;

  // Mon Nov 9 reuses the empty A674:B674 merge; a second line gives 'full'. Tue Nov 10 jar like C671 keeps its colors.
  const jarText = t(670, 2).replace('BLACK MAGIC', 'TEA PARTY');
  const mon = addOp(NOV9, 0, 673, [t(672, 0)], { week: NOV9, day: 1, text: t(670, 2) }, jarText);
  const monSaved = roundTrip(mon, 'A674');
  assert.equal(monSaved.p.cells[0].range, 'A674:B674'); assert.deepEqual(reqKinds(monSaved.p), ['updateCells']);
  const monFull = plan1(addOp(NOV9, 0, 674, [jarText], DROP1, 'X'), monSaved.sheet);
  assert.equal(monFull.cells[0].why, 'full'); assert.match(monFull.message, /^Monday, Nov 9 has no empty row left/);
  const tue = plan1(addOp(NOV9, 1, 671, [t(670, 2)], { week: NOV9, day: 1, text: t(670, 2) }, jarText));
  assert.equal(tue.cells[0].range, 'C672:D672');
  assert.deepEqual(tue.cells[0].after.runs.map(r => r.startIndex), [0, 21, 47, 48, 60]);
  m++;

  // Sat Nov 14 after L665 "1G PREROLL- 600" of SMOOTHIE; with another strain's name it is a conflict
  const sat = plan1(addOp(NOV9, 5, 665, ['1G PREROLL- 600', 'SMOOTHIE'], DROP1, 'DEC DROP 2'));
  assert.equal(sat.cells[0].range, 'K666:L666'); assert.ok(sat.keys.includes(`${PLAN}!L665`));
  const satNo = plan1(addOp(NOV9, 5, 665, ['1G PREROLL- 600', 'VOODOO'], DROP1, 'DEC DROP 2'));
  assert.equal(satNo.reason, 'conflict'); assert.equal(satNo.cells[0].role, 'after');
  m++;

  // Wed Dec 2: the empty 2x1 E743:E744 is cleared; undo merges it back
  const dec2 = addOp(NOV30, 2, 742, [t(741, 4)], DROP1, 'JAN DROP 1');
  assert.ok(t(741, 4).endsWith('\r\n'), 'E742 is stored with a line break at the end');
  const decSaved = roundTrip(dec2, 'E743');
  assert.deepEqual(decSaved.p.cells[0].cleared, ['E743:E744']); assert.deepEqual(reqKinds(decSaved.p), ['unmergeCells', 'updateCells', 'mergeCells']);
  assert.deepEqual(decSaved.edit.cells[0].before.freed.map(f => f.a1), ['E744']);
  // copying E742 itself to Thu Dec 3 keeps its \r\n and its two colors
  const e742 = plan1(addOp(NOV30, 3, 739, [t(738, 6)], { week: NOV30, day: 2, text: t(741, 4) }, R.nl(t(741, 4))));
  assert.equal(e742.ok, true, e742.message);
  const ev = e742.requests[0].updateCells.rows[0].values[0];
  assert.ok(ev.userEnteredValue.stringValue.endsWith('\r\n')); assert.equal(ev.textFormatRuns.length, 2);
  m++;

  // Wed Nov 18 fills its last row, E707, then is full
  const own18 = R.ownerOf(g0, 674, 705, 5);
  const wed = saveOn(sheet, [addOp(NOV16, 2, 706, ['1G PREROLL- 600', own18], DROP1, 'DEC DROP 2')]);
  assert.equal(wed.p.cells[0].range, 'E707:F707');
  assert.equal(plan1(addOp(NOV16, 2, 707, ['DEC DROP 2'], DROP1, 'DEC DROP 3'), wed.sheet).cells[0].why, 'full');
  // the last week (Jan 18) ends at row 870: Monday is full, Tuesday takes row 870 and is then full, 871+ are never written
  const janOp = addOp(JAN18, 0, 870, [t(869, 0)], DROP1, 'DEC DROP 2'), jan = plan1(janOp);
  assert.equal(jan.cells[0].why, 'full');
  assert.equal(jan.message, 'Monday, Jan 18 is in the last week in the sheet, and that day has no row left under its last line. Add the line in the sheet.');
  // two blank rows inserted under row 870, at the bottom of the Jan 18 week: still full, with the same message
  const janMore = plan1(janOp, insertRows(sheet, 870, 2));
  assert.equal(janMore.cells[0].why, 'full'); assert.equal(janMore.message, jan.message);
  // as index.ts reads it: the sheet has 1087 rows, so the last week counts as whole only when read to the end
  const sized = structuredClone(sheet); sized.properties.gridProperties = { rowCount: 1087, columnCount: 14 };
  const gs = R.gridFromSheet(sized, PLAN);
  assert.equal(R.plan([janOp], { [PLAN]: gs }).cells[0].why, 'changed', 'read only to row 900: never a shorter week');
  gs.toEnd = true;
  assert.equal(R.plan([janOp], { [PLAN]: gs }).cells[0].why, 'full', 'read to the end of the sheet');
  const tue19 = saveOn(sheet, [addOp(JAN18, 1, 869, [t(868, 2)], DROP1, 'DEC DROP 2')]);
  assert.equal(tue19.p.cells[0].range, 'C870:D870');
  assert.equal(plan1(addOp(JAN18, 1, 870, ['DEC DROP 2'], DROP1, 'DEC DROP 3'), tue19.sheet).cells[0].why, 'full');
  m++;

  // rows inserted under the Nov 9 header between the page's read and the save: every slot moves down 2
  const ins = insertRows(sheet, 639, 2);
  const moved = R.plan([copyOp, addOp(NOV9, 5, 665, ['1G PREROLL- 600', 'SMOOTHIE'], DROP1, 'DEC DROP 2')], planGrid(ins));
  assert.equal(moved.ok, true, moved.message);
  assert.deepEqual(moved.cells.map(c => [c.range, c.moved]), [['G684:H684', true], ['K668:L668', true]]);
  roundTrip(copyOp, 'G682 with rows inserted before the undo', s => insertRows(s, 639, 2));
  m++;
  console.log(`real tab, adding a line: ${m} groups of checks pass (copy to G682, A674 reused, K666, E743 cleared, full days, moved rows, undo)`);
}
console.log('pipeline-sheet-write rules: all checks pass');
