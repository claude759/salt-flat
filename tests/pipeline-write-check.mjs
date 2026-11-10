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
// cells: {A1: text | number | {formula, shows} | {text, runs}}
function sheetOf(title, cells, { merges = [], hidden = [], rows = 30, cols = 14 } = {}) {
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({})));
  for (const [ref, v] of Object.entries(cells)) {
    const [r, c] = cellRef(ref);
    if (typeof v === 'number') grid[r][c] = { userEnteredValue: { numberValue: v }, formattedValue: String(v) };
    else if (typeof v === 'string') grid[r][c] = { userEnteredValue: { stringValue: v }, formattedValue: v };
    else if (v.formula) grid[r][c] = { userEnteredValue: { formulaValue: v.formula }, formattedValue: v.shows };
    else grid[r][c] = { userEnteredValue: { stringValue: v.text }, formattedValue: v.text, textFormatRuns: v.runs };
  }
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
console.log('pipeline-sheet-write rules: all checks pass');
