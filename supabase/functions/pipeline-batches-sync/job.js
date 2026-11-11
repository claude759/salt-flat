// job.js (pipeline-batches-sync): Victoria's batch list, hourly. Since 2026-11-11 it is the BATCH LABEL SHEET tab of
// her WIZARD TREES WORKBOOK (a Google Sheet, read as an .xlsx export); before, the WIZARD tab of "Batch Label
// Sheet.xlsx". The source link pasted on the Admin page is the workbook. The cloud copy of
// ~/ar-automation/pipeline-batches-sync.mjs on Gianni's Mac: the same active rows (above the FINISHED/COMPLETE ITEMS
// divider) plus the finished rows of the last FINISHED_DAYS days, the same rows and meta stamps (pipeline_batches_save's
// rules, through pipeline_sync_apply). The file is read again only when its md5 or the day (UTC) changed, since the
// finished window moves with the day (a Google Sheet has no md5, so its modified time stands in). Pure: Google, the database and SheetJS come in through `io`.
import { diffRows, sameInstant } from './core.js';

export const JOB = 'batches';
export const FUNCTION = 'pipeline-batches-sync';
export const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';   // read-only on purpose
export const STALE_SECONDS = 600;
export const TABS = ['BATCH LABEL SHEET', 'WIZARD'];   // the first that exists, as the Mac job does
export const FINISHED_DAYS = 120;
export const NATIVE = 'application/vnd.google-apps.spreadsheet';

/* ---- parsing: exactly the Mac job's ---- */

const norm = s => String(s ?? '').toUpperCase().replace(/[^A-Z0-9/]+/g, ' ').trim();
// column -> header words (the first row); the finished block repeats an older header, so positions come from row 1
const COLS = {
  status: ['STATUS'], strain: ['STRAIN', 'STRAIN NAME'], item: ['ITEM', 'PRODUCT'], class: ['CLASS'], cross_name: ['CROSS'],
  harvest_date: ['HRVST DATE', 'HARVEST DATE'], package_date: ['PCKG DATE', 'PACKAGE DATE'], batch_code: ['PRODUCTION BATCH', 'BATCH'],
  cult_lic: ['CULT LIC'], distro_lic: ['DISTRO LIC'], tested_by: ['TESTED BY'], thc: ['THC'], cbd: ['CBD'], total_canna: ['TOTAL CANNA'],
  metrc_uid: ['METRC UID'], coa: ['COA LINK', 'COA'], total_units: ['TOTAL UNITS'], budtender_units: ['BUDTENDER UNITS'], cases: ['CASES'],
  distru_qty: ['QTY MADE IN DISTRU'], received_date: ['RECIEVE DATE', 'RECEIVE DATE', 'RECEIVED DATE'], test_date: ['TEST DATE'],
  coa_date: ['COA RETURN DATE'], nabis_date: ['NABIS P/U DATE', 'NABIS PU DATE', 'NABIS PICKUP DATE'],
};
const REQUIRED = ['status', 'strain', 'item', 'batch_code', 'metrc_uid', 'harvest_date', 'package_date'];
const DATES = ['harvest_date', 'package_date', 'received_date', 'test_date', 'coa_date', 'nabis_date'];
const NUMS = ['thc', 'cbd', 'total_canna', 'total_units', 'budtender_units', 'cases', 'distru_qty'];
const TEXTS = ['status', 'strain', 'item', 'class', 'cross_name', 'batch_code', 'cult_lic', 'distro_lic', 'tested_by', 'metrc_uid'];
const NOTE_LABEL = { harvest_date: 'Harvest', package_date: 'Package', received_date: 'Received', test_date: 'Test',
  coa_date: 'COA return', nabis_date: 'Nabis P/U', total_units: 'Units', budtender_units: 'Budtender units', cases: 'Cases', distru_qty: 'Distru qty' };

