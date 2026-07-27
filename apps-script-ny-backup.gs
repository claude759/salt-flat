/**
 * NY Labor Tracker → Google Sheet backup
 * ---------------------------------------------------------------------------
 * Mirrors the ny_* tables into one tab each, overwriting on every run. Google
 * Sheets keeps a revision per run, so its built-in File → Version history IS
 * the point-in-time restore: scroll back to 12:55 PM and the rows are there.
 *
 * Runs on Google's schedule, so it does not depend on anyone's laptop.
 *
 * WHY THIS EXISTS: on 2026-07-27 a whole-table delete wiped a morning of task
 * entries and there was no way to get them back (PITR off, no restore points).
 *
 * SETUP (once, ~5 minutes)
 *   1. Create a Google Sheet, e.g. "NY Tracker Backup".
 *   2. Extensions → Apps Script, and paste this file in.
 *   3. Project Settings (gear) → Script properties → add two:
 *        SB_EMAIL     = automation@wizardtrees.com
 *        SB_PASSWORD  = (that account's password — same one ~/gusto-sync/.env uses)
 *      Credentials live here, never in the code.
 *   4. Run `backupNow` once and approve the authorization prompt.
 *   5. Triggers (clock icon) → Add trigger → backupNow → Time-driven →
 *      Minutes timer → Every 10 minutes.
 *
 * TO RESTORE: File → Version history → All versions → pick the moment before
 * the loss, read the rows off the tab, and re-enter them (or ask Claude to
 * write them back). Restoring is deliberately manual — an automatic writer
 * pointed at production is the exact class of thing that caused the incident.
 */

var SB_URL = 'https://dhiqhgtmelxwelyoowle.supabase.co';
var SB_ANON = 'sb_publishable_FtScmtn1C0tE1bwUsavJFg_koiVEu14';   // publishable; RLS does the guarding

// Explicit column order per table: a backup should be stable and readable, not
// dependent on whatever key order the API happened to return.
//
// `order` MUST be a total ordering. Paging with Range headers over a sort key
// that has ties (work_date) lets pages overlap and silently drop rows — this was
// measured against the live API, not assumed — so every list ends in a unique key.
var TABLES = [
  { name: 'ny_tasks', order: 'work_date,id',
    cols: ['id','work_date','task','people','begin_at','end_at','packaged','labeled',
           'seconds','hours','cost','note','updated_by','created_at','updated_at'] },
  { name: 'ny_units_days', order: 'work_date',
    cols: ['work_date','p10_prod','p10_pre','p10_post','pk5_prod','pk5_pre','pk5_post',
           'jar_pack','jar_label','bud_pack','bud_label','pouch_pack','pouch_label','prep',
           'hours','ppl','tot_pack','tot_label','tot_prep','uph','lbs_pack','lbs_label',
           'source','updated_by','updated_at'] },
  { name: 'ny_notes', order: 'work_date',
    cols: ['work_date','note','updated_by','updated_at'] },
  { name: 'ny_roster', order: 'last,id',
    cols: ['id','last','first','full_name','team','default_company','default_rate',
           'aliases','active','created_at'] },
  { name: 'ny_shifts', order: 'work_date,id',
    cols: ['id','category','work_date','company','team','roster_id','last','first',
           'clock_in','clock_out','break_minutes','hours','rate','total','people',
           'pay_period','source_id','overlap_ok','source','photo_path','note',
           'updated_by','created_at','updated_at'] },
];

function signIn_() {
  var props = PropertiesService.getScriptProperties();
  var email = props.getProperty('SB_EMAIL'), pass = props.getProperty('SB_PASSWORD');
  if (!email || !pass) throw new Error('Set SB_EMAIL and SB_PASSWORD in Script properties first.');
  var res = UrlFetchApp.fetch(SB_URL + '/auth/v1/token?grant_type=password', {
    method: 'post', contentType: 'application/json',
    headers: { apikey: SB_ANON },
    payload: JSON.stringify({ email: email, password: pass }),
    muteHttpExceptions: true,
  });
  var body = JSON.parse(res.getContentText() || '{}');
  if (!body.access_token) throw new Error('Supabase sign-in failed: ' + res.getContentText().slice(0, 200));
  return body.access_token;
}

// Page through a table so this keeps working as the data grows.
function fetchAll_(jwt, t) {
  var out = [], from = 0, PAGE = 1000;
  while (true) {
    var url = SB_URL + '/rest/v1/' + t.name + '?select=*&order=' + encodeURIComponent(t.order);
    var res = UrlFetchApp.fetch(url, {
      headers: { apikey: SB_ANON, Authorization: 'Bearer ' + jwt,
                 Range: from + '-' + (from + PAGE - 1) },
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    if (code !== 200 && code !== 206) throw new Error(t.name + ' read failed (' + code + '): ' + res.getContentText().slice(0, 200));
    var rows = JSON.parse(res.getContentText() || '[]');
    out = out.concat(rows);
    if (rows.length < PAGE) return out;
    from += PAGE;
  }
}

function cell_(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function backupNow() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var jwt = signIn_();

  // Fetch EVERYTHING before writing anything. A transient failure must never
  // blank a tab — that would destroy the very history we are keeping.
  var fetched = [];
  for (var i = 0; i < TABLES.length; i++) {
    fetched.push({ t: TABLES[i], rows: fetchAll_(jwt, TABLES[i]) });
  }

  var stamp = Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd HH:mm:ss');
  var counts = [];
  for (var j = 0; j < fetched.length; j++) {
    var t = fetched[j].t, rows = fetched[j].rows;
    var sheet = ss.getSheetByName(t.name) || ss.insertSheet(t.name);
    var values = [t.cols];
    for (var r = 0; r < rows.length; r++) {
      var line = [];
      for (var c = 0; c < t.cols.length; c++) line.push(cell_(rows[r][t.cols[c]]));
      values.push(line);
    }
    sheet.clearContents();
    sheet.getRange(1, 1, values.length, t.cols.length).setValues(values);
    sheet.setFrozenRows(1);
    counts.push(t.name + '=' + rows.length);
  }

  // a short log so a stalled backup is obvious at a glance
  var log = ss.getSheetByName('_log') || ss.insertSheet('_log');
  if (log.getLastRow() === 0) log.appendRow(['backed up at (ET)', 'row counts']);
  log.appendRow([stamp, counts.join('  ')]);
  if (log.getLastRow() > 500) log.deleteRows(2, log.getLastRow() - 500);   // keep it small
}
