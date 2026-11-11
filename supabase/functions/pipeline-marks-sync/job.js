// job.js (pipeline-marks-sync): the red cells of the DISTRO PIPELINE tab, every 5 minutes. The cloud copy of
// ~/ar-automation/pipeline-marks-sync.mjs on Gianni's Mac: the same reading of red, the same rows, the same meta stamps
// (pipeline_marks_save's rules, through pipeline_sync_apply). Pure: Google and the database come in through `io`
// (runtime.ts gives the real ones, tests/pipeline-sync-check.mjs fakes), so the node check runs exactly this code.
import { diffRows, sameInstant } from './core.js';

export const JOB = 'marks';
export const FUNCTION = 'pipeline-marks-sync';
// read-only on purpose: pipeline-writer can edit the workbook through its link, and a bug here must never be able to
export const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets.readonly';
export const STALE_SECONDS = 240;   // a run holding the job longer than this is taken to have died (runs take seconds)
export const TAB = 'DISTRO PIPELINE';
export const MIN_ROWS = 50;
export const FIELDS = 'sheets(data(rowData(values(formattedValue,effectiveFormat(backgroundColor,textFormat(foregroundColor,strikethrough)),textFormatRuns(format(foregroundColor))))))';
// how a shadow run compares with public.pipeline_marks
export const SPEC = { key: ['r', 'c'], fields: { r: 'int', c: 'int', fill: 'bool0', text: 'bool0', part: 'bool0', strike: 'bool0', txt: 'text' } };

/* ---- parsing: exactly the Mac job's ---- */

// red: a strong red hue (red channel well above green and blue): #FF0000, #CC0000, #980000, #660000; not pink, orange or the pale rose fills
export function isRed(c) {
  if (!c) return false;
  const r = (c.red || 0) * 255, g = (c.green || 0) * 255, b = (c.blue || 0) * 255;
  return r >= 0x50 && g <= r * 0.35 && b <= r * 0.35;
}
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
export function marksFrom(rowData) {
  const out = [];
  (rowData || []).forEach((row, r) => (row.values || []).forEach((v, c) => {
    const txt = clean(v.formattedValue);
    if (!txt) return;
    const f = v.effectiveFormat || {}, tf = f.textFormat || {};
    const fill = isRed(f.backgroundColor), text = isRed(tf.foregroundColor);
    const part = !text && (v.textFormatRuns || []).some(x => isRed(x.format && x.format.foregroundColor));
    const strike = !!tf.strikethrough;
    if (fill || text || part || strike) out.push({ r, c, fill, text, part, strike, txt });
  }));
  return out;
}
export const rowDataOf = (grid) => grid && grid.sheets && grid.sheets[0] && grid.sheets[0].data && grid.sheets[0].data[0] && grid.sheets[0].data[0].rowData;
export const summaryOf = (rowData, marks) => `${rowData.length} rows, ${marks.length} marked cells (${marks.filter(m => m.fill).length} red fill, ` +
  `${marks.filter(m => m.text).length} red text, ${marks.filter(m => m.part).length} partly red, ${marks.filter(m => m.strike).length} struck through)`;

/* ---- one run ---- */

// ctx: { mode: 'write' | 'shadow', state: what the last runs left (written_sig, compared_sig), sourceId: the workbook }
// Returns the report the runtime logs; `state` in it is what to keep for the next run.
export async function run(io, ctx) {
  const wb = ctx.sourceId;
  if (!wb) throw new Error('no workbook: the CA row of schedule_board has no workbook id');
  const modified = (await io.driveMeta(wb, 'modifiedTime')).modifiedTime || null;
  const st = ctx.state || {};
  // the sheet has not changed since the last write: only the sync time is stamped (the Mac's stamp-only call)
  if (ctx.mode === 'write' && modified && st.written_sig === modified) {
    await io.apply(null, { sheet_modified: modified });
    return { status: 'unchanged', source_sig: modified };
  }
  if (ctx.mode === 'shadow' && modified && st.compared_sig === modified) return { status: 'unchanged', source_sig: modified };

  const rowData = rowDataOf(await io.sheetGrid(wb, TAB, FIELDS));
  if (!rowData || rowData.length < MIN_ROWS) throw new Error(`the ${TAB} tab came back with ${rowData ? rowData.length : 0} rows; nothing sent`);
  const marks = marksFrom(rowData);
  const summary = summaryOf(rowData, marks);
  if (ctx.mode === 'write') {
    const result = await io.apply(marks, { sheet_modified: modified });
    return { status: 'saved', rows: marks.length, summary, source_sig: modified, result, state: { source_sig: modified, written_sig: modified } };
  }
  // shadow: compare with the table, write nothing, stamp nothing. A difference counts only when the Mac's last write
  // read the same version of the sheet (pipeline_marks_meta.sheet_modified); otherwise the next run compares again.
  const live = await io.live();
  const liveVersion = (live && live.meta && live.meta.sheet_modified) || null;
  const comparable = sameInstant(liveVersion, modified);
  const diff = diffRows(marks, (live && live.rows) || [], SPEC);
  return { status: comparable ? 'compared' : 'waiting', rows: marks.length, summary, source_sig: modified, live_version: liveVersion,
    comparable, diff, state: comparable ? { source_sig: modified, compared_sig: modified } : { source_sig: modified } };
}