export const iso = d => d.toISOString().slice(0, 10);
const okYear = y => y >= 2018 && y <= 2040;
// Excel serials 43101..51501 are 2018..2040; small numbers in a date column (box counts typed into the old
// layout's columns) are not dates
function toDate(v) {
  if (typeof v === 'number') { if (v < 43101 || v > 51501) return null; return iso(new Date(Math.round((v - 25569) * 864e5))); }
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (!okYear(y) || +m[1] < 1 || +m[1] > 12 || +m[2] < 1 || +m[2] > 31) return null;
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})-(\d\d)-(\d\d)/);
  return m && okYear(+m[1]) ? m[0] : null;
}
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').trim();
  if (!/^-?[\d,]*\.?\d+\s*%?$/.test(s)) return null;
  return parseFloat(s.replace(/[,%\s]/g, ''));
}
// potency: the sheet keeps fractions (0.3057); someone typing 30.57 means the same
const pct = n => n == null ? null : Math.round((n <= 1 ? n * 100 : n) * 100) / 100;
const isErr = v => typeof v === 'string' && /^#(REF|N\/A|VALUE|DIV\/0|NAME|NUM|NULL)!?/i.test(v.trim());
const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();

// the batch tab as rows (the Mac job's sheet_to_json(header: 1, raw: true, defval: '', blankrows: true)) plus each
// cell's hyperlink
export function parseBatches(XLSX, bytes, today = iso(new Date())) {
  const wb = XLSX.read(bytes, { type: 'array', cellDates: false });
  const tab = TABS.find((t) => wb.Sheets[t]);
  const ws = tab && wb.Sheets[tab];
  if (!ws) throw new Error(`no ${TABS.join(' or ')} tab (tabs: ${wb.SheetNames.join(', ')})`);
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true });
  const linkAt = (r, c) => { const x = ws[XLSX.utils.encode_cell({ r, c })]; return x && x.l && x.l.Target; };
  return parseGrid(grid, linkAt, today);
}
export function parseGrid(grid, linkAt, today = iso(new Date())) {
  const head = (grid[0] || []).map(norm);
  const col = {};
  for (const [k, names] of Object.entries(COLS)) {
    const i = head.findIndex(h => names.includes(h));
    if (i >= 0) col[k] = i;
  }
  const missing = REQUIRED.filter(k => col[k] == null);
  if (missing.length) throw new Error(`header changed: can't find ${missing.join(', ')} in row 1`);

  let divider = -1;
  grid.forEach((r, i) => {
    if (divider < 0 && i > 0 && !clean(r[col.status]) && r.some(c => /FINISHED|COMPLETE(D)?\s+ITEMS/i.test(String(c)))) divider = i;
  });
  const since = iso(new Date(Date.parse(today + 'T12:00:00Z') - FINISHED_DAYS * 864e5));
  const rows = [];
  let activeCount = 0, finishedAll = 0;
  grid.forEach((r, i) => {
    if (i === 0 || i === divider) return;
    if (norm(r[col.status]) === 'STATUS') return;                       // the finished block's own header
    const get = k => col[k] == null ? '' : r[col[k]];
    if (!clean(get('strain')) && !clean(get('batch_code')) && !clean(get('metrc_uid'))) return;
    const o = { sheet_row: i + 1, finished: divider >= 0 && i > divider };
    const notes = [];
    for (const k of TEXTS) { const v = get(k); o[k] = isErr(v) ? null : clean(v) || null; }
    for (const k of DATES) {
      const v = get(k); o[k] = toDate(v);
      if (!o[k] && typeof v === 'string' && clean(v) && !isErr(v)) notes.push(`${NOTE_LABEL[k]}: ${clean(v)}`);
    }
    for (const k of NUMS) {
      const v = get(k); o[k] = isErr(v) ? null : toNum(v);
      if (o[k] == null && typeof v === 'string' && clean(v) && !isErr(v)) notes.push(NOTE_LABEL[k] ? `${NOTE_LABEL[k]}: ${clean(v)}` : clean(v));
    }
    o.thc = pct(o.thc); o.cbd = pct(o.cbd); o.total_canna = pct(o.total_canna);
    // COA: the cell's hyperlink when it has one, else its text when that is a URL
    const coaText = clean(get('coa')), link = col.coa == null ? null : linkAt(i, col.coa);
    o.coa_url = link && /^https?:\/\//i.test(link) ? link : /^https?:\/\//i.test(coaText) ? coaText : null;
    o.coa_text = coaText && !/^https?:\/\//i.test(coaText) && !isErr(coaText) ? coaText : null;
    o.notes = notes.length ? notes.join(' · ') : null;
    if (o.finished) {
      finishedAll++;
      const last = [o.package_date, o.coa_date, o.nabis_date, o.test_date, o.received_date, o.harvest_date].filter(Boolean).sort().pop();
      if (!last || last < since) return;
    } else activeCount++;
    rows.push(o);
  });
  return { rows, divider: divider >= 0 ? divider + 1 : null, activeCount, finishedAll, since };
}

