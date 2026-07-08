// ══════════════════════════════════════════════════════════════
//  Wizard Trees — Labor / Unit Tracker · Apps Script web app
//
//  Serves the tracker app (labor-calculator.html) behind a
//  @wizardtrees.com Google login AND feeds it live sheet data.
//  The page and the backend are the same origin, so the browser
//  talks to the server with google.script.run — no CORS, no public
//  sheet, no keys in the browser. Data is delivered only after a
//  @wizardtrees.com user signs in, so it is never exposed publicly.
//
//  SETUP (one-time, ~5 min) — signed in as a Google account that can
//  OPEN the tracker sheet.
//  ──────────────────────────────────────────────────────────────
//  1. https://script.google.com → New project. Rename it "WT Labor".
//  2. Paste THIS file into Code.gs (replace the sample code).
//  3. Add the app's HTML:
//        File → New → HTML file → name it exactly  index
//        Open labor-calculator.html from the repo, copy ALL of it,
//        and paste it into that "index" file (replace its contents).
//        Save.
//  4. Deploy → New deployment. If you see a gear icon, pick "Web app":
//        Execute as:      Me
//        Who has access:  Anyone within Wizard Trees   ← the login gate
//     Deploy, and authorize when prompted (Advanced → Go to WT Labor
//     → Allow — it only READS your sheet).
//  5. Copy the "Web app" URL (ends in /exec). That IS the app —
//     share that link with the team; only @wizardtrees.com can open it.
//
//  Updating the app: when I change labor-calculator.html, re-copy it
//  into the "index" file, then Manage deployments → Edit (pencil) →
//  Version: New version → Deploy. (Same flow as the Distro Hours app.)
//
//  To sync the Labor/Packaging sheet live too, share that sheet with
//  this same account, send me its ID, and I'll add a second reader.
// ══════════════════════════════════════════════════════════════

var ALLOWED_DOMAIN   = 'wizardtrees.com';
var TRACKER_SHEET_ID = '1IUMecFlqCYFe51jBBmu5gIs-8elhlrgxdUPxP3qLFuQ';   // Daily Labor_Unit tracker
var TRACKER_TAB      = 'Combined';

// -- Serve the app (from the project's HTML file) --------------
//    Tries common file names/casings so it works whether you named
//    the file index, Index, labor-calculator, etc.
function doGet() {
  var names = ['index', 'Index', 'labor-calculator', 'labor_calculator', 'app', 'Page'];
  for (var i = 0; i < names.length; i++) {
    try {
      return HtmlService.createHtmlOutputFromFile(names[i])
        .setTitle('Wizard Trees - Labor / Unit Tracker')
        .addMetaTag('viewport', 'width=device-width, initial-scale=1');
    } catch (e) { /* not that name; try the next */ }
  }
  return HtmlService.createHtmlOutput(
    '<p style="font:15px sans-serif;padding:40px">Setup needed: add an HTML file named ' +
    '<b>index</b> to this Apps Script project and paste labor-calculator.html into it.</p>');
}

// -- Domain gate. The deployment already restricts who can open the
//    app; this second check guards the data call directly. --------
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
