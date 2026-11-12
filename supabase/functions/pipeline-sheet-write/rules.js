// rules.js: the pure rules of pipeline-sheet-write (no network, no imports). index.ts (Deno) runs them on the sheet
// it has just read; tests/pipeline-write-check.mjs (node) runs them on made-up grids and on saved reads of the real
// tab. Release 1a: rewrite the text of a cell that already holds something, or set a supply count. Release 1b: add a
// one-line item (a 1x2 merge across a day's two columns) in the first row under that day's last line, with the look
// of a named line ('like'), and take it out again on undo. It only fills blank cells: it never inserts, deletes, hides
// or unhides rows. Everything here decides from the fresh grid; from the page only the op itself is taken, and every
// part of it is checked.
//
// A grid is what the Sheets API returned for one tab, flattened: rows[r][c] = {text, value, runs, format}, where text
// is the formattedValue (what the CSV export and the page show), value the userEnteredValue, runs the textFormatRuns
// and format the userEnteredFormat (null when it was not read). rows[r] is undefined for rows that were not read, and
// hidden[r] is true for hidden rows. r and c are 0-based.

export const TABS = {
  'DISTRO PIPELINE': { scope: 'plan', plan: true },
  'DISTRO SUPPLY': { scope: 'supply', plan: false },
  'ACCESSORY SUPPLY': { scope: 'supply', plan: false },
};
export const MAX_OPS = 20;
export const MAX_TEXT = 2000;      // a trim strain list is about 150 characters; this only stops nonsense
export const PLAN_COLS = 14;       // DISTRO PIPELINE: A to N, two columns per day
const MARGIN = 8;                  // rows read past a week band, in case rows moved between the two reads
const SLIDE = 200;                 // how far an insertion is slid looking for a spot inside one color

// what the person who pressed Save reads (plain English, no em dashes)
export const MSG = {
  bad: 'The app sent a change the save program could not read. Reload the page and try again.',
  tooMany: `At most ${MAX_OPS} cells can be changed in one save. Split the change into smaller saves.`,
  tab: 'The app can only change the DISTRO PIPELINE, DISTRO SUPPLY and ACCESSORY SUPPLY tabs.',
  cols: 'The app can only change columns A to N of DISTRO PIPELINE.',
  long: `That text is too long for one cell (more than ${MAX_TEXT} characters).`,
  empty: 'The app can only change cells that already hold something. Fill in an empty cell in the sheet.',
  clear: 'The app cannot empty a cell yet. Make that change in the sheet.',
  title: 'That is the title row of the tab. The app does not change it.',
  header: 'That is a week header. Change it in the sheet.',
  hidden: 'That row is hidden in the sheet (a past week), so the app does not change it.',
  hiddenSupply: 'That row is hidden in the sheet (by a filter, or by hand), so the app does not change it. Show the row in the sheet, then try again.',
  countFormat: 'That count cell is set to show a date in the sheet, so a number there would read as a date. In the sheet, set the cell to Format, Number, Automatic, then try again.',
  formula:'That cell is worked out by a formula in the sheet, so the app does not change it.',
  merged: 'That cell is part of a merged cell that starts elsewhere. Make that change in the sheet.',
  column: 'From the app, only the site counts, STATUS, PAR and NOTES of a supply row can be changed.',
  countKind: 'Counts and PAR are written as numbers. Reload the page and try again.',
  textKind: 'STATUS and NOTES are written as words, not numbers. Reload the page and try again.',
  number: 'Counts and PAR must be a number of 0 or more, like 450 or 3.5.',
  colors: 'Part of this cell is in a different color, and the change runs across that color. Make that change in the sheet.',
  twice: 'Two of the changes point at the same cell. Reload the page and try again.',
  nothing: 'Nothing to save: the sheet already says that.',
  // release 1b: adding a line
  addTab: 'Lines can only be added to the DISTRO PIPELINE tab.',
  addText: 'Type what the new line should say.',
  addMixed: 'Adding a line and changing other cells are saved separately. Save one, then the other.',
  addTwice: 'Only one line can be added to each day in one save. Add one, save, then add the next.',
  slotValue: 'The row under that day\'s last line holds something the app cannot show. Clear that row in the sheet, then try again.',
  slotMerged: 'The row under that day\'s last line has merged cells the app cannot clear. Tidy that row in the sheet, then try again.',
  twinLine: 'That day already has a line that says exactly that. Change the wording, or change the line that is there.',
  likeShape: 'The line the new one copies its look from is not a one-line item across its day\'s two columns. Pick another line to copy.',
  likeHeader: 'The new line cannot copy its look from a week header or the title row. Pick another line to copy.',
  likeHidden: 'The line the new one copies its look from is in a hidden past week. Pick a line from this week or a later one.',
  likeFormula: 'The line the new one copies its look from is worked out by a formula. Pick another line to copy.',
  likeMark: 'The line the new one copies its look from is marked urgent or crossed out, and the new line would look the same. Pick another line to copy.',
  likeLook: 'The app could not read the look of the line the new one copies, so nothing was saved. Reload the page and try again.',
  addColors: 'Part of this line is in a different color and the change runs across it. Add it as it is, then change the wording.',
  undoNewer: 'A newer change on that day was made from the app. Undo that one first.',
};