export const SPEC = { key: ['sheet_row'], fields: Object.fromEntries([
  ['sheet_row', 'int'], ['finished', 'bool0'], ...TEXTS.map(k => [k, 'text']), ...DATES.map(k => [k, 'date']), ...NUMS.map(k => [k, 'num']),
  ['coa_url', 'text'], ['coa_text', 'text'], ['notes', 'text']]) };
export function summaryOf(p) {
  const fin = p.rows.filter(r => r.finished).length;
  return { fin, text: `${p.activeCount} active, ${fin} of ${p.finishedAll} finished since ${p.since}` +
    (p.divider ? `, divider row ${p.divider}` : ', NO divider row found (all rows treated as active)') };
}

/* ---- one run ---- */

// ctx: { mode: 'write' | 'shadow', state: { written_sig, rows_sig, compared_sig, cache: { meta } }, sourceId: the file }
export async function run(io, ctx) {
  const id = ctx.sourceId;
  if (!id) throw new Error('the Batch Label Sheet is not set (pipeline_sync_settings, job batches)');
  const st = ctx.state || {};
  const meta = await io.driveMeta(id, 'name,mimeType,modifiedTime,md5Checksum,trashed');
  if (meta.trashed) throw new Error(`${meta.name} is in the trash`);
  const today = io.today();
  const sourceSig = `${meta.md5Checksum || meta.modifiedTime || ''}|${today}`;
  // same file, same day: the parse would come out the same, so only the time is stamped (with the counts last sent)
  if (ctx.mode === 'write' && st.written_sig === sourceSig && st.cache && st.cache.meta) {
    await io.apply(null, { ...st.cache.meta, file_modified: meta.modifiedTime || null });
    return { status: 'unchanged', source_sig: sourceSig };
  }
  if (ctx.mode === 'shadow' && st.compared_sig === sourceSig) return { status: 'unchanged', source_sig: sourceSig };

  const bytes = meta.mimeType === NATIVE ? await io.exportXlsx(id) : await io.download({ id, name: meta.name, md5Checksum: meta.md5Checksum });
  const p = parseBatches(io.XLSX, bytes, today);
  const sum = summaryOf(p);
  if (!p.activeCount) throw new Error(`no active rows (${sum.text}); nothing sent`);
  const metaOut = { file_modified: meta.modifiedTime || null, active_rows: p.activeCount, finished_rows: sum.fin, finished_since: p.since };
  const base = { rows: p.rows.length, summary: sum.text, source_sig: sourceSig };
  if (ctx.mode === 'write') {
    const sig = await io.sha256(JSON.stringify(p.rows));
    const same = sig === st.rows_sig;
    const result = await io.apply(same ? null : p.rows, metaOut);
    const { file_modified: _f, ...counts } = metaOut;
    return { ...base, status: same ? 'unchanged' : 'saved', result,
      state: { source_sig: sourceSig, written_sig: sourceSig, rows_sig: sig, cache: { meta: counts } } };
  }
  // shadow: comparable only when the Mac's last run read the same file version on the same day
  const live = await io.live();
  const lm = (live && live.meta) || {};
  const comparable = sameInstant(lm.file_modified, meta.modifiedTime) && String(lm.finished_since || '').slice(0, 10) === p.since;
  const diff = diffRows(p.rows, (live && live.rows) || [], SPEC);
  return { ...base, status: comparable ? 'compared' : 'waiting', live_version: lm.file_modified || null, comparable, diff,
    state: comparable ? { source_sig: sourceSig, compared_sig: sourceSig } : { source_sig: sourceSig } };
}
