// job.js (pipeline-trims-sync): the site trim workbooks (Drive folder "2026 TRIM SHEETS": FILIFERA / SLANE / IMPERIAL
// PROJECTS / OLYMPIC 2026.xlsx), hourly. The cloud copy of ~/ar-automation/pipeline-trims-sync.mjs on Gianni's Mac:
// the same reading of every tab, the same rows, the same guards and meta stamps (pipeline_trims_save's rules, through
// pipeline_sync_apply). To stay inside the Edge Function CPU limit it parses only the workbooks whose md5 changed and
// keeps every workbook's lines in pipeline_sync_state.cache; when several changed at once it parses some and hands the
// rest to a follow-up run. Pure: Google, the database and SheetJS come in through `io`.
import { diffRows, sameInstant, stableJson } from './core.js';

export const JOB = 'trims';
export const FUNCTION = 'pipeline-trims-sync';
export const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';   // read-only on purpose
export const STALE_SECONDS = 600;
export const PARSER = 'trims-1';   // change it when the parsing changes: every cached workbook is read again
// parse time per run, well inside the Edge Functions' 2 s of CPU (all four workbooks take about 0.7 s in node); a workbook
// that would go past it, judged by its size, goes to a follow-up run
export const BUDGET_MS = 500;
export const MIN_LINES = 20;
export const SPEC = { key: ['file', 'tab', 'block', 'line'], fields: { file: 'text', tab: 'text', block: 'int', line: 'int', site: 'text',
  room: 'text', start_date: 'date', end_date: 'date', lights: 'num', strain: 'text', code: 'text', bigs_g: 'num0', littles_g: 'num0', trim_g: 'num0' } };

/* ---- parsing: exactly the Mac job's ---- */

// workbook name -> site, as the pipeline sheet names them
export const SITES = [[/FILIFERA/i, '25TH'], [/SLANE/i, '23RD'], [/IMPERIAL/i, '15TH'], [/OLYMPIC/i, 'OLYMPIC']];
export const siteOf = name => (SITES.find(([re]) => re.test(name)) || [])[1] || null;
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const pad = n => String(n).padStart(2, '0');
// a real calendar day (no April 31, Feb 29 only in a leap year)
const okDay = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d;
// only month names count as dates, so "(Room 2)" or "(Part 2)" in a tab name is never read as one
const MON = '(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\\.?\\s*';
const DATE_RE = new RegExp(`\\b${MON}(\\d{1,2})(?:\\s*-\\s*(?:${MON})?(\\d{1,2}))?`);
// "Oct 2-4", "Sept. 23-24", "March 20", "Dec 30-Jan 01", "Oct. 6(RM2 early harvest)", "April 16 Cont.-(April 30-May 1)":
// a date in brackets wins (the continuation tab's real days); a December that runs into January is last year's
export function tabDates(name, year) {
  const t = String(name).toUpperCase();
  const paren = t.match(/\(([^)]*)\)/);
  const m = (paren && paren[1].match(DATE_RE)) || t.replace(/\([^)]*\)/g, ' ').match(DATE_RE);
  if (!m) return null;
  const m1 = MONTHS[m[1]], d1 = +m[2], m2 = m[3] ? MONTHS[m[3]] : m1, d2 = m[4] ? +m[4] : d1;
  const y1 = m1 === 12 && m2 === 1 ? year - 1 : year;
  if (!okDay(y1, m1, d1) || !okDay(year, m2, d2)) return null;
  return { start: `${y1}-${pad(m1)}-${pad(d1)}`, end: `${year}-${pad(m2)}-${pad(d2)}` };
}
const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[,$\s]/g, '')); return Number.isFinite(n) ? n : null; };
const cell = v => String(v ?? '').replace(/\s+/g, ' ').trim();