export const nl = s => String(s == null ? '' : s).replace(/\r\n?/g, '\n');
const clean = s => String(s == null ? '' : s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
const key = s => clean(s).toUpperCase();
// the same supply category spelled two ways (as the page's SUPPLY PARSER reads them)
const CAT = { LIDS: 'LID', '1LB BAG': 'LB BAG', 'PRE-ROLL': 'PREROLL', PREROLLS: 'PREROLL', JARS: 'JAR', LABELS: 'LABEL' };
const catKey = s => { const k = key(s); return CAT[k] || k; };

export function colName(c) {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
export const a1 = (r, c) => colName(c) + (r + 1);

/* ---------- grids ---------- */

const EMPTY = Object.freeze({ text: '', value: null, runs: null, format: null });
const cellOf = v => ({ text: v.formattedValue == null ? '' : String(v.formattedValue), value: v.userEnteredValue || null,
  runs: Array.isArray(v.textFormatRuns) && v.textFormatRuns.length ? v.textFormatRuns : null,
  format: v.userEnteredFormat && typeof v.userEnteredFormat === 'object' ? v.userEnteredFormat : null });

// one entry of a spreadsheets.get response's `sheets` (data blocks, rowMetadata, merges, properties)
export function gridFromSheet(sheet, tab) {
  const p = (sheet && sheet.properties) || {}, gp = p.gridProperties || {};
  const g = { tab: p.title || tab, sheetId: p.sheetId, rowCount: gp.rowCount == null ? null : gp.rowCount,
    rows: [], hidden: [], merges: [], readEnd: 0, toEnd: false };
  for (const m of (sheet && sheet.merges) || [])
    g.merges.push({ r0: m.startRowIndex || 0, r1: m.endRowIndex, c0: m.startColumnIndex || 0, c1: m.endColumnIndex });
  for (const d of (sheet && sheet.data) || []) {
    const r0 = d.startRow || 0, c0 = d.startColumn || 0, data = d.rowData || [], meta = d.rowMetadata || [];
    g.readEnd = Math.max(g.readEnd, r0 + Math.max(data.length, meta.length));
    for (let i = 0; i < Math.max(data.length, meta.length); i++) {
      const r = r0 + i, row = g.rows[r] || (g.rows[r] = []);
      ((data[i] || {}).values || []).forEach((v, j) => { if (v) row[c0 + j] = cellOf(v); });
      if (meta[i]) g.hidden[r] = !!(meta[i].hiddenByUser || meta[i].hiddenByFilter);
    }
  }
  return g;
}
// a values.get response's `values` (formatted text only): enough to find the week bands to read
export function gridFromValues(values, tab, rowCount = null) {
  const g = { tab, sheetId: undefined, rowCount, rows: [], hidden: [], merges: [] };
  (values || []).forEach((row, r) => { g.rows[r] = (row || []).map(t => ({ text: t == null ? '' : String(t), value: null, runs: null, format: null })); });
  return g;
}
// null = that row was not read
export const cellAt = (g, r, c) => (g.rows[r] ? g.rows[r][c] || EMPTY : null);
const textAt = (g, r, c) => { const x = cellAt(g, r, c); return x ? x.text : ''; };

function cover(g) {
  if (!g._cover) {
    const m = new Map();
    for (const x of g.merges) for (let r = x.r0; r < x.r1; r++) for (let c = x.c0; c < x.c1; c++) m.set(r * 1000 + c, x);
    Object.defineProperty(g, '_cover', { value: m, enumerable: false });
  }
  return g._cover;
}
export const mergeAt = (g, r, c) => cover(g).get(r * 1000 + c) || null;
export const coveredElsewhere = (g, r, c) => { const m = mergeAt(g, r, c); return !!m && (m.r0 !== r || m.c0 !== c); };
// the cell whose text a cell shows: a merged cell's top-left, or itself
const shownAt = (g, r, c) => { const m = mergeAt(g, r, c); return m ? [m.r0, m.c0] : [r, c]; };

/* ---------- DISTRO PIPELINE: week bands, headers, owners ---------- */

// the page's own test (PIPELINE PARSER isWeekHeader): Monday's header in column A, and at least three other day names
const DAY_HDR = /\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\b[\s,]*(?:MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)?\s*(\d{1,2})(?:ST|ND|RD|TH)?\b/;
export function isWeekHeaderRow(g, r) {
  const row = g.rows[r];
  if (!row) return false;
  const a = row[0] ? row[0].text : '';
  if (!/MONDAY/i.test(a) || !DAY_HDR.test(key(a))) return false;
  let n = 0;
  for (const x of row) if (x && /(TUES|WEDNES|THURS|FRI|SATUR|SUN)DAY/i.test(x.text)) n++;
  return n >= 3;
}
// every band whose header (column A) reads `week`: {start: header row, end: next header row or end of what was read}
export function findBands(g, week) {
  const want = key(week), out = [];
  if (!want) return out;
  g.rows.forEach((row, r) => {
    if (key(row[0] && row[0].text) !== want || !isWeekHeaderRow(g, r)) return;
    let end = r + 1;
    while (g.rows[end] && !isWeekHeaderRow(g, end)) end++;
    out.push({ start: r, end });
  });
  return out;
}
// the item a cell belongs to, the way the page reads the tab: the nearest task cell (the day's left column) at or
// above it inside the band. A pre-roll size line "1G PREROLL- 600" belongs to its strain ("VOODOO"); a task cell
// belongs to itself. -> {r, c, text} of that task cell, or null.
export function ownerCell(g, bandStart, r, c) {
  const task = c - (c % 2);
  for (let k = r; k > bandStart; k--) {
    const [or, oc] = shownAt(g, k, task), t = textAt(g, or, oc);
    if (t !== '') return { r: or, c: oc, text: t };
  }
  return null;
}
export const ownerOf = (g, bandStart, r, c) => (ownerCell(g, bandStart, r, c) || { text: '' }).text;
// The nearest text above a cell in its own column inside the band (the header row counts; '' when there is none).
// Logged with each edit (find.prev) so an undo takes the cell it wrote, found by its words, only where that cell still
// sits under the same line: a line someone typed elsewhere that day with the same words is never taken for it. Rows
// inserted or deleted around it keep it (blank rows are skipped). `over` (r * 1000 + c -> text): cells this same save
// rewrites, read as they will be after it.
export function prevText(g, start, r, c, over) {
  for (let k = r - 1; k >= start; k--) {
    const t = over && over.has(k * 1000 + c) ? over.get(k * 1000 + c) : textAt(g, k, c);
    if (t !== '') return t;
  }
  return '';
}
// which rows of DISTRO PIPELINE to read with formats: each op's week band (and an add's 'like' week band) and a few
// rows more. The last week (no header under it in the text read, which leaves out the blank rows at the bottom) and a
// band near the end of the tab are read to the end of the sheet (end = Infinity), so they are always read whole.
// Returns [[start, end), ...]; null for a supply tab (read it whole).
export function windowsFor(vg, ops, rowCount) {
  if (!TABS[vg.tab] || !TABS[vg.tab].plan) return null;
  const cap = rowCount || vg.rows.length, spans = [];
  for (const op of ops || []) for (const week of [op && op.find && op.find.week, op && op.like && op.like.week])
    for (const b of findBands(vg, week))
      spans.push([b.start, b.end + MARGIN >= cap || !isWeekHeaderRow(vg, b.end) ? Infinity : b.end + MARGIN]);
  spans.sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const s of spans) { const last = out[out.length - 1]; if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else out.push(s.slice()); }
  return out;
}

/* ---------- supply tabs ---------- */

// the header row and what each column is, found by header name like the page's SUPPLY PARSER: the site
// columns sit between PAR and Vendor. 'count' = written as a number, 'text' = written as words.
export function supplyLayout(g) {
  let h = -1;
  g.rows.forEach((row, r) => {
    if (h < 0 && row.some(x => x && /^TOTAL\s*QTY$/i.test(clean(x.text))) && row.some(x => x && /^STATUS$/i.test(clean(x.text)))) h = r;
  });
  if (h < 0) return null;
  const H = Array.from({ length: g.rows[h].length }, (_, c) => key(textAt(g, h, c)));
  const col = re => H.findIndex(x => re.test(x));
  const cCat = col(/^ITEM$/), cTot = col(/^TOTAL\s*QTY$/), cSt = col(/^STATUS$/), cPar = col(/^PAR$/),
    cVen = col(/^VENDORS?$/), cNotes = col(/^NOTES?$/);
  const first = Math.max(cTot, cSt, cPar) + 1, stop = cVen >= 0 ? cVen : cNotes >= 0 ? cNotes : H.length;
  const roles = {};
  for (let c = first; c < stop; c++) if (H[c]) roles[c] = 'count';
  if (cPar >= 0) roles[cPar] = 'count';
  if (cSt >= 0) roles[cSt] = 'text';
  if (cNotes >= 0) roles[cNotes] = 'text';
  return { h, H, cCat, roles };
}

/* ---------- text and its colored words ---------- */

// the one stretch where two texts differ: old [p, oe) became new [p, ne)
export function diffStretch(a, b) {
  let p = 0;
  const n = Math.min(a.length, b.length);
  while (p < n && a[p] === b[p]) p++;
  let s = 0;
  while (s < n - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { p, oe: a.length - s, ne: b.length - s };
}
// An insertion or deletion can sit at more than one place ("AB" -> "AAB"): every equivalent spot, rightmost first.
function alignments(a, b) {
  const d = diffStretch(a, b), out = [d], xl = d.oe - d.p, yl = d.ne - d.p;
  if (xl && yl) return out;
  for (let p = d.p - 1; p >= 0 && d.p - p <= SLIDE; p--) {
    if (a.slice(p + xl) !== b.slice(p + yl)) break;
    out.push({ p, oe: p + xl, ne: p + yl });
  }
  return out;
}
const fmtKey = f => JSON.stringify(sortKeys(f || {}));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]); return o; }
  return v;
}
// runs as the API gives them -> sorted, starting at 0, one entry per real format change
export function normRuns(runs, len) {
  const rs = (runs || []).map(x => ({ startIndex: x.startIndex || 0, format: x.format || {} }))
    .filter(x => x.startIndex < Math.max(len, 1)).sort((x, y) => x.startIndex - y.startIndex);
  const out = [];
  for (const x of rs) {
    if (out.length && out[out.length - 1].startIndex === x.startIndex) out.pop();   // the later of two at one spot wins
    out.push(x);
  }
  if (!out.length || out[0].startIndex > 0) out.unshift({ startIndex: 0, format: {} });
  return out.filter((x, i) => i === 0 || fmtKey(x.format) !== fmtKey(out[i - 1].format));
}
// Carry a cell's colored words over a text change. The change must be one stretch inside one format: formats
// before it stay, formats after it shift. Returns {ok: true, runs} or {ok: false} ("make that change in the sheet").
export function carryRuns(oldText, newText, runs) {
  const R = normRuns(runs, oldText.length), cuts = R.slice(1).map(x => x.startIndex);
  for (const { p, oe, ne } of alignments(oldText, newText)) {
    const fits = oe > p ? !cuts.some(b => b > p && b < oe) : (p === 0 || p === oldText.length || !cuts.includes(p));
    if (!fits) continue;
    const moved = R.map(x => ({ startIndex: x.startIndex <= p ? x.startIndex : x.startIndex + (ne - oe), format: x.format }));
    return { ok: true, runs: normRuns(moved, newText.length) };
  }
  return { ok: false };
}

