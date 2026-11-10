// rules.js: the pure rules of pipeline-sheet-write (no network, no imports). index.ts (Deno) runs them on the sheet
// it has just read; tests/pipeline-write-check.mjs (node) runs them on made-up grids and on saved reads of the real
// tab. Release 1a: rewrite the text of a cell that already holds something, or set a supply count. Everything here
// decides from the fresh grid; from the page only the op itself is taken, and every part of it is checked.
//
// A grid is what the Sheets API returned for one tab, flattened: rows[r][c] = {text, value, runs}, where text is the
// formattedValue (what the CSV export and the page show), value the userEnteredValue and runs the textFormatRuns.
// rows[r] is undefined for rows that were not read, and hidden[r] is true for hidden rows. r and c are 0-based.

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
  formula: 'That cell is worked out by a formula in the sheet, so the app does not change it.',
  merged: 'That cell is part of a merged cell that starts elsewhere. Make that change in the sheet.',
  column: 'From the app, only the site counts, STATUS, PAR and NOTES of a supply row can be changed.',
  countKind: 'Counts and PAR are written as numbers. Reload the page and try again.',
  textKind: 'STATUS and NOTES are written as words, not numbers. Reload the page and try again.',
  number: 'Counts and PAR must be a number of 0 or more, like 450 or 3.5.',
  colors: 'Part of this cell is in a different color, and the change runs across that color. Make that change in the sheet.',
  twice: 'Two of the changes point at the same cell. Reload the page and try again.',
  nothing: 'Nothing to save: the sheet already says that.',
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

