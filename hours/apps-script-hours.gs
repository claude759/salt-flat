// ==============================================================
//  Wizard Trees - Distro Hours - Apps Script web app (all-in-one)
//
//  Serves the timesheet app itself (HtmlService) AND stores the rows
//  in a Google Sheet + reads dropped photos with Claude Vision. The
//  page and the backend are the same origin, so the browser talks to
//  the server with google.script.run - no CORS, no tokens, no keys in
//  the browser.
//
//  ACCESS = your deployment setting. Deploy "Execute as: Me" +
//  "Who has access: Anyone within Wizard Trees" - Google then only
//  lets @wizardtrees.com users open it, and Session.getActiveUser()
//  tells the script who they are. Everyone who's in has full access.
//
//  SETUP (one-time, ~5 min)
//  ------------------------
//  1. https://script.google.com -> New project.
//  2. Paste THIS file into Code.gs.
//  3. Add an HTML file named exactly  index  (File -> New -> HTML file ->
//     name it "index") and paste all of hours/index.html into it.
//  4. Project Settings -> Script properties -> add:
//        ANTHROPIC_API_KEY   sk-ant-...          (reuse the BA app's key)
//        OCR_MODEL           claude-opus-4-8   (optional; strong handwriting)
//  5. Run the `setup` function once (authorize when prompted). It makes
//     the "Distro Hours - app data" spreadsheet, seeds the roster, and
//     logs the spreadsheet URL - open it any time to view/edit the data.
//  6. Deploy -> New deployment -> Web app:
//        Execute as:      Me
//        Who has access:  Anyone within Wizard Trees
//     Open the /exec URL - that's the app. Bookmark/share it.
//     (Re-paste + "Manage deployments -> Edit -> New version" to update.)
// ==============================================================

var ALLOWED_DOMAIN = 'wizardtrees.com';
var ENTRY_COLS = ['id','category','company','work_date','pay_period','employee_id','last','first','team',
  'clock_in','clock_out','break_minutes','people','hours','rate','total','source','note','photo_id','overlap_ok','seq','created_by','created_at','updated_at'];
var EMP_COLS = ['id','last','first','full_name','default_rate','team','default_company','aliases','active'];

// -- Serve the app ---------------------------------------------
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Distro Hours')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    // allow the Labor/Unit Tracker (GitHub Pages) to embed this app in its Timesheets tab.
    // The Apps Script login still gates it, so embedding elsewhere just shows the login.
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// -- Auth: the accessing @wizardtrees.com user (deployment-gated) -
function requireUser_() {
  var email = (Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email || email.split('@')[1] !== ALLOWED_DOMAIN) throw new Error('Not authorized - sign in with your @' + ALLOWED_DOMAIN + ' account.');
  return email;
}

// -- API (called from the page via google.script.run) ----------
function apiLoad() {
  var email = requireUser_();
  var ss = getBook_();
  ensureSchema_(ss);   // auto-migrate the entries tab if columns changed
  return {
    ok: true,
    me: { email: email, name: email.split('@')[0] },
    entries: readTab_(getTab_(ss, 'entries', ENTRY_COLS), ENTRY_COLS),
    employees: readTab_(getTab_(ss, 'employees', EMP_COLS), EMP_COLS),
  };
}
function apiSave(rowsJson) {
  var email = requireUser_();
  var lock = LockService.getScriptLock(); lock.tryLock(20000);
  try { var ss = getBook_(); ensureSchema_(ss); saveEntries_(ss, JSON.parse(rowsJson), email); }
  finally { lock.releaseLock(); }
  return { ok: true };
}
// If the entries tab's header no longer matches ENTRY_COLS (e.g. a column was
// added), rebuild it preserving the data - so schema changes need no manual step.
function ensureSchema_(ss) {
  var sh = ss.getSheetByName('entries');
  if (!sh) return;
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  if (head.join('|') === ENTRY_COLS.join('|')) return;   // already current
  var rows = readTab_(sh, ENTRY_COLS);   // maps by name; missing cols -> null
  ss.deleteSheet(sh);
  var neu = getTab_(ss, 'entries', ENTRY_COLS);
  rows.forEach(function (o) { neu.appendRow(ENTRY_COLS.map(function (c) { return o[c] == null ? '' : o[c]; })); });
}
function apiParseNotes(text) {
  requireUser_();
  try { return { ok: true, data: parseHarvestNotes_(String(text || '')) }; }
  catch (e) { Logger.log('parse: ' + e); return { ok: false, error: 'parse_failed' }; }
}
function apiDelete(id) {
  requireUser_();
  var lock = LockService.getScriptLock(); lock.tryLock(20000);
  try { deleteRow_(getTab_(getBook_(), 'entries', ENTRY_COLS), id); } finally { lock.releaseLock(); }
  return { ok: true };
}
function apiRoster(rowsJson) {
  requireUser_();
  var lock = LockService.getScriptLock(); lock.tryLock(20000);
  try { upsertEmployees_(getBook_(), JSON.parse(rowsJson)); } finally { lock.releaseLock(); }
  return { ok: true };
}
function apiRosterDelete(id) {
  requireUser_();
  var lock = LockService.getScriptLock(); lock.tryLock(20000);
  try { deleteRow_(getTab_(getBook_(), 'employees', EMP_COLS), id); } finally { lock.releaseLock(); }
  return { ok: true };
}
function apiOcr(base64, mime) {
  requireUser_();
  try {
    var data = extractTimesheet_(base64, mime || 'image/jpeg');
    return { ok: true, data: data, photoId: savePhoto_(base64, mime) };
  }
  catch (e) { Logger.log('ocr: ' + e); return { ok: false, error: 'extraction_failed' }; }
}
function apiOcrNotes(base64, mime) {   // harvest photo -> Claude Vision -> parsed rows
  requireUser_();
  try {
    var data = visionHarvestNotes_(base64, mime || 'image/jpeg');
    return { ok: true, data: data, photoId: savePhoto_(base64, mime) };
  }
  catch (e) { Logger.log('ocrnotes: ' + e); return { ok: false, error: 'parse_failed' }; }
}
function apiGetPhoto(id) {             // fetch a stored timesheet photo for review
  requireUser_();
  try {
    var blob = DriveApp.getFileById(String(id)).getBlob();
    return { ok: true, mime: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()) };
  } catch (e) { return { ok: false, error: 'not_found' }; }
}
function apiSavePhoto(base64, mime) {  // store a photo attached after the fact
  requireUser_();
  try {
    var ext = (mime === 'image/png') ? '.png' : '.jpg';
    var name = 'timesheet-' + Utilities.formatDate(new Date(), tz_(), 'yyyyMMdd-HHmmss') + ext;
    var blob = Utilities.newBlob(Utilities.base64Decode(base64), mime || 'image/jpeg', name);
    return { ok: true, photoId: photosFolder_().createFile(blob).getId() };
  } catch (e) {
    var msg = String(e && e.message || e);
    Logger.log('savePhoto: ' + msg);
    var perm = msg.indexOf('permission') >= 0 || msg.indexOf('Authorization') >= 0 || msg.indexOf('PERMISSION') >= 0;
    return { ok: false, error: perm ? 'drive_permission' : msg };
  }
}

// -- Photo storage: a Drive folder owned by the deploying account ------------
function photosFolder_() {
  var id = props_().getProperty('PHOTO_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var f = DriveApp.createFolder('Distro Hours - timesheet photos');
  props_().setProperty('PHOTO_FOLDER_ID', f.getId());
  return f;
}
function savePhoto_(base64, mime) {
  try {
    var ext = (mime === 'image/png') ? '.png' : '.jpg';
    var name = 'timesheet-' + Utilities.formatDate(new Date(), tz_(), 'yyyyMMdd-HHmmss') + ext;
    var blob = Utilities.newBlob(Utilities.base64Decode(base64), mime || 'image/jpeg', name);
    return photosFolder_().createFile(blob).getId();
  } catch (e) { Logger.log('savePhoto: ' + e); return null; }
}
// Run me ONCE from the editor after this update to grant the new Drive permission.
function authorizePhotos() { Logger.log('Photo folder ready: ' + photosFolder_().getUrl()); }
function apiImport() {                 // load the 74 historical Distro rows + seed roster
  requireUser_();
  var lock = LockService.getScriptLock(); lock.tryLock(30000);
  try { var n = importHistory(); return { ok: true, count: n }; }
  catch (e) { Logger.log('import: ' + e); return { ok: false, error: String(e && e.message || e) }; }
  finally { lock.releaseLock(); }
}

// -- Spreadsheet helpers ---------------------------------------
function props_() { return PropertiesService.getScriptProperties(); }

function getBook_() {
  var id = props_().getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.create('Distro Hours - app data');
  props_().setProperty('SHEET_ID', ss.getId());
  return ss;
}

function getTab_(ss, name, cols) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readTab_(sh, cols) {
  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  var head = vals[0].map(String);
  var idx = {}; cols.forEach(function (c) { idx[c] = head.indexOf(c); });
  var out = [];
  for (var r = 1; r < vals.length; r++) {
    if (!vals[r][idx.id]) continue;
    var o = {};
    cols.forEach(function (c) { o[c] = idx[c] >= 0 ? vals[r][idx[c]] : null; });
    out.push(normalizeOut_(o));
  }
  return out;
}

// Sheets store dates/times as Date objects; normalize to the strings the app uses.
function normalizeOut_(o) {
  if (o.work_date instanceof Date) o.work_date = Utilities.formatDate(o.work_date, tz_(), 'yyyy-MM-dd');
  if (o.pay_period instanceof Date) o.pay_period = Utilities.formatDate(o.pay_period, tz_(), 'yyyy-MM-dd');
  else if (o.pay_period === '') o.pay_period = null;
  if (o.photo_id === '') o.photo_id = null;
  o.overlap_ok = (o.overlap_ok === true || o.overlap_ok === 'true' || o.overlap_ok === 'TRUE');
  o.seq = Number(o.seq) || 0;
  ['clock_in', 'clock_out'].forEach(function (k) {
    if (o[k] instanceof Date) o[k] = Utilities.formatDate(o[k], tz_(), 'HH:mm');
    else if (o[k] != null && o[k] !== '') o[k] = String(o[k]).slice(0, 5);
    else o[k] = null;
  });
  if (typeof o.aliases === 'string') o.aliases = o.aliases ? o.aliases.split('|').filter(String) : [];
  if (o.active === '' ) o.active = true; else o.active = o.active !== 'FALSE' && o.active !== false;
  ['break_minutes', 'people', 'hours', 'rate', 'total', 'default_rate'].forEach(function (k) {
    if (o[k] === '') o[k] = null; else if (o[k] != null) o[k] = Number(o[k]);
  });
  return o;
}
function tz_() { return Session.getScriptTimeZone() || 'America/Los_Angeles'; }

// -- Server-owned hours/total (mirrors the client) -------------
function computeHours_(cin, cout, brk) {
  if (!cin || !cout) return null;
  var a = String(cin).split(':'), b = String(cout).split(':');
  var mins = (Number(b[0]) * 60 + Number(b[1])) - (Number(a[0]) * 60 + Number(a[1]));
  if (isNaN(mins)) return null;
  if (mins < 0) mins += 24 * 60;
  var h = (mins - (Number(brk) || 0)) / 60;
  if (h < 0) h = 0;
  return Math.round(h * 100) / 100;
}

function rowIndexById_(sh, id) {
  var ids = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (var r = 1; r < ids.length; r++) if (String(ids[r][0]) === String(id)) return r + 1;
  return -1;
}
function deleteRow_(sh, id) { var r = rowIndexById_(sh, id); if (r > 0) sh.deleteRow(r); }

function saveEntries_(ss, rows, email) {
  var sh = getTab_(ss, 'entries', ENTRY_COLS);
  rows.forEach(function (row) {
    var bm = Number(row.break_minutes);                                                 // clamp 0..1440
    row.break_minutes = (isFinite(bm) && bm > 0) ? Math.min(Math.round(bm), 1440) : 0;
    var rt = Number(row.rate);                                                           // no negative pay
    row.rate = (isFinite(rt) && rt >= 0) ? rt : 20;
    var pp = Number(row.people);                                                         // crew size (harvest); 1 for distro
    row.people = (isFinite(pp) && pp > 0) ? Math.round(pp) : 1;
    row.hours = computeHours_(row.clock_in, row.clock_out, row.break_minutes);           // server owns these
    row.total = row.hours == null ? null : Math.round(row.hours * row.rate * row.people * 100) / 100;
    row.updated_at = new Date().toISOString();
    var line = ENTRY_COLS.map(function (c) { return row[c] == null ? '' : row[c]; });
    var existing = row.id ? rowIndexById_(sh, row.id) : -1;
    if (existing > 0) { sh.getRange(existing, 1, 1, ENTRY_COLS.length).setValues([line]); }
    else {
      if (!row.id) line[0] = Utilities.getUuid();
      line[ENTRY_COLS.indexOf('created_by')] = email;
      line[ENTRY_COLS.indexOf('created_at')] = new Date().toISOString();
      sh.appendRow(line);
    }
  });
}

function upsertEmployees_(ss, rows) {
  var sh = getTab_(ss, 'employees', EMP_COLS);
  rows.forEach(function (row) {
    if (Array.isArray(row.aliases)) row.aliases = row.aliases.join('|');
    if (row.active == null) row.active = true;
    var line = EMP_COLS.map(function (c) { return row[c] == null ? '' : row[c]; });
    var existing = row.id ? rowIndexById_(sh, row.id) : -1;
    if (existing > 0) sh.getRange(existing, 1, 1, EMP_COLS.length).setValues([line]);
    else { if (!row.id) line[0] = Utilities.getUuid(); sh.appendRow(line); }
  });
}

// -- Claude Vision OCR of the timesheet photo ------------------
var OCR_INSTRUCTION =
'You are reading a photo of a paper EMPLOYEE TIME SHEET (a sign-in sheet). It has a title header ' +
'naming a company/LLC, then a table: LAST NAME | FIRST NAME | DATE | TIME IN | TIME OUT | LUNCH | SIGNATURE.\n' +
'Return ONLY a JSON object, no prose:\n' +
'{"company": string|null, "sheet_date": "YYYY-MM-DD"|null, "rows": [{"last": string|null, "first": string|null, ' +
'"date": "YYYY-MM-DD"|null, "time_in": "HH:MM"|null, "time_out": "HH:MM"|null, "break_minutes": number|null}]}\n' +
'- company: from the TITLE header, usually Filifera/Slane/Portal (drop ", LLC" + license numbers).\n' +
'- Ignore the SIGNATURE column. One object per named data row; skip blanks + the header.\n' +
'- 24-hour "HH:MM"; infer AM/PM from an 8am-6pm workday ("8:00" in = 08:00, "5:00" out = 17:00).\n' +
'- CARRY-DOWN: a ditto mark ("), a blank cell inside a bracket, or a vertical line/brace/arrow drawn ' +
'down a column all mean "same value as the row above". Apply the carried value to EVERY row the mark ' +
'or line spans - this applies to TIME IN, TIME OUT, LUNCH and DATE alike. Only leave a value null when ' +
'the cell is truly empty with no mark or line through it.\n' +
'- break_minutes from the LUNCH column: "12-1" = 60; "12-12:30" = 30; blank with no mark = 0.\n' +
'- ONE SHEET = ONE DAY: every row on the sheet is the same work date. Determine the sheet date from the ' +
'clearest/majority DATE entry (assume 2026 if no year; ignore an obviously miswritten outlier) and use ' +
'it for sheet_date AND for every row date.\n' +
'- Preserve names exactly as handwritten.';

function extractTimesheet_(base64, mime) {
  var key = props_().getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  var model = props_().getProperty('OCR_MODEL') || 'claude-opus-4-8';
  var payload = {
    model: model, max_tokens: 3000,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
      { type: 'text', text: OCR_INSTRUCTION },
    ] }],
  };
  var r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  if (r.getResponseCode() !== 200) throw new Error('anthropic ' + r.getResponseCode());
  var data = JSON.parse(r.getContentText());
  var text = (data.content || []).map(function (c) { return c.text || ''; }).join('').trim();
  var parsed = parseJsonLoose_(text) || {};
  return {
    company: cleanCompany_(parsed.company),
    sheet_date: isDate_(parsed.sheet_date) ? parsed.sheet_date : null,
    rows: (parsed.rows || []).map(normRow_).filter(function (x) { return x; }),
  };
}
function parseJsonLoose_(t) {
  try { return JSON.parse(t); } catch (e) {}
  var a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e2) {} }
  return null;
}
function cleanCompany_(c) {
  if (typeof c !== 'string') return null;
  var s = c.replace(/,?\s*LLC.*$/i, '').trim();
  var known = ['Filifera', 'Slane', 'Portal'];
  for (var i = 0; i < known.length; i++) if (s.toLowerCase().indexOf(known[i].toLowerCase()) >= 0) return known[i];
  return s || null;
}
function isDate_(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }
function cleanTime_(v) {
  if (typeof v !== 'string') return null;
  var m = v.trim().match(/^(\d{1,2}):(\d{2})$/); if (!m) return null;
  var h = Number(m[1]); if (h > 23 || Number(m[2]) > 59) return null;
  return ('0' + h).slice(-2) + ':' + m[2];
}
function normRow_(r) {
  if (!r || typeof r !== 'object') return null;
  var last = typeof r.last === 'string' ? r.last.trim() : null;
  var first = typeof r.first === 'string' ? r.first.trim() : null;
  if (!last && !first) return null;
  var bm = Number(r.break_minutes); if (!isFinite(bm) || bm < 0) bm = 0; bm = Math.min(Math.round(bm), 1440);
  return { last: last || null, first: first || null, date: isDate_(r.date) ? r.date : null,
    time_in: cleanTime_(r.time_in), time_out: cleanTime_(r.time_out), break_minutes: bm };
}