/* ---------- checking and planning ops ---------- */

const isText = v => typeof v === 'string';
const isDay = v => Number.isInteger(v) && v >= 0 && v <= 6;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
// op kinds besides a 1a rewrite (no kind): 'add' from the page, 'unadd' built only by undoOps() (index.ts never passes
// it, or `undo`, from the page)
const KINDS = new Set(['add', 'unadd']);
export const needsFormats = ops => (ops || []).some(o => o && KINDS.has(o.kind));   // read userEnteredFormat too
// an add or unadd: its own shape (the sheet is not needed). Returns a message, or null.
function checkAddOp(op) {
  const f = op.find;
  if (!TABS[op.tab].plan) return MSG.addTab;
  if (!isText(f.week) || !clean(f.week) || !isDay(f.day) || op.c !== 2 * f.day) return MSG.bad;
  if (op.number || op.restore != null) return MSG.bad;
  if (f.prev != null && (op.kind !== 'unadd' || !isText(f.prev))) return MSG.bad;   // only an undo, from the log
  if (op.kind === 'add') {
    if (op.expect !== '' || op.undo != null) return MSG.bad;
    if (!clean(nl(op.text))) return MSG.addText;
    if (!isText(f.after) || f.after.length > 50000 || (f.afterOwner != null && !isText(f.afterOwner))) return MSG.bad;
    const L = op.like;
    if (!isObj(L) || !isText(L.week) || !clean(L.week) || !isDay(L.day) || !isText(L.text) || !clean(L.text) || L.text.length > 50000) return MSG.bad;
    return null;
  }
  // unadd: the log entry of the add it takes out
  const U = op.undo, fmts = v => Array.isArray(v) && v.length === 2 && v.every(x => x == null || isObj(x));
  if (!op.expect || !isObj(U) || !fmts(U.formats) || !fmts(U.formats0) || typeof U.merged !== 'boolean') return MSG.bad;
  if (!Array.isArray(U.cleared) || !Array.isArray(U.freed) || (U.runs != null && !Array.isArray(U.runs))) return MSG.bad;
  const inDay = (r0, r1, c0, c1) => [r0, r1, c0, c1].every(Number.isInteger) && r0 >= 0 && r1 > r0 && c0 >= op.c && c1 <= op.c + 2 && c1 > c0;
  if (!U.cleared.every(m => isObj(m) && inDay(m.r0, m.r1, m.c0, m.c1))) return MSG.bad;
  if (!U.freed.every(x => isObj(x) && inDay(x.r, x.r + 1, x.c, x.c + 1) && (x.format == null || isObj(x.format)) &&
    (x.after == null || isObj(x.after)))) return MSG.bad;
  return null;
}
// shape, tab, column and size checks that need no sheet. Returns a message, or null when the ops are fine.
export function checkOps(ops) {
  if (!Array.isArray(ops) || !ops.length) return MSG.bad;
  if (ops.length > MAX_OPS) return MSG.tooMany;
  let cells = 0, adds = 0;
  const days = new Set();
  for (const op of ops) {
    if (!op || typeof op !== 'object') return MSG.bad;
    if (op.kind != null && !KINDS.has(op.kind)) return MSG.bad;
    if (!Object.hasOwn(TABS, op.tab)) return MSG.tab;
    if (!Number.isInteger(op.r) || op.r < 0 || !Number.isInteger(op.c) || op.c < 0) return MSG.bad;
    if (!isText(op.expect) || !isText(op.text) || !op.find || typeof op.find !== 'object') return MSG.bad;
    if (op.text.length > MAX_TEXT || op.expect.length > 50000) return MSG.long;
    if (op.number != null && typeof op.number !== 'boolean') return MSG.bad;
    const f = op.find;
    // an add writes two cells (the pair); this runs before the 1a empty-cell refusal below, which still holds for 1a
    if (op.kind != null) {
      const no = checkAddOp(op);
      if (no) return no;
      const day = key(f.week) + '|' + f.day;
      if (days.has(day)) return MSG.addTwice;
      days.add(day); adds++; cells += 2;
      continue;
    }
    cells++;
    if (TABS[op.tab].plan) {
      if (op.c >= PLAN_COLS) return MSG.cols;
      if (!isText(f.week) || !clean(f.week) || !Number.isInteger(f.day) || f.day < 0 || f.day > 6) return MSG.bad;
      if (op.c >> 1 !== f.day) return MSG.bad;                     // the cell is in that day's two columns
      if (f.owner != null && !isText(f.owner)) return MSG.bad;
      if (f.prev != null && (!op.restore || !isText(f.prev))) return MSG.bad;   // only an undo, from the log
      if (op.c % 2 === 1 && !op.restore && !clean(f.owner)) return MSG.bad;   // a detail line needs its item
      if (op.number && !op.restore) return MSG.textKind;
      if (op.expect === '') return MSG.empty;
    } else if (!isText(f.item) || !clean(f.item) || !isText(f.header) || !clean(f.header) ||
               (f.category != null && !isText(f.category))) return MSG.bad;
    if (!op.restore && !op.number && nl(op.text) === '') return MSG.clear;
  }
  if (adds && adds !== ops.length) return MSG.addMixed;
  if (cells > MAX_OPS) return MSG.tooMany;
  return null;
}

function locatePlan(g, op) {
  const f = op.find, bands = findBands(g, f.week);
  if (bands.length !== 1) return { why: bands.length ? 'week-twice' : 'week-gone', found: '' };
  const b = bands[0], cols = [2 * f.day, 2 * f.day + 1], want = nl(op.expect);
  let hits = [];
  // the band must end at the next week's header or at the end of the sheet, never at the edge of what was read
  // (rows inserted between the two reads can push part of the week, and a second copy of the text, past the window)
  const whole = isWeekHeaderRow(g, b.end) || g.rowCount == null || b.end >= g.rowCount || (g.toEnd && b.end >= g.readEnd);
  if (!whole) return { why: 'changed', found: '' };
  const ownerOk = (r, c) => (c % 2 === 0 && !f.owner) || key(ownerOf(g, b.start, r, c)) === key(f.owner || '');
  // the header row is searched too, so an op aimed at it is refused by guard() rather than reported as moved
  for (let r = b.start; r < b.end; r++) for (const c of cols) {
    const x = cellAt(g, r, c);
    if (x && x.text !== '' && nl(x.text) === want && ownerOk(r, c)) hits.push([r, c]);
  }
  // an undo logged with the line above its cell (find.prev) takes only its own cell: in the column it wrote, and
  // still at the row it wrote or still under that line (rows moved). Never a look-alike line typed elsewhere on that
  // day (its own cell retyped), and its own cell even when another line that day says the same.
  if (op.restore && isText(f.prev))
    hits = hits.filter(([r, c]) => c === op.c && (r === op.r || nl(prevText(g, b.start, r, c)) === nl(f.prev)));
  if (hits.length === 1) return { r: hits[0][0], c: hits[0][1], band: b };
  // what the cell the page meant holds now, when it is still that item's cell
  const here = op.r >= b.start && op.r < b.end && ownerOk(op.r, op.c) ? textAt(g, op.r, op.c) : '';
  return { why: hits.length ? 'twice' : 'changed', found: here };
}
function locateSupply(g, op) {
  const L = supplyLayout(g), f = op.find;
  if (!L) return { why: 'layout', found: '' };
  const cols = [];
  L.H.forEach((h, c) => { if (h && h === key(f.header)) cols.push(c); });
  if (cols.length !== 1) return { why: 'column', found: '' };
  const rows = [];
  g.rows.forEach((row, r) => {
    if (r > L.h && key(row[0] && row[0].text) === key(f.item) && catKey(L.cCat >= 0 ? textAt(g, r, L.cCat) : '') === catKey(f.category)) rows.push(r);
  });
  if (rows.length !== 1) return { why: rows.length ? 'item-twice' : 'item-gone', found: '' };
  const r = rows[0], c = cols[0], now = textAt(g, r, c);
  if (nl(now) !== nl(op.expect)) return { why: 'changed', found: now };
  return { r, c, head: L.h, role: L.roles[c] || null, width: L.H.length };
}