const EMPTY = Object.freeze({ text: '', value: null, runs: null });
const cellOf = v => ({ text: v.formattedValue == null ? '' : String(v.formattedValue), value: v.userEnteredValue || null,
  runs: Array.isArray(v.textFormatRuns) && v.textFormatRuns.length ? v.textFormatRuns : null });

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
  (values || []).forEach((row, r) => { g.rows[r] = (row || []).map(t => ({ text: t == null ? '' : String(t), value: null, runs: null })); });
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
// which rows of DISTRO PIPELINE to read with formats: each op's week band and a few rows more; a band near the end of
// the tab is read to the end of the sheet (end = Infinity). Returns [[start, end), ...]; null for a supply tab (read it whole).
export function windowsFor(vg, ops, rowCount) {
  if (!TABS[vg.tab] || !TABS[vg.tab].plan) return null;
  const cap = rowCount || vg.rows.length, spans = [];
  for (const op of ops || []) for (const b of findBands(vg, op && op.find && op.find.week))
    spans.push([b.start, b.end + MARGIN >= cap ? Infinity : b.end + MARGIN]);
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
// shape, tab, column and size checks that need no sheet. Returns a message, or null when the ops are fine.
export function checkOps(ops) {
  if (!Array.isArray(ops) || !ops.length) return MSG.bad;
  if (ops.length > MAX_OPS) return MSG.tooMany;
  for (const op of ops) {
    if (!op || typeof op !== 'object') return MSG.bad;
    if (!Object.hasOwn(TABS, op.tab)) return MSG.tab;
    if (!Number.isInteger(op.r) || op.r < 0 || !Number.isInteger(op.c) || op.c < 0) return MSG.bad;
    if (!isText(op.expect) || !isText(op.text) || !op.find || typeof op.find !== 'object') return MSG.bad;
    if (op.text.length > MAX_TEXT || op.expect.length > 50000) return MSG.long;
    if (op.number != null && typeof op.number !== 'boolean') return MSG.bad;
    const f = op.find;
    if (TABS[op.tab].plan) {
      if (op.c >= PLAN_COLS) return MSG.cols;
      if (!isText(f.week) || !clean(f.week) || !Number.isInteger(f.day) || f.day < 0 || f.day > 6) return MSG.bad;
      if (op.c >> 1 !== f.day) return MSG.bad;                     // the cell is in that day's two columns
      if (f.owner != null && !isText(f.owner)) return MSG.bad;
      if (op.c % 2 === 1 && !op.restore && !clean(f.owner)) return MSG.bad;   // a detail line needs its item
      if (op.number && !op.restore) return MSG.textKind;
      if (op.expect === '') return MSG.empty;
    } else if (!isText(f.item) || !clean(f.item) || !isText(f.header) || !clean(f.header) ||
               (f.category != null && !isText(f.category))) return MSG.bad;
    if (!op.restore && !op.number && nl(op.text) === '') return MSG.clear;
  }
  return null;
}

function locatePlan(g, op) {
  const f = op.find, bands = findBands(g, f.week);
  if (bands.length !== 1) return { why: bands.length ? 'week-twice' : 'week-gone', found: '' };
  const b = bands[0], cols = [2 * f.day, 2 * f.day + 1], want = nl(op.expect), hits = [];
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
  return { r, c, head: L.h, role: L.roles[c] || null };
}

// where a cell may not be written, whatever it holds
function guard(g, op, at, plan) {
  if (at.r === 0 || (!plan && at.r <= at.head)) return MSG.title;
  if (plan && isWeekHeaderRow(g, at.r)) return MSG.header;
  if (g.hidden[at.r]) return MSG.hidden;
  const x = cellAt(g, at.r, at.c);
  if (x.value && x.value.formulaValue != null) return MSG.formula;
  if (coveredElsewhere(g, at.r, at.c)) return MSG.merged;
  if (!plan) {
    if (!at.role) return MSG.column;
    if (!op.restore && at.role === 'count' && !op.number) return MSG.countKind;
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
  const cells = [], conflicts = [], seen = new Set();
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
    cells.push({ tab: op.tab, r: at.r, c: at.c, a1: a1(at.r, at.c), key: k, moved: at.r !== op.r || at.c !== op.c,
      find, own, before: w.before, after: w.after, same: w.same,
      request: { updateCells: {
        range: { sheetId: g.sheetId, startRowIndex: at.r, endRowIndex: at.r + 1, startColumnIndex: at.c, endColumnIndex: at.c + 1 },
        rows: [{ values: [w.data] }], fields: w.fields } } });
  }
  if (conflicts.length) return { ok: false, reason: 'conflict', message: conflictMessage(conflicts), cells: conflicts };
  // an owner rewritten in this same save is found by its new text afterwards
  for (const x of cells) {
    const o = x.own && cells.find(y => y.tab === x.tab && y.r === x.own.r && y.c === x.own.c);
    if (o) x.find.owner = o.after.text;
    delete x.own;
  }
  const changing = cells.filter(x => !x.same);
  if (!changing.length) return { ok: false, reason: 'refused', message: MSG.nothing, cells: [] };
  return { ok: true, cells: changing, requests: changing.map(x => x.request), keys: changing.map(x => x.key) };
}

// After the write: does each cell now hold what was written? grids are the re-read cells.
export function checkWritten(cells, grids) {
  const wrong = [];
  for (const x of cells) {
    const g = grids[x.tab], now = g ? cellAt(g, x.r, x.c) : null;
    const num = now && now.value && typeof now.value.numberValue === 'number' ? now.value.numberValue : null;
    const ok = !!now && (x.after.number != null ? num === x.after.number : nl(now.text) === nl(x.after.text));
    if (!ok) wrong.push({ tab: x.tab, a1: x.a1, expect: x.after.text, found: now ? now.text : '' });
  }
  return { ok: !wrong.length, wrong };
}

// The ops that undo a logged edit: each cell must still hold what the edit wrote, and gets back exactly its old
// text, colored words or number.
export function undoOps(edit) {
  return ((edit && edit.cells) || []).map(x => ({
    tab: x.tab, r: x.r, c: x.c, find: x.find, expect: (x.after && x.after.text) || '',
    text: x.before.number != null ? String(x.before.number) : (x.before.text || ''),
    number: x.before.number != null,
    restore: { text: x.before.text || '', runs: x.before.runs || null, number: x.before.number == null ? null : x.before.number,
      afterRuns: (x.after && x.after.runs) || null },
  }));
}