// -- One-time setup: create the book, seed the roster ----------
// -- Parse messy harvest/deleaf notes (typed text OR a photo) via Claude -----
function harvestInstr_() {
  return 'You are parsing messy, informal HARVEST/DELEAF labor notes into structured rows. ' +
    'The input may be typed text OR a photo of handwritten notes; read whatever is given.\n' +
    'Location mapping (map any mention to the business): "23rd" -> Slane; "25th" -> Filifera; ' +
    '"imperial"/"imp" -> Imperial; "Olympic"/"Olimpic" -> Olympic.\n' +
    'Each note describes a crew OR a named person working at a location on a date, for a time range, on a ' +
    'task (harvest, veg, deleaf, clean lamps, transplant, loading, general cleaning, etc).\n' +
    'Return ONLY a JSON object, no prose: {"rows":[{"date":"YYYY-MM-DD"|null,"location":string|null,' +
    '"task":string|null,"worker":string|null,"people":number|null,"rate":number|null,"time_in":"HH:MM"|null,"time_out":"HH:MM"|null,"note":string}]}\n' +
    'Rules:\n' +
    '- Bare dates like "6/7", "jun 6", "5/27", "6/20/16" are year 2026 (ignore an obviously wrong year like 16). Output YYYY-MM-DD.\n' +
    '- PAY: NORMA is paid $25/hr; everyone else is $20/hr. Set "rate" 25 for a Norma row, 20 otherwise.\n' +
    '- SEPARATE NORMA: whenever "Norma" (or "+norma") is part of a crew, output her as her OWN row ' +
    '(worker "Norma", people 1, rate 25) for that same date/location/task/time, AND do NOT count her in the crew. ' +
    'Example: "8 people + norma" -> a crew row {people 8, rate 20} PLUS a separate {worker "Norma", people 1, rate 25}. ' +
    'A bare number of people is that count at rate 20.\n' +
    '- A specific named person (Esmeralda, Issac, Stefani, Elmer, Oscar, Lili, Andres, Norma, Nouri, ...) -> ' +
    'worker = that name, people = 1 unless a count is given. One row per date for that person.\n' +
    '- Times: "7 to 5pm" -> 07:00/17:00; "8:30 to 4pm" -> 08:30/16:00; "10:50-2:00" -> 10:50/14:00; ' +
    '"5pm to 9pm" -> 17:00/21:00. Infer AM/PM for a normal daytime shift.\n' +
    '- If the image has a header naming the location or person, apply it to every row below it.\n' +
    '- location: use the mapped business name (Slane/Filifera/Imperial/Olympic). If none is given, null.\n' +
    '- task: short label incl. room if noted. note: a short snippet of the original line (incl. things like "no lunch").\n' +
    '- One row per distinct work entry. Skip pure header/label lines with no work info.\n';
}
function callClaude_(content, maxTokens) {
  var key = props_().getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  var model = props_().getProperty('OCR_MODEL') || 'claude-opus-4-8';
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: model, max_tokens: maxTokens || 8000, messages: [{ role: 'user', content: content }] }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('anthropic ' + res.getResponseCode());
  var data = JSON.parse(res.getContentText());
  return (data.content || []).map(function (c) { return c.text || ''; }).join('').trim();
}
function harvestRowsFrom_(out) {
  var parsed = parseJsonLoose_(out) || {};
  return { rows: (parsed.rows || []).map(normNote_).filter(function (x) { return x; }) };
}
function parseHarvestNotes_(text) {
  return harvestRowsFrom_(callClaude_(harvestInstr_() + '\nNOTES TO PARSE:\n' + text, 8000));
}
function visionHarvestNotes_(base64, mime) {
  return harvestRowsFrom_(callClaude_([
    { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
    { type: 'text', text: harvestInstr_() + '\nParse the harvest/deleaf notes shown in the attached photo.' },
  ], 8000));
}
function cleanLocation_(s) {
  if (typeof s !== 'string') return null;
  var t = s.toLowerCase();
  if (t.indexOf('slane') >= 0 || t.indexOf('23') >= 0) return 'Slane';
  if (t.indexOf('filifera') >= 0 || t.indexOf('25') >= 0) return 'Filifera';
  if (t.indexOf('imp') >= 0) return 'Imperial';
  if (t.indexOf('olim') >= 0 || t.indexOf('olym') >= 0) return 'Olympic';
  return s.trim() || null;
}
function normNote_(r) {
  if (!r || typeof r !== 'object') return null;
  var people = Number(r.people); if (!isFinite(people) || people < 1) people = 1; people = Math.round(people);
  var worker = typeof r.worker === 'string' ? r.worker.trim() : null;
  var isNorma = worker && /norma/i.test(worker);       // Norma = $25/hr, everyone else $20/hr
  return {
    date: isDate_(r.date) ? r.date : null,
    location: cleanLocation_(r.location),
    task: typeof r.task === 'string' ? r.task.trim() : null,
    worker: worker,
    rate: isNorma ? 25 : 20,
    people: isNorma ? 1 : people,
    time_in: cleanTime_(r.time_in),
    time_out: cleanTime_(r.time_out),
    note: typeof r.note === 'string' ? r.note.trim().slice(0, 120) : null,
  };
}

function setup() {
  var ss = getBook_();
  getTab_(ss, 'entries', ENTRY_COLS);
  var emp = getTab_(ss, 'employees', EMP_COLS);
  if (emp.getLastRow() < 2) {
    SEED_ROSTER.forEach(function (r) {
      emp.appendRow([Utilities.getUuid(), r[0], r[1], (r[0] + ' ' + r[1]).trim(), r[2], r[3], r[4], (r[5] || []).join('|'), true]);
    });
  }
  Logger.log('Spreadsheet ready: ' + ss.getUrl());
  Logger.log('SHEET_ID = ' + ss.getId());
}
// -- One-time import of historical Distro hours (from the workbook) -----------
// Run this ONCE from the editor (pick 'importHistory' -> Run). Idempotent: it
// preserves any real rows you've entered, drops prior 'import' rows, rebuilds
// the entries tab so the 'category' column exists, seeds the roster if empty,
// then loads the historical rows as category 'distro'.
function importHistory() {
  var ss = getBook_();
  var emp = getTab_(ss, 'employees', EMP_COLS);
  if (emp.getLastRow() < 2) {
    SEED_ROSTER.forEach(function (r) {
      emp.appendRow([Utilities.getUuid(), r[0], r[1], (r[0] + ' ' + r[1]).trim(), r[2], r[3], r[4], (r[5] || []).join('|'), true]);
    });
  }
  // preserve any non-import rows, then rebuild the tab with the current schema
  var keep = [];
  var oldSh = ss.getSheetByName('entries');
  if (oldSh) { keep = readTab_(oldSh, ENTRY_COLS).filter(function (e) { return e.source !== 'import'; }); ss.deleteSheet(oldSh); }
  var sh = getTab_(ss, 'entries', ENTRY_COLS);
  keep.forEach(function (o) { sh.appendRow(ENTRY_COLS.map(function (c) { return o[c] == null ? '' : o[c]; })); });
  var now = new Date().toISOString();
  HISTORY.forEach(function (row) {
    // row: [company,date,last,first,team,in,out,break,rate,pay_period,note]
    var o = { id: Utilities.getUuid(), category: 'distro', company: row[0], work_date: row[1],
      pay_period: row[9] || null, last: row[2], first: row[3], team: row[4], clock_in: row[5], clock_out: row[6],
      break_minutes: row[7], people: 1, rate: row[8], note: row[10] || null,
      source: 'import', created_by: 'import', created_at: now, updated_at: now };
    o.hours = computeHours_(o.clock_in, o.clock_out, o.break_minutes);
    o.total = o.hours == null ? null : Math.round(o.hours * o.rate * 100) / 100;
    sh.appendRow(ENTRY_COLS.map(function (c) { return o[c] == null ? '' : o[c]; }));
  });
  Logger.log('Imported ' + HISTORY.length + ' historical Distro rows (+ kept ' + keep.length + ' existing).');
  return HISTORY.length;
}
// HISTORY row: [company, date, last, first, team, clock_in, clock_out, break_minutes, rate, pay_period, note]

var HISTORY = [
  ["Filifera","2026-06-11","Ortega","Lucy","Norma's Team","08:00","15:00",60,20,"2026-06-20","missed on last payroll"],
  ["Portal","2026-06-15","Ortega","Lucy","Norma's Team","09:10","12:30",0,20,"2026-06-20","missed on last payroll"],
  ["Slane","2026-06-11","","Elmer","Norma's Team","14:11","16:10",0,20,"2026-06-20","missed on last payroll"],
  ["Slane","2026-06-11","Diaz","Oscar","Norma's Team","14:11","16:10",0,20,"2026-06-20","missed on last payroll"],
  ["Filifera","2026-06-11","Torres","Lucero","Norma's Team","08:00","15:00",60,20,"2026-06-20","missed on last payroll"],
  ["Portal","2026-06-22","Goldomez","Ronnie","Norma's Team","09:00","16:30",60,20,"",""],
  ["Portal","2026-06-22","Lopez","Esmeralda","Norma's Team","09:00","16:30",60,20,"",""],
  ["Filifera","2026-06-22","Diaz","Oscar","Norma's Team","08:00","17:15",60,20,"",""],
  ["Filifera","2026-06-22","Vasquez","Teresa","Norma's Team","08:00","17:15",60,20,"",""],
  ["Filifera","2026-06-22","Torres","Lucero","Norma's Team","08:00","17:15",60,20,"",""],
  ["Filifera","2026-06-22","Beltran","Dina","Norma's Team","08:00","17:15",60,20,"",""],
  ["Filifera","2026-06-22","Nguyen","Thanh","Justin's Team","08:00","17:15",60,20,"",""],
  ["Filifera","2026-06-22","Zuluogo","Andres","Norma's Team","09:00","17:15",60,20,"",""],
  ["Portal","2026-06-23","Lopez","Esmeralda","Norma's Team","08:50","15:43",55,20,"",""],
  ["Portal","2026-06-23","Delgado","Norma","Norma's Team","08:50","15:43",55,25,"",""],
  ["Filifera","2026-06-23","Diaz","Oscar","Norma's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-06-23","Torres","Lucero","Norma's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-06-23","Vasquez","Teresa","Norma's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-06-23","Zuluogo","Andres","Norma's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-06-23","Andvade","Maria","Norma's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-06-23","Beltran","Dina","Norma's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-06-23","Nguyen","Thanh","Justin's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-06-23","Pham","Suong","Justin's Team","08:00","17:20",60,20,"",""],
  ["Portal","2026-06-24","Delgado","Norma","Norma's Team","08:00","17:18",60,25,"",""],
  ["Portal","2026-06-24","Lopez","Esmeralda","Norma's Team","08:00","17:18",60,20,"",""],
  ["Portal","2026-06-24","Torres","Lucero","Norma's Team","08:00","17:18",60,20,"",""],
  ["Portal","2026-06-24","Diaz","Oscar","Norma's Team","08:00","11:30",0,20,"",""],
  ["Portal","2026-06-24","Zuluogo","Andres","Norma's Team","08:00","17:18",60,20,"",""],
  ["Portal","2026-06-24","Nguyen","Thanh","Justin's Team","08:00","17:18",60,20,"",""],
  ["Portal","2026-06-24","Pham","Suong","Justin's Team","08:00","17:18",60,20,"",""],
  ["Portal","2026-06-24","Diaz","Oscar","Norma's Team","16:30","17:18",0,20,"",""],
  ["Portal","2026-06-24","","Elmer","Norma's Team","16:30","17:18",0,20,"",""],
  ["Portal","2026-06-25","Nguyen","Thanh","Justin's Team","08:00","11:40",0,20,"",""],
  ["Portal","2026-06-25","Pham","Suong","Justin's Team","08:00","11:40",0,20,"",""],
  ["Portal","2026-06-25","Diaz","Oscar","Norma's Team","08:00","11:40",0,20,"",""],
  ["Portal","2026-06-25","Lopez","Esmeralda","Norma's Team","08:00","11:40",0,20,"",""],
  ["Portal","2026-06-26","Lopez","Esmeralda","Norma's Team","11:00","16:30",0,20,"",""],
  ["Portal","2026-06-26","Delgado","Norma","Norma's Team","11:14","16:30",0,25,"",""],
  ["Portal","2026-06-26","Zuluogo","Andres","Norma's Team","11:14","16:30",0,20,"",""],
  ["Portal","2026-06-29","Fuentes","Liliana","Norma's Team","09:00","16:40",60,20,"",""],
  ["Portal","2026-06-29","Zuluogo","Andres","Norma's Team","09:00","16:40",60,20,"",""],
  ["Portal","2026-06-29","Parra","Yesenia","Norma's Team","09:00","16:40",60,20,"",""],
  ["Portal","2026-06-29","Lopez","Esmeralda","Norma's Team","09:08","16:40",60,20,"",""],
  ["Portal","2026-06-29","Delgado","Norma","Norma's Team","14:15","16:40",0,25,"",""],
  ["Portal","2026-06-30","Lopez","Esmeralda","Norma's Team","09:00","17:05",60,20,"",""],
  ["Portal","2026-06-30","Zuluogo","Andres","Norma's Team","09:00","17:05",60,20,"",""],
  ["Portal","2026-06-30","Delgado","Norma","Norma's Team","09:00","12:00",0,25,"",""],
  ["Portal","2026-06-30","Fuentes","Liliana","Norma's Team","09:00","17:05",60,20,"",""],
  ["Portal","2026-06-30","Parra","Yesenia","Norma's Team","09:00","12:00",0,20,"",""],
  ["Portal","2026-06-30","Diaz","Oscar","Norma's Team","13:00","17:05",0,20,"",""],
  ["Filifera","2026-07-01","Delgado","Norma","Norma's Team","08:00","11:34",0,25,"",""],
  ["Filifera","2026-07-01","Vasquez","Teresa","Norma's Team","08:00","16:55",60,20,"",""],
  ["Filifera","2026-07-01","Andvade","Maria","Norma's Team","08:00","16:55",60,20,"",""],
  ["Filifera","2026-07-01","Diaz","Oscar","Norma's Team","08:00","16:55",60,20,"",""],
  ["Filifera","2026-07-01","Torres","Lucero","Norma's Team","08:00","16:55",60,20,"",""],
  ["Filifera","2026-07-01","Parra","Tany","Norma's Team","08:00","16:55",60,20,"",""],
  ["Filifera","2026-07-01","Pham","Suong","Justin's Team","08:00","16:55",60,20,"",""],
  ["Filifera","2026-07-01","Nguyen","Thanh","Justin's Team","08:00","16:55",60,20,"",""],
  ["Filifera","2026-07-01","Beltran","Dina","Norma's Team","08:00","16:55",60,20,"",""],
  ["Filifera","2026-07-02","Vasquez","Teresa","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-07-02","Andvade","Maria","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-07-02","Diaz","Oscar","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-07-02","Torres","Lucero","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-07-02","Beltran","Dina","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-07-02","Nguyen","Thanh","Justin's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-07-02","Pham","Suong","Justin's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-07-02","Ortega","Lucy","Norma's Team","08:19","17:00",60,20,"",""],
  ["Filifera","2026-07-03","Torres","Lucero","Norma's Team","08:00","18:00",60,20,"",""],
  ["Filifera","2026-07-03","Vasquez","Teresa","Norma's Team","08:00","18:00",60,20,"",""],
  ["Filifera","2026-07-03","Ferro","Lorraine","Norma's Team","08:00","18:00",60,20,"",""],
  ["Filifera","2026-07-03","Nguyen","Thanh","Justin's Team","08:00","18:00",60,20,"",""],
  ["Filifera","2026-07-03","Pham","Suong","Justin's Team","08:00","18:00",60,20,"",""],
  ["Filifera","2026-07-03","Delgado","Diana","Norma's Team","08:00","18:00",60,20,"",""],
  ["Filifera","2026-07-03","Diaz","Oscar","Norma's Team","08:00","18:00",60,20,"",""],
  ["Portal","2026-01-19","Perez","Yamileth","08:20:00","15:00","00:30",370,123.4,"",""],
  ["Portal","2026-01-19","Beltran","Dina","08:20:00","15:00","00:30",370,123.4,"",""],
  ["Portal","2026-01-19","Torres","Lucero","08:20:00","15:00","00:30",370,123.4,"",""],
  ["Portal","2026-01-19","Delgado","Diana","08:20:00","15:00","00:30",370,123.4,"",""],
  ["Portal","2026-01-20","Nguyen","Thanh","08:30:00","17:00",null,450,150,"",""],
  ["Portal","2026-01-20","Han","Xue","08:30:00","17:00",null,450,150,"",""],
  ["Portal","2026-01-20","Velasquez","Jenny","12:50:00","16:00",null,130,43.4,"",""],
  ["Portal","2026-01-20","Delgado","Norma","11:00:00","16:20",null,320,106.6,"",""],
  ["Portal","2026-01-20","Delgado","Diana","11:00:00","16:20",null,320,106.6,"",""],
  ["Portal","2026-01-20","","Tani","11:00:00","16:20",null,320,133.25,"",""],
  ["Portal","2026-01-21","Torres","Lucero","08:48:00","17:00","00:30",462,154,"",""],
  ["Portal","2026-01-21","Beltran","Dina","08:48:00","17:00","00:30",462,154,"",""],
  ["Portal","2026-01-21","Delgado","Diana","08:48:00","17:00","00:30",462,154,"",""],
  ["Portal","2026-01-21","Velasquez","Jenny","08:48:00","17:00","00:30",462,154,"",""],
  ["Portal","2026-01-22","Chen","Yujie","09:00:00","13:20","00:30",230,76.6,"",""],
  ["Portal","2026-01-22","Chen","Libin","09:00:00","13:20","00:30",230,76.6,"",""],
  ["Portal","2026-01-22","Li","Airu","09:00:00","13:20","00:30",230,76.6,"",""],
  ["Portal","2026-01-22","Ma","Yushum","09:00:00","13:20","00:30",230,76.6,"",""],
  ["Portal","2026-01-22","Liu","Mark","09:00:00","13:20","00:30",230,76.6,"",""],
  ["Portal","2026-01-22","Perez","Yamileth","09:00:00","13:10","00:30",220,73.4,"",""],
  ["Portal","2026-01-22","Torres","Lucero","09:00:00","13:10","00:30",220,73.4,"",""],
  ["Portal","2026-01-22","Beltran","Dina","09:00:00","13:10","00:30",220,73.4,"",""],
  ["Portal","2026-01-22","Velasquez","Jenny","09:00:00","13:10","00:30",220,73.4,"",""],
  ["Filifera","2026-01-22","Perez","Yamileth","13:20:00","16:30",null,190,63.4,"",""],
  ["Filifera","2026-01-22","Torres","Lucero","13:20:00","16:30",null,190,63.4,"",""],
  ["Filifera","2026-01-22","Beltran","Dina","13:20:00","16:30",null,190,63.4,"",""],
  ["Filifera","2026-01-22","Diaz","Oscar","09:00:00","16:30","00:30",420,140,"",""],
  ["Filifera","2026-01-22","Delgado","Norma","09:00:00","16:30","00:30",420,175,"",""],
  ["Filifera","2026-01-22","Delgado","Diana","09:00:00","16:30","00:30",420,140,"",""],
  ["Filifera","2026-01-23","Nguyen","Thanh","08:00:00","17:10","00:30",520,173.4,"",""],
  ["Filifera","2026-01-23","Han","Xue","08:00:00","17:10","00:30",520,173.4,"",""],
  ["Filifera","2026-01-23","Pham","Suong","08:00:00","17:10","00:30",520,173.4,"",""],
  ["Filifera","2026-01-23","Diaz","Oscar","09:30:00","14:00","00:30",240,80,"",""],
  ["Filifera","2026-01-23","Delgado","Diana","09:30:00","17:00","00:30",420,140,"",""],
  ["Filifera","2026-01-23","Torres","Lucero","09:30:00","17:00","00:30",420,140,"",""],
  ["Filifera","2026-01-23","Perez","Yamileth","09:30:00","17:00","00:30",420,140,"",""],
  ["Filifera","2026-01-23","Delgado","Norma","14:00:00","17:00","00:00",180,75,"",""],
  ["Filifera","2026-01-24","Nguyen","Thanh","08:00:00","17:00","00:30",510,170,"",""],
  ["Filifera","2026-01-24","Han","Xue","08:00:00","17:00","00:30",510,170,"",""],
  ["Filifera","2026-01-24","Pham","Suong","08:00:00","17:00","00:30",510,170,"",""],
  ["Filifera","2026-01-24","Perez","Yamileth","08:00:00","16:40","00:30",490,163.4,"",""],
  ["Filifera","2026-01-24","Delgado","Diana","08:00:00","16:40","00:30",490,163.4,"",""],
  ["Filifera","2026-01-24","Torres","Lucero","08:00:00","16:40","00:30",490,163.4,"",""],
  ["Filifera","2026-01-24","Delgado","Norma","08:00:00","13:00","00:00",300,125,"",""],
  ["Filifera","2026-01-24","Vasquez","Teresa","13:25:00","16:40","00:00",195,65,"",""],
  ["Filifera","2026-01-26","Nguyen","Thanh","08:15:00","17:00","00:30",495,165,"",""],
  ["Filifera","2026-01-26","Han","Xue","08:15:00","17:00","00:30",495,165,"",""],
  ["Filifera","2026-01-26","Pham","Suong","08:15:00","17:00","00:30",495,165,"",""],
  ["Filifera","2026-01-26","Delgado","Norma","09:00:00","12:10","00:30",160,66.75,"",""],
  ["Filifera","2026-01-26","Delgado","Diana","09:00:00","17:00","00:30",450,150,"",""],
  ["Filifera","2026-01-26","Perez","Yamileth","09:05:00","17:00","00:30",445,148.4,"",""],
  ["Filifera","2026-01-26","Vasquez","Teresa","09:05:00","17:00","00:30",445,148.4,"",""],
  ["Filifera","2026-01-26","Torres","Lucero","09:20:00","17:00","00:30",430,143.4,"",""],
  ["Filifera","2026-01-26","Diaz","Oscar","09:20:00","17:00","00:30",430,143.4,"",""],
  ["Portal","2026-01-26","Dong","Liyan","09:00:00","16:00","00:30",390,130,"",""],
  ["Portal","2026-01-26","Chen","Yujie","09:00:00","16:00","00:30",390,130,"",""],
  ["Portal","2026-01-26","Li","Airu","09:00:00","16:00","00:30",390,130,"",""],
  ["Portal","2026-01-26","Ma","Yushum","09:00:00","16:00","00:30",390,130,"",""],
  ["Portal","2026-01-26","Liu","Mark","09:00:00","16:00","00:30",390,130,"",""],
  ["Portal","2026-01-26","Di Gang","Dong","09:00:00","16:00","00:30",390,130,"",""],
  ["Portal","2026-01-27","Li","Airu","09:00:00","12:00","00:00",180,60,"",""],
  ["Portal","2026-01-27","Ma","Yushum","09:00:00","12:00","00:00",180,60,"",""],
  ["Filifera","2026-01-27","Nguyen","Thanh","08:20:00","17:00","01:00",460,153.4,"",""],
  ["Filifera","2026-01-27","Han","Xue","08:30:00","17:00","01:00",450,150,"",""],
  ["Filifera","2026-01-27","Pham","Suong","08:20:00","17:00","01:00",460,153.4,"",""],
  ["Filifera","2026-01-27","Perez","Yamileth","08:00:00","17:00","00:30",510,170,"",""],
  ["Filifera","2026-01-27","Vasquez","Teresa","08:00:00","17:00","00:30",510,170,"",""],
  ["Filifera","2026-01-27","Beltran","Dina","08:00:00","17:00","00:30",510,170,"",""],
  ["Filifera","2026-01-27","Torres","Lucero","08:00:00","17:00","00:30",510,170,"",""],
  ["Filifera","2026-01-27","Delgado","Diana","08:00:00","17:00","00:30",510,170,"",""],
  ["Filifera","2026-01-28","Han","Xue","08:20:00","17:00","01:00",460,153.4,"",""],
  ["Filifera","2026-01-28","Pham","Suong","08:20:00","17:00","01:00",460,153.4,"",""],
  ["Filifera","2026-01-28","Torres","Lucero","08:00:00","17:00","00:30",510,170,"",""],
  ["Filifera","2026-01-28","Perez","Yamileth","08:00:00","17:00","00:30",510,170,"",""],
  ["Filifera","2026-01-28","Delgado","Diana","08:00:00","17:00","00:30",510,170,"",""],
  ["Filifera","2026-01-28","Diaz","Oscar","08:00:00","17:00","00:30",510,170,"",""],
  ["Filifera","2026-01-29","Perez","Yamileth","08:00:00","12:20",null,260,86.6,"",""],
  ["Filifera","2026-01-29","Delgado","Diana","08:00:00","12:20",null,260,86.6,"",""],
  ["Filifera","2026-01-29","Torres","Lucero","08:00:00","12:20",null,260,86.6,"",""],
  ["Filifera","2026-01-29","Galdames","Ronnie","08:00:00","12:20",null,260,86.6,"",""],
  ["Filifera","2026-01-29","Fuentes","Lily","08:00:00","12:20",null,260,86.6,"",""],
  ["Filifera","2026-01-30","Nguyen","Thanh","07:30:00","13:00","00:30",300,100,"",""],
  ["Filifera","2026-01-30","Han","Xue","08:00:00","13:00","00:30",270,90,"",""],
  ["Filifera","2026-01-30","Galdames","Ronnie","08:00:00","13:10","00:30",280,93.4,"",""],
  ["Filifera","2026-01-30","Beltran","Dina","08:00:00","13:10","00:30",280,93.4,"",""],
  ["Filifera","2026-01-30","Torres","Lucero","08:00:00","16:15","00:30",465,155,"",""],
  ["Filifera","2026-01-30","Delgado","Diana","08:00:00","16:15","00:30",465,155,"",""],
  ["Filifera","2026-01-30","Vasquez","Teresa","08:00:00","16:30","00:30",480,160,"",""],
  ["Filifera","2026-01-30","Perez","Yamileth","08:00:00","13:10","00:30",280,93.4,"",""],
  ["Filifera","2026-01-22","Nguyen","Thanh","08:15:00","17:10","01:00",475,158.4,"2026-01-31","Anna's Team"],
  ["Filifera","2026-01-22","Han","Xue","08:15:00","17:10","01:00",475,158.4,"2026-01-31","Justin's Team"],
  ["Filifera","2026-01-22","Nguyen","Tien","08:15:00","17:10","01:00",475,158.4,"2026-01-31",""],
  ["Portal","2026-02-02","Kitty","Dong","08:00:00","16:15","00:30",465,155,"",""],
  ["Portal","2026-02-02","Sun","Huiying","08:00:00","16:15","00:30",465,155,"",""],
  ["Portal","2026-02-02","Li","Airu","08:00:00","16:15","00:30",465,155,"",""],
  ["Portal","2026-02-02","Ma","Yushan","08:00:00","16:15","00:30",465,155,"",""],
  ["Portal","2026-02-02","Chen","Libin","08:00:00","16:15","00:30",465,155,"",""],
  ["Portal","2026-02-02","Liu","Mark","08:10:00","16:15","00:30",455,151.6,"",""],
  ["Filifera","2026-02-08","Vasquez","Teresa","08:00:00","13:00",null,300,100,"",""],
  ["Filifera","2026-02-08","Torres","Lucero","08:00:00","13:00",null,300,100,"",""],
  ["Filifera","2026-02-08","Beltran","Dina","08:00:00","13:00",null,300,100,"",""],
  ["Filifera","2026-02-08","Perez","Yamileth","08:00:00","13:00",null,300,100,"",""],
  ["Filifera","2026-02-09","Han","Xue","08:00:00","17:00","00:30",510,170,"",""],
  ["Filifera","2026-02-09","Nguyen","Thanh","08:00:00","17:00","00:30",510,170,"",""],
  ["Filifera","2026-02-09","Pham","Suong","08:00:00","17:00","00:30",510,170,"",""],
  ["Filifera","2026-02-09","Dong","Liyan","08:30:00","17:30","00:30",510,170,"",""],
  ["Filifera","2026-02-09","Dong","Xiaotao","08:30:00","17:30","00:30",510,170,"",""],
  ["Filifera","2026-02-09","Guan","Li Xian","08:30:00","17:30","00:30",510,170,"",""],
  ["Filifera","2026-02-09","Ma","Yushan","08:30:00","17:30","00:30",510,170,"",""],
  ["Filifera","2026-02-09","","Joyce","08:30:00","17:30","00:30",510,170,"",""],
  ["Filifera","2026-02-09","Yang","Jinxing","08:30:00","17:30","00:30",510,170,"",""],
  ["Filifera","2026-02-10","Han","Xue","08:00:00","13:00","00:30",270,90,"",""],
  ["Filifera","2026-02-10","Nguyen","Thanh","08:00:00","13:00","00:30",270,90,"",""],
  ["Filifera","2026-02-10","Pham","Suong","08:00:00","13:00","00:30",270,90,"",""],
  ["Filifera","2026-02-10","Dong","Liyan","08:00:00","13:00","00:30",270,90,"",""],
  ["Filifera","2026-02-10","Yang","Jinxing","08:00:00","13:00","00:30",270,90,"",""],
  ["Filifera","2026-02-10","Li","Airu","08:00:00","13:00","00:30",270,90,"",""],
  ["Filifera","2026-02-10","Ma","Yushan","08:00:00","13:00","00:30",270,90,"",""],
  ["Filifera","2026-02-11","Dong","Liyan","09:30:00","12:30",null,180,60,"",""],
  ["Filifera","2026-02-11","Ma","Yushan","09:30:00","12:30",null,180,60,"",""],
  ["Filifera","2026-02-11","Li","Airu","09:30:00","12:30",null,180,60,"",""],
  ["Filifera","2026-02-11","Yang","Jinxing","09:30:00","12:30",null,180,60,"",""],
  ["Portal","2026-02-12","Perez","Yamileth","09:30:00","13:37",null,247,82.4,"",""],
  ["Portal","2026-02-12","Torres","Lucero","09:30:00","13:37",null,247,82.4,"",""],
  ["Portal","2026-02-12","Balencuela","Stephani","09:30:00","13:37",null,247,82.4,"",""],
  ["Filifera","2026-02-13","Nguyen","Thanh","08:00:00","17:00","01:00",480,160,"",""],
  ["Filifera","2026-02-13","Han","Xue","08:00:00","17:00","01:00",480,160,"",""],
  ["Filifera","2026-02-13","Pham","Suong","08:00:00","17:00","01:00",480,160,"",""],
  ["Filifera","2026-02-13","Li","Airu","08:00:00","17:00","01:00",480,160,"",""],
  ["Filifera","2026-02-13","Sun","Huiying","08:00:00","17:00","01:00",480,160,"",""],
  ["Filifera","2026-02-13","Yu","Annie","08:00:00","17:00","01:00",480,160,"",""],
  ["Filifera","2026-02-13","Ma","Yushan","08:00:00","17:00","01:00",480,160,"",""],
  ["Filifera","2026-02-13","Perez","Yamileth","09:30:00","17:00","00:45",405,135,"",""],
  ["Filifera","2026-02-13","Torres","Lucero","09:30:00","17:00","00:45",405,135,"",""],
  ["Filifera","2026-02-13","Beltran","Dina","09:30:00","17:00","00:45",405,135,"",""],
  ["Filifera","2026-02-13","Valenzuela","Stephanie","09:30:00","17:00","00:45",405,135,"",""],
  ["Filifera","2026-02-13","Dong","Liyan","08:00:00","17:00","01:00",480,160,"",""],
  ["Filifera","2026-01-29","Perez","Yamileth","12:20:00","17:00",null,280,93.4,"2026-01-31",""],
  ["Filifera","2026-01-29","Delgado","Diana","12:20:00","17:00",null,280,93.4,"2026-01-31",""],
  ["Filifera","2026-01-29","Torres","Lucero","12:20:00","17:00",null,280,93.4,"2026-01-31",""],
  ["Filifera","2026-01-29","Galdames","Ronnie","12:20:00","17:00",null,280,93.4,"2026-01-31",""],
  ["Filifera","2026-01-29","Fuentes","Lily","12:20:00","17:00",null,280,93.4,"2026-01-31",""],
  ["Filifera","2026-02-14","Pham","Suong","Justin's Team","08:00","17:10",45,20,"",""],
  ["Filifera","2026-02-14","Nguyen","Thanh","Justin's Team","08:00","17:10",45,20,"",""],
  ["Filifera","2026-02-14","Han","Xue","Justin's Team","08:00","17:00",45,20,"",""],
  ["Filifera","2026-02-14","Ma","Yushan","Anna's Team","08:00","17:20",45,20,"",""],
  ["Filifera","2026-02-14","Ya","Changwei","Anna's Team","08:00","17:20",45,20,"",""],
  ["Filifera","2026-02-14","Dong","Liyan","Anna's Team","08:20","17:20",45,20,"",""],
  ["Filifera","2026-02-14","Yu","Annie","Anna's Team","08:00","17:20",45,20,"",""],
  ["Filifera","2026-02-14","Li","Airu","Anna's Team","08:00","17:20",45,20,"",""],
  ["Filifera","2026-02-14","Perez","Yamileth","Norma's Team","08:00","17:20",45,20,"",""],
  ["Filifera","2026-02-14","Vasquez","Teresa","Norma's Team","08:00","17:07",45,20,"",""],
  ["Filifera","2026-02-14","Valenzuela","Estafany","Norma's Team","09:29","17:07",45,20,"",""],
  ["Filifera","2026-02-14","Delgado","Norma","Norma's Team","09:15","17:07",45,25,"",""],
  ["Filifera","2026-02-15","Pham","Suong","Justin's Team","08:00","15:09",45,20,"",""],
  ["Filifera","2026-02-15","Nguyen","Thanh","Justin's Team","08:00","15:09",45,20,"",""],
  ["Filifera","2026-02-15","Torres","Lucero","Norma's Team","08:00","15:09",45,20,"",""],
  ["Filifera","2026-02-15","Beltran","Dina","Norma's Team","08:00","15:09",45,20,"",""],
  ["Filifera","2026-02-15","Vasquez","Teresa","Norma's Team","08:00","15:09",45,20,"",""],
  ["Filifera","2026-02-15","Perez","Yamileth","Norma's Team","08:00","15:09",45,20,"",""],
  ["Filifera","2026-02-15","Valenzuela","Estafany","Norma's Team","08:00","15:09",45,20,"",""],
  ["Filifera","2026-02-15","Han","Xue","Justin's Team","08:00","13:25",45,20,"",""],
  ["Filifera","2026-02-17","Perez","Yamileth","Norma's Team","09:00","16:30",60,20,"",""],
  ["Filifera","2026-02-17","Beltran","Dina","Norma's Team","09:00","16:30",60,20,"",""],
  ["Filifera","2026-02-17","Vasquez","Teresa","Norma's Team","09:00","16:30",60,20,"",""],
  ["Filifera","2026-02-17","Torres","Lucero","Norma's Team","09:00","16:30",60,20,"",""],
  ["Portal","2026-02-17","Cortes","Ulises","Norma's Team","09:00","15:42",30,20,"",""],
  ["Portal","2026-02-17","Jorge","Deny","Norma's Team","09:00","15:45",30,20,"",""],
  ["Portal","2026-02-17","Valenzuela","Estafany","Norma's Team","09:00","15:55",30,20,"",""],
  ["Portal","2026-02-17","Gonsales","Christian","Norma's Team","09:00","15:45",30,20,"",""],
  ["Filifera","2026-02-18","Nguyen","Thanh","Justin's Team","08:15","17:00",60,20,"",""],
  ["Filifera","2026-02-18","Pham","Suong","Justin's Team","08:15","17:00",60,20,"",""],
  ["Filifera","2026-02-18","Torres","Lucero","Norma's Team","08:30","17:00",60,20,"",""],
  ["Filifera","2026-02-18","Beltran","Dina","Norma's Team","08:30","17:00",60,20,"",""],
  ["Filifera","2026-02-18","Vasquez","Teresa","Norma's Team","08:30","17:00",60,20,"",""],
  ["Filifera","2026-02-18","Perez","Yamileth","Norma's Team","08:30","17:00",60,20,"",""],
  ["Filifera","2026-02-18","Valazques","Melina","Norma's Team","08:30","17:00",60,20,"",""],
  ["Filifera","2026-02-19","Nguyen","Thanh","Justin's Team","08:00","17:00",45,20,"",""],
  ["Filifera","2026-02-19","Han","Xue","Justin's Team","08:00","17:00",45,20,"",""],
  ["Filifera","2026-02-19","Pham","Suong","Justin's Team","08:00","17:00",45,20,"",""],
  ["Filifera","2026-02-19","Macias","Diego","Norma's Team","08:30","17:00",60,20,"",""],
  ["Filifera","2026-02-19","Fuentes","Liliana","Norma's Team","08:30","17:00",60,20,"",""],
  ["Filifera","2026-02-19","Perez","Yamileth","Norma's Team","08:30","17:00",60,20,"",""],
  ["Filifera","2026-02-19","Valenzuela","Estafany","Norma's Team","08:30","17:00",60,20,"",""],
  ["Filifera","2026-02-20","Perez","Yamileth","Norma's Team","10:00","12:45",0,20,"",""],
  ["Filifera","2026-02-20","Vasquez","Teresa","Norma's Team","10:00","12:45",0,20,"",""],
  ["Filifera","2026-02-20","Valazques","Melina","Norma's Team","10:00","12:45",0,20,"",""],
  ["Filifera","2026-02-20","Fuentes","Liliana","Norma's Team","10:00","12:45",0,20,"",""],
  ["Filifera","2026-02-23","Macias","Diego","Norma's Team","09:30","16:45",45,20,"",""],
  ["Filifera","2026-02-23","Beltran","Dina","Norma's Team","09:30","16:45",47,20,"",""],
  ["Filifera","2026-02-23","Torres","Lucero","Norma's Team","09:30","16:45",47,20,"",""],
  ["Filifera","2026-02-23","Vasquez","Teresa","Norma's Team","09:30","16:45",47,20,"",""],
  ["Filifera","2026-02-23","Perez","Yamileth","Norma's Team","09:30","16:45",45,20,"",""],
  ["Filifera","2026-02-23","Pham","Suong","Justin's Team","10:00","10:30",0,20,"",""],
  ["Filifera","2026-02-23","Nguyen","Thanh","Justin's Team","09:30","16:45",60,20,"",""],
  ["Filifera","2026-02-23","Han","Xue","Justin's Team","09:30","16:45",60,20,"",""],
  ["Filifera","2026-02-27","Han","Xue","Justin's Team","09:00","17:00",45,20,"",""],
  ["Filifera","2026-02-27","Pham","Suong","Justin's Team","09:00","17:00",45,20,"",""],
  ["Filifera","2026-02-27","Nguyen","Thanh","Justin's Team","09:00","17:00",45,20,"",""],
  ["Filifera","2026-02-27","Torres","Lucero","Norma's Team","08:35","17:00",45,20,"",""],
  ["Filifera","2026-02-27","Macias","Diego","Norma's Team","08:30","17:00",45,20,"",""],
  ["Filifera","2026-02-27","Fuentes","Liliana","Norma's Team","08:30","17:00",45,20,"",""],
  ["Filifera","2026-02-27","Vasquez","Teresa","Norma's Team","08:30","17:00",45,20,"",""],
  ["Filifera","2026-02-27","Perez","Yamileth","Norma's Team","08:30","17:00",45,20,"",""],
  ["Filifera","2026-02-24","Nguyen","Thanh","Justin's Team","08:00","10:00",0,20,"2026-02-28",""],
  ["Filifera","2026-02-24","Han","Xue","Justin's Team","08:00","10:00",0,20,"2026-02-28",""],
  ["Filifera","2026-02-24","Beltran","Dina","Norma's Team","08:00","10:40",0,20,"2026-02-28",""],
  ["Filifera","2026-02-24","Torres","Lucero","Norma's Team","08:00","10:40",0,20,"2026-02-28",""],
  ["Filifera","2026-02-24","Pham","Suong","Justin's Team","09:00","10:00",0,20,"2026-02-28",""],
  ["Filifera","2026-02-24","Valenzuela","Estefany","Norma's Team","08:00","10:40",0,20,"2026-02-28",""],
  ["Filifera","2026-02-24","Perez","Yamileth","Norma's Team","09:30","10:50",0,20,"2026-02-28",""],
  ["Filifera","2026-02-24","Vasquez","Teresa","Norma's Team","09:30","10:50",0,20,"2026-02-28",""],
  ["Portal","2026-02-25","Delgado","Norma","Norma's Team","10:18","14:32",0,25,"2026-02-28",""],
  ["Portal","2026-02-25","Delgado","Diana","Norma's Team","10:18","14:32",0,20,"2026-02-28",""],
  ["Filifera","2026-02-28","Nguyen","Thanh","Justin's Team","08:00","15:45",45,20,"",""],
  ["Filifera","2026-02-28","Han","Xue","Justin's Team","08:00","15:45",45,20,"",""],
  ["Filifera","2026-02-28","Pham","Suong","Justin's Team","08:00","15:45",45,20,"",""],
  ["Filifera","2026-02-28","Vasquez","Teresa","Norma's Team","08:00","11:00",45,20,"",""],
  ["Filifera","2026-02-28","Perez","Yamileth","Norma's Team","08:00","15:45",45,20,"",""],
  ["Filifera","2026-02-28","Torres","Lucero","Norma's Team","08:00","15:45",45,20,"",""],
  ["Filifera","2026-02-28","Macias","Diego","Norma's Team","08:00","15:45",45,20,"",""],
  ["Filifera","2026-02-28","Fuentes","Liliana","Norma's Team","08:00","15:45",45,20,"",""],
  ["Portal","2026-02-28","Delgado","Norma","Norma's Team","09:00","13:13",0,25,"",""],
  ["Portal","2026-02-28","Delgado","Diana","Norma's Team","09:00","13:13",0,20,"",""],
  ["Portal","2026-02-28","Beltran","Dina","Norma's Team","09:00","13:13",0,20,"",""],
  ["Portal","2026-03-02","Delgado","Norma","Norma's Team","13:20","16:36",0,25,"",""],
  ["Portal","2026-03-02","Parra","Tani","Norma's Team","13:20","16:36",0,20,"",""],
  ["Portal","2026-03-02","Delgado","Diana","Norma's Team","13:20","16:36",0,20,"",""],
  ["Portal","2026-03-02","Vasquez","Teresa","Norma's Team","13:20","16:36",0,20,"",""],
  ["Portal","2026-03-03","Perez","Yamileth","Norma's Team","08:00","15:10",30,20,"",""],
  ["Portal","2026-03-03","Delgado","Diana","Norma's Team","08:00","15:10",30,20,"",""],
  ["Portal","2026-03-03","Torres","Lucero","Norma's Team","08:00","15:10",30,20,"",""],
  ["Portal","2026-03-03","Beltran","Dina","Norma's Team","08:00","15:10",30,20,"",""],
  ["Portal","2026-03-03","Parra","Tani","Norma's Team","08:00","15:10",30,20,"",""],
  ["Portal","2026-03-03","Vasquez","Teresa","Norma's Team","08:00","15:10",30,20,"",""],
  ["Filifera","2026-03-04","Diaz","Oscar","Norma's Team","08:00","14:15",30,20,"",""],
  ["Filifera","2026-03-04","Parra","Tani","Norma's Team","08:00","14:15",30,20,"",""],
  ["Filifera","2026-03-04","Delgado","Diana","Norma's Team","08:00","14:15",30,20,"",""],
  ["Filifera","2026-03-04","Perez","Yamileth","Norma's Team","08:00","14:15",30,20,"",""],
  ["Portal","2026-03-06","Torres","Lucero","Norma's Team","09:00","12:52",0,20,"",""],
  ["Portal","2026-03-06","Delgado","Diana","Norma's Team","09:00","12:52",0,20,"",""],
  ["Slane","2026-03-06","Rodriguez","Angel","Norma's Team","12:00","15:00",0,20,"",""],
  ["Slane","2026-03-06","","Victor","Norma's Team","12:00","15:00",0,20,"",""],
  ["Portal","2026-03-09","Perez","Yamileth","Norma's Team","11:50","15:55",0,20,"",""],
  ["Portal","2026-03-09","Vasquez","Teresa","Norma's Team","11:50","15:55",0,20,"",""],
  ["Portal","2026-03-09","Fuentes","Liliana","Norma's Team","11:50","15:55",0,20,"",""],
  ["Portal","2026-03-09","Delgado","Norma","Norma's Team","11:58","15:55",0,25,"",""],
  ["Portal","2026-03-09","Delgado","Diana","Norma's Team","11:58","15:55",0,20,"",""],
  ["Portal","2026-03-09","Beltran","Dina","Norma's Team","12:00","15:55",0,20,"",""],
  ["Portal","2026-03-09","Torres","Lucero","Norma's Team","12:00","15:55",0,20,"",""],
  ["Filifera","2026-03-10","Nguyen","Thanh","Justin's Team","08:25","17:00",60,20,"",""],
  ["Filifera","2026-03-10","Han","Xue","Justin's Team","08:25","17:00",60,20,"",""],
  ["Filifera","2026-03-10","Pham","Suong","Justin's Team","08:25","17:00",60,20,"",""],
  ["Filifera","2026-03-10","Perez","Yamileth","Norma's Team","08:25","17:00",60,20,"",""],
  ["Filifera","2026-03-10","Torres","Lucero","Norma's Team","08:25","17:00",60,20,"",""],
  ["Filifera","2026-03-10","Beltran","Dina","Norma's Team","08:25","17:00",60,20,"",""],
  ["Filifera","2026-03-10","Delgado","Diana","Norma's Team","08:25","17:00",60,20,"",""],
  ["Filifera","2026-03-10","Vasquez","Teresa","Norma's Team","15:00","17:00",0,20,"",""],
  ["Filifera","2026-03-10","Valenzuela","Estefany","Norma's Team","15:00","17:00",0,20,"",""],
  ["Filifera","2026-03-11","Perez","Yamileth","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-03-11","Vasquez","Teresa","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-03-11","Beltran","Dina","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-03-11","Torres","Lucero","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-03-11","Delgado","Norma","Norma's Team","08:00","17:00",60,25,"",""],
  ["Filifera","2026-03-11","Delgado","Diana","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-03-11","Valenzuela","Estefany","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-03-11","Pham","Suong","Justin's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-03-11","Nguyen","Thanh","Justin's Team","08:00","17:30",60,20,"",""],
  ["Filifera","2026-03-12","Han","Xue","Justin's Team","08:20","17:00",60,20,"",""],
  ["Filifera","2026-03-12","Nguyen","Thanh","Justin's Team","08:20","17:00",60,20,"",""],
  ["Filifera","2026-03-12","Pham","Suong","Justin's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-03-12","Delgado","Norma","Norma's Team","08:00","17:00",60,25,"",""],
  ["Filifera","2026-03-12","Delgado","Diana","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-03-12","Beltran","Dina","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-03-12","Rodriguez","Angel","Norma's Team","10:00","17:00",60,20,"",""],
  ["Filifera","2026-03-12","Torres","Lucero","Norma's Team","10:00","17:00",60,20,"",""],
  ["Filifera","2026-03-12","Vasquez","Teresa","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-03-12","Perez","Yamileth","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-03-13","Nguyen","Thanh","Justin's Team","08:00","17:10",30,20,"",""],
  ["Filifera","2026-03-13","Han","Xue","Justin's Team","08:00","17:10",30,20,"",""],
  ["Filifera","2026-03-13","Pham","Suong","Justin's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-03-13","Delgado","Norma","Norma's Team","08:00","17:10",60,25,"",""],
  ["Filifera","2026-03-13","Delgado","Diana","Norma's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-03-13","Torres","Lucero","Norma's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-03-13","Beltran","Dina","Norma's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-03-13","Rodriguez","Angel","Norma's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-03-13","Vasquez","Teresa","Norma's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-03-13","Perez","Yamileth","Norma's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-03-17","Han","Xue","Justin's Team","08:00","14:20",60,20,"",""],
  ["Filifera","2026-03-17","Nguyen","Thanh","Justin's Team","08:00","14:20",60,20,"",""],
  ["Filifera","2026-03-17","Pham","Suong","Justin's Team","08:00","14:20",60,20,"",""],
  ["Filifera","2026-03-17","Torres","Lucero","Norma's Team","08:00","14:20",60,20,"",""],
  ["Filifera","2026-03-17","Diaz","Oscar","Norma's Team","08:00","14:20",60,20,"",""],
  ["Filifera","2026-03-17","Beltran","Dina","Norma's Team","08:00","14:20",60,20,"",""],
  ["Filifera","2026-03-17","Delgado","Diana","Norma's Team","08:00","14:20",60,20,"",""],
  ["Filifera","2026-03-17","Perez","Yamileth","Norma's Team","08:00","14:20",60,20,"",""],
  ["Filifera","2026-03-17","Vasquez","Teresa","Norma's Team","08:00","14:20",60,20,"",""],
  ["Filifera","2026-03-18","Nguyen","Thanh","Justin's Team","08:05","17:00",60,20,"",""],
  ["Filifera","2026-03-18","Han","Xue","Justin's Team","09:30","17:00",60,20,"",""],
  ["Filifera","2026-03-18","Pham","Suong","Justin's Team","09:30","17:00",60,20,"",""],
  ["Filifera","2026-03-18","Diaz","Oscar","Norma's Team","09:30","17:00",60,20,"",""],
  ["Filifera","2026-03-18","Torres","Lucero","Norma's Team","09:30","17:00",60,20,"",""],
  ["Filifera","2026-03-18","Delgado","Diana","Norma's Team","09:30","17:00",60,20,"",""],
  ["Filifera","2026-03-18","Fuentes","Lilliana","Norma's Team","09:30","17:00",60,20,"",""],
  ["Filifera","2026-03-18","Beltran","Dina","Norma's Team","09:30","17:00",60,20,"",""],
  ["Filifera","2026-03-19","Delgado","Norma","Norma's Team","08:05","17:10",60,25,"",""],
  ["Filifera","2026-03-19","Vasquez","Teresa","Norma's Team","08:05","17:10",60,20,"",""],
  ["Filifera","2026-03-19","Ortega","Lucia","Norma's Team","08:05","16:00",60,20,"",""],
  ["Filifera","2026-03-19","Perez","Yamileth","Norma's Team","08:05","17:10",60,20,"",""],
  ["Filifera","2026-03-19","Pham","Suong","Justin's Team","08:05","17:10",60,20,"",""],
  ["Filifera","2026-03-19","Torres","Lucero","Norma's Team","08:05","17:10",60,20,"",""],
  ["Filifera","2026-03-19","Fuentes","Lilliana","Norma's Team","08:05","17:10",60,20,"",""],
  ["Filifera","2026-03-19","Beltran","Dina","Norma's Team","08:05","17:10",60,20,"",""],
  ["Filifera","2026-03-19","Nguyen","Thanh","Justin's Team","08:20","17:30",60,20,"",""],
  ["Filifera","2026-03-20","Nguyen","Thanh","Justin's Team","07:30","17:13",60,20,"",""],
  ["Filifera","2026-03-20","Pham","Suong","Justin's Team","08:00","17:13",60,20,"",""],
  ["Filifera","2026-03-20","Han","Xue","Justin's Team","09:25","17:13",60,20,"",""],
  ["Filifera","2026-03-20","Diaz","Oscar","Norma's Team","08:00","17:13",60,20,"",""],
  ["Filifera","2026-03-20","Fuentes","Lilliana","Norma's Team","08:00","17:13",60,20,"",""],
  ["Filifera","2026-03-20","Torres","Lucero","Norma's Team","08:00","17:13",60,20,"",""],
  ["Filifera","2026-03-20","Delgado","Norma","Norma's Team","12:30","17:13",0,25,"",""],
  ["Filifera","2026-03-20","Vasquez","Teresa","Norma's Team","12:30","17:13",0,20,"",""],
  ["Filifera","2026-03-20","Perez","Yamileth","Norma's Team","08:00","17:13",60,20,"",""],
  ["Filifera","2026-03-23","Delgado","Norma","Norma's Team","08:10","15:40",60,25,"",""],
  ["Filifera","2026-03-23","Perez","Yamileth","Norma's Team","08:10","15:40",60,20,"",""],
  ["Filifera","2026-03-23","Vasquez","Teresa","Norma's Team","08:10","15:40",60,20,"",""],
  ["Filifera","2026-03-23","Macia","Diego","Norma's Team","08:10","12:00",60,20,"",""],
  ["Filifera","2026-03-23","Fuentes","Lilliana","Norma's Team","08:10","15:40",60,20,"",""],
  ["Filifera","2026-03-23","Torres","Lucero","Norma's Team","08:10","15:40",60,20,"",""],
  ["Filifera","2026-03-23","Diaz","Oscar","Norma's Team","08:10","15:40",60,20,"",""],
  ["Filifera","2026-03-23","Nguyen","Thanh","Justin's Team","08:10","15:40",60,20,"",""],
  ["Filifera","2026-03-23","Han","Xue","Justin's Team","08:10","15:40",60,20,"",""],
  ["Filifera","2026-03-23","Pham","Suong","Justin's Team","09:30","15:40",60,20,"",""],
  ["Filifera","2026-03-24","Nguyen","Thanh","Justin's Team","08:00","17:35",60,20,"",""],
  ["Filifera","2026-03-24","Pham","Suong","Justin's Team","08:00","17:35",60,20,"",""],
  ["Filifera","2026-03-24","Diaz","Oscar","Norma's Team","08:00","17:35",60,20,"",""],
  ["Filifera","2026-03-24","Torres","Lucero","Norma's Team","08:00","17:35",60,20,"",""],
  ["Filifera","2026-03-24","Vasquez","Teresa","Norma's Team","08:00","17:35",60,20,"",""],
  ["Filifera","2026-03-24","Fuentes","Lilliana","Norma's Team","08:00","17:35",60,20,"",""],
  ["Filifera","2026-03-24","Macia","Diego","Norma's Team","08:00","17:35",60,20,"",""],
  ["Filifera","2026-03-24","Perez","Yamileth","Norma's Team","08:00","14:00",60,20,"",""],
  ["Filifera","2026-03-24","Beltran","Dina","Norma's Team","08:00","17:35",60,20,"",""],
  ["Filifera","2026-03-24","Delgado","Norma","Norma's Team","14:00","17:35",60,25,"",""],
  ["Filifera","2026-03-24","Ortega","Lucia","Norma's Team","14:00","17:04",60,20,"",""],
  ["Filifera","2026-03-24","Parra","Tani","Norma's Team","15:00","17:35",60,20,"",""],
  ["Filifera","2026-03-25","Delgado","Norma","Norma's Team","08:20","15:15",60,25,"",""],
  ["Filifera","2026-03-25","Parra","Tani","Norma's Team","08:20","15:15",60,20,"",""],
  ["Filifera","2026-03-25","Macia","Diego","Norma's Team","08:20","15:15",60,20,"",""],
  ["Filifera","2026-03-25","Perez","Yamileth","Norma's Team","08:20","15:15",60,20,"",""],
  ["Filifera","2026-03-25","Vasquez","Teresa","Norma's Team","08:20","15:15",60,20,"",""],
  ["Filifera","2026-03-25","Fuentes","Lilliana","Norma's Team","08:20","15:15",60,20,"",""],
  ["Filifera","2026-03-25","Torres","Lucero","Norma's Team","08:20","15:15",60,20,"",""],
  ["Filifera","2026-03-25","Diaz","Oscar","Norma's Team","08:20","15:15",60,20,"",""],
  ["Filifera","2026-03-25","Han","Xue","Justin's Team","08:20","15:15",60,20,"",""],
  ["Filifera","2026-03-25","Nguyen","Thanh","Justin's Team","08:20","15:15",60,20,"",""],
  ["Filifera","2026-03-25","Pham","Suong","Justin's Team","08:20","15:15",60,20,"",""],
  ["Filifera","2026-03-26","Han","Xue","Justin's Team","09:30","10:30",0,20,"",""],
  ["Filifera","2026-03-26","Nguyen","Thanh","Justin's Team","09:30","10:30",0,20,"",""],
  ["Filifera","2026-03-26","Beltran","Dina","Norma's Team","09:15","10:30",0,20,"",""],
  ["Filifera","2026-03-26","Goldamez","Rony","Norma's Team","09:15","10:30",0,20,"",""],
  ["Filifera","2026-03-26","Fuentes","Lilliana","Norma's Team","09:15","10:30",0,20,"",""],
  ["Filifera","2026-03-26","Torres","Lucero","Norma's Team","09:15","10:30",0,20,"",""],
  ["Filifera","2026-03-26","Diaz","Oscar","Norma's Team","09:15","10:30",0,20,"",""],
  ["Portal","2026-03-26","Delgado","Norma","Norma's Team","09:00","15:20",30,25,"",""],
  ["Portal","2026-03-26","Parra","Tani","Norma's Team","09:00","15:20",30,20,"",""],
  ["Portal","2026-03-26","Torres","Lucero","Norma's Team","11:00","15:20",30,20,"",""],
  ["Portal","2026-03-26","Beltran","Dina","Norma's Team","11:00","15:20",30,20,"",""],
  ["Filifera","2026-03-30","Nguyen","Thanh","Justin's Team","09:30","17:00",30,20,"",""],
  ["Filifera","2026-03-30","Han","Xue","Justin's Team","10:30","17:00",30,20,"",""],
  ["Filifera","2026-03-30","Torres","Lucero","Norma's Team","13:24","17:00",0,20,"",""],
  ["Filifera","2026-03-30","Beltran","Dina","Norma's Team","13:24","17:00",0,20,"",""],
  ["Filifera","2026-03-30","Vasquez","Teresa","Norma's Team","13:24","17:00",0,20,"",""],
  ["Filifera","2026-03-31","Nguyen","Thanh","Justin's Team","08:00","17:00",30,20,"",""],
  ["Filifera","2026-03-31","Han","Xue","Justin's Team","08:00","17:00",30,20,"",""],
  ["Filifera","2026-03-31","Vasquez","Teresa","Norma's Team","08:00","17:00",30,20,"",""],
  ["Filifera","2026-03-31","Beltran","Dina","Norma's Team","08:00","17:00",30,20,"",""],
  ["Filifera","2026-03-31","Torres","Lucero","Norma's Team","08:00","17:00",30,20,"",""],
  ["Filifera","2026-03-31","Valenzuela","Estefany","Norma's Team","08:00","17:00",30,20,"",""],
  ["Filifera","2026-03-31","Ramos","Elmer","Norma's Team","08:00","17:00",30,20,"",""],
  ["Portal","2026-04-01","Delgado","Norma","Norma's Team","08:00","10:20",0,25,"",""],
  ["Portal","2026-04-01","Valenzuela","Estefany","Norma's Team","08:00","10:20",0,20,"",""],
  ["Filifera","2026-04-01","Nguyen","Thanh","Justin's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-04-01","Delgado","Diana","Norma's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-04-01","Vasquez","Teresa","Norma's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-04-01","Beltran","Dina","Norma's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-04-01","Torres","Lucero","Norma's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-04-01","Perez","Yamileth","Norma's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-04-01","Diaz","Oscar","Norma's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-04-01","Han","Xue","Justin's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-04-01","Delgado","Norma","Norma's Team","10:30","12:48",0,25,"",""],
  ["Filifera","2026-04-01","Valenzuela","Estefany","Norma's Team","10:30","12:48",0,20,"",""],
  ["Filifera","2026-04-02","Delgado","Norma","Norma's Team","08:00","17:30",66,25,"",""],
  ["Filifera","2026-04-02","Valenzuela","Estefany","Norma's Team","08:00","17:30",66,20,"",""],
  ["Filifera","2026-04-02","Macias","Diego","Norma's Team","08:00","18:30",66,20,"","added hour to correct for error on previous pay"],
  ["Filifera","2026-04-02","Parra","Tany","Norma's Team","08:00","17:30",66,20,"",""],
  ["Filifera","2026-04-02","Fuentes","Liliana","Norma's Team","08:00","17:30",66,20,"",""],
  ["Filifera","2026-04-02","Delgado","Diana","Norma's Team","08:00","17:30",66,20,"",""],
  ["Filifera","2026-04-02","Diaz","Oscar","Norma's Team","08:00","17:30",66,20,"",""],
  ["Filifera","2026-04-02","Torres","Lucero","Norma's Team","08:00","17:30",66,20,"",""],
  ["Filifera","2026-04-02","Pham","Suong","Justin's Team","08:00","17:30",66,20,"",""],
  ["Filifera","2026-04-02","Nguyen","Thanh","Justin's Team","08:00","17:30",66,20,"",""],
  ["Filifera","2026-04-03","Nguyen","Thanh","Justin's Team","08:00","17:45",60,20,"",""],
  ["Filifera","2026-04-03","Pham","Suong","Justin's Team","08:00","17:45",60,20,"",""],
  ["Filifera","2026-04-03","Delgado","Norma","Norma's Team","08:00","13:10",0,25,"",""],
  ["Filifera","2026-04-03","Delgado","Diana","Norma's Team","08:00","17:45",60,20,"",""],
  ["Filifera","2026-04-03","Fuentes","Liliana","Norma's Team","08:00","15:00",60,20,"",""],
  ["Filifera","2026-04-03","Macias","Diego","Norma's Team","08:00","15:30",60,20,"",""],
  ["Filifera","2026-04-03","Valenzuela","Estefany","Norma's Team","08:00","17:45",60,20,"",""],
  ["Filifera","2026-04-03","Diaz","Oscar","Norma's Team","08:00","17:45",60,20,"",""],
  ["Filifera","2026-04-03","Torres","Lucero","Norma's Team","08:00","17:45",60,20,"",""],
  ["Filifera","2026-04-03","Parra","Tany","Norma's Team","08:00","17:45",60,20,"",""],
  ["Filifera","2026-04-04","Nguyen","Thanh","Justin's Team","08:20","17:10",60,20,"",""],
  ["Filifera","2026-04-04","Pham","Suong","Justin's Team","08:20","17:10",60,20,"",""],
  ["Filifera","2026-04-04","Han","Xue","Justin's Team","08:20","17:10",60,20,"",""],
  ["Filifera","2026-04-04","Valenzuela","Estefany","Norma's Team","08:20","17:10",60,20,"",""],
  ["Filifera","2026-04-04","Delgado","Norma","Norma's Team","08:20","17:10",60,25,"",""],
  ["Filifera","2026-04-04","Parra","Tany","Norma's Team","08:20","17:10",60,20,"",""],
  ["Filifera","2026-04-04","Fuentes","Liliana","Norma's Team","08:20","17:10",60,20,"",""],
  ["Filifera","2026-04-04","Delgado","Diana","Norma's Team","08:20","17:10",60,20,"",""],
  ["Filifera","2026-04-04","Escalante","Elmer-","Norma's Team","08:20","17:10",60,20,"",""],
  ["Filifera","2026-04-04","Diaz","Oscar","Norma's Team","08:20","12:10",0,20,"",""],
  ["Filifera","2026-04-04","Chen","Yujue","Anna's Team","10:30","17:10",60,20,"",""],
  ["Filifera","2026-04-04","Xu","Mei","Anna's Team","10:30","17:10",60,20,"",""],
  ["Filifera","2026-04-04","Li","Ariu","Anna's Team","10:30","17:10",60,20,"",""],
  ["Filifera","2026-04-04","Chen","Libin","Anna's Team","10:30","17:10",60,20,"",""],
  ["Filifera","2026-04-04","Lau","Hiuchit","Anna's Team","10:30","17:10",60,20,"",""],
  ["Filifera","2026-04-06","Delgado","Diana","Norma's Team","08:00","19:05",85,20,"",""],
  ["Filifera","2026-04-06","Macias","Diego","Norma's Team","08:00","19:05",85,20,"",""],
  ["Filifera","2026-04-06","Vasquez","Teresa","Norma's Team","08:00","19:05",85,20,"",""],
  ["Filifera","2026-04-06","Perez","Yamileth","Norma's Team","08:00","19:05",85,20,"",""],
  ["Filifera","2026-04-06","Torres","Lucero","Norma's Team","08:00","19:05",85,20,"",""],
  ["Filifera","2026-04-06","Beltran","Dina","Norma's Team","08:00","19:05",85,20,"",""],
  ["Filifera","2026-04-06","Han","Xue","Justin's Team","08:00","19:05",45,20,"",""],
  ["Filifera","2026-04-06","Pham","Suong","Justin's Team","08:00","19:05",60,20,"",""],
  ["Filifera","2026-04-06","Delgado","Norma","Norma's Team","10:30","12:24",0,25,"",""],
  ["Filifera","2026-04-06","Valenzuela","Estefany","Norma's Team","10:30","19:05",85,20,"",""],
  ["Portal","2026-04-06","Delgado","Norma","Norma's Team","09:00","10:15",0,25,"",""],
  ["Portal","2026-04-06","Valenzuela","Estefany","Norma's Team","09:00","10:15",0,20,"",""],
  ["Filifera","2026-04-07","Delgado","Diana","Norma's Team","08:00","20:00",60,20,"",""],
  ["Filifera","2026-04-07","Diaz","Oscar","Norma's Team","08:00","20:00",60,20,"",""],
  ["Filifera","2026-04-07","Torres","Lucero","Norma's Team","08:00","20:00",60,20,"",""],
  ["Filifera","2026-04-07","Beltran","Dina","Norma's Team","08:00","20:00",60,20,"",""],
  ["Filifera","2026-04-07","Perez","Yamileth","Norma's Team","08:00","20:00",60,20,"",""],
  ["Filifera","2026-04-07","Vasquez","Teresa","Norma's Team","09:40","20:00",60,20,"",""],
  ["Filifera","2026-04-07","Nguyen","Thanh","Justin's Team","08:00","20:00",60,20,"",""],
  ["Filifera","2026-04-07","Pham","Suong","Justin's Team","08:00","20:00",60,20,"",""],
  ["Filifera","2026-04-07","Han","Xue","Justin's Team","08:00","20:00",60,20,"",""],
  ["Filifera","2026-04-08","Delgado","Norma","Norma's Team","08:30","17:30",60,25,"",""],
  ["Filifera","2026-04-08","Valenzuela","Estefany","Norma's Team","08:30","17:30",60,20,"",""],
  ["Filifera","2026-04-08","Escalante","Elmer-","Norma's Team","08:30","17:30",60,20,"",""],
  ["Filifera","2026-04-08","Delgado","Diana","Norma's Team","08:30","17:30",60,20,"",""],
  ["Portal","2026-04-27","Torres","Lucero","Norma's Team","10:00","16:24",60,20,"",""],
  ["Portal","2026-04-27","Valenzuela","Estefany","Norma's Team","10:00","16:20",60,20,"",""],
  ["Portal","2026-04-27","Delgado","Diana","Norma's Team","10:15","16:24",60,20,"",""],
  ["Portal","2026-04-27","Delgado","Norma","Norma's Team","10:15","16:24",60,25,"",""],
  ["Portal","2026-04-27","Fuentes","Liliana","Norma's Team","10:15","16:24",60,20,"",""],
  ["Filifera","2026-04-28","Nguyen","Thanh","Justin's Team","08:25","17:00",60,20,"",""],
  ["Filifera","2026-04-28","Pham","Suong","Justin's Team","10:00","17:00",60,20,"",""],
  ["Filifera","2026-04-28","Han","Xue","Justin's Team","10:00","17:00",60,20,"",""],
  ["Filifera","2026-04-28","Torres","Lucero","Norma's Team","10:00","17:00",60,20,"",""],
  ["Filifera","2026-04-28","Zuluaga","Andres","Norma's Team","10:00","17:00",60,20,"",""],
  ["Filifera","2026-04-28","Beltran","Dina","Norma's Team","10:00","17:00",60,20,"",""],
  ["Filifera","2026-04-28","Diaz","Oscar","Norma's Team","13:30","17:00",0,20,"",""],
  ["Filifera","2026-04-28","Parra","Tany","Norma's Team","13:30","17:00",0,20,"",""],
  ["Portal","2026-04-28","Delgado","Diana","Norma's Team","10:10","15:40",60,20,"",""],
  ["Portal","2026-04-28","Vasquez","Teresa","Norma's Team","10:00","15:40",60,20,"",""],
  ["Portal","2026-04-28","Ortega","Lucia","Norma's Team","10:00","15:40",60,20,"",""],
  ["Portal","2026-04-28","Delgado","Norma","Norma's Team","13:20","15:40",0,25,"",""],
  ["Filifera","2026-04-29","Nguyen","Thanh","Justin's Team","08:20","17:32",60,20,"",""],
  ["Filifera","2026-04-29","Pham","Suong","Justin's Team","08:20","17:32",60,20,"",""],
  ["Filifera","2026-04-29","Torres","Lucero","Norma's Team","08:20","17:32",60,20,"",""],
  ["Filifera","2026-04-29","Beltran","Dina","Norma's Team","08:20","17:32",60,20,"",""],
  ["Filifera","2026-04-29","Zuluaga","Andres","Norma's Team","08:20","17:32",60,20,"",""],
  ["Filifera","2026-04-29","Diaz","Oscar","Norma's Team","13:30","17:32",0,20,"",""],
  ["Filifera","2026-04-29","Ortega","Lucia","Norma's Team","13:30","17:32",0,20,"",""],
  ["Portal","2026-04-29","Delgado","Diana","Norma's Team","09:00","17:39",28,20,"",""],
  ["Portal","2026-04-29","Vasquez","Teresa","Norma's Team","09:00","17:39",28,20,"",""],
  ["Portal","2026-04-29","Lopez","Esmeralda","Norma's Team","09:00","17:39",28,20,"",""],
  ["Portal","2026-04-29","Delgado","Norma","Norma's Team","13:28","17:39",0,20,"",""],
  ["Portal","2026-04-29","Parra","Tany","Norma's Team","13:28","17:39",0,20,"",""],
  ["Filifera","2026-05-01","Delgado","Diana","Norma's Team","13:20","17:20",0,20,"",""],
  ["Filifera","2026-05-01","Parra","Tany","Norma's Team","13:20","17:20",0,20,"",""],
  ["Filifera","2026-05-01","Torres","Lucero","Norma's Team","13:20","17:20",0,20,"",""],
  ["Filifera","2026-05-01","Delgado","Norma","Norma's Team","13:20","17:20",0,25,"",""],
  ["Filifera","2026-05-01","Beltran","Dina","Norma's Team","13:20","17:20",0,20,"",""],
  ["Filifera","2026-05-01","Vasquez","Teresa","Norma's Team","13:20","17:20",0,20,"",""],
  ["Filifera","2026-05-01","Nguyen","Thanh","Justin's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-05-01","Pham","Suong","Justin's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-05-01","Han","Xue","Justin's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-05-02","Han","Xue","Justin's Team","08:00","14:00",30,20,"",""],
  ["Filifera","2026-05-02","Pham","Suong","Justin's Team","08:00","17:30",60,20,"",""],
  ["Filifera","2026-05-02","Nguyen","Thanh","Justin's Team","08:00","17:30",30,20,"",""],
  ["Filifera","2026-05-02","Delgado","Diana","Norma's Team","08:00","12:00",60,20,"",""],
  ["Filifera","2026-05-02","Vasquez","Teresa","Norma's Team","08:00","17:30",60,20,"",""],
  ["Filifera","2026-05-02","Zuluaga","Andres","Norma's Team","08:00","17:30",60,20,"",""],
  ["Filifera","2026-05-02","Lopez","Esmeralda","Norma's Team","08:00","17:30",60,20,"",""],
  ["Filifera","2026-05-02","Beltran","Dina","Norma's Team","08:00","17:30",60,20,"",""],
  ["Filifera","2026-05-02","Diaz","Oscar","Norma's Team","11:50","17:30",0,20,"",""],
  ["Filifera","2026-05-02","Fuentes","Liliana","Norma's Team","11:50","17:30",0,20,"",""],
  ["Filifera","2026-05-04","Nguyen","Thanh","Justin's Team","08:00","16:30",60,20,"",""],
  ["Filifera","2026-05-04","Han","Xue","Justin's Team","08:00","16:30",60,20,"",""],
  ["Filifera","2026-05-04","Pham","Suong","Justin's Team","08:00","16:30",60,20,"",""],
  ["Filifera","2026-05-04","Delgado","Norma","Norma's Team","08:00","16:35",60,25,"",""],
  ["Filifera","2026-05-04","Beltran","Dina","Norma's Team","08:00","16:35",60,20,"",""],
  ["Filifera","2026-05-04","Torres","Lucero","Norma's Team","08:00","16:35",60,20,"",""],
  ["Filifera","2026-05-04","Vasquez","Teresa","Norma's Team","08:00","16:35",60,20,"",""],
  ["Filifera","2026-05-04","Diaz","Oscar","Norma's Team","08:00","16:35",60,20,"",""],
  ["Filifera","2026-05-04","","Elmer","Norma's Team","08:00","16:35",60,20,"",""],
  ["Filifera","2026-05-04","Fuentes","Liliana","Norma's Team","08:00","16:35",60,20,"",""],
  ["Filifera","2026-05-05","Nguyen","Thanh","Justin's Team","08:00","17:15",60,20,"",""],
  ["Filifera","2026-05-05","Vasquez","Teresa","Norma's Team","08:00","17:15",60,20,"",""],
  ["Filifera","2026-05-05","Beltran","Dina","Norma's Team","08:00","17:15",60,20,"",""],
  ["Filifera","2026-05-05","Torres","Lucero","Norma's Team","08:00","17:15",60,20,"",""],
  ["Filifera","2026-05-05","Pham","Suong","Justin's Team","08:00","17:15",60,20,"",""],
  ["Filifera","2026-05-05","Ortega","Lucia","Norma's Team","08:00","17:15",60,20,"",""],
  ["Filifera","2026-05-05","Han","Xue","Justin's Team","08:00","17:15",60,20,"",""],
  ["Filifera","2026-05-06","Nguyen","Thanh","Justin's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-05-06","Han","Xue","Justin's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-05-06","Pham","Suong","Justin's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-05-06","Delgado","Norma","Norma's Team","08:00","09:30",0,25,"",""],
  ["Filifera","2026-05-06","Vasquez","Teresa","Norma's Team","08:00","09:30",0,20,"",""],
  ["Filifera","2026-05-06","Diaz","Oscar","Norma's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-05-06","Torres","Lucero","Norma's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-05-06","Zuluaga","Andres","Norma's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-05-06","Alac","Kevin","Norma's Team","08:00","17:10",60,20,"",""],
  ["Portal","2026-05-06","Delgado","Norma","Norma's Team","09:45","16:00",30,25,"",""],
  ["Portal","2026-05-06","Vasquez","Teresa","Norma's Team","09:45","16:00",30,20,"",""],
  ["Filifera","2026-05-07","Delgado","Norma","Norma's Team","08:00","17:00",60,25,"",""],
  ["Filifera","2026-05-07","Vasquez","Teresa","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-05-07","Fuentes","Liliana","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-05-07","Torres","Lucero","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-05-07","Beltran","Dina","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-05-07","Han","Xue","Justin's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-05-07","Nguyen","Thanh","Justin's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-05-07","Ortega","Lucia","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-05-27","Nguyen","Thanh","Justin's Team","08:20","18:35",60,20,"",""],
  ["Filifera","2026-05-27","Diaz","Oscar","Norma's Team","08:30","17:00",60,20,"",""],
  ["Filifera","2026-05-27","Escalante","Elmer","Norma's Team","08:30","17:00",60,20,"",""],
  ["Filifera","2026-05-27","Torres","Lucero","Norma's Team","09:00","18:35",60,20,"",""],
  ["Filifera","2026-05-27","Beltran","Dina","Norma's Team","09:00","18:35",60,20,"",""],
  ["Filifera","2026-05-27","Lopez","Esmeralda","Norma's Team","09:00","18:35",60,20,"",""],
  ["Filifera","2026-05-27","Pham","Suong","Justin's Team","09:00","18:35",60,20,"",""],
  ["Filifera","2026-05-27","Guzman","Evelyn","Norma's Team","09:00","18:35",60,20,"",""],
  ["Filifera","2026-05-27","Vasquez","Teresa","Norma's Team","09:00","18:35",60,20,"",""],
  ["Portal","2026-05-27","Delgado","Norma","Norma's Team","09:00","16:40",30,25,"",""],
  ["Portal","2026-05-27","Fuentes","Liliana","Norma's Team","09:00","16:40",30,20,"",""],
  ["Filifera","2026-05-28","Pham","Suong","Justin's Team","08:00","17:40",60,20,"",""],
  ["Filifera","2026-05-28","Nguyen","Thanh","Justin's Team","08:00","17:40",60,20,"",""],
  ["Filifera","2026-05-28","Lopez","Esmeralda","Norma's Team","08:00","17:40",60,20,"",""],
  ["Filifera","2026-05-28","Vasquez","Teresa","Norma's Team","08:00","17:40",60,20,"",""],
  ["Filifera","2026-05-28","Torres","Lucero","Norma's Team","08:00","17:40",60,20,"",""],
  ["Filifera","2026-05-28","Beltran","Dina","Norma's Team","08:00","17:40",60,20,"",""],
  ["Filifera","2026-05-28","","Leticia","Norma's Team","08:00","17:40",60,20,"",""],
  ["Filifera","2026-05-29","Vasquez","Teresa","Norma's Team","08:00","18:30",60,20,"",""],
  ["Filifera","2026-05-29","Torres","Lucero","Norma's Team","08:00","18:30",60,20,"",""],
  ["Filifera","2026-05-29","Fuentes","Liliana","Norma's Team","08:00","18:30",60,20,"",""],
  ["Filifera","2026-05-29","Beltran","Dina","Norma's Team","08:00","18:30",60,20,"",""],
  ["Filifera","2026-05-29","Lopez","Esmeralda","Norma's Team","08:00","18:30",60,20,"",""],
  ["Filifera","2026-05-29","Nguyen","Thanh","Justin's Team","08:00","18:20",60,20,"",""],
  ["Filifera","2026-05-29","Pham","Suong","Justin's Team","08:05","18:30",60,20,"",""],
  ["Filifera","2026-05-29","Delgado","Norma","Norma's Team","13:10","18:30",0,25,"",""],
  ["Filifera","2026-05-29","Diaz","Kevin","Norma's Team","16:50","18:30",0,20,"",""],
  ["Portal","2026-05-29","Ortega","Lucia","Norma's Team","10:03","13:00",0,20,"",""],
  ["Portal","2026-05-29","Parra","Tany","Norma's Team","10:00","13:00",0,20,"",""],
  ["Filifera","2026-06-01","Pham","Suong","Justin's Team","08:00","17:02",60,20,"",""],
  ["Filifera","2026-06-01","Nguyen","Thanh","Justin's Team","08:00","17:02",60,20,"",""],
  ["Filifera","2026-06-01","Vasquez","Teresa","Norma's Team","08:00","17:02",60,20,"",""],
  ["Filifera","2026-06-01","Torres","Lucero","Norma's Team","08:00","17:02",60,20,"",""],
  ["Filifera","2026-06-01","Beltran","Dina","Norma's Team","08:00","17:02",60,20,"",""],
  ["Filifera","2026-06-01","Fuentes","Liliana","Norma's Team","08:00","17:02",60,20,"",""],
  ["Filifera","2026-06-01","Guzman","Evelyn","Norma's Team","08:00","17:02",60,20,"",""],
  ["Filifera","2026-06-01","Diaz","Oscar","Norma's Team","08:00","17:02",60,20,"",""],
  ["Filifera","2026-06-01","Delgado","Norma","Norma's Team","08:00","17:02",60,25,"",""],
  ["Filifera","2026-06-02","Vasquez","Teresa","Norma's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-06-02","Chabolla","Antonio","Norma's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-06-02","Guzman","Evelyn","Norma's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-06-02","Torres","Lucero","Norma's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-06-02","Beltran","Dina","Norma's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-06-02","Lopez","Esmeralda","Norma's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-06-02","Nguyen","Thanh","Justin's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-06-02","Pham","Suong","Justin's Team","08:00","17:20",60,20,"",""],
  ["Filifera","2026-06-02","Delgado","Norma","Norma's Team","08:00","13:18",60,25,"",""],
  ["Portal","2026-06-02","Parra","Tany","Norma's Team","08:45","17:50",30,20,"",""],
  ["Portal","2026-06-02","Zuluaga","Andres","Norma's Team","09:00","17:50",30,20,"",""],
  ["Portal","2026-06-02","Fuentes","Liliana","Norma's Team","09:00","17:50",30,20,"",""],
  ["Portal","2026-06-02","Beltran","Dina","Norma's Team","10:23","17:50",30,20,"",""],
  ["Portal","2026-06-02","Ortega","Lucia","Norma's Team","09:15","17:50",30,20,"",""],
  ["Portal","2026-06-02","Delgado","Norma","Norma's Team","13:30","17:50",0,25,"",""],
  ["Filifera","2026-06-03","Vasquez","Teresa","Norma's Team","09:00","17:12",60,20,"",""],
  ["Filifera","2026-06-03","Beltran","Dina","Norma's Team","09:00","17:12",60,20,"",""],
  ["Filifera","2026-06-03","Lopez","Esmeralda","Norma's Team","09:00","17:12",60,20,"",""],
  ["Filifera","2026-06-03","Chabolla","Antonio","Norma's Team","09:00","17:12",60,20,"",""],
  ["Filifera","2026-06-03","Nguyen","Thanh","Justin's Team","09:00","17:12",60,20,"",""],
  ["Filifera","2026-06-03","Pham","Suong","Justin's Team","09:00","17:12",60,20,"",""],
  ["Filifera","2026-06-03","Delgado","Norma","Norma's Team","10:07","17:12",60,25,"",""],
  ["Portal","2026-06-03","Ortega","Lucia","Norma's Team","09:00","16:30",60,20,"",""],
  ["Portal","2026-06-03","Fuentes","Liliana","Norma's Team","09:00","16:30",60,20,"",""],
  ["Filifera","2026-06-04","Delgado","Norma","Norma's Team","08:30","18:00",60,25,"",""],
  ["Filifera","2026-06-04","Diaz","Oscar","Norma's Team","08:30","18:00",60,20,"",""],
  ["Filifera","2026-06-04","Chabolla","Antonio","Norma's Team","08:30","18:00",60,20,"",""],
  ["Filifera","2026-06-04","Vasquez","Teresa","Norma's Team","08:30","18:00",60,20,"",""],
  ["Filifera","2026-06-04","Lopez","Esmeralda","Norma's Team","08:30","18:00",60,20,"",""],
  ["Filifera","2026-06-04","Guzman","Evelyn","Norma's Team","08:30","18:00",60,20,"",""],
  ["Filifera","2026-06-04","Escalante","Elmer","Norma's Team","08:00","12:30",0,20,"",""],
  ["Filifera","2026-06-04","Parra","Tany","Norma's Team","08:00","12:30",0,20,"",""],
  ["Filifera","2026-06-04","Nguyen","Thanh","Justin's Team","09:00","18:00",60,20,"",""],
  ["Filifera","2026-06-04","Pham","Suong","Justin's Team","09:00","18:00",60,20,"",""],
  ["Portal","2026-06-04","Torres","Lucero","Norma's Team","08:30","16:00",60,20,"",""],
  ["Portal","2026-06-04","Beltran","Dina","Norma's Team","08:30","16:00",60,20,"",""],
  ["Portal","2026-06-04","Ortega","Lucia","Norma's Team","08:30","16:00",60,20,"",""],
  ["Portal","2026-06-04","Fuentes","Liliana","Norma's Team","08:30","16:00",60,20,"",""],
  ["Filifera","2026-06-05","Delgado","Norma","Norma's Team","09:00","12:30",0,20,"",""],
  ["Filifera","2026-06-05","Torres","Lucero","Norma's Team","09:00","18:10",60,20,"",""],
  ["Filifera","2026-06-05","Beltran","Dina","Norma's Team","09:00","18:10",60,20,"",""],
  ["Filifera","2026-06-05","Nguyen","Thanh","Justin's Team","09:00","18:10",60,20,"",""],
  ["Filifera","2026-06-05","Fuentes","Liliana","Norma's Team","09:00","18:10",60,20,"",""],
  ["Filifera","2026-06-05","Ortega","Lucia","Norma's Team","09:00","18:10",60,20,"",""],
  ["Filifera","2026-06-05","Pham","Suong","Justin's Team","09:00","18:10",60,20,"",""],
  ["Filifera","2026-06-05","Delgado","Norma","Norma's Team","13:56","18:10",0,20,"",""],
  ["Filifera","2026-05-11","Torres","Lucero","Norma's Team","08:00","17:50",60,20,"",""],
  ["Filifera","2026-05-11","Beltran","Dina","Norma's Team","08:00","17:50",60,20,"",""],
  ["Filifera","2026-05-11","Macias","Diego","Norma's Team","08:00","17:50",60,20,"",""],
  ["Filifera","2026-05-11","Vasquez","Teresa","Norma's Team","08:00","17:50",60,20,"",""],
  ["Filifera","2026-05-11","Han","Xue","Justin's Team","08:00","14:30",60,20,"",""],
  ["Filifera","2026-05-11","Pham","Suong","Justin's Team","08:00","17:50",60,20,"",""],
  ["Filifera","2026-05-11","Nguyen","Thanh","Justin's Team","08:00","17:50",60,20,"",""],
  ["Filifera","2026-05-11","Juors","Ana","Norma's Team","13:00","17:50",0,20,"",""],
  ["Filifera","2026-05-11","Caranga","Ijeinan","Norma's Team","13:00","17:50",0,20,"",""],
  ["Portal","2026-05-11","Ortega","Lucia","Norma's Team","10:20","16:55",30,20,"",""],
  ["Portal","2026-05-11","Zuluaga","Andres","Norma's Team","10:20","16:55",30,20,"",""],
  ["Portal","2026-05-11","Fuentes","Liliana","Norma's Team","10:20","16:55",30,20,"",""],
  ["Portal","2026-05-11","Delgado","Norma","Norma's Team","12:00","16:55",0,25,"",""],
  ["Filifera","2026-05-12","Han","Xue","Justin's Team","08:00","16:00",60,20,"",""],
  ["Filifera","2026-05-12","Vasquez","Teresa","Norma's Team","08:00","16:00",60,20,"",""],
  ["Filifera","2026-05-12","Nguyen","Thanh","Justin's Team","08:00","16:00",60,20,"",""],
  ["Filifera","2026-05-12","Beltran","Dina","Norma's Team","08:00","16:00",60,20,"",""],
  ["Filifera","2026-05-12","Zuluaga","Andres","Norma's Team","08:00","16:00",60,20,"",""],
  ["Filifera","2026-05-12","Torres","Lucero","Norma's Team","08:00","16:00",60,20,"",""],
  ["Filifera","2026-05-12","Pham","Suong","Justin's Team","08:00","16:00",60,20,"",""],
  ["Portal","2026-05-12","Ortega","Lucia","Norma's Team","09:00","16:00",30,20,"",""],
  ["Portal","2026-05-12","Escalante","Elmer","Norma's Team","09:00","16:00",30,20,"",""],
  ["Portal","2026-05-12","Diaz","Oscar","Norma's Team","13:40","16:00",0,20,"",""],
  ["Portal","2026-05-12","Gonzalez","Mingo","Norma's Team","13:40","14:30",0,20,"",""],
  ["Portal","2026-05-13","Torres","Lucero","Norma's Team","09:00","15:00",60,20,"",""],
  ["Portal","2026-05-13","Diaz","Oscar","Norma's Team","09:00","15:00",60,20,"",""],
  ["Portal","2026-05-13","Beltran","Dina","Norma's Team","09:00","15:00",60,20,"",""],
  ["Portal","2026-05-13","Ortega","Lucia","Norma's Team","09:20","15:00",60,20,"",""],
  ["Filifera","2026-05-18","Nguyen","Thanh","Justin's Team","08:00","18:00",60,20,"",""],
  ["Filifera","2026-05-18","Pham","Suong","Justin's Team","10:00","17:20",60,20,"",""],
  ["Filifera","2026-05-18","Torres","Lucero","Norma's Team","10:00","17:20",60,20,"",""],
  ["Filifera","2026-05-18","Guzman","Evelyn","Norma's Team","10:00","17:20",60,20,"",""],
  ["Filifera","2026-05-18","Beltran","Dina","Norma's Team","10:00","17:20",60,20,"",""],
  ["Filifera","2026-05-18","Vasquez","Teresa","Norma's Team","10:00","17:20",60,20,"",""],
  ["Filifera","2026-05-18","Escalante","Elmer","Norma's Team","10:00","17:20",60,20,"",""],
  ["Filifera","2026-05-18","Han","Xue","Justin's Team","10:00","17:20",60,20,"",""],
  ["Filifera","2026-05-18","Delgado","Norma","Norma's Team","10:30","17:20",60,25,"",""],
  ["Filifera","2026-05-19","Nguyen","Thanh","Justin's Team","09:00","17:04",60,20,"",""],
  ["Filifera","2026-05-19","Pham","Suong","Justin's Team","09:00","17:04",60,20,"",""],
  ["Filifera","2026-05-19","Torres","Lucero","Norma's Team","09:00","17:04",60,20,"",""],
  ["Filifera","2026-05-19","Vasquez","Teresa","Norma's Team","09:00","11:18",0,20,"",""],
  ["Filifera","2026-05-19","Ortega","Lucia","Norma's Team","09:00","11:18",0,20,"",""],
  ["Filifera","2026-05-19","Delgado","Norma","Norma's Team","11:00","17:04",0,25,"",""],
  ["Filifera","2026-05-19","Valenzuela","Esefany","Norma's Team","09:08","17:04",60,20,"",""],
  ["Filifera","2026-05-19","Beltran","Dina","Norma's Team","09:10","17:04",60,20,"",""],
  ["Filifera","2026-05-19","Han","Xue","Justin's Team","09:00","17:04",60,20,"",""],
  ["Portal","2026-05-20","Valenzuela","Esefany","Norma's Team","09:08","17:30",60,20,"",""],
  ["Portal","2026-05-20","Guzman","Evelyn","Norma's Team","09:00","17:30",60,20,"",""],
  ["Portal","2026-05-20","Escalante","Elmer","Norma's Team","09:20","17:30",60,20,"",""],
  ["Portal","2026-05-20","Ortega","Lucia","Norma's Team","09:20","17:30",60,20,"",""],
  ["Filifera","2026-05-20","Vasquez","Teresa","Norma's Team","08:00","16:45",60,20,"",""],
  ["Filifera","2026-05-20","Beltran","Dina","Norma's Team","08:00","16:45",60,20,"",""],
  ["Filifera","2026-05-20","Torres","Lucero","Norma's Team","08:00","16:45",60,20,"",""],
  ["Filifera","2026-05-20","Martinez","Leticia","Norma's Team","08:30","16:45",60,20,"",""],
  ["Filifera","2026-05-20","Zuluaga","Andres","Norma's Team","08:15","16:45",60,20,"",""],
  ["Filifera","2026-05-20","Lopez","Esmeralda","Norma's Team","08:00","16:45",60,20,"",""],
  ["Filifera","2026-05-20","Nguyen","Thanh","Justin's Team","08:10","16:45",60,20,"",""],
  ["Filifera","2026-05-20","Pham","Suong","Justin's Team","08:10","16:45",60,20,"",""],
  ["Filifera","2026-05-20","Han","Xue","Justin's Team","08:25","15:00",60,20,"",""],
  ["Filifera","2026-05-20","Delgado","Norma","Norma's Team","11:35","16:45",30,25,"",""],
  ["Filifera","2026-06-08","Vasquez","Teresa","Norma's Team","08:00","18:00",60,20,"",""],
  ["Filifera","2026-06-08","Diaz","Oscar","Norma's Team","08:00","18:00",60,20,"",""],
  ["Filifera","2026-06-08","Torres","Lucero","Norma's Team","08:00","18:00",60,20,"",""],
  ["Filifera","2026-06-08","Beltran","Dina","Norma's Team","08:00","18:00",60,20,"",""],
  ["Filifera","2026-06-08","Fuentes","Liliana","Norma's Team","08:00","18:00",60,20,"",""],
  ["Filifera","2026-06-08","Nguyen","Thanh","Justin's Team","08:00","18:00",60,20,"",""],
  ["Filifera","2026-06-08","Pham","Suong","Justin's Team","08:00","18:00",60,20,"",""],
  ["Filifera","2026-06-09","Vasquez","Teresa","Norma's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-06-09","Beltran","Dina","Norma's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-06-09","Diaz","Oscar","Norma's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-06-09","Torres","Lucero","Norma's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-06-09","Zuluogo","Andres","Norma's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-06-09","Delgado","Norma","Norma's Team","08:00","12:30",0,25,"",""],
  ["Filifera","2026-06-09","Nguyen","Thanh","Justin's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-06-09","Pham","Suong","Justin's Team","08:00","17:10",60,20,"",""],
  ["Filifera","2026-06-09","Escalante","Elmer","Norma's Team","08:00","17:10",60,20,"",""],
  ["Portal","2026-06-10","Vasquez","Teresa","Norma's Team","09:00","17:50",60,20,"",""],
  ["Portal","2026-06-10","Beltran","Dina","Norma's Team","09:00","17:50",60,20,"",""],
  ["Portal","2026-06-10","Torres","Lucero","Norma's Team","09:00","17:50",60,20,"",""],
  ["Portal","2026-06-10","Diaz","Oscar","Norma's Team","09:00","17:50",60,20,"",""],
  ["Portal","2026-06-10","Delgado","Norma","Norma's Team","17:00","17:50",0,25,"",""],
  ["Filifera","2026-06-11","Nguyen","Thanh","Justin's Team","08:00","15:00",60,20,"",""],
  ["Filifera","2026-06-11","Vasquez","Teresa","Norma's Team","08:00","15:00",60,20,"",""],
  ["Filifera","2026-06-11","Fuentes","Liliana","Norma's Team","08:00","15:00",60,20,"",""],
  ["Filifera","2026-06-11","Beltran","Dina","Norma's Team","08:00","15:00",60,20,"",""],
  ["Filifera","2026-06-11","Delgado","Norma","Norma's Team","08:00","10:00",0,25,"",""],
  ["Filifera","2026-06-11","Pham","Suong","Justin's Team","08:00","15:00",60,20,"",""],
  ["Filifera","2026-06-11","Parra","Tany","Norma's Team","11:00","15:00",60,20,"",""],
  ["Portal","2026-06-11","Escalante","Elmer","Norma's Team","09:00","14:11",60,20,"",""],
  ["Portal","2026-06-11","Zuluogo","Andres","Norma's Team","09:00","15:00",60,20,"",""],
  ["Portal","2026-06-11","Lopez","Esmeralda","Norma's Team","09:16","15:00",60,20,"",""],
  ["Portal","2026-06-11","Diaz","Oscar","Norma's Team","09:00","14:11",60,20,"",""],
  ["Filifera","2026-06-12","Nguyen","Thanh","Justin's Team","09:30","14:30",60,20,"",""],
  ["Filifera","2026-06-12","Diaz","Oscar","Norma's Team","09:43","14:30",60,20,"",""],
  ["Filifera","2026-06-12","Delgado","Norma","Norma's Team","09:50","14:30",60,25,"",""],
  ["Filifera","2026-06-12","Fuentes","Liliana","Norma's Team","09:50","14:30",60,20,"",""],
  ["Portal","2026-06-15","Fuentes","Liliana","Norma's Team","09:10","12:30",0,20,"",""],
  ["Filifera","2026-06-15","Nguyen","Thanh","Justin's Team","09:00","17:10",60,20,"",""],
  ["Filifera","2026-06-15","Pham","Suong","Justin's Team","09:00","17:10",60,20,"",""],
  ["Filifera","2026-06-15","Diaz","Oscar","Norma's Team","09:00","16:10",60,20,"",""],
  ["Filifera","2026-06-15","Torres","Lucero","Norma's Team","09:00","17:10",60,20,"",""],
  ["Filifera","2026-06-15","Beltran","Dina","Norma's Team","09:00","17:10",60,20,"",""],
  ["Filifera","2026-06-15","Vasquez","Teresa","Norma's Team","09:00","17:10",60,20,"",""],
  ["Filifera","2026-06-15","Zuluogo","Andres","Norma's Team","09:00","17:10",60,20,"",""],
  ["Filifera","2026-06-15","Delgado","Norma","Norma's Team","13:50","17:10",0,25,"",""],
  ["Portal","2026-06-16","Delgado","Norma","Norma's Team","08:00","15:20",60,25,"",""],
  ["Portal","2026-06-16","Beltran","Dina","Norma's Team","08:00","17:08",60,20,"",""],
  ["Portal","2026-06-16","Diaz","Oscar","Norma's Team","08:00","17:08",60,20,"",""],
  ["Portal","2026-06-16","Torres","Lucero","Norma's Team","08:00","17:08",60,20,"",""],
  ["Portal","2026-06-16","Vasquez","Teresa","Norma's Team","08:00","17:08",60,20,"",""],
  ["Portal","2026-06-16","Zuluogo","Andres","Norma's Team","08:00","17:08",60,20,"",""],
  ["Portal","2026-06-16","Nguyen","Thanh","Justin's Team","08:00","17:08",60,20,"",""],
  ["Portal","2026-06-16","Pham","Suong","Justin's Team","08:00","17:08",60,20,"",""],
  ["Portal","2026-06-17","Delgado","Norma","Norma's Team","11:15","12:48",0,20,"",""],
  ["Portal","2026-06-17","Torres","Lucero","Norma's Team","11:15","12:48",0,20,"",""],
  ["Filifera","2026-06-18","Diaz","Oscar","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-06-18","Vasquez","Teresa","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-06-18","Fuentes","Liliana","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-06-18","Beltran","Dina","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-06-18","Torres","Lucero","Norma's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-06-18","Nguyen","Thanh","Justin's Team","08:00","17:00",60,20,"",""],
  ["Filifera","2026-06-18","Pham","Suong","Justin's Team","08:00","13:00",0,20,"",""],
  ["Filifera","2026-06-18","Parra","Tany","Norma's Team","13:00","17:00",0,20,"",""],
  ["Portal","2026-06-19","Diaz","Oscar","Norma's Team","08:00","17:15",60,20,"",""],
  ["Portal","2026-06-19","Torres","Lucero","Norma's Team","08:00","17:15",60,20,"",""],
  ["Portal","2026-06-19","Fuentes","Liliana","Norma's Team","08:00","17:15",60,20,"",""],
  ["Portal","2026-06-19","Vasquez","Teresa","Norma's Team","08:00","17:15",60,20,"",""],
  ["Portal","2026-06-19","Beltran","Dina","Norma's Team","08:00","17:15",60,20,"",""],
  ["Portal","2026-06-19","Delgado","Norma","Norma's Team","08:00","12:45",0,20,"",""],
  ["Portal","2026-06-19","Nguyen","Thanh","Justin's Team","08:00","17:15",60,20,"",""],
  ["Portal","2026-06-19","Pham","Suong","Justin's Team","08:00","17:15",60,20,"",""],
  ["Portal","2026-06-19","Zuluogo","Andres","Norma's Team","08:15","17:15",60,20,"",""]
];

// [last, first, default_rate, team, default_company, aliases[]]
var SEED_ROSTER = [
  ['', 'Elmer', 20, "Norma's Team", 'Slane', []],
  ['Andrade', 'Maria', 20, "Norma's Team", 'Filifera', ['Andvade']],
  ['Beltran', 'Dina', 20, "Norma's Team", 'Filifera', []],
  ['Delgado', 'Norma', 25, "Norma's Team", 'Portal', []],
  ['Diaz', 'Oscar', 20, "Norma's Team", 'Portal', []],
  ['Fuentes', 'Liliana', 20, "Norma's Team", 'Portal', []],
  ['Goldomez', 'Ronnie', 20, "Norma's Team", 'Portal', []],
  ['Lopez', 'Esmeralda', 20, "Norma's Team", 'Portal', []],
  ['Nguyen', 'Thanh', 20, "Justin's Team", 'Filifera', []],
  ['Parra', 'Yesenia', 20, "Norma's Team", 'Portal', []],
  ['Pham', 'Suong', 20, "Justin's Team", 'Portal', []],
  ['Torres', 'Lucero', 20, "Norma's Team", 'Filifera', []],
  ['Vasquez', 'Teresa', 20, "Norma's Team", 'Filifera', []],
  ['Zuluago', 'Andres', 20, "Norma's Team", 'Portal', ['Zuluogo', 'Zuluaga']],
];