// where a cell may not be written, whatever it holds
function guard(g, op, at, plan) {
  if (at.r === 0 || (!plan && at.r <= at.head)) return MSG.title;
  if (plan && isWeekHeaderRow(g, at.r)) return MSG.header;
  if (g.hidden[at.r]) return plan ? MSG.hidden : MSG.hiddenSupply;
  const x = cellAt(g, at.r, at.c);
  if (x.value && x.value.formulaValue != null) return MSG.formula;
  if (coveredElsewhere(g, at.r, at.c)) return MSG.merged;
  if (!plan) {
    if (!at.role) return MSG.column;
    if (!op.restore && at.role === 'count' && !op.number) return MSG.countKind;
    // a count written into a cell formatted as a date would show as a date (120 reads 4/29); index.ts reads each
    // cell's number format for this
    const nf = x.format && x.format.numberFormat;
    if (!op.restore && at.role === 'count' && clean(op.text) !== '' && nf && /^(DATE|TIME|DATE_TIME)$/.test(nf.type)) return MSG.countFormat;
    if (!op.restore && at.role === 'text' && op.number) return MSG.textKind;
    if (op.expect === '' && at.role !== 'count') return MSG.empty;
  }
  return null;
}

// the new cell: value, colored words and the field mask for updateCells
function buildWrite(g, op, at) {
  const x = cellAt(g, at.r, at.c), v = x.value || {};
  const before = { text: isText(v.stringValue) ? v.stringValue : x.text, runs: x.runs,
    number: typeof v.numberValue === 'number' ? v.numberValue : null };
  if (op.restore) {                                                    // undo: put back exactly what was there
    const R = op.restore, data = {};
    if (typeof R.number === 'number') data.userEnteredValue = { numberValue: R.number };
    else if (isText(R.text) && R.text !== '') {
      data.userEnteredValue = { stringValue: R.text };
      if (Array.isArray(R.runs) && R.runs.length) data.textFormatRuns = R.runs;
    }
    const after = { text: typeof R.number === 'number' ? String(R.number) : (R.text || ''), runs: R.runs || null,
      number: typeof R.number === 'number' ? R.number : null };
    return { data, fields: 'userEnteredValue,textFormatRuns', before, after,
      same: after.number === before.number && after.text === before.text && fmtKey(after.runs) === fmtKey(before.runs) };
  }
  if (op.number) {
    const t = clean(op.text).replace(/,/g, '');
    if (t === '') return { data: {}, fields: 'userEnteredValue', before, after: { text: '', runs: null, number: null },
      same: before.text === '' && before.number == null };
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(t)) return { refuse: MSG.number };
    const n = Number(t);
    return { data: { userEnteredValue: { numberValue: n } }, fields: 'userEnteredValue', before,
      after: { text: String(n), runs: null, number: n }, same: before.number === n };
  }
  const old = before.text;
  // a cell stored with \r\n (a trim strain list) keeps \r\n
  const next = /\r\n/.test(old) ? nl(op.text).replace(/\n/g, '\r\n') : nl(op.text);
  if (!x.runs) return { data: { userEnteredValue: { stringValue: next } }, fields: 'userEnteredValue', before,
    after: { text: next, runs: null, number: null }, same: next === old && before.number == null };
  // writing a new value erases a cell's runs, so they are always sent again, moved to fit the new text
  const carried = carryRuns(old, next, x.runs);
  if (!carried.ok) return { refuse: MSG.colors };
  return { data: { userEnteredValue: { stringValue: next }, textFormatRuns: carried.runs },
    fields: 'userEnteredValue,textFormatRuns', before, after: { text: next, runs: carried.runs, number: null },
    same: next === old };
}

const conflictMessage = cs => {
  const w = cs[0].why;
  if (cs[0].role) return addConflictMessage(cs);
  if (w === 'week-gone') return 'That week is no longer in the sheet under the same header, so nothing was saved. Reload the page.';
  if (w === 'week-twice') return 'Two weeks in the sheet have the same header, so the app cannot tell them apart. Make that change in the sheet.';
  if (w === 'twice') return 'That text is in the sheet more than once on that day, so the app cannot tell which one you mean. Make that change in the sheet.';
  if (w === 'layout' || w === 'column') return 'The supply tab\'s columns changed since you opened this, so nothing was saved. Reload the page.';
  if (w === 'item-twice') return 'That item is listed twice on the supply tab, so the app cannot tell which row you mean. Make that change in the sheet.';
  if (w === 'item-gone') return 'That item is no longer on the supply tab under the same name, so nothing was saved. Reload the page.';
  return cs.length === 1
    ? 'Changed in the sheet since you opened this, so nothing was saved. Reload to see what the sheet says now.'
    : `${cs.length} cells changed in the sheet since you opened this, so nothing was saved. Reload to see what the sheet says now.`;
};

// The whole check for one save. grids: {tab name: grid}. Ops with `restore` come only from undoOps().
// -> {ok: true, cells, requests, keys} or {ok: false, reason: 'refused' | 'conflict', message, cells}
export function plan(ops, grids) {
  const bad = checkOps(ops);
  if (bad) return { ok: false, reason: 'refused', message: bad, cells: [] };
  if (ops[0].kind != null) return planAdds(ops, grids);         // checkOps: adds (or unadds) are never mixed with 1a ops
  const cells = [], conflicts = [], seen = new Set(), where = [];
  for (const op of ops) {
    const g = grids[op.tab], isPlan = TABS[op.tab].plan;
    const refuse = message => ({ ok: false, reason: 'refused', message, cells: [{ tab: op.tab, r: op.r, c: op.c, a1: a1(op.r, op.c), expect: op.expect }] });
    if (!g) return refuse(MSG.bad);
    const at = isPlan ? locatePlan(g, op) : locateSupply(g, op);
    if (at.why) { conflicts.push({ tab: op.tab, r: op.r, c: op.c, a1: a1(op.r, op.c), expect: op.expect, found: at.found, why: at.why }); continue; }
    // undo: someone recolored words in the cell after the edit, so putting back the old colors would undo their change too
    if (op.restore && 'afterRuns' in op.restore) {
      const x = cellAt(g, at.r, at.c), len = (x.text || '').length;
      if (fmtKey(normRuns(x.runs, len)) !== fmtKey(normRuns(op.restore.afterRuns, len))) {
        conflicts.push({ tab: op.tab, r: op.r, c: op.c, a1: a1(op.r, op.c), expect: op.expect, found: x.text, why: 'changed' }); continue;
      }
    }
    const stop = guard(g, op, at, isPlan);
    if (stop) return refuse(stop);
    const k = op.tab + '!' + a1(at.r, at.c);
    if (seen.has(k)) return refuse(MSG.twice);
    seen.add(k);
    const w = buildWrite(g, op, at);
    if (w.refuse) return refuse(w.refuse);
    // how to find this cell again (undo). A cell in a day's right column also records the item it belongs to.
    const own = isPlan && at.c % 2 ? ownerCell(g, at.band.start, at.r, at.c) : null;
    const find = isPlan
      ? { week: op.find.week, day: op.find.day, owner: own ? own.text : '' }
      : { item: op.find.item, category: op.find.category || '', header: op.find.header };
    // around: what index.ts reads again after the write to see that no row moved under it (the day's two columns in
    // its week, or the supply row); never logged
    const around = isPlan ? { r0: at.band.start, r1: aroundEnd(g, at.band.end), c0: 2 * op.find.day, c1: 2 * op.find.day + 2 }
      : { r0: at.r, r1: at.r + 1, c0: 0, c1: Math.max(at.width || 0, at.c + 1) };
    cells.push({ tab: op.tab, r: at.r, c: at.c, a1: a1(at.r, at.c), key: k, moved: at.r !== op.r || at.c !== op.c,
      find, own, before: w.before, after: w.after, same: w.same, around,
      request: { updateCells: {
        range: { sheetId: g.sheetId, startRowIndex: at.r, endRowIndex: at.r + 1, startColumnIndex: at.c, endColumnIndex: at.c + 1 },
        rows: [{ values: [w.data] }], fields: w.fields } } });
    where.push({ g, band: isPlan ? at.band : null, restore: !!op.restore });
  }
  if (conflicts.length) return { ok: false, reason: 'conflict', message: conflictMessage(conflicts), cells: conflicts };
  // an owner rewritten in this same save is found by its new text afterwards
  for (const x of cells) {
    const o = x.own && cells.find(y => y.tab === x.tab && y.r === x.own.r && y.c === x.own.c);
    if (o) x.find.owner = o.after.text;
    delete x.own;
  }
  // DISTRO PIPELINE: each cell as it will read after this save, for the line above it (find.prev) and for twins
  const over = new Map();
  cells.forEach((x, i) => { if (where[i].band) over.set(x.r * 1000 + x.c, x.after.text); });
  for (let i = 0; i < cells.length; i++) {
    const x = cells[i], { g, band, restore } = where[i];
    if (!band) continue;
    x.find.prev = prevText(g, band.start, x.r, x.c, over);
    if (restore || x.same) continue;
    // A rewrite never makes a line that says exactly what another line on that day says (with the same owner, for a
    // detail line): an undo finds its cell by its words, and the board could not tell the two apart. An add already
    // refuses this (MSG.twinLine).
    const ownerAfter = (r, c) => { const o = ownerCell(g, band.start, r, c); return !o ? '' : over.has(o.r * 1000 + o.c) ? over.get(o.r * 1000 + o.c) : o.text; };
    const owned = (r, c) => (c % 2 === 0 && !x.find.owner) || key(ownerAfter(r, c)) === key(x.find.owner || '');
    for (let r = band.start + 1; r < band.end; r++) for (const c of [x.c - (x.c % 2), x.c - (x.c % 2) + 1]) {
      if (r === x.r && c === x.c) continue;
      const t = over.has(r * 1000 + c) ? over.get(r * 1000 + c) : textAt(g, r, c);
      if (t !== '' && nl(t) === nl(x.after.text) && owned(r, c))
        return { ok: false, reason: 'refused', message: MSG.twinLine, cells: [{ tab: x.tab, r: x.r, c: x.c, a1: x.a1, expect: x.before.text }] };
    }
  }
  const changing = cells.filter(x => !x.same);
  if (!changing.length) return { ok: false, reason: 'refused', message: MSG.nothing, cells: [] };
  return { ok: true, cells: changing, requests: changing.map(x => x.request), keys: changing.map(x => x.key) };
}

