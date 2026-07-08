// ══════════════════════════════════════════════════════════════
//  Wizard Trees — Labor / Unit Tracker · Apps Script web app
//
//  Serves the tracker app (labor-calculator.html) behind a
//  @wizardtrees.com Google login AND feeds it live sheet data.
//  The page and the backend are the same origin, so the browser
//  talks to the server with google.script.run — no CORS, no public
//  sheet, no keys in the browser. The data is delivered only after
//  a @wizardtrees.com user signs in, so it is never exposed publicly.
//
//  (This replaces the old read-only proxy approach — you no longer
//  make the sheet link-viewable; Google's login is the gate.)
//
//  SETUP (one-time, ~4 min) — signed in as a Google account that can
//  OPEN the tracker sheet.
//  ──────────────────────────────────────────────────────────────
//  1. https://script.google.com → New project. Rename it "WT Labor".
//  2. Paste THIS file into Code.gs (replace the sample code).
//  3. Deploy → New deployment. If you see a gear icon, click it and
//     choose "Web app". Set:
//        Execute as:      Me
//        Who has access:  Anyone within Wizard Trees   ← the login gate
//     (Only this option restricts to @wizardtrees.com. "Anyone" = no
//      login; "Anyone with Google account" = any Google login.)
//  4. Click Deploy and authorize when prompted:
//        • pick your @wizardtrees.com account
//        • "Google hasn't verified this app" is normal for your own
//          script → Advanced → Go to WT Labor (unsafe) → Allow.
//          (It only READS your sheet.)
//  5. Copy the "Web app" URL (ends in /exec). That IS the app —
//     share that link with the team; only @wizardtrees.com can open it.
//
//  Updating the app: I just push to the repo — this script always
//  serves the latest version, so you never re-paste. To change the
//  access setting later: Manage deployments → Edit.
//
//  To sync the Labor/Packaging sheet live too, share that sheet with
//  this same account, send me its ID, and I'll add a second reader.
// ══════════════════════════════════════════════════════════════

var ALLOWED_DOMAIN   = 'wizardtrees.com';
var TRACKER_SHEET_ID = '1IUMecFlqCYFe51jBBmu5gIs-8elhlrgxdUPxP3qLFuQ';   // Daily Labor_Unit tracker
var TRACKER_TAB      = 'Combined';
var APP_HTML_URL     = 'https://raw.githubusercontent.com/claude759/salt-flat/main/labor-calculator.html';

// -- Serve the app (always the latest version from the repo) ----
function doGet() {
  var html;
  try {
    var res = UrlFetchApp.fetch(APP_HTML_URL, { muteHttpExceptions: true });
    html = (res.getResponseCode() === 200) ? res.getContentText() : null;
  } catch (e) { html = null; }
  if (!html) html = '<p style="font:15px sans-serif;padding:40px">Could not load the app right now — refresh in a moment.</p>';
  return HtmlService.createHtmlOutput(html)
    .setTitle('Wizard Trees — Labor / Unit Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// -- Domain gate. The deployment already restricts who can open the
//    app; this second check guards the data call directly. ---------
function requireUser_() {
  var email = (Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email || email.split('@')[1] !== ALLOWED_DOMAIN)
    throw new Error('Sign in with your @' + ALLOWED_DOMAIN + ' account.');
  return email;
}

// -- Live data: the tracker's Combined tab as CSV, called from the
//    page via google.script.run. --------------------------------
function getCombinedCsv() {
  requireUser_();
  var ss = SpreadsheetApp.openById(TRACKER_SHEET_ID);
  var sheet = ss.getSheetByName(TRACKER_TAB) || ss.getSheets()[0];
  var values = sheet.getDataRange().getDisplayValues();   // formatted, like the sheet shows
  return values.map(function (row) {
    return row.map(function (cell) {
      var s = String(cell == null ? '' : cell);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }).join('\r\n');
}

// Optional: who's signed in (the page can show it).
function whoAmI() { return requireUser_(); }