// the workbook's tabs, each with its rows read only when asked (TEMPLATE and PHENO tabs are never read)
export function tabsFromXlsx(XLSX, bytes) {
  const wb = XLSX.read(bytes, { type: 'array' });
  return wb.SheetNames.map(name => ({ name, rows: () => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' }) }));
}
export const parseWorkbook = (XLSX, bytes, fileName) => parseTabs(tabsFromXlsx(XLSX, bytes), fileName);
// tabs: [{ name, rows() -> array of rows }] (the Mac job's sheet_to_json(header: 1, raw: true, defval: ''))
export function parseTabs(tabs, fileName) {
  const site = siteOf(fileName), year = +((fileName.match(/(20\d\d)/) || [])[1] || new Date().getFullYear());
  const lines = [];
  for (const { name: tab, rows: read } of tabs) {
    if (/TEMPLATE|PHENO/i.test(tab)) continue;
    const dates = tabDates(tab, year);
    const rows = read();
    let block = -1;
    rows.forEach((r, i) => {
      const a = cell(r[0]);
      if (!/^(ROOM|RM)\b/i.test(a)) return;
      block++;
      const room = a.replace(/^(ROOM|RM)\s*/i, '').trim().toUpperCase() || null;
      const lr = rows[i + 1] || [];
      const lights = /LIGHT/i.test(cell(lr[0])) ? num(lr[1]) : null;
      const codes = /STRAIN CODE/i.test(cell((rows[i - 1] || [])[0])) ? rows[i - 2] || [] : [];
      // the block's Total Gms row, then the Grams row of its Trim section; stop at the next ROOM block
      let tot = -1, gr = -1;
      for (let j = i + 2; j < Math.min(rows.length, i + 80); j++) {
        if (/^(ROOM|RM)\b/i.test(cell(rows[j][0]))) break;
        const b = cell(rows[j][1]);
        if (tot < 0 && /^TOTAL\s*GMS?$/i.test(b)) tot = j;
        else if (tot >= 0 && /^GRAMS$/i.test(b)) { gr = j; break; }
      }
      if (tot < 0) return;
      const T = rows[tot], G = gr >= 0 ? rows[gr] : [];
      let line = 0;
      // strain names sit in columns C, E, G ... (a BIGS, LITTLES pair each); the right-hand Grams/Weight/Paycheck columns are totals
      for (let c = 2; c < r.length; c += 2) {
        const nm = cell(r[c]);
        if (!nm || /^(GRAMS|WEIGHT|PAYCHECK|TOTAL)/i.test(nm)) continue;
        const bigs = num(T[c]) || 0, littles = num(T[c + 1]) || 0, trim = num(G[c]) || 0;
        const at = line++;
        if (!bigs && !littles && !trim) continue;
        lines.push({ file: fileName, tab, block, line: at, site, room, start_date: dates && dates.start, end_date: dates && dates.end,
          lights, strain: nm, code: cell(codes[c]) || null, bigs_g: bigs, littles_g: littles, trim_g: trim });
      }
    });
  }
  return lines;
}

// the folder's site workbooks: .xlsx with a site in the name; two files with one name (a re-upload instead of a new
// version) keep the newer, or their rows would collide. Sorted by name, so a run's rows come in a fixed order.
export function pickFiles(listed) {
  const byName = new Map(), dupes = [];
  for (const f of (listed || []).filter(f => /\.xlsx$/i.test(f.name) && siteOf(f.name))) {
    const o = byName.get(f.name);
    if (o) dupes.push(f.name);
    if (!o || f.modifiedTime > o.modifiedTime) byName.set(f.name, f);
  }
  return { files: [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), dupes };
}
// every site must come through, or a renamed / moved / unshared workbook would wipe that site's history
export function checkSet(files, rows, summary) {
  for (const [, site] of SITES) {
    if (!files.some(f => siteOf(f.name) === site)) throw new Error(`no workbook for ${site} in the folder; nothing sent`);
    if (!rows.some(r => r.site === site)) throw new Error(`no trims read for ${site}; nothing sent`);
  }
  if (rows.length < MIN_LINES) throw new Error(`only ${rows.length} lines read (${summary}); nothing sent`);
}
export function summaryOf(files, rows) {
  const trims = new Set(rows.map(r => `${r.file}|${r.tab}|${r.block}`)).size;
  const undated = [...new Set(rows.filter(r => !r.start_date).map(r => `${r.file}: ${r.tab}`))];
  return { trims, text: `${files.length} workbooks, ${trims} trims, ${rows.length} strain lines` + (undated.length ? `; no date read from ${undated.join(', ')}` : '') };
}
const verOf = f => f.md5Checksum || f.modifiedTime || '';

/* ---- one run ---- */

// ctx: { mode: 'write' | 'shadow', state: { cache, rows_sig, compared_sig }, sourceId: the folder }
export async function run(io, ctx) {
  const folder = ctx.sourceId;
  if (!folder) throw new Error('the 2026 TRIM SHEETS folder is not set (pipeline_sync_settings, job trims)');
  const st = ctx.state || {};
  const { files, dupes } = pickFiles(await io.listFolder(folder));
  if (!files.length) throw new Error('no site trim workbooks found in the folder');
  const sourceSig = await io.sha256(files.map(f => `${f.name}\t${f.id}\t${verOf(f)}`).join('\n'));

  // the lines of every workbook read before, kept by file (a parser change reads them all again)
  const old = st.cache && st.cache.parser === PARSER && st.cache.files ? st.cache.files : {};
  const files_ = {};
  for (const f of files) if (old[f.name] && old[f.name].id === f.id && old[f.name].ver === verOf(f)) files_[f.name] = old[f.name];
  const todo = files.filter(f => !files_[f.name]).sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0));
  if (ctx.mode === 'shadow' && !todo.length && st.compared_sig === sourceSig) return { status: 'unchanged', source_sig: sourceSig };

  const parsed = [];
  let parseMs = 0, parsedBytes = 0;
  for (const f of todo) {
    // at least one workbook per run; then only while the next one should still fit (time per byte so far x its size)
    const guess = parsedBytes && Number(f.size) ? (parseMs / parsedBytes) * Number(f.size) : 0;
    if (parsed.length && parseMs + guess > BUDGET_MS) break;
    const bytes = await io.download(f);
    const t0 = io.now();
    const lines = parseWorkbook(io.XLSX, bytes, f.name);
    parseMs += io.now() - t0;
    parsedBytes += bytes.length;
    files_[f.name] = { id: f.id, ver: verOf(f), modified: f.modifiedTime || null, lines };
    parsed.push(f.name);
  }
  const cache = { parser: PARSER, files: files_ };
  const remaining = todo.length - parsed.length;
  if (remaining) {
    return { status: 'partial', parsed, remaining, parse_ms: Math.round(parseMs), source_sig: sourceSig, continue: true,
      state: { source_sig: sourceSig, cache } };
  }

  const rows = files.flatMap(f => files_[f.name].lines);
  const sum = summaryOf(files, rows);
  checkSet(files, rows, sum.text);
  const newest = files.map(f => f.modifiedTime).filter(Boolean).sort().pop() || null;
  const meta = { file_modified: newest, files: files.length, trims: sum.trims };
  const base = { rows: rows.length, summary: sum.text, parsed, parse_ms: Math.round(parseMs), dupes, source_sig: sourceSig };
  if (ctx.mode === 'write') {
    // unchanged lines only stamp the time, as the Mac job does when its signature matches the last one it sent. Signed
    // with sorted keys: cached lines come back from jsonb in another key order than freshly read ones
    const sig = await io.sha256(stableJson(rows));
    const same = sig === st.rows_sig;
    const result = await io.apply(same ? null : rows, meta);
    return { ...base, status: same ? 'unchanged' : 'saved', result, state: { source_sig: sourceSig, written_sig: sourceSig, rows_sig: sig, cache } };
  }
  // shadow: comparable only when the Mac's last run read the same newest workbook (pipeline_trims_meta.file_modified)
  const live = await io.live();
  const liveVersion = (live && live.meta && live.meta.file_modified) || null;
  const comparable = sameInstant(liveVersion, newest);
  const diff = diffRows(rows, (live && live.rows) || [], SPEC);
  return { ...base, status: comparable ? 'compared' : 'waiting', live_version: liveVersion, comparable, diff,
    state: comparable ? { source_sig: sourceSig, compared_sig: sourceSig, cache } : { source_sig: sourceSig, cache } };
}