// After the write: does each cell now hold what was written? grids are the re-read cells (for an add or unadd: its
// `read` range, with merges). An add: the left cell holds the text and its colored words, the right cell is blank and
// the pair is merged. An unadd: both cells are blank, merged only if they were before the add, and any merge the add
// cleared is back. Formats are recorded (readAfter) but not compared yet.
export function checkWritten(cells, grids) {
  const wrong = [];
  for (const x of cells) {
    const g = grids[x.tab], now = g ? cellAt(g, x.r, x.c) : null;
    const num = now && now.value && typeof now.value.numberValue === 'number' ? now.value.numberValue : null;
    const ok = !!now && (KINDS.has(x.kind) ? pairHolds(g, x)
      : x.after.number != null ? num === x.after.number : nl(now.text) === nl(x.after.text));
    if (!ok) wrong.push({ tab: x.tab, a1: x.a1, expect: x.after.text, found: now ? now.text : '' });
  }
  return { ok: !wrong.length, wrong };
}
// Google writes by row number, and the Sheets API has no "only if the sheet still reads like this": a row inserted or
// deleted above a cell in the second between the locked re-check and the write lands the write one row off, and the
// read-back of the written cells alone cannot see it. So index.ts also reads `around` each written cell (the day's two
// columns in its week, or its supply row) and compares it with the re-check. aroundRanges: what to read, per tab.
// a week's compared rows run through the next week's header row, so a write on the week's last row that a deleted row
// moved onto that header is seen too
const aroundEnd = (g, end) => end + (isWeekHeaderRow(g, end) ? 1 : 0);
export function aroundRanges(cells) {
  const seen = new Set(), out = [];
  for (const x of cells || []) {
    const A = x && x.around;
    if (!A || !(A.r1 > A.r0) || !(A.c1 > A.c0)) continue;
    const range = rangeA1(A.r0, A.c0, A.r1, A.c1), k = x.tab + '!' + range;
    if (!seen.has(k)) { seen.add(k); out.push({ tab: x.tab, range }); }
  }
  return out;
}
// The cells around the written ones that read differently after the write than at the re-check (`pre`: the grids the
// save was planned on; `post`: the read-back), leaving out the cells the save wrote and formula cells (a supply row's
// TOTAL QTY changes with its counts). Rows either read did not cover are not compared. -> [{tab, a1}]
export function changedAround(cells, pre, post) {
  const wrote = new Set(), out = [], seen = new Set();
  for (const x of cells || []) for (const k of x.writes || [x.key]) wrote.add(k);
  for (const x of cells || []) {
    const A = x.around, gp = pre && pre[x.tab], ga = post && post[x.tab];
    if (!A || !gp || !ga) continue;
    for (let r = A.r0; r < A.r1; r++) for (let c = A.c0; c < A.c1; c++) {
      const k = x.tab + '!' + a1(r, c);
      if (wrote.has(k) || seen.has(k)) continue;
      seen.add(k);
      const p = cellAt(gp, r, c), q = cellAt(ga, r, c);
      if (!p || !q) continue;
      if ((p.value && p.value.formulaValue != null) || (q.value && q.value.formulaValue != null)) continue;
      if (nl(p.text) !== nl(q.text)) out.push({ tab: x.tab, a1: a1(r, c) });
    }
  }
  return out;
}
function pairHolds(g, x) {
  const L = cellAt(g, x.r, x.c), Rt = cellAt(g, x.r, x.c + 1);
  if (!L || !blank(Rt) || isPairAt(g, x.r, x.c) !== !!x.after.merged) return false;
  if (x.kind === 'unadd') return blank(L) && (x.after.merges || []).every(m => sameMerge(mergeAt(g, m.r0, m.c0), m));
  const len = (L.text || '').length;
  return nl(L.text) === nl(x.after.text) && fmtKey(normRuns(L.runs, len)) === fmtKey(normRuns(x.after.runs, len));
}

// What a cell holds after the write, from the read-back, for the log (what an undo must find there); null when the
// read-back has no such cell. An add or unadd also records both cells' formats and whether the pair is merged. An add
// that cleared a merge also records the look each freed cell has right after the add (`freed`: Google may give a
// freed cell the merge's look when it unmerges), which an undo compares before it merges that cell back.
export function readAfter(x, grids) {
  const g = grids && grids[x.tab], now = g ? cellAt(g, x.r, x.c) : null;
  if (!now) return null;
  const v = now.value || {};
  const after = { text: isText(v.stringValue) ? v.stringValue : now.text, runs: now.runs,
    number: typeof v.numberValue === 'number' ? v.numberValue : null };
  if (!KINDS.has(x.kind)) return after;
  const Rt = cellAt(g, x.r, x.c + 1);
  const freed = (x.kind === 'add' && x.before && x.before.freed) || [];
  return { ...after, formats: [now.format || null, (Rt && Rt.format) || null], merged: isPairAt(g, x.r, x.c),
    ...(x.kind === 'unadd' ? { merges: x.after.merges || [] } : {}),
    // a freed cell the read-back does not cover has no look logged, so its undo is refused rather than guessed
    ...(freed.length ? { freed: freed.map(f => { const n = cellAt(g, f.r, f.c); return n ? { a1: f.a1, format: n.format || null } : { a1: f.a1 }; }) } : {}) };
}
// The log's entry for one planned cell (pipeline_edits.cells): what undoOps() needs, and nothing it does not. An add's
// `after` is readAfter's (with the freed cells' looks) once the write was read back.
export function logCell(x) {
  const base = { tab: x.tab, r: x.r, c: x.c, a1: x.a1, find: x.find, moved: x.moved, before: x.before, after: x.after };
  return KINDS.has(x.kind) ? { kind: x.kind, ...base, range: x.range, like: x.like || null, merged: x.merged, cleared: x.cleared || [] } : base;
}

