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
 * SETUP — two steps, the Sheet and this code are already in place:
 *   1. Project Settings (gear) → Script properties → add ONE property:
 *        SB_PASSWORD = the automation@wizardtrees.com password
 *                      (same value as AUTOMATION_PASSWORD in ~/gusto-sync/.env)
 *      The password stays here, never in the code and never in git.
 *   2. Pick `setup` in the function dropdown → Run. Approve the authorization
 *      prompt. That verifies the credential, installs the 10-minute trigger and
 *      takes the first backup immediately.
 *
 *   `setup` is safe to re-run — it replaces its own trigger rather than stacking.
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
           'vape_fill','vape_pack','vape_label',
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
  // the account is not a secret; only the password is, and it lives in Script
  // properties so it is never in this file or in git
  var email = props.getProperty('SB_EMAIL') || 'automation@wizardtrees.com';
  var pass = props.getProperty('SB_PASSWORD');
  if (!pass) throw new Error('Add a Script property SB_PASSWORD (the automation@wizardtrees.com password), then run setup again.');
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

/**
 * Run this once. Verifies the credential, installs the every-10-minutes trigger
 * (replacing any previous one so re-running never stacks them up), and takes an
 * immediate first backup so there is a baseline from minute one.
 */
function setup() {
  signIn_();   // fail fast and loudly if SB_PASSWORD is missing or wrong
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'backupNow') ScriptApp.deleteTrigger(existing[i]);
  }
  ScriptApp.newTrigger('backupNow').timeBased().everyMinutes(10).create();
  backupNow();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log('Backup is live, every 10 minutes → ' + ss.getUrl());
}

/**
 * A backup that fails quietly is worse than no backup — you find out when you
 * need it. Any failure is written into the _log tab (and re-thrown so Google
 * still emails its failure notice), so a stalled backup is visible at a glance.
 */
function backupNow() {
  try {
    runBackup_();
  } catch (err) {
    try {
      logLine_(SpreadsheetApp.getActiveSpreadsheet(),
               Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd HH:mm:ss'),
               'FAILED: ' + ((err && err.message) ? err.message : String(err)));
    } catch (ignored) { /* never let the reporter mask the real error */ }
    throw err;
  }
}

// One log line, written as TEXT. appendRow() would re-parse the timestamp into a
// serial, so write the cells directly with the format set first.
function logLine_(ss, a, b) {
  var log = ss.getSheetByName('_log') || ss.insertSheet('_log');
  if (log.getLastRow() === 0) {
    var head = log.getRange(1, 1, 1, 2);
    head.setNumberFormat('@');
    head.setValues([['backed up at (ET)', 'row counts']]);
  }
  var row = log.getRange(log.getLastRow() + 1, 1, 1, 2);
  row.setNumberFormat('@');
  row.setValues([[a, b]]);
  if (log.getLastRow() > 500) log.deleteRows(2, log.getLastRow() - 500);   // keep it small
  // trim rows that are empty but "used" (an earlier version formatted whole columns)
  var maxR = log.getMaxRows(), lastR = Math.max(log.getLastRow(), 1);
  if (maxR > lastR + 50) log.deleteRows(lastR + 1, maxR - lastR - 50);
}

function runBackup_() {
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
    var range = sheet.getRange(1, 1, values.length, t.cols.length);
    // Store everything as TEXT. Left alone, Sheets coerces '2026-07-27' into the
    // serial 46230 and '13:00:00' into 0.5417 — which still restores, but nobody
    // can read it in version history, and reading it is the entire point.
    range.setNumberFormat('@');
    range.setValues(values);
    sheet.setFrozenRows(1);
    counts.push(t.name + '=' + rows.length);
  }

  // a short log so a stalled backup is obvious at a glance
  logLine_(ss, stamp, counts.join('  '));
}
