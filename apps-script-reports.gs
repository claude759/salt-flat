// ══════════════════════════════════════════════════════════════
//  Wizard Trees — AR Reports · shared-data backend
//
//  This is a SEPARATE Apps Script from your collections script
//  (apps-script.gs). Keep them in two different projects so the
//  reports link stays open to anyone while your email/login
//  backend keeps its "Anyone with Google account" protection.
//
//  WHAT IT DOES
//  ────────────
//  Stores the latest AR dataset (published by whoever uploaded the
//  CSVs) as a single JSON file in your Google Drive, and serves it
//  back to anyone who opens ar-reports.html — so the whole team
//  sees the same numbers, plus a "last updated" timestamp.
//
//  SETUP (one-time, ~5 minutes)
//  ────────────────────────────
//  1. Go to https://script.google.com and click "New project".
//  2. Delete any code in the editor and paste THIS entire file in.
//  3. Click Deploy → New deployment.
//        Type:            Web app
//        Execute as:      Me
//        Who has access:  Anyone            ← important: "Anyone",
//                                              NOT "Anyone with Google account",
//                                              so teammates don't need to log in.
//  4. Click Deploy, authorize when prompted, then copy the Web app URL
//     (it ends in /exec).
//  5. Open ar-reports.html, find this line near the top of the <script>:
//         const REPORTS_SCRIPT_URL = 'YOUR_APPS_SCRIPT_URL_HERE';
//     and paste your URL between the quotes. Save.
//  6. (If hosted on GitHub Pages) commit & push ar-reports.html.
//
//  A file called "wizard-trees-ar-reports-data.json" will be created
//  in your Drive on the first publish. Delete it any time to reset.
// ══════════════════════════════════════════════════════════════

var DATA_FILE = 'wizard-trees-ar-reports-data.json';

// ── Storage helpers ───────────────────────────────────────────
function getDataFile_() {
  var it = DriveApp.getFilesByName(DATA_FILE);
  return it.hasNext() ? it.next() : null;
}

function readData_() {
  var f = getDataFile_();
  if (!f) return { ok: true, empty: true };
  try {
    return JSON.parse(f.getBlob().getDataAsString());
  } catch (e) {
    return { ok: true, empty: true, error: 'Stored data could not be parsed' };
  }
}

function writeData_(obj) {
  var content = JSON.stringify(obj);
  var f = getDataFile_();
  if (f) f.setContent(content);
  else DriveApp.createFile(DATA_FILE, content, 'application/json');
}

// ── Output helper (supports JSONP via ?callback=) ─────────────
function out_(obj, e) {
  var json = JSON.stringify(obj);
  var cb = e && e.parameter && e.parameter.callback;
  if (cb) {
    return ContentService
      .createTextOutput(cb + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Entry points ──────────────────────────────────────────────
function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  if (action === 'hmops') return hmops_(e);
  // Default: returns the latest published dataset (or { empty:true } if none yet).
  return out_(readData_(), e);
}

// HM OPS "Order Queue" sheet → the Wizard Trees rows only. Token-gated and READ-ONLY.
// Runs as the script owner (gianni@), who has view access to the shared sheet — so the
// nightly pipeline can read it without the sheet being public. Scans every weekly tab
// (names like "7/20-7/24") and returns rows whose Box Count/Brands mentions Wizard Trees.
var HMOPS_SHEET_ID = '1SckEftdpPhT1G-zmEsFKLit0y-32WkmK8kpYV0roVOA';
function hmops_(e) {
  if (e.parameter.token !== 'wt-health-7f3a9c21') return out_({ ok: false, error: 'bad token' }, e);
  try {
    var ss = SpreadsheetApp.openById(HMOPS_SHEET_ID);
    var rows = [];
    ss.getSheets().forEach(function (sh) {
      var name = String(sh.getName() || '').trim();
      if (!/^\d{1,2}\/\d{1,2}\s*-\s*\d{1,2}\/\d{1,2}$/.test(name)) return;   // weekly tabs only (skip DROP LISTS / Driver Blocks / Template)
      var vals = sh.getDataRange().getDisplayValues();
      if (vals.length < 2) return;
      var head = vals[0].map(function (h) { return String(h || '').trim(); });
      var bi = head.indexOf('Box Count/Brands'); if (bi < 0) bi = 4;   // column E if the header ever changes
      for (var r = 1; r < vals.length; r++) {
        if (!/wizard\s*trees/i.test(String(vals[r][bi] || ''))) continue;
        var o = { week: name };
        head.forEach(function (h, i) { if (h) o[h] = String(vals[r][i] == null ? '' : vals[r][i]); });
        rows.push(o);
      }
    });
    return out_({ ok: true, fetchedAt: new Date().toISOString(), rows: rows }, e);
  } catch (ex) {
    return out_({ ok: false, error: ex.message }, e);
  }
}

function doPost(e) {
  try {
    var action = e.parameter.action;
    if (action === 'publish') {
      var payload = e.parameter.payload || '';
      var parsed;
      try {
        parsed = JSON.parse(payload);
      } catch (err) {
        return out_({ ok: false, error: 'Invalid payload JSON' }, e);
      }
      var obj = {
        ok: true,
        uploadedAt: new Date().toISOString(),
        uploadedBy: (e.parameter.uploadedBy || '').toString().slice(0, 80),
        data: parsed
      };
      writeData_(obj);
      return out_({ ok: true, uploadedAt: obj.uploadedAt, uploadedBy: obj.uploadedBy }, e);
    }
    if (action === 'email') {
      // Morning systems-health review, emailed by the local 5am health-check.mjs. Token-gated
      // and FIXED recipient so this public endpoint can't be abused to send arbitrary mail.
      // Sends as the script owner via Gmail — no SMTP creds anywhere.
      if (e.parameter.token !== 'wt-health-7f3a9c21') return out_({ ok: false, error: 'bad token' }, e);
      MailApp.sendEmail({
        to: 'gianni@wizardtrees.com',
        subject: (e.parameter.subject || 'Wizard Trees — Systems Health').toString().slice(0, 200),
        body: (e.parameter.body || '').toString().slice(0, 40000)
      });
      return out_({ ok: true, emailed: true }, e);
    }
    return out_({ ok: false, error: 'Unknown action: ' + action }, e);
  } catch (ex) {
    return out_({ ok: false, error: ex.message }, e);
  }
}