// The ops that undo a logged edit: each cell must still hold what the edit wrote, and gets back exactly its old
// text, colored words or number. An added line is taken out (unadd): found again by its text, it must still be as
// the add left it (words, colored words, both cells' formats, the merge, a blank right cell, nothing typed under it
// in the right column, freed cells with the look they had right after the add); both cells get back their earlier
// formats with no value, and a merge the add cleared is put back. Each freed cell carries its earlier look (`format`)
// and, when the read-back logged it, its look right after the add (`after`).
export function undoOps(edit) {
  return ((edit && edit.cells) || []).map(x => {
    if (x.kind === 'add') {
      const b = x.before || {}, a = x.after || {}, looks = Array.isArray(a.freed) ? a.freed : [];
      const freed = (b.freed || []).map(f => {
        const n = looks.find(y => y && f && y.a1 === f.a1);
        return n && Object.hasOwn(n, 'format') ? { ...f, after: n.format } : { ...f };
      });
      const prev = x.find && isText(x.find.prev) ? { prev: x.find.prev } : {};
      return { kind: 'unadd', tab: x.tab, r: x.r, c: x.c, find: { week: x.find && x.find.week, day: x.find && x.find.day, ...prev },
        expect: a.text || '', text: '', number: false,
        undo: { runs: a.runs || null, formats: a.formats, formats0: b.formats, merged: !!b.merged,
          cleared: b.cleared || [], freed } };
    }
    if (x.kind != null) return { kind: 'undo-of-' + x.kind };       // not undoable: checkOps refuses it
    return {
      tab: x.tab, r: x.r, c: x.c, find: x.find, expect: (x.after && x.after.text) || '',
      text: x.before.number != null ? String(x.before.number) : (x.before.text || ''),
      number: x.before.number != null,
      restore: { text: x.before.text || '', runs: x.before.runs || null, number: x.before.number == null ? null : x.before.number,
        afterRuns: (x.after && x.after.runs) || null },
    };
  });
}

// Before an add is undone: the later edits that block it. An added line is found again only by its words, so a newer
// line on that day with the same words (copied again after hers was reworded) could be taken out in its place. Undo
// the newest change first is therefore enforced for adds: `later` are the log rows written from the app after `edit`
// (action 'write', status 'written', not undone; index.ts reads them), and every one on the same workbook that changed
// a cell on the same tab, week and day as one of the edit's added lines blocks the undo. -> their ids, oldest first
export function newerOnDay(edit, later) {
  const day = x => x.tab + '|' + key(x.find.week) + '|' + x.find.day;
  const days = new Set(((edit && edit.cells) || []).filter(x => x && x.kind === 'add' && isObj(x.find)).map(day));
  if (!days.size) return [];
  return (later || []).filter(e => e && e.id !== edit.id && (e.target ?? null) === (edit.target ?? null) &&
    ((e.cells) || []).some(x => x && isObj(x.find) && isText(x.find.week) && days.has(day(x))))
    .map(e => e.id).sort((p, q) => p - q);
}

/* ---------- release 1b: adding a one-line item ---------- */

export const PAIR_FIELDS = 'userEnteredValue,userEnteredFormat,textFormatRuns';
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const copy = v => (v == null ? null : JSON.parse(JSON.stringify(v)));
const blank = x => !!x && x.text === '' && !x.value && !x.runs;
const sameMerge = (m, n) => !!m && !!n && m.r0 === n.r0 && m.r1 === n.r1 && m.c0 === n.c0 && m.c1 === n.c1;
// the pair (r, c0..c0+1) is exactly one 1x2 merge
const isPairAt = (g, r, c0) => sameMerge(mergeAt(g, r, c0), { r0: r, r1: r + 1, c0, c1: c0 + 2 });
const rangeA1 = (r0, c0, r1, c1) => (r1 - r0 === 1 && c1 - c0 === 1 ? a1(r0, c0) : `${a1(r0, c0)}:${a1(r1 - 1, c1 - 1)}`);
const gridRange = (g, r0, c0, r1, c1) => ({ sheetId: g.sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
const mergeOf = m => ({ r0: m.r0, r1: m.r1, c0: m.c0, c1: m.c1 });

// "Monday, Jan 18" from the day's cell in the week's header row; just "Monday" when it does not read as a date
function dayLabel(g, start, d) {
  const m = DAY_HDR.exec(key(textAt(g, start, 2 * d)));
  return m ? `${DAY_NAMES[d]}, ${m[1][0]}${m[1].slice(1).toLowerCase()} ${Number(m[2])}` : DAY_NAMES[d];
}
// Where adding stops in a band: the next week's header. The last week has none under it, so it ends after its last
// row holding text in A to N: the blank formatted rows under it are never written (a full day there is refused).
export function bandEnd(g, b) {
  if (isWeekHeaderRow(g, b.end)) return b.end;
  let last = b.start;
  for (let r = b.start + 1; r < b.end; r++) {
    for (let c = 0; c < PLAN_COLS; c++) if (textAt(g, r, c) !== '') { last = r; break; }
  }
  return last + 1;
}
// the one band whose header reads `week`, read whole (as in locatePlan): {band: {start, end, last, lastWeek}} or {why}.
// lastWeek: no week header under it, so its blank rows never count (bandEnd)
function bandFor(g, week) {
  const bands = findBands(g, week);
  if (bands.length !== 1) return { why: bands.length ? 'week-twice' : 'week-gone' };
  const b = bands[0];
  const whole = isWeekHeaderRow(g, b.end) || g.rowCount == null || b.end >= g.rowCount || (g.toEnd && b.end >= g.readEnd);
  return whole ? { band: { start: b.start, end: b.end, last: bandEnd(g, b), lastWeek: !isWeekHeaderRow(g, b.end) } } : { why: 'changed' };
}
// A day's last line, the way the page reads the CSV: the last row of the band where the day's left or right cell holds
// text; the cell that shows it (the left one when both do, null for an empty day) and its owner; and `bottom`, the
// last row of any merge on that row in the day (a 2x1 strain name whose second row is empty).
function dayEnd(g, band, d) {
  const c0 = 2 * d, c1 = c0 + 1;
  let L = band.start;
  for (let r = band.start + 1; r < band.last; r++) if (textAt(g, r, c0) !== '' || textAt(g, r, c1) !== '') L = r;
  let bottom = L;
  for (const c of [c0, c1]) { const m = mergeAt(g, L, c); if (m) bottom = Math.max(bottom, m.r1 - 1); }
  if (L === band.start) return { L, c: null, text: '', owner: '', bottom };
  const c = textAt(g, L, c0) !== '' ? c0 : c1;
  return { L, c, text: textAt(g, L, c), owner: ownerOf(g, band.start, L, c), bottom };
}

// The template ('like'): the one cell in that band's day-left column whose text is exactly like.text. It must be the
// top-left of exactly a 1x2 merge in a visible week, not a header, formula, urgent (red fill) or crossed-out line.
// -> {r, c, a1, text (as stored), runs, left, right (formats)} or {conflict: {why}} or {refuse}
const isRed = col => !!col && col.red === 1 && !col.green && !col.blue;
function likeCell(g, like) {
  const bf = bandFor(g, like.week);
  if (bf.why) return { conflict: { why: bf.why, found: '' } };
  const b = bf.band, c = 2 * like.day, want = nl(like.text), hits = [];
  for (let r = b.start; r < b.end; r++) { const x = cellAt(g, r, c); if (x && x.text !== '' && nl(x.text) === want) hits.push(r); }
  if (hits.length !== 1) return { conflict: { why: hits.length ? 'twice' : 'changed', found: hits.length ? like.text : '' } };
  const r = hits[0], x = cellAt(g, r, c), right = cellAt(g, r, c + 1), F = x.format;
  if (r === 0 || isWeekHeaderRow(g, r)) return { refuse: MSG.likeHeader };
  if (g.hidden[r] || g.hidden[b.start]) return { refuse: MSG.likeHidden };
  if (x.value && x.value.formulaValue != null) return { refuse: MSG.likeFormula };
  if (!isPairAt(g, r, c)) return { refuse: MSG.likeShape };
  if (!F) return { refuse: MSG.likeLook };          // every line has a look; none means formats were not read
  const tf = F.textFormat || {};
  if (isRed(F.backgroundColor) || isRed(F.backgroundColorStyle && F.backgroundColorStyle.rgbColor) || tf.strikethrough ||
      (x.runs || []).some(y => y && y.format && y.format.strikethrough)) return { refuse: MSG.likeMark };
  const v = x.value || {};
  return { r, c, a1: a1(r, c), text: isText(v.stringValue) ? v.stringValue : x.text, runs: x.runs, left: F, right: right ? right.format : null };
}

// The left cell's look: the template's whole format, with any border side it lacks (its neighbor draws that line, but
// the slot's neighbors are other cells) filled with a copy of its own solid black side, or solid black width 1.
const SIDES = ['top', 'bottom', 'left', 'right'];
const BLACK_SIDE = { style: 'SOLID', width: 1, color: {}, colorStyle: { rgbColor: {} } };
const isBlack = col => !col || (!col.red && !col.green && !col.blue);
const solidBlack = s => !!s && s.style === 'SOLID' && isBlack(s.color) &&
  (!s.colorStyle || (!s.colorStyle.themeColor && isBlack(s.colorStyle.rgbColor)));
export function slotFormat(format) {
  const f = copy(format) || {}, b = f.borders || {};
  const has = s => !!b[s] && !!b[s].style && b[s].style !== 'NONE';
  if (SIDES.every(has)) return f;
  const from = ['left', 'right', 'top', 'bottom'].map(s => b[s]).find(solidBlack) || BLACK_SIDE;
  f.borders = Object.fromEntries(SIDES.map(s => [s, has(s) ? b[s] : copy(from)]));
  return f;
}

// One add: find the slot under the day's last line, prove it can be written, copy the template's look.
// -> {cell} | {conflict} | {refuse}
function buildAdd(g, op) {
  const f = op.find, d = f.day, c0 = 2 * d, c1 = c0 + 1, tab = op.tab;
  const stop = (why, role, found = '', label = DAY_NAMES[d], more = {}) => ({ conflict: { tab, r: op.r, c: op.c, a1: a1(op.r, op.c),
    expect: role === 'like' ? op.like.text : f.after, found, why, role, label, ...more } });
  const refuse = message => ({ refuse: message });
  // 1. the anchor: the day must still end with the line the page saw (owner too, for a line in the right column)
  const bf = bandFor(g, f.week);
  if (bf.why) return stop(bf.why, 'after');
  const band = bf.band, end = dayEnd(g, band, d);
  const anchored = end.c == null ? nl(f.after) === ''
    : nl(end.text) === nl(f.after) && (end.c === c1 ? key(end.owner) === key(f.afterOwner || '')
      : !clean(f.afterOwner) || key(f.afterOwner) === key(end.text));
  if (!anchored) return stop('changed', 'after', end.text);
  // 2. the slot: the first row under that line and under any merge on its row. In the last week a blank row added in
  // the sheet never makes room (the week ends at its last row holding text), so its message does not suggest one.
  const slot = end.bottom + 1;
  if (slot >= band.last) return stop('full', 'slot', end.text, dayLabel(g, band.start, d), { lastWeek: band.lastWeek });
  if (slot === 0) return refuse(MSG.title);
  if (isWeekHeaderRow(g, slot)) return refuse(MSG.header);
  if (g.hidden[slot]) return refuse(MSG.hidden);
  for (const c of [c0, c1]) {
    const x = cellAt(g, slot, c);
    if (!x) return refuse(MSG.bad);
    if (x.value && x.value.formulaValue != null) return refuse(MSG.formula);
    if (!blank(x)) return refuse(MSG.slotValue);            // an empty-looking value is never written over
  }
  // merges there: none (merge the pair), exactly the pair (reuse it), or empty merges starting on the slot row inside
  // the day and the band, with no hidden row: cleared first (unmerged), their other cells left blank
  const m0 = mergeAt(g, slot, c0), m1 = mergeAt(g, slot, c1), cleared = [], freed = [];
  const reuse = !!m0 && m0 === m1 && isPairAt(g, slot, c0);
  if (!reuse) for (const m of new Set([m0, m1].filter(Boolean))) {
    if (m.r0 !== slot || m.c0 < c0 || m.c1 > c0 + 2 || m.r1 > band.last) return refuse(MSG.slotMerged);
    for (let r = m.r0; r < m.r1; r++) {
      if (g.hidden[r] || isWeekHeaderRow(g, r)) return refuse(MSG.slotMerged);
      for (let c = m.c0; c < m.c1; c++) {
        const x = cellAt(g, r, c);
        if (!blank(x)) return refuse(MSG.slotMerged);
        if (r !== slot) freed.push({ r, c, a1: a1(r, c), format: x.format });
      }
    }
    cleared.push(mergeOf(m));
  }
  // 3. the template and the new text with its colored words (a line stored with \r\n keeps \r\n)
  const lk = likeCell(g, op.like);
  if (lk.conflict) return stop(lk.conflict.why, 'like', lk.conflict.found);
  if (lk.refuse) return refuse(lk.refuse);
  const text = /\r\n/.test(lk.text) ? nl(op.text).replace(/\n/g, '\r\n') : nl(op.text);
  for (let r = band.start + 1; r < band.last; r++) if (nl(textAt(g, r, c0)) === nl(text)) return refuse(MSG.twinLine);
  let runs = null;
  if (lk.runs) {
    const carried = carryRuns(lk.text, text, lk.runs);
    if (!carried.ok) return refuse(MSG.addColors);
    runs = carried.runs.length === 1 && fmtKey(carried.runs[0].format) === '{}' ? null : carried.runs;
  }
  // 4. the requests: unmerge what is cleared, write both cells (value, whole format, colored words), merge the pair
  const left = { userEnteredValue: { stringValue: text }, userEnteredFormat: slotFormat(lk.left) };
  if (runs) left.textFormatRuns = runs;
  const right = lk.right ? { userEnteredFormat: copy(lk.right) } : {};
  const pair = gridRange(g, slot, c0, slot + 1, c0 + 2);
  const requests = [
    ...cleared.map(m => ({ unmergeCells: { range: gridRange(g, m.r0, m.c0, m.r1, m.c1) } })),
    { updateCells: { range: pair, rows: [{ values: [left, right] }], fields: PAIR_FIELDS } },
    ...(reuse ? [] : [{ mergeCells: { range: gridRange(g, slot, c0, slot + 1, c0 + 2), mergeType: 'MERGE_ALL' } }]),
  ];
  const k = (r, c) => tab + '!' + a1(r, c);
  const writes = [k(slot, c0), k(slot, c1), ...freed.map(x => k(x.r, x.c))];
  const bottom = Math.max(slot + 1, ...cleared.map(m => m.r1));
  return { cell: {
    kind: 'add', tab, r: slot, c: c0, a1: a1(slot, c0), range: rangeA1(slot, c0, slot + 1, c0 + 2),
    read: rangeA1(slot, c0, bottom, c0 + 2), key: writes[0], writes,
    keys: [...writes, ...(end.c == null ? [] : [k(end.L, end.c)])],      // the anchor is locked too, never written
    count: writes.length, moved: slot !== op.r, around: { r0: band.start, r1: aroundEnd(g, band.end), c0, c1: c0 + 2 },
    find: { week: f.week, day: d, after: f.after, afterOwner: f.afterOwner || '', prev: prevText(g, band.start, slot, c0) },
    like: { week: op.like.week, day: op.like.day, text: op.like.text, a1: lk.a1 },
    merged: !reuse, cleared: cleared.map(m => rangeA1(m.r0, m.c0, m.r1, m.c1)),
    before: { text: '', runs: null, number: null, formats: [cellAt(g, slot, c0).format, cellAt(g, slot, c1).format],
      merged: reuse, cleared, freed },
    after: { text, runs, number: null, formats: [left.userEnteredFormat, right.userEnteredFormat || null], merged: true },
    same: false, requests } };
}

// One unadd (undo of an add): the line is found again by its text in the day's left column (rows may have moved);
// it must be exactly as the add left it, or nothing is written. (index.ts first refuses it while a newer change from
// the app on that day is not undone: newerOnDay.)
function buildUnadd(g, op) {
  const f = op.find, U = op.undo, c0 = 2 * f.day, c1 = c0 + 1, tab = op.tab;
  const stop = (why, found = '', more = {}) => ({ conflict: { tab, r: op.r, c: op.c, a1: a1(op.r, op.c), expect: op.expect, found, why, role: 'line', ...more } });
  const bf = bandFor(g, f.week);
  if (bf.why) return stop(bf.why);
  // the line must be the only one with these words in the day's left column: a twin could be the one taken out. An
  // add logged with the line above it (find.prev) counts only a line still at its row or still under that line, so a
  // copy someone pasted elsewhere that day (its own line reworded) is never taken out, and its own line is found even
  // beside a twin.
  const b = bf.band, want = nl(op.expect);
  let hits = [];
  for (let r = b.start; r < b.end; r++) { const x = cellAt(g, r, c0); if (x && x.text !== '' && nl(x.text) === want) hits.push(r); }
  if (isText(f.prev)) hits = hits.filter(r => r === op.r || nl(prevText(g, b.start, r, c0)) === nl(f.prev));
  if (hits.length !== 1) return stop(hits.length ? 'twice' : 'changed');
  const r = hits[0], shift = r - op.r, L = cellAt(g, r, c0), Rt = cellAt(g, r, c1), len = (L.text || '').length;
  if (r === 0) return { refuse: MSG.title };
  if (isWeekHeaderRow(g, r)) return { refuse: MSG.header };
  if (g.hidden[r]) return { refuse: MSG.hidden };
  const untouched = !(L.value && L.value.formulaValue != null) &&
    fmtKey(normRuns(L.runs, len)) === fmtKey(normRuns(U.runs, len)) &&
    fmtKey(L.format) === fmtKey(U.formats[0]) && fmtKey(Rt.format) === fmtKey(U.formats[1]) &&
    blank(Rt) && isPairAt(g, r, c0);
  if (!untouched) return stop('changed', L.text);
  // a detail line typed in the day's right column under it since ("1G PREROLL- 300") belongs to it, the way the page
  // reads the tab: taking the line out would hand that detail to the item above, so it is left for the sheet. The
  // first right-column text below decides: the owner only changes going down.
  for (let rr = r + 1; rr < b.end; rr++) {
    if (textAt(g, rr, c1) === '') continue;
    const o = ownerCell(g, b.start, rr, c1);
    if (o && o.r === r && o.c === c0) return stop('changed', L.text, { under: true });
    break;
  }
  // a merge the add cleared comes back where its cells still are: blank, unmerged, visible, inside the band, and with
  // the look each had right after the add. A look changed by hand would be wiped; a row inserted or deleted between the
  // line and a freed cell puts another row's cell there (it does not move with the line), and in the sheet that cell's
  // look differs, so the merge is never put back across a row the add did not touch. No look logged: refused.
  const merges = U.cleared.map(m => ({ r0: m.r0 + shift, r1: m.r1 + shift, c0: m.c0, c1: m.c1 }));
  const freed = U.freed.map(x => ({ r: x.r + shift, c: x.c, a1: a1(x.r + shift, x.c), format: x.format || null,
    logged: Object.hasOwn(x, 'after'), after: x.after || null }));
  for (const x of freed) {
    const now = cellAt(g, x.r, x.c);
    if (x.r <= r || x.r >= b.end || g.hidden[x.r] || !blank(now) || mergeAt(g, x.r, x.c) ||
        !x.logged || fmtKey(now.format) !== fmtKey(x.after)) return stop('changed', L.text);
  }
  const fmtOnly = F => (F ? { userEnteredFormat: copy(F) } : {});
  const requests = [
    ...(U.merged ? [] : [{ unmergeCells: { range: gridRange(g, r, c0, r + 1, c0 + 2) } }]),
    { updateCells: { range: gridRange(g, r, c0, r + 1, c0 + 2), rows: [{ values: [fmtOnly(U.formats0[0]), fmtOnly(U.formats0[1])] }], fields: PAIR_FIELDS } },
    ...freed.map(x => ({ updateCells: { range: gridRange(g, x.r, x.c, x.r + 1, x.c + 1), rows: [{ values: [fmtOnly(x.format)] }], fields: PAIR_FIELDS } })),
    ...merges.map(m => ({ mergeCells: { range: gridRange(g, m.r0, m.c0, m.r1, m.c1), mergeType: 'MERGE_ALL' } })),
  ];
  const k = (rr, c) => tab + '!' + a1(rr, c);
  const writes = [k(r, c0), k(r, c1), ...freed.map(x => k(x.r, x.c))];
  const v = L.value || {};
  return { cell: {
    kind: 'unadd', tab, r, c: c0, a1: a1(r, c0), range: rangeA1(r, c0, r + 1, c0 + 2),
    read: rangeA1(r, c0, Math.max(r + 1, ...merges.map(m => m.r1)), c0 + 2), key: writes[0], writes, keys: writes,
    count: writes.length, moved: r !== op.r, find: { week: f.week, day: f.day }, around: { r0: b.start, r1: aroundEnd(g, b.end), c0, c1: c0 + 2 },
    merged: false, cleared: merges.map(m => rangeA1(m.r0, m.c0, m.r1, m.c1)),
    before: { text: isText(v.stringValue) ? v.stringValue : L.text, runs: L.runs, number: null, formats: [L.format, Rt.format], merged: true },
    after: { text: '', runs: null, number: null, formats: [U.formats0[0] || null, U.formats0[1] || null], merged: U.merged, merges },
    same: false, requests } };
}

// adds (or the unadds of one undo): each one found and checked on the fresh grid, at most MAX_OPS cells in all
function planAdds(ops, grids) {
  const cells = [], conflicts = [];
  for (const op of ops) {
    const g = grids[op.tab];
    const refused = message => ({ ok: false, reason: 'refused', message, cells: [{ tab: op.tab, r: op.r, c: op.c, a1: a1(op.r, op.c), expect: op.expect }] });
    if (!g) return refused(MSG.bad);
    const res = op.kind === 'add' ? buildAdd(g, op) : buildUnadd(g, op);
    if (res.conflict) { conflicts.push(res.conflict); continue; }
    if (res.refuse) return refused(res.refuse);
    cells.push(res.cell);
  }
  if (conflicts.length) return { ok: false, reason: 'conflict', message: conflictMessage(conflicts), cells: conflicts };
  if (cells.reduce((n, x) => n + x.count, 0) > MAX_OPS) return { ok: false, reason: 'refused', message: MSG.tooMany, cells: [] };
  const written = new Set();
  for (const x of cells) for (const k of x.writes) {
    if (written.has(k)) return { ok: false, reason: 'refused', message: MSG.twice, cells: [] };
    written.add(k);
  }
  return { ok: true, cells, requests: cells.flatMap(x => x.requests), keys: [...new Set(cells.flatMap(x => x.keys))] };
}

// conflicts of an add ('after': the day's last line, 'slot': no room, 'like': the template) or an unadd ('line')
function addConflictMessage(cs) {
  const x = cs[0], w = x.why;
  if (x.role === 'slot') return x.lastWeek
    ? `${x.label} is in the last week in the sheet, and that day has no row left under its last line. Add the line in the sheet.`
    : `${x.label} has no empty row left under its last line in the sheet. Add a row at the bottom of that week in the sheet, then try again.`;
  if (x.role === 'like') return w === 'twice'
    ? 'The line the new one copies its look from is on its day twice, so the app cannot tell which to copy. Pick another line.'
    : 'The line the new one copies its look from changed in the sheet, so nothing was saved. Reload and try again.';
  if (w === 'week-gone') return 'That week is no longer in the sheet under the same header, so nothing was saved. Reload the page.';
  if (w === 'week-twice') return 'Two weeks in the sheet have the same header, so the app cannot tell them apart. Make that change in the sheet.';
  if (x.role === 'line') return w === 'twice'
    ? 'The added line is on its day twice now, so the app cannot tell which one to take out. Make that change in the sheet.'
    : x.under ? 'Lines were added under the added line in the sheet since it was added, so it was not taken out. Make that change in the sheet.'
    : 'The added line changed in the sheet since it was added (its words, colors, look or merge), so it was not taken out. Make that change in the sheet.';
  return cs.length === 1 ? `${x.label} changed in the sheet since you opened this, so nothing was saved.`
    : `${cs.length} days changed in the sheet since you opened this, so nothing was saved.`;
}
